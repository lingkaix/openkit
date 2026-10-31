//! Bounded projection of exact-container backend observations into resource diagnostics.
//!
//! The transport specification's Host-Observed Sandbox Resource Summary owns the fields.
//! Missing or invalid observations remain unknown and cannot affect Sandbox deletion.
//! Collection finishes or is abandoned before SDK deletion, within the lesser of
//! one second and the existing operation's remaining allowance. This is not C1 carriage.

/// Projects raw Docker inspect JSON and optional cgroup-v2 files into the closed summary.
///
/// Missing files remain unknown. Container identity, read bounds and collection lifetime
/// belong to the caller; this function performs no I/O and grants no lifecycle authority.
pub(crate) fn summary_from_observation(
    docker_inspect_json: &[u8],
    memory_peak: Option<&str>,
    memory_events: Option<&str>,
    cpu_stat: Option<&str>,
    pids_peak: Option<&str>,
) -> serde_json::Value {
    let mut summary = serde_json::Map::new();
    for (name, value) in [
        ("memoryPeakBytes", memory_peak.and_then(counter)),
        (
            "oomKillCount",
            keyed_counter(memory_events, "oom_kill")
                .filter(|value| *value <= 9_007_199_254_740_991),
        ),
        ("pidsPeak", pids_peak.and_then(counter)),
    ] {
        if let Some(value) = value {
            summary.insert(name.into(), value.into());
        }
    }
    for (name, key) in [
        ("cpuUsageSeconds", "usage_usec"),
        ("cpuThrottledSeconds", "throttled_usec"),
    ] {
        if let Some(value) = keyed_counter(cpu_stat, key) {
            summary.insert(name.into(), serde_json::json!(value as f64 / 1_000_000.0));
        }
    }
    if let Ok(inspect) = serde_json::from_slice::<serde_json::Value>(docker_inspect_json)
        && let Some(containers) = inspect.as_array()
        && containers.len() == 1
    {
        let state = &containers[0]["State"];
        if let Some(value) = state["OOMKilled"].as_bool() {
            summary.insert("backendOomKilled".into(), value.into());
        }
        if let Some(value) = state["Status"].as_str()
            && matches!(
                value,
                "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead"
            )
        {
            summary.insert("exitState".into(), value.into());
        }
    }
    serde_json::Value::Object(summary)
}

/// Reads a measured nonnegative integer within the interoperable JSON range.
fn counter(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>()
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
}

/// Selects one unambiguous cgroup counter; duplicates and extra tokens are invalid.
fn keyed_counter(raw: Option<&str>, key: &str) -> Option<u64> {
    let mut matching = raw?.lines().filter_map(|line| {
        let mut words = line.split_whitespace();
        (words.next() == Some(key)).then(|| (words.next(), words.next()))
    });
    let (value, extra) = matching.next()?;
    if extra.is_some() || matching.next().is_some() {
        return None;
    }
    let value = value?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// Observes only the current Sandbox on the Epoch-private Docker connection.
///
/// The lifecycle owner finishes or drops this future before starting SDK deletion,
/// within the existing operation deadline. Its own one-second cap also bounds direct
/// collection. The pinned SDK already enables Tokio process facilities.
pub(crate) async fn observe_before_delete(
    socket: &std::path::Path,
    sandbox_id: &str,
    sandbox_name: &str,
) -> Option<serde_json::Value> {
    observe_from_sources(
        socket,
        sandbox_id,
        sandbox_name,
        std::path::Path::new("/usr/bin/docker"),
        std::path::Path::new("/proc"),
        std::path::Path::new("/sys/fs/cgroup"),
    )
    .await
}

/// Supplies private source paths explicitly so fixtures never contact a real backend.
pub(crate) async fn observe_from_sources(
    socket: &std::path::Path,
    sandbox_id: &str,
    sandbox_name: &str,
    docker_binary: &std::path::Path,
    proc_root: &std::path::Path,
    cgroup_root: &std::path::Path,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    tokio::time::timeout_at(deadline, async {
        let id = exact_container_id(docker_binary, socket, sandbox_id, sandbox_name).await?;
        let id = id.as_str();
        // Project no environment, logs, arbitrary labels or State.Error into private stdout.
        let args = ["container", "inspect", "--format",
            r#"[{"Id":{{json .Id}},"State":{"Pid":{{json .State.Pid}},"Status":{{json .State.Status}},"OOMKilled":{{json .State.OOMKilled}}},"Config":{"Labels":{"openshell.ai/managed-by":{{json (index .Config.Labels "openshell.ai/managed-by")}},"openshell.ai/sandbox-namespace":{{json (index .Config.Labels "openshell.ai/sandbox-namespace")}},"openshell.ai/sandbox-id":{{json (index .Config.Labels "openshell.ai/sandbox-id")}},"openshell.ai/sandbox-name":{{json (index .Config.Labels "openshell.ai/sandbox-name")}}}}}]"#,
            id];
        let inspect = docker_metadata(docker_binary, socket, &args).await?;
        let container = exact_container(&inspect, id, sandbox_id, sandbox_name)?;
        let pid = container["State"]["Pid"].as_u64().filter(|pid| *pid > 0);
        let cgroup = pid.and_then(|pid| {
            let membership = kernel_metadata(&proc_root.join(format!("{pid}/cgroup")), deadline)?;
            let mut paths = membership.lines().filter_map(|line| line.strip_prefix("0::"));
            let path = paths.next()?;
            if paths.next().is_some() || !path.starts_with('/') { return None; }
            let relative = std::path::Path::new(path.strip_prefix('/')?);
            if !relative.components().all(|part| matches!(part, std::path::Component::Normal(_)))
                || !relative.components().any(|part| part.as_os_str() == id
                    || part.as_os_str() == std::ffi::OsStr::new(&format!("docker-{id}.scope"))) {
                return None;
            }
            Some(cgroup_root.join(relative))
        });
        let values = ["memory.peak", "memory.events", "cpu.stat", "pids.peak"]
            .map(|file| cgroup.as_ref().and_then(|root| kernel_metadata(&root.join(file), deadline)));
        // A gone or replaced container must not leave a partial stale observation.
        let final_inspect = docker_metadata(docker_binary, socket, &args).await?;
        let final_container = exact_container(&final_inspect, id, sandbox_id, sandbox_name)?;
        let same_pid = final_container["State"]["Pid"].as_u64() == pid;
        let fields = values.each_ref().map(|value| if same_pid { value.as_deref() } else { None });
        let summary = summary_from_observation(final_inspect.as_bytes(), fields[0], fields[1], fields[2], fields[3]);
        (!summary.as_object()?.is_empty() && serde_json::to_vec(&summary).ok()?.len() <= 1024
            && tokio::time::Instant::now() < deadline).then_some(summary)
    }).await.ok().flatten()
}

/// Resolves one exact stock-driver Sandbox through its four authoritative labels.
async fn exact_container_id(
    binary: &std::path::Path,
    socket: &std::path::Path,
    sandbox_id: &str,
    sandbox_name: &str,
) -> Option<String> {
    let id_filter = format!("label=openshell.ai/sandbox-id={sandbox_id}");
    let name_filter = format!("label=openshell.ai/sandbox-name={sandbox_name}");
    let ids = docker_metadata(
        binary,
        socket,
        &[
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            "label=openshell.ai/managed-by=openshell",
            "--filter",
            "label=openshell.ai/sandbox-namespace=default",
            "--filter",
            &id_filter,
            "--filter",
            &name_filter,
            "--format",
            "{{.ID}}",
        ],
    )
    .await?;
    let id = ids.trim();
    (id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    .then(|| id.to_string())
}

/// Observes only mount facts and the same exact native identity used by deletion.
/// It excludes environment values and logs even from the private command output.
pub(crate) async fn observe_credential_mounts(
    socket: &std::path::Path,
    sandbox_id: &str,
    sandbox_name: &str,
) -> Option<serde_json::Value> {
    let binary = std::path::Path::new("/usr/bin/docker");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let id = exact_container_id(binary, socket, sandbox_id, sandbox_name).await?;
        let raw = docker_metadata(binary, socket, &["container", "inspect", "--format",
            r#"[{"Id":{{json .Id}},"Mounts":{{json .Mounts}},"Config":{"Labels":{"openshell.ai/managed-by":{{json (index .Config.Labels "openshell.ai/managed-by")}},"openshell.ai/sandbox-namespace":{{json (index .Config.Labels "openshell.ai/sandbox-namespace")}},"openshell.ai/sandbox-id":{{json (index .Config.Labels "openshell.ai/sandbox-id")}},"openshell.ai/sandbox-name":{{json (index .Config.Labels "openshell.ai/sandbox-name")}}}}}]"#, &id]).await?;
        let row = exact_container(&raw, &id, sandbox_id, sandbox_name)?;
        row.get("Mounts").cloned()
    }).await.ok().flatten()
}

/// Runs only bounded metadata commands; dropping any wait kills the owned child.
async fn docker_metadata(
    binary: &std::path::Path,
    socket: &std::path::Path,
    args: &[&str],
) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let host = format!("unix://{}", socket.display());
    let mut child = tokio::process::Command::new(binary)
        .args(["--host", &host])
        .args(args)
        .env_remove("DOCKER_CONTEXT")
        .env_remove("DOCKER_TLS_VERIFY")
        .env_remove("DOCKER_CERT_PATH")
        .env_remove("DOCKER_TLS")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut output = Vec::new();
    child
        .stdout
        .take()?
        .take(8193)
        .read_to_end(&mut output)
        .await
        .ok()?;
    if output.len() > 8192 || !child.wait().await.ok()?.success() {
        return None;
    }
    String::from_utf8(output).ok()
}

/// Rejects ambiguous or changed backend identity before reading kernel counters.
fn exact_container(raw: &str, id: &str, sandbox_id: &str, name: &str) -> Option<serde_json::Value> {
    let inspect: serde_json::Value = serde_json::from_str(raw).ok()?;
    let containers = inspect.as_array()?;
    if containers.len() != 1 || containers[0]["Id"].as_str() != Some(id) {
        return None;
    }
    let labels = &containers[0]["Config"]["Labels"];
    for (key, expected) in [
        ("openshell.ai/managed-by", "openshell"),
        ("openshell.ai/sandbox-namespace", "default"),
        ("openshell.ai/sandbox-id", sandbox_id),
        ("openshell.ai/sandbox-name", name),
    ] {
        if labels[key].as_str() != Some(expected) {
            return None;
        }
    }
    Some(containers[0].clone())
}

/// Reads only small nonblocking kernel metadata, with no blocking-pool task to outlive deletion.
fn kernel_metadata(path: &std::path::Path, deadline: tokio::time::Instant) -> Option<String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    if tokio::time::Instant::now() >= deadline {
        return None;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut output = String::new();
    file.take(4097).read_to_string(&mut output).ok()?;
    (output.len() <= 4096 && tokio::time::Instant::now() < deadline).then_some(output)
}

#[cfg(test)]
pub(crate) mod collector_tests {
    use super::observe_from_sources;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::Duration;

    /// Owns all fake backend commands and kernel files used by collector/race tests.
    pub(crate) struct Fixture {
        pub(crate) root: PathBuf,
        pub(crate) binary: PathBuf,
        pub(crate) socket: PathBuf,
        pub(crate) proc_root: PathBuf,
        pub(crate) cgroup_root: PathBuf,
        pub(crate) id: String,
    }

    impl Fixture {
        /// Creates a private executable that cannot address a real Docker socket.
        pub(crate) fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "resource-summary-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            let fixture = Self {
                binary: root.join("docker-fixture"),
                socket: root.join("private.sock"),
                proc_root: root.join("proc"),
                cgroup_root: root.join("cgroup"),
                root,
                id: "a".repeat(64),
            };
            let inspect = json!([{"Id":fixture.id,"State":{"Pid":42,"Status":"running","OOMKilled":false},
                "Config":{"Labels":{"openshell.ai/managed-by":"openshell", "openshell.ai/sandbox-namespace":"default",
                    "openshell.ai/sandbox-id":"sandbox-id", "openshell.ai/sandbox-name":"sandbox-name"}}}]);
            std::fs::write(fixture.root.join("inspect.json"), inspect.to_string()).unwrap();
            fixture.script(&format!("case \"$4\" in\nls) printf '%s\\n' '{}' ;;\ninspect) cat '{}/inspect.json' ;;\n*) exit 1 ;;\nesac\n", fixture.id, fixture.root.display()));
            fixture
        }

        /// Installs an attempt-local fake command, checking private connection arguments.
        pub(crate) fn script(&self, body: &str) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&self.binary, format!("#!/bin/sh\nset -eu\n[ \"$1\" = --host ]\n[ \"$2\" = 'unix://{}' ]\n[ \"$3\" = container ]\nprintf '%s\\n' \"$4\" >> '{}/events'\n{}", self.socket.display(), self.root.display(), body)).unwrap();
            std::fs::set_permissions(&self.binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        /// Runs the actual bounded collector against this fixture's sources.
        pub(crate) async fn observe(&self) -> Option<serde_json::Value> {
            observe_from_sources(
                &self.socket,
                "sandbox-id",
                "sandbox-name",
                &self.binary,
                &self.proc_root,
                &self.cgroup_root,
            )
            .await
        }

        /// Waits for proof that the fake private command actually started.
        pub(crate) async fn child_pid(&self) -> i32 {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(raw) = std::fs::read_to_string(self.root.join("child.pid"))
                        && let Ok(pid) = raw.trim().parse()
                    {
                        return pid;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("fixture child started")
        }

        /// Requires the owned child to be killed and reaped, not merely abandoned.
        pub(crate) async fn assert_reaped(&self, pid: i32) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    // SAFETY: signal zero only probes existence of this fixture's child.
                    if unsafe { libc::kill(pid, 0) } == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("collector child killed and reaped");
        }
    }

    impl Drop for Fixture {
        /// Releases only this fixture's local files after command containment checks.
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn resource_summary_independent_source_containment_excludes_parent_and_symlink() {
        let fixture = Fixture::new();
        let group = format!("host.slice/docker-{}.scope", fixture.id);
        std::fs::create_dir_all(fixture.proc_root.join("42")).unwrap();
        std::fs::create_dir_all(fixture.cgroup_root.join(&group)).unwrap();
        std::fs::write(
            fixture.proc_root.join("42/cgroup"),
            format!("0::/{group}\n"),
        )
        .unwrap();
        // Both decoys are valid numbers, so a parser cannot hide a containment failure.
        std::fs::write(fixture.cgroup_root.join("host.slice/memory.peak"), "999999").unwrap();
        let outside = fixture.root.join("unrelated-memory.peak");
        std::fs::write(&outside, "888888").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            fixture.cgroup_root.join(&group).join("memory.peak"),
        )
        .unwrap();
        std::fs::write(fixture.cgroup_root.join(&group).join("pids.peak"), "3").unwrap();
        std::fs::write(
            fixture.cgroup_root.join(&group).join("cpu.stat"),
            "usage_usec 500000\nthrottled_usec invalid\n",
        )
        .unwrap();
        assert_eq!(
            fixture.observe().await,
            Some(json!({"pidsPeak": 3, "cpuUsageSeconds": 0.5,
                "backendOomKilled": false, "exitState": "running"}))
        );
        std::fs::write(fixture.proc_root.join("42/cgroup"), "0::/host.slice\n").unwrap();
        assert_eq!(
            fixture.observe().await,
            Some(json!({"backendOomKilled": false, "exitState": "running"}))
        );
    }

    #[tokio::test]
    async fn resource_summary_independent_final_identity_loss_discards_observation() {
        for gone in [false, true] {
            let fixture = Fixture::new();
            let mut changed: serde_json::Value =
                serde_json::from_slice(&std::fs::read(fixture.root.join("inspect.json")).unwrap())
                    .unwrap();
            changed[0]["Config"]["Labels"]["openshell.ai/sandbox-name"] =
                json!("different-sandbox");
            std::fs::write(fixture.root.join("changed.json"), changed.to_string()).unwrap();
            let final_reply = if gone {
                "exit 1".to_string()
            } else {
                format!("cat '{}/changed.json'", fixture.root.display())
            };
            fixture.script(&format!(
                "if [ \"$4\" = ls ]; then printf '%s\\n' '{}';\n\
                 elif [ -e '{}/seen' ]; then {final_reply};\n\
                 else touch '{}/seen'; cat '{}/inspect.json'; fi\n",
                fixture.id,
                fixture.root.display(),
                fixture.root.display(),
                fixture.root.display(),
            ));
            assert!(fixture.observe().await.is_none());
            assert_eq!(
                std::fs::read_to_string(fixture.root.join("events")).unwrap(),
                "ls\ninspect\ninspect\n"
            );
        }
    }

    #[tokio::test]
    async fn resource_summary_collects_exact_lifetime_counters_and_checks_presence() {
        let fixture = Fixture::new();
        let group = format!("system.slice/docker-{}.scope", fixture.id);
        std::fs::create_dir_all(fixture.proc_root.join("42")).unwrap();
        std::fs::create_dir_all(fixture.cgroup_root.join(&group)).unwrap();
        std::fs::write(
            fixture.proc_root.join("42/cgroup"),
            format!("0::/{group}\n"),
        )
        .unwrap();
        for (name, value) in [
            ("memory.peak", "12"),
            ("memory.events", "oom_kill 2"),
            ("cpu.stat", "usage_usec 250000\nthrottled_usec 125000"),
            ("pids.peak", "3"),
        ] {
            std::fs::write(fixture.cgroup_root.join(&group).join(name), value).unwrap();
        }
        assert_eq!(
            fixture.observe().await,
            Some(json!({"memoryPeakBytes":12,"oomKillCount":2,
            "cpuUsageSeconds":0.25,"cpuThrottledSeconds":0.125,"pidsPeak":3,
            "backendOomKilled":false,"exitState":"running"}))
        );
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("events")).unwrap(),
            "ls\ninspect\ninspect\n"
        );
    }

    #[tokio::test]
    async fn resource_summary_missing_cgroups_keep_only_backend_facts() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture.observe().await,
            Some(json!({"backendOomKilled":false,"exitState":"running"}))
        );
    }

    #[tokio::test]
    async fn resource_summary_rejects_unrelated_cgroups_and_oversized_kernel_files() {
        let fixture = Fixture::new();
        let group = format!("system.slice/docker-{}.scope", fixture.id);
        std::fs::create_dir_all(fixture.proc_root.join("42")).unwrap();
        std::fs::create_dir_all(fixture.cgroup_root.join(&group)).unwrap();
        std::fs::write(
            fixture.proc_root.join("42/cgroup"),
            format!("0::/{group}\n"),
        )
        .unwrap();
        std::fs::write(
            fixture.cgroup_root.join(&group).join("memory.events"),
            format!("oom_kill 2\n{}", "x".repeat(4096)),
        )
        .unwrap();
        std::fs::write(fixture.cgroup_root.join(&group).join("memory.peak"), "12").unwrap();
        assert_eq!(
            fixture.observe().await,
            Some(json!({"memoryPeakBytes":12,
            "backendOomKilled":false,"exitState":"running"}))
        );
        std::fs::write(
            fixture.proc_root.join("42/cgroup"),
            "0::/system.slice/unrelated\n",
        )
        .unwrap();
        assert_eq!(
            fixture.observe().await,
            Some(json!({"backendOomKilled":false,"exitState":"running"}))
        );
    }

    #[tokio::test]
    async fn resource_summary_gone_wrong_and_multiple_containers_are_unknown() {
        let fixture = Fixture::new();
        fixture.script(&format!("if [ \"$4\" = ls ]; then printf '%s\\n' '{}'; else\nif [ -e '{}/seen' ]; then exit 1; fi\ntouch '{}/seen'\ncat '{}/inspect.json'\nfi", fixture.id, fixture.root.display(), fixture.root.display(), fixture.root.display()));
        assert!(fixture.observe().await.is_none());
        std::fs::write(fixture.root.join("inspect.json"), r#"[{"Id":"wrong"}]"#).unwrap();
        fixture.script(&format!(
            "if [ \"$4\" = ls ]; then printf '%s\\n' '{}'; else cat '{}/inspect.json'; fi",
            fixture.id,
            fixture.root.display()
        ));
        assert!(fixture.observe().await.is_none());
        fixture.script(&format!(
            "printf '%s\\n%s\\n' '{}' '{}'",
            fixture.id,
            "b".repeat(64)
        ));
        assert!(fixture.observe().await.is_none());
    }

    #[tokio::test]
    async fn resource_summary_timeout_and_output_overflow_kill_private_commands() {
        for overflow in [false, true] {
            let fixture = Fixture::new();
            let body = if overflow {
                "while :; do printf '012345678901234567890123456789'; done"
            } else {
                "exec sleep 20"
            };
            fixture.script(&format!(
                "echo $$ > '{}/child.pid'\n{body}\n",
                fixture.root.display()
            ));
            let start = tokio::time::Instant::now();
            assert!(fixture.observe().await.is_none());
            assert!(start.elapsed() < Duration::from_millis(1500));
            if !overflow {
                assert!(start.elapsed() >= Duration::from_millis(900));
            }
            let pid = fixture.child_pid().await;
            fixture.assert_reaped(pid).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::summary_from_observation;
    use serde_json::json;

    #[test]
    fn projects_only_the_seven_resource_fields_with_literal_units_and_bounds() {
        // Ordinary single-container Docker inspect output; other metadata is not diagnostic data.
        let inspect = br#"[{
            "Id":"exact-container",
            "State":{"Status":"dead","OOMKilled":true,"Error":"PRIVATE_PROCESS_TEXT"},
            "LogPath":"/private/container.log",
            "Config":{"Env":["PRIVATE_CREDENTIAL=not-a-real-secret"]}
        }]"#;
        let summary = summary_from_observation(
            inspect,
            Some("9007199254740991\n"),
            Some("low 41\nhigh 37\nmax 31\noom 9\noom_kill 2\noom_group_kill 11\n"),
            Some(
                "usage_usec 1250000\nuser_usec 1000000\nsystem_usec 250000\nnr_periods 8\nnr_throttled 3\nthrottled_usec 125000\n",
            ),
            Some("7\n"),
        );
        assert_eq!(
            summary,
            json!({
                "memoryPeakBytes": 9007199254740991_u64,
                "oomKillCount": 2,
                "backendOomKilled": true,
                "cpuUsageSeconds": 1.25,
                "cpuThrottledSeconds": 0.125,
                "pidsPeak": 7,
                "exitState": "dead"
            })
        );
        let encoded = serde_json::to_vec(&summary).unwrap();
        assert!(encoded.len() <= 1024);
        assert!(!String::from_utf8(encoded).unwrap().contains("PRIVATE_"));
    }

    #[test]
    fn missing_cgroup_files_do_not_fabricate_counters() {
        assert_eq!(
            summary_from_observation(
                br#"[{"State":{"Status":"running","OOMKilled":false}}]"#,
                None,
                None,
                None,
                None,
            ),
            json!({"backendOomKilled": false, "exitState": "running"})
        );
    }

    #[test]
    fn preserves_measured_zero_and_false() {
        let summary = summary_from_observation(
            br#"[{"State":{"Status":"running","OOMKilled":false}}]"#,
            Some("0\n"),
            Some("oom_kill 0\n"),
            Some("usage_usec 0\nthrottled_usec 0\n"),
            Some("0\n"),
        );
        // Seconds admit numeric zero whether its JSON spelling is 0 or 0.0.
        assert_eq!(summary["cpuUsageSeconds"].as_f64(), Some(0.0));
        assert_eq!(summary["cpuThrottledSeconds"].as_f64(), Some(0.0));
        assert_eq!(summary["memoryPeakBytes"].as_u64(), Some(0));
        assert_eq!(summary["oomKillCount"].as_u64(), Some(0));
        assert_eq!(summary["pidsPeak"].as_u64(), Some(0));
        assert_eq!(summary["backendOomKilled"], false);
        assert_eq!(summary["exitState"], "running");
        assert_eq!(summary.as_object().unwrap().len(), 7);
    }

    #[test]
    fn omits_invalid_fields_without_discarding_an_independent_valid_measurement() {
        // Invalid raw observations become unknown individually; Core rejects malformed DTOs whole.
        assert_eq!(
            summary_from_observation(
                br#"[{"State":{"Status":"oom-killed","OOMKilled":"false"}}]"#,
                Some("-1\n"),
                Some("oom_kill 9007199254740992\n"),
                Some("usage_usec -1\nthrottled_usec 250000\n"),
                Some("1.5\n"),
            ),
            json!({"cpuThrottledSeconds": 0.25})
        );
    }

    #[test]
    fn absent_unsupported_and_unparseable_observations_remain_unknown() {
        assert_eq!(
            summary_from_observation(
                br#"[{"State":{}}]"#,
                None,
                Some("low 3\nhigh 5\n"),
                Some("nr_periods 4\nnr_throttled 2\n"),
                None,
            ),
            json!({})
        );
        assert_eq!(
            summary_from_observation(
                b"not-json",
                Some("max\n"),
                Some("oom_kill invalid\n"),
                Some("usage_usec NaN\nthrottled_usec Infinity\n"),
                Some("PRIVATE_PROCESS_TEXT\n"),
            ),
            json!({})
        );
    }
}
