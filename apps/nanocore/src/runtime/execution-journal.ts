import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import { ActorRefSchema, type WorkOwner, WorkOwnerSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type {
  EndedExecutionStep,
  ExecutionInvocation,
  ExecutionJournalAnyValue,
  ExecutionJournalExecution,
  ExecutionJournalIntent,
  ExecutionJournalRef,
  ExecutionJournalSettlement,
  ExecutionJournalSpan,
  ExecutionStepJournalReader,
  ExecutionStepRef,
} from './execution-step-journal.js';

/** Release-authored interpretation for the first existing administrative image-acquisition invocation. */
export const CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION = 'core-image-acquire/v1';

/** COORD 23:5x idle physical cleanup; each keyed operation has its own existing Core root. */
export const CORE_IDLE_CLEANUP_EXECUTION_DEFINITION = 'core-idle-cleanup/v1';

/** Release-authored interpretation for the existing Workspace Worker-Turn producers. */
export const WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION = 'workspace-worker-turn/v1';

/** Actual Workspace producers; admission, reservation and observations keep their existing owners. */
const workspaceStepKinds = new Set([
  'resolve-setup',
  'validate-setup',
  'materialize',
  'open-session',
  'inspect-session',
  'deliver-start',
  'collect',
  'terminal-publication',
  'cancel',
  'consume-receipt',
  'inspect-cleanup',
  'release',
]);

// A witness is process-local evidence, not a clock registry or a restart allowance.
const processWitness = randomUUID();
const text = z.string().min(1);
const count = z.number().int().nonnegative().safe();
const integer = z.union([
  z.bigint(),
  z
    .string()
    .regex(/^(?:0|-?[1-9][0-9]*)$/)
    .transform((value) => BigInt(value)),
]);
const nano = integer.refine((value) => value >= 0n && value <= 18_446_744_073_709_551_615n);
const int64 = integer.refine(
  (value) => value >= -9_223_372_036_854_775_808n && value <= 9_223_372_036_854_775_807n
);
const double = z.preprocess(
  (value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value),
  z.union([
    z.number(),
    z.enum(['NaN', 'Infinity', '-Infinity', '-0']).transform((value) => Number(value)),
  ])
);
const anyValue: z.ZodType<ExecutionJournalAnyValue> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('empty') }),
    z.object({ type: z.literal('string'), value: z.string() }),
    z.object({ type: z.literal('boolean'), value: z.boolean() }),
    z.object({ type: z.literal('int'), value: int64 }),
    z.object({ type: z.literal('double'), value: double }),
    z.object({ type: z.literal('bytes'), value: z.array(z.number().int().min(0).max(255)) }),
    z.object({ type: z.literal('array'), value: z.array(anyValue) }),
    z.object({
      type: z.literal('kvlist'),
      value: z.array(z.object({ key: z.string(), value: anyValue })),
    }),
  ])
);
const attributes = z.array(z.object({ key: z.string(), value: anyValue }));
const traceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .refine((value) => /[1-9a-f]/.test(value));
const spanId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((value) => /[1-9a-f]/.test(value));
const descriptor = z.object({
  attributes,
  droppedAttributesCount: count,
  schemaUrl: z.string().optional(),
});
const spanSchema: z.ZodType<ExecutionJournalSpan> = z
  .object({
    traceId,
    spanId,
    parentSpanId: spanId.optional(),
    traceState: z.string().optional(),
    flags: count.max(0xffff_ffff),
    name: text,
    kind: z.enum(['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER']),
    startTimeUnixNano: nano,
    endTimeUnixNano: nano.nullable(),
    status: z
      .object({ code: z.enum(['UNSET', 'OK', 'ERROR']), description: z.string().optional() })
      .transform(({ description, ...status }) => ({
        ...status,
        ...(description === undefined ? {} : { description }),
      })),
    attributes,
    droppedAttributesCount: count,
    events: z.array(
      z.object({
        timeUnixNano: nano,
        name: text,
        attributes,
        droppedAttributesCount: count,
      })
    ),
    droppedEventsCount: count,
    links: z.array(
      z
        .object({
          traceId,
          spanId,
          traceState: z.string().optional(),
          flags: count.max(0xffff_ffff),
          attributes,
          droppedAttributesCount: count,
        })
        .transform(({ traceState, ...link }) => ({
          ...link,
          ...(traceState === undefined ? {} : { traceState }),
        }))
    ),
    droppedLinksCount: count,
    instrumentationScope: descriptor
      .extend({ name: text, version: z.string().optional() })
      .transform(({ version, schemaUrl, ...scope }) => ({
        ...scope,
        ...(version === undefined ? {} : { version }),
        ...(schemaUrl === undefined ? {} : { schemaUrl }),
      })),
    resource: descriptor.transform(({ schemaUrl, ...resource }) => ({
      ...resource,
      ...(schemaUrl === undefined ? {} : { schemaUrl }),
    })),
  })
  .transform(({ parentSpanId, traceState, ...span }) => ({
    ...span,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(traceState === undefined ? {} : { traceState }),
  }))
  .refine(
    (span) => span.endTimeUnixNano === null || span.endTimeUnixNano >= span.startTimeUnixNano
  );
const ownerSchema = WorkOwnerSchema;
const refSchema = z.object({ owner: ownerSchema, executionId: text });
const stepRefSchema = z.object({ execution: refSchema, stepId: text });
const definition = z.enum([
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
]);
const controlSchema = z.object({
  definitionVersion: definition,
  kind: z.enum([
    'admit',
    'queue-capacity-wait',
    'reserve',
    'resolve-setup',
    'validate-setup',
    'materialize',
    'open-session',
    'inspect-session',
    'deliver-start',
    'observe',
    'collect',
    'terminal-publication',
    'cancel',
    'human-wait',
    'consume-receipt',
    'inspect-cleanup',
    'fence',
    'release',
  ]),
  target: z
    .object({ backendKind: text, targetId: text, allocationRef: text.nullable() })
    .nullable(),
  workId: text,
  operationId: text.nullable(),
  attemptId: text.nullable(),
  invocationId: text,
  actor: ActorRefSchema,
  inputRefs: z.array(text),
  outputRefs: z.array(text),
  fingerprint: text,
  permittingDecisionRef: text.nullable(),
  authorityRefs: z.array(text),
  retryDeclarationRef: text.nullable(),
  retryPermitted: z.boolean(),
  deadlineUnixNano: nano.nullable(),
  physicalFenceRefs: z.array(text),
});
const invocationSchema = z.object({
  parent: z.object({ ref: stepRefSchema, deadlineUnixNano: nano.nullable() }).nullable(),
  carriage: z.object({
    operation: text,
    requestId: text,
    sequence: count.nullable(),
    bindingRef: text.nullable(),
  }),
  clock: z.object({ processWitness: text, admittedUnixNano: nano, admittedMonotonicNano: nano }),
});
const phase = z.enum(['open', 'closing', 'closed']);
const state = z.enum(['intent', 'completed', 'failed', 'unknown', 'cancelled']);
const rootRowSchema = z.object({
  id: text,
  schema_version: z.literal(1),
  owner_json: text,
  work_id: text,
  definition_version: definition,
  input_fingerprint: text,
  phase,
  revision: count.min(1),
  terminal_cause: text.nullable(),
  exclusion_refs_json: text,
  span_json: text,
});
const stepRowSchema = z.object({
  execution_id: text,
  step_id: text,
  schema_version: z.literal(1),
  ordinal: count.min(1),
  parent_step_id: text.nullable(),
  state,
  invocation_id: text,
  control_json: text,
  invocation_json: text,
  span_json: text,
  inspected_execution_id: text.nullable(),
  inspected_step_id: text.nullable(),
});

/** Serializes exact typed values; only typed doubles use JSON's special-value spellings. */
export function encodeExecutionJournalValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (
      item &&
      typeof item === 'object' &&
      'type' in item &&
      item.type === 'double' &&
      'value' in item
    ) {
      const number = item.value;
      if (typeof number === 'number' && (!Number.isFinite(number) || Object.is(number, -0))) {
        return { ...item, value: Object.is(number, -0) ? '-0' : String(number) };
      }
    }
    return item;
  });
}

/** Decodes the retained original span with the journal's exact typed-value rules. */
export function decodeExecutionJournalSpan(value: unknown): ExecutionJournalSpan {
  return spanSchema.parse(value);
}

/** Closed native transport for the existing journal owner; decimal JSON preserves exact typed integers. */
export const ControlExecutionJournalInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('intent'), inputJson: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('settle'),
      inputJson: z.string().min(1),
      consumeIntentJson: z.string().min(1).optional(),
    })
    .strict(),
]);
/** One existing journal mutation, never a SQL or callback transport. */
export type ControlExecutionJournalInput = z.infer<typeof ControlExecutionJournalInputSchema>;

/** Parses lossless intent framing before the existing synchronous owner validates the transition. */
export function decodeExecutionJournalIntent(inputJson: string): ExecutionJournalIntent {
  return z
    .object({
      execution: z
        .object({
          ref: refSchema,
          definitionVersion: definition,
          workId: text,
          fingerprint: text,
          exclusionRefs: z.array(text),
          span: spanSchema.refine((value) => value.endTimeUnixNano === null),
        })
        .strict(),
      stepId: text,
      parentStepId: text.nullable(),
      control: controlSchema,
      parent: invocationSchema.shape.parent,
      carriage: invocationSchema.shape.carriage,
      inspectedStep: stepRefSchema.nullable(),
      span: spanSchema.refine((value) => value.endTimeUnixNano === null),
    })
    .strict()
    .parse(JSON.parse(inputJson)) as ExecutionJournalIntent;
}

/** Parses lossless conditional settlement framing without changing its original comparison fields. */
export function decodeExecutionJournalSettlement(inputJson: string): ExecutionJournalSettlement {
  return z
    .object({
      ref: stepRefSchema,
      expectedExecutionRevision: count.min(1),
      state: state.exclude(['intent']),
      outputRefs: z.array(text),
      span: spanSchema.refine((value) => value.endTimeUnixNano !== null),
      nextPhase: phase,
      terminalCause: text.nullable(),
      exclusionRefs: z.array(text),
    })
    .strict()
    .parse(JSON.parse(inputJson)) as ExecutionJournalSettlement;
}

/** Decodes the actual native invocation, including its worker-owned remaining-time calculation. */
export function decodeExecutionJournalInvocation(value: string): ExecutionInvocation {
  return z
    .object({
      ref: stepRefSchema,
      state,
      control: controlSchema,
      ...invocationSchema.shape,
      remainingMs: z.number().nonnegative().finite(),
    })
    .strict()
    .parse(JSON.parse(value));
}

/** Decodes an ended native step without coercing an open intent into completion. */
export function decodeEndedExecutionStep(value: string): EndedExecutionStep {
  return z
    .object({
      ref: stepRefSchema,
      state: state.exclude(['intent']),
      control: controlSchema,
      rootSpanId: spanId,
      span: spanSchema.refine((item) => item.endTimeUnixNano !== null),
    })
    .strict()
    .parse(JSON.parse(value)) as EndedExecutionStep;
}

/** Applies one existing Workspace journal mutation on the admitted writer, with exact Turn lineage. */
export function applyControlExecutionJournal(
  db: WorkspaceDb,
  value: ControlExecutionJournalInput
): string {
  if (isMainThread || !db.sqlite.inTransaction)
    throw new Error('Workspace execution mutations require the native writer transaction.');
  const command = ControlExecutionJournalInputSchema.parse(value);
  const input =
    command.kind === 'intent'
      ? decodeExecutionJournalIntent(command.inputJson)
      : decodeExecutionJournalSettlement(command.inputJson);
  const ref = 'execution' in input ? input.execution.ref : input.ref.execution;
  const workId = 'execution' in input ? input.execution.workId : readRoot(db, ref).workId;
  if (ref.owner.kind !== 'workspace' || ref.owner.workspaceId !== db.workspaceId)
    throw new Error('Workspace execution owner conflicts.');
  const turn = db.sqlite.prepare('SELECT record_json FROM control_turns WHERE id=?').get(workId) as
    | { record_json: string }
    | undefined;
  if (!turn) throw new Error('Workspace execution requires its admitted Turn.');
  const record = JSON.parse(turn.record_json) as {
    owner?: WorkOwner;
    agentSessionId?: string | null;
  };
  if (!isDeepStrictEqual(record.owner, ref.owner) || !record.agentSessionId)
    throw new Error('Workspace execution requires its actual Worker binding.');
  const roots = db.sqlite
    .prepare('SELECT id FROM control_executions WHERE work_id=?')
    .all(workId) as { id: string }[];
  if (roots.some((root) => root.id !== ref.executionId))
    throw new Error('Workspace execution root conflicts.');
  if (command.kind === 'intent')
    return encodeExecutionJournalValue(
      writeExecutionJournalIntent(db, input as ExecutionJournalIntent)
    );
  const settlement = input as ExecutionJournalSettlement;
  const ended = settleExecutionJournalStep(db, settlement);
  if (command.consumeIntentJson) {
    const consume = decodeExecutionJournalIntent(command.consumeIntentJson);
    if (
      !isDeepStrictEqual(consume.execution.ref, ref) ||
      consume.execution.workId !== workId ||
      consume.control.kind !== 'consume-receipt' ||
      consume.control.operationId !== ended.control.operationId ||
      !isDeepStrictEqual(consume.inspectedStep, settlement.ref) ||
      !isDeepStrictEqual(consume.carriage, storedStep(db, settlement.ref).invocation.carriage)
    )
      throw new Error('Receipt consumption conflicts with its original outcome.');
    // The existing request savepoint makes the observed outcome and ACK obligation indivisible.
    writeExecutionJournalIntent(db, consume);
  }
  return encodeExecutionJournalValue(ended);
}

/** Parses known fields while refusing unknown core versions, tags and malformed required content. */
function decode<T>(schema: z.ZodType<T>, bytes: string): T {
  return schema.parse(JSON.parse(bytes));
}

/** Enforces the physical owner and prevents a primitive from opening its own transaction. */
function requireWriter(db: CoreDb | WorkspaceDb, ref: ExecutionJournalRef): void {
  requireScope(db, ref.owner);
  refSchema.parse(ref);
  if (!db.sqlite.inTransaction)
    throw new Error('Execution journal requires the owning transaction.');
}

/** Requires the caller's physical database and disclosure owner to name the same authority. */
function requireScope(db: CoreDb | WorkspaceDb, owner: WorkOwner): void {
  ownerSchema.parse(owner);
  if (
    db.scope === 'core'
      ? owner.kind !== 'server'
      : owner.kind !== 'workspace' || owner.workspaceId !== db.workspaceId
  ) {
    throw new Error('Execution journal scope or owner conflicts.');
  }
}

/** Refuses a known definition used in the wrong physical scope, not just unknown versions. */
function requireDefinition(db: CoreDb | WorkspaceDb, value: string): void {
  const admitted =
    db.scope === 'core'
      ? value === CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION ||
        value === CORE_IDLE_CLEANUP_EXECUTION_DEFINITION
      : value === WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION;
  if (!admitted) throw new Error('Execution definition conflicts with its physical owner.');
}

/** Reads an exact root; absence, invalid metadata and unknown definitions fail closed. */
function readRoot(db: CoreDb | WorkspaceDb, ref: ExecutionJournalRef): ExecutionJournalExecution {
  requireScope(db, ref.owner);
  refSchema.parse(ref);
  const row = rootRowSchema.parse(
    db.sqlite.prepare('SELECT * FROM control_executions WHERE id = ?').get(ref.executionId)
  );
  const owner = decode(ownerSchema, row.owner_json);
  requireDefinition(db, row.definition_version);
  if (!isDeepStrictEqual(owner, ref.owner)) throw new Error('Execution owner conflicts.');
  const span = decode(spanSchema, row.span_json);
  if ((row.phase === 'closed') !== (span.endTimeUnixNano !== null)) {
    throw new Error('Execution root phase conflicts with its span.');
  }
  const steps = db.sqlite
    .prepare(
      "SELECT step_id FROM control_execution_steps WHERE execution_id = ? AND state = 'intent' ORDER BY ordinal"
    )
    .all(row.id) as { step_id: string }[];
  return {
    ref,
    definitionVersion: row.definition_version,
    workId: row.work_id,
    fingerprint: row.input_fingerprint,
    phase: row.phase,
    revision: row.revision,
    terminalCause: row.terminal_cause,
    exclusionRefs: decode(z.array(text), row.exclusion_refs_json),
    span,
    openSteps: steps.map((step) => ({ execution: ref, stepId: text.parse(step.step_id) })),
  };
}

/** Shares the existing validated root read with native causal admission; SQL remains the deciding owner. */
export { readRoot as readExecutionJournalRoot };

/** Decodes retained step facts without interpreting diagnostic values as control authority. */
function storedStep(db: CoreDb | WorkspaceDb, ref: ExecutionStepRef) {
  stepRefSchema.parse(ref);
  const root = readRoot(db, ref.execution);
  const row = stepRowSchema.parse(
    db.sqlite
      .prepare('SELECT * FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
      .get(ref.execution.executionId, ref.stepId)
  );
  const control = decode(controlSchema, row.control_json);
  if (
    db.scope === 'core' &&
    root.definitionVersion === CORE_IDLE_CLEANUP_EXECUTION_DEFINITION &&
    !['inspect-cleanup', 'collect', 'release', 'consume-receipt'].includes(control.kind)
  )
    throw new Error('Core idle cleanup step has no admitted producer.');
  if (db.scope === 'workspace' && !workspaceStepKinds.has(control.kind)) {
    throw new Error('Workspace execution step has no admitted producer.');
  }
  const invocation = decode(invocationSchema, row.invocation_json);
  const span = decode(spanSchema, row.span_json);
  if (
    control.invocationId !== row.invocation_id ||
    control.definitionVersion !== root.definitionVersion ||
    control.workId !== root.workId ||
    (row.state === 'intent') !== (span.endTimeUnixNano === null) ||
    (row.state === 'unknown' && span.status.code !== 'ERROR')
  ) {
    throw new Error('Execution step conflicts with retained authority.');
  }
  if ((row.inspected_execution_id === null) !== (row.inspected_step_id === null)) {
    throw new Error('Execution inspection reference is incomplete.');
  }
  return { root, row, control, invocation, span };
}

/** Computes a conservative allowance from this live process's original anchor, never from reopening. */
function invocationView(
  db: CoreDb | WorkspaceDb,
  ref: ExecutionStepRef,
  ancestors = new Set<string>()
): ExecutionInvocation {
  const identity = encodeExecutionJournalValue(ref);
  if (ancestors.has(identity)) throw new Error('Execution parent lineage contains a cycle.');
  ancestors.add(identity);
  const stored = storedStep(db, ref);
  const { clock } = stored.invocation;
  const expiry = stored.control.deadlineUnixNano;
  let remainingMs = 0;
  if (stored.row.state === 'intent' && clock.processWitness === processWitness && expiry !== null) {
    const now = BigInt(Date.now()) * 1_000_000n;
    const elapsed = process.hrtime.bigint() - clock.admittedMonotonicNano;
    if (elapsed >= 0n && now >= clock.admittedUnixNano) {
      const wallRemaining = expiry - now;
      const monotonicRemaining = expiry - clock.admittedUnixNano - elapsed;
      const remaining = wallRemaining < monotonicRemaining ? wallRemaining : monotonicRemaining;
      if (remaining > 0n) remainingMs = Number(remaining / 1_000_000n);
    }
  }
  const parent = stored.invocation.parent;
  if (parent !== null && remainingMs > 0) {
    const originalParent = invocationView(db, parent.ref, ancestors);
    if (
      parent.deadlineUnixNano !== originalParent.control.deadlineUnixNano ||
      (parent.deadlineUnixNano !== null && (expiry === null || expiry > parent.deadlineUnixNano))
    ) {
      throw new Error('Execution parent cap conflicts.');
    }
    remainingMs = Math.min(remainingMs, originalParent.remainingMs);
  }
  return {
    ref,
    state: stored.row.state,
    control: stored.control,
    ...stored.invocation,
    remainingMs,
  };
}

/** Reads an ended step with its original root span identity; open intents are not exportable. */
function endedStep(db: CoreDb | WorkspaceDb, ref: ExecutionStepRef): EndedExecutionStep {
  const stored = storedStep(db, ref);
  if (stored.row.state === 'intent' || stored.span.endTimeUnixNano === null)
    throw new Error('Execution step has not ended.');
  return {
    ref,
    state: stored.row.state,
    control: stored.control,
    rootSpanId: stored.root.span.spanId,
    span: { ...stored.span, endTimeUnixNano: stored.span.endTimeUnixNano },
  };
}

/**
 * Creates a read-only view over the caller's existing owning connection; it opens no database or timer.
 * @param db Existing connection selected under current scope admission.
 * @param owner Current disclosure owner, never inferred from correlation or a path.
 * @returns Lossless history readers; retained facts grant no execution authority.
 * @throws For unsupported scope or missing, corrupt, conflicting or unknown required authority.
 */
export function createExecutionStepJournalReader(
  db: CoreDb | WorkspaceDb,
  owner: WorkOwner
): ExecutionStepJournalReader {
  requireScope(db, owner);
  /** Checks each supplied reference against the construction owner before SQL. */
  const check = (ref: ExecutionJournalRef): void => {
    if (!isDeepStrictEqual(ref.owner, owner)) throw new Error('Execution reader owner conflicts.');
  };
  return {
    async readExecution(ref) {
      check(ref);
      return readRoot(db, ref);
    },
    async readInvocation(ref) {
      check(ref.execution);
      return invocationView(db, ref);
    },
    async readEndedSteps(ref) {
      check(ref);
      readRoot(db, ref);
      const rows = db.sqlite
        .prepare(
          "SELECT step_id FROM control_execution_steps WHERE execution_id = ? AND state <> 'intent' ORDER BY ordinal"
        )
        .all(ref.executionId) as { step_id: string }[];
      return rows.map((row) => endedStep(db, { execution: ref, stepId: text.parse(row.step_id) }));
    },
    async readLinkedInspections(ref) {
      check(ref.execution);
      storedStep(db, ref);
      const rows = db.sqlite
        .prepare(
          "SELECT execution_id, step_id FROM control_execution_steps WHERE inspected_execution_id = ? AND inspected_step_id = ? AND state <> 'intent' ORDER BY execution_id, ordinal"
        )
        .all(ref.execution.executionId, ref.stepId) as { execution_id: string; step_id: string }[];
      return rows.map((row) => ({
        inspectedStep: ref,
        inspection: endedStep(db, {
          execution: { owner, executionId: row.execution_id },
          stepId: row.step_id,
        }),
      }));
    },
  };
}

/**
 * Persists one immutable intent before any queue or external wait in the caller's owning transaction.
 * @param db Existing owning Core or Workspace connection inside its write transaction.
 * @param input Exact root, original authority and separate stable invocation identity.
 * @returns Retained invocation; an identical repeat does not renew its clock or revision.
 * @throws For changed identity/input, closed authority, malformed values or absent transaction.
 */
export function writeExecutionJournalIntent(
  db: CoreDb | WorkspaceDb,
  input: ExecutionJournalIntent
): ExecutionInvocation {
  requireWriter(db, input.execution.ref);
  const admission = input.execution;
  const control = controlSchema.parse(input.control);
  const span = spanSchema.parse(input.span);
  const rootSpan = spanSchema.parse(admission.span);
  definition.parse(admission.definitionVersion);
  requireDefinition(db, admission.definitionVersion);
  if (
    db.scope === 'core' &&
    admission.definitionVersion === CORE_IDLE_CLEANUP_EXECUTION_DEFINITION &&
    !['inspect-cleanup', 'collect', 'release', 'consume-receipt'].includes(control.kind)
  )
    throw new Error('Core idle cleanup step has no admitted producer.');
  if (db.scope === 'workspace' && !workspaceStepKinds.has(control.kind)) {
    throw new Error('Workspace execution step has no admitted producer.');
  }
  text.parse(admission.workId);
  text.parse(admission.fingerprint);
  text.parse(input.stepId);
  if (
    span.endTimeUnixNano !== null ||
    rootSpan.endTimeUnixNano !== null ||
    control.workId !== admission.workId ||
    control.definitionVersion !== admission.definitionVersion
  )
    throw new Error('Execution intent conflicts with its admission.');
  const ref = { execution: admission.ref, stepId: input.stepId };
  const previous = db.sqlite
    .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
    .get(admission.ref.executionId, input.stepId);
  if (previous) {
    const stored = storedStep(db, ref);
    if (
      !isDeepStrictEqual(stored.control, control) ||
      !isDeepStrictEqual(stored.invocation.parent, input.parent) ||
      !isDeepStrictEqual(stored.invocation.carriage, input.carriage) ||
      stored.row.parent_step_id !== input.parentStepId ||
      stored.row.inspected_execution_id !== (input.inspectedStep?.execution.executionId ?? null) ||
      stored.row.inspected_step_id !== (input.inspectedStep?.stepId ?? null) ||
      stored.root.fingerprint !== admission.fingerprint ||
      !isDeepStrictEqual(stored.span, span)
    )
      throw new Error('Execution invocation input conflicts.');
    return invocationView(db, ref);
  }
  const exists = db.sqlite
    .prepare('SELECT 1 FROM control_executions WHERE id = ?')
    .get(admission.ref.executionId);
  if (!exists) {
    db.sqlite
      .prepare(
        `INSERT INTO control_executions (id, schema_version, owner_json, work_id, definition_version, input_fingerprint, phase, revision, terminal_cause, exclusion_refs_json, span_json) VALUES (?, 1, ?, ?, ?, ?, 'open', 1, NULL, ?, ?)`
      )
      .run(
        admission.ref.executionId,
        encodeExecutionJournalValue(ownerSchema.parse(admission.ref.owner)),
        admission.workId,
        admission.definitionVersion,
        admission.fingerprint,
        encodeExecutionJournalValue(z.array(text).parse(admission.exclusionRefs)),
        encodeExecutionJournalValue(rootSpan)
      );
  }
  const root = readRoot(db, admission.ref);
  if (
    root.phase === 'closed' ||
    (root.phase === 'closing' &&
      ![
        'inspect-cleanup',
        'consume-receipt',
        ...(db.scope === 'workspace' ? ['release'] : []),
      ].includes(control.kind)) ||
    root.workId !== admission.workId ||
    root.fingerprint !== admission.fingerprint ||
    root.definitionVersion !== admission.definitionVersion ||
    root.span.traceId !== rootSpan.traceId ||
    root.span.spanId !== rootSpan.spanId ||
    root.span.startTimeUnixNano !== rootSpan.startTimeUnixNano
  )
    throw new Error('Execution admission conflicts with retained authority.');
  if (span.traceId !== root.span.traceId) throw new Error('Execution step trace conflicts.');
  if (input.parent !== null) {
    const parent = storedStep(db, input.parent.ref);
    if (
      parent.row.state !== 'intent' ||
      input.parent.deadlineUnixNano !== parent.control.deadlineUnixNano ||
      (input.parent.deadlineUnixNano !== null &&
        (control.deadlineUnixNano === null ||
          control.deadlineUnixNano > input.parent.deadlineUnixNano))
    )
      throw new Error('Execution parent authority cannot be renewed.');
    const sameExecution = input.parent.ref.execution.executionId === admission.ref.executionId;
    if (
      sameExecution
        ? input.parentStepId !== input.parent.ref.stepId || span.parentSpanId !== parent.span.spanId
        : input.parentStepId !== null
    )
      throw new Error('Execution control parent conflicts.');
  } else if (input.parentStepId !== null) throw new Error('Execution parent authority is missing.');
  if (input.inspectedStep !== null) {
    const inspected = storedStep(db, input.inspectedStep);
    if (
      !span.links.some(
        (link) => link.traceId === inspected.span.traceId && link.spanId === inspected.span.spanId
      )
    )
      throw new Error('Inspection must link its original span.');
  }
  const invocation = invocationSchema.parse({
    parent: input.parent,
    carriage: input.carriage,
    clock: {
      processWitness,
      admittedUnixNano: BigInt(Date.now()) * 1_000_000n,
      admittedMonotonicNano: process.hrtime.bigint(),
    },
  });
  const ordinal = db.sqlite
    .prepare(
      'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM control_execution_steps WHERE execution_id = ?'
    )
    .get(admission.ref.executionId) as { ordinal: number };
  db.sqlite
    .prepare(
      `INSERT INTO control_execution_steps (execution_id, step_id, schema_version, ordinal, parent_step_id, state, invocation_id, control_json, invocation_json, span_json, inspected_execution_id, inspected_step_id) VALUES (?, ?, 1, ?, ?, 'intent', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      admission.ref.executionId,
      input.stepId,
      count.min(1).parse(ordinal.ordinal),
      input.parentStepId,
      control.invocationId,
      encodeExecutionJournalValue(control),
      encodeExecutionJournalValue(invocation),
      encodeExecutionJournalValue(span),
      input.inspectedStep?.execution.executionId ?? null,
      input.inspectedStep?.stepId ?? null
    );
  db.sqlite
    .prepare('UPDATE control_executions SET revision = revision + 1 WHERE id = ? AND revision = ?')
    .run(admission.ref.executionId, root.revision);
  return invocationView(db, ref);
}

/**
 * Ends exactly one intent and advances its root inside the existing receipt-owning transaction.
 * @param db Existing owning Core or Workspace connection inside its write transaction.
 * @param input Conditional outcome and explicit next local transition.
 * @returns Immutable ended step; this function emits no samples and releases no physical fence.
 * @throws For stale revision, ended identity, changed span, open children or absent transaction.
 */
export function settleExecutionJournalStep(
  db: CoreDb | WorkspaceDb,
  input: ExecutionJournalSettlement
): EndedExecutionStep {
  requireWriter(db, input.ref.execution);
  const stored = storedStep(db, input.ref);
  const span = spanSchema.parse(input.span);
  const outcome = state.exclude(['intent']).parse(input.state);
  phase.parse(input.nextPhase);
  if (
    stored.row.state !== 'intent' ||
    stored.root.revision !== input.expectedExecutionRevision ||
    stored.root.phase === 'closed' ||
    span.endTimeUnixNano === null ||
    span.endTimeUnixNano < span.startTimeUnixNano ||
    (outcome === 'unknown' && span.status.code !== 'ERROR')
  )
    throw new Error('Execution settlement is stale or conflicts.');
  for (const key of [
    'traceId',
    'spanId',
    'parentSpanId',
    'startTimeUnixNano',
    'name',
    'kind',
  ] as const) {
    if (span[key] !== stored.span[key]) throw new Error('Execution span identity is immutable.');
  }
  const outputRefs = z.array(text).parse(input.outputRefs);
  const exclusionRefs = z.array(text).parse(input.exclusionRefs);
  const hasUnknown =
    outcome === 'unknown' ||
    db.sqlite
      .prepare(
        "SELECT 1 FROM control_execution_steps WHERE execution_id = ? AND state = 'unknown' LIMIT 1"
      )
      .get(input.ref.execution.executionId) !== undefined;
  const inspectedRelease =
    stored.row.inspected_step_id === null
      ? undefined
      : storedStep(db, {
          execution: {
            owner: input.ref.execution.owner,
            executionId: stored.row.inspected_execution_id!,
          },
          stepId: stored.row.inspected_step_id,
        });
  const releaseProof =
    stored.control.kind === 'release' ||
    (stored.control.kind === 'inspect-cleanup' &&
      stored.row.inspected_execution_id === input.ref.execution.executionId &&
      inspectedRelease?.row.state === 'completed' &&
      inspectedRelease.control.kind === 'release' &&
      isDeepStrictEqual(inspectedRelease.control.outputRefs, outputRefs));
  const qualifiedRelease =
    db.scope === 'workspace' &&
    releaseProof &&
    outcome === 'completed' &&
    outputRefs.length === 1 &&
    (
      db.sqlite
        .prepare(
          "SELECT step_id FROM control_execution_steps WHERE execution_id = ? AND state = 'unknown'"
        )
        .all(input.ref.execution.executionId) as { step_id: string }[]
    ).every((unknown) => {
      const proofs = db.sqlite
        .prepare(
          "SELECT step_id FROM control_execution_steps WHERE execution_id = ? AND inspected_execution_id = ? AND inspected_step_id = ? AND state = 'completed'"
        )
        .all(input.ref.execution.executionId, input.ref.execution.executionId, unknown.step_id) as {
        step_id: string;
      }[];
      return proofs.some((proof) => {
        const observed = storedStep(db, { execution: input.ref.execution, stepId: proof.step_id });
        return (
          observed.control.kind === 'inspect-cleanup' &&
          isDeepStrictEqual(observed.control.outputRefs, outputRefs)
        );
      });
    });
  if (
    hasUnknown &&
    !qualifiedRelease &&
    (input.nextPhase === 'closed' ||
      stored.root.exclusionRefs.some((ref) => !exclusionRefs.includes(ref)))
  ) {
    throw new Error('Unknown children retain exclusion; parent completion cannot release them.');
  }
  if (
    input.nextPhase === 'closed' &&
    (stored.root.openSteps.some((ref) => ref.stepId !== input.ref.stepId) ||
      exclusionRefs.length !== 0 ||
      outcome === 'unknown')
  )
    throw new Error('Execution cannot close with unresolved work.');
  // Preserve additive retained fields on the only permitted control update.
  const control = { ...JSON.parse(stored.row.control_json), outputRefs };
  const persistedSpan = {
    ...JSON.parse(stored.row.span_json),
    ...JSON.parse(encodeExecutionJournalValue(input.span)),
  };
  const changed = db.sqlite
    .prepare(
      "UPDATE control_execution_steps SET state = ?, control_json = ?, span_json = ? WHERE execution_id = ? AND step_id = ? AND state = 'intent'"
    )
    .run(
      outcome,
      encodeExecutionJournalValue(control),
      encodeExecutionJournalValue(persistedSpan),
      input.ref.execution.executionId,
      input.ref.stepId
    );
  if (changed.changes !== 1) throw new Error('Execution outcome lost its conditional transition.');
  const retainedRootSpan = JSON.parse(
    rootRowSchema.parse(
      db.sqlite
        .prepare('SELECT * FROM control_executions WHERE id = ?')
        .get(input.ref.execution.executionId)
    ).span_json
  );
  const rootSpan =
    input.nextPhase === 'closed'
      ? { ...retainedRootSpan, endTimeUnixNano: span.endTimeUnixNano, status: span.status }
      : retainedRootSpan;
  const advanced = db.sqlite
    .prepare(
      'UPDATE control_executions SET phase = ?, revision = revision + 1, terminal_cause = ?, exclusion_refs_json = ?, span_json = ? WHERE id = ? AND revision = ?'
    )
    .run(
      input.nextPhase,
      input.terminalCause,
      encodeExecutionJournalValue(exclusionRefs),
      encodeExecutionJournalValue(rootSpan),
      input.ref.execution.executionId,
      input.expectedExecutionRevision
    );
  if (advanced.changes !== 1) throw new Error('Execution revision conflicts.');
  return endedStep(db, input.ref);
}
