//! Reconnect policy and bounded injected binary streaming. Production WSS transport is gated.
use super::frames::MAX_FRAME_BYTES;
use async_trait::async_trait;
use std::time::Duration;
use thiserror::Error;
use url::Url;

pub trait ReconnectJitter: Send + Sync {
    fn millis(&self, base: Duration) -> u64;
}
pub struct RandomReconnectJitter;
impl ReconnectJitter for RandomReconnectJitter {
    fn millis(&self, base: Duration) -> u64 {
        use rand::Rng;
        rand::thread_rng().gen_range(0..=base.as_millis() as u64 / 4)
    }
}
pub fn reconnect_delay(attempt: u32, jitter: &dyn ReconnectJitter) -> Duration {
    let base = Duration::from_secs(1u64.checked_shl(attempt.min(6)).unwrap_or(60).min(60));
    (base + Duration::from_millis(jitter.millis(base))).min(Duration::from_secs(60))
}
#[async_trait]
pub trait ReconnectClock: super::backfill::ReceiptClock {
    async fn sleep(&self, duration: Duration);
}
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum StreamError {
    #[error("relay_transport_failed")]
    Transport,
    #[error("relay_frame_too_large")]
    FrameTooLarge,
    #[error("invalid_relay_url")]
    InvalidUrl,
}
/// Implementations must bound the message while receiving, not after an unbounded allocation.
#[async_trait]
pub trait RelayConnection: Send {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError>;
}
#[async_trait]
pub trait RelayTransport: Send + Sync {
    /// The adapter must enforce WSS TLS and pin publicly resolved addresses before connecting.
    async fn connect(
        &self,
        url: &Url,
        max_message_bytes: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError>;
}
pub fn subscription_url(relay: &str, cursor: Option<i64>) -> Result<Url, StreamError> {
    let mut url = Url::parse(relay).map_err(|_| StreamError::InvalidUrl)?;
    if url.scheme() != "wss"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || url.path() != "/"
        || cursor.is_some_and(|v| v < 0)
    {
        return Err(StreamError::InvalidUrl);
    }
    url.set_path("/xrpc/com.atproto.sync.subscribeRepos");
    if let Some(cursor) = cursor {
        url.query_pairs_mut()
            .append_pair("cursor", &cursor.to_string());
    }
    Ok(url)
}
pub async fn bounded_receive(
    connection: &mut dyn RelayConnection,
) -> Result<Option<Vec<u8>>, StreamError> {
    let frame = connection.receive().await?;
    if frame.as_ref().is_some_and(|v| v.len() > MAX_FRAME_BYTES) {
        return Err(StreamError::FrameTooLarge);
    }
    Ok(frame)
}
