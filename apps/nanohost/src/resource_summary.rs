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

#[cfg(test)]
mod tests {
    use super::summary_from_observation;
    use serde_json::json;

    #[test]
    fn projects_only_the_seven_resource_fields_with_literal_units_and_bounds() {
        // Ordinary single-container Docker inspect output; other metadata is not diagnostic data.
        let inspect = br#"[{
            "Id":"exact-container",
            "State":{"Status":"dead","OOMKilled":true,"Error":"PRIVATE_PROCESS_TEXT"},
            "LogPath":"/private/container.log",
            "Config":{"Env":["PRIVATE_CREDENTIAL=not-a-real-secret"]}
        }]"#;
        let summary = summary_from_observation(
            inspect,
            Some("9007199254740991\n"),
            Some("low 41\nhigh 37\nmax 31\noom 9\noom_kill 2\noom_group_kill 11\n"),
            Some(
                "usage_usec 1250000\nuser_usec 1000000\nsystem_usec 250000\nnr_periods 8\nnr_throttled 3\nthrottled_usec 125000\n",
            ),
            Some("7\n"),
        );
        assert_eq!(
            summary,
            json!({
                "memoryPeakBytes": 9007199254740991_u64,
                "oomKillCount": 2,
                "backendOomKilled": true,
                "cpuUsageSeconds": 1.25,
                "cpuThrottledSeconds": 0.125,
                "pidsPeak": 7,
                "exitState": "dead"
            })
        );
        let encoded = serde_json::to_vec(&summary).unwrap();
        assert!(encoded.len() <= 1024);
        assert!(!String::from_utf8(encoded).unwrap().contains("PRIVATE_"));
    }

    #[test]
    fn missing_cgroup_files_do_not_fabricate_counters() {
        assert_eq!(
            summary_from_observation(
                br#"[{"State":{"Status":"running","OOMKilled":false}}]"#,
                None,
                None,
                None,
                None,
            ),
            json!({"backendOomKilled": false, "exitState": "running"})
        );
    }

    #[test]
    fn preserves_measured_zero_and_false() {
        let summary = summary_from_observation(
            br#"[{"State":{"Status":"running","OOMKilled":false}}]"#,
            Some("0\n"),
            Some("oom_kill 0\n"),
            Some("usage_usec 0\nthrottled_usec 0\n"),
            Some("0\n"),
        );
        // Seconds admit numeric zero whether its JSON spelling is 0 or 0.0.
        assert_eq!(summary["cpuUsageSeconds"].as_f64(), Some(0.0));
        assert_eq!(summary["cpuThrottledSeconds"].as_f64(), Some(0.0));
        assert_eq!(summary["memoryPeakBytes"].as_u64(), Some(0));
        assert_eq!(summary["oomKillCount"].as_u64(), Some(0));
        assert_eq!(summary["pidsPeak"].as_u64(), Some(0));
        assert_eq!(summary["backendOomKilled"], false);
        assert_eq!(summary["exitState"], "running");
        assert_eq!(summary.as_object().unwrap().len(), 7);
    }

    #[test]
    fn omits_invalid_fields_without_discarding_an_independent_valid_measurement() {
        // Invalid raw observations become unknown individually; Core rejects malformed DTOs whole.
        assert_eq!(
            summary_from_observation(
                br#"[{"State":{"Status":"oom-killed","OOMKilled":"false"}}]"#,
                Some("-1\n"),
                Some("oom_kill 9007199254740992\n"),
                Some("usage_usec -1\nthrottled_usec 250000\n"),
                Some("1.5\n"),
            ),
            json!({"cpuThrottledSeconds": 0.25})
        );
    }

    #[test]
    fn absent_unsupported_and_unparseable_observations_remain_unknown() {
        assert_eq!(
            summary_from_observation(
                br#"[{"State":{}}]"#,
                None,
                Some("low 3\nhigh 5\n"),
                Some("nr_periods 4\nnr_throttled 2\n"),
                None,
            ),
            json!({})
        );
        assert_eq!(
            summary_from_observation(
                b"not-json",
                Some("max\n"),
                Some("oom_kill invalid\n"),
                Some("usage_usec NaN\nthrottled_usec Infinity\n"),
                Some("PRIVATE_PROCESS_TEXT\n"),
            ),
            json!({})
        );
    }
}
