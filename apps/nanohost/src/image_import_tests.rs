//! Composition regressions for local OCI selection and retained store publication.

#![cfg(target_os = "linux")]

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::image_store::{
    ImageStore, LocalArchiveError, StoreEntryStatus, StoreError, StoreLineage,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

/// Removes only the isolated paths owned by this fixture.
struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self::at(std::env::temp_dir().join(format!(
            "openkit-local-image-import-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        )))
    }

    fn at(root: PathBuf) -> Self {
        fs::create_dir(&root).expect("create isolated fixture");
        Self(root)
    }

    fn store(&self) -> ImageStore {
        ImageStore::open(
            self.0.join("store"),
            self.0.join("epoch"),
            &[self.0.join("credentials")],
        )
        .expect("open fixture store")
    }

    fn source(&self, bytes: &[u8]) -> File {
        let path = self.0.join(format!(
            "source-{}.tar",
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .expect("create archive source");
        file.write_all(bytes).expect("write archive source");
        File::open(path).expect("open archive source")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove isolated fixture");
    }
}

/// Independently authored OCI bytes with an index and one selected host image.
struct Archive {
    bytes: Vec<u8>,
    index_digest: String,
    manifest_digest: String,
    manifest: Vec<u8>,
    layer_digest: String,
    layer: Vec<u8>,
}

impl Archive {
    fn new(label: &str, layer_size: usize) -> Self {
        let architecture = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => panic!("unsupported NanoHost fixture architecture: {other}"),
        };
        let other_architecture = if architecture == "amd64" {
            "arm64"
        } else {
            "amd64"
        };
        let layer = (0..layer_size)
            .map(|index| label.as_bytes()[index % label.len()])
            .collect::<Vec<_>>();
        let config = serde_json::to_vec(&json!({
            "architecture": architecture, "os": "linux"
        }))
        .unwrap();
        let layer_digest = digest(&layer);
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": digest(&config), "size": config.len()
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar",
                "digest": layer_digest, "size": layer.len()
            }]
        }))
        .unwrap();
        let manifest_digest = digest(&manifest);
        let index = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": digest(b"unselected manifest"), "size": 19,
                    "platform": {"architecture": other_architecture, "os": "linux"}
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": manifest_digest, "size": manifest.len(),
                    "platform": {"architecture": architecture, "os": "linux"}
                }
            ]
        }))
        .unwrap();
        let index_digest = digest(&index);
        let layout_index = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "manifests": [{
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "digest": index_digest, "size": index.len()
            }]
        }))
        .unwrap();
        let mut bytes = Vec::new();
        append_member(
            &mut bytes,
            "oci-layout",
            br#"{"imageLayoutVersion":"1.0.0"}"#,
        );
        append_member(&mut bytes, "index.json", &layout_index);
        append_member(&mut bytes, &blob_path(&index_digest), &index);
        append_member(
            &mut bytes,
            "unneeded-member",
            b"must not become retained image content",
        );
        append_member(&mut bytes, &blob_path(&manifest_digest), &manifest);
        append_member(&mut bytes, &blob_path(&digest(&config)), &config);
        append_member(&mut bytes, &blob_path(&layer_digest), &layer);
        bytes.extend_from_slice(&[0; 1024]);
        Self {
            bytes,
            index_digest,
            manifest_digest,
            manifest,
            layer_digest,
            layer,
        }
    }

    fn admit(&self, fixture: &Fixture, store: &ImageStore) -> Result<String, LocalArchiveError> {
        store.admit_local_archive(&self.index_digest, fixture.source(&self.bytes), 17)
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn blob_path(digest: &str) -> String {
    format!("blobs/sha256/{}", digest.strip_prefix("sha256:").unwrap())
}

/// Constructs a regular USTAR member without using the archive implementation under test.
fn append_member(archive: &mut Vec<u8>, name: &str, contents: &[u8]) {
    let mut header = [0_u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    header[100..108].copy_from_slice(b"0000600\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(format!("{:011o}\0", contents.len()).as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    archive.extend_from_slice(&header);
    archive.extend_from_slice(contents);
    archive.resize(archive.len().next_multiple_of(512), 0);
}

/// Reads fixture-sized retained members with an oracle independent of production parsing.
fn retained_member<'a>(archive: &'a [u8], wanted: &str) -> Option<&'a [u8]> {
    let mut offset = 0;
    while offset + 512 <= archive.len() {
        let header = &archive[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            return None;
        }
        let name_end = header[..100]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(100);
        let name = std::str::from_utf8(&header[..name_end]).unwrap();
        let size_text = std::str::from_utf8(&header[124..136])
            .unwrap()
            .trim_matches(['\0', ' ']);
        let size = usize::from_str_radix(size_text, 8).unwrap();
        let start = offset + 512;
        if name == wanted {
            return Some(&archive[start..start + size]);
        }
        offset = start + size.next_multiple_of(512);
    }
    None
}

fn verified_bytes(store: &ImageStore, digest: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    store
        .read_verified(digest)
        .expect("verified retained file")
        .read_to_end(&mut bytes)
        .unwrap();
    bytes
}

#[test]
fn index_import_retains_selected_host_manifest_and_large_layer() {
    let fixture = Fixture::new();
    let store = fixture.store();
    // This exceeds both document and transfer limits. Memory bounds need separate reader evidence.
    let archive = Archive::new("selected-host", 1024 * 1024 + 7);
    assert_eq!(
        archive.admit(&fixture, &store).unwrap(),
        archive.manifest_digest
    );
    let rows = store.list().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].digest, archive.manifest_digest);
    assert_eq!(rows[0].status, StoreEntryStatus::Usable);
    assert_eq!(
        rows[0].lineage,
        Some(StoreLineage::LocalArchive(archive.manifest_digest.clone()))
    );
    let retained = verified_bytes(&store, &archive.manifest_digest);
    assert_eq!(
        retained_member(&retained, &blob_path(&archive.manifest_digest)),
        Some(archive.manifest.as_slice())
    );
    assert_eq!(
        retained_member(&retained, &blob_path(&archive.layer_digest)),
        Some(archive.layer.as_slice())
    );
    assert_eq!(store.capacity().unwrap().used, retained.len() as u64);
    assert_eq!(rows[0].size, retained.len() as u64);
    assert_eq!(
        store.read_verified(&archive.index_digest).unwrap_err(),
        StoreError::Missing
    );
}

#[test]
fn repeated_index_import_preserves_lineage_and_usage_below_lowered_limit() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let archive = Archive::new("idempotent", 4096);
    archive.admit(&fixture, &store).unwrap();
    let retained = verified_bytes(&store, &archive.manifest_digest);
    store.remove(&archive.manifest_digest).unwrap();
    let lineage = StoreLineage::Build(digest(b"original build definition"));
    store
        .admit_oci_file(
            &archive.manifest_digest,
            fixture.source(&retained),
            lineage.clone(),
            3,
        )
        .unwrap();
    let before = store.list().unwrap();
    store.set_capacity(1).unwrap();
    assert_eq!(
        archive.admit(&fixture, &store).unwrap(),
        archive.manifest_digest
    );
    assert_eq!(store.list().unwrap(), before);
    assert_eq!(store.capacity().unwrap().used, retained.len() as u64);
    assert_eq!(verified_bytes(&store, &archive.manifest_digest), retained);
}

#[test]
fn index_capacity_refusal_preserves_prior_entry() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let prior = Archive::new("prior", 4096);
    prior.admit(&fixture, &store).unwrap();
    let prior_bytes = verified_bytes(&store, &prior.manifest_digest);
    let before = store.list().unwrap();
    store.set_capacity(prior_bytes.len() as u64).unwrap();
    let incoming = Archive::new("incoming", 16384);
    assert!(matches!(
        incoming.admit(&fixture, &store),
        Err(LocalArchiveError::Store(StoreError::Capacity))
    ));
    assert_eq!(store.list().unwrap(), before);
    assert_eq!(store.capacity().unwrap().used, prior_bytes.len() as u64);
    assert_eq!(verified_bytes(&store, &prior.manifest_digest), prior_bytes);
}

#[test]
fn index_busy_refusal_preserves_store_and_allows_fresh_request() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let archive = Archive::new("busy", 4096);
    let lock = File::open(fixture.0.join("store")).unwrap();
    lock.try_lock().expect("own independent transaction lock");
    assert!(matches!(
        archive.admit(&fixture, &store),
        Err(LocalArchiveError::Store(StoreError::Busy))
    ));
    File::unlock(&lock).unwrap();
    assert_eq!(store.capacity().unwrap().used, 0);
    assert!(store.list().unwrap().is_empty());
    assert_eq!(
        archive.admit(&fixture, &store).unwrap(),
        archive.manifest_digest
    );
}

#[test]
fn index_digest_mismatch_publishes_no_image() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let archive = Archive::new("wrong-index", 4096);
    let result = store.admit_local_archive(
        &digest(b"different index"),
        fixture.source(&archive.bytes),
        17,
    );
    assert!(matches!(result, Err(LocalArchiveError::Acquisition(_))));
    assert!(store.list().unwrap().is_empty());
    assert_eq!(store.capacity().unwrap().used, 0);
}

#[test]
fn interrupted_index_publication_counts_retained_staging_and_exact_cleanup() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let prior = Archive::new("kept", 4096);
    prior.admit(&fixture, &store).unwrap();
    let prior_bytes = verified_bytes(&store, &prior.manifest_digest);
    let incoming = Archive::new("interrupted", 32768);
    let stem = incoming.manifest_digest.strip_prefix("sha256:").unwrap();
    // The directory is a fixture fault at the existing metadata publication boundary.
    let blocker = fixture
        .0
        .join("store/index")
        .join(format!("{stem}.meta.tmp"));
    fs::create_dir(&blocker).unwrap();
    assert!(matches!(
        incoming.admit(&fixture, &store),
        Err(LocalArchiveError::Store(_))
    ));
    fs::remove_dir(&blocker).expect("remove only fixture fault");
    drop(store);
    let store = fixture.store();
    let rows = store.list().unwrap();
    let incomplete = rows
        .iter()
        .find(|row| row.digest == incoming.manifest_digest)
        .expect("attributed interrupted content");
    assert_eq!(incomplete.status, StoreEntryStatus::Incomplete);
    assert!(incomplete.size > incoming.layer.len() as u64);
    let physical = store.capacity().unwrap().used;
    assert_eq!(physical, prior_bytes.len() as u64 + incomplete.size);
    store.set_capacity(physical).unwrap();
    let next = Archive::new("refused-growth", 4096);
    assert!(matches!(
        next.admit(&fixture, &store),
        Err(LocalArchiveError::Store(StoreError::Capacity))
    ));
    assert_eq!(store.capacity().unwrap().used, physical);
    store.remove(&incoming.manifest_digest).unwrap();
    store.remove(&incoming.manifest_digest).unwrap();
    assert_eq!(store.capacity().unwrap().used, prior_bytes.len() as u64);
    assert_eq!(verified_bytes(&store, &prior.manifest_digest), prior_bytes);
    assert_eq!(store.list().unwrap().len(), 1);
}

#[test]
fn index_import_does_not_require_configured_system_temp() {
    const CHILD_ROOT: &str = "OPENKIT_LOCAL_IMAGE_IMPORT_CHILD_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let fixture = Fixture::at(PathBuf::from(root).join("child"));
        let archive = Archive::new("no-system-temp", 1024 * 1024 + 7);
        assert_eq!(
            archive.admit(&fixture, &fixture.store()).unwrap(),
            archive.manifest_digest
        );
        return;
    }
    let fixture = Fixture::new();
    let denied_temp = fixture.0.join("not-a-directory");
    fs::write(&denied_temp, b"fixture denies temp staging").unwrap();
    // Child-local environment avoids races with unrelated tests. This observes TMPDIR use only.
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "image_import_tests::index_import_does_not_require_configured_system_temp",
            "--test-threads=1",
        ])
        .env(CHILD_ROOT, &fixture.0)
        .env("TMPDIR", &denied_temp)
        .env("TMP", &denied_temp)
        .env("TEMP", &denied_temp)
        .output()
        .expect("run isolated temp-path regression");
    assert!(
        output.status.success(),
        "child failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "child must execute its deciding test"
    );
    assert_eq!(
        fs::read(denied_temp).unwrap(),
        b"fixture denies temp staging"
    );
}
