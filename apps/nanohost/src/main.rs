//! NanoHost service binary entrypoint.
//!
//! This crate is the sole NanoHost Rust application. Internal role modules
//! mark responsibility boundaries inside one binary; they are not separate
//! crates or public interfaces.

mod credential_slots;
mod epoch_coordinator;
#[cfg(not(test))]
mod epoch_evidence;
mod image_acquisition;
mod image_store;
mod nanocore_session;
mod openshell_client;
mod openshell_release;
mod sandbox_bridge;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::read_to_string;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use credential_slots::{CredentialSelectionContext, SlotPairPaths};
use epoch_coordinator::{
    DockerImageBackend, EpochCoordinator, EpochPlan, RuntimeBackend, RuntimeEffectKind,
    configured_backend, resolve_epoch_nameservers,
};
use epoch_evidence::{
    AbsentEpochTrigger, EVIDENCE_ROOT, EpochEvidenceWriter, EpochInvalidationTrigger,
    REBUILD_HARD_LIMIT, clear_fence_started, measure_fence_to_ready, observe_recovery,
    record_fence_started,
};
use image_acquisition::BuildDefinition;
use image_store::ImageStore;
use nanocore_session::{
    OuterSessionDisposition, OuterSessionFailure, OuterSessionOperation, OuterSessionStage,
    PolledEffectCommand, TlsTrustMaterial, VerifiedSessionTransport,
};
use openshell_client::{
    LifecycleEffectKind, LifecycleEffectRequest, NanoHostOpenShellClient, WorkerBootstrapRequest,
};
use openshell_sdk::SandboxSpec;
use openshell_sdk::raw::proto::{
    FilesystemPolicy, L7Allow, L7Rule, LandlockPolicy, NetworkBinary, NetworkEndpoint,
    NetworkPolicyRule, ProcessPolicy, SandboxPolicy,
};
use sandbox_bridge::{
    FILE_EFFECT_MAX_BYTES, FileEffectKind, FileEffectPresence, FileEffectRequest,
    RetainedExportResult,
};

/// Parsed and verified NanoHost outer-session deployment inputs.
struct NanoHostSessionInputs {
    rendezvous_url: String,
    selection_context: CredentialSelectionContext,
    slot_paths: SlotPairPaths,
    transport: VerifiedSessionTransport,
}

/// Hard bound for restoring one successor outer-session connection.
const OUTER_SESSION_RECONNECT_BOUND: Duration = Duration::from_secs(300);

/// Delay between failed successor connection attempts.
const OUTER_SESSION_RECONNECT_DELAY: Duration = Duration::from_millis(250);

/// Delay after one complete fair cycle returns no pending effect.
const EFFECT_POLL_IDLE_DELAY: Duration = Duration::from_millis(100);

/// Returns the time left for one already-observed outer-session outage.
fn successor_connect_remaining(started_at: Option<Instant>) -> Option<Duration> {
    started_at.map(|started_at| OUTER_SESSION_RECONNECT_BOUND.saturating_sub(started_at.elapsed()))
}

/// Parses the required deployment image digests from one fixed environment value.
///
/// # Errors
///
/// Returns an error unless the value contains one to four unique canonical
/// lowercase SHA-256 digests separated only by commas.
fn parse_required_deployment_image_digests(
    value: Option<&str>,
) -> Result<BTreeSet<String>, &'static str> {
    let value = value
        .filter(|value| !value.is_empty())
        .ok_or("nanohost required deployment images missing")?;
    let mut digests = BTreeSet::new();
    for digest in value.split(',') {
        let valid = digest.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        });
        if !valid || !digests.insert(digest.to_string()) || digests.len() > 4 {
            return Err("nanohost required deployment images invalid");
        }
    }
    Ok(digests)
}

/// Parses and validates the sole `/etc/openkit/nanohost.env` projection.
///
/// # Errors
///
/// Returns a bounded non-secret error for a missing, empty, unknown, relative,
/// duplicate, downgrade, or invalid trust input. Raw Token environment keys are
/// rejected; only the declared slot files may contain credential material.
fn parse_nanohost_session_inputs(
    environment: &BTreeMap<String, String>,
) -> Result<NanoHostSessionInputs, &'static str> {
    const REQUIRED_KEYS: [&str; 8] = [
        "OPENKIT_NANOHOST_IDENTITY_ID",
        "OPENKIT_NANOHOST_DEPLOYMENT_ID",
        "OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL",
        "OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE",
        "OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE",
        "OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE",
        "OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE",
        "OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS",
    ];
    const OPTIONAL_CA_KEY: &str = "OPENKIT_NANOHOST_NANOCORE_CA_FILE";
    for key in environment
        .keys()
        .filter(|key| key.starts_with("OPENKIT_NANOHOST_"))
    {
        if !REQUIRED_KEYS.contains(&key.as_str()) && key != OPTIONAL_CA_KEY {
            return Err("nanohost session environment key rejected");
        }
    }
    let required = |key: &str| -> Result<String, &'static str> {
        environment
            .get(key)
            .filter(|value| !value.is_empty() && value.trim() == value.as_str())
            .cloned()
            .ok_or("nanohost session input missing or empty")
    };
    let identity_id = required("OPENKIT_NANOHOST_IDENTITY_ID")?;
    let deployment_id = required("OPENKIT_NANOHOST_DEPLOYMENT_ID")?;
    let rendezvous_url = required("OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL")?;
    let slot_paths = SlotPairPaths {
        slot_a_secret: PathBuf::from(required("OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE")?),
        slot_a_companion: PathBuf::from(required("OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE")?),
        slot_b_secret: PathBuf::from(required("OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE")?),
        slot_b_companion: PathBuf::from(required("OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE")?),
    };
    let slot_references = [
        &slot_paths.slot_a_secret,
        &slot_paths.slot_a_companion,
        &slot_paths.slot_b_secret,
        &slot_paths.slot_b_companion,
    ];
    if slot_references.iter().any(|path| !path.is_absolute())
        || slot_references
            .iter()
            .enumerate()
            .any(|(index, path)| slot_references[..index].contains(path))
    {
        return Err("nanohost credential slot references invalid");
    }
    parse_required_deployment_image_digests(
        environment
            .get("OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS")
            .map(String::as_str),
    )?;
    let trust = match environment.get(OPTIONAL_CA_KEY) {
        None => TlsTrustMaterial::Platform,
        Some(reference) if Path::new(reference).is_absolute() && !reference.is_empty() => {
            TlsTrustMaterial::ConfiguredRef {
                reference: reference.clone(),
            }
        }
        Some(_) => return Err("nanohost configured CA reference invalid"),
    };
    let transport = nanocore_session::prepare_verified_session_transport(&rendezvous_url, &trust)
        .map_err(|_| "nanohost rendezvous or trust input invalid")?;
    Ok(NanoHostSessionInputs {
        rendezvous_url,
        selection_context: CredentialSelectionContext {
            identity_id,
            deployment_id,
        },
        slot_paths,
        transport,
    })
}

/// One completed effect retained until its matching result is acknowledged.
enum ExecutedEffectResult {
    /// Existing bounded JSON result, including the exact optional-export absence fact.
    Json(serde_json::Value),
    /// Complete verified raw export tuple eligible for exact successor resend.
    FileExport(RetainedExportResult),
}

/// Parses one complete NanoCore-derived policy into the pinned OpenShell proto.
///
/// # Errors
///
/// Returns a bounded failure for every missing, unknown, malformed, or unsupported field.
fn parse_sandbox_policy(value: &serde_json::Value) -> Result<SandboxPolicy, &'static str> {
    let exact_keys = |object: &serde_json::Map<String, serde_json::Value>, keys: &[&str]| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    };
    let text = |value: &serde_json::Value| {
        value
            .as_str()
            .filter(|value| !value.is_empty() && !value.contains(['\r', '\n', '\0']))
            .map(str::to_string)
            .ok_or("sandbox policy string invalid")
    };
    let absolute_path = |value: &serde_json::Value| {
        let path = text(value)?;
        if !path.starts_with('/') {
            return Err("sandbox policy path must be absolute");
        }
        Ok(path)
    };
    let object = value.as_object().ok_or("sandbox policy invalid")?;
    if !exact_keys(
        object,
        &[
            "filesystem",
            "landlock",
            "networkMiddlewares",
            "networkPolicies",
            "process",
            "version",
        ],
    ) || object.get("version").and_then(serde_json::Value::as_u64) != Some(1)
    {
        return Err("sandbox policy invalid");
    }

    let filesystem = object
        .get("filesystem")
        .and_then(serde_json::Value::as_object)
        .ok_or("sandbox filesystem policy invalid")?;
    if !exact_keys(filesystem, &["includeWorkdir", "readOnly", "readWrite"]) {
        return Err("sandbox filesystem policy invalid");
    }
    let read_only = filesystem
        .get("readOnly")
        .and_then(serde_json::Value::as_array)
        .ok_or("sandbox filesystem policy invalid")?
        .iter()
        .map(&absolute_path)
        .collect::<Result<Vec<_>, _>>()?;
    let read_write = filesystem
        .get("readWrite")
        .and_then(serde_json::Value::as_array)
        .ok_or("sandbox filesystem policy invalid")?
        .iter()
        .map(&absolute_path)
        .collect::<Result<Vec<_>, _>>()?;
    let include_workdir = filesystem
        .get("includeWorkdir")
        .and_then(serde_json::Value::as_bool)
        .ok_or("sandbox filesystem policy invalid")?;

    let landlock = object
        .get("landlock")
        .and_then(serde_json::Value::as_object)
        .filter(|value| exact_keys(value, &["compatibility"]))
        .ok_or("sandbox Landlock policy invalid")?;
    let compatibility = text(
        landlock
            .get("compatibility")
            .ok_or("sandbox Landlock policy invalid")?,
    )?;
    let process = object
        .get("process")
        .and_then(serde_json::Value::as_object)
        .filter(|value| exact_keys(value, &["runAsGroup", "runAsUser"]))
        .ok_or("sandbox process policy invalid")?;
    let run_as_group = text(
        process
            .get("runAsGroup")
            .ok_or("sandbox process policy invalid")?,
    )?;
    let run_as_user = text(
        process
            .get("runAsUser")
            .ok_or("sandbox process policy invalid")?,
    )?;
    if !include_workdir
        || compatibility != "best_effort"
        || run_as_group != "sandbox"
        || run_as_user != "sandbox"
        || !object
            .get("networkMiddlewares")
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty)
    {
        return Err("sandbox policy fixed fields invalid");
    }

    let policies = object
        .get("networkPolicies")
        .and_then(serde_json::Value::as_object)
        .ok_or("sandbox network policies invalid")?;
    let mut network_policies = HashMap::new();
    for (key, value) in policies {
        let policy = value
            .as_object()
            .filter(|value| exact_keys(value, &["binaries", "endpoints", "name"]))
            .ok_or("sandbox network policy invalid")?;
        let name = text(policy.get("name").ok_or("sandbox network policy invalid")?)?;
        let mut identifier = name.bytes();
        if name != *key
            || !identifier
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            || !identifier.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err("sandbox network policy identity invalid");
        }
        let binaries = policy
            .get("binaries")
            .and_then(serde_json::Value::as_array)
            .filter(|value| !value.is_empty())
            .ok_or("sandbox network policy binaries invalid")?
            .iter()
            .map(|value| {
                let binary = value
                    .as_object()
                    .filter(|value| exact_keys(value, &["path"]))
                    .ok_or("sandbox network policy binary invalid")?;
                Ok(NetworkBinary {
                    path: absolute_path(
                        binary
                            .get("path")
                            .ok_or("sandbox network policy binary invalid")?,
                    )?,
                    ..NetworkBinary::default()
                })
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        let endpoint_values = policy
            .get("endpoints")
            .and_then(serde_json::Value::as_array)
            .filter(|value| value.len() == 1)
            .ok_or("sandbox network policy endpoint invalid")?;
        let endpoint = endpoint_values[0]
            .as_object()
            .ok_or("sandbox network policy endpoint invalid")?;
        let has_access = endpoint.contains_key("access");
        let has_rules = endpoint.contains_key("rules");
        let expected_endpoint_keys = if has_access {
            &["access", "enforcement", "host", "port", "protocol"][..]
        } else {
            &["enforcement", "host", "port", "protocol", "rules"][..]
        };
        if has_access == has_rules || !exact_keys(endpoint, expected_endpoint_keys) {
            return Err("sandbox network policy endpoint invalid");
        }
        let enforcement = text(
            endpoint
                .get("enforcement")
                .ok_or("sandbox network policy endpoint invalid")?,
        )?;
        if enforcement != "enforce" {
            return Err("sandbox network policy endpoint invalid");
        }
        let access = if has_access {
            let access = text(
                endpoint
                    .get("access")
                    .ok_or("sandbox network policy endpoint invalid")?,
            )?;
            if access != "read-only" && access != "read-write" {
                return Err("sandbox network policy endpoint invalid");
            }
            access
        } else {
            String::new()
        };
        let rules = if has_rules {
            endpoint
                .get("rules")
                .and_then(serde_json::Value::as_array)
                .filter(|value| !value.is_empty())
                .ok_or("sandbox network policy rules invalid")?
                .iter()
                .map(|value| {
                    let rule = value
                        .as_object()
                        .filter(|value| exact_keys(value, &["allow"]))
                        .ok_or("sandbox network policy rule invalid")?;
                    let allow = rule
                        .get("allow")
                        .and_then(serde_json::Value::as_object)
                        .filter(|value| exact_keys(value, &["method", "path"]))
                        .ok_or("sandbox network policy rule invalid")?;
                    let method = text(
                        allow
                            .get("method")
                            .ok_or("sandbox network policy rule invalid")?,
                    )?;
                    if method != "GET" && method != "POST" {
                        return Err("sandbox network policy rule invalid");
                    }
                    let path = text(
                        allow
                            .get("path")
                            .ok_or("sandbox network policy rule invalid")?,
                    )?;
                    if !path.starts_with('/') {
                        return Err("sandbox network policy rule invalid");
                    }
                    Ok(L7Rule {
                        allow: Some(L7Allow {
                            method,
                            path,
                            ..L7Allow::default()
                        }),
                    })
                })
                .collect::<Result<Vec<_>, &'static str>>()?
        } else {
            Vec::new()
        };
        let port = endpoint
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| *value > 0 && *value <= u16::MAX as u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("sandbox network policy endpoint invalid")?;
        let protocol = text(
            endpoint
                .get("protocol")
                .ok_or("sandbox network policy endpoint invalid")?,
        )?;
        if protocol != "rest" {
            return Err("sandbox network policy protocol invalid");
        }
        let host = text(
            endpoint
                .get("host")
                .ok_or("sandbox network policy endpoint invalid")?,
        )?;
        if host.trim().is_empty() {
            return Err("sandbox network policy host invalid");
        }
        network_policies.insert(
            key.clone(),
            NetworkPolicyRule {
                name,
                binaries,
                endpoints: vec![NetworkEndpoint {
                    host,
                    port,
                    protocol,
                    enforcement,
                    access,
                    rules,
                    ..NetworkEndpoint::default()
                }],
            },
        );
    }

    Ok(SandboxPolicy {
        version: 1,
        filesystem: Some(FilesystemPolicy {
            include_workdir,
            read_only,
            read_write,
        }),
        landlock: Some(LandlockPolicy { compatibility }),
        process: Some(ProcessPolicy {
            run_as_user,
            run_as_group,
        }),
        network_policies,
        network_middlewares: HashMap::new(),
    })
}

/// One bounded process-exit diagnostic from startup or the outer session.
enum NanoHostRunFailure {
    /// Existing fixed startup or Runtime Epoch message.
    Bounded(&'static str),
    /// Exact closed outer-session classification.
    OuterSession(OuterSessionFailure),
}

impl From<&'static str> for NanoHostRunFailure {
    /// Preserves one existing fixed bounded failure message.
    fn from(message: &'static str) -> Self {
        Self::Bounded(message)
    }
}

impl From<OuterSessionFailure> for NanoHostRunFailure {
    /// Preserves one exact terminal outer-session classification.
    fn from(failure: OuterSessionFailure) -> Self {
        Self::OuterSession(failure)
    }
}

impl std::fmt::Display for NanoHostRunFailure {
    /// Formats only an existing fixed message or the closed outer-session display.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bounded(message) => formatter.write_str(message),
            Self::OuterSession(failure) => std::fmt::Display::fmt(failure, formatter),
        }
    }
}

/// Parses the bounded secret-bearing environment used only by one Sandbox creation effect.
fn parse_sandbox_environment(
    value: Option<&serde_json::Value>,
) -> Result<HashMap<String, String>, &'static str> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let object = value
        .as_object()
        .filter(|entries| entries.len() <= 128)
        .ok_or("sandbox environment invalid")?;
    let mut environment = HashMap::with_capacity(object.len());
    for (name, value) in object {
        let mut bytes = name.bytes();
        let first = bytes.next().ok_or("sandbox environment invalid")?;
        if !(first.is_ascii_alphabetic() || first == b'_')
            || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err("sandbox environment invalid");
        }
        let value = value
            .as_str()
            .filter(|value| value.len() <= 65_536 && !value.contains('\0'))
            .ok_or("sandbox environment invalid")?;
        environment.insert(name.clone(), value.to_string());
    }
    Ok(environment)
}

/// Calls the one existing local owner selected by a fixed effect path.
///
/// # Errors
///
/// Rejects missing or malformed operation-specific input and preserves the
/// underlying owner's bounded failure instead of fabricating success.
fn execute_effect_command(
    coordinator: &mut EpochCoordinator,
    command: &mut PolledEffectCommand,
) -> Result<ExecutedEffectResult, &'static str> {
    let string = |name: &str| {
        command
            .input
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty() && !value.contains(['\r', '\n', '\0']))
            .ok_or("effect command field invalid")
    };
    match command.kind {
        RuntimeEffectKind::CreateSandbox
        | RuntimeEffectKind::DeleteSandbox
        | RuntimeEffectKind::CloseBridge => {
            let sandbox_id = string("sandboxId")?;
            let kind = match command.kind {
                RuntimeEffectKind::CreateSandbox => LifecycleEffectKind::CreateSandbox,
                RuntimeEffectKind::DeleteSandbox => LifecycleEffectKind::DeleteSandbox,
                RuntimeEffectKind::CloseBridge => LifecycleEffectKind::CloseBridge,
                _ => unreachable!("closed lifecycle branch"),
            };
            let request = LifecycleEffectRequest::new(
                &command.request_id,
                string("leaseId")?,
                sandbox_id,
                kind,
            );
            let create_spec = if command.kind == RuntimeEffectKind::CreateSandbox {
                Some(SandboxSpec {
                    name: Some(sandbox_id.to_string()),
                    image: Some(string("imageDigest")?.to_string()),
                    labels: HashMap::new(),
                    environment: parse_sandbox_environment(command.input.get("environment"))?,
                    providers: Vec::new(),
                    gpu: false,
                })
            } else {
                None
            };
            let create_policy = if command.kind == RuntimeEffectKind::CreateSandbox {
                Some(parse_sandbox_policy(
                    command
                        .input
                        .get("policy")
                        .ok_or("sandbox policy missing")?,
                )?)
            } else {
                None
            };
            let state = coordinator
                .execute_lifecycle_effect(&request, create_spec, create_policy, None)
                .map_err(|_| "lifecycle effect failed")?;
            Ok(ExecutedEffectResult::Json(serde_json::json!({
                "sandboxId": sandbox_id,
                "state": state,
            })))
        }
        RuntimeEffectKind::OpenBridge => {
            let sandbox_integration_binding_ref =
                string("sandboxIntegrationBindingRef")?.to_string();
            let sandbox_id = coordinator
                .current_sandbox_name()
                .map_err(|_| "bridge.open has no current Sandbox")?
                .to_string();
            let request = LifecycleEffectRequest::new(
                &command.request_id,
                &sandbox_integration_binding_ref,
                &sandbox_id,
                LifecycleEffectKind::OpenBridge,
            );
            let bootstrap = WorkerBootstrapRequest {
                sandbox_id: sandbox_id.clone(),
                request_id: command.request_id.clone(),
                sandbox_integration_binding_ref,
            };
            let state = coordinator
                .execute_lifecycle_effect(&request, None, None, Some(bootstrap))
                .map_err(|_| "bridge.open failed or unknown")?;
            Ok(ExecutedEffectResult::Json(serde_json::json!({
                "accepted": true,
                "integrationReady": true,
                "state": state,
            })))
        }
        RuntimeEffectKind::AcquireImage => {
            let evidence =
                coordinator.acquire_image(&command.request_id, string("imageReference")?)?;
            Ok(ExecutedEffectResult::Json(serde_json::json!({
                "digest": evidence.resulting_digest(),
            })))
        }
        RuntimeEffectKind::BuildImage => {
            let context_ref = string("contextRef")?.to_string();
            let arguments = command
                .input
                .get("arguments")
                .and_then(serde_json::Value::as_object)
                .ok_or("image.build arguments invalid")?
                .iter()
                .map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), value.to_string()))
                        .ok_or("image.build argument invalid")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let egress_grants = command
                .input
                .get("egress")
                .and_then(serde_json::Value::as_array)
                .ok_or("image.build egress invalid")?
                .iter()
                .map(|grant| {
                    let host = grant
                        .get("host")
                        .and_then(serde_json::Value::as_str)
                        .ok_or("image.build egress host invalid")?;
                    let port = grant
                        .get("port")
                        .and_then(serde_json::Value::as_u64)
                        .filter(|port| *port > 0 && *port <= u16::MAX as u64)
                        .ok_or("image.build egress port invalid")?;
                    Ok(format!("{host}:{port}"))
                })
                .collect::<Result<BTreeSet<_>, &'static str>>()?;
            let definition = BuildDefinition {
                context_ref,
                context_digest: string("contextDigest")?.to_string(),
                dockerfile: command
                    .input
                    .get("dockerfile")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("image.build Dockerfile input invalid")?
                    .to_string(),
                arguments,
                egress_grants,
                time_limit: Duration::from_secs(
                    command
                        .input
                        .get("timeLimitSeconds")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or("image.build time bound invalid")?,
                ),
                output_limit_bytes: command
                    .input
                    .get("outputLimitBytes")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or("image.build output bound invalid")?,
                layer_limit: command
                    .input
                    .get("layerLimit")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or("image.build layer bound invalid")?,
            };
            let evidence = coordinator.execute_image_build(
                &command.request_id,
                string("dockerfileDigest")?,
                string("argumentsDigest")?,
                definition,
            )?;
            Ok(ExecutedEffectResult::Json(serde_json::json!({
                "digest": evidence.resulting_digest(),
            })))
        }
        RuntimeEffectKind::ExportFile => {
            let max_byte_length = command
                .input
                .get("maxByteLength")
                .and_then(serde_json::Value::as_u64)
                .filter(|value| *value == FILE_EFFECT_MAX_BYTES)
                .ok_or("file.export maximum invalid")?;
            let presence = match string("presence")? {
                "required" => FileEffectPresence::Required,
                "optional" => FileEffectPresence::Optional,
                _ => return Err("file.export presence invalid"),
            };
            let request = FileEffectRequest {
                request_id: command.request_id.clone(),
                sandbox_id: string("sandboxId")?.to_string(),
                slot: string("slot")?.to_string(),
                relative_path: PathBuf::from(string("relativePath")?),
                sha256: String::new(),
                byte_length: max_byte_length,
                kind: FileEffectKind::ExportFile,
                presence,
            };
            let terminal_barrier_proved = command
                .input
                .get("terminalBarrierProved")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let final_status = command
                .input
                .get("finalStatusAccepted")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let process_group_absent = command
                .input
                .get("processGroupAbsent")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let retained_export_result = coordinator.export_file(
                &request,
                terminal_barrier_proved,
                final_status,
                process_group_absent,
            )?;
            Ok(match retained_export_result {
                Some(result) => ExecutedEffectResult::FileExport(result),
                None => ExecutedEffectResult::Json(serde_json::json!({"state": "absent"})),
            })
        }
        RuntimeEffectKind::ImportReference => {
            // The session owner has already verified `content-length` and the
            // `x-openkit-request-id`, `x-openkit-slot`,
            // `x-openkit-relative-path`, `x-openkit-sha256`, and
            // `x-openkit-byte-length` headers before exposing these bytes.
            let file_data = command
                .file_data
                .as_ref()
                .ok_or("reference.import raw body missing")?;
            let carriage = coordinator.import_reference(
                &command.request_id,
                &file_data.slot,
                &file_data.relative_path,
                &file_data.sha256,
                file_data.byte_length,
                &file_data.bytes,
            )?;
            let result: Result<serde_json::Value, &'static str> = Ok(serde_json::json!({
                "byteLength": carriage.byte_length(),
                "reference": carriage.complete()?,
            }));
            result.map(ExecutedEffectResult::Json)
        }
    }
}

/// Runs one fixed V1 Docker Runtime Epoch until a member exits.
///
/// # Errors
///
/// Returns a bounded non-secret message when planning, startup, or a member fails.
async fn run() -> Result<(), NanoHostRunFailure> {
    let environment = std::env::vars().collect::<BTreeMap<_, _>>();
    let session_inputs = parse_nanohost_session_inputs(&environment)?;
    let required_deployment = parse_required_deployment_image_digests(
        environment
            .get("OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS")
            .map(String::as_str),
    )?;
    if configured_backend("docker") != Ok(RuntimeBackend::Docker) {
        return Err("nanohost runtime backend rejected".into());
    }
    let resolver_source = read_to_string("/run/systemd/resolve/resolv.conf")
        .map_err(|_| "nanohost resolver source unavailable")?;
    let nameservers = resolve_epoch_nameservers(&resolver_source)
        .map_err(|_| "nanohost resolver source invalid")?;
    let mut evidence = EpochEvidenceWriter::new(PathBuf::from(EVIDENCE_ROOT))
        .map_err(|_| "nanohost evidence root unavailable")?;
    let recovery = observe_recovery(Path::new("/var/lib/openkit/nanohost"))
        .map_err(|_| "nanohost recovery observation failed")?;
    let mut fence_started = recovery.fence_started;
    if let Some(prior_epochs) = &recovery.absent_prior_epochs {
        let observed_fence = SystemTime::now();
        record_fence_started(observed_fence)
            .map_err(|_| "nanohost recovery measurement unavailable")?;
        fence_started = Some(observed_fence);
        let residual_inventory = format!(
            "processes=0 roots={} networks=0 sockets=0 sandboxes=0",
            recovery.residual_roots
        );
        evidence
            .export_absent_disposition(
                AbsentEpochTrigger::NanoHostCrash,
                &[
                    ("classification", "nanohost-absent"),
                    ("prior_epoch", prior_epochs.as_str()),
                    ("residual_inventory", residual_inventory.as_str()),
                    ("fence", "supervisor-start-boundary-proved"),
                ],
                Instant::now(),
            )
            .map_err(|_| "nanohost prior-epoch disposition unavailable")?;
    }
    recovery
        .remove_prior_epoch_roots(
            Path::new("/var/lib/openkit/nanohost"),
            Path::new("/run/openkit/nanohost"),
        )
        .map_err(|_| "nanohost prior-epoch cleanup failed")?;
    let mut image_store = Some(
        match ImageStore::open(
            PathBuf::from("/var/lib/openkit/nanohost-images"),
            PathBuf::from("/var/lib/openkit/nanohost"),
            &[PathBuf::from("/var/lib/openkit/nanohost-credentials")],
        ) {
            Ok(image_store) => image_store,
            Err(_) => {
                let _ = evidence.export_invalidation(
                    EpochInvalidationTrigger::EpochCreationFailure,
                    &[("fence", "not-started")],
                    Instant::now(),
                );
                return Err("nanohost image store unavailable".into());
            }
        },
    );
    let plan = match EpochPlan::fresh(
        Path::new("/var/lib/openkit/nanohost"),
        Path::new("/run/openkit/nanohost"),
        Path::new("/usr/lib/openkit/openshell-gateway"),
        &nameservers,
    ) {
        Ok(plan) => plan,
        Err(_) => {
            let _ = evidence.export_invalidation(
                EpochInvalidationTrigger::EpochCreationFailure,
                &[("fence", "not-started")],
                Instant::now(),
            );
            return Err("nanohost epoch planning failed".into());
        }
    };
    let mut image_backend = Some(DockerImageBackend::new(
        plan.docker_socket().to_path_buf(),
        plan.run_root().join("image-import"),
    ));
    let client = NanoHostOpenShellClient::new(
        plan.gateway_endpoint(),
        plan.gateway_auth_path().to_path_buf(),
    );
    let mut coordinator = EpochCoordinator::start(
        &plan,
        client,
        evidence,
        &mut image_store,
        &required_deployment,
        &mut image_backend,
    )
    .map_err(|_| "nanohost epoch startup failed")?;
    let selection_context = session_inputs.selection_context.clone();
    let route_projection = coordinator.outer_route_projection();
    let mut reconnect_after = None;
    let mut reconnect_started_at = None;
    let mut pending_result: Option<(PolledEffectCommand, ExecutedEffectResult)> = None;
    loop {
        let presentation = nanocore_session::select_and_present_credential(
            &session_inputs.slot_paths,
            &selection_context,
        );
        let terminal_connect = |reason| {
            OuterSessionFailure::terminal(
                OuterSessionStage::Connect,
                OuterSessionOperation::None,
                None,
                reason,
            )
            .with_reconnect_after(reconnect_after)
        };
        let io = loop {
            let connection = nanocore_session::connect_verified_session_transport(
                &session_inputs.rendezvous_url,
                &session_inputs.transport,
            );
            let connected = match successor_connect_remaining(reconnect_started_at) {
                Some(remaining) if remaining.is_zero() => {
                    return Err(terminal_connect(
                        "outer-session successor connection deadline expired",
                    )
                    .into());
                }
                Some(remaining) => {
                    tokio::time::timeout(remaining, connection)
                        .await
                        .map_err(|_| {
                            terminal_connect("outer-session successor connection deadline expired")
                        })?
                }
                None => connection.await,
            };
            match connected {
                Ok(io) => break io,
                Err(_reason) if reconnect_after.is_some() => {
                    let remaining =
                        successor_connect_remaining(reconnect_started_at).unwrap_or_default();
                    if remaining.is_zero() {
                        return Err(terminal_connect(
                            "outer-session successor connection deadline expired",
                        )
                        .into());
                    }
                    tokio::select! {
                        () = tokio::time::sleep(OUTER_SESSION_RECONNECT_DELAY.min(remaining)) => {}
                        _ = coordinator.wait() => {
                            return Err(terminal_connect("nanohost epoch member failed").into());
                        }
                    }
                }
                Err(reason) => {
                    return Err(terminal_connect(reason).into());
                }
            }
        };
        let readiness_fence = fence_started;
        let session_result = nanocore_session::run_outer_session(
            io,
            &session_inputs.rendezvous_url,
            &selection_context,
            &presentation,
            reconnect_after,
            move || {
                let Some(started) = readiness_fence else {
                    return Ok(None);
                };
                SystemTime::now()
                    .duration_since(started)
                    .ok()
                    .filter(|elapsed| measure_fence_to_ready(*elapsed, true).ready)
                    .and_then(|elapsed| REBUILD_HARD_LIMIT.checked_sub(elapsed))
                    .and_then(|remaining| tokio::time::Instant::now().checked_add(remaining))
                    .map(Some)
                    .ok_or_else(|| {
                        OuterSessionFailure::terminal(
                            OuterSessionStage::Readiness,
                            OuterSessionOperation::None,
                            None,
                            "epoch rebuild hard bound exceeded",
                        )
                    })
            },
            |generation, mut sender| {
                let readiness_commit = if fence_started.is_some() {
                    clear_fence_started().map_err(|_| {
                        OuterSessionFailure::terminal(
                            OuterSessionStage::Readiness,
                            OuterSessionOperation::None,
                            None,
                            "epoch rebuild marker could not be consumed",
                        )
                    })
                } else {
                    Ok(())
                };
                if readiness_commit.is_ok() {
                    fence_started = None;
                }
                let coordinator = &mut coordinator;
                let pending_result = &mut pending_result;
                let reconnect_started_at = &mut reconnect_started_at;
                let authority = session_inputs.rendezvous_url.as_str();
                let route_projection = route_projection.clone();
                async move {
                    readiness_commit?;
                    route_projection.bind(authority, sender.clone()).await;
                    *reconnect_started_at = None;
                    let mut cursor =
                        nanocore_session::effect_cursor_start(pending_result.is_some());
                    let mut empty_effect_polls = 0;
                    loop {
                        if let Some((command, result)) = pending_result.as_ref() {
                            let operation = OuterSessionOperation::from(command.kind);
                            let submission = tokio::select! {
                                submitted = async {
                                    match result {
                                        ExecutedEffectResult::Json(result) => {
                                            nanocore_session::submit_effect_result(
                                                authority,
                                                &mut sender,
                                                command,
                                                result.clone(),
                                            ).await
                                        }
                                        ExecutedEffectResult::FileExport(result) => {
                                            nanocore_session::submit_file_export_result(
                                                authority,
                                                &mut sender,
                                                command,
                                                result,
                                            ).await
                                        }
                                    }
                                } => submitted,
                                _ = coordinator.wait() => {
                                    return Err(OuterSessionFailure::terminal(
                                        OuterSessionStage::Result,
                                        operation,
                                        None,
                                        "nanohost epoch member failed",
                                    ));
                                }
                            };
                            if let Err(failure) = submission {
                                let retry_on_successor =
                                    failure.disposition() == OuterSessionDisposition::Reconnect;
                                if !retry_on_successor {
                                    *pending_result = None;
                                }
                                return Err(failure.with_reconnect_after(Some(generation)));
                            }
                            *pending_result = None;
                            continue;
                        }
                        let poll_kind = nanocore_session::effect_kind_for_cursor(cursor);
                        let poll_operation = OuterSessionOperation::from(poll_kind);
                        let polled_command = tokio::select! {
                            command = nanocore_session::poll_effect_command(
                                authority,
                                &mut sender,
                                &mut cursor,
                                coordinator.has_live_bridge(),
                            ) => command,
                            _ = coordinator.wait() => {
                                return Err(OuterSessionFailure::terminal(
                                    OuterSessionStage::Poll,
                                    poll_operation,
                                    None,
                                    "nanohost epoch member failed",
                                ));
                            }
                        };
                        let command = match polled_command {
                            Ok(command) => command,
                            Err(failure)
                                if matches!(
                                    failure.reason(),
                                    "bridge.open command delivery unknown"
                                        | "static Harness bridge command invalid"
                                ) =>
                            {
                                if coordinator.discard_unknown_bridge_command().is_err() {
                                    return Err(OuterSessionFailure::terminal(
                                        OuterSessionStage::Poll,
                                        OuterSessionOperation::OpenBridge,
                                        None,
                                        "bridge.open command cleanup uncertain",
                                    ));
                                }
                                return Err(OuterSessionFailure::terminal(
                                    OuterSessionStage::Poll,
                                    OuterSessionOperation::OpenBridge,
                                    None,
                                    failure.reason(),
                                )
                                .with_reconnect_after(Some(generation)));
                            }
                            Err(failure) => {
                                return Err(failure.with_reconnect_after(Some(generation)));
                            }
                        };
                        if command.is_none() {
                            empty_effect_polls += 1;
                            if empty_effect_polls == nanocore_session::EFFECT_OPERATION_COUNT {
                                tokio::time::sleep(EFFECT_POLL_IDLE_DELAY).await;
                                empty_effect_polls = 0;
                            }
                        } else {
                            empty_effect_polls = 0;
                        }
                        if let Some(mut command) = command {
                            let _ = writeln!(
                                std::io::stderr().lock(),
                                "nanohost effect accepted: operation={:?}",
                                OuterSessionOperation::from(command.kind)
                            );
                            // The coordinator retains the static Harness monitor and
                            // bridge plus terminal proof across successor reconnects.
                            let result = match execute_effect_command(coordinator, &mut command) {
                                Ok(result) => result,
                                Err("static Harness bridge command invalid") => {
                                    if coordinator.discard_unknown_bridge_command().is_err() {
                                        return Err(OuterSessionFailure::terminal(
                                            OuterSessionStage::Execute,
                                            OuterSessionOperation::OpenBridge,
                                            None,
                                            "bridge.open command cleanup uncertain",
                                        ));
                                    }
                                    return Err(OuterSessionFailure::terminal(
                                        OuterSessionStage::Execute,
                                        OuterSessionOperation::OpenBridge,
                                        None,
                                        "bridge.open command delivery unknown",
                                    ));
                                }
                                Err(_error)
                                    if matches!(
                                        command.kind,
                                        RuntimeEffectKind::AcquireImage
                                            | RuntimeEffectKind::BuildImage
                                    ) =>
                                {
                                    let operation = OuterSessionOperation::from(command.kind);
                                    let _ = writeln!(
                                        std::io::stderr().lock(),
                                        "nanohost effect failure: stage=execute operation={operation:?} reason={_error}"
                                    );
                                    if command.request_id.is_empty() {
                                        return Err(OuterSessionFailure::terminal(
                                            OuterSessionStage::Execute,
                                            operation,
                                            None,
                                            "effect command requestId invalid",
                                        ));
                                    }
                                    let failure_result = serde_json::json!({
                                        "failureCode": "effect_failed"
                                    });
                                    if command.kind == RuntimeEffectKind::BuildImage {
                                        command.input = serde_json::json!({});
                                    }
                                    let submission = tokio::select! {
                                        submitted = nanocore_session::submit_effect_result(
                                            authority,
                                            &mut sender,
                                            &command,
                                            failure_result.clone(),
                                        ) => submitted,
                                        _ = coordinator.wait() => {
                                            return Err(OuterSessionFailure::terminal(
                                                OuterSessionStage::Result,
                                                operation,
                                                None,
                                                "nanohost epoch member failed",
                                            ));
                                        }
                                    };
                                    if submission.is_ok() {
                                        continue;
                                    }
                                    let submission_failure = submission.expect_err(
                                        "typed failure submission was not acknowledged",
                                    );
                                    let delivery_uncertain = submission_failure.disposition()
                                        == OuterSessionDisposition::Reconnect;
                                    if delivery_uncertain {
                                        *pending_result = Some((
                                            command,
                                            ExecutedEffectResult::Json(failure_result),
                                        ));
                                        return Err(submission_failure
                                            .with_reconnect_after(Some(generation)));
                                    }
                                    return Err(
                                        submission_failure.with_reconnect_after(Some(generation))
                                    );
                                }
                                Err(error) => {
                                    let operation = match command.kind {
                                        RuntimeEffectKind::OpenBridge => {
                                            OuterSessionOperation::OpenBridge
                                        }
                                        RuntimeEffectKind::CreateSandbox => {
                                            OuterSessionOperation::CreateSandbox
                                        }
                                        RuntimeEffectKind::DeleteSandbox => {
                                            OuterSessionOperation::DeleteSandbox
                                        }
                                        RuntimeEffectKind::ImportReference => {
                                            OuterSessionOperation::ImportReference
                                        }
                                        RuntimeEffectKind::ExportFile => {
                                            OuterSessionOperation::ExportFile
                                        }
                                        RuntimeEffectKind::CloseBridge => {
                                            OuterSessionOperation::CloseBridge
                                        }
                                        RuntimeEffectKind::AcquireImage
                                        | RuntimeEffectKind::BuildImage => {
                                            unreachable!("definite image failure handled above")
                                        }
                                    };
                                    return Err(OuterSessionFailure::terminal(
                                        OuterSessionStage::Execute,
                                        operation,
                                        None,
                                        error,
                                    )
                                    .with_reconnect_after(Some(generation)));
                                }
                            };
                            if command.kind == RuntimeEffectKind::BuildImage {
                                command.input = serde_json::json!({});
                            }
                            *pending_result = Some((command, result));
                        }
                    }
                }
            },
        )
        .await;
        match session_result {
            Ok(generation) => reconnect_after = Some(generation),
            Err(failure) => match failure.disposition() {
                OuterSessionDisposition::Reconnect => {
                    reconnect_after = failure.reconnect_after();
                    reconnect_started_at.get_or_insert_with(Instant::now);
                }
                OuterSessionDisposition::Terminal => {
                    if matches!(
                        failure.reason(),
                        "epoch rebuild hard bound exceeded"
                            | "epoch rebuild marker could not be consumed"
                    ) {
                        coordinator.invalidate_startup();
                    }
                    return Err(failure.into());
                }
            },
        }
    }
}

/// Reports the binary version or starts the fixed NanoHost V1 Runtime Epoch.
fn main() {
    let mut args = std::env::args();
    let _program = args.next();
    let argument = args.next();
    let extra = args.next();
    if argument.as_deref() == Some("--version") && extra.is_none() {
        println!(env!("CARGO_PKG_VERSION"));
        return;
    }
    if argument.is_some() {
        eprintln!("nanohost arguments invalid");
        std::process::exit(1);
    }
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("nanohost TLS provider installation failed");
    let runtime =
        tokio::runtime::Runtime::new().expect("nanohost Tokio runtime construction failed");
    if let Err(message) = runtime.block_on(run()) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod openshell_upgrade_tests;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    use super::{
        OUTER_SESSION_RECONNECT_BOUND, OUTER_SESSION_RECONNECT_DELAY,
        parse_nanohost_session_inputs, parse_required_deployment_image_digests,
        parse_sandbox_environment, parse_sandbox_policy, successor_connect_remaining,
    };
    use crate::epoch_coordinator::{RuntimeBackend, configured_backend};
    use crate::nanocore_session::{OuterSessionFailure, OuterSessionOperation, OuterSessionStage};

    #[test]
    fn nanocore_authored_policy_reaches_current_sdk_and_rejects_invalid_grants() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/support/openshell-worker-policy.json"
        ))
        .expect("shared NanoCore-authored policy fixture");
        let policy = parse_sandbox_policy(&value).expect("NanoCore policy must reach the SDK");
        let filesystem = policy.filesystem.expect("filesystem grants");
        assert!(
            filesystem
                .read_only
                .contains(&"/opt/toolchains".to_string())
        );
        assert!(
            filesystem
                .read_write
                .contains(&"/sandbox/.cache/npm".to_string())
        );
        let direct = &policy.network_policies["direct_api"];
        assert_eq!(direct.binaries[0].path, "/usr/local/bin/codex");
        assert_eq!(direct.endpoints[0].access, "read-only");
        assert_eq!(direct.endpoints[0].enforcement, "enforce");
        let git = &policy.network_policies["github_git_read"].endpoints[0];
        assert!(git.access.is_empty());
        assert_eq!(git.rules.len(), 2);
        let read = git.rules[0].allow.as_ref().expect("exact GET rule");
        assert_eq!(
            (read.method.as_str(), read.path.as_str()),
            ("GET", "/**/info/refs*")
        );
        let upload = git.rules[1].allow.as_ref().expect("exact POST rule");
        assert_eq!(
            (upload.method.as_str(), upload.path.as_str()),
            ("POST", "/**/git-upload-pack")
        );

        let mut empty_binaries = value.clone();
        empty_binaries["networkPolicies"]["direct_api"]["binaries"] = serde_json::json!([]);
        assert!(parse_sandbox_policy(&empty_binaries).is_err());
        let mut ambiguous = value.clone();
        ambiguous["networkPolicies"]["github_git_read"]["endpoints"][0]["access"] =
            serde_json::json!("read-write");
        assert!(parse_sandbox_policy(&ambiguous).is_err());
        for (pointer, unsupported) in [
            ("/filesystem/readOnly/0", "relative/path"),
            ("/filesystem/readWrite/0", "relative/path"),
            (
                "/networkPolicies/direct_api/binaries/0/path",
                "relative/path",
            ),
            (
                "/networkPolicies/direct_api/endpoints/0/protocol",
                "unsupported",
            ),
            ("/networkPolicies/direct_api/endpoints/0/host", "   "),
        ] {
            let mut invalid = value.clone();
            *invalid.pointer_mut(pointer).expect("fixture grant exists") =
                serde_json::json!(unsupported);
            assert!(
                parse_sandbox_policy(&invalid).is_err(),
                "unsupported grant at {pointer}"
            );
        }
        let mut bad_name = value.clone();
        let mut entry = bad_name["networkPolicies"]
            .as_object_mut()
            .expect("policy map")
            .remove("direct_api")
            .expect("named policy");
        entry["name"] = serde_json::json!("bad/name");
        bad_name["networkPolicies"]["bad/name"] = entry;
        assert!(parse_sandbox_policy(&bad_name).is_err());
        let mut unknown = value;
        unknown["unrecognized"] = serde_json::json!(true);
        assert!(parse_sandbox_policy(&unknown).is_err());
    }

    /// Returns the exact non-secret execution-host environment projection.
    fn valid_nanohost_environment() -> BTreeMap<String, String> {
        [
            ("OPENKIT_NANOHOST_IDENTITY_ID", "integration_nanohost_main"),
            ("OPENKIT_NANOHOST_DEPLOYMENT_ID", "deployment-main"),
            (
                "OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL",
                "http://127.0.0.1:3000",
            ),
            (
                "OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE",
                "/etc/openkit/nanohost-token-a",
            ),
            (
                "OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE",
                "/etc/openkit/nanohost-token-a.json",
            ),
            (
                "OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE",
                "/etc/openkit/nanohost-token-b",
            ),
            (
                "OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE",
                "/etc/openkit/nanohost-token-b.json",
            ),
            (
                "OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
    }

    #[test]
    fn sandbox_environment_accepts_only_bounded_string_entries() {
        let accepted = serde_json::json!({
            "GITHUB_TOKEN": "secret-value",
            "_SECOND": "line one\nline two"
        });
        assert_eq!(
            parse_sandbox_environment(Some(&accepted))
                .expect("valid sandbox environment")
                .get("GITHUB_TOKEN")
                .map(String::as_str),
            Some("secret-value")
        );
        for rejected in [
            serde_json::json!([]),
            serde_json::json!({"bad-name": "secret"}),
            serde_json::json!({"VALID": 1}),
            serde_json::json!({"VALID": "contains\0nul"}),
        ] {
            assert!(parse_sandbox_environment(Some(&rejected)).is_err());
        }
    }

    #[test]
    fn nhc_imp_5q_successor_connect_retries_are_bounded() {
        assert_eq!(OUTER_SESSION_RECONNECT_BOUND, Duration::from_secs(300));
        assert_eq!(successor_connect_remaining(None), None);

        let remaining =
            successor_connect_remaining(Some(Instant::now())).expect("successor reconnect budget");
        assert!(remaining <= OUTER_SESSION_RECONNECT_BOUND);
        assert!(remaining > OUTER_SESSION_RECONNECT_BOUND - OUTER_SESSION_RECONNECT_DELAY);

        let expired = Instant::now()
            .checked_sub(OUTER_SESSION_RECONNECT_BOUND + Duration::from_secs(1))
            .expect("expired reconnect instant");
        assert_eq!(
            successor_connect_remaining(Some(expired)),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn wp3c_wp5_required_images_precede_epoch_and_outer_session_activation() {
        let digests = ['a', 'b', 'c', 'd', 'e']
            .map(|value| format!("sha256:{}", value.to_string().repeat(64)));
        assert_eq!(
            parse_required_deployment_image_digests(Some(&digests[0])),
            Ok([digests[0].clone()].into())
        );
        let four = digests[..4].join(",");
        assert_eq!(
            parse_required_deployment_image_digests(Some(&four)),
            Ok(digests[..4].iter().cloned().collect())
        );

        let uppercase = format!("sha256:{}", "A".repeat(64));
        let bare = "a".repeat(64);
        let spaced = format!("{}, {}", digests[0], digests[1]);
        let duplicate = format!("{},{}", digests[0], digests[0]);
        let five = digests.join(",");
        for rejected in [
            None,
            Some(""),
            Some(uppercase.as_str()),
            Some(bare.as_str()),
            Some(spaced.as_str()),
            Some(duplicate.as_str()),
            Some(five.as_str()),
        ] {
            assert!(
                parse_required_deployment_image_digests(rejected).is_err(),
                "accepted invalid required-image input {rejected:?}"
            );
        }

        let valid_environment = valid_nanohost_environment();
        assert!(parse_nanohost_session_inputs(&valid_environment).is_ok());
        for required in [
            "OPENKIT_NANOHOST_IDENTITY_ID",
            "OPENKIT_NANOHOST_DEPLOYMENT_ID",
            "OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL",
            "OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE",
            "OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE",
            "OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE",
            "OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE",
            "OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS",
        ] {
            let mut missing = valid_environment.clone();
            missing.remove(required);
            assert!(
                parse_nanohost_session_inputs(&missing).is_err(),
                "accepted missing {required}"
            );
            let mut empty = valid_environment.clone();
            empty.insert(required.to_string(), String::new());
            assert!(
                parse_nanohost_session_inputs(&empty).is_err(),
                "accepted empty {required}"
            );
        }
        for (key, value) in [
            (
                "OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL",
                "http://nanocore.example:3000",
            ),
            ("OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE", "relative/a"),
            ("OPENKIT_NANOHOST_NANOCORE_CA_FILE", "relative/ca.pem"),
        ] {
            let mut rejected = valid_environment.clone();
            rejected.insert(key.to_string(), value.to_string());
            assert!(
                parse_nanohost_session_inputs(&rejected).is_err(),
                "accepted invalid {key}"
            );
        }
        let mut duplicate_slots = valid_environment.clone();
        duplicate_slots.insert(
            "OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE".to_string(),
            "/etc/openkit/nanohost-token-a".to_string(),
        );
        assert!(parse_nanohost_session_inputs(&duplicate_slots).is_err());
        let mut raw_token = valid_environment.clone();
        raw_token.insert(
            "OPENKIT_NANOHOST_TOKEN".to_string(),
            "okt_forbidden_environment_material".to_string(),
        );
        assert!(parse_nanohost_session_inputs(&raw_token).is_err());

        let production = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("main production section");
        let run = production
            .split_once("fn run()")
            .expect("NanoHost run path")
            .1
            .split_once("fn main()")
            .expect("end of NanoHost run path")
            .0;
        let binding_start = run
            .find("parse_nanohost_session_inputs(")
            .expect("bounded NanoHost session-input parsing");
        let required_binding = run[binding_start..]
            .split_once(';')
            .expect("complete required deployment binding")
            .0;
        let binding_end = binding_start + required_binding.len() + 1;
        let evidence = run
            .find("EpochEvidenceWriter::new")
            .expect("private evidence writer");
        let recovery = run.find("observe_recovery(").expect("recovery observation");
        let image_store = run.find("ImageStore::open").expect("Image Store open");
        let plan = run.find("EpochPlan::fresh").expect("Runtime Epoch plan");
        let image_backend = run
            .find("DockerImageBackend::new")
            .expect("private image backend");
        let start = run
            .find("EpochCoordinator::start(")
            .expect("Runtime Epoch start");
        let session_activation = run
            .find("run_outer_session(")
            .expect("authoritative NanoCore HTTP/2 client activation");
        for (owner, first_effect) in [
            ("evidence writer", evidence),
            ("recovery observation", recovery),
            ("Image Store", image_store),
            ("Runtime Epoch plan", plan),
            ("private image backend", image_backend),
        ] {
            assert!(
                binding_end < first_effect,
                "required deployment parsing occurs after {owner}"
            );
        }
        assert!(!run[..start].contains("let required_deployment = BTreeSet::new()"));
        assert!(
            run[start..]
                .split_once(".map_err")
                .expect("bounded Runtime Epoch start")
                .0
                .contains("&required_deployment")
        );
        assert!(start < session_activation);

        let (session_call, after_session_call) = run[session_activation..]
            .split_once("\n        .await;\n        match session_result")
            .expect("awaited outer-session runner");
        for required_input in [
            "session_inputs.rendezvous_url",
            "selection_context",
            "presentation",
            "reconnect_after",
        ] {
            assert!(
                session_call.contains(required_input),
                "outer-session activation omits {required_input}"
            );
        }
        assert!(!session_call.contains("|_generation, _sender|"));
        assert!(!session_call.contains("std::future::pending"));
        assert!(session_call.contains("coordinator.wait()"));
        assert!(session_call.contains("execute_effect_command(coordinator"));
        assert!(session_call.contains("route_projection"));
        let effect_owner = production
            .split_once("fn execute_effect_command(")
            .expect("fixed effect execution owner")
            .1
            .split_once("async fn run()")
            .expect("end of fixed effect execution owner")
            .0;
        assert!(effect_owner.contains("final_status"));
        assert!(effect_owner.contains("process_group_absent"));
        let epoch_source = include_str!("epoch_coordinator.rs");
        let export_owner = epoch_source
            .split_once("pub fn export_file(")
            .expect("terminal file export owner")
            .1
            .split_once("/// Waits for the monitor")
            .expect("end of terminal file export owner")
            .0;
        assert!(
            !export_owner.contains("monitor_exit"),
            "per-Turn export must not consume the Harness-lifetime monitor exit"
        );
        let bridge_owner = production
            .split_once("RuntimeEffectKind::OpenBridge =>")
            .expect("static Harness bridge owner")
            .1
            .split_once("RuntimeEffectKind::CloseBridge =>")
            .expect("end of static Harness bridge owner")
            .0;
        assert!(bridge_owner.contains("string(\"sandboxIntegrationBindingRef\")"));
        assert!(bridge_owner.contains("WorkerBootstrapRequest"));
        assert!(bridge_owner.contains("sandbox_integration_binding_ref"));
        assert!(!session_call.contains("workerControlToken"));
        assert!(!session_call.contains("workerInferenceToken"));
        assert!(!run.contains("spawn_blocking(move ||"));
        assert!(!after_session_call.contains("coordinator.wait()"));

        let build_command = production
            .split_once("RuntimeEffectKind::BuildImage =>")
            .expect("image.build command owner")
            .1
            .split_once("RuntimeEffectKind::ExportFile")
            .expect("end of image.build command owner")
            .0;
        let context_ref_parse = build_command
            .find("string(\"contextRef\")")
            .expect("resolved empty-context reference parse");
        let definition = build_command
            .find("let definition = BuildDefinition")
            .expect("build definition construction");
        let coordinator = build_command
            .find("coordinator.execute_image_build")
            .expect("attempt-local build dispatch");
        assert!(context_ref_parse < definition);
        assert!(definition < coordinator);

        let file_effects = production
            .split_once("RuntimeEffectKind::ExportFile")
            .expect("directional file-effect parsing")
            .1
            .split_once("Ok(serde_json::json!")
            .expect("file-effect result projection")
            .0;
        assert!(!file_effects.starts_with(" | RuntimeEffectKind::ImportReference"));
        for field in [
            "maxByteLength",
            "terminalBarrierProved",
            "content-length",
            "x-openkit-request-id",
            "x-openkit-relative-path",
        ] {
            assert!(
                file_effects.contains(field),
                "missing directional field {field}"
            );
        }

        let unit = include_str!("../deploy/openkit-nanohost.service");
        assert!(unit.contains("EnvironmentFile=/etc/openkit/nanohost.env"));
        assert!(!unit.contains("okt_"));
    }

    #[test]
    fn nhc_imp_5o_resolves_the_fixed_nameserver_source_before_epoch_planning() {
        let production = include_str!("main.rs")
            .split_once("#[cfg(test)]")
            .expect("main production section")
            .0;
        let run = production
            .split_once("async fn run()")
            .expect("NanoHost async run path")
            .1
            .split_once("\nfn main()")
            .expect("end of NanoHost run path")
            .0;
        let resolver_source = run
            .find("/run/systemd/resolve/resolv.conf")
            .expect("fixed resolver source");
        let resolver_validation = run
            .find("resolve_epoch_nameservers")
            .expect("resolver validation");
        let epoch_plan = run.find("EpochPlan::fresh").expect("epoch planning");

        assert_eq!(run.matches("/run/systemd/resolve/resolv.conf").count(), 1);
        assert!(resolver_source < resolver_validation && resolver_validation < epoch_plan);
    }

    #[test]
    fn wp3a_u3a1_accepts_only_the_closed_docker_backend() {
        assert_eq!(configured_backend("docker"), Ok(RuntimeBackend::Docker));

        for backend in ["", "containerd", "podman", "external", "custom"] {
            assert!(
                configured_backend(backend).is_err(),
                "accepted backend {backend}"
            );
        }
    }

    #[test]
    fn wp5_f6_returns_the_bounded_session_error_after_coordinator_teardown() {
        let production = include_str!("main.rs")
            .split_once("#[cfg(test)]")
            .expect("main production section")
            .0;
        let run = production
            .split_once("async fn run()")
            .expect("NanoHost async run path")
            .1
            .split_once("\nfn main()")
            .expect("end of NanoHost run path")
            .0;
        let coordinator = run
            .find("let mut coordinator = EpochCoordinator::start(")
            .expect("Runtime Epoch coordinator creation");
        let session = run
            .find("nanocore_session::run_outer_session(")
            .expect("post-readiness outer session");
        let classified = run
            .find("match failure.disposition()")
            .expect("classified outer-session disposition");
        let reconnect = run[classified..]
            .find("OuterSessionDisposition::Reconnect")
            .map(|offset| classified + offset)
            .expect("silent reconnect disposition");
        let terminal = run[classified..]
            .find("OuterSessionDisposition::Terminal => {")
            .map(|offset| classified + offset)
            .expect("original terminal classification return");
        assert!(coordinator < session && session < classified);
        assert!(classified <= reconnect && reconnect < terminal);
        assert!(run[reconnect..terminal].contains("reconnect_after = failure.reconnect_after();"));
        let terminal_path = &run[terminal..];
        assert!(terminal_path.contains("coordinator.invalidate_startup();"));
        assert!(terminal_path.contains("return Err(failure.into());"));
        assert!(!run[reconnect..terminal].contains("eprintln!"));
        assert!(!run.contains("nanohost outer session failed"));
        assert!(!run.contains("std::mem::forget(coordinator)"));

        let run_failure_display = production
            .split_once("impl std::fmt::Display for NanoHostRunFailure")
            .expect("bounded run failure display")
            .1
            .split_once("/// Calls the one existing local owner")
            .expect("end of run failure display")
            .0;
        assert!(
            run_failure_display.contains(
                "Self::OuterSession(failure) => std::fmt::Display::fmt(failure, formatter)"
            )
        );

        let main = production
            .split_once("if let Err(message) = runtime.block_on(run())")
            .expect("Tokio runtime failure branch")
            .1;
        assert!(main.contains("eprintln!(\"{message}\")"));
    }

    #[test]
    fn wp5_r8_orders_verified_image_input_before_build_and_retains_only_results() {
        let production = include_str!("main.rs")
            .split_once("#[cfg(test)]")
            .expect("main production section")
            .0;
        let build = production
            .split_once("RuntimeEffectKind::BuildImage =>")
            .expect("image.build owner")
            .1
            .split_once("RuntimeEffectKind::ExportFile =>")
            .expect("end of image.build owner")
            .0;
        let definition = build
            .find("let definition = BuildDefinition")
            .expect("verified build definition");
        let execution = build
            .find("coordinator.execute_image_build(")
            .expect("existing image build owner");
        assert!(definition < execution);
        assert!(
            !build.contains("string(\"dockerfile\")"),
            "generic control JSON must not be Dockerfile byte authority"
        );
        assert!(!build.contains("dockerfileByteLength"));

        let run = production
            .split_once("async fn run()")
            .expect("NanoHost run path")
            .1
            .split_once("\nfn main()")
            .expect("end of NanoHost run path")
            .0;
        let poll = run
            .find("poll_effect_command(")
            .expect("accepted metadata and input poll");
        let local_effect = run
            .find("execute_effect_command(coordinator, &mut command)")
            .expect("local effect dispatch");
        assert!(poll < local_effect);
        assert!(
            run.contains("empty_effect_polls == nanocore_session::EFFECT_OPERATION_COUNT")
                && run.contains("tokio::time::sleep(EFFECT_POLL_IDLE_DELAY).await"),
            "one fully empty fair poll cycle must yield before polling again"
        );
        let definite_failure = &run[local_effect..];
        assert!(definite_failure.contains("RuntimeEffectKind::BuildImage"));
        assert!(definite_failure.contains("\"failureCode\": \"effect_failed\""));
        assert!(definite_failure.contains("continue;"));
        let retained = definite_failure
            .split_once("pending_result = Some((")
            .expect("successor-only retained result")
            .1
            .split_once("return Err(submission_failure")
            .expect("result-only reconnect return")
            .0;
        assert!(retained.contains("failure_result"));
        assert!(!retained.contains("dockerfile"));
    }

    #[test]
    fn wp5_r7_reports_definite_effect_failure_once_and_keeps_reconnect_silent() {
        let production = include_str!("main.rs")
            .split_once("#[cfg(test)]")
            .expect("main production section")
            .0;
        let run = production
            .split_once("async fn run()")
            .expect("NanoHost run path")
            .1
            .split_once("\nfn main()")
            .expect("end of NanoHost run path")
            .0;
        let connect_failure = OuterSessionFailure::terminal(
            OuterSessionStage::Connect,
            OuterSessionOperation::None,
            None,
            "nanohost NanoCore rendezvous failed",
        );
        assert_eq!(
            connect_failure.to_string(),
            "nanohost outer session failure: disposition=terminal stage=connect operation=none status=none"
        );
        assert!(
            !connect_failure
                .to_string()
                .contains("nanohost NanoCore rendezvous failed")
        );
        let connect = run
            .split_once("let terminal_connect = |reason|")
            .expect("bounded rendezvous connect loop")
            .1
            .split_once("let session_result = nanocore_session::run_outer_session(")
            .expect("end of rendezvous connect handling")
            .0;
        assert!(connect.contains("connect_verified_session_transport("));
        assert!(connect.contains("successor_connect_remaining(reconnect_started_at)"));
        assert!(connect.contains("tokio::time::timeout(remaining, connection)"));
        assert!(connect.contains("Err(_reason) if reconnect_after.is_some()"));
        assert!(
            connect.contains("tokio::time::sleep(OUTER_SESSION_RECONNECT_DELAY.min(remaining))")
        );
        assert!(connect.contains("Err(reason) =>"));
        assert!(connect.contains("OuterSessionFailure::terminal("));
        assert!(connect.contains("OuterSessionStage::Connect"));
        assert!(connect.contains("OuterSessionOperation::None"));
        assert!(connect.contains("reason"));
        assert!(connect.contains(".into()"));
        assert!(!connect.contains(".await?;"));
        let typed_failure = run
            .find("\"failureCode\": \"effect_failed\"")
            .expect("exact ordinary typed-failure result");
        let failure_path = &run[typed_failure.saturating_sub(600)..];
        assert!(failure_path.contains("command.request_id"));
        assert!(failure_path.contains("submit_effect_result("));
        assert!(failure_path.contains("continue;"));
        assert!(
            !failure_path[..failure_path.find("continue;").expect("continued polling")]
                .contains("pending_result = Some")
        );
        for special in [
            "RuntimeEffectKind::OpenBridge",
            "RuntimeEffectKind::CreateSandbox",
            "RuntimeEffectKind::DeleteSandbox",
            "RuntimeEffectKind::ImportReference",
            "RuntimeEffectKind::ExportFile",
        ] {
            assert!(run.contains(special), "missing special path {special}");
        }

        let reconnect = run
            .find("OuterSessionDisposition::Reconnect")
            .expect("silent reconnect disposition");
        let terminal = run
            .find("OuterSessionDisposition::Terminal")
            .expect("terminal disposition");
        assert!(reconnect < terminal);
        assert!(!run[reconnect..terminal].contains("eprintln!"));
        let main = production
            .split_once("if let Err(message) = runtime.block_on(run())")
            .expect("one runtime failure exit path")
            .1;
        assert_eq!(main.matches("eprintln!(").count(), 1);
        assert_eq!(main.matches("std::process::exit(1)").count(), 1);
        for forbidden in [
            "requestId",
            "leaseId",
            "sandboxId",
            "imageReference",
            "authorization",
            "workerControlToken",
            "workerInferenceToken",
        ] {
            assert!(
                !main.contains(forbidden),
                "terminal display leaks {forbidden}"
            );
        }
    }

    #[test]
    fn wp3a_u3a1_wires_typed_lifecycle_and_dependency_gates_into_the_epoch() {
        let main_source = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("main production section");
        let client_source = include_str!("openshell_client.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("client production section");
        let coordinator_source = include_str!("epoch_coordinator.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("coordinator production section");

        assert!(main_source.contains("NanoHostOpenShellClient"));
        for operation in [
            "create_sandbox",
            "get_sandbox",
            "list_sandboxes",
            "delete_sandbox",
            "wait_deleted",
        ] {
            assert!(
                client_source.contains(operation),
                "missing typed {operation} owner"
            );
        }
        for invalidation in [
            "EpochFault::IdentityMismatch",
            "EpochFault::CreateOutcomeUncertain",
            "EpochFault::DeleteOutcomeUncertain",
        ] {
            assert!(
                coordinator_source.contains(invalidation),
                "{invalidation} is not connected to epoch invalidation"
            );
        }

        let startup = coordinator_source
            .split("pub fn start")
            .nth(1)
            .expect("coordinator start path");
        let containerd_ready = startup
            .find("containerd_socket()")
            .expect("containerd socket proof");
        let dockerd_ready = startup
            .find("docker_socket()")
            .expect("dockerd socket proof");
        let gateway_connected = startup.find("health").expect("typed Gateway health proof");
        assert!(containerd_ready < dockerd_ready && dockerd_ready < gateway_connected);
        assert!(startup[gateway_connected..].contains("terminate_children"));
    }

    #[test]
    fn wp3b_readiness_composes_store_import_without_acquisition() {
        let main_source = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("main production section");
        let coordinator_source = include_str!("epoch_coordinator.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("coordinator production section");

        for owner in ["ImageStore", "required_deployment", "DockerImageBackend"] {
            assert!(
                main_source.contains(owner),
                "missing readiness owner {owner}"
            );
        }
        let run_source = main_source
            .split_once("fn run()")
            .expect("NanoHost run path")
            .1
            .split_once("fn main()")
            .expect("end of NanoHost run path")
            .0;
        let store_open = run_source
            .find("ImageStore::open")
            .expect("Image Store open");
        let prior_epoch_cleanup = run_source
            .find("remove_prior_epoch_roots(")
            .expect("prior epoch cleanup");
        let required_input = run_source
            .find("let required_deployment =")
            .expect("required deployment input");
        let backend = run_source
            .find("DockerImageBackend::new")
            .expect("private image backend");
        let start = run_source
            .find("EpochCoordinator::start(")
            .expect("Runtime Epoch start");
        let required_binding = run_source[required_input..]
            .split_once(';')
            .expect("complete required deployment binding")
            .0;
        assert!(required_binding.contains("parse_required_deployment_image_digests("));
        assert!(
            required_input < prior_epoch_cleanup
                && prior_epoch_cleanup < store_open
                && store_open < backend
                && backend < start
        );
        let start_call = run_source[start..]
            .split_once(".map_err")
            .expect("bounded Epoch start result")
            .0;
        for direct_owner in [
            "&plan",
            "client",
            "&mut image_store",
            "&required_deployment",
            "&mut image_backend",
        ] {
            assert!(
                start_call.contains(direct_owner),
                "Epoch start does not receive {direct_owner} directly"
            );
        }
        assert!(!run_source[start + start_call.len()..].contains("import_required_images("));

        let startup = coordinator_source
            .split_once("pub fn start")
            .expect("coordinator start path")
            .1
            .split_once("/// Creates a sandbox")
            .expect("end of coordinator start path")
            .0;
        let containerd_ready = startup
            .find("containerd_socket()")
            .expect("containerd socket proof");
        let dockerd_ready = startup
            .find("docker_socket()")
            .expect("dockerd socket proof");
        let required_import = startup
            .find("import_required_images(")
            .expect("required image import gate");
        let gateway_spawn = startup
            .find("plan.members()[3]")
            .expect("Gateway member spawn");
        let typed_health = startup
            .find("client.health()")
            .expect("typed Gateway health");
        assert!(
            containerd_ready < dockerd_ready
                && dockerd_ready < required_import
                && required_import < gateway_spawn
                && gateway_spawn < typed_health
        );
        let import_failure = &startup[required_import..gateway_spawn];
        assert!(import_failure.contains("terminate_children(&mut children)"));
        assert!(import_failure.contains("return Err(EpochFault::PartialStart)"));

        let import_owner = coordinator_source
            .split_once("pub fn import_required_images")
            .expect("required import owner")
            .1
            .split_once("pub fn import_attempt_image")
            .expect("end of required import owner")
            .0;
        let import_effect = import_owner
            .find("import_verified")
            .expect("bounded store import");
        let post_inspect = import_owner
            .find("inspect_digest")
            .expect("post-import digest inspection");
        assert!(import_effect < post_inspect);

        for forbidden in [
            "acquire_registry",
            "acquire_build",
            "build_image",
            "pull_image",
        ] {
            assert!(
                !main_source.contains(forbidden) && !startup.contains(forbidden),
                "readiness invokes forbidden acquisition path {forbidden}"
            );
        }
    }

    #[test]
    fn wp3b_main_installs_one_ring_provider_before_runtime_entry() {
        let production = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("main production section");
        let main_body = production
            .split_once("fn main() {")
            .expect("binary process entry")
            .1;
        let ring_provider = "rustls::crypto::ring::default_provider()";

        assert_eq!(main_body.matches(ring_provider).count(), 1);
        assert_eq!(main_body.matches("install_default()").count(), 1);
        let install = main_body
            .find(ring_provider)
            .expect("ring provider selection");
        let require_success = main_body[install..]
            .find(".install_default()\n        .expect(")
            .map(|offset| install + offset)
            .expect("provider installation Result must be required");
        let runtime_entry = main_body.find("run()").expect("runtime entry");
        assert!(install <= require_success && require_success < runtime_entry);
        assert!(!main_body[..runtime_entry].contains("aws_lc_rs::default_provider"));
    }
}

#[cfg(test)]
mod epoch_evidence;
