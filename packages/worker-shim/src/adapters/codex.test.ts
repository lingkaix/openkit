import { lstatSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerAdapterPrepareInput, WorkerNativeProcessResult } from '../adapter-registry.js';
import { codexAdapter } from './codex.js';

const NATIVE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const finalMessageRace = vi.hoisted(() => ({
  path: null as string | null,
  replace: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1]
    ) => {
      const handle = await actual.open(path, flags);
      if (String(path) === finalMessageRace.path) {
        finalMessageRace.path = null;
        finalMessageRace.replace?.();
      }
      return handle;
    },
  };
});

/**
 * Creates one isolated Codex adapter input.
 *
 * @returns Adapter input with one already resolved LLM route.
 */
function codexInput(): WorkerAdapterPrepareInput {
  const root = mkdtempSync(join(tmpdir(), 'openkit-codex-adapter-'));

  return {
    childEnvironment: {
      OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
      PATH: process.env.PATH ?? '',
    },
    llmRoute: {
      credentialVisibility: 'placeholder',
      endpoint: {
        kind: 'openai-compatible',
        upstream: {
          baseUrlRef: 'runtime://nanocore/worker-inference/v1',
          kind: 'nanocore-gateway',
        },
        workerBaseUrl: 'https://nanocore.local/api/worker-inference/v1',
      },
      id: 'worker-inference',
      model: 'gpt-5',
      providerInstanceId: 'provider_openai',
    },
    sessionDirectory: join(root, 'session'),
    stateRoot: join(root, 'state'),
    turnInput: 'Summarize the repository.',
    workingDirectory: '/workspace/repository',
  };
}

/**
 * Creates one normally exited native process result.
 *
 * @param exitCode Native process exit code.
 * @returns Bounded process output presented to adapter collection.
 */
function nativeResult(exitCode = 0): WorkerNativeProcessResult {
  return {
    exitCode,
    interrupted: false,
    signal: null,
    stderr: '',
    stdout: new Uint8Array(),
  };
}

describe('Codex worker adapter', () => {
  it('creates the isolated Codex home before launch', async () => {
    const input = codexInput();

    await codexAdapter.prepare(input);

    expect(lstatSync(input.stateRoot).isDirectory()).toBe(true);
  });

  it('prepares the pinned one-shot command without a config-artifact envelope', async () => {
    const input = codexInput();
    const plan = await codexAdapter.prepare(input);

    expect(plan.argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--ephemeral',
      '--output-last-message',
      join(input.sessionDirectory, 'final-message.txt'),
      '--cd',
      input.workingDirectory,
      '-c',
      'model_provider="openkit-worker-inference"',
      '-c',
      'web_search="disabled"',
      '-c',
      'model_providers.openkit-worker-inference.name="OpenKit Worker Inference"',
      '-c',
      'model_providers.openkit-worker-inference.base_url="https://nanocore.local/api/worker-inference/v1"',
      '-c',
      'model_providers.openkit-worker-inference.env_key="OPENKIT_WORKER_INFERENCE_TOKEN"',
      '-c',
      'model_providers.openkit-worker-inference.wire_api="responses"',
      '-c',
      'model_providers.openkit-worker-inference.requires_openai_auth=false',
      '--model',
      'gpt-5',
      '--dangerously-bypass-approvals-and-sandbox',
      input.turnInput,
    ]);
    expect(plan.captureStdout).toBe(false);
    expect(plan.environment).toMatchObject({
      OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
    });
    expect(plan.environment.CODEX_HOME).toContain(input.stateRoot);
    expect(plan.argv).not.toContain('openshell-placeholder-value');
    expect(plan).not.toHaveProperty('configArtifacts');
  });

  it('rejects direct-provider authority before launch', async () => {
    const input = codexInput();

    await expect(
      codexAdapter.prepare({
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
    ).rejects.toThrow(/Codex direct-provider routes are unsupported/i);
  });

  it.each([
    {
      expected: { assistantText: 'Completed answer.', status: 'completed' },
      name: 'a regular final message',
      setup: (path: string) => writeFileSync(path, '  Completed answer.\n', 'utf8'),
    },
    {
      expected: { assistantText: null, status: 'completed' },
      name: 'an absent final message',
      setup: (_path: string) => undefined,
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'a non-file final path',
      setup: (path: string) => mkdirSync(path, { recursive: true }),
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'an oversized final message',
      setup: (path: string) => writeFileSync(path, Buffer.alloc(NATIVE_OUTPUT_MAX_BYTES + 1)),
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'an invalid UTF-8 final message',
      setup: (path: string) => writeFileSync(path, Buffer.from([0xff, 0x0a])),
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'a symlink final path',
      setup: (path: string) => {
        writeFileSync(`${path}.target`, 'must not be followed', 'utf8');
        symlinkSync(`${path}.target`, path);
      },
    },
    {
      expected: { assistantText: null, status: 'failed' },
      exitCode: 7,
      name: 'a non-zero process with a final message',
      setup: (path: string) => writeFileSync(path, 'must not be accepted', 'utf8'),
    },
  ])('collects $name fail closed', async ({ exitCode = 0, expected, setup }) => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const launchPlan = await codexAdapter.prepare(input);
    const finalMessageIndex = launchPlan.argv.indexOf('--output-last-message') + 1;
    const finalMessagePath = launchPlan.argv[finalMessageIndex];

    expect(finalMessagePath).toBeTruthy();
    setup(finalMessagePath as string);

    await expect(
      codexAdapter.collect({ launchPlan, processResult: nativeResult(exitCode) })
    ).resolves.toMatchObject(expected);
  });

  it('removes a stale final message before preparing a reused session', async () => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const firstPlan = await codexAdapter.prepare(input);
    const finalPath = firstPlan.argv[firstPlan.argv.indexOf('--output-last-message') + 1];

    expect(finalPath).toBeTruthy();
    writeFileSync(finalPath as string, 'stale assistant message', 'utf8');

    const launchPlan = await codexAdapter.prepare(input);
    await expect(
      codexAdapter.collect({ launchPlan, processResult: nativeResult() })
    ).resolves.toMatchObject({ assistantText: null, status: 'completed' });
  });

  it.each([
    { name: 'another regular file', replacement: 'replacement text' },
    { name: 'an oversized file', replacement: Buffer.alloc(NATIVE_OUTPUT_MAX_BYTES + 1) },
  ])('reads the opened final message when its path becomes $name', async ({ replacement }) => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const launchPlan = await codexAdapter.prepare(input);
    const finalPath = launchPlan.argv[launchPlan.argv.indexOf('--output-last-message') + 1];
    const openedPath = `${finalPath}.opened`;
    const replacementPath = `${finalPath}.replacement`;

    expect(finalPath).toBeTruthy();
    writeFileSync(finalPath as string, 'trusted final message', 'utf8');
    writeFileSync(replacementPath, replacement);
    finalMessageRace.path = finalPath as string;
    finalMessageRace.replace = () => {
      renameSync(finalPath as string, openedPath);
      renameSync(replacementPath, finalPath as string);
    };

    await expect(
      codexAdapter.collect({ launchPlan, processResult: nativeResult() })
    ).resolves.toMatchObject({ assistantText: 'trusted final message', status: 'completed' });
  });

  it('redacts exact relay credentials and common secret shapes from failure diagnostics', async () => {
    const input = codexInput();
    const launchPlan = await codexAdapter.prepare(input);
    const relayToken = input.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN as string;
    const apiKey = 'sk-secret-diagnostic-value';
    const result = await codexAdapter.collect({
      launchPlan,
      processResult: {
        ...nativeResult(7),
        stderr: `Authorization: Bearer ${relayToken} api_key=${apiKey}`,
        stdout: Buffer.from(`native output ${relayToken}`),
      },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(relayToken);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain('[redacted]');
  });
});
