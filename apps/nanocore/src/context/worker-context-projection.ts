import { assertCanonicalDirectory } from '@openkit/storage';
/** A contradictory ordinary Context Package projection remains inspect-only. */
export class WorkerContextProjectionError extends Error {
  public readonly code = 'recovery_required';
  public readonly status = 409;
  public constructor(_code: string, message: string) {
    super(message);
  }
}

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadMaterialActiveDelivery, ThreadTaskInput } from '@openkit/app-api-schemas';
import { compareCodeUnits, isSealedTurnTerminal, workspaceIdForOwner } from '@openkit/protocol';
import { StructuredWorkerDelegationRequestSchema } from '../internal-agents/delegation.js';
import type { FsStore } from '../lib/store.js';
import {
  listSchedulerAdmissionEntriesForWorkspace,
  readSchedulerAdmissionPagesForWorkspace,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import { StoredTurnV1Schema } from '../storage/retained-work-metadata-v1.js';
import {
  nativeProductMetadataScope,
  readNativeProductPages,
} from '../storage/workspace-file-records.js';

import {
  createWorkerContextPackageAuthorityReader,
  createWorkerContextPackageAuthorityStepReader,
} from './worker-context-authorities.js';
import {
  readPortableWorkerContextPackageTrace,
  readPortableWorkerContextPackageTraceSteps,
  readWorkerContextPackageTrace,
  type WorkerContextPackageTrace,
} from './worker-context-package.js';

/** One fully verified trace paired with its owning Turn timestamp. */
export interface VerifiedWorkerContextTrace {
  /** Accepted Turn start time used by the S16 read-model ordering rule. */
  readonly startedAt: string;
  /** Immutable trace already accepted by the shared S39 verifier. */
  readonly trace: WorkerContextPackageTrace;
  /** Exact authority branch that fully verified the trace. */
  readonly verification: 'strict' | 'imported-history';
}

/** Derived Material revision identities exposed by the Thread read model. */
export interface ThreadMaterialTraceProjection {
  /** Latest verified revision seen by any accepted worker Turn. */
  readonly lastWorkerSeenRevisionId: string | null;
  /** Revision selected by the exact current accepted worker Turn. */
  readonly currentTurnRevisionId: string | null;
}

/** Existing authorities required to derive one Thread's worker Context Package read state. */
export interface WorkerContextProjectionInput {
  /** Core scheduler and backend-session owner. */
  readonly coreDb: CoreDb;
  /** Product Turn, Item, and AgentSession owner. */
  readonly store: FsStore;
  /** Workspace-owned Goal, Material, package, and steering owner. */
  readonly workspaceDb: WorkspaceDb;
  /** Thread whose immutable traces are inspected. */
  readonly threadId: string;
}

/**
 * Reads one strict accepted S39 digest without promoting imported or incomplete history.
 *
 * @param input Existing authorities plus the exact Turn to verify.
 * @returns Digest from the fully verified immutable Context Package trace.
 * @throws Error when the strict trace or any required authority is unavailable or contradictory.
 */
export function readStrictWorkerContextPackageDigest(
  input: WorkerContextProjectionInput & { readonly turnId: string }
): string {
  const workspaceId = input.workspaceDb.workspaceId;
  const workspaceRoot = resolveDataRootPath(input.workspaceDb.dataRoot, 'workspaces', workspaceId);

  return readWorkerContextPackageTrace({
    authorities: createWorkerContextPackageAuthorityReader(input),
    threadId: input.threadId,
    turnId: input.turnId,
    workspaceId,
    workspaceRoot,
  }).contextPackageDigest;
}

/**
 * Derives `{ itemId, objective }` summaries from fully verified Context Package traces.
 *
 * Missing, inconsistent, unsupported, or malformed per-Turn proof omits that summary and does
 * not rewrite the original Item. The projection stores nothing.
 *
 * Check request eligibility before expensive provenance reads so dashboard polling cannot make
 * impossible summaries compete with Turn completion. This only rejects candidates; every
 * published summary still requires the complete shared verifier and exact Item/digest checks.
 *
 * @param input Existing authorities plus the Thread whose Turns are inspected.
 * @returns Proven initiating-request summaries in Thread Turn order.
 */
export function projectThreadTaskInputs(input: WorkerContextProjectionInput): ThreadTaskInput[] {
  const workspaceId = input.workspaceDb.workspaceId;
  const workspaceRoot = resolveDataRootPath(input.workspaceDb.dataRoot, 'workspaces', workspaceId);
  const turns = input.store.listThreadTurns(workspaceId, input.threadId);
  let authorities: ReturnType<typeof createWorkerContextPackageAuthorityReader>;
  try {
    authorities = createWorkerContextPackageAuthorityReader(input);
  } catch {
    return [];
  }

  const itemsById = new Map(
    input.store.listThreadItems(workspaceId, input.threadId).flatMap((item) => {
      if (item.type !== 'user-message') return [];
      try {
        const parsed = StructuredWorkerDelegationRequestSchema.safeParse(JSON.parse(item.text));
        return parsed.success
          ? [[item.id, { item, objective: parsed.data.objective }] as const]
          : [];
      } catch {
        return [];
      }
    })
  );
  const summaries: ThreadTaskInput[] = [];
  for (const turn of turns) {
    if (![...itemsById.values()].some(({ item }) => item.turnId === turn.id)) continue;
    try {
      const trace = readWorkerContextPackageTrace({
        authorities,
        threadId: input.threadId,
        turnId: turn.id,
        workspaceId,
        workspaceRoot,
      });
      const candidate = itemsById.get(trace.workerRequestItemId);
      if (!candidate) continue;
      const { item, objective } = candidate;
      if (
        workspaceIdForOwner(item.owner) !== workspaceId ||
        item.threadId !== input.threadId ||
        item.turnId !== turn.id ||
        item.type !== 'user-message' ||
        `sha256:${createHash('sha256').update(item.text).digest('hex')}` !==
          trace.workerRequestDigest
      ) {
        continue;
      }
      summaries.push({ itemId: item.id, objective });
    } catch {}
  }
  return summaries;
}

/** Derived S16 fields added to the Thread Material read model. */
export interface ThreadMaterialContextProjection extends ThreadMaterialTraceProjection {
  /** Current pending delivery for this exact Material, if any. */
  readonly activeDelivery: ThreadMaterialActiveDelivery | null;
}

/**
 * Selects Material revision identities from already-verified S39 traces.
 *
 * @param input Material identity, exact current Turn, and verified trace set.
 * @returns Historical and current revision projections without persisting derived state.
 */
export function projectVerifiedThreadMaterialTraces(input: {
  readonly materialId: string;
  readonly currentTurnId: string | null;
  readonly traces: readonly VerifiedWorkerContextTrace[];
}): ThreadMaterialTraceProjection {
  const traces = [...input.traces].sort(
    (left, right) =>
      compareCodeUnits(right.startedAt, left.startedAt) ||
      compareCodeUnits(right.trace.turnId, left.trace.turnId)
  );
  const revisionFor = (trace: WorkerContextPackageTrace | undefined): string | null =>
    trace?.materialSelections.find((selection) => selection.materialId === input.materialId)
      ?.revisionId ?? null;

  return {
    lastWorkerSeenRevisionId:
      traces.map(({ trace }) => revisionFor(trace)).find((revisionId) => revisionId !== null) ??
      null,
    currentTurnRevisionId: revisionFor(
      traces.find(
        ({ trace, verification }) =>
          verification === 'strict' && trace.turnId === input.currentTurnId
      )?.trace
    ),
  };
}

/** Reads and fully verifies every accepted trace file present in one Thread. */
export function readVerifiedThreadWorkerContextTraces(
  input: WorkerContextProjectionInput
): VerifiedWorkerContextTrace[] {
  const steps = readVerifiedThreadWorkerContextTracesWithOwners(input, true);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Discovers trace candidates through admitted native metadata pages, then uses the original S39 verifier.
 * Each metadata page and selected trace ends before yielding, with no SQL transaction held by this
 * reader. Scheduler admission selection and internal S39 callbacks retain their existing lifetimes
 * and collection costs; one complete Thread or trace is not a bounded-step guarantee.
 */
export function* readVerifiedThreadWorkerContextTraceSteps(
  input: WorkerContextProjectionInput
): Generator<void, VerifiedWorkerContextTrace[], void> {
  return yield* readVerifiedThreadWorkerContextTracesWithOwners(input, false);
}

/** Ordinary roots retain owner-local selections; native preparation uses released owners. */
function* readVerifiedThreadWorkerContextTracesWithOwners(
  input: WorkerContextProjectionInput,
  synchronousLeafReads: boolean
): Generator<void, VerifiedWorkerContextTrace[], void> {
  const workspaceId = input.workspaceDb.workspaceId;
  const workspaceRoot = resolveDataRootPath(input.workspaceDb.dataRoot, 'workspaces', workspaceId);
  input.store.getThread(workspaceId, input.threadId);
  const scope = {
    ...nativeProductMetadataScope(
      input.workspaceDb.dataRoot,
      { kind: 'workspace', workspaceId },
      workspaceRoot
    ),
    sqlite: input.workspaceDb.sqlite,
  };
  const turns: ReturnType<typeof StoredTurnV1Schema.parse>[] = [];
  const turnsWithTrace: typeof turns = [];
  for (const page of readNativeProductPages(scope, 'turn')) {
    for (const row of page) {
      if (row.record.threadId !== input.threadId) continue;
      const turn = StoredTurnV1Schema.parse(row.record);
      turns.push(turn);
      if (
        existsSync(
          join(workspaceRoot, 'threads', input.threadId, 'turns', turn.id, 'context-package.json')
        )
      ) {
        turnsWithTrace.push(turn);
      }
    }
    yield;
  }
  // Preserve Store's trace order, including native id order for equal timestamps.
  turnsWithTrace.sort((a, b) => compareCodeUnits(a.startedAt ?? '', b.startedAt ?? ''));
  const admitted: ReturnType<typeof listSchedulerAdmissionEntriesForWorkspace> = [];
  if (synchronousLeafReads) {
    admitted.push(
      ...listSchedulerAdmissionEntriesForWorkspace(input.coreDb, {
        workspaceId,
        statuses: ['admitted'],
      }).filter((entry) => entry.threadId === input.threadId)
    );
  } else {
    for (const page of readSchedulerAdmissionPagesForWorkspace(input.coreDb, {
      workspaceId,
      statuses: ['admitted'],
    })) {
      admitted.push(...page.filter((entry) => entry.threadId === input.threadId));
      yield;
    }
  }
  if (
    turns.some(
      (turn) =>
        turn.agentSessionId != null && !turnsWithTrace.some((candidate) => candidate.id === turn.id)
    ) ||
    admitted.some((entry) => !turnsWithTrace.some((turn) => turn.id === entry.turnId))
  ) {
    throw recoveryRequired(
      'An accepted worker Turn or admitted scheduler entry lacks its Context Package trace.'
    );
  }
  if (turnsWithTrace.length === 0) {
    return [];
  }

  // Record only the native boundary reached; exception text can contain private paths or bytes.
  let failedCheck:
    | 'createWorkerContextPackageAuthorityReader'
    | 'assertCanonicalDirectory'
    | 'readPortableWorkerContextPackageTrace'
    | 'turn.startedAt' = 'createWorkerContextPackageAuthorityReader';
  try {
    const authorities = synchronousLeafReads
      ? createWorkerContextPackageAuthorityReader(input)
      : null;
    const authoritySteps = synchronousLeafReads
      ? null
      : createWorkerContextPackageAuthorityStepReader(input);
    const traces: VerifiedWorkerContextTrace[] = [];
    for (const turn of turnsWithTrace) {
      failedCheck = 'assertCanonicalDirectory';
      for (const directory of [
        workspaceRoot,
        join(workspaceRoot, 'threads'),
        join(workspaceRoot, 'threads', input.threadId),
        join(workspaceRoot, 'threads', input.threadId, 'turns'),
        join(workspaceRoot, 'threads', input.threadId, 'turns', turn.id),
      ]) {
        assertCanonicalDirectory(directory);
      }
      failedCheck = 'readPortableWorkerContextPackageTrace';
      const traceInput = {
        workspaceId,
        threadId: input.threadId,
        turnId: turn.id,
        workspaceRoot,
      };
      const verified = authorities
        ? readPortableWorkerContextPackageTrace({ ...traceInput, authorities })
        : yield* readPortableWorkerContextPackageTraceSteps({
            ...traceInput,
            authorities: authoritySteps!,
          });
      failedCheck = 'turn.startedAt';
      if (!turn.startedAt) {
        throw new Error('Worker Context Package Turn lacks its start time.');
      }
      traces.push({ startedAt: turn.startedAt, ...verified });
      yield;
    }
    return traces;
  } catch {
    throw recoveryRequired(
      `Worker Context Package verification failed: owner=worker-context-projection; check=${failedCheck}; stage=thread-material-read.`
    );
  }
}

/**
 * Derives the S16 worker-seen and active-delivery fields for one bound Material.
 *
 * @param input Existing authority owners, Thread scope, and bound Material identity.
 * @returns Three read-only fields backed only by current durable owners.
 * @throws GoalSteeringAuthorityError when a trace or pending owner is contradictory.
 */
export function projectThreadMaterialContext(
  input: WorkerContextProjectionInput & { readonly materialId: string }
): ThreadMaterialContextProjection {
  const verifiedTraces = readVerifiedThreadWorkerContextTraces(input);
  const nonTerminalTurns = input.store
    .listThreadTurns(input.workspaceDb.workspaceId, input.threadId)
    .filter((turn) => !isSealedTurnTerminal(turn.status));
  if (nonTerminalTurns.length > 1) {
    throw recoveryRequired('The Thread has ambiguous non-terminal Turn authority.');
  }
  const currentTurnId = verifiedTraces.some(
    ({ trace, verification }) =>
      verification === 'strict' && trace.turnId === nonTerminalTurns[0]?.id
  )
    ? (nonTerminalTurns[0]?.id ?? null)
    : null;
  const traceProjection = projectVerifiedThreadMaterialTraces({
    materialId: input.materialId,
    currentTurnId,
    traces: verifiedTraces,
  });
  return { ...traceProjection, activeDelivery: null };
}

/** Creates the product-safe fail-closed error used by S16 read projections. */
function recoveryRequired(message: string): WorkerContextProjectionError {
  return new WorkerContextProjectionError('recovery_required', message);
}
