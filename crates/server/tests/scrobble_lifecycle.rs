//! Consolidated HTTP + OAuth + durable outbox + signed remote repository journey.
#[path = "support/scrobble_journey.rs"]
mod journey;
use journey::*;
use serde_json::{Value, json};

#[tokio::test]
async fn lifecycle() {
    let fixture = Fixture::new().await;
    let app = Application::start(&fixture).await;
    let login = fixture.sign_in(&app.base).await;
    let (status, created) = login.create(&app.base, "k1", &input()).await;
    assert_eq!(status, 202);
    assert_eq!(created["state"], "pending");
    let operation_id = created["operationId"].as_str().unwrap();
    assert_eq!(
        login.operation(&app.base, operation_id).await["attempts"],
        0
    );
    assert_eq!(
        get(&app.base, &format!("/api/v1/users/{ALICE}/scrobbles"))
            .await
            .1["items"],
        json!([])
    );
    app.run().await;
    let succeeded = login.succeeded(&app.base, operation_id).await;
    assert_eq!(succeeded["kind"], "scrobble_create");
    assert_eq!(succeeded["attempts"], 1);
    let uri = succeeded["recordUri"].as_str().unwrap();
    assert!(uri.starts_with(&format!("at://{ALICE}/{PREFIX}.scrobble/")));
    let (status, replayed) = login.create(&app.base, "k1", &input()).await;
    assert_eq!(status, 201);
    let scrobble = &replayed["scrobble"];
    assert_eq!(scrobble["uri"], uri);
    assert_eq!(scrobble["did"], ALICE);
    assert_eq!(scrobble["track"], "Jóga");
    assert_eq!(scrobble["artist"], "Björk");
    assert!(scrobble["revision"].is_string());
    assert!(scrobble["indexedAt"].is_string());
    let remote_get = fixture.remote_get(uri).await;
    assert_eq!(remote_get.status, 200);
    let remote_record: Value = serde_json::from_slice(&remote_get.body).unwrap();
    assert_eq!(remote_record["uri"], uri);
    assert_eq!(remote_record["cid"], scrobble["cid"]);
    assert_eq!(
        remote_record["value"]["$type"],
        format!("{PREFIX}.scrobble")
    );
    assert_eq!(remote_record["value"]["artist"], "Björk");
    assert_eq!(remote_record["value"]["track"], "Jóga");
    assert_eq!(remote_record["value"]["durationSeconds"], 300);
    for _ in 0..5 {
        let (status, retry) = login.create(&app.base, "k1", &input()).await;
        assert_eq!(status, 201);
        assert_eq!(retry["scrobble"], *scrobble);
    }
    let verified = fixture.snapshot().await;
    assert_eq!(verified.mutations().len(), 1);
    assert_eq!(fixture.remote.lock().await.creates, 1);
    let (status, lookup) = get(&app.base, &format!("/api/v1/scrobbles/{}", encoded(uri))).await;
    assert_eq!(status, 200);
    assert_eq!(lookup["scrobble"], *scrobble);
    for path in [
        format!("/api/v1/users/{ALICE}/scrobbles"),
        "/api/v1/feed?scope=global".into(),
    ] {
        let (status, page) = get(&app.base, &path).await;
        assert_eq!(status, 200);
        assert_eq!(page["items"], json!([scrobble]));
        assert_eq!(page["indexing"]["caughtUp"], false);
    }
    let (status, stats) = get(
        &app.base,
        &format!("/api/v1/users/{ALICE}/stats?window=all"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(stats["totalScrobbles"], 1);
    let (status, deletion) = login.delete(&app.base, uri).await;
    assert_eq!(status, 202);
    let deletion_id = deletion["operationId"].as_str().unwrap();
    // Local admission immediately hides history/feed/statistics before remote ACK.
    assert_eq!(
        get(&app.base, &format!("/api/v1/scrobbles/{}", encoded(uri)))
            .await
            .0,
        404
    );
    assert_eq!(
        get(&app.base, &format!("/api/v1/users/{ALICE}/scrobbles"))
            .await
            .1["items"],
        json!([])
    );
    assert_eq!(get(&app.base, "/api/v1/feed").await.1["items"], json!([]));
    assert_eq!(
        get(&app.base, &format!("/api/v1/users/{ALICE}/stats"))
            .await
            .1["totalScrobbles"],
        0
    );
    app.run().await;
    let deleted = login.succeeded(&app.base, deletion_id).await;
    assert_eq!(deleted["kind"], "scrobble_delete");
    assert_eq!(deleted["recordUri"], uri);
    assert_eq!(fixture.remote.lock().await.deletes, 1);
    assert!(fixture.remote.lock().await.records.is_empty());
    let absent = fixture.remote_get(uri).await;
    assert_eq!(absent.status, 400);
    assert_eq!(
        serde_json::from_slice::<Value>(&absent.body).unwrap()["error"],
        "RecordNotFound"
    );
    assert!(fixture.snapshot().await.mutations().is_empty());
    assert_eq!(login.delete(&app.base, uri).await.0, 204);
    let state = fixture.oauth.state.lock().unwrap();
    assert_eq!(state.par_calls, 2);
    assert_eq!(state.token_calls, 1);
    assert!(
        state
            .proofs
            .iter()
            .any(|proof| proof.htu.ends_with("createRecord"))
    );
    assert!(
        state
            .proofs
            .iter()
            .any(|proof| proof.htu.ends_with("deleteRecord"))
    );
}

#[tokio::test]
async fn validation_matrix() {
    let fixture = Fixture::new().await;
    let app = Application::start(&fixture).await;
    let login = fixture.sign_in(&app.base).await;
    let mut invalid: Vec<(String, Value)> = vec![];
    for case in serde_json::from_str::<Value>(include_str!(
        "../../../tests/fixtures/scrobbles/invalid.json"
    ))
    .unwrap()
    .as_array()
    .unwrap()
    {
        let field = case["field"].as_str().unwrap();
        // createdAt is deliberately forbidden on local input; retain its case.
        let mut value = input();
        value[field] = case["value"].clone();
        invalid.push((field.into(), value));
    }
    for field in ["artist", "track"] {
        for value in [
            json!("a".repeat(257)),
            json!("💿".repeat(257)),
            json!("   "),
            Value::Null,
            json!(17),
        ] {
            let mut record = input();
            record[field] = value;
            invalid.push((field.into(), record));
        }
        let mut record = input();
        record.as_object_mut().unwrap().remove(field);
        invalid.push((field.into(), record));
    }
    for value in [
        json!("a".repeat(257)),
        json!("💿".repeat(257)),
        json!(" "),
        Value::Null,
    ] {
        let mut record = input();
        record["album"] = value;
        invalid.push(("album".into(), record));
    }
    for value in [
        "2026-01-15T12:00:00+01:00",
        "2026-01-15T12:00:00-00:00",
        "2026-01-15t12:00:00z",
        "2026-01-15T12:05:00.0000000001Z",
        "2026-01-15T12:00:60Z",
        "bad",
    ] {
        let mut record = input();
        record["listenedAt"] = json!(value);
        invalid.push(("listenedAt".into(), record));
    }
    for value in [
        Value::Null,
        json!("300"),
        json!(-1),
        json!(true),
        json!(1.0),
    ] {
        let mut record = input();
        record["durationSeconds"] = value;
        invalid.push(("durationSeconds".into(), record));
    }
    for value in [
        Value::Null,
        json!("550e8400e29b41d4a716446655440000"),
        json!("urn:uuid:550e8400-e29b-41d4-a716-446655440000"),
    ] {
        let mut record = input();
        record["recordingMbid"] = value;
        invalid.push(("recordingMbid".into(), record));
    }
    for field in ["$type", "owner", "unknown"] {
        let mut record = input();
        record[field] = json!(ALICE);
        invalid.push((field.into(), record));
    }
    let count = invalid.len();
    assert!(count >= 40);
    for (index, (field, value)) in invalid.into_iter().enumerate() {
        let (status, error) = login
            .create(&app.base, &format!("invalid-{index}"), &value)
            .await;
        assert_eq!(status, 422, "case {index} {field}: {value} => {error}");
        assert_eq!(error["error"]["code"], "invalid_scrobble");
        assert!(error["error"]["fields"][&field].is_string(), "{error}");
    }
    let operations: i64 = sqlx::query_scalar("SELECT count(*) FROM operations")
        .fetch_one(app.db.reader_pool())
        .await
        .unwrap();
    assert_eq!(operations, 0);
    assert_eq!(fixture.remote.lock().await.creates, 0);
    assert!(fixture.remote.lock().await.records.is_empty());
    assert_eq!(app.worker.run_due(now()).await.unwrap(), 0);
}

#[tokio::test]
async fn same_time_distinct() {
    let fixture = Fixture::new().await;
    let app = Application::start(&fixture).await;
    let login = fixture.sign_in(&app.base).await;
    let mut uris = std::collections::BTreeSet::new();
    for key in ["k1", "k2"] {
        let (status, value) = login.create(&app.base, key, &input()).await;
        assert_eq!(status, 202);
        app.run().await;
        let operation = login
            .succeeded(&app.base, value["operationId"].as_str().unwrap())
            .await;
        assert!(uris.insert(operation["recordUri"].as_str().unwrap().to_owned()));
    }
    let remote = fixture.remote.lock().await;
    assert_eq!(remote.creates, 2);
    assert_eq!(remote.records.len(), 2);
    let cids: std::collections::BTreeSet<_> = remote.cids.values().collect();
    assert_eq!(
        cids.len(),
        1,
        "identical content can share CID but must have distinct AT identities"
    );
    drop(remote);
    assert_eq!(fixture.snapshot().await.mutations().len(), 2);
    for path in [
        format!("/api/v1/users/{ALICE}/scrobbles"),
        "/api/v1/feed".into(),
    ] {
        let (_, page) = get(&app.base, &path).await;
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items
                .iter()
                .map(|row| row["uri"].as_str().unwrap().to_owned())
                .collect::<std::collections::BTreeSet<_>>(),
            uris
        );
    }
    assert_eq!(
        get(&app.base, &format!("/api/v1/users/{ALICE}/stats"))
            .await
            .1["totalScrobbles"],
        2
    );
}
