use std::{collections::BTreeMap, sync::Arc};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jwt_compact::{AlgorithmExt, Header, alg::Es256, jwk::JsonWebKey};
use p256::{
    SecretKey,
    ecdsa::SigningKey,
    pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use super::{
    discovery::{DiscoveryError, OAuthDiscovery, validate_client_callback},
    token_store::TokenStore,
};
use crate::{
    http::safe_client::{FetchError, HttpRequest, HttpResponse, SafeClient},
    identity::{IdentityError, IdentityResolver},
};

#[derive(Debug, Error)]
pub enum OAuthError {
    #[error("invalid_oauth_configuration")]
    Configuration,
    #[error("oauth_storage_unavailable")]
    Storage,
    #[error("invalid_or_expired_oauth_state")]
    InvalidState,
    #[error("issuer_mismatch")]
    IssuerMismatch,
    #[error("subject_mismatch")]
    SubjectMismatch,
    #[error("oauth_crypto_error")]
    Crypto,
    #[error("missing_dpop_nonce")]
    MissingNonce,
    #[error("dpop_nonce_retry_exhausted")]
    NonceExhausted,
    #[error("oauth_upstream_rejected")]
    UpstreamRejected,
    #[error("invalid_oauth_response")]
    InvalidResponse,
    #[error("oauth_scope_mismatch")]
    ScopeMismatch,
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Discovery(#[from] DiscoveryError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
}

#[derive(Clone)]
pub struct OAuthConfig {
    pub client_id: Url,
    pub callback: Url,
    pub scopes: Vec<String>,
}

impl OAuthConfig {
    pub fn new(public_origin: &Url, scopes: Vec<String>) -> Result<Self, OAuthError> {
        let client_id = public_origin
            .join("/oauth/client-metadata.json")
            .map_err(|_| OAuthError::Configuration)?;
        let callback = public_origin
            .join("/api/v1/auth/callback")
            .map_err(|_| OAuthError::Configuration)?;
        validate_client_callback(&client_id, &callback)?;
        if !scopes.iter().any(|scope| scope == "atproto")
            || scopes
                .iter()
                .any(|scope| scope.is_empty() || scope.chars().any(char::is_whitespace))
        {
            return Err(OAuthError::Configuration);
        }
        Ok(Self {
            client_id,
            callback,
            scopes,
        })
    }
}

/// Injected only as a typed boundary; production uses operating-system entropy.
pub trait Entropy: Send + Sync {
    fn bytes(&self) -> [u8; 32];
}

pub struct OsEntropy;
impl Entropy for OsEntropy {
    fn bytes(&self) -> [u8; 32] {
        let mut bytes = [0; 32];
        OsRng.fill_bytes(&mut bytes);
        bytes
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingAuthorization {
    pub expected_did: String,
    pub issuer: String,
    pub pds: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub client_id: String,
    pub callback: String,
    pub scopes: Vec<String>,
    pub pkce_verifier: String,
    pub dpop_private_pem: String,
    pub dpop_nonce: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TokenMaterial {
    pub did: String,
    pub issuer: String,
    pub pds: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub scopes: Vec<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub dpop_private_pem: String,
    pub authorization_nonce: Option<String>,
    pub resource_nonce: Option<String>,
}

impl std::fmt::Debug for TokenMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TokenMaterial")
            .field("did", &self.did)
            .field("issuer", &self.issuer)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallbackQuery {
    pub state: String,
    pub code: String,
    pub iss: String,
}

#[derive(Clone)]
pub struct OAuthService {
    pub(crate) client: SafeClient,
    pub(crate) identity: IdentityResolver,
    pub(crate) discovery: OAuthDiscovery,
    pub(crate) store: TokenStore,
    pub(crate) config: OAuthConfig,
    pub(crate) entropy: Arc<dyn Entropy>,
}

impl OAuthService {
    pub fn new(client: SafeClient, store: TokenStore, config: OAuthConfig) -> Self {
        Self {
            identity: IdentityResolver::new(client.clone()),
            discovery: OAuthDiscovery::new(client.clone()),
            client,
            store,
            config,
            entropy: Arc::new(OsEntropy),
        }
    }

    pub fn with_entropy(mut self, entropy: Arc<dyn Entropy>) -> Self {
        self.entropy = entropy;
        self
    }

    pub fn client(&self) -> &SafeClient {
        &self.client
    }
    pub fn token_store(&self) -> &TokenStore {
        &self.store
    }

    pub async fn resolve_identifier(
        &self,
        identifier: &str,
    ) -> Result<crate::identity::Identity, IdentityError> {
        self.identity.resolve(identifier).await
    }

    pub(crate) fn nonce(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.entropy.bytes())
    }

    pub(crate) fn private_key(&self) -> Result<String, OAuthError> {
        for _ in 0..16 {
            if let Ok(key) = SecretKey::from_slice(&self.entropy.bytes()) {
                return key
                    .to_pkcs8_pem(LineEnding::LF)
                    .map(|pem| pem.to_string())
                    .map_err(|_| OAuthError::Crypto);
            }
        }
        Err(OAuthError::Crypto)
    }

    pub(crate) fn proof(
        &self,
        request: &HttpRequest,
        private_pem: &str,
        nonce: &Option<String>,
        access_token: Option<&str>,
        now: i64,
    ) -> Result<String, OAuthError> {
        let key = SigningKey::from_pkcs8_pem(private_pem).map_err(|_| OAuthError::Crypto)?;
        let header = Header::new(serde_json::json!({"jwk": JsonWebKey::from(key.verifying_key())}))
            .with_token_type("dpop+jwt");
        let mut htu = request.url.clone();
        htu.set_query(None);
        htu.set_fragment(None);
        #[derive(Serialize)]
        struct Claims<'a> {
            jti: String,
            iat: i64,
            htm: &'a str,
            htu: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            nonce: &'a Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            ath: Option<String>,
        }
        let claims = Claims {
            jti: self.nonce(),
            iat: now,
            htm: &request.method,
            htu: htu.as_str(),
            nonce,
            ath: access_token.map(|token| URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))),
        };
        Es256
            .token(&header, &jwt_compact::Claims::new(claims), &key)
            .map_err(|_| OAuthError::Crypto)
    }

    pub(crate) async fn dpop_send(
        &self,
        mut request: HttpRequest,
        private_pem: &str,
        nonce: &mut Option<String>,
        access_token: Option<&str>,
        now: i64,
    ) -> Result<HttpResponse, OAuthError> {
        for attempt in 0..2 {
            request.headers.insert(
                "dpop".into(),
                self.proof(&request, private_pem, nonce, access_token, now)?,
            );
            let response = self.client.send(&request).await?;
            let fresh_nonce = response
                .headers
                .get("dpop-nonce")
                .filter(|value| !value.is_empty() && value.len() <= 1024 && value.is_ascii())
                .ok_or(OAuthError::MissingNonce)?;
            *nonce = Some(fresh_nonce.clone());
            let challenge = response.status == 400
                && serde_json::from_slice::<Value>(&response.body)
                    .ok()
                    .is_some_and(|body| body["error"] == "use_dpop_nonce")
                || response.status == 401
                    && response
                        .headers
                        .get("www-authenticate")
                        .is_some_and(|value| {
                            value.starts_with("DPoP") && value.contains("use_dpop_nonce")
                        });
            if challenge {
                if attempt == 1 {
                    return Err(OAuthError::NonceExhausted);
                }
                continue;
            }
            return Ok(response);
        }
        Err(OAuthError::NonceExhausted)
    }

    pub(crate) fn form_request(url: Url, fields: &[(&str, &str)]) -> HttpRequest {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish()
            .into_bytes();
        HttpRequest {
            url,
            method: "POST".into(),
            headers: BTreeMap::from([
                (
                    "content-type".into(),
                    "application/x-www-form-urlencoded".into(),
                ),
                ("accept".into(), "application/json".into()),
            ]),
            body,
        }
    }

    pub(crate) fn response_json<T: serde::de::DeserializeOwned>(
        response: &HttpResponse,
        expected_status: u16,
    ) -> Result<T, OAuthError> {
        if response.status != expected_status {
            return Err(OAuthError::UpstreamRejected);
        }
        if !response.headers.get("content-type").is_some_and(|header| {
            header
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        }) {
            return Err(OAuthError::InvalidResponse);
        }
        serde_json::from_slice(&response.body).map_err(|_| OAuthError::InvalidResponse)
    }
}
