//! The parent owns the PDS and kills only its test server children after remote
//! commit and before ACK. Both children open the same persistent SQLite database.
#[path = "support/scrobble_journey.rs"]
mod journey;
use journey::*;
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "owned fixture child entrypoint; invoked explicitly by fault tests"]
async fn fixture_child_server() {
    serve_child().await;
}

#[tokio::test]
#[cfg(unix)]
async fn kill_after_create() {
    let fixture = Fixture::new().await;
    let mut child = ChildApplication::start(&fixture, 1).await;
    let login = fixture.sign_in(&child.base).await;
    let pause = fixture.pause(false).await;
    let (status, admitted) = login.create(&child.base, "k1", &input()).await;
    assert_eq!(status, 202);
    let id = admitted["operationId"].as_str().unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        pause.committed.notified(),
    )
    .await
    .unwrap();
    let operation = login.operation(&child.base, id).await;
    assert_eq!(operation["state"], "pending");
    assert_eq!(operation["attempts"], 1);
    let uri = operation["recordUri"].as_str().unwrap().to_owned();
    assert_eq!(fixture.remote_get(&uri).await.status, 200);
    assert_eq!(fixture.snapshot().await.mutations().len(), 1);
    assert_eq!(
        get(&child.base, &format!("/api/v1/users/{ALICE}/scrobbles"))
            .await
            .1["items"],
        json!([])
    );
    child.kill();
    pause.release.notify_one();
    let restarted = ChildApplication::start(&fixture, 2).await;
    let recovered = login.succeeded(&restarted.base, id).await;
    assert_eq!(recovered["recordUri"], uri);
    assert_eq!(recovered["attempts"], 2);
    let (status, replayed) = login.create(&restarted.base, "k1", &input()).await;
    assert_eq!(status, 201);
    assert_eq!(replayed["scrobble"]["uri"], uri);
    let (_, history) = get(&restarted.base, &format!("/api/v1/users/{ALICE}/scrobbles")).await;
    assert_eq!(history["items"], json!([replayed["scrobble"]]));
    assert_eq!(
        get(&restarted.base, "/api/v1/feed").await.1["items"],
        history["items"]
    );
    assert_eq!(
        get(&restarted.base, &format!("/api/v1/users/{ALICE}/stats"))
            .await
            .1["totalScrobbles"],
        1
    );
    let remote = fixture.remote.lock().await;
    assert_eq!(remote.creates, 1);
    assert_eq!(remote.deletes, 0);
    assert_eq!(remote.records.len(), 1);
    assert_eq!(
        remote.cids.values().next().unwrap(),
        replayed["scrobble"]["cid"].as_str().unwrap()
    );
    drop(remote);
    assert_eq!(fixture.snapshot().await.mutations().len(), 1);
    let db = atmusic_storage::Database::open(&fixture.path)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM operations")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scrobbles")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        1
    );
    db.close().await;
}

#[tokio::test]
#[cfg(unix)]
async fn kill_after_delete() {
    let fixture = Fixture::new().await;
    let mut child = ChildApplication::start(&fixture, 1).await;
    let login = fixture.sign_in(&child.base).await;
    let (status, admitted) = login.create(&child.base, "k1", &input()).await;
    assert_eq!(status, 202);
    let created = login
        .succeeded(&child.base, admitted["operationId"].as_str().unwrap())
        .await;
    let uri = created["recordUri"].as_str().unwrap().to_owned();
    let pause = fixture.pause(true).await;
    let (status, deletion) = login.delete(&child.base, &uri).await;
    assert_eq!(status, 202);
    let id = deletion["operationId"].as_str().unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        pause.committed.notified(),
    )
    .await
    .unwrap();
    let pending = login.operation(&child.base, id).await;
    assert_eq!(pending["state"], "pending");
    assert_eq!(pending["attempts"], 1);
    assert_eq!(fixture.remote_get(&uri).await.status, 400);
    assert!(fixture.snapshot().await.mutations().is_empty());
    assert_hidden(&child.base, &uri).await;
    child.kill();
    pause.release.notify_one();
    let restarted = ChildApplication::start(&fixture, 2).await;
    // A restart cannot expose a tombstoned row while reconciliation is pending.
    assert_hidden(&restarted.base, &uri).await;
    let deleted = login.succeeded(&restarted.base, id).await;
    assert_eq!(deleted["recordUri"], uri);
    assert_eq!(deleted["attempts"], 2);
    assert_hidden(&restarted.base, &uri).await;
    assert_eq!(login.delete(&restarted.base, &uri).await.0, 204);
    let remote = fixture.remote.lock().await;
    assert_eq!(remote.creates, 1);
    assert_eq!(remote.deletes, 1);
    assert!(remote.records.is_empty());
    drop(remote);
    assert!(fixture.snapshot().await.mutations().is_empty());
    let db = atmusic_storage::Database::open(&fixture.path)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scrobbles")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM tombstones WHERE pending=0")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM operations WHERE state='succeeded'")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        2
    );
    db.close().await;
}
async fn assert_hidden(base: &str, uri: &str) {
    assert_eq!(
        get(base, &format!("/api/v1/scrobbles/{}", encoded(uri)))
            .await
            .0,
        404
    );
    assert_eq!(
        get(base, &format!("/api/v1/users/{ALICE}/scrobbles"))
            .await
            .1["items"],
        json!([])
    );
    assert_eq!(get(base, "/api/v1/feed").await.1["items"], json!([]));
    assert_eq!(
        get(base, &format!("/api/v1/users/{ALICE}/stats")).await.1["totalScrobbles"],
        0
    );
}

#[tokio::test]
async fn cursor_faults() {
    let fixture = Fixture::new().await;
    let app = Application::start(&fixture).await;
    let login = fixture.sign_in(&app.base).await;
    for index in 0..7 {
        let (status, _) = login
            .create(&app.base, &format!("equal-{index}"), &input())
            .await;
        assert_eq!(status, 202);
        app.run().await;
    }
    let path = format!("/api/v1/users/{ALICE}/scrobbles");
    let (_, initial) = get(&app.base, &format!("{path}?limit=100")).await;
    let ordered: Vec<_> = initial["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["uri"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ordered.len(), 7);
    assert!(ordered.windows(2).all(|pair| pair[0] > pair[1]));
    let (_, first) = get(&app.base, &format!("{path}?limit=2")).await;
    assert_eq!(
        first["items"],
        Value::Array(initial["items"].as_array().unwrap()[..2].to_vec())
    );
    let mut traversed: Vec<String> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["uri"].as_str().unwrap().to_owned())
        .collect();
    let mut future = input();
    future["listenedAt"] = json!("2026-01-15T12:01:00Z");
    let (status, insert) = login.create(&app.base, "between-pages", &future).await;
    assert_eq!(status, 202);
    app.run().await;
    let inserted = login
        .succeeded(&app.base, insert["operationId"].as_str().unwrap())
        .await["recordUri"]
        .as_str()
        .unwrap()
        .to_owned();
    let removed = ordered[2].clone();
    assert_eq!(login.delete(&app.base, &removed).await.0, 202);
    app.run().await;
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    while let Some(token) = cursor {
        let url = format!("{path}?limit=2&cursor={}", encoded(&token));
        let (status, page) = get(&app.base, &url).await;
        assert_eq!(status, 200);
        assert_eq!(page["asOf"], first["asOf"]);
        traversed.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["uri"].as_str().unwrap().to_owned()),
        );
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    let expected: Vec<_> = ordered.into_iter().filter(|uri| uri != &removed).collect();
    assert_eq!(traversed, expected);
    assert!(!traversed.contains(&inserted));
    assert_eq!(
        traversed
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        6
    );
    let (_, fresh) = get(&app.base, &format!("{path}?limit=100")).await;
    assert_eq!(fresh["items"].as_array().unwrap().len(), 7);
    assert_eq!(fresh["items"][0]["uri"], inserted);
    // Statistics use the fixed receipt-time asOf; the permitted future listen
    // appears on a fresh history page but enters statistics only at that time.
    assert_eq!(
        get(&app.base, &format!("/api/v1/users/{ALICE}/stats"))
            .await
            .1["totalScrobbles"],
        6
    );
    assert_eq!(fixture.snapshot().await.mutations().len(), 7);
    let remote = fixture.remote.lock().await;
    assert_eq!(remote.creates, 8);
    assert_eq!(remote.deletes, 1);
}
