use serde::Deserialize;
use url::Url;

use super::service::{
    CallbackQuery, OAuthError, OAuthService, PendingAuthorization, TokenMaterial,
};
use crate::identity::Identity;

#[derive(Deserialize)]
pub(crate) struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub refresh_token: Option<String>,
    pub scope: String,
    pub expires_in: u64,
    pub sub: String,
}

impl OAuthService {
    pub async fn callback(
        &self,
        query: CallbackQuery,
        now: i64,
    ) -> Result<TokenMaterial, OAuthError> {
        if query.state.is_empty()
            || query.state.len() > 256
            || query.code.is_empty()
            || query.code.len() > 4096
        {
            return Err(OAuthError::InvalidState);
        }
        let payload = self
            .store
            .consume_oauth_state(&query.state, now)
            .await
            .map_err(|_| OAuthError::Storage)?
            .ok_or(OAuthError::InvalidState)?;
        let mut pending: PendingAuthorization =
            serde_json::from_value(payload).map_err(|_| OAuthError::Storage)?;
        if now < pending.created_at || now - pending.created_at >= 300 {
            return Err(OAuthError::InvalidState);
        }
        if query.iss != pending.issuer {
            return Err(OAuthError::IssuerMismatch);
        }
        let request = Self::form_request(
            Url::parse(&pending.token_endpoint).map_err(|_| OAuthError::Configuration)?,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &pending.client_id),
                ("redirect_uri", &pending.callback),
                ("code", &query.code),
                ("code_verifier", &pending.pkce_verifier),
            ],
        );
        let response = self
            .dpop_send(
                request,
                &pending.dpop_private_pem,
                &mut pending.dpop_nonce,
                None,
                now,
            )
            .await?;
        let token: TokenResponse = Self::response_json(&response, 200)?;
        if token.sub != pending.expected_did {
            return Err(OAuthError::SubjectMismatch);
        }
        let authority = self
            .verify_token(&token, &pending.scopes, &pending.issuer)
            .await?;
        let expires_at = now
            .checked_add(i64::try_from(token.expires_in).map_err(|_| OAuthError::InvalidResponse)?)
            .ok_or(OAuthError::InvalidResponse)?;
        let material = TokenMaterial {
            did: token.sub,
            issuer: pending.issuer,
            pds: authority.pds.to_string(),
            token_endpoint: authority.token_endpoint.to_string(),
            revocation_endpoint: authority.revocation_endpoint.map(|url| url.to_string()),
            scopes: token.scope.split_whitespace().map(str::to_owned).collect(),
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at,
            dpop_private_pem: pending.dpop_private_pem,
            authorization_nonce: pending.dpop_nonce,
            resource_nonce: None,
        };
        self.store
            .put_authorized_oauth_tokens(
                &material.did,
                &serde_json::to_value(&material).map_err(|_| OAuthError::Storage)?,
                now,
            )
            .await
            .map_err(|_| OAuthError::Storage)?;
        Ok(material)
    }

    pub(crate) async fn verify_token(
        &self,
        token: &TokenResponse,
        required_scopes: &[String],
        issuer: &str,
    ) -> Result<super::discovery::DiscoveredOAuth, OAuthError> {
        if !token.token_type.eq_ignore_ascii_case("DPoP")
            || token.access_token.is_empty()
            || token.expires_in == 0
        {
            return Err(OAuthError::InvalidResponse);
        }
        let granted: Vec<_> = token.scope.split_whitespace().collect();
        if !required_scopes
            .iter()
            .all(|scope| granted.contains(&scope.as_str()))
        {
            return Err(OAuthError::ScopeMismatch);
        }
        self.resolve_authority(&token.sub, issuer).await
    }

    pub(crate) async fn resolve_authority(
        &self,
        did: &str,
        issuer: &str,
    ) -> Result<super::discovery::DiscoveredOAuth, OAuthError> {
        // Re-resolve independently of sign-in caches: a token is not identity
        // evidence without this fresh DID/PDS/issuer chain.
        let document = self.identity.document(did).await?;
        let identity = Identity {
            did: did.to_owned(),
            handle: None,
            verified: false,
            pds: document.pds()?,
        };
        let discovery = self
            .discovery
            .discover(&identity, &self.config.client_id, &self.config.callback)
            .await?;
        if discovery.metadata.issuer != issuer {
            return Err(OAuthError::IssuerMismatch);
        }
        Ok(discovery)
    }
}
