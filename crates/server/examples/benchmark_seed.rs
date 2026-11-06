//! Test-only fixed dataset; every projected row passes the production signed-repo verifier.
#[path = "../tests/common/bulk_repo.rs"]
mod bulk_repo;
use atmusic_server::auth::session;
use atmusic_storage::Database;
use chrono::Utc;
use serde_json::json;
use std::{fs::OpenOptions, io::Write, path::PathBuf};

#[tokio::main]
async fn main() {
    let directory = PathBuf::from(std::env::args().nth(1).expect("new dataset directory"));
    assert!(!directory.exists(), "dataset directory must be new");
    std::fs::create_dir_all(&directory).unwrap();
    let db = Database::open(directory.join("music.sqlite"))
        .await
        .unwrap();
    bulk_repo::seed_benchmark(&db).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM scrobbles WHERE confirmed=1")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 100_000);
    let key = [0x71; 32];
    let issued = session::issue(&db, &key, "did:web:benchmark-000.test", Utc::now())
        .await
        .unwrap();
    let credentials = json!({"key":hex::encode(key),"cookie":issued.cookie.split(';').next().unwrap(),"rows":count,"users":100,"rowsPerUser":1000,"seed":7});
    let path = directory.join("fixture-access.json");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .unwrap()
        .write_all(credentials.to_string().as_bytes())
        .unwrap();
    db.close().await;
    println!("verified dataset: 100000 active records; 100 users; 1000 records/user; seed 7");
}
