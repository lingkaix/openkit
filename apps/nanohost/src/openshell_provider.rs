//! Dormant native Provider projection; this module grants no credential authority.

use crate::openshell_provider_policy::{absolute_path, endpoint_document};
use openshell_sdk::raw::proto::datamodel::v1::ObjectMeta;
use openshell_sdk::raw::proto::{
    NetworkBinary, NetworkEndpoint, Provider, ProviderProfile, ProviderProfileCredential,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Closed diagnostics never retain native messages, identifiers, or material.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderRefusal {
    /// A projection input is outside the understood native subset.
    InvalidProjection,
    /// The complete effective native policy is absent, unsupported, or different.
    PolicyUnproved,
    /// A required upstream facility is absent or unknown.
    FacilityUnavailable,
    /// Native evidence is outside the understood bounded shape.
    EvidenceUnproved,
    /// The stock RPC did not prove the requested result.
    NativeUnproved,
}

/// Backend-private generated profile; its digest is computed from the current declaration.
/// Credential material is never part of this profile or its digest.
pub(crate) struct ProviderProjection {
    pub(crate) profile: ProviderProfile,
}

/// Restricts generated identity parts so prefixes cannot alias another deployment.
pub(crate) fn identity_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Projects one exact deployment/access-shape profile without importing built-in profiles.
pub(crate) fn project_profile(
    deployment: &str,
    shape: &str,
    mapping_major: u32,
    env: &str,
    endpoints: Vec<NetworkEndpoint>,
    binaries: Vec<NetworkBinary>,
) -> Result<ProviderProjection, ProviderRefusal> {
    let invalid = ProviderRefusal::InvalidProjection;
    let reserved = env
        .strip_prefix('v')
        .and_then(|s| s.split_once('_'))
        .is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()));
    if !identity_part(deployment)
        || !identity_part(shape)
        || mapping_major == 0
        || env.is_empty()
        || env.len() > 128
        || reserved
        || !env
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
        || endpoints.is_empty()
        || binaries.is_empty()
    {
        return Err(invalid);
    }
    for endpoint in &endpoints {
        endpoint_document(endpoint)?;
    }
    for binary in &binaries {
        if !absolute_path(&binary.path)
            || *binary
                != (NetworkBinary {
                    path: binary.path.clone(),
                    ..Default::default()
                })
        {
            return Err(invalid);
        }
    }
    let id = format!("okp-{deployment}-{shape}-v{mapping_major}");
    Ok(ProviderProjection {
        profile: ProviderProfile {
            id,
            category: openshell_sdk::raw::proto::ProviderProfileCategory::Other as i32,
            credentials: vec![ProviderProfileCredential {
                name: "bearer".into(),
                env_vars: vec![env.into()],
                required: true,
                auth_style: "bearer".into(),
                header_name: "Authorization".into(),
                ..Default::default()
            }],
            endpoints,
            binaries,
            ..Default::default()
        },
    })
}

/// Builds a transient SDK instance request. The return value must never be logged or retained.
/// Core integration must supply already-authorized material and lineage before using this adapter.
pub(crate) fn project_instance(
    deployment: &str,
    workspace: &str,
    grant: &str,
    projection: &ProviderProjection,
    env: &str,
    material: String,
    expires_at_ms: Option<i64>,
) -> Result<Provider, ProviderRefusal> {
    let invalid = ProviderRefusal::InvalidProjection;
    if ![deployment, workspace, grant]
        .iter()
        .all(|v| identity_part(v))
        || !projection
            .profile
            .id
            .starts_with(&format!("okp-{deployment}-"))
        || projection.profile.credentials.len() != 1
        || projection.profile.credentials[0].env_vars != [env]
        || material.is_empty()
        || material.len() > 1024 * 1024
        || expires_at_ms.is_some_and(|v| v <= 0)
    {
        return Err(invalid);
    }
    Ok(Provider {
        metadata: Some(ObjectMeta {
            name: format!("oki-{deployment}-{workspace}-{grant}"),
            ..Default::default()
        }),
        r#type: projection.profile.id.clone(),
        credentials: HashMap::from([(env.into(), material)]),
        credential_expires_at_ms: expires_at_ms
            .map(|v| HashMap::from([(env.into(), v)]))
            .unwrap_or_default(),
        ..Default::default()
    })
}

/// Digests the current non-secret profile, including any delegated refresh declaration.
/// Computing on demand prevents a later refresh projection from retaining a stale digest.
pub(crate) fn profile_digest(profile: &ProviderProfile) -> Result<String, ProviderRefusal> {
    let endpoints = profile
        .endpoints
        .iter()
        .map(endpoint_document)
        .collect::<Result<Vec<_>, _>>()?;
    let credentials=profile.credentials.iter().map(|credential| {
        let refresh=credential.refresh.as_ref().map(|refresh| json!({
            "strategy":refresh.strategy,"tokenUrl":refresh.token_url,"scopes":refresh.scopes,
            "refreshBeforeSeconds":refresh.refresh_before_seconds,"maxLifetimeSeconds":refresh.max_lifetime_seconds,
            "material":refresh.material.iter().map(|m|json!({"name":m.name,"description":m.description,"required":m.required,"secret":m.secret})).collect::<Vec<_>>(),
            "additionalOutputs":refresh.additional_outputs.iter().map(|o|json!({"output":o.output,"credential":o.credential})).collect::<Vec<_>>()
        }));
        if credential.token_grant.is_some() {return Err(ProviderRefusal::InvalidProjection);}
        Ok(json!({"name":credential.name,"description":credential.description,"envVars":credential.env_vars,
            "required":credential.required,"authStyle":credential.auth_style,"headerName":credential.header_name,
            "queryParam":credential.query_param,"pathTemplate":credential.path_template,"refresh":refresh}))
    }).collect::<Result<Vec<_>, _>>()?;
    let annotations: std::collections::BTreeMap<_, _> = profile.annotations.iter().collect();
    let discovery = profile.discovery.as_ref().map(|d| &d.credentials);
    let document = json!({"id":profile.id,"displayName":profile.display_name,"description":profile.description,
        "category":profile.category,"credentials":credentials,"endpoints":endpoints,
        "binaries":profile.binaries.iter().map(|b|json!({"path":b.path})).collect::<Vec<_>>(),
        "inferenceCapable":profile.inference_capable,"discovery":discovery,"annotations":annotations});
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&document).map_err(|_| ProviderRefusal::InvalidProjection)?
        )
    ))
}
