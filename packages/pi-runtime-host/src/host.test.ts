// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostResponse } from './channel.ts';
import { PI_PROVIDER_ALIAS } from './host.ts';
import { type SyntheticCapability, startSyntheticCapability } from './test-support/capability.ts';
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

/** Polls until a condition holds, failing after a bound. */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
    ? { toolCall: { arguments: { text: `call-${n}` }, name: 'openkit-work_echo' } }
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
      expect(toolNames).toContain('openkit-work_echo');
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
        expect(failed.outcome).toMatchObject({ status: 'failed' });
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
    'grants no ready authority when the first Turn fails and fences the binding for close',
    async () => {
      const f = await fixture(() => ({ finish: 'length', text: 'truncated' }));
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'first');
      expect(settled.outcome).toMatchObject({ status: 'failed' });
      expect(settled.nativeHandle.state).not.toBe('ready');
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
        (closed as { result: { nativeHandle: { state: string } } }).result.nativeHandle.state
      ).not.toBe('ready');
      expect(await host.exited).toBe(0);
      expect(f.inference.requests).toHaveLength(1);
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
      expect(settled.nativeHandle.state).not.toBe('ready');
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
    'loads user packages, Extensions, Skills, and prompt templates while keeping native UI fail-closed',
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
      expect(start).toMatchObject({ confirm: false, hasUI: true });
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
    "serves a user's in-Sandbox MCP server from the adapter's own configuration with one client",
    async () => {
      const replies: InferenceReply[] = [
        {
          toolCall: {
            arguments: { args: { text: 'local' }, server: 'local-tools', tool: 'echo' },
            name: 'mcp',
          },
        },
        { toolCall: { arguments: { text: 'granted' }, name: 'openkit-work_echo' } },
        { text: 'both served' },
      ];
      const f = await fixture((n) => replies[n - 1] ?? { text: 'late' });
      const local = await startSyntheticCapability(null, ['local-tools']);
      local.bound = true;
      cleanups.push(() => local.close());
      // A user installs the ordinary adapter as a Pi package and configures it in the file the
      // pinned adapter reads under the agent directory; the pinned Pi has no built-in MCP.
      const adapterRoot = await realpath(
        join(import.meta.dirname, '..', 'node_modules', 'pi-mcp-adapter')
      );
      await writeFile(
        join(f.directories.agentDir, 'settings.json'),
        JSON.stringify({ packages: [adapterRoot] })
      );
      await writeFile(
        join(f.directories.agentDir, 'mcp-adapter.json'),
        JSON.stringify({
          mcpServers: {
            'local-tools': { lifecycle: 'eager', url: `${local.base}/mcp/local-tools` },
          },
        })
      );
      f.capability.bound = true;
      const host = f.start();
      await f.open(host);
      const settled = await turn(host, 'turn-1', 'use both');
      expect(settled.outcome).toEqual({ assistantText: 'both served', status: 'completed' });
      expect(f.inference.requests[0]?.body.tools?.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(['mcp', 'openkit-work_echo'])
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
        f.capability.log
          .filter((entry) => entry.method === 'tools/call')
          .map((entry) => entry.params?.arguments)
      ).toEqual([{ text: 'granted' }]);
      expect(requestTexts(f.inference.requests[1]!).join('\n')).toContain('echo:local');
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
        'openkit-work_echo'
      );
      expect(f.inference.requests[0]?.body.tools?.map((tool) => tool.function.name)).not.toContain(
        'openkit-extra_echo'
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
      expect(tools).toEqual(expect.arrayContaining(['openkit-work_echo', 'openkit-extra_echo']));
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
    'keeps recognized ambient prompt and context files out of provider input',
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
      for (const marker of Object.values(markers)) expect(body).not.toContain(marker);
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
