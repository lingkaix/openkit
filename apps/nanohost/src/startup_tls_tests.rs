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

/// Initial TLS rejection must export its creation-failure report before fencing the partial Epoch.
#[tokio::test]
async fn initial_tls_rejection_exports_epoch_creation_failure() {
    let (mut peer, mut lines, input) =
        crate::nanocore_session::native_tls_tests::native_tls_peer(true).await;
    let root = peer.root.join("startup");
    std::fs::create_dir(&root).unwrap();
    let origin = format!("https://localhost:{}", input["port"].as_u64().unwrap());
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
