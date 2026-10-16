//! Verified TLS must preserve encrypted input across arbitrary socket-read boundaries.

use std::collections::VecDeque;
use std::io::{self, Cursor, Read, Write};
use std::path::PathBuf;
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConnection, Connection, ServerConfig, ServerConnection};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

use super::{AsyncRustlsClientStream, TlsTrustMaterial, build_verified_tls_client_config};

const FOLLOWUP_REQUEST: &[u8] = b"fixture second request\n";
const FOLLOWUP_RESPONSE: &[u8] = b"fixture second response\n";

/// Own attempt-local CA and leaf material; no fixture reaches a host or installed service.
struct Certificates(PathBuf);

impl Certificates {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "nanohost-tls-io-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).expect("private TLS fixture directory");
        let fixture = Self(root);
        std::fs::write(fixture.0.join("leaf.ext"), b"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:fixture.local\n").unwrap();
        fixture.openssl(&[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=Fixture CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
        ]);
        fixture.openssl(&[
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=fixture.local",
            "-keyout",
            "leaf.key",
            "-out",
            "leaf.csr",
        ]);
        fixture.openssl(&[
            "x509",
            "-req",
            "-in",
            "leaf.csr",
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "1",
            "-extfile",
            "leaf.ext",
            "-out",
            "leaf.pem",
        ]);
        fixture
    }

    fn openssl(&self, arguments: &[&str]) {
        assert!(
            Command::new("openssl")
                .args(arguments)
                .current_dir(&self.0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("OpenSSL fixture process")
                .success(),
            "OpenSSL fixture certificate generation"
        );
    }
}

impl Drop for Certificates {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Transfer every encrypted byte during fixture setup through the real rustls interfaces.
fn transfer(from: &mut Connection, to: &mut Connection) {
    let mut bytes = Vec::new();
    while from.wants_write() {
        from.write_tls(&mut bytes).unwrap();
    }
    let mut input = Cursor::new(bytes.as_slice());
    while input.position() < bytes.len() as u64 {
        assert!(to.read_tls(&mut input).unwrap() > 0);
        to.process_new_packets()
            .expect("verified fixture handshake records");
    }
}

/// Complete normal CA and hostname verification before testing application-record input.
fn verified_pair(certificates: &Certificates) -> (ClientConnection, ServerConnection) {
    let client_config = build_verified_tls_client_config(&TlsTrustMaterial::ConfiguredRef {
        reference: certificates.0.join("ca.pem").to_str().unwrap().to_owned(),
    })
    .expect("exclusive fixture CA trust");
    let cert = CertificateDer::from_pem_file(certificates.0.join("leaf.pem")).unwrap();
    let key = PrivateKeyDer::from_pem_file(certificates.0.join("leaf.key")).unwrap();
    let mut server_config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap();
    server_config.alpn_protocols = vec![b"h2".to_vec()];
    let mut client = Connection::Client(
        ClientConnection::new(
            client_config,
            ServerName::try_from("fixture.local").unwrap(),
        )
        .unwrap(),
    );
    let mut server = Connection::Server(ServerConnection::new(Arc::new(server_config)).unwrap());
    for _ in 0..16 {
        transfer(&mut client, &mut server);
        transfer(&mut server, &mut client);
        if !client.is_handshaking()
            && !server.is_handshaking()
            && !client.wants_write()
            && !server.wants_write()
        {
            break;
        }
    }
    assert!(
        !client.is_handshaking() && !server.is_handshaking(),
        "verified handshake must complete"
    );
    assert_eq!(client.alpn_protocol(), Some(b"h2".as_slice()));
    let Connection::Client(client) = client else {
        unreachable!()
    };
    let Connection::Server(mut server) = server else {
        unreachable!()
    };
    server.set_buffer_limit(None);
    (client, server)
}

/// A real rustls server with deterministic encrypted read boundaries and a second exchange.
struct RecordSocket {
    server: ServerConnection,
    encrypted: VecDeque<u8>,
    fragments: &'static [usize],
    read_sizes: Vec<usize>,
    request: Vec<u8>,
    responded: bool,
}

impl RecordSocket {
    fn flush_server(&mut self) {
        let mut bytes = Vec::new();
        while self.server.wants_write() {
            self.server.write_tls(&mut bytes).unwrap();
        }
        self.encrypted.extend(bytes);
    }
}

impl AsyncRead for RecordSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.encrypted.is_empty() {
            return Poll::Pending;
        }
        let limit = self.fragments[self.read_sizes.len() % self.fragments.len()];
        let count = limit.min(output.remaining()).min(self.encrypted.len());
        for _ in 0..count {
            output.put_slice(&[self.encrypted.pop_front().unwrap()]);
        }
        self.read_sizes.push(count);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for RecordSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        let consumed = self.server.read_tls(&mut Cursor::new(input))?;
        self.server
            .process_new_packets()
            .map_err(io::Error::other)?;
        let mut plaintext = [0; 512];
        loop {
            match self.server.reader().read(&mut plaintext) {
                Ok(0) => break,
                Ok(count) => self.request.extend_from_slice(&plaintext[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Poll::Ready(Err(error)),
            }
        }
        if self.request.len() >= FOLLOWUP_REQUEST.len() && !self.responded {
            assert_eq!(
                self.request, FOLLOWUP_REQUEST,
                "second request must be exact and occur once"
            );
            self.responded = true;
            self.server.writer().write_all(FOLLOWUP_RESPONSE)?;
        }
        self.flush_server();
        cx.waker().wake_by_ref();
        Poll::Ready(Ok(consumed))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Assert exact continuity and a clean next request/response on the same verified connection.
async fn assert_record_continuity(fragments: &'static [usize]) {
    let certificates = Certificates::new();
    let (client, mut server) = verified_pair(&certificates);
    let expected: Vec<u8> = (0..65_536).map(|index| (index % 251) as u8).collect();
    server.writer().write_all(&expected).unwrap();
    let mut socket = RecordSocket {
        server,
        encrypted: VecDeque::new(),
        fragments,
        read_sizes: Vec::new(),
        request: Vec::new(),
        responded: false,
    };
    socket.flush_server();
    assert!(
        socket.encrypted.len() > 16_384,
        "fixture must offer multiple coalesced TLS records, beyond the initial 4096-byte rustls intake"
    );
    let mut stream = AsyncRustlsClientStream {
        socket,
        connection: client,
        pending_tls: Vec::new(),
        pending_tls_offset: 0,
    };
    let mut observed = vec![0; expected.len()];
    let result =
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut observed)).await;
    assert!(
        matches!(result, Ok(Ok(_))),
        "verified TLS payload must survive every encrypted-read suffix; result={result:?}, actual socket reads={:?}",
        stream.socket.read_sizes
    );
    assert_eq!(
        observed, expected,
        "verified TLS plaintext must remain exact, ordered and unduplicated"
    );
    stream.write_all(FOLLOWUP_REQUEST).await.unwrap();
    stream.flush().await.unwrap();
    let mut response = vec![0; FOLLOWUP_RESPONSE.len()];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut response))
        .await
        .expect("second exchange deadline")
        .expect("second exchange TLS continuity");
    assert_eq!(response, FOLLOWUP_RESPONSE);
    assert!(stream.socket.responded);
    stream.socket.server.send_close_notify();
    stream.socket.flush_server();
    let mut extra = [0; 1];
    let count = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut extra))
        .await
        .expect("clean TLS close deadline")
        .expect("clean verified TLS close");
    assert_eq!(
        count, 0,
        "no plaintext may be duplicated after the second response"
    );
}

#[tokio::test]
async fn tls_io_coalesced_records_preserve_large_payload_and_next_exchange() {
    assert_record_continuity(&[16_384]).await;
}

#[tokio::test]
async fn tls_io_fragmented_records_preserve_large_payload_and_next_exchange() {
    assert_record_continuity(&[1, 7, 127, 1021]).await;
}
