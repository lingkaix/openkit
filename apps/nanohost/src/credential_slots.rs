//! Execution-host NanoHost Token slot-pair owner.
//!
//! Owns the stable A/B credential slots outside Runtime Epoch identity: writing
//! and reading `0600` service credential files and their non-secret companion
//! metadata, and selecting the usable higher issuance-generation material for
//! the configured NanoHost identity and deployment.
//!
//! This module is the S-2b-2 credential owner under the NanoCore-session role
//! boundary. It does not open a NanoCore session, perform TLS, fall back after
//! authentication rejection, search outside the two declared slots, or invent a
//! second secret format.
//!
//! The selection and write APIs are intentionally unused by `main` until a later
//! session lease consumes them; dead_code is allowed until that consumer lands.

#![allow(dead_code)]

use std::fs::{self, File};
use std::path::{Path, PathBuf};

/// Declared execution-host credential slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSlot {
    /// Slot A.
    A,
    /// Slot B.
    B,
}

/// Fixed deployment-configured paths for the stable slot pair and companions.
///
/// Slot locations are stable configuration and are not part of epoch identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotPairPaths {
    /// Raw secret path for slot A (`0600` service credential file).
    pub slot_a_secret: PathBuf,
    /// Non-secret companion metadata path for slot A.
    pub slot_a_companion: PathBuf,
    /// Raw secret path for slot B (`0600` service credential file).
    pub slot_b_secret: PathBuf,
    /// Non-secret companion metadata path for slot B.
    pub slot_b_companion: PathBuf,
}

/// Configured NanoHost identity and deployment used to filter companion metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSelectionContext {
    /// Configured NanoHost identity id.
    pub identity_id: String,
    /// Declared deployment id.
    pub deployment_id: String,
}

/// Result of runtime credential selection at connection time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectedCredential {
    /// Exactly one usable slot's material for presentation on the next attempt.
    Usable {
        /// Selected slot.
        slot: CredentialSlot,
        /// Token id from companion metadata.
        token_id: String,
        /// Issuance generation from companion metadata.
        issuance_generation: u64,
        /// Raw `okt_` secret from the selected slot.
        secret: String,
    },
    /// Both slots empty or ambiguous; the NanoHost remains non-ready.
    Empty,
}

/// Companion metadata on-disk projection (non-secret; no hash).
///
/// Line-oriented UTF-8 with exactly these keys, one `key=value` per line:
/// `token_id`, `issuance_generation`, `identity_id`, `deployment_id`.
/// Companion metadata is an ordering hint only; NanoCore verification remains
/// the sole authority.
pub const COMPANION_TOKEN_ID_KEY: &str = "token_id";
/// Issuance generation companion key.
pub const COMPANION_ISSUANCE_GENERATION_KEY: &str = "issuance_generation";
/// Owning NanoHost identity companion key.
pub const COMPANION_IDENTITY_ID_KEY: &str = "identity_id";
/// Declared deployment companion key.
pub const COMPANION_DEPLOYMENT_ID_KEY: &str = "deployment_id";

/// Required file mode for file-backed secret and companion material.
const REQUIRED_FILE_MODE: u32 = 0o600;

/// Parsed non-secret companion fields used for usability and ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CompanionMetadata {
    token_id: String,
    issuance_generation: u64,
    identity_id: String,
    deployment_id: String,
}

/// Usable material loaded from exactly one declared slot.
#[derive(Debug, Clone, PartialEq, Eq)]
struct UsableSlotMaterial {
    slot: CredentialSlot,
    token_id: String,
    issuance_generation: u64,
    secret: String,
}

/// Reads both declared slots and returns only the usable higher-generation
/// credential for the configured identity and deployment.
///
/// Selection rules (accepted owner):
/// - Read only the two declared slot paths; search nowhere else.
/// - A slot is usable only when its secret and companion are present, mode
///   `0600`, companion metadata parses, identity/deployment match context, and
///   the secret is raw `okt_` material.
/// - Missing, malformed, wrong-identity, wrong-deployment, or
///   generation-ambiguous companion metadata is treated as empty for that slot.
/// - Generation comes only from companion metadata, never mtime, filename, or
///   content length.
/// - When two usable slots share the same generation, the result is `Empty`.
/// - This function does not fall back to the other slot after a later
///   authentication rejection; callers present at most the selected material.
pub fn select_usable_credential(
    paths: &SlotPairPaths,
    context: &CredentialSelectionContext,
) -> SelectedCredential {
    let Ok(_lock) = SlotPairLock::acquire(paths) else {
        return SelectedCredential::Empty;
    };
    let slot_a = load_usable_slot(
        CredentialSlot::A,
        &paths.slot_a_secret,
        &paths.slot_a_companion,
        context,
    );
    let slot_b = load_usable_slot(
        CredentialSlot::B,
        &paths.slot_b_secret,
        &paths.slot_b_companion,
        context,
    );
    select_from_usable_slots(slot_a, slot_b)
}

/// Chooses among at most two independently loaded usable slots.
fn select_from_usable_slots(
    slot_a: Option<UsableSlotMaterial>,
    slot_b: Option<UsableSlotMaterial>,
) -> SelectedCredential {
    match (slot_a, slot_b) {
        (None, None) => SelectedCredential::Empty,
        (Some(only), None) | (None, Some(only)) => SelectedCredential::Usable {
            slot: only.slot,
            token_id: only.token_id,
            issuance_generation: only.issuance_generation,
            secret: only.secret,
        },
        (Some(a), Some(b)) => {
            if a.issuance_generation == b.issuance_generation {
                SelectedCredential::Empty
            } else if a.issuance_generation > b.issuance_generation {
                SelectedCredential::Usable {
                    slot: a.slot,
                    token_id: a.token_id,
                    issuance_generation: a.issuance_generation,
                    secret: a.secret,
                }
            } else {
                SelectedCredential::Usable {
                    slot: b.slot,
                    token_id: b.token_id,
                    issuance_generation: b.issuance_generation,
                    secret: b.secret,
                }
            }
        }
    }
}

/// Loads one declared slot; any usability failure yields `None` (empty).
fn load_usable_slot(
    slot: CredentialSlot,
    secret_path: &Path,
    companion_path: &Path,
    context: &CredentialSelectionContext,
) -> Option<UsableSlotMaterial> {
    if !is_exact_mode_0600(secret_path) || !is_exact_mode_0600(companion_path) {
        return None;
    }
    let secret = read_okt_secret(secret_path)?;
    let companion = read_companion_metadata(companion_path)?;
    if companion.identity_id != context.identity_id
        || companion.deployment_id != context.deployment_id
    {
        return None;
    }
    Some(UsableSlotMaterial {
        slot,
        token_id: companion.token_id,
        issuance_generation: companion.issuance_generation,
        secret,
    })
}

/// Returns true only when the path exists as a file with mode exactly `0600`.
fn is_exact_mode_0600(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => return false,
        };
        if !metadata.is_file() {
            return false;
        }
        metadata.permissions().mode() & 0o777 == REQUIRED_FILE_MODE
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// Reads raw `okt_` secret bytes as UTF-8.
///
/// A usable secret is `okt_` plus a token body and nothing else. Whitespace,
/// control bytes, and a bare prefix cannot be presented as one header value,
/// so they are empty rather than a higher-generation slot.
fn read_okt_secret(path: &Path) -> Option<String> {
    let secret = fs::read_to_string(path).ok()?;
    usable_okt_secret(&secret).then_some(secret)
}

/// Returns whether `secret` is one presentable raw `okt_` token.
fn usable_okt_secret(secret: &str) -> bool {
    let Some(body) = secret.strip_prefix("okt_") else {
        return false;
    };
    !body.is_empty() && secret.bytes().all(|byte| byte.is_ascii_graphic())
}

/// Parses companion `key=value` lines; malformed or incomplete companions are empty.
fn read_companion_metadata(path: &Path) -> Option<CompanionMetadata> {
    let contents = fs::read_to_string(path).ok()?;
    parse_companion_metadata(&contents)
}

/// Parses the frozen std-only companion projection.
fn parse_companion_metadata(contents: &str) -> Option<CompanionMetadata> {
    let mut token_id: Option<String> = None;
    let mut issuance_generation: Option<u64> = None;
    let mut identity_id: Option<String> = None;
    let mut deployment_id: Option<String> = None;

    for line in contents.lines() {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once('=')?;
        match key {
            COMPANION_TOKEN_ID_KEY => {
                if token_id.is_some() || value.is_empty() {
                    return None;
                }
                token_id = Some(value.to_string());
            }
            COMPANION_ISSUANCE_GENERATION_KEY => {
                if issuance_generation.is_some() {
                    return None;
                }
                issuance_generation = Some(value.parse().ok()?);
            }
            COMPANION_IDENTITY_ID_KEY => {
                if identity_id.is_some() || value.is_empty() {
                    return None;
                }
                identity_id = Some(value.to_string());
            }
            COMPANION_DEPLOYMENT_ID_KEY => {
                if deployment_id.is_some() || value.is_empty() {
                    return None;
                }
                deployment_id = Some(value.to_string());
            }
            _ => return None,
        }
    }

    Some(CompanionMetadata {
        token_id: token_id?,
        issuance_generation: issuance_generation?,
        identity_id: identity_id?,
        deployment_id: deployment_id?,
    })
}

/// Material written once into a named execution-host credential slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotWriteMaterial {
    /// Durable Token id recorded in companion metadata.
    pub token_id: String,
    /// Issuance generation recorded in companion metadata.
    pub issuance_generation: u64,
    /// Owning NanoHost identity id.
    pub identity_id: String,
    /// Declared deployment id.
    pub deployment_id: String,
    /// Raw `okt_` secret written to the slot secret file.
    pub secret: String,
}

/// Error returned when a named slot write cannot be proved.
#[derive(Debug)]
pub struct SlotWriteError {
    /// Stable failure reason without secret material.
    pub message: String,
}

impl std::fmt::Display for SlotWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SlotWriteError {}

/// Writes raw secret and companion metadata into one declared slot at mode `0600`.
///
/// This is the execution-host same-owner delivery surface that matches
/// `select_usable_credential` readability rules. Callers that cannot prove the
/// write MUST leave the Token unusable.
///
/// # Errors
///
/// Returns [`SlotWriteError`] when the secret is not `okt_` material or either
/// file write / mode set fails.
pub fn write_credential_slot(
    paths: &SlotPairPaths,
    slot: CredentialSlot,
    material: &SlotWriteMaterial,
) -> Result<(), SlotWriteError> {
    if !material.secret.starts_with("okt_") || material.secret.is_empty() {
        return Err(SlotWriteError {
            message: "credential slot write requires raw okt_ secret material".to_string(),
        });
    }
    if material.issuance_generation == 0 {
        return Err(SlotWriteError {
            message: "credential slot write requires a positive issuance generation".to_string(),
        });
    }

    let (secret_path, companion_path) = match slot {
        CredentialSlot::A => (&paths.slot_a_secret, &paths.slot_a_companion),
        CredentialSlot::B => (&paths.slot_b_secret, &paths.slot_b_companion),
    };
    let companion = format!(
        "{COMPANION_TOKEN_ID_KEY}={}\n\
         {COMPANION_ISSUANCE_GENERATION_KEY}={}\n\
         {COMPANION_IDENTITY_ID_KEY}={}\n\
         {COMPANION_DEPLOYMENT_ID_KEY}={}\n",
        material.token_id,
        material.issuance_generation,
        material.identity_id,
        material.deployment_id
    );

    #[cfg(unix)]
    {
        let secret_staged = stage_mode_0600(secret_path, &material.secret)
            .map_err(|message| SlotWriteError { message })?;
        let companion_staged = stage_mode_0600(companion_path, &companion)
            .map_err(|message| SlotWriteError { message })?;
        publish_staged_pair(
            paths,
            secret_path,
            secret_staged,
            companion_path,
            companion_staged,
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (secret_path, companion_path, companion);
        Err(SlotWriteError {
            message: "credential slot write requires unix 0600 file semantics".to_string(),
        })
    }
}

/// Publishes a staged secret and companion as one pair.
///
/// The process-shared slot lock covers companion invalidation and both renames.
/// The old companion is removed before the secret is replaced, so a writer that
/// dies between the renames leaves a secret with no valid companion. A reader
/// treats that slot as unusable. Failure to remove the old companion happens
/// before the secret is touched.
#[cfg(unix)]
fn publish_staged_pair(
    paths: &SlotPairPaths,
    secret_path: &Path,
    secret_staged: StagedSlotFile,
    companion_path: &Path,
    companion_staged: StagedSlotFile,
) -> Result<(), SlotWriteError> {
    let _lock = SlotPairLock::acquire(paths)?;
    before_companion_invalidation();
    remove_published_file(companion_path)?;
    secret_staged
        .publish(secret_path)
        .map_err(|message| SlotWriteError { message })?;
    between_pair_publication();
    if companion_publication_rejected() {
        remove_published_file(secret_path)?;
        return Err(SlotWriteError {
            message: "credential companion publication failed".to_string(),
        });
    }
    if let Err(message) = companion_staged.publish(companion_path) {
        remove_published_file(secret_path)?;
        return Err(SlotWriteError { message });
    }
    Ok(())
}

fn before_companion_invalidation() {
    #[cfg(all(test, unix))]
    tests::before_companion_invalidation();
}

fn between_pair_publication() {
    #[cfg(all(test, unix))]
    tests::between_pair_publication();
}

fn companion_publication_rejected() -> bool {
    #[cfg(all(test, unix))]
    {
        tests::companion_publication_rejected()
    }
    #[cfg(not(all(test, unix)))]
    {
        false
    }
}

/// Removes one published slot file. Absence is success; any other error is returned.
fn remove_published_file(path: &Path) -> Result<(), SlotWriteError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SlotWriteError {
            message: format!("credential slot cleanup failed: {error}"),
        }),
    }
}

/// Service state directory that stays writable when the credential sink is not.
///
/// This is the same durable NanoHost directory as the rebuild-fence marker. The
/// slot lock lives here so selection does not need to create a file beside the
/// credential sink, which may be a read-only facility or bind mount.
const NANOHOST_STATE_DIRECTORY: &str = "/var/lib/openkit/nanohost";

/// Stable lock file name. The file is created once and never replaced or removed.
const CREDENTIAL_SLOT_LOCK_FILE_NAME: &str = ".nanohost-credential-slot.lock";

/// Directory that owns the shared slot lock for this process.
///
/// Production uses [`NANOHOST_STATE_DIRECTORY`]. Tests use one private directory
/// under the temp dir so they never create the lock on the host state root.
fn credential_slot_lock_directory() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir().join("nanohost-credential-slot-lock")
    }
    #[cfg(not(test))]
    {
        PathBuf::from(NANOHOST_STATE_DIRECTORY)
    }
}

/// Exclusive lock on the stable service-state slot file.
///
/// Delivery, clearing, and runtime selection in any process take this same
/// mode-`0600` file. The credential sink directory is not used and is not made
/// writable. A caller that cannot take the lock must not read or publish a slot.
struct SlotPairLock {
    file: File,
}

impl SlotPairLock {
    fn acquire(paths: &SlotPairPaths) -> Result<Self, SlotWriteError> {
        // The guarded pair identifies the operation. The lock file does not
        // live beside those paths.
        let _ = paths;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            use std::os::unix::io::AsRawFd;
            let directory = credential_slot_lock_directory();
            fs::create_dir_all(&directory).map_err(|error| SlotWriteError {
                message: error.to_string(),
            })?;
            let lock_path = directory.join(CREDENTIAL_SLOT_LOCK_FILE_NAME);
            let file = fs::OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .mode(REQUIRED_FILE_MODE)
                .open(&lock_path)
                .map_err(|error| SlotWriteError {
                    message: error.to_string(),
                })?;
            let mut permissions = file
                .metadata()
                .map_err(|error| SlotWriteError {
                    message: error.to_string(),
                })?
                .permissions();
            permissions.set_mode(REQUIRED_FILE_MODE);
            fs::set_permissions(&lock_path, permissions).map_err(|error| SlotWriteError {
                message: error.to_string(),
            })?;
            let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
            if locked != 0 {
                Err(SlotWriteError {
                    message: std::io::Error::last_os_error().to_string(),
                })
            } else {
                Ok(Self { file })
            }
        }
        #[cfg(not(unix))]
        {
            let _ = paths;
            Err(SlotWriteError {
                message: "credential slot lock requires unix flock".to_string(),
            })
        }
    }
}

impl Drop for SlotPairLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

/// A mode-`0600` temp that becomes the destination only after [`StagedSlotFile::publish`].
#[cfg(unix)]
struct StagedSlotFile {
    temp: PathBuf,
    published: bool,
}

#[cfg(unix)]
impl Drop for StagedSlotFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.temp);
        }
    }
}

#[cfg(unix)]
impl StagedSlotFile {
    fn publish(mut self, path: &Path) -> Result<(), String> {
        fs::rename(&self.temp, path).map_err(|error| error.to_string())?;
        self.published = true;
        Ok(())
    }
}

/// Stages UTF-8 contents in a new mode-`0600` temp beside `path` without publishing it.
///
/// An existing inode is not truncated in place, so a permissive mode cannot
/// observe the new bytes before the mode is `0600`.
#[cfg(unix)]
fn stage_mode_0600(path: &Path, contents: &str) -> Result<StagedSlotFile, String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| "credential slot path has no file name".to_string())?;
    let parent = parent.unwrap_or_else(|| Path::new("."));
    let nonce = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(file_name);
    temp_name.push(format!(".{}.{nanos}.{nonce}.tmp", std::process::id()));
    let temp_path = parent.join(temp_name);
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(REQUIRED_FILE_MODE)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut permissions = file
            .metadata()
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(REQUIRED_FILE_MODE);
        fs::set_permissions(&temp_path, permissions).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(StagedSlotFile {
            temp: temp_path.clone(),
            published: false,
        })
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

/// Clears one declared credential slot so it no longer holds usable material.
///
/// Removes the slot's secret and companion files when present. Missing paths are
/// treated as already cleared. Used after rotation cutover (clear predecessor)
/// or abort (clear successor) so exactly one slot remains usable at steady state.
///
/// # Errors
///
/// Returns [`SlotWriteError`] when an existing path cannot be removed.
pub fn clear_credential_slot(
    paths: &SlotPairPaths,
    slot: CredentialSlot,
) -> Result<(), SlotWriteError> {
    let (secret_path, companion_path) = match slot {
        CredentialSlot::A => (&paths.slot_a_secret, &paths.slot_a_companion),
        CredentialSlot::B => (&paths.slot_b_secret, &paths.slot_b_companion),
    };
    let _lock = SlotPairLock::acquire(paths)?;
    for path in [secret_path, companion_path] {
        remove_published_file(path)?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;

    thread_local! {
        static PAIR_PUBLICATION_HOOK: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
        static BEFORE_INVALIDATION_HOOK: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
        static REJECT_COMPANION_PUBLICATION: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn between_pair_publication() {
        let hook = PAIR_PUBLICATION_HOOK.with(|hook| hook.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
        }
    }

    pub(super) fn before_companion_invalidation() {
        let hook = BEFORE_INVALIDATION_HOOK.with(|hook| hook.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
        }
    }

    pub(super) fn companion_publication_rejected() -> bool {
        REJECT_COMPANION_PUBLICATION.with(|flag| flag.replace(false))
    }

    fn reject_next_companion_publication() {
        REJECT_COMPANION_PUBLICATION.with(|flag| flag.set(true));
    }

    fn install_pair_publication_hook(hook: impl FnOnce() + 'static) {
        PAIR_PUBLICATION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    fn install_before_invalidation_hook(hook: impl FnOnce() + 'static) {
        BEFORE_INVALIDATION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    struct ClearPairHook;
    impl Drop for ClearPairHook {
        fn drop(&mut self) {
            PAIR_PUBLICATION_HOOK.with(|hook| {
                hook.borrow_mut().take();
            });
            BEFORE_INVALIDATION_HOOK.with(|hook| {
                hook.borrow_mut().take();
            });
            REJECT_COMPANION_PUBLICATION.with(|flag| flag.set(false));
        }
    }

    const IDENTITY: &str = "nanohost_test_identity";
    const DEPLOYMENT: &str = "deployment_test";
    const SECRET_A: &str = "okt_testsecretaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECRET_B: &str = "okt_testsecretbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    static FIXTURE_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        paths: SlotPairPaths,
        context: CredentialSelectionContext,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nanohost-credential-slots-{}-{}-{}",
                std::process::id(),
                FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir_all(&root).expect("temp slot root");
            let paths = SlotPairPaths {
                slot_a_secret: root.join("A.token"),
                slot_a_companion: root.join("A.meta"),
                slot_b_secret: root.join("B.token"),
                slot_b_companion: root.join("B.meta"),
            };
            Self {
                root,
                paths,
                context: CredentialSelectionContext {
                    identity_id: IDENTITY.to_string(),
                    deployment_id: DEPLOYMENT.to_string(),
                },
            }
        }

        fn write_companion(path: &Path, token_id: &str, generation: u64) {
            write_mode(
                path,
                0o600,
                &format!(
                    "{COMPANION_TOKEN_ID_KEY}={token_id}\n\
                     {COMPANION_ISSUANCE_GENERATION_KEY}={generation}\n\
                     {COMPANION_IDENTITY_ID_KEY}={IDENTITY}\n\
                     {COMPANION_DEPLOYMENT_ID_KEY}={DEPLOYMENT}\n"
                ),
            );
        }

        fn write_usable_slot(
            &self,
            slot: CredentialSlot,
            token_id: &str,
            generation: u64,
            secret: &str,
        ) {
            let (secret_path, companion_path) = match slot {
                CredentialSlot::A => (&self.paths.slot_a_secret, &self.paths.slot_a_companion),
                CredentialSlot::B => (&self.paths.slot_b_secret, &self.paths.slot_b_companion),
            };
            write_mode(secret_path, 0o600, secret);
            Self::write_companion(companion_path, token_id, generation);
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_mode(path: &Path, mode: u32, contents: &str) {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(path)
            .expect("open credential fixture");
        file.write_all(contents.as_bytes())
            .expect("write credential fixture");
        let mut permissions = file.metadata().expect("metadata").permissions();
        permissions.set_mode(mode);
        fs::set_permissions(path, permissions).expect("chmod credential fixture");
    }

    #[test]
    fn selects_higher_issuance_generation_when_both_slots_usable() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 1, SECRET_A);
        fixture.write_usable_slot(CredentialSlot::B, "tok_b", 2, SECRET_B);

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::B,
                token_id: "tok_b".to_string(),
                issuance_generation: 2,
                secret: SECRET_B.to_string(),
            },
            "must present only the usable higher-generation slot"
        );
    }

    #[test]
    fn newline_or_bare_prefix_cannot_shadow_a_usable_lower_generation_slot() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 1, SECRET_A);
        for rejected in [
            format!("{SECRET_B}\n"),
            format!("{SECRET_B}\r\n"),
            format!("{SECRET_B} "),
            "okt_\u{0001}body".to_string(),
            "okt_".to_string(),
        ] {
            fixture.write_usable_slot(CredentialSlot::B, "tok_b", 2, &rejected);
            let selected = select_usable_credential(&fixture.paths, &fixture.context);
            assert_eq!(
                selected,
                SelectedCredential::Usable {
                    slot: CredentialSlot::A,
                    token_id: "tok_a".to_string(),
                    issuance_generation: 1,
                    secret: SECRET_A.to_string(),
                },
                "rejected secret {rejected:?} must not shadow slot A"
            );
        }
        fixture.write_usable_slot(CredentialSlot::A, "tok_only", 4, "okt_");
        fs::remove_file(&fixture.paths.slot_b_secret).unwrap();
        fs::remove_file(&fixture.paths.slot_b_companion).unwrap();
        assert_eq!(
            select_usable_credential(&fixture.paths, &fixture.context),
            SelectedCredential::Empty,
            "a bare okt_ prefix is not a presentable credential"
        );
    }

    #[test]
    fn treats_wrong_identity_or_deployment_companion_as_empty_and_uses_other_usable_slot() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 1, SECRET_A);
        write_mode(&fixture.paths.slot_b_secret, 0o600, SECRET_B);
        write_mode(
            &fixture.paths.slot_b_companion,
            0o600,
            &format!(
                "{COMPANION_TOKEN_ID_KEY}=tok_b\n\
                 {COMPANION_ISSUANCE_GENERATION_KEY}=9\n\
                 {COMPANION_IDENTITY_ID_KEY}=other_identity\n\
                 {COMPANION_DEPLOYMENT_ID_KEY}={DEPLOYMENT}\n"
            ),
        );

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            },
            "wrong-identity companion must be empty; remaining usable slot wins"
        );

        write_mode(
            &fixture.paths.slot_b_companion,
            0o600,
            &format!(
                "{COMPANION_TOKEN_ID_KEY}=tok_b\n\
                 {COMPANION_ISSUANCE_GENERATION_KEY}=9\n\
                 {COMPANION_IDENTITY_ID_KEY}={IDENTITY}\n\
                 {COMPANION_DEPLOYMENT_ID_KEY}=other_deployment\n"
            ),
        );
        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            },
            "wrong-deployment companion must be empty; remaining usable slot wins"
        );
    }

    #[test]
    fn treats_missing_malformed_or_ambiguous_generation_as_empty() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 3, SECRET_A);

        // Missing companion on B with a secret present → B empty; A wins.
        write_mode(&fixture.paths.slot_b_secret, 0o600, SECRET_B);
        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 3,
                secret: SECRET_A.to_string(),
            },
            "missing companion metadata must treat the slot as empty"
        );

        // Malformed companion on B.
        write_mode(
            &fixture.paths.slot_b_companion,
            0o600,
            "not-valid-companion\n",
        );
        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 3,
                secret: SECRET_A.to_string(),
            },
            "malformed companion metadata must treat the slot as empty"
        );

        // Equal generations on two usable slots → ambiguous → Empty.
        fixture.write_usable_slot(CredentialSlot::B, "tok_b", 3, SECRET_B);
        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Empty,
            "equal issuance generations across two usable slots are generation-ambiguous"
        );
    }

    #[test]
    fn resolves_generation_from_companion_metadata_not_filename_or_length() {
        let fixture = Fixture::new();
        // Paths are the fixed declared pair (filename must not imply generation).
        // The lower-generation secret is intentionally longer so content length
        // cannot be used as a generation proxy. mtime is not an input to the
        // accepted selection rule and MUST NOT be consulted by the builder.
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 5, SECRET_A);
        fixture.write_usable_slot(
            CredentialSlot::B,
            "tok_b",
            1,
            &format!("{SECRET_B}_padded_length_must_not_imply_generation"),
        );

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 5,
                secret: SECRET_A.to_string(),
            },
            "generation must come from companion metadata, not filename or content length"
        );
    }

    #[test]
    fn treats_non_0600_secret_or_companion_as_unusable() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 1, SECRET_A);
        write_mode(&fixture.paths.slot_b_secret, 0o644, SECRET_B);
        Fixture::write_companion(&fixture.paths.slot_b_companion, "tok_b", 9);

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            },
            "wrong-mode secret must be unusable even with higher companion generation"
        );

        write_mode(&fixture.paths.slot_b_secret, 0o600, SECRET_B);
        write_mode(
            &fixture.paths.slot_b_companion,
            0o644,
            &format!(
                "{COMPANION_TOKEN_ID_KEY}=tok_b\n\
                 {COMPANION_ISSUANCE_GENERATION_KEY}=9\n\
                 {COMPANION_IDENTITY_ID_KEY}={IDENTITY}\n\
                 {COMPANION_DEPLOYMENT_ID_KEY}={DEPLOYMENT}\n"
            ),
        );
        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            },
            "wrong-mode companion must be unusable"
        );
    }

    #[test]
    fn returns_empty_when_both_slots_absent() {
        let fixture = Fixture::new();
        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Empty,
            "both slots empty keeps the NanoHost non-ready"
        );
    }

    #[test]
    fn does_not_consult_material_outside_the_declared_slot_pair() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "tok_a", 1, SECRET_A);

        // Higher-generation decoy beside the declared pair must be ignored.
        let decoy_secret = fixture.root.join("C.token");
        let decoy_companion = fixture.root.join("C.meta");
        write_mode(&decoy_secret, 0o600, SECRET_B);
        Fixture::write_companion(&decoy_companion, "tok_decoy", 99);

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_a".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            },
            "selection must not search outside the two declared slots"
        );
    }

    #[test]
    fn write_credential_slot_proves_named_slot_and_companion_at_declared_paths() {
        let fixture = Fixture::new();
        write_credential_slot(
            &fixture.paths,
            CredentialSlot::A,
            &SlotWriteMaterial {
                token_id: "tok_written".to_string(),
                issuance_generation: 7,
                identity_id: IDENTITY.to_string(),
                deployment_id: DEPLOYMENT.to_string(),
                secret: SECRET_A.to_string(),
            },
        )
        .expect("named slot write must succeed");

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "tok_written".to_string(),
                issuance_generation: 7,
                secret: SECRET_A.to_string(),
            },
            "write helper must install secret+companion selectable at the declared A path"
        );
        assert_eq!(
            fs::metadata(&fixture.paths.slot_a_secret)
                .expect("secret metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&fixture.paths.slot_a_companion)
                .expect("companion metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn write_credential_slot_replaces_a_permissive_inode_instead_of_truncating_it() {
        use std::os::unix::fs::MetadataExt;

        let fixture = Fixture::new();
        write_mode(&fixture.paths.slot_a_secret, 0o644, "visible-before-write");
        let previous = fs::metadata(&fixture.paths.slot_a_secret).expect("existing secret");
        assert_eq!(previous.permissions().mode() & 0o777, 0o644);
        write_credential_slot(
            &fixture.paths,
            CredentialSlot::A,
            &SlotWriteMaterial {
                token_id: "tok_replaced".to_string(),
                issuance_generation: 3,
                identity_id: IDENTITY.to_string(),
                deployment_id: DEPLOYMENT.to_string(),
                secret: SECRET_A.to_string(),
            },
        )
        .expect("atomic slot write");
        let current = fs::metadata(&fixture.paths.slot_a_secret).expect("replaced secret");
        assert_ne!(
            current.ino(),
            previous.ino(),
            "the permissive inode must not receive the new secret bytes"
        );
        assert_eq!(current.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::read_to_string(&fixture.paths.slot_a_secret).unwrap(),
            SECRET_A
        );
    }

    #[test]
    fn clear_credential_slot_leaves_exactly_one_usable_slot_after_cutover() {
        let fixture = Fixture::new();
        write_credential_slot(
            &fixture.paths,
            CredentialSlot::A,
            &SlotWriteMaterial {
                token_id: "tok_pred".to_string(),
                issuance_generation: 1,
                identity_id: IDENTITY.to_string(),
                deployment_id: DEPLOYMENT.to_string(),
                secret: SECRET_A.to_string(),
            },
        )
        .expect("predecessor slot write");
        write_credential_slot(
            &fixture.paths,
            CredentialSlot::B,
            &SlotWriteMaterial {
                token_id: "tok_succ".to_string(),
                issuance_generation: 2,
                identity_id: IDENTITY.to_string(),
                deployment_id: DEPLOYMENT.to_string(),
                secret: SECRET_B.to_string(),
            },
        )
        .expect("successor slot write");

        clear_credential_slot(&fixture.paths, CredentialSlot::A)
            .expect("predecessor clear after cutover");

        let selected = select_usable_credential(&fixture.paths, &fixture.context);
        assert_eq!(
            selected,
            SelectedCredential::Usable {
                slot: CredentialSlot::B,
                token_id: "tok_succ".to_string(),
                issuance_generation: 2,
                secret: SECRET_B.to_string(),
            },
            "after cutover clear, exactly the successor slot remains usable"
        );
        assert!(!fixture.paths.slot_a_secret.exists());
        assert!(!fixture.paths.slot_a_companion.exists());
    }

    #[test]
    fn incomplete_companion_publication_leaves_the_old_slot_unusable() {
        let _clear = ClearPairHook;
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "old-token", 1, SECRET_A);
        reject_next_companion_publication();
        let error = write_credential_slot(
            &fixture.paths,
            CredentialSlot::A,
            &SlotWriteMaterial {
                token_id: "new-token".to_string(),
                issuance_generation: 2,
                identity_id: IDENTITY.to_string(),
                deployment_id: DEPLOYMENT.to_string(),
                secret: "okt_testc".to_string(),
            },
        )
        .expect_err("companion publication must fail");
        assert_eq!(error.message, "credential companion publication failed");
        assert_eq!(
            select_usable_credential(&fixture.paths, &fixture.context),
            SelectedCredential::Empty
        );
        assert!(!fixture.paths.slot_a_secret.exists());
    }

    fn paths_under(root: &Path) -> SlotPairPaths {
        SlotPairPaths {
            slot_a_secret: root.join("A.token"),
            slot_a_companion: root.join("A.meta"),
            slot_b_secret: root.join("B.token"),
            slot_b_companion: root.join("B.meta"),
        }
    }

    fn test_context() -> CredentialSelectionContext {
        CredentialSelectionContext {
            identity_id: IDENTITY.to_string(),
            deployment_id: DEPLOYMENT.to_string(),
        }
    }

    fn replacement_material() -> SlotWriteMaterial {
        SlotWriteMaterial {
            token_id: "new-token".to_string(),
            issuance_generation: 2,
            identity_id: IDENTITY.to_string(),
            deployment_id: DEPLOYMENT.to_string(),
            secret: "okt_testc".to_string(),
        }
    }

    fn spawn_slot_child(test_name: &str, role: &str, root: &Path) -> std::process::Child {
        std::process::Command::new(std::env::current_exe().expect("test executable"))
            .arg(test_name)
            .arg("--exact")
            .env("NANOHOS_SLOT_CHILD", role)
            .env("NANOHOS_SLOT_DIR", root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("slot child")
    }

    #[test]
    fn cross_process_selector_between_renames_waits_for_the_complete_pair() {
        if std::env::var("NANOHOS_SLOT_CHILD").ok().as_deref() == Some("select") {
            let root = PathBuf::from(std::env::var("NANOHOS_SLOT_DIR").expect("slot dir"));
            let paths = paths_under(&root);
            fs::write(root.join("child-entered"), b"1").expect("child entered");
            let selected = select_usable_credential(&paths, &test_context());
            let line = match selected {
                SelectedCredential::Usable { token_id, .. } => format!("token={token_id}"),
                SelectedCredential::Empty => "empty".to_string(),
            };
            fs::write(root.join("child-result"), line).expect("child result");
            return;
        }
        let _clear = ClearPairHook;
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "old-token", 1, SECRET_A);
        let root = fixture.root.clone();
        let child_slot = Arc::new(Mutex::new(None));
        let child_for_hook = Arc::clone(&child_slot);
        let hook_root = root.clone();
        install_pair_publication_hook(move || {
            let child = spawn_slot_child(
                "credential_slots::tests::cross_process_selector_between_renames_waits_for_the_complete_pair",
                "select",
                &hook_root,
            );
            *child_for_hook
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(child);
            while !hook_root.join("child-entered").is_file() {
                std::thread::yield_now();
            }
        });
        write_credential_slot(&fixture.paths, CredentialSlot::A, &replacement_material())
            .expect("complete pair publication");
        let mut child = child_slot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .expect("selector child");
        let status = child.wait().expect("selector wait");
        assert!(status.success());
        assert_eq!(
            fs::read_to_string(root.join("child-result")).expect("selector result"),
            "token=new-token"
        );
    }

    #[test]
    fn read_only_parent_blocks_publication_before_the_secret_is_replaced() {
        let _clear = ClearPairHook;
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "old-token", 1, SECRET_A);
        let root = fixture.root.clone();
        struct RestoreMode(PathBuf);
        impl Drop for RestoreMode {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }
        let _restore = RestoreMode(root.clone());
        install_before_invalidation_hook(move || {
            fs::set_permissions(&root, fs::Permissions::from_mode(0o555))
                .expect("read-only parent");
        });
        let error =
            write_credential_slot(&fixture.paths, CredentialSlot::A, &replacement_material())
                .expect_err("cleanup must fail before secret replacement");
        assert!(error.message.contains("credential slot cleanup failed"));
        assert_eq!(
            fs::read_to_string(&fixture.paths.slot_a_secret).expect("old secret"),
            SECRET_A
        );
        assert!(
            fs::read_to_string(&fixture.paths.slot_a_companion)
                .expect("old companion")
                .contains("token_id=old-token")
        );
        assert_eq!(
            select_usable_credential(&fixture.paths, &fixture.context),
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "old-token".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            }
        );
    }

    #[test]
    fn writer_exit_between_renames_leaves_the_slot_unusable() {
        if std::env::var("NANOHOS_SLOT_CHILD").ok().as_deref() == Some("die") {
            let root = PathBuf::from(std::env::var("NANOHOS_SLOT_DIR").expect("slot dir"));
            let paths = paths_under(&root);
            install_pair_publication_hook(|| std::process::exit(0));
            let _ = write_credential_slot(&paths, CredentialSlot::A, &replacement_material());
            std::process::exit(2);
        }
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "old-token", 1, SECRET_A);
        let mut child = spawn_slot_child(
            "credential_slots::tests::writer_exit_between_renames_leaves_the_slot_unusable",
            "die",
            &fixture.root,
        );
        let status = child.wait().expect("writer wait");
        assert!(status.success());
        assert_eq!(
            select_usable_credential(&fixture.paths, &fixture.context),
            SelectedCredential::Empty
        );
        assert!(
            !fixture.paths.slot_a_companion.exists(),
            "the old companion must not remain beside the replaced secret"
        );
    }

    #[test]
    fn read_only_directory_slot_without_sidecar_stays_usable() {
        let fixture = Fixture::new();
        fixture.write_usable_slot(CredentialSlot::A, "kept-token", 1, SECRET_A);
        let sidecar = fixture.root.join(CREDENTIAL_SLOT_LOCK_FILE_NAME);
        assert!(
            !sidecar.exists(),
            "the credential directory starts without a sidecar lock"
        );
        struct RestoreMode(PathBuf);
        impl Drop for RestoreMode {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }
        let _restore = RestoreMode(fixture.root.clone());
        fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o500))
            .expect("read-only credential directory");

        assert_eq!(
            select_usable_credential(&fixture.paths, &fixture.context),
            SelectedCredential::Usable {
                slot: CredentialSlot::A,
                token_id: "kept-token".to_string(),
                issuance_generation: 1,
                secret: SECRET_A.to_string(),
            }
        );
        assert!(
            !sidecar.exists(),
            "selection must not create a lock in the credential directory"
        );
        let lock = credential_slot_lock_directory().join(CREDENTIAL_SLOT_LOCK_FILE_NAME);
        let mode = fs::metadata(&lock)
            .expect("service-state slot lock")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "the shared slot lock stays mode 0600");
    }
}
