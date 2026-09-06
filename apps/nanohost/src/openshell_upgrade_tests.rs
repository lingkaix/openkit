//! Unadmitted stock forwarding diagnostic, never a deciding qualification gate.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http::{Request, Response, StatusCode};
use openshell_sdk::raw::proto::{
    CreateSandboxRequest, CreateSshSessionRequest, ExecSandboxRequest, FilesystemPolicy,
    LandlockPolicy, ProcessPolicy, RevokeSshSessionRequest, SandboxPolicy, SandboxSpec,
    SandboxTemplate, TcpForwardFrame, TcpForwardInit, TcpRelayTarget, exec_sandbox_event,
    tcp_forward_frame, tcp_forward_init,
};
use openshell_sdk::{EdgeAuthInterceptor, ListOptions, OpenShellClient, ServiceStatus};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity};

use crate::openshell_release::{supervisor_image, version};
use crate::sandbox_bridge::{
    FORWARD_FRAME_CHANNEL_CAPACITY, SANDBOX_INTEGRATION_TARGET, TcpForwardByteStream,
    serve_sandbox_http2,
};

const LIVE_FLAG: &str = "OPENKIT_OPENSHELL_UPGRADE_LIVE";
const GATEWAY_URL: &str = "OPENKIT_OPENSHELL_UPGRADE_GATEWAY_URL";
const TLS_DIR: &str = "OPENKIT_OPENSHELL_UPGRADE_TLS_DIR";
const GATEWAY_BINARY: &str = "OPENKIT_OPENSHELL_UPGRADE_GATEWAY_BINARY";
const GATEWAY_CONFIG: &str = "OPENKIT_OPENSHELL_UPGRADE_GATEWAY_CONFIG";
const SANDBOX_IMAGE: &str = "OPENKIT_OPENSHELL_UPGRADE_SANDBOX_IMAGE";
const FIXTURE_URL: &str = "https://127.0.0.1:17670";
const REQUEST_BYTES: usize = 512 * 1024;
const RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAUSED_ACCEPTED_BYTES: usize = 512 * 1024;
const CHUNKS: [usize; 7] = [1, 7, 63, 1024, 65_535, 3, 8192];
const PEER_SOURCE: &str = include_str!("../tests/openshell-upgrade-peer.mjs");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureOutcome {
    Prerequisite,
    Error,
    Timeout,
    Incompatible,
    CleanupFailed,
}

impl fmt::Display for FailureOutcome {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::Prerequisite => "prerequisite",
            Self::Error => "error",
            Self::Timeout => "timeout",
            Self::Incompatible => "incompatible",
            Self::CleanupFailed => "cleanup-failed",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProbeFailure {
    stage: &'static str,
    outcome: FailureOutcome,
}

impl ProbeFailure {
    const fn new(stage: &'static str, outcome: FailureOutcome) -> Self {
        Self { stage, outcome }
    }
}

impl fmt::Display for ProbeFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "stage={} outcome={}", self.stage, self.outcome)
    }
}

#[derive(Debug)]
struct Inputs {
    gateway_url: String,
    tls_dir: PathBuf,
    gateway_binary: PathBuf,
    gateway_config: PathBuf,
    sandbox_image: String,
}

#[derive(Debug)]
struct Release {
    version: String,
    commit: String,
    gateway_sha256: String,
    supervisor_image: String,
}

fn required<'a>(values: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, ProbeFailure> {
    values
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty() && value.trim() == *value)
        .ok_or(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ))
}

fn parse_inputs(values: &BTreeMap<String, String>) -> Result<Inputs, ProbeFailure> {
    if values.get(LIVE_FLAG).map(String::as_str) != Some("1") {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    let gateway_url = required(values, GATEWAY_URL)?;
    if gateway_url != FIXTURE_URL {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    let tls_dir = PathBuf::from(required(values, TLS_DIR)?);
    let gateway_binary = PathBuf::from(required(values, GATEWAY_BINARY)?);
    let gateway_config = PathBuf::from(required(values, GATEWAY_CONFIG)?);
    if [&tls_dir, &gateway_binary, &gateway_config]
        .iter()
        .any(|path| !path.is_absolute())
    {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    let sandbox_image = required(values, SANDBOX_IMAGE)?;
    let Some((repository, digest)) = sandbox_image.rsplit_once("@sha256:") else {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    };
    if repository.is_empty()
        || repository.contains('@')
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    Ok(Inputs {
        gateway_url: gateway_url.to_string(),
        tls_dir,
        gateway_binary,
        gateway_config,
        sandbox_image: sandbox_image.to_string(),
    })
}

fn release() -> Result<Release, ProbeFailure> {
    let value: serde_json::Value = serde_json::from_str(include_str!("../openshell/release.json"))
        .map_err(|_| ProbeFailure::new("prerequisites", FailureOutcome::Prerequisite))?;
    let text = |path: &[&str]| {
        let mut value = &value;
        for key in path {
            value = value.get(key)?;
        }
        value.as_str().map(str::to_string)
    };
    let version = version();
    let commit = text(&["source", "commit"]);
    let gateway_sha256 = text(&["gateway", "executable", "sha256"]);
    let supervisor_image = supervisor_image();
    let (Some(version), Some(commit), Some(gateway_sha256), Some(supervisor_image)) =
        (version, commit, gateway_sha256, supervisor_image)
    else {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    };
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || commit.len() != 40
        || gateway_sha256.len() != 64
    {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    Ok(Release {
        supervisor_image,
        version,
        commit,
        gateway_sha256,
    })
}

fn file_sha256(path: &Path) -> Result<String, ProbeFailure> {
    let mut file = fs::File::open(path)
        .map_err(|_| ProbeFailure::new("prerequisites", FailureOutcome::Prerequisite))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| ProbeFailure::new("prerequisites", FailureOutcome::Prerequisite))?;
        if count == 0 {
            return Ok(format!("{:x}", digest.finalize()));
        }
        digest.update(&buffer[..count]);
    }
}

fn configured_supervisor(path: &Path) -> Result<String, ProbeFailure> {
    let contents = fs::read_to_string(path)
        .map_err(|_| ProbeFailure::new("prerequisites", FailureOutcome::Prerequisite))?;
    let matches = contents
        .lines()
        .filter_map(|line| {
            let line = line.split('#').next()?.trim();
            let (key, value) = line.split_once('=')?;
            (key.trim() == "supervisor_image").then(|| {
                value
                    .trim()
                    .strip_prefix('"')?
                    .strip_suffix('"')
                    .map(str::to_string)
            })?
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    Ok(matches[0].clone())
}

async fn observe<T, F>(stage: &'static str, bound: Duration, future: F) -> Result<T, ProbeFailure>
where
    F: Future<Output = Result<T, ()>>,
{
    match timeout(bound, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(())) => Err(ProbeFailure::new(stage, FailureOutcome::Error)),
        Err(_) => Err(ProbeFailure::new(stage, FailureOutcome::Timeout)),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PeerSignal {
    Ready,
    Paused,
    Result { bytes: usize, sha256: String },
    Exit,
}

#[derive(Default)]
struct PeerOutput {
    buffered: Vec<u8>,
}

impl PeerOutput {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<PeerSignal>, ()> {
        if self.buffered.len() + bytes.len() > 512 {
            return Err(());
        }
        self.buffered.extend_from_slice(bytes);
        let mut signals = Vec::new();
        while let Some(end) = self.buffered.iter().position(|byte| *byte == b'\n') {
            let line = self.buffered.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line[..line.len() - 1]).map_err(|_| ())?;
            let signal = match line {
                "READY" => PeerSignal::Ready,
                "PAUSED" => PeerSignal::Paused,
                "EXIT 0" => PeerSignal::Exit,
                "ERROR" => return Err(()),
                _ => {
                    let mut parts = line.split(' ');
                    if parts.next() != Some("RESULT") {
                        return Err(());
                    }
                    let bytes = parts.next().ok_or(())?.parse().map_err(|_| ())?;
                    let sha256 = parts.next().ok_or(())?;
                    if parts.next().is_some()
                        || sha256.len() != 64
                        || !sha256
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                    {
                        return Err(());
                    }
                    PeerSignal::Result {
                        bytes,
                        sha256: sha256.to_string(),
                    }
                }
            };
            signals.push(signal);
        }
        Ok(signals)
    }
}

#[derive(Default)]
struct ForwardObservation {
    request_integrity: bool,
    paused: bool,
    backpressure: bool,
    resumed: bool,
    response_integrity: bool,
}

struct SandboxCreation {
    result: Result<String, ProbeFailure>,
    expected_id: Option<String>,
    cleanup_fenced: bool,
}

struct SandboxAttemptObservation {
    forward: Result<(), ProbeFailure>,
    cleanup: Result<(), ProbeFailure>,
    cleanup_fenced: bool,
}

fn evaluate(observation: &ForwardObservation) -> Result<(), ProbeFailure> {
    if observation.request_integrity
        && observation.paused
        && observation.backpressure
        && observation.resumed
        && observation.response_integrity
    {
        Ok(())
    } else {
        Err(ProbeFailure::new("forward", FailureOutcome::Incompatible))
    }
}

fn evaluate_attempt(observation: &SandboxAttemptObservation) -> Result<(), ProbeFailure> {
    observation.cleanup?;
    if !observation.cleanup_fenced {
        return Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed));
    }
    observation.forward
}

async fn observe_sandbox_attempt<F, C>(
    forward: F,
    cleanup: C,
    cleanup_fenced: bool,
) -> SandboxAttemptObservation
where
    F: Future<Output = Result<ForwardObservation, ProbeFailure>>,
    C: Future<Output = Result<(), ProbeFailure>>,
{
    let forward = forward.await.and_then(|observation| evaluate(&observation));
    let cleanup = cleanup.await;
    SandboxAttemptObservation {
        forward,
        cleanup,
        cleanup_fenced,
    }
}

fn deterministic_bytes(length: usize, multiplier: usize, addend: usize) -> Vec<u8> {
    (0..length)
        .map(|index| ((index * multiplier + addend) % 251) as u8)
        .collect()
}

async fn connect(inputs: &Inputs) -> Result<OpenShellClient, ProbeFailure> {
    let ca = fs::read(inputs.tls_dir.join("ca.crt"))
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Prerequisite))?;
    let cert = fs::read(inputs.tls_dir.join("client/tls.crt"))
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Prerequisite))?;
    let key = fs::read(inputs.tls_dir.join("client/tls.key"))
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Prerequisite))?;
    let tls = ClientTlsConfig::new()
        .domain_name("127.0.0.1")
        .ca_certificate(Certificate::from_pem(ca))
        .identity(Identity::from_pem(cert, key));
    let channel: Channel = Endpoint::from_shared(inputs.gateway_url.clone())
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Prerequisite))?
        .tls_config(tls)
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Prerequisite))?
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .connect()
        .await
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Error))?;
    Ok(OpenShellClient::from_parts(
        channel,
        EdgeAuthInterceptor::noop(),
    ))
}

fn unique_sandbox_name() -> String {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64;
    let seed = micros ^ u64::from(std::process::id());
    format!("okupg-{:012x}", seed & 0x0000_ffff_ffff_ffff)
}

fn fixture_policy() -> SandboxPolicy {
    SandboxPolicy {
        version: 1,
        filesystem: Some(FilesystemPolicy {
            include_workdir: true,
            read_only: vec!["/".to_string()],
            read_write: vec!["/sandbox".to_string()],
        }),
        landlock: Some(LandlockPolicy {
            compatibility: "best_effort".to_string(),
        }),
        process: Some(ProcessPolicy {
            run_as_user: "sandbox".to_string(),
            run_as_group: "sandbox".to_string(),
        }),
        network_policies: HashMap::new(),
        network_middlewares: HashMap::new(),
    }
}

async fn create_sandbox(client: &OpenShellClient, name: &str, image: &str) -> SandboxCreation {
    let mut labels = HashMap::new();
    labels.insert("openkit-upgrade-probe".to_string(), name.to_string());
    let response = match client
        .raw_grpc()
        .create_sandbox(CreateSandboxRequest {
            spec: Some(SandboxSpec {
                template: Some(SandboxTemplate {
                    image: image.to_string(),
                    ..SandboxTemplate::default()
                }),
                policy: Some(fixture_policy()),
                ..SandboxSpec::default()
            }),
            name: name.to_string(),
            labels,
            annotations: HashMap::new(),
            workspace: String::new(),
        })
        .await
    {
        Ok(response) => response
            .into_inner()
            .sandbox
            .and_then(|sandbox| sandbox.metadata),
        Err(_) => {
            return SandboxCreation {
                result: Err(ProbeFailure::new("sandbox-create", FailureOutcome::Error)),
                expected_id: None,
                cleanup_fenced: false,
            };
        }
    };
    let Some(response) = response else {
        return SandboxCreation {
            result: Err(ProbeFailure::new(
                "sandbox-create",
                FailureOutcome::Incompatible,
            )),
            expected_id: None,
            cleanup_fenced: false,
        };
    };
    let expected_id = (!response.id.is_empty()).then(|| response.id.clone());
    if response.name != name || response.id.is_empty() {
        return SandboxCreation {
            result: Err(ProbeFailure::new(
                "sandbox-create",
                FailureOutcome::Incompatible,
            )),
            expected_id,
            cleanup_fenced: false,
        };
    }
    let ready = match client.wait_ready(name, Duration::from_secs(120)).await {
        Ok(ready) => ready,
        Err(_) => {
            return SandboxCreation {
                result: Err(ProbeFailure::new("sandbox-create", FailureOutcome::Error)),
                expected_id,
                cleanup_fenced: true,
            };
        }
    };
    if ready.id != response.id || ready.name != name {
        return SandboxCreation {
            result: Err(ProbeFailure::new(
                "sandbox-create",
                FailureOutcome::Incompatible,
            )),
            expected_id,
            cleanup_fenced: true,
        };
    }
    SandboxCreation {
        result: Ok(response.id),
        expected_id,
        cleanup_fenced: true,
    }
}

fn start_peer(
    client: &OpenShellClient,
    sandbox_id: &str,
) -> (JoinHandle<Result<(), ()>>, mpsc::Receiver<PeerSignal>) {
    let client = client.clone();
    let sandbox_id = sandbox_id.to_string();
    let (signal_tx, signal_rx) = mpsc::channel(8);
    let monitor = tokio::spawn(async move {
        let mut events = client
            .raw_grpc()
            .exec_sandbox(ExecSandboxRequest {
                sandbox_id,
                command: vec![
                    "node".to_string(),
                    "--input-type=module".to_string(),
                    "-e".to_string(),
                    PEER_SOURCE.to_string(),
                ],
                workdir: "/workspace".to_string(),
                environment: HashMap::new(),
                timeout_seconds: 30,
                stdin: Vec::new(),
                tty: false,
                cols: 0,
                rows: 0,
            })
            .await
            .map_err(|_| ())?
            .into_inner();
        let mut output = PeerOutput::default();
        let mut exit_status = None;
        while let Some(event) = events.next().await {
            match event.map_err(|_| ())?.payload {
                Some(exec_sandbox_event::Payload::Stdout(stdout)) => {
                    for signal in output.push(&stdout.data)? {
                        signal_tx.send(signal).await.map_err(|_| ())?;
                    }
                }
                Some(exec_sandbox_event::Payload::Stderr(stderr)) if stderr.data.is_empty() => {}
                Some(exec_sandbox_event::Payload::Exit(exit)) if exit_status.is_none() => {
                    exit_status = Some(exit.exit_code);
                }
                _ => return Err(()),
            }
        }
        if !output.buffered.is_empty() || exit_status != Some(0) {
            return Err(());
        }
        Ok(())
    });
    (monitor, signal_rx)
}

async fn abort_peer(peer: &mut Option<JoinHandle<Result<(), ()>>>) {
    if let Some(peer) = peer.take() {
        peer.abort();
        let _ = peer.await;
    }
}

async fn next_signal(
    signals: &mut mpsc::Receiver<PeerSignal>,
    expected: fn(&PeerSignal) -> bool,
) -> Result<PeerSignal, ProbeFailure> {
    observe("peer", Duration::from_secs(20), async {
        loop {
            let signal = signals.recv().await.ok_or(())?;
            if expected(&signal) {
                return Ok(signal);
            }
        }
    })
    .await
}

async fn send_response(
    mut respond: h2::server::SendResponse<Bytes>,
    sent: Arc<AtomicUsize>,
    complete: Arc<AtomicBool>,
) -> Result<(), ()> {
    let response = Response::builder()
        .status(StatusCode::OK)
        .header("content-length", RESPONSE_BYTES)
        .body(())
        .map_err(|_| ())?;
    let mut stream = respond.send_response(response, false).map_err(|_| ())?;
    let body = deterministic_bytes(RESPONSE_BYTES, 17, 11);
    let mut offset = 0;
    let mut chunk = 0;
    while offset < body.len() {
        let wanted = CHUNKS[chunk % CHUNKS.len()].min(body.len() - offset);
        let mut remaining = wanted;
        while remaining > 0 {
            stream.reserve_capacity(remaining);
            let capacity = std::future::poll_fn(|context| stream.poll_capacity(context))
                .await
                .ok_or(())?
                .map_err(|_| ())?;
            if capacity == 0 {
                return Err(());
            }
            let count = capacity.min(remaining);
            let end = offset + count;
            stream
                .send_data(
                    Bytes::copy_from_slice(&body[offset..end]),
                    end == body.len(),
                )
                .map_err(|_| ())?;
            offset = end;
            remaining -= count;
            sent.store(offset, Ordering::SeqCst);
        }
        chunk += 1;
    }
    complete.store(true, Ordering::SeqCst);
    Ok(())
}

async fn observe_bounded_producer_plateau(sent: &AtomicUsize, complete: &AtomicBool) -> bool {
    let mut previous = sent.load(Ordering::SeqCst);
    let mut unchanged_samples = 0;
    for _ in 0..10 {
        sleep(Duration::from_millis(100)).await;
        let current = sent.load(Ordering::SeqCst);
        if current > 0
            && current == previous
            && current <= MAX_PAUSED_ACCEPTED_BYTES
            && !complete.load(Ordering::SeqCst)
        {
            unchanged_samples += 1;
            if unchanged_samples == 3 {
                return true;
            }
        } else {
            unchanged_samples = 0;
        }
        previous = current;
    }
    false
}

async fn handle_request(
    request: Request<h2::RecvStream>,
    respond: h2::server::SendResponse<Bytes>,
    request_ok: Arc<AtomicBool>,
    sent: Arc<AtomicUsize>,
    complete: Arc<AtomicBool>,
    handler_failed: Arc<AtomicBool>,
) {
    let result = async {
        if request.method() != http::Method::POST
            || request.uri().path() != "/inference/openshell-upgrade-probe"
        {
            return Err(());
        }
        let mut body = request.into_body();
        let mut received = Vec::with_capacity(REQUEST_BYTES);
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|_| ())?;
            if received.len() + chunk.len() > REQUEST_BYTES {
                return Err(());
            }
            received.extend_from_slice(&chunk);
            body.flow_control()
                .release_capacity(chunk.len())
                .map_err(|_| ())?;
        }
        if received != deterministic_bytes(REQUEST_BYTES, 31, 7) {
            return Err(());
        }
        request_ok.store(true, Ordering::SeqCst);
        send_response(respond, sent, complete).await
    }
    .await;
    if result.is_err() {
        handler_failed.store(true, Ordering::SeqCst);
    }
}

async fn run_forward_slice(
    client: &OpenShellClient,
    sandbox_id: &str,
) -> Result<ForwardObservation, ProbeFailure> {
    let (peer, mut signals) = start_peer(client, sandbox_id);
    let mut peer = Some(peer);
    let ready = next_signal(&mut signals, |signal| matches!(signal, PeerSignal::Ready)).await;
    if let Err(failure) = ready {
        abort_peer(&mut peer).await;
        return Err(failure);
    }

    let mut grpc = client.raw_grpc();
    let session = match grpc
        .create_ssh_session(CreateSshSessionRequest {
            sandbox_id: sandbox_id.to_string(),
        })
        .await
    {
        Ok(response) => response.into_inner(),
        Err(_) => {
            abort_peer(&mut peer).await;
            return Err(ProbeFailure::new("forward-auth", FailureOutcome::Error));
        }
    };
    if session.token.is_empty() {
        abort_peer(&mut peer).await;
        return Err(ProbeFailure::new(
            "forward-auth",
            FailureOutcome::Incompatible,
        ));
    }
    let token = session.token;
    if session.sandbox_id != sandbox_id {
        abort_peer(&mut peer).await;
        if grpc
            .revoke_ssh_session(RevokeSshSessionRequest { token })
            .await
            .is_err()
        {
            eprintln!("stage=forward-auth outcome=cleanup-failed");
        }
        return Err(ProbeFailure::new(
            "forward-auth",
            FailureOutcome::Incompatible,
        ));
    }
    let result = async {
        let (outbound, outbound_rx) = mpsc::channel(FORWARD_FRAME_CHANNEL_CAPACITY);
        let forward = grpc.forward_tcp(ReceiverStream::new(outbound_rx));
        let (host, port) = SANDBOX_INTEGRATION_TARGET
            .split_once(':')
            .ok_or(ProbeFailure::new("forward", FailureOutcome::Incompatible))?;
        outbound
            .send(TcpForwardFrame {
                payload: Some(tcp_forward_frame::Payload::Init(TcpForwardInit {
                    sandbox_id: sandbox_id.to_string(),
                    service_id: "openkit-upgrade-probe".to_string(),
                    target: Some(tcp_forward_init::Target::Tcp(TcpRelayTarget {
                        host: host.to_string(),
                        port: port.parse().map_err(|_| {
                            ProbeFailure::new("forward", FailureOutcome::Incompatible)
                        })?,
                    })),
                    authorization_token: token.clone(),
                })),
            })
            .await
            .map_err(|_| ProbeFailure::new("forward", FailureOutcome::Error))?;
        let response = timeout(Duration::from_secs(20), forward)
            .await
            .map_err(|_| ProbeFailure::new("forward", FailureOutcome::Timeout))?
            .map_err(|_| ProbeFailure::new("forward", FailureOutcome::Error))?;
        let mut stream = TcpForwardByteStream::from_grpc(response.into_inner(), outbound);
        let request_ok = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(AtomicUsize::new(0));
        let complete = Arc::new(AtomicBool::new(false));
        let handler_failed = Arc::new(AtomicBool::new(false));
        let route_request_ok = Arc::clone(&request_ok);
        let route_sent = Arc::clone(&sent);
        let route_complete = Arc::clone(&complete);
        let route_handler_failed = Arc::clone(&handler_failed);
        let route = tokio::spawn(async move {
            serve_sandbox_http2(&mut stream, move |_, request, respond| {
                let request_ok = Arc::clone(&route_request_ok);
                let sent = Arc::clone(&route_sent);
                let complete = Arc::clone(&route_complete);
                let handler_failed = Arc::clone(&route_handler_failed);
                async move {
                    handle_request(request, respond, request_ok, sent, complete, handler_failed)
                        .await;
                }
            })
            .await
            .map_err(|_| ())
        });

        let scenario = async {
            next_signal(&mut signals, |signal| matches!(signal, PeerSignal::Paused)).await?;
            let blocked = observe_bounded_producer_plateau(&sent, &complete).await;
            let result = next_signal(&mut signals, |signal| {
                matches!(signal, PeerSignal::Result { .. })
            })
            .await?;
            let PeerSignal::Result { bytes, sha256 } = result else {
                unreachable!();
            };
            next_signal(&mut signals, |signal| matches!(signal, PeerSignal::Exit)).await?;
            timeout(Duration::from_secs(2), peer.as_mut().expect("peer present"))
                .await
                .map_err(|_| ProbeFailure::new("peer", FailureOutcome::Timeout))?
                .map_err(|_| ProbeFailure::new("peer", FailureOutcome::Error))?
                .map_err(|_| ProbeFailure::new("peer", FailureOutcome::Error))?;
            peer.take();
            let expected = format!(
                "{:x}",
                Sha256::digest(deterministic_bytes(RESPONSE_BYTES, 17, 11))
            );
            Ok(ForwardObservation {
                request_integrity: request_ok.load(Ordering::SeqCst),
                paused: true,
                backpressure: blocked,
                resumed: complete.load(Ordering::SeqCst),
                response_integrity: bytes == RESPONSE_BYTES
                    && sha256 == expected
                    && !handler_failed.load(Ordering::SeqCst),
            })
        }
        .await;
        route.abort();
        let _ = route.await;
        scenario
    }
    .await;
    abort_peer(&mut peer).await;
    let revoked = grpc
        .revoke_ssh_session(RevokeSshSessionRequest { token })
        .await
        .is_ok();
    match (result, revoked) {
        (Err(primary), false) => {
            eprintln!("stage=forward-auth outcome=cleanup-failed");
            Err(primary)
        }
        (Ok(_), false) => Err(ProbeFailure::new(
            "forward-auth",
            FailureOutcome::CleanupFailed,
        )),
        (result, true) => {
            println!("stage=forward-auth outcome=pass authorizationRevoked=observed");
            result
        }
    }
}

async fn cleanup_sandbox(
    client: &OpenShellClient,
    name: &str,
    expected_id: Option<&str>,
) -> Result<(), ProbeFailure> {
    let owned = client
        .list_sandboxes(ListOptions {
            label_selector: Some(format!("openkit-upgrade-probe={name}")),
            ..ListOptions::default()
        })
        .await
        .map_err(|_| ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed))?;
    match owned.as_slice() {
        [] => {}
        [sandbox]
            if sandbox.name == name
                && expected_id.is_none_or(|expected| sandbox.id == expected) =>
        {
            client
                .delete_sandbox(name)
                .await
                .map_err(|_| ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed))?;
            client
                .wait_deleted(name, Duration::from_secs(120))
                .await
                .map_err(|_| ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed))?;
        }
        _ => {
            return Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed));
        }
    }
    let remaining = client
        .list_sandboxes(ListOptions::default())
        .await
        .map_err(|_| ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed))?;
    if !remaining.is_empty() {
        return Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed));
    }
    Ok(())
}

async fn run_live(values: BTreeMap<String, String>) -> Result<(), ProbeFailure> {
    let inputs = parse_inputs(&values)?;
    let release = release()?;
    let fixture_files = [
        inputs.gateway_binary.clone(),
        inputs.gateway_config.clone(),
        inputs.tls_dir.join("ca.crt"),
        inputs.tls_dir.join("client/tls.crt"),
        inputs.tls_dir.join("client/tls.key"),
    ];
    if !inputs.tls_dir.is_dir()
        || fixture_files
            .iter()
            .any(|path| !fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
    {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    if file_sha256(&inputs.gateway_binary)? != release.gateway_sha256
        || configured_supervisor(&inputs.gateway_config)? != release.supervisor_image
    {
        return Err(ProbeFailure::new(
            "prerequisites",
            FailureOutcome::Prerequisite,
        ));
    }
    println!(
        "stage=prerequisites outcome=pass gatewayBinary=observed supervisorConfig=observed sandboxImage=premise"
    );
    let client = connect(&inputs).await?;
    let health = client
        .health()
        .await
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Error))?;
    let initial = client
        .list_sandboxes(ListOptions::default())
        .await
        .map_err(|_| ProbeFailure::new("gateway", FailureOutcome::Error))?;
    if health.status != ServiceStatus::Healthy
        || health.version != release.version
        || !initial.is_empty()
    {
        return Err(ProbeFailure::new("gateway", FailureOutcome::Prerequisite));
    }
    println!(
        "stage=gateway outcome=pass tls=observed healthVersion=observed initialEmpty=observed"
    );

    let name = unique_sandbox_name();
    let SandboxCreation {
        result: creation,
        expected_id,
        cleanup_fenced,
    } = create_sandbox(&client, &name, &inputs.sandbox_image).await;
    let attempt = observe_sandbox_attempt(
        async {
            match creation {
                Ok(sandbox_id) => run_forward_slice(&client, &sandbox_id).await,
                Err(failure) => Err(failure),
            }
        },
        cleanup_sandbox(&client, &name, expected_id.as_deref()),
        cleanup_fenced,
    )
    .await;
    if attempt.forward.is_ok() {
        println!(
            "stage=forward outcome=pass requestIntegrity=observed paused=observed backpressure=observed resumed=observed responseIntegrity=observed"
        );
    }
    match attempt.cleanup {
        Ok(()) if attempt.cleanup_fenced => {
            println!("stage=cleanup outcome=pass sandboxAbsent=observed finalEmpty=observed");
        }
        Ok(()) => {
            eprintln!("stage=cleanup outcome=cleanup-failed");
            attempt.forward?;
            return Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed));
        }
        Err(cleanup_failure) => {
            if let Err(primary) = attempt.forward {
                eprintln!("{primary}");
            }
            return Err(cleanup_failure);
        }
    }
    evaluate_attempt(&attempt)?;
    println!(
        "outcome=observed scope=stock-forwarding-diagnostic admission=unadmitted qualification=not-evaluated release={} commit={}",
        release.version, release.commit
    );
    Ok(())
}

#[tokio::test]
#[ignore = "unadmitted diagnostic requiring an isolated stock OpenShell fixture"]
async fn openshell_upgrade_live() {
    let values = [
        LIVE_FLAG,
        GATEWAY_URL,
        TLS_DIR,
        GATEWAY_BINARY,
        GATEWAY_CONFIG,
        SANDBOX_IMAGE,
    ]
    .into_iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| (name.to_string(), value))
    })
    .collect();
    if let Err(failure) = run_live(values).await {
        panic!("{failure}");
    }
}

#[test]
fn openshell_upgrade_driver_rejects_missing_opt_in_before_auth_inputs() {
    let mut values = BTreeMap::from([
        (LIVE_FLAG.to_string(), "1".to_string()),
        (GATEWAY_URL.to_string(), FIXTURE_URL.to_string()),
        (TLS_DIR.to_string(), "/fixture/tls".to_string()),
        (
            GATEWAY_BINARY.to_string(),
            "/fixture/openshell-gateway".to_string(),
        ),
        (
            GATEWAY_CONFIG.to_string(),
            "/fixture/gateway.toml".to_string(),
        ),
        (
            SANDBOX_IMAGE.to_string(),
            format!("example.invalid/worker@sha256:{}", "a".repeat(64)),
        ),
    ]);
    assert!(parse_inputs(&values).is_ok());
    values.remove(LIVE_FLAG);
    assert_eq!(
        parse_inputs(&values).expect_err("missing explicit opt-in must fail"),
        ProbeFailure::new("prerequisites", FailureOutcome::Prerequisite)
    );
}

#[tokio::test]
async fn openshell_upgrade_driver_observes_success_error_and_timeout() {
    assert_eq!(
        observe("self-check", Duration::from_secs(1), async {
            Ok::<_, ()>(7)
        })
        .await,
        Ok(7)
    );
    assert_eq!(
        observe("self-check", Duration::from_secs(1), async {
            Err::<(), _>(())
        })
        .await,
        Err(ProbeFailure::new("self-check", FailureOutcome::Error))
    );
    assert_eq!(
        observe("self-check", Duration::from_millis(1), async {
            std::future::pending::<Result<(), ()>>().await
        })
        .await,
        Err(ProbeFailure::new("self-check", FailureOutcome::Timeout))
    );

    let passing = || ForwardObservation {
        request_integrity: true,
        paused: true,
        backpressure: true,
        resumed: true,
        response_integrity: true,
    };
    let success = observe_sandbox_attempt(async { Ok(passing()) }, async { Ok(()) }, true).await;
    assert_eq!(evaluate_attempt(&success), Ok(()));

    let failure = observe_sandbox_attempt(
        async { Err(ProbeFailure::new("forward", FailureOutcome::Incompatible)) },
        async { Ok(()) },
        true,
    )
    .await;
    assert_eq!(
        evaluate_attempt(&failure),
        Err(ProbeFailure::new("forward", FailureOutcome::Incompatible))
    );

    let timed_out = observe_sandbox_attempt(
        async {
            let _: () = observe("forward", Duration::from_millis(1), async {
                std::future::pending::<Result<(), ()>>().await
            })
            .await?;
            Ok(passing())
        },
        async { Ok(()) },
        true,
    )
    .await;
    assert_eq!(
        evaluate_attempt(&timed_out),
        Err(ProbeFailure::new("forward", FailureOutcome::Timeout))
    );

    let cleanup_failed = observe_sandbox_attempt(
        async { Ok(passing()) },
        async { Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed)) },
        true,
    )
    .await;
    assert_eq!(
        evaluate_attempt(&cleanup_failed),
        Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed))
    );

    let unfenced = observe_sandbox_attempt(async { Ok(passing()) }, async { Ok(()) }, false).await;
    assert_eq!(
        evaluate_attempt(&unfenced),
        Err(ProbeFailure::new("cleanup", FailureOutcome::CleanupFailed))
    );
}

#[test]
fn openshell_upgrade_driver_rejects_incomplete_observation() {
    let mut observation = ForwardObservation {
        request_integrity: true,
        paused: true,
        backpressure: true,
        resumed: true,
        response_integrity: true,
    };
    assert_eq!(evaluate(&observation), Ok(()));
    observation.backpressure = false;
    assert_eq!(
        evaluate(&observation),
        Err(ProbeFailure::new("forward", FailureOutcome::Incompatible))
    );
}

#[test]
fn openshell_upgrade_peer_output_accepts_arbitrary_event_splits() {
    let line = format!("READY\nPAUSED\nRESULT 4194304 {}\nEXIT 0\n", "a".repeat(64));
    for split in 0..=line.len() {
        let mut output = PeerOutput::default();
        let mut signals = output.push(&line.as_bytes()[..split]).expect("first split");
        signals.extend(
            output
                .push(&line.as_bytes()[split..])
                .expect("second split"),
        );
        assert_eq!(
            signals,
            [
                PeerSignal::Ready,
                PeerSignal::Paused,
                PeerSignal::Result {
                    bytes: RESPONSE_BYTES,
                    sha256: "a".repeat(64),
                },
                PeerSignal::Exit,
            ],
            "split {split}"
        );
        assert!(output.buffered.is_empty());
    }
}
