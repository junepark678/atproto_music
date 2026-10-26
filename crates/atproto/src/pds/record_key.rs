//! Allocate TID record identities with the maintained AT Protocol codec.
use atrium_api::types::{LimitedU32, string::Tid};
use chrono::{DateTime, Utc};
use rand::{Rng, rngs::OsRng};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, thiserror::Error)]
pub enum RecordKeyError {
    #[error("record_key_clock_invalid")]
    Clock,
    #[error("record_key_allocator_unavailable")]
    Unavailable,
}
pub struct RecordKeyAllocator {
    clock_id: LimitedU32<1023>,
    last_micros: Mutex<i64>,
}
impl Default for RecordKeyAllocator {
    fn default() -> Self {
        Self {
            clock_id: OsRng
                .gen_range(0..=1023u32)
                .try_into()
                .expect("bounded clock identifier"),
            last_micros: Mutex::new(-1),
        }
    }
}
impl RecordKeyAllocator {
    pub fn allocate(&self, now: DateTime<Utc>) -> Result<String, RecordKeyError> {
        let mut last = self
            .last_micros
            .lock()
            .map_err(|_| RecordKeyError::Unavailable)?;
        let micros = now
            .timestamp_micros()
            .max(last.checked_add(1).ok_or(RecordKeyError::Clock)?);
        // TID stores 53 timestamp bits. Reject overflow instead of wrapping an identity.
        if !(0..(1i64 << 53)).contains(&micros) {
            return Err(RecordKeyError::Clock);
        }
        let time = DateTime::from_timestamp_micros(micros).ok_or(RecordKeyError::Clock)?;
        let tid = Tid::from_datetime(self.clock_id, time);
        *last = micros;
        Ok(tid.as_str().to_owned())
    }
}
pub fn allocate_scrobble_rkey(now: DateTime<Utc>) -> Result<String, RecordKeyError> {
    static ALLOCATOR: OnceLock<RecordKeyAllocator> = OnceLock::new();
    ALLOCATOR
        .get_or_init(RecordKeyAllocator::default)
        .allocate(now)
}
