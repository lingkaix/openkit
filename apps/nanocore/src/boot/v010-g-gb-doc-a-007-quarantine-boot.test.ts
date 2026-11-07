// openkit-test-platform: posix
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { recordWorkspaceOwnerMembership } from '../storage/workspace-owner-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxCli = require.resolve('tsx/cli');
const BOOT_DEADLINE_MS = 90_000;
const children: ChildProcess[] = [];
const roots: string[] = [];

/**
 * GB-DOC-A-007. docs/core/fault-tolerance.md: a bad Workspace is quarantined and
 * stays inspectable; healthy Workspaces and the server still boot. Untrustworthy
 * Server Knowledge refuses whole-server boot. Fresh absence is not that failure.
 * Original Workspace bytes stay in place.
 */
describe('GB-DOC-A-007 boot quarantine', () => {
  afterEach(async () => {
    for (const child of children.splice(0)) {
      await stopChild(child);
    }
    await shutdownControlStoreWorkerClient();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('boots a healthy Workspace beside a malformed one, quarantines only the malformed Workspace, and preserves its bytes', async () => {
    const dataRoot = createRoot();
    const [healthyId, malformedId] = await seedWorkspaces(dataRoot, [
      'Healthy Workspace',
      'Malformed Workspace',
    ]);
    const malformedBody = '{ this is not a Workspace config\n';
    const malformedPath = writeWorkspaceConfig(dataRoot, malformedId, malformedBody);
    const server = await startServer(dataRoot);

    expect(server.output()).toContain('App server is running');
    expect(server.output()).not.toMatch(/NanoCore boot failed/);

    const healthy = await operation(server.baseUrl, 'workspace.read', { workspaceId: healthyId });
    expect(healthy.status).toBe(200);
    expect(healthy.body).toMatchObject({ id: healthyId, name: 'Healthy Workspace' });

    const refused = await operation(server.baseUrl, 'workspace.read', {
      workspaceId: malformedId,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'recovery_required',
      message: expect.stringMatching(/quarantined/i),
    });
    expect(JSON.stringify(refused.body)).toContain(malformedId);

    const diagnostics = await operation(server.baseUrl, 'diagnostics.app', {});
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body).toMatchObject({
      boot: {
        acceptingProductWork: true,
        subsystems: {
          storage: {
            reasons: expect.arrayContaining([
              expect.objectContaining({
                blocks: [`workspace:${malformedId}`],
                code: 'storage.scope-quarantined',
              }),
            ]),
          },
        },
      },
    });
    const storage = (
      diagnostics.body as {
        boot: { subsystems: { storage: { reasons: { blocks: string[]; message: string }[] } } };
      }
    ).boot.subsystems.storage;
    const quarantine = storage.reasons.find((reason) =>
      reason.blocks.includes(`workspace:${malformedId}`)
    );
    expect(quarantine?.message).toMatch(/check=/);
    expect(JSON.stringify(storage.reasons)).not.toContain(`workspace:${healthyId}`);
    expect(readFileSync(malformedPath, 'utf8')).toBe(malformedBody);
  }, 120_000);

  it('refuses server boot when Server Knowledge is present but untrustworthy', async () => {
    const dataRoot = createRoot();
    await seedWorkspaces(dataRoot, ['Healthy Workspace']);
    const knowledgeRoot = join(dataRoot, 'server', 'knowledge');
    const notebook = join(knowledgeRoot, 'notebook.git');
    mkdirSync(join(notebook, 'refs', 'heads'), { recursive: true });
    mkdirSync(join(knowledgeRoot, 'schema'), { recursive: true });
    writeFileSync(join(notebook, 'HEAD'), 'ref: refs/heads/published\n');
    writeFileSync(join(notebook, 'refs', 'heads', 'published'), `${'a'.repeat(40)}\n`);
    writeFileSync(join(knowledgeRoot, 'schema', 'scope-schema.yaml'), 'untrustworthy: [\n');

    const outcome = await runUntilBootDecision(dataRoot);
    expect(outcome.running).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(
      /NanoCore boot (failed during critical phase|blocked product work)/
    );
    expect(outcome.output.toLowerCase()).toMatch(/server knowledge/);
    expect(outcome.output).not.toContain('App server is running');
    const reason = outcome.output.split('NanoCore boot')[1] ?? '';
    expect(reason.trim().length).toBeGreaterThan('server knowledge'.length);
  }, 120_000);

  it('boots a fully healthy data root and serves its Workspace without quarantine', async () => {
    const dataRoot = createRoot();
    const [healthyId] = await seedWorkspaces(dataRoot, ['Healthy Workspace']);
    const server = await startServer(dataRoot);

    expect(server.output()).toContain('App server is running');
    const healthy = await operation(server.baseUrl, 'workspace.read', { workspaceId: healthyId });
    expect(healthy.status, JSON.stringify(healthy.body)).toBe(200);
    expect(healthy.body).toMatchObject({ id: healthyId, name: 'Healthy Workspace' });

    const diagnostics = await operation(server.baseUrl, 'diagnostics.app', {});
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body).toMatchObject({ boot: { acceptingProductWork: true } });
    expect(JSON.stringify(diagnostics.body)).not.toContain('storage.scope-quarantined');
    expect(JSON.stringify(diagnostics.body)).not.toContain(`workspace:${healthyId}`);
  }, 120_000);
});

function createRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-v010-g-boot-'));
  roots.push(dataRoot);
  return dataRoot;
}

async function seedWorkspaces(dataRoot: string, names: readonly string[]): Promise<string[]> {
  const store = createTestStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  try {
    const ownerUserId = ensureLocalUser(coreDb);
    const ids: string[] = [];
    for (const name of names) {
      const workspace = await store.createWorkspace(name);
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: workspace.id });
      ids.push(workspace.id);
    }
    return ids;
  } finally {
    closeTestCoreDb(coreDb);
    await shutdownControlStoreWorkerClient();
  }
}

function writeWorkspaceConfig(dataRoot: string, workspaceId: string, body: string): string {
  const directory = join(dataRoot, 'workspaces', workspaceId, 'config');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'workspace.jsonc');
  writeFileSync(path, body);
  return path;
}

async function startServer(dataRoot: string): Promise<{ baseUrl: string; output: () => string }> {
  const port = await findOpenPort();
  const child = spawnServer(dataRoot, port);
  const output = capture(child);
  try {
    await waitFor(child, output, /App server is running on http:\/\//);
  } catch (error) {
    throw new Error(
      `Expected the server to boot.\n${output()}\n${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { baseUrl: `http://127.0.0.1:${port}`, output };
}

async function runUntilBootDecision(dataRoot: string): Promise<{
  exitCode: number | null;
  output: string;
  running: boolean;
}> {
  const port = await findOpenPort();
  const child = spawnServer(dataRoot, port);
  const output = capture(child);
  const running = waitFor(child, output, /App server is running on http:\/\//).then(
    () => true,
    () => false
  );
  const exited = waitForExit(child).then(() => false);
  const decision = await Promise.race([running, exited]);
  if (decision) {
    await stopChild(child);
  }
  return { exitCode: child.exitCode, output: output(), running: decision };
}

function spawnServer(dataRoot: string, port: number): ChildProcess {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.BETTER_AUTH_SECRET;
  env.OPENKIT_CORE_MODE = 'local';
  env.OPENKIT_BIND_HOST = '127.0.0.1';
  env.OPENKIT_DATA_ROOT = dataRoot;
  env.PORT = String(port);
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function capture(child: ChildProcess): () => string {
  let text = '';
  const append = (chunk: Buffer | string) => {
    text = `${text}${chunk}`.slice(-24_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => text;
}

function waitFor(child: ChildProcess, output: () => string, pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(BOOT_DEADLINE_MS);
    const finish = (error?: Error) => {
      deadline.removeEventListener('abort', onAbort);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = () => {
      if (pattern.test(output())) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    };
    const onAbort = () => {
      finish(new Error('boot deadline elapsed before the server reported its listener'));
    };
    deadline.addEventListener('abort', onAbort);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
    onData();
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const deadline = AbortSignal.timeout(BOOT_DEADLINE_MS);
    const onAbort = () => {
      child.off('exit', onExit);
      reject(new Error('boot deadline elapsed before the process exited'));
    };
    const onExit = () => {
      deadline.removeEventListener('abort', onAbort);
      resolve();
    };
    deadline.addEventListener('abort', onAbort);
    child.once('exit', onExit);
  });
}

function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected a TCP port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function operation(
  baseUrl: string,
  id: string,
  body: Record<string, unknown>
): Promise<{ body: unknown; status: number }> {
  const response = await fetch(`${baseUrl}/api/app/operations/${id}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = { raw: text };
  }
  return { body: parsed, status: response.status };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      AbortSignal.timeout(5_000).addEventListener('abort', () => resolve(false));
    }),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
