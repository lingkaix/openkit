import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ArtifactIdSchema, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import {
  canonicalNativeEnvironment,
  NativeEnvironmentRecordSchema,
} from '@openkit/worker-protocol';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { controlStoreFor } from '../storage/control-store.js';
import type { CoreDb } from '../storage/db.js';
import * as schema from '../storage/schema/index.js';
import {
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import { commandInputHash } from './idempotent-command.js';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** Private immutable candidate lineage carried in process, never on the Host wire. */
export const WorkerImageSettlementIdentitySchema = z
  .object({
    authoredArtifactId: ArtifactIdSchema,
    authoredArtifactVersion: z.literal(1),
    authoredContentDigest: digest,
    inputDigest: digest,
  })
  .strict();
/** Non-authorizing provenance for one preparation image result. */
export type WorkerImageSettlementIdentity = z.infer<typeof WorkerImageSettlementIdentitySchema>;
/** Exact completed result retained independently of a live Workspace or user credential. */
export const WorkerImageSettlementSchema = WorkerImageSettlementIdentitySchema.extend({
  requestId: z.string().regex(/^[0-9a-f]{64}$/),
  operation: z.enum(['image.acquire', 'image.build']),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('success'), imageDigest: digest }).strict(),
    z.object({ kind: z.literal('failure'), failureCode: z.literal('effect_failed') }).strict(),
  ]),
}).strict();
/** Durable validated image outcome without commands or dispatch authority. */
export type WorkerImageSettlement = z.infer<typeof WorkerImageSettlementSchema>;
/** Contradictory immutable settlement; it must never become retryable storage deferral. */
export class WorkerImageSettlementConflict extends Error {
  readonly status = 409;
  constructor() {
    super('Worker image settlement conflicts with its immutable result.');
  }
}
/** Delivery deferral for local persistence failure, distinct from a rejected Host result. */
export class WorkerImageSettlementDeferred extends Error {
  readonly status = 503;
  readonly code = 'recovery_required';
  constructor() {
    super('Worker image settlement persistence is deferred.');
  }
}

/** Reads one exact private settlement; storage errors remain errors, never absence. */
export function readWorkerImageSettlement(
  coreDb: CoreDb,
  requestId: string
): WorkerImageSettlement | null {
  const row = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, request_id AS requestId, operation,
    authored_artifact_id AS authoredArtifactId, authored_artifact_version AS authoredArtifactVersion,
    authored_content_digest AS authoredContentDigest, input_digest AS inputDigest,
    outcome, image_digest AS imageDigest, failure_code AS failureCode
    FROM worker_image_settlements WHERE request_id = ?`)
    .get(requestId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const {
    outcome,
    imageDigest,
    failureCode,
    schemaVersion: _schemaVersion,
    ...identity
  } = readRetainedV1(row, () => row);
  const parsed = WorkerImageSettlementSchema.safeParse({
    ...identity,
    outcome:
      outcome === 'success' ? { kind: outcome, imageDigest } : { kind: outcome, failureCode },
  });
  if (!parsed.success) throw new WorkerImageSettlementConflict();
  return parsed.data;
}

/**
 * Commits an exact image receipt, its journal outcome and next transition before acknowledgment.
 * @param coreDb Existing Core authority; the owning writer supplies the one synchronous transaction.
 * @param input Validated receiver result, never a command or replay grant.
 * @throws For conflicting results or unavailable persistence; no partial tuple is acknowledged.
 */
export function writeWorkerImageSettlement(coreDb: CoreDb, input: WorkerImageSettlement): void {
  const value = WorkerImageSettlementSchema.parse(input);
  controlStoreFor(coreDb.sqlite).write((sqlite) => {
    // Recovery may hold another handle to the same file; bind the whole tuple to its writer.
    const owningCoreDb =
      sqlite === coreDb.sqlite ? coreDb : { ...coreDb, sqlite, db: drizzle(sqlite, { schema }) };
    writeWorkerImageSettlementInTransaction(owningCoreDb, value, sqlite);
  });
}

/** Keeps every receipt and journal statement on the supplied owning transaction, never a caller's sibling handle. */
function writeWorkerImageSettlementInTransaction(
  coreDb: CoreDb,
  value: WorkerImageSettlement,
  sqlite: CoreDb['sqlite']
): void {
  if (sqlite !== coreDb.sqlite || !sqlite.inTransaction)
    throw new Error('Image settlement requires its owning connection.');
  const existing = readWorkerImageSettlement(coreDb, value.requestId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(value))
      throw new WorkerImageSettlementConflict();
    return;
  }
  sqlite
    .prepare(`INSERT INTO worker_image_settlements
      (request_id, operation, authored_artifact_id, authored_artifact_version, authored_content_digest,
       input_digest, outcome, image_digest, failure_code, created_at, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      value.requestId,
      value.operation,
      value.authoredArtifactId,
      value.authoredArtifactVersion,
      value.authoredContentDigest,
      value.inputDigest,
      value.outcome.kind,
      value.outcome.kind === 'success' ? value.outcome.imageDigest : null,
      value.outcome.kind === 'failure' ? value.outcome.failureCode : null,
      new Date().toISOString(),
      writeRetainedV1({}).schemaVersion
    );
  settleImageJournal(coreDb, value);
  if (JSON.stringify(readWorkerImageSettlement(coreDb, value.requestId)) !== JSON.stringify(value))
    throw new WorkerImageSettlementConflict();
}

/** Advances only the selected acquisition; existing build receipts and retained unjournaled results remain data. */
function settleImageJournal(coreDb: CoreDb, value: WorkerImageSettlement): void {
  if (value.operation !== 'image.acquire') return;
  const rows = coreDb.sqlite
    .prepare(`SELECT s.execution_id, s.step_id, s.state, s.span_json,
    s.control_json, r.work_id, r.revision, r.input_fingerprint, r.span_json AS root_span_json,
    r.exclusion_refs_json FROM control_execution_steps s JOIN control_executions r ON r.id = s.execution_id
    WHERE r.definition_version = ? AND json_extract(s.control_json, '$.kind') = 'resolve-setup'
    AND json_extract(s.invocation_json, '$.carriage.operation') = 'image.acquire'
    AND json_extract(s.invocation_json, '$.carriage.requestId') = ?`)
    .all(CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION, value.requestId) as {
    execution_id: string;
    step_id: string;
    state: string;
    span_json: string;
    control_json: string;
    work_id: string;
    revision: number;
    input_fingerprint: string;
    root_span_json: string;
    exclusion_refs_json: string;
  }[];
  if (rows.length === 0) return;
  if (rows.length !== 1) throw new WorkerImageSettlementConflict();
  const row = rows[0]!;
  const execution = { owner: { kind: 'server' as const }, executionId: row.execution_id };
  const originalRef = { execution, stepId: row.step_id };
  const originalSpan = JSON.parse(row.span_json);
  const now = BigInt(Date.now()) * 1_000_000n;
  const receiptRef = `worker-image-settlement/v1:${value.requestId}`;
  const state = value.outcome.kind === 'success' ? 'completed' : 'failed';
  const status = { code: value.outcome.kind === 'success' ? ('OK' as const) : ('ERROR' as const) };
  if (row.state === 'intent') {
    settleExecutionJournalStep(coreDb, {
      ref: originalRef,
      expectedExecutionRevision: row.revision,
      state,
      outputRefs: [receiptRef],
      span: {
        ...originalSpan,
        endTimeUnixNano:
          now < BigInt(originalSpan.startTimeUnixNano)
            ? BigInt(originalSpan.startTimeUnixNano)
            : now,
        status,
      },
      // A typed failure is not complete-domain absence or writer-release proof.
      nextPhase: value.outcome.kind === 'success' ? 'closed' : 'closing',
      terminalCause: value.outcome.kind === 'failure' ? 'Image acquisition failed.' : null,
      exclusionRefs: value.outcome.kind === 'success' ? [] : JSON.parse(row.exclusion_refs_json),
    });
    return;
  }
  if (row.state !== 'unknown') throw new WorkerImageSettlementConflict();
  // A late receiver result is a separately bounded local consumption, not a rewrite or new remote call.
  const rootSpan = JSON.parse(row.root_span_json);
  const control = JSON.parse(row.control_json);
  const stepId = randomUUID();
  const span = {
    ...originalSpan,
    spanId: randomBytes(8).toString('hex'),
    parentSpanId: rootSpan.spanId,
    name: 'image.acquire result reconciliation',
    kind: 'INTERNAL',
    startTimeUnixNano: now,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [],
    events: [],
    links: [
      {
        traceId: originalSpan.traceId,
        spanId: originalSpan.spanId,
        flags: originalSpan.flags,
        attributes: [],
        droppedAttributesCount: 0,
      },
    ],
  };
  writeExecutionJournalIntent(coreDb, {
    execution: {
      ref: execution,
      definitionVersion: CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
      workId: row.work_id,
      fingerprint: row.input_fingerprint,
      exclusionRefs: JSON.parse(row.exclusion_refs_json),
      span: rootSpan,
    },
    stepId,
    parentStepId: null,
    parent: null,
    inspectedStep: originalRef,
    carriage: {
      operation: 'image.acquire',
      requestId: value.requestId,
      sequence: null,
      bindingRef: null,
    },
    control: {
      ...control,
      kind: 'consume-receipt',
      target: null,
      invocationId: randomUUID(),
      inputRefs: [receiptRef],
      outputRefs: [],
      fingerprint: commandInputHash(value),
      retryPermitted: false,
      deadlineUnixNano: now,
      physicalFenceRefs: control.physicalFenceRefs,
    },
    span,
  });
  const revision = coreDb.sqlite
    .prepare('SELECT revision FROM control_executions WHERE id = ?')
    .get(row.execution_id) as { revision: number };
  settleExecutionJournalStep(coreDb, {
    ref: { execution, stepId },
    expectedExecutionRevision: revision.revision,
    state,
    outputRefs: [receiptRef],
    span: { ...span, endTimeUnixNano: now, status },
    nextPhase: 'closing',
    terminalCause: 'Original image acquisition outcome remains unknown.',
    exclusionRefs: JSON.parse(row.exclusion_refs_json),
  });
}

/** Validates admitted default bytes again on durable read; corruption never becomes empty defaults. */
function checkedImageEnvironment(value: unknown) {
  const record = NativeEnvironmentRecordSchema.parse(value);
  if (
    `sha256:${createHash('sha256').update(canonicalNativeEnvironment(record.values), 'utf8').digest('hex')}` !==
    record.defaultsDigest
  )
    throw new WorkerImageSettlementConflict();
  return {
    ...record,
    values: Object.fromEntries(
      Object.entries(record.values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    ),
  };
}

/** Adds exact confirmed defaults to the existing acquisition/build settlement, without rewriting its result. */
export function admitWorkerImageEnvironment(
  coreDb: CoreDb,
  candidate: WorkerImageSettlementIdentity,
  input: unknown
): void {
  const environment = checkedImageEnvironment(input);
  const identity = WorkerImageSettlementIdentitySchema.parse(candidate);
  const previous = readAdmittedWorkerImageEnvironment(coreDb, environment.imageDigest);
  if (previous && JSON.stringify(previous) !== JSON.stringify(environment))
    throw new WorkerImageSettlementConflict();
  const rows = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, request_id AS requestId FROM worker_image_settlements
    WHERE authored_artifact_id = ? AND authored_artifact_version = ? AND authored_content_digest = ? AND input_digest = ? AND outcome = 'success' AND image_digest = ?`)
    .all(
      identity.authoredArtifactId,
      identity.authoredArtifactVersion,
      identity.authoredContentDigest,
      identity.inputDigest,
      environment.imageDigest
    ) as { schemaVersion: unknown; requestId: string }[];
  if (rows.length !== 1) throw new WorkerImageSettlementConflict();
  const row = readRetainedV1(rows[0]!, () => rows[0]!);
  const bytes = JSON.stringify(environment);
  coreDb.sqlite
    .prepare(
      'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ? AND native_environment_json IS NULL'
    )
    .run(bytes, row.requestId);
  const admitted = readAdmittedWorkerImageEnvironment(coreDb, environment.imageDigest);
  if (JSON.stringify(admitted) !== bytes) throw new WorkerImageSettlementConflict();
}

/** Finds only confirmed exact-image defaults; mere successful acquisition is not admission. */
export function readAdmittedWorkerImageEnvironment(coreDb: CoreDb, imageDigest: string) {
  digest.parse(imageDigest);
  const rows = coreDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, native_environment_json AS environment FROM worker_image_settlements WHERE image_digest = ? AND outcome = 'success' AND native_environment_json IS NOT NULL`
    )
    .all(imageDigest) as { schemaVersion: unknown; environment: string }[];
  if (!rows.length) return null;
  const records = rows.map((row) =>
    readRetainedV1(row, () => checkedImageEnvironment(JSON.parse(row.environment)))
  );
  if (
    records.some(
      (record) =>
        record.imageDigest !== imageDigest || JSON.stringify(record) !== JSON.stringify(records[0])
    )
  )
    throw new WorkerImageSettlementConflict();
  return records[0]!;
}
