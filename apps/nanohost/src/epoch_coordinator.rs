//! Closed Docker Runtime Epoch process coordination.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Ipv4Addr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use openshell_sdk::raw::proto::SandboxPolicy;
use openshell_sdk::{ListOptions, SandboxRef, SandboxSpec};
use opentelemetry::trace::TraceContextExt;
use opentelemetry::{Context, KeyValue};
use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;
use tokio::time::{sleep, timeout};

use crate::epoch_evidence::{
    EXPORT_TIMEOUT, EpochEvidenceWriter, EpochInvalidationTrigger, REBUILD_FENCE_STARTED_PATH,
    record_fence_started_at,
};
use crate::image_acquisition::{
    AcquisitionTrigger, BuildDefinition, BuildPlan, EMPTY_BUILD_CONTEXT_DIGEST,
    EMPTY_BUILD_CONTEXT_REF, ImageEffectEvidence, ImageEffectRequest, RegistryAcquisition,
    retained_parent_alias, verify_raw_import_names_before,
};
use crate::image_store::{ImageStore, StoreError};
use crate::nanocore_session::OuterRouteProjection;
use crate::openshell_client::{
    LifecycleEffectKind, LifecycleEffectRequest, LifecycleEffectResult, NanoHostOpenShellClient,
    WorkerBootstrapMonitor, WorkerBootstrapRequest,
};
use crate::openshell_release;
use crate::persistent_volume::{PersistentVolumeStore, StorageAttachmentRequest, StorageMount};
use crate::sandbox_bridge::{
    EffectCarriage, FileEffectKind, FileEffectPresence, FileEffectRequest, OpenSandboxBridge,
    RetainedExportResult, read_import_staging, stage_export,
};

/// systemd slice containing NanoHost and every Runtime Epoch member.
pub const OPENKIT_NANOHOST_SLICE: &str = "openkit-nanohost.slice";

/// Fixed loopback port for the closed V1 epoch-local Gateway.
const GATEWAY_PORT: &str = "17670";

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("NanoHost supports only linux/amd64 and linux/arm64 Supervisor images");

/// Maximum time allowed for each dependency readiness proof.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Fresh roots through complete readiness share the transport specification's hard bound.
pub const STARTUP_READINESS_HARD_LIMIT: Duration = Duration::from_secs(120);

/// Last successful readiness observation, used only by private forensic reports.
#[derive(Clone, Copy)]
#[repr(u8)]
enum ReadinessProof {
    /// No readiness check has been observed.
    Unavailable,
    /// Both fresh private roots were created.
    PrivateRoots,
    /// Gateway authentication, configuration and resolver files were written.
    Configuration,
    /// Containerd namespaces were retained and its socket became available.
    ContainerdSocket,
    /// Slirp proved its route while containerd remained running.
    PrivateNetwork,
    /// Docker namespace membership and socket availability were proved.
    DockerSocket,
    /// Gateway health and all local member liveness checks succeeded.
    GatewayHealth,
    /// Core completed the exact readiness acknowledgement within its deadline.
    CoreAcknowledgement,
}

impl ReadinessProof {
    /// Snapshots one closed proof name without waiting for diagnostic collection.
    fn report_value(observation: &AtomicU8) -> String {
        let last_succeeded = match observation.load(Ordering::Acquire) {
            value if value == Self::PrivateRoots as u8 => "private-roots",
            value if value == Self::Configuration as u8 => "configuration",
            value if value == Self::ContainerdSocket as u8 => "containerd-socket",
            value if value == Self::PrivateNetwork as u8 => "private-network",
            value if value == Self::DockerSocket as u8 => "docker-socket",
            value if value == Self::GatewayHealth as u8 => "gateway-health",
            value if value == Self::CoreAcknowledgement as u8 => "core-acknowledgement",
            _ => "unavailable",
        };
        format!("last_succeeded={last_succeeded}")
    }
}

/// Enters one retained Linux network namespace.
unsafe fn setns_network(fd: i32) -> i32 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the caller owns the retained descriptor and namespace type.
        unsafe { libc::setns(fd, libc::CLONE_NEWNET) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = fd;
        -1
    }
}

/// Enters one retained Linux mount namespace.
unsafe fn setns_mount(fd: i32) -> i32 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the caller owns the retained mount namespace descriptor.
        unsafe { libc::setns(fd, libc::CLONE_NEWNS) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = fd;
        -1
    }
}

/// Creates one fresh Linux network namespace.
unsafe fn unshare_network() -> i32 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the caller supplies the fixed supported namespace flag.
        unsafe { libc::unshare(libc::CLONE_NEWNET) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        -1
    }
}

/// Reads one fresh 128-bit discriminator from the execution host's OS random device.
fn fresh_epoch_discriminator() -> io::Result<[u8; 16]> {
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open("/dev/urandom")?;
    if !source.metadata()?.file_type().is_char_device() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "epoch randomness source is not a character device",
        ));
    }
    let mut discriminator = [0_u8; 16];
    source.read_exact(&mut discriminator)?;
    Ok(discriminator)
}

/// Composes one bounded epoch name from a fresh random discriminator.
fn compose_epoch_name(discriminator: &[u8; 16]) -> String {
    let discriminator = discriminator
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("epoch-{discriminator}")
}

/// Runtime backend accepted by NanoHost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeBackend {
    /// Dedicated Docker daemon backed by the epoch's containerd process.
    Docker,
}

/// Parses the closed runtime-backend configuration.
///
/// # Errors
///
/// Returns an error for every backend other than `docker`.
pub fn configured_backend(value: &str) -> Result<RuntimeBackend, &'static str> {
    match value {
        "docker" => Ok(RuntimeBackend::Docker),
        _ => Err("unsupported runtime backend"),
    }
}

/// Parses the fixed epoch resolver source into one strict ordered IPv4 set.
///
/// # Errors
///
/// Returns an error unless the source contains one through three unique plain
/// unicast IPv4 `nameserver` literals and no malformed nameserver declaration.
pub fn resolve_epoch_nameservers(source: &str) -> Result<Vec<Ipv4Addr>, &'static str> {
    let mut nameservers = Vec::new();
    for line in source.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let mut fields = line.split_ascii_whitespace();
        if fields.next() != Some("nameserver") {
            continue;
        }
        let address = fields
            .next()
            .and_then(|value| value.parse::<Ipv4Addr>().ok())
            .filter(|address| {
                !address.is_unspecified()
                    && !address.is_loopback()
                    && !address.is_multicast()
                    && !address.is_broadcast()
            })
            .ok_or("epoch resolver address rejected")?;
        if fields.next().is_some() || nameservers.contains(&address) {
            return Err("epoch resolver declaration rejected");
        }
        nameservers.push(address);
        if nameservers.len() > 3 {
            return Err("epoch resolver count rejected");
        }
    }
    if nameservers.is_empty() {
        return Err("epoch resolver set missing");
    }
    Ok(nameservers)
}

/// Projects the accepted resolver set as repeated fixed Docker DNS arguments.
pub fn dockerd_dns_arguments(nameservers: &[Ipv4Addr]) -> Vec<String> {
    nameservers
        .iter()
        .flat_map(|address| ["--dns".to_string(), address.to_string()])
        .collect()
}

/// Process role in dependency start order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpochProcessRole {
    /// Epoch-private containerd.
    Containerd,
    /// Host-side userspace network helper for the private namespace.
    Slirp4netns,
    /// Epoch-private Docker daemon.
    Dockerd,
    /// Stock OpenShell Gateway.
    OpenShellGateway,
}

/// Network-namespace placement for one fixed Runtime Epoch member.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpochNetworkNamespaceMode {
    /// Creates the fresh private namespace before the member executes.
    CreatePrivate,
    /// Remains in the NanoHost service's host namespace.
    Host,
    /// Joins the retained private namespace before the member executes.
    JoinPrivate,
}

/// Direct foreground process invocation for one Runtime Epoch member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochMemberSpec {
    role: EpochProcessRole,
    program: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
    network_namespace_mode: EpochNetworkNamespaceMode,
    inherited_descriptor_targets: Vec<i32>,
}

impl EpochMemberSpec {
    /// Returns the member's role.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn role(&self) -> EpochProcessRole {
        self.role
    }

    /// Returns the executable invoked directly, without a shell or helper.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Returns the executable's direct argument vector.
    pub fn args(&self) -> &[String] {
        &self.args
    }

    /// Returns the environment entries projected only into this member process.
    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    /// Returns this member's exact network-namespace placement.
    pub fn network_namespace_mode(&self) -> EpochNetworkNamespaceMode {
        self.network_namespace_mode
    }

    /// Returns the fixed child descriptor targets inherited by this member.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn inherited_descriptor_targets(&self) -> &[i32] {
        &self.inherited_descriptor_targets
    }

    /// Returns whether the process remains attached in the foreground.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn foreground(&self) -> bool {
        true
    }
}

/// Fresh, non-adopting filesystem and process plan for one Runtime Epoch.
#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct EpochPlan {
    epoch_name: String,
    epoch_root: PathBuf,
    run_root: PathBuf,
    containerd_socket: PathBuf,
    docker_socket: PathBuf,
    gateway_auth_path: PathBuf,
    gateway_config_path: PathBuf,
    gateway_config_contents: String,
    gateway_program: PathBuf,
    resolver_path: PathBuf,
    resolver_contents: String,
    members: Vec<EpochMemberSpec>,
}

impl EpochPlan {
    /// Builds a unique epoch-private plan beneath the supplied state and run roots.
    ///
    /// # Errors
    ///
    /// Returns an error if OS randomness cannot produce a fresh epoch name.
    pub fn fresh(
        state_root: &Path,
        run_root: &Path,
        gateway: &Path,
        nameservers: &[Ipv4Addr],
    ) -> io::Result<Self> {
        let discriminator = fresh_epoch_discriminator()?;
        let epoch_name = compose_epoch_name(&discriminator);
        let epoch_root = state_root.join(&epoch_name);
        let run_root = run_root.join(&epoch_name);
        let containerd_socket = run_root.join("containerd.sock");
        let docker_socket = run_root.join("docker.sock");
        let gateway_auth_path = epoch_root.join("gateway-auth");
        let gateway_config_path = epoch_root.join("gateway.toml");
        let gateway_database_path = epoch_root.join("gateway.db");
        let gateway_program = gateway.to_path_buf();
        let resolver_path = epoch_root.join("resolv.conf");
        let resolver_contents = nameservers
            .iter()
            .map(|address| format!("nameserver {address}\n"))
            .collect();
        let gateway_config_contents = gateway_config(&docker_socket, &gateway_auth_path)?;
        let containerd_namespace = format!("openkit-{epoch_name}");
        let containerd_plugins_namespace = format!("openkit-plugins-{epoch_name}");
        let members = vec![
            EpochMemberSpec {
                role: EpochProcessRole::Containerd,
                program: PathBuf::from("/usr/bin/containerd"),
                args: vec![
                    "--address".into(),
                    path_arg(&containerd_socket),
                    "--root".into(),
                    path_arg(&epoch_root.join("containerd")),
                    "--state".into(),
                    path_arg(&run_root.join("containerd")),
                ],
                env: Vec::new(),
                network_namespace_mode: EpochNetworkNamespaceMode::CreatePrivate,
                inherited_descriptor_targets: Vec::new(),
            },
            EpochMemberSpec {
                role: EpochProcessRole::Slirp4netns,
                program: PathBuf::from("/usr/bin/slirp4netns"),
                args: vec![
                    "--configure".into(),
                    "--disable-host-loopback".into(),
                    "--disable-dns".into(),
                    "--enable-sandbox".into(),
                    "--enable-seccomp".into(),
                    "--ready-fd=3".into(),
                    "--netns-type=path".into(),
                    "/proc/self/fd/4".into(),
                    "tap0".into(),
                ],
                env: Vec::new(),
                network_namespace_mode: EpochNetworkNamespaceMode::Host,
                inherited_descriptor_targets: vec![3, 4],
            },
            EpochMemberSpec {
                role: EpochProcessRole::Dockerd,
                program: PathBuf::from("/usr/bin/dockerd"),
                args: {
                    let mut args = vec![
                        "--config-file".into(),
                        "/dev/null".into(),
                        "--host".into(),
                        format!("unix://{}", docker_socket.display()),
                        "--containerd".into(),
                        path_arg(&containerd_socket),
                        "--containerd-namespace".into(),
                        containerd_namespace,
                        "--containerd-plugins-namespace".into(),
                        containerd_plugins_namespace,
                        "--bridge".into(),
                        "none".into(),
                        "--feature".into(),
                        "containerd-snapshotter=true".into(),
                        "--data-root".into(),
                        path_arg(&epoch_root.join("docker")),
                        "--exec-root".into(),
                        path_arg(&run_root.join("docker")),
                        "--pidfile".into(),
                        path_arg(&run_root.join("dockerd.pid")),
                        "--cgroup-parent".into(),
                        OPENKIT_NANOHOST_SLICE.into(),
                    ];
                    args.extend(dockerd_dns_arguments(nameservers));
                    args
                },
                env: Vec::new(),
                network_namespace_mode: EpochNetworkNamespaceMode::JoinPrivate,
                inherited_descriptor_targets: Vec::new(),
            },
            EpochMemberSpec {
                role: EpochProcessRole::OpenShellGateway,
                program: gateway_program.clone(),
                args: vec![
                    "--config".into(),
                    path_arg(&gateway_config_path),
                    "--bind-address".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    GATEWAY_PORT.into(),
                    "--db-url".into(),
                    format!("sqlite:{}", gateway_database_path.display()),
                    "--drivers".into(),
                    "docker".into(),
                ],
                env: vec![
                    ("HOME".into(), path_arg(&epoch_root.join("home"))),
                    (
                        "OPENSHELL_LOCAL_TLS_DIR".into(),
                        path_arg(&gateway_auth_path),
                    ),
                ],
                network_namespace_mode: EpochNetworkNamespaceMode::JoinPrivate,
                inherited_descriptor_targets: Vec::new(),
            },
        ];
        Ok(Self {
            epoch_name,
            epoch_root,
            run_root,
            containerd_socket,
            docker_socket,
            gateway_auth_path,
            gateway_config_path,
            gateway_config_contents,
            gateway_program,
            resolver_path,
            resolver_contents,
            members,
        })
    }

    /// Returns the epoch-private durable state root.
    pub fn epoch_root(&self) -> &Path {
        &self.epoch_root
    }

    /// Returns the epoch-private runtime root.
    pub fn run_root(&self) -> &Path {
        &self.run_root
    }

    /// Returns the epoch-private containerd socket.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn containerd_socket(&self) -> &Path {
        &self.containerd_socket
    }

    /// Returns the epoch-private Docker socket.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn docker_socket(&self) -> &Path {
        &self.docker_socket
    }

    /// Returns the epoch-private Gateway authentication-material path.
    pub fn gateway_auth_path(&self) -> &Path {
        &self.gateway_auth_path
    }

    /// Returns the Gateway TOML projection for the supported OpenShell release.
    pub fn gateway_config_contents(&self) -> &str {
        &self.gateway_config_contents
    }

    /// Returns the epoch-private resolver projection path.
    fn resolver_path(&self) -> &Path {
        &self.resolver_path
    }

    /// Returns the resolver projection rendered from the accepted fixed set.
    fn resolver_contents(&self) -> &str {
        &self.resolver_contents
    }

    /// Returns the fixed epoch-local Gateway endpoint.
    pub fn gateway_endpoint(&self) -> String {
        format!("https://127.0.0.1:{GATEWAY_PORT}")
    }

    /// Returns the four members in dependency start order.
    pub fn members(&self) -> &[EpochMemberSpec] {
        &self.members
    }
}

/// Derives the private physical-incarnation witness from one fresh epoch name.
fn physical_epoch_for_plan(plan: &EpochPlan) -> String {
    format!("{:x}", Sha256::digest(plan.epoch_name.as_bytes()))
}

/// Closed certainty-loss points retained for an accepted sandbox create.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateCertaintyLossPoint {
    /// The Gateway create request did not produce a proved response.
    CreateRequestUnproved,
    /// The Gateway create response omitted a usable accepted identity.
    CreateResponseInvalid,
    /// A typed Ready observation could not be obtained.
    ReadyObservationUnproved,
    /// The accepted Sandbox entered the terminal Error phase.
    ReadyErrorPhase,
    /// The accepted Sandbox did not become Ready before the fixed deadline.
    ReadyTimeout,
}

impl CreateCertaintyLossPoint {
    /// Returns the exact private evidence literal for this certainty-loss point.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CreateRequestUnproved => "create-request-unproved",
            Self::CreateResponseInvalid => "create-response-invalid",
            Self::ReadyObservationUnproved => "ready-observation-unproved",
            Self::ReadyErrorPhase => "ready-error-phase",
            Self::ReadyTimeout => "ready-timeout",
        }
    }
}

/// Bounded private context for one uncertain sandbox create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateUncertainty {
    certainty_loss: CreateCertaintyLossPoint,
    sandbox_lineage: String,
    attempt_lineage: String,
    elapsed_ms: u64,
}

impl CreateUncertainty {
    /// Captures only the specification-owned create invalidation fields.
    pub fn new(
        certainty_loss: CreateCertaintyLossPoint,
        sandbox_lineage: &str,
        attempt_lineage: &str,
        elapsed: Duration,
    ) -> Self {
        Self {
            certainty_loss,
            sandbox_lineage: sandbox_lineage.to_string(),
            attempt_lineage: attempt_lineage.to_string(),
            elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        }
    }
}

/// Role or watched task that the member monitor names as the first failure.
///
/// The tokens are closed so the invalidation report and journal cannot carry
/// a path, process id, credential, or raw member output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberFailureSubject {
    /// Epoch-private containerd, start index 0.
    Containerd,
    /// Host-side slirp4netns helper, start index 1.
    Slirp4netns,
    /// Epoch-private dockerd, start index 2.
    Dockerd,
    /// Stock OpenShell Gateway, start index 3.
    OpenShellGateway,
    /// Bootstrap response task retained beside the bridge.
    HarnessResponse,
    /// Bridge route task retained beside the bootstrap response.
    HarnessRoute,
    /// The failing role or task could not be observed.
    Unknown,
}

impl MemberFailureSubject {
    /// Returns the closed journal and report spelling for this subject.
    const fn token(self) -> &'static str {
        match self {
            Self::Containerd => "containerd",
            Self::Slirp4netns => "slirp4netns",
            Self::Dockerd => "dockerd",
            Self::OpenShellGateway => "openshell-gateway",
            Self::HarnessResponse => "harness-response",
            Self::HarnessRoute => "harness-route",
            Self::Unknown => "unknown",
        }
    }
}

/// Why the member monitor stopped, without raw output or an invented status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberObservation {
    /// Proved child exit code in the closed range `0..=255`.
    ExitCode(u8),
    /// Proved terminating signal in the closed range `1..=64`.
    Signal(u8),
    /// A watched Harness task finished; its join result is not an exit status.
    Finished,
    /// Liveness could not be proved, so no exit status exists.
    ProofUnavailable(MemberProofKind),
}

/// Closed reason a member-failure proof did not produce an exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberProofKind {
    /// `try_wait` failed, or the status was outside the closed code and signal ranges.
    WaitError,
    /// The harness observation lock was poisoned.
    LockFailure,
    /// The monitor failure channel disconnected without a fault.
    MonitorDisconnected,
    /// Explicit close found no retained response and route task pair.
    TasksAbsent,
}

impl MemberProofKind {
    /// Returns the closed `proof` token for this kind.
    const fn token(self) -> &'static str {
        match self {
            Self::WaitError => "wait-error",
            Self::LockFailure => "lock-failure",
            Self::MonitorDisconnected => "monitor-disconnected",
            Self::TasksAbsent => "tasks-absent",
        }
    }
}

/// First observed member or Harness-task failure carried into the report and journal.
///
/// `failed_member` uses the same tokens separated by `;`. The journal appends
/// the same tokens separated by spaces. Neither form includes raw output,
/// exception text, process ids, paths, or a status that was not observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemberFailure {
    subject: MemberFailureSubject,
    observation: MemberObservation,
}

/// Fixed start order used to name a child when the monitor only has process handles.
const MEMBER_ROLE_BY_START_INDEX: [MemberFailureSubject; 4] = [
    MemberFailureSubject::Containerd,
    MemberFailureSubject::Slirp4netns,
    MemberFailureSubject::Dockerd,
    MemberFailureSubject::OpenShellGateway,
];

impl MemberFailure {
    /// Records one already-classified subject and observation.
    pub(crate) const fn new(subject: MemberFailureSubject, observation: MemberObservation) -> Self {
        Self {
            subject,
            observation,
        }
    }

    /// Classifies one `try_wait` result for the child at this start-order index.
    ///
    /// `Ok(None)` means the child is still running. A missing role for the index
    /// stays `Unknown` rather than borrowing another member's name.
    fn from_child_wait(
        index: usize,
        waited: io::Result<Option<std::process::ExitStatus>>,
    ) -> Option<Self> {
        let subject = MEMBER_ROLE_BY_START_INDEX
            .get(index)
            .copied()
            .unwrap_or(MemberFailureSubject::Unknown);
        let observation = match waited {
            Ok(None) => return None,
            Ok(Some(status)) => observation_from_exit_status(status),
            Err(_) => MemberObservation::ProofUnavailable(MemberProofKind::WaitError),
        };
        Some(Self {
            subject,
            observation,
        })
    }

    /// Records only the failure class proved by the existing member observation.
    fn trace_failure(self) {
        let kind = match self.observation {
            MemberObservation::ExitCode(_) => "exit-code",
            MemberObservation::Signal(_) => "signal",
            MemberObservation::Finished => "finished",
            MemberObservation::ProofUnavailable(_) => "proof-unavailable",
        };
        let mut observation = crate::telemetry::Observation::start(
            "nanohost.member.failure",
            &Context::new(),
            vec![
                KeyValue::new("openkit.member", self.subject.token()),
                KeyValue::new("openkit.member.observation", kind),
            ],
            None,
        );
        observation.finish(false);
    }

    /// Returns the space-separated cause-line tokens for this observation.
    pub(crate) fn journal_tokens(self) -> String {
        let subject = self.subject.token();
        match self.observation {
            MemberObservation::ExitCode(code) => {
                format!("subject={subject} observation=exit-code code={code}")
            }
            MemberObservation::Signal(signal) => {
                format!("subject={subject} observation=signal signal={signal}")
            }
            MemberObservation::Finished => format!("subject={subject} observation=finished"),
            MemberObservation::ProofUnavailable(kind) => format!(
                "subject={subject} observation=proof-unavailable proof={}",
                kind.token()
            ),
        }
    }

    /// Returns the semicolon-separated `failed_member` report value.
    fn report_value(self) -> String {
        self.journal_tokens().replace(' ', ";")
    }
}

/// Maps a proved exit onto the closed code or signal range.
///
/// A status outside those ranges is a wait proof failure, not a guessed code.
fn observation_from_exit_status(status: std::process::ExitStatus) -> MemberObservation {
    use std::os::unix::process::ExitStatusExt;
    if let Some(code) = status.code() {
        return match u8::try_from(code) {
            Ok(code) => MemberObservation::ExitCode(code),
            Err(_) => MemberObservation::ProofUnavailable(MemberProofKind::WaitError),
        };
    }
    if let Some(signal) = status.signal()
        && (1..=64).contains(&signal)
    {
        return MemberObservation::Signal(signal as u8);
    }
    MemberObservation::ProofUnavailable(MemberProofKind::WaitError)
}

/// Failure classes that invalidate the entire Runtime Epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum EpochFault {
    /// At least one member failed during dependency-ordered startup.
    PartialStart,
    /// A running epoch member exited or its liveness proof failed.
    ///
    /// `None` is an OpenShell or not-ready bridge failure whose member identity
    /// was not observed. `Some` is the monitor's first bounded observation.
    MemberExited(Option<MemberFailure>),
    /// Observed runtime identity does not match the active epoch.
    IdentityMismatch,
    /// Sandbox creation outcome cannot be proved.
    CreateOutcomeUncertain(CreateUncertainty),
    /// Sandbox deletion outcome cannot be proved.
    DeleteOutcomeUncertain,
}

/// Closed runtime-effect vocabulary accepted from the authoritative NanoCore session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum RuntimeEffectKind {
    /// Creates one already-authorized sandbox.
    CreateSandbox,
    /// Deletes one already-authorized sandbox.
    DeleteSandbox,
    /// Opens the fixed Sandbox Integration bridge.
    OpenBridge,
    /// Closes the current Sandbox Integration bridge.
    CloseBridge,
    /// Acquires one exact attempt image reference.
    AcquireImage,
    /// Builds one immutable bounded attempt image.
    BuildImage,
    /// Exports one bounded file reference.
    ExportFile,
    /// Imports one immutable bounded reference.
    ImportReference,
    /// Inspects one exact verified local image.
    InspectImage,
    /// Inspects one exact retained storage association.
    InspectStorage,
    /// Purges one exact fenced storage association.
    PurgeStorage,
    /// Collects one read-only workspace snapshot pair.
    CollectWorkspace,
}

#[cfg_attr(not(test), allow(dead_code))]
impl RuntimeEffectKind {
    /// Parses the exact effect names admitted by the NanoHost boundary.
    ///
    /// # Errors
    ///
    /// Returns an error for commands, proxies, bulk bytes, and every unknown effect.
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "sandbox.create" => Ok(Self::CreateSandbox),
            "sandbox.delete" => Ok(Self::DeleteSandbox),
            "bridge.open" => Ok(Self::OpenBridge),
            "bridge.close" => Ok(Self::CloseBridge),
            "image.acquire" => Ok(Self::AcquireImage),
            "image.build" => Ok(Self::BuildImage),
            "file.export" => Ok(Self::ExportFile),
            "reference.import" => Ok(Self::ImportReference),
            "image.inspect" => Ok(Self::InspectImage),
            "storage.inspect" => Ok(Self::InspectStorage),
            "storage.purge" => Ok(Self::PurgeStorage),
            "workspace.collect" => Ok(Self::CollectWorkspace),
            _ => Err("runtime effect rejected"),
        }
    }
}

/// Required whole-process response to an epoch fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum EpochAction {
    /// Stop the whole NanoHost process and its epoch members.
    TerminateProcess,
}

impl EpochFault {
    /// Returns the fail-closed action for this fault.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn action(&self) -> EpochAction {
        EpochAction::TerminateProcess
    }
}

/// Preflights lifecycle effects against the exact retained single-Sandbox state.
///
/// A fresh-empty epoch can prove an old bridge and Sandbox already absent without
/// calling OpenShell. Live cleanup still proceeds through the ordinary owner,
/// while mismatched, partial, reordered, or auxiliary-bearing input fails closed.
/// A second create is rejected before OpenShell can produce an untracked Sandbox.
fn preflight_lifecycle_result(
    request: &LifecycleEffectRequest,
    current_sandbox_name: Option<&str>,
    bridge_present: bool,
    monitor_present: bool,
    auxiliary_input_present: bool,
) -> Result<Option<&'static str>, EpochFault> {
    if request.kind() == LifecycleEffectKind::CreateSandbox
        && (current_sandbox_name.is_some() || bridge_present || monitor_present)
    {
        return Err(EpochFault::IdentityMismatch);
    }
    let absent_result = match request.kind() {
        LifecycleEffectKind::CloseBridge => "closed",
        LifecycleEffectKind::DeleteSandbox => "deleted",
        _ => return Ok(None),
    };
    request
        .validate()
        .map_err(|_| EpochFault::IdentityMismatch)?;
    if auxiliary_input_present {
        return Err(EpochFault::IdentityMismatch);
    }
    let Some(current_sandbox_name) = current_sandbox_name else {
        return if bridge_present || monitor_present {
            Err(EpochFault::IdentityMismatch)
        } else {
            Ok(Some(absent_result))
        };
    };
    if current_sandbox_name != request.sandbox_id()
        || (request.kind() == LifecycleEffectKind::CloseBridge
            && (!bridge_present || !monitor_present))
        || (request.kind() == LifecycleEffectKind::DeleteSandbox && bridge_present)
    {
        return Err(EpochFault::IdentityMismatch);
    }
    Ok(None)
}

/// Hard bound for one attempt-local image import.
pub const MID_EPOCH_IMPORT_TIMEOUT: Duration = Duration::from_secs(45);

/// Attempt-local image import outcome.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptImportOutcome {
    /// The exact digest was already present in the current private backend.
    AlreadyPresent,
    /// Verified store content was imported and re-verified.
    Imported,
}

/// Fail-closed local image-import errors that do not invalidate a healthy epoch.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageImportError {
    /// Store content is missing, corrupt, or otherwise unusable.
    Store,
    /// The exact-image presence probe could not execute.
    Probe,
    /// The bounded stock Docker image load failed.
    Load,
    /// The exact post-load Docker inspection failed.
    Inspect,
    /// Post-import inspection did not return the exact requested digest.
    DigestMismatch,
}

impl From<StoreError> for ImageImportError {
    fn from(_: StoreError) -> Self {
        Self::Store
    }
}

/// Minimum private-backend image operations used by readiness and attempts.
#[cfg_attr(not(test), allow(dead_code))]
pub trait ImageBackend {
    /// Returns whether the exact digest is already installed.
    fn contains_digest(&mut self, digest: &str) -> Result<bool, ImageImportError>;

    /// Imports verified inert content within the caller's hard bound.
    fn import_verified(
        &mut self,
        digest: &str,
        content: File,
        timeout: Duration,
    ) -> Result<(), ImageImportError>;

    /// Returns the backend's exact installed image digest.
    fn inspect_digest(&mut self, digest: &str) -> Result<String, ImageImportError>;
}

/// Captures one small Docker metadata reply under the build and per-command bounds.
///
/// Output is nonblocking and capped, so an unavailable daemon or malformed reply
/// cannot hold the lifecycle owner indefinitely or allocate an unbounded buffer.
fn run_image_metadata_command(
    mut command: Command,
    deadline: Instant,
) -> Result<String, ImageImportError> {
    let deadline = deadline.min(Instant::now() + MID_EPOCH_IMPORT_TIMEOUT);
    if Instant::now() >= deadline {
        return Err(ImageImportError::Inspect);
    }
    let (mut stdout, writer) = UnixStream::pair().map_err(|_| ImageImportError::Inspect)?;
    stdout
        .set_nonblocking(true)
        .map_err(|_| ImageImportError::Inspect)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|_| ImageImportError::Inspect)?;
    drop(command);
    let result = (|| {
        let mut output = Vec::new();
        let mut buffer = [0_u8; 1024];
        let mut eof = false;
        loop {
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(count) => {
                        if output.len() + count > 8192 {
                            return Err(ImageImportError::Inspect);
                        }
                        output.extend_from_slice(&buffer[..count]);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(ImageImportError::Inspect),
                }
            }
            if Instant::now() >= deadline {
                return Err(ImageImportError::Inspect);
            }
            match child.try_wait() {
                Ok(Some(status)) if !status.success() => return Err(ImageImportError::Inspect),
                Ok(Some(_)) if eof => {
                    return String::from_utf8(output).map_err(|_| ImageImportError::Inspect);
                }
                Ok(_) => {}
                Err(_) => return Err(ImageImportError::Inspect),
            }
            thread::sleep(Duration::from_millis(5));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

/// Direct Docker CLI projection bound to the epoch-private socket.
pub struct DockerImageBackend {
    docker_socket: PathBuf,
}

impl DockerImageBackend {
    /// Creates one direct backend projection for the epoch-private daemon.
    pub fn new(docker_socket: PathBuf) -> Self {
        Self { docker_socket }
    }

    /// Returns the exact epoch-private Docker socket used by image effects.
    pub fn docker_socket(&self) -> &Path {
        &self.docker_socket
    }

    /// Builds a direct Docker command bound only to the epoch-private daemon.
    fn command(&self) -> Command {
        let mut command = Command::new("/usr/bin/docker");
        command.env(
            "DOCKER_HOST",
            format!("unix://{}", self.docker_socket.display()),
        );
        command
    }

    /// Reads the selected manifest descriptor, never a configuration ID or mutable tag identity.
    fn inspect_manifest(
        &self,
        reference: &str,
        deadline: Instant,
    ) -> Result<String, ImageImportError> {
        let mut command = self.command();
        command.args([
            "image",
            "inspect",
            "--format",
            "{{.Descriptor.digest}}",
            reference,
        ]);
        let output = run_image_metadata_command(command, deadline)?;
        let digest = output.trim();
        if !is_canonical_local_digest(digest) {
            return Err(ImageImportError::DigestMismatch);
        }
        Ok(digest.to_string())
    }

    /// Distinguishes a proved absent private alias from backend or binding uncertainty.
    fn retained_alias_digest(
        &self,
        alias: &str,
        deadline: Instant,
    ) -> Result<Option<String>, ImageImportError> {
        let filter = format!("reference={alias}");
        let mut command = self.command();
        command.args([
            "image",
            "ls",
            "--filter",
            &filter,
            "--format",
            "{{.Repository}}:{{.Tag}}",
        ]);
        let output = run_image_metadata_command(command, deadline)?;
        if output.is_empty() {
            return Ok(None);
        }
        if output.trim() != alias {
            return Err(ImageImportError::Inspect);
        }
        self.inspect_manifest(alias, deadline).map(Some)
    }

    /// Binds verified retained content without repairing or overwriting any existing alias.
    ///
    /// The caller supplies a naming-neutral, content-verified archive and the one
    /// whole-build deadline. Only the serialized lifecycle owner invokes this path.
    fn bind_retained_parent(
        &mut self,
        digest: &str,
        alias: &str,
        content: File,
        deadline: Instant,
    ) -> Result<(), ImageImportError> {
        if !is_canonical_local_digest(digest)
            || alias
                != retained_parent_alias(digest).map_err(|_| ImageImportError::DigestMismatch)?
        {
            return Err(ImageImportError::DigestMismatch);
        }
        if let Some(actual) = self.retained_alias_digest(alias, deadline)? {
            return if actual == digest {
                Ok(())
            } else {
                Err(ImageImportError::DigestMismatch)
            };
        }
        self.import_verified_before(content, deadline)?;
        if self.inspect_manifest(digest, deadline)? != digest {
            return Err(ImageImportError::DigestMismatch);
        }
        match self.retained_alias_digest(alias, deadline)? {
            Some(actual) if actual == digest => return Ok(()),
            Some(_) => return Err(ImageImportError::DigestMismatch),
            None => {}
        }
        let mut command = self.command();
        command.args(["image", "tag", digest, alias]);
        run_image_metadata_command(command, deadline)?;
        if self.retained_alias_digest(alias, deadline)?.as_deref() != Some(digest) {
            return Err(ImageImportError::DigestMismatch);
        }
        Ok(())
    }
    /// Loads verified content without extending the caller's absolute deadline.
    fn import_verified_before(
        &self,
        mut content: File,
        deadline: Instant,
    ) -> Result<(), ImageImportError> {
        let deadline = deadline.min(Instant::now() + MID_EPOCH_IMPORT_TIMEOUT);
        verify_raw_import_names_before(&mut content, deadline)
            .map_err(|_| ImageImportError::Load)?;
        if Instant::now() >= deadline {
            return Err(ImageImportError::Load);
        }
        let mut child = self
            .command()
            .args(["image", "load"])
            .stdin(Stdio::from(content))
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| ImageImportError::Load)?;
        if wait_for_child_success(&mut child, deadline) {
            Ok(())
        } else {
            Err(ImageImportError::Load)
        }
    }
}

impl ImageBackend for DockerImageBackend {
    /// Probes exact image presence without retrieval.
    fn contains_digest(&mut self, digest: &str) -> Result<bool, ImageImportError> {
        let status = self
            .command()
            .args(["image", "inspect", digest])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| ImageImportError::Probe)?;
        Ok(status.success())
    }

    /// Loads an OCI archive into the private daemon within the hard bound.
    fn import_verified(
        &mut self,
        _digest: &str,
        content: File,
        import_timeout: Duration,
    ) -> Result<(), ImageImportError> {
        self.import_verified_before(
            content,
            Instant::now() + import_timeout.min(MID_EPOCH_IMPORT_TIMEOUT),
        )
    }

    /// Re-verifies the installed manifest digest through the private daemon.
    fn inspect_digest(&mut self, digest: &str) -> Result<String, ImageImportError> {
        let actual = self.inspect_manifest(digest, Instant::now() + MID_EPOCH_IMPORT_TIMEOUT)?;
        if actual == digest {
            Ok(actual)
        } else {
            Err(ImageImportError::DigestMismatch)
        }
    }
}

/// Imports one already-authorized attempt digest without changing epoch identity.
///
/// # Errors
///
/// Returns an attempt-local failure for store failure, backend failure, timeout,
/// or post-import mismatch.
#[cfg_attr(not(test), allow(dead_code))]
pub fn import_attempt_image<B: ImageBackend>(
    store: &ImageStore,
    digest: &str,
    backend: &mut B,
) -> Result<AttemptImportOutcome, ImageImportError> {
    let content = store.read_verified(digest)?;
    if backend.contains_digest(digest)? {
        if backend.inspect_digest(digest)? != digest {
            return Err(ImageImportError::DigestMismatch);
        }
        return Ok(AttemptImportOutcome::AlreadyPresent);
    }
    backend.import_verified(digest, content, MID_EPOCH_IMPORT_TIMEOUT)?;
    if backend.inspect_digest(digest)? != digest {
        return Err(ImageImportError::DigestMismatch);
    }
    Ok(AttemptImportOutcome::Imported)
}

/// Returns whether an acquire reference is an exact local-only content digest.
fn is_canonical_local_digest(reference: &str) -> bool {
    reference.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

/// Requires a ready route and live retained response task for Harness readiness.
fn harness_bridge_is_live(
    bridge: Option<&OpenSandboxBridge>,
    bootstrap_monitor: Option<&WorkerBootstrapMonitor>,
) -> bool {
    bridge.is_some_and(OpenSandboxBridge::harness_ready)
        && bootstrap_monitor.is_some_and(WorkerBootstrapMonitor::is_live)
}

/// Owns all child processes in one fresh Runtime Epoch.
#[allow(dead_code)]
pub struct EpochCoordinator {
    monitor: EpochMemberMonitor,
    inspection_server: Option<crate::live_inspection::InspectionServer>,
    runtime: Handle,
    client: NanoHostOpenShellClient,
    image_store: ImageStore,
    image_backend: DockerImageBackend,
    persistent_volumes: PersistentVolumeStore,
    physical_epoch: String,
    /// Ended local startup observation; never a readiness or delivery witness.
    startup_context: opentelemetry::trace::SpanContext,
    run_root: PathBuf,
    file_staging_root: PathBuf,
    bridge: Option<OpenSandboxBridge>,
    route_projection: OuterRouteProjection,
    current_sandbox: Option<SandboxRef>,
    worker_bootstrap_monitor: Option<WorkerBootstrapMonitor>,
    #[cfg(test)]
    collection_scan_root: PathBuf,
    #[cfg(test)]
    collection_test_sandbox: Option<String>,
}

/// Sole owner of Runtime Epoch member handles and whole-group fencing.
struct EpochMemberMonitor {
    fence: mpsc::SyncSender<Option<EpochFault>>,
    member_failure: mpsc::Receiver<EpochFault>,
    worker: Option<JoinHandle<()>>,
    harness_tasks: Arc<Mutex<Option<(AbortHandle, AbortHandle)>>>,
    readiness: Arc<AtomicU8>,
    inspection: Option<Arc<crate::live_inspection::InspectionState>>,
}

/// Child-handle aggregate whose normal drop always kills and reaps the group.
struct OwnedEpochChildren {
    children: Vec<Child>,
    private_namespaces: Option<PrivateNamespaceDescriptors>,
}

/// Retains the exact network and mount namespaces created by containerd.
struct PrivateNamespaceDescriptors {
    network: Arc<OwnedFd>,
    mount: Arc<OwnedFd>,
}

/// Incarnation-bound private report inputs; no path, command line or output is retained.
struct MemberInventory {
    role: MemberFailureSubject,
    pid: u32,
    process: Option<File>,
    status: serde_json::Value,
}

impl MemberInventory {
    /// Pins procfs while the unreaped child handle still prevents PID reuse.
    fn pin(index: usize, child: &mut Child) -> Self {
        let process = (|| {
            if child.try_wait().ok()?.is_some() {
                return None;
            }
            let process = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(format!("/proc/{}", child.id()))
                .ok()?;
            if child.try_wait().ok()?.is_some() {
                return None;
            }
            Some(process)
        })();
        Self {
            role: MEMBER_ROLE_BY_START_INDEX
                .get(index)
                .copied()
                .unwrap_or(MemberFailureSubject::Unknown),
            pid: child.id(),
            process,
            status: serde_json::json!({"state": "unavailable"}),
        }
    }

    /// Keeps actual pre-fence wait observations distinct from later group termination.
    fn observe_status(&mut self, child: &mut Child) {
        self.status = match child.try_wait() {
            Ok(None) => serde_json::json!({"state": "running"}),
            Ok(Some(status)) => match observation_from_exit_status(status) {
                MemberObservation::ExitCode(code) => {
                    serde_json::json!({"state": "exited", "code": code})
                }
                MemberObservation::Signal(signal) => {
                    serde_json::json!({"state": "signaled", "signal": signal})
                }
                _ => serde_json::json!({"state": "unavailable"}),
            },
            Err(_) => serde_json::json!({"state": "unavailable"}),
        };
    }

    /// Measures only the pinned process in the bounded export worker, never a reused PID.
    fn report(
        self,
        #[cfg(test)] before_recheck: Option<&(dyn Fn() + Send + Sync)>,
    ) -> serde_json::Value {
        let mut binary = serde_json::json!("unavailable");
        let mut cgroup = serde_json::json!("unavailable");
        if let Some(process) = self.process {
            let measured = (|| {
                let image = open_process_entry(&process, c"exe")?;
                let before = image.metadata().ok()?;
                if !before.is_file() {
                    return None;
                }
                #[cfg(test)]
                if let Some(hook) = before_recheck {
                    hook();
                }
                let membership = read_process_cgroup(&process);
                let group = membership
                    .as_ref()
                    .and_then(|bytes| resolve_member_cgroup(bytes));
                let after = open_process_entry(&process, c"exe")?.metadata().ok()?;
                let unchanged = |left: &fs::Metadata, right: &fs::Metadata| {
                    left.dev() == right.dev()
                        && left.ino() == right.ino()
                        && left.len() == right.len()
                        && left.ctime() == right.ctime()
                        && left.ctime_nsec() == right.ctime_nsec()
                };
                if !unchanged(&before, &after) || !unchanged(&before, &image.metadata().ok()?) {
                    return None;
                }
                let group = group.filter(|_| membership == read_process_cgroup(&process));
                Some((before, group))
            })();
            if let Some((image, group)) = measured {
                binary = serde_json::json!({
                    "device": image.dev(), "inode": image.ino(), "size": image.len(),
                });
                if let Some(group) = group {
                    cgroup = serde_json::json!({"device": group.dev(), "inode": group.ino()});
                }
            }
        }
        serde_json::json!({
            "role": self.role.token(), "pid": self.pid, "binary": binary,
            "version": "unavailable", "cgroup": cgroup, "status": self.status,
        })
    }
}

/// Opens a fixed virtual process entry relative to the retained incarnation, including its exe link.
fn open_process_entry(process: &File, entry: &std::ffi::CStr) -> Option<File> {
    // SAFETY: the directory remains owned, the entry is a fixed NUL-terminated name,
    // and a successful call transfers one new descriptor into File ownership.
    let fd = unsafe {
        libc::openat(
            process.as_raw_fd(),
            entry.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

/// Reads only a bounded kernel cgroup membership projection, with no retained path text.
fn read_process_cgroup(process: &File) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    open_process_entry(process, c"cgroup")?
        .take(8193)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= 8192).then_some(bytes)
}

/// Resolves an exact unified membership to filesystem identity; unsupported namespaces stay unknown.
#[cfg(target_os = "linux")]
fn resolve_member_cgroup(bytes: &[u8]) -> Option<fs::Metadata> {
    let source = std::str::from_utf8(bytes).ok()?;
    let mut records = source.lines();
    let path = records.next()?.strip_prefix("0::/")?;
    if records.next().is_some() {
        return None;
    }
    // A subtree mount cannot resolve a hierarchy-absolute membership by simple joining.
    // Require the exact unified hierarchy root rather than guess a namespace translation.
    let mut mounts = String::new();
    File::open("/proc/self/mountinfo")
        .ok()?
        .take(262145)
        .read_to_string(&mut mounts)
        .ok()?;
    if mounts.len() > 262144 {
        return None;
    }
    let matching_mounts = mounts
        .lines()
        .filter(|line| {
            let Some((mount, filesystem)) = line.split_once(" - ") else {
                return false;
            };
            let fields = mount.split_ascii_whitespace().collect::<Vec<_>>();
            fields.get(3) == Some(&"/")
                && fields.get(4) == Some(&"/sys/fs/cgroup")
                && filesystem.split_ascii_whitespace().next() == Some("cgroup2")
        })
        .count();
    if matching_mounts != 1 {
        return None;
    }
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/sys/fs/cgroup")
        .ok()?;
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: the descriptor and output allocation remain valid during fstatfs.
    // A successful return initializes the output; only then is the second condition evaluated.
    if unsafe { libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) } != 0
        || unsafe { filesystem.assume_init() }.f_type != libc::CGROUP2_SUPER_MAGIC
    {
        return None;
    }
    for component in path.split('/').filter(|component| !component.is_empty()) {
        if component == "." || component == ".." {
            return None;
        }
        let component = CString::new(component).ok()?;
        // SAFETY: the retained parent descriptor and component live through openat;
        // no symlink can redirect a component outside the observed hierarchy.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return None;
        }
        // SAFETY: a successful openat transfers one new owned descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    directory.metadata().ok()
}

/// Keeps Linux cgroup proof unavailable on other Unix development hosts.
#[cfg(not(target_os = "linux"))]
fn resolve_member_cgroup(_bytes: &[u8]) -> Option<fs::Metadata> {
    None
}

impl Drop for OwnedEpochChildren {
    /// Performs normal fail-stop teardown without creating invalidation evidence.
    fn drop(&mut self) {
        terminate_children(&mut self.children);
        self.private_namespaces.take();
    }
}

impl EpochMemberMonitor {
    /// Starts the one monitor that owns every member handle during long effects.
    #[allow(dead_code)]
    fn start(children: Vec<Child>, evidence: EpochEvidenceWriter) -> Self {
        Self::start_with_namespaces(
            children,
            None,
            evidence,
            PathBuf::from(REBUILD_FENCE_STARTED_PATH),
            Arc::new(AtomicU8::new(ReadinessProof::Unavailable as u8)),
            None,
        )
    }

    /// Starts the monitor while retaining the proved private namespace descriptors.
    fn start_with_namespaces(
        mut children: Vec<Child>,
        private_namespaces: Option<PrivateNamespaceDescriptors>,
        evidence: EpochEvidenceWriter,
        fence_started_path: PathBuf,
        readiness: Arc<AtomicU8>,
        inspection: Option<Arc<crate::live_inspection::InspectionState>>,
    ) -> Self {
        let inventory = children
            .iter_mut()
            .enumerate()
            .map(|(index, child)| MemberInventory::pin(index, child))
            .collect();
        let (fence, fence_rx) = mpsc::sync_channel(1);
        let (failure_tx, member_failure) = mpsc::sync_channel(1);
        let harness_tasks = Arc::new(Mutex::new(None));
        let watched_tasks = Arc::clone(&harness_tasks);
        let observed_readiness = Arc::clone(&readiness);
        let observed_inspection = inspection.clone();
        let worker = thread::spawn(move || {
            let mut children = OwnedEpochChildren {
                children,
                private_namespaces,
            };
            if let Some(fault) =
                Self::observe_members(&mut children.children, &fence_rx, &watched_tasks)
            {
                if let Some(inspection) = &observed_inspection {
                    inspection.close();
                }
                fence_initiated(
                    &evidence,
                    &mut children.children,
                    &fault,
                    fence_started_path,
                    &observed_readiness,
                    inventory,
                );
                let _ = failure_tx.send(fault);
            }
        });
        Self {
            fence,
            member_failure,
            worker: Some(worker),
            harness_tasks,
            readiness,
            inspection,
        }
    }

    /// Runs the existing member observation loop independently of outer-session polling.
    ///
    /// The first watched-task failure wins over a child, and the first non-running
    /// child in start order wins over later children. A requested fence fault is
    /// returned unchanged.
    fn observe_members(
        children: &mut [Child],
        requests: &mpsc::Receiver<Option<EpochFault>>,
        harness_tasks: &Mutex<Option<(AbortHandle, AbortHandle)>>,
    ) -> Option<EpochFault> {
        loop {
            if let Some(failure) = Self::watched_task_failure(harness_tasks) {
                failure.trace_failure();
                return Some(EpochFault::MemberExited(Some(failure)));
            }
            for (index, child) in children.iter_mut().enumerate() {
                if let Some(failure) = MemberFailure::from_child_wait(index, child.try_wait()) {
                    failure.trace_failure();
                    return Some(EpochFault::MemberExited(Some(failure)));
                }
            }
            match requests.recv_timeout(Duration::from_millis(50)) {
                Ok(fault) => return fault,
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    /// Classifies a poisoned lock or the first finished watched task.
    ///
    /// Response is checked before route. An unwatched pair is not a failure.
    fn watched_task_failure(
        tasks: &Mutex<Option<(AbortHandle, AbortHandle)>>,
    ) -> Option<MemberFailure> {
        match tasks.lock() {
            Err(_) => Some(MemberFailure::new(
                MemberFailureSubject::Unknown,
                MemberObservation::ProofUnavailable(MemberProofKind::LockFailure),
            )),
            Ok(tasks) => tasks.as_ref().and_then(finished_watched_task),
        }
    }

    /// Retains the exact response and route task proofs beside the existing child monitor.
    fn watch_harness(&self, bootstrap: &WorkerBootstrapMonitor) -> Result<(), EpochFault> {
        let tasks = bootstrap
            .task_handles()
            .ok_or(EpochFault::IdentityMismatch)?;
        if let Some(failure) = finished_watched_task(&tasks) {
            return Err(EpochFault::MemberExited(Some(failure)));
        }
        match self.harness_tasks.lock() {
            Ok(mut slot) => {
                *slot = Some(tasks);
                Ok(())
            }
            Err(_) => Err(EpochFault::MemberExited(Some(MemberFailure::new(
                MemberFailureSubject::Unknown,
                MemberObservation::ProofUnavailable(MemberProofKind::LockFailure),
            )))),
        }
    }

    /// Establishes the explicit-close exemption before bridge ownership is removed.
    fn begin_bridge_close(&self) -> Result<(), EpochFault> {
        let mut tasks = match self.harness_tasks.lock() {
            Ok(tasks) => tasks,
            Err(_) => {
                return Err(EpochFault::MemberExited(Some(MemberFailure::new(
                    MemberFailureSubject::Unknown,
                    MemberObservation::ProofUnavailable(MemberProofKind::LockFailure),
                ))));
            }
        };
        if tasks.is_none() {
            return Err(EpochFault::MemberExited(Some(MemberFailure::new(
                MemberFailureSubject::Unknown,
                MemberObservation::ProofUnavailable(MemberProofKind::TasksAbsent),
            ))));
        }
        if let Some(failure) = tasks.as_ref().and_then(finished_watched_task) {
            return Err(EpochFault::MemberExited(Some(failure)));
        }
        tasks.take();
        Ok(())
    }

    /// Waits asynchronously for the continuously observed member-failure event.
    async fn member_failure(&self) -> EpochFault {
        loop {
            match self.member_failure.try_recv() {
                Ok(fault) => return fault,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return EpochFault::MemberExited(Some(MemberFailure::new(
                        MemberFailureSubject::Unknown,
                        MemberObservation::ProofUnavailable(MemberProofKind::MonitorDisconnected),
                    )));
                }
                Err(mpsc::TryRecvError::Empty) => sleep(Duration::from_millis(50)).await,
            }
        }
    }

    /// Joins the existing fence before a completed local effect can publish its result.
    fn check_liveness(&mut self) -> Result<(), EpochFault> {
        let fault = match self.member_failure.try_recv() {
            Ok(fault) => Some(fault),
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(EpochFault::MemberExited(Some(MemberFailure::new(
                    MemberFailureSubject::Unknown,
                    MemberObservation::ProofUnavailable(MemberProofKind::MonitorDisconnected),
                ))))
            }
            Err(mpsc::TryRecvError::Empty) => Self::watched_task_failure(&self.harness_tasks)
                .map(|failure| EpochFault::MemberExited(Some(failure))),
        };
        if let Some(fault) = fault {
            self.fence(fault.clone());
            return Err(self.member_failure.try_recv().unwrap_or(fault));
        }
        Ok(())
    }

    /// Requests one export-before-fence and waits for complete sibling reap.
    fn fence(&mut self, fault: EpochFault) {
        if let Some(inspection) = &self.inspection {
            inspection.close();
        }
        let _ = self.fence.send(Some(fault));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }

    /// Requests the existing partial-start invalidation path before readiness.
    fn invalidate_startup(&mut self) {
        self.fence(EpochFault::PartialStart);
    }

    /// Stops and joins every epoch member before host-side attachments are released.
    #[allow(dead_code)]
    fn stop(&mut self) {
        if let Some(inspection) = &self.inspection {
            inspection.close();
        }
        if self.worker.is_some() {
            let _ = self.fence.send(None);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for EpochMemberMonitor {
    /// Performs normal whole-group termination exactly once.
    fn drop(&mut self) {
        if let Some(inspection) = &self.inspection {
            inspection.close();
        }
        if self.worker.is_some() {
            let _ = self.fence.send(None);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Gives contract tests their own paths and children while retaining the actual monitor and fence.
#[cfg(test)]
pub(crate) struct InventoryMonitorFixture(EpochMemberMonitor);

#[cfg(test)]
impl InventoryMonitorFixture {
    /// Starts fixed-order owned children with a private evidence root and optional blocked export.
    pub(crate) fn start(
        children: Vec<Child>,
        root: &Path,
        before_export: Option<Arc<dyn Fn() + Send + Sync>>,
        inventory_recheck: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        let mut evidence = EpochEvidenceWriter::new(root.join("reports")).unwrap();
        evidence.inventory_recheck = inventory_recheck;
        if let Some(hook) = before_export {
            evidence.before_export(hook);
        }
        Self(EpochMemberMonitor::start_with_namespaces(
            children,
            None,
            evidence,
            root.join("fence-started"),
            Arc::new(AtomicU8::new(ReadinessProof::Unavailable as u8)),
            None,
        ))
    }

    /// Requests the existing explicit fault and waits for all owned children to be reaped.
    pub(crate) fn fence(&mut self) {
        self.0.fence(EpochFault::IdentityMismatch);
    }

    /// Waits for the production monitor's first cause after its complete fence.
    pub(crate) fn failure(&self, limit: Duration) -> Option<String> {
        match self.0.member_failure.recv_timeout(limit).ok()? {
            EpochFault::MemberExited(Some(failure)) => Some(failure.report_value()),
            _ => None,
        }
    }
}

impl EpochCoordinator {
    /// Creates restrictive fresh directories and starts every member in order.
    ///
    /// # Errors
    ///
    /// Returns [`EpochFault::PartialStart`] after stopping every child already
    /// started when setup or member start fails.
    pub fn start(
        plan: &EpochPlan,
        mut client: NanoHostOpenShellClient,
        evidence: EpochEvidenceWriter,
        image_store: &mut Option<ImageStore>,
        image_backend: &mut Option<DockerImageBackend>,
        persistent_volumes: &mut Option<PersistentVolumeStore>,
    ) -> Result<Self, EpochFault> {
        let mut startup = crate::telemetry::Observation::start(
            "nanohost.epoch.start",
            &Context::new(),
            Vec::new(),
            None,
        );
        let _active = startup.context().attach();
        let physical_epoch = physical_epoch_for_plan(plan);
        let image_store = image_store.take().ok_or(EpochFault::PartialStart)?;
        let image_backend = image_backend.take().ok_or(EpochFault::PartialStart)?;
        let persistent_volumes = persistent_volumes.take().ok_or(EpochFault::PartialStart)?;
        let mut children = Vec::with_capacity(plan.members().len());
        let readiness = Arc::new(AtomicU8::new(ReadinessProof::Unavailable as u8));
        let runtime = {
            let fence_failed_startup = |fault: EpochFault, children: &mut [Child]| {
                fence_startup_failure(
                    &evidence,
                    children,
                    &fault,
                    PathBuf::from(REBUILD_FENCE_STARTED_PATH),
                    &readiness,
                );
            };
            if create_private_dir(plan.epoch_root()).is_err() {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            if create_private_dir(plan.run_root()).is_err() {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            readiness.store(ReadinessProof::PrivateRoots as u8, Ordering::Release);
            let resolver_target = match fs::canonicalize("/etc/resolv.conf") {
                Ok(path) if path.is_file() => path,
                _ => {
                    fence_failed_startup(EpochFault::PartialStart, &mut children);
                    return Err(EpochFault::PartialStart);
                }
            };
            if !generate_gateway_auth(plan)
                || write_private_file(&plan.gateway_config_path, plan.gateway_config_contents())
                    .is_err()
                || write_private_file(plan.resolver_path(), plan.resolver_contents()).is_err()
            {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            readiness.store(ReadinessProof::Configuration as u8, Ordering::Release);

            let runtime = Handle::current();

            if spawn_member(
                &mut children,
                &plan.members()[0],
                None,
                Some((plan.resolver_path(), &resolver_target)),
            )
            .is_err()
            {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            let private_namespaces = match children
                .last_mut()
                .ok_or(EpochFault::PartialStart)
                .and_then(|child| {
                    retain_private_namespaces(child).map_err(|_| EpochFault::PartialStart)
                }) {
                Ok(descriptor) => descriptor,
                Err(fault) => {
                    fence_failed_startup(fault.clone(), &mut children);
                    return Err(fault);
                }
            };
            let containerd_ready = children
                .last_mut()
                .is_some_and(|child| wait_for_socket(child, plan.containerd_socket()));
            if !containerd_ready {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            readiness.store(ReadinessProof::ContainerdSocket as u8, Ordering::Release);

            let slirp_ready = match spawn_member(
                &mut children,
                &plan.members()[1],
                Some(&private_namespaces),
                None,
            ) {
                Ok(Some(ready_reader)) => children.last_mut().is_some_and(|child| {
                    wait_for_slirp_ready(
                        child,
                        ready_reader,
                        Arc::clone(&private_namespaces.network),
                    )
                }),
                Ok(None) | Err(_) => false,
            };
            let containerd_running = children
                .first_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
            if !slirp_ready || !containerd_running {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            readiness.store(ReadinessProof::PrivateNetwork as u8, Ordering::Release);

            if spawn_member(
                &mut children,
                &plan.members()[2],
                Some(&private_namespaces),
                None,
            )
            .is_err()
            {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            let dockerd_ready = children.last_mut().is_some_and(|child| {
                wait_for_member_namespaces(child, &private_namespaces)
                    && wait_for_socket(child, plan.docker_socket())
            });
            let containerd_running = children
                .first_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
            if !dockerd_ready || !containerd_running {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            readiness.store(ReadinessProof::DockerSocket as u8, Ordering::Release);

            if spawn_member(
                &mut children,
                &plan.members()[3],
                Some(&private_namespaces),
                None,
            )
            .is_err()
                || !children
                    .last_mut()
                    .is_some_and(|child| wait_for_member_namespaces(child, &private_namespaces))
                || !children
                    .first_mut()
                    .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
            {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }
            if client
                .bind_network_namespace(Arc::clone(&private_namespaces.network))
                .is_err()
            {
                fence_failed_startup(EpochFault::PartialStart, &mut children);
                return Err(EpochFault::PartialStart);
            }

            let health = tokio::task::block_in_place(|| {
                runtime.block_on(async {
                    timeout(STARTUP_TIMEOUT, async {
                        loop {
                            let readiness = match client.connect().await {
                                Ok(()) => client.health().await,
                                Err(fault) => Err(fault),
                            };
                            match readiness {
                                Ok(()) => break Ok(()),
                                Err(EpochFault::IdentityMismatch) => {
                                    break Err(EpochFault::IdentityMismatch);
                                }
                                Err(EpochFault::PartialStart | EpochFault::MemberExited(_)) => {
                                    sleep(Duration::from_millis(50)).await;
                                }
                                Err(fault) => break Err(fault),
                            }
                        }
                    })
                    .await
                })
            });
            let members_running = children
                .iter_mut()
                .all(|child| matches!(child.try_wait(), Ok(None)));
            if !matches!(health, Ok(Ok(()))) || !members_running {
                let fault = match health {
                    Ok(Err(fault)) => fault,
                    Err(_) | Ok(Ok(())) => EpochFault::PartialStart,
                };
                fence_failed_startup(fault.clone(), &mut children);
                return Err(fault);
            }
            readiness.store(ReadinessProof::GatewayHealth as u8, Ordering::Release);
            (runtime, private_namespaces)
        };

        let (runtime, private_namespaces) = runtime;
        // The handle comes from the owned Gateway child after its health proof.
        let inspection = children.last().and_then(|gateway| {
            crate::live_inspection::InspectionState::new(physical_epoch.clone(), gateway.id()).ok()
        });
        let inspection_server = inspection.as_ref().and_then(|state| {
            crate::live_inspection::InspectionServer::start(Arc::clone(state)).ok()
        });

        let startup_context = startup.context().span().span_context().clone();
        // Local Gateway health ends startup; later Core acknowledgement owns readiness.
        startup.finish(true);
        Ok(Self {
            monitor: EpochMemberMonitor::start_with_namespaces(
                children,
                Some(private_namespaces),
                evidence,
                PathBuf::from(REBUILD_FENCE_STARTED_PATH),
                readiness,
                inspection,
            ),
            inspection_server,
            runtime,
            client,
            image_store,
            image_backend,
            persistent_volumes,
            physical_epoch,
            startup_context,
            run_root: plan.run_root().to_path_buf(),
            file_staging_root: plan.epoch_root().join("file-transfer"),
            bridge: None,
            route_projection: OuterRouteProjection::new(),
            current_sandbox: None,
            worker_bootstrap_monitor: None,
            #[cfg(test)]
            collection_scan_root: PathBuf::from(crate::workspace_collect::WORKSPACE_SCAN_ROOT),
            #[cfg(test)]
            collection_test_sandbox: None,
        })
    }

    /// Returns only the ended startup context for one optional later-effect link.
    pub(crate) fn startup_context(&self) -> &opentelemetry::trace::SpanContext {
        &self.startup_context
    }

    /// Returns the private physical-incarnation witness retained by this coordinator.
    pub fn physical_epoch(&self) -> &str {
        &self.physical_epoch
    }

    /// Shares only the ephemeral operator observation with native connection carriage.
    pub(crate) fn inspection_state(&self) -> Option<Arc<crate::live_inspection::InspectionState>> {
        self.monitor.inspection.clone()
    }

    /// Records a completed Core acknowledgement for reports, never as readiness authority.
    pub fn record_readiness_acknowledgement(&self) {
        self.monitor
            .readiness
            .store(ReadinessProof::CoreAcknowledgement as u8, Ordering::Release);
    }

    /// Returns the epoch-retained outer route projection for successor rebinding.
    pub fn outer_route_projection(&self) -> OuterRouteProjection {
        self.route_projection.clone()
    }

    /// Returns the exact current ready Sandbox name for static bridge composition.
    pub fn current_sandbox_name(&self) -> Result<&str, EpochFault> {
        #[cfg(test)]
        if let Some(name) = &self.collection_test_sandbox {
            return Ok(name);
        }
        self.current_sandbox
            .as_ref()
            .map(|sandbox| sandbox.name.as_str())
            .ok_or(EpochFault::IdentityMismatch)
    }

    /// Returns the fixed private store root; fixtures substitute only its placement.
    pub(crate) fn collection_scan_root(&self) -> &Path {
        #[cfg(test)]
        {
            &self.collection_scan_root
        }
        #[cfg(not(test))]
        {
            Path::new(crate::workspace_collect::WORKSPACE_SCAN_ROOT)
        }
    }

    /// Builds admitted metadata and a ready identity projection without a deployed Sandbox.
    #[cfg(test)]
    pub(crate) fn collection_fixture(root: &Path) -> (Self, PathBuf) {
        let persistent_volumes = crate::persistent_volume::tests::test_store(&root.join("volumes"));
        let (_, volume) = crate::persistent_volume::tests::stored_association(
            &persistent_volumes,
            "storage-one",
            "sandbox-one",
            1,
        );
        let worktree = volume.join("worktrees/slotA");
        fs::create_dir_all(&worktree).unwrap();
        let (fence, _) = mpsc::sync_channel(1);
        let (_, member_failure) = mpsc::sync_channel(1);
        (
            Self {
                monitor: EpochMemberMonitor {
                    fence,
                    member_failure,
                    worker: None,
                    harness_tasks: Arc::new(Mutex::new(None)),
                    readiness: Arc::new(AtomicU8::new(ReadinessProof::Unavailable as u8)),
                    inspection: None,
                },
                inspection_server: None,
                runtime: Handle::current(),
                client: NanoHostOpenShellClient::new(
                    "http://127.0.0.1:1".into(),
                    root.join("missing-auth"),
                ),
                image_store: ImageStore::open(root.join("images"), root.join("epoch"), &[])
                    .unwrap(),
                image_backend: DockerImageBackend::new(root.join("missing-docker")),
                persistent_volumes,
                physical_epoch: "a".repeat(64),
                startup_context: opentelemetry::trace::SpanContext::empty_context(),
                run_root: root.join("epoch"),
                file_staging_root: root.join("file-transfer"),
                bridge: None,
                route_projection: OuterRouteProjection::new(),
                current_sandbox: None,
                worker_bootstrap_monitor: None,
                collection_scan_root: root.join("scans"),
                collection_test_sandbox: Some("sandbox-one".into()),
            },
            worktree,
        )
    }

    /// Uses the production invalidation monitor with only fixture-owned report and marker paths.
    #[cfg(test)]
    pub(crate) fn fixture_invalidation_reports(&mut self, root: &Path) -> PathBuf {
        let reports = root.join("reports");
        let evidence = EpochEvidenceWriter::new(reports.clone()).expect("fixture evidence root");
        self.monitor = EpochMemberMonitor::start_with_namespaces(
            Vec::new(),
            None,
            evidence,
            root.join("fence-started"),
            Arc::clone(&self.monitor.readiness),
            self.monitor.inspection.clone(),
        );
        reports
    }

    /// Injects a fault through the real monitor's report-before-fence path.
    #[cfg(test)]
    pub(crate) fn fixture_invalidation_requester(&self) -> mpsc::SyncSender<Option<EpochFault>> {
        self.monitor.fence.clone()
    }

    /// Proves live-epoch identity before the storage owner opens worker-controlled children.
    pub fn resolve_collection(
        &self,
        command: &crate::workspace_collect::CollectCommand,
    ) -> Result<crate::persistent_volume::CollectionWorktree, &'static str> {
        if self
            .current_sandbox_name()
            .map_err(|_| "collection epoch unproved")?
            != command.sandbox_id.as_str()
        {
            return Err("collection sandbox unproved");
        }
        self.persistent_volumes.resolve_collection(command)
    }

    /// Inspects one exact verified local image without acquisition.
    pub fn inspect_image(&self, digest: &str) -> Result<serde_json::Value, &'static str> {
        self.persistent_volumes
            .inspect_image(digest)
            .map(|layout| layout.result_json())
    }

    /// Verifies the selected image and prepares one exact retained attachment.
    pub fn prepare_storage(
        &mut self,
        sandbox_id: &str,
        image_digest: &str,
        request: &StorageAttachmentRequest,
    ) -> Result<Vec<StorageMount>, &'static str> {
        let layout = self.persistent_volumes.inspect_image(image_digest)?;
        self.persistent_volumes.attach(sandbox_id, request, &layout)
    }

    /// Inspects one exact association without creating or mounting it.
    pub fn inspect_storage(
        &self,
        storage_ref: &str,
        attachment_generation: u64,
    ) -> serde_json::Value {
        self.persistent_volumes
            .inspect(storage_ref, attachment_generation)
    }

    /// Purges one exact detached association through the local partial-removal fence.
    pub fn purge_storage(
        &mut self,
        storage_ref: &str,
        attachment_generation: u64,
    ) -> serde_json::Value {
        self.persistent_volumes
            .purge(storage_ref, attachment_generation)
    }

    /// Returns whether the accepted Harness bridge and its lifetime monitor remain live.
    pub fn has_live_bridge(&self) -> bool {
        harness_bridge_is_live(self.bridge.as_ref(), self.worker_bootstrap_monitor.as_ref())
    }

    /// Deletes the current sandbox after static bridge command delivery becomes unknown.
    ///
    /// # Errors
    ///
    /// Returns and fences on unproved deletion or an impossible live-bridge state.
    pub fn discard_unknown_bridge_command(&mut self) -> Result<(), EpochFault> {
        if self.bridge.is_some() || self.worker_bootstrap_monitor.is_some() {
            return self.settle(Err(EpochFault::IdentityMismatch));
        }
        let sandbox = self
            .current_sandbox
            .clone()
            .ok_or(EpochFault::IdentityMismatch)?;
        let deletion = tokio::task::block_in_place(|| {
            self.runtime.block_on(
                self.client
                    .delete_sandbox(&sandbox.name, Duration::from_secs(120)),
            )
        });
        self.settle(deletion)?;
        self.current_sandbox = None;
        Ok(())
    }

    /// Creates a sandbox and invalidates the epoch unless its outcome is proved.
    ///
    /// # Errors
    ///
    /// Returns the fail-stop lifecycle fault after terminating all members.
    #[allow(dead_code)]
    pub fn create_sandbox(
        &mut self,
        spec: SandboxSpec,
        policy: SandboxPolicy,
        attempt_lineage: &str,
    ) -> Result<SandboxRef, EpochFault> {
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(
                self.client
                    .create_sandbox(spec, policy, attempt_lineage, &[]),
            )
        });
        self.settle(result)
    }

    /// Gets a sandbox and invalidates the epoch on transport or identity failure.
    ///
    /// # Errors
    ///
    /// Returns the fail-stop lifecycle fault after terminating all members.
    #[allow(dead_code)]
    pub fn get_sandbox(&mut self, name: &str) -> Result<SandboxRef, EpochFault> {
        let result =
            tokio::task::block_in_place(|| self.runtime.block_on(self.client.get_sandbox(name)));
        self.settle(result)
    }

    /// Lists sandboxes and invalidates the epoch on transport or identity failure.
    ///
    /// # Errors
    ///
    /// Returns the fail-stop lifecycle fault after terminating all members.
    #[allow(dead_code)]
    pub fn list_sandboxes(&mut self, options: ListOptions) -> Result<Vec<SandboxRef>, EpochFault> {
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(self.client.list_sandboxes(options))
        });
        self.settle(result)
    }

    /// Settles one definite native Sandbox deletion before releasing retained state.
    ///
    /// Exact Sandbox absence is the fallback fence when the optional Harness-lifetime
    /// monitor cannot prove its own clean completion.
    fn settle_definite_sandbox_deletion(&mut self, name: &str) -> Result<(), EpochFault> {
        let exact_current_sandbox = self
            .current_sandbox
            .as_ref()
            .is_some_and(|sandbox| sandbox.name.as_str() == name);
        if !exact_current_sandbox {
            return self.settle(Err(EpochFault::IdentityMismatch));
        }
        if let Some(exec_monitor) = self.worker_bootstrap_monitor.take() {
            exec_monitor.discard_after_sandbox_deletion();
        }
        self.current_sandbox = None;
        Ok(())
    }

    /// Exempts expected task completion before deleting the exact current Sandbox.
    ///
    /// File-effect cleanup can delete a Sandbox with its bridge still live. Reuse
    /// explicit-close admission under the task lock, but retain the bootstrap
    /// monitor until native deletion proves absence.
    fn begin_sandbox_deletion(&mut self, name: &str) -> Result<(), EpochFault> {
        if !self
            .current_sandbox_name()
            .is_ok_and(|current| current == name)
        {
            return self.settle(Err(EpochFault::IdentityMismatch));
        }
        if self.bridge.is_some() {
            let close = self.monitor.begin_bridge_close();
            self.settle(close)?;
            self.bridge = None;
        }
        Ok(())
    }

    /// Deletes a sandbox and invalidates the epoch unless absence is proved.
    ///
    /// # Errors
    ///
    /// Returns the fail-stop lifecycle fault after terminating all members.
    #[allow(dead_code)]
    pub fn delete_sandbox(
        &mut self,
        name: &str,
        deletion_timeout: Duration,
    ) -> Result<(), EpochFault> {
        self.begin_sandbox_deletion(name)?;
        let result = tokio::task::block_in_place(|| {
            self.runtime
                .block_on(self.client.delete_sandbox(name, deletion_timeout))
        });
        self.settle(result)?;
        self.settle_definite_sandbox_deletion(name)
    }

    /// Calls the existing lifecycle owner and retains only the one live bridge.
    ///
    /// # Errors
    ///
    /// Returns the existing fail-stop lifecycle fault after the monitor fences
    /// every member on an uncertain or identity-mismatched effect.
    pub fn execute_lifecycle_effect(
        &mut self,
        request: &LifecycleEffectRequest,
        create_spec: Option<SandboxSpec>,
        create_policy: Option<SandboxPolicy>,
        storage_mounts: Vec<StorageMount>,
        worker_bootstrap: Option<WorkerBootstrapRequest>,
    ) -> Result<String, EpochFault> {
        // For OpenBridge the client composes the fixed Harness bootstrap before
        // `open_sandbox_bridge`, then proves the exact private-poll readiness latch.
        if request.kind() == LifecycleEffectKind::OpenBridge
            && (self.bridge.is_some() || self.worker_bootstrap_monitor.is_some())
        {
            return Err(EpochFault::IdentityMismatch);
        }
        let create = match (create_spec, create_policy) {
            (Some(spec), Some(policy)) => Some((spec, policy, storage_mounts)),
            (None, None) if storage_mounts.is_empty() => None,
            _ => return Err(EpochFault::IdentityMismatch),
        };
        if let Some(result) = preflight_lifecycle_result(
            request,
            self.current_sandbox
                .as_ref()
                .map(|sandbox| sandbox.name.as_str()),
            self.bridge.is_some(),
            self.worker_bootstrap_monitor.is_some(),
            create.is_some() || worker_bootstrap.is_some(),
        )? {
            if request.kind() == LifecycleEffectKind::DeleteSandbox {
                self.persistent_volumes
                    .detach(request.sandbox_id())
                    .map_err(|_| EpochFault::IdentityMismatch)?;
            }
            return Ok(result.to_string());
        }
        // OpenBridge orders fixed Start before `open_sandbox_bridge` and retains
        // the live Harness monitor.
        let bridge = if request.kind() == LifecycleEffectKind::CloseBridge {
            let close = self.monitor.begin_bridge_close();
            self.settle(close)?;
            self.bridge.take()
        } else {
            None
        };
        let route_projection = (request.kind() == LifecycleEffectKind::OpenBridge)
            .then(|| self.route_projection.clone());
        let worker_bootstrap = if request.kind() == LifecycleEffectKind::OpenBridge {
            let sandbox = self
                .current_sandbox
                .as_ref()
                .ok_or(EpochFault::IdentityMismatch)?;
            if sandbox.name.as_str() != request.sandbox_id() {
                return Err(EpochFault::IdentityMismatch);
            }
            let mut worker_bootstrap = worker_bootstrap.ok_or(EpochFault::IdentityMismatch)?;
            worker_bootstrap.sandbox_id = sandbox.id.clone();
            Some(worker_bootstrap)
        } else {
            worker_bootstrap
        };
        let lifecycle_timeout = Duration::from_secs(120);
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(self.client.execute_lifecycle_effect(
                request,
                create,
                bridge,
                worker_bootstrap,
                route_projection,
                lifecycle_timeout,
            ))
        });
        let result = match result {
            Err(fault) if request.kind() == LifecycleEffectKind::OpenBridge => {
                let sandbox = self
                    .current_sandbox
                    .clone()
                    .ok_or(EpochFault::IdentityMismatch)?;
                let deletion = tokio::task::block_in_place(|| {
                    self.runtime
                        .block_on(self.client.delete_sandbox(&sandbox.name, lifecycle_timeout))
                });
                if deletion.is_err() {
                    return self.settle(Err(EpochFault::DeleteOutcomeUncertain));
                }
                self.current_sandbox = None;
                self.worker_bootstrap_monitor = None;
                return Err(fault);
            }
            result => result,
        };
        let result = match self.settle(result) {
            Ok(result) => result,
            Err(fault) => {
                if request.kind() == LifecycleEffectKind::CreateSandbox {
                    self.persistent_volumes
                        .detach(request.sandbox_id())
                        .map_err(|_| EpochFault::IdentityMismatch)?;
                }
                return Err(fault);
            }
        };
        match result {
            LifecycleEffectResult::SandboxCreated(sandbox) => {
                if self.current_sandbox.replace(sandbox.clone()).is_some() {
                    return self.settle(Err(EpochFault::IdentityMismatch));
                }
                Ok(sandbox.name)
            }
            LifecycleEffectResult::SandboxDeleted => {
                self.settle_definite_sandbox_deletion(request.sandbox_id())?;
                self.persistent_volumes
                    .detach(request.sandbox_id())
                    .map_err(|_| EpochFault::IdentityMismatch)?;
                Ok("deleted".to_string())
            }
            LifecycleEffectResult::BridgeOpened {
                bridge,
                exec_monitor,
            } => {
                if self.bridge.replace(bridge).is_some() {
                    return self.settle(Err(EpochFault::IdentityMismatch));
                }
                if self
                    .worker_bootstrap_monitor
                    .replace(exec_monitor)
                    .is_some()
                {
                    return self.settle(Err(EpochFault::IdentityMismatch));
                }
                let watched = self.monitor.watch_harness(
                    self.worker_bootstrap_monitor
                        .as_ref()
                        .expect("retained response monitor"),
                );
                self.settle(watched)?;
                let harness_ready = self
                    .bridge
                    .as_ref()
                    .is_some_and(OpenSandboxBridge::harness_ready);
                if !harness_ready {
                    return self.settle(Err(EpochFault::MemberExited(None)));
                }
                Ok("open".to_string())
            }
            LifecycleEffectResult::BridgeClosed => Ok("closed".to_string()),
        }
    }

    /// Verifies and imports one retained digest or exact fixed-registry image.
    ///
    /// # Errors
    ///
    /// Returns an attempt-local failure without registry fallback for a local
    /// digest or treating validation as successful acquisition evidence.
    pub fn acquire_image(
        &mut self,
        request_id: &str,
        reference: &str,
    ) -> Result<ImageEffectEvidence, &'static str> {
        let request = ImageEffectRequest::reference(request_id, reference);
        request.validate().map_err(|_| "image.acquire rejected")?;
        let acquired_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "image.acquire clock unavailable")?
            .as_secs();
        let local_digest = is_canonical_local_digest(reference);
        let digest = if local_digest {
            reference.to_string()
        } else {
            let registries = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                reference,
                &registries,
            )
            .map_err(|_| "image.acquire rejected")?;
            let staging = self
                .run_root
                .join("acquisitions")
                .join(format!("{:x}", Sha256::digest(request_id.as_bytes())));
            tokio::task::block_in_place(|| {
                self.runtime
                    .block_on(acquisition.acquire(&staging, &self.image_store, acquired_at))
            })
            .map_err(|error| error.report_effect_failure(&mut io::stderr().lock()))?
        };
        import_attempt_image(&self.image_store, &digest, &mut self.image_backend)
            .map_err(|_| "image.acquire import failed")?;
        let evidence = ImageEffectEvidence::new(request.request_id(), &digest);
        evidence
            .validate_result_identity(request_id)
            .map_err(|_| "image.acquire result rejected")?;
        Ok(evidence)
    }

    /// Builds, stores, and imports one exact resolved AEP attempt image.
    ///
    /// # Errors
    ///
    /// Returns an attempt-local validation, capability, build, store, or import
    /// failure. The fixed registry bootstrap set is not projected into sandbox
    /// or ordinary Dockerfile `RUN` authority.
    pub fn execute_image_build(
        &mut self,
        request_id: &str,
        dockerfile_digest: &str,
        arguments_digest: &str,
        definition: BuildDefinition,
    ) -> Result<ImageEffectEvidence, &'static str> {
        let context_ref = &definition.context_ref;
        if context_ref != EMPTY_BUILD_CONTEXT_REF
            || definition.context_digest != EMPTY_BUILD_CONTEXT_DIGEST
        {
            return Err("image.build context rejected");
        }
        let actual_dockerfile_digest = format!(
            "sha256:{:x}",
            Sha256::digest(definition.dockerfile.as_bytes())
        );
        let canonical_arguments = definition
            .arguments
            .iter()
            .cloned()
            .collect::<BTreeMap<_, _>>();
        let actual_arguments_digest = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&canonical_arguments)
                    .map_err(|_| "image.build arguments rejected")?
            )
        );
        if dockerfile_digest != actual_dockerfile_digest
            || arguments_digest != actual_arguments_digest
        {
            return Err("image.build lineage rejected");
        }
        let request = ImageEffectRequest::build(
            request_id,
            &definition.context_digest,
            dockerfile_digest,
            arguments_digest,
        );
        request.validate().map_err(|_| "image.build rejected")?;
        let registries = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        let build_root = self
            .run_root
            .join("acquisitions")
            .join(format!("{:x}", Sha256::digest(request_id.as_bytes())));
        let plan = BuildPlan::validate(
            definition,
            &registries,
            self.image_backend.docker_socket(),
            &build_root,
        )
        .map_err(|_| "image.build rejected")?;
        let acquired_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "image.build clock unavailable")?
            .as_secs();
        let digest = plan
            .execute_and_admit(
                &self.image_store,
                acquired_at,
                |digest, alias, content, deadline| {
                    self.image_backend
                        .bind_retained_parent(digest, alias, content, deadline)
                        .map_err(|_| crate::image_acquisition::AcquisitionError::Backend)
                },
            )
            .map_err(|_| "image.build failed")?;
        import_attempt_image(&self.image_store, &digest, &mut self.image_backend)
            .map_err(|_| "image.build import failed")?;
        let evidence = ImageEffectEvidence::new(request_id, &digest);
        evidence
            .validate_result_identity(request_id)
            .map_err(|_| "image.build result rejected")?;
        Ok(evidence)
    }

    /// Imports one verified file or declared directory into the current ready sandbox.
    ///
    /// # Errors
    ///
    /// Returns a bounded failure after exact sandbox cleanup; an unproved delete
    /// fences the epoch through the existing lifecycle owner.
    pub fn import_reference(
        &mut self,
        request_id: &str,
        slot: &str,
        relative_path: &Path,
        entry: &crate::sandbox_bridge::ImportEntry,
    ) -> Result<EffectCarriage, &'static str> {
        let (sha256, byte_length, kind) = match entry {
            crate::sandbox_bridge::ImportEntry::File { executable, file } => (
                file.digest(),
                file.length(),
                FileEffectKind::ImportReference {
                    executable: *executable,
                },
            ),
            crate::sandbox_bridge::ImportEntry::Directory => {
                ("", 0, FileEffectKind::ImportDirectory)
            }
        };
        let sandbox = self
            .current_sandbox
            .clone()
            .ok_or("reference.import current sandbox unavailable")?;
        let request = FileEffectRequest {
            artifact_submission: false,
            request_id: request_id.to_string(),
            sandbox_id: sandbox.name.clone(),
            slot: slot.to_string(),
            relative_path: relative_path.to_path_buf(),
            sha256: sha256.to_string(),
            byte_length,
            kind,
            presence: FileEffectPresence::Required,
        };
        request
            .validate()
            .map_err(|_| "reference.import request rejected")?;
        let mut source = match entry {
            crate::sandbox_bridge::ImportEntry::File { file, .. } => {
                match read_import_staging(file, &request) {
                    Ok(source) => Some(source),
                    Err(_) => {
                        let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                        return Err("reference.import failed or unknown");
                    }
                }
            }
            crate::sandbox_bridge::ImportEntry::Directory => None,
        };
        let mut empty_source = std::io::empty();
        let source: &mut dyn std::io::Read = match source.as_mut() {
            Some(source) => source,
            None => &mut empty_source,
        };
        let command = match request.helper_command() {
            Ok(command) => command,
            Err(_) => {
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                return Err("reference.import failed or unknown");
            }
        };
        let expected = if kind == FileEffectKind::ImportDirectory {
            String::new()
        } else {
            format!("{} {}\n", request.sha256, request.byte_length)
        };
        let mut acknowledgement = Vec::new();
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(self.client.exec_sandbox_interactive(
                &sandbox.id,
                &command,
                source,
                byte_length as usize,
                &mut acknowledgement,
                expected.len(),
            ))
        });
        match result {
            Ok(result) if result.exit_status == 0 && acknowledgement == expected.as_bytes() => {
                let carriage = EffectCarriage::reference(
                    &request.request_id,
                    &format!(
                        "sandbox://{}/{}/{}",
                        request.sandbox_id,
                        request.slot,
                        request.relative_path.display()
                    ),
                    request.byte_length,
                );
                if carriage.is_err() {
                    let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                }
                carriage
            }
            Ok(_) => {
                eprintln!("stage=reference-import outcome=stdout-acknowledgement");
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                Err("reference.import failed or unknown")
            }
            Err(_) => {
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                Err("reference.import failed or unknown")
            }
        }
    }

    /// Exports one regular file after accepted final status while the Harness may remain live.
    ///
    /// # Errors
    ///
    /// Returns a bounded failure after removing reachable staging and requesting
    /// exact sandbox cleanup; an unproved delete fences the epoch.
    pub fn export_file(
        &mut self,
        request: &FileEffectRequest,
        terminal_barrier_proved: bool,
        final_status: bool,
    ) -> Result<Option<RetainedExportResult>, &'static str> {
        let sandbox = self
            .current_sandbox
            .clone()
            .ok_or("file.export current sandbox unavailable")?;
        if request.kind != FileEffectKind::ExportFile
            || (!request.artifact_submission && (!terminal_barrier_proved || !final_status))
        {
            let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
            return Err("file.export terminal barrier missing");
        }
        if sandbox.name.as_str() != request.sandbox_id.as_str() {
            return Err("file.export current sandbox mismatch");
        }
        request
            .validate()
            .map_err(|_| "file.export request rejected")?;
        let command = request.helper_command()?;
        let mut stage = crate::file_transfer::FileStage::create(
            &self.file_staging_root,
            request.byte_length,
            0,
        )
        .map_err(|_| "file.export capacity unavailable")?;
        let mut empty = std::io::empty();
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(self.client.exec_sandbox_interactive(
                &sandbox.id,
                &command,
                &mut empty,
                0,
                &mut stage,
                request.byte_length as usize,
            ))
        });
        match result {
            Ok(result) if result.exit_status == 0 => {
                let retained = stage_export(request, stage, terminal_barrier_proved);
                if retained.is_err() {
                    let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                }
                // Retain this exact disk source for successor delivery; never re-export a changed Worker file.
                retained.map(Some)
            }
            Ok(result)
                if result.exit_status == 2
                    && result.stdout_bytes == 0
                    && request.presence == FileEffectPresence::Optional =>
            {
                Ok(None)
            }
            Ok(result)
                if request.artifact_submission
                    && result.exit_status == 3
                    && result.stdout_bytes == 0 =>
            {
                Err("artifact_file_not_regular")
            }
            Ok(_) | Err(_) => {
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                Err("file.export failed or unknown")
            }
        }
    }

    /// Selects disk-backed private carriage beneath this Epoch's existing state root.
    pub fn file_staging_root(&self) -> &Path {
        &self.file_staging_root
    }

    /// Waits for the monitor's terminal member event while effects remain callable.
    pub async fn member_failure(&self) -> EpochFault {
        self.monitor.member_failure().await
    }

    /// Completes the existing fence before publishing an effect result from a dead Harness.
    ///
    /// # Errors
    ///
    /// Returns the winning member fault after export-before-fence and sibling reap.
    pub fn check_member_liveness(&mut self) -> Result<(), EpochFault> {
        self.monitor.check_liveness()
    }

    /// Waits for the monitor's terminal member event without owning child handles.
    pub async fn wait(&self) -> EpochFault {
        self.member_failure().await
    }

    /// Exports one partial-start invalidation and fences the locally healthy but non-admitted epoch.
    pub fn invalidate_startup(&mut self) {
        self.monitor.invalidate_startup();
    }

    /// Settles a typed lifecycle result or terminates the invalid epoch.
    #[allow(dead_code)]
    fn settle<T>(&mut self, result: Result<T, EpochFault>) -> Result<T, EpochFault> {
        if let Err(fault) = result {
            match &fault {
                EpochFault::IdentityMismatch
                | EpochFault::CreateOutcomeUncertain(_)
                | EpochFault::DeleteOutcomeUncertain
                | EpochFault::PartialStart
                | EpochFault::MemberExited(_) => {
                    self.monitor.fence(fault.clone());
                }
            }
            return Err(fault);
        }
        result
    }
}

impl Drop for EpochCoordinator {
    /// Stops the whole epoch before releasing its exact retained storage writer hint.
    fn drop(&mut self) {
        self.inspection_server.take();
        self.monitor.stop();
        if let Some(sandbox) = self.current_sandbox.take() {
            let _ = self.persistent_volumes.detach(&sandbox.name);
        }
    }
}

/// Captures the actually started prefix and enters the existing bounded invalidation fence.
fn fence_startup_failure(
    evidence: &EpochEvidenceWriter,
    children: &mut [Child],
    fault: &EpochFault,
    fence_started_path: PathBuf,
    readiness: &AtomicU8,
) {
    let inventory = children
        .iter_mut()
        .enumerate()
        .map(|(index, child)| MemberInventory::pin(index, child))
        .collect();
    fence_initiated(
        evidence,
        children,
        fault,
        fence_started_path,
        readiness,
        inventory,
    );
}

/// Invokes the actual startup failure producer with fixture-owned processes and evidence paths.
#[cfg(test)]
pub(crate) fn fixture_startup_failure(
    children: Vec<Child>,
    root: &Path,
    fault: EpochFault,
    before_export: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    let mut children = OwnedEpochChildren {
        children,
        private_namespaces: None,
    };
    let mut evidence = EpochEvidenceWriter::new(root.join("reports")).unwrap();
    if let Some(hook) = before_export {
        evidence.before_export(hook);
    }
    fence_startup_failure(
        &evidence,
        &mut children.children,
        &fault,
        root.join("fence-started"),
        &AtomicU8::new(ReadinessProof::Unavailable as u8),
    );
}

/// Starts exactly one bounded invalidation export before fencing owned children.
fn fence_initiated(
    evidence: &EpochEvidenceWriter,
    children: &mut [Child],
    fault: &EpochFault,
    fence_started_path: PathBuf,
    readiness: &AtomicU8,
    mut inventory: Vec<MemberInventory>,
) {
    for (member, child) in inventory.iter_mut().zip(children.iter_mut()) {
        member.observe_status(child);
    }
    let mut writer = evidence.clone();
    let fault = fault.clone();
    let readiness = ReadinessProof::report_value(readiness);
    let (completed_tx, completed_rx) = mpsc::sync_channel(1);
    let fence_started = SystemTime::now();
    let worker = catch_unwind(AssertUnwindSafe(|| {
        thread::spawn(move || {
            let started = Instant::now();
            let _ = record_fence_started_at(&fence_started_path, fence_started);
            let mut fields = invalidation_report_fields(&fault);
            fields.push(("readiness", readiness));
            let mut members = Vec::with_capacity(inventory.len());
            for member in inventory {
                #[cfg(test)]
                let value = member.report(writer.inventory_recheck.as_deref());
                #[cfg(not(test))]
                let value = member.report();
                members.push(value);
            }
            fields.push(("members", serde_json::Value::Array(members).to_string()));
            let field_refs = fields
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect::<Vec<_>>();
            let _ = writer.export_invalidation(invalidation_trigger(&fault), &field_refs, started);
            let _ = completed_tx.send(());
        })
    }));
    if let Ok(_worker) = worker {
        let _ = completed_rx.recv_timeout(EXPORT_TIMEOUT);
    }
    terminate_children(children);
}

/// Maps one existing epoch fault to its accepted invalidation classification.
fn invalidation_trigger(fault: &EpochFault) -> EpochInvalidationTrigger {
    match fault {
        EpochFault::PartialStart => EpochInvalidationTrigger::EpochCreationFailure,
        EpochFault::MemberExited(_) => EpochInvalidationTrigger::MemberExit,
        EpochFault::IdentityMismatch => EpochInvalidationTrigger::MemberIdentityChange,
        EpochFault::CreateOutcomeUncertain(_) => EpochInvalidationTrigger::UncertainCreate,
        EpochFault::DeleteOutcomeUncertain => EpochInvalidationTrigger::UncertainDelete,
    }
}

/// Names the first finished watched task, response before route.
fn finished_watched_task(tasks: &(AbortHandle, AbortHandle)) -> Option<MemberFailure> {
    if tasks.0.is_finished() {
        Some(MemberFailure::new(
            MemberFailureSubject::HarnessResponse,
            MemberObservation::Finished,
        ))
    } else if tasks.1.is_finished() {
        Some(MemberFailure::new(
            MemberFailureSubject::HarnessRoute,
            MemberObservation::Finished,
        ))
    } else {
        None
    }
}

/// Projects one fault into the closed private invalidation-report fields.
fn invalidation_report_fields(fault: &EpochFault) -> Vec<(&'static str, String)> {
    match fault {
        EpochFault::CreateOutcomeUncertain(context) => vec![
            ("operation", "sandbox.create".to_string()),
            ("sandbox", context.sandbox_lineage.clone()),
            ("attempt", context.attempt_lineage.clone()),
            (
                "certainty_loss",
                context.certainty_loss.as_str().to_string(),
            ),
            ("timing", format!("elapsed_ms={}", context.elapsed_ms)),
            ("fence", "initiated".to_string()),
        ],
        EpochFault::MemberExited(Some(failure)) => vec![
            ("failed_member", failure.report_value()),
            ("fence", "initiated".to_string()),
        ],
        _ => vec![("fence", "initiated".to_string())],
    }
}

/// Converts a path to a direct argument without shell interpretation.
fn path_arg(path: &Path) -> String {
    path.as_os_str().to_string_lossy().into_owned()
}

/// Renders the Gateway configuration for one private epoch.
fn gateway_config(docker_socket: &Path, auth_path: &Path) -> io::Result<String> {
    let supervisor_image = openshell_release::supervisor_image()
        .ok_or_else(|| io::Error::other("OpenShell release metadata is invalid"))?;
    Ok(format!(
        "[openshell]\nversion = 1\n\n[openshell.gateway.tls]\ncert_path = \"{auth}/server/tls.crt\"\nkey_path = \"{auth}/server/tls.key\"\nclient_ca_path = \"{auth}/ca.crt\"\nrequire_client_auth = true\n\n[openshell.gateway.mtls_auth]\nenabled = true\n\n[openshell.gateway.gateway_jwt]\nsigning_key_path = \"{auth}/jwt/signing.pem\"\npublic_key_path = \"{auth}/jwt/public.pem\"\nkid_path = \"{auth}/jwt/kid\"\ngateway_id = \"openkit-nanohost\"\nttl_secs = 3600\n\n[openshell.drivers.docker]\nsocket_path = \"{}\"\nsupervisor_image = \"{supervisor_image}\"\nenable_bind_mounts = true\n",
        docker_socket.display(),
        auth = auth_path.display(),
    ))
}

/// Creates one new private directory and refuses an existing epoch root.
fn create_private_dir(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    DirBuilder::new().mode(0o700).create(path)?;
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
}

/// Writes one private epoch configuration file with mode `0600`.
fn write_private_file(path: &Path, contents: &str) -> io::Result<()> {
    fs::write(path, contents)?;
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
}

/// Generates the stock epoch-local TLS and JWT bundle within the startup bound.
fn generate_gateway_auth(plan: &EpochPlan) -> bool {
    for directory in [
        plan.epoch_root().join("home"),
        plan.epoch_root().join("xdg-config"),
    ] {
        if create_private_dir(&directory).is_err() {
            return false;
        }
    }
    let mut child = match gateway_cert_command(plan)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let message = match error.kind() {
                io::ErrorKind::NotFound => "stage=gateway-auth outcome=spawn-not-found",
                io::ErrorKind::PermissionDenied => "stage=gateway-auth outcome=spawn-permission",
                _ => "stage=gateway-auth outcome=spawn-other",
            };
            let _ = writeln!(std::io::stderr().lock(), "{message}");
            return false;
        }
    };
    match wait_for_success(&mut child) {
        Ok(()) => true,
        Err(outcome) => {
            let _ = writeln!(
                std::io::stderr().lock(),
                "stage=gateway-auth outcome={outcome}"
            );
            false
        }
    }
}

/// Builds the stock cert-generation command with all writable homes epoch-local.
fn gateway_cert_command(plan: &EpochPlan) -> Command {
    let mut command = Command::new(&plan.gateway_program);
    command
        .args([
            "generate-certs",
            "--output-dir",
            &path_arg(plan.gateway_auth_path()),
            "--server-san",
            "127.0.0.1",
            "--server-san",
            "host.openshell.internal",
        ])
        .env("HOME", plan.epoch_root().join("home"))
        .env("XDG_CONFIG_HOME", plan.epoch_root().join("xdg-config"));
    command
}

/// Starts one direct foreground member in its declared namespace placement.
fn spawn_member(
    children: &mut Vec<Child>,
    member: &EpochMemberSpec,
    private_namespaces: Option<&PrivateNamespaceDescriptors>,
    resolver_projection: Option<(&Path, &Path)>,
) -> io::Result<Option<UnixStream>> {
    // This observes process creation. Dependency readiness remains in startup.
    let role = match member.role() {
        EpochProcessRole::Containerd => "containerd",
        EpochProcessRole::Slirp4netns => "slirp4netns",
        EpochProcessRole::Dockerd => "dockerd",
        EpochProcessRole::OpenShellGateway => "openshell-gateway",
    };
    let mut observation = crate::telemetry::Observation::start(
        "nanohost.member.start",
        &Context::current(),
        vec![KeyValue::new("openkit.member", role)],
        None,
    );
    let mut command = Command::new(member.program());
    command
        .args(member.args())
        .envs(member.env().iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut ready_reader = None;
    match member.network_namespace_mode() {
        EpochNetworkNamespaceMode::CreatePrivate => {
            let (resolver_source, resolver_target) = resolver_mount(resolver_projection)?;
            // SAFETY: the closure uses only async-signal-safe namespace and mount
            // calls with owned C strings retained through spawn.
            unsafe {
                command.pre_exec(move || {
                    if unshare_network() == 0
                        && mount_private_resolver(
                            resolver_source.as_ptr(),
                            resolver_target.as_ptr(),
                        ) == 0
                    {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
            }
        }
        EpochNetworkNamespaceMode::JoinPrivate => {
            let private_namespaces = private_namespaces
                .ok_or_else(|| io::Error::other("private namespace descriptors missing"))?;
            let network_namespace_fd = private_namespaces.network.as_raw_fd();
            let mount_namespace_fd = private_namespaces.mount.as_raw_fd();
            // SAFETY: the closure uses only async-signal-safe namespace calls
            // with owned descriptors retained through spawn.
            unsafe {
                command.pre_exec(move || {
                    if setns_network(network_namespace_fd) == 0
                        && setns_mount(mount_namespace_fd) == 0
                    {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
            }
        }
        EpochNetworkNamespaceMode::Host if member.role() == EpochProcessRole::Slirp4netns => {
            let namespace_fd = private_namespaces
                .ok_or_else(|| io::Error::other("private namespace descriptors missing"))?
                .network
                .as_raw_fd();
            let (reader, writer) = UnixStream::pair()?;
            // SAFETY: `fcntl` returns a new owned descriptor on success.
            let staged_ready_fd =
                unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
            if staged_ready_fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful `F_DUPFD_CLOEXEC` transfers ownership of this
            // previously unowned descriptor into `OwnedFd`.
            let staged_ready = unsafe { OwnedFd::from_raw_fd(staged_ready_fd) };
            // SAFETY: `fcntl` returns a new owned descriptor on success.
            let staged_namespace_fd =
                unsafe { libc::fcntl(namespace_fd, libc::F_DUPFD_CLOEXEC, 10) };
            if staged_namespace_fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful `F_DUPFD_CLOEXEC` transfers ownership of this
            // previously unowned descriptor into `OwnedFd`.
            let staged_namespace = unsafe { OwnedFd::from_raw_fd(staged_namespace_fd) };
            // SAFETY: the closure uses only async-signal-safe namespace, mount,
            // and descriptor calls. The recursively private mount tree prevents
            // slirp's own sandbox pivot from propagating unmounts to siblings.
            // Owned captures retain both sources through spawn, and staging above
            // the fixed targets avoids aliasing with descriptors 3 and 4.
            unsafe {
                command.pre_exec(move || {
                    #[cfg(target_os = "linux")]
                    let mount_namespace_result = if libc::unshare(libc::CLONE_NEWNS) != 0 {
                        -1
                    } else {
                        libc::mount(
                            std::ptr::null(),
                            c"/".as_ptr(),
                            std::ptr::null(),
                            libc::MS_REC | libc::MS_PRIVATE,
                            std::ptr::null(),
                        )
                    };
                    #[cfg(not(target_os = "linux"))]
                    let mount_namespace_result = -1;
                    if mount_namespace_result != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let ready_result = libc::dup2(staged_ready.as_raw_fd(), 3);
                    let namespace_result = libc::dup2(staged_namespace.as_raw_fd(), 4);
                    if ready_result < 0 || namespace_result < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            ready_reader = Some(reader);
        }
        EpochNetworkNamespaceMode::Host => {}
    }
    let child = command.spawn()?;
    children.push(child);
    observation.finish(true);
    Ok(ready_reader)
}

/// Converts the one required private-member resolver projection before fork.
fn resolver_mount(projection: Option<(&Path, &Path)>) -> io::Result<(CString, CString)> {
    let (source, target) =
        projection.ok_or_else(|| io::Error::other("private resolver projection missing"))?;
    Ok((
        CString::new(source.as_os_str().as_bytes())
            .map_err(|_| io::Error::other("private resolver source rejected"))?,
        CString::new(target.as_os_str().as_bytes())
            .map_err(|_| io::Error::other("private resolver target rejected"))?,
    ))
}

/// Creates a private mount view and installs one read-only resolver file in it.
unsafe fn mount_private_resolver(source: *const libc::c_char, target: *const libc::c_char) -> i32 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the caller supplies live NUL-terminated paths and runs before exec.
        if unsafe { libc::unshare(libc::CLONE_NEWNS) } != 0
            || unsafe {
                libc::mount(
                    std::ptr::null(),
                    c"/".as_ptr(),
                    std::ptr::null(),
                    libc::MS_REC | libc::MS_PRIVATE,
                    std::ptr::null(),
                )
            } != 0
            || unsafe {
                libc::mount(
                    source,
                    target,
                    std::ptr::null(),
                    libc::MS_BIND,
                    std::ptr::null(),
                )
            } != 0
        {
            return -1;
        }
        // SAFETY: the preceding bind created this mount in the child-private tree.
        unsafe {
            libc::mount(
                std::ptr::null(),
                target,
                std::ptr::null(),
                libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY,
                std::ptr::null(),
            )
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (source, target);
        -1
    }
}

/// Returns one namespace object's stable device and inode identity.
fn namespace_identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

/// Opens and proves both fresh namespaces created by the containerd child.
fn retain_private_namespaces(child: &mut Child) -> io::Result<PrivateNamespaceDescriptors> {
    let host_network_identity = namespace_identity(Path::new("/proc/self/ns/net"))?;
    let host_mount_identity = namespace_identity(Path::new("/proc/self/ns/mnt"))?;
    let network_path = PathBuf::from(format!("/proc/{}/ns/net", child.id()));
    let mount_path = PathBuf::from(format!("/proc/{}/ns/mnt", child.id()));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return Err(io::Error::other("containerd exited before namespace proof"));
        }
        if let (Ok(network), Ok(mount)) = (File::open(&network_path), File::open(&mount_path))
            && let (Ok(network_metadata), Ok(mount_metadata)) =
                (network.metadata(), mount.metadata())
            && (network_metadata.dev(), network_metadata.ino()) != host_network_identity
            && (mount_metadata.dev(), mount_metadata.ino()) != host_mount_identity
            && namespace_identity(&network_path).ok()
                == Some((network_metadata.dev(), network_metadata.ino()))
            && namespace_identity(&mount_path).ok()
                == Some((mount_metadata.dev(), mount_metadata.ino()))
            && matches!(child.try_wait(), Ok(None))
        {
            return Ok(PrivateNamespaceDescriptors {
                network: Arc::new(OwnedFd::from(network)),
                mount: Arc::new(OwnedFd::from(mount)),
            });
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(io::Error::other("private namespace proof timed out"))
}

/// Proves one child is running in both retained private namespaces.
fn wait_for_member_namespaces(
    child: &mut Child,
    private_namespaces: &PrivateNamespaceDescriptors,
) -> bool {
    let expected_network = namespace_identity(Path::new(&format!(
        "/proc/self/fd/{}",
        private_namespaces.network.as_raw_fd()
    )))
    .ok();
    let expected_mount = namespace_identity(Path::new(&format!(
        "/proc/self/fd/{}",
        private_namespaces.mount.as_raw_fd()
    )))
    .ok();
    let member_network_path = PathBuf::from(format!("/proc/{}/ns/net", child.id()));
    let member_mount_path = PathBuf::from(format!("/proc/{}/ns/mnt", child.id()));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return false;
        }
        if expected_network.is_some()
            && expected_mount.is_some()
            && namespace_identity(&member_network_path).ok() == expected_network
            && namespace_identity(&member_mount_path).ok() == expected_mount
        {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Returns whether one proc route table proves an up exact TAP default route.
fn has_up_tap0_default_route(route_table: &str) -> bool {
    route_table.lines().any(|line| {
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        fields.len() >= 8
            && fields[0] == "tap0"
            && fields[1] == "00000000"
            && fields[7] == "00000000"
            && u32::from_str_radix(fields[3], 16).is_ok_and(|flags| flags & 0x1 != 0)
    })
}

/// Proves the helper's ready signal and the private TAP default route.
fn wait_for_slirp_ready(
    child: &mut Child,
    mut ready_reader: UnixStream,
    namespace_descriptor: Arc<OwnedFd>,
) -> bool {
    if ready_reader
        .set_read_timeout(Some(STARTUP_TIMEOUT))
        .is_err()
    {
        return false;
    }
    let mut signal = [0_u8; 1];
    if ready_reader.read_exact(&mut signal).is_err() || !matches!(child.try_wait(), Ok(None)) {
        return false;
    }
    thread::spawn(move || {
        // SAFETY: the dedicated probe thread changes only its own network
        // namespace and exits immediately after the bounded local inspection.
        if unsafe { setns_network(namespace_descriptor.as_raw_fd()) } != 0 {
            return false;
        }
        let mut route = String::new();
        let route_read = File::open("/proc/thread-self/net/route")
            .and_then(|mut file| file.read_to_string(&mut route))
            .is_ok();
        // SAFETY: the fixed NUL-terminated interface name is read-only.
        let tap_present = unsafe { libc::if_nametoindex(c"tap0".as_ptr()) } != 0;
        tap_present && route_read && has_up_tap0_default_route(&route)
    })
    .join()
    .unwrap_or(false)
}

/// Waits a bounded interval for a dependency socket while its process stays alive.
fn wait_for_socket(child: &mut Child, socket: &Path) -> bool {
    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if socket.exists() {
            return matches!(child.try_wait(), Ok(None));
        }
        if !matches!(child.try_wait(), Ok(None)) {
            return false;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Waits a bounded interval for a short-lived preparation process to succeed.
///
/// # Errors
///
/// Returns a fixed outcome for a nonzero exit, wait failure, or timeout.
fn wait_for_success(child: &mut Child) -> Result<(), &'static str> {
    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                return status.success().then_some(()).ok_or("nonzero");
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("wait");
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("timeout")
}

/// Waits for a direct child without extending the caller's absolute deadline.
fn wait_for_child_success(child: &mut Child, deadline: Instant) -> bool {
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return status.success() && Instant::now() < deadline,
            Ok(None) => thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(25)),
            ),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// Stops and reaps all children, including after a partial start.
fn terminate_children(children: &mut [Child]) {
    for child in children.iter_mut() {
        let _ = child.kill();
    }
    for child in children.iter_mut() {
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    /// Uses real native H2 carriage and the local storage owner, without a deployed host.
    #[tokio::test]
    async fn native_trace_context_bounds_execution_and_survives_result_redelivery() {
        use bytes::Bytes;
        use opentelemetry::trace::TraceContextExt;
        use opentelemetry::{Context, global};
        use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};

        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        global::set_tracer_provider(provider.clone());
        let root = std::env::temp_dir().join(format!("nanohost-tracing-{}", std::process::id()));
        let (mut coordinator, _) = super::EpochCoordinator::collection_fixture(&root);
        let mut startup = crate::telemetry::Observation::start(
            "nanohost.epoch.start",
            &Context::new(),
            Vec::new(),
            None,
        );
        startup.finish(true);
        coordinator.startup_context = startup.context().span().span_context().clone();
        let startup_context = coordinator.startup_context.clone();
        let remote = "00-11111111111111111111111111111111-2222222222222222-01";
        let (client, server) = tokio::io::duplex(4096);
        let (mut sender, driver) = h2::client::handshake(client).await.unwrap();
        let driver = tokio::spawn(driver);
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let requests = observed.clone();
        let server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(server).await.unwrap();
            while let Some(request) = connection.accept().await {
                let (request, mut respond) = request.unwrap();
                let is_result = request.uri().path().ends_with("/result");
                let headers = request.headers().clone();
                let mut body = request.into_body();
                let mut bytes = Vec::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    bytes.extend_from_slice(&chunk);
                }
                if is_result {
                    requests.lock().unwrap().push((headers, bytes));
                    respond
                        .send_response(
                            http::Response::builder().status(204).body(()).unwrap(),
                            true,
                        )
                        .unwrap();
                } else {
                    assert!(
                        !headers.contains_key("traceparent"),
                        "poll context is not effect parentage"
                    );
                    let mut stream = respond
                        .send_response(
                            http::Response::builder()
                                .status(200)
                                .header("traceparent", remote)
                                .header("tracestate", "test=value")
                                .body(())
                                .unwrap(),
                            false,
                        )
                        .unwrap();
                    stream.send_data(Bytes::from(serde_json::to_vec(&serde_json::json!({
                        "requestId": "a".repeat(64), "storageRef": "storage-one", "attachmentGeneration": 1,
                    })).unwrap()), true).unwrap();
                }
            }
        });
        let mut cursor = 9;
        let mut command = crate::nanocore_session::poll_effect_command(
            "http://nanocore.test",
            &mut sender,
            &mut cursor,
            false,
            &root,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            command
                .trace_context
                .span()
                .span_context()
                .trace_id()
                .to_string(),
            "11111111111111111111111111111111",
            "command response must carry the initiating parent"
        );
        let original_input = command.input.clone();
        let result = match crate::execute_effect_command(&mut coordinator, &mut command).unwrap() {
            crate::ExecutedEffectResult::Json(result) => result,
            _ => panic!("storage inspection returns JSON"),
        };
        assert_eq!(
            command.input, original_input,
            "trace context must not enter effect identity"
        );
        let spans = exporter.get_finished_spans().unwrap();
        let effect = spans
            .iter()
            .find(|span| span.name == "nanohost.effect")
            .expect("local span must end before any result delivery");
        assert_eq!(effect.parent_span_id.to_string(), "2222222222222222");
        assert_eq!(effect.links.links.len(), 1);
        assert_eq!(effect.links.links[0].span_context, startup_context);
        assert_eq!(
            command.trace_context.span().span_context(),
            &effect.span_context
        );
        assert_eq!(effect.status, opentelemetry::trace::Status::Unset);
        assert!(
            effect
                .attributes
                .contains(&opentelemetry::KeyValue::new("openkit.outcome", "returned"))
        );
        for _ in 0..2 {
            crate::nanocore_session::submit_effect_result(
                "http://nanocore.test",
                &mut sender,
                &command,
                result.clone(),
            )
            .await
            .unwrap();
        }
        let requests = observed.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0], requests[1],
            "redelivery preserves context and exact result identity"
        );
        assert_eq!(
            crate::telemetry::extract(&requests[0].0)
                .span()
                .span_context()
                .span_id(),
            effect.span_context.span_id()
        );
        assert_eq!(requests[0].0["tracestate"], "test=value");
        assert_eq!(
            exporter.get_finished_spans().unwrap().len(),
            2,
            "delivery must not retain or create execution spans"
        );
        let exported = format!("{spans:?}");
        assert!(!exported.contains("storage-one"));
        assert!(!exported.contains(root.to_str().unwrap()));
        drop(requests);
        driver.abort();
        server.abort();
        drop(coordinator);
        std::fs::remove_dir_all(root).unwrap();
        global::set_tracer_provider(opentelemetry::trace::noop::NoopTracerProvider::new());
        provider.shutdown().unwrap();
    }

    use std::collections::{BTreeMap, BTreeSet};
    #[cfg(target_os = "linux")]
    use std::ffi::CString;
    #[cfg(target_os = "linux")]
    use std::fs;
    use std::fs::File;
    #[cfg(target_os = "linux")]
    use std::io::{Read, Write};
    #[cfg(target_os = "linux")]
    use std::net::UdpSocket;
    #[cfg(target_os = "linux")]
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    #[cfg(target_os = "linux")]
    use std::thread;
    use std::time::{Duration, Instant};
    use tokio::task::AbortHandle;

    use sha2::{Digest, Sha256};

    use super::{
        AttemptImportOutcome, CreateCertaintyLossPoint, CreateUncertainty, EpochAction,
        EpochEvidenceWriter, EpochFault, EpochInvalidationTrigger, EpochMemberMonitor,
        EpochNetworkNamespaceMode, EpochPlan, EpochProcessRole, ImageBackend, ImageImportError,
        MID_EPOCH_IMPORT_TIMEOUT, MemberFailure, MemberFailureSubject, MemberObservation,
        MemberProofKind, OPENKIT_NANOHOST_SLICE, RuntimeEffectKind, compose_epoch_name,
        dockerd_dns_arguments, finished_watched_task, gateway_cert_command,
        has_up_tap0_default_route, import_attempt_image, invalidation_report_fields,
        invalidation_trigger, is_canonical_local_digest, physical_epoch_for_plan,
        preflight_lifecycle_result, resolve_epoch_nameservers, run_image_metadata_command,
        wait_for_success,
    };
    #[cfg(target_os = "linux")]
    use super::{EpochMemberSpec, spawn_member, wait_for_child_success};
    use crate::image_store::{ImageStore, StoreLineage};
    use crate::openshell_client::{LifecycleEffectKind, LifecycleEffectRequest};

    /// Keeps a real bridge route task pending until its ordinary Drop cleanup.
    fn liveness_test_bridge() -> (crate::sandbox_bridge::OpenSandboxBridge, AbortHandle) {
        let route = tokio::spawn(std::future::pending());
        let watched_route = route.abort_handle();
        (
            crate::sandbox_bridge::OpenSandboxBridge::new(
                route,
                "fixture-authorization".to_string(),
                "fixture-integration-binding".to_string(),
                true,
            ),
            watched_route,
        )
    }

    /// Creates a real pending bootstrap response task whose completion is controllable.
    fn liveness_test_bootstrap(
        route: AbortHandle,
    ) -> (
        crate::openshell_client::WorkerBootstrapMonitor,
        tokio::task::AbortHandle,
    ) {
        let response = tokio::spawn(std::future::pending());
        let abort = response.abort_handle();
        (
            crate::openshell_client::WorkerBootstrapMonitor::from_test_task(response, route),
            abort,
        )
    }

    /// Requires task completion as fixture setup, rather than mistaking a setup race for red.
    async fn wait_for_liveness_test_bootstrap(
        monitor: &crate::openshell_client::WorkerBootstrapMonitor,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while monitor.is_live() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("bootstrap fixture task completed");
    }

    /// Acknowledges the real failure wait's fence request without host-global fence timestamps.
    /// Existing member-owner tests cover termination; these tests decide Harness observation.
    fn liveness_test_member_monitor() -> EpochMemberMonitor {
        let (fence, requests) = std::sync::mpsc::sync_channel(1);
        let (faults, member_failure) = std::sync::mpsc::sync_channel(1);
        let harness_tasks = Arc::new(Mutex::new(None));
        let watched_tasks = Arc::clone(&harness_tasks);
        let worker = std::thread::spawn(move || {
            if let Some(fault) =
                EpochMemberMonitor::observe_members(&mut [], &requests, &watched_tasks)
            {
                faults.send(fault).expect("acknowledge requested fence");
            }
        });
        EpochMemberMonitor {
            fence,
            member_failure,
            worker: Some(worker),
            harness_tasks,
            readiness: Arc::new(super::AtomicU8::new(
                super::ReadinessProof::Unavailable as u8,
            )),
            inspection: None,
        }
    }

    /// Names a finished Harness response without an invented exit status.
    fn observed_harness_response() -> EpochFault {
        EpochFault::MemberExited(Some(MemberFailure::new(
            MemberFailureSubject::HarnessResponse,
            MemberObservation::Finished,
        )))
    }

    /// Requires the closed `failed_member` report field and the same journal tokens.
    fn assert_failed_member(fault: &EpochFault, report_value: &str) {
        let EpochFault::MemberExited(Some(failure)) = *fault else {
            panic!("member failure did not record an observation: {fault:?}");
        };
        assert_eq!(failure.report_value(), report_value);
        assert_eq!(failure.journal_tokens().replace(' ', ";"), report_value);
        assert!(
            !report_value.contains("code=") || report_value.contains("observation=exit-code"),
            "only a proved exit code may carry code"
        );
        assert_eq!(
            invalidation_report_fields(fault),
            vec![
                ("failed_member", report_value.to_string()),
                ("fence", "initiated".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn harness_liveness_completed_monitor_is_not_ready() {
        let (bridge, route) = liveness_test_bridge();
        let bootstrap = crate::openshell_client::WorkerBootstrapMonitor::from_test_task(
            tokio::spawn(async {
                Ok(crate::openshell_client::WorkerBootstrapCompletion {
                    monitor_exit: true,
                    clean_response: true,
                    exit_status: 0,
                })
            }),
            route,
        );
        wait_for_liveness_test_bootstrap(&bootstrap).await;
        assert!(bridge.harness_ready(), "the route itself is still live");
        assert!(
            !super::harness_bridge_is_live(Some(&bridge), Some(&bootstrap)),
            "a retained completed bootstrap is not a live Harness"
        );
    }

    #[tokio::test]
    async fn harness_liveness_finished_monitor_wakes_existing_wait() {
        let (bridge, route) = liveness_test_bridge();
        let (bootstrap, abort) = liveness_test_bootstrap(route);
        let members = liveness_test_member_monitor();
        members
            .watch_harness(&bootstrap)
            .expect("watch real Harness tasks");
        assert!(super::harness_bridge_is_live(
            Some(&bridge),
            Some(&bootstrap)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), members.member_failure(),)
                .await
                .is_err(),
            "a live Harness must not interrupt active consumers"
        );
        abort.abort();
        wait_for_liveness_test_bootstrap(&bootstrap).await;
        let observed = tokio::time::timeout(Duration::from_secs(1), members.member_failure()).await;
        drop(members);
        let fault = observed.expect("completed Harness must wake the existing failure wait");
        assert_eq!(fault, observed_harness_response());
        assert_failed_member(&fault, "subject=harness-response;observation=finished");
    }

    #[tokio::test]
    async fn harness_liveness_both_finished_tasks_report_the_response_first() {
        let (bridge, route) = liveness_test_bridge();
        let (bootstrap, response) = liveness_test_bootstrap(route.clone());
        let tasks = bootstrap
            .task_handles()
            .expect("retained response and route handles");
        response.abort();
        route.abort();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !tasks.0.is_finished() || !tasks.1.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both watched tasks finished");
        assert!(tasks.0.is_finished(), "response handle is finished");
        assert!(tasks.1.is_finished(), "route handle is finished");
        let failure = finished_watched_task(&tasks).expect("both finished tasks classify");
        assert_eq!(
            failure,
            MemberFailure::new(
                MemberFailureSubject::HarnessResponse,
                MemberObservation::Finished,
            )
        );
        assert_eq!(
            failure.report_value(),
            "subject=harness-response;observation=finished"
        );
        drop(bridge);
        drop(bootstrap);
    }

    #[tokio::test]
    async fn harness_liveness_intentional_bridge_close_keeps_member_wait() {
        let (bridge, route) = liveness_test_bridge();
        let (bootstrap, abort) = liveness_test_bootstrap(route);
        let members = liveness_test_member_monitor();
        members
            .watch_harness(&bootstrap)
            .expect("watch real Harness tasks");
        members.begin_bridge_close().expect("live explicit close");
        drop(bridge);
        abort.abort();
        wait_for_liveness_test_bootstrap(&bootstrap).await;
        assert!(!super::harness_bridge_is_live(None, Some(&bootstrap)));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), members.member_failure(),)
                .await
                .is_err(),
            "explicit bridge.close retains the monitor until Sandbox deletion"
        );
        drop(members);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn harness_liveness_completion_during_effect_without_waiter() {
        let (_bridge, route) = liveness_test_bridge();
        let (bootstrap, abort) = liveness_test_bootstrap(route);
        let members = liveness_test_member_monitor();
        members
            .watch_harness(&bootstrap)
            .expect("watch real Harness tasks");
        abort.abort();
        wait_for_liveness_test_bootstrap(&bootstrap).await;
        // Matches the synchronous local-effect window: no member_failure future exists.
        let observed = tokio::task::block_in_place(|| {
            members.member_failure.recv_timeout(Duration::from_secs(1))
        });
        drop(members);
        let fault =
            observed.expect("Harness completion must reach the fence during a local effect");
        assert_eq!(fault, observed_harness_response());
        assert_failed_member(&fault, "subject=harness-response;observation=finished");
    }

    /// Expected task completion during exact deletion must not replace its absence proof.
    #[tokio::test]
    async fn sandbox_deletion_exempts_expected_harness_completion_and_retains_monitor() {
        let root =
            std::env::temp_dir().join(format!("nanohost-delete-exemption-{}", std::process::id()));
        let (mut coordinator, _) = super::EpochCoordinator::collection_fixture(&root);
        coordinator.monitor = liveness_test_member_monitor();
        let (bridge, route) = liveness_test_bridge();
        let (bootstrap, abort) = liveness_test_bootstrap(route);
        coordinator.monitor.watch_harness(&bootstrap).unwrap();
        coordinator.bridge = Some(bridge);
        coordinator.worker_bootstrap_monitor = Some(bootstrap);

        coordinator
            .begin_sandbox_deletion("sandbox-one")
            .expect("admit exact current deletion");
        abort.abort();
        wait_for_liveness_test_bootstrap(coordinator.worker_bootstrap_monitor.as_ref().unwrap())
            .await;
        coordinator
            .check_member_liveness()
            .expect("intentional Sandbox deletion must not become member loss");
        assert!(coordinator.bridge.is_none(), "deletion closes its route");
        assert!(
            coordinator.worker_bootstrap_monitor.is_some(),
            "response proof stays retained until exact absence"
        );
        assert!(
            coordinator.monitor.worker.is_some(),
            "healthy epoch retains its member monitor"
        );

        // Failure to prove native absence must still use the existing whole-epoch fence.
        assert_eq!(
            coordinator.settle::<()>(Err(EpochFault::DeleteOutcomeUncertain)),
            Err(EpochFault::DeleteOutcomeUncertain)
        );
        assert!(
            coordinator.monitor.worker.is_none(),
            "uncertain deletion joins the epoch fence"
        );
        assert!(
            coordinator.worker_bootstrap_monitor.is_some(),
            "uncertain deletion does not manufacture absence"
        );
        drop(coordinator);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A task already finished before deletion intent is a real failure, not expected cleanup.
    #[tokio::test]
    async fn sandbox_deletion_rejects_prior_harness_completion_and_wrong_identity() {
        for prior_completion in [false, true] {
            let root = std::env::temp_dir().join(format!(
                "nanohost-delete-refusal-{}-{prior_completion}",
                std::process::id()
            ));
            let (mut coordinator, _) = super::EpochCoordinator::collection_fixture(&root);
            coordinator.monitor = liveness_test_member_monitor();
            let (bridge, route) = liveness_test_bridge();
            let (bootstrap, abort) = liveness_test_bootstrap(route);
            coordinator.monitor.watch_harness(&bootstrap).unwrap();
            coordinator.bridge = Some(bridge);
            coordinator.worker_bootstrap_monitor = Some(bootstrap);
            if prior_completion {
                abort.abort();
                wait_for_liveness_test_bootstrap(
                    coordinator.worker_bootstrap_monitor.as_ref().unwrap(),
                )
                .await;
            }
            let result = coordinator.begin_sandbox_deletion(if prior_completion {
                "sandbox-one"
            } else {
                "another-sandbox"
            });
            assert_eq!(
                result,
                Err(if prior_completion {
                    observed_harness_response()
                } else {
                    EpochFault::IdentityMismatch
                })
            );
            assert!(
                coordinator.bridge.is_some(),
                "refused deletion retains bridge ownership"
            );
            assert!(coordinator.worker_bootstrap_monitor.is_some());
            assert!(
                coordinator.monitor.worker.is_none(),
                "refused teardown remains fail closed"
            );
            abort.abort();
            drop(coordinator);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn harness_liveness_completion_before_close_cannot_be_exempted() {
        let (bridge, route) = liveness_test_bridge();
        let (bootstrap, abort) = liveness_test_bootstrap(route);
        let members = liveness_test_member_monitor();
        members
            .watch_harness(&bootstrap)
            .expect("watch real Harness tasks");
        abort.abort();
        wait_for_liveness_test_bootstrap(&bootstrap).await;
        let closed = members.begin_bridge_close();
        drop(members);
        assert_eq!(
            closed,
            Err(observed_harness_response()),
            "completion before close cannot settle as explicit close"
        );
        assert!(
            bridge.harness_ready(),
            "close rejection retains bridge ownership"
        );
    }

    #[tokio::test]
    async fn harness_liveness_result_checkpoint_joins_fence_before_publication() {
        let (_bridge, route) = liveness_test_bridge();
        let (bootstrap, abort) = liveness_test_bootstrap(route);
        let mut members = liveness_test_member_monitor();
        members
            .watch_harness(&bootstrap)
            .expect("watch real Harness tasks");
        assert_eq!(members.check_liveness(), Ok(()));
        abort.abort();
        wait_for_liveness_test_bootstrap(&bootstrap).await;
        let fault = members.check_liveness().expect_err("finished response");
        assert_eq!(fault, observed_harness_response());
        assert_failed_member(&fault, "subject=harness-response;observation=finished");
        assert!(
            members.worker.is_none(),
            "publication checkpoint joins fence acknowledgement"
        );

        // The runtime oracle above proves the barrier; this checks its actual caller binding.
        let main = include_str!("main.rs")
            .split_once("#[cfg(test)]")
            .expect("main production")
            .0;
        let effect = main
            .find("let executed = execute_effect_command(coordinator, &mut command)")
            .expect("synchronous effect caller");
        let checkpoint = main[effect..]
            .find("coordinator.check_member_liveness()")
            .expect("effect result checkpoint");
        let publication = main[effect..]
            .find("let result = match executed")
            .expect("result classification before publication");
        assert!(
            checkpoint < publication,
            "caller must complete the fence before accepting an effect result"
        );
    }

    /// Stops every short-lived shell child when the observation test returns.
    struct ReapTestChildren(Vec<std::process::Child>);

    impl Drop for ReapTestChildren {
        fn drop(&mut self) {
            for child in &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// Spawns one shell script with no inherited standard streams.
    fn shell_child(script: &str) -> std::process::Child {
        Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("short-lived test child")
    }

    /// Local health does not imply a Core acknowledgement when startup is invalidated.
    #[test]
    fn readiness_report_retains_local_proof_before_core_acknowledgement() {
        let root = std::env::temp_dir().join(format!(
            "nanohost-readiness-report-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let reports = root.join("reports");
        let readiness = Arc::new(super::AtomicU8::new(
            super::ReadinessProof::GatewayHealth as u8,
        ));
        let mut monitor = EpochMemberMonitor::start_with_namespaces(
            Vec::new(),
            None,
            EpochEvidenceWriter::new(reports.clone()).unwrap(),
            root.join("fence-started"),
            readiness,
            None,
        );
        monitor.invalidate_startup();
        let artifacts = std::fs::read_dir(&reports)
            .unwrap()
            .map(|entry| {
                serde_json::from_slice::<serde_json::Value>(
                    &std::fs::read(entry.unwrap().path()).unwrap(),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0]["trigger"], "epoch-creation-failure");
        assert_eq!(artifacts[0]["complete"], true);
        assert_eq!(artifacts[0]["fields"]["fence"], "initiated");
        assert_eq!(
            artifacts[0]["fields"]["readiness"],
            "last_succeeded=gateway-health"
        );
        assert!(root.join("fence-started").is_file());
        drop(monitor);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn member_monitor_child_exit_names_the_first_exited_role_and_code() {
        let (fence, requests) = std::sync::mpsc::sync_channel(1);
        let tasks = std::sync::Mutex::new(None);
        let mut children = ReapTestChildren(vec![
            shell_child("sleep 30"),
            shell_child("sleep 30"),
            shell_child("exit 7"),
            shell_child("sleep 30"),
        ]);
        let fault = EpochMemberMonitor::observe_members(&mut children.0, &requests, &tasks)
            .expect("third child exit");
        drop(fence);
        assert!(
            matches!(children.0[0].try_wait(), Ok(None)),
            "an earlier child that has not exited is not the failing member"
        );
        assert!(
            matches!(children.0[1].try_wait(), Ok(None)),
            "an earlier child that has not exited is not the failing member"
        );
        assert_eq!(
            fault,
            EpochFault::MemberExited(Some(MemberFailure::new(
                MemberFailureSubject::Dockerd,
                MemberObservation::ExitCode(7),
            )))
        );
        assert_failed_member(&fault, "subject=dockerd;observation=exit-code;code=7");
        let record = invalidation_report_fields(&fault);
        let failed_member = record
            .iter()
            .find(|(name, _)| *name == "failed_member")
            .map(|(_, value)| value.as_str())
            .unwrap_or("");
        assert!(!failed_member.contains("containerd"));
        assert!(!failed_member.contains("slirp4netns"));
    }

    #[tokio::test]
    async fn member_monitor_disconnect_records_proof_unavailable_without_a_status() {
        let mut members = liveness_test_member_monitor();
        let fence = std::mem::replace(&mut members.fence, std::sync::mpsc::sync_channel(1).0);
        drop(fence);
        let observed = tokio::time::timeout(Duration::from_secs(1), members.member_failure()).await;
        drop(members);
        let fault = observed.expect("monitor disconnect must wake the failure wait");
        assert_eq!(
            fault,
            EpochFault::MemberExited(Some(MemberFailure::new(
                MemberFailureSubject::Unknown,
                MemberObservation::ProofUnavailable(MemberProofKind::MonitorDisconnected),
            )))
        );
        assert_failed_member(
            &fault,
            "subject=unknown;observation=proof-unavailable;proof=monitor-disconnected",
        );
        let EpochFault::MemberExited(Some(failure)) = fault else {
            panic!("disconnect observation missing");
        };
        let tokens = failure.journal_tokens();
        assert!(!tokens.contains("code="));
        assert!(!tokens.contains("signal="));
    }

    #[test]
    fn member_failure_proofs_do_not_invent_an_exit_status() {
        use std::os::unix::process::ExitStatusExt;
        use std::process::ExitStatus;

        let tasks = Arc::new(Mutex::new(None));
        let watched = Arc::clone(&tasks);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = watched.lock().expect("lock before poison");
            panic!("poison harness lock");
        }));
        let (fence, requests) = std::sync::mpsc::sync_channel(1);
        let locked = EpochMemberMonitor::observe_members(&mut [], &requests, &tasks)
            .expect("poisoned harness lock");
        drop(fence);
        assert_eq!(
            locked,
            EpochFault::MemberExited(Some(MemberFailure::new(
                MemberFailureSubject::Unknown,
                MemberObservation::ProofUnavailable(MemberProofKind::LockFailure),
            )))
        );
        assert_failed_member(
            &locked,
            "subject=unknown;observation=proof-unavailable;proof=lock-failure",
        );

        let members = liveness_test_member_monitor();
        let absent = members.begin_bridge_close();
        drop(members);
        assert_eq!(
            absent,
            Err(EpochFault::MemberExited(Some(MemberFailure::new(
                MemberFailureSubject::Unknown,
                MemberObservation::ProofUnavailable(MemberProofKind::TasksAbsent),
            ))))
        );

        let wait = MemberFailure::from_child_wait(0, Err(std::io::Error::other("wait")))
            .expect("wait error");
        assert_eq!(
            wait,
            MemberFailure::new(
                MemberFailureSubject::Containerd,
                MemberObservation::ProofUnavailable(MemberProofKind::WaitError),
            )
        );
        assert!(!wait.report_value().contains("code="));
        assert!(!wait.report_value().contains("signal="));
        assert_eq!(
            MemberFailure::from_child_wait(2, Ok(Some(ExitStatus::from_raw(7 << 8))))
                .expect("exit code"),
            MemberFailure::new(
                MemberFailureSubject::Dockerd,
                MemberObservation::ExitCode(7)
            )
        );
        assert_eq!(
            MemberFailure::from_child_wait(3, Ok(Some(ExitStatus::from_raw(9)))).expect("signal"),
            MemberFailure::new(
                MemberFailureSubject::OpenShellGateway,
                MemberObservation::Signal(9),
            )
        );
        assert_eq!(
            MemberFailure::from_child_wait(1, Ok(Some(ExitStatus::from_raw(65))))
                .expect("out of range signal"),
            MemberFailure::new(
                MemberFailureSubject::Slirp4netns,
                MemberObservation::ProofUnavailable(MemberProofKind::WaitError),
            )
        );
        assert!(MemberFailure::from_child_wait(0, Ok(None)).is_none());
    }

    #[cfg(target_os = "linux")]
    const RESOLVER_CHILD_ENV: &str = "OPENKIT_NANOHOST_TEST_RESOLVER_CHILD";
    #[cfg(target_os = "linux")]
    const PRIVATE_MOUNT_SOURCE_ENV: &str = "OPENKIT_NANOHOST_TEST_MOUNT_SOURCE";
    #[cfg(target_os = "linux")]
    const PRIVATE_MOUNT_TARGET_ENV: &str = "OPENKIT_NANOHOST_TEST_MOUNT_TARGET";
    #[cfg(target_os = "linux")]
    const PRIVATE_MOUNT_READY_ENV: &str = "OPENKIT_NANOHOST_TEST_MOUNT_READY";
    #[cfg(target_os = "linux")]
    const PRIVATE_MOUNT_STOP_ENV: &str = "OPENKIT_NANOHOST_TEST_MOUNT_STOP";

    #[cfg(target_os = "linux")]
    fn answer_test_dns(socket: UdpSocket) {
        let mut query = [0_u8; 512];
        let (length, peer) = socket.recv_from(&mut query).expect("receive DNS query");
        let mut cursor = 12;
        while cursor < length && query[cursor] != 0 {
            cursor += usize::from(query[cursor]) + 1;
        }
        let question_end = cursor + 5;
        assert!(question_end <= length, "DNS question is bounded");
        assert_eq!(&query[question_end - 4..question_end], &[0, 1, 0, 1]);
        let mut response = query[..question_end].to_vec();
        response[2..12].copy_from_slice(&[0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
        response.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 17]);
        socket.send_to(&response, peer).expect("send DNS answer");
    }

    #[cfg(target_os = "linux")]
    fn assert_test_dns_resolution() {
        let host = CString::new("daemon-resolver.openkit.test").expect("DNS test host");
        // SAFETY: zero initializes the optional addrinfo hints.
        let mut hints: libc::addrinfo = unsafe { std::mem::zeroed() };
        hints.ai_family = libc::AF_INET;
        hints.ai_socktype = libc::SOCK_STREAM;
        let mut result = std::ptr::null_mut();
        // SAFETY: the host and hints remain live and the result is released below.
        let status =
            unsafe { libc::getaddrinfo(host.as_ptr(), std::ptr::null(), &hints, &mut result) };
        assert_eq!(status, 0, "private member must use projected DNS");
        assert!(!result.is_null(), "DNS resolution must return one address");
        // SAFETY: AF_INET success returns a sockaddr_in at ai_addr.
        let address = unsafe { &*((*result).ai_addr.cast::<libc::sockaddr_in>()) };
        assert_eq!(address.sin_addr.s_addr.to_ne_bytes(), [192, 0, 2, 17]);
        // SAFETY: getaddrinfo returned this owned result list.
        unsafe { libc::freeaddrinfo(result) };
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open("/etc/resolv.conf")
                .is_err(),
            "private resolver mount must be read-only"
        );
    }

    #[cfg(target_os = "linux")]
    fn set_test_loopback_up() {
        #[repr(C)]
        struct InterfaceRequest {
            name: [libc::c_char; libc::IFNAMSIZ],
            flags: libc::c_short,
            padding: [u8; 22],
        }

        let mut request = InterfaceRequest {
            name: [0; libc::IFNAMSIZ],
            flags: libc::IFF_UP as libc::c_short,
            padding: [0; 22],
        };
        request.name[..2].copy_from_slice(&[b'l' as libc::c_char, b'o' as libc::c_char]);
        // SAFETY: the fixed AF_INET control socket and Linux ifreq layout are
        // used only by this privileged Linux namespace regression.
        let socket = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
        assert!(socket >= 0, "create loopback control socket");
        // SAFETY: `request` is a live writable Linux ifreq for the fixed `lo` name.
        let status = unsafe { libc::ioctl(socket, libc::SIOCSIFFLAGS, &mut request) };
        // SAFETY: `socket` is owned by this helper and no longer used.
        unsafe { libc::close(socket) };
        assert_eq!(status, 0, "bring private loopback up");
    }

    #[cfg(target_os = "linux")]
    fn run_private_namespace_test_child(role: &str) {
        let source = std::env::var_os(PRIVATE_MOUNT_SOURCE_ENV)
            .map(std::path::PathBuf::from)
            .expect("private mount source");
        let target = std::env::var_os(PRIVATE_MOUNT_TARGET_ENV)
            .map(std::path::PathBuf::from)
            .expect("private mount target");
        match role {
            "creator" => {
                set_test_loopback_up();
                let source = CString::new(source.as_os_str().as_bytes()).expect("mount source");
                let target = CString::new(target.as_os_str().as_bytes()).expect("mount target");
                // SAFETY: both paths name live test-owned directories, and the
                // creator already occupies its recursively private mount tree.
                assert_eq!(
                    unsafe {
                        libc::mount(
                            source.as_ptr(),
                            target.as_ptr(),
                            std::ptr::null(),
                            libc::MS_BIND,
                            std::ptr::null(),
                        )
                    },
                    0,
                    "create private bind mount"
                );
                let socket = UdpSocket::bind(("127.0.0.1", 53)).expect("bind private test DNS");
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("bound private DNS timeout");
                fs::write(
                    std::env::var_os(PRIVATE_MOUNT_READY_ENV).expect("ready path"),
                    b"ready",
                )
                .expect("publish creator readiness");
                answer_test_dns(socket);
                let stop = std::env::var_os(PRIVATE_MOUNT_STOP_ENV)
                    .map(std::path::PathBuf::from)
                    .expect("stop path");
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while !stop.exists() && std::time::Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                assert!(stop.exists(), "creator stop signal");
            }
            "joiner" => {
                assert_test_dns_resolution();
                assert_eq!(
                    fs::read_to_string(target.join("marker")).expect("read private mount marker"),
                    "private-view",
                    "joiner must observe the creator's private mount"
                );
            }
            _ => panic!("unknown private namespace test role"),
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "requires root namespace privileges and an unused 127.0.0.1:53"]
    fn nhc_imp_5o_private_member_resolver_mount_drives_real_dns() {
        if let Some(role) = std::env::var_os(RESOLVER_CHILD_ENV) {
            run_private_namespace_test_child(&role.to_string_lossy());
            return;
        }

        assert_eq!(unsafe { libc::geteuid() }, 0, "test requires root");
        let host_resolver = fs::read("/etc/resolv.conf").expect("read host resolver");
        let resolver_target = fs::canonicalize("/etc/resolv.conf").expect("resolver target");
        let fixture_root = std::env::temp_dir().join(format!(
            "nanohost-private-resolver-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir(&fixture_root).expect("create resolver fixture");
        let resolver_source = fixture_root.join("resolv.conf");
        let mount_source = fixture_root.join("mount-source");
        let mount_target = fixture_root.join("mount-target");
        let ready_path = fixture_root.join("creator-ready");
        let stop_path = fixture_root.join("creator-stop");
        fs::create_dir(&mount_source).expect("create mount source");
        fs::create_dir(&mount_target).expect("create mount target");
        fs::write(mount_source.join("marker"), b"private-view").expect("write private marker");
        fs::write(mount_target.join("marker"), b"host-view").expect("write host marker");
        let mut resolver = File::create(&resolver_source).expect("create resolver projection");
        resolver
            .write_all(b"nameserver 127.0.0.1\noptions attempts:1 timeout:1\n")
            .expect("write resolver projection");
        drop(resolver);

        let child_args = vec![
            "--exact".into(),
            "epoch_coordinator::tests::nhc_imp_5o_private_member_resolver_mount_drives_real_dns"
                .into(),
            "--ignored".into(),
            "--nocapture".into(),
        ];
        let child_env = |role: &str| {
            vec![
                (RESOLVER_CHILD_ENV.into(), role.into()),
                (
                    PRIVATE_MOUNT_SOURCE_ENV.into(),
                    mount_source.display().to_string(),
                ),
                (
                    PRIVATE_MOUNT_TARGET_ENV.into(),
                    mount_target.display().to_string(),
                ),
                (
                    PRIVATE_MOUNT_READY_ENV.into(),
                    ready_path.display().to_string(),
                ),
                (
                    PRIVATE_MOUNT_STOP_ENV.into(),
                    stop_path.display().to_string(),
                ),
            ]
        };
        let creator = EpochMemberSpec {
            role: EpochProcessRole::Containerd,
            program: std::env::current_exe().expect("current test binary"),
            args: child_args.clone(),
            env: child_env("creator"),
            network_namespace_mode: EpochNetworkNamespaceMode::CreatePrivate,
            inherited_descriptor_targets: Vec::new(),
        };
        let mut children = Vec::new();
        spawn_member(
            &mut children,
            &creator,
            None,
            Some((&resolver_source, &resolver_target)),
        )
        .expect("spawn private namespace creator");
        let private_namespaces =
            super::retain_private_namespaces(children.last_mut().expect("namespace creator child"))
                .expect("retain creator namespaces");
        let ready_deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() && std::time::Instant::now() < ready_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready_path.exists(), "creator readiness");

        let joiner = EpochMemberSpec {
            role: EpochProcessRole::OpenShellGateway,
            program: std::env::current_exe().expect("current test binary"),
            args: child_args,
            env: child_env("joiner"),
            network_namespace_mode: EpochNetworkNamespaceMode::JoinPrivate,
            inherited_descriptor_targets: Vec::new(),
        };
        spawn_member(&mut children, &joiner, Some(&private_namespaces), None)
            .expect("spawn private namespace joiner");
        let joiner_succeeded = wait_for_child_success(
            children.last_mut().expect("private namespace joiner"),
            Instant::now() + Duration::from_secs(10),
        );
        fs::write(&stop_path, b"stop").expect("signal creator stop");
        let creator_succeeded = wait_for_child_success(
            children.first_mut().expect("private namespace creator"),
            Instant::now() + Duration::from_secs(10),
        );
        assert_eq!(
            fs::read("/etc/resolv.conf").expect("re-read host resolver"),
            host_resolver,
            "shared private resolver mount must preserve host bytes"
        );
        assert_eq!(
            fs::read_to_string(mount_target.join("marker")).expect("read host mount marker"),
            "host-view",
            "creator's private mount must not propagate to the host"
        );
        fs::remove_dir_all(fixture_root).expect("remove resolver fixture");
        assert!(creator_succeeded, "namespace creator exits cleanly");
        assert!(joiner_succeeded, "namespace joiner exits cleanly");
    }

    #[test]
    fn nhc_imp_5o_requires_one_up_tap0_default_route() {
        const HEADER: &str =
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n";
        let exact_default =
            format!("{HEADER}tap0\t00000000\t01020304\t0001\t0\t0\t0\t00000000\t0\t0\t0\n");
        let host_route_decoy =
            format!("{HEADER}tap0\t00000000\t01020304\t0001\t0\t0\t0\tFFFFFFFF\t0\t0\t0\n");
        let non_up_default =
            format!("{HEADER}tap0\t00000000\t01020304\t0000\t0\t0\t0\t00000000\t0\t0\t0\n");

        assert!(has_up_tap0_default_route(&exact_default));
        assert!(!has_up_tap0_default_route(&host_route_decoy));
        assert!(!has_up_tap0_default_route(&non_up_default));
    }

    #[test]
    fn nhc_imp_5o_orders_namespace_entry_and_gateway_connection_proofs() {
        let production = include_str!("epoch_coordinator.rs")
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("epoch coordinator production section")
            .0;
        let setns_network_wrapper = production
            .split_once("unsafe fn setns_network(fd: i32) -> i32 {")
            .expect("network setns wrapper")
            .1
            .split_once("/// Enters one retained Linux mount namespace.")
            .expect("end of network setns wrapper")
            .0;
        assert_eq!(
            setns_network_wrapper
                .matches("libc::setns(fd, libc::CLONE_NEWNET)")
                .count(),
            1
        );
        assert_eq!(setns_network_wrapper.matches("\n        -1\n").count(), 1);
        let setns_mount_wrapper = production
            .split_once("unsafe fn setns_mount(fd: i32) -> i32 {")
            .expect("mount setns wrapper")
            .1
            .split_once("/// Creates one fresh Linux network namespace.")
            .expect("end of mount setns wrapper")
            .0;
        assert_eq!(
            setns_mount_wrapper
                .matches("libc::setns(fd, libc::CLONE_NEWNS)")
                .count(),
            1
        );
        assert_eq!(setns_mount_wrapper.matches("\n        -1\n").count(), 1);
        let unshare_network_wrapper = production
            .split_once("unsafe fn unshare_network() -> i32 {")
            .expect("network unshare wrapper")
            .1
            .split_once("/// Reads one fresh 128-bit discriminator")
            .expect("end of network unshare wrapper")
            .0;
        assert_eq!(
            unshare_network_wrapper
                .matches("libc::unshare(libc::CLONE_NEWNET)")
                .count(),
            1
        );
        assert_eq!(unshare_network_wrapper.matches("\n        -1\n").count(), 1);

        let spawn = production
            .split_once("fn spawn_member(")
            .expect("member spawn owner")
            .1
            .split_once("/// Returns one namespace object's stable")
            .expect("end of member spawn owner")
            .0;
        let create_private = spawn
            .split_once("EpochNetworkNamespaceMode::CreatePrivate => {")
            .expect("CreatePrivate arm")
            .1
            .split_once("EpochNetworkNamespaceMode::JoinPrivate => {")
            .expect("end of CreatePrivate arm")
            .0;
        let create_pre_exec = create_private
            .find("command.pre_exec")
            .expect("CreatePrivate pre-exec owner");
        let create_call = create_private
            .find("if unshare_network() == 0")
            .expect("CreatePrivate unshare success polarity");
        let resolver_projection = create_private
            .find("mount_private_resolver(")
            .expect("creator resolver projection");
        let create_success = create_private.find("Ok(())").expect("unshare success");
        let create_failure = create_private
            .find("Err(io::Error::last_os_error())")
            .expect("unshare failure");
        assert!(
            create_pre_exec < create_call
                && create_call < resolver_projection
                && resolver_projection < create_success
                && create_success < create_failure
        );
        assert_eq!(create_private.matches("command.pre_exec").count(), 1);
        assert_eq!(create_private.matches("unshare_network()").count(), 1);
        assert_eq!(create_private.matches("mount_private_resolver(").count(), 1);

        let join_private = spawn
            .split_once("EpochNetworkNamespaceMode::JoinPrivate => {")
            .expect("JoinPrivate arm")
            .1
            .split_once("EpochNetworkNamespaceMode::Host if member.role()")
            .expect("end of JoinPrivate arm")
            .0;
        let network_descriptor = join_private
            .find("let network_namespace_fd = private_namespaces.network.as_raw_fd()")
            .expect("retained network namespace descriptor");
        let mount_descriptor = join_private
            .find("let mount_namespace_fd = private_namespaces.mount.as_raw_fd()")
            .expect("retained mount namespace descriptor");
        let join_pre_exec = join_private
            .find("command.pre_exec")
            .expect("JoinPrivate pre-exec owner");
        let join_network = join_private
            .find("if setns_network(network_namespace_fd) == 0")
            .expect("JoinPrivate network setns success polarity");
        let join_mount = join_private
            .find("&& setns_mount(mount_namespace_fd) == 0")
            .expect("JoinPrivate mount setns success polarity");
        let join_success = join_private.find("Ok(())").expect("setns success");
        let join_failure = join_private
            .find("Err(io::Error::last_os_error())")
            .expect("setns failure");
        assert!(
            network_descriptor < mount_descriptor
                && mount_descriptor < join_pre_exec
                && join_pre_exec < join_network
                && join_network < join_mount
                && join_mount < join_success
                && join_success < join_failure
        );
        assert_eq!(join_private.matches("command.pre_exec").count(), 1);
        assert_eq!(join_private.matches("setns_network(").count(), 1);
        assert_eq!(join_private.matches("setns_mount(").count(), 1);
        assert!(!join_private.contains("mount_private_resolver"));
        assert!(!join_private.contains("resolver_projection"));
        assert!(!join_private.contains("unshare"));

        let startup = production
            .split_once("pub fn start(")
            .expect("coordinator startup owner")
            .1
            .split_once("/// Returns the epoch-retained outer route")
            .expect("end of coordinator startup owner")
            .0;
        let dockerd = startup
            .split_once("let dockerd_ready =")
            .expect("dockerd readiness owner")
            .1
            .split_once("if !dockerd_ready")
            .expect("end of dockerd readiness owner")
            .0;
        assert_eq!(
            dockerd
                .matches("wait_for_member_namespaces(child, &private_namespaces)")
                .count(),
            1
        );
        let gateway_start = startup
            .find("&plan.members()[3]")
            .expect("Gateway spawn owner");
        let namespace_bind = startup
            .find(".bind_network_namespace(Arc::clone(&private_namespaces.network))")
            .expect("Gateway namespace binding");
        let gateway = &startup[gateway_start..namespace_bind];
        assert_eq!(
            gateway
                .matches("wait_for_member_namespaces(child, &private_namespaces)")
                .count(),
            1
        );
        let first_connect = startup
            .find("client.connect().await")
            .expect("first typed Gateway connect");
        assert_eq!(startup.matches(".bind_network_namespace(").count(), 1);
        assert!(namespace_bind < first_connect);

        let slirp_probe = production
            .split("fn wait_for_slirp_ready")
            .nth(1)
            .and_then(|source| source.split("fn wait_for_socket").next())
            .expect("slirp readiness owner");
        assert!(slirp_probe.contains("/proc/thread-self/net/route"));
        assert!(!slirp_probe.contains("\"/proc/net/route\""));
        assert!(slirp_probe.contains("libc::if_nametoindex(c\"tap0\".as_ptr())"));

        let slirp_spawn = production
            .split(
                "EpochNetworkNamespaceMode::Host if member.role() == EpochProcessRole::Slirp4netns",
            )
            .nth(1)
            .and_then(|source| source.split("EpochNetworkNamespaceMode::Host =>").next())
            .expect("slirp spawn owner");
        let private_mount_namespace = slirp_spawn
            .find("libc::unshare(libc::CLONE_NEWNS)")
            .expect("slirp mount namespace creation");
        let recursive_private_mounts = slirp_spawn
            .find("libc::MS_REC | libc::MS_PRIVATE")
            .expect("slirp recursive private mount tree");
        assert!(slirp_spawn.contains("c\"/\".as_ptr()"));
        let inherited_descriptors = slirp_spawn
            .find("libc::dup2(staged_ready.as_raw_fd(), 3)")
            .expect("slirp inherited descriptor projection");
        assert!(private_mount_namespace < recursive_private_mounts);
        assert!(recursive_private_mounts < inherited_descriptors);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn nhc_imp_5o_keeps_slirp_inherited_descriptors_open_through_spawn() {
        let member = EpochMemberSpec {
            role: EpochProcessRole::Slirp4netns,
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "test -e /dev/fd/4 && printf R >&3".into()],
            env: Vec::new(),
            network_namespace_mode: EpochNetworkNamespaceMode::Host,
            inherited_descriptor_targets: vec![3, 4],
        };
        let private_namespaces = super::PrivateNamespaceDescriptors {
            network: Arc::new(
                File::open("/proc/self/ns/net")
                    .expect("current network namespace descriptor")
                    .into(),
            ),
            mount: Arc::new(
                File::open("/proc/self/ns/mnt")
                    .expect("current mount namespace descriptor")
                    .into(),
            ),
        };
        let mut children = Vec::new();

        let effective_capabilities = std::fs::read_to_string("/proc/self/status")
            .expect("Linux process status")
            .lines()
            .find_map(|line| line.strip_prefix("CapEff:\t"))
            .and_then(|value| u64::from_str_radix(value, 16).ok())
            .expect("effective Linux capabilities");
        let spawn = spawn_member(&mut children, &member, Some(&private_namespaces), None);
        if effective_capabilities & (1 << 21) == 0 {
            let error = spawn.expect_err("mount namespace creation fails without CAP_SYS_ADMIN");
            assert_eq!(error.raw_os_error(), Some(libc::EPERM));
            assert!(children.is_empty());
            return;
        }
        let mut ready_reader = spawn
            .expect("Slirp child starts with live inherited descriptor sources")
            .expect("Slirp ready reader");
        ready_reader
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("bounded ready read");
        let mut ready = [0_u8; 1];
        ready_reader
            .read_exact(&mut ready)
            .expect("child proves fd4 and writes readiness on fd3");

        assert_eq!(ready, [b'R']);
        assert_eq!(children.len(), 1);
        assert!(wait_for_child_success(
            children.first_mut().expect("spawned child"),
            Instant::now() + Duration::from_secs(1),
        ));
    }

    /// In-memory backend probe for import ordering, bounds, and verification results.
    #[derive(Default)]
    struct ImportBackend {
        present: BTreeSet<String>,
        inspected: BTreeMap<String, String>,
        imports: Vec<(String, Duration)>,
        fail_import: bool,
    }

    impl ImageBackend for ImportBackend {
        fn contains_digest(&mut self, digest: &str) -> Result<bool, ImageImportError> {
            Ok(self.present.contains(digest))
        }

        fn import_verified(
            &mut self,
            digest: &str,
            _content: File,
            timeout: Duration,
        ) -> Result<(), ImageImportError> {
            self.imports.push((digest.to_string(), timeout));
            if self.fail_import {
                return Err(ImageImportError::Load);
            }
            self.present.insert(digest.to_string());
            Ok(())
        }

        fn inspect_digest(&mut self, digest: &str) -> Result<String, ImageImportError> {
            Ok(self
                .inspected
                .get(digest)
                .cloned()
                .unwrap_or_else(|| digest.to_string()))
        }
    }

    /// Creates an isolated store and admits one verified image fixture.
    fn admitted_store(label: &str, content: &[u8]) -> (ImageStore, String, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "openkit-wp3b-import-{}-{label}",
            std::process::id()
        ));
        let archive = crate::image_acquisition::test_oci_archive(content);
        let digest = crate::image_acquisition::oci_manifest_digest(&archive)
            .expect("fixture manifest digest");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture root");
        let archive_path = root.join("fixture.oci.tar");
        std::fs::write(&archive_path, archive).expect("fixture archive");
        let store = ImageStore::open(
            root.join("store"),
            root.join("epoch"),
            &[root.join("credentials")],
        )
        .expect("isolated store");
        store
            .admit_oci_file(
                &digest,
                File::open(archive_path).expect("open fixture archive"),
                StoreLineage::Registry(format!("ghcr.io/openkit/worker@{digest}")),
                1,
            )
            .expect("verified fixture");
        (store, digest, root)
    }

    /// Returns one deterministic accepted resolver set for plan projection tests.
    fn accepted_nameservers() -> Vec<std::net::Ipv4Addr> {
        resolve_epoch_nameservers("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
            .expect("accepted resolver fixture")
    }

    #[test]
    fn wp3a_u3a1_builds_fresh_direct_argv_epoch_members() {
        let state_root = Path::new("/var/lib/openkit/nanohost");
        let run_root = Path::new("/run/openkit/nanohost");
        let gateway = Path::new("/usr/lib/openkit/openshell-gateway");
        let nameservers = accepted_nameservers();
        let first = EpochPlan::fresh(state_root, run_root, gateway, &nameservers)
            .expect("first fresh plan");
        let second = EpochPlan::fresh(state_root, run_root, gateway, &nameservers)
            .expect("second fresh plan");

        assert_ne!(first.epoch_root(), second.epoch_root());
        assert_ne!(first.containerd_socket(), second.containerd_socket());
        assert_ne!(first.docker_socket(), second.docker_socket());
        assert_ne!(first.gateway_auth_path(), second.gateway_auth_path());
        assert!(first.epoch_root().starts_with(state_root));
        assert_eq!(
            first.resolver_path(),
            first.epoch_root().join("resolv.conf")
        );
        assert_eq!(
            first.resolver_contents(),
            "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"
        );
        for path in [first.containerd_socket(), first.docker_socket()] {
            assert!(path.starts_with(run_root));
            assert!(
                path.to_str().expect("ASCII production socket path").len() <= 107,
                "production Unix socket path exceeds Linux sun_path: {}",
                path.display()
            );
        }
        assert!(
            first.gateway_auth_path().starts_with(state_root)
                || first.gateway_auth_path().starts_with(run_root)
        );

        let members = first.members();
        assert_eq!(
            members
                .iter()
                .map(|member| member.role())
                .collect::<Vec<_>>(),
            vec![
                EpochProcessRole::Containerd,
                EpochProcessRole::Slirp4netns,
                EpochProcessRole::Dockerd,
                EpochProcessRole::OpenShellGateway,
            ]
        );
        for member in members {
            assert!(!matches!(
                member.program().file_name().and_then(|name| name.to_str()),
                Some("sh" | "bash" | "env")
            ));
            assert!(!member.args().iter().any(|arg| arg == "-c"));
            assert!(member.foreground());
        }
        assert_eq!(
            members
                .iter()
                .map(|member| member.network_namespace_mode())
                .collect::<Vec<_>>(),
            vec![
                EpochNetworkNamespaceMode::CreatePrivate,
                EpochNetworkNamespaceMode::Host,
                EpochNetworkNamespaceMode::JoinPrivate,
                EpochNetworkNamespaceMode::JoinPrivate,
            ]
        );

        let dockerd = members
            .iter()
            .find(|member| member.role() == EpochProcessRole::Dockerd)
            .expect("dockerd member");
        let containerd = members
            .iter()
            .find(|member| member.role() == EpochProcessRole::Containerd)
            .expect("containerd member");
        let gateway = members
            .iter()
            .find(|member| member.role() == EpochProcessRole::OpenShellGateway)
            .expect("Gateway member");
        let slirp = members
            .iter()
            .find(|member| member.role() == EpochProcessRole::Slirp4netns)
            .expect("slirp4netns member");
        let containerd_argv = containerd.args().join(" ");
        let dockerd_argv = dockerd.args().join(" ");
        assert!(containerd_argv.contains(&first.epoch_root().display().to_string()));
        assert!(containerd_argv.contains(&first.containerd_socket().display().to_string()));
        assert!(dockerd_argv.contains(&first.epoch_root().display().to_string()));
        assert!(dockerd_argv.contains(&first.containerd_socket().display().to_string()));
        assert!(dockerd_argv.contains(&first.docker_socket().display().to_string()));
        assert!(
            dockerd
                .args()
                .windows(2)
                .any(|args| args == ["--dns", "1.1.1.1"])
        );
        assert!(
            dockerd
                .args()
                .windows(2)
                .any(|args| args == ["--dns", "8.8.8.8"])
        );
        assert_eq!(
            dockerd.args().iter().filter(|arg| *arg == "--dns").count(),
            2
        );
        assert!(
            dockerd
                .args()
                .windows(2)
                .any(|args| { args[0] == "--feature" && args[1] == "containerd-snapshotter=true" })
        );
        assert!(
            dockerd
                .args()
                .windows(2)
                .any(|args| { args[0] == "--cgroup-parent" && args[1] == OPENKIT_NANOHOST_SLICE })
        );
        assert_eq!(
            gateway.program(),
            Path::new("/usr/lib/openkit/openshell-gateway")
        );
        assert_eq!(slirp.program(), Path::new("/usr/bin/slirp4netns"));
        assert_eq!(slirp.inherited_descriptor_targets(), [3, 4]);
        assert_eq!(
            slirp.args(),
            [
                "--configure",
                "--disable-host-loopback",
                "--disable-dns",
                "--enable-sandbox",
                "--enable-seccomp",
                "--ready-fd=3",
                "--netns-type=path",
                "/proc/self/fd/4",
                "tap0",
            ]
        );

        for rejected in ["--socket", "--auth-file", "--docker-host"] {
            assert!(!gateway.args().iter().any(|arg| arg == rejected));
        }
        for required in [
            "--config",
            "--bind-address",
            "--port",
            "--db-url",
            "--drivers",
        ] {
            assert!(gateway.args().iter().any(|arg| arg == required));
        }
        let value_after = |flag: &str| {
            let position = gateway
                .args()
                .iter()
                .position(|arg| arg == flag)
                .expect("required Gateway flag");
            gateway
                .args()
                .get(position + 1)
                .expect("Gateway flag value")
        };
        assert_eq!(value_after("--bind-address"), "127.0.0.1");
        assert_eq!(value_after("--drivers"), "docker");
        assert!(value_after("--config").contains(&first.epoch_root().display().to_string()));
        assert!(value_after("--db-url").contains(&first.epoch_root().display().to_string()));
        let gateway_config = first.gateway_config_contents();
        assert!(gateway_config.contains(&first.docker_socket().display().to_string()));
        assert!(gateway_config.contains(&first.gateway_auth_path().display().to_string()));
        let supervisor_image = crate::openshell_release::supervisor_image().unwrap();
        assert!(gateway_config.contains(&format!("supervisor_image = \"{supervisor_image}\"")));
        assert!(gateway_config.contains("enable_bind_mounts = true"));
        assert!(
            !gateway_config.contains(
                "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6"
            )
        );
        assert!(!gateway_config.contains("supervisor_bin"));
    }

    #[test]
    fn nhc_imp_5o_resolves_one_to_three_unique_unicast_ipv4_nameservers() {
        for (source, expected) in [
            ("nameserver 1.1.1.1\n", vec!["1.1.1.1"]),
            (
                "search example.invalid\nnameserver 1.1.1.1\noptions edns0\nnameserver 8.8.8.8\n",
                vec!["1.1.1.1", "8.8.8.8"],
            ),
            (
                "# resolver set\nnameserver 9.9.9.9\nnameserver 149.112.112.112\nnameserver 1.0.0.1\n",
                vec!["9.9.9.9", "149.112.112.112", "1.0.0.1"],
            ),
        ] {
            assert_eq!(
                resolve_epoch_nameservers(source)
                    .expect("accepted resolver set")
                    .into_iter()
                    .map(|address| address.to_string())
                    .collect::<Vec<_>>(),
                expected
            );
        }

        for rejected in [
            "",
            "search example.invalid\noptions edns0\n",
            "nameserver 1.1.1.1\nnameserver 1.1.1.1\n",
            "nameserver 0.0.0.0\n",
            "nameserver 127.0.0.1\n",
            "nameserver 224.0.0.1\n",
            "nameserver 255.255.255.255\n",
            "nameserver 2001:4860:4860::8888\n",
            "nameserver not-an-address\n",
            "nameserver 1.1.1.1 trailing\n",
            "nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 9.9.9.9\nnameserver 1.0.0.1\n",
        ] {
            assert!(
                resolve_epoch_nameservers(rejected).is_err(),
                "accepted invalid resolver source {rejected:?}"
            );
        }

        let resolvers = resolve_epoch_nameservers(
            "nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 9.9.9.9\n",
        )
        .expect("three accepted resolvers");
        assert_eq!(
            dockerd_dns_arguments(&resolvers),
            ["--dns", "1.1.1.1", "--dns", "8.8.8.8", "--dns", "9.9.9.9",]
        );
    }

    #[test]
    fn physical_epoch_is_stable_for_one_plan_and_changes_for_replacement() {
        let state_root = Path::new("/var/lib/openkit/nanohost");
        let run_root = Path::new("/run/openkit/nanohost");
        let gateway = Path::new("/usr/lib/openkit/openshell-gateway");
        let nameservers = accepted_nameservers();
        let first = EpochPlan::fresh(state_root, run_root, gateway, &nameservers)
            .expect("first fresh plan");
        let replacement = EpochPlan::fresh(state_root, run_root, gateway, &nameservers)
            .expect("replacement fresh plan");

        let first_physical_epoch = physical_epoch_for_plan(&first);
        let epoch_name = first
            .epoch_root()
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .expect("ASCII epoch name");
        assert_eq!(first.run_root().file_name(), first.epoch_root().file_name());
        assert_eq!(
            first_physical_epoch,
            format!("{:x}", Sha256::digest(epoch_name.as_bytes()))
        );
        assert_eq!(first_physical_epoch, physical_epoch_for_plan(&first));
        assert_eq!(first_physical_epoch.len(), 64);
        assert!(
            first_physical_epoch
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert_ne!(first_physical_epoch, physical_epoch_for_plan(&replacement));
    }

    #[test]
    fn random_discriminator_produces_distinct_bounded_replacement_epoch_names() {
        let first = compose_epoch_name(&[0x11; 16]);
        let replacement = compose_epoch_name(&[0x22; 16]);

        assert_eq!(first, format!("epoch-{}", "11".repeat(16)));
        assert_eq!(replacement, format!("epoch-{}", "22".repeat(16)));
        assert_ne!(first, replacement);
        assert_ne!(
            format!("{:x}", Sha256::digest(first.as_bytes())),
            format!("{:x}", Sha256::digest(replacement.as_bytes()))
        );
    }

    #[test]
    fn nhc_imp_5o_reaps_members_before_releasing_the_private_namespace_descriptors() {
        let production = include_str!("epoch_coordinator.rs")
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("epoch coordinator production section")
            .0;
        let owner = production
            .split_once("impl Drop for OwnedEpochChildren")
            .expect("owned epoch teardown")
            .1
            .split_once("impl EpochMemberMonitor")
            .expect("end of owned epoch teardown")
            .0;
        let terminate = owner
            .find("terminate_children")
            .expect("member termination and reap");
        let release = owner
            .find("private_namespaces.take()")
            .expect("retained namespace descriptor release");
        assert!(terminate < release);
    }

    #[test]
    fn wp3a_u3a1_fail_stops_every_uncertain_or_partial_epoch() {
        for fault in [
            EpochFault::PartialStart,
            EpochFault::MemberExited(None),
            EpochFault::IdentityMismatch,
            EpochFault::CreateOutcomeUncertain(CreateUncertainty::new(
                CreateCertaintyLossPoint::ReadyErrorPhase,
                "sandbox-lineage",
                "attempt-lineage",
                Duration::from_millis(17),
            )),
            EpochFault::DeleteOutcomeUncertain,
        ] {
            assert_eq!(fault.action(), EpochAction::TerminateProcess);
        }
    }

    #[test]
    fn uncertain_create_report_retains_only_owned_bounded_context() {
        for (point, expected) in [
            (
                CreateCertaintyLossPoint::CreateRequestUnproved,
                "create-request-unproved",
            ),
            (
                CreateCertaintyLossPoint::CreateResponseInvalid,
                "create-response-invalid",
            ),
            (
                CreateCertaintyLossPoint::ReadyObservationUnproved,
                "ready-observation-unproved",
            ),
            (
                CreateCertaintyLossPoint::ReadyErrorPhase,
                "ready-error-phase",
            ),
            (CreateCertaintyLossPoint::ReadyTimeout, "ready-timeout"),
        ] {
            assert_eq!(point.as_str(), expected);
        }
        let fault = EpochFault::CreateOutcomeUncertain(CreateUncertainty::new(
            CreateCertaintyLossPoint::ReadyErrorPhase,
            "sandbox-lineage",
            "attempt-lineage",
            Duration::from_millis(17),
        ));
        assert_eq!(
            invalidation_trigger(&fault),
            EpochInvalidationTrigger::UncertainCreate
        );
        assert_eq!(
            invalidation_report_fields(&fault),
            vec![
                ("operation", "sandbox.create".to_string()),
                ("sandbox", "sandbox-lineage".to_string()),
                ("attempt", "attempt-lineage".to_string()),
                ("certainty_loss", "ready-error-phase".to_string()),
                ("timing", "elapsed_ms=17".to_string()),
                ("fence", "initiated".to_string()),
            ]
        );
    }

    #[test]
    fn occupied_epoch_rejects_second_create_before_the_gateway_effect() {
        let request = LifecycleEffectRequest::new(
            "request",
            "lease",
            "replacement",
            LifecycleEffectKind::CreateSandbox,
        );
        for (sandbox, bridge, monitor) in [
            (Some("retained"), false, false),
            (Some("replacement"), true, true),
            (None, true, false),
            (None, false, true),
        ] {
            assert_eq!(
                preflight_lifecycle_result(&request, sandbox, bridge, monitor, true),
                Err(EpochFault::IdentityMismatch),
            );
        }
        assert_eq!(
            preflight_lifecycle_result(&request, None, false, false, true),
            Ok(None),
        );
    }

    #[test]
    fn fresh_empty_epoch_settles_only_exact_cleanup_absence() {
        let request = |kind| LifecycleEffectRequest::new("request", "lease", "sandbox", kind);

        assert_eq!(
            preflight_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                None,
                false,
                false,
                false,
            ),
            Ok(Some("closed"))
        );
        assert_eq!(
            preflight_lifecycle_result(
                &request(LifecycleEffectKind::DeleteSandbox),
                None,
                false,
                false,
                false,
            ),
            Ok(Some("deleted"))
        );
        for kind in [
            LifecycleEffectKind::CreateSandbox,
            LifecycleEffectKind::OpenBridge,
        ] {
            assert_eq!(
                preflight_lifecycle_result(&request(kind), None, false, false, false),
                Ok(None)
            );
        }
        for (bridge_present, monitor_present) in [(true, false), (false, true)] {
            assert_eq!(
                preflight_lifecycle_result(
                    &request(LifecycleEffectKind::CloseBridge),
                    None,
                    bridge_present,
                    monitor_present,
                    false,
                ),
                Err(EpochFault::IdentityMismatch)
            );
        }
        assert_eq!(
            preflight_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                Some("sandbox"),
                true,
                true,
                false,
            ),
            Ok(None)
        );
        assert_eq!(
            preflight_lifecycle_result(
                &request(LifecycleEffectKind::DeleteSandbox),
                Some("sandbox"),
                false,
                true,
                false,
            ),
            Ok(None)
        );
        for (kind, bridge_present) in [
            (LifecycleEffectKind::CloseBridge, false),
            (LifecycleEffectKind::DeleteSandbox, true),
        ] {
            assert_eq!(
                preflight_lifecycle_result(
                    &request(kind),
                    Some("sandbox"),
                    bridge_present,
                    true,
                    false,
                ),
                Err(EpochFault::IdentityMismatch)
            );
        }
        assert_eq!(
            preflight_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                Some("sandbox"),
                true,
                false,
                false,
            ),
            Err(EpochFault::IdentityMismatch)
        );
        assert_eq!(
            preflight_lifecycle_result(
                &LifecycleEffectRequest::new(
                    "request",
                    "lease",
                    "other-sandbox",
                    LifecycleEffectKind::CloseBridge,
                ),
                Some("sandbox"),
                true,
                true,
                false,
            ),
            Err(EpochFault::IdentityMismatch)
        );
        assert_eq!(
            preflight_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                None,
                false,
                false,
                true,
            ),
            Err(EpochFault::IdentityMismatch)
        );
        assert_eq!(
            preflight_lifecycle_result(
                &LifecycleEffectRequest::new(
                    "",
                    "lease",
                    "sandbox",
                    LifecycleEffectKind::DeleteSandbox,
                ),
                None,
                false,
                false,
                false,
            ),
            Err(EpochFault::IdentityMismatch)
        );
    }

    #[test]
    fn wp3a_u3a1_fences_host_docker_and_cert_state_inside_each_epoch() {
        let nameservers = accepted_nameservers();
        let first = EpochPlan::fresh(
            Path::new("/var/lib/openkit/nanohost"),
            Path::new("/run/openkit/nanohost"),
            Path::new("/usr/lib/openkit/openshell-gateway"),
            &nameservers,
        )
        .expect("first fresh plan");
        let second = EpochPlan::fresh(
            Path::new("/var/lib/openkit/nanohost"),
            Path::new("/run/openkit/nanohost"),
            Path::new("/usr/lib/openkit/openshell-gateway"),
            &nameservers,
        )
        .expect("second fresh plan");
        /// Returns the dockerd value following one required isolation flag.
        fn value_after<'a>(plan: &'a EpochPlan, flag: &str) -> &'a String {
            let args = plan
                .members()
                .iter()
                .find(|member| member.role() == EpochProcessRole::Dockerd)
                .expect("dockerd member")
                .args();
            let position = args
                .iter()
                .position(|arg| arg == flag)
                .expect("required dockerd isolation flag");
            args.get(position + 1).expect("dockerd isolation value")
        }

        assert_eq!(value_after(&first, "--config-file"), "/dev/null");
        for flag in ["--containerd-namespace", "--containerd-plugins-namespace"] {
            let first_namespace = value_after(&first, flag);
            let second_namespace = value_after(&second, flag);
            assert_ne!(first_namespace, second_namespace);
            assert!(!first_namespace.is_empty());
        }
        assert_eq!(value_after(&first, "--bridge"), "none");
        assert_eq!(value_after(&second, "--bridge"), "none");
        assert!(
            first
                .gateway_config_contents()
                .contains("[openshell.drivers.docker]")
        );

        let cert_command = gateway_cert_command(&first);
        assert_eq!(
            cert_command.get_program(),
            Path::new("/usr/lib/openkit/openshell-gateway")
        );
        let cert_args = cert_command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(cert_args.iter().any(|arg| arg == "generate-certs"));
        assert_eq!(
            cert_args
                .windows(2)
                .filter_map(|args| (args[0] == "--server-san").then_some(args[1].as_ref()))
                .collect::<Vec<_>>(),
            vec!["127.0.0.1", "host.openshell.internal"]
        );
        assert!(
            cert_args
                .iter()
                .any(|arg| arg == &first.gateway_auth_path().to_string_lossy())
        );
        for variable in ["HOME", "XDG_CONFIG_HOME"] {
            let value = cert_command
                .get_envs()
                .find_map(|(key, value)| (key == variable).then_some(value).flatten())
                .expect("epoch-local cert-generation environment");
            assert!(Path::new(value).starts_with(first.epoch_root()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn wp5_stabilization_classifies_gateway_auth_wait_and_logging() {
        unsafe extern "C" {
            fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
        }

        let mut succeeded = Command::new("/usr/bin/true")
            .spawn()
            .expect("successful direct child");
        assert_eq!(wait_for_success(&mut succeeded), Ok(()));

        let mut nonzero = Command::new("/usr/bin/false")
            .spawn()
            .expect("nonzero direct child");
        assert_eq!(wait_for_success(&mut nonzero), Err("nonzero"));

        let mut already_reaped = Command::new("/usr/bin/true")
            .spawn()
            .expect("direct child for invalid wait");
        let child_pid = already_reaped.id() as i32;
        let mut status = 0;
        // SAFETY: `already_reaped` is this process's live child, and `status` is a valid output slot.
        assert_eq!(unsafe { waitpid(child_pid, &mut status, 0) }, child_pid);
        assert_eq!(wait_for_success(&mut already_reaped), Err("wait"));

        let production = include_str!("epoch_coordinator.rs")
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("coordinator production section")
            .0;
        let gateway_auth = production
            .split_once("fn generate_gateway_auth")
            .expect("Gateway auth generation")
            .1
            .split_once("fn gateway_cert_command")
            .expect("end of Gateway auth generation")
            .0;
        assert!(gateway_auth.contains(".stdout(Stdio::null())"));
        assert!(gateway_auth.contains(".stderr(Stdio::null())"));
        assert!(gateway_auth.contains("stage=gateway-auth outcome=spawn"));
        assert!(gateway_auth.contains("stage=gateway-auth outcome={"));
        assert!(!gateway_auth.contains(".output()"));

        let wait = production
            .split_once("fn wait_for_success")
            .expect("Gateway auth child wait")
            .1
            .split_once("fn wait_for_child_success")
            .expect("end of Gateway auth child wait")
            .0;
        assert!(wait.contains("Err(\"timeout\")"));

        let startup = production
            .split_once("pub fn start(")
            .expect("coordinator startup")
            .1
            .split_once("/// Creates a sandbox")
            .expect("end of coordinator startup")
            .0;
        let gateway_auth_failure = startup
            .split_once("if !generate_gateway_auth(plan)")
            .expect("Gateway auth failure branch")
            .1
            .split_once("let runtime = Handle::current()")
            .expect("end of Gateway auth failure branch")
            .0;
        assert!(gateway_auth_failure.contains("return Err(EpochFault::PartialStart);"));
    }

    #[test]
    fn wp3a_u3a1_enters_the_runtime_before_constructing_startup_timeout() {
        let production = include_str!("epoch_coordinator.rs")
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("coordinator production section");
        let startup = production
            .split("pub fn start")
            .nth(1)
            .and_then(|source| source.split("pub fn create_sandbox").next())
            .expect("coordinator startup path");

        assert!(!startup.contains("block_on(timeout("));
        let runtime_future = startup
            .split("block_on(async")
            .nth(1)
            .expect("startup future entered through the Tokio runtime");
        assert!(runtime_future.contains("timeout("));
        assert!(runtime_future.contains(".await"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wp5_f6_reuses_the_process_runtime_and_joins_the_monitor_without_masking_errors() {
        let handle = tokio::runtime::Handle::current();
        let driven = tokio::task::block_in_place(|| handle.block_on(async { "effect-complete" }));
        assert_eq!(driven, "effect-complete");

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openkit-wp5-f6-runtime-{}-{nonce}",
            std::process::id()
        ));
        let normal = {
            let evidence = EpochEvidenceWriter::new(root.join("normal")).expect("normal evidence");
            let _monitor = EpochMemberMonitor::start(Vec::new(), evidence);
            Ok::<(), &'static str>(())
        };
        assert_eq!(normal, Ok(()));
        let original_error = {
            let evidence = EpochEvidenceWriter::new(root.join("error")).expect("error evidence");
            let _monitor = EpochMemberMonitor::start(Vec::new(), evidence);
            Err::<(), &'static str>("post-readiness session failed")
        };
        assert_eq!(original_error, Err("post-readiness session failed"));
        let _ = std::fs::remove_dir_all(root);

        let production = include_str!("epoch_coordinator.rs")
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("coordinator production section")
            .0;
        assert!(!production.contains("use tokio::runtime::Runtime"));
        assert!(!production.contains("runtime: Runtime"));
        assert!(!production.contains("Runtime::new()"));
        assert!(production.contains("use tokio::runtime::Handle"));
        assert!(production.contains("runtime: Handle"));
        let startup = production
            .split_once("pub fn start(")
            .expect("coordinator startup")
            .1
            .split_once("/// Creates a sandbox")
            .expect("end of coordinator startup")
            .0;
        assert!(startup.contains("Handle::current()"));
        assert!(startup.contains("tokio::task::block_in_place"));
        assert!(startup.contains("runtime.block_on"));
        assert!(production.contains("self.runtime.block_on"));
        let monitor_drop = production
            .split_once("impl Drop for EpochMemberMonitor")
            .expect("normal monitor teardown")
            .1
            .split_once("impl EpochCoordinator")
            .expect("end of monitor teardown")
            .0;
        assert!(monitor_drop.contains("self.fence.send(None)"));
        assert!(monitor_drop.contains("worker.join()"));
    }

    #[test]
    fn wp3a_u3a1_retries_transient_gateway_readiness_without_retrying_identity_mismatch() {
        let production = include_str!("epoch_coordinator.rs")
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("coordinator production section");
        let startup = production
            .split("pub fn start")
            .nth(1)
            .and_then(|source| source.split("pub fn create_sandbox").next())
            .expect("coordinator startup path");
        let gateway_spawn = startup
            .find("plan.members()[3]")
            .expect("Gateway spawn path");
        let bounded_readiness = startup
            .find("timeout(STARTUP_TIMEOUT")
            .expect("bounded Gateway readiness path");
        assert!(gateway_spawn < bounded_readiness);

        let readiness_future = &startup[bounded_readiness..];
        assert!(readiness_future.contains("loop"));
        assert!(!readiness_future.contains("client.connect().await?"));
        assert!(readiness_future.contains("client.connect().await"));
        assert!(readiness_future.contains("client.health().await"));
        assert!(readiness_future.contains("EpochFault::IdentityMismatch"));
        assert!(readiness_future.contains("sleep("));
    }

    #[test]
    fn wp3a_u3a1_projects_epoch_local_home_and_tls_into_the_stock_gateway_child() {
        let nameservers = accepted_nameservers();
        let first = EpochPlan::fresh(
            Path::new("/var/lib/openkit/nanohost"),
            Path::new("/run/openkit/nanohost"),
            Path::new("/usr/lib/openkit/openshell-gateway"),
            &nameservers,
        )
        .expect("first fresh plan");
        let second = EpochPlan::fresh(
            Path::new("/var/lib/openkit/nanohost"),
            Path::new("/run/openkit/nanohost"),
            Path::new("/usr/lib/openkit/openshell-gateway"),
            &nameservers,
        )
        .expect("second fresh plan");
        let first_gateway = first
            .members()
            .iter()
            .find(|member| member.role() == EpochProcessRole::OpenShellGateway)
            .expect("first Gateway member");
        let second_gateway = second
            .members()
            .iter()
            .find(|member| member.role() == EpochProcessRole::OpenShellGateway)
            .expect("second Gateway member");
        let first_local_tls = first_gateway
            .env()
            .iter()
            .filter(|(key, _)| key == "OPENSHELL_LOCAL_TLS_DIR")
            .collect::<Vec<_>>();
        let second_local_tls = second_gateway
            .env()
            .iter()
            .filter(|(key, _)| key == "OPENSHELL_LOCAL_TLS_DIR")
            .collect::<Vec<_>>();

        assert_eq!(
            first_local_tls,
            vec![&(
                "OPENSHELL_LOCAL_TLS_DIR".to_string(),
                first.gateway_auth_path().display().to_string(),
            )]
        );
        assert_eq!(
            second_local_tls,
            vec![&(
                "OPENSHELL_LOCAL_TLS_DIR".to_string(),
                second.gateway_auth_path().display().to_string(),
            )]
        );
        assert_ne!(first.gateway_auth_path(), second.gateway_auth_path());
        for plan in [&first, &second] {
            let gateway = plan
                .members()
                .iter()
                .find(|member| member.role() == EpochProcessRole::OpenShellGateway)
                .expect("Gateway member");
            assert_eq!(
                gateway.env().iter().find(|(key, _)| key == "HOME"),
                Some(&(
                    "HOME".to_string(),
                    plan.epoch_root().join("home").display().to_string(),
                ))
            );
        }

        let production = include_str!("epoch_coordinator.rs")
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("coordinator production section");
        let spawn_member = production
            .split("fn spawn_member")
            .nth(1)
            .and_then(|source| source.split("fn wait_for_socket").next())
            .expect("member Command projection");
        assert!(spawn_member.contains(".envs(member.env().iter().cloned())"));
    }

    #[test]
    fn image_import_deadline_is_not_rebased_and_expiry_reaps_the_child() {
        let (store, digest, root) = admitted_store("expired-import", b"deadline-content");
        let content = store.read_verified(&digest).expect("verified fixture");
        let backend = super::DockerImageBackend::new(root.join("absent-docker.sock"));
        assert_eq!(
            backend.import_verified_before(content, Instant::now()),
            Err(ImageImportError::Load),
        );
        let mut child = Command::new("/bin/sleep")
            .arg("10")
            .spawn()
            .expect("slow child");
        let deadline = Instant::now() + Duration::from_millis(20);
        assert!(!super::wait_for_child_success(&mut child, deadline));
        assert!(child.try_wait().expect("reaped child").is_some());
        assert!(Instant::now() < deadline + Duration::from_secs(1));
        std::fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn image_import_streams_one_verified_file_and_checks_the_exact_digest() {
        let production = include_str!("epoch_coordinator.rs")
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("coordinator production section");
        let docker_backend = production
            .split_once("impl ImageBackend for DockerImageBackend")
            .expect("direct Docker backend implementation")
            .1;
        let contains_source = docker_backend
            .split_once("fn contains_digest")
            .expect("Docker presence probe")
            .1
            .split_once("fn import_verified")
            .expect("end of Docker presence probe")
            .0;
        let import_source = production
            .split_once("fn import_verified_before")
            .expect("Docker import implementation")
            .1
            .split_once("impl ImageBackend for DockerImageBackend")
            .expect("end of Docker import implementation")
            .0;
        let inspect_source = docker_backend
            .split_once("fn inspect_digest")
            .expect("Docker digest inspection")
            .1
            .split_once("/// Imports one already-authorized attempt digest")
            .expect("end of Docker digest inspection")
            .0;

        assert!(contains_source.contains("ImageImportError::Probe"));
        assert!(import_source.contains(r#".args(["image", "load"])"#));
        assert!(import_source.contains(".stdin(Stdio::from(content))"));
        assert!(import_source.contains("wait_for_child_success(&mut child, deadline)"));
        assert!(import_source.contains(".stderr(Stdio::inherit())"));
        for forbidden in [
            "--input",
            "staging_root",
            "write_private_bytes",
            "fs::read(",
        ] {
            assert!(
                !import_source.contains(forbidden),
                "import retained {forbidden}"
            );
        }
        assert!(
            inspect_source.contains(
                "self.inspect_manifest(digest, Instant::now() + MID_EPOCH_IMPORT_TIMEOUT)"
            )
        );
        assert!(inspect_source.contains("actual == digest"));
        assert!(inspect_source.contains("Err(ImageImportError::DigestMismatch)"));
        for forbidden in [
            "RepoDigests",
            "org.opencontainers.image.ref.name",
            "io.containerd.image.name",
        ] {
            assert!(!inspect_source.contains(forbidden));
            assert!(!import_source.contains(forbidden));
        }
    }

    #[test]
    fn image_metadata_command_is_bounded_and_requires_success() {
        let mut success = Command::new("/bin/sh");
        success.args(["-c", "printf manifest"]);
        assert_eq!(
            run_image_metadata_command(success, Instant::now() + Duration::from_secs(1)),
            Ok("manifest".to_string())
        );
        let mut failure = Command::new("/bin/sh");
        failure.args(["-c", "printf manifest; exit 1"]);
        assert!(
            run_image_metadata_command(failure, Instant::now() + Duration::from_secs(1)).is_err()
        );
        let mut timeout = Command::new("/bin/sh");
        timeout.args(["-c", "exec sleep 10"]);
        let started = Instant::now();
        assert!(run_image_metadata_command(timeout, started + Duration::from_millis(20)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut oversized = Command::new("/bin/sh");
        oversized.args(["-c", "head -c 8193 /dev/zero"]);
        assert!(
            run_image_metadata_command(oversized, Instant::now() + Duration::from_secs(1)).is_err()
        );
    }

    #[test]
    fn attempt_import_verifies_store_before_backend_hit_and_is_failure_isolated() {
        assert_eq!(MID_EPOCH_IMPORT_TIMEOUT, Duration::from_secs(45));
        let (store, digest, root) = admitted_store("attempt", b"attempt image");

        let mut already_present = ImportBackend {
            present: BTreeSet::from([digest.clone()]),
            ..ImportBackend::default()
        };
        assert_eq!(
            import_attempt_image(&store, &digest, &mut already_present),
            Ok(AttemptImportOutcome::AlreadyPresent)
        );
        assert!(already_present.imports.is_empty());
        let mut mismatched_present = ImportBackend {
            present: BTreeSet::from([digest.clone()]),
            inspected: BTreeMap::from([(digest.clone(), format!("sha256:{}", "0".repeat(64)))]),
            ..ImportBackend::default()
        };
        assert_eq!(
            import_attempt_image(&store, &digest, &mut mismatched_present),
            Err(ImageImportError::DigestMismatch)
        );

        let mut imported = ImportBackend::default();
        assert_eq!(
            import_attempt_image(&store, &digest, &mut imported),
            Ok(AttemptImportOutcome::Imported)
        );
        assert_eq!(
            imported.imports,
            vec![(digest.clone(), MID_EPOCH_IMPORT_TIMEOUT)]
        );

        let mut failed = ImportBackend {
            fail_import: true,
            ..ImportBackend::default()
        };
        assert_eq!(
            import_attempt_image(&store, &digest, &mut failed),
            Err(ImageImportError::Load)
        );
        let absent = format!("sha256:{}", "f".repeat(64));
        let mut backend_hit_without_store = ImportBackend {
            present: BTreeSet::from([absent.clone()]),
            ..ImportBackend::default()
        };
        assert_eq!(
            import_attempt_image(&store, &absent, &mut backend_hit_without_store),
            Err(ImageImportError::Store)
        );
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn local_image_acquire_accepts_only_one_canonical_digest_shape() {
        let digest = format!("sha256:{}", "a".repeat(64));
        assert!(is_canonical_local_digest(&digest));
        for rejected in [
            "sha256:abc".to_string(),
            format!("sha256:{}", "A".repeat(64)),
            format!("docker.io/openkit/worker@{digest}"),
            digest.trim_start_matches("sha256:").to_string(),
        ] {
            assert!(!is_canonical_local_digest(&rejected));
        }
    }

    #[test]
    fn wp3c_invalidation_export_precedes_every_fence_and_is_never_recovery_input() {
        let coordinator = include_str!("epoch_coordinator.rs")
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("coordinator production section");
        let main = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("main production section");

        let writer = main
            .find("EpochEvidenceWriter")
            .expect("fixed private evidence writer");
        let planning = main.find("EpochPlan::fresh").expect("epoch planning");
        assert!(
            writer < planning,
            "evidence writer opened after epoch creation could fail"
        );
        let mut correction_gaps = Vec::new();
        if main.matches("export_absent_disposition(").count() != 1
            || main
                .find("export_absent_disposition(")
                .is_none_or(|note| note >= planning)
        {
            correction_gaps.push("absent recovery has no pre-creation disposition caller");
        }
        if !main[..planning].contains("fence_started") {
            correction_gaps.push("fresh process discarded the prior fence timestamp");
        }
        let start_call = main
            .find("EpochCoordinator::start")
            .expect("coordinator startup caller");
        if !main[start_call..].contains("fence_started") {
            correction_gaps.push("coordinator receives no prior fence timestamp");
        }
        if coordinator.contains("let rebuild_started = Instant::now()") {
            correction_gaps
                .push("rebuild timing starts at fresh-process startup instead of the prior fence");
        }

        for forbidden_read in [
            "read_report(",
            "read_disposition(",
            "load_report(",
            "load_disposition(",
            "fs::read(",
            "fs::read_to_string(",
        ] {
            assert!(
                !main.contains(forbidden_read),
                "main reads private evidence through {forbidden_read}"
            );
            assert!(
                !coordinator.contains(forbidden_read),
                "coordinator reads private evidence through {forbidden_read}"
            );
        }

        for (fence, _) in coordinator.match_indices("terminate_children(") {
            let line_start = coordinator[..fence]
                .rfind('\n')
                .map_or(0, |index| index + 1);
            if coordinator[line_start..fence].contains("fn terminate_children") {
                continue;
            }
            let private_function = coordinator[..fence].rfind("\n    fn ");
            let public_function = coordinator[..fence].rfind("\n    pub fn ");
            let function_start = match (private_function, public_function) {
                (Some(left), Some(right)) => left.max(right),
                (Some(index), None) | (None, Some(index)) => index,
                (None, None) => panic!("fence is outside an owned function"),
            };
            let function = &coordinator[function_start..fence];
            if function.starts_with("\n    fn drop") {
                continue;
            }
            assert_eq!(
                function.matches("export_invalidation(").count(),
                1,
                "initiated invalidation must start exactly one report before its fence"
            );
        }
        let startup_fence = coordinator
            .split("pub fn start")
            .nth(1)
            .and_then(|source| source.split("pub fn create_sandbox").next())
            .expect("startup invalidation boundary");
        let running_fence = coordinator
            .split("fn fence_initiated")
            .nth(1)
            .and_then(|source| source.split("fn invalidation_trigger").next())
            .expect("running invalidation boundary");
        let startup_capture = coordinator
            .split_once("fn fence_startup_failure(")
            .and_then(|(_, source)| {
                source
                    .split("/// Invokes the actual startup failure producer")
                    .next()
            })
            .expect("startup process capture boundary");
        // Startup now enters the same fence owner, so check that call boundary
        // before applying the unchanged hard-bound checks to its sole worker.
        assert!(startup_fence.contains("fence_startup_failure("));
        assert!(!startup_fence.contains("terminate_children("));
        assert!(startup_capture.contains("MemberInventory::pin"));
        assert!(startup_capture.contains("fence_initiated("));
        assert!(!startup_capture.contains("terminate_children("));
        assert!(!startup_capture.contains("thread::spawn"));
        assert_eq!(running_fence.matches("export_invalidation(").count(), 1);
        let all_fences_bounded = [running_fence].into_iter().all(|boundary| {
            let worker = boundary.find("thread::spawn(move || {");
            let worker_body = worker.and_then(|worker| {
                boundary[worker..]
                    .split_once("})")
                    .map(|(worker_body, _)| worker_body)
            });
            matches!(
                (
                    worker,
                    worker_body.and_then(|body| body.find("record_fence_started(").or_else(|| body.find("record_fence_started_at("))),
                    worker_body.and_then(|body| body.find("export_invalidation(")),
                    boundary.find("recv_timeout(EXPORT_TIMEOUT)"),
                    boundary.find("terminate_children("),
                ),
                (Some(worker), Some(marker), Some(export), Some(hard), Some(fence))
                    if !boundary[..worker].contains("record_fence_started(")
                        && !boundary[..worker].contains("record_fence_started_at(")
                        && marker < export
                        && worker + export < hard
                        && hard < fence
                        && !boundary[hard..fence].contains("record_fence_started(")
                        && !boundary[hard..fence].contains("record_fence_started_at(")
                        && !boundary[hard..fence].contains("export_invalidation(")
                        && !boundary[hard..fence].contains(".join(")
            )
        });
        if !all_fences_bounded {
            correction_gaps
                .push("export I/O is not isolated behind the hard two-second return bound");
        }
        assert!(
            correction_gaps.is_empty(),
            "WP-3c correction gaps: {}",
            correction_gaps.join("; ")
        );
    }

    #[test]
    fn nhc_imp_5n_turn_export_preserves_the_harness_lifetime_monitor_until_sandbox_deletion() {
        let source = include_str!("epoch_coordinator.rs")
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("coordinator production section")
            .0;
        let compact = |value: &str| value.split_whitespace().collect::<Vec<_>>().join(" ");
        let export = source
            .split_once("pub fn export_file(")
            .expect("file export owner")
            .1
            .split_once("/// Waits for the monitor")
            .expect("end of file export owner")
            .0;
        let public_delete = source
            .split_once("pub fn delete_sandbox(")
            .expect("public sandbox deletion owner")
            .1
            .split_once("/// Calls the existing lifecycle owner")
            .expect("end of public sandbox deletion owner")
            .0;
        let lifecycle = source
            .split_once("pub fn execute_lifecycle_effect(")
            .expect("lifecycle effect owner")
            .1
            .split_once("pub fn acquire_image(")
            .expect("end of lifecycle effect owner")
            .0;
        let sandbox_deleted = lifecycle
            .split_once("LifecycleEffectResult::SandboxDeleted =>")
            .expect("sandbox deletion owner")
            .1
            .split_once("LifecycleEffectResult::BridgeOpened")
            .expect("end of sandbox deletion owner")
            .0;
        let bridge_closed = lifecycle
            .split_once("LifecycleEffectResult::BridgeClosed =>")
            .expect("bridge close owner")
            .1;

        let compact_export = compact(export);
        assert!(compact_export.contains(
            "if request.kind != FileEffectKind::ExportFile || (!request.artifact_submission && (!terminal_barrier_proved || !final_status)) {"
        ));
        assert!(compact_export.contains("result.exit_status == 2 && result.stdout_bytes == 0"));
        assert!(export.contains("exec_sandbox_interactive"));
        for harness_lifetime_fact in [
            "worker_terminal_barrier_proved",
            "worker_bootstrap_monitor",
            "exec_monitor",
            ".complete()",
            "monitor_exit",
            "clean_response",
        ] {
            assert!(
                !export.contains(harness_lifetime_fact),
                "per-Turn export consumed Harness-lifetime fact {harness_lifetime_fact}"
            );
        }
        let export_deletions = export.matches("self.delete_sandbox(").count();
        assert!(
            export_deletions > 0,
            "export has no definite-deletion settlement"
        );
        assert_eq!(
            export_deletions,
            export.matches("self.delete_sandbox(&sandbox.name").count(),
            "every export cleanup must use the shared public Sandbox deletion owner"
        );

        assert_eq!(
            source.matches("worker_bootstrap_monitor.take()").count(),
            1,
            "one shared deletion settlement must uniquely own the Harness monitor"
        );
        let monitor_take = source
            .find("worker_bootstrap_monitor.take()")
            .expect("shared deletion settlement must take the optional Harness monitor");
        let private_owner = source[..monitor_take].rfind("\n    fn ");
        let public_owner = source[..monitor_take].rfind("\n    pub fn ");
        let owner_start = match (private_owner, public_owner) {
            (Some(left), Some(right)) => left.max(right),
            (Some(owner), None) | (None, Some(owner)) => owner,
            (None, None) => panic!("Harness monitor settlement is outside a coordinator owner"),
        };
        let deletion_settlement = source[owner_start..]
            .split_once("\n    ///")
            .map_or(&source[owner_start..], |(owner, _)| owner);
        let deletion_owner = deletion_settlement
            .split_once("fn ")
            .and_then(|(_, signature)| signature.split_once('('))
            .map(|(name, _)| name.trim())
            .expect("shared deletion settlement function name");
        assert_ne!(
            deletion_owner, "execute_lifecycle_effect",
            "Harness settlement must remain in the shared deletion owner"
        );
        assert_ne!(deletion_owner, "delete_sandbox");
        let settlement = compact(deletion_settlement);
        assert!(
            settlement
                .contains("if let Some(exec_monitor) = self.worker_bootstrap_monitor.take() {")
        );
        assert!(settlement.contains("exec_monitor.discard_after_sandbox_deletion()"));
        for rejected_monitor_proof in ["exec_monitor.complete()", "monitor_exit", "clean_response"]
        {
            assert!(!settlement.contains(rejected_monitor_proof));
        }
        assert!(!deletion_settlement.contains("unwrap"));
        let monitor_discard = deletion_settlement
            .find("exec_monitor.discard_after_sandbox_deletion()")
            .expect("shared deletion settlement must discard the process-local monitor");
        let sandbox_clear = deletion_settlement
            .find("self.current_sandbox = None")
            .expect("shared deletion settlement must clear Sandbox state");
        assert!(
            monitor_discard < sandbox_clear,
            "shared deletion settlement released state before monitor discard"
        );

        let shared_call = format!("self.{deletion_owner}(");
        let native_delete = public_delete
            .find("self.client.delete_sandbox(")
            .expect("public deletion must first prove native Sandbox absence");
        let public_settlement = public_delete
            .find(&shared_call)
            .expect("public deletion must call the shared deletion settlement");
        assert!(native_delete < public_settlement);
        assert!(sandbox_deleted.contains(&shared_call));
        for forbidden in [
            "worker_bootstrap_monitor",
            ".complete()",
            "self.current_sandbox = None",
        ] {
            assert!(!sandbox_deleted.contains(forbidden));
            assert!(!bridge_closed.contains(forbidden));
        }
    }

    #[test]
    fn wp5_runtime_effect_vocabulary_is_closed_and_excludes_commands_proxies_and_bulk_bytes() {
        for operation in [
            "sandbox.create",
            "sandbox.delete",
            "bridge.open",
            "bridge.close",
            "image.acquire",
            "image.build",
            "file.export",
            "reference.import",
            "workspace.collect",
        ] {
            assert!(
                RuntimeEffectKind::parse(operation).is_ok(),
                "rejected {operation}"
            );
        }
        for rejected in [
            "command.run",
            "proxy.open",
            "bulk.bytes",
            "gateway.forward",
            "",
        ] {
            assert!(
                RuntimeEffectKind::parse(rejected).is_err(),
                "accepted {rejected}"
            );
        }
        let source = include_str!("epoch_coordinator.rs")
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("coordinator production section")
            .0;
        let coordinator = source
            .split_once("pub struct EpochCoordinator")
            .expect("coordinator owner")
            .1
            .split_once("impl EpochCoordinator")
            .expect("coordinator implementation")
            .0;
        assert_eq!(
            coordinator
                .matches("client: NanoHostOpenShellClient")
                .count(),
            1
        );
        assert!(
            coordinator.contains("current_sandbox: Option<SandboxRef>"),
            "current sandbox must retain both the stock object id and public name"
        );
        assert!(!source.contains("Arc<Mutex<NanoHostOpenShellClient"));
        assert!(source.contains("member_failure"));
        assert!(!source.contains("pub fn wait(&mut self)"));
        for owner in [
            "execute_lifecycle_effect",
            "RegistryAcquisition::validate",
            "BuildPlan::validate",
            "reference.import",
            "file.export",
        ] {
            assert!(
                source.contains(owner),
                "missing composed effect owner {owner}"
            );
        }
        let lifecycle = source
            .split_once("pub fn execute_lifecycle_effect(")
            .expect("lifecycle effect owner")
            .1
            .split_once("pub fn acquire_image(")
            .expect("end of lifecycle effect owner")
            .0;
        let created = lifecycle
            .split_once("LifecycleEffectResult::SandboxCreated(sandbox)")
            .expect("sandbox create result owner")
            .1
            .split_once("LifecycleEffectResult::SandboxDeleted")
            .expect("end of sandbox create result owner")
            .0;
        assert!(created.contains("current_sandbox.replace("));
        assert!(created.contains("sandbox.name"));
        assert!(
            lifecycle.contains("worker_bootstrap.sandbox_id = sandbox.id.clone()"),
            "bridge bootstrap must carry the stock sandbox object id"
        );
        assert!(
            lifecycle.contains("delete_sandbox(&sandbox.name"),
            "bridge mismatch and failure cleanup must delete by public sandbox name"
        );
        let deleted = lifecycle
            .split_once("LifecycleEffectResult::SandboxDeleted")
            .expect("sandbox delete result owner")
            .1
            .split_once("LifecycleEffectResult::BridgeOpened")
            .expect("end of sandbox delete result owner")
            .0;
        assert!(deleted.contains("request.sandbox_id()"));
        let definite_deletion = source
            .split_once("fn settle_definite_sandbox_deletion(")
            .expect("shared definite Sandbox deletion owner")
            .1
            .split_once("/// Deletes a sandbox")
            .expect("end of shared definite Sandbox deletion owner")
            .0
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(definite_deletion.contains(
            "self .current_sandbox .as_ref() .is_some_and(|sandbox| sandbox.name.as_str() == name)"
        ));
        assert!(definite_deletion.contains("if !exact_current_sandbox"));
        let build = source
            .split_once("pub fn execute_image_build(")
            .expect("attempt-local image build owner")
            .1
            .split_once("/// Imports one verified file or declared directory")
            .expect("end of image build owner")
            .0;
        let context_ref = build
            .find("&definition.context_ref")
            .expect("resolved empty-context reference carriage");
        let request_validation = build
            .find("request.validate()")
            .expect("pre-effect build-lineage validation");
        let build_root = build
            .find("let build_root")
            .expect("private build-root selection");
        let build_plan = build
            .find("BuildPlan::validate")
            .expect("bounded build-plan validation");
        assert!(context_ref < request_validation);
        assert!(request_validation < build_root);
        assert!(build_root < build_plan);
        let import = source
            .split_once("pub fn import_reference(")
            .expect("reference import owner")
            .1
            .split_once("/// Exports one regular file")
            .expect("end of reference import owner")
            .0;
        assert!(
            import
                .find("read_import_staging")
                .expect("complete import staging")
                < import
                    .find("exec_sandbox_interactive")
                    .expect("sandbox helper admission")
        );
        assert!(import.contains("sandbox_id: sandbox.name.clone()"));
        assert!(import.contains("exec_sandbox_interactive(\n                &sandbox.id"));
        let acknowledgement_success = import
            .find("Ok(result) if result.exit_status == 0 && acknowledgement == expected.as_bytes()")
            .expect("exact helper acknowledgement success");
        let acknowledgement_mismatch = import
            .find("Ok(_) =>")
            .expect("successful helper with mismatched acknowledgement");
        let acknowledgement_diagnostic = import
            .find("eprintln!(\"stage=reference-import outcome=stdout-acknowledgement\")")
            .expect("fixed value-free stdout acknowledgement mismatch");
        let helper_failure = import[acknowledgement_diagnostic..]
            .find("Err(_) =>")
            .map(|position| acknowledgement_diagnostic + position)
            .expect("classified raw helper failure");
        assert!(
            acknowledgement_success < acknowledgement_mismatch
                && acknowledgement_mismatch < acknowledgement_diagnostic
                && acknowledgement_diagnostic < helper_failure,
            "stdout acknowledgement mismatch must be classified only for a successful raw helper result"
        );
        assert_eq!(
            import
                .matches("stage=reference-import outcome=stdout-acknowledgement")
                .count(),
            1,
            "stdout acknowledgement mismatch must emit one fixed value-free category"
        );
        assert_eq!(import.matches("eprintln!(").count(), 1);
        assert!(!import.contains("std::io::stderr"));
        assert_eq!(
            import.matches("delete_sandbox(").count(),
            import.matches("delete_sandbox(&sandbox.name").count(),
            "every import failure must clean up by public sandbox name"
        );
        let export = source
            .split_once("pub fn export_file(")
            .expect("file export owner")
            .1
            .split_once("/// Waits for the monitor")
            .expect("end of file export owner")
            .0;
        assert!(export.contains("terminal_barrier_proved"));
        assert!(export.contains("stage_export(request, stage, terminal_barrier_proved)"));
        assert!(export.contains("successor"));
        assert!(export.contains("sandbox.name.as_str()"));
        assert!(export.contains("exec_sandbox_interactive(\n                &sandbox.id"));
        assert_eq!(
            export.matches("delete_sandbox(").count(),
            export.matches("delete_sandbox(&sandbox.name").count(),
            "every export failure must clean up by public sandbox name"
        );
        for bootstrap_rule in ["harness_ready", "final_status"] {
            assert!(
                source.contains(bootstrap_rule),
                "missing worker bootstrap lifecycle rule {bootstrap_rule}"
            );
        }
        assert!(!source.contains("workerControlToken"));
        assert!(!source.contains("workerInferenceToken"));
        let bridge_open = source
            .split_once("LifecycleEffectKind::OpenBridge")
            .expect("bridge-open worker bootstrap owner")
            .1;
        assert!(bridge_open.contains("exec_sandbox_interactive"));
        assert!(bridge_open.contains("open_sandbox_bridge"));
        assert!(bridge_open.contains("harness_ready"));
        let client_source = include_str!("openshell_client.rs")
            .split_once("#[cfg(test)]")
            .expect("OpenShell client production section")
            .0;
        for monitor_rule in ["monitor_exit", "clean_response"] {
            assert!(
                client_source.contains(monitor_rule),
                "OpenShell client omitted bootstrap monitor rule {monitor_rule}"
            );
        }
        let client_bridge_open = client_source
            .split_once("LifecycleEffectKind::OpenBridge => {")
            .expect("client bridge-open owner")
            .1
            .split_once("LifecycleEffectKind::CloseBridge")
            .expect("end of client bridge-open owner")
            .0;
        let retained_object_id = client_bridge_open
            .find("worker_bootstrap.sandbox_id.clone()")
            .expect("bridge-open retained sandbox object id");
        let worker_bootstrap = client_bridge_open
            .find("exec_sandbox_worker_bootstrap")
            .expect("sole worker bootstrap");
        let open_bridge = client_bridge_open
            .find("open_sandbox_bridge")
            .expect("raw bridge open");
        assert!(retained_object_id < worker_bootstrap && worker_bootstrap < open_bridge);
        assert!(client_bridge_open[open_bridge..].contains("&sandbox_id"));
        assert_eq!(
            client_source
                .matches(".exec_sandbox_worker_bootstrap(")
                .count(),
            1,
            "bridge.open must remain the sole worker bootstrap owner"
        );
    }
    #[tokio::test]
    async fn h1_r3_current_epoch_is_required_before_storage_resolution() {
        let root = std::env::temp_dir().join(format!("openkit-h1-epoch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (mut coordinator, _) = super::EpochCoordinator::collection_fixture(&root);
        let command = crate::workspace_collect::validate_collect_command(&serde_json::to_vec(&serde_json::json!({
            "requestId": "ab".repeat(32), "mode": "baseline", "storageRef": "storage-one",
            "scopeDigest": format!("sha256:{}", "b".repeat(64)), "attachmentGeneration": 1,
            "sandboxId": "sandbox-one", "workSlot": "slotA", "collectionId": "baseline",
            "acceptedBase": null, "previousHead": null,
            "checkValues": {"runtimeEnv": [], "loopbackDigests": ["c".repeat(64), "d".repeat(64)]}
        })).unwrap()).unwrap();
        coordinator.collection_test_sandbox = Some("other-epoch-sandbox".into());
        assert!(coordinator.resolve_collection(&command).is_err());
        assert!(!coordinator.collection_scan_root.exists());
        coordinator.collection_test_sandbox = None;
        assert!(coordinator.resolve_collection(&command).is_err());
        coordinator.collection_test_sandbox = Some("sandbox-one".into());
        assert!(coordinator.resolve_collection(&command).is_ok());
        drop(coordinator);
        std::fs::remove_dir_all(root).unwrap();
    }
}
