//! AT identity resolution following https://atproto.com/specs/{did,handle}.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

use crate::http::safe_client::{FetchError, SafeClient, validate_https_url};

pub const IDENTITY_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum IdentityError {
    #[error("invalid_handle")]
    InvalidHandle,
    #[error("unsupported_or_invalid_did")]
    InvalidDid,
    #[error("handle_not_found")]
    HandleNotFound,
    #[error("ambiguous_handle")]
    AmbiguousHandle,
    #[error("handle_mismatch")]
    HandleMismatch,
    #[error("did_mismatch")]
    DidMismatch,
    #[error("invalid_did_document")]
    InvalidDocument,
    #[error("invalid_pds_service")]
    InvalidPds,
    #[error(transparent)]
    Fetch(#[from] FetchError),
}

/// Cache time is monotonic in production and independently advanceable in tests.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
}

pub struct MonotonicClock(Instant);

impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}

impl Clock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Identity {
    pub did: String,
    pub handle: Option<String>,
    pub verified: bool,
    /// A canonical origin URL, never an unvalidated arbitrary service value.
    pub pds: Url,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidDocument {
    pub id: String,
    #[serde(default)]
    pub also_known_as: Vec<String>,
    #[serde(default)]
    pub service: Vec<DidService>,
    #[serde(default)]
    pub verification_method: Vec<VerificationMethod>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidService {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub service_endpoint: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationMethod {
    pub id: String,
    pub controller: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub public_key_multibase: Option<String>,
}

struct CachedIdentity {
    expires: Duration,
    identity: Identity,
}

#[derive(Clone)]
pub struct IdentityResolver {
    client: SafeClient,
    clock: Arc<dyn Clock>,
    cache: Arc<Mutex<HashMap<String, CachedIdentity>>>,
}

impl IdentityResolver {
    pub fn new(client: SafeClient) -> Self {
        Self::with_clock(client, Arc::new(MonotonicClock::default()))
    }

    pub fn with_clock(client: SafeClient, clock: Arc<dyn Clock>) -> Self {
        Self {
            client,
            clock,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn resolve(&self, identifier: &str) -> Result<Identity, IdentityError> {
        let is_did = identifier.starts_with("did:");
        let key = if is_did {
            validate_did(identifier)?;
            identifier.to_owned()
        } else {
            normalize_handle(identifier)?
        };
        let now = self.clock.now();
        if let Some(identity) = self
            .cache
            .lock()
            .expect("identity cache poisoned")
            .get(&key)
            .filter(|entry| now < entry.expires)
            .map(|entry| entry.identity.clone())
        {
            return Ok(identity);
        }
        let did = if is_did {
            key.clone()
        } else {
            self.handle_did(&key).await?
        };
        let document = self.document(&did).await?;
        let pds = document.pds()?;
        let claimed = document.claimed_handle();
        let (handle, verified) = if is_did {
            match claimed {
                Some(handle)
                    if self
                        .handle_did(&handle)
                        .await
                        .is_ok_and(|resolved| resolved == did) =>
                {
                    (Some(handle), true)
                }
                _ => (None, false),
            }
        } else {
            if claimed.as_deref() != Some(key.as_str()) {
                return Err(IdentityError::HandleMismatch);
            }
            (Some(key.clone()), true)
        };
        let identity = Identity {
            did,
            handle,
            verified,
            pds,
        };
        let mut cache = self.cache.lock().expect("identity cache poisoned");
        cache.retain(|_, entry| now < entry.expires);
        // Bound attacker-driven handle/DID growth without a global background task.
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(
            key,
            CachedIdentity {
                expires: self.clock.now() + IDENTITY_CACHE_TTL,
                identity: identity.clone(),
            },
        );
        Ok(identity)
    }

    pub async fn document(&self, did: &str) -> Result<DidDocument, IdentityError> {
        let url = did_document_url(did)?;
        let response = self.client.get(&url).await?;
        let document: DidDocument =
            serde_json::from_slice(&response.body).map_err(|_| IdentityError::InvalidDocument)?;
        if document.id != did {
            return Err(IdentityError::DidMismatch);
        }
        Ok(document)
    }

    async fn handle_did(&self, handle: &str) -> Result<String, IdentityError> {
        // Long handles cannot fit the additional DNS label; HTTPS still works.
        if handle.len() + "_atproto.".len() <= 253
            && let Ok(records) = self.client.txt(&format!("_atproto.{handle}")).await
        {
            let dids: HashSet<_> = records
                .iter()
                .filter_map(|txt| txt.strip_prefix("did="))
                .filter(|did| validate_did(did).is_ok())
                .collect();
            if dids.len() > 1 {
                return Err(IdentityError::AmbiguousHandle);
            }
            if let Some(did) = dids.into_iter().next() {
                return Ok(did.to_owned());
            }
        }
        let url = Url::parse(&format!("https://{handle}/.well-known/atproto-did"))
            .map_err(|_| IdentityError::InvalidHandle)?;
        let response = self.client.get(&url).await?;
        if !response.headers.get("content-type").is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/plain"))
        }) {
            return Err(IdentityError::Fetch(FetchError::ContentType));
        }
        let did = std::str::from_utf8(&response.body)
            .map_err(|_| IdentityError::HandleNotFound)?
            .trim();
        validate_did(did)?;
        Ok(did.to_owned())
    }
}

impl DidDocument {
    pub fn claimed_handle(&self) -> Option<String> {
        self.also_known_as
            .iter()
            .filter_map(|alias| alias.strip_prefix("at://"))
            .find_map(|handle| normalize_handle(handle).ok())
    }

    pub fn pds(&self) -> Result<Url, IdentityError> {
        let service = self
            .service
            .iter()
            .find(|service| {
                (service.id == "#atproto_pds" || service.id == format!("{}#atproto_pds", self.id))
                    && service.kind == "AtprotoPersonalDataServer"
            })
            .ok_or(IdentityError::InvalidPds)?;
        let endpoint = service
            .service_endpoint
            .as_str()
            .ok_or(IdentityError::InvalidPds)?;
        origin_url(endpoint).map_err(|_| IdentityError::InvalidPds)
    }
}

pub fn normalize_handle(handle: &str) -> Result<String, IdentityError> {
    if !handle.is_ascii() || handle.len() > 253 {
        return Err(IdentityError::InvalidHandle);
    }
    let labels: Vec<_> = handle.split('.').collect();
    if labels.len() < 2
        || !labels.last().is_some_and(|label| {
            label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
        })
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return Err(IdentityError::InvalidHandle);
    }
    Ok(handle.to_ascii_lowercase())
}

pub fn validate_did(did: &str) -> Result<(), IdentityError> {
    if did.len() > 2048 {
        return Err(IdentityError::InvalidDid);
    }
    if let Some(identifier) = did.strip_prefix("did:plc:") {
        if identifier.len() == 24
            && identifier
                .bytes()
                .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c))
        {
            return Ok(());
        }
    } else if let Some(host) = did.strip_prefix("did:web:") {
        // AT supports only hostname-level did:web; paths and encoded ports are
        // development exceptions, deliberately absent from production policy.
        if normalize_handle(host).is_ok() {
            return Ok(());
        }
    }
    Err(IdentityError::InvalidDid)
}

pub fn did_document_url(did: &str) -> Result<Url, IdentityError> {
    validate_did(did)?;
    let endpoint = if let Some(host) = did.strip_prefix("did:web:") {
        format!("https://{host}/.well-known/did.json")
    } else {
        format!("https://plc.directory/{did}")
    };
    Url::parse(&endpoint).map_err(|_| IdentityError::InvalidDid)
}

/// AT PDS and issuer locations are origins, not arbitrary endpoint URLs.
pub fn origin_url(value: &str) -> Result<Url, FetchError> {
    let url = Url::parse(value).map_err(|_| FetchError::UnsafeDestination)?;
    validate_https_url(&url)?;
    if url.path() != "/" || url.query().is_some() {
        return Err(FetchError::UnsafeDestination);
    }
    // URL parsers erase explicit default ports, but AT OAuth forbids them.
    let authority = value
        .strip_prefix("https://")
        .ok_or(FetchError::UnsafeDestination)?
        .split('/')
        .next()
        .ok_or(FetchError::UnsafeDestination)?;
    if authority.ends_with(":443") {
        return Err(FetchError::UnsafeDestination);
    }
    Ok(url)
}
