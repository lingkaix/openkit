// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostResponse } from './channel.ts';
import { PI_PROVIDER_ALIAS } from './host.ts';
import {
  type SyntheticCapability,
  type SyntheticCapabilityOptions,
  startSyntheticCapability,
} from './test-support/capability.ts';
import {
  createHostDirectories,
  type HostDirectories,
  HostProcess,
  mintLoopbackCredential,
  modelDescriptor,
} from './test-support/host-process.ts';
import {
  type CapturedInference,
  type InferenceReply,
  requestTexts,
  type SyntheticInference,
  startSyntheticInference,
} from './test-support/inference.ts';

const TIMEOUT = 60_000;
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  readonly capability: SyntheticCapability;
  readonly capabilityCredential: string;
  readonly directories: HostDirectories;
  readonly inference: SyntheticInference;
  readonly inferenceCredential: string;
  start(env?: NodeJS.ProcessEnv): HostProcess;
  open(host: HostProcess, overrides?: Record<string, unknown>): Promise<HostResponse>;
}

/** Starts synthetic inference and capability endpoints and fresh binding directories. */
async function fixture(
  reply: (n: number, request: CapturedInference) => InferenceReply
): Promise<Fixture> {
  const directories = await createHostDirectories();
  const inferenceCredential = mintLoopbackCredential();
  const capabilityCredential = mintLoopbackCredential();
  const inference = await startSyntheticInference((request, n) => reply(n, request));
  const capability = await startSyntheticCapability(capabilityCredential, ['openkit-work']);
  cleanups.push(
    () => inference.close(),
    () => capability.close()
  );
  return {
    capability,
    capabilityCredential,
    directories,
    inference,
    inferenceCredential,
    open: (host, overrides = {}) =>
      host.request({
        agentDir: directories.agentDir,
        capabilityBaseUrl: capability.base,
        capabilityCredential,
        inferenceBaseUrl: inference.url,
        inferenceCredential,
        mcpServers: ['openkit-work'],
        model: modelDescriptor('logical-a'),
        op: 'open',
        skillTargetPaths: [],
        resume: null,
        stateRoot: directories.stateRoot,
        workingDirectory: directories.workingDirectory,
        ...overrides,
      }),
    start: (env = {}) => {
      const host = HostProcess.start({
        HOME: directories.home,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        ...env,
      });
      cleanups.push(() => host.kill());
      return host;
    },
  };
}

/** Writes a user package with an Extension, a Skill, and a prompt template, and selects it. */
async function installUserPackage(directories: HostDirectories): Promise<string> {
  const packageRoot = join(directories.root, 'user-package');
  const probe = join(directories.root, 'extension-probe.jsonl');
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
console.error('extension noise on stderr');
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    record({
      argv: process.argv,
      confirm: await ctx.ui.confirm('Allow?', 'native permission'),
      env: process.env,
      hasUI: ctx.hasUI,
      model: ctx.model,
      type: 'session_start',
    });
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
  await writeFile(
    join(directories.agentDir, 'settings.json'),
    JSON.stringify({ packages: [packageRoot] })
  );
  return probe;
}

async function readProbe(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readyHandle(response: HostResponse): { digest: string; handle: string } {
  if (!response.ok) throw new Error(`host refused: ${response.error.message}`);
  const nativeHandle = response.result.nativeHandle as {
    digest: string;
    handle: string;
    state: string;
  };
  expect(nativeHandle.state).toBe('ready');
  return nativeHandle;
}

async function turn(host: HostProcess, turnId: string, prompt: string) {
  const response = await host.request({ op: 'turn', prompt, turnId });
  expect(response).toMatchObject({ ok: true, result: { state: 'started' } });
  return host.settled(turnId);
}

/** Whether Pi has created the session file for this binding. Setup entries alone leave it absent. */
async function sessionFileExists(stateRoot: string): Promise<boolean> {
  let sessions: string[];
  try {
    sessions = await readdir(join(stateRoot, 'sessions'));
  } catch {
    return false;
  }
  return sessions.some((name) => existsSync(join(stateRoot, 'sessions', name, 'session.jsonl')));
}

/** Polls until a condition holds, failing after a bound. */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Starts a bound plane for the fixture credential and admits it through `capabilityBaseUrl`. */
async function admittedPlane(
  f: Fixture,
  options: SyntheticCapabilityOptions
): Promise<SyntheticCapability> {
  const plane = await startSyntheticCapability(f.capabilityCredential, ['openkit-work'], options);
  plane.bound = true;
  cleanups.push(() => plane.close());
  return plane;
}

/** Installs one package whose only resource is the given Extension source. */
async function installExtension(
  directories: HostDirectories,
  source: string,
  settings: Record<string, unknown> = {}
): Promise<void> {
  const packageRoot = join(directories.root, 'extension-package');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'extension-package',
      pi: { extensions: ['./extension.js'] },
      type: 'module',
      version: '1.0.0',
    })
  );
  await writeFile(join(packageRoot, 'extension.js'), source);
  await writeFile(
    join(directories.agentDir, 'settings.json'),
    JSON.stringify({ ...settings, packages: [packageRoot] })
  );
}

/** Reads the lines an Extension probe file holds so far. */
function probeLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Rewrites the session id in the header of the file a ready handle names. */
async function tamperHeader(nativeHandle: { state: string }): Promise<void> {
  const { path } = JSON.parse((nativeHandle as { handle: string }).handle) as { path: string };
  const [header, ...rest] = (await readFile(path, 'utf8')).split('\n');
  await writeFile(
    path,
    [JSON.stringify({ ...JSON.parse(header!), id: 'replaced' }), ...rest].join('\n')
  );
}

/** Replies with one tool call on odd requests and with text on even ones. */
const toolThenText = (n: number): InferenceReply =>
  n % 2 === 1
    ? { toolCall: { arguments: { text: `call-${n}` }, name: 'mcp__openkit_work__echo' } }
    : { text: `answer-${n}` };

describe('Pi runtime host', () => {
  it(
    'runs two Turns on one conversation and connects OpenKit MCP once, after the first Turn is bound',
    async () => {
      const f = await fixture(toolThenText);
      const host = f.start();
      const opened = await f.open(host);
      expect(opened).toEqual({ id: 1, ok: true, result: { nativeHandle: { state: 'pending' } } });
      expect(f.capability.log).toEqual([]);

      f.capability.bound = true;
      const first = await turn(host, 'turn-1', 'first prompt');
      expect(first.outcome).toEqual({ assistantText: 'answer-2', status: 'completed' });
      expect(first.nativeHandle.state).toBe('ready');
      const ready = first.nativeHandle as { digest: string; handle: string };
      expect(ready.digest).toBe(createHash('sha256').update(ready.handle, 'utf8').digest('hex'));
      const handle = JSON.parse(ready.handle) as { cwd: string; path: string; sessionId: string };
      expect(handle.cwd).toBe(f.directories.workingDirectory);
      expect(handle.path.startsWith(join(f.directories.stateRoot, 'sessions', 'binding-'))).toBe(
        true
      );

      const toolNames = f.inference.requests[0]?.body.tools?.map((tool) => tool.function.name);
      expect(toolNames).toContain('mcp__openkit_work__echo');
      expect(f.capability.log.every((entry) => entry.accepted)).toBe(true);
      // Probe results the shim adapter and manifest rely on: the pinned client negotiates the
      // 2025-11-25 era and opens one standalone GET stream beside its POST requests.
      expect(f.capability.log.find((entry) => entry.method === 'initialize')?.params).toMatchObject(
        {
          protocolVersion: '2025-11-25',
        }
      );
      expect(f.capability.log.some((entry) => entry.httpMethod === 'GET')).toBe(true);
      expect(
        f.capability.log.every(
          (entry) => entry.headers.authorization === `Bearer ${f.capabilityCredential}`
        )
      ).toBe(true);

      // Turn barrier: the plane cuts open streams and refuses everything until the next Turn.
      f.capability.bound = false;
      f.capability.cutStreams();
      await new Promise((resolve) => setTimeout(resolve, 500));
      f.capability.bound = true;

      const second = await turn(host, 'turn-2', 'second prompt');
      expect(second.outcome).toEqual({ assistantText: 'answer-4', status: 'completed' });
      expect(second.nativeHandle).toEqual(first.nativeHandle);
      const calls = f.capability.log.filter((entry) => entry.method === 'tools/call');
      expect(calls.map((entry) => [entry.accepted, entry.params?.arguments])).toEqual([
        [true, { text: 'call-1' }],
        [true, { text: 'call-3' }],
      ]);
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(f.capability.log.filter((entry) => entry.method === 'tools/list')).toHaveLength(1);

      const secondRequest = f.inference.requests[2];
      if (!secondRequest) throw new Error('second Turn made no provider request');
      const texts = requestTexts(secondRequest).join('\n');
      expect(texts).toContain('first prompt');
      expect(texts).toContain('answer-2');
      expect(texts).toContain('second prompt');
      expect(secondRequest.body.model).toBe('logical-a');
      expect(secondRequest.headers.authorization).toBe(`Bearer ${f.inferenceCredential}`);
    },
    TIMEOUT
  );

  it(
    'resumes the exact session file in a successor host and closes without touching retained bytes',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      f.capability.bound = true;
      const first = f.start();
      await f.open(first);
      const settled = await turn(first, 'turn-1', 'remember the word cobalt');
      expect(settled.outcome.status).toBe('completed');
      const retained = join(f.directories.stateRoot, 'memory', 'notes.md');
      await mkdir(join(f.directories.stateRoot, 'memory'));
      await writeFile(retained, 'retained user bytes');
      const closed = await first.request({ op: 'close' });
      expect(closed).toMatchObject({
        ok: true,
        result: { nativeHandle: settled.nativeHandle, state: 'closed' },
      });
      expect(await first.exited).toBe(0);

      const { handle, digest } = settled.nativeHandle as { digest: string; handle: string };
      const { path } = JSON.parse(handle) as { path: string };
      const sessionBytes = await readFile(path);
      expect(await readFile(retained, 'utf8')).toBe('retained user bytes');

      const successor = f.start();
      const reopened = await f.open(successor, { resume: { handle } });
      expect(readyHandle(reopened)).toEqual({ digest, handle, state: 'ready' });
      const resumed = await turn(successor, 'turn-2', 'what was the word?');
      expect(resumed.outcome).toEqual({ assistantText: 'answer-2', status: 'completed' });
      expect(resumed.nativeHandle).toEqual(settled.nativeHandle);
      const texts = requestTexts(f.inference.requests[1]!).join('\n');
      expect(texts).toContain('remember the word cobalt');
      expect(texts).toContain('answer-1');
      const grown = await readFile(path);
      expect(grown.subarray(0, sessionBytes.length).equals(sessionBytes)).toBe(true);
      expect(grown.length).toBeGreaterThan(sessionBytes.length);
      expect(await readdir(join(f.directories.stateRoot, 'sessions'))).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    'fails identity preflight before any work when the retained reference does not match',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      f.capability.bound = true;
      const first = f.start();
      await f.open(first);
      const settled = await turn(first, 'turn-1', 'hello');
      await first.request({ op: 'close' });
      const { handle } = settled.nativeHandle as { handle: string };
      const parsed = JSON.parse(handle) as { cwd: string; path: string; sessionId: string };
      const encode = (value: typeof parsed) =>
        JSON.stringify({ cwd: value.cwd, path: value.path, sessionId: value.sessionId });
      const cases = [
        encode({ ...parsed, sessionId: 'another-session' }),
        encode({ ...parsed, cwd: f.directories.root }),
        encode({
          ...parsed,
          path: join(f.directories.stateRoot, 'sessions', 'absent', 'session.jsonl'),
        }),
        encode({ ...parsed, path: join(f.directories.root, 'outside.jsonl') }),
        JSON.stringify({ sessionId: parsed.sessionId, cwd: parsed.cwd, path: parsed.path }),
      ];
      const before = f.inference.requests.length;
      for (const candidate of cases) {
        const host = f.start();
        const response = await f.open(host, { resume: { handle: candidate } });
        expect(response).toMatchObject({ ok: false, error: { code: 'identity_failed' } });
        const refused = await host.request({ op: 'turn', prompt: 'work', turnId: 'refused' });
        expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
        host.kill();
      }
      expect(f.inference.requests.length).toBe(before);
    },
    TIMEOUT
  );

  it(
    'changes the admitted model across Turns on the same conversation',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'first');
      const configured = await host.request({
        model: modelDescriptor('logical-b', { contextWindow: 64_000 }),
        op: 'configure',
      });
      expect(configured).toMatchObject({ ok: true });
      const second = await turn(host, 'turn-2', 'second');
      expect(second.outcome).toEqual({ assistantText: 'answer-2', status: 'completed' });
      expect(second.nativeHandle).toEqual(first.nativeHandle);
      expect(f.inference.requests.map((request) => request.body.model)).toEqual([
        'logical-a',
        'logical-b',
      ]);
      expect(requestTexts(f.inference.requests[1]!).join('\n')).toContain('answer-1');
    },
    TIMEOUT
  );

  it(
    'interrupts an established conversation, reports the actual outcome, and keeps the session',
    async () => {
      const f = await fixture((n) => (n === 2 ? { hang: true } : { text: `answer-${n}` }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'establish');
      expect(first.outcome.status).toBe('completed');
      expect(
        await host.request({ op: 'turn', prompt: 'long work', turnId: 'turn-2' })
      ).toMatchObject({ ok: true, result: { state: 'started' } });
      await waitFor(() => f.inference.requests.length === 2);
      expect(await host.request({ op: 'turn', prompt: 'overlap', turnId: 'turn-x' })).toMatchObject(
        { error: { code: 'busy' }, ok: false }
      );
      expect(
        await host.request({ model: modelDescriptor('logical-b'), op: 'configure' })
      ).toMatchObject({ error: { code: 'busy' }, ok: false });
      const interrupted = await host.request({ op: 'interrupt', turnId: 'turn-2' });
      expect(interrupted).toMatchObject({ ok: true, result: { outcome: 'interrupted' } });
      const settled = await host.settled('turn-2');
      expect(settled.outcome).toEqual({ reason: 'worker-interrupted', status: 'interrupted' });
      expect(settled.nativeHandle).toEqual(first.nativeHandle);
      expect(await host.request({ op: 'interrupt', turnId: 'turn-2' })).toMatchObject({
        result: { outcome: 'not_active' },
      });
      const next = await turn(host, 'turn-3', 'continue');
      expect(next.outcome).toEqual({ assistantText: 'answer-3', status: 'completed' });
      expect(requestTexts(f.inference.requests[2]!).join('\n')).toContain('long work');
    },
    TIMEOUT
  );

  it(
    'rejects failed provider outcomes of an established conversation without closing it',
    async () => {
      const replies: InferenceReply[] = [
        { text: 'established' },
        { finish: 'length', text: 'truncated' },
        { status: 400 },
        { text: ['  one', ' two  '] },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'late' });
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'a');
      expect(first.outcome.status).toBe('completed');
      for (const turnId of ['turn-2', 'turn-3']) {
        const failed = await turn(host, turnId, 'b');
        expect(failed.outcome).toMatchObject({ status: turnId === 'turn-2' ? 'length' : 'failed' });
        expect(failed.nativeHandle).toEqual(first.nativeHandle);
      }
      expect((await turn(host, 'turn-4', 'c')).outcome).toEqual({
        assistantText: 'one two',
        status: 'completed',
      });
    },
    TIMEOUT
  );

  it(
    'grants no ready authority when the first Turn reaches length and fences the binding for close',
    async () => {
      const f = await fixture(() => ({ finish: 'length', text: 'truncated' }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toMatchObject({ status: 'length', reason: 'pi-length' });
      expect(await sessionFileExists(f.directories.stateRoot)).toBe(true);
      expect(settled.nativeHandle).toEqual({ state: 'unknown' });
      expect(await host.request({ op: 'inspect' })).toEqual({
        id: 3,
        ok: true,
        result: { nativeHandle: settled.nativeHandle, state: 'failed', turnId: null },
      });
      expect(await host.request({ op: 'turn', prompt: 'again', turnId: 'turn-2' })).toMatchObject({
        error: { code: 'invalid_state' },
        ok: false,
      });
      expect(
        await host.request({ model: modelDescriptor('logical-b'), op: 'configure' })
      ).toMatchObject({ error: { code: 'invalid_state' }, ok: false });
      const closed = await host.request({ op: 'close' });
      expect(closed).toMatchObject({ ok: true, result: { state: 'closed' } });
      expect(
        (closed as { result: { nativeHandle: { state: string } } }).result.nativeHandle
      ).toEqual({ state: 'unknown' });
      expect(await sessionFileExists(f.directories.stateRoot)).toBe(true);
      expect(await host.exited).toBe(0);
      expect(f.inference.requests).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    'grants no ready authority when the provider fails before any assistant message',
    async () => {
      const f = await fixture(() => ({ status: 400 }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toMatchObject({ status: 'failed' });
      expect(f.inference.requests).toHaveLength(1);
      expect(
        f.inference.requests.every((request) =>
          request.body.messages.every((message) => message.role !== 'assistant')
        )
      ).toBe(true);
      expect(await sessionFileExists(f.directories.stateRoot)).toBe(true);
      expect(settled.nativeHandle).toEqual({ state: 'unknown' });
      const closed = await host.request({ op: 'close' });
      expect(closed).toMatchObject({ ok: true, result: { state: 'closed' } });
      expect(
        (closed as { result: { nativeHandle: { state: string } } }).result.nativeHandle
      ).toEqual({ state: 'unknown' });
      expect(await host.exited).toBe(0);
    },
    TIMEOUT
  );

  it(
    'grants no ready authority when the first Turn is interrupted',
    async () => {
      const f = await fixture(() => ({ hang: true }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      await host.request({ op: 'turn', prompt: 'first', turnId: 'turn-1' });
      await waitFor(() => f.inference.requests.length === 1);
      expect(await host.request({ op: 'interrupt', turnId: 'turn-1' })).toMatchObject({
        ok: true,
        result: { outcome: 'interrupted' },
      });
      const settled = await host.settled('turn-1');
      expect(settled.outcome.status).toBe('interrupted');
      // Pi 0.99 creates the session file when the user message is persisted, before the assistant
      // reply. The file then exists without a completed first Turn, so the handle is unknown.
      expect(await sessionFileExists(f.directories.stateRoot)).toBe(true);
      expect(settled.nativeHandle).toEqual({ state: 'unknown' });
      expect(await host.request({ op: 'turn', prompt: 'again', turnId: 'turn-2' })).toMatchObject({
        error: { code: 'invalid_state' },
        ok: false,
      });
      const inspected = await host.request({ op: 'inspect' });
      expect(inspected).toMatchObject({ ok: true, result: { state: 'failed' } });
      expect(f.inference.requests).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    'loads user packages, Extensions, Skills, and prompt templates with headless confirmation and free-input answers',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { arguments: { command: 'touch pwned' }, name: 'bash' } },
        { text: 'blocked as expected' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'late' });
      const probe = await installUserPackage(f.directories);
      f.capability.bound = true;
      const host = f.start({ BROWSER_TEST_PATH: '/opt/browser/chrome' });
      await f.open(host);
      const settled = await turn(host, 'turn-1', '/hello world');
      expect(settled.outcome).toEqual({
        assistantText: 'blocked as expected',
        status: 'completed',
      });

      const request = f.inference.requests[0]!;
      const texts = requestTexts(request).join('\n');
      expect(texts).toContain('Template says hello to world.');
      expect(texts).toContain('Greets people in the synthetic fixture.');
      await expect(readFile(join(f.directories.workingDirectory, 'pwned'))).rejects.toThrow();

      const records = await readProbe(probe);
      const start = records.find((record) => record.type === 'session_start');
      expect(start).toMatchObject({ confirm: true, hasUI: true });
      expect((start?.env as Record<string, string> | undefined)?.BROWSER_TEST_PATH).toBe(
        '/opt/browser/chrome'
      );
      expect(records.find((record) => record.type === 'permission')).toEqual({
        choice: null,
        type: 'permission',
      });
      const unsupported = host.events.filter((event) => event.event === 'ui_unsupported');
      expect(unsupported).toEqual([
        { event: 'ui_unsupported', method: 'confirm', turnId: 'turn-1' },
        { event: 'ui_unsupported', method: 'setWidget', turnId: 'turn-1' },
        { event: 'ui_unsupported', method: 'select', turnId: 'turn-1' },
      ]);
      expect(host.stdout).toContain('"noise":"stdout"');
      expect(host.orphanResponses).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "serves a user's agent-directory MCP server beside the OpenKit connection",
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { arguments: { text: 'local' }, name: 'mcp__local_tools__echo' } },
        { toolCall: { arguments: { text: 'granted' }, name: 'mcp__openkit_work__echo' } },
        { text: 'both served' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'late' });
      const local = await startSyntheticCapability(null, ['local-tools']);
      local.bound = true;
      cleanups.push(() => local.close());
      // Direct exposure declares the user's tool before any native search.
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'local-tools': { exposure: 'direct', url: `${local.base}/mcp/local-tools` },
          },
        })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'use both');
      expect(settled.outcome).toEqual({ assistantText: 'both served', status: 'completed' });
      expect(f.inference.requests[0]?.body.tools?.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(['mcp__local_tools__echo', 'mcp__openkit_work__echo'])
      );
      expect(
        local.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'local' }]);
      expect(local.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(local.log.some((entry) => entry.headers.authorization !== undefined)).toBe(false);
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(
        f.capability.log.every(
          (entry) => entry.headers.authorization === `Bearer ${f.capabilityCredential}`
        )
      ).toBe(true);
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'granted' }]);
      expect(requestTexts(f.inference.requests[1]!).join('\n')).toContain('echo:local');
      expect(await readFile(join(f.directories.agentDir, 'mcp.json'), 'utf8')).not.toContain(
        f.capabilityCredential
      );
    },
    TIMEOUT
  );

  it(
    'overlays a disabled native MCP entry with the managed Gateway transport',
    async () => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'overlay' } } }
          : { text: 'managed route' }
      );
      const local = await startSyntheticCapability(null, ['openkit-work']);
      local.bound = true;
      cleanups.push(() => local.close());
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'openkit-work': { enabled: false, url: `${local.base}/mcp/openkit-work` },
          },
        })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'managed route', status: 'completed' });
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'overlay' }]);
      expect(host.stderr).toContain('OpenKit overlay');
      expect(settled.nativeHandle.state).toBe('ready');
      expect(f.inference.requests).toHaveLength(2);
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(local.log).toEqual([]);
      expect(await sessionFileExists(f.directories.stateRoot)).toBe(true);
    },
    TIMEOUT
  );

  it(
    'fails setup for an OpenKit server id Pi cannot register, without prompting',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host, { mcpServers: ['openkit.work'] });
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ reason: 'pi-setup-failed', status: 'failed' });
      expect(settled.nativeHandle).toEqual({ state: 'pending' });
      expect(f.inference.requests).toEqual([]);
      expect(f.capability.log).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'ignores an agent mcp.json entry Pi would skip and still connects the registration',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'openkit-work': { url: 'not a url' } } })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'answer-1', status: 'completed' });
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(f.capability.log.some((entry) => entry.method === 'tools/list')).toBe(true);
      expect(
        f.capability.log.every(
          (entry) => entry.headers.authorization === `Bearer ${f.capabilityCredential}`
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'fails setup when an OpenKit server does not connect, before any prompt',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ reason: 'pi-setup-failed', status: 'failed' });
      expect(settled.nativeHandle).toEqual({ state: 'pending' });
      expect(f.inference.requests).toEqual([]);
      expect(await sessionFileExists(f.directories.stateRoot)).toBe(false);
      expect(await host.request({ op: 'turn', prompt: 'again', turnId: 'turn-2' })).toMatchObject({
        error: { code: 'invalid_state' },
        ok: false,
      });
    },
    TIMEOUT
  );

  it.each([false, true])(
    'overlays a project MCP collision with the managed Gateway transport (partial override=%s)',
    async (partial) => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'overlay' } } }
          : { text: 'managed route' }
      );
      const local = await startSyntheticCapability(null, ['openkit-work']);
      local.bound = true;
      cleanups.push(() => local.close());
      await mkdir(join(f.directories.workingDirectory, '.pi'), { recursive: true });
      const globalPath = join(f.directories.agentDir, 'mcp.json');
      const globalBytes = JSON.stringify({
        mcpServers: {
          'openkit-work': { exposure: 'hidden', url: `${local.base}/mcp/openkit-work` },
        },
      });
      await writeFile(globalPath, globalBytes);
      const projectPath = join(f.directories.workingDirectory, '.pi', 'mcp.json');
      await writeFile(
        projectPath,
        JSON.stringify({
          mcpServers: {
            'openkit-work': partial
              ? { enabled: false, exposure: 'hidden' }
              : { exposure: 'direct', url: `${local.base}/mcp/openkit-work` },
          },
        })
      );
      const projectBytes = await readFile(projectPath, 'utf8');
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'managed route', status: 'completed' });
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'overlay' }]);
      expect(host.stderr).toContain('OpenKit overlay');
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(f.inference.requests).toHaveLength(2);
      expect(
        f.capability.log.every(
          (entry) => entry.headers.authorization === `Bearer ${f.capabilityCredential}`
        )
      ).toBe(true);
      expect(local.log).toEqual([]);
      expect(await readFile(globalPath, 'utf8')).toBe(globalBytes);
      expect(await readFile(projectPath, 'utf8')).toBe(projectBytes);
    },
    TIMEOUT
  );

  it(
    'overlays a native MCP command replacement with the host MCP owner',
    async () => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'overlay' } } }
          : { text: 'managed route' }
      );
      await installExtension(
        f.directories,
        `export default function (pi) {
  pi.registerCommand('mcp', {
    description: 'Replaces built-in MCP',
    handler: async () => {},
  });
}
`
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'managed route', status: 'completed' });
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'overlay' }]);
      expect(host.stderr).toContain('OpenKit overlay');
      expect(settled.nativeHandle.state).toBe('ready');
      expect(f.inference.requests).toHaveLength(2);
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
    },
    TIMEOUT
  );

  it(
    'overlays an enabled native MCP entry with the managed Gateway transport',
    async () => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'overlay' } } }
          : { text: 'managed route' }
      );
      const local = await startSyntheticCapability(null, ['openkit-work']);
      local.bound = true;
      cleanups.push(() => local.close());
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'openkit-work': {
              enabled: true,
              exposure: 'direct',
              url: `${local.base}/mcp/openkit-work`,
            },
          },
        })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'managed route', status: 'completed' });
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'overlay' }]);
      expect(host.stderr).toContain('OpenKit overlay');
      expect(f.inference.requests).toHaveLength(2);
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(local.log).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'overlays an Extension-authored MCP collision with the managed Gateway transport',
    async () => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'overlay' } } }
          : { text: 'managed route' }
      );
      const local = await startSyntheticCapability(null, ['openkit-work']);
      local.bound = true;
      cleanups.push(() => local.close());
      await installExtension(
        f.directories,
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(f.directories.agentDir, 'mcp.json'))}, JSON.stringify({
  mcpServers: {
    'openkit-work': {
      exposure: 'direct',
      url: ${JSON.stringify(`${local.base}/mcp/openkit-work`)},
    },
  },
}));
export default function () {}
`
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'managed route', status: 'completed' });
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'overlay' }]);
      expect(host.stderr).toContain('OpenKit overlay');
      expect(f.inference.requests).toHaveLength(2);
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(local.log).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'overlays a native createMcpExtension replacement without duplicate Gateway connections',
    async () => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'overlay' } } }
          : { text: 'managed route' }
      );
      const codingAgent = import.meta.resolve('@earendil-works/pi-coding-agent');
      await installExtension(
        f.directories,
        `import { createMcpExtension } from ${JSON.stringify(codingAgent)};
export default createMcpExtension();
`
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'managed route', status: 'completed' });
      expect(
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'overlay' }]);
      expect(host.stderr).toContain('OpenKit overlay');
      expect(settled.nativeHandle.state).toBe('ready');
      expect(f.inference.requests).toHaveLength(2);
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
    },
    TIMEOUT
  );

  it(
    'keeps Extension fetch cancellation, a null signal, and unrelated in-flight work',
    async () => {
      const hits = { aborted: 0, held: 0 };
      let held: ServerResponse | undefined;
      let heldClosed = false;
      const server = createServer((req, res) => {
        if (req.url === '/aborted') {
          hits.aborted += 1;
          res.writeHead(200);
          res.end('aborted-reached');
          return;
        }
        if (req.url === '/null') {
          res.writeHead(200);
          res.end('null-ok');
          return;
        }
        hits.held += 1;
        held = res;
        res.writeHead(200);
        res.on('close', () => {
          heldClosed = true;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      cleanups.push(async () => {
        held?.end('done');
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const f = await fixture(() => ({ text: 'unexpected prompt' }));
      const probe = join(f.directories.root, 'fetch-probe.txt');
      await installExtension(
        f.directories,
        `import { appendFileSync } from 'node:fs';
const probe = ${JSON.stringify(probe)};
const base = ${JSON.stringify(base)};
export default function (pi) {
  pi.on('session_start', async () => {
    const abortedSignal = new AbortController();
    abortedSignal.abort();
    let aborted = 'reached';
    try {
      const response = await fetch(new Request(base + '/aborted', { signal: abortedSignal.signal }));
      aborted = 'status ' + response.status;
    } catch (error) {
      aborted = error && error.name ? error.name : 'error';
    }
    let nulled = 'threw';
    try {
      const response = await fetch(base + '/null', { signal: null });
      nulled = 'status ' + response.status;
    } catch (error) {
      nulled = String(error && error.message ? error.message : error);
    }
    void fetch(base + '/held').then(
      (response) => appendFileSync(probe, 'held-status ' + response.status + '\\n'),
      (error) => appendFileSync(probe, 'held-error ' + (error && error.name) + '\\n')
    );
    appendFileSync(probe, 'aborted ' + aborted + '\\nnull ' + nulled + '\\nheld-started\\n');
  });
}
`
      );
      f.capability.bound = true;
      f.capability.holdInitialize = true;
      const host = f.start();
      await f.open(host);
      await host.request({ op: 'turn', prompt: 'first', turnId: 'turn-1' });
      await waitFor(() => probeLines(probe).some((line) => line.startsWith('null ')));
      const lines = probeLines(probe);
      expect(lines.find((line) => line.startsWith('aborted '))).toBe('aborted AbortError');
      expect(lines.find((line) => line.startsWith('null '))).toBe('null status 200');
      expect(hits.aborted).toBe(0);
      await waitFor(() => hits.held === 1);
      expect(await host.request({ op: 'interrupt', turnId: 'turn-1' })).toMatchObject({
        ok: true,
        result: { outcome: 'interrupted' },
      });
      await waitFor(() => f.capability.cancelledHeld.includes('initialize'), 5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(heldClosed).toBe(false);
      expect(f.inference.requests).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'redacts loopback credentials from native MCP logs and reflected tool results',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { arguments: { text: 'secret' }, name: 'mcp__openkit_work__echo' } },
        { text: 'redacted answer' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'late' });
      const plane = await startSyntheticCapability(f.capabilityCredential, ['openkit-work'], {
        logAuthorization: true,
        reflectAuthorization: true,
      });
      plane.bound = true;
      cleanups.push(() => plane.close());
      const host = f.start();
      await f.open(host, { capabilityBaseUrl: plane.base });
      const settled = await turn(host, 'turn-1', 'reflect');
      expect(settled.outcome).toEqual({ assistantText: 'redacted answer', status: 'completed' });
      const log = await readFile(join(f.directories.agentDir, 'mcp.log'), 'utf8');
      const { path } = JSON.parse((settled.nativeHandle as { handle: string }).handle) as {
        path: string;
      };
      const session = await readFile(path, 'utf8');
      expect(log.includes('[redacted]')).toBe(true);
      expect(session.includes('[redacted]')).toBe(true);
      for (const secret of [f.inferenceCredential, f.capabilityCredential]) {
        expect(log.includes(secret)).toBe(false);
        expect(session.includes(secret)).toBe(false);
      }
    },
    TIMEOUT
  );

  it.each([
    ['log member name', { logAuthorizationKey: true }, false],
    ['HTTP tool error', { rejectToolWithAuthorization: true }, true],
    ['decoded resource', { resourceAuthorization: true }, true],
  ] as const)(
    'keeps credentials out of native %s',
    async (_case, options, callsTool) => {
      const f = await fixture((n) =>
        n === 1 && callsTool
          ? { toolCall: { arguments: { text: 'probe' }, name: 'mcp__openkit_work__echo' } }
          : { text: 'done' }
      );
      const plane = await admittedPlane(f, { logAuthorization: true, ...options });
      const host = f.start();
      await f.open(host, { capabilityBaseUrl: plane.base });
      const settled = await turn(host, 'turn-1', 'probe');
      expect(settled.outcome).toEqual({ assistantText: 'done', status: 'completed' });
      if (callsTool)
        expect(plane.log.filter((entry) => entry.method === 'tools/call')).toHaveLength(1);
      const { path } = JSON.parse((settled.nativeHandle as { handle: string }).handle) as {
        path: string;
      };
      const persisted = [
        await readFile(path, 'utf8'),
        await readFile(join(f.directories.agentDir, 'mcp.log'), 'utf8'),
      ];
      const modelFacing = f.inference.requests.map((request) => JSON.stringify(request.body));
      for (const secret of [f.inferenceCredential, f.capabilityCredential]) {
        expect(persisted.some((content) => content.includes(secret))).toBe(false);
        expect(modelFacing.some((content) => content.includes(secret))).toBe(false);
      }
    },
    TIMEOUT
  );

  it.each([
    ['malformed catalog', { catalog: 'malformed' }],
    ['unfinished initialized notification', { holdInitialized: true }],
    ['unrelated response', { unrelatedListResponse: true }],
  ] as const)(
    'refuses first prompt after %s',
    async (_case, options) => {
      const f = await fixture(() => ({ text: 'unexpected inference' }));
      const plane = await admittedPlane(f, options);
      const host = f.start();
      await f.open(host, { capabilityBaseUrl: plane.base });
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ reason: 'pi-setup-failed', status: 'failed' });
      expect(f.inference.requests).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'lets native MCP recover a transient initialize failure before the first prompt',
    async () => {
      const f = await fixture(() => ({ text: 'recovered' }));
      const plane = await admittedPlane(f, { catalog: 'empty', retryInitialize: true });
      const host = f.start();
      await f.open(host, { capabilityBaseUrl: plane.base });
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'recovered', status: 'completed' });
      expect(plane.log.filter((entry) => entry.method === 'initialize')).toHaveLength(2);
      expect(plane.log.filter((entry) => entry.method === 'tools/list')).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    'prompts after an admitted OpenKit server connects with an empty tool catalog',
    async () => {
      const f = await fixture(() => ({ text: 'answer-1' }));
      const plane = await admittedPlane(f, { catalog: 'empty' });
      const host = f.start();
      await f.open(host, { capabilityBaseUrl: plane.base });
      const started = Date.now();
      const settled = await turn(host, 'turn-1', 'first');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(settled.outcome).toEqual({ assistantText: 'answer-1', status: 'completed' });
      expect(plane.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(plane.log.some((entry) => entry.method === 'tools/list')).toBe(true);
    },
    TIMEOUT
  );

  it(
    'prompts after a paginated OpenKit tool catalog is fully listed',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { arguments: { text: 'paged' }, name: 'mcp__openkit_work__echo' } },
        { text: 'paged answer' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'late' });
      const plane = await admittedPlane(f, { catalog: 'paged' });
      const host = f.start();
      await f.open(host, { capabilityBaseUrl: plane.base });
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toEqual({ assistantText: 'paged answer', status: 'completed' });
      expect(plane.log.filter((entry) => entry.method === 'tools/list')).toHaveLength(2);
      expect(
        plane.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'paged' }]);
    },
    TIMEOUT
  );

  it(
    'does not treat an unrelated tool in the OpenKit namespace as connection readiness',
    async () => {
      const f = await fixture(() => ({ text: 'unexpected prompt' }));
      const typebox = import.meta.resolve('typebox');
      await installExtension(
        f.directories,
        `import Type from ${JSON.stringify(typebox)};
export default function (pi) {
  pi.registerTool({
    name: 'mcp__openkit_work__echo',
    label: 'Decoy',
    description: 'Unrelated tool',
    parameters: Type.Object({ text: Type.String() }),
    namespace: { name: 'mcp__openkit_work' },
    exposure: 'direct',
    async execute() {
      return { content: [{ type: 'text', text: 'decoy' }], details: {} };
    },
  });
}
`
      );
      const host = f.start();
      await f.open(host);
      const started = Date.now();
      const settled = await turn(host, 'turn-1', 'first');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(settled.outcome).toEqual({ reason: 'pi-setup-failed', status: 'failed' });
      expect(f.inference.requests).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'does not let one connected OpenKit server stand in for another admitted server',
    async () => {
      const f = await fixture(() => ({ text: 'unexpected prompt' }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host, { mcpServers: ['openkit-work', 'openkit-extra'] });
      const started = Date.now();
      const settled = await turn(host, 'turn-1', 'first');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(settled.outcome).toEqual({ reason: 'pi-setup-failed', status: 'failed' });
      expect(f.inference.requests).toEqual([]);
      expect(
        f.capability.log.some(
          (entry) => entry.method === 'initialize' && entry.path.endsWith('/openkit-work')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'keeps both loopback credentials out of argv, environment, descriptor, diagnostics, and files',
    async () => {
      const f = await fixture(toolThenText);
      const probe = await installUserPackage(f.directories);
      await writeFile(
        join(f.directories.agentDir, 'auth.json'),
        JSON.stringify({ [PI_PROVIDER_ALIAS]: { key: 'stale-retained-key', type: 'api_key' } })
      );
      await writeFile(
        join(f.directories.agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            [PI_PROVIDER_ALIAS]: {
              api: 'openai-completions',
              apiKey: 'stale-models-key',
              baseUrl: 'http://127.0.0.1:9/v1',
              models: [{ id: 'logical-a' }],
            },
          },
        })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'work');
      expect(settled.outcome.status).toBe('completed');
      await host.request({ op: 'close' });
      await host.exited;

      for (const request of f.inference.requests) {
        expect(request.headers.authorization).toBe(`Bearer ${f.inferenceCredential}`);
      }
      const secrets = [f.inferenceCredential, f.capabilityCredential];
      const start = (await readProbe(probe)).find((record) => record.type === 'session_start');
      const model = start?.model as Record<string, unknown>;
      expect(model).toMatchObject({
        baseUrl: f.inference.url,
        id: 'logical-a',
        provider: PI_PROVIDER_ALIAS,
      });
      const { path } = JSON.parse((settled.nativeHandle as { handle: string }).handle) as {
        path: string;
      };
      const surfaces = [
        JSON.stringify(start?.argv),
        JSON.stringify(start?.env),
        JSON.stringify(model),
        host.stdout,
        host.stderr,
        host.lines.join('\n'),
        await readFile(path, 'utf8'),
        ...(await Promise.all(
          (
            await readdir(f.directories.agentDir, { recursive: true, withFileTypes: true })
          )
            .filter((entry) => entry.isFile())
            .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
        )),
      ];
      for (const surface of surfaces) {
        for (const secret of secrets) expect(surface).not.toContain(secret);
      }
    },
    TIMEOUT
  );

  it(
    'serves a changed supply through a successor that resumes the conversation, never a retained decoy',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      const plane = await startSyntheticCapability(f.capabilityCredential, [
        'openkit-work',
        'openkit-extra',
      ]);
      plane.bound = true;
      cleanups.push(() => plane.close());
      const decoy = join(f.directories.stateRoot, 'sessions', 'decoy', 'session.jsonl');
      await mkdir(join(f.directories.stateRoot, 'sessions', 'decoy'), { recursive: true });
      await writeFile(
        decoy,
        `${JSON.stringify({ cwd: f.directories.workingDirectory, id: 'decoy', timestamp: '2026-01-01T00:00:00.000Z', type: 'session', version: 3 })}\n`
      );
      await writeFile(
        join(f.directories.agentDir, 'prompts-retained.md'),
        'retained prompt must not load'
      );
      const first = f.start();
      await f.open(first, { capabilityBaseUrl: plane.base });
      const settled = await turn(first, 'turn-1', 'first');
      expect(f.inference.requests[0]?.body.tools?.map((tool) => tool.function.name)).toContain(
        'mcp__openkit_work__echo'
      );
      expect(f.inference.requests[0]?.body.tools?.map((tool) => tool.function.name)).not.toContain(
        'mcp__openkit_extra__echo'
      );
      expect(JSON.stringify(f.inference.requests[0]?.body)).not.toContain(
        'retained prompt must not load'
      );
      const handle = (settled.nativeHandle as { handle: string }).handle;
      expect(JSON.parse(handle).path).not.toBe(decoy);
      await first.request({ op: 'close' });

      const resumed = f.start();
      await f.open(resumed, {
        capabilityBaseUrl: plane.base,
        mcpServers: ['openkit-work', 'openkit-extra'],
        resume: { handle },
      });
      const second = await turn(resumed, 'turn-2', 'second');
      expect(second.outcome.status).toBe('completed');
      const tools = f.inference.requests.at(-1)?.body.tools?.map((tool) => tool.function.name);
      expect(tools).toEqual(
        expect.arrayContaining(['mcp__openkit_work__echo', 'mcp__openkit_extra__echo'])
      );
      expect(requestTexts(f.inference.requests.at(-1)!).join('\n')).toContain('answer-1');
    },
    TIMEOUT
  );

  it(
    'inspects the exact session without launching work and fails closed on a changed identity',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      const requests = f.inference.requests.length;
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        ok: true,
        result: { nativeHandle: settled.nativeHandle, state: 'idle', turnId: null },
      });
      expect(f.inference.requests.length).toBe(requests);
      const { path } = JSON.parse((settled.nativeHandle as { handle: string }).handle) as {
        path: string;
      };
      const text = await readFile(path, 'utf8');
      const [header, ...rest] = text.split('\n');
      await writeFile(
        path,
        [JSON.stringify({ ...JSON.parse(header!), id: 'replaced' }), ...rest].join('\n')
      );
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        error: { code: 'identity_failed' },
        ok: false,
      });
      expect(await host.request({ op: 'turn', prompt: 'more', turnId: 'turn-2' })).toMatchObject({
        error: { code: 'invalid_state' },
        ok: false,
      });
      expect(f.inference.requests.length).toBe(requests);
    },
    TIMEOUT
  );

  it(
    'records the compaction identities it observes inside a prompt',
    async () => {
      const f = await fixture((n) =>
        n === 1 ? { promptTokens: 31_000, text: 'answer-1' } : { text: `summary-or-answer-${n}` }
      );
      // A small recent-context budget lets the second prompt find something older to summarize.
      await writeFile(
        join(f.directories.agentDir, 'settings.json'),
        JSON.stringify({ compaction: { keepRecentTokens: 1 } })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      // The first answer reports near-full context, so Pi compacts inside that same prompt.
      const first = await turn(host, 'turn-1', 'fill the context');
      expect(first.outcome).toEqual({ assistantText: 'answer-1', status: 'completed' });
      expect(first.compactionEntryIds).toHaveLength(1);
      const { path } = JSON.parse((first.nativeHandle as { handle: string }).handle) as {
        path: string;
      };
      const entries = (await readFile(path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: string; type: string });
      expect(
        entries.filter((entry) => entry.type === 'compaction').map((entry) => entry.id)
      ).toEqual(first.compactionEntryIds);
      const second = await turn(host, 'turn-2', 'after pressure');
      expect(second.outcome.status).toBe('completed');
      expect(second.compactionEntryIds).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'keeps its private channel exact under malformed requests and refuses work before open',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      const host = f.start();
      host.writeRaw('not json\n');
      host.writeRaw(
        `${JSON.stringify({ extra: 1, id: 9, op: 'turn', prompt: 'x', turnId: 't' })}\n`
      );
      host.writeRaw(`${'x'.repeat(8 * 1024 * 1024 + 1)}\n`);
      await host.waitUntil(() => host.orphanResponses.length === 3);
      expect(host.orphanResponses).toEqual([
        {
          error: { code: 'invalid_request', message: 'Request is not JSON.' },
          id: null,
          ok: false,
        },
        { error: { code: 'invalid_request', message: 'Request is invalid.' }, id: 9, ok: false },
        {
          error: { code: 'invalid_request', message: 'Request exceeded its bound.' },
          id: null,
          ok: false,
        },
      ]);
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        error: { code: 'invalid_state' },
      });
      expect(await host.request({ op: 'turn', prompt: 'x', turnId: 't' })).toMatchObject({
        error: { code: 'invalid_state' },
      });
      expect(await f.open(host)).toMatchObject({
        ok: true,
        result: { nativeHandle: { state: 'pending' } },
      });
      expect(await f.open(host)).toMatchObject({ error: { code: 'invalid_state' }, ok: false });
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        ok: true,
        result: { nativeHandle: { state: 'pending' }, state: 'idle', turnId: null },
      });
      expect(await host.request({ op: 'close' })).toMatchObject({
        ok: true,
        result: { nativeHandle: { state: 'pending' }, state: 'closed' },
      });
      expect(await host.exited).toBe(0);
      expect(f.inference.requests).toEqual([]);
      expect(f.capability.log).toEqual([]);
    },
    TIMEOUT
  );
});

describe('Pi runtime host cancellation and identity', () => {
  /**
   * An Extension input hook that holds prompts containing `slow` for 500 ms. A provider request
   * for such a prompt would answer with a bash call that writes the effect file.
   */
  async function slowInputFixture() {
    const f = await fixture((n, request) =>
      requestTexts(request).at(-1)?.includes('slow')
        ? { toolCall: { arguments: { command: 'touch cancellation-effect' }, name: 'bash' } }
        : { text: `answer-${n}` }
    );
    const probe = join(f.directories.root, 'input-probe.jsonl');
    await installExtension(
      f.directories,
      `import { appendFileSync } from 'node:fs';
const probe = ${JSON.stringify(probe)};
export default function (pi) {
  pi.on('input', async (event) => {
    if (!event.text.includes('slow')) return undefined;
    appendFileSync(probe, 'start\\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    appendFileSync(probe, 'end\\n');
    return undefined;
  });
}
`
    );
    f.capability.bound = true;
    const effect = join(f.directories.workingDirectory, 'cancellation-effect');
    const hookStarted = async () => {
      await waitFor(() => {
        try {
          return readFileSync(probe, 'utf8').includes('start');
        } catch {
          return false;
        }
      });
    };
    const hookEnded = async () => {
      await waitFor(() => {
        try {
          return readFileSync(probe, 'utf8').includes('end');
        } catch {
          return false;
        }
      });
      // Give a run that escaped cancellation time to reach the provider and the tool.
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    return { effect, f, hookEnded, hookStarted };
  }

  it(
    'stops an interrupt during Extension input hooks before any inference or tool effect',
    async () => {
      const { effect, f, hookEnded, hookStarted } = await slowInputFixture();
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'establish');
      expect(first.outcome.status).toBe('completed');
      await host.request({ op: 'turn', prompt: 'slow work', turnId: 'turn-2' });
      await hookStarted();
      const interrupted = await host.request({ op: 'interrupt', turnId: 'turn-2' });
      expect(interrupted).toMatchObject({ ok: true, result: { outcome: 'interrupted' } });
      const settled = await host.settled('turn-2');
      expect(settled.outcome.status).toBe('interrupted');
      expect(settled.nativeHandle).toEqual(first.nativeHandle);
      await hookEnded();
      expect(f.inference.requests).toHaveLength(1);
      expect(existsSync(effect)).toBe(false);
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        ok: true,
        result: { nativeHandle: first.nativeHandle, state: 'idle' },
      });
    },
    TIMEOUT
  );

  it(
    'stops a Turn held in Extension input hooks on close and on channel loss',
    async () => {
      for (const stop of ['close', 'channel'] as const) {
        const { effect, f, hookEnded, hookStarted } = await slowInputFixture();
        const host = f.start();
        await f.open(host);
        await host.request({ op: 'turn', prompt: 'slow work', turnId: 'turn-1' });
        await hookStarted();
        if (stop === 'close') {
          expect(await host.request({ op: 'close' })).toMatchObject({
            ok: true,
            result: { state: 'closed' },
          });
          expect(await host.exited).toBe(0);
        } else {
          host.endChannel();
          expect(await host.exited).toBe(1);
        }
        await hookEnded().catch(() => undefined);
        expect(f.inference.requests).toHaveLength(0);
        expect(existsSync(effect)).toBe(false);
      }
    },
    TIMEOUT
  );

  it(
    'cancels the pre-run compaction of an interrupted later Turn',
    async () => {
      const f = await fixture((n) =>
        n === 1 ? { promptTokens: 5_000, text: 'answer-1' } : { text: `summary-or-answer-${n}` }
      );
      const probe = join(f.directories.root, 'input-probe.jsonl');
      await installExtension(
        f.directories,
        `import { appendFileSync } from 'node:fs';
export default function (pi) {
  pi.on('input', async (event) => {
    if (!event.text.includes('slow')) return undefined;
    appendFileSync(${JSON.stringify(probe)}, 'start\\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    appendFileSync(${JSON.stringify(probe)}, 'end\\n');
    return undefined;
  });
}
`,
        { compaction: { keepRecentTokens: 1 } }
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'establish');
      expect(first.outcome.status).toBe('completed');
      expect(first.compactionEntryIds).toEqual([]);
      // A smaller window makes the retained context exceed the compaction threshold before the
      // next prompt runs.
      expect(
        await host.request({
          model: modelDescriptor('logical-a', { contextWindow: 8_192 }),
          op: 'configure',
        })
      ).toMatchObject({ ok: true });
      await host.request({ op: 'turn', prompt: 'slow work', turnId: 'turn-2' });
      await waitFor(() => probeLines(probe).includes('start'));
      expect(await host.request({ op: 'interrupt', turnId: 'turn-2' })).toMatchObject({
        ok: true,
        result: { outcome: 'interrupted' },
      });
      const settled = await host.settled('turn-2');
      expect(settled.outcome.status).toBe('interrupted');
      expect(settled.compactionEntryIds).toEqual([]);
      expect(settled.nativeHandle).toEqual(first.nativeHandle);
      await waitFor(() => probeLines(probe).includes('end'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(f.inference.requests).toHaveLength(1);
      const { path } = JSON.parse((first.nativeHandle as { handle: string }).handle) as {
        path: string;
      };
      expect(await readFile(path, 'utf8')).not.toContain('"type":"compaction"');
      expect(
        host.events.filter((event) => event.event === 'turn_settled' && event.turnId === 'turn-2')
      ).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    'blocks the tool call of an interrupted later Turn after user tool hooks ran',
    async () => {
      const f = await fixture((n) =>
        n === 2
          ? { toolCall: { arguments: { command: 'touch tool-effect' }, name: 'bash' } }
          : { text: `answer-${n}` }
      );
      const probe = join(f.directories.root, 'tool-probe.jsonl');
      await installExtension(
        f.directories,
        `import { appendFileSync } from 'node:fs';
export default function (pi) {
  pi.on('tool_call', async (event) => {
    if (event.toolName !== 'bash') return undefined;
    appendFileSync(${JSON.stringify(probe)}, 'start\\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    appendFileSync(${JSON.stringify(probe)}, 'end\\n');
    return undefined;
  });
}
`
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'establish');
      expect(first.outcome.status).toBe('completed');
      await host.request({ op: 'turn', prompt: 'use the tool', turnId: 'turn-2' });
      await waitFor(() => probeLines(probe).includes('start'));
      expect(await host.request({ op: 'interrupt', turnId: 'turn-2' })).toMatchObject({
        ok: true,
        result: { outcome: 'interrupted' },
      });
      const settled = await host.settled('turn-2');
      expect(settled.outcome.status).toBe('interrupted');
      expect(settled.nativeHandle).toEqual(first.nativeHandle);
      await waitFor(() => probeLines(probe).includes('end'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(join(f.directories.workingDirectory, 'tool-effect'))).toBe(false);
      expect(f.inference.requests).toHaveLength(2);
    },
    TIMEOUT
  );

  /**
   * A provider that answers any request whose latest text asks to continue with a bash call that
   * writes the effect file, and an Extension that starts a fresh native run through one official
   * trigger when `when` fires.
   */
  async function extensionRunFixture(
    trigger: 'sendMessage' | 'sendUserMessage',
    when: 'input' | 'idle'
  ) {
    const f = await fixture((n, request) =>
      requestTexts(request).at(-1)?.includes('Continue the requested work')
        ? { toolCall: { arguments: { command: 'touch extension-effect' }, name: 'bash' } }
        : { text: `answer-${n}` }
    );
    const probe = join(f.directories.root, 'run-probe.jsonl');
    const fire =
      trigger === 'sendMessage'
        ? `pi.sendMessage({ customType: 'probe', content: 'Continue the requested work.', display: false }, { triggerTurn: true });`
        : `pi.sendUserMessage('Continue the requested work.');`;
    const hook =
      when === 'input'
        ? `pi.on('input', async (event) => {
    if (!event.text.includes('slow')) return undefined;
    appendFileSync(probe, 'start\\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    ${fire}
    appendFileSync(probe, 'triggered\\n');
    await new Promise((resolve) => setTimeout(resolve, 200));
    return undefined;
  });`
        : `let armed = true;
  pi.on('agent_end', () => {
    if (!armed) return;
    armed = false;
    setTimeout(() => {
      ${fire}
      appendFileSync(probe, 'triggered\\n');
    }, 300);
  });`;
    await installExtension(
      f.directories,
      `import { appendFileSync } from 'node:fs';
const probe = ${JSON.stringify(probe)};
export default function (pi) {
  ${hook}
}
`
    );
    f.capability.bound = true;
    return { effect: join(f.directories.workingDirectory, 'extension-effect'), f, probe };
  }

  it(
    'fences a native run an Extension starts after an interrupt',
    async () => {
      for (const trigger of ['sendMessage', 'sendUserMessage'] as const) {
        const { effect, f, probe } = await extensionRunFixture(trigger, 'input');
        const host = f.start();
        await f.open(host);
        const first = await turn(host, 'turn-1', 'establish');
        expect(first.outcome.status).toBe('completed');
        await host.request({ op: 'turn', prompt: 'slow work', turnId: 'turn-2' });
        await waitFor(() => probeLines(probe).includes('start'));
        expect(await host.request({ op: 'interrupt', turnId: 'turn-2' })).toMatchObject({
          ok: true,
          result: { outcome: 'interrupted' },
        });
        const settled = await host.settled('turn-2');
        expect(settled.outcome.status).toBe('interrupted');
        expect(settled.nativeHandle).toEqual(first.nativeHandle);
        await waitFor(() => probeLines(probe).includes('triggered'));
        // Give an escaped run time to reach the provider and the tool.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(f.inference.requests, trigger).toHaveLength(1);
        expect(existsSync(effect), trigger).toBe(false);
        expect(
          host.events.filter((event) => event.event === 'turn_settled' && event.turnId === 'turn-2')
        ).toHaveLength(1);
      }
    },
    TIMEOUT
  );

  it(
    'fences a native run an Extension starts while no Turn is active',
    async () => {
      for (const trigger of ['sendMessage', 'sendUserMessage'] as const) {
        const { effect, f, probe } = await extensionRunFixture(trigger, 'idle');
        const host = f.start();
        await f.open(host);
        const first = await turn(host, 'turn-1', 'establish');
        expect(first.outcome.status).toBe('completed');
        await waitFor(() => probeLines(probe).includes('triggered'));
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(f.inference.requests, trigger).toHaveLength(1);
        expect(existsSync(effect), trigger).toBe(false);
        expect(host.events.filter((event) => event.event === 'turn_settled')).toHaveLength(1);
        const second = await turn(host, 'turn-2', 'after idle');
        expect(second.outcome.status).toBe('completed');
        expect(second.nativeHandle).toEqual(first.nativeHandle);
        expect(f.inference.requests).toHaveLength(2);
      }
    },
    TIMEOUT
  );

  it(
    'cancels a held first-Turn MCP initialize on interrupt, close, and channel loss',
    async () => {
      for (const stop of ['interrupt', 'close', 'channel'] as const) {
        const f = await fixture((n) => ({ text: `answer-${n}` }));
        f.capability.bound = true;
        f.capability.holdInitialize = true;
        const host = f.start();
        await f.open(host);
        await host.request({ op: 'turn', prompt: 'first', turnId: 'turn-1' });
        await waitFor(() => f.capability.log.some((entry) => entry.method === 'initialize'));
        const started = Date.now();
        if (stop === 'interrupt') {
          expect(await host.request({ op: 'interrupt', turnId: 'turn-1' })).toMatchObject({
            ok: true,
            result: { outcome: 'interrupted' },
          });
          const settled = await host.settled('turn-1');
          expect(settled.outcome.status).toBe('interrupted');
          expect(settled.nativeHandle.state).not.toBe('ready');
          expect(
            await host.request({ op: 'turn', prompt: 'again', turnId: 'turn-2' })
          ).toMatchObject({ error: { code: 'invalid_state' }, ok: false });
        } else if (stop === 'close') {
          expect(await host.request({ op: 'close' })).toMatchObject({
            ok: true,
            result: { state: 'closed' },
          });
          expect(await host.exited).toBe(0);
        } else {
          host.endChannel();
          expect(await host.exited).toBe(1);
        }
        expect(Date.now() - started).toBeLessThan(5_000);
        await waitFor(() => f.capability.cancelledHeld.length > 0, 5_000);
        expect(f.inference.requests).toHaveLength(0);
      }
    },
    TIMEOUT
  );

  it(
    'proves identity before a resident prompt without an explicit inspect',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'establish');
      await tamperHeader(first.nativeHandle);
      const second = await turn(host, 'turn-2', 'after tamper');
      expect(second.outcome).toEqual({ reason: 'pi-identity-failed', status: 'failed' });
      expect(second.nativeHandle).toEqual({ state: 'unknown' });
      expect(f.inference.requests).toHaveLength(1);
      expect(await host.request({ op: 'turn', prompt: 'more', turnId: 'turn-3' })).toMatchObject({
        error: { code: 'invalid_state' },
        ok: false,
      });
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        ok: true,
        result: { nativeHandle: { state: 'unknown' }, state: 'failed' },
      });
      expect(await host.request({ op: 'close' })).toMatchObject({
        ok: true,
        result: { nativeHandle: { state: 'unknown' }, state: 'closed' },
      });
    },
    TIMEOUT
  );

  it(
    'stops the active Turn when inspection finds a changed identity',
    async () => {
      const f = await fixture((n) => (n === 2 ? { hang: true } : { text: `answer-${n}` }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const first = await turn(host, 'turn-1', 'establish');
      await host.request({ op: 'turn', prompt: 'long work', turnId: 'turn-2' });
      await waitFor(() => f.inference.requests.length === 2);
      await tamperHeader(first.nativeHandle);
      expect(await host.request({ op: 'inspect' })).toMatchObject({
        error: { code: 'identity_failed' },
        ok: false,
      });
      const settled = await host.settled('turn-2');
      expect(settled.outcome).toEqual({ reason: 'pi-identity-failed', status: 'failed' });
      expect(settled.nativeHandle).toEqual({ state: 'unknown' });
      expect(await host.request({ op: 'turn', prompt: 'more', turnId: 'turn-3' })).toMatchObject({
        error: { code: 'invalid_state' },
        ok: false,
      });
      expect(f.inference.requests).toHaveLength(2);
    },
    TIMEOUT
  );

  it(
    'loads native context with project system prompts taking precedence without changing bytes',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      const markers: Record<string, string> = {
        [join(f.directories.agentDir, 'AGENTS.md')]: 'marker-agent-agents',
        [join(f.directories.agentDir, 'APPEND_SYSTEM.md')]: 'marker-agent-append',
        [join(f.directories.agentDir, 'SYSTEM.md')]: 'marker-agent-system',
        [join(f.directories.workingDirectory, '.pi', 'APPEND_SYSTEM.md')]: 'marker-project-append',
        [join(f.directories.workingDirectory, '.pi', 'SYSTEM.md')]: 'marker-project-system',
        [join(f.directories.workingDirectory, 'AGENTS.md')]: 'marker-project-agents',
        [join(f.directories.workingDirectory, 'CLAUDE.md')]: 'marker-project-claude',
      };
      await mkdir(join(f.directories.workingDirectory, '.pi'));
      for (const [path, marker] of Object.entries(markers)) await writeFile(path, `${marker}\n`);
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      expect((await turn(host, 'turn-1', 'work')).outcome.status).toBe('completed');
      const body = JSON.stringify(f.inference.requests[0]?.body);
      for (const marker of [
        'marker-agent-agents',
        'marker-project-agents',
        'marker-project-system',
        'marker-project-append',
      ])
        expect(body).toContain(marker);
      for (const marker of ['marker-agent-system', 'marker-agent-append', 'marker-project-claude'])
        expect(body).not.toContain(marker);
      for (const [path, marker] of Object.entries(markers)) {
        expect(await readFile(path, 'utf8')).toBe(`${marker}\n`);
      }
    },
    TIMEOUT
  );

  it(
    'reports Extension shortcuts and terminal-only UI methods as unsupported once each',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      const probe = join(f.directories.root, 'ui-probe.json');
      await installExtension(
        f.directories,
        `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.registerShortcut('ctrl+shift+k', { description: 'probe', handler: () => undefined });
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.notify('first');
    ctx.ui.notify('second');
    ctx.ui.setStatus('probe', 'busy');
    ctx.ui.setEditorText('draft');
    ctx.ui.setTitle('title');
    writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ themed: typeof ctx.ui.theme, text: ctx.ui.getEditorText() }));
  });
}
`
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      expect((await turn(host, 'turn-1', 'work')).outcome.status).toBe('completed');
      const methods = host.events
        .filter((event) => event.event === 'ui_unsupported')
        .map((event) => (event as { method: string }).method)
        .sort();
      expect(methods).toEqual([
        'notify',
        'registerShortcut',
        'setEditorText',
        'setStatus',
        'setTitle',
      ]);
      expect(JSON.parse(await readFile(probe, 'utf8'))).toEqual({ text: '', themed: 'object' });
    },
    TIMEOUT
  );

  it(
    'refuses an open that a close on the same channel overtakes',
    async () => {
      const f = await fixture((n) => ({ text: `answer-${n}` }));
      const host = f.start();
      const open = {
        agentDir: f.directories.agentDir,
        capabilityBaseUrl: f.capability.base,
        capabilityCredential: f.capabilityCredential,
        id: 100,
        inferenceBaseUrl: f.inference.url,
        inferenceCredential: f.inferenceCredential,
        mcpServers: [],
        model: modelDescriptor('logical-a'),
        op: 'open',
        skillTargetPaths: [],
        resume: null,
        stateRoot: f.directories.stateRoot,
        workingDirectory: f.directories.workingDirectory,
      };
      host.writeRaw(`${JSON.stringify(open)}\n${JSON.stringify({ id: 101, op: 'close' })}\n`);
      await waitFor(() => host.orphanResponses.length === 2);
      expect(host.orphanResponses).toEqual(
        expect.arrayContaining([
          { error: { code: 'invalid_state', message: 'Host is closing.' }, id: 100, ok: false },
          { id: 101, ok: true, result: { nativeHandle: { state: 'pending' }, state: 'closed' } },
        ])
      );
      expect(await host.exited).toBe(0);
      expect(await readdir(join(f.directories.stateRoot, 'sessions'))).toEqual([]);
    },
    TIMEOUT
  );
});

/** Native search qualification uses the real SDK, real HTTP MCP, and a scripted local provider. */
describe('M4 native search', () => {
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const tool = (name: string) => ({
    name,
    description: 'Distinct archive retrieval sentinel.',
    inputSchema: schema,
  });
  const extra = `import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const threads = createRequire(import.meta.url)('node:worker_threads');
const NativeWorker = threads.Worker;
threads.Worker = class extends NativeWorker {
 constructor(...args) {
  appendFileSync(process.env.PI_M4_WORKER_PROBE, 'worker-created\\n');
  super(...args);
 }
};
syncBuiltinESMExports();
export default function(pi) {
    pi.on('tool_result', event => {
      if (event.toolName === 'mcp__local__read_file') appendFileSync(process.env.PI_M4_WORKER_PROBE + '.results', event.toolName);
    });
    pi.registerTool({ name: 'native_extra', label: 'extra', description: 'Unrelated active tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'extra' }] }) });
  }`;
  const names = (request: CapturedInference) =>
    request.body.tools?.map((entry) => entry.function.name) ?? [];

  it.each([undefined, 'codemode-deferred', 'deferred'])(
    'declares active additive search and calls exact local exposure %s (inactive factory must fail)',
    async (exposure) => {
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval', limit: 8 } } },
        { toolCall: { name: 'mcp__local__read_file', arguments: { text: 'qualified' } } },
        { text: 'served' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, ['local'], {
        tools: [tool('read_file')],
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      await installExtension(f.directories, extra, {
        defaultTools: ['read', 'native_extra', 'mcp__openkit_work__echo'],
      });
      const config = JSON.stringify({
        mcpServers: {
          local: { url: `${local.base}/mcp/local`, ...(exposure ? { exposure } : {}) },
        },
      });
      await writeFile(join(f.directories.agentDir, 'mcp.json'), config);
      const settings = await readFile(join(f.directories.agentDir, 'settings.json'), 'utf8');
      f.capability.bound = true;
      const workerProbe = join(f.directories.root, 'worker-created');
      const host = f.start({ PI_M4_WORKER_PROBE: workerProbe });
      await f.open(host);
      expect((await turn(host, 'turn-search', 'discover and call')).outcome.status).toBe(
        'completed'
      );
      expect(names(f.inference.requests[0]!)).toEqual(
        expect.arrayContaining(['read', 'native_extra', 'mcp__openkit_work__echo', 'tool_search'])
      );
      expect(names(f.inference.requests[0]!)).not.toContain('mcp__local__read_file');
      expect(names(f.inference.requests[1]!)).toContain('mcp__local__read_file');
      expect(f.inference.requests[1]!.body.tools).toContainEqual(
        expect.objectContaining({
          function: expect.objectContaining({ name: 'mcp__local__read_file', parameters: schema }),
        })
      );
      expect(
        local.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => ({ name: entry.params?.name, arguments: entry.params?.arguments }))
      ).toEqual([{ name: 'read_file', arguments: { text: 'qualified' } }]);
      expect(requestTexts(f.inference.requests[2]!).join(' ')).toContain(
        'local:read_file:qualified'
      );
      expect(local.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(local.log.some((entry) => entry.headers.authorization !== undefined)).toBe(false);
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(
        f.capability.log.every(
          (entry) => entry.headers.authorization === `Bearer ${f.capabilityCredential}`
        )
      ).toBe(true);
      expect(await readFile(join(f.directories.agentDir, 'mcp.json'), 'utf8')).toBe(config);
      expect(await readFile(join(f.directories.agentDir, 'settings.json'), 'utf8')).toBe(settings);
      expect(f.inference.requests.every((request) => !names(request).includes('codemode'))).toBe(
        true
      );
      expect(existsSync(workerProbe)).toBe(false);
      expect(await readFile(`${workerProbe}.results`, 'utf8')).toBe('mcp__local__read_file');
    },
    TIMEOUT
  );

  it(
    'calls an ordinary raw codemode MCP tool through its exact namespaced name',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval', limit: 8 } } },
        { toolCall: { name: 'mcp__local__codemode', arguments: { text: 'ordinary-target' } } },
        { text: 'served ordinary target' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, ['local'], {
        tools: [tool('codemode')],
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: { local: { url: `${local.base}/mcp/local` } },
        })
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect(
        (await turn(host, 'ordinary-codemode', 'discover and call ordinary tool')).outcome.status
      ).toBe('completed');
      expect(names(f.inference.requests[0]!)).toContain('tool_search');
      expect(names(f.inference.requests[0]!)).not.toContain('mcp__local__codemode');
      expect(f.inference.requests[1]!.body.tools).toContainEqual(
        expect.objectContaining({
          function: expect.objectContaining({ name: 'mcp__local__codemode', parameters: schema }),
        })
      );
      expect(
        local.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => ({
            name: entry.params?.name,
            arguments: entry.params?.arguments,
          }))
      ).toEqual([{ name: 'codemode', arguments: { text: 'ordinary-target' } }]);
      expect(requestTexts(f.inference.requests[2]!).join(' ')).toContain(
        'local:codemode:ordinary-target'
      );
      expect(f.inference.requests.every((request) => !names(request).includes('codemode'))).toBe(
        true
      );
      expect(local.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
    },
    TIMEOUT
  );

  it.each(
    ['native', 'managed', 'mixed', 'registered', 'registered-native', 'session-start'].flatMap(
      (kind) => [false, true].map((reverse) => ({ kind, reverse }))
    )
  )(
    'refuses a normalized $kind server collision (reversed=$reverse) before provider or tool work',
    async ({ kind, reverse }) => {
      const f = await fixture(() => ({ text: 'must not prompt' }));
      const local = await startSyntheticCapability(null, ['work-files', 'work_files']);
      local.bound = true;
      cleanups.push(() => local.close());
      const native =
        kind === 'native'
          ? reverse
            ? ['work_files', 'work-files']
            : ['work-files', 'work_files']
          : kind === 'mixed'
            ? [reverse ? 'work-files' : 'work_files']
            : [];
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: Object.fromEntries(
            native.map((name) => [name, { url: `${local.base}/mcp/${name}` }])
          ),
        })
      );
      if (kind === 'registered' || kind === 'registered-native' || kind === 'session-start') {
        await mkdir(join(f.directories.agentDir, 'extensions'), { recursive: true });
        await writeFile(
          join(f.directories.agentDir, 'extensions', 'collision.ts'),
          `export default (pi) => {
            const register = () => {
              pi.registerMcpServer('${reverse ? 'work-files' : 'work_files'}', { url: '${local.base}/mcp/work_files' });
              ${kind === 'registered' ? '' : `pi.registerMcpServer('${reverse ? 'work_files' : 'work-files'}', { url: '${local.base}/mcp/work-files' });`}
            };
            ${kind === 'session-start' ? 'pi.on("session_start", register);' : 'register();'}
          };`
        );
      }
      const host = f.start();
      await f.open(host, {
        mcpServers:
          kind === 'managed'
            ? reverse
              ? ['work_files', 'work-files']
              : ['work-files', 'work_files']
            : kind === 'native' || kind === 'registered-native' || kind === 'session-start'
              ? []
              : [reverse ? 'work_files' : 'work-files'],
      });
      expect((await turn(host, 'turn-collision', 'must refuse')).outcome).toEqual({
        status: 'failed',
        reason: 'pi-setup-failed',
      });
      expect(f.inference.requests).toHaveLength(0);
      expect(local.log).toHaveLength(0);
      expect(f.capability.log).toHaveLength(0);
    },
    TIMEOUT
  );

  it.each([false, true])(
    'preserves exact normalized colliding tool targets in reversed order=%s',
    async (reverse) => {
      const servers = reverse ? ['archive_files', 'work-files'] : ['work-files', 'archive_files'];
      const tools = reverse ? ['read_file', 'read-file'] : ['read-file', 'read_file'];
      const targets = servers.flatMap((server) =>
        tools.map((name) => ({
          server,
          name,
          nativeName: `mcp__${server.replace(/-/g, '_')}__read_file_${createHash('sha256').update(`${server}\0${name}`).digest('hex').slice(0, 8)}`,
        }))
      );
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval', limit: 8 } } },
        ...targets.map(({ nativeName }, index) => ({
          toolCall: { name: nativeName, arguments: { text: `effect-${index}` } },
        })),
        { text: 'exact targets' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, servers, {
        tools: tools.map(tool),
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: Object.fromEntries(
            servers.map((server) => [server, { url: `${local.base}/mcp/${server}` }])
          ),
        })
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect(
        (await turn(host, 'turn-targets', 'discover exact archive tools')).outcome.status
      ).toBe('completed');
      const calls = local.log.filter((entry) => entry.method === 'tools/call');
      expect(
        calls.map((entry) => ({
          server: entry.path.split('/').at(-1),
          name: entry.params?.name,
          arguments: entry.params?.arguments,
        }))
      ).toEqual(
        targets.map(({ server, name }, index) => ({
          server,
          name,
          arguments: { text: `effect-${index}` },
        }))
      );
      for (const [index, { server, name, nativeName }] of targets.entries()) {
        expect(names(f.inference.requests[index + 1]!)).toContain(nativeName);
        expect(requestTexts(f.inference.requests[index + 2]!).join(' ')).toContain(
          `${server}:${name}:effect-${index}`
        );
        expect(
          calls.filter(
            (call) =>
              call.params?.arguments &&
              (call.params.arguments as { text: string }).text === `effect-${index}`
          )
        ).toHaveLength(1);
      }
    },
    TIMEOUT
  );

  it.each([
    'exclude-search',
    'exclude-all',
    'replace-search',
    'late-replace-search',
    'script-setting',
    'script-factory',
  ])(
    'allows configured resources %s with the managed overlay',
    async (kind) => {
      const f = await fixture(() => ({ text: 'provider reached' }));
      const marker = join(f.directories.root, 'session-start');
      const hook = `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', () => writeFileSync(${JSON.stringify(marker)}, 'effect'));
  ${kind === 'late-replace-search' ? "pi.on('session_start', () => pi.registerTool({ name: 'tool_search', label: 'fake', description: 'fake', parameters: { type: 'object' }, execute: async () => ({ content: [] }) }));" : ''}
  ${kind === 'replace-search' ? "pi.registerTool({ name: 'tool_search', label: 'fake', description: 'fake', parameters: { type: 'object' }, execute: async () => ({ content: [] }) });" : ''}
}`;
      const source =
        kind === 'script-factory'
          ? `import { writeFileSync } from 'node:fs';
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
export default function(pi) {
  createCodemodeExtension()(pi);
  pi.on('session_start', () => writeFileSync(${JSON.stringify(marker)}, 'effect'));
}`
          : hook;
      await installExtension(
        f.directories,
        source,
        kind === 'exclude-search'
          ? { extensions: ['-builtin:tool-search'] }
          : kind === 'exclude-all'
            ? { extensions: ['-builtin:mcp', '-builtin:tool-search'] }
            : kind === 'script-setting'
              ? { defaultTools: ['+codemode'] }
              : {}
      );
      const original = await readFile(join(f.directories.agentDir, 'settings.json'), 'utf8');
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      expect((await turn(host, 'turn-overlay', 'work')).outcome).toEqual({
        status: 'completed',
        assistantText: 'provider reached',
      });
      expect(f.inference.requests).toHaveLength(1);
      expect(f.capability.log.some((entry) => entry.method === 'initialize')).toBe(true);
      expect(
        f.inference.requests[0]!.body.tools?.some((tool) => tool.function.name === 'tool_search')
      ).toBe(true);
      expect(existsSync(marker)).toBe(true);
      expect(await readFile(join(f.directories.agentDir, 'settings.json'), 'utf8')).toBe(original);
    },
    TIMEOUT
  );
});

describe('M4 late native setup registration', () => {
  it.each([true, false])(
    'allows genuine session_start codemode registration activated=%s',
    async (activate) => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'codemode', arguments: { code: 'return 73019;' } } }
          : { text: 'provider reached' }
      );
      const registration = join(f.directories.root, 'late-registration');
      await installExtension(
        f.directories,
        `import { writeFileSync } from 'node:fs';
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
export default function(pi) {
  pi.on('session_start', () => {
    createCodemodeExtension()(pi);
    ${activate ? "pi.setActiveTools([...pi.getActiveTools(), 'codemode']);" : ''}
    writeFileSync(${JSON.stringify(registration)}, JSON.stringify({ registered: pi.getAllTools().some(tool => tool.name === 'codemode'), active: pi.getActiveTools().includes('codemode') }));
  });
}`
      );
      const configPath = join(f.directories.agentDir, 'settings.json');
      const authored = await readFile(configPath, 'utf8');
      f.capability.bound = true;
      const host = f.start();
      expect(await f.open(host)).toMatchObject({ ok: true });
      const settled = await turn(host, 'turn-late-codemode', 'user-configured native setup');
      expect(settled.outcome.status).toBe('completed');
      expect(JSON.parse(await readFile(registration, 'utf8'))).toEqual({
        registered: true,
        active: activate,
      });
      expect(f.inference.requests.length).toBeGreaterThan(0);
      expect(f.capability.log.filter((entry) => entry.method === 'tools/call')).toHaveLength(0);
      expect(await readFile(configPath, 'utf8')).toBe(authored);
      await host.request({ op: 'close' });
      expect(await host.exited).toBe(0);
      const count = f.capability.log.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(f.capability.log).toHaveLength(count);
    },
    TIMEOUT
  );
});

describe('M4 bounded support checkpoint characterization', () => {
  it.each(['input', 'before_agent_start', 'agent_start'])(
    'places reviewer %s registration outside the promised setup refusal',
    async (event) => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'codemode', arguments: { code: 'return 73019;' } } }
          : { text: 'provider reached' }
      );
      // Preserve the reviewer's genuine later-event source. Its Turn result is observation,
      // not a supported-feature success or universal-refusal oracle.
      const source = `import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
export default function(pi) { pi.on('${event}', () => {
  createCodemodeExtension()(pi);
  pi.setActiveTools([...pi.getActiveTools(), 'codemode']);
}); }`;
      const checkpoint = join(f.directories.root, 'support-checkpoint.json');
      const observer = join(f.directories.root, 'checkpoint-observer.js');
      await writeFile(
        observer,
        `import { writeFileSync } from 'node:fs';
export default function(pi) { pi.on('session_start', () => {
  writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify({
    registered: pi.getAllTools().some(tool => tool.name === 'codemode'),
    active: pi.getActiveTools().includes('codemode')
  })); }); }`
      );
      await installExtension(f.directories, source, { extensions: [observer] });
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      const settled = await turn(host, 'reviewer-later', 'work');
      // These sources supply nothing at the documented checkpoint. No assertion constrains
      // their later success or refusal; lifecycle cleanup retains its ordinary oracle.
      expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toEqual({
        registered: false,
        active: false,
      });
      expect(
        await readFile(join(f.directories.root, 'extension-package', 'extension.js'), 'utf8')
      ).toBe(source);
      console.info(
        'bounded-codemode-observation',
        JSON.stringify({
          event,
          outcome: settled.outcome,
          providerRequests: f.inference.requests.length,
          firstDeclaresComposer:
            f.inference.requests[0]?.body.tools?.some(
              (tool) => tool.function.name === 'codemode'
            ) ?? false,
          arithmeticObserved: f.inference.requests.some((request) =>
            requestTexts(request).join(' ').includes('73019')
          ),
        })
      );
      await host.request({ op: 'close' });
      expect(await host.exited).toBe(0);
    },
    TIMEOUT
  );
});

describe('M4 native search lifecycle and authority', () => {
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const localTool = { name: 'read_file', description: 'Archive retrieval.', inputSchema: schema };
  const declared = (request: CapturedInference) =>
    request.body.tools?.map((entry) => entry.function.name) ?? [];

  it(
    'keeps hidden tools unsearchable and uncallable without rewriting configuration',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval' } } },
        { toolCall: { name: 'mcp__secret__read_file', arguments: { text: 'forbidden' } } },
        { text: 'hidden stayed hidden' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, ['secret'], {
        tools: [localTool],
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      const config = JSON.stringify({
        mcpServers: { secret: { url: `${local.base}/mcp/secret`, exposure: 'hidden' } },
      });
      await writeFile(join(f.directories.agentDir, 'mcp.json'), config);
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect((await turn(host, 'turn-hidden', 'attempt discovery')).outcome.status).toBe(
        'completed'
      );
      expect(
        f.inference.requests.every(
          (request) => !declared(request).includes('mcp__secret__read_file')
        )
      ).toBe(true);
      expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain('No matching tools');
      expect(local.log.filter((entry) => entry.method === 'tools/call')).toHaveLength(0);
      expect(await readFile(join(f.directories.agentDir, 'mcp.json'), 'utf8')).toBe(config);
    },
    TIMEOUT
  );

  it.each(['validation', 'hook'])(
    'discovered tools obey native %s before effects',
    async (guard) => {
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval' } } },
        {
          toolCall: {
            name: 'mcp__local__read_file',
            arguments: guard === 'validation' ? {} : { text: 'blocked' },
          },
        },
        { text: 'refused tool' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, ['local'], {
        tools: [localTool],
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      const probe = join(f.directories.root, 'tool-hooks');
      await installExtension(
        f.directories,
        `import { appendFileSync } from 'node:fs';
export default function(pi) {
 pi.on('tool_call', event => {
  appendFileSync(${JSON.stringify(probe)}, event.toolName + '\\n');
  ${guard === 'hook' ? "if (event.toolName === 'mcp__local__read_file') return { block: true, reason: 'native hook refusal' };" : ''}
 });
}`
      );
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { local: { url: `${local.base}/mcp/local` } } })
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect((await turn(host, 'turn-guard', 'discover')).outcome.status).toBe('completed');
      expect(declared(f.inference.requests[1]!)).toContain('mcp__local__read_file');
      expect(local.log.filter((entry) => entry.method === 'tools/call')).toHaveLength(0);
      const resultText = requestTexts(f.inference.requests[2]!).join(' ');
      expect(resultText).toContain(guard === 'hook' ? 'native hook refusal' : 'text');
      if (guard === 'hook') {
        expect(await readFile(probe, 'utf8')).toContain('mcp__local__read_file');
      }
    },
    TIMEOUT
  );

  it.each(['changed', 'unchanged', 'unconfigured'] as const)(
    'preserves resident activation and exact successor rediscovery with %s defaults',
    async (defaults) => {
      const target = 'mcp__local__read_file';
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval' } } },
        { toolCall: { name: target, arguments: { text: 'first' } } },
        { text: 'first sentinel' },
        { toolCall: { name: target, arguments: { text: 'second' } } },
        { text: 'second sentinel' },
        { toolCall: { name: target, arguments: { text: 'stale-do-not-run' } } },
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval' } } },
        { toolCall: { name: target, arguments: { text: 'resumed-new' } } },
        { text: 'resumed after native rediscovery' },
      ];
      let nativePath = '';
      const projections = new Map<number, ReturnType<SessionManager['buildSessionContext']>>();
      const effectsAtRequest = new Map<number, ReturnType<typeof calls>>();
      const f = await fixture((n, request) => {
        if (n >= 6) {
          projections.set(n, SessionManager.open(nativePath).buildSessionContext());
          effectsAtRequest.set(n, calls());
          // Stop the script before any stale/new effect if a mutation restores old declarations.
          const names = declared(request);
          if (
            n === 6 &&
            (names.includes(target) || (defaults === 'changed' && names.includes('write')))
          )
            return { text: 'unexpected historical startup declaration' };
        }
        return replies[n - 1] ?? { text: 'unexpected' };
      });
      const local = await startSyntheticCapability(null, ['local'], {
        tools: [localTool],
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      const calls = () =>
        local.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => ({ name: entry.params?.name, arguments: entry.params?.arguments }));
      const configPath = join(f.directories.agentDir, 'mcp.json');
      const config = JSON.stringify({ mcpServers: { local: { url: `${local.base}/mcp/local` } } });
      await writeFile(configPath, config);
      const settingsPath = join(f.directories.agentDir, 'settings.json');
      const firstSettings = JSON.stringify(
        defaults === 'unconfigured' ? {} : { defaultTools: ['read', 'write'] }
      );
      await writeFile(settingsPath, firstSettings);
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      expect((await turn(host, 'turn-first', 'search')).outcome.status).toBe('completed');
      expect(f.inference.requests[1]!.body.tools).toContainEqual(
        expect.objectContaining({
          function: expect.objectContaining({ name: target, parameters: schema }),
        })
      );
      const first = readyHandle(await host.request({ op: 'inspect' }));
      nativePath = JSON.parse(first.handle).path;
      expect((await turn(host, 'turn-second', 'reuse without search')).outcome.status).toBe(
        'completed'
      );
      expect(declared(f.inference.requests[3]!)).toContain(target);
      expect(calls()).toEqual([
        { name: 'read_file', arguments: { text: 'first' } },
        { name: 'read_file', arguments: { text: 'second' } },
      ]);
      expect(local.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      await host.request({ op: 'close' });
      expect(await host.exited).toBe(0);
      const retained = await readFile(nativePath);
      const predecessorTools = getCurrentSystemMessage(
        SessionManager.open(nativePath).buildSessionContext().messages
      )?.toolsAdded?.map((tool) => tool.name);
      expect(predecessorTools).toContain(target);
      const successorSettings = JSON.stringify(
        defaults === 'unconfigured'
          ? {}
          : {
              defaultTools: defaults === 'changed' ? ['read', 'edit'] : ['read', 'write'],
            }
      );
      await writeFile(settingsPath, successorSettings);
      const successor = f.start();
      expect(await f.open(successor, { resume: { handle: first.handle } })).toMatchObject({
        ok: true,
      });
      expect((await turn(successor, 'turn-resumed', 'resume and rediscover')).outcome.status).toBe(
        'completed'
      );
      const startup = declared(f.inference.requests[5]!);
      expect(startup).not.toContain(target);
      if (defaults === 'changed') expect(startup).not.toContain('write');
      expect(startup).toEqual(
        expect.arrayContaining(['read', 'tool_search', 'mcp__openkit_work__echo'])
      );
      if (defaults === 'changed') expect(startup).toContain('edit');
      if (defaults === 'unchanged') expect(startup).toContain('write');
      expect(requestTexts(f.inference.requests[5]!).join(' ')).toContain('second sentinel');
      const stale = projections
        .get(7)!
        .messages.filter((message) => message.role === 'toolResult')
        .at(-1);
      expect(stale).toMatchObject({
        role: 'toolResult',
        toolName: target,
        toolCallId: expect.stringContaining('call_6'),
        isError: true,
        content: [{ type: 'text', text: `Tool ${target} not found` }],
      });
      const staleInput = f.inference.requests[6]!.body.messages.filter(
        (message) => message.role === 'tool'
      ).at(-1);
      expect(staleInput).toMatchObject({ tool_call_id: expect.stringContaining('call_6') });
      expect(JSON.stringify(staleInput)).toContain('not found');
      const staleEffects = projections
        .get(7)!
        .messages.filter(
          (message) =>
            message.role === 'toolResult' && message.toolName === target && !message.isError
        );
      expect(staleEffects).toHaveLength(2);
      for (const index of [6, 7, 8])
        expect(effectsAtRequest.get(index)).toEqual([
          { name: 'read_file', arguments: { text: 'first' } },
          { name: 'read_file', arguments: { text: 'second' } },
        ]);
      expect(f.inference.requests[7]!.body.tools).toContainEqual(
        expect.objectContaining({
          function: expect.objectContaining({ name: target, parameters: schema }),
        })
      );
      expect(requestTexts(f.inference.requests[8]!).join(' ')).toContain(
        'local:read_file:resumed-new'
      );
      expect(calls()).toEqual([
        { name: 'read_file', arguments: { text: 'first' } },
        { name: 'read_file', arguments: { text: 'second' } },
        { name: 'read_file', arguments: { text: 'resumed-new' } },
      ]);
      expect(local.log.filter((entry) => entry.method === 'initialize')).toHaveLength(2);
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(2);
      expect(f.inference.requests).toHaveLength(9);
      for (const index of [6, 7, 8, 9]) {
        const folded =
          getCurrentSystemMessage(projections.get(index)!.messages)?.toolsAdded?.map(
            (tool) => tool.name
          ) ?? [];
        expect(folded.sort()).toEqual(declared(f.inference.requests[index - 1]!).sort());
      }
      expect(
        getCurrentSystemMessage(projections.get(6)!.messages)?.toolsAdded?.map((tool) => tool.name)
      ).not.toContain(target);
      expect(
        getCurrentSystemMessage(projections.get(8)!.messages)?.toolsAdded?.map((tool) => tool.name)
      ).toContain(target);
      const startupDeltas = projections
        .get(6)!
        .messages.filter((message) => message.role === 'system');
      expect(
        startupDeltas.some((message) => message.toolsRemoved?.some((tool) => tool.name === target))
      ).toBe(true);
      if (defaults === 'changed') {
        expect(
          startupDeltas.some((message) =>
            message.toolsRemoved?.some((tool) => tool.name === 'write')
          )
        ).toBe(true);
        expect(
          startupDeltas.some((message) => message.toolsAdded?.some((tool) => tool.name === 'edit'))
        ).toBe(true);
      }
      expect(readyHandle(await successor.request({ op: 'inspect' }))).toEqual(first);
      expect((await readFile(nativePath)).subarray(0, retained.length)).toEqual(retained);
      expect(await readFile(configPath, 'utf8')).toBe(config);
      expect(await readFile(settingsPath, 'utf8')).toBe(successorSettings);
      await successor.request({ op: 'close' });
      expect(await successor.exited).toBe(0);
    },
    TIMEOUT
  );

  it(
    'redacts both credentials from discovered schemas, search results and retained native evidence',
    async () => {
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval' } } },
        { toolCall: { name: 'mcp__local__read_file', arguments: { text: 'safe' } } },
        { text: 'safe result' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, ['local'], {
        tools: [
          {
            ...localTool,
            description: `archive retrieval ${f.inferenceCredential} ${f.capabilityCredential}`,
          },
        ],
        targetSentinel: true,
      });
      local.bound = true;
      cleanups.push(() => local.close());
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { local: { url: `${local.base}/mcp/local` } } })
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      const settled = await turn(host, 'turn-redaction', 'discover');
      expect(settled.outcome.status).toBe('completed');
      const handle = readyHandle(await host.request({ op: 'inspect' }));
      const nativeEvidence = await readFile(JSON.parse(handle.handle).path, 'utf8');
      const logPath = join(f.directories.agentDir, 'mcp.log');
      const nativeLog = existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
      const evidence =
        JSON.stringify({
          requests: f.inference.requests.map((request) => request.body),
          frames: host.events,
          stdout: host.stdout,
          stderr: host.stderr,
        }) +
        nativeEvidence +
        nativeLog;
      for (const secret of [f.inferenceCredential, f.capabilityCredential])
        expect(evidence).not.toContain(secret);
      expect(evidence).toContain('[redacted]');
    },
    TIMEOUT
  );
});

describe('M4 current authority after discovery', () => {
  it.each(['hidden', 'withdrawn'] as const)(
    'does not revive searched %s tools through successor search or stale direct calls',
    async (exposure) => {
      const replies: InferenceReply[] = [
        { toolCall: { name: 'tool_search', arguments: { query: 'echo text' } } },
        { toolCall: { name: 'mcp__local__echo', arguments: { text: 'one-effect' } } },
        { text: 'effect retained' },
        { toolCall: { name: 'tool_search', arguments: { query: 'echo text' } } },
        { toolCall: { name: 'mcp__local__echo', arguments: { text: 'withdrawn' } } },
        { text: 'withdrawn target refused' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      const local = await startSyntheticCapability(null, ['local']);
      local.bound = true;
      cleanups.push(() => local.close());
      const configPath = join(f.directories.agentDir, 'mcp.json');
      await writeFile(
        configPath,
        JSON.stringify({ mcpServers: { local: { url: `${local.base}/mcp/local` } } })
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect((await turn(host, 'turn-found', 'search')).outcome.status).toBe('completed');
      const handle = readyHandle(await host.request({ op: 'inspect' }));
      await host.request({ op: 'close' });
      expect(await host.exited).toBe(0);
      const retained = await readFile(JSON.parse(handle.handle).path);
      const hiddenConfig = JSON.stringify({
        mcpServers:
          exposure === 'hidden'
            ? { local: { url: `${local.base}/mcp/local`, exposure: 'hidden' } }
            : {},
      });
      await writeFile(configPath, hiddenConfig);
      const successor = f.start();
      expect(
        await f.open(successor, { mcpServers: [], resume: { handle: handle.handle } })
      ).toMatchObject({ ok: true });
      expect((await turn(successor, 'turn-hidden-again', 'try prior tool')).outcome.status).toBe(
        'completed'
      );
      expect(
        f.inference.requests[3]!.body.tools?.map((entry) => entry.function.name)
      ).not.toContain('mcp__local__echo');
      expect(requestTexts(f.inference.requests[4]!).join(' ')).toContain('No matching tools');
      expect(
        f.inference.requests[4]!.body.tools?.map((entry) => entry.function.name)
      ).not.toContain('mcp__local__echo');
      expect(
        local.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'one-effect' }]);
      expect(readyHandle(await successor.request({ op: 'inspect' }))).toEqual(handle);
      expect((await readFile(JSON.parse(handle.handle).path)).subarray(0, retained.length)).toEqual(
        retained
      );
      expect(await readFile(configPath, 'utf8')).toBe(hiddenConfig);
      await successor.request({ op: 'close' });
      expect(await successor.exited).toBe(0);
    },
    TIMEOUT
  );

  it(
    'does not give searched state a bypass of revoked managed capability',
    async () => {
      const replies: InferenceReply[] = [
        { text: 'established' },
        { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'revoked' } } },
        { text: 'capability refusal observed' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'unexpected' });
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      expect((await turn(host, 'turn-established', 'first')).outcome.status).toBe('completed');
      f.capability.bound = false;
      expect((await turn(host, 'turn-revoked', 'try the tool')).outcome.status).toBe('completed');
      const attempted = f.capability.log.filter((entry) => entry.method === 'tools/call');
      expect(attempted).toHaveLength(1);
      expect(attempted[0]!.accepted).toBe(false);
      expect(attempted[0]!.headers.authorization).toBe(`Bearer ${f.capabilityCredential}`);
      expect(f.capability.log.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
      expect(
        f.inference.requests.every((request) =>
          request.body.tools?.some((entry) => entry.function.name === 'tool_search')
        )
      ).toBe(true);
      await host.request({ op: 'close' });
      expect(await host.exited).toBe(0);
    },
    TIMEOUT
  );
});

describe('M4 user-local attempts retain actual managed authority', () => {
  it.each(['revoked', 'ungranted'])(
    'refuses the actual %s managed operation without a target effect',
    async (denial) => {
      const f = await fixture((n) =>
        n === 1
          ? { toolCall: { name: 'user_local_attempt', arguments: {} } }
          : { text: 'attempt observed' }
      );
      f.capability.bound = denial !== 'revoked';
      const target = denial === 'ungranted' ? 'not-admitted' : 'openkit-work';
      // A user-local mechanism can attempt HTTP directly; only the current capability plane
      // can authorize the actual target. Neither arithmetic nor the composer guard proves it.
      await installExtension(
        f.directories,
        `export default function(pi) {
  pi.registerTool({ name: 'user_local_attempt', label: 'attempt', description: 'Local authority probe',
    parameters: { type: 'object', properties: {} }, execute: async () => {
      const response = await fetch(${JSON.stringify(`${f.capability.base}/mcp/${target}`)}, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ${JSON.stringify(`Bearer ${f.capabilityCredential}`)} },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'must-not-reach-target' } } })
      });
      return { content: [{ type: 'text', text: 'actual-target-status:' + response.status + ':' + await response.text() }] };
    } });
}`,
        { defaultTools: ['user_local_attempt'] }
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      await turn(host, 'local-authority-attempt', 'attempt managed operation');
      const calls = f.capability.log.filter((entry) => entry.method === 'tools/call');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        accepted: false,
        path: `/capabilities/mcp/${target}`,
        params: { name: 'echo', arguments: { text: 'must-not-reach-target' } },
      });
      expect(calls.filter((entry) => entry.accepted)).toHaveLength(0);
      expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain(
        'actual-target-status:403'
      );
      expect(requestTexts(f.inference.requests[1]!).join(' ')).not.toContain(
        'echo:must-not-reach-target'
      );
    },
    TIMEOUT
  );
});

describe('M4 discovered call cleanup', () => {
  it.each(['interrupt', 'close', 'channel'])(
    'cancels discovered call on %s, preserves retained bytes and ends native work',
    async (stop) => {
      const replies: InferenceReply[] = [
        { text: 'established' },
        { toolCall: { name: 'tool_search', arguments: { query: 'archive retrieval' } } },
        { toolCall: { name: 'mcp__local__read_file', arguments: { text: 'held' } } },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'must not continue' });
      const local = await startSyntheticCapability(null, ['local'], {
        tools: [
          {
            name: 'read_file',
            description: 'Archive retrieval',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      });
      local.bound = true;
      local.holdToolCall = true;
      cleanups.push(() => local.close());
      await writeFile(
        join(f.directories.agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { local: { url: `${local.base}/mcp/local` } } })
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect((await turn(host, 'turn-established', 'establish')).outcome.status).toBe('completed');
      const handle = readyHandle(await host.request({ op: 'inspect' }));
      const path = JSON.parse(handle.handle).path;
      const retained = await readFile(path);
      await host.request({ op: 'turn', turnId: 'turn-held', prompt: 'discover held tool' });
      await waitFor(() => local.log.some((entry) => entry.method === 'tools/call'));
      if (stop === 'interrupt') {
        expect(await host.request({ op: 'interrupt', turnId: 'turn-held' })).toMatchObject({
          ok: true,
          result: { outcome: 'interrupted' },
        });
        expect((await host.settled('turn-held')).outcome.status).toBe('interrupted');
        await host.request({ op: 'close' });
        expect(await host.exited).toBe(0);
      } else if (stop === 'close') {
        expect(await host.request({ op: 'close' })).toMatchObject({
          ok: true,
          result: { state: 'closed' },
        });
        expect(await host.exited).toBe(0);
      } else {
        host.endChannel();
        expect(await host.exited).toBe(1);
      }
      await waitFor(() => local.cancelledHeld.includes('tools/call'), 5000);
      expect((await readFile(path)).subarray(0, retained.length)).toEqual(retained);
      expect(f.inference.requests).toHaveLength(3);
      const count = local.log.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(local.log).toHaveLength(count);
      expect(host.child.exitCode).not.toBeNull();
    },
    TIMEOUT
  );
});

/** Native workspace tools execute under the same resident host and managed model route. */
describe('Sandbox full capability', () => {
  it(
    'executes model-directed shell and file writes with observable workspace effects',
    async () => {
      const f = await fixture(
        (n) =>
          [
            {
              toolCall: {
                name: 'bash',
                arguments: { command: 'printf shell-effect > shell.txt; cat shell.txt' },
              },
            },
            {
              toolCall: {
                name: 'write',
                arguments: { path: 'written.txt', content: 'write-effect' },
              },
            },
            { text: 'workspace work complete' },
          ][n - 1] ?? { text: 'unexpected' }
      );
      const host = f.start();
      await f.open(host, { mcpServers: [] });
      expect((await turn(host, 'capability', 'run shell and write a file')).outcome).toEqual({
        status: 'completed',
        assistantText: 'workspace work complete',
      });
      expect(await readFile(join(f.directories.workingDirectory, 'shell.txt'), 'utf8')).toBe(
        'shell-effect'
      );
      expect(await readFile(join(f.directories.workingDirectory, 'written.txt'), 'utf8')).toBe(
        'write-effect'
      );
      expect(requestTexts(f.inference.requests[1]!).join(' ')).toContain('shell-effect');
      expect(f.inference.requests).toHaveLength(3);
    },
    TIMEOUT
  );
});

/** Complete transport replacement prevents a native stdio entry becoming a mixed Gateway entry. */
it(
  'overlays an authored stdio MCP entry without spawning it or editing its bytes',
  async () => {
    const f = await fixture((n) =>
      n === 1
        ? { toolCall: { name: 'mcp__openkit_work__echo', arguments: { text: 'stdio-overlay' } } }
        : { text: 'Gateway served' }
    );
    const marker = join(f.directories.workingDirectory, 'native-stdio-effect');
    const path = join(f.directories.agentDir, 'mcp.json');
    const authored = JSON.stringify({
      mcpServers: {
        'openkit-work': {
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong target')`,
          ],
        },
      },
    });
    await writeFile(path, authored);
    f.capability.bound = true;
    const host = f.start();
    await f.open(host);
    expect((await turn(host, 'stdio-overlay', 'call managed tool')).outcome).toEqual({
      status: 'completed',
      assistantText: 'Gateway served',
    });
    expect(
      f.capability.log
        .filter((entry) => entry.method === 'tools/call')
        .map((entry) => entry.params?.arguments)
    ).toEqual([{ text: 'stdio-overlay' }]);
    expect(
      f.capability.log.every(
        (entry) => entry.headers.authorization === `Bearer ${f.capabilityCredential}`
      )
    ).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(authored);
    expect(host.stderr).toContain('OpenKit overlay');
  },
  TIMEOUT
);
