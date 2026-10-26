//! Real controlled identity HTTP server behind the typed test transport.
#![allow(dead_code)]
use std::{
    collections::{BTreeMap, HashMap},
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{DnsResolver, FetchError, HttpResponse, HttpTransport, SafeClient},
    identity::{Clock, IdentityResolver},
};
use axum::{
    Router,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use tokio::task::JoinHandle;
use url::Url;

pub const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
pub const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
pub const CAROL: &str = "did:plc:cccccccccccccccccccccccc";

#[derive(Default)]
pub struct FakeIdentityClock(AtomicU64);
impl FakeIdentityClock {
    pub fn set(&self, seconds: u64) {
        self.0.store(seconds, Ordering::SeqCst);
    }
}
impl Clock for FakeIdentityClock {
    fn now(&self) -> Duration {
        Duration::from_secs(self.0.load(Ordering::SeqCst))
    }
}

#[derive(Default)]
struct IdentityState {
    handles: HashMap<String, String>,
    aliases: HashMap<String, String>,
    calls: Vec<String>,
    upstream_failure: bool,
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
struct WireTransport {
    address: SocketAddr,
    client: reqwest::Client,
}
#[async_trait]
impl HttpTransport for WireTransport {
    async fn fetch(&self, url: &Url, addresses: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        assert_eq!(addresses, &["93.184.216.34:443".parse().unwrap()]);
        let host = url.host_str().ok_or(FetchError::Transport)?;
        if host != "plc.directory" && !host.ends_with(".test") {
            return Err(FetchError::Transport);
        }
        let response = self
            .client
            .get(format!("http://{}{}", self.address, url.path()))
            .header("host", host)
            .send()
            .await
            .map_err(|_| FetchError::Transport)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| {
                Ok((
                    key.as_str().to_owned(),
                    value
                        .to_str()
                        .map_err(|_| FetchError::Transport)?
                        .to_owned(),
                ))
            })
            .collect::<Result<BTreeMap<_, _>, FetchError>>()?;
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

pub struct ControlledIdentity {
    state: Arc<Mutex<IdentityState>>,
    pub clock: Arc<FakeIdentityClock>,
    pub resolver: Arc<IdentityResolver>,
    task: JoinHandle<()>,
}
impl ControlledIdentity {
    pub async fn start() -> Self {
        let state = Arc::new(Mutex::new(IdentityState::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .fallback(identity_request)
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let transport = WireTransport {
            address,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        };
        let clock = Arc::new(FakeIdentityClock::default());
        let resolver = Arc::new(IdentityResolver::with_clock(
            SafeClient::new(Arc::new(FixtureDns), Arc::new(transport)),
            clock.clone(),
        ));
        let fixture = Self {
            state,
            clock,
            resolver,
            task,
        };
        for (did, handle) in [
            (ALICE, "alice.test"),
            (BOB, "bob.test"),
            (CAROL, "carol.test"),
        ] {
            fixture.rename(did, handle);
        }
        fixture
    }
    pub fn rename(&self, did: &str, handle: &str) {
        let mut state = self.state.lock().unwrap();
        state.handles.retain(|_, owner| owner != did);
        state.handles.insert(handle.into(), did.into());
        state.aliases.insert(did.into(), handle.into());
    }
    pub fn alias(&self, did: &str, handle: &str) {
        self.state
            .lock()
            .unwrap()
            .aliases
            .insert(did.into(), handle.into());
    }
    pub fn handle(&self, handle: &str, did: &str) {
        self.state
            .lock()
            .unwrap()
            .handles
            .insert(handle.into(), did.into());
    }
    pub fn fail_upstream(&self, failure: bool) {
        self.state.lock().unwrap().upstream_failure = failure;
    }
    pub fn calls(&self) -> usize {
        self.state.lock().unwrap().calls.len()
    }
}
impl Drop for ControlledIdentity {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn identity_request(
    State(state): State<Arc<Mutex<IdentityState>>>,
    request: Request,
) -> Response {
    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let path = request.uri().path();
    let mut state = state.lock().unwrap();
    state.calls.push(format!("{host}{path}"));
    if state.upstream_failure {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "fixture-upstream-private-detail",
        )
            .into_response();
    }
    if path == "/.well-known/atproto-did" {
        return match state.handles.get(host) {
            Some(did) => ([("content-type", "text/plain")], did.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    if host == "plc.directory"
        && let Some(did) = path.strip_prefix('/')
        && let Some(handle) = state.aliases.get(did)
    {
        return axum::Json(json!({
            "id":did, "alsoKnownAs":[format!("at://{handle}")],
            "service":[{"id":"#atproto_pds","type":"AtprotoPersonalDataServer","serviceEndpoint":"https://pds.test"}]
        })).into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}
