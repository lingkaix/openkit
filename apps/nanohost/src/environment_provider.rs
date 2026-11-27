//! NanoHost realization of the three Environment Provider Contract operations.
//!
//! See docs/specs/20261020-compute_neutrality_target.md, Environment Provider
//! Contract. These are process-local operations on already admitted orders. The
//! current Host session still carries provision and carrier orders separately.

use std::time::Duration;

use crate::epoch_coordinator::EpochFault;

/// Separates native absence after a failed create from an Epoch-invalidating fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleEffectError {
    /// The existing fail-stop fault still owns the complete Epoch.
    Epoch(EpochFault),
    /// Native absence is proved; the coordinator exposes this only after credential and attachment cleanup.
    CreateCleanupProved,
}

impl From<EpochFault> for LifecycleEffectError {
    fn from(fault: EpochFault) -> Self {
        Self::Epoch(fault)
    }
}

/// Keep present folds the template, envelope, Volume writer and carrier into
/// one contract. The current wire stages these two parts of the same order.
pub(crate) enum KeepPresent<T, E, A, C> {
    Provision {
        template: T,
        envelope: E,
        attachment: A,
    },
    Carry(C),
}

/// Physical readiness and shim readiness have different observations on the
/// current wire. A provision result has no proof about the carrier.
pub(crate) enum Present<S, B, M> {
    Provisioned(S),
    Carried { bridge: B, monitor: M },
}

/// The current wire orders carrier close separately from physical deletion.
/// The Sandbox name is an opaque address from the admitted incarnation.
pub(crate) enum KeepAbsent<'a, B> {
    Carrier(B),
    Sandbox {
        name: &'a str,
        expected_native_id: &'a str,
        timeout: Duration,
    },
}

/// The immediate outcome of a keep-absent order. Only the owner of the stop
/// unit can settle physical absence and authorize release.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Absent {
    CarrierClosed,
    /// Gateway NotFound for the original address. Retain the claim until the
    /// stop unit supplies independent physical absence proof.
    AwaitingPhysicalProof,
}

/// The absence declaration from the Environment Provider Contract.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AbsenceProof {
    /// Reserved for an implementation that can join all accepted work.
    #[allow(dead_code)]
    ExactWithinEpoch,
    EpochRenewalOnly,
}

/// A complete inventory observation for this provider connection. The owner
/// needs a predecessor-end witness separately to use a fresh empty inventory.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct ProviderInventory<S> {
    pub observed: Vec<S>,
    pub absence: AbsenceProof,
}

/// Environment Provider Contract operations on the provider's current epoch.
/// The outer session retains admission and owns rejection of stale authority.
pub(crate) trait EnvironmentProvider {
    type Template;
    type Envelope;
    type Attachment;
    type CarrierOrder;
    type Sandbox;
    type Bridge;
    type Monitor;

    async fn keep_present(
        &self,
        operation_id: &str,
        order: KeepPresent<Self::Template, Self::Envelope, Self::Attachment, Self::CarrierOrder>,
    ) -> Result<Present<Self::Sandbox, Self::Bridge, Self::Monitor>, LifecycleEffectError>;

    async fn keep_absent(&self, order: KeepAbsent<'_, Self::Bridge>) -> Result<Absent, EpochFault>;

    async fn report_inventory(&self) -> Result<ProviderInventory<Self::Sandbox>, EpochFault>;
}

#[cfg(test)]
#[path = "environment_provider_tests.rs"]
mod tests;
