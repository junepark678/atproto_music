//! Public social reads use signed repository mutations through the production verifier.
mod common;
#[path = "common/read_projection.rs"]
mod projection;
use atmusic_storage::User;
use projection::{ALICE, AS_OF, BOB, CAROL, items, server};
use serde_json::Value;

async fn page(
    server: &common::TestServer,
    did: &str,
    kind: &str,
    limit: u32,
    cursor: Option<&str>,
) -> Value {
    let mut request = server
        .client
        .get(server.url(&format!("/api/v1/users/{did}/{kind}")))
        .query(&[("limit", limit.to_string())]);
    if let Some(cursor) = cursor {
        request = request.query(&[("cursor", cursor)]);
    }
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body.as_object().unwrap().len(), 4);
    assert_eq!(body["indexing"].as_object().unwrap().len(), 4);
    assert_eq!(
        body["indexing"]["caughtUp"], false,
        "no configured relay can claim catch-up"
    );
    for row in body["items"].as_array().unwrap() {
        assert_eq!(row.as_object().unwrap().len(), 5);
        for field in ["uri", "cid", "actor", "subject", "createdAt"] {
            assert!(row[field].is_string(), "{field}: {row}");
        }
        assert!(row.get("confirmed").is_none());
    }
    body
}
fn edge(actor: &str, rkey: &str) -> String {
    format!("at://{actor}/com.example.atmusic.follow/{rkey}")
}

#[tokio::test]
async fn external_duplicates() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, false).await;
    fixtures
        .put_follow(&server, CAROL, "duplicate-z", BOB)
        .await;
    fixtures
        .put_follow(&server, CAROL, "duplicate-a", BOB)
        .await;
    let repo = server.database.repositories();
    assert_eq!(repo.public_counts(CAROL).await.unwrap().2, 1);
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 1);
    assert_eq!(
        items(&page(&server, CAROL, "following", 100, None).await),
        [edge(CAROL, "duplicate-a")]
    );
    fixtures
        .delete(&server, CAROL, &edge(CAROL, "duplicate-a"))
        .await;
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 1);
    assert_eq!(
        items(&page(&server, BOB, "followers", 100, None).await),
        [edge(CAROL, "duplicate-z")]
    );
    fixtures
        .delete(&server, CAROL, &edge(CAROL, "duplicate-z"))
        .await;
    assert_eq!(repo.public_counts(CAROL).await.unwrap().2, 0);
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 0);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn public_lists() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let repo = server.database.repositories();
    let pending = atmusic_atproto::pds::follow::operation(
        CAROL,
        BOB,
        &atmusic_core::namespace::Namespace::new("com.example.atmusic").unwrap(),
        chrono::DateTime::parse_from_rfc3339(AS_OF)
            .unwrap()
            .with_timezone(&chrono::Utc),
        true,
        "pending-carol".into(),
    )
    .unwrap();
    repo.admit_operation(pending, None).await.unwrap();
    assert_eq!(
        items(&page(&server, ALICE, "following", 100, None).await),
        [projection::follow_uri(ALICE, BOB)]
    );
    assert_eq!(
        items(&page(&server, BOB, "followers", 100, None).await),
        [projection::follow_uri(ALICE, BOB)]
    );
    assert!(items(&page(&server, CAROL, "following", 100, None).await).is_empty());
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 1);
    // Known inactive endpoints and suppression remove distinct edges from counts and lists.
    let mut inactive = User::new(BOB, "2025-01-01T00:00:00Z");
    inactive.active = false;
    repo.upsert_user(inactive).await.unwrap();
    assert_eq!(repo.public_counts(ALICE).await.unwrap().2, 0);
    assert!(items(&page(&server, BOB, "followers", 100, None).await).is_empty());
    // A verified external mutation is still retained while the target account is inactive.
    fixtures.put_follow(&server, CAROL, "external", BOB).await;
    assert_eq!(repo.public_counts(CAROL).await.unwrap().2, 0);
    repo.account_inactive(CAROL.into(), AS_OF.into())
        .await
        .unwrap();
    assert_eq!(repo.public_counts(BOB).await.unwrap().1, 0);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn list_pagination() {
    const DAN: &str = "did:plc:dddddddddddddddddddddddd";
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, false).await;
    server
        .database
        .repositories()
        .upsert_user(User::new(DAN, "2025-01-01T00:00:00Z"))
        .await
        .unwrap();
    for actor in [ALICE, CAROL, DAN] {
        fixtures.put_follow(&server, actor, "same-time", BOB).await;
    }
    let first = page(&server, BOB, "followers", 1, None).await;
    let token = first["nextCursor"].as_str().unwrap();
    for (did, kind) in [(ALICE, "followers"), (BOB, "following")] {
        let response = server
            .client
            .get(server.url(&format!("/api/v1/users/{did}/{kind}")))
            .query(&[("cursor", token)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        projection::assert_error(&response.json::<Value>().await.unwrap(), "invalid_cursor");
    }
    let bad = server
        .client
        .get(server.url(&format!("/api/v1/users/{BOB}/followers")))
        .query(&[("cursor", "invalid")])
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    let mut all = items(&first);
    while let Some(token) = cursor {
        let next = page(&server, BOB, "followers", 1, Some(&token)).await;
        all.extend(items(&next));
        cursor = next["nextCursor"].as_str().map(str::to_owned);
        assert!(all.len() <= 3);
    }
    assert_eq!(
        all,
        [
            edge(DAN, "same-time"),
            edge(CAROL, "same-time"),
            edge(ALICE, "same-time")
        ]
    );
    assert_eq!(
        server
            .database
            .repositories()
            .public_counts(BOB)
            .await
            .unwrap()
            .1,
        3
    );
    assert!(!server.shutdown().await.timed_out);
}
