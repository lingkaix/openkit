//! NanoCore-session owner role boundary.
//!
//! Owns the NanoHost-initiated authenticated NanoCore transport session:
//! rendezvous TLS classification, minimum verified-TLS client preparation,
//! presentation of S-2b-2 selected credential material via
//! `credential_slots::select_usable_credential`, and refusal to fall back to a
//! second slot after authentication rejection.
//!
//! This module does not invent a parallel credential framework or open
//! OpenShell/bridge/epoch paths. `sandbox_bridge` owns stock byte carriage and
//! its nested HTTP/2 session; this surface remains the fail-closed verified-TLS
//! presentation and credential boundary required for NanoHost→NanoCore admission.

#![allow(dead_code, clippy::assertions_on_constants)]

use std::future::Future;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use bytes::{Bytes, BytesMut};
use h2::server::SendResponse;
use http::{HeaderMap, Method, Request, Response, StatusCode};
use rustls::pki_types::{CertificateDer, ServerName, pem::PemObject};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{RwLock, watch};

use crate::credential_slots::{
    CredentialSelectionContext, CredentialSlot, SelectedCredential, SlotPairPaths,
    select_usable_credential,
};
use crate::epoch_coordinator::RuntimeEffectKind;
use crate::sandbox_bridge::{
    CAPABILITY_IN_FLIGHT_BYTES, CONNECTION_RECEIVE_WINDOW_BYTES, INFERENCE_IN_FLIGHT_BYTES,
    OUTER_MAX_CONCURRENT_STREAMS, PER_STREAM_RECEIVE_WINDOW_BYTES, RetainedExportResult,
    RouteFamily, WORKER_CONTROL_IN_FLIGHT_BYTES,
};

const FILE_DATA_BODY_MAX_BYTES: u64 = 256 * 1024 * 1024;
const FILE_DATA_APPLICATION_CHUNK_BYTES: usize = 64 * 1024;
const FILE_CONTENT_TYPE: &str = "application/octet-stream";
const REQUEST_ID_HEADER: &str = "x-openkit-request-id";
const SLOT_HEADER: &str = "x-openkit-slot";
const RELATIVE_PATH_HEADER: &str = "x-openkit-relative-path";
const SHA256_HEADER: &str = "x-openkit-sha256";
const BYTE_LENGTH_HEADER: &str = "x-openkit-byte-length";
const SANDBOX_INTEGRATION_BINDING_HEADER: &str = "x-openkit-integration-binding";
const HARNESS_POLL_PATH: &str = "/worker-control/harness/poll";
const HARNESS_RESULT_PATH: &str = "/worker-control/harness/result";

/// Cloneable route projection bound to one authoritative outer H2 connection.
#[derive(Clone)]
pub struct OuterRouteProjection {
    target: Arc<RwLock<Option<OuterRouteTarget>>>,
}

/// Current authoritative outer target replaced in place across reconnects.
#[derive(Clone)]
struct OuterRouteTarget {
    authority: String,
    predecessor_fenced: watch::Sender<bool>,
    sender: h2::client::SendRequest<Bytes>,
}

impl OuterRouteProjection {
    /// Creates one initially unbound projection retained for the Runtime Epoch.
    pub fn new() -> Self {
        Self {
            target: Arc::new(RwLock::new(None)),
        }
    }

    /// Rebinds route carriage to one admitted authoritative successor connection.
    pub async fn bind(&self, authority: &str, sender: h2::client::SendRequest<Bytes>) {
        let mut target = self.target.write().await;
        if let Some(predecessor) = target.as_ref() {
            predecessor.predecessor_fenced.send_replace(true);
        }
        let (predecessor_fenced, _) = watch::channel(false);
        *target = Some(OuterRouteTarget {
            authority: authority.trim_end_matches('/').to_string(),
            predecessor_fenced,
            sender,
        });
    }

    /// Projects one admitted nested request through the same ordinary outer path.
    ///
    /// # Errors
    ///
    /// Rejects a non-POST request, an oversized body, outer
    /// connection failure, or response delivery failure. The returned boolean is
    /// true only for an exact credential-free Harness poll accepted with empty `204`.
    pub async fn forward(
        &self,
        family: RouteFamily,
        request: Request<h2::RecvStream>,
        mut respond: SendResponse<Bytes>,
        sandbox_integration_binding_ref: &str,
    ) -> Result<bool, &'static str> {
        let target = self
            .target
            .read()
            .await
            .clone()
            .ok_or("outer route connection unavailable")?;
        if request.method() != Method::POST {
            send_nested_status(&mut respond, StatusCode::METHOD_NOT_ALLOWED)?;
            return Err("sandbox route method rejected");
        }
        let path = request
            .uri()
            .path_and_query()
            .map(|value| value.as_str().to_string())
            .ok_or("sandbox route path invalid")?;
        let expected_prefix = match family {
            RouteFamily::WorkerControl => "/worker-control/",
            RouteFamily::Inference => "/inference/",
            RouteFamily::Capabilities => "/capabilities/",
        };
        if !path.starts_with(expected_prefix) || path.starts_with("//") {
            send_nested_status(&mut respond, StatusCode::NOT_FOUND)?;
            return Err("sandbox route path rejected");
        }
        let private_harness_route = path == HARNESS_POLL_PATH || path == HARNESS_RESULT_PATH;
        if private_harness_route
            && (request.headers().contains_key(http::header::AUTHORIZATION)
                || request
                    .headers()
                    .contains_key(SANDBOX_INTEGRATION_BINDING_HEADER))
        {
            send_nested_status(&mut respond, StatusCode::BAD_REQUEST)?;
            return Err("sandbox Harness route supplied a forbidden header");
        }
        let body_limit = match family {
            RouteFamily::WorkerControl => WORKER_CONTROL_IN_FLIGHT_BYTES,
            RouteFamily::Inference => INFERENCE_IN_FLIGHT_BYTES,
            RouteFamily::Capabilities => CAPABILITY_IN_FLIGHT_BYTES,
        };
        let (parts, mut nested_body) = request.into_parts();
        let mut body = BytesMut::new();
        while let Some(chunk) = nested_body.data().await {
            let chunk = chunk.map_err(|_| "sandbox route body failed")?;
            if body.len() + chunk.len() > body_limit {
                send_nested_status(&mut respond, StatusCode::PAYLOAD_TOO_LARGE)?;
                return Err("sandbox route body exceeded bound");
            }
            nested_body
                .flow_control()
                .release_capacity(chunk.len())
                .map_err(|_| "sandbox route flow control failed")?;
            body.extend_from_slice(&chunk);
        }
        let initial_harness_poll =
            is_initial_harness_poll(&parts.method, &path, &parts.headers, &body);
        let mut builder = Request::builder()
            .method(parts.method)
            .uri(format!("{}{path}", target.authority));
        for (name, value) in &parts.headers {
            builder = builder.header(name, value);
        }
        if private_harness_route {
            let binding = http::HeaderValue::from_str(sandbox_integration_binding_ref)
                .map_err(|_| "Harness binding header invalid")?;
            builder = builder.header(SANDBOX_INTEGRATION_BINDING_HEADER, binding);
        }
        let outer_request = builder
            .body(())
            .map_err(|_| "outer route request invalid")?;
        let mut predecessor_fenced = target.predecessor_fenced.subscribe();
        tokio::select! {
            biased;
            _ = predecessor_fenced.wait_for(|fenced| *fenced) => {
                Err("outer route predecessor fenced")
            }
            result = async move {
                let mut ready = target
                    .sender
                    .clone()
                    .ready()
                    .await
                    .map_err(|_| "outer route connection closed")?;
                let (outer_response, mut outer_body) = ready
                    .send_request(outer_request, body.is_empty())
                    .map_err(|_| "outer route send failed")?;
                if !body.is_empty() {
                    send_h2_bytes(&mut outer_body, body.freeze(), true).await?;
                }
                let outer_response = outer_response
                    .await
                    .map_err(|_| "outer route response failed")?;
                let accepted_initial_harness_poll =
                    initial_harness_poll && outer_response.status() == StatusCode::NO_CONTENT;
                let (response_parts, mut response_body) = outer_response.into_parts();
                let mut response_builder = Response::builder().status(response_parts.status);
                for (name, value) in &response_parts.headers {
                    response_builder = response_builder.header(name, value);
                }
                let response = response_builder
                    .body(())
                    .map_err(|_| "nested route response invalid")?;
                let mut nested_output = respond
                    .send_response(response, false)
                    .map_err(|_| "nested route response failed")?;
                let mut response_bytes = 0;
                while let Some(chunk) = response_body.data().await {
                    let chunk = chunk.map_err(|_| "outer route response failed")?;
                    response_bytes += chunk.len();
                    send_h2_bytes(&mut nested_output, chunk.clone(), false).await?;
                    response_body
                        .flow_control()
                        .release_capacity(chunk.len())
                        .map_err(|_| "outer route response flow control failed")?;
                }
                send_h2_bytes(&mut nested_output, Bytes::new(), true).await?;
                Ok(accepted_initial_harness_poll && response_bytes == 0)
            } => result,
        }
    }
}

/// Sends one exact byte block after the peer grants stream capacity.
async fn send_h2_bytes(
    stream: &mut h2::SendStream<Bytes>,
    bytes: Bytes,
    end_stream: bool,
) -> Result<(), &'static str> {
    let mut offset = 0;
    while offset < bytes.len() {
        stream.reserve_capacity(bytes.len() - offset);
        let capacity = std::future::poll_fn(|context| stream.poll_capacity(context))
            .await
            .ok_or("H2 stream closed")?
            .map_err(|_| "H2 stream capacity failed")?;
        if capacity == 0 {
            continue;
        }
        let count = capacity.min(bytes.len() - offset);
        let last = offset + count == bytes.len();
        stream
            .send_data(bytes.slice(offset..offset + count), end_stream && last)
            .map_err(|_| "H2 stream data failed")?;
        offset += count;
    }
    if bytes.is_empty() && end_stream {
        stream
            .send_data(Bytes::new(), true)
            .map_err(|_| "H2 stream end failed")?;
    }
    Ok(())
}

/// Sends one bodyless nested failure response.
fn send_nested_status(
    respond: &mut SendResponse<Bytes>,
    status: StatusCode,
) -> Result<(), &'static str> {
    let response = Response::builder()
        .status(status)
        .body(())
        .map_err(|_| "nested route response invalid")?;
    respond
        .send_response(response, true)
        .map(|_| ())
        .map_err(|_| "nested route response failed")
}

/// Recognizes the exact Integration-scoped poll eligible for the readiness latch.
fn is_initial_harness_poll(method: &Method, path: &str, headers: &HeaderMap, body: &[u8]) -> bool {
    if method != Method::POST
        || path != HARNESS_POLL_PATH
        || headers.contains_key(http::header::AUTHORIZATION)
        || headers.contains_key(SANDBOX_INTEGRATION_BINDING_HEADER)
    {
        return false;
    }
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .is_some_and(|value| {
            value.as_object().is_some_and(|object| {
                object.len() == 1
                    && object
                        .get("schemaVersion")
                        .and_then(serde_json::Value::as_u64)
                        == Some(1)
            })
        })
}

/// One exact command returned from a fixed private effect path.
pub struct PolledEffectCommand {
    /// Closed local owner selected by the request path, never by the body.
    pub kind: RuntimeEffectKind,
    /// Opaque owner-derived request identity echoed by NanoHost.
    pub request_id: String,
    /// Operation-specific bounded body with the selector removed from consideration.
    pub input: serde_json::Value,
    /// Complete verified raw body for the one `reference.import` direction.
    pub file_data: Option<RawImportFile>,
}

/// Complete canonical metadata and verified bytes from one raw import response.
pub struct RawImportFile {
    /// Exact declared package slot.
    pub slot: String,
    /// Decoded normalized UTF-8 path relative to the declared slot.
    pub relative_path: PathBuf,
    /// Exact lowercase source digest.
    pub sha256: String,
    /// Exact declared and observed length.
    pub byte_length: u64,
    /// Complete source bytes, admitted only after all metadata verifies.
    pub bytes: Vec<u8>,
}

/// The exact eight command/result pairs carried on the authoritative connection.
const EFFECT_PATHS: [(&str, &str, RuntimeEffectKind); 8] = [
    (
        "/api/nanohost/transport/effects/sandbox.create",
        "/api/nanohost/transport/effects/sandbox.create/result",
        RuntimeEffectKind::CreateSandbox,
    ),
    (
        "/api/nanohost/transport/effects/sandbox.delete",
        "/api/nanohost/transport/effects/sandbox.delete/result",
        RuntimeEffectKind::DeleteSandbox,
    ),
    (
        "/api/nanohost/transport/effects/bridge.open",
        "/api/nanohost/transport/effects/bridge.open/result",
        RuntimeEffectKind::OpenBridge,
    ),
    (
        "/api/nanohost/transport/effects/bridge.close",
        "/api/nanohost/transport/effects/bridge.close/result",
        RuntimeEffectKind::CloseBridge,
    ),
    (
        "/api/nanohost/transport/effects/image.acquire",
        "/api/nanohost/transport/effects/image.acquire/result",
        RuntimeEffectKind::AcquireImage,
    ),
    (
        "/api/nanohost/transport/effects/image.build",
        "/api/nanohost/transport/effects/image.build/result",
        RuntimeEffectKind::BuildImage,
    ),
    (
        "/api/nanohost/transport/effects/file.export",
        "/api/nanohost/transport/effects/file.export/result",
        RuntimeEffectKind::ExportFile,
    ),
    (
        "/api/nanohost/transport/effects/reference.import",
        "/api/nanohost/transport/effects/reference.import/result",
        RuntimeEffectKind::ImportReference,
    ),
];
/// Fixed effect count used to retain the round-robin start after a successor result delivery.
pub const EFFECT_OPERATION_COUNT: usize = EFFECT_PATHS.len();
const FIRST_EFFECT_POLL_RESPONSE_LOST: &str = "first effect poll response lost";

/// Returns the effect polling cursor start for one physical outer session.
pub fn effect_cursor_start(has_retained_result: bool) -> usize {
    if has_retained_result {
        EFFECT_OPERATION_COUNT
    } else {
        0
    }
}

/// Returns the fixed effect owner selected by one fair polling cursor.
pub fn effect_kind_for_cursor(cursor: usize) -> RuntimeEffectKind {
    EFFECT_PATHS[cursor % EFFECT_PATHS.len()].2
}

/// Decision for NanoHost→NanoCore rendezvous transport security.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportSecurityDecision {
    /// Exact same-host loopback may use plaintext HTTP/2 under local trust.
    AllowPlaintextLoopback,
    /// Non-loopback rendezvous requires server-authenticated TLS.
    RequireServerAuthenticatedTls,
    /// Endpoint or trust posture is unacceptable; no authoritative session.
    Reject {
        /// Stable machine-readable reason (no secret material).
        reason: &'static str,
    },
}

/// Outcome of presenting credential material for one session attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialPresentationOutcome {
    /// Exactly the selected usable slot material is presented once.
    Presented {
        /// Selected slot.
        slot: CredentialSlot,
        /// Token id from companion metadata.
        token_id: String,
        /// Raw `okt_` secret from the selected slot.
        secret: String,
    },
    /// No usable material; NanoHost remains non-ready.
    NonReady,
    /// Authentication was rejected; no second-slot fallback is permitted.
    AuthRejected,
}

/// Trust material presented for server certificate validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsTrustMaterial {
    /// Platform trust store only.
    Platform,
    /// Explicit non-secret CA PEM path.
    ConfiguredRef {
        /// Non-secret CA PEM filesystem path (never a raw secret).
        reference: String,
    },
    /// Missing trust material.
    Missing,
    /// Present but explicitly untrusted / invalid for this deployment.
    Untrusted,
}

/// Fail-closed reasons when verified transport cannot be prepared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifiedTransportReject {
    /// Rendezvous URL could not be classified.
    InvalidRendezvous,
    /// Non-loopback plaintext would be a TLS downgrade.
    PlaintextNonLoopbackForbidden,
    /// Trust material is missing, unreadable, invalid, or explicitly untrusted.
    UntrustedTlsMaterial,
    /// Configured trust reference is empty.
    EmptyTrustReference,
}

/// Minimum verified transport surface for one NanoHost→NanoCore session attempt.
///
/// Non-loopback sessions carry a rustls `ClientConfig`. Exact same-host loopback
/// may omit TLS. Credential presentation is admitted only after this surface is
/// prepared; this type does not open OpenShell, bridge, or WP-4 route carriage.
#[derive(Clone)]
pub struct VerifiedSessionTransport {
    /// Whether server-authenticated TLS is required for this rendezvous.
    requires_tls: bool,
    /// rustls client configuration when TLS is required.
    tls_client_config: Option<Arc<ClientConfig>>,
}

/// Connected TCP or server-authenticated TLS stream for the outer H2 client.
pub enum VerifiedSessionIo {
    /// Exact same-host plaintext TCP stream.
    Plain(TcpStream),
    /// Rustls-protected TCP stream with the configured exclusive trust posture.
    Tls(Box<AsyncRustlsClientStream>),
}

/// Minimal async rustls client stream over the existing Tokio TCP capability.
pub struct AsyncRustlsClientStream<S = TcpStream> {
    socket: S,
    connection: ClientConnection,
    pending_tls: Vec<u8>,
    pending_tls_offset: usize,
}

impl VerifiedSessionTransport {
    /// Returns whether this transport requires server-authenticated TLS.
    pub fn requires_server_authenticated_tls(&self) -> bool {
        self.requires_tls
    }

    /// Returns the rustls client configuration when TLS is required.
    pub fn tls_client_config(&self) -> Option<&Arc<ClientConfig>> {
        self.tls_client_config.as_ref()
    }
}

impl AsyncRead for VerifiedSessionIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buffer),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buffer),
        }
    }
}

impl AsyncWrite for VerifiedSessionIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match &mut *self {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buffer),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buffer),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

impl<S> AsyncRustlsClientStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// Flushes queued rustls records to the underlying nonblocking socket.
    fn poll_flush_tls(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        loop {
            if self.pending_tls_offset == self.pending_tls.len() && self.connection.wants_write() {
                self.pending_tls.clear();
                self.pending_tls_offset = 0;
                self.connection.write_tls(&mut self.pending_tls)?;
            }
            while self.pending_tls_offset < self.pending_tls.len() {
                let written = match Pin::new(&mut self.socket)
                    .poll_write(cx, &self.pending_tls[self.pending_tls_offset..])
                {
                    Poll::Ready(result) => result?,
                    Poll::Pending => return Poll::Pending,
                };
                if written == 0 {
                    return Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "nanohost TLS socket write closed",
                    )));
                }
                self.pending_tls_offset += written;
            }
            if !self.connection.wants_write() {
                self.pending_tls.clear();
                self.pending_tls_offset = 0;
                return Poll::Ready(Ok(()));
            }
        }
    }

    /// Copies decrypted bytes or reports that rustls needs more TLS input.
    fn read_plaintext(&mut self, buffer: &mut ReadBuf<'_>) -> std::io::Result<Option<usize>> {
        let destination = buffer.initialize_unfilled();
        match self.connection.reader().read(destination) {
            Ok(read) => {
                buffer.advance(read);
                Ok(Some(read))
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl<S> AsyncRead for AsyncRustlsClientStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        loop {
            match self.read_plaintext(buffer) {
                Ok(Some(_)) => return Poll::Ready(Ok(())),
                Ok(None) => {}
                Err(error) => return Poll::Ready(Err(error)),
            }
            if self.connection.wants_write() {
                match self.poll_flush_tls(cx) {
                    Poll::Ready(Ok(())) => {}
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Pending => {}
                }
            }

            let mut encrypted = [0_u8; 16 * 1024];
            let mut encrypted_buffer = ReadBuf::new(&mut encrypted);
            match Pin::new(&mut self.socket).poll_read(cx, &mut encrypted_buffer) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Ready(Ok(())) => {
                    self.connection
                        .read_tls(&mut Cursor::new(encrypted_buffer.filled()))?;
                    self.connection
                        .process_new_packets()
                        .map_err(std::io::Error::other)?;
                }
            }
        }
    }
}

impl<S> AsyncWrite for AsyncRustlsClientStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.pending_tls_offset < self.pending_tls.len() {
            match self.poll_flush_tls(cx) {
                Poll::Ready(Ok(())) => {}
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            }
        }
        let written = self.connection.writer().write(buffer)?;
        match self.poll_flush_tls(cx) {
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) | Poll::Pending => Poll::Ready(Ok(written)),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.poll_flush_tls(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.socket).poll_flush(cx),
            other => other,
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.connection.send_close_notify();
        match self.as_mut().poll_flush(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.socket).poll_shutdown(cx),
            other => other,
        }
    }
}

/// Opens the exact configured TCP/TLS stream prepared for the outer session.
///
/// # Errors
///
/// Returns a bounded error when the exact origin, TCP rendezvous, server name,
/// or configured trust posture cannot produce a verified stream.
pub async fn connect_verified_session_transport(
    rendezvous_url: &str,
    transport: &VerifiedSessionTransport,
) -> Result<VerifiedSessionIo, &'static str> {
    let (host, port) = parse_rendezvous_origin(rendezvous_url)
        .map(|(_, host, port)| (host, port))
        .ok_or("nanohost rendezvous origin invalid")?;
    let socket = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|_| "nanohost NanoCore rendezvous failed")?;
    if !transport.requires_server_authenticated_tls() {
        return Ok(VerifiedSessionIo::Plain(socket));
    }
    let config = transport
        .tls_client_config()
        .cloned()
        .ok_or("nanohost TLS trust unavailable")?;
    let server_name = ServerName::try_from(host).map_err(|_| "nanohost TLS server name invalid")?;
    let connection = ClientConnection::new(config, server_name)
        .map_err(|_| "nanohost TLS client unavailable")?;
    Ok(VerifiedSessionIo::Tls(Box::new(AsyncRustlsClientStream {
        socket,
        connection,
        pending_tls: Vec::new(),
        pending_tls_offset: 0,
    })))
}

/// Classifies whether the NanoCore rendezvous URL requires verified TLS.
///
/// Exact same-host loopback may use plaintext. Every other parseable host,
/// including private LAN and container-bridge addresses, requires
/// server-authenticated TLS. Unparseable rendezvous URLs are rejected.
pub fn classify_rendezvous_transport(rendezvous_url: &str) -> TransportSecurityDecision {
    let Some(host) = extract_url_host(rendezvous_url) else {
        return TransportSecurityDecision::Reject {
            reason: "invalid_rendezvous_url",
        };
    };

    if is_loopback_host(&host) {
        TransportSecurityDecision::AllowPlaintextLoopback
    } else {
        TransportSecurityDecision::RequireServerAuthenticatedTls
    }
}

/// Returns whether trust material is sufficient to establish an authoritative
/// session under a TLS-required rendezvous.
///
/// Missing or untrusted material never permits an authoritative session.
/// Platform trust and a usable configured CA PEM are admissible.
pub fn tls_trust_permits_authoritative_session(trust: &TlsTrustMaterial) -> bool {
    build_verified_tls_client_config(trust).is_ok()
}

/// Prepares the minimum verified NanoHost→NanoCore transport surface.
///
/// Non-loopback plaintext is rejected (no downgrade). Missing or untrusted TLS
/// material is rejected. Non-loopback HTTPS with admissible trust builds a
/// rustls client configuration. Exact same-host loopback may omit TLS.
///
/// # Errors
///
/// Returns [`VerifiedTransportReject`] when the rendezvous or trust posture
/// cannot admit credential presentation.
pub fn prepare_verified_session_transport(
    rendezvous_url: &str,
    trust: &TlsTrustMaterial,
) -> Result<VerifiedSessionTransport, VerifiedTransportReject> {
    match classify_rendezvous_transport(rendezvous_url) {
        TransportSecurityDecision::Reject { .. } => Err(VerifiedTransportReject::InvalidRendezvous),
        TransportSecurityDecision::AllowPlaintextLoopback => {
            if rendezvous_uses_https(rendezvous_url) {
                let tls_client_config = build_verified_tls_client_config(trust)?;
                Ok(VerifiedSessionTransport {
                    requires_tls: true,
                    tls_client_config: Some(tls_client_config),
                })
            } else {
                Ok(VerifiedSessionTransport {
                    requires_tls: false,
                    tls_client_config: None,
                })
            }
        }
        TransportSecurityDecision::RequireServerAuthenticatedTls => {
            if !rendezvous_uses_https(rendezvous_url) {
                return Err(VerifiedTransportReject::PlaintextNonLoopbackForbidden);
            }
            let tls_client_config = build_verified_tls_client_config(trust)?;
            Ok(VerifiedSessionTransport {
                requires_tls: true,
                tls_client_config: Some(tls_client_config),
            })
        }
    }
}

/// Builds a rustls client configuration from admissible trust material.
///
/// # Errors
///
/// Returns [`VerifiedTransportReject::UntrustedTlsMaterial`] when trust is
/// missing, untrusted, unreadable, invalid, or contains no usable CA, or
/// [`VerifiedTransportReject::EmptyTrustReference`] when a configured reference
/// is empty.
fn build_verified_tls_client_config(
    trust: &TlsTrustMaterial,
) -> Result<Arc<ClientConfig>, VerifiedTransportReject> {
    match trust {
        TlsTrustMaterial::Missing | TlsTrustMaterial::Untrusted => {
            Err(VerifiedTransportReject::UntrustedTlsMaterial)
        }
        TlsTrustMaterial::ConfiguredRef { reference } if reference.is_empty() => {
            Err(VerifiedTransportReject::EmptyTrustReference)
        }
        TlsTrustMaterial::Platform => {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let config = ClientConfig::builder_with_provider(
                rustls::crypto::ring::default_provider().into(),
            )
            .with_safe_default_protocol_versions()
            .map_err(|_| VerifiedTransportReject::UntrustedTlsMaterial)?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Ok(Arc::new(config))
        }
        TlsTrustMaterial::ConfiguredRef { reference } => {
            let certificates = CertificateDer::pem_file_iter(reference)
                .map_err(|_| VerifiedTransportReject::UntrustedTlsMaterial)?;
            let mut roots = RootCertStore::empty();
            for certificate in certificates {
                roots
                    .add(certificate.map_err(|_| VerifiedTransportReject::UntrustedTlsMaterial)?)
                    .map_err(|_| VerifiedTransportReject::UntrustedTlsMaterial)?;
            }
            if roots.is_empty() {
                return Err(VerifiedTransportReject::UntrustedTlsMaterial);
            }
            let config = ClientConfig::builder_with_provider(
                rustls::crypto::ring::default_provider().into(),
            )
            .with_safe_default_protocol_versions()
            .map_err(|_| VerifiedTransportReject::UntrustedTlsMaterial)?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Ok(Arc::new(config))
        }
    }
}

/// Returns whether the rendezvous URL uses the `https` scheme.
fn rendezvous_uses_https(rendezvous_url: &str) -> bool {
    rendezvous_url
        .split_once("://")
        .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("https"))
}

/// Selects usable S-2b-2 slot material and presents at most that one slot.
///
/// Consumes `credential_slots::select_usable_credential`. Does not search
/// outside the declared slot pair and does not invent a second secret format.
pub fn select_and_present_credential(
    paths: &SlotPairPaths,
    context: &CredentialSelectionContext,
) -> CredentialPresentationOutcome {
    present_selected_credential(&select_usable_credential(paths, context))
}

/// Presents at most the S-2b-2 selected credential for one authentication attempt.
///
/// Does not search outside the selected material. Empty selection yields
/// `NonReady`.
pub fn present_selected_credential(selected: &SelectedCredential) -> CredentialPresentationOutcome {
    match selected {
        SelectedCredential::Empty => CredentialPresentationOutcome::NonReady,
        SelectedCredential::Usable {
            slot,
            token_id,
            secret,
            ..
        } => CredentialPresentationOutcome::Presented {
            slot: *slot,
            token_id: token_id.clone(),
            secret: secret.clone(),
        },
    }
}

/// Handles NanoCore authentication rejection for the already-presented material.
///
/// Always returns `AuthRejected`. Never presents another slot, even when
/// `other_slot` carries usable material.
pub fn after_authentication_rejection(
    _presented: &CredentialPresentationOutcome,
    _other_slot: Option<&SelectedCredential>,
) -> CredentialPresentationOutcome {
    CredentialPresentationOutcome::AuthRejected
}

/// Parses one exact `http`/`https` origin without accepting path or userinfo.
fn parse_rendezvous_origin(url: &str) -> Option<(&str, String, u16)> {
    let (scheme, authority) = url.split_once("://")?;
    if !matches!(scheme, "http" | "https")
        || authority.is_empty()
        || authority.contains(['/', '?', '#', '@'])
    {
        return None;
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, port_suffix) = rest.split_once(']')?;
        if host.is_empty() {
            return None;
        }
        let port = if port_suffix.is_empty() {
            default_port
        } else {
            port_suffix.strip_prefix(':')?.parse::<u16>().ok()?
        };
        return (port > 0).then_some((scheme, host.to_string(), port));
    }
    let mut parts = authority.split(':');
    let host = parts.next()?;
    let port = match parts.next() {
        Some(value) => value.parse::<u16>().ok()?,
        None => default_port,
    };
    if host.is_empty() || port == 0 || parts.next().is_some() {
        return None;
    }
    Some((scheme, host.to_string(), port))
}

/// Extracts the host from one exact rendezvous origin.
fn extract_url_host(url: &str) -> Option<String> {
    parse_rendezvous_origin(url).map(|(_, host, _)| host)
}

/// Returns true for exact same-host loopback names and addresses.
fn is_loopback_host(hostname: &str) -> bool {
    let normalized = hostname.to_ascii_lowercase();

    if normalized == "localhost" || normalized == "::1" {
        return true;
    }

    if let Some(mapped) = normalized.strip_prefix("::ffff:") {
        return is_loopback_host(mapped);
    }

    let mut parts = normalized.split('.');
    match (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) {
        (Some("127"), Some(b), Some(c), Some(d), None) => {
            b.parse::<u8>().is_ok() && c.parse::<u8>().is_ok() && d.parse::<u8>().is_ok()
        }
        _ => false,
    }
}

/// Closed lifecycle disposition for one physical outer-session failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OuterSessionDisposition {
    /// The observed physical close or eligible result-delivery uncertainty may reconnect.
    Reconnect,
    /// The failure ends the NanoHost process through its one diagnostic path.
    Terminal,
}

/// Closed stage at which one outer-session failure was observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OuterSessionStage {
    /// Physical transport connection or HTTP/2 handshake.
    Connect,
    /// Authoritative physical-session admission.
    Admission,
    /// Durable current-generation readiness acknowledgement.
    Readiness,
    /// One fixed effect-command poll.
    Poll,
    /// One fixed local effect execution.
    Execute,
    /// One correlated effect-result submission.
    Result,
}

/// Closed operation projection used by value-free outer-session diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OuterSessionOperation {
    /// No operation applies outside poll, execute, or result stages.
    None,
    /// `sandbox.create`.
    CreateSandbox,
    /// `sandbox.delete`.
    DeleteSandbox,
    /// `bridge.open`.
    OpenBridge,
    /// `bridge.close`.
    CloseBridge,
    /// `image.acquire`.
    AcquireImage,
    /// `image.build`.
    BuildImage,
    /// `file.export`.
    ExportFile,
    /// `reference.import`.
    ImportReference,
}

impl From<RuntimeEffectKind> for OuterSessionOperation {
    /// Projects one existing fixed effect owner into the diagnostic vocabulary.
    fn from(kind: RuntimeEffectKind) -> Self {
        match kind {
            RuntimeEffectKind::CreateSandbox => Self::CreateSandbox,
            RuntimeEffectKind::DeleteSandbox => Self::DeleteSandbox,
            RuntimeEffectKind::OpenBridge => Self::OpenBridge,
            RuntimeEffectKind::CloseBridge => Self::CloseBridge,
            RuntimeEffectKind::AcquireImage => Self::AcquireImage,
            RuntimeEffectKind::BuildImage => Self::BuildImage,
            RuntimeEffectKind::ExportFile => Self::ExportFile,
            RuntimeEffectKind::ImportReference => Self::ImportReference,
        }
    }
}

impl OuterSessionOperation {
    /// Returns the exact fixed operation literal or `none`.
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::CreateSandbox => "sandbox.create",
            Self::DeleteSandbox => "sandbox.delete",
            Self::OpenBridge => "bridge.open",
            Self::CloseBridge => "bridge.close",
            Self::AcquireImage => "image.acquire",
            Self::BuildImage => "image.build",
            Self::ExportFile => "file.export",
            Self::ImportReference => "reference.import",
        }
    }
}

/// Failure from one physical outer-session attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OuterSessionFailure {
    disposition: OuterSessionDisposition,
    stage: OuterSessionStage,
    operation: OuterSessionOperation,
    status: Option<u16>,
    reason: &'static str,
    reconnect_after: Option<u64>,
}

impl OuterSessionFailure {
    /// Creates one terminal, value-free failure classification.
    pub fn terminal(
        stage: OuterSessionStage,
        operation: OuterSessionOperation,
        status: Option<u16>,
        reason: &'static str,
    ) -> Self {
        Self::classified(
            OuterSessionDisposition::Terminal,
            stage,
            operation,
            status,
            reason,
            None,
        )
    }

    /// Creates one reconnectable physical-close or result-delivery classification.
    pub fn reconnect(
        stage: OuterSessionStage,
        operation: OuterSessionOperation,
        status: Option<u16>,
        reason: &'static str,
        reconnect_after: Option<u64>,
    ) -> Self {
        Self::classified(
            OuterSessionDisposition::Reconnect,
            stage,
            operation,
            status,
            reason,
            reconnect_after,
        )
    }

    /// Creates one normalized closed classification.
    fn classified(
        disposition: OuterSessionDisposition,
        stage: OuterSessionStage,
        operation: OuterSessionOperation,
        status: Option<u16>,
        reason: &'static str,
        reconnect_after: Option<u64>,
    ) -> Self {
        let operation = match stage {
            OuterSessionStage::Poll | OuterSessionStage::Execute | OuterSessionStage::Result => {
                operation
            }
            OuterSessionStage::Connect
            | OuterSessionStage::Admission
            | OuterSessionStage::Readiness => OuterSessionOperation::None,
        };
        let status = match status {
            Some(status @ 100..=599) => Some(status),
            _ => None,
        };
        Self {
            disposition,
            stage,
            operation,
            status,
            reason,
            reconnect_after,
        }
    }

    /// Returns the reconnect or terminal disposition.
    pub fn disposition(&self) -> OuterSessionDisposition {
        self.disposition
    }

    /// Returns the stable non-secret internal failure reason.
    pub fn reason(&self) -> &'static str {
        self.reason
    }

    /// Returns the allocated generation that a replacement connection must exceed.
    pub fn reconnect_after(&self) -> Option<u64> {
        self.reconnect_after
    }

    /// Retains the admitted generation for successor validation.
    pub fn with_reconnect_after(mut self, reconnect_after: Option<u64>) -> Self {
        self.reconnect_after = reconnect_after;
        self
    }
}

impl std::fmt::Display for OuterSessionFailure {
    /// Formats the exact bounded diagnostic without runtime or request values.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let disposition = match self.disposition {
            OuterSessionDisposition::Reconnect => "reconnect",
            OuterSessionDisposition::Terminal => "terminal",
        };
        let stage = match self.stage {
            OuterSessionStage::Connect => "connect",
            OuterSessionStage::Admission => "admission",
            OuterSessionStage::Readiness => "readiness",
            OuterSessionStage::Poll => "poll",
            OuterSessionStage::Execute => "execute",
            OuterSessionStage::Result => "result",
        };
        let status = self
            .status
            .map_or_else(|| "none".to_string(), |status| status.to_string());
        write!(
            formatter,
            "nanohost outer session failure: disposition={} stage={} operation={} status={}",
            disposition,
            stage,
            self.operation.as_str(),
            status
        )
    }
}

/// Runs one authenticated outbound HTTP/2 connection to NanoCore.
///
/// # Errors
///
/// Returns one bounded closed classification when the fixed session cannot continue.
pub async fn run_outer_session<IO, D, F>(
    io: IO,
    authority: &str,
    context: &CredentialSelectionContext,
    presentation: &CredentialPresentationOutcome,
    reconnect_after: Option<u64>,
    dispatch: D,
) -> Result<u64, OuterSessionFailure>
where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    D: FnOnce(u64, h2::client::SendRequest<Bytes>) -> F,
    F: Future<Output = Result<(), OuterSessionFailure>>,
{
    let authorization_secret = match presentation {
        CredentialPresentationOutcome::Presented { secret, .. } if secret.starts_with("okt_") => {
            secret
        }
        _ => {
            return Err(OuterSessionFailure::terminal(
                OuterSessionStage::Connect,
                OuterSessionOperation::None,
                None,
                "outer-session credential unavailable",
            ));
        }
    };
    let mut builder = h2::client::Builder::new();
    let file_data = 1_u32;
    let control_readiness = 1_u32;
    debug_assert_eq!(file_data + control_readiness, 2);
    builder
        .initial_connection_window_size(CONNECTION_RECEIVE_WINDOW_BYTES as u32)
        .initial_window_size(PER_STREAM_RECEIVE_WINDOW_BYTES as u32)
        .max_send_buffer_size(PER_STREAM_RECEIVE_WINDOW_BYTES)
        .max_concurrent_streams(OUTER_MAX_CONCURRENT_STREAMS);
    let (sender, connection) = builder.handshake(io).await.map_err(|_| {
        OuterSessionFailure::terminal(
            OuterSessionStage::Connect,
            OuterSessionOperation::None,
            None,
            "outer-session HTTP/2 handshake failed",
        )
        .with_reconnect_after(reconnect_after)
    })?;
    let admitted_generation = Arc::new(AtomicU64::new(0));
    let exchange_generation = Arc::clone(&admitted_generation);
    let exchange = async move {
        let mut sender = sender.ready().await.map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Admission,
                OuterSessionOperation::None,
                None,
                "outer-session physical connection closed",
                reconnect_after,
            )
        })?;
        let admission_uri = format!(
            "{}/api/nanohost/transport/session/admit",
            authority.trim_end_matches('/')
        );
        let admission = Request::builder()
            .method(Method::POST)
            .uri(admission_uri)
            .header("authorization", format!("Bearer {authorization_secret}"))
            .header("content-type", "application/json")
            .body(())
            .map_err(|_| {
                OuterSessionFailure::terminal(
                    OuterSessionStage::Admission,
                    OuterSessionOperation::None,
                    None,
                    "outer-session admission request invalid",
                )
                .with_reconnect_after(reconnect_after)
            })?;
        let (response, mut request_body) = sender.send_request(admission, false).map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Admission,
                OuterSessionOperation::None,
                None,
                "outer-session admission send failed",
                reconnect_after,
            )
        })?;
        request_body
            .send_data(Bytes::from_static(b"{}"), true)
            .map_err(|_| {
                OuterSessionFailure::reconnect(
                    OuterSessionStage::Admission,
                    OuterSessionOperation::None,
                    None,
                    "outer-session admission body send failed",
                    reconnect_after,
                )
            })?;
        let response = response.await.map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Admission,
                OuterSessionOperation::None,
                None,
                "outer-session admission response failed",
                reconnect_after,
            )
        })?;
        if response.status() != StatusCode::OK {
            return Err(OuterSessionFailure::terminal(
                OuterSessionStage::Admission,
                OuterSessionOperation::None,
                Some(response.status().as_u16()),
                "outer-session admission rejected",
            )
            .with_reconnect_after(reconnect_after));
        }

        let mut response_body = response.into_body();
        let mut admission_bytes = BytesMut::new();
        while let Some(chunk) = response_body.data().await {
            let chunk = chunk.map_err(|_| {
                OuterSessionFailure::reconnect(
                    OuterSessionStage::Admission,
                    OuterSessionOperation::None,
                    Some(StatusCode::OK.as_u16()),
                    "outer-session admission response failed",
                    reconnect_after,
                )
            })?;
            if admission_bytes.len() + chunk.len()
                > crate::sandbox_bridge::NANOHOST_CONTROL_IN_FLIGHT_BYTES
            {
                return Err(OuterSessionFailure::terminal(
                    OuterSessionStage::Admission,
                    OuterSessionOperation::None,
                    Some(StatusCode::OK.as_u16()),
                    "outer-session admission response exceeded bound",
                )
                .with_reconnect_after(reconnect_after));
            }
            response_body
                .flow_control()
                .release_capacity(chunk.len())
                .map_err(|_| {
                    OuterSessionFailure::terminal(
                        OuterSessionStage::Admission,
                        OuterSessionOperation::None,
                        Some(StatusCode::OK.as_u16()),
                        "outer-session admission flow control failed",
                    )
                    .with_reconnect_after(reconnect_after)
                })?;
            admission_bytes.extend_from_slice(&chunk);
        }
        let admission: serde_json::Value =
            serde_json::from_slice(&admission_bytes).map_err(|_| {
                OuterSessionFailure::terminal(
                    OuterSessionStage::Admission,
                    OuterSessionOperation::None,
                    Some(StatusCode::OK.as_u16()),
                    "outer-session admission response invalid",
                )
                .with_reconnect_after(reconnect_after)
            })?;
        let connection_generation = admission
            .get("connectionGeneration")
            .and_then(serde_json::Value::as_u64)
            .filter(|generation| {
                *generation > 0
                    && reconnect_after.is_none_or(|predecessor| *generation > predecessor)
            })
            .ok_or_else(|| {
                OuterSessionFailure::terminal(
                    OuterSessionStage::Admission,
                    OuterSessionOperation::None,
                    Some(StatusCode::OK.as_u16()),
                    "outer-session admission generation invalid",
                )
                .with_reconnect_after(reconnect_after)
            })?;
        let response_identity = admission
            .get("identityId")
            .and_then(serde_json::Value::as_str);
        let response_deployment = admission
            .get("deploymentId")
            .and_then(serde_json::Value::as_str);
        let authoritative = admission.get("role").and_then(serde_json::Value::as_str)
            == Some("authoritative")
            && admission
                .get("mayCarryWork")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
        if response_identity != Some(context.identity_id.as_str())
            || response_deployment != Some(context.deployment_id.as_str())
            || !authoritative
        {
            return Err(OuterSessionFailure::terminal(
                OuterSessionStage::Admission,
                OuterSessionOperation::None,
                Some(StatusCode::OK.as_u16()),
                "outer-session admission binding invalid",
            )
            .with_reconnect_after(Some(connection_generation)));
        }
        exchange_generation.store(connection_generation, Ordering::Release);

        let mut sender = sender.ready().await.map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Readiness,
                OuterSessionOperation::None,
                None,
                "outer-session physical connection closed",
                Some(connection_generation),
            )
        })?;
        let readiness_uri = format!(
            "{}/api/nanohost/transport/session/readiness",
            authority.trim_end_matches('/')
        );
        let readiness = Request::builder()
            .method(Method::POST)
            .uri(readiness_uri)
            .header("content-type", "application/json")
            .body(())
            .map_err(|_| {
                OuterSessionFailure::terminal(
                    OuterSessionStage::Readiness,
                    OuterSessionOperation::None,
                    None,
                    "outer-session readiness request invalid",
                )
                .with_reconnect_after(Some(connection_generation))
            })?;
        let (response, mut request_body) = sender.send_request(readiness, false).map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Readiness,
                OuterSessionOperation::None,
                None,
                "outer-session physical connection closed",
                Some(connection_generation),
            )
        })?;
        request_body
            .send_data(Bytes::from_static(b"{}"), true)
            .map_err(|_| {
                OuterSessionFailure::reconnect(
                    OuterSessionStage::Readiness,
                    OuterSessionOperation::None,
                    None,
                    "outer-session physical connection closed",
                    Some(connection_generation),
                )
            })?;
        let response = response.await.map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Readiness,
                OuterSessionOperation::None,
                None,
                "outer-session physical connection closed",
                Some(connection_generation),
            )
        })?;
        if response.status() != StatusCode::NO_CONTENT {
            return Err(OuterSessionFailure::terminal(
                OuterSessionStage::Readiness,
                OuterSessionOperation::None,
                Some(response.status().as_u16()),
                "outer-session readiness rejected",
            )
            .with_reconnect_after(Some(connection_generation)));
        }
        let mut response_body = response.into_body();
        while let Some(chunk) = response_body.data().await {
            let chunk = chunk.map_err(|_| {
                OuterSessionFailure::reconnect(
                    OuterSessionStage::Readiness,
                    OuterSessionOperation::None,
                    Some(StatusCode::NO_CONTENT.as_u16()),
                    "outer-session physical connection closed",
                    Some(connection_generation),
                )
            })?;
            if !chunk.is_empty() {
                return Err(OuterSessionFailure::terminal(
                    OuterSessionStage::Readiness,
                    OuterSessionOperation::None,
                    Some(StatusCode::NO_CONTENT.as_u16()),
                    "outer-session readiness response invalid",
                )
                .with_reconnect_after(Some(connection_generation)));
            }
            response_body
                .flow_control()
                .release_capacity(chunk.len())
                .map_err(|_| {
                    OuterSessionFailure::terminal(
                        OuterSessionStage::Readiness,
                        OuterSessionOperation::None,
                        Some(StatusCode::NO_CONTENT.as_u16()),
                        "outer-session readiness flow control failed",
                    )
                    .with_reconnect_after(Some(connection_generation))
                })?;
        }

        dispatch(connection_generation, sender)
            .await
            .map_err(|mut failure| {
                if reconnect_after.is_some()
                    && failure.disposition == OuterSessionDisposition::Reconnect
                    && failure.reason == FIRST_EFFECT_POLL_RESPONSE_LOST
                {
                    failure.disposition = OuterSessionDisposition::Terminal;
                }
                failure.with_reconnect_after(Some(connection_generation))
            })?;
        Ok(connection_generation)
    };
    let mut connection = tokio::spawn(connection);
    tokio::pin!(exchange);
    tokio::select! {
        biased;
        result = &mut exchange => {
            connection.abort();
            result
        },
        _ = &mut connection => {
            let generation = admitted_generation.load(Ordering::Acquire);
            Err(OuterSessionFailure::reconnect(
                OuterSessionStage::Connect,
                OuterSessionOperation::None,
                None,
                "outer-session physical connection closed",
                (generation != 0).then_some(generation).or(reconnect_after),
            ))
        }
    }
}

/// Polls the next fixed effect path in fair round-robin order.
///
/// A fully accepted live bridge makes loss of a later `bridge.open` poll response ordinary physical-connection loss because NanoHost cannot accept a second bridge command in that state.
///
/// # Errors
///
/// Rejects transport failure, any status other than `204` or `200`, an
/// oversized or malformed command, missing `requestId`, a body operation
/// selector, or bulk/credential/physical-connection fields.
pub async fn poll_effect_command(
    authority: &str,
    sender: &mut h2::client::SendRequest<Bytes>,
    cursor: &mut usize,
    live_bridge: bool,
) -> Result<Option<PolledEffectCommand>, OuterSessionFailure> {
    let first_poll = *cursor == 0;
    let kind = effect_kind_for_cursor(*cursor);
    let operation = OuterSessionOperation::from(kind);
    let (path, _, _) = EFFECT_PATHS[*cursor % EFFECT_PATHS.len()];
    *cursor = cursor.checked_add(1).unwrap_or(EFFECT_OPERATION_COUNT);
    if kind == RuntimeEffectKind::ImportReference {
        return poll_reference_import(authority, sender, path).await;
    }
    let (status, body) = match send_effect_request(authority, sender, path, b"{}").await {
        Ok(response) => response,
        Err(_) if kind == RuntimeEffectKind::OpenBridge && !live_bridge => {
            return Err(OuterSessionFailure::terminal(
                OuterSessionStage::Poll,
                operation,
                None,
                "bridge.open command delivery unknown",
            ));
        }
        Err(error) => {
            let physical_close = matches!(
                error,
                "effect connection closed"
                    | "effect request send failed"
                    | "effect request body send failed"
                    | "effect response failed"
            );
            let error = if first_poll
                && matches!(
                    error,
                    "effect request body send failed" | "effect response failed"
                ) {
                FIRST_EFFECT_POLL_RESPONSE_LOST
            } else {
                error
            };
            return Err(if physical_close {
                OuterSessionFailure::reconnect(
                    OuterSessionStage::Poll,
                    operation,
                    None,
                    error,
                    None,
                )
            } else {
                OuterSessionFailure::terminal(OuterSessionStage::Poll, operation, None, error)
            });
        }
    };
    if status == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if status != StatusCode::OK {
        return Err(OuterSessionFailure::terminal(
            OuterSessionStage::Poll,
            operation,
            Some(status.as_u16()),
            "effect command poll rejected",
        ));
    }
    let terminal = |reason| {
        OuterSessionFailure::terminal(
            OuterSessionStage::Poll,
            operation,
            Some(status.as_u16()),
            reason,
        )
    };
    let input: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| terminal("effect command body invalid"))?;
    let object = input
        .as_object()
        .ok_or_else(|| terminal("effect command body invalid"))?;
    let request_id = object
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_lowercase_hex(value, 64))
        .ok_or_else(|| terminal("effect command requestId invalid"))?
        .to_string();
    for rejected in [
        "operation",
        "kind",
        "bytes",
        "payload",
        "dockerfile",
        "authorization",
        "connectionGeneration",
        "physicalHandle",
    ] {
        if object.contains_key(rejected) {
            return Err(terminal("effect command contains forbidden field"));
        }
    }
    if kind == RuntimeEffectKind::OpenBridge {
        if object.len() != 2
            || !object
                .get("sandboxIntegrationBindingRef")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| {
                    !value.is_empty() && value.len() <= 512 && !value.contains(['\r', '\n', '\0'])
                })
        {
            return Err(terminal("static Harness bridge command invalid"));
        }
    } else if object.contains_key("sandboxIntegrationBindingRef") {
        return Err(terminal(
            "Harness binding field rejected for non-bridge effect",
        ));
    }
    let mut input = input;
    if kind == RuntimeEffectKind::BuildImage {
        let object = input
            .as_object()
            .ok_or_else(|| terminal("image.build command body invalid"))?;
        let expected_digest = object
            .get("dockerfileDigest")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                value
                    .strip_prefix("sha256:")
                    .is_some_and(|digest| is_lowercase_hex(digest, 64))
            })
            .ok_or_else(|| terminal("image.build digest invalid"))?
            .to_string();
        let expected_byte_length = object
            .get("dockerfileByteLength")
            .and_then(serde_json::Value::as_u64)
            .filter(|length| (1..=FILE_DATA_BODY_MAX_BYTES).contains(length))
            .ok_or_else(|| terminal("image.build byte length invalid"))?;
        let dockerfile = fetch_image_build_input(
            authority,
            sender,
            &request_id,
            &expected_digest,
            expected_byte_length,
        )
        .await;
        let object = input
            .as_object_mut()
            .ok_or_else(|| terminal("image.build command body invalid"))?;
        object.remove("dockerfileByteLength");
        match dockerfile {
            Ok(dockerfile) => {
                object.insert(
                    "dockerfile".to_string(),
                    serde_json::Value::String(dockerfile),
                );
            }
            Err(error) => {
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "nanohost effect failure: stage=input operation=BuildImage reason={error}"
                );
            }
        }
    }
    Ok(Some(PolledEffectCommand {
        kind,
        request_id,
        input,
        file_data: None,
    }))
}

/// Fetches and completely verifies one accepted `image.build` Dockerfile body.
///
/// # Errors
///
/// Rejects a failed fixed-path exchange, any invalid required response metadata,
/// incomplete or oversized bytes, digest disagreement, and non-UTF-8 input.
async fn fetch_image_build_input(
    authority: &str,
    sender: &mut h2::client::SendRequest<Bytes>,
    request_id: &str,
    expected_digest: &str,
    expected_byte_length: u64,
) -> Result<String, &'static str> {
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "{}/api/nanohost/transport/effects/image.build/input",
            authority.trim_end_matches('/')
        ))
        .header("content-type", "application/json")
        .header(REQUEST_ID_HEADER, request_id)
        .body(())
        .map_err(|_| "image.build input request invalid")?;
    let mut ready = sender
        .clone()
        .ready()
        .await
        .map_err(|_| "image.build input connection closed")?;
    let (response, mut request_body) = ready
        .send_request(request, false)
        .map_err(|_| "image.build input request send failed")?;
    request_body
        .send_data(Bytes::from_static(b"{}"), true)
        .map_err(|_| "image.build input request body send failed")?;
    let response = response
        .await
        .map_err(|_| "image.build input response failed")?;
    if response.status() != StatusCode::OK {
        let _ = writeln!(
            std::io::stderr().lock(),
            "nanohost effect failure: stage=input operation=BuildImage status={}",
            response.status().as_u16()
        );
        return Err("image.build input rejected");
    }
    let headers = response.headers();
    if required_header(headers, "content-type")? != FILE_CONTENT_TYPE
        || required_header(headers, REQUEST_ID_HEADER)? != request_id
        || required_header(headers, SHA256_HEADER)? != expected_digest
    {
        return Err("image.build input metadata invalid");
    }
    let byte_length_text = required_header(headers, BYTE_LENGTH_HEADER)?;
    let byte_length = byte_length_text
        .parse::<u64>()
        .ok()
        .filter(|length| {
            length.to_string() == byte_length_text
                && *length == expected_byte_length
                && (1..=FILE_DATA_BODY_MAX_BYTES).contains(length)
        })
        .ok_or("image.build input byte length invalid")?;
    let content_length_text = required_header(headers, "content-length")?;
    let content_length = content_length_text
        .parse::<u64>()
        .ok()
        .filter(|length| length.to_string() == content_length_text)
        .ok_or("image.build input content length invalid")?;
    if content_length != byte_length {
        return Err("image.build input length mismatch");
    }
    let mut response_body = response.into_body();
    let mut bytes = BytesMut::with_capacity(byte_length as usize);
    while let Some(chunk) = response_body.data().await {
        let chunk = chunk.map_err(|_| "image.build input response failed")?;
        if bytes.len() as u64 + chunk.len() as u64 > byte_length {
            return Err("image.build input body exceeded declared length");
        }
        for consumed in chunk.chunks(FILE_DATA_APPLICATION_CHUNK_BYTES) {
            bytes.extend_from_slice(consumed);
            response_body
                .flow_control()
                .release_capacity(consumed.len())
                .map_err(|_| "image.build input flow control failed")?;
        }
    }
    if bytes.len() as u64 != byte_length
        || format!("sha256:{:x}", Sha256::digest(&bytes)) != expected_digest
    {
        return Err("image.build input body digest or length mismatch");
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "image.build input UTF-8 invalid")
}

/// Polls and completely verifies the one raw `reference.import` response.
async fn poll_reference_import(
    authority: &str,
    sender: &mut h2::client::SendRequest<Bytes>,
    path: &str,
) -> Result<Option<PolledEffectCommand>, OuterSessionFailure> {
    let operation = OuterSessionOperation::ImportReference;
    let terminal_without_status =
        |reason| OuterSessionFailure::terminal(OuterSessionStage::Poll, operation, None, reason);
    let reconnect_without_status = |reason| {
        OuterSessionFailure::reconnect(OuterSessionStage::Poll, operation, None, reason, None)
    };
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("{}{}", authority.trim_end_matches('/'), path))
        .header("content-type", "application/json")
        .body(())
        .map_err(|_| terminal_without_status("reference.import poll invalid"))?;
    let mut ready = sender
        .clone()
        .ready()
        .await
        .map_err(|_| reconnect_without_status("effect connection closed"))?;
    let (response, mut request_body) = ready
        .send_request(request, false)
        .map_err(|_| reconnect_without_status("reference.import poll send failed"))?;
    request_body
        .send_data(Bytes::from_static(b"{}"), true)
        .map_err(|_| reconnect_without_status("reference.import poll body send failed"))?;
    let response = response
        .await
        .map_err(|_| reconnect_without_status("reference.import response failed"))?;
    let status = response.status();
    let terminal = |reason| {
        OuterSessionFailure::terminal(
            OuterSessionStage::Poll,
            operation,
            Some(status.as_u16()),
            reason,
        )
    };
    let reconnect = |reason| {
        OuterSessionFailure::reconnect(
            OuterSessionStage::Poll,
            operation,
            Some(status.as_u16()),
            reason,
            None,
        )
    };
    if status == StatusCode::NO_CONTENT {
        let mut body = response.into_body();
        if body
            .data()
            .await
            .transpose()
            .map_err(|_| reconnect("reference.import response failed"))?
            .is_some()
        {
            return Err(terminal("reference.import empty response invalid"));
        }
        return Ok(None);
    }
    if status != StatusCode::OK {
        return Err(terminal("reference.import command poll rejected"));
    }
    let headers = response.headers();
    if required_header(headers, "content-type").map_err(terminal)? != FILE_CONTENT_TYPE {
        return Err(terminal("reference.import content type invalid"));
    }
    let request_id = required_header(headers, REQUEST_ID_HEADER)
        .map_err(terminal)?
        .to_string();
    if !is_lowercase_hex(&request_id, 64) {
        return Err(terminal("reference.import requestId invalid"));
    }
    let slot = required_header(headers, SLOT_HEADER)
        .map_err(terminal)?
        .to_string();
    if !is_valid_slot(&slot) {
        return Err(terminal("reference.import slot invalid"));
    }
    let encoded_path = required_header(headers, RELATIVE_PATH_HEADER).map_err(terminal)?;
    let relative_path = decode_relative_path(encoded_path).map_err(terminal)?;
    let sha256 = required_header(headers, SHA256_HEADER)
        .map_err(terminal)?
        .to_string();
    if !sha256
        .strip_prefix("sha256:")
        .is_some_and(|digest| is_lowercase_hex(digest, 64))
    {
        return Err(terminal("reference.import digest invalid"));
    }
    let byte_length_text = required_header(headers, BYTE_LENGTH_HEADER).map_err(terminal)?;
    let byte_length = byte_length_text
        .parse::<u64>()
        .ok()
        .filter(|length| {
            length.to_string() == byte_length_text && *length <= FILE_DATA_BODY_MAX_BYTES
        })
        .ok_or_else(|| terminal("reference.import byte length invalid"))?;
    let content_length_text = required_header(headers, "content-length").map_err(terminal)?;
    let content_length = content_length_text
        .parse::<u64>()
        .ok()
        .filter(|length| length.to_string() == content_length_text)
        .ok_or_else(|| terminal("reference.import content length invalid"))?;
    if content_length != byte_length {
        return Err(terminal("reference.import length mismatch"));
    }
    let mut response_body = response.into_body();
    let mut bytes = BytesMut::new();
    while let Some(chunk) = response_body.data().await {
        let chunk = chunk.map_err(|_| reconnect("reference.import response failed"))?;
        if bytes.len() as u64 + chunk.len() as u64 > byte_length {
            return Err(terminal("reference.import body exceeded declared length"));
        }
        for consumed in chunk.chunks(FILE_DATA_APPLICATION_CHUNK_BYTES) {
            bytes.extend_from_slice(consumed);
            response_body
                .flow_control()
                .release_capacity(consumed.len())
                .map_err(|_| terminal("reference.import flow control failed"))?;
        }
    }
    if bytes.len() as u64 != byte_length || format!("sha256:{:x}", Sha256::digest(&bytes)) != sha256
    {
        return Err(terminal("reference.import body digest or length mismatch"));
    }
    Ok(Some(PolledEffectCommand {
        kind: RuntimeEffectKind::ImportReference,
        request_id,
        input: serde_json::json!({}),
        file_data: Some(RawImportFile {
            slot,
            relative_path,
            sha256,
            byte_length,
            bytes: bytes.to_vec(),
        }),
    }))
}

/// Submits one bounded correlated result on its fixed matching path.
///
/// # Errors
///
/// Rejects malformed identity, an oversized result, transport failure, or a
/// response other than an empty `204`. Callers retain the same result for a successor rather
/// than re-executing the accepted local effect.
pub async fn submit_effect_result(
    authority: &str,
    sender: &mut h2::client::SendRequest<Bytes>,
    command: &PolledEffectCommand,
    result: serde_json::Value,
) -> Result<(), OuterSessionFailure> {
    let operation = OuterSessionOperation::from(command.kind);
    let terminal_without_status =
        |reason| OuterSessionFailure::terminal(OuterSessionStage::Result, operation, None, reason);
    if command.request_id.is_empty() {
        return Err(terminal_without_status("effect result requestId invalid"));
    }
    let (_, path, _) = EFFECT_PATHS
        .iter()
        .find(|(_, _, kind)| *kind == command.kind)
        .ok_or_else(|| terminal_without_status("effect result path unavailable"))?;
    let mut body = result
        .as_object()
        .cloned()
        .ok_or_else(|| terminal_without_status("effect result body invalid"))?;
    if body.contains_key("requestId") {
        return Err(terminal_without_status("effect result body invalid"));
    }
    body.insert(
        "requestId".to_string(),
        serde_json::Value::String(command.request_id.clone()),
    );
    let body = serde_json::to_vec(&body)
        .map_err(|_| terminal_without_status("effect result body invalid"))?;
    if body.len() > crate::sandbox_bridge::NANOHOST_CONTROL_IN_FLIGHT_BYTES {
        return Err(terminal_without_status("effect result body exceeded bound"));
    }
    let (status, response) = match send_effect_request(authority, sender, path, &body).await {
        Ok(response) => response,
        Err(error) => {
            let delivery_uncertain = matches!(
                error,
                "effect connection closed"
                    | "effect request send failed"
                    | "effect request body send failed"
                    | "effect response failed"
            );
            return Err(if delivery_uncertain {
                OuterSessionFailure::reconnect(
                    OuterSessionStage::Result,
                    operation,
                    None,
                    error,
                    None,
                )
            } else {
                terminal_without_status(error)
            });
        }
    };
    if status != StatusCode::NO_CONTENT || !response.is_empty() {
        return Err(OuterSessionFailure::terminal(
            OuterSessionStage::Result,
            operation,
            Some(status.as_u16()),
            "effect result rejected",
        ));
    }
    Ok(())
}

/// Sends one retained complete `file.export` body on its fixed result path.
///
/// # Errors
///
/// Returns `file export result delivery uncertain` only when a successor may
/// resend the unchanged retained tuple. Any received non-204 status is a
/// definitive rejection and must not be retried.
pub async fn submit_file_export_result(
    authority: &str,
    sender: &mut h2::client::SendRequest<Bytes>,
    command: &PolledEffectCommand,
    result: &RetainedExportResult,
) -> Result<(), OuterSessionFailure> {
    let operation = OuterSessionOperation::ExportFile;
    let terminal_without_status =
        |reason| OuterSessionFailure::terminal(OuterSessionStage::Result, operation, None, reason);
    let reconnect_without_status = |reason| {
        OuterSessionFailure::reconnect(OuterSessionStage::Result, operation, None, reason, None)
    };
    if command.kind != RuntimeEffectKind::ExportFile
        || command.request_id != result.request_id()
        || !is_lowercase_hex(result.request_id(), 64)
        || result.byte_length() > FILE_DATA_BODY_MAX_BYTES
        || result.bytes().len() as u64 != result.byte_length()
        || format!("sha256:{:x}", Sha256::digest(result.bytes())) != result.sha256()
    {
        return Err(terminal_without_status("file export result invalid"));
    }
    let (_, path, _) = EFFECT_PATHS
        .iter()
        .find(|(_, _, kind)| *kind == RuntimeEffectKind::ExportFile)
        .ok_or_else(|| terminal_without_status("file export result path unavailable"))?;
    let relative_path =
        encode_relative_path(result.relative_path()).map_err(terminal_without_status)?;
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("{}{}", authority.trim_end_matches('/'), path))
        .header("content-type", FILE_CONTENT_TYPE)
        .header("content-length", result.byte_length().to_string())
        .header(REQUEST_ID_HEADER, result.request_id())
        .header(SLOT_HEADER, result.slot())
        .header(RELATIVE_PATH_HEADER, relative_path)
        .header(SHA256_HEADER, result.sha256())
        .header(BYTE_LENGTH_HEADER, result.byte_length().to_string())
        .body(())
        .map_err(|_| terminal_without_status("file export result invalid"))?;
    let mut ready = sender
        .clone()
        .ready()
        .await
        .map_err(|_| reconnect_without_status("file export result delivery uncertain"))?;
    let (response, mut request_body) = ready
        .send_request(request, false)
        .map_err(|_| reconnect_without_status("file export result delivery uncertain"))?;
    let mut offset = 0;
    while offset < result.bytes().len() {
        let wanted = (result.bytes().len() - offset).min(FILE_DATA_APPLICATION_CHUNK_BYTES);
        request_body.reserve_capacity(wanted);
        let available = std::future::poll_fn(|context| request_body.poll_capacity(context))
            .await
            .ok_or_else(|| reconnect_without_status("file export result delivery uncertain"))?
            .map_err(|_| reconnect_without_status("file export result delivery uncertain"))?;
        let sent = available.min(wanted);
        if sent == 0 {
            continue;
        }
        request_body
            .send_data(
                Bytes::copy_from_slice(&result.bytes()[offset..offset + sent]),
                false,
            )
            .map_err(|_| reconnect_without_status("file export result delivery uncertain"))?;
        offset += sent;
    }
    request_body
        .send_data(Bytes::new(), true)
        .map_err(|_| reconnect_without_status("file export result delivery uncertain"))?;
    let response = response
        .await
        .map_err(|_| reconnect_without_status("file export result delivery uncertain"))?;
    let status = response.status();
    if status != StatusCode::NO_CONTENT {
        return Err(OuterSessionFailure::terminal(
            OuterSessionStage::Result,
            operation,
            Some(status.as_u16()),
            "file export result rejected",
        ));
    }
    let mut response_body = response.into_body();
    if response_body
        .data()
        .await
        .transpose()
        .map_err(|_| {
            OuterSessionFailure::reconnect(
                OuterSessionStage::Result,
                operation,
                Some(status.as_u16()),
                "file export result delivery uncertain",
                None,
            )
        })?
        .is_some()
    {
        return Err(OuterSessionFailure::terminal(
            OuterSessionStage::Result,
            operation,
            Some(status.as_u16()),
            "file export result rejected",
        ));
    }
    Ok(())
}

/// Returns one required non-duplicated visible-ASCII response header.
fn required_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, &'static str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().ok_or("file-data header missing")?;
    if values.next().is_some() {
        return Err("file-data header duplicated");
    }
    value.to_str().map_err(|_| "file-data header invalid")
}

/// Returns whether one identity is exact lowercase hexadecimal text.
fn is_lowercase_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// Returns whether one package slot matches the closed ASCII slot grammar.
fn is_valid_slot(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= 128
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Decodes and verifies the canonical uppercase-percent relative-path header.
fn decode_relative_path(encoded: &str) -> Result<PathBuf, &'static str> {
    if encoded.is_empty()
        || encoded.len() > 4096
        || encoded.starts_with('/')
        || encoded.ends_with('/')
        || encoded.contains("//")
        || !encoded.is_ascii()
    {
        return Err("file-data relative path invalid");
    }
    let source = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            if index + 2 >= source.len() {
                return Err("file-data relative path invalid");
            }
            let high = decode_hex(source[index + 1])?;
            let low = decode_hex(source[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(source[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| "file-data relative path invalid")?;
    if decoded.contains('\\') || decoded.chars().any(char::is_control) {
        return Err("file-data relative path invalid");
    }
    let path = PathBuf::from(&decoded);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().collect::<PathBuf>() != path
        || encode_relative_path(&path)? != encoded
    {
        return Err("file-data relative path invalid");
    }
    Ok(path)
}

/// Encodes one normalized UTF-8 relative path into its canonical header form.
fn encode_relative_path(path: &Path) -> Result<String, &'static str> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().collect::<PathBuf>() != path
    {
        return Err("file-data relative path invalid");
    }
    let path = path.to_str().ok_or("file-data relative path invalid")?;
    let mut encoded = String::with_capacity(path.len());
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' | b'/'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    if encoded.len() > 4096 {
        return Err("file-data relative path invalid");
    }
    Ok(encoded)
}

/// Decodes one canonical uppercase hexadecimal digit.
fn decode_hex(byte: u8) -> Result<u8, &'static str> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("file-data relative path invalid"),
    }
}

/// Sends one ordinary fixed-path JSON request and collects its bounded response.
async fn send_effect_request(
    authority: &str,
    sender: &mut h2::client::SendRequest<Bytes>,
    path: &str,
    body: &[u8],
) -> Result<(StatusCode, BytesMut), &'static str> {
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("{}{}", authority.trim_end_matches('/'), path))
        .header("content-type", "application/json")
        .body(())
        .map_err(|_| "effect request invalid")?;
    let mut ready = sender
        .clone()
        .ready()
        .await
        .map_err(|_| "effect connection closed")?;
    let (response, mut request_body) = ready
        .send_request(request, false)
        .map_err(|_| "effect request send failed")?;
    request_body
        .send_data(Bytes::copy_from_slice(body), true)
        .map_err(|_| "effect request body send failed")?;
    let response = response.await.map_err(|_| "effect response failed")?;
    let status = response.status();
    let mut response_body = response.into_body();
    let mut bytes = BytesMut::new();
    while let Some(chunk) = response_body.data().await {
        let chunk = chunk.map_err(|_| "effect response failed")?;
        if bytes.len() + chunk.len() > crate::sandbox_bridge::NANOHOST_CONTROL_IN_FLIGHT_BYTES {
            return Err("effect response exceeded bound");
        }
        response_body
            .flow_control()
            .release_capacity(chunk.len())
            .map_err(|_| "effect response flow control failed")?;
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}

/// Test-only bounded request used to prove predecessor and replay fencing.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OuterSessionEnvelope {
    nanohost_id: String,
    connection_generation: u64,
    request_id: String,
    operation: String,
    byte_length: usize,
}

#[cfg(test)]
impl OuterSessionEnvelope {
    /// Creates one untrusted envelope for validation by [`OuterSessionState::accept`].
    pub fn new(
        nanohost_id: &str,
        connection_generation: u64,
        request_id: &str,
        operation: &str,
        byte_length: usize,
    ) -> Self {
        Self {
            nanohost_id: nanohost_id.to_string(),
            connection_generation,
            request_id: request_id.to_string(),
            operation: operation.to_string(),
            byte_length,
        }
    }

    /// Returns the exact request identity carried by the envelope.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

/// Test-only predecessor-fenced state for one connection generation.
#[cfg(test)]
pub struct OuterSessionState {
    nanohost_id: String,
    connection_generation: u64,
    predecessor_generation: Option<u64>,
    predecessor_closed: bool,
    accepted_requests: std::collections::BTreeSet<String>,
    cancelled: bool,
}

#[cfg(test)]
impl OuterSessionState {
    /// Creates one inactive successor or one predecessor-free current generation.
    pub fn new(
        nanohost_id: &str,
        connection_generation: u64,
        predecessor_generation: Option<u64>,
    ) -> Self {
        Self {
            nanohost_id: nanohost_id.to_string(),
            connection_generation,
            predecessor_generation,
            predecessor_closed: predecessor_generation.is_none(),
            accepted_requests: std::collections::BTreeSet::new(),
            cancelled: false,
        }
    }

    /// Records exact predecessor closure before a successor may carry work.
    ///
    /// # Errors
    ///
    /// Returns an error when the supplied generation is not the declared predecessor.
    pub fn close_predecessor(&mut self, generation: u64) -> Result<(), &'static str> {
        if self.predecessor_generation != Some(generation) {
            return Err("outer-session predecessor mismatch");
        }
        self.predecessor_closed = true;
        Ok(())
    }

    /// Accepts one exact, bounded, non-replayed request for the current generation.
    ///
    /// # Errors
    ///
    /// Rejects cancelled state, an open predecessor, identity or generation mismatch,
    /// malformed identity, replay, or a control envelope above the owned byte ceiling.
    pub fn accept(&mut self, envelope: &OuterSessionEnvelope) -> Result<(), &'static str> {
        if self.cancelled {
            return Err("outer session cancelled");
        }
        if !self.predecessor_closed {
            return Err("outer-session predecessor remains open");
        }
        if envelope.nanohost_id != self.nanohost_id
            || envelope.connection_generation != self.connection_generation
        {
            return Err("outer-session identity mismatch");
        }
        if envelope.request_id.is_empty()
            || envelope.operation.is_empty()
            || envelope.request_id.contains(['\r', '\n', '\0'])
            || envelope.operation.contains(['\r', '\n', '\0'])
            || envelope.byte_length > crate::sandbox_bridge::NANOHOST_CONTROL_IN_FLIGHT_BYTES
        {
            return Err("outer-session envelope rejected");
        }
        if !self.accepted_requests.insert(envelope.request_id.clone()) {
            return Err("outer-session request replay");
        }
        Ok(())
    }

    /// Verifies that one result belongs to an accepted request on this generation.
    ///
    /// # Errors
    ///
    /// Rejects cancelled state, unknown requests, and mismatched result identity.
    pub fn validate_result_identity(
        &self,
        request_id: &str,
        result_request_id: &str,
    ) -> Result<(), &'static str> {
        if self.cancelled
            || request_id != result_request_id
            || !self.accepted_requests.contains(request_id)
        {
            return Err("outer-session result identity mismatch");
        }
        Ok(())
    }

    /// Cancels the current generation and rejects every later request or result.
    pub fn cancel(&mut self) {
        self.cancelled = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_slots::{CredentialSlot, SelectedCredential};
    use crate::sandbox_bridge::{
        CAPABILITY_IN_FLIGHT_BYTES, CONNECTION_RECEIVE_WINDOW_BYTES, INFERENCE_IN_FLIGHT_BYTES,
        NANOHOST_CONTROL_IN_FLIGHT_BYTES, OUTER_MAX_CONCURRENT_STREAMS,
        PER_STREAM_RECEIVE_WINDOW_BYTES, WORKER_CONTROL_IN_FLIGHT_BYTES,
    };

    #[test]
    fn wp5_outer_session_is_one_authenticated_outbound_h2_client_runner() {
        assert_eq!(OUTER_MAX_CONCURRENT_STREAMS, 16);
        assert_eq!(CONNECTION_RECEIVE_WINDOW_BYTES, 5 * 1024 * 1024);
        assert_eq!(PER_STREAM_RECEIVE_WINDOW_BYTES, 256 * 1024);
        assert_eq!(WORKER_CONTROL_IN_FLIGHT_BYTES, 1024 * 1024);
        assert_eq!(INFERENCE_IN_FLIGHT_BYTES, 2 * 1024 * 1024);
        assert_eq!(CAPABILITY_IN_FLIGHT_BYTES, 512 * 1024);
        assert_eq!(NANOHOST_CONTROL_IN_FLIGHT_BYTES, 512 * 1024);
        assert!(
            WORKER_CONTROL_IN_FLIGHT_BYTES
                + INFERENCE_IN_FLIGHT_BYTES
                + CAPABILITY_IN_FLIGHT_BYTES
                + NANOHOST_CONTROL_IN_FLIGHT_BYTES
                < CONNECTION_RECEIVE_WINDOW_BYTES
        );

        let source = include_str!("nanocore_session.rs")
            .split_once("#[cfg(test)]")
            .expect("NanoCore session production section")
            .0;
        assert!(
            source.contains("h2::client::Builder::new()"),
            "NanoHost must own the outer HTTP/2 client runner"
        );
        assert!(source.contains("initial_connection_window_size(CONNECTION_RECEIVE_WINDOW_BYTES"));
        assert!(source.contains("initial_window_size(PER_STREAM_RECEIVE_WINDOW_BYTES"));
        assert!(source.contains("/api/nanohost/transport/session/admit"));
        assert!(source.contains("authorization"));
        assert!(source.contains("send_request"));
        assert!(source.contains("send_data(Bytes::from_static(b\"{}\"), true)"));
        let admission_request = source
            .split_once("let admission = Request::builder()")
            .expect("ordinary admission request")
            .1
            .split_once("let (response")
            .expect("admission send boundary")
            .0;
        assert!(!admission_request.contains("connectionGeneration"));
        assert!(!admission_request.contains("predecessorGeneration"));
        assert!(source.contains("connection_generation"));
        assert!(source.contains("reconnect"));
        assert!(!source.contains("h2::server::Builder::new()"));
        assert!(!source.contains("priority"));
        assert!(source.contains("requestId"));
        for operation in [
            "sandbox.create",
            "sandbox.delete",
            "bridge.open",
            "bridge.close",
            "image.acquire",
            "image.build",
            "file.export",
            "reference.import",
        ] {
            let command_path = format!("/api/nanohost/transport/effects/{operation}");
            let result_path = format!("{command_path}/result");
            assert!(source.contains(&command_path), "missing {command_path}");
            assert!(source.contains(&result_path), "missing {result_path}");
        }
        assert!(!source.contains("attempt-session.cleanup"));
        assert!(!source.contains("/effects/{operation}"));
        for bridge_rule in [
            "sandboxIntegrationBindingRef",
            "x-openkit-integration-binding",
            "/worker-control/harness/poll",
            "/worker-control/harness/result",
            "bridge.open",
            "accepted",
            "unknown",
        ] {
            assert!(
                source.contains(bridge_rule),
                "missing static Harness bridge rule {bridge_rule}"
            );
        }
        assert!(!source.contains("workerControlToken"));
        assert!(!source.contains("workerInferenceToken"));
        assert!(source.contains("reconnect"));
        assert!(source.contains("retained"));
        for raw_rule in [
            "application/octet-stream",
            "x-openkit-request-id",
            "x-openkit-slot",
            "x-openkit-relative-path",
            "x-openkit-sha256",
            "x-openkit-byte-length",
            "256 * 1024 * 1024",
            "64 * 1024",
            "release_capacity",
        ] {
            assert!(
                source.contains(raw_rule),
                "missing file-data rule {raw_rule}"
            );
        }
        assert!(source.contains("reference.import"));
        assert!(source.contains("file.export"));
        assert!(source.contains("file_data"));
        assert!(source.contains("control_readiness"));

        let admission = source
            .find("/api/nanohost/transport/session/admit")
            .expect("authoritative admission request");
        let readiness = source
            .find("/api/nanohost/transport/session/readiness")
            .expect("durable readiness request");
        let dispatch = source
            .find("dispatch(connection_generation, sender)")
            .expect("first effect dispatcher boundary");
        assert!(admission < readiness && readiness < dispatch);
        let readiness_exchange = &source[readiness..dispatch];
        assert!(readiness_exchange.contains("send_data(Bytes::from_static(b\"{}\"), true)"));
        assert!(readiness_exchange.contains("StatusCode::NO_CONTENT"));
        assert!(readiness_exchange.contains("return Err"));
        assert!(readiness_exchange.contains("response.into_body()"));

        let main_source = include_str!("main.rs")
            .split_once("#[cfg(test)]")
            .expect("NanoHost main production section")
            .0;
        let epoch_start = main_source
            .find("EpochCoordinator::start(")
            .expect("fresh Runtime Epoch start");
        let session_start = main_source
            .find("run_outer_session(")
            .expect("authoritative outer session activation");
        assert!(epoch_start < session_start);
    }

    #[test]
    fn initial_harness_poll_is_exact_and_credential_free() {
        let headers = http::HeaderMap::new();
        let body = br#"{"schemaVersion":1}"#;
        assert!(is_initial_harness_poll(
            &Method::POST,
            "/worker-control/harness/poll",
            &headers,
            body,
        ));
        assert!(!is_initial_harness_poll(
            &Method::POST,
            "/worker-control/harness/result",
            &headers,
            body,
        ));
        assert!(!is_initial_harness_poll(
            &Method::POST,
            "/worker-control/harness/poll",
            &headers,
            br#"{"schemaVersion":1,"nextExpectedSequence":1}"#,
        ));
        assert!(!is_initial_harness_poll(
            &Method::POST,
            "/worker-control/harness/poll",
            &headers,
            br#"{"schemaVersion":1,"nextExpectedSequence":0}"#,
        ));
        let mut credential_headers = http::HeaderMap::new();
        credential_headers.insert(
            http::header::AUTHORIZATION,
            http::HeaderValue::from_static("Bearer forbidden"),
        );
        assert!(!is_initial_harness_poll(
            &Method::POST,
            "/worker-control/harness/poll",
            &credential_headers,
            body,
        ));
        credential_headers.remove(http::header::AUTHORIZATION);
        credential_headers.insert(
            "x-openkit-integration-binding",
            http::HeaderValue::from_static("client-forbidden"),
        );
        assert!(!is_initial_harness_poll(
            &Method::POST,
            "/worker-control/harness/poll",
            &credential_headers,
            body,
        ));
    }

    #[tokio::test]
    async fn successor_bind_fences_one_inflight_predecessor_route() {
        let projection = OuterRouteProjection::new();
        let (outer_client_io, outer_server_io) = tokio::io::duplex(4096);
        let (outer_seen_tx, outer_seen_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut connection = h2::server::handshake(outer_server_io)
                .await
                .expect("outer server handshake");
            let (_request, _respond) = connection
                .accept()
                .await
                .expect("outer request stream")
                .expect("accepted outer request");
            outer_seen_tx.send(()).expect("signal accepted outer route");
            std::future::pending::<()>().await;
        });
        let (outer_sender, outer_connection) = h2::client::handshake(outer_client_io)
            .await
            .expect("outer client handshake");
        tokio::spawn(outer_connection);
        projection
            .bind("http://predecessor.test", outer_sender.clone())
            .await;

        let (nested_client_io, nested_server_io) = tokio::io::duplex(4096);
        let projection_for_route = projection.clone();
        let nested_server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(nested_server_io)
                .await
                .expect("nested server handshake");
            let (request, respond) = connection
                .accept()
                .await
                .expect("nested request stream")
                .expect("accepted nested request");
            projection_for_route
                .forward(
                    RouteFamily::Capabilities,
                    request,
                    respond,
                    "harness-binding",
                )
                .await
        });
        let (mut nested_sender, nested_connection) = h2::client::handshake(nested_client_io)
            .await
            .expect("nested client handshake");
        tokio::spawn(nested_connection);
        let request = Request::builder()
            .method(Method::POST)
            .uri("/capabilities/mcp/echo")
            .header("content-type", "application/json")
            .body(())
            .expect("nested request");
        let (nested_response, mut nested_body) = nested_sender
            .send_request(request, false)
            .expect("nested request send");
        nested_body
            .send_data(
                Bytes::from_static(br#"{"schemaVersion":1,"nextExpectedSequence":2}"#),
                true,
            )
            .expect("nested body send");
        outer_seen_rx.await.expect("outer route acceptance");

        projection.bind("http://successor.test", outer_sender).await;

        let route_result =
            tokio::time::timeout(std::time::Duration::from_millis(100), nested_server)
                .await
                .expect("predecessor route remained live after successor bind")
                .expect("nested route task");
        assert_eq!(route_result, Err("outer route predecessor fenced"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), nested_response)
                .await
                .expect("nested predecessor response remained live")
                .is_err()
        );
    }

    #[tokio::test]
    async fn wp5_r8_fetches_and_verifies_exact_image_build_input_before_dispatch() {
        let (client_io, server_io) = tokio::io::duplex(5 * 1024 * 1024);
        let (mut sender, connection) = h2::client::handshake(client_io)
            .await
            .expect("client handshake");
        let client_driver = tokio::spawn(connection);
        let dockerfile = "é".repeat(965_971);
        let dockerfile_bytes = dockerfile.as_bytes().to_vec();
        assert_eq!(dockerfile_bytes.len(), 1_931_942);
        let dockerfile_digest = format!("sha256:{:x}", Sha256::digest(&dockerfile_bytes));
        let request_id = "f".repeat(64);
        let server_request_id = request_id.clone();
        let server_digest = dockerfile_digest.clone();
        let server_bytes = dockerfile_bytes.clone();
        let (verified_sender, mut verified_receiver) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(server_io)
                .await
                .expect("server handshake");
            for expected_path in [
                "/api/nanohost/transport/effects/image.build",
                "/api/nanohost/transport/effects/image.build/input",
            ] {
                let (request, mut respond) = connection
                    .accept()
                    .await
                    .expect("request stream")
                    .expect("accepted request");
                assert_eq!(request.method(), Method::POST);
                assert_eq!(request.uri().path(), expected_path);
                assert_eq!(
                    request.headers().get("content-type").unwrap(),
                    "application/json"
                );
                if expected_path.ends_with("/input") {
                    assert_eq!(
                        request.headers().get(REQUEST_ID_HEADER).unwrap(),
                        server_request_id.as_str()
                    );
                } else {
                    assert!(request.headers().get(REQUEST_ID_HEADER).is_none());
                }
                let mut body = request.into_body();
                let mut request_bytes = BytesMut::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("request body");
                    body.flow_control()
                        .release_capacity(chunk.len())
                        .expect("request flow control");
                    request_bytes.extend_from_slice(&chunk);
                }
                assert_eq!(request_bytes.as_ref(), b"{}");
                if expected_path.ends_with("/input") {
                    let response = Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", FILE_CONTENT_TYPE)
                        .header("content-length", server_bytes.len().to_string())
                        .header(REQUEST_ID_HEADER, server_request_id.as_str())
                        .header(SHA256_HEADER, server_digest.as_str())
                        .header(BYTE_LENGTH_HEADER, server_bytes.len().to_string())
                        .header("date", "Mon, 10 Aug 2026 00:00:00 GMT")
                        .header("cache-control", "no-store")
                        .body(())
                        .expect("raw input response");
                    let mut response_body = respond
                        .send_response(response, false)
                        .expect("raw input response send");
                    let response_bytes = server_bytes.clone();
                    let mut send_response = tokio::spawn(async move {
                        let chunk_count = response_bytes
                            .chunks(FILE_DATA_APPLICATION_CHUNK_BYTES)
                            .count();
                        for (index, chunk) in response_bytes
                            .chunks(FILE_DATA_APPLICATION_CHUNK_BYTES)
                            .enumerate()
                        {
                            send_h2_bytes(
                                &mut response_body,
                                Bytes::copy_from_slice(chunk),
                                index + 1 == chunk_count,
                            )
                            .await
                            .expect("bounded raw input body");
                        }
                    });
                    tokio::select! {
                        result = &mut send_response => result.expect("raw response task"),
                        request = connection.accept() => {
                            let _ = request;
                            panic!("unexpected request while raw image input response was active");
                        }
                    }
                    tokio::select! {
                        verified = &mut verified_receiver => {
                            verified.expect("client verified complete raw response");
                        }
                        request = connection.accept() => {
                            let _ = request;
                            panic!("unexpected request before raw image input verification");
                        }
                    }
                } else {
                    let metadata = serde_json::json!({
                        "arguments": { "NODE_VERSION": "24.16.0" },
                        "argumentsDigest": format!("sha256:{}", "1".repeat(64)),
                        "contextDigest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                        "contextRef": "build-context://empty/v1",
                        "dockerfileByteLength": server_bytes.len(),
                        "dockerfileDigest": server_digest.as_str(),
                        "egress": [{ "host": "registry.npmjs.org", "port": 443 }],
                        "layerLimit": 128,
                        "outputLimitBytes": 21_474_836_480_u64,
                        "requestId": server_request_id.as_str(),
                        "timeLimitSeconds": 1800,
                    });
                    let response = Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(())
                        .expect("metadata response");
                    let mut response_body = respond
                        .send_response(response, false)
                        .expect("metadata response send");
                    send_h2_bytes(
                        &mut response_body,
                        Bytes::from(serde_json::to_vec(&metadata).expect("metadata JSON")),
                        true,
                    )
                    .await
                    .expect("metadata body");
                }
            }
        });

        let mut cursor = 5;
        let command = poll_effect_command(
            "http://sandbox-integration:80",
            &mut sender,
            &mut cursor,
            false,
        )
        .await
        .expect("verified image.build command")
        .expect("pending image.build command");
        assert_eq!(command.kind, RuntimeEffectKind::BuildImage);
        assert_eq!(command.request_id, request_id);
        assert!(
            command
                .input
                .get("dockerfile")
                .and_then(serde_json::Value::as_str)
                == Some(dockerfile.as_str()),
            "verified image.build input bytes were not attached to the command"
        );
        assert_eq!(
            command
                .input
                .get("dockerfileDigest")
                .and_then(serde_json::Value::as_str),
            Some(dockerfile_digest.as_str())
        );
        assert!(command.input.get("dockerfileByteLength").is_none());
        verified_sender
            .send(())
            .expect("signal complete client verification");
        server.await.expect("server task");
        drop(sender);
        client_driver
            .await
            .expect("client driver task")
            .expect("client driver completion");
    }

    #[tokio::test]
    async fn wp5_r8_rejects_missing_duplicate_or_invalid_image_build_input_headers() {
        for case in ["missing", "duplicate", "invalid"] {
            let (client_io, server_io) = tokio::io::duplex(4096);
            let (mut sender, connection) = h2::client::handshake(client_io)
                .await
                .expect("client handshake");
            let client_driver = tokio::spawn(connection);
            let dockerfile = b"FROM scratch\n";
            let dockerfile_digest = format!("sha256:{:x}", Sha256::digest(dockerfile));
            let request_id = "e".repeat(64);
            let server_request_id = request_id.clone();
            let server_digest = dockerfile_digest.clone();
            let server = tokio::spawn(async move {
                let mut connection = h2::server::handshake(server_io)
                    .await
                    .expect("server handshake");
                let (request, mut respond) = connection
                    .accept()
                    .await
                    .expect("request stream")
                    .expect("accepted request");
                assert_eq!(
                    request.uri().path(),
                    "/api/nanohost/transport/effects/image.build/input"
                );
                let mut body = request.into_body();
                let mut request_bytes = BytesMut::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("request body");
                    body.flow_control()
                        .release_capacity(chunk.len())
                        .expect("request flow control");
                    request_bytes.extend_from_slice(&chunk);
                }
                assert_eq!(request_bytes.as_ref(), b"{}");

                let mut response = Response::builder()
                    .status(StatusCode::OK)
                    .header(
                        "content-type",
                        if case == "invalid" {
                            "text/plain"
                        } else {
                            FILE_CONTENT_TYPE
                        },
                    )
                    .header("content-length", dockerfile.len().to_string())
                    .header(REQUEST_ID_HEADER, server_request_id.as_str())
                    .header(BYTE_LENGTH_HEADER, dockerfile.len().to_string());
                if case != "missing" {
                    response = response.header(SHA256_HEADER, server_digest.as_str());
                }
                if case == "duplicate" {
                    response = response.header(REQUEST_ID_HEADER, server_request_id.as_str());
                }
                respond
                    .send_response(response.body(()).expect("invalid raw input response"), true)
                    .expect("invalid raw input response send");
            });

            assert!(
                fetch_image_build_input(
                    "http://sandbox-integration:80",
                    &mut sender,
                    &request_id,
                    &dockerfile_digest,
                    dockerfile.len() as u64,
                )
                .await
                .is_err(),
                "{case} required header was accepted"
            );
            server.await.expect("server task");
            client_driver.abort();
        }
    }

    #[tokio::test]
    async fn wp5_r7_submits_one_exact_typed_failure_then_continues_polling() {
        let (client_io, server_io) = tokio::io::duplex(4096);
        let (mut sender, connection) = h2::client::handshake(client_io)
            .await
            .expect("client handshake");
        let client_driver = tokio::spawn(connection);
        let request_id = "a".repeat(64);
        let expected_request_id = request_id.clone();
        let (release_server, hold_server) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(server_io)
                .await
                .expect("server handshake");
            for (index, expected_path) in [
                "/api/nanohost/transport/effects/image.acquire/result",
                "/api/nanohost/transport/effects/image.acquire",
            ]
            .into_iter()
            .enumerate()
            {
                let (request, mut respond) = connection
                    .accept()
                    .await
                    .expect("request stream")
                    .expect("accepted request");
                assert_eq!(request.uri().path(), expected_path);
                let mut body = request.into_body();
                let mut bytes = BytesMut::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("request body");
                    body.flow_control()
                        .release_capacity(chunk.len())
                        .expect("request flow control");
                    bytes.extend_from_slice(&chunk);
                }
                if index == 0 {
                    let value: serde_json::Value =
                        serde_json::from_slice(&bytes).expect("typed failure JSON");
                    let object = value.as_object().expect("typed failure object");
                    assert_eq!(object.len(), 2);
                    assert_eq!(
                        object.get("requestId").and_then(serde_json::Value::as_str),
                        Some(expected_request_id.as_str())
                    );
                    assert_eq!(
                        object
                            .get("failureCode")
                            .and_then(serde_json::Value::as_str),
                        Some("effect_failed")
                    );
                } else {
                    assert_eq!(bytes.as_ref(), b"{}");
                }
                respond
                    .send_response(
                        Response::builder()
                            .status(StatusCode::NO_CONTENT)
                            .body(())
                            .expect("empty response"),
                        true,
                    )
                    .expect("response send");
            }
            tokio::select! {
                _ = hold_server => {}
                request = connection.accept() => {
                    let _ = request;
                    panic!("unexpected third request");
                }
            }
        });
        let command = PolledEffectCommand {
            kind: RuntimeEffectKind::AcquireImage,
            request_id,
            input: serde_json::json!({ "imageReference": "openkit/worker:test" }),
            file_data: None,
        };

        submit_effect_result(
            "http://sandbox-integration:80",
            &mut sender,
            &command,
            serde_json::json!({ "failureCode": "effect_failed" }),
        )
        .await
        .expect("empty 204 typed-failure acknowledgement");
        let mut cursor = 4;
        assert!(
            poll_effect_command(
                "http://sandbox-integration:80",
                &mut sender,
                &mut cursor,
                false,
            )
            .await
            .expect("next poll after definite failure")
            .is_none()
        );
        let _ = release_server.send(());
        server.await.expect("server task");
        client_driver.abort();

        let source = include_str!("nanocore_session.rs")
            .split_once("#[cfg(test)]")
            .expect("NanoCore session production section")
            .0;
        assert!(source.contains("pub enum OuterSessionDisposition"));
        assert!(source.contains("pub enum OuterSessionStage"));
        assert!(source.contains("impl std::fmt::Display for OuterSessionFailure"));
        for disposition in ["Reconnect", "Terminal"] {
            assert!(
                source.contains(disposition),
                "missing {disposition} disposition"
            );
        }
        for stage in [
            "Connect",
            "Admission",
            "Readiness",
            "Poll",
            "Execute",
            "Result",
        ] {
            assert!(source.contains(stage), "missing {stage} stage");
        }
        for operation in [
            "sandbox.create",
            "sandbox.delete",
            "bridge.open",
            "bridge.close",
            "image.acquire",
            "image.build",
            "file.export",
            "reference.import",
        ] {
            assert!(source.contains(operation), "missing {operation} operation");
        }
        assert!(source.contains("100..=599"));
        assert!(source.contains(
            "nanohost outer session failure: disposition={} stage={} operation={} status={}"
        ));
        let display = source
            .split_once("impl std::fmt::Display for OuterSessionFailure")
            .expect("closed outer-session display")
            .1
            .split_once("pub async fn run_outer_session")
            .expect("end of failure display")
            .0;
        for forbidden in [
            "generation",
            "request_id",
            "lease",
            "sandbox",
            "image_reference",
            "endpoint",
            "header",
            "body",
            "credential",
        ] {
            assert!(!display.contains(forbidden), "display leaks {forbidden}");
        }
    }

    #[derive(Clone, Copy)]
    enum TestEffectResponse {
        NoContent,
        PhysicalClose,
    }

    fn scripted_outer_server(
        generation: u64,
        effects: Vec<(&'static str, TestEffectResponse)>,
    ) -> (tokio::io::DuplexStream, tokio::task::JoinHandle<()>) {
        let (client_io, server_io) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(server_io)
                .await
                .expect("server handshake");
            for expected_path in [
                "/api/nanohost/transport/session/admit",
                "/api/nanohost/transport/session/readiness",
            ] {
                let (request, mut respond) = connection
                    .accept()
                    .await
                    .expect("request stream")
                    .expect("accepted request");
                assert_eq!(request.uri().path(), expected_path);
                let mut body = request.into_body();
                let mut request_bytes = BytesMut::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("request body");
                    body.flow_control()
                        .release_capacity(chunk.len())
                        .expect("request flow control");
                    request_bytes.extend_from_slice(&chunk);
                }
                assert_eq!(request_bytes.as_ref(), b"{}");

                match expected_path {
                    "/api/nanohost/transport/session/admit" => {
                        let response = serde_json::json!({
                            "connectionGeneration": generation,
                            "deploymentId": "deployment-a",
                            "identityId": "nanohost-a",
                            "mayCarryWork": true,
                            "role": "authoritative",
                        });
                        let mut response_body = respond
                            .send_response(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .body(())
                                    .expect("admission response"),
                                false,
                            )
                            .expect("admission response send");
                        response_body
                            .send_data(
                                Bytes::from(serde_json::to_vec(&response).expect("admission JSON")),
                                true,
                            )
                            .expect("admission response body");
                    }
                    "/api/nanohost/transport/session/readiness" => {
                        respond
                            .send_response(
                                Response::builder()
                                    .status(StatusCode::NO_CONTENT)
                                    .body(())
                                    .expect("readiness response"),
                                true,
                            )
                            .expect("readiness response send");
                    }
                    _ => unreachable!("closed request list"),
                }
            }

            for (expected_path, response) in effects {
                let (request, mut respond) = connection
                    .accept()
                    .await
                    .expect("effect request stream")
                    .expect("accepted effect request");
                assert_eq!(request.uri().path(), expected_path);
                let mut body = request.into_body();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("effect request body");
                    body.flow_control()
                        .release_capacity(chunk.len())
                        .expect("effect request flow control");
                }
                match response {
                    TestEffectResponse::NoContent => {
                        respond
                            .send_response(
                                Response::builder()
                                    .status(StatusCode::NO_CONTENT)
                                    .body(())
                                    .expect("empty effect response"),
                                true,
                            )
                            .expect("empty effect response send");
                    }
                    TestEffectResponse::PhysicalClose => return,
                }
            }
            assert!(
                connection
                    .accept()
                    .await
                    .transpose()
                    .expect("post-script connection")
                    .is_none()
            );
        });
        (client_io, server)
    }

    fn test_outer_credentials() -> (CredentialSelectionContext, CredentialPresentationOutcome) {
        let context = CredentialSelectionContext {
            identity_id: "nanohost-a".to_string(),
            deployment_id: "deployment-a".to_string(),
        };
        let presentation = CredentialPresentationOutcome::Presented {
            slot: CredentialSlot::A,
            token_id: "token-a".to_string(),
            secret: "okt_test_only".to_string(),
        };
        (context, presentation)
    }

    async fn first_poll_physical_close_after_readiness(
        reconnect_after: Option<u64>,
    ) -> OuterSessionFailure {
        let generation = reconnect_after.map_or(1, |predecessor| predecessor + 1);
        let (client_io, server) = scripted_outer_server(
            generation,
            vec![(
                "/api/nanohost/transport/effects/sandbox.create",
                TestEffectResponse::PhysicalClose,
            )],
        );
        let (context, presentation) = test_outer_credentials();
        let failure = run_outer_session(
            client_io,
            "http://nanocore.test",
            &context,
            &presentation,
            reconnect_after,
            |_, mut sender| async move {
                let mut cursor = effect_cursor_start(false);
                poll_effect_command("http://nanocore.test", &mut sender, &mut cursor, false)
                    .await
                    .map(|_| ())
            },
        )
        .await
        .expect_err("physical close during first poll response must fail the outer session");
        server.await.expect("server task");
        failure
    }

    #[tokio::test]
    async fn nhc_imp_5c_successor_first_poll_physical_close_is_terminal() {
        let initial = first_poll_physical_close_after_readiness(None).await;
        assert_eq!(
            initial.disposition(),
            OuterSessionDisposition::Reconnect,
            "an initial-session first-poll physical close remains eligible for ordinary reconnect"
        );

        for predecessor in 7..15 {
            let successor = first_poll_physical_close_after_readiness(Some(predecessor)).await;
            assert_eq!(
                successor.disposition(),
                OuterSessionDisposition::Terminal,
                "physical connection loss after an authoritative successor starts its first poll must not enter the reconnect loop"
            );
        }
    }

    #[tokio::test]
    async fn nhc_imp_5c_retained_result_and_post_first_poll_close_remain_reconnectable() {
        let (context, presentation) = test_outer_credentials();
        let command = PolledEffectCommand {
            kind: RuntimeEffectKind::CreateSandbox,
            request_id: "a".repeat(64),
            input: serde_json::json!({}),
            file_data: None,
        };
        let (client_io, server) = scripted_outer_server(
            8,
            vec![
                (
                    "/api/nanohost/transport/effects/sandbox.create/result",
                    TestEffectResponse::NoContent,
                ),
                (
                    "/api/nanohost/transport/effects/sandbox.create",
                    TestEffectResponse::PhysicalClose,
                ),
            ],
        );
        let post_retained_result_poll_loss = run_outer_session(
            client_io,
            "http://nanocore.test",
            &context,
            &presentation,
            Some(7),
            |_, mut sender| async move {
                let mut cursor = effect_cursor_start(true);
                submit_effect_result(
                    "http://nanocore.test",
                    &mut sender,
                    &command,
                    serde_json::json!({ "sandboxId": "sandbox-a" }),
                )
                .await?;
                poll_effect_command("http://nanocore.test", &mut sender, &mut cursor, false)
                    .await
                    .map(|_| ())
            },
        )
        .await
        .expect_err("post-retained-result poll response loss must fail the physical session");
        server.await.expect("retained-result server task");
        assert_eq!(
            post_retained_result_poll_loss.disposition(),
            OuterSessionDisposition::Reconnect,
            "a delivered eligible retained result must prevent the following poll from activating the result-absence terminal window"
        );

        let (client_io, server) = scripted_outer_server(
            8,
            vec![
                (
                    "/api/nanohost/transport/effects/sandbox.create",
                    TestEffectResponse::NoContent,
                ),
                (
                    "/api/nanohost/transport/effects/sandbox.delete",
                    TestEffectResponse::PhysicalClose,
                ),
            ],
        );
        let later_poll_loss = run_outer_session(
            client_io,
            "http://nanocore.test",
            &context,
            &presentation,
            Some(7),
            |_, mut sender| async move {
                let mut cursor = effect_cursor_start(false);
                assert!(
                    poll_effect_command("http://nanocore.test", &mut sender, &mut cursor, false)
                        .await?
                        .is_none()
                );
                poll_effect_command("http://nanocore.test", &mut sender, &mut cursor, false)
                    .await
                    .map(|_| ())
            },
        )
        .await
        .expect_err("later poll response loss must fail the physical session");
        server.await.expect("later-poll server task");
        assert_eq!(
            later_poll_loss.disposition(),
            OuterSessionDisposition::Reconnect,
            "a complete first poll closes the successor-only terminal response window"
        );
    }

    #[tokio::test]
    async fn nhc_fnd_059_live_bridge_poll_close_remains_reconnectable() {
        let (client_io, server) = scripted_outer_server(
            1,
            vec![(
                "/api/nanohost/transport/effects/bridge.open",
                TestEffectResponse::PhysicalClose,
            )],
        );
        let (context, presentation) = test_outer_credentials();
        let failure = run_outer_session(
            client_io,
            "http://nanocore.test",
            &context,
            &presentation,
            None,
            |_, mut sender| async move {
                let mut cursor = 2;
                poll_effect_command("http://nanocore.test", &mut sender, &mut cursor, true)
                    .await
                    .map(|_| ())
            },
        )
        .await
        .expect_err("live bridge poll response loss must fail only the physical session");
        server.await.expect("live bridge server task");
        assert_eq!(failure.disposition(), OuterSessionDisposition::Reconnect);
        assert_ne!(failure.reason(), "bridge.open command delivery unknown");
    }

    #[test]
    fn nhc_imp_5c_cursor_start_has_exact_retained_result_polarity() {
        assert_eq!(effect_cursor_start(false), 0);
        assert_eq!(effect_cursor_start(true), EFFECT_OPERATION_COUNT);
        assert!(
            include_str!("main.rs").contains("effect_cursor_start(pending_result.is_some())"),
            "the outer loop must derive the effect cursor start directly from retained-result presence"
        );
    }

    #[tokio::test]
    async fn nhc_imp_5c_effect_poll_cursor_completes_and_wraps_one_fair_cycle() {
        let (client_io, server_io) = tokio::io::duplex(4096);
        let (mut sender, connection) = h2::client::handshake(client_io)
            .await
            .expect("client handshake");
        let client_driver = tokio::spawn(connection);
        let (release_server, mut hold_server) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(server_io)
                .await
                .expect("server handshake");
            let mut observed = Vec::new();
            for _ in 0..EFFECT_PATHS.len() {
                let (request, mut respond) = connection
                    .accept()
                    .await
                    .expect("poll request stream")
                    .expect("accepted poll request");
                observed.push(request.uri().path().to_string());
                let mut body = request.into_body();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("poll request body");
                    body.flow_control()
                        .release_capacity(chunk.len())
                        .expect("poll request flow control");
                }
                respond
                    .send_response(
                        Response::builder()
                            .status(StatusCode::NO_CONTENT)
                            .body(())
                            .expect("empty poll response"),
                        true,
                    )
                    .expect("empty poll response send");
            }
            tokio::select! {
                _ = &mut hold_server => {}
                request = connection.accept() => {
                    assert!(request.transpose().expect("post-cycle connection").is_none());
                }
            }
            observed
        });
        let mut cursor = usize::MAX - 3;
        for _ in 0..EFFECT_PATHS.len() {
            assert!(
                poll_effect_command("http://nanocore.test", &mut sender, &mut cursor, false)
                    .await
                    .expect("bounded fair poll")
                    .is_none()
            );
        }
        let _ = release_server.send(());
        let observed = server.await.expect("fair-cycle server task");
        assert_eq!(
            observed,
            vec![
                "/api/nanohost/transport/effects/image.acquire",
                "/api/nanohost/transport/effects/image.build",
                "/api/nanohost/transport/effects/file.export",
                "/api/nanohost/transport/effects/reference.import",
                "/api/nanohost/transport/effects/sandbox.create",
                "/api/nanohost/transport/effects/sandbox.delete",
                "/api/nanohost/transport/effects/bridge.open",
                "/api/nanohost/transport/effects/bridge.close",
            ],
            "the cursor boundary must wrap through one complete fair operation cycle instead of saturating on reference.import"
        );
        drop(sender);
        client_driver.abort();
    }

    #[test]
    fn requires_server_authenticated_tls_for_non_loopback_rendezvous() {
        assert_eq!(
            classify_rendezvous_transport("https://nanocore.example:8443"),
            TransportSecurityDecision::RequireServerAuthenticatedTls,
            "non-loopback rendezvous must require server-authenticated TLS"
        );
        assert_eq!(
            classify_rendezvous_transport("http://192.168.10.2:3000"),
            TransportSecurityDecision::RequireServerAuthenticatedTls,
            "private non-loopback addresses still require TLS"
        );
        assert_eq!(
            classify_rendezvous_transport("http://127.0.0.1:3000"),
            TransportSecurityDecision::AllowPlaintextLoopback,
            "exact same-host loopback may use plaintext"
        );
        assert_eq!(
            classify_rendezvous_transport("http://localhost:3000"),
            TransportSecurityDecision::AllowPlaintextLoopback,
            "localhost loopback may use plaintext"
        );
    }

    #[test]
    fn missing_or_untrusted_tls_material_prevents_authoritative_session() {
        assert!(
            !tls_trust_permits_authoritative_session(&TlsTrustMaterial::Missing),
            "missing TLS trust material must prevent an authoritative session"
        );
        assert!(
            !tls_trust_permits_authoritative_session(&TlsTrustMaterial::Untrusted),
            "untrusted TLS material must prevent an authoritative session"
        );
        assert!(
            tls_trust_permits_authoritative_session(&TlsTrustMaterial::Platform),
            "platform trust remains admissible when rendezvous requires TLS"
        );
    }

    #[test]
    fn presents_only_selected_credential_slot_material() {
        let selected = SelectedCredential::Usable {
            slot: CredentialSlot::B,
            token_id: "tok_b".to_string(),
            issuance_generation: 2,
            secret: "okt_selected_only_material_aaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        };
        let presented = present_selected_credential(&selected);
        assert_eq!(
            presented,
            CredentialPresentationOutcome::Presented {
                slot: CredentialSlot::B,
                token_id: "tok_b".to_string(),
                secret: "okt_selected_only_material_aaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            },
            "presentation must consume only the S-2b-2 selected usable slot"
        );
        assert_eq!(
            present_selected_credential(&SelectedCredential::Empty),
            CredentialPresentationOutcome::NonReady,
            "empty selection keeps the NanoHost non-ready"
        );
    }

    #[test]
    fn does_not_fall_back_to_second_slot_after_authentication_rejection() {
        let presented = CredentialPresentationOutcome::Presented {
            slot: CredentialSlot::A,
            token_id: "tok_a".to_string(),
            secret: "okt_presented_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        };
        let other = SelectedCredential::Usable {
            slot: CredentialSlot::B,
            token_id: "tok_b".to_string(),
            issuance_generation: 1,
            secret: "okt_other_slot_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        };

        let outcome = after_authentication_rejection(&presented, Some(&other));
        assert_eq!(
            outcome,
            CredentialPresentationOutcome::AuthRejected,
            "authentication rejection must not present the other slot"
        );
        match outcome {
            CredentialPresentationOutcome::Presented { slot, .. } => {
                panic!("must not present fallback slot {slot:?}");
            }
            CredentialPresentationOutcome::AuthRejected
            | CredentialPresentationOutcome::NonReady => {}
        }
    }

    #[test]
    fn rejects_non_tls_non_loopback_before_credential_presentation() {
        let rejected = prepare_verified_session_transport(
            "http://nanocore.example:8443",
            &TlsTrustMaterial::Platform,
        );
        assert!(
            matches!(
                rejected,
                Err(VerifiedTransportReject::PlaintextNonLoopbackForbidden)
            ),
            "non-loopback plaintext must fail closed before presentation"
        );
    }

    #[test]
    fn rejects_untrusted_tls_material_before_credential_presentation() {
        let rejected = prepare_verified_session_transport(
            "https://nanocore.example:8443",
            &TlsTrustMaterial::Untrusted,
        );
        assert!(
            matches!(rejected, Err(VerifiedTransportReject::UntrustedTlsMaterial)),
            "untrusted TLS material must fail closed before presentation"
        );
        let missing = prepare_verified_session_transport(
            "https://nanocore.example:8443",
            &TlsTrustMaterial::Missing,
        );
        assert!(
            matches!(missing, Err(VerifiedTransportReject::UntrustedTlsMaterial)),
            "missing TLS material must fail closed before presentation"
        );
    }

    #[test]
    fn builds_minimum_verified_tls_client_for_non_loopback_https() {
        let transport = prepare_verified_session_transport(
            "https://nanocore.example:8443",
            &TlsTrustMaterial::Platform,
        )
        .expect("platform trust over non-loopback HTTPS must build a verified TLS client");
        assert!(
            transport.requires_server_authenticated_tls(),
            "non-loopback HTTPS must present credentials only over verified TLS"
        );
        assert!(
            transport.tls_client_config().is_some(),
            "minimum verified TLS client surface must expose a rustls ClientConfig"
        );
    }

    #[tokio::test]
    async fn pending_tls_handshake_does_not_report_eof() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let socket = TcpStream::connect(listener.local_addr().expect("test listener address"))
            .await
            .expect("test client socket");
        let (_server_socket, _) = listener.accept().await.expect("test server socket");
        let config = build_verified_tls_client_config(&TlsTrustMaterial::Platform)
            .expect("test TLS client config");
        let connection = ClientConnection::new(
            config,
            ServerName::try_from("nanocore.example").expect("test server name"),
        )
        .expect("test TLS client connection");
        let mut stream = AsyncRustlsClientStream {
            socket,
            connection,
            pending_tls: Vec::new(),
            pending_tls_offset: 0,
        };
        let mut byte = [0_u8; 1];

        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                tokio::io::AsyncReadExt::read(&mut stream, &mut byte),
            )
            .await
            .is_err(),
            "an open TLS socket without plaintext must remain pending instead of reporting an error or EOF"
        );
    }

    struct BackpressuredReadableIo {
        read_polled: bool,
        write_polled: bool,
        readable: Option<[u8; 5]>,
    }

    impl AsyncRead for BackpressuredReadableIo {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.read_polled = true;
            if let Some(bytes) = self.readable.take() {
                buffer.put_slice(&bytes);
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        }
    }

    impl AsyncWrite for BackpressuredReadableIo {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buffer: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.write_polled = true;
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn readable_tls_socket_is_polled_while_write_is_pending() {
        let config = build_verified_tls_client_config(&TlsTrustMaterial::Platform)
            .expect("test TLS client config");
        let connection = ClientConnection::new(
            config,
            ServerName::try_from("nanocore.example").expect("test server name"),
        )
        .expect("test TLS client connection");
        assert!(
            connection.wants_write(),
            "test TLS client must queue its ClientHello"
        );
        let mut stream = AsyncRustlsClientStream {
            socket: BackpressuredReadableIo {
                read_polled: false,
                write_polled: false,
                readable: Some([0xff, 0x03, 0x03, 0x00, 0x00]),
            },
            connection,
            pending_tls: Vec::new(),
            pending_tls_offset: 0,
        };
        let mut context = Context::from_waker(std::task::Waker::noop());
        let mut byte = [0_u8; 1];
        let mut buffer = ReadBuf::new(&mut byte);
        let read = Pin::new(&mut stream).poll_read(&mut context, &mut buffer);

        assert!(
            stream.socket.write_polled,
            "TLS write backpressure was not exercised"
        );
        assert!(
            stream.socket.read_polled,
            "readable peer was not polled after write backpressure"
        );
        assert!(
            matches!(read, Poll::Ready(Err(_))),
            "the invalid readable TLS record must fail closed"
        );
    }

    #[test]
    fn configured_trust_reference_is_consumed_and_fails_closed_when_unusable() {
        let missing = std::env::temp_dir().join(format!(
            "openkit-missing-nanocore-ca-{}",
            std::process::id()
        ));
        let invalid = std::env::temp_dir().join(format!(
            "openkit-invalid-nanocore-ca-{}",
            std::process::id()
        ));
        std::fs::write(&invalid, b"not a CA certificate or certificate pin")
            .expect("invalid trust fixture must be writable");

        let missing_result = prepare_verified_session_transport(
            "https://nanocore.example:8443",
            &TlsTrustMaterial::ConfiguredRef {
                reference: missing.display().to_string(),
            },
        );
        let invalid_result = prepare_verified_session_transport(
            "https://nanocore.example:8443",
            &TlsTrustMaterial::ConfiguredRef {
                reference: invalid.display().to_string(),
            },
        );
        std::fs::remove_file(&invalid).expect("invalid trust fixture must be removable");

        assert!(
            missing_result.is_err(),
            "a missing configured trust reference must not substitute platform roots"
        );
        assert!(
            invalid_result.is_err(),
            "invalid configured trust must fail closed instead of substituting platform roots"
        );
    }

    #[test]
    fn wp5_outer_session_fences_predecessor_generation_replay_bounds_and_cancellation() {
        let mut predecessor = OuterSessionState::new("nanohost-a", 7, None);
        let first = OuterSessionEnvelope::new("nanohost-a", 7, "request-1", "readiness.report", 64);
        assert_eq!(predecessor.accept(&first), Ok(()));
        assert!(
            predecessor.accept(&first).is_err(),
            "request replay must fail closed"
        );
        assert!(
            predecessor
                .accept(&OuterSessionEnvelope::new(
                    "nanohost-other",
                    7,
                    "request-2",
                    "readiness.report",
                    64,
                ))
                .is_err()
        );
        assert!(
            predecessor
                .accept(&OuterSessionEnvelope::new(
                    "nanohost-a",
                    8,
                    "request-3",
                    "readiness.report",
                    64,
                ))
                .is_err()
        );
        assert!(
            predecessor
                .accept(&OuterSessionEnvelope::new(
                    "nanohost-a",
                    7,
                    "request-4",
                    "readiness.report",
                    NANOHOST_CONTROL_IN_FLIGHT_BYTES + 1,
                ))
                .is_err()
        );

        let mut successor = OuterSessionState::new("nanohost-a", 8, Some(7));
        let successor_request =
            OuterSessionEnvelope::new("nanohost-a", 8, "request-5", "effect.execute", 64);
        assert!(successor.accept(&successor_request).is_err());
        assert!(successor.close_predecessor(6).is_err());
        assert_eq!(successor.close_predecessor(7), Ok(()));
        assert_eq!(successor.accept(&successor_request), Ok(()));
        successor.cancel();
        assert!(
            successor
                .accept(&OuterSessionEnvelope::new(
                    "nanohost-a",
                    8,
                    "request-6",
                    "effect.execute",
                    64,
                ))
                .is_err()
        );
    }
}
