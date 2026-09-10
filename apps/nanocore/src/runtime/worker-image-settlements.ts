import { z } from 'zod';
import type { CoreDb } from '../storage/db.js';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** Private immutable candidate lineage carried in process, never on the Host wire. */
export const WorkerImageSettlementIdentitySchema = z
  .object({
    authoredArtifactId: z.string().min(1),
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
    .prepare(`SELECT request_id AS requestId, operation,
    authored_artifact_id AS authoredArtifactId, authored_artifact_version AS authoredArtifactVersion,
    authored_content_digest AS authoredContentDigest, input_digest AS inputDigest,
    outcome, image_digest AS imageDigest, failure_code AS failureCode
    FROM worker_image_settlements WHERE request_id = ?`)
    .get(requestId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const { outcome, imageDigest, failureCode, ...identity } = row;
  const parsed = WorkerImageSettlementSchema.safeParse({
    ...identity,
    outcome:
      outcome === 'success' ? { kind: outcome, imageDigest } : { kind: outcome, failureCode },
  });
  if (!parsed.success) throw new WorkerImageSettlementConflict();
  return parsed.data;
}

/** Persists one validated result before acknowledgment; creation time is not duplicate identity. */
export function writeWorkerImageSettlement(coreDb: CoreDb, input: WorkerImageSettlement): void {
  const value = WorkerImageSettlementSchema.parse(input);
  const existing = readWorkerImageSettlement(coreDb, value.requestId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(value))
      throw new WorkerImageSettlementConflict();
    return;
  }
  coreDb.sqlite
    .prepare(`INSERT INTO worker_image_settlements
    (request_id, operation, authored_artifact_id, authored_artifact_version, authored_content_digest,
     input_digest, outcome, image_digest, failure_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING`)
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
      new Date().toISOString()
    );
  if (
    JSON.stringify(readWorkerImageSettlement(coreDb, value.requestId)) !== JSON.stringify(value)
  ) {
    throw new WorkerImageSettlementConflict();
  }
}
