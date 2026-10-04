// openkit-test-platform: posix
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import {
  requestTexts,
  type SyntheticInference,
  startSyntheticInference,
} from '../test-support/inference.js';
import { startSyntheticMcp } from '../test-support/mcp-http.js';
import { deepseekResidentAdapter } from './deepseek.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, cp: vi.fn(original.cp) };
});

// Cold native starts under CI scheduling took 4373.79–5844.15 ms (15232.93 ms for the successor), exceeding the five-second default.
const NATIVE_FIXTURE_TIMEOUT = 180_000;
const sessions: WorkerResidentSession[] = [];
const closers: (() => Promise<void>)[] = [];
let root: string;
let image: string;
let state: string;
let work: string;
let control: string;
let home: string;
const { cp: actualCopy } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deepseek-native-'));
  image = join(root, 'image');
  state = join(root, 'state');
  work = join(root, 'work');
  control = join(root, 'control');
  home = join(state, 'dsh-home');
  for (const path of [image, state, work, control]) mkdirSync(path);
  vi.stubEnv('HOME', image);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
  vi.mocked(filesystem.cp).mockReset();
  vi.mocked(filesystem.cp).mockImplementation((...args) => actualCopy(...args));
  rmSync(root, { recursive: true, force: true });
});

it.each(['bash', 'write'])(
  'executes native %s without ACP client filesystem or terminal services',
  async (name) => {
    const target = join(work, `${name}-effect.txt`);
    const sentinel = `native-${name}-effect`;
    const inference = await startSyntheticInference((_request, n) =>
      n === 1
        ? {
            toolCall: {
              name,
              arguments:
                name === 'bash'
                  ? {
                      command: `printf ${sentinel} > ${JSON.stringify(target)}; printf shell-observed`,
                      description: 'Write the native shell sentinel',
                    }
                  : { file_path: target, content: sentinel },
            },
          }
        : { text: 'native-ok' }
    );
    closers.push(() => inference.close());
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result).toMatchObject({ status: 'completed', assistantText: 'native-ok' });
    expect(inference.requests[0]?.body.tools?.some((tool) => tool.function.name === name)).toBe(
      true
    );
    expect(inference.requests).toHaveLength(2);
    expect(readFileSync(target, 'utf8')).toBe(sentinel);
    const toolResults = inference.requests[1]!.body.messages.filter(
      (message) => message.role === 'tool'
    );
    expect(JSON.stringify(toolResults)).toContain(
      name === 'bash' ? 'shell-observed' : 'Created file'
    );
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'executes an authored local MCP tool alongside managed MCP without granting it Gateway credentials',
  async () => {
    mkdirSync(home);
    const localScript = join(root, 'local-mcp.cjs');
    const called = join(root, 'local-mcp-call.json');
    writeFileSync(
      localScript,
      `const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } };
  if (request.method === 'tools/list') result = { tools: [{ name: 'local_echo', description: 'Local echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  if (request.method === 'tools/call') {
    writeFileSync(${JSON.stringify(called)}, JSON.stringify(request.params));
    result = { content: [{ type: 'text', text: 'local-mcp-observed:' + request.params.arguments.text }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`
    );
    const managed = await startSyntheticMcp({ managed: 'managed_echo' });
    closers.push(() => managed.close());
    const patch = JSON.stringify([
      {
        insert: [
          {
            id: 'native-local-mcp',
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              transport: 'stdio',
              serverName: 'local',
              command: process.execPath,
              args: [localScript],
              failOnStartupError: true,
              reconnect: { enabled: false },
            },
          },
        ],
      },
    ]);
    writeFileSync(join(home, 'cordis.patch.yml'), patch);
    const inference = await startSyntheticInference((_request, n) =>
      n === 1
        ? {
            toolCall: {
              name: 'mcp__local__local_echo',
              arguments: { text: 'native-call-sentinel' },
            },
          }
        : { text: 'native-ok' }
    );
    closers.push(() => inference.close());
    const session = await open(inference, null, {}, managed.url);
    const result = await (await session.startTurn(turn([], ['managed']))).settled;
    expect(result.status).toBe('completed');
    expect(inference.requests[0]?.body.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(['mcp__local__local_echo', 'mcp__managed__managed_echo'])
    );
    expect(JSON.parse(readFileSync(called, 'utf8'))).toEqual({
      name: 'local_echo',
      arguments: { text: 'native-call-sentinel' },
    });
    expect(
      managed.requests.some((request) => request.authorization === 'Bearer native-capability')
    ).toBe(true);
    expect(requestTexts(inference.requests[1]!).join('\n')).toContain(
      'local-mcp-observed:native-call-sentinel'
    );
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(patch);
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'loads authored home and workspace instructions into the model request without changing their bytes',
  async () => {
    mkdirSync(home);
    const authored = [
      [join(home, 'AGENTS.md'), 'HOME-INSTRUCTION-SENTINEL'],
      [join(work, 'AGENTS.md'), 'WORKSPACE-INSTRUCTION-SENTINEL'],
    ] as const;
    for (const [file, text] of authored) writeFileSync(file, text);
    const inference = await server();
    const session = await open(inference);
    expect((await (await session.startTurn(turn())).settled).status).toBe('completed');
    const modelText = requestTexts(inference.requests[0]!).join('\n');
    for (const [file, text] of authored) {
      expect(modelText).toContain(text);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'restores omitted protected rows in a native profile while retaining its other capabilities',
  async () => {
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
    const native = createRequire(anchor);
    const boot = await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-app-boot')).href);
    const base = readFileSync(
      join(boot.resolveBundleDir('dsh', '@deepseek-ai/dsh-base', anchor, home), 'cordis.patch.yml'),
      'utf8'
    );
    const omitted = "    - id: llm-pi-ai\n      name: '@deepseek-ai/dsh-llm-pi-ai'\n";
    expect(base).toContain(omitted);
    const profile = join(home, 'profiles', 'acp');
    mkdirSync(profile, { recursive: true });
    const manifest = JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } });
    const patch =
      base.replace(omitted, '') +
      '\n- insert:\n    - id: acp-app-startup\n      name: "@deepseek-ai/dsh-acp-app"\n';
    writeFileSync(join(profile, 'package.json'), manifest);
    writeFileSync(join(profile, 'cordis.patch.yml'), patch);
    const inference = await server();
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.nativeConfiguration).toMatch(/warning.*protected/i);
    expect(inference.requests[0]?.body.model).toBe('probe-model');
    expect(inference.requests[0]?.headers.authorization).toBe('Bearer native-inference');
    expect(inference.requests[0]?.body.tools?.some((tool) => tool.function.name === 'bash')).toBe(
      true
    );
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch);
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest);
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'copies an image default before a real native Turn and ignores a redirected input HOME',
  async () => {
    const source = join(image, '.dsh');
    mkdirSync(source);
    skill(join(source, 'skills'), 'image-default');
    writeFileSync(
      join(source, 'cordis.patch.yml'),
      `- id: skill-filesystem\n  config:\n    watch: false\n    customSkillDirs: [${JSON.stringify(join(source, 'skills'))}]\n`
    );
    const original = snapshot(source);
    const inference = await server();
    const session = await open(inference, null, { HOME: join(root, 'wrong-source') });
    expect(snapshot(home)).toEqual(original);
    const result = await (await session.startTurn(turn())).settled;
    expect(result).toMatchObject({ status: 'completed', assistantText: 'native-ok' });
    expect(requestTexts(inference.requests[0]!).join('\n')).toContain('image-default');
    expect(snapshot(source)).toEqual(original);
  },
  NATIVE_FIXTURE_TIMEOUT
);

it('reuses an existing home byte for byte even when the image source changes or is unsafe', async () => {
  mkdirSync(home);
  writeFileSync(join(home, 'opaque-native-record'), Buffer.from([0, 255, 42]));
  writeFileSync(join(home, 'cordis.patch.yml'), '[] # existing empty configuration\n');
  const source = join(image, '.dsh');
  mkdirSync(source);
  symlinkSync(work, join(source, 'escape'));
  const before = snapshot(home);
  const inference = await server();
  const session = await open(inference);
  expect(session.childState()).toBe('absent');
  expect(snapshot(home)).toEqual(before);
  writeFileSync(join(source, 'changed'), 'new image bytes');
  await session.close();
  await open(inference);
  expect(snapshot(home)).toEqual(before);
});

it.each([
  'unreadable',
  'special',
  'escape',
  'staging',
])('refuses %s initialization before native work without changing retained bytes', async (kind) => {
  writeFileSync(join(state, 'retained-canary'), 'unchanged');
  const source = join(image, '.dsh');
  mkdirSync(source);
  const entry = join(source, 'entry');
  if (kind === 'escape') symlinkSync(work, entry);
  if (kind === 'special') expect(spawnSync('mkfifo', [entry]).status).toBe(0);
  if (kind === 'unreadable') {
    writeFileSync(entry, 'unreadable');
    chmodSync(entry, 0);
  }
  if (kind === 'staging') {
    mkdirSync(`${home}.initializing`);
    writeFileSync(join(`${home}.initializing`, 'partial'), 'leave me');
  }
  const before = snapshot(state);
  const inference = await server();
  try {
    await expect(open(inference)).rejects.toThrow();
    expect(snapshot(state)).toEqual(before);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(`${home}.initializing`)).toBe(kind === 'staging');
    expect(readdirSync(control)).toEqual([]);
    expect(inference.requests).toHaveLength(0);
  } finally {
    if (kind === 'unreadable') chmodSync(entry, 0o600);
  }
});

it('creates an empty home with no source and does not read a source inside stateRoot', async () => {
  const inference = await server();
  await open(inference);
  expect(snapshot(home)).toEqual({});
  await sessions.pop()!.close();
  rmSync(home, { recursive: true });
  vi.stubEnv('HOME', state);
  mkdirSync(join(state, '.dsh'));
  writeFileSync(join(state, '.dsh', 'not-an-image'), 'keep');
  await open(inference);
  expect(snapshot(home)).toEqual({});
  expect(readFileSync(join(state, '.dsh', 'not-an-image'), 'utf8')).toBe('keep');
});

it.each([false, true])(
  'keeps native profile, custom and default Skill roots with managed supply=%s',
  async (managed) => {
    mkdirSync(home);
    const local = join(root, 'local');
    skill(local, 'local-custom');
    skill(join(home, 'skills'), 'local-default');
    skill(join(work, '.agents', 'skills'), 'workspace-default');
    const selected = join(root, 'selected');
    skill(selected, 'managed-current');
    const profile = join(home, 'profiles', 'acp');
    mkdirSync(profile, { recursive: true });
    // The native ACP profile's own preference survives; protected model preferences are shadowed.
    const patch = `- id: skill-filesystem\n  config:\n    watch: false\n    customSkillDirs: [${JSON.stringify(local)}]\n- id: acp\n  config:\n    provider: benign-native-preference\n    model: benign-native-model\n`;
    writeFileSync(join(profile, 'cordis.patch.yml'), patch);
    const mcp = await startSyntheticMcp({ 'native-managed': 'managed_echo' });
    closers.push(() => mcp.close());
    const inference = await server();
    const session = await open(inference, null, {}, mcp.url);
    const result = await (
      await session.startTurn(turn(managed ? [selected] : [], managed ? ['native-managed'] : []))
    ).settled;
    expect(result.status).toBe('completed');
    const text = requestTexts(inference.requests[0]!).join('\n');
    for (const name of ['local-custom', 'local-default', 'workspace-default'])
      expect(text).toContain(name);
    expect(text.includes('managed-current')).toBe(managed);
    expect(inference.requests[0]?.body.model).toBe('probe-model');
    expect(inference.requests[0]?.headers.authorization).toBe('Bearer native-inference');
    expect(mcp.requests.some((request) => request.method === 'tools/list')).toBe(managed);
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch);
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'removes a stale managed root on exact successor resume while retaining a local root',
  async () => {
    mkdirSync(home);
    const local = join(root, 'local');
    skill(local, 'local-survives');
    writeFileSync(
      join(home, 'cordis.patch.yml'),
      `- id: skill-filesystem\n  config:\n    watch: false\n    customSkillDirs: [${JSON.stringify(local)}]\n`
    );
    const stale = join(root, 'stale');
    skill(stale, 'managed-stale');
    const inference = await server();
    const first = await open(inference);
    expect((await (await first.startTurn(turn([stale]))).settled).status).toBe('completed');
    expect(requestTexts(inference.requests[0]!).join('\n')).toContain('managed-stale');
    const handle = await first.nativeHandle();
    if (handle.state !== 'ready') throw new Error('Expected ready native session');
    await first.close();
    const successor = await open(inference, handle.reference);
    expect((await (await successor.startTurn(turn())).settled).status).toBe('completed');
    const currentSystem =
      [
        ...requestTexts(inference.requests.at(-1)!)
          .join('\n')
          .matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g),
      ].at(-1)?.[1] ?? '';
    expect(currentSystem).toContain('local-survives');
    expect(currentSystem).not.toContain('managed-stale');
    expect(await successor.nativeHandle()).toEqual(handle);
  },
  NATIVE_FIXTURE_TIMEOUT
);

it.each(['acp', 'llm-pi-ai'])(
  'overrides a native disabled %s binding with a warning and unchanged user bytes',
  async (id) => {
    mkdirSync(home);
    writeFileSync(join(home, 'cordis.patch.yml'), `- id: ${id}\n  disabled: true\n`);
    const before = snapshot(state);
    const inference = await server();
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.nativeConfiguration).toMatch(/warning.*protected/i);
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(
      Buffer.from(before['dsh-home/cordis.patch.yml']!, 'base64').toString()
    );
    expect(inference.requests[0]?.body.model).toBe('probe-model');
    expect(inference.requests[0]?.headers.authorization).toBe('Bearer native-inference');
  },
  NATIVE_FIXTURE_TIMEOUT
);

it('refuses publication over a child created during staging and leaves both trees intact', async () => {
  const source = join(image, '.dsh');
  mkdirSync(source);
  writeFileSync(join(source, 'seed'), 'source');
  vi.mocked(filesystem.cp).mockImplementationOnce(async (...args) => {
    await actualCopy(...args);
    mkdirSync(home);
  });
  const inference = await server();
  await expect(open(inference)).rejects.toThrow(/created during initialization/);
  expect(snapshot(home)).toEqual({});
  expect(readFileSync(join(`${home}.initializing`, 'seed'), 'utf8')).toBe('source');
  expect(inference.requests).toHaveLength(0);
});

it('refuses an existing native home link outside the retained root', async () => {
  symlinkSync(work, home);
  writeFileSync(join(work, 'canary'), 'unchanged');
  const inference = await server();
  await expect(open(inference)).rejects.toThrow(/retained root/);
  expect(readFileSync(join(work, 'canary'), 'utf8')).toBe('unchanged');
  expect(readdirSync(control)).toEqual([]);
});

it('does not seed from a source whose canonical path is inside the retained root', async () => {
  const inside = join(state, 'inside');
  mkdirSync(inside);
  writeFileSync(join(inside, 'record'), 'keep');
  symlinkSync(inside, join(image, '.dsh'));
  const inference = await server();
  await open(inference);
  expect(snapshot(home)).toEqual({});
  expect(readFileSync(join(inside, 'record'), 'utf8')).toBe('keep');
});

it('refuses a designated source that is not a directory', async () => {
  writeFileSync(join(image, '.dsh'), 'invalid-native-home');
  const inference = await server();
  await expect(open(inference)).rejects.toThrow(/directory/);
  expect(existsSync(home)).toBe(false);
});

it('copies contained links and refuses an internal traversal cycle without publication', async () => {
  const source = join(image, '.dsh');
  mkdirSync(source);
  writeFileSync(join(source, 'real'), 'inside');
  symlinkSync('real', join(source, 'link'));
  const inference = await server();
  await open(inference);
  expect(readFileSync(join(home, 'link'), 'utf8')).toBe('inside');
  await sessions.pop()!.close();
  rmSync(home, { recursive: true });
  symlinkSync('.', join(source, 'cycle'));
  await expect(open(inference)).rejects.toThrow();
  expect(existsSync(home)).toBe(false);
});

it(
  'replaces a previous managed provider row and preserves the native local provider',
  async () => {
    mkdirSync(home);
    const local = join(root, 'local');
    skill(local, 'local-survives');
    const stale = join(root, 'stale');
    skill(stale, 'managed-stale');
    writeFileSync(
      join(home, 'cordis.patch.yml'),
      `- id: skill-filesystem\n  config:\n    watch: false\n    customSkillDirs: [${JSON.stringify(local)}]\n- insert:\n    - id: openkit-managed-skills\n      name: "@deepseek-ai/dsh-skill-filesystem"\n      config:\n        providerName: openkit-managed\n        includeDefaultRoots: false\n        watch: false\n        customSkillDirs: [${JSON.stringify(stale)}]\n`
    );
    const inference = await server();
    const session = await open(inference);
    expect((await (await session.startTurn(turn())).settled).status).toBe('completed');
    const text = requestTexts(inference.requests[0]!).join('\n');
    expect(text).toContain('local-survives');
    expect(text).not.toContain('managed-stale');
  },
  NATIVE_FIXTURE_TIMEOUT
);

it('does not mistake an inaccessible designated source for absence', async () => {
  mkdirSync(join(image, '.dsh'));
  chmodSync(image, 0);
  const inference = await server();
  try {
    await expect(open(inference)).rejects.toThrow();
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(control)).toEqual([]);
  } finally {
    chmodSync(image, 0o700);
  }
});

it('refuses a dangling staging link and leaves it untouched', async () => {
  symlinkSync('missing-staging-target', `${home}.initializing`);
  const before = snapshot(state);
  const inference = await server();
  await expect(open(inference)).rejects.toThrow(/incomplete/);
  expect(snapshot(state)).toEqual(before);
});

it(
  'overrides a protected conflict in image defaults without editing source or copied profile',
  async () => {
    const source = join(image, '.dsh');
    mkdirSync(source);
    writeFileSync(join(source, 'cordis.patch.yml'), '- id: acp\n  disabled: true\n');
    const before = snapshot(source);
    const inference = await server();
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.nativeConfiguration).toMatch(/warning.*protected/i);
    expect(snapshot(source)).toEqual(before);
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(
      '- id: acp\n  disabled: true\n'
    );
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'overrides a disabled row in a retained native profile manifest without modifying user bytes',
  async () => {
    const profile = join(home, 'profiles', 'acp');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
      })
    );
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: acp\n  disabled: true\n');
    const before = snapshot(state);
    const inference = await server();
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.nativeConfiguration).toMatch(/warning.*protected/i);
    for (const file of ['package.json', 'cordis.patch.yml'])
      expect(readFileSync(join(profile, file)).toString('base64')).toBe(
        before[`dsh-home/profiles/acp/${file}`]
      );
  },
  NATIVE_FIXTURE_TIMEOUT
);

it('refuses leftover staging even when there is no image source', async () => {
  mkdirSync(`${home}.initializing`);
  writeFileSync(join(`${home}.initializing`, 'partial'), 'keep');
  const before = snapshot(state);
  const inference = await server();
  await expect(open(inference)).rejects.toThrow(/incomplete/);
  expect(snapshot(state)).toEqual(before);
  expect(existsSync(home)).toBe(false);
});

it('does not seed from a lexical source inside stateRoot linked to an outside directory', async () => {
  writeFileSync(join(work, 'record'), 'outside');
  vi.stubEnv('HOME', state);
  symlinkSync(work, join(state, '.dsh'));
  const inference = await server();
  await open(inference);
  expect(snapshot(home)).toEqual({});
  expect(readFileSync(join(work, 'record'), 'utf8')).toBe('outside');
});

it.each(['disabled', 'substituted', 'grouped'])(
  'overrides the effective %s protected row after a native duplicate-id insert',
  async (kind) => {
    mkdirSync(home);
    writeFileSync(
      join(home, 'cordis.patch.yml'),
      `- insert:\n    - id: acp\n      name: "${kind === 'disabled' ? '@deepseek-ai/dsh-acp' : '@deepseek-ai/dsh-llm-pi-ai'}"\n${kind === 'disabled' ? '      disabled: true\n' : ''}`
    );
    if (kind === 'grouped') {
      const local = join(root, 'grouped-local');
      skill(local, 'nested-native-sibling');
      writeFileSync(
        join(home, 'cordis.patch.yml'),
        '- insert:\n    - id: probe-group\n      name: "@deepseek-ai/cordis-plugin-group"\n      group: true\n      config:\n        - id: acp\n          name: "@deepseek-ai/dsh-acp"\n          disabled: true\n        - id: nested-skills\n          name: "@deepseek-ai/dsh-skill-filesystem"\n          config:\n            providerName: nested-native\n            includeDefaultRoots: false\n            watch: false\n            customSkillDirs: [' +
          JSON.stringify(local) +
          ']\n'
      );
    }
    const before = snapshot(state);
    const inference = await server();
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.nativeConfiguration).toMatch(/warning.*protected/i);
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(
      Buffer.from(before['dsh-home/cordis.patch.yml']!, 'base64').toString()
    );
    expect(inference.requests[0]?.body.model).toBe('probe-model');
    expect(inference.requests[0]?.headers.authorization).toBe('Bearer native-inference');
    if (kind === 'grouped')
      expect(requestTexts(inference.requests[0]!).join('\n')).toContain('nested-native-sibling');
  },
  NATIVE_FIXTURE_TIMEOUT
);

it(
  'overrides a disabled native group containing the protected ACP implementation',
  async () => {
    mkdirSync(home);
    writeFileSync(
      join(home, 'cordis.patch.yml'),
      '- id: acp\n  group: true\n  disabled: true\n  config:\n    - id: acp\n      name: "@deepseek-ai/dsh-acp"\n'
    );
    const before = snapshot(state);
    const inference = await server();
    const session = await open(inference);
    const result = await (await session.startTurn(turn())).settled;
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.nativeConfiguration).toMatch(/warning.*protected/i);
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(
      Buffer.from(before['dsh-home/cordis.patch.yml']!, 'base64').toString()
    );
  },
  NATIVE_FIXTURE_TIMEOUT
);

/** Writes a discoverable native Skill under one root. */
function skill(directory: string, name: string): void {
  const path = join(directory, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Native ${name} sentinel.\n---\nUse ${name}.\n`
  );
}
/** Snapshots every ordinary native byte before process loading. */
function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      const entry = lstatSync(file);
      if (entry.isSymbolicLink()) result[prefix + name] = `link:${readlinkSync(file)}`;
      else if (entry.isDirectory()) {
        result[`${prefix}${name}/`] = 'directory';
        walk(file, `${prefix}${name}/`);
      } else result[prefix + name] = readFileSync(file).toString('base64');
    }
  };
  walk(directory, '');
  return result;
}
/** Uses the existing synthetic loopback provider with the real runtime. */
async function server(): Promise<SyntheticInference> {
  const inference = await startSyntheticInference(() => ({ text: 'native-ok' }));
  closers.push(() => inference.close());
  return inference;
}
/** Opens the real adapter while keeping the image source separate from launch environment. */
async function open(
  inference: SyntheticInference,
  resumeReference: Uint8Array | null = null,
  environment: Record<string, string> = {},
  capabilityBaseUrl = 'http://127.0.0.1:9'
): Promise<WorkerResidentSession> {
  const input: WorkerResidentOpenInput = {
    agentSessionId: 'native-test',
    controlRoot: control,
    stateRoot: state,
    resumeReference,
    environment: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), ...environment },
    loopback: {
      inferenceBaseUrl: inference.url,
      inferenceCredential: 'native-inference',
      capabilityBaseUrl,
      capabilityCredential: 'native-capability',
    },
  };
  const session = await deepseekResidentAdapter.openSession(input);
  sessions.push(session);
  return session;
}
/** Supplies the protected catalog and selected resources at the actual Turn boundary. */
function turn(skills: string[] = [], mcpServerIds: string[] = []): WorkerResidentTurnInput {
  const route = {
    credentialVisibility: 'none' as const,
    endpoint: {
      kind: 'openai-compatible' as const,
      upstream: { kind: 'nanocore-gateway' as const },
    },
    id: 'native-route',
    model: 'probe-model',
    providerInstanceId: 'native-provider',
  };
  return {
    allowedLlmRoutes: [route],
    llmRoute: route,
    mcpServerIds,
    skillTargetPaths: skills.map((targetPath, index) => ({ id: `skill-${index}`, targetPath })),
    turnDirectory: work,
    turnId: 'native-turn',
    turnInput: 'NATIVEWORD',
    workingDirectory: work,
    runtimeCapture: {
      captureCoverage: { scope: 'workspace', value: 'off' },
      credentialValues: ['native-inference', 'native-capability'],
      emit: async () => undefined,
      packageSnapshotId: 'native-snapshot',
    },
  };
}
