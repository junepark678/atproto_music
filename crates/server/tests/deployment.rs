use atmusic_storage::{Database, User};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_atmusic"));
    for (name, _) in std::env::vars().filter(|(name, _)| name.starts_with("ATMUSIC_")) {
        command.env_remove(name);
    }
    command
}
fn migrate(database: &Path) -> std::process::Output {
    cli()
        .args(["migrate", "--database-path"])
        .arg(database)
        .output()
        .unwrap()
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::new();
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' && characters.peek() == Some(&'[') {
            characters.next();
            for control in characters.by_ref() {
                if ('@'..='~').contains(&control) {
                    break;
                }
            }
        } else {
            output.push(character);
        }
    }
    output
}

#[tokio::test]
async fn fresh_install() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data/music.sqlite");
    let output = migrate(&path);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let database = Database::open(&path).await.unwrap();
    assert_eq!(
        database.schema_version().await.unwrap(),
        atmusic_storage::migrations::SCHEMA_VERSION
    );
    database
        .repositories()
        .upsert_user(User::new(
            "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
            "2026-01-15T12:00:00Z",
        ))
        .await
        .unwrap();
    database.close().await;
    let log_path = directory.path().join("server.log");
    let log = fs::File::create(&log_path).unwrap();
    let mut child = OwnedChild(
        cli()
            .args(["serve", "--bind", "127.0.0.1:0", "--database-path"])
            .arg(&path)
            .args([
                "--public-origin",
                "https://music.example",
                "--encryption-key",
            ])
            .arg("11".repeat(32))
            .env("RUST_LOG", "info")
            .current_dir(directory.path())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
    let address = loop {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "server exited: {}",
            fs::read_to_string(&log_path).unwrap()
        );
        if let Some((_, suffix)) =
            strip_ansi(&fs::read_to_string(&log_path).unwrap()).split_once("address=127.0.0.1:")
        {
            let port = suffix
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if !port.is_empty() {
                break format!("http://127.0.0.1:{port}");
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "listener startup timed out"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let ready = client
        .get(format!("{address}/health/ready"))
        .send()
        .await
        .unwrap();
    assert_eq!(ready.status(), 200);
    assert_eq!(
        ready.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"status":"ready"})
    );
    let history = client
        .get(format!(
            "{address}/api/v1/users/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/scrobbles"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(history.status(), 200);
    let body = history.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["items"], serde_json::json!([]));
    assert!(body["nextCursor"].is_null());
    let terminated = Command::new("kill")
        .args(["-TERM", &child.0.id().to_string()])
        .status()
        .unwrap();
    assert!(terminated.success());
    let deadline = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            deadline.elapsed() < Duration::from_secs(5),
            "idle shutdown timed out"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn upgrade_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("music.sqlite");
    assert!(migrate(&path).status.success());
    let database = Database::open(&path).await.unwrap();
    database
        .repositories()
        .upsert_user(User::new(
            "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
            "2026-01-15T12:00:00Z",
        ))
        .await
        .unwrap();
    database.close().await;
    let snapshot = directory.path().join("before-upgrade.sqlite");
    let backup = cli()
        .args(["backup", "--database-path"])
        .arg(&path)
        .arg("--output")
        .arg(&snapshot)
        .output()
        .unwrap();
    assert!(
        backup.status.success(),
        "{}",
        String::from_utf8_lossy(&backup.stderr)
    );
    let backup_bytes = fs::read(&snapshot).unwrap();
    let database = Database::open(&path).await.unwrap();
    database
        .writer()
        .execute(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE _sqlx_migrations SET checksum=x'00' WHERE version=1")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    database.close().await;
    let failed_bytes = fs::read(&path).unwrap();
    let output = migrate(&path);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("migration failed"));
    assert_eq!(fs::read(&snapshot).unwrap(), backup_bytes);
    assert_eq!(
        fs::read(&path).unwrap(),
        failed_bytes,
        "failed migration erased or modified old database"
    );
    let recovered = directory.path().join("recovered");
    let restore = cli()
        .args(["restore", "--backup-path"])
        .arg(&snapshot)
        .arg("--destination")
        .arg(&recovered)
        .output()
        .unwrap();
    assert!(
        restore.status.success(),
        "{}",
        String::from_utf8_lossy(&restore.stderr)
    );
    let restored = Database::open(recovered.join("music.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(restored.reader_pool())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        restored.schema_version().await.unwrap(),
        atmusic_storage::migrations::SCHEMA_VERSION
    );
    restored.close().await;
    assert_eq!(fs::read(&snapshot).unwrap(), backup_bytes);
}

#[tokio::test]
async fn owned_namespace_cli_starts_current_head_workers_and_stops_both_listeners() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owned.sqlite");
    let log_path = directory.path().join("owned.log");
    let log = fs::File::create(&log_path).unwrap();
    let mut child = OwnedChild(
        cli()
            .args([
                "serve",
                "--bind",
                "127.0.0.1:0",
                "--metrics-bind",
                "127.0.0.1:0",
                "--database-path",
            ])
            .arg(&path)
            .args([
                "--public-origin",
                "https://app.fixture.test",
                "--encryption-key",
            ])
            .arg("11".repeat(32))
            .args([
                "--lexicon-prefix",
                "test.fixture.music",
                "--namespace-owner-domain",
                "fixture.test",
                "--namespace-ownership-reference",
                "controlled test-only CLI namespace",
                "--relay-url",
                "wss://relay.fixture.test/",
            ])
            .env("RUST_LOG", "info")
            .current_dir(directory.path())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
    let (api, metrics) = loop {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "server exited: {}",
            fs::read_to_string(&log_path).unwrap()
        );
        let text = strip_ansi(&fs::read_to_string(&log_path).unwrap());
        if text.contains("publication_enabled=true") && text.contains("relay_enabled=false") {
            let port = |marker| {
                text.split_once(marker).map(|(_, suffix)| {
                    suffix
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                })
            };
            if let (Some(api), Some(metrics)) =
                (port("address=127.0.0.1:"), port("metrics_bind=127.0.0.1:"))
            {
                break (format!("127.0.0.1:{api}"), format!("127.0.0.1:{metrics}"));
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "startup deadline"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let meta = client
        .get(format!("http://{api}/api/v1/meta"))
        .send()
        .await
        .unwrap();
    assert_eq!(meta.status(), 200);
    let meta = meta.json::<serde_json::Value>().await.unwrap();
    assert_eq!(meta["lexiconPrefix"], "test.fixture.music");
    assert_eq!(meta["indexing"]["state"], "recovering");
    assert_eq!(meta["indexing"]["caughtUp"], false);
    assert_eq!(
        client
            .get(format!("http://{metrics}/metrics"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let stopped = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            stopped.elapsed() < Duration::from_secs(5),
            "owned workers did not stop"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    for address in [api, metrics] {
        assert_eq!(
            std::net::TcpStream::connect(address).unwrap_err().kind(),
            std::io::ErrorKind::ConnectionRefused
        );
    }
    let reopened = Database::open(path).await.unwrap();
    let recovery = reopened
        .repositories()
        .relay_recovery("wss://relay.fixture.test/")
        .await
        .unwrap()
        .unwrap();
    assert!(!recovery.connected);
    assert!(recovery.pending_gap);
    assert_eq!(recovery.reason.as_deref(), Some("relay_worker_not_enabled"));
    reopened.close().await;
}

#[test]
fn secret_example_scan() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for path in [
        ".env.example",
        "config/atmusic.env.example",
        "docs/deployment.md",
        "docs/backup.md",
        "docs/releases.md",
    ] {
        let text = fs::read_to_string(root.join(path)).unwrap();
        assert!(!text.contains("-----BEGIN PRIVATE KEY-----"), "{path}");
        assert!(!text.contains("-----BEGIN EC PRIVATE KEY-----"), "{path}");
        for line in text.lines() {
            if let Some((name, value)) = line.split_once('=')
                && matches!(
                    name.trim(),
                    "ATMUSIC_ENCRYPTION_KEY" | "ATMUSIC_METRICS_TOKEN"
                )
            {
                assert!(
                    value.trim().is_empty(),
                    "{path}: configured secret must be blank"
                );
            }
            // The examples prescribe random generation rather than a reusable key literal.
            for word in line.split(|character: char| !character.is_ascii_hexdigit()) {
                assert!(word.len() != 64, "{path}: literal 32-byte secret present");
            }
        }
    }
}
