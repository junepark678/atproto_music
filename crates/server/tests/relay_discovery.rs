//! First matching stream events are hints; fresh account and signed-head proof admits data.
#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;

use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{DnsResolver, FetchError, HttpResponse, HttpTransport, SafeClient},
    identity::IdentityResolver,
    sync::{
        accounts::PdsAccountSource,
        backfill::{BackfillCoordinator, PdsSnapshotSource, ReceiptClock},
        current_head::CurrentHeadResolver,
        frames::{Action, CommitEvent, MAX_FRAME_BYTES},
        stream::{ReconnectClock, RelayConnection, RelayTransport, StreamError},
        verify::VerificationError,
    },
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atmusic_server::{
    AppState, Clock,
    config::Config,
    router_with_state,
    startup::AccountSnapshotSource,
    workers::relay::{RelayDependencies, RelayWorker},
};
use atmusic_storage::{Database, PageBounds, SnapshotOutcome, User};
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use ipld_core::ipld::Ipld;
use serde_json::{Value, json};
use signed_repo::{ALICE, REVISION, SignedFixture};
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
    time::timeout,
};
use tower::ServiceExt;
use url::Url;

const PDS: &str = "https://pds.fixture.test/";
const RELAY: &str = "wss://relay.fixture.test/";
const PATH: &str = "com.example.atmusic.scrobble/r01";
fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
fn record() -> Value {
    json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2026-01-14T12:00:00Z","createdAt":"2026-01-14T12:00:00Z"})
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
#[async_trait]
impl ReconnectClock for Frozen {
    async fn sleep(&self, _: Duration) {
        tokio::task::yield_now().await;
    }
}
#[derive(Default)]
struct Pause {
    entered: Notify,
    release: Notify,
}
struct Upstream {
    fixture: SignedFixture,
    active: bool,
    requests: Vec<(String, String)>,
    pause_car: Option<Arc<Pause>>,
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
            Some("plc.directory" | "pds.fixture.test")
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
        Ok(HttpResponse {
            status: response.status().as_u16(),
            headers: response
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
                .collect(),
            body: response
                .bytes()
                .await
                .map_err(|_| FetchError::Transport)?
                .to_vec(),
        })
    }
}
async fn endpoint(
    State(state): State<Arc<Mutex<Upstream>>>,
    request: Request,
) -> axum::response::Response {
    let url = Url::parse(request.headers()["x-fixture-url"].to_str().unwrap()).unwrap();
    let method = request.method().to_string();
    let mut state = state.lock().await;
    state.requests.push((method.clone(), url.to_string()));
    if url.host_str() == Some("plc.directory") {
        assert_eq!(url.path(), format!("/{ALICE}"));
        assert_eq!(method, "GET");
        return axum::Json(json!({"id":ALICE,"service":[{"id":format!("{ALICE}#atproto_pds"),"type":"AtprotoPersonalDataServer","serviceEndpoint":PDS}],"verificationMethod":[{"id":format!("{ALICE}#atproto"),"controller":ALICE,"type":"Multikey","publicKeyMultibase":state.fixture.key.did_key.strip_prefix("did:key:").unwrap()}]})).into_response();
    }
    assert_eq!(
        url.origin().ascii_serialization(),
        PDS.trim_end_matches('/')
    );
    if url.path() == "/xrpc/com.atproto.repo.putRecord" {
        assert_eq!(method, "POST");
        let body: Value =
            serde_json::from_slice(&to_bytes(request.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"repo":ALICE,"collection":"com.example.atmusic.scrobble","rkey":"r01","record":record()})
        );
        state.fixture = signed_repo::signed_mutation(
            &state.fixture,
            PATH,
            Some(body["record"].clone()),
            7,
            REVISION,
        )
        .await;
        return axum::Json(json!({"uri":format!("at://{ALICE}/{PATH}"),"cid":state.fixture.record_cids[0].to_string()})).into_response();
    }
    assert_eq!(method, "GET");
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("did".into(), ALICE.into())]
    );
    match url.path() {
        "/xrpc/com.atproto.sync.getRepoStatus" => axum::Json(json!({"did":ALICE,"active":state.active})).into_response(),
        "/xrpc/com.atproto.sync.getLatestCommit" => axum::Json(json!({"cid":state.fixture.event.commit.to_string(),"rev":state.fixture.event.revision})).into_response(),
        "/xrpc/com.atproto.sync.getRepo" => {
            let bytes = state.fixture.event.blocks.clone(); let pause = state.pause_car.take(); drop(state);
            if let Some(pause) = pause { pause.entered.notify_one(); pause.release.notified().await; }
            ([("content-type", "application/vnd.ipld.car")], bytes).into_response()
        }
        _ => panic!("unexpected discovery fixture request: {url}"),
    }
}
struct Connection(VecDeque<Vec<u8>>);
#[async_trait]
impl RelayConnection for Connection {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        Ok(self.0.pop_front())
    }
}
struct Stream(Vec<Vec<u8>>);
#[async_trait]
impl RelayTransport for Stream {
    async fn connect(
        &self,
        url: &Url,
        max: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError> {
        assert_eq!(max, MAX_FRAME_BYTES);
        assert_eq!(url.query(), None);
        Ok(Box::new(Connection(self.0.clone().into())))
    }
}
fn map(fields: impl IntoIterator<Item = (&'static str, Ipld)>) -> Ipld {
    Ipld::Map(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn commit(event: &CommitEvent) -> Vec<u8> {
    let operations = event
        .operations
        .iter()
        .map(|op| {
            map([
                (
                    "action",
                    Ipld::String(
                        match op.action {
                            Action::Create => "create",
                            Action::Update => "update",
                            Action::Delete => "delete",
                        }
                        .into(),
                    ),
                ),
                ("path", Ipld::String(op.path.clone())),
                ("cid", op.cid.map(Ipld::Link).unwrap_or(Ipld::Null)),
            ])
        })
        .collect();
    let mut bytes = serde_ipld_dagcbor::to_vec(&map([
        ("op", Ipld::Integer(1)),
        ("t", Ipld::String("#commit".into())),
    ]))
    .unwrap();
    bytes.extend(
        serde_ipld_dagcbor::to_vec(&map([
            ("seq", Ipld::Integer(event.sequence.into())),
            ("repo", Ipld::String(event.did.clone())),
            ("rev", Ipld::String(event.revision.clone())),
            (
                "since",
                event.since.clone().map(Ipld::String).unwrap_or(Ipld::Null),
            ),
            ("commit", Ipld::Link(event.commit)),
            ("time", Ipld::String(event.time.clone())),
            ("blocks", Ipld::Bytes(event.blocks.clone())),
            ("ops", Ipld::List(operations)),
            ("tooBig", Ipld::Bool(false)),
        ]))
        .unwrap(),
    );
    bytes
}
fn changed_commit(
    event: &CommitEvent,
    changes: impl IntoIterator<Item = (&'static str, Ipld)>,
) -> Vec<u8> {
    let bytes = commit(event);
    let header = serde_ipld_dagcbor::to_vec(&map([
        ("op", Ipld::Integer(1)),
        ("t", Ipld::String("#commit".into())),
    ]))
    .unwrap();
    let Ipld::Map(mut body) =
        serde_ipld_dagcbor::from_slice::<Ipld>(&bytes[header.len()..]).unwrap()
    else {
        unreachable!()
    };
    for (key, value) in changes {
        body.insert(key.into(), value);
    }
    let mut bytes = header;
    bytes.extend(serde_ipld_dagcbor::to_vec(&Ipld::Map(body)).unwrap());
    bytes
}
fn bare_backfill(event_type: &str) -> Vec<u8> {
    let mut bytes = serde_ipld_dagcbor::to_vec(&map([
        ("op", Ipld::Integer(1)),
        ("t", Ipld::String(event_type.into())),
    ]))
    .unwrap();
    bytes.extend(
        serde_ipld_dagcbor::to_vec(&map([
            ("seq", Ipld::Integer(1)),
            ("did", Ipld::String(ALICE.into())),
            ("rev", Ipld::String(REVISION.into())),
        ]))
        .unwrap(),
    );
    bytes
}
struct Harness {
    directory: tempfile::TempDir,
    db: Database,
    state: Arc<Mutex<Upstream>>,
    client: SafeClient,
    address: SocketAddr,
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
        let db = Database::open(directory.path().join("discovery.sqlite"))
            .await
            .unwrap();
        let state = Arc::new(Mutex::new(Upstream {
            fixture: signed_repo::signed_repo_for(ALICE, vec![], 7, "2222222222222").await,
            active: true,
            requests: vec![],
            pause_car: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .fallback(endpoint)
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = SafeClient::new(Arc::new(FixtureDns), Arc::new(Wire(address)));
        Self {
            directory,
            db,
            state,
            client,
            address,
            task,
        }
    }
    async fn external_write(&self) -> SignedFixture {
        let response = reqwest::Client::builder().no_proxy().build().unwrap()
            .post(format!("http://{}/xrpc/com.atproto.repo.putRecord",self.address))
            .header("x-fixture-url",format!("{PDS}xrpc/com.atproto.repo.putRecord"))
            .json(&json!({"repo":ALICE,"collection":"com.example.atmusic.scrobble","rkey":"r01","record":record()}))
            .send().await.unwrap();
        assert_eq!(response.status(), 200);
        let value: Value = response.json().await.unwrap();
        let fixture = self.state.lock().await.fixture.clone();
        assert_eq!(value["cid"], fixture.record_cids[0].to_string());
        fixture
    }
    fn workers(&self, frames: Vec<Vec<u8>>) -> (RelayWorker, Arc<BackfillCoordinator>) {
        let repository = self.db.repositories();
        let identity = IdentityResolver::new(self.client.clone());
        let clock = Arc::new(Frozen);
        let source = Arc::new(AccountSnapshotSource::new(
            repository.clone(),
            Arc::new(PdsAccountSource::new(identity.clone(), self.client.clone())),
            Arc::new(PdsSnapshotSource::new(identity, self.client.clone())),
            clock.clone(),
        ));
        let resolver = Arc::new(CurrentHeadResolver::new(self.client.clone()));
        let backfills = Arc::new(BackfillCoordinator::new(
            repository.clone(),
            namespace(),
            source,
            resolver.clone(),
            clock.clone(),
        ));
        let relay = RelayWorker::new(
            repository,
            RELAY.into(),
            namespace(),
            RelayDependencies {
                transport: Arc::new(Stream(frames)),
                resolver,
                clock,
                backfills: backfills.clone(),
            },
        );
        (relay, backfills)
    }
    async fn http(&self, path: &str) -> (u16, Value) {
        let config = Config::from_values(
            "127.0.0.1:0".parse().unwrap(),
            self.directory.path().join("discovery.sqlite"),
            "https://app.fixture.test",
            &"11".repeat(32),
            Some(FIXTURE_PREFIX),
            Some(RELAY),
        )
        .unwrap();
        let app = router_with_state(
            AppState::new(config, Some(self.db.clone())).with_clock(Arc::new(Frozen)),
        );
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }
    async fn hidden(&self) {
        let repository = self.db.repositories();
        assert!(repository.active_user(ALICE).await.unwrap().is_none());
        assert!(
            repository
                .history(ALICE, PageBounds::default())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            repository
                .feed(None, PageBounds::default())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(repository.public_counts(ALICE).await.unwrap(), (0, 0, 0));
        assert!(repository.checkpoint(RELAY).await.unwrap().is_none());
        assert_eq!(
            self.http(&format!("/api/v1/users/{ALICE}/profile")).await.0,
            404
        );
    }
}

#[tokio::test]
async fn external_writer_discovered() {
    let h = Harness::new().await;
    let f = h.external_write().await;
    assert!(h.db.repositories().user(ALICE).await.unwrap().is_none());
    let (relay, backfills) = h.workers(vec![commit(&f.event)]);
    let result = relay.run_session().await.unwrap();
    assert!(result.recovery_requested);
    assert_eq!(result.applied, 0);
    h.hidden().await;
    let job = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert!(job.reactivate);
    assert_eq!(job.state, "pending");
    assert_eq!(
        h.state.lock().await.requests.len(),
        1,
        "relay hint must make no trusted network claim"
    );
    let results = backfills.run_batch().await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Complete
    );
    let rows =
        h.db.repositories()
            .history(ALICE, PageBounds::default())
            .await
            .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].uri, format!("at://{ALICE}/{PATH}"));
    assert_eq!(rows[0].cid, f.record_cids[0].to_string());
    assert_eq!(rows[0].revision, f.event.revision);
    assert_eq!(
        (rows[0].artist.as_str(), rows[0].track.as_str()),
        ("Björk", "Jóga")
    );
    let (status, profile) = h.http(&format!("/api/v1/users/{ALICE}/profile")).await;
    assert_eq!(status, 200);
    assert_eq!(profile["totalScrobbles"], 1);
    assert_eq!(profile["indexing"]["caughtUp"], false);
    assert_eq!(
        h.http(&format!("/api/v1/users/{ALICE}/stats")).await.1["totalScrobbles"],
        1
    );
    assert!(
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .is_none()
    );
    let requests = &h.state.lock().await.requests;
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "POST")
            .count(),
        1
    );
    assert!(
        requests.iter().all(|(_, url)| !url.contains("/api/")),
        "external writer never uses application POST"
    );
    for (path, count) in [("getRepoStatus", 2), ("getRepo", 1), ("getLatestCommit", 1)] {
        assert_eq!(
            requests
                .iter()
                .filter(|(_, url)| Url::parse(url).unwrap().path()
                    == format!("/xrpc/com.atproto.sync.{path}"))
                .count(),
            count
        );
    }
    for table in ["oauth_tokens", "sessions", "operations", "outbox"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(h.db.reader_pool())
            .await
            .unwrap();
        assert_eq!(count, 0, "discovery creates no {table}");
    }
    // Oversized/rebased commit hints preserve the same configured operation boundary.
    for flag in ["tooBig", "rebase"] {
        let h = Harness::new().await;
        let f = h.external_write().await;
        let (relay, backfills) =
            h.workers(vec![changed_commit(&f.event, [(flag, Ipld::Bool(true))])]);
        let outcome = relay.run_session().await.unwrap();
        assert!(outcome.recovery_requested);
        assert_eq!(outcome.applied, 0);
        h.hidden().await;
        assert_eq!(
            backfills.run_batch().await.unwrap()[0]
                .result
                .as_ref()
                .unwrap(),
            &SnapshotOutcome::Complete
        );
        let rows =
            h.db.repositories()
                .history(ALICE, PageBounds::default())
                .await
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cid, f.record_cids[0].to_string());
        assert!(
            h.db.repositories()
                .checkpoint(RELAY)
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn nonmusic_does_not_discover() {
    for mode in ["commit", "tooBig", "rebase", "#sync", "#tooBig"] {
        let h = Harness::new().await;
        let mut f = h.external_write().await;
        f.event.operations[0].path = "app.bsky.feed.post/r01".into();
        let bytes = match mode {
            "commit" => commit(&f.event),
            "tooBig" | "rebase" => changed_commit(&f.event, [(mode, Ipld::Bool(true))]),
            _ => bare_backfill(mode),
        };
        let (relay, backfills) = h.workers(vec![bytes]);
        let outcome = relay.run_session().await.unwrap();
        assert!(!outcome.recovery_requested);
        assert!(h.db.repositories().user(ALICE).await.unwrap().is_none());
        assert!(backfills.run_batch().await.unwrap().is_empty());
        assert_eq!(h.state.lock().await.requests.len(), 1);
        h.hidden().await;
    }
    // A matching string alone is insufficient: validate path, action and CID pairing first.
    for flag in ["tooBig", "rebase"] {
        for invalid in ["path", "action", "cid"] {
            let h = Harness::new().await;
            let f = h.external_write().await;
            let operation = map([
                (
                    "path",
                    Ipld::String(
                        if invalid == "path" {
                            "com.example.atmusic.scrobble/.."
                        } else {
                            PATH
                        }
                        .into(),
                    ),
                ),
                (
                    "action",
                    Ipld::String(
                        if invalid == "action" {
                            "unsupported"
                        } else {
                            "create"
                        }
                        .into(),
                    ),
                ),
                (
                    "cid",
                    if invalid == "cid" {
                        Ipld::Null
                    } else {
                        Ipld::Link(f.record_cids[0])
                    },
                ),
            ]);
            let bytes = changed_commit(
                &f.event,
                [
                    (flag, Ipld::Bool(true)),
                    ("ops", Ipld::List(vec![operation])),
                ],
            );
            let (relay, backfills) = h.workers(vec![bytes]);
            assert!(relay.run_session().await.is_err());
            assert!(h.db.repositories().user(ALICE).await.unwrap().is_none());
            assert!(backfills.run_batch().await.unwrap().is_empty());
            h.hidden().await;
        }
    }
}

#[tokio::test]
async fn duplicate_hints_coalesce() {
    let h = Harness::new().await;
    let f = h.external_write().await;
    let (first, backfills) = h.workers(vec![commit(&f.event)]);
    first.run_session().await.unwrap();
    let before = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    let (second, _) = h.workers(vec![commit(&f.event), commit(&f.event)]);
    let outcome = second.run_session().await.unwrap();
    assert!(!outcome.recovery_requested);
    assert_eq!(outcome.applied, 0);
    let after = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(after.generation, before.generation);
    assert!(after.reactivate);
    h.hidden().await;
    assert_eq!(h.state.lock().await.requests.len(), 1);
    assert_eq!(backfills.run_batch().await.unwrap().len(), 1);
    assert_eq!(
        h.db.repositories().public_counts(ALICE).await.unwrap(),
        (1, 0, 0)
    );
}

#[tokio::test]
async fn invalid_signature_hint_requires_snapshot() {
    let h = Harness::new().await;
    let good = h.external_write().await;
    let bad =
        signed_repo::signed_repo_with_bad_signature(vec![(PATH.into(), record())], 7, true).await;
    assert_ne!(good.event.commit, bad.event.commit);
    let (relay, backfills) = h.workers(vec![commit(&bad.event)]);
    assert_eq!(relay.run_session().await.unwrap().applied, 0);
    h.hidden().await;
    assert_eq!(
        backfills.run_batch().await.unwrap()[0]
            .result
            .as_ref()
            .unwrap(),
        &SnapshotOutcome::Complete
    );
    assert_eq!(
        h.db.repositories()
            .history(ALICE, PageBounds::default())
            .await
            .unwrap()[0]
            .cid,
        good.record_cids[0].to_string()
    );
    assert!(
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .is_none()
    );
    let rejected = Harness::new().await;
    rejected.state.lock().await.fixture = bad.clone();
    let (relay, backfills) = rejected.workers(vec![commit(&bad.event)]);
    relay.run_session().await.unwrap();
    let results = backfills.run_batch().await.unwrap();
    assert!(matches!(
        results[0].result,
        Err(
            atmusic_atproto::sync::backfill::BackfillError::Verification(
                VerificationError::InvalidSignature
            )
        )
    ));
    rejected.hidden().await;
    assert_eq!(
        rejected
            .db
            .repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .state,
        "failed"
    );
}

#[tokio::test]
async fn suppressed_and_known_inactive_hints() {
    let h = Harness::new().await;
    let f = h.external_write().await;
    h.db.repositories()
        .disconnect(ALICE.into(), now().to_rfc3339())
        .await
        .unwrap();
    let (relay, backfills) = h.workers(vec![commit(&f.event)]);
    assert!(!relay.run_session().await.unwrap().recovery_requested);
    assert!(h.db.repositories().user(ALICE).await.unwrap().is_none());
    assert!(h.db.repositories().backfill(ALICE).await.unwrap().is_none());
    assert!(backfills.run_batch().await.unwrap().is_empty());
    h.hidden().await;
    let inactive = Harness::new().await;
    let f = inactive.external_write().await;
    let mut user = User::new(ALICE, now().to_rfc3339());
    user.active = false;
    inactive.db.repositories().upsert_user(user).await.unwrap();
    let (relay, backfills) = inactive.workers(vec![commit(&f.event)]);
    assert!(!relay.run_session().await.unwrap().recovery_requested);
    assert!(
        inactive
            .db
            .repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .is_none()
    );
    assert!(backfills.run_batch().await.unwrap().is_empty());
    inactive.hidden().await;
    assert_eq!(inactive.state.lock().await.requests.len(), 1);
}

#[tokio::test]
async fn disconnect_during_discovery_snapshot() {
    let h = Harness::new().await;
    let f = h.external_write().await;
    let (relay, backfills) = h.workers(vec![commit(&f.event)]);
    relay.run_session().await.unwrap();
    let pause = Arc::new(Pause::default());
    h.state.lock().await.pause_car = Some(pause.clone());
    let run = tokio::spawn(async move { backfills.run_batch().await });
    timeout(Duration::from_secs(3), pause.entered.notified())
        .await
        .unwrap();
    h.db.repositories()
        .disconnect(ALICE.into(), now().to_rfc3339())
        .await
        .unwrap();
    pause.release.notify_one();
    let results = timeout(Duration::from_secs(3), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(results[0].result.is_err());
    assert!(h.db.repositories().is_suppressed(ALICE).await.unwrap());
    assert!(h.db.repositories().user(ALICE).await.unwrap().is_none());
    h.hidden().await;
}

#[tokio::test]
async fn inactive_account_never_activates() {
    let h = Harness::new().await;
    let f = h.external_write().await;
    h.state.lock().await.active = false;
    let (relay, backfills) = h.workers(vec![commit(&f.event)]);
    relay.run_session().await.unwrap();
    let results = backfills.run_batch().await.unwrap();
    assert!(matches!(
        results[0].result,
        Err(atmusic_atproto::sync::backfill::BackfillError::AccountInactive)
    ));
    h.hidden().await;
    let job = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert!(!job.reactivate);
    assert!(
        h.state
            .lock()
            .await
            .requests
            .iter()
            .all(|(_, url)| !url.contains("getRepo?") && !url.contains("getLatestCommit"))
    );
}
