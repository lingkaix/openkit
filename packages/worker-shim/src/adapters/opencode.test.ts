// openkit-test-platform: posix

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReasoningEffort } from '@openkit/protocol';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkerAdapterLlmRoute,
  WorkerAdapterResult,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import { WORKER_ADAPTERS } from '../adapter-registry.js';
import { WorkerHarness } from '../harness.js';
import type { SandboxIntegrationClient } from '../integration-client.js';
import {
  type SyntheticCapability,
  startSyntheticCapability,
} from '../test-support/synthetic-capability.js';
import {
  type CapturedInference,
  requestTexts,
  type SyntheticInference,
  startSyntheticInference,
} from '../test-support/synthetic-inference.js';
import { TurnTimeline } from '../turn-timeline.js';
import {
  boundOpenCodeDiagnostic,
  createOpenCodeAdapter,
  OPENCODE_LISTS_TOOLS_AT_TURN_START,
  OPENCODE_PERMISSION_REPLY,
  OPENCODE_PROVIDER_ID,
  opencodeAdapter,
  resolveOpenCodeBinary,
  surfaceUnprovedOpenCodeTurn,
} from './opencode.js';
import { OPENCODE_PLUGIN_SOURCE } from './opencode-plugin.js';

const RESULT_LIMIT = 16 * 1024 * 1024;
const sessions: WorkerResidentSession[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const roots: string[] = [];

beforeEach(() => {
  // Image-default qualification owns its own fixtures; ordinary adapter cases use an empty image.
  const image = mkdtempSync(join(tmpdir(), 'openkit-opencode-image-'));
  roots.push(image);
  vi.stubEnv('HOME', image);
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

describe('OpenCode resident adapter', () => {
  /** Uses the existing SDK-shaped double and child peer to observe retained conversation collection. */
  function timelineFixture(second: 'new' | 'empty' | 'failed') {
    const layout = makeRoots();
    const creds = loopback('timeline-history', 'http://127.0.0.1:9');
    const child = stubbornChild([]);
    child.kill = () => {
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    };
    const module = failingModule('prompt');
    const client = module.OpenCode.make({ baseUrl: 'http://127.0.0.1:9' });
    let turn = 0;
    let history: object[] = [];
    client.session.prompt = async () => {
      turn += 1;
      if (turn === 1 || second === 'new')
        history = [
          ...history,
          { id: `user-${turn}`, type: 'user' },
          {
            id: `answer-${turn}`,
            type: 'assistant',
            finish: turn === 1 ? 'stop' : 'error',
            content: [{ type: 'text', text: 'answer' }],
          },
          { id: `idle-${turn}`, type: 'idle', outcome: turn === 1 ? 'succeeded' : 'failed' },
        ];
      if (turn === 1 && second === 'failed')
        history = [
          { id: 'user-1', type: 'user' },
          { id: 'idle-1', type: 'idle', outcome: 'failed' },
        ];
      return { id: `user-${turn}` };
    };
    client.session.get = async () => ({
      id: 'sess-1',
      model: { id: 'prompt-model', providerID: OPENCODE_PROVIDER_ID },
      time: { idle: Number.MAX_SAFE_INTEGER },
      outcome: turn === 1 && second !== 'failed' ? 'succeeded' : 'failed',
    });
    client.message.list = async () => ({ cursor: {}, data: history }) as never;
    module.OpenCode.make = () => client;
    const adapter = createOpenCodeAdapter({
      loadClient: async () => module,
      resolveBinary: () => '/unused',
      spawnServer: () => child,
    });
    return { adapter, child, layout, creds };
  }

  it.each([
    'new',
    'empty',
  ] as const)('counts only this Turn native messages with retained history and %s collection', async (second) => {
    const f = timelineFixture(second);
    const session = await f.adapter.openSession(openInput(f.layout, f.creds));
    sessions.push(session);
    const first = new TurnTimeline();
    expect(
      (
        await (
          await session.startTurn({
            ...turnInput(f.layout, f.creds, 'first', 'prompt-model'),
            recordLifecycleFact: first.record,
          })
        ).settled
      ).status
    ).toBe('completed');
    const later = new TurnTimeline();
    expect(
      (
        await (
          await session.startTurn({
            ...turnInput(f.layout, f.creds, 'second', 'prompt-model'),
            recordLifecycleFact: later.record,
          })
        ).settled
      ).status
    ).toBe('failed');
    const snapshot = JSON.parse(later.seal());
    const events = snapshot.entries.filter(
      (entry: { label: string }) => entry.label === 'native_first' || entry.label === 'native_last'
    );
    if (second === 'new')
      expect(events).toEqual([
        expect.objectContaining({ label: 'native_first' }),
        expect.objectContaining({ label: 'native_last', count: 3 }),
      ]);
    else expect(events).toEqual([]);
  });

  it.each([
    'completed',
    'failed',
  ] as const)('contains native exit recorder faults after a %s Turn', async (status) => {
    const f = timelineFixture(status === 'failed' ? 'failed' : 'new');
    const session = await f.adapter.openSession(openInput(f.layout, f.creds));
    sessions.push(session);
    const recordLifecycleFact = vi.fn((fact: { label: string }) => {
      if (fact.label === 'host_exit') throw new Error('exit recorder fault');
    });
    const turn = await session.startTurn({
      ...turnInput(f.layout, f.creds, 'first', 'prompt-model'),
      recordLifecycleFact,
    });
    expect((await turn.settled).status).toBe(status);
    Object.assign(f.child, { exitCode: 17 });
    expect(() => f.child.emit('exit', 17, null)).not.toThrow();
    expect(session.childState()).toBe('absent');
    await session.exited;
    expect(recordLifecycleFact).toHaveBeenCalledWith({
      label: 'host_exit',
      code: 17,
      signal: null,
    });
  });

  it('bounds diagnostics to 16 KiB and redacts both loopback credentials', () => {
    const secret = 'c'.repeat(43);
    const diagnostic = boundOpenCodeDiagnostic(`${secret}${'x'.repeat(20_000)}`, [secret]);
    expect(diagnostic.startsWith('[redacted]')).toBe(true);
    expect(diagnostic.includes(secret)).toBe(false);
    expect(diagnostic.length).toBe(16 * 1024);
  });

  it.each([
    'UND_ERR_SOCKET',
    'ECONNREFUSED',
  ])('preserves transport cause code %s without credentials or secret URLs', async (code) => {
    const { ClientError } = await import('@opencode/client');
    const creds = loopback('transport-cause', 'http://127.0.0.1:9');
    const root = Object.assign(
      new Error(
        `other side closed ${creds.capabilityCredential} https://user:password@example.test/private?token=unknown-secret#fragment`
      ),
      { code }
    );
    // A cyclic vendor cause must not hang error reporting or duplicate socket metadata.
    root.cause = root;
    const transport = new ClientError('Transport', {
      cause: new TypeError('fetch failed', { cause: root }),
    });
    const module = failingModule('create');
    const client = module.OpenCode.make({ baseUrl: 'http://127.0.0.1:9' });
    client.session.create = async () => {
      throw transport;
    };
    module.OpenCode.make = () => client;
    const child = stubbornChild([]);
    child.kill = () => {
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    const adapter = createOpenCodeAdapter({
      loadClient: async () => module,
      resolveBinary: () => '/unused',
      spawnServer: () => child,
    });
    const failure = await adapter
      .openSession(openInput(makeRoots(), creds))
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) return;
    expect(failure.message).toContain('Transport: fetch failed');
    expect(failure.message).toContain(`${code}: other side closed`);
    expect(failure.message.match(new RegExp(code, 'g'))).toHaveLength(1);
    for (const secret of [creds.capabilityCredential, 'password', 'unknown-secret', 'fragment']) {
      expect(failure.message).not.toContain(secret);
    }
    expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(16 * 1024);
    const bounded = boundOpenCodeDiagnostic(`${failure.message}${'é'.repeat(20_000)}`, []);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(16 * 1024);
    expect(bounded).toContain(`${code}: other side closed`);
    expect(bounded).not.toContain('\uFFFD');
  });

  it('registers the production adapter and resolves only the pinned CLI', () => {
    expect(WORKER_ADAPTERS.opencode).toBe(opencodeAdapter);
    expect(OPENCODE_PROVIDER_ID).toBe('openkit-worker-inference');
    expect(OPENCODE_PROVIDER_ID.includes('/')).toBe(false);
    expect(OPENCODE_LISTS_TOOLS_AT_TURN_START).toBe(false);
    expect(OPENCODE_PERMISSION_REPLY).toBe('once');
    const decoy = mkdtempSync(join(tmpdir(), 'openkit-opencode-decoy-'));
    roots.push(decoy);
    const decoyBin = join(decoy, 'opencode');
    writeFileSync(decoyBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const previousPath = process.env.PATH;
    const previousOverride = process.env.OPENCODE_BIN;
    process.env.PATH = `${decoy}${previousPath ? `:${previousPath}` : ''}`;
    process.env.OPENCODE_BIN = decoyBin;
    try {
      const binary = resolveOpenCodeBinary();
      expect(binary).not.toBe(decoyBin);
      expect(binary.includes(`${join('@opencode', 'cli')}`)).toBe(true);
      expect(binary.endsWith(join('bin', 'opencode.exe'))).toBe(true);
      expect(existsSync(binary)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previousOverride;
    }
  });

  it('records supporting literal-string evidence; image smoke still owns /etc/opencode absence', () => {
    expect(readFileSync(resolveOpenCodeBinary()).includes(Buffer.from('/etc/opencode'))).toBe(
      false
    );
  });

  it('fails open closed when the client or the binary cannot be loaded', async () => {
    let loaded = false;
    const missingBinary = createOpenCodeAdapter({
      loadClient: async () => {
        loaded = true;
        throw new Error('client should not load');
      },
      resolveBinary: () => {
        throw new Error('pinned CLI missing');
      },
    });
    const input = openInput(makeRoots(), loopback('missing-binary', 'http://127.0.0.1:9'));
    await expect(missingBinary.openSession(input)).rejects.toThrow(/pinned CLI missing/);
    expect(loaded).toBe(false);

    const missingClient = createOpenCodeAdapter({
      loadClient: async () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    await expect(missingClient.openSession(input)).rejects.toThrow(
      /@opencode\/client@2\.0\.22[\s\S]*worker-runtimes/
    );
  });

  it('rejects an unproved stop within its bound so the Harness can fence it', async () => {
    const surfaced = surfaceUnprovedOpenCodeTurn(new Error('still live'), async () => false);
    await expect(surfaced.settled).rejects.toThrow('still live');
    await expect(surfaced.interrupt()).rejects.toThrow(/stop was not proved/);
  });

  it('resolves interrupt after an unproved stop is confirmed', async () => {
    const surfaced = surfaceUnprovedOpenCodeTurn(new Error('stopped later'), async () => true);
    await expect(surfaced.interrupt()).resolves.toBeUndefined();
  });

  it('rejects a spawn that never created a process', async () => {
    const layout = makeRoots();
    const adapter = createOpenCodeAdapter({
      resolveBinary: () => join(layout.root, 'missing-opencode'),
    });
    await expect(
      adapter.openSession(openInput(layout, loopback('enoent', 'http://127.0.0.1:9')))
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects open only after a process that exits before listen is gone', async () => {
    const layout = makeRoots();
    const pidFile = join(layout.root, 'host.pid');
    const binary = join(layout.root, 'exit-before-listen');
    writeFileSync(binary, `#!/bin/sh\necho $$ > '${pidFile}'\nexit 1\n`, { mode: 0o755 });
    const adapter = createOpenCodeAdapter({ resolveBinary: () => binary });
    await expect(
      adapter.openSession(openInput(layout, loopback('early-exit', 'http://127.0.0.1:9')))
    ).rejects.toThrow(/exited before it listened/);
    expect(processAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  });

  it('does not reject open while a process that ignores stop is still live', async () => {
    const signals: string[] = [];
    const adapter = createOpenCodeAdapter({
      loadClient: async () => failingModule('create'),
      resolveBinary: () => '/unused/opencode',
      spawnServer: () => stubbornChild(signals),
      stopTimeoutMs: 15,
    });
    const session = await adapter.openSession(
      openInput(makeRoots(), loopback('unproved-open', 'http://127.0.0.1:9'))
    );
    sessions.push(session);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(session.childState()).toBe('unknown');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    await expect(session.close()).rejects.toThrow(/exit was not confirmed/);
    expect(session.childState()).toBe('unknown');
  });

  it('does not reject a prompted Turn while the server ignores stop', async () => {
    const adapter = createOpenCodeAdapter({
      loadClient: async () => failingModule('prompt'),
      resolveBinary: () => '/unused/opencode',
      spawnServer: () => stubbornChild([]),
      stopTimeoutMs: 15,
    });
    const layout = makeRoots();
    const creds = loopback('unproved-turn', 'http://127.0.0.1:9');
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'prompt-user', 'prompt-model'));
    await expect(turn.settled).rejects.toThrow(/prompt acceptance is unknown/);
    expect(session.childState()).toBe('unknown');
    await expect(turn.interrupt()).rejects.toThrow(/stop was not proved/);
  });

  it('stops the real server before rejecting an open that failed after spawn', async () => {
    const layout = makeRoots();
    const launched = launchWrapper(layout);
    const adapter = createOpenCodeAdapter({
      loadClient: () => realModuleRejecting('create'),
      resolveBinary: () => launched.binary,
    });
    await expect(
      adapter.openSession(openInput(layout, loopback('live-open', 'http://127.0.0.1:9')))
    ).rejects.toThrow(/create acceptance is unknown/);
    expect(processAlive(Number(readFileSync(launched.pidFile, 'utf8')))).toBe(false);
  }, 120_000);

  it('stops the real server before rejecting a Turn whose prompt may have been accepted', async () => {
    const layout = makeRoots();
    const launched = launchWrapper(layout);
    const creds = loopback('live-prompt', 'http://127.0.0.1:9');
    const adapter = createOpenCodeAdapter({
      loadClient: () => realModuleRejecting('prompt'),
      resolveBinary: () => launched.binary,
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const pid = Number(readFileSync(launched.pidFile, 'utf8'));
    expect(processAlive(pid)).toBe(true);
    const attempt = await session.startTurn(
      turnInput(layout, creds, 'prompt-user', 'prompt-model')
    );
    const failed = await attempt.settled;
    expect(failed.status).toBe('failed');
    expect(failed.diagnostics?.native).toMatch(/prompt acceptance is unknown/);
    expect(session.childState()).toBe('absent');
    await session.exited;
    expect(processAlive(pid)).toBe(false);
  }, 120_000);

  it('stops a live server when session inspection loses terminal evidence', async () => {
    const layout = makeRoots();
    const launched = launchWrapper(layout);
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const creds = loopback('lost-wait', inference.url);
    const adapter = createOpenCodeAdapter({
      loadClient: () => realModuleRejecting('get'),
      resolveBinary: () => launched.binary,
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const pid = Number(readFileSync(launched.pidFile, 'utf8'));
    const turn = await session.startTurn(turnInput(layout, creds, 'alpha-user', 'exact-model'));
    const result = await turn.settled;
    expect(result.status).toBe('failed');
    expect(processAlive(pid)).toBe(false);
    expect(session.childState()).toBe('absent');
  }, 120_000);

  it('bounds a hung resume inspection and proves server exit before refusal', async () => {
    const layout = makeRoots();
    const launched = launchWrapper(layout);
    const adapter = createOpenCodeAdapter({
      loadClient: () => realModuleRejecting('get-hang'),
      resolveBinary: () => launched.binary,
      rpcTimeoutMs: 30,
    });
    await expect(
      adapter.openSession(
        openInput(layout, loopback('hung-resume', 'http://127.0.0.1:9'), Buffer.from('v1:some-id'))
      )
    ).rejects.toThrow(/timed out|did not prove/);
    expect(processAlive(Number(readFileSync(launched.pidFile, 'utf8')))).toBe(false);
  }, 120_000);

  it('poisons duplicated terminal evidence and stops the real server', async () => {
    const layout = makeRoots();
    const launched = launchWrapper(layout);
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const creds = loopback('duplicate-terminal', inference.url);
    const adapter = createOpenCodeAdapter({
      loadClient: () => realModuleRejecting('duplicate-terminal'),
      resolveBinary: () => launched.binary,
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'alpha-user', 'exact-model'));
    const result = await turn.settled;
    expect(result.status).toBe('failed');
    expect(processAlive(Number(readFileSync(launched.pidFile, 'utf8')))).toBe(false);
  }, 120_000);

  it('bounds post-close stream drain and shares its rejected close promise', async () => {
    const child = stubbornChild([]);
    child.kill = () => {
      child.emit('exit', null, 'SIGTERM');
      return true;
    };
    const adapter = createOpenCodeAdapter({
      loadClient: async () => absentRowModule(),
      resolveBinary: () => '/unused/opencode',
      spawnServer: () => child,
    });
    const session = await adapter.openSession(
      openInput(makeRoots(), loopback('close-stream', 'http://127.0.0.1:9'))
    );
    sessions.push(session);
    const first = session.close();
    expect(session.close()).toBe(first);
    await expect(first).rejects.toThrow(/post-close/);
    await session.exited;
    expect(session.childState()).toBe('absent');
  });

  it('refuses a connected MCP supply when its native registry reload proof is lost', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference((request) => scripted(request));
    const capability = await startSyntheticCapability();
    servers.push(inference, capability);
    const creds = loopback('lost-registry', inference.url, capability.url);
    // Use the owner's eight-second RPC bound so catalog reload and move precede registry proof.
    const adapter = createOpenCodeAdapter({
      spawnServer(binary, args, options) {
        const pluginPath = join(layout.controlRoot, 'plugin', 'index.js');
        const plugin = readFileSync(pluginPath, 'utf8');
        // Preserve initialization proof but lose subsequent native reload notifications.
        writeFileSync(
          pluginPath,
          plugin.replace(
            "writeFileSync(join(root, 'tools-' + key),",
            "try { readFileSync(join(root, 'tools-' + key)); return; } catch {} writeFileSync(join(root, 'tools-' + key),"
          )
        );
        return spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      },
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    await expect(
      session.startTurn(
        turnInput(layout, creds, 'mcp-alpha-user', 'model', acceptedRoute(creds, 'model'), [
          'alpha',
        ])
      )
    ).rejects.toThrow(/tool registry did not reload/);
    expect(authenticated(capability, 'alpha', creds.capabilityCredential)).toBe(true);
    expect(inference.requests).toHaveLength(0);
    expect(session.childState()).toBe('absent');
  }, 120_000);

  it('poisons distinct-id contradictory assistant finals correlated to the Turn', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const creds = loopback('distinct-finals', inference.url);
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          messages: (response) => {
            const terminal = response.data.find(
              (row) => row.type === 'assistant' && row.finish === 'stop'
            );
            return terminal
              ? {
                  ...response,
                  data: [
                    ...response.data,
                    {
                      ...terminal,
                      id: 'msg_conflicting-final',
                      content: [{ type: 'text', text: 'contradiction' }],
                    },
                  ],
                }
              : response;
          },
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const result = await (await session.startTurn(turnInput(layout, creds, 'alpha-user', 'model')))
      .settled;
    expect(result.status).toBe('failed');
    expect(result.assistantText).toBeNull();
    expect(session.childState()).toBe('absent');
  }, 120_000);

  for (const [label, change] of [
    ['unknown outcome', { outcome: 'new-native-status' }],
    ['null time', { time: null }],
    ['missing time', { time: undefined }],
    ['NaN idle', { time: { idle: Number.NaN } }],
    ['infinite idle', { time: { idle: Number.POSITIVE_INFINITY } }],
    ['negative idle', { time: { idle: -1 } }],
    ['string idle', { time: { idle: 'idle' } }],
    ['wrong identity', { id: 'ses_wrong' }],
  ] as const) {
    it(`fails closed on inspection and settlement with ${label}`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference((request) => scripted(request));
      servers.push(inference);
      const creds = loopback(label, inference.url);
      let corrupt = false;
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            sessionGet: (info) => (corrupt ? { ...info, ...change } : info),
            prompt: (info) => {
              corrupt = true;
              return info;
            },
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      expect((await session.nativeHandle()).state).toBe('ready');
      corrupt = true;
      expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
      corrupt = false;
      const result = await (
        await session.startTurn(turnInput(layout, creds, 'alpha-user', 'model'))
      ).settled;
      expect(result.status).toBe('failed');
      expect(session.childState()).toBe('absent');
    }, 120_000);
  }

  for (const nativeStatus of ['future-status', undefined, null, { status: 'connected' }, 7]) {
    it(`refuses malformed MCP status ${JSON.stringify(nativeStatus)} before a prompt`, async () => {
      const layout = makeRoots();
      const creds = loopback('mcp-status', 'http://127.0.0.1:9');
      const calls: string[] = [];
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            calls,
            mcpList: (response) => ({
              ...response,
              data: [{ name: 'alpha', status: { status: nativeStatus } }],
            }),
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const failure = await session
        .startTurn(turnInput(layout, creds, 'alpha-user', 'model'))
        .catch((error: Error) => error);
      expect(calls).not.toContain('mcp.remove');
      expect(calls).not.toContain('session.prompt');
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/MCP.*status/);
      expect(session.childState()).toBe('absent');
    }, 120_000);
  }

  for (const label of [
    'unknown message type',
    'missing admitted prompt',
    'assistant error on success',
    'unknown idle outcome',
  ]) {
    it(`fails settlement closed with ${label}`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference((request) => scripted(request));
      servers.push(inference);
      const creds = loopback(label, inference.url);
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            messages: (response) => ({
              ...response,
              data: response.data.flatMap((row) => {
                if (label === 'missing admitted prompt' && row.type === 'user') return [];
                if (label === 'unknown message type' && row.type === 'assistant')
                  return [{ ...row, type: 'future' }];
                if (label === 'assistant error on success' && row.type === 'assistant')
                  return [
                    {
                      ...row,
                      error: { type: 'ProviderError', message: creds.capabilityCredential },
                    },
                  ];
                if (
                  label === 'unknown idle outcome' &&
                  row.type === 'idle' &&
                  response.data.some((entry) => entry.type === 'assistant')
                )
                  return [{ ...row, outcome: 'future' }];
                return [row];
              }),
            }),
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const result = await (
        await session.startTurn(turnInput(layout, creds, 'alpha-user', 'model'))
      ).settled;
      expect(result.status).toBe('failed');
      expect(session.childState()).toBe('absent');
      expect(JSON.stringify(result)).not.toContain(creds.capabilityCredential);
    }, 120_000);
  }

  it('stops before refusing a prompt admission whose native identity is missing', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const creds = loopback('prompt-id', inference.url);
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          prompt: (info) => ({ ...info, id: undefined }),
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const attempt = await session.startTurn(turnInput(layout, creds, 'alpha-user', 'model'));
    const failed = await attempt.settled;
    expect(failed.status).toBe('failed');
    expect(failed.diagnostics?.native).toMatch(/admission.*identity/);
    expect(session.childState()).toBe('absent');
  }, 120_000);

  it('never reports ready when the real server exits during inspection', async () => {
    const layout = makeRoots();
    const creds = loopback('inspection-exit', 'http://127.0.0.1:9');
    let child: ChildProcess | undefined;
    let killDuringInspection = false;
    const adapter = createOpenCodeAdapter({
      spawnServer(binary, args, options) {
        child = spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        return child;
      },
      loadClient: () =>
        transformingModule({
          sessionGet: async (info) => {
            if (killDuringInspection && child) {
              const exit = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
              child.kill('SIGKILL');
              await exit;
            }
            return info;
          },
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    expect((await session.nativeHandle()).state).toBe('ready');
    killDuringInspection = true;
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    expect(session.childState()).toBe('absent');
  }, 120_000);

  it('ignores unknown additive inspection and message members', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const creds = loopback('additive', inference.url);
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          sessionGet: (info) => ({ ...info, extension: { outcome: 'future' } }),
          messages: (response) => ({
            ...response,
            extension: 'future',
            data: response.data.map((row) => ({ ...row, extension: 'future' })),
          }),
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    expect((await session.nativeHandle()).state).toBe('ready');
    await complete(session, turnInput(layout, creds, 'alpha-user', 'model'));
  }, 120_000);

  it('redacts and byte-bounds native loader failures and unproved settlement errors', async () => {
    const layout = makeRoots();
    const creds = loopback('native-errors', 'http://127.0.0.1:9');
    const detail = creds.capabilityCredential + 'é'.repeat(20_000);
    const adapter = createOpenCodeAdapter({
      loadClient: async () => {
        throw new Error(detail);
      },
    });
    const error = await adapter
      .openSession(openInput(layout, creds))
      .catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).not.toContain(creds.capabilityCredential);
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(16 * 1024);
    const missingBinary = createOpenCodeAdapter({
      resolveBinary: () => {
        throw new Error(detail);
      },
    });
    const binaryError = await missingBinary
      .openSession(openInput(layout, creds))
      .catch((cause: Error) => cause);
    expect(binaryError).toBeInstanceOf(Error);
    if (!(binaryError instanceof Error)) return;
    expect(binaryError.message).not.toContain(creds.capabilityCredential);
    expect(Buffer.byteLength(binaryError.message)).toBeLessThanOrEqual(16 * 1024);
    const fake = failingModule('create');
    const sessionId = 'sess-1';
    const native = fake.OpenCode.make({ baseUrl: 'http://127.0.0.1:9' });
    native.model.list = async () =>
      ({ data: [{ id: 'model', providerID: OPENCODE_PROVIDER_ID, enabled: true }] }) as never;
    native.session.create = async () => ({ id: sessionId }) as never;
    native.session.prompt = async () => ({ id: 'user-1' }) as never;
    native.session.get = async () => {
      throw new Error(detail);
    };
    const stubborn = createOpenCodeAdapter({
      loadClient: async () => fake,
      resolveBinary: () => '/unused',
      spawnServer: () => stubbornChild([]),
      // This peer ignores both signals; the short window exercises unproved settlement.
      stopTimeoutMs: 10,
    });
    // Reuse the same admitted stand-in client for the settlement-error boundary.
    fake.OpenCode.make = () => native;
    const session = await stubborn.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'alpha-user', 'model'));
    const failure = await turn.settled.catch((cause: Error) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) return;
    expect(failure.message).not.toContain(creds.capabilityCredential);
    expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(16 * 1024);
  });

  it('decodes every stdout split of a multibyte character before diagnostics', async () => {
    const bytes = Buffer.from('é', 'utf8');
    for (let split = 1; split < bytes.length; split += 1) {
      const child = stubbornChild([]);
      child.kill = () => {
        child.emit('exit', null, 'SIGTERM');
        return true;
      };
      const adapter = createOpenCodeAdapter({
        loadClient: async () => failingModule('create'),
        resolveBinary: () => '/unused/opencode',
        spawnServer: () => {
          setTimeout(() => {
            child.stdout?.emit('data', bytes.subarray(0, split));
            child.stdout?.emit('data', bytes.subarray(split));
          }, 0);
          return child;
        },
      });
      await expect(
        adapter.openSession(openInput(makeRoots(), loopback('utf8', 'http://127.0.0.1:9')))
      ).rejects.toThrow('é');
    }
  });

  it('rejects equal loopback credentials before starting a server', async () => {
    const rootsForOpen = makeRoots();
    const shared = credential('same');
    await expect(
      opencodeAdapter.openSession(
        openInput(rootsForOpen, {
          capabilityBaseUrl: 'http://127.0.0.1:9',
          capabilityCredential: shared,
          inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
          inferenceCredential: shared,
        })
      )
    ).rejects.toThrow(/two distinct loopback credentials/);
  });

  it('admits one conversation, rejects a direct route, and preserves the home at close', async () => {
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const layout = plantAmbient(makeRoots());
    const creds = loopback('admit', inference.url);
    const session = await opencodeAdapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const opened = await session.nativeHandle();
    expect(opened.state).toBe('ready');
    if (opened.state !== 'ready') return;
    const reference = Buffer.from(opened.reference);
    expect(reference.toString('utf8').startsWith('v1:')).toBe(true);

    const before = inference.requests.length;
    await expect(
      session.startTurn(turnInput(layout, creds, 'direct-user', 'direct-model', directRoute()))
    ).rejects.toThrow(/rejected the selected route/);
    await expect(
      session.startTurn(
        turnInput(layout, creds, 'env-user', 'env-model', {
          ...acceptedRoute(creds, 'env-model'),
          credentialVisibility: 'environment',
        })
      )
    ).rejects.toThrow(/rejected the selected route/);
    await expect(
      session.startTurn(turnInput(layout, creds, creds.inferenceCredential, 'secret-model'))
    ).rejects.toThrow(/loopback credential/);
    expect(inference.requests.length).toBe(before);
    expect(session.childState()).toBe('running');

    const alpha = await complete(
      session,
      turnInput(layout, creds, 'alpha-user', 'org/exact-model-a')
    );
    expect(alpha.assistantText).toBe('alpha-answer');
    const alphaRequest = primary(inference, 'alpha-user');
    expect(alphaRequest.body.model).toBe('org/exact-model-a');
    expect(alphaRequest.headers.authorization).toBe(`Bearer ${creds.inferenceCredential}`);
    expect(alphaRequest.path.includes('chat/completions')).toBe(true);
    expect(JSON.stringify(alphaRequest.body).includes('openkitUnknown')).toBe(false);

    const beta = await complete(
      session,
      turnInput(layout, creds, 'beta-user', 'org/exact-model-b')
    );
    expect(beta.assistantText).toBe('beta-answer');
    const betaRequest = primary(inference, 'beta-user');
    expect(betaRequest.body.model).toBe('org/exact-model-b');
    expect(requestTexts(betaRequest).some((text) => text.includes('alpha-user'))).toBe(true);
    const again = await session.nativeHandle();
    expect(again.state).toBe('ready');
    if (again.state === 'ready') {
      expect(Buffer.from(again.reference).equals(reference)).toBe(true);
    }

    expect(filesContaining(layout.stateRoot, creds.inferenceCredential)).toEqual([]);
    expect(filesContaining(layout.stateRoot, creds.capabilityCredential)).toEqual([]);
    expect(
      filesContaining(layout.controlRoot, creds.inferenceCredential, (path) =>
        path.endsWith(`${join('loopback', 'inference-bearer')}`)
      )
    ).toEqual([]);
    expect(statSync(join(layout.controlRoot, 'loopback', 'inference-bearer')).mode & 0o777).toBe(
      0o600
    );
    for (const marker of AMBIENT_MARKERS) {
      expect(filesContaining(layout.stateRoot, marker, isPlant)).toEqual([]);
      expect(JSON.stringify(inference.requests).includes(marker)).toBe(false);
    }
    expect(existsSync(join(layout.stateRoot, 'xdg', 'opencode'))).toBe(true);

    const mysteryLayout = makeRoots();
    // Corrupt collected terminal evidence after native completion so auxiliary inference request order cannot choose its failure path.
    const mysteryAdapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          messages: (response) => ({
            ...response,
            data: response.data.map((row) =>
              row.type === 'assistant' ? { ...row, finish: 'mystery' } : row
            ),
          }),
        }),
    });
    const mystery = await mysteryAdapter.openSession(openInput(mysteryLayout, creds));
    sessions.push(mystery);
    const unknown = await mystery.startTurn(
      turnInput(mysteryLayout, creds, 'mystery-user', 'org/exact-model-a')
    );
    const unknownOutcome = await Promise.race([
      unknown.settled.then((result) => ({ kind: 'settled' as const, result })),
      delay(20_000).then(() => ({ kind: 'timeout' as const })),
    ]);
    if (unknownOutcome.kind !== 'settled') {
      const logPath = join(mysteryLayout.stateRoot, 'xdg', 'opencode', 'log', 'opencode.log');
      const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-1500) : 'missing-log';
      expect(unknownOutcome.kind, tail).toBe('settled');
      return;
    }
    const unknownResult = unknownOutcome.result;
    expect(unknownResult.status, unknownResult.diagnostics?.native ?? '').toBe('failed');
    expect(unknownResult.assistantText).toBeNull();
    expect(unknownResult.diagnostics?.native).toBe('OpenCode assistant finish is unknown.');
    expect(mystery.childState()).toBe('absent');
    await expect(mystery.close()).rejects.toThrow(/drain or persistence flush was not proved/);

    const leaked = await session.startTurn(
      turnInput(layout, creds, 'secret-echo', 'org/exact-model-a')
    );
    const leakedResult = await leaked.settled;
    expect(leakedResult.status).toBe('failed');
    expect(leakedResult.assistantText).toBeNull();
    expect(JSON.stringify(leakedResult.diagnostics ?? {}).includes(creds.inferenceCredential)).toBe(
      false
    );

    const hung = await session.startTurn(
      turnInput(layout, creds, 'hang-user', 'org/exact-model-a')
    );
    await delay(300);
    expect(session.childState()).toBe('running');
    const interruptOutcome = await Promise.race([
      hung.interrupt().then(async () => ({
        kind: 'done' as const,
        status: (await hung.settled).status,
      })),
      delay(8_000).then(() => ({ kind: 'timeout' as const, status: 'pending' })),
    ]);
    expect(
      interruptOutcome,
      `aborted=${inference.aborted} requests=${inference.requests.length}`
    ).toEqual({ kind: 'done', status: 'interrupted' });
    expect((await hung.settled).assistantText).toBeNull();
    expect(session.childState()).toBe('running');
    const recovered = await complete(
      session,
      turnInput(layout, creds, 'after-interrupt', 'org/exact-model-a')
    );
    expect(recovered.assistantText).toBe('after-answer');

    writeFileSync(join(layout.stateRoot, 'home', 'retained.txt'), 'kept');
    const dying = await session.startTurn(
      turnInput(layout, creds, 'hang-close', 'org/exact-model-a')
    );
    const firstClose = session.close();
    expect(session.close()).toBe(firstClose);
    await expect(firstClose).rejects.toThrow(/drain or persistence flush was not proved/);
    expect((await dying.settled).status).toBe('failed');
    expect(session.childState()).toBe('absent');
    await session.exited;
    expect(readFileSync(join(layout.stateRoot, 'home', 'retained.txt'), 'utf8')).toBe('kept');
    expect(existsSync(layout.controlRoot)).toBe(true);
  }, 180_000);

  it('keeps MCP bearers on their own servers and resumes a changed supply on a successor', async () => {
    const inference = await startSyntheticInference((request) => scripted(request));
    const capability = await startSyntheticCapability();
    servers.push(inference, capability);
    const first = makeRoots();
    const creds = loopback('mcp-a', inference.url, capability.url);
    const session = await opencodeAdapter.openSession(openInput(first, creds));
    sessions.push(session);
    const opened = await session.nativeHandle();
    expect(opened.state).toBe('ready');
    if (opened.state !== 'ready') return;
    const reference = Buffer.from(opened.reference);
    await complete(
      session,
      turnInput(first, creds, 'mcp-alpha-user', 'mcp-model', acceptedRoute(creds, 'mcp-model'), [
        'alpha',
      ])
    );
    const alphaRequest = primary(inference, 'mcp-alpha-user');
    expect(toolNames(alphaRequest).some((name) => name.includes('echo-alpha'))).toBe(true);
    expect(authenticated(capability, 'alpha', creds.capabilityCredential)).toBe(true);
    expect(authenticated(capability, 'beta', creds.capabilityCredential)).toBe(false);

    const hits = inference.requests.length;
    const listed = capability.hits.length;
    await expect(
      session.startTurn(
        turnInput(first, creds, 'mcp-switch-user', 'mcp-model', acceptedRoute(creds, 'mcp-model'), [
          'beta',
        ])
      )
    ).rejects.toThrow(/does not re-list/);
    expect(inference.requests.length).toBe(hits);
    expect(capability.hits.length).toBe(listed);
    expect(session.childState()).toBe('running');
    const elsewhere = join(first.work, 'elsewhere');
    mkdirSync(elsewhere);
    await expect(
      session.startTurn({
        ...turnInput(first, creds, 'mcp-dir-user', 'mcp-model', acceptedRoute(creds, 'mcp-model'), [
          'alpha',
        ]),
        workingDirectory: elsewhere,
      })
    ).rejects.toThrow(/does not re-list/);
    expect(inference.requests.length).toBe(hits);
    expect(capability.hits.length).toBe(listed);
    expect(session.childState()).toBe('running');
    await session.close();

    const successor = makeRoots();
    successor.stateRoot = first.stateRoot;
    const nextCreds = loopback('mcp-b', inference.url, capability.url);
    const resumed = await opencodeAdapter.openSession(
      openInput(successor, nextCreds, new Uint8Array(reference))
    );
    sessions.push(resumed);
    const proved = await resumed.nativeHandle();
    expect(proved.state).toBe('ready');
    if (proved.state === 'ready') {
      expect(Buffer.from(proved.reference).equals(reference)).toBe(true);
    }
    const idleHits = capability.hits.length;
    await resumed.nativeHandle();
    await delay(100);
    expect(capability.hits.length).toBe(idleHits);
    await complete(
      resumed,
      turnInput(
        successor,
        nextCreds,
        'mcp-beta-user',
        'mcp-model',
        acceptedRoute(nextCreds, 'mcp-model'),
        ['beta']
      )
    );
    const betaRequests = inference.requests.filter((request) =>
      requestTexts(request).some((text) => text.includes('mcp-beta-user'))
    );
    const betaBodies = betaRequests.map((request) => JSON.stringify(request.body));
    expect(betaBodies.some((body) => body.includes('mcp-alpha-user'))).toBe(true);
    expect(betaBodies.some((body) => body.includes('echo-beta'))).toBe(true);
    expect(authenticated(capability, 'beta', nextCreds.capabilityCredential)).toBe(true);
    expect(authenticated(capability, 'alpha', nextCreds.capabilityCredential)).toBe(false);
    expect(authenticated(capability, 'beta', creds.capabilityCredential)).toBe(false);
    expect(filesContaining(successor.stateRoot, nextCreds.capabilityCredential)).toEqual([]);
    expect(filesContaining(successor.stateRoot, nextCreds.inferenceCredential)).toEqual([]);
    await resumed.close();

    const corrupt = await opencodeAdapter.openSession(
      openInput(makeRootsFor(first.stateRoot), creds, Buffer.from('not-a-handle'))
    );
    sessions.push(corrupt);
    expect((await corrupt.nativeHandle()).state).toBe('unknown');
    await expect(
      corrupt.startTurn(turnInput(first, creds, 'corrupt-user', 'mcp-model'))
    ).rejects.toThrow(/did not prove/);
    expect(primaryOrNull(inference, 'corrupt-user')).toBeNull();
    await corrupt.close();

    const missing = await opencodeAdapter.openSession(
      openInput(makeRootsFor(first.stateRoot), creds, Buffer.from('v1:missing-session-id'))
    );
    sessions.push(missing);
    expect((await missing.nativeHandle()).state).toBe('unknown');
    await expect(
      missing.startTurn(turnInput(first, creds, 'missing-user', 'mcp-model'))
    ).rejects.toThrow(/did not prove/);
    expect(primaryOrNull(inference, 'missing-user')).toBeNull();
  }, 180_000);

  it('interrupts a running native shell tool and leaves the session up', async () => {
    let toolCalls = 0;
    const inference = await startSyntheticInference((request) => {
      const text = requestTexts(request).join('\n');
      const names = toolNames(request);
      // The title request also contains the user text and advertises no tools.
      if (toolCalls === 0 && names.includes('shell') && text.includes('tool-user')) {
        toolCalls += 1;
        return { toolCall: { arguments: { command: 'sleep 20' }, name: 'shell' } };
      }
      return { text: 'tool-title' };
    });
    servers.push(inference);
    const layout = makeRoots();
    const creds = loopback('tool', inference.url);
    const session = await opencodeAdapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'tool-user', 'tool-model'));
    const early = await Promise.race([
      turn.settled.then((result) => ({ pending: false as const, result })),
      delay(4_000).then(() => ({ pending: true as const, result: null })),
    ]);
    expect(early.pending, JSON.stringify(early.result)).toBe(true);
    const stopped = await Promise.race([
      turn.interrupt().then(async () => ({
        kind: 'done' as const,
        status: (await turn.settled).status,
      })),
      delay(12_000).then(() => ({ kind: 'timeout' as const, status: 'pending' })),
    ]);
    expect(stopped, `aborted=${inference.aborted}`).toEqual({
      kind: 'done',
      status: 'interrupted',
    });
    expect(session.childState()).toBe('running');
    expect((await session.nativeHandle()).state).toBe('ready');
    const denies = join(layout.controlRoot, 'loopback', 'permission-decisions.jsonl');
    const recorded = existsSync(denies) ? readFileSync(denies, 'utf8') : '';
    expect(recorded.includes('once')).toBe(false);
    expect(recorded.includes('always')).toBe(false);
    expect(recorded.includes('allow')).toBe(false);
    const followed = await complete(session, turnInput(layout, creds, 'after-tool', 'tool-model'));
    expect(followed.assistantText).toBe('tool-title');
  }, 180_000);

  it('fails a native result above 16 MiB without returning the text', async () => {
    const inference = await startSyntheticInference((request) =>
      requestTexts(request).some((text) => text.includes('huge-user'))
        ? { text: 'x'.repeat(RESULT_LIMIT + 1) }
        : { text: 'huge-title' }
    );
    servers.push(inference);
    const layout = makeRoots();
    const creds = loopback('huge', inference.url);
    const session = await opencodeAdapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const result = await (
      await session.startTurn(turnInput(layout, creds, 'huge-user', 'huge-model'))
    ).settled;
    const detail = `${result.status} len=${result.assistantText?.length ?? 0} ${result.diagnostics?.native ?? ''}`;
    expect(result.status, detail).toBe('failed');
    expect(result.assistantText, detail).toBeNull();
    expect(result.diagnostics?.native ?? '', detail).toContain('16 MiB');
  }, 180_000);

  it('stays pending while session_v2 has no row, including after a Turn that fails first', async () => {
    const layout = makeRoots();
    const creds = loopback('pending-row', 'http://127.0.0.1:9/inference/v1');
    const adapter = createOpenCodeAdapter({ loadClient: async () => absentRowModule() });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    expect(await session.nativeHandle()).toEqual({ state: 'pending' });
    await expect(
      session.startTurn(turnInput(layout, creds, 'direct-user', 'direct-model', directRoute()))
    ).rejects.toThrow(/rejected the selected route/);
    expect(session.childState()).toBe('running');
    expect(await session.nativeHandle()).toEqual({ state: 'pending' });
    expect(sessionRowState(layout.stateRoot, 'sess-not-written')).toBe('absent');
  }, 120_000);

  it('resumes a SIGKILL-surviving session_v2 row from a new process', async () => {
    const inference = await startSyntheticInference((request) => scripted(request));
    servers.push(inference);
    const layout = makeRoots();
    const launched = launchWrapper(layout);
    const creds = loopback('persist', inference.url);
    const adapter = createOpenCodeAdapter({ resolveBinary: () => launched.binary });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const opened = await session.nativeHandle();
    expect(opened.state).toBe('ready');
    if (opened.state !== 'ready') return;
    const reference = Buffer.from(opened.reference);
    const sessionId = reference.toString('utf8').slice('v1:'.length);
    expect(sessionRowState(layout.stateRoot, sessionId)).toBe('present');

    await expect(
      session.startTurn(turnInput(layout, creds, 'direct-user', 'direct-model', directRoute()))
    ).rejects.toThrow(/rejected the selected route/);
    expect(session.childState()).toBe('running');
    const afterRefusal = await session.nativeHandle();
    expect(afterRefusal.state).toBe('ready');
    if (afterRefusal.state === 'ready') {
      expect(Buffer.from(afterRefusal.reference).equals(reference)).toBe(true);
    }

    const alpha = await complete(
      session,
      turnInput(layout, creds, 'alpha-user', 'org/exact-model-a')
    );
    expect(alpha.assistantText).toBe('alpha-answer');
    const ready = await session.nativeHandle();
    expect(ready.state).toBe('ready');
    if (ready.state === 'ready') {
      expect(Buffer.from(ready.reference).equals(reference)).toBe(true);
    }

    const pid = Number(readFileSync(launched.pidFile, 'utf8'));
    process.kill(pid, 'SIGKILL');
    await session.exited;
    expect(processAlive(pid)).toBe(false);

    const successorLayout = makeRootsFor(layout.stateRoot);
    const successor = await opencodeAdapter.openSession(
      openInput(successorLayout, creds, new Uint8Array(reference))
    );
    sessions.push(successor);
    const resumed = await successor.nativeHandle();
    expect(resumed.state).toBe('ready');
    if (resumed.state === 'ready') {
      expect(Buffer.from(resumed.reference).equals(reference)).toBe(true);
    }
    const beta = await complete(
      successor,
      turnInput(successorLayout, creds, 'beta-user', 'org/exact-model-b')
    );
    expect(beta.assistantText).toBe('beta-answer');
    expect(
      requestTexts(primary(inference, 'beta-user')).some((text) => text.includes('alpha-user'))
    ).toBe(true);
  }, 180_000);

  it('inspects the surviving host and lets harness.drain refuse new work', async () => {
    const layout = makeRoots();
    const integration = fakeIntegration();
    const harness = new WorkerHarness({
      environment: process.env,
      integration: integration.client,
      nativeDataRootDirectory: join(layout.root, 'native'),
      rootDirectory: join(layout.root, 'private'),
      sandboxRoot: join(layout.root, 'sandbox'),
      turnOutputDirectory: join(layout.root, 'sandbox', 'session'),
    });
    let sequence = 0;
    const send = (operation: string, body: Readonly<Record<string, unknown>>) =>
      harness.handle({
        body,
        harnessInstanceId: 'harness-opencode',
        operation: operation as 'session.open',
        operationId: createHash('sha256').update(`${layout.root}:${sequence}`).digest('hex'),
        schemaVersion: 2,
        sequence: sequence++,
      });
    const selector = {
      agentSessionId: 'as-opencode',
      agentSessionRuntimeBindingId: 'binding-as-opencode',
    };
    try {
      const config = join(layout.root, 'sandbox', 'sessions', 'as-opencode', 'config');
      mkdirSync(config, { recursive: true });
      writeFileSync(
        join(config, 'package.json'),
        JSON.stringify({
          scope: {
            agentSessionId: 'as-opencode',
            threadId: 'thread-opencode',
            workspaceId: 'workspace-opencode',
          },
          workspace: { root: join(layout.root, 'sandbox'), inputs: [] },
          extensions: { openkit: { sessionWorkspace: { layout: { slots: [] } } } },
        })
      );
      const opened = await send('session.open', {
        ...selector,
        adapterId: 'opencode',
        agentSessionCompatibilityKey: 'a'.repeat(64),
        capabilityLoopbackCredential: credential('harness-capability'),
        effectiveSetupGeneration: 1,
        inferenceLoopbackCredential: credential('harness-inference'),
        resume: null,
        threadId: 'thread-opencode',
        workspaceId: 'workspace-opencode',
      });
      expect(opened.disposition, JSON.stringify(opened.body)).toBe('succeeded');
      const inspected = await send('session.inspect', selector);
      expect(inspected.body).toMatchObject({
        childState: 'running',
        cleanupState: 'clean',
        nativeHandleState: 'ready',
        state: 'open',
      });
      const drained = await send('harness.drain', {});
      expect(drained.body).toMatchObject({ openSessions: 1, state: 'draining' });
      const second = await send('session.open', {
        ...selector,
        adapterId: 'opencode',
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'as-opencode-2',
        agentSessionRuntimeBindingId: 'binding-as-opencode-2',
        capabilityLoopbackCredential: credential('harness-capability-2'),
        effectiveSetupGeneration: 1,
        inferenceLoopbackCredential: credential('harness-inference-2'),
        resume: null,
        threadId: 'thread-opencode-2',
        workspaceId: 'workspace-opencode',
      });
      expect(second).toMatchObject({ body: { reasonCode: 'busy' }, disposition: 'refused' });
      const started = await send('turn.start', {
        ...selector,
        aepRef: 'package-opencode',
        capabilityToken: credential('capability-token'),
        contextPackageId: 'ctxpkg_turn-opencode',
        contextRef: 'context-opencode',
        deadline: '2099-01-01T00:00:00.000Z',
        inferenceToken: credential('inference-token'),
        leaseId: 'lease-opencode',
        packageSnapshotId: 'package-opencode',
        threadId: 'thread-opencode',
        turnId: 'turn-opencode',
        turnSequence: 0,
        workerControlToken: credential('control-token'),
        workspaceId: 'workspace-opencode',
      });
      expect(started).toMatchObject({ body: { reasonCode: 'busy' }, disposition: 'refused' });
      expect(integration.calls.includes('bind:as-opencode')).toBe(false);
      const closed = await send('session.close', selector);
      expect(closed.disposition).toBe('succeeded');
    } finally {
      await send('session.close', selector).catch(() => undefined);
    }
  }, 120_000);
});

const AMBIENT_MARKERS = [
  'ambient-project-marker',
  'ambient-home-marker',
  'ambient-xdg-marker',
  'ambient-config-marker',
  'ambient-skill-marker',
];

/** A finite test observation; timeout fails without changing the adapter outcome. */
async function nativeTestBound<T>(work: Promise<T>, timeout: number, detail: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(detail)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Real-distribution counterexamples from the independent W4 review.
describe('W4 round-five proof regressions', () => {
  for (const corruption of [
    'missing terminal',
    'duplicate idle',
    'session contradiction',
    'invalid cursor',
  ]) {
    it(`R2 stops on ${corruption}`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference(() => ({ text: 'proved-final' }));
      servers.push(inference);
      const creds = loopback(corruption, inference.url);
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            sessionGet: (info) =>
              corruption === 'session contradiction' && info.outcome === 'succeeded'
                ? { ...info, outcome: 'failed' }
                : info,
            messages: (response) => {
              if (!response.data.some((row) => row.type === 'assistant')) return response;
              if (corruption === 'missing terminal')
                return {
                  ...response,
                  data: response.data.filter(
                    (row) => row.type !== 'assistant' && row.type !== 'idle'
                  ),
                };
              if (corruption === 'duplicate idle') {
                const idle = response.data.findLast((row) => row.type === 'idle');
                return { ...response, data: [...response.data, { ...idle, id: 'duplicate-idle' }] };
              }
              if (corruption === 'invalid cursor') return { ...response, cursor: { next: 7 } };
              return response;
            },
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const result = await (
        await session.startTurn(turnInput(layout, creds, 'proof-user', 'model'))
      ).settled;
      expect(result.status).toBe('failed');
      expect(result.assistantText).toBeNull();
      expect(session.childState()).toBe('absent');
    }, 120_000);
  }

  it('R2 fences a late prior final before another prompt', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'first-final' }));
    servers.push(inference);
    const creds = loopback('late', inference.url);
    let published = false;
    const calls: string[] = [];
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          calls,
          messages: (response) => {
            const final = response.data.find(
              (row) => row.type === 'assistant' && row.finish === 'stop'
            );
            return published && final
              ? { ...response, data: [...response.data, { ...final, id: 'late-final' }] }
              : response;
          },
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    expect((await complete(session, turnInput(layout, creds, 'first', 'model'))).status).toBe(
      'completed'
    );
    published = true;
    calls.length = 0;
    await expect(session.startTurn(turnInput(layout, creds, 'second', 'model'))).rejects.toThrow(
      /terminal|boundary/
    );
    expect(calls).not.toContain('session.prompt');
    expect(session.childState()).toBe('absent');
  }, 120_000);

  for (const nativeOutcome of ['completed', 'failed']) {
    it(`R3 preserves ${nativeOutcome} against interrupt during collection`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference(() => ({ text: 'already-final' }));
      servers.push(inference);
      const creds = loopback(nativeOutcome, inference.url);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let observed!: () => void;
      const collecting = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            sessionGet: (info) =>
              nativeOutcome === 'failed' && info.outcome === 'succeeded'
                ? { ...info, outcome: 'failed' }
                : info,
            messages: async (response) => {
              if (!response.data.some((row) => row.type === 'assistant')) return response;
              observed();
              await held;
              return nativeOutcome === 'failed'
                ? {
                    ...response,
                    data: response.data.map((row) =>
                      row.type === 'idle'
                        ? { ...row, outcome: 'failed' }
                        : row.type === 'assistant'
                          ? { ...row, finish: 'error', error: { message: 'failed' } }
                          : row
                    ),
                  }
                : response;
            },
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const turn = await session.startTurn(turnInput(layout, creds, 'race', 'model'));
      await collecting;
      const interrupt = turn.interrupt();
      release();
      await interrupt;
      expect((await turn.settled).status).toBe(nativeOutcome);
    }, 120_000);
  }

  it('R3 refuses stale interruption of a later Turn', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference((request) =>
      requestTexts(request).some((text) => text.includes('new-hang'))
        ? { hang: true as const }
        : { text: 'old-final' }
    );
    servers.push(inference);
    const creds = loopback('stale', inference.url);
    const calls: string[] = [];
    const adapter = createOpenCodeAdapter({ loadClient: () => transformingModule({ calls }) });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const old = await session.startTurn(turnInput(layout, creds, 'old', 'model'));
    await old.settled;
    const next = await session.startTurn(turnInput(layout, creds, 'new-hang', 'model'));
    calls.length = 0;
    await old.interrupt();
    expect(calls).not.toContain('session.interrupt');
    await next.interrupt();
    expect((await next.settled).status).toBe('interrupted');
  }, 120_000);

  it('R4 qualifies graceful idle close and exact successor resume', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'persisted' }));
    servers.push(inference);
    const creds = loopback('graceful', inference.url);
    const adapter = createOpenCodeAdapter({
      spawnServer: (binary, args, options) => {
        const child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        return child;
      },
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    await complete(session, turnInput(layout, creds, 'persist-me', 'model'));
    const handle = await session.nativeHandle();
    if (handle.state !== 'ready') throw new Error('missing durable reference');
    await expect(session.close()).resolves.toBeUndefined();
    const nextLayout = makeRootsFor(layout.stateRoot);
    const next = await opencodeAdapter.openSession(openInput(nextLayout, creds, handle.reference));
    sessions.push(next);
    await complete(next, turnInput(nextLayout, creds, 'resume-me', 'model'));
    expect(
      requestTexts(primary(inference, 'resume-me')).some((text) => text.includes('persist-me'))
    ).toBe(true);
  }, 120_000);

  it('R4 rejects idle forced kill and shares rejection', async () => {
    const child = stubbornChild([]);
    child.kill = (signal) => {
      if (signal === 'SIGKILL') {
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      }
      return true;
    };
    const adapter = createOpenCodeAdapter({
      loadClient: async () => absentRowModule(),
      resolveBinary: () => '/unused',
      spawnServer: () => child,
    });
    const session = await adapter.openSession(
      openInput(makeRoots(), loopback('forced', 'http://127.0.0.1:9'))
    );
    sessions.push(session);
    const close = session.close();
    expect(session.close()).toBe(close);
    await expect(close).rejects.toThrow(/drain|flush/);
    expect(session.childState()).toBe('absent');
  });

  it('R4 rejects close of a previously crashed host', async () => {
    const child = stubbornChild([]);
    const adapter = createOpenCodeAdapter({
      loadClient: async () => absentRowModule(),
      resolveBinary: () => '/unused',
      spawnServer: () => child,
    });
    const session = await adapter.openSession(
      openInput(makeRoots(), loopback('crash', 'http://127.0.0.1:9'))
    );
    sessions.push(session);
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    await expect(session.close()).rejects.toThrow(/drain|flush/);
  });

  it('R5 rejects both interruption and settlement when escalation is unproved', async () => {
    const child = stubbornChild([]);
    const module = failingModule('prompt');
    const client = module.OpenCode.make({ baseUrl: 'http://127.0.0.1:9' });
    client.session.prompt = async () => ({ id: 'user-1' });
    client.session.get = async () => ({
      id: 'sess-1',
      time: { idle: 0 },
      model: { id: 'model', providerID: OPENCODE_PROVIDER_ID },
    });
    client.model.list = async () =>
      ({ data: [{ id: 'model', providerID: OPENCODE_PROVIDER_ID, enabled: true }] }) as never;
    client.session.interrupt = async () => ({ interrupted: true });
    module.OpenCode.make = () => client;
    const adapter = createOpenCodeAdapter({
      loadClient: async () => module,
      resolveBinary: () => '/unused',
      spawnServer: () => child,
      interruptTimeoutMs: 20,
      stopTimeoutMs: 10,
    });
    const layout = makeRoots();
    const creds = loopback('unproved-ack', 'http://127.0.0.1:9');
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'hang', 'model'));
    try {
      await expect(turn.interrupt()).rejects.toThrow(/interruption proof/);
      await expect(
        nativeTestBound(turn.settled, 100, 'settlement remained pending')
      ).rejects.toThrow(/interruption proof/);
      expect(session.childState()).toBe('unknown');
    } finally {
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
    }
  });

  it('R5 bounds an interrupt acknowledgement without a terminal', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ hang: true as const }));
    servers.push(inference);
    const creds = loopback('ack-only', inference.url);
    const adapter = createOpenCodeAdapter({
      interruptTimeoutMs: 100,
      // Keep production signal windows while bounding only interrupt acknowledgement.
      loadClient: () => transformingModule({ interrupt: async () => ({ interrupted: true }) }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'hang', 'model'));
    const outcome = await Promise.race([
      turn.interrupt().then(
        () => 'stopped',
        () => 'rejected'
      ),
      delay(1500).then(() => 'pending'),
    ]);
    expect(outcome).not.toBe('pending');
    expect(session.childState()).toBe('absent');
  }, 120_000);

  for (const bytes of ['multibyte', 'aggregate']) {
    it(`R6 rejects oversized ${bytes} native content`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference(() => ({ text: 'small' }));
      servers.push(inference);
      const creds = loopback(bytes, inference.url);
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            messages: (response) => ({
              ...response,
              data: response.data.map((row) =>
                row.type === 'assistant'
                  ? {
                      ...row,
                      content:
                        bytes === 'multibyte'
                          ? [{ type: 'text', text: '漢'.repeat(6 * 1024 * 1024) }]
                          : [
                              { type: 'text', text: 'x'.repeat(9 * 1024 * 1024) },
                              { type: 'reasoning', text: 'y'.repeat(9 * 1024 * 1024) },
                            ],
                    }
                  : row
              ),
            }),
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const result = await (await session.startTurn(turnInput(layout, creds, 'bytes', 'model')))
        .settled;
      expect(result.status).toBe('failed');
      expect(result.assistantText).toBeNull();
      expect(result.diagnostics?.native).toContain('16 MiB');
    }, 120_000);
  }

  for (const stream of ['stdout', 'stderr'] as const) {
    for (const character of ['é', '漢', '😀']) {
      for (let split = 1; split < Buffer.byteLength(character); split++) {
        it(`R7 preserves ${stream} ${character} split ${split} after exit`, async () => {
          const child = stubbornChild([]);
          child.kill = () => {
            const bytes = Buffer.from(character);
            child[stream]?.emit('data', bytes.subarray(0, split));
            child.emit('exit', null, 'SIGTERM');
            child[stream]?.emit('data', bytes.subarray(split));
            child[stream]?.emit('end');
            child.emit('close', null, 'SIGTERM');
            return true;
          };
          const adapter = createOpenCodeAdapter({
            loadClient: async () => failingModule('create'),
            resolveBinary: () => '/unused',
            spawnServer: () => child,
          });
          await expect(
            adapter.openSession(openInput(makeRoots(), loopback('split', 'http://127.0.0.1:9')))
          ).rejects.toThrow(character);
        });
      }
    }
  }

  for (const path of ['plugin', 'rpc']) {
    it(`allows an unexpected native permission once through ${path}`, async () => {
      const layout = makeRoots();
      const protectedEffect = join(layout.work, 'allowed-effect');
      const observed = join(layout.root, 'ask-observed');
      let called = false;
      const inference = await startSyntheticInference((request) => {
        if (!called && toolNames(request).includes('shell')) {
          called = true;
          return {
            toolCall: { name: 'shell', arguments: { command: `touch '${protectedEffect}'` } },
          };
        }
        return { text: 'after-allow' };
      });
      servers.push(inference);
      const creds = loopback(path, inference.url);
      const decisions: string[] = [];
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            permissionReply: (decision) => {
              decisions.push(decision);
            },
          }),
        spawnServer: (binary, args, options) => {
          const plugin = join(layout.controlRoot, 'plugin', 'index.js');
          let source = readFileSync(plugin, 'utf8');
          // Supported native hook makes the otherwise disabled prompt unavoidable.
          const forceAsk = `await ctx.permission.hook('evaluate', async evt => { if (evt.action !== 'shell') return; evt.effect = 'ask'; writeFileSync(${JSON.stringify(observed)}, 'ask'); });`;
          source =
            path === 'plugin'
              ? source.replace('    if (ctx.permission', `${forceAsk}\n    if (ctx.permission`)
              : source.replace('    if (ctx.mcp', `${forceAsk}\n    if (ctx.mcp`);
          writeFileSync(plugin, source);
          return spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        },
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const active = await session.startTurn(
        turnInput(layout, creds, 'unexpected-permission', 'model')
      );
      const result = await nativeTestBound(
        active.settled,
        10_000,
        `permission ${path}; replies=${decisions.join(',')}`
      );
      expect(called).toBe(true);
      expect(existsSync(observed)).toBe(true);
      expect(existsSync(protectedEffect)).toBe(true);
      if (path === 'plugin')
        expect(
          readFileSync(join(layout.controlRoot, 'loopback', 'permission-decisions.jsonl'), 'utf8')
        ).toContain('"decision":"once"');
      else {
        expect(decisions).toEqual(['once']);
        expect(session.childState()).toBe('running');
      }
      expect(result.status).toBe('completed');
    }, 120_000);
  }

  for (const response of [{ interrupted: false }, { interrupted: 'yes' }, {}]) {
    it(`R3 validates interrupt response ${JSON.stringify(response)}`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference(() => ({ hang: true as const }));
      servers.push(inference);
      const creds = loopback('response', inference.url);
      const adapter = createOpenCodeAdapter({
        interruptTimeoutMs: 200,
        // Real exit proof exceeded the 100 ms signal grace in the CI image.
        // Use the owned native stop budget while the missing-terminal deadline stays short.
        loadClient: () => transformingModule({ interrupt: async () => response }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const turn = await session.startTurn(turnInput(layout, creds, 'hang-response', 'model'));
      await turn.interrupt();
      const result = await turn.settled;
      expect(result.status).toBe('failed');
      if (typeof response.interrupted !== 'boolean')
        expect(result.diagnostics?.native).toContain('unknown boolean core');
      expect(session.childState()).toBe('absent');
    }, 120_000);
  }

  it('R3 drains a delayed cancellation before reusing native Turn ownership', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'won-before-cancel' }));
    servers.push(inference);
    const creds = loopback('delayed', inference.url);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          interrupt: async () => {
            await held;
            return { interrupted: false };
          },
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const turn = await session.startTurn(turnInput(layout, creds, 'delayed', 'model'));
    const interruption = turn.interrupt();
    await delay(800);
    await expect(session.startTurn(turnInput(layout, creds, 'competing', 'model'))).rejects.toThrow(
      /active Turn/
    );
    release();
    await interruption;
    expect((await turn.settled).status).toBe('completed');
    expect((await complete(session, turnInput(layout, creds, 'next', 'model'))).status).toBe(
      'completed'
    );
  }, 120_000);

  it('R7 flushes a final incomplete sequence at stream end', async () => {
    const child = stubbornChild([]);
    child.kill = () => {
      child.stderr?.emit('data', Buffer.from([0xe6]));
      child.emit('exit', null, 'SIGTERM');
      child.stderr?.emit('end');
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    const adapter = createOpenCodeAdapter({
      loadClient: async () => failingModule('create'),
      resolveBinary: () => '/unused',
      spawnServer: () => child,
    });
    await expect(
      adapter.openSession(openInput(makeRoots(), loopback('incomplete', 'http://127.0.0.1:9')))
    ).rejects.toThrow('�');
  });

  it('R6 rejects a real provider Unicode result above 16 MiB', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: '漢'.repeat(6 * 1024 * 1024) }));
    servers.push(inference);
    const creds = loopback('real-unicode', inference.url);
    const session = await opencodeAdapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const result = await (await session.startTurn(turnInput(layout, creds, 'unicode', 'model')))
      .settled;
    expect(result.status).toBe('failed');
    expect(result.assistantText).toBeNull();
    expect(result.diagnostics?.native).toContain('16 MiB');
  }, 120_000);

  it('R6 admits content exactly at 16 MiB', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'small' }));
    servers.push(inference);
    const creds = loopback('limit', inference.url);
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          messages: (response) => ({
            ...response,
            data: response.data.map((row) =>
              row.type === 'assistant'
                ? { ...row, content: [{ type: 'text', text: 'x'.repeat(RESULT_LIMIT) }] }
                : row
            ),
          }),
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const result = await (await session.startTurn(turnInput(layout, creds, 'limit', 'model')))
      .settled;
    expect(result.status).toBe('completed');
    expect(Buffer.byteLength(result.assistantText ?? '')).toBe(RESULT_LIMIT);
  }, 120_000);
  it('R1 lends the MCP bearer only to the exact admitted id and URL', async () => {
    const layout = makeRoots();
    vi.stubEnv('OPENKIT_OPENCODE_CONFIG', '');
    const pluginDir = join(layout.controlRoot, 'plugin');
    const carriers = join(layout.controlRoot, 'loopback');
    mkdirSync(pluginDir);
    mkdirSync(carriers);
    mkdirSync(join(layout.controlRoot, 'config'));
    writeFileSync(join(layout.controlRoot, 'config', 'openkit.json'), '{}');
    writeFileSync(join(carriers, 'capability-bearer'), 'synthetic-bearer');
    writeFileSync(
      join(carriers, 'mcp-grants'),
      JSON.stringify({ selected: 'http://127.0.0.1:1234/mcp/selected' })
    );
    const drafts = new Map([
      [
        'selected',
        { url: 'http://127.0.0.1:1234/mcp/selected', headers: {} as Record<string, string> },
      ],
      [
        'rogue',
        { url: 'http://127.0.0.1:1234/mcp/selected', headers: {} as Record<string, string> },
      ],
      [
        'wrong-url',
        { url: 'http://127.0.0.1:1234/mcp/rogue', headers: {} as Record<string, string> },
      ],
    ]);
    // The same admitted id with a changed URL must also stay credential-free.
    const modulePath = join(pluginDir, 'test.mjs');
    writeFileSync(modulePath, OPENCODE_PLUGIN_SOURCE);
    const plugin = (await import(modulePath)).default;
    const ctx = {
      tool: { transform: async () => undefined },
      session: { hook: async () => undefined },
      mcp: {
        transform: async (apply: (editor: unknown) => void) =>
          apply({ list: () => drafts.entries() }),
      },
    };
    await plugin.setup(ctx);
    expect(drafts.get('selected')?.headers.authorization).toBe('Bearer synthetic-bearer');
    expect(drafts.get('rogue')?.headers.authorization).toBeUndefined();
    drafts.set('selected', { url: 'http://127.0.0.1:1234/mcp/rogue', headers: {} });
    await plugin.setup(ctx);
    expect(drafts.get('selected')?.headers.authorization).toBeUndefined();
  });

  it('loads retained native plugins and MCP on first and successor Turns', async () => {
    const layout = makeRoots();
    const marker = join(layout.root, 'executed');
    const rogue = join(layout.root, 'rogue-plugin');
    mkdirSync(rogue);
    writeFileSync(join(rogue, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(rogue, 'index.js'),
      `import {writeFileSync} from 'node:fs'; export default {id:'rogue',async setup(){writeFileSync(${JSON.stringify(marker)},'executed')}};`
    );
    const capability = await startSyntheticCapability();
    servers.push(capability);
    const inference = await startSyntheticInference(() => ({ text: 'isolated' }));
    servers.push(inference);
    const config = JSON.stringify({
      plugins: [rogue],
      mcp: {
        servers: {
          rogue: {
            type: 'remote',
            url: `${capability.url}/mcp/rogue`,
            oauth: false,
            codemode: false,
          },
        },
      },
    });
    for (const dir of [
      join(layout.stateRoot, 'config'),
      join(layout.stateRoot, 'home', '.config', 'opencode'),
      join(layout.stateRoot, 'xdg', 'opencode'),
      join(layout.stateRoot, 'work'),
      join(layout.work, '.opencode'),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'opencode.json'), config);
    }
    const creds = loopback('isolation', inference.url, capability.url);
    const session = await opencodeAdapter.openSession(openInput(layout, creds));
    sessions.push(session);
    expect((await complete(session, turnInput(layout, creds, 'isolate', 'model'))).status).toBe(
      'completed'
    );
    expect(existsSync(marker)).toBe(true);
    expect(capability.hits.some((hit) => hit.method === 'tools/list')).toBe(true);
    expect(capability.hits.every((hit) => hit.authorization === null)).toBe(true);
    const handle = await session.nativeHandle();
    expect(handle.state).toBe('ready');
    if (handle.state !== 'ready') throw new Error('missing reference');
    await session.close();
    const successorLayout = makeRootsFor(layout.stateRoot);
    const successor = await opencodeAdapter.openSession(
      openInput(successorLayout, creds, handle.reference)
    );
    sessions.push(successor);
    expect(
      (await complete(successor, turnInput(successorLayout, creds, 'successor', 'model'))).status
    ).toBe('completed');
    expect(existsSync(marker)).toBe(true);
    expect(capability.hits.some((hit) => hit.method === 'tools/list')).toBe(true);
    expect(capability.hits.every((hit) => hit.authorization === null)).toBe(true);
    expect(readFileSync(join(layout.stateRoot, 'config', 'opencode.json'), 'utf8')).toBe(config);
  }, 120_000);
});

function scripted(request: CapturedInference) {
  const text = requestTexts(request).join('\n');
  // History stays in later requests. The marker that ends latest is this Turn.
  const marker = latestMarker(text, [
    'hang-close',
    'hang-user',
    'after-interrupt',
    'mystery-user',
    'secret-echo',
    'mcp-beta-user',
    'mcp-alpha-user',
    'beta-user',
    'alpha-user',
  ]);
  if (marker === 'hang-user' || marker === 'hang-close') return { hang: true as const };
  if (marker === 'mystery-user') return { text: 'mystery-answer' };
  if (marker === 'secret-echo') return { text: `leak ${request.headers.authorization ?? ''}` };
  if (marker === 'beta-user') return { text: 'beta-answer' };
  if (marker === 'after-interrupt') return { text: 'after-answer' };
  if (marker === 'mcp-beta-user' || marker === 'mcp-alpha-user') return { text: 'mcp-answer' };
  if (marker === 'alpha-user') return { text: 'alpha-answer' };
  return { text: 'title-answer' };
}

function latestMarker(text: string, markers: readonly string[]): string | null {
  let best: { end: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index < 0) continue;
    const end = index + marker.length;
    const longer = best !== null && end === best.end && marker.length > best.marker.length;
    if (best === null || end > best.end || longer) best = { end, marker };
  }
  return best?.marker ?? null;
}

/** Returns the last captured request that carries the Turn's user text. */
function primary(inference: SyntheticInference, userText: string): CapturedInference {
  const found = primaryOrNull(inference, userText);
  expect(found, `missing request for ${userText}`).not.toBeNull();
  return found as CapturedInference;
}

function primaryOrNull(inference: SyntheticInference, userText: string): CapturedInference | null {
  const matches = inference.requests.filter((request) =>
    requestTexts(request).some((text) => text.includes(userText))
  );
  return matches.at(-1) ?? null;
}

function toolNames(request: CapturedInference): string[] {
  return (request.body.tools ?? []).flatMap((tool) =>
    tool.function?.name ? [tool.function.name] : []
  );
}

function authenticated(
  capability: SyntheticCapability,
  serverId: string,
  credentialValue: string
): boolean {
  return capability.hits.some(
    (hit) =>
      hit.serverId === serverId &&
      hit.method === 'tools/list' &&
      hit.authorization === `Bearer ${credentialValue}`
  );
}

async function complete(
  session: WorkerResidentSession,
  input: WorkerResidentTurnInput
): Promise<WorkerAdapterResult> {
  const turn = await session.startTurn(input);
  return settledOk(turn);
}

async function settledOk(turn: WorkerResidentTurn): Promise<WorkerAdapterResult> {
  const result = await turn.settled;
  expect(result.status, JSON.stringify(result.diagnostics ?? {})).toBe('completed');
  return result;
}

function credential(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}

function loopback(
  seed: string,
  inferenceBaseUrl: string,
  capabilityBaseUrl = 'http://127.0.0.1:9'
) {
  return {
    capabilityBaseUrl,
    capabilityCredential: credential(`${seed}-capability`),
    inferenceBaseUrl,
    inferenceCredential: credential(`${seed}-inference`),
  };
}

function makeRoots(): {
  controlRoot: string;
  root: string;
  stateRoot: string;
  work: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'openkit-opencode-'));
  roots.push(root);
  const stateRoot = join(root, 'state');
  const controlRoot = join(root, 'control');
  const work = join(root, 'project');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { controlRoot, root, stateRoot, work };
}

/** A second control root over a retained state root. */
function makeRootsFor(stateRoot: string): ReturnType<typeof makeRoots> {
  const created = makeRoots();
  return { ...created, stateRoot };
}

function plantAmbient(layout: ReturnType<typeof makeRoots>): ReturnType<typeof makeRoots> {
  mkdirSync(join(layout.stateRoot, 'work'), { recursive: true });
  writeFileSync(
    join(layout.stateRoot, 'work', 'opencode.json'),
    JSON.stringify({ marker: 'ambient-project-marker' })
  );
  mkdirSync(join(layout.stateRoot, 'home', '.config', 'opencode'), { recursive: true });
  writeFileSync(
    join(layout.stateRoot, 'home', '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ marker: 'ambient-home-marker' })
  );
  mkdirSync(join(layout.stateRoot, 'xdg', 'opencode'), { recursive: true });
  writeFileSync(
    join(layout.stateRoot, 'xdg', 'opencode', 'opencode.json'),
    JSON.stringify({ marker: 'ambient-xdg-marker' })
  );
  mkdirSync(join(layout.stateRoot, 'config'), { recursive: true });
  writeFileSync(
    join(layout.stateRoot, 'config', 'opencode.json'),
    JSON.stringify({ marker: 'ambient-config-marker' })
  );
  const skill = join(layout.work, '.opencode', 'skills', 'evil');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'ambient-skill-marker');
  return layout;
}

function isPlant(path: string): boolean {
  return path.endsWith('opencode.json') || path.endsWith('SKILL.md');
}

function filesContaining(
  root: string,
  needle: string,
  skip: (path: string) => boolean = () => false
): string[] {
  if (!existsSync(root)) return [];
  const hits: string[] = [];
  const pending = [root];
  const bytes = Buffer.from(needle);
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (skip(path)) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && readFileSync(path).includes(bytes)) hits.push(path);
    }
  }
  return hits;
}

function openInput(
  layout: ReturnType<typeof makeRoots>,
  endpoints: ReturnType<typeof loopback>,
  resumeReference: Uint8Array | null = null
): WorkerResidentOpenInput {
  return {
    agentSessionId: 'as-opencode',
    controlRoot: layout.controlRoot,
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    loopback: endpoints,
    resumeReference,
    stateRoot: layout.stateRoot,
  };
}

function acceptedRoute(
  endpoints: ReturnType<typeof loopback>,
  model: string
): WorkerAdapterLlmRoute {
  return {
    credentialVisibility: 'placeholder',
    endpoint: {
      kind: 'openai-compatible',
      upstream: { kind: 'nanocore-gateway' },
      workerBaseUrl: endpoints.inferenceBaseUrl,
    },
    id: 'worker-inference',
    model,
    providerInstanceId: 'provider-evidence',
  };
}

function directRoute(): WorkerAdapterLlmRoute {
  return {
    credentialVisibility: 'none',
    endpoint: { kind: 'openai-compatible', upstream: { kind: 'direct-provider' } },
    id: 'direct',
    model: 'direct-model',
    providerInstanceId: 'provider-evidence',
  };
}

function turnInput(
  layout: ReturnType<typeof makeRoots>,
  endpoints: ReturnType<typeof loopback>,
  text: string,
  model: string,
  route: WorkerAdapterLlmRoute = acceptedRoute(endpoints, model),
  mcpServerIds: readonly string[] = []
): WorkerResidentTurnInput {
  return {
    allowedLlmRoutes: model.startsWith('org/exact-model-')
      ? ['org/exact-model-a', 'org/exact-model-b'].map((id) => ({
          ...acceptedRoute(endpoints, id),
          id,
        }))
      : [route],
    llmRoute: model.startsWith('org/exact-model-') ? { ...route, id: model } : route,
    mcpServerIds,
    runtimeCapture: {
      captureCoverage: { scope: 'server', value: 'off' },
      credentialValues: [],
      emit: async () => undefined,
      packageSnapshotId: 'package-opencode',
    },
    skillTargetPaths: [],
    turnDirectory: join(layout.root, 'turn'),
    turnId: `turn-${text}`,
    turnInput: text,
    workingDirectory: layout.work,
  };
}

function fakeIntegration(): { calls: string[]; client: SandboxIntegrationClient } {
  const calls: string[] = [];
  const client = {
    ready: Promise.resolve(),
    registerSessionLoopback(agentSessionId: string) {
      calls.push(`register:${agentSessionId}`);
    },
    destroySessionLoopback(agentSessionId: string) {
      calls.push(`destroy:${agentSessionId}`);
    },
    bindTurnRouteTokens(agentSessionId: string) {
      calls.push(`bind:${agentSessionId}`);
    },
    clearTurnRouteTokens(agentSessionId: string) {
      calls.push(`clear:${agentSessionId}`);
    },
    async drainTurn(agentSessionId: string) {
      calls.push(`drain:${agentSessionId}`);
      return 0;
    },
    workerControlFetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
    }),
  } as unknown as SandboxIntegrationClient;
  return { calls, client };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EPERM'
    );
  }
}

function launchWrapper(layout: ReturnType<typeof makeRoots>): { binary: string; pidFile: string } {
  const pidFile = join(layout.root, 'host.pid');
  const binary = join(layout.root, 'opencode-wrap');
  const real = resolveOpenCodeBinary();
  writeFileSync(binary, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${real}' "$@"\n`, {
    mode: 0o755,
  });
  return { binary, pidFile };
}

function stubbornChild(signals: string[]): ChildProcess {
  const stdout = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    exitCode: null;
    kill: (signal?: NodeJS.Signals) => boolean;
    killed: boolean;
    pid: number;
    signalCode: null;
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 424242;
  child.killed = false;
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  child.kill = (signal?: NodeJS.Signals) => {
    signals.push(signal ?? 'SIGTERM');
    child.killed = true;
    return true;
  };
  // Async home initialization precedes spawn; emit startup only after observation begins.
  stdout.once('newListener', () => {
    setTimeout(() => {
      stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:9\n'));
    }, 0);
  });
  return child as unknown as ChildProcess;
}

function sessionRowState(
  stateRoot: string,
  sessionId: string
): 'absent' | 'present' | 'unreadable' {
  const dbPath = join(stateRoot, 'xdg', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return 'unreadable';
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1_000 });
    try {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'")
        .get();
      if (!table) return 'unreadable';
      const row = db.prepare('SELECT id FROM session_v2 WHERE id = ?').get(sessionId);
      return row?.id === sessionId ? 'present' : 'absent';
    } finally {
      db.close();
    }
  } catch {
    return 'unreadable';
  }
}

function absentRowModule() {
  return {
    OpenCode: {
      make() {
        return {
          mcp: {
            add: async () => undefined,
            list: async () => ({ data: [] }),
            remove: async () => undefined,
          },
          message: { list: async () => ({ cursor: {}, data: [] }) },
          permission: { list: async () => [] },
          session: {
            create: async () => ({ id: 'sess-not-written' }),
            form: { list: async () => [] },
            get: async () => {
              throw new Error('missing session');
            },
            interrupt: async () => undefined,
            move: async () => undefined,
            wait: async () => undefined,
            prompt: async () => ({ id: 'user-1' }),
          },
        };
      },
    },
  } as unknown as Awaited<
    ReturnType<NonNullable<Parameters<typeof createOpenCodeAdapter>[0]['loadClient']>>
  >;
}

function failingModule(method: 'create' | 'prompt') {
  const sessionId = 'sess-1';
  let selectedModel = 'prompt-model';
  return {
    OpenCode: {
      make() {
        return {
          agent: { get: async () => ({ data: { permissions: [] } }) },
          config: { get: async () => [] },
          location: { reload: async () => undefined },
          model: {
            list: async () => ({
              data: [{ id: 'prompt-model', providerID: OPENCODE_PROVIDER_ID, enabled: true }],
            }),
          },
          mcp: {
            add: async () => undefined,
            list: async () => ({ data: [] }),
            remove: async () => undefined,
          },
          message: {
            list: async () => ({ cursor: {}, data: [] }),
          },
          permission: { list: async () => [] },
          session: {
            update: async () => undefined,
            create: async () => {
              if (method === 'create') throw new Error('create acceptance is unknown');
              return { id: sessionId };
            },
            form: { list: async () => [] },
            get: async () => ({
              id: sessionId,
              time: {},
              model: { id: selectedModel, providerID: OPENCODE_PROVIDER_ID },
            }),
            switchModel: async (input: { model: { id: string } }) => {
              selectedModel = input.model.id;
            },
            interrupt: async () => undefined,
            move: async () => undefined,
            wait: async () => undefined,
            prompt: async () => {
              if (method === 'prompt') throw new Error('prompt acceptance is unknown');
              return { id: 'user-1' };
            },
          },
        };
      },
    },
  } as unknown as Awaited<
    ReturnType<NonNullable<Parameters<typeof createOpenCodeAdapter>[0]['loadClient']>>
  >;
}

async function realModuleRejecting(
  method: 'create' | 'prompt' | 'get' | 'get-hang' | 'duplicate-terminal'
) {
  const real = (await import('@opencode/client')) as {
    OpenCode: {
      make(options: { baseUrl: string; headers?: { authorization: string } }): object;
    };
  };
  return {
    OpenCode: {
      make(options: { baseUrl: string; headers?: { authorization: string } }) {
        const client = real.OpenCode.make(options);
        let prompted = false;
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (method === 'duplicate-terminal' && prop === 'message') {
              const messageApi = Reflect.get(target, prop, receiver) as object;
              return new Proxy(messageApi, {
                get(messageTarget, key, messageReceiver) {
                  if (key === 'list') {
                    return async (...args: unknown[]) => {
                      const list = Reflect.get(messageTarget, key, messageReceiver) as (
                        ...args: unknown[]
                      ) => Promise<{ data: unknown[] }>;
                      const response = await list.apply(messageTarget, args);
                      const terminal = response.data.find(
                        (row) =>
                          typeof row === 'object' &&
                          row !== null &&
                          (row as { type?: unknown }).type === 'assistant' &&
                          ((row as { finish?: unknown }).finish === 'stop' ||
                            (row as { finish?: unknown }).finish === 'length')
                      );
                      return terminal
                        ? { ...response, data: [...response.data, terminal] }
                        : response;
                    };
                  }
                  const value = Reflect.get(messageTarget, key, messageReceiver);
                  return typeof value === 'function' ? value.bind(messageTarget) : value;
                },
              });
            }
            if (prop !== 'session') return Reflect.get(target, prop, receiver);
            const sessionApi = Reflect.get(target, prop, receiver) as object;
            return new Proxy(sessionApi, {
              get(sessionTarget, key, sessionReceiver) {
                if (method === 'get-hang' && key === 'get') {
                  return () => new Promise(() => undefined);
                }
                if (method === 'get' && key === 'prompt')
                  return async (...args: unknown[]) => {
                    prompted = true;
                    return Reflect.get(sessionTarget, key, sessionReceiver).apply(
                      sessionTarget,
                      args
                    );
                  };
                if (key === method && (method !== 'get' || prompted)) {
                  return async () => {
                    throw new Error(`${method} acceptance is unknown`);
                  };
                }
                const value = Reflect.get(sessionTarget, key, sessionReceiver);
                return typeof value === 'function' ? value.bind(sessionTarget) : value;
              },
            });
          },
        });
      },
    },
  } as unknown as ReturnType<typeof failingModule>;
}

/** Mutates native responses after the real distribution produced them. */
async function transformingModule(changes: {
  calls?: string[];
  prompt?: (info: Record<string, unknown>) => unknown;
  sessionGet?: (info: Record<string, unknown>) => unknown;
  messages?: (response: { data: Array<Record<string, unknown>> }) => unknown;
  interrupt?: () => Promise<unknown>;
  permissionReply?: (decision: string) => void;
  mcpList?: (response: { data: Array<Record<string, unknown>> }) => unknown;
}) {
  const real = await import('@opencode/client');
  return {
    OpenCode: {
      make(options: { baseUrl: string; headers?: { authorization: string } }) {
        const client = real.OpenCode.make(options);
        return new Proxy(client, {
          get(target, group, receiver) {
            const api = Reflect.get(target, group, receiver);
            const change =
              group === 'session'
                ? (changes.sessionGet ?? changes.prompt)
                : group === 'message'
                  ? changes.messages
                  : group === 'mcp'
                    ? changes.mcpList
                    : undefined;
            if (
              !change &&
              !changes.calls &&
              !(group === 'session' && changes.interrupt) &&
              !(group === 'permission' && changes.permissionReply)
            )
              return api;
            return new Proxy(api, {
              get(inner, method, innerReceiver) {
                const value = Reflect.get(inner, method, innerReceiver);
                if (group === 'permission' && method === 'reply' && changes.permissionReply)
                  return async (input: { decision: string }) => {
                    changes.permissionReply?.(input.decision);
                    return value.call(inner, input);
                  };
                if (group === 'session' && method === 'interrupt' && changes.interrupt)
                  return changes.interrupt;
                if (typeof value === 'function')
                  changes.calls?.push(`${String(group)}.${String(method)}`);
                if (group === 'session' && method === 'prompt' && changes.prompt)
                  return async (...args: unknown[]) =>
                    changes.prompt?.(await value.apply(inner, args));
                if (
                  change &&
                  method === (group === 'session' ? 'get' : 'list') &&
                  (group !== 'session' || changes.sessionGet)
                )
                  return async (...args: unknown[]) => change(await value.apply(inner, args));
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          },
        });
      },
    },
  } as unknown as ReturnType<typeof failingModule>;
}

describe('W4 round-six admitted catalog', () => {
  async function fixture() {
    const inference = await startSyntheticInference(() => ({ text: 'catalog-answer' }));
    servers.push(inference);
    const layout = makeRoots();
    const creds = loopback('catalog', inference.url);
    const calls: string[] = [];
    let native!: import('@opencode/client').OpenCodeClient;
    const adapter = createOpenCodeAdapter({
      loadClient: async () => {
        const module = await transformingModule({ calls });
        return {
          OpenCode: {
            make(options) {
              native = module.OpenCode.make(options);
              return native;
            },
          },
        };
      },
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    const a = {
      ...acceptedRoute(creds, 'org/catalog-a'),
      id: 'a',
      modelParameters: {
        contextWindow: 32000,
        maxOutputTokens: 1024,
        inputModalities: ['text'] as const,
        reasoning: false,
      },
    };
    const b = { ...acceptedRoute(creds, 'org/catalog-b'), id: 'b' };
    const input = (
      text: string,
      preferred = a,
      allowed: readonly WorkerAdapterLlmRoute[] = [a, b]
    ) => ({
      ...turnInput(layout, creds, text, preferred.model, preferred),
      allowedLlmRoutes: allowed,
    });
    return { inference, layout, creds, calls, native: () => native, adapter, session, a, b, input };
  }

  it('r6: exposes the complete exact native catalog and selects both preferred choices on one conversation', async () => {
    const f = await fixture();
    await complete(f.session, f.input('catalog-first'));
    const handle = await f.session.nativeHandle();
    expect(handle.state).toBe('ready');
    if (handle.state !== 'ready') throw new Error('missing ready handle');
    const id = Buffer.from(handle.reference).toString().slice(3);
    const catalog = await f.native().model.list({ location: { directory: f.layout.work } });
    const models = catalog.data.filter((model) => model.providerID === OPENCODE_PROVIDER_ID);
    expect(models.map((model) => model.id).sort()).toEqual([f.a.model, f.b.model]);
    expect(models.find((model) => model.id === f.a.model)?.limit).toMatchObject({
      context: 32000,
      output: 1024,
    });
    expect(models.find((model) => model.id === f.a.model)?.capabilities).toMatchObject({
      input: ['text'],
      output: ['text'],
    });
    expect((await f.native().session.get({ sessionID: id })).model).toMatchObject({
      providerID: OPENCODE_PROVIDER_ID,
      id: f.a.model,
    });
    await complete(f.session, f.input('catalog-second', f.b));
    expect((await f.native().session.get({ sessionID: id })).model).toMatchObject({
      providerID: OPENCODE_PROVIDER_ID,
      id: f.b.model,
    });
    expect(
      Buffer.from(((await f.session.nativeHandle()) as { reference: Uint8Array }).reference)
    ).toEqual(Buffer.from(handle.reference));
    expect(requestTexts(primary(f.inference, 'catalog-second')).join(' ')).toContain(
      'catalog-first'
    );
    expect(f.calls.filter((call) => call === 'session.switchModel')).toHaveLength(2);
  }, 60000);

  it('r6: independently proves native selected model without a wire rewrite', async () => {
    const f = await fixture();
    await complete(f.session, f.input('native-first'));
    const handle = await f.session.nativeHandle();
    if (handle.state !== 'ready') throw new Error('missing ready handle');
    const id = Buffer.from(handle.reference).toString().slice(3);
    expect((await f.native().session.get({ sessionID: id })).model).toMatchObject({
      id: f.a.model,
      providerID: OPENCODE_PROVIDER_ID,
    });
    await complete(f.session, f.input('native-second', f.b));
    expect((await f.native().session.get({ sessionID: id })).model).toMatchObject({
      id: f.b.model,
      providerID: OPENCODE_PROVIDER_ID,
    });
    expect(requestTexts(primary(f.inference, 'native-second')).join(' ')).toContain('native-first');
    expect(primary(f.inference, 'native-second').body.model).toBe(f.b.model);
    expect(await f.session.nativeHandle()).toEqual(handle);
  }, 60000);

  it('r6: refuses an unsupported non-preferred member before native work', async () => {
    const f = await fixture();
    const count = f.calls.length;
    await expect(
      f.session.startTurn(f.input('unsupported', f.a, [f.a, directRoute()]))
    ).rejects.toThrow(/route/);
    expect(f.calls.length).toBe(count);
    expect(f.inference.requests).toHaveLength(0);
  }, 30000);

  it('r6: refuses a credential in a non-preferred catalog member before native work', async () => {
    const f = await fixture();
    const count = f.calls.length;
    await expect(
      f.session.startTurn(
        f.input('secret-member', f.a, [f.a, { ...f.b, model: f.creds.inferenceCredential }])
      )
    ).rejects.toThrow(/credential/);
    expect(f.calls.length).toBe(count);
    expect(f.inference.requests).toHaveLength(0);
  }, 30000);

  it('r6: refuses a preferred route outside the exact set before native work', async () => {
    const f = await fixture();
    const count = f.calls.length;
    await expect(f.session.startTurn(f.input('outside', f.b, [f.a]))).rejects.toThrow(
      /preferred.*admitted/
    );
    expect(f.calls.length).toBe(count);
  }, 30000);

  it('r6: refuses duplicate native model identities before native work', async () => {
    const f = await fixture();
    const count = f.calls.length;
    await expect(
      f.session.startTurn(f.input('duplicate', f.a, [f.a, { ...f.a, id: 'other' }]))
    ).rejects.toThrow(/duplicate/);
    expect(f.calls.length).toBe(count);
  }, 30000);

  for (const failure of ['catalog', 'selection'] as const)
    it(`r6: refuses unproved ${failure} before prompting`, async () => {
      const f = await fixture();
      const real = f.native();
      if (failure === 'catalog')
        real.model.list = async () => ({ location: { directory: f.layout.work }, data: [] });
      else {
        const get = real.session.get;
        real.session.get = async (input) => ({
          ...(await get(input)),
          model: { providerID: OPENCODE_PROVIDER_ID, id: 'wrong' },
        });
      }
      const count = f.inference.requests.length;
      await expect(f.session.startTurn(f.input('unproved'))).rejects.toThrow(
        failure === 'catalog' ? /catalog/ : /selection/
      );
      expect(f.inference.requests.length).toBe(count);
      expect(f.calls).not.toContain('session.prompt');
      expect(f.session.childState()).toBe('absent');
    }, 30000);

  it('r6: refuses changed admission before any native request', async () => {
    const f = await fixture();
    await complete(f.session, f.input('fixed'));
    const count = f.calls.length;
    await expect(f.session.startTurn(f.input('changed', f.a, [f.a]))).rejects.toThrow(/successor/);
    expect(f.calls.length).toBe(count);
  }, 60000);

  for (const operation of ['add', 'remove'] as const)
    it(`r6: successor exact resume after catalog ${operation}`, async () => {
      const f = await fixture();
      await complete(f.session, f.input('predecessor', f.b));
      const handle = await f.session.nativeHandle();
      if (handle.state !== 'ready') throw new Error('missing ready handle');
      await f.session.close();
      const layout = makeRootsFor(f.layout.stateRoot);
      const successor = await f.adapter.openSession(openInput(layout, f.creds, handle.reference));
      sessions.push(successor);
      expect(await successor.nativeHandle()).toEqual(handle);
      const c = { ...acceptedRoute(f.creds, 'org/catalog-c'), id: 'c' };
      const allowed = operation === 'add' ? [f.a, f.b, c] : [f.a];
      await complete(successor, {
        ...turnInput(layout, f.creds, `successor-${operation}`, f.a.model, f.a),
        allowedLlmRoutes: allowed,
      });
      expect(await successor.nativeHandle()).toEqual(handle);
      const catalog = await f.native().model.list({ location: { directory: layout.work } });
      expect(
        catalog.data
          .filter((model) => model.providerID === OPENCODE_PROVIDER_ID)
          .map((model) => model.id)
          .sort()
      ).toEqual(allowed.map((route) => route.model).sort());
      expect(requestTexts(primary(f.inference, `successor-${operation}`)).join(' ')).toContain(
        'predecessor'
      );
    }, 60000);
});

describe('W4 round-seven collection proof', () => {
  it('r7: fences a same-id late final before a later prompt or attachment', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'published-final' }));
    servers.push(inference);
    const creds = loopback('late-same-id', inference.url);
    let published = false;
    const calls: string[] = [];
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          calls,
          messages: (response) => {
            const final = response.data.find(
              (row) => row.type === 'assistant' && row.finish === 'stop'
            );
            return published && final
              ? { ...response, data: [...response.data, { ...final }] }
              : response;
          },
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    await complete(session, turnInput(layout, creds, 'published', 'model'));
    published = true;
    calls.length = 0;
    let outcome = 'refused';
    let attached: string | null = null;
    try {
      const result = await (
        await session.startTurn(turnInput(layout, creds, 'r7-forbidden-followup-unique', 'model'))
      ).settled;
      outcome = result.status;
      attached = result.assistantText;
    } catch {}
    expect({
      outcome,
      prompted: calls.includes('session.prompt'),
      child: session.childState(),
      attached,
    }).toEqual({ outcome: 'refused', prompted: false, child: 'absent', attached: null });
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    const count = calls.length;
    await expect(session.startTurn(turnInput(layout, creds, 'fenced', 'model'))).rejects.toThrow(
      /not running/
    );
    expect(calls.length).toBe(count);
    expect(
      inference.requests.some((request) =>
        requestTexts(request).join(' ').includes('r7-forbidden-followup-unique')
      )
    ).toBe(false);
  }, 60000);

  it('r7: rejects a duplicated prior id in settlement before prior-id filtering', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'native-final' }));
    servers.push(inference);
    const creds = loopback('prior-duplicate', inference.url);
    let prompts = 0;
    const adapter = createOpenCodeAdapter({
      loadClient: () =>
        transformingModule({
          prompt: (info) => {
            prompts += 1;
            return info;
          },
          messages: (response) => {
            const final = response.data.find(
              (row) => row.type === 'assistant' && row.finish === 'stop'
            );
            return prompts === 2 && final
              ? { ...response, data: [...response.data, { ...final }] }
              : response;
          },
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    await complete(session, turnInput(layout, creds, 'prior', 'model'));
    const result = await (await session.startTurn(turnInput(layout, creds, 'current', 'model')))
      .settled;
    expect({
      status: result.status,
      text: result.assistantText,
      child: session.childState(),
    }).toEqual({ status: 'failed', text: null, child: 'absent' });
  }, 60000);

  it('r7: rejects a duplicated prior identity across native pages', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'page-final' }));
    servers.push(inference);
    const creds = loopback('page-duplicate', inference.url);
    let prompts = 0;
    const adapter = createOpenCodeAdapter({
      loadClient: async () => {
        const module = await transformingModule({
          prompt: (info) => {
            prompts += 1;
            return info;
          },
        });
        return {
          OpenCode: {
            make(options) {
              const client = module.OpenCode.make(options);
              const list = client.message.list;
              client.message.list = async (input) => {
                if (prompts !== 2) return list(input);
                const response = await list({ sessionID: input.sessionID, order: 'asc' });
                let page = response;
                for (let count = 0; page.cursor.next && count < 20; count += 1) {
                  page = await list({ sessionID: input.sessionID, cursor: page.cursor.next });
                  response.data.push(...page.data);
                }
                expect(page.cursor.next ?? null).toBeNull();
                const index = response.data.findIndex(
                  (row) => row.type === 'assistant' && row.finish === 'stop'
                );
                if (index < 0) return response;
                return input.cursor === 'r7-test-page'
                  ? {
                      ...response,
                      data: [...response.data.slice(index + 1), response.data[index]!],
                      cursor: { next: null, additive: true },
                    }
                  : {
                      ...response,
                      data: response.data.slice(0, index + 1),
                      cursor: { next: 'r7-test-page' },
                    };
              };
              return client;
            },
          },
        };
      },
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    await complete(session, turnInput(layout, creds, 'prior-page', 'model'));
    const result = await (
      await session.startTurn(turnInput(layout, creds, 'current-page', 'model'))
    ).settled;
    expect({
      status: result.status,
      text: result.assistantText,
      child: session.childState(),
    }).toEqual({ status: 'failed', text: null, child: 'absent' });
  }, 60000);

  for (const cursor of [7, [], null, 'bad'])
    it(`r7: fails malformed cursor envelope ${JSON.stringify(cursor)}`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference(() => ({ text: 'native-final' }));
      servers.push(inference);
      const creds = loopback('cursor-envelope', inference.url);
      const adapter = createOpenCodeAdapter({
        loadClient: () =>
          transformingModule({
            messages: (response) =>
              response.data.some((row) => row.type === 'assistant')
                ? { ...response, cursor }
                : response,
          }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const result = await (await session.startTurn(turnInput(layout, creds, 'malformed', 'model')))
        .settled;
      expect({
        status: result.status,
        text: result.assistantText,
        child: session.childState(),
      }).toEqual({ status: 'failed', text: null, child: 'absent' });
    }, 60000);

  for (const cursor of [
    {},
    { next: null },
    { next: undefined, extra: { next: 7 } },
    { next: null, previous: null, extra: 'safe' },
  ])
    it(`r7: accepts valid additive cursor ${JSON.stringify(cursor)}`, async () => {
      const layout = makeRoots();
      const inference = await startSyntheticInference(() => ({ text: 'native-final' }));
      servers.push(inference);
      const creds = loopback('valid-envelope', inference.url);
      const adapter = createOpenCodeAdapter({
        loadClient: () => transformingModule({ messages: (response) => ({ ...response, cursor }) }),
      });
      const session = await adapter.openSession(openInput(layout, creds));
      sessions.push(session);
      const result = await complete(session, turnInput(layout, creds, 'valid', 'model'));
      expect(result.assistantText).toBe('native-final');
      expect(session.childState()).toBe('running');
    }, 60000);

  it('r7: rejects exceptional settlement when malformed collection cannot prove stop', async () => {
    const layout = makeRoots();
    const inference = await startSyntheticInference(() => ({ text: 'native-final' }));
    servers.push(inference);
    const creds = loopback('unproved-envelope', inference.url);
    let native!: ChildProcess;
    let kill!: ChildProcess['kill'];
    const adapter = createOpenCodeAdapter({
      stopTimeoutMs: 20,
      spawnServer: (binary, args, options) => {
        native = spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        kill = native.kill.bind(native);
        native.kill = () => false;
        return native;
      },
      loadClient: () =>
        transformingModule({
          messages: (response) =>
            response.data.some((row) => row.type === 'assistant')
              ? { ...response, cursor: 7 }
              : response,
        }),
    });
    const session = await adapter.openSession(openInput(layout, creds));
    sessions.push(session);
    try {
      const turn = await session.startTurn(turnInput(layout, creds, 'unproved', 'model'));
      const actual = await turn.settled.then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      expect(actual).toHaveProperty('error');
      expect((actual as { error: Error }).error.message).toMatch(/cursor/);
      expect(session.childState()).toBe('unknown');
      const fenced = await session.startTurn(turnInput(layout, creds, 'fenced', 'model'));
      await expect(fenced.settled).rejects.toThrow(/not running/);
    } finally {
      native.kill = kill;
      kill('SIGKILL');
      await session.exited;
    }
  }, 60000);
});

describe('W4 round-eight refused setup cleanup', () => {
  for (const stop of ['proved', 'unproved', 'forced'] as const)
    it(`r8: Harness ${stop} pre-prompt cleanup preserves its release boundary`, async () => {
      const layout = makeRoots();
      const integration = fakeIntegration();
      const residents: WorkerResidentSession[] = [];
      let native!: ChildProcess;
      let kill!: ChildProcess['kill'];
      let prompts = 0;
      const adapter = createOpenCodeAdapter({
        // Forced cleanup needs native signal delivery time; only unproved cleanup uses a short window.
        stopTimeoutMs: stop === 'unproved' ? 30 : 2000,
        loadClient: async () => {
          const real = await import('@opencode/client');
          return {
            OpenCode: {
              make(options) {
                const client = real.OpenCode.make(options);
                client.model.list = async () => ({ location: { directory: '/unused' }, data: [] });
                const prompt = client.session.prompt;
                client.session.prompt = async (input) => {
                  prompts += 1;
                  return prompt(input);
                };
                return client;
              },
            },
          };
        },
        spawnServer: (binary, args, options) => {
          native = spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
          kill = native.kill.bind(native);
          if (stop !== 'proved') native.stdin!.end = (() => native.stdin) as never;
          if (stop === 'unproved') native.kill = () => false;
          return native;
        },
      });
      const nativeRoot = join(layout.root, 'native');
      const sandboxRoot = join(layout.root, 'sandbox');
      const harness = new WorkerHarness({
        adapters: {
          opencode: {
            openSession: async (input) => {
              const resident = await adapter.openSession(input);
              residents.push(resident);
              sessions.push(resident);
              return resident;
            },
          },
        },
        environment: { PATH: process.env.PATH! },
        integration: integration.client,
        nativeDataRootDirectory: nativeRoot,
        rootDirectory: join(layout.root, 'private'),
        sandboxRoot,
        turnOutputDirectory: join(sandboxRoot, 'session'),
      });
      let sequence = 0;
      const send = (operation: string, body: Readonly<Record<string, unknown>>) =>
        harness.handle({
          body,
          harnessInstanceId: 'harness-r8',
          operation: operation as never,
          operationId: credential(`${layout.root}:${sequence}`),
          schemaVersion: 2,
          sequence: sequence++,
        });
      const selector = (id: string) => ({
        agentSessionId: id,
        agentSessionRuntimeBindingId: `binding-${id}`,
      });
      const open = (id: string, resume: { digest: string; locator: string } | null = null) => {
        const config = join(sandboxRoot, 'sessions', id, 'config');
        mkdirSync(config, { recursive: true });
        writeFileSync(
          join(config, 'package.json'),
          JSON.stringify({
            scope: { agentSessionId: id, threadId: 'thread-r8', workspaceId: 'workspace-r8' },
            workspace: { root: sandboxRoot, inputs: [] },
            extensions: { openkit: { sessionWorkspace: { layout: { slots: [] } } } },
          })
        );
        return send('session.open', {
          ...selector(id),
          adapterId: 'opencode',
          agentSessionCompatibilityKey: 'a'.repeat(64),
          capabilityLoopbackCredential: credential(`capability-${id}`),
          effectiveSetupGeneration: 1,
          inferenceLoopbackCredential: credential(`inference-${id}`),
          resume,
          threadId: 'thread-r8',
          workspaceId: 'workspace-r8',
        });
      };
      try {
        expect(await open('as-r8')).toMatchObject({
          disposition: 'succeeded',
          body: { nativeHandleState: 'ready' },
        });
        const reference = readFileSync(join(nativeRoot, 'agent-session-references', 'as-r8'));
        const config = join(sandboxRoot, 'sessions', 'as-r8', 'config');
        mkdirSync(config, { recursive: true });
        const packagePath = join(config, 'package.json');
        writeFileSync(
          packagePath,
          JSON.stringify({
            capabilities: { mode: 'disabled', routes: [] },
            control: {
              adapter: { kind: 'openkit-worker-shim', targetRuntime: 'opencode' },
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
            extensions: { openkit: { turnInput: 'never-prompt-r8' } },
            llm: {
              mode: 'gateway',
              preferredLogicalModelId: 'model-r8',
              routes: [
                {
                  credentialVisibility: 'placeholder',
                  endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
                  id: 'inference-r8',
                  model: 'model-r8',
                  providerInstanceId: 'provider-r8',
                },
              ],
            },
            observability: { captureCoverage: { scope: 'server', value: 'off' } },
            runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: sandboxRoot } },
            scope: {
              agentSessionId: 'as-r8',
              threadId: 'thread-r8',
              turnId: 'turn-r8',
              workspaceId: 'workspace-r8',
            },
            snapshotId: 'package-r8',
            supply: { mcpServers: [] },
          })
        );
        const started = await send('turn.start', {
          ...selector('as-r8'),
          aepRef: packagePath,
          capabilityToken: credential('capability-turn'),
          contextPackageId: 'ctxpkg_turn-r8',
          contextRef: join(sandboxRoot, 'sessions', 'as-r8', 'context'),
          deadline: '2099-01-01T00:00:00.000Z',
          inferenceToken: credential('inference-turn'),
          leaseId: 'lease-r8',
          packageSnapshotId: 'package-r8',
          threadId: 'thread-r8',
          turnId: 'turn-r8',
          turnSequence: 0,
          workerControlToken: credential('control-turn'),
          workspaceId: 'workspace-r8',
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const inspection = await send('session.inspect', selector('as-r8'));
          const nativeWorkFinished =
            stop !== 'forced' || (await send('harness.drain', {})).body.activeTurns === 0;
          if (
            nativeWorkFinished &&
            inspection.body.state !== 'active' &&
            inspection.body.cleanupState !== 'pending'
          )
            break;
          await delay(10);
        }
        expect(prompts).toBe(0);
        if (stop === 'proved') {
          expect(started).toMatchObject({
            disposition: 'refused',
            body: {
              reasonCode: 'dependency_failed',
              startupFailure: { stage: 'native_spawn', reason: 'failed' },
            },
          });
          expect((await send('session.inspect', selector('as-r8'))).body).toMatchObject({
            childState: 'absent',
            cleanupState: 'clean',
          });
          expect(await send('session.close', selector('as-r8'))).toMatchObject({
            disposition: 'succeeded',
            body: { state: 'closed', privateState: 'absent' },
          });
          expect(existsSync(join(sandboxRoot, 'sessions', 'as-r8'))).toBe(false);
          expect(integration.calls).toContain('destroy:as-r8');
          expect(
            await open('as-r8-successor', {
              digest: createHash('sha256').update(reference).digest('hex'),
              locator: 'as-r8',
            })
          ).toMatchObject({ disposition: 'succeeded', body: { nativeHandleState: 'ready' } });
          const resumed = await residents[1]!.nativeHandle();
          expect(resumed.state).toBe('ready');
          if (resumed.state === 'ready') expect(Buffer.from(resumed.reference)).toEqual(reference);
          expect(
            readFileSync(join(nativeRoot, 'agent-session-references', 'as-r8-successor'))
          ).toEqual(reference);
          expect(await send('session.close', selector('as-r8-successor'))).toMatchObject({
            disposition: 'succeeded',
          });
          expect((await send('harness.drain', {})).body).toMatchObject({
            activeTurns: 0,
            openSessions: 0,
          });
        } else {
          expect(started).toMatchObject({ disposition: 'succeeded', body: { state: 'started' } });
          expect((await send('session.inspect', selector('as-r8'))).body).toMatchObject({
            state: 'failed',
            cleanupState: stop === 'unproved' ? 'unknown' : 'clean',
            childState: stop === 'unproved' ? 'unknown' : 'absent',
          });
          expect(await send('session.close', selector('as-r8'))).toMatchObject({
            disposition: 'refused',
            body: { reasonCode: 'cleanup_required' },
          });
          expect((await send('session.inspect', selector('as-r8'))).body).toMatchObject({
            cleanupState: 'unknown',
            state: 'failed',
          });
          expect((await send('harness.drain', {})).body).toMatchObject({
            activeTurns: stop === 'unproved' ? 1 : 0,
            openSessions: 1,
          });
        }
      } finally {
        if (stop === 'unproved') {
          native.kill = kill;
          kill('SIGKILL');
          await residents[0]!.exited;
        }
        for (const id of ['as-r8', 'as-r8-successor'])
          await send('session.close', selector(id)).catch(() => undefined);
      }
    }, 60000);
});

it.each([
  { levels: [] },
  { levels: ['low'] },
])('s4: delivers effort on retained native conversation and reports native selection %j', async ({
  levels,
}) => {
  const inference = await startSyntheticInference(() => ({ text: 'effort-answer' }));
  servers.push(inference);
  const layout = makeRoots();
  const creds = loopback('effort', inference.url);
  const session = await opencodeAdapter.openSession(openInput(layout, creds));
  sessions.push(session);
  const reasoning = {
    ...acceptedRoute(creds, 'effort-model'),
    reasoningEffortLevels: levels as ReasoningEffort[],
    modelParameters: {
      contextWindow: 32000,
      maxOutputTokens: 1024,
      inputModalities: ['text'] as const,
      reasoning: true,
    },
  };
  const plain = {
    ...reasoning,
    model: 'plain-model',
    id: 'plain-model',
    reasoningEffortLevels: undefined,
  };
  const input = (text: string, llmRoute: WorkerResidentTurnInput['llmRoute'] = reasoning) => ({
    ...turnInput(layout, creds, text, llmRoute.model, llmRoute),
    allowedLlmRoutes: [reasoning, plain],
  });
  const bodies = () =>
    inference.requests
      .filter(
        (request) => request.body.model === 'effort-model' || request.body.model === 'plain-model'
      )
      .map((request) => request.body);
  const level = (body: Record<string, unknown>) => body.reasoning_effort;
  let handle: Awaited<ReturnType<typeof session.nativeHandle>> | undefined;
  for (const [index, effort] of (
    ['low', 'high', undefined, 'none', 'minimal', 'medium', 'xhigh', 'max'] as const
  ).entries()) {
    // Live Gateway advertisement never resets or restricts the retained native selection.
    if (index === 2) reasoning.reasoningEffortLevels = ['minimal'];
    const before = bodies().length;
    const admitted = input(`effort-${index}`);
    const result = await (
      await session.startTurn({
        ...admitted,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
    ).settled;
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('completed');
    const expected = effort ?? 'high';
    expect(bodies().slice(before).length).toBeGreaterThan(0);
    expect(bodies().slice(before).map(level)).toEqual(expect.arrayContaining([expected]));
    expect(
      bodies()
        .slice(before)
        .every((body) => level(body) === expected)
    ).toBe(true);
    expect(result.diagnostics?.reasoningEffort).toBe(expected);

    if (handle) expect(await session.nativeHandle()).toEqual(handle);
    else handle = await session.nativeHandle();
    expect(handle.state).toBe('ready');
  }
  const before = bodies().length;
  const result = await (
    await session.startTurn({ ...input('plain-turn', plain), reasoningEffort: 'high' })
  ).settled;
  expect(result.status, JSON.stringify(result.diagnostics)).toBe('completed');
  expect(bodies().slice(before).length).toBeGreaterThan(0);
  expect(
    bodies()
      .slice(before)
      .every((body) => level(body) === undefined)
  ).toBe(true);
  expect(result.diagnostics?.reasoningEffortDelivery).toBe('not-delivered: model has no reasoning');
  expect(result.diagnostics?.reasoningEffort).toBe('unknown');
  expect(await session.nativeHandle()).toEqual(handle);
  const count = bodies().length;
  await expect(
    session.startTurn({ ...input('unknown-core'), reasoningEffort: 'ultra' as ReasoningEffort })
  ).rejects.toThrow();
  expect(bodies()).toHaveLength(count);
  const invalidRoute = { ...reasoning, reasoningEffortLevels: ['ultra'] as ReasoningEffort[] };
  await expect(
    session.startTurn({
      ...input('unknown-route'),
      llmRoute: invalidRoute,
      allowedLlmRoutes: [invalidRoute, plain],
    })
  ).rejects.toThrow();
  expect(bodies()).toHaveLength(count);
}, 180000);

it('s4: rejects an unproved native variant before prompting and proves cleanup', async () => {
  const inference = await startSyntheticInference(() => ({ text: 'unexpected' }));
  servers.push(inference);
  const layout = makeRoots();
  const creds = loopback('effort-proof', inference.url);
  const calls: string[] = [];
  const adapter = createOpenCodeAdapter({
    loadClient: () =>
      transformingModule({
        calls,
        sessionGet: (info) => {
          const model = info.model as Record<string, unknown> | undefined;
          return model?.variant === 'high'
            ? { ...info, model: { ...model, variant: 'low' } }
            : info;
        },
      }),
  });
  const session = await adapter.openSession(openInput(layout, creds));
  sessions.push(session);
  const route = { ...acceptedRoute(creds, 'effort-proof'), reasoningEffortLevels: [] };
  await expect(
    session.startTurn({
      ...turnInput(layout, creds, 'unproved-effort', route.model, route),
      reasoningEffort: 'high',
    })
  ).rejects.toThrow('effort selection was not proved');
  expect(inference.requests).toHaveLength(0);
  expect(calls).not.toContain('session.prompt');
  expect(session.childState()).toBe('absent');
}, 180000);
