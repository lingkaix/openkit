//! Epoch-external verified image-content store.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder, File, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

/// Default content ceiling for one NanoHost Image Store.
pub const IMAGE_STORE_DEFAULT_CAPACITY_BYTES: u64 = 200 * 1024 * 1024 * 1024;

/// Hard bound for one OCI archive, independent of total store capacity.
pub const IMAGE_ARCHIVE_MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Fixed service and local-maintenance Image Store root.
pub const IMAGE_STORE_ROOT: &str = "/var/lib/openkit/nanohost-images";

const EPOCH_ROOT: &str = "/var/lib/openkit/nanohost";
const CREDENTIAL_ROOT: &str = "/var/lib/openkit/nanohost-credentials";
const COPY_CHUNK_BYTES: usize = 64 * 1024;
const INDEX_MAX_BYTES: u64 = 512 * 1024;

/// Local, non-authoritative acquisition lineage retained with one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreLineage {
    /// Exact public-registry reference used to acquire the content.
    Registry(String),
    /// Digest of the accepted build definition that produced the content.
    Build(String),
    /// Explicit local archive admission, identified only by verified image identity.
    LocalArchive(String),
}

impl StoreLineage {
    /// Encodes lineage without admitting line-oriented metadata injection.
    fn encode(&self) -> Result<String, StoreError> {
        let (kind, value) = match self {
            Self::Registry(value) => ("registry", value),
            Self::Build(value) => ("build", value),
            Self::LocalArchive(value) => ("local-archive", value),
        };
        if value.is_empty() || value.contains(['\r', '\n']) {
            return Err(StoreError::InvalidMetadata);
        }
        Ok(format!("{kind}:{value}"))
    }

    /// Decodes one persisted lineage field.
    fn decode(value: &str) -> Result<Self, StoreError> {
        let (kind, value) = value.split_once(':').ok_or(StoreError::InvalidMetadata)?;
        if value.is_empty() || value.contains(['\r', '\n']) {
            return Err(StoreError::InvalidMetadata);
        }
        match kind {
            "registry" => Ok(Self::Registry(value.to_string())),
            "build" => Ok(Self::Build(value.to_string())),
            "local-archive" => Ok(Self::LocalArchive(value.to_string())),
            _ => Err(StoreError::InvalidMetadata),
        }
    }
}

/// Availability of one digest-attributed store inventory row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreEntryStatus {
    /// Content and index form one verified usable entry.
    Usable,
    /// One or more attributed projections are missing, staged, or malformed.
    Incomplete,
}

/// Bounded local inventory row returned to host administration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreListEntry {
    /// Exact digest selected by administrator operations.
    pub digest: String,
    /// Physical bytes attributed under the content root.
    pub size: u64,
    /// Source lineage when valid index metadata remains available.
    pub lineage: Option<StoreLineage>,
    /// Current usability of this digest.
    pub status: StoreEntryStatus,
}

/// Current capacity and observed physical content usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreCapacity {
    /// Current admission limit in bytes.
    pub limit: u64,
    /// Checked physical content usage in bytes.
    pub used: u64,
}

/// Bounded local index entry for verified inert image content.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StoreEntry {
    digest: String,
    size: u64,
    acquired_at: u64,
    lineage: StoreLineage,
}

enum StoreEntryReadError {
    Malformed,
    Unavailable(StoreError),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RetainedContentState {
    Absent,
    Valid(u64),
    Invalid,
}

impl StoreEntry {
    /// Serializes one entry into the private line-oriented index format.
    fn encode(&self) -> Result<String, StoreError> {
        Ok(format!(
            "digest={}\nsize={}\nacquired_at={}\nlineage={}\nverification=oci-manifest\n",
            self.digest,
            self.size,
            self.acquired_at,
            self.lineage.encode()?,
        ))
    }

    /// Parses and strictly validates one private index entry.
    fn decode(contents: &str) -> Result<Self, StoreError> {
        let mut digest = None;
        let mut size = None;
        let mut acquired_at = None;
        let mut lineage = None;
        let mut verification = None;
        for line in contents.lines() {
            let (key, value) = line.split_once('=').ok_or(StoreError::InvalidMetadata)?;
            match key {
                "digest" if digest.is_none() => digest = Some(value.to_string()),
                "size" if size.is_none() => {
                    size = Some(value.parse().map_err(|_| StoreError::InvalidMetadata)?);
                }
                "acquired_at" if acquired_at.is_none() => {
                    acquired_at = Some(value.parse().map_err(|_| StoreError::InvalidMetadata)?);
                }
                "lineage" if lineage.is_none() => lineage = Some(StoreLineage::decode(value)?),
                "verification" if verification.is_none() => {
                    if value != "oci-manifest" {
                        return Err(StoreError::InvalidMetadata);
                    }
                    verification = Some(());
                }
                _ => return Err(StoreError::InvalidMetadata),
            }
        }
        let entry = Self {
            digest: digest.ok_or(StoreError::InvalidMetadata)?,
            size: size.ok_or(StoreError::InvalidMetadata)?,
            acquired_at: acquired_at.ok_or(StoreError::InvalidMetadata)?,
            lineage: lineage.ok_or(StoreError::InvalidMetadata)?,
        };
        verification.ok_or(StoreError::InvalidMetadata)?;
        validate_digest(&entry.digest)?;
        Ok(entry)
    }
}

/// Fail-closed Image Store error classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// Store placement overlaps an epoch, credential path, or unsafe path shape.
    UnsafePlacement,
    /// Another store transaction currently holds the root lock.
    Busy,
    /// A content address is not canonical SHA-256.
    InvalidDigest,
    /// The selected digest has no attributed content, staging, or index state.
    Missing,
    /// Content does not match its claimed digest.
    DigestMismatch,
    /// Persisted content no longer matches its address and was discarded.
    Corrupt,
    /// Admission would exceed configured physical-content capacity.
    Capacity,
    /// The bounded local metadata is malformed.
    InvalidMetadata,
    /// A local filesystem operation failed.
    Io,
}

impl From<io::Error> for StoreError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

/// Durable, listener-free retained supply of verified inert image content.
pub struct ImageStore {
    root: PathBuf,
    content_root: PathBuf,
    index_root: PathBuf,
}

impl ImageStore {
    /// Opens the fixed store shared by service and local administration.
    ///
    /// # Errors
    ///
    /// Returns an error for unsafe placement, symlinks, or filesystem failure.
    pub fn open_fixed() -> Result<Self, StoreError> {
        Self::open(
            PathBuf::from(IMAGE_STORE_ROOT),
            Path::new(EPOCH_ROOT),
            &[PathBuf::from(CREDENTIAL_ROOT)],
        )
    }

    /// Opens or creates an epoch-external private store.
    ///
    /// # Errors
    ///
    /// Returns an error for unsafe placement, symlinks, or filesystem failure.
    pub fn open<P: AsRef<Path>>(
        root: PathBuf,
        epoch_root: P,
        credential_paths: &[PathBuf],
    ) -> Result<Self, StoreError> {
        validate_placement(&root, epoch_root.as_ref(), credential_paths)?;
        create_private_dir(&root)?;
        reject_symlink(&root)?;
        let content_root = root.join("content");
        let index_root = root.join("index");
        create_private_dir(&content_root)?;
        create_private_dir(&index_root)?;
        Ok(Self {
            root,
            content_root,
            index_root,
        })
    }

    /// Admits one captured regular OCI archive under its exact manifest digest.
    ///
    /// The source is copied, verified, synchronized, capacity-checked, and
    /// published while one store transaction owns the root lock.
    ///
    /// # Errors
    ///
    /// Returns an error for busy state, invalid content, capacity, or I/O failure.
    pub fn admit_oci_file(
        &self,
        digest: &str,
        mut source: File,
        lineage: StoreLineage,
        acquired_at: u64,
    ) -> Result<(), StoreError> {
        validate_digest(digest)?;
        let source_metadata = source.metadata()?;
        if !source_metadata.is_file()
            || source_metadata.len() == 0
            || source_metadata.len() > IMAGE_ARCHIVE_MAX_BYTES
        {
            return Err(StoreError::DigestMismatch);
        }
        let _lock = self.try_lock()?;
        source.seek(SeekFrom::Start(0))?;
        match crate::image_acquisition::verify_oci_archive(&mut source, Some(digest)) {
            Ok(_) => {}
            Err(crate::image_acquisition::AcquisitionError::Io) => return Err(StoreError::Io),
            Err(_) => return Err(StoreError::DigestMismatch),
        }
        source.seek(SeekFrom::Start(0))?;
        match self.open_verified_locked(digest) {
            Ok(_) => return Ok(()),
            Err(StoreError::Missing | StoreError::Corrupt) => {}
            Err(StoreError::InvalidMetadata) => {}
            Err(error) => return Err(error),
        }
        if self.recover_retained_locked(digest, lineage.clone(), acquired_at)? {
            return Ok(());
        }
        let capacity = self.capacity_locked()?;
        let used = self.physical_usage_locked()?;
        let projected = used
            .checked_add(source_metadata.len())
            .ok_or(StoreError::Capacity)?;
        if projected > capacity {
            return Err(StoreError::Capacity);
        }
        let stem = digest_stem(digest)?;
        let staged_path = self.content_root.join(format!("{stem}.content.tmp"));
        let mut staged = open_new_private(&staged_path)?;
        source.seek(SeekFrom::Start(0))?;
        let copied = match copy_bounded(&mut source, &mut staged, source_metadata.len()) {
            Ok(copied) => copied,
            Err(error) => {
                let _ = fs::remove_file(&staged_path);
                let _ = sync_dir(&self.content_root);
                return Err(error);
            }
        };
        if copied != source_metadata.len() {
            let _ = fs::remove_file(&staged_path);
            let _ = sync_dir(&self.content_root);
            return Err(StoreError::DigestMismatch);
        }
        staged.sync_all()?;
        staged.seek(SeekFrom::Start(0))?;
        if let Err(error) = crate::image_acquisition::verify_oci_archive(&mut staged, Some(digest))
        {
            return self.handle_staged_archive_failure(&staged_path, error);
        }
        if self.physical_usage_locked()? > self.capacity_locked()? {
            let _ = fs::remove_file(&staged_path);
            let _ = sync_dir(&self.content_root);
            return Err(StoreError::Capacity);
        }
        let entry = StoreEntry {
            digest: digest.to_string(),
            size: copied,
            acquired_at,
            lineage,
        };
        atomic_write(
            &self.index_path(digest)?,
            entry.encode()?.as_bytes(),
            0o600,
            &self.index_root,
        )?;
        fs::rename(&staged_path, self.content_path_checked(digest)?)?;
        sync_dir(&self.content_root)?;
        Ok(())
    }

    /// Opens and re-verifies one retained archive for point-of-use import.
    ///
    /// The returned descriptor is rewound and the store lock is released.
    ///
    /// # Errors
    ///
    /// Distinguishes busy, missing, and corrupt retained state.
    pub fn read_verified(&self, digest: &str) -> Result<File, StoreError> {
        validate_digest(digest)?;
        let lock = self.try_lock()?;
        let result = self.open_verified_locked(digest);
        drop(lock);
        result
    }

    /// Lists every digest attributed by content, staging, or index state.
    ///
    /// # Errors
    ///
    /// Fails on busy, unsafe, unreadable, unbounded, or unattributed inventory.
    pub fn list(&self) -> Result<Vec<StoreListEntry>, StoreError> {
        let _lock = self.try_lock()?;
        self.list_locked()
    }

    /// Returns configured capacity and physical content usage.
    pub fn capacity(&self) -> Result<StoreCapacity, StoreError> {
        let _lock = self.try_lock()?;
        Ok(StoreCapacity {
            limit: self.capacity_locked()?,
            used: self.physical_usage_locked()?,
        })
    }

    /// Atomically updates positive capacity and reports current usage.
    pub fn set_capacity(&self, limit: u64) -> Result<StoreCapacity, StoreError> {
        if limit == 0 {
            return Err(StoreError::InvalidMetadata);
        }
        let _lock = self.try_lock()?;
        let used = self.physical_usage_locked()?;
        atomic_write(
            &self.root.join("capacity"),
            format!("{limit}\n").as_bytes(),
            0o600,
            &self.root,
        )?;
        Ok(StoreCapacity { limit, used })
    }

    /// Removes only one exact digest's content, staging, and index projections.
    pub fn remove(&self, digest: &str) -> Result<(), StoreError> {
        validate_digest(digest)?;
        let _lock = self.try_lock()?;
        self.remove_locked(digest)
    }

    #[cfg(test)]
    fn content_path(&self, digest: &str) -> PathBuf {
        self.content_path_checked(digest).expect("test digest")
    }

    fn try_lock(&self) -> Result<File, StoreError> {
        reject_symlink(&self.root)?;
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.root)?;
        if !root.metadata()?.is_dir() {
            return Err(StoreError::UnsafePlacement);
        }
        match root.try_lock() {
            Ok(()) => Ok(root),
            Err(TryLockError::WouldBlock) => Err(StoreError::Busy),
            Err(TryLockError::Error(_)) => Err(StoreError::Io),
        }
    }

    fn open_verified_locked(&self, digest: &str) -> Result<File, StoreError> {
        let content_path = self.content_path_checked(digest)?;
        let index_path = self.index_path(digest)?;
        let staged_path = self
            .content_root
            .join(format!("{}.content.tmp", digest_stem(digest)?));
        let staged_index_path = self
            .index_root
            .join(format!("{}.meta.tmp", digest_stem(digest)?));
        let content_exists = path_exists_nofollow(&content_path)?;
        let index_exists = path_exists_nofollow(&index_path)?;
        let staged_exists = path_exists_nofollow(&staged_path)?;
        match (content_exists, staged_exists, index_exists) {
            (false, false, false) => {
                return if path_exists_nofollow(&staged_index_path)? {
                    Err(StoreError::InvalidMetadata)
                } else {
                    Err(StoreError::Missing)
                };
            }
            (true, false, true) => {}
            _ => return Err(StoreError::InvalidMetadata),
        }
        let entry = match read_entry_file(&index_path) {
            Ok(entry) => entry,
            Err(StoreEntryReadError::Malformed) => return Err(StoreError::InvalidMetadata),
            Err(StoreEntryReadError::Unavailable(error)) => return Err(error),
        };
        let mut content = open_regular_nofollow(&content_path)?;
        let size = content.metadata()?.len();
        if entry.digest != digest {
            return Err(StoreError::InvalidMetadata);
        }
        if let Err(error) = crate::image_acquisition::verify_oci_archive(&mut content, Some(digest))
        {
            drop(content);
            return self.handle_archive_failure(digest, error);
        }
        if entry.size != size {
            return Err(StoreError::InvalidMetadata);
        }
        if path_exists_nofollow(&staged_index_path)? {
            return Err(StoreError::InvalidMetadata);
        }
        content.seek(SeekFrom::Start(0))?;
        Ok(content)
    }

    fn recover_retained_locked(
        &self,
        digest: &str,
        lineage: StoreLineage,
        acquired_at: u64,
    ) -> Result<bool, StoreError> {
        let stem = digest_stem(digest)?;
        let final_path = self.content_root.join(stem);
        let staged_path = self.content_root.join(format!("{stem}.content.tmp"));
        let final_state = inspect_retained_content(&final_path, digest)?;
        let staged_state = inspect_retained_content(&staged_path, digest)?;
        let (selected_size, selected_is_staged) = match (final_state, staged_state) {
            (RetainedContentState::Valid(size), _) => (size, false),
            (_, RetainedContentState::Valid(size)) => (size, true),
            _ => {
                if final_state == RetainedContentState::Invalid {
                    remove_regular_if_present(&final_path)?;
                }
                if staged_state == RetainedContentState::Invalid {
                    remove_regular_if_present(&staged_path)?;
                }
                sync_dir(&self.content_root)?;
                return Ok(false);
            }
        };
        let entry = StoreEntry {
            digest: digest.to_string(),
            size: selected_size,
            acquired_at,
            lineage,
        };
        if selected_is_staged && final_state == RetainedContentState::Invalid {
            remove_regular_if_present(&final_path)?;
            sync_dir(&self.content_root)?;
        }
        atomic_write(
            &self.index_path(digest)?,
            entry.encode()?.as_bytes(),
            0o600,
            &self.index_root,
        )?;
        if selected_is_staged {
            fs::rename(&staged_path, &final_path)?;
            sync_dir(&self.content_root)?;
        } else if staged_state != RetainedContentState::Absent {
            remove_regular_if_present(&staged_path)?;
            sync_dir(&self.content_root)?;
        }
        Ok(true)
    }

    fn list_locked(&self) -> Result<Vec<StoreListEntry>, StoreError> {
        let mut rows: BTreeMap<String, StoreListEntry> = BTreeMap::new();
        let mut final_content = BTreeSet::new();
        let mut final_index = BTreeSet::new();
        let mut staged = BTreeSet::new();
        for item in fs::read_dir(&self.content_root)? {
            let item = item?;
            if item.file_type()?.is_symlink() || !item.file_type()?.is_file() {
                return Err(StoreError::InvalidMetadata);
            }
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| StoreError::InvalidMetadata)?;
            let (stem, is_staged) = content_name(&name).ok_or(StoreError::InvalidMetadata)?;
            let digest = format!("sha256:{stem}");
            validate_digest(&digest)?;
            if is_staged {
                staged.insert(digest.clone());
            } else {
                final_content.insert(digest.clone());
            }
            let row = rows.entry(digest.clone()).or_insert(StoreListEntry {
                digest,
                size: 0,
                lineage: None,
                status: StoreEntryStatus::Incomplete,
            });
            row.size = row
                .size
                .checked_add(item.metadata()?.len())
                .ok_or(StoreError::InvalidMetadata)?;
        }
        for item in fs::read_dir(&self.index_root)? {
            let item = item?;
            if item.file_type()?.is_symlink() || !item.file_type()?.is_file() {
                return Err(StoreError::InvalidMetadata);
            }
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| StoreError::InvalidMetadata)?;
            let (stem, is_staged) = index_name(&name).ok_or(StoreError::InvalidMetadata)?;
            let digest = format!("sha256:{stem}");
            validate_digest(&digest)?;
            if is_staged {
                staged.insert(digest.clone());
            } else {
                final_index.insert(digest.clone());
            }
            let entry = match read_entry_file(&item.path()) {
                Ok(entry) => Some(entry),
                Err(StoreEntryReadError::Malformed) => None,
                Err(StoreEntryReadError::Unavailable(error)) => return Err(error),
            };
            let row = rows.entry(digest.clone()).or_insert(StoreListEntry {
                digest: digest.clone(),
                size: 0,
                lineage: None,
                status: StoreEntryStatus::Incomplete,
            });
            if let Some(entry) = entry
                && entry.digest == digest
            {
                row.lineage = Some(entry.lineage);
            }
        }
        let verify = final_content
            .intersection(&final_index)
            .filter(|digest| !staged.contains(*digest))
            .cloned()
            .collect::<Vec<_>>();
        for digest in verify {
            match self.open_verified_locked(&digest) {
                Ok(_) => {
                    if let Some(row) = rows.get_mut(&digest) {
                        row.status = StoreEntryStatus::Usable;
                    }
                }
                Err(StoreError::Missing) => {}
                Err(StoreError::Corrupt) => {
                    rows.remove(&digest);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(rows.into_values().collect())
    }

    fn capacity_locked(&self) -> Result<u64, StoreError> {
        let path = self.root.join("capacity");
        if !path_exists_nofollow(&path)? {
            return Ok(IMAGE_STORE_DEFAULT_CAPACITY_BYTES);
        }
        let mut file = open_regular_nofollow(&path)?;
        if file.metadata()?.len() > 32 {
            return Err(StoreError::InvalidMetadata);
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        let Some(decimal) = contents.strip_suffix('\n') else {
            return Err(StoreError::InvalidMetadata);
        };
        if decimal.is_empty()
            || (decimal.len() > 1 && decimal.starts_with('0'))
            || !decimal.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(StoreError::InvalidMetadata);
        }
        let limit = decimal
            .parse::<u64>()
            .map_err(|_| StoreError::InvalidMetadata)?;
        if limit == 0 {
            return Err(StoreError::InvalidMetadata);
        }
        Ok(limit)
    }

    fn physical_usage_locked(&self) -> Result<u64, StoreError> {
        let mut total = 0_u64;
        for item in fs::read_dir(&self.content_root)? {
            let item = item?;
            if item.file_type()?.is_symlink() || !item.file_type()?.is_file() {
                return Err(StoreError::InvalidMetadata);
            }
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| StoreError::InvalidMetadata)?;
            let (stem, _) = content_name(&name).ok_or(StoreError::InvalidMetadata)?;
            validate_digest(&format!("sha256:{stem}"))?;
            total = total
                .checked_add(item.metadata()?.len())
                .ok_or(StoreError::InvalidMetadata)?;
        }
        Ok(total)
    }

    fn remove_locked(&self, digest: &str) -> Result<(), StoreError> {
        let stem = digest_stem(digest)?;
        for path in [
            self.content_root.join(stem),
            self.content_root.join(format!("{stem}.content.tmp")),
        ] {
            remove_regular_if_present(&path)?;
        }
        sync_dir(&self.content_root)?;
        for path in [
            self.index_root.join(format!("{stem}.meta")),
            self.index_root.join(format!("{stem}.meta.tmp")),
        ] {
            remove_regular_if_present(&path)?;
        }
        sync_dir(&self.index_root)?;
        Ok(())
    }

    fn discard_corrupt_locked<T>(&self, digest: &str) -> Result<T, StoreError> {
        self.remove_locked(digest)?;
        Err(StoreError::Corrupt)
    }

    fn handle_archive_failure<T>(
        &self,
        digest: &str,
        error: crate::image_acquisition::AcquisitionError,
    ) -> Result<T, StoreError> {
        match error {
            crate::image_acquisition::AcquisitionError::DigestMismatch
            | crate::image_acquisition::AcquisitionError::InvalidOciResult => {
                self.discard_corrupt_locked(digest)
            }
            crate::image_acquisition::AcquisitionError::Io => Err(StoreError::Io),
            _ => Err(StoreError::InvalidMetadata),
        }
    }

    fn handle_staged_archive_failure<T>(
        &self,
        staged_path: &Path,
        error: crate::image_acquisition::AcquisitionError,
    ) -> Result<T, StoreError> {
        match error {
            crate::image_acquisition::AcquisitionError::DigestMismatch
            | crate::image_acquisition::AcquisitionError::InvalidOciResult => {
                remove_regular_if_present(staged_path)?;
                sync_dir(&self.content_root)?;
                Err(StoreError::DigestMismatch)
            }
            crate::image_acquisition::AcquisitionError::Io => Err(StoreError::Io),
            _ => Err(StoreError::InvalidMetadata),
        }
    }

    fn content_path_checked(&self, digest: &str) -> Result<PathBuf, StoreError> {
        Ok(self.content_root.join(digest_stem(digest)?))
    }

    fn index_path(&self, digest: &str) -> Result<PathBuf, StoreError> {
        Ok(self
            .index_root
            .join(format!("{}.meta", digest_stem(digest)?)))
    }
}

/// Validates one canonical SHA-256 content address.
fn validate_digest(digest: &str) -> Result<(), StoreError> {
    let Some(hex) = digest.strip_prefix("sha256:") else {
        return Err(StoreError::InvalidDigest);
    };
    if hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(StoreError::InvalidDigest)
    }
}

/// Returns the filename-safe digest component.
fn digest_stem(digest: &str) -> Result<&str, StoreError> {
    validate_digest(digest)?;
    Ok(digest.strip_prefix("sha256:").expect("validated prefix"))
}

fn content_name(name: &str) -> Option<(&str, bool)> {
    if name.len() == 64 {
        Some((name, false))
    } else {
        name.strip_suffix(".content.tmp").map(|stem| (stem, true))
    }
}

fn index_name(name: &str) -> Option<(&str, bool)> {
    if let Some(stem) = name.strip_suffix(".meta.tmp") {
        Some((stem, true))
    } else {
        name.strip_suffix(".meta").map(|stem| (stem, false))
    }
}

fn read_entry_file(path: &Path) -> Result<StoreEntry, StoreEntryReadError> {
    let mut file = open_regular_nofollow(path).map_err(StoreEntryReadError::Unavailable)?;
    let size = file
        .metadata()
        .map_err(StoreError::from)
        .map_err(StoreEntryReadError::Unavailable)?
        .len();
    if size > INDEX_MAX_BYTES {
        return Err(StoreEntryReadError::Malformed);
    }
    let capacity = usize::try_from(size).map_err(|_| StoreEntryReadError::Malformed)?;
    let mut contents = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(INDEX_MAX_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(StoreError::from)
        .map_err(StoreEntryReadError::Unavailable)?;
    if contents.len() != capacity {
        return Err(StoreEntryReadError::Unavailable(StoreError::Io));
    }
    let contents = String::from_utf8(contents).map_err(|_| StoreEntryReadError::Malformed)?;
    StoreEntry::decode(&contents).map_err(|_| StoreEntryReadError::Malformed)
}

fn inspect_retained_content(path: &Path, digest: &str) -> Result<RetainedContentState, StoreError> {
    if !path_exists_nofollow(path)? {
        return Ok(RetainedContentState::Absent);
    }
    let mut content = open_regular_nofollow(path)?;
    match crate::image_acquisition::verify_oci_archive(&mut content, Some(digest)) {
        Ok(_) => Ok(RetainedContentState::Valid(content.metadata()?.len())),
        Err(crate::image_acquisition::AcquisitionError::DigestMismatch)
        | Err(crate::image_acquisition::AcquisitionError::InvalidOciResult) => {
            Ok(RetainedContentState::Invalid)
        }
        Err(crate::image_acquisition::AcquisitionError::Io) => Err(StoreError::Io),
        Err(_) => Err(StoreError::InvalidMetadata),
    }
}

fn open_regular_nofollow(path: &Path) -> Result<File, StoreError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(StoreError::InvalidMetadata);
    }
    Ok(file)
}

/// Opens one local-maintenance archive without following its final component.
///
/// # Errors
///
/// Rejects a symlink, non-regular file, or filesystem failure.
pub fn open_archive_nofollow(path: &Path) -> Result<File, StoreError> {
    open_regular_nofollow(path)
}

fn open_new_private(path: &Path) -> Result<File, StoreError> {
    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(Into::into)
}

fn path_exists_nofollow(path: &Path) -> Result<bool, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(StoreError::InvalidMetadata),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_regular_if_present(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(StoreError::InvalidMetadata)
        }
        Ok(_) => fs::remove_file(path).map_err(Into::into),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn copy_bounded<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    limit: u64,
) -> Result<u64, StoreError> {
    let mut buffer = [0_u8; COPY_CHUNK_BYTES];
    let mut total = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(total);
        }
        total = total.checked_add(read as u64).ok_or(StoreError::Capacity)?;
        if total > limit {
            return Err(StoreError::Capacity);
        }
        writer.write_all(&buffer[..read])?;
    }
}

/// Rejects lexical overlap with epoch or credential state.
fn validate_placement(
    root: &Path,
    epoch_root: &Path,
    credential_paths: &[PathBuf],
) -> Result<(), StoreError> {
    if !safe_absolute(root) || !safe_absolute(epoch_root) {
        return Err(StoreError::UnsafePlacement);
    }
    for protected in
        std::iter::once(epoch_root).chain(credential_paths.iter().map(PathBuf::as_path))
    {
        if !safe_absolute(protected) || root.starts_with(protected) || protected.starts_with(root) {
            return Err(StoreError::UnsafePlacement);
        }
    }
    Ok(())
}

/// Returns whether a path is absolute and free of traversal components.
fn safe_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                Component::RootDir | Component::Normal(_) | Component::Prefix(_)
            )
        })
}

/// Creates a private directory without following a final symlink.
fn create_private_dir(path: &Path) -> Result<(), StoreError> {
    if path.exists() {
        reject_symlink(path)?;
    }
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Rejects a symlink or non-directory store component.
fn reject_symlink(path: &Path) -> Result<(), StoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        Err(StoreError::UnsafePlacement)
    } else {
        Ok(())
    }
}

/// Writes a private attributed temporary file, syncs, renames, and syncs its parent.
fn atomic_write(path: &Path, contents: &[u8], mode: u32, parent: &Path) -> Result<(), StoreError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(StoreError::InvalidMetadata)?;
    let temp = path.with_file_name(format!("{file_name}.tmp"));
    remove_regular_if_present(&temp)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)?;
    file.write_all(contents)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    sync_dir(parent)
}

fn sync_dir(path: &Path) -> Result<(), StoreError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?
        .sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{
        IMAGE_STORE_DEFAULT_CAPACITY_BYTES, ImageStore, StoreEntry, StoreEntryStatus, StoreError,
        StoreLineage,
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "openkit-image-store-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn open_store(root: &Path) -> ImageStore {
        ImageStore::open(
            root.join("store"),
            root.join("epoch"),
            &[root.join("credentials")],
        )
        .expect("safe image store")
    }

    fn archive(root: &Path, label: &str) -> (File, String, Vec<u8>) {
        let bytes = crate::image_acquisition::test_oci_archive(label.as_bytes());
        let digest = crate::image_acquisition::oci_manifest_digest(&bytes).expect("fixture digest");
        let path = root.join(format!(
            "archive-{}.tar",
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, &bytes).expect("fixture archive");
        (File::open(path).expect("open fixture"), digest, bytes)
    }

    #[test]
    fn verified_fd_survives_exact_removal() {
        let root = fixture_root();
        let store = open_store(&root);
        let (archive, digest, bytes) = archive(&root, "retained-fd");
        store
            .admit_oci_file(
                &digest,
                archive,
                StoreLineage::Registry(format!("ghcr.io/openkit/worker@{digest}")),
                10,
            )
            .expect("admit archive");
        let mut retained = store.read_verified(&digest).expect("verified descriptor");
        store.remove(&digest).expect("exact removal");
        assert_eq!(
            store.read_verified(&digest).unwrap_err(),
            StoreError::Missing
        );
        let mut observed = Vec::new();
        retained
            .read_to_end(&mut observed)
            .expect("read retained inode");
        assert_eq!(observed, bytes);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn transaction_lock_is_nonblocking_across_independent_opens() {
        let root = fixture_root();
        let store = open_store(&root);
        let independently_opened = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&store.root)
            .expect("independent root descriptor");
        independently_opened
            .try_lock()
            .expect("hold transaction lock");
        assert_eq!(store.capacity().unwrap_err(), StoreError::Busy);
        drop(independently_opened);
        assert_eq!(store.capacity().expect("lock released").used, 0);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn capacity_counts_incomplete_content_and_retains_it_when_lowered() {
        assert_eq!(IMAGE_STORE_DEFAULT_CAPACITY_BYTES, 214_748_364_800);
        let root = fixture_root();
        let store = open_store(&root);
        let stem = format!("{:064x}", 7);
        let digest = format!("sha256:{stem}");
        let staged = store.content_root.join(format!("{stem}.content.tmp"));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(staged)
            .unwrap();
        file.write_all(b"orphaned").unwrap();
        file.sync_all().unwrap();
        let capacity = store.set_capacity(4).expect("lower without deletion");
        assert_eq!(capacity.used, 8);
        assert_eq!(store.capacity().unwrap().limit, 4);
        let list = store.list().expect("incomplete inventory");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].digest, digest);
        assert_eq!(list[0].size, 8);
        assert_eq!(list[0].status, StoreEntryStatus::Incomplete);
        let (archive, rejected_digest, _) = archive(&root, "capacity-refusal");
        assert_eq!(
            store.admit_oci_file(
                &rejected_digest,
                archive,
                StoreLineage::LocalArchive(rejected_digest.clone()),
                30,
            ),
            Err(StoreError::Capacity)
        );
        assert_eq!(
            fs::read(store.content_root.join(format!("{stem}.content.tmp"))).unwrap(),
            b"orphaned"
        );
        assert!(
            !store
                .content_root
                .join(format!(
                    "{}.content.tmp",
                    rejected_digest.strip_prefix("sha256:").unwrap()
                ))
                .exists()
        );
        store.remove(&digest).expect("exact incomplete cleanup");
        assert_eq!(store.capacity().unwrap().used, 0);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn invalid_retry_preserves_content_without_index_until_verified_recovery() {
        let root = fixture_root();
        let store = open_store(&root);
        let (initial_archive, digest, bytes) = archive(&root, "content-without-index");
        store
            .admit_oci_file(
                &digest,
                initial_archive,
                StoreLineage::LocalArchive(digest.clone()),
                11,
            )
            .expect("admit archive");
        let content_path = store.content_path(&digest);
        let index_path = store.index_path(&digest).unwrap();
        fs::remove_file(&index_path).expect("simulate interrupted index publication");
        let invalid_path = root.join("invalid-content-retry.tar");
        fs::write(&invalid_path, b"invalid retry").unwrap();
        assert_eq!(
            store.admit_oci_file(
                &digest,
                File::open(&invalid_path).unwrap(),
                StoreLineage::LocalArchive(digest.clone()),
                12,
            ),
            Err(StoreError::DigestMismatch)
        );
        assert_eq!(fs::read(&content_path).unwrap(), bytes);
        assert!(!index_path.exists());

        let (retry, retry_digest, _) = archive(&root, "content-without-index");
        assert_eq!(retry_digest, digest);
        store
            .admit_oci_file(
                &digest,
                retry,
                StoreLineage::LocalArchive(digest.clone()),
                13,
            )
            .expect("recover verified retained content");
        assert!(store.read_verified(&digest).is_ok());
        assert_eq!(fs::read(&content_path).unwrap(), bytes);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn malformed_index_cannot_delete_valid_content_and_verified_retry_recovers() {
        let root = fixture_root();
        let store = open_store(&root);
        let (initial_archive, digest, bytes) = archive(&root, "malformed-index");
        store
            .admit_oci_file(
                &digest,
                initial_archive,
                StoreLineage::LocalArchive(digest.clone()),
                17,
            )
            .expect("admit archive");
        let content_path = store.content_path(&digest);
        let index_path = store.index_path(&digest).unwrap();
        let malformed_index = b"malformed retained index";
        fs::write(&index_path, malformed_index).unwrap();
        assert_eq!(
            store.read_verified(&digest).unwrap_err(),
            StoreError::InvalidMetadata
        );
        let invalid_path = root.join("invalid-malformed-index-retry.tar");
        fs::write(&invalid_path, b"invalid retry").unwrap();
        assert_eq!(
            store.admit_oci_file(
                &digest,
                File::open(&invalid_path).unwrap(),
                StoreLineage::LocalArchive(digest.clone()),
                18,
            ),
            Err(StoreError::DigestMismatch)
        );
        assert_eq!(fs::read(&content_path).unwrap(), bytes);
        assert_eq!(fs::read(&index_path).unwrap(), malformed_index);
        assert_eq!(
            store.set_capacity(bytes.len() as u64).unwrap().used,
            bytes.len() as u64
        );

        let (retry, retry_digest, _) = archive(&root, "malformed-index");
        assert_eq!(retry_digest, digest);
        store
            .admit_oci_file(
                &digest,
                retry,
                StoreLineage::LocalArchive(digest.clone()),
                19,
            )
            .expect("recover valid content from malformed index");
        assert!(store.read_verified(&digest).is_ok());
        assert_eq!(fs::read(&content_path).unwrap(), bytes);
        assert_ne!(fs::read(&index_path).unwrap(), malformed_index);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn invalid_retry_preserves_verified_staging_until_verified_recovery() {
        let root = fixture_root();
        let store = open_store(&root);
        let (initial_archive, digest, bytes) = archive(&root, "verified-staging");
        store
            .admit_oci_file(
                &digest,
                initial_archive,
                StoreLineage::LocalArchive(digest.clone()),
                14,
            )
            .expect("admit archive");
        let final_path = store.content_path(&digest);
        let stem = digest.strip_prefix("sha256:").unwrap();
        let staged_path = store.content_root.join(format!("{stem}.content.tmp"));
        let index_path = store.index_path(&digest).unwrap();
        let index_bytes = fs::read(&index_path).unwrap();
        fs::rename(&final_path, &staged_path).expect("simulate pre-rename interruption");
        let invalid_path = root.join("invalid-staging-retry.tar");
        fs::write(&invalid_path, b"invalid retry").unwrap();
        assert_eq!(
            store.admit_oci_file(
                &digest,
                File::open(&invalid_path).unwrap(),
                StoreLineage::LocalArchive(digest.clone()),
                15,
            ),
            Err(StoreError::DigestMismatch)
        );
        assert!(!final_path.exists());
        assert_eq!(fs::read(&staged_path).unwrap(), bytes);
        assert_eq!(fs::read(&index_path).unwrap(), index_bytes);

        let (retry, retry_digest, _) = archive(&root, "verified-staging");
        assert_eq!(retry_digest, digest);
        store
            .admit_oci_file(
                &digest,
                retry,
                StoreLineage::LocalArchive(digest.clone()),
                16,
            )
            .expect("recover verified staged content");
        assert!(store.read_verified(&digest).is_ok());
        assert_eq!(fs::read(&final_path).unwrap(), bytes);
        assert!(!staged_path.exists());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn corruption_is_discarded_without_repair() {
        let root = fixture_root();
        let store = open_store(&root);
        let (archive, digest, _) = archive(&root, "corrupt");
        store
            .admit_oci_file(
                &digest,
                archive,
                StoreLineage::Build(format!("sha256:{:064x}", 8)),
                20,
            )
            .expect("admit archive");
        fs::write(store.content_path(&digest), b"corrupt").expect("corrupt content");
        assert_eq!(
            store.read_verified(&digest).unwrap_err(),
            StoreError::Corrupt
        );
        assert_eq!(
            store.read_verified(&digest).unwrap_err(),
            StoreError::Missing
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn unavailable_component_is_preserved_and_never_hidden_from_list() {
        let root = fixture_root();
        let store = open_store(&root);
        let (archive, digest, _) = archive(&root, "unavailable-component");
        store
            .admit_oci_file(
                &digest,
                archive,
                StoreLineage::LocalArchive(digest.clone()),
                21,
            )
            .expect("admit archive");
        let content_path = store.content_path(&digest);
        fs::remove_file(&content_path).expect("remove fixture content");
        fs::create_dir(&content_path).expect("install unsafe non-file residue");
        assert_eq!(
            store.read_verified(&digest).unwrap_err(),
            StoreError::InvalidMetadata
        );
        assert_eq!(store.list().unwrap_err(), StoreError::InvalidMetadata);
        assert!(content_path.is_dir());
        assert!(store.index_path(&digest).unwrap().is_file());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn failed_positive_corruption_cleanup_is_reported_and_retained_in_inventory() {
        let root = fixture_root();
        let store = open_store(&root);
        let (archive, digest, _) = archive(&root, "cleanup-failure");
        store
            .admit_oci_file(
                &digest,
                archive,
                StoreLineage::LocalArchive(digest.clone()),
                22,
            )
            .expect("admit archive");
        let content_path = store.content_path(&digest);
        fs::write(&content_path, b"corrupt").expect("establish positive content corruption");
        let stem = digest.strip_prefix("sha256:").unwrap();
        let index_path = store.index_path(&digest).unwrap();
        let staged_index_path = store.index_root.join(format!("{stem}.meta.tmp"));
        fs::create_dir(&staged_index_path).expect("install cleanup failure residue");
        assert_eq!(
            store.read_verified(&digest).unwrap_err(),
            StoreError::InvalidMetadata
        );
        assert_eq!(store.list().unwrap_err(), StoreError::InvalidMetadata);
        assert!(!content_path.exists());
        assert!(!index_path.exists());
        assert!(staged_index_path.is_dir());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn verifier_io_preserves_valid_content_and_index() {
        let root = fixture_root();
        let store = open_store(&root);
        let (archive, digest, _) = archive(&root, "verifier-io");
        store
            .admit_oci_file(
                &digest,
                archive,
                StoreLineage::LocalArchive(digest.clone()),
                23,
            )
            .expect("admit archive");
        assert_eq!(
            store.handle_archive_failure::<()>(
                &digest,
                crate::image_acquisition::AcquisitionError::Io
            ),
            Err(StoreError::Io)
        );
        assert!(store.content_path(&digest).is_file());
        assert!(store.index_path(&digest).unwrap().is_file());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn staged_verifier_io_preserves_synced_attributed_content() {
        let root = fixture_root();
        let store = open_store(&root);
        let digest = format!("sha256:{:064x}", 24);
        let staged_path = store.content_root.join(format!(
            "{}.content.tmp",
            digest.strip_prefix("sha256:").unwrap()
        ));
        let mut staged = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&staged_path)
            .unwrap();
        staged.write_all(b"captured bytes").unwrap();
        staged.sync_all().unwrap();
        assert_eq!(
            store.handle_staged_archive_failure::<()>(
                &staged_path,
                crate::image_acquisition::AcquisitionError::Io
            ),
            Err(StoreError::Io)
        );
        assert_eq!(fs::read(&staged_path).unwrap(), b"captured bytes");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn malformed_first_numeric_metadata_field_cannot_be_replaced_by_a_duplicate() {
        let digest = format!("sha256:{:064x}", 9);
        let metadata = format!(
            "digest={digest}\nsize=bad\nsize=10\nacquired_at=1\nlineage=local-archive:{digest}\nverification=oci-manifest\n"
        );
        assert_eq!(
            StoreEntry::decode(&metadata),
            Err(StoreError::InvalidMetadata)
        );
    }

    #[test]
    fn rejects_unsafe_placement_and_has_no_network_surface() {
        let root = fixture_root();
        let epoch = root.join("epoch");
        let credentials = root.join("credentials");
        for unsafe_root in [
            epoch.join("images"),
            credentials.join("images"),
            root.clone(),
        ] {
            assert!(matches!(
                ImageStore::open(unsafe_root, &epoch, std::slice::from_ref(&credentials)),
                Err(StoreError::UnsafePlacement)
            ));
        }
        let production = include_str!("image_store.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("store production section");
        for forbidden in ["TcpListener", "UdpSocket", "std::net", ".listen("] {
            assert!(
                !production.contains(forbidden),
                "network surface {forbidden}"
            );
        }
    }
}
