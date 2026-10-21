import { isDeepStrictEqual } from 'node:util';
import {
  EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS,
  type EvaluationCandidate,
  type JudgementRecord,
  JudgementRecordSchema,
} from '@openkit/app-api-schemas';
import { UserActorRefSchema, writeRetainedV1 } from '@openkit/protocol';
import {
  ArtifactReviewError,
  executeControlReviewCommand,
  getArtifactReview,
} from './artifact-reviews.js';
import type { Actor } from './auth/identity.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isArtifactVisible } from './auth/thread-visibility.js';
import { ArtifactAuthorityError, type FsStore, StoreRecordNotFoundError } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { IdempotentCommandReceipt } from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/** Current native identity, source files and existing Workspace transaction authority. */
export interface ArtifactJudgementAccess {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
  readonly actor: Actor;
}

/** Caller-authored assessment; server identity and time are never input fields. */
export type ArtifactJudgementInput = EvaluationCandidate & {
  readonly requestId: string;
  readonly note?: string | null;
  readonly extensions?: JudgementRecord['extensions'];
} & (
    | { readonly kind: 'accept' | 'reject'; readonly choice: null }
    | {
        readonly kind: 'rate';
        readonly choice: Extract<JudgementRecord, { kind: 'rate' }>['choice'];
      }
  );

/** Admits current write access and exact original bytes before inspecting any Review. */
function admit(access: ArtifactJudgementAccess, input: ArtifactJudgementInput) {
  const actor = UserActorRefSchema.safeParse({ kind: 'user', id: access.actor.userId });
  if (
    !actor.success ||
    !isWorkspaceOperationAuthorized(
      access.coreDb,
      access.actor,
      access.workspaceDb.workspaceId,
      EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS['evaluation.judgement-add']
    )
  )
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  const parsed = JudgementRecordSchema.safeParse(
    writeRetainedV1({
      workspaceId: access.workspaceDb.workspaceId,
      actor: actor.data,
      recordedAt: new Date().toISOString(),
      requestId: input.requestId,
      target: {
        kind: 'artifact-version',
        artifactId: input.artifactId,
        artifactVersion: input.artifactVersion,
        contentDigest: input.contentDigest,
      },
      kind: input.kind,
      choice: input.choice,
      note: input.note ?? null,
      extensions: input.extensions ?? {},
    })
  );
  if (!parsed.success)
    throw new OperationError('invalid_request', 'The Artifact assessment is invalid.', 400);
  access.store.getWorkspace(access.workspaceDb.workspaceId);
  try {
    const current = access.store.getArtifact(access.workspaceDb.workspaceId, input.artifactId);
    if (
      !isArtifactVisible(
        access.store,
        current,
        access.actor.userId,
        isCurrentDeploymentAdministrator(access.coreDb, access.actor)
      )
    )
      throw new OperationError('not_found', 'The exact Artifact source was not found.', 404);
    const exact = access.store.getArtifactVersion(
      access.workspaceDb.workspaceId,
      input.artifactId,
      input.artifactVersion
    );
    if (exact.version.contentDigest !== input.contentDigest)
      throw new OperationError(
        'source_digest_mismatch',
        'The assessment digest does not match the exact retained Artifact.',
        400
      );
    const version = exact.version;
    const turn =
      version.threadId !== null && version.turnId !== null
        ? access.store.getTurn(access.workspaceDb.workspaceId, version.threadId, version.turnId)
        : null;
    return { judgement: parsed.data, version, turn };
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError)
      throw new OperationError('not_found', 'The exact Artifact source was not found.', 404);
    if (error instanceof ArtifactAuthorityError)
      throw new OperationError(error.code, error.message, error.status, { cause: error });
    throw error;
  }
}

/** Reads and verifies the exact publication tuple without reconstructing proposal authority. */
function review(access: ArtifactJudgementAccess, admitted: ReturnType<typeof admit>) {
  let retained: ReturnType<typeof getArtifactReview>;
  try {
    retained = getArtifactReview(
      access.workspaceDb,
      admitted.version.artifactId,
      admitted.version.artifactVersion
    );
  } catch (error) {
    if (!(error instanceof ArtifactReviewError) || error.code !== 'stale') throw error;
    if (admitted.turn?.agentId || (admitted.turn !== null && admitted.turn.status !== 'completed'))
      throw recovery('The producing Artifact Review authority is missing.');
    return null;
  }
  if (
    retained.contentDigest !== admitted.version.contentDigest ||
    retained.sourceThreadId !== admitted.version.threadId ||
    retained.sourceTurnId !== admitted.version.turnId ||
    retained.sourceAgentId !== (admitted.turn?.agentId ?? null) ||
    retained.createdAt !== admitted.version.recordedAt
  )
    throw recovery('The Review does not match its exact Artifact publication.');
  return retained;
}

/** Finds an exact replay after current admission, returning null only when no accepted annotation exists. */
export function readArtifactJudgement(
  access: ArtifactJudgementAccess,
  input: ArtifactJudgementInput
): JudgementRecord | null {
  const admitted = admit(access, input);
  const previous = review(access, admitted)?.judgements.find(
    (entry) => entry.requestId === input.requestId
  );
  if (!previous) return null;
  assertSameAssessment(previous, admitted.judgement);
  return previous;
}

/** Commits one admitted annotation and its original receipt through the Review family's single native writer. */
export async function appendArtifactJudgement(
  access: ArtifactJudgementAccess,
  input: ArtifactJudgementInput,
  receipt: IdempotentCommandReceipt
): Promise<JudgementRecord> {
  const admitted = admit(access, input);
  const retained = review(access, admitted);
  if (
    receipt.command !== 'evaluation.judgement-add' ||
    receipt.responseKind !== 'evaluation_judgement'
  )
    throw recovery('Artifact judgement has no matching original command.');
  const publication =
    retained === null
      ? {
          artifactId: admitted.version.artifactId,
          artifactVersion: admitted.version.artifactVersion,
          contentDigest: admitted.version.contentDigest,
          sourceThreadId: admitted.version.threadId,
          sourceTurnId: admitted.version.turnId,
          sourceAgentId: null,
          materialProposal: null,
          createdAt: admitted.version.recordedAt,
        }
      : null;
  return (
    await executeControlReviewCommand(access.workspaceDb, {
      mode: 'judgement',
      publication,
      judgement: admitted.judgement,
      receipt: {
        ...receipt,
        command: 'evaluation.judgement-add',
        responseKind: 'evaluation_judgement',
      },
    })
  ).value;
}

/** Request identity binds the authenticated author and every caller-authored assessment field. */
function assertSameAssessment(previous: JudgementRecord, expected: JudgementRecord): void {
  if (
    previous.kind !== expected.kind ||
    !isDeepStrictEqual(previous.actor, expected.actor) ||
    !isDeepStrictEqual(previous.target, expected.target) ||
    !isDeepStrictEqual(previous.choice, expected.choice) ||
    previous.note !== expected.note ||
    !isDeepStrictEqual(previous.extensions, expected.extensions)
  )
    throw new OperationError(
      'conflict',
      'The judgement request identity owns a different assessment.',
      409
    );
}

/** Missing or contradictory retained owner proof is not repaired by an annotation command. */
function recovery(message: string) {
  return new OperationError('recovery_required', message, 409);
}
