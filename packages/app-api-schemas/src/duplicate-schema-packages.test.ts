import {
  AgentHealthSchema,
  AgentIdSchema,
  ListThreadItemsResponseSchema as ProtocolListThreadItemsResponseSchema,
} from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  AgentHealthRefreshResponseSchema,
  ListThreadItemsResponseSchema,
  WorkspaceDashboardResponseSchema,
} from './dashboard.js';
import { GoalViewSchema } from './goal.js';
import { UpdateKnowledgeNotebookResponseSchema } from './knowledge-notebook.js';
import { MemoryPublicationSchema } from './memory.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const userId = 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b';
const requestId = '11111111-1111-4111-8111-111111111111';

describe('GB-DUP1-01 thread item cursor', () => {
  it('refuses an empty nextCursor on both copies', () => {
    const input = { items: [], nextCursor: '' };
    expect(ProtocolListThreadItemsResponseSchema.safeParse(input).success).toBe(false);
    expect(ListThreadItemsResponseSchema.safeParse(input).success).toBe(false);
    expect(
      ProtocolListThreadItemsResponseSchema.safeParse({ items: [], nextCursor: null }).success
    ).toBe(true);
  });
});

describe('GB-DUP1-02 agent health', () => {
  it('refuses a bogus status and empty health strings on both copies', () => {
    const drifted = { status: 'bogus', message: '', checkedAt: '' };
    const row = {
      agentId: 'ag_00000000-0000-7000-8000-000000000001',
      ...drifted,
    };
    expect(AgentHealthSchema.safeParse(drifted).success).toBe(false);
    expect(WorkspaceDashboardResponseSchema.shape.agentHealth.element.safeParse(row).success).toBe(
      false
    );
    expect(AgentHealthRefreshResponseSchema.shape.items.element.safeParse(row).success).toBe(false);

    const accepted = {
      agentId: 'agent_demo',
      status: 'ready' as const,
      message: null,
      checkedAt: '2026-10-01T10:00:00.000Z',
    };
    expect(AgentHealthSchema.extend({ agentId: AgentIdSchema }).safeParse(accepted).success).toBe(
      true
    );
    expect(
      WorkspaceDashboardResponseSchema.shape.agentHealth.element.safeParse(accepted).success
    ).toBe(true);
  });
});

describe('GB-DUP1-09 notebook publication page ids', () => {
  const notebook = {
    outcome: 'published' as const,
    ownerScope: { kind: 'workspace' as const, workspaceId },
    baseRevision: 'abc',
    notebookRevision: 'def',
    changedPageIds: ['plans/release'],
    receiptRef: {
      operation: 'knowledge.notebook.update' as const,
      requestId,
      ownerScope: { kind: 'workspace' as const, workspaceId },
    },
  };
  const memory = {
    outcome: 'published' as const,
    ownerScope: { kind: 'user' as const, userId },
    baseRevision: 'abc',
    notebookRevision: 'def',
    changedPageIds: ['plans/release'],
    receiptRef: {
      operation: 'knowledge.notebook.restore' as const,
      requestId,
      ownerScope: { kind: 'user' as const, userId },
    },
  };

  it('refuses a non-page changedPageId and unknown publication fields', () => {
    expect(
      UpdateKnowledgeNotebookResponseSchema.safeParse({
        ...notebook,
        changedPageIds: ['../invalid'],
      }).success
    ).toBe(false);
    expect(
      MemoryPublicationSchema.safeParse({ ...memory, changedPageIds: ['../invalid'] }).success
    ).toBe(false);
    expect(MemoryPublicationSchema.safeParse({ ...memory, extra: true }).success).toBe(false);
    expect(UpdateKnowledgeNotebookResponseSchema.safeParse(notebook).success).toBe(true);
    expect(MemoryPublicationSchema.safeParse(memory).success).toBe(true);
  });
});

describe('GB-DUP1-12 goal request resolution', () => {
  const request = {
    requestId: 'req-1',
    operation: 'vault.grant',
    state: 'resolved' as const,
    resolution: 'granted' as const,
    reason: null,
    decidingActorId: null,
    claim: 'finished' as const,
    disposition: 'approved-executed' as const,
    exactIntent: {},
  };

  it('refuses open resolution and disposition strings on the goal view', () => {
    expect(
      GoalViewSchema.shape.requests.element.safeParse({
        ...request,
        resolution: 'bogus',
        disposition: 'bogus',
      }).success
    ).toBe(false);
    expect(GoalViewSchema.shape.requests.element.safeParse(request).success).toBe(true);
  });
});
