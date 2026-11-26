//! Private v1 physical address for an admitted Sandbox incarnation.
//!
//! The current serving wire carries an opaque v0.1 Sandbox locator. The v1
//! adapter stays staged until the incarnation owner supplies the guarded row.
//! See NanoHost Runtime And Transport, Sandbox Incarnation Map, and OpenShell
//! Gateway, Physical Sandbox Address.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

pub(crate) const INCARNATION_LABEL: &str = "openkit.dev/sbxi";
pub(crate) const EPOCH_LABEL: &str = "openkit.dev/hepoch";

/// A physical locator is never authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddressError {
    Conflict,
    Unknown,
}

/// Scope bound to the authenticated epoch-local SDK connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProviderScope<'a> {
    pub gateway: &'a str,
    pub workspace: &'a str,
    pub host_epoch: &'a str,
}

/// The adapter reads these fields from the incarnation owner. The owner must
/// include every overlapping or still-actionable row in this routing domain.
pub(crate) struct IncarnationRow<'a> {
    pub scope: ProviderScope<'a>,
    pub incarnation: &'a str,
    pub mapping_version: u8,
    pub create_intent: &'a str,
    pub native_id: Option<&'a str>,
    pub attachment_generation: u64,
    pub stopped: bool,
}

/// Borrows the owner's exclusive operation view for the whole provider call.
/// The incarnation owner holds the durable exclusion across an unknown outcome.
pub(crate) struct BoundAddress<'row, 'scope> {
    row: &'row IncarnationRow<'scope>,
    name: String,
}

impl<'row, 'scope> BoundAddress<'row, 'scope> {
    pub(crate) fn from_rows(
        scope: ProviderScope<'scope>,
        rows: &'row mut [IncarnationRow<'scope>],
        incarnation: &str,
    ) -> Result<Self, AddressError> {
        Self::bind(scope, rows, incarnation, sandbox_name)
    }

    fn bind(
        scope: ProviderScope<'scope>,
        rows: &'row [IncarnationRow<'scope>],
        incarnation: &str,
        name_for: impl Fn(&str) -> Result<String, AddressError>,
    ) -> Result<Self, AddressError> {
        let mut matches = rows.iter().filter(|row| row.incarnation == incarnation);
        let row = matches.next().ok_or(AddressError::Conflict)?;
        if matches.next().is_some()
            || row.scope != scope
            || row.mapping_version != 1
            || row.scope.gateway.is_empty()
            || row.scope.workspace.is_empty()
            || !canonical_v7(row.scope.host_epoch, "hepoch_")
            || row.create_intent.is_empty()
            || row.native_id.is_some_and(str::is_empty)
        {
            return Err(AddressError::Conflict);
        }
        let name = name_for(row.incarnation)?;
        for other in rows.iter().filter(|other| {
            other.incarnation != incarnation
                && other.scope.gateway == scope.gateway
                && other.scope.workspace == scope.workspace
        }) {
            if other.mapping_version != 1 || name_for(other.incarnation)? == name {
                return Err(AddressError::Conflict);
            }
        }
        Ok(Self { row, name })
    }

    /// Verifies one inventory object without issuing a mutation capability.
    pub(crate) fn observe_inventory(
        scope: ProviderScope<'scope>,
        rows: &'row [IncarnationRow<'scope>],
        observed: &openshell_sdk::SandboxRef,
    ) -> Result<(), AddressError> {
        let incarnation = observed
            .labels
            .get(INCARNATION_LABEL)
            .ok_or(AddressError::Conflict)?;
        let address = Self::bind(scope, rows, incarnation, sandbox_name)?;
        address.observe(
            &observed.workspace,
            &observed.name,
            &observed.id,
            &observed.labels,
        )
    }

    pub(crate) fn scope(&self) -> ProviderScope<'_> {
        self.row.scope
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// Project reserved labels only from the original admitted create.
    pub(crate) fn create_labels(
        &self,
        intent: &str,
        labels: &mut HashMap<String, String>,
    ) -> Result<(), AddressError> {
        if self.row.stopped
            || self.row.native_id.is_some()
            || self.row.create_intent != intent
            || labels.contains_key(INCARNATION_LABEL)
            || labels.contains_key(EPOCH_LABEL)
        {
            return Err(AddressError::Conflict);
        }
        labels.insert(INCARNATION_LABEL.into(), self.row.incarnation.into());
        labels.insert(EPOCH_LABEL.into(), self.row.scope.host_epoch.into());
        Ok(())
    }

    /// Verify reverse labels as evidence against the original authority.
    pub(crate) fn observe(
        &self,
        workspace: &str,
        name: &str,
        native_id: &str,
        labels: &HashMap<String, String>,
    ) -> Result<(), AddressError> {
        if workspace != self.row.scope.workspace
            || name != self.name
            || native_id.is_empty()
            || self
                .row
                .native_id
                .is_some_and(|expected| expected != native_id)
            || labels.get(INCARNATION_LABEL).map(String::as_str) != Some(self.row.incarnation)
            || labels.get(EPOCH_LABEL).map(String::as_str) != Some(self.row.scope.host_epoch)
        {
            return Err(AddressError::Conflict);
        }
        Ok(())
    }

    /// Delete consumes the original command's expectation after ingress closes.
    pub(crate) fn check_delete(
        &self,
        original_native_id: &str,
        original_attachment_generation: u64,
    ) -> Result<(), AddressError> {
        if !self.row.stopped
            || self.row.native_id != Some(original_native_id)
            || self.row.attachment_generation != original_attachment_generation
        {
            return Err(AddressError::Conflict);
        }
        Ok(())
    }
}

/// OpenShell Gateway, Physical Sandbox Address. The domain tag and all 41
/// canonical ASCII identity bytes precede truncation to the first 80 bits.
fn sandbox_name(incarnation: &str) -> Result<String, AddressError> {
    if !canonical_v7(incarnation, "sbxi_") {
        return Err(AddressError::Conflict);
    }
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut hash = Sha256::new();
    hash.update(b"openkit/openshell-sandbox-name/v1\0");
    hash.update(incarnation.as_bytes());
    let digest = hash.finalize();
    let mut name = String::from("nh-");
    for bytes in digest[..10].chunks_exact(5) {
        let mut group: u64 = 0;
        for byte in bytes {
            group = (group << 8) | u64::from(*byte);
        }
        for shift in (0..8).rev() {
            name.push(char::from(ALPHABET[((group >> (shift * 5)) & 31) as usize]));
        }
    }
    Ok(name)
}

/// Protocol Identifiers And Enums, typed runtime identities.
fn canonical_v7(value: &str, prefix: &str) -> bool {
    let Some(uuid) = value.strip_prefix(prefix).map(str::as_bytes) else {
        return false;
    };
    uuid.len() == 36
        && uuid[14] == b'7'
        && matches!(uuid[19], b'8' | b'9' | b'a' | b'b')
        && uuid.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                matches!(byte, b'0'..=b'9' | b'a'..=b'f')
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR: &str = "sbxi_019af584-1234-7abc-8123-456789abcdef";
    const SECOND: &str = "sbxi_019af584-1234-7abc-8123-456789abcdee";
    const SCOPE: ProviderScope<'_> = ProviderScope {
        gateway: "lab-gateway",
        workspace: "default",
        host_epoch: "hepoch_019af584-8888-7abc-8123-456789abcdef",
    };

    fn row(incarnation: &'static str) -> IncarnationRow<'static> {
        IncarnationRow {
            scope: SCOPE,
            incarnation,
            mapping_version: 1,
            create_intent: "original",
            native_id: None,
            attachment_generation: 7,
            stopped: false,
        }
    }

    #[test]
    fn maps_the_fixed_vector_and_refuses_noncanonical_input() {
        assert_eq!(sandbox_name(VECTOR).unwrap(), "nh-keplbp5c6sa3ohuf");
        assert_eq!(
            sandbox_name(&VECTOR.to_ascii_uppercase()),
            Err(AddressError::Conflict)
        );
        assert_eq!(
            sandbox_name(&VECTOR.replace("-7abc-", "-4abc-")),
            Err(AddressError::Conflict)
        );
    }

    #[test]
    fn a_forced_prefix_collision_refuses_before_native_dispatch() {
        let rows = [row(VECTOR), row(SECOND)];
        let mut calls = 0;
        let result = BoundAddress::bind(SCOPE, &rows, VECTOR, |_| Ok("nh-keplbp5c6sa3ohuf".into()))
            .map(|_| calls += 1);
        assert_eq!(result, Err(AddressError::Conflict));
        assert_eq!(calls, 0);
    }

    #[test]
    fn stale_scope_label_native_id_and_delete_expectations_refuse() {
        let mut rows = [row(VECTOR)];
        {
            let bound = BoundAddress::from_rows(SCOPE, &mut rows, VECTOR).unwrap();
            let mut labels = HashMap::new();
            assert_eq!(
                bound.create_labels("different", &mut labels),
                Err(AddressError::Conflict)
            );
            bound.create_labels("original", &mut labels).unwrap();
            assert_eq!(labels[INCARNATION_LABEL].len(), 41);
            assert_eq!(labels[EPOCH_LABEL].len(), 43);
            assert_eq!(
                bound.observe("other", bound.name(), "first", &labels),
                Err(AddressError::Conflict)
            );
            assert!(
                bound
                    .observe("default", bound.name(), "first", &labels)
                    .is_ok()
            );
        }
        rows[0].native_id = Some("successor");
        rows[0].stopped = true;
        let bound = BoundAddress::from_rows(SCOPE, &mut rows, VECTOR).unwrap();
        let labels = HashMap::from([
            (EPOCH_LABEL.into(), SCOPE.host_epoch.into()),
            (INCARNATION_LABEL.into(), VECTOR.into()),
        ]);
        assert_eq!(
            bound.observe("default", bound.name(), "predecessor", &labels),
            Err(AddressError::Conflict)
        );
        let mut wrong = labels;
        wrong.insert(INCARNATION_LABEL.into(), SECOND.into());
        assert_eq!(
            bound.observe("default", bound.name(), "successor", &wrong),
            Err(AddressError::Conflict)
        );
        assert_eq!(
            bound.check_delete("predecessor", 7),
            Err(AddressError::Conflict)
        );
        assert_eq!(
            bound.check_delete("successor", 6),
            Err(AddressError::Conflict)
        );
        assert!(bound.check_delete("successor", 7).is_ok());
        assert_eq!(
            bound.create_labels("original", &mut wrong),
            Err(AddressError::Conflict)
        );
    }
}
