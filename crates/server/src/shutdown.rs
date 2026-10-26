//! Stop write admission and share one bounded deadline across HTTP and storage drain.
use std::{
    future::{Future, IntoFuture},
    io,
    net::SocketAddr,
    time::Duration,
};

use atmusic_storage::writer::Writer;
use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch},
    task::JoinSet,
    time::{Instant, timeout, timeout_at},
};

use crate::http::error::{HttpError, RequestId};
use crate::workers::runtime::{ShutdownReport, WorkerRuntime};

pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainReport {
    pub timed_out: bool,
    pub unfinished: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ApplicationDrainReport {
    pub timed_out: bool,
    pub unfinished_writes: usize,
    pub unfinished_servers: usize,
    pub workers: ShutdownReport,
}

/// Stop every listener at once, clean up workers while writer admission is open,
/// then drain HTTP and storage within the same absolute 30-second deadline.
pub async fn serve_application_until<F>(
    listeners: Vec<(TcpListener, Router)>,
    writer: &Writer,
    runtime: Option<WorkerRuntime>,
    shutdown: F,
) -> io::Result<ApplicationDrainReport>
where
    F: Future<Output = ()> + Send + 'static,
{
    if listeners.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "no HTTP listeners",
        ));
    }
    let (stop, _) = watch::channel(false);
    let mut servers = JoinSet::new();
    for (listener, router) in listeners {
        servers.spawn(serve_listener(listener, router, stop.subscribe()));
    }
    tokio::pin!(shutdown);
    let mut failure = tokio::select! {
        result = servers.join_next() => server_result(result).err(),
        () = &mut shutdown => None,
    };
    let deadline = Instant::now() + DRAIN_TIMEOUT;
    stop.send_replace(true);
    let workers = if let Some(runtime) = runtime {
        runtime.shutdown_until(deadline).await
    } else {
        ShutdownReport::default()
    };
    writer.stop_admission();
    let drained = timeout_at(deadline, async {
        while let Some(result) = servers.join_next().await {
            if let Err(error) = server_result(Some(result)) {
                failure.get_or_insert(error);
            }
        }
        writer.drain().await;
        writer.wait_closed().await;
    })
    .await
    .is_ok();
    let unfinished_servers = servers.len();
    servers.abort_all();
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(ApplicationDrainReport {
        timed_out: workers.timed_out || !drained,
        unfinished_writes: writer.unfinished(),
        unfinished_servers,
        workers,
    })
}

fn server_result(result: Option<Result<io::Result<()>, tokio::task::JoinError>>) -> io::Result<()> {
    match result {
        Some(Ok(result)) => result,
        Some(Err(_)) => Err(io::Error::other("HTTP listener task failed")),
        None => Ok(()),
    }
}

async fn serve_listener(
    listener: TcpListener,
    router: Router,
    mut stopped: watch::Receiver<bool>,
) -> io::Result<()> {
    let (_request_lifetime, cancelled) = watch::channel(());
    let router = cancel_active_requests(router, cancelled);
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        if !*stopped.borrow_and_update() {
            let _ = stopped.changed().await;
        }
    })
    .await
}

fn cancel_active_requests(router: Router, cancelled: watch::Receiver<()>) -> Router {
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        let mut cancelled = cancelled.clone();
        async move {
            tokio::select! {
                response = next.run(request) => response,
                _ = cancelled.changed() => {
                    let id = RequestId(uuid::Uuid::new_v4().to_string());
                    let mut response = HttpError::new(StatusCode::SERVICE_UNAVAILABLE,
                        "server_shutting_down", "The server is shutting down.", &id).into_response();
                    response.headers_mut().insert("x-request-id", HeaderValue::from_str(&id.0).expect("UUID header"));
                    response
                }
            }
        }
    }))
}

pub async fn drain_writer(writer: &Writer) -> DrainReport {
    writer.stop_admission();
    let timed_out = timeout(DRAIN_TIMEOUT, writer.drain()).await.is_err();
    DrainReport {
        timed_out,
        unfinished: writer.unfinished(),
    }
}

/// Serve until shutdown is requested, then bound the entire shutdown to 30 seconds.
/// Tokio's monotonic clock is used so tests can advance it without wall-clock sleeps.
pub async fn serve_until<F>(
    listener: TcpListener,
    router: Router,
    writer: &Writer,
    shutdown: F,
) -> io::Result<DrainReport>
where
    F: Future<Output = ()> + Send + 'static,
{
    // Axum owns detached connection tasks. Closing this channel when the serving
    // future completes or is aborted drops their active handler futures too.
    let (_request_lifetime, cancelled) = watch::channel(());
    let router = cancel_active_requests(router, cancelled);
    let (stop, stopped) = oneshot::channel();
    let serving = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = stopped.await;
    })
    .into_future();
    tokio::pin!(serving, shutdown);
    tokio::select! {
        result = &mut serving => {
            result?;
            return Ok(drain_writer(writer).await);
        }
        () = &mut shutdown => {}
    }
    writer.stop_admission();
    let _ = stop.send(());
    let completed = timeout(DRAIN_TIMEOUT, async {
        tokio::try_join!(serving, async {
            writer.drain().await;
            Ok::<(), io::Error>(())
        },)?;
        Ok::<(), io::Error>(())
    })
    .await;
    let timed_out = match completed {
        Ok(result) => {
            result?;
            false
        }
        Err(_) => true,
    };
    Ok(DrainReport {
        timed_out,
        unfinished: writer.unfinished(),
    })
}

pub async fn signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    result = tokio::signal::ctrl_c() => {
                        if let Err(error) = result { tracing::error!(%error, "SIGINT handler failed"); }
                    }
                    _ = terminate.recv() => {}
                }
            }
            Err(error) => {
                tracing::error!(%error, "SIGTERM handler failed");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "SIGINT handler failed");
    }
}
