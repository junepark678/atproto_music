mod common;

use std::{
    collections::BTreeMap,
    io::Write,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
};

use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{
        DnsResolver, FetchError, HttpRequest, HttpResponse, HttpTransport, SafeClient,
    },
    oauth::{
        service::{OAuthConfig, OAuthService, TokenMaterial},
        token_store::TokenStore,
    },
};
use atmusic_server::{Clock, auth::session};
use chrono::{DateTime, Utc};
use url::Url;

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

struct PublicDns;
#[async_trait]
impl DnsResolver for PublicDns {
    async fn resolve(&self, _: &str) -> Result<Vec<IpAddr>, FetchError> {
        Ok(vec!["93.184.216.34".parse().unwrap()])
    }
    async fn txt(&self, _: &str) -> Result<Vec<String>, FetchError> {
        Ok(vec![])
    }
}

struct RevokeTransport {
    calls: Mutex<Vec<HttpRequest>>,
}
#[async_trait]
impl HttpTransport for RevokeTransport {
    async fn fetch(&self, _: &Url, _: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        panic!("logout must not invent metadata or record fetches")
    }
    async fn send(
        &self,
        request: &HttpRequest,
        addresses: &[SocketAddr],
    ) -> Result<HttpResponse, FetchError> {
        assert_eq!(
            addresses,
            ["93.184.216.34:443".parse::<SocketAddr>().unwrap()]
        );
        self.calls.lock().unwrap().push(request.clone());
        Ok(HttpResponse {
            status: 500,
            headers: BTreeMap::from([("dpop-nonce".into(), "fixture-revoke-nonce".into())]),
            body: br#"{"error":"server_error"}"#.to_vec(),
        })
    }
}

struct Capture(Arc<Mutex<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn captured_logs() -> Arc<Mutex<Vec<u8>>> {
    static LOGS: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
    LOGS.get_or_init(|| {
        let logs = Arc::new(Mutex::new(vec![]));
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .without_time()
            .with_ansi(false)
            .with_writer(move || Capture(writer.clone()))
            .finish();
        tracing::subscriber::set_global_default(subscriber).unwrap();
        logs
    })
    .clone()
}

async fn check_logout(endpoint: Option<&str>) {
    let logs = captured_logs();
    let now = DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let transport = Arc::new(RevokeTransport {
        calls: Mutex::new(vec![]),
    });
    let configured_transport = transport.clone();
    let server = common::TestServer::start_with_state(Arc::new(FixedClock(now)), move |state| {
        let client = SafeClient::new(Arc::new(PublicDns), configured_transport);
        let config = state.config.as_ref().unwrap();
        let store = TokenStore::new(
            state.database.as_ref().unwrap().repositories(),
            config.encryption_key(),
        )
        .unwrap();
        let service = OAuthService::new(
            client,
            store,
            OAuthConfig::new(&config.public_origin, vec!["atproto".into()]).unwrap(),
        );
        state.with_oauth(Arc::new(service))
    })
    .await;
    let did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    let material = TokenMaterial {
        did: did.into(),
        issuer: "https://authorization.test".into(),
        pds: "https://pds.test".into(),
        token_endpoint: "https://authorization.test/token".into(),
        revocation_endpoint: endpoint.map(str::to_owned),
        scopes: vec!["atproto".into()],
        access_token: "do-not-log-access-token".into(),
        refresh_token: Some("do-not-log-refresh-token".into()),
        expires_at: now.timestamp() + 3600,
        dpop_private_pem: include_str!("../../../tests/fixtures/oauth/dpop_private.pem").into(),
        authorization_nonce: None,
        resource_nonce: None,
    };
    let oauth = server.state.oauth.as_ref().unwrap();
    oauth
        .token_store()
        .put_oauth_tokens(
            did,
            &serde_json::to_value(&material).unwrap(),
            now.timestamp(),
        )
        .await
        .unwrap();
    let key = server.state.config.as_ref().unwrap().encryption_key();
    let issued = session::issue(&server.database, key, did, now)
        .await
        .unwrap();
    let _other_device = session::issue(&server.database, key, did, now)
        .await
        .unwrap();
    let cookie = issued.cookie.split(';').next().unwrap();

    // A rejected Origin leaves both sessions and encrypted OAuth material intact,
    // and never reaches the remote revocation boundary.
    let rejected = server
        .client
        .post(server.url("/api/v1/auth/logout"))
        .header("cookie", cookie)
        .header("origin", "https://attacker.example")
        .header("x-csrf-token", &issued.csrf_token)
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 403);
    assert_eq!(transport.calls.lock().unwrap().len(), 0);
    assert!(
        oauth
            .token_store()
            .get_oauth_tokens(did)
            .await
            .unwrap()
            .is_some()
    );
    let sessions = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(sessions, 2);

    let response = server
        .client
        .post(server.url("/api/v1/auth/logout"))
        .header("cookie", cookie)
        .header("origin", "https://music.example")
        .header("x-csrf-token", &issued.csrf_token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(response.bytes().await.unwrap().is_empty());
    assert!(
        oauth
            .token_store()
            .get_oauth_tokens(did)
            .await
            .unwrap()
            .is_none()
    );
    let sessions = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(
        sessions, 0,
        "all sessions relying on revoked material must become invalid"
    );
    let response = server
        .client
        .get(server.url("/api/v1/auth/session"))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    {
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), usize::from(endpoint.is_some()));
        if let Some(endpoint) = endpoint {
            assert_eq!(calls[0].url.as_str(), endpoint);
            assert_eq!(calls[0].method, "POST");
            assert!(
                calls[0]
                    .headers
                    .get("dpop")
                    .is_some_and(|proof| proof.split('.').count() == 3)
            );
            let form = url::form_urlencoded::parse(&calls[0].body)
                .into_owned()
                .collect::<BTreeMap<_, _>>();
            assert_eq!(
                form["client_id"],
                "https://music.example/oauth/client-metadata.json"
            );
            assert_eq!(form["token"], "do-not-log-refresh-token");
        }
    }
    let log = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
    if endpoint.is_some() {
        assert!(
            log.contains("revocation_failed"),
            "log capture must observe the real failure path"
        );
    }
    assert!(!log.contains("do-not-log-access-token"));
    assert!(!log.contains("do-not-log-refresh-token"));
    assert!(!log.contains("PRIVATE KEY"));
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn revocation_outage() {
    check_logout(Some("https://authorization.test/revoke")).await;
}

#[tokio::test]
async fn unsupported_revocation() {
    check_logout(None).await;
}
