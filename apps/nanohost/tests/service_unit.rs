use std::path::Path;

const UNIT: &str = include_str!("../deploy/openkit-nanohost.service");

/// Slice-wide SIGKILL that does not enqueue a stop job for the service.
const SLICE_KILL: &str =
    "-/usr/bin/systemctl kill --signal=SIGKILL --kill-whom=all openkit-nanohost.slice";

/// Keys whose effective value is one `[Service]` assignment.
const SERVICE_POLICY: [&str; 4] = [
    "Restart",
    "RestartSec",
    "RestartPreventExitStatus",
    "ExecStopPost",
];

/// Parses unit assignments as `(section, key, value)` and drops blanks and comments.
///
/// Whitespace immediately around `=` is ignored, as systemd ignores it.
fn unit_assignments(unit: &str) -> Vec<(String, String, String)> {
    let mut section = String::new();
    let mut rows = Vec::new();
    for raw in unit.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            section = name.to_string();
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            rows.push((
                section.clone(),
                key.trim().to_string(),
                value.trim().to_string(),
            ));
        }
    }
    rows
}

/// Returns the sole `[Service]` value for `key`.
///
/// A second assignment, or an assignment outside `[Service]`, is an error.
fn service_policy<'a>(rows: &'a [(String, String, String)], key: &str) -> Result<&'a str, String> {
    let hits = rows
        .iter()
        .filter(|(_, assignment, _)| assignment == key)
        .collect::<Vec<_>>();
    if hits.len() != 1 {
        return Err(format!("{key} count {}", hits.len()));
    }
    if hits[0].0 != "Service" {
        return Err(format!("{key} section {}", hits[0].0));
    }
    Ok(hits[0].2.as_str())
}

#[test]
fn wp3a_u3a2_service_unit_owns_one_bounded_fail_stop_slice() {
    let rows = unit_assignments(UNIT);
    let directives = rows
        .iter()
        .map(|(_, key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>();
    for key in SERVICE_POLICY {
        service_policy(&rows, key).unwrap_or_else(|error| panic!("{error}"));
    }

    assert!(
        directives
            .iter()
            .any(|line| line == "Slice=openkit-nanohost.slice")
    );
    assert!(
        directives
            .iter()
            .any(|line| line == "KillMode=control-group")
    );
    assert_eq!(service_policy(&rows, "Restart").expect("Restart"), "always");
    assert_eq!(
        service_policy(&rows, "RestartSec").expect("RestartSec"),
        "5s"
    );
    assert_eq!(
        service_policy(&rows, "RestartPreventExitStatus").expect("RestartPreventExitStatus"),
        "78"
    );
    assert!(
        directives
            .iter()
            .any(|line| line == "StartLimitIntervalSec=0")
    );
    assert!(
        directives
            .iter()
            .any(|line| line == "EnvironmentFile=/etc/openkit/nanohost.env")
    );
    assert!(directives.iter().any(|line| line == "PrivateMounts=yes"));
    assert!(
        directives
            .iter()
            .any(|line| line == "InaccessiblePaths=/run/docker.sock")
    );
    assert!(
        directives
            .iter()
            .any(|line| line.starts_with("TimeoutStopSec="))
    );
    assert!(!UNIT.lines().any(|line| line.trim() == "[Install]"));
    assert!(!directives.iter().any(|line| line.starts_with("WantedBy=")));
    assert!(
        !directives
            .iter()
            .any(|line| line.contains("systemctl stop"))
    );

    let exec_start = directives
        .iter()
        .find_map(|line| line.strip_prefix("ExecStart="))
        .expect("direct ExecStart");
    let start_argv = exec_start.split_ascii_whitespace().collect::<Vec<_>>();
    assert_eq!(
        Path::new(start_argv[0])
            .file_name()
            .and_then(|name| name.to_str()),
        Some("nanohost")
    );
    assert!(Path::new(start_argv[0]).is_absolute());
    assert!(
        !start_argv
            .iter()
            .any(|arg| matches!(*arg, "sh" | "bash" | "-c"))
    );
    assert!(!exec_start.contains("containerd"));
    assert!(!exec_start.contains("dockerd"));
    assert!(!exec_start.contains("openshell"));

    let exec_stop_post = directives
        .iter()
        .find_map(|line| line.strip_prefix("ExecStopPost="))
        .expect("abnormal-exit slice cgroup kill");
    assert_eq!(exec_stop_post, SLICE_KILL);
}

#[test]
fn intentional_stop_does_not_report_its_own_slice_kill_as_main_process_failure() {
    let rows = unit_assignments(UNIT);
    for (section, key, value) in &rows {
        if section != "Service" {
            continue;
        }
        let arguments = value.split_ascii_whitespace().collect::<Vec<_>>();
        if key == "ExecStop" {
            // Killing MainPID from ExecStop records Result=signal even after the slice is empty.
            // ExecStopPost retains whole-slice cleanup after service-process termination.
            let kills_own_slice = arguments.contains(&"kill")
                && arguments.contains(&"--signal=SIGKILL")
                && arguments.contains(&"openkit-nanohost.slice");
            assert!(
                !kills_own_slice,
                "ExecStop must not SIGKILL MainPID through its containing slice"
            );
        }
        if key == "SuccessExitStatus" {
            assert!(
                !arguments
                    .iter()
                    .any(|value| matches!(*value, "SIGKILL" | "KILL")),
                "unexpected MainPID SIGKILL must remain a failure"
            );
        }
    }
}

#[test]
fn service_policy_rejects_duplicate_and_wrong_section_assignments() {
    let restart_no = "[Service]\nRestart=always\nRestart = no\n";
    if let Ok(value) = service_policy(&unit_assignments(restart_no), "Restart") {
        panic!("Restart = no duplicate parsed as Ok({value})");
    }
    let reset = format!("{UNIT}\nRestartPreventExitStatus =\n");
    if let Ok(value) = service_policy(&unit_assignments(&reset), "RestartPreventExitStatus") {
        panic!("RestartPreventExitStatus = reset parsed as Ok({value})");
    }
    for key in SERVICE_POLICY.into_iter().chain(["ExecStop"]) {
        let duplicate = format!("[Service]\n{key}=one\n{key}=two\n");
        assert!(
            service_policy(&unit_assignments(&duplicate), key).is_err(),
            "{key} duplicate"
        );
        let wrong_section = format!("[Unit]\n{key}=one\n");
        assert!(
            service_policy(&unit_assignments(&wrong_section), key).is_err(),
            "{key} section"
        );
        let spaced_duplicate = format!("[Service]\n{key}=kept\n{key} = other\n");
        assert!(
            service_policy(&unit_assignments(&spaced_duplicate), key).is_err(),
            "{key} spaced duplicate"
        );
        let spaced_section = format!("[Service]\n{key}=kept\n[Unit]\n{key} = other\n");
        assert!(
            service_policy(&unit_assignments(&spaced_section), key).is_err(),
            "{key} spaced section"
        );
    }
}
