//! Proves the previous failure group gone before admitting a NanoHost start.
//!
//! The service manager can signal the slice before this process is exec'd.
//! That signal is not termination.
//! This module reads the kernel cgroup state after session-input validation and before evidence, recovery, the Image Store, the Runtime Epoch, the backend, the Gateway, or a network effect.
//! Admission requires proof that existing siblings report `populated 0` or a sibling directory is proved removed; only readable, well-formed population may wait for a bounded drain, and every other refusal is immediate.
//! A refusal prints one fixed cause and returns a restartable error so `ExecStopPost=` repeats the slice signal and systemd tries again.

use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

const SERVICE_NAME: &str = "openkit-nanohost.service";
const SLICE_NAME: &str = "openkit-nanohost.slice";

const UNREADABLE: &str = "nanohost failure group unreadable";
const PLACEMENT: &str = "nanohost cgroup placement rejected";
const OCCUPIED: &str = "nanohost service cgroup occupied";
const POPULATED: &str = "nanohost slice subtree populated";

// SIGKILL has already been sent: allow the same five seconds as the observed successful RestartSec retry, well below TimeoutStopSec=30s.
// Poll at the existing 50-ms member-observation cadence to prove drain promptly without busy polling; elapsed time alone never admits a start.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Requires this process to be the only one in its service cgroup and proof that existing siblings report `populated 0` or a sibling directory is proved removed.
///
/// `cgroup_mount` is the cgroup v2 mount, normally `/sys/fs/cgroup`.
/// `self_cgroup_path` is normally `/proc/self/cgroup`; `self_pid` is this process.
/// One hierarchy-0 `/proc/self/cgroup` line is the unified v2 statement.
/// Readable, well-formed siblings with at least one `populated 1` are re-observed for at most five seconds, including placement and only-self checks.
/// The returned causes are fixed and carry no path or pid, and this wait never touches a rebuild marker.
///
/// # Errors
///
/// Immediately returns a static cause when a cgroup cannot be read, this process is not directly in `openkit-nanohost.service` under `openkit-nanohost.slice`, the service cgroup contains any other process, or a sibling population field is malformed, missing or duplicated.
/// Returns the same populated-subtree cause if a well-formed sibling still reports `populated 1` at the bound.
/// `populated 0` covers that sibling's whole subtree; a missing events file or entry type counts as absence only when metadata proves the sibling directory removed under a still-valid slice.
pub(super) fn require_previous_failure_group_gone(
    cgroup_mount: &Path,
    self_cgroup_path: &Path,
    self_pid: u32,
) -> Result<(), &'static str> {
    let started = Instant::now();
    require_previous_failure_group_gone_with_wait(
        cgroup_mount,
        self_cgroup_path,
        self_pid,
        || started.elapsed(),
        std::thread::sleep,
        |entry| {
            read_sibling_events(&entry.path(), entry.file_type(), |path| {
                fs::symlink_metadata(path)
            })
        },
    )
}

/// Observes the barrier with an injectable elapsed clock, sleeper, and listed-sibling reader.
fn require_previous_failure_group_gone_with_wait(
    cgroup_mount: &Path,
    self_cgroup_path: &Path,
    self_pid: u32,
    elapsed: impl Fn() -> Duration,
    mut sleep: impl FnMut(Duration),
    mut read_sibling: impl FnMut(&fs::DirEntry) -> Result<Option<String>, &'static str>,
) -> Result<(), &'static str> {
    loop {
        let text = fs::read_to_string(self_cgroup_path).map_err(|_| UNREADABLE)?;
        let relative = service_cgroup_relative(&text)?;
        let service_dir = cgroup_mount.join(relative);
        require_only_self(&service_dir, self_pid)?;
        if !observe_siblings_populated(&service_dir, &mut read_sibling)? {
            return Ok(());
        }
        let remaining = DRAIN_TIMEOUT.saturating_sub(elapsed());
        if remaining.is_zero() {
            return Err(POPULATED);
        }
        sleep(DRAIN_POLL_INTERVAL.min(remaining));
    }
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

/// Validates every remaining direct child, requiring proof that existing siblings report `populated 0` or a sibling directory is proved removed, and reports whether any subtree remains populated.
fn observe_siblings_populated(
    service_dir: &Path,
    mut read_sibling: impl FnMut(&fs::DirEntry) -> Result<Option<String>, &'static str>,
) -> Result<bool, &'static str> {
    let slice_dir = service_dir.parent().ok_or(UNREADABLE)?;
    let entries = fs::read_dir(slice_dir).map_err(|_| UNREADABLE)?;
    let mut any_populated = false;
    for entry in entries {
        let entry = entry.map_err(|_| UNREADABLE)?;
        if entry.file_name() == SERVICE_NAME {
            continue;
        }
        let Some(events) = read_sibling(&entry)? else {
            continue;
        };
        let mut populated = None;
        for line in events.lines() {
            let line = line.trim();
            if line.split_whitespace().next() != Some("populated") {
                continue;
            }
            if populated.is_some() {
                return Err(POPULATED);
            }
            populated = Some(line.strip_prefix("populated ").ok_or(POPULATED)?);
        }
        match populated {
            Some("0") => {}
            Some("1") => any_populated = true,
            _ => return Err(POPULATED),
        }
    }
    Ok(any_populated)
}

/// Reads a listed sibling's events or proves it removed, rejecting listed symlinks before ignoring ordinary non-directory interface files.
fn read_sibling_events(
    sibling_dir: &Path,
    entry_type: io::Result<fs::FileType>,
    mut directory_metadata: impl FnMut(&Path) -> io::Result<fs::Metadata>,
) -> Result<Option<String>, &'static str> {
    match entry_type {
        Ok(kind) if kind.is_symlink() => return Err(UNREADABLE),
        Ok(kind) if !kind.is_dir() => return Ok(None),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return require_sibling_removed(sibling_dir, &mut directory_metadata).map(|()| None);
        }
        Err(_) => return Err(UNREADABLE),
    }
    match fs::read_to_string(sibling_dir.join("cgroup.events")) {
        Ok(events) => Ok(Some(events)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            require_sibling_removed(sibling_dir, &mut directory_metadata).map(|()| None)
        }
        Err(_) => Err(UNREADABLE),
    }
}

/// Accepts only positive sibling absence under a still-readable slice directory.
fn require_sibling_removed(
    sibling_dir: &Path,
    mut directory_metadata: impl FnMut(&Path) -> io::Result<fs::Metadata>,
) -> Result<(), &'static str> {
    // In the trusted cgroup-v2 hierarchy, normal removal requires no live population or child groups; a missing core interface alone proves nothing.
    match directory_metadata(sibling_dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let slice_dir = sibling_dir.parent().ok_or(UNREADABLE)?;
            let slice = directory_metadata(slice_dir).map_err(|_| UNREADABLE)?;
            if slice.is_dir() {
                Ok(())
            } else {
                Err(UNREADABLE)
            }
        }
        _ => Err(UNREADABLE),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::io;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use super::{
        OCCUPIED, PLACEMENT, POPULATED, UNREADABLE, read_sibling_events,
        require_previous_failure_group_gone_with_wait,
    };

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
        observe_with_wait(tree, |_| {})
    }

    fn observe_with_wait(tree: &Tree, on_sleep: impl FnMut(Duration)) -> Result<(), &'static str> {
        observe_with_sibling_reader(tree, on_sleep, |entry| {
            read_sibling_events(&entry.path(), entry.file_type(), |path| {
                fs::symlink_metadata(path)
            })
        })
    }

    fn observe_with_sibling_reader(
        tree: &Tree,
        mut on_sleep: impl FnMut(Duration),
        read_sibling: impl FnMut(&fs::DirEntry) -> Result<Option<String>, &'static str>,
    ) -> Result<(), &'static str> {
        let elapsed = Cell::new(Duration::ZERO);
        require_previous_failure_group_gone_with_wait(
            &tree.0.join("cgroup"),
            &tree.0.join("self-cgroup"),
            PID,
            || elapsed.get(),
            |duration| {
                elapsed.set(elapsed.get() + duration);
                on_sleep(duration);
            },
            read_sibling,
        )
    }

    #[test]
    fn own_cgroup_outside_the_slice_is_rejected() {
        let tree = Tree::new();
        write(
            &tree.0.join("self-cgroup"),
            "0::/system.slice/openkit-nanohost.service\n",
        );
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "invalid placement must refuse without waiting"
            )),
            Err(PLACEMENT)
        );
    }

    #[test]
    fn extra_process_in_own_cgroup_is_rejected() {
        let tree = Tree::new();
        ready(&tree);
        write(
            &tree.0.join("cgroup").join(RELATIVE).join("cgroup.procs"),
            "4242\n99\n",
        );
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "extra process must refuse without waiting"
            )),
            Err(OCCUPIED)
        );
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
    fn listed_dangling_symlink_is_rejected_without_waiting() {
        let tree = Tree::new();
        ready(&tree);
        let sibling = tree
            .0
            .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope");
        symlink(tree.0.join("missing-sibling"), sibling).expect("dangling sibling symlink");
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "listed symlink must refuse without waiting"
            )),
            Err(UNREADABLE)
        );
    }

    #[test]
    fn listed_directory_symlink_is_rejected_without_waiting() {
        let tree = Tree::new();
        ready(&tree);
        let target = tree.0.join("linked-sibling");
        write(&target.join("cgroup.events"), "populated 0\n");
        let sibling = tree
            .0
            .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope");
        symlink(target, sibling).expect("directory sibling symlink");
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "listed symlink must refuse without waiting"
            )),
            Err(UNREADABLE)
        );
    }

    #[test]
    fn ordinary_cgroup_interface_file_is_ignored_without_waiting() {
        let tree = Tree::new();
        ready(&tree);
        write(
            &tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/cgroup.events"),
            "populated 1\nfrozen 0\n",
        );
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "interface file must pass without waiting"
            )),
            Ok(())
        );
    }

    #[test]
    fn sibling_removed_after_listing_passes_when_remaining_siblings_are_empty() {
        let tree = Tree::new();
        ready(&tree);
        let slice = tree.0.join("cgroup/openkit.slice/openkit-nanohost.slice");
        write(
            &slice.join("docker-removed.scope/cgroup.events"),
            "populated 0\n",
        );
        write(
            &slice.join("docker-empty.scope/cgroup.events"),
            "populated 0\n",
        );
        let mut removed = false;
        let mut inspected_empty = false;
        let result = observe_with_sibling_reader(
            &tree,
            |_| panic!("proved absence must pass without waiting"),
            |entry| {
                let entry_type = entry.file_type();
                if !removed {
                    fs::remove_dir_all(entry.path())
                        .expect("remove listed sibling before events read");
                    removed = true;
                } else {
                    inspected_empty = true;
                }
                read_sibling_events(&entry.path(), entry_type, |path| fs::symlink_metadata(path))
            },
        );
        assert_eq!(result, Ok(()));
        assert!(
            removed,
            "the listed sibling must exercise the events-read race"
        );
        assert!(inspected_empty, "every remaining sibling must be validated");
    }

    #[test]
    fn sibling_removed_after_listing_keeps_waiting_for_populated_siblings_at_the_bound() {
        let tree = Tree::new();
        ready(&tree);
        let slice = tree.0.join("cgroup/openkit.slice/openkit-nanohost.slice");
        for name in ["docker-abc.scope", "docker-def.scope"] {
            write(&slice.join(name).join("cgroup.events"), "populated 1\n");
        }
        let mut removed = false;
        let mut waited = Duration::ZERO;
        let mut remaining_reads = 0;
        let result = observe_with_sibling_reader(
            &tree,
            |duration| {
                assert_eq!(duration, Duration::from_millis(50));
                waited += duration;
            },
            |entry| {
                let entry_type = entry.file_type();
                if !removed {
                    fs::remove_dir_all(entry.path())
                        .expect("remove listed sibling before events read");
                    removed = true;
                } else {
                    remaining_reads += 1;
                }
                read_sibling_events(&entry.path(), entry_type, |path| fs::symlink_metadata(path))
            },
        );
        assert_eq!(result, Err(POPULATED));
        assert!(removed);
        assert_eq!(
            waited,
            Duration::from_secs(5),
            "removal must not reset the original deadline"
        );
        assert_eq!(
            remaining_reads, 101,
            "validate the remaining sibling on every observation"
        );
    }

    #[test]
    fn sibling_removed_after_listing_keeps_remaining_invalid_siblings_as_immediate_refusals() {
        for body in [Some("populated invalid\n"), None] {
            let tree = Tree::new();
            ready(&tree);
            let slice = tree.0.join("cgroup/openkit.slice/openkit-nanohost.slice");
            for name in ["docker-abc.scope", "docker-def.scope"] {
                let sibling = slice.join(name);
                fs::create_dir_all(&sibling).expect("sibling directory");
                if let Some(body) = body {
                    write(&sibling.join("cgroup.events"), body);
                }
            }
            let mut removed = false;
            let mut inspected_remaining = false;
            let result = observe_with_sibling_reader(
                &tree,
                |_| panic!("invalid remaining sibling must refuse without waiting"),
                |entry| {
                    let entry_type = entry.file_type();
                    if !removed {
                        fs::remove_dir_all(entry.path())
                            .expect("remove listed sibling before events read");
                        removed = true;
                    } else {
                        inspected_remaining = true;
                    }
                    read_sibling_events(&entry.path(), entry_type, |path| {
                        fs::symlink_metadata(path)
                    })
                },
            );
            assert_eq!(
                result,
                Err(if body.is_some() {
                    POPULATED
                } else {
                    UNREADABLE
                })
            );
            assert!(removed);
            assert!(
                inspected_remaining,
                "removal cannot skip subsequent validation"
            );
        }
    }

    #[test]
    fn sibling_directory_metadata_errors_are_immediate_refusals() {
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Other] {
            let tree = Tree::new();
            ready(&tree);
            let sibling = tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope");
            write(&sibling.join("cgroup.events"), "populated 0\n");
            let mut checked_directory = false;
            let result = observe_with_sibling_reader(
                &tree,
                |_| panic!("metadata uncertainty must refuse without waiting"),
                |entry| {
                    let entry_type = entry.file_type();
                    fs::remove_dir_all(entry.path())
                        .expect("remove listed sibling before events read");
                    read_sibling_events(&entry.path(), entry_type, |path| {
                        assert_eq!(path, sibling);
                        checked_directory = true;
                        Err(io::Error::from(kind))
                    })
                },
            );
            assert_eq!(result, Err(UNREADABLE));
            assert!(
                checked_directory,
                "missing events must check the sibling directory"
            );
        }
    }

    #[test]
    fn entry_type_not_found_requires_proved_sibling_removal_under_a_valid_slice() {
        for (remove_sibling, remove_slice) in [(true, false), (false, false), (true, true)] {
            let tree = Tree::new();
            ready(&tree);
            let sibling = tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope");
            write(&sibling.join("cgroup.events"), "populated 0\n");
            let mut inspected = false;
            let result = observe_with_sibling_reader(
                &tree,
                |_| panic!("entry-type disappearance must settle without waiting"),
                |entry| {
                    inspected = true;
                    if remove_slice {
                        fs::remove_dir_all(entry.path().parent().expect("slice directory"))
                            .expect("remove slice after listing");
                    } else if remove_sibling {
                        fs::remove_dir_all(entry.path()).expect("remove sibling after listing");
                    }
                    // DirEntry may cache its file type on this platform; inject the lookup's NotFound after obtaining the actual entry.
                    read_sibling_events(
                        &entry.path(),
                        Err(io::Error::from(io::ErrorKind::NotFound)),
                        |path| fs::symlink_metadata(path),
                    )
                },
            );
            assert_eq!(
                result,
                if remove_sibling && !remove_slice {
                    Ok(())
                } else {
                    Err(UNREADABLE)
                }
            );
            assert!(inspected);
        }
    }

    #[test]
    fn populated_sibling_drains_within_the_bound() {
        let tree = Tree::new();
        ready(&tree);
        let events = tree
            .0
            .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope/cgroup.events");
        let other_events = tree
            .0
            .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-def.scope/cgroup.events");
        write(&events, "populated 1\nfrozen 0\n");
        write(&other_events, "populated 1\nfrozen 0\n");
        let mut waits = 0;
        let result = observe_with_wait(&tree, |duration| {
            assert_eq!(duration, Duration::from_millis(50));
            waits += 1;
            if waits == 1 {
                write(&events, "populated 0\nfrozen 0\n");
            }
            if waits == 3 {
                write(&other_events, "populated 0\nfrozen 0\n");
            }
        });
        assert_eq!(result, Ok(()));
        assert_eq!(waits, 3);
    }

    #[test]
    fn populated_sibling_is_rejected_at_the_bound_with_the_same_cause() {
        let tree = Tree::new();
        ready(&tree);
        write(
            &tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope/cgroup.events"),
            "populated 1\nfrozen 0\n",
        );
        let mut waited = Duration::ZERO;
        assert_eq!(
            observe_with_wait(&tree, |duration| {
                assert_eq!(duration, Duration::from_millis(50));
                waited += duration;
            }),
            Err(POPULATED)
        );
        assert_eq!(waited, Duration::from_secs(5));
    }

    #[test]
    fn malformed_or_unreadable_siblings_are_rejected_without_waiting() {
        for body in [
            Some("populated 2\nfrozen 0\n"),
            Some("populated invalid\n"),
            Some("populated\n"),
            Some("frozen 0\n"),
            Some("populated 1\npopulated 0\n"),
            Some("populated 0\npopulated 0\n"),
            Some("populated 1\npopulated\n"),
            Some("populated 1\npopulated\t0\n"),
            None,
        ] {
            let tree = Tree::new();
            ready(&tree);
            write(
                &tree.0.join(
                    "cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope/cgroup.events",
                ),
                "populated 1\nfrozen 0\n",
            );
            let events = tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-def.scope/cgroup.events");
            if let Some(body) = body {
                write(&events, body);
            } else {
                fs::create_dir_all(events.parent().expect("sibling directory"))
                    .expect("unreadable events fixture");
            }
            assert_eq!(
                observe_with_wait(&tree, |_| panic!(
                    "invalid state must refuse without waiting"
                )),
                Err(if body.is_some() {
                    POPULATED
                } else {
                    UNREADABLE
                })
            );
        }
    }

    #[test]
    fn nontransient_refusals_during_drain_stop_the_wait_immediately() {
        for expected in [PLACEMENT, OCCUPIED, POPULATED, UNREADABLE] {
            let tree = Tree::new();
            ready(&tree);
            let events = tree
                .0
                .join("cgroup/openkit.slice/openkit-nanohost.slice/docker-abc.scope/cgroup.events");
            write(&events, "populated 1\nfrozen 0\n");
            let mut waits = 0;
            assert_eq!(
                observe_with_wait(&tree, |_| {
                    waits += 1;
                    assert_eq!(waits, 1, "nontransient refusal must stop further waiting");
                    match expected {
                        PLACEMENT => write(
                            &tree.0.join("self-cgroup"),
                            "0::/system.slice/openkit-nanohost.service\n",
                        ),
                        OCCUPIED => write(
                            &tree.0.join("cgroup").join(RELATIVE).join("cgroup.procs"),
                            "4242\n99\n",
                        ),
                        POPULATED => write(&events, "populated 1\npopulated 0\n"),
                        UNREADABLE => fs::remove_file(&events).expect("remove sibling observation"),
                        _ => unreachable!(),
                    }
                }),
                Err(expected)
            );
            assert_eq!(waits, 1);
        }
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
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "empty siblings must pass without waiting"
            )),
            Ok(())
        );
    }

    #[test]
    fn unreadable_file_is_rejected() {
        let tree = Tree::new();
        write(&tree.0.join("self-cgroup"), SELF_CGROUP);
        assert_eq!(
            observe_with_wait(&tree, |_| panic!(
                "unreadable state must refuse without waiting"
            )),
            Err(UNREADABLE)
        );
    }
}
