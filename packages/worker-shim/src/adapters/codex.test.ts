import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerAdapterPrepareInput, WorkerNativeProcessResult } from '../adapter-registry.js';
import { codexAdapter } from './codex.js';

const NATIVE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const TEST_THREAD_ID = '019f0000-0000-7000-8000-000000000099';
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
          kind: 'nanocore-gateway',
        },
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

/** Writes one pinned root rollout proving the exact native conversation UUID. */
function writeRootRollout(stateRoot: string, threadId: string): void {
  const directory = join(stateRoot, 'sessions', '2026', '08', '21');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `rollout-${threadId}.jsonl`),
    `${JSON.stringify({
      payload: {
        cli_version: '0.144.1',
        cwd: '/workspace/repository',
        id: threadId,
        originator: 'codex_exec',
        session_id: threadId,
        source: 'exec',
        timestamp: '2026-08-21T00:00:00.000Z',
      },
      timestamp: '2026-08-21T00:00:00.000Z',
      type: 'session_meta',
    })}\n`,
    'utf8'
  );
}

/** Supplies the native conversation proof required by a successful continuity Turn. */
async function collectTestTurn(
  input: WorkerAdapterPrepareInput,
  launchPlan: Awaited<ReturnType<typeof codexAdapter.prepareTurn>>,
  processResult: WorkerNativeProcessResult
) {
  if (processResult.exitCode === 0 && !processResult.interrupted) {
    writeRootRollout(input.stateRoot, TEST_THREAD_ID);
  }
  return codexAdapter.collectTurn({
    launchPlan,
    processResult:
      processResult.exitCode === 0 && !processResult.interrupted
        ? {
            ...processResult,
            stdout: Buffer.from(
              `${JSON.stringify({ thread_id: TEST_THREAD_ID, type: 'thread.started' })}\n`
            ),
          }
        : processResult,
    stateRoot: input.stateRoot,
  });
}

describe('Codex worker adapter', () => {
  it('opens a pending Session, establishes one exact UUID, resumes it, and closes only that root', async () => {
    const first = codexInput();
    const sibling = codexInput();
    const threadId = '019f0000-0000-7000-8000-000000000001';
    mkdirSync(first.sessionDirectory, { recursive: true });
    mkdirSync(sibling.sessionDirectory, { recursive: true });

    await expect(codexAdapter.openSession({ stateRoot: first.stateRoot })).resolves.toEqual({
      nativeHandle: null,
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
    });
    await codexAdapter.openSession({ stateRoot: sibling.stateRoot });
    const initialPlan = await codexAdapter.prepareTurn(first);
    expect(initialPlan.argv).not.toContain('resume');
    expect(initialPlan.argv).not.toContain('--ephemeral');
    writeRootRollout(first.stateRoot, threadId);
    writeFileSync(
      initialPlan.argv[initialPlan.argv.indexOf('--output-last-message') + 1] as string,
      'First answer.',
      'utf8'
    );

    const collected = await codexAdapter.collectTurn({
      launchPlan: initialPlan,
      processResult: {
        ...nativeResult(),
        stdout: Buffer.from(`${JSON.stringify({ thread_id: threadId, type: 'thread.started' })}\n`),
      },
      stateRoot: first.stateRoot,
    });
    expect(collected.nativeHandle).toBe(threadId);
    expect(collected.nativeHandleDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      codexAdapter.inspectSession({ stateRoot: first.stateRoot })
    ).resolves.toMatchObject({
      nativeHandleDigest: collected.nativeHandleDigest,
      nativeHandleState: 'ready',
    });

    const resumedPlan = await codexAdapter.prepareTurn(first);
    const resumeIndex = resumedPlan.argv.indexOf('resume');
    expect(resumedPlan.argv[resumeIndex + 1]).toBe('--json');
    expect(resumedPlan.argv.at(-2)).toBe(threadId);
    expect(resumedPlan.argv.at(-1)).toBe(first.turnInput);
    await expect(
      codexAdapter.inspectSession({ stateRoot: sibling.stateRoot })
    ).resolves.toMatchObject({
      nativeHandleState: 'pending',
    });

    await expect(
      codexAdapter.closeSession({
        sessionDirectory: first.sessionDirectory,
        stateRoot: first.stateRoot,
      })
    ).resolves.toEqual({ privateState: 'absent' });
    expect(existsSync(first.stateRoot)).toBe(false);
    expect(existsSync(sibling.stateRoot)).toBe(true);
  });

  it('creates the isolated Codex home before launch', async () => {
    const input = codexInput();

    await codexAdapter.prepareTurn(input);

    expect(lstatSync(input.stateRoot).isDirectory()).toBe(true);
  });

  it('prepares the pinned one-shot command without a config-artifact envelope', async () => {
    const input = codexInput();
    const plan = await codexAdapter.prepareTurn(input);

    expect(plan.argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
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
      'model_providers.openkit-worker-inference.base_url="http://127.0.0.1:17892/inference/v1"',
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
    expect(plan.captureStdout).toBe(true);
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
      codexAdapter.prepareTurn({
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
    const launchPlan = await codexAdapter.prepareTurn(input);
    const finalMessageIndex = launchPlan.argv.indexOf('--output-last-message') + 1;
    const finalMessagePath = launchPlan.argv[finalMessageIndex];

    expect(finalMessagePath).toBeTruthy();
    setup(finalMessagePath as string);

    await expect(collectTestTurn(input, launchPlan, nativeResult(exitCode))).resolves.toMatchObject(
      expected
    );
  });

  it('removes a stale final message before preparing a reused session', async () => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const firstPlan = await codexAdapter.prepareTurn(input);
    const finalPath = firstPlan.argv[firstPlan.argv.indexOf('--output-last-message') + 1];

    expect(finalPath).toBeTruthy();
    writeFileSync(finalPath as string, 'stale assistant message', 'utf8');

    const launchPlan = await codexAdapter.prepareTurn(input);
    await expect(collectTestTurn(input, launchPlan, nativeResult())).resolves.toMatchObject({
      assistantText: null,
      status: 'completed',
    });
  });

  it.each([
    { name: 'another regular file', replacement: 'replacement text' },
    { name: 'an oversized file', replacement: Buffer.alloc(NATIVE_OUTPUT_MAX_BYTES + 1) },
  ])('reads the opened final message when its path becomes $name', async ({ replacement }) => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const launchPlan = await codexAdapter.prepareTurn(input);
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

    await expect(collectTestTurn(input, launchPlan, nativeResult())).resolves.toMatchObject({
      assistantText: 'trusted final message',
      status: 'completed',
    });
  });

  it('redacts exact relay credentials and common secret shapes from failure diagnostics', async () => {
    const input = codexInput();
    const launchPlan = await codexAdapter.prepareTurn(input);
    const relayToken = input.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN as string;
    const apiKey = 'sk-secret-diagnostic-value';
    const result = await collectTestTurn(input, launchPlan, {
      ...nativeResult(7),
      stderr: `Authorization: Bearer ${relayToken} api_key=${apiKey}`,
      stdout: Buffer.from(`native output ${relayToken}`),
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(relayToken);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain('[redacted]');
  });
});
