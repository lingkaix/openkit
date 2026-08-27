//! Closed Docker Runtime Epoch process coordination.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Ipv4Addr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use openshell_sdk::raw::proto::SandboxPolicy;
use openshell_sdk::{ListOptions, SandboxRef, SandboxSpec};
use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio::time::{sleep, timeout};

use crate::epoch_evidence::{
    EXPORT_TIMEOUT, EpochEvidenceWriter, EpochInvalidationTrigger, clear_fence_started,
    measure_fence_to_ready, record_fence_started,
};
use crate::image_acquisition::{
    AcquisitionTrigger, BuildDefinition, BuildPlan, EMPTY_BUILD_CONTEXT_DIGEST,
    EMPTY_BUILD_CONTEXT_REF, ImageEffectEvidence, ImageEffectRequest, RegistryAcquisition,
};
use crate::image_store::{ImageStore, StoreError};
use crate::nanocore_session::OuterRouteProjection;
use crate::openshell_client::{
    LifecycleEffectKind, LifecycleEffectRequest, LifecycleEffectResult, NanoHostOpenShellClient,
    WorkerBootstrapMonitor, WorkerBootstrapRequest,
};
use crate::sandbox_bridge::{
    EffectCarriage, FILE_EFFECT_CHUNK_BYTES, FileEffectKind, FileEffectPresence, FileEffectRequest,
    OpenSandboxBridge, RetainedExportResult, read_import_staging, stage_export,
};

/// systemd slice containing NanoHost and every Runtime Epoch member.
pub const OPENKIT_NANOHOST_SLICE: &str = "openkit-nanohost.slice";

/// Fixed loopback port for the closed V1 epoch-local Gateway.
const GATEWAY_PORT: &str = "17670";

#[cfg(target_arch = "x86_64")]
const SUPERVISOR_IMAGE: &str = "ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9";

#[cfg(target_arch = "aarch64")]
const SUPERVISOR_IMAGE: &str = "ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38";

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("NanoHost supports only linux/amd64 and linux/arm64 Supervisor images");

/// Maximum time allowed for each dependency readiness proof.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Calls Linux `setns`, or fails closed on unsupported build hosts.
unsafe fn setns(fd: i32) -> i32 {
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

/// Calls Linux `unshare`, or fails closed on unsupported build hosts.
unsafe fn unshare() -> i32 {
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

/// Monotonic in-process discriminator for plans created in the same instant.
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(0);

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
    epoch_root: PathBuf,
    run_root: PathBuf,
    containerd_socket: PathBuf,
    docker_socket: PathBuf,
    gateway_auth_path: PathBuf,
    gateway_config_path: PathBuf,
    gateway_config_contents: String,
    gateway_program: PathBuf,
    members: Vec<EpochMemberSpec>,
}

impl EpochPlan {
    /// Builds a unique epoch-private plan beneath the supplied state and run roots.
    ///
    /// # Errors
    ///
    /// Returns an error if the system clock cannot produce a fresh epoch name.
    pub fn fresh(
        state_root: &Path,
        run_root: &Path,
        gateway: &Path,
        nameservers: &[Ipv4Addr],
    ) -> io::Result<Self> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let sequence = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed);
        let epoch_name = format!("epoch-{}-{timestamp}-{sequence}", std::process::id());
        let epoch_root = state_root.join(&epoch_name);
        let run_root = run_root.join(&epoch_name);
        let containerd_socket = run_root.join("containerd.sock");
        let docker_socket = run_root.join("docker.sock");
        let gateway_auth_path = epoch_root.join("gateway-auth");
        let gateway_config_path = epoch_root.join("gateway.toml");
        let gateway_database_path = epoch_root.join("gateway.db");
        let gateway_program = gateway.to_path_buf();
        let gateway_config_contents = gateway_config(&docker_socket, &gateway_auth_path);
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
            epoch_root,
            run_root,
            containerd_socket,
            docker_socket,
            gateway_auth_path,
            gateway_config_path,
            gateway_config_contents,
            gateway_program,
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

    /// Returns the exact pinned Gateway TOML projection.
    pub fn gateway_config_contents(&self) -> &str {
        &self.gateway_config_contents
    }

    /// Returns the epoch-local pinned Gateway endpoint.
    pub fn gateway_endpoint(&self) -> String {
        format!("https://127.0.0.1:{GATEWAY_PORT}")
    }

    /// Returns the four members in dependency start order.
    pub fn members(&self) -> &[EpochMemberSpec] {
        &self.members
    }
}

/// Failure classes that invalidate the entire Runtime Epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum EpochFault {
    /// At least one member failed during dependency-ordered startup.
    PartialStart,
    /// A running epoch member exited.
    MemberExited,
    /// Observed runtime identity does not match the active epoch.
    IdentityMismatch,
    /// Sandbox creation outcome cannot be proved.
    CreateOutcomeUncertain,
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
    pub fn action(self) -> EpochAction {
        EpochAction::TerminateProcess
    }
}

/// Returns whether capacity may be advertised after the required image proof.
#[cfg_attr(not(test), allow(dead_code))]
pub fn capacity_ready(image_import_proved: bool) -> bool {
    image_import_proved
}

/// Preflights cleanup against the exact retained Sandbox state.
///
/// A fresh-empty epoch can prove an old bridge and Sandbox already absent without
/// calling OpenShell. Live cleanup still proceeds through the ordinary owner,
/// while mismatched, partial, reordered, or auxiliary-bearing input fails closed.
fn definite_absence_lifecycle_result(
    request: &LifecycleEffectRequest,
    current_sandbox_name: Option<&str>,
    bridge_present: bool,
    monitor_present: bool,
    auxiliary_input_present: bool,
) -> Result<Option<&'static str>, EpochFault> {
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

/// Hard bound for one required or mid-epoch image import.
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
    /// Local import staging failed before the Docker subprocess.
    Backend,
    /// The exact-image presence probe could not execute.
    Probe,
    /// The bounded stock Docker image load failed.
    Load,
    /// The exact post-load Docker inspection failed.
    Inspect,
    /// Post-import inspection did not return the exact requested digest.
    DigestMismatch,
    /// A mid-epoch request attempted to install a deployment digest.
    DeploymentDigest,
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
        content: &[u8],
        timeout: Duration,
    ) -> Result<(), ImageImportError>;

    /// Returns the backend's exact installed image digest.
    fn inspect_digest(&mut self, digest: &str) -> Result<String, ImageImportError>;
}

/// Direct Docker CLI projection bound to the epoch-private socket.
pub struct DockerImageBackend {
    docker_socket: PathBuf,
    staging_root: PathBuf,
}

impl DockerImageBackend {
    /// Creates one direct backend projection with private staging.
    pub fn new(docker_socket: PathBuf, staging_root: PathBuf) -> Self {
        Self {
            docker_socket,
            staging_root,
        }
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
        digest: &str,
        content: &[u8],
        import_timeout: Duration,
    ) -> Result<(), ImageImportError> {
        create_private_dir(&self.staging_root).map_err(|_| ImageImportError::Backend)?;
        let stem = digest
            .strip_prefix("sha256:")
            .filter(|stem| stem.len() == 64)
            .ok_or(ImageImportError::DigestMismatch)?;
        let archive = self.staging_root.join(format!("{stem}.oci.tar"));
        write_private_bytes(&archive, content).map_err(|_| ImageImportError::Backend)?;
        let child = self
            .command()
            .args(["image", "load", "--input", &path_arg(&archive)])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn();
        let result = child
            .map_err(|_| ImageImportError::Load)
            .and_then(|mut child| {
                if wait_for_child_success(&mut child, import_timeout) {
                    Ok(())
                } else {
                    Err(ImageImportError::Load)
                }
            });
        let _ = fs::remove_file(archive);
        let _ = fs::remove_dir(&self.staging_root);
        result
    }

    /// Re-verifies the installed content digest through the private daemon.
    fn inspect_digest(&mut self, digest: &str) -> Result<String, ImageImportError> {
        let mut command = self.command();
        let output = command
            .args(["image", "inspect", "--format", "{{.Id}}", digest])
            .stdin(Stdio::null())
            .stderr(Stdio::inherit())
            .output()
            .map_err(|_| ImageImportError::Inspect)?;
        if !output.status.success() {
            return Err(ImageImportError::Inspect);
        }
        let output = String::from_utf8(output.stdout).map_err(|_| ImageImportError::Inspect)?;
        if output.trim() == digest {
            Ok(digest.to_string())
        } else {
            Err(ImageImportError::DigestMismatch)
        }
    }
}

/// Imports every non-empty required deployment digest from the store only.
pub fn import_required_images<B: ImageBackend>(
    store: &mut ImageStore,
    required: &BTreeSet<String>,
    backend: &mut B,
) -> bool {
    if required.is_empty() {
        return false;
    }
    for digest in required {
        let content = match store.read_verified(digest) {
            Ok(content) => content,
            Err(_) => return false,
        };
        if backend
            .import_verified(digest, &content, MID_EPOCH_IMPORT_TIMEOUT)
            .is_err()
            || backend.inspect_digest(digest).as_deref() != Ok(digest.as_str())
        {
            return false;
        }
        let imported_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs());
        if store.mark_imported(digest, imported_at).is_err() {
            return false;
        }
    }
    true
}

/// Imports one already-authorized attempt digest without changing epoch identity.
///
/// # Errors
///
/// Returns an attempt-local failure for deployment digests, store failure,
/// backend failure, timeout, or post-import mismatch.
#[cfg_attr(not(test), allow(dead_code))]
pub fn import_attempt_image<B: ImageBackend>(
    store: &mut ImageStore,
    digest: &str,
    required: &BTreeSet<String>,
    backend: &mut B,
) -> Result<AttemptImportOutcome, ImageImportError> {
    if required.contains(digest) {
        return Err(ImageImportError::DeploymentDigest);
    }
    if backend.contains_digest(digest)? {
        return Ok(AttemptImportOutcome::AlreadyPresent);
    }
    let content = store.read_verified(digest)?;
    backend.import_verified(digest, &content, MID_EPOCH_IMPORT_TIMEOUT)?;
    if backend.inspect_digest(digest)? != digest {
        return Err(ImageImportError::DigestMismatch);
    }
    let imported_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    store.mark_imported(digest, imported_at)?;
    Ok(AttemptImportOutcome::Imported)
}

/// Owns all child processes in one fresh Runtime Epoch.
#[allow(dead_code)]
pub struct EpochCoordinator {
    monitor: EpochMemberMonitor,
    runtime: Handle,
    client: NanoHostOpenShellClient,
    image_store: ImageStore,
    image_backend: DockerImageBackend,
    required_images: BTreeSet<String>,
    run_root: PathBuf,
    bridge: Option<OpenSandboxBridge>,
    route_projection: OuterRouteProjection,
    current_sandbox: Option<SandboxRef>,
    worker_bootstrap_monitor: Option<WorkerBootstrapMonitor>,
}

/// Sole owner of Runtime Epoch member handles and whole-group fencing.
struct EpochMemberMonitor {
    fence: mpsc::SyncSender<Option<EpochFault>>,
    member_failure: mpsc::Receiver<EpochFault>,
    worker: Option<JoinHandle<()>>,
}

/// Child-handle aggregate whose normal drop always kills and reaps the group.
struct OwnedEpochChildren {
    children: Vec<Child>,
    namespace_descriptor: Option<Arc<OwnedFd>>,
}

impl Drop for OwnedEpochChildren {
    /// Performs normal fail-stop teardown without creating invalidation evidence.
    fn drop(&mut self) {
        terminate_children(&mut self.children);
        self.namespace_descriptor.take();
    }
}

impl EpochMemberMonitor {
    /// Starts the one monitor that owns every member handle during long effects.
    #[allow(dead_code)]
    fn start(children: Vec<Child>, evidence: EpochEvidenceWriter) -> Self {
        Self::start_with_namespace(children, None, evidence)
    }

    /// Starts the monitor while retaining the proved private namespace descriptor.
    fn start_with_namespace(
        children: Vec<Child>,
        namespace_descriptor: Option<Arc<OwnedFd>>,
        mut evidence: EpochEvidenceWriter,
    ) -> Self {
        let (fence, fence_rx) = mpsc::sync_channel(1);
        let (failure_tx, member_failure) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let mut children = OwnedEpochChildren {
                children,
                namespace_descriptor,
            };
            loop {
                let observed = children
                    .children
                    .iter_mut()
                    .any(|child| !matches!(child.try_wait(), Ok(None)));
                if observed {
                    fence_initiated(
                        &mut evidence,
                        &mut children.children,
                        EpochFault::MemberExited,
                    );
                    let _ = failure_tx.send(EpochFault::MemberExited);
                    return;
                }
                match fence_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(Some(fault)) => {
                        fence_initiated(&mut evidence, &mut children.children, fault);
                        let _ = failure_tx.send(fault);
                        return;
                    }
                    Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        });
        Self {
            fence,
            member_failure,
            worker: Some(worker),
        }
    }

    /// Waits asynchronously for the monitor's one terminal member-failure event.
    async fn member_failure(&self) -> EpochFault {
        loop {
            match self.member_failure.try_recv() {
                Ok(fault) => return fault,
                Err(mpsc::TryRecvError::Disconnected) => return EpochFault::MemberExited,
                Err(mpsc::TryRecvError::Empty) => sleep(Duration::from_millis(50)).await,
            }
        }
    }

    /// Requests one export-before-fence and waits for complete sibling reap.
    fn fence(&mut self, fault: EpochFault) {
        let _ = self.fence.send(Some(fault));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for EpochMemberMonitor {
    /// Performs normal whole-group termination exactly once.
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.fence.send(None);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl EpochCoordinator {
    /// Creates restrictive fresh directories and starts every member in order.
    ///
    /// # Errors
    ///
    /// Returns [`EpochFault::PartialStart`] after stopping every child already
    /// started when setup, member start, or required-image import fails.
    pub fn start(
        plan: &EpochPlan,
        mut client: NanoHostOpenShellClient,
        evidence: EpochEvidenceWriter,
        fence_started: Option<SystemTime>,
        image_store: &mut Option<ImageStore>,
        required_images: &BTreeSet<String>,
        image_backend: &mut Option<DockerImageBackend>,
    ) -> Result<Self, EpochFault> {
        let mut image_store = image_store.take().ok_or(EpochFault::PartialStart)?;
        let mut image_backend = image_backend.take().ok_or(EpochFault::PartialStart)?;
        let mut children = Vec::with_capacity(plan.members().len());
        let runtime = {
            let export_before_fence = |fault| {
                let mut writer = evidence.clone();
                let (completed_tx, completed_rx) = mpsc::sync_channel(1);
                let fence_started = SystemTime::now();
                let worker = catch_unwind(AssertUnwindSafe(|| {
                    thread::spawn(move || {
                        let started = Instant::now();
                        let _ = record_fence_started(fence_started);
                        let _ = writer.export_invalidation(
                            invalidation_trigger(fault),
                            &[("fence", "initiated")],
                            started,
                        );
                        let _ = completed_tx.send(());
                    })
                }));
                if let Ok(_worker) = worker {
                    let _ = completed_rx.recv_timeout(EXPORT_TIMEOUT);
                }
            };
            if create_private_dir(plan.epoch_root()).is_err() {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }
            if create_private_dir(plan.run_root()).is_err() {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }
            if !generate_gateway_auth(plan)
                || write_private_file(&plan.gateway_config_path, plan.gateway_config_contents())
                    .is_err()
            {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }

            let runtime = Handle::current();

            if spawn_member(&mut children, &plan.members()[0], None).is_err() {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }
            let namespace_descriptor = match children
                .last_mut()
                .ok_or(EpochFault::PartialStart)
                .and_then(|child| {
                    retain_private_namespace(child).map_err(|_| EpochFault::PartialStart)
                }) {
                Ok(descriptor) => descriptor,
                Err(fault) => {
                    export_before_fence(fault);
                    terminate_children(&mut children);
                    return Err(fault);
                }
            };
            let containerd_ready = children
                .last_mut()
                .is_some_and(|child| wait_for_socket(child, plan.containerd_socket()));
            if !containerd_ready {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }

            let slirp_ready = match spawn_member(
                &mut children,
                &plan.members()[1],
                Some(&namespace_descriptor),
            ) {
                Ok(Some(ready_reader)) => children.last_mut().is_some_and(|child| {
                    wait_for_slirp_ready(child, ready_reader, Arc::clone(&namespace_descriptor))
                }),
                Ok(None) | Err(_) => false,
            };
            if !slirp_ready {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }

            if spawn_member(
                &mut children,
                &plan.members()[2],
                Some(&namespace_descriptor),
            )
            .is_err()
            {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }
            let dockerd_ready = children.last_mut().is_some_and(|child| {
                wait_for_member_namespace(child, &namespace_descriptor)
                    && wait_for_socket(child, plan.docker_socket())
            });
            if !dockerd_ready {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }

            if !import_required_images(&mut image_store, required_images, &mut image_backend) {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }

            if spawn_member(
                &mut children,
                &plan.members()[3],
                Some(&namespace_descriptor),
            )
            .is_err()
                || !children
                    .last_mut()
                    .is_some_and(|child| wait_for_member_namespace(child, &namespace_descriptor))
            {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }
            if client
                .bind_network_namespace(Arc::clone(&namespace_descriptor))
                .is_err()
            {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
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
                                Err(EpochFault::PartialStart | EpochFault::MemberExited) => {
                                    sleep(Duration::from_millis(50)).await;
                                }
                                Err(fault) => break Err(fault),
                            }
                        }
                    })
                    .await
                })
            });
            let gateway_running = children
                .last_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
            if !matches!(health, Ok(Ok(()))) || !gateway_running {
                let fault = match health {
                    Ok(Err(fault)) => fault,
                    Err(_) | Ok(Ok(())) => EpochFault::PartialStart,
                };
                export_before_fence(fault);
                terminate_children(&mut children);
                return Err(fault);
            }
            let rebuild_ready = fence_started.is_none_or(|fence_started| {
                SystemTime::now()
                    .duration_since(fence_started)
                    .is_ok_and(|elapsed| measure_fence_to_ready(elapsed, true).ready)
            });
            if !rebuild_ready || (fence_started.is_some() && clear_fence_started().is_err()) {
                export_before_fence(EpochFault::PartialStart);
                terminate_children(&mut children);
                return Err(EpochFault::PartialStart);
            }
            (runtime, namespace_descriptor)
        };

        let (runtime, namespace_descriptor) = runtime;

        Ok(Self {
            monitor: EpochMemberMonitor::start_with_namespace(
                children,
                Some(namespace_descriptor),
                evidence,
            ),
            runtime,
            client,
            image_store,
            image_backend,
            required_images: required_images.clone(),
            run_root: plan.run_root().to_path_buf(),
            bridge: None,
            route_projection: OuterRouteProjection::new(),
            current_sandbox: None,
            worker_bootstrap_monitor: None,
        })
    }

    /// Returns the epoch-retained outer route projection for successor rebinding.
    pub fn outer_route_projection(&self) -> OuterRouteProjection {
        self.route_projection.clone()
    }

    /// Returns the exact current ready Sandbox name for static bridge composition.
    pub fn current_sandbox_name(&self) -> Result<&str, EpochFault> {
        self.current_sandbox
            .as_ref()
            .map(|sandbox| sandbox.name.as_str())
            .ok_or(EpochFault::IdentityMismatch)
    }

    /// Returns whether the accepted Harness bridge and its lifetime monitor remain live.
    pub fn has_live_bridge(&self) -> bool {
        self.bridge.is_some() && self.worker_bootstrap_monitor.is_some()
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
    ) -> Result<SandboxRef, EpochFault> {
        let result = tokio::task::block_in_place(|| {
            self.runtime
                .block_on(self.client.create_sandbox(spec, policy))
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
            (Some(spec), Some(policy)) => Some((spec, policy)),
            (None, None) => None,
            _ => return Err(EpochFault::IdentityMismatch),
        };
        if let Some(result) = definite_absence_lifecycle_result(
            request,
            self.current_sandbox
                .as_ref()
                .map(|sandbox| sandbox.name.as_str()),
            self.bridge.is_some(),
            self.worker_bootstrap_monitor.is_some(),
            create.is_some() || worker_bootstrap.is_some(),
        )? {
            return Ok(result.to_string());
        }
        // OpenBridge orders fixed Start before `open_sandbox_bridge` and retains
        // the live Harness monitor.
        let bridge = if request.kind() == LifecycleEffectKind::CloseBridge {
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
        let result = self.settle(result)?;
        match result {
            LifecycleEffectResult::SandboxCreated(sandbox) => {
                if self.current_sandbox.replace(sandbox.clone()).is_some() {
                    return self.settle(Err(EpochFault::IdentityMismatch));
                }
                Ok(sandbox.name)
            }
            LifecycleEffectResult::SandboxDeleted => {
                self.settle_definite_sandbox_deletion(request.sandbox_id())?;
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
                let harness_ready = self
                    .bridge
                    .as_ref()
                    .is_some_and(OpenSandboxBridge::harness_ready);
                if !harness_ready {
                    return self.settle(Err(EpochFault::MemberExited));
                }
                Ok("open".to_string())
            }
            LifecycleEffectResult::BridgeClosed => Ok("closed".to_string()),
        }
    }

    /// Acquires, stores, and imports one exact fixed-registry attempt image.
    ///
    /// # Errors
    ///
    /// Returns an attempt-local failure without widening the fixed registry set
    /// or treating validation as successful acquisition evidence.
    pub fn acquire_image(
        &mut self,
        request_id: &str,
        reference: &str,
    ) -> Result<ImageEffectEvidence, &'static str> {
        let request = ImageEffectRequest::reference(request_id, reference);
        request.validate().map_err(|_| "image.acquire rejected")?;
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
        let acquired_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "image.acquire clock unavailable")?
            .as_secs();
        let digest = tokio::task::block_in_place(|| {
            self.runtime.block_on(acquisition.acquire(
                &staging,
                &mut self.image_store,
                &self.required_images,
                acquired_at,
            ))
        })
        .map_err(|_| "image.acquire failed")?;
        import_attempt_image(
            &mut self.image_store,
            &digest,
            &self.required_images,
            &mut self.image_backend,
        )
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
            .execute_and_admit(&mut self.image_store, &self.required_images, acquired_at)
            .map_err(|_| "image.build failed")?;
        import_attempt_image(
            &mut self.image_store,
            &digest,
            &self.required_images,
            &mut self.image_backend,
        )
        .map_err(|_| "image.build import failed")?;
        let evidence = ImageEffectEvidence::new(request_id, &digest);
        evidence
            .validate_result_identity(request_id)
            .map_err(|_| "image.build result rejected")?;
        Ok(evidence)
    }

    /// Imports one private staged regular file into the current ready sandbox.
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
        sha256: &str,
        byte_length: u64,
        file_data: &[u8],
    ) -> Result<EffectCarriage, &'static str> {
        let sandbox = self
            .current_sandbox
            .clone()
            .ok_or("reference.import current sandbox unavailable")?;
        let request = FileEffectRequest {
            request_id: request_id.to_string(),
            sandbox_id: sandbox.name.clone(),
            slot: slot.to_string(),
            relative_path: relative_path.to_path_buf(),
            sha256: sha256.to_string(),
            byte_length,
            kind: FileEffectKind::ImportReference,
            presence: FileEffectPresence::Required,
        };
        request
            .validate()
            .map_err(|_| "reference.import request rejected")?;
        let staging_root = self.run_root.join("file-import");
        let source = staging_root.join(format!(
            "{:x}",
            Sha256::digest(request.request_id.as_bytes())
        ));
        let temporary = staging_root.join(format!(
            ".{:x}.partial",
            Sha256::digest(request.request_id.as_bytes())
        ));
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&source);
        let staged = (|| {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&staging_root)
                .map_err(|_| "reference.import staging unavailable")?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|_| "reference.import staging unavailable")?;
            for chunk in file_data.chunks(FILE_EFFECT_CHUNK_BYTES) {
                file.write_all(chunk)
                    .map_err(|_| "reference.import staging unavailable")?;
            }
            file.sync_all()
                .map_err(|_| "reference.import staging unavailable")?;
            fs::rename(&temporary, &source).map_err(|_| "reference.import staging unavailable")?;
            OpenOptions::new()
                .read(true)
                .open(&staging_root)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "reference.import staging unavailable")
        })();
        if staged.is_err() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&source);
            let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
            return Err("reference.import failed or unknown");
        }
        let bytes = match read_import_staging(&source, &request) {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = fs::remove_file(&temporary);
                let _ = fs::remove_file(&source);
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                return Err("reference.import failed or unknown");
            }
        };
        let command = match request.helper_command() {
            Ok(command) => command,
            Err(_) => {
                let _ = fs::remove_file(&source);
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                return Err("reference.import failed or unknown");
            }
        };
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(self.client.exec_sandbox_interactive(
                &sandbox.id,
                &command,
                &bytes,
            ))
        });
        let expected = format!("{} {}\n", request.sha256, request.byte_length);
        match result {
            Ok(result) if result.exit_status == 0 && result.stdout == expected.as_bytes() => {
                let _ = fs::remove_file(&source);
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
                let _ = fs::remove_file(&source);
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                Err("reference.import failed or unknown")
            }
            Err(_) => {
                let _ = fs::remove_file(&source);
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                Err("reference.import failed or unknown")
            }
        }
    }

    /// Exports one regular file after the owning terminal/process-group barrier.
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
        process_group_absent: bool,
    ) -> Result<Option<RetainedExportResult>, &'static str> {
        let sandbox = self
            .current_sandbox
            .clone()
            .ok_or("file.export current sandbox unavailable")?;
        if request.kind != FileEffectKind::ExportFile
            || !terminal_barrier_proved
            || !final_status
            || !process_group_absent
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
        let result = tokio::task::block_in_place(|| {
            self.runtime.block_on(self.client.exec_sandbox_interactive(
                &sandbox.id,
                &command,
                // The export helper reads the sandbox path and receives no input bytes.
                &[],
            ))
        });
        let staging_root = self.run_root.join("file-export");
        match result {
            Ok(result) if result.exit_status == 0 => {
                let retained_export_result = stage_export(
                    &staging_root,
                    request,
                    result.stdout,
                    terminal_barrier_proved,
                );
                if retained_export_result.is_err() {
                    let _ = fs::remove_file(staging_root.join(&request.request_id));
                    let _ = fs::remove_file(
                        staging_root.join(format!(".{}.partial", request.request_id)),
                    );
                    let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                }
                // The caller retains this exact complete result for successor-only resend.
                retained_export_result.map(Some)
            }
            Ok(result)
                if result.exit_status == 2
                    && result.stdout.is_empty()
                    && request.presence == FileEffectPresence::Optional =>
            {
                Ok(None)
            }
            Ok(_) | Err(_) => {
                let _ = fs::remove_file(staging_root.join(&request.request_id));
                let _ =
                    fs::remove_file(staging_root.join(format!(".{}.partial", request.request_id)));
                let _ = self.delete_sandbox(&sandbox.name, Duration::from_secs(120));
                Err("file.export failed or unknown")
            }
        }
    }

    /// Waits for the monitor's terminal member event while effects remain callable.
    pub async fn member_failure(&self) -> EpochFault {
        self.monitor.member_failure().await
    }

    /// Waits for the monitor's terminal member event without owning child handles.
    pub async fn wait(&self) -> EpochFault {
        self.member_failure().await
    }

    /// Settles a typed lifecycle result or terminates the invalid epoch.
    #[allow(dead_code)]
    fn settle<T>(&mut self, result: Result<T, EpochFault>) -> Result<T, EpochFault> {
        if let Err(fault) = result {
            match fault {
                EpochFault::IdentityMismatch
                | EpochFault::CreateOutcomeUncertain
                | EpochFault::DeleteOutcomeUncertain
                | EpochFault::PartialStart
                | EpochFault::MemberExited => {
                    self.monitor.fence(fault);
                }
            }
            return Err(fault);
        }
        result
    }
}

/// Starts exactly one bounded invalidation export before fencing owned children.
fn fence_initiated(evidence: &mut EpochEvidenceWriter, children: &mut [Child], fault: EpochFault) {
    let mut writer = evidence.clone();
    let (completed_tx, completed_rx) = mpsc::sync_channel(1);
    let fence_started = SystemTime::now();
    let worker = catch_unwind(AssertUnwindSafe(|| {
        thread::spawn(move || {
            let started = Instant::now();
            let _ = record_fence_started(fence_started);
            let _ = writer.export_invalidation(
                invalidation_trigger(fault),
                &[("fence", "initiated")],
                started,
            );
            let _ = completed_tx.send(());
        })
    }));
    if let Ok(_worker) = worker {
        let _ = completed_rx.recv_timeout(EXPORT_TIMEOUT);
    }
    terminate_children(children);
}

/// Maps one existing epoch fault to its accepted invalidation classification.
fn invalidation_trigger(fault: EpochFault) -> EpochInvalidationTrigger {
    match fault {
        EpochFault::PartialStart => EpochInvalidationTrigger::EpochCreationFailure,
        EpochFault::MemberExited => EpochInvalidationTrigger::MemberExit,
        EpochFault::IdentityMismatch => EpochInvalidationTrigger::MemberIdentityChange,
        EpochFault::CreateOutcomeUncertain => EpochInvalidationTrigger::UncertainCreate,
        EpochFault::DeleteOutcomeUncertain => EpochInvalidationTrigger::UncertainDelete,
    }
}

/// Converts a path to a direct argument without shell interpretation.
fn path_arg(path: &Path) -> String {
    path.as_os_str().to_string_lossy().into_owned()
}

/// Renders the exact pinned Gateway configuration for one private epoch.
fn gateway_config(docker_socket: &Path, auth_path: &Path) -> String {
    format!(
        "[openshell]\nversion = 1\n\n[openshell.gateway.tls]\ncert_path = \"{auth}/server/tls.crt\"\nkey_path = \"{auth}/server/tls.key\"\nclient_ca_path = \"{auth}/ca.crt\"\nrequire_client_auth = true\n\n[openshell.gateway.mtls_auth]\nenabled = true\n\n[openshell.gateway.gateway_jwt]\nsigning_key_path = \"{auth}/jwt/signing.pem\"\npublic_key_path = \"{auth}/jwt/public.pem\"\nkid_path = \"{auth}/jwt/kid\"\ngateway_id = \"openkit-nanohost\"\nttl_secs = 3600\n\n[openshell.drivers.docker]\nsocket_path = \"{}\"\nsupervisor_image = \"{SUPERVISOR_IMAGE}\"\n",
        docker_socket.display(),
        auth = auth_path.display(),
    )
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

/// Writes one new binary staging file with mode `0600`.
fn write_private_bytes(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()
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
    namespace_descriptor: Option<&Arc<OwnedFd>>,
) -> io::Result<Option<UnixStream>> {
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
            // SAFETY: `unshare` is async-signal-safe and this closure runs after
            // fork, before exec, without touching shared Rust state.
            unsafe {
                command.pre_exec(|| {
                    if unshare() == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
            }
        }
        EpochNetworkNamespaceMode::JoinPrivate => {
            let namespace_fd = namespace_descriptor
                .ok_or_else(|| io::Error::other("private namespace descriptor missing"))?
                .as_raw_fd();
            // SAFETY: `setns` is async-signal-safe and receives the retained
            // namespace descriptor, which remains open through spawn.
            unsafe {
                command.pre_exec(move || {
                    if setns(namespace_fd) == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
            }
        }
        EpochNetworkNamespaceMode::Host if member.role() == EpochProcessRole::Slirp4netns => {
            let namespace_fd = namespace_descriptor
                .ok_or_else(|| io::Error::other("private namespace descriptor missing"))?
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
    Ok(ready_reader)
}

/// Returns one namespace object's stable device and inode identity.
fn namespace_identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

/// Opens and proves the fresh namespace created by the containerd child.
fn retain_private_namespace(child: &mut Child) -> io::Result<Arc<OwnedFd>> {
    let host_identity = namespace_identity(Path::new("/proc/self/ns/net"))?;
    let namespace_path = PathBuf::from(format!("/proc/{}/ns/net", child.id()));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return Err(io::Error::other("containerd exited before namespace proof"));
        }
        if let Ok(file) = File::open(&namespace_path)
            && let Ok(metadata) = file.metadata()
            && (metadata.dev(), metadata.ino()) != host_identity
            && namespace_identity(&namespace_path).ok() == Some((metadata.dev(), metadata.ino()))
        {
            return Ok(Arc::new(OwnedFd::from(file)));
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(io::Error::other("private namespace proof timed out"))
}

/// Proves one child is running in the retained namespace.
fn wait_for_member_namespace(child: &mut Child, namespace_descriptor: &OwnedFd) -> bool {
    let expected = namespace_identity(Path::new(&format!(
        "/proc/self/fd/{}",
        namespace_descriptor.as_raw_fd()
    )))
    .ok();
    let member_path = PathBuf::from(format!("/proc/{}/ns/net", child.id()));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return false;
        }
        if expected.is_some() && namespace_identity(&member_path).ok() == expected {
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
        if unsafe { setns(namespace_descriptor.as_raw_fd()) } != 0 {
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

/// Waits a caller-bounded interval for a direct child to succeed.
fn wait_for_child_success(child: &mut Child, limit: Duration) -> bool {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
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
    use std::collections::{BTreeMap, BTreeSet};
    #[cfg(target_os = "linux")]
    use std::fs::File;
    #[cfg(target_os = "linux")]
    use std::io::Read;
    #[cfg(target_os = "linux")]
    use std::os::fd::OwnedFd;
    use std::path::Path;
    use std::process::Command;
    #[cfg(target_os = "linux")]
    use std::sync::Arc;
    use std::time::Duration;

    use super::{
        AttemptImportOutcome, EpochAction, EpochEvidenceWriter, EpochFault, EpochMemberMonitor,
        EpochNetworkNamespaceMode, EpochPlan, EpochProcessRole, ImageBackend, ImageImportError,
        MID_EPOCH_IMPORT_TIMEOUT, OPENKIT_NANOHOST_SLICE, RuntimeEffectKind, SUPERVISOR_IMAGE,
        capacity_ready, definite_absence_lifecycle_result, dockerd_dns_arguments,
        gateway_cert_command, has_up_tap0_default_route, import_attempt_image,
        import_required_images, resolve_epoch_nameservers, wait_for_success,
    };
    #[cfg(target_os = "linux")]
    use super::{EpochMemberSpec, spawn_member, wait_for_child_success};
    use crate::image_store::{ImageStore, StoreLineage};
    use crate::openshell_client::{LifecycleEffectKind, LifecycleEffectRequest};

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
            .split_once("#[cfg(test)]")
            .expect("epoch coordinator production section")
            .0;
        let setns_wrapper = production
            .split_once("unsafe fn setns(fd: i32) -> i32 {")
            .expect("setns wrapper")
            .1
            .split_once("/// Calls Linux `unshare`")
            .expect("end of setns wrapper")
            .0;
        assert_eq!(
            setns_wrapper
                .matches("libc::setns(fd, libc::CLONE_NEWNET)")
                .count(),
            1
        );
        assert_eq!(setns_wrapper.matches("\n        -1\n").count(), 1);
        let unshare_wrapper = production
            .split_once("unsafe fn unshare() -> i32 {")
            .expect("unshare wrapper")
            .1
            .split_once("/// Monotonic in-process discriminator")
            .expect("end of unshare wrapper")
            .0;
        assert_eq!(
            unshare_wrapper
                .matches("libc::unshare(libc::CLONE_NEWNET)")
                .count(),
            1
        );
        assert_eq!(unshare_wrapper.matches("\n        -1\n").count(), 1);

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
            .find("if unshare() == 0")
            .expect("CreatePrivate unshare success polarity");
        let create_success = create_private.find("Ok(())").expect("unshare success");
        let create_failure = create_private
            .find("Err(io::Error::last_os_error())")
            .expect("unshare failure");
        assert!(
            create_pre_exec < create_call
                && create_call < create_success
                && create_success < create_failure
        );
        assert_eq!(create_private.matches("command.pre_exec").count(), 1);
        assert_eq!(create_private.matches("unshare()").count(), 1);

        let join_private = spawn
            .split_once("EpochNetworkNamespaceMode::JoinPrivate => {")
            .expect("JoinPrivate arm")
            .1
            .split_once("EpochNetworkNamespaceMode::Host if member.role()")
            .expect("end of JoinPrivate arm")
            .0;
        let retained_descriptor = join_private
            .find("let namespace_fd = namespace_descriptor")
            .expect("retained namespace descriptor");
        let raw_descriptor = join_private
            .find(".as_raw_fd()")
            .expect("retained namespace raw fd");
        let join_pre_exec = join_private
            .find("command.pre_exec")
            .expect("JoinPrivate pre-exec owner");
        let join_call = join_private
            .find("if setns(namespace_fd) == 0")
            .expect("JoinPrivate setns success polarity");
        let join_success = join_private.find("Ok(())").expect("setns success");
        let join_failure = join_private
            .find("Err(io::Error::last_os_error())")
            .expect("setns failure");
        assert!(
            retained_descriptor < raw_descriptor
                && raw_descriptor < join_pre_exec
                && join_pre_exec < join_call
                && join_call < join_success
                && join_success < join_failure
        );
        assert_eq!(join_private.matches("command.pre_exec").count(), 1);
        assert_eq!(join_private.matches("setns(namespace_fd)").count(), 1);

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
                .matches("wait_for_member_namespace(child, &namespace_descriptor)")
                .count(),
            1
        );
        let gateway_start = startup
            .find("&plan.members()[3]")
            .expect("Gateway spawn owner");
        let namespace_bind = startup
            .find(".bind_network_namespace(Arc::clone(&namespace_descriptor))")
            .expect("Gateway namespace binding");
        let gateway = &startup[gateway_start..namespace_bind];
        assert_eq!(
            gateway
                .matches("wait_for_member_namespace(child, &namespace_descriptor)")
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
        let namespace_path = if cfg!(target_os = "linux") {
            "/proc/self/ns/net"
        } else {
            "/dev/null"
        };
        let namespace_descriptor: Arc<OwnedFd> = Arc::new(
            File::open(namespace_path)
                .expect("current network namespace descriptor")
                .into(),
        );
        let mut children = Vec::new();

        let effective_capabilities = std::fs::read_to_string("/proc/self/status")
            .expect("Linux process status")
            .lines()
            .find_map(|line| line.strip_prefix("CapEff:\t"))
            .and_then(|value| u64::from_str_radix(value, 16).ok())
            .expect("effective Linux capabilities");
        let spawn = spawn_member(&mut children, &member, Some(&namespace_descriptor));
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
            Duration::from_secs(1),
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
            _content: &[u8],
            timeout: Duration,
        ) -> Result<(), ImageImportError> {
            self.imports.push((digest.to_string(), timeout));
            if self.fail_import {
                return Err(ImageImportError::Backend);
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
        use sha2::{Digest, Sha256};

        let root = std::env::temp_dir().join(format!(
            "openkit-wp3b-import-{}-{label}",
            std::process::id()
        ));
        let digest = format!("sha256:{:x}", Sha256::digest(content));
        let mut store = ImageStore::open(
            root.join("store"),
            root.join("epoch"),
            &[root.join("credentials")],
        )
        .expect("isolated store");
        store
            .admit(
                &digest,
                content,
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
        for path in [first.containerd_socket(), first.docker_socket()] {
            assert!(path.starts_with(run_root));
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
        assert!(gateway_config.contains(&format!("supervisor_image = \"{SUPERVISOR_IMAGE}\"")));
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
    fn nhc_imp_5o_reaps_network_members_before_releasing_the_namespace_descriptor() {
        let production = include_str!("epoch_coordinator.rs")
            .split_once("#[cfg(test)]")
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
            .find("namespace_descriptor.take()")
            .expect("retained namespace descriptor release");
        assert!(terminate < release);
    }

    #[test]
    fn wp3a_u3a1_fail_stops_every_uncertain_or_partial_epoch() {
        for fault in [
            EpochFault::PartialStart,
            EpochFault::MemberExited,
            EpochFault::IdentityMismatch,
            EpochFault::CreateOutcomeUncertain,
            EpochFault::DeleteOutcomeUncertain,
        ] {
            assert_eq!(fault.action(), EpochAction::TerminateProcess);
        }
        assert!(!capacity_ready(false));
    }

    #[test]
    fn fresh_empty_epoch_settles_only_exact_cleanup_absence() {
        let request = |kind| LifecycleEffectRequest::new("request", "lease", "sandbox", kind);

        assert_eq!(
            definite_absence_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                None,
                false,
                false,
                false,
            ),
            Ok(Some("closed"))
        );
        assert_eq!(
            definite_absence_lifecycle_result(
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
                definite_absence_lifecycle_result(&request(kind), None, false, false, false),
                Ok(None)
            );
        }
        for (bridge_present, monitor_present) in [(true, false), (false, true)] {
            assert_eq!(
                definite_absence_lifecycle_result(
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
            definite_absence_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                Some("sandbox"),
                true,
                true,
                false,
            ),
            Ok(None)
        );
        assert_eq!(
            definite_absence_lifecycle_result(
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
                definite_absence_lifecycle_result(
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
            definite_absence_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                Some("sandbox"),
                true,
                false,
                false,
            ),
            Err(EpochFault::IdentityMismatch)
        );
        assert_eq!(
            definite_absence_lifecycle_result(
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
            definite_absence_lifecycle_result(
                &request(LifecycleEffectKind::CloseBridge),
                None,
                false,
                false,
                true,
            ),
            Err(EpochFault::IdentityMismatch)
        );
        assert_eq!(
            definite_absence_lifecycle_result(
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
            .split_once("#[cfg(test)]")
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
            .split("#[cfg(test)]")
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
            .split_once("#[cfg(test)]")
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
            .split("#[cfg(test)]")
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
            .split("#[cfg(test)]")
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
    fn wp3b_required_import_is_store_only_verified_and_fail_closed() {
        use sha2::{Digest, Sha256};

        let production = include_str!("epoch_coordinator.rs")
            .split("#[cfg(test)]")
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
        let import_source = docker_backend
            .split_once("fn import_verified")
            .expect("Docker import implementation")
            .1
            .split_once("fn inspect_digest")
            .expect("end of Docker import implementation")
            .0;
        let inspect_source = docker_backend
            .split_once("fn inspect_digest")
            .expect("Docker digest inspection")
            .1
            .split_once("/// Imports every non-empty required deployment digest")
            .expect("end of Docker digest inspection")
            .0;
        let inspect_args = inspect_source
            .split_once(".args([")
            .expect("direct Docker inspect argv")
            .1
            .split_once("])")
            .expect("end of Docker inspect argv")
            .0;
        let image = inspect_args
            .find("\"image\"")
            .expect("Docker image command");
        let inspect = inspect_args
            .find("\"inspect\"")
            .expect("Docker inspect command");
        let format = inspect_args
            .find("\"--format\"")
            .expect("Docker inspect format");
        let image_id = inspect_args
            .find("\"{{.Id}}\"")
            .expect("digest-only image Id projection");
        let requested = inspect_args
            .rfind("digest")
            .expect("requested image digest");
        assert!(image < inspect && inspect < format && format < image_id && image_id < requested);
        assert!(inspect_source.contains("self.command()"));
        let trim = inspect_source
            .find(".trim()")
            .expect("trimmed Docker output");
        let exact = inspect_source[trim..]
            .find("== digest")
            .map(|offset| trim + offset)
            .expect("exact requested-digest equality");
        let success = inspect_source[exact..]
            .find("Ok(digest.to_string())")
            .map(|offset| exact + offset)
            .expect("canonical requested digest result");
        let mismatch = inspect_source[success..]
            .find("Err(ImageImportError::DigestMismatch)")
            .map(|offset| success + offset)
            .expect("empty, other, or substring mismatch rejection");
        assert!(trim < exact && exact < success && success < mismatch);
        assert!(!inspect_source.contains(".contains(digest)"));
        for forbidden in [
            "RepoDigests",
            "org.opencontainers.image.ref.name",
            "io.containerd.image.name",
            "failed to validate image signature",
        ] {
            assert!(!inspect_source.contains(forbidden));
            assert!(!import_source.contains(forbidden));
        }
        assert!(
            contains_source.contains("ImageImportError::Probe")
                && !contains_source.contains("ImageImportError::Backend"),
            "presence-probe failure collapsed into another backend operation"
        );
        let load_source = import_source
            .split_once("let child =")
            .expect("stock Docker image-load command")
            .1;
        assert!(
            load_source.contains(".args([\"image\", \"load\", \"--input\", &path_arg(&archive)])")
                && load_source.contains(".stderr(Stdio::inherit())")
                && load_source.contains("ImageImportError::Load")
                && !load_source.contains("ImageImportError::Backend"),
            "image-load failure or diagnostics collapsed into another backend operation"
        );
        assert!(
            inspect_source.contains(".stderr(Stdio::inherit())")
                && inspect_source.contains("ImageImportError::Inspect")
                && !inspect_source.contains("ImageImportError::Backend"),
            "post-inspect failure or diagnostics collapsed into another backend operation"
        );
        let load_result = import_source
            .find("let result = child")
            .expect("bounded load result retained through cleanup");
        let archive_cleanup = import_source[load_result..]
            .find("fs::remove_file(archive)")
            .map(|offset| load_result + offset)
            .expect("attempt-local archive cleanup");
        let staging_cleanup = import_source[archive_cleanup..]
            .find("fs::remove_dir(&self.staging_root)")
            .map(|offset| archive_cleanup + offset)
            .expect("attempt-local empty staging-root cleanup");
        let load_return = import_source[staging_cleanup..]
            .find("\n        result")
            .map(|offset| staging_cleanup + offset)
            .expect("load result returned after cleanup");
        assert!(load_result < archive_cleanup && archive_cleanup < staging_cleanup);
        assert!(staging_cleanup < load_return);
        assert!(!import_source.contains("remove_dir_all(&self.staging_root)"));

        let private_dir_source = production
            .split_once("fn create_private_dir")
            .expect("fresh-only private directory helper")
            .1
            .split_once("fn write_private_file")
            .expect("end of private directory helper")
            .0;
        assert!(
            private_dir_source.contains("DirBuilder::new().mode(0o700).create(path)?"),
            "global epoch directory creation no longer refuses an existing root"
        );

        let (mut store, digest, root) = admitted_store("required", b"deployment image");
        let second_content = b"second deployment image";
        let second_digest = format!("sha256:{:x}", Sha256::digest(second_content));
        store
            .admit(
                &second_digest,
                second_content,
                StoreLineage::Registry(format!("docker.io/openkit/worker@{second_digest}")),
                2,
            )
            .expect("second required image");
        let required = BTreeSet::from([digest.clone(), second_digest.clone()]);
        let mut backend = ImportBackend::default();

        assert!(import_required_images(&mut store, &required, &mut backend));
        assert_eq!(backend.imports.len(), 2);
        assert_eq!(
            backend
                .imports
                .iter()
                .map(|(digest, _)| digest.clone())
                .collect::<BTreeSet<_>>(),
            required
        );
        assert!(
            backend
                .imports
                .iter()
                .all(|(_, timeout)| *timeout == Duration::from_secs(45))
        );
        assert!(capacity_ready(true));

        let mut missing_backend = ImportBackend::default();
        assert!(!import_required_images(
            &mut store,
            &BTreeSet::from(["sha256:missing".to_string()]),
            &mut missing_backend,
        ));
        assert!(missing_backend.imports.is_empty());
        assert!(!capacity_ready(false));

        let mut mismatch_backend = ImportBackend {
            inspected: BTreeMap::from([(digest.clone(), "sha256:other".to_string())]),
            ..ImportBackend::default()
        };
        assert!(!import_required_images(
            &mut store,
            &required,
            &mut mismatch_backend,
        ));
        assert!(!capacity_ready(false));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wp3b_mid_epoch_import_is_bounded_noop_and_failure_isolated() {
        assert_eq!(MID_EPOCH_IMPORT_TIMEOUT, Duration::from_secs(45));
        let (mut store, digest, root) = admitted_store("attempt", b"attempt image");
        let required = BTreeSet::from(["sha256:deployment".to_string()]);

        let mut already_present = ImportBackend {
            present: BTreeSet::from([digest.clone()]),
            ..ImportBackend::default()
        };
        assert_eq!(
            import_attempt_image(&mut store, &digest, &required, &mut already_present),
            Ok(AttemptImportOutcome::AlreadyPresent)
        );
        assert!(already_present.imports.is_empty());

        let mut imported = ImportBackend::default();
        assert_eq!(
            import_attempt_image(&mut store, &digest, &required, &mut imported),
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
            import_attempt_image(&mut store, &digest, &required, &mut failed),
            Err(ImageImportError::Backend)
        );
        assert!(
            capacity_ready(true),
            "attempt failure invalidated healthy epoch"
        );
        assert_eq!(
            import_attempt_image(
                &mut store,
                "sha256:deployment",
                &required,
                &mut ImportBackend::default(),
            ),
            Err(ImageImportError::DeploymentDigest)
        );
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wp3c_invalidation_export_precedes_every_fence_and_is_never_recovery_input() {
        let coordinator = include_str!("epoch_coordinator.rs")
            .split("#[cfg(test)]")
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
        let all_fences_bounded = [startup_fence, running_fence].into_iter().all(|boundary| {
            let worker = boundary.find("thread::spawn(move || {");
            let worker_body = worker.and_then(|worker| {
                boundary[worker..]
                    .split_once("})")
                    .map(|(worker_body, _)| worker_body)
            });
            matches!(
                (
                    worker,
                    worker_body.and_then(|body| body.find("record_fence_started(")),
                    worker_body.and_then(|body| body.find("export_invalidation(")),
                    boundary.find("recv_timeout(EXPORT_TIMEOUT)"),
                    boundary.find("terminate_children("),
                ),
                (Some(worker), Some(marker), Some(export), Some(hard), Some(fence))
                    if !boundary[..worker].contains("record_fence_started(")
                        && marker < export
                        && worker + export < hard
                        && hard < fence
                        && !boundary[hard..fence].contains("record_fence_started(")
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
            .split_once("#[cfg(test)]")
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
            .split_once("/// Acquires, stores, and imports")
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
            "if request.kind != FileEffectKind::ExportFile || !terminal_barrier_proved || !final_status || !process_group_absent {"
        ));
        assert!(compact_export.contains(
            "Ok(result) if result.exit_status == 2 && result.stdout.is_empty() && request.presence == FileEffectPresence::Optional =>"
        ));
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
            .split_once("#[cfg(test)]")
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
            .split_once("/// Acquires, stores, and imports")
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
            .split_once("/// Imports one private staged regular file")
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
            .find("Ok(result) if result.exit_status == 0 && result.stdout == expected.as_bytes()")
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
        assert!(export.contains("retained_export_result"));
        assert!(export.contains("successor"));
        assert!(export.contains("sandbox.name.as_str()"));
        assert!(export.contains("exec_sandbox_interactive(\n                &sandbox.id"));
        assert_eq!(
            export.matches("delete_sandbox(").count(),
            export.matches("delete_sandbox(&sandbox.name").count(),
            "every export failure must clean up by public sandbox name"
        );
        for bootstrap_rule in ["harness_ready", "final_status", "process_group_absent"] {
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
}
