//! Authenticated follow intentions converge only through signed PDS repository evidence.
#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;
use atmusic_atproto::{
    pds::write::{Jitter, PdsWriteBoundary},
    sync::verify::{VerifiedMutation, VerifiedRecord, verify_snapshot},
};
use atmusic_core::follow::follow_rkey;
use atmusic_server::{
    AppState, Clock, auth::session, config::Config, workers::outbox::OutboxWorker,
};
use atmusic_storage::{Checkpoint, Database, FollowRow, RecordMutation, RepositoryEvent, User};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use write_pds::*;
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL: &str = "did:plc:cccccccccccccccccccccccc";
struct Frozen;
impl Clock for Frozen {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        now()
    }
}
struct Zero;
impl Jitter for Zero {
    fn milliseconds(&self, _: u64) -> u64 {
        0
    }
}
fn config(path: std::path::PathBuf) -> Config {
    Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path,
        "https://app.fixture.test",
        &"aa".repeat(32),
        Some(PREFIX),
        None,
    )
    .unwrap()
    .with_namespace_ownership(atmusic_core::namespace::OwnershipEvidence {
        domain: "fixture.test".into(),
        reference: "controlled fixture domain; test-only".into(),
    })
    .unwrap()
}
async fn prepare(
    replies: Vec<Reply>,
) -> (
    tempfile::TempDir,
    Database,
    WritePds,
    Arc<OutboxWorker>,
    AppState,
    session::IssuedSession,
) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("music.sqlite");
    let db = Database::open(&path).await.unwrap();
    for did in [signed_repo::ALICE, BOB, CAROL] {
        db.repositories()
            .upsert_user(User::new(did, NOW))
            .await
            .unwrap();
    }
    let fixture = WritePds::new(&db, replies, None).await;
    let worker = Arc::new(
        OutboxWorker::new(db.repositories(), fixture.client.clone()).with_jitter(Arc::new(Zero)),
    );
    let cfg = config(path);
    let issued = session::issue(&db, cfg.encryption_key(), signed_repo::ALICE, now())
        .await
        .unwrap();
    let state = AppState::new(cfg, Some(db.clone()))
        .with_clock(Arc::new(Frozen))
        .with_outbox(worker.clone());
    (temp, db, fixture, worker, state, issued)
}
async fn request(
    state: AppState,
    issued: &session::IssuedSession,
    method: &str,
    subject: &str,
    body: Option<Value>,
) -> (u16, Value, Option<String>) {
    let response = atmusic_server::router_with_state(state)
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/api/v1/follows/{subject}"))
                .header("origin", "https://app.fixture.test")
                .header("cookie", issued.cookie.split(';').next().unwrap())
                .header("x-csrf-token", &issued.csrf_token)
                .body(Body::from(
                    body.map(|body| body.to_string()).unwrap_or_default(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .map(|header| header.to_str().unwrap().into());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value, location)
}
fn follow(subject: &str) -> Value {
    json!({"$type":format!("{PREFIX}.follow"),"subject":subject,"createdAt":NOW})
}
fn path(rkey: &str) -> String {
    format!("{PREFIX}.follow/{rkey}")
}
async fn seed_remote(db: &Database, fixture: &WritePds, records: Vec<(String, Value)>) {
    let mut remote = fixture.state.lock().await;
    for (path, value) in records {
        let alphabet = b"234567abcdefghijklmnopqrstuvwxyz";
        let mut revision = remote.fixture.event.revision.as_bytes().to_vec();
        for ch in revision.iter_mut().rev() {
            let index = alphabet
                .iter()
                .position(|candidate| candidate == ch)
                .unwrap();
            *ch = alphabet[(index + 1) % alphabet.len()];
            if index + 1 < alphabet.len() {
                break;
            }
        }
        remote.fixture = signed_repo::signed_mutation(
            &remote.fixture,
            &path,
            Some(value.clone()),
            7,
            &String::from_utf8(revision).unwrap(),
        )
        .await;
        let cid = remote.fixture.record_cids[0].to_string();
        remote.cids.insert(path.clone(), cid);
        remote.records.insert(path, value);
    }
    let verified = verify_snapshot(
        &remote.fixture.event.blocks,
        signed_repo::ALICE,
        &namespace(),
        now(),
        &signed_repo::FixtureResolver(remote.fixture.key.clone()),
    )
    .await
    .unwrap();
    let mutations = verified
        .mutations()
        .iter()
        .filter_map(|mutation| match mutation {
            VerifiedMutation::Put { uri, cid, record } => match record.as_ref() {
                VerifiedRecord::Follow(record) => Some(RecordMutation::Follow(FollowRow {
                    uri: uri.clone(),
                    cid: cid.to_string(),
                    actor: verified.did().into(),
                    subject: record.subject.clone(),
                    revision: verified.revision().into(),
                    created_at: record.created_at.clone(),
                    indexed_at: NOW.into(),
                    confirmed: true,
                })),
                _ => None,
            },
            _ => None,
        })
        .collect();
    db.repositories()
        .apply_event(RepositoryEvent {
            checkpoint: Checkpoint {
                relay: "signed-follow-fixture".into(),
                sequence: 1,
                revision: Some(verified.revision().into()),
                indexed_at: NOW.into(),
            },
            mutations,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn self_and_duplicate() {
    let (_temp, db, fixture, worker, state, issued) = prepare(vec![]).await;
    assert_eq!(
        request(state.clone(), &issued, "PUT", signed_repo::ALICE, None)
            .await
            .0,
        422
    );
    assert_eq!(
        request(
            state.clone(),
            &issued,
            "PUT",
            BOB,
            Some(json!({"actor":CAROL}))
        )
        .await
        .0,
        422
    );
    let first = request(state.clone(), &issued, "PUT", BOB, None).await;
    assert_eq!(first.0, 202, "{}", first.1);
    let second = request(state.clone(), &issued, "PUT", BOB, None).await;
    assert_eq!(second.0, 202);
    assert_eq!(first.1, second.1);
    assert_eq!(db.repositories().public_counts(BOB).await.unwrap().1, 0);
    assert_eq!(
        db.repositories().outbox_due(NOW, 100).await.unwrap().len(),
        1
    );
    worker.run_due(now()).await.unwrap();
    let confirmed = request(state, &issued, "PUT", BOB, None).await;
    assert_eq!(confirmed.0, 200);
    assert_eq!(confirmed.1["follow"]["actor"], signed_repo::ALICE);
    assert_eq!(confirmed.1["follow"]["subject"], BOB);
    assert_eq!(db.repositories().public_counts(BOB).await.unwrap().1, 1);
    let remote = fixture.state.lock().await;
    assert_eq!(remote.calls, 1);
    assert_eq!(remote.payloads[0]["repo"], signed_repo::ALICE);
    assert_eq!(remote.payloads[0]["rkey"], follow_rkey(BOB).unwrap());
    assert_eq!(remote.records.len(), 2);
    drop(remote);
    db.close().await;
}

#[tokio::test]
async fn restart_follow() {
    let (temp, db, fixture, _worker, state, issued) = prepare(vec![Reply::CrashAfterCommit]).await;
    let response = request(state, &issued, "PUT", BOB, None).await;
    let id = response.1["operationId"].as_str().unwrap().to_string();
    db.repositories()
        .begin_attempt(id.clone(), NOW.into())
        .await
        .unwrap();
    let item = db
        .repositories()
        .outbox_due(NOW, 10)
        .await
        .unwrap()
        .pop()
        .unwrap();
    let _lost = fixture.client.execute(&item, now()).await;
    assert_eq!(db.repositories().public_counts(BOB).await.unwrap().1, 0);
    assert_eq!(fixture.state.lock().await.calls, 1);
    db.close().await;
    let reopened = Database::open(temp.path().join("music.sqlite"))
        .await
        .unwrap();
    let worker = OutboxWorker::new(
        reopened.repositories(),
        fixture.rebuild_for(&reopened).await,
    )
    .with_jitter(Arc::new(Zero));
    worker.run_due(now()).await.unwrap();
    assert_eq!(
        reopened
            .repositories()
            .operation(signed_repo::ALICE, &id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert_eq!(
        reopened.repositories().public_counts(BOB).await.unwrap().1,
        1
    );
    assert_eq!(fixture.state.lock().await.calls, 1);
    reopened.close().await;
}

#[tokio::test]
async fn unfollow_absent() {
    let (_temp, db, fixture, worker, state, issued) = prepare(vec![]).await;
    assert_eq!(
        request(state.clone(), &issued, "DELETE", BOB, None).await.0,
        204
    );
    seed_remote(
        &db,
        &fixture,
        vec![
            (path(&follow_rkey(BOB).unwrap()), follow(BOB)),
            (path(&follow_rkey(CAROL).unwrap()), follow(CAROL)),
        ],
    )
    .await;
    let queued = request(state.clone(), &issued, "DELETE", BOB, None).await;
    assert_eq!(queued.0, 202, "{}", queued.1);
    assert_eq!(
        db.repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .2,
        1
    );
    worker.run_due(now()).await.unwrap();
    assert_eq!(request(state, &issued, "DELETE", BOB, None).await.0, 204);
    let remote = fixture.state.lock().await;
    assert!(
        !remote
            .records
            .contains_key(&path(&follow_rkey(BOB).unwrap()))
    );
    assert!(
        remote
            .records
            .contains_key(&path(&follow_rkey(CAROL).unwrap()))
    );
    drop(remote);
    db.close().await;
}

#[tokio::test]
async fn aggregate_duplicates_and_ordered_intents() {
    let (_temp, db, fixture, worker, state, issued) = prepare(vec![]).await;
    seed_remote(
        &db,
        &fixture,
        vec![
            (path("external-a"), follow(BOB)),
            (path("external-z"), follow(BOB)),
        ],
    )
    .await;
    let removed = request(state.clone(), &issued, "DELETE", BOB, None).await;
    assert_eq!(removed.0, 202, "{}", removed.1);
    assert_eq!(db.repositories().public_counts(BOB).await.unwrap().1, 0);
    let created = request(state.clone(), &issued, "PUT", BOB, None).await;
    assert_eq!(created.0, 202);
    assert_ne!(created.1["operationId"], removed.1["operationId"]);
    let removed_again = request(state, &issued, "DELETE", BOB, None).await;
    assert_eq!(removed_again.0, 202);
    assert_ne!(removed_again.1["operationId"], removed.1["operationId"]);
    assert_eq!(
        db.repositories().outbox_due(NOW, 100).await.unwrap().len(),
        1
    );
    worker.run_due(now()).await.unwrap();
    assert_eq!(
        db.repositories()
            .operation(
                signed_repo::ALICE,
                removed.1["operationId"].as_str().unwrap()
            )
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert_eq!(
        db.repositories().outbox_due(NOW, 100).await.unwrap().len(),
        1
    );
    worker.run_due(now()).await.unwrap();
    assert_eq!(
        db.repositories()
            .operation(
                signed_repo::ALICE,
                created.1["operationId"].as_str().unwrap()
            )
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert_eq!(
        db.repositories().public_counts(BOB).await.unwrap().1,
        0,
        "later delete intent stays hidden during predecessor create"
    );
    worker.run_due(now()).await.unwrap();
    assert_eq!(
        db.repositories()
            .operation(
                signed_repo::ALICE,
                removed_again.1["operationId"].as_str().unwrap()
            )
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    let remote = fixture.state.lock().await;
    assert!(
        remote
            .records
            .keys()
            .all(|key| !key.starts_with(&format!("{PREFIX}.follow/")))
    );
    assert_eq!(remote.calls, 4);
    drop(remote);
    db.close().await;
}

#[tokio::test]
async fn failed_unfollow_is_not_absent_and_refollow_reconciles() {
    let (_temp, db, fixture, worker, state, issued) =
        prepare(vec![Reply::Permanent("Forbidden")]).await;
    let mut original = follow(BOB);
    original["createdAt"] = json!("2025-12-01T12:00:00Z");
    seed_remote(
        &db,
        &fixture,
        vec![(path(&follow_rkey(BOB).unwrap()), original.clone())],
    )
    .await;
    let removed = request(state.clone(), &issued, "DELETE", BOB, None).await;
    assert_eq!(removed.0, 202);
    worker.run_due(now()).await.unwrap();
    let failed = request(state.clone(), &issued, "DELETE", BOB, None).await;
    assert_eq!(failed.0, 502);
    assert_eq!(failed.1["error"]["code"], "deletion_failed");
    assert_eq!(
        failed.2,
        Some(format!(
            "/api/v1/operations/{}",
            removed.1["operationId"].as_str().unwrap()
        ))
    );
    let created = request(state, &issued, "PUT", BOB, None).await;
    assert_eq!(created.0, 202);
    worker.run_due(now()).await.unwrap();
    assert_eq!(db.repositories().public_counts(BOB).await.unwrap().1, 1);
    assert_eq!(
        db.repositories()
            .follow_list(signed_repo::ALICE, false, 100)
            .await
            .unwrap()[0]
            .created_at,
        "2025-12-01T12:00:00.000000000Z"
    );
    assert_eq!(
        fixture.state.lock().await.records[&path(&follow_rkey(BOB).unwrap())],
        original
    );
    assert_eq!(
        fixture.state.lock().await.calls,
        1,
        "same verified remote edge is reconciled without overwriting it"
    );
    db.close().await;
}

#[tokio::test]
async fn publisher_unavailable() {
    let (_temp, db, _fixture, _worker, state, issued) = prepare(vec![]).await;
    let mut state = state;
    state.outbox = None;
    assert_eq!(
        request(state.clone(), &issued, "PUT", BOB, None).await.0,
        503
    );
    assert_eq!(request(state, &issued, "DELETE", BOB, None).await.0, 204);
    assert_eq!(
        db.repositories().outbox_due(NOW, 100).await.unwrap().len(),
        0
    );
    db.close().await;
}

#[tokio::test]
async fn aggregate_does_not_acknowledge_partial_removal() {
    let (_temp, db, fixture, worker, state, issued) =
        prepare(vec![Reply::Status(200, None), Reply::Timeout]).await;
    seed_remote(
        &db,
        &fixture,
        vec![
            (path("external-a"), follow(BOB)),
            (path("external-z"), follow(BOB)),
        ],
    )
    .await;
    let queued = request(state, &issued, "DELETE", BOB, None).await;
    assert_eq!(queued.0, 202);
    let id = queued.1["operationId"].as_str().unwrap();
    worker.run_due(now()).await.unwrap();
    let pending = db
        .repositories()
        .operation(signed_repo::ALICE, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.state, "pending");
    assert_eq!(pending.attempts, 1);
    assert_eq!(db.repositories().public_counts(BOB).await.unwrap().1, 0);
    assert!(
        !fixture
            .state
            .lock()
            .await
            .records
            .contains_key(&path("external-a"))
    );
    assert!(
        fixture
            .state
            .lock()
            .await
            .records
            .contains_key(&path("external-z"))
    );
    worker
        .run_due(now() + chrono::Duration::seconds(1))
        .await
        .unwrap();
    assert_eq!(
        db.repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert_eq!(fixture.state.lock().await.calls, 3);
    assert!(
        !fixture
            .state
            .lock()
            .await
            .records
            .contains_key(&path("external-z"))
    );
    db.close().await;
}

#[tokio::test]
async fn remote_follow_subject_change_is_preserved() {
    let (_temp, db, fixture, worker, state, issued) =
        prepare(vec![Reply::ChangeBeforeDelete(follow(CAROL))]).await;
    seed_remote(
        &db,
        &fixture,
        vec![(path(&follow_rkey(BOB).unwrap()), follow(BOB))],
    )
    .await;
    let queued = request(state, &issued, "DELETE", BOB, None).await;
    let id = queued.1["operationId"].as_str().unwrap();
    worker.run_due(now()).await.unwrap();
    assert_eq!(
        db.repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    worker
        .run_due(now() + chrono::Duration::seconds(1))
        .await
        .unwrap();
    let failed = db
        .repositories()
        .operation(signed_repo::ALICE, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.state, "failed");
    assert_eq!(
        failed.failure_code.as_deref(),
        Some("remote_record_conflict")
    );
    let remote = fixture.state.lock().await;
    assert_eq!(remote.calls, 1);
    assert_eq!(
        remote.records[&path(&follow_rkey(BOB).unwrap())]["subject"],
        CAROL
    );
    drop(remote);
    db.close().await;
}

#[tokio::test]
async fn unknown_remote_duplicate_prevents_false_success() {
    let (_temp, db, fixture, worker, state, issued) = prepare(vec![]).await;
    seed_remote(&db, &fixture, vec![(path("external-a"), follow(BOB))]).await;
    let queued = request(state, &issued, "DELETE", BOB, None).await;
    let id = queued.1["operationId"].as_str().unwrap();
    // An external writer adds a second signed record after the bounded intent was persisted.
    seed_remote(&db, &fixture, vec![(path("external-new"), follow(BOB))]).await;
    worker.run_due(now()).await.unwrap();
    let failed = db
        .repositories()
        .operation(signed_repo::ALICE, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.state, "failed");
    assert_eq!(failed.failure_code.as_deref(), Some("remote_edge_changed"));
    let remote = fixture.state.lock().await;
    assert!(!remote.records.contains_key(&path("external-a")));
    assert!(remote.records.contains_key(&path("external-new")));
    assert_eq!(remote.calls, 1);
    drop(remote);
    db.close().await;
}
