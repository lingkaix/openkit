import type { KnowledgeOwnerScope } from '@openkit/protocol';

/** Trusted scope selection; scheduling does not grant publication delegation or source access. */
export interface KnowledgeMaintenanceScheduleScope {
  readonly ownerScope: KnowledgeOwnerScope;
  readonly schedule?: { readonly enabled: boolean } | undefined;
}

/** Existing Turn execution metadata needed to identify an already admitted daily run. */
export interface KnowledgeMaintenanceScheduleTurn {
  readonly startedAt: string;
  readonly internalExecution?: {
    readonly roleId: string;
    readonly knowledge?: {
      readonly purpose: 'query' | 'maintenance';
      readonly ownerScope: KnowledgeOwnerScope;
      readonly trigger: 'schedule' | 'request';
    };
  };
}

/** One already retained Turn; native execution and failure publication keep their existing owners. */
export interface PreparedKnowledgeMaintenanceScheduleRun {
  readonly execute: () => Promise<void>;
  readonly fail: (error: unknown) => void;
}

/** Native admission callbacks supply fresh authority, inputs and existing work-record publication. */
export interface DailyKnowledgeMaintenanceInput<Scope extends KnowledgeMaintenanceScheduleScope> {
  readonly now: string;
  readonly scopes: Iterable<Scope>;
  readonly listTurns: (scope: Scope) => readonly KnowledgeMaintenanceScheduleTurn[];
  /**
   * Retains a scheduled maintenance Turn before returning execution, or a visible failed/skipped outcome before returning null.
   * This boundary performs finite local preparation and current single-writer admission, never a Provider call.
   */
  readonly prepare: (
    scope: Scope,
    startedAt: string
  ) => PreparedKnowledgeMaintenanceScheduleRun | null;
  /** Reports unexpected admission or failure-publication errors; this reporting sink must not throw. */
  readonly onError: (error: unknown) => void;
}

/** Admits each enabled scope at most once per UTC day using only its retained maintenance Turns. */
export function scanDailyKnowledgeMaintenance<Scope extends KnowledgeMaintenanceScheduleScope>(
  input: DailyKnowledgeMaintenanceInput<Scope>
): void {
  const startedAt = new Date(input.now).toISOString();
  const day = startedAt.slice(0, 10);
  for (const scope of input.scopes) {
    if (!scope.schedule?.enabled) continue;
    try {
      const alreadyAdmitted = input.listTurns(scope).some((turn) => {
        const execution = turn.internalExecution;
        const knowledge = execution?.knowledge;
        return (
          execution?.roleId === 'knowledge-manager' &&
          knowledge?.purpose === 'maintenance' &&
          knowledge.trigger === 'schedule' &&
          sameOwner(knowledge.ownerScope, scope.ownerScope) &&
          new Date(turn.startedAt).toISOString().slice(0, 10) === day
        );
      });
      if (alreadyAdmitted) continue;
      const prepared = input.prepare(scope, startedAt);
      if (prepared) {
        // The durable Turn excludes another daily admission before provider work starts.
        void Promise.resolve().then(prepared.execute).catch(prepared.fail).catch(input.onError);
      }
    } catch (error) {
      input.onError(error);
    }
  }
}

/** Compares only the canonical notebook owner, never a caller-supplied destination or actor. */
function sameOwner(left: KnowledgeOwnerScope, right: KnowledgeOwnerScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'user') return right.kind === 'user' && left.userId === right.userId;
  if (left.kind === 'workspace')
    return right.kind === 'workspace' && left.workspaceId === right.workspaceId;
  return true;
}
