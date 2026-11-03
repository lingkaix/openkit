import { z } from 'zod';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { OperationError } from '../operation-error-core.js';
import {
  commandRequestKey,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { WorkspaceDb } from './db.js';
import { listWorkerOutputManifests } from './workspace-handoff-read.js';
import { resolveWorkspaceReconciliationRecord } from './workspace-reconciliation-decision.js';
import {
  type ControlWorkspaceRecoveryDecision,
  WorkspaceRecoveryDecisionRefusal,
} from './workspace-recovery-decision-codecs.js';

/** Current record/manifests decide in the original mutation stage; receipt failure preserves that committed prefix. */
export function applyWorkspaceRecoveryDecisionInDb(
  db: WorkspaceDb,
  input: ControlWorkspaceRecoveryDecision
) {
  if (input.action === 'receipt') {
    const { receipt } = input;
    if (
      receipt.scope.workspaceId !== input.workspaceId ||
      receipt.scope.reconciliationRecordId !== input.reconciliationRecordId ||
      receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
      receipt.expiresAt <= receipt.createdAt
    )
      throw new ControlProductPreconditionError();
    const { responseKind, ...record } = receipt;
    recordControlCommandRequestRecordInDb(db, {
      ...record,
      response: { kind: responseKind, id: input.reconciliationRecordId },
    });
    return null;
  }
  try {
    return resolveWorkspaceReconciliationRecord({
      workspaceDb: db,
      workspaceId: input.workspaceId,
      reconciliationRecordId: input.reconciliationRecordId,
      decision: input.decision,
      decidedAt: input.decidedAt,
      workerOutputManifests: listWorkerOutputManifests(db, input.workspaceId),
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new WorkspaceRecoveryDecisionRefusal('record_invalid');
    const id = input.reconciliationRecordId;
    if (
      error instanceof StoreRecordNotFoundError &&
      error.message === `Workspace reconciliation record not found: ${id}`
    )
      throw new WorkspaceRecoveryDecisionRefusal('missing');
    if (error instanceof OperationError && error.code === 'workspace_recovery_decision_failed') {
      if (
        error.status === 404 &&
        error.message === `Workspace reconciliation record is already terminal: ${id}`
      )
        throw new WorkspaceRecoveryDecisionRefusal('terminal');
      if (
        error.status === 409 &&
        error.message === 'Unaccepted capture source supports only abandon with evidence retained.'
      )
        throw new WorkspaceRecoveryDecisionRefusal('capture_source');
      if (
        error.status === 404 &&
        error.message === `Workspace recovery collection has no durable output manifest: ${id}`
      )
        throw new WorkspaceRecoveryDecisionRefusal('no_manifest');
    }
    throw error;
  }
}
