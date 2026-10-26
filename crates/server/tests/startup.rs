#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;

use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{DnsResolver, FetchError, HttpResponse, HttpTransport, SafeClient},
    oauth::token_store::TokenStore,
    sync::backfill::ReceiptClock,
};
use atmusic_core::namespace::OwnershipEvidence;
use atmusic_server::{
    Clock,
    config::Config,
    startup::{InitializedApp, initialize_with_clock},
};
use atmusic_storage::{Database, RelayRecovery};
use axum::{
    extract::{Request, State},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use signed_repo::{ALICE, SignedFixture};
use std::{
    collections::BTreeMap,
    future::Future,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
    time::{Instant, timeout},
};
use tower::ServiceExt;
use url::Url;

const PREFIX: &str = "test.fixture.music";
const PDS: &str = "https://pds.fixture.test/";
const RELAY: &str = "wss://relay.fixture.test/";
fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
struct Frozen;
impl Clock for Frozen {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
impl ReceiptClock for Frozen {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
fn config(path: &std::path::Path, prefix: Option<&str>, owned: bool) -> Config {
    let config = Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path.to_owned(),
        "https://app.fixture.test",
        &"11".repeat(32),
        prefix,
        Some(RELAY),
    )
    .unwrap();
    if owned {
        config
            .with_namespace_ownership(OwnershipEvidence {
                domain: "fixture.test".into(),
                reference: "controlled test namespace; not live ownership evidence".into(),
            })
            .unwrap()
    } else {
        config
    }
}
async fn until<F, Fut>(mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    timeout(Duration::from_secs(10), async {
        while !condition().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("startup worker progress deadline");
}
async fn stop(app: InitializedApp) {
    if let Some(runtime) = app.runtime {
        assert_eq!(
            runtime
                .shutdown_until(Instant::now() + Duration::from_secs(3))
                .await,
            Default::default()
        );
    }
}

#[derive(Default)]
struct Pause {
    entered: Notify,
    release: Notify,
}
struct UpstreamState {
    fixture: SignedFixture,
    active: bool,
    head_changed: bool,
    migrate_at_document: Option<usize>,
    documents: usize,
    requests: Vec<String>,
    pause_car: Option<Arc<Pause>>,
    pause_status: Option<Arc<Pause>>,
}
struct FixtureDns;
#[async_trait]
impl DnsResolver for FixtureDns {
    async fn resolve(&self, _: &str) -> Result<Vec<IpAddr>, FetchError> {
        Ok(vec!["93.184.216.34".parse().unwrap()])
    }
    async fn txt(&self, _: &str) -> Result<Vec<String>, FetchError> {
        Ok(vec![])
    }
}
struct Wire(SocketAddr);
#[async_trait]
impl HttpTransport for Wire {
    async fn fetch(&self, url: &Url, addresses: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        assert_eq!(addresses, &["93.184.216.34:443".parse().unwrap()]);
        assert!(matches!(
            url.host_str(),
            Some("plc.directory" | "pds.fixture.test" | "moved.fixture.test")
        ));
        let mut local = Url::parse(&format!("http://{}", self.0)).unwrap();
        local.set_path(url.path());
        local.set_query(url.query());
        let response = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(local)
            .header("x-fixture-url", url.as_str())
            .send()
            .await
            .map_err(|_| FetchError::Transport)?;
        let status = response.status().as_u16();
        let headers: BTreeMap<_, _> = response
            .headers()
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_str().unwrap().to_owned()))
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|_| FetchError::Transport)?
            .to_vec();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}
async fn endpoint(
    State(state): State<Arc<Mutex<UpstreamState>>>,
    request: Request,
) -> axum::response::Response {
    let url = Url::parse(request.headers()["x-fixture-url"].to_str().unwrap()).unwrap();
    let mut state = state.lock().await;
    state.requests.push(url.to_string());
    if url.host_str() == Some("plc.directory") {
        assert_eq!(url.path(), format!("/{ALICE}"));
        state.documents += 1;
        let pds = if state.migrate_at_document == Some(state.documents) {
            "https://moved.fixture.test/"
        } else {
            PDS
        };
        return axum::Json(json!({"id":ALICE,"service":[{"id":format!("{ALICE}#atproto_pds"),"type":"AtprotoPersonalDataServer","serviceEndpoint":pds}],"verificationMethod":[{"id":format!("{ALICE}#atproto"),"controller":ALICE,"type":"Multikey","publicKeyMultibase":state.fixture.key.did_key.strip_prefix("did:key:").unwrap()}]})).into_response();
    }
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("did".into(), ALICE.into())]
    );
    match url.path() {
        "/xrpc/com.atproto.sync.getRepoStatus" => {
            let active = state.active;
            let pause = state.pause_status.take();
            drop(state);
            if let Some(pause) = pause { pause.entered.notify_one(); pause.release.notified().await; }
            axum::Json(json!({"did":ALICE,"active":active})).into_response()
        }
        "/xrpc/com.atproto.sync.getRepo" => {
            let bytes = state.fixture.event.blocks.clone();
            let pause = state.pause_car.take();
            drop(state);
            if let Some(pause) = pause { pause.entered.notify_one(); pause.release.notified().await; }
            ([("content-type", "application/vnd.ipld.car")], bytes).into_response()
        }
        "/xrpc/com.atproto.sync.getLatestCommit" => {
            axum::Json(json!({"cid":state.fixture.event.commit.to_string(),"rev":if state.head_changed { "3m4zm2ufr2223" } else { state.fixture.event.revision.as_str() }})).into_response()
        }
        _ => panic!("unexpected startup fixture path: {}", url.path()),
    }
}
struct Harness {
    _directory: tempfile::TempDir,
    db: Database,
    client: SafeClient,
    state: Arc<Mutex<UpstreamState>>,
    task: JoinHandle<()>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Harness {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("startup.sqlite"))
            .await
            .unwrap();
        let fixture = signed_repo::signed_repo(vec![(format!("{PREFIX}.scrobble/r01"), json!({"$type":format!("{PREFIX}.scrobble"),"artist":"Björk","track":"Jóga","listenedAt":"2026-01-14T12:00:00Z","createdAt":"2026-01-14T12:00:00Z"}))], 7).await;
        let state = Arc::new(Mutex::new(UpstreamState {
            fixture,
            active: true,
            head_changed: false,
            migrate_at_document: None,
            documents: 0,
            requests: vec![],
            pause_car: None,
            pause_status: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .fallback(endpoint)
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            _directory: directory,
            db,
            client: SafeClient::new(Arc::new(FixtureDns), Arc::new(Wire(address))),
            state,
            task,
        }
    }
    fn config(&self) -> Config {
        config(
            &self._directory.path().join("startup.sqlite"),
            Some(PREFIX),
            true,
        )
    }
    async fn authorize(&self) {
        TokenStore::new(self.db.repositories(), &[0x11; 32])
            .unwrap()
            .put_authorized_oauth_tokens(
                ALICE,
                &json!({"did":ALICE,"issuer":PDS,"expires_at":now().timestamp()+3600}),
                now().timestamp(),
            )
            .await
            .unwrap();
    }
    async fn initialize(&self) -> InitializedApp {
        initialize_with_clock(
            self.config(),
            self.db.clone(),
            self.client.clone(),
            Arc::new(Frozen),
        )
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn publication_requires_an_owned_configured_namespace() {
    let h = Harness::new().await;
    for prefix in [None, Some("com.example.atmusic"), Some(PREFIX)] {
        let app = initialize_with_clock(
            config(&h._directory.path().join("startup.sqlite"), prefix, false),
            h.db.clone(),
            h.client.clone(),
            Arc::new(Frozen),
        )
        .await
        .unwrap();
        assert!(app.state.outbox.is_none());
        assert!(app.runtime.is_none());
        assert!(app.backfills.is_none());
        assert!(app.state.oauth.is_some());
        assert!(app.state.identity.is_some());
        stop(app).await;
    }
    assert!(h.state.lock().await.requests.is_empty());
    h.db.close().await;
}

#[tokio::test]
async fn owned_namespace_initializes_delivery_without_enabling_relay() {
    let h = Harness::new().await;
    h.db.repositories()
        .set_relay_recovery(RelayRecovery {
            relay: RELAY.into(),
            pending_gap: false,
            connected: true,
            prior_sequence: Some(42),
            last_event_at: Some(now().to_rfc3339()),
            reason: None,
            updated_at: now().to_rfc3339(),
        })
        .await
        .unwrap();
    let previous =
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
    let app = h.initialize().await;
    assert!(app.state.outbox.is_some());
    assert!(app.runtime.is_some());
    assert!(app.backfills.is_some());
    let recovery =
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(!recovery.connected);
    assert!(recovery.pending_gap);
    assert_eq!(recovery.prior_sequence, Some(42));
    assert_eq!(recovery.last_event_at, previous.last_event_at);
    assert_eq!(recovery.reason.as_deref(), Some("relay_worker_not_enabled"));
    stop(app).await;
    assert!(h.state.lock().await.requests.is_empty());
    h.db.close().await;
}

#[tokio::test]
async fn authorized_backfill_uses_current_head_and_keeps_global_indexing_recovering() {
    let h = Harness::new().await;
    h.authorize().await;
    assert!(
        !h.db
            .repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    let app = h.initialize().await;
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    })
    .await;
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 1);
    let response = atmusic_server::router_with_state(app.state.clone())
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/v1/meta")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let meta: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(meta["indexing"]["state"], "recovering");
    assert_eq!(meta["indexing"]["caughtUp"], false);
    let requests = h.state.lock().await.requests.clone();
    assert!(
        requests
            .iter()
            .filter(|url| url.contains("getRepoStatus"))
            .count()
            >= 2
    );
    assert!(requests.iter().any(|url| url.contains("getLatestCommit")));
    assert!(!requests.iter().any(|url| url.contains("subscribeRepos")));
    stop(app).await;
    h.db.close().await;
}

#[tokio::test]
async fn head_advancement_retains_retryable_backfill_without_visibility() {
    let h = Harness::new().await;
    h.authorize().await;
    h.state.lock().await.head_changed = true;
    let app = h.initialize().await;
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .state
            == "failed"
    })
    .await;
    let job = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert!(!job.backfill_complete);
    assert_eq!(job.failure_code.as_deref(), Some("repository_changed"));
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 0);
    h.state.lock().await.head_changed = false;
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    })
    .await;
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 1);
    stop(app).await;
    h.db.close().await;
}

#[tokio::test]
async fn account_inactive_hides_rows_and_verified_reactivation_restores_them() {
    let h = Harness::new().await;
    h.authorize().await;
    let app = h.initialize().await;
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    })
    .await;
    h.state.lock().await.active = false;
    app.backfills
        .as_ref()
        .unwrap()
        .schedule(ALICE, false)
        .await
        .unwrap();
    until(|| async {
        h.db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_none()
    })
    .await;
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 0);
    assert!(!h.db.repositories().is_suppressed(ALICE).await.unwrap());
    h.state.lock().await.active = true;
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    })
    .await;
    assert!(
        h.db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 1);
    stop(app).await;
    h.db.close().await;
}

#[tokio::test]
async fn pds_migration_during_snapshot_retries_without_visibility() {
    let h = Harness::new().await;
    h.authorize().await;
    h.state.lock().await.migrate_at_document = Some(3);
    let app = h.initialize().await;
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .state
            == "failed"
    })
    .await;
    assert_eq!(
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .failure_code
            .as_deref(),
        Some("repository_changed")
    );
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 0);
    stop(app).await;
    h.db.close().await;
}

#[tokio::test]
async fn disconnect_during_snapshot_preserves_suppression() {
    let h = Harness::new().await;
    h.authorize().await;
    let pause = Arc::new(Pause::default());
    h.state.lock().await.pause_car = Some(pause.clone());
    let app = h.initialize().await;
    timeout(Duration::from_secs(5), pause.entered.notified())
        .await
        .unwrap();
    h.db.repositories()
        .disconnect(ALICE.into(), now().to_rfc3339())
        .await
        .unwrap();
    h.state.lock().await.active = false;
    pause.release.notify_one();
    until(|| async { app.backfills.as_ref().unwrap().active() == 0 }).await;
    assert!(h.db.repositories().is_suppressed(ALICE).await.unwrap());
    assert!(h.db.repositories().user(ALICE).await.unwrap().is_none());
    let status_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM indexing_status WHERE scope=?")
        .bind(ALICE)
        .fetch_one(h.db.reader_pool())
        .await
        .unwrap();
    assert_eq!(status_rows, 0);
    stop(app).await;
    h.db.close().await;
}

async fn stale_inactive_response(reconnect: bool) {
    let h = Harness::new().await;
    h.authorize().await;
    let pause = Arc::new(Pause::default());
    {
        let mut state = h.state.lock().await;
        state.active = false;
        state.pause_status = Some(pause.clone());
    }
    let app = h.initialize().await;
    timeout(Duration::from_secs(5), pause.entered.notified())
        .await
        .unwrap();
    let before =
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .generation;
    if reconnect {
        h.db.repositories()
            .disconnect(ALICE.into(), now().to_rfc3339())
            .await
            .unwrap();
    }
    h.authorize().await;
    let after =
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .generation;
    assert!(after > before);
    let authorized_active =
        h.db.repositories()
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .active;
    h.state.lock().await.active = true;
    pause.release.notify_one();
    until(|| async { app.backfills.as_ref().unwrap().active() == 0 }).await;
    assert_eq!(
        h.db.repositories()
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .active,
        authorized_active
    );
    assert_eq!(
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .generation,
        after
    );
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    })
    .await;
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 1);
    stop(app).await;
    h.db.close().await;
}

#[tokio::test]
async fn stale_inactive_response_cannot_override_fresh_oauth_generation() {
    stale_inactive_response(false).await;
}

#[tokio::test]
async fn disconnect_reauthorize_cannot_reuse_an_old_backfill_generation() {
    stale_inactive_response(true).await;
}
