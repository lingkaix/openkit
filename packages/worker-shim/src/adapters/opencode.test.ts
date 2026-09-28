import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorkerObservationData, WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import type { WorkerAdapterPrepareInput, WorkerNativeProcessResult } from '../adapter-registry.js';
import { opencodeAdapter } from './opencode.js';

/**
 * Creates one isolated OpenCode adapter input.
 *
 * @returns Adapter input with one Shim-selected LLM route.
 */
function opencodeInput(): WorkerAdapterPrepareInput {
  const root = mkdtempSync(join(tmpdir(), 'openkit-opencode-adapter-'));

  return {
    runtimeCapture: {
      captureCoverage: { scope: 'server', value: 'off' },
      packageSnapshotId: 'aep_test',
      credentialValues: [],
      emit: async () => undefined,
    },
    childEnvironment: {
      OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
      PATH: process.env.PATH ?? '',
    },
    controlRoot: join(root, 'control'),
    llmRoute: {
      credentialVisibility: 'placeholder',
      endpoint: {
        kind: 'openai-compatible',
        upstream: {
          kind: 'nanocore-gateway',
        },
      },
      id: 'worker-inference',
      model: 'gpt-5',
      providerInstanceId: 'provider_openai',
    },
    sessionDirectory: join(root, 'session'),
    stateRoot: join(root, 'state'),
    turnInput: 'Review the change.',
    workingDirectory: '/workspace/repository',
  };
}

/**
 * Creates one OpenCode process result from native JSON lines.
 *
 * @param records Native records or malformed lines.
 * @param exitCode Native process exit code.
 * @returns Bounded process output presented to adapter collection.
 */
function nativeResult(
  records: ReadonlyArray<Record<string, unknown> | string>,
  exitCode = 0
): WorkerNativeProcessResult {
  const stdout = records
    .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
    .join('\n');

  return {
    exitCode,
    interrupted: false,
    signal: null,
    stderr: '',
    stdout: Buffer.from(`${stdout}\n`),
  };
}

const stepStart = {
  part: { id: 'part-start', messageID: 'message-assistant', type: 'step-start' },
  type: 'step_start',
};
const firstText = {
  part: {
    id: 'part-text-1',
    messageID: 'message-assistant',
    text: 'First paragraph.',
    time: { end: 2, start: 1 },
    type: 'text',
  },
  type: 'text',
};
const secondText = {
  part: {
    id: 'part-text-2',
    messageID: 'message-assistant',
    text: 'Second paragraph.',
    time: { end: 4, start: 3 },
    type: 'text',
  },
  type: 'text',
};
const stepFinish = {
  part: { id: 'part-finish', messageID: 'message-assistant', type: 'step-finish' },
  type: 'step_finish',
};

describe('OpenCode worker adapter', () => {
  it.each([
    'on',
    'off',
  ] as const)('streams exposed tool and text content with capture %s and honest child coverage', async (value) => {
    const recorded: Array<{ record: WorkerObservationData; body?: Uint8Array }> = [];
    const base = opencodeInput();
    const plan = await opencodeAdapter.prepare({
      ...base,
      runtimeCapture: {
        ...base.runtimeCapture,
        captureCoverage: { scope: 'server', value },
        emit: async (record, body) => {
          recorded.push({
            record: WorkerObservationDataSchema.parse(record),
            ...(body ? { body } : {}),
          });
        },
      },
    });
    const text = '  outward 💡\n';
    const records = [
      {
        type: 'tool_use',
        sessionID: 'native-private',
        part: {
          type: 'tool',
          id: 'part-tool',
          callID: 'call-1',
          tool: 'read',
          state: {
            status: 'completed',
            input: { file: 'file.txt' },
            output: ' exact tool result\n',
          },
        },
      },
      { ...firstText, part: { ...firstText.part, text } },
      { type: 'reasoning', part: { text: 'unpublished-reasoning-canary' } },
    ];
    await plan.writeStdout!(nativeResult(records).stdout);
    expect(
      recorded.some(
        ({ record }) => record.fact.kind === 'tool' && record.fact.phase === 'completed'
      )
    ).toBe(true);
    expect(
      recorded
        .filter(({ record }) => record.fact.coverage === 'unsupported')
        .map(({ record }) => record.fact.family)
    ).toEqual(['child-metadata', 'child-content']);
    if (value === 'on')
      expect(recorded.map(({ body }) => body && Buffer.from(body).toString())).toEqual(
        expect.arrayContaining([text, ' exact tool result\n', '{"file":"file.txt"}'])
      );
    else expect(recorded.every(({ body }) => body === undefined)).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('unpublished-reasoning-canary');
    await plan.finalize!();
  });
  it('prepares the pinned one-shot command and isolated native state', async () => {
    const input = opencodeInput();
    const plan = await opencodeAdapter.prepare(input);

    expect(plan.argv).toEqual([
      'opencode',
      'run',
      '--format',
      'json',
      '--dir',
      input.workingDirectory,
      '--model',
      'openkit-worker-inference/gpt-5',
      input.turnInput,
    ]);
    expect(plan.captureStdout).toBe(true);
    expect(plan.environment).toMatchObject({
      OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_AUTO_SHARE: '0',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_PURE: '1',
      OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
    });
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
    ]) {
      expect(plan.environment[key]).toContain(input.stateRoot);
    }
    expect(JSON.parse(plan.environment.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      autoupdate: false,
      enabled_providers: ['openkit-worker-inference'],
      model: 'openkit-worker-inference/gpt-5',
      provider: {
        'openkit-worker-inference': {
          models: { 'gpt-5': { name: 'gpt-5' } },
          name: 'OpenKit Worker Inference',
          npm: '@ai-sdk/openai',
          options: {
            apiKey: '{env:OPENKIT_WORKER_INFERENCE_TOKEN}',
            baseURL: 'http://127.0.0.1:17892/inference/v1',
          },
        },
      },
      share: 'disabled',
    });
    expect(plan.environment.OPENCODE_CONFIG_CONTENT).not.toContain('openshell-placeholder-value');
    expect(plan).not.toHaveProperty('configArtifacts');
  });

  it('rejects direct-provider authority before launch', async () => {
    const input = opencodeInput();

    await expect(
      opencodeAdapter.prepare({
        ...input,
        childEnvironment: { OPENAI_API_KEY: 'provider-credential-value' },
        llmRoute: {
          credentialVisibility: 'environment',
          endpoint: {
            kind: 'provider-compatible',
            upstream: { kind: 'direct-provider' },
          },
          id: 'worker-inference',
          model: 'gpt-5',
          providerInstanceId: 'openai',
        },
      })
    ).rejects.toThrow(/OpenCode direct-provider routes are unsupported/i);
  });

  it('rejects a caller-selected URL on a local Integration route', async () => {
    const input = opencodeInput();

    await expect(
      opencodeAdapter.prepare({
        ...input,
        llmRoute: {
          ...input.llmRoute,
          endpoint: {
            ...input.llmRoute.endpoint,
            workerBaseUrl: 'https://example.invalid/v1',
          },
        },
      })
    ).rejects.toThrow(/local Integration/i);
  });

  it('collects only completed text for the tracked assistant step', async () => {
    const launchPlan = await opencodeAdapter.prepare(opencodeInput());
    const processResult = nativeResult([
      stepStart,
      {
        ...firstText,
        part: { ...firstText.part, id: 'foreign-text', messageID: 'other-message' },
      },
      {
        ...firstText,
        part: { ...firstText.part, id: 'ignored-text', ignored: true },
      },
      firstText,
      { type: 'future_runtime_event' },
      secondText,
      stepFinish,
    ]);

    await expect(opencodeAdapter.collect({ launchPlan, processResult })).resolves.toMatchObject({
      assistantText: 'First paragraph.\n\nSecond paragraph.',
      status: 'completed',
    });
  });

  it.each([
    { name: 'malformed JSON', records: ['{not-json'] },
    { name: 'a missing terminal step', records: [stepStart, firstText] },
    {
      name: 'a native error',
      records: [stepStart, firstText, { error: { message: 'provider failed' }, type: 'error' }],
    },
    {
      name: 'an incomplete tracked text part',
      records: [
        stepStart,
        {
          part: {
            messageID: 'message-assistant',
            text: 'unfinished',
            time: { start: 1 },
            type: 'text',
          },
          type: 'text',
        },
        stepFinish,
      ],
    },
    { exitCode: 1, name: 'a non-zero process', records: [stepStart, firstText, stepFinish] },
  ])('fails closed on $name', async ({ exitCode = 0, records }) => {
    const launchPlan = await opencodeAdapter.prepare(opencodeInput());

    await expect(
      opencodeAdapter.collect({ launchPlan, processResult: nativeResult(records, exitCode) })
    ).resolves.toMatchObject({ assistantText: null, status: 'failed' });
  });

  it('fails closed on invalid UTF-8 stdout', async () => {
    const launchPlan = await opencodeAdapter.prepare(opencodeInput());

    await expect(
      opencodeAdapter.collect({
        launchPlan,
        processResult: {
          exitCode: 0,
          interrupted: false,
          signal: null,
          stderr: '',
          stdout: Buffer.from([0xff, 0x0a]),
        },
      })
    ).resolves.toMatchObject({ assistantText: null, status: 'failed' });
  });
});
