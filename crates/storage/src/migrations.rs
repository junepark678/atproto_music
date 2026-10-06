//! Forward-only SQLx migrations embedded into the executable.
use crate::StorageError;
use sqlx::{
    SqliteConnection,
    migrate::{Migration, MigrationType, Migrator},
};
use std::borrow::Cow;

pub const SCHEMA_VERSION: i64 = 4;

pub fn embedded() -> Migrator {
    Migrator {
        migrations: Cow::Owned(vec![
            Migration::new(
                1,
                Cow::Borrowed("initial"),
                MigrationType::Simple,
                Cow::Borrowed(include_str!("../migrations/0001_initial.sql")),
                false,
            ),
            Migration::new(
                2,
                Cow::Borrowed("operation dependencies"),
                MigrationType::Simple,
                Cow::Borrowed(include_str!(
                    "../migrations/0002_operation_dependencies.sql"
                )),
                false,
            ),
            Migration::new(
                3,
                Cow::Borrowed("verified backfill"),
                MigrationType::Simple,
                Cow::Borrowed(include_str!("../migrations/0003_backfill.sql")),
                false,
            ),
            Migration::new(
                4,
                Cow::Borrowed("durable backfill generation"),
                MigrationType::Simple,
                Cow::Borrowed(include_str!("../migrations/0004_backfill_generation.sql")),
                false,
            ),
        ]),
        ..Migrator::DEFAULT
    }
}

/// Inspect through a read-only connection before configuring WAL or running migrations.
pub async fn check_version(connection: &mut SqliteConnection) -> Result<i64, StorageError> {
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await?;
    let exists: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
    )
    .fetch_one(&mut *connection)
    .await?;
    let migration_version = if exists > 0 {
        sqlx::query_scalar::<_, Option<i64>>("SELECT max(version) FROM _sqlx_migrations")
            .fetch_one(&mut *connection)
            .await?
            .unwrap_or(0)
    } else {
        0
    };
    let version = user_version.max(migration_version);
    if version > SCHEMA_VERSION {
        return Err(StorageError::SchemaTooNew {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(version)
}
