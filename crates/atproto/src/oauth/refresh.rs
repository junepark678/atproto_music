use url::Url;

use super::{
    callback::TokenResponse,
    service::{OAuthError, OAuthService, TokenMaterial},
    token_store::RefreshFailure,
};

impl OAuthService {
    pub async fn refresh(&self, did: &str, now: i64) -> Result<TokenMaterial, OAuthError> {
        let material = self
            .store
            .fresh_tokens(did, now, |payload| async {
                self.rotate(payload, now).await
            })
            .await
            .map_err(|_| OAuthError::Storage)?
            .ok_or(OAuthError::InvalidState)?;
        serde_json::from_value(material).map_err(|_| OAuthError::Storage)
    }

    async fn rotate(
        &self,
        payload: serde_json::Value,
        now: i64,
    ) -> Result<serde_json::Value, RefreshFailure> {
        let mut material: TokenMaterial =
            serde_json::from_value(payload).map_err(|_| RefreshFailure::Failed)?;
        let authority = self
            .resolve_authority(&material.did, &material.issuer)
            .await
            .map_err(|_| RefreshFailure::Failed)?;
        material.pds = authority.pds.to_string();
        material.token_endpoint = authority.token_endpoint.to_string();
        material.revocation_endpoint = authority.revocation_endpoint.map(|url| url.to_string());
        let refresh = material
            .refresh_token
            .as_ref()
            .ok_or(RefreshFailure::InvalidGrant)?;
        let request = Self::form_request(
            Url::parse(&material.token_endpoint).map_err(|_| RefreshFailure::Failed)?,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", self.config.client_id.as_str()),
                ("refresh_token", refresh),
            ],
        );
        let response = self
            .dpop_send(
                request,
                &material.dpop_private_pem,
                &mut material.authorization_nonce,
                None,
                now,
            )
            .await
            .map_err(|_| RefreshFailure::Failed)?;
        if response.status == 400
            && serde_json::from_slice::<serde_json::Value>(&response.body)
                .ok()
                .is_some_and(|value| value["error"] == "invalid_grant")
        {
            return Err(RefreshFailure::InvalidGrant);
        }
        let token: TokenResponse =
            Self::response_json(&response, 200).map_err(|_| RefreshFailure::Failed)?;
        if token.sub != material.did {
            return Err(RefreshFailure::Failed);
        }
        self.verify_token(&token, &material.scopes, &material.issuer)
            .await
            .map_err(|_| RefreshFailure::Failed)?;
        material.expires_at = now
            .checked_add(i64::try_from(token.expires_in).map_err(|_| RefreshFailure::Failed)?)
            .ok_or(RefreshFailure::Failed)?;
        material.access_token = token.access_token;
        material.refresh_token = token.refresh_token.or(material.refresh_token);
        material.scopes = token.scope.split_whitespace().map(str::to_owned).collect();
        serde_json::to_value(material).map_err(|_| RefreshFailure::Failed)
    }
}
