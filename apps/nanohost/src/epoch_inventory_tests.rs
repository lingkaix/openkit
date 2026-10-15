//! Contract tests for owned member observations in private invalidation reports.
//!
//! Fixtures own their processes and files. Expected process facts come directly
//! from the kernel, not from the inventory producer or installed pathnames.

#![cfg(target_os = "linux")]

use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::epoch_coordinator::InventoryMonitorFixture;

static NEXT_ROOT: AtomicUsize = AtomicUsize::new(0);

/// Reaps fixture children on failure until the actual monitor takes ownership.
struct ReapChildren(Vec<Child>);

impl ReapChildren {
    fn take(mut self) -> Vec<Child> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for ReapChildren {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
        }
        for child in &mut self.0 {
            let _ = child.wait();
        }
    }
}

#[test]
fn epoch_inventory_real_monitor_exports_owned_members() {
    let fixture = LocalInventory::new();
    let children = ReapChildren((0..4).map(|index| fixture.sleep_member(index)).collect());
    let pids: Vec<_> = children.0.iter().map(Child::id).collect();
    let images: Vec<_> = pids.iter().map(|pid| live_image_identity(*pid)).collect();
    let cgroups: Vec<_> = pids.iter().map(|pid| live_cgroup_identity(*pid)).collect();
    std::fs::write(
        fixture.root.join("replacement"),
        b"new installed image bytes",
    )
    .unwrap();
    std::fs::rename(
        fixture.root.join("replacement"),
        fixture.root.join("private-member-3"),
    )
    .unwrap();
    let installed = std::fs::metadata(fixture.root.join("private-member-3")).unwrap();
    assert_ne!(images[3]["inode"], json!(installed.ino()));
    let mut monitor = InventoryMonitorFixture::start(children.take(), &fixture.root, None, None);
    monitor.fence();
    let report = read_report(&fixture.root.join("reports"));
    assert!(
        report["fields"]["members"].is_string(),
        "actual monitor report omitted the effect-capable member inventory: {report}"
    );
    let rows = members(&report, &pids);
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(row["binary"], images[index]);
        assert_eq!(row["cgroup"], cgroups[index]);
        assert_eq!(row["status"], json!({"state":"running"}));
    }
    assert_eq!(report["complete"], true);
    assert_private(&report, &fixture.root);
}

/// Owns one isolated report root; the monitor separately owns transferred children.
struct LocalInventory {
    root: PathBuf,
}

impl LocalInventory {
    /// Uses the caller's private disk-backed TMPDIR and no installed paths.
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "openkit-inventory-okt_inventory_fixture-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }

    /// Starts a uniquely installed real image, with deliberately private path text.
    fn sleep_member(&self, ordinal: usize) -> Child {
        let image = self.root.join(format!("private-member-{ordinal}"));
        std::fs::copy("/bin/sleep", &image).unwrap();
        Command::new(image).arg("60").spawn().unwrap()
    }

    /// Starts a real child whose observed exit code is controlled through stdin.
    fn exit_member(&self, ordinal: usize) -> (Child, ChildStdin) {
        let image = self.root.join(format!("private-member-{ordinal}"));
        std::fs::copy("/bin/sh", &image).unwrap();
        let mut child = Command::new(image)
            .args(["-c", "read result; exit \"$result\""])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        (child, input)
    }
}

impl Drop for LocalInventory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Reads exact live executable metadata without hashing or executing the image.
fn live_image_identity(pid: u32) -> Value {
    let metadata = std::fs::metadata(format!("/proc/{pid}/exe")).unwrap();
    json!({"device":metadata.dev(),"inode":metadata.ino(),"size":metadata.size()})
}

/// Resolves actual unified membership independently, without exporting its path.
fn live_cgroup_identity(pid: u32) -> Value {
    let resolve = || -> Option<Value> {
        let membership = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
        let lines: Vec<_> = membership.lines().collect();
        if lines.len() != 1 {
            return None;
        }
        let path = lines[0].strip_prefix("0::")?;
        if !path.starts_with('/') || path.split('/').any(|part| matches!(part, "." | "..")) {
            return None;
        }
        let mounts = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
        let (root, mount) = mounts.lines().find_map(|line| {
            let (left, right) = line.split_once(" - ")?;
            if right.split_whitespace().next()? != "cgroup2" {
                return None;
            }
            let fields: Vec<_> = left.split_whitespace().collect();
            Some((*fields.get(3)?, *fields.get(4)?))
        })?;
        let decode = |value: &str| {
            value
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\")
        };
        let root = PathBuf::from(decode(root));
        if root != Path::new("/") || decode(mount) != "/sys/fs/cgroup" {
            return None;
        }
        let relative = Path::new(path).strip_prefix(root).ok()?;
        let mut resolved = PathBuf::from(decode(mount));
        let mount_file = std::fs::File::open(&resolved).ok()?;
        let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: the descriptor is open and fstatfs receives allocated output storage.
        if unsafe { libc::fstatfs(mount_file.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: successful fstatfs initialized the complete result.
        if unsafe { filesystem.assume_init() }.f_type as u64 != 0x6367_7270 {
            return None;
        }
        for part in relative.components() {
            let std::path::Component::Normal(part) = part else {
                return None;
            };
            resolved.push(part);
            let metadata = std::fs::symlink_metadata(&resolved).ok()?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return None;
            }
        }
        let metadata = std::fs::metadata(resolved).ok()?;
        Some(json!({"device":metadata.dev(),"inode":metadata.ino()}))
    };
    resolve().unwrap_or_else(|| json!("unavailable"))
}

/// Reads the actual private report artifact after the monitor has exported it.
fn read_report(root: &Path) -> Value {
    let paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(
        paths.len(),
        1,
        "one invalidation must produce exactly one report"
    );
    serde_json::from_slice(&std::fs::read(&paths[0]).unwrap()).unwrap()
}

/// Checks fixed start order and PID ownership before interpreting member facts.
fn members(report: &Value, pids: &[u32]) -> Vec<Value> {
    let rows: Vec<Value> = serde_json::from_str(
        report["fields"]["members"]
            .as_str()
            .expect("private members field"),
    )
    .unwrap();
    assert_eq!(rows.len(), pids.len());
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(
            row["role"],
            ["containerd", "slirp4netns", "dockerd", "openshell-gateway"][index]
        );
        assert_eq!(row["pid"], pids[index]);
        assert_eq!(
            row["version"], "unavailable",
            "fixture images have no proved stock version"
        );
    }
    rows
}

/// Rejects private path and command material in the actual exported artifact.
fn assert_private(report: &Value, root: &Path) {
    let encoded = report.to_string();
    for forbidden in [
        root.to_str().unwrap(),
        "private-member",
        "/bin/sleep",
        "/bin/sh",
        "read result",
        "okt_inventory_fixture",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "report leaked private observation text"
        );
    }
}

/// Waits only for a named own-process or export event under a fixed test bound.
fn wait_for(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Sends a signal only to a still-owned fixture child, never an installed member.
fn signal_child(pid: u32, signal: i32) {
    // SAFETY: each caller retains this child through the production monitor.
    assert_eq!(unsafe { libc::kill(pid as i32, signal) }, 0);
}

#[test]
fn epoch_inventory_preserves_real_exit_code_and_first_cause_after_later_signal() {
    let fixture = LocalInventory::new();
    let (exiting, mut input) = fixture.exit_member(2);
    let children = ReapChildren(vec![
        fixture.sleep_member(0),
        fixture.sleep_member(1),
        exiting,
        fixture.sleep_member(3),
    ]);
    let pids: Vec<_> = children.0.iter().map(Child::id).collect();
    let later_pid = pids[0];
    let after_cause = Arc::new(move || {
        signal_child(later_pid, libc::SIGTERM);
        wait_for("later child signal", || {
            std::fs::read_link(format!("/proc/{later_pid}/exe")).is_err()
        });
    });
    let monitor =
        InventoryMonitorFixture::start(children.take(), &fixture.root, Some(after_cause), None);
    input.write_all(b"7\n").unwrap();
    assert_eq!(
        monitor.failure(Duration::from_secs(3)).as_deref(),
        Some("subject=dockerd;observation=exit-code;code=7")
    );
    let report = read_report(&fixture.root.join("reports"));
    assert_eq!(report["trigger"], "member-exit");
    assert_eq!(
        report["fields"]["failed_member"],
        "subject=dockerd;observation=exit-code;code=7"
    );
    let rows = members(&report, &pids);
    assert_eq!(rows[2]["status"], json!({"state":"exited","code":7}));
    assert_eq!(rows[2]["binary"], "unavailable");
    assert_eq!(rows[2]["cgroup"], "unavailable");
    assert_eq!(rows[1]["status"], json!({"state":"running"}));
    assert_eq!(rows[3]["status"], json!({"state":"running"}));
    assert_private(&report, &fixture.root);
}

#[test]
fn epoch_inventory_distinguishes_real_signal_from_still_running_members() {
    let fixture = LocalInventory::new();
    let children = ReapChildren((0..4).map(|index| fixture.sleep_member(index)).collect());
    let pids: Vec<_> = children.0.iter().map(Child::id).collect();
    let monitor = InventoryMonitorFixture::start(children.take(), &fixture.root, None, None);
    signal_child(pids[1], libc::SIGTERM);
    assert_eq!(
        monitor.failure(Duration::from_secs(3)).as_deref(),
        Some("subject=slirp4netns;observation=signal;signal=15")
    );
    let report = read_report(&fixture.root.join("reports"));
    let rows = members(&report, &pids);
    assert_eq!(rows[1]["status"], json!({"state":"signaled","signal":15}));
    for index in [0, 2, 3] {
        assert_eq!(rows[index]["status"], json!({"state":"running"}));
    }
    assert_private(&report, &fixture.root);
}

#[test]
fn epoch_inventory_reports_missing_os_proof_without_invented_identity() {
    let fixture = LocalInventory::new();
    let (mut child, mut input) = fixture.exit_member(0);
    let pid = child.id();
    input.write_all(b"3\n").unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(3));
    assert!(!Path::new(&format!("/proc/{pid}/exe")).exists());
    let monitor = InventoryMonitorFixture::start(vec![child], &fixture.root, None, None);
    assert_eq!(
        monitor.failure(Duration::from_secs(3)).as_deref(),
        Some("subject=containerd;observation=exit-code;code=3")
    );
    let report = read_report(&fixture.root.join("reports"));
    let rows = members(&report, &[pid]);
    assert_eq!(rows[0]["binary"], "unavailable");
    assert_eq!(rows[0]["cgroup"], "unavailable");
    assert_eq!(rows[0]["status"], json!({"state":"exited","code":3}));
    assert_private(&report, &fixture.root);
}

/// Starts a live child whose own stdin can request same-PID executable replacement.
fn exec_member(fixture: &LocalInventory) -> (Child, ChildStdin) {
    let image = fixture.root.join("private-member-0");
    std::fs::copy("/bin/sh", &image).unwrap();
    let mut child = Command::new(image)
        .args(["-c", "read result; exec /bin/sleep 60"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    (child, input)
}

#[test]
fn epoch_inventory_measures_current_exec_without_a_stale_startup_identity() {
    let fixture = LocalInventory::new();
    let (child, mut input) = exec_member(&fixture);
    let pid = child.id();
    let children = ReapChildren(vec![child]);
    let before = live_image_identity(pid);
    let mut monitor = InventoryMonitorFixture::start(children.take(), &fixture.root, None, None);
    input.write_all(b"replace\n").unwrap();
    wait_for("same-PID exec", || live_image_identity(pid) != before);
    let current = live_image_identity(pid);
    monitor.fence();
    let report = read_report(&fixture.root.join("reports"));
    let rows = members(&report, &[pid]);
    assert_eq!(rows[0]["binary"], current);
    assert_ne!(rows[0]["binary"], before);
    assert_eq!(rows[0]["status"], json!({"state":"running"}));
    assert_private(&report, &fixture.root);
}

#[test]
fn epoch_inventory_rejects_exec_replacement_during_measurement() {
    let fixture = LocalInventory::new();
    let (child, input) = exec_member(&fixture);
    let pid = child.id();
    let children = ReapChildren(vec![child]);
    let before = live_image_identity(pid);
    let input = Mutex::new(input);
    let replace = Arc::new(move || {
        input.lock().unwrap().write_all(b"replace\n").unwrap();
        wait_for("in-measurement exec", || live_image_identity(pid) != before);
    });
    let mut monitor =
        InventoryMonitorFixture::start(children.take(), &fixture.root, None, Some(replace));
    monitor.fence();
    let report = read_report(&fixture.root.join("reports"));
    let rows = members(&report, &[pid]);
    assert_eq!(rows[0]["binary"], "unavailable");
    assert_eq!(rows[0]["cgroup"], "unavailable");
    assert_eq!(rows[0]["status"], json!({"state":"running"}));
    assert_private(&report, &fixture.root);
}

/// Holds only the evidence worker while the production fence deadline advances.
#[derive(Default)]
struct ExportGate {
    entered: AtomicUsize,
    released: Mutex<bool>,
    changed: Condvar,
}

impl ExportGate {
    fn block(&self) {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

struct ReleaseExport(Arc<ExportGate>);
impl Drop for ReleaseExport {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[test]
fn epoch_inventory_export_timeout_never_delays_the_fence() {
    let fixture = LocalInventory::new();
    let child = fixture.sleep_member(0);
    let pid = child.id();
    let gate = Arc::new(ExportGate::default());
    let _release = ReleaseExport(gate.clone());
    let blocked = gate.clone();
    let mut monitor = InventoryMonitorFixture::start(
        vec![child],
        &fixture.root,
        Some(Arc::new(move || blocked.block())),
        None,
    );
    let started = Instant::now();
    let worker = std::thread::spawn(move || monitor.fence());
    wait_for("actual export attempt", || {
        gate.entered.load(Ordering::SeqCst) == 1
    });
    assert!(
        std::fs::read_link(format!("/proc/{pid}/exe")).is_ok(),
        "member was fenced before its report export began"
    );
    wait_for("bounded fence despite blocked export", || {
        worker.is_finished()
    });
    worker.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "evidence I/O exceeded the existing two-second fence allowance"
    );
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "the fence did not reap its owned child"
    );
    gate.release();
    wait_for("late incomplete report", || {
        std::fs::read_dir(fixture.root.join("reports"))
            .unwrap()
            .any(|entry| {
                let Ok(entry) = entry else {
                    return false;
                };
                std::fs::read(entry.path())
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some()
            })
    });
    let report = read_report(&fixture.root.join("reports"));
    assert_eq!(
        report["complete"], false,
        "an export that exceeded its deadline claimed completeness"
    );
    assert_private(&report, &fixture.root);
}
