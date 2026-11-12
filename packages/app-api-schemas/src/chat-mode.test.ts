import { expect, it } from 'vitest';
import {
  ConversationModelChoiceSchema,
  ConversationTargetSchema,
  SubmitConversationRequestSchema,
} from './chat-mode.js';

it('separates live-steer facts from ordinary busy target availability', () => {
  const target = {
    targetRef: 'running-worker:thread:agent',
    kind: 'running-worker',
    label: 'Worker',
    description: null,
    availability: 'busy',
    unavailableReason: 'Worker is busy.',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    profileId: null,
    logicalModels: [],
    defaultLogicalModelId: null,
    activeTurnId: 'tu_00000000-0000-7000-8000-000000000001',
    steerAvailability: 'available',
    steerUnavailableReason: null,
  };
  expect(ConversationTargetSchema.safeParse(target).success).toBe(true);
  for (const invalid of [
    { ...target, steerAvailability: 'queued' },
    { ...target, activeTurnId: null },
    { ...target, kind: 'goal-coordinator' },
    { ...target, steerUnavailableReason: 'stale' },
    { ...target, steerAvailability: 'busy', steerUnavailableReason: null },
  ])
    expect(ConversationTargetSchema.safeParse(invalid).success).toBe(false);
});

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

it('admits an ordered exact file inventory without text and bounds combined declared bytes', () => {
  const file = {
    name: 'original.bin',
    mediaType: 'application/octet-stream',
    sizeBytes: 500_000_000,
    contentDigest: `sha256:${'a'.repeat(64)}`,
  };
  const input = {
    input: '',
    targetRef: 'internal-role:assistant',
    artifactRefs: [],
    requestId: 'file-input-command',
    fileInputs: [file, { ...file, name: 'second.bin' }],
  };
  expect(SubmitConversationRequestSchema.safeParse(input).success).toBe(true);
  expect(
    SubmitConversationRequestSchema.safeParse({
      ...input,
      fileInputs: [file, { ...file, sizeBytes: 500_000_001 }],
    }).success
  ).toBe(false);
  expect(
    SubmitConversationRequestSchema.safeParse({ ...input, fileInputs: [{ ...file, sizeBytes: 0 }] })
      .success
  ).toBe(true);
  expect(
    SubmitConversationRequestSchema.safeParse({
      ...input,
      fileInputs: [{ ...file, requiredFeatures: ['unknown'] }],
    }).success
  ).toBe(false);
  expect(
    SubmitConversationRequestSchema.safeParse({
      ...input,
      fileInputs: [{ ...file, contentDigest: 'not-a-digest' }],
    }).success
  ).toBe(false);
});

it('binds explicit file handoff consent without accepting false or invented confirmation payloads', () => {
  const input = {
    input: 'Exact shared work brief',
    targetRef: 'new-task-worker',
    requestId: 'confirmed-file-command',
    artifactRefs: [],
    fileHandoffConfirmed: true,
  };
  expect(SubmitConversationRequestSchema.parse(input)).toEqual(input);
  for (const fileHandoffConfirmed of [false, 'true', { confirmed: true }]) {
    expect(
      SubmitConversationRequestSchema.safeParse({ ...input, fileHandoffConfirmed }).success
    ).toBe(false);
  }
});
