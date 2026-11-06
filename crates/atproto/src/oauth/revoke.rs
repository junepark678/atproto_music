use url::Url;

use super::{
    service::{OAuthError, OAuthService, TokenMaterial},
    token_store::TokenStoreError,
};

impl OAuthService {
    /// Serialize revocation against refresh, and always invalidate local token
    /// material and application sessions after the upstream attempt.
    pub async fn revoke(&self, did: &str, now: i64) -> Result<(), OAuthError> {
        self.store
            .revoke_tokens(did, |payload| async {
                let mut material: TokenMaterial = serde_json::from_value(payload)
                    .map_err(|_| TokenStoreError::InvalidMaterial)?;
                let Some(endpoint) = material.revocation_endpoint else {
                    return Ok(());
                };
                let token = material
                    .refresh_token
                    .as_deref()
                    .unwrap_or(&material.access_token);
                let request = Self::form_request(
                    Url::parse(&endpoint).map_err(|_| TokenStoreError::InvalidMaterial)?,
                    &[
                        ("client_id", self.config.client_id.as_str()),
                        ("token", token),
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
                    .map_err(|_| TokenStoreError::RefreshFailed)?;
                if matches!(response.status, 200 | 204) {
                    Ok(())
                } else {
                    Err(TokenStoreError::RefreshFailed)
                }
            })
            .await
            .map_err(|_| OAuthError::Storage)
    }
}
