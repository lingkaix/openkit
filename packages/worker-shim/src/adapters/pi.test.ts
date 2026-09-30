// openkit-test-platform: posix
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnCalls = vi.hoisted(
  () =>
    [] as Array<
      [
        string,
        readonly string[] | undefined,
        { env?: NodeJS.ProcessEnv; shell?: boolean; stdio?: unknown } | undefined,
      ]
    >
);

const spawnControl = vi.hoisted(() => ({
  blockKill: false,
  children: [] as Array<
    import('node:child_process').ChildProcess & {
      realKill?: import('node:child_process').ChildProcess['kill'];
    }
  >,
  hideChannel: false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(
      command: string,
      args?: readonly string[],
      options?: { env?: NodeJS.ProcessEnv; shell?: boolean; stdio?: unknown }
    ) {
      spawnCalls.push([command, args, options]);
      const child = actual.spawn(
        command,
        args as string[] | undefined,
        options as Parameters<typeof actual.spawn>[2]
      );
      const tracked = child as (typeof spawnControl.children)[number];
      tracked.realKill = child.kill.bind(child);
      if (spawnControl.blockKill) child.kill = () => false;
      if (spawnControl.hideChannel) (child.stdio as unknown[])[3] = null;
      spawnControl.children.push(tracked);
      return child;
    },
  };
});

import { WORKER_ADAPTERS, type WorkerResidentTurnInput } from '../adapter-registry.js';
import {
  type SyntheticCapability,
  startSyntheticCapability,
} from '../test-support/pi-capability.js';
import {
  type InferenceReply,
  requestTexts,
  type SyntheticInference,
  startSyntheticInference,
} from '../test-support/pi-inference.js';
import {
  createPiResidentAdapter,
  PI_RUNTIME_HOST_EXECUTABLE,
  type PiResidentBinding,
  type PiTurnSettledFrame,
  piAgentDirectory,
  piResidentAdapter,
  projectPiTurnSettlement,
} from './pi.js';
import {
  createPiLineReader,
  PI_CHANNEL_FRAME_MAX_BYTES,
  PI_RESULT_CONTENT_MAX_BYTES,
  parsePiHostFrame,
  redactPiText,
} from './pi-channel.js';

const UNPERSISTED_HOST = `import { createHash } from 'node:crypto';
import { Socket } from 'node:net';

const channel = new Socket({ fd: 3, readable: true, writable: true });
let buffer = '';
let handle = '';

channel.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.op === 'open') {
      handle = JSON.stringify({
        cwd: message.workingDirectory,
        path: message.stateRoot + '/sessions/missing/session.jsonl',
        sessionId: 'sess-missing',
      });
      reply({ id: message.id, ok: true, result: { nativeHandle: { state: 'pending' } } });
    } else if (message.op === 'turn') {
      reply({ id: message.id, ok: true, result: { state: 'started' } });
      reply({
        compactionEntryIds: [],
        event: 'turn_settled',
        nativeHandle: { digest: digest(handle), handle, state: 'ready' },
        outcome: { assistantText: 'answer-1', status: 'completed' },
        turnId: message.turnId,
      });
    } else if (message.op === 'inspect') {
      reply({
        id: message.id,
        ok: true,
        result: {
          nativeHandle: { digest: digest(handle), handle, state: 'ready' },
          state: 'idle',
          turnId: null,
        },
      });
    } else if (message.op === 'close') {
      reply({
        id: message.id,
        ok: true,
        result: { nativeHandle: { state: 'pending' }, state: 'closed' },
      });
      channel.end();
    }
    newline = buffer.indexOf('\\n');
  }
});
channel.on('error', () => undefined);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function reply(value) {
  channel.write(JSON.stringify(value) + '\\n');
}
`;

const HOST_BIN = fileURLToPath(
  new URL('../../../pi-runtime-host/src/bin/openkit-pi-runtime-host.ts', import.meta.url)
);
const PEER_BIN = fileURLToPath(new URL('../test-support/pi-channel-peer.mjs', import.meta.url));
const TIMEOUT = 120_000;
const sessions: PiResidentBinding[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  spawnControl.blockKill = false;
  spawnControl.hideChannel = false;
  for (const child of spawnControl.children) {
    if (child.realKill) child.kill = child.realKill;
  }
  for (const session of sessions.splice(0)) {
    session.kill();
    await session.exited;
  }
  for (const child of spawnControl.children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || typeof child.pid !== 'number') {
      continue;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGKILL');
    });
  }
  for (const stop of stops.splice(0).reverse()) await stop();
  spawnCalls.length = 0;
  vi.restoreAllMocks();
});

interface Dirs {
  readonly home: string;
  readonly root: string;
  readonly stateRoot: string;
  readonly turnDirectory: string;
  readonly workingDirectory: string;
}

interface Fixture {
  readonly capability: SyntheticCapability;
  readonly capabilityCredential: string;
  readonly dirs: Dirs;
  readonly inference: SyntheticInference;
  readonly inferenceCredential: string;
  open(resume?: Uint8Array | null, env?: Record<string, string>): Promise<PiResidentBinding>;
}

/** Real, absolute directories for one binding. macOS `/tmp` is a symlink, so this resolves it. */
async function createDirs(): Promise<Dirs> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-adapter-')));
  const dirs = {
    home: join(root, 'home'),
    root,
    stateRoot: join(root, 'state'),
    turnDirectory: join(root, 'turn'),
    workingDirectory: join(root, 'work'),
  };
  for (const path of Object.values(dirs)) await mkdir(path, { recursive: true });
  return dirs;
}

function credential(): string {
  return randomBytes(32).toString('base64url');
}

function hostCommand(): readonly string[] {
  return [process.execPath, '--no-warnings', HOST_BIN];
}

async function fixture(
  reply: (request: { readonly body: { readonly model: string } }, n: number) => InferenceReply,
  serverIds: readonly string[] = ['openkit-work']
): Promise<Fixture> {
  const dirs = await createDirs();
  const inferenceCredential = credential();
  const capabilityCredential = credential();
  const inference = await startSyntheticInference(reply);
  const capability = await startSyntheticCapability(capabilityCredential, serverIds);
  stops.push(
    () => inference.close(),
    () => capability.close()
  );
  const adapter = createPiResidentAdapter({ hostCommand: hostCommand() });
  return {
    capability,
    capabilityCredential,
    dirs,
    inference,
    inferenceCredential,
    open: async (resume = null, env = {}) => {
      const session = await adapter.openSession({
        agentSessionId: 'session-a',
        controlRoot: join(dirs.root, 'control'),
        environment: {
          HOME: dirs.home,
          PATH: process.env.PATH ?? '',
          TMPDIR: dirs.root,
          ...env,
        },
        loopback: {
          capabilityBaseUrl: capability.base,
          capabilityCredential,
          inferenceBaseUrl: inference.url,
          inferenceCredential,
        },
        resumeReference: resume,
        stateRoot: dirs.stateRoot,
      });
      sessions.push(session);
      return session;
    },
  };
}

function turnInput(
  dirs: Dirs,
  overrides: {
    mcpServerIds?: readonly string[];
    modelId?: string;
    prompt?: string;
    turnId?: string;
    workingDirectory?: string;
  } = {},
  routeOverrides: Partial<WorkerResidentTurnInput['llmRoute']> = {}
): WorkerResidentTurnInput {
  const modelId = overrides.modelId ?? 'logical-a';
  const llmRoute: WorkerResidentTurnInput['llmRoute'] = {
    credentialVisibility: 'placeholder',
    endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
    id: modelId,
    model: modelId,
    modelParameters: {
      contextWindow: 32_000,
      inputModalities: ['text'],
      maxOutputTokens: 4_000,
      reasoning: false,
    },
    providerInstanceId: 'provider-a',
    ...routeOverrides,
  };
  return {
    llmRoute,
    allowedLlmRoutes: ['logical-a', 'logical-b'].map((model) => ({
      ...llmRoute,
      id: model,
      model,
    })),
    mcpServerIds: overrides.mcpServerIds ?? ['openkit-work'],
    runtimeCapture: {
      captureCoverage: { scope: 'server', value: 'off' },
      credentialValues: [],
      emit: async () => undefined,
      packageSnapshotId: 'package-1',
    },
    runtimeProvenance: {
      lineage: {
        agentSessionId: 'session-a',
        packageSnapshotId: 'package-1',
        threadId: 'thread-one',
        turnId: overrides.turnId ?? 'turn-1',
        workspaceId: 'workspace-one',
      },
      maxStreamCount: 1,
      maxTotalBytes: 1_000,
      nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
      rawStreamsRoot: '/openkit/session/runtime/raw',
      streamManifestPath: '/openkit/session/runtime/raw-streams.json',
    },
    skillTargetPaths: [{ id: 'greeting', targetPath: join(dirs.workingDirectory, 'skills') }],
    turnDirectory: dirs.turnDirectory,
    turnId: overrides.turnId ?? 'turn-1',
    turnInput: overrides.prompt ?? 'prompt',
    workingDirectory: overrides.workingDirectory ?? dirs.workingDirectory,
  };
}

function digestOf(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function handleText(reference: Uint8Array): string {
  return Buffer.from(reference).toString('utf8');
}

/** Session files under the retained root. An unpersisted conversation has none. */
async function sessionJsonlFiles(stateRoot: string): Promise<string[]> {
  const root = join(stateRoot, 'sessions');
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
    }
  };
  await visit(root);
  return found;
}

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function toolNames(request: {
  readonly body: { readonly tools?: readonly { function: { name: string } }[] };
}): string[] {
  return request.body.tools?.map((tool) => tool.function.name) ?? [];
}

describe('Pi frame projection', () => {
  const handle = JSON.stringify({
    cwd: '/work',
    path: '/state/sessions/binding/session.jsonl',
    sessionId: 'sess-1',
  });
  const ready = { digest: digestOf(handle), handle, state: 'ready' as const };
  const project = (outcome: unknown, nativeHandle: unknown = ready, secrets: string[] = []) =>
    projectPiTurnSettlement(
      {
        compactionEntryIds: ['compact-1'],
        nativeHandle,
        outcome,
        turnId: 'turn-1',
      } satisfies PiTurnSettledFrame,
      { expectedHandleText: null, secrets }
    );

  it('keeps one trimmed completion and fails closed on contradictory host values', () => {
    expect(project({ assistantText: '  hello \n', status: 'completed' })).toMatchObject({
      assistantText: 'hello',
      establishes: true,
      readyText: handle,
      status: 'completed',
      stopReason: 'stop',
    });
    expect(project({ assistantText: '   ', status: 'completed' })).toMatchObject({
      assistantText: null,
      establishes: false,
      status: 'failed',
      stopReason: 'pi-final-message-empty',
    });
    expect(
      project({ assistantText: `${'a'.repeat(PI_RESULT_CONTENT_MAX_BYTES)}b`, status: 'completed' })
    ).toMatchObject({ status: 'failed', stopReason: 'pi-output-too-large', assistantText: null });
    expect(
      project({ assistantText: 'secret-value', status: 'completed' }, ready, ['secret-value'])
    ).toMatchObject({
      assistantText: null,
      status: 'failed',
      stopReason: 'pi-credential-hit',
    });
    expect(
      project({ assistantText: 'hello', status: 'completed' }, { state: 'pending' })
    ).toMatchObject({
      status: 'failed',
      stopReason: 'pi-terminal-correlation-failed',
    });
    expect(
      project({ assistantText: 'hello', status: 'completed' }, { ...ready, digest: 'a'.repeat(64) })
    ).toMatchObject({ status: 'failed', stopReason: 'pi-identity-failed' });
    expect(project({ reason: 'nope', status: 'failed' })).toMatchObject({
      status: 'failed',
      stopReason: 'pi-output-malformed',
    });
    expect(project({ reason: 'user', status: 'interrupted' })).toMatchObject({
      status: 'failed',
      stopReason: 'pi-output-malformed',
    });
    expect(project({ reason: 'worker-interrupted', status: 'interrupted' })).toMatchObject({
      assistantText: null,
      status: 'interrupted',
      stopReason: 'worker-interrupted',
    });
    expect(project({ status: 'exploded' })).toMatchObject({
      status: 'failed',
      stopReason: 'pi-output-malformed',
    });
  });

  it('ignores unknown events and bounds the frame reader', () => {
    expect(PI_CHANNEL_FRAME_MAX_BYTES).toBe(6 * PI_RESULT_CONTENT_MAX_BYTES + 64 * 1024);
    expect(parsePiHostFrame('{"event":"future_widget","detail":1}')).toEqual({ kind: 'ignored' });
    expect(parsePiHostFrame('{"event":"turn_settled","turnId":"t"}')).toEqual({ kind: 'invalid' });
    expect(
      parsePiHostFrame('{"id":1,"ok":false,"error":{"code":"future-code","message":"no"}}')
    ).toEqual({ kind: 'invalid' });
    const lines: string[] = [];
    let overflows = 0;
    const read = createPiLineReader(
      (line) => lines.push(line),
      () => {
        overflows += 1;
      },
      4
    );
    read(Buffer.from('abcde'));
    read(Buffer.from('\nok\n'));
    expect(overflows).toBe(1);
    expect(lines).toEqual(['ok']);
    expect(redactPiText('Authorization: Bearer secret token=value', ['secret'])).toBe(
      'Authorization: Bearer [redacted] token=[redacted]'
    );
  });
});

describe('Pi resume proof', () => {
  it('rejects a different conversation before spawning and proves a matching header locally', async () => {
    const dirs = await createDirs();
    const sessionPath = join(dirs.stateRoot, 'sessions', 'binding-proof', 'session.jsonl');
    await mkdir(dirname(sessionPath), { recursive: true });
    const header = `${JSON.stringify({
      cwd: dirs.workingDirectory,
      id: 'sess-real',
      type: 'session',
    })}\n`;
    await writeFile(sessionPath, header);
    const canonical = JSON.stringify({
      cwd: dirs.workingDirectory,
      path: sessionPath,
      sessionId: 'sess-real',
    });
    const marker = join(dirs.root, 'spawned');
    const adapter = createPiResidentAdapter({
      hostCommand: [
        process.execPath,
        '--eval',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`,
      ],
    });
    const open = (reference: string) =>
      adapter.openSession({
        agentSessionId: 'session-a',
        controlRoot: join(dirs.root, 'control'),
        environment: { HOME: dirs.home, PATH: process.env.PATH ?? '' },
        loopback: {
          capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
          capabilityCredential: credential(),
          inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
          inferenceCredential: credential(),
        },
        resumeReference: new Uint8Array(Buffer.from(reference)),
        stateRoot: dirs.stateRoot,
      });
    const cases: Array<[string, string]> = [
      ['{', 'Pi resume handle is malformed.'],
      [JSON.stringify({ extra: 1, ...JSON.parse(canonical) }), 'Pi resume handle is malformed.'],
      [
        JSON.stringify({
          path: sessionPath,
          sessionId: 'sess-real',
          cwd: dirs.workingDirectory,
        }),
        'Pi resume handle is not canonical.',
      ],
      [
        JSON.stringify({ cwd: dirs.workingDirectory, path: '/etc/passwd', sessionId: 'sess-real' }),
        'Pi resume handle is outside its retained state root.',
      ],
      [
        JSON.stringify({
          cwd: dirs.workingDirectory,
          path: join(dirs.stateRoot, 'sessions', 'missing', 'session.jsonl'),
          sessionId: 'sess-real',
        }),
        'Pi resume file is missing.',
      ],
      [
        JSON.stringify({
          cwd: dirs.workingDirectory,
          path: sessionPath,
          sessionId: 'sess-other',
        }),
        'Pi resume handle names another conversation.',
      ],
    ];
    for (const [reference, message] of cases) {
      await expect(open(reference)).rejects.toThrow(message);
      expect(existsSync(marker)).toBe(false);
    }
    await writeFile(sessionPath, '');
    await expect(open(canonical)).rejects.toThrow('Pi session header proof failed.');
    await rm(sessionPath);
    await writeFile(join(dirs.root, 'target.jsonl'), header);
    await symlink(join(dirs.root, 'target.jsonl'), sessionPath);
    await expect(open(canonical)).rejects.toThrow('Pi session header proof failed.');
    expect(await readdir(join(dirs.stateRoot, 'sessions'))).toEqual(['binding-proof']);
    await rm(sessionPath);
    await writeFile(sessionPath, header);
    const session = await open(canonical);
    sessions.push(session);
    await waitFor(() => existsSync(marker));
    const proved = await session.nativeHandle();
    expect(proved.state).toBe('ready');
    if (proved.state === 'ready') expect(handleText(proved.reference)).toBe(canonical);
    expect(existsSync(join(dirs.stateRoot, 'sessions', 'binding-proof', 'session.jsonl'))).toBe(
      true
    );
  });

  it('registers the image executable and fails closed when that binary is absent', async () => {
    expect(WORKER_ADAPTERS.pi).toBe(piResidentAdapter);
    const dirs = await createDirs();
    const inferenceCredential = credential();
    await expect(
      piResidentAdapter.openSession({
        agentSessionId: 'session-a',
        controlRoot: join(dirs.root, 'control'),
        environment: {
          DECOY_SECRET: inferenceCredential,
          HOME: dirs.home,
          PATH: process.env.PATH ?? '',
        },
        loopback: {
          capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
          capabilityCredential: credential(),
          inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
          inferenceCredential,
        },
        resumeReference: null,
        stateRoot: dirs.stateRoot,
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const call = spawnCalls.find((item) => item[0] === PI_RUNTIME_HOST_EXECUTABLE);
    expect(call?.[1]).toEqual([]);
    expect(call?.[2]).toMatchObject({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    expect(JSON.stringify(call?.[2]?.env)).not.toContain(inferenceCredential);
    expect(call?.[2]?.env).not.toHaveProperty('DECOY_SECRET');
  });

  it('refuses an omitted capability credential and a non-loopback endpoint before spawn', async () => {
    const dirs = await createDirs();
    const marker = join(dirs.root, 'spawned');
    const inferenceCredential = credential();
    const capabilityCredential = credential();
    const adapter = createPiResidentAdapter({
      hostCommand: [
        process.execPath,
        '--eval',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`,
      ],
    });
    const open = (loopback: {
      capabilityBaseUrl?: string;
      capabilityCredential?: string;
      inferenceBaseUrl?: string;
      inferenceCredential?: string;
    }) =>
      adapter.openSession({
        agentSessionId: 'session-a',
        controlRoot: join(dirs.root, 'control'),
        environment: { HOME: dirs.home, PATH: process.env.PATH ?? '' },
        loopback: {
          capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
          capabilityCredential,
          inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
          inferenceCredential,
          ...loopback,
        },
        resumeReference: null,
        stateRoot: dirs.stateRoot,
      });
    await expect(open({ capabilityCredential: '' })).rejects.toThrow(
      'Pi loopback credentials are invalid.'
    );
    await expect(
      open({ capabilityCredential: inferenceCredential, inferenceCredential })
    ).rejects.toThrow('Pi loopback credentials are invalid.');
    await expect(open({ capabilityBaseUrl: 'http://10.0.0.1:9/capabilities' })).rejects.toThrow(
      'Pi loopback endpoints are invalid.'
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe('Pi rejected open and Turn', () => {
  const liveHost = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

  async function openLive(
    dirs: Dirs,
    observeChannel?: (channel: Duplex) => void
  ): Promise<PiResidentBinding> {
    const adapter = createPiResidentAdapter({
      hostCommand: [process.execPath, '--eval', liveHost],
      ...(observeChannel ? { observeChannel } : {}),
    });
    return adapter.openSession({
      agentSessionId: 'session-a',
      controlRoot: join(dirs.root, 'control'),
      environment: { HOME: dirs.home, PATH: process.env.PATH ?? '' },
      loopback: {
        capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
        capabilityCredential: credential(),
        inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
        inferenceCredential: credential(),
      },
      resumeReference: null,
      stateRoot: dirs.stateRoot,
    });
  }

  function latestChild(): (typeof spawnControl.children)[number] {
    const child = spawnControl.children.at(-1);
    if (!child) throw new Error('No host process was spawned.');
    return child;
  }

  it('rejects a missing channel only after the host process has exited', async () => {
    spawnControl.hideChannel = true;
    await expect(openLive(await createDirs())).rejects.toThrow('Pi host channel is missing.');
    const child = latestChild();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('returns a fenced binding when the missing channel cannot be proved stopped', async () => {
    spawnControl.hideChannel = true;
    spawnControl.blockKill = true;
    const session = await openLive(await createDirs());
    sessions.push(session);
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    expect(session.childState()).toBe('unknown');
    await expect(session.close()).rejects.toThrow('Pi host close was not proved.');
    const child = latestChild();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it('rejects an unanswered Turn only after the host process has exited', async () => {
    let channel: Duplex | undefined;
    const dirs = await createDirs();
    const session = await openLive(dirs, (value) => {
      channel = value;
    });
    sessions.push(session);
    const pending = session.startTurn(turnInput(dirs, { prompt: 'go', turnId: 'turn-1' }));
    const pipe = channel;
    if (!pipe) throw new Error('Pi host channel was not observed.');
    pipe.destroy();
    await expect(pending).rejects.toThrow('Pi host channel is lost.');
    const child = latestChild();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(session.childState()).toBe('absent');
  });

  it('returns a Turn the Harness fences when the stop is not proved', async () => {
    spawnControl.blockKill = true;
    let channel: Duplex | undefined;
    const dirs = await createDirs();
    const session = await openLive(dirs, (value) => {
      channel = value;
    });
    sessions.push(session);
    const pending = session.startTurn(turnInput(dirs, { prompt: 'go', turnId: 'turn-1' }));
    const pipe = channel;
    if (!pipe) throw new Error('Pi host channel was not observed.');
    pipe.destroy();
    const turn = await pending;
    await expect(turn.settled).rejects.toThrow('Pi host channel is lost.');
    const winner = await Promise.race([
      turn.interrupt().then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(winner).toBe('pending');
    const child = latestChild();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    const again = await session.startTurn(turnInput(dirs, { prompt: 'again', turnId: 'turn-2' }));
    await expect(again.settled).rejects.toThrow('Pi host channel is lost.');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it('bounds an unanswered live open before admitting a Turn', async () => {
    const dirs = await createDirs();
    const session = await openLive(dirs);
    sessions.push(session);
    await expect(session.startTurn(turnInput(dirs))).rejects.toThrow();
    expect(session.childState()).toBe('absent');
  }, 15_000);

  it('reports a dead deferred-open host as unknown', async () => {
    const session = await openLive(await createDirs());
    sessions.push(session);
    session.kill();
    await session.exited;
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('rejects a Turn that was never sent without stopping the resident process', async () => {
    const dirs = await createDirs();
    const session = await openLive(dirs);
    sessions.push(session);
    const input = turnInput(dirs, { prompt: 'go', turnId: 'turn-1' });
    await expect(
      session.startTurn({
        ...input,
        llmRoute: {
          ...input.llmRoute,
          endpoint: { kind: 'openai-compatible', upstream: { kind: 'direct-provider' } },
        },
      })
    ).rejects.toThrow('Pi direct-provider routes are refused.');
    const child = latestChild();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(session.childState()).toBe('running');
  });
});

describe('Pi controlled channel faults', () => {
  async function peer(
    mode: string,
    marker?: string,
    options: { requestTimeoutMs?: number; closeExitTimeoutMs?: number } = {}
  ) {
    const dirs = await createDirs();
    const adapter = createPiResidentAdapter({
      hostCommand: [process.execPath, PEER_BIN],
      ...options,
    });
    const session = await adapter.openSession({
      agentSessionId: 'session-a',
      controlRoot: join(dirs.root, 'control'),
      environment: {
        HOME: dirs.home,
        PATH: process.env.PATH ?? '',
        PI_PEER_MODE: mode,
        ...(marker ? { PI_PEER_MARKER: marker } : {}),
      },
      loopback: {
        capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
        capabilityCredential: credential(),
        inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
        inferenceCredential: credential(),
      },
      resumeReference: null,
      stateRoot: dirs.stateRoot,
    });
    sessions.push(session);
    return { dirs, session };
  }

  it('R5 changes the admitted set only through an exact real-host successor', async () => {
    const f = await fixture((_request, n) => ({ text: `answer-${n}` }), []);
    const session = await f.open();
    const input = turnInput(f.dirs, { mcpServerIds: [] });
    expect((await (await session.startTurn(input)).settled).status).toBe('completed');
    const ready = await session.nativeHandle();
    if (ready.state !== 'ready') throw new Error('Expected exact ready reference.');
    const changed = {
      ...input,
      llmRoute: { ...input.llmRoute, model: 'logical-c', id: 'logical-c' },
    };
    const successorInput = { ...changed, allowedLlmRoutes: [changed.llmRoute], turnId: 'turn-2' };
    const write = vi.spyOn(spawnControl.children.at(-1)!.stdio[3] as Duplex, 'write');
    await expect(session.startTurn(successorInput)).rejects.toThrow('route set changed');
    expect(write).not.toHaveBeenCalled();
    expect((await session.nativeHandle()).state).toBe('ready');
    await session.close();
    const successor = await f.open(ready.reference);
    expect((await (await successor.startTurn(successorInput)).settled).status).toBe('completed');
    expect(f.inference.requests[1]!.body.model).toBe('logical-c');
    expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain('answer-1');
    expect(await successor.nativeHandle()).toEqual(ready);
    expect(spawnControl.children).toHaveLength(2);
    await successor.close();
  });

  it('R5 fixes the admitted route set before native requests', async () => {
    let channel: Duplex | undefined;
    const { dirs, session } = await peer('ordinary', undefined, {
      observeChannel: (value) => {
        channel = value;
      },
    });
    const initial = turnInput(dirs);
    expect((await (await session.startTurn(initial)).settled).status).toBe('completed');
    const write = vi.spyOn(channel!, 'write');
    const refused = [
      { ...initial, llmRoute: { ...initial.llmRoute, model: 'outside' } },
      { ...initial, allowedLlmRoutes: initial.allowedLlmRoutes.slice(0, 1) },
      {
        ...initial,
        llmRoute: { ...initial.llmRoute, providerInstanceId: 'changed' },
        allowedLlmRoutes: initial.allowedLlmRoutes.map((route) => ({
          ...route,
          providerInstanceId: 'changed',
        })),
      },
      {
        ...initial,
        llmRoute: {
          ...initial.llmRoute,
          modelParameters: { ...initial.llmRoute.modelParameters!, maxOutputTokens: 3000 },
        },
        allowedLlmRoutes: initial.allowedLlmRoutes.map((route) => ({
          ...route,
          modelParameters: { ...route.modelParameters!, maxOutputTokens: 3000 },
        })),
      },
    ];
    for (const input of refused) {
      write.mockClear();
      await expect(session.startTurn(input)).rejects.toThrow('Pi');
      expect(write).not.toHaveBeenCalled();
      expect(session.childState()).toBe('running');
    }
    const reordered = {
      ...initial,
      allowedLlmRoutes: [...initial.allowedLlmRoutes].reverse(),
      turnId: 'turn-2',
    };
    expect((await (await session.startTurn(reordered)).settled).status).toBe('completed');
  });

  it.each(
    ['malformed', 'inspect'].flatMap((kind) =>
      ['refused', 'no-exit', 'confirmed'].map((stop) => ({ kind, stop }))
    )
  )('R5 stop owner $kind $stop', async ({ kind, stop }) => {
    const markerDirs = await createDirs();
    stops.push(() => rm(markerDirs.root, { force: true, recursive: true }));
    const marker = join(markerDirs.root, 'late');
    const { dirs, session } = await peer(`race-${kind}`, marker);
    const child = spawnControl.children.at(-1)!;
    if (stop !== 'confirmed') child.kill = () => stop === 'no-exit';
    const turn = await session.startTurn(turnInput(dirs));
    let published = false;
    const result = turn.settled.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message })
    );
    void result.then(() => {
      published = true;
    });
    const inspection = kind === 'inspect' ? session.nativeHandle() : undefined;
    if (stop === 'no-exit') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(published).toBe(false);
    }
    if (stop === 'confirmed') {
      expect(await result).toMatchObject({
        value: {
          status: 'failed',
          stopReason: kind === 'inspect' ? 'pi-identity-failed' : 'pi-output-malformed',
        },
      });
      expect(session.childState()).toBe('absent');
    } else {
      expect(await result).toEqual({ error: 'Pi native stop was not proved.' });
      expect(session.childState()).toBe('unknown');
      expect(child.exitCode).toBeNull();
    }
    if (inspection) expect(await inspection).toEqual({ state: 'unknown' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(existsSync(marker)).toBe(stop !== 'confirmed');
  });

  it.each(
    ['status', 'failure', 'interruption', 'shape', 'handle'].flatMap((kind) =>
      [false, true].map((blocked) => ({ kind, blocked }))
    )
  )('R4 semantic evidence $kind blocked=$blocked', async ({ kind, blocked }) => {
    spawnControl.blockKill = blocked;
    const marker = join((await createDirs()).root, 'late');
    const { dirs, session } = await peer(`semantic-${kind}`, marker);
    const turn = await session.startTurn(turnInput(dirs));
    if (blocked) await expect(turn.settled).rejects.toThrow('Pi native stop was not proved.');
    else {
      expect(await turn.settled).toMatchObject({ status: 'failed' });
      expect(session.childState()).toBe('absent');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(marker)).toBe(false);
    }
  });

  it.each([
    'array',
    'object',
    'null',
    'number',
    'unknown',
    'negative',
    'silent',
    'no-terminal',
  ])('R4 bounded interrupt %s', async (kind) => {
    const { dirs, session } = await peer(`interrupt-${kind}`, undefined, { requestTimeoutMs: 100 });
    const turn = await session.startTurn(turnInput(dirs));
    const result = await Promise.race([
      turn.interrupt().then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1400)),
    ]);
    expect(result).not.toBe('pending');
    expect(session.childState()).toBe('absent');
    expect(await turn.settled).toMatchObject({ status: 'failed' });
  });

  it.each([
    'array',
    'object',
    'null',
    'number',
    'unknown',
  ])('R4 rejects closed interrupt shape %s after completion', async (kind) => {
    const { dirs, session } = await peer(`interrupt-after-${kind}`, undefined, {
      requestTimeoutMs: 100,
    });
    const turn = await session.startTurn(turnInput(dirs));
    expect(await turn.settled).toMatchObject({ status: 'completed' });
    await expect(turn.interrupt()).rejects.toThrow('Pi host interrupt response is invalid.');
  });

  it.each([
    'interrupt-array',
    'interrupt-no-terminal',
    'interrupt-silent',
    'active-inspect-unknown',
    'active-inspect-error',
    'active-inspect-silent',
  ])('R4 blocked stop on %s rejects active settlement', async (mode) => {
    spawnControl.blockKill = true;
    const { dirs, session } = await peer(mode, undefined, { requestTimeoutMs: 100 });
    const turn = await session.startTurn(turnInput(dirs));
    const rejected = expect(turn.settled).rejects.toThrow('Pi native stop was not proved.');
    if (mode.startsWith('interrupt-')) await expect(turn.interrupt()).rejects.toThrow();
    else expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    await rejected;
    expect(session.childState()).toBe('unknown');
    const child = spawnControl.children.at(-1)!;
    child.kill = child.realKill!;
    // A later stop proof permits the Harness cleanup retry, without a successful Turn.
    await turn.interrupt();
    expect(session.childState()).toBe('absent');
  });

  it.each(['unknown', 'error', 'silent'])('R4 active inspection %s', async (kind) => {
    const { dirs, session } = await peer(`active-inspect-${kind}`, undefined, {
      requestTimeoutMs: 100,
    });
    const turn = await session.startTurn(turnInput(dirs));
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    const result = await Promise.race([
      turn.settled.then(
        () => 'settled',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1400)),
    ]);
    expect(result).toBe('settled');
    expect(session.childState()).toBe('absent');
  });

  it.each(
    ['identical', 'conflicting'].flatMap((kind) =>
      [false, true].map((blocked) => ({ kind, blocked }))
    )
  )('R4 prior duplicate $kind blocked=$blocked', async ({ kind, blocked }) => {
    const { dirs, session } = await peer(`prior-${kind}`);
    expect(await (await session.startTurn(turnInput(dirs))).settled).toMatchObject({
      status: 'completed',
    });
    if (blocked) {
      const child = spawnControl.children.at(-1)!;
      child.kill = () => false;
    }
    const turn = await session.startTurn(turnInput(dirs, { turnId: 'turn-2' }));
    if (blocked) await expect(turn.settled).rejects.toThrow('Pi native stop was not proved.');
    else {
      expect(await turn.settled).toMatchObject({ status: 'failed' });
      expect(session.childState()).toBe('absent');
    }
  });

  it('R4 bounds and redacts all native observations', async () => {
    const { dirs, session } = await peer('observations');
    await (await session.startTurn(turnInput(dirs))).settled;
    expect(session.unsupportedUiMethods.length).toBeLessThanOrEqual(32);
    expect(session.unsupportedUiMethods.join('')).toContain('[redacted]');
    expect(Buffer.byteLength(session.unsupportedUiMethods.join(''))).toBeLessThanOrEqual(8192);
    expect(session.lastCompactionEntryIds.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(session.lastCompactionEntryIds.join(''))).toBeLessThanOrEqual(8192);
    expect(session.lastCompactionEntryIds.join('')).toContain('[redacted]');
  });

  it.each([0, 1, 2, 3, 4])('R4 actual stdout UTF-8 split %s', async (split) => {
    const { dirs, session } = await peer(`utf8-${split}`);
    const result = await (await session.startTurn(turnInput(dirs))).settled;
    expect(result.diagnostics?.stdout).toBe('😀');
  });

  it('R4 shares the close promise and its rejection', async () => {
    const { session } = await peer('stuck-close', undefined, { closeExitTimeoutMs: 100 });
    const first = session.close();
    const second = session.close();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow('Pi host close exit timed out.');
    expect(session.close()).toBe(first);
    await expect(second).rejects.toThrow('Pi host close exit timed out.');
  });

  it.each([
    'malformed',
    'disconnect',
  ])('does not settle a %s channel fault before stop proof', async (mode) => {
    spawnControl.blockKill = true;
    const { dirs, session } = await peer(mode, join((await createDirs()).root, 'late'));
    const turn = await session.startTurn(turnInput(dirs));
    await expect(turn.settled).rejects.toThrow('Pi native stop was not proved.');
    expect(session.childState()).toBe('unknown');
    await expect(turn.interrupt()).rejects.toThrow('Pi host channel is lost.');
  }, 15_000);

  it('rejects duplicate correlated settlements in one chunk', async () => {
    const { dirs, session } = await peer('duplicate');
    const turn = await session.startTurn(turnInput(dirs));
    expect(await turn.settled).toMatchObject({
      status: 'failed',
      stopReason: 'pi-terminal-correlation-failed',
    });
    expect(session.childState()).toBe('absent');
  });

  it('fences a delayed duplicate while ignoring a wrong Turn id', async () => {
    const wrong = await peer('wrong-turn');
    const turn = await wrong.session.startTurn(turnInput(wrong.dirs));
    expect(await turn.settled).toMatchObject({ status: 'completed' });
    await wrong.session.close();
    spawnControl.blockKill = true;
    const delayed = await peer('delayed-duplicate');
    const later = await delayed.session.startTurn(turnInput(delayed.dirs));
    expect(await later.settled).toMatchObject({ status: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await delayed.session.nativeHandle()).state).toBe('unknown');
    expect(delayed.session.childState()).toBe('unknown');
    await expect(delayed.session.close()).rejects.toThrow('Pi host close was not proved.');
  });

  it('bounds a silent live channel and an acknowledged close without exit', async () => {
    const silent = await peer('silent-open', undefined, { requestTimeoutMs: 100 });
    await expect(silent.session.startTurn(turnInput(silent.dirs))).rejects.toThrow(
      'Pi host request timed out.'
    );
    expect(silent.session.childState()).toBe('absent');
    const stuck = await peer('stuck-close', undefined, { closeExitTimeoutMs: 100 });
    await expect(stuck.session.close()).rejects.toThrow('Pi host close exit timed out.');
  });

  it.each([
    'unknown-state',
    'mismatched-handle',
    'bad-digest',
  ])('fails inspection on %s identity evidence', async (mode) => {
    const { dirs, session } = await peer(mode);
    const turn = await session.startTurn(turnInput(dirs));
    expect(await turn.settled).toMatchObject({ status: 'completed' });
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('refuses new input once close starts during an active Turn', async () => {
    const { dirs, session } = await peer('silent');
    const turn = await session.startTurn(turnInput(dirs));
    const closing = session.close();
    await expect(session.startTurn(turnInput(dirs, { turnId: 'turn-2' }))).rejects.toThrow(
      'Pi host is closing.'
    );
    await expect(closing).resolves.toBeUndefined();
    expect(await turn.settled).toMatchObject({ status: 'failed', stopReason: 'pi-channel-lost' });
  });

  it('rejects an unknown interrupt result after the Turn settles', async () => {
    const { dirs, session } = await peer('bad-interrupt');
    const turn = await session.startTurn(turnInput(dirs));
    await expect(turn.interrupt()).rejects.toThrow('Pi host interrupt response is invalid.');
    expect(await turn.settled).toMatchObject({ status: 'failed' });
  });
});

it.each([
  'setting',
  'late-registration',
] as const)('M4 adapter preserves the explicit unsupported script outcome from %s before provider work', async (source) => {
  const f = await fixture(() => ({ text: 'must not prompt' }));
  const agentDir = piAgentDirectory(f.dirs.stateRoot);
  await mkdir(agentDir, { recursive: true });
  if (source === 'setting') {
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultTools: ['+codemode'] })
    );
  } else {
    const extension = join(agentDir, 'late-codemode.js');
    await writeFile(
      extension,
      `import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
export default function(pi) { pi.on('session_start', () => {
  createCodemodeExtension()(pi);
  pi.setActiveTools([...pi.getActiveTools(), 'codemode']);
}); }`
    );
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [extension] }));
  }
  f.capability.bound = true;
  const session = await f.open();
  const result = await (await session.startTurn(turnInput(f.dirs))).settled;
  expect(result).toMatchObject({ status: 'failed', stopReason: 'pi-codemode-unsupported' });
  expect(f.inference.requests).toHaveLength(0);
  if (source === 'setting') expect(f.capability.log).toHaveLength(0);
  expect(f.capability.log.filter((entry) => entry.method === 'tools/call')).toHaveLength(0);
  await session.close();
});

it('M4 adapter discovers and calls default-exposure local MCP without a second managed owner', async () => {
  const replies: InferenceReply[] = [
    { toolCall: { name: 'tool_search', arguments: { query: 'echo text' } } },
    { toolCall: { name: 'mcp__local-tools__echo', arguments: { text: 'adapter-sentinel' } } },
    { text: 'adapter search completed' },
  ];
  const f = await fixture((_request, n) => replies[n - 1] ?? { text: 'unexpected' });
  const localCredential = credential();
  // The user server has its own authored local credential, unrelated to the two loopback carriers.
  // Use a plane with the exact credential written into user configuration.
  const admittedLocal = await startSyntheticCapability(localCredential, ['local-tools']);
  admittedLocal.bound = true;
  stops.push(() => admittedLocal.close());
  const agentDir = piAgentDirectory(f.dirs.stateRoot);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'local-tools': {
          url: `${admittedLocal.base}/mcp/local-tools`,
          headers: { Authorization: `Bearer ${localCredential}` },
        },
      },
    })
  );
  f.capability.bound = true;
  const session = await f.open();
  expect((await (await session.startTurn(turnInput(f.dirs))).settled).status).toBe('completed');
  expect(toolNames(f.inference.requests[0]!)).toContain('tool_search');
  expect(toolNames(f.inference.requests[0]!)).toContain('mcp__openkit-work__echo');
  expect(toolNames(f.inference.requests[1]!)).toContain('mcp__local-tools__echo');
  expect(
    admittedLocal.log
      .filter((entry) => entry.method === 'tools/call')
      .map((entry) => entry.params?.arguments)
  ).toEqual([{ text: 'adapter-sentinel' }]);
  expect(requestTexts(f.inference.requests[2]!).join(' ')).toContain('echo:adapter-sentinel');
  expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
  expect(admittedLocal.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
  await session.close();
});

describe('Pi resident host', () => {
  it(
    'keeps one conversation across Turns, then resumes that handle in a new host',
    async () => {
      const replies: InferenceReply[] = [
        { text: 'answer-1' },
        { text: 'answer-2' },
        { text: 'answer-3' },
        { text: 'answer-4' },
      ];
      const f = await fixture((_request, n) => replies[n - 1] ?? { text: 'late' });
      f.capability.bound = true;
      const session = await f.open();
      expect((await session.nativeHandle()).state).toBe('pending');
      expect(existsSync(join(f.dirs.stateRoot, 'sessions'))).toBe(false);
      const first = await (
        await session.startTurn(turnInput(f.dirs, { prompt: 'remember cobalt', turnId: 'turn-1' }))
      ).settled;
      expect(first).toEqual({ assistantText: 'answer-1', status: 'completed', stopReason: 'stop' });
      const firstHandle = await session.nativeHandle();
      expect(session.nativeEventCount).toBeGreaterThan(0);
      expect(toolNames(f.inference.requests[0]!)).toContain('mcp__openkit-work__echo');
      const second = await (
        await session.startTurn(
          turnInput(f.dirs, { prompt: 'what was the word?', turnId: 'turn-2' })
        )
      ).settled;
      expect(second).toMatchObject({ assistantText: 'answer-2', status: 'completed' });
      const remembered = requestTexts(f.inference.requests[1]!).join('\n');
      expect(remembered).toContain('remember cobalt');
      expect(remembered).toContain('answer-1');
      expect(f.inference.requests[1]?.body.model).toBe('logical-a');
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      const changedInput = turnInput(f.dirs, {
        modelId: 'logical-b',
        prompt: 'continue',
        turnId: 'turn-3',
      });
      const changed = await (
        await session.startTurn({
          ...changedInput,
          allowedLlmRoutes: [...changedInput.allowedLlmRoutes].reverse(),
        })
      ).settled;
      expect(changed).toMatchObject({ assistantText: 'answer-3', status: 'completed' });
      expect(f.inference.requests.at(-1)?.body.model).toBe('logical-b');
      expect(requestTexts(f.inference.requests.at(-1)!).join(' ')).toContain('answer-1');
      expect(await session.nativeHandle()).toEqual(firstHandle);
      expect(spawnControl.children).toHaveLength(1);
      const beforeInspect = f.inference.requests.length;
      const ready = await session.nativeHandle();
      expect(ready.state).toBe('ready');
      expect(f.inference.requests).toHaveLength(beforeInspect);
      if (ready.state !== 'ready') throw new Error('handle was not ready');
      const text = handleText(ready.reference);
      expect(digestOf(ready.reference)).toBe(digestOf(text));
      const { path } = JSON.parse(text) as { path: string };
      const planted = join(f.dirs.stateRoot, 'memory', 'notes.md');
      await mkdir(dirname(planted), { recursive: true });
      await writeFile(planted, 'retained user bytes');
      const preserved = await readFile(path);
      await session.close();
      expect(session.childState()).toBe('absent');
      expect(await readFile(planted, 'utf8')).toBe('retained user bytes');
      expect((await readFile(path)).subarray(0, preserved.length).equals(preserved)).toBe(true);

      await writeFile(path, preserved);
      f.capability.bound = false;
      const capabilityCount = f.capability.log.length;
      const successor = await f.open(ready.reference);
      expect(await successor.nativeHandle()).toEqual(ready);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.capability.log).toHaveLength(capabilityCount);
      await expect(
        successor.startTurn(
          turnInput(f.dirs, { prompt: 'again', turnId: 'turn-4', workingDirectory: f.dirs.root })
        )
      ).rejects.toThrow('Pi resume handle records another working directory.');
      expect(f.inference.requests).toHaveLength(beforeInspect);
      f.capability.bound = true;
      const resumed = await (
        await successor.startTurn(turnInput(f.dirs, { prompt: 'again', turnId: 'turn-4' }))
      ).settled;
      expect(resumed).toMatchObject({ assistantText: 'answer-4', status: 'completed' });
      expect(requestTexts(f.inference.requests.at(-1)!).join('\n')).toContain('answer-1');
      const again = await successor.nativeHandle();
      expect(again).toEqual(ready);
      await successor.close();
    },
    TIMEOUT
  );

  it(
    'interrupts an established Turn during the model and during a tool call without closing',
    async () => {
      const replies: InferenceReply[] = [
        { text: 'established' },
        { hang: true },
        { toolCall: { arguments: { text: 'held' }, name: 'mcp__openkit-work__echo' } },
        { text: 'after interrupt' },
      ];
      const f = await fixture((_request, n) => replies[n - 1] ?? { text: 'late' });
      f.capability.bound = true;
      const session = await f.open();
      expect(
        (
          await (
            await session.startTurn(turnInput(f.dirs, { prompt: 'first', turnId: 'turn-1' }))
          ).settled
        ).status
      ).toBe('completed');
      const hung = await session.startTurn(
        turnInput(f.dirs, { prompt: 'mid-model', turnId: 'turn-2' })
      );
      await waitFor(() => f.inference.requests.length === 2);
      await hung.interrupt();
      expect(await hung.settled).toMatchObject({
        assistantText: null,
        status: 'interrupted',
        stopReason: 'worker-interrupted',
      });
      expect(session.childState()).toBe('running');
      expect((await session.nativeHandle()).state).toBe('ready');
      f.capability.holdToolCall = true;
      const tool = await session.startTurn(
        turnInput(f.dirs, { prompt: 'mid-tool', turnId: 'turn-3' })
      );
      await waitFor(() => f.capability.log.some((entry) => entry.method === 'tools/call'));
      await tool.interrupt();
      expect(await tool.settled).toMatchObject({ status: 'interrupted' });
      f.capability.holdToolCall = false;
      f.capability.cutStreams();
      expect(
        (
          await (
            await session.startTurn(turnInput(f.dirs, { prompt: 'next', turnId: 'turn-4' }))
          ).settled
        ).status
      ).toBe('completed');
      await session.close();

      const fenced = await fixture(() => ({ hang: true }));
      fenced.capability.bound = true;
      const first = await fenced.open();
      const opening = await first.startTurn(
        turnInput(fenced.dirs, { prompt: 'never', turnId: 'turn-1' })
      );
      await waitFor(() => fenced.inference.requests.length === 1);
      await opening.interrupt();
      expect(await opening.settled).toMatchObject({ status: 'interrupted' });
      expect(await sessionJsonlFiles(fenced.dirs.stateRoot)).toHaveLength(1);
      expect((await first.nativeHandle()).state).toBe('unknown');
      await expect(
        first.startTurn(turnInput(fenced.dirs, { prompt: 'again', turnId: 'turn-2' }))
      ).rejects.toThrow('Pi conversation is not reusable until a completed first Turn.');
      await first.close();
    },
    TIMEOUT
  );

  it(
    'stays pending until a new process can resume the session file',
    async () => {
      const hung = await fixture(() => ({ text: 'unused' }));
      hung.capability.bound = true;
      hung.capability.holdInitialize = true;
      const early = await hung.open();
      expect((await early.nativeHandle()).state).toBe('pending');
      expect(await sessionJsonlFiles(hung.dirs.stateRoot)).toEqual([]);
      const opening = await early.startTurn(
        turnInput(hung.dirs, { prompt: 'never', turnId: 'turn-1' })
      );
      await waitFor(() => hung.capability.log.some((entry) => entry.method === 'initialize'));
      expect(await sessionJsonlFiles(hung.dirs.stateRoot)).toEqual([]);
      expect((await early.nativeHandle()).state).toBe('pending');
      await opening.interrupt();
      expect(await opening.settled).toMatchObject({
        status: 'interrupted',
        stopReason: 'worker-interrupted',
      });
      expect(await sessionJsonlFiles(hung.dirs.stateRoot)).toEqual([]);
      expect((await early.nativeHandle()).state).toBe('unknown');
      await expect(
        early.startTurn(turnInput(hung.dirs, { prompt: 'again', turnId: 'turn-2' }))
      ).rejects.toThrow('Pi conversation is not reusable until a completed first Turn.');
      await early.close();

      const replies: InferenceReply[] = [{ text: 'answer-1' }, { text: 'answer-2' }];
      const done = await fixture((_request, n) => replies[n - 1] ?? { text: 'late' });
      done.capability.bound = true;
      const session = await done.open();
      expect((await session.nativeHandle()).state).toBe('pending');
      const first = await (
        await session.startTurn(
          turnInput(done.dirs, { prompt: 'remember cobalt', turnId: 'turn-1' })
        )
      ).settled;
      expect(first).toMatchObject({ assistantText: 'answer-1', status: 'completed' });
      const ready = await session.nativeHandle();
      expect(ready.state).toBe('ready');
      if (ready.state !== 'ready') throw new Error('handle was not ready');
      const handlePath = (JSON.parse(handleText(ready.reference)) as { path: string }).path;
      expect(await sessionJsonlFiles(done.dirs.stateRoot)).toEqual([handlePath]);
      const headerLine = (await readFile(handlePath, 'utf8')).split('\n')[0] ?? '';
      expect(JSON.parse(headerLine)).toMatchObject({ type: 'session' });
      await session.close();

      const successor = await done.open(ready.reference);
      expect(await successor.nativeHandle()).toEqual(ready);
      const resumed = await (
        await successor.startTurn(turnInput(done.dirs, { prompt: 'again', turnId: 'turn-2' }))
      ).settled;
      expect(resumed).toMatchObject({ assistantText: 'answer-2', status: 'completed' });
      expect(requestTexts(done.inference.requests.at(-1)!).join('\n')).toContain('answer-1');
      expect(await successor.nativeHandle()).toEqual(ready);
      await successor.close();
    },
    TIMEOUT
  );

  it('stops a completion whose ready frame has no resumable session file', async () => {
    const dirs = await createDirs();
    const script = join(dirs.root, 'unpersisted-host.mjs');
    await writeFile(script, UNPERSISTED_HOST);
    const adapter = createPiResidentAdapter({
      hostCommand: [process.execPath, script],
    });
    const session = await adapter.openSession({
      agentSessionId: 'session-a',
      controlRoot: join(dirs.root, 'control'),
      environment: { HOME: dirs.home, PATH: process.env.PATH ?? '' },
      loopback: {
        capabilityBaseUrl: 'http://127.0.0.1:9/capabilities',
        capabilityCredential: credential(),
        inferenceBaseUrl: 'http://127.0.0.1:9/inference/v1',
        inferenceCredential: credential(),
      },
      resumeReference: null,
      stateRoot: dirs.stateRoot,
    });
    sessions.push(session);
    expect((await session.nativeHandle()).state).toBe('pending');
    const turn = await session.startTurn(turnInput(dirs, { prompt: 'go', turnId: 'turn-1' }));
    expect(await turn.settled).toMatchObject({
      assistantText: null,
      status: 'failed',
      stopReason: 'pi-identity-failed',
    });
    expect(await sessionJsonlFiles(dirs.stateRoot)).toEqual([]);
    expect((await session.nativeHandle()).state).toBe('unknown');
    await expect(
      session.startTurn(turnInput(dirs, { prompt: 'again', turnId: 'turn-2' }))
    ).rejects.toThrow('Pi host channel is lost.');
    expect(session.childState()).toBe('absent');
    await expect(session.close()).rejects.toThrow('Pi host close was not proved.');
  });

  it(
    'fails a Turn when the channel drops or the host exits, and does not call that an interrupt',
    async () => {
      let channel: Duplex | undefined;
      const dirs = await createDirs();
      const inferenceCredential = credential();
      const capabilityCredential = credential();
      const inference = await startSyntheticInference(() => ({ hang: true }));
      const capability = await startSyntheticCapability(capabilityCredential, ['openkit-work']);
      stops.push(
        () => inference.close(),
        () => capability.close()
      );
      const adapter = createPiResidentAdapter({
        hostCommand: hostCommand(),
        observeChannel: (value) => {
          channel = value;
        },
      });
      const open = () =>
        adapter.openSession({
          agentSessionId: 'session-a',
          controlRoot: join(dirs.root, 'control'),
          environment: { HOME: dirs.home, PATH: process.env.PATH ?? '', TMPDIR: dirs.root },
          loopback: {
            capabilityBaseUrl: capability.base,
            capabilityCredential,
            inferenceBaseUrl: inference.url,
            inferenceCredential,
          },
          resumeReference: null,
          stateRoot: dirs.stateRoot,
        });
      capability.bound = true;
      const session = await open();
      sessions.push(session);
      const turn = await session.startTurn(turnInput(dirs, { prompt: 'drop', turnId: 'turn-1' }));
      await waitFor(() => inference.requests.length === 1);
      channel?.end();
      const lost = await turn.settled;
      expect(lost.status).toBe('failed');
      expect(lost.stopReason).toBe('pi-channel-lost');
      expect(session.childState()).toBe('absent');
      expect(JSON.stringify(lost)).not.toContain(inferenceCredential);
      expect(JSON.stringify(lost)).not.toContain(capabilityCredential);
      await expect(turn.interrupt()).rejects.toThrow('Pi host channel is lost.');
      await session.exited;
      await expect(session.close()).rejects.toThrow('Pi host close was not proved.');

      const killed = await open();
      sessions.push(killed);
      const hanging = await killed.startTurn(turnInput(dirs, { prompt: 'kill', turnId: 'turn-2' }));
      await waitFor(() => inference.requests.length === 2);
      killed.kill();
      expect(await hanging.settled).toMatchObject({
        status: 'failed',
        stopReason: 'pi-channel-lost',
      });
      await expect(hanging.interrupt()).rejects.toThrow('Pi host channel is lost.');
    },
    TIMEOUT
  );

  it(
    'loads an Extension and Skill, keeps credentials out of the process, and ignores stale files',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { arguments: { command: 'touch pwned' }, name: 'bash' } },
        { text: 'blocked as expected' },
      ];
      const f = await fixture((_request, n) => replies[n - 1] ?? { text: 'late' });
      const session = await f.open(null, {
        BROWSER_TEST_PATH: '/opt/browser/chrome',
        DECOY_SECRET: f.inferenceCredential,
      });
      const agentDir = piAgentDirectory(f.dirs.stateRoot);
      const probe = join(f.dirs.root, 'extension-probe.jsonl');
      const packageRoot = join(f.dirs.root, 'user-package');
      await mkdir(join(packageRoot, 'skills', 'greeting'), { recursive: true });
      await mkdir(join(packageRoot, 'prompts'), { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'user-package',
          pi: { extensions: ['./extension.js'], prompts: ['./prompts'], skills: ['./skills'] },
          type: 'module',
          version: '1.0.0',
        })
      );
      await writeFile(
        join(packageRoot, 'extension.js'),
        `import { appendFileSync } from 'node:fs';
const probe = ${JSON.stringify(probe)};
const record = (value) => appendFileSync(probe, JSON.stringify(value) + '\\n');
console.log('{"id":1,"ok":true,"result":{"noise":"stdout"}}');
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    record({ argv: process.argv, confirm: await ctx.ui.confirm('Allow?', 'native permission'), env: process.env, model: ctx.model, type: 'session_start' });
    ctx.ui.setWidget('panel', ['unsupported']);
  });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const choice = await ctx.ui.select('Allow bash?', ['Allow once', 'Reject']);
    record({ choice: choice ?? null, type: 'permission' });
    return choice === 'Allow once' ? undefined : { block: true, reason: 'permission not granted' };
  });
}
`
      );
      await writeFile(
        join(packageRoot, 'skills', 'greeting', 'SKILL.md'),
        '---\nname: greeting\ndescription: Greets people in the synthetic fixture.\n---\n\nSay hello.\n'
      );
      await writeFile(join(packageRoot, 'prompts', 'hello.md'), 'Template says hello to $1.\n');
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageRoot] }));
      await writeFile(
        join(agentDir, 'auth.json'),
        JSON.stringify({
          'openkit-worker-inference': { key: 'stale-retained-key', type: 'api_key' },
        })
      );
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: { 'openkit-worker-inference': { apiKey: 'stale-models-key' } },
        })
      );
      const markers: Record<string, string> = {
        [join(agentDir, 'AGENTS.md')]: 'marker-agent-agents',
        [join(agentDir, 'APPEND_SYSTEM.md')]: 'marker-agent-append',
        [join(agentDir, 'SYSTEM.md')]: 'marker-agent-system',
      };
      for (const [path, marker] of Object.entries(markers)) await writeFile(path, `${marker}\n`);
      f.capability.bound = true;
      const settled = await (
        await session.startTurn(turnInput(f.dirs, { prompt: '/hello world', turnId: 'turn-1' }))
      ).settled;
      expect(settled).toMatchObject({ assistantText: 'blocked as expected', status: 'completed' });
      expect(JSON.stringify(settled)).not.toContain('"noise"');
      const body = JSON.stringify(f.inference.requests[0]?.body);
      expect(body).toContain('Template says hello to world.');
      expect(body).toContain('Greets people in the synthetic fixture.');
      for (const marker of Object.values(markers)) expect(body).not.toContain(marker);
      expect(f.inference.requests[0]?.headers.authorization).toBe(
        `Bearer ${f.inferenceCredential}`
      );
      const records = (await readFile(probe, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const start = records.find((record) => record.type === 'session_start');
      expect(start).toMatchObject({ confirm: false });
      if (!start) throw new Error('session start was not recorded');
      const startEnv = start.env as Record<string, string>;
      const startModel = start.model as { id?: string };
      expect(startEnv.BROWSER_TEST_PATH).toBe('/opt/browser/chrome');
      expect(startModel.id).toBe('logical-a');
      expect(records.find((record) => record.type === 'permission')).toEqual({
        choice: null,
        type: 'permission',
      });
      expect(session.unsupportedUiMethods).toEqual(
        expect.arrayContaining(['confirm', 'setWidget', 'select'])
      );
      expect(session.unsupportedUiMethods).not.toContain('allow');
      const ready = await session.nativeHandle();
      if (ready.state !== 'ready') throw new Error('handle was not ready');
      const { path } = JSON.parse(handleText(ready.reference)) as { path: string };
      const planted = new Set([join(agentDir, 'auth.json'), join(agentDir, 'models.json')]);
      const files = (await readdir(agentDir, { recursive: true, withFileTypes: true })).filter(
        (entry) => entry.isFile()
      );
      const carried = [
        JSON.stringify(start.argv),
        JSON.stringify(start.env),
        JSON.stringify(start.model),
        body,
        await readFile(path, 'utf8'),
      ];
      for (const surface of carried) {
        expect(surface).not.toContain(f.inferenceCredential);
        expect(surface).not.toContain(f.capabilityCredential);
        expect(surface).not.toContain('--api-key');
        expect(surface).not.toContain('stale-retained-key');
        expect(surface).not.toContain('stale-models-key');
      }
      for (const entry of files) {
        const filePath = join(entry.parentPath, entry.name);
        const text = await readFile(filePath, 'utf8');
        expect(text).not.toContain(f.inferenceCredential);
        expect(text).not.toContain(f.capabilityCredential);
        expect(text).not.toContain('--api-key');
        if (planted.has(filePath)) continue;
        expect(text).not.toContain('stale-retained-key');
        expect(text).not.toContain('stale-models-key');
      }
      await expect(readFile(join(f.dirs.workingDirectory, 'pwned'))).rejects.toThrow();
      await session.close();
    },
    TIMEOUT
  );

  it(
    'refuses a changed MCP supply without fencing and resumes it on a successor host',
    async () => {
      const f = await fixture(
        (_request, n) => ({ text: `answer-${n}` }),
        ['openkit-work', 'openkit-extra']
      );
      f.capability.bound = true;
      const session = await f.open();
      const first = await (
        await session.startTurn(turnInput(f.dirs, { prompt: 'first', turnId: 'turn-1' }))
      ).settled;
      expect(first.status).toBe('completed');
      expect(toolNames(f.inference.requests[0]!)).toContain('mcp__openkit-work__echo');
      expect(toolNames(f.inference.requests[0]!)).not.toContain('mcp__openkit-extra__echo');
      const requests = f.inference.requests.length;
      await expect(
        session.startTurn(
          turnInput(f.dirs, { mcpServerIds: ['openkit-extra'], prompt: 'switch', turnId: 'turn-2' })
        )
      ).rejects.toThrow('Pi MCP supply changed; a successor host must resume the session.');
      await expect(
        session.startTurn(
          turnInput(f.dirs, { mcpServerIds: ['openkit-extra'], prompt: 'switch', turnId: 'turn-3' })
        )
      ).rejects.toThrow('Pi MCP supply changed; a successor host must resume the session.');
      expect(f.inference.requests).toHaveLength(requests);
      const ready = await session.nativeHandle();
      expect(ready.state).toBe('ready');
      await session.close();
      if (ready.state !== 'ready') throw new Error('handle was not ready');
      const successor = await f.open(ready.reference);
      const second = await (
        await successor.startTurn(
          turnInput(f.dirs, {
            mcpServerIds: ['openkit-extra'],
            prompt: 'second',
            turnId: 'turn-4',
          })
        )
      ).settled;
      expect(second.status).toBe('completed');
      const names = toolNames(f.inference.requests.at(-1)!);
      expect(names).toContain('mcp__openkit-extra__echo');
      expect(names).not.toContain('mcp__openkit-work__echo');
      expect(requestTexts(f.inference.requests.at(-1)!).join('\n')).toContain('answer-1');
      await successor.close();
    },
    TIMEOUT
  );

  it(
    'records compaction ids and rejects provider failures without ending the host',
    async () => {
      let requests = 0;
      let mode: 'ok' | 'length' | 'status' | 'tool' | 'empty' | 'recovered' = 'ok';
      let toolSent = false;
      const f = await fixture(() => {
        requests += 1;
        if (mode === 'length') return { finish: 'length' as const, text: 'truncated' };
        if (mode === 'status') return { status: 500 };
        if (mode === 'tool') {
          if (!toolSent) {
            toolSent = true;
            return { toolCall: { arguments: { text: 'x' }, name: 'mcp__openkit-work__echo' } };
          }
          return { finish: 'length' as const, text: 'partial' };
        }
        if (mode === 'empty') return { text: '   ' };
        if (mode === 'recovered') return { text: 'recovered' };
        return requests === 1
          ? { promptTokens: 31_000, text: 'answer-1' }
          : { text: `answer-${requests}` };
      });
      const agentDir = piAgentDirectory(f.dirs.stateRoot);
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({ compaction: { keepRecentTokens: 1 } })
      );
      f.capability.bound = true;
      const session = await f.open();
      const first = await (
        await session.startTurn(turnInput(f.dirs, { prompt: 'fill the context', turnId: 'turn-1' }))
      ).settled;
      expect(first).toMatchObject({ assistantText: 'answer-1', status: 'completed' });
      expect(session.lastCompactionEntryIds).toHaveLength(1);
      const ready = await session.nativeHandle();
      if (ready.state !== 'ready') throw new Error('handle was not ready');
      const { path } = JSON.parse(handleText(ready.reference)) as { path: string };
      const entries = (await readFile(path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: string; type: string });
      expect(
        entries.filter((entry) => entry.type === 'compaction').map((entry) => entry.id)
      ).toEqual(session.lastCompactionEntryIds);
      const second = await (
        await session.startTurn(turnInput(f.dirs, { prompt: 'after pressure', turnId: 'turn-2' }))
      ).settled;
      expect(second).toMatchObject({ status: 'completed', stopReason: 'stop' });
      expect(session.lastCompactionEntryIds).toEqual([]);
      const compactionIds = entries
        .filter((entry) => entry.type === 'compaction')
        .map((entry) => entry.id);
      await session.close();
      const successor = await f.open(ready.reference);
      const resumed = await (
        await successor.startTurn(
          turnInput(f.dirs, { prompt: 'after close', turnId: 'turn-resume' })
        )
      ).settled;
      expect(resumed).toMatchObject({ status: 'completed', stopReason: 'stop' });
      const resumedRequest = requestTexts(f.inference.requests.at(-1)!).join('\n');
      expect(
        ['answer-1', 'answer-2', 'after pressure', 'fill the context'].some((part) =>
          resumedRequest.includes(part)
        )
      ).toBe(true);
      expect(resumedRequest.split('fill the context').length - 1).toBeLessThanOrEqual(1);
      expect(await successor.nativeHandle()).toEqual(ready);
      const retained = (await readFile(path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: string; type: string });
      const retainedIds = retained
        .filter((entry) => entry.type === 'compaction')
        .map((entry) => entry.id);
      expect(compactionIds).toHaveLength(1);
      expect(retainedIds.filter((id) => id === compactionIds[0])).toEqual(compactionIds);
      const failures = [
        ['turn-3', 'length', 'pi-terminal-correlation-failed'],
        ['turn-4', 'status', 'pi-terminal-correlation-failed'],
        ['turn-5', 'tool', 'pi-terminal-correlation-failed'],
        ['turn-6', 'empty', 'pi-final-message-empty'],
      ] as const;
      for (const [turnId, nextMode, reason] of failures) {
        mode = nextMode;
        const failed = await (
          await successor.startTurn(turnInput(f.dirs, { prompt: turnId, turnId }))
        ).settled;
        expect(failed.status).toBe('failed');
        expect(failed.assistantText).toBeNull();
        expect(failed.stopReason).toBe(reason);
        expect(successor.childState()).toBe('running');
      }
      mode = 'recovered';
      expect(
        (
          await (
            await successor.startTurn(turnInput(f.dirs, { prompt: 'back', turnId: 'turn-7' }))
          ).settled
        ).status
      ).toBe('completed');
      await successor.close();
    },
    TIMEOUT
  );

  it(
    'bounds diagnostics, refuses direct routes before open, and fences a tampered session',
    async () => {
      const f = await fixture(() => ({ text: 'answer-1' }));
      const session = await f.open();
      const input = turnInput(f.dirs, { prompt: 'work', turnId: 'turn-1' });
      await expect(
        session.startTurn({
          ...input,
          llmRoute: {
            ...input.llmRoute,
            endpoint: { kind: 'openai-compatible', upstream: { kind: 'direct-provider' } },
          },
        })
      ).rejects.toThrow('Pi direct-provider routes are refused.');
      await expect(
        session.startTurn({
          ...input,
          llmRoute: { ...input.llmRoute, credentialVisibility: 'environment' },
        })
      ).rejects.toThrow('Pi environment credentials are refused.');
      await expect(
        session.startTurn({
          ...input,
          llmRoute: { ...input.llmRoute, modelParameters: undefined },
        })
      ).rejects.toThrow('Pi model parameters are missing.');
      await expect(
        session.startTurn({
          ...input,
          llmRoute: {
            ...input.llmRoute,
            endpoint: {
              kind: 'openai-compatible',
              upstream: { kind: 'nanocore-gateway' },
              workerBaseUrl: 'http://127.0.0.1:9/inference/v1',
            },
          },
        })
      ).rejects.toThrow('Pi worker base URL does not match the inference loopback.');
      expect(f.inference.requests).toHaveLength(0);
      f.capability.bound = true;
      expect((await (await session.startTurn(input)).settled).status).toBe('completed');
      const ready = await session.nativeHandle();
      if (ready.state !== 'ready') throw new Error('handle was not ready');
      const { path } = JSON.parse(handleText(ready.reference)) as { path: string };
      const text = await readFile(path, 'utf8');
      const [header, ...rest] = text.split('\n');
      await writeFile(
        path,
        [JSON.stringify({ ...JSON.parse(header!), id: 'replaced' }), ...rest].join('\n')
      );
      expect((await session.nativeHandle()).state).toBe('unknown');
      expect(await readFile(path, 'utf8')).toContain('"id":"replaced"');
      await expect(
        session.startTurn(turnInput(f.dirs, { prompt: 'more', turnId: 'turn-2' }))
      ).rejects.toThrow('Pi conversation is not reusable until a completed first Turn.');
      expect(f.inference.requests).toHaveLength(1);
      await session.close();
      expect(await readFile(path, 'utf8')).toContain('"id":"replaced"');

      const noisy = await fixture(() => ({ status: 500 }));
      const bound = await noisy.open();
      const packageRoot = join(noisy.dirs.root, 'noise-package');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'noise-package',
          pi: { extensions: ['./extension.js'] },
          type: 'module',
          version: '1.0.0',
        })
      );
      await writeFile(
        join(packageRoot, 'extension.js'),
        `console.error('BOUND-MARK-${'E'.repeat(20_000)}');\nconsole.log('BOUND-MARK-${'S'.repeat(20_000)}');\nexport default function () {}\n`
      );
      await writeFile(
        join(piAgentDirectory(noisy.dirs.stateRoot), 'settings.json'),
        JSON.stringify({ packages: [packageRoot] })
      );
      noisy.capability.bound = true;
      const failed = await (
        await bound.startTurn(turnInput(noisy.dirs, { prompt: 'fail', turnId: 'turn-1' }))
      ).settled;
      expect(failed.status).toBe('failed');
      expect(failed.diagnostics?.stderr.startsWith('BOUND-MARK-')).toBe(true);
      expect(failed.diagnostics?.stdout.startsWith('BOUND-MARK-')).toBe(true);
      expect(Buffer.byteLength(failed.diagnostics?.stderr ?? '', 'utf8')).toBeLessThanOrEqual(
        16_384
      );
      expect(Buffer.byteLength(failed.diagnostics?.stdout ?? '', 'utf8')).toBeLessThanOrEqual(
        16_384
      );
      expect(JSON.stringify(failed.diagnostics)).not.toContain(noisy.inferenceCredential);
      expect(JSON.stringify(failed.diagnostics)).not.toContain(noisy.capabilityCredential);
      await expect(
        bound.startTurn(turnInput(noisy.dirs, { prompt: 'again', turnId: 'turn-2' }))
      ).rejects.toThrow('Pi conversation is not reusable until a completed first Turn.');
    },
    TIMEOUT
  );
});
