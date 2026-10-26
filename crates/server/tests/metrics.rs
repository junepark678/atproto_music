mod common;
#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;
use atmusic_server::{AppState, Clock, metrics, workers::outbox::OutboxWorker};
use atmusic_storage::User;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use chrono::{DateTime, Utc};
use common::TestServer;
use http_body_util::BodyExt;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use tracing::instrument::WithSubscriber;

struct Frozen;
impl Clock for Frozen {
    fn now(&self) -> DateTime<Utc> {
        write_pds::now()
    }
}

async fn metric_response(
    state: AppState,
    peer: &str,
    token: Option<&str>,
) -> axum::response::Response {
    let mut request = Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    if let Some(token) = token {
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    metrics::router(state).oneshot(request).await.unwrap()
}
#[tokio::test]
async fn metrics_auth() {
    let server = TestServer::start_with_clock(Arc::new(Frozen)).await;
    assert_eq!(
        server
            .client
            .get(server.url("/metrics"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        metric_response(server.state.clone(), "127.0.0.1:1234", None)
            .await
            .status(),
        200
    );
    assert_eq!(
        metric_response(server.state.clone(), "203.0.113.1:1234", None)
            .await
            .status(),
        403
    );
    let mut state = server.state.clone();
    let config = state.config.as_ref().unwrap().as_ref().clone();
    assert!(
        config
            .clone()
            .with_metrics("0.0.0.0:9091".parse().unwrap(), None)
            .is_err()
    );
    let token = "cd".repeat(32);
    state.config = Some(Arc::new(
        config
            .with_metrics("0.0.0.0:9091".parse().unwrap(), Some(&token))
            .unwrap(),
    ));
    assert_eq!(
        metric_response(state.clone(), "203.0.113.1:1234", None)
            .await
            .status(),
        401
    );
    assert_eq!(
        metric_response(state.clone(), "203.0.113.1:1234", Some("invalid"))
            .await
            .status(),
        403
    );
    let response = metric_response(state.clone(), "203.0.113.1:1234", Some(&token)).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("atmusic_storage_ready 1\n"));
    assert!(!body.contains(&token));
    assert!(!format!("{:?}", state.config).contains(&token));
    assert!(!server.shutdown().await.timed_out);
}
#[tokio::test]
async fn upstream_offline() {
    let server = TestServer::start_with_clock(Arc::new(Frozen)).await;
    server
        .database
        .repositories()
        .upsert_user(User::new(signed_repo::ALICE, write_pds::NOW))
        .await
        .unwrap();
    let fixture = write_pds::WritePds::new(
        &server.database,
        vec![write_pds::Reply::Status(503, None)],
        None,
    )
    .await;
    server
        .database
        .repositories()
        .admit_operation(write_pds::operation(), Some("outage-key".into()))
        .await
        .unwrap();
    let worker = OutboxWorker::new(server.database.repositories(), fixture.client.clone());
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        worker.run_due(write_pds::now()),
    )
    .await
    .unwrap()
    .unwrap();
    let operation = server
        .database
        .repositories()
        .operation(signed_repo::ALICE, "operation-one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(operation.state, "pending");
    assert_eq!(operation.attempts, 1);
    assert_eq!(fixture.state.lock().await.calls, 1);
    server
        .database
        .writer()
        .execute(|connection| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE indexing_status SET state='stale',caught_up=0 WHERE scope='global'",
                )
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    for route in ["/health/live", "/health/ready"] {
        assert_eq!(
            server
                .client
                .get(server.url(route))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let feed: serde_json::Value = server
        .client
        .get(server.url("/api/v1/feed"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(feed["items"].as_array().unwrap().is_empty());
    assert_eq!(feed["indexing"]["state"], "stale");
    let meta: serde_json::Value = server
        .client
        .get(server.url("/api/v1/meta"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(meta["indexing"]["state"], "stale");
    let response = metric_response(server.state.clone(), "127.0.0.1:1234", None).await;
    let body = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("atmusic_outbox_pending 1\n"));
    assert!(body.contains("atmusic_index_caught_up 0\n"));
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn indexing_evidence() {
    let server = TestServer::start_with_clock(Arc::new(Frozen)).await;
    let repository = server.database.repositories();
    repository
        .set_indexing(
            "global".into(),
            atmusic_storage::Indexing {
                state: "current".into(),
                caught_up: true,
                last_indexed_at: Some(write_pds::NOW.into()),
                lag_seconds: Some(123),
            },
        )
        .await
        .unwrap();
    let text = |response: axum::response::Response| async move {
        String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap()
    };
    let body = text(metric_response(server.state.clone(), "127.0.0.1:1234", None).await).await;
    assert!(body.contains("atmusic_index_caught_up 0\n"));
    assert!(body.contains("atmusic_index_lag_known 0\n"));
    let meta: serde_json::Value = server
        .client
        .get(server.url("/api/v1/meta"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(meta["indexing"]["caughtUp"], false);
    repository
        .upsert_user(User::new(signed_repo::ALICE, write_pds::NOW))
        .await
        .unwrap();
    repository
        .request_backfill(signed_repo::ALICE.into(), false, write_pds::NOW.into())
        .await
        .unwrap();
    repository
        .set_indexing(
            "unrelated-status".into(),
            atmusic_storage::Indexing {
                state: "recovering".into(),
                caught_up: false,
                last_indexed_at: None,
                lag_seconds: None,
            },
        )
        .await
        .unwrap();
    let relay = "wss://relay.test/";
    repository
        .set_relay_recovery(atmusic_storage::RelayRecovery {
            relay: relay.into(),
            pending_gap: true,
            connected: true,
            last_event_at: Some("2026-01-15T11:59:55Z".into()),
            prior_sequence: None,
            reason: Some("repository_revision_gap".into()),
            updated_at: write_pds::NOW.into(),
        })
        .await
        .unwrap();
    let mut state = server.state.clone();
    state.config = Some(Arc::new(
        atmusic_server::config::Config::from_values(
            server.address,
            server.database_path.clone(),
            "https://music.example",
            &"11".repeat(32),
            None,
            Some(relay),
        )
        .unwrap(),
    ));
    let body = text(metric_response(state, "127.0.0.1:1234", None).await).await;
    assert!(body.contains("atmusic_index_caught_up 0\n"));
    assert!(body.contains("atmusic_index_lag_seconds 5\n"));
    assert!(body.contains("atmusic_backfills_pending 1\n"));
    assert!(!server.shutdown().await.timed_out);
}

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[tokio::test]
async fn log_redaction() {
    let capture = Capture(Arc::default());
    let writer = capture.clone();
    let subscriber = tracing::Dispatch::new(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_span_events(
                tracing_subscriber::fmt::format::FmtSpan::NEW
                    | tracing_subscriber::fmt::format::FmtSpan::CLOSE,
            )
            .with_writer(move || writer.clone())
            .finish(),
    );
    let markers = [
        "DUMMY_AUTH_CODE_MARKER",
        "DUMMY_ACCESS_TOKEN_MARKER",
        "DUMMY_COOKIE_MARKER",
        "DUMMY_LISTENING_TRACK_MARKER",
    ];
    let routes = atmusic_server::router();
    for (method, path) in [
        (
            "GET",
            format!(
                "/api/v1/auth/callback?code={}&state=x&iss=https://issuer.test",
                markers[0]
            ),
        ),
        ("POST", "/api/v1/scrobbles".into()),
    ] {
        let response = routes
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {}", markers[1]))
                    .header("cookie", format!("atmusic_session={}", markers[2]))
                    .header("content-type", "application/json")
                    .body(Body::from(format!("{{\"track\":\"{}\"}}", markers[3])))
                    .unwrap(),
            )
            .with_subscriber(subscriber.clone())
            .await
            .unwrap();
        assert!(!response.status().is_success());
    }
    let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("http_request"));
    assert!(logs.contains("request_id"));
    for marker in markers {
        assert!(!logs.contains(marker), "secret marker leaked: {marker}");
    }
}
