import { describe, expect, it } from 'vitest';
import {
  assembleBuiltInSystemPrompt,
  BUILT_IN_SYSTEM_PROMPTS,
  type BuiltInSystemPromptId,
} from './builtin-prompts.js';

const CURRENT_ENTRYPOINTS = ['administration', 'goal-orchestrator', 'quick-chat'] as const;

describe('built-in Agent System Prompts', () => {
  it('keeps every complete fixed assembly within 3000 Unicode code points', () => {
    for (const roleId of CURRENT_ENTRYPOINTS) {
      expect(BUILT_IN_SYSTEM_PROMPTS).toHaveProperty(roleId);
    }

    for (const [roleId, fixedText] of Object.entries(BUILT_IN_SYSTEM_PROMPTS)) {
      expect(fixedText.trim()).not.toBe('');
      expect(Array.from(fixedText).length).toBeLessThanOrEqual(3000);
      if (roleId !== 'administration') {
        expect(
          assembleBuiltInSystemPrompt(roleId as Exclude<BuiltInSystemPromptId, 'administration'>)
        ).toBe(fixedText);
      }
    }
  });

  it('keeps administration framing in the counted fixed text and current identifiers separate', () => {
    const context = {
      workspaceId: 'ws_current',
      threadId: 'th_current',
      workspaceKind: 'quick-chat',
    } as const;

    expect(assembleBuiltInSystemPrompt('administration', context)).toBe(
      BUILT_IN_SYSTEM_PROMPTS.administration + JSON.stringify(context)
    );
    expect(BUILT_IN_SYSTEM_PROMPTS.administration).toContain(
      'Server-authored current private administration context:'
    );
  });
});
