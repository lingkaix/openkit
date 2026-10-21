import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { KnowledgeMaintenanceResponseSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  ActorRefSchema,
  allocateEntityId,
  isSealedTurnTerminal,
  KnowledgeOwnerScopeSchema,
  RequestIdSchema,
  responsibleUserIdForActor,
  ThreadIdSchema,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { findWorkspaceConfig, type RuntimeConfigManager } from '../config/runtime-config.js';
import { createAssistantHistory } from '../internal-agents/assistant-history.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import { readInternalContextEvidence } from '../internal-agents/internal-context-evidence.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { verifyKnowledgeProposalWorkHistory } from '../knowledge-source-authority.js';
import {
  commandRequestKey,
  type FsStore,
  type KnowledgeSourceRecord,
  quickChatWorkspaceIdForUser,
} from '../lib/store.js';

import {
  admitKnowledgeRetrieval,
  knowledgeSourceAudienceReadable,
  readAuthorizedWorkspaceNotebookPages,
  threadReadable,
} from '../retrieval-knowledge-adapter.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type IdempotentCommandReceipt,
  type InflightIdempotentCommand,
} from '../runtime/idempotent-command.js';
import {
  getCommandRequestRecordFromDb,
  normalizeCommandRequestResponse,
  recordControlCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import {
  applyControlProducts,
  assertControlProductWriter,
  type ControlProductMutation,
  decode as decodeControlProduct,
  readProduct,
} from '../storage/control-store-products.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  ensureCanonicalDirectoryAsync,
  nativeProductScope,
} from '../storage/workspace-file-records.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook, NotebookError } from './notebook.js';
import { createNotebookAgentEditing, NOTEBOOK_EDITING_LIMITS } from './notebook-agent-editing.js';
import { notebookAuthoringGuidance } from './notebook-authoring-guidance.js';
import { boundedNotebookDiff } from './notebook-history.js';
import {
  attributedNotebookPageBytes,
  type NotebookPublicationAdmission,
  type NotebookUpdate,
  publishWorkspaceNotebook,
} from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import {
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
} from './okf.js';
import { readSourcePointers } from './source-pointers.js';
import { publishCapturedSource } from './source-publication.js';
import { readManagedSourceText } from './source-reading.js';

type Turn = ReturnType<FsStore['getTurnById']>;

/** Original request facts from runIdempotentCommand, not a second request or receipt owner. */
const MaintenanceReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'knowledge.maintain',
      'knowledge.tell',
      'knowledge.server.maintain',
      'knowledge.server.tell',
    ]),
    requestId: RequestIdSchema,
    scope: z.union([
      z.object({ actorId: z.string().min(1), workspaceId: z.string().min(1) }).strict(),
      z.object({ actorId: z.string().min(1), coreId: z.literal('server') }).strict(),
    ]),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.literal('turn'),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Closed native admission; model content cannot select a database, execution callback, or immutable byte body. */
export const ControlMaintenanceAdmissionInputSchema = z
  .object({
    purpose: z.enum(['maintenance', 'query']),
    ownerScope: KnowledgeOwnerScopeSchema,
    actor: ActorRefSchema,
    requestId: RequestIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    startedAt: z.string().datetime(),
    trigger: z.enum(['request', 'schedule']),
    instructions: z.string().max(64 * 1024),
    captureCoverage: z
      .object({ scope: z.enum(['server', 'workspace', 'task']), value: z.enum(['off', 'on']) })
      .strict(),
    outputThreadId: ThreadIdSchema.optional(),
    receipt: MaintenanceReceiptSchema.optional(),
  })
  .strict();

/** Structured-clone input to the existing control worker; authority is admitted before dispatch. */
export type ControlMaintenanceAdmissionInput = z.infer<
  typeof ControlMaintenanceAdmissionInputSchema
>;

/** Only acknowledged product identities leave SQL; busy admission has no permission to invoke a model. */
export const ControlMaintenanceAdmissionResultSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  busy: z.boolean(),
  replayed: z.boolean(),
});

/** A complete acknowledged admission result; consumers ignore additive descriptive fields. */
export type ControlMaintenanceAdmissionResult = z.infer<
  typeof ControlMaintenanceAdmissionResultSchema
>;

/**
 * Selects and admits complete Knowledge work against current native scope state in the caller's savepoint.
 *
 * Workspace/User maintenance serializes on its existing notebook Thread. Queries always create a fresh Thread. User Memory receipts remain in User SQLite and cannot join this Workspace transaction. No file effects, sibling connection, callback, or commit occurs here.
 */
export function applyControlMaintenanceAdmission(
  db: CoreDb | WorkspaceDb,
  value: ControlMaintenanceAdmissionInput
): ControlMaintenanceAdmissionResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlMaintenanceAdmissionInputSchema.parse(value);
  const userId = responsibleUserIdForActor(input.actor);
  if (!userId) throw new NotebookError('invalid_request');
  const owner =
    db.scope === 'core'
      ? { kind: 'server' as const }
      : { kind: 'workspace' as const, workspaceId: db.workspaceId };
  if (
    (input.ownerScope.kind === 'server') !== (db.scope === 'core') ||
    (input.ownerScope.kind === 'workspace' &&
      (db.scope !== 'workspace' || input.ownerScope.workspaceId !== db.workspaceId)) ||
    (input.ownerScope.kind === 'user' &&
      (input.ownerScope.userId !== userId ||
        db.scope !== 'workspace' ||
        (input.purpose === 'maintenance' &&
          db.workspaceId !== quickChatWorkspaceIdForUser(userId)))) ||
    (input.purpose === 'query' && (db.scope !== 'workspace' || input.trigger !== 'request')) ||
    (input.purpose === 'maintenance' && input.outputThreadId !== undefined)
  )
    throw new NotebookError('invalid_request');
  const receipt = input.receipt;
  if (receipt) {
    if (
      input.purpose !== 'maintenance' ||
      input.ownerScope.kind === 'user' ||
      receipt.requestId !== input.requestId ||
      receipt.scope.actorId !== input.actor.id ||
      receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
      receipt.expiresAt <= receipt.createdAt ||
      (owner.kind === 'server'
        ? !('coreId' in receipt.scope) ||
          receipt.scope.coreId !== 'server' ||
          !receipt.command.startsWith('knowledge.server.')
        : !('workspaceId' in receipt.scope) ||
          receipt.scope.workspaceId !== owner.workspaceId ||
          receipt.command.startsWith('knowledge.server.'))
    )
      throw new NotebookError('invalid_request');
    const prior = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
    if (prior) {
      if (
        prior.command !== receipt.command ||
        prior.requestId !== receipt.requestId ||
        commandRequestKey(prior.command, prior.requestId, prior.scope) !== receipt.key
      )
        throw new NotebookError('recovery_required');
      if (prior.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
      const turn = readProduct(db.sqlite, owner, 'turn', prior.response.id);
      if (!turn || prior.response.kind !== 'turn') throw new NotebookError('recovery_required');
      return {
        threadId: turn.record.threadId as string,
        turnId: prior.response.id,
        busy: false,
        replayed: true,
      };
    }
  }
  const workspace =
    owner.kind === 'workspace'
      ? readProduct(db.sqlite, owner, 'workspace', owner.workspaceId)
      : undefined;
  if (
    (owner.kind === 'workspace' && workspace?.record.status !== 'active') ||
    (input.ownerScope.kind === 'user' &&
      input.purpose === 'maintenance' &&
      workspace?.record.kind !== 'personal')
  )
    throw new NotebookError('invalid_request');
  // Decode every candidate through the retained owner. Unknown core semantics must not disappear from selection.
  const threads =
    input.purpose === 'query'
      ? []
      : (
          db.sqlite.prepare('SELECT id FROM control_threads ORDER BY id').all() as { id: string }[]
        ).map(({ id }) => readProduct(db.sqlite, owner, 'thread', id)!);
  const turns =
    input.purpose === 'query'
      ? []
      : (
          db.sqlite.prepare('SELECT id FROM control_turns ORDER BY id').all() as { id: string }[]
        ).map(({ id }) => readProduct(db.sqlite, owner, 'turn', id)!);
  const summary =
    input.purpose === 'query'
      ? 'Knowledge question.'
      : input.ownerScope.kind === 'user'
        ? 'User Memory maintenance.'
        : input.trigger === 'schedule'
          ? 'Knowledge Manager scheduled maintenance.'
          : 'Knowledge maintenance.';
  const priorRuns =
    input.purpose === 'query'
      ? []
      : turns.filter(({ record }) => {
          const knowledge = (record.internalExecution as Turn['internalExecution'])?.knowledge;
          if (knowledge?.purpose === 'maintenance') {
            const scope = knowledge.ownerScope;
            return (
              scope.kind === input.ownerScope.kind &&
              (scope.kind === 'workspace'
                ? input.ownerScope.kind === 'workspace' &&
                  scope.workspaceId === input.ownerScope.workspaceId
                : scope.kind === 'user'
                  ? input.ownerScope.kind === 'user' && scope.userId === input.ownerScope.userId
                  : true)
            );
          }
          const trigger = record.triggerSource as Turn['triggerSource'];
          return (
            record.agentId === 'knowledge-manager' &&
            (input.ownerScope.kind === 'user'
              ? trigger?.summary === 'User Memory maintenance.'
              : trigger?.summary === 'Knowledge maintenance.' ||
                trigger?.summary === 'Knowledge Manager scheduled maintenance.')
          );
        });
  const ids = new Set(priorRuns.map(({ record }) => record.threadId as string));
  if (input.ownerScope.kind === 'server' && input.purpose === 'maintenance')
    for (const thread of threads)
      if (thread.record.entryPath === 'knowledge-manager') ids.add(thread.record.id as string);
  if (ids.size > 1) throw new NotebookError('recovery_required');
  const existingId = [...ids][0];
  const existing = existingId ? threads.find(({ record }) => record.id === existingId) : undefined;
  if (existingId && !existing) throw new NotebookError('recovery_required');
  let visibility: 'private' | 'workspace' | 'server' =
    owner.kind === 'server' ? 'server' : 'workspace';
  if (input.ownerScope.kind === 'user' || input.purpose === 'query') visibility = 'private';
  if (input.outputThreadId) {
    const parent = readProduct(db.sqlite, owner, 'thread', input.outputThreadId);
    if (
      !parent ||
      (parent.record.visibility === 'private' && parent.record.privateOwnerUserId !== userId)
    )
      throw new NotebookError('invalid_request');
    if (input.ownerScope.kind !== 'user' && parent.record.visibility === 'workspace')
      visibility = 'workspace';
  }
  if (
    existing &&
    (existing.record.status !== 'active' ||
      existing.record.entryPath !== 'knowledge-manager' ||
      existing.record.visibility !== visibility ||
      (visibility === 'private' && existing.record.privateOwnerUserId !== userId))
  )
    throw new NotebookError('recovery_required');
  if (input.trigger === 'schedule') {
    const scheduled = priorRuns.find(({ record }) => {
      const trigger = record.triggerSource as Turn['triggerSource'];
      return (
        trigger?.kind === 'automation' &&
        typeof record.startedAt === 'string' &&
        record.startedAt.slice(0, 10) === input.startedAt.slice(0, 10)
      );
    });
    if (scheduled)
      return {
        threadId: scheduled.record.threadId as string,
        turnId: scheduled.record.id as string,
        busy: false,
        replayed: true,
      };
  }
  const threadId = existingId ?? input.threadId;
  const busy =
    input.purpose === 'maintenance' &&
    turns.some(
      ({ record }) =>
        record.threadId === threadId && (record.status === 'running' || record.status === 'pending')
    );
  const title =
    input.purpose === 'query'
      ? 'Knowledge question'
      : input.ownerScope.kind === 'user'
        ? 'Memory maintenance'
        : owner.kind === 'server'
          ? 'Server Knowledge maintenance'
          : 'Knowledge maintenance';
  const products: ControlProductMutation[] = [];
  if (workspace)
    products.push({
      kind: 'workspace',
      expectedRevision: workspace.revision,
      record: { ...workspace.record, updatedAt: input.startedAt },
    });
  products.push({
    kind: 'thread',
    expectedRevision: existing?.revision ?? 0,
    record: {
      ...(existing?.record ?? {
        schemaVersion: 1,
        id: threadId,
        owner,
        name: title,
        status: 'active',
        entryPath: 'knowledge-manager',
        threadSource: 'conversation',
        visibility,
        ...(visibility === 'private' ? { privateOwnerUserId: userId } : {}),
        createdAt: input.startedAt,
      }),
      schemaVersion: 1,
      preview: input.instructions.slice(0, 160),
      updatedAt: input.startedAt,
    },
  });
  products.push({
    kind: 'turn',
    expectedRevision: 0,
    record: {
      schemaVersion: 1,
      id: input.turnId,
      owner,
      threadId,
      triggerActor: input.actor,
      status: 'running',
      error: null,
      configVersion: null,
      startedAt: input.startedAt,
      completedAt: null,
      durationMs: null,
      agentId: 'knowledge-manager',
      triggerSource: {
        kind: input.trigger === 'schedule' ? 'automation' : 'system-input',
        summary,
      },
      captureCoverage: input.captureCoverage,
    },
  });
  if (busy) {
    // A skipped service Turn owns no execution or external effects. It must be born terminal so the existing single-flight index keeps the active run excluded.
    const skipped = products.pop()!;
    const record = {
      ...skipped.record,
      status: 'completed',
      completedAt: input.startedAt,
      durationMs: 0,
    };
    decodeControlProduct('turn', record, owner);
    applyControlProducts(db.sqlite, owner, products, []);
    db.sqlite
      .prepare(
        'INSERT INTO control_turns (id,schema_version,revision,record_json,thread_id,agent_session_id,status) VALUES (?,1,1,?,?,NULL,?)'
      )
      .run(input.turnId, JSON.stringify(record), threadId, 'completed');
  } else {
    applyControlProducts(db.sqlite, owner, products, []);
  }
  if (receipt) {
    const response = normalizeCommandRequestResponse(receipt.command, {
      kind: 'turn',
      id: input.turnId,
    });
    recordControlCommandRequestRecordInDb(db, { ...receipt, response });
  }
  return { threadId, turnId: input.turnId, busy, replayed: false };
}

/** Opens the exact physical product owner and awaits its complete native admission; no binding is upgraded. */
export async function admitControlMaintenance(
  dataRoot: string,
  workspaceId: string | undefined,
  input: ControlMaintenanceAdmissionInput
): Promise<ControlMaintenanceAdmissionResult> {
  const scope = nativeProductScope(
    dataRoot,
    workspaceId === undefined ? { kind: 'server' } : { kind: 'workspace', workspaceId }
  );
  await ensureCanonicalDirectoryAsync(scope.contentMount.root);
  const path = scope.path;
  const database = workspaceId === undefined ? `core:${path}` : `workspace:${path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path,
    dataRoot,
    create: false,
    initialize: workspaceId === undefined ? 'core' : 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return client.maintenance(database, input);
}

/** Trusted request admission supplies identity and the native authority closure, never model arguments. */
export interface KnowledgeMaintenanceInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly requestActor?: Actor;
  readonly actor: ActorRef;
  readonly startedAt?: string;
  readonly trigger: 'request' | 'schedule';
  readonly instructions: string;
  readonly sources: readonly string[];
  readonly pageIds?: readonly string[];
  readonly tellContent?: string;
  readonly askingThreadId?: string;
  readonly askingTurnId?: string;
  readonly signal: AbortSignal;
  /** Original command facts, supplied only by the existing command owner before native admission. */
  readonly receipt?: IdempotentCommandReceipt;
  /** Required for native Worker/scheduler calls without a public request actor. */
  readonly currentAdmission?:
    | ((request: NotebookUpdate) => NotebookPublicationAdmission)
    | undefined;
}

/** Existing owners and one role runner; this adapter adds no model, scheduling or record owner. */
export interface KnowledgeMaintenanceDependencies {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  readonly openWorkspace: (workspaceId: string) => WorkspaceDb;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly pin: (input: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>) => void;
  readonly run: (
    input: KnowledgeManagerAgentRun
  ) => Promise<{ readonly turnId: string; readonly text: string }>;
}

/** Projects a complete UTF-8 prefix with its own delivered digest, distinct from canonical Source identity. */
function excerpt(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const content = bytes.subarray(0, end).toString('utf8');
  return {
    content,
    truncated: end < bytes.length,
    deliveredDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

/** Awaits one complete native Workspace admission; only actual Tool outcomes can report publication. */
export async function prepareKnowledgeMaintenance(
  dependencies: KnowledgeMaintenanceDependencies,
  input: KnowledgeMaintenanceInput
) {
  const { store } = dependencies;
  const userId = responsibleUserIdForActor(input.actor);
  if (!userId || (!input.requestActor && !input.currentAdmission))
    throw new NotebookError('invalid_request');
  const actor = { kind: 'user', id: userId } as const;
  admitKnowledgeRetrieval({
    workspaceId: input.workspaceId,
    access: {
      store,
      coreDb: dependencies.coreDb,
      actor: input.actor,
      requestActor: input.requestActor,
    },
  });
  if (
    input.requestActor &&
    !isWorkspaceOperationAuthorized(dependencies.coreDb, input.requestActor, input.workspaceId, {
      mutating: true,
      policyOperation: 'knowledge.write',
    })
  )
    throw new NotebookError('invalid_request');
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(
      dependencies.coreDb.dataRoot,
      'workspaces',
      input.workspaceId,
      'knowledge',
      'notebook.git'
    ),
  });
  let baseRevision = notebook.publishedRevision();
  input.currentAdmission?.({
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    baseRevision,
    changes: [],
    summary: input.instructions,
  });
  input.signal.throwIfAborted();
  const admitted = await admitControlMaintenance(dependencies.coreDb.dataRoot, input.workspaceId, {
    purpose: 'maintenance',
    ownerScope: { kind: 'workspace', workspaceId: input.workspaceId },
    actor: input.actor,
    requestId: input.requestId,
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
    startedAt: input.startedAt ?? new Date().toISOString(),
    trigger: input.trigger,
    instructions: input.instructions,
    captureCoverage: store.getLiveCaptureCoverage(),
    ...(input.receipt ? { receipt: MaintenanceReceiptSchema.parse(input.receipt) } : {}),
  });
  if (admitted.replayed) throw new NotebookError('recovery_required');
  const thread = store.getThread(input.workspaceId, admitted.threadId);
  const turn = store.getTurnById(admitted.turnId);
  const all = store
    .listThreads(input.workspaceId)
    .flatMap((thread) => store.listThreadTurns(input.workspaceId, thread.id))
    .filter((prior) => prior.id !== turn.id);
  const maintenance = all.filter((turn) => {
    const knowledge = turn.internalExecution?.knowledge;
    return (
      (knowledge?.purpose === 'maintenance' &&
        knowledge.ownerScope.kind === 'workspace' &&
        knowledge.ownerScope.workspaceId === input.workspaceId) ||
      (turn.agentId === 'knowledge-manager' &&
        ((turn.triggerSource?.kind === 'automation' &&
          turn.triggerSource.summary === 'Knowledge Manager scheduled maintenance.') ||
          (turn.triggerSource?.kind === 'system-input' &&
            turn.triggerSource.summary === 'Knowledge maintenance.')))
    );
  });
  const access = {
    store,
    coreDb: dependencies.coreDb,
    actor: input.actor,
    requestActor: input.requestActor,
    outputThreadId: thread.id,
  };
  const target = {
    dataRoot: dependencies.coreDb.dataRoot,
    workspaceId: input.workspaceId,
    access,
    notebookRevision: baseRevision,
  };
  admitKnowledgeRetrieval(target);
  const workspaceDb = dependencies.openWorkspace(input.workspaceId);
  const status = async (summary: string, failed = false, result?: ReturnType<typeof response>) => {
    const timestamp = new Date().toISOString();
    await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId: input.workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type: 'status',
      ...(result ? { knowledgeMaintenanceResult: result } : {}),
      level: failed ? 'error' : 'info',
      title: 'Knowledge maintenance',
      summary,
      status: failed ? 'failed' : 'completed',
      createdAt: timestamp,
      completedAt: timestamp,
    });
  };
  const response = (
    outcome: 'published' | 'review-required' | 'no-change' | 'skipped' | 'failed',
    summary: string,
    extra: { notebookRevision?: string; candidateRevision?: string; proposalId?: string } = {}
  ) =>
    KnowledgeMaintenanceResponseSchema.parse({
      threadId: thread.id,
      turnId: turn.id,
      outcome,
      notebookRevision: baseRevision,
      summary,
      ...extra,
    });
  const admission = (request: NotebookUpdate) =>
    input.currentAdmission
      ? input.currentAdmission(request)
      : readWorkspaceNotebookAdmission({
          ...dependencies,
          workspaceDb,
          requestActor: input.requestActor!,
          actor,
          notebook,
          request,
        });
  const empty = {
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    baseRevision,
    changes: [],
    summary: input.instructions,
  };
  let outcome: ReturnType<typeof response> | undefined;
  let outcomeStatusRecorded = false;
  const recordOutcome = async () => {
    if (outcome && !outcomeStatusRecorded) {
      await status(outcome.summary, false, outcome);
      outcomeStatusRecorded = true;
    }
  };
  let closed = false;
  const close = () => {
    if (!closed) {
      workspaceDb.sqlite.close();
      closed = true;
    }
  };
  const fail = async () => {
    try {
      const current = store.getTurnById(turn.id);
      const result =
        outcome ??
        response(
          'failed',
          current.error?.message ?? 'Knowledge maintenance failed. Inspect its retained Turn.'
        );
      if (!isSealedTurnTerminal(current.status)) {
        if (!outcomeStatusRecorded) await status(result.summary, true, result);
        await store.updateTurn(turn.id, {
          status: input.signal.aborted ? 'cancelled' : 'failed',
          completedAt: new Date().toISOString(),
          error: { code: 'knowledge_maintenance_failed', message: result.summary },
        });
      }
      return result;
    } finally {
      close();
    }
  };
  const settled = (result: ReturnType<typeof response>) => {
    close();
    return { turnId: turn.id, execute: async () => result, fail };
  };
  try {
    admission(empty);
    if (admitted.busy) {
      const skipped = response('skipped', 'Another notebook maintenance Turn is still active.');
      await status(skipped.summary, false, skipped);
      return settled(skipped);
    }
  } catch {
    return settled(await fail());
  }
  let started = false;
  return {
    turnId: turn.id,
    fail,
    execute: async () => {
      if (started || closed) throw new NotebookError('invalid_request');
      started = true;
      try {
        const files: Record<string, string> = {};
        const sourceFiles: Record<string, string> = {};
        const admittedReferences = new Set<string>();
        let bytes = 0;
        const admitBytes = (text: string) => {
          bytes += Buffer.byteLength(text);
          if (
            Buffer.byteLength(text) > NOTEBOOK_EDITING_LIMITS.fileBytes ||
            bytes > NOTEBOOK_EDITING_LIMITS.workspaceBytes
          )
            throw new NotebookError('invalid_request');
        };
        const sources = new Map<string, KnowledgeSourceRecord>();
        const sourceOwner = {
          dataRoot: dependencies.coreDb.dataRoot,
          ownerScope: { kind: 'workspace' as const, workspaceId: input.workspaceId },
        };
        const readSource = async (source: KnowledgeSourceRecord) => {
          if (!knowledgeSourceAudienceReadable(target, source.id))
            throw new NotebookError('invalid_request');
          const pointer = readSourcePointers(sourceOwner).get(source.id);
          if (!pointer || pointer.source.contentDigest !== source.contentDigest)
            throw new NotebookError('recovery_required');
          const delivered = await readManagedSourceText({ owner: sourceOwner, pointer, access });
          if (
            delivered.status !== 'ok' ||
            !knowledgeSourceAudienceReadable(target, source.id) ||
            store.getKnowledgeSource(input.workspaceId, source.id).contentDigest !==
              source.contentDigest
          )
            throw new NotebookError('recovery_required');
          return delivered.value;
        };
        const capture = async (
          content: string,
          threadId: string,
          turnId: string,
          title: string
        ) => {
          if (Buffer.byteLength(content) > NOTEBOOK_EDITING_LIMITS.fileBytes)
            throw new NotebookError('invalid_request');
          const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
          let source = store
            .listKnowledgeSources(input.workspaceId)
            .find(
              (entry) =>
                entry.originatingTurnId === turnId &&
                entry.originatingThreadId === threadId &&
                entry.contentDigest === digest
            );
          if (!source) {
            if (input.actor.kind !== 'user' && input.actor.kind !== 'agent')
              throw new NotebookError('invalid_request');
            const now = new Date().toISOString();
            const metadata = {
              id: allocateEntityId('ks'),
              kind: 'document' as const,
              title,
              uri: null,
              contentDigest: digest,
              originatingThreadId: threadId,
              originatingTurnId: turnId,
              originatingFileId: null,
              capturedAt: now,
              createdAt: now,
              updatedAt: now,
            };
            const captured = await publishCapturedSource(
              {
                owner: sourceOwner,
                database: { kind: 'workspace', workspaceDb },
                access,
                producer:
                  input.actor.kind === 'user' ? input.actor : { ...input.actor, kind: 'agent' },
                requestId: randomUUID(),
                commandInput: { maintenanceRequestId: input.requestId, source: metadata },
                captureChannel: 'knowledge.source.register',
                revalidatePublication: () =>
                  admission({ ...empty, baseRevision: notebook.publishedRevision() }),
              },
              metadata,
              Buffer.from(content)
            );
            source = { ...captured.source, workspaceId: input.workspaceId };
          }
          sources.set(source.id, source);
          return source;
        };
        const processed = new Set(
          maintenance
            .filter((prior) => prior.status === 'completed')
            .flatMap(
              (prior) =>
                prior.internalExecution?.knowledge?.sourceRange.map((range) => range.turnId) ?? []
            )
        );
        const ranges: NonNullable<
          NonNullable<Turn['internalExecution']>['knowledge']
        >['sourceRange'] = [];
        const eligible = all
          .filter(
            (prior) =>
              prior.status === 'completed' &&
              prior.internalExecution?.roleId !== 'knowledge-manager' &&
              prior.agentId !== 'knowledge-manager' &&
              !processed.has(prior.id) &&
              store.getThread(input.workspaceId, prior.threadId).entryPath !==
                'knowledge-manager' &&
              threadReadable(target, prior.threadId)
          )
          .sort((left, right) => (left.completedAt ?? '').localeCompare(right.completedAt ?? ''));
        for (const prior of eligible.slice(-8)) {
          // Human expressions are evidence; unreviewed generated replies are never recast as factual Sources.
          const items = prior.items.filter(
            (item) =>
              item.type === 'user-message' &&
              item.actor.kind === 'user' &&
              item.status === 'completed'
          );
          if (!items.length) continue;
          await capture(
            JSON.stringify(items),
            prior.threadId,
            prior.id,
            'Selected conversation expressions'
          );
          ranges.push({
            threadId: prior.threadId,
            turnId: prior.id,
            firstItemId: items[0]!.id,
            lastItemId: items.at(-1)!.id,
          });
        }
        const suppliedSource = input.tellContent
          ? await capture(
              input.tellContent,
              input.askingThreadId ?? thread.id,
              input.askingTurnId ?? turn.id,
              'Supplied knowledge information'
            )
          : undefined;
        const instructions = suppliedSource
          ? `${input.instructions} This knowledge.tell request supplies information in source:${suppliedSource.id}@${suppliedSource.contentDigest}. Integrate that Source, preserving evidence, conflicts and unknowns. The overview and prior human notebook edits are separate context; equality between them does not mean the supplied information is already integrated. If the information is already represented, a native no-change outcome is valid. Otherwise edit the admitted notebook snapshot, keep its overview current, then submit those edits under the existing publication and Review rules. Source capture alone is not notebook page integration.`
          : input.instructions;
        // Native Source capture adds a Git commit. Pin the editor and model only after capture.
        baseRevision = notebook.publishedRevision();
        target.notebookRevision = baseRevision;
        empty.baseRevision = baseRevision;
        const authoringGuidance = notebookAuthoringGuidance(admission(empty).scopeSchemaText, {
          kind: 'workspace',
          workspaceId: input.workspaceId,
        });
        const selectedPages = input.pageIds ? new Set([...input.pageIds, 'index']) : undefined;
        for (const path of Object.keys(notebook.inspectRevision(baseRevision).entries).sort()) {
          const id = path.slice(0, -3);
          if (selectedPages && !selectedPages.has(id)) continue;
          const content = notebook.readRevision(baseRevision, [path]).files[path]!;
          const parsed = parseOkfDocument({ path, content });
          if (!parsed.ok) throw new NotebookError('recovery_required');
          if (
            !selectedPages &&
            path !== 'index.md' &&
            (parsed.document.reserved || parsed.document.frontmatter.openkit_status !== 'active')
          )
            continue;
          const page = readAuthorizedWorkspaceNotebookPages({
            ...target,
            pageIds: [path.slice(0, -3)],
          }).pages[0];
          if (!page) throw new NotebookError('invalid_request');
          admitBytes(content);
          files[path] = content;
          for (const ref of stringListFrontmatterField(parsed.document, 'source_refs') ?? [])
            admittedReferences.add(ref);
        }
        // Omitted base files stay immutable; an explicit selection may include non-active pages.
        for (const id of input.pageIds ?? []) {
          if (!Object.hasOwn(files, `${id}.md`)) throw new NotebookError('invalid_request');
        }
        const registered = new Map(
          store
            .listKnowledgeSources(input.workspaceId)
            .map((source) => [source.id, source.contentDigest])
        );
        const editableSources = new Set(suppliedSource ? [suppliedSource.id] : []);
        for (const supplied of input.sources) {
          const resolution = resolveRegisteredKnowledgeSourceReference(
            supplied.startsWith('source:') ? supplied : `source:${supplied}`,
            registered
          );
          if (!resolution.resolved || !resolution.targetId)
            throw new NotebookError('invalid_request');
          editableSources.add(resolution.targetId);
          sources.set(
            resolution.targetId,
            store.getKnowledgeSource(input.workspaceId, resolution.targetId)
          );
        }
        for (const source of sources.values()) {
          const text = await readSource(source);
          admitBytes(text);
          sourceFiles[source.id] = text;
          admittedReferences.add(`source:${source.id}@${source.contentDigest}`);
        }
        for (const id of editableSources) {
          const path = `@sources/${id}.md`;
          const content = notebook.readContent(baseRevision, [path])[path]!;
          admitBytes(content);
          files[path] = content;
          const parsed = parseOkfDocument({ path, content });
          if (!parsed.ok) throw new NotebookError('recovery_required');
          for (const ref of stringListFrontmatterField(parsed.document, 'source_refs') ?? [])
            admittedReferences.add(ref);
        }
        const historyReads: Array<{ notebookRevision: string; path: string; content: string }> = [];
        const assertCurrent = () => {
          input.signal.throwIfAborted();
          admitKnowledgeRetrieval(target);
          admission(empty);
          for (const source of sources.values())
            if (
              !knowledgeSourceAudienceReadable(target, source.id) ||
              store.getKnowledgeSource(input.workspaceId, source.id).contentDigest !==
                source.contentDigest
            )
              throw new NotebookError('recovery_required');
          for (const path of Object.keys(files).filter((path) => !path.startsWith('@sources/')))
            readAuthorizedWorkspaceNotebookPages({ ...target, pageIds: [path.slice(0, -3)] });
          for (const selection of historyReads) {
            const page = readAuthorizedWorkspaceNotebookPages({
              ...target,
              notebookRevision: selection.notebookRevision,
              pageIds: [selection.path.slice(0, -3)],
            }).pages[0];
            if (page?.content !== selection.content) throw new NotebookError('recovery_required');
          }
        };
        const settings = () =>
          findWorkspaceConfig(dependencies.runtimeConfigManager.current(), input.workspaceId)
            ?.config.workspace.knowledgeMaintenance ?? {
            enabled: false,
            reviewRequiredPageIds: [],
          };
        const controller = new AbortController();
        const editor = createNotebookAgentEditing({
          notebook,
          baseRevision,
          requestId: input.requestId,
          files,
          sources: sourceFiles,
          signal: AbortSignal.any([input.signal, controller.signal]),
          /** The editor exists before pinning; Tool access reads the actual admitted budget. */
          get deadlineMs() {
            const pinned = store.getTurnById(turn.id);
            const limit = pinned.internalExecution?.limits?.deadlineMs;
            if (limit === undefined || pinned.startedAt === null)
              throw new NotebookError('invalid_request');
            return Date.parse(pinned.startedAt) + limit;
          },
          revalidate: assertCurrent,
          submit: async (edit) => {
            if (edit.changes.length > NOTEBOOK_EDITING_LIMITS.changedFiles)
              throw new NotebookError('invalid_request', undefined, [
                'notebook.maintenance_change_limit',
              ]);
            const request = { ...edit, workspaceId: input.workspaceId };
            const refs = [
              ...new Set(
                edit.changes.flatMap(({ path, content }) => {
                  if (content === null) return [];
                  const parsed = parseOkfDocument({ path, content });
                  if (!parsed.ok) throw new NotebookError('invalid_request');
                  const refs = stringListFrontmatterField(parsed.document, 'source_refs') ?? [];
                  if (path.startsWith('@sources/')) {
                    const id = path.slice('@sources/'.length, -3);
                    const source = sources.get(id);
                    if (!editableSources.has(id) || !source)
                      throw new NotebookError('invalid_request');
                    refs.push(`source:${id}@${source.contentDigest}`);
                  }
                  return refs;
                })
              ),
            ].sort();
            if (refs.some((ref) => !admittedReferences.has(ref)))
              throw new NotebookError('invalid_request');
            const release = dependencies.workspaceMutationAdmission.enter(input.workspaceId);
            if (!release) throw new NotebookError('invalid_request');
            try {
              const facts = admission(request);
              // Explain structural refusals before either native publisher or Proposal creation.
              // Both still perform their own current-authority and exact-candidate verification.
              const baseFiles = notebook.readContent(baseRevision);
              const candidateFiles = { ...baseFiles };
              for (const { path, content } of edit.changes) {
                if (content === null) delete candidateFiles[path];
                else
                  candidateFiles[path] = attributedNotebookPageBytes(
                    path,
                    content,
                    { kind: 'workspace', workspaceId: input.workspaceId },
                    'delegated'
                  );
              }
              const validation = validateNotebookCandidate({
                ownerScope: { kind: 'workspace', workspaceId: input.workspaceId },
                base: { files: baseFiles },
                candidate: { files: candidateFiles },
                ...facts,
              });
              if (validation.errors.length)
                throw new NotebookError(
                  'invalid_request',
                  undefined,
                  validation.errors.map(({ code }) => code),
                  validation.errors.flatMap(({ code, pageId, target }) =>
                    code === 'notebook.unresolved_page_link' &&
                    target !== undefined &&
                    edit.changes.some(({ path }) => path === `${pageId}.md`)
                      ? [{ code, pageId, target }]
                      : []
                  )
                );
              const setting = settings();
              if (
                setting.enabled &&
                !edit.changes.some(
                  ({ path, content }) =>
                    facts.reviewRequiredPageIds.includes(path.slice(0, -3)) ||
                    (content === null &&
                      Object.hasOwn(notebook.inspectRevision(baseRevision).entries, path))
                )
              ) {
                try {
                  const published = await publishWorkspaceNotebook(
                    {
                      store,
                      workspaceDb,
                      notebook,
                      actor,
                      producer: {
                        kind: 'agent',
                        id: 'knowledge-manager',
                        responsibleUserId: userId,
                      },
                      inflightCommands: dependencies.inflightCommands,
                      publicationAuthority: {
                        kind: 'delegated',
                        settingReference: `workspace:${input.workspaceId}:knowledgeMaintenance:${JSON.stringify(setting)}`,
                        settingDigest: commandInputHash(setting),
                      },
                      revalidate: () => {
                        assertCurrent();
                        if (commandInputHash(settings()) !== commandInputHash(setting))
                          throw new NotebookError('review_required');
                        return admission(request);
                      },
                    },
                    request
                  );
                  outcome = response('published', edit.summary, {
                    notebookRevision: published.notebookRevision,
                  });
                  return published;
                } catch (error) {
                  if (!(error instanceof NotebookError) || error.code !== 'review_required')
                    throw error;
                }
              }
              const external = verifyKnowledgeProposalWorkHistory({
                coreDb: dependencies.coreDb,
                workspaceDb,
                store,
                workspaceId: input.workspaceId,
                sourceReferences: refs,
              }).verifiedExternalReferences;
              const proposal = await store.createKnowledgeProposal({
                ...edit,
                workspaceId: input.workspaceId,
                sourceReferences: refs,
                verifiedExternalReferences: external,
                producer: { kind: 'agent', id: 'knowledge-manager', responsibleUserId: userId },
                createdAt: new Date().toISOString(),
              });
              outcome = response('review-required', edit.summary, {
                candidateRevision: proposal.candidateRevision,
                proposalId: proposal.id,
              });
              return {
                outcome: 'review_required',
                proposalId: proposal.id,
                baseRevision,
                candidateRevision: proposal.candidateRevision,
              };
            } finally {
              release();
            }
          },
        });
        const tool = (
          name: string,
          key: string,
          description: string,
          execute: (value: Record<string, string>) => Promise<unknown>
        ): AgentTool => ({
          name,
          description: `${description} Use only the admitted notebook snapshot and Sources. Notebook limits: 32 MiB total, 2 MiB per file, ${NOTEBOOK_EDITING_LIMITS.changedFiles} changed files, 64 KiB script/output. Publication needs current authority.`,
          inputSchema: {
            type: 'object',
            properties: { [key]: { type: 'string' } },
            required: [key],
            additionalProperties: false,
          },
          execute: async (value, context) => {
            const abort = () => controller.abort();
            if (context.signal.aborted) abort();
            context.signal.addEventListener('abort', abort, { once: true });
            try {
              if (
                typeof value !== 'object' ||
                value === null ||
                Array.isArray(value) ||
                Object.keys(value).length !== 1 ||
                typeof (value as Record<string, unknown>)[key] !== 'string'
              )
                throw new NotebookError('invalid_request');
              const result = await execute(value as Record<string, string>);
              return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            } catch (error) {
              if (context.signal.aborted || input.signal.aborted) throw error;
              const errorCode =
                error instanceof NotebookError ? error.code : 'notebook_tool_failed';
              const diagnostics =
                error instanceof NotebookError
                  ? [...new Set(error.diagnostics ?? [])].slice(0, 8)
                  : [];
              if (
                name === 'knowledge.notebook-workspace.update' &&
                errorCode === 'invalid_request' &&
                !diagnostics.length
              )
                diagnostics.push('notebook.script_failed');
              else if (
                name === 'knowledge.notebook.update' &&
                errorCode === 'invalid_request' &&
                !diagnostics.length
              )
                diagnostics.push('notebook.submission_refused');
              // Class labels are native constants; exception text and constructor names are untrusted.
              const exceptionClass =
                error instanceof NotebookError
                  ? 'NotebookError'
                  : error instanceof TypeError
                    ? 'TypeError'
                    : error instanceof RangeError
                      ? 'RangeError'
                      : error instanceof SyntaxError
                        ? 'SyntaxError'
                        : 'Error';
              try {
                console.warn(
                  JSON.stringify({
                    code: 'knowledge_notebook_tool_failed',
                    message: 'Workspace Knowledge notebook Tool failed.',
                    operation: name,
                    exceptionClass,
                    errorCode,
                    workspaceId: input.workspaceId,
                    threadId: thread.id,
                    turnId: turn.id,
                  })
                );
              } catch {
                // Optional process diagnostics cannot replace the native failure feedback.
              }
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      code: errorCode,
                      ...(diagnostics.length ? { diagnostics } : {}),
                      ...(error instanceof NotebookError && error.linkDiagnostics?.length
                        ? { linkDiagnostics: error.linkDiagnostics }
                        : {}),
                      message: diagnostics.includes('notebook.maintenance_change_limit')
                        ? `Maintenance permits at most ${NOTEBOOK_EDITING_LIMITS.changedFiles} changed files, including index.md. Reduce the temporary edits before resubmitting; call knowledge.result only after a successful notebook submission.`
                        : diagnostics.includes('scope_schema.invalid_confidence')
                          ? 'Claim requires confidence: a finite number from zero through one. Correct the temporary Claim frontmatter before resubmitting; call knowledge.result only after a successful notebook submission.'
                          : diagnostics.includes('notebook.unresolved_page_link')
                            ? 'Repair the reported local links in the temporary notebook, then resubmit. Page links resolve relative to the containing page against the complete resulting tree, not relative to the editor filesystem root. Call knowledge.result only after a successful notebook submission.'
                            : diagnostics.includes('notebook.script_path_refused')
                              ? 'Writable Page files use bundle-relative lowercase .md paths under the Notebook root. Original Sources and omitted base members are read-only. There are no script, scratch or non-Markdown files. mkdir, remove, copy and move use the same path rule. Correct the path, then submit the accepted pages with knowledge.notebook.update once the synthesis is ready.'
                              : errorCode === 'notebook_tool_failed'
                                ? 'Notebook Tool failed unexpectedly. Publication is not confirmed; inspect the notebook before starting a new request.'
                                : 'Notebook Tool refused the request. Check the admitted notebook constraints and native diagnostic codes; publication is not confirmed.',
                    }),
                  },
                ],
              };
            } finally {
              context.signal.removeEventListener('abort', abort);
            }
          },
        });
        const nativeAuthority = {
          actorRef: input.actor,
          assertCurrent,
          requestActor: input.requestActor,
        };
        const history = createAssistantHistory({
          store,
          coreDb: dependencies.coreDb,
          workspaceId: input.workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          nativeAuthority,
        });
        const tools: AgentTool[] = [
          history.tool,
          tool(
            'knowledge.notebook-workspace.update',
            'script',
            'Run an edit script against the admitted virtual Knowledge snapshot. This edits pages and selected Source summaries; submit the prior edits with knowledge.notebook.update.',
            (value) => editor.workspaceUpdate({ script: value.script! })
          ),
          tool(
            'knowledge.notebook.update',
            'summary',
            'Submit prior knowledge.notebook-workspace.update edits for Knowledge publication or required Review. The summary describes the edits and is not page content. Literal Source capture is not Knowledge page integration. A native no_change outcome means the editor has no page changes.',
            async (value) => {
              const result = await editor.notebookUpdate({ summary: value.summary! });
              if (result.outcome === 'no_change') outcome = response('no-change', value.summary!);
              await recordOutcome();
              return result;
            }
          ),
        ];
        const previous = maintenance.filter((prior) => prior.status === 'completed').at(-1)
          ?.internalExecution?.knowledge?.baseRevision;
        const humanChanges: Array<{ path: string; before: string | null; after: string | null }> =
          [];
        let cursor: string | null = baseRevision;
        let scanned = 0;
        while (cursor && cursor !== previous && scanned++ < 256) {
          const revision = notebook.inspectRevision(cursor);
          const parent = revision.parentRevision
            ? notebook.inspectRevision(revision.parentRevision)
            : undefined;
          if (revision.metadata.producer.kind === 'user')
            for (const path of new Set([
              ...Object.keys(revision.entries),
              ...Object.keys(parent?.entries ?? {}),
            ])) {
              if (selectedPages && !selectedPages.has(path.slice(0, -3))) continue;
              if (revision.entries[path] === parent?.entries[path]) continue;
              const read = (notebookRevision: string | undefined, exists: boolean) => {
                if (!notebookRevision || !exists) return null;
                const content = readAuthorizedWorkspaceNotebookPages({
                  ...target,
                  notebookRevision,
                  pageIds: [path.slice(0, -3)],
                }).pages[0]!.content;
                admitBytes(content);
                historyReads.push({ notebookRevision, path, content });
                return content;
              };
              const before = read(parent?.revision, Boolean(parent?.entries[path]));
              const after = read(revision.revision, Boolean(revision.entries[path]));
              // Creation records its human caller even when navigation is the unchanged native seed.
              if (
                !parent &&
                Object.keys(revision.entries).length === 1 &&
                path === 'index.md' &&
                after === DEFAULT_NOTEBOOK_INDEX
              )
                continue;
              humanChanges.push({ path, before, after });
              if (humanChanges.length > 256) throw new NotebookError('invalid_request');
            }
          cursor = revision.parentRevision;
        }
        if (cursor && cursor !== previous) throw new NotebookError('invalid_request');
        const humanEdits = boundedNotebookDiff(humanChanges, false);
        let remaining = 64 * 1024;
        const selectedSources = [...sources.values()].map((source) => {
          const delivered = excerpt(sourceFiles[source.id]!, remaining);
          remaining -= Buffer.byteLength(delivered.content);
          return {
            reference: `source:${source.id}@${source.contentDigest}`,
            file: `/sources/${source.id}`,
            ...delivered,
          };
        });
        const runInput: KnowledgeManagerAgentRun = {
          turn,
          workspaceDb,
          signal: input.signal,
          inputs: {
            purpose: 'maintenance',
            ownerScope: { kind: 'workspace', workspaceId: input.workspaceId },
            baseRevision,
            trigger: input.trigger,
            instructions,
            sourceRange: ranges,
            ...(input.askingThreadId ? { askingThreadId: input.askingThreadId } : {}),
            ...(input.askingTurnId ? { askingTurnId: input.askingTurnId } : {}),
          },
          tools,
          assertCurrent,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    instructions,
                    notebookRevision: baseRevision,
                    authoringGuidance,
                    files: Object.keys(files),
                    selectedPageIds: input.pageIds ?? [],
                    humanEdits,
                    overview: excerpt(files['index.md'] ?? '', 16 * 1024),
                    sources: selectedSources,
                    sourceHistory:
                      'Supplied Source content is the authorized retained human input. Source material digests and Turn IDs are not history Item range coordinates. thread.history.read accepts only exact current-run compaction ranges.',
                    omittedEligibleTurns: Math.max(0, eligible.length - 8),
                  }),
                },
              ],
            },
          ],
          readEvidence: (items) =>
            readInternalContextEvidence({
              store,
              coreDb: dependencies.coreDb,
              workspaceId: input.workspaceId,
              threadId: thread.id,
              nativeAuthority,
              items,
              strategy: 'compaction',
            }),
          resultSchema: {
            type: 'object',
            properties: { summary: { type: 'string', minLength: 1 } },
            required: ['summary'],
            additionalProperties: false,
          },
          validateResult: () => {
            assertCurrent();
            if (!outcome)
              return 'Call knowledge.notebook.update({summary: ...}) first, including when no changes are needed. Then call knowledge.result.';
            history.assertCurrent();
          },
        };
        dependencies.pin(runInput);
        await dependencies.run(runInput);
        await recordOutcome();
        if (!outcome) throw new NotebookError('invalid_request');
        return outcome;
      } catch {
        return await fail();
      } finally {
        close();
      }
    },
  };
}

/** Explicit requests await the same native admission and detached execution boundary as schedules. */
export async function maintainKnowledgeAgent(
  dependencies: KnowledgeMaintenanceDependencies,
  input: KnowledgeMaintenanceInput
) {
  return (await prepareKnowledgeMaintenance(dependencies, input)).execute();
}
