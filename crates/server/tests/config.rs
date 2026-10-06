use atmusic_server::config::Config;
use std::{path::Path, process::Command};

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn serve_command(path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_atmusic"));
    command
        .args([
            "serve",
            "--public-origin",
            "https://music.example",
            "--encryption-key",
        ])
        .arg("ab".repeat(32))
        .arg("--database-path")
        .arg(path);
    command
}

#[test]
fn invalid_config() {
    let temp = tempfile::tempdir().unwrap();
    for (origin, namespace, key, field) in [
        (
            "https://music.example:443",
            None,
            "ab".repeat(32),
            "public_origin",
        ),
        (
            "https://music.example:8443",
            None,
            "ab".repeat(32),
            "public_origin",
        ),
        (
            "http://public.example",
            None,
            "ab".repeat(32),
            "public_origin",
        ),
        (
            "https://music.example/path",
            None,
            "ab".repeat(32),
            "public_origin",
        ),
        (
            "https://music.example",
            Some("invalid"),
            "ab".repeat(32),
            "lexicon_prefix",
        ),
        (
            "https://music.example",
            None,
            "sensitive-malformed-key".into(),
            "encryption_key",
        ),
    ] {
        let error = Config::from_values(
            "127.0.0.1:0".parse().unwrap(),
            temp.path().join("music.sqlite"),
            origin,
            &key,
            namespace,
            None,
        )
        .unwrap_err();
        assert_eq!(error.field, field);
        assert!(!error.to_string().contains(&key));
    }
    let output = serve_command(&temp.path().join("bad.sqlite"))
        .args(["--encryption-key", "sensitive-malformed-key"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("sensitive-malformed-key"));
    assert!(!temp.path().join("bad.sqlite").exists());
    let output = serve_command(&temp.path().join("bad-proxy.sqlite"))
        .args(["--trusted-proxy-cidrs", "not-a-cidr"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("trusted_proxy_cidrs"));
    assert!(!temp.path().join("bad-proxy.sqlite").exists());
}

#[test]
fn migrate_only() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("nested/music.sqlite");
    for _ in 0..2 {
        let output = Command::new(env!("CARGO_BIN_EXE_atmusic"))
            .args(["migrate", "--database-path"])
            .arg(&database)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("listening"));
    }
    assert!(database.exists());
}

#[tokio::test]
async fn bind_precedence() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("music.sqlite");
    let database = atmusic_storage::Database::open(&path).await.unwrap();
    database
        .repositories()
        .set_indexing(
            "global".into(),
            atmusic_storage::Indexing {
                state: "current".into(),
                caught_up: true,
                last_indexed_at: Some("2026-01-15T12:00:00Z".into()),
                lag_seconds: Some(0),
            },
        )
        .await
        .unwrap();
    database
        .repositories()
        .set_relay_recovery(atmusic_storage::RelayRecovery {
            relay: "wss://relay.example/".into(),
            pending_gap: false,
            connected: true,
            prior_sequence: Some(42),
            last_event_at: Some("2026-01-15T12:00:00Z".into()),
            reason: None,
            updated_at: "2026-01-15T12:00:00Z".into(),
        })
        .await
        .unwrap();
    database.close().await;
    let env_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let env_address = env_listener.local_addr().unwrap();
    let cli_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let cli_address = cli_listener.local_addr().unwrap();
    drop(cli_listener);
    let mut child = OwnedChild(
        serve_command(&path)
            .env("ATMUSIC_BIND", env_address.to_string())
            .args([
                "--bind",
                &cli_address.to_string(),
                "--relay-url",
                "wss://relay.example",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let reached = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(response) = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://{cli_address}/health/ready"))
                .send()
                .await
            {
                assert_eq!(response.status(), 200);
                break;
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("server exited: {status}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await;
    reached.unwrap();
    let metadata = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{cli_address}/api/v1/meta"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(
        metadata["indexing"]["caughtUp"], false,
        "persisted connected=true cannot advertise an inactive production worker after restart"
    );
    assert_eq!(metadata["indexing"]["state"], "recovering");
    drop(child);
    let database = atmusic_storage::Database::open(&path).await.unwrap();
    let recovery = database
        .repositories()
        .relay_recovery("wss://relay.example/")
        .await
        .unwrap()
        .unwrap();
    assert!(!recovery.connected);
    assert!(recovery.pending_gap);
    assert_eq!(recovery.prior_sequence, Some(42));
    assert_eq!(
        recovery.last_event_at.as_deref(),
        Some("2026-01-15T12:00:00.000000000Z")
    );
    database.close().await;
    // Holding the env listener proves only the CLI socket was bound by the child.
    assert_eq!(env_listener.local_addr().unwrap(), env_address);
    let invalid = serve_command(&temp.path().join("invalid.sqlite"))
        .args(["--bind", "invalid-address"])
        .output()
        .unwrap();
    assert_eq!(invalid.status.code(), Some(2));
}
