//! Epoch-external verified image-content store.

use std::collections::BTreeSet;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Hard content ceiling for one NanoHost Image Store.
pub const IMAGE_STORE_MAX_BYTES: u64 = 200 * 1024 * 1024 * 1024;

/// Local, non-authoritative acquisition lineage retained with one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreLineage {
    /// Exact public-registry reference used to acquire the content.
    Registry(String),
    /// Digest of the accepted build definition that produced the content.
    Build(String),
}

impl StoreLineage {
    /// Encodes lineage without admitting line-oriented metadata injection.
    fn encode(&self) -> Result<String, StoreError> {
        let (kind, value) = match self {
            Self::Registry(value) => ("registry", value),
            Self::Build(value) => ("build", value),
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
            _ => Err(StoreError::InvalidMetadata),
        }
    }
}

/// Bounded local index entry for verified inert image content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreEntry {
    digest: String,
    size: u64,
    acquired_at: u64,
    last_imported_at: u64,
    lineage: StoreLineage,
    verification: ContentVerification,
}

/// Verification rule persisted with inert stored content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentVerification {
    /// The address is the digest of the complete stored byte sequence.
    Bytes,
    /// The address is the verified top-level OCI manifest inside the archive.
    OciManifest,
}

impl StoreEntry {
    /// Creates the minimum entry shape used by eviction selection.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(digest: &str, size: u64, last_imported_at: u64) -> Self {
        Self {
            digest: digest.to_string(),
            size,
            acquired_at: last_imported_at,
            last_imported_at,
            lineage: StoreLineage::Build("unknown".into()),
            verification: ContentVerification::Bytes,
        }
    }

    /// Serializes one entry into the private line-oriented index format.
    fn encode(&self) -> Result<String, StoreError> {
        Ok(format!(
            "digest={}\nsize={}\nacquired_at={}\nlast_imported_at={}\nlineage={}\nverification={}\n",
            self.digest,
            self.size,
            self.acquired_at,
            self.last_imported_at,
            self.lineage.encode()?,
            match self.verification {
                ContentVerification::Bytes => "bytes",
                ContentVerification::OciManifest => "oci-manifest",
            }
        ))
    }

    /// Parses and strictly validates one private index entry.
    fn decode(contents: &str) -> Result<Self, StoreError> {
        let mut digest = None;
        let mut size = None;
        let mut acquired_at = None;
        let mut last_imported_at = None;
        let mut lineage = None;
        let mut verification = None;
        for line in contents.lines() {
            let (key, value) = line.split_once('=').ok_or(StoreError::InvalidMetadata)?;
            match key {
                "digest" if digest.is_none() => digest = Some(value.to_string()),
                "size" if size.is_none() => size = value.parse().ok(),
                "acquired_at" if acquired_at.is_none() => acquired_at = value.parse().ok(),
                "last_imported_at" if last_imported_at.is_none() => {
                    last_imported_at = value.parse().ok();
                }
                "lineage" if lineage.is_none() => lineage = Some(StoreLineage::decode(value)?),
                "verification" if verification.is_none() => {
                    verification = Some(match value {
                        "bytes" => ContentVerification::Bytes,
                        "oci-manifest" => ContentVerification::OciManifest,
                        _ => return Err(StoreError::InvalidMetadata),
                    });
                }
                _ => return Err(StoreError::InvalidMetadata),
            }
        }
        let entry = Self {
            digest: digest.ok_or(StoreError::InvalidMetadata)?,
            size: size.ok_or(StoreError::InvalidMetadata)?,
            acquired_at: acquired_at.ok_or(StoreError::InvalidMetadata)?,
            last_imported_at: last_imported_at.ok_or(StoreError::InvalidMetadata)?,
            lineage: lineage.ok_or(StoreError::InvalidMetadata)?,
            verification: verification.ok_or(StoreError::InvalidMetadata)?,
        };
        validate_digest(&entry.digest)?;
        Ok(entry)
    }
}

/// Fail-closed Image Store error classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// Store placement overlaps an epoch, credential path, or unsafe path shape.
    UnsafePlacement,
    /// A content address is not canonical SHA-256.
    InvalidDigest,
    /// Content does not match its claimed digest.
    DigestMismatch,
    /// Persisted content no longer matches its address and was discarded.
    Corrupt,
    /// The fixed ceiling cannot be met without evicting protected content.
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

/// Durable, listener-free cache of verified inert image content.
pub struct ImageStore {
    content_root: PathBuf,
    index_root: PathBuf,
}

impl ImageStore {
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
            content_root,
            index_root,
        })
    }

    /// Atomically admits verified content using the fixed ceiling.
    ///
    /// # Errors
    ///
    /// Returns an error on digest mismatch, capacity exhaustion, unsafe metadata,
    /// or filesystem failure.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn admit(
        &mut self,
        digest: &str,
        content: &[u8],
        lineage: StoreLineage,
        acquired_at: u64,
    ) -> Result<(), StoreError> {
        self.admit_internal(
            digest,
            content,
            lineage,
            acquired_at,
            &BTreeSet::new(),
            ContentVerification::Bytes,
        )
    }

    /// Admits a verified OCI archive under its exact top-level manifest digest.
    ///
    /// # Errors
    ///
    /// Returns an error when the archive does not contain the claimed manifest.
    #[allow(dead_code)]
    pub fn admit_oci(
        &mut self,
        digest: &str,
        content: &[u8],
        lineage: StoreLineage,
        acquired_at: u64,
        protected: &BTreeSet<String>,
    ) -> Result<(), StoreError> {
        self.admit_internal(
            digest,
            content,
            lineage,
            acquired_at,
            protected,
            ContentVerification::OciManifest,
        )
    }

    /// Applies the shared bounded atomic admission flow.
    fn admit_internal(
        &mut self,
        digest: &str,
        content: &[u8],
        lineage: StoreLineage,
        acquired_at: u64,
        protected: &BTreeSet<String>,
        verification: ContentVerification,
    ) -> Result<(), StoreError> {
        validate_digest(digest)?;
        let verified = match verification {
            ContentVerification::Bytes => content_digest(content) == digest,
            ContentVerification::OciManifest => {
                crate::image_acquisition::oci_manifest_digest(content).as_deref() == Ok(digest)
            }
        };
        if !verified {
            return Err(StoreError::DigestMismatch);
        }
        let mut entries = self.entries()?;
        let existing_size = entries
            .iter()
            .find(|entry| entry.digest == digest)
            .map_or(0, |entry| entry.size);
        let total = entries.iter().map(|entry| entry.size).sum::<u64>();
        let evictions = select_evictions(
            &entries,
            total.saturating_sub(existing_size),
            content.len() as u64,
            IMAGE_STORE_MAX_BYTES,
            protected,
        )?;
        for evicted in evictions {
            self.remove(&evicted)?;
            entries.retain(|entry| entry.digest != evicted);
        }

        let entry = StoreEntry {
            digest: digest.to_string(),
            size: content.len() as u64,
            acquired_at,
            last_imported_at: acquired_at,
            lineage,
            verification,
        };
        let stem = digest_stem(digest)?;
        atomic_write(&self.content_root.join(stem), content, 0o600)?;
        if let Err(error) = atomic_write(
            &self.index_root.join(format!("{stem}.meta")),
            entry.encode()?.as_bytes(),
            0o600,
        ) {
            let _ = fs::remove_file(self.content_root.join(stem));
            return Err(error);
        }
        Ok(())
    }

    /// Reads and re-verifies one entry, discarding corruption rather than repairing it.
    ///
    /// # Errors
    ///
    /// Returns missing/corrupt state as a fail-closed store error.
    pub fn read_verified(&mut self, digest: &str) -> Result<Vec<u8>, StoreError> {
        validate_digest(digest)?;
        let content = fs::read(self.content_path(digest)).map_err(|_| StoreError::Corrupt)?;
        let entry = self.read_entry(digest).map_err(|_| StoreError::Corrupt)?;
        let verified = match entry.verification {
            ContentVerification::Bytes => content_digest(&content) == digest,
            ContentVerification::OciManifest => {
                crate::image_acquisition::oci_manifest_digest(&content).as_deref() == Ok(digest)
            }
        };
        if entry.digest != digest || entry.size != content.len() as u64 || !verified {
            let _ = self.remove(digest);
            return Err(StoreError::Corrupt);
        }
        Ok(content)
    }

    /// Records one successful import for least-recently-imported eviction.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry is missing or its metadata is malformed.
    pub fn mark_imported(&mut self, digest: &str, imported_at: u64) -> Result<(), StoreError> {
        let mut entry = self.read_entry(digest)?;
        entry.last_imported_at = imported_at;
        let stem = digest_stem(digest)?;
        atomic_write(
            &self.index_root.join(format!("{stem}.meta")),
            entry.encode()?.as_bytes(),
            0o600,
        )
    }

    /// Returns whether both content and valid metadata exist for one digest.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn contains(&self, digest: &str) -> bool {
        self.read_entry(digest).is_ok() && self.content_path(digest).is_file()
    }

    /// Returns the private inert-content path for one digest.
    pub fn content_path(&self, digest: &str) -> PathBuf {
        let stem = digest.strip_prefix("sha256:").unwrap_or("invalid");
        self.content_root.join(stem)
    }

    /// Loads all valid bounded index entries.
    fn entries(&self) -> Result<Vec<StoreEntry>, StoreError> {
        let mut entries = Vec::new();
        for item in fs::read_dir(&self.index_root)? {
            let item = item?;
            if item.file_type()?.is_symlink() || !item.file_type()?.is_file() {
                return Err(StoreError::InvalidMetadata);
            }
            let contents = fs::read_to_string(item.path())?;
            entries.push(StoreEntry::decode(&contents)?);
        }
        Ok(entries)
    }

    /// Reads one exact metadata entry.
    fn read_entry(&self, digest: &str) -> Result<StoreEntry, StoreError> {
        let stem = digest_stem(digest)?;
        let contents = fs::read_to_string(self.index_root.join(format!("{stem}.meta")))?;
        StoreEntry::decode(&contents)
    }

    /// Removes both projections of one disposable cache entry.
    fn remove(&self, digest: &str) -> Result<(), StoreError> {
        let stem = digest_stem(digest)?;
        for path in [
            self.content_root.join(stem),
            self.index_root.join(format!("{stem}.meta")),
        ] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

/// Selects the least-recently-imported unprotected entries needed for admission.
///
/// # Errors
///
/// Returns [`StoreError::Capacity`] when protected content prevents admission.
pub fn select_evictions(
    entries: &[StoreEntry],
    current_bytes: u64,
    incoming_bytes: u64,
    limit_bytes: u64,
    protected: &BTreeSet<String>,
) -> Result<Vec<String>, StoreError> {
    if incoming_bytes > limit_bytes {
        return Err(StoreError::Capacity);
    }
    let required = current_bytes
        .saturating_add(incoming_bytes)
        .saturating_sub(limit_bytes);
    if required == 0 {
        return Ok(Vec::new());
    }
    let mut candidates = entries
        .iter()
        .filter(|entry| !protected.contains(&entry.digest))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| (entry.last_imported_at, entry.acquired_at, &entry.digest));
    let mut freed = 0_u64;
    let mut selected = Vec::new();
    for entry in candidates {
        freed = freed.saturating_add(entry.size);
        selected.push(entry.digest.clone());
        if freed >= required {
            return Ok(selected);
        }
    }
    Err(StoreError::Capacity)
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

/// Returns the canonical digest for inert stored bytes.
fn content_digest(content: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(content))
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

/// Writes a private temporary file, syncs it, and atomically renames it.
fn atomic_write(path: &Path, contents: &[u8], mode: u32) -> Result<(), StoreError> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .open(&temp)?;
    let result = (|| -> io::Result<()> {
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(StoreError::from)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use sha2::{Digest, Sha256};

    use super::{
        IMAGE_STORE_MAX_BYTES, ImageStore, StoreEntry, StoreError, StoreLineage, select_evictions,
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    /// Returns a unique disposable test root without adding a fixture dependency.
    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "openkit-wp3b-store-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Returns the canonical SHA-256 image address for fixture bytes.
    fn digest(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    /// Opens one store whose root is disjoint from epoch and credential state.
    fn open_store(root: &Path) -> ImageStore {
        ImageStore::open(
            root.join("store"),
            root.join("epoch"),
            &[root.join("credentials")],
        )
        .expect("safe image store")
    }

    #[test]
    fn wp3b_store_admits_atomically_reopens_and_discards_corruption() {
        let root = fixture_root();
        let content = b"verified inert image archive";
        let exact_digest = digest(content);
        let mut store = open_store(&root);

        store
            .admit(
                &exact_digest,
                content,
                StoreLineage::Registry("ghcr.io/openkit/worker@sha256:exact".into()),
                10,
            )
            .expect("atomic verified admission");
        assert_eq!(store.read_verified(&exact_digest), Ok(content.to_vec()));
        drop(store);

        let mut reopened = open_store(&root);
        assert_eq!(reopened.read_verified(&exact_digest), Ok(content.to_vec()));
        fs::write(reopened.content_path(&exact_digest), b"corrupt").expect("corrupt fixture");
        assert_eq!(
            reopened.read_verified(&exact_digest),
            Err(StoreError::Corrupt)
        );
        assert!(!reopened.contains(&exact_digest));

        let rejected_digest = digest(b"different bytes");
        assert!(matches!(
            reopened.admit(
                &rejected_digest,
                b"mismatch",
                StoreLineage::Registry("docker.io/library/alpine@sha256:exact".into()),
                11,
            ),
            Err(StoreError::DigestMismatch)
        ));
        drop(reopened);
        assert!(!open_store(&root).contains(&rejected_digest));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wp3b_store_enforces_fixed_capacity_and_protected_lri_eviction() {
        assert_eq!(IMAGE_STORE_MAX_BYTES, 200 * 1024 * 1024 * 1024);
        let old = format!("sha256:{:064x}", 1);
        let deployment = format!("sha256:{:064x}", 2);
        let attempt = format!("sha256:{:064x}", 3);
        let new = format!("sha256:{:064x}", 4);
        let entries = vec![
            StoreEntry::new(&old, 40, 1),
            StoreEntry::new(&deployment, 40, 2),
            StoreEntry::new(&attempt, 40, 3),
            StoreEntry::new(&new, 40, 4),
        ];
        let protected = BTreeSet::from([deployment.clone(), attempt.clone()]);

        assert_eq!(
            select_evictions(&entries, 160, 70, 180, &protected),
            Ok(vec![old, new])
        );
        assert_eq!(
            select_evictions(&entries[1..3], 80, 1, 80, &protected),
            Err(StoreError::Capacity)
        );
    }

    #[test]
    fn wp3b_store_rejects_unsafe_placement_and_has_no_network_surface() {
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
                "image store gained network surface {forbidden}"
            );
        }
    }
}
