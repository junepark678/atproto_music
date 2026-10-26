use oauth2::{PkceCodeChallenge, PkceCodeVerifier};
use serde::Deserialize;

use super::service::{OAuthError, OAuthService, PendingAuthorization};

impl OAuthService {
    pub async fn start(&self, identifier: &str, now: i64) -> Result<String, OAuthError> {
        let identity = self.identity.resolve(identifier).await?;
        let discovery = self
            .discovery
            .discover(&identity, &self.config.client_id, &self.config.callback)
            .await?;
        let verifier = PkceCodeVerifier::new(self.nonce());
        let challenge = PkceCodeChallenge::from_code_verifier_sha256(&verifier);
        let state = self.nonce();
        let mut pending = PendingAuthorization {
            expected_did: identity.did,
            issuer: discovery.metadata.issuer,
            pds: identity.pds.to_string(),
            token_endpoint: discovery.token_endpoint.to_string(),
            revocation_endpoint: discovery.revocation_endpoint.map(|url| url.to_string()),
            client_id: self.config.client_id.to_string(),
            callback: self.config.callback.to_string(),
            scopes: self.config.scopes.clone(),
            pkce_verifier: verifier.secret().clone(),
            dpop_private_pem: self.private_key()?,
            dpop_nonce: None,
            created_at: now,
        };
        let payload = serde_json::to_value(&pending).map_err(|_| OAuthError::Storage)?;
        self.store
            .put_oauth_state(&state, &payload, now)
            .await
            .map_err(|_| OAuthError::Storage)?;
        let scopes = self.config.scopes.join(" ");
        let request = Self::form_request(
            discovery.par_endpoint,
            &[
                ("client_id", self.config.client_id.as_str()),
                ("response_type", "code"),
                ("redirect_uri", self.config.callback.as_str()),
                ("scope", &scopes),
                ("state", &state),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("login_hint", identifier),
            ],
        );
        #[derive(Deserialize)]
        struct Par {
            request_uri: String,
            expires_in: u64,
        }
        let result = async {
            let response = self
                .dpop_send(
                    request,
                    &pending.dpop_private_pem,
                    &mut pending.dpop_nonce,
                    None,
                    now,
                )
                .await?;
            let par: Par = Self::response_json(&response, 201)?;
            if !par
                .request_uri
                .starts_with("urn:ietf:params:oauth:request_uri:")
                || par.expires_in == 0
            {
                return Err(OAuthError::InvalidResponse);
            }
            // Persist the authorization-server nonce returned by PAR so the
            // token exchange begins with the current server nonce.
            if !self
                .store
                .update_oauth_state(
                    &state,
                    &serde_json::to_value(&pending).map_err(|_| OAuthError::Storage)?,
                )
                .await
                .map_err(|_| OAuthError::Storage)?
            {
                return Err(OAuthError::InvalidState);
            }
            let mut authorization = discovery.authorization_endpoint;
            authorization
                .query_pairs_mut()
                .append_pair("client_id", self.config.client_id.as_str())
                .append_pair("request_uri", &par.request_uri);
            Ok(authorization.to_string())
        }
        .await;
        if result.is_err() {
            self.store
                .consume_oauth_state(&state, now)
                .await
                .map_err(|_| OAuthError::Storage)?;
        }
        result
    }
}
