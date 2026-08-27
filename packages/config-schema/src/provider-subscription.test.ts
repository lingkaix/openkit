import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { ProviderSubscriptionAccountSlotId, SubscriptionProviderId } from './index.js';
import * as configSchema from './index.js';
import { ProviderSubscriptionAccountSlotIdSchema, SubscriptionProviderIdSchema } from './index.js';

describe('provider subscription identifiers', () => {
  it('accepts only the supported subscription provider ids', () => {
    const supported: SubscriptionProviderId[] = ['openai-codex', 'xai'];

    expectTypeOf<SubscriptionProviderId>().toEqualTypeOf<'openai-codex' | 'xai'>();
    expect(SubscriptionProviderIdSchema.options).toEqual(supported);
    expect(supported.map((providerId) => SubscriptionProviderIdSchema.parse(providerId))).toEqual(
      supported
    );
    for (const providerId of [null, 1, '', 'openai', 'codex', 'XAI', 'anthropic']) {
      expect(SubscriptionProviderIdSchema.safeParse(providerId).success).toBe(false);
    }
  });

  it('accepts only safe bounded account slot ids', () => {
    const valid: ProviderSubscriptionAccountSlotId[] = [
      'a',
      '0',
      'work-',
      'work_',
      'work_chatgpt-1',
      `a${'z'.repeat(63)}`,
    ];

    expectTypeOf<ProviderSubscriptionAccountSlotId>().toEqualTypeOf<string>();
    for (const slotId of valid) {
      expect(ProviderSubscriptionAccountSlotIdSchema.parse(slotId)).toBe(slotId);
    }
    for (const slotId of [
      null,
      1,
      '',
      '-work',
      '_work',
      'Work',
      'work account',
      'work.account',
      '../work',
      'work/account',
      `a${'z'.repeat(64)}`,
    ]) {
      expect(ProviderSubscriptionAccountSlotIdSchema.safeParse(slotId).success).toBe(false);
    }
  });
});

describe('provider subscription family resolution', () => {
  beforeEach(() => {
    expect(configSchema.resolveProviderSubscriptionFamily).toBeTypeOf('function');
  });

  it('normalizes each identifier and applies vendor authority with id fallback', () => {
    for (const [input, expected] of [
      [{ id: '  OpenAI-Codex  ' }, 'openai-codex'],
      [{ id: '  XAI  ' }, 'xai'],
      [{ id: 'ignored', vendor: '  OpenAI-Codex  ' }, 'openai-codex'],
      [{ id: 'ignored', vendor: '  XAI  ' }, 'xai'],
      [{ id: 'xai', vendor: 'unsupported' }, 'xai'],
      [{ id: 'openai_codex', vendor: 'unsupported' }, 'openai-codex'],
      [{ id: 'openai_codex', vendor: ' OPENAI-CODEX ' }, 'openai-codex'],
    ] as const) {
      expect(configSchema.resolveProviderSubscriptionFamily(input)).toBe(expected);
    }
  });

  it('rejects conflicting recognized families', () => {
    for (const input of [
      { id: 'xai', vendor: 'openai_codex' },
      { id: ' OPENAI-CODEX ', vendor: ' XAI ' },
    ]) {
      expect(() => configSchema.resolveProviderSubscriptionFamily(input)).toThrow();
    }
  });

  it('returns null for unsupported and partial lookalikes', () => {
    for (const input of [
      { id: 'openai' },
      { id: 'codex' },
      { id: 'openai_codex_preview' },
      { id: 'xai-compatible' },
      { id: 'anthropic', vendor: 'openai' },
      { id: 'xai_preview', vendor: 'codex' },
    ]) {
      expect(configSchema.resolveProviderSubscriptionFamily(input)).toBeNull();
    }
  });
});
