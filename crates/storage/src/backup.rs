//! Transaction-consistent SQLite snapshots, validated before no-overwrite publication.
//! Secret encryption keys are deliberately outside the backup format.
use crate::{StorageError, migrations};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

#[derive(Debug)]
pub enum BackupError {
    Io(std::io::Error),
    Sql(sqlx::Error),
    Schema(StorageError),
    Invalid(&'static str),
}
impl std::fmt::Display for BackupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "backup_io: {error}"),
            Self::Sql(error) => write!(formatter, "backup_sql: {error}"),
            Self::Schema(error) => write!(formatter, "backup_schema: {error}"),
            Self::Invalid(message) => write!(formatter, "backup_invalid: {message}"),
        }
    }
}
impl std::error::Error for BackupError {}
impl From<std::io::Error> for BackupError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<sqlx::Error> for BackupError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}
impl From<StorageError> for BackupError {
    fn from(error: StorageError) -> Self {
        Self::Schema(error)
    }
}

#[derive(Debug)]
pub struct BackupReport {
    pub schema_version: i64,
    pub bytes: u64,
}

async fn connect(path: &Path) -> Result<SqliteConnection, BackupError> {
    Ok(SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(Duration::from_secs(5)),
    )
    .await?)
}

async fn validate(connection: &mut SqliteConnection) -> Result<i64, BackupError> {
    let checks = sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
        .fetch_all(&mut *connection)
        .await?;
    if checks != ["ok"] {
        return Err(BackupError::Invalid("SQLite integrity check failed"));
    }
    if !sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *connection)
        .await?
        .is_empty()
    {
        return Err(BackupError::Invalid("SQLite foreign key check failed"));
    }
    let version = migrations::check_version(connection).await?;
    if version < 1 {
        return Err(BackupError::Invalid(
            "not an initialized application database",
        ));
    }
    let pragma: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await?;
    if pragma != version {
        return Err(BackupError::Invalid("inconsistent schema version"));
    }
    let rows =
        sqlx::query("SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *connection)
            .await?;
    let embedded = migrations::embedded();
    let expected: Vec<_> = embedded
        .iter()
        .filter(|migration| migration.version <= version)
        .collect();
    if rows.len() != expected.len() {
        return Err(BackupError::Invalid("incomplete migration history"));
    }
    for (row, migration) in rows.into_iter().zip(&expected) {
        if row.get::<i64, _>("version") != migration.version
            || !row.get::<bool, _>("success")
            || row.get::<Vec<u8>, _>("checksum") != migration.checksum.as_ref()
        {
            return Err(BackupError::Invalid(
                "migration history does not match this executable",
            ));
        }
    }
    // A version/checksum marker alone cannot detect an accidentally dropped table
    // or modified constraint. Reconstruct the supported schema in memory only.
    let mut reference = SqliteConnection::connect("sqlite::memory:").await?;
    for migration in expected {
        sqlx::raw_sql(migration.sql.as_ref())
            .execute(&mut reference)
            .await?;
    }
    let schema_query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations' ORDER BY type,name";
    let actual = sqlx::query_as::<_, (String, String, String, String)>(schema_query)
        .fetch_all(&mut *connection)
        .await?;
    let required = sqlx::query_as::<_, (String, String, String, String)>(schema_query)
        .fetch_all(&mut reference)
        .await?;
    reference.close().await?;
    if actual != required {
        return Err(BackupError::Invalid(
            "application schema does not match migration history",
        ));
    }
    Ok(version)
}

/// Check without migrating or modifying the input database.
pub async fn verify(path: impl AsRef<Path>) -> Result<BackupReport, BackupError> {
    let path = path.as_ref();
    let mut connection = connect(path).await?;
    let result = validate(&mut connection).await;
    connection.close().await?;
    Ok(BackupReport {
        schema_version: result?,
        bytes: fs::metadata(path)?.len(),
    })
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn temporary_file(parent: &Path) -> Result<TemporaryFile, BackupError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..256 {
        let path = parent.join(format!(
            ".atmusic-snapshot-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => return Ok(TemporaryFile(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(BackupError::Invalid("cannot reserve snapshot staging file"))
}

/// SQLite VACUUM INTO takes one read snapshot, including committed WAL contents.
/// The destination must be new; concurrent callers cannot overwrite an existing backup.
pub async fn snapshot(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<BackupReport, BackupError> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    if fs::symlink_metadata(destination).is_ok() {
        return Err(BackupError::Invalid("destination already exists"));
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let stage = temporary_file(parent)?;
    let mut connection = connect(source).await?;
    let result = async {
        validate(&mut connection).await?;
        let stage_path = stage
            .0
            .to_str()
            .ok_or(BackupError::Invalid("snapshot path is not UTF-8"))?;
        sqlx::query("VACUUM INTO ?")
            .bind(stage_path)
            .execute(&mut connection)
            .await?;
        Ok::<_, BackupError>(())
    }
    .await;
    connection.close().await?;
    result?;
    let report = verify(&stage.0).await?;
    File::open(&stage.0)?.sync_all()?;
    fs::hard_link(&stage.0, destination)?;
    File::open(parent)?.sync_all()?;
    Ok(report)
}

struct RestoreDirectory {
    path: PathBuf,
    published: bool,
}
impl Drop for RestoreDirectory {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Restore offline into a new directory. Existing instances are never modified.
pub async fn restore(
    source: impl AsRef<Path>,
    directory: impl AsRef<Path>,
) -> Result<PathBuf, BackupError> {
    let source = source.as_ref();
    let directory = directory.as_ref();
    verify(source).await?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    let mut owned = RestoreDirectory {
        path: directory.to_owned(),
        published: false,
    };
    let destination = directory.join("music.sqlite");
    snapshot(source, &destination).await?;
    let parent = directory
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    File::open(parent)?.sync_all()?;
    owned.published = true;
    Ok(destination)
}
