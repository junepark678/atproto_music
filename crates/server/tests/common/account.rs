//! Account tests drive the real OAuth and HTTP routes and signed repository boundary.
#![allow(dead_code)]
#[path = "../../../atproto/tests/support/oauth_pds.rs"]
mod oauth_pds;
#[path = "../../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
use async_trait::async_trait;
use atmusic_atproto::{
    oauth::{
        service::{OAuthConfig, OAuthService},
        token_store::TokenStore,
    },
    sync::{
        apply::{ApplyContext, apply_commit},
        backfill::{
            BackfillCoordinator, BackfillError, FetchedSnapshot, ReceiptClock, SnapshotSource,
        },
    },
};
use atmusic_core::namespace::Namespace;
use atmusic_server::Clock;
use chrono::{DateTime, Utc};
pub use oauth_pds::{ALICE, BOB, NOW};
use serde_json::{Value, json};
pub use signed_repo::{SignedFixture, signed_repo_for};
use std::sync::Arc;

pub const PATH: &str = "com.example.atmusic.scrobble/3m4zm2ufr2222";
pub struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
impl ReceiptClock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
pub fn now() -> DateTime<Utc> {
    DateTime::from_timestamp(NOW, 0).unwrap()
}
pub fn record() -> Value {
    json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","album":"Homogenic","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T11:00:00Z"})
}
pub async fn signed() -> SignedFixture {
    signed_repo_for(ALICE, vec![(PATH.into(), record())], 1, "3m4zm2ufr2222").await
}
pub struct AccountHarness {
    pub server: crate::common::TestServer,
    pub fixture: oauth_pds::ControlledPds,
    pub oauth: Arc<OAuthService>,
    pub client: reqwest::Client,
}
pub struct Login {
    pub cookie: String,
    pub csrf: String,
}
impl AccountHarness {
    pub async fn seed_read_fixture(&self) {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../tests/fixtures/read_models.json"))
                .unwrap();
        for (did, seed) in [
            (ALICE, 1),
            (BOB, 2),
            ("did:plc:cccccccccccccccccccccccc", 3),
        ] {
            self.server
                .database
                .repositories()
                .upsert_user(atmusic_storage::User::new(did, "2025-01-01T00:00:00Z"))
                .await
                .unwrap();
            let mut records: Vec<_> = fixture["scrobbles"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["owner"] == did && row["state"] == "confirmed")
                .map(|row| {
                    (
                        format!(
                            "com.example.atmusic.scrobble/{}",
                            row["rkey"].as_str().unwrap()
                        ),
                        row["record"].clone(),
                    )
                })
                .collect();
            if did == ALICE {
                records.push((format!("com.example.atmusic.follow/{}",atmusic_core::follow::follow_rkey(BOB).unwrap()),json!({"$type":"com.example.atmusic.follow","subject":BOB,"createdAt":"2025-01-01T00:00:00Z"})));
            }
            let signed = signed_repo_for(did, records, seed, "3m3ijqc2abc22").await;
            self.apply(&signed, &format!("export-fixture:{did}")).await;
        }
    }
    pub async fn new() -> Self {
        Self::new_with_relay(None).await
    }
    pub async fn new_with_relay(relay: Option<&str>) -> Self {
        let fixture = oauth_pds::ControlledPds::start().await;
        let client = fixture.client();
        let relay = relay.map(|relay| url::Url::parse(relay).unwrap());
        let server =
            crate::common::TestServer::start_with_state(Arc::new(FixedClock), move |mut state| {
                if relay.is_some() {
                    let mut config = state.config.as_ref().unwrap().as_ref().clone();
                    config.relay_url = relay;
                    state.config = Some(Arc::new(config));
                }
                let config = state.config.as_ref().unwrap();
                let store = TokenStore::new(
                    state.database.as_ref().unwrap().repositories(),
                    config.encryption_key(),
                )
                .unwrap();
                let oauth = OAuthService::new(
                    client,
                    store,
                    OAuthConfig::new(&config.public_origin, vec!["atproto".into()]).unwrap(),
                );
                state.with_oauth(Arc::new(oauth))
            })
            .await;
        let oauth = server.state.oauth.as_ref().unwrap().clone();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            server,
            fixture,
            oauth,
            client,
        }
    }
    pub async fn sign_in(&self, handle: &str) -> Login {
        let response = self
            .client
            .post(self.server.url("/api/v1/auth/start"))
            .header("origin", "https://music.example")
            .json(&json!({"handle":handle}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let value: Value = response.json().await.unwrap();
        let (code, state, issuer) = self
            .fixture
            .authorize(value["authorizationUrl"].as_str().unwrap())
            .await;
        let response = self
            .client
            .get(self.server.url("/api/v1/auth/callback"))
            .query(&[("code", code), ("state", state), ("iss", issuer)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 303);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let response = self
            .client
            .get(self.server.url("/api/v1/auth/session"))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let value: Value = response.json().await.unwrap();
        Login {
            cookie,
            csrf: value["csrfToken"].as_str().unwrap().into(),
        }
    }
    pub async fn apply(&self, fixture: &SignedFixture, relay: &str) {
        let result = apply_commit(
            &self.server.database.repositories(),
            &fixture.event,
            ApplyContext {
                relay,
                expected_did: &fixture.event.did,
                namespace: &Namespace::new("com.example.atmusic").unwrap(),
                receipt_time: now(),
                resolver: &signed_repo::FixtureResolver(fixture.key.clone()),
            },
        )
        .await
        .unwrap();
        assert!(result.applied);
        assert!(result.excluded.is_empty());
    }
    pub async fn recover(&self, fixture: &SignedFixture) {
        let coordinator = Arc::new(BackfillCoordinator::new(
            self.server.database.repositories(),
            Namespace::new("com.example.atmusic").unwrap(),
            Arc::new(OwnedSnapshot(fixture.event.blocks.clone())),
            Arc::new(signed_repo::FixtureResolver(fixture.key.clone())),
            Arc::new(FixedClock),
        ));
        let results = coordinator.run_batch().await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].did, ALICE);
        assert_eq!(
            results[0].result.as_ref().unwrap(),
            &atmusic_storage::SnapshotOutcome::Complete
        );
    }
    pub async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(self.server.database.reader_pool())
            .await
            .unwrap()
    }
    pub fn remote_counts(&self) -> (usize, usize, usize, usize, usize) {
        let state = self.fixture.state.lock().unwrap();
        (
            state.par_calls,
            state.token_calls,
            state.refresh_calls,
            state.revocation_calls,
            state.proofs.len(),
        )
    }
    pub async fn disconnect(&self, login: &Login) -> reqwest::Response {
        self.client
            .delete(self.server.url("/api/v1/account/local-data"))
            .header("cookie", &login.cookie)
            .header("origin", "https://music.example")
            .header("x-csrf-token", &login.csrf)
            .send()
            .await
            .unwrap()
    }
}
struct OwnedSnapshot(Vec<u8>);
#[async_trait]
impl SnapshotSource for OwnedSnapshot {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        assert_eq!(did, ALICE);
        Ok(FetchedSnapshot {
            pds: "https://pds.fixture.test".into(),
            bytes: self.0.clone(),
        })
    }
}
