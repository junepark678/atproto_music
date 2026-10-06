//! Host-only end-to-end fixture. OAuth access tokens and DPoP are checked by the
//! real port-zero authorization server; records are confirmed from signed CARs.
#![allow(dead_code)]
#[path = "../../../atproto/tests/support/oauth_pds.rs"]
mod oauth_pds;
#[path = "../../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{
        DnsResolver, FetchError, HttpRequest, HttpResponse, HttpTransport, SafeClient,
    },
    oauth::{
        service::{OAuthConfig, OAuthService},
        token_store::TokenStore,
    },
    pds::reconcile::PdsClient,
    sync::{
        backfill::{BackfillCoordinator, PdsSnapshotSource, ReceiptClock, SnapshotSource},
        verify::{TrustedSigningKey, verify_snapshot},
    },
};
use atmusic_core::namespace::{Namespace, OwnershipEvidence};
use atmusic_server::{AppState, Clock, config::Config, workers::outbox::OutboxWorker};
use atmusic_storage::Database;
use axum::{
    body::to_bytes,
    extract::{Request, State},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};
use url::Url;

pub const ALICE: &str = oauth_pds::ALICE;
pub const PREFIX: &str = "test.fixture.music";
pub const NOW: &str = "2026-01-15T12:00:00Z";
pub fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .with_timezone(&Utc)
}
pub fn input() -> Value {
    json!({"artist":"Björk","track":"Jóga","album":"Homogenic","listenedAt":NOW,"durationSeconds":300})
}
pub fn encoded(uri: &str) -> String {
    url::form_urlencoded::byte_serialize(uri.as_bytes()).collect()
}
pub fn namespace() -> Namespace {
    Namespace::with_ownership(
        PREFIX,
        OwnershipEvidence {
            domain: "fixture.test".into(),
            reference: "controlled host fixture; test only".into(),
        },
    )
    .unwrap()
}
pub struct Frozen;
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
pub struct FixtureDns;
#[async_trait]
impl DnsResolver for FixtureDns {
    async fn resolve(&self, _: &str) -> Result<Vec<IpAddr>, FetchError> {
        Ok(vec!["93.184.216.34".parse().unwrap()])
    }
    async fn txt(&self, name: &str) -> Result<Vec<String>, FetchError> {
        Ok(if name == "_atproto.alice.test" {
            vec![format!("did={ALICE}")]
        } else {
            vec![]
        })
    }
}
#[derive(Clone)]
pub struct ProxyTransport(pub SocketAddr);
#[async_trait]
impl HttpTransport for ProxyTransport {
    async fn fetch(&self, url: &Url, addresses: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        self.send(
            &HttpRequest {
                url: url.clone(),
                method: "GET".into(),
                headers: BTreeMap::new(),
                body: vec![],
            },
            addresses,
        )
        .await
    }
    async fn send(
        &self,
        request: &HttpRequest,
        _: &[SocketAddr],
    ) -> Result<HttpResponse, FetchError> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut url = Url::parse(&format!("http://{}", self.0)).unwrap();
        url.set_path(request.url.path());
        url.set_query(request.url.query());
        let mut wire = client
            .request(
                reqwest::Method::from_bytes(request.method.as_bytes()).unwrap(),
                url,
            )
            .header("x-fixture-url", request.url.as_str())
            .body(request.body.clone());
        for (key, value) in &request.headers {
            wire = wire.header(key, value);
        }
        let response = wire.send().await.map_err(|_| FetchError::Transport)?;
        let status = response.status().as_u16();
        let headers = response
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
pub fn safe_client(address: SocketAddr) -> SafeClient {
    SafeClient::new(Arc::new(FixtureDns), Arc::new(ProxyTransport(address)))
}
#[derive(Default)]
pub struct Pause {
    pub committed: Notify,
    pub release: Notify,
}
pub struct RemoteState {
    pub fixture: signed_repo::SignedFixture,
    pub records: BTreeMap<String, Value>,
    pub cids: BTreeMap<String, String>,
    pub creates: usize,
    pub deletes: usize,
    pub pause: Option<(bool, Arc<Pause>)>,
}
#[derive(Clone)]
struct Endpoint {
    oauth: oauth_pds::WireTransport,
    remote: Arc<Mutex<RemoteState>>,
}
fn response(status: u16, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: body.to_string().into_bytes(),
    }
}
async fn endpoint(State(endpoint): State<Endpoint>, request: Request) -> axum::response::Response {
    let url = Url::parse(request.headers()["x-fixture-url"].to_str().unwrap()).unwrap();
    let method = request.method().to_string();
    let headers = request
        .headers()
        .iter()
        .filter(|(key, _)| {
            key.as_str() != "x-fixture-url"
                && key.as_str() != "host"
                && key.as_str() != "content-length"
        })
        .map(|(key, value)| (key.to_string(), value.to_str().unwrap().to_owned()))
        .collect();
    let body = to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    let request = HttpRequest {
        url,
        method,
        headers,
        body,
    };
    let result = handle(endpoint, request).await;
    let mut response = (
        axum::http::StatusCode::from_u16(result.status).unwrap(),
        result.body,
    )
        .into_response();
    for (key, value) in result.headers {
        response.headers_mut().insert(
            axum::http::HeaderName::from_bytes(key.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    response
}
async fn handle(endpoint: Endpoint, request: HttpRequest) -> HttpResponse {
    let path = request.url.path();
    if !matches!(
        path,
        "/xrpc/com.atproto.repo.createRecord"
            | "/xrpc/com.atproto.repo.deleteRecord"
            | "/xrpc/com.atproto.repo.getRecord"
            | "/xrpc/com.atproto.sync.getRepo"
    ) {
        return endpoint.oauth.send(&request, &[]).await.unwrap();
    }
    assert_eq!(
        request.url.origin().ascii_serialization(),
        endpoint.oauth.origin
    );
    if path.ends_with("getRepo") {
        let remote = endpoint.remote.lock().await;
        return HttpResponse {
            status: 200,
            headers: BTreeMap::from([("content-type".into(), "application/vnd.ipld.car".into())]),
            body: remote.fixture.event.blocks.clone(),
        };
    }
    if path.ends_with("getRecord") {
        let query: BTreeMap<_, _> = request.url.query_pairs().into_owned().collect();
        assert_eq!(query["repo"], ALICE);
        let key = format!("{}/{}", query["collection"], query["rkey"]);
        let remote = endpoint.remote.lock().await;
        return match remote.records.get(&key) {
            Some(record) => response(
                200,
                json!({"uri":format!("at://{ALICE}/{key}"),"cid":remote.cids[&key],"value":record}),
            ),
            None => response(400, json!({"error":"RecordNotFound"})),
        };
    }
    // This request is authenticated at the actual OAuth fixture, including token
    // signature, audience/owner, requested repo scope, fresh DPoP jti/ath.
    let authenticated = endpoint.oauth.send(&request, &[]).await.unwrap();
    if authenticated.status != 200 {
        return authenticated;
    }
    let payload: Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(payload["repo"], ALICE);
    let key = format!(
        "{}/{}",
        payload["collection"].as_str().unwrap(),
        payload["rkey"].as_str().unwrap()
    );
    let deleting = path.ends_with("deleteRecord");
    let mut remote = endpoint.remote.lock().await;
    if deleting {
        if payload["swapRecord"].as_str() != remote.cids.get(&key).map(String::as_str) {
            return response(400, json!({"error":"InvalidSwap"}));
        }
        remote.deletes += 1;
    } else {
        assert!(
            !remote.records.contains_key(&key),
            "outbox must reconcile before another create"
        );
        remote.creates += 1;
    }
    let revision = next_revision(&remote.fixture.event.revision);
    let record = (!deleting).then(|| payload["record"].clone());
    remote.fixture =
        signed_repo::signed_mutation(&remote.fixture, &key, record.clone(), 7, &revision).await;
    if let Some(record) = record {
        let cid = remote.fixture.record_cids[0].to_string();
        remote.cids.insert(key.clone(), cid);
        remote.records.insert(key.clone(), record);
    } else {
        remote.records.remove(&key);
        remote.cids.remove(&key);
    }
    let result = if deleting {
        response(200, json!({}))
    } else {
        response(
            200,
            json!({"uri":format!("at://{ALICE}/{key}"),"cid":remote.cids[&key]}),
        )
    };
    let pause = if remote
        .pause
        .as_ref()
        .is_some_and(|(delete, _)| *delete == deleting)
    {
        remote.pause.take().map(|(_, pause)| pause)
    } else {
        None
    };
    drop(remote);
    if let Some(pause) = pause {
        pause.committed.notify_one();
        pause.release.notified().await;
    }
    HttpResponse {
        headers: authenticated.headers,
        ..result
    }
}
fn next_revision(previous: &str) -> String {
    let alphabet = b"234567abcdefghijklmnopqrstuvwxyz";
    let mut bytes = previous.as_bytes().to_vec();
    for byte in bytes.iter_mut().rev() {
        let index = alphabet
            .iter()
            .position(|candidate| candidate == byte)
            .unwrap();
        *byte = alphabet[(index + 1) % alphabet.len()];
        if index + 1 < alphabet.len() {
            break;
        }
    }
    String::from_utf8(bytes).unwrap()
}
pub struct Fixture {
    pub directory: tempfile::TempDir,
    pub path: PathBuf,
    pub oauth: oauth_pds::ControlledPds,
    pub remote: Arc<Mutex<RemoteState>>,
    pub address: SocketAddr,
    pub key: TrustedSigningKey,
    task: JoinHandle<()>,
}
impl Fixture {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("music.sqlite");
        let oauth = oauth_pds::ControlledPds::start().await;
        let fixture = signed_repo::signed_repo(
            vec![("app.fixture.seed/self".into(), json!({"seed":true}))],
            7,
        )
        .await;
        let key = fixture.key.clone();
        let remote = Arc::new(Mutex::new(RemoteState {
            fixture,
            records: BTreeMap::new(),
            cids: BTreeMap::new(),
            creates: 0,
            deletes: 0,
            pause: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(endpoint).with_state(Endpoint {
            oauth: oauth.transport.clone(),
            remote: remote.clone(),
        });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            directory,
            path,
            oauth,
            remote,
            address,
            key,
            task,
        }
    }
    pub async fn snapshot(&self) -> atmusic_atproto::sync::verify::VerifiedSnapshot {
        let safe = safe_client(self.address);
        let source = PdsSnapshotSource::new(
            atmusic_atproto::identity::IdentityResolver::new(safe.clone()),
            safe,
        );
        let snapshot = source.fetch(ALICE).await.unwrap();
        verify_snapshot(
            &snapshot.bytes,
            ALICE,
            &namespace(),
            now(),
            &signed_repo::FixtureResolver(self.key.clone()),
        )
        .await
        .unwrap()
    }
    pub async fn remote_get(&self, uri: &str) -> HttpResponse {
        let components: Vec<_> = uri.strip_prefix("at://").unwrap().split('/').collect();
        let mut url = Url::parse(&self.oauth.origin())
            .unwrap()
            .join("/xrpc/com.atproto.repo.getRecord")
            .unwrap();
        url.query_pairs_mut()
            .append_pair("repo", components[0])
            .append_pair("collection", components[1])
            .append_pair("rkey", components[2]);
        safe_client(self.address)
            .send(&HttpRequest {
                url,
                method: "GET".into(),
                headers: BTreeMap::new(),
                body: vec![],
            })
            .await
            .unwrap()
    }
    pub async fn pause(&self, deleting: bool) -> Arc<Pause> {
        let pause = Arc::new(Pause::default());
        self.remote.lock().await.pause = Some((deleting, pause.clone()));
        pause
    }
    pub async fn sign_in(&self, base: &str) -> Login {
        let client = client();
        let response = client
            .post(format!("{base}/api/v1/auth/start"))
            .header("origin", "https://app.fixture.test")
            .json(&json!({"handle":"alice.test"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let value: Value = response.json().await.unwrap();
        let (code, state, issuer) = self
            .oauth
            .authorize(value["authorizationUrl"].as_str().unwrap())
            .await;
        let response = client
            .get(format!("{base}/api/v1/auth/callback"))
            .query(&[("code", code), ("state", state), ("iss", issuer)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 303);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let response = client
            .get(format!("{base}/api/v1/auth/session"))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let session: Value = response.json().await.unwrap();
        assert_eq!(session["did"], ALICE);
        Login {
            cookie,
            csrf: session["csrfToken"].as_str().unwrap().into(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
pub struct Login {
    pub cookie: String,
    pub csrf: String,
}
impl Login {
    pub fn request(
        &self,
        method: reqwest::Method,
        base: &str,
        path: &str,
    ) -> reqwest::RequestBuilder {
        client()
            .request(method, format!("{base}{path}"))
            .header("cookie", &self.cookie)
            .header("origin", "https://app.fixture.test")
            .header("x-csrf-token", &self.csrf)
    }
    pub async fn create(&self, base: &str, key: &str, input: &Value) -> (u16, Value) {
        let response = self
            .request(reqwest::Method::POST, base, "/api/v1/scrobbles")
            .header("idempotency-key", key)
            .json(input)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
    }
    pub async fn delete(&self, base: &str, uri: &str) -> (u16, Value) {
        let response = self
            .request(
                reqwest::Method::DELETE,
                base,
                &format!("/api/v1/scrobbles/{}", encoded(uri)),
            )
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.bytes().await.unwrap();
        (
            status,
            if body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&body).unwrap()
            },
        )
    }
    pub async fn operation(&self, base: &str, id: &str) -> Value {
        let response = self
            .request(
                reqwest::Method::GET,
                base,
                &format!("/api/v1/operations/{id}"),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }
    pub async fn succeeded(&self, base: &str, id: &str) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let operation = self.operation(base, id).await;
                if operation["state"] == "succeeded" {
                    break operation;
                }
                assert_eq!(operation["state"], "pending");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
    }
}
pub async fn get(base: &str, path: &str) -> (u16, Value) {
    let response = client().get(format!("{base}{path}")).send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}
pub async fn application(
    path: &Path,
    address: SocketAddr,
    key: TrustedSigningKey,
) -> (
    Database,
    AppState,
    Arc<OutboxWorker>,
    Arc<BackfillCoordinator>,
) {
    let db = Database::open(path).await.unwrap();
    let config = Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path.to_path_buf(),
        "https://app.fixture.test",
        &"aa".repeat(32),
        Some(PREFIX),
        None,
    )
    .unwrap()
    .with_namespace_ownership(OwnershipEvidence {
        domain: "fixture.test".into(),
        reference: "controlled host fixture; test only".into(),
    })
    .unwrap();
    let store = TokenStore::new(db.repositories(), config.encryption_key()).unwrap();
    let oauth = Arc::new(OAuthService::new(
        safe_client(address),
        store,
        OAuthConfig::new(
            &config.public_origin,
            vec!["atproto".into(), format!("repo:{PREFIX}.scrobble")],
        )
        .unwrap(),
    ));
    let resolver = Arc::new(signed_repo::FixtureResolver(key));
    let pds = Arc::new(PdsClient::new(oauth.clone(), namespace(), resolver.clone()).unwrap());
    let safe = safe_client(address);
    let backfills = Arc::new(BackfillCoordinator::new(
        db.repositories(),
        namespace(),
        Arc::new(PdsSnapshotSource::new(
            atmusic_atproto::identity::IdentityResolver::new(safe.clone()),
            safe,
        )),
        resolver,
        Arc::new(Frozen),
    ));
    let worker = Arc::new(OutboxWorker::new(db.repositories(), pds));
    let state = AppState::new(config, Some(db.clone()))
        .with_clock(Arc::new(Frozen))
        .with_oauth(oauth)
        .with_outbox(worker.clone());
    (db, state, worker, backfills)
}
pub struct Application {
    pub db: Database,
    pub base: String,
    pub worker: Arc<OutboxWorker>,
    pub backfills: Arc<BackfillCoordinator>,
    task: JoinHandle<()>,
}
impl Application {
    pub async fn start(fixture: &Fixture) -> Self {
        let (db, state, worker, backfills) =
            application(&fixture.path, fixture.address, fixture.key.clone()).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, atmusic_server::router_with_state(state))
                .await
                .unwrap();
        });
        Self {
            db,
            base,
            worker,
            backfills,
            task,
        }
    }
    pub async fn run(&self) {
        for result in self.backfills.run_batch().await.unwrap() {
            result.result.unwrap();
        }
        self.worker.run_due(now()).await.unwrap();
    }
}
impl Drop for Application {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Only this host test binary is started and killed. It uses explicit fixture
/// trust; the production executable still requires a revision-evidence resolver.
pub struct ChildApplication {
    child: std::process::Child,
    pub base: String,
}
impl ChildApplication {
    pub async fn start(fixture: &Fixture, generation: u32) -> Self {
        let ready = fixture.directory.path().join(format!("ready-{generation}"));
        let log = std::fs::File::create(
            fixture
                .directory
                .path()
                .join(format!("child-{generation}.log")),
        )
        .unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fixture_child_server",
                "--ignored",
                "--nocapture",
            ])
            .env("ATMUSIC_JOURNEY_DATABASE", &fixture.path)
            .env("ATMUSIC_JOURNEY_PDS", fixture.address.to_string())
            .env("ATMUSIC_JOURNEY_KEY", &fixture.key.did_key)
            .env("ATMUSIC_JOURNEY_KEY_FROM", &fixture.key.valid_from)
            .env("ATMUSIC_JOURNEY_READY", &ready)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        let mut application = Self {
            child,
            base: String::new(),
        };
        let base = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if let Ok(base) = std::fs::read_to_string(&ready)
                    && base.starts_with("http://")
                {
                    break base;
                }
                assert!(
                    application.child.try_wait().unwrap().is_none(),
                    "fixture child exited before readiness; inspect owned child log"
                );
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        application.base = base;
        application
    }
    pub fn kill(&mut self) {
        self.child.kill().unwrap();
        let status = self.child.wait().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                status.signal(),
                Some(9),
                "only the owned child receives SIGKILL"
            );
        }
    }
}
impl Drop for ChildApplication {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
pub async fn serve_child() {
    let path = PathBuf::from(std::env::var("ATMUSIC_JOURNEY_DATABASE").unwrap());
    let address = std::env::var("ATMUSIC_JOURNEY_PDS")
        .unwrap()
        .parse()
        .unwrap();
    let key = TrustedSigningKey {
        did: ALICE.into(),
        did_key: std::env::var("ATMUSIC_JOURNEY_KEY").unwrap(),
        valid_from: std::env::var("ATMUSIC_JOURNEY_KEY_FROM").unwrap(),
        valid_until: None,
    };
    let (_db, state, worker, backfills) = application(&path, address, key).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let _task = tokio::spawn(async move {
        loop {
            for result in backfills.run_batch().await.unwrap() {
                result.result.unwrap();
            }
            worker.run_due(now()).await.unwrap();
            tokio::select! { _=worker.wait_for_notification()=>{},_=tokio::time::sleep(std::time::Duration::from_millis(25))=>{} }
        }
    });
    std::fs::write(std::env::var("ATMUSIC_JOURNEY_READY").unwrap(), base).unwrap();
    axum::serve(listener, atmusic_server::router_with_state(state))
        .await
        .unwrap();
}
