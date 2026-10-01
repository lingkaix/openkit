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
  it.each([
    'absent',
    'delisted',
  ])('derives the complete contract without constraining a %s backup', (kind) => {
    const primary = profile({
      id: 'primary',
      models: ['primary-model'],
      modelMetadata: {
        'primary-model': {
          family: 'primary-family',
          limit: { context: 128_000, output: 16_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          reasoning: true,
          tool_call: true,
        },
      },
    });
    const [model] = resolveLogicalModelCatalog(
      gateway({
        routes: [
          { id: 'primary', providerProfileId: 'primary', providerModel: 'primary-model' },
          { id: 'backup', providerProfileId: 'backup', providerModel: 'missing-model' },
        ],
      }),
      new ProviderRegistry([
        primary,
        ...(kind === 'absent' ? [] : [profile({ id: 'backup', models: ['different-model'] })]),
      ])
    );
    expect(model).toMatchObject({
      modelFamilyId: 'primary-family',
      modelParameters: {
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        inputModalities: ['text', 'image'],
        reasoning: true,
      },
      routes: [
        { available: true },
        {
          available: false,
          unavailableReason:
            kind === 'absent' ? 'provider_profile_absent' : 'provider_model_delisted',
        },
      ],
    });
    expect(model?.capabilities).toEqual([
      'chat-completions',
      'input:image',
      'input:text',
      'output:text',
      'reasoning',
      'responses',
      'tool-calling',
    ]);
  });

  it('derives a coherent mixed-family contract over all authored members', () => {
    const [model] = resolveLogicalModelCatalog(
      gateway({
        routes: [
          { id: 'primary', providerProfileId: 'a', providerModel: 'a' },
          { id: 'backup', providerProfileId: 'b', providerModel: 'b' },
        ],
      }),
      new ProviderRegistry([
        profile({
          id: 'a',
          models: ['a'],
          modelMetadata: {
            a: {
              family: 'family-a',
              limit: { context: 128_000, output: 16_000 },
              modalities: { input: ['text', 'image'], output: ['text'] },
              reasoning: true,
              tool_call: true,
            },
          },
        }),
        profile({
          id: 'b',
          models: ['b'],
          modelMetadata: {
            b: {
              family: 'family-b',
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ['text', 'audio'], output: ['text'] },
              tool_call: false,
            },
          },
        }),
      ])
    );
    expect(model).toMatchObject({
      autoFailover: true,
      modelFamilyId: null,
      modelParameters: {
        contextWindow: 64_000,
        maxOutputTokens: 8_000,
        inputModalities: ['text'],
        reasoning: false,
      },
    });
    expect(model?.capabilities).toEqual([
      'chat-completions',
      'input:text',
      'output:text',
      'responses',
    ]);
  });

  it('projects complete effective model parameters without filtering modalities or replacing false', () => {
    const metadata = {
      limit: { context: 128_000, output: 16_000 },
      modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'] },
      reasoning: false,
    };
    const provider = profile({
      baseUrl: 'https://orca.example/v1',
      id: 'orca-custom',
      models: ['handwritten/local-flash'],
      modelMetadata: { 'handwritten/local-flash': metadata },
    });
    const [model] = resolveLogicalModelCatalog(
      gateway({
        routes: [
          { id: 'primary', providerProfileId: provider.id, providerModel: provider.models[0]! },
        ],
      }),
      new ProviderRegistry([provider])
    );

    expect(model).toHaveProperty('modelParameters', {
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
      reasoning: false,
    });
    expect(metadata).toEqual({
      limit: { context: 128_000, output: 16_000 },
      modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'] },
      reasoning: false,
    });
  });

  it.each([
    { label: 'matching', overlay: {}, projected: true },
    {
      label: 'conflicting context',
      overlay: { limit: { context: 256_000, output: 16_000 } },
      projected: true,
    },
    {
      label: 'conflicting output',
      overlay: { limit: { context: 128_000, output: 8_000 } },
      projected: true,
    },
    {
      label: 'conflicting modalities',
      overlay: { modalities: { input: ['text', 'image'] } },
      projected: true,
    },
    { label: 'conflicting reasoning', overlay: { reasoning: true }, projected: true },
    { label: 'missing output', overlay: { limit: { context: 128_000 } }, projected: true },
    { label: 'missing modalities', overlay: { modalities: undefined }, projected: false },
    { label: 'missing reasoning', overlay: { reasoning: undefined }, projected: true },
  ])('projects only coherent model parameters across authored routes: $label', ({
    label,
    overlay,
    projected,
  }) => {
    const metadata = {
      family: 'local-model',
      limit: { context: 128_000, output: 16_000 },
      modalities: { input: ['text'] },
      reasoning: false,
    };
    const [model] = resolveLogicalModelCatalog(
      gateway({
        routes: [
          { id: 'primary', providerProfileId: 'primary', providerModel: 'handwritten/local-flash' },
          { id: 'blocked', providerProfileId: 'blocked', providerModel: 'handwritten/local-flash' },
        ],
      }),
      new ProviderRegistry([
        profile({
          id: 'primary',
          baseUrl: 'https://primary.example/v1',
          models: ['handwritten/local-flash'],
          modelMetadata: { 'handwritten/local-flash': metadata },
        }),
        profile({
          id: 'blocked',
          baseUrl: 'https://blocked.example/v1',
          models: ['handwritten/local-flash'],
          readiness: { status: 'blocked', message: 'Unavailable' },
          modelMetadata: { 'handwritten/local-flash': { ...metadata, ...overlay } },
        }),
      ])
    );

    expect(model?.routes).toHaveLength(2);
    if (projected) {
      expect(model).toHaveProperty('modelParameters', {
        contextWindow: 128_000,
        maxOutputTokens: label === 'conflicting output' ? 8_000 : 16_000,
        inputModalities: ['text'],
        reasoning: false,
      });
    } else {
      expect(model).not.toHaveProperty('modelParameters');
    }
  });

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
        autoFailover: true,
        contract: { context: 1000000, output: null, inputModalities: null, reasoning: null },
        id: 'local-free',
        displayName: 'local-free',
        modelFamilyId: null,
        contextManagement: { type: 'compaction', compactThreshold: 8_000 },
        capabilities: ['chat-completions', 'responses'],
        routes: [
          {
            available: true,
            unavailableReason: null,
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
        autoFailover: true,
        contract: {
          context: 1000000,
          output: 8000,
          inputModalities: ['text', 'image'],
          reasoning: true,
        },
        id: 'openrouter-free',
        displayName: 'openrouter-free',
        modelFamilyId: null,
        reasoningEffortLevels: [],
        modelParameters: {
          contextWindow: 1_000_000,
          maxOutputTokens: 8_000,
          inputModalities: ['text', 'image'],
          reasoning: true,
        },
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
            available: true,
            unavailableReason: null,
            id: 'primary',
            providerProfileId: 'openrouter-test',
            providerModel: 'openrouter/free',
          },
        ],
      },
    ]);
  });

  it('retains mixed families when an authored sibling is blocked', () => {
    expect(
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
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mixed-admission', modelFamilyId: null }),
      ])
    );
  });

  it('retains the logical id when an authored sibling profile is undeployed', () => {
    expect(
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
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'mixed-undeployed',
          modelFamilyId: 'gpt',
          routes: expect.arrayContaining([
            expect.objectContaining({
              id: 'missing',
              available: false,
              unavailableReason: 'provider_profile_absent',
            }),
          ]),
        }),
      ])
    );
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
        routes: [
          {
            id: 'blocked',
            providerProfileId: 'blocked',
            providerModel: 'gpt-5.1',
            available: false,
            unavailableReason: 'provider_not_dispatchable',
          },
          {
            id: 'ready',
            providerProfileId: 'ready',
            providerModel: 'gpt-5.1',
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ]);
  });

  it('admits multiple unknown-family authored routes', () => {
    expect(
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
    ).toEqual(expect.arrayContaining([expect.objectContaining({ modelFamilyId: null })]));
  });

  it('admits distinct known catalog families with null logical family', () => {
    expect(
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
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'mixed', modelFamilyId: null })])
    );
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
      autoFailover: true,
      contract: { context: 1000000, output: null, inputModalities: null, reasoning: null },
      id: 'local-free',
      displayName: 'local-free',
      modelFamilyId: null,
      contextManagement: { type: 'compaction', compactThreshold: 8_000 },
      capabilities: ['chat-completions', 'responses'],
      routes: [
        {
          available: true,
          unavailableReason: null,
          id: 'primary',
          providerProfileId: 'orca-custom',
          providerModel: 'handwritten/local-flash',
        },
      ],
    });
  });

  it('retains a delisted member as unavailable without using catalog metadata', () => {
    expect(
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
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-free',
          modelFamilyId: null,
          routes: [
            expect.objectContaining({
              id: 'primary',
              available: false,
              unavailableReason: 'provider_model_delisted',
            }),
          ],
        }),
      ])
    );
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

describe('reasoning effort levels', () => {
  it.each([
    { label: 'toggle', reasoning: true, options: [{ type: 'toggle' }], levels: ['none'] },
    {
      label: 'effort order and deduplication',
      reasoning: true,
      options: [
        {
          type: 'effort',
          values: ['max', 'high', 'low', 'high', 'minimal', 'medium', 'xhigh', 'none'],
        },
      ],
      levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      label: 'toggle plus effort',
      reasoning: true,
      options: [{ type: 'effort', values: ['high'] }, { type: 'toggle' }],
      levels: ['none', 'high'],
    },
    { label: 'no options', reasoning: true, options: undefined, levels: [] },
    { label: 'empty options', reasoning: true, options: [], levels: [] },
    {
      label: 'empty effort',
      reasoning: true,
      options: [{ type: 'effort', values: [] }],
      levels: [],
    },
    {
      label: 'false reasoning',
      reasoning: false,
      options: [{ type: 'toggle' }],
      levels: undefined,
    },
    {
      label: 'unknown reasoning',
      reasoning: undefined,
      options: [{ type: 'effort', values: ['high'] }],
      levels: undefined,
    },
  ])('derives $label', ({ reasoning, options, levels }) => {
    const providers = new ProviderRegistry([
      profile({
        id: 'test',
        models: ['model'],
        modelMetadata: {
          model: {
            reasoning,
            reasoning_options: options,
            limit: { context: 100000 },
          },
        },
      }),
    ]);
    const [model] = resolveLogicalModelCatalog(
      gateway({ routes: [{ id: 'test', providerProfileId: 'test', providerModel: 'model' }] }),
      providers
    );
    if (levels === undefined) expect(model).not.toHaveProperty('reasoningEffortLevels');
    else expect(model).toHaveProperty('reasoningEffortLevels', levels);
  });

  it.each([
    { options: undefined, levels: [] },
    { options: [], levels: [] },
    { options: [{ type: 'effort', values: ['high', 'medium'] }], levels: ['medium', 'high'] },
    { options: [{ type: 'effort', values: ['max'] }], levels: [] },
  ])('intersects every available member, including missing options: %j', ({ options, levels }) => {
    const providers = new ProviderRegistry(
      ['a', 'b', 'blocked'].map((id) =>
        profile({
          id,
          models: ['model'],
          ...(id === 'blocked' ? { readiness: { status: 'disabled' as const } } : {}),
          modelMetadata: {
            model: {
              reasoning: true,
              limit: { context: 100000 },
              reasoning_options:
                id === 'a'
                  ? [{ type: 'effort', values: ['high', 'low', 'medium'] }]
                  : id === 'b'
                    ? options
                    : [],
            },
          },
        })
      )
    );
    const config = gateway({
      routes: ['a', 'b', 'blocked', 'missing'].map((id) => ({
        id,
        providerProfileId: id,
        providerModel: 'model',
      })),
    });
    expect(resolveLogicalModelCatalog(config, providers)[0]).toHaveProperty(
      'reasoningEffortLevels',
      levels
    );
  });

  it('ignores out-of-enum pinned catalog values', () => {
    const providers = new ProviderRegistry([
      profile({ id: 'groq', vendor: 'groq', models: ['qwen/qwen3.8-27b'] }),
    ]);
    const config = gateway({
      routes: [{ id: 'test', providerProfileId: 'groq', providerModel: 'qwen/qwen3.8-27b' }],
    });
    expect(
      resolveEffectiveModelMetadata(providers.get('groq')!, 'qwen/qwen3.8-27b')
    ).toHaveProperty('reasoning_options', [
      { type: 'effort', values: ['none', 'default', 'low', 'medium', 'high'] },
    ]);
    expect(resolveLogicalModelCatalog(config, providers)[0]).toHaveProperty(
      'reasoningEffortLevels',
      ['none', 'low', 'medium', 'high']
    );
  });

  it('recomputes intersection on live subscription supply changes without resolver restart', () => {
    const providers = new ProviderRegistry(
      ['a', 'b'].map((id) =>
        profile({
          id,
          vendor: 'openai-codex',
          kind: 'oauth',
          models: ['model'],
          extensions: { openkit: { subscriptionAccount: { accountSlotId: id } } },
          modelMetadata: {
            model: {
              reasoning: true,
              limit: { context: 100000 },
              reasoning_options: [
                { type: 'effort', values: id === 'a' ? ['high', 'low'] : ['low'] },
              ],
            },
          },
        })
      )
    );
    const config = gateway({
      routes: ['a', 'b'].map((id) => ({ id, providerProfileId: id, providerModel: 'model' })),
    });
    let unavailable = false;
    const accounts = {
      gatewayUnavailableReason: ({ accountSlotId }: { accountSlotId: string }) =>
        unavailable && accountSlotId === 'b' ? 'subscription_account_unavailable' : null,
    };
    expect(resolveLogicalModelCatalog(config, providers, accounts)[0]).toHaveProperty(
      'reasoningEffortLevels',
      ['low']
    );
    unavailable = true;
    expect(resolveLogicalModelCatalog(config, providers, accounts)[0]).toHaveProperty(
      'reasoningEffortLevels',
      ['low', 'high']
    );
    unavailable = false;
    expect(resolveLogicalModelCatalog(config, providers, accounts)[0]).toHaveProperty(
      'reasoningEffortLevels',
      ['low']
    );
  });
});

it('does not advertise a control when an available member lacks reasoning', () => {
  const providers = new ProviderRegistry(
    ['a', 'b'].map((id) =>
      profile({
        id,
        models: ['model'],
        modelMetadata: {
          model: {
            reasoning: id === 'a',
            limit: { context: 100000 },
            reasoning_options: [{ type: 'effort', values: ['high'] }],
          },
        },
      })
    )
  );
  const config = gateway({
    routes: ['a', 'b'].map((id) => ({ id, providerProfileId: id, providerModel: 'model' })),
  });
  expect(resolveLogicalModelCatalog(config, providers)[0]).not.toHaveProperty(
    'reasoningEffortLevels'
  );
});

it('ignores pinned token-budget options without inventing effort levels', () => {
  const providers = new ProviderRegistry([
    profile({ id: 'anthropic', models: ['claude-haiku-4-5'] }),
  ]);
  const config = gateway({
    routes: [{ id: 'test', providerProfileId: 'anthropic', providerModel: 'claude-haiku-4-5' }],
  });
  expect(
    resolveEffectiveModelMetadata(providers.get('anthropic')!, 'claude-haiku-4-5')
  ).toHaveProperty('reasoning_options', []);
  expect(resolveLogicalModelCatalog(config, providers)[0]).toHaveProperty(
    'reasoningEffortLevels',
    []
  );
});
