import { ThreadTimelineResponseSchema } from '@openkit/app-api-schemas';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import * as auditOwner from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createApp } from '../test-support/app.js';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { operationRequest } from '../test-support/operation-request.js';
import { openWorkspaceDb } from './db.js';
import type { ThreadTimelineSnapshot } from './workspace-file-records.js';

/** Finds the actual public run fact without assuming a private facade result container or key order. */
function hasAllowedStop(value: unknown, actorId: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  const fact = node.interruptedBy;
  if (fact !== null && typeof fact === 'object') {
    const candidate = fact as { visibility?: unknown; actor?: { id?: unknown; kind?: unknown } };
    if (
      candidate.visibility === 'available' &&
      candidate.actor?.kind === 'user' &&
      candidate.actor.id === actorId
    )
      return true;
  }
  return Object.values(node).some((child) => hasAllowedStop(child, actorId));
}

/** Kernel-result injection; not native authority proof */
it('rejects denied-allowed-denied audit policy drift after the original privileged projection', async () => {
  const f = await navigationFixture();
  await f.store.completeTurn(f.turn.id, {
    status: 'interrupted',
    completedAt: '2026-11-08T17:00:00.000Z',
  });
  const stopActor = { kind: 'user' as const, id: allocateEntityId('usr') };
  const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
  try {
    auditOwner.recordWorkspaceAuditEvent({
      workspaceDb: db,
      workspaceId: f.workspaceId,
      threadId: f.thread.id,
      turnId: f.turn.id,
      actor: stopActor,
      action: 'turn.interrupt',
      resource: `turn:${f.turn.id}`,
      outcome: 'succeeded',
      summary: 'Recorded interruption for policy race.',
    });
  } finally {
    db.sqlite.close();
  }
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: f.actor.id,
    scope: 'workspace',
    workspaceIds: [f.workspaceId],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const app = createApp({ mode: 'server', dataRoot: f.dataRoot, coreDb: f.coreDb, store: f.store });
  const headers = { authorization: `Bearer ${token.secret}` };
  const timeline = () =>
    app.request(
      ...operationRequest(
        'thread.timeline',
        {
          workspaceId: f.workspaceId,
          threadId: f.thread.id,
          view: 'runs',
          anchor: { kind: 'latest' },
          limit: 1,
        },
        { headers }
      )
    );
  const audit = () =>
    app.request(
      ...operationRequest('audit.workspace-list', { workspaceId: f.workspaceId }, { headers })
    );
  const thread = () =>
    app.request(
      ...operationRequest(
        'thread.read',
        { workspaceId: f.workspaceId, threadId: f.thread.id },
        { headers }
      )
    );
  let phase: 'entry-denied' | 'projection-allowed' | 'final-denied' = 'entry-denied';
  const decisions: Array<{ phase: string; effect: string }> = [];
  const actual = policyKernel.evaluateAccess;
  // Kernel-result injection; not native authority proof
  const kernel = vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) => {
    const decision = actual(
      phase === 'projection-allowed'
        ? policy
        : {
            ...policy,
            associations: policy.associations.map((association) => ({
              ...association,
              accessRights: association.accessRights.filter((right) => right !== 'ar:audit-read'),
            })),
          },
      request
    );
    if (request.operation === 'audit.read') decisions.push({ phase, effect: decision.effect });
    return decision;
  });
  onTestFinished(() => kernel.mockRestore());
  expect((await thread()).status).toBe(200);
  expect((await audit()).status).toBe(403);
  const deniedResponse = await timeline();
  expect(deniedResponse.status).toBe(200);
  const denied = ThreadTimelineResponseSchema.parse(await deniedResponse.json());
  expect(denied.runs[0]!.interruptedBy).toEqual({ visibility: 'restricted' });
  expect(hasAllowedStop(denied, stopActor.id)).toBe(false);

  const original = f.store.readThreadTimelineSnapshotCooperative.bind(f.store);
  let crossed = 0;
  let projected = false;
  let deniedAgain = false;
  const forwarding = vi
    .spyOn(f.store, 'readThreadTimelineSnapshotCooperative')
    .mockImplementation(
      async <T>(
        workspaceId: string,
        threadId: string,
        read: (snapshot: ThreadTimelineSnapshot) => Generator<void, T, void>,
        signal?: AbortSignal
      ): Promise<T> => {
        const scheduled =
          workspaceId === f.workspaceId && threadId === f.thread.id && crossed === 0;
        if (scheduled) {
          crossed++;
          expect(phase).toBe('entry-denied');
          phase = 'projection-allowed';
          expect((await audit()).status).toBe(200);
        }
        const result = await original(workspaceId, threadId, read, signal);
        if (scheduled) {
          projected = hasAllowedStop(result, stopActor.id);
          expect(projected).toBe(true);
          phase = 'final-denied';
          expect((await audit()).status).toBe(403);
          deniedAgain = true;
        }
        return result;
      }
    );
  let response: Response;
  try {
    response = await timeline();
  } finally {
    forwarding.mockRestore();
  }
  expect(crossed).toBe(1);
  expect(projected).toBe(true);
  expect(deniedAgain).toBe(true);
  expect(response.status).toBe(503);
  const refusal = await response.json();
  expect(refusal).toMatchObject({ code: 'operation_storage_unavailable' });
  expect(refusal).not.toHaveProperty('runs');
  expect(refusal).not.toHaveProperty('items');
  expect(hasAllowedStop(refusal, stopActor.id)).toBe(false);
  expect(JSON.stringify(refusal)).not.toContain(stopActor.id);
  expect((await thread()).status).toBe(200);
  expect((await audit()).status).toBe(403);
  const freshResponse = await timeline();
  expect(freshResponse.status).toBe(200);
  const fresh = ThreadTimelineResponseSchema.parse(await freshResponse.json());
  expect(fresh.runs[0]!.interruptedBy).toEqual({ visibility: 'restricted' });
  expect(hasAllowedStop(fresh, stopActor.id)).toBe(false);
  expect(decisions.some((value) => value.phase === 'entry-denied' && value.effect === 'deny')).toBe(
    true
  );
  expect(
    decisions.some((value) => value.phase === 'projection-allowed' && value.effect === 'allow')
  ).toBe(true);
  expect(decisions.some((value) => value.phase === 'final-denied' && value.effect === 'deny')).toBe(
    true
  );
}, 30000);
