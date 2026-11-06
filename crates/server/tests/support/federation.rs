//! Controlled port-zero AT PDS writers. These generated signatures never count as live evidence.
#![allow(dead_code)]
#[path = "../../../atproto/tests/support/signed_repo.rs"]
pub mod signed_repo;
use async_trait::async_trait;
use atmusic_atproto::sync::{
    accounts::{AccountReconciler, AccountSource, AccountStatus},
    backfill::{BackfillCoordinator, BackfillError, FetchedSnapshot, ReceiptClock, SnapshotSource},
    frames::{Action, CommitEvent, MAX_FRAME_BYTES},
    stream::{ReconnectClock, ReconnectJitter, RelayConnection, RelayTransport, StreamError},
    verify::{
        SigningKeyResolver, TrustedSigningKey, VerificationError, VerifiedMutation, VerifiedRecord,
        verify_snapshot,
    },
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atmusic_server::{
    AppState, router_with_state,
    workers::relay::{RelayDependencies, RelayWorker},
};
use atmusic_storage::{Database, User};
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use ipld_core::ipld::Ipld;
use serde::Deserialize;
use serde_json::{Value, json};
use signed_repo::{SignedFixture, signed_mutation, signed_repo_for};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use url::Url;
pub const ALICE: &str = signed_repo::ALICE;
pub const CAROL: &str = "did:plc:cccccccccccccccccccccccc";
pub const RELAY: &str = "wss://relay.fixture.music/";
pub const SCROBBLE: &str = "com.example.atmusic.scrobble";
pub const FOLLOW: &str = "com.example.atmusic.follow";
pub fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
pub fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
pub fn record(artist: &str, track: &str) -> Value {
    json!({"$type":SCROBBLE,"artist":artist,"track":track,"album":"Dummy","listenedAt":"2026-01-15T11:15:00Z","createdAt":"2026-01-15T12:00:00Z"})
}
pub fn follow(subject: &str) -> Value {
    json!({"$type":FOLLOW,"subject":subject,"createdAt":"2026-01-15T12:00:00Z"})
}
pub struct Clock;
impl ReceiptClock for Clock {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
impl atmusic_server::Clock for Clock {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
#[async_trait]
impl ReconnectClock for Clock {
    async fn sleep(&self, _: Duration) {
        tokio::task::yield_now().await;
    }
}
struct ZeroJitter;
impl ReconnectJitter for ZeroJitter {
    fn millis(&self, _: Duration) -> u64 {
        0
    }
}

#[derive(Default)]
pub struct Keys(pub Mutex<BTreeMap<String, Vec<TrustedSigningKey>>>);
#[async_trait]
impl SigningKeyResolver for Keys {
    async fn resolve_for_revision(
        &self,
        did: &str,
        revision: &str,
    ) -> Result<TrustedSigningKey, VerificationError> {
        self.0
            .lock()
            .unwrap()
            .get(did)
            .and_then(|keys| {
                keys.iter().find(|k| {
                    revision >= k.valid_from.as_str()
                        && k.valid_until
                            .as_deref()
                            .is_none_or(|until| revision < until)
                })
            })
            .cloned()
            .ok_or(VerificationError::UntrustedIdentity)
    }
}
impl Keys {
    pub fn insert(&self, key: TrustedSigningKey) {
        self.0
            .lock()
            .unwrap()
            .entry(key.did.clone())
            .or_default()
            .push(key);
    }
    pub fn rotate(&self, mut key: TrustedSigningKey, revision: &str) {
        let mut keys = self.0.lock().unwrap();
        let entries = keys.get_mut(&key.did).unwrap();
        entries.last_mut().unwrap().valid_until = Some(revision.into());
        key.valid_from = revision.into();
        entries.push(key);
    }
}
pub struct Relay {
    pub frames: Mutex<VecDeque<Vec<u8>>>,
    pub requests: Mutex<Vec<Url>>,
    pub covered: Mutex<BTreeSet<String>>,
    sequence: AtomicU64,
}
impl Relay {
    fn new() -> Self {
        Self {
            frames: Mutex::new(VecDeque::new()),
            requests: Mutex::new(vec![]),
            covered: Mutex::new(BTreeSet::from([ALICE.into(), CAROL.into()])),
            sequence: AtomicU64::new(0),
        }
    }
    pub fn publish(&self, event: &mut CommitEvent) {
        event.sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        if self.covered.lock().unwrap().contains(&event.did) {
            self.frames.lock().unwrap().push_back(commit_frame(event));
        }
    }
    pub fn push(&self, event: &CommitEvent) {
        self.frames.lock().unwrap().push_back(commit_frame(event));
    }
    pub fn error(&self, code: &str) {
        self.frames.lock().unwrap().push_back(error_frame(code));
    }
    pub fn identity(&self, did: &str) {
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        self.frames.lock().unwrap().push_back(frame(
            map([
                ("op", Ipld::Integer(1)),
                ("t", Ipld::String("#identity".into())),
            ]),
            map([
                ("seq", Ipld::Integer(seq.into())),
                ("did", Ipld::String(did.into())),
                ("time", Ipld::String(now().to_rfc3339())),
            ]),
        ));
    }
}
struct Connection(VecDeque<Vec<u8>>);
#[async_trait]
impl RelayConnection for Connection {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        Ok(self.0.pop_front())
    }
}
#[async_trait]
impl RelayTransport for Relay {
    async fn connect(
        &self,
        url: &Url,
        max: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError> {
        assert_eq!(max, MAX_FRAME_BYTES);
        self.requests.lock().unwrap().push(url.clone());
        Ok(Box::new(Connection(std::mem::take(
            &mut *self.frames.lock().unwrap(),
        ))))
    }
}
fn map(fields: impl IntoIterator<Item = (&'static str, Ipld)>) -> Ipld {
    Ipld::Map(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn frame(header: Ipld, body: Ipld) -> Vec<u8> {
    let mut bytes = serde_ipld_dagcbor::to_vec(&header).unwrap();
    bytes.extend(serde_ipld_dagcbor::to_vec(&body).unwrap());
    bytes
}
fn error_frame(code: &str) -> Vec<u8> {
    frame(
        map([("op", Ipld::Integer(-1))]),
        map([("error", Ipld::String(code.into()))]),
    )
}
fn commit_frame(event: &CommitEvent) -> Vec<u8> {
    let ops = event
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
    frame(
        map([
            ("op", Ipld::Integer(1)),
            ("t", Ipld::String("#commit".into())),
        ]),
        map([
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
            ("ops", Ipld::List(ops)),
            ("tooBig", Ipld::Bool(false)),
        ]),
    )
}

#[derive(Default)]
pub struct RequestCounts {
    pub create: AtomicU64,
    pub update: AtomicU64,
    pub delete: AtomicU64,
    pub snapshots: AtomicU64,
    pub app_posts: AtomicU64,
}
struct PdsState {
    did: String,
    repo: tokio::sync::Mutex<SignedFixture>,
    seed: AtomicU8,
    revision: AtomicU64,
    relay: Arc<Relay>,
    counts: Arc<RequestCounts>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteInput {
    repo: String,
    collection: String,
    rkey: String,
    record: Option<Value>,
}
fn revision(count: u64) -> String {
    let alphabet = b"234567abcdefghijklmnopqrstuvwxyz";
    let mut suffix = [b'2'; 4];
    let mut n = count;
    for c in suffix.iter_mut().rev() {
        *c = alphabet[(n % 32) as usize];
        n /= 32;
    }
    format!("3m4zm2ufr{}", std::str::from_utf8(&suffix).unwrap())
}
async fn mutate(state: Arc<PdsState>, input: WriteInput, action: Action) -> Response {
    if input.repo != state.did || ![SCROBBLE, FOLLOW].contains(&input.collection.as_str()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let path = format!("{}/{}", input.collection, input.rkey);
    let mut repo = state.repo.lock().await;
    let exists = repo
        .event
        .operations
        .iter()
        .any(|op| op.path == path && op.cid.is_some());
    // The maintained repository verifies actual create/update/delete membership below.
    let _ = exists;
    let count = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
    let rev = revision(count);
    let mut next = signed_mutation(
        &repo,
        &path,
        if action == Action::Delete {
            None
        } else {
            input.record
        },
        state.seed.load(Ordering::SeqCst),
        &rev,
    )
    .await;
    state.relay.publish(&mut next.event);
    let cid = next.event.operations[0].cid;
    *repo = next;
    match action {
        Action::Create => {
            state.counts.create.fetch_add(1, Ordering::SeqCst);
        }
        Action::Update => {
            state.counts.update.fetch_add(1, Ordering::SeqCst);
        }
        Action::Delete => {
            state.counts.delete.fetch_add(1, Ordering::SeqCst);
        }
    }
    Json(json!({"uri":format!("at://{}/{}",state.did,path),"cid":cid.map(|v|v.to_string())}))
        .into_response()
}
async fn create(State(s): State<Arc<PdsState>>, Json(v): Json<WriteInput>) -> Response {
    mutate(s, v, Action::Create).await
}
async fn update(State(s): State<Arc<PdsState>>, Json(v): Json<WriteInput>) -> Response {
    mutate(s, v, Action::Update).await
}
async fn delete(State(s): State<Arc<PdsState>>, Json(v): Json<WriteInput>) -> Response {
    mutate(s, v, Action::Delete).await
}
async fn snapshot(State(s): State<Arc<PdsState>>) -> Response {
    s.counts.snapshots.fetch_add(1, Ordering::SeqCst);
    (
        [(axum::http::header::CONTENT_TYPE, "application/vnd.ipld.car")],
        s.repo.lock().await.event.blocks.clone(),
    )
        .into_response()
}
async fn status(State(s): State<Arc<PdsState>>) -> Json<Value> {
    Json(json!({"did":s.did,"active":true}))
}
pub struct Writer {
    pub did: String,
    pub origin: Url,
    pub counts: Arc<RequestCounts>,
    state: Arc<PdsState>,
    task: tokio::task::JoinHandle<()>,
}
impl Writer {
    async fn start(did: &str, seed: u8, relay: Arc<Relay>, keys: &Keys) -> Self {
        let repo = signed_repo_for(did, vec![], seed, &revision(0)).await;
        keys.insert(repo.key.clone());
        let counts = Arc::new(RequestCounts::default());
        let state = Arc::new(PdsState {
            did: did.into(),
            repo: tokio::sync::Mutex::new(repo),
            seed: AtomicU8::new(seed),
            revision: AtomicU64::new(0),
            relay,
            counts: counts.clone(),
        });
        let router = Router::new()
            .route("/xrpc/com.atproto.repo.createRecord", post(create))
            .route("/xrpc/com.atproto.repo.putRecord", post(update))
            .route("/xrpc/com.atproto.repo.deleteRecord", post(delete))
            .route("/xrpc/com.atproto.sync.getRepo", get(snapshot))
            .route("/xrpc/com.atproto.sync.getRepoStatus", get(status))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            did: did.into(),
            origin,
            counts,
            state,
            task,
        }
    }
    pub async fn create(&self, collection: &str, rkey: &str, record: Value) -> Value {
        self.write("createRecord", collection, rkey, Some(record))
            .await
    }
    pub async fn update(&self, collection: &str, rkey: &str, record: Value) -> Value {
        self.write("putRecord", collection, rkey, Some(record))
            .await
    }
    pub async fn delete(&self, collection: &str, rkey: &str) -> Value {
        self.write("deleteRecord", collection, rkey, None).await
    }
    async fn write(
        &self,
        method: &str,
        collection: &str,
        rkey: &str,
        record: Option<Value>,
    ) -> Value {
        reqwest::Client::new()
            .post(
                self.origin
                    .join(&format!("xrpc/com.atproto.repo.{method}"))
                    .unwrap(),
            )
            .json(&json!({"repo":self.did,"collection":collection,"rkey":rkey,"record":record}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    pub async fn repository(&self) -> SignedFixture {
        self.state.repo.lock().await.clone()
    }
    pub async fn rotate(&self, seed: u8, keys: &Keys) -> SignedFixture {
        self.state.seed.store(seed, Ordering::SeqCst);
        let value = record("Portishead", "Roads rotated");
        self.update(SCROBBLE, "r10", value).await;
        let repo = self.repository().await;
        keys.rotate(repo.key.clone(), &repo.event.revision);
        repo
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct Source {
    endpoints: BTreeMap<String, Url>,
    pub overrides: Mutex<BTreeMap<String, Vec<u8>>>,
}
#[async_trait]
impl SnapshotSource for Source {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        let pds = self
            .endpoints
            .get(did)
            .ok_or(BackfillError::InvalidSnapshot)?;
        let override_bytes = self.overrides.lock().unwrap().get(did).cloned();
        let bytes = if let Some(bytes) = override_bytes {
            bytes
        } else {
            reqwest::Client::new()
                .get(pds.join("xrpc/com.atproto.sync.getRepo").unwrap())
                .send()
                .await
                .map_err(|_| BackfillError::InvalidSnapshot)?
                .bytes()
                .await
                .map_err(|_| BackfillError::InvalidSnapshot)?
                .to_vec()
        };
        Ok(FetchedSnapshot {
            pds: pds.to_string(),
            bytes,
        })
    }
}
#[async_trait]
impl AccountSource for Source {
    async fn current(&self, did: &str) -> Result<AccountStatus, BackfillError> {
        let pds = self
            .endpoints
            .get(did)
            .ok_or(BackfillError::InvalidSnapshot)?;
        let value: Value = reqwest::Client::new()
            .get(pds.join("xrpc/com.atproto.sync.getRepoStatus").unwrap())
            .send()
            .await
            .map_err(|_| BackfillError::InvalidSnapshot)?
            .json()
            .await
            .map_err(|_| BackfillError::InvalidSnapshot)?;
        if value["did"] != did {
            return Err(BackfillError::InvalidSnapshot);
        }
        Ok(AccountStatus {
            did: did.into(),
            pds: pds.to_string(),
            active: value["active"]
                .as_bool()
                .ok_or(BackfillError::InvalidSnapshot)?,
        })
    }
}
async fn count_posts(
    State(counts): State<Arc<RequestCounts>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.method() == axum::http::Method::POST && request.uri().path() == "/api/v1/scrobbles" {
        counts.app_posts.fetch_add(1, Ordering::SeqCst);
    }
    next.run(request).await
}
pub struct App {
    pub origin: Url,
    pub counts: Arc<RequestCounts>,
    task: tokio::task::JoinHandle<()>,
}
impl App {
    pub async fn start(db: &Database) -> Self {
        let counts = Arc::new(RequestCounts::default());
        let config = atmusic_server::config::Config::from_values(
            "127.0.0.1:0".parse().unwrap(),
            std::path::PathBuf::from("fixture.sqlite"),
            "https://music.fixture.music",
            &"11".repeat(32),
            Some(FIXTURE_PREFIX),
            Some(RELAY),
        )
        .unwrap();
        let state = AppState::new(config, Some(db.clone())).with_clock(Arc::new(Clock));
        let router = router_with_state(state)
            .layer(middleware::from_fn_with_state(counts.clone(), count_posts));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            origin,
            counts,
            task,
        }
    }
    pub async fn get(&self, path: &str) -> Value {
        reqwest::get(self.origin.join(path).unwrap())
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}
impl Drop for App {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub struct Harness {
    pub directory: tempfile::TempDir,
    pub db: Database,
    pub relay: Arc<Relay>,
    pub keys: Arc<Keys>,
    pub alice: Writer,
    pub carol: Writer,
    pub source: Arc<Source>,
    pub backfills: Arc<BackfillCoordinator>,
    pub worker: RelayWorker,
    pub app: App,
}
impl Harness {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("federation.sqlite"))
            .await
            .unwrap();
        for did in [ALICE, CAROL] {
            db.repositories()
                .upsert_user(User::new(did, now().to_rfc3339()))
                .await
                .unwrap();
        }
        let relay = Arc::new(Relay::new());
        let keys = Arc::new(Keys::default());
        let alice = Writer::start(ALICE, 7, relay.clone(), &keys).await;
        let carol = Writer::start(CAROL, 9, relay.clone(), &keys).await;
        assert_ne!(
            alice.repository().await.key.did_key,
            carol.repository().await.key.did_key
        );
        let source = Arc::new(Source {
            endpoints: BTreeMap::from([
                (ALICE.into(), alice.origin.clone()),
                (CAROL.into(), carol.origin.clone()),
            ]),
            overrides: Mutex::new(BTreeMap::new()),
        });
        let backfills = Arc::new(BackfillCoordinator::new(
            db.repositories(),
            namespace(),
            source.clone(),
            keys.clone(),
            Arc::new(Clock),
        ));
        let worker = make_worker(
            &db,
            relay.clone(),
            keys.clone(),
            source.clone(),
            backfills.clone(),
        );
        let app = App::start(&db).await;
        Self {
            directory,
            db,
            relay,
            keys,
            alice,
            carol,
            source,
            backfills,
            worker,
            app,
        }
    }
    pub async fn index(&self) {
        self.worker.run_session().await.unwrap();
    }
    pub async fn recover(&self) {
        self.backfills.schedule_known().await.unwrap();
        let result = self.backfills.run_batch().await.unwrap();
        assert!(result.iter().all(|r| r.result.is_ok()));
    }
    pub async fn assert_converged(&self) {
        assert_exact(&self.db, &[&self.alice, &self.carol], self.keys.as_ref()).await;
    }
    pub async fn close(self) {
        self.db.close().await;
    }
}
pub fn make_worker(
    db: &Database,
    relay: Arc<Relay>,
    keys: Arc<Keys>,
    source: Arc<Source>,
    backfills: Arc<BackfillCoordinator>,
) -> RelayWorker {
    let accounts = Arc::new(AccountReconciler::new(
        db.repositories(),
        source,
        backfills.clone(),
    ));
    RelayWorker::new(
        db.repositories(),
        RELAY.into(),
        namespace(),
        RelayDependencies {
            transport: relay,
            resolver: keys,
            clock: Arc::new(Clock),
            backfills,
        },
    )
    .with_accounts(accounts)
    .with_jitter(Arc::new(ZeroJitter))
}
pub async fn assert_exact(db: &Database, writers: &[&Writer], keys: &dyn SigningKeyResolver) {
    let mut expected = BTreeMap::new();
    for writer in writers {
        let bytes = reqwest::get(writer.origin.join("xrpc/com.atproto.sync.getRepo").unwrap())
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let verified = verify_snapshot(&bytes, &writer.did, &namespace(), now(), keys)
            .await
            .unwrap();
        for m in verified.mutations() {
            if let VerifiedMutation::Put { uri, cid, record } = m {
                expected.insert(
                    uri.clone(),
                    (
                        cid.to_string(),
                        serde_json::to_value(match record.as_ref() {
                            VerifiedRecord::Scrobble(r) => serde_json::to_value(r).unwrap(),
                            VerifiedRecord::Follow(r) => serde_json::to_value(r).unwrap(),
                        })
                        .unwrap(),
                    ),
                );
            }
        }
    }
    let scrobbles:Vec<atmusic_storage::ScrobbleRow>=sqlx::query_as("SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did WHERE u.active=1 AND s.confirmed=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=s.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=s.did)").fetch_all(db.reader_pool()).await.unwrap();
    let follows:Vec<atmusic_storage::FollowRow>=sqlx::query_as("SELECT f.* FROM follows f JOIN users u ON u.did=f.actor WHERE u.active=1 AND f.confirmed=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor)").fetch_all(db.reader_pool()).await.unwrap();
    let mut actual = BTreeMap::new();
    for row in scrobbles {
        let value = json!({"$type":SCROBBLE,"artist":row.artist,"track":row.track,"album":row.album,"listenedAt":canonical(&row.listened_at),"createdAt":canonical(&row.created_at)});
        actual.insert(row.uri, (row.cid, value));
    }
    for row in follows {
        actual.insert(row.uri,(row.cid,json!({"$type":FOLLOW,"subject":row.subject,"createdAt":canonical(&row.created_at)})));
    }
    for (_, value) in expected.values_mut() {
        for field in ["listenedAt", "createdAt"] {
            if let Some(time) = value.get(field).and_then(Value::as_str).map(canonical) {
                value[field] = Value::String(time);
            }
        }
    }
    assert_eq!(
        actual, expected,
        "complete URI/CID/payload projection differs from verified remote repositories"
    );
    for writer in writers {
        let expected_total = expected
            .iter()
            .filter(|(uri, (_, value))| {
                uri.starts_with(&format!("at://{}/", writer.did)) && value["$type"] == SCROBBLE
            })
            .count() as i64;
        assert_eq!(
            db.repositories()
                .public_counts(&writer.did)
                .await
                .unwrap()
                .0,
            expected_total
        );
        let stats = db
            .repositories()
            .statistics(
                &writer.did,
                atmusic_storage::StatisticsWindow::All,
                now(),
                100,
            )
            .await
            .unwrap();
        assert_eq!(stats.total_scrobbles, expected_total as u64);
    }
}
fn canonical(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
}
