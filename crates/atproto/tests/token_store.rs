use atmusic_atproto::oauth::token_store::{RefreshFailure, TokenStore, TokenStoreError};
use atmusic_storage::{Database, Session, User};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Barrier,
};
const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const NOW: i64 = 1768478400;
struct Temp {
    dir: PathBuf,
    path: PathBuf,
}
impl Temp {
    fn new() -> Self {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("atmusic-token-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            path: dir.join("music.sqlite"),
            dir,
        }
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn material(access: &str, refresh: &str, expires: i64) -> Value {
    json!({"did":ALICE,"issuer":"https://issuer.test","access_token":access,"refresh_token":refresh,"dpop_private_pem":"SECRET-DPOP-PRIVATE-KEY","expires_at":expires})
}
async fn open_store(temp: &Temp) -> (Database, TokenStore) {
    let db = Database::open(&temp.path).await.unwrap();
    let store = TokenStore::new(db.repositories(), &[42; 32]).unwrap();
    (db, store)
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|s| s == needle.as_bytes())
}
#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}
#[tokio::test]
async fn encrypted_persistence() {
    let logs = LogCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let temp = Temp::new();
    let (db, store) = open_store(&temp).await;
    let payload = material("SECRET-ACCESS-TOKEN", "SECRET-REFRESH-TOKEN", NOW + 3600);
    store.put_oauth_tokens(ALICE, &payload, NOW).await.unwrap();
    let first = db
        .repositories()
        .oauth_tokens(ALICE)
        .await
        .unwrap()
        .unwrap()
        .encrypted_material;
    store.put_oauth_tokens(ALICE, &payload, NOW).await.unwrap();
    let second = db
        .repositories()
        .oauth_tokens(ALICE)
        .await
        .unwrap()
        .unwrap()
        .encrypted_material;
    assert_ne!(first, second, "each encryption write uses a fresh nonce");
    assert_eq!(
        store.get_oauth_tokens(ALICE).await.unwrap().unwrap(),
        payload
    );
    let wrong = TokenStore::new(db.repositories(), &[99; 32]).unwrap();
    assert!(matches!(
        wrong.get_oauth_tokens(ALICE).await,
        Err(TokenStoreError::Authentication)
    ));
    db.repositories()
        .upsert_user(User::new(BOB, "2026-01-15T12:00:00Z"))
        .await
        .unwrap();
    db.writer().execute(|c|Box::pin(async move{sqlx::query("INSERT INTO oauth_tokens(owner,encrypted_material,generation,expires_at) SELECT ?,encrypted_material,generation,expires_at FROM oauth_tokens WHERE owner=?").bind(BOB).bind(ALICE).execute(c).await?;Ok(())})).await.unwrap();
    assert!(matches!(
        store.get_oauth_tokens(BOB).await,
        Err(TokenStoreError::Authentication)
    ));
    for entry in std::fs::read_dir(&temp.dir).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        for secret in [
            "SECRET-ACCESS-TOKEN",
            "SECRET-REFRESH-TOKEN",
            "SECRET-DPOP-PRIVATE-KEY",
        ] {
            assert!(!contains(&bytes, secret));
        }
    }
    // Errors use fixed safe messages; material is never added to error/log text.
    let error = wrong.get_oauth_tokens(ALICE).await.err().unwrap();
    tracing::warn!(error=%error,"encrypted OAuth material rejected");
    for secret in [
        "SECRET-ACCESS-TOKEN",
        "SECRET-REFRESH-TOKEN",
        "SECRET-DPOP-PRIVATE-KEY",
    ] {
        assert!(!contains(&logs.0.lock().unwrap(), secret));
    }
    assert!(
        !logs.0.lock().unwrap().is_empty(),
        "scan actual captured logs"
    );
    let captured = format!("{error:?}\n{error}");
    for secret in [
        "SECRET-ACCESS-TOKEN",
        "SECRET-REFRESH-TOKEN",
        "SECRET-DPOP-PRIVATE-KEY",
    ] {
        assert!(!captured.contains(secret));
    }
    let state = json!({"expected_did":ALICE,"issuer":"https://issuer.test","pkce_verifier":"SECRET-PKCE","dpop_private_pem":"SECRET-STATE-KEY"});
    store
        .put_oauth_state("state-raw-secret", &state, NOW)
        .await
        .unwrap();
    assert_eq!(
        store
            .consume_oauth_state("state-raw-secret", NOW + 299)
            .await
            .unwrap(),
        Some(state)
    );
    assert!(
        store
            .consume_oauth_state("state-raw-secret", NOW + 299)
            .await
            .unwrap()
            .is_none()
    );
    store
        .put_oauth_state(
            "expired-state",
            &json!({"expected_did":ALICE,"issuer":"https://issuer.test"}),
            NOW,
        )
        .await
        .unwrap();
    assert!(
        store
            .consume_oauth_state("expired-state", NOW + 300)
            .await
            .unwrap()
            .is_none()
    );
    db.close().await;
}
struct RefreshFixture {
    url: String,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for RefreshFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl RefreshFixture {
    async fn start(expected_refresh: &str, rotated: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let task_calls = calls.clone();
        let expected = expected_refresh.to_owned();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0u8; 4096];
                    let count = socket.read(&mut bytes).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..count]);
                    if let Some(header_end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..header_end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= header_end + 4 + length {
                            break;
                        }
                    }
                }
                let split = request.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
                let payload: Value = serde_json::from_slice(&request[split + 4..]).unwrap();
                task_calls.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if payload["refresh_token"] == expected {
                    ("200 OK", rotated.to_string())
                } else {
                    (
                        "400 Bad Request",
                        json!({"error":"invalid_grant"}).to_string(),
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Self { url, calls, task }
    }
    async fn refresh(url: String, current: Value) -> Result<Value, RefreshFailure> {
        let response = reqwest::Client::new()
            .post(url)
            .json(&json!({"refresh_token":current["refresh_token"]}))
            .send()
            .await
            .map_err(|_| RefreshFailure::Failed)?;
        if response.status() == 400 {
            return Err(RefreshFailure::InvalidGrant);
        }
        response.json().await.map_err(|_| RefreshFailure::Failed)
    }
}
#[tokio::test]
async fn refresh_race() {
    let temp = Temp::new();
    let (db, store) = open_store(&temp).await;
    store
        .put_oauth_tokens(ALICE, &material("expired-access", "old-refresh", NOW), NOW)
        .await
        .unwrap();
    let fixture = RefreshFixture::start(
        "old-refresh",
        material("rotated-access", "rotated-refresh", NOW + 3600),
    )
    .await;
    let barrier = Arc::new(Barrier::new(11));
    let mut requests = Vec::new();
    for _ in 0..10 {
        let store = store.clone();
        let url = fixture.url.clone();
        let barrier = barrier.clone();
        requests.push(tokio::spawn(async move {
            barrier.wait().await;
            store
                .fresh_tokens(ALICE, NOW, move |current| {
                    RefreshFixture::refresh(url, current)
                })
                .await
                .unwrap()
                .unwrap()
        }));
    }
    barrier.wait().await;
    for request in requests {
        assert_eq!(request.await.unwrap()["access_token"], "rotated-access");
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.get_oauth_tokens(ALICE).await.unwrap().unwrap()["refresh_token"],
        "rotated-refresh"
    );
    db.close().await;
}
#[tokio::test]
async fn refresh_restart() {
    let temp = Temp::new();
    let (db, store) = open_store(&temp).await;
    store
        .put_oauth_tokens(ALICE, &material("old-access", "old-refresh", NOW), NOW)
        .await
        .unwrap();
    let fixture = RefreshFixture::start(
        "old-refresh",
        material("new-access", "new-refresh", NOW + 3600),
    )
    .await;
    store
        .fresh_tokens(ALICE, NOW, {
            let url = fixture.url.clone();
            move |current| RefreshFixture::refresh(url, current)
        })
        .await
        .unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    db.close().await;
    drop(store);
    let (db, store) = open_store(&temp).await;
    let after = store.get_oauth_tokens(ALICE).await.unwrap().unwrap();
    assert_eq!(after["refresh_token"], "new-refresh");
    let fixture = RefreshFixture::start(
        "new-refresh",
        material("newest-access", "newest-refresh", NOW + 7200),
    )
    .await;
    let result = store
        .fresh_tokens(ALICE, NOW + 3600, {
            let url = fixture.url.clone();
            move |current| RefreshFixture::refresh(url, current)
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["access_token"], "newest-access");
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    db.repositories()
        .put_session(&Session {
            session_hash: "sessionhash".into(),
            owner: ALICE.into(),
            csrf_hash: "csrfhash".into(),
            encrypted_material: vec![1, 2, 3],
            created_at: NOW,
            expires_at: NOW + 604800,
        })
        .await
        .unwrap();
    let rejected = RefreshFixture::start(
        "deliberately-invalid",
        material("none", "none", NOW + 10000),
    )
    .await;
    let result = store
        .fresh_tokens(ALICE, NOW + 7200, {
            let url = rejected.url.clone();
            move |current| RefreshFixture::refresh(url, current)
        })
        .await;
    assert!(matches!(result, Err(TokenStoreError::SignInRequired)));
    assert_eq!(rejected.calls.load(Ordering::SeqCst), 1);
    assert!(store.get_oauth_tokens(ALICE).await.unwrap().is_none());
    assert!(
        db.repositories()
            .session("sessionhash", NOW + 7200)
            .await
            .unwrap()
            .is_none()
    );
    db.close().await;
}

#[tokio::test]
async fn disconnect_refresh_race() {
    let temp = Temp::new();
    let (db, store) = open_store(&temp).await;
    store
        .put_oauth_tokens(ALICE, &material("expired-access", "old-refresh", NOW), NOW)
        .await
        .unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, resumed) = tokio::sync::oneshot::channel();
    let refreshing = store.clone();
    let task = tokio::spawn(async move {
        refreshing
            .fresh_tokens(ALICE, NOW, move |_| async move {
                entered.send(()).unwrap();
                resumed.await.unwrap();
                Ok(material("rotated-access", "rotated-refresh", NOW + 3600))
            })
            .await
    });
    started.await.unwrap();
    db.repositories()
        .disconnect(ALICE.into(), "2026-01-15T12:00:00Z".into())
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        task.await.unwrap(),
        Err(TokenStoreError::SignInRequired)
    ));
    assert!(store.get_oauth_tokens(ALICE).await.unwrap().is_none());
    assert!(db.repositories().user(ALICE).await.unwrap().is_none());
    assert!(db.repositories().is_suppressed(ALICE).await.unwrap());
    assert!(
        store
            .put_oauth_tokens(
                ALICE,
                &material("stale-access", "stale-refresh", NOW + 3600),
                NOW
            )
            .await
            .is_err()
    );
    assert!(db.repositories().user(ALICE).await.unwrap().is_none());
    db.close().await;
}

#[tokio::test]
async fn refresh_cannot_replace_reconnected_material() {
    for invalid_grant in [false, true] {
        let temp = Temp::new();
        let (db, store) = open_store(&temp).await;
        store
            .put_oauth_tokens(ALICE, &material("expired-access", "old-refresh", NOW), NOW)
            .await
            .unwrap();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, resumed) = tokio::sync::oneshot::channel();
        let refreshing = store.clone();
        let task = tokio::spawn(async move {
            refreshing
                .fresh_tokens(ALICE, NOW, move |_| async move {
                    entered.send(()).unwrap();
                    resumed.await.unwrap();
                    if invalid_grant {
                        return Err(RefreshFailure::InvalidGrant);
                    }
                    Ok(material(
                        "stale-rotated-access",
                        "stale-rotated-refresh",
                        NOW + 3600,
                    ))
                })
                .await
        });
        started.await.unwrap();
        db.repositories()
            .disconnect(ALICE.into(), "2026-01-15T12:00:00Z".into())
            .await
            .unwrap();
        let restarted = TokenStore::new(db.repositories(), &[42; 32]).unwrap();
        let fresh = material(
            "fresh-authorized-access",
            "fresh-authorized-refresh",
            NOW + 7200,
        );
        restarted
            .put_authorized_oauth_tokens(ALICE, &fresh, NOW)
            .await
            .unwrap();
        db.repositories()
            .put_session(&Session {
                session_hash: "fresh-session-hash".into(),
                owner: ALICE.into(),
                csrf_hash: "fresh-csrf-hash".into(),
                encrypted_material: vec![1, 2, 3],
                created_at: NOW,
                expires_at: NOW + 604800,
            })
            .await
            .unwrap();
        release.send(()).unwrap();
        assert!(matches!(
            task.await.unwrap(),
            Err(TokenStoreError::SignInRequired)
        ));
        assert_eq!(
            restarted.get_oauth_tokens(ALICE).await.unwrap().unwrap(),
            fresh
        );
        assert!(!db.repositories().is_suppressed(ALICE).await.unwrap());
        assert!(db.repositories().backfill(ALICE).await.unwrap().is_some());
        assert!(
            db.repositories()
                .session("fresh-session-hash", NOW)
                .await
                .unwrap()
                .is_some()
        );
        db.close().await;
    }
}
