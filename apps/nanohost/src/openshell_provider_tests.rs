//! Independent component oracles for the dormant generic bearer Provider adapter.
//!
//! These tests project the mechanism owner's strict policy and evidence rules.
//! They do not qualify a real Gateway, refresh mint, or canonical Core acceptance.

use openshell_sdk::raw::proto::datamodel::v1::ObjectMeta;
use openshell_sdk::raw::proto::{
    FilesystemPolicy, LandlockPolicy, NetworkBinary, NetworkEndpoint, NetworkMiddlewareConfig,
    NetworkPolicyRule, ProcessPolicy, Provider, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshStrategy, SandboxPolicy,
};
use serde_json::json;

use crate::openshell_provider_evidence::{
    normalize_provider, normalize_refresh_status, observation_summary,
};
use crate::openshell_provider_policy::verify_effective_policy;
use crate::openshell_provider_refresh::{ProviderFacilities, require_facilities};

const PROVIDER_LAYER: &str = "_provider_oki_deployment_workspace_grant";
const SENTINELS: [&str; 6] = [
    "secret-access-token-oracle",
    "secret-refresh-token-oracle",
    "Bearer secret-authorization-oracle",
    "private-account@example.invalid",
    "unknown-native-payload-oracle",
    "private-client-secret-oracle",
];

/// Build actual pinned SDK authority, independently of the candidate projector.
fn policy() -> SandboxPolicy {
    let endpoint = NetworkEndpoint {
        host: "api.example.invalid".into(),
        port: 443,
        protocol: "rest".into(),
        tls: "terminate".into(),
        enforcement: "enforce".into(),
        access: "read-only".into(),
        ..Default::default()
    };
    let rule = NetworkPolicyRule {
        name: PROVIDER_LAYER.into(),
        endpoints: vec![endpoint],
        binaries: vec![NetworkBinary {
            path: "/usr/bin/curl".into(),
            ..Default::default()
        }],
    };
    SandboxPolicy {
        version: 1,
        filesystem: Some(FilesystemPolicy {
            include_workdir: false,
            read_only: vec!["/usr".into(), "/etc".into()],
            read_write: vec!["/workspace".into()],
        }),
        landlock: Some(LandlockPolicy {
            compatibility: "best_effort".into(),
        }),
        process: Some(ProcessPolicy {
            run_as_user: "sandbox".into(),
            run_as_group: "sandbox".into(),
        }),
        network_policies: [(PROVIDER_LAYER.into(), rule)].into_iter().collect(),
        ..Default::default()
    }
}

fn endpoint(policy: &mut SandboxPolicy) -> &mut NetworkEndpoint {
    &mut policy
        .network_policies
        .get_mut(PROVIDER_LAYER)
        .unwrap()
        .endpoints[0]
}

fn assert_no_secrets(value: impl std::fmt::Debug) {
    let rendered = format!("{value:?}");
    for sentinel in SENTINELS {
        assert!(
            !rendered.contains(sentinel),
            "native secret escaped redaction"
        );
    }
}

#[test]
fn provider_policy_equality_covers_complete_authority_and_layer_set() {
    // Mechanism owner: exact effective-policy equality, never layer presence alone.
    let expected = policy();
    let digest = verify_effective_policy(&expected, &expected).unwrap();
    assert_eq!(digest.len(), 64);
    assert!(
        digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    assert_eq!(
        digest,
        verify_effective_policy(&expected, &expected.clone()).unwrap()
    );

    let mutations: [fn(&mut SandboxPolicy); 12] = [
        |p| {
            p.network_policies.remove(PROVIDER_LAYER);
        },
        |p| {
            p.network_policies.insert(
                "_provider_unexpected".into(),
                p.network_policies[PROVIDER_LAYER].clone(),
            );
        },
        |p| {
            p.network_policies.insert(
                "unexpected_base".into(),
                p.network_policies[PROVIDER_LAYER].clone(),
            );
        },
        |p| {
            endpoint(p).host = "other.example.invalid".into();
        },
        |p| {
            endpoint(p).port = 8443;
        },
        |p| {
            endpoint(p).access = "full".into();
        },
        |p| {
            endpoint(p).allow_encoded_slash = true;
        },
        |p| {
            p.network_policies.get_mut(PROVIDER_LAYER).unwrap().binaries[0].path =
                "/usr/bin/python3".into();
        },
        |p| {
            p.filesystem
                .as_mut()
                .unwrap()
                .read_write
                .push("/private".into());
        },
        |p| {
            p.filesystem.as_mut().unwrap().read_only.reverse();
        },
        |p| {
            p.process.as_mut().unwrap().run_as_user = "root".into();
        },
        |p| {
            p.landlock.as_mut().unwrap().compatibility = "hard_requirement".into();
        },
    ];
    for (index, mutate) in mutations.into_iter().enumerate() {
        let mut observed = expected.clone();
        mutate(&mut observed);
        assert!(
            verify_effective_policy(&expected, &observed).is_err(),
            "authority mutation {index} passed"
        );
    }
}

#[test]
fn provider_policy_digest_is_map_order_independent_and_binds_the_whole_policy() {
    let mut first = policy();
    let mut base = first.network_policies[PROVIDER_LAYER].clone();
    base.name = "base".into();
    first.network_policies.insert("base".into(), base);
    let mut second = first.clone();
    second.network_policies.clear();
    second
        .network_policies
        .insert("base".into(), first.network_policies["base"].clone());
    second.network_policies.insert(
        PROVIDER_LAYER.into(),
        first.network_policies[PROVIDER_LAYER].clone(),
    );
    let digest = verify_effective_policy(&first, &second).unwrap();
    assert_eq!(digest, verify_effective_policy(&second, &first).unwrap());
    second
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .push("/opt".into());
    assert_ne!(digest, verify_effective_policy(&second, &second).unwrap());
}

#[test]
fn provider_policy_missing_or_unsupported_authority_refuses_even_when_equal() {
    // Equal projections must not hide authority that this dormant adapter cannot enforce.
    let mutations: [fn(&mut SandboxPolicy); 17] = [
        |p| {
            p.version = 0;
        },
        |p| {
            p.filesystem = None;
        },
        |p| {
            p.landlock = None;
        },
        |p| {
            p.process = None;
        },
        |p| {
            endpoint(p).protocol = "unknown-protocol".into();
        },
        |p| {
            endpoint(p).tls = "unknown-tls".into();
        },
        |p| {
            endpoint(p).enforcement = "unknown-enforcement".into();
        },
        |p| {
            endpoint(p).access = "unknown-access".into();
        },
        |p| {
            endpoint(p).request_body_credential_rewrite = true;
        },
        |p| {
            endpoint(p).websocket_credential_rewrite = true;
        },
        |p| {
            endpoint(p).advisor_proposed = true;
        },
        |p| {
            endpoint(p).credential_signing = "sigv4".into();
        },
        |p| {
            endpoint(p).graphql_max_body_bytes = 1;
        },
        |p| {
            endpoint(p).json_rpc_max_body_bytes = 1;
        },
        |p| {
            endpoint(p).persisted_queries = "allow_registered".into();
        },
        |p| {
            endpoint(p).ports = vec![443, 8443];
        },
        |p| {
            p.network_middlewares.insert(
                "unqualified".into(),
                NetworkMiddlewareConfig {
                    name: "unqualified".into(),
                    middleware: "unknown-middleware".into(),
                    on_error: "fail_open".into(),
                    ..Default::default()
                },
            );
        },
    ];
    for (index, mutate) in mutations.into_iter().enumerate() {
        let mut invalid = policy();
        mutate(&mut invalid);
        assert!(
            verify_effective_policy(&invalid, &invalid).is_err(),
            "unsupported authority mutation {index} passed"
        );
        assert!(verify_effective_policy(&policy(), &invalid).is_err());
        assert!(verify_effective_policy(&invalid, &policy()).is_err());
    }
}

fn refresh_status() -> ProviderCredentialRefreshStatus {
    ProviderCredentialRefreshStatus {
        provider_name: SENTINELS[3].into(),
        provider_id: SENTINELS[4].into(),
        credential_key: SENTINELS[0].into(),
        strategy: ProviderCredentialRefreshStrategy::Oauth2RefreshToken as i32,
        status: "refreshed".into(),
        expires_at_ms: 2_000_000,
        next_refresh_at_ms: 1_900_000,
        last_refresh_at_ms: 1_000_000,
        last_error: SENTINELS.join(" "),
    }
}

#[test]
fn provider_refresh_evidence_allows_closed_operational_facts_only() {
    // Native names and errors are untrusted even when upstream calls logs secret-safe.
    for status in ["configured", "refreshed", "error", "rotation_requested"] {
        let mut native = refresh_status();
        native.status = status.into();
        let summary = normalize_refresh_status(&native).unwrap();
        assert!(summary.is_object());
        assert!(
            summary
                .as_object()
                .unwrap()
                .values()
                .any(|value| value == status)
        );
        assert_no_secrets(&summary);
    }
    for strategy in [
        ProviderCredentialRefreshStrategy::Static,
        ProviderCredentialRefreshStrategy::External,
        ProviderCredentialRefreshStrategy::Oauth2RefreshToken,
        ProviderCredentialRefreshStrategy::Oauth2ClientCredentials,
        ProviderCredentialRefreshStrategy::GoogleServiceAccountJwt,
    ] {
        let mut native = refresh_status();
        native.strategy = strategy as i32;
        assert_no_secrets(normalize_refresh_status(&native).unwrap());
    }
}

#[test]
fn provider_refresh_unknown_or_malformed_evidence_refuses_without_echo() {
    for strategy in [
        0,
        i32::MAX,
        ProviderCredentialRefreshStrategy::AwsStsAssumeRole as i32,
    ] {
        let mut native = refresh_status();
        native.strategy = strategy;
        let error = normalize_refresh_status(&native).unwrap_err();
        assert_no_secrets(error);
    }
    for status in ["", "active", SENTINELS[4]] {
        let mut native = refresh_status();
        native.status = status.into();
        assert_no_secrets(normalize_refresh_status(&native).unwrap_err());
    }
    let mut native = refresh_status();
    native.expires_at_ms = -1;
    assert_no_secrets(normalize_refresh_status(&native).unwrap_err());
}

#[test]
fn provider_record_evidence_drops_credentials_config_and_account_metadata() {
    let native = Provider {
        metadata: Some(ObjectMeta {
            id: SENTINELS[3].into(),
            name: SENTINELS[4].into(),
            workspace: SENTINELS[3].into(),
            labels: [("account".into(), SENTINELS[3].into())]
                .into_iter()
                .collect(),
            annotations: [("Authorization".into(), SENTINELS[2].into())]
                .into_iter()
                .collect(),
            ..Default::default()
        }),
        r#type: "okp-deployment-generic-v1".into(),
        credentials: [
            ("ACCESS_TOKEN".into(), SENTINELS[0].into()),
            ("refresh_token".into(), SENTINELS[1].into()),
        ]
        .into_iter()
        .collect(),
        config: [
            ("Authorization".into(), SENTINELS[2].into()),
            ("account".into(), SENTINELS[3].into()),
            ("unknown".into(), SENTINELS[4].into()),
            ("client_secret".into(), SENTINELS[5].into()),
        ]
        .into_iter()
        .collect(),
        credential_expires_at_ms: [(SENTINELS[3].into(), 2_000_000)].into_iter().collect(),
        profile_workspace: SENTINELS[3].into(),
    };
    let summary = normalize_provider(&native).unwrap();
    assert!(summary.is_object());
    assert_no_secrets(summary);
}

fn facilities() -> ProviderFacilities {
    ProviderFacilities {
        providers_v2: Some(true),
        effective_policy: Some(true),
        endpoint_override: Some(true),
        refresh_status: Some(true),
        stable_refresh_logs: Some(true),
    }
}

#[test]
fn provider_unknown_or_absent_required_facilities_refuse_the_profile() {
    assert!(require_facilities(&facilities(), true).is_ok());
    for unavailable in [None, Some(false)] {
        for field in 0..4 {
            let mut native = facilities();
            match field {
                0 => native.providers_v2 = unavailable,
                1 => native.effective_policy = unavailable,
                2 => native.endpoint_override = unavailable,
                3 => native.refresh_status = unavailable,
                _ => unreachable!(),
            }
            assert!(
                require_facilities(&native, true).is_err(),
                "unqualified required facility {field} passed"
            );
            if field < 2 {
                assert!(require_facilities(&native, false).is_err());
            }
        }
    }
    let mut static_only = facilities();
    static_only.endpoint_override = None;
    static_only.refresh_status = None;
    static_only.stable_refresh_logs = None;
    assert!(require_facilities(&static_only, false).is_ok());
}

#[test]
fn provider_refresh_audit_completeness_never_assumes_missing_upstream_observation() {
    for status in [None, Some(false), Some(true)] {
        for logs in [None, Some(false), Some(true)] {
            let mut native = facilities();
            native.refresh_status = status;
            native.stable_refresh_logs = logs;
            assert_eq!(
                observation_summary(&native),
                json!({
                    "refreshStatus": status == Some(true), "refreshLogs": logs == Some(true),
                    "complete": status == Some(true) && logs == Some(true),
                })
            );
        }
    }
}

#[test]
fn provider_production_admission_guards_remain_dormant() {
    // This bounded source guard proves these two retained refusals only.
    let main = include_str!("main.rs");
    assert!(main.contains("providers: Vec::new(),"));
    let core = include_str!("../../nanocore/src/runtime/turn-executor-factory.ts");
    let refusal = core
        .find("if ((context.providerCredentials?.length ?? 0) > 0) {")
        .unwrap();
    assert!(core[refusal..].starts_with("if ((context.providerCredentials?.length ?? 0) > 0) {\n      throw new Error('NanoHost Provider credential materialization is not supported.');\n    }"));
}

/// One fixture-owned H2 peer for the real pinned SDK transport, without Core or Gateway authority.
async fn sdk_peer(
    expected_paths: Vec<&'static str>,
    grpc_code: &'static str,
    protobuf_response: Vec<u8>,
) -> (openshell_sdk::OpenShellClient, tokio::task::JoinHandle<()>) {
    use bytes::Bytes;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut connection = h2::server::handshake(socket).await.unwrap();
        let mut paths = expected_paths.into_iter();
        let mut handlers = Vec::new();
        while let Some(stream) = connection.accept().await {
            let (request, mut respond) = match stream {
                // An unused SDK channel can close while H2 flushes control frames.
                // This is terminal teardown only; every actual RPC still needs its exact path.
                Err(error)
                    if paths.len() == 0
                        && error.get_io().is_some_and(|source| {
                            matches!(
                                source.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                            )
                        }) =>
                {
                    break;
                }
                stream => stream.unwrap(),
            };
            assert_eq!(request.uri().path(), paths.next().unwrap());
            assert!(!request.headers().contains_key("authorization"));
            let code = grpc_code;
            let payload = protobuf_response.clone();
            handlers.push(tokio::spawn(async move {
                let mut body = request.into_body();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                }
                if code != "0" {
                    let message = SENTINELS.join("%20");
                    respond
                        .send_response(
                            http::Response::builder()
                                .status(200)
                                .header("content-type", "application/grpc")
                                .header("grpc-status", code)
                                .header("grpc-message", message)
                                .body(())
                                .unwrap(),
                            true,
                        )
                        .unwrap();
                } else {
                    let mut stream = respond
                        .send_response(
                            http::Response::builder()
                                .status(200)
                                .header("content-type", "application/grpc")
                                .body(())
                                .unwrap(),
                            false,
                        )
                        .unwrap();
                    let mut frame = vec![0];
                    frame.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
                    frame.extend_from_slice(&payload);
                    stream.send_data(Bytes::from(frame), false).unwrap();
                    let mut trailers = http::HeaderMap::new();
                    trailers.insert("grpc-status", http::HeaderValue::from_static("0"));
                    stream.send_trailers(trailers).unwrap();
                }
            }));
            if paths.len() == 0 {
                connection.graceful_shutdown();
            }
        }
        assert_eq!(paths.len(), 0, "the deciding native RPC did not run");
        for handler in handlers {
            handler.await.unwrap();
        }
    });
    let client = openshell_sdk::OpenShellClient::connect(openshell_sdk::ClientConfig::new(
        format!("http://{address}"),
    ))
    .await
    .unwrap();
    (client, server)
}

#[tokio::test]
async fn provider_sdk_errors_are_closed_for_all_dormant_native_effects() {
    use crate::openshell_client::{
        dormant_provider_configure_refresh, dormant_provider_create, dormant_provider_import,
        dormant_provider_refresh_status,
    };
    use openshell_sdk::raw::proto::{
        ConfigureProviderRefreshRequest, GetProviderRefreshStatusRequest, ProviderProfile,
    };
    // Pinned stock method names, rather than a double of any SDK client method.
    const METHODS: [&str; 4] = [
        "/openshell.v1.OpenShell/ImportProviderProfiles",
        "/openshell.v1.OpenShell/CreateProvider",
        "/openshell.v1.OpenShell/ConfigureProviderRefresh",
        "/openshell.v1.OpenShell/GetProviderRefreshStatus",
    ];
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for code in ["12", "13"] {
            // UNIMPLEMENTED and INTERNAL must not echo upstream diagnostics.
            let (client, server) = sdk_peer(METHODS.to_vec(), code, Vec::new()).await;
            let profile = ProviderProfile {
                id: "okp-deployment-generic-v1".into(),
                ..Default::default()
            };
            assert_no_secrets(
                dormant_provider_import(&client, "deployment", profile)
                    .await
                    .unwrap_err(),
            );
            let provider = Provider {
                metadata: Some(ObjectMeta {
                    name: "oki-deployment-workspace-grant".into(),
                    ..Default::default()
                }),
                r#type: "okp-deployment-generic-v1".into(),
                ..Default::default()
            };
            assert_no_secrets(
                dormant_provider_create(&client, "deployment", provider)
                    .await
                    .unwrap_err(),
            );
            let request = ConfigureProviderRefreshRequest {
                provider: "oki-deployment-workspace-grant".into(),
                credential_key: "TOKEN".into(),
                strategy: ProviderCredentialRefreshStrategy::Oauth2RefreshToken as i32,
                material: [("refresh_token".into(), SENTINELS[1].into())]
                    .into_iter()
                    .collect(),
                secret_material_keys: vec!["refresh_token".into()],
                ..Default::default()
            };
            assert_no_secrets(
                dormant_provider_configure_refresh(&client, "deployment", request)
                    .await
                    .unwrap_err(),
            );
            let request = GetProviderRefreshStatusRequest {
                provider: "oki-deployment-workspace-grant".into(),
                credential_key: "TOKEN".into(),
                ..Default::default()
            };
            assert_no_secrets(
                dormant_provider_refresh_status(&client, "deployment", request)
                    .await
                    .unwrap_err(),
            );
            drop(client);
            server.await.unwrap();
        }
    })
    .await
    .expect("native SDK error fixture exceeded its bound");
}

/// Fixed protobuf fields from pinned openshell.proto: response.credentials=1;
/// status provider_name=1, provider_id=2, credential_key=3, strategy=4, status=5, last_error=9.
fn refresh_status_wire(status: &str) -> Vec<u8> {
    let mut native = Vec::new();
    for (tag, text) in [
        (0x0a, "oki-deployment-workspace-grant"),
        (0x12, SENTINELS[3]),
        (0x1a, "TOKEN"),
        (0x2a, status),
        (0x4a, SENTINELS[0]),
    ] {
        assert!(text.len() < 128);
        native.extend_from_slice(&[tag, text.len() as u8]);
        native.extend_from_slice(text.as_bytes());
    }
    native.extend_from_slice(&[0x20, 3]); // OAuth2 refresh-token strategy, pinned enum number.
    assert!(native.len() < 256);
    let mut response = vec![0x0a];
    if native.len() >= 128 {
        response.extend_from_slice(&[(native.len() as u8) | 0x80, 1]);
    } else {
        response.push(native.len() as u8);
    }
    response.extend_from_slice(&native);
    response
}

#[tokio::test]
async fn provider_sdk_status_decoding_reaches_redaction_and_unknown_status_refusal() {
    use crate::openshell_client::dormant_provider_refresh_status;
    use crate::openshell_provider::ProviderRefusal;
    use openshell_sdk::raw::proto::GetProviderRefreshStatusRequest;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for status in ["refreshed", SENTINELS[4]] {
            let (client, server) = sdk_peer(
                vec!["/openshell.v1.OpenShell/GetProviderRefreshStatus"],
                "0",
                refresh_status_wire(status),
            )
            .await;
            let observed = dormant_provider_refresh_status(
                &client,
                "deployment",
                GetProviderRefreshStatusRequest {
                    provider: "oki-deployment-workspace-grant".into(),
                    credential_key: "TOKEN".into(),
                    ..Default::default()
                },
            )
            .await;
            if status == "refreshed" {
                let rows = observed.unwrap();
                assert_eq!(rows.len(), 1);
                assert!(
                    rows[0]
                        .as_object()
                        .unwrap()
                        .values()
                        .any(|value| value == "refreshed")
                );
                assert_no_secrets(rows);
            } else {
                let error = observed.unwrap_err();
                assert_eq!(error, ProviderRefusal::EvidenceUnproved);
                assert_no_secrets(error);
            }
            drop(client);
            server.await.unwrap();
        }
    })
    .await
    .expect("native SDK status fixture exceeded its bound");
}

#[tokio::test]
async fn provider_sdk_foreign_deployment_identifiers_refuse_before_native_requests() {
    use crate::openshell_client::{
        dormant_provider_configure_refresh, dormant_provider_create, dormant_provider_import,
        dormant_provider_refresh_status,
    };
    use crate::openshell_provider::ProviderRefusal;
    use openshell_sdk::raw::proto::{
        ConfigureProviderRefreshRequest, GetProviderRefreshStatusRequest, ProviderProfile,
    };
    // Mechanism owner: a NanoHost must never mutate artifacts outside its own prefix.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (client, server) = sdk_peer(Vec::new(), "12", Vec::new()).await;
        assert_eq!(
            dormant_provider_import(
                &client,
                "deployment",
                ProviderProfile {
                    id: "okp-foreign-generic-v1".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err(),
            ProviderRefusal::NativeUnproved
        );
        for (name, profile) in [
            ("oki-foreign-workspace-grant", "okp-deployment-generic-v1"),
            ("oki-deployment-workspace-grant", "okp-foreign-generic-v1"),
        ] {
            assert_eq!(
                dormant_provider_create(
                    &client,
                    "deployment",
                    Provider {
                        metadata: Some(ObjectMeta {
                            name: name.into(),
                            ..Default::default()
                        }),
                        r#type: profile.into(),
                        ..Default::default()
                    }
                )
                .await
                .unwrap_err(),
                ProviderRefusal::NativeUnproved
            );
        }
        assert_eq!(
            dormant_provider_configure_refresh(
                &client,
                "deployment",
                ConfigureProviderRefreshRequest {
                    provider: "oki-foreign-workspace-grant".into(),
                    credential_key: "TOKEN".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err(),
            ProviderRefusal::NativeUnproved
        );
        assert_eq!(
            dormant_provider_refresh_status(
                &client,
                "deployment",
                GetProviderRefreshStatusRequest {
                    provider: "oki-foreign-workspace-grant".into(),
                    credential_key: "TOKEN".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err(),
            ProviderRefusal::NativeUnproved
        );
        drop(client);
        server.await.unwrap(); // The peer panics if it observes any RPC.
    })
    .await
    .expect("foreign-deployment native refusal fixture exceeded its bound");
}
