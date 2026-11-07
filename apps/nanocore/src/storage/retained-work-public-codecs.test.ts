import { expect, it } from 'vitest';
import {
  StoredTurnPayloadV1Schema,
  StoredTurnSnapshotV1Schema,
} from './retained-work-events-v1.js';
import { StoredItemPayloadV1Schema } from './retained-work-items-v1.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const otherWorkspaceId = 'ws_00000000-0000-7000-8000-000000000002';
const threadId = 'th_00000000-0000-7000-8000-000000000003';
const turnId = 'tu_00000000-0000-7000-8000-000000000004';
const userId = 'usr_00000000-0000-7000-8000-000000000005';
const otherUserId = 'usr_00000000-0000-7000-8000-000000000006';

const workspaceOwner = { kind: 'workspace', workspaceId };
const serverOwner = { kind: 'server' };

const userDecisionItem = {
  id: 'it_00000000-0000-7000-8000-000000000007',
  owner: workspaceOwner,
  threadId,
  turnId,
  status: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  type: 'approval-decision',
  actor: { kind: 'user', id: userId },
  causationId: 'approval-request-1',
  approvalRequestId: 'approval-request-1',
  decision: 'granted',
  decidedAt: '2026-01-01T00:00:01.000Z',
};

const systemGrantItem = {
  ...userDecisionItem,
  id: 'it_00000000-0000-7000-8000-000000000008',
  actor: { kind: 'system', id: 'nanocore-repo-push-policy', responsibleUserId: null },
};

const userInputRequestItem = {
  id: 'it_00000000-0000-7000-8000-000000000009',
  owner: workspaceOwner,
  threadId,
  turnId,
  status: 'in_progress',
  createdAt: '2026-01-01T00:00:02.000Z',
  completedAt: null,
  type: 'user-input-request',
  responsibleUserId: userId,
  userInputRequestId: 'user-input-request-1',
  prompt: 'Choose one option.',
  questions: [
    {
      id: 'question-1',
      header: 'Choice',
      question: 'Which option?',
      options: null,
      isOther: false,
      isSecret: false,
    },
  ],
};

const workspaceTurn = {
  id: turnId,
  owner: workspaceOwner,
  threadId,
  triggerActor: { kind: 'user', id: userId },
  error: null,
  configVersion: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:10.000Z',
  durationMs: 10_000,
  status: 'completed',
  items: [userDecisionItem, userInputRequestItem],
};

const serverTurn = {
  ...workspaceTurn,
  owner: serverOwner,
  items: [
    { ...userDecisionItem, owner: serverOwner },
    { ...userInputRequestItem, owner: serverOwner },
  ],
};

const publicTurnSchemas = [
  { name: 'payload', schema: StoredTurnPayloadV1Schema },
  { name: 'snapshot', schema: StoredTurnSnapshotV1Schema },
];

it('accepts a user approval decision item', () => {
  expect(StoredItemPayloadV1Schema.safeParse(userDecisionItem).success).toBe(true);
});

it('accepts the repository-push policy system grant item', () => {
  expect(StoredItemPayloadV1Schema.safeParse(systemGrantItem).success).toBe(true);
});

it('refuses a system approval decision that is a denial', () => {
  expect(
    StoredItemPayloadV1Schema.safeParse({ ...systemGrantItem, decision: 'denied' }).success
  ).toBe(false);
});

it('refuses an approval decision from a foreign system actor', () => {
  expect(
    StoredItemPayloadV1Schema.safeParse({
      ...systemGrantItem,
      actor: { kind: 'system', id: 'foreign-push-policy', responsibleUserId: null },
    }).success
  ).toBe(false);
});

it.each(publicTurnSchemas)(
  'accepts a Turn $name whose Items inherit the Workspace owner and responsible User',
  ({ schema }) => {
    expect(schema.safeParse(workspaceTurn).success).toBe(true);
  }
);

it.each(publicTurnSchemas)(
  'accepts a Turn $name whose Items inherit the Server owner and responsible User',
  ({ schema }) => {
    expect(schema.safeParse(serverTurn).success).toBe(true);
  }
);

it.each(publicTurnSchemas)('refuses a Turn $name whose Item owner kind differs', ({ schema }) => {
  expect(
    schema.safeParse({
      ...workspaceTurn,
      items: [{ ...userDecisionItem, owner: serverOwner }],
    }).success
  ).toBe(false);
});

it.each(publicTurnSchemas)(
  'refuses a Turn $name whose Item names another Workspace',
  ({ schema }) => {
    expect(
      schema.safeParse({
        ...workspaceTurn,
        items: [
          { ...userDecisionItem, owner: { kind: 'workspace', workspaceId: otherWorkspaceId } },
        ],
      }).success
    ).toBe(false);
  }
);

it.each(publicTurnSchemas)(
  'refuses a Turn $name whose user-input request names another responsible User',
  ({ schema }) => {
    expect(
      schema.safeParse({
        ...workspaceTurn,
        items: [{ ...userInputRequestItem, responsibleUserId: otherUserId }],
      }).success
    ).toBe(false);
  }
);
