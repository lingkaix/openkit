//! Read-only `workspace.collect` scan into NanoHost's private Git store.
//!
//! Core owns the capture cursor. A produced pair stays unacknowledged until a later command names it. The private store is not canonical Workspace storage. Runtime-env values and loopback digests stay in memory for the scan and are never written or logged.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// Host root for private scan repositories, outside the bind-mounted worktree.
pub const WORKSPACE_SCAN_ROOT: &str = "/var/lib/openkit/nanohost-workspace-scan";
/// Review-candidate ceiling shared with the fixed file-data stream.
pub const COLLECT_CANDIDATE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const OBJECT_ID_LEN: usize = 40;
const RUNTIME_ENV_MAX_BYTES: usize = 64 * 1024;
const RUNTIME_ENV_MAX_COUNT: usize = 128;
const LOOPBACK_WINDOW_BYTES: usize = 43;
const IDENTIFIER_MAX_BYTES: usize = 128;
const PINNED_GIT: &str = "/usr/bin/git";
const PINNED_GIT_VERSION: &str = "git version 2.43.0";
const COLLECT_DEADLINE: Duration = Duration::from_secs(120);
const MAX_WALK_ENTRIES: usize = 100_000;
const MAX_WALK_DEPTH: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
const MAX_METADATA_BYTES: usize = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IGNORE_BYTES: usize = 1024 * 1024;
const MAX_HEAD_BYTES: usize = 4096;
const REF_PROTECTION: &str = "refs/openkit/protection";
const CORE_MEMBERS: &[&str] = &[
    "storageRef",
    "scopeDigest",
    "attachmentGeneration",
    "sandboxId",
    "mode",
    "requestId",
    "workSlot",
    "collectionId",
    "acceptedBase",
    "previousHead",
    "checkValues",
];

/// Returns whether a collect result body is within the file-data ceiling.
pub fn collect_result_is_admissible(len: u64) -> bool {
    len <= COLLECT_CANDIDATE_MAX_BYTES
}

/// Git tree id paired with the blob id of the canonical full-permission manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotPair {
    /// Lowercase hexadecimal tree object id.
    pub tree: String,
    /// Lowercase hexadecimal manifest blob id.
    pub manifest: String,
}

impl SnapshotPair {
    fn wire(&self) -> String {
        format!("{} {}", self.tree, self.manifest)
    }
}

/// Closed collection mode; Core alone decides baseline acceptance.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CollectMode {
    /// Extend the Core-named snapshot chain.
    Capture,
    /// Observe the first initialization without accepting it.
    Baseline,
}

/// Closed command core. Unknown top-level members are not represented here.
#[derive(Clone, PartialEq, Eq)]
pub struct CollectCommand {
    /// Exact admitted retained association.
    pub storage_ref: String,
    /// Core scope correlation.
    pub scope_digest: String,
    /// Current attachment generation.
    pub attachment_generation: u64,
    /// Current live Sandbox identity.
    pub sandbox_id: String,
    /// Closed operation form.
    pub mode: CollectMode,
    /// Lowercase 64-hex effect identity.
    pub request_id: String,
    /// Work slot used to find the bind-mounted worktree.
    pub work_slot: String,
    /// Collection identity. It is not persisted.
    pub collection_id: String,
    /// Core's accepted base pair.
    pub accepted_base: SnapshotPair,
    /// Capture cursor the command claims to extend.
    pub previous_head: SnapshotPair,
    /// Session-static runtime-env values. Memory only.
    pub runtime_env: Vec<String>,
    /// SHA-256 digests of the two loopback credentials. Memory only.
    pub loopback_digests: [String; 2],
}

impl CollectCommand {
    /// Projects only admitted core input for production dispatch; extensions never survive polling.
    pub fn input(&self) -> serde_json::Value {
        let pair =
            |pair: &SnapshotPair| serde_json::json!({"tree": pair.tree, "manifest": pair.manifest});
        serde_json::json!({
            "requestId": self.request_id, "storageRef": self.storage_ref, "scopeDigest": self.scope_digest,
            "attachmentGeneration": self.attachment_generation, "sandboxId": self.sandbox_id,
            "workSlot": self.work_slot, "collectionId": self.collection_id,
            "mode": if self.mode == CollectMode::Capture { "capture" } else { "baseline" },
            "acceptedBase": if self.mode == CollectMode::Capture { pair(&self.accepted_base) } else { serde_json::Value::Null },
            "previousHead": if self.mode == CollectMode::Capture { pair(&self.previous_head) } else { serde_json::Value::Null },
            "checkValues": {"runtimeEnv": self.runtime_env, "loopbackDigests": self.loopback_digests}
        })
    }
}

/// Octet-stream review candidate bound to one verified second scan.
#[derive(Clone)]
pub struct WorkspaceCandidate {
    /// Effect identity.
    pub request_id: String,
    /// Second scan's snapshot pair.
    pub head: SnapshotPair,
    /// Command cursor.
    pub previous_head: SnapshotPair,
    /// Command accepted base.
    pub accepted_base: SnapshotPair,
    /// The two scans differed.
    pub unstable: bool,
    /// Immutable patch bytes, including a full-mode section when needed.
    pub body: CandidateBody,
}

/// Exact file-data result. JSON bodies already contain `requestId`.
#[derive(Clone)]
pub enum WorkspaceCollectDelivery {
    /// JSON outcome. The body binds `requestId`; no snapshot header is required.
    Json {
        /// Effect identity.
        request_id: String,
        /// Exact JSON bytes.
        body: Vec<u8>,
    },
    /// Non-empty review candidate.
    Candidate(WorkspaceCandidate),
}

/// Immutable staged candidate; production never accumulates the complete content in memory.
#[derive(Clone)]
pub struct CandidateBody(Arc<StagedCandidate>);

struct StagedCandidate {
    file: File,
    path: PathBuf,
    len: u64,
    digest: String,
}

impl Drop for StagedCandidate {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl CandidateBody {
    /// Length fixed after staging completes.
    pub fn len(&self) -> u64 {
        self.0.len
    }
    /// Whether the immutable candidate has zero bytes.
    pub fn is_empty(&self) -> bool {
        self.0.len == 0
    }
    /// Digest fixed over exactly the staged bytes.
    pub fn digest(&self) -> &str {
        &self.0.digest
    }
    /// Reads one bounded application chunk without sharing a seek cursor.
    pub fn chunk(&self, offset: u64, maximum: usize) -> std::io::Result<Vec<u8>> {
        let remaining = self
            .0
            .len
            .saturating_sub(offset)
            .min(maximum.min(65536) as u64) as usize;
        let mut bytes = vec![0u8; remaining];
        self.0.file.read_exact_at(&mut bytes, offset)?;
        Ok(bytes)
    }
    #[cfg(test)]
    fn bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        while (bytes.len() as u64) < self.len() {
            bytes.extend(self.chunk(bytes.len() as u64, 65536).unwrap());
        }
        bytes
    }
    #[cfg(test)]
    pub fn fixture(bytes: Vec<u8>) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "openkit-candidate-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(&bytes).unwrap();
        Self(Arc::new(StagedCandidate {
            file,
            path,
            len: bytes.len() as u64,
            digest: format!("sha256:{:x}", Sha256::digest(&bytes)),
        }))
    }
}

impl WorkspaceCollectDelivery {
    /// Effect identity carried by this result.
    pub fn request_id(&self) -> &str {
        match self {
            Self::Json { request_id, .. } => request_id,
            Self::Candidate(candidate) => &candidate.request_id,
        }
    }

    /// Exact immutable body length.
    pub fn body_len(&self) -> u64 {
        match self {
            Self::Json { body, .. } => body.len() as u64,
            Self::Candidate(candidate) => candidate.body.len(),
        }
    }

    /// Reads at most one 64-KiB application chunk.
    pub fn body_chunk(&self, offset: u64, maximum: usize) -> std::io::Result<Vec<u8>> {
        match self {
            Self::Json { body, .. } => {
                let offset = usize::try_from(offset)
                    .map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))?;
                let end = offset.saturating_add(maximum.min(65536)).min(body.len());
                Ok(body
                    .get(offset..end)
                    .ok_or(ErrorKind::InvalidInput)?
                    .to_vec())
            }
            Self::Candidate(candidate) => candidate.body.chunk(offset, maximum),
        }
    }

    #[cfg(test)]
    pub fn body(&self) -> Vec<u8> {
        match self {
            Self::Json { body, .. } => body.clone(),
            Self::Candidate(candidate) => candidate.body.bytes(),
        }
    }
}

/// One file-data response header. Each name is emitted once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectHeader {
    /// Lowercase header name.
    pub name: &'static str,
    /// Header value.
    pub value: String,
}

/// Headers for one collect result. JSON results carry no snapshot-pair headers.
pub fn delivery_headers(delivery: &WorkspaceCollectDelivery) -> Vec<CollectHeader> {
    match delivery {
        WorkspaceCollectDelivery::Json { body, .. } => vec![
            header("content-type", "application/json"),
            header("content-length", body.len().to_string()),
        ],
        WorkspaceCollectDelivery::Candidate(candidate) => {
            let digest = candidate.body.digest().to_string();
            vec![
                header("content-type", "application/octet-stream"),
                header("content-length", candidate.body.len().to_string()),
                header("x-openkit-request-id", candidate.request_id.clone()),
                header("x-openkit-head", candidate.head.wire()),
                header("x-openkit-previous-head", candidate.previous_head.wire()),
                header("x-openkit-accepted-base", candidate.accepted_base.wire()),
                header(
                    "x-openkit-unstable",
                    if candidate.unstable { "true" } else { "false" },
                ),
                header("x-openkit-sha256", digest),
                header("x-openkit-byte-length", candidate.body.len().to_string()),
            ]
        }
    }
}

fn header(name: &'static str, value: impl Into<String>) -> CollectHeader {
    CollectHeader {
        name,
        value: value.into(),
    }
}

/// Validates one raw command before any scan.
///
/// # Errors
///
/// Returns a static reason for a missing core member, a duplicate core member, a core value outside its closed set, or a body over the control ceiling. Unknown additive members are ignored and are not retained.
pub fn validate_collect_command(body: &[u8]) -> Result<CollectCommand, &'static str> {
    if body.len() > crate::sandbox_bridge::NANOHOST_CONTROL_IN_FLIGHT_BYTES {
        return Err("workspace.collect command invalid");
    }
    validate_json_depth(body)?;
    let mut decoder = serde_json::Deserializer::from_slice(body);
    decoder.disable_recursion_limit();
    let mut values = decoder.into_iter::<serde_json::Value>();
    let value = values
        .next()
        .ok_or(COMMAND_INVALID)?
        .map_err(|_| COMMAND_INVALID)?;
    if values.next().is_some() {
        return Err(COMMAND_INVALID);
    }
    reject_duplicate_core_members(body)?;
    validate_collect_value(&value)
}

fn validate_collect_value(value: &serde_json::Value) -> Result<CollectCommand, &'static str> {
    let object = value
        .as_object()
        .ok_or("workspace.collect command invalid")?;
    let request_id = required_string(object, "requestId")?;
    if !is_request_id(request_id) {
        return Err("workspace.collect command invalid");
    }
    let work_slot = required_string(object, "workSlot")?;
    let collection_id = required_string(object, "collectionId")?;
    if !is_identifier(work_slot) || !is_identifier(collection_id) {
        return Err("workspace.collect command invalid");
    }
    let storage_ref = required_string(object, "storageRef")?;
    let scope_digest = required_string(object, "scopeDigest")?;
    let sandbox_id = required_string(object, "sandboxId")?;
    let attachment_generation = object
        .get("attachmentGeneration")
        .and_then(serde_json::Value::as_u64)
        .filter(|generation| *generation > 0 && *generation <= 9_007_199_254_740_991)
        .ok_or(COMMAND_INVALID)?;
    if !crate::persistent_volume::valid_collection_identity(storage_ref, scope_digest, sandbox_id) {
        return Err(COMMAND_INVALID);
    }
    let mode = match required_string(object, "mode")? {
        "capture" => CollectMode::Capture,
        "baseline" => CollectMode::Baseline,
        _ => return Err(COMMAND_INVALID),
    };
    let (accepted_base, previous_head) = match mode {
        CollectMode::Capture => (
            required_pair(object, "acceptedBase")?,
            required_pair(object, "previousHead")?,
        ),
        CollectMode::Baseline => {
            if !object
                .get("acceptedBase")
                .is_some_and(serde_json::Value::is_null)
                || !object
                    .get("previousHead")
                    .is_some_and(serde_json::Value::is_null)
            {
                return Err(COMMAND_INVALID);
            }
            // Baseline never consults these capture-only fields.
            let absent = SnapshotPair {
                tree: String::new(),
                manifest: String::new(),
            };
            (absent.clone(), absent)
        }
    };
    let checks = object
        .get("checkValues")
        .and_then(serde_json::Value::as_object)
        .ok_or("workspace.collect command invalid")?;
    if !checks.contains_key("runtimeEnv") || !checks.contains_key("loopbackDigests") {
        return Err("workspace.collect command invalid");
    }
    let runtime_env = checks
        .get("runtimeEnv")
        .and_then(serde_json::Value::as_array)
        .ok_or("workspace.collect command invalid")?;
    if runtime_env.len() > RUNTIME_ENV_MAX_COUNT {
        return Err("workspace.collect command invalid");
    }
    let mut values = Vec::with_capacity(runtime_env.len());
    for entry in runtime_env {
        let value = entry
            .as_str()
            .filter(|value| {
                !value.is_empty() && !value.contains('\0') && value.len() <= RUNTIME_ENV_MAX_BYTES
            })
            .ok_or("workspace.collect command invalid")?;
        values.push(value.to_string());
    }
    let digests = checks
        .get("loopbackDigests")
        .and_then(serde_json::Value::as_array)
        .ok_or("workspace.collect command invalid")?;
    if digests.len() != 2 {
        return Err("workspace.collect command invalid");
    }
    let mut loopback_digests = [String::new(), String::new()];
    for (index, digest) in digests.iter().enumerate() {
        let digest = digest
            .as_str()
            .filter(|value| is_lowercase_hex(value, 64))
            .ok_or("workspace.collect command invalid")?;
        loopback_digests[index] = digest.to_string();
    }
    Ok(CollectCommand {
        storage_ref: storage_ref.to_string(),
        scope_digest: scope_digest.to_string(),
        attachment_generation,
        sandbox_id: sandbox_id.to_string(),
        mode,
        request_id: request_id.to_string(),
        work_slot: work_slot.to_string(),
        collection_id: collection_id.to_string(),
        accepted_base,
        previous_head,
        runtime_env: values,
        loopback_digests,
    })
}

/// Runs the production scan for one polled command.
///
/// Failures, including a missing worktree or an unavailable Git binary, become
/// the two-member `effect_failed` result. The scan does not start for an invalid command.
pub fn execute_collect(
    coordinator: &crate::epoch_coordinator::EpochCoordinator,
    request_id: &str,
    input: &serde_json::Value,
) -> WorkspaceCollectDelivery {
    let started = Instant::now();
    let command = match validate_collect_value(input) {
        Ok(command) if command.request_id == request_id => command,
        _ => return effect_failed(request_id),
    };
    let resolved = match coordinator.resolve_collection(&command) {
        Ok(resolved) => resolved,
        Err(_) => return effect_failed(request_id),
    };
    let git_bin = match pinned_git() {
        Ok(path) => path,
        Err(()) => return effect_failed(request_id),
    };
    let store = store_directory(
        coordinator.collection_scan_root(),
        &command.storage_ref,
        &resolved.volume_ref,
        &command.work_slot,
    );
    let mut collector = match WorkspaceCollector::open_with_fd_started(
        &git_bin,
        &store,
        resolved.worktree,
        started,
    ) {
        Ok(collector) => collector,
        Err(()) => return effect_failed(request_id),
    };
    collector.started = started;
    collector.collect(&command)
}

/// Absolute Git binary pinned by the host manifest.
///
/// # Errors
///
/// Returns an error when `/usr/bin/git` is not a regular non-symlink file.
pub fn pinned_git() -> Result<PathBuf, ()> {
    let path = PathBuf::from(PINNED_GIT);
    if is_regular_nonlink(&path) {
        Ok(path)
    } else {
        Err(())
    }
}

/// Checks the manifest pin against `git --version` before the service accepts work.
///
/// # Errors
///
/// Returns a value-free error when the binary is missing or its version line differs.
pub fn verify_pinned_git() -> Result<(), &'static str> {
    verify_git_identity(Path::new(PINNED_GIT), PINNED_GIT_VERSION)
}

/// Compares one Git binary's version line with the pinned text.
///
/// # Errors
///
/// Returns a value-free error when the binary cannot be executed or the line differs.
pub fn verify_git_identity(path: &Path, expected: &str) -> Result<(), &'static str> {
    if !is_regular_nonlink(path) {
        return Err("nanohost git identity rejected");
    }
    let output = Command::new(path)
        .arg("--version")
        .env_clear()
        .output()
        .map_err(|_| "nanohost git identity rejected")?;
    if !output.status.success() {
        return Err("nanohost git identity rejected");
    }
    let line = output
        .stdout
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or(&[]);
    if line != expected.as_bytes() {
        return Err("nanohost git identity rejected");
    }
    Ok(())
}

fn is_regular_nonlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

/// Stable private lookup scoped to association, volume, and slot across reattachment.
pub fn store_directory(
    root: &Path,
    storage_ref: &str,
    volume_ref: &str,
    work_slot: &str,
) -> PathBuf {
    let framed = serde_json::to_vec(&[storage_ref, volume_ref, work_slot]).expect("string tuple");
    root.join(format!("{:x}", Sha256::digest(framed)))
}

fn effect_failed(request_id: &str) -> WorkspaceCollectDelivery {
    json_delivery(
        request_id,
        &format!(r#"{{"requestId":"{request_id}","outcome":"effect_failed"}}"#),
    )
}

fn credential_hit(request_id: &str) -> WorkspaceCollectDelivery {
    json_delivery(
        request_id,
        &format!(r#"{{"requestId":"{request_id}","outcome":"credential_hit"}}"#),
    )
}

fn recovery_required(request_id: &str, cause: &str) -> WorkspaceCollectDelivery {
    json_delivery(
        request_id,
        &format!(
            r#"{{"requestId":"{request_id}","outcome":"recovery_required","cause":"{cause}"}}"#
        ),
    )
}

fn no_new_head(request_id: &str, unstable: bool) -> WorkspaceCollectDelivery {
    json_delivery(
        request_id,
        &format!(
            r#"{{"requestId":"{request_id}","outcome":"no_new_head","unstable":{unstable}}}"#,
            unstable = if unstable { "true" } else { "false" }
        ),
    )
}

fn empty_result(
    request_id: &str,
    head: &SnapshotPair,
    previous: &SnapshotPair,
    accepted: &SnapshotPair,
    unstable: bool,
) -> WorkspaceCollectDelivery {
    let unstable = if unstable { "true" } else { "false" };
    json_delivery(
        request_id,
        &format!(
            r#"{{"requestId":"{request_id}","outcome":"empty","head":{{"tree":"{}","manifest":"{}"}},"previousHead":{{"tree":"{}","manifest":"{}"}},"acceptedBase":{{"tree":"{}","manifest":"{}"}},"unstable":{unstable}}}"#,
            head.tree,
            head.manifest,
            previous.tree,
            previous.manifest,
            accepted.tree,
            accepted.manifest
        ),
    )
}

fn json_delivery(request_id: &str, body: &str) -> WorkspaceCollectDelivery {
    WorkspaceCollectDelivery::Json {
        request_id: request_id.to_string(),
        body: body.as_bytes().to_vec(),
    }
}

#[derive(Debug)]
enum ScanFault {
    UnsafePath,
    Malformed,
    Disagreement,
    MetadataUnavailable,
    AcceptedBaseUnknown,
    SnapshotUnavailable,
    /// Internal: the named object is not in the private store. Callers map it.
    Missing,
    CleanupFailed,
    Failed,
}

#[derive(Clone)]
struct ChainState {
    accepted: SnapshotPair,
    head: SnapshotPair,
    /// Produced pair Core has not named. `None` when it equals `head`.
    unacknowledged: Option<SnapshotPair>,
}

#[derive(Clone, Copy)]
struct CollectLimits {
    entries: usize,
    depth: usize,
    path_bytes: usize,
    metadata_bytes: usize,
    store_bytes: u64,
    source_bytes: u64,
    deadline: Duration,
}

impl CollectLimits {
    fn production() -> Self {
        Self {
            entries: MAX_WALK_ENTRIES,
            depth: MAX_WALK_DEPTH,
            path_bytes: MAX_PATH_BYTES,
            metadata_bytes: MAX_METADATA_BYTES,
            store_bytes: MAX_STORE_BYTES,
            source_bytes: MAX_SOURCE_BYTES,
            deadline: COLLECT_DEADLINE,
        }
    }
}

struct GitStore {
    bin: PathBuf,
    dir: PathBuf,
    index: PathBuf,
    config: PathBuf,
    home: PathBuf,
    template: PathBuf,
    attempt: PathBuf,
}

struct TreeObject {
    mode: String,
    kind: String,
    oid: String,
}

struct Scan {
    pair: SnapshotPair,
    blobs: BTreeMap<Vec<u8>, String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Symlink,
    Dir,
    Other,
}

struct KeptEntry {
    rel: Vec<u8>,
    kind: EntryKind,
    full_mode: u32,
    blob: Option<String>,
}

#[cfg(test)]
#[derive(Default)]
struct CollectHooks {
    fail_publish_at: Option<u32>,
    publish_count: u32,
    fail_prune: bool,
    before_file_read: Option<Box<dyn FnMut()>>,
    before_file_open: Option<Box<dyn FnMut()>>,
    before_dir_read: Option<Box<dyn FnMut()>>,
    before_dir_open: Option<Box<dyn FnMut()>>,
    before_cleanup: Option<Box<dyn FnMut()>>,
    attempt_objects: Vec<(String, &'static str)>,
}

#[cfg(test)]
thread_local! {
    static FS_FAIL: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    static FS_CRASH: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn test_boundary(label: &'static str) -> Result<(), ScanFault> {
    if FS_CRASH.get() == Some(label) {
        unsafe { libc::_exit(86) };
    }
    if FS_FAIL.get() == Some(label) {
        return Err(ScanFault::Failed);
    }
    Ok(())
}

struct WorkspaceCollector {
    git: GitStore,
    store: PathBuf,
    worktree_fd: OwnedFd,
    state: Option<ChainState>,
    cursor_tree: BTreeMap<Vec<u8>, TreeObject>,
    started: Instant,
    limits: CollectLimits,
    attempt: bool,
    attempt_bytes: u64,
    #[cfg(test)]
    hooks: CollectHooks,
}

impl WorkspaceCollector {
    #[cfg(test)]
    fn open(git_bin: &Path, store: &Path, worktree: &Path) -> Result<Self, ()> {
        let worktree_fd = open_nofollow_dir(worktree).map_err(|_| ())?;
        Self::open_with_fd(git_bin, store, worktree_fd)
    }

    #[cfg(test)]
    fn open_with_fd(git_bin: &Path, store: &Path, worktree_fd: OwnedFd) -> Result<Self, ()> {
        Self::open_with_fd_started(git_bin, store, worktree_fd, Instant::now())
    }

    fn open_with_fd_started(
        git_bin: &Path,
        store: &Path,
        worktree_fd: OwnedFd,
        started: Instant,
    ) -> Result<Self, ()> {
        let mut collector = Self {
            git: GitStore {
                bin: git_bin.to_path_buf(),
                dir: store.join("git"),
                index: store.join("index"),
                config: store.join("empty-config"),
                home: store.join("home"),
                template: store.join("template"),
                attempt: store.join("attempt"),
            },
            store: store.to_path_buf(),
            worktree_fd,
            state: None,
            cursor_tree: BTreeMap::new(),
            started,
            limits: CollectLimits::production(),
            attempt: false,
            attempt_bytes: 0,
            #[cfg(test)]
            hooks: CollectHooks::default(),
        };
        collector.ensure_layout().map_err(|_| ())?;
        collector.state = collector.load_state().map_err(|_| ())?;
        Ok(collector)
    }

    fn collect(&mut self, command: &CollectCommand) -> WorkspaceCollectDelivery {
        self.collect_between(command, || {})
    }

    fn collect_between(
        &mut self,
        command: &CollectCommand,
        between: impl FnOnce(),
    ) -> WorkspaceCollectDelivery {
        if command.mode == CollectMode::Baseline {
            return self.baseline(command, between);
        }
        if let Err(fault) = self.prepare(command) {
            return self.fail_delivery(command, fault);
        }
        if let Err(fault) = self.begin_attempt() {
            return self.fail_delivery(command, fault);
        }
        let first = match self.scan() {
            Ok(scan) => scan,
            Err(fault) => return self.fail_delivery(command, fault),
        };
        between();
        let second = match self.scan() {
            Ok(scan) => scan,
            Err(fault) => return self.fail_delivery(command, fault),
        };
        let hit = match self.credential_union(&first, &second, command) {
            Ok(hit) => hit,
            Err(fault) => return self.fail_delivery(command, fault),
        };
        if hit {
            return self.cleanup_hit(command);
        }
        let unstable = first.pair != second.pair;
        if second.pair == command.previous_head {
            return self.finish_unchanged(command, unstable);
        }
        match self.finish_new(command, &second, unstable) {
            Ok(delivery) => delivery,
            Err(fault) => self.fail_delivery(command, fault),
        }
    }

    /// Protects a stable unacknowledged observation; never authorizes a retained slot.
    fn baseline(
        &mut self,
        command: &CollectCommand,
        between: impl FnOnce(),
    ) -> WorkspaceCollectDelivery {
        self.cursor_tree.clear();
        if self.state.is_some() {
            return effect_failed(&command.request_id);
        }
        if let Err(fault) = self.begin_attempt() {
            return self.fail_delivery(command, fault);
        }
        let first = match self.scan_without_ignore() {
            Ok(scan) => scan,
            Err(fault) => return self.fail_delivery(command, fault),
        };
        between();
        let second = match self.scan_without_ignore() {
            Ok(scan) => scan,
            Err(fault) => return self.fail_delivery(command, fault),
        };
        let mut checker = SecretChecker::new(&command.runtime_env, &command.loopback_digests);
        let mut ids = BTreeSet::new();
        ids.extend(first.blobs.values().cloned());
        ids.extend(second.blobs.values().cloned());
        ids.insert(first.pair.manifest.clone());
        ids.insert(second.pair.manifest.clone());
        for oid in ids {
            match self.blob_hits(&oid, &mut checker) {
                Ok(true) => return self.cleanup_hit(command),
                Ok(false) => {}
                Err(fault) => return self.fail_delivery(command, fault),
            }
        }
        if first.pair != second.pair {
            if self.remove_attempt().is_err() {
                return effect_failed(&command.request_id);
            }
            return recovery_required(&command.request_id, "baseline_unstable");
        }
        let result = (|| {
            self.promote_loose()?;
            // A new Core-authorized baseline replaces an unacknowledged observation; the private pair is not a cursor.
            self.publish_selection(&[("baseline", &second.pair)])?;
            self.remove_attempt()?;
            self.prune()?;
            Ok::<(), ScanFault>(())
        })();
        if let Err(fault) = result {
            return self.fail_delivery(command, fault);
        }
        json_delivery(
            &command.request_id,
            &format!(
                r#"{{"requestId":"{}","outcome":"baseline","head":{{"tree":"{}","manifest":"{}"}}}}"#,
                command.request_id, second.pair.tree, second.pair.manifest
            ),
        )
    }

    fn scan_without_ignore(&mut self) -> Result<Scan, ScanFault> {
        self.scan_with_ignore(false)
    }

    /// Core's verified pair is the retention selection. A missing accepted pair wins over every other snapshot fault.
    fn prepare(&mut self, command: &CollectCommand) -> Result<(), ScanFault> {
        self.cursor_tree.clear();
        self.verify_named(&command.accepted_base, true)?;
        if command.previous_head != command.accepted_base {
            self.verify_named(&command.previous_head, false)?;
        }
        let pending = self
            .state
            .as_ref()
            .and_then(|state| state.unacknowledged.clone())
            .filter(|pair| pair != &command.previous_head);
        self.publish(
            command.accepted_base.clone(),
            command.previous_head.clone(),
            pending,
        )?;
        self.cursor_tree = self.ls_tree(&command.previous_head.tree)?;
        Ok(())
    }

    fn finish_unchanged(
        &mut self,
        command: &CollectCommand,
        unstable: bool,
    ) -> WorkspaceCollectDelivery {
        if self.remove_attempt().is_err() {
            return effect_failed(&command.request_id);
        }
        if self.prune().is_err() {
            return effect_failed(&command.request_id);
        }
        let _ = self.record_context();
        no_new_head(&command.request_id, unstable)
    }

    fn finish_new(
        &mut self,
        command: &CollectCommand,
        second: &Scan,
        unstable: bool,
    ) -> Result<WorkspaceCollectDelivery, ScanFault> {
        let body = self.candidate_body(&command.accepted_base, &second.pair)?;
        if body.len() > COLLECT_CANDIDATE_MAX_BYTES {
            return Err(ScanFault::Failed);
        }
        self.promote_loose()?;
        #[cfg(test)]
        test_boundary("after-promotion")?;
        self.publish(
            command.accepted_base.clone(),
            command.previous_head.clone(),
            Some(second.pair.clone()),
        )?;
        if self.remove_attempt().is_err() {
            return Err(ScanFault::CleanupFailed);
        }
        self.prune()?;
        let _ = self.record_context();
        if body.is_empty() {
            return Ok(empty_result(
                &command.request_id,
                &second.pair,
                &command.previous_head,
                &command.accepted_base,
                unstable,
            ));
        }
        Ok(WorkspaceCollectDelivery::Candidate(WorkspaceCandidate {
            request_id: command.request_id.clone(),
            head: second.pair.clone(),
            previous_head: command.previous_head.clone(),
            accepted_base: command.accepted_base.clone(),
            unstable,
            body,
        }))
    }

    fn cleanup_hit(&mut self, command: &CollectCommand) -> WorkspaceCollectDelivery {
        if self.remove_attempt().is_err() {
            return effect_failed(&command.request_id);
        }
        credential_hit(&command.request_id)
    }

    fn fail_delivery(
        &mut self,
        command: &CollectCommand,
        fault: ScanFault,
    ) -> WorkspaceCollectDelivery {
        let cleanup_failed = self.attempt && self.remove_attempt().is_err();
        if cleanup_failed {
            return effect_failed(&command.request_id);
        }
        map_fault(&command.request_id, fault)
    }

    fn scan(&mut self) -> Result<Scan, ScanFault> {
        self.scan_with_ignore(true)
    }

    fn scan_with_ignore(&mut self, use_ignore: bool) -> Result<Scan, ScanFault> {
        if self.expired() {
            return Err(ScanFault::Failed);
        }
        self.attempt_bytes = 0;
        let tracked = self.cursor_tree.keys().cloned().collect::<BTreeSet<_>>();
        let tracked_dirs = tracked_directories(&tracked);
        let mirror = self.git.attempt.join("ignore");
        if mirror.exists() {
            fs::remove_dir_all(&mirror)?;
        }
        self.check_capacity(8192, 2)?;
        create_private_dir(&mirror)?;
        let mut ignored = BTreeSet::new();
        let mut entries = Vec::new();
        let mut budget = WalkBudget::default();
        let mut walk = WalkState {
            use_ignore,
            tracked: &tracked,
            tracked_dirs: &tracked_dirs,
            ignored: &mut ignored,
            out: &mut entries,
            budget: &mut budget,
        };
        self.walk_at(&self.worktree_fd.try_clone()?, &[], 0, &mut walk)?;
        let entries = keep_directories(entries);
        let mut blobs = BTreeMap::new();
        for entry in &entries {
            if let Some(blob) = &entry.blob {
                blobs.insert(entry.rel.clone(), blob.clone());
            }
        }
        let tree = self.build_tree(&entries)?;
        let encoded_len = entries.iter().try_fold(0usize, |total, entry| {
            total
                .checked_add(entry.rel.len() + entry.rel.len().to_string().len() + 7)
                .ok_or(ScanFault::Failed)
        })?;
        if encoded_len > self.limits.metadata_bytes {
            return Err(ScanFault::Failed);
        }
        let manifest_bytes = encode_manifest(&entries);
        if manifest_bytes.len() > self.limits.metadata_bytes {
            return Err(ScanFault::Failed);
        }
        let manifest = self.write_manifest(&manifest_bytes)?;
        let pair = SnapshotPair { tree, manifest };
        self.verify_scanned(&pair)?;
        Ok(Scan { pair, blobs })
    }

    fn walk_at(
        &mut self,
        dir: &OwnedFd,
        rel_dir: &[u8],
        depth: usize,
        walk: &mut WalkState<'_>,
    ) -> Result<(), ScanFault> {
        if self.expired() || depth > self.limits.depth {
            return Err(ScanFault::Failed);
        }
        if depth > 0 {
            self.before_dir();
        }
        if walk.use_ignore {
            self.load_ignore(dir, rel_dir, walk.budget)?;
        }
        let names = read_dir_names(
            dir,
            self.limits.entries.saturating_sub(walk.budget.entries),
            self.limits
                .path_bytes
                .saturating_sub(rel_dir.len() + usize::from(!rel_dir.is_empty())),
        )?;
        walk.budget.entries = walk
            .budget
            .entries
            .checked_add(names.len())
            .ok_or(ScanFault::Failed)?;
        if walk.use_ignore {
            walk.ignored
                .extend(self.ignored_names(dir, rel_dir, &names)?);
        }
        for name in names {
            self.visit_entry(dir, rel_dir, depth, &name, walk)?;
        }
        Ok(())
    }

    fn visit_entry(
        &mut self,
        dir: &OwnedFd,
        rel_dir: &[u8],
        depth: usize,
        name: &OsStr,
        walk: &mut WalkState<'_>,
    ) -> Result<(), ScanFault> {
        let bytes = name.as_bytes();
        if bytes == b"." || bytes == b".." {
            return Ok(());
        }
        if bytes.eq_ignore_ascii_case(b".git") {
            return Ok(());
        }
        if std::str::from_utf8(bytes).is_err() || unsafe_component(bytes) {
            return Err(ScanFault::UnsafePath);
        }
        let rel = child_rel(rel_dir, bytes);
        if rel.len() > self.limits.path_bytes {
            return Err(ScanFault::Failed);
        }
        let stat = fstatat_nofollow(dir, name).map_err(|_| ScanFault::MetadataUnavailable)?;
        let kind = entry_kind(stat.st_mode);
        let ignored = !walk.tracked.contains(&rel) && walk.ignored.contains(&rel);
        match kind {
            EntryKind::Dir => self.visit_dir(dir, name, &rel, depth, &stat, walk),
            EntryKind::File => {
                if ignored {
                    return Ok(());
                }
                self.visit_file(dir, name, &rel, &stat, walk.out)
            }
            EntryKind::Symlink => {
                if ignored {
                    return Ok(());
                }
                self.visit_link(dir, name, &rel, perm_bits(stat.st_mode), walk.out)
            }
            EntryKind::Other => {
                if ignored {
                    Ok(())
                } else {
                    Err(ScanFault::Failed)
                }
            }
        }
    }

    fn visit_dir(
        &mut self,
        dir: &OwnedFd,
        name: &OsStr,
        rel: &[u8],
        depth: usize,
        listed: &libc::stat,
        walk: &mut WalkState<'_>,
    ) -> Result<(), ScanFault> {
        let ignored = !walk.tracked.contains(rel) && walk.ignored.contains(rel);
        if ignored && !walk.tracked_dirs.contains(rel) {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(hook) = &mut self.hooks.before_dir_open {
            hook();
        }
        let child = openat_dir(dir, name).map_err(|_| ScanFault::MetadataUnavailable)?;
        let opened = fstat(&child).map_err(|_| ScanFault::MetadataUnavailable)?;
        if !same_file(listed, &opened) {
            return Err(ScanFault::Failed);
        }
        self.walk_at(&child, rel, depth + 1, walk)?;
        walk.out.push(KeptEntry {
            rel: rel.to_vec(),
            kind: EntryKind::Dir,
            full_mode: perm_bits(opened.st_mode),
            blob: None,
        });
        Ok(())
    }

    fn visit_file(
        &mut self,
        dir: &OwnedFd,
        name: &OsStr,
        rel: &[u8],
        listed: &libc::stat,
        out: &mut Vec<KeptEntry>,
    ) -> Result<(), ScanFault> {
        #[cfg(test)]
        if let Some(hook) = &mut self.hooks.before_file_open {
            hook();
        }
        let opened = openat_file(dir, name).map_err(|_| ScanFault::MetadataUnavailable)?;
        let opened_stat = fstat(&opened).map_err(|_| ScanFault::MetadataUnavailable)?;
        if entry_kind(opened_stat.st_mode) != EntryKind::File || !same_file(listed, &opened_stat) {
            return Err(ScanFault::Failed);
        }
        self.before_file();
        let oid = self.hash_fd(opened, opened_stat.st_size)?;
        out.push(KeptEntry {
            rel: rel.to_vec(),
            kind: EntryKind::File,
            full_mode: perm_bits(opened_stat.st_mode),
            blob: Some(oid),
        });
        Ok(())
    }

    fn visit_link(
        &mut self,
        dir: &OwnedFd,
        name: &OsStr,
        rel: &[u8],
        mode: u32,
        out: &mut Vec<KeptEntry>,
    ) -> Result<(), ScanFault> {
        let target = read_link_at(dir, name)?;
        let oid = self.write_blob(&target)?;
        out.push(KeptEntry {
            rel: rel.to_vec(),
            kind: EntryKind::Symlink,
            full_mode: mode,
            blob: Some(oid),
        });
        Ok(())
    }

    /// Copies only contained ignore inputs into a private worktree for Git's own pattern engine.
    fn load_ignore(
        &self,
        dir: &OwnedFd,
        rel_dir: &[u8],
        budget: &mut WalkBudget,
    ) -> Result<(), ScanFault> {
        let directory = self
            .git
            .attempt
            .join("ignore")
            .join(OsStr::from_bytes(rel_dir));
        self.check_capacity(8192, 2)?;
        create_private_dir(&directory)?;
        let Some(bytes) = read_regular_at(dir, ".gitignore", MAX_IGNORE_BYTES)? else {
            return Ok(());
        };
        budget.ignore_bytes = budget
            .ignore_bytes
            .checked_add(bytes.len())
            .ok_or(ScanFault::Failed)?;
        if budget.ignore_bytes > 8 * 1024 * 1024 {
            return Err(ScanFault::Failed);
        }
        self.check_capacity(bytes.len() as u64 + 4096, 2)?;
        atomic_write(&directory.join(".gitignore"), &bytes, 0o600)
    }

    fn ignored_names(
        &self,
        dir: &OwnedFd,
        rel_dir: &[u8],
        names: &[OsString],
    ) -> Result<BTreeSet<Vec<u8>>, ScanFault> {
        // Ignore queries are bounded batches, not admitted manifest metadata. Git evaluates each path independently.
        let query = |input: Vec<u8>| -> Result<BTreeSet<Vec<u8>>, ScanFault> {
            let mirror = self.git.attempt.join("ignore");
            let mut command = self.git.command(false);
            command
                .env("GIT_WORK_TREE", &mirror)
                .current_dir(&mirror)
                .args(["check-ignore", "--no-index", "-z", "--stdin"]);
            let outcome = capture(
                &mut command,
                StdinSource::Bytes(input),
                true,
                65536,
                65536,
                self.deadline_at(),
                None,
            )?;
            if outcome.code != 0 && outcome.code != 1 {
                return Err(ScanFault::Failed);
            }
            Ok(outcome
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| path.strip_suffix(b"/").unwrap_or(path).to_vec())
                .collect())
        };
        let mut input = Vec::new();
        let mut ignored = BTreeSet::new();
        for name in names {
            if name.as_bytes().eq_ignore_ascii_case(b".git") {
                continue;
            }
            let rel = child_rel(rel_dir, name.as_bytes());
            if rel.len() > self.limits.path_bytes {
                return Err(ScanFault::Failed);
            }
            if input.len() + rel.len() + 2 > 65536 {
                ignored.extend(query(std::mem::take(&mut input))?);
            }
            let stat = fstatat_nofollow(dir, name).map_err(|_| ScanFault::MetadataUnavailable)?;
            input.extend_from_slice(&rel);
            if entry_kind(stat.st_mode) == EntryKind::Dir {
                input.push(b'/');
            }
            input.push(0);
        }
        if !input.is_empty() {
            ignored.extend(query(input)?);
        }
        Ok(ignored)
    }

    fn build_tree(&mut self, entries: &[KeptEntry]) -> Result<String, ScanFault> {
        if entries.is_empty() {
            return self.mktree(b"");
        }
        let mut groups: BTreeMap<Vec<u8>, Vec<&KeptEntry>> = BTreeMap::new();
        for entry in entries {
            groups
                .entry(parent_of(&entry.rel).to_vec())
                .or_default()
                .push(entry);
        }
        let mut ordered: Vec<Vec<u8>> = groups.keys().cloned().collect();
        ordered.sort_by_key(|path| std::cmp::Reverse(path_depth(path)));
        let mut tree_ids: BTreeMap<Vec<u8>, String> = BTreeMap::new();
        for dir in ordered {
            let mut children = groups.remove(&dir).unwrap_or_default();
            children.sort_by(|left, right| file_name(&left.rel).cmp(file_name(&right.rel)));
            let mut payload = Vec::new();
            for entry in children {
                append_tree_row(&mut payload, entry, &tree_ids)?;
            }
            let id = self.mktree(&payload)?;
            tree_ids.insert(dir, id);
        }
        tree_ids
            .get(&Vec::<u8>::new())
            .cloned()
            .ok_or(ScanFault::Failed)
    }

    fn credential_union(
        &mut self,
        first: &Scan,
        second: &Scan,
        command: &CollectCommand,
    ) -> Result<bool, ScanFault> {
        let mut ids = BTreeSet::new();
        ids.extend(changed_blob_ids(
            &self.ls_tree(&first.pair.tree)?,
            &self.cursor_tree,
        ));
        ids.extend(changed_blob_ids(
            &self.ls_tree(&second.pair.tree)?,
            &self.cursor_tree,
        ));
        ids.extend(manifest_ids(first, second, command));
        ids.extend(self.cumulative_blob_ids(&command.accepted_base.tree, &second.pair.tree)?);
        if ids.is_empty() {
            return Ok(false);
        }
        let mut checker = SecretChecker::new(&command.runtime_env, &command.loopback_digests);
        for oid in ids {
            if self.blob_hits(&oid, &mut checker)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn cumulative_blob_ids(&self, base: &str, head: &str) -> Result<Vec<String>, ScanFault> {
        let base_tree = self.ls_tree(base)?;
        let head_tree = self.ls_tree(head)?;
        let mut paths = BTreeSet::new();
        paths.extend(base_tree.keys().cloned());
        paths.extend(head_tree.keys().cloned());
        let mut ids = Vec::new();
        for path in paths {
            let left = base_tree.get(&path);
            let right = head_tree.get(&path);
            if !snapshot_differs(left, right) {
                continue;
            }
            for side in [left, right].into_iter().flatten() {
                if side.kind == "blob" {
                    ids.push(side.oid.clone());
                }
            }
        }
        Ok(ids)
    }

    fn blob_hits(&self, oid: &str, checker: &mut SecretChecker) -> Result<bool, ScanFault> {
        checker.begin_blob();
        let mut command = self.git.command(self.attempt);
        command.args(["cat-file", "blob", oid]);
        let cap = usize::try_from(self.limits.store_bytes).unwrap_or(usize::MAX);
        capture(
            &mut command,
            StdinSource::None,
            false,
            cap.saturating_add(1),
            u64::MAX,
            self.deadline_at(),
            Some(&mut |chunk| {
                checker.push(chunk);
                if checker.hit { Ok(false) } else { Ok(true) }
            }),
        )?;
        Ok(checker.finish())
    }

    fn candidate_body(
        &self,
        base: &SnapshotPair,
        head: &SnapshotPair,
    ) -> Result<CandidateBody, ScanFault> {
        self.check_capacity(COLLECT_CANDIDATE_MAX_BYTES, 1)?;
        static NEXT_CANDIDATE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = self.store.join(format!(
            "candidate-{}-{}",
            std::process::id(),
            NEXT_CANDIDATE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let mut staged = StagedCandidate {
            file,
            path: path.clone(),
            len: 0,
            digest: String::new(),
        };
        let file = &mut staged.file;
        let mut digest = Sha256::new();
        let mut length = 0u64;
        let mut command = self.git.command(self.attempt);
        command.args([
            "diff",
            "--binary",
            "--full-index",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &base.tree,
            &head.tree,
        ]);
        let outcome = capture(
            &mut command,
            StdinSource::None,
            true,
            COLLECT_CANDIDATE_MAX_BYTES as usize,
            0,
            self.deadline_at(),
            Some(&mut |chunk| {
                file.write_all(chunk)?;
                digest.update(chunk);
                length += chunk.len() as u64;
                Ok(true)
            }),
        );
        if let Err(fault) = outcome {
            let _ = fs::remove_file(&path);
            return Err(fault);
        }
        if !matches!(outcome?.code, 0 | 1) {
            let _ = fs::remove_file(&path);
            return Err(ScanFault::Failed);
        }
        let mut modes = Vec::new();
        append_mode_records(
            &mut modes,
            &decode_manifest(&self.read_blob(&base.manifest)?)?,
            &decode_manifest(&self.read_blob(&head.manifest)?)?,
        )?;
        if length.saturating_add(modes.len() as u64) > COLLECT_CANDIDATE_MAX_BYTES {
            let _ = fs::remove_file(&path);
            return Err(ScanFault::Failed);
        }
        for chunk in modes.chunks(65536) {
            file.write_all(chunk)?;
            digest.update(chunk);
        }
        length += modes.len() as u64;
        file.sync_all()?;
        if self.expired() {
            let _ = fs::remove_file(&path);
            return Err(ScanFault::Failed);
        }
        staged.len = length;
        staged.digest = format!("sha256:{:x}", digest.finalize());
        Ok(CandidateBody(Arc::new(staged)))
    }

    fn verify_named(&self, pair: &SnapshotPair, accepted: bool) -> Result<(), ScanFault> {
        match self.verify_pair(pair) {
            Ok(()) => Ok(()),
            Err(ScanFault::Missing) if accepted => Err(ScanFault::AcceptedBaseUnknown),
            Err(ScanFault::Missing) => Err(ScanFault::SnapshotUnavailable),
            Err(fault) => Err(fault),
        }
    }

    fn verify_scanned(&self, pair: &SnapshotPair) -> Result<(), ScanFault> {
        match self.verify_pair(pair) {
            Err(ScanFault::Missing) => Err(ScanFault::Failed),
            other => other,
        }
    }

    fn verify_pair(&self, pair: &SnapshotPair) -> Result<(), ScanFault> {
        if !is_lowercase_hex(&pair.tree, OBJECT_ID_LEN)
            || !is_lowercase_hex(&pair.manifest, OBJECT_ID_LEN)
        {
            return Err(ScanFault::Malformed);
        }
        if self.object_type(&pair.tree)? != "tree" || self.object_type(&pair.manifest)? != "blob" {
            return Err(ScanFault::Disagreement);
        }
        let manifest = decode_manifest(&self.read_blob(&pair.manifest)?)?;
        let listed = self.ls_tree(&pair.tree)?;
        if manifest.len() != listed.len() {
            return Err(ScanFault::Disagreement);
        }
        for (path, object) in &listed {
            if object.kind == "tree" && !has_child(path, &listed) {
                return Err(ScanFault::Disagreement);
            }
        }
        for (path, mode) in &manifest {
            let Some(object) = listed.get(path) else {
                return Err(ScanFault::Disagreement);
            };
            if !mode_agrees(object, *mode) {
                return Err(ScanFault::Disagreement);
            }
        }
        Ok(())
    }

    fn ensure_layout(&mut self) -> Result<(), ScanFault> {
        create_private_dir(&self.store)?;
        for entry in fs::read_dir(&self.store)? {
            let entry = entry?;
            if entry.file_name().as_bytes().starts_with(b"candidate-") {
                fs::remove_file(entry.path())?;
            }
        }
        self.check_capacity(1024 * 1024, 16)?;
        create_private_dir(&self.git.home)?;
        create_private_dir(&self.git.template)?;
        if !self.git.config.exists() {
            atomic_write(&self.git.config, b"", 0o600)?;
        }
        if !self.git.dir.join("HEAD").is_file() {
            git_bare_init(&self.git, self.deadline_at())?;
        }
        let format = self.git.run(
            &["rev-parse", "--show-object-format"],
            StdinSource::None,
            false,
            64,
            false,
            self.deadline_at(),
        )?;
        if std::str::from_utf8(&format)
            .map_err(|_| ScanFault::Failed)?
            .trim()
            != "sha1"
        {
            return Err(ScanFault::Failed);
        }
        self.git.run(
            &["read-tree", "--empty"],
            StdinSource::None,
            false,
            1024,
            false,
            self.deadline_at(),
        )?;
        Ok(())
    }

    fn protection_pairs(&self) -> Result<BTreeMap<String, SnapshotPair>, ScanFault> {
        let Some(root) = self.read_ref(REF_PROTECTION)? else {
            return Ok(BTreeMap::new());
        };
        let listing = self.git.run(
            &["ls-tree", "-z", &root],
            StdinSource::None,
            false,
            MAX_METADATA_BYTES,
            false,
            self.deadline_at(),
        )?;
        let listed = index_listing(&listing)?;
        let mut pairs = BTreeMap::new();
        for role in ["accepted", "head", "pending", "baseline"] {
            match (
                listed.get(format!("{role}-tree").as_bytes()),
                listed.get(format!("{role}-manifest").as_bytes()),
            ) {
                (None, None) => {}
                (Some(tree), Some(manifest)) if tree.kind == "tree" && manifest.kind == "blob" => {
                    pairs.insert(
                        role.to_string(),
                        SnapshotPair {
                            tree: tree.oid.clone(),
                            manifest: manifest.oid.clone(),
                        },
                    );
                }
                _ => return Err(ScanFault::Failed),
            }
        }
        Ok(pairs)
    }

    fn load_state(&self) -> Result<Option<ChainState>, ScanFault> {
        let pairs = self.protection_pairs()?;
        if pairs.is_empty() || (pairs.len() == 1 && pairs.contains_key("baseline")) {
            return Ok(None);
        }
        let accepted = pairs.get("accepted").ok_or(ScanFault::Failed)?.clone();
        let head = pairs.get("head").ok_or(ScanFault::Failed)?.clone();
        Ok(Some(ChainState {
            accepted,
            head,
            unacknowledged: pairs.get("pending").cloned(),
        }))
    }

    /// One ref atomically selects a complete tree whose children protect all pair objects.
    fn publish_selection(&mut self, pairs: &[(&str, &SnapshotPair)]) -> Result<(), ScanFault> {
        let mut payload = Vec::new();
        for (role, pair) in pairs {
            push_mktree(
                &mut payload,
                "040000",
                "tree",
                &pair.tree,
                format!("{role}-tree").as_bytes(),
            );
            push_mktree(
                &mut payload,
                "100644",
                "blob",
                &pair.manifest,
                format!("{role}-manifest").as_bytes(),
            );
        }
        self.check_capacity(payload.len() as u64 + 65536, 5)?;
        let root = self.git.run(
            &["mktree", "-z"],
            StdinSource::Bytes(payload),
            false,
            128,
            false,
            self.deadline_at(),
        )?;
        let root = parse_oid(&root)?;
        let object_dir = self.git.dir.join("objects").join(&root[..2]);
        sync_publication_file(
            &File::open(object_dir.join(&root[2..]))?,
            "protection-object",
        )?;
        sync_publication_dir(&object_dir, "protection-fanout")?;
        sync_publication_dir(&self.git.dir.join("objects"), "protection-objects")?;
        #[cfg(test)]
        test_boundary("before-ref")?;
        self.git.run(
            &["update-ref", REF_PROTECTION, &root],
            StdinSource::None,
            false,
            4096,
            false,
            self.deadline_at(),
        )?;
        sync_publication_file(&File::open(self.git.dir.join(REF_PROTECTION))?, "ref-file")?;
        sync_publication_dir(&self.git.dir.join("refs/openkit"), "ref-directory")?;
        sync_publication_dir(&self.git.dir.join("refs"), "refs-directory")?;
        sync_publication_dir(&self.git.dir, "git-directory")?;
        Ok(())
    }

    fn publish(
        &mut self,
        accepted: SnapshotPair,
        head: SnapshotPair,
        unacknowledged: Option<SnapshotPair>,
    ) -> Result<(), ScanFault> {
        if self.publish_blocked() {
            return Err(ScanFault::Failed);
        }
        let pending = unacknowledged.filter(|pair| pair != &head);
        if self.selection_current(&accepted, &head, &pending) {
            return Ok(());
        }
        let mut pairs = vec![("accepted", &accepted), ("head", &head)];
        if let Some(pair) = &pending {
            pairs.push(("pending", pair));
        }
        self.publish_selection(&pairs)?;
        self.state = Some(ChainState {
            accepted,
            head,
            unacknowledged: pending,
        });
        Ok(())
    }

    fn begin_attempt(&mut self) -> Result<(), ScanFault> {
        if self.git.attempt.exists() {
            fs::remove_dir_all(&self.git.attempt)?;
        }
        self.check_capacity(16384, 3)?;
        create_private_dir(&self.git.attempt.join("objects"))?;
        self.attempt = true;
        self.attempt_bytes = 0;
        self.clear_attempt_notes();
        Ok(())
    }

    fn promote_loose(&mut self) -> Result<(), ScanFault> {
        let objects = self.git.attempt.join("objects");
        if objects.exists() {
            let (bytes, inodes) = self.physical_usage(&objects)?;
            self.check_capacity(bytes.saturating_add(65536), inodes.saturating_add(2))?;
            copy_loose_objects(
                &objects,
                &self.git.dir.join("objects"),
                self.limits.store_bytes,
            )?;
        }
        Ok(())
    }

    fn remove_attempt(&mut self) -> Result<(), ScanFault> {
        self.before_cleanup();
        let removed = fs::remove_dir_all(&self.git.attempt);
        self.attempt = false;
        match removed {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ScanFault::CleanupFailed),
        }
    }

    fn prune(&mut self) -> Result<(), ScanFault> {
        if self.prune_blocked() {
            return Err(ScanFault::Failed);
        }
        #[cfg(test)]
        test_boundary("before-prune")?;
        let saved = self.attempt;
        self.attempt = false;
        let result = self.git.run(
            &["prune", "--expire=now"],
            StdinSource::None,
            false,
            1024,
            false,
            self.deadline_at(),
        );
        self.attempt = saved;
        result?;
        #[cfg(test)]
        test_boundary("after-prune")?;
        Ok(())
    }

    fn record_context(&self) -> Result<(), ScanFault> {
        let path = self.store.join("head-context");
        match self.head_commit()? {
            Some(commit) => atomic_write(&path, commit.as_bytes(), 0o600),
            None => {
                if path.exists() {
                    fs::remove_file(path)?;
                }
                Ok(())
            }
        }
    }

    fn head_commit(&self) -> Result<Option<String>, ScanFault> {
        let git_fd = match openat_dir(&self.worktree_fd, ".git") {
            Ok(fd) => fd,
            Err(_) => return Ok(None),
        };
        let Ok(bytes) = read_regular_at(&git_fd, "HEAD", MAX_HEAD_BYTES) else {
            return Ok(None);
        };
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Ok(None);
        };
        let text = text.trim();
        if is_lowercase_hex(text, OBJECT_ID_LEN) {
            return Ok(Some(text.to_string()));
        }
        let Some(name) = text.strip_prefix("ref: ") else {
            return Ok(None);
        };
        resolve_git_ref(&git_fd, name, 0)
    }

    fn write_blob(&mut self, bytes: &[u8]) -> Result<String, ScanFault> {
        let oid = self.hash_bytes(bytes)?;
        self.note_object(&oid, "blob");
        Ok(oid)
    }

    fn write_manifest(&mut self, bytes: &[u8]) -> Result<String, ScanFault> {
        if bytes.len() > MAX_METADATA_BYTES {
            return Err(ScanFault::Failed);
        }
        let oid = self.hash_bytes(bytes)?;
        self.note_object(&oid, "manifest");
        Ok(oid)
    }

    fn hash_bytes(&self, bytes: &[u8]) -> Result<String, ScanFault> {
        self.check_capacity(bytes.len() as u64 + 65536, 2)?;
        let stdout = self.git.run(
            &["hash-object", "-w", "--no-filters", "--stdin"],
            StdinSource::Bytes(bytes.to_vec()),
            false,
            128,
            self.attempt,
            self.deadline_at(),
        )?;
        parse_oid(&stdout)
    }

    fn hash_fd(&mut self, fd: OwnedFd, size: i64) -> Result<String, ScanFault> {
        let size = u64::try_from(size).map_err(|_| ScanFault::Failed)?;
        self.charge(size)?;
        self.check_capacity(size.saturating_add(65536), 2)?;
        let mut command = self.git.command(self.attempt);
        command.args(["hash-object", "-w", "--no-filters", "--stdin"]);
        let outcome = capture(
            &mut command,
            StdinSource::File(fd),
            false,
            128,
            size,
            self.deadline_at(),
            None,
        )?;
        let oid = parse_oid(&outcome.stdout)?;
        self.note_object(&oid, "blob");
        Ok(oid)
    }

    fn mktree(&mut self, payload: &[u8]) -> Result<String, ScanFault> {
        if payload.len() > MAX_METADATA_BYTES {
            return Err(ScanFault::Failed);
        }
        self.check_capacity(payload.len() as u64 + 65536, 2)?;
        let stdout = self.git.run(
            &["mktree", "-z"],
            StdinSource::Bytes(payload.to_vec()),
            false,
            128,
            self.attempt,
            self.deadline_at(),
        )?;
        let oid = parse_oid(&stdout)?;
        self.note_object(&oid, "tree");
        Ok(oid)
    }

    fn read_blob(&self, oid: &str) -> Result<Vec<u8>, ScanFault> {
        self.git.run(
            &["cat-file", "blob", oid],
            StdinSource::None,
            false,
            MAX_METADATA_BYTES,
            self.attempt,
            self.deadline_at(),
        )
    }

    fn object_type(&self, oid: &str) -> Result<String, ScanFault> {
        let (code, stdout) = self.git.run_code(
            &["cat-file", "-t", oid],
            StdinSource::None,
            64,
            self.attempt,
            self.deadline_at(),
        )?;
        if code != 0 {
            return Err(ScanFault::Missing);
        }
        let text = String::from_utf8(stdout).map_err(|_| ScanFault::Failed)?;
        Ok(text.trim().to_string())
    }

    fn ls_tree(&self, tree: &str) -> Result<BTreeMap<Vec<u8>, TreeObject>, ScanFault> {
        let (code, stdout) = self.git.run_code(
            &["ls-tree", "-r", "-t", "-z", tree],
            StdinSource::None,
            MAX_METADATA_BYTES,
            self.attempt,
            self.deadline_at(),
        )?;
        if code != 0 {
            return Err(ScanFault::Missing);
        }
        index_listing(&stdout)
    }

    fn read_ref(&self, name: &str) -> Result<Option<String>, ScanFault> {
        let (code, stdout) = self.git.run_code(
            &["rev-parse", "--verify", "--quiet", name],
            StdinSource::None,
            128,
            false,
            self.deadline_at(),
        )?;
        if code == 1 && stdout.is_empty() {
            return Ok(None);
        }
        if code != 0 {
            return Err(ScanFault::Failed);
        }
        Ok(Some(parse_oid(&stdout)?))
    }

    fn selection_current(
        &self,
        accepted: &SnapshotPair,
        head: &SnapshotPair,
        pending: &Option<SnapshotPair>,
    ) -> bool {
        self.state.as_ref().is_some_and(|state| {
            state.accepted == *accepted && state.head == *head && state.unacknowledged == *pending
        })
    }

    /// Measures retained and temporary physical usage; restart cannot reset this bound.
    /// Counts allocated blocks and all directory entries, including restart residue, before growth.
    fn physical_usage(&self, path: &Path) -> Result<(u64, u64), ScanFault> {
        if self.expired() {
            return Err(ScanFault::Failed);
        }
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Err(ScanFault::Failed);
        }
        let mut bytes = metadata.blocks().saturating_mul(512);
        let mut inodes = 1u64;
        if metadata.is_dir() {
            for entry in fs::read_dir(path)? {
                let (child_bytes, child_inodes) = self.physical_usage(&entry?.path())?;
                bytes = bytes.checked_add(child_bytes).ok_or(ScanFault::Failed)?;
                inodes = inodes.checked_add(child_inodes).ok_or(ScanFault::Failed)?;
                if bytes > MAX_STORE_BYTES {
                    return Err(ScanFault::Failed);
                }
            }
        }
        Ok((bytes, inodes))
    }

    fn check_capacity(&self, growth: u64, inodes: u64) -> Result<(), ScanFault> {
        let (used, _) = self.physical_usage(&self.store)?;
        let path =
            CString::new(self.store.as_os_str().as_bytes()).map_err(|_| ScanFault::Failed)?;
        let mut facts = unsafe { std::mem::zeroed::<libc::statvfs>() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut facts) } != 0 {
            return Err(ScanFault::Failed);
        }
        let free = (facts.f_bavail as u64).saturating_mul(facts.f_frsize as u64);
        if used.saturating_add(growth) > self.limits.store_bytes
            || free.saturating_sub(growth) < 64 * 1024 * 1024
            || (facts.f_favail as u64).saturating_sub(inodes) < 1024
        {
            return Err(ScanFault::Failed);
        }
        Ok(())
    }

    fn charge(&mut self, bytes: u64) -> Result<(), ScanFault> {
        if bytes > MAX_STORE_BYTES {
            return Err(ScanFault::Failed);
        }
        if !self.attempt {
            return Ok(());
        }
        let next = self.attempt_bytes.saturating_add(bytes);
        if next > self.limits.source_bytes {
            return Err(ScanFault::Failed);
        }
        self.attempt_bytes = next;
        Ok(())
    }

    fn expired(&self) -> bool {
        std::time::Instant::now() >= self.deadline_at()
    }

    fn deadline_at(&self) -> Instant {
        self.started
            .checked_add(self.limits.deadline)
            .unwrap_or(self.started)
    }

    fn before_file(&mut self) {
        #[cfg(test)]
        if let Some(hook) = self.hooks.before_file_read.as_mut() {
            hook();
        }
    }

    fn before_dir(&mut self) {
        #[cfg(test)]
        if let Some(hook) = self.hooks.before_dir_read.as_mut() {
            hook();
        }
    }

    fn before_cleanup(&mut self) {
        #[cfg(test)]
        if let Some(hook) = self.hooks.before_cleanup.as_mut() {
            hook();
        }
    }

    fn publish_blocked(&mut self) -> bool {
        #[cfg(test)]
        {
            self.hooks.publish_count = self.hooks.publish_count.saturating_add(1);
            if self.hooks.fail_publish_at == Some(self.hooks.publish_count) {
                return true;
            }
        }
        false
    }

    fn prune_blocked(&self) -> bool {
        #[cfg(test)]
        {
            self.hooks.fail_prune
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    fn note_object(&mut self, oid: &str, kind: &'static str) {
        #[cfg(test)]
        if self.attempt {
            self.hooks.attempt_objects.push((oid.to_string(), kind));
        }
        #[cfg(not(test))]
        {
            let _ = (oid, kind);
        }
    }

    fn clear_attempt_notes(&mut self) {
        #[cfg(test)]
        self.hooks.attempt_objects.clear();
    }

    #[cfg(test)]
    fn retain_worktree_as_base(&mut self) -> SnapshotPair {
        // Test-only seeder. Production does not adopt the worktree as an accepted base.
        self.begin_attempt().expect("seed attempt");
        let scan = self.scan().expect("seed scan");
        self.promote_loose().expect("seed promote");
        self.publish(scan.pair.clone(), scan.pair.clone(), None)
            .expect("seed publish");
        self.remove_attempt().expect("seed cleanup");
        self.prune().expect("seed prune");
        scan.pair
    }

    #[cfg(test)]
    fn install_unverified(&mut self, tree: &str, manifest: &[u8]) -> SnapshotPair {
        self.attempt = false;
        let manifest = self.write_blob(manifest).expect("manifest blob");
        let pair = SnapshotPair {
            tree: tree.to_string(),
            manifest,
        };
        self.publish(pair.clone(), pair.clone(), None)
            .expect("install refs");
        pair
    }

    #[cfg(test)]
    fn object_id(&self, bytes: &[u8]) -> String {
        let stdout = self
            .git
            .run(
                &["hash-object", "--no-filters", "--stdin"],
                StdinSource::Bytes(bytes.to_vec()),
                false,
                128,
                false,
                self.deadline_at(),
            )
            .expect("object id");
        parse_oid(&stdout).expect("object id text")
    }

    #[cfg(test)]
    fn object_exists(&self, oid: &str) -> bool {
        self.git
            .run(
                &["cat-file", "-e", oid],
                StdinSource::None,
                false,
                64,
                false,
                std::time::Instant::now() + Duration::from_secs(30),
            )
            .is_ok()
    }
}

impl GitStore {
    fn command(&self, attempt: bool) -> Command {
        let mut command = scrubbed_git(&self.bin, &self.home, &self.config);
        command.env("GIT_DIR", &self.dir);
        command.env("GIT_INDEX_FILE", &self.index);
        command.env("GIT_ATTR_NOSYSTEM", "1");
        if attempt {
            command.env("GIT_OBJECT_DIRECTORY", self.attempt.join("objects"));
            command.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", self.dir.join("objects"));
        }
        apply_config_flags(&mut command, &self.dir);
        command
    }

    fn run(
        &self,
        args: &[&str],
        stdin: StdinSource,
        allow_exit_one: bool,
        max: usize,
        attempt: bool,
        deadline: Instant,
    ) -> Result<Vec<u8>, ScanFault> {
        let (code, stdout) = self.run_code(args, stdin, max, attempt, deadline)?;
        if code == 0 || (allow_exit_one && code == 1) {
            Ok(stdout)
        } else {
            Err(ScanFault::Failed)
        }
    }

    fn run_code(
        &self,
        args: &[&str],
        stdin: StdinSource,
        max: usize,
        attempt: bool,
        deadline: Instant,
    ) -> Result<(i32, Vec<u8>), ScanFault> {
        if std::time::Instant::now() >= deadline {
            return Err(ScanFault::Failed);
        }
        let mut command = self.command(attempt);
        command.args(args);
        let outcome = capture(&mut command, stdin, true, max, u64::MAX, deadline, None)?;
        Ok((outcome.code, outcome.stdout))
    }
}

fn git_bare_init(git: &GitStore, deadline: Instant) -> Result<(), ScanFault> {
    let mut command = scrubbed_git(&git.bin, &git.home, &git.config);
    command
        .arg("init")
        .arg("--bare")
        .arg("--quiet")
        .arg("--object-format=sha1")
        .arg("--template")
        .arg(&git.template)
        .arg(&git.dir);
    let outcome = capture(
        &mut command,
        StdinSource::None,
        false,
        1024,
        u64::MAX,
        deadline,
        None,
    )?;
    if outcome.code == 0 {
        Ok(())
    } else {
        Err(ScanFault::Failed)
    }
}

fn scrubbed_git(bin: &Path, home: &Path, config: &Path) -> Command {
    let mut command = Command::new(bin);
    command.env_clear();
    command.env("HOME", home);
    command.env("GIT_CONFIG_GLOBAL", config);
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    command.env("GIT_CONFIG_COUNT", "0");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.env("GIT_PAGER", "");
    command.env("LC_ALL", "C");
    command.process_group(0);
    command
}

fn apply_config_flags(command: &mut Command, git_dir: &Path) {
    let directory = git_dir.display().to_string();
    for (key, value) in [
        ("core.hooksPath", "/dev/null".to_string()),
        ("core.attributesFile", "/dev/null".to_string()),
        ("core.excludesFile", "/dev/null".to_string()),
        ("core.autocrlf", "false".to_string()),
        ("core.safecrlf", "false".to_string()),
        ("core.symlinks", "true".to_string()),
        ("core.ignorecase", "false".to_string()),
        ("core.precomposeunicode", "false".to_string()),
        ("core.quotePath", "false".to_string()),
        ("core.bare", "false".to_string()),
        ("safe.directory", directory),
    ] {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    command.arg("--no-pager");
}

enum StdinSource {
    None,
    Bytes(Vec<u8>),
    File(OwnedFd),
}

struct CaptureOutcome {
    code: i32,
    stdout: Vec<u8>,
}

type ChunkObserver<'a> = dyn FnMut(&[u8]) -> Result<bool, ScanFault> + 'a;

fn capture(
    command: &mut Command,
    stdin: StdinSource,
    allow_nonzero: bool,
    max_stdout: usize,
    max_stdin: u64,
    deadline: Instant,
    mut on_chunk: Option<&mut ChunkObserver<'_>>,
) -> Result<CaptureOutcome, ScanFault> {
    if std::time::Instant::now() >= deadline {
        return Err(ScanFault::Failed);
    }
    let has_stdin = !matches!(stdin, StdinSource::None);
    command.process_group(0);
    command.stdin(if has_stdin {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped());
    command.stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| ScanFault::Failed)?;
    let pid = child.id();
    let writer = match spawn_writer(has_stdin, &mut child, stdin, max_stdin) {
        Ok(writer) => writer,
        Err(fault) => {
            kill_group(pid);
            let _ = child.wait();
            return Err(fault);
        }
    };
    let read_result = match child.stdout.take() {
        Some(stdout) => read_stdout(stdout, pid, max_stdout, deadline, &mut on_chunk),
        None => Err(ScanFault::Failed),
    };
    if read_result.is_err() {
        kill_group(pid);
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) if writer.as_ref().is_none_or(|writer| writer.is_finished()) => {
                break status;
            }
            Ok(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            _ => {
                kill_group(pid);
                let _ = child.wait();
                let _ = join_writer(writer);
                return Err(ScanFault::Failed);
            }
        }
    };
    let write_result = join_writer(writer);
    let outcome = read_result?;
    if outcome.halted {
        return Ok(CaptureOutcome {
            code: status.code().unwrap_or(0),
            stdout: outcome.stdout,
        });
    }
    write_result?;
    let code = status.code().ok_or(ScanFault::Failed)?;
    if code == 0 || allow_nonzero {
        Ok(CaptureOutcome {
            code,
            stdout: outcome.stdout,
        })
    } else {
        Err(ScanFault::Failed)
    }
}

fn spawn_writer(
    has_stdin: bool,
    child: &mut Child,
    stdin: StdinSource,
    max_stdin: u64,
) -> Result<Option<thread::JoinHandle<Result<(), ()>>>, ScanFault> {
    if !has_stdin {
        return Ok(None);
    }
    let input = child.stdin.take().ok_or(ScanFault::Failed)?;
    Ok(Some(thread::spawn(move || {
        write_stdin(input, stdin, max_stdin)
    })))
}

fn write_stdin(mut input: impl Write, source: StdinSource, limit: u64) -> Result<(), ()> {
    match source {
        StdinSource::None => Ok(()),
        StdinSource::Bytes(bytes) => {
            if bytes.len() as u64 > limit {
                return Err(());
            }
            input.write_all(&bytes).map_err(|_| ())
        }
        StdinSource::File(fd) => {
            let mut file = File::from(fd);
            let mut buf = [0u8; 65_536];
            let mut total = 0u64;
            loop {
                let read = file.read(&mut buf).map_err(|_| ())?;
                if read == 0 {
                    break;
                }
                total = total.saturating_add(read as u64);
                if total > limit {
                    return Err(());
                }
                input.write_all(&buf[..read]).map_err(|_| ())?;
            }
            Ok(())
        }
    }
}

struct ReadOutcome {
    stdout: Vec<u8>,
    halted: bool,
}

fn read_stdout(
    mut stdout: impl Read + AsRawFd,
    pid: u32,
    max_stdout: usize,
    deadline: Instant,
    on_chunk: &mut Option<&mut ChunkObserver<'_>>,
) -> Result<ReadOutcome, ScanFault> {
    set_nonblocking(stdout.as_raw_fd()).map_err(|_| ScanFault::Failed)?;
    let mut buf = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 65_536];
    loop {
        if std::time::Instant::now() >= deadline {
            kill_group(pid);
            return Err(ScanFault::Failed);
        }
        let Some(timeout) = poll_timeout(deadline) else {
            kill_group(pid);
            return Err(ScanFault::Failed);
        };
        let mut polled = libc::pollfd {
            fd: stdout.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut polled, 1, timeout) };
        if ready < 0 {
            if errno_value() == libc::EINTR {
                continue;
            }
            kill_group(pid);
            return Err(ScanFault::Failed);
        }
        if ready == 0 {
            continue;
        }
        match stdout.read(&mut chunk) {
            Ok(0) => {
                return Ok(ReadOutcome {
                    stdout: buf,
                    halted: false,
                });
            }
            Ok(read) => {
                total = total.saturating_add(read);
                if total > max_stdout {
                    kill_group(pid);
                    return Err(ScanFault::Failed);
                }
                let bytes = &chunk[..read];
                if let Some(callback) = on_chunk.as_mut() {
                    match callback(bytes) {
                        Ok(true) => {}
                        Ok(false) => {
                            kill_group(pid);
                            return Ok(ReadOutcome {
                                stdout: buf,
                                halted: true,
                            });
                        }
                        Err(fault) => {
                            kill_group(pid);
                            return Err(fault);
                        }
                    }
                }
                if on_chunk.is_none() {
                    buf.extend_from_slice(bytes);
                }
            }
            Err(error)
                if error.kind() == ErrorKind::WouldBlock
                    || error.kind() == ErrorKind::Interrupted => {}
            Err(_) => {
                kill_group(pid);
                return Err(ScanFault::Failed);
            }
        }
    }
}

fn poll_timeout(deadline: Instant) -> Option<i32> {
    let now = std::time::Instant::now();
    if now >= deadline {
        return None;
    }
    let millis = deadline.saturating_duration_since(now).as_millis();
    Some(i32::try_from(millis).unwrap_or(i32::MAX).max(1))
}

fn kill_group(pid: u32) {
    if pid == 0 {
        return;
    }
    unsafe {
        libc::kill(-i32::try_from(pid).unwrap_or(i32::MAX), libc::SIGKILL);
    }
}

fn join_writer(writer: Option<thread::JoinHandle<Result<(), ()>>>) -> Result<(), ScanFault> {
    let Some(writer) = writer else {
        return Ok(());
    };
    match writer.join() {
        Ok(Ok(())) => Ok(()),
        _ => Err(ScanFault::Failed),
    }
}

fn set_nonblocking(fd: i32) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let updated = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if updated < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

const OPEN_DIR: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
const OPEN_FILE: i32 = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;

#[cfg(test)]
fn open_nofollow_dir(path: &Path) -> std::io::Result<OwnedFd> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))?;
    let fd = unsafe { libc::open(c_path.as_ptr(), OPEN_DIR) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn openat_dir(dir: &OwnedFd, name: impl AsRef<OsStr>) -> std::io::Result<OwnedFd> {
    openat_flags(dir, name.as_ref(), OPEN_DIR)
}

fn openat_file(dir: &OwnedFd, name: impl AsRef<OsStr>) -> std::io::Result<OwnedFd> {
    openat_flags(dir, name.as_ref(), OPEN_FILE)
}

fn openat_flags(dir: &OwnedFd, name: &OsStr, flags: i32) -> std::io::Result<OwnedFd> {
    let c_name =
        CString::new(name.as_bytes()).map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))?;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Bounds raw listing by real-entry count and each root-relative name allowance, independently of admitted metadata.
fn read_dir_names(
    dir: &OwnedFd,
    max_entries: usize,
    max_name_bytes: usize,
) -> Result<Vec<OsString>, ScanFault> {
    // A fresh open file description starts at offset zero. dup shares the offset, so a second scan would see an empty directory.
    let duplicated = openat_dir(dir, ".").map_err(|_| ScanFault::MetadataUnavailable)?;
    let raw = duplicated.into_raw_fd();
    let handle = unsafe { libc::fdopendir(raw) };
    if handle.is_null() {
        unsafe { libc::close(raw) };
        return Err(ScanFault::MetadataUnavailable);
    }
    let mut names = Vec::new();
    loop {
        clear_errno();
        let entry = unsafe { libc::readdir(handle) };
        if entry.is_null() {
            let error = errno_value();
            unsafe { libc::closedir(handle) };
            if error != 0 {
                return Err(ScanFault::MetadataUnavailable);
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        if names.len() >= max_entries || name.to_bytes().len() > max_name_bytes {
            unsafe { libc::closedir(handle) };
            return Err(ScanFault::Failed);
        }
        names.push(OsString::from_vec(name.to_bytes().to_vec()));
    }
    Ok(names)
}

fn fstatat_nofollow(dir: &OwnedFd, name: &OsStr) -> std::io::Result<libc::stat> {
    let c_name =
        CString::new(name.as_bytes()).map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))?;
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    let result = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            c_name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(stat)
}

fn fstat(fd: &OwnedFd) -> std::io::Result<libc::stat> {
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    let result = unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(stat)
}

fn read_link_at(dir: &OwnedFd, name: &OsStr) -> Result<Vec<u8>, ScanFault> {
    let c_name = CString::new(name.as_bytes()).map_err(|_| ScanFault::UnsafePath)?;
    let mut buffer = vec![0u8; MAX_PATH_BYTES + 1];
    let read = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            c_name.as_ptr(),
            buffer.as_mut_ptr().cast::<libc::c_char>(),
            buffer.len(),
        )
    };
    if read < 0 {
        return Err(ScanFault::MetadataUnavailable);
    }
    let read = usize::try_from(read).map_err(|_| ScanFault::Failed)?;
    if read >= buffer.len() {
        return Err(ScanFault::Failed);
    }
    buffer.truncate(read);
    Ok(buffer)
}

/// Reads one bounded regular file without following symbolic links.
fn read_regular_at(dir: &OwnedFd, name: &str, cap: usize) -> Result<Option<Vec<u8>>, ScanFault> {
    let stat = match fstatat_nofollow(dir, OsStr::new(name)) {
        Ok(stat) => stat,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ScanFault::MetadataUnavailable),
    };
    if file_kind(stat.st_mode) != libc::S_IFREG {
        return Ok(None);
    }
    if stat.st_size < 0 || u64::try_from(stat.st_size).unwrap_or(u64::MAX) > cap as u64 {
        return Err(ScanFault::Failed);
    }
    let fd = openat_file(dir, name).map_err(|_| ScanFault::MetadataUnavailable)?;
    let opened = fstat(&fd).map_err(|_| ScanFault::MetadataUnavailable)?;
    if entry_kind(opened.st_mode) != EntryKind::File || !same_file(&stat, &opened) {
        return Err(ScanFault::Failed);
    }
    let mut file = File::from(fd).take(cap as u64 + 1);
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|_| ScanFault::MetadataUnavailable)?;
    if buf.len() > cap {
        return Err(ScanFault::Failed);
    }
    Ok(Some(buf))
}

fn same_file(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

/// Extracts the file-kind mask in the platform's native mode type.
fn file_kind(mode: libc::mode_t) -> libc::mode_t {
    mode & libc::S_IFMT
}

/// Classifies the native file-kind mask without changing its integer width.
fn entry_kind(mode: libc::mode_t) -> EntryKind {
    match file_kind(mode) {
        value if value == libc::S_IFREG => EntryKind::File,
        value if value == libc::S_IFDIR => EntryKind::Dir,
        value if value == libc::S_IFLNK => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}

/// Extracts supported permission bits into the manifest's fixed integer width.
fn perm_bits(mode: libc::mode_t) -> u32 {
    // mode_t is u16 on macOS and u32 on Linux; the return type fixes the manifest width.
    (mode & 0o7777) as _
}

#[cfg(target_os = "macos")]
fn clear_errno() {
    unsafe { *libc::__error() = 0 }
}

#[cfg(target_os = "linux")]
fn clear_errno() {
    unsafe { *libc::__errno_location() = 0 }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clear_errno() {}

#[cfg(target_os = "macos")]
fn errno_value() -> i32 {
    unsafe { *libc::__error() }
}

#[cfg(target_os = "linux")]
fn errno_value() -> i32 {
    unsafe { *libc::__errno_location() }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn errno_value() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn create_private_dir(path: &Path) -> Result<(), ScanFault> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    Ok(())
}

fn fsync_dir(path: &Path) -> Result<(), ScanFault> {
    let file = File::open(path)?;
    file.sync_all()?;
    Ok(())
}

/// Keeps syscall failure injection at the same operation callers must execute.
fn sync_publication_file(file: &File, label: &'static str) -> Result<(), ScanFault> {
    #[cfg(test)]
    test_boundary(label)?;
    #[cfg(not(test))]
    let _ = label;
    file.sync_all()?;
    Ok(())
}

/// Tests publication directory failures through the actual mandatory call site.
fn sync_publication_dir(path: &Path, label: &'static str) -> Result<(), ScanFault> {
    #[cfg(test)]
    test_boundary(label)?;
    #[cfg(not(test))]
    let _ = label;
    fsync_dir(path)
}

fn copy_loose_objects(from: &Path, to: &Path, cap: u64) -> Result<(), ScanFault> {
    create_private_dir(to)?;
    let mut copied = 0u64;
    let entries = fs::read_dir(from)?;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_bytes = name.as_bytes();
        if name_bytes == b"info" || name_bytes == b"pack" {
            continue;
        }
        if symlink_path(&entry.path()) {
            return Err(ScanFault::Failed);
        }
        let fanout = to.join(&name);
        create_private_dir(&fanout)?;
        let files = fs::read_dir(entry.path())?;
        for file in files {
            let file = file?;
            if symlink_path(&file.path()) {
                return Err(ScanFault::Failed);
            }
            let dest = fanout.join(file.file_name());
            if dest.exists() {
                let mut source = File::open(file.path())?;
                let mut retained = File::open(&dest)?;
                let mut left = [0u8; 65536];
                let mut right = [0u8; 65536];
                loop {
                    let n = source.read(&mut left)?;
                    retained.read_exact(&mut right[..n])?;
                    if left[..n] != right[..n] {
                        return Err(ScanFault::Failed);
                    }
                    if n == 0 {
                        if retained.read(&mut right[..1])? != 0 {
                            return Err(ScanFault::Failed);
                        }
                        break;
                    }
                }
                continue;
            }
            let len = file.metadata()?.len();
            copied = copied.saturating_add(len);
            if copied > cap {
                return Err(ScanFault::Failed);
            }
            let temporary = dest.with_extension("partial");
            if temporary.exists() {
                fs::remove_file(&temporary)?;
            }
            let copied = copy_fsync(&file.path(), &temporary).and_then(|()| {
                fs::rename(&temporary, &dest)?;
                fsync_dir(&fanout)
            });
            if copied.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            copied?;
        }
        sync_publication_dir(&fanout, "object-directory")?;
    }
    fsync_dir(to)?;
    Ok(())
}

fn symlink_path(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

fn copy_fsync(from: &Path, to: &Path) -> Result<(), ScanFault> {
    let mut input = File::open(from)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o444)
        .open(to)?;
    let mut buf = [0u8; 65_536];
    loop {
        let read = input.read(&mut buf)?;
        if read == 0 {
            break;
        }
        output.write_all(&buf[..read])?;
        #[cfg(test)]
        test_boundary("copy-mid")?;
    }
    sync_publication_file(&output, "object-file")?;
    Ok(())
}

fn tracked_directories(tracked: &BTreeSet<Vec<u8>>) -> BTreeSet<Vec<u8>> {
    let mut dirs = BTreeSet::new();
    for path in tracked {
        dirs.insert(path.clone());
        for prefix in parent_prefixes(path) {
            dirs.insert(prefix);
        }
    }
    dirs
}

fn child_rel(parent: &[u8], name: &[u8]) -> Vec<u8> {
    let mut rel = parent.to_vec();
    if !rel.is_empty() {
        rel.push(b'/');
    }
    rel.extend_from_slice(name);
    rel
}

#[derive(Default)]
struct WalkBudget {
    entries: usize,
    ignore_bytes: usize,
}

/// Shared bounded scan state for one descriptor-relative directory walk.
struct WalkState<'a> {
    use_ignore: bool,
    tracked: &'a BTreeSet<Vec<u8>>,
    tracked_dirs: &'a BTreeSet<Vec<u8>>,
    ignored: &'a mut BTreeSet<Vec<u8>>,
    out: &'a mut Vec<KeptEntry>,
    budget: &'a mut WalkBudget,
}

fn keep_directories(entries: Vec<KeptEntry>) -> Vec<KeptEntry> {
    let mut parents = BTreeSet::new();
    for entry in &entries {
        if entry.kind != EntryKind::Dir {
            parents.extend(parent_prefixes(&entry.rel));
        }
    }
    let mut kept = entries
        .into_iter()
        .filter(|entry| entry.kind != EntryKind::Dir || parents.contains(&entry.rel))
        .collect::<Vec<_>>();
    kept.sort_by(|left, right| left.rel.cmp(&right.rel));
    kept
}

fn append_tree_row(
    payload: &mut Vec<u8>,
    entry: &KeptEntry,
    tree_ids: &BTreeMap<Vec<u8>, String>,
) -> Result<(), ScanFault> {
    let name = file_name(&entry.rel);
    match entry.kind {
        EntryKind::Dir => {
            let id = tree_ids.get(&entry.rel).ok_or(ScanFault::Failed)?;
            push_mktree(payload, "040000", "tree", id, name);
        }
        EntryKind::File => {
            let mode = if entry.full_mode & 0o111 == 0 {
                "100644"
            } else {
                "100755"
            };
            let id = entry.blob.as_deref().ok_or(ScanFault::Failed)?;
            push_mktree(payload, mode, "blob", id, name);
        }
        EntryKind::Symlink => {
            let id = entry.blob.as_deref().ok_or(ScanFault::Failed)?;
            push_mktree(payload, "120000", "blob", id, name);
        }
        EntryKind::Other => return Err(ScanFault::Failed),
    }
    Ok(())
}

/// Selects blobs whose content can be emitted by Git, including same-oid type replacements.
fn changed_blob_ids(
    scan: &BTreeMap<Vec<u8>, TreeObject>,
    cursor: &BTreeMap<Vec<u8>, TreeObject>,
) -> Vec<String> {
    scan.iter()
        .filter(|&(path, entry)| {
            entry.kind == "blob" && snapshot_differs(cursor.get(path), Some(entry))
        })
        .map(|(_, entry)| entry.oid.clone())
        .collect()
}

fn manifest_ids(first: &Scan, second: &Scan, command: &CollectCommand) -> Vec<String> {
    vec![
        first.pair.manifest.clone(),
        second.pair.manifest.clone(),
        command.previous_head.manifest.clone(),
        command.accepted_base.manifest.clone(),
    ]
}

/// Content-bearing differences exclude executable-bit-only changes, but Git emits both sides of symlink type changes.
fn snapshot_differs(left: Option<&TreeObject>, right: Option<&TreeObject>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.oid != right.oid
                || left.kind != right.kind
                || (left.mode != right.mode && (left.mode == "120000" || right.mode == "120000"))
        }
        (Some(_), None) | (None, Some(_)) => true,
        (None, None) => false,
    }
}

struct SecretChecker {
    needles: Vec<Vec<u8>>,
    digests: [[u8; 32]; 2],
    overlap: usize,
    tail: Vec<u8>,
    run: Vec<u8>,
    hit: bool,
}

impl SecretChecker {
    fn new(values: &[String], digests: &[String; 2]) -> Self {
        let needles = values
            .iter()
            .map(|value| value.as_bytes().to_vec())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let longest = needles.iter().map(Vec::len).max().unwrap_or(0);
        let overlap = longest.max(LOOPBACK_WINDOW_BYTES).saturating_sub(1);
        Self {
            needles,
            digests: [decode_hex32(&digests[0]), decode_hex32(&digests[1])],
            overlap,
            tail: Vec::new(),
            run: Vec::new(),
            hit: false,
        }
    }

    fn begin_blob(&mut self) {
        self.tail.clear();
        self.run.clear();
    }

    fn push(&mut self, chunk: &[u8]) {
        if self.hit || chunk.is_empty() {
            return;
        }
        self.push_literals(chunk);
        if self.hit {
            return;
        }
        for &byte in chunk {
            if is_base64url(byte) {
                self.push_base64(byte);
                if self.hit {
                    return;
                }
            } else {
                self.run.clear();
            }
        }
    }

    fn push_literals(&mut self, chunk: &[u8]) {
        if self.needles.is_empty() {
            return;
        }
        let mut window = std::mem::take(&mut self.tail);
        window.extend_from_slice(chunk);
        for needle in &self.needles {
            if needle.len() <= window.len()
                && window
                    .windows(needle.len())
                    .any(|item| item == needle.as_slice())
            {
                self.hit = true;
                return;
            }
        }
        let keep = self.overlap.min(window.len());
        self.tail = window[window.len() - keep..].to_vec();
    }

    fn push_base64(&mut self, byte: u8) {
        self.run.push(byte);
        if self.run.len() < LOOPBACK_WINDOW_BYTES {
            return;
        }
        let start = self.run.len() - LOOPBACK_WINDOW_BYTES;
        let digest = Sha256::digest(&self.run[start..]);
        if self
            .digests
            .iter()
            .any(|expected| expected.as_slice() == digest.as_slice())
        {
            self.hit = true;
            return;
        }
        let keep = LOOPBACK_WINDOW_BYTES - 1;
        if self.run.len() > keep {
            self.run.drain(0..self.run.len() - keep);
        }
    }

    fn finish(&mut self) -> bool {
        self.hit
    }
}

fn decode_hex32(value: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return out;
    }
    for index in 0..32 {
        let high = hex_value(bytes[index * 2]);
        let low = hex_value(bytes[index * 2 + 1]);
        out[index] = (high << 4) | low;
    }
    out
}

fn hex_value(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => 0,
    }
}

fn append_mode_records(
    body: &mut Vec<u8>,
    base: &[(Vec<u8>, u32)],
    head: &[(Vec<u8>, u32)],
) -> Result<(), ScanFault> {
    let base_modes = base
        .iter()
        .map(|(path, mode)| (path.clone(), *mode))
        .collect::<BTreeMap<_, _>>();
    let mut records = Vec::new();
    for (path, mode) in head {
        match base_modes.get(path) {
            None => records.push((None, *mode, path.clone())),
            Some(previous) if *previous != *mode => {
                records.push((Some(*previous), *mode, path.clone()))
            }
            Some(_) => {}
        }
    }
    if records.is_empty() {
        return Ok(());
    }
    body.extend_from_slice(b"openkit-full-mode-delta\n");
    for (previous, mode, path) in records {
        match previous {
            Some(mode) => body.extend_from_slice(format!("{mode:04o}").as_bytes()),
            None => body.extend_from_slice(b"----"),
        }
        body.push(b' ');
        body.extend_from_slice(format!("{mode:04o}").as_bytes());
        body.push(b' ');
        body.extend_from_slice(path.len().to_string().as_bytes());
        body.push(b' ');
        body.extend_from_slice(&path);
        body.push(b'\n');
    }
    Ok(())
}

fn index_listing(stdout: &[u8]) -> Result<BTreeMap<Vec<u8>, TreeObject>, ScanFault> {
    let mut listed = BTreeMap::new();
    for record in stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or(ScanFault::Malformed)?;
        let header = std::str::from_utf8(&record[..tab]).map_err(|_| ScanFault::Malformed)?;
        let mut parts = header.split(' ');
        let mode = parts.next().ok_or(ScanFault::Malformed)?.to_string();
        let kind = parts.next().ok_or(ScanFault::Malformed)?.to_string();
        let oid = parts.next().ok_or(ScanFault::Malformed)?;
        if parts.next().is_some() || !is_lowercase_hex(oid, OBJECT_ID_LEN) {
            return Err(ScanFault::Malformed);
        }
        let path = record[tab + 1..].to_vec();
        if listed.contains_key(&path) {
            return Err(ScanFault::Disagreement);
        }
        listed.insert(
            path,
            TreeObject {
                mode,
                kind,
                oid: oid.to_string(),
            },
        );
    }
    Ok(listed)
}

fn has_child(path: &[u8], listed: &BTreeMap<Vec<u8>, TreeObject>) -> bool {
    let mut prefix = path.to_vec();
    prefix.push(b'/');
    listed.keys().any(|other| other.starts_with(&prefix))
}

fn mode_agrees(object: &TreeObject, mode: u32) -> bool {
    match (object.mode.as_str(), object.kind.as_str()) {
        ("040000", "tree") => true,
        ("120000", "blob") => true,
        ("100644", "blob") => mode & 0o111 == 0,
        ("100755", "blob") => mode & 0o111 != 0,
        _ => false,
    }
}

fn resolve_git_ref(
    git_fd: &OwnedFd,
    name: &str,
    depth: usize,
) -> Result<Option<String>, ScanFault> {
    if depth >= 8 || !safe_ref_name(name) {
        return Ok(None);
    }
    match read_rel_file(git_fd, name, MAX_HEAD_BYTES) {
        Ok(bytes) => interpret_ref(git_fd, &bytes, depth),
        Err(ScanFault::Missing) => packed_ref(git_fd, name),
        Err(_) => Ok(None),
    }
}

fn interpret_ref(
    git_fd: &OwnedFd,
    bytes: &[u8],
    depth: usize,
) -> Result<Option<String>, ScanFault> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Ok(None);
    };
    let text = text.trim();
    if is_lowercase_hex(text, OBJECT_ID_LEN) {
        return Ok(Some(text.to_string()));
    }
    if let Some(name) = text.strip_prefix("ref: ") {
        return resolve_git_ref(git_fd, name, depth + 1);
    }
    Ok(None)
}

fn packed_ref(git_fd: &OwnedFd, name: &str) -> Result<Option<String>, ScanFault> {
    let Ok(Some(bytes)) = read_regular_at(git_fd, "packed-refs", 1024 * 1024) else {
        return Ok(None);
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(None);
    };
    for line in text.lines() {
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let Some((oid, ref_name)) = line.split_once(' ') else {
            continue;
        };
        if ref_name == name && is_lowercase_hex(oid, OBJECT_ID_LEN) {
            return Ok(Some(oid.to_string()));
        }
    }
    Ok(None)
}

fn safe_ref_name(name: &str) -> bool {
    if !name.starts_with("refs/") || name.ends_with('/') || name.contains('\0') {
        return false;
    }
    name.split('/')
        .all(|part| !unsafe_component(part.as_bytes()))
}

fn read_rel_file(dir: &OwnedFd, rel: &str, cap: usize) -> Result<Vec<u8>, ScanFault> {
    let parts = rel.split('/').collect::<Vec<_>>();
    if parts.is_empty() {
        return Err(ScanFault::Missing);
    }
    let mut current = dir.try_clone().map_err(|_| ScanFault::Failed)?;
    for (index, part) in parts.iter().enumerate() {
        if unsafe_component(part.as_bytes()) {
            return Err(ScanFault::Failed);
        }
        if index + 1 == parts.len() {
            return read_regular_at(&current, part, cap)?.ok_or(ScanFault::Missing);
        }
        current = openat_dir(&current, part).map_err(|_| ScanFault::Missing)?;
    }
    Err(ScanFault::Missing)
}

fn map_fault(request_id: &str, fault: ScanFault) -> WorkspaceCollectDelivery {
    let cause = match fault {
        ScanFault::UnsafePath => "unsafe_path",
        ScanFault::Malformed => "malformed_manifest",
        ScanFault::Disagreement => "tree_manifest_disagreement",
        ScanFault::MetadataUnavailable => "metadata_unavailable",
        ScanFault::AcceptedBaseUnknown => "accepted_base_unknown",
        ScanFault::SnapshotUnavailable => "snapshot_unavailable",
        ScanFault::Missing | ScanFault::CleanupFailed | ScanFault::Failed => {
            return effect_failed(request_id);
        }
    };
    recovery_required(request_id, cause)
}

const COMMAND_INVALID: &str = "workspace.collect command invalid";

/// Bounds all containers, including extensions, before a recursive parser runs.
fn validate_json_depth(body: &[u8]) -> Result<(), &'static str> {
    let mut depth = 0usize;
    let mut string = false;
    let mut escaped = false;
    for &byte in body {
        if string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                string = false;
            }
        } else {
            match byte {
                b'"' => string = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 128 {
                        return Err(COMMAND_INVALID);
                    }
                }
                b'}' | b']' => {
                    depth = depth.checked_sub(1).ok_or(COMMAND_INVALID)?;
                }
                _ => {}
            }
        }
    }
    if string || depth != 0 {
        return Err(COMMAND_INVALID);
    }
    Ok(())
}

fn reject_duplicate_core_members(body: &[u8]) -> Result<(), &'static str> {
    let mut cursor = 0;
    skip_ws(body, &mut cursor)?;
    if cursor >= body.len() {
        return Err(COMMAND_INVALID);
    }
    scan_json(body, &mut cursor, 1)?;
    skip_ws(body, &mut cursor)?;
    if cursor != body.len() {
        return Err(COMMAND_INVALID);
    }
    Ok(())
}

fn scan_json(body: &[u8], cursor: &mut usize, schema: u8) -> Result<(), &'static str> {
    let byte = *body.get(*cursor).ok_or(COMMAND_INVALID)?;
    match byte {
        b'{' => scan_object(body, cursor, schema),
        b'[' => scan_array(body, cursor),
        b'"' => scan_string(body, cursor).map(|_| ()),
        b't' => scan_literal(body, cursor, b"true"),
        b'f' => scan_literal(body, cursor, b"false"),
        b'n' => scan_literal(body, cursor, b"null"),
        b'-' | b'0'..=b'9' => scan_number(body, cursor),
        _ => Err(COMMAND_INVALID),
    }
}

fn scan_object(body: &[u8], cursor: &mut usize, schema: u8) -> Result<(), &'static str> {
    expect_byte(body, cursor, b'{')?;
    skip_ws(body, cursor)?;
    if body.get(*cursor) == Some(&b'}') {
        *cursor += 1;
        return Ok(());
    }
    let mut seen = BTreeSet::new();
    loop {
        skip_ws(body, cursor)?;
        let key = scan_string(body, cursor)?;
        skip_ws(body, cursor)?;
        expect_byte(body, cursor, b':')?;
        skip_ws(body, cursor)?;
        let core = match schema {
            1 => CORE_MEMBERS,
            2 => &["tree", "manifest"],
            3 => &["runtimeEnv", "loopbackDigests"],
            _ => &[],
        };
        let child_schema = match (schema, key.as_str()) {
            (1, "acceptedBase" | "previousHead") => 2,
            (1, "checkValues") => 3,
            _ => 0,
        };
        if core.contains(&key.as_str()) && !seen.insert(key) {
            return Err(COMMAND_INVALID);
        }
        scan_json(body, cursor, child_schema)?;
        skip_ws(body, cursor)?;
        match body.get(*cursor) {
            Some(b',') => *cursor += 1,
            Some(b'}') => {
                *cursor += 1;
                return Ok(());
            }
            _ => return Err(COMMAND_INVALID),
        }
    }
}

fn scan_array(body: &[u8], cursor: &mut usize) -> Result<(), &'static str> {
    expect_byte(body, cursor, b'[')?;
    skip_ws(body, cursor)?;
    if body.get(*cursor) == Some(&b']') {
        *cursor += 1;
        return Ok(());
    }
    loop {
        skip_ws(body, cursor)?;
        scan_json(body, cursor, 0)?;
        skip_ws(body, cursor)?;
        match body.get(*cursor) {
            Some(b',') => *cursor += 1,
            Some(b']') => {
                *cursor += 1;
                return Ok(());
            }
            _ => return Err(COMMAND_INVALID),
        }
    }
}

fn scan_string(body: &[u8], cursor: &mut usize) -> Result<String, &'static str> {
    expect_byte(body, cursor, b'"')?;
    let mut out = String::new();
    while *cursor < body.len() {
        let byte = body[*cursor];
        match byte {
            b'"' => {
                *cursor += 1;
                return Ok(out);
            }
            b'\\' => {
                *cursor += 1;
                push_escape(body, cursor, &mut out)?;
            }
            0x00..=0x1F => return Err(COMMAND_INVALID),
            _ => push_utf8(body, cursor, &mut out)?,
        }
    }
    Err(COMMAND_INVALID)
}

fn push_escape(body: &[u8], cursor: &mut usize, out: &mut String) -> Result<(), &'static str> {
    let escaped = *body.get(*cursor).ok_or(COMMAND_INVALID)?;
    *cursor += 1;
    match escaped {
        b'"' | b'\\' | b'/' => out.push(escaped as char),
        b'b' => out.push('\u{0008}'),
        b'f' => out.push('\u{000c}'),
        b'n' => out.push('\n'),
        b'r' => out.push('\r'),
        b't' => out.push('\t'),
        b'u' => push_unicode(body, cursor, out)?,
        _ => return Err(COMMAND_INVALID),
    }
    Ok(())
}

fn push_unicode(body: &[u8], cursor: &mut usize, out: &mut String) -> Result<(), &'static str> {
    let unit = hex4(body, cursor)?;
    if (0xD800..=0xDBFF).contains(&unit) {
        if body.get(*cursor) != Some(&b'\\') || body.get(*cursor + 1) != Some(&b'u') {
            return Err(COMMAND_INVALID);
        }
        *cursor += 2;
        let low = hex4(body, cursor)?;
        if !(0xDC00..=0xDFFF).contains(&low) {
            return Err(COMMAND_INVALID);
        }
        let point = 0x10000 + (((unit as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
        out.push(char::from_u32(point).ok_or(COMMAND_INVALID)?);
    } else if (0xDC00..=0xDFFF).contains(&unit) {
        return Err(COMMAND_INVALID);
    } else {
        out.push(char::from_u32(unit as u32).ok_or(COMMAND_INVALID)?);
    }
    Ok(())
}

fn hex4(body: &[u8], cursor: &mut usize) -> Result<u16, &'static str> {
    if *cursor + 4 > body.len() {
        return Err(COMMAND_INVALID);
    }
    let text = std::str::from_utf8(&body[*cursor..*cursor + 4]).map_err(|_| COMMAND_INVALID)?;
    *cursor += 4;
    u16::from_str_radix(text, 16).map_err(|_| COMMAND_INVALID)
}

fn push_utf8(body: &[u8], cursor: &mut usize, out: &mut String) -> Result<(), &'static str> {
    let width = utf8_width(*body.get(*cursor).ok_or(COMMAND_INVALID)?).ok_or(COMMAND_INVALID)?;
    if *cursor + width > body.len() {
        return Err(COMMAND_INVALID);
    }
    let text = std::str::from_utf8(&body[*cursor..*cursor + width]).map_err(|_| COMMAND_INVALID)?;
    out.push_str(text);
    *cursor += width;
    Ok(())
}

fn utf8_width(byte: u8) -> Option<usize> {
    if byte < 0x80 {
        Some(1)
    } else if (0xC2..=0xDF).contains(&byte) {
        Some(2)
    } else if (0xE0..=0xEF).contains(&byte) {
        Some(3)
    } else if (0xF0..=0xF4).contains(&byte) {
        Some(4)
    } else {
        None
    }
}

fn scan_literal(body: &[u8], cursor: &mut usize, literal: &[u8]) -> Result<(), &'static str> {
    if body
        .get(*cursor..)
        .is_some_and(|rest| rest.starts_with(literal))
    {
        *cursor += literal.len();
        Ok(())
    } else {
        Err(COMMAND_INVALID)
    }
}

fn scan_number(body: &[u8], cursor: &mut usize) -> Result<(), &'static str> {
    if body.get(*cursor) == Some(&b'-') {
        *cursor += 1;
    }
    let start = *cursor;
    while body.get(*cursor).is_some_and(|byte| byte.is_ascii_digit()) {
        *cursor += 1;
    }
    if *cursor == start {
        return Err(COMMAND_INVALID);
    }
    if body.get(*cursor) == Some(&b'.') {
        *cursor += 1;
        let fraction = *cursor;
        while body.get(*cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            *cursor += 1;
        }
        if *cursor == fraction {
            return Err(COMMAND_INVALID);
        }
    }
    if matches!(body.get(*cursor), Some(b'e' | b'E')) {
        *cursor += 1;
        if matches!(body.get(*cursor), Some(b'+' | b'-')) {
            *cursor += 1;
        }
        let exponent = *cursor;
        while body.get(*cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            *cursor += 1;
        }
        if *cursor == exponent {
            return Err(COMMAND_INVALID);
        }
    }
    Ok(())
}

fn expect_byte(body: &[u8], cursor: &mut usize, expected: u8) -> Result<(), &'static str> {
    if body.get(*cursor) == Some(&expected) {
        *cursor += 1;
        Ok(())
    } else {
        Err(COMMAND_INVALID)
    }
}

fn skip_ws(body: &[u8], cursor: &mut usize) -> Result<(), &'static str> {
    while body
        .get(*cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
    {
        *cursor += 1;
    }
    Ok(())
}

fn encode_manifest(entries: &[KeptEntry]) -> Vec<u8> {
    let mut records = entries
        .iter()
        .filter(|entry| entry.kind != EntryKind::Other)
        .map(|entry| (entry.rel.clone(), entry.full_mode))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.0.cmp(&right.0));
    let mut body = Vec::new();
    for (path, mode) in records {
        body.extend_from_slice(format!("{mode:04o}").as_bytes());
        body.push(b' ');
        body.extend_from_slice(path.len().to_string().as_bytes());
        body.push(b' ');
        body.extend_from_slice(&path);
        body.push(b'\n');
    }
    body
}

fn decode_manifest(bytes: &[u8]) -> Result<Vec<(Vec<u8>, u32)>, ScanFault> {
    let mut cursor = 0;
    let mut records: Vec<(Vec<u8>, u32)> = Vec::new();
    while cursor < bytes.len() {
        if cursor + 5 > bytes.len() {
            return Err(ScanFault::Malformed);
        }
        let mode_text = &bytes[cursor..cursor + 4];
        if !mode_text.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
            return Err(ScanFault::Malformed);
        }
        let mode = u32::from_str_radix(
            std::str::from_utf8(mode_text).map_err(|_| ScanFault::Malformed)?,
            8,
        )
        .map_err(|_| ScanFault::Malformed)?;
        cursor += 4;
        if bytes.get(cursor) != Some(&b' ') {
            return Err(ScanFault::Malformed);
        }
        cursor += 1;
        let length_start = cursor;
        if bytes
            .get(cursor)
            .is_none_or(|byte| !byte.is_ascii_digit() || *byte == b'0')
        {
            return Err(ScanFault::Malformed);
        }
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        let length = std::str::from_utf8(&bytes[length_start..cursor])
            .map_err(|_| ScanFault::Malformed)?
            .parse::<usize>()
            .map_err(|_| ScanFault::Malformed)?;
        if bytes.get(cursor) != Some(&b' ') {
            return Err(ScanFault::Malformed);
        }
        cursor += 1;
        let end = cursor.checked_add(length).ok_or(ScanFault::Malformed)?;
        if end >= bytes.len() || bytes.get(end) != Some(&b'\n') {
            return Err(ScanFault::Malformed);
        }
        let path = bytes[cursor..end].to_vec();
        cursor = end + 1;
        if std::str::from_utf8(&path).is_err() || unsafe_path(&path) {
            if unsafe_path(&path) {
                return Err(ScanFault::UnsafePath);
            }
            return Err(ScanFault::Malformed);
        }
        if let Some((previous, _)) = records.last()
            && previous.as_slice() >= path.as_slice()
        {
            return Err(ScanFault::Malformed);
        }
        records.push((path, mode));
    }
    Ok(records)
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

fn unsafe_component(name: &[u8]) -> bool {
    name.is_empty() || name == b"." || name == b".." || name.contains(&b'/') || name.contains(&0)
}

fn unsafe_path(path: &[u8]) -> bool {
    path.is_empty()
        || path.starts_with(b"/")
        || path.contains(&0)
        || path
            .split(|byte| *byte == b'/')
            .any(|component| component.is_empty() || component == b"." || component == b"..")
}

fn parent_prefixes(path: &[u8]) -> Vec<Vec<u8>> {
    let mut prefixes = Vec::new();
    let mut start = 0;
    while let Some(offset) = path[start..].iter().position(|byte| *byte == b'/') {
        let end = start + offset;
        prefixes.push(path[..end].to_vec());
        start = end + 1;
    }
    prefixes
}

fn parent_of(path: &[u8]) -> &[u8] {
    match path.iter().rposition(|byte| *byte == b'/') {
        Some(index) => &path[..index],
        None => b"",
    }
}

fn file_name(path: &[u8]) -> &[u8] {
    match path.iter().rposition(|byte| *byte == b'/') {
        Some(index) => &path[index + 1..],
        None => path,
    }
}

fn path_depth(path: &[u8]) -> usize {
    if path.is_empty() {
        0
    } else {
        path.iter().filter(|byte| **byte == b'/').count() + 1
    }
}

fn push_mktree(out: &mut Vec<u8>, mode: &str, kind: &str, oid: &str, name: &[u8]) {
    out.extend_from_slice(mode.as_bytes());
    out.push(b' ');
    out.extend_from_slice(kind.as_bytes());
    out.push(b' ');
    out.extend_from_slice(oid.as_bytes());
    out.push(b'\t');
    out.extend_from_slice(name);
    out.push(0);
}

fn parse_oid(bytes: &[u8]) -> Result<String, ScanFault> {
    let text = std::str::from_utf8(bytes).map_err(|_| ScanFault::Failed)?;
    let oid = text.trim();
    if is_lowercase_hex(oid, OBJECT_ID_LEN) {
        Ok(oid.to_string())
    } else {
        Err(ScanFault::Failed)
    }
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), ScanFault> {
    let temporary = path.with_extension("tmp");
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(mode)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<&'a str, &'static str> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or(COMMAND_INVALID)
}

fn required_pair(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<SnapshotPair, &'static str> {
    let pair = object
        .get(key)
        .and_then(serde_json::Value::as_object)
        .ok_or(COMMAND_INVALID)?;
    Ok(SnapshotPair {
        tree: pair_oid(pair, "tree")?,
        manifest: pair_oid(pair, "manifest")?,
    })
}

fn pair_oid(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, &'static str> {
    let value = object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_lowercase_hex(value, OBJECT_ID_LEN))
        .ok_or(COMMAND_INVALID)?;
    Ok(value.to_string())
}

fn is_request_id(value: &str) -> bool {
    is_lowercase_hex(value, 64)
}

fn is_lowercase_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    match bytes.next() {
        Some(byte) if byte.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    value.len() <= IDENTIFIER_MAX_BYTES
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-'
        })
}

impl From<std::io::Error> for ScanFault {
    fn from(_error: std::io::Error) -> Self {
        ScanFault::Failed
    }
}
#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::fs::{self, File};
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "openkit-h1-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn worktree(&self) -> PathBuf {
            self.root.join("wt")
        }

        fn store(&self) -> PathBuf {
            self.root.join("store")
        }

        fn open(&self) -> WorkspaceCollector {
            fs::create_dir_all(self.worktree()).unwrap();
            WorkspaceCollector::open(Path::new("/usr/bin/git"), &self.store(), &self.worktree())
                .expect("open collector")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_file(path: &Path, bytes: &[u8], mode: u32) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
        file.set_permissions(fs::Permissions::from_mode(mode))
            .unwrap();
    }

    fn command_for(base: &SnapshotPair, previous: &SnapshotPair) -> CollectCommand {
        CollectCommand {
            storage_ref: "storage-one".into(),
            scope_digest: format!("sha256:{}", "b".repeat(64)),
            attachment_generation: 1,
            sandbox_id: "sandbox-one".into(),
            mode: CollectMode::Capture,
            request_id: "ab".repeat(32),
            work_slot: "slotA".to_string(),
            collection_id: "collect.1".to_string(),
            accepted_base: base.clone(),
            previous_head: previous.clone(),
            runtime_env: Vec::new(),
            loopback_digests: dummy_digests(),
        }
    }

    fn dummy_digests() -> [String; 2] {
        ["0123456789abcdef".repeat(4), "fedcba9876543210".repeat(4)]
    }

    fn assert_outcome(delivery: &WorkspaceCollectDelivery, expected: &str) {
        match delivery {
            WorkspaceCollectDelivery::Json { body, .. } => {
                assert_eq!(std::str::from_utf8(body).unwrap(), expected);
            }
            WorkspaceCollectDelivery::Candidate(_) => panic!("expected json result"),
        }
    }

    fn candidate(delivery: &WorkspaceCollectDelivery) -> &WorkspaceCandidate {
        match delivery {
            WorkspaceCollectDelivery::Candidate(candidate) => candidate,
            WorkspaceCollectDelivery::Json { body, .. } => {
                panic!("expected candidate, got {}", String::from_utf8_lossy(body))
            }
        }
    }

    fn manifest_paths(collector: &WorkspaceCollector, oid: &str) -> Vec<Vec<u8>> {
        decode_manifest(&collector.read_blob(oid).unwrap())
            .unwrap()
            .into_iter()
            .map(|(path, _)| path)
            .collect()
    }

    fn worker_git(worktree: &Path, args: &[&str]) {
        let status = Command::new("/usr/bin/git")
            .current_dir(worktree)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .env("GIT_AUTHOR_NAME", "OpenKit Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "OpenKit Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }

    fn count_files(root: &Path) -> u64 {
        let mut count = 0;
        if !root.exists() {
            return 0;
        }
        for entry in walkdir_files(root) {
            if entry.is_file() {
                count += 1;
            }
        }
        count
    }

    fn walkdir_files(root: &Path) -> Vec<PathBuf> {
        let mut pending = vec![root.to_path_buf()];
        let mut files = Vec::new();
        while let Some(dir) = pending.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    files.push(path);
                }
            }
        }
        files
    }

    #[test]
    fn h1_clean_tree_returns_stable_no_new_head() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"same", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let delivery = collector.collect(&command_for(&base, &base));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().head, base);
    }

    #[test]
    fn h1_dirty_tree_returns_candidate() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"before", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"after", 0o644);
        let delivery = collector.collect(&command_for(&base, &base));
        let body = candidate(&delivery).body.bytes();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("diff --git a/a b/a"), "{text}");
        assert!(!text.contains("openkit-full-mode-delta"), "{text}");
        assert!(!candidate(&delivery).unstable);
    }

    #[test]
    fn h1_non_git_tree_scans_without_a_worker_repository() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"plain", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        collector.collect(&command_for(&base, &base));
        assert!(!fixture.worktree().join(".git").exists());
        assert!(!fixture.store().join("head-context").exists());
        assert!(!fixture.store().starts_with(fixture.worktree()));
        assert!(fixture.store().join("git").join("HEAD").is_file());
    }

    #[test]
    fn h1_git_worktree_head_is_context_only() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        write_file(&fixture.worktree().join("a"), b"committed", 0o644);
        worker_git(&fixture.worktree(), &["init", "--quiet"]);
        worker_git(&fixture.worktree(), &["add", "a"]);
        worker_git(&fixture.worktree(), &["commit", "--quiet", "-m", "seed"]);
        let before = count_files(&fixture.worktree().join(".git/objects"));
        let head = String::from_utf8(
            Command::new("/usr/bin/git")
                .current_dir(fixture.worktree())
                .args(["rev-parse", "--verify", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        collector.collect(&command_for(&base, &base));
        let stored = fs::read_to_string(fixture.store().join("head-context")).unwrap();
        assert_eq!(stored, head.trim());
        assert_eq!(
            count_files(&fixture.worktree().join(".git/objects")),
            before
        );
    }

    #[test]
    fn h1_deletion_is_a_candidate() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"gone", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::remove_file(fixture.worktree().join("a")).unwrap();
        let delivery = collector.collect(&command_for(&base, &base));
        assert!(
            String::from_utf8_lossy(&candidate(&delivery).body.bytes()).contains("deleted file")
        );
    }

    #[test]
    fn h1_mode_only_change_0644_to_0600_is_a_candidate() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"mode", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::set_permissions(
            fixture.worktree().join("a"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let delivery = collector.collect(&command_for(&base, &base));
        let found = candidate(&delivery);
        assert_eq!(found.head.tree, base.tree);
        assert_ne!(found.head.manifest, base.manifest);
        assert_eq!(
            found.body.bytes(),
            b"openkit-full-mode-delta\n0644 0600 1 a\n"
        );
    }

    #[test]
    fn h1_symlink_is_recorded_with_its_own_mode() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("realdir/file"), b"inside", 0o644);
        symlink("realdir", fixture.worktree().join("link")).unwrap();
        let mode = fs::symlink_metadata(fixture.worktree().join("link"))
            .unwrap()
            .mode()
            & 0o7777;
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let paths = manifest_paths(&collector, &base.manifest);
        assert!(paths.contains(&b"link".to_vec()));
        assert!(paths.contains(&b"realdir".to_vec()));
        assert!(paths.contains(&b"realdir/file".to_vec()));
        assert!(!paths.contains(&b"link/file".to_vec()));
        let records = decode_manifest(&collector.read_blob(&base.manifest).unwrap()).unwrap();
        let link_mode = records.iter().find(|(path, _)| path == b"link").unwrap().1;
        assert_eq!(link_mode, mode);
        let listed = collector.ls_tree(&base.tree).unwrap();
        assert_eq!(listed.get(b"link".as_slice()).unwrap().mode, "120000");
        let target = collector
            .read_blob(&listed.get(b"link".as_slice()).unwrap().oid)
            .unwrap();
        assert_eq!(target, b"realdir");
    }

    #[test]
    fn h1_path_with_space_and_embedded_lf_round_trips_manifest() {
        let fixture = Fixture::new();
        let name = "a b\nc";
        write_file(&fixture.worktree().join(name), b"z", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let bytes = collector.read_blob(&base.manifest).unwrap();
        let records = decode_manifest(&bytes).unwrap();
        assert!(records.iter().any(|(path, _)| path == name.as_bytes()));
        let entries = records
            .iter()
            .map(|(path, mode)| KeptEntry {
                rel: path.clone(),
                kind: EntryKind::File,
                full_mode: *mode,
                blob: None,
            })
            .collect::<Vec<_>>();
        assert_eq!(encode_manifest(&entries), bytes);
    }

    #[test]
    fn h1_manifest_has_no_root_record() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"root", 0o644);
        write_file(&fixture.worktree().join("dir/file"), b"nested", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let paths = manifest_paths(&collector, &base.manifest);
        assert!(paths.contains(&b"a".to_vec()));
        assert!(paths.contains(&b"dir".to_vec()));
        assert!(paths.contains(&b"dir/file".to_vec()));
        assert!(
            paths
                .iter()
                .all(|path| !path.is_empty() && path != b"." && path != b"..")
        );
        assert!(
            !collector
                .ls_tree(&base.tree)
                .unwrap()
                .contains_key(b"".as_slice())
        );
    }

    #[test]
    fn h1_empty_directory_is_absent() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree().join("empty")).unwrap();
        write_file(&fixture.worktree().join("a"), b"file", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let paths = manifest_paths(&collector, &base.manifest);
        assert_eq!(paths, vec![b"a".to_vec()]);
        assert!(
            !collector
                .ls_tree(&base.tree)
                .unwrap()
                .contains_key(b"empty".as_slice())
        );
    }

    #[test]
    fn h1_ignored_untracked_paths_are_excluded_and_tracked_ignored_paths_stay() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("keep"), b"keep", 0o644);
        write_file(&fixture.worktree().join("secret"), b"secret", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(
            &fixture.worktree().join(".gitignore"),
            b"secret\nignored-new\n",
            0o644,
        );
        write_file(&fixture.worktree().join("ignored-new"), b"new", 0o644);
        let delivery = collector.collect(&command_for(&base, &base));
        let head = candidate(&delivery).head.clone();
        let paths = manifest_paths(&collector, &head.manifest);
        assert!(paths.contains(&b"secret".to_vec()));
        assert!(paths.contains(&b"keep".to_vec()));
        assert!(paths.contains(&b".gitignore".to_vec()));
        assert!(!paths.contains(&b"ignored-new".to_vec()));
        let again = collector.collect(&command_for(&base, &head));
        assert_outcome(
            &again,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(
            !manifest_paths(&collector, &collector.state.as_ref().unwrap().head.manifest)
                .contains(&b"ignored-new".to_vec())
        );
    }

    #[test]
    fn h1_scans_that_differ_mark_unstable() {
        let fixture = Fixture::new();
        let file = fixture.worktree().join("a");
        write_file(&file, b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let delivery = collector.collect_between(&command_for(&base, &base), || {
            write_file(&file, b"1", 0o644);
        });
        let found = candidate(&delivery);
        assert!(found.unstable);
        assert_ne!(found.head, base);
        let paths = decode_manifest(&collector.read_blob(&found.head.manifest).unwrap()).unwrap();
        assert_eq!(paths[0].1, 0o644);
        let blob = collector
            .read_blob(
                &collector
                    .ls_tree(&found.head.tree)
                    .unwrap()
                    .get(b"a".as_slice())
                    .unwrap()
                    .oid,
            )
            .unwrap();
        assert_eq!(blob, b"1");
    }

    #[test]
    fn h1_two_mode_only_scans_record_the_second_mode() {
        let fixture = Fixture::new();
        let file = fixture.worktree().join("a");
        write_file(&file, b"mode", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let delivery = collector.collect_between(&command_for(&base, &base), || {
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        });
        let found = candidate(&delivery);
        assert!(found.unstable);
        assert_eq!(found.head.tree, base.tree);
        let records = decode_manifest(&collector.read_blob(&found.head.manifest).unwrap()).unwrap();
        assert_eq!(records, vec![(b"a".to_vec(), 0o600)]);
    }

    #[test]
    fn h1_unstable_return_to_previous_mode_is_no_new_head() {
        let fixture = Fixture::new();
        let file = fixture.worktree().join("a");
        write_file(&file, b"mode", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let delivery = collector.collect_between(&command_for(&base, &base), || {
            fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        });
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":true}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(
            collector.state.as_ref().unwrap().head.manifest,
            base.manifest
        );
        let transient = collector.object_id(b"0600 1 a\n");
        assert!(!collector.object_exists(&transient), "{transient}");
        assert!(collector.object_exists(&base.manifest));
    }

    #[test]
    fn h1_runtime_env_sentinel_in_a_binary_file_is_a_hit() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"safe", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let sentinel = "OPENKIT_H1_RUNTIME_ENV_SENTINEL";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend_from_slice(sentinel.as_bytes());
        bytes.push(0);
        write_file(&fixture.worktree().join("a"), &bytes, 0o644);
        let mut command = command_for(&base, &base);
        command.runtime_env = vec![sentinel.to_string()];
        let blob = collector.object_id(&bytes);
        let delivery = collector.collect(&command);
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(!collector.object_exists(&blob), "{blob}");
        assert_eq!(collector.state.as_ref().unwrap().head, base);
    }

    #[test]
    fn h1_loopback_window_inside_a_longer_run_is_a_hit() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"safe", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let secret = "A".repeat(LOOPBACK_WINDOW_BYTES);
        let digest = format!("{:x}", Sha256::digest(secret.as_bytes()));
        let body = format!("B{secret}C");
        write_file(&fixture.worktree().join("a"), body.as_bytes(), 0o644);
        let mut command = command_for(&base, &base);
        command.loopback_digests = [digest, "fedcba9876543210".repeat(4)];
        let delivery = collector.collect(&command);
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(!collector.object_exists(&collector.object_id(body.as_bytes())));
        assert_eq!(collector.state.as_ref().unwrap().head, base);
    }

    #[test]
    fn h1_credential_hit_deletes_scan_objects_and_does_not_advance() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"before", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"TOKEN-VALUE", 0o644);
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["TOKEN-VALUE".to_string()];
        let new_blob = collector.object_id(b"TOKEN-VALUE");
        let delivery = collector.collect(&command);
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(!collector.object_exists(&new_blob));
        assert!(collector.object_exists(&base.tree));
        assert!(collector.object_exists(&base.manifest));
        assert_eq!(collector.state.as_ref().unwrap().head, base);
    }

    #[test]
    fn h1_private_store_survives_reopen() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"1", 0o644);
        let delivery = collector.collect(&command_for(&base, &base));
        let head = candidate(&delivery).head.clone();
        drop(collector);
        let mut reopened = fixture.open();
        assert_eq!(reopened.state.as_ref().unwrap().head, base);
        assert_eq!(reopened.state.as_ref().unwrap().accepted, base);
        assert_eq!(
            reopened.state.as_ref().unwrap().unacknowledged.as_ref(),
            Some(&head)
        );
        assert_eq!(reopened.object_type(&head.tree).unwrap(), "tree");
        assert_eq!(reopened.object_type(&head.manifest).unwrap(), "blob");
        let again = reopened.collect(&command_for(&base, &head));
        assert_outcome(
            &again,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(reopened.state.as_ref().unwrap().head, head);
        assert!(reopened.state.as_ref().unwrap().unacknowledged.is_none());
        assert!(reopened.object_exists(&head.tree));
        assert!(reopened.object_exists(&base.manifest));
    }

    #[test]
    fn h1_first_link_from_accepted_base() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("b"), b"added", 0o644);
        let delivery = collector.collect(&command_for(&base, &base));
        let text = String::from_utf8_lossy(&candidate(&delivery).body.bytes()).into_owned();
        assert!(text.contains("diff --git a/b b/b"), "{text}");
        assert!(text.contains("---- 0644 1 b\n"), "{text}");
    }

    #[test]
    fn h1_base_mismatch_does_not_advance() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"1", 0o644);
        let delivery = collector.collect(&command_for(&base, &base));
        let head = candidate(&delivery).head.clone();
        let again = collector.collect(&command_for(&base, &base));
        let repeated = candidate(&again);
        assert_eq!(repeated.previous_head, base);
        assert_eq!(collector.state.as_ref().unwrap().head, base);
        assert_eq!(
            collector.state.as_ref().unwrap().unacknowledged.as_ref(),
            Some(&head)
        );
        assert!(collector.object_exists(&base.tree));
        assert!(collector.object_exists(&head.tree));
    }

    #[test]
    fn h1_unknown_base_objects_fail_closed() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        let mut collector = fixture.open();
        let missing = SnapshotPair {
            tree: "0123456789abcdef0123456789abcdef01234567".to_string(),
            manifest: "89abcdef0123456789abcdef0123456789abcdef".to_string(),
        };
        let delivery = collector.collect(&command_for(&missing, &missing));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"recovery_required","cause":"accepted_base_unknown"}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(collector.state.is_none());
        assert!(!fixture.store().join("state").exists());
    }

    #[test]
    fn h1_empty_candidate_advances_without_a_body() {
        let fixture = Fixture::new();
        let file = fixture.worktree().join("a");
        write_file(&file, b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&file, b"1", 0o644);
        let advanced = collector.collect(&command_for(&base, &base));
        let previous = candidate(&advanced).head.clone();
        write_file(&file, b"0", 0o644);
        let delivery = collector.collect(&command_for(&base, &previous));
        let unstable = "false";
        let expected = format!(
            r#"{{"requestId":"{}","outcome":"empty","head":{{"tree":"{}","manifest":"{}"}},"previousHead":{{"tree":"{}","manifest":"{}"}},"acceptedBase":{{"tree":"{}","manifest":"{}"}},"unstable":{unstable}}}"#,
            "ab".repeat(32),
            base.tree,
            base.manifest,
            previous.tree,
            previous.manifest,
            base.tree,
            base.manifest
        );
        assert_outcome(&delivery, &expected);
        assert_eq!(collector.state.as_ref().unwrap().head, previous);
        assert_eq!(
            collector.state.as_ref().unwrap().unacknowledged.as_ref(),
            Some(&base)
        );
    }

    fn valid_command() -> serde_json::Value {
        let pair = json!({"tree": "0123456789abcdef0123456789abcdef01234567", "manifest": "89abcdef0123456789abcdef0123456789abcdef"});
        json!({
            "requestId": "ab".repeat(32),
            "storageRef": "storage-one",
            "scopeDigest": format!("sha256:{}", "b".repeat(64)),
            "attachmentGeneration": 1,
            "sandboxId": "sandbox-one",
            "mode": "capture",
            "workSlot": "slotA",
            "collectionId": "collect.1",
            "acceptedBase": pair.clone(),
            "previousHead": pair,
            "checkValues": {
                "runtimeEnv": ["VALUE"],
                "loopbackDigests": ["0123456789abcdef".repeat(4), "fedcba9876543210".repeat(4)]
            }
        })
    }

    #[test]
    fn h1_command_validation_failures() {
        let reject = |value: serde_json::Value| {
            let bytes = serde_json::to_vec(&value).unwrap();
            assert!(validate_collect_command(&bytes).is_err(), "{value}");
        };
        for key in [
            "requestId",
            "workSlot",
            "collectionId",
            "acceptedBase",
            "previousHead",
            "checkValues",
        ] {
            let mut value = valid_command();
            value.as_object_mut().unwrap().remove(key);
            reject(value);
        }
        let mut bad_hex = valid_command();
        bad_hex["acceptedBase"]["tree"] = json!("0123456789ABCDEF0123456789abcdef01234567");
        reject(bad_hex);
        let mut short_hex = valid_command();
        short_hex["previousHead"]["manifest"] = json!("89abcdef0123456789abcdef0123456789abcde");
        reject(short_hex);
        let mut long_hex = valid_command();
        long_hex["acceptedBase"]["tree"] = json!("ab".repeat(32));
        reject(long_hex);
        let mut inner = valid_command();
        inner["acceptedBase"]["extra"] = json!(1);
        let accepted = validate_collect_command(&serde_json::to_vec(&inner).unwrap()).unwrap();
        assert_eq!(
            accepted.accepted_base.tree,
            "0123456789abcdef0123456789abcdef01234567"
        );
        let mut checks = valid_command();
        checks["checkValues"]["extra"] = json!(true);
        assert!(validate_collect_command(&serde_json::to_vec(&checks).unwrap()).is_ok());
        let mut empty_env = valid_command();
        empty_env["checkValues"]["runtimeEnv"] = json!([""]);
        reject(empty_env);
        let mut nul_env = valid_command();
        nul_env["checkValues"]["runtimeEnv"] = json!(["a\u{0}b"]);
        reject(nul_env);
        let mut too_many = valid_command();
        too_many["checkValues"]["runtimeEnv"] = json!(
            (0..129)
                .map(|index| format!("v{index}"))
                .collect::<Vec<_>>()
        );
        reject(too_many);
        let mut too_long = valid_command();
        too_long["checkValues"]["runtimeEnv"] = json!(["a".repeat(65537)]);
        reject(too_long);
        let mut admitted = valid_command();
        admitted["checkValues"]["runtimeEnv"] = json!(["a".repeat(4097)]);
        assert!(validate_collect_command(&serde_json::to_vec(&admitted).unwrap()).is_ok());
        let mut one_digest = valid_command();
        one_digest["checkValues"]["loopbackDigests"] = json!(["0123456789abcdef".repeat(4)]);
        reject(one_digest);
        let mut upper_digest = valid_command();
        upper_digest["checkValues"]["loopbackDigests"][0] =
            json!("0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef");
        reject(upper_digest);
        let mut prefixed = valid_command();
        prefixed["checkValues"]["loopbackDigests"][0] =
            json!(format!("sha256:{}", "ab".repeat(32)));
        reject(prefixed);
        reject(json!([1, 2]));
        reject(json!(null));
        let mut bad_slot = valid_command();
        bad_slot["workSlot"] = json!("../slot");
        reject(bad_slot);
        let mut empty_collection = valid_command();
        empty_collection["collectionId"] = json!("");
        reject(empty_collection);
        let mut oversized = vec![b' '; crate::sandbox_bridge::NANOHOST_CONTROL_IN_FLIGHT_BYTES + 1];
        oversized[0] = b'{';
        assert!(validate_collect_command(&oversized).is_err());
        let mut boundary = valid_command();
        boundary["checkValues"]["runtimeEnv"] = json!(["a".repeat(65536)]);
        assert!(validate_collect_command(&serde_json::to_vec(&boundary).unwrap()).is_ok());
        let mut wide = valid_command();
        wide["checkValues"]["runtimeEnv"] = json!(
            (0..128)
                .map(|index| format!("v{index}"))
                .collect::<Vec<_>>()
        );
        assert!(validate_collect_command(&serde_json::to_vec(&wide).unwrap()).is_ok());
        let mut same_digests = valid_command();
        let digest = "0123456789abcdef".repeat(4);
        same_digests["checkValues"]["loopbackDigests"] = json!([digest.clone(), digest]);
        assert!(validate_collect_command(&serde_json::to_vec(&same_digests).unwrap()).is_ok());
        let raw = serde_json::to_string(&valid_command()).unwrap();
        let duplicated = raw.replacen("\"workSlot\"", "\"workSlot\":\"slotA\",\"workSlot\"", 1);
        assert!(validate_collect_command(duplicated.as_bytes()).is_err());
        let escaped = raw.replacen(
            "\"workSlot\"",
            "\"work\\u0053lot\":\"slotB\",\"workSlot\"",
            1,
        );
        assert!(validate_collect_command(escaped.as_bytes()).is_err());
        let unknown = raw.replacen('{', "{\"extra\":1,\"extra\":2,", 1);
        let parsed = validate_collect_command(unknown.as_bytes()).unwrap();
        let plain =
            validate_collect_command(&serde_json::to_vec(&valid_command()).unwrap()).unwrap();
        assert!(parsed == plain);
    }

    #[test]
    fn h1_unknown_command_member_is_ignored() {
        let mut extra = valid_command();
        extra["bytes"] = json!("ignored");
        extra["operation"] = json!("sandbox.delete");
        extra["authorization"] = json!("raw");
        let with_extra = validate_collect_command(&serde_json::to_vec(&extra).unwrap()).unwrap();
        let plain =
            validate_collect_command(&serde_json::to_vec(&valid_command()).unwrap()).unwrap();
        assert!(with_extra == plain);
    }

    #[test]
    fn h1_execute_invalid_command_is_effect_failed() {
        let fixture = Fixture::new();
        let request_id = "ab".repeat(32);
        assert!(validate_collect_value(&json!({})).is_err());
        let delivery = effect_failed(&request_id);
        assert_outcome(
            &delivery,
            &format!(r#"{{"requestId":"{request_id}","outcome":"effect_failed"}}"#),
        );
        assert!(!fixture.store().exists());
    }

    #[test]
    fn h1_malformed_manifest_does_not_advance() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        let mut collector = fixture.open();
        let empty = collector.mktree(b"").unwrap();
        let garbage = collector.install_unverified(&empty, b"this is not a manifest\n");
        let delivery = collector.collect(&command_for(&garbage, &garbage));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"recovery_required","cause":"malformed_manifest"}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().head, garbage);
        let blob = collector.write_blob(b"a").unwrap();
        let mut payload = Vec::new();
        push_mktree(&mut payload, "100644", "blob", &blob, b"a");
        push_mktree(&mut payload, "100644", "blob", &blob, b"b");
        let tree = collector.mktree(&payload).unwrap();
        let unsorted = collector.install_unverified(&tree, b"0644 1 b\n0644 1 a\n");
        let delivery = collector.collect(&command_for(&unsorted, &unsorted));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"recovery_required","cause":"malformed_manifest"}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().head, unsorted);
    }

    #[test]
    fn h1_unsafe_path_manifest_does_not_advance() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        let mut collector = fixture.open();
        let empty = collector.mktree(b"").unwrap();
        let installed = collector.install_unverified(&empty, b"0644 4 ../x\n");
        let delivery = collector.collect(&command_for(&installed, &installed));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"recovery_required","cause":"unsafe_path"}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().head, installed);
    }

    #[test]
    fn h1_tree_manifest_disagreement_does_not_advance() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        let mut collector = fixture.open();
        let blob = collector.write_blob(b"a").unwrap();
        let mut payload = Vec::new();
        push_mktree(&mut payload, "100644", "blob", &blob, b"a");
        let tree = collector.mktree(&payload).unwrap();
        let installed = collector.install_unverified(&tree, b"0644 5 other\n");
        let delivery = collector.collect(&command_for(&installed, &installed));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"recovery_required","cause":"tree_manifest_disagreement"}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().head, installed);
    }

    #[test]
    fn h1_candidate_headers_bind_the_pair_digest_and_length() {
        let pair = |tree: &str, manifest: &str| SnapshotPair {
            tree: tree.to_string(),
            manifest: manifest.to_string(),
        };
        let body = b"patch-bytes".to_vec();
        let delivery = WorkspaceCollectDelivery::Candidate(WorkspaceCandidate {
            request_id: "ab".repeat(32),
            head: pair(
                "0123456789abcdef0123456789abcdef01234567",
                "89abcdef0123456789abcdef0123456789abcdef",
            ),
            previous_head: pair(
                "1111111111111111111111111111111111111111",
                "2222222222222222222222222222222222222222",
            ),
            accepted_base: pair(
                "3333333333333333333333333333333333333333",
                "4444444444444444444444444444444444444444",
            ),
            unstable: true,
            body: CandidateBody::fixture(body.clone()),
        });
        let headers = delivery_headers(&delivery);
        let value = |name| {
            headers
                .iter()
                .find(|header| header.name == name)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(value("content-type"), "application/octet-stream");
        assert_eq!(value("content-length"), body.len().to_string());
        assert_eq!(value("x-openkit-request-id"), "ab".repeat(32));
        assert_eq!(
            value("x-openkit-head"),
            "0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef"
        );
        assert_eq!(
            value("x-openkit-previous-head"),
            "1111111111111111111111111111111111111111 2222222222222222222222222222222222222222"
        );
        assert_eq!(
            value("x-openkit-accepted-base"),
            "3333333333333333333333333333333333333333 4444444444444444444444444444444444444444"
        );
        assert_eq!(value("x-openkit-unstable"), "true");
        assert_eq!(
            value("x-openkit-sha256"),
            format!("sha256:{:x}", Sha256::digest(&body))
        );
        assert_eq!(value("x-openkit-byte-length"), body.len().to_string());
        assert_eq!(headers.len(), 9);
    }

    #[test]
    fn h1_r1_parent_symlink_escape_is_not_a_slot() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir_all(outside.join("slotA")).unwrap();
        write_file(&outside.join("slotA").join("a"), b"OUTSIDE_SENTINEL", 0o644);
        let vol = fixture.root.join("volumes/stor/volumes/vol");
        fs::create_dir_all(&vol).unwrap();
        symlink(&outside, vol.join("worktrees")).unwrap();
        assert!(
            openat_dir(&open_nofollow_dir(&vol).unwrap(), "worktrees").is_err(),
            "a symlinked worktrees parent must not authorize an outside slot"
        );
    }

    #[test]
    fn h1_r1_root_swap_does_not_read_outside() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"INSIDE", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let displaced = fixture.root.join("displaced");
        fs::rename(fixture.worktree(), &displaced).unwrap();
        let outside = fixture.root.join("outside");
        write_file(&outside.join("a"), b"OUTSIDE_SENTINEL", 0o644);
        symlink(&outside, fixture.worktree()).unwrap();
        let delivery = collector.collect(&command_for(&base, &base));
        let rendered = match &delivery {
            WorkspaceCollectDelivery::Candidate(candidate) => {
                String::from_utf8_lossy(&candidate.body.bytes()).into_owned()
            }
            WorkspaceCollectDelivery::Json { body, .. } => {
                String::from_utf8_lossy(body).into_owned()
            }
        };
        assert!(
            !rendered.contains("OUTSIDE_SENTINEL"),
            "root replacement was followed: {rendered}"
        );
    }

    #[test]
    fn h1_r2_lost_result_accepts_the_same_previous_head() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"B", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"H", 0o644);
        let first = collector.collect(&command_for(&base, &base));
        let produced = candidate(&first).head.clone();
        assert_ne!(produced, base);
        drop(collector);
        let mut reopened = fixture.open();
        write_file(&fixture.worktree().join("a"), b"H", 0o644);
        let retry = reopened.collect(&command_for(&base, &base));
        match &retry {
            WorkspaceCollectDelivery::Json { body, .. } => {
                let text = String::from_utf8_lossy(body);
                assert!(
                    !text.contains("effect_failed") && !text.contains("previous_head_mismatch"),
                    "lost delivery must not block Core's unchanged cursor: {text}"
                );
            }
            WorkspaceCollectDelivery::Candidate(found) => {
                assert_eq!(found.previous_head, base);
            }
        }
        assert_eq!(reopened.state.as_ref().unwrap().head, base);
        assert!(reopened.object_exists(&base.tree));
        assert!(reopened.object_exists(&produced.tree));
    }

    #[test]
    fn h1_r4_cumulative_candidate_checks_old_side_bytes() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"NEW_BINDING_SECRET", 0o644);
        let first = collector.collect(&command_for(&base, &base));
        let head = candidate(&first).head.clone();
        write_file(&fixture.worktree().join("b"), b"only-b", 0o644);
        let mut command = command_for(&base, &head);
        command.runtime_env = vec!["NEW_BINDING_SECRET".to_string()];
        let delivery = collector.collect(&command);
        match &delivery {
            WorkspaceCollectDelivery::Json { body, .. } => {
                assert!(
                    String::from_utf8_lossy(body).contains("credential_hit"),
                    "cumulative old-side bytes must hit, got {}",
                    String::from_utf8_lossy(body)
                );
            }
            WorkspaceCollectDelivery::Candidate(found) => {
                let text = String::from_utf8_lossy(&found.body.bytes()).into_owned();
                assert!(
                    !text.contains("NEW_BINDING_SECRET"),
                    "candidate published a current check value: {text}"
                );
            }
        }
        assert!(collector.object_exists(&base.tree));
        assert!(collector.object_exists(&head.tree));
    }

    fn recovery(cause: &str) -> String {
        format!(
            r#"{{"requestId":"{}","outcome":"recovery_required","cause":"{cause}"}}"#,
            "ab".repeat(32)
        )
    }

    fn failed_json() -> String {
        format!(
            r#"{{"requestId":"{}","outcome":"effect_failed"}}"#,
            "ab".repeat(32)
        )
    }

    fn rendered(delivery: &WorkspaceCollectDelivery) -> String {
        String::from_utf8_lossy(&delivery.body()).into_owned()
    }

    struct RestoreMode(PathBuf);

    impl Drop for RestoreMode {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }

    struct ClearEnv(&'static str);

    impl Drop for ClearEnv {
        fn drop(&mut self) {
            unsafe { std::env::remove_var(self.0) };
        }
    }

    fn make_fifo(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let name = CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o644) }, 0, "{path:?}");
    }

    fn unstick_fifo(path: PathBuf) {
        thread::spawn(move || {
            let name = CString::new(path.to_str().unwrap()).unwrap();
            for _ in 0..40 {
                thread::sleep(Duration::from_millis(25));
                let fd = unsafe { libc::open(name.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
                if fd >= 0 {
                    unsafe { libc::close(fd) };
                    break;
                }
            }
        });
    }

    fn swap_once(flag: &AtomicBool, swap: impl FnOnce()) {
        if !flag.swap(true, Ordering::Relaxed) {
            swap();
        }
    }

    #[test]
    fn h1_r1_leaf_substitution_after_open_keeps_the_original_bytes() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"leaf", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let original = collector.object_id(b"leaf");
        let swapped = collector.object_id(b"SWAPPED_LEAF");
        let file = fixture.worktree().join("a");
        let parked = fixture.root.join("parked-leaf");
        let sentinel = fixture.root.join("sentinel-leaf");
        write_file(&sentinel, b"SWAPPED_LEAF", 0o644);
        let once = AtomicBool::new(false);
        collector.hooks.before_file_read = Some(Box::new(move || {
            swap_once(&once, || {
                fs::rename(&file, &parked).unwrap();
                fs::copy(&sentinel, &file).unwrap();
            });
        }));
        let file = fixture.worktree().join("a");
        let parked = fixture.root.join("parked-leaf");
        let delivery = collector.collect_between(&command_for(&base, &base), || {
            if sentinel_replaced(&file) {
                fs::remove_file(&file).unwrap();
                fs::rename(&parked, &file).unwrap();
            }
        });
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(!rendered(&delivery).contains("SWAPPED_LEAF"));
        let blobs = collector
            .hooks
            .attempt_objects
            .iter()
            .filter(|(_, kind)| *kind == "blob")
            .map(|(oid, _)| oid.clone())
            .collect::<Vec<_>>();
        assert!(blobs.contains(&original), "{blobs:?}");
        assert!(!blobs.contains(&swapped), "{blobs:?}");
    }

    fn sentinel_replaced(path: &Path) -> bool {
        fs::read(path).ok().as_deref() == Some(b"SWAPPED_LEAF".as_slice())
            || fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
    }

    #[test]
    fn h1_r1_directory_substitution_after_open_keeps_the_original_listing() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("sub/a"), b"inside", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let outside = fixture.root.join("outside-dir");
        write_file(&outside.join("secret-name"), b"DIR_SENTINEL", 0o644);
        let sub = fixture.worktree().join("sub");
        let parked = fixture.root.join("parked-sub");
        let once = AtomicBool::new(false);
        collector.hooks.before_dir_read = Some(Box::new(move || {
            swap_once(&once, || {
                fs::rename(&sub, &parked).unwrap();
                symlink(&outside, &sub).unwrap();
            });
        }));
        let sub = fixture.worktree().join("sub");
        let parked = fixture.root.join("parked-sub");
        let delivery = collector.collect_between(&command_for(&base, &base), || {
            if fs::symlink_metadata(&sub).is_ok_and(|meta| meta.file_type().is_symlink()) {
                fs::remove_file(&sub).unwrap();
                fs::rename(&parked, &sub).unwrap();
            }
        });
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(!rendered(&delivery).contains("DIR_SENTINEL"));
        assert!(!rendered(&delivery).contains("secret-name"));
    }

    #[test]
    fn h1_r1_directory_substitution_before_open_is_rejected() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("sub/a"), b"inside", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let sub = fixture.worktree().join("sub");
        let parked = fixture.root.join("parked-sub");
        let once = AtomicBool::new(false);
        collector.hooks.before_dir_open = Some(Box::new(move || {
            swap_once(&once, || {
                fs::rename(&sub, &parked).unwrap();
                write_file(&sub.join("outside"), b"DIR_SENTINEL", 0o644);
            });
        }));
        let delivery = collector.collect(&command_for(&base, &base));
        assert_outcome(&delivery, &failed_json());
        assert!(!rendered(&delivery).contains("DIR_SENTINEL"));
        assert_eq!(collector.state.as_ref().unwrap().head, base);
    }

    #[test]
    fn h1_r3_failed_publish_preserves_the_old_pair_and_reopens() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        assert_eq!(collector.hooks.publish_count, 1);
        write_file(&fixture.worktree().join("a"), b"1", 0o644);
        collector.hooks.fail_publish_at = Some(collector.hooks.publish_count + 2);
        let delivery = collector.collect(&command_for(&base, &base));
        assert_outcome(&delivery, &failed_json());
        assert_eq!(collector.state.as_ref().unwrap().head, base);
        assert!(collector.object_exists(&base.tree));
        assert!(collector.object_exists(&base.manifest));
        assert!(!fixture.store().join("state").exists());
        drop(collector);
        let reopened = fixture.open();
        assert_eq!(reopened.state.as_ref().unwrap().head, base);
        assert_eq!(reopened.state.as_ref().unwrap().accepted, base);
    }

    #[test]
    fn h1_r3_mode_only_and_distinct_previous_head_stay_reopenable() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::set_permissions(
            fixture.worktree().join("a"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let mode_delivery = collector.collect(&command_for(&base, &base));
        let mode_head = candidate(&mode_delivery).head.clone();
        assert_eq!(mode_head.tree, base.tree);
        assert_ne!(mode_head.manifest, base.manifest);
        assert_eq!(collector.state.as_ref().unwrap().head, base);
        write_file(&fixture.worktree().join("a"), b"2", 0o644);
        let moved = collector.collect(&command_for(&base, &mode_head));
        let produced = candidate(&moved).head.clone();
        assert_eq!(collector.state.as_ref().unwrap().head, mode_head);
        assert_eq!(
            collector.state.as_ref().unwrap().unacknowledged.as_ref(),
            Some(&produced)
        );
        assert!(collector.object_exists(&base.tree));
        assert!(collector.object_exists(&mode_head.manifest));
        assert!(collector.object_exists(&produced.tree));
        collector.hooks.fail_prune = true;
        write_file(&fixture.worktree().join("a"), b"3", 0o644);
        let pruned = collector.collect(&command_for(&base, &mode_head));
        assert_outcome(&pruned, &failed_json());
        assert_eq!(collector.state.as_ref().unwrap().head, mode_head);
        drop(collector);
        let reopened = fixture.open();
        assert_eq!(reopened.state.as_ref().unwrap().head, mode_head);
        reopened
            .git
            .run(
                &["update-ref", REF_PROTECTION, &base.manifest],
                StdinSource::None,
                false,
                1024,
                false,
                std::time::Instant::now() + Duration::from_secs(30),
            )
            .unwrap();
        drop(reopened);
        assert!(
            WorkspaceCollector::open(
                Path::new("/usr/bin/git"),
                &fixture.store(),
                &fixture.worktree()
            )
            .is_err()
        );
    }

    #[test]
    fn h1_r4_first_scan_manifest_name_and_symlink_target_are_checked() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"safe", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let file = fixture.worktree().join("a");
        write_file(&file, b"FIRST_SCAN_SECRET", 0o644);
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["FIRST_SCAN_SECRET".to_string()];
        let delivery = collector.collect_between(&command, || write_file(&file, b"safe", 0o644));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().head, base);

        write_file(
            &fixture.worktree().join("MANIFEST_NAME_SECRET"),
            b"plain",
            0o644,
        );
        let mut named = command_for(&base, &base);
        named.runtime_env = vec!["MANIFEST_NAME_SECRET".to_string()];
        let named_delivery = collector.collect(&named);
        assert!(
            rendered(&named_delivery).contains("credential_hit"),
            "{}",
            rendered(&named_delivery)
        );
        assert!(!rendered(&named_delivery).contains("MANIFEST_NAME_SECRET"));

        symlink("SYMLINK_TARGET_SECRET", fixture.worktree().join("link")).unwrap();
        let mut linked = command_for(&base, &base);
        linked.runtime_env = vec!["SYMLINK_TARGET_SECRET".to_string()];
        let linked_delivery = collector.collect(&linked);
        assert!(
            rendered(&linked_delivery).contains("credential_hit"),
            "{}",
            rendered(&linked_delivery)
        );
        assert_eq!(collector.state.as_ref().unwrap().head, base);
        assert!(collector.object_exists(&base.tree));
    }

    #[test]
    fn h1_r5_hit_removes_attempt_blob_tree_and_manifest() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"before", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"ATTEMPT_SECRET", 0o600);
        let seen = Arc::new(Mutex::new(0usize));
        let record = Arc::clone(&seen);
        let attempt = collector.git.attempt.clone();
        collector.hooks.before_cleanup = Some(Box::new(move || {
            *record.lock().unwrap() = usize::try_from(count_files(&attempt)).unwrap();
        }));
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["ATTEMPT_SECRET".to_string()];
        let delivery = collector.collect(&command);
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(
            *seen.lock().unwrap() >= 3,
            "attempt objects {}",
            seen.lock().unwrap()
        );
        let kinds = collector
            .hooks
            .attempt_objects
            .iter()
            .map(|(_, kind)| *kind)
            .collect::<Vec<_>>();
        assert!(
            kinds.contains(&"blob") && kinds.contains(&"tree") && kinds.contains(&"manifest"),
            "{kinds:?}"
        );
        for (oid, _) in &collector.hooks.attempt_objects {
            assert!(!collector.object_exists(oid), "{oid}");
        }
        assert!(!collector.git.attempt.exists());
        assert!(collector.object_exists(&base.tree));
        assert_eq!(collector.state.as_ref().unwrap().head, base);
    }

    #[test]
    fn h1_r5_cleanup_failure_does_not_claim_credential_hit() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"before", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"CLEANUP_SECRET", 0o644);
        let attempt = collector.git.attempt.clone();
        let _restore = RestoreMode(attempt.clone());
        collector.hooks.before_cleanup = Some(Box::new(move || {
            fs::set_permissions(&attempt, fs::Permissions::from_mode(0o555)).unwrap();
        }));
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["CLEANUP_SECRET".to_string()];
        let delivery = collector.collect(&command);
        assert_outcome(&delivery, &failed_json());
        assert!(!rendered(&delivery).contains("credential_hit"));
        assert!(!rendered(&delivery).contains("CLEANUP_SECRET"));
        assert!(collector.git.attempt.exists());
        assert_eq!(collector.state.as_ref().unwrap().head, base);
        assert!(collector.object_exists(&base.tree));
    }

    #[test]
    fn h1_r6_private_store_is_sha1_with_an_empty_template_and_pinned_git() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        let collector = fixture.open();
        let format = collector
            .git
            .run(
                &["rev-parse", "--show-object-format"],
                StdinSource::None,
                false,
                64,
                false,
                std::time::Instant::now() + Duration::from_secs(30),
            )
            .unwrap();
        assert_eq!(std::str::from_utf8(&format).unwrap().trim(), "sha1");
        let hooks = fixture.store().join("git/hooks");
        let hook_files = if hooks.exists() {
            fs::read_dir(&hooks).unwrap().count()
        } else {
            0
        };
        assert_eq!(hook_files, 0);
        assert_eq!(
            fs::read_dir(fixture.store().join("template"))
                .unwrap()
                .count(),
            0
        );
        let observed = Command::new("/usr/bin/git")
            .arg("--version")
            .output()
            .unwrap();
        let line = String::from_utf8(observed.stdout).unwrap();
        let line = line.lines().next().unwrap();
        assert!(verify_git_identity(Path::new("/usr/bin/git"), line).is_ok());
        if cfg!(target_os = "macos") {
            assert!(verify_git_identity(Path::new("/usr/bin/git"), PINNED_GIT_VERSION).is_err());
        }
        assert_eq!(PINNED_GIT, "/usr/bin/git");
        assert_eq!(PINNED_GIT_VERSION, "git version 2.43.0");
        let link = fixture.root.join("git-link");
        symlink("/usr/bin/git", &link).unwrap();
        assert!(verify_git_identity(&link, line).is_err());
        let source = include_str!("workspace_collect.rs");
        let prefix = source.split("#[cfg(test)]").next().unwrap();
        assert!(!prefix.contains("GIT_WORK_TREE"));
        assert!(!prefix.contains("run_in_worktree"));
        assert!(!prefix.contains("retain_worktree_as_base"));
        let init_at = source.find("fn git_bare_init").unwrap();
        let init = &source[init_at..source.find("fn scrubbed_git").unwrap()];
        assert!(init.contains("--object-format=sha1"));
        assert!(init.contains("--template"));
        let main = include_str!("main.rs");
        let version = main.find("--version").unwrap();
        let image = main.find("image_store_cli::dispatch").unwrap();
        let pinned = main.find("verify_pinned_git()").unwrap();
        assert!(version < image && image < pinned);
        let install = include_str!("../deploy/install.sh");
        assert!(install.contains("git_path=$(manifest_identity_value git path)"));
        assert!(install.contains("[ \"$observed_git\" = \"$git_version\" ]"));
        let manifest = include_str!("../deploy/host-manifest.json");
        assert!(manifest.contains("\"path\": \"/usr/bin/git\""));
        assert!(manifest.contains("\"version\": \"git version 2.43.0\""));
        let unit = include_str!("../deploy/openkit-nanohost.service");
        assert!(unit.contains("ExecStart=/usr/lib/openkit/nanohost"));
        assert!(!unit.contains("ExecStart=/bin/sh"));
        assert!(!include_str!("persistent_volume.rs").contains("establish_accepted_base"));
    }

    #[test]
    fn h1_r6_worker_repository_discovery_does_not_affect_the_scan() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"same", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        worker_git(&fixture.worktree(), &["init", "-q"]);
        worker_git(&fixture.worktree(), &["add", "a"]);
        worker_git(&fixture.worktree(), &["commit", "-q", "-m", "base"]);
        let bad = fixture.root.join("bad.gitconfig");
        fs::write(&bad, b"[include]\n\tpath = /no/such/openkit-h1-include\n").unwrap();
        let config_path = fixture.worktree().join(".git/config");
        let mut config = fs::read_to_string(&config_path).unwrap();
        config.push_str(&format!("[include]\n\tpath = {}\n", bad.display()));
        fs::write(&config_path, config).unwrap();
        let marker = fixture.root.join("hook-ran");
        let hook = fixture.worktree().join(".git/hooks/reference-transaction");
        fs::write(
            &hook,
            format!("#!/bin/sh\necho ran > {}\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let _dir = ClearEnv("GIT_DIR");
        let _global = ClearEnv("GIT_CONFIG_GLOBAL");
        let _system = ClearEnv("GIT_CONFIG_SYSTEM");
        unsafe {
            std::env::set_var("GIT_DIR", fixture.worktree().join(".git"));
            std::env::set_var("GIT_CONFIG_GLOBAL", &bad);
            std::env::set_var("GIT_CONFIG_SYSTEM", &bad);
        }
        let delivery = collector.collect(&command_for(&base, &base));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert!(!marker.exists());
        fs::remove_dir_all(fixture.worktree().join(".git")).unwrap();
        symlink(
            fixture.root.join("missing-gitdir"),
            fixture.worktree().join(".git"),
        )
        .unwrap();
        let linked = collector.collect(&command_for(&base, &base));
        assert_outcome(
            &linked,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        fs::remove_file(fixture.worktree().join(".git")).unwrap();
        fs::write(
            fixture.worktree().join(".git"),
            b"gitdir: /no/such/openkit-h1-gitdir\n",
        )
        .unwrap();
        let file_gitdir = collector.collect(&command_for(&base, &base));
        assert_outcome(
            &file_gitdir,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
    }

    #[test]
    fn h1_r7_capture_pumps_large_stdin_and_stdout_together() {
        let fixture = Fixture::new();
        let repo = fixture.root.join("ignore-repo");
        fs::create_dir_all(&repo).unwrap();
        let init = Command::new("/usr/bin/git")
            .current_dir(&repo)
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(init.success());
        fs::write(repo.join(".gitignore"), b"*\n").unwrap();
        let mut stdin = Vec::new();
        for index in 0..1500 {
            stdin.extend(format!("ignored/{index:064}\n").into_bytes());
        }
        let mut command = Command::new("/usr/bin/git");
        command.env_clear();
        command.env("GIT_CONFIG_NOSYSTEM", "1");
        command.env("LC_ALL", "C");
        command.current_dir(&repo);
        command.args(["check-ignore", "--stdin"]);
        let outcome = capture(
            &mut command,
            StdinSource::Bytes(stdin),
            true,
            2_000_000,
            2_000_000,
            std::time::Instant::now() + Duration::from_secs(20),
            None,
        )
        .unwrap();
        assert_eq!(outcome.code, 0);
        assert!(outcome.stdout.len() > 65_536, "{}", outcome.stdout.len());
    }

    #[test]
    fn h1_r7_directory_listing_stops_at_its_memory_bound() {
        let fixture = Fixture::new();
        let directory = fixture.root.join("listing");
        write_file(&directory.join("one"), b"1", 0o644);
        write_file(&directory.join("two"), b"2", 0o644);
        let fd = open_nofollow_dir(&directory).unwrap();
        assert!(matches!(
            read_dir_names(&fd, 1, 1024),
            Err(ScanFault::Failed)
        ));
        assert!(matches!(read_dir_names(&fd, 16, 2), Err(ScanFault::Failed)));
        assert_eq!(read_dir_names(&fd, 16, 3).unwrap().len(), 2);
        assert_eq!(read_dir_names(&fd, 2, 1024).unwrap().len(), 2);
    }

    #[test]
    fn h1_r7_scan_limits_and_special_files_fail_closed() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        write_file(&fixture.worktree().join("b"), b"1", 0o644);
        write_file(&fixture.worktree().join("c"), b"2", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        collector.limits.entries = 2;
        let limited = collector.collect(&command_for(&base, &base));
        assert_outcome(&limited, &failed_json());
        assert!(!rendered(&limited).contains("recovery_required"));
        assert_eq!(collector.state.as_ref().unwrap().head, base);

        collector.limits.entries = MAX_WALK_ENTRIES;
        write_file(
            &fixture.worktree().join("a"),
            b"0123456789abcdefEXTRA",
            0o644,
        );
        collector.limits.store_bytes = 10;
        let grown = collector.collect(&command_for(&base, &base));
        assert_outcome(&grown, &failed_json());
        assert_eq!(collector.state.as_ref().unwrap().head, base);

        collector.limits.store_bytes = MAX_STORE_BYTES;
        collector.limits.deadline = Duration::ZERO;
        let expired = collector.collect(&command_for(&base, &base));
        assert_outcome(&expired, &failed_json());
        assert_eq!(collector.state.as_ref().unwrap().head, base);
        collector.limits.deadline = COLLECT_DEADLINE;

        collector.limits.depth = 0;
        write_file(&fixture.worktree().join("nested/a"), b"deep", 0o644);
        let deep = collector.collect(&command_for(&base, &base));
        assert_outcome(&deep, &failed_json());
        fs::remove_dir_all(fixture.worktree().join("nested")).unwrap();
        collector.limits.depth = MAX_WALK_DEPTH;

        let pipe = fixture.worktree().join("pipe");
        make_fifo(&pipe);
        unstick_fifo(pipe.clone());
        let special = collector.collect(&command_for(&base, &base));
        assert_outcome(&special, &failed_json());
        fs::remove_file(&pipe).unwrap();

        let socket = fixture.worktree().join("sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let device = collector.collect(&command_for(&base, &base));
        assert_outcome(&device, &failed_json());
        drop(listener);
        fs::remove_file(&socket).unwrap();
        assert!(collector.object_exists(&base.tree));
    }

    #[test]
    fn h1_r7_ignored_fifo_and_socket_do_not_fail_the_scan() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        write_file(&fixture.worktree().join("ignored/keep"), b"stay", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(
            &fixture.worktree().join(".gitignore"),
            b"ignored/\nloose-pipe\nloose.sock\n",
            0o644,
        );
        write_file(&fixture.worktree().join("a"), b"1", 0o644);
        let nested = fixture.worktree().join("ignored/pipe");
        make_fifo(&nested);
        unstick_fifo(nested);
        let loose = fixture.worktree().join("loose-pipe");
        make_fifo(&loose);
        unstick_fifo(loose);
        let socket = fixture.worktree().join("loose.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let delivery = collector.collect(&command_for(&base, &base));
        let found = candidate(&delivery);
        let paths = manifest_paths(&collector, &found.head.manifest);
        assert!(paths.contains(&b"ignored/keep".to_vec()));
        assert!(paths.contains(&b"a".to_vec()));
        assert!(
            !paths
                .iter()
                .any(|path| path.windows(4).any(|item| item == b"pipe"))
        );
        assert!(!paths.iter().any(|path| path.ends_with(b"sock")));
        assert!(!rendered(&delivery).contains("effect_failed"));
        drop(listener);
    }

    #[test]
    fn h1_r8_dirty_worktree_without_a_base_is_not_adopted() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"DIRTY_SENTINEL", 0o644);
        let mut collector = fixture.open();
        assert!(collector.state.is_none());
        let missing = SnapshotPair {
            tree: "0123456789abcdef0123456789abcdef01234567".to_string(),
            manifest: "89abcdef0123456789abcdef0123456789abcdef".to_string(),
        };
        let delivery = collector.collect(&command_for(&missing, &missing));
        assert_outcome(&delivery, &recovery("accepted_base_unknown"));
        assert!(!rendered(&delivery).contains("DIRTY_SENTINEL"));
        assert!(collector.state.is_none());
        assert!(!fixture.store().join("state").exists());
        assert!(!collector.git.dir.join("refs/openkit").exists());
    }

    #[test]
    fn h1_r8_deleted_refs_with_surviving_objects_accept_cores_pair() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let git_dir = collector.git.dir.clone();
        drop(collector);
        let _ = fs::remove_dir_all(git_dir.join("refs/openkit"));
        let _ = fs::remove_file(git_dir.join("packed-refs"));
        let mut reopened = fixture.open();
        assert!(reopened.state.is_none());
        let delivery = reopened.collect(&command_for(&base, &base));
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"no_new_head","unstable":false}}"#,
                "ab".repeat(32)
            ),
        );
        assert_eq!(reopened.state.as_ref().unwrap().head, base);
        assert_eq!(reopened.state.as_ref().unwrap().accepted, base);
    }

    #[test]
    fn h1_r9_recovery_causes_stay_specific_and_do_not_advance() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"0", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let missing = SnapshotPair {
            tree: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            manifest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        };
        let unavailable = collector.collect(&command_for(&base, &missing));
        assert_outcome(&unavailable, &recovery("snapshot_unavailable"));
        assert_eq!(collector.state.as_ref().unwrap().head, base);

        fs::set_permissions(
            fixture.worktree().join("a"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let metadata = collector.collect(&command_for(&base, &base));
        assert_outcome(&metadata, &recovery("metadata_unavailable"));
        fs::set_permissions(
            fixture.worktree().join("a"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(collector.state.as_ref().unwrap().head, base);

        let empty = collector.mktree(b"").unwrap();
        let mut payload = Vec::new();
        push_mktree(&mut payload, "040000", "tree", &empty, b"empty");
        let tree = collector.mktree(&payload).unwrap();
        let installed = collector.install_unverified(&tree, b"0755 5 empty\n");
        let disagreement = collector.collect(&command_for(&installed, &installed));
        assert_outcome(&disagreement, &recovery("tree_manifest_disagreement"));
        assert_eq!(collector.state.as_ref().unwrap().head, installed);

        let oid = "0123456789abcdef0123456789abcdef01234567";
        let duplicate = format!("100644 blob {oid}\ta\0100644 blob {oid}\ta\0");
        assert!(matches!(
            index_listing(duplicate.as_bytes()),
            Err(ScanFault::Disagreement)
        ));
    }

    #[test]
    fn h1_r12_candidate_round_trip_applies_binary_kind_and_full_modes() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("gone"), b"gone", 0o644);
        write_file(&fixture.worktree().join("dir/bin"), b"hi\0there", 0o644);
        write_file(&fixture.worktree().join("plain"), b"plain", 0o644);
        write_file(&fixture.worktree().join("a b\nc"), b"lf", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::remove_file(fixture.worktree().join("gone")).unwrap();
        write_file(&fixture.worktree().join("dir/bin"), b"hi\0there!", 0o755);
        fs::set_permissions(
            fixture.worktree().join("plain"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        symlink("dir/bin", fixture.worktree().join("link")).unwrap();
        let delivery = collector.collect(&command_for(&base, &base));
        let found = candidate(&delivery);
        let body = found.body.bytes();
        assert!(
            body.windows(b"GIT binary patch".len())
                .any(|item| item == b"GIT binary patch")
                || body
                    .windows(b"literal ".len())
                    .any(|item| item == b"literal ")
        );
        let marker = b"openkit-full-mode-delta\n";
        let split = body
            .windows(marker.len())
            .position(|item| item == marker)
            .unwrap();
        let diff = &body[..split];
        let modes = &body[split + marker.len()..];
        assert!(modes.windows(9).any(|item| item == b"0644 0755"));
        assert!(modes.windows(9).any(|item| item == b"0644 0600"));
        let records = decode_manifest(&collector.read_blob(&found.head.manifest).unwrap()).unwrap();
        assert!(
            records
                .iter()
                .any(|(path, mode)| path == b"a b\nc" && *mode == 0o644)
        );
        assert!(
            records
                .iter()
                .any(|(path, mode)| path == b"dir/bin" && *mode == 0o755)
        );
        assert!(
            records
                .iter()
                .any(|(path, mode)| path == b"plain" && *mode == 0o600)
        );
        assert!(records.iter().any(|(path, _)| path == b"dir"));
        assert!(!records.iter().any(|(path, _)| path == b"gone"));
        let apply_root = fixture.root.join("apply");
        fs::create_dir_all(apply_root.join("dir")).unwrap();
        fs::write(apply_root.join("gone"), b"gone").unwrap();
        fs::write(apply_root.join("dir/bin"), b"hi\0there").unwrap();
        fs::write(apply_root.join("plain"), b"plain").unwrap();
        fs::write(apply_root.join("a b\nc"), b"lf").unwrap();
        let patch = apply_root.join("candidate.diff");
        fs::write(&patch, diff).unwrap();
        let applied = Command::new("/usr/bin/git")
            .current_dir(&apply_root)
            .env_clear()
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("LC_ALL", "C")
            .args([
                "apply",
                "--binary",
                "--whitespace=nowarn",
                patch.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(applied.success(), "candidate diff did not apply");
        assert!(!apply_root.join("gone").exists());
        assert_eq!(fs::read(apply_root.join("dir/bin")).unwrap(), b"hi\0there!");
        assert_eq!(
            fs::read_link(apply_root.join("link")).unwrap(),
            PathBuf::from("dir/bin")
        );
        assert_eq!(fs::read(apply_root.join("plain")).unwrap(), b"plain");
        assert_eq!(
            fs::metadata(apply_root.join("dir/bin")).unwrap().mode() & 0o7777,
            0o755
        );
        assert_eq!(fs::read(apply_root.join("a b\nc")).unwrap(), b"lf");
        assert!(!fixture.store().join("state").exists());
    }

    #[test]
    fn h1_collect_result_admissible_boundary_is_the_file_data_ceiling() {
        assert!(collect_result_is_admissible(0));
        assert!(collect_result_is_admissible(COLLECT_CANDIDATE_MAX_BYTES));
        assert!(!collect_result_is_admissible(
            COLLECT_CANDIDATE_MAX_BYTES + 1
        ));
        assert_eq!(COLLECT_CANDIDATE_MAX_BYTES, 256 * 1024 * 1024);
    }
    #[test]
    fn h1_r3_unchanged_manifest_current_path_secret() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("PATH_SECRET"), b"before", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("PATH_SECRET"), b"after", 0o644);
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["PATH_SECRET".to_string()];
        assert!(rendered(&collector.collect(&command)).contains("\"outcome\":\"credential_hit\""));
        collector.verify_pair(&base).unwrap();
    }

    #[test]
    fn h1_r3_observer_does_not_buffer_content() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 1234567890"]);
        let mut seen = 0;
        let outcome = capture(
            &mut command,
            StdinSource::None,
            false,
            128,
            0,
            Instant::now() + Duration::from_secs(1),
            Some(&mut |chunk| {
                seen += chunk.len();
                Ok(true)
            }),
        )
        .unwrap();
        assert_eq!(seen, 10);
        assert!(outcome.stdout.is_empty());
    }

    #[test]
    fn h1_r3_child_exit_uses_absolute_deadline() {
        let start = Instant::now();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec 1>&-; sleep 0.4"]);
        assert!(
            capture(
                &mut command,
                StdinSource::None,
                false,
                128,
                0,
                start + Duration::from_millis(30),
                None
            )
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn h1_r3_publish_failure_cleans_attempt() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"old", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(&fixture.worktree().join("a"), b"new", 0o644);
        collector.hooks.fail_publish_at = Some(collector.hooks.publish_count + 2);
        assert_outcome(
            &collector.collect(&command_for(&base, &base)),
            &failed_json(),
        );
        assert!(!collector.git.attempt.exists());
        fixture.open().verify_pair(&base).unwrap();
    }

    #[test]
    fn h1_r3_additive_duplicate_names_are_schema_scoped() {
        let mut body = serde_json::to_string(&valid_command()).unwrap();
        body.pop();
        body.push_str(r#","extra":{"tree":1,"tree":2}}"#);
        assert!(validate_collect_command(body.as_bytes()).is_ok());
    }

    #[test]
    fn h1_r3_gitignore_differential_patterns() {
        for (rules, path) in [
            (
                "**/cache
",
                "a/b/cache",
            ),
            (
                "[ab].log
",
                "a.log",
            ),
            (
                "foo 
", "foo",
            ),
            (
                r"\#secret
",
                "#secret",
            ),
            (
                "/root-only
",
                "root-only",
            ),
            (
                "*.log
!keep.log
",
                "drop.log",
            ),
            (
                "cache/
",
                "cache/child",
            ),
        ] {
            let fixture = Fixture::new();
            write_file(&fixture.worktree().join("base"), b"base", 0o644);
            let mut collector = fixture.open();
            let base = collector.retain_worktree_as_base();
            write_file(
                &fixture.worktree().join(".gitignore"),
                rules.as_bytes(),
                0o644,
            );
            write_file(&fixture.worktree().join(path), b"IGNORED", 0o644);
            worker_git(&fixture.worktree(), &["init", "-q"]);
            assert!(
                Command::new("/usr/bin/git")
                    .env_clear()
                    .current_dir(fixture.worktree())
                    .args(["check-ignore", "--quiet", "--", path])
                    .status()
                    .unwrap()
                    .success()
            );
            let delivery = collector.collect(&command_for(&base, &base));
            assert!(
                !manifest_paths(&collector, &candidate(&delivery).head.manifest)
                    .contains(&path.as_bytes().to_vec()),
                "{rules:?} {path}"
            );
        }
    }

    #[test]
    fn h1_r3_baseline_is_unacknowledged_and_checks_all_sources() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join(".gitignore"), b"ignored\n", 0o644);
        write_file(&fixture.worktree().join("ignored"), b"base", 0o600);
        write_file(&fixture.worktree().join("PATH_ONLY"), b"clean", 0o644);
        let mut raw = valid_command();
        raw["mode"] = json!("baseline");
        raw["acceptedBase"] = serde_json::Value::Null;
        raw["previousHead"] = serde_json::Value::Null;
        raw["checkValues"]["runtimeEnv"] = json!([]);
        let command = validate_collect_command(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let mut collector = fixture.open();
        let delivery = collector.collect(&command);
        let result: serde_json::Value = serde_json::from_slice(&delivery.body()).unwrap();
        assert_eq!(result["outcome"], "baseline");
        assert_eq!(result.as_object().unwrap().len(), 3);
        let head = required_pair(result.as_object().unwrap(), "head").unwrap();
        assert!(manifest_paths(&collector, &head.manifest).contains(&b"ignored".to_vec()));
        assert!(collector.state.is_none());
        drop(collector);
        let mut reopened = fixture.open();
        assert!(reopened.state.is_none());
        reopened.verify_pair(&head).unwrap();
        let mut checked = command.clone();
        checked.runtime_env = vec!["PATH_ONLY".into()];
        assert!(rendered(&reopened.collect(&checked)).contains("\"outcome\":\"credential_hit\""));
        reopened.verify_pair(&head).unwrap();
        let unchanged = reopened.collect(&command_for(&head, &head));
        assert!(rendered(&unchanged).contains("\"outcome\":\"no_new_head\""));
        assert!(rendered(&reopened.collect(&command)).contains("\"outcome\":\"effect_failed\""));
    }

    #[test]
    fn h1_r3_baseline_instability_protects_no_pair() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"first", 0o644);
        let mut command = command_for(
            &SnapshotPair {
                tree: String::new(),
                manifest: String::new(),
            },
            &SnapshotPair {
                tree: String::new(),
                manifest: String::new(),
            },
        );
        command.mode = CollectMode::Baseline;
        let mut collector = fixture.open();
        let delivery = collector.collect_between(&command, || {
            write_file(&fixture.worktree().join("a"), b"second", 0o644);
        });
        assert_eq!(
            rendered(&delivery),
            format!(
                r#"{{"requestId":"{}","outcome":"recovery_required","cause":"baseline_unstable"}}"#,
                command.request_id
            )
        );
        assert!(collector.protection_pairs().unwrap().is_empty());
        assert!(!collector.git.attempt.exists());
    }

    #[test]
    fn h1_r3_metadata_components_are_excluded_before_open_in_both_modes() {
        for baseline in [false, true] {
            let fixture = Fixture::new();
            write_file(&fixture.worktree().join("base"), b"base", 0o644);
            let mut collector = fixture.open();
            let base = if baseline {
                SnapshotPair {
                    tree: String::new(),
                    manifest: String::new(),
                }
            } else {
                collector.retain_worktree_as_base()
            };
            write_file(
                &fixture.worktree().join("empty/.GiT/secret"),
                b"SECRET",
                0o644,
            );
            write_file(&fixture.worktree().join("a/.GIT"), b"SECRET", 0o644);
            make_fifo(&fixture.worktree().join(".git"));
            for name in [".gitignore", ".gitattributes", ".gitmodules"] {
                write_file(&fixture.worktree().join(name), b"", 0o644);
            }
            let mut command = command_for(&base, &base);
            if baseline {
                command.mode = CollectMode::Baseline;
            }
            command.runtime_env = vec!["SECRET".into()];
            let delivery = collector.collect(&command);
            let pair = match &delivery {
                WorkspaceCollectDelivery::Candidate(candidate) => candidate.head.clone(),
                WorkspaceCollectDelivery::Json { body, .. } => {
                    let value: serde_json::Value = serde_json::from_slice(body).unwrap();
                    assert_eq!(value["outcome"], "baseline");
                    required_pair(value.as_object().unwrap(), "head").unwrap()
                }
            };
            let paths = manifest_paths(&collector, &pair.manifest);
            assert!(!paths.iter().any(|path| {
                path.split(|byte| *byte == b'/')
                    .any(|component| component.eq_ignore_ascii_case(b".git"))
            }));
            assert!(!paths.contains(&b"empty".to_vec()));
            assert!(!paths.contains(&b"a".to_vec()));
            for name in [".gitignore", ".gitattributes", ".gitmodules"] {
                assert!(paths.contains(&name.as_bytes().to_vec()));
            }
        }
    }

    #[test]
    fn h1_r3_closed_mode_and_inclusive_json_depth() {
        let mut value = valid_command();
        for mode in ["unknown", ""] {
            value["mode"] = json!(mode);
            assert!(validate_collect_command(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        value["mode"] = json!("capture");
        let mut body = serde_json::to_string(&value).unwrap();
        body.pop();
        let at = format!("{body},\"extra\":{}0{}}}", "[".repeat(127), "]".repeat(127));
        assert!(validate_collect_command(at.as_bytes()).is_ok());
        let over = format!("{body},\"extra\":{}0{}}}", "[".repeat(128), "]".repeat(128));
        assert!(validate_collect_command(over.as_bytes()).is_err());
        let hostile = format!(
            "{body},\"extra\":{}0{}}}",
            "[".repeat(20000),
            "]".repeat(20000)
        );
        assert!(validate_collect_command(hostile.as_bytes()).is_err());
        let duplicate = body.replacen("\"mode\"", "\"mode\":\"baseline\",\"mo\\u0064e\"", 1) + "}";
        assert!(validate_collect_command(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn h1_r3_fifo_substitution_is_nonblocking_and_rejected() {
        let fixture = Fixture::new();
        let path = fixture.worktree().join("a");
        write_file(&path, b"base", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let root = open_nofollow_dir(&fixture.worktree()).unwrap();
        let listed = fstatat_nofollow(&root, OsStr::new("a")).unwrap();
        collector.hooks.before_file_open = Some(Box::new(move || {
            fs::remove_file(&path).unwrap();
            make_fifo(&path);
        }));
        assert_outcome(
            &collector.collect(&command_for(&base, &base)),
            &failed_json(),
        );
        // Bound the substituted open itself, excluding unrelated Git process scheduling.
        let start = Instant::now();
        assert!(
            collector
                .visit_file(&root, OsStr::new("a"), b"a", &listed, &mut Vec::new())
                .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn h1_r3_publication_boundary_failures_preserve_complete_pairs() {
        for boundary in [
            "copy-mid",
            "protection-object",
            "protection-fanout",
            "protection-objects",
            "object-file",
            "object-directory",
            "before-ref",
            "ref-file",
            "ref-directory",
            "refs-directory",
            "git-directory",
            "before-prune",
            "after-prune",
        ] {
            let fixture = Fixture::new();
            write_file(&fixture.worktree().join("a"), b"base", 0o644);
            let mut collector = fixture.open();
            let base = collector.retain_worktree_as_base();
            fs::set_permissions(
                fixture.worktree().join("a"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
            let first_delivery = collector.collect(&command_for(&base, &base));
            let head = candidate(&first_delivery).head.clone();
            collector.collect(&command_for(&base, &head));
            write_file(&fixture.worktree().join("a"), b"next", 0o644);
            FS_FAIL.set(Some(boundary));
            let failed = collector.collect(&command_for(&base, &head));
            FS_FAIL.set(None);
            assert_outcome(&failed, &failed_json());
            assert!(!collector.git.attempt.exists(), "{boundary}");
            drop(collector);
            let mut reopened = fixture.open();
            reopened.verify_pair(&base).unwrap();
            reopened.verify_pair(&head).unwrap();
            assert!(
                matches!(
                    reopened.collect(&command_for(&base, &head)),
                    WorkspaceCollectDelivery::Candidate(_)
                ),
                "{boundary}"
            );
        }
    }

    #[test]
    fn h1_r3_crash_child() {
        let Ok(path) = std::env::var("OPENKIT_H1_CRASH_ROOT") else {
            return;
        };
        let label = std::env::var("OPENKIT_H1_CRASH_BOUNDARY").unwrap();
        let fixture = Fixture {
            root: PathBuf::from(path),
        };
        let mut collector = fixture.open();
        let base = collector.state.as_ref().unwrap().accepted.clone();
        let head = collector.state.as_ref().unwrap().head.clone();
        let label = match label.as_str() {
            "after-promotion" => "after-promotion",
            "before-ref" => "before-ref",
            "ref-file" => "ref-file",
            "before-prune" => "before-prune",
            "after-prune" => "after-prune",
            _ => panic!("invalid child boundary"),
        };
        FS_CRASH.set(Some(label));
        collector.collect(&command_for(&base, &head));
        panic!("crash boundary not reached");
    }

    #[test]
    fn h1_r3_process_interruption_reopens_complete_selection() {
        for boundary in [
            "after-promotion",
            "before-ref",
            "ref-file",
            "before-prune",
            "after-prune",
        ] {
            let fixture = Fixture::new();
            write_file(&fixture.worktree().join("a"), b"base", 0o644);
            let mut collector = fixture.open();
            let base = collector.retain_worktree_as_base();
            write_file(&fixture.worktree().join("a"), b"head", 0o600);
            let head_delivery = collector.collect(&command_for(&base, &base));
            let head = candidate(&head_delivery).head.clone();
            collector.collect(&command_for(&base, &head));
            drop(collector);
            write_file(&fixture.worktree().join("a"), b"unrecorded", 0o644);
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "workspace_collect::tests::h1_r3_crash_child",
                    "--nocapture",
                ])
                .env("OPENKIT_H1_CRASH_ROOT", &fixture.root)
                .env("OPENKIT_H1_CRASH_BOUNDARY", boundary)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("child stalled: {boundary}");
                }
                thread::sleep(Duration::from_millis(10));
            };
            assert_eq!(status.code(), Some(86), "{boundary}");
            let mut reopened = fixture.open();
            reopened.verify_pair(&base).unwrap();
            reopened.verify_pair(&head).unwrap();
            assert!(matches!(
                reopened.collect(&command_for(&base, &head)),
                WorkspaceCollectDelivery::Candidate(_)
            ));
        }
    }

    #[test]
    fn h1_r3_hostile_git_child() {
        let Ok(path) = std::env::var("OPENKIT_H1_HOSTILE_ROOT") else {
            return;
        };
        let fixture = Fixture {
            root: PathBuf::from(path),
        };
        let marker = fixture.root.join("EXECUTED");
        write_file(&fixture.worktree().join("a"), b"raw\r\nbytes\0", 0o644);
        write_file(
            &fixture.worktree().join(".gitattributes"),
            b"* filter=hostile diff=hostile text eol=crlf\n",
            0o644,
        );
        let bad = fixture.root.join("bad-config");
        let included = fixture.root.join("included");
        write_file(&included, b"not valid git configuration", 0o600);
        let script = fixture.root.join("hostile-hook");
        write_file(
            &script,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()).as_bytes(),
            0o755,
        );
        write_file(
            &bad,
            format!("[include]\npath = {}\n", included.display()).as_bytes(),
            0o600,
        );
        write_file(&fixture.worktree().join(".git/config"), format!(
            "[include]\npath = {}\n[filter \"hostile\"]\nclean = {}\nrequired = true\n[diff \"hostile\"]\ncommand = {}\n[core]\nhooksPath = {}\nattributesFile = {}\nexcludesFile = {}\n",
            included.display(), script.display(), script.display(), fixture.root.display(),
            included.display(), included.display()).as_bytes(), 0o600);
        write_file(
            &fixture.worktree().join(".git/objects/info/alternates"),
            b"/outside-unavailable\n",
            0o600,
        );
        write_file(
            &fixture.root.join("template/TEMPLATE_WAS_USED"),
            b"unsafe",
            0o600,
        );
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        let oid = collector
            .ls_tree(&base.tree)
            .unwrap()
            .get(b"a".as_slice())
            .unwrap()
            .oid
            .clone();
        let raw = collector
            .git
            .run(
                &["cat-file", "blob", &oid],
                StdinSource::None,
                false,
                64,
                false,
                collector.deadline_at(),
            )
            .unwrap();
        assert_eq!(raw, b"raw\r\nbytes\0");
        write_file(&fixture.worktree().join("a"), b"after\r\nbytes\0", 0o644);
        assert!(matches!(
            collector.collect(&command_for(&base, &base)),
            WorkspaceCollectDelivery::Candidate(_)
        ));
        assert!(!marker.exists());
        assert!(!collector.git.dir.join("TEMPLATE_WAS_USED").exists());
        assert!(
            collector
                .git
                .dir
                .join("hooks")
                .read_dir()
                .map_or(true, |mut files| files.next().is_none())
        );
    }

    #[test]
    fn h1_r3_hostile_git_input_matrix() {
        for category in [
            "attributes-filters-hooks",
            "templates",
            "config-includes",
            "gitdir-alternates",
            "environment",
        ] {
            let fixture = Fixture::new();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "workspace_collect::tests::h1_r3_hostile_git_child",
                    "--nocapture",
                ])
                .env("OPENKIT_H1_HOSTILE_ROOT", &fixture.root);
            match category {
                "templates" => {
                    command.env("GIT_TEMPLATE_DIR", fixture.root.join("template"));
                }
                "config-includes" => {
                    command
                        .env("GIT_CONFIG_GLOBAL", fixture.root.join("bad-config"))
                        .env("GIT_CONFIG_SYSTEM", fixture.root.join("bad-config"));
                }
                "gitdir-alternates" => {
                    command
                        .env("GIT_DIR", fixture.worktree().join(".git"))
                        .env("GIT_COMMON_DIR", fixture.worktree().join(".git"))
                        .env(
                            "GIT_OBJECT_DIRECTORY",
                            fixture.worktree().join(".git/objects"),
                        )
                        .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", "/unavailable");
                }
                "environment" => {
                    command
                        .env("GIT_CONFIG_COUNT", "1")
                        .env("GIT_CONFIG_KEY_0", "include.path")
                        .env("GIT_CONFIG_VALUE_0", fixture.root.join("included"))
                        .env("GIT_INDEX_FILE", "/unavailable")
                        .env("GIT_EXTERNAL_DIFF", fixture.root.join("hostile-hook"))
                        .env("XDG_CONFIG_HOME", &fixture.root);
                }
                _ => {}
            }
            let mut child = command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("matrix timeout: {category}");
                }
                thread::sleep(Duration::from_millis(10));
            }
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{category}: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    #[test]
    fn h1_r3_opened_file_kind_is_checked_before_reading() {
        let fixture = Fixture::new();
        let path = fixture.worktree().join("a");
        write_file(&path, b"base", 0o644);
        let mut collector = fixture.open();
        collector.begin_attempt().unwrap();
        let root = open_nofollow_dir(&fixture.worktree()).unwrap();
        let listed = fstatat_nofollow(&root, OsStr::new("a")).unwrap();
        fs::remove_file(&path).unwrap();
        make_fifo(&path);
        let mut entries = Vec::new();
        assert!(
            collector
                .visit_file(&root, OsStr::new("a"), b"a", &listed, &mut entries)
                .is_err()
        );
        assert!(entries.is_empty());
        assert!(collector.hooks.attempt_objects.is_empty());
    }

    #[test]
    fn h1_r3_physical_usage_includes_preexisting_store_after_reopen() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        write_file(
            &fixture.store().join("unreachable-residue"),
            &[0u8; 65536],
            0o600,
        );
        drop(collector);
        let mut reopened = fixture.open();
        reopened.limits.store_bytes = 65536;
        assert!(reopened.check_capacity(0, 0).is_err());
        reopened.verify_pair(&base).unwrap();
        assert!(fixture.worktree().join("a").exists());
    }
    #[test]
    fn h1_r3_lost_baseline_does_not_authorize_a_private_cursor() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        let absent = SnapshotPair {
            tree: String::new(),
            manifest: String::new(),
        };
        let mut command = command_for(&absent, &absent);
        command.mode = CollectMode::Baseline;
        let mut collector = fixture.open();
        let first: serde_json::Value =
            serde_json::from_slice(&collector.collect(&command).body()).unwrap();
        assert_eq!(first["outcome"], "baseline");
        drop(collector);
        write_file(&fixture.worktree().join("a"), b"changed", 0o600);
        command.request_id = "cd".repeat(32);
        command.collection_id = "new-authorized-baseline".into();
        let mut reopened = fixture.open();
        let next: serde_json::Value =
            serde_json::from_slice(&reopened.collect(&command).body()).unwrap();
        assert_eq!(next["outcome"], "baseline");
        assert_ne!(first["head"], next["head"]);
        assert!(reopened.state.is_none());
    }
    #[test]
    fn h1_r3_corrupt_existing_promotion_object_is_never_accepted() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        collector.begin_attempt().unwrap();
        let oid = collector.write_blob(b"new unique promotion bytes").unwrap();
        let fanout = collector.git.dir.join("objects").join(&oid[..2]);
        create_private_dir(&fanout).unwrap();
        let destination = fanout.join(&oid[2..]);
        fs::write(&destination, b"truncated").unwrap();
        assert!(collector.promote_loose().is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"truncated");
        collector.remove_attempt().unwrap();
        collector.verify_pair(&base).unwrap();
    }
    #[test]
    fn h1_r3_baseline_prune_failure_is_not_success() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        let absent = SnapshotPair {
            tree: String::new(),
            manifest: String::new(),
        };
        let mut command = command_for(&absent, &absent);
        command.mode = CollectMode::Baseline;
        let mut collector = fixture.open();
        collector.hooks.fail_prune = true;
        assert_outcome(&collector.collect(&command), &failed_json());
        let protected = collector.protection_pairs().unwrap();
        collector
            .verify_pair(protected.get("baseline").unwrap())
            .unwrap();
        assert!(!collector.git.attempt.exists());
        collector.hooks.fail_prune = false;
        command.request_id = "cd".repeat(32);
        let result: serde_json::Value =
            serde_json::from_slice(&collector.collect(&command).body()).unwrap();
        assert_eq!(result["outcome"], "baseline");
        assert!(collector.state.is_none());
    }
    #[test]
    fn h1_r4_same_oid_file_to_symlink_checks_candidate_source() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"TYPE_SECRET", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::remove_file(fixture.worktree().join("a")).unwrap();
        symlink("TYPE_SECRET", fixture.worktree().join("a")).unwrap();
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["TYPE_SECRET".into()];
        let delivery = collector.collect(&command);
        if let WorkspaceCollectDelivery::Candidate(candidate) = &delivery {
            assert!(
                candidate
                    .body
                    .bytes()
                    .windows(11)
                    .any(|part| part == b"TYPE_SECRET")
            );
            eprintln!("file_to_symlink: candidate contains TYPE_SECRET");
        }
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                command.request_id
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().accepted, base);
        assert!(collector.state.as_ref().unwrap().unacknowledged.is_none());
        collector.verify_pair(&base).unwrap();
    }

    #[test]
    fn h1_r4_same_oid_symlink_to_file_checks_candidate_source() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.worktree()).unwrap();
        symlink("TYPE_SECRET", fixture.worktree().join("a")).unwrap();
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::remove_file(fixture.worktree().join("a")).unwrap();
        write_file(&fixture.worktree().join("a"), b"TYPE_SECRET", 0o644);
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["TYPE_SECRET".into()];
        let delivery = collector.collect(&command);
        if let WorkspaceCollectDelivery::Candidate(candidate) = &delivery {
            assert!(
                candidate
                    .body
                    .bytes()
                    .windows(11)
                    .any(|part| part == b"TYPE_SECRET")
            );
            eprintln!("symlink_to_file: candidate contains TYPE_SECRET");
        }
        assert_outcome(
            &delivery,
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                command.request_id
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().accepted, base);
        assert!(collector.state.as_ref().unwrap().unacknowledged.is_none());
        collector.verify_pair(&base).unwrap();
    }

    #[test]
    fn h1_r4_executable_bit_only_does_not_check_unchanged_content() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"TYPE_SECRET", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::set_permissions(
            fixture.worktree().join("a"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let mut command = command_for(&base, &base);
        command.runtime_env = vec!["TYPE_SECRET".into()];
        let delivery = collector.collect(&command);
        let candidate = candidate(&delivery);
        assert!(
            !candidate
                .body
                .bytes()
                .windows(11)
                .any(|part| part == b"TYPE_SECRET")
        );
        assert_ne!(candidate.head, base);
        collector.verify_pair(&base).unwrap();
    }

    #[test]
    fn h1_r4_ignored_names_do_not_spend_encoded_manifest_budget() {
        let fixture = Fixture::new();
        let ignored = "x".repeat(80);
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        write_file(
            &fixture.worktree().join(".gitignore"),
            format!("{ignored}\n").as_bytes(),
            0o644,
        );
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        assert_eq!(collector.read_blob(&base.manifest).unwrap().len(), 28);
        let command = command_for(&base, &base);
        collector.limits.metadata_bytes = 28;
        assert!(rendered(&collector.collect(&command)).contains("no_new_head"));
        write_file(&fixture.worktree().join(&ignored), b"ignored", 0o644);
        let delivery = collector.collect(&command);
        eprintln!(
            "ignored 80-byte name with 28-byte manifest: {}",
            rendered(&delivery)
        );
        assert!(rendered(&delivery).contains("no_new_head"));
        collector.limits.metadata_bytes = 27;
        assert_outcome(&collector.collect(&command), &failed_json());
        collector.limits.metadata_bytes = 28;
        assert!(rendered(&collector.collect(&command)).contains("no_new_head"));
        collector.verify_pair(&base).unwrap();
    }
    #[test]
    fn h1_r4_first_only_same_oid_type_change_is_checked() {
        for base_is_symlink in [false, true] {
            let fixture = Fixture::new();
            fs::create_dir_all(fixture.worktree()).unwrap();
            let path = fixture.worktree().join("a");
            if base_is_symlink {
                symlink("TYPE_SECRET", &path).unwrap();
            } else {
                write_file(&path, b"TYPE_SECRET", 0o644);
            }
            let mut collector = fixture.open();
            let base = collector.retain_worktree_as_base();
            fs::remove_file(&path).unwrap();
            if base_is_symlink {
                write_file(&path, b"TYPE_SECRET", 0o644);
            } else {
                symlink("TYPE_SECRET", &path).unwrap();
            }
            let mut command = command_for(&base, &base);
            command.runtime_env = vec!["TYPE_SECRET".into()];
            let delivery = collector.collect_between(&command, || {
                fs::remove_file(&path).unwrap();
                if base_is_symlink {
                    symlink("TYPE_SECRET", &path).unwrap();
                } else {
                    write_file(&path, b"TYPE_SECRET", 0o644);
                }
            });
            assert_outcome(
                &delivery,
                &format!(
                    r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                    command.request_id
                ),
            );
            assert!(collector.state.as_ref().unwrap().unacknowledged.is_none());
            collector.verify_pair(&base).unwrap();
        }
    }

    #[test]
    fn h1_r4_cumulative_same_oid_type_change_uses_current_checks() {
        let fixture = Fixture::new();
        let path = fixture.worktree().join("a");
        write_file(&path, b"TYPE_SECRET", 0o644);
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        fs::remove_file(&path).unwrap();
        symlink("TYPE_SECRET", &path).unwrap();
        let head = candidate(&collector.collect(&command_for(&base, &base)))
            .head
            .clone();
        let mut command = command_for(&base, &head);
        command.runtime_env = vec!["TYPE_SECRET".into()];
        assert_outcome(
            &collector.collect(&command),
            &format!(
                r#"{{"requestId":"{}","outcome":"credential_hit"}}"#,
                command.request_id
            ),
        );
        assert_eq!(collector.state.as_ref().unwrap().accepted, base);
        collector.verify_pair(&base).unwrap();
        collector.verify_pair(&head).unwrap();
    }

    #[test]
    fn h1_r4_ignore_batches_preserve_exclusion_and_entry_count() {
        let fixture = Fixture::new();
        write_file(&fixture.worktree().join("a"), b"base", 0o644);
        write_file(
            &fixture.worktree().join(".gitignore"),
            b"ignored-*\n",
            0o644,
        );
        let mut collector = fixture.open();
        let base = collector.retain_worktree_as_base();
        for index in 0..900 {
            make_fifo(
                &fixture
                    .worktree()
                    .join(format!("ignored-{index:04}-{}", "x".repeat(70))),
            );
        }
        collector.limits.metadata_bytes = 28;
        collector.limits.entries = 902;
        assert!(rendered(&collector.collect(&command_for(&base, &base))).contains("no_new_head"));
        collector.limits.entries = 901;
        assert_outcome(
            &collector.collect(&command_for(&base, &base)),
            &failed_json(),
        );
        collector.limits.entries = 902;
        assert!(rendered(&collector.collect(&command_for(&base, &base))).contains("no_new_head"));
        collector.verify_pair(&base).unwrap();
    }
}
