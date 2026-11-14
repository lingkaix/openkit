//! Static Provider projection for the existing authenticated private import carriage.

use crate::openshell_policy::render_sandbox_policy;
use crate::openshell_provider::{ProviderRefusal, profile_digest, project_profile};
use openshell_sdk::raw::proto::{ProviderProfile, SandboxPolicy};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Private cleanup/projection and comparison facts held only by the live Sandbox owner.
#[derive(Clone)]
pub(crate) struct StaticProviderBinding {
    pub(crate) metadata: Value,
    pub(crate) profile: ProviderProfile,
    pub(crate) provider_name: String,
    pub(crate) deployment: String,
    pub(crate) workspace: String,
    pub(crate) grant: String,
    pub(crate) base_policy: SandboxPolicy,
    pub(crate) expires_at_ms: Option<i64>,
    /// Raw-frame deny-list values. Never project these into metadata, effects or Worker input.
    pub(crate) comparison_values: Vec<String>,
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, ProviderRefusal> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
        })
        .ok_or(ProviderRefusal::InvalidProjection)
}

fn namespace(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))[..32].to_string()
}

/// Validates all Core authority fields before the stock SDK receives an effect.
pub(crate) fn prepare_static_binding(
    value: &Value,
) -> Result<StaticProviderBinding, ProviderRefusal> {
    let invalid = ProviderRefusal::InvalidProjection;
    let object = value.as_object().ok_or(invalid)?;
    const REQUIRED: &[&str] = &[
        "declarationId",
        "grantId",
        "planId",
        "receiptId",
        "vaultReferenceId",
        "materialVersion",
        "providerInstanceId",
        "providerType",
        "credentialKey",
        "profileId",
        "accessShape",
        "deploymentId",
        "workspaceId",
        "policyIntent",
    ];
    if REQUIRED.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| {
            !REQUIRED.contains(&key.as_str())
                && !["expectedReceiptId", "expiresAtMs"].contains(&key.as_str())
        })
        || value
            .get("materialVersion")
            .and_then(Value::as_u64)
            .is_none_or(|version| version == 0 || version > 9_007_199_254_740_991)
    {
        return Err(invalid);
    }
    for key in REQUIRED
        .iter()
        .filter(|key| !["materialVersion", "accessShape", "policyIntent"].contains(key))
    {
        text(value, key)?;
    }
    if object.contains_key("expectedReceiptId") {
        text(value, "expectedReceiptId")?;
    }
    let shape = value
        .get("accessShape")
        .and_then(Value::as_object)
        .ok_or(invalid)?;
    if shape.len() != 3
        || !["id", "credentialKey", "endpoints"]
            .iter()
            .all(|key| shape.contains_key(*key))
    {
        return Err(invalid);
    }
    let shape_value = &value["accessShape"];
    if text(shape_value, "id")? != text(value, "profileId")?
        || text(shape_value, "credentialKey")? != text(value, "credentialKey")?
        || shape_value["endpoints"]
            .as_array()
            .is_none_or(Vec::is_empty)
    {
        return Err(invalid);
    }
    let endpoints_policy = render_sandbox_policy(&json!({
        "additionalFilesystemGrants": [],
        "additionalNetworkEndpoints": shape_value["endpoints"],
    }))
    .map_err(|_| invalid)?;
    let mut rules: Vec<_> = endpoints_policy.network_policies.values().collect();
    rules.sort_by(|left, right| left.name.cmp(&right.name));
    let binaries = rules.first().ok_or(invalid)?.binaries.clone();
    if rules.iter().any(|rule| rule.binaries != binaries) {
        return Err(invalid);
    }
    let endpoints = rules
        .iter()
        .flat_map(|rule| rule.endpoints.clone())
        .collect();
    let deployment = namespace(text(value, "deploymentId")?.as_bytes());
    let workspace = namespace(text(value, "workspaceId")?.as_bytes());
    let grant = namespace(
        format!(
            "{}:{}",
            text(value, "grantId")?,
            text(value, "providerInstanceId")?
        )
        .as_bytes(),
    );
    let shape_name = namespace(&serde_json::to_vec(shape_value).map_err(|_| invalid)?);
    let projection = project_profile(
        &deployment,
        &shape_name,
        1,
        text(value, "credentialKey")?,
        endpoints,
        binaries,
    )?;
    let base_policy = render_sandbox_policy(&value["policyIntent"]).map_err(|_| invalid)?;
    let expires_at_ms = match value.get("expiresAtMs") {
        None => None,
        Some(value) => Some(value.as_i64().filter(|value| *value > 0).ok_or(invalid)?),
    };
    Ok(StaticProviderBinding {
        metadata: value.clone(),
        profile: projection.profile,
        provider_name: format!("oki-{deployment}-{workspace}-{grant}"),
        deployment,
        workspace,
        grant,
        base_policy,
        expires_at_ms,
        comparison_values: Vec::new(),
    })
}

/// Reproduces only the selected stock mapping for names generated by this adapter.
fn policy_rule_name(provider_name: &str) -> String {
    format!("_provider_{}", provider_name.replace('-', "_"))
}

/// Expected policy is derived from Core intent and known projections, never the observed policy.
pub(crate) fn expected_static_policy(
    base: &SandboxPolicy,
    bindings: &[StaticProviderBinding],
) -> Result<SandboxPolicy, ProviderRefusal> {
    let mut expected = base.clone();
    for binding in bindings {
        let name = policy_rule_name(&binding.provider_name);
        if expected.network_policies.contains_key(&name) {
            return Err(ProviderRefusal::PolicyUnproved);
        }
        expected.network_policies.insert(
            name.clone(),
            openshell_sdk::raw::proto::NetworkPolicyRule {
                name,
                endpoints: binding.profile.endpoints.clone(),
                binaries: binding.profile.binaries.clone(),
            },
        );
    }
    Ok(expected)
}

/// Builds only bounded value-free evidence after the complete effective policy has matched.
pub(crate) fn static_protection_proof(
    binding: &StaticProviderBinding,
    policy_digest: &str,
) -> Result<Value, ProviderRefusal> {
    Ok(json!({
        "declarationId": binding.metadata["declarationId"],
        "grantId": binding.metadata["grantId"],
        "planId": binding.metadata["planId"],
        "receiptId": binding.metadata["receiptId"],
        "vaultReferenceId": binding.metadata["vaultReferenceId"],
        "materialVersion": binding.metadata["materialVersion"],
        "mappingVersion": 1,
        "profileDigest": profile_digest(&binding.profile)?,
        "expectedPolicyDigest": policy_digest,
        "observedPolicyDigest": policy_digest,
        "placeholderOnly": true,
        "exposure": "sandbox-provider",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent() -> Value {
        json!({
            "declarationId":"provider", "grantId":"grant", "planId":"plan", "receiptId":"receipt", "vaultReferenceId":"reference", "materialVersion":1,
            "providerInstanceId":"logical-provider", "providerType":"generic", "credentialKey":"GITHUB_TOKEN", "profileId":"github_mcp",
            "deploymentId":"deployment", "workspaceId":"workspace",
            "accessShape":{"id":"github_mcp","credentialKey":"GITHUB_TOKEN","endpoints":[{"name":"github_api","host":"api.github.com","port":443,"binaries":["/usr/bin/curl"]}]},
            "policyIntent":{"additionalFilesystemGrants":[],"additionalNetworkEndpoints":[]}
        })
    }

    #[test]
    fn static_projection_is_closed_and_receipt_independent_but_generation_bound() {
        let original = prepare_static_binding(&intent()).unwrap();
        let mut successor = intent();
        successor["planId"] = json!("next-plan");
        successor["receiptId"] = json!("next-receipt");
        let next = prepare_static_binding(&successor).unwrap();
        assert_eq!(original.provider_name, next.provider_name);
        assert_eq!(original.profile, next.profile);
        successor["credentialValue"] = json!("never metadata");
        assert!(prepare_static_binding(&successor).is_err());
        let mut unknown = intent();
        unknown["accessShape"]["refresh"] = json!({});
        assert!(prepare_static_binding(&unknown).is_err());
        let mut invalid = intent();
        invalid["materialVersion"] = json!(0);
        assert!(prepare_static_binding(&invalid).is_err());
    }

    #[test]
    fn static_projection_requires_exact_policy_and_closed_value_free_proof() {
        let binding = prepare_static_binding(&intent()).unwrap();
        let expected =
            expected_static_policy(&binding.base_policy, std::slice::from_ref(&binding)).unwrap();
        assert_eq!(
            expected.network_policies.len(),
            binding.base_policy.network_policies.len() + 1
        );
        let digest =
            crate::openshell_provider_policy::verify_effective_policy(&expected, &expected)
                .unwrap();
        let proof = static_protection_proof(&binding, &digest).unwrap();
        assert_eq!(proof["receiptId"], "receipt");
        assert_eq!(proof["materialVersion"], 1);
        assert_eq!(proof["expectedPolicyDigest"], proof["observedPolicyDigest"]);
        assert_eq!(proof.as_object().unwrap().len(), 12);
        let mut widened = expected.clone();
        widened
            .network_policies
            .get_mut(&policy_rule_name(&binding.provider_name))
            .unwrap()
            .endpoints[0]
            .host = "other.example.com".into();
        assert!(
            crate::openshell_provider_policy::verify_effective_policy(&expected, &widened).is_err()
        );
        let mut nonuniform = intent();
        nonuniform["accessShape"]["endpoints"].as_array_mut().unwrap().push(json!({"name":"other_api","host":"other.example.com","port":443,"binaries":["/usr/bin/python3"]}));
        assert!(prepare_static_binding(&nonuniform).is_err());
    }
}
