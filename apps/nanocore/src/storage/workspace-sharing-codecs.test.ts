import { describe, expect, it } from 'vitest';
import { ControlCoreSharingRefusalSchema } from './workspace-sharing-codecs.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const activeMember = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
  status: 'active',
  isOwner: false,
  invitationId: null,
  joinedAt: timestamp,
  removedAt: null,
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

describe('Workspace sharing native refusal codec', () => {
  it('accepts only established code, status, message, and detail combinations', () => {
    expect(
      ControlCoreSharingRefusalSchema.safeParse({
        operation: 'core-sharing',
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
        status: 403,
      }).success
    ).toBe(true);
    expect(
      ControlCoreSharingRefusalSchema.safeParse({
        operation: 'core-sharing',
        code: 'revision_conflict',
        message: 'Workspace membership revision conflict.',
        status: 409,
        details: { resource: 'membership', current: activeMember },
      }).success
    ).toBe(true);

    for (const refusal of [
      {
        operation: 'core-sharing',
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
        status: 400,
        details: { resource: 'membership', current: activeMember },
      },
      {
        operation: 'core-sharing',
        code: 'revision_conflict',
        message: 'Workspace membership revision conflict.',
        status: 409,
      },
      {
        operation: 'core-sharing',
        code: 'workspace_access_denied',
        message: 'Unknown sharing refusal.',
        status: 403,
      },
      {
        operation: 'core-sharing',
        code: 'revision_conflict',
        message: 'Workspace membership revision conflict.',
        status: 409,
        details: { resource: 'unknown', current: activeMember },
      },
    ] as const) {
      expect(ControlCoreSharingRefusalSchema.safeParse(refusal).success).toBe(false);
    }
  });
});
