//! Dormant exact effective-policy verification for the pinned native REST subset.

use openshell_sdk::raw::proto::{L7Allow, NetworkEndpoint, SandboxPolicy};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::openshell_provider::ProviderRefusal;

/// Produces a stable document only when every native authority field is understood.
/// Unsupported nondefault fields refuse before projection; they are never discarded.
fn policy_document(policy: &SandboxPolicy) -> Result<Value, ProviderRefusal> {
    let invalid = ProviderRefusal::PolicyUnproved;
    let filesystem = policy.filesystem.as_ref().ok_or(invalid)?;
    let landlock = policy.landlock.as_ref().ok_or(invalid)?;
    let process = policy.process.as_ref().ok_or(invalid)?;
    if policy.version != 1
        || filesystem.include_workdir
        || landlock.compatibility != "best_effort"
        || process.run_as_user != "sandbox"
        || process.run_as_group != "sandbox"
        || !policy.network_middlewares.is_empty()
    {
        return Err(invalid);
    }
    for path in filesystem.read_only.iter().chain(&filesystem.read_write) {
        if !absolute_path(path) {
            return Err(invalid);
        }
    }
    let mut networks = std::collections::BTreeMap::new();
    for (name, rule) in &policy.network_policies {
        if name.is_empty()
            || rule.name != *name
            || rule.endpoints.is_empty()
            || rule.binaries.is_empty()
        {
            return Err(invalid);
        }
        let endpoints = rule
            .endpoints
            .iter()
            .map(endpoint_document)
            .collect::<Result<Vec<_>, _>>()?;
        let binaries = rule
            .binaries
            .iter()
            .map(|binary| {
                if !absolute_path(&binary.path)
                    || *binary
                        != (openshell_sdk::raw::proto::NetworkBinary {
                            path: binary.path.clone(),
                            ..Default::default()
                        })
                {
                    return Err(invalid);
                }
                Ok(json!({"path":binary.path}))
            })
            .collect::<Result<Vec<_>, _>>()?;
        networks.insert(
            name.clone(),
            json!({"name":rule.name,"endpoints":endpoints,"binaries":binaries}),
        );
    }
    Ok(json!({"version":policy.version,
        "filesystem":{"includeWorkdir":filesystem.include_workdir,"readOnly":filesystem.read_only,"readWrite":filesystem.read_write},
        "landlock":{"compatibility":landlock.compatibility},
        "process":{"runAsUser":process.run_as_user,"runAsGroup":process.run_as_group},
        "networkPolicies":networks,"networkMiddlewares":{}}))
}

/// Limits the dormant bearer adapter to the existing understood REST enforcement fields.
pub(crate) fn endpoint_document(endpoint: &NetworkEndpoint) -> Result<Value, ProviderRefusal> {
    let invalid = ProviderRefusal::PolicyUnproved;
    let understood = NetworkEndpoint {
        host: endpoint.host.clone(),
        port: endpoint.port,
        protocol: endpoint.protocol.clone(),
        tls: endpoint.tls.clone(),
        enforcement: endpoint.enforcement.clone(),
        access: endpoint.access.clone(),
        rules: endpoint.rules.clone(),
        allow_encoded_slash: endpoint.allow_encoded_slash,
        ..Default::default()
    };
    if *endpoint != understood
        || endpoint.host.is_empty()
        || endpoint
            .host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "/@?#\\".contains(c))
        || endpoint.port == 0
        || endpoint.port > 65535
        || endpoint.protocol != "rest"
        || !matches!(endpoint.tls.as_str(), "" | "terminate")
        || endpoint.enforcement != "enforce"
        || !((matches!(endpoint.access.as_str(), "read-only" | "read-write")
            && endpoint.rules.is_empty())
            || (endpoint.access.is_empty() && !endpoint.rules.is_empty()))
    {
        return Err(invalid);
    }
    let rules = endpoint
        .rules
        .iter()
        .map(|rule| {
            let allow = rule.allow.as_ref().ok_or(invalid)?;
            if *allow
                != (L7Allow {
                    method: allow.method.clone(),
                    path: allow.path.clone(),
                    ..Default::default()
                })
                || !matches!(
                    allow.method.as_str(),
                    "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE" | "*"
                )
                || allow.path.is_empty()
                || allow.path.chars().any(char::is_control)
            {
                return Err(invalid);
            }
            Ok(json!({"allow":{"method":allow.method,"path":allow.path}}))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"host":endpoint.host,"port":endpoint.port,"protocol":endpoint.protocol,
        "tls":endpoint.tls,"enforcement":endpoint.enforcement,"access":endpoint.access,
        "rules":rules,"allowEncodedSlash":endpoint.allow_encoded_slash}),
    )
}

/// Requires complete native equality, including base and every Provider layer, before a digest.
/// Missing or unsupported policy structure is an unproved policy, not an empty grant.
pub(crate) fn verify_effective_policy(
    expected: &SandboxPolicy,
    observed: &SandboxPolicy,
) -> Result<String, ProviderRefusal> {
    let expected_document = policy_document(expected)?;
    policy_document(observed)?;
    if expected != observed {
        return Err(ProviderRefusal::PolicyUnproved);
    }
    let bytes =
        serde_json::to_vec(&expected_document).map_err(|_| ProviderRefusal::PolicyUnproved)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Admits an exact absolute path without alternate traversal spellings.
pub(crate) fn absolute_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.chars().any(char::is_control)
        && (path == "/"
            || path[1..]
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."))
}
