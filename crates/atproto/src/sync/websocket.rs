//! Bounded WSS transport with the same authoritative destination policy as HTTPS.
//!
//! The production dialer connects only to the complete validated DNS answer set,
//! keeps the original hostname for Rustls verification, and never uses a proxy or
//! follows a redirect. Injection is at the dialer boundary, not a production flag
//! that permits private addresses or disables certificate verification.

use super::{
    frames::MAX_FRAME_BYTES,
    stream::{RelayConnection, RelayTransport, StreamError},
};
use crate::http::safe_client::{FetchError, SafeClient};
use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, client_async_tls_with_config,
    tungstenite::{Error, Message, protocol::WebSocketConfig},
};
use url::Url;

pub const CONNECT_DEADLINE: Duration = Duration::from_secs(10);
pub const RECEIVE_DEADLINE: Duration = Duration::from_secs(10);
pub const CLOSE_DEADLINE: Duration = Duration::from_secs(1);
pub const MAX_CONTROL_MESSAGES: usize = 32;

pub type RelaySocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Dial only the supplied, already authorized addresses. Preserve the WSS
/// hostname and normal TLS certificate verification; do not follow redirects.
/// Alternative dialers support deterministic TLS fixtures at this boundary.
#[async_trait]
pub trait RelayDialer: Send + Sync {
    async fn dial(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        config: WebSocketConfig,
    ) -> Result<RelaySocket, StreamError>;
}

struct PinnedWssDialer;

#[async_trait]
impl RelayDialer for PinnedWssDialer {
    async fn dial(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        config: WebSocketConfig,
    ) -> Result<RelaySocket, StreamError> {
        // A socket-address slice never triggers a second hostname resolution.
        let socket = TcpStream::connect(addresses)
            .await
            .map_err(|_| StreamError::Transport)?;
        socket
            .set_nodelay(true)
            .map_err(|_| StreamError::Transport)?;
        let (socket, _) = client_async_tls_with_config(url.as_str(), socket, Some(config), None)
            .await
            .map_err(stream_error)?;
        Ok(socket)
    }
}

pub struct WebSocketTransport {
    client: SafeClient,
    dialer: Arc<dyn RelayDialer>,
}

impl WebSocketTransport {
    pub fn production() -> Result<Self, StreamError> {
        Ok(Self::new(
            SafeClient::production().map_err(destination_error)?,
            Arc::new(PinnedWssDialer),
        ))
    }

    /// Inject a securely implemented dialer and resolver for a controlled
    /// transport boundary. The shared destination policy always runs first.
    pub fn new(client: SafeClient, dialer: Arc<dyn RelayDialer>) -> Self {
        Self { client, dialer }
    }
}

fn destination_error(error: FetchError) -> StreamError {
    match error {
        FetchError::UnsafeDestination => StreamError::InvalidUrl,
        _ => StreamError::Transport,
    }
}

fn stream_error(error: Error) -> StreamError {
    match error {
        Error::Capacity(_) => StreamError::FrameTooLarge,
        _ => StreamError::Transport,
    }
}

#[async_trait]
impl RelayTransport for WebSocketTransport {
    async fn connect(
        &self,
        url: &Url,
        max_message_bytes: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError> {
        if url.scheme() != "wss"
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(StreamError::InvalidUrl);
        }
        let maximum = max_message_bytes.min(MAX_FRAME_BYTES);
        if maximum == 0 {
            return Err(StreamError::FrameTooLarge);
        }
        let config = WebSocketConfig::default()
            .read_buffer_size(16 * 1024)
            .write_buffer_size(0)
            .max_write_buffer_size(64 * 1024)
            .max_frame_size(Some(maximum))
            .max_message_size(Some(maximum));
        let mut destination = url.clone();
        destination
            .set_scheme("https")
            .map_err(|_| StreamError::InvalidUrl)?;
        let socket = tokio::time::timeout(CONNECT_DEADLINE, async {
            let addresses = self
                .client
                .destination(&destination)
                .await
                .map_err(destination_error)?;
            self.dialer.dial(url, &addresses, config).await
        })
        .await
        .map_err(|_| StreamError::Transport)??;
        Ok(Box::new(WebSocketConnection {
            socket: Some(socket),
        }))
    }
}

struct WebSocketConnection {
    // Dropping a connection/cancelled worker closes TCP directly. No spawned
    // reader, reconnect task or independently owned socket survives cancellation.
    socket: Option<RelaySocket>,
}

async fn receive(socket: &mut RelaySocket) -> Result<Option<Vec<u8>>, StreamError> {
    let mut controls = 0;
    loop {
        match socket.next().await {
            Some(Ok(Message::Binary(bytes))) => return Ok(Some(bytes.to_vec())),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                controls += 1;
                if controls > MAX_CONTROL_MESSAGES {
                    return Err(StreamError::Transport);
                }
                // Tungstenite queues the protocol's pong itself. The enclosing
                // receive deadline also bounds flushing that response.
                socket.flush().await.map_err(stream_error)?;
            }
            Some(Ok(Message::Close(_))) => {
                // Acknowledge the queued close before releasing the socket.
                match socket.flush().await {
                    Ok(()) | Err(Error::ConnectionClosed) => return Ok(None),
                    Err(error) => return Err(stream_error(error)),
                }
            }
            Some(Ok(Message::Text(_) | Message::Frame(_))) => {
                return Err(StreamError::Transport);
            }
            Some(Err(Error::ConnectionClosed)) | None => return Ok(None),
            Some(Err(error)) => return Err(stream_error(error)),
        }
    }
}

#[async_trait]
impl RelayConnection for WebSocketConnection {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        let Some(socket) = self.socket.as_mut() else {
            return Ok(None);
        };
        let result = tokio::time::timeout(RECEIVE_DEADLINE, receive(socket))
            .await
            .unwrap_or(Err(StreamError::Transport));
        if !matches!(result, Ok(Some(_))) {
            if result.is_err() {
                // Best-effort protocol close has its own short bound; socket
                // ownership is released even when an upstream will not read.
                let _ = tokio::time::timeout(CLOSE_DEADLINE, socket.close(None)).await;
            }
            self.socket.take();
        }
        result
    }
}
