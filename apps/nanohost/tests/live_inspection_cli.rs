//! Exercises the fixed CLI before service initialization or local entry access.

#![cfg(target_os = "linux")]

use std::io::Write;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;

const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// Owns one unprivileged child and kills only that child if a test fails.
struct Invocation(Option<Child>);

impl Invocation {
    /// Forces every invocation below the root-only inspection admission boundary.
    fn start(arguments: &[&str]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nanohost"));
        command
            .args(arguments)
            .env_clear()
            .env("TOKIO_WORKER_THREADS", "0")
            .env("OPENKIT_NANOHOST_IDENTITY_ID", "forbidden-service-init")
            .env("OPENKIT_NANOHOST_TOKEN", "invalid-service-environment")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // SAFETY: geteuid takes no arguments and changes no process state.
        if unsafe { libc::geteuid() } == 0 {
            command.uid(65534);
        }
        Self(Some(
            command
                .spawn()
                .expect("start own unprivileged NanoHost child"),
        ))
    }

    /// Supplies only fixed request bytes and optionally closes stdin framing.
    fn input(&mut self, bytes: &[u8], close: bool) {
        let child = self.0.as_mut().unwrap();
        child.stdin.as_mut().unwrap().write_all(bytes).unwrap();
        if close {
            drop(child.stdin.take());
        }
    }

    /// Adds a test bound without changing the product's absolute input deadline.
    fn finish(mut self, bound: Duration) -> Output {
        let deadline = Instant::now() + bound;
        loop {
            if self.0.as_mut().unwrap().try_wait().unwrap().is_some() {
                return self.0.take().unwrap().wait_with_output().unwrap();
            }
            assert!(
                Instant::now() < deadline,
                "CLI child exceeded test bound {bound:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Invocation {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Requires grammar rejection rather than a nonce-bound observation or service error.
fn rejected(output: Output) {
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "invalid input produced an observation"
    );
    assert!(output.stderr.len() <= 256);
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    for forbidden in [
        "forbidden-service-init",
        "invalid-service-environment",
        "TOKIO_WORKER_THREADS",
        "panicked",
    ] {
        assert!(
            !diagnostic.contains(forbidden),
            "service initialization ran: {diagnostic}"
        );
    }
}

#[test]
fn inspect_rejects_malformed_duplicate_extended_and_oversized_stdin_before_service_init() {
    for input in [
        b"{}".to_vec(),
        b"not JSON".to_vec(),
        format!("{{\"nonce\":\"{}\"}}", "A".repeat(64)).into_bytes(),
        format!("{{\"nonce\":\"{}\"}}", "a".repeat(63)).into_bytes(),
        format!("{{\"nonce\":\"{NONCE}\",\"pid\":1}}").into_bytes(),
        format!("{{\"nonce\":\"{NONCE}\",\"nonce\":\"{NONCE}\"}}").into_bytes(),
        vec![b' '; 257],
    ] {
        let mut child = Invocation::start(&["inspect"]);
        child.input(&input, true);
        rejected(child.finish(Duration::from_secs(2)));
    }
}

#[test]
fn inspect_rejects_command_arguments_before_service_init() {
    for arguments in [["inspect", "--pid=1"], ["inspect", "--help"]] {
        let mut child = Invocation::start(&arguments);
        child.input(json!({"nonce": NONCE}).to_string().as_bytes(), true);
        rejected(child.finish(Duration::from_secs(2)));
    }
}

#[test]
fn inspect_returns_only_nonce_bound_access_denied_without_service_initialization() {
    let mut child = Invocation::start(&["inspect"]);
    let mut input = json!({"nonce": NONCE}).to_string().into_bytes();
    input.resize(256, b' ');
    child.input(&input, true);
    let output = child.finish(Duration::from_secs(2));
    assert!(output.status.success(), "stderr: {:?}", output.stderr);
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        json!({"nonce": NONCE, "outcome":"unavailable", "reason":"access-denied"})
    );
}

#[test]
fn inspect_bounds_held_open_input_by_one_absolute_ten_second_deadline() {
    let mut child = Invocation::start(&["inspect"]);
    let started = Instant::now();
    child.input(b"{\"nonce\":\"", false);
    rejected(child.finish(Duration::from_secs(12)));
    assert!(
        started.elapsed() >= Duration::from_secs(9),
        "CLI did not wait for its input deadline"
    );
    assert!(started.elapsed() < Duration::from_secs(12));
}
