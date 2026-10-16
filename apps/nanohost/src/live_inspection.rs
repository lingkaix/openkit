//! Fixed read-only operator inspection, independent of runtime effect carriage.
//!
//! Only ephemeral coordinator observations cross this local entry. Blocking OS
//! measurements hold their admission slot until they end, even after a response
//! deadline; they never hold the runtime monitor or a connection-state lock.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::{SocketAddr, UnixListener as StdListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ring::digest::{Context, SHA256, digest};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;
use tokio::task::{AbortHandle, JoinSet};

const ENTRY: &[u8] = b"openkit.nanohost.inspection.v1";
const REQUEST_LIMIT: usize = 256;
const RESPONSE_LIMIT: usize = 16 * 1024;
const CLI_LIMIT: Duration = Duration::from_secs(10);
const SERVER_LIMIT: Duration = Duration::from_secs(5);

/// Closed evidence refusals; never expose underlying OS errors or observations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    NotRunning,
    AccessDenied,
    ConnectionUnavailable,
    ProcessChanged,
    MeasurementUnavailable,
    UnitUnavailable,
}

impl Failure {
    /// Returns the consumer's closed wire reason.
    fn reason(self) -> &'static str {
        match self {
            Self::NotRunning => "not-running",
            Self::AccessDenied => "access-denied",
            Self::ConnectionUnavailable => "connection-unavailable",
            Self::ProcessChanged => "process-changed",
            Self::MeasurementUnavailable => "measurement-unavailable",
            Self::UnitUnavailable => "unit-unavailable",
        }
    }

    /// Constructs a nonce-bound refusal without partial measurement fields.
    fn envelope(self, nonce: &str) -> Value {
        json!({"nonce": nonce, "outcome": "unavailable", "reason": self.reason()})
    }
}

/// Immutable OS incarnation; a PID by itself is never a process identity.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessStamp {
    boot_id: String,
    pid: u32,
    start_ticks: String,
}

impl ProcessStamp {
    /// Reads live kernel identity and rejects exited and zombie processes.
    fn read(pid: u32) -> Result<Self, Failure> {
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|_| Failure::MeasurementUnavailable)?
            .trim()
            .to_owned();
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_err(|_| Failure::ProcessChanged)?;
        let tail = stat
            .rsplit_once(") ")
            .ok_or(Failure::MeasurementUnavailable)?
            .1;
        let fields: Vec<_> = tail.split_ascii_whitespace().collect();
        if matches!(fields.first(), Some(&"Z" | &"X" | &"x")) {
            return Err(Failure::ProcessChanged);
        }
        let start_ticks = fields
            .get(19)
            .filter(|v| positive_decimal(v))
            .ok_or(Failure::MeasurementUnavailable)?
            .to_string();
        if !uuid(&boot_id) || pid == 0 || pid > i32::MAX as u32 {
            return Err(Failure::MeasurementUnavailable);
        }
        Ok(Self {
            boot_id,
            pid,
            start_ticks,
        })
    }

    /// Confirms that the same live incarnation still exists.
    fn recheck(&self) -> Result<(), Failure> {
        if Self::read(self.pid)? != *self {
            return Err(Failure::ProcessChanged);
        }
        Ok(())
    }

    /// Serializes only the consumer's process identity fields.
    fn value(&self) -> Value {
        json!({"bootId":self.boot_id,"pid":self.pid,"startTimeTicks":self.start_ticks})
    }
}

/// Current authenticated connection snapshot and private transition detector.
#[derive(Clone)]
struct Binding {
    identity: String,
    deployment: String,
    generation: u64,
}

/// Mutex scope is only observation-state access, never OS measurement or await.
struct Current {
    alive: bool,
    version: u64,
    binding: Option<Binding>,
}

/// Read-only projection retained by the real coordinator and its fence monitor.
pub(crate) struct InspectionState {
    epoch: String,
    coordinator: ProcessStamp,
    gateway: ProcessStamp,
    current: Mutex<Current>,
}

impl InspectionState {
    /// Pins this coordinator and its already proved distinct Gateway child.
    pub(crate) fn new(epoch: String, gateway_pid: u32) -> Result<Arc<Self>, Failure> {
        let coordinator = ProcessStamp::read(std::process::id())?;
        let gateway = ProcessStamp::read(gateway_pid)?;
        if !hex64(&epoch) || gateway == coordinator {
            return Err(Failure::MeasurementUnavailable);
        }
        Ok(Arc::new(Self {
            epoch,
            coordinator,
            gateway,
            current: Mutex::new(Current {
                alive: true,
                version: 0,
                binding: None,
            }),
        }))
    }

    /// Publishes only the actual allocated connection after its complete ACK.
    #[cfg(test)]
    pub(crate) fn admit(&self, identity: &str, deployment: &str, generation: u64) {
        if let Ok(mut current) = self.current.lock() {
            Self::advance(&mut current);
            if current.alive
                && !identity.is_empty()
                && !deployment.is_empty()
                && generation > 0
                && generation <= 9_007_199_254_740_991
            {
                current.binding = Some(Binding {
                    identity: identity.into(),
                    deployment: deployment.into(),
                    generation,
                });
            }
        }
    }

    /// Clears availability before reconnect; the Epoch itself stays unchanged.
    pub(crate) fn clear(&self) {
        if let Ok(mut current) = self.current.lock() {
            Self::advance(&mut current);
        }
    }

    /// Permanently closes this owner before fencing or teardown.
    pub(crate) fn close(&self) {
        if let Ok(mut current) = self.current.lock() {
            Self::advance(&mut current);
            current.alive = false;
        }
    }

    /// Prevents ABA and refuses a theoretical observation-version overflow.
    fn advance(current: &mut Current) {
        current.binding = None;
        match current.version.checked_add(1) {
            Some(version) => current.version = version,
            None => current.alive = false,
        }
    }

    /// Captures the current connection without allowing measurement to own it.
    fn snapshot(&self) -> Result<(u64, Binding), Failure> {
        let current = self
            .current
            .lock()
            .map_err(|_| Failure::ConnectionUnavailable)?;
        if !current.alive {
            return Err(Failure::ConnectionUnavailable);
        }
        Ok((
            current.version,
            current
                .binding
                .clone()
                .ok_or(Failure::ConnectionUnavailable)?,
        ))
    }

    /// Rejects every transition, including away and back to the same tuple.
    fn recheck(&self, version: u64) -> Result<(), Failure> {
        let (actual, _) = self.snapshot()?;
        if actual != version {
            return Err(Failure::ConnectionUnavailable);
        }
        Ok(())
    }
}

/// Clears observation on every native-session return or future cancellation.
pub(crate) struct ConnectionObservation {
    state: Arc<InspectionState>,
    version: Option<u64>,
}

impl ConnectionObservation {
    /// Starts a non-ready attempt; only the native readiness ACK can admit it.
    pub(crate) fn new(state: Arc<InspectionState>) -> Self {
        let version = state.current.lock().ok().map(|mut current| {
            InspectionState::advance(&mut current);
            current.version
        });
        Self { state, version }
    }

    /// A transport that ended before readiness cannot republish a stale binding.
    pub(crate) fn admit(&self, identity: &str, deployment: &str, generation: u64) {
        if let Ok(mut current) = self.state.current.lock()
            && current.alive
            && self.version == Some(current.version)
            && !identity.is_empty()
            && !deployment.is_empty()
            && generation > 0
            && generation <= 9_007_199_254_740_991
        {
            InspectionState::advance(&mut current);
            if current.alive {
                current.binding = Some(Binding {
                    identity: identity.into(),
                    deployment: deployment.into(),
                    generation,
                });
            }
        }
    }
}

impl Drop for ConnectionObservation {
    /// Does not leave stale readiness when the outer future is dropped.
    fn drop(&mut self) {
        self.state.clear();
    }
}

/// Fixed production sources; only verification builds can substitute fixtures.
#[derive(Clone)]
struct Sources {
    machine: PathBuf,
    unit: PathBuf,
    #[cfg(test)]
    observer: Option<Arc<dyn Fn() -> Result<String, Failure> + Send + Sync>>,
    #[cfg(test)]
    after_pin: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Sources {
    /// Uses no caller, configuration or environment selector.
    fn fixed() -> Self {
        Self {
            machine: PathBuf::from("/etc/machine-id"),
            unit: PathBuf::from("/etc/systemd/system/openkit-nanohost.service"),
            #[cfg(test)]
            observer: None,
            #[cfg(test)]
            after_pin: None,
        }
    }

    /// Reads exactly the named non-secret effective properties under the deadline.
    fn unit(&self, deadline: Instant) -> Result<String, Failure> {
        #[cfg(test)]
        if let Some(observer) = &self.observer {
            return observer();
        }
        systemd_observation(deadline)
    }
}

/// Coordinator-owned local listener; dropping it aborts all response tasks.
pub(crate) struct InspectionServer {
    state: Arc<InspectionState>,
    task: AbortHandle,
}

impl InspectionServer {
    /// Binds the one production abstract entry. Failure affects inspection only.
    pub(crate) fn start(state: Arc<InspectionState>) -> Result<Self, Failure> {
        // SAFETY: geteuid has no memory preconditions or side effects.
        if unsafe { libc::geteuid() } != 0 {
            return Err(Failure::AccessDenied);
        }
        Self::bind(state, ENTRY, 0, Sources::fixed())
    }

    /// Starts independently scheduled exchanges without a disk discovery record.
    fn bind(
        state: Arc<InspectionState>,
        entry: &[u8],
        uid: u32,
        sources: Sources,
    ) -> Result<Self, Failure> {
        let address =
            SocketAddr::from_abstract_name(entry).map_err(|_| Failure::MeasurementUnavailable)?;
        let listener =
            StdListener::bind_addr(&address).map_err(|_| Failure::MeasurementUnavailable)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| Failure::MeasurementUnavailable)?;
        let listener =
            UnixListener::from_std(listener).map_err(|_| Failure::MeasurementUnavailable)?;
        let observed = Arc::clone(&state);
        let task = tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(4));
            let mut exchanges = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream,_)) = accepted else { break; };
                        let state = Arc::clone(&observed);
                        let sources = sources.clone();
                        let slots = Arc::clone(&slots);
                        exchanges.spawn(async move {
                            let deadline = tokio::time::Instant::now() + SERVER_LIMIT;
                            let _ = tokio::time::timeout_at(deadline,
                                exchange(stream, state, sources, slots, uid, deadline.into_std())).await;
                        });
                    }
                    _ = exchanges.join_next(), if !exchanges.is_empty() => {}
                }
            }
        });
        Ok(Self {
            state,
            task: task.abort_handle(),
        })
    }

    /// Substitutes only owner-permitted fixture sources and entry admission.
    #[cfg(test)]
    pub(crate) fn start_fixture(
        state: Arc<InspectionState>,
        fixture: test_support::Fixture,
    ) -> Result<Self, Failure> {
        Self::bind(
            state,
            &fixture.endpoint,
            fixture.allowed_uid,
            Sources {
                machine: fixture.machine_id,
                unit: fixture.unit_file,
                observer: Some(fixture.unit_observer),
                after_pin: fixture.after_pin,
            },
        )
    }
}

impl Drop for InspectionServer {
    /// Closes observation authority before aborting listener and response tasks.
    fn drop(&mut self) {
        self.state.close();
        self.task.abort();
    }
}

/// Reads a complete EOF-delimited bounded request and produces at most one reply.
async fn exchange(
    mut stream: UnixStream,
    state: Arc<InspectionState>,
    sources: Sources,
    slots: Arc<Semaphore>,
    uid: u32,
    deadline: Instant,
) -> Result<(), Failure> {
    let admitted = stream.peer_cred().map_err(|_| Failure::AccessDenied)?.uid() == uid;
    let request = read_bounded(&mut stream, REQUEST_LIMIT).await?;
    let nonce = request_nonce(&request)?;
    if !admitted {
        return write_reply(&stream, &Failure::AccessDenied.envelope(&nonce), None).await;
    }
    let Ok(slot) = slots.try_acquire_owned() else {
        return write_reply(
            &stream,
            &Failure::MeasurementUnavailable.envelope(&nonce),
            None,
        )
        .await;
    };
    let producer = Arc::clone(&state);
    let requested = nonce.clone();
    let measured = tokio::task::spawn_blocking(move || {
        let _occupied = slot;
        measure(&producer, &sources, &requested, deadline)
    })
    .await
    .map_err(|_| Failure::MeasurementUnavailable)?;
    match measured {
        Ok((value, version)) => {
            if let Err(failure) = state.recheck(version) {
                write_reply(&stream, &failure.envelope(&nonce), None).await
            } else {
                write_reply(&stream, &value, Some((&state, version))).await
            }
        }
        Err(failure) => write_reply(&stream, &failure.envelope(&nonce), None).await,
    }
}

/// Bounds complete framing, including whitespace; overflow never becomes JSON.
async fn read_bounded(stream: &mut UnixStream, limit: usize) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    stream
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Failure::MeasurementUnavailable)?;
    if bytes.len() > limit {
        return Err(Failure::MeasurementUnavailable);
    }
    Ok(bytes)
}

/// Rechecks current authority at each nonblocking write without holding it over await.
async fn write_reply(
    stream: &UnixStream,
    value: &Value,
    current: Option<(&InspectionState, u64)>,
) -> Result<(), Failure> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| Failure::MeasurementUnavailable)?;
    bytes.push(b'\n');
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Failure::MeasurementUnavailable);
    }
    let mut offset = 0;
    while offset < bytes.len() {
        stream
            .writable()
            .await
            .map_err(|_| Failure::MeasurementUnavailable)?;
        let guard = match current {
            Some((state, version)) => {
                let guard = state
                    .current
                    .lock()
                    .map_err(|_| Failure::ConnectionUnavailable)?;
                if !guard.alive || guard.binding.is_none() || guard.version != version {
                    return Err(Failure::ConnectionUnavailable);
                }
                Some(guard)
            }
            None => None,
        };
        let written = stream.try_write(&bytes[offset..]);
        drop(guard);
        match written {
            Ok(0) => return Err(Failure::MeasurementUnavailable),
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => return Err(Failure::MeasurementUnavailable),
        }
    }
    Ok(())
}

/// Common complete measurement; no field is published until every check passes.
fn measure(
    state: &InspectionState,
    sources: &Sources,
    nonce: &str,
    deadline: Instant,
) -> Result<(Value, u64), Failure> {
    check_deadline(deadline)?;
    let (version, binding) = state.snapshot()?;
    state.coordinator.recheck()?;
    state.gateway.recheck()?;
    let machine = read_regular(&sources.machine, 4096, true, deadline)?;
    if machine.is_empty() {
        return Err(Failure::MeasurementUnavailable);
    }
    let unit_file = read_regular(&sources.unit, 128 * 1024, true, deadline)
        .map_err(|_| Failure::UnitUnavailable)?;
    let unit = unit_observation(&sources.unit(deadline)?, state.coordinator.pid)?;
    let mut nanohost = Image::open(&state.coordinator)?;
    let mut gateway = Image::open(&state.gateway)?;
    #[cfg(test)]
    if let Some(after_pin) = &sources.after_pin {
        after_pin();
    }
    let nanohost_hash = nanohost.hash(deadline)?;
    let gateway_hash = gateway.hash(deadline)?;
    let after_unit = unit_observation(&sources.unit(deadline)?, state.coordinator.pid)?;
    let after_file = read_regular(&sources.unit, 128 * 1024, true, deadline)
        .map_err(|_| Failure::UnitUnavailable)?;
    if unit != after_unit || unit_file != after_file {
        return Err(Failure::UnitUnavailable);
    }
    if machine != read_regular(&sources.machine, 4096, true, deadline)? {
        return Err(Failure::MeasurementUnavailable);
    }
    // Recheck both processes after ALL potentially blocking unit/file observations.
    nanohost.recheck()?;
    gateway.recheck()?;
    state.recheck(version)?;
    check_deadline(deadline)?;
    Ok((
        json!({"nonce":nonce,"outcome":"observed","machineIdentityDigest":sha256(&machine),
        "physicalEpoch":state.epoch,"identityId":binding.identity,"deploymentId":binding.deployment,
        "connectionGeneration":binding.generation,"coordinator":state.coordinator.value(),
        "executables":{"nanohost":{"process":state.coordinator.value(),"sha256":nanohost_hash},
            "gateway":{"process":state.gateway.value(),"sha256":gateway_hash}},
        "unit":{"fileSha256":sha256(&unit_file),"effectiveStateDigest":unit,
            "activeState":"active","subState":"running"},"replacementDuringMeasurement":false}),
        version,
    ))
}

/// File identity checks bind a retained image handle to the live process interface.
struct Image {
    stamp: ProcessStamp,
    file: File,
    identity: (u64, u64, u64, i64, i64),
}

impl Image {
    /// Opens the process image, not its installation pathname.
    fn open(stamp: &ProcessStamp) -> Result<Self, Failure> {
        stamp.recheck()?;
        let file = File::open(format!("/proc/{}/exe", stamp.pid))
            .map_err(|_| Failure::MeasurementUnavailable)?;
        let identity = image_identity(&file)?;
        let image = Self {
            stamp: stamp.clone(),
            file,
            identity,
        };
        image.recheck()?;
        Ok(image)
    }

    /// Streams at most 64 KiB per read and checks the shared absolute bound.
    fn hash(&mut self, deadline: Instant) -> Result<String, Failure> {
        self.recheck()?;
        let mut digest = Context::new(&SHA256);
        let mut chunk = [0u8; 64 * 1024];
        let mut count = 0u64;
        loop {
            check_deadline(deadline)?;
            let size = self
                .file
                .read(&mut chunk)
                .map_err(|_| Failure::MeasurementUnavailable)?;
            if size == 0 {
                break;
            }
            count += size as u64;
            if count > self.identity.2 {
                return Err(Failure::ProcessChanged);
            }
            digest.update(&chunk[..size]);
        }
        if count != self.identity.2 {
            return Err(Failure::ProcessChanged);
        }
        self.recheck()?;
        Ok(hex_digest(digest.finish().as_ref()))
    }

    /// Detects exit, PID reuse, exec and mutation of the opened image.
    fn recheck(&self) -> Result<(), Failure> {
        self.stamp.recheck()?;
        let current = File::open(format!("/proc/{}/exe", self.stamp.pid))
            .map_err(|_| Failure::ProcessChanged)?;
        if image_identity(&self.file)? != self.identity
            || image_identity(&current)? != self.identity
        {
            return Err(Failure::ProcessChanged);
        }
        Ok(())
    }
}

/// Adds ctime to dev/inode/size so same-size image changes cannot pass silently.
fn image_identity(file: &File) -> Result<(u64, u64, u64, i64, i64), Failure> {
    let metadata = file
        .metadata()
        .map_err(|_| Failure::MeasurementUnavailable)?;
    if !metadata.is_file() {
        return Err(Failure::MeasurementUnavailable);
    }
    Ok((
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    ))
}

/// Reads fixed regular files without allowing a blocking special file substitution.
fn read_regular(
    path: &Path,
    limit: usize,
    no_symlink: bool,
    deadline: Instant,
) -> Result<Vec<u8>, Failure> {
    check_deadline(deadline)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NONBLOCK | if no_symlink { libc::O_NOFOLLOW } else { 0 });
    let mut file = options
        .open(path)
        .map_err(|_| Failure::MeasurementUnavailable)?;
    let before = image_identity(&file)?;
    if before.2 > limit as u64 {
        return Err(Failure::MeasurementUnavailable);
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::MeasurementUnavailable)?;
    if bytes.len() > limit || image_identity(&file)? != before {
        return Err(Failure::MeasurementUnavailable);
    }
    check_deadline(deadline)?;
    Ok(bytes)
}

/// Rejects expired work before it can turn into a late success.
fn check_deadline(deadline: Instant) -> Result<(), Failure> {
    if Instant::now() >= deadline {
        Err(Failure::MeasurementUnavailable)
    } else {
        Ok(())
    }
}

/// Hashes exact bytes; no trim or newline normalization is permitted.
fn sha256(bytes: &[u8]) -> String {
    hex_digest(digest(&SHA256, bytes).as_ref())
}

/// Encodes only measurement digests, never raw machine or unit observations.
fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Exact canonical effective-state set owned by Live Operator Inspection.
const UNIT_PROPERTIES: [&str; 40] = [
    "Type",
    "ExecStart",
    "ExecStop",
    "ExecStopPost",
    "User",
    "Group",
    "SupplementaryGroups",
    "DynamicUser",
    "NoNewPrivileges",
    "PrivateMounts",
    "PrivateTmp",
    "ProtectSystem",
    "ProtectHome",
    "InaccessiblePaths",
    "ReadOnlyPaths",
    "ReadWritePaths",
    "BindPaths",
    "BindReadOnlyPaths",
    "RootDirectory",
    "RootImage",
    "WorkingDirectory",
    "EnvironmentFiles",
    "LoadCredential",
    "LoadCredentialEncrypted",
    "PassEnvironment",
    "UnsetEnvironment",
    "Slice",
    "KillMode",
    "Restart",
    "RestartUSec",
    "RestartPreventExitStatus",
    "TimeoutStopUSec",
    "CapabilityBoundingSet",
    "AmbientCapabilities",
    "RestrictNamespaces",
    "RestrictAddressFamilies",
    "SystemCallFilter",
    "DevicePolicy",
    "DeviceAllow",
    "DropInPaths",
];
const UNIT_BINDING: [&str; 4] = ["MainPID", "ActiveState", "SubState", "NeedDaemonReload"];

/// Invokes only a fixed read, with a bounded nonblocking stdout and killed child on error.
fn systemd_observation(deadline: Instant) -> Result<String, Failure> {
    check_deadline(deadline).map_err(|_| Failure::UnitUnavailable)?;
    let mut child = Command::new("/usr/bin/systemctl")
        .env_clear()
        .env("LC_ALL", "C")
        .args(["--no-pager", "--all", "show"])
        .arg(format!(
            "--property={}",
            UNIT_PROPERTIES
                .into_iter()
                .chain(UNIT_BINDING)
                .collect::<Vec<_>>()
                .join(",")
        ))
        .args(["--", "openkit-nanohost.service"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Failure::UnitUnavailable)?;
    let result = (|| {
        use std::os::fd::AsRawFd;
        let mut output = child.stdout.take().ok_or(Failure::UnitUnavailable)?;
        // SAFETY: fcntl acts on our owned pipe descriptor; O_NONBLOCK changes no owner.
        if unsafe { libc::fcntl(output.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
            return Err(Failure::UnitUnavailable);
        }
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            check_deadline(deadline).map_err(|_| Failure::UnitUnavailable)?;
            match output.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.len() > 128 * 1024 {
                        return Err(Failure::UnitUnavailable);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => return Err(Failure::UnitUnavailable),
            }
        }
        loop {
            check_deadline(deadline).map_err(|_| Failure::UnitUnavailable)?;
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) | Err(_) => return Err(Failure::UnitUnavailable),
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        String::from_utf8(bytes).map_err(|_| Failure::UnitUnavailable)
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// Validates binding and hashes only the sorted, string-valued canonical map.
fn unit_observation(raw: &str, pid: u32) -> Result<String, Failure> {
    let mut properties = BTreeMap::new();
    for line in raw.lines() {
        let (key, value) = line.split_once('=').ok_or(Failure::UnitUnavailable)?;
        if (!UNIT_PROPERTIES.contains(&key) && !UNIT_BINDING.contains(&key))
            || properties.insert(key, value).is_some()
        {
            return Err(Failure::UnitUnavailable);
        }
    }
    if properties.len() != UNIT_PROPERTIES.len() + UNIT_BINDING.len()
        || properties.get("MainPID") != Some(&pid.to_string().as_str())
        || properties.get("ActiveState") != Some(&"active")
        || properties.get("SubState") != Some(&"running")
        || properties.get("NeedDaemonReload") != Some(&"no")
    {
        return Err(Failure::UnitUnavailable);
    }
    let mut canonical = BTreeMap::new();
    for key in UNIT_PROPERTIES {
        let value = properties.get(key).ok_or(Failure::UnitUnavailable)?;
        let normalized = match key {
            "ExecStart" | "ExecStop" | "ExecStopPost" => normalize_execution(key, value)?,
            "UnsetEnvironment" | "PassEnvironment"
                if value.split_ascii_whitespace().any(|name| {
                    !name.bytes().enumerate().all(|(index, byte)| {
                        byte == b'_'
                            || byte.is_ascii_alphabetic()
                            || (index > 0 && byte.is_ascii_digit())
                    })
                }) =>
            {
                return Err(Failure::UnitUnavailable);
            }
            _ => value.to_string(),
        };
        canonical.insert(key, normalized);
    }
    Ok(sha256(
        &serde_json::to_vec(&canonical).map_err(|_| Failure::UnitUnavailable)?,
    ))
}

/// Admits only existing fixed service commands, excluding runtime execution fields.
fn normalize_execution(kind: &str, raw: &str) -> Result<String, Failure> {
    if raw.is_empty() {
        return Ok("[]".into());
    }
    let mut commands = Vec::new();
    let framed = raw
        .strip_prefix("{ ")
        .and_then(|value| value.strip_suffix(" }"))
        .ok_or(Failure::UnitUnavailable)?;
    for body in framed.split(" } { ") {
        let mut fields = BTreeMap::new();
        for field in body.split(" ; ") {
            let (key, value) = field.split_once('=').ok_or(Failure::UnitUnavailable)?;
            if fields.insert(key, value).is_some() {
                return Err(Failure::UnitUnavailable);
            }
        }
        let names = [
            "path",
            "argv[]",
            "ignore_errors",
            "start_time",
            "stop_time",
            "pid",
            "code",
            "status",
        ];
        if fields.len() != names.len() || names.iter().any(|name| !fields.contains_key(name)) {
            return Err(Failure::UnitUnavailable);
        }
        let start = kind == "ExecStart";
        let path = if start {
            "/usr/lib/openkit/nanohost"
        } else {
            "/usr/bin/systemctl"
        };
        let argv = if start {
            vec![path]
        } else {
            vec![
                path,
                "kill",
                "--signal=SIGKILL",
                "--kill-whom=all",
                "openkit-nanohost.slice",
            ]
        };
        if fields["path"] != path
            || fields["argv[]"] != argv.join(" ")
            || fields["ignore_errors"] != if start { "no" } else { "yes" }
        {
            return Err(Failure::UnitUnavailable);
        }
        commands.push(json!({"argv":argv,"ignoreErrors":!start,"path":path}));
    }
    serde_json::to_string(&commands).map_err(|_| Failure::UnitUnavailable)
}

/// Bounded JSON value that rejects duplicate names at every nesting level.
struct Unique(Value);

impl<'de> Deserialize<'de> for Unique {
    /// Uses serde's grammar and depth bound instead of another JSON parser.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("unique-key JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Unique(n.into()))
                    .ok_or_else(|| E::custom("invalid number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                let mut values = Vec::new();
                while let Some(Unique(v)) = seq.next_element()? {
                    values.push(v);
                }
                Ok(Unique(values.into()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, Unique(value))) = map.next_entry::<String, Unique>()? {
                    if values.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate name"));
                    }
                }
                Ok(Unique(values.into()))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}

/// Parses exact nonce-only input with serde's recursion limit still enabled.
fn request_nonce(bytes: &[u8]) -> Result<String, Failure> {
    let Unique(value) =
        serde_json::from_slice(bytes).map_err(|_| Failure::MeasurementUnavailable)?;
    if value.as_object().is_none_or(|object| object.len() != 1) {
        return Err(Failure::MeasurementUnavailable);
    }
    value
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|nonce| hex64(nonce))
        .map(str::to_owned)
        .ok_or(Failure::MeasurementUnavailable)
}

/// Validates the consumer's lowercase digest and nonce grammar.
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
/// Validates positive canonical kernel decimal text without precision loss.
fn positive_decimal(value: &str) -> bool {
    !value.starts_with('0') && value.parse::<u64>().is_ok_and(|n| n > 0)
}
/// Validates UUID shape without emitting or normalizing host identifiers.
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Calls the real local entry and checks nonce, core semantics and peer incarnation.
async fn inspect_at(nonce: &str, entry: &[u8], uid: u32) -> Result<Value, Failure> {
    if !hex64(nonce) {
        return Err(Failure::MeasurementUnavailable);
    }
    let mut address = Vec::with_capacity(entry.len() + 1);
    address.push(0);
    address.extend_from_slice(entry);
    let path = Path::new(std::ffi::OsStr::from_bytes(&address));
    let mut stream = UnixStream::connect(path)
        .await
        .map_err(|error| match error.kind() {
            io::ErrorKind::PermissionDenied => Failure::AccessDenied,
            io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound => Failure::NotRunning,
            _ => Failure::MeasurementUnavailable,
        })?;
    let peer = stream.peer_cred().map_err(|_| Failure::AccessDenied)?;
    if peer.uid() != uid {
        return Err(Failure::AccessDenied);
    }
    let peer_pid = peer
        .pid()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or(Failure::AccessDenied)?;
    let stamp = ProcessStamp::read(peer_pid)?;
    let request =
        serde_json::to_vec(&json!({"nonce":nonce})).map_err(|_| Failure::MeasurementUnavailable)?;
    stream
        .write_all(&request)
        .await
        .map_err(|_| Failure::MeasurementUnavailable)?;
    stream
        .shutdown()
        .await
        .map_err(|_| Failure::MeasurementUnavailable)?;
    let bytes = read_bounded(&mut stream, RESPONSE_LIMIT).await?;
    let Unique(value) =
        serde_json::from_slice(&bytes).map_err(|_| Failure::MeasurementUnavailable)?;
    stamp.recheck()?;
    validate_reply(value, nonce, &stamp)
}

/// Strips descriptive extensions and rejects unsupported core evidence.
fn validate_reply(value: Value, nonce: &str, peer: &ProcessStamp) -> Result<Value, Failure> {
    let string = |key: &str| value.get(key).and_then(Value::as_str);
    if string("nonce") != Some(nonce) {
        return Err(Failure::MeasurementUnavailable);
    }
    if string("outcome") == Some("unavailable") {
        let reason = string("reason").ok_or(Failure::MeasurementUnavailable)?;
        if ![
            "not-running",
            "access-denied",
            "connection-unavailable",
            "process-changed",
            "measurement-unavailable",
            "unit-unavailable",
        ]
        .contains(&reason)
        {
            return Err(Failure::MeasurementUnavailable);
        }
        return Ok(json!({"nonce":nonce,"outcome":"unavailable","reason":reason}));
    }
    if string("outcome") != Some("observed")
        || !string("machineIdentityDigest").is_some_and(hex64)
        || !string("physicalEpoch").is_some_and(hex64)
        || !string("identityId").is_some_and(|s| !s.is_empty())
        || !string("deploymentId").is_some_and(|s| !s.is_empty())
        || !value["connectionGeneration"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
        || value["replacementDuringMeasurement"] != false
    {
        return Err(Failure::MeasurementUnavailable);
    }
    let stamp_value = |v: &Value| -> Result<Value, Failure> {
        let boot = v["bootId"]
            .as_str()
            .filter(|s| uuid(s))
            .ok_or(Failure::MeasurementUnavailable)?;
        let pid = v["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= i32::MAX as u64)
            .ok_or(Failure::MeasurementUnavailable)?;
        let ticks = v["startTimeTicks"]
            .as_str()
            .filter(|s| positive_decimal(s))
            .ok_or(Failure::MeasurementUnavailable)?;
        Ok(json!({"bootId":boot,"pid":pid,"startTimeTicks":ticks}))
    };
    let coordinator = stamp_value(&value["coordinator"])?;
    if coordinator != peer.value() {
        return Err(Failure::ProcessChanged);
    }
    let mut executables = serde_json::Map::new();
    for name in ["nanohost", "gateway"] {
        let exe = &value["executables"][name];
        let process = stamp_value(&exe["process"])?;
        if (name == "nanohost" && process != coordinator)
            || (name == "gateway"
                && (process["pid"] == coordinator["pid"]
                    || process["bootId"] != coordinator["bootId"]))
        {
            return Err(Failure::ProcessChanged);
        }
        let hash = exe["sha256"]
            .as_str()
            .filter(|s| hex64(s))
            .ok_or(Failure::MeasurementUnavailable)?;
        executables.insert(name.into(), json!({"process":process,"sha256":hash}));
    }
    let unit = &value["unit"];
    if !unit["fileSha256"].as_str().is_some_and(hex64)
        || !unit["effectiveStateDigest"].as_str().is_some_and(hex64)
        || unit["activeState"] != "active"
        || unit["subState"] != "running"
    {
        return Err(Failure::UnitUnavailable);
    }
    Ok(
        json!({"nonce":nonce,"outcome":"observed","machineIdentityDigest":value["machineIdentityDigest"],
        "physicalEpoch":value["physicalEpoch"],"identityId":value["identityId"],"deploymentId":value["deploymentId"],
        "connectionGeneration":value["connectionGeneration"],"coordinator":coordinator,"executables":executables,
        "unit":{"fileSha256":unit["fileSha256"],"effectiveStateDigest":unit["effectiveStateDigest"],"activeState":"active","subState":"running"},"replacementDuringMeasurement":false}),
    )
}

/// Reads stdin under the CLI's absolute bound without a thread that can outlive it.
fn input_before(deadline: Instant) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    loop {
        check_deadline(deadline)?;
        let milliseconds = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(i32::MAX as u128) as i32;
        let mut descriptor = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll and read receive valid stack buffers; fd 0 is read only.
        let ready = unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
        if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if ready <= 0 {
            return Err(Failure::MeasurementUnavailable);
        }
        let mut chunk = [0u8; REQUEST_LIMIT + 1];
        // SAFETY: read writes at most the supplied buffer length.
        let size = unsafe { libc::read(0, chunk.as_mut_ptr().cast(), chunk.len()) };
        if size < 0 {
            return Err(Failure::MeasurementUnavailable);
        }
        if size == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..size as usize]);
        if bytes.len() > REQUEST_LIMIT {
            return Err(Failure::MeasurementUnavailable);
        }
    }
}

/// Includes the complete bounded stdout envelope in the invocation deadline.
fn output_before(value: &Value, deadline: Instant) -> Result<(), Failure> {
    use std::os::fd::AsRawFd;
    let output = std::io::stdout();
    let descriptor = output.as_raw_fd();
    // The CLI owns this output operation. Restore shared descriptor flags before
    // returning; nonblocking writes cannot exceed the absolute bound on a slow pipe.
    // SAFETY: fcntl operates on the process's existing stdout descriptor.
    let original = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if original < 0
        || unsafe { libc::fcntl(descriptor, libc::F_SETFL, original | libc::O_NONBLOCK) } < 0
    {
        return Err(Failure::MeasurementUnavailable);
    }
    let result = (|| {
        let mut bytes = serde_json::to_vec(value).map_err(|_| Failure::MeasurementUnavailable)?;
        bytes.push(b'\n');
        if bytes.len() > RESPONSE_LIMIT {
            return Err(Failure::MeasurementUnavailable);
        }
        let mut offset = 0;
        while offset < bytes.len() {
            check_deadline(deadline)?;
            let milliseconds = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(i32::MAX as u128) as i32;
            let mut polled = libc::pollfd {
                fd: descriptor,
                events: libc::POLLOUT,
                revents: 0,
            };
            // SAFETY: poll and write use valid stack data and the serialized byte buffer.
            let ready = unsafe { libc::poll(&mut polled, 1, milliseconds) };
            if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if ready <= 0 {
                return Err(Failure::MeasurementUnavailable);
            }
            let count = unsafe {
                libc::write(
                    descriptor,
                    bytes[offset..].as_ptr().cast(),
                    bytes.len() - offset,
                )
            };
            if count < 0 {
                if matches!(
                    io::Error::last_os_error().kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) {
                    continue;
                }
                return Err(Failure::MeasurementUnavailable);
            }
            if count == 0 {
                return Err(Failure::MeasurementUnavailable);
            }
            offset += count as usize;
        }
        Ok(())
    })();
    // SAFETY: restores exactly the flags observed on this same output descriptor.
    let _ = unsafe { libc::fcntl(descriptor, libc::F_SETFL, original) };
    result
}

/// Executes the fixed command before TLS, credentials, Epoch or service setup.
pub(crate) fn cli() -> Result<(), Failure> {
    let deadline = Instant::now() + CLI_LIMIT;
    let nonce = request_nonce(&input_before(deadline)?)?;
    // SAFETY: geteuid has no memory preconditions or side effects.
    if unsafe { libc::geteuid() } != 0 {
        return output_before(&Failure::AccessDenied.envelope(&nonce), deadline);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Failure::MeasurementUnavailable)?;
    let result = runtime.block_on(async {
        tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline),
            inspect_at(&nonce, ENTRY, 0),
        )
        .await
        .map_err(|_| Failure::MeasurementUnavailable)?
    });
    output_before(
        &result.unwrap_or_else(|failure| failure.envelope(&nonce)),
        deadline,
    )
}

/// Verification substitutes observations while retaining actual IPC and process reads.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    /// Fixture-owned entry, admission and observed files; absent in production.
    pub(crate) struct Fixture {
        pub endpoint: Vec<u8>,
        pub allowed_uid: u32,
        pub machine_id: PathBuf,
        pub unit_file: PathBuf,
        pub unit_observer: Arc<dyn Fn() -> Result<String, Failure> + Send + Sync>,
        pub after_pin: Option<Arc<dyn Fn() + Send + Sync>>,
    }
    /// Applies the same complete client, including deadline and peer credentials.
    pub(crate) async fn inspect_at(
        nonce: &str,
        endpoint: &[u8],
        allowed_uid: u32,
    ) -> Result<Value, Failure> {
        tokio::time::timeout(CLI_LIMIT, super::inspect_at(nonce, endpoint, allowed_uid))
            .await
            .map_err(|_| Failure::MeasurementUnavailable)?
    }
}
