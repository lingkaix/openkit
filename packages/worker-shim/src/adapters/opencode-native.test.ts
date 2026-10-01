// openkit-test-platform: posix

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkerResidentSession, WorkerResidentTurnInput } from '../adapter-registry.js';
import { startSyntheticCapability } from '../test-support/synthetic-capability.js';
import { requestTexts, startSyntheticInference } from '../test-support/synthetic-inference.js';
import { createOpenCodeAdapter, OPENCODE_PROVIDER_ID, opencodeAdapter } from './opencode.js';

let root: string;
let image: string;
let state: string;
let work: string;
let control: string;
let home: string;
const copyFault = vi.hoisted(() => ({ afterCopy: null as null | (() => void) }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    cp: async (...args: Parameters<typeof fs.cp>) => {
      await fs.cp(...args);
      copyFault.afterCopy?.();
    },
  };
});

const sessions: WorkerResidentSession[] = [];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-native-'));
  image = join(root, 'image');
  state = join(root, 'state');
  work = join(root, 'workspace');
  control = join(root, 'control');
  home = join(state, 'config');
  for (const path of [image, state, work, control]) mkdirSync(path);
  copyFault.afterCopy = null;
  vi.stubEnv('HOME', image);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Native Skills contain their own discoverable description and content. */
function skill(parent: string, id: string): string {
  const path = join(parent, id);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id}-description\n---\n${id}-content\n`
  );
  return path;
}

/** Captures authored bytes without assigning meaning to retained native filenames. */
function snapshot(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [file.slice(path.length + 1), readFileSync(file).toString('base64')];
      })
  );
}

/** Creates an actual pinned resident binding over synthetic endpoints. */
async function fixture(
  adapter = opencodeAdapter,
  resumeReference: Uint8Array | null = null,
  reply: Parameters<typeof startSyntheticInference>[0] = () => ({ text: 'native-ok' })
) {
  const inference = await startSyntheticInference(reply);
  const capability = await startSyntheticCapability();
  closers.push(
    () => inference.close(),
    () => capability.close()
  );
  const loopback = {
    inferenceBaseUrl: inference.url,
    inferenceCredential: 'synthetic-inference-credential',
    capabilityBaseUrl: capability.url,
    capabilityCredential: 'synthetic-capability-credential',
  };
  const session = await adapter.openSession({
    agentSessionId: 'as-native',
    stateRoot: state,
    controlRoot: control,
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'wrong-image') },
    loopback,
    resumeReference,
  });
  sessions.push(session);
  const route = {
    id: 'managed',
    model: 'native-model',
    providerInstanceId: 'evidence',
    credentialVisibility: 'placeholder' as const,
    endpoint: {
      kind: 'openai-compatible' as const,
      upstream: { kind: 'nanocore-gateway' as const },
      workerBaseUrl: inference.url,
    },
  };
  const turn = (skills: string[] = [], ids: string[] = []): WorkerResidentTurnInput => ({
    turnId: 'turn-native',
    turnInput: 'native-user',
    workingDirectory: work,
    turnDirectory: join(root, 'turn'),
    allowedLlmRoutes: [route],
    llmRoute: route,
    mcpServerIds: ids,
    skillTargetPaths: skills.map((targetPath) => ({
      id: targetPath.split('/').at(-1)!,
      targetPath,
    })),
    runtimeCapture: {
      captureCoverage: { scope: 'server', value: 'off' },
      credentialValues: [],
      emit: async () => undefined,
      packageSnapshotId: 'native',
    },
  });
  return { session, inference, capability, turn };
}

it.each([
  false,
  true,
])('loads native home and Workspace resources beside managed supply=%s', async (managed) => {
  mkdirSync(home);
  skill(join(home, 'skills'), 'home-skill');
  skill(join(work, '.opencode', 'skills'), 'local-skill');
  const managedPath = skill(join(root, 'selected'), 'managed-skill');
  // A native same-id Skill must not replace the current managed projection.
  skill(join(work, '.opencode', 'skills'), 'managed-skill');
  writeFileSync(
    join(work, '.opencode', 'skills', 'managed-skill', 'SKILL.md'),
    '---\nname: managed-skill\ndescription: stale-native-description\n---\nstale\n'
  );
  const marker = join(root, 'plugin-loaded');
  const plugin = join(root, 'plugin');
  mkdirSync(plugin);
  writeFileSync(join(plugin, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(plugin, 'index.js'),
    `import {writeFileSync} from 'node:fs'; export default {id:'native-local',async setup(){writeFileSync(${JSON.stringify(marker)},'loaded')}};`
  );
  const local = await startSyntheticCapability();
  closers.push(() => local.close());
  const config = JSON.stringify({
    model: 'ignored/benign-preference',
    agents: { build: { system: 'native-setting-marker' } },
    plugins: [plugin],
    mcp: {
      servers: {
        local: { type: 'remote', url: `${local.url}/mcp/local`, oauth: false, codemode: false },
      },
    },
  });
  writeFileSync(join(work, 'opencode.json'), config);
  const before = snapshot(home);
  const f = await fixture();
  const result = await (
    await f.session.startTurn(f.turn(managed ? [managedPath] : [], managed ? ['selected'] : []))
  ).settled;
  expect(result.status, JSON.stringify(result.diagnostics)).toBe('completed');
  const request = f.inference.requests.findLast((entry) =>
    requestTexts(entry).join(' ').includes('native-user')
  )!;
  const text = requestTexts(request).join('\n');
  expect(text).toContain('native-setting-marker');
  expect(text).toContain('home-skill-description');
  expect(text).toContain('local-skill-description');
  expect(text).toContain(managed ? 'managed-skill-description' : 'stale-native-description');
  if (managed) expect(text).not.toContain('stale-native-description');
  const tools = JSON.stringify(request.body.tools);
  expect(tools + text).toContain('echo-local');
  expect(tools.includes('echo-selected')).toBe(managed);
  expect(existsSync(marker)).toBe(true);
  expect(local.hits.some((hit) => hit.method === 'tools/list')).toBe(true);
  expect(local.hits.every((hit) => hit.authorization === null)).toBe(true);
  if (managed)
    expect(
      f.capability.hits.some(
        (hit) => hit.authorization === 'Bearer synthetic-capability-credential'
      )
    ).toBe(true);
  expect(request.body.model).toBe('native-model');
  expect(request.headers.authorization).toBe('Bearer synthetic-inference-credential');
  await f.session.close();
  expect(snapshot(home)).toEqual(before);
  expect(readFileSync(join(work, 'opencode.json'), 'utf8')).toBe(config);
}, 60000);

it('initializes image defaults once and applies them on a native Turn', async () => {
  const source = join(image, '.config', 'opencode');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'opencode.json'),
    JSON.stringify({ agents: { build: { system: 'image-default-marker' } } })
  );
  skill(join(source, 'skills'), 'image-skill');
  const original = snapshot(source);
  const f = await fixture();
  expect(snapshot(home)).toEqual(original);
  expect((await (await f.session.startTurn(f.turn())).settled).status).toBe('completed');
  expect(
    requestTexts(
      f.inference.requests.findLast((r) => requestTexts(r).join(' ').includes('native-user'))!
    ).join(' ')
  ).toContain('image-default-marker');
  expect(snapshot(home)).toEqual(original);
  expect(snapshot(source)).toEqual(original);
  const handle = await f.session.nativeHandle();
  expect(handle.state).toBe('ready');
  if (handle.state !== 'ready') throw new Error('missing reference');
  await f.session.close();
  writeFileSync(join(source, 'opencode.json'), '{"agents":{"build":{"system":"changed-source"}}}');
  symlinkSync(work, join(source, 'escape'));
  control = join(root, 'successor-control');
  mkdirSync(control);
  const successor = await fixture(opencodeAdapter, handle.reference);
  expect(await successor.session.nativeHandle()).toEqual(handle);
  expect(snapshot(home)).toEqual(original);
  expect((await (await successor.session.startTurn(successor.turn())).settled).status).toBe(
    'completed'
  );
  const text = requestTexts(
    successor.inference.requests.findLast((r) => requestTexts(r).join(' ').includes('native-user'))!
  ).join(' ');
  expect(text).toContain('image-default-marker');
  expect(text).not.toContain('changed-source');
  expect(snapshot(home)).toEqual(original);
}, 60000);

it.each([
  'unreadable',
  'source-parent',
  'escape',
  'staging',
  'destination',
  'special',
])('refuses %s initialization before native work and preserves retained bytes', async (kind) => {
  const source = join(image, '.config', 'opencode');
  mkdirSync(source, { recursive: true });
  const entry = join(source, 'entry');
  if (kind === 'source-parent') chmodSync(join(image, '.config'), 0);
  if (kind === 'special') {
    writeFileSync(join(source, 'a-readable'), 'must-not-stage');
    expect(spawnSync('/usr/bin/mkfifo', [entry]).status).toBe(0);
  }
  if (kind === 'escape') symlinkSync(work, entry);
  if (kind === 'unreadable') {
    writeFileSync(join(source, 'a-readable'), 'must-not-stage');
    writeFileSync(entry, 'unreadable');
    chmodSync(entry, 0);
  }
  if (kind === 'staging') {
    mkdirSync(`${home}.initializing`);
    writeFileSync(join(`${home}.initializing`, 'partial'), 'keep');
  }
  if (kind === 'destination') symlinkSync(work, home);
  writeFileSync(join(state, 'retained-canary'), 'unchanged');
  const before = snapshot(state);
  try {
    await expect(fixture()).rejects.toThrow(/EACCES|image source|initialization|native home|FIFO/);
    expect(snapshot(state)).toEqual(before);
    if (['unreadable', 'escape', 'special', 'source-parent'].includes(kind)) {
      expect(existsSync(`${home}.initializing`)).toBe(false);
    }
    expect(readdirSync(control)).toEqual([]);
  } finally {
    if (kind === 'unreadable') chmodSync(entry, 0o600);
    if (kind === 'source-parent') chmodSync(join(image, '.config'), 0o700);
  }
});

it.each([
  'provider',
  'mcp',
  'mcp-stdio',
])('overlays a native %s collision without editing configuration', async (kind) => {
  const config = JSON.stringify(
    kind === 'provider'
      ? {
          providers: {
            [OPENCODE_PROVIDER_ID]: {
              canonical: 'openai',
              package: '@ai-sdk/openai-compatible',
              models: {
                injected: {},
                'native-model': {
                  modelID: 'foreign-model',
                  package: 'file:///synthetic-missing-provider.js',
                  headers: { authorization: 'Bearer synthetic-native-credential' },
                },
              },
              headers: { authorization: 'Bearer synthetic-native-credential' },
              settings: { baseURL: 'http://127.0.0.1:9/foreign' },
            },
          },
        }
      : {
          mcp: {
            servers: {
              selected:
                kind === 'mcp'
                  ? { type: 'remote', url: 'http://127.0.0.1:9/mcp/selected', oauth: false }
                  : { type: 'local', command: ['/usr/bin/false'] },
            },
          },
        }
  );
  writeFileSync(join(work, 'opencode.json'), config);
  const f = await fixture();
  const result = await (
    await f.session.startTurn(f.turn([], kind !== 'provider' ? ['selected'] : []))
  ).settled;
  expect(result.status, JSON.stringify(result.diagnostics)).toBe('completed');
  expect(result.diagnostics?.native).toContain('protected');
  const request = f.inference.requests.findLast((entry) =>
    requestTexts(entry).join(' ').includes('native-user')
  )!;
  expect(request.body.model).toBe('native-model');
  expect(request.headers.authorization).toBe('Bearer synthetic-inference-credential');
  if (kind !== 'provider') {
    expect(JSON.stringify(request.body.tools)).toContain('echo-selected');
    expect(f.capability.hits.some((hit) => hit.method === 'tools/list')).toBe(true);
    expect(
      f.capability.hits.every(
        (hit) => hit.authorization === 'Bearer synthetic-capability-credential'
      )
    ).toBe(true);
  }
  expect(readFileSync(join(work, 'opencode.json'), 'utf8')).toBe(config);
  await expect(f.session.close()).resolves.toBeUndefined();
}, 60000);

it('shadows a declared host-plugin disable with the protected inline plugin', async () => {
  const config =
    '{"plugins":["-openkit-loopback"],"agents":{"build":{"system":"declared-disable-shadowed"}}}';
  writeFileSync(join(work, 'opencode.json'), config);
  const f = await fixture();
  expect((await (await f.session.startTurn(f.turn())).settled).status).toBe('completed');
  expect(f.inference.requests.at(-1)?.headers.authorization).toBe(
    'Bearer synthetic-inference-credential'
  );
  expect(requestTexts(f.inference.requests.at(-1)!).join(' ')).toContain(
    'declared-disable-shadowed'
  );
  expect(readFileSync(join(work, 'opencode.json'), 'utf8')).toBe(config);
}, 60000);

it.each([
  'lexical',
  'canonical',
])('does not seed from a %s source inside retained state', async (kind) => {
  const retainedImage = join(state, 'retained-image');
  const source = join(retainedImage, '.config', 'opencode');
  if (kind === 'lexical') {
    const outside = join(image, 'outside');
    mkdirSync(outside);
    mkdirSync(join(retainedImage, '.config'), { recursive: true });
    symlinkSync(outside, source);
  } else mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'canary'), 'not-an-image-default');
  if (kind === 'lexical') vi.stubEnv('HOME', retainedImage);
  else {
    symlinkSync(retainedImage, join(image, 'alias'));
    vi.stubEnv('HOME', join(image, 'alias'));
  }
  const f = await fixture();
  expect(existsSync(home)).toBe(true);
  expect(snapshot(home)).toEqual({});
  expect(readFileSync(join(source, 'canary'), 'utf8')).toBe('not-an-image-default');
  await f.session.close();
}, 60000);

it('does not overwrite a destination published during image copying', async () => {
  const source = join(image, '.config', 'opencode');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'default'), 'image');
  copyFault.afterCopy = () => mkdirSync(home);
  await expect(fixture()).rejects.toThrow(/created during initialization/);
  expect(snapshot(home)).toEqual({});
  expect(readFileSync(join(`${home}.initializing`, 'default'), 'utf8')).toBe('image');
  expect(readdirSync(control)).toEqual([]);
});

it('refuses a managed Skill id outside its projection root before provider work', async () => {
  const f = await fixture();
  const turn = f.turn();
  await expect(
    f.session.startTurn({ ...turn, skillTargetPaths: [{ id: '../escape', targetPath: work }] })
  ).rejects.toThrow(/Skill id escapes/);
  expect(f.inference.requests).toHaveLength(0);
  expect(existsSync(join(control, 'escape'))).toBe(false);
}, 60000);

it('requires an exact successor to clear managed Skills while preserving native Skills', async () => {
  mkdirSync(home);
  skill(join(home, 'skills'), 'native-stays');
  const selected = skill(join(root, 'selected'), 'selected-goes');
  const f = await fixture();
  expect((await (await f.session.startTurn(f.turn([selected]))).settled).status).toBe('completed');
  const count = f.inference.requests.length;
  await expect(f.session.startTurn(f.turn())).rejects.toThrow(/supply change needs a successor/);
  expect(f.inference.requests).toHaveLength(count);
  const handle = await f.session.nativeHandle();
  if (handle.state !== 'ready') throw new Error('missing reference');
  await f.session.close();
  control = join(root, 'successor-control');
  mkdirSync(control);
  const successor = await fixture(opencodeAdapter, handle.reference);
  expect((await (await successor.session.startTurn(successor.turn())).settled).status).toBe(
    'completed'
  );
  const text = requestTexts(
    successor.inference.requests.findLast((r) => requestTexts(r).join(' ').includes('native-user'))!
  ).join(' ');
  expect(text).toContain('native-stays-description');
  // Exact native history retains the earlier catalog; the native removal update is authoritative.
  expect(text).toContain(
    'The following skill IDs are no longer available and must not be used: selected-goes.'
  );
}, 60000);

it.each([
  'id',
  'path',
])('refuses a loopback credential in a managed Skill %s before native projection', async (field) => {
  const f = await fixture();
  const selected =
    field === 'path' ? skill(join(root, 'synthetic-capability-credential'), 'safe-skill') : work;
  const input = {
    ...f.turn(),
    skillTargetPaths: [
      {
        id: field === 'id' ? 'synthetic-inference-credential' : 'safe-skill',
        targetPath: selected,
      },
    ],
  };
  await expect(f.session.startTurn(input)).rejects.toThrow(/contains a loopback credential/);
  expect(f.inference.requests).toHaveLength(0);
  expect(readdirSync(join(control, 'skills'))).toEqual([]);
}, 60000);

it('loads a native MCP name outside the managed id pattern', async () => {
  const local = await startSyntheticCapability();
  closers.push(() => local.close());
  const config = JSON.stringify({
    mcp: {
      servers: {
        'local.test': {
          type: 'remote',
          url: `${local.url}/mcp/local.test`,
          oauth: false,
          codemode: false,
        },
      },
    },
  });
  writeFileSync(join(work, 'opencode.json'), config);
  const f = await fixture();
  expect((await (await f.session.startTurn(f.turn())).settled).status).toBe('completed');
  expect(
    local.hits.some((hit) => hit.serverId === 'local.test' && hit.method === 'tools/list')
  ).toBe(true);
  expect(local.hits.every((hit) => hit.authorization === null)).toBe(true);
  const request = f.inference.requests.findLast((entry) =>
    requestTexts(entry).join(' ').includes('native-user')
  )!;
  // The pin sanitizes dotted native names when rendering provider function names.
  expect(JSON.stringify(request.body.tools)).toContain('"name":"local_test_echo-local_test"');
  expect(readFileSync(join(work, 'opencode.json'), 'utf8')).toBe(config);
}, 60000);

it('refuses a regular-file image source root before spawn without publishing a home', async () => {
  mkdirSync(join(image, '.config'));
  const source = join(image, '.config', 'opencode');
  writeFileSync(source, 'invalid-directory-source');
  writeFileSync(join(state, 'retained-canary'), 'unchanged');
  const before = snapshot(state);
  const spawn = vi.fn(() => {
    throw new Error('native spawn sentinel reached');
  });
  const adapter = createOpenCodeAdapter({ spawnServer: spawn });
  const error = await fixture(adapter).then(
    () => null,
    (failure: unknown) => failure
  );
  expect(spawn).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/image source root must be a directory/);
  expect(existsSync(home)).toBe(false);
  expect(existsSync(`${home}.initializing`)).toBe(false);
  expect(snapshot(state)).toEqual(before);
  expect(readFileSync(source, 'utf8')).toBe('invalid-directory-source');
  expect(readdirSync(control)).toEqual([]);
});

it.each([
  'shell',
  'write',
])('executes a model-directed workspace %s and observes its effect', async (tool) => {
  const target = join(work, `${tool}-effect.txt`);
  let called = false;
  const f = await fixture(opencodeAdapter, null, (request) => {
    const names = request.body.tools?.map((entry) => entry.function?.name) ?? [];
    if (
      !called &&
      names.includes(tool) &&
      requestTexts(request).join(' ').includes('native-user')
    ) {
      called = true;
      return {
        toolCall: {
          name: tool,
          arguments:
            tool === 'shell'
              ? { command: `printf shell-observed > '${target}'` }
              : { path: target, content: 'write-observed' },
        },
      };
    }
    return { text: 'effect-completed' };
  });
  const result = await (await f.session.startTurn(f.turn())).settled;
  expect(result.status, JSON.stringify(result.diagnostics)).toBe('completed');
  expect(called).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(`${tool}-observed`);
  expect(
    f.inference.requests.some((request) =>
      request.body.messages.some((message) => message.role === 'tool')
    )
  ).toBe(true);
}, 60000);

it.each([
  'global',
  'agent',
])('preserves an explicit native %s deny rule under full launch permission', async (scope) => {
  const target = join(work, 'denied-effect');
  const permissions = [{ action: 'shell', resource: '*', effect: 'deny' }];
  const config = JSON.stringify(
    scope === 'global' ? { permissions } : { agents: { build: { permissions } } }
  );
  writeFileSync(join(work, 'opencode.json'), config);
  let called = false;
  const f = await fixture(opencodeAdapter, null, (request) => {
    if (
      !called &&
      (request.body.tools?.length ?? 0) > 0 &&
      requestTexts(request).join(' ').includes('native-user')
    ) {
      called = true;
      return { toolCall: { name: 'shell', arguments: { command: `touch '${target}'` } } };
    }
    return { text: 'deny-completed' };
  });
  const result = await (await f.session.startTurn(f.turn())).settled;
  expect(result.status, JSON.stringify(result.diagnostics)).toBe('completed');
  expect(called).toBe(true);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(join(work, 'opencode.json'), 'utf8')).toBe(config);
}, 60000);

it('cancels a native typed-answer form without inventing an answer', async () => {
  let called = false;
  const f = await fixture(opencodeAdapter, null, (request) => {
    if (!called && request.body.tools?.some((tool) => tool.function?.name === 'question')) {
      called = true;
      return {
        toolCall: {
          name: 'question',
          arguments: {
            questions: [
              {
                question: 'Choose a value',
                header: 'Value',
                options: [{ label: 'authored-value', description: 'Requires user input' }],
              },
            ],
          },
        },
      };
    }
    return { text: 'form-followup' };
  });
  const result = await (await f.session.startTurn(f.turn())).settled;
  expect(called).toBe(true);
  expect(result.status).toBe('failed');
  expect(result.diagnostics?.native).toContain('native drain was not proved');
  expect(f.session.childState()).toBe('absent');
}, 60000);
