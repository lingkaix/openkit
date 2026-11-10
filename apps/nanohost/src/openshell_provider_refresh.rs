//! Dormant stock refresh configuration, with no refresher, timer or credential cache.

use crate::openshell_provider::ProviderRefusal;
use openshell_sdk::raw::proto::{
    ConfigureProviderRefreshRequest, Provider, ProviderCredentialRefresh,
    ProviderCredentialRefreshMaterial, ProviderCredentialRefreshStrategy, ProviderProfile,
};
use std::collections::HashMap;

/// Observed upstream facilities. Unknown is distinct from a supported facility.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ProviderFacilities {
    pub(crate) providers_v2: Option<bool>,
    pub(crate) endpoint_override: Option<bool>,
    pub(crate) effective_policy: Option<bool>,
    pub(crate) refresh_status: Option<bool>,
    pub(crate) stable_refresh_logs: Option<bool>,
}

/// Refuses before native effects when a required facility has not been proved.
pub(crate) fn require_facilities(
    facilities: &ProviderFacilities,
    delegated: bool,
) -> Result<(), ProviderRefusal> {
    if facilities.providers_v2 != Some(true)
        || facilities.effective_policy != Some(true)
        || (delegated
            && (facilities.endpoint_override != Some(true)
                || facilities.refresh_status != Some(true)))
    {
        return Err(ProviderRefusal::FacilityUnavailable);
    }
    Ok(())
}

/// Names only the five accepted strategies; unknown values never become static defaults.
pub(crate) fn strategy_name(strategy: i32) -> Result<&'static str, ProviderRefusal> {
    use ProviderCredentialRefreshStrategy as S;
    match S::try_from(strategy) {
        Ok(S::Static) => Ok("static"),
        Ok(S::External) => Ok("external"),
        Ok(S::Oauth2RefreshToken) => Ok("oauth2_refresh_token"),
        Ok(S::Oauth2ClientCredentials) => Ok("oauth2_client_credentials"),
        Ok(S::GoogleServiceAccountJwt) => Ok("google_service_account_jwt"),
        _ => Err(ProviderRefusal::EvidenceUnproved),
    }
}

/// Prepares the pinned profile token URL and transient stock configure request.
/// This is native projection only: it does not authorize delegation or perform an RPC.
/// Integration must prove the governed Vault delegation and predecessor fence first.
pub(crate) fn prepare_delegated_refresh(
    provider: &Provider,
    profile: &mut ProviderProfile,
    strategy: i32,
    token_url: &str,
    scopes: Vec<String>,
    material: HashMap<String, String>,
    facilities: &ProviderFacilities,
) -> Result<ConfigureProviderRefreshRequest, ProviderRefusal> {
    require_facilities(facilities, true)?;
    let invalid = ProviderRefusal::InvalidProjection;
    let (required, optional): (&[&str], &[&str]) = match strategy_name(strategy)? {
        "oauth2_refresh_token" => (&["client_id", "refresh_token"], &["client_secret"]),
        "oauth2_client_credentials" => (&["client_id", "client_secret"], &[]),
        "google_service_account_jwt" if !scopes.is_empty() => {
            (&["client_email", "private_key"], &["subject"])
        }
        _ => return Err(invalid),
    };
    let url = reqwest::Url::parse(token_url).map_err(|_| invalid)?;
    if token_url.trim() != token_url
        || token_url.chars().any(char::is_control)
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || token_url.len() > 2048
        || profile.credentials.len() != 1
        || provider.r#type != profile.id
        || !profile.id.starts_with("okp-")
        || !provider
            .metadata
            .as_ref()
            .is_some_and(|m| m.name.starts_with("oki-"))
        || required.iter().any(|key| !material.contains_key(*key))
        || material.iter().any(|(key, value)| {
            (!required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
                || value.is_empty()
                || value.len() > 1024 * 1024
        })
        || scopes.len() > 64
        || scopes
            .iter()
            .any(|s| s.is_empty() || s.len() > 1024 || s.chars().any(char::is_control))
    {
        return Err(invalid);
    }
    let credential = &profile.credentials[0];
    let env = credential
        .env_vars
        .first()
        .filter(|_| credential.env_vars.len() == 1)
        .ok_or(invalid)?;
    if provider.credentials.len() != 1 || !provider.credentials.contains_key(env) {
        return Err(invalid);
    }
    let mut keys: Vec<_> = material.keys().cloned().collect();
    keys.sort();
    // Mark every delegated material value secret, including raw account identifiers.
    let refresh = ProviderCredentialRefresh {
        strategy,
        token_url: token_url.into(),
        scopes,
        material: keys
            .iter()
            .map(|name| ProviderCredentialRefreshMaterial {
                name: name.clone(),
                required: required.contains(&name.as_str()),
                secret: true,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let request = ConfigureProviderRefreshRequest {
        provider: provider.metadata.as_ref().ok_or(invalid)?.name.clone(),
        credential_key: env.clone(),
        strategy,
        material,
        secret_material_keys: keys,
        expires_at_ms: provider.credential_expires_at_ms.get(env).copied(),
        workspace: "default".into(),
    };
    profile.credentials[0].refresh = Some(refresh);
    Ok(request)
}
