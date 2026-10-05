import { describe, expect, it } from 'vitest';
import { getConfigSchemaCatalog } from './catalog.js';
import { ModelCatalogSchema } from './model-catalog.js';

describe('deployment model extension catalog', () => {
  it('admits operational metadata and publishes editor schema', () => {
    const catalog = {
      schemaVersion: 1,
      providers: {
        openai: {
          models: {
            'future-model': { limit: { context: 256000 }, reasoning: false, cost: { input: 0 } },
          },
        },
      },
    };
    expect(ModelCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(getConfigSchemaCatalog().find((entry) => entry.kind === 'model-catalog')).toBeDefined();
  });
  it.each([
    { limit: { context: 0 } },
    { cost: { input: -1 } },
    { reasoning: 'high' },
    { limit: { output: 1.5 } },
    { secretRef: 'vault://x' },
  ])('rejects malformed metadata %j', (metadata) => {
    expect(
      ModelCatalogSchema.safeParse({
        schemaVersion: 1,
        providers: { openai: { models: { future: metadata } } },
      }).success
    ).toBe(false);
  });
  it.each(['', '  '])('rejects blank provider and native model keys %j', (key) => {
    expect(
      ModelCatalogSchema.safeParse({ schemaVersion: 1, providers: { [key]: { models: {} } } })
        .success
    ).toBe(false);
    expect(
      ModelCatalogSchema.safeParse({
        schemaVersion: 1,
        providers: { openai: { models: { [key]: {} } } },
      }).success
    ).toBe(false);
  });
});

it.each([
  { options: [], valid: true },
  { options: [{ type: 'toggle' }, { type: 'effort', values: ['default', 'high'] }], valid: true },
  { options: [{ type: 'effort', values: [] }], valid: true },
  { options: [{ type: 'effort' }], valid: false },
  { options: [{ type: 'toggle', extra: true }], valid: false },
  { options: [{ type: 'effort', values: [false] }], valid: false },
  { options: [{ type: 'budget_tokens' }], valid: false },
])('validates extension reasoning option shapes: $options', ({ options, valid }) => {
  const catalog = {
    schemaVersion: 1,
    providers: { test: { models: { model: { reasoning_options: options } } } },
  };
  const result = ModelCatalogSchema.safeParse(catalog);
  expect(result.success).toBe(valid);
  if (result.success) expect(result.data).toEqual(catalog);
});

it('discards obsolete descriptive metadata without extending model controls', () => {
  expect(
    ModelCatalogSchema.parse({
      schemaVersion: 1,
      providers: { vendor: { models: { model: { reasoning_effort: ['high'] } } } },
    }).providers.vendor?.models.model
  ).toEqual({});
});
