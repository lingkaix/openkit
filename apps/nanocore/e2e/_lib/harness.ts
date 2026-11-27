import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';
import { shutdownControlStoreWorkerClient } from '../../dist/storage/control-store-worker-client.js';

export interface NanoCoreHarness {
  baseUrl: string;
  dataRoot: string;
  /** Marks the start of a child stderr window and returns its safe fingerprint reader. */
  startStderrFingerprint(): () => string;
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
const stderrFrameNames = new Map<string, string>();
for (const file of [
  'runtime/goal-owner',
  'runtime/goal-coordinator',
  'runtime/idempotent-command',
  'storage/control-store-worker-client',
  'operation-json-routes',
]) {
  for (const [directory, extension] of [
    ['src', 'ts'],
    ['dist', 'js'],
  ]) {
    const path = join(nanoCoreRoot, directory, `${file}.${extension}`);
    const name = basename(path);
    stderrFrameNames.set(path, name);
    stderrFrameNames.set(pathToFileURL(path).href, name);
  }
}

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
    OPENKIT_BIND_HOST: '127.0.0.1',
    OPENKIT_CORE_MODE: coreMode,
    OPENKIT_DATA_ROOT: dataRoot,
    PORT: String(port),
  };

  if (options.seedDemoWorkspace ?? coreMode === 'local') {
    await seedSharedDemoWorkspaceDataRoot(dataRoot);
    await seedDemoWorkspaceAuthority(dataRoot);
  }

  if (options.useSimulator ?? true) {
    env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
  } else {
    delete env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  }

  await shutdownControlStoreWorkerClient();
  const child = spawn(process.execPath, [join(nanoCoreRoot, 'dist', 'index.js')], {
    cwd: nanoCoreRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureProcessOutput(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(baseUrl, child, output);
  } catch (error) {
    // Failed-start tests retain caller-owned evidence but must never leak a writer.
    await killProcess(child);
    if (!options.dataRoot) await removeDataRoot(dataRoot);
    throw error;
  }

  return {
    baseUrl,
    dataRoot,
    startStderrFingerprint: output.startStderrFingerprint,
    kill: () => killProcess(child),
    stop: () => stopProcess(child),
  };
}

/** Completes first-admin setup through the public API using this disposable root's operator emission. */
export async function completeServerBootstrap(harness: NanoCoreHarness): Promise<string> {
  const owner = {
    email: 'bootstrap-owner@example.invalid',
    name: 'Bootstrap Owner',
    password: 'password123456',
  };
  const signup = await fetch(`${harness.baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(owner),
  });
  await signup.body?.cancel();
  if (signup.status !== 403) {
    throw new Error(`Pre-bootstrap signup must refuse; received ${signup.status}.`);
  }
  const emission = await readFile(
    join(harness.dataRoot, 'server', 'files', 'auth', 'bootstrap-token.txt'),
    'utf8'
  );
  const token = /^Token: (\S+)$/m.exec(emission)?.[1];
  if (!token) throw new Error('Disposable server bootstrap emission is unavailable.');
  const response = await fetch(`${harness.baseUrl}/api/app/operations/bootstrap.consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: owner.name,
      email: owner.email,
      ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      password: owner.password,
      token,
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Public server bootstrap must succeed; received ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string')
    throw new Error('Public server bootstrap did not return administrator access.');
  return body.token;
}

/**
 * Removes one temporary data root created by the harness.
 */
export async function removeDataRoot(dataRoot: string): Promise<void> {
  await rm(dataRoot, { force: true, recursive: true });
}

/**
 * Gives the shipped `smart` logical model live Gateway supply through a credential-free local Provider.
 *
 * Diagnostics publish `ready` only after setup supply accepts an Agent, and the
 * shipped `smart` routes need Provider credentials that a disposable root lacks.
 * Takes effect at the next NanoCore start.
 */
export async function seedLocalSmartSupply(dataRoot: string): Promise<void> {
  await writeFile(
    join(dataRoot, 'config', 'providers', 'e2e.provider.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'provider_e2e',
      displayName: 'E2E Provider',
      kind: 'local',
      baseUrl: 'https://provider.example.com/v1',
      models: ['model-e2e'],
      defaultModel: 'model-e2e',
      // The synthetic uncatalogued model still obeys boot's known-context contract.
      modelMetadata: { 'model-e2e': { limit: { context: 16_000 } } },
      readiness: { status: 'ready' },
    })
  );
  const gatewayPath = join(dataRoot, 'config', 'gateway.jsonc');
  const gateway = JSON.parse(await readFile(gatewayPath, 'utf8')) as {
    logicalModels: Array<{ id: string }>;
  };
  gateway.logicalModels = gateway.logicalModels.map((logicalModel) =>
    logicalModel.id === 'smart'
      ? {
          ...logicalModel,
          contextManagement: [{ type: 'compaction', compactThreshold: 12_000 }],
          routes: [
            { id: 'smart-e2e', providerProfileId: 'provider_e2e', providerModel: 'model-e2e' },
          ],
        }
      : logicalModel
  );
  await writeFile(gatewayPath, JSON.stringify(gateway));
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
  return postJson(`${baseUrl}/api/app/operations/turn.start`, {
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
    headers: {
      'content-type': 'application/json',
      ...(typeof body.requestId === 'string' ? { 'x-openkit-request-id': body.requestId } : {}),
    },
    body: JSON.stringify(
      url.includes('/api/app/operations/')
        ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'))
        : body
    ),
  });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

interface CapturedProcessOutput {
  stderr(): string;
  stdout(): string;
  startStderrFingerprint(): () => string;
}

/** Returns up to three distinct allowlisted V8 source locations without log text. */
function stderrFingerprint(window: string): string {
  const frames = new Set<string>();
  for (const line of window.split('\n')) {
    const frame = /^\s*at (?:async )?(?:.* \()?([^()]+):([1-9]\d{0,5}):\d+\)?\s*$/.exec(line);
    if (!frame) continue;
    const name = stderrFrameNames.get(frame[1]!);
    if (!name) continue;
    frames.add(`${name}:${frame[2]}`);
    if (frames.size === 3) break;
  }
  return frames.size === 0 ? 'unavailable' : [...frames].join(', ');
}

/**
 * Captures bounded child output for startup and request diagnostics.
 */
function captureProcessOutput(process: ChildProcessWithoutNullStreams): CapturedProcessOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stderrEnd = 0;
  const append = (buffer: string[], chunk: string) => {
    buffer.push(chunk);
    while (buffer.join('').length > 4000) {
      buffer.shift();
    }
  };

  process.stdout.on('data', (chunk: Buffer) => append(stdout, chunk.toString('utf8')));
  process.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrEnd += text.length;
    append(stderr, text);
  });

  return {
    stderr: () => stderr.join(''),
    stdout: () => stdout.join(''),
    startStderrFingerprint: () => {
      const start = stderrEnd;
      return () => {
        const retained = stderr.join('');
        // The cursor stays valid when the bounded buffer drops older chunks.
        return stderrFingerprint(
          retained.slice(Math.max(0, retained.length - (stderrEnd - start)))
        );
      };
    },
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
  let attempts = 0;
  let lastHealth = 'no response';

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `NanoCore exited before health check passed: ${process.exitCode}\nstdout:\n${output.stdout()}\nstderr:\n${output.stderr()}`
      );
    }

    try {
      attempts += 1;
      const response = await fetch(`${baseUrl}/api/health`);
      lastHealth = `HTTP ${response.status}`;

      if (response.ok) {
        return;
      }
    } catch (error) {
      lastHealth = error instanceof Error ? error.name : typeof error;
      if (
        error instanceof Error &&
        typeof error.cause === 'object' &&
        error.cause !== null &&
        'code' in error.cause &&
        typeof error.cause.code === 'string'
      ) {
        lastHealth += ` (${error.cause.code})`;
      }
      await sleep(100);
    }
  }

  throw new Error(
    `Timed out waiting for NanoCore health check. attempts=${attempts}; last=${lastHealth}; childExit=${process.exitCode}; childSignal=${process.signalCode}`
  );
}

/**
 * Terminates a spawned NanoCore process.
 */
async function stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  const timeout = setTimeout(() => process.kill('SIGKILL'), 2_000);
  process.kill('SIGTERM');
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

/** Immediately kills a spawned NanoCore process and waits for exit. */
async function killProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  process.kill('SIGKILL');
  await exited;
}

/**
 * Finds an available localhost TCP port.
 */
export async function findOpenPort(): Promise<number> {
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
