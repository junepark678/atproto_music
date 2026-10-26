#[path = "support/federation.rs"]
mod federation;

use async_trait::async_trait;
use atmusic_atproto::sync::stream::{RelayConnection, RelayTransport, StreamError};
use atmusic_server::{
    AppState,
    config::Config,
    shutdown::{ApplicationDrainReport, DRAIN_TIMEOUT, serve_application_until},
    workers::{
        relay::{RelayDependencies, RelayWorker},
        runtime::{ShutdownReport, WorkerRuntime, WorkerSet},
    },
};
use atmusic_storage::{Database, NewOperation, StorageError, User};
use axum::{Router, routing::get};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::SocketAddr,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, oneshot},
    task::JoinHandle,
    time::{Instant, timeout},
};
use url::Url;

// Tokio rounds timer expiration up to the next millisecond. Explicitly advance
// that tick because the real socket readers prevent paused-time auto-advance.
const TIMER_TICK: Duration = Duration::from_millis(1);

struct HandlerDrop(Option<oneshot::Sender<()>>);
impl Drop for HandlerDrop {
    fn drop(&mut self) {
        if let Some(dropped) = self.0.take() {
            let _ = dropped.send(());
        }
    }
}

fn held_router(router: Router) -> (Router, Arc<Notify>, oneshot::Receiver<()>) {
    let entered = Arc::new(Notify::new());
    let route_entered = entered.clone();
    let (dropped, handler_dropped) = oneshot::channel();
    let drop_signal = Arc::new(Mutex::new(Some(dropped)));
    let router = router.route(
        "/blocked",
        get(move || {
            let entered = route_entered.clone();
            let dropped = drop_signal.clone();
            async move {
                let _guard = HandlerDrop(dropped.lock().unwrap().take());
                entered.notify_one();
                std::future::pending::<()>().await;
                "done"
            }
        }),
    );
    (router, entered, handler_dropped)
}

fn routers(database: &Database, path: &Path) -> (Router, Router) {
    let config = Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path.to_owned(),
        "https://music.example",
        &"11".repeat(32),
        None,
        None,
    )
    .unwrap();
    let state = AppState::new(config, Some(database.clone()));
    (
        atmusic_server::router_with_state(state.clone()),
        atmusic_server::metrics::router(state),
    )
}

async fn listeners(api: Router, metrics: Router) -> (Vec<(TcpListener, Router)>, [SocketAddr; 2]) {
    let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let metrics_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addresses = [
        api_listener.local_addr().unwrap(),
        metrics_listener.local_addr().unwrap(),
    ];
    (
        vec![(api_listener, api), (metrics_listener, metrics)],
        addresses,
    )
}

fn start_application(
    listeners: Vec<(TcpListener, Router)>,
    database: &Database,
    runtime: Option<WorkerRuntime>,
) -> (oneshot::Sender<()>, JoinHandle<ApplicationDrainReport>) {
    let writer = database.writer().clone();
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        serve_application_until(listeners, &writer, runtime, async move {
            let _ = stopped.await;
        })
        .await
        .unwrap()
    });
    (stop, task)
}

// Keep this task runnable while Tokio time is paused. Awaiting network or SQLite
// work here would allow the runtime to auto-advance to the shutdown deadline.
async fn until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(std::time::Instant::now() < deadline, "progress deadline");
        tokio::task::yield_now().await;
    }
}

async fn listeners_are_closed(addresses: [SocketAddr; 2]) {
    for address in addresses {
        until(|| {
            match std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)) {
                Ok(stream) => {
                    drop(stream);
                    false
                }
                Err(error) => {
                    assert_eq!(error.kind(), std::io::ErrorKind::ConnectionRefused);
                    true
                }
            }
        })
        .await;
    }
}

fn keepalive_request(address: SocketAddr) -> JoinHandle<Vec<u8>> {
    tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .write_all(
                b"GET /blocked HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
            )
            .unwrap();
        let mut response = vec![];
        // EOF also proves the owned keepalive socket closes after cancellation.
        stream.read_to_end(&mut response).unwrap();
        response
    })
}

async fn cancelled_requests(
    requests: [JoinHandle<Vec<u8>>; 2],
    dropped: [oneshot::Receiver<()>; 2],
) {
    for signal in dropped {
        timeout(Duration::from_secs(2), signal)
            .await
            .unwrap()
            .unwrap();
    }
    for request in requests {
        let response = timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.contains("503 Service Unavailable"));
        assert!(response.contains("server_shutting_down"));
    }
}

#[tokio::test]
async fn application_signal_closes_api_and_metrics_listeners() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("listeners.sqlite");
    let database = Database::open(&path).await.unwrap();
    let (api, metrics) = routers(&database, &path);
    let (listeners, addresses) = listeners(api, metrics).await;
    let (stop, task) = start_application(listeners, &database, None);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client
        .get(format!("http://{}/health/ready", addresses[0]))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"status":"ready"})
    );
    let response = client
        .get(format!("http://{}/metrics", addresses[1]))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("atmusic_storage_ready 1")
    );
    stop.send(()).unwrap();
    let report = timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(!report.timed_out);
    assert_eq!(report.unfinished_writes, 0);
    assert_eq!(report.unfinished_servers, 0);
    assert_eq!(report.workers, ShutdownReport::default());
    assert!(!database.writer().is_accepting());
    assert!(database.writer().is_closed());
    assert!(matches!(
        database.writer().enqueue(|_| Box::pin(async { Ok(()) })),
        Err(StorageError::Closed)
    ));
    listeners_are_closed(addresses).await;
    database.close().await;
}

#[tokio::test]
async fn both_http_servers_and_writer_share_thirty_seconds_and_retain_durable_work() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("deadline.sqlite");
    let database = Database::open(&path).await.unwrap();
    database
        .repositories()
        .upsert_user(User::new(federation::ALICE, federation::now().to_rfc3339()))
        .await
        .unwrap();
    let payload = federation::record("Björk", "Jóga").to_string();
    let digest = hex::encode(Sha256::digest(payload.as_bytes()));
    database
        .repositories()
        .admit_operation(
            NewOperation {
                operation_id: "recover-me".into(),
                owner: federation::ALICE.into(),
                kind: "scrobble_create".into(),
                created_at: federation::now().to_rfc3339(),
                record_uri: Some(format!(
                    "at://{}/{}/r01",
                    federation::ALICE,
                    federation::SCROBBLE
                )),
                collection: federation::SCROBBLE.into(),
                rkey: "r01".into(),
                payload_json: Some(payload),
                canonical_digest: Some(digest),
            },
            None,
        )
        .await
        .unwrap();
    let (api, metrics) = routers(&database, &path);
    let (api, api_entered, api_dropped) = held_router(api);
    let (metrics, metrics_entered, metrics_dropped) = held_router(metrics);
    let (listeners, addresses) = listeners(api, metrics).await;
    let (stop, task) = start_application(listeners, &database, None);
    let requests = addresses.map(keepalive_request);
    timeout(Duration::from_secs(3), api_entered.notified())
        .await
        .unwrap();
    timeout(Duration::from_secs(3), metrics_entered.notified())
        .await
        .unwrap();
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let (entered, started) = oneshot::channel();
    let pending = database
        .writer()
        .enqueue(move |_| {
            Box::pin(async move {
                let _ = entered.send(());
                gate.notified().await;
                Ok(())
            })
        })
        .unwrap();
    started.await.unwrap();
    assert_eq!(database.writer().unfinished(), 1);

    tokio::time::pause();
    let signalled_at = Instant::now();
    stop.send(()).unwrap();
    until(|| !database.writer().is_accepting()).await;
    listeners_are_closed(addresses).await;
    tokio::time::advance(DRAIN_TIMEOUT - Duration::from_secs(1)).await;
    assert!(!task.is_finished(), "shutdown ended before the deadline");
    tokio::time::advance(Duration::from_secs(1) + TIMER_TICK).await;
    let report = task.await.unwrap();
    assert_eq!(Instant::now() - signalled_at, DRAIN_TIMEOUT + TIMER_TICK);
    assert!(report.timed_out);
    assert_eq!(report.unfinished_writes, 1);
    assert_eq!(report.unfinished_servers, 2);
    assert_eq!(report.workers, ShutdownReport::default());
    tokio::time::resume();

    cancelled_requests(requests, [api_dropped, metrics_dropped]).await;
    release.notify_one();
    pending.wait().await.unwrap();
    database.close().await;
    drop(database);
    let reopened = Database::open(&path).await.unwrap();
    let recoverable = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT o.operation_id,o.state,o.attempts FROM operations o JOIN outbox b USING(operation_id)",
    )
    .fetch_all(reopened.reader_pool())
    .await
    .unwrap();
    assert_eq!(recoverable, [("recover-me".into(), "pending".into(), 0)]);
    reopened.close().await;
}

struct HeldRelay {
    source: Arc<dyn RelayTransport>,
    waiting: Arc<Notify>,
    dropped: Arc<AtomicBool>,
}
struct HeldConnection {
    source: Box<dyn RelayConnection>,
    waiting: Arc<Notify>,
    dropped: Arc<AtomicBool>,
}
impl Drop for HeldConnection {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}
#[async_trait]
impl RelayConnection for HeldConnection {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        match self.source.receive().await? {
            Some(frame) => Ok(Some(frame)),
            None => {
                self.waiting.notify_one();
                std::future::pending().await
            }
        }
    }
}
#[async_trait]
impl RelayTransport for HeldRelay {
    async fn connect(
        &self,
        url: &Url,
        max: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError> {
        Ok(Box::new(HeldConnection {
            source: self.source.connect(url, max).await?,
            waiting: self.waiting.clone(),
            dropped: self.dropped.clone(),
        }))
    }
}

#[tokio::test]
async fn worker_cleanup_keeps_writer_admission_open_and_uses_the_http_deadline() {
    let h = federation::Harness::new().await;
    h.alice
        .create(
            federation::SCROBBLE,
            "3m4zm2ufr2222",
            federation::record("Björk", "Jóga"),
        )
        .await;
    let transport = Arc::new(HeldRelay {
        source: h.relay.clone(),
        waiting: Arc::new(Notify::new()),
        dropped: Arc::new(AtomicBool::new(false)),
    });
    let worker = Arc::new(RelayWorker::new(
        h.db.repositories(),
        federation::RELAY.into(),
        federation::namespace(),
        RelayDependencies {
            transport: transport.clone(),
            resolver: h.keys.clone(),
            clock: Arc::new(federation::Clock),
            backfills: h.backfills.clone(),
        },
    ));
    let runtime = WorkerRuntime::start(
        WorkerSet {
            relay: Some(worker),
            ..Default::default()
        },
        Arc::new(federation::Clock),
        Duration::from_secs(60),
    )
    .unwrap();
    timeout(Duration::from_secs(5), transport.waiting.notified())
        .await
        .unwrap();
    let checkpoint =
        h.db.repositories()
            .checkpoint(federation::RELAY)
            .await
            .unwrap()
            .unwrap();
    let before =
        h.db.repositories()
            .relay_recovery(federation::RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(before.connected);
    assert_eq!(
        h.db.repositories()
            .public_counts(federation::ALICE)
            .await
            .unwrap()
            .0,
        1
    );
    let path = h.directory.path().join("federation.sqlite");
    let (api, metrics) = routers(&h.db, &path);
    let (api, api_entered, api_dropped) = held_router(api);
    let (metrics, metrics_entered, metrics_dropped) = held_router(metrics);
    let (listeners, addresses) = listeners(api, metrics).await;
    let (stop, task) = start_application(listeners, &h.db, Some(runtime));
    let requests = addresses.map(keepalive_request);
    timeout(Duration::from_secs(3), api_entered.notified())
        .await
        .unwrap();
    timeout(Duration::from_secs(3), metrics_entered.notified())
        .await
        .unwrap();
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let (entered, started) = oneshot::channel();
    let pending =
        h.db.writer()
            .enqueue(move |_| {
                Box::pin(async move {
                    let _ = entered.send(());
                    gate.notified().await;
                    Ok(())
                })
            })
            .unwrap();
    started.await.unwrap();

    tokio::time::pause();
    let signalled_at = Instant::now();
    stop.send(()).unwrap();
    // The held transaction plus the real relay disconnect write are admitted.
    until(|| h.db.writer().unfinished() == 2).await;
    assert!(h.db.writer().is_accepting());
    assert!(transport.dropped.load(Ordering::SeqCst));
    assert!(!task.is_finished());
    listeners_are_closed(addresses).await;
    tokio::time::advance(Duration::from_secs(20)).await;
    assert!(!task.is_finished());
    assert!(h.db.writer().is_accepting());
    release.notify_one();
    until(|| !h.db.writer().is_accepting()).await;
    assert_eq!(h.db.writer().unfinished(), 0);
    tokio::time::advance(Duration::from_secs(9)).await;
    assert!(!task.is_finished());
    tokio::time::advance(Duration::from_secs(1) + TIMER_TICK).await;
    let report = task.await.unwrap();
    assert_eq!(Instant::now() - signalled_at, DRAIN_TIMEOUT + TIMER_TICK);
    assert!(report.timed_out);
    assert_eq!(report.unfinished_writes, 0);
    assert_eq!(report.unfinished_servers, 2);
    assert_eq!(report.workers, ShutdownReport::default());
    tokio::time::resume();

    pending.wait().await.unwrap();
    cancelled_requests(requests, [api_dropped, metrics_dropped]).await;
    let after =
        h.db.repositories()
            .relay_recovery(federation::RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(!after.connected);
    assert!(after.pending_gap);
    assert_eq!(after.reason.as_deref(), Some("worker_stopped"));
    assert_eq!(after.last_event_at, before.last_event_at);
    assert_eq!(
        h.db.repositories()
            .checkpoint(federation::RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        checkpoint.sequence
    );
    federation::assert_exact(&h.db, &[&h.alice, &h.carol], h.keys.as_ref()).await;
    h.close().await;
}
