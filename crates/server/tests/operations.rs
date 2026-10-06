use atmusic_atproto::sync::verify::{VerifiedMutation, verify_commit};
use atmusic_server::{AppState, auth::session, config::Config};
use atmusic_storage::{Admission, Database, NewOperation, RecordMutation, User};
#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;
struct Fixed(chrono::DateTime<chrono::Utc>);
impl atmusic_server::Clock for Fixed {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        self.0
    }
}

#[tokio::test]
async fn status_contract() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("music.sqlite");
    let database = Database::open(&path).await.unwrap();
    let now = "2026-01-15T12:00:00Z"
        .parse::<chrono::DateTime<chrono::Utc>>()
        .unwrap();
    let alice = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    let bob = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
    for did in [alice, bob] {
        database
            .repositories()
            .upsert_user(User::new(did, now.to_rfc3339()))
            .await
            .unwrap();
    }
    let config = Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path,
        "https://music.example",
        &"ab".repeat(32),
        None,
        None,
    )
    .unwrap();
    let alice_session = session::issue(&database, config.encryption_key(), alice, now)
        .await
        .unwrap();
    let bob_session = session::issue(&database, config.encryption_key(), bob, now)
        .await
        .unwrap();
    let proof_path = "com.example.atmusic.scrobble/succeeded";
    let created=signed_repo::signed_repo_for(alice,vec![(proof_path.into(),serde_json::json!({"$type":"com.example.atmusic.scrobble","artist":"Proof","track":"Verified deletion","listenedAt":now.to_rfc3339(),"createdAt":now.to_rfc3339()}))],7,signed_repo::REVISION).await;
    let deleted =
        signed_repo::signed_mutation(&created, proof_path, None, 7, "3m4zm2ufr2223").await;
    let verified = verify_commit(
        &deleted.event,
        alice,
        &atmusic_core::namespace::Namespace::new("com.example.atmusic").unwrap(),
        now,
        &signed_repo::FixtureResolver(deleted.key.clone()),
    )
    .await
    .unwrap();
    let [VerifiedMutation::Delete { uri }] = verified.mutations() else {
        panic!("Expected signed MST deletion proof")
    };
    let deletion = RecordMutation::Delete {
        uri: uri.clone(),
        owner: verified.did().into(),
        revision: verified.revision().into(),
        indexed_at: now.to_rfc3339(),
    };
    for id in ["pending", "succeeded", "failed"] {
        let admission = database
            .repositories()
            .admit_operation(
                NewOperation {
                    operation_id: id.into(),
                    owner: alice.into(),
                    kind: "scrobble_delete".into(),
                    created_at: now.to_rfc3339(),
                    record_uri: Some(format!("at://{alice}/com.example.atmusic.scrobble/{id}")),
                    collection: "com.example.atmusic.scrobble".into(),
                    rkey: id.into(),
                    payload_json: None,
                    canonical_digest: None,
                },
                None,
            )
            .await
            .unwrap();
        assert!(matches!(admission, Admission::Created(_)));
        if id != "pending" {
            database
                .repositories()
                .begin_attempt(id.into(), now.to_rfc3339())
                .await
                .unwrap();
            database
                .repositories()
                .finish_operation(
                    id.into(),
                    now.to_rfc3339(),
                    (id == "failed").then(|| "upstream_rejected".into()),
                    (id == "succeeded").then(|| deletion.clone()),
                )
                .await
                .unwrap();
        }
    }
    let state =
        AppState::new(config, Some(database.clone())).with_clock(std::sync::Arc::new(Fixed(now)));
    for (owner, operation, expected) in [
        (Some(&alice_session), "pending", 200),
        (Some(&alice_session), "succeeded", 200),
        (Some(&alice_session), "failed", 200),
        (Some(&bob_session), "pending", 403),
        (Some(&bob_session), "missing", 404),
        (None, "pending", 401),
        (Some(&alice_session), "%FF", 400),
        (None, "%FF", 401),
    ] {
        let mut builder = Request::builder().uri(format!("/api/v1/operations/{operation}"));
        if let Some(issued) = owner {
            builder = builder.header("cookie", issued.cookie.split(';').next().unwrap());
        }
        let response = atmusic_server::router_with_state(state.clone())
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == 200 {
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        let body: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        if expected == 200 {
            let keys: Vec<_> = body
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                keys,
                [
                    "attempts",
                    "createdAt",
                    "failureCode",
                    "kind",
                    "operationId",
                    "recordUri",
                    "state",
                    "updatedAt"
                ]
            );
            assert_eq!(body["operationId"], operation);
            assert_eq!(body["state"], operation);
            assert_eq!(body["attempts"], if operation == "pending" { 0 } else { 1 });
            assert_eq!(
                body["failureCode"],
                if operation == "failed" {
                    serde_json::json!("upstream_rejected")
                } else {
                    serde_json::Value::Null
                }
            );
        } else {
            uuid::Uuid::parse_str(body["error"]["requestId"].as_str().unwrap()).unwrap();
        }
        assert!(!body.to_string().contains("session_hash"));
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM operations")
            .fetch_one(database.reader_pool())
            .await
            .unwrap(),
        3
    );
    database.close().await;
}
