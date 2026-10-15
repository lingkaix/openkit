//! Linux contract regressions for the real local inspection producer and client.
//!
//! The fixture owns only its local entry, admission UID, machine file and unit
//! observations. Process stamps and executable-image reads use the live OS.

#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::io::Write;
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::credential_slots::{CredentialSelectionContext, CredentialSlot};
use crate::live_inspection::test_support::{Fixture, inspect_at};
use crate::live_inspection::{Failure, InspectionServer, InspectionState};
use crate::nanocore_session::{
    CredentialPresentationOutcome, OuterSessionFailure, run_outer_session,
};

const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EPOCH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MACHINE_DIGEST: &str = "6ed6653dba3d6aee8110c6e23de37f15c609b8a6e29aa164d1acace604e5cb7e";
const UNIT_DIGEST: &str = "e428c3859b06b474a99bd455572a79e9743048737898747bfb059463775f57f7";
const EFFECTIVE_DIGEST: &str = "a8468cf551252a9e1baf1e2503790dbd55be5def9acb43d2c995b1abbd3a34c1";
static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

/// Drives the actual native handshake while the test controls readiness EOF.
struct NativeSession {
    client: tokio::task::JoinHandle<Result<u64, OuterSessionFailure>>,
    server: tokio::task::JoinHandle<()>,
    readiness_seen: tokio::sync::oneshot::Receiver<()>,
    dispatch_seen: tokio::sync::oneshot::Receiver<(u64, h2::client::SendRequest<bytes::Bytes>)>,
    finish_ack: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.client.abort();
        self.server.abort();
    }
}

/// Uses real H2 framing and the real session producer without a runtime effect.
fn native_session(
    state: Arc<InspectionState>,
    generation: u64,
    predecessor: Option<u64>,
) -> NativeSession {
    let (client_io, server_io) = tokio::io::duplex(4096);
    let (readiness_sent, readiness_seen) = tokio::sync::oneshot::channel();
    let (finish_ack, ack_finished) = tokio::sync::oneshot::channel();
    let (dispatch_sent, dispatch_seen) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut connection = h2::server::handshake(server_io).await.unwrap();
        let mut exchanges = tokio::task::JoinSet::new();
        let mut readiness_sent = Some(readiness_sent);
        let mut ack_finished = Some(ack_finished);
        while let Some(request) = connection.accept().await {
            let (request, mut respond) = request.unwrap();
            let path = request.uri().path().to_owned();
            let readiness_sent = if path.ends_with("/readiness") {
                readiness_sent.take()
            } else {
                None
            };
            let ack_finished = if path.ends_with("/readiness") {
                ack_finished.take()
            } else {
                None
            };
            exchanges.spawn(async move {
                let mut body = request.into_body();
                let mut bytes = Vec::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    bytes.extend_from_slice(&chunk);
                }
                match path.as_str() {
                    "/api/nanohost/transport/session/admit" => {
                        assert_eq!(bytes, b"{}");
                        let admission = json!({"connectionGeneration":generation,"identityId":"host-fixture","deploymentId":"deployment-fixture","role":"authoritative","mayCarryWork":true});
                        let mut response = respond.send_response(http::Response::builder().status(200).body(()).unwrap(), false).unwrap();
                        response.send_data(bytes::Bytes::from(admission.to_string()), true).unwrap();
                    }
                    "/api/nanohost/transport/session/readiness" => {
                        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!({"physicalEpoch":EPOCH}));
                        let mut response = respond.send_response(http::Response::builder().status(204).body(()).unwrap(), false).unwrap();
                        readiness_sent.unwrap().send(()).unwrap();
                        if ack_finished.unwrap().await.is_ok() {
                            response.send_data(bytes::Bytes::new(), true).unwrap();
                        }
                    }
                    "/inspection-transport-proof" => {
                        assert!(bytes.is_empty());
                        respond.send_response(http::Response::builder().status(204).body(()).unwrap(), true).unwrap();
                    }
                    _ => panic!("unexpected native request: {path}"),
                }
            });
        }
    });
    let client = tokio::spawn(async move {
        let context = CredentialSelectionContext {
            identity_id: "host-fixture".into(),
            deployment_id: "deployment-fixture".into(),
        };
        let presentation = CredentialPresentationOutcome::Presented {
            slot: CredentialSlot::A,
            token_id: "fixture-token".into(),
            secret: "okt_test_only".into(),
        };
        run_outer_session(
            client_io,
            "http://nanocore.test",
            &context,
            &presentation,
            predecessor,
            (
                EPOCH,
                tokio::time::Instant::now() + Duration::from_secs(20),
                Some(state),
                || Ok(None),
            ),
            move |allocated, sender| async move {
                // The caller retains carriage across session-future cancellation.
                // Otherwise dropping the last sender could close H2 and mask a
                // missing cancellation cleanup with transport-close cleanup.
                let _ = dispatch_sent.send((allocated, sender));
                std::future::pending::<Result<(), OuterSessionFailure>>().await
            },
        )
        .await
    });
    NativeSession {
        client,
        server,
        readiness_seen,
        dispatch_seen,
        finish_ack: Some(finish_ack),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_follows_native_ack_physical_close_reconnect_and_future_abort() {
    let host = LocalHost::new();
    let state = InspectionState::new(EPOCH.to_owned(), host.gateway.id()).unwrap();
    let _entry = InspectionServer::start_fixture(state.clone(), host.fixture()).unwrap();
    let mut first = native_session(state.clone(), 41, None);
    tokio::time::timeout(Duration::from_secs(2), &mut first.readiness_seen)
        .await
        .unwrap()
        .unwrap();
    unavailable(
        &inspect_at(NONCE, &host.endpoint, uid()).await.unwrap(),
        "connection-unavailable",
    );
    assert!(matches!(
        first.dispatch_seen.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    first.finish_ack.take().unwrap().send(()).unwrap();
    let (generation, first_sender) =
        tokio::time::timeout(Duration::from_secs(2), &mut first.dispatch_seen)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(generation, 41);
    let observed = inspect_at(NONCE, &host.endpoint, uid()).await.unwrap();
    assert_eq!(observed["outcome"], "observed", "{observed}");
    assert_eq!(observed["connectionGeneration"], 41);
    assert_eq!(observed["physicalEpoch"], EPOCH);
    assert_eq!(observed["identityId"], "host-fixture");
    assert_eq!(observed["deploymentId"], "deployment-fixture");
    assert!(
        !first.client.is_finished(),
        "dispatch is deliberately pending"
    );
    first.server.abort();
    let _ = (&mut first.server).await;
    tokio::time::timeout(Duration::from_secs(2), &mut first.client)
        .await
        .unwrap()
        .unwrap()
        .expect_err("physical close cannot keep the session current");
    unavailable(
        &inspect_at(NONCE, &host.endpoint, uid()).await.unwrap(),
        "connection-unavailable",
    );
    drop(first_sender);

    let mut successor = native_session(state, 42, Some(41));
    tokio::time::timeout(Duration::from_secs(2), &mut successor.readiness_seen)
        .await
        .unwrap()
        .unwrap();
    unavailable(
        &inspect_at(NONCE, &host.endpoint, uid()).await.unwrap(),
        "connection-unavailable",
    );
    successor.finish_ack.take().unwrap().send(()).unwrap();
    let (generation, successor_sender) =
        tokio::time::timeout(Duration::from_secs(2), &mut successor.dispatch_seen)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(generation, 42);
    let observed = inspect_at(NONCE, &host.endpoint, uid()).await.unwrap();
    assert_eq!(observed["outcome"], "observed", "{observed}");
    assert_eq!(observed["connectionGeneration"], 42);
    assert_eq!(observed["physicalEpoch"], EPOCH);
    successor.client.abort();
    assert!((&mut successor.client).await.unwrap_err().is_cancelled());
    let successor_sender = tokio::time::timeout(Duration::from_secs(2), async {
        let mut sender = successor_sender.ready().await.unwrap();
        let request = http::Request::builder()
            .uri("http://nanocore.test/inspection-transport-proof")
            .body(())
            .unwrap();
        let (response, _) = sender.send_request(request, true).unwrap();
        let response = response.await.unwrap();
        assert_eq!(response.status(), http::StatusCode::NO_CONTENT);
        assert!(response.into_body().data().await.is_none());
        sender
    })
    .await
    .expect("retained sender must prove the physical connection remains open");
    assert!(
        !successor.server.is_finished(),
        "native peer exited after session cancellation"
    );
    unavailable(
        &inspect_at(NONCE, &host.endpoint, uid()).await.unwrap(),
        "connection-unavailable",
    );
    drop(successor_sender);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_never_admits_a_lost_native_readiness_ack() {
    let host = LocalHost::new();
    let state = InspectionState::new(EPOCH.to_owned(), host.gateway.id()).unwrap();
    let _entry = InspectionServer::start_fixture(state.clone(), host.fixture()).unwrap();
    let mut session = native_session(state, 71, None);
    tokio::time::timeout(Duration::from_secs(2), &mut session.readiness_seen)
        .await
        .unwrap()
        .unwrap();
    unavailable(
        &inspect_at(NONCE, &host.endpoint, uid()).await.unwrap(),
        "connection-unavailable",
    );
    session.server.abort();
    let _ = (&mut session.server).await;
    tokio::time::timeout(Duration::from_secs(2), &mut session.client)
        .await
        .unwrap()
        .unwrap()
        .expect_err("lost readiness EOF cannot admit inspection");
    assert!(session.dispatch_seen.try_recv().is_err());
    unavailable(
        &inspect_at(NONCE, &host.endpoint, uid()).await.unwrap(),
        "connection-unavailable",
    );
}

/// Owns a distinct live Gateway image and all substituted observation files.
struct LocalHost {
    root: PathBuf,
    gateway: Child,
    endpoint: Vec<u8>,
    unit: Arc<Mutex<String>>,
    live_gateway_digest: String,
}

impl LocalHost {
    /// Starts only a copied sleep process, with no product service effects.
    fn new() -> Self {
        let unique = format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        );
        let root = std::env::temp_dir().join(format!("openkit-inspection-{unique}"));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("machine-id"),
            b"0123456789abcdef0123456789abcdef\n",
        )
        .unwrap();
        std::fs::write(root.join("unit"), b"[Unit]\nDescription=fixture\n").unwrap();
        let image = root.join("gateway");
        std::fs::copy("/bin/sleep", &image).unwrap();
        let live_gateway_digest = digest(&std::fs::read(&image).unwrap());
        let gateway = Command::new(&image).arg("60").spawn().unwrap();
        Self {
            root,
            gateway,
            endpoint: format!("openkit.inspection.test.{unique}").into_bytes(),
            unit: Arc::new(Mutex::new(unit_properties(std::process::id()))),
            live_gateway_digest,
        }
    }

    /// Supplies only the fixture substitutions admitted by the accepted owner.
    fn fixture(&self) -> Fixture {
        let unit = self.unit.clone();
        Fixture {
            endpoint: self.endpoint.clone(),
            allowed_uid: uid(),
            machine_id: self.root.join("machine-id"),
            unit_file: self.root.join("unit"),
            unit_observer: Arc::new(move || Ok(unit.lock().unwrap().clone())),
            after_pin: None,
        }
    }

    /// Creates the actual coordinator observation state with one admitted binding.
    fn state(&self) -> Arc<InspectionState> {
        let state = InspectionState::new(EPOCH.to_owned(), self.gateway.id()).unwrap();
        state.admit("host-fixture", "deployment-fixture", 8);
        state
    }
}

impl Drop for LocalHost {
    fn drop(&mut self) {
        let _ = self.gateway.kill();
        let _ = self.gateway.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Computes an oracle from independently selected bytes, never producer helpers.
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Derives the expected incarnation directly from Linux's documented stat fields.
fn expected_stamp(pid: u32) -> Value {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let suffix = stat.rsplit_once(')').unwrap().1;
    let start_ticks = suffix.split_whitespace().nth(19).unwrap();
    json!({
        "bootId": std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim(),
        "pid": pid,
        "startTimeTicks": start_ticks,
    })
}

/// Reads the test process's OS identity for the verification-only peer policy.
fn uid() -> u32 {
    // SAFETY: getuid has no arguments or memory effects.
    unsafe { libc::getuid() }
}

/// Builds the complete accepted property set without importing producer constants.
fn unit_properties(pid: u32) -> String {
    let names = "Type ExecStart ExecStop ExecStopPost User Group SupplementaryGroups DynamicUser NoNewPrivileges PrivateMounts PrivateTmp ProtectSystem ProtectHome InaccessiblePaths ReadOnlyPaths ReadWritePaths BindPaths BindReadOnlyPaths RootDirectory RootImage WorkingDirectory EnvironmentFiles LoadCredential LoadCredentialEncrypted PassEnvironment UnsetEnvironment Slice KillMode Restart RestartUSec RestartPreventExitStatus TimeoutStopUSec CapabilityBoundingSet AmbientCapabilities RestrictNamespaces RestrictAddressFamilies SystemCallFilter DevicePolicy DeviceAllow DropInPaths";
    let mut fields: BTreeMap<&str, String> = names
        .split_whitespace()
        .map(|name| (name, String::new()))
        .collect();
    let kill = "{ path=/usr/bin/systemctl ; argv[]=/usr/bin/systemctl kill --signal=SIGKILL --kill-whom=all openkit-nanohost.slice ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 }";
    for (name, value) in [
        ("Type", "simple"),
        (
            "ExecStart",
            "{ path=/usr/lib/openkit/nanohost ; argv[]=/usr/lib/openkit/nanohost ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 }",
        ),
        ("ExecStop", kill),
        ("ExecStopPost", kill),
        ("PrivateMounts", "yes"),
        ("InaccessiblePaths", "/run/docker.sock"),
        ("Slice", "openkit-nanohost.slice"),
        ("KillMode", "control-group"),
        ("Restart", "always"),
        ("RestartUSec", "5s"),
        ("RestartPreventExitStatus", "78"),
        ("TimeoutStopUSec", "30s"),
        ("ActiveState", "active"),
        ("SubState", "running"),
        ("NeedDaemonReload", "no"),
    ] {
        fields.insert(name, value.to_owned());
    }
    fields.insert("MainPID", pid.to_string());
    fields
        .into_iter()
        .map(|(name, value)| format!("{name}={value}\n"))
        .collect()
}

/// Opens the same abstract Unix entry used by the real client, without a parser.
fn raw_connection(endpoint: &[u8]) -> tokio::net::UnixStream {
    let address = SocketAddr::from_abstract_name(endpoint).unwrap();
    let stream = UnixStream::connect_addr(&address).unwrap();
    stream.set_nonblocking(true).unwrap();
    tokio::net::UnixStream::from_std(stream).unwrap()
}

/// Exchanges one raw request under an outer test bound.
async fn raw_exchange(endpoint: &[u8], request: &[u8]) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(7), async {
        let mut stream = raw_connection(endpoint);
        stream.write_all(request).await.unwrap();
        stream.shutdown().await.unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response).await;
        response
    })
    .await
    .expect("server exchange must remain bounded")
}

/// Rejects partial success and checks the closed unavailable envelope.
fn unavailable(value: &Value, reason: &str) {
    assert_eq!(
        value,
        &json!({"nonce": NONCE, "outcome": "unavailable", "reason": reason})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_measures_live_images_and_exact_canonical_evidence() {
    let host = LocalHost::new();
    let oracle_started = Instant::now();
    let nanohost_digest = digest(&std::fs::read("/proc/self/exe").unwrap());
    let oracle_elapsed = oracle_started.elapsed();
    // Atomic installation replacement does not replace the running image.
    std::fs::write(host.root.join("next-gateway"), b"new installed payload\n").unwrap();
    std::fs::rename(host.root.join("next-gateway"), host.root.join("gateway")).unwrap();
    assert_ne!(
        digest(&std::fs::read(host.root.join("gateway")).unwrap()),
        host.live_gateway_digest
    );
    let state = host.state();
    let _server = InspectionServer::start_fixture(state, host.fixture()).unwrap();
    let observed = inspect_at(NONCE, &host.endpoint, uid())
        .await
        .unwrap_or_else(|failure| panic!("inspection failed: {failure:?}; independent Rust image hashing took {oracle_elapsed:?}"));
    assert_eq!(
        observed["outcome"], "observed",
        "{observed}; independent Rust image hashing took {oracle_elapsed:?}"
    );
    assert_eq!(observed["nonce"], NONCE);
    assert_eq!(observed["machineIdentityDigest"], MACHINE_DIGEST);
    assert_eq!(observed["physicalEpoch"], EPOCH);
    assert_eq!(observed["identityId"], "host-fixture");
    assert_eq!(observed["deploymentId"], "deployment-fixture");
    assert_eq!(observed["connectionGeneration"], 8);
    assert_eq!(observed["coordinator"], expected_stamp(std::process::id()));
    assert_eq!(
        observed["executables"]["nanohost"]["process"],
        observed["coordinator"]
    );
    assert_eq!(
        observed["executables"]["gateway"]["process"],
        expected_stamp(host.gateway.id())
    );
    assert_eq!(
        observed["executables"]["nanohost"]["sha256"],
        nanohost_digest
    );
    assert_eq!(
        observed["executables"]["gateway"]["sha256"],
        host.live_gateway_digest
    );
    assert_eq!(
        observed["unit"],
        json!({"fileSha256": UNIT_DIGEST, "effectiveStateDigest": EFFECTIVE_DIGEST, "activeState":"active", "subState":"running"})
    );
    assert_eq!(observed["replacementDuringMeasurement"], false);
    let encoded = observed.to_string();
    assert!(!encoded.contains("0123456789abcdef0123456789abcdef"));
    assert!(!encoded.contains("/run/docker.sock"));
    assert!(!encoded.contains("/usr/lib/openkit"));
    for stamp in [
        &observed["coordinator"],
        &observed["executables"]["gateway"]["process"],
    ] {
        let ticks = stamp["startTimeTicks"].as_str().unwrap();
        assert!(ticks.parse::<u64>().unwrap() > 0);
        assert_eq!(ticks.parse::<u64>().unwrap().to_string(), ticks);
        assert_eq!(
            stamp["bootId"],
            std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .unwrap()
                .trim()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_refuses_malformed_requests_and_unauthorized_peers() {
    let host = LocalHost::new();
    let state = host.state();
    let server = InspectionServer::start_fixture(state, host.fixture()).unwrap();
    for request in [
        b"{}".to_vec(),
        format!("{{\"nonce\":\"{}\"}}", "A".repeat(64)).into_bytes(),
        format!("{{\"nonce\":\"{NONCE}\",\"pid\":1}}").into_bytes(),
        format!("{{\"nonce\":\"{NONCE}\",\"nonce\":\"{NONCE}\"}}").into_bytes(),
        vec![b' '; 257],
    ] {
        let bytes = raw_exchange(&host.endpoint, &request).await;
        assert!(
            bytes.is_empty(),
            "malformed request returned an envelope: {bytes:?}"
        );
    }
    let mut boundary_request = format!("{{\"nonce\":\"{NONCE}\"}}").into_bytes();
    boundary_request.resize(256, b' ');
    let boundary_reply: Value =
        serde_json::from_slice(&raw_exchange(&host.endpoint, &boundary_request).await).unwrap();
    assert_eq!(
        boundary_reply["outcome"], "observed",
        "exactly 256 request bytes must remain admissible: {boundary_reply}"
    );
    assert_eq!(boundary_reply["nonce"], NONCE);
    assert_eq!(
        inspect_at(NONCE, &host.endpoint, uid().wrapping_add(1)).await,
        Err(Failure::AccessDenied)
    );
    drop(server);
    let host = LocalHost::new();
    let mut fixture = host.fixture();
    fixture.allowed_uid = uid().wrapping_add(1);
    let _server = InspectionServer::start_fixture(host.state(), fixture).unwrap();
    let result = inspect_at(NONCE, &host.endpoint, uid()).await;
    assert!(
        result.is_err() || result.as_ref().unwrap()["outcome"] == "unavailable",
        "unauthorized caller received {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_invalidates_in_measurement_unit_process_and_connection_changes() {
    for fault in [
        "gateway-exit",
        "gateway-exec",
        "unit-file",
        "unit-effective",
        "reconnect",
        "connection-away-back",
        "owner-close",
    ] {
        let mut host = LocalHost::new();
        let exec_input = if fault == "gateway-exec" {
            host.gateway.kill().unwrap();
            host.gateway.wait().unwrap();
            host.gateway = Command::new("/bin/sh")
                .args(["-c", "read line; exec /bin/sleep 60"])
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            host.gateway.stdin.take()
        } else {
            None
        };
        let exec_input = Mutex::new(exec_input);
        let state = host.state();
        let mut fixture = host.fixture();
        let state_for_fault = state.clone();
        let unit = host.unit.clone();
        let unit_path = host.root.join("unit");
        let gateway_pid = host.gateway.id();
        fixture.after_pin = Some(Arc::new(move || match fault {
            "gateway-exit" => {
                // SAFETY: the fixture owns this live child PID.
                assert_eq!(unsafe { libc::kill(gateway_pid as i32, libc::SIGKILL) }, 0);
                let deadline = Instant::now() + Duration::from_secs(1);
                while Instant::now() < deadline {
                    if std::fs::read_link(format!("/proc/{gateway_pid}/exe")).is_err() {
                        break;
                    }
                    std::thread::yield_now();
                }
            }
            "gateway-exec" => {
                exec_input
                    .lock()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .write_all(b"replace\n")
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(1);
                while Instant::now() < deadline {
                    let path = std::fs::read_link(format!("/proc/{gateway_pid}/exe")).unwrap();
                    if path.file_name().unwrap() == "sleep" {
                        break;
                    }
                    std::thread::yield_now();
                }
                assert_eq!(
                    std::fs::read_link(format!("/proc/{gateway_pid}/exe"))
                        .unwrap()
                        .file_name()
                        .unwrap(),
                    "sleep"
                );
            }
            "unit-file" => std::fs::write(&unit_path, b"changed unit\n").unwrap(),
            "unit-effective" => {
                let mut text = unit.lock().unwrap();
                *text = text.replace("KillMode=control-group", "KillMode=process");
            }
            "reconnect" => {
                state_for_fault.clear();
                state_for_fault.admit("host-fixture", "deployment-fixture", 9);
            }
            "connection-away-back" => {
                state_for_fault.clear();
                state_for_fault.admit("host-fixture", "deployment-fixture", 8);
            }
            "owner-close" => state_for_fault.close(),
            _ => unreachable!(),
        }));
        let _server = InspectionServer::start_fixture(state, fixture).unwrap();
        let result = inspect_at(NONCE, &host.endpoint, uid()).await;
        if fault == "owner-close" {
            assert!(result.is_err() || result.as_ref().unwrap()["outcome"] == "unavailable");
        } else {
            let reason = match fault {
                "gateway-exit" | "gateway-exec" => "process-changed",
                "unit-file" | "unit-effective" => "unit-unavailable",
                _ => "connection-unavailable",
            };
            unavailable(&result.unwrap(), reason);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_fails_closed_for_unavailable_and_unsafe_observations() {
    for fault in [
        "machine-missing",
        "machine-empty",
        "machine-symlink",
        "unit-missing",
        "unit-symlink",
        "unit-observer",
        "unit-duplicate",
        "unit-missing-property",
        "unit-main-pid",
        "unit-reload",
        "unit-secret-removal",
        "unit-escaped-secret-removal",
        "unit-secret-pass-through",
        "unit-unknown-exec",
        "connection-missing",
    ] {
        let host = LocalHost::new();
        let state = host.state();
        let mut fixture = host.fixture();
        match fault {
            "machine-missing" => fixture.machine_id = host.root.join("missing"),
            "machine-empty" => std::fs::write(&fixture.machine_id, b"").unwrap(),
            "machine-symlink" => {
                std::os::unix::fs::symlink(&fixture.machine_id, host.root.join("linked-machine"))
                    .unwrap();
                fixture.machine_id = host.root.join("linked-machine");
            }
            "unit-missing" => fixture.unit_file = host.root.join("missing"),
            "unit-symlink" => {
                std::os::unix::fs::symlink(host.root.join("unit"), host.root.join("linked-unit"))
                    .unwrap();
                fixture.unit_file = host.root.join("linked-unit");
            }
            "unit-observer" => fixture.unit_observer = Arc::new(|| Err(Failure::UnitUnavailable)),
            "unit-duplicate" => host.unit.lock().unwrap().push_str("KillMode=process\n"),
            "unit-missing-property" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace("DynamicUser=\n", "");
            }
            "unit-main-pid" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace(&format!("MainPID={}", std::process::id()), "MainPID=1");
            }
            "unit-reload" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace("NeedDaemonReload=no", "NeedDaemonReload=yes");
            }
            "unit-secret-removal" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace(
                    "UnsetEnvironment=\n",
                    "UnsetEnvironment=TOKEN=secret-value\n",
                );
            }
            "unit-escaped-secret-removal" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace(
                    "UnsetEnvironment=\n",
                    "UnsetEnvironment=TOKEN\\x3dsecret-value\n",
                );
            }
            "unit-secret-pass-through" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace("PassEnvironment=\n", "PassEnvironment=TOKEN=secret-value\n");
            }
            "unit-unknown-exec" => {
                let mut text = host.unit.lock().unwrap();
                *text = text.replace(
                    "argv[]=/usr/lib/openkit/nanohost ;",
                    "argv[]=/usr/lib/openkit/nanohost --secret=secret-value ;",
                );
            }
            "connection-missing" => state.clear(),
            _ => unreachable!(),
        }
        let _server = InspectionServer::start_fixture(state, fixture).unwrap();
        let result = inspect_at(NONCE, &host.endpoint, uid()).await.unwrap();
        unavailable(
            &result,
            match fault {
                "machine-missing" | "machine-empty" | "machine-symlink" => {
                    "measurement-unavailable"
                }
                "connection-missing" => "connection-unavailable",
                _ => "unit-unavailable",
            },
        );
        assert!(!result.to_string().contains("secret-value"));
    }
}

/// Releases blocked measurement callbacks even when a deciding assertion panics.
#[derive(Default)]
struct MeasurementGate {
    released: Mutex<bool>,
    changed: Condvar,
    entered: AtomicUsize,
}

impl MeasurementGate {
    /// Holds a real measurement worker without altering the five-second deadline.
    fn wait(&self) {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }

    /// Unblocks workers so the fixture cannot strand the test runtime.
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

struct ReleaseOnDrop(Arc<MeasurementGate>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_owner_teardown_aborts_an_in_flight_response() {
    let host = LocalHost::new();
    let gate = Arc::new(MeasurementGate::default());
    let _release = ReleaseOnDrop(gate.clone());
    let mut fixture = host.fixture();
    let callback_gate = gate.clone();
    fixture.after_pin = Some(Arc::new(move || callback_gate.wait()));
    let server = InspectionServer::start_fixture(host.state(), fixture).unwrap();
    let endpoint = host.endpoint.clone();
    let request = tokio::spawn(async move { inspect_at(NONCE, &endpoint, uid()).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while gate.entered.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("measurement must reach the pause");
    drop(server);
    let result = tokio::time::timeout(Duration::from_secs(1), request)
        .await
        .expect("owner teardown must abort the response")
        .unwrap();
    assert!(
        result.is_err(),
        "closed owner returned a response: {result:?}"
    );
    gate.release();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_bounds_measurement_slots_deadline_and_owner_teardown() {
    let host = LocalHost::new();
    let gate = Arc::new(MeasurementGate::default());
    let _release = ReleaseOnDrop(gate.clone());
    let mut fixture = host.fixture();
    let callback_gate = gate.clone();
    fixture.after_pin = Some(Arc::new(move || callback_gate.wait()));
    let server = InspectionServer::start_fixture(host.state(), fixture).unwrap();
    let started = Instant::now();
    let mut requests = Vec::new();
    for _ in 0..4 {
        let endpoint = host.endpoint.clone();
        requests.push(tokio::spawn(async move {
            inspect_at(NONCE, &endpoint, uid()).await
        }));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while gate.entered.load(Ordering::SeqCst) != 4 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("four measurement slots must be admitted");
    let fifth = tokio::time::timeout(
        Duration::from_secs(1),
        inspect_at(NONCE, &host.endpoint, uid()),
    )
    .await
    .expect("saturation must not queue another measurement");
    assert!(fifth.is_err() || fifth.as_ref().unwrap()["outcome"] == "unavailable");
    assert_eq!(gate.entered.load(Ordering::SeqCst), 4);
    for request in requests {
        let result = tokio::time::timeout(Duration::from_secs(7), request)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err() || result.as_ref().unwrap()["outcome"] == "unavailable");
    }
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "server did not enforce the common five-second deadline"
    );
    let after_timeout = inspect_at(NONCE, &host.endpoint, uid()).await;
    assert!(after_timeout.is_err() || after_timeout.as_ref().unwrap()["outcome"] == "unavailable");
    assert_eq!(
        gate.entered.load(Ordering::SeqCst),
        4,
        "timed-out blocking work released occupied slots too early"
    );
    drop(server);
    gate.release();
    assert!(inspect_at(NONCE, &host.endpoint, uid()).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_bounds_partial_requests() {
    let host = LocalHost::new();
    let _server = InspectionServer::start_fixture(host.state(), host.fixture()).unwrap();
    let mut stream = raw_connection(&host.endpoint);
    stream.write_all(b"{\"nonce\":\"").await.unwrap();
    let mut reply = Vec::new();
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(7), stream.read_to_end(&mut reply))
        .await
        .expect("partial request must time out")
        .ok();
    assert!(
        reply.is_empty(),
        "partial request cannot have a nonce-bound result"
    );
    assert!(started.elapsed() < Duration::from_secs(7));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_inspection_client_rejects_wrong_nonce_unknown_core_and_oversized_responses() {
    let mut false_coordinator = expected_stamp(std::process::id());
    false_coordinator["pid"] = json!(1);
    let wrong_peer = json!({
        "nonce": NONCE,
        "outcome": "observed",
        "machineIdentityDigest": MACHINE_DIGEST,
        "physicalEpoch": EPOCH,
        "identityId": "host-fixture",
        "deploymentId": "deployment-fixture",
        "connectionGeneration": 8,
        "coordinator": false_coordinator,
        "executables": {
            "nanohost": {"process":false_coordinator,"sha256":MACHINE_DIGEST},
            "gateway": {"process":expected_stamp(std::process::id()),"sha256":UNIT_DIGEST},
        },
        "unit": {"fileSha256":UNIT_DIGEST,"effectiveStateDigest":EFFECTIVE_DIGEST,"activeState":"active","subState":"running"},
        "replacementDuringMeasurement": false,
    });
    let mut boundary_response = json!({"nonce":NONCE,"outcome":"unavailable","reason":"not-running","description":"discard this annotation"}).to_string();
    boundary_response.extend(std::iter::repeat_n(
        ' ',
        16 * 1024 - boundary_response.len(),
    ));
    for (reply, accepted) in [
        (
            json!({"nonce":"c".repeat(64),"outcome":"unavailable","reason":"not-running"})
                .to_string(),
            false,
        ),
        (
            json!({"nonce":NONCE,"outcome":"unavailable","reason":"new-authority"}).to_string(),
            false,
        ),
        (
            json!({"nonce":NONCE,"outcome":"new-authority"}).to_string(),
            false,
        ),
        (wrong_peer.to_string(), false),
        (" ".repeat(16 * 1024 + 1), false),
        (boundary_response, true),
    ] {
        let host = LocalHost::new();
        let listener =
            UnixListener::bind_addr(&SocketAddr::from_abstract_name(&host.endpoint).unwrap())
                .unwrap();
        listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::UnixListener::from_std(listener).unwrap();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            let _ = stream.write_all(reply.as_bytes()).await;
        });
        let result = inspect_at(NONCE, &host.endpoint, uid()).await;
        if accepted {
            unavailable(&result.unwrap(), "not-running");
        } else {
            assert!(result.is_err());
        }
        tokio::time::timeout(Duration::from_secs(2), peer)
            .await
            .unwrap()
            .unwrap();
    }
}
