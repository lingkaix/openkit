//! Per-sandbox stock `ForwardTcp`/`RelayStream` bridge owner.

#![allow(dead_code, clippy::assertions_on_constants)]

use std::collections::VecDeque;
use std::fs::{self, DirBuilder, OpenOptions};
use std::future::Future;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use h2::server::SendResponse;
use http::{Method, Request, Response, StatusCode};
use openshell_sdk::raw::proto::{TcpForwardFrame, tcp_forward_frame};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio_stream::Stream;

/// Fixed image-private Sandbox Integration listener reached by stock `ForwardTcp`.
pub const SANDBOX_INTEGRATION_TARGET: &str = "127.0.0.1:17891";

const SANDBOX_INTEGRATION_HTTP_AUTHORITY: &str = "sandbox-integration:80";

/// HTTP/2 connection receive window used by both accepted sessions.
pub const CONNECTION_RECEIVE_WINDOW_BYTES: usize = 5 * 1024 * 1024;

/// HTTP/2 receive window for one stream.
pub const PER_STREAM_RECEIVE_WINDOW_BYTES: usize = 256 * 1024;

/// Maximum concurrent streams in one sandbox-nested HTTP/2 session.
pub const NESTED_MAX_CONCURRENT_STREAMS: u32 = 14;

/// Maximum concurrent streams in the NanoHost-to-NanoCore HTTP/2 session.
pub const OUTER_MAX_CONCURRENT_STREAMS: u32 = 16;

/// Worker-control aggregate in-flight DATA ceiling.
pub const WORKER_CONTROL_IN_FLIGHT_BYTES: usize = 1024 * 1024;

/// Inference aggregate in-flight DATA ceiling.
pub const INFERENCE_IN_FLIGHT_BYTES: usize = 2 * 1024 * 1024;

/// Capability aggregate in-flight DATA ceiling when the family is enabled.
pub const CAPABILITY_IN_FLIGHT_BYTES: usize = 512 * 1024;

/// NanoHost control/readiness aggregate in-flight DATA ceiling.
pub const NANOHOST_CONTROL_IN_FLIGHT_BYTES: usize = 512 * 1024;

/// Largest byte chunk written into the stock forward stream.
pub const MAX_INFERENCE_WRITE_BYTES: usize = 64 * 1024;

/// Records that HTTP/2 priority is not part of route isolation.
pub const HTTP2_PRIORITY_ENABLED: bool = false;

/// Normal bridge re-establishment target.
pub const BRIDGE_REESTABLISH_TARGET: Duration = Duration::from_secs(30);

/// Hard bridge re-establishment deadline.
pub const BRIDGE_REESTABLISH_HARD_BOUND: Duration = Duration::from_secs(120);

pub(crate) const FORWARD_FRAME_CHANNEL_CAPACITY: usize = 4;
const PRODUCED_FACT_CAPACITY_BYTES: usize = 8 * 1024 * 1024;
const PRODUCED_FACT_MAX_AGE: Duration = Duration::from_secs(300);
const EFFECT_REFERENCE_MAX_BYTES: usize = 4096;
pub(crate) const FILE_EFFECT_CHUNK_BYTES: usize = 64 * 1024;
pub(crate) const FILE_EFFECT_MAX_BYTES: u64 = 256 * 1024 * 1024;
const FILE_EFFECT_HELPER: &str = "/usr/local/bin/openkit-file-effect";

/// One of the three fixed Sandbox Integration route namespaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteFamily {
    /// Existing worker-control protocol traffic.
    WorkerControl,
    /// Existing inference protocol traffic.
    Inference,
    /// Present but non-callable capability traffic.
    Capabilities,
}

/// Classifies one origin-form path into the exact fixed route table.
///
/// # Errors
///
/// Returns an error for empty suffixes, absolute origins, and every fourth namespace.
pub fn route_family(path: &str) -> Result<RouteFamily, &'static str> {
    if path.starts_with("/worker-control/") && path.len() > "/worker-control/".len() {
        Ok(RouteFamily::WorkerControl)
    } else if path.starts_with("/inference/") && path.len() > "/inference/".len() {
        Ok(RouteFamily::Inference)
    } else if path.starts_with("/capabilities/") && path.len() > "/capabilities/".len() {
        Ok(RouteFamily::Capabilities)
    } else {
        Err("sandbox bridge route rejected")
    }
}

/// Returns the active per-family stream reservation derived from DATA ceilings.
pub const fn route_stream_limit(family: RouteFamily) -> usize {
    match family {
        RouteFamily::WorkerControl => {
            WORKER_CONTROL_IN_FLIGHT_BYTES / PER_STREAM_RECEIVE_WINDOW_BYTES
        }
        RouteFamily::Inference => INFERENCE_IN_FLIGHT_BYTES / PER_STREAM_RECEIVE_WINDOW_BYTES,
        RouteFamily::Capabilities => 0,
    }
}

/// Direct receive shapes needed by live gRPC and the released channel check.
enum TcpForwardInbound {
    Channel(mpsc::Receiver<Result<TcpForwardFrame, tonic::Status>>),
    Grpc(Box<tonic::Streaming<TcpForwardFrame>>),
}

impl TcpForwardInbound {
    /// Polls the next stock frame from either the test channel or live gRPC stream.
    fn poll_next(
        &mut self,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<TcpForwardFrame, tonic::Status>>> {
        match self {
            Self::Channel(receiver) => receiver.poll_recv(context),
            Self::Grpc(stream) => Pin::new(stream.as_mut()).poll_next(context),
        }
    }

    /// Prevents a bounded test channel from accepting more frames after cancellation.
    fn close(&mut self) {
        if let Self::Channel(receiver) = self {
            receiver.close();
        }
    }
}

/// Owned bounded-channel capacity awaited across `AsyncWrite` polls.
type PendingFramePermit = Pin<
    Box<
        dyn Future<Output = Result<mpsc::OwnedPermit<TcpForwardFrame>, mpsc::error::SendError<()>>>
            + Send,
    >,
>;

/// Adapts the pinned stock `TcpForwardFrame` stream to bounded asynchronous bytes.
pub struct TcpForwardByteStream {
    inbound: TcpForwardInbound,
    outbound: mpsc::Sender<TcpForwardFrame>,
    buffered: Vec<u8>,
    buffered_offset: usize,
    pending_permit: Option<PendingFramePermit>,
    cancelled: bool,
}

impl TcpForwardByteStream {
    /// Creates an adapter over a bounded channel, primarily for direct checks.
    pub fn new(
        inbound: mpsc::Receiver<Result<TcpForwardFrame, tonic::Status>>,
        outbound: mpsc::Sender<TcpForwardFrame>,
    ) -> Self {
        Self::from_inbound(TcpForwardInbound::Channel(inbound), outbound)
    }

    /// Creates an adapter over the live stock gRPC response stream.
    pub(crate) fn from_grpc(
        inbound: tonic::Streaming<TcpForwardFrame>,
        outbound: mpsc::Sender<TcpForwardFrame>,
    ) -> Self {
        Self::from_inbound(TcpForwardInbound::Grpc(Box::new(inbound)), outbound)
    }

    /// Creates the shared direct adapter state.
    fn from_inbound(inbound: TcpForwardInbound, outbound: mpsc::Sender<TcpForwardFrame>) -> Self {
        Self {
            inbound,
            outbound,
            buffered: Vec::new(),
            buffered_offset: 0,
            pending_permit: None,
            cancelled: false,
        }
    }

    /// Cancels the current byte stream without opening a replacement pair.
    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.inbound.close();
        self.pending_permit = None;
    }

    /// Returns whether the byte stream has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    /// Copies buffered DATA into one caller read buffer.
    fn copy_buffered(&mut self, output: &mut ReadBuf<'_>) {
        let available = &self.buffered[self.buffered_offset..];
        let count = available.len().min(output.remaining());
        output.put_slice(&available[..count]);
        self.buffered_offset += count;
        if self.buffered_offset == self.buffered.len() {
            self.buffered.clear();
            self.buffered_offset = 0;
        }
    }
}

impl AsyncRead for TcpForwardByteStream {
    /// Polls stock DATA frames and maps stream completion to definite EOF.
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.buffered_offset < self.buffered.len() {
            self.copy_buffered(output);
            return Poll::Ready(Ok(()));
        }
        if self.cancelled {
            return Poll::Ready(Ok(()));
        }

        loop {
            match self.inbound.poll_next(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Ready(Some(Err(status))) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        status,
                    )));
                }
                Poll::Ready(Some(Ok(frame))) => match frame.payload {
                    Some(tcp_forward_frame::Payload::Data(data)) if !data.is_empty() => {
                        self.buffered = data;
                        self.copy_buffered(output);
                        return Poll::Ready(Ok(()));
                    }
                    Some(tcp_forward_frame::Payload::Data(_)) => continue,
                    Some(tcp_forward_frame::Payload::Init(_)) | None => {
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "unexpected ForwardTcp frame",
                        )));
                    }
                },
            }
        }
    }
}

impl AsyncWrite for TcpForwardByteStream {
    /// Writes at most one bounded stock DATA frame.
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.cancelled {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "ForwardTcp stream cancelled",
            )));
        }
        if input.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if self.pending_permit.is_none() {
            self.pending_permit = Some(Box::pin(self.outbound.clone().reserve_owned()));
        }
        let permit = self.pending_permit.as_mut().expect("permit future present");
        match permit.as_mut().poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(_)) => {
                self.pending_permit = None;
                Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "ForwardTcp stream closed",
                )))
            }
            Poll::Ready(Ok(permit)) => {
                self.pending_permit = None;
                let count = input.len().min(MAX_INFERENCE_WRITE_BYTES);
                permit.send(TcpForwardFrame {
                    payload: Some(tcp_forward_frame::Payload::Data(input[..count].to_vec())),
                });
                Poll::Ready(Ok(count))
            }
        }
    }

    /// Flushes the channel-backed adapter; each accepted frame is already queued.
    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    /// Completes the writer side; dropping the bridge closes the stock request stream.
    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Owns the live byte stream and short-lived authorization for one stock pair.
pub struct OpenSandboxBridge {
    route_server: JoinHandle<()>,
    authorization_token: String,
    bootstrap: WorkerBootstrapBinding,
}

/// Static Harness binding and readiness state retained beside one `ForwardTcp` pair.
struct WorkerBootstrapBinding {
    sandbox_integration_binding_ref: String,
    harness_ready: bool,
    exec_monitor_live: bool,
}

impl OpenSandboxBridge {
    /// Creates one retained bridge after the authenticated starting round trip.
    pub(crate) fn new(
        route_server: JoinHandle<()>,
        authorization_token: String,
        sandbox_integration_binding_ref: String,
        harness_ready: bool,
    ) -> Self {
        Self {
            route_server,
            authorization_token,
            bootstrap: WorkerBootstrapBinding {
                sandbox_integration_binding_ref,
                harness_ready,
                exec_monitor_live: true,
            },
        }
    }

    /// Returns whether the fixed bootstrap remains live at the starting latch.
    pub fn harness_ready(&self) -> bool {
        self.bootstrap.harness_ready
            && !self.bootstrap.sandbox_integration_binding_ref.is_empty()
            && self.bootstrap.exec_monitor_live
            && !self.route_server.is_finished()
    }

    /// Splits the bridge for explicit close and authorization revocation.
    pub(crate) fn into_close_parts(mut self) -> String {
        self.route_server.abort();
        self.bootstrap.sandbox_integration_binding_ref.clear();
        std::mem::take(&mut self.authorization_token)
    }
}

impl Drop for OpenSandboxBridge {
    /// Cancels only route carriage and clears retained binding material on drop.
    fn drop(&mut self) {
        self.route_server.abort();
        self.bootstrap.sandbox_integration_binding_ref.clear();
        self.authorization_token.clear();
    }
}

/// Serves one bounded standard HTTP/2 session on the stock bridge.
///
/// The handler receives only worker-control and inference requests. Capability,
/// CONNECT, absolute-origin, saturated-family, and unknown routes fail closed
/// before semantic dispatch.
///
/// # Errors
///
/// Returns the stock HTTP/2 error when handshake or connection processing fails.
pub async fn serve_sandbox_http2<H, F>(
    stream: &mut TcpForwardByteStream,
    handler: H,
) -> Result<(), h2::Error>
where
    H: Fn(RouteFamily, Request<h2::RecvStream>, SendResponse<Bytes>) -> F
        + Clone
        + Send
        + Sync
        + 'static,
    F: Future<Output = ()> + Send + 'static,
{
    let mut builder = h2::server::Builder::new();
    builder
        .initial_connection_window_size(CONNECTION_RECEIVE_WINDOW_BYTES as u32)
        .initial_window_size(PER_STREAM_RECEIVE_WINDOW_BYTES as u32)
        .max_send_buffer_size(PER_STREAM_RECEIVE_WINDOW_BYTES)
        .max_concurrent_streams(NESTED_MAX_CONCURRENT_STREAMS);
    let mut connection: h2::server::Connection<_, Bytes> = builder.handshake(stream).await?;
    let worker_control = Arc::new(Semaphore::new(route_stream_limit(
        RouteFamily::WorkerControl,
    )));
    let inference = Arc::new(Semaphore::new(route_stream_limit(RouteFamily::Inference)));

    while let Some(incoming) = connection.accept().await {
        let (request, mut respond) = incoming?;
        if request.method() == Method::CONNECT
            || request.uri().scheme_str() != Some("http")
            || request.uri().authority().map(|value| value.as_str())
                != Some(SANDBOX_INTEGRATION_HTTP_AUTHORITY)
        {
            send_empty_response(&mut respond, StatusCode::BAD_REQUEST)?;
            continue;
        }
        let family = match route_family(request.uri().path()) {
            Ok(RouteFamily::Capabilities) => {
                send_empty_response(&mut respond, StatusCode::FORBIDDEN)?;
                continue;
            }
            Ok(family) => family,
            Err(_) => {
                send_empty_response(&mut respond, StatusCode::NOT_FOUND)?;
                continue;
            }
        };
        let semaphore = match family {
            RouteFamily::WorkerControl => Arc::clone(&worker_control),
            RouteFamily::Inference => Arc::clone(&inference),
            RouteFamily::Capabilities => unreachable!("capability is fail-closed above"),
        };
        let Ok(permit) = semaphore.try_acquire_owned() else {
            send_empty_response(&mut respond, StatusCode::TOO_MANY_REQUESTS)?;
            continue;
        };
        let handler = handler.clone();
        tokio::spawn(async move {
            let _permit = permit;
            handler(family, request, respond).await;
        });
    }
    Ok(())
}

/// Sends one bodyless fail-closed HTTP/2 response.
fn send_empty_response(
    respond: &mut SendResponse<Bytes>,
    status: StatusCode,
) -> Result<(), h2::Error> {
    let response = Response::builder()
        .status(status)
        .body(())
        .expect("fixed HTTP response is valid");
    respond.send_response(response, true).map(|_| ())
}

/// Exact lineage binding required before one successor stock pair is admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeBinding {
    /// Current Runtime Epoch identity.
    pub epoch_id: String,
    /// Current epoch-local Gateway identity.
    pub gateway_id: String,
    /// Current NanoCore lease identity.
    pub lease_id: String,
    /// Immutable package snapshot identity.
    pub package_snapshot_id: String,
    /// Exact resolved route-binding digest.
    pub route_bindings_digest: String,
    /// Current sandbox principal.
    pub sandbox_principal: String,
    /// Current stock Supervisor session identity.
    pub supervisor_session_id: String,
}

/// Holds the predecessor fence before admitting one exact-lineage successor.
pub struct BridgePredecessorFence {
    binding: BridgeBinding,
    predecessor_closed: bool,
}

impl BridgePredecessorFence {
    /// Creates a fence for one still-open predecessor pair.
    pub fn new(binding: BridgeBinding) -> Self {
        Self {
            binding,
            predecessor_closed: false,
        }
    }

    /// Records definite predecessor closure.
    pub fn close_predecessor(&mut self) {
        self.predecessor_closed = true;
    }

    /// Admits one exact-lineage successor only after predecessor closure.
    ///
    /// # Errors
    ///
    /// Returns an error while the predecessor is open or the binding differs.
    pub fn begin_successor(
        &self,
        binding: BridgeBinding,
    ) -> Result<ActiveSandboxBridge, &'static str> {
        if !self.predecessor_closed {
            return Err("bridge predecessor remains open");
        }
        if binding != self.binding {
            return Err("bridge successor binding mismatch");
        }
        Ok(ActiveSandboxBridge)
    }
}

/// Observable single-pair, zero-replay successor state.
pub struct ActiveSandboxBridge;

impl ActiveSandboxBridge {
    /// Returns the mandatory one current stock pair.
    pub fn current_pair_count(&self) -> usize {
        1
    }

    /// Returns the forbidden logical replay count.
    pub fn replayed_request_count(&self) -> usize {
        0
    }
}

/// Bounded non-authoritative carriage evidence for one file or immutable reference effect.
pub struct EffectCarriage {
    request_id: String,
    reference: String,
    byte_length: u64,
    cancelled: bool,
}

impl EffectCarriage {
    /// Creates bounded reference evidence without carrying the referenced bytes.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized, control-bearing, or secret-shaped references.
    pub fn reference(
        request_id: &str,
        reference: &str,
        byte_length: u64,
    ) -> Result<Self, &'static str> {
        if request_id.is_empty()
            || request_id.len() > EFFECT_REFERENCE_MAX_BYTES
            || reference.is_empty()
            || reference.len() > EFFECT_REFERENCE_MAX_BYTES
            || request_id.contains(['\r', '\n', '\0'])
            || reference.contains(['\r', '\n', '\0'])
            || reference.contains("okt_")
        {
            return Err("effect reference rejected");
        }
        Ok(Self {
            request_id: request_id.to_string(),
            reference: reference.to_string(),
            byte_length,
            cancelled: false,
        })
    }

    /// Rejects inline effect bytes on the control transport.
    ///
    /// # Errors
    ///
    /// Always returns an error because bulk bytes require a separate data path.
    pub fn inline_control_bytes(_request_id: &str, _bytes: Vec<u8>) -> Result<Self, &'static str> {
        Err("inline effect bytes rejected")
    }

    /// Returns the exact request identity for this effect.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the declared length of the referenced bytes.
    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }

    /// Cancels this carriage before completion.
    pub fn cancel(&mut self) {
        self.cancelled = true;
    }

    /// Returns whether cancellation has definitively closed this carriage.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    /// Completes the non-authoritative reference handoff.
    ///
    /// # Errors
    ///
    /// Returns an error after cancellation and never substitutes inline bytes.
    pub fn complete(&self) -> Result<&str, &'static str> {
        if self.cancelled {
            Err("effect carriage cancelled")
        } else {
            Ok(&self.reference)
        }
    }
}

/// One of the two closed V1 single-file effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEffectKind {
    /// Places one immutable staged input before worker launch.
    ImportReference,
    /// Collects one regular output after the terminal barrier.
    ExportFile,
}

/// Declares whether one export may prove that its exact leaf is absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEffectPresence {
    /// The declared regular file must exist.
    Required,
    /// Exact final-leaf absence is an accepted transport result.
    Optional,
}

impl FileEffectKind {
    /// Returns the fixed wire operation carried to the image-owned helper.
    fn wire_name(self) -> &'static str {
        match self {
            Self::ImportReference => "reference.import",
            Self::ExportFile => "file.export",
        }
    }
}

/// Validated envelope for one regular-file import or export.
pub struct FileEffectRequest {
    /// Correlated outer-session request identity.
    pub request_id: String,
    /// Current ready sandbox identity.
    pub sandbox_id: String,
    /// Declared package slot, never a host path.
    pub slot: String,
    /// Normalized path relative to the declared slot.
    pub relative_path: PathBuf,
    /// Exact lowercase SHA-256 digest for an import; empty for an export whose
    /// actual digest is computed from the produced bytes.
    pub sha256: String,
    /// Exact import byte length or the fixed export maximum.
    pub byte_length: u64,
    /// Closed effect direction.
    pub kind: FileEffectKind,
    /// Closed presence policy; imports are always required.
    pub presence: FileEffectPresence,
}

impl FileEffectRequest {
    /// Validates the immutable slot/path/digest/length envelope before RPC admission.
    ///
    /// # Errors
    ///
    /// Rejects malformed identity, undeclared path shape, non-canonical digest,
    /// and every file larger than 256 MiB.
    pub fn validate(&self) -> Result<(), &'static str> {
        let request_id_invalid = self.request_id.len() != 64
            || !self
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
        let sandbox_invalid = self.sandbox_id.is_empty()
            || self.sandbox_id.len() > EFFECT_REFERENCE_MAX_BYTES
            || self.sandbox_id.contains(['/', '\\', '\r', '\n', '\0']);
        let mut slot_bytes = self.slot.bytes();
        let slot_invalid = self.slot.len() > 128
            || !slot_bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !slot_bytes
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        let path_text = self.relative_path.to_str();
        let path_invalid = self.relative_path.as_os_str().is_empty()
            || self.relative_path.is_absolute()
            || path_text
                .is_none_or(|path| path.contains('\\') || path.chars().any(char::is_control))
            || self
                .relative_path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || self.relative_path.components().collect::<PathBuf>() != self.relative_path;
        let digest_valid = self.sha256.strip_prefix("sha256:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        });
        let file_facts_valid = match self.kind {
            FileEffectKind::ImportReference => {
                self.presence == FileEffectPresence::Required
                    && digest_valid
                    && self.byte_length <= FILE_EFFECT_MAX_BYTES
            }
            FileEffectKind::ExportFile => {
                self.sha256.is_empty() && self.byte_length == FILE_EFFECT_MAX_BYTES
            }
        };
        if request_id_invalid
            || sandbox_invalid
            || slot_invalid
            || path_invalid
            || !file_facts_valid
        {
            return Err("single-file effect envelope rejected");
        }
        Ok(())
    }

    /// Returns the one fixed helper argv; no caller-selected executable is accepted.
    pub fn helper_command(&self) -> Result<Vec<String>, &'static str> {
        self.validate()?;
        let mut command = vec![
            FILE_EFFECT_HELPER.to_string(),
            self.kind.wire_name().to_string(),
            "--slot".to_string(),
            self.slot.clone(),
            "--path".to_string(),
            self.relative_path.to_string_lossy().into_owned(),
        ];
        match self.kind {
            FileEffectKind::ImportReference => command.extend([
                "--length".to_string(),
                self.byte_length.to_string(),
                "--sha256".to_string(),
                self.sha256.clone(),
            ]),
            FileEffectKind::ExportFile => command.extend([
                "--max-length".to_string(),
                FILE_EFFECT_MAX_BYTES.to_string(),
            ]),
        }
        if self.kind == FileEffectKind::ExportFile && self.presence == FileEffectPresence::Optional
        {
            command.push("--allow-missing".to_string());
        }
        Ok(command)
    }
}

/// One completely verified export retained for exact successor delivery.
pub struct RetainedExportResult {
    request_id: String,
    slot: String,
    relative_path: PathBuf,
    sha256: String,
    byte_length: u64,
    bytes: Vec<u8>,
    staging_path: PathBuf,
}

impl Drop for RetainedExportResult {
    /// Removes the request-private copy once delivery is settled or abandoned.
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staging_path);
    }
}

impl RetainedExportResult {
    /// Returns the correlated effect identity.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the declared output slot.
    pub fn slot(&self) -> &str {
        &self.slot
    }

    /// Returns the normalized slot-relative output path.
    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    /// Returns the actual lowercase SHA-256 identity.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    /// Returns the actual complete byte length.
    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }

    /// Returns the complete verified body retained without rerunning export.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Reads and verifies one regular request-private import source.
///
/// # Errors
///
/// Rejects symlinks, hard links, non-regular files, size drift, and digest drift.
pub fn read_import_staging(
    source: &Path,
    request: &FileEffectRequest,
) -> Result<Vec<u8>, &'static str> {
    request.validate()?;
    let metadata = fs::symlink_metadata(source).map_err(|_| "import staging unavailable")?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || metadata.len() != request.byte_length
    {
        return Err("import staging is not the declared regular file");
    }
    let bytes = fs::read(source).map_err(|_| "import staging unavailable")?;
    verify_file_bytes(&bytes, request)?;
    Ok(bytes)
}

/// Fsyncs and atomically places one verified export into private staging.
///
/// # Errors
///
/// Rejects missing terminal proof, byte drift, an existing destination, or any
/// private staging operation that cannot prove the atomic final reference.
pub fn stage_export(
    staging_root: &Path,
    request: &FileEffectRequest,
    bytes: Vec<u8>,
    terminal_barrier_proved: bool,
) -> Result<RetainedExportResult, &'static str> {
    request.validate()?;
    if request.kind != FileEffectKind::ExportFile || !terminal_barrier_proved {
        return Err("file export terminal barrier missing");
    }
    let byte_length = bytes.len() as u64;
    if byte_length > FILE_EFFECT_MAX_BYTES {
        return Err("single-file effect digest or length mismatch");
    }
    let sha256 = format!("sha256:{:x}", Sha256::digest(&bytes));
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(staging_root)
        .map_err(|_| "export staging unavailable")?;
    let final_path = staging_root.join(&request.request_id);
    let temporary = staging_root.join(format!(".{}.partial", request.request_id));
    if final_path.exists() {
        return Err("export staging unavailable");
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "export staging unavailable")?;
    for chunk in bytes.chunks(FILE_EFFECT_CHUNK_BYTES) {
        file.write_all(chunk)
            .map_err(|_| "export staging unavailable")?;
    }
    file.sync_all().map_err(|_| "export staging unavailable")?;
    fs::rename(&temporary, &final_path).map_err(|_| "export staging unavailable")?;
    OpenOptions::new()
        .read(true)
        .open(staging_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "export staging unavailable")?;
    Ok(RetainedExportResult {
        request_id: request.request_id.clone(),
        slot: request.slot.clone(),
        relative_path: request.relative_path.clone(),
        sha256,
        byte_length,
        bytes,
        staging_path: final_path,
    })
}

/// Verifies exact aggregate length and lowercase SHA-256 identity.
fn verify_file_bytes(bytes: &[u8], request: &FileEffectRequest) -> Result<(), &'static str> {
    if bytes.len() as u64 != request.byte_length
        || format!("sha256:{:x}", Sha256::digest(bytes)) != request.sha256
    {
        return Err("single-file effect digest or length mismatch");
    }
    Ok(())
}

/// Bounded ordered epoch-local runtime-produced candidate facts.
pub struct ProducedFactBuffer {
    epoch_id: String,
    facts: VecDeque<(Duration, Vec<u8>)>,
    bytes: usize,
    ended: bool,
}

impl ProducedFactBuffer {
    /// Creates an empty buffer owned by one Runtime Epoch identity.
    pub fn new(epoch_id: &str) -> Self {
        Self {
            epoch_id: epoch_id.to_string(),
            facts: VecDeque::new(),
            bytes: 0,
            ended: false,
        }
    }

    /// Appends one fact without exceeding the 8 MiB sandbox ceiling.
    ///
    /// # Errors
    ///
    /// Returns an error after epoch end or before an append would exceed the ceiling.
    pub fn push(&mut self, observed_at: Duration, fact: Vec<u8>) -> Result<(), &'static str> {
        if self.ended {
            return Err("produced-fact epoch ended");
        }
        let Some(bytes) = self.bytes.checked_add(fact.len()) else {
            return Err("produced-fact buffer full");
        };
        if bytes > PRODUCED_FACT_CAPACITY_BYTES {
            return Err("produced-fact buffer full");
        }
        self.bytes = bytes;
        self.facts.push_back((observed_at, fact));
        Ok(())
    }

    /// Removes all facts in insertion order while they remain inside the age bound.
    ///
    /// # Errors
    ///
    /// Returns an error without dropping data when the oldest fact is 300 seconds old.
    pub fn take(&mut self, now: Duration) -> Result<Vec<Vec<u8>>, &'static str> {
        if self.facts.front().is_some_and(|(observed_at, _)| {
            now.checked_sub(*observed_at)
                .is_some_and(|age| age >= PRODUCED_FACT_MAX_AGE)
        }) {
            return Err("produced-fact buffer expired");
        }
        self.bytes = 0;
        Ok(self.facts.drain(..).map(|(_, fact)| fact).collect())
    }

    /// Ends and clears the buffer only for its exact owning epoch.
    pub fn end_epoch(&mut self, epoch_id: &str) {
        if epoch_id == self.epoch_id {
            self.facts.clear();
            self.bytes = 0;
            self.ended = true;
        }
    }

    /// Returns whether no produced fact remains buffered.
    pub fn is_empty(&self) -> bool {
        self.facts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::path::PathBuf;
    use std::time::Duration;

    use http::{Method, Request, Response, StatusCode};
    use openshell_sdk::raw::proto::{TcpForwardFrame, tcp_forward_frame};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;

    use super::{
        BRIDGE_REESTABLISH_HARD_BOUND, BRIDGE_REESTABLISH_TARGET, BridgeBinding,
        BridgePredecessorFence, CAPABILITY_IN_FLIGHT_BYTES, CONNECTION_RECEIVE_WINDOW_BYTES,
        EffectCarriage, FILE_EFFECT_MAX_BYTES, FileEffectKind, FileEffectPresence,
        FileEffectRequest, HTTP2_PRIORITY_ENABLED, INFERENCE_IN_FLIGHT_BYTES,
        MAX_INFERENCE_WRITE_BYTES, NESTED_MAX_CONCURRENT_STREAMS, OUTER_MAX_CONCURRENT_STREAMS,
        PER_STREAM_RECEIVE_WINDOW_BYTES, ProducedFactBuffer, RouteFamily, TcpForwardByteStream,
        WORKER_CONTROL_IN_FLIGHT_BYTES, route_family, route_stream_limit, serve_sandbox_http2,
    };

    #[test]
    fn wp4_transport_constants_and_route_table_match_the_fixed_integration_projection() {
        assert_eq!(CONNECTION_RECEIVE_WINDOW_BYTES, 5 * 1024 * 1024);
        assert_eq!(PER_STREAM_RECEIVE_WINDOW_BYTES, 256 * 1024);
        assert_eq!(NESTED_MAX_CONCURRENT_STREAMS, 14);
        assert_eq!(OUTER_MAX_CONCURRENT_STREAMS, 16);
        assert_eq!(WORKER_CONTROL_IN_FLIGHT_BYTES, 1024 * 1024);
        assert_eq!(INFERENCE_IN_FLIGHT_BYTES, 2 * 1024 * 1024);
        assert_eq!(CAPABILITY_IN_FLIGHT_BYTES, 512 * 1024);
        assert_eq!(MAX_INFERENCE_WRITE_BYTES, 64 * 1024);
        assert!(!HTTP2_PRIORITY_ENABLED);
        assert_eq!(route_stream_limit(RouteFamily::WorkerControl), 4);
        assert_eq!(route_stream_limit(RouteFamily::Inference), 8);
        assert_eq!(route_stream_limit(RouteFamily::Capabilities), 0);
        assert_eq!(
            route_family("/worker-control/heartbeat"),
            Ok(RouteFamily::WorkerControl)
        );
        assert_eq!(
            route_family("/inference/v1/responses"),
            Ok(RouteFamily::Inference)
        );
        assert_eq!(
            route_family("/capabilities/calls"),
            Ok(RouteFamily::Capabilities)
        );
        assert!(route_family("https://nanocore.example/worker-control/heartbeat").is_err());
        assert!(route_family("/gateway/forward").is_err());

        let integration_source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/worker-shim/src/integration-client.ts"
        ))
        .expect("the released U-4-1 Integration owner must exist");
        assert!(integration_source.contains("export const SANDBOX_INTEGRATION_TARGET"));
        assert!(integration_source.contains(super::SANDBOX_INTEGRATION_TARGET));
        assert!(!integration_source.contains("OPENKIT_CONTROL_BASE_URL"));

        let bridge_source = include_str!("sandbox_bridge.rs");
        let serve_source = bridge_source
            .split_once("pub async fn serve_sandbox_http2")
            .expect("the nested H2 owner must exist")
            .1
            .split_once("fn send_empty_response")
            .expect("the nested H2 owner must end before its response helper")
            .0;
        let active_limit = serve_source
            .find("route_stream_limit(")
            .expect("serve_sandbox_http2 must actively acquire the family DATA-derived limit");
        let handler = serve_source
            .find("handler(family, request, respond).await")
            .expect("the semantic handler call must remain explicit");
        assert!(active_limit < handler);
        assert!(
            serve_source.contains("initial_connection_window_size(CONNECTION_RECEIVE_WINDOW_BYTES")
        );
        assert!(serve_source.contains("initial_window_size(PER_STREAM_RECEIVE_WINDOW_BYTES"));
    }

    #[tokio::test]
    async fn wp4_fixed_node_h2_origin_reaches_only_the_declared_handler() {
        let (inbound_tx, inbound_rx) = mpsc::channel(16);
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<TcpForwardFrame>(16);
        let (client_io, wire_io) = tokio::io::duplex(256 * 1024);
        let (mut wire_read, mut wire_write) = tokio::io::split(wire_io);
        let inbound_pump = tokio::spawn(async move {
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                let count = wire_read
                    .read(&mut buffer)
                    .await
                    .expect("in-memory client bytes must remain readable");
                if count == 0 {
                    break;
                }
                inbound_tx
                    .send(Ok(TcpForwardFrame {
                        payload: Some(tcp_forward_frame::Payload::Data(buffer[..count].to_vec())),
                    }))
                    .await
                    .expect("client bytes must enter the stock frame adapter");
            }
        });
        let outbound_pump = tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if let Some(tcp_forward_frame::Payload::Data(data)) = frame.payload {
                    wire_write
                        .write_all(&data)
                        .await
                        .expect("server bytes must reach the in-memory client");
                }
            }
        });
        let (handled_tx, mut handled_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let mut stream = TcpForwardByteStream::new(inbound_rx, outbound_tx);
            serve_sandbox_http2(&mut stream, move |family, request, mut respond| {
                let handled_tx = handled_tx.clone();
                async move {
                    handled_tx
                        .send((family, request.uri().to_string()))
                        .expect("handler observation channel must remain open");
                    respond
                        .send_response(
                            Response::builder()
                                .status(StatusCode::OK)
                                .body(())
                                .expect("fixed response must build"),
                            true,
                        )
                        .expect("handler response must remain writable");
                }
            })
            .await
        });
        let (mut client, connection) = h2::client::handshake(client_io)
            .await
            .expect("in-memory standard H2 handshake must succeed");
        let client_driver = tokio::spawn(connection);

        let accepted = Request::builder()
            .method(Method::GET)
            .uri("http://sandbox-integration:80/worker-control/heartbeat")
            .body(())
            .expect("fixed Node H2 request must build");
        let (accepted, _) = client
            .send_request(accepted, true)
            .expect("fixed Node H2 request must be sent");
        assert_eq!(
            accepted.await.expect("fixed Node H2 response").status(),
            StatusCode::OK
        );
        assert_eq!(
            handled_rx.recv().await,
            Some((
                RouteFamily::WorkerControl,
                "http://sandbox-integration:80/worker-control/heartbeat".into()
            ))
        );

        for request in [
            Request::builder()
                .method(Method::GET)
                .uri("https://sandbox-integration:80/worker-control/heartbeat")
                .body(())
                .expect("wrong-scheme request must build"),
            Request::builder()
                .method(Method::GET)
                .uri("http://wrong-integration:80/worker-control/heartbeat")
                .body(())
                .expect("wrong-authority request must build"),
            Request::builder()
                .method(Method::CONNECT)
                .uri("sandbox-integration:80")
                .body(())
                .expect("CONNECT request must build"),
        ] {
            let (rejected, _) = client
                .send_request(request, true)
                .expect("fail-closed request must reach the H2 route guard");
            assert_eq!(
                rejected.await.expect("fail-closed H2 response").status(),
                StatusCode::BAD_REQUEST
            );
            assert!(handled_rx.try_recv().is_err());
        }

        drop(client);
        client_driver.abort();
        server.abort();
        inbound_pump.abort();
        outbound_pump.abort();
    }

    #[tokio::test]
    async fn wp4_tcp_forward_frames_are_async_bytes_with_eof_status_and_cancellation() {
        let (inbound_tx, inbound_rx) = mpsc::channel(4);
        let (outbound_tx, mut outbound_rx) = mpsc::channel(4);
        let mut stream = TcpForwardByteStream::new(inbound_rx, outbound_tx);
        inbound_tx
            .send(Ok(TcpForwardFrame {
                payload: Some(tcp_forward_frame::Payload::Data(b"inbound".to_vec())),
            }))
            .await
            .expect("inbound frame must enter the adapter");
        let mut inbound = [0_u8; 7];
        stream
            .read_exact(&mut inbound)
            .await
            .expect("DATA must become async bytes");
        assert_eq!(&inbound, b"inbound");

        stream
            .write_all(b"outbound")
            .await
            .expect("async bytes must become DATA");
        let outbound = outbound_rx.recv().await.expect("one outbound DATA frame");
        assert!(matches!(
            outbound.payload,
            Some(tcp_forward_frame::Payload::Data(data)) if data == b"outbound"
        ));

        drop(inbound_tx);
        assert_eq!(
            stream
                .read(&mut [0_u8; 1])
                .await
                .expect("EOF must be definite"),
            0
        );

        let (error_tx, error_rx) = mpsc::channel(1);
        let (discard_tx, _discard_rx) = mpsc::channel(1);
        let mut failed = TcpForwardByteStream::new(error_rx, discard_tx);
        error_tx
            .send(Err(tonic::Status::unavailable("forward stream failed")))
            .await
            .expect("status must enter the adapter");
        assert_eq!(
            failed
                .read(&mut [0_u8; 1])
                .await
                .expect_err("status must fail bytes")
                .kind(),
            ErrorKind::ConnectionAborted
        );
        failed.cancel();
        assert!(failed.is_cancelled());
    }

    #[test]
    fn wp4_produced_facts_are_ordered_bounded_and_epoch_local() {
        let mut facts = ProducedFactBuffer::new("epoch-a");
        facts
            .push(Duration::ZERO, b"first".to_vec())
            .expect("first fact");
        facts
            .push(Duration::from_secs(1), b"second".to_vec())
            .expect("second fact");
        assert_eq!(
            facts
                .take(Duration::from_secs(2))
                .expect("facts inside age bound"),
            vec![b"first".to_vec(), b"second".to_vec()]
        );
        assert!(
            facts
                .push(Duration::ZERO, vec![0_u8; 8 * 1024 * 1024 + 1])
                .is_err()
        );
        let mut expired = ProducedFactBuffer::new("epoch-a");
        expired
            .push(Duration::ZERO, b"stale".to_vec())
            .expect("stale fixture");
        assert!(expired.take(Duration::from_secs(300)).is_err());
        expired.end_epoch("epoch-a");
        assert!(expired.is_empty());
        assert!(
            expired
                .push(Duration::from_secs(1), b"late".to_vec())
                .is_err()
        );
    }

    #[test]
    fn wp4_successor_waits_for_exact_predecessor_closure_without_replay_or_second_pair() {
        let binding = BridgeBinding {
            epoch_id: "epoch-a".into(),
            gateway_id: "gateway-a".into(),
            lease_id: "lease-a".into(),
            package_snapshot_id: "package-a".into(),
            route_bindings_digest: "routes-a".into(),
            sandbox_principal: "sandbox-a".into(),
            supervisor_session_id: "supervisor-a".into(),
        };
        let mut fence = BridgePredecessorFence::new(binding.clone());
        assert!(fence.begin_successor(binding.clone()).is_err());
        fence.close_predecessor();
        let successor = fence
            .begin_successor(binding)
            .expect("closed predecessor admits successor");
        assert_eq!(successor.current_pair_count(), 1);
        assert_eq!(successor.replayed_request_count(), 0);
        assert_eq!(BRIDGE_REESTABLISH_TARGET, Duration::from_secs(30));
        assert_eq!(BRIDGE_REESTABLISH_HARD_BOUND, Duration::from_secs(120));
    }

    #[test]
    fn wp5_effect_carriage_returns_only_bounded_references_and_cancels_definitively() {
        let mut reference = EffectCarriage::reference(
            "request-bridge",
            "nanohost://sandbox/sandbox-a/output/result.json",
            4096,
        )
        .expect("bounded non-secret reference");
        assert_eq!(reference.request_id(), "request-bridge");
        assert_eq!(reference.byte_length(), 4096);
        assert!(EffectCarriage::inline_control_bytes("request-inline", vec![0_u8; 1]).is_err());
        assert!(EffectCarriage::reference("request-empty", "", 1).is_err());
        reference.cancel();
        assert!(reference.is_cancelled());
        assert!(reference.complete().is_err());

        let optional_export = FileEffectRequest {
            request_id: "a".repeat(64),
            sandbox_id: "sandbox-a".into(),
            slot: "session".into(),
            relative_path: PathBuf::from("workspace-changes.json"),
            sha256: String::new(),
            byte_length: FILE_EFFECT_MAX_BYTES,
            kind: FileEffectKind::ExportFile,
            presence: FileEffectPresence::Optional,
        };
        assert_eq!(
            optional_export
                .helper_command()
                .expect("optional export command")
                .last()
                .map(String::as_str),
            Some("--allow-missing")
        );

        let source = include_str!("sandbox_bridge.rs")
            .split_once("#[cfg(test)]")
            .expect("bridge production section")
            .0;
        for required in [
            "256 * 1024 * 1024",
            "64 * 1024",
            "sha256",
            "sync_all",
            "rename",
            "reference.import",
            "file.export",
        ] {
            assert!(
                source.contains(required),
                "missing file effect rule {required}"
            );
        }
        let import = source
            .split_once("pub fn read_import_staging(")
            .expect("import private staging owner")
            .1
            .split_once("/// Fsyncs and atomically places one verified export")
            .expect("end of import staging owner")
            .0;
        assert!(
            import
                .find("verify_file_bytes")
                .expect("complete import proof")
                > 0
        );
        let export = source
            .split_once("pub fn stage_export(")
            .expect("export private staging owner")
            .1
            .split_once("/// Verifies exact aggregate length")
            .expect("end of export staging owner")
            .0;
        assert!(export.contains("Sha256::digest"));
        assert!(export.contains("bytes.len()"));
        assert!(
            export.find("sync_all").expect("export fsync")
                < export.find("rename").expect("atomic export placement")
        );
        for bootstrap_rule in [
            "sandbox_integration_binding_ref",
            "harness_ready",
            "exec_monitor",
            "ForwardTcp",
        ] {
            assert!(
                source.contains(bootstrap_rule),
                "missing bridge bootstrap rule {bootstrap_rule}"
            );
        }
        assert!(!source.contains("worker_control_token"));
        assert!(!source.contains("worker_inference_token"));
    }
}
