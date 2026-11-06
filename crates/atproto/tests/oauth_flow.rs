mod support {
    pub mod oauth_pds;
}
use atmusic_atproto::oauth::{
    service::{
        CallbackQuery, Entropy, OAuthConfig, OAuthError, OAuthService, PendingAuthorization,
    },
    token_store::TokenStore,
};
use atmusic_storage::Database;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
use support::oauth_pds::{ALICE, BOB, ControlledPds, NOW, NonceMode};
use url::Url;

struct CounterEntropy(AtomicU8);
impl Entropy for CounterEntropy {
    fn bytes(&self) -> [u8; 32] {
        [self.0.fetch_add(1, Ordering::SeqCst); 32]
    }
}
struct Harness {
    fixture: ControlledPds,
    service: OAuthService,
    database: Database,
    _directory: tempfile::TempDir,
}
impl Harness {
    async fn new() -> Self {
        let fixture = ControlledPds::start().await;
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("music.sqlite"))
            .await
            .unwrap();
        let store = TokenStore::new(database.repositories(), &[0x41; 32]).unwrap();
        let config = OAuthConfig::new(
            &Url::parse("https://music.example").unwrap(),
            vec![
                "atproto".into(),
                "repo:com.example.atmusic.scrobble".into(),
                "repo:com.example.atmusic.follow".into(),
            ],
        )
        .unwrap();
        let service = OAuthService::new(fixture.client(), store, config)
            .with_entropy(Arc::new(CounterEntropy(AtomicU8::new(1))));
        Self {
            fixture,
            service,
            database,
            _directory: directory,
        }
    }
    async fn query(&self) -> CallbackQuery {
        let url = self.service.start("alice.test", NOW).await.unwrap();
        let (code, state, iss) = self.fixture.authorize(&url).await;
        CallbackQuery { code, state, iss }
    }
    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(self.database.reader_pool())
            .await
            .unwrap()
    }
}
#[tokio::test]
async fn par_pkce() {
    let harness = Harness::new().await;
    let url = harness.service.start("alice.test", NOW).await.unwrap();
    let (state, challenge, redirect, key) = {
        let fixture = harness.fixture.state.lock().unwrap();
        let par = &fixture.pars[0];
        assert_eq!(par.fields["code_challenge_method"], "S256");
        (
            par.fields["state"].clone(),
            par.fields["code_challenge"].clone(),
            par.fields["redirect_uri"].clone(),
            par.key.clone(),
        )
    };
    assert_eq!(
        challenge,
        URL_SAFE_NO_PAD.encode(Sha256::digest(URL_SAFE_NO_PAD.encode([1u8; 32]).as_bytes()))
    );
    assert_eq!(redirect, "https://music.example/api/v1/auth/callback");
    assert_eq!(key["kty"], "EC");
    assert_eq!(key["crv"], "P-256");
    assert!(key.get("d").is_none());
    assert!(!url.contains("verifier"));
    assert!(!url.contains("PRIVATE"));
    assert!(!url.contains(&state));
    assert_eq!(harness.count("oauth_states").await, 1);
    let pending = harness
        .service
        .token_store()
        .consume_oauth_state(&state, NOW)
        .await
        .unwrap()
        .unwrap();
    let pending: PendingAuthorization = serde_json::from_value(pending).unwrap();
    assert_eq!(pending.pkce_verifier, URL_SAFE_NO_PAD.encode([1u8; 32]));
    assert!(pending.dpop_private_pem.contains("PRIVATE KEY"));
    assert_eq!(pending.expected_did, ALICE);
    assert_eq!(
        harness.fixture.state.lock().unwrap().par_calls,
        2,
        "initial missing nonce, then signed retry"
    );
}
#[tokio::test]
async fn par_failure() {
    let harness = Harness::new().await;
    harness.fixture.state.lock().unwrap().faults.par_failure = true;
    assert!(matches!(
        harness.service.start("alice.test", NOW).await,
        Err(OAuthError::UpstreamRejected)
    ));
    assert_eq!(harness.count("oauth_states").await, 0);
    assert_eq!(harness.count("oauth_tokens").await, 0);
    harness.fixture.state.lock().unwrap().faults.par_failure = false;
    assert!(harness.service.start("alice.test", NOW).await.is_ok());
}
#[tokio::test]
async fn expired_and_replay() {
    let harness = Harness::new().await;
    let query = harness.query().await;
    let replay = CallbackQuery {
        state: query.state.clone(),
        code: query.code.clone(),
        iss: query.iss.clone(),
    };
    let tokens = harness.service.callback(query, NOW + 299).await.unwrap();
    assert_eq!(tokens.did, ALICE);
    assert!(matches!(
        harness.service.callback(replay, NOW + 299).await,
        Err(OAuthError::InvalidState)
    ));
    assert_eq!(harness.fixture.state.lock().unwrap().token_calls, 1);
    assert_eq!(harness.count("oauth_tokens").await, 1);
    let expired = harness.query().await;
    assert!(matches!(
        harness.service.callback(expired, NOW + 300).await,
        Err(OAuthError::InvalidState)
    ));
    assert_eq!(harness.fixture.state.lock().unwrap().token_calls, 1);
    assert_eq!(harness.count("oauth_states").await, 0);
}
#[tokio::test]
async fn issuer_subject() {
    let harness = Harness::new().await;
    let mut query = harness.query().await;
    query.iss = "https://attacker.example".into();
    assert!(matches!(
        harness.service.callback(query, NOW).await,
        Err(OAuthError::IssuerMismatch)
    ));
    assert_eq!(harness.fixture.state.lock().unwrap().token_calls, 0);
    assert_eq!(harness.count("oauth_tokens").await, 0);
    assert_eq!(harness.count("users").await, 0);
    let query = harness.query().await;
    harness.fixture.state.lock().unwrap().faults.wrong_subject = true;
    assert!(matches!(
        harness.service.callback(query, NOW).await,
        Err(OAuthError::SubjectMismatch)
    ));
    assert_eq!(harness.count("oauth_tokens").await, 0);
    assert_eq!(harness.count("users").await, 0);
    assert!(
        harness
            .service
            .token_store()
            .get_oauth_tokens(BOB)
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn nonce_retry() {
    let harness = Harness::new().await;
    let query = harness.query().await;
    harness.fixture.state.lock().unwrap().faults.nonce = NonceMode::Once;
    harness.service.callback(query, NOW).await.unwrap();
    {
        let fixture = harness.fixture.state.lock().unwrap();
        assert_eq!(fixture.token_calls, 2);
        let proofs: &[_] = &fixture.proofs[fixture.proofs.len() - 2..];
        assert_ne!(proofs[0].jti, proofs[1].jti);
        assert_eq!(proofs[1].nonce.as_deref(), Some("token-nonce-1"));
    }
    assert_eq!(harness.count("oauth_tokens").await, 1);
    let endless = Harness::new().await;
    let query = endless.query().await;
    endless.fixture.state.lock().unwrap().faults.nonce = NonceMode::Endless;
    assert!(matches!(
        endless.service.callback(query, NOW).await,
        Err(OAuthError::NonceExhausted)
    ));
    assert_eq!(endless.fixture.state.lock().unwrap().token_calls, 2);
    assert_eq!(endless.count("oauth_tokens").await, 0);
    assert_eq!(endless.count("users").await, 0);
}
#[tokio::test]
async fn mandatory_nonce_and_refresh_rotation() {
    let harness = Harness::new().await;
    let query = harness.query().await;
    harness.fixture.state.lock().unwrap().faults.nonce = NonceMode::Missing;
    assert!(matches!(
        harness.service.callback(query, NOW).await,
        Err(OAuthError::MissingNonce)
    ));
    assert_eq!(harness.count("oauth_tokens").await, 0);
    harness.fixture.state.lock().unwrap().faults.nonce = NonceMode::Normal;
    let query = harness.query().await;
    let original = harness.service.callback(query, NOW).await.unwrap();
    harness.fixture.state.lock().unwrap().now = NOW + 3600;
    harness.fixture.state.lock().unwrap().faults.rotate_refresh = true;
    let (first, second) = tokio::join!(
        harness.service.refresh(ALICE, NOW + 3600),
        harness.service.refresh(ALICE, NOW + 3600)
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.refresh_token, second.refresh_token);
    assert_ne!(first.refresh_token, original.refresh_token);
    assert_eq!(harness.fixture.state.lock().unwrap().refresh_calls, 1);
    harness.fixture.state.lock().unwrap().faults.invalid_grant = true;
    harness.fixture.state.lock().unwrap().now = NOW + 7200;
    assert!(harness.service.refresh(ALICE, NOW + 7200).await.is_err());
    assert_eq!(harness.count("oauth_tokens").await, 0);
}
fn signed_pds_request(
    tokens: &atmusic_atproto::oauth::service::TokenMaterial,
    origin: &str,
    path: &str,
    method: &str,
    payload: serde_json::Value,
) -> atmusic_atproto::http::safe_client::HttpRequest {
    use jwt_compact::{AlgorithmExt, Claims, Header, alg::Es256, jwk::JsonWebKey};
    use p256::{ecdsa::SigningKey, pkcs8::DecodePrivateKey};
    let signing = SigningKey::from_pkcs8_pem(&tokens.dpop_private_pem).unwrap();
    let header = Header::new(serde_json::json!({"jwk": JsonWebKey::from(signing.verifying_key())}))
        .with_token_type("dpop+jwt");
    let mut url = Url::parse(&format!("{origin}/xrpc/com.atproto.repo.{path}")).unwrap();
    let htu = url.to_string();
    if method == "GET" {
        for (key, value) in payload.as_object().unwrap() {
            url.query_pairs_mut()
                .append_pair(key, value.as_str().unwrap());
        }
    }
    let proof=Es256.token(&header,&Claims::new(serde_json::json!({"jti":oauth2::CsrfToken::new_random().secret(),"iat":NOW,"htm":method,"htu":htu,"nonce":"initial-server-nonce","ath":URL_SAFE_NO_PAD.encode(Sha256::digest(tokens.access_token.as_bytes()))})),&signing).unwrap();
    atmusic_atproto::http::safe_client::HttpRequest {
        url,
        method: method.into(),
        headers: std::collections::BTreeMap::from([
            (
                "authorization".into(),
                format!("DPoP {}", tokens.access_token),
            ),
            ("dpop".into(), proof),
            ("content-type".into(), "application/json".into()),
        ]),
        body: if method == "GET" {
            vec![]
        } else {
            serde_json::to_vec(&payload).unwrap()
        },
    }
}
fn signed_record_request(
    tokens: &atmusic_atproto::oauth::service::TokenMaterial,
    origin: &str,
) -> atmusic_atproto::http::safe_client::HttpRequest {
    signed_pds_request(
        tokens,
        origin,
        "createRecord",
        "POST",
        serde_json::json!({"repo":tokens.did,"collection":"com.example.atmusic.scrobble","rkey":"fixture-record","record":{"artist":"Alice","track":"Fixture","$type":"com.example.atmusic.scrobble"}}),
    )
}

#[tokio::test]
async fn es256_backend_policy() {
    let harness = Harness::new().await;
    let query = harness.query().await;
    let tokens = harness.service.callback(query, NOW).await.unwrap();
    let origin = harness.fixture.state.lock().unwrap().origin.clone();
    let valid = signed_record_request(&tokens, &origin);
    let proof = valid.headers["dpop"].split('.').collect::<Vec<_>>();
    let original: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(proof[0]).unwrap()).unwrap();
    let mut headers = Vec::new();
    for algorithm in ["none", "HS256", "ES384", "RS256"] {
        let mut altered = original.clone();
        altered["alg"] = serde_json::json!(algorithm);
        headers.push(altered);
    }
    let mut wrong_curve = original.clone();
    wrong_curve["jwk"]["crv"] = serde_json::json!("P-384");
    headers.push(wrong_curve);
    let mut wrong_coordinate = original.clone();
    wrong_coordinate["jwk"]["x"] = serde_json::json!(URL_SAFE_NO_PAD.encode([1_u8; 31]));
    headers.push(wrong_coordinate);
    let mut private = original.clone();
    private["jwk"]["d"] = serde_json::json!(URL_SAFE_NO_PAD.encode([1_u8; 32]));
    headers.push(private);
    for header in headers {
        let mut request = valid.clone();
        request.headers.insert(
            "dpop".into(),
            format!(
                "{}.{}.{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
                proof[1],
                proof[2]
            ),
        );
        let response = harness.fixture.client().send(&request).await.unwrap();
        assert_eq!(response.status, 400, "header policy {header}");
        assert_eq!(harness.fixture.state.lock().unwrap().records.len(), 0);
    }
    let mut truncated = valid.clone();
    truncated.headers.insert(
        "dpop".into(),
        format!(
            "{}.{}.{}",
            proof[0],
            proof[1],
            URL_SAFE_NO_PAD.encode([0_u8; 32])
        ),
    );
    let response = harness.fixture.client().send(&truncated).await.unwrap();
    assert_eq!(response.status, 400);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&response.body).unwrap()["error"],
        "invalid_signature"
    );
    assert_eq!(harness.fixture.state.lock().unwrap().records.len(), 0);
    // A healthy ES256 proof still succeeds after every rejection.
    let response = harness.fixture.client().send(&valid).await.unwrap();
    assert_eq!(response.status, 200);
    let record: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    let cid: ipld_core::cid::Cid = record["cid"].as_str().unwrap().parse().unwrap();
    assert_eq!(cid.codec(), 0x71);
    assert_eq!(harness.fixture.state.lock().unwrap().records.len(), 1);
    assert_eq!(harness.count("oauth_tokens").await, 1);
}
#[tokio::test]
async fn fixture_isolation() {
    let alice = Harness::new().await;
    let query = alice.query().await;
    let tokens = alice.service.callback(query, NOW).await.unwrap();
    let bob = Harness::new().await;
    assert_ne!(alice.fixture.origin(), bob.fixture.origin());
    // Real signature, correctly bound DPoP key/ath/htu, and valid issuing token.
    let own = signed_record_request(&tokens, &alice.fixture.origin());
    let response = alice.fixture.client().send(&own).await.unwrap();
    assert_eq!(response.status, 200);
    let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert!(body["cid"].as_str().unwrap().starts_with("bafy"));
    assert_eq!(alice.fixture.state.lock().unwrap().records.len(), 1);
    // Correct new destination-bound DPoP proof passes proof verification. The
    // foreign issuing token signature must still fail at the second fixture.
    let foreign = signed_record_request(&tokens, &bob.fixture.origin());
    let response = bob.fixture.client().send(&foreign).await.unwrap();
    assert_eq!(response.status, 401);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&response.body).unwrap()["error"],
        "invalid_token"
    );
    assert!(bob.fixture.state.lock().unwrap().records.is_empty());
    assert!(
        bob.service
            .token_store()
            .get_oauth_tokens(ALICE)
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn fault_controls() {
    let harness = Harness::new().await;
    harness.fixture.state.lock().unwrap().faults.wrong_issuer = true;
    assert!(matches!(
        harness.service.start("alice.test", NOW).await,
        Err(OAuthError::Discovery(_))
    ));
    assert_eq!(harness.count("oauth_states").await, 0);
    assert_eq!(harness.fixture.state.lock().unwrap().par_calls, 0);
    harness.fixture.state.lock().unwrap().faults.wrong_issuer = false;
    assert!(harness.service.start("alice.test", NOW).await.is_ok());
}
#[test]
fn no_prod_bypass() {
    let transport = include_str!("../src/http/safe_client.rs");
    assert!(!transport.contains("danger_accept_invalid"));
    assert!(!transport.contains("allow_private"));
    assert!(!transport.contains("skip_signature"));
}

#[tokio::test]
async fn par_timeout_cleanup() {
    let harness = Harness::new().await;
    harness.fixture.state.lock().unwrap().faults.stall_par = true;
    let before = std::time::Instant::now();
    assert!(matches!(
        harness.service.start("alice.test", NOW).await,
        Err(OAuthError::Fetch(
            atmusic_atproto::http::safe_client::FetchError::Timeout
        ))
    ));
    assert!(before.elapsed() >= std::time::Duration::from_secs(10));
    assert!(before.elapsed() < std::time::Duration::from_secs(12));
    assert_eq!(harness.count("oauth_states").await, 0);
    assert_eq!(harness.fixture.state.lock().unwrap().par_calls, 1);
    harness.fixture.state.lock().unwrap().faults.stall_par = false;
    assert!(harness.service.start("alice.test", NOW).await.is_ok());
}

#[tokio::test]
async fn fixture_record_lifecycle_and_revocation() {
    let harness = Harness::new().await;
    let query = harness.query().await;
    let tokens = harness.service.callback(query, NOW).await.unwrap();
    let origin = harness.fixture.origin();
    let created = harness
        .fixture
        .client()
        .send(&signed_record_request(&tokens, &origin))
        .await
        .unwrap();
    assert_eq!(created.status, 200);
    let params = serde_json::json!({"repo":ALICE,"collection":"com.example.atmusic.scrobble","rkey":"fixture-record"});
    let get = signed_pds_request(&tokens, &origin, "getRecord", "GET", params.clone());
    let response = harness.fixture.client().send(&get).await.unwrap();
    assert_eq!(response.status, 200);
    let record: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(record["value"]["track"], "Fixture");
    assert_eq!(
        record["cid"],
        serde_json::from_slice::<serde_json::Value>(&created.body).unwrap()["cid"]
    );
    let delete = signed_pds_request(&tokens, &origin, "deleteRecord", "POST", params.clone());
    assert_eq!(
        harness.fixture.client().send(&delete).await.unwrap().status,
        200
    );
    assert!(harness.fixture.state.lock().unwrap().records.is_empty());
    let missing = signed_pds_request(&tokens, &origin, "getRecord", "GET", params);
    assert_eq!(
        harness
            .fixture
            .client()
            .send(&missing)
            .await
            .unwrap()
            .status,
        404
    );
    harness.service.revoke(ALICE, NOW).await.unwrap();
    assert_eq!(harness.fixture.state.lock().unwrap().revocation_calls, 1);
    assert_eq!(harness.count("oauth_tokens").await, 0);
    let revoked = signed_record_request(&tokens, &origin);
    assert_eq!(
        harness
            .fixture
            .client()
            .send(&revoked)
            .await
            .unwrap()
            .status,
        401
    );
    assert!(harness.fixture.state.lock().unwrap().records.is_empty());
}
