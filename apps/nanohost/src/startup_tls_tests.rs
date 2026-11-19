//! Initial TLS failure evidence through the production session loop.

use crate::credential_slots::{
    CredentialSelectionContext, CredentialSlot, SlotPairPaths, SlotWriteMaterial,
    write_credential_slot,
};
use crate::epoch_coordinator::EpochCoordinator;
use crate::nanocore_session::{
    OuterSessionDisposition, TlsTrustMaterial, prepare_verified_session_transport,
};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};

/// Initial TLS rejection must export its creation-failure report before fencing the partial Epoch.
#[tokio::test]
async fn initial_tls_rejection_exports_epoch_creation_failure() {
    let (mut peer, mut lines, input) =
        crate::nanocore_session::native_tls_tests::native_tls_peer(true).await;
    let (inputs, coordinator, reports) =
        startup_fixture(&peer, &input, input["port"].as_u64().unwrap() as u16);
    let root = peer.root.join("startup");
    let failure = tokio::time::timeout(
        Duration::from_secs(5),
        crate::run_sessions(
            inputs,
            coordinator,
            None,
            tokio::time::Instant::now() + crate::STARTUP_READINESS_HARD_LIMIT,
        ),
    )
    .await
    .expect("definite TLS rejection must not consume the startup timeout")
    .expect_err("a CA certificate used as the server leaf must fail closed");
    let crate::NanoHostRunFailure::OuterSession(ref classified) = failure else {
        panic!("TLS rejection must keep its closed outer-session classification");
    };
    assert_eq!(
        classified.reason(),
        "nanohost NanoCore TLS certificate verification failed"
    );
    assert_eq!(classified.disposition(), OuterSessionDisposition::Terminal);
    assert_eq!(classified.reconnect_after(), None);
    assert_eq!(
        classified.to_string(),
        "nanohost outer session failure: disposition=terminal stage=connect operation=none status=none"
    );
    std::io::Write::write_all(peer.child.stdin.as_mut().unwrap(), b"observe\n").unwrap();
    let observation = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("peer observation must be bounded")
        .unwrap()
        .expect("peer observation");
    let observation: serde_json::Value = serde_json::from_str(&observation).unwrap();
    assert_eq!(observation["requestCount"], 0);
    assert_eq!(observation["tokenPresentationCount"], 0);
    assert_eq!(observation["targetExists"], false);
    let reports = std::fs::read_dir(reports)
        .unwrap()
        .map(|entry| {
            serde_json::from_slice::<serde_json::Value>(
                &std::fs::read(entry.unwrap().path()).unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        reports.len(),
        1,
        "initial TLS rejection must export exactly one epoch-creation-failure report"
    );
    assert_eq!(reports[0]["trigger"], "epoch-creation-failure");
    assert_eq!(reports[0]["complete"], true);
    assert!(root.join("fence-started").is_file());
}

/// An accepted TCP connection that closes during ClientHello can precede the private listener.
#[tokio::test]
async fn initial_tls_io_close_retries_until_authenticated_readiness() {
    let (peer, mut lines, input) =
        crate::nanocore_session::native_tls_tests::native_tls_peer(false).await;
    let private_port = input["port"].as_u64().unwrap() as u16;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (inputs, coordinator, reports) =
        startup_fixture(&peer, &input, listener.local_addr().unwrap().port());
    let proxy = async {
        let (mut early, _) = listener.accept().await.unwrap();
        let mut client_hello = [0; 1];
        early.read_exact(&mut client_hello).await.unwrap();
        assert_eq!(client_hello, [0x16], "initial TCP accept must reach TLS");
        drop(early);
        let (mut client, _) = listener.accept().await.unwrap();
        let mut server = TcpStream::connect(("127.0.0.1", private_port))
            .await
            .unwrap();
        tokio::io::copy_bidirectional(&mut client, &mut server)
            .await
            .unwrap();
    };
    let host = crate::run_sessions(
        inputs,
        coordinator,
        None,
        tokio::time::Instant::now() + Duration::from_secs(5),
    );
    tokio::select! {
        failure = host => panic!("NanoHost ended before authenticated readiness: {}", failure.unwrap_err()),
        () = proxy => panic!("TLS proxy ended before authenticated readiness"),
        ready = tokio::time::timeout(Duration::from_secs(6), lines.next_line()) => {
            let ready: serde_json::Value = serde_json::from_str(&ready.unwrap().unwrap().unwrap()).unwrap();
            assert_eq!(ready["ready"], true);
            assert_eq!(ready["generation"], 1);
        }
    }
    assert_eq!(std::fs::read_dir(reports).unwrap().count(), 0);
}

/// Builds the same initial Epoch and credentials for both verified TLS outcomes.
fn startup_fixture(
    peer: &crate::nanocore_session::native_tls_tests::NativeTlsPeer,
    input: &serde_json::Value,
    port: u16,
) -> (
    crate::NanoHostSessionInputs,
    EpochCoordinator,
    std::path::PathBuf,
) {
    let root = peer.root.join("startup");
    std::fs::create_dir(&root).unwrap();
    let origin = format!("https://localhost:{port}");
    let slot_paths = SlotPairPaths {
        slot_a_secret: root.join("token-a"),
        slot_a_companion: root.join("token-a-metadata"),
        slot_b_secret: root.join("token-b"),
        slot_b_companion: root.join("token-b-metadata"),
    };
    let selection_context = CredentialSelectionContext {
        identity_id: "nanohost-a".into(),
        deployment_id: "deployment-a".into(),
    };
    write_credential_slot(
        &slot_paths,
        CredentialSlot::A,
        &SlotWriteMaterial {
            token_id: "startup-tls-fixture".into(),
            issuance_generation: 1,
            identity_id: selection_context.identity_id.clone(),
            deployment_id: selection_context.deployment_id.clone(),
            secret: input["secret"].as_str().unwrap().to_owned(),
        },
    )
    .unwrap();
    let inputs = crate::NanoHostSessionInputs {
        rebuild_marker: root.join("fence-started"),
        transport: prepare_verified_session_transport(
            &origin,
            &TlsTrustMaterial::ConfiguredRef {
                reference: peer.root.join("ca.pem").to_str().unwrap().to_owned(),
            },
        )
        .unwrap(),
        rendezvous_url: origin,
        slot_paths,
        selection_context,
    };
    let (mut coordinator, _) = EpochCoordinator::collection_fixture(&root);
    let reports = coordinator.fixture_invalidation_reports(&root);
    (inputs, coordinator, reports)
}
