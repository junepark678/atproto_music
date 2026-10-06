use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{
        DnsResolver, FetchError, HttpResponse, HttpTransport, MAX_METADATA_BYTES, SafeClient,
    },
    identity::{Clock, IdentityError, IdentityResolver, did_document_url, normalize_handle},
    oauth::discovery::{DiscoveryError, OAuthDiscovery},
};
use serde_json::{Value, json};
use url::Url;

#[path = "support/signed_repo.rs"]
mod signed_repo;

const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const PUBLIC: &str = "93.184.216.34";

#[derive(Default)]
struct FakeDns {
    txt: Mutex<HashMap<String, Vec<String>>>,
    ips: Mutex<HashMap<String, VecDeque<Vec<IpAddr>>>>,
}

#[async_trait]
impl DnsResolver for FakeDns {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError> {
        let mut ips = self.ips.lock().unwrap();
        if let Some(sequence) = ips.get_mut(host) {
            if sequence.len() > 1 {
                return Ok(sequence.pop_front().unwrap());
            }
            return Ok(sequence.front().unwrap().clone());
        }
        Ok(vec![PUBLIC.parse().unwrap()])
    }

    async fn txt(&self, name: &str) -> Result<Vec<String>, FetchError> {
        Ok(self
            .txt
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct FakeTransport {
    routes: Mutex<HashMap<String, HttpResponse>>,
    calls: Mutex<Vec<(String, Vec<SocketAddr>)>>,
    stalled: Mutex<bool>,
}

#[async_trait]
impl HttpTransport for FakeTransport {
    async fn fetch(&self, url: &Url, addresses: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        self.calls
            .lock()
            .unwrap()
            .push((url.to_string(), addresses.to_vec()));
        let stalled = *self.stalled.lock().unwrap();
        if stalled {
            return std::future::pending().await;
        }
        self.routes
            .lock()
            .unwrap()
            .get(url.as_str())
            .cloned()
            .ok_or(FetchError::Transport)
    }
}

struct Fixture {
    dns: Arc<FakeDns>,
    http: Arc<FakeTransport>,
    client: SafeClient,
}

impl Fixture {
    fn new() -> Self {
        let dns = Arc::new(FakeDns::default());
        let http = Arc::new(FakeTransport::default());
        let client = SafeClient::new(dns.clone(), http.clone());
        Self { dns, http, client }
    }

    fn route(&self, url: &str, status: u16, headers: &[(&str, &str)], body: Vec<u8>) {
        self.http.routes.lock().unwrap().insert(
            url.to_owned(),
            HttpResponse {
                status,
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                body,
            },
        );
    }

    fn json(&self, url: &str, body: Value) {
        self.route(
            url,
            200,
            &[("content-type", "application/json; charset=utf-8")],
            serde_json::to_vec(&body).unwrap(),
        );
    }

    fn account(&self, did: &str, handle: &str, pds: &str) {
        self.dns
            .txt
            .lock()
            .unwrap()
            .insert(format!("_atproto.{handle}"), vec![format!("did={did}")]);
        self.document(did, handle, pds);
    }

    fn document(&self, did: &str, handle: &str, pds: &str) {
        self.json(did_document_url(did).unwrap().as_str(), json!({
            "id": did, "alsoKnownAs": [format!("at://{handle}")],
            "service": [{"id": "#atproto_pds", "type": "AtprotoPersonalDataServer", "serviceEndpoint": pds}]
        }));
    }

    fn metadata(&self, metadata: Value) {
        self.json("https://pds.example/.well-known/oauth-protected-resource", json!({
            "resource": "https://pds.example", "authorization_servers": ["https://issuer.example"]
        }));
        self.json(
            "https://issuer.example/.well-known/oauth-authorization-server",
            metadata,
        );
    }

    fn calls(&self) -> usize {
        self.http.calls.lock().unwrap().len()
    }
}

#[derive(Default)]
struct FakeClock(AtomicU64);

impl FakeClock {
    fn set(&self, seconds: u64) {
        self.0.store(seconds, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        Duration::from_secs(self.0.load(Ordering::SeqCst))
    }
}

fn oauth_metadata() -> Value {
    json!({
        "issuer": "https://issuer.example",
        "authorization_endpoint": "https://issuer.example/authorize",
        "token_endpoint": "https://issuer.example/token",
        "pushed_authorization_request_endpoint": "https://issuer.example/par",
        "revocation_endpoint": "https://issuer.example/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
        "token_endpoint_auth_signing_alg_values_supported": ["ES256"],
        "scopes_supported": ["atproto"],
        "dpop_signing_alg_values_supported": ["ES256"],
        "authorization_response_iss_parameter_supported": true,
        "require_pushed_authorization_requests": true,
        "client_id_metadata_document_supported": true
    })
}

fn client_urls() -> (Url, Url) {
    (
        Url::parse("https://music.example/oauth/client-metadata.json").unwrap(),
        Url::parse("https://music.example/api/v1/auth/callback").unwrap(),
    )
}

#[tokio::test]
async fn round_trip() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    let resolved = IdentityResolver::new(fixture.client.clone())
        .resolve("Alice.TEST")
        .await
        .unwrap();
    assert_eq!(resolved.did, ALICE);
    assert_eq!(resolved.handle.as_deref(), Some("alice.test"));
    assert!(resolved.verified);
    assert_eq!(resolved.pds.as_str(), "https://pds.example/");
    assert_eq!(fixture.calls(), 1);
    assert_eq!(
        fixture.http.calls.lock().unwrap()[0].1,
        vec![format!("{PUBLIC}:443").parse().unwrap()]
    );
}

#[tokio::test]
async fn spoofed_handle() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    fixture.document(ALICE, "bob.test", "https://pds.example");
    let resolver = IdentityResolver::new(fixture.client.clone());
    assert_eq!(
        resolver.resolve("alice.test").await,
        Err(IdentityError::HandleMismatch)
    );
    // Mismatches do not enter the successful cache; a valid correction works.
    fixture.document(ALICE, "alice.test", "https://pds.example");
    assert_eq!(resolver.resolve("alice.test").await.unwrap().did, ALICE);
    assert_eq!(fixture.calls(), 2);
}

#[tokio::test]
async fn cache_expiry() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://old.example");
    let clock = Arc::new(FakeClock::default());
    let resolver = IdentityResolver::with_clock(fixture.client.clone(), clock.clone());
    let original = resolver.resolve("alice.test").await.unwrap();
    fixture.account(BOB, "alice.test", "https://new.example");
    clock.set(299);
    assert_eq!(resolver.resolve("alice.test").await.unwrap(), original);
    assert_eq!(fixture.calls(), 1);
    clock.set(301);
    let refreshed = resolver.resolve("alice.test").await.unwrap();
    assert_eq!(refreshed.did, BOB);
    assert_eq!(refreshed.pds.as_str(), "https://new.example/");
    assert_eq!(fixture.calls(), 2);
}

#[tokio::test]
async fn https_fallback_and_did_web() {
    let fixture = Fixture::new();
    let did = "did:web:alice.test";
    fixture.route(
        "https://alice.test/.well-known/atproto-did",
        200,
        &[("content-type", "text/plain")],
        format!("{did}\n").into_bytes(),
    );
    fixture.document(did, "alice.test", "https://pds.example");
    let resolver = IdentityResolver::new(fixture.client.clone());
    assert!(resolver.resolve("alice.test").await.unwrap().verified);
    assert_eq!(fixture.calls(), 2);
    fixture.json(
        "https://alice.test/.well-known/did.json",
        json!({"id": ALICE}),
    );
    assert!(matches!(
        resolver.document(did).await,
        Err(IdentityError::DidMismatch)
    ));
}

#[tokio::test]
async fn first_alias_and_ambiguous_dns() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    fixture.json(did_document_url(ALICE).unwrap().as_str(), json!({
        "id": ALICE, "alsoKnownAs": ["https://ignored.example", "at://bob.test", "at://alice.test"],
        "service": [{"id": format!("{ALICE}#atproto_pds"), "type": "AtprotoPersonalDataServer", "serviceEndpoint": "https://pds.example"}]
    }));
    let resolver = IdentityResolver::new(fixture.client.clone());
    assert_eq!(
        resolver.resolve("alice.test").await,
        Err(IdentityError::HandleMismatch)
    );
    fixture.dns.txt.lock().unwrap().insert(
        "_atproto.alice.test".into(),
        vec![format!("did={ALICE}"), format!("did={BOB}")],
    );
    assert_eq!(
        resolver.resolve("alice.test").await,
        Err(IdentityError::AmbiguousHandle)
    );
    assert_eq!(fixture.calls(), 1);
    let did_result = resolver.resolve(ALICE).await.unwrap();
    assert_eq!(did_result.handle, None);
    assert!(!did_result.verified);
}

#[tokio::test]
async fn ssrf_destinations() {
    let fixture = Fixture::new();
    for destination in [
        "https://127.0.0.1/",
        "https://10.1.2.3/",
        "https://169.254.169.254/",
        "https://[::1]/",
        "https://[::ffff:10.0.0.1]/",
        "https://[fc00::1]/",
        "https://[fe80::1]/",
        "http://public.example/",
        "https://user:pass@public.example/",
    ] {
        assert_eq!(
            fixture
                .client
                .get(&Url::parse(destination).unwrap())
                .await
                .unwrap_err(),
            FetchError::UnsafeDestination,
            "{destination}"
        );
    }
    fixture.dns.ips.lock().unwrap().insert(
        "mixed.example".into(),
        VecDeque::from([vec![
            PUBLIC.parse().unwrap(),
            "192.168.1.1".parse().unwrap(),
        ]]),
    );
    assert_eq!(
        fixture
            .client
            .get(&Url::parse("https://mixed.example/").unwrap())
            .await
            .unwrap_err(),
        FetchError::UnsafeDestination
    );
    assert_eq!(
        fixture.calls(),
        0,
        "no transport may receive any denied destination"
    );
}

#[tokio::test]
async fn redirect_rebinding() {
    let fixture = Fixture::new();
    fixture.route(
        "https://public.example/",
        302,
        &[("location", "https://127.0.0.1/private")],
        vec![],
    );
    assert_eq!(
        fixture
            .client
            .get(&Url::parse("https://public.example/").unwrap())
            .await
            .unwrap_err(),
        FetchError::UnsafeDestination
    );
    assert_eq!(fixture.calls(), 1);
    fixture.route(
        "https://rebind.example/",
        302,
        &[("location", "/next")],
        vec![],
    );
    fixture.dns.ips.lock().unwrap().insert(
        "rebind.example".into(),
        VecDeque::from([
            vec![PUBLIC.parse().unwrap()],
            vec!["10.0.0.1".parse().unwrap()],
        ]),
    );
    assert_eq!(
        fixture
            .client
            .get(&Url::parse("https://rebind.example/").unwrap())
            .await
            .unwrap_err(),
        FetchError::UnsafeDestination
    );
    assert_eq!(fixture.calls(), 2);
    assert!(
        fixture
            .http
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, addresses)| addresses
                .iter()
                .all(|address| address.ip().to_string() == PUBLIC))
    );
}

#[tokio::test]
async fn fetch_bounds() {
    tokio::time::pause();
    let fixture = Fixture::new();
    for hop in 0..4 {
        fixture.route(
            &format!("https://public.example/{hop}"),
            302,
            &[("location", &format!("/{next}", next = hop + 1))],
            vec![],
        );
    }
    assert_eq!(
        fixture
            .client
            .get(&Url::parse("https://public.example/0").unwrap())
            .await
            .unwrap_err(),
        FetchError::TooManyRedirects
    );
    assert_eq!(fixture.calls(), 4);
    fixture.route(
        "https://public.example/large",
        200,
        &[],
        vec![b' '; MAX_METADATA_BYTES + 1],
    );
    assert_eq!(
        fixture
            .client
            .get(&Url::parse("https://public.example/large").unwrap())
            .await
            .unwrap_err(),
        FetchError::BodyTooLarge
    );
    *fixture.http.stalled.lock().unwrap() = true;
    let before = tokio::time::Instant::now();
    assert_eq!(
        fixture
            .client
            .get(&Url::parse("https://public.example/stall").unwrap())
            .await
            .unwrap_err(),
        FetchError::Timeout
    );
    let elapsed = tokio::time::Instant::now() - before;
    assert!((Duration::from_secs(10)..=Duration::from_millis(10_010)).contains(&elapsed));
}

#[tokio::test]
async fn valid_chain() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    fixture.metadata(oauth_metadata());
    let identity = IdentityResolver::new(fixture.client.clone())
        .resolve("alice.test")
        .await
        .unwrap();
    let (client_id, callback) = client_urls();
    let result = OAuthDiscovery::new(fixture.client.clone())
        .discover(&identity, &client_id, &callback)
        .await
        .unwrap();
    assert_eq!(result.did, ALICE);
    assert_eq!(result.pds.as_str(), "https://pds.example/");
    assert_eq!(result.issuer.as_str(), "https://issuer.example/");
    assert_eq!(result.par_endpoint.as_str(), "https://issuer.example/par");
    assert_eq!(fixture.calls(), 3);
}

#[tokio::test]
async fn issuer_mismatch() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    let mut metadata = oauth_metadata();
    metadata["issuer"] = json!("https://other.example");
    fixture.metadata(metadata);
    let identity = IdentityResolver::new(fixture.client.clone())
        .resolve("alice.test")
        .await
        .unwrap();
    let (client_id, callback) = client_urls();
    assert!(matches!(
        OAuthDiscovery::new(fixture.client.clone())
            .discover(&identity, &client_id, &callback)
            .await,
        Err(DiscoveryError::IssuerMismatch)
    ));
    assert_eq!(fixture.calls(), 3);
}

#[tokio::test]
async fn unsupported_server() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    let identity = IdentityResolver::new(fixture.client.clone())
        .resolve("alice.test")
        .await
        .unwrap();
    let (client_id, callback) = client_urls();
    for field in [
        "pushed_authorization_request_endpoint",
        "code_challenge_methods_supported",
        "dpop_signing_alg_values_supported",
        "client_id_metadata_document_supported",
    ] {
        let mut metadata = oauth_metadata();
        metadata.as_object_mut().unwrap().remove(field);
        fixture.metadata(metadata);
        assert!(
            matches!(
                OAuthDiscovery::new(fixture.client.clone())
                    .discover(&identity, &client_id, &callback)
                    .await,
                Err(DiscoveryError::UnsupportedOAuthServer)
            ),
            "{field}"
        );
    }
    assert_eq!(
        fixture.calls(),
        9,
        "DID plus two metadata GETs per check; no PAR or password call"
    );
}

#[tokio::test]
async fn callback_origin_and_metadata_wire_contract() {
    let fixture = Fixture::new();
    fixture.account(ALICE, "alice.test", "https://pds.example");
    let identity = IdentityResolver::new(fixture.client.clone())
        .resolve("alice.test")
        .await
        .unwrap();
    let (client_id, _) = client_urls();
    assert!(matches!(
        OAuthDiscovery::new(fixture.client.clone())
            .discover(
                &identity,
                &client_id,
                &Url::parse("https://attacker.example/callback").unwrap()
            )
            .await,
        Err(DiscoveryError::InvalidClientOrigin)
    ));
    assert_eq!(fixture.calls(), 1);
    let metadata_url =
        Url::parse("https://pds.example/.well-known/oauth-protected-resource").unwrap();
    fixture.route(
        metadata_url.as_str(),
        302,
        &[("location", "https://issuer.example/metadata")],
        vec![],
    );
    assert_eq!(
        fixture.client.metadata(&metadata_url).await.unwrap_err(),
        FetchError::RedirectForbidden
    );
    fixture.route(
        metadata_url.as_str(),
        201,
        &[("content-type", "application/json")],
        b"{}".to_vec(),
    );
    assert_eq!(
        fixture.client.metadata(&metadata_url).await.unwrap_err(),
        FetchError::HttpStatus(201)
    );
    fixture.route(
        metadata_url.as_str(),
        200,
        &[("content-type", "text/html")],
        b"{}".to_vec(),
    );
    assert_eq!(
        fixture.client.metadata(&metadata_url).await.unwrap_err(),
        FetchError::ContentType
    );
}

#[test]
fn handle_syntax() {
    for handle in [
        "127.0.0.1",
        "alice",
        "a..test",
        "-a.test",
        "a-.test",
        "alice.test/",
        " alice.test",
        "é.test",
    ] {
        assert!(normalize_handle(handle).is_err(), "{handle}");
    }
    assert_eq!(normalize_handle("Alice.Example").unwrap(), "alice.example");
    assert!(did_document_url("did:web:example.com:path").is_err());
    assert!(did_document_url("did:web:localhost%3A443").is_err());
    // Strict response header names are normalized by the production transport.
    let _: BTreeMap<String, String> = BTreeMap::new();
}

#[tokio::test]
async fn repository_download_bounds() {
    use atmusic_atproto::{
        http::safe_client::MAX_REPOSITORY_BYTES, sync::verify::verify_snapshot_record,
    };
    use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
    let repository = signed_repo::signed_repo(vec![
        ("com.example.atmusic.scrobble/r01".into(), json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"})),
        ("com.example.other.blob/r02".into(), json!({"$type":"com.example.other.blob","payload":"x".repeat(MAX_METADATA_BYTES + 1)})),
    ], 7).await;
    assert!(repository.event.blocks.len() > MAX_METADATA_BYTES);
    assert!(repository.event.blocks.len() < MAX_REPOSITORY_BYTES);
    let fixture = Fixture::new();
    let url = Url::parse("https://pds.example/xrpc/com.atproto.sync.getRepo").unwrap();
    fixture.route(
        url.as_str(),
        200,
        &[("content-type", "application/vnd.ipld.car")],
        repository.event.blocks.clone(),
    );
    let fetched = fixture.client.repository(&url).await.unwrap();
    assert_eq!(fetched.body, repository.event.blocks);
    let verified = verify_snapshot_record(
        &fetched.body,
        ALICE,
        "com.example.atmusic.scrobble/r01",
        Some(repository.record_cids[0]),
        &Namespace::new(FIXTURE_PREFIX).unwrap(),
        chrono::DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc),
        &signed_repo::FixtureResolver(repository.key),
    )
    .await
    .unwrap();
    assert_eq!(
        verified.mutations().len(),
        1,
        "larger CAR retains signature/CID/MST verification"
    );
    assert_eq!(
        fixture.client.metadata(&url).await.unwrap_err(),
        FetchError::BodyTooLarge
    );
    assert_eq!(
        fixture.client.get(&url).await.unwrap_err(),
        FetchError::BodyTooLarge
    );
    fixture.route(url.as_str(), 200, &[], vec![0; MAX_REPOSITORY_BYTES + 1]);
    assert_eq!(
        fixture.client.repository(&url).await.unwrap_err(),
        FetchError::BodyTooLarge
    );
    let before = fixture.calls();
    assert_eq!(
        fixture
            .client
            .repository(&Url::parse("https://127.0.0.1/repo").unwrap())
            .await
            .unwrap_err(),
        FetchError::UnsafeDestination
    );
    assert_eq!(
        fixture.calls(),
        before,
        "repository downloads also reject private destinations before transport"
    );
}
