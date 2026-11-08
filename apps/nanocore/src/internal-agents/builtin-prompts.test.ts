import { expect, it } from 'vitest';
import { assembleBuiltInSystemPrompt, BUILT_IN_SYSTEM_PROMPTS } from './builtin-prompts.js';

it('keeps every complete fixed built-in prompt within 3000 Unicode code points', () => {
  expect(Object.keys(BUILT_IN_SYSTEM_PROMPTS).length).toBeGreaterThan(0);
  for (const [role, prompt] of Object.entries(BUILT_IN_SYSTEM_PROMPTS)) {
    expect(Array.from(prompt).length, role).toBeLessThanOrEqual(3000);
    expect(prompt.trim().length, role).toBeGreaterThan(0);
  }
});

it('delivers role-scoped reporting rules while preserving machine-only output tasks', () => {
  for (const role of [
    'goal-orchestrator',
    'administration',
    'quick-chat',
    'knowledge-manager',
  ] as const) {
    const prompt =
      role === 'administration'
        ? assembleBuiltInSystemPrompt(role, {
            workspaceId: 'current-workspace',
            threadId: 'current-thread',
            workspaceKind: 'personal',
          })
        : assembleBuiltInSystemPrompt(role);
    expect(prompt, role).toContain('Outcome first:');
    expect(prompt, role).toContain("Unrun checks: 'not checked'.");
    expect(prompt.includes('Questions:'), role).toBe(role !== 'knowledge-manager');
    expect(prompt.includes('Progress:'), role).toBe(
      role === 'goal-orchestrator' || role === 'administration'
    );
  }
  for (const role of ['policy-agent-gate', 'context-compaction'] as const) {
    expect(assembleBuiltInSystemPrompt(role)).not.toContain('Outcome first:');
    expect(assembleBuiltInSystemPrompt(role)).not.toContain('Progress:');
  }
});
