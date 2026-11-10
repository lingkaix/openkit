//! Bounded allowlisted native observations, never raw upstream records or diagnostics.

use crate::openshell_provider::ProviderRefusal;
use crate::openshell_provider_refresh::{ProviderFacilities, strategy_name};
use openshell_sdk::raw::proto::{Provider, ProviderCredentialRefreshStatus};
use serde_json::{Value, json};

/// Records observation gaps without making the unavailable surface look complete.
pub(crate) fn observation_summary(facilities: &ProviderFacilities) -> Value {
    let status = facilities.refresh_status == Some(true);
    let logs = facilities.stable_refresh_logs == Some(true);
    json!({"refreshStatus":status,"refreshLogs":logs,"complete":status && logs})
}

/// Omits all identifiers, raw errors, credential keys and material from refresh evidence.
pub(crate) fn normalize_refresh_status(
    status: &ProviderCredentialRefreshStatus,
) -> Result<Value, ProviderRefusal> {
    let strategy = strategy_name(status.strategy)?;
    if !matches!(
        status.status.as_str(),
        "configured" | "refreshed" | "error" | "rotation_requested"
    ) || [
        status.expires_at_ms,
        status.next_refresh_at_ms,
        status.last_refresh_at_ms,
    ]
    .iter()
    .any(|n| *n < 0)
    {
        return Err(ProviderRefusal::EvidenceUnproved);
    }
    Ok(json!({"strategy":strategy,"status":status.status,
        "expiresAtMs":status.expires_at_ms,"nextRefreshAtMs":status.next_refresh_at_ms,
        "lastRefreshAtMs":status.last_refresh_at_ms,"hasError":!status.last_error.is_empty()}))
}

/// Omits credential values, config, labels, annotations and account or native locators.
/// Lineage must be supplied by the authorized Core consumer, never inferred from native names.
pub(crate) fn normalize_provider(provider: &Provider) -> Result<Value, ProviderRefusal> {
    if provider.metadata.is_none()
        || provider.credentials.len() > 64
        || provider.config.len() > 64
        || provider.credential_expires_at_ms.len() > 64
        || provider.credential_expires_at_ms.values().any(|n| *n < 0)
    {
        return Err(ProviderRefusal::EvidenceUnproved);
    }
    Ok(json!({"credentialCount":provider.credentials.len(),
        "expiringCredentialCount":provider.credential_expires_at_ms.values().filter(|n|**n>0).count()}))
}
