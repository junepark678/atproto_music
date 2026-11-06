//! External AT Protocol boundary. Identity, OAuth, and sync are tracked by M2/M4.
//!
//! No unverified remote data is treated as an authenticated repository here.

pub mod http;
pub mod identity;
pub mod oauth;
pub mod pds;
pub mod sync;
