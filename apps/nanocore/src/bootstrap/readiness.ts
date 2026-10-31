import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { WorkspaceIdSchema } from '@openkit/protocol';
import { OperationError } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';
import type {
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';

/** A refused authority or unavailable projection; never persisted or used as replacement truth. */
export interface ScopeAdmissionFailure {
  readonly scope: 'workspace' | 'user';
  readonly id: string;
  readonly check: 'layout' | 'database' | 'records' | 'recovery' | 'index' | 'retired';
  /** First unsupported canonical feature identifier; excludes arbitrary record or parser content. */
  readonly requiredFeature?: string;
}

// Boot and ordinary callers share refusal until restart or exact-target recovery revalidates authority.
const scopeFailures = new Map<string, Map<string, ScopeAdmissionFailure>>();

/** Records the first failed check; trusted durable retirement supersedes that diagnostic without changing bytes. */
export function refuseScope(dataRoot: string, failure: ScopeAdmissionFailure): void {
  const root = resolve(dataRoot);
  let failures = scopeFailures.get(root);
  if (!failures) {
    failures = new Map();
    scopeFailures.set(root, failures);
  }
  const key = `${failure.scope}:${failure.id}:${failure.check === 'index' ? 'index' : 'authority'}`;
  if (failure.check === 'retired' || !failures.has(key)) failures.set(key, failure);
}

/**
 * Restores registry-owned retirement exclusion before any scoped migration, content load or recovery.
 * @param input Verified Core authority and the existing process-local mutation gate.
 * @throws When retired registry identity cannot be established; no retained Workspace is opened.
 */
export function restoreWorkspaceRetirementAdmission(input: {
  readonly coreDb: CoreDb;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
}): void {
  const rows = input.coreDb.sqlite
    .prepare("SELECT workspace_id AS workspaceId FROM workspace_registry WHERE status = 'retired'")
    .all() as Array<{ workspaceId: string }>;
  for (const row of rows) {
    const workspaceId = WorkspaceIdSchema.parse(row.workspaceId);
    refuseScope(input.coreDb.dataRoot, { scope: 'workspace', id: workspaceId, check: 'retired' });
    input.workspaceMutationAdmission.restoreClosed(workspaceId);
  }
}

/** Returns bounded, owner-authored diagnoses for the existing authorized readiness projection. */
export function scopeAdmissionFailures(dataRoot: string): readonly ScopeAdmissionFailure[] {
  return [...(scopeFailures.get(resolve(dataRoot))?.values() ?? [])];
}

/** Removes only the exact recovery diagnosis after its owner validates the target under this freeze. */
export function settleWorkspaceRecoveryScope(input: {
  readonly dataRoot: string;
  readonly failure: ScopeAdmissionFailure;
  readonly admission: WorkspaceMutationAdmission;
  readonly freeze: WorkspaceFrozenAdmission;
}): void {
  const { failure } = input;
  const failures = scopeFailures.get(resolve(input.dataRoot));
  const key = `workspace:${failure.id}:authority`;
  if (
    failure.scope !== 'workspace' ||
    failure.check !== 'recovery' ||
    failures?.get(key) !== failure ||
    !input.admission.ownsFreeze(failure.id, input.freeze)
  )
    throw new OperationError('recovery_required', 'Workspace recovery is not current.', 409);
  failures.delete(key);
}

/** Tests admission without opening or reconstructing a refused scope. */
export function isScopeAdmitted(
  dataRoot: string,
  scope: ScopeAdmissionFailure['scope'],
  id: string
): boolean {
  return !scopeFailures.get(resolve(dataRoot))?.has(`${scope}:${id}:authority`);
}

/** Refuses dependent operations while leaving other scopes and server authority available. */
export function assertScopeAdmitted(
  dataRoot: string,
  scope: ScopeAdmissionFailure['scope'],
  id: string
): void {
  if (!isScopeAdmitted(dataRoot, scope, id)) {
    const failure = scopeFailures.get(resolve(dataRoot))!.get(`${scope}:${id}:authority`)!;
    throw new OperationError(
      'recovery_required',
      `storage: ${scope} ${id} quarantined; check=${failure.check}; stage=scope-admission.`,
      409
    );
  }
}

/** Adds scope-local degradation without making a healthy sibling globally unready. */
export function withScopeAdmissionReadiness(
  snapshot: BootReadinessSnapshot,
  dataRoot: string
): BootReadinessSnapshot {
  const failures = scopeAdmissionFailures(dataRoot).filter(
    (failure) =>
      scopeFailures.get(resolve(dataRoot))?.get(`${failure.scope}:${failure.id}:authority`)
        ?.check !== 'retired'
  );
  if (failures.length === 0) return snapshot;
  const subsystems = { ...snapshot.subsystems };
  for (const name of ['storage', 'knowledgeIndex'] as const) {
    const reasons = failures
      .filter((failure) =>
        name === 'knowledgeIndex' ? failure.check === 'index' : failure.check !== 'index'
      )
      .map((failure) => ({
        code: failure.check === 'index' ? 'storage.index-unavailable' : 'storage.scope-quarantined',
        message: `storage: ${failure.scope} ${failure.id}; check=${failure.check}; stage=scope-admission.${failure.requiredFeature ? ` requiredFeature=${failure.requiredFeature}.` : ''}`,
        blocks: [`${failure.scope}:${failure.id}${failure.check === 'index' ? ':index' : ''}`],
      }));
    if (reasons.length > 0)
      subsystems[name] = {
        state: subsystems[name].state === 'failed' ? 'failed' : 'degraded',
        reasons: [...subsystems[name].reasons, ...reasons],
      };
  }
  return {
    ...snapshot,
    overall: snapshot.overall === 'failed' ? 'failed' : 'degraded',
    subsystems,
  };
}

type BootSubsystemName = keyof BootReadinessSnapshot['subsystems'];

const BOOT_SUBSYSTEMS: BootSubsystemName[] = [
  'config',
  'storage',
  'policy',
  'vault',
  'scheduler',
  'llmGateway',
  'knowledgeIndex',
];
const CRITICAL_SUBSYSTEMS = new Set<BootSubsystemName>(['config', 'storage', 'policy']);

/** Input for computing a boot readiness snapshot. */
export interface BootReadinessInput {
  /** Stable boot id for this process run. */
  bootId: string;
  /** Subsystem states to override from the default ready baseline. */
  subsystems?: Partial<BootReadinessSnapshot['subsystems']>;
}

/**
 * Creates a stable boot id for one NanoCore process run.
 *
 * @returns Boot id.
 */
export function createBootId(): string {
  return `boot_${randomUUID()}`;
}

/**
 * Creates the first boot readiness projection for the current NanoCore process.
 *
 * @returns App API boot readiness read model.
 */
export function createBootReadinessSnapshot(): BootReadinessSnapshot {
  return computeBootReadinessSnapshot({ bootId: createBootId() });
}

/**
 * Computes a boot readiness projection from subsystem states.
 *
 * @param input Boot id and subsystem states.
 * @returns App API boot readiness read model.
 */
export function computeBootReadinessSnapshot(input: BootReadinessInput): BootReadinessSnapshot {
  const subsystems = Object.fromEntries(
    BOOT_SUBSYSTEMS.map((name) => [name, input.subsystems?.[name] ?? readySubsystem()])
  ) as BootReadinessSnapshot['subsystems'];
  const hasCriticalFailure = BOOT_SUBSYSTEMS.some(
    (name) => CRITICAL_SUBSYSTEMS.has(name) && subsystems[name].state === 'failed'
  );
  const hasNonReadySubsystem = BOOT_SUBSYSTEMS.some((name) => subsystems[name].state !== 'ready');

  return {
    bootId: input.bootId,
    acceptingProductWork: !hasCriticalFailure,
    overall: hasCriticalFailure ? 'failed' : hasNonReadySubsystem ? 'degraded' : 'ready',
    subsystems,
  };
}

/**
 * Derives readiness from current subsystem facts without probing or retaining another health state.
 *
 * @param input Boot outcomes and current Vault, Gateway supply and scoped index facts.
 * @returns Current diagnosis preserving critical failures and shutdown admission closure.
 */
export function computeCurrentReadiness(input: {
  readonly snapshot: BootReadinessSnapshot;
  readonly vaultHealth: 'available' | 'locked' | 'unavailable';
  readonly llmGatewayAvailable: boolean;
  readonly dataRoot: string;
}): BootReadinessSnapshot {
  const current = computeBootReadinessSnapshot({
    bootId: input.snapshot.bootId,
    subsystems: {
      ...input.snapshot.subsystems,
      vault:
        input.vaultHealth === 'available'
          ? readySubsystem()
          : {
              state: 'degraded',
              reasons: [
                {
                  code: input.vaultHealth === 'locked' ? 'vault.locked' : 'vault.unavailable',
                  message: 'Vault-dependent operations are unavailable.',
                  blocks: ['vault.read', 'vault.use', 'secret.inject'],
                },
              ],
            },
      llmGateway: input.llmGatewayAvailable
        ? readySubsystem()
        : {
            state: 'degraded',
            reasons: [
              {
                code: 'llm.gateway_unavailable',
                message: 'Gateway supply is unavailable or degraded.',
                blocks: ['llm.inference'],
              },
            ],
          },
    },
  });
  return withScopeAdmissionReadiness(
    {
      ...current,
      acceptingProductWork: input.snapshot.acceptingProductWork && current.acceptingProductWork,
    },
    input.dataRoot
  );
}

/**
 * Creates the shutdown readiness projection that stops product-work admission.
 *
 * @param snapshot Current boot readiness snapshot.
 * @returns Readiness snapshot with product work admission closed.
 */
export function createShutdownReadinessSnapshot(
  snapshot: BootReadinessSnapshot
): BootReadinessSnapshot {
  return {
    ...snapshot,
    acceptingProductWork: false,
    overall: snapshot.overall === 'failed' ? 'failed' : 'degraded',
    subsystems: {
      ...snapshot.subsystems,
      scheduler: {
        state: snapshot.subsystems.scheduler.state === 'failed' ? 'failed' : 'degraded',
        reasons: [
          ...snapshot.subsystems.scheduler.reasons,
          {
            code: 'shutdown.in_progress',
            message: 'NanoCore is shutting down.',
            blocks: ['product_work'],
          },
        ],
      },
    },
  };
}

/**
 * Creates a ready subsystem state with no degraded reasons.
 *
 * @returns Ready subsystem readiness state.
 */
function readySubsystem(): BootReadinessSnapshot['subsystems']['config'] {
  return { state: 'ready', reasons: [] };
}
