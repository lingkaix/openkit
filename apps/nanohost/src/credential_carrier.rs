//! Ephemeral credential files owned by the existing Sandbox and Epoch lifecycle.
//!
//! This module has no durable metadata. Only NanoHost can construct a mount
//! source, and removal is allowed only after the lifecycle owner proves absence.

use std::collections::BTreeSet;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};

const INVALID: &str = "credential carrier proof unavailable";
const MAX_BINDINGS: usize = 32;
const TMPFS_MAGIC: libc::c_long = 0x0102_1994;

/// Transient Core intent. No host path or secret is accepted in this shape.
#[derive(Clone, PartialEq, Eq)]
pub struct CredentialBinding {
    /// Current AEP declaration admitted by Core.
    pub declaration_id: String,
    /// Existing immutable injection intent identity.
    pub plan_id: String,
    /// Existing receipt identity, not a claim of completed delivery.
    pub receipt_id: String,
    /// Canonical single-file destination inside the admitted Worker home.
    pub target_path: String,
}

/// Parses the closed private sandbox.create branch before any native effect.
pub fn parse_bindings(value: Option<&Value>) -> Result<Vec<CredentialBinding>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= MAX_BINDINGS)
        .ok_or(INVALID)?;
    let mut identities = BTreeSet::new();
    let mut plans = BTreeSet::new();
    let mut receipts = BTreeSet::new();
    let mut targets = BTreeSet::<String>::new();
    let mut bindings = Vec::new();
    for row in rows {
        let object = row.as_object().ok_or(INVALID)?;
        if object.len() != 7
            || object.keys().any(|key| {
                ![
                    "declarationId",
                    "planId",
                    "receiptId",
                    "material",
                    "target",
                    "access",
                    "requiredProtection",
                ]
                .contains(&key.as_str())
            })
            || object.get("access").and_then(Value::as_str) != Some("read-only")
        {
            return Err(INVALID);
        }
        let material = object
            .get("material")
            .and_then(Value::as_object)
            .ok_or(INVALID)?;
        let target = object
            .get("target")
            .and_then(Value::as_object)
            .ok_or(INVALID)?;
        let protection = object
            .get("requiredProtection")
            .and_then(Value::as_object)
            .ok_or(INVALID)?;
        if material.len() != 3
            || material.get("format").and_then(Value::as_str) != Some("utf8")
            || material
                .get("referenceId")
                .and_then(Value::as_str)
                .is_none_or(|value| {
                    value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control)
                })
            || material
                .get("version")
                .and_then(Value::as_u64)
                .is_none_or(|value| value == 0 || value > 9_007_199_254_740_991)
            || target.len() != 2
            || target.get("kind").and_then(Value::as_str) != Some("file")
            || protection.len() != 4
            || [
                "ephemeral",
                "outsideRetainedStorage",
                "excludedFromCapture",
                "excludedFromExport",
            ]
            .iter()
            .any(|key| protection.get(*key).and_then(Value::as_bool) != Some(true))
        {
            return Err(INVALID);
        }
        let string = |key| {
            object
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| {
                    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
                })
                .map(str::to_string)
                .ok_or(INVALID)
        };
        let binding = CredentialBinding {
            declaration_id: string("declarationId")?,
            plan_id: string("planId")?,
            receipt_id: string("receiptId")?,
            target_path: target
                .get("path")
                .and_then(Value::as_str)
                .ok_or(INVALID)?
                .to_string(),
        };
        validate_target(&binding.target_path)?;
        if !identities.insert(binding.declaration_id.clone())
            || !plans.insert(binding.plan_id.clone())
            || !receipts.insert(binding.receipt_id.clone())
            || targets.iter().any(|target| {
                Path::new(target).starts_with(&binding.target_path)
                    || Path::new(&binding.target_path).starts_with(target)
            })
        {
            return Err(INVALID);
        }
        targets.insert(binding.target_path.clone());
        bindings.push(binding);
    }
    Ok(bindings)
}

/// Keeps the accepted home namespace and rejects normalization and traversal.
pub fn validate_target(target: &str) -> Result<(), &'static str> {
    if !target.starts_with("/sandbox/")
        || target == "/sandbox/openkit"
        || target.starts_with("/sandbox/openkit/")
        || target.len() > 4096
        || target.contains('\\')
        || target.chars().any(char::is_control)
        || target
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        || target.as_bytes().contains(&0)
    {
        return Err(INVALID);
    }
    Ok(())
}

/// A credential mount cannot be constructed by a caller-selected host path.
#[derive(Clone)]
pub struct CredentialMount {
    source: PathBuf,
    target: String,
    device: u64,
    inode: u64,
    namespace: Option<Arc<OwnedFd>>,
}

impl PartialEq for CredentialMount {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source
            && self.target == other.target
            && self.device == other.device
            && self.inode == other.inode
    }
}
impl Eq for CredentialMount {}

impl std::fmt::Debug for CredentialMount {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CredentialMount([private])")
    }
}

impl CredentialMount {
    /// Revalidates the root-controlled memory inode immediately before rendering.
    pub fn source(&self) -> Result<&Path, &'static str> {
        in_mount_namespace(self.namespace.as_ref(), || self.verify_source())?;
        Ok(&self.source)
    }

    fn verify_source(&self) -> Result<(), &'static str> {
        let file = open_file(&self.source, false)?;
        let metadata = file.metadata().map_err(|_| INVALID)?;
        verify_memory_file(&file)?;
        if metadata.dev() != self.device || metadata.ino() != self.inode {
            return Err(INVALID);
        }
        Ok(())
    }

    /// Fixed admitted Worker destination; never a host destination.
    pub fn target(&self) -> &str {
        &self.target
    }
}

/// One tmpfs attached to the current Sandbox; the Epoch owns its lifetime.
pub struct CredentialCarrier {
    namespace: Option<Arc<OwnedFd>>,
    root: PathBuf,
    sandbox_id: String,
    bindings: Vec<(CredentialBinding, CredentialMount, File, Option<String>)>,
    mount_points: Vec<File>,
}

impl CredentialCarrier {
    /// Uses the incarnation-pinned mount domain already owned by the backend monitor.
    pub fn create_in_namespace(
        namespace: Arc<OwnedFd>,
        run_root: &Path,
        sandbox_id: &str,
        bindings: Vec<CredentialBinding>,
        uid: u32,
        gid: u32,
        mount_points: Vec<File>,
    ) -> Result<Self, &'static str> {
        let mut carrier = in_mount_namespace(Some(&namespace), || {
            Self::create(run_root, sandbox_id, bindings, uid, gid, mount_points)
        })?;
        for (_, mount, _, _) in &mut carrier.bindings {
            mount.namespace = Some(Arc::clone(&namespace));
        }
        carrier.namespace = Some(namespace);
        Ok(carrier)
    }
    /// Allocates after image seeding and empty target admission, before creation.
    /// The parent must be the root-owned disposable Epoch runtime directory.
    pub fn create(
        run_root: &Path,
        sandbox_id: &str,
        bindings: Vec<CredentialBinding>,
        uid: u32,
        gid: u32,
        mount_points: Vec<File>,
    ) -> Result<Self, &'static str> {
        verify_root_parents(run_root)?;
        let root = run_root.join(format!(
            "credentials-{:x}",
            Sha256::digest(sandbox_id.as_bytes())
        ));
        fs::create_dir(&root).map_err(|_| INVALID)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|_| INVALID)?;
        let target = CString::new(root.as_os_str().as_bytes()).map_err(|_| INVALID)?;
        let options = CString::new(format!("mode=0700,uid={uid},gid={gid},size=268435456"))
            .map_err(|_| INVALID)?;
        // SAFETY: root was exclusively created below a verified private parent;
        // fixed flags and filesystem do not come from Core or Worker inputs.
        let mounted = unsafe {
            libc::mount(
                c"tmpfs".as_ptr(),
                target.as_ptr(),
                c"tmpfs".as_ptr(),
                libc::MS_NODEV | libc::MS_NOSUID | libc::MS_NOEXEC,
                options.as_ptr().cast(),
            )
        };
        if mounted != 0 {
            let _ = fs::remove_dir(&root);
            return Err(INVALID);
        }
        let mut carrier = Self {
            namespace: None,
            root,
            sandbox_id: sandbox_id.to_string(),
            bindings: Vec::new(),
            mount_points,
        };
        let prepared = (|| {
            let directory = File::open(&carrier.root).map_err(|_| INVALID)?;
            verify_tmpfs(&directory)?;
            let metadata = directory.metadata().map_err(|_| INVALID)?;
            if metadata.uid() != uid || metadata.gid() != gid || metadata.mode() & 0o777 != 0o700 {
                return Err(INVALID);
            }
            for (index, binding) in bindings.into_iter().enumerate() {
                let source = carrier.root.join(index.to_string());
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o400)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&source)
                    .map_err(|_| INVALID)?;
                if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0 {
                    return Err(INVALID);
                }
                let metadata = file.metadata().map_err(|_| INVALID)?;
                let mount = CredentialMount {
                    source,
                    target: binding.target_path.clone(),
                    device: metadata.dev(),
                    inode: metadata.ino(),
                    namespace: None,
                };
                carrier.bindings.push((binding, mount, file, None));
            }
            Ok(())
        })();
        if prepared.is_err() {
            carrier.remove_after_absence()?;
            return Err(INVALID);
        }
        Ok(carrier)
    }

    /// Returns only root-derived sources for the pinned OpenShell mount envelope.
    pub fn mounts(&self) -> Vec<crate::persistent_volume::StorageMount> {
        self.bindings
            .iter()
            .map(|(_, mount, _, _)| crate::persistent_volume::StorageMount {
                source: mount.source.clone(),
                target: mount.target.clone(),
                credential: Some(mount.clone()),
            })
            .collect()
    }

    /// Imports once into the admitted mounted inode after full private verification.
    pub fn import(
        &mut self,
        sandbox_id: &str,
        relative: &Path,
        source: &crate::file_transfer::VerifiedFile,
    ) -> Result<CredentialMount, &'static str> {
        self.write_binding(sandbox_id, relative, source, false)
    }

    /// Replaces a delivered file in place. The host retains the same writable
    /// descriptor and inode; consumer quiescence and reload belong to its profile.
    /// A failed write must close or fence the Sandbox before consumer work resumes.
    #[cfg(test)]
    pub fn rewrite(
        &mut self,
        sandbox_id: &str,
        relative: &Path,
        source: &crate::file_transfer::VerifiedFile,
    ) -> Result<CredentialMount, &'static str> {
        self.write_binding(sandbox_id, relative, source, true)
    }

    /// The existing carrier owns the current receipt generation; compare it before changing bytes.
    pub fn replace(
        &mut self,
        sandbox_id: &str,
        address: &Path,
        expected_receipt: &str,
        receipt: &str,
        source: &crate::file_transfer::VerifiedFile,
    ) -> Result<CredentialMount, &'static str> {
        let index = self
            .bindings
            .iter()
            .position(|(binding, _, _, _)| {
                serde_json::to_vec(&[
                    &binding.declaration_id,
                    &binding.plan_id,
                    &binding.receipt_id,
                ])
                .is_ok_and(|bytes| {
                    address.to_str() == Some(format!("{:x}", Sha256::digest(bytes)).as_str())
                })
            })
            .ok_or(INVALID)?;
        if self.bindings[index].3.as_deref() != Some(expected_receipt)
            || expected_receipt == receipt
        {
            return Err(INVALID);
        }
        let mount = self.write_binding(sandbox_id, address, source, true)?;
        self.bindings[index].3 = Some(receipt.to_string());
        Ok(mount)
    }

    fn write_binding(
        &mut self,
        sandbox_id: &str,
        relative: &Path,
        source: &crate::file_transfer::VerifiedFile,
        replacement: bool,
    ) -> Result<CredentialMount, &'static str> {
        let namespace = self.namespace.clone();
        in_mount_namespace(namespace.as_ref(), || {
            self.write_binding_in_namespace(sandbox_id, relative, source, replacement)
        })
    }

    fn write_binding_in_namespace(
        &mut self,
        sandbox_id: &str,
        relative: &Path,
        source: &crate::file_transfer::VerifiedFile,
        replacement: bool,
    ) -> Result<CredentialMount, &'static str> {
        if sandbox_id != self.sandbox_id {
            return Err(INVALID);
        }
        let address = relative.to_str().ok_or(INVALID)?;
        let (binding, mount, file, imported) = self
            .bindings
            .iter_mut()
            .find(|(binding, _, _, _)| {
                let identities = [
                    &binding.declaration_id,
                    &binding.plan_id,
                    &binding.receipt_id,
                ];
                serde_json::to_vec(&identities)
                    .is_ok_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == address)
            })
            .ok_or(INVALID)?;
        if imported.is_some() != replacement || source.length() == 0 {
            return Err(INVALID);
        }
        mount.verify_source()?;
        let mut reader = source.reader().map_err(|_| INVALID)?;
        // The binding remains the same inode. No rename or remount can update a
        // read-only single-file bind; callers must stop readers around this write.
        file.seek(SeekFrom::Start(0)).map_err(|_| INVALID)?;
        file.set_len(0).map_err(|_| INVALID)?;
        if std::io::copy(&mut reader, file).map_err(|_| INVALID)? != source.length() {
            return Err(INVALID);
        }
        file.sync_all().map_err(|_| INVALID)?;
        let mut check = open_file(&mount.source, false)?;
        let mut digest = Sha256::new();
        let mut bytes = [0_u8; crate::file_transfer::CHUNK_BYTES];
        loop {
            let read = check.read(&mut bytes).map_err(|_| INVALID)?;
            if read == 0 {
                break;
            }
            digest.update(&bytes[..read]);
        }
        if format!("sha256:{:x}", digest.finalize()) != source.digest() {
            return Err(INVALID);
        }
        if imported.is_none() {
            *imported = Some(format!(
                "{:x}",
                Sha256::digest(binding.receipt_id.as_bytes())
            ));
        }
        Ok(mount.clone())
    }

    /// Native mount observations must identify every admitted source and read-only flag.
    pub fn verify_mounts(&self, observations: &Value) -> Result<(), &'static str> {
        let rows = observations.as_array().ok_or(INVALID)?;
        for (_, mount, _, _) in &self.bindings {
            let source = mount.source()?.to_str().ok_or(INVALID)?;
            let matches = rows
                .iter()
                .filter(|row| {
                    row.get("Destination").and_then(Value::as_str) == Some(mount.target())
                })
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err(INVALID);
            }
            let row = matches[0];
            if row.get("Source").and_then(Value::as_str) != Some(source)
                || row.get("RW").and_then(Value::as_bool) != Some(false)
                || row.get("Type").and_then(Value::as_str) != Some("bind")
            {
                return Err(INVALID);
            }
        }
        Ok(())
    }

    /// Unmount only after proved Sandbox absence; uncertainty is fenced by caller.
    pub fn remove_after_absence(&mut self) -> Result<(), &'static str> {
        let namespace = self.namespace.clone();
        in_mount_namespace(namespace.as_ref(), || self.remove_in_namespace())
    }

    fn remove_in_namespace(&mut self) -> Result<(), &'static str> {
        let root = CString::new(self.root.as_os_str().as_bytes()).map_err(|_| INVALID)?;
        // Release our own writable descriptors before strict unmount. Native
        // consumer absence is proved by the caller; a busy mount still fences.
        self.bindings.clear();
        // No lazy unmount: a surviving mount or open process is not removal proof.
        if unsafe { libc::umount2(root.as_ptr(), 0) } != 0 {
            return Err(INVALID);
        }
        if self.mount_points.iter().any(|file| {
            file.metadata()
                .map_or(true, |metadata| !metadata.is_file() || metadata.len() != 0)
        }) {
            return Err(INVALID);
        }
        self.mount_points.clear();
        fs::remove_dir(&self.root).map_err(|_| INVALID)
    }
}

/// A bounded dedicated thread changes only its own mount view, then exits.
/// The namespace is an existing pinned backend descriptor, never a caller path.
fn in_mount_namespace<T: Send>(
    namespace: Option<&Arc<OwnedFd>>,
    run: impl FnOnce() -> Result<T, &'static str> + Send,
) -> Result<T, &'static str> {
    let Some(namespace) = namespace else {
        return run();
    };
    std::thread::scope(|scope| {
        scope
            .spawn(move || {
                // SAFETY: detach this thread's shared fs state before changing its mount
                // namespace. The retained descriptor pins the original backend domain.
                if unsafe { libc::unshare(libc::CLONE_FS) } != 0
                    || unsafe { libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNS) } != 0
                {
                    return Err(INVALID);
                }
                run()
            })
            .join()
            .map_err(|_| INVALID)?
    })
}

fn open_file(path: &Path, write: bool) -> Result<File, &'static str> {
    OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| INVALID)
}

fn verify_tmpfs(file: &File) -> Result<(), &'static str> {
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(INVALID);
    }
    let info = unsafe { info.assume_init() };
    if info.f_type != TMPFS_MAGIC {
        return Err(INVALID);
    }
    let mut flags = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::fstatvfs(file.as_raw_fd(), flags.as_mut_ptr()) } != 0 {
        return Err(INVALID);
    }
    let flags = unsafe { flags.assume_init() }.f_flag;
    if flags & (libc::ST_NODEV | libc::ST_NOSUID | libc::ST_NOEXEC)
        != (libc::ST_NODEV | libc::ST_NOSUID | libc::ST_NOEXEC)
    {
        return Err(INVALID);
    }
    Ok(())
}

fn verify_memory_file(file: &File) -> Result<(), &'static str> {
    verify_tmpfs(file)?;
    let metadata = file.metadata().map_err(|_| INVALID)?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.mode() & 0o777 != 0o400 {
        return Err(INVALID);
    }
    Ok(())
}

fn verify_root_parents(path: &Path) -> Result<(), &'static str> {
    let mut current = PathBuf::new();
    for component in path.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err(INVALID);
        }
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| INVALID)?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(INVALID);
        }
    }
    if path.starts_with(crate::persistent_volume::PERSISTENT_VOLUME_ROOT) {
        return Err(INVALID);
    }
    Ok(())
}

/// Removes only generated carrier mounts after the complete prior Epoch fence.
/// The caller's prior-member absence proof is required; this is never revocation.
pub(crate) fn remove_fenced_epoch_carriers(run_root: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(run_root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(identity) = name.strip_prefix("credentials-") else {
            continue;
        };
        if identity.len() != 64
            || !identity
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(std::io::Error::other(INVALID));
        }
        verify_root_parents(run_root).map_err(std::io::Error::other)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(entry.path())?;
        let escaped = entry
            .path()
            .as_os_str()
            .as_bytes()
            .iter()
            .map(|byte| match byte {
                b' ' => "\\040".to_string(),
                b'\t' => "\\011".to_string(),
                b'\n' => "\\012".to_string(),
                b'\\' => "\\134".to_string(),
                byte => char::from(*byte).to_string(),
            })
            .collect::<String>();
        let mounted = fs::read_to_string("/proc/thread-self/mountinfo")?
            .lines()
            .any(|line| line.split_ascii_whitespace().nth(4) == Some(escaped.as_str()));
        if mounted {
            verify_tmpfs(&file).map_err(std::io::Error::other)?;
            drop(file);
            let path = CString::new(entry.path().as_os_str().as_bytes())
                .map_err(|_| std::io::Error::other(INVALID))?;
            if unsafe { libc::umount2(path.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
        } else {
            drop(file);
        }
        // Namespace destruction or a failed mount can leave only this empty,
        // root-owned generated directory. Contents or foreign ownership fence.
        let underlying = fs::symlink_metadata(entry.path())?;
        if !underlying.is_dir()
            || underlying.uid() != 0
            || underlying.mode() & 0o777 != 0o700
            || fs::read_dir(entry.path())?.next().is_some()
        {
            return Err(std::io::Error::other(INVALID));
        }
        fs::remove_dir(entry.path())?;
    }
    Ok(())
}
