//! A bounded HTTPS boundary for attacker-controlled AT Protocol URLs.
//!
//! The production transport pins every validated DNS answer into the connection
//! and disables independently resolving HTTP proxies. It never disables TLS.
//! Tests inject a transport rather than weakening this destination policy.

use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use hickory_resolver::{TokioResolver, proto::rr::RData};
use thiserror::Error;
use url::{Host, Url};

pub const MAX_METADATA_BYTES: usize = 1_048_576;
/// The repository verifier accepts CAR files up to eight MiB. This is separate
/// from metadata limits and never relaxes them for OAuth/identity documents.
pub const MAX_REPOSITORY_BYTES: usize = crate::sync::frames::MAX_CAR_BYTES;
pub const FETCH_DEADLINE: Duration = Duration::from_secs(10);
pub const MAX_REDIRECTS: usize = 3;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum FetchError {
    #[error("unsafe_destination")]
    UnsafeDestination,
    #[error("dns_resolution_failed")]
    Dns,
    #[error("upstream_transport_error")]
    Transport,
    #[error("upstream_timeout")]
    Timeout,
    #[error("too_many_redirects")]
    TooManyRedirects,
    #[error("metadata_redirect_forbidden")]
    RedirectForbidden,
    #[error("upstream_body_too_large")]
    BodyTooLarge,
    #[error("invalid_redirect")]
    InvalidRedirect,
    #[error("upstream_http_status_{0}")]
    HttpStatus(u16),
    #[error("invalid_content_type")]
    ContentType,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// Header names are lowercase. The production transport normalizes them.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Clone)]
pub struct HttpRequest {
    pub url: Url,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("body", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

#[async_trait]
pub trait DnsResolver: Send + Sync {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError>;
    async fn txt(&self, name: &str) -> Result<Vec<String>, FetchError>;
}

/// A transport receives the exact addresses authorized for this request. An
/// implementation must connect only to these addresses, preserving TLS hostname
/// verification, and must not follow redirects itself.
#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn fetch(&self, url: &Url, addresses: &[SocketAddr]) -> Result<HttpResponse, FetchError>;

    /// A dedicated repository GET with an eight-MiB maximum. Production streams
    /// to this limit; injected transports must retain the destination contract.
    async fn fetch_repository(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
    ) -> Result<HttpResponse, FetchError> {
        self.fetch(url, addresses).await
    }

    async fn send(
        &self,
        request: &HttpRequest,
        addresses: &[SocketAddr],
    ) -> Result<HttpResponse, FetchError> {
        if request.method == "GET" && request.body.is_empty() {
            self.fetch(&request.url, addresses).await
        } else {
            Err(FetchError::Transport)
        }
    }
}

pub struct SystemDns(TokioResolver);

impl SystemDns {
    pub fn new() -> Result<Self, FetchError> {
        let builder = TokioResolver::builder_tokio().map_err(|_| FetchError::Dns)?;
        builder.build().map(Self).map_err(|_| FetchError::Dns)
    }
}

#[async_trait]
impl DnsResolver for SystemDns {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError> {
        reject_reserved_domain(host)?;
        self.0
            .lookup_ip(host)
            .await
            .map(|r| r.iter().collect())
            .map_err(|_| FetchError::Dns)
    }

    async fn txt(&self, name: &str) -> Result<Vec<String>, FetchError> {
        reject_reserved_domain(name)?;
        self.0
            .txt_lookup(name)
            .await
            .map(|r| {
                r.answers()
                    .iter()
                    .filter_map(|record| {
                        let RData::TXT(txt) = &record.data else {
                            return None;
                        };
                        let bytes: Vec<u8> = txt
                            .txt_data
                            .iter()
                            .flat_map(|v| v.iter().copied())
                            .collect();
                        String::from_utf8(bytes).ok()
                    })
                    .collect()
            })
            .map_err(|_| FetchError::Dns)
    }
}

fn reject_reserved_domain(host: &str) -> Result<(), FetchError> {
    let tld = host
        .trim_end_matches('.')
        .rsplit('.')
        .next()
        .unwrap_or(host);
    if matches!(
        tld.to_ascii_lowercase().as_str(),
        "arpa" | "example" | "invalid" | "local" | "localhost" | "onion" | "test"
    ) {
        return Err(FetchError::UnsafeDestination);
    }
    Ok(())
}

#[derive(Default)]
pub struct ReqwestTransport;

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn fetch(&self, url: &Url, addresses: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        self.send(
            &HttpRequest {
                url: url.clone(),
                method: "GET".into(),
                headers: BTreeMap::new(),
                body: Vec::new(),
            },
            addresses,
        )
        .await
    }

    async fn send(
        &self,
        request: &HttpRequest,
        addresses: &[SocketAddr],
    ) -> Result<HttpResponse, FetchError> {
        Self::bounded_send(request, addresses, MAX_METADATA_BYTES).await
    }

    async fn fetch_repository(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
    ) -> Result<HttpResponse, FetchError> {
        Self::bounded_send(
            &HttpRequest {
                url: url.clone(),
                method: "GET".into(),
                headers: BTreeMap::from([("accept".into(), "application/vnd.ipld.car".into())]),
                body: Vec::new(),
            },
            addresses,
            MAX_REPOSITORY_BYTES,
        )
        .await
    }
}

impl ReqwestTransport {
    async fn bounded_send(
        request: &HttpRequest,
        addresses: &[SocketAddr],
        maximum_body: usize,
    ) -> Result<HttpResponse, FetchError> {
        let url = &request.url;
        let host = url.host_str().ok_or(FetchError::UnsafeDestination)?;
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(FETCH_DEADLINE)
            .resolve_to_addrs(host, addresses)
            .build()
            .map_err(|_| FetchError::Transport)?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| FetchError::Transport)?;
        let mut builder = client
            .request(method, url.clone())
            .body(request.body.clone());
        for (key, value) in &request.headers {
            builder = builder.header(key, value);
        }
        let mut response = builder.send().await.map_err(transport_error)?;
        if response
            .content_length()
            .is_some_and(|len| len > maximum_body as u64)
        {
            return Err(FetchError::BodyTooLarge);
        }
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|v| (k.as_str().to_owned(), v.to_owned()))
            })
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            if body.len().saturating_add(chunk.len()) > maximum_body {
                return Err(FetchError::BodyTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

fn transport_error(error: reqwest::Error) -> FetchError {
    if error.is_timeout() {
        FetchError::Timeout
    } else {
        FetchError::Transport
    }
}

#[derive(Clone)]
pub struct SafeClient {
    resolver: Arc<dyn DnsResolver>,
    transport: Arc<dyn HttpTransport>,
}

impl SafeClient {
    pub fn production() -> Result<Self, FetchError> {
        Ok(Self::new(
            Arc::new(SystemDns::new()?),
            Arc::new(ReqwestTransport),
        ))
    }

    /// Dependency injection for alternative securely implemented transports and
    /// deterministic test fixtures. There is no private-network or TLS bypass.
    pub fn new(resolver: Arc<dyn DnsResolver>, transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            resolver,
            transport,
        }
    }

    pub async fn txt(&self, name: &str) -> Result<Vec<String>, FetchError> {
        tokio::time::timeout(FETCH_DEADLINE, self.resolver.txt(name))
            .await
            .map_err(|_| FetchError::Timeout)?
    }

    pub async fn get(&self, url: &Url) -> Result<HttpResponse, FetchError> {
        self.bounded_fetch(url, true, false, false).await
    }

    /// Dedicated bounded CAR download. Certificate validation, DNS pinning,
    /// ten-second deadline and redirect destination checks are unchanged.
    pub async fn repository(&self, url: &Url) -> Result<HttpResponse, FetchError> {
        self.bounded_fetch(url, true, true, true).await
    }

    /// OAuth and authenticated PDS requests never follow redirects; return HTTP
    /// error responses to the protocol layer for bounded nonce/retry handling.
    pub async fn send(&self, request: &HttpRequest) -> Result<HttpResponse, FetchError> {
        tokio::time::timeout(FETCH_DEADLINE, async {
            if request.body.len() > MAX_METADATA_BYTES {
                return Err(FetchError::BodyTooLarge);
            }
            let addresses = self.destination(&request.url).await?;
            let response = self.transport.send(request, &addresses).await?;
            if response.body.len() > MAX_METADATA_BYTES {
                return Err(FetchError::BodyTooLarge);
            }
            if (300..400).contains(&response.status) {
                return Err(FetchError::RedirectForbidden);
            }
            Ok(response)
        })
        .await
        .map_err(|_| FetchError::Timeout)?
    }

    /// AT OAuth metadata requires exact 200, JSON, and no redirects.
    pub async fn metadata(&self, url: &Url) -> Result<Vec<u8>, FetchError> {
        let response = self.bounded_fetch(url, false, true, false).await?;
        if !response.headers.get("content-type").is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        }) {
            return Err(FetchError::ContentType);
        }
        Ok(response.body)
    }

    async fn bounded_fetch(
        &self,
        url: &Url,
        redirects: bool,
        exact_200: bool,
        repository: bool,
    ) -> Result<HttpResponse, FetchError> {
        tokio::time::timeout(FETCH_DEADLINE, async {
            let mut destination = url.clone();
            let mut hops = 0;
            loop {
                let addresses = self.destination(&destination).await?;
                let response = if repository {
                    self.transport
                        .fetch_repository(&destination, &addresses)
                        .await?
                } else {
                    self.transport.fetch(&destination, &addresses).await?
                };
                let maximum = if repository {
                    MAX_REPOSITORY_BYTES
                } else {
                    MAX_METADATA_BYTES
                };
                if response.body.len() > maximum {
                    return Err(FetchError::BodyTooLarge);
                }
                if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
                    if !redirects {
                        return Err(FetchError::RedirectForbidden);
                    }
                    if hops == MAX_REDIRECTS {
                        return Err(FetchError::TooManyRedirects);
                    }
                    let location = response
                        .headers
                        .get("location")
                        .ok_or(FetchError::InvalidRedirect)?;
                    destination = destination
                        .join(location)
                        .map_err(|_| FetchError::InvalidRedirect)?;
                    hops += 1;
                    continue;
                }
                if (exact_200 && response.status != 200) || !(200..300).contains(&response.status) {
                    return Err(FetchError::HttpStatus(response.status));
                }
                return Ok(response);
            }
        })
        .await
        .map_err(|_| FetchError::Timeout)?
    }

    /// Validate all answers before handing pinned addresses to the transport.
    pub async fn destination(&self, url: &Url) -> Result<Vec<SocketAddr>, FetchError> {
        validate_https_url(url)?;
        let ips = match url.host().ok_or(FetchError::UnsafeDestination)? {
            Host::Ipv4(ip) => vec![IpAddr::V4(ip)],
            Host::Ipv6(ip) => vec![IpAddr::V6(ip)],
            Host::Domain(host) => tokio::time::timeout(FETCH_DEADLINE, self.resolver.resolve(host))
                .await
                .map_err(|_| FetchError::Timeout)??,
        };
        if ips.is_empty() || ips.iter().any(|ip| !public_ip(*ip)) {
            return Err(FetchError::UnsafeDestination);
        }
        let port = url
            .port_or_known_default()
            .ok_or(FetchError::UnsafeDestination)?;
        Ok(ips
            .into_iter()
            .map(|ip| SocketAddr::new(ip, port))
            .collect())
    }
}

pub fn validate_https_url(url: &Url) -> Result<(), FetchError> {
    if url.scheme() != "https"
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(FetchError::UnsafeDestination);
    }
    Ok(())
}

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
        || (a == 198 && ((b == 18 || b == 19) || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = ip.segments();
    // Only global-unicast addresses, excluding protocol-special, documentation,
    // and 6to4 ranges. This also denies local, mapped-private, and NAT64 routes.
    (s[0] & 0xe000) == 0x2000
        && !(s[0] == 0x2001 && (s[1] <= 0x01ff || s[1] == 0x0db8))
        && s[0] != 0x2002
        && !(s[0] == 0x3fff && s[1] <= 0x0fff)
}
