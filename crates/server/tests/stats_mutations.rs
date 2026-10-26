//! M5.1.3 lives in server integration tests to cross the real signature gate
//! without introducing a storage -> atproto dependency cycle.
#[path = "common/bulk_repo.rs"]
mod bulk_repo;
mod common;
#[path = "common/read_projection.rs"]
mod projection;
use atmusic_storage::StatisticsWindow;
use chrono::{Duration, SecondsFormat};
use projection::{ALICE, CANONICAL_AS_OF};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tracing_subscriber::{Layer, layer::Context, prelude::*};

async fn statistics(server: &common::TestServer) -> Value {
    let response = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/stats?window=all")))
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
    json!(values.iter().map(|(artist,track,count)|json!({"artist":artist,"track":track,"scrobbleCount":count})).collect::<Vec<_>>())
}
fn albums(values: &[(&str, &str, u64)]) -> Value {
    json!(values.iter().map(|(artist,album,count)|json!({"artist":artist,"album":album,"scrobbleCount":count})).collect::<Vec<_>>())
}

#[tokio::test]
async fn delete_effect() {
    let (server, _) = projection::server().await;
    let mut fixtures = projection::seed(&server, true).await;
    fixtures
        .delete(&server, ALICE, &projection::uri(ALICE, "r01"))
        .await;
    assert!(fixtures.excluded.is_empty());
    assert_eq!(
        statistics(&server).await,
        json!({
            "did":ALICE,"window":"all","asOf":CANONICAL_AS_OF,"totalScrobbles":6,"distinctArtists":3,"distinctTracks":6,
            "topArtists":artists(&[("Radiohead",3),("Kate Bush",2),("  BJÖRK  ",1)]),
            "topTracks":tracks(&[("  BJÖRK  ","jóga",1),("Kate Bush","Cloudbusting",1),("Kate Bush","Running Up That Hill",1),("Radiohead","Karma Police",1),("Radiohead","No Surprises",1),("Radiohead","Weird Fishes",1)]),
            "topAlbums":albums(&[("Radiohead","OK Computer",2),("  BJÖRK  "," HOMOGENIC ",1),("Kate Bush","Hounds of Love",1),("Radiohead","In Rainbows",1)]),
        })
    );
    let history: Value = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/scrobbles")))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let actual: Vec<_> = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["uri"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        actual,
        ["r07", "r02", "r03", "r04", "r05", "r06"].map(|key| projection::uri(ALICE, key))
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn update_artist() {
    let (server, _) = projection::server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let uri = projection::uri(ALICE, "r03");
    let mut before = server
        .database
        .repositories()
        .scrobble(&uri)
        .await
        .unwrap()
        .unwrap();
    let old_cid = before.cid.clone();
    before.artist = "Björk".into();
    fixtures.update(&server, before).await;
    assert!(fixtures.excluded.is_empty());
    let after = server
        .database
        .repositories()
        .scrobble(&uri)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.uri, uri);
    assert_ne!(after.cid, old_cid);
    assert_eq!(after.artist, "Björk");
    assert_eq!(
        statistics(&server).await,
        json!({
            "did":ALICE,"window":"all","asOf":CANONICAL_AS_OF,"totalScrobbles":7,"distinctArtists":3,"distinctTracks":6,
            "topArtists":artists(&[("Björk",3),("Kate Bush",2),("Radiohead",2)]),
            "topTracks":tracks(&[("Björk","Jóga",2),("Björk","Weird Fishes",1),("Kate Bush","Cloudbusting",1),("Kate Bush","Running Up That Hill",1),("Radiohead","Karma Police",1),("Radiohead","No Surprises",1)]),
            "topAlbums":albums(&[("Björk","Homogenic",2),("Radiohead","OK Computer",2),("Björk","In Rainbows",1),("Kate Bush","Hounds of Love",1)]),
        })
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM scrobbles WHERE did=? AND confirmed=1")
            .bind(ALICE)
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap();
    assert_eq!(rows, 7);
    assert!(!server.shutdown().await.timed_out);
}

#[derive(Clone)]
struct SqlStatements(Arc<Mutex<Vec<String>>>);
struct StatementVisitor(Option<String>);
impl tracing::field::Visit for StatementVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "db.statement" {
            self.0 = Some(value.trim().into());
        }
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "db.statement" {
            self.0 = Some(format!("{value:?}"));
        }
    }
}
impl<S: tracing::Subscriber> Layer<S> for SqlStatements {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        if event.metadata().target() != "sqlx::query" {
            return;
        }
        let mut visitor = StatementVisitor(None);
        event.record(&mut visitor);
        if let Some(sql) = visitor.0.filter(|sql| {
            sql.starts_with("SELECT s.* FROM scrobbles") && sql.contains("s.listened_at<=")
        }) {
            self.0.lock().unwrap().push(sql);
        }
    }
}
async fn explain(
    server: &common::TestServer,
    sql: &str,
    window: StatisticsWindow,
    negative: bool,
) -> Vec<String> {
    let now = CANONICAL_AS_OF
        .parse::<chrono::DateTime<chrono::Utc>>()
        .unwrap();
    let suffix = if negative {
        " /* isolated index-drop control */"
    } else {
        ""
    };
    let query = format!("EXPLAIN QUERY PLAN {sql}{suffix}");
    let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(&query)
        .bind("did:web:benchmark-000.test")
        .bind(CANONICAL_AS_OF);
    if let Some(days) = window.days() {
        query =
            query.bind((now - Duration::days(days)).to_rfc3339_opts(SecondsFormat::Nanos, true));
    }
    let rows = if negative {
        use sqlx::Connection;
        let mut connection = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&server.database_path)
                .read_only(true),
        )
        .await
        .unwrap();
        let indexes:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN('scrobbles_owner_time','scrobbles_stats','scrobbles_global_time')").fetch_one(&mut connection).await.unwrap();
        assert_eq!(indexes, 0, "owned negative-control indexes removed");
        let rows = query.fetch_all(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        rows
    } else {
        query
            .fetch_all(server.database.reader_pool())
            .await
            .unwrap()
    };
    rows.into_iter().map(|(_, _, _, detail)| detail).collect()
}
fn indexed_did_time(plan: &[String]) -> bool {
    plan.iter().any(|line| {
        let upper = line.to_ascii_uppercase();
        upper.contains("SEARCH S USING INDEX")
            && upper.contains("DID=?")
            && upper.contains("LISTENED_AT")
    }) && !plan.iter().any(|line| {
        let upper = line.to_ascii_uppercase();
        upper.contains("SCAN S") || upper.contains("SCAN SCROBBLES")
    })
}
#[tokio::test]
async fn query_plan() {
    let (server, _) = projection::server().await;
    bulk_repo::seed_benchmark(&server.database).await;
    let statements = SqlStatements(Arc::new(Mutex::new(Vec::new())));
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(statements.clone()),
    )
    .unwrap();
    let now = CANONICAL_AS_OF
        .parse::<chrono::DateTime<chrono::Utc>>()
        .unwrap();
    let mut seven_days = None;
    for window in [
        StatisticsWindow::All,
        StatisticsWindow::SevenDays,
        StatisticsWindow::ThirtyDays,
        StatisticsWindow::Year,
    ] {
        statements.0.lock().unwrap().clear();
        let stats = server
            .database
            .repositories()
            .statistics("did:web:benchmark-000.test", window, now, 20)
            .await
            .unwrap();
        assert_eq!(stats.total_scrobbles, 1000);
        let sql = statements
            .0
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|sql| sql.contains("s.listened_at>=") == window.days().is_some())
            .cloned()
            .expect("capture actual production statistics SQL");
        let plan = explain(&server, &sql, window, false).await;
        assert!(
            indexed_did_time(&plan),
            "indexed DID/time plan for {window:?}: {plan:?}"
        );
        if window == StatisticsWindow::SevenDays {
            seven_days = Some(sql);
        }
    }
    // This owned temporary schema is a real negative control, not an invented plan string.
    server
        .database
        .writer()
        .execute(|connection| {
            Box::pin(async move {
                for sql in [
                    "DROP INDEX scrobbles_owner_time",
                    "DROP INDEX scrobbles_stats",
                    "DROP INDEX scrobbles_global_time",
                ] {
                    sqlx::query(sql).execute(&mut *connection).await?;
                }
                Ok(())
            })
        })
        .await
        .unwrap();
    let plan = explain(
        &server,
        &seven_days.unwrap(),
        StatisticsWindow::SevenDays,
        true,
    )
    .await;
    assert!(
        !indexed_did_time(&plan),
        "missing-index control must reject {plan:?}"
    );
    assert!(
        plan.iter().any(|line| line.starts_with("SCAN s")),
        "actual global scan after owned index removal: {plan:?}"
    );
    assert!(!server.shutdown().await.timed_out);
}
