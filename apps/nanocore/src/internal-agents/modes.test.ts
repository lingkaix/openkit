import { describe, expect, it } from 'vitest';

import {
  getInternalAgentPathForMode,
  INTERNAL_AGENT_MODE_PATHS,
  OPENKIT_WORK_MODES,
} from './modes.js';

describe('internal agent mode routing model', () => {
  it('defines every v0.0.5 product work mode', () => {
    expect(OPENKIT_WORK_MODES).toEqual([
      'chat',
      'automation',
      'plan',
      'review',
      'organize',
      'delegation',
    ]);
  });

  it('maps every product mode to an explicit implementation path', () => {
    for (const mode of OPENKIT_WORK_MODES) {
      expect(INTERNAL_AGENT_MODE_PATHS[mode].length).toBeGreaterThan(0);
      expect(getInternalAgentPathForMode(mode)).toEqual(INTERNAL_AGENT_MODE_PATHS[mode]);
    }
  });

  it('keeps chat and automation on the implemented internal-agent paths', () => {
    expect(getInternalAgentPathForMode('chat')).toEqual([
      { kind: 'internal-agent', role: 'primary', target: 'quick-chat' },
    ]);
    expect(getInternalAgentPathForMode('automation')).toEqual([
      { kind: 'internal-agent', role: 'primary', target: 'worker-coordinator' },
      { kind: 'worker-runtime', role: 'execution', target: 'selected-worker' },
    ]);
  });

  it('keeps future delegation as composition instead of a single internal agent', () => {
    expect(getInternalAgentPathForMode('delegation')).toEqual([
      { kind: 'internal-agent', role: 'routing', target: 'worker-coordinator' },
      { kind: 'internal-agent', role: 'context', target: 'context-packager' },
      { kind: 'worker-runtime', role: 'execution', target: 'selected-worker' },
      { kind: 'internal-agent', role: 'review', target: 'task-evaluator' },
      { kind: 'internal-agent', role: 'knowledge', target: 'knowledge-manager' },
    ]);
  });
});
