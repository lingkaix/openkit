//! Refuses a NanoHost start until the previous failure group is gone.
//!
//! The service manager can signal the slice before this process is exec'd.
//! That signal is not termination. This module reads the kernel cgroup state
//! after session-input validation and before evidence, recovery, the Image
//! Store, the Runtime Epoch, the backend, the Gateway, or a network effect.
//! A refusal prints one fixed cause and returns a restartable error so
//! `ExecStopPost=` repeats the slice signal and systemd tries again.

use std::fs;
use std::path::Path;

const SERVICE_NAME: &str = "openkit-nanohost.service";
const SLICE_NAME: &str = "openkit-nanohost.slice";

const UNREADABLE: &str = "nanohost failure group unreadable";
const PLACEMENT: &str = "nanohost cgroup placement rejected";
const OCCUPIED: &str = "nanohost service cgroup occupied";
const POPULATED: &str = "nanohost slice subtree populated";

/// Requires this process to be the only one in its service cgroup and every
/// other child of the slice to report `populated 0`.
///
/// `cgroup_mount` is the cgroup v2 mount, normally `/sys/fs/cgroup`.
/// `self_cgroup_path` is normally `/proc/self/cgroup`. `self_pid` is this
/// process. One hierarchy-0 `/proc/self/cgroup` line is the unified v2
/// statement. The returned causes are fixed and carry no path or pid.
///
/// # Errors
///
/// Returns a static cause when the cgroup cannot be read, this process is not
/// directly in `openkit-nanohost.service` under `openkit-nanohost.slice`, the
/// service cgroup contains any other process, or a sibling does not report
/// `populated 0`. `populated 0` covers that sibling's whole subtree.
pub(super) fn require_previous_failure_group_gone(
    cgroup_mount: &Path,
    self_cgroup_path: &Path,
    self_pid: u32,
) -> Result<(), &'static str> {
    let text = fs::read_to_string(self_cgroup_path).map_err(|_| UNREADABLE)?;
    let relative = service_cgroup_relative(&text)?;
    let service_dir = cgroup_mount.join(relative);
    require_only_self(&service_dir, self_pid)?;
    require_siblings_unpopulated(&service_dir)
}

/// Parses the single unified-v2 cgroup line into a mount-relative service path.
fn service_cgroup_relative(text: &str) -> Result<&str, &'static str> {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(line) = lines.next() else {
        return Err(PLACEMENT);
    };
    if lines.next().is_some() {
        return Err(PLACEMENT);
    }
    let Some(path) = line.strip_prefix("0::") else {
        return Err(PLACEMENT);
    };
    if !path.starts_with('/') {
        return Err(PLACEMENT);
    }
    let mut previous = None;
    let mut last = None;
    for component in path.split('/').filter(|component| !component.is_empty()) {
        if component == "." || component == ".." {
            return Err(PLACEMENT);
        }
        previous = last;
        last = Some(component);
    }
    if previous != Some(SLICE_NAME) || last != Some(SERVICE_NAME) {
        return Err(PLACEMENT);
    }
    Ok(path.trim_start_matches('/'))
}

/// Requires `cgroup.procs` to name exactly this process.
fn require_only_self(service_dir: &Path, self_pid: u32) -> Result<(), &'static str> {
    let text = fs::read_to_string(service_dir.join("cgroup.procs")).map_err(|_| UNREADABLE)?;
    let mut seen = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let pid = line.parse::<u32>().map_err(|_| UNREADABLE)?;
        seen.push(pid);
    }
    if seen.len() != 1 || seen[0] != self_pid {
        return Err(OCCUPIED);
    }
    Ok(())
}

/// Requires every other direct child of the slice to report `populated 0`.
fn require_siblings_unpopulated(service_dir: &Path) -> Result<(), &'static str> {
    let slice_dir = service_dir.parent().ok_or(UNREADABLE)?;
    let entries = fs::read_dir(slice_dir).map_err(|_| UNREADABLE)?;
    for entry in entries {
        let entry = entry.map_err(|_| UNREADABLE)?;
        if entry.file_name() == SERVICE_NAME {
            continue;
        }
        if !entry.file_type().map_err(|_| UNREADABLE)?.is_dir() {
            continue;
        }
        let events =
            fs::read_to_string(entry.path().join("cgroup.events")).map_err(|_| UNREADABLE)?;
        let mut populated = None;
        for line in events.lines() {
            let Some(value) = line.trim().strip_prefix("populated ") else {
                continue;
            };
            if populated.is_some() {
                return Err(POPULATED);
            }
            populated = Some(value);
        }
        if populated != Some("0") {
            return Err(POPULATED);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{OCCUPIED, PLACEMENT, POPULATED, UNREADABLE, require_previous_failure_group_gone};

    struct Tree(PathBuf);

    impl Tree {
        fn new() -> Self {
            static COUNT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "nanohost-start-barrier-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).expect("fixture root");
            Self(root)
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const RELATIVE: &str = "openkit.slice/openkit-nanohost.slice/openkit-nanohost.service";
    const SELF_CGROUP: &str = "0::/openkit.slice/openkit-nanohost.slice/openkit-nanohost.service\n";
    const PID: u32 = 4242;

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("fixture parent");
        }
        fs::write(path, body).expect("fixture file");
    }

    fn ready(tree: &Tree) {
        write(&tree.0.join("self-cgroup"), SELF_CGROUP);
        write(
            &tree.0.join("cgroup").join(RELATIVE).join("cgroup.procs"),
            "4242\n",
        );
    }

    fn observe(tree: &Tree) -> Result<(), &'static str> {
        require_previous_failure_group_gone(
            &tree.0.join("cgroup"),
            &tree.0.join("self-cgroup"),
            PID,
        )
    }

    #[test]
    fn own_cgroup_outside_the_slice_is_rejected() {
        let tree = Tree::new();
        write(
            &tree.0.join("self-cgroup"),
            "0::/system.slice/openkit-nanohost.service\n",
        );
        assert_eq!(observe(&tree), Err(PLACEMENT));
    }

    #[test]
    fn extra_process_in_own_cgroup_is_rejected() {
        let tree = Tree::new();
        ready(&tree);
        write(
            &tree.0.join("cgroup").join(RELATIVE).join("cgroup.procs"),
            "4242\n99\n",
        );
        assert_eq!(observe(&tree), Err(OCCUPIED));
    }

    #[test]
    fn populated_sibling_is_rejected() {
        let tree = Tree::new();
        ready(&tree);
        write(
            &tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope/cgroup.events"),
            "populated 1\nfrozen 0\n",
        );
        assert_eq!(observe(&tree), Err(POPULATED));
    }

    #[test]
    fn unpopulated_siblings_pass() {
        let tree = Tree::new();
        ready(&tree);
        write(
            &tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope/cgroup.events"),
            "populated 0\nfrozen 0\n",
        );
        write(
            &tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/cgroup.procs"),
            "",
        );
        assert_eq!(observe(&tree), Ok(()));
    }

    #[test]
    fn unreadable_file_is_rejected() {
        let tree = Tree::new();
        write(&tree.0.join("self-cgroup"), SELF_CGROUP);
        assert_eq!(observe(&tree), Err(UNREADABLE));
    }
}
