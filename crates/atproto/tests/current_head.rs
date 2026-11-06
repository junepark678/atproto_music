//! Current-head trust through an actual port-zero HTTP fixture and genuinely signed CARs.
//! Production TLS/DNS policy remains in SafeClient; only the test transport maps locally.
#[path = "support/signed_repo.rs"]
mod signed_repo;
use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{DnsResolver, FetchError, HttpResponse, HttpTransport, SafeClient},
    identity::IdentityResolver,
    sync::{
        apply::{ApplyContext, ApplyError, apply_commit},
        backfill::{BackfillCoordinator, PdsSnapshotSource, ReceiptClock},
        current_head::CurrentHeadResolver,
        verify::{
            SigningKeyProof, SigningKeyResolver, VerificationError, VerifiedMutation,
            content_addressed_car_blocks, verify_commit, verify_snapshot,
        },
    },
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atmusic_storage::{Database, PageBounds, SnapshotOutcome, User};
use atrium_crypto::{
    keypair::{Did as _, P256Keypair},
    multibase::{self, Base},
};
use atrium_repo::blockstore::{AsyncBlockStoreWrite, CarStore};
use axum::{
    extract::{Request, State},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use ipld_core::{cid::Cid, ipld::Ipld};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use signed_repo::{
    ALICE, REVISION, SignedFixture, signed_repo, signed_repo_for, signed_repo_with_bad_signature,
};
use std::{
    collections::{BTreeMap, VecDeque},
    io::Cursor,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;
use url::Url;
const PDS: &str = "https://pds.fixture.example.com";
const RELAY: &str = "current-head-fixture";
fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
fn records() -> Vec<(String, Value)> {
    vec![
        (
            "com.example.atmusic.scrobble/r01".into(),
            json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2025-01-01T12:00:00Z","createdAt":"2025-01-01T12:00:00Z"}),
        ),
        (
            "com.example.atmusic.scrobble/r02".into(),
            json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Bachelorette","listenedAt":"2025-01-02T12:00:00Z","createdAt":"2025-01-02T12:00:00Z"}),
        ),
    ]
}
fn document(fixture: &SignedFixture) -> Value {
    json!({"id":ALICE,"service":[{"id":format!("{ALICE}#atproto_pds"),"type":"AtprotoPersonalDataServer","serviceEndpoint":PDS}],"verificationMethod":[{"id":format!("{ALICE}#atproto"),"controller":ALICE,"type":"Multikey","publicKeyMultibase":fixture.key.did_key.strip_prefix("did:key:").unwrap()}]})
}
fn head(fixture: &SignedFixture) -> Value {
    json!({"cid":fixture.event.commit.to_string(),"rev":fixture.event.revision})
}
struct HttpState {
    document: Value,
    documents: VecDeque<Value>,
    head: Value,
    head_status: u16,
    car: Vec<u8>,
    document_calls: usize,
    head_calls: usize,
    car_calls: usize,
    requests: Vec<String>,
}
struct FixtureDns {
    private_pds: AtomicBool,
}
#[async_trait]
impl DnsResolver for FixtureDns {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError> {
        Ok(
            if host == "pds.fixture.example.com" && self.private_pds.load(Ordering::SeqCst) {
                vec![
                    "93.184.216.34".parse().unwrap(),
                    "127.0.0.1".parse().unwrap(),
                ]
            } else {
                vec!["93.184.216.34".parse().unwrap()]
            },
        )
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
        let mut fixture = Url::parse(&format!("http://{}", self.0)).unwrap();
        fixture.set_path(url.path());
        fixture.set_query(url.query());
        let response = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(fixture)
            .header("x-fixture-url", url.as_str())
            .send()
            .await
            .map_err(|_| FetchError::Transport)?;
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
    State(state): State<Arc<Mutex<HttpState>>>,
    request: Request,
) -> axum::response::Response {
    let url = Url::parse(request.headers()["x-fixture-url"].to_str().unwrap()).unwrap();
    let mut state = state.lock().await;
    state.requests.push(url.to_string());
    if url.host_str() == Some("plc.directory") {
        assert_eq!(url.path(), format!("/{ALICE}"));
        state.document_calls += 1;
        let document = state
            .documents
            .pop_front()
            .unwrap_or_else(|| state.document.clone());
        return axum::Json(document).into_response();
    }
    assert_eq!(url.origin().ascii_serialization(), PDS);
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("did".into(), ALICE.into())]
    );
    match url.path() {
        "/xrpc/com.atproto.sync.getLatestCommit" => {
            state.head_calls += 1;
            (
                axum::http::StatusCode::from_u16(state.head_status).unwrap(),
                axum::Json(state.head.clone()),
            )
                .into_response()
        }
        "/xrpc/com.atproto.sync.getRepo" => {
            state.car_calls += 1;
            (
                [("content-type", "application/vnd.ipld.car")],
                state.car.clone(),
            )
                .into_response()
        }
        _ => panic!("unexpected current-head fixture path"),
    }
}
struct Harness {
    _temp: tempfile::TempDir,
    db: Database,
    state: Arc<Mutex<HttpState>>,
    dns: Arc<FixtureDns>,
    client: SafeClient,
    resolver: Arc<CurrentHeadResolver>,
    task: tokio::task::JoinHandle<()>,
}
impl Harness {
    async fn new(fixture: &SignedFixture) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(temp.path().join("head.sqlite"))
            .await
            .unwrap();
        db.repositories()
            .upsert_user(User::new(ALICE, "2026-01-15T12:00:00Z"))
            .await
            .unwrap();
        let state = Arc::new(Mutex::new(HttpState {
            document: document(fixture),
            documents: VecDeque::new(),
            head: head(fixture),
            head_status: 200,
            car: fixture.event.blocks.clone(),
            document_calls: 0,
            head_calls: 0,
            car_calls: 0,
            requests: vec![],
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .fallback(endpoint)
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let dns = Arc::new(FixtureDns {
            private_pds: AtomicBool::new(false),
        });
        let client = SafeClient::new(dns.clone(), Arc::new(Wire(address)));
        let resolver = Arc::new(CurrentHeadResolver::new(client.clone()));
        Self {
            _temp: temp,
            db,
            state,
            dns,
            client,
            resolver,
            task,
        }
    }
    async fn set(&self, fixture: &SignedFixture) {
        let mut state = self.state.lock().await;
        state.document = document(fixture);
        state.documents.clear();
        state.head = head(fixture);
        state.head_status = 200;
        state.car = fixture.event.blocks.clone();
    }
    async fn apply(
        &self,
        fixture: &SignedFixture,
    ) -> Result<atmusic_atproto::sync::apply::ApplyOutcome, ApplyError> {
        apply_commit(
            &self.db.repositories(),
            &fixture.event,
            ApplyContext {
                relay: RELAY,
                expected_did: ALICE,
                namespace: &namespace(),
                receipt_time: now(),
                resolver: self.resolver.as_ref(),
            },
        )
        .await
    }
    async fn reject(&self, fixture: &SignedFixture, error: VerificationError) {
        let before = sqlx::query_as::<_, (String, String, String)>(
            "SELECT uri,cid,revision FROM scrobbles ORDER BY uri",
        )
        .fetch_all(self.db.reader_pool())
        .await
        .unwrap();
        let checkpoint = self
            .db
            .repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .map(|value| (value.sequence, value.revision));
        assert!(
            matches!(self.apply(fixture).await,Err(ApplyError::Verification(actual)) if actual==error),
            "expected {error:?}"
        );
        let after = sqlx::query_as::<_, (String, String, String)>(
            "SELECT uri,cid,revision FROM scrobbles ORDER BY uri",
        )
        .fetch_all(self.db.reader_pool())
        .await
        .unwrap();
        assert_eq!(before, after);
        assert_eq!(
            self.db
                .repositories()
                .checkpoint(RELAY)
                .await
                .unwrap()
                .map(|value| (value.sequence, value.revision)),
            checkpoint
        );
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn current_head_signed_repo() {
    let fixture = signed_repo(records(), 7).await;
    let h = Harness::new(&fixture).await;
    assert_eq!(
        h.resolver
            .resolve_for_revision(ALICE, REVISION)
            .await
            .unwrap_err(),
        VerificationError::UntrustedIdentity
    );
    let proof = h
        .resolver
        .resolve_for_commit(ALICE, REVISION, fixture.event.commit)
        .await
        .unwrap();
    assert!(
        matches!(proof,SigningKeyProof::CurrentHead(key) if key.did==ALICE && key.revision==REVISION && key.commit==fixture.event.commit && key.did_key==fixture.key.did_key)
    );
    assert!(h.apply(&fixture).await.unwrap().applied);
    let rows =
        h.db.repositories()
            .history(ALICE, PageBounds::default())
            .await
            .unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        let index = fixture
            .event
            .operations
            .iter()
            .position(|op| row.uri == format!("at://{ALICE}/{}", op.path))
            .unwrap();
        assert_eq!(row.cid, fixture.record_cids[index].to_string());
        assert_eq!(row.revision, REVISION);
    }
    assert_eq!(
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        1
    );
    let state = h.state.lock().await;
    assert_eq!(state.document_calls, 4);
    assert_eq!(state.head_calls, 2);
    assert!(
        state
            .requests
            .iter()
            .filter(|url| url.contains("getLatestCommit"))
            .all(|url| url.ends_with(&format!(
                "did={}",
                url::form_urlencoded::byte_serialize(ALICE.as_bytes()).collect::<String>()
            )))
    );
}
struct Frozen;
impl ReceiptClock for Frozen {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
#[tokio::test]
async fn current_head_old_records() {
    let fixture = signed_repo(records(), 7).await;
    let h = Harness::new(&fixture).await;
    let source = Arc::new(PdsSnapshotSource::new(
        IdentityResolver::new(h.client.clone()),
        h.client.clone(),
    ));
    let coordinator = Arc::new(BackfillCoordinator::new(
        h.db.repositories(),
        namespace(),
        source,
        h.resolver.clone(),
        Arc::new(Frozen),
    ));
    coordinator.schedule(ALICE, false).await.unwrap();
    let results = coordinator.run_batch().await.unwrap();
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
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].track, "Bachelorette");
    assert!(
        rows.iter()
            .all(|row| row.listened_at.starts_with("2025-") && row.revision == REVISION)
    );
    let job = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert!(job.backfill_complete);
    let expected_pds = Url::parse(PDS).unwrap().to_string();
    assert_eq!(job.pds.as_deref(), Some(expected_pds.as_str()));
    // Snapshot authentication supplies no relay sequence or catch-up evidence.
    assert!(
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .is_none()
    );
    let state = h.state.lock().await;
    assert_eq!(state.car_calls, 1);
    assert_eq!(state.head_calls, 1);
    assert_eq!(state.document_calls, 3);
}

#[tokio::test]
async fn current_key_rotation() {
    let old = signed_repo(records(), 7).await;
    let h = Harness::new(&old).await;
    h.apply(&old).await.unwrap();
    let mut changed = records();
    changed[0].1["track"] = json!("New key version");
    let mut new = signed_repo_for(ALICE, changed.clone(), 9, "3m4zm2ufr2223").await;
    new.event.sequence = 2;
    new.event.since = Some(REVISION.into());
    h.set(&new).await;
    assert!(h.apply(&new).await.unwrap().applied);
    assert_eq!(
        h.db.repositories()
            .scrobble(&format!("at://{ALICE}/com.example.atmusic.scrobble/r01"))
            .await
            .unwrap()
            .unwrap()
            .track,
        "New key version"
    );
    h.reject(&old, VerificationError::HeadChanged).await;
    // A PDS head assertion cannot make the revoked key valid for the new head.
    let mut revoked = signed_repo_for(ALICE, changed, 7, "3m4zm2ufr2223").await;
    revoked.event.sequence = 3;
    h.state.lock().await.head = head(&revoked);
    h.state.lock().await.document["verificationMethod"] = json!([
        document(&new)["verificationMethod"][0],
        document(&old)["verificationMethod"][0]
    ]);
    h.reject(&revoked, VerificationError::InvalidSignature)
        .await;
    assert_eq!(
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        2
    );
}

#[tokio::test]
async fn head_binding_matrix() {
    let fixture = signed_repo(records(), 7).await;
    let h = Harness::new(&fixture).await;
    let other=signed_repo_for(ALICE,vec![("com.example.atmusic.scrobble/r01".into(),json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Other","listenedAt":"2025-01-01T00:00:00Z","createdAt":"2025-01-01T00:00:00Z"}))],7,REVISION).await;
    for (witness, error) in [
        (
            json!({"rev":"3m4zm2ufr2223","cid":fixture.event.commit.to_string()}),
            VerificationError::HeadChanged,
        ),
        (head(&other), VerificationError::HeadCidMismatch),
        (
            json!({"rev":"invalid","cid":fixture.event.commit.to_string()}),
            VerificationError::InvalidHeadWitness,
        ),
        (
            json!({"rev":REVISION,"cid":"bad"}),
            VerificationError::InvalidHeadWitness,
        ),
        (
            json!({"rev":REVISION}),
            VerificationError::InvalidHeadWitness,
        ),
        (
            json!({"rev":REVISION,"cid":Cid::new_v0(*fixture.event.commit.hash()).unwrap().to_string()}),
            VerificationError::InvalidHeadWitness,
        ),
        (
            json!({"rev":REVISION,"cid":multibase::encode(Base::Base58Btc,fixture.event.commit.to_bytes())}),
            VerificationError::InvalidHeadWitness,
        ),
        (
            json!({"rev":REVISION,"cid":format!("z{}","Z".repeat(200_000))}),
            VerificationError::InvalidHeadWitness,
        ),
    ] {
        h.state.lock().await.head = witness;
        h.reject(&fixture, error).await;
    }
    h.set(&fixture).await;
    h.state.lock().await.document["id"] = json!("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
    h.reject(&fixture, VerificationError::UntrustedIdentity)
        .await;
    assert!(!VerificationError::HeadCidMismatch.is_retryable_head_race());
    assert!(VerificationError::HeadChanged.is_retryable_head_race());
}

#[tokio::test]
async fn head_identity_race() {
    let old = signed_repo(records(), 7).await;
    let new = signed_repo_for(ALICE, records(), 9, "3m4zm2ufr2223").await;
    let h = Harness::new(&old).await;
    {
        let mut state = h.state.lock().await;
        state.documents = VecDeque::from([document(&old), document(&new)]);
        state.document = document(&new);
        state.head = head(&new);
    }
    h.reject(&old, VerificationError::IdentityChanged).await;
    h.set(&new).await;
    let verified = verify_commit(&new.event, ALICE, &namespace(), now(), h.resolver.as_ref())
        .await
        .unwrap();
    assert_eq!(verified.commit(), new.event.commit);
    let mut migrated = document(&new);
    migrated["service"][0]["serviceEndpoint"] = json!("https://new-pds.fixture.example.com");
    h.state.lock().await.documents = VecDeque::from([document(&new), migrated]);
    h.reject(&new, VerificationError::IdentityChanged).await;
    assert!(VerificationError::IdentityChanged.is_retryable_head_race());
}

#[tokio::test]
async fn invalid_trust_matrix() {
    let fixture = signed_repo(records(), 7).await;
    let h = Harness::new(&fixture).await;
    let mut cases = vec![];
    let mut doc = document(&fixture);
    doc["verificationMethod"] = json!([]);
    cases.push(doc);
    for value in ["z", "z1", "z11", "did:key:zQ3unknown", "invalid"] {
        let mut doc = document(&fixture);
        doc["verificationMethod"][0]["publicKeyMultibase"] = json!(value);
        cases.push(doc);
    }
    for field in ["controller", "id", "type"] {
        let mut doc = document(&fixture);
        doc["verificationMethod"][0][field] = json!("wrong");
        cases.push(doc);
    }
    let mut doc = document(&fixture);
    doc["service"][0]["serviceEndpoint"] = json!("http://pds.fixture.example.com");
    cases.push(doc);
    let mut doc = document(&fixture);
    doc["verificationMethod"][0]["publicKeyMultibase"] = json!(format!("z{}", "Z".repeat(200_000)));
    cases.push(doc);
    for doc in cases {
        h.state.lock().await.document = doc;
        h.reject(&fixture, VerificationError::UntrustedIdentity)
            .await;
    }
    assert_eq!(h.state.lock().await.head_calls, 0);
    h.set(&fixture).await;
    h.state.lock().await.document["verificationMethod"][0]["publicKeyMultibase"] =
        json!(multibase::encode(Base::Base58Btc, [0xff; 35]));
    h.reject(&fixture, VerificationError::UntrustedIdentity)
        .await;
    assert!(!VerificationError::UntrustedIdentity.is_retryable_head_race());
}

#[tokio::test]
async fn private_destination() {
    let fixture = signed_repo(records(), 7).await;
    let h = Harness::new(&fixture).await;
    h.dns.private_pds.store(true, Ordering::SeqCst);
    h.reject(&fixture, VerificationError::UntrustedIdentity)
        .await;
    let state = h.state.lock().await;
    assert_eq!(state.document_calls, 1);
    assert_eq!(state.head_calls, 0);
    assert_eq!(state.requests.len(), 1);
}

#[tokio::test]
async fn first_valid_key_order() {
    let fixture = signed_repo(records(), 7).await;
    let other = signed_repo(records(), 9).await;
    let h = Harness::new(&fixture).await;
    let valid = document(&fixture)["verificationMethod"][0].clone();
    let second = document(&other)["verificationMethod"][0].clone();
    h.state.lock().await.document["verificationMethod"] = json!([valid, second]);
    assert_eq!(
        verify_snapshot(
            &fixture.event.blocks,
            ALICE,
            &namespace(),
            now(),
            h.resolver.as_ref()
        )
        .await
        .unwrap()
        .mutations()
        .len(),
        2
    );
    let mut malformed = valid.clone();
    malformed["publicKeyMultibase"] = json!("z1");
    h.state.lock().await.document["verificationMethod"] = json!([malformed, valid]);
    assert_eq!(
        verify_snapshot(
            &fixture.event.blocks,
            ALICE,
            &namespace(),
            now(),
            h.resolver.as_ref()
        )
        .await
        .unwrap()
        .mutations()
        .len(),
        2
    );
    // Selection is by document order, never by whichever signature happens to pass.
    h.state.lock().await.document["verificationMethod"] = json!([second, valid]);
    h.reject(&fixture, VerificationError::InvalidSignature)
        .await;
}

#[tokio::test]
async fn invalid_signature() {
    let fixture = signed_repo_with_bad_signature(records(), 7, true).await;
    let h = Harness::new(&fixture).await;
    h.reject(&fixture, VerificationError::InvalidSignature)
        .await;
    let valid = signed_repo(records(), 7).await;
    let missing = rewrite_commit(
        valid,
        |fields| {
            fields.remove("sig");
        },
        None,
    )
    .await;
    h.set(&missing).await;
    h.reject(&missing, VerificationError::InvalidCar).await;
}

#[tokio::test]
async fn transient_head_unavailable() {
    let fixture = signed_repo(records(), 7).await;
    let h = Harness::new(&fixture).await;
    for status in [429, 500, 503] {
        h.state.lock().await.head_status = status;
        h.reject(&fixture, VerificationError::HeadUnavailable).await;
    }
    assert!(VerificationError::HeadUnavailable.is_retryable_head_race());
    h.state.lock().await.head_status = 404;
    h.reject(&fixture, VerificationError::UntrustedIdentity)
        .await;
    h.set(&fixture).await;
    assert!(h.apply(&fixture).await.unwrap().applied);
}

async fn rewrite_commit(
    mut fixture: SignedFixture,
    mutate: impl FnOnce(&mut BTreeMap<String, Ipld>),
    key: Option<&P256Keypair>,
) -> SignedFixture {
    let mut blocks =
        content_addressed_car_blocks(&fixture.event.blocks, fixture.event.commit).unwrap();
    let old_commit = blocks.remove(&fixture.event.commit.to_string()).unwrap();
    let Ipld::Map(mut commit) = serde_ipld_dagcbor::from_slice::<Ipld>(&old_commit).unwrap() else {
        panic!("commit map")
    };
    mutate(&mut commit);
    if let Some(key) = key {
        commit.remove("sig");
        let signature = key
            .sign(&serde_ipld_dagcbor::to_vec(&Ipld::Map(commit.clone())).unwrap())
            .unwrap();
        commit.insert("sig".into(), Ipld::Bytes(signature));
        fixture.key.did_key = key.did();
    }
    let bytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(commit)).unwrap();
    let root = Cid::new_v1(
        0x71,
        ipld_core::cid::multihash::Multihash::wrap(0x12, &Sha256::digest(&bytes)).unwrap(),
    );
    let mut car_bytes = vec![];
    let mut car = CarStore::create_with_roots(Cursor::new(&mut car_bytes), [root])
        .await
        .unwrap();
    assert_eq!(car.write_block(0x71, 0x12, &bytes).await.unwrap(), root);
    for (cid, block) in blocks {
        assert_eq!(
            car.write_block(0x71, 0x12, &block).await.unwrap(),
            cid.parse::<Cid>().unwrap()
        );
    }
    drop(car);
    fixture.event.commit = root;
    fixture.event.blocks = car_bytes;
    fixture
}
#[tokio::test]
async fn modern_and_legacy_keys() {
    let k256 = signed_repo(records(), 7).await;
    let p256key = P256Keypair::import(&[11; 32]).unwrap();
    let p256 = rewrite_commit(signed_repo(records(), 7).await, |_| {}, Some(&p256key)).await;
    for (fixture, suite) in [
        (&k256, "EcdsaSecp256k1VerificationKey2019"),
        (&p256, "EcdsaSecp256r1VerificationKey2019"),
    ] {
        let h = Harness::new(fixture).await;
        assert_eq!(
            verify_snapshot(
                &fixture.event.blocks,
                ALICE,
                &namespace(),
                now(),
                h.resolver.as_ref()
            )
            .await
            .unwrap()
            .mutations()
            .len(),
            2
        );
        let (_, key) = atrium_crypto::did::parse_did_key(&fixture.key.did_key).unwrap();
        h.state.lock().await.document["verificationMethod"] = json!([{"id":"#atproto","controller":ALICE,"type":suite,"publicKeyMultibase":multibase::encode(Base::Base58Btc,key)}]);
        let verified = verify_snapshot(
            &fixture.event.blocks,
            ALICE,
            &namespace(),
            now(),
            h.resolver.as_ref(),
        )
        .await
        .unwrap();
        assert!(
            verified
                .mutations()
                .iter()
                .all(|mutation| matches!(mutation, VerifiedMutation::Put { .. }))
        );
        h.state.lock().await.document["verificationMethod"][0]["controller"] =
            json!("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
        h.reject(fixture, VerificationError::UntrustedIdentity)
            .await;
    }
}
