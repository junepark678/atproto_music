//! AT OAuth discovery and compatibility checks.
//!
//! Profile reference: https://atproto.com/specs/oauth (retrieved 2026-10-06).
//! Metadata is fetched with exact HTTP 200 JSON and no redirect acceptance.

use serde::Deserialize;
use thiserror::Error;
use url::Url;

use crate::{
    http::safe_client::{FetchError, SafeClient, validate_https_url},
    identity::{Identity, origin_url},
};

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    #[error("issuer_mismatch")]
    IssuerMismatch,
    #[error("unsupported_oauth_server")]
    UnsupportedOAuthServer,
    #[error("invalid_oauth_metadata")]
    InvalidMetadata,
    #[error("invalid_client_callback_origin")]
    InvalidClientOrigin,
    #[error(transparent)]
    Fetch(#[from] FetchError),
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProtectedResourceMetadata {
    pub resource: String,
    pub authorization_servers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthorizationServerMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub pushed_authorization_request_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    #[serde(default)]
    pub response_types_supported: Vec<String>,
    #[serde(default)]
    pub grant_types_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    pub token_endpoint_auth_signing_alg_values_supported: Vec<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub dpop_signing_alg_values_supported: Vec<String>,
    #[serde(default)]
    pub authorization_response_iss_parameter_supported: bool,
    #[serde(default)]
    pub require_pushed_authorization_requests: bool,
    #[serde(default)]
    pub client_id_metadata_document_supported: bool,
    pub require_request_uri_registration: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct DiscoveredOAuth {
    pub did: String,
    pub pds: Url,
    pub issuer: Url,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub par_endpoint: Url,
    pub revocation_endpoint: Option<Url>,
    pub metadata: AuthorizationServerMetadata,
}

#[derive(Clone)]
pub struct OAuthDiscovery {
    client: SafeClient,
}

impl OAuthDiscovery {
    pub fn new(client: SafeClient) -> Self {
        Self { client }
    }

    pub async fn discover(
        &self,
        identity: &Identity,
        client_id: &Url,
        callback: &Url,
    ) -> Result<DiscoveredOAuth, DiscoveryError> {
        validate_client_callback(client_id, callback)?;
        let pds = origin_url(identity.pds.as_str()).map_err(|_| DiscoveryError::InvalidMetadata)?;
        let protected_url = pds
            .join("/.well-known/oauth-protected-resource")
            .map_err(|_| DiscoveryError::InvalidMetadata)?;
        let resource: ProtectedResourceMetadata =
            serde_json::from_slice(&self.client.metadata(&protected_url).await?)
                .map_err(|_| DiscoveryError::InvalidMetadata)?;
        if origin_url(&resource.resource).map_err(|_| DiscoveryError::InvalidMetadata)? != pds {
            return Err(DiscoveryError::IssuerMismatch);
        }
        if resource.authorization_servers.len() != 1 {
            return Err(DiscoveryError::UnsupportedOAuthServer);
        }
        let issuer = origin_url(&resource.authorization_servers[0])
            .map_err(|_| DiscoveryError::InvalidMetadata)?;
        let metadata_url = issuer
            .join("/.well-known/oauth-authorization-server")
            .map_err(|_| DiscoveryError::InvalidMetadata)?;
        let metadata: AuthorizationServerMetadata =
            serde_json::from_slice(&self.client.metadata(&metadata_url).await?)
                .map_err(|_| DiscoveryError::InvalidMetadata)?;
        if metadata.issuer != resource.authorization_servers[0]
            || origin_url(&metadata.issuer).map_err(|_| DiscoveryError::IssuerMismatch)? != issuer
        {
            return Err(DiscoveryError::IssuerMismatch);
        }
        if !supported(&metadata) {
            return Err(DiscoveryError::UnsupportedOAuthServer);
        }
        let authorization_endpoint = self.endpoint(&metadata.authorization_endpoint).await?;
        let token_endpoint = self.endpoint(&metadata.token_endpoint).await?;
        let par_endpoint = self
            .endpoint(
                metadata
                    .pushed_authorization_request_endpoint
                    .as_deref()
                    .ok_or(DiscoveryError::UnsupportedOAuthServer)?,
            )
            .await?;
        let revocation_endpoint = match &metadata.revocation_endpoint {
            Some(endpoint) => Some(self.endpoint(endpoint).await?),
            None => None,
        };
        Ok(DiscoveredOAuth {
            did: identity.did.clone(),
            pds,
            issuer,
            authorization_endpoint,
            token_endpoint,
            par_endpoint,
            revocation_endpoint,
            metadata,
        })
    }

    async fn endpoint(&self, value: &str) -> Result<Url, DiscoveryError> {
        let url = Url::parse(value).map_err(|_| DiscoveryError::InvalidMetadata)?;
        self.client.destination(&url).await?;
        Ok(url)
    }
}

fn includes(values: &[String], expected: &str) -> bool {
    values.iter().any(|value| value == expected)
}

fn supported(m: &AuthorizationServerMetadata) -> bool {
    includes(&m.response_types_supported, "code")
        && includes(&m.grant_types_supported, "authorization_code")
        && includes(&m.grant_types_supported, "refresh_token")
        && includes(&m.code_challenge_methods_supported, "S256")
        && includes(&m.token_endpoint_auth_methods_supported, "none")
        && includes(&m.token_endpoint_auth_methods_supported, "private_key_jwt")
        && includes(&m.token_endpoint_auth_signing_alg_values_supported, "ES256")
        && !includes(&m.token_endpoint_auth_signing_alg_values_supported, "none")
        && includes(&m.scopes_supported, "atproto")
        && includes(&m.dpop_signing_alg_values_supported, "ES256")
        && m.authorization_response_iss_parameter_supported
        && m.require_pushed_authorization_requests
        && m.pushed_authorization_request_endpoint.is_some()
        && m.client_id_metadata_document_supported
        && m.require_request_uri_registration != Some(false)
}

pub fn validate_client_callback(client_id: &Url, callback: &Url) -> Result<(), DiscoveryError> {
    validate_https_url(client_id).map_err(|_| DiscoveryError::InvalidClientOrigin)?;
    validate_https_url(callback).map_err(|_| DiscoveryError::InvalidClientOrigin)?;
    if client_id.port().is_some()
        || client_id.query().is_some()
        || callback.query().is_some()
        || client_id.origin() != callback.origin()
    {
        return Err(DiscoveryError::InvalidClientOrigin);
    }
    Ok(())
}
