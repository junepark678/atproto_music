use crate::{StorageError, Writer, migrations, repositories::Repository};
use sqlx::{
    Connection, SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{path::Path, time::Duration};

#[derive(Clone)]
pub struct Database {
    readers: SqlitePool,
    writer: Writer,
}
impl Database {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        if path.exists() {
            let mut probe = SqliteConnection::connect_with(
                &SqliteConnectOptions::new().filename(path).read_only(true),
            )
            .await?;
            let check = migrations::check_version(&mut probe).await;
            probe.close().await?;
            check?;
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| StorageError::Sql(sqlx::Error::Io(e)))?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_millis(5000));
        let mut connection = SqliteConnection::connect_with(&options).await?;
        migrations::embedded().run(&mut connection).await?;
        let readers = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options.clone().create_if_missing(false))
            .await?;
        Ok(Self {
            readers,
            writer: Writer::start(connection),
        })
    }
    pub fn reader_pool(&self) -> &SqlitePool {
        &self.readers
    }
    pub fn writer(&self) -> &Writer {
        &self.writer
    }
    pub fn repositories(&self) -> Repository {
        Repository::new(self.readers.clone(), self.writer.clone())
    }
    pub fn is_ready(&self) -> bool {
        !self.readers.is_closed() && self.writer.is_accepting()
    }
    pub async fn schema_version(&self) -> Result<i64, StorageError> {
        Ok(sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&self.readers)
            .await?)
    }
    pub async fn close(&self) {
        self.writer.stop_admission();
        self.writer.drain().await;
        self.writer.wait_closed().await;
        self.readers.close().await;
    }
}
