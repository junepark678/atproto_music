//! Test-only transport at the protected HTTP boundary. Every confirmed result comes
//! from the production verifier and a genuinely signed repository generated here.
#![allow(dead_code)]
use super::signed_repo::{self, ALICE, FixtureResolver, SignedFixture};
use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{
        DnsResolver, FetchError, HttpRequest, HttpResponse, HttpTransport, SafeClient,
    },
    oauth::{
        service::{OAuthConfig, OAuthService},
        token_store::TokenStore,
    },
    pds::reconcile::{PdsClient, canonical_digest},
    sync::verify::SigningKeyResolver,
};
use atmusic_core::namespace::{Namespace, OwnershipEvidence};
use atmusic_storage::{Database, NewOperation};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use jwt_compact::{AlgorithmExt, UntrustedToken, alg::Es256, jwk::JsonWebKey};
use p256::{
    SecretKey,
    pkcs8::{EncodePrivateKey, LineEnding},
};
use rand::rngs::OsRng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use tokio::sync::{Mutex, Notify};
use url::Url;
pub const PREFIX: &str = "test.fixture.music";
pub const RKEY: &str = "3m4zm2ufr2222";
pub const NOW: &str = "2026-01-15T12:00:00Z";
pub fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .with_timezone(&Utc)
}
pub fn namespace() -> Namespace {
    Namespace::with_ownership(
        PREFIX,
        OwnershipEvidence {
            domain: "fixture.test".into(),
            reference: "controlled fixture domain; test-only".into(),
        },
    )
    .unwrap()
}
pub fn record(track: &str) -> Value {
    json!({"$type":format!("{PREFIX}.scrobble"),"artist":"Björk","track":track,"listenedAt":NOW,"createdAt":NOW,"album":"Homogenic"})
}
pub fn operation() -> NewOperation {
    let value = record("Jóga");
    NewOperation {
        operation_id: "operation-one".into(),
        owner: ALICE.into(),
        kind: "scrobble_create".into(),
        created_at: NOW.into(),
        record_uri: Some(format!("at://{ALICE}/{PREFIX}.scrobble/{RKEY}")),
        collection: format!("{PREFIX}.scrobble"),
        rkey: RKEY.into(),
        payload_json: Some(value.to_string()),
        canonical_digest: Some(canonical_digest(&value)),
    }
}
#[derive(Clone)]
pub enum Reply {
    Status(u16, Option<u64>),
    Permanent(&'static str),
    Timeout,
    CrashAfterCommit,
    PauseAfterCommit(Arc<Pause>),
    AcknowledgeWithoutCommit,
    ChangeBeforeDelete(Value),
}
#[derive(Clone)]
pub enum HeadReply {
    Stable,
    Advance,
    Unavailable,
    CidMismatch,
    Malformed,
}
#[derive(Default)]
pub struct Pause {
    pub committed: Notify,
    pub release: Notify,
}
pub struct State {
    pub replies: VecDeque<Reply>,
    pub calls: usize,
    pub reads: usize,
    pub records: BTreeMap<String, Value>,
    pub payloads: Vec<Value>,
    pub fixture: SignedFixture,
    pub cids: BTreeMap<String, String>,
    pub hide_records: bool,
    pub snapshot_override: Option<Vec<u8>>,
    pub seen_jti: HashSet<String>,
    pub head_faults: VecDeque<(usize, HeadReply)>,
    pub head_requests: usize,
    pub identity_requests: usize,
    pub identity_without_key: bool,
}
pub struct WritePds {
    pub state: Arc<Mutex<State>>,
    pub client: Arc<PdsClient>,
    pub token_store: TokenStore,
    server: Arc<FixtureServer>,
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
struct EndpointTransport {
    state: Arc<Mutex<State>>,
}
struct FixtureServer {
    address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
struct Transport {
    server: Arc<FixtureServer>,
}
#[async_trait]
impl HttpTransport for Transport {
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
        let identity = request.method == "GET"
            && request.url.origin().ascii_serialization() == "https://plc.directory"
            && request.url.path() == format!("/{ALICE}");
        if request.url.origin().ascii_serialization() != "https://pds.fixture.test" && !identity {
            return Err(FetchError::UnsafeDestination);
        }
        let mut url = Url::parse(&format!("http://{}", self.server.address)).unwrap();
        url.set_path(request.url.path());
        url.set_query(request.url.query());
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
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
        match response
            .headers()
            .get("x-fixture-fault")
            .and_then(|value| value.to_str().ok())
        {
            Some("timeout") => return Err(FetchError::Timeout),
            Some("transport") => return Err(FetchError::Transport),
            _ => {}
        }
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
async fn endpoint(
    axum::extract::State(endpoint): axum::extract::State<Arc<EndpointTransport>>,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let original = Url::parse(
        request
            .headers()
            .get("x-fixture-url")
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    let method = request.method().to_string();
    let headers = request
        .headers()
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_str().unwrap().to_owned()))
        .collect();
    let body = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    match endpoint
        .send(
            &HttpRequest {
                url: original,
                method,
                headers,
                body,
            },
            &[],
        )
        .await
    {
        Ok(result) => {
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
        Err(error) => {
            let mut response = axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
            response.headers_mut().insert(
                "x-fixture-fault",
                if matches!(error, FetchError::Timeout) {
                    "timeout"
                } else {
                    "transport"
                }
                .parse()
                .unwrap(),
            );
            response
        }
    }
}
fn response(status: u16, value: Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: BTreeMap::from([
            ("content-type".into(), "application/json".into()),
            ("dpop-nonce".into(), "resource-fixture-nonce".into()),
        ]),
        body: value.to_string().into_bytes(),
    }
}
fn verify_proof(request: &HttpRequest, state: &mut State) {
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "DPoP fixture-access"
    );
    let proof = request.headers.get("dpop").unwrap();
    let parsed = UntrustedToken::<Value>::try_from(proof.as_str()).unwrap();
    assert_eq!(parsed.algorithm(), "ES256");
    assert_eq!(parsed.header().token_type.as_deref(), Some("dpop+jwt"));
    let jwk: JsonWebKey<'_> =
        serde_json::from_value(parsed.header().other_fields["jwk"].clone()).unwrap();
    let key = p256::ecdsa::VerifyingKey::try_from(&jwk).unwrap();
    let verified = Es256.validator::<Value>(&key).validate(&parsed).unwrap();
    let claims: Value = serde_json::to_value(verified.claims()).unwrap();
    assert_eq!(claims["htm"], "POST");
    let mut htu = request.url.clone();
    htu.set_query(None);
    assert_eq!(claims["htu"], htu.as_str());
    assert_eq!(
        claims["ath"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(b"fixture-access"))
    );
    assert!(
        state
            .seen_jti
            .insert(claims["jti"].as_str().unwrap().into())
    );
}
#[async_trait]
impl HttpTransport for EndpointTransport {
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
        let mut state = self.state.lock().await;
        if request.url.origin().ascii_serialization() == "https://plc.directory" {
            assert_eq!(request.method, "GET");
            assert_eq!(request.url.path(), format!("/{ALICE}"));
            assert!(!request.headers.contains_key("authorization"));
            state.identity_requests += 1;
            let methods = if state.identity_without_key {
                json!([])
            } else {
                json!([{"id":format!("{ALICE}#atproto"),"controller":ALICE,"type":"Multikey","publicKeyMultibase":state.fixture.key.did_key.strip_prefix("did:key:").unwrap()}])
            };
            return Ok(response(
                200,
                json!({"id":ALICE,"alsoKnownAs":["at://alice.fixture.test"],"verificationMethod":methods,"service":[{"id":"#atproto_pds","type":"AtprotoPersonalDataServer","serviceEndpoint":"https://pds.fixture.test"}]}),
            ));
        }
        assert_eq!(
            request.url.origin().ascii_serialization(),
            "https://pds.fixture.test"
        );
        match request.url.path() {
            "/xrpc/com.atproto.sync.getLatestCommit" => {
                assert_eq!(request.method, "GET");
                assert!(!request.headers.contains_key("authorization"));
                assert_eq!(
                    request
                        .url
                        .query_pairs()
                        .find(|(name, _)| name == "did")
                        .unwrap()
                        .1,
                    ALICE
                );
                state.head_requests += 1;
                let reply = state
                    .head_faults
                    .front()
                    .and_then(|(after_writes, _)| (state.calls >= *after_writes).then_some(()))
                    .and_then(|()| state.head_faults.pop_front().map(|(_, reply)| reply));
                match reply {
                    Some(HeadReply::Unavailable) => {
                        return Ok(response(503, json!({"error":"Unavailable"})));
                    }
                    Some(HeadReply::Malformed) => {
                        return Ok(response(200, json!({"rev":"invalid","cid":"not-a-cid"})));
                    }
                    Some(HeadReply::CidMismatch) => {
                        return Ok(response(
                            200,
                            json!({"rev":state.fixture.event.revision,"cid":state.fixture.record_cids[0].to_string()}),
                        ));
                    }
                    Some(HeadReply::Advance) => {
                        let revision = successor_revision(&state.fixture.event.revision);
                        let path = "app.fixture.seed/self";
                        let value = json!({"seed":true,"concurrentChange":state.head_requests});
                        state.fixture = signed_repo::signed_mutation(
                            &state.fixture,
                            path,
                            Some(value.clone()),
                            7,
                            &revision,
                        )
                        .await;
                        let cid = state.fixture.record_cids[0].to_string();
                        state.cids.insert(path.into(), cid);
                        state.records.insert(path.into(), value);
                    }
                    Some(HeadReply::Stable) | None => {}
                }
                Ok(response(
                    200,
                    json!({"rev":state.fixture.event.revision,"cid":state.fixture.event.commit.to_string()}),
                ))
            }
            "/xrpc/com.atproto.repo.getRecord" => {
                state.reads += 1;
                let query: BTreeMap<_, _> = request
                    .url
                    .query_pairs()
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                assert_eq!(query["repo"], ALICE);
                let path = format!("{}/{}", query["collection"], query["rkey"]);
                if let Some(record) = state.records.get(&path).filter(|_| !state.hide_records) {
                    Ok(response(
                        200,
                        json!({"uri":format!("at://{ALICE}/{path}"),"cid":state.cids[&path],"value":record}),
                    ))
                } else {
                    Ok(response(400, json!({"error":"RecordNotFound"})))
                }
            }
            "/xrpc/com.atproto.sync.getRepo" => {
                state.reads += 1;
                Ok(HttpResponse {
                    status: 200,
                    headers: BTreeMap::from([(
                        "content-type".into(),
                        "application/vnd.ipld.car".into(),
                    )]),
                    body: state
                        .snapshot_override
                        .clone()
                        .unwrap_or_else(|| state.fixture.event.blocks.clone()),
                })
            }
            "/xrpc/com.atproto.repo.createRecord" | "/xrpc/com.atproto.repo.deleteRecord" => {
                let deleting = request.url.path().ends_with("deleteRecord");
                verify_proof(request, &mut state);
                state.calls += 1;
                let payload: Value = serde_json::from_slice(&request.body).unwrap();
                assert_eq!(payload["repo"], ALICE);
                state.payloads.push(payload.clone());
                let reply = state
                    .replies
                    .pop_front()
                    .unwrap_or(Reply::Status(200, None));
                match reply {
                    Reply::Timeout => return Err(FetchError::Timeout),
                    Reply::Permanent(code) => return Ok(response(400, json!({"error":code}))),
                    Reply::Status(status, retry) if status != 200 => {
                        let mut response = response(status, json!({"error":"fixture_failure"}));
                        if let Some(seconds) = retry {
                            response
                                .headers
                                .insert("retry-after".into(), seconds.to_string());
                        }
                        return Ok(response);
                    }
                    _ => {}
                }
                let path = format!(
                    "{}/{}",
                    payload["collection"].as_str().unwrap(),
                    payload["rkey"].as_str().unwrap()
                );
                if let Reply::ChangeBeforeDelete(record) = &reply {
                    assert!(deleting);
                    let revision = successor_revision(&state.fixture.event.revision);
                    state.fixture = signed_repo::signed_mutation(
                        &state.fixture,
                        &path,
                        Some(record.clone()),
                        7,
                        &revision,
                    )
                    .await;
                    let cid = state.fixture.record_cids[0].to_string();
                    state.cids.insert(path.clone(), cid);
                    state.records.insert(path.clone(), record.clone());
                }
                if deleting
                    && payload["swapRecord"].as_str() != state.cids.get(&path).map(String::as_str)
                {
                    return Ok(response(400, json!({"error":"InvalidSwap"})));
                }
                if matches!(reply, Reply::AcknowledgeWithoutCommit) {
                    return Ok(response(200, json!({})));
                }
                if !deleting {
                    assert!(
                        !state.records.contains_key(&path),
                        "create must never overwrite an existing record"
                    );
                }
                let revision = successor_revision(&state.fixture.event.revision);
                let value = if deleting {
                    None
                } else {
                    Some(payload["record"].clone())
                };
                state.fixture = signed_repo::signed_mutation(
                    &state.fixture,
                    &path,
                    value.clone(),
                    7,
                    &revision,
                )
                .await;
                if let Some(record) = value {
                    state.records.insert(path.clone(), record);
                    let cid = state.fixture.record_cids[0].to_string();
                    state.cids.insert(path.clone(), cid);
                } else {
                    state.records.remove(&path);
                    state.cids.remove(&path);
                }
                let result = if deleting {
                    response(200, json!({}))
                } else {
                    response(
                        200,
                        json!({"uri":format!("at://{ALICE}/{path}"),"cid":state.cids[&path]}),
                    )
                };
                if matches!(reply, Reply::CrashAfterCommit) {
                    return Err(FetchError::Transport);
                }
                if let Reply::PauseAfterCommit(pause) = reply {
                    drop(state);
                    pause.committed.notify_one();
                    pause.release.notified().await;
                }
                Ok(result)
            }
            _ => panic!("unexpected fixture endpoint {}", request.url.path()),
        }
    }
}
impl WritePds {
    pub async fn new(db: &Database, replies: Vec<Reply>, initial: Option<Value>) -> Self {
        let mut records = BTreeMap::from([("app.fixture.seed/self".into(), json!({"seed":true}))]);
        if let Some(record) = initial {
            records.insert(format!("{PREFIX}.scrobble/{RKEY}"), record);
        }
        let fixture = signed_repo::signed_repo(
            records
                .iter()
                .map(|(p, v)| (p.clone(), v.clone()))
                .collect(),
            7,
        )
        .await;
        let cids = fixture
            .event
            .operations
            .iter()
            .zip(&fixture.record_cids)
            .map(|(op, cid)| (op.path.clone(), cid.to_string()))
            .collect();
        let resolver = Arc::new(FixtureResolver(fixture.key.clone()));
        let state = Arc::new(Mutex::new(State {
            replies: replies.into(),
            calls: 0,
            reads: 0,
            records,
            payloads: vec![],
            fixture,
            cids,
            hide_records: false,
            snapshot_override: None,
            seen_jti: HashSet::new(),
            head_faults: VecDeque::new(),
            head_requests: 0,
            identity_requests: 0,
            identity_without_key: false,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router =
            axum::Router::new()
                .fallback(endpoint)
                .with_state(Arc::new(EndpointTransport {
                    state: state.clone(),
                }));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let server = Arc::new(FixtureServer { address, task });
        let safe = SafeClient::new(
            Arc::new(FixtureDns),
            Arc::new(Transport {
                server: server.clone(),
            }),
        );
        let token_store = TokenStore::new(db.repositories(), &[45; 32]).unwrap();
        let secret = SecretKey::random(&mut OsRng);
        let pem = secret.to_pkcs8_pem(LineEnding::LF).unwrap();
        token_store.put_oauth_tokens(ALICE,&json!({"did":ALICE,"issuer":"https://issuer.fixture.test","pds":"https://pds.fixture.test","token_endpoint":"https://issuer.fixture.test/token","revocation_endpoint":null,"scopes":["atproto"],"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_at":now().timestamp()+86400,"dpop_private_pem":pem.as_str(),"authorization_nonce":null,"resource_nonce":null}),now().timestamp()).await.unwrap();
        let config = OAuthConfig::new(
            &Url::parse("https://app.fixture.test").unwrap(),
            vec!["atproto".into()],
        )
        .unwrap();
        let oauth = Arc::new(OAuthService::new(safe, token_store.clone(), config));
        let client = Arc::new(PdsClient::new(oauth, namespace(), resolver).unwrap());
        Self {
            state,
            client,
            token_store,
            server,
        }
    }
    pub async fn seed_records(&self, records: Vec<(String, Value)>) {
        let mut state = self.state.lock().await;
        let revision = successor_revision(&state.fixture.event.revision);
        let fixture = signed_repo::signed_repo_for(ALICE, records.clone(), 7, &revision).await;
        state.cids = fixture
            .event
            .operations
            .iter()
            .zip(&fixture.record_cids)
            .map(|(op, cid)| (op.path.clone(), cid.to_string()))
            .collect();
        state.records = records.into_iter().collect();
        state.fixture = fixture;
    }
    pub async fn rebuild_for(&self, db: &Database) -> Arc<PdsClient> {
        let state = self.state.lock().await;
        let resolver = Arc::new(FixtureResolver(state.fixture.key.clone()));
        drop(state);
        self.rebuild_with_resolver(db, resolver).await
    }
    pub fn safe_client(&self) -> SafeClient {
        SafeClient::new(
            Arc::new(FixtureDns),
            Arc::new(Transport {
                server: self.server.clone(),
            }),
        )
    }
    pub async fn rebuild_with_resolver(
        &self,
        db: &Database,
        resolver: Arc<dyn SigningKeyResolver>,
    ) -> Arc<PdsClient> {
        let safe = self.safe_client();
        let store = TokenStore::new(db.repositories(), &[45; 32]).unwrap();
        let config = OAuthConfig::new(
            &Url::parse("https://app.fixture.test").unwrap(),
            vec!["atproto".into()],
        )
        .unwrap();
        Arc::new(
            PdsClient::new(
                Arc::new(OAuthService::new(safe, store, config)),
                namespace(),
                resolver,
            )
            .unwrap(),
        )
    }
}

fn successor_revision(previous: &str) -> String {
    let alphabet = b"234567abcdefghijklmnopqrstuvwxyz";
    let mut bytes = previous.as_bytes().to_vec();
    for ch in bytes.iter_mut().rev() {
        let index = alphabet
            .iter()
            .position(|candidate| candidate == ch)
            .unwrap();
        *ch = alphabet[(index + 1) % alphabet.len()];
        if index + 1 < alphabet.len() {
            break;
        }
    }
    String::from_utf8(bytes).unwrap()
}
