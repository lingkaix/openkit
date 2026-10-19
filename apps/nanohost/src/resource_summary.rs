//! Bounded projection of exact-container backend observations into resource diagnostics.
//!
//! The transport specification's Host-Observed Sandbox Resource Summary owns the fields.
//! This input seam initially preserves unavailable output so independent producer tests can
//! expose missing parsing before implementation. Replace that temporary empty projection
//! before landing; it must never imply measured zero values or affect Sandbox deletion.

/// Projects raw Docker inspect JSON and optional cgroup-v2 files into the closed summary.
///
/// Missing files remain unknown. Container identity, read bounds and collection lifetime
/// belong to the caller; this function performs no I/O and grants no lifecycle authority.
pub(crate) fn summary_from_observation(
    _docker_inspect_json: &[u8],
    _memory_peak: Option<&str>,
    _memory_events: Option<&str>,
    _cpu_stat: Option<&str>,
    _pids_peak: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({})
}
