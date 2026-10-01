import { describe, expect, it } from 'vitest';
import { AppDiagnosticsResponseSchema, ProviderModelDiagnosticSchema } from './diagnostics.js';

/** Complete public native-model row with no invented optional metadata. */
const MODEL = {
  id: 'model',
  context: { value: 10000, source: 'deployment-extension' },
  output: { value: null, source: null },
  inputModalities: { value: [], source: 'profile-override' },
  outputModalities: { value: null, source: null },
  reasoning: { value: false, source: 'profile-override' },
  reasoningEffortLevels: { value: [], source: 'deployment-extension' },
  cost: {
    input: { value: 0, source: 'profile-override' },
    output: { value: null, source: null },
    cache_read: { value: null, source: null },
    cache_write: { value: null, source: null },
  },
};

describe('Gateway model diagnostic admission', () => {
  it('preserves unknown, false, zero and explicit empty advertisements', () => {
    expect(ProviderModelDiagnosticSchema.parse(MODEL)).toEqual(MODEL);
  });
  it.each([
    { value: null, source: 'profile-override' },
    { value: 10000, source: null },
    { value: 10000, source: 'invented' },
    { value: 0, source: 'profile-override' },
  ])('fails closed on inconsistent source/value or invalid core context: %j', (context) => {
    expect(ProviderModelDiagnosticSchema.safeParse({ ...MODEL, context }).success).toBe(false);
  });
  it('rejects invented core modalities and effort levels', () => {
    expect(
      ProviderModelDiagnosticSchema.safeParse({
        ...MODEL,
        inputModalities: { value: ['invented'], source: 'profile-override' },
      }).success
    ).toBe(false);
    expect(
      ProviderModelDiagnosticSchema.safeParse({
        ...MODEL,
        reasoningEffortLevels: { value: ['invented'], source: 'deployment-extension' },
      }).success
    ).toBe(false);
  });
});

/** Full diagnostics boundary fixture; logical contract admission must match native metadata's closed modalities. */
function diagnosticsWithInputModalities(inputModalities: string[] | null) {
  const readiness = { state: 'ready', reasons: [] };
  return {
    service: 'nanocore',
    boot: {
      bootId: 'boot',
      acceptingProductWork: true,
      overall: 'ready',
      subsystems: {
        config: readiness,
        storage: readiness,
        policy: readiness,
        vault: readiness,
        scheduler: readiness,
        llmGateway: readiness,
        knowledgeIndex: readiness,
      },
    },
    process: {
      observedAt: '2026-10-02T00:00:00.000Z',
      nodeVersion: 'v24.18.0',
      uptimeSeconds: 1,
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
      telemetry: { enabled: false, exportConfigured: false },
    },
    gateway: {
      status: 'ok',
      endpoints: ['/v1/responses'],
      defaultModelId: 'tier',
      models: [
        {
          id: 'tier',
          displayName: 'Tier',
          capabilities: [],
          contract: { context: 10000, output: null, inputModalities, reasoning: null },
        },
      ],
    },
    providers: { diagnostics: [], registry: [] },
    capabilities: [],
    runtimeConfig: {
      currentVersion: 1,
      loadedAt: '2026-10-02T00:00:00.000Z',
      lastReload: null,
      lastFailedReload: null,
      pendingRestart: [],
      staleSessions: [],
    },
  };
}

describe('Round 2 full logical contract admission', () => {
  it('rejects unknown input modalities at the full diagnostics response boundary', () => {
    expect(
      AppDiagnosticsResponseSchema.safeParse(diagnosticsWithInputModalities(['text'])).success
    ).toBe(true);
    const result = AppDiagnosticsResponseSchema.safeParse(
      diagnosticsWithInputModalities(['invented'])
    );
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.path).toEqual([
        'gateway',
        'models',
        0,
        'contract',
        'inputModalities',
        0,
      ]);
  });
  it.each([
    { inputModalities: ['text', 'image', 'audio', 'video', 'pdf'] },
    { inputModalities: [] },
    { inputModalities: null },
  ])('preserves known, empty or unknown input modalities: $inputModalities', ({
    inputModalities,
  }) => {
    const input = diagnosticsWithInputModalities(inputModalities);
    expect(
      AppDiagnosticsResponseSchema.parse(input).gateway.models[0]?.contract?.inputModalities
    ).toEqual(inputModalities);
  });
});
