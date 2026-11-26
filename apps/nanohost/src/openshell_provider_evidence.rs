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
    ) {
        return Err(ProviderRefusal::EvidenceUnproved);
    }
    let expires_at = timestamp_ms(status.expiration_time.as_ref())?;
    let next_refresh = timestamp_ms(status.next_refresh_time.as_ref())?;
    let last_refresh = timestamp_ms(status.last_refresh_time.as_ref())?;
    Ok(json!({"strategy":strategy,"status":status.status,
        "expiresAtMs":expires_at,"nextRefreshAtMs":next_refresh,
        "lastRefreshAtMs":last_refresh,"hasError":!status.last_error.is_empty()}))
}

fn timestamp_ms(value: Option<&prost_types::Timestamp>) -> Result<i64, ProviderRefusal> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.seconds < 0 || !(0..1_000_000_000).contains(&value.nanos) {
        return Err(ProviderRefusal::EvidenceUnproved);
    }
    value
        .seconds
        .checked_mul(1000)
        .and_then(|seconds| seconds.checked_add(i64::from(value.nanos / 1_000_000)))
        .ok_or(ProviderRefusal::EvidenceUnproved)
}

/// Omits credential values, config, labels, annotations and account or native locators.
/// Lineage must be supplied by the authorized Core consumer, never inferred from native names.
pub(crate) fn normalize_provider(provider: &Provider) -> Result<Value, ProviderRefusal> {
    if provider.metadata.is_none()
        || provider.credentials.len() > 64
        || provider.config.len() > 64
        || provider.credential_expiration_times.len() > 64
    {
        return Err(ProviderRefusal::EvidenceUnproved);
    }
    let mut expiring_count = 0;
    for value in provider.credential_expiration_times.values() {
        expiring_count += usize::from(timestamp_ms(Some(value))? > 0);
    }
    Ok(
        json!({"credentialCount":provider.credentials.len(),"expiringCredentialCount":expiring_count}),
    )
}
