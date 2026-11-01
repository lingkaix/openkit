import { isDeepStrictEqual } from 'node:util';
import {
  type CandidateSetRecord,
  CandidateSetRecordReaderSchema,
  CandidateSetRecordSchema,
} from '@openkit/app-api-schemas';
import { commandRequestKey } from '../lib/store.js';
import { IdempotencyKeyConflictError } from '../operation-error.js';
import {
  getCommandRequestRecordFromDb,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import {
  type ControlEvaluationCandidate,
  ControlEvaluationCandidateSchema,
  EvaluationCandidateCommandError,
} from './evaluation-candidate-codecs.js';

/** Reads one exact owning row on the writer connection, preserving raw descriptive history for append. */
function read(db: WorkspaceDb, candidateSetId: string) {
  const row = db.sqlite
    .prepare(
      'SELECT payload_json AS payloadJson FROM evaluation_candidate_sets WHERE workspace_id=? AND candidate_set_id=?'
    )
    .get(db.workspaceId, candidateSetId) as { payloadJson: string } | undefined;
  if (!row) return undefined;
  try {
    const raw = JSON.parse(row.payloadJson) as Record<string, unknown>;
    const record = CandidateSetRecordReaderSchema.parse(raw);
    if (record.workspaceId !== db.workspaceId || record.candidateSetId !== candidateSetId)
      throw recovery();
    return { raw, record };
  } catch {
    throw recovery();
  }
}
/** Missing or inconsistent original authority is refused without reconstruction. */
function recovery() {
  return new EvaluationCandidateCommandError(
    'recovery_required',
    'The candidate-set authority or request proof is unavailable.'
  );
}

/** Applies membership/history and the original receipt in the existing native savepoint; no nested commit or await. */
export function applyControlEvaluationCandidate(
  db: WorkspaceDb,
  value: ControlEvaluationCandidate
): CandidateSetRecord {
  assertControlProductWriter(db.sqlite);
  const input = ControlEvaluationCandidateSchema.parse(value);
  const receipt = input.receipt;
  const scope: Record<string, string> = { workspaceId: receipt.scope.workspaceId };
  if (receipt.scope.candidateSetId !== undefined)
    scope.candidateSetId = receipt.scope.candidateSetId;
  const create = input.mode === 'create';
  const judgement = input.mode === 'append' ? input.judgement : undefined;
  const candidateSetId = create
    ? input.record.candidateSetId
    : judgement!.target.kind === 'candidate-set'
      ? judgement!.target.candidateSetId
      : undefined;
  const select = receipt.command === 'evaluation.candidate-set-select';
  if (
    !candidateSetId ||
    receipt.scope.workspaceId !== db.workspaceId ||
    receipt.key !== commandRequestKey(receipt.command, receipt.requestId, scope) ||
    receipt.expiresAt <= receipt.createdAt ||
    (create
      ? receipt.command !== 'evaluation.candidate-set-create' ||
        input.record.workspaceId !== db.workspaceId ||
        candidateSetId !== receipt.requestId ||
        input.record.judgements.length !== 0 ||
        receipt.scope.candidateSetId !== undefined
      : receipt.command === 'evaluation.candidate-set-create' ||
        judgement!.workspaceId !== db.workspaceId ||
        judgement!.requestId !== receipt.requestId ||
        (select
          ? judgement!.kind !== 'select' || receipt.scope.candidateSetId !== candidateSetId
          : receipt.scope.candidateSetId !== undefined ||
            judgement!.kind === 'select' ||
            judgement!.kind === 'correct')) ||
    receipt.responseKind !==
      (receipt.command === 'evaluation.judgement-add'
        ? 'evaluation_judgement'
        : 'evaluation_candidate_set')
  )
    throw new ControlProductPreconditionError();
  const existing = read(db, candidateSetId);
  const prior = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
  if (prior) {
    if (prior.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
    if (
      prior.command !== receipt.command ||
      prior.requestId !== receipt.requestId ||
      !isDeepStrictEqual(prior.scope, scope) ||
      prior.response.kind !== receipt.responseKind ||
      prior.response.id !==
        (receipt.command === 'evaluation.judgement-add' ? receipt.requestId : candidateSetId) ||
      !existing
    )
      throw recovery();
    if (create) {
      if (
        !isDeepStrictEqual(existing.record.candidates, input.record.candidates) ||
        !isDeepStrictEqual(existing.record.createdBy, input.record.createdBy)
      )
        throw recovery();
      return { ...existing.record, judgements: [] };
    }
    const index = existing.record.judgements.findIndex((j) => j.requestId === receipt.requestId);
    const previous = existing.record.judgements[index];
    if (
      !previous ||
      previous.kind !== judgement!.kind ||
      !isDeepStrictEqual(previous.actor, judgement!.actor) ||
      !isDeepStrictEqual(previous.choice, judgement!.choice) ||
      previous.note !== judgement!.note ||
      (!select && !isDeepStrictEqual(previous.extensions, judgement!.extensions))
    )
      throw recovery();
    return { ...existing.record, judgements: existing.record.judgements.slice(0, index + 1) };
  }
  let result: CandidateSetRecord;
  if (create) {
    if (existing) {
      if (
        !isDeepStrictEqual(existing.record.candidates, input.record.candidates) ||
        !isDeepStrictEqual(existing.record.createdBy, input.record.createdBy)
      )
        throw new EvaluationCandidateCommandError(
          'conflict',
          'The candidate-set creation identity already owns different membership.'
        );
      throw recovery();
    }
    result = input.record;
    db.sqlite
      .prepare(
        'INSERT INTO evaluation_candidate_sets (workspace_id,candidate_set_id,payload_json) VALUES (?,?,?)'
      )
      .run(db.workspaceId, candidateSetId, JSON.stringify(result));
  } else {
    if (!existing)
      throw new EvaluationCandidateCommandError(
        'not_found',
        'Candidate set or exact source not found.'
      );
    const record = existing.record;
    if (
      judgement!.kind === 'select' &&
      !record.candidates.some((candidate) => isDeepStrictEqual(candidate, judgement!.choice))
    )
      throw new EvaluationCandidateCommandError(
        'invalid_request',
        'The selected exact Artifact version is not a member of this candidate set.'
      );
    const previous = record.judgements.find((entry) => entry.requestId === receipt.requestId);
    if (previous) {
      if (
        previous.kind !== judgement!.kind ||
        !isDeepStrictEqual(previous.actor, judgement!.actor) ||
        !isDeepStrictEqual(previous.choice, judgement!.choice) ||
        previous.note !== judgement!.note
      )
        throw new EvaluationCandidateCommandError(
          'conflict',
          'The judgement request identity already owns a different assessment.'
        );
      throw recovery();
    }
    result = CandidateSetRecordSchema.parse({
      ...record,
      judgements: [...record.judgements, judgement!],
    });
    // Only history is changed. Keep every existing raw member and nested descriptive field byte-for-value.
    db.sqlite
      .prepare(
        'UPDATE evaluation_candidate_sets SET payload_json=? WHERE workspace_id=? AND candidate_set_id=?'
      )
      .run(
        JSON.stringify({
          ...existing.raw,
          judgements: [...(existing.raw.judgements as unknown[]), judgement!],
        }),
        db.workspaceId,
        candidateSetId
      );
  }
  recordControlCommandRequestRecordInDb(db, {
    ...receipt,
    scope,
    response: {
      kind: receipt.responseKind,
      id: receipt.command === 'evaluation.judgement-add' ? receipt.requestId : candidateSetId,
    },
  });
  return result;
}
