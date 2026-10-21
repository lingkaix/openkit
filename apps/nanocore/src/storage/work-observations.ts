import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
} from 'node:fs';
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
  ReasoningEffortSchema,
  readRetainedV1,
  SystemPromptDigestSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { retainWorkObservationBody, workObservationBodyBundleId } from '../evidence-bundles.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { ControlProductOwner } from './control-store-products.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { StoredThreadSnapshotV1Schema } from './retained-work-events-v1.js';
import { StoredTurnV1Schema, StoredWorkOwnerV1Schema } from './retained-work-metadata-v1.js';
import { readServerTurnRecord } from './server-thread-records.js';
import {
  appendCanonicalTextFile,
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  CaptureCoverageBindingSchema,
  preserveDescriptiveRecord,
  readCanonicalFile,
  readCanonicalTextFile,
  readPublishedTurnFileRecords,
  syncCanonicalDirectory,
  TurnReaderSchema,
  writeFileAtomic,
} from './workspace-file-records.js';

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
// Only retained version-1 data accepts historical observer names; live drafts stay canonical-only.
const recordSchema = draftSchema.extend({
  obs: z.preprocess(
    (value) =>
      value === 'core'
        ? 'nanocore'
        : value === 'gateway'
          ? 'llm-gateway'
          : value === 'sidecar'
            ? 'worker-shim'
            : value,
    draftSchema.shape.obs
  ),
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
  if (
    (row.type.startsWith('model.') && row.obs !== 'llm-gateway') ||
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
  for (const id of [
    ...(workspaceDb.scope === 'workspace' ? [workspaceDb.workspaceId] : []),
    input.threadId,
    input.turnId,
  ])
    assertSafeWorkspacePathSegment(id, 'Observation owner');
  if (workspaceDb.scope === 'core') {
    let root = workspaceDb.dataRoot;
    for (const part of ['server', 'threads', input.threadId, 'turns', input.turnId]) {
      root = join(root, part);
      assertCanonicalDirectory(root);
    }
    const turn = readServerTurnRecord(workspaceDb.dataRoot, input.threadId, input.turnId);
    const raw = readRetainedV1(
      JSON.parse(readCanonicalTextFile(join(root, 'turn.json'))),
      (record) => record as Record<string, unknown>
    );
    return { root, turn, raw, coverage: turn.captureCoverage ?? null };
  }
  let root = workspaceDb.dataRoot;
  for (const part of ['workspaces', workspaceDb.workspaceId, 'threads', input.threadId]) {
    root = join(root, part);
    assertCanonicalDirectory(root);
  }
  const thread = StoredThreadSnapshotV1Schema.parse(
    JSON.parse(readCanonicalTextFile(join(root, 'thread.json')))
  );
  if (thread.id !== input.threadId || workspaceIdForOwner(thread.owner) !== workspaceDb.workspaceId)
    throw new Error('recovery_required: observation Thread lineage mismatch');
  for (const part of ['turns', input.turnId]) {
    root = join(root, part);
    assertCanonicalDirectory(root);
  }
  const raw = readRetainedV1(
    JSON.parse(readCanonicalTextFile(join(root, 'turn.json'))),
    (record) => record as Record<string, unknown>
  );
  const metadata = StoredTurnV1Schema.parse(raw);
  const turn = TurnReaderSchema.parse({ ...metadata, items: [] });
  if (
    turn.id !== input.turnId ||
    turn.threadId !== input.threadId ||
    workspaceIdForOwner(turn.owner) !== workspaceDb.workspaceId
  )
    throw new Error('recovery_required: observation Turn lineage mismatch');
  return {
    root,
    turn,
    raw,
    coverage:
      raw.captureCoverage === undefined
        ? null
        : CaptureCoverageBindingSchema.parse(raw.captureCoverage),
  };
}

/** Reads committed LF-terminated rows only; malformed interior data fails closed. */
export function readWorkObservations(
  workspaceDb: WorkspaceDb | CoreDb,
  input: { readonly threadId: string; readonly turnId: string }
): readonly WorkObservationRecord[] {
  const { root, raw } = readWorkObservationTurnBinding(workspaceDb, input);
  const path = join(root, 'observations.jsonl');
  if (
    existsSync(path) &&
    !z
      .array(z.string())
      .parse(raw.requiredFeatures ?? [])
      .includes('openkit.work-observations.v1')
  )
    throw new Error('recovery_required: missing observation manifest feature');
  return readRows(path, input.turnId).rows;
}

/** Commits exact admitted bodies through evidence, then the single observation publication marker. */
export function appendWorkObservation(
  workspaceDb: WorkspaceDb | CoreDb,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly observation: WorkObservationDraft;
    readonly bodies: readonly AdmittedWorkBody[];
    /** Records expected byte identity without writing content pending semantic-unit admission. */
    readonly deferBodyPublication?: true;
  }
): {
  readonly disposition: 'committed' | 'duplicate';
  readonly observation: WorkObservationRecord;
} {
  const binding = readWorkObservationTurnBinding(workspaceDb, input);
  if (!binding.coverage) throw new Error('recovery_required: missing capture coverage');
  const draft = draftSchema.parse(input.observation);
  if (
    draft.type === 'env.bound' &&
    (workspaceDb.scope === 'core'
      ? draft.payload.workspaceId !== undefined ||
        (draft.payload.owner as { kind?: string } | undefined)?.kind !== 'server'
      : draft.payload.workspaceId !== workspaceDb.workspaceId || draft.payload.owner !== undefined)
  )
    throw new Error('Environment binding database owner mismatch.');
  if (draft.refs?.some((ref) => ref.edge !== 'association') || 'bodies' in draft.payload)
    throw new Error('Publication descriptors belong to the observation writer');
  if (input.bodies.length && binding.coverage.value !== 'on')
    throw new Error('Capture coverage is off');
  if (input.bodies.length && draft.type !== 'model.observed' && draft.type !== 'runtime.observed')
    throw new Error('This observation type has no admitted body');
  if (
    input.bodies.length &&
    (draft.payload.content as { state?: string } | undefined)?.state !== 'expected'
  )
    throw new Error('Body requires an expected-content declaration');
  const bodyIds = new Set<string>();
  const descriptors = input.bodies.map((body) => {
    if (
      !body.id ||
      bodyIds.has(body.id) ||
      !body.mediaType ||
      !body.boundary ||
      !(body.bytes instanceof Uint8Array) ||
      body.bytes.byteLength > 16 * 1024 * 1024
    )
      throw new Error('Invalid or duplicate admitted body');
    bodyIds.add(body.id);
    return {
      id: body.id,
      bytes: body.bytes.byteLength,
      mediaType: body.mediaType,
      boundary: body.boundary,
      sha256: createHash('sha256').update(body.bytes).digest('hex'),
      bundleId: workObservationBodyBundleId(
        workspaceDb.scope === 'core' ? { kind: 'server' } : workspaceDb.workspaceId,
        input.threadId,
        input.turnId,
        draft.id,
        body.id
      ),
    };
  });
  const refs: WorkObservationReference[] = descriptors.map((body) => ({
    kind: 'evidence-bundle',
    scope: {
      ...(workspaceDb.scope === 'core'
        ? { owner: 'server' }
        : { workspaceId: workspaceDb.workspaceId }),
      pathClass: 'backend',
    },
    locator: body.bundleId,
    digest: body.sha256,
    edge: 'publication' as const,
  }));
  const path = join(binding.root, 'observations.jsonl');
  const state = readAppendState(workspaceDb, path, input.turnId);
  const { committedBytes, totalBytes } = state;
  const existing = state.records.get(draft.id);
  const candidate = parseWorkObservationRecord({
    ...draft,
    payload:
      descriptors.length && draft.type !== 'runtime.observed'
        ? {
            ...draft.payload,
            bodies: descriptors.map((body) => ({ ...body, state: 'expected' as const })),
          }
        : existing?.payload.bodies && draft.type === 'model.observed'
          ? { ...draft.payload, bodies: existing.payload.bodies }
          : draft.payload,
    v: 1,
    seq: existing?.seq ?? state.records.size + 1,
    turnId: input.turnId,
  });
  if (draft.type === 'runtime.observed' && descriptors.length) {
    const expected = WorkerObservationDataSchema.parse(draft.payload).content;
    const body = descriptors[0];
    if (
      expected.state !== 'expected' ||
      descriptors.length !== 1 ||
      !body ||
      body.bytes !== expected.bytes ||
      `sha256:${body.sha256}` !== expected.sha256 ||
      body.boundary !== expected.boundary ||
      body.mediaType !== expected.mediaType
    )
      throw new Error('Runtime body contradicts its expected declaration');
  }
  if (existing && !isDeepStrictEqual(existing, candidate))
    throw new Error('recovery_required: observation identity conflict');
  const requiredFeatures = z.array(z.string()).parse(binding.raw.requiredFeatures ?? []);
  if (!requiredFeatures.includes('openkit.work-observations.v1')) {
    writeFileAtomic(
      join(binding.root, 'turn.json'),
      `${JSON.stringify(writeRetainedV1({ ...binding.raw, requiredFeatures: [...requiredFeatures, 'openkit.work-observations.v1'] }), null, 2)}\n`
    );
  }
  // Replays synchronize even a previously failed commit. A fresh line's fsync also commits truncation.
  if (existing || committedBytes !== totalBytes) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      if (committedBytes !== totalBytes) ftruncateSync(fd, committedBytes);
      if (existing) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existing) syncCanonicalDirectory(binding.root);
  }
  if (!existing) {
    appendObservationRecord(path, state, candidate);
  } else {
    state.totalBytes = state.committedBytes;
    state.stamp = lstatSync(path, { bigint: true });
  }
  // Metadata replay neither withdraws an existing publication nor publishes deferred content.
  if (!descriptors.length || input.deferBodyPublication)
    return { disposition: existing ? 'duplicate' : 'committed', observation: candidate };
  const publicationId = `${draft.id}:publication`;
  const priorPublication = state.records.get(publicationId);
  const publication: WorkObservationRecord = {
    v: 1,
    id: publicationId,
    type: 'content.published',
    seq: priorPublication?.seq ?? state.records.size + 1,
    ts: draft.ts,
    obs: draft.obs,
    turnId: input.turnId,
    parent: draft.id,
    ret: 'turn-evidence',
    refs,
    payload: { bodies: descriptors },
  };
  if (priorPublication && !isDeepStrictEqual(priorPublication, publication))
    throw new Error('recovery_required: observation publication conflict');
  // A committed marker survives lawful evidence expiry; replay never recreates its bytes.
  if (priorPublication) return { disposition: 'duplicate', observation: candidate };
  for (const [index, body] of input.bodies.entries()) {
    const descriptor = descriptors[index];
    if (!descriptor) throw new Error('Missing body descriptor');
    const retained = retainWorkObservationBody(workspaceDb, {
      bundleId: descriptor.bundleId,
      threadId: input.threadId,
      turnId: input.turnId,
      createdAt: draft.ts,
      sha256: descriptor.sha256,
      bytes: body.bytes,
    });
    if (retained === 'expired')
      throw new Error('recovery_required: unpublished body was lawfully expired');
  }
  if (descriptors.length)
    appendObservationRecord(path, state, parseWorkObservationRecord(publication));
  return { disposition: existing ? 'duplicate' : 'committed', observation: candidate };
}

/** Exact immutable body identity prepared before the native SQL transition. */
export type WorkObservationBodyDescriptor = z.infer<typeof bodyDescriptorSchema>;

/** SQL-only input; body bytes and publication effects never enter the database worker. */
export interface ControlWorkObservationInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly observation: WorkObservationDraft;
  readonly bodies: readonly WorkObservationBodyDescriptor[];
  readonly publishBodies?: boolean | undefined;
}

/** Savepoint result only: the worker must await outer FULL COMMIT before acknowledgement. */
export interface ControlWorkObservationResult {
  readonly disposition: 'committed' | 'duplicate';
  readonly observation: WorkObservationRecord;
  readonly publication: WorkObservationRecord | null;
}

/** Producer-owned complete bytes; deferral records expectations without publication authority. */
export interface ControlWorkObservationPreparation {
  readonly threadId: string;
  readonly turnId: string;
  readonly observation: WorkObservationDraft;
  readonly bodies: readonly AdmittedWorkBody[];
  readonly deferBodyPublication?: true;
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
  })
  .strict();

/** Native index fields are checked against their frozen retained payload before use. */
interface ControlObservationRow {
  turn_id: string;
  sequence: number;
  id: string;
  schema_version: number;
  record_json: string;
}

/** Native retained binding; descriptive bytes remain available for the observation manifest update. */
export interface ControlWorkObservationTurnBinding {
  readonly turn: z.infer<typeof StoredTurnV1Schema>;
  readonly raw: Record<string, unknown>;
  readonly revision: number;
  readonly coverage: NonNullable<z.infer<typeof StoredTurnV1Schema>['captureCoverage']> | null;
}

/** Reads native Thread/Turn authority in one short snapshot; no file fallback or current-policy inference. */
export function readControlWorkObservationTurnBinding(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string }
): ControlWorkObservationTurnBinding {
  if (!sqlite.inTransaction)
    return sqlite.transaction(() => readControlWorkObservationTurnBinding(sqlite, owner, input))();
  controlObservationSelectorSchema.parse(input);
  if (!isDeepStrictEqual(owner, StoredWorkOwnerV1Schema.parse(owner)))
    throw new Error('Observation database owner is invalid');
  const threadRow = sqlite
    .prepare('SELECT * FROM control_threads WHERE id=?')
    .get(input.threadId) as
    | {
        schema_version: number;
        revision: number;
        workspace_id: string | null;
        status: string;
        record_json: string;
      }
    | undefined;
  const turnRow = sqlite.prepare('SELECT * FROM control_turns WHERE id=?').get(input.turnId) as
    | {
        schema_version: number;
        revision: number;
        thread_id: string;
        agent_session_id: string | null;
        status: string;
        record_json: string;
      }
    | undefined;
  if (
    !threadRow ||
    !turnRow ||
    threadRow.schema_version !== 1 ||
    turnRow.schema_version !== 1 ||
    Buffer.byteLength(threadRow.record_json) > 64 * 1024 ||
    Buffer.byteLength(turnRow.record_json) > 64 * 1024 ||
    !Number.isSafeInteger(threadRow.revision) ||
    threadRow.revision < 1 ||
    !Number.isSafeInteger(turnRow.revision) ||
    turnRow.revision < 1
  )
    throw new Error('recovery_required: missing or invalid native observation owner');
  const threadRaw = JSON.parse(threadRow.record_json) as Record<string, unknown>;
  const thread = readRetainedV1(threadRaw, () => StoredThreadSnapshotV1Schema.parse(threadRaw));
  const raw = JSON.parse(turnRow.record_json) as Record<string, unknown>;
  const turn = readRetainedV1(raw, () => StoredTurnV1Schema.parse(raw));
  if (
    threadRaw.requiredFeatures !== undefined &&
    (!Array.isArray(threadRaw.requiredFeatures) || threadRaw.requiredFeatures.length !== 0)
  )
    throw new Error('recovery_required: unsupported required Thread semantics');
  if (
    thread.id !== input.threadId ||
    turn.id !== input.turnId ||
    turn.threadId !== input.threadId ||
    turnRow.thread_id !== input.threadId ||
    turnRow.agent_session_id !== (turn.agentSessionId ?? null) ||
    threadRow.status !== thread.status ||
    turnRow.status !== turn.status ||
    threadRow.workspace_id !== (owner.kind === 'workspace' ? owner.workspaceId : null) ||
    !isDeepStrictEqual(thread.owner, owner) ||
    !isDeepStrictEqual(turn.owner, owner)
  )
    throw new Error('recovery_required: native observation owner lineage mismatch');
  return { turn, raw, revision: turnRow.revision, coverage: turn.captureCoverage ?? null };
}

/** Checks native row version, known semantics and indexed identity without rewriting descriptive additions. */
function decodeControlObservation(
  row: ControlObservationRow,
  turnId: string
): WorkObservationRecord {
  if (row.schema_version !== 1 || Buffer.byteLength(row.record_json) > 64 * 1024)
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

/** Returns one committed native identity, including the original sequence on replay. */
export function readControlWorkObservation(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string; readonly id: string }
): WorkObservationRecord | undefined {
  if (!sqlite.inTransaction)
    return sqlite.transaction(() => readControlWorkObservation(sqlite, owner, input))();
  const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
  const row = sqlite
    .prepare('SELECT * FROM control_work_observations WHERE turn_id=? AND id=?')
    .get(input.turnId, input.id) as ControlObservationRow | undefined;
  if (!row) return undefined;
  assertControlObservationManifest(binding);
  const record = decodeControlObservation(row, input.turnId);
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
  if (!sqlite.inTransaction)
    return sqlite.transaction(() => readControlWorkObservations(sqlite, owner, input))();
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
    assertControlObservationLineage(sqlite, owner, input, record);
    return record;
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
  if (!parentRow) throw new Error('recovery_required: missing native observation parent');
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
  if (record.type === 'content.published') {
    const bodies = z.array(bodyDescriptorSchema).parse(record.payload.bodies);
    assertControlBodyDescriptors(owner, input, parent, bodies);
    if (
      record.id !== `${parent.id}:publication` ||
      record.ts !== parent.ts ||
      record.obs !== parent.obs ||
      record.ret !== 'turn-evidence' ||
      !isDeepStrictEqual(record.refs, controlBodyReferences(owner, bodies))
    )
      throw new Error('recovery_required: native observation publication lineage mismatch');
  }
}

/** Checks prepared identities against the deterministic body owner and the producer's expected-content declaration. */
function assertControlBodyDescriptors(
  owner: ControlProductOwner,
  input: { readonly threadId: string; readonly turnId: string },
  record: WorkObservationRecord,
  bodies: readonly WorkObservationBodyDescriptor[]
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
      body.bundleId !==
        workObservationBodyBundleId(
          owner.kind === 'server' ? owner : owner.workspaceId,
          input.threadId,
          input.turnId,
          record.id,
          body.id
        )
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
  // Parse the same complete candidate as SQL before any immutable publication effect.
  controlObservationCandidate({ ...input, bodies }, undefined, 1, owner);
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    observation: input.observation,
    bodies,
    publishBodies: bodies.length > 0 && !input.deferBodyPublication,
  };
}

/** Uses the existing evidence owner outside SQL, preserving its independent FULL-commit and expiry guards. */
export function publishControlWorkObservationBodies(
  db: WorkspaceDb | CoreDb,
  input: ControlWorkObservationPreparation
): ControlWorkObservationInput {
  if (db.sqlite.inTransaction || Number(db.sqlite.pragma('synchronous', { simple: true })) < 2)
    throw new Error('Observation evidence requires a durable independent owner commit');
  const owner: ControlProductOwner =
    db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId };
  const prepared = prepareControlWorkObservation(owner, input);
  const binding = readControlWorkObservationTurnBinding(db.sqlite, owner, input);
  if (!binding.coverage || (prepared.bodies.length && binding.coverage.value !== 'on'))
    throw new Error('Observation capture coverage does not permit bodies');
  const existing = readControlWorkObservation(db.sqlite, owner, {
    ...input,
    id: input.observation.id,
  });
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

/** Builds a known-core candidate while leaving its retained descriptive source available to the insert. */
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

/** Applies native metadata/order and optional publication in the caller's existing savepoint, without filesystem effects or COMMIT. */
export function applyControlWorkObservation(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  value: ControlWorkObservationInput
): ControlWorkObservationResult {
  if (!sqlite.inTransaction || sqlite.readonly)
    throw new Error('Native observations require the owning SQL transaction');
  const parsed = ControlWorkObservationInputSchema.parse(value);
  const input: ControlWorkObservationInput = {
    ...parsed,
    observation: parsed.observation as unknown as WorkObservationDraft,
  };
  const binding = readControlWorkObservationTurnBinding(sqlite, owner, input);
  if (!binding.coverage) throw new Error('recovery_required: missing capture coverage');
  if (input.bodies.length && binding.coverage.value !== 'on')
    throw new Error('Capture coverage is off');
  const existing = readControlWorkObservation(sqlite, owner, {
    ...input,
    id: input.observation.id,
  });
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
    candidate.type === 'turn.reap' &&
    (['pending', 'running'].includes(binding.turn.status) ||
      !binding.turn.completedAt ||
      candidate.ts !== binding.turn.completedAt ||
      candidate.id !== `turn.reap:${input.turnId}`)
  )
    throw new Error('turn.reap requires the native terminal Turn in the same transition');
  const prior = readControlWorkObservation(sqlite, owner, {
    ...input,
    id: `${candidate.id}:publication`,
  });
  let publication = prior ?? null;
  if (
    prior &&
    (prior.type !== 'content.published' ||
      prior.parent !== candidate.id ||
      (input.bodies.length > 0 && !isDeepStrictEqual(prior.payload.bodies, input.bodies)))
  )
    throw new Error('recovery_required: observation publication conflict');
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
  const insert = (record: WorkObservationRecord, raw: unknown): void => {
    const text = JSON.stringify(preserveDescriptiveRecord(raw, record, record));
    if (Buffer.byteLength(text) > 64 * 1024)
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
  if (!binding.turn.requiredFeatures?.includes('openkit.work-observations.v1')) {
    const turnJson = JSON.stringify({
      ...binding.raw,
      requiredFeatures: [...(binding.turn.requiredFeatures ?? []), 'openkit.work-observations.v1'],
    });
    if (Buffer.byteLength(turnJson) > 64 * 1024)
      throw new Error('Observation Turn metadata exceeds the native bound');
    const changed = sqlite
      .prepare(
        'UPDATE control_turns SET revision=revision+1,record_json=? WHERE id=? AND revision=?'
      )
      .run(turnJson, input.turnId, binding.revision);
    if (changed.changes !== 1)
      throw new Error('recovery_required: observation Turn revision conflict');
  }
  if (!existing)
    insert(candidate, { ...input.observation, v: 1, seq: candidate.seq, turnId: input.turnId });
  if (publication && !prior) insert(publication, publication);
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
  const calls = new Map<string, { corr: string; type: string; name: string | null; ts: string }>();
  let afterSequence = 0;
  let lastObservedTs: string | null = null;
  for (;;) {
    const rows = readControlWorkObservations(sqlite, owner, { ...input, afterSequence });
    for (const row of rows) {
      lastObservedTs = row.ts;
      if (row.type === 'model.observed' && row.corr) {
        const key = JSON.stringify([
          row.type,
          row.corr,
          row.payload.direction === 'request' ? row.id : row.parent,
        ]);
        if (row.payload.direction === 'request')
          calls.set(key, { corr: row.corr, type: row.type, name: null, ts: row.ts });
        else if (
          row.parent &&
          ['done', 'error', 'interrupted', 'truncated', 'failed'].includes(
            String(row.payload.event)
          )
        )
          calls.delete(key);
      } else if (row.type === 'runtime.observed') {
        const { fact } = WorkerObservationDataSchema.parse(row.payload);
        if (fact.kind !== 'tool' || !fact.callRef) continue;
        const corr = row.corr ?? fact.callRef;
        const key = JSON.stringify([row.type, corr]);
        if (['completed', 'failed', 'interrupted', 'closed'].includes(fact.phase ?? ''))
          calls.delete(key);
        else if (['started', 'running', 'updated'].includes(fact.phase ?? '')) {
          const previous = calls.get(key);
          calls.set(key, {
            corr,
            type: row.type,
            name: previous?.name ?? fact.toolName ?? null,
            ts: previous?.ts ?? row.ts,
          });
        }
      }
    }
    if (rows.length < 128) break;
    afterSequence = rows.at(-1)!.seq;
  }
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
        lastObservedTs,
        unresolvedCalls: [...calls.values()],
        inferredBy: input.inferredBy,
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
  return prepared ? applyControlWorkObservation(sqlite, owner, prepared).observation : null;
}

/** Validated writer projection; canonical files remain authoritative and reads always validate them. */
interface ObservationAppendState {
  readonly records: Map<string, WorkObservationRecord>;
  committedBytes: number;
  totalBytes: number;
  stamp: BigIntStats | undefined;
}

// Scope reusable state to the borrowed database lifetime, without a second durable index.
const observationAppendStates = new WeakMap<
  WorkspaceDb | CoreDb,
  Map<string, ObservationAppendState>
>();

/** Opens a ledger with full validation; only this writer's unchanged committed prefix is reusable. */
function readAppendState(
  workspaceDb: WorkspaceDb | CoreDb,
  path: string,
  turnId: string
): ObservationAppendState {
  const states = observationAppendStates.get(workspaceDb) ?? new Map();
  observationAppendStates.set(workspaceDb, states);
  const cached = states.get(path);
  const stamp = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (
    cached &&
    stamp?.isFile() &&
    cached.stamp &&
    stamp.dev === cached.stamp.dev &&
    stamp.ino === cached.stamp.ino &&
    stamp.size === cached.stamp.size &&
    stamp.mtimeNs === cached.stamp.mtimeNs &&
    stamp.ctimeNs === cached.stamp.ctimeNs
  )
    return cached;
  // Replacement, edits, a torn tail, another handle's write and failed synchronization all reopen.
  states.delete(path);
  const { rows, committedBytes, totalBytes } = readRows(path, turnId);
  const state: ObservationAppendState = {
    records: new Map(rows.map((row) => [row.id, row])),
    committedBytes,
    totalBytes,
    stamp,
  };
  states.set(path, state);
  return state;
}

/** Advances validated state only after the existing file-and-directory synchronization succeeds. */
function appendObservationRecord(
  path: string,
  state: ObservationAppendState,
  record: WorkObservationRecord
): void {
  const text = `${JSON.stringify(record)}\n`;
  // Keep emitted bytes independent of mutable objects returned to producers.
  const retained = parseWorkObservationRecord(JSON.parse(text));
  appendCanonicalTextFile(path, text);
  state.records.set(retained.id, retained);
  state.committedBytes += Buffer.byteLength(text);
  state.totalBytes = state.committedBytes;
  state.stamp = lstatSync(path, { bigint: true });
}

/** Validates all complete records and preserves the exact truncation boundary for the writer. */
function readRows(
  path: string,
  turnId: string
): { rows: WorkObservationRecord[]; committedBytes: number; totalBytes: number } {
  if (!existsSync(path)) return { rows: [], committedBytes: 0, totalBytes: 0 };
  const bytes = readCanonicalFile(path);
  const committedBytes = bytes.lastIndexOf(0x0a) + 1;
  const rows: WorkObservationRecord[] = [];
  const ids = new Set<string>();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, committedBytes));
  for (const line of text.split('\n').slice(0, -1)) {
    const row = parseWorkObservationRecord(JSON.parse(line));
    if (row.seq !== rows.length + 1 || row.turnId !== turnId || ids.has(row.id))
      throw new Error('recovery_required: corrupt observation sequence or identity');
    ids.add(row.id);
    rows.push(row);
  }
  return { rows, committedBytes, totalBytes: bytes.length };
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
      const published = readPublishedTurnFileRecords(
        workspaceDb.dataRoot,
        workspaceDb.workspaceId,
        input.threadId,
        turnId
      );
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
