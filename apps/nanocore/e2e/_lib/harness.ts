import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';

export interface NanoCoreHarness {
  baseUrl: string;
  dataRoot: string;
  /** Immediately kills the child process and waits for exit. */
  kill(): Promise<void>;
  stop(): Promise<void>;
}

export interface NanoCoreHarnessOptions {
  coreMode?: 'local' | 'server';
  dataRoot?: string;
  env?: Record<string, string | undefined>;
  /** Fixed listener port reused across process restart. */
  port?: number;
  seedDemoWorkspace?: boolean;
  useSimulator?: boolean;
}

interface SseEventEnvelope {
  event: string;
  sequence: number;
  workspaceId: string;
  threadId: string;
  turnId: string;
  data: Record<string, unknown>;
}

const nanoCoreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Starts a built NanoCore process for black-box e2e tests.
 */
export async function startNanoCoreHarness(
  options: NanoCoreHarnessOptions = {}
): Promise<NanoCoreHarness> {
  const port = options.port ?? (await findOpenPort());
  const dataRoot = options.dataRoot ?? (await mkdtemp(join(tmpdir(), 'openkit-nanocore-e2e-')));
  const coreMode = options.coreMode ?? 'local';
  const env: NodeJS.ProcessEnv = {
    ...processEnv(),
    ...(coreMode === 'server'
      ? { BETTER_AUTH_SECRET: 'openkit-nanocore-e2e-server-secret-at-least-32-characters' }
      : {}),
    ...options.env,
    OPENKIT_CORE_MODE: coreMode,
    OPENKIT_DATA_ROOT: dataRoot,
    PORT: String(port),
  };

  if (options.seedDemoWorkspace ?? coreMode === 'local') {
    seedSharedDemoWorkspaceDataRoot(dataRoot);
    await seedDemoWorkspaceAuthority(dataRoot);
  }

  if (options.useSimulator ?? true) {
    env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
  } else {
    delete env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  }

  const child = spawn(process.execPath, [join(nanoCoreRoot, 'dist', 'index.js')], {
    cwd: nanoCoreRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureProcessOutput(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  await waitForHealth(baseUrl, child, output);

  return {
    baseUrl,
    dataRoot,
    kill: () => killProcess(child),
    stop: () => stopProcess(child),
  };
}

/**
 * Removes one temporary data root created by the harness.
 */
export async function removeDataRoot(dataRoot: string): Promise<void> {
  await rm(dataRoot, { force: true, recursive: true });
}

/**
 * Reads SSE turn events until the supplied predicate is true.
 */
export async function readTurnEventsUntil(
  baseUrl: string,
  workspaceId: string,
  threadId: string,
  turnId: string,
  predicate: (event: SseEventEnvelope, events: SseEventEnvelope[]) => boolean,
  timeoutMs = 15_000
): Promise<SseEventEnvelope[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: SseEventEnvelope[] = [];

  try {
    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/events?turnId=${turnId}&since=0`,
      { signal: controller.signal }
    );

    if (!response.ok || !response.body) {
      throw new Error(`SSE request failed with ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        return events;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));

        if (!dataLine) {
          continue;
        }

        const event = JSON.parse(dataLine.slice('data: '.length)) as SseEventEnvelope;
        events.push(event);

        if (predicate(event, events)) {
          await reader.cancel();
          return events;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Starts one turn through the public HTTP API.
 */
export async function startTurn(
  baseUrl: string,
  workspaceId: string,
  threadId: string,
  input: string
): Promise<Record<string, unknown>> {
  return postJson(`${baseUrl}/api/turns`, {
    workspaceId,
    threadId,
    input,
    requestId: randomUUID(),
  });
}

/**
 * Returns process environment variables in a mockable wrapper.
 */
function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * Posts a JSON body and returns a JSON object response.
 */
async function postJson(
  url: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

interface CapturedProcessOutput {
  stderr(): string;
  stdout(): string;
}

/**
 * Captures bounded child output for startup diagnostics.
 */
function captureProcessOutput(process: ChildProcessWithoutNullStreams): CapturedProcessOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const append = (buffer: string[], chunk: Buffer) => {
    buffer.push(chunk.toString('utf8'));
    while (buffer.join('').length > 4000) {
      buffer.shift();
    }
  };

  process.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
  process.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));

  return {
    stderr: () => stderr.join(''),
    stdout: () => stdout.join(''),
  };
}

/**
 * Waits until the spawned process responds to `/api/health`.
 */
async function waitForHealth(
  baseUrl: string,
  process: ChildProcessWithoutNullStreams,
  output: CapturedProcessOutput
): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `NanoCore exited before health check passed: ${process.exitCode}\nstdout:\n${output.stdout()}\nstderr:\n${output.stderr()}`
      );
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(100);
    }
  }

  throw new Error('Timed out waiting for NanoCore health check.');
}

/**
 * Terminates a spawned NanoCore process.
 */
async function stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.killed) {
    return;
  }

  process.kill('SIGTERM');

  await Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    sleep(2_000).then(() => {
      if (process.exitCode === null && !process.killed) {
        process.kill('SIGKILL');
      }
    }),
  ]);
}

/** Immediately kills a spawned NanoCore process and waits for exit. */
async function killProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null) {
    return;
  }
  process.kill('SIGKILL');
  await new Promise<void>((resolve) => process.once('exit', () => resolve()));
}

/**
 * Finds an available localhost TCP port.
 */
async function findOpenPort(): Promise<number> {
  const { createServer } = await import('node:net');

  return await new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (typeof address !== 'object' || address === null) {
        reject(new Error('Failed to allocate an open port.'));
        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

/**
 * Waits for the requested duration.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
