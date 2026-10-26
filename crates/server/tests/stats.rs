//! HTTP/SQLite statistics from signed repository fixtures checked by the
//! production verifier. Live federation evidence remains a separate gate.
mod common;
#[path = "common/read_projection.rs"]
mod projection;

use std::sync::atomic::Ordering;

use atmusic_core::scrobble::ScrobbleInput;
use atmusic_storage::User;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use projection::{ALICE, AS_OF, CANONICAL_AS_OF, server};
use serde_json::{Value, json};

fn at(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

async fn stats(server: &common::TestServer, did: &str, query: &str) -> Value {
    let response = server
        .client
        .get(server.url(&format!("/api/v1/users/{did}/stats{query}")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}

fn artists(values: &[(&str, u64)]) -> Value {
    json!(
        values
            .iter()
            .map(|(artist, count)| json!({"artist":artist,"scrobbleCount":count}))
            .collect::<Vec<_>>()
    )
}
fn tracks(values: &[(&str, &str, u64)]) -> Value {
    json!(values.iter().map(|(artist, track, count)| json!({"artist":artist,"track":track,"scrobbleCount":count})).collect::<Vec<_>>())
}
fn albums(values: &[(&str, &str, u64)]) -> Value {
    json!(values.iter().map(|(artist, album, count)| json!({"artist":artist,"album":album,"scrobbleCount":count})).collect::<Vec<_>>())
}

#[tokio::test]
async fn window_totals() {
    let (server, _) = server().await;
    projection::seed(&server, true).await;
    let expected = [
        (
            "all",
            7,
            3,
            6,
            artists(&[("Radiohead", 3), ("Björk", 2), ("Kate Bush", 2)]),
            tracks(&[
                ("Björk", "Jóga", 2),
                ("Kate Bush", "Cloudbusting", 1),
                ("Kate Bush", "Running Up That Hill", 1),
                ("Radiohead", "Karma Police", 1),
                ("Radiohead", "No Surprises", 1),
                ("Radiohead", "Weird Fishes", 1),
            ]),
            albums(&[
                ("Björk", "Homogenic", 2),
                ("Radiohead", "OK Computer", 2),
                ("Kate Bush", "Hounds of Love", 1),
                ("Radiohead", "In Rainbows", 1),
            ]),
        ),
        (
            "7d",
            4,
            2,
            3,
            artists(&[("Björk", 2), ("Radiohead", 2)]),
            tracks(&[
                ("Björk", "Jóga", 2),
                ("Radiohead", "No Surprises", 1),
                ("Radiohead", "Weird Fishes", 1),
            ]),
            albums(&[
                ("Björk", "Homogenic", 2),
                ("Radiohead", "In Rainbows", 1),
                ("Radiohead", "OK Computer", 1),
            ]),
        ),
        (
            "30d",
            5,
            2,
            4,
            artists(&[("Radiohead", 3), ("Björk", 2)]),
            tracks(&[
                ("Björk", "Jóga", 2),
                ("Radiohead", "Karma Police", 1),
                ("Radiohead", "No Surprises", 1),
                ("Radiohead", "Weird Fishes", 1),
            ]),
            albums(&[
                ("Björk", "Homogenic", 2),
                ("Radiohead", "OK Computer", 2),
                ("Radiohead", "In Rainbows", 1),
            ]),
        ),
        (
            "365d",
            6,
            3,
            5,
            artists(&[("Radiohead", 3), ("Björk", 2), ("Kate Bush", 1)]),
            tracks(&[
                ("Björk", "Jóga", 2),
                ("Kate Bush", "Running Up That Hill", 1),
                ("Radiohead", "Karma Police", 1),
                ("Radiohead", "No Surprises", 1),
                ("Radiohead", "Weird Fishes", 1),
            ]),
            albums(&[
                ("Björk", "Homogenic", 2),
                ("Radiohead", "OK Computer", 2),
                ("Radiohead", "In Rainbows", 1),
            ]),
        ),
    ];
    for (window, total, distinct_artists, distinct_tracks, top_artists, top_tracks, top_albums) in
        expected
    {
        assert_eq!(
            stats(&server, ALICE, &format!("?window={window}")).await,
            json!({"did":ALICE, "window":window, "asOf":CANONICAL_AS_OF,
                "totalScrobbles":total, "distinctArtists":distinct_artists, "distinctTracks":distinct_tracks,
                "topArtists":top_artists, "topTracks":top_tracks, "topAlbums":top_albums}),
            "exact frozen fixture window {window}"
        );
    }
    assert_eq!(
        stats(&server, ALICE, "").await,
        stats(&server, ALICE, "?window=all&limit=10").await
    );
    let limited = stats(&server, ALICE, "?limit=1").await;
    assert_eq!(limited["totalScrobbles"], 7);
    assert_eq!(limited["distinctTracks"], 6);
    assert_eq!(limited["topArtists"], artists(&[("Radiohead", 3)]));
    assert_eq!(limited["topTracks"], tracks(&[("Björk", "Jóga", 2)]));
    assert_eq!(limited["topAlbums"], albums(&[("Björk", "Homogenic", 2)]));
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn boundary_seconds() {
    let (server, clock) = server().await;
    let mut fixtures = projection::seed(&server, false).await;
    let repository = server.database.repositories();
    let now = at(AS_OF);
    for (window, days) in [("7d", 7), ("30d", 30), ("365d", 365)] {
        let did = format!("did:web:boundary-{window}.test");
        repository
            .upsert_user(User::new(&did, AS_OF))
            .await
            .unwrap();
        let lower = now - Duration::days(days);
        for (key, track, time) in [
            ("before", "before", lower - Duration::seconds(1)),
            ("lower", "lower", lower),
            ("upper", "as-of", now),
            ("future", "future", now + Duration::seconds(1)),
        ] {
            let record = json!({"artist":"Boundary", "track":track, "listenedAt":time.to_rfc3339_opts(SecondsFormat::Nanos,true), "createdAt":AS_OF});
            assert!(
                ScrobbleInput::from_json(
                    &json!({"artist":"Boundary", "track":track, "listenedAt":record["listenedAt"]}),
                    now
                )
                .is_ok(),
                "future listen is schema valid"
            );
            fixtures.put(&server, &did, key, record).await;
            assert!(
                fixtures.excluded.is_empty(),
                "signed boundary record must pass schema validation"
            );
        }
        let body = stats(&server, &did, &format!("?window={window}")).await;
        assert_eq!(
            body["totalScrobbles"], 2,
            "inclusive lower and upper {window}"
        );
        assert_eq!(
            body["topTracks"],
            tracks(&[("Boundary", "as-of", 1), ("Boundary", "lower", 1)])
        );
        assert_eq!(body["topAlbums"], json!([]));
        clock.0.store(now.timestamp() + 1, Ordering::SeqCst);
        let advanced = stats(&server, &did, &format!("?window={window}")).await;
        assert_eq!(
            advanced["totalScrobbles"], 2,
            "new lower bound removes old boundary while future enters"
        );
        assert_eq!(
            advanced["topTracks"],
            tracks(&[("Boundary", "as-of", 1), ("Boundary", "future", 1)])
        );
        clock.0.store(now.timestamp(), Ordering::SeqCst);
    }
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn ranking_ties() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, false).await;
    let repository = server.database.repositories();
    let did = "did:web:tuple.test";
    repository.upsert_user(User::new(did, AS_OF)).await.unwrap();
    for (key, artist, track, time) in [
        ("tuple-one", "a|b", "c", AS_OF),
        ("tuple-two", "a", "b|c", AS_OF),
        ("fold-old", "STRASSE", "x", "2026-01-15T11:00:00Z"),
        ("fold-new", "Straße", "x", "2026-01-15T11:30:00Z"),
    ] {
        fixtures
            .put(
                &server,
                did,
                key,
                json!({"artist":artist,"track":track,"listenedAt":time,"createdAt":AS_OF}),
            )
            .await;
        assert!(
            fixtures.excluded.is_empty(),
            "signed grouping record must pass schema validation"
        );
    }
    let body = stats(&server, did, "").await;
    assert_eq!(body["totalScrobbles"], 4);
    assert_eq!(body["distinctArtists"], 3);
    assert_eq!(
        body["distinctTracks"], 3,
        "tuple collision must not collapse SQLite rows"
    );
    assert_eq!(
        body["topArtists"],
        artists(&[("Straße", 2), ("a", 1), ("a|b", 1)])
    );
    assert_eq!(
        body["topTracks"],
        tracks(&[("Straße", "x", 2), ("a", "b|c", 1), ("a|b", "c", 1)])
    );
    for (query, field) in [
        ("?window=day", "window"),
        ("?window=", "window"),
        ("?window=all&window=7d", "window"),
        ("?limit=0", "limit"),
        ("?limit=-1", "limit"),
        ("?limit=1.5", "limit"),
        ("?limit=101", "limit"),
        ("?limit=abc", "limit"),
        ("?limit=", "limit"),
        ("?limit=1&limit=2", "limit"),
        ("?cursor=x", "cursor"),
    ] {
        let response = server
            .client
            .get(server.url(&format!("/api/v1/users/{did}/stats{query}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422, "invalid {query}");
        let body: Value = response.json().await.unwrap();
        projection::assert_error(&body, "invalid_query");
        assert!(body["error"]["fields"][field].is_string());
    }
    assert_eq!(
        stats(&server, did, "?limit=100").await,
        body,
        "valid request remains healthy after query failures"
    );
    assert_eq!(
        repository.public_counts(did).await.unwrap().0,
        4,
        "query failures do not mutate state"
    );
    assert!(!server.shutdown().await.timed_out);
}
