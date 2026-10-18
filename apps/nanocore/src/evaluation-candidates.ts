import { isDeepStrictEqual } from 'node:util';
import {
  type CandidateSetRecord,
  CandidateSetRecordReaderSchema,
  CandidateSetRecordSchema,
  type CreateCandidateSetRequest,
  EVALUATION_OPERATION_DEFINITIONS,
  type EvaluationCandidate,
  type JudgementRecord,
  JudgementRecordSchema,
  type SelectCandidateSetRequest,
} from '@openkit/app-api-schemas';
import { UserActorRefSchema } from '@openkit/protocol';
import type { Actor } from './auth/identity.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isArtifactVisible } from './auth/thread-visibility.js';
import {
  ArtifactAuthorityError,
  type CommandRequestRecord,
  type FsStore,
  StoreRecordNotFoundError,
} from './lib/store.js';
import { OperationError } from './operation-error.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { preserveDescriptiveRecord } from './storage/workspace-file-records.js';

/** Existing authenticated authority and SQLite scope; no caller payload supplies these facts. */
export interface CandidateSetAccess {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
  readonly actor: Actor;
}

/** Reuses the existing command receipt owner with the same Workspace transaction. */
export interface CandidateSetCommands extends CandidateSetAccess {
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}

/** Current set-owned assessment choices; the existing judgement union owns their retained form. */
export type CandidateSetJudgementInput = {
  readonly candidateSetId: string;
  readonly requestId: string;
  readonly note?: string | null;
  readonly extensions?: JudgementRecord['extensions'];
} & (
  | { readonly kind: 'select'; readonly choice: EvaluationCandidate }
  | { readonly kind: 'accept' | 'reject'; readonly choice: null }
  | { readonly kind: 'rate'; readonly choice: Extract<JudgementRecord, { kind: 'rate' }>['choice'] }
);

type OperationId = keyof typeof EVALUATION_OPERATION_DEFINITIONS;
type Row = { readonly candidateSetId: string; readonly payloadJson: string };

/** Requires current native Workspace authority and derives the authenticated human actor. */
function admit(access: CandidateSetAccess, operation: OperationId) {
  const actor = UserActorRefSchema.safeParse({ kind: 'user', id: access.actor.userId });
  if (
    !actor.success ||
    !isWorkspaceOperationAuthorized(
      access.coreDb,
      access.actor,
      access.workspaceDb.workspaceId,
      EVALUATION_OPERATION_DEFINITIONS[operation]
    )
  )
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  access.store.getWorkspace(access.workspaceDb.workspaceId);
  return actor.data;
}

/** Verifies every exact original and current source audience before returning any membership. */
function admitCandidates(
  access: CandidateSetAccess,
  candidates: readonly EvaluationCandidate[]
): void {
  const administrator = isCurrentDeploymentAdministrator(access.coreDb, access.actor);
  for (const candidate of candidates) {
    try {
      const current = access.store.getArtifact(
        access.workspaceDb.workspaceId,
        candidate.artifactId
      );
      if (!isArtifactVisible(access.store, current, access.actor.userId, administrator))
        throw missing();
      const exact = access.store.getArtifactVersion(
        access.workspaceDb.workspaceId,
        candidate.artifactId,
        candidate.artifactVersion
      );
      if (exact.artifact.contentDigest !== candidate.contentDigest)
        throw new OperationError(
          'source_digest_mismatch',
          'A candidate does not match its exact retained Artifact version.',
          400
        );
    } catch (error) {
      if (error instanceof StoreRecordNotFoundError) throw missing();
      if (error instanceof ArtifactAuthorityError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      throw error;
    }
  }
}

/** Parses one canonical payload without rewriting descriptive additions. */
function parseRow(access: CandidateSetAccess, row: Row) {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payloadJson);
  } catch {
    throw recovery();
  }
  const parsed = CandidateSetRecordReaderSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.workspaceId !== access.workspaceDb.workspaceId ||
    parsed.data.candidateSetId !== row.candidateSetId
  )
    throw recovery();
  return { raw, record: parsed.data };
}

/** Reads exact membership after current Workspace and every-source admission. */
export function readCandidateSet(
  access: CandidateSetAccess,
  candidateSetId: string
): CandidateSetRecord {
  admit(access, 'evaluation.candidate-set-read');
  const row = access.workspaceDb.sqlite
    .prepare(
      'SELECT candidate_set_id AS candidateSetId, payload_json AS payloadJson FROM evaluation_candidate_sets WHERE workspace_id = ? AND candidate_set_id = ?'
    )
    .get(access.workspaceDb.workspaceId, candidateSetId) as Row | undefined;
  if (!row) throw missing();
  const { record } = parseRow(access, row);
  admitCandidates(access, record.candidates);
  return record;
}

/** Omits a complete inaccessible set; it never discloses a partial membership or partial history. */
export function listCandidateSets(access: CandidateSetAccess): CandidateSetRecord[] {
  admit(access, 'evaluation.candidate-set-list');
  const rows = access.workspaceDb.sqlite
    .prepare(
      'SELECT candidate_set_id AS candidateSetId, payload_json AS payloadJson FROM evaluation_candidate_sets WHERE workspace_id = ? ORDER BY rowid'
    )
    .all(access.workspaceDb.workspaceId) as Row[];
  const records: CandidateSetRecord[] = [];
  for (const row of rows) {
    const { record } = parseRow(access, row);
    try {
      admitCandidates(access, record.candidates);
      records.push(record);
    } catch (error) {
      if (!(error instanceof OperationError && error.code === 'not_found')) throw error;
    }
  }
  return records;
}

/** Creates immutable ordered membership with its ordinary transaction-owned command receipt. */
export async function createCandidateSet(
  access: CandidateSetCommands,
  input: CreateCandidateSetRequest
): Promise<CandidateSetRecord> {
  const actor = admit(access, 'evaluation.candidate-set-create');
  if (input.workspaceId !== access.workspaceDb.workspaceId) throw missing();
  admitCandidates(access, input.candidates);
  return runIdempotentCommand({
    store: access.store,
    inflightCommands: access.inflightCommands,
    workspaceDb: access.workspaceDb,
    workspaceTransaction: true,
    command: 'evaluation.candidate-set-create',
    requestId: input.requestId,
    scope: { workspaceId: input.workspaceId },
    input: { actor, candidates: input.candidates },
    responseKind: 'evaluation_candidate_set',
    responseId: (record) => record.candidateSetId,
    execute: () => {
      admit(access, 'evaluation.candidate-set-create');
      admitCandidates(access, input.candidates);
      const parsed = CandidateSetRecordSchema.safeParse({
        formatVersion: 1,
        workspaceId: input.workspaceId,
        candidateSetId: input.requestId,
        createdBy: actor,
        createdAt: new Date().toISOString(),
        candidates: input.candidates,
        judgements: [],
        extensions: {},
      });
      if (!parsed.success)
        throw new OperationError(
          'invalid_request',
          'Candidate membership must contain at least two distinct exact Artifact versions.',
          400
        );
      const existing = access.workspaceDb.sqlite
        .prepare(
          'SELECT candidate_set_id AS candidateSetId, payload_json AS payloadJson FROM evaluation_candidate_sets WHERE workspace_id = ? AND candidate_set_id = ?'
        )
        .get(input.workspaceId, input.requestId) as Row | undefined;
      if (existing) {
        const { record } = parseRow(access, existing);
        if (
          !isDeepStrictEqual(record.candidates, input.candidates) ||
          !isDeepStrictEqual(record.createdBy, actor)
        )
          throw new OperationError(
            'conflict',
            'The candidate-set creation identity already owns different membership.',
            409
          );
        throw recovery();
      }
      access.workspaceDb.sqlite
        .prepare(
          'INSERT INTO evaluation_candidate_sets (workspace_id, candidate_set_id, payload_json) VALUES (?, ?, ?)'
        )
        .run(input.workspaceId, input.requestId, JSON.stringify(parsed.data));
      return parsed.data;
    },
    replay: (receipt) => {
      assertReceipt(receipt, input.requestId);
      const record = readCandidateSet(access, input.requestId);
      if (
        !isDeepStrictEqual(record.candidates, input.candidates) ||
        !isDeepStrictEqual(record.createdBy, actor)
      )
        throw recovery();
      return { ...record, judgements: [] };
    },
  });
}

/** Appends set-owned judgement in the caller's existing Workspace transaction; no second judgement store exists. */
export function appendCandidateSetJudgement(
  access: CandidateSetAccess,
  input: CandidateSetJudgementInput
): CandidateSetRecord {
  const actor = admit(access, 'evaluation.candidate-set-select');
  if (!access.workspaceDb.sqlite.inTransaction)
    throw new Error('Candidate judgement requires the existing Workspace transaction.');
  const record = readCandidateSet(access, input.candidateSetId);
  const judgement = JudgementRecordSchema.parse({
    formatVersion: 1,
    workspaceId: access.workspaceDb.workspaceId,
    requestId: input.requestId,
    actor,
    recordedAt: new Date().toISOString(),
    kind: input.kind,
    target: { kind: 'candidate-set', candidateSetId: input.candidateSetId },
    choice: input.choice,
    note: input.note ?? null,
    extensions: input.extensions ?? {},
  });
  if (
    input.kind === 'select' &&
    !record.candidates.some((candidate) => isDeepStrictEqual(candidate, input.choice))
  )
    throw new OperationError(
      'invalid_request',
      'The selected exact Artifact version is not a member of this candidate set.',
      400
    );
  const previous = record.judgements.find((entry) => entry.requestId === input.requestId);
  if (previous) {
    if (
      previous.kind !== judgement.kind ||
      !isDeepStrictEqual(previous.actor, actor) ||
      !isDeepStrictEqual(previous.choice, judgement.choice) ||
      previous.note !== judgement.note
    )
      throw new OperationError(
        'conflict',
        'The judgement request identity already owns a different assessment.',
        409
      );
    throw recovery();
  }
  const updated = CandidateSetRecordSchema.parse({
    ...record,
    judgements: [...record.judgements, judgement],
  });
  const row = access.workspaceDb.sqlite
    .prepare(
      'SELECT candidate_set_id AS candidateSetId, payload_json AS payloadJson FROM evaluation_candidate_sets WHERE workspace_id = ? AND candidate_set_id = ?'
    )
    .get(access.workspaceDb.workspaceId, input.candidateSetId) as Row;
  const { raw } = parseRow(access, row);
  access.workspaceDb.sqlite
    .prepare(
      'UPDATE evaluation_candidate_sets SET payload_json = ? WHERE workspace_id = ? AND candidate_set_id = ?'
    )
    .run(
      JSON.stringify(preserveDescriptiveRecord(raw, record, updated)),
      access.workspaceDb.workspaceId,
      input.candidateSetId
    );
  return updated;
}

/** Appends one exact member choice and replays its original authoritative history prefix. */
export async function selectCandidateSet(
  access: CandidateSetCommands,
  input: SelectCandidateSetRequest
): Promise<CandidateSetRecord> {
  const actor = admit(access, 'evaluation.candidate-set-select');
  if (input.workspaceId !== access.workspaceDb.workspaceId) throw missing();
  readCandidateSet(access, input.candidateSetId);
  return runIdempotentCommand({
    store: access.store,
    inflightCommands: access.inflightCommands,
    workspaceDb: access.workspaceDb,
    workspaceTransaction: true,
    command: 'evaluation.candidate-set-select',
    requestId: input.requestId,
    scope: { workspaceId: input.workspaceId, candidateSetId: input.candidateSetId },
    input: { actor, choice: input.choice, note: input.note ?? null },
    responseKind: 'evaluation_candidate_set',
    responseId: (record) => record.candidateSetId,
    // Set membership owns this choice; do not also append a version-owned Review choice.
    execute: () =>
      appendCandidateSetJudgement(access, { ...input, kind: 'select', note: input.note ?? null }),
    replay: (receipt) => {
      assertReceipt(receipt, input.candidateSetId);
      const record = readCandidateSet(access, input.candidateSetId);
      const index = record.judgements.findIndex(
        (judgement) => judgement.requestId === input.requestId
      );
      const judgement = record.judgements[index];
      if (
        !judgement ||
        judgement.kind !== 'select' ||
        !isDeepStrictEqual(judgement.actor, actor) ||
        !isDeepStrictEqual(judgement.choice, input.choice) ||
        judgement.note !== (input.note ?? null)
      )
        throw recovery();
      return { ...record, judgements: record.judgements.slice(0, index + 1) };
    },
  });
}

/** Requires the existing receipt to point at this Workspace-scoped creation identity. */
function assertReceipt(receipt: CommandRequestRecord, candidateSetId: string): void {
  if (
    receipt.response.kind !== 'evaluation_candidate_set' ||
    receipt.response.id !== candidateSetId
  )
    throw recovery();
}

/** Uniform current-source refusal without disclosing hidden membership. */
function missing(): OperationError {
  return new OperationError('not_found', 'Candidate set or exact source not found.', 404);
}
/** Existing command-owner unknown-result refusal; no reconstruction or repair is attempted. */
function recovery(): OperationError {
  return new OperationError(
    'recovery_required',
    'The candidate-set authority or request proof is unavailable.',
    409
  );
}
