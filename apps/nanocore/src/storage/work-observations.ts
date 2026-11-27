import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  THREAD_RUNTIME_ACTIVITY_MAX_ENTRIES,
  THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS,
} from '@openkit/app-api-schemas';
import {
  ResourceCatalogDocumentSchema,
  ResourceCatalogIdSchema,
  ResourceDigestSchema,
} from '@openkit/config-schema';
import {
  canonicalJsonText,
  RETAINED_FORMAT_VERSION,
  ReasoningEffortSchema,
  readRetainedV1,
  SystemPromptDigestSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assertScopeAdmitted } from '../bootstrap/readiness.js';
import {
  retainWorkObservationBody,
  stageWorkObservationChunk,
  workObservationBodyBundleId,
} from '../evidence-bundles.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import { OperationError } from '../operation-error-core.js';
import type { ControlProductOwner } from './control-store-product-records.js';
import { getWorkspaceProductReadHandle } from './control-store-product-records.js';
import { bindWorkspaceSqlite, type CoreDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import {
  NATIVE_THREAD_LOGIN_FEATURE,
  NativeThreadRequiredFeaturesSchema,
  registerNativeThreadLoginValidity,
} from './native-thread-login.js';
import { StoredThreadSnapshotV1Schema } from './retained-work-events-v1.js';
import { StoredTurnV1Schema, StoredWorkOwnerV1Schema } from './retained-work-metadata-v1.js';
import { serverWorkUnavailable } from './server-work-command.js';
import {
  assertReapObservationPrefix,
  assertWorkObservationPosition,
  chargeObservation,
  EMPTY_OBSERVATION_BUDGET,
  fitsReap,
  isObservationCompanion,
  mergeReapCall,
  NATIVE_OBSERVATION_BYTES,
  ObservationCounterSchema,
  ObservationCutoffSchema,
  type ObservationOmissionResultSchema,
  type ObservationTruncation,
  ObservationTruncationSchema,
  observationBudgetLimit,
  omission,
  reapCallChange,
  reservedModelGap,
  serializedCallBytes,
  TURN_OBSERVATION_CONTROL_BYTES,
  WORK_OBSERVATION_TRUNCATION_FEATURE,
} from './work-observation-collection.js';
import { nativeProductScope, readNativeTurnHistory } from './workspace-file-records.js';

/** A scoped citation; publication edges are minted only by the storage owner. */
export interface WorkObservationReference {
  readonly kind: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly locator: string;
  readonly digest?: string | undefined;
  readonly edge: 'association' | 'publication';
}

/** Minimal historical source admission, never target catalog references or access authority. */
export const AssistantSkillAdmissionSchema = z
  .object({
    catalogRevision: ResourceCatalogDocumentSchema.shape.revision.nullable(),
    skills: z.array(
      z
        .object({
          skillId: ResourceCatalogIdSchema,
          versionId: ResourceDigestSchema,
          contentDigest: ResourceDigestSchema,
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((admission, context) => {
    if ((admission.skills.length === 0) !== (admission.catalogRevision === null)) {
      context.addIssue({
        code: 'custom',
        path: ['catalogRevision'],
        message: 'Only an empty Skill selection has a null catalog revision.',
      });
    }
    for (const [index, skill] of admission.skills.entries()) {
      const previous = admission.skills[index - 1];
      if (previous && previous.skillId >= skill.skillId) {
        context.addIssue({
          code: 'custom',
          path: ['skills', index, 'skillId'],
          message: 'Skill IDs must be unique and ordered by Skill ID.',
        });
      }
      if (skill.versionId !== skill.contentDigest) {
        context.addIssue({
          code: 'custom',
          path: ['skills', index, 'versionId'],
          message: 'The admitted Skill version must equal its content digest.',
        });
      }
    }
  });

/** Shared trusted-producer shape for the canonical environment admission tuple. */
export type AssistantSkillAdmission = z.infer<typeof AssistantSkillAdmissionSchema>;

/** Owner-validated long-lived facts, never arbitrary original bodies. */
export interface WorkObservationDraft {
  readonly id: string;
  readonly type: string;
  readonly ts: string;
  readonly obs: 'nanocore' | 'llm-gateway' | 'worker-shim' | 'nanohost';
  readonly parent?: string | undefined;
  readonly corr?: string | undefined;
  readonly ret?:
    | 'ephemeral-diagnostic'
    | 'turn-evidence'
    | 'workspace-audit'
    | 'restricted-raw'
    | 'legal-hold'
    | undefined;
  readonly outcome?: 'ok' | 'error' | 'unknown' | undefined;
  readonly cert?: 'inferred' | undefined;
  readonly refs?: readonly WorkObservationReference[] | undefined;
  readonly ext?: Readonly<Record<string, unknown>> | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Complete bytes already selected by the producer's admitted semantic boundary. */
export interface AdmittedWorkBody {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly boundary: string;
}

/** Persisted observation; sequence is Turn-local ingest order, not narrative order. */
export interface WorkObservationRecord extends WorkObservationDraft {
  readonly v: 1;
  readonly seq: number;
  readonly turnId: string;
}

/** Safe, lossy runtime activity projected after the caller checks current Thread audience. */
export interface ThreadRuntimeActivity {
  readonly turnId: string;
  readonly coverage: 'collecting' | 'partial' | 'unavailable';
  readonly contentCapture: 'off' | 'on' | 'unknown';
  readonly entries: readonly {
    readonly sequence: number;
    readonly observedAt: string;
    readonly kind: 'child-started' | 'progress' | 'result' | 'failure';
    readonly label?: string;
    readonly text?: string;
    readonly textTruncated: boolean;
  }[];
  readonly omittedEntryCount: number;
}

const referenceSchema = z
  .object({
    kind: z.string().min(1),
    scope: z.record(z.string(), z.string()),
    locator: z.string().min(1),
    digest: z.string().optional(),
    edge: z.enum(['association', 'publication']),
  })
  .strip();
const draftSchema = z
  .object({
    id: z.string().min(1).max(512),
    type: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/),
    ts: z.string().datetime(),
    obs: z.enum(['nanocore', 'llm-gateway', 'worker-shim', 'nanohost']),
    parent: z.string().min(1).optional(),
    corr: z.string().min(1).optional(),
    ret: z
      .enum([
        'ephemeral-diagnostic',
        'turn-evidence',
        'workspace-audit',
        'restricted-raw',
        'legal-hold',
      ])
      .optional(),
    outcome: z.enum(['ok', 'error', 'unknown']).optional(),
    cert: z.literal('inferred').optional(),
    refs: z.array(referenceSchema).optional(),
    ext: z.record(z.string(), z.unknown()).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strip();
const recordSchema = draftSchema.extend({
  v: z.literal(1),
  seq: z.number().int().positive(),
  turnId: TurnIdSchema,
});
const bodyDescriptorSchema = z
  .object({
    id: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    boundary: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bundleId: z.string().min(1),
  })
  .strip();
const modelEventSchema = z.enum([
  'request',
  'start',
  'text_start',
  'text_delta',
  'text_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error',
  'interrupted',
  'truncated',
  'failed',
]);
const modelContentSchema = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['off', 'expected']) }).strip(),
  z
    .object({
      state: z.literal('unavailable'),
      reason: z.enum(['credential-excluded', 'limit-exceeded', 'capture-failed']),
    })
    .strip(),
]);
const modelSamplingSchema = z
  .object({
    temperature: z.number().finite().nullable().optional(),
    topP: z.number().finite().nullable().optional(),
    maxOutputTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningEffort: ReasoningEffortSchema.nullable().optional(),
    reasoningSummary: z.enum(['auto', 'concise', 'detailed', 'off', 'on']).nullable().optional(),
    reasoningContext: z.literal('all_turns').nullable().optional(),
  })
  .strip();
const modelPayloadFields = {
  attempt: z.number().int().nonnegative(),
  runtimeOriginRef: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .nullable(),
  content: modelContentSchema,
  bodies: z.array(bodyDescriptorSchema.extend({ state: z.literal('expected') })).optional(),
};
const payloadSchemas = {
  'turn.reap': z
    .object({
      reason: z.string().min(1),
      lastObservedTs: z.string().datetime().nullable(),
      unresolvedCalls: z.array(
        z
          .object({
            corr: z.string().min(1),
            type: z.string().min(1),
            name: z.string().min(1).nullable(),
            ts: z.string().datetime(),
          })
          .strip()
      ),
      inferredBy: z.string().min(1),
      truncation: ObservationTruncationSchema.optional(),
    })
    .strip(),
  'env.bound': z
    .object({
      version: z.string().min(1),
      workspaceId: WorkspaceIdSchema.optional(),
      owner: z
        .object({ kind: z.literal('server') })
        .strict()
        .optional(),
      assistantSkillAdmission: AssistantSkillAdmissionSchema.optional(),
      systemPromptDigest: SystemPromptDigestSchema,
      tools: z.array(
        z
          .object({
            name: z.string().min(1),
            inputSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strip()
      ),
    })
    .strip()
    .superRefine((environment, context) => {
      if ((environment.workspaceId === undefined) === (environment.owner === undefined))
        context.addIssue({
          code: 'custom',
          message: 'Environment binding requires exactly one Workspace or Server owner.',
        });
    }),
  'runtime.observed': WorkerObservationDataSchema,
  // Reserved configured identity at shared dispatch; this does not assert provider delivery or a reported snapshot.
  'config.model': z
    .object({
      attempt: z.number().int().nonnegative(),
      providerRef: z.string().min(1),
      model: z.string().min(1),
      sampling: modelSamplingSchema,
      cause: z.string().min(1).optional(),
    })
    .strip(),
  'model.observed': z.discriminatedUnion('direction', [
    z
      .object({
        ...modelPayloadFields,
        direction: z.literal('request'),
        event: z.literal('request'),
        providerRef: z.string().min(1),
        model: z.string().min(1),
        systemPromptDigest: SystemPromptDigestSchema,
        sampling: modelSamplingSchema,
      })
      .strip(),
    z
      .object({
        ...modelPayloadFields,
        direction: z.literal('response'),
        event: modelEventSchema.exclude(['request']),
        reportedModel: z.string().min(1).optional(),
      })
      .strip(),
  ]),
  'model.capture-gap': z
    .object({
      direction: z.enum(['request', 'response']),
      event: modelEventSchema,
      attempt: z.number().int().nonnegative(),
      content: z
        .object({
          state: z.literal('unavailable'),
          reason: z.enum(['capture-failed', 'credential-excluded', 'limit-exceeded']),
        })
        .strip(),
    })
    .strip(),
  'content.published': z.object({ bodies: z.array(bodyDescriptorSchema).min(1) }).strip(),
  'capture.unavailable': z
    .object({
      family: z.enum(['model-request', 'model-response', 'runtime-content']),
      reason: z.enum(['unsupported', 'capture-failed', 'truncated', 'credential-excluded']),
    })
    .strip(),
};

/** Identifies canonical types whose complete payload semantics this implementation admits. */
export function isSupportedWorkObservationType(type: string): boolean {
  return Object.hasOwn(payloadSchemas, type);
}

/** Pure canonical parser shared by storage and portable consumers; unknown semantics fail closed. */
export function parseWorkObservationRecord(value: unknown): WorkObservationRecord {
  const row = recordSchema.parse(value);
  if (!isSupportedWorkObservationType(row.type))
    throw new Error(`Unsupported work observation type: ${row.type}`);
  const schema = payloadSchemas[row.type as keyof typeof payloadSchemas];
  for (const key of ['id', 'turnId'] as const) {
    if (row.payload[key] !== undefined && row.payload[key] !== row[key])
      throw new Error('recovery_required: observation header identity mismatch');
  }
  row.payload = schema.parse(row.payload);
  if (row.type === 'turn.reap' && row.payload.truncation !== undefined) {
    const { firstOmittedSequence } = ObservationTruncationSchema.parse(row.payload.truncation);
    if (firstOmittedSequence > row.seq)
      throw new Error('recovery_required: invalid observation truncation boundary');
  }
  if (
    ((row.type.startsWith('model.') || row.type === 'config.model') && row.obs !== 'llm-gateway') ||
    (row.type === 'runtime.observed' && row.obs !== 'worker-shim') ||
    ((row.type === 'env.bound' || row.type === 'turn.reap') && row.obs !== 'nanocore')
  )
    throw new Error('Observation type has the wrong observer');
  if (row.type !== 'content.published' && row.refs?.some((ref) => ref.edge === 'publication'))
    throw new Error('Only publication observations may carry publication references');
  if (row.type === 'content.published') {
    const bodies = z.array(bodyDescriptorSchema).parse(row.payload.bodies);
    if (
      !row.parent ||
      row.refs?.length !== bodies.length ||
      new Set(bodies.map((body) => body.id)).size !== bodies.length ||
      bodies.some(
        (body) =>
          !row.refs?.some(
            (ref) =>
              ref.edge === 'publication' &&
              ref.kind === 'evidence-bundle' &&
              ref.locator === body.bundleId &&
              ref.digest === body.sha256 &&
              ref.scope.pathClass === 'backend' &&
              ((typeof ref.scope.workspaceId === 'string' && ref.scope.owner === undefined) ||
                (ref.scope.owner === 'server' && ref.scope.workspaceId === undefined))
          )
      )
    )
      throw new Error('Invalid content publication observation');
  }
  return row;
}

/** Validates persisted lineage and reads historical coverage without using current policy. */
export function readWorkObservationTurnBinding(
  workspaceDb: WorkspaceDb | CoreDb,
  input: { readonly threadId: string; readonly turnId: string }
) {
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
  const owner = { kind: 'workspace' as const, workspaceId: workspaceDb.workspaceId };
  const binding = readControlWorkObservationTurnBinding(workspaceDb.sqlite, owner, input);
  const root = join(
    workspaceDb.dataRoot,
    'workspaces',
    owner.workspaceId,
    'threads',
    input.threadId,
    'turns',
    input.turnId
  );
  return { root, turn: binding.turn, coverage: binding.coverage };
}

/** Reads complete ordered native pages; malformed or missing authority fails closed. */
export function readWorkObservations(
  workspaceDb: WorkspaceDb | CoreDb,
  input: { readonly threadId: string; readonly turnId: string }
): readonly WorkObservationRecord[] {
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
  const owner = { kind: 'workspace' as const, workspaceId: workspaceDb.workspaceId };
  const records: WorkObservationRecord[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = readControlWorkObservations(workspaceDb.sqlite, owner, {
      ...input,
      afterSequence,
    });
    records.push(...page);
    if (page.length < 128) return records;
    afterSequence = page.at(-1)!.seq;
  }
}

/** Awaits expected metadata first; only durable evidence bytes can authorize the later publication marker. */
export async function appendWorkObservation(
  workspaceDb: WorkspaceDb | CoreDb,
  input: ControlWorkObservationPreparation
): Promise<Pick<RetainedWorkObservation, 'disposition' | 'observation'>> {
  if (workspaceDb.sqlite.inTransaction)
    throw new Error('Observation submission cannot span a Main transaction');
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
  const owner = { kind: 'workspace' as const, workspaceId: workspaceDb.workspaceId };
  const prepared = prepareControlWorkObservation(owner, input);
  const scope = nativeProductScope(workspaceDb.dataRoot, owner);
  // Load only on the producer path; the native SQL owner must not start another writer host.
  const { getControlStoreWorkerClient } = await import('./control-store-worker-client.js');
  const client = getControlStoreWorkerClient();
  const database = `${workspaceDb.scope}:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: workspaceDb.dataRoot,
    create: false,
    initialize: workspaceDb.scope,
    productOwner: owner,
    contentMount: scope.contentMount,
  });
  // This is the existing expectation/publication lifecycle, not a second writer or a retry.
  // If independent evidence publication fails, the original expected observation remains available to its gap fact.
  const expected = requireRetainedObservation(
    await client.observation(database, { ...prepared, publishBodies: false })
  );
  if (!prepared.publishBodies)
    return { disposition: expected.disposition, observation: expected.observation };
  const result = requireRetainedObservation(
    await client.observation(
      database,
      prepared,
      input.bodies.map((body) => body.bytes)
    )
  );
  return { disposition: expected.disposition, observation: result.observation };
}

/** Exact immutable body identity prepared before the native SQL transition. */
export type WorkObservationBodyDescriptor = z.infer<typeof bodyDescriptorSchema>;

/** SQL-only prepared input; the native preparation owns body publication before this transition. */
export interface ControlWorkObservationInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly observation: WorkObservationDraft;
  readonly bodies: readonly WorkObservationBodyDescriptor[];
  readonly publishBodies?: boolean | undefined;
  readonly workerSequence?: number | undefined;
  readonly originalWorkerReplay?: boolean | undefined;
}

/** Savepoint result only: the worker must await outer FULL COMMIT before acknowledgement. */
export interface RetainedWorkObservation {
  readonly disposition: 'committed' | 'duplicate';
  readonly observation: WorkObservationRecord;
  readonly publication: WorkObservationRecord | null;
}

export type ControlWorkObservationResult =
  | RetainedWorkObservation
  | z.infer<typeof ObservationOmissionResultSchema>;

/** Delivered after the native owner's FULL acknowledgement, never from a rolled-back savepoint. */
export class ObservationCollectionStoppedError extends Error {
  readonly code = 'observation_limit_reached';
  constructor(
    readonly disposition: 'truncated' | 'closed',
    readonly truncation: ObservationTruncation | null
  ) {
    super('Work observation collection is closed.');
    this.name = 'ObservationCollectionStoppedError';
  }
}

export function requireRetainedObservation<
  T extends Pick<RetainedWorkObservation, 'disposition' | 'observation'>,
>(result: T | z.infer<typeof ObservationOmissionResultSchema>): T {
  if ('observation' in result) return result;
  throw new ObservationCollectionStoppedError(result.disposition, result.truncation);
}

type ObservationStopSelector = {
  threadId: string;
  turnId: string;
  agentSessionId?: string | null;
};

/** Rechecks a cutoff in the already-admitted owner snapshot before agent contact. */
export function readAdmittedObservationCutoff(
  db: WorkspaceDb,
  input: ObservationStopSelector
): ObservationTruncation | undefined {
  return db.sqlite.transaction(() => {
    const candidate = db.sqlite
      .prepare(
        "SELECT 1 FROM control_turns WHERE id=? AND json_type(record_json,'$.observationCutoff') IS NOT NULL"
      )
      .get(input.turnId);
    if (!candidate) return undefined;
    const { turn } = readWorkObservationTurnBinding(db, input);
    if (input.agentSessionId != null && input.agentSessionId !== turn.agentSessionId)
      throw new Error('recovery_required: observation cutoff worker lineage mismatch');
    return turn.observationCutoff?.summary;
  })();
}

/** Uses the admitted Workspace and exact Turn for startup and stop delivery. */
export function readWorkspaceObservationCutoff(
  dataRoot: string,
  input: ObservationStopSelector & { workspaceId: string }
): ObservationTruncation | undefined {
  assertScopeAdmitted(dataRoot, 'workspace', input.workspaceId);
  const reader = getWorkspaceProductReadHandle(workspaceDbPath(dataRoot, input.workspaceId), {
    kind: 'workspace',
    workspaceId: input.workspaceId,
  });
  return readAdmittedObservationCutoff(
    bindWorkspaceSqlite(reader.sqlite, dataRoot, input.workspaceId),
    input
  );
}

/** Producer-owned complete bytes; deferral records expectations without publication authority. */
export interface ControlWorkObservationPreparation {
  readonly threadId: string;
  readonly turnId: string;
  readonly observation: WorkObservationDraft;
  readonly bodies: readonly AdmittedWorkBody[];
  readonly deferBodyPublication?: true;
  readonly workerSequence?: number | undefined;
  readonly originalWorkerReplay?: boolean | undefined;
}

/** Scoped selectors are not paths and cannot select a second owning database. */
const controlObservationSelectorSchema = z.object({
  threadId: z.string().min(1),
  turnId: TurnIdSchema,
});
/** Closed native transport envelope; the complete SQL body validates retained observation semantics. */
export const ControlWorkObservationInputSchema = controlObservationSelectorSchema
  .extend({
    observation: z.record(z.string(), z.unknown()),
    bodies: z.array(bodyDescriptorSchema.strict()),
    publishBodies: z.boolean().optional(),
    workerSequence: z.int().nonnegative().optional(),
    originalWorkerReplay: z.boolean().optional(),
  })
  .strict();

/** Trusted chunk carriage; the native owner rechecks it against the original durable declaration. */
export const ControlWorkObservationChunkInputSchema = controlObservationSelectorSchema
  .extend({
    chunk: z
      .object({
        observationId: z.string().min(1),
        totalBytes: z
          .number()
          .int()
          .min(0)
          .max(16 * 1024 * 1024),
        byteLength: z
          .number()
          .int()
          .min(0)
          .max(48 * 1024),
        chunkIndex: z.number().int().nonnegative(),
        byteOffset: z.number().int().nonnegative(),
        replay: z.boolean(),
        workerSequence: z.int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

/** Existing observation command, with either complete body descriptors or an original chunk selector. */
export type ControlWorkObservationCommandInput =
  | ControlWorkObservationInput
  | z.infer<typeof ControlWorkObservationChunkInputSchema>;

/** Publishes one admitted chunk through the same native preparation and covering acknowledgement. */
export async function appendWorkObservationChunk(
  workspaceDb: WorkspaceDb,
  input: z.infer<typeof ControlWorkObservationChunkInputSchema>,
  bytes: Uint8Array
): Promise<void> {
  if (workspaceDb.sqlite.inTransaction)
    throw new Error('Observation submission cannot span a Main transaction');
  const owner = { kind: 'workspace' as const, workspaceId: workspaceDb.workspaceId };
  const scope = nativeProductScope(workspaceDb.dataRoot, owner);
  const { getControlStoreWorkerClient } = await import('./control-store-worker-client.js');
  const client = getControlStoreWorkerClient();
  const database = `workspace:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: workspaceDb.dataRoot,
    create: false,
    initialize: workspaceDb.scope,
    productOwner: owner,
    contentMount: scope.contentMount,
  });
  requireRetainedObservation(await client.observation(database, input, [bytes]));
}

/** Native index fields are checked against their frozen retained payload before use. */
interface ControlObservationRow {
  turn_id: string;
  sequence: number;
  id: string;
  schema_version: number;
  record_json: string;
}

const threadBindingSchema = z.object({
  id: StoredThreadSnapshotV1Schema.shape.id,
  owner: StoredWorkOwnerV1Schema,
  status: StoredThreadSnapshotV1Schema.shape.status,
  entryPath: StoredThreadSnapshotV1Schema.shape.entryPath,
  visibility: StoredThreadSnapshotV1Schema.shape.visibility,
  privateOwnerUserId: StoredThreadSnapshotV1Schema.shape.privateOwnerUserId,
  parentThreadId: StoredThreadSnapshotV1Schema.shape.parentThreadId,
  requiredFeatures: NativeThreadRequiredFeaturesSchema.optional(),
});
const turnBindingSchema = StoredTurnV1Schema.pick({
  id: true,
  owner: true,
  threadId: true,
  agentSessionId: true,
  status: true,
  startedAt: true,
  completedAt: true,
  captureCoverage: true,
  requiredFeatures: true,
  reasoningEffort: true,
}).extend({
  observationCutoff: ObservationCutoffSchema.optional(),
  observationCounter: ObservationCounterSchema.optional(),
});

/** Whitelist metadata before any row crosses the SQLite boundary. */
function bindingProjection(fields: Record<string, unknown>): string {
  const keys = ['schemaVersion', ...Object.keys(fields)].map((key) => `'${key}'`).join(', ');
  return `(SELECT json_group_object(key, json(record_json -> fullkey)) FROM json_each(record_json)
    WHERE key IN (${keys})) AS metadata`;
}

interface ObservationOwnerRow {
  readonly schema_version: number;
  readonly revision: number;
  readonly bytes: number;
  readonly legacy_owner_absent: number;
  readonly status: string;
  readonly metadata: string;
  readonly ordinary_bytes?: number;
}

function validObservationOwnerRow(
  row: ObservationOwnerRow | undefined
): row is ObservationOwnerRow {
  return (
    row !== undefined &&
    row.schema_version === RETAINED_FORMAT_VERSION &&
    row.bytes <=
      (row.ordinary_bytes === undefined ? 65_536 : 65_536 + TURN_OBSERVATION_CONTROL_BYTES) &&
    (row.ordinary_bytes ?? row.bytes) <= 65_536 &&
    row.legacy_owner_absent === 1 &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 1
  );
}

/** Reads native Thread/Turn authority without materializing titles, descriptions or Item bodies. */
export function readControlWorkObservationTurnBinding(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string }
): {
  readonly turn: z.infer<typeof turnBindingSchema>;
  readonly revision: number;
  readonly coverage: NonNullable<z.infer<typeof turnBindingSchema>['captureCoverage']> | null;
} {
  if (!sqlite.inTransaction)
    return sqlite.transaction(() => readControlWorkObservationTurnBinding(sqlite, owner, input))();
  controlObservationSelectorSchema.parse(input);
  if (!isDeepStrictEqual(owner, StoredWorkOwnerV1Schema.parse(owner)))
    throw new Error('Observation database owner is invalid');
  registerNativeThreadLoginValidity(sqlite);
  const threadRow = sqlite
    .prepare(`SELECT schema_version, revision, workspace_id, status,
      length(CAST(record_json AS BLOB)) AS bytes,
      json_type(record_json, '$.workspaceId') IS NULL AS legacy_owner_absent,
      native_thread_login_valid(record_json -> '$.login') AS login_valid,
      ${bindingProjection(threadBindingSchema.shape)} FROM control_threads WHERE id=?`)
    .get(input.threadId) as
    | (ObservationOwnerRow & { workspace_id: string | null; login_valid: number | null })
    | undefined;
  const turnRow = sqlite
    .prepare(`SELECT schema_version, revision, thread_id, agent_session_id, status,
      length(CAST(record_json AS BLOB)) AS bytes,
      length(CAST(json_remove(record_json, '$.observationCutoff', '$.observationCounter', '$.requiredFeatures') AS BLOB)) AS ordinary_bytes,
      json_type(record_json, '$.workspaceId') IS NULL AS legacy_owner_absent,
      ${bindingProjection(turnBindingSchema.shape)}
      FROM control_turns WHERE id=?`)
    .get(input.turnId) as
    | (ObservationOwnerRow & { thread_id: string; agent_session_id: string | null })
    | undefined;
  if (!validObservationOwnerRow(threadRow) || !validObservationOwnerRow(turnRow))
    throw new Error('recovery_required: missing or invalid native observation owner');

  const threadMetadata: unknown = JSON.parse(threadRow.metadata);
  const turnMetadata: unknown = JSON.parse(turnRow.metadata);
  const thread = readRetainedV1(threadMetadata, () => threadBindingSchema.parse(threadMetadata));
  const turn = readRetainedV1(turnMetadata, () => turnBindingSchema.parse(turnMetadata));
  if (
    thread.id !== input.threadId ||
    thread.parentThreadId === thread.id ||
    turn.id !== input.turnId ||
    turn.threadId !== input.threadId ||
    turnRow.thread_id !== input.threadId ||
    turnRow.agent_session_id !== (turn.agentSessionId ?? null) ||
    threadRow.status !== thread.status ||
    turnRow.status !== turn.status ||
    threadRow.workspace_id !== (owner.kind === 'workspace' ? owner.workspaceId : null) ||
    !isDeepStrictEqual(thread.owner, owner) ||
    !isDeepStrictEqual(turn.owner, owner) ||
    (thread.visibility === 'server') !== (owner.kind === 'server') ||
    (thread.visibility === 'private') !== (thread.privateOwnerUserId !== undefined) ||
    (thread.entryPath === 'administration' &&
      owner.kind === 'workspace' &&
      thread.visibility !== 'private') ||
    threadRow.login_valid === 0 ||
    (threadRow.login_valid === 1) !==
      (thread.requiredFeatures?.includes(NATIVE_THREAD_LOGIN_FEATURE) === true)
  )
    throw new Error('recovery_required: native observation owner lineage mismatch');
  const truncated = turn.requiredFeatures?.includes(WORK_OBSERVATION_TRUNCATION_FEATURE) === true;
  if (
    (truncated && !turn.requiredFeatures?.includes('openkit.work-observations.v1')) ||
    (turn.observationCutoff && !truncated)
  )
    throw new Error('recovery_required: missing observation truncation feature');
  return { turn, revision: turnRow.revision, coverage: turn.captureCoverage ?? null };
}

/** Checks native row version, known semantics and indexed identity without rewriting descriptive additions. */
function decodeControlObservation(
  row: ControlObservationRow,
  turnId: string
): WorkObservationRecord {
  if (row.schema_version !== 1 || Buffer.byteLength(row.record_json) > NATIVE_OBSERVATION_BYTES)
    throw new Error('recovery_required: unsupported native observation record');
  const raw = JSON.parse(row.record_json) as Record<string, unknown>;
  if (
    raw.requiredFeatures !== undefined &&
    (!Array.isArray(raw.requiredFeatures) || raw.requiredFeatures.length !== 0)
  )
    throw new Error('recovery_required: unsupported required observation semantics');
  const record = parseWorkObservationRecord(raw);
  if (
    record.turnId !== turnId ||
    row.turn_id !== turnId ||
    record.seq !== row.sequence ||
    record.id !== row.id
  )
    throw new Error('recovery_required: native observation index mismatch');
  return record;
}

/** Checks the committed manifest before a native observation can be consumed. */
function assertControlObservationManifest(
  binding: ReturnType<typeof readControlWorkObservationTurnBinding>
): void {
  if (!binding.coverage || !binding.turn.requiredFeatures?.includes('openkit.work-observations.v1'))
    throw new Error('recovery_required: missing native observation capture manifest');
}

function assertObservationTruncation(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  binding: ReturnType<typeof readControlWorkObservationTurnBinding>,
  record: WorkObservationRecord
): void {
  if (record.type !== 'turn.reap') return;
  const truncated = record.payload.truncation !== undefined;
  if (
    truncated !==
      (binding.turn.requiredFeatures?.includes(WORK_OBSERVATION_TRUNCATION_FEATURE) === true) ||
    (binding.turn.observationCutoff &&
      !isDeepStrictEqual(record.payload.truncation, binding.turn.observationCutoff.summary))
  )
    throw new Error('recovery_required: inconsistent observation truncation feature or summary');
  const summary = ObservationTruncationSchema.optional().parse(record.payload.truncation);
  function* prior() {
    const rows = sqlite
      .prepare(
        'SELECT * FROM control_work_observations WHERE turn_id=? AND sequence<? ORDER BY sequence'
      )
      .iterate(record.turnId, record.seq) as Iterable<ControlObservationRow>;
    for (const row of rows)
      yield {
        record: decodeControlObservation(row, record.turnId),
        bytes: Buffer.byteLength(row.record_json),
      };
  }
  assertReapObservationPrefix(
    prior(),
    summary,
    record,
    ['pending', 'running'].includes(binding.turn.status) || !binding.turn.completedAt,
    { retainedSequence: binding.turn.observationCutoff?.retainedSequence, owner }
  );
}

/** Returns one committed native identity, including the original sequence on replay. */
export function readControlWorkObservation(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string; readonly id: string },
  replay?: Pick<ControlWorkObservationInput, 'workerSequence' | 'originalWorkerReplay'>
): WorkObservationRecord | undefined {
  if (!sqlite.inTransaction)
    return sqlite.transaction(() => readControlWorkObservation(sqlite, owner, input, replay))();
  const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
  const row = sqlite
    .prepare('SELECT * FROM control_work_observations WHERE turn_id=? AND id=?')
    .get(input.turnId, input.id) as ControlObservationRow | undefined;
  if (!row) return undefined;
  assertControlObservationManifest(binding);
  const record = decodeControlObservation(row, input.turnId);
  if (replay?.workerSequence !== undefined)
    assertWorkObservationPosition(
      JSON.parse(row.record_json).workerSequence,
      replay.workerSequence,
      replay.originalWorkerReplay
    );
  assertObservationTruncation(sqlite, owner, binding, record);
  assertControlObservationLineage(sqlite, owner, input, record);
  return record;
}

/** Reads a bounded ordered native page; end the read before streaming or awaiting downstream work. */
export function readControlWorkObservations(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly afterSequence?: number;
    readonly limit?: number;
  }
): readonly WorkObservationRecord[] {
  return readControlObservationPage(sqlite, owner, input).map(({ record }) => record);
}

function readControlObservationPage(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly afterSequence?: number;
    readonly limit?: number;
  }
): readonly { record: WorkObservationRecord; bytes: number }[] {
  if (!sqlite.inTransaction)
    return sqlite.transaction(() => readControlObservationPage(sqlite, owner, input))();
  const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
  const after = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(input.afterSequence ?? 0);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(128)
    .parse(input.limit ?? 128);
  const rows = sqlite
    .prepare(
      'SELECT * FROM control_work_observations WHERE turn_id=? AND sequence>? ORDER BY sequence LIMIT ?'
    )
    .all(input.turnId, after, limit) as ControlObservationRow[];
  if (rows.length) assertControlObservationManifest(binding);
  return rows.map((row, index) => {
    const record = decodeControlObservation(row, input.turnId);
    if (record.seq !== after + index + 1)
      throw new Error('recovery_required: native observation sequence gap');
    assertObservationTruncation(sqlite, owner, binding, record);
    assertControlObservationLineage(sqlite, owner, input, record);
    return { record, bytes: Buffer.byteLength(row.record_json) };
  });
}

/** Verifies retained causal edges, expected bodies and the exact scope of publication descriptors. */
function assertControlObservationLineage(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string },
  record: WorkObservationRecord
): void {
  if (
    record.type === 'env.bound' &&
    (owner.kind === 'server'
      ? record.payload.workspaceId !== undefined ||
        (record.payload.owner as { kind?: string } | undefined)?.kind !== 'server'
      : record.payload.workspaceId !== owner.workspaceId || record.payload.owner !== undefined)
  )
    throw new Error('Environment binding database owner mismatch');
  if (!record.parent) return;
  const parentRow = sqlite
    .prepare('SELECT * FROM control_work_observations WHERE turn_id=? AND id=?')
    .get(input.turnId, record.parent) as ControlObservationRow | undefined;
  if (!parentRow) {
    // Portable remint preserves the format's Item parent alternative; it is not an observation-only edge.
    const itemRow = sqlite
      .prepare(
        "SELECT identity_json FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(input.turnId, record.parent) as { identity_json: string } | undefined;
    const item = itemRow ? (JSON.parse(itemRow.identity_json) as Record<string, unknown>) : null;
    if (
      !isObservationCompanion(record) &&
      !(record.type === 'model.observed' && record.payload.direction === 'response') &&
      item?.id === record.parent &&
      item.turnId === input.turnId &&
      item.threadId === input.threadId &&
      isDeepStrictEqual(item.owner, owner)
    )
      return;
    throw new Error('recovery_required: missing native observation parent');
  }
  const parent = decodeControlObservation(parentRow, input.turnId);
  if (parent.seq >= record.seq)
    throw new Error('recovery_required: invalid native observation parent order');
  if (
    record.type === 'model.observed' &&
    record.payload.direction === 'response' &&
    (parent.type !== 'model.observed' ||
      parent.payload.direction !== 'request' ||
      parent.corr !== record.corr ||
      parent.payload.attempt !== record.payload.attempt)
  )
    throw new Error('recovery_required: model observation request lineage mismatch');
  if (record.type === 'model.capture-gap' && isObservationCompanion(record)) {
    const { v: _version, seq: _sequence, turnId: _turnId, ...draft } = record;
    const content = record.payload.content as { reason?: unknown };
    if (
      !admitsReservedModelGap(parent, draft) ||
      !isDeepStrictEqual(draft, reservedModelGap(parent, content.reason))
    )
      throw new Error('recovery_required: reserved model gap lineage mismatch');
  }
  if (record.type === 'content.published') {
    const bodies = z.array(bodyDescriptorSchema).parse(record.payload.bodies);
    // Import remints observation and bundle identities through their exact maps. Retained meaning uses the bound descriptors and refs, not a live producer's id derivation.
    assertControlBodyDescriptors(owner, input, parent, bodies, false);
    if (
      record.ts !== parent.ts ||
      record.obs !== parent.obs ||
      record.ret !== 'turn-evidence' ||
      !isDeepStrictEqual(record.refs, controlBodyReferences(owner, bodies))
    )
      throw new Error('recovery_required: native observation publication lineage mismatch');
  }
}

function hasReservedModelBody(row: WorkObservationRecord): boolean {
  return (
    row.type === 'model.observed' &&
    Array.isArray(row.payload.bodies) &&
    row.payload.bodies.length > 0
  );
}

function admitsReservedModelGap(parent: WorkObservationRecord, gap: WorkObservationDraft): boolean {
  return (
    hasReservedModelBody(parent) &&
    isDeepStrictEqual(gap.refs, parent.refs) &&
    gap.parent === parent.id &&
    gap.ts === parent.ts &&
    gap.obs === parent.obs &&
    gap.corr === parent.corr &&
    gap.payload.attempt === parent.payload.attempt &&
    gap.payload.direction === parent.payload.direction &&
    gap.payload.event === parent.payload.event
  );
}

/** Checks prepared identities against the deterministic body owner and the producer's expected-content declaration. */
function assertControlBodyDescriptors(
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string },
  record: WorkObservationRecord,
  bodies: readonly WorkObservationBodyDescriptor[],
  requireDerivedIdentity = true
): void {
  if (!bodies.length) return;
  if (
    !['model.observed', 'runtime.observed'].includes(record.type) ||
    (record.payload.content as { state?: string } | undefined)?.state !== 'expected' ||
    new Set(bodies.map((body) => body.id)).size !== bodies.length
  )
    throw new Error('Observation body requires a unique expected-content declaration');
  for (const body of bodies) {
    bodyDescriptorSchema.parse(body);
    if (
      body.bytes > 16 * 1024 * 1024 ||
      (requireDerivedIdentity &&
        body.bundleId !==
          workObservationBodyBundleId(
            owner.kind === 'server' ? owner : owner.workspaceId,
            input.threadId,
            input.turnId,
            record.id,
            body.id
          ))
    )
      throw new Error('recovery_required: observation body owner mismatch');
  }
  if (record.type === 'runtime.observed') {
    const expected = WorkerObservationDataSchema.parse(record.payload).content;
    const body = bodies[0];
    if (
      expected.state !== 'expected' ||
      bodies.length !== 1 ||
      !body ||
      body.bytes !== expected.bytes ||
      `sha256:${body.sha256}` !== expected.sha256 ||
      body.boundary !== expected.boundary ||
      body.mediaType !== expected.mediaType
    )
      throw new Error('Runtime body contradicts its expected declaration');
  } else if (
    !isDeepStrictEqual(
      record.payload.bodies,
      bodies.map((body) => ({ ...body, state: 'expected' }))
    )
  )
    throw new Error('recovery_required: model body publication identity mismatch');
}

/** Only the observation owner mints scoped publication edges. */
function controlBodyReferences(
  owner: ControlProductOwner,
  bodies: readonly WorkObservationBodyDescriptor[]
): WorkObservationReference[] {
  return bodies.map((body) => ({
    kind: 'evidence-bundle',
    scope: {
      ...(owner.kind === 'server' ? { owner: 'server' } : { workspaceId: owner.workspaceId }),
      pathClass: 'backend',
    },
    locator: body.bundleId,
    digest: body.sha256,
    edge: 'publication',
  }));
}

/** Derives immutable expected identity without I/O; the SQL body revalidates it at admission. */
export function prepareControlWorkObservation(
  owner: ControlProductOwner,
  input: ControlWorkObservationPreparation
): ControlWorkObservationInput {
  controlObservationSelectorSchema.parse(input);
  draftSchema.parse(input.observation);
  const bodies = input.bodies.map((body) => {
    if (!(body.bytes instanceof Uint8Array) || body.bytes.byteLength > 16 * 1024 * 1024)
      throw new Error('Invalid admitted observation body');
    return bodyDescriptorSchema.parse({
      id: body.id,
      bytes: body.bytes.byteLength,
      mediaType: body.mediaType,
      boundary: body.boundary,
      sha256: createHash('sha256').update(body.bytes).digest('hex'),
      bundleId: workObservationBodyBundleId(
        owner.kind === 'server' ? owner : owner.workspaceId,
        input.threadId,
        input.turnId,
        input.observation.id,
        body.id
      ),
    });
  });
  // Forward the known live DTO; retained annotations and generated descriptors are not producer input.
  const candidate = controlObservationCandidate({ ...input, bodies }, undefined, 1, owner);
  const { v: _version, seq: _sequence, turnId: _turnId, payload, ...observation } = candidate;
  const { bodies: _expectedBodies, ...producerPayload } = payload;
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    observation: { ...observation, payload: producerPayload },
    bodies,
    publishBodies: bodies.length > 0 && !input.deferBodyPublication,
    ...(input.workerSequence !== undefined ? { workerSequence: input.workerSequence } : {}),
    ...(input.originalWorkerReplay ? { originalWorkerReplay: true } : {}),
  };
}

/** Existing Server work writer with the immutable Server evidence root. */
export type ServerWorkObservationDb = {
  readonly scope: 'server-work';
  readonly sqlite: Database.Database;
  readonly dataRoot: string;
};

/** Uses the existing evidence owner outside SQL, preserving its independent FULL-commit and expiry guards. */
export function publishControlWorkObservationBodies(
  db: WorkspaceDb | CoreDb | ServerWorkObservationDb,
  input: ControlWorkObservationPreparation
): ControlWorkObservationInput {
  if (db.sqlite.inTransaction || Number(db.sqlite.pragma('synchronous', { simple: true })) < 2)
    throw new Error('Observation evidence requires a durable independent owner commit');
  if (db.scope === 'core') throw serverWorkUnavailable();
  const owner: ControlProductOwner =
    db.scope === 'workspace'
      ? { kind: 'workspace', workspaceId: db.workspaceId }
      : { kind: 'server' };
  const prepared = prepareControlWorkObservation(owner, input);
  const binding = readControlWorkObservationTurnBinding(db.sqlite, owner, input);
  if (!binding.coverage || (prepared.bodies.length && binding.coverage.value !== 'on'))
    throw new Error('Observation capture coverage does not permit bodies');
  const existing = readControlWorkObservation(
    db.sqlite,
    owner,
    { ...input, id: input.observation.id },
    prepared
  );
  if (prepared.publishBodies && !existing)
    throw new Error('Observation body publication requires a committed declaration');
  controlObservationCandidate(prepared, existing, existing?.seq ?? 1, owner);
  const prior = readControlWorkObservation(db.sqlite, owner, {
    ...input,
    id: `${input.observation.id}:publication`,
  });
  if (prior) {
    if (
      !existing ||
      (prepared.bodies.length > 0 && !isDeepStrictEqual(prior.payload.bodies, prepared.bodies))
    )
      throw new Error('recovery_required: observation publication conflict');
    return prepared;
  }
  if (prepared.publishBodies)
    for (const [index, body] of input.bodies.entries()) {
      const descriptor = prepared.bodies[index]!;
      if (
        retainWorkObservationBody(db, {
          bundleId: descriptor.bundleId,
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt: input.observation.ts,
          sha256: descriptor.sha256,
          bytes: body.bytes,
        }) === 'expired'
      )
        throw new Error('recovery_required: unpublished body was lawfully expired');
    }
  return prepared;
}

/** Prepares the complete WorkBody family outside SQL on the existing native scope and FIFO slot. */
export async function prepareControlWorkObservationCommand(
  db: WorkspaceDb | CoreDb,
  input: ControlWorkObservationCommandInput,
  content: ArrayBuffer | undefined
): Promise<ControlWorkObservationInput> {
  if (db.scope === 'core') throw serverWorkUnavailable();
  if ('chunk' in input) {
    const parsed = ControlWorkObservationChunkInputSchema.parse(input);
    if ((content?.byteLength ?? 0) !== parsed.chunk.byteLength)
      throw new Error('Invalid native observation chunk');
    const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
    const binding = readControlWorkObservationTurnBinding(db.sqlite, owner, parsed);
    if (binding.coverage?.value !== 'on')
      throw new Error('Observation content is not admitted by this Turn');
    const initial = readControlWorkObservation(db.sqlite, owner, {
      ...parsed,
      id: parsed.chunk.observationId,
    });
    if (!initial || initial.type !== 'runtime.observed')
      throw new Error('Observation content arrived without durable metadata');
    const declaration = WorkerObservationDataSchema.parse(initial.payload);
    if (
      declaration.content.state !== 'expected' ||
      declaration.content.bytes !== parsed.chunk.totalBytes
    )
      throw new Error('Observation has no matching expected content');
    const expected = declaration.content;
    const staged = await stageWorkObservationChunk(db, {
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      bundleId: workObservationBodyBundleId(
        db.workspaceId,
        parsed.threadId,
        parsed.turnId,
        initial.id,
        'content'
      ),
      createdAt: initial.ts,
      sha256: expected.sha256.replace(/^sha256:/, ''),
      totalBytes: expected.bytes,
      chunkCount: expected.chunkCount,
      chunkIndex: parsed.chunk.chunkIndex,
      byteOffset: parsed.chunk.byteOffset,
      workerSequence: parsed.chunk.workerSequence,
      originalWorkerReplay: parsed.chunk.replay,
      bytes: new Uint8Array(content ?? new ArrayBuffer(0)),
    });
    if (staged.state === 'expired' && !parsed.chunk.replay)
      throw new Error('Expired observation evidence cannot accept new content');
    const { v: _v, seq: _seq, turnId: _turnId, ...observation } = initial;
    const preparation = {
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      observation,
      bodies:
        staged.state === 'complete'
          ? [
              {
                id: 'content',
                bytes: staged.bytes,
                mediaType: expected.mediaType,
                boundary: expected.boundary,
              },
            ]
          : [],
    };
    return staged.state === 'complete'
      ? publishControlWorkObservationBodies(db, preparation)
      : prepareControlWorkObservation(owner, preparation);
  }
  if (!input.publishBodies || !input.bodies.length) return input;
  let offset = 0;
  const bodies = input.bodies.map((body) => {
    const bytes = new Uint8Array(content ?? new ArrayBuffer(0), offset, body.bytes);
    offset += body.bytes;
    return { ...body, bytes };
  });
  if (offset !== (content?.byteLength ?? 0)) throw new Error('Observation body length mismatch');
  const preparation = { ...input, bodies };
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  // Recheck the complete immutable declaration before any independently durable file or row effect.
  if (!isDeepStrictEqual(prepareControlWorkObservation(owner, preparation), input))
    throw new Error('Observation body declaration mismatch');
  return publishControlWorkObservationBodies(db, preparation);
}

/** Builds the known live DTO while retained descriptive rows remain unchanged on replay. */
function controlObservationCandidate(
  input: ControlWorkObservationInput,
  existing: WorkObservationRecord | undefined,
  sequence: number,
  owner: ControlProductOwner
): WorkObservationRecord {
  const required = (input.observation as unknown as Record<string, unknown>).requiredFeatures;
  if (required !== undefined && (!Array.isArray(required) || required.length !== 0))
    throw new Error('recovery_required: unsupported required observation semantics');
  const draft = draftSchema.parse(input.observation);
  if (
    draft.type === 'content.published' ||
    draft.refs?.some((ref) => ref.edge !== 'association') ||
    'bodies' in draft.payload
  )
    throw new Error('Publication descriptors belong to the observation writer');
  const payload =
    draft.type === 'model.observed' && (input.bodies.length || existing?.payload.bodies)
      ? {
          ...draft.payload,
          bodies: input.bodies.length
            ? input.bodies.map((body) => ({ ...body, state: 'expected' }))
            : existing?.payload.bodies,
        }
      : draft.payload;
  const candidate = parseWorkObservationRecord({
    ...draft,
    payload,
    v: 1,
    seq: sequence,
    turnId: input.turnId,
  });
  assertControlBodyDescriptors(owner, input, candidate, input.bodies);
  if (existing && !isDeepStrictEqual(existing, candidate))
    throw new Error('recovery_required: observation identity conflict');
  return candidate;
}

/** Checks only independently committed evidence metadata; file synchronization belongs to the existing body publisher. */
function assertControlBodyPublished(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: ControlWorkObservationInput,
  body: WorkObservationBodyDescriptor
): void {
  const row = sqlite
    .prepare('SELECT * FROM evidence_bundles WHERE evidence_bundle_id=?')
    .get(body.bundleId) as
    | {
        schema_version: number;
        workspace_id: string | null;
        thread_id: string | null;
        turn_id: string | null;
        source_kind: string;
        created_at: string;
        content_digests_json: string;
        required_features_json: string;
        raw_evidence_refs_json: string;
        import_status: string;
        retention_class: string;
        sensitivity_class: string;
      }
    | undefined;
  if (
    !row ||
    row.schema_version !== 1 ||
    row.workspace_id !== (owner.kind === 'server' ? null : owner.workspaceId) ||
    row.thread_id !== input.threadId ||
    row.turn_id !== input.turnId ||
    row.source_kind !== 'work-observation-body' ||
    row.created_at !== input.observation.ts ||
    row.import_status !== 'promoted' ||
    row.retention_class !== 'restricted-raw' ||
    row.sensitivity_class !== 'restricted' ||
    !isDeepStrictEqual(JSON.parse(row.content_digests_json), [body.sha256]) ||
    !isDeepStrictEqual(JSON.parse(row.raw_evidence_refs_json), [
      { kind: 'work-observation-body', ref: 'raw/content' },
    ])
  )
    throw new Error('recovery_required: observation body lacks independent publication');
  z.array(z.literal('openkit.work-observations.v1')).parse(JSON.parse(row.required_features_json));
}

type ObservationBinding = ReturnType<typeof readControlWorkObservationTurnBinding>;
type ObservationCutoff = z.infer<typeof ObservationCutoffSchema>;
type ObservationCounter = z.infer<typeof ObservationCounterSchema>;

/** Rebuild ordinary charges from rows without losing the independent raw-file reservation. */
function readObservationCollection(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  binding: ObservationBinding,
  input: { threadId: string; turnId: string },
  sequence: number
): { counter: ObservationCounter; cutoff: ObservationCutoff | undefined } {
  const retained = binding.turn.observationCounter;
  if (retained?.sequence === sequence && retained.budget)
    return { counter: retained, cutoff: undefined };
  const folded = foldObservationPrefix(sqlite, owner, input);
  return {
    cutoff: folded.cutoff,
    counter: { ...folded.counter, rawProvenance: retained?.rawProvenance },
  };
}

/** The Workspace FIFO durably admits the exact raw provenance family before private file growth. */
export function reserveWorkObservationProvenance(
  db: WorkspaceDb,
  input: { threadId: string; turnId: string },
  raw: NonNullable<ObservationCounter['rawProvenance']>,
  verifiedRetainedFamily: boolean
): z.infer<typeof ObservationOmissionResultSchema> | undefined {
  const { sqlite } = db;
  if (
    sqlite.inTransaction ||
    sqlite.readonly ||
    sqlite.pragma('synchronous', { simple: true }) !== 2
  )
    throw new Error('Raw observation admission requires the independent FULL Workspace writer.');
  const owner = { kind: 'workspace', workspaceId: db.workspaceId } as const;
  return sqlite
    .transaction(() => {
      const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
      if (!binding.coverage) throw new Error('recovery_required: missing capture coverage');
      const existing = binding.turn.observationCounter?.rawProvenance;
      if (existing) {
        if (!isDeepStrictEqual(existing, raw))
          throw new OperationError('conflict', 'Runtime provenance replay conflict.', 409);
        return;
      }
      // The retained census already counts the verified B originals before or after
      // their SQL receipt. Exact replay keeps that charge after an unrelated cutoff.
      if (verifiedRetainedFamily) return;
      const cutoff = binding.turn.observationCutoff;
      if (cutoff) {
        if (cutoff.observationId !== raw.id || cutoff.workerSequence !== undefined)
          return { disposition: 'closed', truncation: cutoff.summary } as const;
        if (cutoff.digest !== raw.digest)
          throw new OperationError('conflict', 'Runtime provenance replay conflict.', 409);
        return { disposition: 'truncated', truncation: cutoff.summary } as const;
      }
      const tail = sqlite
        .prepare(
          'SELECT COALESCE(MAX(sequence),0) AS sequence FROM control_work_observations WHERE turn_id=?'
        )
        .get(input.turnId) as { sequence: number };
      const previous = readObservationCollection(sqlite, owner, binding, input, tail.sequence);
      const budget = previous.counter.budget ?? EMPTY_OBSERVATION_BUDGET;
      const reason = observationBudgetLimit({ ...budget, bodyBytes: budget.bodyBytes + raw.bytes });
      if (previous.cutoff || reason) {
        // An already published terminal snapshot cannot acquire a new cutoff.
        if (
          readControlWorkObservation(sqlite, owner, { ...input, id: `turn.reap:${input.turnId}` })
        )
          return { disposition: 'closed', truncation: null } as const;
        const summary = previous.cutoff?.summary ?? omission(previous.counter.intake + 1, reason);
        updateObservationManifest(sqlite, binding, {
          cutoff: previous.cutoff ?? {
            observationId: raw.id,
            digest: raw.digest,
            retainedSequence: tail.sequence,
            summary,
          },
        });
        return {
          disposition: previous.cutoff ? 'closed' : 'truncated',
          truncation: summary,
        } as const;
      }
      updateObservationManifest(sqlite, binding, {
        counter: { ...previous.counter, rawProvenance: raw },
      });
    })
    .immediate();
}

/** Only this owner changes collection state. The private fields survive ordinary Turn replacement. */
function updateObservationManifest(
  sqlite: Database.Database,
  binding: ObservationBinding,
  state: { cutoff?: ObservationCutoff; counter?: ObservationCounter; truncated?: boolean }
): void {
  const features = new Set(binding.turn.requiredFeatures ?? []);
  features.add('openkit.work-observations.v1');
  if (state.cutoff || state.truncated) features.add(WORK_OBSERVATION_TRUNCATION_FEATURE);
  const fields = {
    requiredFeatures: [...features],
    ...(state.cutoff ? { observationCutoff: state.cutoff } : {}),
    ...(state.counter ? { observationCounter: state.counter } : {}),
  };
  const patch = JSON.stringify(fields);
  const changed = sqlite
    .prepare(
      `UPDATE control_turns SET
       revision=revision+?, record_json=json_patch(record_json, ?)
       WHERE id=? AND revision=?
       AND length(CAST(json_patch(record_json, ?) AS BLOB)) <= ${65_536 + TURN_OBSERVATION_CONTROL_BYTES}`
    )
    .run(
      features.size === (binding.turn.requiredFeatures?.length ?? 0) ? 0 : 1,
      patch,
      binding.turn.id,
      binding.revision,
      patch
    );
  if (changed.changes !== 1)
    throw new Error('recovery_required: observation Turn revision conflict');
}

function observationDigest(record: WorkObservationRecord): string {
  const { seq: _seq, ...meaning } = record;
  return createHash('sha256').update(canonicalJsonText(meaning)).digest('hex');
}

function foldObservationPrefix(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string },
  retainedSequence?: number
) {
  const calls = new Map<
    string,
    NonNullable<NonNullable<ReturnType<typeof reapCallChange>>['call']>
  >();
  let sequence = 0;
  let intake = 0;
  let callBytes = 0;
  let budget = EMPTY_OBSERVATION_BUDGET;
  let lastObservedTs: string | null = null;
  let cutoff: ObservationCutoff | undefined;
  for (;;) {
    const rows = readControlObservationPage(sqlite, owner, { ...input, afterSequence: sequence });
    for (const { record: row, bytes } of rows) {
      if (retainedSequence !== undefined && row.seq > retainedSequence)
        return {
          calls,
          lastObservedTs,
          cutoff,
          counter: { sequence, intake, callBytes, callCount: calls.size, budget },
        };
      if (row.type === 'turn.reap') {
        sequence = row.seq;
        continue;
      }
      const ordinary = !isObservationCompanion(row);
      if (ordinary) intake += 1;
      if (cutoff) {
        if (ordinary)
          cutoff.summary = {
            ...cutoff.summary,
            omittedCount: cutoff.summary.omittedCount + 1,
            lastOmittedSequence: intake,
          };
        sequence = row.seq;
        continue;
      }
      const change = reapCallChange(row);
      const previous = change ? calls.get(change.key) : undefined;
      const next = change ? mergeReapCall(previous, change.call) : null;
      const prospectiveBytes =
        callBytes - serializedCallBytes(previous) + serializedCallBytes(next);
      const prospectiveCount = calls.size - Number(previous !== undefined) + Number(next !== null);
      if (ordinary) budget = chargeObservation(budget, row, bytes, owner);
      const reason =
        ordinary &&
        (!fitsReap(input.turnId, row.ts, prospectiveBytes, prospectiveCount)
          ? 'unresolved-call-bytes'
          : observationBudgetLimit(budget));
      if (reason) {
        cutoff = {
          observationId: row.id,
          digest: observationDigest(row),
          retainedSequence: sequence,
          summary: omission(intake, reason),
        };
      } else {
        if (change) {
          if (next) calls.set(change.key, next);
          else calls.delete(change.key);
          callBytes = prospectiveBytes;
        }
        lastObservedTs = row.ts;
      }
      sequence = row.seq;
    }
    if (rows.length < 128)
      return {
        calls,
        lastObservedTs,
        cutoff,
        counter: { sequence, intake, callBytes, callCount: calls.size, budget },
      };
  }
}

/** Reconstruct only the affected call for a valid counter. Model responses bind their request ID. */
function updateObservationCounter(
  sqlite: Database.Database,
  candidate: WorkObservationRecord,
  counter: ObservationCounter
): ObservationCounter {
  const change = reapCallChange(candidate);
  if (!change) return { ...counter, intake: counter.intake + 1 };
  if (candidate.payload.direction === 'request')
    return {
      ...counter,
      intake: counter.intake + 1,
      callBytes: counter.callBytes + serializedCallBytes(change.call),
      callCount: counter.callCount + 1,
    };
  const model = candidate.type === 'model.observed';
  const rows = sqlite
    .prepare(
      model
        ? `SELECT * FROM control_work_observations WHERE turn_id=?
          AND (id=? OR json_extract(record_json, '$.parent')=?) ORDER BY sequence`
        : `SELECT * FROM control_work_observations WHERE turn_id=?
          AND json_extract(record_json, '$.type')='runtime.observed'
          AND coalesce(json_extract(record_json, '$.corr'), json_extract(record_json, '$.payload.fact.callRef'))=?
          ORDER BY sequence`
    )
    .iterate(
      ...(model
        ? [candidate.turnId, candidate.parent ?? candidate.id, candidate.parent ?? candidate.id]
        : [candidate.turnId, change.correlation])
    ) as Iterable<ControlObservationRow>;
  let previous: typeof change.call | undefined;
  for (const row of rows) {
    const earlier = reapCallChange(decodeControlObservation(row, candidate.turnId));
    if (earlier?.key === change.key) previous = mergeReapCall(previous ?? undefined, earlier.call);
  }
  const next = mergeReapCall(previous ?? undefined, change.call);
  return {
    ...counter,
    intake: counter.intake + 1,
    callBytes: counter.callBytes - serializedCallBytes(previous) + serializedCallBytes(next),
    callCount: counter.callCount - Number(!!previous) + Number(!!next),
  };
}

/** Applies native metadata/order and optional publication in the caller's existing savepoint, without filesystem effects or COMMIT. */
export function applyControlWorkObservation(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  value: ControlWorkObservationInput,
  terminalReap = false,
  retainedProvenanceBytes = 0
): ControlWorkObservationResult {
  if (!sqlite.inTransaction || sqlite.readonly)
    throw new Error('Native observations require the owning SQL transaction');
  const parsed = ControlWorkObservationInputSchema.parse(value);
  let observation = parsed.observation as unknown as WorkObservationDraft;
  if (
    observation.type === 'model.capture-gap' &&
    observation.parent &&
    !Object.hasOwn(observation, 'requiredFeatures')
  ) {
    const content = payloadSchemas['model.capture-gap'].parse(observation.payload).content;
    const parent = readControlWorkObservation(sqlite, owner, {
      ...parsed,
      id: observation.parent,
    });
    if (
      parent &&
      hasReservedModelBody(parent) &&
      observation.id === `${parent.id}:gap:${content.reason}`
    ) {
      if (!admitsReservedModelGap(parent, observation))
        throw new Error('recovery_required: reserved model gap lineage mismatch');
      if (!readControlWorkObservation(sqlite, owner, { ...parsed, id: observation.id }))
        observation = reservedModelGap(parent, content.reason);
    }
  }
  const input: ControlWorkObservationInput = { ...parsed, observation };
  const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
  if (!binding.coverage) throw new Error('recovery_required: missing capture coverage');
  if (input.bodies.length && binding.coverage.value !== 'on')
    throw new Error('Capture coverage is off');
  const existing = readControlWorkObservation(
    sqlite,
    owner,
    { ...input, id: input.observation.id },
    input
  );
  const tail = sqlite
    .prepare(
      'SELECT MAX(sequence) AS last, COUNT(*) AS count FROM control_work_observations WHERE turn_id=?'
    )
    .get(input.turnId) as { last: number | null; count: number };
  if ((tail.last ?? 0) !== tail.count || !Number.isSafeInteger(tail.count + 2))
    throw new Error('recovery_required: corrupt native observation sequence');
  if (tail.count > 0) assertControlObservationManifest(binding);
  const candidate = controlObservationCandidate(
    input,
    existing,
    existing?.seq ?? tail.count + 1,
    owner
  );
  assertControlObservationLineage(sqlite, owner, input, candidate);
  if (
    !existing &&
    binding.coverage.value !== 'on' &&
    candidate.type === 'runtime.observed' &&
    WorkerObservationDataSchema.parse(candidate.payload).content.state === 'expected'
  )
    throw new Error('Capture coverage is off');
  // The exact stored envelope includes the private Worker position.
  const candidateText = JSON.stringify(
    input.workerSequence === undefined
      ? candidate
      : { ...candidate, workerSequence: input.workerSequence }
  );
  const candidateBytes = Buffer.byteLength(candidateText);
  if (!existing && candidateBytes > NATIVE_OBSERVATION_BYTES)
    throw new Error('Observation metadata exceeds the native bound');
  if (
    candidate.type === 'turn.reap' &&
    (['pending', 'running'].includes(binding.turn.status) ||
      !binding.turn.completedAt ||
      candidate.ts !== binding.turn.completedAt ||
      candidate.id !== `turn.reap:${input.turnId}`)
  )
    throw new Error('turn.reap requires the native terminal Turn in the same transition');
  const priorCompanion = readControlWorkObservation(sqlite, owner, {
    ...input,
    id: `${candidate.id}:publication`,
  });
  const prior = priorCompanion?.type === 'content.published' ? priorCompanion : undefined;
  let publication = prior ?? null;
  if (
    priorCompanion &&
    (priorCompanion.parent !== candidate.id ||
      (!prior && (priorCompanion.type !== 'model.capture-gap' || input.publishBodies)) ||
      (prior && input.bodies.length > 0 && !isDeepStrictEqual(prior.payload.bodies, input.bodies)))
  )
    throw new Error('recovery_required: observation publication conflict');
  let counter: ObservationCounter | undefined;
  if (!existing) {
    const cutoff = binding.turn.observationCutoff;
    if (candidate.type === 'turn.reap') {
      if (!terminalReap && (candidate.payload.truncation !== undefined || cutoff))
        throw new Error('Observation truncation belongs to the terminal writer');
    } else if (candidate.type === 'model.capture-gap' && isObservationCompanion(candidate)) {
      // The parent already paid for this exact closeout slot.
      if (binding.turn.observationCounter?.sequence === tail.count)
        counter = binding.turn.observationCounter;
    } else if (cutoff) {
      if (cutoff.observationId !== candidate.id || cutoff.workerSequence !== input.workerSequence)
        return { disposition: 'closed', truncation: cutoff.summary };
      if (cutoff.digest !== observationDigest(candidate))
        throw new Error('recovery_required: observation cutoff identity conflict');
      return { disposition: 'truncated', truncation: cutoff.summary };
    } else {
      const previous = readObservationCollection(sqlite, owner, binding, input, tail.count);
      counter = previous.counter;
      const priorBudget = counter.budget ?? EMPTY_OBSERVATION_BUDGET;
      const budget = previous.cutoff
        ? priorBudget
        : chargeObservation(priorBudget, candidate, candidateBytes, owner);
      if (!previous.cutoff) counter = updateObservationCounter(sqlite, candidate, counter);
      const reason = !fitsReap(input.turnId, candidate.ts, counter.callBytes, counter.callCount)
        ? 'unresolved-call-bytes'
        : observationBudgetLimit({
            ...budget,
            bodyBytes: budget.bodyBytes + (counter.rawProvenance?.bytes ?? retainedProvenanceBytes),
          });
      counter = { ...counter, budget };
      if (previous.cutoff || reason) {
        const historicalReap = readControlWorkObservation(sqlite, owner, {
          ...input,
          id: `turn.reap:${input.turnId}`,
        });
        const summary = previous.cutoff?.summary ?? omission(counter.intake, reason);
        if (historicalReap) return { disposition: 'closed', truncation: null };
        const seal = previous.cutoff ?? {
          observationId: candidate.id,
          ...(input.workerSequence !== undefined ? { workerSequence: input.workerSequence } : {}),
          digest: observationDigest(candidate),
          retainedSequence: tail.count,
          summary,
        };
        updateObservationManifest(sqlite, binding, { cutoff: seal });
        return { disposition: previous.cutoff ? 'closed' : 'truncated', truncation: summary };
      }
    }
  }
  if (input.publishBodies && input.bodies.length) {
    publication = parseWorkObservationRecord({
      v: 1,
      id: `${candidate.id}:publication`,
      type: 'content.published',
      turnId: input.turnId,
      seq: prior?.seq ?? tail.count + (existing ? 1 : 2),
      ts: candidate.ts,
      obs: candidate.obs,
      parent: candidate.id,
      ret: 'turn-evidence',
      refs: controlBodyReferences(owner, input.bodies),
      payload: { bodies: input.bodies },
    });
    if (prior && !isDeepStrictEqual(prior, publication))
      throw new Error('recovery_required: observation publication conflict');
    if (!prior)
      for (const body of input.bodies) assertControlBodyPublished(sqlite, owner, input, body);
  }
  // The caller's savepoint rolls back the manifest and both rows on any bound or SQL failure.
  const insert = (record: WorkObservationRecord, text: string): void => {
    if (Buffer.byteLength(text) > NATIVE_OBSERVATION_BYTES)
      throw new Error('Observation metadata exceeds the native bound');
    // Refuse an unknown required declaration even when the known-field parser would strip it.
    decodeControlObservation(
      {
        turn_id: input.turnId,
        id: record.id,
        sequence: record.seq,
        schema_version: 1,
        record_json: text,
      },
      input.turnId
    );
    sqlite
      .prepare(
        'INSERT INTO control_work_observations (turn_id,sequence,id,schema_version,record_json) VALUES (?,?,?,1,?)'
      )
      .run(input.turnId, record.seq, record.id, text);
  };
  const truncated = candidate.type === 'turn.reap' && candidate.payload.truncation !== undefined;
  if (!counter && publication && !prior && binding.turn.observationCounter?.sequence === tail.count)
    counter = binding.turn.observationCounter;
  if (
    counter ||
    truncated ||
    !binding.turn.requiredFeatures?.includes('openkit.work-observations.v1')
  )
    updateObservationManifest(sqlite, binding, {
      ...(counter ? { counter: { ...counter, sequence: publication?.seq ?? candidate.seq } } : {}),
      truncated,
    });
  if (!existing) insert(candidate, candidateText);
  if (publication && !prior) insert(publication, JSON.stringify(publication));
  return { disposition: existing ? 'duplicate' : 'committed', observation: candidate, publication };
}

/** Terminal snapshot arguments; product terminality and physical exclusion remain separate owners. */
export interface ControlTurnReapInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly reason: string;
  readonly inferredBy: string;
}

/** Prepares ordinary terminal evidence from native authority, preserving the first snapshot despite late observations. */
export function prepareControlTurnReap(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: ControlTurnReapInput
): ControlWorkObservationInput | null {
  if (!sqlite.inTransaction)
    throw new Error('Native reap preparation requires the owning SQL transaction');
  z.string().min(1).parse(input.reason);
  z.string().min(1).parse(input.inferredBy);
  const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
  if (!binding.coverage) {
    if (
      binding.turn.requiredFeatures?.includes('openkit.work-observations.v1') ||
      sqlite
        .prepare('SELECT 1 FROM control_work_observations WHERE turn_id=? LIMIT 1')
        .get(input.turnId)
    )
      throw new Error('recovery_required: missing capture coverage for native observations');
    return null;
  }
  if (['pending', 'running'].includes(binding.turn.status) || !binding.turn.completedAt)
    throw new Error('turn.reap requires the native terminal Turn in the same transition');
  const id = `turn.reap:${input.turnId}`;
  const existing = readControlWorkObservation(sqlite, owner, { ...input, id });
  if (existing) {
    if (existing.type !== 'turn.reap')
      throw new Error('recovery_required: turn.reap identity conflict');
    return { threadId: input.threadId, turnId: input.turnId, observation: existing, bodies: [] };
  }
  const cutoff = binding.turn.observationCutoff;
  const prefix = foldObservationPrefix(sqlite, owner, input, cutoff?.retainedSequence);
  const truncation = cutoff?.summary ?? prefix.cutoff?.summary;
  if (
    cutoff &&
    (prefix.cutoff || cutoff.summary.firstOmittedSequence !== prefix.counter.intake + 1)
  )
    throw new Error('recovery_required: inconsistent native observation cutoff boundary');
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    bodies: [],
    observation: {
      id,
      type: 'turn.reap',
      ts: binding.turn.completedAt,
      obs: 'nanocore',
      ret: 'turn-evidence',
      payload: {
        reason: input.reason,
        lastObservedTs: prefix.lastObservedTs,
        unresolvedCalls: [...prefix.calls.values()],
        inferredBy: input.inferredBy,
        ...(truncation ? { truncation } : {}),
      },
    },
  };
}

/** Appends ordinary reap metadata inside the same terminal savepoint; never commits or performs restart-only repair. */
export function applyControlTurnReap(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: ControlTurnReapInput
): WorkObservationRecord | null {
  if (!sqlite.inTransaction || sqlite.readonly)
    throw new Error('Native observations require the owning SQL transaction');
  const prepared = prepareControlTurnReap(sqlite, owner, input);
  return prepared
    ? requireRetainedObservation(applyControlWorkObservation(sqlite, owner, prepared, true))
        .observation
    : null;
}

/** Fixed adapter tool vocabulary permitted in ordinary timeline labels. */
const timelineToolNames = new Set([
  'exec_command',
  'write_stdin',
  'apply_patch',
  'read_file',
  'write_file',
  'shell',
  'bash',
  'read',
  'write',
  'edit',
  'spawn_agent',
  'send_input',
  'wait',
  'close_agent',
  'web_search',
]);

/** Omits suspect outward text rather than exposing redaction remnants, private paths or native identifiers. */
function isSafeTimelineText(text: string): boolean {
  return (
    redactInternalAgentText(text) === text &&
    [...text].every((character) => character.charCodeAt(0) >= 32 || '\t\n\r'.includes(character)) &&
    !/\b(?:okt_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b|(?:^|[\s"'])(?:\/[A-Za-z_.-][^\s]*|[A-Za-z]:\\)|native[_-]?(?:thread|session|turn)[_-]?id/i.test(
      text
    )
  );
}

/** Projects structural observations and ordinary Item text after the caller checks current Thread authority. */
export function readThreadRuntimeActivity(
  workspaceDb: WorkspaceDb,
  input: {
    readonly threadId: string;
    readonly turnIds: readonly string[];
  }
): readonly ThreadRuntimeActivity[] {
  return input.turnIds.map((turnId): ThreadRuntimeActivity => {
    let contentCapture: ThreadRuntimeActivity['contentCapture'] = 'unknown';
    let coverage: ThreadRuntimeActivity['coverage'] = 'unavailable';
    const entries: ThreadRuntimeActivity['entries'][number][] = [];
    try {
      const binding = readWorkObservationTurnBinding(workspaceDb, {
        threadId: input.threadId,
        turnId,
      });
      contentCapture = binding.coverage?.value ?? 'unknown';
      const rows = readWorkObservations(workspaceDb, { threadId: input.threadId, turnId });
      const runtime = rows.filter((row) => row.type === 'runtime.observed');
      const children = new Map<string, number>();
      for (const row of runtime) {
        const { fact } = WorkerObservationDataSchema.parse(row.payload);
        if (
          fact.kind === 'origin' &&
          fact.parentRuntimeOriginRef &&
          fact.runtimeOriginRef &&
          !children.has(fact.runtimeOriginRef)
        )
          children.set(fact.runtimeOriginRef, children.size + 1);
      }
      let partial = false;
      let unavailable = runtime.length === 0;
      let nativeCollected = false;
      const displayedChildren = new Set<string>();
      for (const row of runtime) {
        const { fact, content } = WorkerObservationDataSchema.parse(row.payload);
        const native = fact.kind === 'native-transcript' || fact.kind === 'runtime-log';
        if (native && content.state !== 'expected') {
          unavailable = true;
          continue;
        }
        if (fact.kind === 'coverage') {
          if (fact.coverage === 'unsupported' || fact.coverage === 'unavailable')
            unavailable = true;
          if (fact.coverage === 'ended' || fact.reason) partial = true;
          continue;
        }
        const publication = rows.find(
          (candidate) => candidate.type === 'content.published' && candidate.parent === row.id
        );
        if (content.state === 'unavailable' || (content.state === 'expected' && !publication))
          partial = true;
        if (native) {
          // Native bytes establish collection evidence, never Worker execution progress.
          nativeCollected ||= publication !== undefined;
          if (
            fact.coverage === 'off' ||
            fact.coverage === 'unavailable' ||
            fact.coverage === 'unsupported'
          )
            unavailable = true;
          if (fact.coverage === 'ended' || fact.reason) partial = true;
          continue;
        }
        const ordinal = fact.runtimeOriginRef ? children.get(fact.runtimeOriginRef) : undefined;
        const subject = ordinal ? `Child ${ordinal}` : 'Worker';
        const phase = fact.phase ?? 'observed';
        const failed = ['failed', 'interrupted', 'unknown'].includes(phase);
        const completed = phase === 'completed' || phase === 'closed';
        const started =
          fact.kind === 'origin' &&
          ordinal !== undefined &&
          fact.runtimeOriginRef !== null &&
          !displayedChildren.has(fact.runtimeOriginRef) &&
          ['started', 'observed'].includes(phase);
        if (started && fact.runtimeOriginRef) displayedChildren.add(fact.runtimeOriginRef);
        const kind = failed
          ? 'failure'
          : completed
            ? 'result'
            : started
              ? 'child-started'
              : 'progress';
        const safeTool =
          fact.toolName && timelineToolNames.has(fact.toolName) ? fact.toolName : 'tool';
        const label =
          fact.kind === 'tool'
            ? `${subject}: ${safeTool} ${phase}${fact.exitCode !== undefined ? ` (exit ${fact.exitCode})` : ''}`
            : fact.kind === 'assistant'
              ? `${subject}: response ${phase}`
              : `${subject} ${phase}`;
        entries.push({
          sequence: row.seq,
          observedAt: row.ts,
          kind,
          label,
          textTruncated: false,
        });
      }
      // Ordinary Item availability must not improve collector coverage.
      coverage =
        unavailable && entries.length === 0 && !nativeCollected
          ? 'unavailable'
          : partial || unavailable
            ? 'partial'
            : 'collecting';
    } catch {
      // Observation failure stays local; the independent ordinary Item source can still be read.
      entries.length = 0;
    }
    try {
      const published = readNativeTurnHistory(
        nativeProductScope(workspaceDb.dataRoot, {
          kind: 'workspace',
          workspaceId: workspaceDb.workspaceId,
        }),
        turnId
      );
      if (published && published.turn.threadId !== input.threadId)
        throw new Error('Runtime activity Turn belongs to another Thread.');
      const reply = published?.turn.items.findLast(
        (item) =>
          item.type === 'assistant-message' && item.text.length > 0 && isSafeTimelineText(item.text)
      );
      if (reply?.type === 'assistant-message') {
        // This is a display ordinal, not a native message association or completion claim.
        entries.push({
          sequence: (entries.at(-1)?.sequence ?? 0) + 1,
          observedAt: reply.createdAt,
          kind: 'progress',
          label: 'Turn reply',
          text: reply.text.slice(0, THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS),
          textTruncated: reply.text.length > THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS,
        });
      }
    } catch {
      // Unproved canonical Items omit the excerpt; restricted evidence is never a fallback.
    }
    const limit = THREAD_RUNTIME_ACTIVITY_MAX_ENTRIES;
    return {
      turnId,
      contentCapture,
      coverage,
      entries: entries.slice(-limit),
      omittedEntryCount: Math.max(0, entries.length - limit),
    };
  });
}
