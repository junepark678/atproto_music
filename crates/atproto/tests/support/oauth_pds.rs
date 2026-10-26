//! Test-only real HTTP fixture behind an explicitly injected transport.
//! Production HTTPS, DNS and signature policies have no fixture flags.
#![allow(dead_code)]
use async_trait::async_trait;
use atmusic_atproto::http::safe_client::{
    DnsResolver, FetchError, HttpRequest, HttpResponse, HttpTransport, SafeClient,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jwt_compact::{AlgorithmExt, Claims, Header, UntrustedToken, alg::Es256, jwk::JsonWebKey};
use p256::{
    SecretKey,
    ecdsa::{SigningKey, VerifyingKey},
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
};
use tokio::task::JoinHandle;
use url::Url;

pub const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
pub const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
pub const NOW: i64 = 1_768_478_400;

#[derive(Clone, Copy, Default)]
pub enum NonceMode {
    #[default]
    Normal,
    Once,
    Endless,
    Missing,
}
#[derive(Default)]
pub struct Faults {
    pub nonce: NonceMode,
    pub wrong_issuer: bool,
    pub wrong_subject: bool,
    pub par_failure: bool,
    pub stall_par: bool,
    pub invalid_grant: bool,
    pub rotate_refresh: bool,
    pub corrupt_proof: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Proof {
    pub jti: String,
    pub iat: i64,
    pub htm: String,
    pub htu: String,
    pub nonce: Option<String>,
    pub ath: Option<String>,
}
#[derive(Clone)]
pub struct Par {
    pub fields: HashMap<String, String>,
    pub key: Value,
    pub used: bool,
}
pub struct FixtureState {
    pub origin: String,
    pub faults: Faults,
    pub pars: Vec<Par>,
    pub proofs: Vec<Proof>,
    pub par_calls: usize,
    pub token_calls: usize,
    pub refresh_calls: usize,
    pub revocation_calls: usize,
    pub now: i64,
    pub nonce: String,
    pub records: HashMap<String, Value>,
    seen_jti: HashSet<String>,
    refresh_tokens: HashMap<String, Value>,
    active_tokens: HashMap<String, Value>,
    codes: HashMap<String, usize>,
    signing: SigningKey,
    verifying: VerifyingKey,
}
#[derive(Clone)]
pub struct WireTransport {
    pub address: SocketAddr,
    pub origin: String,
    pub state: Arc<Mutex<FixtureState>>,
}
struct FixtureDns;
#[async_trait]
impl DnsResolver for FixtureDns {
    async fn resolve(&self, _: &str) -> Result<Vec<IpAddr>, FetchError> {
        Ok(vec!["93.184.216.34".parse().unwrap()])
    }
    async fn txt(&self, name: &str) -> Result<Vec<String>, FetchError> {
        Ok(if name == "_atproto.alice.test" {
            vec![format!("did={ALICE}")]
        } else if name == "_atproto.bob.test" {
            vec![format!("did={BOB}")]
        } else {
            vec![]
        })
    }
}
#[async_trait]
impl HttpTransport for WireTransport {
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
        // Only owned fixture routes and one missing-handle HTTPS lookup map locally.
        let missing_handle = request.method == "GET"
            && request.url.host_str() == Some("missing.test")
            && request.url.path() == "/.well-known/atproto-did";
        if request.url.origin().ascii_serialization() != self.origin
            && request.url.host_str() != Some("plc.directory")
            && !missing_handle
        {
            return Err(FetchError::UnsafeDestination);
        }
        let mut url = Url::parse(&format!("http://{}", self.address)).unwrap();
        url.set_path(request.url.path());
        url.set_query(request.url.query());
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut builder = client
            .request(
                reqwest::Method::from_bytes(request.method.as_bytes()).unwrap(),
                url,
            )
            .header("x-fixture-url", request.url.as_str())
            .body(request.body.clone());
        for (key, value) in &request.headers {
            if key == "dpop"
                && request.url.path() == "/token"
                && self.state.lock().unwrap().faults.corrupt_proof
            {
                let mut segments: Vec<_> = value.split('.').collect();
                if segments.len() == 3 {
                    segments[2] = "invalid-signature";
                }
                builder = builder.header(key, segments.join("."));
            } else {
                builder = builder.header(key, value);
            }
        }
        let response = builder.send().await.map_err(|_| FetchError::Transport)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().into(), v.into())))
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

pub struct ControlledPds {
    pub state: Arc<Mutex<FixtureState>>,
    pub transport: WireTransport,
    task: JoinHandle<()>,
}
impl ControlledPds {
    pub async fn start() -> Self {
        let secret = SecretKey::random(&mut OsRng);
        let point = secret.public_key().to_encoded_point(false);
        let bytes = point.as_bytes();
        let origin = format!(
            "https://oauth-{}.test",
            URL_SAFE_NO_PAD
                .encode(Sha256::digest(bytes))
                .to_ascii_lowercase()
                .replace('_', "-")
        );
        let signing = SigningKey::from(secret);
        let verifying = *signing.verifying_key();
        let state = Arc::new(Mutex::new(FixtureState {
            origin: origin.clone(),
            faults: Faults::default(),
            pars: vec![],
            proofs: vec![],
            par_calls: 0,
            token_calls: 0,
            refresh_calls: 0,
            revocation_calls: 0,
            now: NOW,
            nonce: "initial-server-nonce".into(),
            records: HashMap::new(),
            seen_jti: HashSet::new(),
            refresh_tokens: HashMap::new(),
            active_tokens: HashMap::new(),
            codes: HashMap::new(),
            signing,
            verifying,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(route).with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            state: state.clone(),
            transport: WireTransport {
                address,
                origin,
                state,
            },
            task,
        }
    }
    pub fn client(&self) -> SafeClient {
        SafeClient::new(Arc::new(FixtureDns), Arc::new(self.transport.clone()))
    }
    pub fn origin(&self) -> String {
        self.transport.origin.clone()
    }
    pub async fn authorize(&self, url: &str) -> (String, String, String) {
        let response = self.client().get(&Url::parse(url).unwrap()).await.unwrap();
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        (
            body["code"].as_str().unwrap().into(),
            body["state"].as_str().unwrap().into(),
            body["iss"].as_str().unwrap().into(),
        )
    }
}
impl Drop for ControlledPds {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn response(status: u16, body: Value, nonce: Option<&str>) -> Response {
    let mut response = (StatusCode::from_u16(status).unwrap(), Json(body)).into_response();
    if let Some(nonce) = nonce {
        response
            .headers_mut()
            .insert("dpop-nonce", HeaderValue::from_str(nonce).unwrap());
    }
    response
}
fn metadata(origin: &str, wrong: bool) -> Value {
    json!({"issuer":if wrong {"https://wrong.example"} else {origin},"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"pushed_authorization_request_endpoint":format!("{origin}/par"),"revocation_endpoint":format!("{origin}/revoke"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","private_key_jwt"],"token_endpoint_auth_signing_alg_values_supported":["ES256"],"scopes_supported":["atproto"],"dpop_signing_alg_values_supported":["ES256"],"authorization_response_iss_parameter_supported":true,"require_pushed_authorization_requests":true,"client_id_metadata_document_supported":true})
}
fn proof(
    headers: &axum::http::HeaderMap,
    method: &str,
    url: &str,
    state: &mut FixtureState,
) -> Result<(Proof, Value), String> {
    let token = headers
        .get("dpop")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing_proof")?;
    let parsed = UntrustedToken::<Value>::try_from(token).map_err(|_| "invalid_proof")?;
    let header = parsed.header();
    if parsed.algorithm() != "ES256" || header.token_type.as_deref() != Some("dpop+jwt") {
        return Err("wrong_algorithm".into());
    }
    let value = header
        .other_fields
        .get("jwk")
        .cloned()
        .ok_or("missing_jwk")?;
    if value.get("d").is_some() {
        return Err("private_key_exposed".into());
    }
    let jwk: JsonWebKey<'_> = serde_json::from_value(value.clone()).map_err(|_| "invalid_jwk")?;
    let verifying = VerifyingKey::try_from(&jwk).map_err(|_| "invalid_jwk")?;
    let verified = Es256
        .validator::<Value>(&verifying)
        .validate(&parsed)
        .map_err(|_| "invalid_signature")?;
    let claims: Proof = serde_json::from_value(serde_json::to_value(verified.claims()).unwrap())
        .map_err(|_| "invalid_proof_claims")?;
    let mut htu = Url::parse(url).unwrap();
    htu.set_query(None);
    htu.set_fragment(None);
    if claims.htm != method
        || claims.htu != htu.as_str()
        || (claims.iat - state.now).abs() > 300
        || !state.seen_jti.insert(claims.jti.clone())
    {
        return Err("invalid_proof_claims".into());
    }
    state.proofs.push(claims.clone());
    Ok((claims, value))
}
async fn route(State(shared): State<Arc<Mutex<FixtureState>>>, request: Request) -> Response {
    let url = request
        .headers()
        .get("x-fixture-url")
        .and_then(|h| h.to_str().ok())
        .unwrap()
        .to_owned();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let method = request.method().to_string();
    let headers = request.headers().clone();
    let body = to_bytes(request.into_body(), 1_048_576).await.unwrap();
    let fields: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let stall = path == "/par" && shared.lock().unwrap().faults.stall_par;
    if stall {
        shared.lock().unwrap().par_calls += 1;
        return std::future::pending().await;
    }
    let mut state = shared.lock().unwrap();
    let origin = state.origin.clone();
    match path.as_str() {
        "/.well-known/atproto-did" => {
            return response(404, json!({"error":"handle_not_found"}), None);
        }
        "/.well-known/oauth-protected-resource" => {
            return response(
                200,
                json!({"resource":origin,"authorization_servers":[origin]}),
                None,
            );
        }
        "/.well-known/oauth-authorization-server" => {
            return response(200, metadata(&origin, state.faults.wrong_issuer), None);
        }
        "/authorize" => {
            let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect();
            let index = params
                .get("request_uri")
                .and_then(|uri| uri.strip_prefix("urn:ietf:params:oauth:request_uri:"))
                .and_then(|s| s.parse::<usize>().ok());
            let Some(index) = index else {
                return response(400, json!({"error":"invalid_request"}), None);
            };
            let Some(par) = state.pars.get(index) else {
                return response(400, json!({"error":"invalid_request"}), None);
            };
            if params.get("client_id") != par.fields.get("client_id") {
                return response(400, json!({"error":"invalid_client"}), None);
            }
            let callback_state = par.fields["state"].clone();
            let code = format!("fixture-code-{index}");
            state.codes.insert(code.clone(), index);
            return response(
                200,
                json!({"code":code,"state":callback_state,"iss":origin}),
                None,
            );
        }
        _ if path == format!("/{ALICE}") || path == format!("/{BOB}") => {
            return response(
                200,
                json!({"id":path.trim_start_matches('/'),"alsoKnownAs":[if path.ends_with(BOB) { "at://bob.test" } else { "at://alice.test" }],"service":[{"id":"#atproto_pds","type":"AtprotoPersonalDataServer","serviceEndpoint":origin}]}),
                None,
            );
        }
        _ => {}
    }
    let (claims, key) = match proof(&headers, &method, &url, &mut state) {
        Ok(v) => v,
        Err(error) => return response(400, json!({"error":error}), Some(&state.nonce)),
    };
    if path == "/par" {
        state.par_calls += 1;
        if state.faults.par_failure {
            return response(400, json!({"error":"invalid_request"}), Some(&state.nonce));
        }
        if claims.nonce.as_deref() != Some(&state.nonce) {
            return response(400, json!({"error":"use_dpop_nonce"}), Some(&state.nonce));
        }
        if fields.get("code_challenge_method").map(String::as_str) != Some("S256")
            || !fields.contains_key("state")
            || !fields.contains_key("redirect_uri")
        {
            return response(400, json!({"error":"invalid_request"}), Some(&state.nonce));
        }
        let index = state.pars.len();
        state.pars.push(Par {
            fields,
            key,
            used: false,
        });
        return response(
            201,
            json!({"request_uri":format!("urn:ietf:params:oauth:request_uri:{index}"),"expires_in":300}),
            Some(&state.nonce),
        );
    }
    if path == "/token" {
        state.token_calls += 1;
        if matches!(state.faults.nonce, NonceMode::Missing) {
            return response(200, json!({}), None);
        }
        if matches!(state.faults.nonce, NonceMode::Endless)
            || matches!(state.faults.nonce, NonceMode::Once) && state.token_calls == 1
        {
            state.nonce = format!("token-nonce-{}", state.token_calls);
            return response(400, json!({"error":"use_dpop_nonce"}), Some(&state.nonce));
        }
        if claims.nonce.as_deref() != Some(&state.nonce) {
            return response(400, json!({"error":"use_dpop_nonce"}), Some(&state.nonce));
        }
        if state.faults.invalid_grant {
            return response(400, json!({"error":"invalid_grant"}), Some(&state.nonce));
        }
        let refresh = fields.get("grant_type").map(String::as_str) == Some("refresh_token");
        let (scope, did) = if refresh {
            state.refresh_calls += 1;
            let Some(token) = fields
                .get("refresh_token")
                .and_then(|token| state.refresh_tokens.remove(token))
            else {
                return response(400, json!({"error":"invalid_grant"}), Some(&state.nonce));
            };
            if token["key"] != key {
                return response(400, json!({"error":"invalid_dpop_key"}), Some(&state.nonce));
            }
            (
                token["scope"].as_str().unwrap().to_owned(),
                token["sub"].as_str().unwrap().to_owned(),
            )
        } else {
            let Some(index) = fields.get("code").and_then(|code| state.codes.remove(code)) else {
                return response(400, json!({"error":"invalid_grant"}), Some(&state.nonce));
            };
            let par = &mut state.pars[index];
            if par.used
                || fields.get("client_id") != par.fields.get("client_id")
                || fields.get("redirect_uri") != par.fields.get("redirect_uri")
                || key != par.key
                || fields
                    .get("code_verifier")
                    .map(|verifier| URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())))
                    != par.fields.get("code_challenge").cloned()
            {
                return response(400, json!({"error":"invalid_grant"}), Some(&state.nonce));
            }
            par.used = true;
            let expected = if par
                .fields
                .get("login_hint")
                .is_some_and(|hint| hint == "bob.test" || hint == BOB)
            {
                BOB
            } else {
                ALICE
            };
            (
                par.fields["scope"].clone(),
                if state.faults.wrong_subject {
                    if expected == ALICE {
                        BOB.into()
                    } else {
                        ALICE.into()
                    }
                } else {
                    expected.into()
                },
            )
        };
        let access = Es256.token(
            &Header::empty(),
            &Claims::new(json!({"iss":origin,"sub":did,"scope":scope,"exp":state.now+3600,"cnf":{"jwk":key}})),
            &state.signing,
        )
        .unwrap();
        let refresh = if refresh && !state.faults.rotate_refresh {
            fields["refresh_token"].clone()
        } else {
            format!(
                "fixture-refresh-{}-{}",
                state.token_calls,
                URL_SAFE_NO_PAD.encode(Sha256::digest(access.as_bytes()))
            )
        };
        state
            .refresh_tokens
            .insert(refresh.clone(), json!({"sub":did,"scope":scope,"key":key}));
        state.active_tokens.insert(access.clone(), key.clone());
        return response(
            200,
            json!({"access_token":access,"token_type":"DPoP","refresh_token":refresh,"scope":scope,"expires_in":3600,"sub":did}),
            Some(&state.nonce),
        );
    }
    if path == "/revoke" {
        state.revocation_calls += 1;
        if let Some(token) = fields.get("token") {
            if let Some(material) = state.refresh_tokens.remove(token) {
                state.active_tokens.retain(|_, key| *key != material["key"]);
            } else {
                state.active_tokens.remove(token);
            }
        }
        return response(200, json!({}), Some(&state.nonce));
    }
    if path.starts_with("/xrpc/") {
        let Some(access) = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("DPoP "))
        else {
            return response(401, json!({"error":"unauthorized"}), Some(&state.nonce));
        };
        let token = match UntrustedToken::new(access).ok().and_then(|parsed| {
            Es256
                .validator::<Value>(&state.verifying)
                .validate(&parsed)
                .ok()
        }) {
            Some(verified) => serde_json::to_value(verified.claims()).unwrap(),
            None => return response(401, json!({"error":"invalid_token"}), Some(&state.nonce)),
        };
        if token["iss"] != origin
            || !state.active_tokens.contains_key(access)
            || token["exp"]
                .as_i64()
                .is_none_or(|expiry| expiry <= state.now)
            || token["cnf"]["jwk"] != key
            || claims.ath.as_deref()
                != Some(&URL_SAFE_NO_PAD.encode(Sha256::digest(access.as_bytes())))
        {
            return response(401, json!({"error":"invalid_token"}), Some(&state.nonce));
        }
        let payload: Value = if method == "GET" {
            serde_json::to_value(
                url::form_urlencoded::parse(query.as_bytes())
                    .into_owned()
                    .collect::<HashMap<String, String>>(),
            )
            .unwrap()
        } else {
            serde_json::from_slice(&body).unwrap_or(Value::Null)
        };
        let rkey = payload["rkey"]
            .as_str()
            .unwrap_or("fixture-record")
            .to_owned();
        let owner = payload["repo"].as_str().unwrap_or(ALICE);
        let collection = payload["collection"]
            .as_str()
            .unwrap_or("com.example.atmusic.scrobble");
        if owner != token["sub"].as_str().unwrap() {
            return response(403, json!({"error":"wrong_repo"}), Some(&state.nonce));
        }
        let uri = format!("at://{owner}/{collection}/{rkey}");
        if !path.ends_with("getRecord")
            && !token["scope"]
                .as_str()
                .unwrap_or("")
                .split_whitespace()
                .any(|scope| scope == format!("repo:{collection}"))
        {
            return response(
                403,
                json!({"error":"insufficient_scope"}),
                Some(&state.nonce),
            );
        }
        if path.ends_with("createRecord") {
            let bytes = serde_ipld_dagcbor::to_vec(&payload["record"]).unwrap();
            let hash =
                ipld_core::cid::multihash::Multihash::<64>::wrap(0x12, &Sha256::digest(&bytes))
                    .unwrap();
            let cid = ipld_core::cid::Cid::new_v1(0x71, hash);
            state.records.insert(uri.clone(), payload["record"].clone());
            return response(
                200,
                json!({"uri":uri,"cid":cid.to_string()}),
                Some(&state.nonce),
            );
        }
        if path.ends_with("deleteRecord") {
            state.records.remove(&uri);
            return response(200, json!({}), Some(&state.nonce));
        }
        if path.ends_with("getRecord") {
            let Some(record) = state.records.get(&uri) else {
                return response(404, json!({"error":"RecordNotFound"}), Some(&state.nonce));
            };
            let bytes = serde_ipld_dagcbor::to_vec(record).unwrap();
            let cid = ipld_core::cid::Cid::new_v1(
                0x71,
                ipld_core::cid::multihash::Multihash::<64>::wrap(0x12, &Sha256::digest(&bytes))
                    .unwrap(),
            );
            return response(
                200,
                json!({"uri":uri,"value":record,"cid":cid.to_string()}),
                Some(&state.nonce),
            );
        }
    }
    response(404, json!({"error":"not_found"}), Some(&state.nonce))
}
