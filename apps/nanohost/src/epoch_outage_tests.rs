//! Real route-producer, member-classifier, and Core successor outage regressions.
//!
//! Only the transport outside the producers is substituted: bounded stock SDK
//! frames and ExecSandbox events. The route server, response future, coordinator,
//! reconnect loop, Core admission, and durable readiness are production owners.
//! These checks do not claim a deployed Sandbox, stock Gateway, or cgroup fence.
//! Linux is explicit because owned-child absence is observed through `/proc`.

#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use openshell_sdk::raw::proto::{
    ExecSandboxEvent, ExecSandboxStdout, TcpForwardFrame, exec_sandbox_event, tcp_forward_frame,
};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinHandle, LocalSet};
use tokio_stream::wrappers::ReceiverStream;

use super::{EpochCoordinator, EpochMemberMonitor};
use crate::credential_slots::{
    CredentialSlot, SlotPairPaths, SlotWriteMaterial, write_credential_slot,
};
use crate::epoch_evidence::{
    EpochEvidenceWriter, clear_fence_started, fixture_fence_clear_path, fixture_observe_recovery,
};
use crate::nanocore_session::{
    OuterRouteProjection, OuterSessionDisposition, TlsTrustMaterial,
    prepare_verified_session_transport,
};
use crate::openshell_client::WorkerBootstrapMonitor;
use crate::sandbox_bridge::{OpenSandboxBridge, TcpForwardByteStream, serve_sandbox_http2};

const OBSERVATION_LIMIT: Duration = Duration::from_secs(15);
// Independent oracle from the accepted inclusive 300-second hard bound.
const OUTAGE: Duration = Duration::from_secs(301);
const RESTART_ROOT: &str = "OPENKIT_TEST_EPOCH_OUTAGE_RESTART_ROOT";
const RESTART_TEST: &str = "epoch_coordinator::epoch_outage_tests::defect2_member_exit_preserves_first_fence_across_restart";

/// Owns only one newly allocated temporary root, including synthetic credentials.
struct FixtureRoot(PathBuf);

impl FixtureRoot {
    /// Allocates a unique root before any fixture child or credential is created.
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "nanohost-real-outage-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Kills and reaps only the child created by this fixture, including on panic.
struct OwnedChild(Child);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Captures Core protocol output without printing the synthetic Token.
struct CorePeer {
    _child: OwnedChild,
    input: ChildStdin,
    events: mpsc::UnboundedReceiver<Value>,
}

impl CorePeer {
    /// Starts the production Core seam in a child with captured credential output.
    async fn start(root: &Path) -> (Self, Value) {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = OwnedChild(
            Command::new("node")
                .current_dir(&repository)
                .arg("--import")
                .arg(repository.join("apps/nanocore/node_modules/tsx/dist/loader.mjs"))
                .arg(
                    repository.join("apps/nanocore/src/test-support/nanohost-epoch-outage-peer.ts"),
                )
                .arg(root.join("core"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("start isolated production Core route fixture"),
        );
        let input = child.0.stdin.take().unwrap();
        let output = child.0.stdout.take().unwrap();
        let (events, receiver) = mpsc::unbounded_channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str(&line) else {
                    break;
                };
                if events.send(event).is_err() {
                    break;
                }
            }
        });
        let mut peer = Self {
            _child: child,
            input,
            events: receiver,
        };
        let listening = peer.next("listening").await;
        (peer, listening)
    }

    /// Requires the next bounded observation without exposing the credential event.
    async fn next(&mut self, expected: &str) -> Value {
        let event = tokio::time::timeout(OBSERVATION_LIMIT, self.events.recv())
            .await
            .expect("Core observation deadline")
            .expect("Core fixture closed its captured output");
        // Never format the whole event: the first event contains a synthetic secret.
        assert_eq!(
            event["event"].as_str(),
            Some(expected),
            "unexpected Core observation kind"
        );
        event
    }

    /// Requests one fixture-owned listener action and waits for its observed result.
    async fn command(&mut self, command: &str, expected: &str) -> Value {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        self.next(expected).await
    }
}

/// Aborts only the actual producer and local byte-pump tasks owned by a test.
struct Tasks(Vec<AbortHandle>);

impl Drop for Tasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

/// Keeps the genuine local H2 peer and stock response source alive independently of Core.
struct HarnessPeer {
    sender: Option<h2::client::SendRequest<Bytes>>,
    driver: JoinHandle<Result<(), h2::Error>>,
    _events: mpsc::Sender<Result<ExecSandboxEvent, tonic::Status>>,
    forwarding: mpsc::UnboundedReceiver<Result<bool, &'static str>>,
    tasks: Tasks,
}

impl HarnessPeer {
    /// Composes the actual watched producers with bounded stock-protocol inputs.
    async fn start(
        projection: OuterRouteProjection,
        binding: String,
    ) -> (Self, OpenSandboxBridge, WorkerBootstrapMonitor) {
        let (inbound, inbound_rx) = mpsc::channel(4);
        let (outbound, mut outbound_rx) = mpsc::channel::<TcpForwardFrame>(4);
        let (client_io, wire_io) = tokio::io::duplex(256 * 1024);
        let (mut wire_read, mut wire_write) = tokio::io::split(wire_io);
        let input_pump = tokio::spawn(async move {
            let mut buffer = vec![0_u8; 64 * 1024];
            while let Ok(count) = wire_read.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                if inbound
                    .send(Ok(TcpForwardFrame {
                        payload: Some(tcp_forward_frame::Payload::Data(buffer[..count].to_vec())),
                    }))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let output_pump = tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if let Some(tcp_forward_frame::Payload::Data(data)) = frame.payload
                    && wire_write.write_all(&data).await.is_err()
                {
                    break;
                }
            }
        });
        let (forwarded, forwarding) = mpsc::unbounded_channel();
        let route_binding = binding.clone();
        // This is the exact server future and forwarding handler used by open_sandbox_bridge.
        // A request failure is observed, not promoted into connection EOF by the fixture.
        let route_server = tokio::spawn(async move {
            let mut stream = TcpForwardByteStream::new(inbound_rx, outbound);
            let admission_binding = route_binding.clone();
            let _ = serve_sandbox_http2(
                &mut stream,
                &admission_binding,
                move |family, request, respond| {
                    let projection = projection.clone();
                    let binding = route_binding.clone();
                    let forwarded = forwarded.clone();
                    async move {
                        let result = projection.forward(family, request, respond, &binding).await;
                        let _ = forwarded.send(result);
                    }
                },
            )
            .await;
        });
        let route = route_server.abort_handle();
        let mut tasks = Tasks(vec![
            input_pump.abort_handle(),
            output_pump.abort_handle(),
            route.clone(),
        ]);
        let (events, events_rx) = mpsc::channel(4);
        events
            .send(Ok(ExecSandboxEvent {
                payload: Some(exec_sandbox_event::Payload::Stdout(ExecSandboxStdout {
                    data: b"OPENKIT_WORKER_SHIM_ENTRY_V1\n".to_vec(),
                })),
            }))
            .await
            .unwrap();
        let bootstrap =
            WorkerBootstrapMonitor::from_test_events(ReceiverStream::new(events_rx), route)
                .await
                .expect("actual response producer accepted the entry marker");
        tasks.0.push(bootstrap.task_handles().unwrap().0);
        let (sender, connection) = h2::client::handshake(client_io).await.unwrap();
        let driver = tokio::spawn(connection);
        tasks.0.push(driver.abort_handle());
        let bridge = OpenSandboxBridge::new(
            route_server,
            "fixture-forward-authorization".into(),
            binding,
            true,
        );
        (
            Self {
                sender: Some(sender),
                driver,
                _events: events,
                forwarding,
                tasks,
            },
            bridge,
            bootstrap,
        )
    }

    /// Distinguishes successful Core forwarding from a live local route's dependency failure.
    async fn poll(&mut self, healthy: bool) {
        let request = http::Request::builder()
            .method("POST")
            .uri("http://sandbox-integration:80/worker-control/harness/poll")
            .header("content-type", "application/json")
            .body(())
            .unwrap();
        let sender = self.sender.take().unwrap();
        let mut sender = sender.ready().await.unwrap();
        let (response, mut body) = sender.send_request(request, false).unwrap();
        body.send_data(
            Bytes::from_static(br#"{"schemaVersion":2,"harnesses":[]}"#),
            true,
        )
        .unwrap();
        self.sender = Some(sender);
        let response = tokio::time::timeout(OBSERVATION_LIMIT, response)
            .await
            .expect("nested response deadline");
        let forwarded = tokio::time::timeout(OBSERVATION_LIMIT, self.forwarding.recv())
            .await
            .unwrap()
            .unwrap();
        if healthy {
            assert_eq!(response.unwrap().status(), http::StatusCode::NO_CONTENT);
            assert_eq!(
                forwarded,
                Ok(true),
                "real Core Harness poll must prove local route health"
            );
        } else {
            assert!(
                response.is_err(),
                "unavailable Core must not acknowledge Harness readiness"
            );
            assert!(
                forwarded.is_err(),
                "forwarding must observe the actual Core loss"
            );
        }
        assert!(
            !self.tasks.0[2].is_finished(),
            "request failure must not end the route producer"
        );
        assert!(
            !self.tasks.0[3].is_finished(),
            "Core loss must not end the response producer"
        );
    }

    /// Ends the genuine local peer as item 2's member-exit control, never as Core loss.
    async fn close_local_peer(&mut self) {
        self.sender.take();
        self.driver.abort();
        assert!(
            (&mut self.driver)
                .await
                .as_ref()
                .is_err_and(|error| error.is_cancelled())
        );
        tokio::time::timeout(OBSERVATION_LIMIT, async {
            while !self.tasks.0[2].is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actual route server must observe local transport EOF");
        assert!(
            !self.tasks.0[3].is_finished(),
            "response producer remains live at route failure"
        );
    }
}

/// Retains cleanup ownership until all child handles enter the production monitor.
struct OwnedChildren(Vec<Child>);

impl Drop for OwnedChildren {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
        }
        for child in &mut self.0 {
            let _ = child.wait();
        }
    }
}

/// Builds only the actual monitor's owned process group; no backend or service starts.
fn coordinator(root: &Path) -> (EpochCoordinator, Vec<u32>) {
    let (mut coordinator, _) = EpochCoordinator::collection_fixture(root);
    let mut children = OwnedChildren(Vec::new());
    for _ in 0..4 {
        children.0.push(
            Command::new("/bin/sleep")
                .arg("1800")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
    }
    let pids = children.0.iter().map(Child::id).collect();
    let children = std::mem::take(&mut children.0);
    coordinator.monitor = EpochMemberMonitor::start_with_namespaces(
        children,
        None,
        EpochEvidenceWriter::new(root.join("reports")).unwrap(),
        root.join("fence-started"),
        Arc::clone(&coordinator.monitor.readiness),
        None,
    );
    (coordinator, pids)
}

/// Creates the normal slot reader's input with synthetic attempt-local material only.
fn session_inputs(root: &Path, listening: &Value) -> crate::NanoHostSessionInputs {
    let slots = slot_paths(root);
    write_credential_slot(
        &slots,
        CredentialSlot::A,
        &SlotWriteMaterial {
            token_id: "outage-fixture".into(),
            issuance_generation: 1,
            identity_id: "nanohost-a".into(),
            deployment_id: "deployment-a".into(),
            secret: listening["secret"]
                .as_str()
                .expect("captured synthetic Token")
                .into(),
        },
    )
    .unwrap();
    let port = listening["port"].as_u64().unwrap();
    std::fs::write(root.join("core-port"), port.to_string()).unwrap();
    restored_inputs(root)
}

/// Names only the synthetic attempt's private slot pair.
fn slot_paths(root: &Path) -> SlotPairPaths {
    SlotPairPaths {
        slot_a_secret: root.join("token-a"),
        slot_a_companion: root.join("token-a-meta"),
        slot_b_secret: root.join("token-b"),
        slot_b_companion: root.join("token-b-meta"),
    }
}

/// Reopens the same private slot files after an actual test-process restart.
fn restored_inputs(root: &Path) -> crate::NanoHostSessionInputs {
    let port: u16 = std::fs::read_to_string(root.join("core-port"))
        .unwrap()
        .parse()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}");
    crate::NanoHostSessionInputs {
        transport: prepare_verified_session_transport(&url, &TlsTrustMaterial::Platform).unwrap(),
        rendezvous_url: url,
        slot_paths: slot_paths(root),
        selection_context: crate::CredentialSelectionContext {
            identity_id: "nanohost-a".into(),
            deployment_id: "deployment-a".into(),
        },
    }
}

/// Requires positive owned-process presence, not just absence of a monitor fault.
fn assert_members_live(pids: &[u32]) {
    for pid in pids {
        assert!(
            Path::new(&format!("/proc/{pid}")).exists(),
            "owned member disappeared"
        );
    }
}

/// Requires kernel-observed absence after the actual monitor reaps the group.
fn assert_members_absent(pids: &[u32]) {
    for pid in pids {
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "whole-group fence left an owned member"
        );
    }
}

/// Acceptance 1: only Core is lost; the real nested streams remain alive for 301 wall seconds.
#[tokio::test]
async fn defect2_real_producers_preserve_healthy_epoch_beyond_300_seconds() {
    let root = FixtureRoot::new();
    LocalSet::new().run_until(async {
        let (mut core, listening) = CorePeer::start(&root.0).await;
        let inputs = session_inputs(&root.0, &listening);
        let (mut coordinator, pids) = coordinator(&root.0);
        let physical_epoch = coordinator.physical_epoch().to_owned();
        let (mut harness, bridge, bootstrap) = HarnessPeer::start(
            coordinator.outer_route_projection(), listening["bindingRef"].as_str().unwrap().into(),
        ).await;
        coordinator.monitor.watch_harness(&bootstrap).unwrap();
        coordinator.bridge = Some(bridge);
        coordinator.worker_bootstrap_monitor = Some(bootstrap);
        let host = tokio::task::spawn_local(crate::run_sessions(inputs, coordinator, None,
            tokio::time::Instant::now() + crate::STARTUP_READINESS_HARD_LIMIT));
        let _host_guard = Tasks(vec![host.abort_handle()]);
        let first = core.next("ready").await;
        core.next("poll-cycle").await;
        assert_eq!(first["physicalEpoch"], physical_epoch);
        harness.poll(true).await;
        let outage = core.command("outage", "outage").await;
        assert_eq!(outage["ready"], false);
        let unavailable_since = Instant::now();
        harness.poll(false).await;
        tokio::time::sleep(OUTAGE).await;
        assert!(unavailable_since.elapsed() > Duration::from_secs(300));
        assert!(!host.is_finished(), "Core-only outage terminated the admitted Host");
        assert_members_live(&pids);
        assert!(!root.0.join("fence-started").exists(), "healthy outage created a rebuild interval");
        assert_eq!(std::fs::read_dir(root.0.join("reports")).unwrap().count(), 0);
        harness.poll(false).await;
        assert_eq!(core.command("observe", "observation").await["ready"], false);
        core.command("resume", "resumed").await;
        let successor = core.next("ready").await;
        core.next("poll-cycle").await;
        assert_eq!(successor["physicalEpoch"], first["physicalEpoch"]);
        assert!(successor["generation"].as_u64().unwrap() > first["generation"].as_u64().unwrap());
        harness.poll(true).await;
        assert_members_live(&pids);
        assert!(!host.is_finished());
        host.abort();
        assert!(host.await.is_err_and(|error| error.is_cancelled()));
        assert_members_absent(&pids);
        eprintln!("defect2 item1: same physicalEpoch, newer durable generation after 301s Core-only outage");
    }).await;
}

/// Qualifies the exact clear entry point using separate owned markers, never the installed one.
#[test]
fn defect2_marker_clear_override_is_scoped() {
    let root = FixtureRoot::new();
    let outer = root.0.join("outer-marker");
    let inner = root.0.join("inner-marker");
    std::fs::write(&outer, b"outer").unwrap();
    std::fs::write(&inner, b"inner").unwrap();
    let _outer_guard = fixture_fence_clear_path(outer.clone());
    {
        let _inner_guard = fixture_fence_clear_path(inner.clone());
        clear_fence_started().unwrap();
        assert!(
            !inner.exists(),
            "the exact clear entry point must use the fixture path"
        );
        assert_eq!(std::fs::read(&outer).unwrap(), b"outer");
    }
    clear_fence_started().unwrap();
    assert!(
        !outer.exists(),
        "dropping the inner guard must restore the prior path"
    );
}

/// The restarted Host must read the original marker and refuse readiness after real expiry.
async fn restarted_readiness_refusal(root: &Path) {
    // This current-thread child must remain contained even if a regression lets
    // late admission reach the successful-readiness marker-consumption callback.
    let _clear_guard = fixture_fence_clear_path(root.join("fence-started"));
    let before = std::fs::read(root.join("fence-started")).unwrap();
    let recovery =
        fixture_observe_recovery(&root.join("state"), &root.join("fence-started")).unwrap();
    let started = recovery
        .fence_started
        .expect("restart retained the first fence");
    assert!(started.elapsed().unwrap() > Duration::from_secs(300));
    let (mut coordinator, _) = EpochCoordinator::collection_fixture(&root.join("restarted"));
    coordinator.physical_epoch = "b".repeat(64);
    coordinator.fixture_invalidation_reports(root);
    let result = crate::run_sessions(
        restored_inputs(root),
        coordinator,
        Some(started),
        tokio::time::Instant::now() + crate::STARTUP_READINESS_HARD_LIMIT,
    )
    .await;
    let crate::NanoHostRunFailure::OuterSession(failure) =
        result.expect_err("late readiness must fail")
    else {
        panic!("late readiness did not reach the outer-session classifier");
    };
    assert_eq!(failure.disposition(), OuterSessionDisposition::Terminal);
    assert_eq!(failure.reason(), "epoch rebuild hard bound exceeded");
    assert_eq!(
        std::fs::read(root.join("fence-started")).unwrap(),
        before,
        "late readiness failure replaced the original first-fence timestamp"
    );
}

/// Acceptance 2: genuine local stream exit fences all members, unlike item 1's Core-only loss.
#[tokio::test]
async fn defect2_member_exit_preserves_first_fence_across_restart() {
    if let Some(root) = std::env::var_os(RESTART_ROOT) {
        restarted_readiness_refusal(Path::new(&root)).await;
        return;
    }
    let root = FixtureRoot::new();
    LocalSet::new().run_until(async {
        let (mut core, listening) = CorePeer::start(&root.0).await;
        let inputs = session_inputs(&root.0, &listening);
        let (mut coordinator, pids) = coordinator(&root.0);
        let (mut harness, bridge, bootstrap) = HarnessPeer::start(
            coordinator.outer_route_projection(), listening["bindingRef"].as_str().unwrap().into(),
        ).await;
        coordinator.monitor.watch_harness(&bootstrap).unwrap();
        coordinator.bridge = Some(bridge);
        coordinator.worker_bootstrap_monitor = Some(bootstrap);
        let host = tokio::task::spawn_local(crate::run_sessions(inputs, coordinator, None,
            tokio::time::Instant::now() + crate::STARTUP_READINESS_HARD_LIMIT));
        let _host_guard = Tasks(vec![host.abort_handle()]);
        let first = core.next("ready").await;
        core.next("poll-cycle").await;
        harness.poll(true).await;
        core.command("outage", "outage").await;
        harness.poll(false).await;
        let exit_started = SystemTime::now();
        harness.close_local_peer().await;
        let result = tokio::time::timeout(OBSERVATION_LIMIT, host).await.unwrap().unwrap();
        let crate::NanoHostRunFailure::OuterSession(failure) = result.expect_err("local exit must end Host") else {
            panic!("member failure did not reach the real outer-session classifier");
        };
        assert_eq!(failure.disposition(), OuterSessionDisposition::Terminal);
        assert_eq!(failure.reason(), "nanohost epoch member failed");
        assert_members_absent(&pids);
        let reports: Vec<Value> = std::fs::read_dir(root.0.join("reports")).unwrap().map(|entry| {
            serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
        }).collect();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["trigger"], "member-exit");
        assert_eq!(reports[0]["fields"]["failed_member"], "subject=harness-route;observation=finished");
        assert_eq!(reports[0]["fields"]["readiness"], "last_succeeded=core-acknowledgement");
        let marker = std::fs::read(root.0.join("fence-started")).unwrap();
        let recovery = fixture_observe_recovery(&root.0.join("state"), &root.0.join("fence-started")).unwrap();
        let started = recovery.fence_started.unwrap();
        assert!(started >= exit_started && started <= SystemTime::now());
        tokio::time::sleep(OUTAGE).await;
        assert!(started.elapsed().unwrap() > Duration::from_secs(300));
        assert_eq!(core.command("observe", "observation").await["ready"], false);
        core.command("resume", "resumed").await;
        // A separate process reopens the marker and normal credential slots. No aged marker
        // is fabricated, and no wall-clock replacement or paused Tokio time is involved.
        let mut restarted = OwnedChild(Command::new(std::env::current_exe().unwrap())
            .args(["--exact", RESTART_TEST, "--nocapture", "--test-threads=1"])
            .env(RESTART_ROOT, &root.0)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap());
        let status = tokio::time::timeout(OBSERVATION_LIMIT, async {
            loop {
                if let Some(status) = restarted.0.try_wait().unwrap() { break status; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("restarted Host readiness refusal deadline");
        assert!(status.success(), "restarted Host did not prove late readiness refusal");
        assert_eq!(std::fs::read(root.0.join("fence-started")).unwrap(), marker);
        let observation = core.command("observe", "observation").await;
        assert_eq!(observation["ready"], false, "Core accepted expired recovery readiness");
        assert!(observation["generation"].as_u64().unwrap() > first["generation"].as_u64().unwrap(),
            "restarted Host must reach real successor admission before readiness refusal");
        eprintln!("defect2 item2: genuine route exit fenced all children; restart preserved first fence and refused readiness after 301s");
    }).await;
}
