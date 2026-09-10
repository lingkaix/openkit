//! Epoch-external retained Worker volume storage.

use std::collections::{BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Fixed execution-host root retained independently of Runtime Epoch roots.
pub const PERSISTENT_VOLUME_ROOT: &str = "/var/lib/openkit/nanohost-work";

const METADATA_NAME: &str = "identity.json";
const MAX_TARGETS: usize = 32;
const MAX_SEED_ENTRIES: u64 = 1_000_000;
const MAX_SEED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const SEED_FREE_BYTE_RESERVE: u64 = 64 * 1024 * 1024;
const SEED_FREE_INODE_RESERVE: u64 = 1_024;
const TAR_BLOCK_BYTES: usize = 512;
const MAX_TAR_ZERO_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const DOCKER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DOCKER_INSPECT_BYTES: usize = 512 * 1024;
const FAMILY_LABEL: &str = "org.openkit.storage.family";
const VERSION_LABEL: &str = "org.openkit.storage.version";

/// Verified immutable storage layout read from one exact local OCI image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageStorageLayout {
    pub digest: String,
    pub family: Option<String>,
    pub version: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub working_directory: String,
    pub os: String,
    pub architecture: String,
    pub targets: Vec<String>,
}

impl ImageStorageLayout {
    /// Returns the exact Core-compatible digest over the admitted layout facts.
    pub fn layout_digest(&self) -> String {
        let string = |value: &str| serde_json::to_string(value).expect("string JSON");
        let family = serde_json::to_string(&self.family).expect("family JSON");
        let version = serde_json::to_string(&self.version).expect("version JSON");
        let targets = self
            .targets
            .iter()
            .map(|target| format!("{{\"target\":{}}}", string(target)))
            .collect::<Vec<_>>()
            .join(",");
        let canonical = format!(
            "{{\"family\":{family},\"version\":{version},\"uid\":{},\"gid\":{},\"workingDirectory\":{},\"platform\":{{\"architecture\":{},\"os\":{}}},\"targets\":[{targets}]}}",
            self.uid,
            self.gid,
            string(&self.working_directory),
            string(&self.architecture),
            string(&self.os),
        );
        format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
    }

    /// Projects only the bounded immutable image facts admitted by Core.
    pub fn result_json(&self) -> Value {
        json!({
            "digest": self.digest,
            "platform": {"os": self.os, "architecture": self.architecture},
            "storageLayout": {
                "family": self.family,
                "version": self.version,
                "uid": self.uid,
                "gid": self.gid,
                "workingDirectory": self.working_directory,
                "targets": self.targets.iter().map(|target| json!({"target": target})).collect::<Vec<_>>(),
            }
        })
    }
}

/// Core-selected fixed target identity for one retained association.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageTargetBinding {
    pub target: String,
    pub volume_ref: String,
}

/// Exact Core-selected attachment input; it contains no host path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageAttachmentRequest {
    pub storage_ref: String,
    pub scope_digest: String,
    pub attachment_generation: u64,
    pub layout_digest: String,
    pub targets: Vec<StorageTargetBinding>,
}

/// One NanoHost-derived fixed writable bind mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageMount {
    pub source: PathBuf,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredTarget {
    target: String,
    volume_ref: String,
    initialized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredAttachment {
    generation: u64,
    sandbox_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StorageMetadata {
    storage_ref: String,
    scope_digest: String,
    layout_digest: String,
    uid: u32,
    gid: u32,
    family: Option<String>,
    version: Option<String>,
    os: String,
    architecture: String,
    attachment_generation: u64,
    state: String,
    attachment: Option<StoredAttachment>,
    targets: Vec<StoredTarget>,
}

/// Host-local retained-volume owner bound to one private Docker epoch socket.
pub struct PersistentVolumeStore {
    root: PathBuf,
    docker_socket: PathBuf,
    owner_uid: u32,
}

impl PersistentVolumeStore {
    /// Opens the fixed production store and rejects unsafe existing roots.
    pub fn open(docker_socket: PathBuf) -> Result<Self, &'static str> {
        Self::open_at(PathBuf::from(PERSISTENT_VOLUME_ROOT), docker_socket, 0)
    }

    fn open_at(
        root: PathBuf,
        docker_socket: PathBuf,
        owner_uid: u32,
    ) -> Result<Self, &'static str> {
        if !root.exists() {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&root)
                .map_err(|_| "persistent volume root unavailable")?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "persistent volume root unavailable")?;
        }
        verify_private_directory(&root, owner_uid)
            .map_err(|_| "persistent volume root identity invalid")?;
        Ok(Self {
            root,
            docker_socket,
            owner_uid,
        })
    }

    /// Reads one exact locally installed image without acquisition or build.
    pub fn inspect_image(&self, digest: &str) -> Result<ImageStorageLayout, &'static str> {
        validate_digest(digest)?;
        let output = self.docker_output(&["image", "inspect", "--format", "{{json .}}", digest])?;
        parse_image_inspect(digest, &output)
    }

    /// Initializes only new targets, records attachment, and returns fixed mounts.
    pub fn attach(
        &mut self,
        sandbox_id: &str,
        request: &StorageAttachmentRequest,
        layout: &ImageStorageLayout,
    ) -> Result<Vec<StorageMount>, &'static str> {
        validate_attachment_request(sandbox_id, request, layout)?;
        let association = self.association_path(&request.storage_ref);
        if path_exists_nofollow(&self.purging_path(&request.storage_ref)) {
            return Err("persistent storage purge outcome unknown");
        }
        let (mut metadata, existing_association) = if path_exists_nofollow(&association) {
            (self.read_metadata(&association)?, true)
        } else {
            (
                self.create_association(&association, request, layout)?,
                false,
            )
        };
        if metadata.storage_ref != request.storage_ref
            || metadata.scope_digest != request.scope_digest
            || metadata.uid != layout.uid
            || metadata.gid != layout.gid
            || metadata.family != layout.family
            || metadata.version != layout.version
            || metadata.os != layout.os
            || metadata.architecture != layout.architecture
            || metadata.state == "unknown"
            || (existing_association
                && metadata.attachment.is_none()
                && request.attachment_generation <= metadata.attachment_generation)
            || metadata.attachment.as_ref().is_some_and(|attachment| {
                attachment.generation != request.attachment_generation
                    || attachment.sandbox_id != sandbox_id
            })
        {
            return Err("persistent storage identity conflict");
        }
        let (available_bytes, _) = filesystem_capacity(&self.root)
            .map_err(|_| "persistent storage capacity unavailable")?;
        if available_bytes == 0 {
            return Err("persistent storage capacity unavailable");
        }
        for target in &metadata.targets {
            if !target.initialized {
                return Err("persistent storage initialization incomplete");
            }
            verify_volume_directory(
                &self.volume_path(&association, &target.volume_ref),
                metadata.uid,
                metadata.gid,
            )
            .map_err(|_| "persistent storage target unavailable")?;
        }
        for binding in &request.targets {
            if let Some(stored) = metadata
                .targets
                .iter()
                .find(|stored| stored.target == binding.target)
            {
                if stored.volume_ref != binding.volume_ref || !stored.initialized {
                    return Err("persistent storage target identity conflict");
                }
                continue;
            }
            if metadata
                .targets
                .iter()
                .any(|stored| stored.volume_ref == binding.volume_ref)
            {
                return Err("persistent storage target identity conflict");
            }
            metadata.state = "initializing".to_string();
            metadata.targets.push(StoredTarget {
                target: binding.target.clone(),
                volume_ref: binding.volume_ref.clone(),
                initialized: false,
            });
            metadata
                .targets
                .sort_by(|left, right| left.target.cmp(&right.target));
            self.write_metadata(&association, &metadata)?;
            self.seed_target(
                &association,
                &layout.digest,
                binding,
                layout.uid,
                layout.gid,
            )?;
            metadata
                .targets
                .iter_mut()
                .find(|stored| stored.target == binding.target)
                .expect("new target retained")
                .initialized = true;
            self.write_metadata(&association, &metadata)?;
        }
        let requested_targets = request
            .targets
            .iter()
            .map(|binding| binding.target.as_str())
            .collect::<BTreeSet<_>>();
        if layout
            .targets
            .iter()
            .any(|target| !requested_targets.contains(target.as_str()))
        {
            return Err("persistent storage required target missing");
        }
        metadata.layout_digest = request.layout_digest.clone();
        metadata.attachment_generation = request.attachment_generation;
        metadata.state = "attached".to_string();
        metadata.attachment = Some(StoredAttachment {
            generation: request.attachment_generation,
            sandbox_id: sandbox_id.to_string(),
        });
        self.write_metadata(&association, &metadata)?;
        request
            .targets
            .iter()
            .map(|binding| {
                let source = self.volume_path(&association, &binding.volume_ref);
                verify_volume_directory(&source, layout.uid, layout.gid)
                    .map_err(|_| "persistent storage target unavailable")?;
                Ok(StorageMount {
                    source,
                    target: binding.target.clone(),
                })
            })
            .collect()
    }

    /// Releases only the exact current Sandbox attachment after its writer is absent.
    pub fn detach(&mut self, sandbox_id: &str) -> Result<(), &'static str> {
        let entries = fs::read_dir(&self.root).map_err(|_| "persistent storage root unreadable")?;
        let mut found = false;
        for entry in entries {
            let entry = entry.map_err(|_| "persistent storage root unreadable")?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(mut metadata) = self.read_metadata(&path) else {
                continue;
            };
            if metadata
                .attachment
                .as_ref()
                .is_some_and(|attachment| attachment.sandbox_id == sandbox_id)
            {
                if found {
                    return Err("persistent storage attachment duplicated");
                }
                found = true;
                metadata.attachment = None;
                metadata.state = "available".to_string();
                self.write_metadata(&path, &metadata)?;
            }
        }
        Ok(())
    }

    /// Releases every attachment only after the complete prior epoch is proved absent.
    pub fn release_fenced_attachments(&mut self) -> Result<(), &'static str> {
        let entries = fs::read_dir(&self.root).map_err(|_| "persistent storage root unreadable")?;
        for entry in entries {
            let entry = entry.map_err(|_| "persistent storage root unreadable")?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(mut metadata) = self.read_metadata(&path) else {
                continue;
            };
            if metadata.attachment.take().is_some() {
                metadata.state = "available".to_string();
                self.write_metadata(&path, &metadata)?;
            }
        }
        Ok(())
    }

    /// Returns exact association, attachment, initialization, and capacity facts.
    pub fn inspect(&self, storage_ref: &str, expected_generation: u64) -> Value {
        if validate_opaque_ref(storage_ref).is_err() || expected_generation == 0 {
            return self.inspect_result(storage_ref, "conflicted", None);
        }
        if path_exists_nofollow(&self.purging_path(storage_ref)) {
            return self.inspect_result(storage_ref, "unknown", None);
        }
        let association = self.association_path(storage_ref);
        if !path_exists_nofollow(&association) {
            return self.inspect_result(storage_ref, "missing", None);
        }
        let metadata = match self.read_metadata(&association) {
            Ok(metadata) => metadata,
            Err(_) => return self.inspect_result(storage_ref, "unknown", None),
        };
        if metadata.storage_ref != storage_ref
            || metadata.attachment_generation != expected_generation
            || metadata
                .attachment
                .as_ref()
                .is_some_and(|attachment| attachment.generation != expected_generation)
        {
            return self.inspect_result(storage_ref, "conflicted", Some(&metadata));
        }
        let targets_present = metadata.targets.iter().all(|target| {
            target.initialized
                && verify_volume_directory(
                    &self.volume_path(&association, &target.volume_ref),
                    metadata.uid,
                    metadata.gid,
                )
                .is_ok()
        });
        let state = if metadata.state == "unknown" {
            "unknown"
        } else if !targets_present {
            "incomplete"
        } else if metadata.attachment.is_some() {
            "attached"
        } else if metadata.state == "initializing" {
            "initializing"
        } else {
            "available"
        };
        self.inspect_result(storage_ref, state, Some(&metadata))
    }

    /// Purges one exact detached association, fencing partial removal by rename.
    pub fn purge(&mut self, storage_ref: &str, expected_generation: u64) -> Value {
        if validate_opaque_ref(storage_ref).is_err() || expected_generation == 0 {
            return json!({"storageRef": storage_ref, "state": "retained"});
        }
        let association = self.association_path(storage_ref);
        let tomb = self.purging_path(storage_ref);
        if path_exists_nofollow(&tomb) {
            let metadata = match self.read_metadata(&tomb) {
                Ok(metadata) => metadata,
                Err(_) => return json!({"storageRef": storage_ref, "state": "unknown"}),
            };
            if metadata.storage_ref != storage_ref
                || metadata.attachment_generation != expected_generation
                || metadata.attachment.is_some()
            {
                return json!({"storageRef": storage_ref, "state": "unknown"});
            }
        } else {
            if !path_exists_nofollow(&association) {
                return json!({"storageRef": storage_ref, "state": "purged"});
            }
            let metadata = match self.read_metadata(&association) {
                Ok(metadata) => metadata,
                Err(_) => return json!({"storageRef": storage_ref, "state": "retained"}),
            };
            if metadata.storage_ref != storage_ref
                || metadata.attachment_generation != expected_generation
                || metadata.attachment.is_some()
            {
                return json!({"storageRef": storage_ref, "state": "retained"});
            }
            if fs::rename(&association, &tomb).is_err() {
                return json!({"storageRef": storage_ref, "state": "retained"});
            }
            if File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .is_err()
            {
                return json!({"storageRef": storage_ref, "state": "unknown"});
            }
        }
        let state = if fs::remove_dir_all(&tomb).is_ok()
            && File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .is_ok()
        {
            "purged"
        } else {
            "unknown"
        };
        json!({"storageRef": storage_ref, "state": state})
    }

    fn create_association(
        &self,
        association: &Path,
        request: &StorageAttachmentRequest,
        layout: &ImageStorageLayout,
    ) -> Result<StorageMetadata, &'static str> {
        DirBuilder::new()
            .mode(0o700)
            .create(association)
            .map_err(|_| "persistent storage association unavailable")?;
        let created = (|| {
            fs::set_permissions(association, fs::Permissions::from_mode(0o700))
                .map_err(|_| "persistent storage association unavailable")?;
            DirBuilder::new()
                .mode(0o700)
                .create(association.join("volumes"))
                .map_err(|_| "persistent storage association unavailable")?;
            let metadata = StorageMetadata {
                storage_ref: request.storage_ref.clone(),
                scope_digest: request.scope_digest.clone(),
                layout_digest: request.layout_digest.clone(),
                uid: layout.uid,
                gid: layout.gid,
                family: layout.family.clone(),
                version: layout.version.clone(),
                os: layout.os.clone(),
                architecture: layout.architecture.clone(),
                attachment_generation: request.attachment_generation,
                state: "initializing".to_string(),
                attachment: None,
                targets: Vec::new(),
            };
            self.write_metadata(association, &metadata)?;
            Ok(metadata)
        })();
        if created.is_err() {
            let _ = fs::remove_dir_all(association);
        }
        created
    }

    fn seed_target(
        &self,
        association: &Path,
        image_digest: &str,
        binding: &StorageTargetBinding,
        uid: u32,
        gid: u32,
    ) -> Result<(), &'static str> {
        let key = component_key(&binding.volume_ref);
        let staging = association.join(format!(".seed-{key}"));
        if path_exists_nofollow(&staging) {
            return Err("persistent storage initialization incomplete");
        }
        DirBuilder::new()
            .mode(0o700)
            .create(&staging)
            .map_err(|_| "persistent storage staging unavailable")?;
        let seed_identity = format!("{}:{}", association.display(), binding.volume_ref);
        let container = format!("openkit-seed-{}", &component_key(&seed_identity)[..24]);
        if self
            .docker_status(&[
                "create",
                "--pull=never",
                "--network=none",
                "--read-only",
                "--name",
                &container,
                image_digest,
            ])
            .is_err()
        {
            let _ = fs::remove_dir_all(&staging);
            return Err("persistent storage seed container failed");
        }
        let copied = self.docker_extract_seed(&container, &binding.target, &staging);
        let removed = self.docker_status(&["rm", "--volumes", &container]);
        let root_mode = match (copied, removed) {
            (Ok(root_mode), Ok(())) => root_mode,
            _ => {
                let _ = fs::remove_dir_all(&staging);
                return Err("persistent storage image seed failed");
            }
        };
        if validate_seed_tree(&staging).is_err() {
            let _ = fs::remove_dir_all(&staging);
            return Err("persistent storage seed rejected");
        }
        if finalize_seed_root(&staging, uid, gid, root_mode).is_err() {
            let _ = fs::remove_dir_all(&staging);
            return Err("persistent storage finalization failed");
        }
        let volume = association.join("volumes").join(key);
        fs::rename(&staging, &volume).map_err(|_| "persistent storage publication failed")?;
        File::open(association.join("volumes"))
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "persistent storage publication failed")?;
        Ok(())
    }

    fn association_path(&self, storage_ref: &str) -> PathBuf {
        self.root.join(component_key(storage_ref))
    }

    fn purging_path(&self, storage_ref: &str) -> PathBuf {
        self.root
            .join(format!(".purging-{}", component_key(storage_ref)))
    }

    fn volume_path(&self, association: &Path, volume_ref: &str) -> PathBuf {
        association.join("volumes").join(component_key(volume_ref))
    }

    fn read_metadata(&self, association: &Path) -> Result<StorageMetadata, &'static str> {
        verify_private_directory(association, self.owner_uid)
            .map_err(|_| "persistent storage association identity invalid")?;
        verify_private_directory(&association.join("volumes"), self.owner_uid)
            .map_err(|_| "persistent storage volume parent identity invalid")?;
        let path = association.join(METADATA_NAME);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "persistent storage metadata unavailable")?;
        if !metadata.file_type().is_file()
            || metadata.uid() != self.owner_uid
            || metadata.mode() & 0o777 != 0o600
            || metadata.len() > 512 * 1024
        {
            return Err("persistent storage metadata identity invalid");
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|_| "persistent storage metadata unavailable")?;
        decode_metadata(&bytes)
    }

    fn write_metadata(
        &self,
        association: &Path,
        metadata: &StorageMetadata,
    ) -> Result<(), &'static str> {
        verify_private_directory(association, self.owner_uid)
            .map_err(|_| "persistent storage association identity invalid")?;
        let bytes = encode_metadata(metadata)?;
        let temporary = association.join(".identity.tmp");
        if temporary.exists() {
            let stale = fs::symlink_metadata(&temporary)
                .map_err(|_| "persistent storage metadata staging invalid")?;
            if !stale.file_type().is_file() || stale.uid() != self.owner_uid {
                return Err("persistent storage metadata staging invalid");
            }
            fs::remove_file(&temporary)
                .map_err(|_| "persistent storage metadata staging invalid")?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "persistent storage metadata unavailable")?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "persistent storage metadata unavailable")?;
        fs::rename(&temporary, association.join(METADATA_NAME))
            .map_err(|_| "persistent storage metadata unavailable")?;
        File::open(association)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "persistent storage metadata unavailable")
    }

    fn inspect_result(
        &self,
        storage_ref: &str,
        state: &str,
        metadata: Option<&StorageMetadata>,
    ) -> Value {
        let (state, available_bytes, total_bytes) = match filesystem_capacity(&self.root) {
            Ok((available, total)) => (state, available, total),
            Err(_) => ("unknown", 0, 0),
        };
        json!({
            "storageRef": storage_ref,
            "state": state,
            "scopeDigest": metadata.map(|metadata| metadata.scope_digest.as_str()),
            "layoutDigest": metadata.map(|metadata| metadata.layout_digest.as_str()),
            "attachment": metadata.and_then(|metadata| metadata.attachment.as_ref()).map(|attachment| json!({
                "generation": attachment.generation,
                "sandboxId": attachment.sandbox_id,
            })),
            "targets": metadata.map_or_else(Vec::new, |metadata| metadata.targets.iter().map(|target| json!({
                "target": target.target,
                "volumeRef": target.volume_ref,
                "initialized": target.initialized,
            })).collect()),
            "capacity": {"availableBytes": available_bytes, "totalBytes": total_bytes},
        })
    }

    fn docker_status(&self, arguments: &[&str]) -> Result<(), &'static str> {
        let mut child = self
            .docker_command()
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "private Docker command failed")?;
        wait_child(&mut child, DOCKER_TIMEOUT)
    }

    fn docker_output(&self, arguments: &[&str]) -> Result<Vec<u8>, &'static str> {
        let mut child = self
            .docker_command()
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "private Docker inspection failed")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("private Docker inspection failed")?;
        let reader = thread::spawn(move || read_bounded(stdout, MAX_DOCKER_INSPECT_BYTES));
        if wait_child(&mut child, DOCKER_TIMEOUT).is_err() {
            let _ = reader.join();
            return Err("private Docker inspection failed");
        }
        reader
            .join()
            .map_err(|_| "private Docker inspection failed")?
            .map_err(|_| "private Docker inspection failed")
    }

    fn docker_extract_seed(
        &self,
        container: &str,
        target: &str,
        staging: &Path,
    ) -> Result<u32, &'static str> {
        let source = format!("{container}:{target}/.");
        let mut child = self
            .docker_command()
            .args(["cp", "--archive", &source, "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "private Docker seed copy failed")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("private Docker seed copy failed")?;
        let staging = staging.to_path_buf();
        let extractor = thread::spawn(move || extract_seed_archive(stdout, &staging));
        let status = wait_child(&mut child, DOCKER_TIMEOUT);
        let extracted = extractor
            .join()
            .map_err(|_| "private Docker seed extraction failed")?;
        status.map_err(|_| "private Docker seed copy failed")?;
        extracted.map_err(|_| "private Docker seed extraction failed")
    }

    fn docker_command(&self) -> Command {
        let mut command = Command::new("/usr/bin/docker");
        command.env(
            "DOCKER_HOST",
            format!("unix://{}", self.docker_socket.display()),
        );
        command
    }
}

fn parse_image_inspect(
    expected_digest: &str,
    bytes: &[u8],
) -> Result<ImageStorageLayout, &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "image.inspect result invalid")?;
    let object = value.as_object().ok_or("image.inspect result invalid")?;
    let digest = object
        .get("Id")
        .and_then(Value::as_str)
        .filter(|digest| *digest == expected_digest)
        .ok_or("image.inspect digest mismatch")?
        .to_string();
    let config = object
        .get("Config")
        .and_then(Value::as_object)
        .ok_or("image.inspect config invalid")?;
    let (uid, gid) = config
        .get("User")
        .and_then(Value::as_str)
        .and_then(parse_numeric_user)
        .ok_or("image.inspect numeric user invalid")?;
    let working_directory = config
        .get("WorkingDir")
        .and_then(Value::as_str)
        .filter(|path| validate_target(path).is_ok())
        .ok_or("image.inspect WorkingDir invalid")?
        .to_string();
    let mut targets = config
        .get("Volumes")
        .and_then(Value::as_object)
        .ok_or("image.inspect Volumes missing")?
        .keys()
        .map(|target| {
            validate_target(target)?;
            Ok(target.clone())
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    targets.sort();
    if targets.is_empty()
        || targets.len() > MAX_TARGETS
        || targets.iter().enumerate().any(|(index, target)| {
            targets[..index]
                .iter()
                .any(|other| paths_overlap(other, target))
        })
        || targets
            .iter()
            .any(|target| paths_overlap(target, &working_directory))
    {
        return Err("image.inspect storage layout invalid");
    }
    let labels = config.get("Labels").and_then(Value::as_object);
    let label = |key| {
        labels
            .and_then(|labels| labels.get(key))
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
            })
            .map(str::to_string)
    };
    let os = object
        .get("Os")
        .and_then(Value::as_str)
        .filter(|value| *value == "linux")
        .ok_or("image.inspect platform invalid")?
        .to_string();
    let architecture = object
        .get("Architecture")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "amd64" | "arm64"))
        .ok_or("image.inspect platform invalid")?
        .to_string();
    Ok(ImageStorageLayout {
        digest,
        family: label(FAMILY_LABEL),
        version: label(VERSION_LABEL),
        uid,
        gid,
        working_directory,
        os,
        architecture,
        targets,
    })
}

fn validate_attachment_request(
    sandbox_id: &str,
    request: &StorageAttachmentRequest,
    layout: &ImageStorageLayout,
) -> Result<(), &'static str> {
    validate_opaque_ref(&request.storage_ref)?;
    validate_digest(&request.scope_digest)?;
    validate_digest(&request.layout_digest)?;
    if sandbox_id.is_empty()
        || sandbox_id.len() > 512
        || sandbox_id.chars().any(char::is_control)
        || request.attachment_generation == 0
        || request.layout_digest != layout.layout_digest()
        || layout.family.is_none()
        || layout.version.is_none()
        || request.targets.len() != layout.targets.len()
    {
        return Err("persistent storage attachment invalid");
    }
    let mut targets = BTreeSet::new();
    let mut volumes = BTreeSet::new();
    for binding in &request.targets {
        validate_target(&binding.target)?;
        validate_opaque_ref(&binding.volume_ref)?;
        if !layout.targets.contains(&binding.target)
            || !targets.insert(binding.target.as_str())
            || !volumes.insert(binding.volume_ref.as_str())
        {
            return Err("persistent storage target identity invalid");
        }
    }
    Ok(())
}

fn validate_target(target: &str) -> Result<(), &'static str> {
    if target.len() < 2
        || target.len() > 4096
        || !target.starts_with('/')
        || target.ends_with('/')
        || target.contains("//")
        || target.chars().any(char::is_control)
    {
        return Err("persistent storage target invalid");
    }
    let path = Path::new(target);
    if path
        .components()
        .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err("persistent storage target invalid");
    }
    for forbidden in [
        "/openkit",
        "/bin",
        "/boot",
        "/etc",
        "/lib",
        "/lib64",
        "/opt",
        "/proc",
        "/sbin",
        "/sys",
        "/usr",
        "/dev",
        "/run",
        "/var/run",
        "/var/lib/openkit",
    ] {
        if path == Path::new(forbidden) || path.starts_with(forbidden) {
            return Err("persistent storage target reserved");
        }
    }
    Ok(())
}

fn validate_opaque_ref(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 512
        || value.chars().any(char::is_control)
        || value.trim() != value
    {
        return Err("persistent storage reference invalid");
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), &'static str> {
    let valid = value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    });
    valid
        .then_some(())
        .ok_or("persistent storage digest invalid")
}

fn parse_numeric_user(value: &str) -> Option<(u32, u32)> {
    let (uid, gid) = value.split_once(':')?;
    if uid.is_empty()
        || gid.is_empty()
        || (uid.len() > 1 && uid.starts_with('0'))
        || (gid.len() > 1 && gid.starts_with('0'))
    {
        return None;
    }
    Some((uid.parse().ok()?, gid.parse().ok()?))
}

fn paths_overlap(left: &str, right: &str) -> bool {
    Path::new(left).starts_with(right) || Path::new(right).starts_with(left)
}

fn component_key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn path_exists_nofollow(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn verify_private_directory(path: &Path, uid: u32) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.uid() != uid || metadata.mode() & 0o777 != 0o700 {
        return Err(io::Error::other("private directory identity invalid"));
    }
    Ok(())
}

fn verify_volume_directory(path: &Path, uid: u32, gid: u32) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.uid() != uid || metadata.gid() != gid {
        return Err(io::Error::other("volume directory identity invalid"));
    }
    Ok(())
}

#[derive(Debug)]
struct SeedDirectoryIdentity {
    path: PathBuf,
    mode: u32,
    uid: u32,
    gid: u32,
}

#[derive(Debug)]
struct PendingSeedHardlink {
    path: PathBuf,
    target: PathBuf,
    mode: u32,
    uid: u32,
    gid: u32,
}

fn extract_seed_archive(mut reader: impl Read, root: &Path) -> io::Result<u32> {
    reject_extended_metadata(root)?;
    let mut entries = 0_u64;
    let mut bytes = 0_u64;
    let mut root_mode = None;
    let mut directories = Vec::<SeedDirectoryIdentity>::new();
    let mut hardlinks = Vec::<PendingSeedHardlink>::new();
    loop {
        let mut header = [0_u8; TAR_BLOCK_BYTES];
        reader.read_exact(&mut header)?;
        if header.iter().all(|byte| *byte == 0) {
            let mut terminator = [0_u8; TAR_BLOCK_BYTES];
            reader.read_exact(&mut terminator)?;
            if terminator.iter().any(|byte| *byte != 0) {
                return Err(io::Error::other("seed archive terminator invalid"));
            }
            validate_tar_zero_tail(&mut reader)?;
            break;
        }
        validate_tar_header(&header)?;
        let path = tar_header_path(&header)?;
        let relative = safe_archive_path(path)?;
        let mode = u32::try_from(parse_tar_number(&header[100..108])?)
            .map_err(|_| io::Error::other("seed archive mode invalid"))?
            & 0o7777;
        let uid = u32::try_from(parse_tar_number(&header[108..116])?)
            .map_err(|_| io::Error::other("seed archive uid invalid"))?;
        let gid = u32::try_from(parse_tar_number(&header[116..124])?)
            .map_err(|_| io::Error::other("seed archive gid invalid"))?;
        let size = parse_tar_number(&header[124..136])?;
        let Some(relative) = relative else {
            if header[156] != b'5' || size != 0 || root_mode.replace(mode).is_some() {
                return Err(io::Error::other("seed archive root entry invalid"));
            }
            continue;
        };
        entries = entries
            .checked_add(1)
            .filter(|count| *count <= MAX_SEED_ENTRIES)
            .ok_or_else(|| io::Error::other("seed entry bound exceeded"))?;
        let destination = root.join(&relative);
        verify_seed_parent(root, &relative)?;
        if path_exists_nofollow(&destination) {
            return Err(io::Error::other("duplicate seed archive path"));
        }
        match header[156] {
            0 | b'0' => {
                bytes = bytes
                    .checked_add(size)
                    .filter(|count| *count <= MAX_SEED_BYTES)
                    .ok_or_else(|| io::Error::other("seed byte bound exceeded"))?;
                require_seed_capacity(root, size, true)?;
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&destination)?;
                copy_exact(&mut reader, &mut file, size)?;
                set_seed_owner(&destination, uid, gid)?;
                fs::set_permissions(&destination, fs::Permissions::from_mode(mode))?;
                file.sync_all()?;
                discard_tar_padding(&mut reader, size)?;
            }
            b'5' if size == 0 => {
                require_seed_capacity(root, 0, true)?;
                DirBuilder::new().mode(0o700).create(&destination)?;
                directories.push(SeedDirectoryIdentity {
                    path: destination,
                    mode,
                    uid,
                    gid,
                });
            }
            b'2' if size == 0 => {
                require_seed_capacity(root, 0, true)?;
                let target = tar_link_path(&header)?;
                std::os::unix::fs::symlink(target, &destination)?;
                set_seed_owner(&destination, uid, gid)?;
            }
            b'1' if size == 0 => {
                let target = safe_archive_path(tar_link_path(&header)?)?
                    .ok_or_else(|| io::Error::other("seed hardlink target invalid"))?;
                verify_seed_parent(root, &target)?;
                hardlinks.push(PendingSeedHardlink {
                    path: destination,
                    target: root.join(target),
                    mode,
                    uid,
                    gid,
                });
            }
            b'x' | b'g' | b'L' | b'K' => {
                return Err(io::Error::other("extended seed metadata rejected"));
            }
            _ => return Err(io::Error::other("seed archive entry type rejected")),
        }
    }
    for hardlink in hardlinks {
        require_seed_capacity(root, 0, false)?;
        let target_relative = hardlink
            .target
            .strip_prefix(root)
            .map_err(|_| io::Error::other("seed hardlink target invalid"))?;
        verify_seed_parent(root, target_relative)?;
        let target = fs::symlink_metadata(&hardlink.target)?;
        if !target.file_type().is_file()
            || target.uid() != hardlink.uid
            || target.gid() != hardlink.gid
            || target.mode() & 0o7777 != hardlink.mode
        {
            return Err(io::Error::other("seed hardlink identity invalid"));
        }
        fs::hard_link(&hardlink.target, &hardlink.path)?;
    }
    directories.sort_by_key(|entry| std::cmp::Reverse(entry.path.components().count()));
    for directory in directories {
        set_seed_owner(&directory.path, directory.uid, directory.gid)?;
        fs::set_permissions(&directory.path, fs::Permissions::from_mode(directory.mode))?;
        File::open(&directory.path)?.sync_all()?;
    }
    validate_seed_tree(root)?;
    File::open(root)?.sync_all()?;
    root_mode.ok_or_else(|| io::Error::other("seed archive root entry missing"))
}

fn validate_tar_header(header: &[u8; TAR_BLOCK_BYTES]) -> io::Result<()> {
    if &header[257..263] != b"ustar\0" || &header[263..265] != b"00" {
        return Err(io::Error::other("seed archive format rejected"));
    }
    let expected = parse_tar_number(&header[148..156])?;
    let actual = header
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                u64::from(b' ')
            } else {
                u64::from(*byte)
            }
        })
        .sum::<u64>();
    if expected != actual
        || parse_tar_number(&header[329..337])? != 0
        || parse_tar_number(&header[337..345])? != 0
    {
        return Err(io::Error::other("seed archive header invalid"));
    }
    Ok(())
}

fn parse_tar_number(field: &[u8]) -> io::Result<u64> {
    if field.first().is_some_and(|byte| byte & 0x80 != 0) {
        return Err(io::Error::other("seed archive numeric encoding rejected"));
    }
    let start = field
        .iter()
        .position(|byte| !matches!(*byte, 0 | b' '))
        .unwrap_or(field.len());
    let end = field
        .iter()
        .rposition(|byte| !matches!(*byte, 0 | b' '))
        .map_or(start, |index| index + 1);
    let text = &field[start..end];
    if text.is_empty() {
        return Ok(0);
    }
    if text.iter().any(|byte| !matches!(*byte, b'0'..=b'7')) {
        return Err(io::Error::other("seed archive numeric field invalid"));
    }
    text.iter().try_fold(0_u64, |value, byte| {
        value
            .checked_mul(8)
            .and_then(|value| value.checked_add(u64::from(*byte - b'0')))
            .ok_or_else(|| io::Error::other("seed archive numeric field overflow"))
    })
}

fn tar_header_path(header: &[u8; TAR_BLOCK_BYTES]) -> io::Result<OsString> {
    let name = tar_text_field(&header[..100])?;
    let prefix = tar_text_field(&header[345..500])?;
    if name.is_empty() {
        return Err(io::Error::other("seed archive path missing"));
    }
    let mut path = prefix;
    if !path.is_empty() {
        path.push(b'/');
    }
    path.extend(name);
    Ok(OsString::from_vec(path))
}

fn tar_link_path(header: &[u8; TAR_BLOCK_BYTES]) -> io::Result<OsString> {
    let link = tar_text_field(&header[157..257])?;
    if link.is_empty() {
        return Err(io::Error::other("seed archive link target missing"));
    }
    Ok(OsString::from_vec(link))
}

fn tar_text_field(field: &[u8]) -> io::Result<Vec<u8>> {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    if field[end..].iter().any(|byte| *byte != 0) {
        return Err(io::Error::other("seed archive text field invalid"));
    }
    Ok(field[..end].to_vec())
}

fn safe_archive_path(path: OsString) -> io::Result<Option<PathBuf>> {
    let mut safe = PathBuf::new();
    for component in Path::new(&path).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(component) => safe.push(component),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(io::Error::other("seed archive path rejected"));
            }
        }
    }
    Ok((!safe.as_os_str().is_empty()).then_some(safe))
}

fn verify_seed_parent(root: &Path, relative: &Path) -> io::Result<()> {
    let mut current = root.to_path_buf();
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            let Component::Normal(component) = component else {
                return Err(io::Error::other("seed archive parent rejected"));
            };
            current.push(component);
            if !fs::symlink_metadata(&current)?.file_type().is_dir() {
                return Err(io::Error::other("seed archive parent rejected"));
            }
        }
    }
    Ok(())
}

fn copy_exact(reader: &mut impl Read, writer: &mut impl Write, length: u64) -> io::Result<()> {
    let mut limited = reader.take(length);
    if io::copy(&mut limited, writer)? != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "seed archive entry truncated",
        ));
    }
    Ok(())
}

fn discard_tar_padding(reader: &mut impl Read, length: u64) -> io::Result<()> {
    let padding =
        (TAR_BLOCK_BYTES as u64 - length % TAR_BLOCK_BYTES as u64) % TAR_BLOCK_BYTES as u64;
    let mut limited = reader.take(padding);
    if io::copy(&mut limited, &mut io::sink())? != padding {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "seed archive padding truncated",
        ));
    }
    Ok(())
}

fn validate_tar_zero_tail(reader: &mut impl Read) -> io::Result<()> {
    let mut limited = reader.take(MAX_TAR_ZERO_TAIL_BYTES + 1);
    let mut tail = Vec::new();
    limited.read_to_end(&mut tail)?;
    if tail.len() as u64 > MAX_TAR_ZERO_TAIL_BYTES || tail.iter().any(|byte| *byte != 0) {
        return Err(io::Error::other("seed archive trailing bytes rejected"));
    }
    Ok(())
}

fn require_seed_capacity(root: &Path, bytes: u64, inode: bool) -> io::Result<()> {
    let path = std::ffi::CString::new(root.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::other("seed capacity path invalid"))?;
    let mut facts = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and facts is writable for one result.
    if unsafe { libc::statvfs(path.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful statvfs initialized the complete structure.
    let facts = unsafe { facts.assume_init() };
    let available_bytes =
        statvfs_value(facts.f_bavail).saturating_mul(statvfs_value(facts.f_frsize));
    let required_bytes = bytes
        .checked_add(SEED_FREE_BYTE_RESERVE)
        .ok_or_else(|| io::Error::other("seed capacity overflow"))?;
    if available_bytes < required_bytes
        || (inode && statvfs_value(facts.f_favail) <= SEED_FREE_INODE_RESERVE)
    {
        return Err(io::Error::other("seed capacity unavailable"));
    }
    Ok(())
}

fn set_seed_owner(path: &Path, uid: u32, gid: u32) -> io::Result<()> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::other("seed ownership path invalid"))?;
    // SAFETY: path is NUL-terminated and lchown never follows a final symlink.
    if unsafe { libc::lchown(path.as_ptr(), uid, gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn finalize_seed_root(path: &Path, uid: u32, gid: u32, mode: u32) -> io::Result<()> {
    set_seed_owner(path, uid, gid)?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    File::open(path)?.sync_all()
}

fn reject_extended_metadata(path: &Path) -> io::Result<()> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::other("seed metadata path invalid"))?;
    #[cfg(target_os = "linux")]
    {
        // SAFETY: path is NUL-terminated; a null list with zero size queries only its length.
        let length = unsafe { libc::llistxattr(path.as_ptr(), std::ptr::null_mut(), 0) };
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        if length > 0 {
            return Err(io::Error::other("extended seed metadata rejected"));
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = path;
        Ok(())
    }
}

fn validate_seed_tree(root: &Path) -> io::Result<()> {
    reject_extended_metadata(root)?;
    let mut stack = vec![(root.to_path_buf(), PathBuf::new())];
    let mut entries = 0_u64;
    let mut bytes = 0_u64;
    let mut hardlinks = HashMap::<(u64, u64), (u64, u64)>::new();
    while let Some((directory, relative)) = stack.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            entries = entries
                .checked_add(1)
                .filter(|entries| *entries <= MAX_SEED_ENTRIES)
                .ok_or_else(|| io::Error::other("seed entry bound exceeded"))?;
            let metadata = fs::symlink_metadata(entry.path())?;
            reject_extended_metadata(&entry.path())?;
            let entry_relative = relative.join(entry.file_name());
            if metadata.file_type().is_dir() {
                stack.push((entry.path(), entry_relative));
            } else if metadata.file_type().is_file() {
                let links = hardlinks
                    .entry((metadata.dev(), metadata.ino()))
                    .or_insert((metadata.nlink(), 0));
                if links.0 != metadata.nlink() {
                    return Err(io::Error::other("seed hardlink identity changed"));
                }
                links.1 = links
                    .1
                    .checked_add(1)
                    .ok_or_else(|| io::Error::other("seed hardlink bound exceeded"))?;
                if links.1 == 1 {
                    bytes = bytes
                        .checked_add(metadata.len())
                        .filter(|bytes| *bytes <= MAX_SEED_BYTES)
                        .ok_or_else(|| io::Error::other("seed byte bound exceeded"))?;
                }
            } else if !metadata.file_type().is_symlink() {
                return Err(io::Error::other("seed special file rejected"));
            }
        }
    }
    if hardlinks
        .values()
        .any(|(declared_links, observed_links)| declared_links != observed_links)
    {
        return Err(io::Error::other("external seed hardlink rejected"));
    }
    Ok(())
}

fn encode_metadata(metadata: &StorageMetadata) -> Result<Vec<u8>, &'static str> {
    serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "storageRef": metadata.storage_ref,
        "scopeDigest": metadata.scope_digest,
        "layoutDigest": metadata.layout_digest,
        "uid": metadata.uid,
        "gid": metadata.gid,
        "family": metadata.family,
        "version": metadata.version,
        "os": metadata.os,
        "architecture": metadata.architecture,
        "attachmentGeneration": metadata.attachment_generation,
        "state": metadata.state,
        "attachment": metadata.attachment.as_ref().map(|attachment| json!({
            "generation": attachment.generation,
            "sandboxId": attachment.sandbox_id,
        })),
        "targets": metadata.targets.iter().map(|target| json!({
            "target": target.target,
            "volumeRef": target.volume_ref,
            "initialized": target.initialized,
        })).collect::<Vec<_>>(),
    }))
    .map_err(|_| "persistent storage metadata invalid")
}

fn decode_metadata(bytes: &[u8]) -> Result<StorageMetadata, &'static str> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "persistent storage metadata invalid")?;
    let object = value
        .as_object()
        .filter(|object| object.len() == 14)
        .ok_or("persistent storage metadata invalid")?;
    for key in [
        "schemaVersion",
        "storageRef",
        "scopeDigest",
        "layoutDigest",
        "uid",
        "gid",
        "family",
        "version",
        "os",
        "architecture",
        "attachmentGeneration",
        "state",
        "attachment",
        "targets",
    ] {
        if !object.contains_key(key) {
            return Err("persistent storage metadata invalid");
        }
    }
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("persistent storage metadata invalid");
    }
    let string = |name| {
        object
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("persistent storage metadata invalid")
    };
    let storage_ref = string("storageRef")?;
    let scope_digest = string("scopeDigest")?;
    let layout_digest = string("layoutDigest")?;
    validate_opaque_ref(&storage_ref)?;
    validate_digest(&scope_digest)?;
    validate_digest(&layout_digest)?;
    let uid = object
        .get("uid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("persistent storage metadata invalid")?;
    let gid = object
        .get("gid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("persistent storage metadata invalid")?;
    let optional_string = |name| match object.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control) =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err("persistent storage metadata invalid"),
    };
    let family = optional_string("family")?;
    let version = optional_string("version")?;
    let os = string("os")?;
    let architecture = string("architecture")?;
    if os != "linux" || !matches!(architecture.as_str(), "amd64" | "arm64") {
        return Err("persistent storage metadata invalid");
    }
    let attachment_generation = object
        .get("attachmentGeneration")
        .and_then(Value::as_u64)
        .filter(|generation| *generation > 0 && *generation <= MAX_SAFE_JSON_INTEGER)
        .ok_or("persistent storage metadata invalid")?;
    let state = string("state")?;
    if !matches!(
        state.as_str(),
        "initializing" | "available" | "attached" | "unknown"
    ) {
        return Err("persistent storage metadata invalid");
    }
    let attachment = match object.get("attachment") {
        Some(Value::Null) => None,
        Some(Value::Object(attachment))
            if attachment.len() == 2
                && attachment.contains_key("generation")
                && attachment.contains_key("sandboxId") =>
        {
            Some(StoredAttachment {
                generation: attachment
                    .get("generation")
                    .and_then(Value::as_u64)
                    .filter(|generation| *generation > 0)
                    .ok_or("persistent storage metadata invalid")?,
                sandbox_id: attachment
                    .get("sandboxId")
                    .and_then(Value::as_str)
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= 512
                            && !value.chars().any(char::is_control)
                    })
                    .ok_or("persistent storage metadata invalid")?
                    .to_string(),
            })
        }
        _ => return Err("persistent storage metadata invalid"),
    };
    let targets = object
        .get("targets")
        .and_then(Value::as_array)
        .filter(|targets| targets.len() <= MAX_TARGETS)
        .ok_or("persistent storage metadata invalid")?
        .iter()
        .map(|target| {
            let target = target
                .as_object()
                .filter(|target| {
                    target.len() == 3
                        && target.contains_key("target")
                        && target.contains_key("volumeRef")
                        && target.contains_key("initialized")
                })
                .ok_or("persistent storage metadata invalid")?;
            let path = target
                .get("target")
                .and_then(Value::as_str)
                .ok_or("persistent storage metadata invalid")?
                .to_string();
            let volume_ref = target
                .get("volumeRef")
                .and_then(Value::as_str)
                .ok_or("persistent storage metadata invalid")?
                .to_string();
            validate_target(&path)?;
            validate_opaque_ref(&volume_ref)?;
            Ok(StoredTarget {
                target: path,
                volume_ref,
                initialized: target
                    .get("initialized")
                    .and_then(Value::as_bool)
                    .ok_or("persistent storage metadata invalid")?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let targets_ordered = targets
        .windows(2)
        .all(|pair| pair[0].target < pair[1].target);
    let unique_volume_refs = targets
        .iter()
        .map(|target| target.volume_ref.as_str())
        .collect::<BTreeSet<_>>()
        .len()
        == targets.len();
    let attachment_consistent = match (&attachment, state.as_str()) {
        (Some(attachment), "attached") => attachment.generation == attachment_generation,
        (None, "initializing" | "available" | "unknown") => true,
        _ => false,
    };
    if !targets_ordered || !unique_volume_refs || !attachment_consistent {
        return Err("persistent storage metadata invalid");
    }
    Ok(StorageMetadata {
        storage_ref,
        scope_digest,
        layout_digest,
        uid,
        gid,
        family,
        version,
        os,
        architecture,
        attachment_generation,
        state,
        attachment,
        targets,
    })
}

fn filesystem_capacity(path: &Path) -> io::Result<(u64, u64)> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::other("capacity path invalid"))?;
    let mut facts = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and facts is writable for one result.
    if unsafe { libc::statvfs(path.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful statvfs initialized the complete structure.
    let facts = unsafe { facts.assume_init() };
    let block_size = statvfs_value(facts.f_frsize);
    let available = statvfs_value(facts.f_bavail).saturating_mul(block_size);
    let total = statvfs_value(facts.f_blocks).saturating_mul(block_size);
    if available > MAX_SAFE_JSON_INTEGER || total > MAX_SAFE_JSON_INTEGER {
        return Err(io::Error::other("capacity exceeds transport range"));
    }
    Ok((available, total))
}

fn statvfs_value<T: Into<u64>>(value: T) -> u64 {
    value.into()
}

fn read_bounded(mut reader: impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut output = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut exceeded = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read) > limit {
            exceeded = true;
        } else if !exceeded {
            output.extend_from_slice(&buffer[..read]);
        }
    }
    if exceeded {
        Err(io::Error::other("output bound exceeded"))
    } else {
        Ok(output)
    }
}

fn wait_child(child: &mut Child, limit: Duration) -> Result<(), &'static str> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err("private Docker command failed"),
            Ok(None) if started.elapsed() < limit => sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("private Docker command timed out");
            }
            Err(_) => return Err("private Docker command failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn temporary_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "openkit-volume-test-{}-{nonce}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn test_store(root: &Path) -> PersistentVolumeStore {
        let uid = unsafe { libc::geteuid() };
        PersistentVolumeStore::open_at(root.to_path_buf(), PathBuf::from("/missing"), uid).unwrap()
    }

    fn stored_association(
        store: &PersistentVolumeStore,
        storage_ref: &str,
        sandbox_id: &str,
        generation: u64,
    ) -> (PathBuf, PathBuf) {
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let layout = ImageStorageLayout {
            digest: digest('a'),
            family: Some("openkit-worker".into()),
            version: Some("1".into()),
            uid,
            gid,
            working_directory: "/tmp/openkit-bootstrap".into(),
            os: "linux".into(),
            architecture: "arm64".into(),
            targets: vec!["/workspace".into()],
        };
        let request = StorageAttachmentRequest {
            storage_ref: storage_ref.into(),
            scope_digest: digest('b'),
            attachment_generation: generation,
            layout_digest: layout.layout_digest(),
            targets: vec![StorageTargetBinding {
                target: "/workspace".into(),
                volume_ref: format!("{storage_ref}-volume"),
            }],
        };
        let association = store.association_path(storage_ref);
        let mut metadata = store
            .create_association(&association, &request, &layout)
            .unwrap();
        let volume = store.volume_path(&association, &request.targets[0].volume_ref);
        DirBuilder::new().mode(0o700).create(&volume).unwrap();
        metadata.attachment_generation = generation;
        metadata.state = "attached".into();
        metadata.attachment = Some(StoredAttachment {
            generation,
            sandbox_id: sandbox_id.into(),
        });
        metadata.targets.push(StoredTarget {
            target: "/workspace".into(),
            volume_ref: request.targets[0].volume_ref.clone(),
            initialized: true,
        });
        store.write_metadata(&association, &metadata).unwrap();
        (association, volume)
    }

    fn tar_header(
        name: &str,
        entry_type: u8,
        size: u64,
        mode: u32,
        uid: u32,
        gid: u32,
        link: Option<&str>,
    ) -> [u8; TAR_BLOCK_BYTES] {
        fn number(field: &mut [u8], value: u64) {
            let encoded = format!("{value:o}");
            assert!(encoded.len() <= field.len());
            field.fill(b'0');
            let start = field.len() - encoded.len();
            field[start..].copy_from_slice(encoded.as_bytes());
            if start > 0 {
                field[field.len() - 1] = 0;
                let digit_start = field.len() - 1 - encoded.len();
                field[digit_start..digit_start + encoded.len()].copy_from_slice(encoded.as_bytes());
            }
        }

        let mut header = [0_u8; TAR_BLOCK_BYTES];
        header[..name.len()].copy_from_slice(name.as_bytes());
        number(&mut header[100..108], u64::from(mode));
        number(&mut header[108..116], u64::from(uid));
        number(&mut header[116..124], u64::from(gid));
        number(&mut header[124..136], size);
        number(&mut header[136..148], 0);
        header[148..156].fill(b' ');
        header[156] = entry_type;
        if let Some(link) = link {
            header[157..157 + link.len()].copy_from_slice(link.as_bytes());
        }
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let checksum = header.iter().map(|byte| u64::from(*byte)).sum::<u64>();
        let checksum = format!("{checksum:06o}\0 ");
        header[148..156].copy_from_slice(checksum.as_bytes());
        header
    }

    fn append_tar_entry(archive: &mut Vec<u8>, header: &[u8; TAR_BLOCK_BYTES], body: &[u8]) {
        archive.extend_from_slice(header);
        archive.extend_from_slice(body);
        archive.resize(
            archive.len() + (TAR_BLOCK_BYTES - body.len() % TAR_BLOCK_BYTES) % TAR_BLOCK_BYTES,
            0,
        );
    }

    #[test]
    fn image_layout_uses_exact_oci_facts_and_core_digest_order() {
        let image_digest = digest('a');
        let fixture = json!({
            "Id": image_digest,
            "Os": "linux",
            "Architecture": "arm64",
            "Config": {
                "User": "1000:1000",
                "WorkingDir": "/tmp/openkit-bootstrap",
                "Volumes": {"/workspace": {}, "/sandbox": {}},
                "Labels": {
                    FAMILY_LABEL: "openkit-worker",
                    VERSION_LABEL: "1",
                }
            }
        });
        let layout =
            parse_image_inspect(&image_digest, &serde_json::to_vec(&fixture).unwrap()).unwrap();
        assert_eq!(layout.targets, ["/sandbox", "/workspace"]);
        let canonical = "{\"family\":\"openkit-worker\",\"version\":\"1\",\"uid\":1000,\"gid\":1000,\"workingDirectory\":\"/tmp/openkit-bootstrap\",\"platform\":{\"architecture\":\"arm64\",\"os\":\"linux\"},\"targets\":[{\"target\":\"/sandbox\"},{\"target\":\"/workspace\"}]}";
        assert_eq!(
            layout.layout_digest(),
            format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
        );
        assert_eq!(layout.result_json()["storageLayout"]["uid"], 1000);
    }

    #[test]
    fn layout_rejects_overlaps_reserved_targets_and_workdir_masking() {
        let image_digest = digest('b');
        for volumes in [
            json!({"/workspace": {}, "/workspace/nested": {}}),
            json!({"/openkit": {}}),
            json!({"/usr/local/data": {}}),
            json!({"/tmp": {}}),
        ] {
            let fixture = json!({
                "Id": image_digest,
                "Os": "linux",
                "Architecture": "amd64",
                "Config": {
                    "User": "1000:1000",
                    "WorkingDir": "/tmp/openkit-bootstrap",
                    "Volumes": volumes,
                    "Labels": null,
                }
            });
            assert!(
                parse_image_inspect(&image_digest, &serde_json::to_vec(&fixture).unwrap()).is_err()
            );
        }
    }

    #[test]
    fn seed_validation_preserves_symlink_bytes_without_following_them() {
        let root = temporary_root();
        fs::create_dir(&root).unwrap();
        symlink("../../outside", root.join("relative")).unwrap();
        symlink("/opt/runtime/bin/python", root.join("absolute")).unwrap();
        assert!(validate_seed_tree(&root).is_ok());
        assert_eq!(
            fs::read_link(root.join("relative")).unwrap(),
            Path::new("../../outside")
        );
        assert_eq!(
            fs::read_link(root.join("absolute")).unwrap(),
            Path::new("/opt/runtime/bin/python")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn seed_validation_preserves_internal_hardlinks_and_rejects_external_ones() {
        let root = temporary_root();
        let outside = temporary_root();
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("first"), b"same inode").unwrap();
        fs::hard_link(root.join("first"), root.join("second")).unwrap();
        assert!(validate_seed_tree(&root).is_ok());

        fs::write(outside.join("external"), b"outside inode").unwrap();
        fs::hard_link(outside.join("external"), root.join("external-link")).unwrap();
        assert!(validate_seed_tree(&root).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn streaming_seed_extraction_preserves_safe_entries_and_internal_hardlinks() {
        let root = temporary_root();
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let mut archive = Vec::new();
        append_tar_entry(
            &mut archive,
            &tar_header("./", b'5', 0, 0o755, uid, gid, None),
            &[],
        );
        append_tar_entry(
            &mut archive,
            &tar_header("./data", b'5', 0, 0o750, uid, gid, None),
            &[],
        );
        append_tar_entry(
            &mut archive,
            &tar_header("./data/file", b'0', 5, 0o640, uid, gid, None),
            b"hello",
        );
        append_tar_entry(
            &mut archive,
            &tar_header("./data/link", b'2', 0, 0o777, uid, gid, Some("file")),
            &[],
        );
        append_tar_entry(
            &mut archive,
            &tar_header("./data/hard", b'1', 0, 0o640, uid, gid, Some("./data/file")),
            &[],
        );
        archive.extend_from_slice(&[0_u8; TAR_BLOCK_BYTES * 2]);

        let root_mode = extract_seed_archive(Cursor::new(archive), &root).unwrap();
        finalize_seed_root(&root, uid, gid, root_mode).unwrap();

        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o7777, 0o755);
        assert_eq!(
            fs::metadata(root.join("data")).unwrap().mode() & 0o7777,
            0o750
        );
        assert_eq!(
            fs::metadata(root.join("data/file")).unwrap().mode() & 0o7777,
            0o640
        );
        assert_eq!(fs::read(root.join("data/file")).unwrap(), b"hello");
        assert_eq!(
            fs::read_link(root.join("data/link")).unwrap(),
            Path::new("file")
        );
        assert_eq!(
            fs::metadata(root.join("data/file")).unwrap().ino(),
            fs::metadata(root.join("data/hard")).unwrap().ino()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn streaming_seed_rejects_oversized_entry_before_creating_it() {
        let root = temporary_root();
        fs::create_dir(&root).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let header = tar_header("oversized", b'0', MAX_SEED_BYTES + 1, 0o600, uid, gid, None);

        assert!(extract_seed_archive(Cursor::new(header), &root).is_err());
        assert!(!path_exists_nofollow(&root.join("oversized")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn streaming_seed_rejects_extended_metadata_before_creating_an_entry() {
        let root = temporary_root();
        fs::create_dir(&root).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let header = tar_header("PaxHeaders/file", b'x', 0, 0o600, uid, gid, None);

        assert!(extract_seed_archive(Cursor::new(header), &root).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn streaming_seed_never_traverses_a_symlink_parent() {
        let root = temporary_root();
        let outside = temporary_root();
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let mut archive = Vec::new();
        append_tar_entry(
            &mut archive,
            &tar_header(
                "escape",
                b'2',
                0,
                0o777,
                uid,
                gid,
                Some(outside.to_str().unwrap()),
            ),
            &[],
        );
        append_tar_entry(
            &mut archive,
            &tar_header("escape/file", b'0', 4, 0o600, uid, gid, None),
            b"nope",
        );

        assert!(extract_seed_archive(Cursor::new(archive), &root).is_err());
        assert!(!path_exists_nofollow(&outside.join("file")));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn streaming_seed_never_resolves_a_hardlink_through_a_symlink_parent() {
        let root = temporary_root();
        let outside = temporary_root();
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("file"), b"outside").unwrap();
        let outside_links = fs::metadata(outside.join("file")).unwrap().nlink();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let mut archive = Vec::new();
        append_tar_entry(
            &mut archive,
            &tar_header(
                "escape",
                b'2',
                0,
                0o777,
                uid,
                gid,
                Some(outside.to_str().unwrap()),
            ),
            &[],
        );
        append_tar_entry(
            &mut archive,
            &tar_header("hard", b'1', 0, 0o600, uid, gid, Some("escape/file")),
            &[],
        );

        assert!(extract_seed_archive(Cursor::new(archive), &root).is_err());
        assert!(!path_exists_nofollow(&root.join("hard")));
        assert_eq!(
            fs::metadata(outside.join("file")).unwrap().nlink(),
            outside_links
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn metadata_round_trip_preserves_only_host_identity_facts() {
        let metadata = StorageMetadata {
            storage_ref: "storage-one".into(),
            scope_digest: digest('c'),
            layout_digest: digest('d'),
            uid: 1000,
            gid: 1000,
            family: Some("openkit-worker".into()),
            version: Some("1".into()),
            os: "linux".into(),
            architecture: "arm64".into(),
            attachment_generation: 2,
            state: "attached".into(),
            attachment: Some(StoredAttachment {
                generation: 2,
                sandbox_id: "sandbox-one".into(),
            }),
            targets: vec![StoredTarget {
                target: "/workspace".into(),
                volume_ref: "volume-one".into(),
                initialized: true,
            }],
        };
        assert_eq!(
            decode_metadata(&encode_metadata(&metadata).unwrap()).unwrap(),
            metadata
        );
    }

    #[test]
    fn unknown_ref_inspection_never_creates_an_association() {
        let root = temporary_root();
        let store = test_store(&root);
        assert_eq!(
            store.inspect("absent-ref", 1)["state"],
            Value::String("missing".into())
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn epoch_fence_releases_attachment_without_removing_retained_bytes() {
        let root = temporary_root();
        let mut store = test_store(&root);
        let (_, volume) = stored_association(&store, "storage-one", "sandbox-one", 3);
        fs::create_dir(store.association_path("unrelated-corrupt")).unwrap();
        fs::write(volume.join("retained.txt"), b"retained work").unwrap();

        store.release_fenced_attachments().unwrap();

        assert_eq!(store.inspect("storage-one", 3)["state"], "available");
        assert_eq!(
            fs::read(volume.join("retained.txt")).unwrap(),
            b"retained work"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exact_detach_skips_unrelated_unreadable_associations() {
        let root = temporary_root();
        let mut store = test_store(&root);
        stored_association(&store, "storage-one", "sandbox-one", 3);
        fs::create_dir(store.association_path("unrelated-corrupt")).unwrap();

        store.detach("sandbox-one").unwrap();

        assert_eq!(store.inspect("storage-one", 3)["state"], "available");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_new_association_creation_removes_only_its_partial_directory() {
        let root = temporary_root();
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::geteuid() };
        let foreign_uid = if uid == u32::MAX { uid - 1 } else { uid + 1 };
        let store = PersistentVolumeStore {
            root: root.clone(),
            docker_socket: PathBuf::from("/missing"),
            owner_uid: foreign_uid,
        };
        let layout = ImageStorageLayout {
            digest: digest('a'),
            family: Some("openkit-worker".into()),
            version: Some("1".into()),
            uid,
            gid: unsafe { libc::getegid() },
            working_directory: "/tmp/openkit-bootstrap".into(),
            os: "linux".into(),
            architecture: "arm64".into(),
            targets: vec!["/workspace".into()],
        };
        let request = StorageAttachmentRequest {
            storage_ref: "storage-one".into(),
            scope_digest: digest('b'),
            attachment_generation: 1,
            layout_digest: layout.layout_digest(),
            targets: Vec::new(),
        };
        let association = store.association_path(&request.storage_ref);

        assert!(
            store
                .create_association(&association, &request, &layout)
                .is_err()
        );
        assert!(!path_exists_nofollow(&association));
        assert!(path_exists_nofollow(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn purge_requires_exact_generation_and_writer_fence_and_removes_only_one_subject() {
        let root = temporary_root();
        let mut store = test_store(&root);
        let (subject, subject_volume) =
            stored_association(&store, "storage-subject", "sandbox-subject", 4);
        let (other, other_volume) = stored_association(&store, "storage-other", "sandbox-other", 9);
        fs::write(subject_volume.join("subject.txt"), b"subject").unwrap();
        fs::write(other_volume.join("other.txt"), b"other").unwrap();

        assert_eq!(store.purge("storage-subject", 4)["state"], "retained");
        store.detach("sandbox-subject").unwrap();
        assert_eq!(store.purge("storage-subject", 3)["state"], "retained");
        assert_eq!(store.purge("storage-subject", 4)["state"], "purged");

        assert!(!path_exists_nofollow(&subject));
        assert_eq!(fs::read(other_volume.join("other.txt")).unwrap(), b"other");
        assert!(path_exists_nofollow(&other));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn purge_resumes_only_an_intact_exact_detached_tomb() {
        let root = temporary_root();
        let mut store = test_store(&root);
        let (association, _) = stored_association(&store, "storage-subject", "sandbox-subject", 4);
        store.detach("sandbox-subject").unwrap();
        let tomb = store.purging_path("storage-subject");
        fs::rename(&association, &tomb).unwrap();

        assert_eq!(store.purge("storage-subject", 3)["state"], "unknown");
        assert!(path_exists_nofollow(&tomb));
        assert_eq!(store.purge("storage-subject", 4)["state"], "purged");
        assert!(!path_exists_nofollow(&tomb));

        let (association, _) = stored_association(&store, "storage-partial", "sandbox-partial", 5);
        store.detach("sandbox-partial").unwrap();
        let partial_tomb = store.purging_path("storage-partial");
        fs::rename(&association, &partial_tomb).unwrap();
        fs::remove_file(partial_tomb.join(METADATA_NAME)).unwrap();
        assert_eq!(store.purge("storage-partial", 5)["state"], "unknown");
        assert!(path_exists_nofollow(&partial_tomb));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_identity_read_is_unknown_and_does_not_rewrite_metadata() {
        let root = temporary_root();
        let store = test_store(&root);
        let (association, _) = stored_association(&store, "storage-one", "sandbox-one", 2);
        let identity = association.join(METADATA_NAME);
        fs::write(&identity, b"not-json").unwrap();
        let before = fs::read(&identity).unwrap();

        assert_eq!(store.inspect("storage-one", 2)["state"], "unknown");
        assert_eq!(fs::read(&identity).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn purge_rejects_symlinked_association_without_following_target() {
        let root = temporary_root();
        let mut store = test_store(&root);
        let outside = temporary_root();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        symlink(&outside, store.association_path("storage-one")).unwrap();

        assert_eq!(store.purge("storage-one", 1)["state"], "retained");
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        fs::remove_file(store.association_path("storage-one")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
