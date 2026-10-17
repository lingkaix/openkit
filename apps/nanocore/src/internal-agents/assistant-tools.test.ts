import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantTools } from './assistant-tools.js';
import type { AgentTool } from './internal-agent-loop.js';

const actorUserId = allocateEntityId('usr');
const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const goalThreadId = allocateEntityId('th');

const placeholder = (name: string): AgentTool => ({
  name,
  description: 'Bound owner',
  inputSchema: { type: 'object' },
  execute: async () => ({ content: [] }),
});
const execution = () => ({
  callId: 'model-correlation-only',
  signal: new AbortController().signal,
  toolOccurrence: 1,
});
function fixture(privateEntry = true) {
  const invoke = vi.fn(async () => ({ ok: true }));
  const assertCurrent = vi.fn();
  return {
    invoke,
    assertCurrent,
    ...createAssistantTools({
      actorUserId,
      commandRequestId: 'same-command',
      workspaceId,
      threadId,
      turnId,
      privateEntry,
      history: placeholder('thread.history.read'),
      skill: placeholder('skill.read'),
      assertCurrent,
      invoke,
    }),
  };
}
const names = [
  'workspace.dashboard',
  'thread.history.read',
  'knowledge.ask',
  'knowledge.tell',
  'workspace.create',
  'task.start',
  'goal.create',
  'goal.intent.revise',
  'goal.card.create',
  'goal.card.edit',
  'goal.card.cancel',
  'memory.page.read',
  'memory.page.create',
  'memory.page.update',
  'memory.page.delete',
  'memory.page.propose',
  'skill.read',
  'kernel.apps.list',
  'kernel.apps.create',
  'kernel.apps.get',
  'kernel.schema.update',
  'kernel.apps.retire',
  'kernel.records.list',
  'kernel.records.get',
  'kernel.records.create',
  'kernel.records.update',
  'kernel.records.batch',
  'generative-ui.publish',
];

describe('ordinary Assistant fixed Tools', () => {
  it('retains the entire owner-ordered set across private and shared entry availability', async () => {
    for (const privateEntry of [true, false]) {
      const run = fixture(privateEntry);
      expect(run.tools.map((tool) => tool.name)).toEqual(names);
      for (const name of names.filter((name) => name.startsWith('memory.'))) {
        const result = await run.tools.find((tool) => tool.name === name)!.execute({}, execution());
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(
          privateEntry ? 'memory_unavailable' : 'private_entry_required'
        );
      }
      expect(run.invoke).not.toHaveBeenCalled();
    }
  });

  it('binds querying authority and server command occurrences while model call ids remain correlation', async () => {
    const run = fixture();
    const tool = run.tools.find((tool) => tool.name === 'kernel.apps.retire')!;
    const value = { appId: '334b2546-f7a2-49e2-b50a-00f4f94343f4', expectedAppRevision: 1 };
    const forged = await tool.execute(
      { ...value, workspaceId: 'other', requestId: 'model-owned' },
      execution()
    );
    expect(forged.isError).toBe(true);
    expect(run.invoke).not.toHaveBeenCalled();
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty('workspaceId');
    expect(properties).not.toHaveProperty('requestId');
    await tool.execute(value, execution());
    await tool.execute(value, { ...execution(), toolOccurrence: 2 });
    expect(run.invoke).toHaveBeenCalledTimes(2);
    const first = run.invoke.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      AbortSignal,
    ];
    const second = run.invoke.mock.calls[1] as unknown as [
      string,
      Record<string, unknown>,
      AbortSignal,
    ];
    expect(first[0]).toBe('kernel.apps.retire');
    expect(first[1]).toMatchObject({ ...value, workspaceId });
    expect(first[1].requestId).not.toBe('model-correlation-only');
    expect(first[1].requestId).not.toBe(second[1].requestId);
    const repeatedAssembly = fixture();
    await repeatedAssembly.tools
      .find((tool) => tool.name === 'kernel.apps.retire')!
      .execute(value, execution());
    expect(
      (repeatedAssembly.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
        .requestId
    ).toBe(first[1].requestId);
  });

  it('retains exact proposed Task bytes and performs no native operation or hidden second handoff', async () => {
    const run = fixture();
    const tool = run.tools.find((tool) => tool.name === 'task.start')!;
    const input = '  Can the worker answer this exact question?\nKeep its constraints.  ';
    const result = await tool.execute(
      { input, agentId: 'selected-agent', modelId: 'logical-model' },
      execution()
    );
    expect(result.isError).toBe(false);
    expect(run.proposedHandoff()).toEqual({
      kind: 'task',
      targetWorkspaceId: workspaceId,
      input,
      agentId: 'selected-agent',
      modelId: 'logical-model',
    });
    expect(run.invoke).not.toHaveBeenCalled();
    const duplicate = await tool.execute({ input: 'Different work' }, execution());
    expect(JSON.stringify(duplicate)).toContain('handoff_already_proposed');
    expect(run.proposedHandoff()?.kind).toBe('task');
  });

  it('keeps a selected Goal target distinct from the server-bound querying Thread', async () => {
    const run = fixture();
    const tool = run.tools.find((tool) => tool.name === 'goal.card.create')!;
    const result = await tool.execute(
      {
        targetThreadId: goalThreadId,
        goalId: 'goal',
        description: 'A desired contribution',
      },
      execution()
    );
    expect(result.isError).toBe(false);
    expect(run.invoke).toHaveBeenCalledWith(
      'goal.card.create',
      expect.objectContaining({
        workspaceId,
        threadId: goalThreadId,
        goalId: 'goal',
        description: 'A desired contribution',
      }),
      expect.any(AbortSignal)
    );
    expect(
      (run.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    ).not.toHaveProperty('targetThreadId');
  });

  it('reauthorizes each requested Tool and withholds unavailable owner output', async () => {
    const run = fixture();
    run.assertCurrent.mockImplementation(() => {
      throw new Error('private diagnostic');
    });
    const result = await run.tools[0]!.execute({}, execution());
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(run.invoke).not.toHaveBeenCalled();
  });
});
