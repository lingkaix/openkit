import { expect, it } from 'vitest';
import { ConversationModelChoiceSchema, SubmitConversationRequestSchema } from './chat-mode.js';

it('admits canonical submission effort and optional advertised control levels', () => {
  const input = {
    input: 'Run',
    requestId: 'request',
    targetRef: 'new-task-worker',
    artifactRefs: [],
    reasoningEffort: 'none',
  };
  expect(SubmitConversationRequestSchema.parse(input)).toEqual(input);
  expect(
    SubmitConversationRequestSchema.safeParse({ ...input, reasoningEffort: 'default' }).success
  ).toBe(false);
  for (const reasoningEffortLevels of [[], ['none', 'high']]) {
    const model = {
      id: 'model',
      label: 'Model',
      capabilities: ['reasoning'],
      reasoningEffortLevels,
    };
    expect(ConversationModelChoiceSchema.parse(model)).toEqual(model);
  }
  expect(
    ConversationModelChoiceSchema.parse({ id: 'model', label: 'Model', capabilities: [] })
  ).not.toHaveProperty('reasoningEffortLevels');
});
