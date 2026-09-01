use std::process::Command;

#[test]
fn version_exits_before_runtime_environment_is_read() {
    let output = Command::new(env!("CARGO_BIN_EXE_nanohost"))
        .arg("--version")
        .env_clear()
        .output()
        .expect("run nanohost --version");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout)
            .expect("UTF-8 stdout")
            .trim(),
        env!("CARGO_PKG_VERSION")
    );
    assert!(output.stderr.is_empty());
}
