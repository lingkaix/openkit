import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import type { ThreadItem } from '../data';
import type { TimelineTurn } from './source';

const owner = {
  kind: 'workspace' as const,
  workspaceId: allocateEntityId('ws'),
};
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');

function stamp(extra: Record<string, unknown>) {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner,
    threadId,
    turnId,
    status: 'completed',
    createdAt: '2026-11-08T02:00:00.000Z',
    completedAt: '2026-11-08T03:00:00.000Z',
    ...extra,
  });
}

/**
 * One running run with more than 100 steps, a plan, and several progress notes.
 * Identifiers stay on the records. Work must not print them.
 */
export function longRunFixture(): { items: ThreadItem[]; turn: TimelineTurn } {
  const notes = ['First note', 'Second note', 'Third note', 'Fourth note', 'Fifth note'].map(
    (text) => stamp({ type: 'assistant-message', text })
  );
  const plans = [0, 1].map((index) =>
    stamp({
      type: 'plan',
      title: `Earlier plan ${index + 1}`,
      summary: 'Replaced',
      steps: [{ id: `old-${index}`, title: 'Old step', status: 'completed' }],
    })
  );
  const currentPlan = stamp({
    type: 'plan',
    title: 'Current plan',
    summary: 'In progress',
    steps: [
      { id: 'reproduce', title: 'Reproduce', status: 'completed' },
      { id: 'fix', title: 'Fix formatter', status: 'completed' },
      { id: 'tests', title: 'Update tests', status: 'in_progress' },
      { id: 'docs', title: 'Docs', status: 'pending' },
    ],
  });
  const files = ['a.ts', 'b.ts', 'c.ts'].map((path) =>
    stamp({ type: 'file-change', path, changeKind: 'modified' })
  );
  const commands = [0, 1].map(() =>
    stamp({
      type: 'command-execution',
      command: 'npm test',
      cwd: '/workspace',
      output: 'fail',
      exitCode: 1,
      durationMs: 1000,
    })
  );
  const tools = Array.from({ length: 100 }, (_, index) =>
    stamp({
      type: 'tool-call',
      tool: index < 4 ? 'read' : 'edit',
      server: null,
      arguments: null,
      result: index < 4 ? null : 'ok',
      error: index < 4 ? 'missing' : null,
      durationMs: 10,
      status: index < 4 ? 'failed' : 'completed',
    })
  );
  const decision = stamp({
    type: 'approval-request',
    approvalRequestId: 'apr-long',
    title: 'Approve the export',
    description: 'Write the file.',
    kind: 'permission',
  });
  const items = ItemSchema.array().parse([
    stamp({
      type: 'user-message',
      actor: { kind: 'user', id: allocateEntityId('usr') },
      text: JSON.stringify({
        schemaVersion: 1,
        objective: 'Check the export dates',
        acceptanceCriteria: ['The dates match'],
      }),
    }),
    ...plans,
    currentPlan,
    ...notes,
    decision,
    ...files,
    ...commands,
    ...tools,
  ]) as ThreadItem[];
  return {
    items,
    turn: {
      id: turnId,
      status: 'running',
      startedAt: '2026-11-08T00:00:00.000Z',
      completedAt: null,
    },
  };
}

export const LONG_RUN_NOW = Date.parse('2026-11-08T03:12:00.000Z');
