import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceBlockerSchema,
  WorkspaceFreezeRefusalSchema,
  WorkspaceQuickActionSchema,
} from './index.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const attemptId = allocateEntityId('attempt');
const agentSessionId = allocateEntityId('as');
const requestId = '11111111-1111-4111-8111-111111111111';

describe('workspace freeze refusal and blocker schemas', () => {
  it('validates discriminated operation inputs on WorkspaceQuickActionSchema and rejects mismatched payloads', () => {
    const validTurnInterrupt = {
      operationId: 'turn.interrupt' as const,
      input: {
        workspaceId,
        threadId,
        turnId,
        requestId,
      },
    };
    expect(WorkspaceQuickActionSchema.parse(validTurnInterrupt)).toEqual(validTurnInterrupt);

    expect(
      WorkspaceQuickActionSchema.safeParse({
        operationId: 'turn.interrupt',
        input: { workspaceId },
      }).success
    ).toBe(false);

    expect(
      WorkspaceQuickActionSchema.safeParse({
        operationId: 'worker.list',
        input: { workspaceId, extra: true },
      }).success
    ).toBe(false);
  });

  it('enforces exact reference unions and action prohibitions on WorkspaceBlockerSchema variants', () => {
    const snapshotByBackupId = {
      kind: 'snapshot' as const,
      reason: 'pending-publication' as const,
      actions: [],
      reference: {
        backupId: `wsbak_${threadId.slice(3)}`,
      },
    };
    expect(WorkspaceBlockerSchema.parse(snapshotByBackupId).kind).toBe('snapshot');

    const snapshotByRecoveryRequest = {
      kind: 'snapshot' as const,
      reason: 'pending-publication' as const,
      actions: [],
      reference: {
        recoveryRequestId: requestId,
      },
    };
    expect(WorkspaceBlockerSchema.parse(snapshotByRecoveryRequest).kind).toBe('snapshot');

    expect(
      WorkspaceBlockerSchema.safeParse({
        ...snapshotByBackupId,
        reference: { backupId: 'invalid-backup-id' },
      }).success
    ).toBe(false);

    const unavailableBlocker = {
      kind: 'unavailable' as const,
      reason: 'unavailable' as const,
      actions: [],
    };
    expect(WorkspaceBlockerSchema.parse(unavailableBlocker)).toEqual(unavailableBlocker);

    expect(
      WorkspaceBlockerSchema.safeParse({
        kind: 'unavailable',
        reason: 'active-work',
        actions: [],
      }).success
    ).toBe(false);

    expect(
      WorkspaceBlockerSchema.safeParse({
        kind: 'unavailable',
        reason: 'unavailable',
        actions: [
          {
            operationId: 'worker.list',
            input: { workspaceId },
          },
        ],
      }).success
    ).toBe(false);
  });

  it('requires at least one blocker and at most one unavailable sentinel in WorkspaceFreezeRefusalSchema', () => {
    const attemptBlocker = {
      kind: 'worker-attempt' as const,
      reason: 'active-work' as const,
      actions: [],
      reference: {
        attemptId,
        threadId,
        turnId,
        agentSessionId,
      },
    };
    const unavailableBlocker = {
      kind: 'unavailable' as const,
      reason: 'unavailable' as const,
      actions: [],
    };

    const validRefusal = {
      workspaceId,
      operation: 'archive' as const,
      retryable: true,
      blockers: [attemptBlocker, unavailableBlocker],
    };
    expect(WorkspaceFreezeRefusalSchema.parse(validRefusal).blockers).toHaveLength(2);

    expect(
      WorkspaceFreezeRefusalSchema.safeParse({
        ...validRefusal,
        blockers: [],
      }).success
    ).toBe(false);

    expect(
      WorkspaceFreezeRefusalSchema.safeParse({
        ...validRefusal,
        blockers: [unavailableBlocker, unavailableBlocker],
      }).success
    ).toBe(false);
  });
});
