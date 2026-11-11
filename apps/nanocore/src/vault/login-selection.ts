/** Current, material-free quota observation projected by the Login lifecycle owner. */
export interface HarnessLoginQuotaObservation {
  /** Unknown includes a failed read; only an observed exhaustion blocks selection. */
  readonly state: 'unknown' | 'available' | 'exhausted';
  /** Material generation to which the observation belongs. */
  readonly materialGeneration: number;
  /** Observation time in epoch milliseconds, not a freshness or recovery promise. */
  readonly observedAt: number;
  /** Provider reset hint; passing it does not prove recovery. */
  readonly resetsAt?: number;
}

/** Already-authorized Login metadata; membership in this list grants no authority itself. */
export interface HarnessLoginCandidate {
  /** Exact User-owned Vault reference, never credential material. */
  readonly referenceId: string;
  /** Non-secret provider account identity shared by its refresh families. */
  readonly accountId: string;
  /** Current use authority relative to the attributed user and Workspace. */
  readonly ownership: 'own' | 'workspace-shared';
  /** Current material generation selected by the lifecycle owner. */
  readonly materialGeneration: number;
  /** Explicit family quarantine; ordinary request errors do not set it. */
  readonly quarantined: boolean;
  /** Conflicting refresh ownership, never concurrent access-only use. */
  readonly refreshBusy: boolean;
  /** Last departure from this Login by this Thread, in epoch milliseconds. */
  readonly lastLeftAt?: number;
  /** Current observation, or unknown when absent. */
  readonly quota?: HarnessLoginQuotaObservation;
}

/** The accepted default policy's use and replacement signals, without strategy variants. */
export type HarnessLoginSelectionTrigger =
  | 'use'
  | 'revoked'
  | 'quota-exhausted'
  | 'error'
  | 'explicit-request';

/** Reference-only inputs supplied by the current authorization and lifecycle owners. */
export interface HarnessLoginSelectionInput {
  /** Authorized references in stable owner-supplied order within each ownership class. */
  readonly eligible: readonly HarnessLoginCandidate[];
  /** Existing Thread affinity; a missing authorized candidate cannot be kept. */
  readonly threadBinding: { readonly referenceId: string } | null;
  /** The use or replacement signal evaluated for the outgoing binding. */
  readonly trigger: HarnessLoginSelectionTrigger;
  /** Caller-supplied current time in epoch milliseconds. */
  readonly now: number;
}

/** A selection is a proposal, never authorization, refreshed material or activation proof. */
export type HarnessLoginSelection =
  | { readonly kind: 'keep' | 'target'; readonly referenceId: string }
  | { readonly kind: 'unavailable' };

/** Only an explicit exhaustion observation for the current material generation blocks use. */
export function hasCurrentHarnessLoginExhaustion(
  quota: Pick<HarnessLoginQuotaObservation, 'state' | 'materialGeneration'> | undefined,
  materialGeneration: number
): boolean {
  return quota?.state === 'exhausted' && quota.materialGeneration === materialGeneration;
}

/**
 * Selects a harness Login without resolving material, changing metadata or performing effects.
 *
 * @param input Current authorized candidates, affinity, trigger and clock.
 * @returns Working affinity, a replacement proposal, or an explicit unavailable result.
 */
export function selectHarnessLogin(input: HarnessLoginSelectionInput): HarnessLoginSelection {
  const current = input.eligible.find(
    (candidate) => candidate.referenceId === input.threadBinding?.referenceId
  );
  // An allowance belongs to the account, not to an individual refresh family.
  const exhaustedAccounts = new Set(
    input.eligible
      .filter((candidate) =>
        hasCurrentHarnessLoginExhaustion(candidate.quota, candidate.materialGeneration)
      )
      .map((candidate) => candidate.accountId)
  );
  if (input.trigger === 'quota-exhausted' && current) {
    exhaustedAccounts.add(current.accountId);
  }

  const usable = (candidate: HarnessLoginCandidate): boolean =>
    !candidate.quarantined && !candidate.refreshBusy && !exhaustedAccounts.has(candidate.accountId);

  // An existing working binding is not a re-entry and does not consume a cooldown.
  if (input.trigger === 'use' && current && usable(current)) {
    return { kind: 'keep', referenceId: current.referenceId };
  }

  for (const ownership of ['own', 'workspace-shared'] as const) {
    const target = input.eligible.find(
      (candidate) =>
        candidate.ownership === ownership &&
        candidate.referenceId !== input.threadBinding?.referenceId &&
        usable(candidate) &&
        (candidate.lastLeftAt === undefined || input.now - candidate.lastLeftAt >= 60_000)
    );
    if (target) return { kind: 'target', referenceId: target.referenceId };
  }
  return { kind: 'unavailable' };
}
