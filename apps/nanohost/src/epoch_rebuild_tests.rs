//! Recovery fault injection through the production startup and loopback session owners.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::epoch_coordinator::{EpochCoordinator, EpochPlan};
use crate::epoch_evidence::{self, EpochEvidenceWriter, EpochInvalidationTrigger};
use crate::tests::loopback_session_inputs;

static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

struct FixtureRoot(PathBuf);

impl FixtureRoot {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "nanohost-rebuild-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Uses the real admission/readiness wire and reports only the first post-readiness poll.
async fn ready_peer(
    socket: tokio::net::TcpStream,
    ready: tokio::sync::oneshot::Sender<serde_json::Value>,
) {
    let mut connection = h2::server::handshake(socket).await.unwrap();
    let mut readiness = None;
    let mut ready = Some(ready);
    let mut admitted = false;
    while let Some(request) = connection.accept().await {
        let (request, mut respond) = request.unwrap();
        let path = request.uri().path().to_owned();
        let mut body = request.into_body();
        let mut bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.unwrap();
            body.flow_control().release_capacity(chunk.len()).unwrap();
            bytes.extend_from_slice(&chunk);
        }
        if path == "/api/nanohost/transport/session/admit" {
            assert!(!admitted);
            assert_eq!(bytes, b"{}");
            admitted = true;
            let mut response = respond
                .send_response(
                    http::Response::builder()
                        .status(200)
                        .header(
                            crate::nanocore_session::NANOHOST_TRANSPORT_REVISION_HEADER,
                            crate::nanocore_session::NANOHOST_TRANSPORT_REVISION.trim(),
                        )
                        .body(())
                        .unwrap(),
                    false,
                )
                .unwrap();
            response
                .send_data(
                    bytes::Bytes::from(
                        serde_json::to_vec(&serde_json::json!({
                            "connectionGeneration": 1, "deploymentId": "deployment-main",
                            "identityId": "integration_nanohost_main", "mayCarryWork": true,
                            "role": "authoritative"
                        }))
                        .unwrap(),
                    ),
                    true,
                )
                .unwrap();
        } else {
            assert!(admitted);
            if path == "/api/nanohost/transport/session/readiness" {
                assert!(readiness.is_none());
                readiness = Some(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
            } else {
                assert!(path.starts_with("/api/nanohost/transport/effects/"));
                assert!(!path.ends_with("/result"));
                if let Some(ready) = ready.take() {
                    ready
                        .send(readiness.clone().expect("readiness before polling"))
                        .unwrap();
                }
            }
            respond
                .send_response(
                    http::Response::builder().status(204).body(()).unwrap(),
                    true,
                )
                .unwrap();
        }
    }
}

/// An expired cross-process interval preserves both roots and evidence, then admits a fresh Epoch.
#[tokio::test]
async fn expired_rebuild_custodies_prior_roots_and_acknowledges_fresh_readiness() {
    let root = FixtureRoot::new();
    let state = root.0.join("state");
    let run = root.0.join("run");
    let marker = root.0.join("fence-started");
    let prior = "epoch-prior";
    fs::create_dir_all(state.join(prior)).unwrap();
    fs::create_dir_all(run.join(prior)).unwrap();
    fs::write(
        state.join(prior).join("gateway.db"),
        b"prior gateway evidence",
    )
    .unwrap();
    fs::write(
        run.join(prior).join("runtime-proof"),
        b"prior runtime evidence",
    )
    .unwrap();
    let retained = root.0.join("retained-worker");
    fs::write(&retained, b"retained worker bytes").unwrap();
    let started = SystemTime::now() - Duration::from_secs(301);
    epoch_evidence::record_fence_started_at(&marker, started).unwrap();
    let old_marker = fs::read(&marker).unwrap();
    let reports = root.0.join("reports");
    let mut evidence = EpochEvidenceWriter::new(reports.clone()).unwrap();
    let old_report = evidence
        .export_invalidation(EpochInvalidationTrigger::MemberExit, &[], Instant::now())
        .unwrap();
    let old_report_bytes = fs::read(&old_report.path).unwrap();
    let now = SystemTime::now();
    let (fence_started, deadline) =
        crate::prepare_epoch_rebuild(&state, &run, &marker, &mut evidence, now)
            .expect("expired interval must permit a new process attempt");
    assert_eq!(fence_started, Some(now));
    assert_eq!(
        epoch_evidence::observe_recovery_at(&state, &marker)
            .unwrap()
            .fence_started,
        Some(now)
    );
    assert!(!state.join(prior).exists());
    assert!(!run.join(prior).exists());
    let custody_name = format!(
        "rebuild-{}",
        started.duration_since(UNIX_EPOCH).unwrap().as_nanos()
    );
    let custody = root.0.join("state-recovery").join(&custody_name);
    assert_eq!(
        fs::read(custody.join(prior).join("gateway.db")).unwrap(),
        b"prior gateway evidence"
    );
    assert_eq!(
        fs::read(custody.join(".rebuild-fence-started")).unwrap(),
        old_marker
    );
    assert_eq!(
        fs::read(
            root.0
                .join("run-recovery")
                .join(&custody_name)
                .join(prior)
                .join("runtime-proof")
        )
        .unwrap(),
        b"prior runtime evidence"
    );
    assert_eq!(fs::read(&old_report.path).unwrap(), old_report_bytes);
    assert_eq!(fs::read(&retained).unwrap(), b"retained worker bytes");
    let notes: Vec<serde_json::Value> = fs::read_dir(&reports)
        .unwrap()
        .map(|entry| serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap())
        .filter(|value: &serde_json::Value| value["kind"] == "prior-epoch-disposition")
        .collect();
    assert_eq!(notes.len(), 1);
    assert!(
        notes[0]["fields"]["fence"]
            .as_str()
            .unwrap()
            .contains("rebuild_hard_bound_exceeded=true")
    );
    let plan = EpochPlan::fresh(
        &state,
        &run,
        &root.0.join("unused-gateway"),
        &["1.1.1.1".parse().unwrap()],
    )
    .unwrap();
    assert!(!plan.epoch_root().ends_with(prior));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let inputs = loopback_session_inputs(
        &root.0,
        &format!("http://{}", listener.local_addr().unwrap()),
    );
    let (mut coordinator, _) = EpochCoordinator::collection_fixture(&root.0);
    coordinator.fixture_invalidation_reports(&root.0);
    let physical_epoch = coordinator.physical_epoch().to_owned();
    let host = crate::run_sessions(inputs, coordinator, fence_started, deadline);
    tokio::pin!(host);
    let (socket, _) = tokio::select! {
        result = &mut host => panic!("Host ended before admission: {}", result.unwrap_err()),
        socket = listener.accept() => socket.unwrap(),
    };
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(ready_peer(socket, ready_tx));
    let ready = tokio::select! {
        result = &mut host => panic!("Host ended before readiness: {}", result.unwrap_err()),
        ready = tokio::time::timeout(Duration::from_secs(5), ready_rx) => ready.unwrap().unwrap(),
    };
    assert_eq!(ready, serde_json::json!({"physicalEpoch": physical_epoch}));
    assert!(
        !marker.exists(),
        "only acknowledged readiness consumes the replacement marker"
    );
    peer.abort();
    let _ = peer.await;
}

/// A future timestamp cannot prove elapsed recovery time or authorize removal of prior roots.
#[tokio::test]
async fn invalid_rebuild_clock_keeps_prior_roots_and_marker() {
    let root = FixtureRoot::new();
    let state = root.0.join("state");
    let run = root.0.join("run");
    let marker = root.0.join("fence-started");
    fs::create_dir_all(state.join("epoch-prior")).unwrap();
    fs::create_dir_all(run.join("epoch-prior")).unwrap();
    let now = SystemTime::now();
    epoch_evidence::record_fence_started_at(&marker, now + Duration::from_secs(301)).unwrap();
    let before = fs::read(&marker).unwrap();
    let mut evidence = EpochEvidenceWriter::new(root.0.join("reports")).unwrap();
    assert!(crate::prepare_epoch_rebuild(&state, &run, &marker, &mut evidence, now).is_err());
    assert!(state.join("epoch-prior").is_dir());
    assert!(run.join("epoch-prior").is_dir());
    assert_eq!(fs::read(&marker).unwrap(), before);
}

/// A 400-second Core outage spans three bounded process attempts without a permanent refusal.
#[tokio::test]
async fn startup_core_outage_across_three_processes_recovers_after_400_seconds() {
    let root = FixtureRoot::new();
    let state = root.0.join("state");
    let run = root.0.join("run");
    let marker = root.0.join("fence-started");
    fs::create_dir_all(state.join("epoch-initial")).unwrap();
    fs::create_dir_all(&run).unwrap();
    let mut evidence = EpochEvidenceWriter::new(root.0.join("reports")).unwrap();
    let reserved = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = reserved.local_addr().unwrap();
    drop(reserved);
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
    // SystemTime is explicit at the recovery boundary; Tokio time controls actual
    // TCP retries and deadlines. Keep the final synthetic wall time in the past
    // so the unmodified real readiness measurement still sees a valid interval.
    let wall_start = SystemTime::now() - Duration::from_secs(400);
    tokio::time::pause();
    let outage_started = tokio::time::Instant::now();
    for (attempt, at) in [0_u64, 150, 310].into_iter().enumerate() {
        let until_start = (outage_started + Duration::from_secs(at))
            .saturating_duration_since(tokio::time::Instant::now());
        tokio::time::advance(until_start).await;
        let (fence, deadline) = crate::prepare_epoch_rebuild(
            &state,
            &run,
            &marker,
            &mut evidence,
            wall_start + Duration::from_secs(at),
        )
        .expect("each process start must retain a supported recovery path");
        fs::create_dir(state.join(format!("epoch-process-{attempt}"))).unwrap();
        let inputs = loopback_session_inputs(&root.0, &format!("http://{address}"));
        let (mut coordinator, _) =
            EpochCoordinator::collection_fixture(&root.0.join(format!("process-{attempt}")));
        coordinator.fixture_invalidation_reports(&root.0);
        let physical_epoch = coordinator.physical_epoch().to_owned();
        let host = crate::run_sessions(inputs, coordinator, fence, deadline);
        tokio::pin!(host);
        if attempt < 2 {
            let started = tokio::time::Instant::now();
            let failure = host.await.unwrap_err();
            assert!(
                matches!(failure, crate::NanoHostRunFailure::OuterSession(ref failure)
                if failure.reason() == "outer-session startup hard bound exceeded")
            );
            let elapsed = tokio::time::Instant::now() - started;
            assert!(elapsed >= crate::STARTUP_READINESS_HARD_LIMIT);
            assert!(elapsed <= crate::STARTUP_READINESS_HARD_LIMIT + Duration::from_millis(1));
            assert!(marker.is_file());
            continue;
        }
        for _ in 0..100 {
            tokio::select! {
                biased;
                result = &mut host => panic!("Host ended during recoverable startup outage: {}", result.unwrap_err()),
                () = tokio::task::yield_now() => {}
            }
        }
        tokio::time::advance(Duration::from_secs(90)).await;
        assert_eq!(
            tokio::time::Instant::now() - outage_started,
            Duration::from_secs(400)
        );
        tokio::time::resume();
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let (socket, _) = tokio::select! {
            result = &mut host => panic!("Host ended before Core returned: {}", result.unwrap_err()),
            socket = tokio::time::timeout(Duration::from_secs(5), listener.accept()) => socket.unwrap().unwrap(),
        };
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(ready_peer(socket, ready_tx));
        let ready = tokio::select! {
            result = &mut host => panic!("Host ended before fresh readiness: {}", result.unwrap_err()),
            ready = tokio::time::timeout(Duration::from_secs(5), ready_rx) => ready.unwrap().unwrap(),
        };
        assert_eq!(ready, serde_json::json!({"physicalEpoch": physical_epoch}));
        assert!(tokio::time::Instant::now() <= deadline);
        assert!(!marker.exists());
        peer.abort();
        let _ = peer.await;
    }
}

/// A custody failure cannot renew the interval or destroy the prior persistent root.
#[tokio::test]
async fn expired_rebuild_with_unproved_runtime_root_stays_held() {
    use std::os::unix::fs::symlink;
    let root = FixtureRoot::new();
    let state = root.0.join("state");
    let run = root.0.join("run");
    let marker = root.0.join("fence-started");
    fs::create_dir_all(state.join("epoch-prior")).unwrap();
    fs::create_dir_all(&run).unwrap();
    let unrelated = root.0.join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::write(unrelated.join("bytes"), b"keep").unwrap();
    symlink(&unrelated, run.join("epoch-prior")).unwrap();
    let now = SystemTime::now();
    epoch_evidence::record_fence_started_at(&marker, now - Duration::from_secs(301)).unwrap();
    let before = fs::read(&marker).unwrap();
    let mut evidence = EpochEvidenceWriter::new(root.0.join("reports")).unwrap();
    assert!(crate::prepare_epoch_rebuild(&state, &run, &marker, &mut evidence, now).is_err());
    assert_eq!(fs::read(&marker).unwrap(), before);
    assert!(state.join("epoch-prior").is_dir());
    assert_eq!(fs::read(unrelated.join("bytes")).unwrap(), b"keep");
}

/// An interrupted pair of filesystem-local renames resumes the same custody set.
#[tokio::test]
async fn expired_rebuild_resumes_partial_custody_and_bounds_completed_sets() {
    let root = FixtureRoot::new();
    let state = root.0.join("state");
    let run = root.0.join("run");
    let marker = root.0.join("fence-started");
    let now = SystemTime::now();
    let started = now - Duration::from_secs(301);
    let set = format!(
        "rebuild-{}",
        started.duration_since(UNIX_EPOCH).unwrap().as_nanos()
    );
    let state_custody = root.0.join("state-recovery");
    let run_custody = root.0.join("run-recovery");
    fs::create_dir_all(state.join("epoch-prior")).unwrap();
    fs::write(
        state.join("epoch-prior").join("persistent"),
        b"persistent proof",
    )
    .unwrap();
    fs::create_dir_all(&run).unwrap();
    // Simulate interruption after the runtime root moved but before the state root moved.
    fs::create_dir_all(run_custody.join(&set).join("epoch-prior")).unwrap();
    fs::write(
        run_custody.join(&set).join("epoch-prior").join("volatile"),
        b"volatile proof",
    )
    .unwrap();
    for custody in [&state_custody, &run_custody] {
        fs::create_dir_all(custody.join("rebuild-1").join("epoch-older")).unwrap();
        fs::write(custody.join("unrelated"), b"keep unrelated").unwrap();
    }
    epoch_evidence::record_fence_started_at(&marker, started).unwrap();
    let mut evidence = EpochEvidenceWriter::new(root.0.join("reports")).unwrap();
    let (fence, _) =
        crate::prepare_epoch_rebuild(&state, &run, &marker, &mut evidence, now).unwrap();
    assert_eq!(fence, Some(now));
    assert_eq!(
        fs::read(
            state_custody
                .join(&set)
                .join("epoch-prior")
                .join("persistent")
        )
        .unwrap(),
        b"persistent proof"
    );
    assert_eq!(
        fs::read(run_custody.join(&set).join("epoch-prior").join("volatile")).unwrap(),
        b"volatile proof"
    );
    for custody in [&state_custody, &run_custody] {
        assert!(!custody.join("rebuild-1").exists());
        assert_eq!(
            fs::read(custody.join("unrelated")).unwrap(),
            b"keep unrelated"
        );
    }
}

/// A reboot may remove all volatile parents while persistent recovery state remains.
#[tokio::test]
async fn expired_rebuild_with_absent_runtime_parent_still_custodies_persistent_root() {
    let root = FixtureRoot::new();
    let state = root.0.join("state");
    let run = root.0.join("absent-volatile-parent/run");
    let marker = root.0.join("fence-started");
    fs::create_dir_all(state.join("epoch-prior")).unwrap();
    fs::write(
        state.join("epoch-prior").join("proof"),
        b"keep after reboot",
    )
    .unwrap();
    let now = SystemTime::now();
    let started = now - Duration::from_secs(301);
    epoch_evidence::record_fence_started_at(&marker, started).unwrap();
    let mut evidence = EpochEvidenceWriter::new(root.0.join("reports")).unwrap();
    let (fence, _) =
        crate::prepare_epoch_rebuild(&state, &run, &marker, &mut evidence, now).unwrap();
    assert_eq!(fence, Some(now));
    let set = format!(
        "rebuild-{}",
        started.duration_since(UNIX_EPOCH).unwrap().as_nanos()
    );
    assert_eq!(
        fs::read(
            root.0
                .join("state-recovery")
                .join(set)
                .join("epoch-prior/proof")
        )
        .unwrap(),
        b"keep after reboot"
    );
    assert!(!run.exists());
}
