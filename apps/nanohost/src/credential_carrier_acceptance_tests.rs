//! Independent slice-1 oracles from the accepted ruling and credential/storage owners.
//! Ordinary checks prove admission, file staging and capture. The ignored qualification
//! needs a separate mount namespace; it does not qualify stock OpenShell mounts.

#![cfg(target_os = "linux")]

use std::ffi::CString;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::credential_carrier::{CredentialBinding, CredentialCarrier, parse_bindings};
use crate::file_transfer::{FileStage, VerifiedFile};
use crate::persistent_volume::{PersistentVolumeStore, StorageMount};

/// Runtime-only synthetic material; never format it in an assertion or diagnostic.
fn synthetic() -> Vec<u8> {
    let mut bytes = vec![0_u8; 48];
    SystemRandom::new().fill(&mut bytes).unwrap();
    bytes
        .iter()
        .flat_map(|byte| format!("{byte:02x}").into_bytes())
        .collect()
}

/// Runtime-only path component, unrelated to any installed credential destination.
fn component() -> String {
    String::from_utf8(synthetic()).unwrap()
}

/// Owns fixture files only; shared storage builders establish the actual owner state.
struct Fixture {
    root: PathBuf,
    store: PersistentVolumeStore,
    volume: PathBuf,
    target: String,
    leaf: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("openkit-carrier-oracle-{}", component()));
        fs::create_dir_all(&root).unwrap();
        let store = crate::persistent_volume::tests::test_store(&root.join("retained"));
        let (_, volume) = crate::persistent_volume::tests::stored_association(
            &store,
            "storage-one",
            "sandbox-one",
            1,
        );
        let leaf = component();
        let target = format!("/sandbox/{leaf}");
        Self {
            root,
            store,
            volume,
            target,
            leaf,
        }
    }

    fn binding(&self) -> CredentialBinding {
        CredentialBinding {
            declaration_id: "static_file".into(),
            plan_id: "plan_fixture".into(),
            receipt_id: "receipt_fixture".into(),
            target_path: self.target.clone(),
        }
    }

    fn mounts(&self) -> Vec<StorageMount> {
        vec![StorageMount {
            source: self.volume.clone(),
            target: "/sandbox".into(),
            credential: None,
        }]
    }

    fn prepare(&self, binding: CredentialBinding) -> Result<Vec<File>, &'static str> {
        self.store.prepare_credential_targets(
            &self.mounts(),
            &[binding],
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Accepted transient wire terms; no bytes, host source, or caller mount options.
fn binding_wire(target: &str) -> Value {
    let id = component();
    let reference_id = format!(
        "vault_{}-{}-7{}-8{}-{}",
        &id[..8],
        &id[8..12],
        &id[13..16],
        &id[17..20],
        &id[20..32]
    );
    json!({
        "declarationId":"static_file", "planId":"plan_fixture", "receiptId":"receipt_fixture",
        "material":{"referenceId":reference_id,"version":1,"format":"utf8"},
        "target":{"kind":"file","path":target}, "access":"read-only",
        "requiredProtection":{
            "ephemeral":true, "outsideRetainedStorage":true,
            "excludedFromCapture":true, "excludedFromExport":true
        }
    })
}

#[test]
fn credential_carrier_accepts_only_closed_secret_free_create_intent() {
    let fixture = Fixture::new();
    let wire = binding_wire(&fixture.target);
    assert!(parse_bindings(Some(&json!([wire.clone()]))).is_ok());
    for field in [
        "source",
        "hostPath",
        "credentialValue",
        "readOnly",
        "driverConfig",
    ] {
        let mut changed = wire.clone();
        changed[field] = Value::String(component());
        assert!(
            parse_bindings(Some(&json!([changed]))).is_err(),
            "caller-controlled authority field admitted"
        );
    }
    for access in [Value::Null, json!("read-write"), json!(true)] {
        let mut changed = wire.clone();
        changed["access"] = access;
        assert!(
            parse_bindings(Some(&json!([changed]))).is_err(),
            "non-read-only intent admitted"
        );
    }
    let mut missing_access = wire.clone();
    missing_access.as_object_mut().unwrap().remove("access");
    assert!(
        parse_bindings(Some(&json!([missing_access]))).is_err(),
        "implicit access admitted"
    );
    for value in [Value::Null, json!({}), json!([{}]), json!([false])] {
        assert!(
            parse_bindings(Some(&value)).is_err(),
            "malformed credential intent admitted"
        );
    }
}

/// Every placement must satisfy the full required protection; omissions never downgrade it.
#[test]
fn credential_carrier_refuses_neutral_binding_protection_or_material_downgrade() {
    let fixture = Fixture::new();
    let wire = binding_wire(&fixture.target);
    for field in ["material", "target", "access", "requiredProtection"] {
        let mut changed = wire.clone();
        changed.as_object_mut().unwrap().remove(field);
        assert!(
            parse_bindings(Some(&json!([changed]))).is_err(),
            "required binding term omitted"
        );
    }
    for field in [
        "ephemeral",
        "outsideRetainedStorage",
        "excludedFromCapture",
        "excludedFromExport",
    ] {
        for value in [Value::Null, json!(false), json!("true")] {
            let mut changed = wire.clone();
            changed["requiredProtection"][field] = value;
            assert!(
                parse_bindings(Some(&json!([changed]))).is_err(),
                "protection downgrade admitted"
            );
        }
        let mut changed = wire.clone();
        changed["requiredProtection"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            parse_bindings(Some(&json!([changed]))).is_err(),
            "implicit protection admitted"
        );
    }
    for version in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("1"),
        json!(9_007_199_254_740_992_u64),
    ] {
        let mut changed = wire.clone();
        changed["material"]["version"] = version;
        assert!(
            parse_bindings(Some(&json!([changed]))).is_err(),
            "unproved material generation admitted"
        );
    }
    for (section, field, value) in [
        ("material", "format", json!("binary")),
        ("material", "referenceId", json!("")),
        ("material", "credentialValue", json!(component())),
        ("target", "kind", json!("directory")),
        ("target", "hostPath", json!(component())),
        ("requiredProtection", "mountFlags", json!([])),
    ] {
        let mut changed = wire.clone();
        changed[section][field] = value;
        assert!(
            parse_bindings(Some(&json!([changed]))).is_err(),
            "non-neutral or unsupported binding term admitted"
        );
    }
}

#[test]
fn credential_carrier_refuses_traversal_and_noncanonical_targets() {
    let fixture = Fixture::new();
    for target in [
        format!("sandbox/{}", fixture.leaf),
        format!("/sandbox/../{}", fixture.leaf),
        format!("/sandbox/./{}", fixture.leaf),
        format!("/sandbox//{}", fixture.leaf),
        format!("/sandbox/{}/", fixture.leaf),
        format!("/sandbox/{}\n", fixture.leaf),
    ] {
        assert!(
            parse_bindings(Some(&json!([binding_wire(&target)]))).is_err(),
            "unsafe target admitted"
        );
    }
}

#[test]
fn credential_carrier_refuses_duplicate_and_overlapping_file_targets() {
    let fixture = Fixture::new();
    let first = binding_wire(&fixture.target);
    for target in [
        fixture.target.clone(),
        format!("{}/{}", fixture.target, component()),
    ] {
        let mut second = binding_wire(&target);
        second["declarationId"] = json!("second");
        second["planId"] = json!("plan_second");
        second["receiptId"] = json!("receipt_second");
        for rows in [
            json!([first.clone(), second.clone()]),
            json!([second, first.clone()]),
        ] {
            assert!(
                parse_bindings(Some(&rows)).is_err(),
                "overlapping targets admitted"
            );
        }
    }
}

#[test]
fn credential_carrier_mount_point_is_one_empty_regular_file() {
    let fixture = Fixture::new();
    let files = fixture
        .prepare(fixture.binding())
        .expect("empty mount point admission");
    assert_eq!(files.len(), 1);
    let observed = files[0].metadata().unwrap();
    assert!(observed.is_file());
    assert_eq!(observed.len(), 0);
    assert_eq!(observed.nlink(), 1);
    assert_eq!(fs::read_dir(&fixture.volume).unwrap().count(), 1);
}

#[test]
fn credential_carrier_refuses_nonempty_target_without_overwriting_it() {
    let fixture = Fixture::new();
    let material = synthetic();
    let path = fixture.volume.join(&fixture.leaf);
    fs::write(&path, &material).unwrap();
    let before = fs::metadata(&path).unwrap();
    assert!(
        fixture.prepare(fixture.binding()).is_err(),
        "nonempty target admitted"
    );
    assert!(
        fs::read(&path).unwrap() == material,
        "existing target changed"
    );
    assert_eq!(fs::metadata(&path).unwrap().ino(), before.ino());
}

#[test]
fn credential_carrier_refuses_symlink_leaf_and_symlink_parent() {
    for parent in [false, true] {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        let path = fixture.volume.join(&fixture.leaf);
        symlink(&outside, &path).unwrap();
        let mut binding = fixture.binding();
        if parent {
            binding.target_path.push_str(&format!("/{}", component()));
        }
        assert!(
            fixture.prepare(binding).is_err(),
            "symlink traversal admitted"
        );
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    }
}

#[test]
fn credential_carrier_refuses_directory_and_hardlinked_targets() {
    for directory in [false, true] {
        let fixture = Fixture::new();
        let path = fixture.volume.join(&fixture.leaf);
        if directory {
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, []).unwrap();
            fs::hard_link(&path, fixture.root.join("alias")).unwrap();
        }
        assert!(
            fixture.prepare(fixture.binding()).is_err(),
            "non-exclusive regular target admitted"
        );
    }
}

#[test]
fn credential_carrier_refuses_target_outside_admitted_retained_roots() {
    let fixture = Fixture::new();
    let mut binding = fixture.binding();
    binding.target_path = format!("/outside/{}", component());
    assert!(fixture.prepare(binding).is_err(), "unowned target admitted");
    assert_eq!(fs::read_dir(&fixture.volume).unwrap().count(), 0);
}

/// Uses the real private stream verification owner, without disk or filesystem doubles.
fn memory_original(material: &[u8]) -> VerifiedFile {
    let mut stage = FileStage::create_memory(material.len() as u64).unwrap();
    for chunk in material.chunks(7) {
        stage.write_all(chunk).unwrap();
    }
    stage
        .complete(Some((
            material.len() as u64,
            &format!("sha256:{:x}", Sha256::digest(material)),
        )))
        .unwrap()
}

#[test]
fn credential_carrier_import_staging_is_memory_backed_and_has_exact_verified_bytes() {
    let material = synthetic();
    let verified = memory_original(&material);
    let mut reader = verified.reader().unwrap();
    let mut facts = std::mem::MaybeUninit::<libc::statfs>::uninit();
    assert_eq!(
        unsafe { libc::fstatfs(reader.as_raw_fd(), facts.as_mut_ptr()) },
        0
    );
    assert_eq!(
        unsafe { facts.assume_init() }.f_type,
        0x0102_1994,
        "credential staging is not memory backed"
    );
    let mut observed = Vec::new();
    reader.read_to_end(&mut observed).unwrap();
    assert!(observed == material, "verified import changed the original");
    assert_eq!(
        reader.metadata().unwrap().nlink(),
        0,
        "staging has a retained filesystem name"
    );
    assert_eq!(verified.length(), material.len() as u64);
}

#[test]
fn credential_carrier_import_refuses_short_long_and_wrong_digest_bodies() {
    let material = synthetic();
    let digest = format!("sha256:{:x}", Sha256::digest(&material));
    for (length, hash) in [
        (material.len() as u64 - 1, digest.clone()),
        (material.len() as u64 + 1, digest),
        (
            material.len() as u64,
            format!("sha256:{:x}", Sha256::digest(synthetic())),
        ),
    ] {
        let mut stage = FileStage::create_memory(material.len() as u64).unwrap();
        stage.write_all(&material).unwrap();
        assert!(
            stage.complete(Some((length, &hash))).is_err(),
            "unverified import admitted"
        );
    }
    let mut stage = FileStage::create_memory(1).unwrap();
    assert!(
        stage.write_all(&material).is_err(),
        "import bound not enforced"
    );
}

#[tokio::test]
async fn credential_carrier_capture_refuses_copied_plaintext_without_publishing_bytes() {
    let fixture = Fixture::new();
    let (coordinator, worktree) = crate::epoch_coordinator::EpochCoordinator::collection_fixture(
        &fixture.root.join("collection"),
    );
    let material = synthetic();
    fs::write(worktree.join(component()), &material).unwrap();
    let request_id = "ac".repeat(32);
    let input = json!({
        "requestId":request_id, "storageRef":"storage-one", "scopeDigest":format!("sha256:{}", "b".repeat(64)),
        "attachmentGeneration":1, "sandboxId":"sandbox-one", "workSlot":"slotA", "collectionId":"synthetic",
        "mode":"baseline", "acceptedBase":null, "previousHead":null,
        "checkValues":{"runtimeEnv":[String::from_utf8(material.clone()).unwrap()],
            "loopbackDigests":[format!("{:x}", Sha256::digest(synthetic())), format!("{:x}", Sha256::digest(synthetic()))]}
    });
    let delivery = crate::workspace_collect::execute_collect(&coordinator, &request_id, &input);
    let crate::workspace_collect::WorkspaceCollectDelivery::Json { body, .. } = delivery else {
        panic!("credential-bearing capture published a candidate");
    };
    let output: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(output["outcome"], "credential_hit");
    assert!(
        !body
            .windows(material.len())
            .any(|window| window == material),
        "capture result disclosed material"
    );
    assert_no_plaintext(&fixture.root.join("collection/scans"), &material);
}

/// Bounded to the fixture's private scan output; the intentionally contaminated source is excluded.
fn assert_no_plaintext(root: &Path, material: &[u8]) {
    if !root.exists() {
        return;
    }
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            assert_no_plaintext(&entry.path(), material);
        } else if kind.is_file() {
            assert!(
                !fs::read(entry.path())
                    .unwrap()
                    .windows(material.len())
                    .any(|window| window == material),
                "private capture output contains credential bytes"
            );
        }
    }
}

#[test]
#[ignore = "explicit qualification: root in a disposable mount namespace; no stock OpenShell claim"]
fn credential_carrier_qualified_tmpfs_lifetime_and_single_file_projection() {
    qualification_root();
    let fixture = Fixture::new();
    let run_root = fixture.root.join("epoch");
    fs::create_dir(&run_root).unwrap();
    fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
    let points = fixture.prepare(fixture.binding()).unwrap();
    let mut carrier = CredentialCarrier::create(
        &run_root,
        "sandbox-one",
        vec![fixture.binding()],
        unsafe { libc::geteuid() },
        unsafe { libc::getegid() },
        points,
    )
    .expect("qualified memory carrier allocation");
    let mounts = carrier.mounts();
    assert_eq!(
        mounts.len(),
        1,
        "must expose one file, never the entire retained home"
    );
    let source = mounts[0].source.clone();
    assert!(
        source.starts_with(&run_root),
        "carrier escaped the disposable epoch"
    );
    assert!(
        !source.starts_with(&fixture.volume),
        "carrier entered retained storage"
    );
    let parent = source.parent().unwrap();
    let metadata = fs::metadata(parent).unwrap();
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.mode() & 0o777, 0o700);
    let file = File::open(&source).unwrap();
    let mut facts = std::mem::MaybeUninit::<libc::statfs>::uninit();
    assert_eq!(
        unsafe { libc::fstatfs(file.as_raw_fd(), facts.as_mut_ptr()) },
        0
    );
    assert_eq!(unsafe { facts.assume_init() }.f_type, 0x0102_1994);
    let mountinfo = fs::read_to_string("/proc/self/mountinfo").unwrap();
    let line = mountinfo
        .lines()
        .find(|line| line.split(' ').nth(4) == parent.to_str())
        .expect("carrier mount evidence");
    for flag in ["nodev", "nosuid", "noexec"] {
        assert!(
            line.split_whitespace()
                .nth(5)
                .unwrap()
                .split(',')
                .any(|option| option == flag),
            "carrier mount flag missing"
        );
    }
    let config = crate::openshell_client::storage_driver_config(&mounts)
        .unwrap()
        .unwrap();
    let docker = match config.fields["docker"].kind.as_ref().unwrap() {
        prost_types::value::Kind::StructValue(value) => value,
        _ => panic!("Docker mount projection missing"),
    };
    let projected = match docker.fields["mounts"].kind.as_ref().unwrap() {
        prost_types::value::Kind::ListValue(value) => &value.values,
        _ => panic!("file mount projection missing"),
    };
    assert_eq!(projected.len(), 1);
    let mount = match projected[0].kind.as_ref().unwrap() {
        prost_types::value::Kind::StructValue(value) => value,
        _ => panic!("file mount projection invalid"),
    };
    assert!(
        matches!(
            mount.fields["read_only"].kind,
            Some(prost_types::value::Kind::BoolValue(true))
        ),
        "credential mount is writable"
    );
    let material = synthetic();
    let original = memory_original(&material);
    let relative = import_address(&fixture.binding());
    // Import addressing belongs to the public private-file effect contract. A future
    // signature change may adapt this address without changing any security oracle.
    let imported = carrier.import("sandbox-one", &relative, &original);
    assert!(imported.is_ok(), "verified private import failed");
    assert!(
        fs::read(&source).unwrap() == material,
        "carrier did not receive exact original"
    );
    assert!(
        fs::read(fixture.volume.join(&fixture.leaf))
            .unwrap()
            .is_empty(),
        "retained mount point received bytes"
    );
    drop(file);
    drop(mounts);
    drop(imported);
    carrier
        .remove_after_absence()
        .expect("fixture has no Sandbox consumer");
    assert!(!source.exists(), "carrier survived proved teardown");
}

/// Only a carriage address, computed independently from the current public boundary terms.
fn import_address(binding: &CredentialBinding) -> PathBuf {
    let framed = serde_json::to_vec(&[
        &binding.declaration_id,
        &binding.plan_id,
        &binding.receipt_id,
    ])
    .unwrap();
    PathBuf::from(format!("{:x}", Sha256::digest(framed)))
}

/// Refuses a host namespace, then confines this qualification process to an owned root.
/// The outer run-slot temporary root is reclaimed after this isolated process exits.
fn qualification_root() {
    static ROOT: OnceLock<()> = OnceLock::new();
    ROOT.get_or_init(|| {
        assert_eq!(
            unsafe { libc::geteuid() },
            0,
            "qualification requires user-namespace root"
        );
        let mapping: Vec<u64> = fs::read_to_string("/proc/self/uid_map")
            .unwrap()
            .split_whitespace()
            .map(|value| value.parse().unwrap())
            .collect();
        assert!(
            mapping.len() == 3 && mapping[0] == 0 && mapping[1] != 0 && mapping[2] == 1,
            "qualification requires an unprivileged single-user mapping"
        );
        let mount_namespace = File::open("/proc/self/ns/mnt").unwrap();
        let user_namespace = File::open("/proc/self/ns/user").unwrap();
        // Linux nsfs NS_GET_USERNS: the isolated mount namespace must belong
        // to this unprivileged user namespace, never the original host owner.
        let owner_fd = unsafe { libc::ioctl(mount_namespace.as_raw_fd(), 0xb701) };
        assert!(owner_fd >= 0, "mount namespace owner proof unavailable");
        let owner = unsafe { File::from_raw_fd(owner_fd) };
        assert_eq!(
            (
                owner.metadata().unwrap().dev(),
                owner.metadata().unwrap().ino()
            ),
            (
                user_namespace.metadata().unwrap().dev(),
                user_namespace.metadata().unwrap().ino()
            ),
            "mount namespace belongs to the host user namespace"
        );
        drop(owner);
        drop(mount_namespace);
        drop(user_namespace);
        let root = std::env::temp_dir().join(format!("carrier-namespace-root-{}", component()));
        fs::create_dir_all(root.join("proc")).unwrap();
        fs::create_dir(root.join("previous-root")).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root_path = CString::new(root.as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe {
                libc::mount(
                    root_path.as_ptr(),
                    root_path.as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND,
                    std::ptr::null(),
                )
            },
            0,
            "isolated fixture root mount failed"
        );
        let proc_target = CString::new(root.join("proc").as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe {
                libc::mount(
                    c"/proc".as_ptr(),
                    proc_target.as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND,
                    std::ptr::null(),
                )
            },
            0,
            "isolated proc observation mount failed"
        );
        // Install the exact production CLI bytes and a fixture-only runtime before pivot_root.
        // No exported JS function or injected slot-root override is used by the helper case.
        let node = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success(), "pinned Node runtime unavailable");
        let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
        for directory in ["usr/local/bin", "usr/bin", "usr/lib"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        bind_fixture_path(Path::new("/usr/lib"), &root.join("usr/lib"));
        symlink("usr/lib", root.join("lib")).unwrap();
        symlink("usr/lib", root.join("lib64")).unwrap();
        for (source, destination) in [
            (node.as_path(), "usr/local/bin/node"),
            (Path::new("/usr/bin/env"), "usr/bin/env"),
        ] {
            fs::write(root.join(destination), []).unwrap();
            bind_fixture_path(source, &root.join(destination));
        }
        let helper = root.join("usr/local/bin/openkit-file-effect");
        fs::write(
            &helper,
            include_bytes!("../../../containers/workers/openkit-file-effect"),
        )
        .unwrap();
        fs::set_permissions(helper, fs::Permissions::from_mode(0o755)).unwrap();
        let previous_root =
            CString::new(root.join("previous-root").as_os_str().as_bytes()).unwrap();
        // setns installs the target namespace's root. chroot alone leaves that root
        // outside this fixture; pivot_root keeps both caller and backend views here.
        assert_eq!(
            unsafe {
                libc::syscall(
                    libc::SYS_pivot_root,
                    root_path.as_ptr(),
                    previous_root.as_ptr(),
                )
            },
            0,
            "isolated fixture root failed"
        );
        assert_eq!(unsafe { libc::chdir(c"/".as_ptr()) }, 0);
    });
}

/// Reclaims only this test's read-only kernel view, before carrier removal.
struct BoundView(PathBuf);
impl Drop for BoundView {
    fn drop(&mut self) {
        let path = CString::new(self.0.as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe { libc::umount2(path.as_ptr(), 0) },
            0,
            "fixture bind removal failed"
        );
    }
}

#[test]
#[ignore = "explicit qualification: isolated user/mount namespaces; kernel mechanism, not stock OpenShell"]
fn credential_carrier_qualified_host_rewrite_keeps_bound_inode() {
    // Engineer amendment D: host-side rewrite, same inode, no rename or remount.
    qualification_root();
    let fixture = Fixture::new();
    let run_root = fixture.root.join("epoch");
    fs::create_dir(&run_root).unwrap();
    fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
    let binding = fixture.binding();
    let address = import_address(&binding);
    let mut carrier = CredentialCarrier::create(
        &run_root,
        "sandbox-one",
        vec![binding],
        unsafe { libc::geteuid() },
        unsafe { libc::getegid() },
        fixture.prepare(fixture.binding()).unwrap(),
    )
    .unwrap();
    let original = synthetic();
    carrier
        .import("sandbox-one", &address, &memory_original(&original))
        .expect("original private import");
    let mounts = carrier.mounts();
    let source = mounts[0].source.clone();
    let destination = fixture.volume.join(&fixture.leaf);
    let source_c = CString::new(source.as_os_str().as_bytes()).unwrap();
    let destination_c = CString::new(destination.as_os_str().as_bytes()).unwrap();
    assert_eq!(
        unsafe {
            libc::mount(
                source_c.as_ptr(),
                destination_c.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND,
                std::ptr::null(),
            )
        },
        0,
        "isolated single-file kernel bind failed"
    );
    let view = BoundView(destination.clone());
    assert_eq!(
        unsafe {
            libc::mount(
                std::ptr::null(),
                destination_c.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY,
                std::ptr::null(),
            )
        },
        0,
        "isolated read-only view failed"
    );
    let mut reader = File::open(&destination).unwrap();
    let before = reader.metadata().unwrap();
    let mut seen = Vec::new();
    reader.read_to_end(&mut seen).unwrap();
    assert!(
        seen == original,
        "initial bound view differs from the admitted original"
    );
    let mountinfo_before = fs::read_to_string("/proc/self/mountinfo").unwrap();
    let replacement = synthetic()[..23].to_vec();
    carrier
        .rewrite("sandbox-one", &address, &memory_original(&replacement))
        .expect("authorized host-side rewrite");
    let after = fs::metadata(&destination).unwrap();
    assert_eq!(
        (before.dev(), before.ino()),
        (after.dev(), after.ino()),
        "bound inode changed during rewrite"
    );
    assert_eq!(
        (before.dev(), before.ino()),
        (
            reader.metadata().unwrap().dev(),
            reader.metadata().unwrap().ino()
        )
    );
    use std::io::{Seek, SeekFrom};
    reader.seek(SeekFrom::Start(0)).unwrap();
    seen.clear();
    reader.read_to_end(&mut seen).unwrap();
    assert!(
        seen == replacement,
        "existing read-only file descriptor did not see the exact replacement"
    );
    assert!(
        fs::read_to_string("/proc/self/mountinfo").unwrap() == mountinfo_before,
        "rewrite changed the mount topology"
    );
    let denied = unsafe { libc::open(destination_c.as_ptr(), libc::O_WRONLY | libc::O_TRUNC) };
    let denial = std::io::Error::last_os_error().raw_os_error();
    if denied >= 0 {
        unsafe { libc::close(denied) };
    }
    assert!(denied < 0, "Worker view became writable");
    assert_eq!(denial, Some(libc::EROFS));
    drop(reader);
    drop(view);
    assert!(
        fs::read(&destination).unwrap().is_empty(),
        "retained mount point contains replacement bytes"
    );
    drop(mounts);
    carrier
        .remove_after_absence()
        .expect("proved-absent fixture carrier removal");
    assert!(!source.exists(), "rewrite carrier survived removal");
}

/// Adds only a runtime/test observation binding inside the already-proved private namespace.
fn bind_fixture_path(source: &Path, target: &Path) {
    let source = CString::new(source.as_os_str().as_bytes()).unwrap();
    let target = CString::new(target.as_os_str().as_bytes()).unwrap();
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
        "isolated fixture bind failed"
    );
}

/// Invokes the actual installed CLI entry with bounded synthetic stdin and captured value-free output.
fn invoke_installed_verify(path: &Path, material: &[u8], length: usize) -> std::process::Output {
    invoke_installed_verify_frame(path, material, length, true)
}

/// An exact frame must settle while its sender remains open; EOF is not a terminator.
fn invoke_installed_verify_frame(
    path: &Path,
    material: &[u8],
    length: usize,
    close_input: bool,
) -> std::process::Output {
    use std::process::{Command, Stdio};
    let mut child = Command::new("/usr/local/bin/openkit-file-effect")
        .args(["credential.verify", "--path"])
        .arg(path)
        .arg("--length")
        .arg(length.to_string())
        .env_clear()
        .env("PATH", "/usr/local/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(material);
    let held_input = if close_input {
        drop(stdin);
        None
    } else {
        Some(stdin)
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("installed helper did not settle its declared frame");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    drop(held_input);
    child.wait_with_output().unwrap()
}

#[test]
#[ignore = "explicit qualification: isolated user/mount namespaces; production helper CLI, no stock OpenShell claim"]
fn credential_carrier_qualified_installed_helper_accepts_exact_readonly_view_and_refuses_unproved_views()
 {
    qualification_root();
    let fixture = Fixture::new();
    let run_root = fixture.root.join("epoch");
    fs::create_dir(&run_root).unwrap();
    fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
    let address = import_address(&fixture.binding());
    let mut carrier = CredentialCarrier::create(
        &run_root,
        "sandbox-one",
        vec![fixture.binding()],
        unsafe { libc::geteuid() },
        unsafe { libc::getegid() },
        fixture.prepare(fixture.binding()).unwrap(),
    )
    .unwrap();
    let material = synthetic();
    carrier
        .import("sandbox-one", &address, &memory_original(&material))
        .unwrap();
    fs::create_dir_all("/sandbox").unwrap();
    bind_fixture_path(&fixture.volume, Path::new("/sandbox"));
    let retained_view = BoundView(PathBuf::from("/sandbox"));
    let destination = PathBuf::from(&fixture.target);
    let mounts = carrier.mounts();
    bind_fixture_path(&mounts[0].source, &destination);
    let file_view = BoundView(destination.clone());
    let destination_c = CString::new(destination.as_os_str().as_bytes()).unwrap();
    let remount = |read_only: bool| {
        let flags = libc::MS_BIND | libc::MS_REMOUNT | if read_only { libc::MS_RDONLY } else { 0 };
        assert_eq!(
            unsafe {
                libc::mount(
                    std::ptr::null(),
                    destination_c.as_ptr(),
                    std::ptr::null(),
                    flags,
                    std::ptr::null(),
                )
            },
            0,
            "isolated helper-view remount failed"
        );
    };
    remount(true);
    let accepted = invoke_installed_verify_frame(&destination, &material, material.len(), false);
    assert!(
        accepted.status.success(),
        "production installed helper refused a proved read-only file"
    );
    assert!(
        accepted.stdout == b"OPENKIT_CREDENTIAL_MOUNT_V1\n",
        "helper success marker invalid"
    );
    assert!(
        accepted.stderr.is_empty(),
        "helper success emitted diagnostics"
    );
    let wrong_material = synthetic();
    let short_material = &material[..material.len() - 1];
    // Complete-body excess belongs to the outer carriage, not this length-framed helper.
    for body in [wrong_material.as_slice(), short_material] {
        let refused = invoke_installed_verify(&destination, body, material.len());
        assert!(
            !refused.status.success(),
            "helper admitted unproved private bytes"
        );
        assert!(
            refused.stdout.is_empty(),
            "failed helper emitted a success or payload"
        );
        assert!(
            !refused
                .stderr
                .windows(material.len())
                .any(|window| window == material),
            "helper diagnostic disclosed material"
        );
        assert!(
            !refused
                .stderr
                .windows(body.len())
                .any(|window| window == body),
            "helper diagnostic disclosed supplied material"
        );
    }
    let ordinary = PathBuf::from(format!("/sandbox/{}", component()));
    fs::write(&ordinary, []).unwrap();
    let refused = invoke_installed_verify(&ordinary, &[], 0);
    assert!(
        !refused.status.success() && refused.stdout.is_empty(),
        "helper admitted an ordinary retained file"
    );
    let alias = PathBuf::from(format!("/sandbox/{}", component()));
    symlink(&destination, &alias).unwrap();
    let refused = invoke_installed_verify(&alias, &material, material.len());
    assert!(
        !refused.status.success() && refused.stdout.is_empty(),
        "helper admitted a symlink alias"
    );
    remount(false);
    let refused = invoke_installed_verify(&destination, &material, material.len());
    assert!(
        !refused.status.success() && refused.stdout.is_empty(),
        "helper admitted a writable bind"
    );
    remount(true);
    assert!(
        fs::read(&destination).unwrap() == material,
        "verification changed the delivered file"
    );
    drop(file_view);
    assert!(
        fs::read(&destination).unwrap().is_empty(),
        "helper verification wrote retained bytes"
    );
    drop(retained_view);
    drop(mounts);
    carrier.remove_after_absence().unwrap();
}

/// Complete outer carriage is checked before any helper sees its declared frame.
#[tokio::test]
async fn credential_carrier_outer_import_refuses_excess_in_one_or_split_data_frames() {
    use crate::epoch_coordinator::RuntimeEffectKind;
    use crate::nanocore_session::{effect_kind_for_cursor, poll_effect_command};
    use bytes::Bytes;
    for case in ["exact", "one-frame-excess", "split-frame-excess"] {
        let fixture = Fixture::new();
        let material = synthetic();
        let supplied = material.clone();
        let declared_length = material.len();
        let digest = format!("sha256:{:x}", Sha256::digest(&material));
        let staging_root = fixture.root.join("outer-staging");
        let (client_io, server_io) = tokio::io::duplex(65536);
        let (mut sender, connection) = h2::client::handshake(client_io).await.unwrap();
        let driver = tokio::spawn(connection);
        let sent = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let peer_sent = Arc::clone(&sent);
        let server = tokio::spawn(async move {
            let mut connection = h2::server::handshake(server_io).await.unwrap();
            let (request, mut respond) = connection.accept().await.unwrap().unwrap();
            assert!(request.uri().path().ends_with("/reference.import"));
            let headers = http::Response::builder()
                .status(200)
                .header("content-type", "application/octet-stream")
                .header("content-length", declared_length.to_string())
                .header(
                    "x-openkit-request-id",
                    format!("{:x}", Sha256::digest(component())),
                )
                .header("x-openkit-slot", "runtime-credential")
                .header("x-openkit-relative-path", component())
                .header("x-openkit-entry-kind", "file")
                .header("x-openkit-executable", "false")
                .header("x-openkit-sha256", digest)
                .header("x-openkit-byte-length", declared_length.to_string());
            let mut stream = respond
                .send_response(headers.body(()).unwrap(), false)
                .unwrap();
            if case == "one-frame-excess" {
                let mut excess = supplied;
                excess.push(1);
                assert!(
                    stream.send_data(Bytes::from(excess), true).is_ok(),
                    "outer excess fixture could not send DATA frame"
                );
            } else {
                stream
                    .send_data(Bytes::from(supplied), case == "exact")
                    .unwrap();
                if case == "split-frame-excess" {
                    assert!(
                        stream.send_data(Bytes::from(vec![1]), true).is_ok(),
                        "outer split excess fixture could not send DATA frame"
                    );
                }
            }
            peer_sent.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = connection.accept().await;
        });
        let mut cursor = (0..32)
            .find(|index| effect_kind_for_cursor(*index) == RuntimeEffectKind::ImportReference)
            .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            poll_effect_command(
                "http://core:80",
                &mut sender,
                &mut cursor,
                false,
                &staging_root,
            ),
        )
        .await;
        assert!(result.is_ok(), "outer carriage did not settle");
        assert!(
            sent.load(std::sync::atomic::Ordering::SeqCst),
            "outer peer did not send the intended body"
        );
        let result = result.unwrap();
        if case == "exact" {
            assert!(result.is_ok(), "exact outer frame was refused");
            let command = result.unwrap().expect("exact outer command missing");
            assert!(
                command.admission_failure.is_none(),
                "exact outer admission failed"
            );
            let entry = command.file_data.expect("verified outer file missing");
            let crate::sandbox_bridge::ImportEntry::File { file, .. } = entry.entry else {
                panic!("file import changed kind");
            };
            let mut actual = Vec::new();
            file.reader().unwrap().read_to_end(&mut actual).unwrap();
            assert!(actual == material, "outer verification changed material");
        } else if let Ok(command) = result {
            let command = command.expect("correlated refusal missing");
            assert!(command.admission_failure.is_some(), "excess body admitted");
            assert!(
                command.file_data.is_none(),
                "excess body reached helper supply"
            );
        }
        // A transport-level H2 framing rejection also prevents any helper supply.
        assert!(
            !staging_root.exists(),
            "credential outer import created disk staging"
        );
        driver.abort();
        server.abort();
        let _ = driver.await;
        let _ = server.await;
    }
}

/// Creates the backend mount domain first, with private propagation, inside the isolated fixture.
fn earlier_backend_namespace() -> Arc<OwnedFd> {
    std::thread::spawn(|| {
        assert_eq!(
            unsafe { libc::unshare(libc::CLONE_FS | libc::CLONE_NEWNS) },
            0,
            "backend namespace setup failed"
        );
        assert_eq!(
            unsafe {
                libc::mount(
                    c"/".as_ptr(),
                    c"/".as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND | libc::MS_REC,
                    std::ptr::null(),
                )
            },
            0,
            "backend root bind failed"
        );
        // The outer unshare establishes private propagation before chroot. A repeated
        // propagation operation after chroot can return EINVAL; prove the actual view.
        let mountinfo = fs::read_to_string("/proc/thread-self/mountinfo").unwrap();
        assert!(!mountinfo.is_empty(), "backend mount view missing");
        assert!(
            mountinfo.lines().all(|line| {
                line.split_ascii_whitespace()
                    .skip(6)
                    .take_while(|field| *field != "-")
                    .all(|field| {
                        !field.starts_with("shared:")
                            && !field.starts_with("master:")
                            && !field.starts_with("propagate_from:")
                    })
            }),
            "backend mount propagation is not private"
        );
        Arc::new(File::open("/proc/thread-self/ns/mnt").unwrap().into())
    })
    .join()
    .unwrap()
}

/// Independent observation in the pinned backend domain; the caller's view never changes.
fn observe_backend<T: Send>(namespace: &Arc<OwnedFd>, observe: impl FnOnce() -> T + Send) -> T {
    std::thread::scope(|scope| {
        scope
            .spawn(move || {
                assert_eq!(
                    unsafe { libc::unshare(libc::CLONE_FS) },
                    0,
                    "observation fs separation failed"
                );
                assert_eq!(
                    unsafe { libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNS) },
                    0,
                    "backend observation unavailable"
                );
                observe()
            })
            .join()
            .unwrap()
    })
}

#[test]
#[ignore = "explicit qualification: isolated user/mount/PID namespaces; backend created before carrier"]
fn credential_carrier_qualified_earlier_backend_sees_source_and_caller_can_manage_it() {
    qualification_root();
    let fixture = Fixture::new();
    let run_root = fixture.root.join("epoch");
    fs::create_dir(&run_root).unwrap();
    fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
    let namespace = earlier_backend_namespace();
    let caller_namespace = File::open("/proc/thread-self/ns/mnt").unwrap();
    let namespace_file = File::from(namespace.as_ref().try_clone().unwrap());
    assert_ne!(
        caller_namespace.metadata().unwrap().ino(),
        namespace_file.metadata().unwrap().ino(),
        "backend reused caller namespace"
    );
    drop(namespace_file);
    let caller_mounts = fs::read_to_string("/proc/thread-self/mountinfo").unwrap();
    let mut carrier = CredentialCarrier::create_in_namespace(
        Arc::clone(&namespace),
        &run_root,
        "sandbox-one",
        vec![fixture.binding()],
        unsafe { libc::geteuid() },
        unsafe { libc::getegid() },
        fixture.prepare(fixture.binding()).unwrap(),
    )
    .unwrap();
    let mounts = carrier.mounts();
    let source = mounts[0].source.clone();
    assert!(
        !source.exists(),
        "carrier source leaked into the allocating namespace"
    );
    assert!(
        observe_backend(&namespace, || source.exists()),
        "earlier backend cannot see carrier source"
    );
    assert!(
        crate::openshell_client::storage_driver_config(&mounts)
            .unwrap()
            .is_some(),
        "renderer could not prove namespace-scoped source"
    );
    let material = synthetic();
    let address = import_address(&fixture.binding());
    carrier
        .import("sandbox-one", &address, &memory_original(&material))
        .unwrap();
    let destination = fixture.volume.join(&fixture.leaf);
    let mut reader = observe_backend(&namespace, || {
        bind_fixture_path(&source, &destination);
        let target = CString::new(destination.as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe {
                libc::mount(
                    std::ptr::null(),
                    target.as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY,
                    std::ptr::null(),
                )
            },
            0,
            "backend read-only bind failed"
        );
        File::open(&destination).unwrap()
    });
    let before = reader.metadata().unwrap();
    let mut actual = Vec::new();
    reader.read_to_end(&mut actual).unwrap();
    assert!(
        actual == material,
        "backend view did not receive exact material"
    );
    let replacement = synthetic()[..17].to_vec();
    carrier
        .rewrite("sandbox-one", &address, &memory_original(&replacement))
        .unwrap();
    use std::io::{Seek, SeekFrom};
    reader.seek(SeekFrom::Start(0)).unwrap();
    actual.clear();
    reader.read_to_end(&mut actual).unwrap();
    assert!(
        actual == replacement,
        "caller rewrite did not update backend inode"
    );
    assert_eq!(
        (before.dev(), before.ino()),
        (
            reader.metadata().unwrap().dev(),
            reader.metadata().unwrap().ino()
        ),
        "backend inode replaced"
    );
    drop(reader);
    observe_backend(&namespace, || {
        let target = CString::new(destination.as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe { libc::umount2(target.as_ptr(), 0) },
            0,
            "backend bind cleanup unproved"
        );
    });
    assert!(
        fs::read(&destination).unwrap().is_empty(),
        "backend carrier wrote retained bytes"
    );
    drop(mounts);
    carrier.remove_after_absence().unwrap();
    assert!(
        observe_backend(&namespace, || !source.exists()),
        "backend carrier survived proved removal"
    );
    assert!(
        fs::read_to_string("/proc/thread-self/mountinfo").unwrap() == caller_mounts,
        "carrier management changed caller mount topology"
    );
}

#[test]
#[ignore = "explicit qualification: isolated user/mount/PID namespaces; prior-domain absence recovery"]
fn credential_carrier_qualified_fenced_recovery_handles_namespace_loss_and_partial_allocation() {
    qualification_root();
    for namespace_lost in [false, true] {
        let fixture = Fixture::new();
        let run_root = fixture.root.join("epoch");
        fs::create_dir(&run_root).unwrap();
        fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
        let namespace = namespace_lost.then(earlier_backend_namespace);
        let args = (
            vec![fixture.binding()],
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            fixture.prepare(fixture.binding()).unwrap(),
        );
        let mut carrier = match namespace.as_ref() {
            Some(namespace) => CredentialCarrier::create_in_namespace(
                Arc::clone(namespace),
                &run_root,
                "sandbox-one",
                args.0,
                args.1,
                args.2,
                args.3,
            ),
            None => {
                CredentialCarrier::create(&run_root, "sandbox-one", args.0, args.1, args.2, args.3)
            }
        }
        .unwrap();
        carrier
            .import(
                "sandbox-one",
                &import_address(&fixture.binding()),
                &memory_original(&synthetic()),
            )
            .unwrap();
        let carrier_root = carrier.mounts()[0].source.parent().unwrap().to_path_buf();
        drop(carrier);
        drop(namespace);
        if namespace_lost {
            assert!(
                carrier_root.is_dir() && fs::read_dir(&carrier_root).unwrap().next().is_none(),
                "namespace loss did not leave an empty underlying directory"
            );
        }
        crate::credential_carrier::remove_fenced_epoch_carriers(&run_root).unwrap();
        assert!(!carrier_root.exists(), "fenced carrier residue survived");
    }
    for case in [
        "empty-partial",
        "nonempty",
        "symlink",
        "foreign-mode",
        "foreign-mount",
    ] {
        let fixture = Fixture::new();
        let run_root = fixture.root.join("epoch");
        fs::create_dir(&run_root).unwrap();
        fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
        let generated = run_root.join(format!("credentials-{:x}", Sha256::digest(component())));
        if case == "symlink" {
            symlink(&fixture.volume, &generated).unwrap();
        } else {
            fs::create_dir(&generated).unwrap();
            fs::set_permissions(
                &generated,
                fs::Permissions::from_mode(if case == "foreign-mode" { 0o755 } else { 0o700 }),
            )
            .unwrap();
        }
        let original = synthetic();
        if case == "nonempty" {
            fs::write(generated.join("preserve"), &original).unwrap();
        }
        if case == "foreign-mount" {
            let target = CString::new(generated.as_os_str().as_bytes()).unwrap();
            assert_eq!(
                unsafe {
                    libc::mount(
                        c"tmpfs".as_ptr(),
                        target.as_ptr(),
                        c"tmpfs".as_ptr(),
                        0,
                        std::ptr::null(),
                    )
                },
                0,
                "foreign fixture mount failed"
            );
        }
        let result = crate::credential_carrier::remove_fenced_epoch_carriers(&run_root);
        if case == "empty-partial" {
            assert!(
                result.is_ok() && !generated.exists(),
                "empty allocation residue refused"
            );
        } else {
            assert!(result.is_err(), "unproved residue cleanup admitted");
            assert!(
                fs::symlink_metadata(&generated).is_ok(),
                "refused residue was removed"
            );
            if case == "nonempty" {
                assert!(
                    fs::read(generated.join("preserve")).unwrap() == original,
                    "refused recovery changed bytes"
                );
            }
        }
        if case == "foreign-mount" {
            let target = CString::new(generated.as_os_str().as_bytes()).unwrap();
            assert_eq!(
                unsafe { libc::umount2(target.as_ptr(), 0) },
                0,
                "foreign fixture teardown unproved"
            );
        }
    }
}

/// A stale request cannot replace the current generation, even when its material is verified.
#[test]
#[ignore = "explicit qualification: isolated namespaces; exact live-generation comparison"]
fn credential_carrier_qualified_replace_compares_receipt_before_same_inode_write() {
    use std::io::{Seek, SeekFrom};
    qualification_root();
    let fixture = Fixture::new();
    let run_root = fixture.root.join("epoch");
    fs::create_dir(&run_root).unwrap();
    fs::set_permissions(&run_root, fs::Permissions::from_mode(0o700)).unwrap();
    let binding = fixture.binding();
    let address = import_address(&binding);
    let initial_receipt = format!("{:x}", Sha256::digest(binding.receipt_id.as_bytes()));
    let successor = format!("{:x}", Sha256::digest(component()));
    let following = format!("{:x}", Sha256::digest(component()));
    let stale = format!("{:x}", Sha256::digest(component()));
    let mut carrier = CredentialCarrier::create(
        &run_root,
        "sandbox-one",
        vec![binding],
        unsafe { libc::geteuid() },
        unsafe { libc::getegid() },
        fixture.prepare(fixture.binding()).unwrap(),
    )
    .unwrap();
    let original = synthetic();
    let replacement = synthetic()[..17].to_vec();
    let later = synthetic()[..9].to_vec();
    assert!(
        carrier
            .replace(
                "sandbox-one",
                &address,
                &initial_receipt,
                &successor,
                &memory_original(&replacement)
            )
            .is_err(),
        "undelivered generation replaced"
    );
    carrier
        .import("sandbox-one", &address, &memory_original(&original))
        .unwrap();
    let mounts = carrier.mounts();
    let source = mounts[0].source.clone();
    let destination = fixture.volume.join(&fixture.leaf);
    bind_fixture_path(&source, &destination);
    let target = CString::new(destination.as_os_str().as_bytes()).unwrap();
    assert_eq!(
        unsafe {
            libc::mount(
                std::ptr::null(),
                target.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY,
                std::ptr::null(),
            )
        },
        0
    );
    let view = BoundView(destination.clone());
    let mut reader = File::open(&destination).unwrap();
    let inode = reader.metadata().unwrap();
    let mountinfo = fs::read_to_string("/proc/thread-self/mountinfo").unwrap();
    for (expected, next, material, should_accept, observed) in [
        (&stale, &successor, &replacement, false, &original),
        (
            &initial_receipt,
            &successor,
            &replacement,
            true,
            &replacement,
        ),
        (&initial_receipt, &following, &later, false, &replacement),
        (&successor, &successor, &later, false, &replacement),
        (&successor, &following, &later, true, &later),
        (&successor, &following, &original, false, &later),
    ] {
        let result = carrier.replace(
            "sandbox-one",
            &address,
            expected,
            next,
            &memory_original(material),
        );
        assert_eq!(
            result.is_ok(),
            should_accept,
            "receipt comparison did not control replacement"
        );
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut actual = Vec::new();
        reader.read_to_end(&mut actual).unwrap();
        assert!(
            actual == *observed,
            "replacement or refusal changed the wrong bytes"
        );
        let after = reader.metadata().unwrap();
        assert_eq!(
            (inode.dev(), inode.ino()),
            (after.dev(), after.ino()),
            "replacement changed inode"
        );
        assert!(
            fs::read_to_string("/proc/thread-self/mountinfo").unwrap() == mountinfo,
            "replacement changed mount topology"
        );
        let write = fs::OpenOptions::new().write(true).open(&destination);
        assert!(
            write.is_err_and(|error| error.raw_os_error() == Some(libc::EROFS)),
            "replacement lost read-only protection"
        );
    }
    drop(reader);
    drop(view);
    assert!(
        fs::read(&destination).unwrap().is_empty(),
        "replacement reached retained mount point"
    );
    drop(mounts);
    carrier.remove_after_absence().unwrap();
    assert!(!source.exists(), "replacement carrier survived removal");
}
