//! Real Rustls/WSS fixtures. Only DNS and the TCP destination are injected;
//! certificates, hostnames, handshakes and framing use the maintained libraries.
#[path = "support/signed_repo.rs"]
mod signed_repo;

use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{DnsResolver, FetchError, HttpResponse, HttpTransport, SafeClient},
    sync::{
        frames::{MAX_FRAME_BYTES, RelayEvent, decode_frame},
        stream::{RelayTransport, StreamError, subscription_url},
        verify::{VerifiedMutation, verify_commit},
        websocket::{
            CLOSE_DEADLINE, CONNECT_DEADLINE, MAX_CONTROL_MESSAGES, RECEIVE_DEADLINE, RelayDialer,
            RelaySocket, WebSocketTransport,
        },
    },
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use ciborium::value::Value;
use futures::{SinkExt, StreamExt};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{ClientConfig, RootCertStore, ServerConfig, pki_types::PrivatePkcs8KeyDer},
};
use tokio_tungstenite::{
    Connector, accept_hdr_async, client_async_tls_with_config,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
        protocol::{
            WebSocketConfig,
            frame::{Frame, coding::Data, coding::OpCode},
        },
    },
};
use url::Url;

const HOST: &str = "relay.example.com";

struct Dns(Vec<IpAddr>);
#[async_trait]
impl DnsResolver for Dns {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError> {
        assert_eq!(host, HOST);
        Ok(self.0.clone())
    }
    async fn txt(&self, _: &str) -> Result<Vec<String>, FetchError> {
        panic!("WSS must not request TXT records")
    }
}
struct NoHttp;
#[async_trait]
impl HttpTransport for NoHttp {
    async fn fetch(&self, _: &Url, _: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        panic!("destination authorization must not make an HTTP request")
    }
}

#[derive(Default)]
struct DialTrace {
    calls: usize,
    addresses: Vec<SocketAddr>,
    url: String,
    maximum_frame: Option<usize>,
    maximum_message: Option<usize>,
}
struct FixtureDialer {
    address: SocketAddr,
    tls: Arc<ClientConfig>,
    trace: Arc<Mutex<DialTrace>>,
}
#[async_trait]
impl RelayDialer for FixtureDialer {
    async fn dial(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        config: WebSocketConfig,
    ) -> Result<RelaySocket, StreamError> {
        {
            let mut trace = self.trace.lock().unwrap();
            trace.calls += 1;
            trace.addresses = addresses.to_vec();
            trace.url = url.to_string();
            trace.maximum_frame = config.max_frame_size;
            trace.maximum_message = config.max_message_size;
        }
        // Only this injected fixture maps authorized public destinations to an
        // owned port-0 listener. The original WSS hostname is still verified.
        let tcp = tokio::net::TcpStream::connect(self.address)
            .await
            .map_err(|_| StreamError::Transport)?;
        client_async_tls_with_config(
            url.as_str(),
            tcp,
            Some(config),
            Some(Connector::Rustls(self.tls.clone())),
        )
        .await
        .map(|(socket, _)| socket)
        .map_err(|_| StreamError::Transport)
    }
}

enum Scenario {
    Messages(Vec<Message>),
    PingClose,
    Idle,
    HandshakeIdle,
    Redirect,
}

struct Fixture {
    address: SocketAddr,
    trusted_tls: Arc<ClientConfig>,
    trace: Arc<Mutex<DialTrace>>,
    request_uri: Arc<Mutex<Option<String>>>,
    tls_ready: Option<oneshot::Receiver<()>>,
    ended: Option<oneshot::Receiver<bool>>,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn start(scenario: Scenario, certificate_host: &str) -> Self {
        let certificate =
            rcgen::generate_simple_self_signed(vec![certificate_host.into()]).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(certificate.cert.der().clone()).unwrap();
        let trusted_tls = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let server = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![certificate.cert.der().clone()],
                PrivatePkcs8KeyDer::from(certificate.signing_key.serialize_der()).into(),
            )
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let request_uri = Arc::new(Mutex::new(None));
        let request = request_uri.clone();
        let (ready, tls_ready) = oneshot::channel();
        let (end, ended) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let Ok(tls) = TlsAcceptor::from(Arc::new(server)).accept(tcp).await else {
                return;
            };
            let _ = ready.send(());
            if matches!(scenario, Scenario::HandshakeIdle) {
                std::future::pending::<()>().await;
                drop(tls);
                return;
            }
            let redirect = matches!(scenario, Scenario::Redirect);
            let result = accept_hdr_async(tls, move |incoming: &Request, response: Response| {
                *request.lock().unwrap() = Some(incoming.uri().to_string());
                if redirect {
                    return Err(Response::builder()
                        .status(302)
                        .header("location", "wss://other.example.com/")
                        .body(Some("redirect must not be followed".into()))
                        .unwrap());
                }
                Ok(response)
            })
            .await;
            let Ok(mut socket) = result else {
                return;
            };
            match scenario {
                Scenario::Messages(messages) => {
                    for message in messages {
                        if socket.send(message).await.is_err() {
                            let _ = end.send(false);
                            return;
                        }
                    }
                }
                Scenario::PingClose => {
                    socket
                        .send(Message::Ping(b"ping".to_vec().into()))
                        .await
                        .unwrap();
                    let pong = socket.next().await.unwrap().unwrap();
                    assert_eq!(pong, Message::Pong(b"ping".to_vec().into()));
                    socket.close(None).await.unwrap();
                    let acknowledged = matches!(socket.next().await, Some(Ok(Message::Close(_))));
                    let _ = end.send(acknowledged);
                    return;
                }
                Scenario::Idle => {}
                Scenario::HandshakeIdle | Scenario::Redirect => unreachable!(),
            }
            // Detect both normal close and cancellation/EOF on the real TLS
            // stream. The fixture itself cannot keep a hidden reader alive.
            while let Some(message) = socket.next().await {
                match message {
                    Ok(Message::Close(_)) => {
                        let _ = socket.flush().await;
                        let _ = end.send(true);
                        return;
                    }
                    Err(_) => {
                        let _ = end.send(true);
                        return;
                    }
                    _ => {}
                }
            }
            let _ = end.send(true);
        });
        Self {
            address,
            trusted_tls,
            trace: Arc::default(),
            request_uri,
            tls_ready: Some(tls_ready),
            ended: Some(ended),
            task,
        }
    }

    fn transport_with(&self, ips: Vec<IpAddr>, tls: Arc<ClientConfig>) -> WebSocketTransport {
        WebSocketTransport::new(
            SafeClient::new(Arc::new(Dns(ips)), Arc::new(NoHttp)),
            Arc::new(FixtureDialer {
                address: self.address,
                tls,
                trace: self.trace.clone(),
            }),
        )
    }
    fn transport(&self) -> WebSocketTransport {
        self.transport_with(
            vec![
                "8.8.8.8".parse().unwrap(),
                "2606:4700:4700::1111".parse().unwrap(),
            ],
            self.trusted_tls.clone(),
        )
    }
    async fn ended(&mut self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), self.ended.take().unwrap())
            .await
            .unwrap()
            .unwrap()
    }
}

fn url() -> Url {
    subscription_url("wss://relay.example.com", Some(42)).unwrap()
}

fn cbor_map(fields: Vec<(&str, Value)>) -> Value {
    Value::Map(
        fields
            .into_iter()
            .map(|(name, value)| (Value::Text(name.into()), value))
            .collect(),
    )
}
fn cid(value: ipld_core::cid::Cid) -> Value {
    let mut bytes = vec![0];
    bytes.extend(value.to_bytes());
    Value::Tag(42, Box::new(Value::Bytes(bytes)))
}
fn commit_frame(fixture: &signed_repo::SignedFixture) -> Vec<u8> {
    let event = &fixture.event;
    let ops = event
        .operations
        .iter()
        .map(|op| {
            cbor_map(vec![
                ("action", Value::Text("create".into())),
                ("path", Value::Text(op.path.clone())),
                ("cid", cid(op.cid.unwrap())),
            ])
        })
        .collect();
    let body = cbor_map(vec![
        ("seq", event.sequence.into()),
        ("repo", Value::Text(event.did.clone())),
        ("rev", Value::Text(event.revision.clone())),
        ("commit", cid(event.commit)),
        ("time", Value::Text(event.time.clone())),
        ("blocks", Value::Bytes(event.blocks.clone())),
        ("ops", Value::Array(ops)),
        ("tooBig", Value::Bool(false)),
    ]);
    let mut wire = vec![];
    ciborium::ser::into_writer(
        &cbor_map(vec![("op", 1.into()), ("t", Value::Text("#commit".into()))]),
        &mut wire,
    )
    .unwrap();
    ciborium::ser::into_writer(&body, &mut wire).unwrap();
    wire
}

#[tokio::test]
async fn wss_binary_verified_and_dns_pinned() {
    let signed = signed_repo::signed_repo(vec![(
        "com.example.atmusic.scrobble/r01".into(),
        serde_json::json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"}),
    )], 7).await;
    let wire = commit_frame(&signed);
    let mut fixture = Fixture::start(
        Scenario::Messages(vec![Message::Binary(wire.clone().into())]),
        HOST,
    )
    .await;
    let mut connection = fixture
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    let received = connection.receive().await.unwrap().unwrap();
    assert_eq!(received, wire);
    let namespace = Namespace::new(FIXTURE_PREFIX).unwrap();
    let RelayEvent::Commit(event) = decode_frame(&received, &namespace).unwrap() else {
        panic!("expected a real signed commit")
    };
    let verified = verify_commit(
        &event,
        signed_repo::ALICE,
        &namespace,
        "2026-01-15T12:00:00Z".parse().unwrap(),
        &signed_repo::FixtureResolver(signed.key),
    )
    .await
    .unwrap();
    assert_eq!(verified.mutations().len(), 1);
    assert!(
        matches!(&verified.mutations()[0], VerifiedMutation::Put { cid, uri, .. }
        if *cid == signed.record_cids[0] && uri == "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/r01")
    );
    {
        let trace = fixture.trace.lock().unwrap();
        assert_eq!(trace.calls, 1);
        assert_eq!(
            trace.addresses,
            vec![
                "8.8.8.8:443".parse::<SocketAddr>().unwrap(),
                "[2606:4700:4700::1111]:443".parse().unwrap()
            ]
        );
        assert_eq!(trace.url, url().as_str());
        assert_eq!(trace.maximum_frame, Some(MAX_FRAME_BYTES));
        assert_eq!(trace.maximum_message, Some(MAX_FRAME_BYTES));
    }
    assert_eq!(
        fixture.request_uri.lock().unwrap().as_deref(),
        Some("/xrpc/com.atproto.sync.subscribeRepos?cursor=42")
    );
    drop(connection);
    assert!(fixture.ended().await);
}

#[tokio::test]
async fn wss_nonpublic_and_empty_dns_rejected_before_dial() {
    let fixture = Fixture::start(Scenario::Idle, HOST).await;
    for bad in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "192.0.2.1",
        "::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
    ] {
        let transport = fixture.transport_with(
            vec!["8.8.8.8".parse().unwrap(), bad.parse().unwrap()],
            fixture.trusted_tls.clone(),
        );
        assert!(
            matches!(
                transport.connect(&url(), MAX_FRAME_BYTES).await,
                Err(StreamError::InvalidUrl)
            ),
            "{bad}"
        );
    }
    let empty = fixture.transport_with(vec![], fixture.trusted_tls.clone());
    assert!(matches!(
        empty.connect(&url(), MAX_FRAME_BYTES).await,
        Err(StreamError::InvalidUrl)
    ));
    assert_eq!(fixture.trace.lock().unwrap().calls, 0);
}

#[tokio::test]
async fn wss_url_credentials_fragment_and_plaintext_rejected() {
    let fixture = Fixture::start(Scenario::Idle, HOST).await;
    for destination in [
        "ws://relay.example.com/",
        "https://relay.example.com/",
        "wss://user:password@relay.example.com/",
        "wss://relay.example.com/#fragment",
        "wss://127.0.0.1/",
        "wss://[::1]/",
    ] {
        assert!(
            matches!(
                fixture
                    .transport()
                    .connect(&Url::parse(destination).unwrap(), MAX_FRAME_BYTES)
                    .await,
                Err(StreamError::InvalidUrl)
            ),
            "{destination}"
        );
    }
    assert_eq!(fixture.trace.lock().unwrap().calls, 0);
}

#[tokio::test]
async fn wss_tls_hostname_and_certificate_verified() {
    let wrong_host = Fixture::start(Scenario::Idle, "other.example.com").await;
    assert!(matches!(
        wrong_host
            .transport()
            .connect(&url(), MAX_FRAME_BYTES)
            .await,
        Err(StreamError::Transport)
    ));
    assert_eq!(wrong_host.trace.lock().unwrap().calls, 1);
    let untrusted = Fixture::start(Scenario::Idle, HOST).await;
    let empty_roots = Arc::new(
        ClientConfig::builder()
            .with_root_certificates(RootCertStore::empty())
            .with_no_client_auth(),
    );
    let transport = untrusted.transport_with(vec!["8.8.8.8".parse().unwrap()], empty_roots);
    assert!(matches!(
        transport.connect(&url(), MAX_FRAME_BYTES).await,
        Err(StreamError::Transport)
    ));
    assert_eq!(untrusted.trace.lock().unwrap().calls, 1);
}

#[tokio::test]
async fn wss_redirect_is_not_followed() {
    let fixture = Fixture::start(Scenario::Redirect, HOST).await;
    assert!(matches!(
        fixture.transport().connect(&url(), MAX_FRAME_BYTES).await,
        Err(StreamError::Transport)
    ));
    assert_eq!(fixture.trace.lock().unwrap().calls, 1);
    assert!(fixture.request_uri.lock().unwrap().is_some());
}

#[tokio::test]
async fn wss_frame_and_fragmented_message_limits() {
    let exact = Fixture::start(
        Scenario::Messages(vec![Message::Binary(vec![7; MAX_FRAME_BYTES].into())]),
        HOST,
    )
    .await;
    let mut connection = exact
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    assert_eq!(
        connection.receive().await.unwrap().unwrap(),
        vec![7; MAX_FRAME_BYTES]
    );
    drop(connection);
    let oversized = Fixture::start(
        Scenario::Messages(vec![Message::Binary(vec![7; MAX_FRAME_BYTES + 1].into())]),
        HOST,
    )
    .await;
    let mut connection = oversized
        .transport()
        .connect(&url(), MAX_FRAME_BYTES + 1024)
        .await
        .unwrap();
    assert_eq!(connection.receive().await, Err(StreamError::FrameTooLarge));
    assert_eq!(connection.receive().await.unwrap(), None);
    let fragments = Fixture::start(
        Scenario::Messages(vec![
            Message::Frame(Frame::message(
                vec![7; 40],
                OpCode::Data(Data::Binary),
                false,
            )),
            Message::Frame(Frame::message(
                vec![7; 25],
                OpCode::Data(Data::Continue),
                true,
            )),
        ]),
        HOST,
    )
    .await;
    let mut connection = fragments.transport().connect(&url(), 64).await.unwrap();
    assert_eq!(connection.receive().await, Err(StreamError::FrameTooLarge));
}

#[tokio::test]
async fn wss_ping_and_close_acknowledged() {
    let mut fixture = Fixture::start(Scenario::PingClose, HOST).await;
    let mut connection = fixture
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    assert_eq!(connection.receive().await.unwrap(), None);
    assert!(fixture.ended().await);
    assert_eq!(connection.receive().await.unwrap(), None);
}

#[tokio::test]
async fn wss_control_budget_and_text_rejected() {
    let mut allowed_controls: Vec<_> = (0..MAX_CONTROL_MESSAGES)
        .map(|_| Message::Pong(vec![].into()))
        .collect();
    allowed_controls.push(Message::Binary(vec![7].into()));
    let boundary = Fixture::start(Scenario::Messages(allowed_controls), HOST).await;
    let mut connection = boundary
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    assert_eq!(connection.receive().await.unwrap(), Some(vec![7]));
    drop(connection);
    let controls = Fixture::start(
        Scenario::Messages(
            (0..=MAX_CONTROL_MESSAGES)
                .map(|_| Message::Pong(vec![].into()))
                .collect(),
        ),
        HOST,
    )
    .await;
    let mut connection = controls
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    assert_eq!(connection.receive().await, Err(StreamError::Transport));
    let text = Fixture::start(
        Scenario::Messages(vec![Message::Text("not a binary relay event".into())]),
        HOST,
    )
    .await;
    let mut connection = text
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    assert_eq!(connection.receive().await, Err(StreamError::Transport));
    assert_eq!(connection.receive().await.unwrap(), None);
}

#[tokio::test]
async fn wss_idle_receive_deadline_closes_socket() {
    let mut fixture = Fixture::start(Scenario::Idle, HOST).await;
    let mut connection = fixture
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    tokio::time::pause();
    let started = tokio::time::Instant::now();
    assert_eq!(connection.receive().await, Err(StreamError::Transport));
    assert!(started.elapsed() >= RECEIVE_DEADLINE);
    assert!(started.elapsed() <= RECEIVE_DEADLINE + CLOSE_DEADLINE);
    assert!(fixture.ended().await);
    assert_eq!(connection.receive().await.unwrap(), None);
}

#[tokio::test]
async fn wss_handshake_deadline_after_valid_tls() {
    let mut fixture = Fixture::start(Scenario::HandshakeIdle, HOST).await;
    let transport = fixture.transport();
    let connection = tokio::spawn(async move { transport.connect(&url(), MAX_FRAME_BYTES).await });
    fixture.tls_ready.take().unwrap().await.unwrap();
    tokio::time::pause();
    tokio::time::advance(CONNECT_DEADLINE + Duration::from_secs(1)).await;
    assert!(matches!(
        connection.await.unwrap(),
        Err(StreamError::Transport)
    ));
    assert_eq!(fixture.trace.lock().unwrap().calls, 1);
}

#[tokio::test]
async fn wss_cancelled_receive_drop_closes_socket() {
    let mut fixture = Fixture::start(Scenario::Idle, HOST).await;
    let mut connection = fixture
        .transport()
        .connect(&url(), MAX_FRAME_BYTES)
        .await
        .unwrap();
    let (cancel, cancelled) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        tokio::select! {
            // Poll the idle network read before the already-ready cancellation
            // branch, proving cancellation of an in-flight receive future.
            biased;
            _ = connection.receive() => panic!("idle receive completed before cancellation"),
            _ = cancelled => {},
        }
        drop(connection);
    });
    cancel.send(()).unwrap();
    task.await.unwrap();
    assert!(fixture.ended().await);
}
