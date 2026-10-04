// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { createServer as createH2Server, type ServerHttp2Session } from 'node:http2';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerHarness } from '../harness.js';
import {
  openSandboxIntegration,
  SANDBOX_INTEGRATION_TARGET,
  type SandboxIntegrationClient,
} from '../integration-client.js';
import { startSyntheticCapability } from '../test-support/pi-capability.js';
import { waitForPiHostReadiness } from '../test-support/pi-host-readiness.js';
import {
  type InferenceReply,
  requestTexts,
  startSyntheticInference,
} from '../test-support/pi-inference.js';
import {
  createPiResidentAdapter,
  type PiResidentAdapterOptions,
  type PiResidentBinding,
} from './pi.js';

const children = vi.hoisted(
  () =>
    [] as Array<
      import('node:child_process').ChildProcess & {
        realKill: import('node:child_process').ChildProcess['kill'];
      }
    >
);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args) as (typeof children)[number];
      child.realKill = child.kill.bind(child);
      children.push(child);
      return child;
    },
  };
});
const observations = vi.hoisted(() => ({ getResponses: [] as number[] }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      server.prependListener('request', (request, response) => {
        if (request.method === 'GET')
          response.once('finish', () => observations.getResponses.push(response.statusCode));
      });
      return server;
    },
  };
});
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

function harnessFor(
  root: string,
  integration: SandboxIntegrationClient,
  options: PiResidentAdapterOptions = {}
) {
  const workspaceId = `workspace-${sha256(root)}`;
  const sandboxRoot = join(root, 'openkit');
  const nativeRoot = join(root, 'sandbox', 'native');
  const bindings: PiResidentBinding[] = [];
  mkdirSync(sandboxRoot, { recursive: true });
  mkdirSync(nativeRoot, { recursive: true });
  const harness = new WorkerHarness({
    adapters: {
      pi: {
        async openSession(input) {
          let readiness: Promise<void> | undefined;
          const binding = (await createPiResidentAdapter({
            hostCommand: [process.execPath, '--no-warnings', HOST_BIN],
            ...options,
            observeChannel: (channel) => {
              options.observeChannel?.(channel);
              readiness = waitForPiHostReadiness(channel);
            },
          }).openSession(input)) as PiResidentBinding;
          bindings.push(binding);
          await readiness;
          return binding;
        },
      },
    },
    environment: { HOME: join(root, 'home'), PATH: process.env.PATH ?? '' },
    integration,
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
  ) => {
    const config = join(sandboxRoot, 'sessions', agentSessionId, 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'package.json'),
      JSON.stringify({
        scope: { agentSessionId, threadId, workspaceId: workspaceId },
        workspace: { root: sandboxRoot, inputs: [] },
        extensions: { openkit: { sessionWorkspace: { layout: { slots: [] } } } },
      })
    );
    return send('session.open', {
      ...selector(agentSessionId),
      adapterId: 'pi',
      agentSessionCompatibilityKey: DIGEST,
      capabilityLoopbackCredential: credential(`capability-${agentSessionId}`),
      effectiveSetupGeneration: 1,
      inferenceLoopbackCredential: credential(`inference-${agentSessionId}`),
      resume,
      threadId,
      workspaceId,
    });
  };
  const run = async (
    turnId: string,
    sequence: number,
    agentSessionId = 'session-a',
    servers: string[] = []
  ) => {
    const config = join(sandboxRoot, 'sessions', agentSessionId, 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'package.json'),
      JSON.stringify({
        capabilities: servers.length
          ? {
              mode: 'enabled',
              protocol: 'openkit-worker-capability-v1',
              routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
            }
          : { mode: 'disabled' },
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
          command: { argv: ['openkit-worker-shim'], workingDirectory: sandboxRoot },
        },
        scope: {
          agentSessionId: agentSessionId,
          threadId: 'thread-one',
          turnId,
          workspaceId,
        },
        snapshotId: `package-${turnId}`,
        supply: { mcpServers: servers.map((id) => ({ id })) },
      })
    );
    return send('turn.start', {
      ...selector(agentSessionId),
      aepRef: join(config, 'package.json'),
      capabilityToken: credential(`capability-token-${turnId}`),
      contextPackageId: `ctxpkg_${turnId}`,
      contextRef: join(sandboxRoot, 'sessions', agentSessionId, 'context'),
      deadline: '2099-01-01T00:00:00.000Z',
      inferenceToken: credential(`inference-token-${turnId}`),
      leaseId: `lease-${turnId}`,
      packageSnapshotId: `package-${turnId}`,
      threadId: 'thread-one',
      turnId,
      turnSequence: sequence,
      workerControlToken: credential(`control-token-${turnId}`),
      workspaceId,
    });
  };

  return { bindings, nativeRoot, open, run, sandboxRoot, selector, send };
}

/** Runs the real Integration H2 bridge against synthetic provider/capability endpoints. */
async function fixture(
  reply: (n: number) => InferenceReply,
  options: PiResidentAdapterOptions = {}
) {
  observations.getResponses = [];
  await mkdir(SCRATCH, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-harness-lifecycle-')));
  vi.stubEnv('HOME', join(root, 'image-home'));
  const events: string[] = [];
  const finalStatuses: Array<{ lineage: { turnId: string }; body: { status: string } }> = [];
  const upstream: Array<{ path: string; authorization: string; body: string }> = [];
  const inference = await startSyntheticInference((_req, n) => reply(n));
  const capability = await startSyntheticCapability(credential('synthetic-plane'), [
    'openkit-work',
    'openkit-extra',
  ]);
  capability.bound = true;
  const bridge = createH2Server();
  const h2Sessions = new Set<ServerHttp2Session>();
  bridge.on('session', (session) => {
    h2Sessions.add(session);
    session.on('error', () => undefined);
  });
  bridge.on('stream', (stream, headers) => {
    stream.on('error', () => undefined);
    const path = String(headers[':path']);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      upstream.push({ path, body, authorization: String(headers.authorization) });
      events.push(`request:${path}`);
      if (path.startsWith('/worker-control/')) {
        if (path.endsWith('/final-status')) {
          events.push('final');
          finalStatuses.push(JSON.parse(body));
        }
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }));
        return;
      }
      const target = path.startsWith('/inference/')
        ? new URL(path, inference.url)
        : new URL(path, capability.base);
      const request = requestHttp(
        target,
        {
          method: String(headers[':method']),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${credential('synthetic-plane')}`,
          },
        },
        (response) => {
          if (stream.destroyed) {
            response.destroy();
            return;
          }
          stream.respond({
            ':status': response.statusCode ?? 502,
            'content-type': response.headers['content-type'] ?? 'application/json',
          });
          response.pipe(stream);
        }
      );
      request.on('error', () => stream.destroy());
      stream.on('close', () => request.destroy());
      request.end(body);
    });
  });
  const integration = await openSandboxIntegration();
  const target = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
  const socket = connect(Number(target.port), target.hostname);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  bridge.emit('connection', socket);
  await integration.ready;
  const bind = integration.bindTurnRouteTokens.bind(integration);
  integration.bindTurnRouteTokens = (id, tokens) => {
    events.push(`bind:${id}`);
    bind(id, tokens);
  };
  const drain = integration.drainTurn.bind(integration);
  integration.drainTurn = async (id) => {
    events.push('drain-start');
    const cuts = await drain(id, 50);
    events.push('drain-end');
    return cuts;
  };
  const harness = harnessFor(root, integration, options);
  const close = async () => {
    for (const binding of harness.bindings) await binding.close().catch(() => undefined);
    for (const child of children.splice(0)) {
      child.realKill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await integration.close();
    socket.destroy();
    for (const session of h2Sessions) session.destroy();
    await capability.close();
    await inference.close();
    await rm(root, { force: true, recursive: true });
  };
  return {
    ...harness,
    root,
    events,
    finalStatuses,
    upstream,
    inference,
    capability,
    integration,
    close,
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) await close();
});
async function waitIdle(f: Awaited<ReturnType<typeof fixture>>, id = 'session-a') {
  await vi.waitFor(
    async () => {
      const state = await f.send('session.inspect', f.selector(id));
      expect(['open', 'failed']).toContain(state.body.state);
      expect(state.body.cleanupState).toBe('clean');
    },
    { timeout: 20000, interval: 20 }
  );
}

describe('Pi real Integration lifecycle', () => {
  it(
    'qualifies continuity, exact reference, one process, routing and the drain barrier',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      cleanup.push(f.close);
      expect((await f.open('session-a')).disposition).toBe('succeeded');
      expect(f.capability.log).toHaveLength(0);
      expect((await f.run('turn-1', 0, 'session-a', ['openkit-work'])).disposition).toBe(
        'succeeded'
      );
      await vi.waitFor(() => expect(f.finalStatuses).toHaveLength(1), { timeout: 20000 });
      await waitIdle(f);
      const first = await f.send('session.inspect', f.selector('session-a'));
      const reference = readFileSync(join(f.nativeRoot, 'agent-session-references', 'session-a'));
      expect(sha256(reference)).toBe(first.body.nativeHandleDigest);
      expect(f.finalStatuses.find((status) => status.lineage.turnId === 'turn-1')).toMatchObject({
        body: { status: 'completed' },
      });
      expect((await f.run('turn-2', 1, 'session-a', ['openkit-work'])).disposition).toBe(
        'succeeded'
      );
      await vi.waitFor(() => expect(f.finalStatuses).toHaveLength(2), { timeout: 20000 });
      await waitIdle(f);
      expect(f.finalStatuses.find((status) => status.lineage.turnId === 'turn-2')).toMatchObject({
        body: { status: 'completed' },
      });
      expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain('input for turn-1');
      expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain('answer-1');
      expect(f.bindings).toHaveLength(1);
      expect(children).toHaveLength(1);
      expect(
        readFileSync(join(f.nativeRoot, 'agent-session-references', 'session-a')).equals(reference)
      ).toBe(true);
      expect(
        (await f.send('session.inspect', f.selector('session-a'))).body.nativeHandleDigest
      ).toBe(first.body.nativeHandleDigest);
      expect(f.capability.log.filter((r) => r.method === 'initialize')).toHaveLength(1);
      expect(f.capability.log.filter((r) => r.method === 'tools/list')).toHaveLength(1);
      const requestAt = f.events.findIndex((e) => e.startsWith('request:/inference/'));
      expect(f.events.indexOf('bind:session-a')).toBeLessThan(requestAt);
      expect(f.events.indexOf('drain-end')).toBeLessThan(f.events.indexOf('final'));
      expect(
        f.upstream.filter((r) => r.path.startsWith('/inference/')).map((r) => r.authorization)
      ).toEqual([
        `Bearer ${credential('inference-token-turn-1')}`,
        `Bearer ${credential('inference-token-turn-2')}`,
      ]);
      const idle = await fetch('http://127.0.0.1:17892/inference/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential('inference-session-a')}` },
        body: '{}',
      });
      expect(idle.status).toBe(403);
      const sibling = await fetch('http://127.0.0.1:17892/inference/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${credential('inference-session-b')}` },
        body: '{}',
      });
      expect(sibling.status).toBe(401);
      expect((await f.send('session.close', f.selector('session-a'))).disposition).toBe(
        'succeeded'
      );
      expect(observations.getResponses).toEqual([405]);
      expect(f.capability.log.some((r) => r.httpMethod === 'GET')).toBe(false);
    },
    TIMEOUT
  );

  it.each(
    ['malformed', 'semantic'].flatMap((kind) => [false, true].map((blocked) => ({ kind, blocked })))
  )(
    'unknown $kind settlement blocked=$blocked retains truthful Harness ownership',
    async ({ kind, blocked }) => {
      let channel: Duplex | undefined;
      const f = await fixture(() => ({ hang: true }), {
        observeChannel: (value) => {
          channel = value;
        },
        requestTimeoutMs: 1000,
      });
      cleanup.push(f.close);
      expect((await f.open('session-a')).disposition).toBe('succeeded');
      const started = await f.run('turn-1', 0);
      expect(started, JSON.stringify(started)).toMatchObject({ disposition: 'succeeded' });
      await vi.waitFor(() => expect(f.inference.requests).toHaveLength(1), { timeout: 20000 });
      const child = children.at(-1)!;
      if (blocked) child.kill = () => false;
      child.once('exit', () => f.events.push('exit'));
      const bytes =
        kind === 'malformed'
          ? '{bad json}\n'
          : `${JSON.stringify({
              event: 'turn_settled',
              turnId: 'turn-1',
              outcome: { status: 'future-status' },
              nativeHandle: { state: 'pending' },
              compactionEntryIds: [],
            })}\n`;
      channel!.emit('data', Buffer.from(bytes));
      if (blocked) {
        await vi.waitFor(
          async () =>
            expect((await f.send('session.inspect', f.selector('session-a'))).body).toMatchObject({
              cleanupState: 'unknown',
              childState: 'unknown',
            }),
          { timeout: 3000 }
        );
        expect((await f.send('harness.drain', {})).body).toMatchObject({
          state: 'draining',
          activeTurns: 1,
        });
        expect((await f.open('session-b', null, 'thread-two')).disposition).toBe('refused');
        expect((await f.open('session-c', null, 'thread-one')).disposition).toBe('refused');
        const rival = harnessFor(f.root, f.integration);
        expect(await rival.open('session-rival')).toMatchObject({
          disposition: 'refused',
          body: { reasonCode: 'conflict' },
        });
        expect(rival.bindings).toHaveLength(0);
        await vi.waitFor(() =>
          expect(
            f.finalStatuses.filter((status) => status.lineage.turnId === 'turn-1')
          ).toHaveLength(1)
        );
        expect(
          f.finalStatuses.find((status) => status.lineage.turnId === 'turn-1')!.body.status
        ).toBe('failed');
        const afterFinal = f.upstream.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(f.upstream).toHaveLength(afterFinal);
        expect((await f.run('turn-2', 1)).disposition).toBe('refused');
        expect(f.events).not.toContain('drain-start');
      } else {
        await waitIdle(f);
        expect(f.bindings[0]!.childState()).toBe('absent');
        expect(f.finalStatuses.every((status) => status.body.status !== 'completed')).toBe(true);
        if (f.events.includes('drain-start'))
          expect(f.events.indexOf('exit')).toBeLessThan(f.events.indexOf('drain-start'));
        expect((await f.run('turn-2', 1)).disposition).toBe('refused');
      }
    },
    TIMEOUT
  );

  it.each(
    ['model', 'tool'].flatMap((stage) =>
      ['invalid', 'silent', 'no-terminal'].flatMap((response) =>
        [false, true].map((blocked) => ({ stage, response, blocked }))
      )
    )
  )(
    'bounded $response interrupt during $stage blocked=$blocked completes its failure decision',
    async ({ stage, response, blocked }) => {
      let channel: Duplex | undefined;
      const f = await fixture(
        (n) =>
          n === 1
            ? { text: 'established' }
            : stage === 'model'
              ? { hang: true }
              : { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'held' } } },
        {
          observeChannel: (value) => {
            channel = value;
          },
          requestTimeoutMs: 1000,
        }
      );
      cleanup.push(f.close);
      await f.open('session-a');
      await f.run('turn-1', 0, 'session-a', ['openkit-work']);
      await vi.waitFor(() => expect(f.finalStatuses).toHaveLength(1), { timeout: 20000 });
      await waitIdle(f);
      f.capability.holdToolCall = true;
      await f.run('turn-2', 1, 'session-a', ['openkit-work']);
      await vi.waitFor(
        () =>
          stage === 'model'
            ? expect(f.inference.requests).toHaveLength(2)
            : expect(f.capability.log.some((r) => r.method === 'tools/call')).toBe(true),
        { timeout: 20000 }
      );
      const child = children.at(-1)!;
      if (blocked) child.kill = () => false;
      const write = channel!.write.bind(channel!);
      channel!.write = ((chunk: unknown, ...args: unknown[]) => {
        const request = JSON.parse(String(chunk));
        if (request.op === 'interrupt') {
          if (response !== 'silent')
            setImmediate(() =>
              channel!.emit(
                'data',
                Buffer.from(
                  `${JSON.stringify({
                    id: request.id,
                    ok: true,
                    result: { outcome: response === 'invalid' ? ['interrupted'] : 'interrupted' },
                  })}\n`
                )
              )
            );
          const cb = args.at(-1);
          if (typeof cb === 'function') cb();
          return true;
        }
        return (write as (...args: unknown[]) => boolean)(chunk, ...args);
      }) as Duplex['write'];
      const result = await f.send('turn.interrupt', {
        ...f.selector('session-a'),
        turnId: 'turn-2',
        leaseId: 'lease-turn-2',
        purpose: 'interrupt',
      });
      if (blocked) {
        expect(result).toMatchObject({
          disposition: 'refused',
          body: { reasonCode: 'cleanup_required' },
        });
        expect((await f.send('session.inspect', f.selector('session-a'))).body.cleanupState).toBe(
          'unknown'
        );
      } else {
        await waitIdle(f);
        expect(f.bindings[0]!.childState()).toBe('absent');
        expect(
          f.finalStatuses
            .filter((status) => status.lineage.turnId === 'turn-2')
            .every((status) => status.body.status !== 'completed')
        ).toBe(true);
      }
    },
    TIMEOUT
  );

  it.each([false, true])(
    'replaces changed MCP supply through an exact successor, rejected start=%s',
    async (rejectedStart) => {
      let channel: Duplex | undefined;
      const f = await fixture((n) => ({ text: `answer-${n}` }), {
        observeChannel: (value) => {
          channel = value;
        },
      });
      cleanup.push(f.close);
      await f.open('session-a');
      await f.run('turn-1', 0, 'session-a', ['openkit-work']);
      await vi.waitFor(() => expect(f.finalStatuses).toHaveLength(1), { timeout: 20000 });
      await waitIdle(f);
      const handle = await f.send('session.inspect', f.selector('session-a'));
      const reference = readFileSync(join(f.nativeRoot, 'agent-session-references', 'session-a'));
      if (rejectedStart) {
        const write = vi.spyOn(channel!, 'write');
        expect(await f.run('turn-refused', 1, 'session-a', ['openkit-extra'])).toMatchObject({
          disposition: 'refused',
          body: {
            reasonCode: 'dependency_failed',
            startupFailure: { stage: 'native_spawn', reason: 'failed' },
          },
        });
        expect(write).not.toHaveBeenCalled();
        write.mockRestore();
      }
      expect(f.inference.requests).toHaveLength(1);
      await waitIdle(f);
      expect((await f.send('session.inspect', f.selector('session-a'))).body).toMatchObject({
        state: 'open',
        cleanupState: 'clean',
      });
      expect((await f.send('session.close', f.selector('session-a'))).disposition).toBe(
        'succeeded'
      );
      expect(f.bindings[0]!.childState()).toBe('absent');
      const count = f.capability.log.length;
      expect(
        (
          await f.open('session-b', {
            locator: 'session-a',
            digest: String(handle.body.nativeHandleDigest),
          })
        ).disposition
      ).toBe('succeeded');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.capability.log).toHaveLength(count);
      expect((await f.run('turn-2', 0, 'session-b', ['openkit-extra'])).disposition).toBe(
        'succeeded'
      );
      await vi.waitFor(
        () =>
          expect(
            f.finalStatuses.find((status) => status.lineage.turnId === 'turn-2')
          ).toMatchObject({ body: { status: 'completed' } }),
        { timeout: 20000 }
      );
      await waitIdle(f, 'session-b');
      expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain('answer-1');
      expect(f.inference.requests[1]!.body.tools?.map((t) => t.function.name)).toContain(
        'mcp__openkit_extra__echo'
      );
      expect(f.inference.requests[1]!.body.tools?.map((t) => t.function.name)).not.toContain(
        'mcp__openkit_work__echo'
      );
      expect(f.capability.log.filter((r) => r.method === 'initialize')).toHaveLength(2);
      expect(
        readFileSync(join(f.nativeRoot, 'agent-session-references', 'session-b')).equals(reference)
      ).toBe(true);
      expect(f.upstream.filter((r) => r.path.startsWith('/inference/')).at(-1)?.authorization).toBe(
        `Bearer ${credential('inference-token-turn-2')}`
      );
      expect((await f.send('session.close', f.selector('session-b'))).disposition).toBe(
        'succeeded'
      );
    },
    TIMEOUT
  );

  it.each(['model', 'tool'])(
    'closes active real %s work, preserving bytes and ending effects',
    async (kind) => {
      const f = await fixture((n) =>
        n === 1
          ? { text: 'established' }
          : kind === 'model'
            ? { hang: true }
            : { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'held' } } }
      );
      cleanup.push(f.close);
      await f.open('session-a');
      await f.run('turn-1', 0, 'session-a', ['openkit-work']);
      await vi.waitFor(() => expect(f.finalStatuses).toHaveLength(1), { timeout: 20000 });
      await waitIdle(f);
      const reference = JSON.parse(
        readFileSync(join(f.nativeRoot, 'agent-session-references', 'session-a'), 'utf8')
      ) as { path: string };
      const retained = readFileSync(reference.path);
      f.capability.holdToolCall = true;
      await f.run('turn-2', 1, 'session-a', ['openkit-work']);
      await vi.waitFor(
        () =>
          kind === 'model'
            ? expect(f.inference.requests).toHaveLength(2)
            : expect(f.capability.log.some((r) => r.method === 'tools/call')).toBe(true),
        { timeout: 20000 }
      );
      // The shared close operation refuses an active Turn. The resident close owns native drain;
      // close it through the held binding, then ask Harness to release the binding.
      expect((await f.send('session.close', f.selector('session-a'))).body.reasonCode).toBe('busy');
      const close = f.bindings[0]!.close();
      expect(f.bindings[0]!.close()).toBe(close);
      await close;
      expect(f.bindings[0]!.childState()).toBe('absent');
      await waitIdle(f);
      expect(readFileSync(reference.path).subarray(0, retained.length).equals(retained)).toBe(true);
      const requests = f.inference.requests.length,
        calls = f.capability.log.filter((r) => r.method === 'tools/call').length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(f.inference.requests).toHaveLength(requests);
      expect(f.capability.log.filter((r) => r.method === 'tools/call')).toHaveLength(calls);
    },
    TIMEOUT
  );
});
