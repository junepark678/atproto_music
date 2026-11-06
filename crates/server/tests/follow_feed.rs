//! Follow membership and account activity affect each public read through verified state.
mod common;
#[path = "common/read_projection.rs"]
mod projection;
use async_trait::async_trait;
use atmusic_atproto::sync::backfill::{
    BackfillCoordinator, BackfillError, FetchedSnapshot, ReceiptClock, SnapshotSource,
};
use atmusic_core::namespace::Namespace;
use atmusic_server::auth::session;
use projection::signed_repo;
use projection::{ALICE, AS_OF, BOB, CAROL, items, server, uri};
use serde_json::Value;
use std::sync::Arc;
fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(AS_OF)
        .unwrap()
        .with_timezone(&chrono::Utc)
}
async fn cookie(server: &common::TestServer) -> String {
    session::issue(&server.database, &[0x11; 32], ALICE, now())
        .await
        .unwrap()
        .cookie
        .split(';')
        .next()
        .unwrap()
        .into()
}
async fn feed(server: &common::TestServer, cookie: &str) -> Vec<String> {
    let response = server
        .client
        .get(server.url("/api/v1/feed"))
        .query(&[("scope", "following")])
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    items(&response.json::<Value>().await.unwrap())
}
async fn following(server: &common::TestServer) -> Vec<String> {
    let response = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/following")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    items(&response.json::<Value>().await.unwrap())
}

#[tokio::test]
async fn pending_confirmed() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let cookie = cookie(&server).await;
    let key = atmusic_core::follow::follow_rkey(BOB).unwrap();
    fixtures
        .delete(&server, ALICE, &projection::follow_uri(ALICE, BOB))
        .await;
    let op = atmusic_atproto::pds::follow::operation(
        ALICE,
        BOB,
        &Namespace::new("com.example.atmusic").unwrap(),
        now(),
        true,
        "pending-edge".into(),
    )
    .unwrap();
    server
        .database
        .repositories()
        .admit_operation(op, None)
        .await
        .unwrap();
    assert!(feed(&server, &cookie).await.is_empty());
    assert!(following(&server).await.is_empty());
    // A signed remote confirmation can arrive through ingestion before the local queue is acknowledged.
    fixtures.put_follow(&server, ALICE, &key, BOB).await;
    assert_eq!(feed(&server, &cookie).await, [uri(BOB, "r09")]);
    assert_eq!(
        following(&server).await,
        [projection::follow_uri(ALICE, BOB)]
    );
    assert_eq!(
        server
            .database
            .repositories()
            .operation(ALICE, "pending-edge")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn unfollow_target() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let cookie = cookie(&server).await;
    fixtures
        .put_follow(
            &server,
            ALICE,
            &atmusic_core::follow::follow_rkey(CAROL).unwrap(),
            CAROL,
        )
        .await;
    assert_eq!(
        feed(&server, &cookie).await,
        [uri(BOB, "r09"), uri(CAROL, "r10")]
    );
    fixtures
        .delete(&server, ALICE, &projection::follow_uri(ALICE, BOB))
        .await;
    assert_eq!(feed(&server, &cookie).await, [uri(CAROL, "r10")]);
    assert_eq!(
        server
            .database
            .repositories()
            .public_counts(ALICE)
            .await
            .unwrap()
            .2,
        1
    );
    assert_eq!(
        server
            .database
            .repositories()
            .history(BOB, Default::default())
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(!server.shutdown().await.timed_out);
}
struct Clock;
impl ReceiptClock for Clock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        now()
    }
}
struct Source(Vec<u8>);
#[async_trait]
impl SnapshotSource for Source {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        assert_eq!(did, BOB);
        Ok(FetchedSnapshot {
            pds: "https://pds-bob.fixture.test".into(),
            bytes: self.0.clone(),
        })
    }
}
#[tokio::test]
async fn account_state() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let cookie = cookie(&server).await;
    fixtures
        .put_follow(
            &server,
            ALICE,
            &atmusic_core::follow::follow_rkey(CAROL).unwrap(),
            CAROL,
        )
        .await;
    let repo = server.database.repositories();
    assert_eq!(
        feed(&server, &cookie).await,
        [uri(BOB, "r09"), uri(CAROL, "r10")]
    );
    repo.account_inactive(BOB.into(), AS_OF.into())
        .await
        .unwrap();
    assert_eq!(feed(&server, &cookie).await, [uri(CAROL, "r10")]);
    assert_eq!(
        following(&server).await,
        [projection::follow_uri(ALICE, CAROL)]
    );
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 0);
    let read: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/read_models.json")).unwrap();
    let record = read["scrobbles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["owner"] == BOB && record["state"] == "confirmed")
        .unwrap();
    let signed = signed_repo::signed_repo_for(
        BOB,
        vec![(
            format!(
                "com.example.atmusic.scrobble/{}",
                record["rkey"].as_str().unwrap()
            ),
            record["record"].clone(),
        )],
        2,
        "3m3ijqc2abc22",
    )
    .await;
    let backfill = Arc::new(BackfillCoordinator::new(
        repo.clone(),
        Namespace::new("com.example.atmusic").unwrap(),
        Arc::new(Source(signed.event.blocks)),
        Arc::new(signed_repo::FixtureResolver(signed.key)),
        Arc::new(Clock),
    ));
    backfill.schedule(BOB, true).await.unwrap();
    assert_eq!(feed(&server, &cookie).await, [uri(CAROL, "r10")]);
    assert_eq!(repo.public_counts(ALICE).await.unwrap().2, 1);
    let results = backfill.run_batch().await.unwrap();
    assert!(results[0].result.is_ok());
    assert!(repo.backfill(BOB).await.unwrap().unwrap().backfill_complete);
    assert_eq!(
        feed(&server, &cookie).await,
        [uri(BOB, "r09"), uri(CAROL, "r10")]
    );
    assert_eq!(following(&server).await.len(), 2);
    assert_eq!(repo.public_counts(ALICE).await.unwrap().2, 2);
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 1);
    assert!(!server.shutdown().await.timed_out);
}
