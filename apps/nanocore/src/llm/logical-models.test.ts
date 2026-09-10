import type { GatewayConfig, ProviderProfile } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from '../providers/registry.js';
import {
  assertConfiguredModelsHaveKnownContext,
  hasCompleteCostRates,
  mergeAdapterCostRates,
  resolveEffectiveModelMetadata,
  resolveLogicalModel,
  resolveLogicalModelCatalog,
} from './logical-models.js';

function profile(
  input: Partial<ProviderProfile> &
    Pick<ProviderProfile, 'id' | 'models'> & {
      readonly modelMetadata?: Readonly<Record<string, unknown>>;
      readonly omitContextMetadata?: boolean;
    }
): ProviderProfile {
  const { omitContextMetadata, ...profileInput } = input;
  return {
    displayName: input.displayName ?? input.id,
    kind: input.kind ?? 'custom',
    ...profileInput,
    modelMetadata:
      input.modelMetadata ??
      (omitContextMetadata
        ? undefined
        : Object.fromEntries(
            input.models.map((model) => [model, { limit: { context: 1_000_000 } }])
          )),
  } as ProviderProfile;
}

function gateway(input: {
  readonly contextManagement?: GatewayConfig['logicalModels'][number]['contextManagement'];
  readonly id?: string;
  readonly routes: GatewayConfig['logicalModels'][number]['routes'];
}): GatewayConfig {
  const id = input.id ?? 'local-free';
  return {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: id,
    logicalModels: [
      {
        id,
        displayName: id,
        contextManagement: input.contextManagement ?? [
          { type: 'compaction', compactThreshold: 8_000 },
        ],
        routes: input.routes,
      },
    ],
  };
}

describe('resolveLogicalModelCatalog', () => {
  it('admits a handwritten uncatalogued model on one authored route with null family', () => {
    const catalog = resolveLogicalModelCatalog(
      gateway({
        routes: [
          {
            id: 'primary',
            providerProfileId: 'orca-custom',
            providerModel: 'handwritten/local-flash',
          },
        ],
      }),
      new ProviderRegistry([
        profile({
          baseUrl: 'https://orca.example/v1',
          id: 'orca-custom',
          models: ['handwritten/local-flash'],
        }),
      ])
    );

    expect(catalog).toEqual([
      {
        id: 'local-free',
        displayName: 'local-free',
        modelFamilyId: null,
        contextManagement: { type: 'compaction', compactThreshold: 8_000 },
        capabilities: ['chat-completions', 'responses'],
        routes: [
          {
            id: 'primary',
            providerProfileId: 'orca-custom',
            providerModel: 'handwritten/local-flash',
          },
        ],
      },
    ]);
  });

  it('keeps catalog capability metadata when a listed model has no family', () => {
    const catalog = resolveLogicalModelCatalog(
      gateway({
        id: 'openrouter-free',
        routes: [
          {
            id: 'primary',
            providerProfileId: 'openrouter-test',
            providerModel: 'openrouter/free',
          },
        ],
      }),
      new ProviderRegistry([
        profile({
          id: 'openrouter-test',
          kind: 'gateway',
          models: ['openrouter/free'],
          vendor: 'openrouter',
        }),
      ])
    );

    expect(catalog).toEqual([
      {
        id: 'openrouter-free',
        displayName: 'openrouter-free',
        modelFamilyId: null,
        contextManagement: { type: 'compaction', compactThreshold: 8_000 },
        capabilities: [
          'attachment',
          'chat-completions',
          'input:image',
          'input:text',
          'output:text',
          'reasoning',
          'responses',
          'temperature',
          'tool-calling',
        ],
        routes: [
          {
            id: 'primary',
            providerProfileId: 'openrouter-test',
            providerModel: 'openrouter/free',
          },
        ],
      },
    ]);
  });

  it('rejects a known-family dispatchable route when an authored blocked sibling has unknown family', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          id: 'mixed-admission',
          routes: [
            { id: 'ready', providerProfileId: 'ready', providerModel: 'gpt-5.1' },
            {
              id: 'blocked-unknown',
              providerProfileId: 'blocked-orca',
              providerModel: 'handwritten/local-flash',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            id: 'ready',
            kind: 'direct',
            models: ['gpt-5.1'],
            vendor: 'openai',
          }),
          profile({
            id: 'blocked-orca',
            models: ['handwritten/local-flash'],
            readiness: { message: 'Unavailable', status: 'blocked' },
          }),
        ])
      )
    ).toThrow('Logical model routes cross model families: mixed-admission.');
  });

  it('rejects a known-family dispatchable route when an authored sibling profile is undeployed', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          id: 'mixed-undeployed',
          routes: [
            { id: 'ready', providerProfileId: 'ready', providerModel: 'gpt-5.1' },
            {
              id: 'missing',
              providerProfileId: 'absent-orca',
              providerModel: 'handwritten/local-flash',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            id: 'ready',
            kind: 'direct',
            models: ['gpt-5.1'],
            vendor: 'openai',
          }),
        ])
      )
    ).toThrow('Logical model routes cross model families: mixed-undeployed.');
  });

  it('retains a known-family logical model when a same-family authored sibling is blocked', () => {
    const catalog = resolveLogicalModelCatalog(
      gateway({
        id: 'reasoning',
        routes: [
          { id: 'blocked', providerProfileId: 'blocked', providerModel: 'gpt-5.1' },
          { id: 'ready', providerProfileId: 'ready', providerModel: 'gpt-5.1' },
        ],
      }),
      new ProviderRegistry([
        profile({
          id: 'blocked',
          kind: 'local',
          models: ['gpt-5.1'],
          readiness: { message: 'Unavailable', status: 'blocked' },
          vendor: 'openai',
        }),
        profile({
          id: 'ready',
          kind: 'local',
          models: ['gpt-5.1'],
          vendor: 'openai',
        }),
      ])
    );

    expect(catalog).toEqual([
      expect.objectContaining({
        id: 'reasoning',
        modelFamilyId: 'gpt',
        routes: [{ id: 'ready', providerProfileId: 'ready', providerModel: 'gpt-5.1' }],
      }),
    ]);
  });

  it('rejects an unknown-family logical model that authors more than one route', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          routes: [
            {
              id: 'primary',
              providerProfileId: 'orca-custom',
              providerModel: 'handwritten/local-flash',
            },
            {
              id: 'backup',
              providerProfileId: 'blocked-orca',
              providerModel: 'handwritten/local-flash',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            baseUrl: 'https://orca.example/v1',
            id: 'orca-custom',
            models: ['handwritten/local-flash'],
          }),
          profile({
            id: 'blocked-orca',
            models: ['handwritten/local-flash'],
            readiness: { message: 'Unavailable', status: 'blocked' },
          }),
        ])
      )
    ).toThrow('Logical model routes cross model families: local-free.');
  });

  it('still rejects distinct known catalog families', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          id: 'mixed',
          routes: [
            { id: 'openai', providerProfileId: 'openai', providerModel: 'gpt-5.1' },
            {
              id: 'anthropic',
              providerProfileId: 'anthropic',
              providerModel: 'claude-sonnet-4-5',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            id: 'openai',
            kind: 'direct',
            models: ['gpt-5.1'],
            vendor: 'openai',
          }),
          profile({
            id: 'anthropic',
            kind: 'direct',
            models: ['claude-sonnet-4-5'],
            vendor: 'anthropic',
          }),
        ])
      )
    ).toThrow('Logical model routes cross model families: mixed.');
  });

  it('resolves the Gateway default logical model when no id is supplied', () => {
    const config = gateway({
      routes: [
        {
          id: 'primary',
          providerProfileId: 'orca-custom',
          providerModel: 'handwritten/local-flash',
        },
      ],
    });
    const providers = new ProviderRegistry([
      profile({
        baseUrl: 'https://orca.example/v1',
        id: 'orca-custom',
        models: ['handwritten/local-flash'],
      }),
    ]);

    expect(resolveLogicalModel(config, providers)).toEqual({
      id: 'local-free',
      displayName: 'local-free',
      modelFamilyId: null,
      contextManagement: { type: 'compaction', compactThreshold: 8_000 },
      capabilities: ['chat-completions', 'responses'],
      routes: [
        {
          id: 'primary',
          providerProfileId: 'orca-custom',
          providerModel: 'handwritten/local-flash',
        },
      ],
    });
  });

  it('still requires the provider profile to list the configured model id', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          routes: [
            {
              id: 'primary',
              providerProfileId: 'orca-custom',
              providerModel: 'handwritten/local-flash',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            id: 'orca-custom',
            models: ['other/model'],
          }),
        ])
      )
    ).toThrow('Logical model route model is not provided: primary.');
  });

  it('rejects an internal context policy that cannot fit every eligible route', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            {
              id: 'primary',
              providerProfileId: 'orca-custom',
              providerModel: 'handwritten/local-flash',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            id: 'orca-custom',
            modelMetadata: {
              'handwritten/local-flash': { limit: { context: 8_100, output: 200 } },
            },
            models: ['handwritten/local-flash'],
          }),
        ])
      )
    ).toThrow('Logical model context management exceeds a route limit: local-free.');
  });

  it('rejects an internal context policy that cannot fit a disabled sibling route', () => {
    expect(() =>
      resolveLogicalModelCatalog(
        gateway({
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            {
              id: 'primary',
              providerProfileId: 'primary-provider',
              providerModel: 'handwritten/local-flash',
            },
            {
              id: 'disabled',
              providerProfileId: 'disabled-provider',
              providerModel: 'handwritten/local-flash',
            },
          ],
        }),
        new ProviderRegistry([
          profile({
            id: 'primary-provider',
            modelMetadata: {
              'handwritten/local-flash': {
                family: 'local-flash',
                limit: { context: 20_000, output: 1_000 },
              },
            },
            models: ['handwritten/local-flash'],
          }),
          profile({
            id: 'disabled-provider',
            modelMetadata: {
              'handwritten/local-flash': {
                family: 'local-flash',
                limit: { context: 8_100, output: 200 },
              },
            },
            models: ['handwritten/local-flash'],
            readiness: { status: 'disabled', detail: 'Unavailable for dispatch.' },
          }),
        ])
      )
    ).toThrow('Logical model context management exceeds a route limit: local-free.');
  });

  it('inherits pinned catalog context and applies authored false, zero, and replacement leaves', () => {
    const effective = resolveEffectiveModelMetadata(
      profile({
        id: 'openrouter-test',
        kind: 'gateway',
        modelMetadata: {
          'openai/gpt-5.1': {
            cost: { input: 0 },
            limit: { output: 16 },
            reasoning: false,
          },
        },
        models: ['openai/gpt-5.1'],
        vendor: 'openrouter',
      }),
      'openai/gpt-5.1'
    );

    expect(effective.limit?.context).toBeGreaterThan(0);
    expect(effective.limit?.output).toBe(16);
    expect(effective.reasoning).toBe(false);
    expect(effective.cost?.input).toBe(0);
  });

  it('treats authored empty modality arrays as replacements rather than catalog inherit', () => {
    const inherited = resolveEffectiveModelMetadata(
      profile({
        id: 'openrouter-test',
        kind: 'gateway',
        models: ['openai/gpt-5.1'],
        vendor: 'openrouter',
      }),
      'openai/gpt-5.1'
    );
    expect((inherited.modalities?.input ?? []).length).toBeGreaterThan(0);
    expect((inherited.modalities?.output ?? []).length).toBeGreaterThan(0);

    const replaced = resolveEffectiveModelMetadata(
      profile({
        id: 'openrouter-test',
        kind: 'gateway',
        modelMetadata: {
          'openai/gpt-5.1': {
            limit: { context: 8192 },
            modalities: { input: [], output: [] },
          },
        },
        models: ['openai/gpt-5.1'],
        vendor: 'openrouter',
      }),
      'openai/gpt-5.1'
    );

    expect(replaced.modalities?.input).toEqual([]);
    expect(replaced.modalities?.output).toEqual([]);
  });

  it('does not invent context for an uncatalogued model and requires authored or catalog context', () => {
    const unknown = profile({
      id: 'orca-custom',
      models: ['handwritten/local-flash'],
      omitContextMetadata: true,
    });

    expect(
      resolveEffectiveModelMetadata(unknown, 'handwritten/local-flash').limit?.context
    ).toBeUndefined();
    expect(() => assertConfiguredModelsHaveKnownContext(new ProviderRegistry([unknown]))).toThrow(
      /orca-custom.*handwritten\/local-flash.*known positive context/s
    );
    expect(() =>
      assertConfiguredModelsHaveKnownContext(
        new ProviderRegistry([
          profile({
            id: 'orca-custom',
            modelMetadata: { 'handwritten/local-flash': { limit: { context: 8192 } } },
            models: ['handwritten/local-flash'],
          }),
        ])
      )
    ).not.toThrow();
    expect(
      hasCompleteCostRates(
        resolveEffectiveModelMetadata(
          profile({
            id: 'orca-custom',
            modelMetadata: {
              'handwritten/local-flash': { cost: { input: 1 }, limit: { context: 8192 } },
            },
            models: ['handwritten/local-flash'],
          }),
          'handwritten/local-flash'
        )
      )
    ).toBe(false);
    expect(
      mergeAdapterCostRates(
        { cacheRead: 0.1, cacheWrite: 1.25, input: 9, output: 8 },
        resolveEffectiveModelMetadata(
          profile({
            id: 'orca-custom',
            modelMetadata: {
              'handwritten/local-flash': { cost: { input: 1 }, limit: { context: 8192 } },
            },
            models: ['handwritten/local-flash'],
          }),
          'handwritten/local-flash'
        )
      )
    ).toEqual({
      complete: true,
      rates: { cacheRead: 0.1, cacheWrite: 1.25, input: 1, output: 8 },
    });
    expect(
      mergeAdapterCostRates(
        undefined,
        resolveEffectiveModelMetadata(
          profile({
            id: 'orca-custom',
            modelMetadata: {
              'handwritten/local-flash': { cost: { input: 1 }, limit: { context: 8192 } },
            },
            models: ['handwritten/local-flash'],
          }),
          'handwritten/local-flash'
        )
      )
    ).toEqual({ complete: false, rates: { input: 1 } });
  });
});
