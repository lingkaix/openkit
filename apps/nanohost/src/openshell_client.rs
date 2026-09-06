//! Typed OpenShell SDK lifecycle owner.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::net::TcpStream;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use hyper_util::rt::TokioIo;
use openshell_sdk::raw::proto::{
    CreateSandboxRequest, CreateSshSessionRequest, ExecSandboxEvent, ExecSandboxInput,
    ExecSandboxRequest, GpuResourceRequirements, ResourceRequirements, RevokeSshSessionRequest,
    SandboxPolicy, SandboxSpec as RawSandboxSpec, SandboxTemplate, TcpForwardFrame, TcpForwardInit,
    TcpRelayTarget, exec_sandbox_event, exec_sandbox_input, tcp_forward_frame, tcp_forward_init,
};
use openshell_sdk::{
    EdgeAuthInterceptor, ListOptions, OpenShellClient, SandboxPhase, SandboxRef, SandboxSpec,
    ServiceStatus,
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity};
use tower::service_fn;

use crate::epoch_coordinator::{CreateCertaintyLossPoint, CreateUncertainty, EpochFault};
use crate::nanocore_session::OuterRouteProjection;
use crate::openshell_release;
use crate::sandbox_bridge::{
    BRIDGE_REESTABLISH_HARD_BOUND, FORWARD_FRAME_CHANNEL_CAPACITY, OpenSandboxBridge,
    SANDBOX_INTEGRATION_TARGET, TcpForwardByteStream, serve_sandbox_http2,
};

/// Maximum bytes in one file-transfer input chunk or output event.
const FILE_EFFECT_CHUNK_BYTES: usize = 64 * 1024;

/// Maximum aggregate bytes moved by one V1 file effect.
const FILE_EFFECT_MAX_BYTES: usize = 256 * 1024 * 1024;

/// Exact value-free worker-entry evidence accepted before bridge establishment.
const WORKER_ENTRY_MARKER: &[u8] = b"OPENKIT_WORKER_SHIM_ENTRY_V1\n";

/// Fixed first delay for typed Sandbox Ready observations.
const READY_POLL_INITIAL_DELAY: Duration = Duration::from_millis(250);

/// Fixed maximum delay between typed Sandbox Ready observations.
const READY_POLL_MAX_DELAY: Duration = Duration::from_secs(2);

/// Fixed Sandbox Ready deadline retained from the pinned SDK behavior.
const READY_POLL_TIMEOUT: Duration = Duration::from_secs(120);

/// Bounded internal result of classifying one typed Ready observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadinessFailure {
    /// The observation lost certainty at one closed point.
    Uncertain(CreateCertaintyLossPoint),
    /// A Ready identity differed from the accepted create identity.
    IdentityMismatch,
}

/// Classifies one typed Ready observation without retaining SDK diagnostics.
fn classify_ready_observation(
    observation: Result<(SandboxPhase, &str, &str), ()>,
    accepted_id: &str,
    accepted_name: &str,
    deadline_reached: bool,
) -> Result<bool, ReadinessFailure> {
    let (phase, observed_id, observed_name) = observation.map_err(|()| {
        ReadinessFailure::Uncertain(CreateCertaintyLossPoint::ReadyObservationUnproved)
    })?;
    match phase {
        SandboxPhase::Ready if observed_id != accepted_id || observed_name != accepted_name => {
            Err(ReadinessFailure::IdentityMismatch)
        }
        SandboxPhase::Ready => Ok(true),
        SandboxPhase::Error => Err(ReadinessFailure::Uncertain(
            CreateCertaintyLossPoint::ReadyErrorPhase,
        )),
        _ if deadline_reached => Err(ReadinessFailure::Uncertain(
            CreateCertaintyLossPoint::ReadyTimeout,
        )),
        _ => Ok(false),
    }
}

/// Linux `CLONE_NEWNET` flag used by the Gateway connector thread.
const CLONE_NEWNET: i32 = 0x4000_0000;

#[cfg(target_os = "linux")]
unsafe extern "C" {
    #[link_name = "setns"]
    fn linux_setns(fd: i32, namespace_type: i32) -> i32;
}

/// Calls Linux `setns`, or fails closed on unsupported build hosts.
unsafe fn setns(fd: i32, namespace_type: i32) -> i32 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the caller owns the retained descriptor and namespace type.
        unsafe { linux_setns(fd, namespace_type) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (fd, namespace_type);
        -1
    }
}

/// The compiled stock OpenShell SDK client used for typed lifecycle calls.
#[cfg_attr(not(test), allow(dead_code))]
pub type CompiledOpenShellClient = OpenShellClient;

/// Marks the stock SDK client as NanoHost's typed lifecycle client boundary.
#[cfg_attr(not(test), allow(dead_code))]
pub trait TypedOpenShellLifecycleClient {}

/// Selects the stock SDK client as the typed NanoHost lifecycle client.
impl TypedOpenShellLifecycleClient for OpenShellClient {}

/// Closed OpenShell lifecycle effects admitted from the authoritative session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum LifecycleEffectKind {
    /// Creates one already-authorized sandbox.
    CreateSandbox,
    /// Deletes one already-authorized sandbox.
    DeleteSandbox,
    /// Opens the fixed Sandbox Integration bridge.
    OpenBridge,
    /// Closes the current Sandbox Integration bridge.
    CloseBridge,
}

#[cfg_attr(not(test), allow(dead_code))]
impl LifecycleEffectKind {
    /// Parses the exact lifecycle effect vocabulary.
    ///
    /// # Errors
    ///
    /// Rejects shell, proxy, arbitrary OpenShell, and every unknown operation.
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "sandbox.create" => Ok(Self::CreateSandbox),
            "sandbox.delete" => Ok(Self::DeleteSandbox),
            "bridge.open" => Ok(Self::OpenBridge),
            "bridge.close" => Ok(Self::CloseBridge),
            _ => Err("lifecycle effect rejected"),
        }
    }
}

/// Exact request, operation authority, and sandbox identity for one lifecycle effect.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct LifecycleEffectRequest {
    request_id: String,
    authority_id: String,
    sandbox_id: String,
    kind: LifecycleEffectKind,
}

#[cfg_attr(not(test), allow(dead_code))]
impl LifecycleEffectRequest {
    /// Creates one lifecycle request for later fail-closed validation.
    pub fn new(
        request_id: &str,
        authority_id: &str,
        sandbox_id: &str,
        kind: LifecycleEffectKind,
    ) -> Self {
        Self {
            request_id: request_id.to_string(),
            authority_id: authority_id.to_string(),
            sandbox_id: sandbox_id.to_string(),
            kind,
        }
    }

    /// Validates the non-empty identity tuple carried by this request.
    ///
    /// # Errors
    ///
    /// Rejects empty or control-bearing request, authority, and sandbox identities.
    pub fn validate(&self) -> Result<(), &'static str> {
        if [&self.request_id, &self.authority_id, &self.sandbox_id]
            .iter()
            .any(|value| value.is_empty() || value.contains(['\r', '\n', '\0']))
        {
            return Err("lifecycle effect identity rejected");
        }
        Ok(())
    }

    /// Verifies that one result belongs to the exact request and sandbox.
    ///
    /// # Errors
    ///
    /// Rejects malformed input or a request/sandbox identity mismatch.
    pub fn validate_result_identity(
        &self,
        request_id: &str,
        sandbox_id: &str,
    ) -> Result<(), &'static str> {
        self.validate()?;
        if self.request_id != request_id || self.sandbox_id != sandbox_id {
            return Err("lifecycle result identity mismatch");
        }
        Ok(())
    }

    /// Returns the exact request identity.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the exact sandbox identity.
    pub fn sandbox_id(&self) -> &str {
        &self.sandbox_id
    }

    /// Returns the closed lifecycle operation selected by the fixed request path.
    pub fn kind(&self) -> LifecycleEffectKind {
        self.kind
    }
}

/// Direct result of one existing OpenShell lifecycle owner.
#[allow(dead_code)]
pub enum LifecycleEffectResult {
    /// Exact created sandbox identity returned by OpenShell.
    SandboxCreated(SandboxRef),
    /// Definite sandbox deletion and terminal absence.
    SandboxDeleted,
    /// Live fixed-target bridge and independent worker response monitor.
    BridgeOpened {
        /// Bridge retained for nested HTTP/2 serving.
        bridge: OpenSandboxBridge,
        /// Bootstrap response monitor retained through worker execution.
        exec_monitor: WorkerBootstrapMonitor,
    },
    /// Definite bridge close and authorization revocation.
    BridgeClosed,
}

/// Clean terminal output from one fixed raw interactive sandbox command.
pub struct ExecSandboxInteractiveResult {
    /// Bounded stdout bytes emitted before the terminal event.
    pub stdout: Vec<u8>,
    /// The single proved zero exit status.
    pub exit_status: i32,
}

/// Exact static input for the fixed Harness-bootstrap Start.
pub struct WorkerBootstrapRequest {
    /// Current ready sandbox identity.
    pub sandbox_id: String,
    /// Current request lineage value.
    pub request_id: String,
    /// Static non-secret Harness binding retained only by NanoHost bridge context.
    pub sandbox_integration_binding_ref: String,
}

impl WorkerBootstrapRequest {
    /// Validates the closed static bootstrap lineage.
    ///
    /// # Errors
    ///
    /// Rejects missing, oversized, or control-bearing bootstrap lineage.
    fn validate(&self) -> Result<(), EpochFault> {
        let lineage_valid = [
            &self.sandbox_id,
            &self.request_id,
            &self.sandbox_integration_binding_ref,
        ]
        .iter()
        .all(|value| {
            !value.is_empty()
                && value.len() <= 512
                && !value.contains(['\r', '\n', '\0'])
                && !value.chars().any(char::is_control)
        });
        if !lineage_valid {
            return Err(EpochFault::IdentityMismatch);
        }
        Ok(())
    }
}

/// Retained independent response task for the fixed worker bootstrap.
pub struct WorkerBootstrapMonitor {
    response: JoinHandle<Result<WorkerBootstrapCompletion, EpochFault>>,
}

impl WorkerBootstrapMonitor {
    /// Returns whether the independent response stream remains live.
    pub fn is_live(&self) -> bool {
        !self.response.is_finished()
    }

    /// Stops the process-local response task after exact Sandbox absence fenced its worker.
    pub fn discard_after_sandbox_deletion(self) {
        self.response.abort();
    }
}

/// Exact local terminal facts produced by one clean bootstrap response monitor.
#[cfg_attr(not(test), allow(dead_code))]
pub struct WorkerBootstrapCompletion {
    /// True only after exactly one correlated Exit event.
    pub monitor_exit: bool,
    /// True only when the response ended cleanly after that Exit.
    pub clean_response: bool,
    /// Native shim exit status carried by the single Exit event.
    pub exit_status: i32,
}

/// Owns one supported-release SDK connection and its fail-stop lifecycle mapping.
pub struct NanoHostOpenShellClient {
    endpoint: String,
    auth_path: PathBuf,
    network_namespace: Option<Arc<OwnedFd>>,
    client: Option<OpenShellClient>,
}

#[allow(dead_code)]
impl NanoHostOpenShellClient {
    /// Describes the epoch-local Gateway connection before it becomes ready.
    pub fn new(endpoint: String, auth_path: PathBuf) -> Self {
        Self {
            endpoint,
            auth_path,
            network_namespace: None,
            client: None,
        }
    }

    /// Binds the sole retained Runtime Epoch network namespace before connect.
    ///
    /// # Errors
    ///
    /// Returns an identity fault if a namespace was already bound.
    pub fn bind_network_namespace(
        &mut self,
        namespace_descriptor: Arc<OwnedFd>,
    ) -> Result<(), EpochFault> {
        if self
            .network_namespace
            .replace(namespace_descriptor)
            .is_some()
        {
            return Err(EpochFault::IdentityMismatch);
        }
        Ok(())
    }

    /// Connects the stock SDK through the epoch-local generated CA.
    ///
    /// # Errors
    ///
    /// Returns [`EpochFault::PartialStart`] when the CA or channel is unavailable.
    pub async fn connect(&mut self) -> Result<(), EpochFault> {
        let namespace_descriptor = Arc::clone(
            self.network_namespace
                .as_ref()
                .ok_or(EpochFault::PartialStart)?,
        );
        let ca = fs::read(self.auth_path.join("ca.crt")).map_err(|_| EpochFault::PartialStart)?;
        let cert = fs::read(self.auth_path.join("client/tls.crt"))
            .map_err(|_| EpochFault::PartialStart)?;
        let key = fs::read(self.auth_path.join("client/tls.key"))
            .map_err(|_| EpochFault::PartialStart)?;
        let tls = ClientTlsConfig::new()
            .domain_name("127.0.0.1")
            .ca_certificate(Certificate::from_pem(ca))
            .identity(Identity::from_pem(cert, key));
        let endpoint = Endpoint::from_shared(self.endpoint.clone())
            .map_err(|_| EpochFault::PartialStart)?
            .tls_config(tls)
            .map_err(|_| EpochFault::PartialStart)?
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120));
        let connector = service_fn(move |uri: http::Uri| {
            let namespace_descriptor = Arc::clone(&namespace_descriptor);
            async move {
                let host = uri
                    .host()
                    .filter(|host| *host == "127.0.0.1")
                    .ok_or_else(|| io::Error::other("Gateway connector host rejected"))?
                    .to_string();
                let port = uri
                    .port_u16()
                    .filter(|port| *port == 17670)
                    .ok_or_else(|| io::Error::other("Gateway connector port rejected"))?;
                let worker = thread::spawn(move || {
                    // SAFETY: this dedicated connector thread changes only its
                    // own namespace and terminates after producing one socket.
                    if unsafe { setns(namespace_descriptor.as_raw_fd(), CLONE_NEWNET) } != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let stream = TcpStream::connect((host.as_str(), port))?;
                    stream.set_nonblocking(true)?;
                    Ok(stream)
                });
                let stream = worker
                    .join()
                    .map_err(|_| io::Error::other("Gateway connector thread panicked"))??;
                tokio::net::TcpStream::from_std(stream).map(TokioIo::new)
            }
        });
        let channel: Channel = endpoint
            .connect_with_connector(connector)
            .await
            .map_err(|_| EpochFault::PartialStart)?;
        self.client = Some(OpenShellClient::from_parts(
            channel,
            EdgeAuthInterceptor::noop(),
        ));
        Ok(())
    }

    /// Proves the connected Gateway is healthy and matches the supported release.
    ///
    /// # Errors
    ///
    /// Returns an epoch-invalidating fault for unavailable or mismatched identity.
    pub async fn health(&self) -> Result<(), EpochFault> {
        let health = self
            .connected()?
            .health()
            .await
            .map_err(|_| EpochFault::PartialStart)?;
        if Some(health.version.as_str()) != openshell_release::version().as_deref() {
            return Err(EpochFault::IdentityMismatch);
        }
        if health.status != ServiceStatus::Healthy {
            return Err(EpochFault::PartialStart);
        }
        Ok(())
    }

    /// Creates one sandbox and rejects a returned identity mismatch.
    ///
    /// # Errors
    ///
    /// Returns one bounded create certainty-loss point, or identity mismatch
    /// when the accepted sandbox does not match the requested name.
    pub async fn create_sandbox(
        &self,
        spec: SandboxSpec,
        policy: SandboxPolicy,
        attempt_lineage: &str,
    ) -> Result<SandboxRef, EpochFault> {
        let started = Instant::now();
        let expected_name = spec
            .name
            .as_deref()
            .filter(|name| !name.is_empty())
            .ok_or(EpochFault::IdentityMismatch)?
            .to_string();
        if attempt_lineage.is_empty() {
            return Err(EpochFault::IdentityMismatch);
        }
        let uncertain = |certainty_loss| {
            EpochFault::CreateOutcomeUncertain(CreateUncertainty::new(
                certainty_loss,
                &expected_name,
                attempt_lineage,
                started.elapsed(),
            ))
        };
        let client = self.connected()?;
        let request = CreateSandboxRequest {
            spec: Some(RawSandboxSpec {
                environment: spec.environment,
                template: spec.image.map(|image| SandboxTemplate {
                    image,
                    ..SandboxTemplate::default()
                }),
                policy: Some(policy),
                providers: spec.providers,
                resource_requirements: spec.gpu.then_some(ResourceRequirements {
                    gpu: Some(GpuResourceRequirements { count: None }),
                }),
                ..RawSandboxSpec::default()
            }),
            name: expected_name.clone(),
            labels: spec.labels,
            annotations: HashMap::new(),
            workspace: String::new(),
        };
        let sandbox = client
            .raw_grpc()
            .create_sandbox(request)
            .await
            .map_err(|_| uncertain(CreateCertaintyLossPoint::CreateRequestUnproved))?
            .into_inner()
            .sandbox
            .and_then(|sandbox| sandbox.metadata)
            .ok_or_else(|| uncertain(CreateCertaintyLossPoint::CreateResponseInvalid))?;
        if sandbox.id.is_empty() || sandbox.name.is_empty() {
            return Err(uncertain(CreateCertaintyLossPoint::CreateResponseInvalid));
        }
        if expected_name != sandbox.name {
            return Err(EpochFault::IdentityMismatch);
        }
        let deadline = Instant::now() + READY_POLL_TIMEOUT;
        let mut delay = READY_POLL_INITIAL_DELAY;
        loop {
            let observation = client.get_sandbox(&sandbox.name).await;
            let classified = classify_ready_observation(
                observation
                    .as_ref()
                    .map(|ready| (ready.phase, ready.id.as_str(), ready.name.as_str()))
                    .map_err(|_| ()),
                &sandbox.id,
                &sandbox.name,
                Instant::now() >= deadline,
            );
            match classified {
                Ok(true) => {
                    return observation.map_err(|_| {
                        uncertain(CreateCertaintyLossPoint::ReadyObservationUnproved)
                    });
                }
                Ok(false) => tokio::time::sleep(delay).await,
                Err(ReadinessFailure::Uncertain(point)) => return Err(uncertain(point)),
                Err(ReadinessFailure::IdentityMismatch) => {
                    return Err(EpochFault::IdentityMismatch);
                }
            }
            delay = (delay * 2).min(READY_POLL_MAX_DELAY);
        }
    }

    /// Gets one sandbox and verifies the returned name.
    ///
    /// # Errors
    ///
    /// Returns an epoch-invalidating fault when the request fails or identity differs.
    pub async fn get_sandbox(&self, name: &str) -> Result<SandboxRef, EpochFault> {
        let sandbox = self
            .connected()?
            .get_sandbox(name)
            .await
            .map_err(|_| EpochFault::MemberExited)?;
        if sandbox.id.is_empty() || sandbox.name != name {
            return Err(EpochFault::IdentityMismatch);
        }
        Ok(sandbox)
    }

    /// Lists sandboxes through the typed SDK and validates returned identities.
    ///
    /// # Errors
    ///
    /// Returns an epoch-invalidating fault for transport or identity failure.
    pub async fn list_sandboxes(
        &self,
        options: ListOptions,
    ) -> Result<Vec<SandboxRef>, EpochFault> {
        let sandboxes = self
            .connected()?
            .list_sandboxes(options)
            .await
            .map_err(|_| EpochFault::MemberExited)?;
        if sandboxes
            .iter()
            .any(|sandbox| sandbox.id.is_empty() || sandbox.name.is_empty())
        {
            return Err(EpochFault::IdentityMismatch);
        }
        Ok(sandboxes)
    }

    /// Deletes one sandbox and waits for terminal absence.
    ///
    /// # Errors
    ///
    /// Returns delete uncertainty unless both acknowledgement and terminal
    /// absence are proved by the typed SDK.
    pub async fn delete_sandbox(&self, name: &str, timeout: Duration) -> Result<(), EpochFault> {
        self.connected()?
            .delete_sandbox(name)
            .await
            .map_err(|_| EpochFault::DeleteOutcomeUncertain)?;
        self.wait_deleted(name, timeout).await
    }

    /// Waits until the typed SDK proves terminal sandbox absence.
    ///
    /// # Errors
    ///
    /// Returns delete uncertainty when terminal absence is not proved.
    pub async fn wait_deleted(&self, name: &str, timeout: Duration) -> Result<(), EpochFault> {
        self.connected()?
            .wait_deleted(name, timeout)
            .await
            .map_err(|_| EpochFault::DeleteOutcomeUncertain)
    }

    /// Opens the one stock forward pair for a sandbox's fixed Integration target.
    ///
    /// The same connected SDK client first issues short-lived target authorization,
    /// then opens exactly one `ForwardTcp` stream. No target input is accepted.
    ///
    /// # Errors
    ///
    /// Returns an epoch-invalidating fault when authorization, identity validation,
    /// initialization, or the stock forward RPC fails.
    pub async fn open_sandbox_bridge(
        &self,
        sandbox_id: &str,
        sandbox_integration_binding_ref: String,
        route_projection: OuterRouteProjection,
    ) -> Result<OpenSandboxBridge, EpochFault> {
        let client = self.connected()?;
        let mut grpc = client.raw_grpc();
        let session = grpc
            .create_ssh_session(CreateSshSessionRequest {
                sandbox_id: sandbox_id.to_string(),
            })
            .await
            .map_err(|_| EpochFault::MemberExited)?
            .into_inner();
        if session.token.is_empty() || session.sandbox_id != sandbox_id {
            return Err(EpochFault::IdentityMismatch);
        }

        let (host, port) = SANDBOX_INTEGRATION_TARGET
            .split_once(':')
            .ok_or(EpochFault::IdentityMismatch)?;
        let port = port
            .parse::<u32>()
            .map_err(|_| EpochFault::IdentityMismatch)?;
        let deadline = tokio::time::Instant::now() + BRIDGE_REESTABLISH_HARD_BOUND;
        loop {
            let (outbound, outbound_rx) = mpsc::channel(FORWARD_FRAME_CHANNEL_CAPACITY);
            let forward = grpc.forward_tcp(ReceiverStream::new(outbound_rx));
            if outbound
                .send(TcpForwardFrame {
                    payload: Some(tcp_forward_frame::Payload::Init(TcpForwardInit {
                        sandbox_id: sandbox_id.to_string(),
                        service_id: "openkit-sandbox-integration".to_string(),
                        target: Some(tcp_forward_init::Target::Tcp(TcpRelayTarget {
                            host: host.to_string(),
                            port,
                        })),
                        authorization_token: session.token.clone(),
                    })),
                })
                .await
                .is_err()
            {
                drop(forward);
                let _ = grpc
                    .revoke_ssh_session(RevokeSshSessionRequest {
                        token: session.token,
                    })
                    .await;
                return Err(EpochFault::MemberExited);
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let response = match timeout(remaining, forward).await {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => {
                    if timeout(
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                        tokio::time::sleep(Duration::from_millis(50)),
                    )
                    .await
                    .is_err()
                    {
                        let _ = grpc
                            .revoke_ssh_session(RevokeSshSessionRequest {
                                token: session.token,
                            })
                            .await;
                        return Err(EpochFault::MemberExited);
                    }
                    continue;
                }
                Err(_) => {
                    let _ = grpc
                        .revoke_ssh_session(RevokeSshSessionRequest {
                            token: session.token,
                        })
                        .await;
                    return Err(EpochFault::MemberExited);
                }
            };

            let mut stream = TcpForwardByteStream::from_grpc(response.into_inner(), outbound);
            let (harness_ready, mut harness_ready_rx) = mpsc::channel(1);
            let projection = route_projection.clone();
            let route_sandbox_integration_binding_ref = sandbox_integration_binding_ref.clone();
            let mut route_server = tokio::spawn(async move {
                let _ = serve_sandbox_http2(&mut stream, move |family, request, respond| {
                    let projection = projection.clone();
                    let harness_ready = harness_ready.clone();
                    let sandbox_integration_binding_ref =
                        route_sandbox_integration_binding_ref.clone();
                    async move {
                        if projection
                            .forward(family, request, respond, &sandbox_integration_binding_ref)
                            .await
                            == Ok(true)
                        {
                            let _ = harness_ready.try_send(());
                        }
                    }
                })
                .await;
            });
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let mut route_server_finished = false;
            let deadline_reached = tokio::select! {
                readiness = harness_ready_rx.recv() => {
                    if readiness.is_some() && !route_server.is_finished() {
                        return Ok(OpenSandboxBridge::new(
                            route_server,
                            session.token,
                            sandbox_integration_binding_ref,
                            true,
                        ));
                    }
                    false
                }
                _ = &mut route_server => {
                    route_server_finished = true;
                    false
                },
                _ = tokio::time::sleep(remaining) => true,
            };
            if !route_server_finished {
                route_server.abort();
                let _ = route_server.await;
            }
            if !deadline_reached {
                if timeout(
                    deadline.saturating_duration_since(tokio::time::Instant::now()),
                    tokio::time::sleep(Duration::from_millis(50)),
                )
                .await
                .is_err()
                {
                    let _ = grpc
                        .revoke_ssh_session(RevokeSshSessionRequest {
                            token: session.token,
                        })
                        .await;
                    return Err(EpochFault::MemberExited);
                }
                continue;
            }
            let _ = grpc
                .revoke_ssh_session(RevokeSshSessionRequest {
                    token: session.token,
                })
                .await;
            return Err(EpochFault::MemberExited);
        }
    }

    /// Closes one bridge and revokes or discards its short-lived authorization.
    ///
    /// # Errors
    ///
    /// Returns an epoch-invalidating fault when the connected Gateway does not
    /// accept the revocation request.
    pub async fn close_sandbox_bridge(&self, bridge: OpenSandboxBridge) -> Result<(), EpochFault> {
        let token = bridge.into_close_parts();
        self.connected()?
            .raw_grpc()
            .revoke_ssh_session(RevokeSshSessionRequest { token })
            .await
            .map_err(|_| EpochFault::MemberExited)?;
        Ok(())
    }

    /// Dispatches one closed lifecycle effect through the existing direct owners.
    ///
    /// `create` is required only for `sandbox.create`; `bridge` is required
    /// only for `bridge.close`. The method remains uncomposed until the final cutover.
    ///
    /// # Errors
    ///
    /// Returns an identity fault for malformed or mismatched input and otherwise
    /// preserves the existing lifecycle owner's fail-stop error.
    pub async fn execute_lifecycle_effect(
        &self,
        request: &LifecycleEffectRequest,
        create: Option<(SandboxSpec, SandboxPolicy)>,
        bridge: Option<OpenSandboxBridge>,
        worker_bootstrap: Option<WorkerBootstrapRequest>,
        route_projection: Option<OuterRouteProjection>,
        deletion_timeout: Duration,
    ) -> Result<LifecycleEffectResult, EpochFault> {
        request
            .validate()
            .map_err(|_| EpochFault::IdentityMismatch)?;
        if request.kind != LifecycleEffectKind::OpenBridge
            && (worker_bootstrap.is_some() || route_projection.is_some())
        {
            return Err(EpochFault::IdentityMismatch);
        }
        if request.kind != LifecycleEffectKind::CreateSandbox && create.is_some() {
            return Err(EpochFault::IdentityMismatch);
        }
        match request.kind {
            LifecycleEffectKind::CreateSandbox => {
                let (spec, policy) = create.ok_or(EpochFault::IdentityMismatch)?;
                if spec.name.as_deref() != Some(request.sandbox_id()) {
                    return Err(EpochFault::IdentityMismatch);
                }
                let sandbox = self
                    .create_sandbox(spec, policy, request.request_id())
                    .await?;
                request
                    .validate_result_identity(request.request_id(), &sandbox.name)
                    .map_err(|_| EpochFault::IdentityMismatch)?;
                Ok(LifecycleEffectResult::SandboxCreated(sandbox))
            }
            LifecycleEffectKind::DeleteSandbox => {
                self.delete_sandbox(request.sandbox_id(), deletion_timeout)
                    .await?;
                Ok(LifecycleEffectResult::SandboxDeleted)
            }
            LifecycleEffectKind::OpenBridge => {
                let worker_bootstrap = worker_bootstrap.ok_or(EpochFault::IdentityMismatch)?;
                let route_projection = route_projection.ok_or(EpochFault::IdentityMismatch)?;
                let sandbox_id = worker_bootstrap.sandbox_id.clone();
                let sandbox_integration_binding_ref =
                    worker_bootstrap.sandbox_integration_binding_ref.clone();
                let mut exec_monitor = self.exec_sandbox_worker_bootstrap(worker_bootstrap).await?;
                let bridge = tokio::select! {
                    bridge = self.open_sandbox_bridge(
                        &sandbox_id,
                        sandbox_integration_binding_ref,
                        route_projection,
                    ) => bridge?,
                    _ = &mut exec_monitor.response => return Err(EpochFault::MemberExited),
                };
                let harness_ready = bridge.harness_ready();
                if !harness_ready || !exec_monitor.is_live() {
                    return Err(EpochFault::MemberExited);
                }
                Ok(LifecycleEffectResult::BridgeOpened {
                    bridge,
                    exec_monitor,
                })
            }
            LifecycleEffectKind::CloseBridge => {
                self.close_sandbox_bridge(bridge.ok_or(EpochFault::IdentityMismatch)?)
                    .await?;
                Ok(LifecycleEffectResult::BridgeClosed)
            }
        }
    }

    /// Executes one fixed helper command through the retained authenticated raw client.
    ///
    /// # Errors
    ///
    /// Rejects oversized input or events, any non-empty stderr, data after a
    /// terminal event, a missing or duplicate exit status, an exit other than
    /// the file-helper success statuses zero and two, or an unclean RPC end.
    /// The caller interprets status two only for an optional export.
    pub async fn exec_sandbox_interactive(
        &self,
        sandbox_id: &str,
        command: &[String],
        stdin: &[u8],
    ) -> Result<ExecSandboxInteractiveResult, EpochFault> {
        if sandbox_id.is_empty()
            || command.is_empty()
            || stdin.len() > FILE_EFFECT_MAX_BYTES
            || command
                .iter()
                .any(|value| value.is_empty() || value.contains(['\r', '\n', '\0']))
        {
            return Err(EpochFault::IdentityMismatch);
        }
        let (input, input_rx) = mpsc::channel(4);
        let start = ExecSandboxInput {
            payload: Some(exec_sandbox_input::Payload::Start(ExecSandboxRequest {
                sandbox_id: sandbox_id.to_string(),
                command: command.to_vec(),
                workdir: String::new(),
                environment: Default::default(),
                timeout_seconds: 300,
                stdin: Vec::new(),
                tty: false,
                cols: 0,
                rows: 0,
            })),
        };
        if input.send(start).await.is_err() {
            return Err(EpochFault::MemberExited);
        }
        let mut events = self
            .connected()?
            .raw_grpc()
            .exec_sandbox_interactive(ReceiverStream::new(input_rx))
            .await
            .map_err(|_| {
                eprintln!("stage=file-effect outcome=rpc-admission");
                EpochFault::MemberExited
            })?
            .into_inner();
        for chunk in stdin.chunks(FILE_EFFECT_CHUNK_BYTES) {
            if input
                .send(ExecSandboxInput {
                    payload: Some(exec_sandbox_input::Payload::Stdin(chunk.to_vec())),
                })
                .await
                .is_err()
            {
                eprintln!("stage=file-effect outcome=request-stream");
                return Err(EpochFault::MemberExited);
            }
        }
        let mut stdout = Vec::new();
        let mut exit_status = None;
        while let Some(event) = events.message().await.map_err(|_| {
            eprintln!("stage=file-effect outcome=event-stream");
            EpochFault::MemberExited
        })? {
            match event.payload {
                Some(exec_sandbox_event::Payload::Stdout(event))
                    if exit_status.is_none()
                        && event.data.len() <= FILE_EFFECT_CHUNK_BYTES
                        && stdout.len() + event.data.len() <= FILE_EFFECT_MAX_BYTES =>
                {
                    stdout.extend_from_slice(&event.data);
                }
                Some(exec_sandbox_event::Payload::Stderr(event))
                    if exit_status.is_none() && event.data.is_empty() => {}
                Some(exec_sandbox_event::Payload::Stderr(event)) if !event.data.is_empty() => {
                    eprintln!("stage=file-effect outcome=stderr");
                    return Err(EpochFault::MemberExited);
                }
                Some(exec_sandbox_event::Payload::Exit(event)) if exit_status.is_none() => {
                    exit_status = Some(event.exit_code);
                }
                _ => {
                    eprintln!("stage=file-effect outcome=invalid-event");
                    return Err(EpochFault::MemberExited);
                }
            }
        }
        drop(input);
        match exit_status {
            Some(exit_status @ (0 | 2)) => Ok(ExecSandboxInteractiveResult {
                stdout,
                exit_status,
            }),
            Some(124) => {
                eprintln!("stage=file-effect outcome=timeout");
                Err(EpochFault::MemberExited)
            }
            Some(_) => {
                eprintln!("stage=file-effect outcome=nonzero-exit");
                Err(EpochFault::MemberExited)
            }
            None => {
                eprintln!("stage=file-effect outcome=missing-exit");
                Err(EpochFault::MemberExited)
            }
        }
    }

    /// Starts the timeout-zero Harness, accepts its exact entry marker, and retains its monitor.
    ///
    /// # Errors
    ///
    /// Rejects malformed static lineage, request admission failure, a
    /// missing or malformed entry marker, and any unclean terminal response.
    pub async fn exec_sandbox_worker_bootstrap(
        &self,
        request: WorkerBootstrapRequest,
    ) -> Result<WorkerBootstrapMonitor, EpochFault> {
        request.validate()?;
        let WorkerBootstrapRequest {
            sandbox_id,
            request_id,
            sandbox_integration_binding_ref: _,
        } = request;
        let _request_id = request_id;
        let events = self
            .connected()?
            .raw_grpc()
            .exec_sandbox(ExecSandboxRequest {
                sandbox_id,
                command: vec!["/usr/local/bin/openkit-worker-shim".to_string()],
                workdir: "/workspace".to_string(),
                environment: HashMap::new(),
                timeout_seconds: 0,
                stdin: Vec::new(),
                tty: false,
                cols: 0,
                rows: 0,
            })
            .await
            .map_err(|_| EpochFault::MemberExited)?
            .into_inner();
        let (marker_ready, marker_received) = oneshot::channel();
        let mut response = tokio::spawn(monitor_worker_bootstrap(events, marker_ready));
        tokio::select! {
            biased;
            _ = &mut response => Err(EpochFault::MemberExited),
            ready = marker_received => {
                ready.map_err(|_| EpochFault::MemberExited)?;
                if response.is_finished() {
                    return Err(EpochFault::MemberExited);
                }
                Ok(WorkerBootstrapMonitor { response })
            }
        }
    }

    /// Returns the connected SDK client or a fail-stop member fault.
    fn connected(&self) -> Result<&OpenShellClient, EpochFault> {
        self.client.as_ref().ok_or(EpochFault::MemberExited)
    }
}

/// Accepts the exact worker-entry marker and monitors the response through clean exit.
async fn monitor_worker_bootstrap<S>(
    mut events: S,
    marker_ready: oneshot::Sender<()>,
) -> Result<WorkerBootstrapCompletion, EpochFault>
where
    S: Stream<Item = Result<ExecSandboxEvent, tonic::Status>> + Unpin,
{
    let mut marker_ready = Some(marker_ready);
    let mut marker_length = 0;
    let mut exit_status = None;
    while let Some(event) = events.next().await {
        let event = event.map_err(|_| EpochFault::MemberExited)?;
        match event.payload {
            Some(exec_sandbox_event::Payload::Stdout(event)) if event.data.is_empty() => {}
            Some(exec_sandbox_event::Payload::Stderr(event)) if event.data.is_empty() => {}
            Some(exec_sandbox_event::Payload::Stdout(event))
                if exit_status.is_none() && marker_length < WORKER_ENTRY_MARKER.len() =>
            {
                let remaining = &WORKER_ENTRY_MARKER[marker_length..];
                if event.data.len() > remaining.len()
                    || event.data.as_slice() != &remaining[..event.data.len()]
                {
                    return Err(EpochFault::MemberExited);
                }
                marker_length += event.data.len();
                if marker_length == WORKER_ENTRY_MARKER.len() {
                    marker_ready
                        .take()
                        .ok_or(EpochFault::MemberExited)?
                        .send(())
                        .map_err(|_| EpochFault::MemberExited)?;
                }
            }
            Some(exec_sandbox_event::Payload::Exit(event))
                if marker_length == WORKER_ENTRY_MARKER.len() && exit_status.is_none() =>
            {
                exit_status = Some(event.exit_code);
            }
            _ => return Err(EpochFault::MemberExited),
        }
    }
    let exit_status = exit_status.ok_or(EpochFault::MemberExited)?;
    Ok(WorkerBootstrapCompletion {
        monitor_exit: true,
        clean_response: true,
        exit_status,
    })
}

#[cfg(test)]
mod tests {
    use openshell_sdk::SandboxPhase;
    use openshell_sdk::raw::proto::{
        ExecSandboxEvent, ExecSandboxExit, ExecSandboxStderr, ExecSandboxStdout, FilesystemPolicy,
        LandlockPolicy, ProcessPolicy, SandboxPolicy, exec_sandbox_event,
    };
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::{Duration, timeout};
    use tokio_stream::wrappers::ReceiverStream;
    use tonic::Status;

    use super::{
        CompiledOpenShellClient, LifecycleEffectKind, LifecycleEffectRequest, ReadinessFailure,
        TypedOpenShellLifecycleClient, WorkerBootstrapMonitor, classify_ready_observation,
        monitor_worker_bootstrap,
    };
    use crate::epoch_coordinator::CreateCertaintyLossPoint;

    /// Exact fixed worker-entry vocabulary accepted from stdout.
    const WORKER_ENTRY_MARKER: &[u8] = b"OPENKIT_WORKER_SHIM_ENTRY_V1\n";

    /// Builds one real stdout response event for monitor behavior checks.
    fn stdout_event(data: impl Into<Vec<u8>>) -> Result<ExecSandboxEvent, Status> {
        Ok(ExecSandboxEvent {
            payload: Some(exec_sandbox_event::Payload::Stdout(ExecSandboxStdout {
                data: data.into(),
            })),
        })
    }

    /// Builds one real stderr response event for monitor behavior checks.
    fn stderr_event(data: impl Into<Vec<u8>>) -> Result<ExecSandboxEvent, Status> {
        Ok(ExecSandboxEvent {
            payload: Some(exec_sandbox_event::Payload::Stderr(ExecSandboxStderr {
                data: data.into(),
            })),
        })
    }

    /// Builds one real Exit response event for monitor behavior checks.
    fn exit_event(exit_code: i32) -> Result<ExecSandboxEvent, Status> {
        Ok(ExecSandboxEvent {
            payload: Some(exec_sandbox_event::Payload::Exit(ExecSandboxExit {
                exit_code,
            })),
        })
    }

    /// Requires one response sequence to fail through the value-free member fault.
    async fn assert_worker_monitor_rejected(
        label: &str,
        events: Vec<Result<ExecSandboxEvent, Status>>,
    ) {
        let (marker_ready_tx, _marker_ready_rx) = oneshot::channel();
        let result = monitor_worker_bootstrap(tokio_stream::iter(events), marker_ready_tx).await;
        assert!(
            matches!(
                result,
                Err(crate::epoch_coordinator::EpochFault::MemberExited)
            ),
            "worker monitor accepted {label}"
        );
    }

    /** Requires the production client to implement the typed lifecycle boundary. */
    fn require_typed_client<T: TypedOpenShellLifecycleClient>() {}

    #[test]
    fn wp3a_u3a1_uses_the_compiled_typed_openshell_client_boundary() {
        require_typed_client::<CompiledOpenShellClient>();
    }

    #[test]
    fn classifies_only_bounded_ready_observations() {
        let cases = [
            (
                "observation failure",
                Err(()),
                false,
                Err(ReadinessFailure::Uncertain(
                    CreateCertaintyLossPoint::ReadyObservationUnproved,
                )),
            ),
            (
                "error phase",
                Ok((SandboxPhase::Error, "sandbox-id", "sandbox-name")),
                false,
                Err(ReadinessFailure::Uncertain(
                    CreateCertaintyLossPoint::ReadyErrorPhase,
                )),
            ),
            (
                "deadline",
                Ok((SandboxPhase::Provisioning, "sandbox-id", "sandbox-name")),
                true,
                Err(ReadinessFailure::Uncertain(
                    CreateCertaintyLossPoint::ReadyTimeout,
                )),
            ),
            (
                "pending",
                Ok((SandboxPhase::Provisioning, "sandbox-id", "sandbox-name")),
                false,
                Ok(false),
            ),
            (
                "ready",
                Ok((SandboxPhase::Ready, "sandbox-id", "sandbox-name")),
                false,
                Ok(true),
            ),
            (
                "ready identity mismatch",
                Ok((SandboxPhase::Ready, "other-id", "sandbox-name")),
                false,
                Err(ReadinessFailure::IdentityMismatch),
            ),
            (
                "ready name mismatch",
                Ok((SandboxPhase::Ready, "sandbox-id", "other-name")),
                false,
                Err(ReadinessFailure::IdentityMismatch),
            ),
        ];
        for (label, observation, deadline_reached, expected) in cases {
            assert_eq!(
                classify_ready_observation(
                    observation,
                    "sandbox-id",
                    "sandbox-name",
                    deadline_reached,
                ),
                expected,
                "unexpected classification for {label}"
            );
        }
    }

    #[test]
    fn nhc_imp_5o_connects_only_through_one_namespace_entering_thread() {
        let production = include_str!("openshell_client.rs")
            .split_once("#[cfg(test)]")
            .expect("OpenShell client production section")
            .0;
        let setns_declaration = production
            .split_once("unsafe extern \"C\" {")
            .expect("Linux setns declaration")
            .1
            .split_once("/// Calls Linux `setns`")
            .expect("end of Linux setns declaration")
            .0;
        assert_eq!(
            setns_declaration
                .matches("#[link_name = \"setns\"]")
                .count(),
            1
        );
        assert_eq!(
            setns_declaration
                .matches("fn linux_setns(fd: i32, namespace_type: i32) -> i32;")
                .count(),
            1
        );
        let setns_wrapper = production
            .split_once("unsafe fn setns(fd: i32, namespace_type: i32) -> i32 {")
            .expect("setns wrapper")
            .1
            .split_once("/// The compiled stock OpenShell SDK client")
            .expect("end of setns wrapper")
            .0;
        assert_eq!(
            setns_wrapper
                .matches("linux_setns(fd, namespace_type)")
                .count(),
            1
        );
        assert_eq!(setns_wrapper.matches("\n        -1\n").count(), 1);

        let connect = production
            .split_once("pub async fn connect(&mut self)")
            .expect("Gateway connect owner")
            .1
            .split_once("/// Proves the connected Gateway")
            .expect("end of Gateway connect owner")
            .0;
        let connector_start = connect
            .find("let connector = service_fn")
            .expect("dedicated connector owner");
        let connector_end = connect
            .find("let channel: Channel")
            .expect("end of dedicated connector owner");
        let connector = &connect[connector_start..connector_end];
        let exact_host = connector
            .find("filter(|host| *host == \"127.0.0.1\")")
            .expect("exact Gateway connector host");
        let exact_port = connector
            .find("filter(|port| *port == 17670)")
            .expect("exact Gateway connector port");
        let dedicated_thread = connector
            .find("let worker = thread::spawn")
            .expect("dedicated connector thread");
        let namespace_entry = connector
            .find("if unsafe { setns(namespace_descriptor.as_raw_fd(), CLONE_NEWNET) } != 0")
            .expect("setns failure polarity");
        let namespace_failure = connector[namespace_entry..]
            .find("return Err(io::Error::last_os_error())")
            .map(|offset| namespace_entry + offset)
            .expect("setns fail-closed result");
        let socket_connect = connector
            .find("TcpStream::connect((host.as_str(), port))")
            .expect("post-setns Gateway socket");
        assert!(
            exact_host < exact_port
                && exact_port < dedicated_thread
                && dedicated_thread < namespace_entry
                && namespace_entry < namespace_failure
                && namespace_failure < socket_connect
        );
        assert_eq!(connector.matches("thread::spawn").count(), 1);
        assert_eq!(connector.matches("setns(").count(), 1);
        assert_eq!(connector.matches("TcpStream::connect").count(), 1);

        let typed_connect = connect
            .find(".connect_with_connector(connector)")
            .expect("typed dedicated connector consumption");
        assert!(connector_end < typed_connect);
        assert_eq!(connect.matches("connect_with_connector(").count(), 1);
        assert!(!connect.contains("endpoint.connect("));
        assert!(!connect.contains(".connect().await"));
    }

    #[tokio::test]
    async fn wp5_worker_entry_marker_accepts_every_stdout_split_boundary() {
        for split in 0..=WORKER_ENTRY_MARKER.len() {
            let (marker_ready_tx, marker_ready_rx) = oneshot::channel();
            let completion = monitor_worker_bootstrap(
                tokio_stream::iter(vec![
                    stdout_event(Vec::new()),
                    stdout_event(WORKER_ENTRY_MARKER[..split].to_vec()),
                    stderr_event(Vec::new()),
                    stdout_event(WORKER_ENTRY_MARKER[split..].to_vec()),
                    exit_event(0),
                    stdout_event(Vec::new()),
                    stderr_event(Vec::new()),
                ]),
                marker_ready_tx,
            )
            .await
            .expect("complete marker, one Exit, and clean EOF must settle");
            marker_ready_rx
                .await
                .expect("the complete marker must release bootstrap readiness");
            assert!(completion.monitor_exit, "split {split} missed Exit");
            assert!(completion.clean_response, "split {split} missed clean EOF");
            assert_eq!(completion.exit_status, 0, "split {split} changed Exit");
        }
    }

    #[tokio::test]
    async fn wp5_worker_entry_marker_releases_readiness_only_when_complete_and_not_completion() {
        let (event_tx, event_rx) = mpsc::channel(4);
        let (marker_ready_tx, mut marker_ready_rx) = oneshot::channel();
        let monitor = tokio::spawn(monitor_worker_bootstrap(
            ReceiverStream::new(event_rx),
            marker_ready_tx,
        ));
        let final_byte = WORKER_ENTRY_MARKER.len() - 1;

        event_tx
            .send(stdout_event(WORKER_ENTRY_MARKER[..final_byte].to_vec()))
            .await
            .expect("send incomplete marker");
        assert!(
            timeout(Duration::from_millis(10), &mut marker_ready_rx)
                .await
                .is_err(),
            "an incomplete marker released readiness"
        );
        assert!(
            !monitor.is_finished(),
            "an incomplete marker settled the monitor"
        );

        event_tx
            .send(stdout_event(WORKER_ENTRY_MARKER[final_byte..].to_vec()))
            .await
            .expect("send final marker byte");
        timeout(Duration::from_secs(1), &mut marker_ready_rx)
            .await
            .expect("complete marker readiness deadline")
            .expect("complete marker readiness sender");
        assert!(
            !monitor.is_finished(),
            "the marker replaced terminal completion"
        );

        event_tx.send(exit_event(0)).await.expect("send one Exit");
        tokio::task::yield_now().await;
        assert!(
            !monitor.is_finished(),
            "Exit without clean EOF settled the monitor"
        );

        drop(event_tx);
        let completion = monitor
            .await
            .expect("monitor task")
            .expect("one Exit followed by clean EOF");
        assert!(completion.monitor_exit);
        assert!(completion.clean_response);
        assert_eq!(completion.exit_status, 0);
    }

    #[tokio::test]
    async fn nhc_fnd_060_definite_sandbox_deletion_discards_the_bootstrap_monitor() {
        let response = tokio::spawn(async {
            std::future::pending::<()>().await;
            unreachable!()
        });
        let abort = response.abort_handle();
        WorkerBootstrapMonitor { response }.discard_after_sandbox_deletion();
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
    }

    #[tokio::test]
    async fn wp5_worker_entry_monitor_rejects_the_complete_invalid_matrix() {
        let mut duplicate_marker = WORKER_ENTRY_MARKER.to_vec();
        duplicate_marker.extend_from_slice(WORKER_ENTRY_MARKER);
        let mut prefixed_marker = b"x".to_vec();
        prefixed_marker.extend_from_slice(WORKER_ENTRY_MARKER);
        let mut suffixed_marker = WORKER_ENTRY_MARKER.to_vec();
        suffixed_marker.push(b'x');
        let incomplete = WORKER_ENTRY_MARKER[..WORKER_ENTRY_MARKER.len() - 1].to_vec();

        let cases = vec![
            ("EOF without marker", vec![]),
            ("Exit without marker", vec![exit_event(0)]),
            (
                "incomplete marker at EOF",
                vec![stdout_event(incomplete.clone())],
            ),
            (
                "incomplete marker before Exit",
                vec![stdout_event(incomplete), exit_event(0)],
            ),
            (
                "duplicate marker in one event",
                vec![stdout_event(duplicate_marker), exit_event(0)],
            ),
            (
                "duplicate marker in another event",
                vec![
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    exit_event(0),
                ],
            ),
            (
                "prefixed marker",
                vec![stdout_event(prefixed_marker), exit_event(0)],
            ),
            (
                "suffixed marker",
                vec![stdout_event(suffixed_marker), exit_event(0)],
            ),
            (
                "post-marker stdout",
                vec![
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    stdout_event(b"x".to_vec()),
                    exit_event(0),
                ],
            ),
            (
                "pre-marker stderr",
                vec![stderr_event(b"x".to_vec()), exit_event(0)],
            ),
            (
                "post-marker stderr",
                vec![
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    stderr_event(b"x".to_vec()),
                    exit_event(0),
                ],
            ),
            (
                "premature Exit",
                vec![exit_event(0), stdout_event(WORKER_ENTRY_MARKER.to_vec())],
            ),
            (
                "duplicate Exit",
                vec![
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    exit_event(0),
                    exit_event(0),
                ],
            ),
            (
                "response event without payload",
                vec![
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    Ok(ExecSandboxEvent { payload: None }),
                    exit_event(0),
                ],
            ),
            (
                "response failure before marker",
                vec![Err(Status::unavailable("response lost"))],
            ),
            (
                "response failure after marker",
                vec![
                    stdout_event(WORKER_ENTRY_MARKER.to_vec()),
                    Err(Status::unavailable("response lost")),
                ],
            ),
            (
                "complete marker EOF without Exit",
                vec![stdout_event(WORKER_ENTRY_MARKER.to_vec())],
            ),
        ];

        for (label, events) in cases {
            assert_worker_monitor_rejected(label, events).await;
        }
    }

    #[test]
    fn wp4_stock_bridge_orders_session_issue_forward_and_revocation_on_one_client() {
        let source = include_str!("openshell_client.rs")
            .split_once("#[cfg(test)]")
            .expect("OpenShell client production section")
            .0;
        let bridge = source
            .split_once("pub async fn open_sandbox_bridge(")
            .expect("the stock bridge owner must be present")
            .1
            .split_once("/// Closes one bridge")
            .expect("end of the stock bridge owner")
            .0;
        let create_rpc = ["create", "_ssh_session"].concat();
        let forward_rpc = ["forward", "_tcp"].concat();
        let revoke_rpc = ["revoke", "_ssh_session"].concat();
        let create = bridge
            .find(&create_rpc)
            .expect("CreateSshSession must issue first");
        let forward = bridge
            .find(&forward_rpc)
            .expect("ForwardTcp must follow issuance");
        let revoke = bridge
            .find(&revoke_rpc)
            .expect("the short-lived session must be revoked or discarded");
        assert!(create < forward && forward < revoke);
        assert_eq!(
            bridge.matches(&forward_rpc).count(),
            1,
            "one source attempt owns one non-overlapping pair"
        );
        let fixed_target = bridge
            .find("SANDBOX_INTEGRATION_TARGET")
            .expect("one fixed bridge target");
        let hard_bound = bridge
            .find("BRIDGE_REESTABLISH_HARD_BOUND")
            .expect("existing bridge hard bound");
        let attempt_loop = bridge.find("loop {").expect("bounded bridge attempt loop");
        let select = bridge
            .find("tokio::select!")
            .expect("Harness readiness and route completion race");
        let harness_ready = bridge[select..]
            .find("harness_ready_rx.recv()")
            .map(|position| select + position)
            .expect("exact Harness readiness observation");
        let success = bridge
            .find("OpenSandboxBridge::new")
            .expect("one authenticated current pair");
        let route_completion = bridge[select..]
            .find("&mut route_server")
            .map(|position| select + position)
            .expect("pre-ready route completion observation");
        let finished_state = bridge[..select]
            .rfind("let mut route_server_finished = false")
            .expect("active route handle state before select");
        let completion_record = bridge[route_completion..]
            .find("route_server_finished = true")
            .map(|position| route_completion + position)
            .expect("select completion records the consumed handle");
        let active_cleanup = bridge[completion_record..]
            .find("if !route_server_finished")
            .map(|position| completion_record + position)
            .expect("cleanup is guarded by an active handle");
        let abort = bridge[active_cleanup..]
            .find("route_server.abort()")
            .map(|position| active_cleanup + position)
            .expect("active attempt abort");
        let await_active = bridge[abort..]
            .find("route_server.await")
            .map(|position| abort + position)
            .expect("active attempt join");
        let backoff = bridge[await_active..]
            .find("sleep(Duration::from_millis(")
            .map(|position| await_active + position)
            .expect("short bridge attempt backoff");
        let final_revoke = bridge
            .rfind(&revoke_rpc)
            .expect("deadline revokes the shared SSH token");
        let final_failure = bridge
            .rfind("return Err(EpochFault::MemberExited)")
            .expect("deadline fails bridge admission");
        assert!(
            create < fixed_target
                && fixed_target < hard_bound
                && hard_bound < attempt_loop
                && attempt_loop < forward
                && forward < select
                && select < harness_ready
                && harness_ready < success
                && select < route_completion
                && finished_state < select
                && route_completion < completion_record
                && completion_record < active_cleanup
                && active_cleanup < abort
                && abort < await_active
                && await_active < backoff
                && backoff < final_revoke
                && final_revoke < final_failure,
            "bridge retries one completed pre-ready pair until exact Harness readiness or the existing hard bound"
        );
        assert!(!bridge[route_completion..backoff].contains("OpenSandboxBridge::new"));
        assert_eq!(bridge.matches("OpenSandboxBridge::new").count(), 1);
        assert_eq!(bridge.matches("tokio::spawn").count(), 1);
        assert_eq!(bridge.matches("route_server.abort()").count(), 1);
        assert_eq!(bridge.matches("route_server.await").count(), 1);
        assert_eq!(bridge.matches(&create_rpc).count(), 1);
        assert_eq!(bridge.matches("SANDBOX_INTEGRATION_TARGET").count(), 1);
        assert!(bridge[attempt_loop..].contains("sandbox_id: sandbox_id.to_string()"));
        assert!(bridge[attempt_loop..].contains("authorization_token: session.token.clone()"));
        for forbidden in [
            ".exec_sandbox(",
            ".exec_sandbox_interactive(",
            ".create_sandbox(",
        ] {
            assert!(
                !bridge.contains(forbidden),
                "bridge attempt must not repeat {forbidden}"
            );
        }
    }

    #[test]
    fn wp5_lifecycle_effects_are_closed_identity_bound_and_use_existing_client_owners() {
        let policy = SandboxPolicy {
            version: 1,
            filesystem: Some(FilesystemPolicy {
                include_workdir: true,
                read_only: Vec::new(),
                read_write: vec!["/sandbox".to_string()],
            }),
            landlock: Some(LandlockPolicy {
                compatibility: "best_effort".to_string(),
            }),
            process: Some(ProcessPolicy {
                run_as_user: "sandbox".to_string(),
                run_as_group: "sandbox".to_string(),
            }),
            ..SandboxPolicy::default()
        };
        assert_eq!(policy.version, 1);
        let filesystem = policy.filesystem.as_ref().expect("filesystem policy");
        assert!(filesystem.include_workdir);
        assert_eq!(filesystem.read_write, ["/sandbox"]);
        assert_eq!(
            policy
                .landlock
                .as_ref()
                .map(|landlock| landlock.compatibility.as_str()),
            Some("best_effort")
        );
        assert_eq!(
            policy
                .process
                .as_ref()
                .map(|process| (process.run_as_user.as_str(), process.run_as_group.as_str())),
            Some(("sandbox", "sandbox"))
        );
        for (wire, expected) in [
            ("sandbox.create", LifecycleEffectKind::CreateSandbox),
            ("sandbox.delete", LifecycleEffectKind::DeleteSandbox),
            ("bridge.open", LifecycleEffectKind::OpenBridge),
            ("bridge.close", LifecycleEffectKind::CloseBridge),
        ] {
            assert_eq!(LifecycleEffectKind::parse(wire), Ok(expected));
        }
        for rejected in ["command.run", "gateway.forward", "sandbox.exec", ""] {
            assert!(
                LifecycleEffectKind::parse(rejected).is_err(),
                "accepted {rejected}"
            );
        }
        assert!(
            LifecycleEffectRequest::new(
                "request-lifecycle",
                "lease-a",
                "sandbox-a",
                LifecycleEffectKind::DeleteSandbox,
            )
            .validate_result_identity("request-other", "sandbox-a")
            .is_err()
        );

        let source = include_str!("openshell_client.rs");
        let handler = source
            .split_once("async fn execute_lifecycle_effect")
            .expect("the additive lifecycle effect handler must exist")
            .1
            .split_once("#[cfg(test)]")
            .expect("the handler remains production code")
            .0;
        for existing_owner in [
            "create_sandbox(",
            "delete_sandbox(",
            "open_sandbox_bridge(",
            "close_sandbox_bridge(",
            "exec_sandbox_worker_bootstrap(",
        ] {
            assert!(handler.contains(existing_owner), "missing {existing_owner}");
        }
        assert!(!handler.contains("exec_sandbox_interactive_worker_bootstrap("));
        let open_bridge = handler
            .split_once("LifecycleEffectKind::OpenBridge => {")
            .expect("closed OpenBridge lifecycle branch")
            .1
            .split_once("LifecycleEffectKind::CloseBridge => {")
            .expect("end of OpenBridge lifecycle branch")
            .0;
        let mutable_monitor = open_bridge
            .find("let mut exec_monitor =")
            .expect("mutable bootstrap response monitor before bridge admission");
        let select = open_bridge
            .find("let bridge = tokio::select!")
            .expect("bridge admission must race bootstrap monitor completion");
        let select_block = open_bridge[select..]
            .split_once("};")
            .expect("bounded bridge/monitor race")
            .0;
        assert_eq!(select_block.matches(".open_sandbox_bridge(").count(), 1);
        assert_eq!(
            select_block.matches("&mut exec_monitor.response").count(),
            1
        );
        let monitor_arm = select_block
            .split_once("_ = &mut exec_monitor.response")
            .expect("value-free bootstrap monitor completion arm")
            .1;
        assert!(monitor_arm.contains("return Err(EpochFault::MemberExited)"));
        for forbidden in [
            ".await",
            "sleep(",
            "timeout(",
            "revoke_ssh_session",
            "eprintln!",
            "println!",
        ] {
            assert!(
                !monitor_arm.contains(forbidden),
                "monitor-first OpenBridge failure must not wait or expose {forbidden}"
            );
        }
        let harness_ready = open_bridge
            .find("bridge.harness_ready()")
            .expect("exact private-poll Harness readiness proof");
        let live_check = open_bridge
            .find("exec_monitor.is_live()")
            .expect("existing post-race monitor liveness proof");
        let retained = open_bridge
            .rfind("exec_monitor,")
            .expect("same bootstrap monitor retained on bridge success");
        assert!(
            mutable_monitor < select
                && select < harness_ready
                && select < live_check
                && harness_ready < retained
                && live_check < retained,
            "OpenBridge must race the mutable monitor before retaining one ready live Harness pair"
        );
        assert_eq!(open_bridge.matches("tokio::select!").count(), 1);
        assert_eq!(open_bridge.matches("exec_monitor.is_live()").count(), 1);
        let production = source
            .split_once("#[cfg(test)]")
            .expect("OpenShell client production section")
            .0;
        let create_owner = production
            .split_once("pub async fn create_sandbox")
            .expect("sandbox create owner")
            .1
            .split_once("/// Gets one sandbox")
            .expect("bounded sandbox create owner")
            .0;
        assert!(
            create_owner.contains("policy: SandboxPolicy"),
            "sandbox create must require the AEP-derived pinned policy"
        );
        let raw_request = create_owner
            .find("CreateSandboxRequest")
            .expect("pinned raw create request");
        let policy = create_owner
            .find("policy: Some(policy)")
            .expect("AEP policy must enter the pinned proto spec");
        let raw_create = create_owner
            .find(".create_sandbox(request)")
            .expect("raw create request dispatch");
        let create_request_unproved = create_owner
            .find("CreateCertaintyLossPoint::CreateRequestUnproved")
            .expect("unproved create request classification");
        let create_response_invalid = create_owner
            .find("CreateCertaintyLossPoint::CreateResponseInvalid")
            .expect("invalid create response classification");
        let accepted_identity = create_owner
            .find("expected_name != sandbox.name")
            .expect("accepted create identity validation");
        let deadline = create_owner
            .find("let deadline =")
            .expect("accepted create must establish the fixed Ready deadline");
        let get_sandbox = create_owner
            .find(".get_sandbox(&sandbox.name)")
            .expect("accepted create must use typed Ready observations");
        let classify = create_owner
            .find("classify_ready_observation(")
            .expect("typed Ready observations must retain closed failure classes");
        let ready_return = create_owner
            .find("return observation.map_err")
            .expect("only the identity-matched ready sandbox may return");
        assert!(
            raw_request < policy
                && policy < raw_create
                && raw_create < create_request_unproved
                && create_request_unproved < create_response_invalid
                && create_response_invalid < accepted_identity
                && accepted_identity < deadline
                && deadline < get_sandbox
                && get_sandbox < classify
                && classify < ready_return,
            "sandbox create must validate acceptance, classify typed Ready observations, then return"
        );
        for fixed_bound in [
            "Duration::from_millis(250)",
            "Duration::from_secs(2)",
            "Duration::from_secs(120)",
        ] {
            assert!(
                production.contains(fixed_bound),
                "missing Ready bound {fixed_bound}"
            );
        }
        assert!(!create_owner.contains(".wait_ready("));
        for required in [
            "exec_sandbox_interactive",
            "64 * 1024",
            "256 * 1024 * 1024",
            "exit_status",
            "stderr",
        ] {
            assert!(
                production.contains(required),
                "missing raw file stream rule {required}"
            );
        }
        assert!(!production.contains("openshell upload"));
        assert!(!production.contains("openshell download"));
        let interactive = production
            .split_once("pub async fn exec_sandbox_interactive(")
            .expect("fixed interactive file helper")
            .1
            .split_once("pub async fn exec_sandbox_worker_bootstrap(")
            .expect("end of fixed interactive file helper")
            .0;
        assert!(interactive.contains("ReceiverStream"));
        assert!(interactive.contains("chunks(FILE_EFFECT_CHUNK_BYTES)"));
        assert!(!interactive.contains("read_to_end"));
        assert!(
            !interactive.contains("tokio::spawn"),
            "finite file-effect input must not use an independent producer task"
        );
        let start_send = interactive
            .find("input.send(start)")
            .expect("Start sent on the current sender");
        let raw_rpc = interactive
            .find(".exec_sandbox_interactive(ReceiverStream::new(input_rx))")
            .expect("raw bidirectional RPC admission");
        let chunk_loop = interactive
            .find("for chunk in stdin.chunks(FILE_EFFECT_CHUNK_BYTES)")
            .expect("bounded sequential stdin chunks");
        let request_stream = interactive
            .find("stage=file-effect outcome=request-stream")
            .expect("fixed chunk-send failure classification");
        let event_stream = interactive
            .find("events.message()")
            .expect("response event consumption");
        let exit_event = interactive
            .find("exit_status = Some(event.exit_code)")
            .expect("retained sender through Exit");
        let sender_release = interactive
            .find("drop(input)")
            .expect("explicit sender release after response completion");
        let settlement = interactive
            .find("match exit_status")
            .expect("closed settlement classification");
        assert!(
            start_send < raw_rpc
                && raw_rpc < chunk_loop
                && chunk_loop < request_stream
                && request_stream < event_stream
                && event_stream < exit_event
                && exit_event < sender_release
                && sender_release < settlement,
            "file-effect input must retain its sender through response Exit, then release it before settlement"
        );
        let classifications = [
            "rpc-admission",
            "request-stream",
            "event-stream",
            "stderr",
            "invalid-event",
            "timeout",
            "nonzero-exit",
            "missing-exit",
        ]
        .map(|outcome| {
            let diagnostic = format!("eprintln!(\"stage=file-effect outcome={outcome}\")");
            let position = interactive
                .find(&diagnostic)
                .unwrap_or_else(|| panic!("missing fixed file effect outcome {outcome}"));
            assert_eq!(
                interactive.matches(&diagnostic).count(),
                1,
                "file effect outcome {outcome} must identify one exact branch"
            );
            position
        });
        assert!(
            classifications.windows(2).all(|pair| pair[0] < pair[1]),
            "file effect failure classification must follow rpc, request, event, stderr, invalid-event, timeout, nonzero, then missing-exit branch order"
        );
        assert!(!interactive.contains("stage=file-effect outcome=producer"));
        assert_eq!(
            interactive.matches("stage=file-effect outcome=").count(),
            classifications.len(),
            "file effect helper must expose only the fixed value-free outcome set"
        );
        assert_eq!(
            interactive.matches("eprintln!(").count(),
            classifications.len()
        );
        assert!(!interactive.contains("std::io::stderr"));
        let exit_match = interactive
            .split_once("match exit_status")
            .expect("closed file effect exit classification")
            .1;
        let successful_exit = exit_match
            .find("Some(exit_status @ (0 | 2))")
            .expect("closed file helper success exits");
        let timeout_exit = exit_match
            .find("Some(124)")
            .expect("exact upstream timeout exit");
        let timeout_diagnostic = exit_match
            .find("stage=file-effect outcome=timeout")
            .expect("fixed timeout classification");
        let nonzero_exit = exit_match.find("Some(_)").expect("other nonzero exit");
        let nonzero_diagnostic = exit_match
            .find("stage=file-effect outcome=nonzero-exit")
            .expect("fixed nonzero classification");
        let missing_exit = exit_match.find("None").expect("missing exit event");
        let missing_diagnostic = exit_match
            .find("stage=file-effect outcome=missing-exit")
            .expect("fixed missing-exit classification");
        assert!(
            successful_exit < timeout_exit
                && timeout_exit < timeout_diagnostic
                && timeout_diagnostic < nonzero_exit
                && nonzero_exit < nonzero_diagnostic
                && nonzero_diagnostic < missing_exit
                && missing_exit < missing_diagnostic,
            "exit classification must distinguish exact 124, other nonzero, and missing status"
        );
        let bootstrap = production
            .split_once("pub async fn exec_sandbox_worker_bootstrap(")
            .expect("fixed worker bootstrap owner")
            .1
            .split_once("/// Returns the connected SDK client")
            .expect("end of fixed worker bootstrap owner")
            .0;
        for bootstrap_rule in [
            "/usr/local/bin/openkit-worker-shim",
            "workdir: \"/workspace\"",
            "timeout_seconds: 0",
            "tty: false",
            "environment: HashMap::new()",
            "stdin: Vec::new()",
        ] {
            assert!(
                bootstrap.contains(bootstrap_rule),
                "missing fixed worker bootstrap rule {bootstrap_rule}"
            );
        }
        let validation = bootstrap
            .find("request.validate()?")
            .expect("validated static Harness bootstrap request");
        let unary = bootstrap
            .find(".exec_sandbox(ExecSandboxRequest {")
            .expect("raw unary worker bootstrap");
        let empty_stdin = bootstrap
            .find("stdin: Vec::new()")
            .expect("exact empty Harness stdin");
        assert!(validation < unary && unary < empty_stdin);
        assert!(!bootstrap.contains("--package"));
        assert!(!bootstrap.contains("/openkit/sessions/"));
        assert!(!production.contains("worker_control_token"));
        assert!(!production.contains("worker_inference_token"));
        assert_eq!(bootstrap.matches(".exec_sandbox(").count(), 1);
        for forbidden in [
            "exec_sandbox_interactive",
            "mpsc::channel",
            "ReceiverStream",
            "ExecSandboxInput",
            "drop(input)",
        ] {
            assert!(
                !bootstrap.contains(forbidden),
                "unary worker bootstrap retained interactive shape {forbidden}"
            );
        }
    }
}
