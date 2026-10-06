//! Embedded SQLite with transactional serialized writes and confirmed repository read models.

pub mod backup;
pub mod database;
pub mod migrations;
pub mod repositories;
pub mod writer;

pub use database::Database;
pub use repositories::*;
pub use writer::{Pending, Writer};

#[derive(Debug)]
pub enum StorageError {
    Sql(sqlx::Error),
    Migration(sqlx::migrate::MigrateError),
    SchemaTooNew { found: i64, supported: i64 },
    ServiceBusy,
    StorageBusy,
    Closed,
    IdempotencyConflict,
    InvalidTransition,
    Ownership,
    NotFound,
    Invariant(&'static str),
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SchemaTooNew { .. } => "schema_too_new",
            Self::ServiceBusy => "service_busy",
            Self::StorageBusy => "storage_busy",
            Self::Closed => "storage_closed",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::InvalidTransition => "invalid_operation_transition",
            Self::Ownership => "forbidden",
            Self::NotFound => "not_found",
            Self::Invariant(_) => "storage_invariant",
            Self::Sql(_) | Self::Migration(_) => "storage_error",
        }
    }
}
impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SchemaTooNew { found, supported } => {
                write!(f, "schema_too_new: {found} > {supported}")
            }
            Self::Sql(error) => write!(f, "storage_error: {error}"),
            Self::Migration(error) => write!(f, "migration_error: {error}"),
            Self::Invariant(message) => write!(f, "storage_invariant: {message}"),
            other => f.write_str(other.code()),
        }
    }
}
impl std::error::Error for StorageError {}
impl From<sqlx::Error> for StorageError {
    fn from(error: sqlx::Error) -> Self {
        if error
            .as_database_error()
            .and_then(|e| e.code())
            .is_some_and(|code| matches!(code.as_ref(), "5" | "6" | "261" | "262" | "517"))
        {
            Self::StorageBusy
        } else {
            Self::Sql(error)
        }
    }
}
impl From<sqlx::migrate::MigrateError> for StorageError {
    fn from(error: sqlx::migrate::MigrateError) -> Self {
        Self::Migration(error)
    }
}
