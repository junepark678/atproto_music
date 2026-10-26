//! Typed storage access. Verified event callers supply CID/revision evidence; local admission
//! never fabricates confirmation. All mutations are committed by the bounded writer.
mod backfill;
mod deletions;
mod follows;
mod models;
pub use deletions::*;
mod disconnect;
mod export;
mod oauth;
mod outbox;
mod private;
mod public;
mod relay;
mod stats;
use crate::Writer;
pub use backfill::*;
pub use export::*;
pub use follows::*;
pub use models::*;
use sqlx::SqlitePool;
pub use stats::*;
#[derive(Clone)]
pub struct Repository {
    pub(crate) readers: SqlitePool,
    pub(crate) writer: Writer,
}
impl Repository {
    pub(crate) fn new(readers: SqlitePool, writer: Writer) -> Self {
        Self { readers, writer }
    }
}
