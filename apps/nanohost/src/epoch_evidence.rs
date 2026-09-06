//! Bounded private evidence for Runtime Epoch invalidation and rebuild timing.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

/// Fixed epoch-external directory for private NanoHost evidence.
pub const EVIDENCE_ROOT: &str = "/var/lib/openkit/nanohost-evidence";

/// Temporary first-fence timestamp carried across NanoHost process restarts until readiness.
pub const REBUILD_FENCE_STARTED_PATH: &str = "/var/lib/openkit/nanohost/.rebuild-fence-started";

/// Maximum encoded size of one report or disposition note.
pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;

/// Maximum time an export attempt may consume before it becomes incomplete.
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(2);

/// Maximum combined number of reports and notes retained by NanoHost.
pub const RETAINED_ARTIFACTS: usize = 20;

/// Accepted fence-to-ready target for one fresh Runtime Epoch.
pub const REBUILD_TARGET: Duration = Duration::from_secs(90);

/// Inclusive hard fence-to-ready limit after which NanoHost stays non-ready.
pub const REBUILD_HARD_LIMIT: Duration = Duration::from_secs(300);

static NEXT_ARTIFACT: AtomicU64 = AtomicU64::new(0);

/// Closed trigger vocabulary for invalidation initiated by a live NanoHost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpochInvalidationTrigger {
    /// An accepted sandbox create has an uncertain outcome.
    UncertainCreate,
    /// An accepted sandbox delete has an uncertain outcome.
    UncertainDelete,
    /// An effect-capable epoch member exited.
    MemberExit,
    /// An effect-capable member no longer has the expected identity.
    MemberIdentityChange,
    /// An effect-capable member restarted independently.
    MemberLocalRestart,
    /// Sandbox containment is lost or cannot be proved.
    ContainmentLoss,
    /// Fresh epoch creation did not complete.
    EpochCreationFailure,
    /// An explicit operator action invalidated the epoch.
    OperatorAction,
}

impl EpochInvalidationTrigger {
    /// Returns the exact stable trigger spelling used in private evidence.
    const fn as_str(self) -> &'static str {
        match self {
            Self::UncertainCreate => "uncertain-create",
            Self::UncertainDelete => "uncertain-delete",
            Self::MemberExit => "member-exit",
            Self::MemberIdentityChange => "member-identity-change",
            Self::MemberLocalRestart => "member-local-restart",
            Self::ContainmentLoss => "containment-loss",
            Self::EpochCreationFailure => "epoch-creation-failure",
            Self::OperatorAction => "operator-action",
        }
    }
}

impl FromStr for EpochInvalidationTrigger {
    type Err = &'static str;

    /// Parses only the accepted live-NanoHost invalidation trigger vocabulary.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "uncertain-create" => Ok(Self::UncertainCreate),
            "uncertain-delete" => Ok(Self::UncertainDelete),
            "member-exit" => Ok(Self::MemberExit),
            "member-identity-change" => Ok(Self::MemberIdentityChange),
            "member-local-restart" => Ok(Self::MemberLocalRestart),
            "containment-loss" => Ok(Self::ContainmentLoss),
            "epoch-creation-failure" => Ok(Self::EpochCreationFailure),
            "operator-action" => Ok(Self::OperatorAction),
            _ => Err("unknown NanoHost-initiated invalidation trigger"),
        }
    }
}

/// Closed trigger vocabulary for invalidation observed after NanoHost absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbsentEpochTrigger {
    /// NanoHost exited without exporting an invalidation report.
    NanoHostCrash,
    /// NanoHost was killed before it could export a report.
    NanoHostKilled,
    /// NanoHost lost its own configured identity.
    NanoHostIdentityLoss,
    /// The execution server restarted.
    ExecutionServerRestart,
    /// The execution host was lost.
    HostLoss,
}

impl AbsentEpochTrigger {
    /// Returns the exact stable trigger spelling used in a disposition note.
    const fn as_str(self) -> &'static str {
        match self {
            Self::NanoHostCrash => "nanohost-crash",
            Self::NanoHostKilled => "nanohost-killed",
            Self::NanoHostIdentityLoss => "nanohost-identity-loss",
            Self::ExecutionServerRestart => "execution-server-restart",
            Self::HostLoss => "host-loss",
        }
    }
}

impl FromStr for AbsentEpochTrigger {
    type Err = &'static str;

    /// Parses only the accepted NanoHost-absent invalidation trigger vocabulary.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "nanohost-crash" => Ok(Self::NanoHostCrash),
            "nanohost-killed" => Ok(Self::NanoHostKilled),
            "nanohost-identity-loss" => Ok(Self::NanoHostIdentityLoss),
            "execution-server-restart" => Ok(Self::ExecutionServerRestart),
            "host-loss" => Ok(Self::HostLoss),
            _ => Err("unknown NanoHost-absent invalidation trigger"),
        }
    }
}

/// Result of one append-only private evidence export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceArtifact {
    /// Exact newly created artifact path inside the configured evidence root.
    pub path: PathBuf,
    /// Whether export completed without reaching its size or time bound.
    pub complete: bool,
}

/// Owns bounded append-only writes below one private evidence root.
#[derive(Clone)]
pub struct EpochEvidenceWriter {
    root: PathBuf,
}

impl EpochEvidenceWriter {
    /// Opens or creates one private evidence root and enforces mode `0700`.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the root cannot be created or secured.
    pub fn new(root: PathBuf) -> io::Result<Self> {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        Ok(Self { root })
    }

    /// Appends one bounded redacted report for a live-NanoHost invalidation.
    ///
    /// `started` is the instant at which the caller began the export attempt.
    ///
    /// # Errors
    ///
    /// Returns an I/O or encoding error when no artifact can be appended.
    pub fn export_invalidation(
        &mut self,
        trigger: EpochInvalidationTrigger,
        fields: &[(&str, &str)],
        started: Instant,
    ) -> io::Result<EvidenceArtifact> {
        self.export(
            "epoch-invalidation",
            trigger.as_str(),
            fields,
            started,
            false,
        )
    }

    /// Appends one bounded prior-epoch note from observable host state.
    ///
    /// `started` is the instant at which the caller began the export attempt.
    ///
    /// # Errors
    ///
    /// Returns an I/O or encoding error when no artifact can be appended.
    pub fn export_absent_disposition(
        &mut self,
        trigger: AbsentEpochTrigger,
        fields: &[(&str, &str)],
        started: Instant,
    ) -> io::Result<EvidenceArtifact> {
        self.export(
            "prior-epoch-disposition",
            trigger.as_str(),
            fields,
            started,
            true,
        )
    }

    /// Encodes, appends, and prunes one owned evidence artifact.
    fn export(
        &mut self,
        kind: &str,
        trigger: &str,
        fields: &[(&str, &str)],
        started: Instant,
        absent: bool,
    ) -> io::Result<EvidenceArtifact> {
        let mut complete = started.elapsed() < EXPORT_TIMEOUT;
        let mut safe_fields = Map::new();
        if complete {
            for &(name, value) in fields {
                if started.elapsed() >= EXPORT_TIMEOUT {
                    complete = false;
                    safe_fields.clear();
                    break;
                }
                if accepted_field(name, absent) {
                    safe_fields.insert(name.to_owned(), Value::String(redact(value)));
                } else {
                    complete = false;
                }
            }
        }

        let mut payload = serde_json::to_vec(&json!({
            "kind": kind,
            "trigger": trigger,
            "complete": complete,
            "fields": safe_fields,
        }))?;
        if payload.len() > MAX_ARTIFACT_BYTES || started.elapsed() >= EXPORT_TIMEOUT {
            complete = false;
            payload = serde_json::to_vec(&json!({
                "kind": kind,
                "trigger": trigger,
                "complete": false,
                "fields": {},
            }))?;
        }

        let path = self.root.join(artifact_name(kind));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(&payload)?;
        file.sync_all()?;
        self.prune()?;
        Ok(EvidenceArtifact { path, complete })
    }

    /// Removes only older owned report and note files beyond the shared bound.
    fn prune(&self) -> io::Result<()> {
        let mut artifacts = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if let Some(sequence) = artifact_sequence(&path) {
                artifacts.push((sequence.to_owned(), entry));
            }
        }
        artifacts.sort_by(|left, right| left.0.cmp(&right.0));
        let remove_count = artifacts.len().saturating_sub(RETAINED_ARTIFACTS);
        for (_, entry) in artifacts.into_iter().take(remove_count) {
            fs::remove_file(entry.path())?;
        }
        Ok(())
    }
}

/// Observable startup state needed to distinguish fresh start from recovery.
pub struct RecoveryObservation {
    /// Persisted prior initiated-fence timestamp, when one exists.
    pub fence_started: Option<SystemTime>,
    /// Redacted residual prior-epoch identities proving NanoHost-absent recovery.
    pub absent_prior_epochs: Option<String>,
    /// Number of residual prior epoch roots observed at startup.
    pub residual_roots: usize,
    prior_epoch_names: Vec<String>,
}

impl RecoveryObservation {
    /// Removes the exact prior state and runtime roots observed before fresh planning.
    ///
    /// # Errors
    ///
    /// Returns an I/O or invalid-data error when an observed root changed shape or
    /// cannot be removed. A missing runtime root is accepted because `/run` is
    /// independently ephemeral; an observed state root must remain a directory.
    pub fn remove_prior_epoch_roots(&self, state_root: &Path, run_root: &Path) -> io::Result<()> {
        for name in &self.prior_epoch_names {
            let runtime_path = run_root.join(name);
            match fs::symlink_metadata(&runtime_path) {
                Ok(metadata) if metadata.file_type().is_dir() => {
                    fs::remove_dir_all(&runtime_path)?;
                }
                Ok(_) => return Err(io::Error::other("prior runtime root changed shape")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }

            let state_path = state_root.join(name);
            match fs::symlink_metadata(&state_path) {
                Ok(metadata) if metadata.file_type().is_dir() => {
                    fs::remove_dir_all(&state_path)?;
                }
                Ok(_) => return Err(io::Error::other("prior epoch root changed shape")),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

/// Observes prior epoch roots and the separate temporary rebuild marker.
///
/// This function never reads an invalidation report or disposition note.
///
/// # Errors
///
/// Returns an I/O or invalid-data error when observable recovery state cannot be read safely.
pub fn observe_recovery(state_root: &Path) -> io::Result<RecoveryObservation> {
    observe_recovery_at(state_root, Path::new(REBUILD_FENCE_STARTED_PATH))
}

/// Observes recovery roots against one explicit first-fence marker path.
fn observe_recovery_at(state_root: &Path, fence_path: &Path) -> io::Result<RecoveryObservation> {
    let fence_started = read_fence_started(fence_path)?;
    let mut prior_epochs = Vec::new();
    match fs::read_dir(state_root) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    let name = entry.file_name();
                    if name.to_str().is_some_and(|name| name.starts_with("epoch-")) {
                        prior_epochs.push(name.to_string_lossy().into_owned());
                    }
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    prior_epochs.sort();
    let residual_roots = prior_epochs.len();
    Ok(RecoveryObservation {
        fence_started,
        absent_prior_epochs: (fence_started.is_none() && residual_roots > 0)
            .then(|| prior_epochs.join(",")),
        residual_roots,
        prior_epoch_names: prior_epochs,
    })
}

/// Reads one optional first-fence timestamp without consulting forensic artifacts.
fn read_fence_started(path: &Path) -> io::Result<Option<SystemTime>> {
    match fs::read_to_string(path) {
        Ok(value) => {
            let nanos = value.parse::<u64>().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid fence timestamp")
            })?;
            Ok(Some(UNIX_EPOCH + Duration::from_nanos(nanos)))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Persists the first temporary wall-clock fence timestamp outside forensic artifacts.
///
/// # Errors
///
/// Returns an I/O or clock error when the marker cannot be written durably.
pub fn record_fence_started(fence_started: SystemTime) -> io::Result<()> {
    record_fence_started_at(Path::new(REBUILD_FENCE_STARTED_PATH), fence_started)
}

/// Creates one marker atomically and preserves an existing first-fence timestamp.
pub(crate) fn record_fence_started_at(path: &Path, fence_started: SystemTime) -> io::Result<()> {
    let nanos = u64::try_from(
        fence_started
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos(),
    )
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "fence timestamp overflow"))?;
    let mut file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    write!(file, "{nanos}")?;
    file.sync_all()
}

/// Removes the consumed temporary fence timestamp after readiness is proved.
///
/// # Errors
///
/// Returns an I/O error when an existing marker cannot be removed.
pub fn clear_fence_started() -> io::Result<()> {
    clear_fence_started_at(Path::new(REBUILD_FENCE_STARTED_PATH))
}

/// Removes one consumed marker at an explicit path while preserving removal failures.
pub(crate) fn clear_fence_started_at(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Result of one temporary fence-to-ready measurement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct RebuildMeasurement {
    /// Whether the complete readiness proof may advertise capacity.
    pub ready: bool,
    /// Whether the accepted 90-second rebuild target was met.
    pub target_met: bool,
}

/// Consumes one elapsed rebuild observation without reading forensic artifacts.
pub fn measure_fence_to_ready(elapsed: Duration, readiness_proved: bool) -> RebuildMeasurement {
    RebuildMeasurement {
        ready: readiness_proved && elapsed <= REBUILD_HARD_LIMIT,
        target_met: readiness_proved && elapsed <= REBUILD_TARGET,
    }
}

/// Returns whether a field belongs to the relevant closed private artifact shape.
fn accepted_field(name: &str, absent: bool) -> bool {
    const REPORT_FIELDS: &[&str] = &[
        "epoch",
        "generation",
        "nanohost",
        "created_at",
        "invalidated_at",
        "timing",
        "operation",
        "sandbox",
        "attempt",
        "certainty_loss",
        "members",
        "backend",
        "images",
        "readiness",
        "connection",
        "fence",
        "bridges",
        "lineage",
        "diagnostics",
    ];
    const NOTE_FIELDS: &[&str] = &[
        "classification",
        "prior_epoch",
        "generation",
        "residual_inventory",
        "fence",
    ];
    if absent {
        NOTE_FIELDS.contains(&name)
    } else {
        REPORT_FIELDS.contains(&name)
    }
}

/// Redacts whole values that could contain credentials, worker content, or host paths.
fn redact(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if value.split_whitespace().any(|part| part.starts_with('/'))
        || value.starts_with("AKIA")
        || lower.contains("okt_")
        || lower.contains("sk-")
        || lower.contains("ghp_")
        || lower.contains("github_pat_")
        || lower.contains("xoxb-")
        || lower.contains("xoxp-")
        || lower.contains("=/")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("private key")
        || lower.contains("authorization")
        || lower.contains("cookie")
        || lower.contains("credential")
        || lower.contains("provider")
        || lower.contains("vault")
        || lower.contains("prompt")
        || lower.contains("transcript")
        || lower.contains("workspace")
        || lower.contains("artifact")
    {
        "[redacted]".to_owned()
    } else {
        value.to_owned()
    }
}

/// Generates one sortable collision-resistant filename without external state.
fn artifact_name(kind: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let sequence = NEXT_ARTIFACT.fetch_add(1, Ordering::Relaxed);
    format!("{kind}-{timestamp:039}-{sequence:020}.json")
}

/// Returns the sortable sequence from an artifact format owned by this module.
fn artifact_sequence(path: &Path) -> Option<&str> {
    let name = path.file_name().and_then(|name| name.to_str())?;
    let sequence = name
        .strip_prefix("epoch-invalidation-")
        .or_else(|| name.strip_prefix("prior-epoch-disposition-"))
        .and_then(|name| name.strip_suffix(".json"));
    sequence.filter(|sequence| {
        let bytes = sequence.as_bytes();
        bytes.len() == 60
            && bytes[39] == b'-'
            && bytes[..39].iter().all(u8::is_ascii_digit)
            && bytes[40..].iter().all(u8::is_ascii_digit)
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant, UNIX_EPOCH};

    use super::{
        AbsentEpochTrigger, EVIDENCE_ROOT, EXPORT_TIMEOUT, EpochEvidenceWriter,
        EpochInvalidationTrigger, MAX_ARTIFACT_BYTES, REBUILD_HARD_LIMIT, REBUILD_TARGET,
        RETAINED_ARTIFACTS, RebuildMeasurement, artifact_sequence, measure_fence_to_ready,
        observe_recovery_at, record_fence_started_at,
    };

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn preserves_first_fence_timestamp_across_repeated_failure() {
        let root = std::env::temp_dir().join(format!(
            "openkit-fence-marker-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("marker root");
        let marker = root.join("fence-started");
        let first = UNIX_EPOCH + Duration::from_secs(1);
        let later = UNIX_EPOCH + Duration::from_secs(2);

        record_fence_started_at(&marker, first).expect("first fence marker");
        let first_bytes = fs::read(&marker).expect("first marker bytes");
        let first_metadata = fs::metadata(&marker).expect("first marker metadata");
        record_fence_started_at(&marker, later).expect("repeated fence marker");
        let final_metadata = fs::metadata(&marker).expect("final marker metadata");

        assert_eq!(fs::read(&marker).expect("final marker bytes"), first_bytes);
        assert_eq!(final_metadata.ino(), first_metadata.ino());
        assert_eq!(final_metadata.mtime(), first_metadata.mtime());
        assert_eq!(final_metadata.mtime_nsec(), first_metadata.mtime_nsec());
        assert_eq!(
            observe_recovery_at(&root.join("state"), &marker)
                .expect("recovery observation")
                .fence_started,
            Some(first)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retains_newest_artifact_across_kinds() {
        const VALID_SEQUENCE: &str = "000000000000000000000000000000000000001-00000000000000000001";
        for kind in ["epoch-invalidation", "prior-epoch-disposition"] {
            let name = format!("{kind}-{VALID_SEQUENCE}.json");
            assert_eq!(artifact_sequence(Path::new(&name)), Some(VALID_SEQUENCE));
        }
        assert!(artifact_sequence(Path::new("epoch-invalidation-invalid.json")).is_none());
        assert!(artifact_sequence(Path::new("unrelated.json")).is_none());

        for first_is_note in [true, false] {
            let root = std::env::temp_dir().join(format!(
                "openkit-epoch-retention-{}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut writer = EpochEvidenceWriter::new(root.clone()).expect("private evidence root");
            let mut export = |note| {
                if note {
                    writer.export_absent_disposition(
                        AbsentEpochTrigger::NanoHostCrash,
                        &[],
                        Instant::now(),
                    )
                } else {
                    writer.export_invalidation(
                        EpochInvalidationTrigger::UncertainCreate,
                        &[],
                        Instant::now(),
                    )
                }
                .expect("retained artifact")
            };
            let first = export(first_is_note);
            for _ in 1..RETAINED_ARTIFACTS {
                export(first_is_note);
            }
            let newest = export(!first_is_note);

            assert!(newest.path.exists());
            assert!(!first.path.exists());
            assert_eq!(
                fs::read_dir(&root).expect("retained evidence").count(),
                RETAINED_ARTIFACTS
            );
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn removes_only_observed_prior_epoch_roots_before_fresh_start() {
        let root = std::env::temp_dir().join(format!(
            "openkit-epoch-recovery-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        let state_root = root.join("state");
        let run_root = root.join("run");
        let prior_epoch = "epoch-123-456-0";
        fs::create_dir_all(state_root.join(prior_epoch).join("docker")).expect("prior state root");
        fs::write(
            state_root.join(prior_epoch).join("docker").join("blob"),
            b"stale",
        )
        .expect("prior state bytes");
        fs::create_dir_all(run_root.join(prior_epoch).join("containerd")).expect("prior run root");
        fs::create_dir_all(state_root.join("preserved")).expect("unrelated state root");
        fs::create_dir_all(run_root.join("preserved")).expect("unrelated run root");

        let marker = root.join("fence-started");
        let recovery = observe_recovery_at(&state_root, &marker).expect("prior epoch observation");
        assert_eq!(recovery.residual_roots, 1);
        recovery
            .remove_prior_epoch_roots(&state_root, &run_root)
            .expect("prior epoch cleanup");

        assert!(!state_root.join(prior_epoch).exists());
        assert!(!run_root.join(prior_epoch).exists());
        assert!(state_root.join("preserved").is_dir());
        assert!(run_root.join("preserved").is_dir());

        let replaced_epoch = "epoch-123-456-1";
        fs::create_dir_all(state_root.join(replaced_epoch)).expect("second prior state root");
        let recovery =
            observe_recovery_at(&state_root, &marker).expect("second prior epoch observation");
        fs::remove_dir(state_root.join(replaced_epoch)).expect("replace observed epoch root");
        symlink(
            state_root.join("preserved"),
            state_root.join(replaced_epoch),
        )
        .expect("replacement symlink");
        assert!(
            recovery
                .remove_prior_epoch_roots(&state_root, &run_root)
                .is_err()
        );
        assert!(state_root.join("preserved").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wp3c_epoch_evidence_is_closed_bounded_redacted_and_non_authoritative() {
        assert_eq!(EVIDENCE_ROOT, "/var/lib/openkit/nanohost-evidence");
        assert_eq!(MAX_ARTIFACT_BYTES, 8 * 1024 * 1024);
        assert_eq!(EXPORT_TIMEOUT, Duration::from_secs(2));
        assert_eq!(RETAINED_ARTIFACTS, 20);
        assert_eq!(REBUILD_TARGET, Duration::from_secs(90));
        assert_eq!(REBUILD_HARD_LIMIT, Duration::from_secs(300));

        for trigger in [
            "uncertain-create",
            "uncertain-delete",
            "member-exit",
            "member-identity-change",
            "member-local-restart",
            "containment-loss",
            "epoch-creation-failure",
            "operator-action",
        ] {
            assert!(trigger.parse::<EpochInvalidationTrigger>().is_ok());
            assert!(trigger.parse::<AbsentEpochTrigger>().is_err());
        }
        for trigger in [
            "nanohost-crash",
            "nanohost-killed",
            "nanohost-identity-loss",
            "execution-server-restart",
            "host-loss",
        ] {
            assert!(trigger.parse::<AbsentEpochTrigger>().is_ok());
            assert!(trigger.parse::<EpochInvalidationTrigger>().is_err());
        }
        for rejected in ["", "member_exit", "nanohost-crash ", "other"] {
            assert!(rejected.parse::<EpochInvalidationTrigger>().is_err());
            assert!(rejected.parse::<AbsentEpochTrigger>().is_err());
        }

        let root = std::env::temp_dir().join(format!(
            "openkit-wp3c-evidence-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut writer = EpochEvidenceWriter::new(root.clone()).expect("private evidence root");
        assert_eq!(
            fs::metadata(&root)
                .expect("evidence root mode")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let dangerous_diagnostic = concat!(
            "okt_forbidden_raw_token ",
            "nanohost_token_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ",
            "-----BEGIN PRIVATE KEY-----private-key-material ",
            "prompt=worker prompt transcript=worker transcript ",
            "Workspace bytes Artifact bytes ",
            "/home/operator/unrestricted/private/path"
        );
        let report = writer
            .export_invalidation(
                "member-exit"
                    .parse::<EpochInvalidationTrigger>()
                    .expect("closed trigger"),
                &[
                    ("epoch", "epoch-redacted-7"),
                    ("generation", "7"),
                    ("nanohost", "nanohost-redacted"),
                    ("timing", "lifetime_ms=45000"),
                    (
                        "operation",
                        "sk-FAKE_REVIEW_MARKER_1234567890 path=/run/openkit/private.sock",
                    ),
                    ("created_at", "AKIAFAKEREVIEW123456"),
                    ("attempt", "xoxb-FAKE-REVIEW-MARKER-1234567890"),
                    ("members", "gateway=exited"),
                    ("backend", "docker=29.6.1"),
                    ("images", "sha256:fixture"),
                    ("readiness", "gateway-health=passed"),
                    ("connection", "generation=3"),
                    ("fence", "initiated"),
                    ("bridges", "session-redacted=closed"),
                    ("lineage", "session-redacted-a"),
                    ("diagnostics", dangerous_diagnostic),
                ],
                Instant::now(),
            )
            .expect("bounded initiated-invalidation export");
        assert!(report.complete);
        assert_eq!(report.path.parent(), Some(root.as_path()));
        assert_eq!(
            fs::metadata(&report.path)
                .expect("report mode")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let report_contents = fs::read_to_string(&report.path).expect("redacted report");
        for prohibited in [
            "okt_forbidden_raw_token",
            "sk-FAKE_REVIEW_MARKER_1234567890",
            "AKIAFAKEREVIEW123456",
            "xoxb-FAKE-REVIEW-MARKER-1234567890",
            "nanohost_token_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "path=/run/openkit/private.sock",
            "private-key-material",
            "worker prompt",
            "worker transcript",
            "Workspace bytes",
            "Artifact bytes",
            "/home/operator/unrestricted/private/path",
        ] {
            assert!(
                !report_contents.contains(prohibited),
                "retained {prohibited}"
            );
        }

        let before_note = fs::read_dir(&root).expect("evidence inventory").count();
        let note = writer
            .export_absent_disposition(
                "execution-server-restart"
                    .parse::<AbsentEpochTrigger>()
                    .expect("closed absent trigger"),
                &[
                    ("classification", "nanohost-absent"),
                    ("prior_epoch", "epoch-redacted-7"),
                    ("generation", "7"),
                    (
                        "residual_inventory",
                        "processes=0 roots=0 networks=0 sockets=0 sandboxes=0",
                    ),
                    ("fence", "proved"),
                ],
                Instant::now(),
            )
            .expect("observable-state disposition note");
        assert_eq!(
            fs::read_dir(&root).expect("note inventory").count(),
            before_note + 1
        );
        assert!(
            fs::read_to_string(note.path)
                .expect("disposition note")
                .contains("nanohost-absent")
        );

        let oversized = "x".repeat(MAX_ARTIFACT_BYTES + 1);
        let truncated = writer
            .export_invalidation(
                "operator-action"
                    .parse::<EpochInvalidationTrigger>()
                    .expect("closed trigger"),
                &[("diagnostics", oversized.as_str())],
                Instant::now(),
            )
            .expect("size-bounded export");
        assert!(!truncated.complete);
        assert!(
            fs::metadata(truncated.path).expect("bounded report").len()
                <= MAX_ARTIFACT_BYTES as u64
        );

        let timed_out = writer
            .export_invalidation(
                "containment-loss"
                    .parse::<EpochInvalidationTrigger>()
                    .expect("closed trigger"),
                &[("diagnostics", "bounded")],
                Instant::now() - Duration::from_secs(3),
            )
            .expect("time-bounded export");
        assert!(!timed_out.complete);

        for generation in 0..22 {
            let marker = format!("retention-marker-{generation}");
            writer
                .export_invalidation(
                    "member-exit"
                        .parse::<EpochInvalidationTrigger>()
                        .expect("closed trigger"),
                    &[("diagnostics", marker.as_str())],
                    Instant::now(),
                )
                .expect("retained report");
        }
        let retained = fs::read_dir(&root)
            .expect("retained evidence")
            .map(|entry| {
                fs::read_to_string(entry.expect("owned evidence").path()).expect("evidence text")
            })
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), RETAINED_ARTIFACTS);
        assert!(
            !retained
                .iter()
                .any(|artifact| artifact.contains("retention-marker-0"))
        );
        assert!(
            retained
                .iter()
                .any(|artifact| artifact.contains("retention-marker-21"))
        );

        assert_eq!(
            measure_fence_to_ready(Duration::from_secs(90), true),
            RebuildMeasurement {
                ready: true,
                target_met: true
            }
        );
        assert_eq!(
            measure_fence_to_ready(Duration::from_secs(300), true),
            RebuildMeasurement {
                ready: true,
                target_met: false
            }
        );
        assert_eq!(
            measure_fence_to_ready(Duration::from_secs(301), true),
            RebuildMeasurement {
                ready: false,
                target_met: false
            }
        );
        assert!(!measure_fence_to_ready(Duration::from_secs(1), false).ready);

        let _ = fs::remove_dir_all(root);
    }
}
