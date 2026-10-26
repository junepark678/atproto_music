mod common;

use std::{
    future::{Future, poll_fn},
    io::{Read, Write},
    pin::Pin,
    sync::{Arc, Mutex},
    task::Poll,
};

struct HandlerDrop(Option<oneshot::Sender<()>>);
impl Drop for HandlerDrop {
    fn drop(&mut self) {
        if let Some(dropped) = self.0.take() {
            let _ = dropped.send(());
        }
    }
}

fn keepalive_request(address: std::net::SocketAddr) -> tokio::task::JoinHandle<Vec<u8>> {
    tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                b"GET /blocked HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
            )
            .unwrap();
        let mut response = vec![];
        // A returned body alone is insufficient: read_to_end proves the owned
        // keepalive socket closed after the handler future was cancelled.
        stream.read_to_end(&mut response).unwrap();
        response
    })
}

use atmusic_server::shutdown::{DRAIN_TIMEOUT, drain_writer, serve_until};
use atmusic_storage::{Database, StorageError};
use axum::{Router, routing::get};
use tokio::{
    net::TcpListener,
    sync::{Notify, oneshot},
    time::Instant,
};

// Tokio's deadline_to_tick rounds expiration up to the next millisecond.
// The real blocking socket reader prevents paused-time auto-advance, so the
// test must explicitly include that one timer quantum when crossing 30 seconds.
const TIMER_TICK: std::time::Duration = std::time::Duration::from_millis(1);

async fn poll_pending<F: Future>(future: Pin<&mut F>) {
    let mut future = future;
    poll_fn(|cx| {
        assert!(
            future.as_mut().poll(cx).is_pending(),
            "expected pending shutdown"
        );
        Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn harness_isolation() {
    let first = common::TestServer::start().await;
    let second = common::TestServer::start().await;
    assert_ne!(first.address, second.address);
    assert_ne!(first.database_path, second.database_path);
    for server in [&first, &second] {
        let response = server
            .client
            .get(server.url("/health/ready"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"status":"ready"})
        );
    }
    first.database.writer().execute(|connection| Box::pin(async move {
        sqlx::query("INSERT INTO users(did,joined_at) VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','2026-01-15T12:00:00Z')")
            .execute(connection).await?;
        Ok(())
    })).await.unwrap();
    let counts = tokio::join!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
            .fetch_one(first.database.reader_pool()),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
            .fetch_one(second.database.reader_pool()),
    );
    assert_eq!(counts.0.unwrap(), 1);
    assert_eq!(counts.1.unwrap(), 0);
    assert!(!first.shutdown().await.timed_out);
    assert!(!second.shutdown().await.timed_out);
}

#[tokio::test]
async fn drain_success() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("music.sqlite");
    let database = Database::open(&path).await.unwrap();
    let release = Arc::new(Notify::new());
    let (entered, started) = oneshot::channel();
    let gate = release.clone();
    let first = database.writer().enqueue(move |connection| Box::pin(async move {
        let _ = entered.send(());
        gate.notified().await;
        sqlx::query("INSERT INTO users(did,joined_at) VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','2026-01-15T12:00:00Z')")
            .execute(connection).await?;
        Ok(())
    })).unwrap();
    let mut acknowledgements = vec![first];
    for did in [
        "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
        "did:plc:cccccccccccccccccccccccc",
    ] {
        acknowledgements.push(
            database
                .writer()
                .enqueue(move |connection| {
                    Box::pin(async move {
                        sqlx::query(
                            "INSERT INTO users(did,joined_at) VALUES(?, '2026-01-15T12:00:00Z')",
                        )
                        .bind(did)
                        .execute(connection)
                        .await?;
                        Ok(())
                    })
                })
                .unwrap(),
        );
    }
    started.await.unwrap();
    assert_eq!(database.writer().unfinished(), 3);
    let report = {
        let drain = drain_writer(database.writer());
        tokio::pin!(drain);
        poll_pending(drain.as_mut()).await;
        assert!(matches!(
            database.writer().enqueue(|_| Box::pin(async { Ok(()) })),
            Err(StorageError::Closed)
        ));
        release.notify_one();
        drain.await
    };
    assert!(!report.timed_out);
    assert_eq!(report.unfinished, 0);
    for acknowledgement in acknowledgements {
        acknowledgement.wait().await.unwrap();
    }
    database.close().await;
    drop(database);
    let reopened = Database::open(&path).await.unwrap();
    let dids = sqlx::query_scalar::<_, String>("SELECT did FROM users ORDER BY did")
        .fetch_all(reopened.reader_pool())
        .await
        .unwrap();
    assert_eq!(
        dids,
        [
            "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
            "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
            "did:plc:cccccccccccccccccccccccc"
        ]
    );
    reopened.close().await;
}

#[tokio::test]
async fn drain_timeout() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("music.sqlite");
    let database = Database::open(&path).await.unwrap();
    // Persist an acknowledged operation before stopping the writer. Only committed
    // outbox rows are restart work; an uncommitted in-memory closure is not an ack.
    database.writer().execute(|connection| Box::pin(async move {
        sqlx::query("INSERT INTO users(did,joined_at) VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','2026-01-15T12:00:00Z')")
            .execute(&mut *connection).await?;
        sqlx::query("INSERT INTO operations(operation_id,owner,kind,created_at,updated_at) VALUES('recover-me','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','scrobble_create','2026-01-15T12:00:00Z','2026-01-15T12:00:00Z')")
            .execute(&mut *connection).await?;
        sqlx::query("INSERT INTO outbox(operation_id,owner,collection,rkey,due_at) VALUES('recover-me','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','com.example.atmusic.scrobble','r01','2026-01-15T12:00:00Z')")
            .execute(connection).await?;
        Ok(())
    })).await.unwrap();
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
    tokio::time::pause();
    let report = {
        let drain = drain_writer(database.writer());
        tokio::pin!(drain);
        poll_pending(drain.as_mut()).await;
        tokio::time::advance(DRAIN_TIMEOUT - std::time::Duration::from_secs(1)).await;
        poll_pending(drain.as_mut()).await;
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        drain.await
    };
    assert!(report.timed_out);
    assert_eq!(report.unfinished, 1);
    tokio::time::resume();
    release.notify_one();
    pending.wait().await.unwrap();
    database.close().await;
    drop(database);
    let reopened = Database::open(&path).await.unwrap();
    let recoverable = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT o.operation_id,o.state,o.attempts FROM operations o JOIN outbox b USING(operation_id)"
    ).fetch_all(reopened.reader_pool()).await.unwrap();
    assert_eq!(
        recoverable,
        [("recover-me".to_owned(), "pending".to_owned(), 0)]
    );
    reopened.close().await;
}

#[tokio::test]
async fn http_and_writer_share_one_shutdown_deadline() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(directory.path().join("music.sqlite"))
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let entered = Arc::new(Notify::new());
    let route_entered = entered.clone();
    let (dropped, handler_dropped) = oneshot::channel();
    let drop_signal = Arc::new(Mutex::new(Some(dropped)));
    let route_database = database.clone();
    let router = Router::new().route(
        "/blocked",
        get(move || {
            let entered = route_entered.clone();
            let dropped = drop_signal.clone();
            let database = route_database.clone();
            async move {
                let _drop_signal = HandlerDrop(dropped.lock().unwrap().take());
                let _held_database = database;
                entered.notify_one();
                std::future::pending::<()>().await;
                drop(_held_database);
                "done"
            }
        }),
    );
    let (stop, stopped) = oneshot::channel();
    let writer = database.writer().clone();
    let server = serve_until(listener, router, &writer, async move {
        let _ = stopped.await;
    });
    tokio::pin!(server);
    let request = keepalive_request(address);
    tokio::select! {
        result = server.as_mut() => panic!("server ended before shutdown: {result:?}"),
        entered = tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified()) => {
            entered.unwrap();
        }
    }
    tokio::time::pause();
    assert_eq!(DRAIN_TIMEOUT, std::time::Duration::from_secs(30));
    let shutdown_at = Instant::now();
    stop.send(()).unwrap();
    // Poll the actual serving future after the signal while time is frozen.
    // Admission closes before timeout construction, so merely observing a
    // closed writer cannot prove that the 30-second timer has been registered.
    poll_pending(server.as_mut()).await;
    assert!(matches!(
        database.writer().enqueue(|_| Box::pin(async { Ok(()) })),
        Err(StorageError::Closed)
    ));
    tokio::time::advance(DRAIN_TIMEOUT - std::time::Duration::from_secs(1)).await;
    poll_pending(server.as_mut()).await;
    tokio::time::advance(std::time::Duration::from_secs(1) + TIMER_TICK).await;
    let report = server.await.unwrap();
    assert!(Instant::now() - shutdown_at <= DRAIN_TIMEOUT + TIMER_TICK);
    assert!(
        report.timed_out,
        "HTTP request must not extend the shutdown deadline"
    );
    assert_eq!(report.unfinished, 0);
    tokio::time::resume();
    tokio::time::timeout(std::time::Duration::from_secs(1), handler_dropped)
        .await
        .unwrap()
        .unwrap();
    let response = request.await.unwrap();
    assert!(String::from_utf8_lossy(&response).contains("server_shutting_down"));
    database.close().await;
}

#[tokio::test]
async fn harness_drop_cancels_owned_handler_and_closes_keepalive_socket() {
    let entered = Arc::new(Notify::new());
    let route_entered = entered.clone();
    let (dropped, handler_dropped) = oneshot::channel();
    let drop_signal = Arc::new(Mutex::new(Some(dropped)));
    let server = common::TestServer::start_with_router(
        Arc::new(atmusic_server::SystemClock),
        |state| state,
        move |state| {
            let database = state.database.as_ref().unwrap().clone();
            atmusic_server::router_with_state(state).route(
                "/blocked",
                get(move || {
                    let entered = route_entered.clone();
                    let dropped = drop_signal.clone();
                    let database = database.clone();
                    async move {
                        let _drop_signal = HandlerDrop(dropped.lock().unwrap().take());
                        let _held_database = database;
                        entered.notify_one();
                        std::future::pending::<()>().await;
                        drop(_held_database);
                        "done"
                    }
                }),
            )
        },
    )
    .await;
    let request = keepalive_request(server.address);
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    drop(server);
    tokio::time::timeout(std::time::Duration::from_secs(1), handler_dropped)
        .await
        .unwrap()
        .unwrap();
    let response = request.await.unwrap();
    assert!(String::from_utf8_lossy(&response).contains("server_shutting_down"));
}
