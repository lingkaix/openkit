use std::path::Path;

const UNIT: &str = include_str!("../deploy/openkit-nanohost.service");

#[test]
fn wp3a_u3a2_service_unit_owns_one_bounded_fail_stop_slice() {
    let directives = UNIT
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();

    assert!(directives.contains(&"Slice=openkit-nanohost.slice"));
    assert!(directives.contains(&"KillMode=control-group"));
    assert!(directives.contains(&"Restart=no"));
    assert!(directives.contains(&"EnvironmentFile=/etc/openkit/nanohost.env"));
    assert!(directives.contains(&"PrivateMounts=yes"));
    assert!(directives.contains(&"InaccessiblePaths=/run/docker.sock"));
    assert!(
        directives
            .iter()
            .any(|line| line.starts_with("TimeoutStopSec="))
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

    let exec_stop = directives
        .iter()
        .find_map(|line| line.strip_prefix("ExecStop="))
        .expect("bounded whole-slice stop");
    assert!(exec_stop.contains("systemctl stop"));
    assert!(!exec_stop.contains("systemctl kill"));
    assert!(exec_stop.ends_with("openkit-nanohost.slice"));
    assert!(!exec_stop.contains("/bin/sh"));

    let exec_stop_post = directives
        .iter()
        .find_map(|line| line.strip_prefix("ExecStopPost="))
        .expect("abnormal-exit whole-slice stop");
    assert_eq!(
        exec_stop_post,
        "/usr/bin/systemctl stop --no-block openkit-nanohost.slice"
    );
}
