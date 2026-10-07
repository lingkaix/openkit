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
import { ReasoningEffortSchema, SystemPromptDigestSchema } from '@openkit/protocol';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { z } from 'zod';
import {
  readWorkObservationBody,
  retainWorkObservationBody,
  workObservationBodyBundleId,
} from '../evidence-bundles.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { WorkspaceDb } from './db.js';
import {
  appendCanonicalTextFile,
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  CaptureCoverageBindingSchema,
  readCanonicalFile,
  readCanonicalTextFile,
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

/** Owner-validated long-lived facts, never arbitrary original bodies. */
export interface WorkObservationDraft {
  readonly id: string;
  readonly type: string;
  readonly ts: string;
  readonly obs: 'core' | 'gateway' | 'sidecar' | 'nanohost';
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

/** Persisted observation; sequence is file-local ingest order, not narrative order. */
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
    obs: z.enum(['core', 'gateway', 'sidecar', 'nanohost']),
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
  turnId: z.string().min(1),
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
      workspaceId: z.string().min(1),
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
    .strip(),
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
    (row.type.startsWith('model.') && row.obs !== 'gateway') ||
    (row.type === 'runtime.observed' && row.obs !== 'sidecar') ||
    ((row.type === 'env.bound' || row.type === 'turn.reap') && row.obs !== 'core')
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
              typeof ref.scope.workspaceId === 'string'
          )
      )
    )
      throw new Error('Invalid content publication observation');
  }
  return row;
}

/** Validates persisted lineage and reads historical coverage without using current policy. */
export function readWorkObservationTurnBinding(
  workspaceDb: WorkspaceDb,
  input: { readonly threadId: string; readonly turnId: string }
) {
  for (const id of [workspaceDb.workspaceId, input.threadId, input.turnId])
    assertSafeWorkspacePathSegment(id, 'Observation owner');
  let root = workspaceDb.dataRoot;
  for (const part of ['workspaces', workspaceDb.workspaceId, 'threads', input.threadId]) {
    root = join(root, part);
    assertCanonicalDirectory(root);
  }
  const thread = JSON.parse(readCanonicalTextFile(join(root, 'thread.json'))) as Record<
    string,
    unknown
  >;
  if (thread.id !== input.threadId || thread.workspaceId !== workspaceDb.workspaceId)
    throw new Error('recovery_required: observation Thread lineage mismatch');
  for (const part of ['turns', input.turnId]) {
    root = join(root, part);
    assertCanonicalDirectory(root);
  }
  const raw = JSON.parse(readCanonicalTextFile(join(root, 'turn.json'))) as Record<string, unknown>;
  const turn = TurnReaderSchema.parse({ ...raw, items: [] });
  if (
    turn.id !== input.turnId ||
    turn.threadId !== input.threadId ||
    turn.workspaceId !== workspaceDb.workspaceId
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
  workspaceDb: WorkspaceDb,
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
  workspaceDb: WorkspaceDb,
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
        workspaceDb.workspaceId,
        input.threadId,
        input.turnId,
        draft.id,
        body.id
      ),
    };
  });
  const refs: WorkObservationReference[] = descriptors.map((body) => ({
    kind: 'evidence-bundle',
    scope: { workspaceId: workspaceDb.workspaceId, pathClass: 'backend' },
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
      `${JSON.stringify({ ...binding.raw, requiredFeatures: [...requiredFeatures, 'openkit.work-observations.v1'] }, null, 2)}\n`
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

/** Validated writer projection; canonical files remain authoritative and reads always validate them. */
interface ObservationAppendState {
  readonly records: Map<string, WorkObservationRecord>;
  committedBytes: number;
  totalBytes: number;
  stamp: BigIntStats | undefined;
}

// Scope reusable state to the borrowed database lifetime, without a second durable index.
const observationAppendStates = new WeakMap<WorkspaceDb, Map<string, ObservationAppendState>>();

/** Opens a ledger with full validation; only this writer's unchanged committed prefix is reusable. */
function readAppendState(
  workspaceDb: WorkspaceDb,
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

/** Projects admitted outward text and deterministic structural labels after current Thread authorization. */
export function readThreadRuntimeActivity(
  workspaceDb: WorkspaceDb,
  input: {
    readonly threadId: string;
    readonly turnIds: readonly string[];
  }
): readonly ThreadRuntimeActivity[] {
  return input.turnIds.map((turnId): ThreadRuntimeActivity => {
    let contentCapture: ThreadRuntimeActivity['contentCapture'] = 'unknown';
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
      const entries: ThreadRuntimeActivity['entries'][number][] = [];
      const displayedChildren = new Set<string>();
      for (const row of runtime) {
        const { fact, content } = WorkerObservationDataSchema.parse(row.payload);
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
        let text: string | undefined;
        if (
          binding.coverage?.value === 'on' &&
          fact.kind === 'assistant' &&
          content.state === 'expected' &&
          content.mediaType === 'text/plain' &&
          publication
        ) {
          const descriptor = bodyDescriptorSchema.parse(
            (publication.payload.bodies as unknown[])[0]
          );
          const ref = publication.refs?.find(
            (candidate) =>
              candidate.edge === 'publication' &&
              candidate.locator === descriptor.bundleId &&
              candidate.digest === descriptor.sha256 &&
              candidate.scope.workspaceId === workspaceDb.workspaceId
          );
          if (
            ref &&
            descriptor.bytes === content.bytes &&
            `sha256:${descriptor.sha256}` === content.sha256 &&
            descriptor.mediaType === content.mediaType &&
            descriptor.boundary === content.boundary
          ) {
            const bytes = readWorkObservationBody(workspaceDb, {
              bundleId: descriptor.bundleId,
              threadId: input.threadId,
              turnId,
              createdAt: row.ts,
              sha256: descriptor.sha256,
            });
            if (bytes) {
              const candidate = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              if (isSafeTimelineText(candidate)) text = candidate;
            } else partial = true;
          }
        }
        entries.push({
          sequence: row.seq,
          observedAt: row.ts,
          kind,
          label,
          ...(text === undefined
            ? {}
            : { text: text.slice(0, THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS) }),
          textTruncated:
            text !== undefined && text.length > THREAD_RUNTIME_ACTIVITY_MAX_TEXT_CHARACTERS,
        });
      }
      const limit = THREAD_RUNTIME_ACTIVITY_MAX_ENTRIES;
      return {
        turnId,
        contentCapture,
        coverage:
          unavailable && entries.length === 0
            ? 'unavailable'
            : partial || unavailable
              ? 'partial'
              : 'collecting',
        entries: entries.slice(-limit),
        omittedEntryCount: Math.max(0, entries.length - limit),
      };
    } catch {
      // Projection failure is local to this Turn; strict storage reads still reject corrupt bytes.
      return { turnId, contentCapture, coverage: 'unavailable', entries: [], omittedEntryCount: 0 };
    }
  });
}
