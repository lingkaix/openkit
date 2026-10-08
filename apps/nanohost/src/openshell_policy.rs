//! Native OpenShell policy projection from exact Core-owned authorization intent.

use openshell_sdk::raw::proto::{
    FilesystemPolicy, L7Allow, L7Rule, LandlockPolicy, NetworkBinary, NetworkEndpoint,
    NetworkPolicyRule, ProcessPolicy, SandboxPolicy,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

const FIXED_READ_ONLY_ROOTS: [&str; 8] = [
    "/usr",
    "/lib",
    "/proc",
    "/dev/urandom",
    "/app",
    "/etc",
    "/opt",
    "/var/log",
];

/// Renders exact Core intent locally and parses it into the selected SDK policy.
///
/// # Errors
///
/// Refuses every missing, unknown, malformed or unsupported authority-bearing field before effects.
pub(crate) fn render_sandbox_policy(intent: &Value) -> Result<SandboxPolicy, &'static str> {
    parse_native_policy(&render_worker_policy(intent)?)
}

/// Requires the complete closed core of an effect instruction and refuses unknown fields.
fn intent_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, &'static str> {
    value
        .as_object()
        .filter(|object| {
            required.iter().all(|key| object.contains_key(*key))
                && object
                    .keys()
                    .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
        })
        .ok_or("sandbox policy intent fields invalid")
}

/// Reads a nonempty intent string without control bytes carried by the native boundary.
fn intent_text(value: &Value) -> Result<&str, &'static str> {
    value
        .as_str()
        .filter(|text| !text.is_empty() && !text.contains(['\r', '\n', '\0']))
        .ok_or("sandbox policy intent string invalid")
}

/// Grants identify an exact filesystem path rather than an alias.
fn canonical_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        && (path == "/"
            || path[1..]
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."))
}

/// Prevents writable intent from broadening an immutable supply root or its ancestors.
fn paths_overlap(left: &str, right: &str) -> bool {
    left == "/"
        || right == "/"
        || left == right
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
}

/// Canonical destination identity for conflict checks, without URL or wildcard authority.
fn canonical_network_host(host: &str) -> Result<String, &'static str> {
    let host = host.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/@?#*\\".contains(c))
    {
        return Err("sandbox network intent host invalid");
    }
    let authority = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let url = reqwest::Url::parse(&format!("https://{authority}"))
        .map_err(|_| "sandbox network intent host invalid")?;
    if url.port().is_some()
        || (host.contains(':')
            && !host.starts_with('[')
            && host.parse::<std::net::Ipv6Addr>().is_err())
    {
        return Err("sandbox network intent host invalid");
    }
    let canonical = url
        .host_str()
        .ok_or("sandbox network intent host invalid")?
        .trim_end_matches('.');
    if let Ok(address) = canonical
        .trim_matches(['[', ']'])
        .parse::<std::net::Ipv6Addr>()
        && let Some(mapped) = address.to_ipv4_mapped()
    {
        return Ok(mapped.to_string());
    }
    Ok(canonical.to_string())
}

/// Refuses mixed parser settings rather than letting native endpoint composition OR them.
fn admit_encoded_slash_setting(
    settings: &mut HashMap<(String, u64), bool>,
    host: &str,
    port: u64,
    allowed: bool,
) -> Result<(), &'static str> {
    let destination = (canonical_network_host(host)?, port);
    if settings
        .insert(destination, allowed)
        .is_some_and(|previous| previous != allowed)
    {
        return Err("composed network grants disagree on encoded-slash authority");
    }
    Ok(())
}

/// Projects the existing fixed native policy from Core endpoint and filesystem intent only.
fn render_worker_policy(intent: &Value) -> Result<Value, &'static str> {
    let intent = intent_object(
        intent,
        &["additionalFilesystemGrants", "additionalNetworkEndpoints"],
        &[],
    )?;
    let grants = intent["additionalFilesystemGrants"]
        .as_array()
        .ok_or("sandbox filesystem intent invalid")?;
    let mut read_only = FIXED_READ_ONLY_ROOTS
        .iter()
        .map(|root| (*root).to_string())
        .collect::<Vec<_>>();
    let mut read_write = [
        "/sandbox",
        "/workspace",
        "/openkit",
        "/tmp/openkit-bootstrap",
        "/dev/null",
    ]
    .map(str::to_string)
    .to_vec();
    for value in grants {
        let grant = intent_object(value, &["access", "path"], &[])?;
        let path = intent_text(&grant["path"])?;
        if !canonical_absolute_path(path) {
            return Err("sandbox filesystem intent path invalid");
        }
        match intent_text(&grant["access"])? {
            "read-only" => read_only.push(path.to_string()),
            "read-write"
                if !FIXED_READ_ONLY_ROOTS
                    .iter()
                    .any(|root| paths_overlap(path, root)) =>
            {
                read_write.push(path.to_string())
            }
            _ => return Err("sandbox filesystem intent access invalid"),
        }
    }
    let endpoints = intent["additionalNetworkEndpoints"]
        .as_array()
        .ok_or("sandbox network intent invalid")?;
    let mut policies = Map::new();
    let mut encoded_slash_settings = HashMap::new();
    for value in endpoints {
        let entry = intent_object(
            value,
            &["binaries", "host", "name", "port"],
            &["access", "allowEncodedSlash", "protocol", "rules"],
        )?;
        let name = intent_text(&entry["name"])?;
        let mut name_bytes = name.bytes();
        if !name_bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            || !name_bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err("sandbox network intent name invalid");
        }
        let host = intent_text(&entry["host"])?;
        if host.trim().is_empty() {
            return Err("sandbox network intent host invalid");
        }
        let port = entry["port"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= u16::MAX as u64)
            .ok_or("sandbox network intent port invalid")?;
        if entry
            .get("protocol")
            .map(intent_text)
            .transpose()?
            .is_some_and(|protocol| protocol != "rest")
        {
            return Err("sandbox network intent protocol unsupported");
        }
        let binaries = entry["binaries"]
            .as_array()
            .filter(|binaries| !binaries.is_empty())
            .ok_or("sandbox network intent binaries invalid")?
            .iter()
            .map(|value| {
                let path = intent_text(value)?;
                if !path.starts_with('/') {
                    return Err("sandbox network intent binary path invalid");
                }
                Ok(json!({"path": path}))
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        let access = entry.get("access").map(intent_text).transpose()?;
        if access.is_some_and(|access| access != "read-only" && access != "read-write") {
            return Err("sandbox network intent access invalid");
        }
        let rules = entry
            .get("rules")
            .map(|rules| {
                rules
                    .as_array()
                    .ok_or("sandbox network intent rules invalid")
            })
            .transpose()?;
        if rules.is_some_and(|rules| !rules.is_empty()) && access.is_some() {
            return Err("sandbox network intent access and rules conflict");
        }
        let allow_encoded_slash = entry
            .get("allowEncodedSlash")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or("sandbox encoded-slash intent boolean invalid")
            })
            .transpose()?;
        if allow_encoded_slash.is_some()
            && (rules.is_some() || access.unwrap_or("read-only") != "read-only")
        {
            return Err(
                "sandbox encoded-slash intent requires read-only REST access without rules",
            );
        }
        admit_encoded_slash_setting(
            &mut encoded_slash_settings,
            host,
            port,
            allow_encoded_slash.unwrap_or(false),
        )?;
        let mut endpoint =
            json!({"enforcement": "enforce", "host": host, "port": port, "protocol": "rest"});
        if let Some(rules) = rules.filter(|rules| !rules.is_empty()) {
            let rules = rules
                .iter()
                .map(|value| {
                    let rule = intent_object(value, &["method", "path"], &[])?;
                    let method = intent_text(&rule["method"])?;
                    let path = intent_text(&rule["path"])?;
                    if !["GET", "POST"].contains(&method) || !path.starts_with('/') {
                        return Err("sandbox network intent REST rule invalid");
                    }
                    Ok(json!({"allow": {"method": method, "path": path}}))
                })
                .collect::<Result<Vec<_>, &'static str>>()?;
            endpoint["rules"] = json!(rules);
        } else {
            endpoint["access"] = json!(access.unwrap_or("read-only"));
        }
        if allow_encoded_slash == Some(true) {
            endpoint["allow_encoded_slash"] = json!(true);
        }
        policies.insert(
            name.to_string(),
            json!({"binaries": binaries, "endpoints": [endpoint], "name": name}),
        );
    }
    Ok(json!({
        "filesystem": {"includeWorkdir": false, "readOnly": read_only, "readWrite": read_write},
        "landlock": {"compatibility": "best_effort"},
        "networkMiddlewares": {}, "networkPolicies": policies,
        "process": {"runAsGroup": "sandbox", "runAsUser": "sandbox"}, "version": 1
    }))
}

/// Parses one complete NanoHost-rendered native policy into the pinned OpenShell proto.
///
/// # Errors
///
/// Returns a bounded failure for every missing, unknown, malformed, or unsupported field.
fn parse_native_policy(value: &serde_json::Value) -> Result<SandboxPolicy, &'static str> {
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
    if include_workdir
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
    let mut encoded_slash_settings = HashMap::new();
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
        let mut expected_endpoint_keys = if has_access {
            vec!["access", "enforcement", "host", "port", "protocol"]
        } else {
            vec!["enforcement", "host", "port", "protocol", "rules"]
        };
        if endpoint.contains_key("allow_encoded_slash") {
            expected_endpoint_keys.push("allow_encoded_slash");
        }
        if has_access == has_rules || !exact_keys(endpoint, &expected_endpoint_keys) {
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
        let allow_encoded_slash = endpoint
            .get("allow_encoded_slash")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or("sandbox encoded-slash policy boolean invalid")
            })
            .transpose()?;
        if allow_encoded_slash.is_some() && (!has_access || access != "read-only") {
            return Err(
                "sandbox encoded-slash policy requires read-only REST access without rules",
            );
        }
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
        admit_encoded_slash_setting(
            &mut encoded_slash_settings,
            &host,
            u64::from(port),
            allow_encoded_slash.unwrap_or(false),
        )?;
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
                    allow_encoded_slash: allow_encoded_slash.unwrap_or(false),
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_native_policy_reaches_current_sdk_and_rejects_invalid_grants() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/support/openshell-worker-policy.json"
        ))
        .expect("captured TypeScript native policy fixture");
        let policy =
            parse_native_policy(&value).expect("captured native policy must reach the SDK");
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
        assert!(parse_native_policy(&empty_binaries).is_err());
        let mut ambiguous = value.clone();
        ambiguous["networkPolicies"]["github_git_read"]["endpoints"][0]["access"] =
            serde_json::json!("read-write");
        assert!(parse_native_policy(&ambiguous).is_err());
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
                parse_native_policy(&invalid).is_err(),
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
        assert!(parse_native_policy(&bad_name).is_err());
        let mut unknown = value;
        unknown["unrecognized"] = serde_json::json!(true);
        assert!(parse_native_policy(&unknown).is_err());
    }

    #[test]
    fn encoded_slash_authority_preserves_strict_controls_and_git_rules() {
        let strict = representative_intent();
        let original = render_worker_policy(&strict).unwrap();
        for setting in [None, Some(false), Some(true)] {
            let mut intent = strict.clone();
            if let Some(allowed) = setting {
                intent["additionalNetworkEndpoints"][0]["allowEncodedSlash"] = json!(allowed);
            }
            let native = render_worker_policy(&intent).unwrap();
            let endpoint = &native["networkPolicies"]["direct_api"]["endpoints"][0];
            assert_eq!(
                endpoint.get("allow_encoded_slash"),
                setting
                    .filter(|allowed| *allowed)
                    .map(|_| &Value::Bool(true))
            );
            let policy = render_sandbox_policy(&intent).unwrap();
            let endpoint = &policy.network_policies["direct_api"].endpoints[0];
            assert_eq!(endpoint.allow_encoded_slash, setting.unwrap_or(false));
            assert_eq!(endpoint.access, "read-only");
            assert_eq!(endpoint.enforcement, "enforce");
            assert_eq!(endpoint.protocol, "rest");
            assert_eq!(endpoint.host, "api.example.com");
            assert_eq!(endpoint.port, 443);
            assert_eq!(
                policy.network_policies["direct_api"].binaries[0].path,
                "/usr/local/bin/codex"
            );
            assert_eq!(
                native["networkPolicies"]["github_git_read"],
                original["networkPolicies"]["github_git_read"]
            );
            assert!(!policy.network_policies["github_git_read"].endpoints[0].allow_encoded_slash);
        }
    }

    #[test]
    fn encoded_slash_refuses_malformed_forbidden_and_unknown_native_authority() {
        for malformed in [
            json!("true"),
            json!("false"),
            json!(0),
            json!(1),
            Value::Null,
            json!({}),
            json!([]),
        ] {
            let mut intent = representative_intent();
            intent["additionalNetworkEndpoints"][0]["allowEncodedSlash"] = malformed.clone();
            assert!(render_sandbox_policy(&intent).is_err());
            let mut native = render_worker_policy(&representative_intent()).unwrap();
            native["networkPolicies"]["direct_api"]["endpoints"][0]["allow_encoded_slash"] =
                malformed;
            assert!(parse_native_policy(&native).is_err());
        }
        for allowed in [false, true] {
            for change in [
                json!({"access": "read-write"}),
                json!({"protocol": "http"}),
                json!({"protocol": "https"}),
                json!({"rules": []}),
            ] {
                let mut intent = representative_intent();
                let endpoint = intent["additionalNetworkEndpoints"][0]
                    .as_object_mut()
                    .unwrap();
                endpoint.insert("allowEncodedSlash".into(), json!(allowed));
                endpoint.extend(change.as_object().unwrap().clone());
                assert!(render_sandbox_policy(&intent).is_err());
            }
            let mut intent = representative_intent();
            intent["additionalNetworkEndpoints"][1]["allowEncodedSlash"] = json!(allowed);
            assert!(render_sandbox_policy(&intent).is_err());
            for name in ["direct_api", "github_git_read"] {
                let mut native = render_worker_policy(&representative_intent()).unwrap();
                native["networkPolicies"][name]["endpoints"][0]["allow_encoded_slash"] =
                    json!(allowed);
                if name == "direct_api" {
                    native["networkPolicies"][name]["endpoints"][0]["access"] = json!("read-write");
                }
                assert!(parse_native_policy(&native).is_err());
            }
        }
        let mut native = render_worker_policy(&representative_intent()).unwrap();
        native["networkPolicies"]["direct_api"]["endpoints"][0]["futureAuthority"] = json!(true);
        assert!(parse_native_policy(&native).is_err());
    }

    #[test]
    fn encoded_slash_composition_requires_agreement_at_each_boundary() {
        let mut opted = representative_intent()["additionalNetworkEndpoints"][0].clone();
        opted["allowEncodedSlash"] = json!(true);
        for rules in [false, true] {
            let mut strict =
                representative_intent()["additionalNetworkEndpoints"][usize::from(rules)].clone();
            strict["host"] = json!("API.EXAMPLE.COM.");
            strict["name"] = json!("strict");
            for endpoints in [json!([opted, strict]), json!([strict, opted])] {
                let intent = json!({"additionalFilesystemGrants": [], "additionalNetworkEndpoints": endpoints});
                assert!(render_sandbox_policy(&intent).is_err());
            }
        }
        let mut same = opted.clone();
        same["name"] = json!("same");
        let intent =
            json!({"additionalFilesystemGrants": [], "additionalNetworkEndpoints": [opted, same]});
        let mut native = render_worker_policy(&intent).unwrap();
        assert!(parse_native_policy(&native).is_ok());
        native["networkPolicies"]["same"]["endpoints"][0]
            .as_object_mut()
            .unwrap()
            .remove("allow_encoded_slash");
        assert!(parse_native_policy(&native).is_err());
        native["networkPolicies"]["same"]["endpoints"][0]["allow_encoded_slash"] = json!(false);
        assert!(parse_native_policy(&native).is_err());
        native["networkPolicies"]["same"]["endpoints"][0]["port"] = json!(8443);
        assert!(parse_native_policy(&native).is_ok());
    }

    /// The input whose TypeScript-rendered bytes were captured before moving the projector.
    pub(crate) fn representative_intent() -> serde_json::Value {
        serde_json::json!({
            "additionalFilesystemGrants": [
                {"access": "read-only", "path": "/opt/toolchains"},
                {"access": "read-write", "path": "/sandbox/.cache/npm"}
            ],
            "additionalNetworkEndpoints": [
                {"binaries": ["/usr/local/bin/codex"], "host": "api.example.com", "name": "direct_api", "port": 443, "protocol": "rest"},
                {"binaries": ["/usr/bin/git"], "host": "github.com", "name": "github_git_read", "port": 443, "rules": [
                    {"method": "GET", "path": "/**/info/refs*"},
                    {"method": "POST", "path": "/**/git-upload-pack"}
                ]}
            ]
        })
    }

    #[test]
    fn host_render_matches_captured_typescript_native_policy() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/support/openshell-worker-policy.json"
        ))
        .unwrap();
        assert_eq!(
            render_worker_policy(&representative_intent()).unwrap(),
            expected
        );

        let public_search = render_worker_policy(&serde_json::json!({
            "additionalFilesystemGrants": [],
            "additionalNetworkEndpoints": [{
                "name": "public_search",
                "host": "search.example.com",
                "port": 443,
                "protocol": "rest",
                "binaries": ["/usr/local/bin/node"],
                "rules": [{"method": "POST", "path": "/mcp"}]
            }]
        }))
        .unwrap();
        assert_eq!(
            public_search["networkPolicies"]["public_search"],
            serde_json::json!({
                "name": "public_search",
                "binaries": [{"path": "/usr/local/bin/node"}],
                "endpoints": [{
                    "enforcement": "enforce",
                    "host": "search.example.com",
                    "port": 443,
                    "protocol": "rest",
                    "rules": [{"allow": {"method": "POST", "path": "/mcp"}}]
                }]
            })
        );
        assert_eq!(public_search["networkMiddlewares"], serde_json::json!({}));
    }

    #[test]
    fn intent_refuses_unknown_authority_at_every_object_boundary() {
        for pointer in [
            "",
            "/additionalFilesystemGrants/0",
            "/additionalNetworkEndpoints/0",
            "/additionalNetworkEndpoints/1/rules/0",
        ] {
            let mut intent = representative_intent();
            intent
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("futureAuthority".into(), serde_json::json!(true));
            assert!(
                render_worker_policy(&intent).is_err(),
                "unknown authority at {pointer}"
            );
        }
    }
    #[test]
    fn fixed_supply_and_data_roots_preserve_the_existing_default_policy() {
        let policy = render_sandbox_policy(&serde_json::json!({
            "additionalFilesystemGrants": [], "additionalNetworkEndpoints": []
        }))
        .unwrap();
        let filesystem = policy.filesystem.unwrap();
        assert!(!filesystem.include_workdir);
        assert!(filesystem.read_only.contains(&"/opt".to_string()));
        assert_eq!(
            filesystem.read_write,
            [
                "/sandbox",
                "/workspace",
                "/openkit",
                "/tmp/openkit-bootstrap",
                "/dev/null"
            ]
        );
        assert!(policy.network_policies.is_empty());
    }

    #[test]
    fn filesystem_intent_refuses_aliases_and_writable_supply_overlap() {
        for path in [
            "relative",
            "/opt/../sandbox",
            "/workspace//data",
            "/workspace/",
            "/workspace/.",
            "/workspace/a\n",
            "/workspace/a\0",
        ] {
            let mut intent = representative_intent();
            intent["additionalFilesystemGrants"][0]["path"] = serde_json::json!(path);
            assert!(render_sandbox_policy(&intent).is_err(), "alias {path:?}");
        }
        for root in FIXED_READ_ONLY_ROOTS {
            for path in ["/".to_string(), root.to_string(), format!("{root}/nested")] {
                let mut intent = representative_intent();
                intent["additionalFilesystemGrants"][1]["path"] = serde_json::json!(path);
                assert!(
                    render_sandbox_policy(&intent).is_err(),
                    "supply overlap {path}"
                );
            }
        }
    }

    #[test]
    fn endpoint_intent_refuses_unsupported_or_ambiguous_enforcement() {
        for (pointer, value) in [
            (
                "/additionalNetworkEndpoints/0/name",
                serde_json::json!("bad/name"),
            ),
            ("/additionalNetworkEndpoints/0/host", serde_json::json!(" ")),
            ("/additionalNetworkEndpoints/0/port", serde_json::json!(0)),
            (
                "/additionalNetworkEndpoints/0/port",
                serde_json::json!(65536),
            ),
            ("/additionalNetworkEndpoints/0/port", serde_json::json!(1.5)),
            (
                "/additionalNetworkEndpoints/0/protocol",
                serde_json::json!("grpc"),
            ),
            (
                "/additionalNetworkEndpoints/0/binaries",
                serde_json::json!([]),
            ),
            (
                "/additionalNetworkEndpoints/0/binaries/0",
                serde_json::json!("relative"),
            ),
            (
                "/additionalNetworkEndpoints/0/access",
                serde_json::json!("unknown"),
            ),
            (
                "/additionalNetworkEndpoints/0/access",
                serde_json::json!(null),
            ),
            (
                "/additionalNetworkEndpoints/1/rules/0/method",
                serde_json::json!("DELETE"),
            ),
            (
                "/additionalNetworkEndpoints/1/rules/0/path",
                serde_json::json!("relative"),
            ),
        ] {
            let mut intent = representative_intent();
            if let Some(slot) = intent.pointer_mut(pointer) {
                *slot = value;
            } else {
                intent["additionalNetworkEndpoints"][0]["access"] = value;
            }
            assert!(
                render_sandbox_policy(&intent).is_err(),
                "unsupported intent at {pointer}"
            );
        }
        let mut intent = representative_intent();
        intent["additionalNetworkEndpoints"][1]["access"] = serde_json::json!("read-write");
        assert!(render_sandbox_policy(&intent).is_err());
        intent = representative_intent();
        intent["additionalNetworkEndpoints"][0]["enforcement"] = serde_json::json!("audit");
        assert!(render_sandbox_policy(&intent).is_err());
        for invalid in [
            serde_json::json!({}),
            serde_json::json!(null),
            serde_json::json!({"additionalFilesystemGrants": [], "additionalNetworkEndpoints": null}),
        ] {
            assert!(render_sandbox_policy(&invalid).is_err());
        }
    }
}
