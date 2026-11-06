//! Same-database restart through the packaged host CLI. The LD_PRELOAD clock is
//! test-only and leaves monotonic timers intact; this is not musl restart proof.
#![cfg(target_os = "linux")]
mod common;
#[path = "common/read_projection.rs"]
mod projection;

use atmusic_atproto::oauth::token_store::TokenStore;
use atmusic_server::auth::session;
use atmusic_storage::{Database, NewOperation};
use chrono::DateTime;
use projection::{ALICE, BOB, CANONICAL_AS_OF};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct PackagedServer {
    child: Child,
    address: SocketAddr,
    client: reqwest::Client,
    logs: tokio::sync::mpsc::UnboundedReceiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
}
impl PackagedServer {
    async fn start(database: &Path, clock: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_atmusic"));
        child
            .args([
                "serve",
                "--bind",
                "127.0.0.1:0",
                "--metrics-bind",
                "127.0.0.1:0",
                "--database-path",
            ])
            .arg(database)
            .args(["--public-origin", "https://music.example"])
            .env("ATMUSIC_ENCRYPTION_KEY", "11".repeat(32))
            .env("RUST_LOG", "info")
            .env("NO_COLOR", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for variable in [
            "ATMUSIC_LEXICON_PREFIX",
            "ATMUSIC_RELAY_URL",
            "ATMUSIC_NAMESPACE_OWNER_DOMAIN",
            "ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE",
            "ATMUSIC_METRICS_TOKEN",
        ] {
            child.env_remove(variable);
        }
        let mut preload = clock.as_os_str().to_owned();
        if let Some(existing) = std::env::var_os("LD_PRELOAD") {
            preload.push(":");
            preload.push(existing);
        }
        child.env("LD_PRELOAD", preload);
        let mut child = child.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, logs) = tokio::sync::mpsc::unbounded_channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if send.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        // Own the child before waiting for logs, so startup timeouts also kill
        // only this test's process and close its stdout reader.
        let mut server = Self {
            child,
            address: "127.0.0.1:0".parse().unwrap(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            logs,
            reader: Some(reader),
        };
        let address = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let line = server
                    .logs
                    .recv()
                    .await
                    .expect("packaged process closed stdout before listening");
                let plain = strip_ansi(&line);
                if plain.contains("listening")
                    && let Some(address) = plain
                        .split_whitespace()
                        .find_map(|field| field.strip_prefix("address="))
                {
                    break address.parse::<SocketAddr>().unwrap();
                }
            }
        })
        .await
        .expect("packaged process did not publish an ephemeral listener");
        server.address = address;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(response) = server.client.get(server.url("/health/ready")).send().await
                    && response.status() == 200
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("packaged process did not become ready");
        server
    }
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
    async fn get(&self, path: &str, cookie: Option<&str>) -> Vec<u8> {
        let request = self.client.get(self.url(path));
        let response = match cookie {
            Some(cookie) => request.header("cookie", cookie),
            None => request,
        }
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), 200, "{path}");
        let bytes = response.bytes().await.unwrap().to_vec();
        let text = std::str::from_utf8(&bytes).unwrap();
        for private in [
            "DUMMY_RESTART_ACCESS",
            "DUMMY_RESTART_REFRESH",
            "DUMMY_RESTART_PRIVATE_PAYLOAD",
            "encrypted_material",
            "payload_json",
        ] {
            assert!(!text.contains(private), "{path} exposed private material");
        }
        bytes
    }
    async fn stop(&mut self) {
        assert!(
            Command::new("kill")
                .args(["-TERM", &self.child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "packaged process did not stop cleanly: {status}"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "packaged process exceeded drain deadline"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
        while let Ok(log) = self.logs.try_recv() {
            for private in [
                "DUMMY_RESTART_ACCESS",
                "DUMMY_RESTART_REFRESH",
                "DUMMY_RESTART_PRIVATE_PAYLOAD",
            ] {
                assert!(!log.contains(private));
            }
        }
    }
}
impl Drop for PackagedServer {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn strip_ansi(text: &str) -> String {
    let mut result = String::new();
    let mut escape = false;
    for character in text.chars() {
        if character == '\u{1b}' {
            escape = true;
        } else if escape {
            if character == 'm' {
                escape = false;
            }
        } else {
            result.push(character);
        }
    }
    result
}
struct Fixture {
    directory: tempfile::TempDir,
    path: PathBuf,
    clock: PathBuf,
    cookie: String,
    fixtures: projection::ReadFixtures,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("music.sqlite");
        let clock = directory.path().join("frozen_clock.so");
        let source = directory.path().join("frozen_clock.c");
        std::fs::write(&source, include_str!("common/frozen_clock.c")).unwrap();
        let output = Command::new("cc")
            .args(["-shared", "-fPIC", "-O2", "-o"])
            .arg(&clock)
            .arg(&source)
            .arg("-ldl")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "clock shim compile failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let database = Database::open(&path).await.unwrap();
        let fixtures = projection::seed_database(&database, true).await;
        let store = TokenStore::new(database.repositories(), &[0x11; 32]).unwrap();
        store.put_oauth_tokens(ALICE,&json!({"did":ALICE,"issuer":"https://issuer.test","expires_at":1_768_482_000,"access_token":"DUMMY_RESTART_ACCESS","refresh_token":"DUMMY_RESTART_REFRESH"}),1_768_478_400).await.unwrap();
        let issued = session::issue(
            &database,
            &[0x11; 32],
            ALICE,
            DateTime::from_timestamp(1_768_478_400, 0).unwrap(),
        )
        .await
        .unwrap();
        database
            .repositories()
            .admit_operation(
                NewOperation {
                    operation_id: "restart-private-create".into(),
                    owner: ALICE.into(),
                    kind: "scrobble_create".into(),
                    created_at: projection::AS_OF.into(),
                    record_uri: Some(projection::uri(ALICE, "private-pending")),
                    collection: "com.example.atmusic.scrobble".into(),
                    rkey: "private-pending".into(),
                    payload_json: Some(
                        json!({"private":"DUMMY_RESTART_PRIVATE_PAYLOAD"}).to_string(),
                    ),
                    canonical_digest: Some("private-digest".into()),
                },
                None,
            )
            .await
            .unwrap();
        database.close().await;
        Self {
            directory,
            path,
            clock,
            cookie: issued.cookie,
            fixtures,
        }
    }
    async fn start(&self) -> PackagedServer {
        PackagedServer::start(&self.path, &self.clock).await
    }
}
fn body(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn durable_views() {
    let fixture = Fixture::new().await;
    assert!(fixture.directory.path().exists());
    let mut first = fixture.start().await;
    let routes = [
        format!("/api/v1/users/{ALICE}/scrobbles"),
        format!("/api/v1/users/{ALICE}/following"),
        format!("/api/v1/users/{BOB}/followers"),
        format!("/api/v1/users/{ALICE}/stats?window=all"),
        "/api/v1/feed?scope=following".into(),
    ];
    let mut before = Vec::new();
    for route in &routes {
        before.push(first.get(route, Some(&fixture.cookie)).await);
    }
    assert_eq!(
        projection::items(&body(&before[0])),
        ["r07", "r01", "r02", "r03", "r04", "r05", "r06"].map(|key| projection::uri(ALICE, key))
    );
    assert_eq!(body(&before[0])["asOf"], CANONICAL_AS_OF);
    assert_eq!(
        body(&before[1])["items"][0]["uri"],
        projection::follow_uri(ALICE, BOB)
    );
    assert_eq!(body(&before[1])["items"].as_array().unwrap().len(), 1);
    assert_eq!(body(&before[2])["items"], body(&before[1])["items"]);
    assert_eq!(body(&before[3])["totalScrobbles"], 7);
    assert_eq!(body(&before[3])["asOf"], CANONICAL_AS_OF);
    assert_eq!(
        body(&before[3])["topArtists"],
        json!([{"artist":"Radiohead","scrobbleCount":3},{"artist":"Björk","scrobbleCount":2},{"artist":"Kate Bush","scrobbleCount":2}])
    );
    assert_eq!(
        projection::items(&body(&before[4])),
        [projection::uri(BOB, "r09")]
    );
    first.stop().await;
    let database = Database::open(&fixture.path).await.unwrap();
    let checkpoints_before: Vec<(String, i64, Option<String>)> =
        sqlx::query_as("SELECT relay,sequence,revision FROM relay_checkpoints ORDER BY relay")
            .fetch_all(database.reader_pool())
            .await
            .unwrap();
    assert_eq!(checkpoints_before.len(), 3);
    assert!(
        database
            .repositories()
            .operation(ALICE, "restart-private-create")
            .await
            .unwrap()
            .is_some()
    );
    database.close().await;
    let mut second = fixture.start().await;
    for (route, expected) in routes.iter().zip(&before) {
        assert_eq!(
            &second.get(route, Some(&fixture.cookie)).await,
            expected,
            "durable bytes for {route}"
        );
    }
    second.stop().await;
    let database = Database::open(&fixture.path).await.unwrap();
    let checkpoints_after: Vec<(String, i64, Option<String>)> =
        sqlx::query_as("SELECT relay,sequence,revision FROM relay_checkpoints ORDER BY relay")
            .fetch_all(database.reader_pool())
            .await
            .unwrap();
    assert_eq!(checkpoints_after, checkpoints_before);
    let store = TokenStore::new(database.repositories(), &[0x11; 32]).unwrap();
    assert_eq!(
        store.get_oauth_tokens(ALICE).await.unwrap().unwrap()["access_token"],
        "DUMMY_RESTART_ACCESS"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions")
            .fetch_one(database.reader_pool())
            .await
            .unwrap(),
        1
    );
    database.close().await;
}

#[tokio::test]
async fn durable_cursor() {
    let fixture = Fixture::new().await;
    let mut first = fixture.start().await;
    let page = body(
        &first
            .get(&format!("/api/v1/users/{ALICE}/scrobbles?limit=2"), None)
            .await,
    );
    assert_eq!(
        projection::items(&page),
        [projection::uri(ALICE, "r07"), projection::uri(ALICE, "r01")]
    );
    assert_eq!(page["asOf"], CANONICAL_AS_OF);
    let cursor = page["nextCursor"].as_str().unwrap().to_owned();
    first.stop().await;
    let mut second = fixture.start().await;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("limit", "2")
        .append_pair("cursor", &cursor)
        .finish();
    let next = body(
        &second
            .get(&format!("/api/v1/users/{ALICE}/scrobbles?{query}"), None)
            .await,
    );
    assert_eq!(
        projection::items(&next),
        [projection::uri(ALICE, "r02"), projection::uri(ALICE, "r03")]
    );
    assert_eq!(next["asOf"], CANONICAL_AS_OF);
    assert!(
        projection::items(&next)
            .iter()
            .all(|uri| !projection::items(&page).contains(uri))
    );
    second.stop().await;
}

#[tokio::test]
async fn durable_delete() {
    let mut fixture = Fixture::new().await;
    let database = Database::open(&fixture.path).await.unwrap();
    // A production atomic deletion admission hides a verified record immediately.
    let pending = projection::uri(ALICE, "r01");
    database
        .repositories()
        .request_deletion(NewOperation {
            operation_id: "durable-delete".into(),
            owner: ALICE.into(),
            kind: "scrobble_delete".into(),
            created_at: projection::AS_OF.into(),
            record_uri: Some(pending.clone()),
            collection: "com.example.atmusic.scrobble".into(),
            rkey: "r01".into(),
            payload_json: None,
            canonical_digest: None,
        })
        .await
        .unwrap();
    // Persist a confirmed deletion using a signed fixture, never a fake row.
    let deleted = projection::uri(ALICE, "r02");
    fixture
        .fixtures
        .delete_database(&database, ALICE, &deleted)
        .await;
    assert!(fixture.fixtures.excluded.is_empty());
    database.close().await;
    let mut first = fixture.start().await;
    let route = format!("/api/v1/users/{ALICE}/scrobbles");
    let before = first.get(&route, None).await;
    assert_eq!(
        projection::items(&body(&before)),
        ["r07", "r03", "r04", "r05", "r06"].map(|key| projection::uri(ALICE, key))
    );
    first.stop().await;
    let mut second = fixture.start().await;
    assert_eq!(second.get(&route, None).await, before);
    let stats = body(
        &second
            .get(&format!("/api/v1/users/{ALICE}/stats?window=all"), None)
            .await,
    );
    assert_eq!(stats["totalScrobbles"], 5);
    second.stop().await;
    let database = Database::open(&fixture.path).await.unwrap();
    assert!(
        database
            .repositories()
            .scrobble(&pending)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        database
            .repositories()
            .scrobble(&deleted)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        database
            .repositories()
            .operation(ALICE, "durable-delete")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    let tombstones: Vec<(String, bool)> =
        sqlx::query_as("SELECT uri,pending FROM tombstones WHERE uri IN (?,?) ORDER BY uri")
            .bind(pending)
            .bind(deleted)
            .fetch_all(database.reader_pool())
            .await
            .unwrap();
    assert_eq!(tombstones.len(), 2);
    assert!(tombstones[0].1);
    assert!(!tombstones[1].1);
    database.close().await;
}
