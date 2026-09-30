// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerHarness } from '../harness.js';
import type { SandboxIntegrationClient } from '../integration-client.js';
import { createPiResidentAdapter } from './pi.js';

const HOST_BIN = fileURLToPath(
  new URL('../../../pi-runtime-host/src/bin/openkit-pi-runtime-host.ts', import.meta.url)
);
const TIMEOUT = 120_000;
const SCRATCH = '/tmp/openkit-bootstrap';
const DIGEST = 'a'.repeat(64);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function credential(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}

/** Records the Integration calls the Harness makes. No listener is bound. */
function fakeIntegration(finalStatuses: unknown[]): SandboxIntegrationClient {
  const loopbacks = new Set<string>();
  return {
    ready: Promise.resolve(),
    registerSessionLoopback(agentSessionId: string) {
      if (loopbacks.has(agentSessionId)) throw new Error('loopback conflict');
      loopbacks.add(agentSessionId);
    },
    destroySessionLoopback(agentSessionId: string) {
      loopbacks.delete(agentSessionId);
    },
    bindTurnRouteTokens() {
      return undefined;
    },
    clearTurnRouteTokens() {
      return undefined;
    },
    async drainTurn() {
      return 0;
    },
    workerControlFetch: async (url: string, init: { body: string }) => {
      if (url.endsWith('/final-status')) finalStatuses.push(JSON.parse(init.body) as unknown);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
      };
    },
  } as unknown as SandboxIntegrationClient;
}

function harnessFor(
  root: string,
  hostCommand: readonly string[] = [process.execPath, '--no-warnings', HOST_BIN]
) {
  const sandboxRoot = join(root, 'openkit');
  const nativeRoot = join(root, 'sandbox', 'native');
  const finalStatuses: unknown[] = [];
  mkdirSync(sandboxRoot, { recursive: true });
  mkdirSync(nativeRoot, { recursive: true });
  const harness = new WorkerHarness({
    adapters: { pi: createPiResidentAdapter({ hostCommand }) },
    environment: { HOME: join(root, 'home'), PATH: process.env.PATH ?? '' },
    integration: fakeIntegration(finalStatuses),
    nativeDataRootDirectory: nativeRoot,
    rootDirectory: join(root, 'private'),
    sandboxRoot,
    turnOutputDirectory: join(sandboxRoot, 'session'),
  });
  let sequence = 0;
  const send = (operation: string, body: Readonly<Record<string, unknown>>) =>
    harness.handle({
      body,
      harnessInstanceId: 'harness-one',
      operation: operation as never,
      operationId: sha256(`${root}:${sequence}:${operation}`),
      schemaVersion: 2,
      sequence: sequence++,
    });
  const selector = (agentSessionId: string) => ({
    agentSessionId,
    agentSessionRuntimeBindingId: `binding-${agentSessionId}`,
  });
  const open = (
    agentSessionId: string,
    resume: { digest: string; locator: string } | null = null,
    threadId = 'thread-one'
  ) =>
    send('session.open', {
      ...selector(agentSessionId),
      adapterId: 'pi',
      agentSessionCompatibilityKey: DIGEST,
      capabilityLoopbackCredential: credential(`capability-${agentSessionId}`),
      effectiveSetupGeneration: 1,
      inferenceLoopbackCredential: credential(`inference-${agentSessionId}`),
      resume,
      threadId,
      workspaceId: 'workspace-one',
    });
  return { finalStatuses, nativeRoot, open, sandboxRoot, selector, send };
}

describe('Pi Harness integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
  });

  it(
    'runs a real host Turn through the Harness and resumes the same conversation',
    async () => {
      await mkdir(SCRATCH, { recursive: true });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-harness-')));
      roots.push(root);
      mkdirSync(join(root, 'home'), { recursive: true });
      const requests: Array<{ model: string }> = [];
      const proxy = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
          requests.push(body);
          const base = {
            created: 1,
            id: `harness-${requests.length}`,
            model: body.model,
            object: 'chat.completion.chunk',
          };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                { index: 0, delta: { role: 'assistant', content: `answer-${requests.length}` } },
              ],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
            })}\n\n`
          );
          res.end('data: [DONE]\n\n');
        } catch {
          res.writeHead(502).end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(17892, '127.0.0.1', resolve);
      });
      try {
        const harness = harnessFor(root);
        expect((await harness.open('session-a')).disposition).toBe('succeeded');
        const run = async (turnId: string, sequence: number) => {
          const config = join(harness.sandboxRoot, 'sessions', 'session-a', 'config');
          mkdirSync(config, { recursive: true });
          writeFileSync(
            join(config, 'package.json'),
            JSON.stringify({
              capabilities: { mode: 'disabled' },
              control: {
                adapter: { kind: 'openkit-worker-shim', targetRuntime: 'pi' },
                bindings: {
                  capabilities: {
                    pathPrefix: '/capabilities/',
                    tokenRef: 'runtime://openkit/capability-token',
                  },
                  inference: {
                    pathPrefix: '/inference/',
                    tokenRef: 'runtime://openkit/inference-token',
                  },
                  workerControl: {
                    pathPrefix: '/worker-control/',
                    tokenRef: 'runtime://openkit/worker-control-token',
                  },
                },
                mode: 'sandbox-integration',
              },
              credentials: { declarations: [] },
              extensions: { openkit: { turnInput: `input for ${turnId}` } },
              llm: {
                mode: 'gateway',
                preferredLogicalModelId: 'model-a',
                routes: [
                  {
                    credentialVisibility: 'placeholder',
                    endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
                    id: 'worker-inference',
                    model: 'model-a',
                    providerInstanceId: 'provider-a',
                    modelParameters: {
                      contextWindow: 32000,
                      maxOutputTokens: 4000,
                      inputModalities: ['text'],
                      reasoning: false,
                    },
                  },
                ],
              },
              observability: { captureCoverage: { scope: 'server', value: 'off' } },
              runtime: {
                command: { argv: ['openkit-worker-shim'], workingDirectory: harness.sandboxRoot },
              },
              scope: {
                agentSessionId: 'session-a',
                threadId: 'thread-one',
                turnId,
                workspaceId: 'workspace-one',
              },
              snapshotId: `package-${turnId}`,
              supply: { mcpServers: [] },
            })
          );
          return harness.send('turn.start', {
            ...harness.selector('session-a'),
            aepRef: join(config, 'package.json'),
            capabilityToken: credential(`capability-token-${turnId}`),
            contextPackageId: `ctxpkg_${turnId}`,
            contextRef: join(harness.sandboxRoot, 'sessions', 'session-a', 'context'),
            deadline: '2099-01-01T00:00:00.000Z',
            inferenceToken: credential(`inference-token-${turnId}`),
            leaseId: `lease-${turnId}`,
            packageSnapshotId: `package-${turnId}`,
            threadId: 'thread-one',
            turnId,
            turnSequence: sequence,
            workerControlToken: credential(`control-token-${turnId}`),
            workspaceId: 'workspace-one',
          });
        };
        const first = await run('turn-1', 0);
        expect(first, JSON.stringify(first)).toMatchObject({ disposition: 'succeeded' });
        await vi.waitFor(() => expect(harness.finalStatuses).toHaveLength(1), {
          interval: 20,
          timeout: 20_000,
        });
        expect(harness.finalStatuses[0]).toMatchObject({ body: { status: 'completed' } });
        await vi.waitFor(
          async () => {
            const observed = await harness.send('session.inspect', harness.selector('session-a'));
            expect(
              observed,
              `${JSON.stringify(observed)} requests=${requests.length}`
            ).toMatchObject({ body: { nativeHandleState: 'ready', state: 'open' } });
          },
          { interval: 20, timeout: 10_000 }
        );
        const second = await run('turn-2', 1);
        expect(second, JSON.stringify(second)).toMatchObject({ disposition: 'succeeded' });
        await vi.waitFor(() => expect(harness.finalStatuses).toHaveLength(2), {
          interval: 20,
          timeout: 20_000,
        });
        expect(harness.finalStatuses[1]).toMatchObject({ body: { status: 'completed' } });
        await vi.waitFor(() => expect(requests).toHaveLength(2), {
          interval: 20,
          timeout: 10_000,
        });
        await vi.waitFor(
          async () => {
            const observed = await harness.send('session.inspect', harness.selector('session-a'));
            expect(observed.body.state).toBe('open');
          },
          { interval: 20, timeout: 10_000 }
        );
        expect(await harness.send('session.close', harness.selector('session-a'))).toMatchObject({
          disposition: 'succeeded',
        });
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
    TIMEOUT
  );

  it(
    'opens a pending host, drains, and closes without creating a session file',
    async () => {
      await mkdir(SCRATCH, { recursive: true });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-harness-')));
      roots.push(root);
      mkdirSync(join(root, 'home'), { recursive: true });
      const harness = harnessFor(root);
      const opened = await harness.open('session-a');
      expect(opened).toMatchObject({
        body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'open' },
        disposition: 'succeeded',
      });
      const stateRoot = join(harness.nativeRoot, 'pi', 'threads', sha256('thread-one'));
      expect(existsSync(join(stateRoot, 'sessions'))).toBe(false);
      const inspected = await harness.send('session.inspect', harness.selector('session-a'));
      expect(inspected).toMatchObject({
        body: { childState: 'running', nativeHandleState: 'pending', state: 'open' },
        disposition: 'succeeded',
      });
      const planted = join(stateRoot, 'planted.txt');
      writeFileSync(planted, 'keep');
      expect(await harness.send('harness.drain', {})).toMatchObject({
        body: { state: 'draining' },
        disposition: 'succeeded',
      });
      expect(await harness.open('session-b', null, 'thread-two')).toMatchObject({
        body: { reasonCode: 'busy' },
        disposition: 'refused',
      });
      expect(
        await harness.send('turn.start', {
          ...harness.selector('session-a'),
          aepRef: join(harness.sandboxRoot, 'sessions', 'session-a', 'config', 'package.json'),
          capabilityToken: credential('capability-token'),
          contextPackageId: 'ctxpkg_turn-1',
          contextRef: join(harness.sandboxRoot, 'sessions', 'session-a', 'context'),
          deadline: '2099-01-01T00:00:00.000Z',
          inferenceToken: credential('inference-token'),
          leaseId: 'lease-turn-1',
          packageSnapshotId: 'package-turn-1',
          threadId: 'thread-one',
          turnId: 'turn-1',
          turnSequence: 0,
          workerControlToken: credential('control-token'),
          workspaceId: 'workspace-one',
        })
      ).toMatchObject({ body: { reasonCode: 'busy' }, disposition: 'refused' });
      expect(await harness.send('session.close', harness.selector('session-a'))).toMatchObject({
        body: { childState: 'absent', state: 'closed' },
        disposition: 'succeeded',
      });
      expect(readFileSync(planted, 'utf8')).toBe('keep');
    },
    TIMEOUT
  );

  it(
    'resumes a proved header and refuses a different conversation before spawn',
    async () => {
      await mkdir(SCRATCH, { recursive: true });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-harness-')));
      roots.push(root);
      mkdirSync(join(root, 'home'), { recursive: true });
      const marker = join(root, 'spawned');
      const bad = harnessFor(root, [
        process.execPath,
        '--eval',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`,
      ]);
      const stateRoot = join(bad.nativeRoot, 'pi', 'threads', sha256('thread-one'));
      const sessionPath = join(stateRoot, 'sessions', 'binding-proof', 'session.jsonl');
      const work = join(root, 'work');
      await mkdir(dirname(sessionPath), { recursive: true });
      await mkdir(work, { recursive: true });
      const headerId = 'sess-real';
      await mkdir(dirname(sessionPath), { recursive: true });
      writeFileSync(
        sessionPath,
        `${JSON.stringify({ cwd: work, id: 'sess-other', type: 'session' })}\n`
      );
      const handle = JSON.stringify({ cwd: work, path: sessionPath, sessionId: headerId });
      const predecessor = 'session-pred';
      const referencePath = join(bad.nativeRoot, 'agent-session-references', predecessor);
      await mkdir(dirname(referencePath), { recursive: true });
      writeFileSync(referencePath, handle);
      const refused = await bad.open('session-new', {
        digest: sha256(handle),
        locator: predecessor,
      });
      expect(refused).toMatchObject({
        body: { reasonCode: 'dependency_failed' },
        disposition: 'refused',
      });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(bad.nativeRoot, 'agent-session-references', 'session-new'))).toBe(
        false
      );
      expect(readFileSync(referencePath, 'utf8')).toBe(handle);

      writeFileSync(
        sessionPath,
        `${JSON.stringify({ cwd: work, id: headerId, type: 'session' })}\n`
      );
      const good = harnessFor(root);
      const opened = await good.open('session-ok', {
        digest: sha256(handle),
        locator: predecessor,
      });
      expect(opened).toMatchObject({
        body: { nativeHandleDigest: sha256(handle), nativeHandleState: 'ready', state: 'open' },
        disposition: 'succeeded',
      });
      expect(await good.send('session.inspect', good.selector('session-ok'))).toMatchObject({
        body: { nativeHandleDigest: sha256(handle), nativeHandleState: 'ready' },
        disposition: 'succeeded',
      });
      expect(await good.send('session.close', good.selector('session-ok'))).toMatchObject({
        body: { childState: 'absent', state: 'closed' },
        disposition: 'succeeded',
      });
      expect(readFileSync(sessionPath, 'utf8')).toContain(headerId);
    },
    TIMEOUT
  );
});
