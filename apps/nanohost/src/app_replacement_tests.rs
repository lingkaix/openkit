//! App replacement through the native Core listener, resident shim, and NanoHost session owner.

use crate::credential_slots::{
    CredentialSelectionContext, CredentialSlot, SlotPairPaths, SlotWriteMaterial,
    write_credential_slot,
};
use crate::epoch_coordinator::{EpochCoordinator, EpochFault, WatchedTask};
use crate::nanocore_session::{TlsTrustMaterial, prepare_verified_session_transport};
use crate::openshell_client::{WorkerBootstrapCompletion, WorkerBootstrapMonitor};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStdout, Command};

const BINDING: &str = "app-replacement-idle-sandbox";
const DEADLINE: Duration = Duration::from_secs(15);

/// Bound loopback ports reported by the shim fixture before its entry marker.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessPorts {
    integration_port: u16,
    native_port: u16,
}

/// Owns the temporary Core data and NanoHost root.
struct FixtureRoot(PathBuf);

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Owns one native Core process and reads its bounded observations.
struct AppPeer {
    process: Child,
    lines: Lines<BufReader<ChildStdout>>,
}

impl AppPeer {
    fn start(core: &Path, root: &Path, port: Option<u16>) -> Self {
        let mut command = Command::new("node");
        command
            .arg("--import")
            .arg(core.join("node_modules/tsx/dist/loader.mjs"))
            .arg(core.join("src/test-support/nanohost-app-replacement-peer.ts"))
            .arg(root);
        if let Some(port) = port {
            command.arg(port.to_string());
        }
        let mut process = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let lines = BufReader::new(process.stdout.take().unwrap()).lines();
        Self { process, lines }
    }

    async fn observation(&mut self, stage: &str) -> Value {
        let line = tokio::time::timeout(DEADLINE, self.lines.next_line())
            .await
            .unwrap_or_else(|_| panic!("App observation timed out at {stage}"))
            .unwrap()
            .unwrap_or_else(|| panic!("App exited before observation at {stage}"));
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("invalid App observation at {stage}"))
    }
}

/// Keeps one NanoHost loop, Epoch, and real idle Worker shim across a SIGTERM and fresh Core process.
#[tokio::test]
async fn idle_harness_poll_during_app_shutdown_preserves_nanohost_epoch() {
    let root = FixtureRoot(std::env::temp_dir().join(format!(
        "openkit-app-replacement-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    )));
    std::fs::create_dir(&root.0).unwrap();
    let host_root = root.0.join("host");
    std::fs::create_dir(&host_root).unwrap();
    let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nanocore");
    let mut old_app = AppPeer::start(&core, &root.0, None);
    let address = old_app.observation("old listener").await;
    let port = address["port"].as_u64().unwrap() as u16;
    let url = format!("http://127.0.0.1:{port}");
    let slot_paths = SlotPairPaths {
        slot_a_secret: host_root.join("token-a"),
        slot_a_companion: host_root.join("token-a-meta"),
        slot_b_secret: host_root.join("token-b"),
        slot_b_companion: host_root.join("token-b-meta"),
    };
    let selection_context = CredentialSelectionContext {
        identity_id: "nanohost-a".into(),
        deployment_id: address["deploymentId"].as_str().unwrap().to_owned(),
    };
    write_credential_slot(
        &slot_paths,
        CredentialSlot::A,
        &SlotWriteMaterial {
            token_id: "app-replacement-fixture".into(),
            issuance_generation: 1,
            identity_id: selection_context.identity_id.clone(),
            deployment_id: selection_context.deployment_id.clone(),
            secret: address["secret"].as_str().unwrap().to_owned(),
        },
    )
    .unwrap();
    let inputs = crate::NanoHostSessionInputs {
        rebuild_marker: host_root.join("fence-started"),
        transport: prepare_verified_session_transport(&url, &TlsTrustMaterial::Platform).unwrap(),
        rendezvous_url: url,
        slot_paths,
        selection_context,
    };
    let (mut coordinator, _) = EpochCoordinator::collection_fixture(&host_root);
    let reports = coordinator.fixture_invalidation_reports(&host_root);
    let physical_epoch = coordinator.physical_epoch().to_string();
    let projection = coordinator.outer_route_projection();
    let mut shim = Command::new("node")
        .arg("--import")
        .arg(core.join("node_modules/tsx/dist/loader.mjs"))
        .arg(core.join(
            "../../packages/worker-shim/src/test-support/nanohost-app-replacement-harness.ts",
        ))
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut shim_output = BufReader::new(shim.stdout.take().unwrap()).lines();
    let ports: HarnessPorts = tokio::time::timeout(DEADLINE, async {
        let ports = shim_output
            .next_line()
            .await
            .unwrap()
            .expect("shim loopback ports");
        let marker = shim_output.next_line().await.unwrap();
        assert_eq!(marker.as_deref(), Some("OPENKIT_WORKER_SHIM_ENTRY_V1"));
        serde_json::from_str(&ports).expect("valid shim loopback ports")
    })
    .await
    .expect("shim startup observations within the fixture deadline");
    assert_ne!(ports.integration_port, 0);
    assert_ne!(ports.native_port, 0);
    assert_ne!(ports.integration_port, ports.native_port);
    eprintln!(
        "Harness fixture loopback ports: integration={} native={}",
        ports.integration_port, ports.native_port
    );
    let shim_socket = TcpStream::connect(("127.0.0.1", ports.integration_port))
        .await
        .unwrap();
    // Supply the fixture's stock-forward byte boundary over loopback. The same
    // production route projection carries requests and resets across Core generations.
    let route = WatchedTask::new(tokio::spawn(async move {
        let mut connection = h2::server::handshake(shim_socket).await?;
        while let Some(incoming) = connection.accept().await {
            let (request, respond) = incoming?;
            let projection = projection.clone();
            tokio::spawn(async move {
                projection
                    .forward(
                        crate::sandbox_bridge::RouteFamily::WorkerControl,
                        request,
                        respond,
                        BINDING,
                    )
                    .await
            });
        }
        Ok(())
    }));
    let response = tokio::spawn(async move {
        let status = shim
            .wait()
            .await
            .map_err(|_| EpochFault::MemberExited(None))?;
        let exit_status = status.code().ok_or(EpochFault::MemberExited(None))?;
        Ok(WorkerBootstrapCompletion {
            monitor_exit: true,
            clean_response: true,
            exit_status,
        })
    });
    let bootstrap = WorkerBootstrapMonitor::from_test_task(response, route.clone());
    coordinator.fixture_watch_harness(&bootstrap).unwrap();

    let host = crate::run_sessions(
        inputs,
        coordinator,
        None,
        tokio::time::Instant::now() + crate::STARTUP_READINESS_HARD_LIMIT,
    );
    let replacement = async {
        let first = old_app.observation("idle Harness poll").await;
        assert_eq!(first["epoch"], physical_epoch);
        assert_eq!(first["generation"], 1);
        let host_pid = std::process::id();
        assert_eq!(
            old_app.observation("poll in flight").await["poll"],
            "in-flight"
        );
        let old_pid = old_app.process.id().unwrap();
        // This is the same signal delivered by an ordinary Docker stop.
        assert_eq!(
            unsafe { libc::kill(old_pid as libc::pid_t, libc::SIGTERM) },
            0
        );
        let shutdown = old_app.observation("poll during shutdown").await;
        assert_eq!(shutdown["poll"], "during-shutdown");
        // Keep the writer alive long enough for a delivered terminal response to reach the
        // supervised member. On transport loss the same loop survives the actual listener outage.
        tokio::time::sleep(Duration::from_millis(500)).await;
        old_app
            .process
            .stdin
            .take()
            .unwrap()
            .write_all(b"publish-close\n")
            .await
            .unwrap();
        let stopped = old_app.observation("durable predecessor close").await;
        assert_eq!(stopped["stopped"], true);
        assert_eq!(stopped["ready"], false);
        assert_eq!(stopped["generation"], first["generation"]);
        assert!(
            tokio::time::timeout(DEADLINE, old_app.process.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert_eq!(shutdown["streamDestroyed"], true);

        let mut new_app = AppPeer::start(&core, &root.0, Some(port));
        assert_eq!(
            new_app.observation("replacement listener").await["port"],
            port
        );
        assert_ne!(new_app.process.id().unwrap(), old_pid);
        let successor = new_app.observation("successor idle Harness poll").await;
        assert_eq!(successor["epoch"], physical_epoch);
        assert_eq!(
            successor["generation"],
            first["generation"].as_u64().unwrap() + 1
        );
        assert_eq!(successor["predecessorFenced"], true);
        assert_eq!(std::process::id(), host_pid);
        assert!(bootstrap.is_live());
        eprintln!(
            "NanoHost PID {host_pid} and Epoch {physical_epoch} survived generations {} -> {} with predecessor fencing",
            first["generation"], successor["generation"]
        );
        new_app
    };
    tokio::pin!(host);
    tokio::select! {
        biased;
        failure = &mut host => panic!("NanoHost ended during App replacement: {}", failure.unwrap_err()),
        _successor = replacement => {}
    }
    assert_eq!(std::fs::read_dir(reports).unwrap().count(), 0);
    route.abort();
    bootstrap.discard_after_sandbox_deletion();
}
