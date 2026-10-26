//! Fixed minute windows. Forwarded identity requires an explicitly trusted socket peer.
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Mutex,
};

use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::error::Error as _;

pub const MAX_KEYS: usize = 10_000;
pub const MUTATIONS_PER_MINUTE: u32 = 60;
pub const ANONYMOUS_READS_PER_MINUTE: u32 = 120;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub enum RateKey {
    Mutation(String),
    Anonymous(IpAddr),
}
struct Bucket {
    window: i64,
    count: u32,
}
#[derive(Default)]
pub struct Limiter {
    buckets: Mutex<HashMap<RateKey, Bucket>>,
}
impl Limiter {
    pub fn admit(&self, key: RateKey, now: i64) -> Result<(), u64> {
        let window = now.div_euclid(60);
        let retry_after = (60 - now.rem_euclid(60)) as u64;
        let limit = match &key {
            RateKey::Mutation(_) => MUTATIONS_PER_MINUTE,
            RateKey::Anonymous(_) => ANONYMOUS_READS_PER_MINUTE,
        };
        let Ok(mut buckets) = self.buckets.lock() else {
            return Err(retry_after);
        };
        buckets.retain(|_, bucket| bucket.window == window);
        if !buckets.contains_key(&key) && buckets.len() == MAX_KEYS {
            return Err(retry_after);
        }
        let bucket = buckets.entry(key).or_insert(Bucket { window, count: 0 });
        if bucket.count >= limit {
            return Err(retry_after);
        }
        bucket.count += 1;
        Ok(())
    }
    pub fn key_count(&self) -> usize {
        self.buckets
            .lock()
            .map_or(MAX_KEYS, |buckets| buckets.len())
    }
}

pub async fn enforce(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // Health and metrics remain available when public traffic exceeds its quota.
    if !request.uri().path().starts_with("/api/v1/") {
        return next.run(request).await;
    }
    state.metrics.request();
    let id = request
        .extensions()
        .get::<RequestId>()
        .cloned()
        .unwrap_or_else(|| RequestId(uuid::Uuid::new_v4().to_string()));
    let authenticated = session::authenticate(&state, request.headers(), &id)
        .await
        .ok();
    let is_read = matches!(*request.method(), Method::GET | Method::HEAD);
    let key = match (authenticated, is_read) {
        (Some(owner), false) => Some(RateKey::Mutation(owner.did)),
        (None, true) => Some(RateKey::Anonymous(client_ip(&state, &request))),
        _ => None,
    };
    if let Some(key) = key
        && let Err(retry_after) = state.limiter.admit(key, state.clock.now().timestamp())
    {
        state.metrics.rate_rejected();
        let mut error = HttpError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "The request rate limit was reached.",
            &id,
        );
        error.headers.insert(
            "retry-after",
            HeaderValue::from_str(&retry_after.to_string()).expect("numeric retry interval"),
        );
        return error.into_response();
    }
    let (parts, body) = request.into_parts();
    let bytes = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        axum::body::to_bytes(body, 65_536),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error))
            if error
                .source()
                .is_some_and(|source| source.is::<http_body_util::LengthLimitError>()) =>
        {
            return HttpError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "The request body exceeds 65536 bytes.",
                &id,
            )
            .into_response();
        }
        _ => {
            return HttpError::new(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                "The request body could not be read within its deadline.",
                &id,
            )
            .into_response();
        }
    };
    next.run(Request::from_parts(parts, axum::body::Body::from(bytes)))
        .await
}

fn client_ip(state: &AppState, request: &Request) -> IpAddr {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::from([0, 0, 0, 0]), |peer| peer.0.ip());
    let Some(config) = state.config.as_ref() else {
        return peer;
    };
    let trusted = |ip: &IpAddr| {
        config
            .trusted_proxy_cidrs
            .iter()
            .any(|cidr| cidr.contains(ip))
    };
    if !trusted(&peer) {
        return peer;
    }
    // A proxy must replace proto/host and append the actual peer to X-Forwarded-For.
    // The configured origin still controls OAuth URLs, CSRF, and secure cookies.
    let single = |name: &'static str| {
        let mut values = request.headers().get_all(name).iter();
        let value = values.next()?.to_str().ok()?;
        if values.next().is_some() || value.len() > 1024 {
            return None;
        }
        Some(value)
    };
    if single("x-forwarded-proto") != Some("https")
        || single("x-forwarded-host") != config.public_origin.host_str()
    {
        return peer;
    }
    let Some(chain) = single("x-forwarded-for") else {
        return peer;
    };
    let mut parsed = Vec::new();
    for entry in chain.split(',') {
        if parsed.len() == 16 {
            return peer;
        }
        let Ok(ip) = entry.trim().parse::<IpAddr>() else {
            return peer;
        };
        parsed.push(ip);
    }
    // Skip only configured proxies from the right; never accept a forged leftmost
    // address when an untrusted hop intervenes.
    parsed
        .iter()
        .rev()
        .find(|ip| !trusted(ip))
        .copied()
        .or_else(|| parsed.first().copied())
        .unwrap_or(peer)
}
