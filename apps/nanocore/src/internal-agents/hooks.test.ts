import { describe, expect, it } from 'vitest';

import {
  createInternalAgentHookDispatcher,
  type InternalAgentCriticalHookError,
  type InternalAgentHook,
} from './hooks.js';
import type { InternalAgentStreamEvent } from './types.js';

const TEST_EVENT: InternalAgentStreamEvent = {
  eventType: 'agent_start',
  sequence: 0,
  agentId: 'quick-chat',
  runId: 'run_hook_1',
  timestamp: '2026-05-31T00:00:00.000Z',
  mode: 'chat',
};

describe('internal agent hook composition', () => {
  it('isolates observational hook failures by default and continues dispatch', async () => {
    const calls: string[] = [];
    const hooks: InternalAgentHook[] = [
      {
        id: 'failing-observer',
        handleEvent: async () => {
          calls.push('failing-observer');
          throw new Error('observer failed token=tok_secret Authorization: Bearer live_secret');
        },
      },
      {
        id: 'healthy-observer',
        handleEvent: async () => {
          calls.push('healthy-observer');
        },
      },
    ];
    const dispatcher = createInternalAgentHookDispatcher(hooks);

    const diagnostics = await dispatcher.dispatch(TEST_EVENT);

    expect(calls).toEqual(['failing-observer', 'healthy-observer']);
    expect(diagnostics).toEqual([
      {
        hookId: 'failing-observer',
        eventType: 'agent_start',
        mode: 'observational',
        message: 'observer failed token=[redacted] Authorization: Bearer [redacted]',
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('tok_secret');
    expect(JSON.stringify(diagnostics)).not.toContain('live_secret');
  });

  it('fails fast when a critical hook fails', async () => {
    const calls: string[] = [];
    const hooks: InternalAgentHook[] = [
      {
        id: 'critical-audit',
        mode: 'critical',
        handleEvent: async () => {
          calls.push('critical-audit');
          throw new Error('critical failed api_key=sk-secret');
        },
      },
      {
        id: 'skipped-observer',
        handleEvent: async () => {
          calls.push('skipped-observer');
        },
      },
    ];
    const dispatcher = createInternalAgentHookDispatcher(hooks);

    await expect(dispatcher.dispatch(TEST_EVENT)).rejects.toMatchObject({
      code: 'internal_agent_critical_hook_failed',
      diagnostic: {
        hookId: 'critical-audit',
        eventType: 'agent_start',
        mode: 'critical',
        message: 'critical failed api_key=[redacted]',
      },
    } satisfies Partial<InternalAgentCriticalHookError>);
    expect(calls).toEqual(['critical-audit']);
  });
});
