import { describe, expect, it } from 'vitest';

import {
  classifyLlmProjectionItemCategory,
  createLlmProjectionPolicyDecision,
  LLM_PROJECTION_ITEM_CATEGORIES,
  LLM_PROJECTION_OUTCOMES,
  projectionOutcomeRequiresExclusionReason,
} from './projection-policy.js';

describe('LLM projection policy types', () => {
  it('declares model-visible, summarized, elided, and UI-only outcomes', () => {
    expect(LLM_PROJECTION_OUTCOMES).toEqual(['model-visible', 'summarized', 'elided', 'ui-only']);
  });

  it('represents user, assistant, artifact, approval, diagnostic, review, and goal categories', () => {
    expect(LLM_PROJECTION_ITEM_CATEGORIES).toEqual(
      expect.arrayContaining([
        'user',
        'assistant',
        'artifact',
        'approval',
        'diagnostic',
        'review',
        'goal',
      ])
    );
  });

  it('classifies durable item types into projection categories', () => {
    expect(classifyLlmProjectionItemCategory('user-message')).toBe('user');
    expect(classifyLlmProjectionItemCategory('assistant-message')).toBe('assistant');
    expect(classifyLlmProjectionItemCategory('artifact-reference')).toBe('artifact');
    expect(classifyLlmProjectionItemCategory('approval-request')).toBe('approval');
    expect(classifyLlmProjectionItemCategory('approval-decision')).toBe('approval');
    expect(classifyLlmProjectionItemCategory('status')).toBe('diagnostic');
    expect(classifyLlmProjectionItemCategory('tool-call')).toBe('diagnostic');
    expect(classifyLlmProjectionItemCategory('reasoning')).toBe('review');
    expect(classifyLlmProjectionItemCategory('plan')).toBe('goal');
  });

  it('requires exclusion reasons for elided and UI-only policy outcomes', () => {
    expect(projectionOutcomeRequiresExclusionReason('model-visible')).toBe(false);
    expect(projectionOutcomeRequiresExclusionReason('summarized')).toBe(false);
    expect(projectionOutcomeRequiresExclusionReason('elided')).toBe(true);
    expect(projectionOutcomeRequiresExclusionReason('ui-only')).toBe(true);
  });

  it('records exclusion reasons on policy decisions that need them', () => {
    expect(
      createLlmProjectionPolicyDecision({
        itemId: 'item_diagnostic',
        itemType: 'status',
        outcome: 'ui-only',
        exclusionReason: 'diagnostic_noise',
      })
    ).toEqual({
      itemId: 'item_diagnostic',
      itemType: 'status',
      category: 'diagnostic',
      outcome: 'ui-only',
      exclusionReason: 'diagnostic_noise',
    });
    expect(() =>
      createLlmProjectionPolicyDecision({
        itemId: 'item_artifact',
        itemType: 'artifact-reference',
        outcome: 'elided',
      })
    ).toThrow('Projection outcome elided requires an exclusion reason.');
  });
});
