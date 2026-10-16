import { describe, expect, it, vi } from 'vitest';
import { ArtifactReviewFollowUpRequestSchema } from '../artifact-reviews.js';
import { StructuredWorkerDelegationRequestSchema } from '../internal-agents/delegation.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { WorkspaceDeletionClosureSchema } from '../workspace-deletion-evidence.js';
import { WorkspaceDeletionRequestRecordSchema } from '../workspace-deletion-request.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import { WorkerControlLineageRequestSchema } from './worker-http.js';
import { WorkerImageSettlementIdentitySchema } from './worker-image-settlements.js';

/** Builds a preparation boundary whose first backend read is observable and deliberately unavailable. */
function fixture() {
  const store = createDemoStore();
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Prepare one Worker',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
  );
  const read = vi.fn(() => {
    throw new Error('Fixture backend is unavailable.');
  });
  const backend = { readThreadAgentSessionBinding: read } as unknown as WorkerGovernanceBackend;
  const executor = new WorkerGovernanceTurnExecutor({ backend });
  const input = {
    agentSetup: createTestAgentSetup(),
    freshAgentSessionId: 'as_01890f3e-0000-7000-8000-000000000001',
    requestId: 'worker-identity-boundary',
    turn,
    turnInput: 'Prepare one Worker',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  };
  return { store, executor, input, read };
}

describe('Worker identity admission', () => {
  it.each([
    'as_legacy',
    'as_01890f3e-0000-4000-8000-000000000001',
    'as_01890f3e-0000-5000-8000-000000000001',
    'th_01890f3e-0000-7000-8000-000000000001',
    'as_01890F3E-0000-7000-8000-000000000001',
  ])('refuses an invalid reserved identity before the first backend contact: %s', async (id) => {
    const f = fixture();
    await expect(
      f.executor.prepareAgentSessionForTurn(f.store, { ...f.input, freshAgentSessionId: id })
    ).rejects.toMatchObject({
      code: 'recovery_required',
      message: 'The reserved AgentSession identity is invalid.',
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(
      f.store.listThreadAgentSessions(f.input.turn.workspaceId, f.input.turn.threadId)
    ).toEqual([]);
  });

  it('admits the canonical kind to the existing backend readiness check', async () => {
    const f = fixture();
    await expect(f.executor.prepareAgentSessionForTurn(f.store, f.input)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(f.read).toHaveBeenCalledExactlyOnceWith({
      workspaceId: f.input.turn.workspaceId,
      threadId: f.input.turn.threadId,
    });
  });
});

describe('private Worker HTTP lineage', () => {
  const uuid = '01890f3e-0000-7000-8000-000000000001';
  const lineage = {
    workspaceId: `ws_${uuid}`,
    threadId: `th_${uuid}`,
    turnId: `tu_${uuid}`,
    agentSessionId: `as_${uuid}`,
    packageSnapshotId: 'opaque-package',
  };
  it.each([
    ['workspaceId', 'ws'],
    ['threadId', 'th'],
    ['turnId', 'tu'],
    ['agentSessionId', 'as'],
  ] as const)('validates the named %s before route authority lookup', (field, kind) => {
    expect(WorkerControlLineageRequestSchema.safeParse(lineage).success).toBe(true);
    for (const invalid of [
      `${kind}_old`,
      `wrong_${uuid}`,
      `${kind}_${uuid.replace('-7000-', '-4000-')}`,
      `${kind}_${uuid}\n`,
    ]) {
      expect(
        WorkerControlLineageRequestSchema.safeParse({ ...lineage, [field]: invalid }).success
      ).toBe(false);
    }
  });
});

describe('private retained named identities', () => {
  const review = StructuredWorkerDelegationRequestSchema.shape.reviewContext.unwrap();
  it.each([
    { kind: 'wsexp', schema: WorkspaceDeletionRequestRecordSchema.shape.recoveryExportId },
    { kind: 'wsexp', schema: WorkspaceDeletionClosureSchema.shape.recoveryExportId },
    { kind: 'usr', schema: WorkspaceDeletionRequestRecordSchema.shape.originalOwnerUserId },
    { kind: 'aud', schema: WorkspaceDeletionRequestRecordSchema.shape.terminalAuditEventId },
    { kind: 'usr', schema: WorkspaceDeletionClosureSchema.shape.originalOwnerUserId },
    { kind: 'arev', schema: ArtifactReviewFollowUpRequestSchema.shape.reviewId },
    { kind: 'th', schema: ArtifactReviewFollowUpRequestSchema.shape.sourceThreadId },
    { kind: 'tu', schema: ArtifactReviewFollowUpRequestSchema.shape.sourceTurnId },
    { kind: 'ar', schema: WorkerImageSettlementIdentitySchema.shape.authoredArtifactId },
    { kind: 'tu', schema: review.options[0].shape.priorTurnId },
    { kind: 'tu', schema: review.options[1].shape.priorTurnId },
    { kind: 'it', schema: review.options[0].shape.evidence.shape.itemIds.element },
    { kind: 'ar', schema: review.options[0].shape.evidence.shape.artifactIds.element },
  ])('refuses a wrong kind for retained $kind metadata', ({ kind, schema }) => {
    const uuid = '01890f3e-0000-7000-8000-000000000001';
    expect(schema.safeParse(`${kind}_${uuid}`).success).toBe(true);
    for (const invalid of [`wrong_${uuid}`, `${kind}_old`, `${kind}_${uuid}\n`])
      expect(schema.safeParse(invalid).success).toBe(false);
  });
});

it.each([
  ['workspace', 'ws'],
  ['thread', 'th'],
  ['artifact', 'ar'],
  ['item', 'it'],
] as const)('types the private %s instruction reference', (kind, prefix) => {
  const schema = StructuredWorkerDelegationRequestSchema.shape.contextRefs.element;
  const uuid = '01890f3e-0000-7000-8000-000000000001';
  expect(schema.safeParse({ kind, id: `${prefix}_${uuid}` }).success).toBe(true);
  expect(schema.safeParse({ kind, id: `wrong_${uuid}` }).success).toBe(false);
  expect(
    schema.safeParse({ kind, id: `${prefix}_${uuid}`, annotation: 'unsupported instruction' })
      .success
  ).toBe(false);
});
