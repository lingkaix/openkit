import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CorrectMaterialRangeRequest,
  type JudgementRecord,
  JudgementRecordReaderSchema,
  JudgementRecordSchema,
} from '@openkit/app-api-schemas';
import { OperationError } from './operation-error.js';
import type { WorkspaceDb } from './storage/db.js';
import {
  assertWorkspaceMaterialRange,
  getWorkspaceMaterialRevision,
  saveWorkspaceMaterialRevision,
} from './workspace-materials.js';

type RangeTarget = Extract<JudgementRecord['target'], { kind: 'material-range' }>;
/** Trusted actor and timestamp are supplied by human command admission, not its public payload. */
export type MaterialRangeCorrectionInput = CorrectMaterialRangeRequest & {
  readonly actor: JudgementRecord['actor'];
  readonly acceptedAt: string;
};

/** Reads the target owner's raw annotation history while preserving unknown descriptive content for append. */
function retainedHistory(db: WorkspaceDb, target: RangeTarget): unknown[] {
  const row = db.sqlite
    .prepare(
      'SELECT judgements FROM workspace_material_revisions WHERE workspace_id = ? AND material_id = ? AND revision_id = ?'
    )
    .get(db.workspaceId, target.materialId, target.revisionId) as
    | { judgements: string }
    | undefined;
  if (!row) throw new OperationError('stale', 'The exact Material revision is unavailable.', 409);
  const raw: unknown = JSON.parse(row.judgements);
  const parsed = JudgementRecordReaderSchema.array().safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.some(
      (entry) =>
        entry.workspaceId !== db.workspaceId ||
        entry.target.kind !== 'material-range' ||
        entry.target.materialId !== target.materialId ||
        entry.target.revisionId !== target.revisionId ||
        entry.target.contentDigest !== target.contentDigest
    )
  )
    throw new OperationError(
      'recovery_required',
      'The Material annotation history is invalid.',
      409
    );
  return raw as unknown[];
}

/** Finds an accepted exact-range judgement for ordinary command replay after current Workspace admission. */
export function readMaterialJudgement(
  db: WorkspaceDb,
  target: RangeTarget,
  requestId: string
): JudgementRecord | null {
  assertWorkspaceMaterialRange(db, target);
  const records = JudgementRecordReaderSchema.array().parse(retainedHistory(db, target));
  const judgement = records.find((entry) => entry.requestId === requestId);
  if (!judgement) return null;
  if (!isDeepStrictEqual(judgement.target, target))
    throw new OperationError('conflict', 'The judgement request owns another original range.', 409);
  if (judgement.kind === 'correct' && judgement.choice.outcome === 'apply') {
    const result = getWorkspaceMaterialRevision(
      db,
      target.materialId,
      judgement.choice.resultingRevision.revisionId
    );
    if (
      result.contentDigest !== judgement.choice.resultingRevision.contentDigest ||
      result.parentRevisionId !== target.revisionId
    )
      throw new OperationError(
        'recovery_required',
        'The applied correction revision is unavailable.',
        409
      );
  }
  return judgement;
}

/** Appends immutable range feedback to its existing revision owner in the command transaction. */
export function appendMaterialJudgement(db: WorkspaceDb, record: JudgementRecord): JudgementRecord {
  if (!db.sqlite.inTransaction)
    throw new Error('Material judgement requires the existing Workspace transaction.');
  const judgement = JudgementRecordSchema.parse(record);
  if (
    judgement.workspaceId !== db.workspaceId ||
    judgement.target.kind !== 'material-range' ||
    judgement.kind === 'select'
  )
    throw new OperationError(
      'invalid_request',
      'The judgement must target this exact Material range.',
      400
    );
  assertWorkspaceMaterialRange(db, judgement.target);
  const raw = retainedHistory(db, judgement.target);
  if (
    JudgementRecordReaderSchema.array()
      .parse(raw)
      .some((entry) => entry.requestId === judgement.requestId)
  )
    throw new OperationError(
      'recovery_required',
      'The request-owned judgement exists without its command receipt.',
      409
    );
  db.sqlite
    .prepare(
      'UPDATE workspace_material_revisions SET judgements = ? WHERE workspace_id = ? AND material_id = ? AND revision_id = ?'
    )
    .run(
      JSON.stringify([...raw, judgement]),
      db.workspaceId,
      judgement.target.materialId,
      judgement.target.revisionId
    );
  return judgement;
}

/** Applies or rejects one exact range through the existing Material save owner, without rebasing. */
export function correctMaterialRange(
  db: WorkspaceDb,
  input: MaterialRangeCorrectionInput
): JudgementRecord {
  if (!db.sqlite.inTransaction)
    throw new Error('Material correction requires the existing Workspace transaction.');
  if (input.workspaceId !== db.workspaceId)
    throw new OperationError('not_found', 'Material Workspace not found.', 404);
  const original = assertWorkspaceMaterialRange(db, input.target);
  let choice: Extract<JudgementRecord, { kind: 'correct' }>['choice'];
  if (input.decision === 'reject')
    choice = { outcome: 'reject', replacementText: input.replacementText, resultingRevision: null };
  else {
    const content =
      original.content.slice(0, input.target.start) +
      input.replacementText +
      original.content.slice(input.target.end);
    const contentDigest = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
    const result = saveWorkspaceMaterialRevision(db, {
      actor: input.actor,
      acceptedAt: input.acceptedAt,
      requestId: input.requestId,
      materialId: input.target.materialId,
      expectedRevisionId: input.target.revisionId,
      content,
      contentDigest,
    });
    choice = {
      outcome: 'apply',
      replacementText: input.replacementText,
      resultingRevision: { ...result, contentDigest },
    };
  }
  return appendMaterialJudgement(
    db,
    JudgementRecordSchema.parse({
      formatVersion: 1,
      workspaceId: db.workspaceId,
      requestId: input.requestId,
      actor: input.actor,
      recordedAt: input.acceptedAt,
      kind: 'correct',
      target: input.target,
      choice,
      note: input.note,
      extensions: input.extensions,
    })
  );
}
