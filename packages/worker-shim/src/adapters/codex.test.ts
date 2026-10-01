// openkit-test-platform: posix
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  WorkerAdapterLlmRoute,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import type { RuntimeCaptureInput } from '../runtime-capture.js';
import {
  CODEX_PRODUCTION_BINARY,
  CODEX_RESULT_MAX_BYTES,
  type CodexStoppableChild,
  codexChildEnvironment,
  codexLaunchArguments,
  confirmCodexChildStopped,
  createCodexResidentAdapter,
  normalizeCodexAssistant,
  openCodexResidentSession,
  surfaceUnprovedCodexTurn,
} from './codex.js';

import { CodexAppServer, codexPermissionResponse, redactDiagnostic } from './codex-app-server.js';

const INFERENCE_SECRET = 'codex-test-inference-secret';
const CAPABILITY_SECRET = 'codex-test-capability-secret';
const require = createRequire(import.meta.url);
const packageJson = require.resolve('@openai/codex/package.json');
const platform = `${process.platform}-${process.arch}`;
const vendorTriples: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const triple = vendorTriples[platform];
if (!triple) throw new Error(`Unsupported Codex test platform ${platform}`);
const vendorPackage = createRequire(packageJson).resolve(
  `@openai/codex-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}/package.json`
);
const vendorBinary = join(
  vendorPackage,
  '..',
  'vendor',
  triple,
  'bin',
  process.platform === 'win32' ? 'codex.exe' : 'codex'
);
const testAdapter = createCodexResidentAdapter({ binaryPath: vendorBinary });
const sessions: WorkerResidentSession[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('Codex App Server adapter', () => {
  it('resolves the pinned vendor binary and keeps launch arguments free of secrets', () => {
    const binary = vendorBinary;
    expect(binary).toContain(`${join('vendor')}`);
    expect(CODEX_PRODUCTION_BINARY).toBe('/usr/local/lib/codex/bin/codex');
    expect(binary.endsWith(join('bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))).toBe(
      true
    );
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    expect(version.stdout).toContain('codex-cli 0.159.2');
    expect(codexLaunchArguments().slice(0, 6)).toEqual([
      'app-server',
      '--strict-config',
      '--disable',
      'plugins',
      '--disable',
      'hooks',
    ]);
    expect(JSON.stringify(codexLaunchArguments())).not.toContain(INFERENCE_SECRET);
    const childEnvironment = codexChildEnvironment(
      { PATH: '/usr/bin', HOME: '/tmp/home' },
      '/tmp/state'
    );
    expect(childEnvironment.CODEX_HOME).toBe('/tmp/state');
    expect(JSON.stringify(childEnvironment)).not.toContain(INFERENCE_SECRET);
    expect(JSON.stringify(childEnvironment)).not.toContain(CAPABILITY_SECRET);
  });

  it('bounds assistant text and redacts a diagnostic prefix', () => {
    expect(normalizeCodexAssistant('completed', ['  cedar  '])).toEqual({
      assistantText: 'cedar',
      status: 'completed',
      stopReason: 'completed',
    });
    expect(normalizeCodexAssistant('interrupted', ['partial']).assistantText).toBeNull();
    expect(normalizeCodexAssistant('interrupted', ['partial']).status).toBe('interrupted');
    expect(normalizeCodexAssistant('completed', ['one', 'two']).stopReason).toBe(
      'malformed-result'
    );
    expect(
      normalizeCodexAssistant('completed', ['x'.repeat(CODEX_RESULT_MAX_BYTES + 1)]).stopReason
    ).toBe('result-too-large');
    const diagnostic = redactDiagnostic(
      `${'a'.repeat(100)}${INFERENCE_SECRET}${'a'.repeat(20_000)}`,
      [INFERENCE_SECRET]
    );
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(diagnostic).not.toContain(INFERENCE_SECRET);
    expect(diagnostic).toContain('[redacted]');
  });

  it('cancels native permission requests and never accepts them', () => {
    expect(codexPermissionResponse('item/commandExecution/requestApproval', {}).result).toEqual({
      decision: 'cancel',
    });
    expect(
      codexPermissionResponse('item/commandExecution/requestApproval', {
        options: ['accept', 'reject_once'],
      }).result
    ).toEqual({ decision: 'reject_once' });
    expect(codexPermissionResponse('mcpServer/elicitation/request', {}).result).toEqual({
      action: 'cancel',
    });
    expect(codexPermissionResponse('item/permissions/requestApproval', {}).outcome).toBe(
      'unsupported'
    );
    expect(codexPermissionResponse('item/tool/requestUserInput', {}).outcome).toBe('unsupported');
    const encoded = JSON.stringify(codexPermissionResponse('item/fileChange/requestApproval', {}));
    expect(encoded).not.toContain('accept');
    expect(encoded).not.toContain('decline');
  });

  it('answers a live permission request with cancel', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "let reply; process.stdin.on('data', d => { for (const line of d.toString().trim().split('\\n')) { const r = JSON.parse(line); if (r.id === 7) reply = r; else process.stdout.write(JSON.stringify({id:r.id,result:reply}) + '\\n'); } }); process.stdout.write(JSON.stringify({id:7,method:'item/commandExecution/requestApproval',params:{}}) + '\\n')",
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const server = new CodexAppServer(
      child,
      [INFERENCE_SECRET],
      () => undefined,
      () => undefined
    );
    await expect
      .poll(() => server.permissionRecords)
      .toEqual([{ method: 'item/commandExecution/requestApproval', outcome: 'cancel' }]);
    await expect(server.request('probe', {})).resolves.toEqual({
      id: 7,
      result: { decision: 'cancel' },
    });
    child.kill('SIGKILL');
  });

  it.each([
    'null',
    '[]',
    '{"method":7}',
    '{"id":1,"error":{"message":7}}',
  ])('contains malformed RPC frame %s', async (frame) => {
    const child = childThatNeverExits();
    const broken: string[] = [];
    new CodexAppServer(
      child,
      [],
      () => undefined,
      (reason) => broken.push(reason)
    );
    child.stdout.write(`${frame}\n`);
    await expect.poll(() => broken.length).toBe(1);
  });

  it('contains invalid UTF-8 from native stdout', async () => {
    const child = childThatNeverExits();
    const broken: string[] = [];
    new CodexAppServer(
      child,
      [],
      () => undefined,
      (reason) => broken.push(reason)
    );
    child.stdout.write(Buffer.from([0xff, 0x0a]));
    await expect.poll(() => broken.length).toBe(1);
  });

  it('does not report ready for an allocated id without a rollout', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = spawnScriptedCodex('terminal-failed');
    trackChild(child);
    const session = await openCodexResidentSession(openInput(roots), { spawnProcess: () => child });
    sessions.push(session);
    await expect((await session.startTurn(turnInput(roots, []))).settled).resolves.toMatchObject({
      status: 'failed',
    });
    expect(await session.nativeHandle()).toEqual({ state: 'pending' });
  });

  it.each([
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CODEX_ROLLOUT_TRACE_ROOT',
  ])('refuses Codex managed environment %s before spawn', async (name) => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    let spawned = false;
    await expect(
      openCodexResidentSession(openInput(roots, {}, { [name]: 'literal-canary' }), {
        spawnProcess: () => {
          spawned = true;
          return controlledPeer();
        },
        stopGraceMs: 5,
      })
    ).rejects.toThrow(`Codex rejected environment ${name}.`);
    expect(spawned).toBe(false);
  });

  it('launches pinned Codex with a harmless OPENAI_ setting in the child environment', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    let environment: NodeJS.ProcessEnv | undefined;
    const session = await openCodexResidentSession(
      openInput(roots, {}, { OPENAI_LOG: 'public-canary', CODEX_BIN: '/unused', CODEX_ARGS: '' }),
      {
        binaryPath: vendorBinary,
        spawnProcess: (binary, args, options) => {
          environment = options.env;
          return spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        },
      }
    );
    sessions.push(session);
    expect(environment?.OPENAI_LOG).toBe('public-canary');
    expect(environment?.CODEX_BIN).toBe('/unused');
    expect(environment?.CODEX_ARGS).toBe('');
    expect((await session.nativeHandle()).state).toBe('pending');
  });

  it('refuses native SQLite-home environment relocation before spawn', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    let spawned = false;
    await expect(
      openCodexResidentSession(openInput(roots, {}, { CODEX_SQLITE_HOME: roots.control }), {
        spawnProcess: () => {
          spawned = true;
          return controlledPeer();
        },
        stopGraceMs: 5,
      })
    ).rejects.toThrow(/CODEX_SQLITE_HOME/);
    expect(spawned).toBe(false);
  });

  it('starts with the complete retained home and no generated base config', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    let environment: NodeJS.ProcessEnv | undefined;
    const session = await openCodexResidentSession(openInput(roots), {
      binaryPath: vendorBinary,
      spawnProcess: (binary, args, options) => {
        environment = options.env;
        return spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      },
    });
    sessions.push(session);
    expect(environment?.CODEX_HOME).toBe(roots.state);
    await expect(readFile(join(roots.state, 'config.toml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await walk(roots.control)).toEqual([]);
    expect((await session.nativeHandle()).state).toBe('pending');
  });

  it('rejects an array-valued effective MCP entry before loading a conversation', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer();
    child.kill = ((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    }) as typeof child.kill;
    child.stdin.removeAllListeners('data');
    const methods: string[] = [];
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.method) methods.push(message.method);
        if (message.id === undefined) continue;
        const result =
          message.method === 'config/read' ? { config: { mcp_servers: { local: [] } } } : {};
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
    await expect(
      openCodexResidentSession(openInput(roots), {
        spawnProcess: () => child,
        stopGraceMs: 5,
        controlTimeoutMs: 20,
      })
    ).rejects.toThrow('Codex native MCP configuration is malformed.');
    expect(methods).toEqual(['initialize', 'initialized', 'config/read']);
  });

  it.each([
    'mapped address',
    'trusted project',
    'unspecified address',
    'mapped unspecified address',
    'localhost nonreserved path',
    'unspecified nonreserved path',
  ] as const)('protects resumed effective configuration from %s before any bound Turn', async (source) => {
    const temporary = await tempRoots();
    const roots = { ...temporary, work: await realpath(temporary.work) };
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const mcp = await mcpServer();
    const bindings = {
      inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
      capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
    };
    const first = await testAdapter.openSession(openInput(roots, bindings));
    sessions.push(first);
    expect((await (await first.startTurn(turnInput(roots, [], 'Say other.'))).settled).status).toBe(
      'completed'
    );
    const reference = await readyReferenceOf(first);
    await expect(first.close()).rejects.toThrow(/drain\/persistence/);
    const homeConfig =
      source === 'trusted project'
        ? `[projects.${JSON.stringify(roots.work)}]\ntrust_level = "trusted"\n`
        : `[mcp_servers.alpha]\nurl = "http://${source.startsWith('unspecified') ? '0.0.0.0' : source === 'mapped unspecified address' ? '[::ffff:0.0.0.0]' : source === 'localhost nonreserved path' ? 'localhost' : '[::ffff:127.0.0.1]'}:${mcp.port}/${source.endsWith('nonreserved path') ? 'local-mcp' : 'capabilities/mcp/alpha'}"\n`;
    await writeFile(join(roots.state, 'config.toml'), homeConfig);
    const projectConfig = `[mcp_servers.alpha]\nurl = "http://127.0.0.1:${mcp.port}/capabilities/mcp/alpha"\n`;
    if (source === 'trusted project') {
      await mkdir(join(roots.work, '.git'));
      await mkdir(join(roots.work, '.codex'));
      await writeFile(join(roots.work, '.codex', 'config.toml'), projectConfig);
    }
    mcp.idle = true;
    const before = mcp.requestCount;
    const nativeRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const successor = await openCodexResidentSession(
      openInput(roots, {
        ...bindings,
        resumeReference: reference,
        agentSessionId: 'as_effective_successor',
      }),
      {
        binaryPath: vendorBinary,
        spawnProcess(binary, args, options) {
          const child = spawn(binary, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
          const write = child.stdin.write;
          child.stdin.write = ((...args: Parameters<typeof write>) => {
            const message = JSON.parse(args[0].toString());
            if (message.method) nativeRequests.push(message);
            return write.apply(child.stdin, args);
          }) as typeof write;
          return child;
        },
      }
    );
    sessions.push(successor);
    expect(await readyReferenceOf(successor)).toEqual(reference);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mcp.requestCount).toBe(before);
    mcp.idle = false;
    expect(nativeRequests.find((request) => request.method === 'thread/read')?.params).toEqual({
      threadId: Buffer.from(reference).toString(),
      includeTurns: false,
    });
    expect(nativeRequests.find((request) => request.method === 'config/read')?.params).toEqual({
      includeLayers: false,
      cwd: roots.work,
    });
    expect(
      nativeRequests.find((request) => request.method === 'thread/resume')?.params
    ).toMatchObject({ cwd: roots.work, config: { mcp_servers: { alpha: { enabled: false } } } });

    expect(
      (await (await successor.startTurn(turnInput(roots, ['alpha'], 'invoke alpha tool'))).settled)
        .status
    ).toBe('completed');
    expect(mcp.requestCount).toBeGreaterThan(before);
    expect(
      inference.bodies.some((body) => body.includes('mcp__alpha') && body.includes('alpha_tool'))
    ).toBe(true);
    expect(inference.bodies.at(-1)).toContain('tool-done');
    expect(
      nativeRequests
        .filter((request) => request.method === 'config/read')
        .map((request) => request.params)
    ).toEqual([
      { includeLayers: false, cwd: roots.work },
      { includeLayers: false, cwd: roots.work },
    ]);
    expect(
      nativeRequests.filter((request) => request.method === 'thread/resume').at(-1)?.params
    ).toMatchObject({
      threadId: Buffer.from(reference).toString(),
      cwd: roots.work,
      model: route().model,
      modelProvider: 'openkit-worker-inference',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: {
        mcp_servers: {
          alpha: {
            enabled: true,
            url: `${bindings.capabilityBaseUrl}/mcp/alpha`,
            http_headers: { Authorization: `Bearer ${CAPABILITY_SECRET}` },
          },
        },
      },
    });
    expect(mcp.idle).toBe(false);
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(homeConfig);
    if (source === 'trusted project') {
      expect(await readFile(join(roots.work, '.codex', 'config.toml'), 'utf8')).toBe(projectConfig);
    }
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
  }, 30_000);

  it('restores an unsupplied authored Gateway entry without injecting credentials', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const gateway = await mcpServer();
    const bindings = {
      inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
      capabilityBaseUrl: `http://127.0.0.1:${gateway.port}/capabilities`,
    };
    const first = await testAdapter.openSession(openInput(roots, bindings));
    sessions.push(first);
    expect((await (await first.startTurn(turnInput(roots, [], 'Say other.'))).settled).status).toBe(
      'completed'
    );
    const reference = await readyReferenceOf(first);
    await expect(first.close()).rejects.toThrow(/drain\/persistence/);
    const authored = `[mcp_servers.alpha]\nurl = "http://127.0.0.1:${gateway.port}/capabilities/mcp/alpha"\n[mcp_servers.alpha.http_headers]\nAuthorization = "Bearer authored-local-credential"\n`;
    await writeFile(join(roots.state, 'config.toml'), authored);
    gateway.idle = true;
    const successor = await testAdapter.openSession(
      openInput(roots, { ...bindings, resumeReference: reference })
    );
    sessions.push(successor);
    expect(await readyReferenceOf(successor)).toEqual(reference);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.requestCount).toBe(0);
    gateway.idle = false;
    expect(
      (await (await successor.startTurn(turnInput(roots, [], 'Say other.'))).settled).status
    ).toBe('completed');
    // The fixture enforces authentication: authored requests receive no adapter credential or tools.
    expect(gateway.requestCount).toBeGreaterThan(0);
    expect(
      gateway.requests.every(
        (request) => request.authorization === 'Bearer authored-local-credential'
      )
    ).toBe(true);
    expect(inference.bodies.at(-1)).not.toContain('mcp__alpha');
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(authored);
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
  }, 30_000);

  it('rejects a credential scan when a credential-bearing subtree is unreadable', async () => {
    const roots = await tempRoots();
    const blocked = join(roots.state, 'blocked');
    await mkdir(blocked);
    await writeFile(join(blocked, 'credential'), INFERENCE_SECRET);
    await chmod(blocked, 0);
    try {
      await expect(readdir(blocked)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(filesContaining(roots.state, [INFERENCE_SECRET])).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await chmod(blocked, 0o700);
      await rm(roots.base, { recursive: true, force: true });
    }
  });

  it('isolates retained route and credential preferences and the auth store', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const mcp = await mcpServer();
    let bypassContacts = 0;
    const bypass = createServer((_request, response) => {
      bypassContacts++;
      response.writeHead(403);
      response.end();
    });
    await listen(bypass);
    closers.push(() => new Promise((resolve) => bypass.close(() => resolve())));
    const address = bypass.address();
    if (!address || typeof address === 'string') throw new Error('bypass listen failed');
    const authored = `model = "retained-model"
model_provider = "retained-provider"
cli_auth_credentials_store = "file"
[model_providers.retained-provider]
name = "retained provider"
base_url = "http://127.0.0.1:${mcp.port}/capabilities/mcp/alpha"
wire_api = "responses"
experimental_bearer_token = "retained-provider-auth"
[model_providers.openkit-worker-inference]
name = "retained relay override"
base_url = "http://127.0.0.1:${mcp.port}/capabilities/mcp/alpha"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "retained-inference-auth"
[model_providers.openkit-worker-inference.http_headers]
Authorization = "Bearer retained-header-auth"
[mcp_servers.alpha]
url = "http://127.0.0.1:${mcp.port}/capabilities/mcp/alpha"
[mcp_servers.alpha.http_headers]
Authorization = "Bearer retained-capability-auth"
`;
    const auth = JSON.stringify({ OPENAI_API_KEY: 'retained-auth-store-token' });
    await writeFile(join(roots.state, 'config.toml'), authored);
    await writeFile(join(roots.state, 'auth.json'), auth);
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(session);
    const rpc = (session as unknown as { rpc: CodexAppServer }).rpc;
    expect(await rpc.request('account/read', { refreshToken: false })).toMatchObject({
      account: null,
    });
    const config = (await rpc.request('config/read', { includeLayers: false })) as {
      config: Record<string, unknown>;
    };
    expect(config.config.cli_auth_credentials_store).toBe('ephemeral');
    const result = await (await session.startTurn(turnInput(roots, ['alpha'], 'Say other.')))
      .settled;
    expect(result.status).toBe('completed');
    expect(JSON.parse(inference.bodies.at(-1)!).model).toBe('openkit-logical-model');
    expect(mcp.requestCount).toBeGreaterThan(0);
    expect(bypassContacts).toBe(0);
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(authored);
    expect(await readFile(join(roots.state, 'auth.json'), 'utf8')).toBe(auth);
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
    const reference = await readyReferenceOf(session);
    await expect(session.close()).rejects.toThrow(/drain\/persistence/);
    const beforeResume = mcp.requestCount;
    const successor = await testAdapter.openSession(
      openInput(roots, {
        resumeReference: reference,
        agentSessionId: 'as_config_successor',
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(successor);
    expect((await successor.nativeHandle()).state).toBe('ready');
    expect(mcp.requestCount).toBe(beforeResume);
    expect(
      (await (await successor.startTurn(turnInput(roots, ['alpha'], 'Say other.'))).settled).status
    ).toBe('completed');
    expect(mcp.requestCount).toBeGreaterThan(beforeResume);
    await expect(successor.close()).rejects.toThrow(/drain\/persistence/);
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
  }, 30_000);

  it('preserves invalid authored configuration and fails without a replacement home', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const authored = 'w2_unknown_launch_authority = true\n';
    await writeFile(join(roots.state, 'config.toml'), authored);
    await expect(testAdapter.openSession(openInput(roots))).rejects.toThrow();
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(authored);
    expect(await walk(roots.control)).toEqual([]);
    expect(countRollouts(await walk(roots.state))).toBe(0);
  });

  it.each([
    '[::1]',
    'localhost',
  ])('honors an idle then active independent IPv6 local MCP via %s', async (hostname) => {
    const temporary = await tempRoots();
    const roots = { ...temporary, work: await realpath(temporary.work) };
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const gateway = await mcpServer();
    const local = await mcpServer({
      port: gateway.port,
      host: '::1',
      credential: 'local-mcp-auth',
    });
    const seed = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${gateway.port}/capabilities`,
      })
    );
    sessions.push(seed);
    await (await seed.startTurn(turnInput(roots, [], 'Say other.'))).settled;
    const reference = await readyReferenceOf(seed);
    await expect(seed.close()).rejects.toThrow(/drain\/persistence/);
    // The effective project layer replaces a stale home Gateway identity with an ordinary local MCP.
    const authored = `[projects.${JSON.stringify(roots.work)}]\ntrust_level = "trusted"\n[mcp_servers.alpha]\nurl = "http://127.0.0.1:${gateway.port}/capabilities/mcp/alpha"\n`;
    const project = `[mcp_servers.alpha]\nurl = "http://${hostname}:${gateway.port}/capabilities/mcp/alpha"\n[mcp_servers.alpha.http_headers]\nAuthorization = "Bearer local-mcp-auth"\n`;
    const homeConfig = hostname === 'localhost' ? project : authored;
    await writeFile(join(roots.state, 'config.toml'), homeConfig);
    if (hostname !== 'localhost') {
      await mkdir(join(roots.work, '.git'));
      await mkdir(join(roots.work, '.codex'));
      await writeFile(join(roots.work, '.codex', 'config.toml'), project);
    }
    gateway.idle = true;
    local.idle = true;
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${gateway.port}/capabilities`,
        resumeReference: reference,
      })
    );
    sessions.push(session);
    expect(await readyReferenceOf(session)).toEqual(reference);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(local.requestCount).toBe(0);
    expect(gateway.requestCount).toBe(0);
    local.idle = false;
    gateway.idle = false;
    expect(
      (await (await session.startTurn(turnInput(roots, [], 'invoke alpha tool'))).settled).status
    ).toBe('completed');
    expect(local.requestCount).toBeGreaterThan(0);
    expect(inference.bodies.some((body) => body.includes('mcp__alpha'))).toBe(true);
    expect(inference.bodies.at(-1)).toContain('tool-done');
    expect(gateway.requestCount).toBe(0);
    expect(
      local.requests.every((request) => request.authorization === 'Bearer local-mcp-auth')
    ).toBe(true);
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(homeConfig);
    if (hostname !== 'localhost') {
      expect(await readFile(join(roots.work, '.codex', 'config.toml'), 'utf8')).toBe(project);
    }
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
  }, 30_000);

  it.each([
    false,
    true,
  ])('uses retained local stdio MCP without providing it Gateway credentials; supplied HTTP collision=%s', async (crossTransport) => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const gateway = crossTransport ? await mcpServer() : undefined;
    const seed = await testAdapter.openSession(
      openInput(roots, { inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1` })
    );
    sessions.push(seed);
    await (await seed.startTurn(turnInput(roots, [], 'Say other.'))).settled;
    const reference = await readyReferenceOf(seed);
    await expect(seed.close()).rejects.toThrow(/drain\/persistence/);
    const localScript = join(roots.work, 'local-mcp.cjs');
    const marker = join(roots.work, 'local-called.json');
    const launched = join(roots.work, 'local-launched');
    const disabledScript = join(roots.work, 'disabled-mcp.cjs');
    const disabledLaunch = join(roots.work, 'disabled-launched');
    await writeFile(
      disabledScript,
      `require('node:fs').writeFileSync(${JSON.stringify(disabledLaunch)}, 'unexpected');`
    );
    await writeFile(
      localScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(launched)}, 'launched');
let buffer = ''; process.stdin.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\\n')) >= 0) { const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); if (msg.id === undefined) continue; let result = {}; if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } }; if (msg.method === 'tools/list') result = { tools: [{ name: 'local_tool', description: 'Local marker', inputSchema: { type: 'object', properties: {} } }] }; if (msg.method === 'tools/call') { fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ method: msg.method, env: process.env })); result = { content: [{ type: 'text', text: 'local-success' }] }; } process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n'); } });`
    );
    const authored = `[mcp_servers.local]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(localScript)}]\n[mcp_servers.disabled]\nenabled = false\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(disabledScript)}]\n`;
    await writeFile(join(roots.state, 'config.toml'), authored);
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        resumeReference: reference,
      })
    );
    sessions.push(session);
    expect(await readyReferenceOf(session)).toEqual(reference);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(readFile(launched)).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await (await session.startTurn(turnInput(roots, [], 'invoke alpha tool')))
      .settled;
    expect(result.status).toBe('completed');
    expect(
      inference.bodies.some((body) => body.includes('mcp__local') && body.includes('local_tool'))
    ).toBe(true);
    const called = await readFile(marker, 'utf8');
    expect(called).toContain('tools/call');
    expect(inference.bodies.at(-1)).toContain('local-success');
    expect(called).not.toContain(INFERENCE_SECRET);
    expect(called).not.toContain(CAPABILITY_SECRET);
    await expect(readFile(disabledLaunch)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(authored);
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
    if (crossTransport && gateway) {
      const exact = await readyReferenceOf(session);
      await expect(session.close()).rejects.toThrow(/drain\/persistence/);
      await rm(launched);
      const successor = await testAdapter.openSession(
        openInput(roots, {
          inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
          capabilityBaseUrl: `http://127.0.0.1:${gateway.port}/capabilities`,
          resumeReference: exact,
        })
      );
      sessions.push(successor);
      expect(await readyReferenceOf(successor)).toEqual(exact);
      await delay(250);
      await expect(readFile(launched)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(gateway.requestCount).toBe(0);
      // The native merge retains command/args. Refusal must not substitute the authored tool for supply.
      await expect(
        successor.startTurn(turnInput(roots, ['local'], 'invoke alpha tool'))
      ).rejects.toThrow(/url is not supported for stdio/);
      expect(successor.childState()).toBe('absent');
      expect(gateway.requestCount).toBe(0);
      await expect(readFile(launched)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(authored);
      expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
    }
  }, 30_000);

  it('preserves retained config and unknown files through open and close', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const config = '# retained config marker\n';
    await writeFile(join(roots.state, 'config.toml'), config);
    await writeFile(join(roots.state, 'unknown.data'), 'retained');
    const session = await testAdapter.openSession(openInput(roots));
    sessions.push(session);
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(config);
    await session.close();
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(config);
    expect(await readFile(join(roots.state, 'unknown.data'), 'utf8')).toBe('retained');
  });

  it('refuses unimplemented App Server provenance before native Turn work', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const session = await testAdapter.openSession(
      openInput(roots, { inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1` })
    );
    sessions.push(session);
    await expect(
      session.startTurn({
        ...turnInput(roots, []),
        runtimeProvenance: {} as NonNullable<WorkerResidentTurnInput['runtimeProvenance']>,
      })
    ).rejects.toThrow(/provenance is not implemented/);
    expect(inference.bodies).toHaveLength(0);
    expect(await session.nativeHandle()).toEqual({ state: 'pending' });
  });

  it('selects the immutable production binary through the process runner', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const calls: unknown[] = [];
    const child = controlledPeer();
    const session = await openCodexResidentSession(openInput(roots), {
      stopGraceMs: 5,
      spawnProcess: (binary, args, options) => {
        calls.push({ binary, args, options });
        return child;
      },
    });
    expect(calls).toEqual([
      {
        binary: CODEX_PRODUCTION_BINARY,
        args: codexLaunchArguments(),
        options: {
          cwd: roots.state,
          env: codexChildEnvironment(openInput(roots).environment, roots.state),
        },
      },
    ]);
    await expect(session.close()).rejects.toThrow();
  });

  it.each([
    'terminal-same-chunk',
    'terminal-before',
  ])('settles a terminal that races turn acceptance: %s', async (mode) => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = spawnScriptedCodex(mode);
    trackChild(child);
    const session = await openCodexResidentSession(openInput(roots), { spawnProcess: () => child });
    sessions.push(session);
    const turn = await session.startTurn(turnInput(roots, []));
    const outcome = await Promise.race([
      turn.settled,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(outcome).toMatchObject({ status: 'completed', assistantText: 'ok' });
  });

  it('contains a malformed frame during an accepted Turn and stops its binding', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = spawnScriptedCodex('broken-after-accept');
    trackChild(child);
    const session = await openCodexResidentSession(openInput(roots), { spawnProcess: () => child });
    sessions.push(session);
    const turn = await session.startTurn(turnInput(roots, []));
    await expect(turn.settled).resolves.toMatchObject({ status: 'failed' });
    expect(session.childState()).toBe('absent');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('does not accept a Turn when the peer exits before its response', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = spawnScriptedCodex('exit-during-accept');
    trackChild(child);
    const session = await openCodexResidentSession(openInput(roots), { spawnProcess: () => child });
    sessions.push(session);
    await expect(session.startTurn(turnInput(roots, []))).rejects.toThrow();
    expect(session.childState()).toBe('absent');
  });

  it.each([
    'terminal-missing-thread',
    'terminal-wrong-thread',
    'terminal-unknown-item',
    'terminal-unknown-status',
    'terminal-in-progress',
    'terminal-malformed-assistant',
  ])('fails closed on invalid correlated terminal: %s', async (mode) => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = spawnScriptedCodex(mode);
    trackChild(child);
    const session = await openCodexResidentSession(openInput(roots), { spawnProcess: () => child });
    sessions.push(session);
    const turn = await session.startTurn(turnInput(roots, []));
    const outcome = await Promise.race([
      turn.settled,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('ignores an additive event even when it carries another thread id', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = spawnScriptedCodex('additive-before-terminal');
    trackChild(child);
    const session = await openCodexResidentSession(openInput(roots), { spawnProcess: () => child });
    sessions.push(session);
    const result = await (await session.startTurn(turnInput(roots, []))).settled;
    expect(result).toMatchObject({ status: 'completed', assistantText: 'ok' });
    expect(session.childState()).toBe('running');
  });

  it('bounds an unproved interrupt while retaining rejected settlement', async () => {
    const surfaced = surfaceUnprovedCodexTurn(new Error('still live'), async () => false);
    await expect(surfaced.settled).rejects.toThrow('still live');
    const winner = await Promise.race([
      surfaced.interrupt().then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(winner).toBe('rejected');
  });

  it('resolves interrupt after an unproved stop is confirmed', async () => {
    const surfaced = surfaceUnprovedCodexTurn(new Error('stopped later'), async () => true);
    await expect(surfaced.interrupt()).resolves.toBeUndefined();
  });

  it('confirms a stopped child and reports a child that never exits', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    await expect(confirmCodexChildStopped(child)).resolves.toBe(true);
    expect(processIsGone(pid)).toBe(true);
    const silent = new EventEmitter() as CodexStoppableChild;
    silent.exitCode = null;
    silent.signalCode = null;
    silent.kill = () => true;
    await expect(confirmCodexChildStopped(silent, 20)).resolves.toBe(false);
    expect(silent.listenerCount('exit')).toBe(0);
  });

  it('returns an unknown session when a failed open cannot prove the process exited', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: childThatNeverExits,
      stopGraceMs: 20,
    });
    sessions.push(session);
    expect(session.childState()).toBe('unknown');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    const turn = await session.startTurn(turnInput(roots, []));
    await expect(turn.settled).rejects.toThrow(/unavailable/);
    const interrupt = turn.interrupt().then(
      () => 'resolved',
      () => 'rejected'
    );
    const winner = await Promise.race([
      interrupt,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 15)),
    ]);
    expect(winner).toBe('pending');
    expect(await Promise.race([interrupt, delay(60).then(() => 'pending')])).toBe('rejected');
    await expect(session.close()).rejects.toThrow(/confirm/);
    expect(session.childState()).toBe('unknown');
  });

  it('rejects a failed resume only after the scripted process has exited', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    await writeFile(join(roots.state, 'config.toml'), '# failed-resume retained marker\n');
    await writeFile(join(roots.state, 'unknown.data'), 'failed-resume retained');
    const child = spawnScriptedCodex('resume-error');
    trackChild(child);
    const pid = child.pid ?? 0;
    await expect(
      openCodexResidentSession(
        openInput(roots, {
          resumeReference: new TextEncoder().encode('00000000-0000-0000-0000-000000000000'),
        }),
        { spawnProcess: () => child }
      )
    ).rejects.toThrow(/rollout/);
    expect(processIsGone(pid)).toBe(true);
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(
      '# failed-resume retained marker\n'
    );
    expect(await readFile(join(roots.state, 'unknown.data'), 'utf8')).toBe(
      'failed-resume retained'
    );
  });

  it('stops a Turn on unqualified native errors and preserves pre-native refusal', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const refused = spawnScriptedCodex('turn-refused');
    trackChild(refused);
    const refusedPid = refused.pid ?? 0;
    const refusedSession = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => refused,
    });
    sessions.push(refusedSession);
    await expect(
      refusedSession.startTurn({
        ...turnInput(roots, []),
        llmRoute: route('openkit-logical-model', 'direct-provider'),
      })
    ).rejects.toThrow(/route/);
    expect(refusedSession.childState()).toBe('running');
    expect(processIsGone(refusedPid)).toBe(false);
    await expect(refusedSession.startTurn(turnInput(roots, []))).rejects.toThrow(/turn refused/);
    expect(refusedSession.childState()).toBe('absent');
    expect(processIsGone(refusedPid)).toBe(true);

    const missing = spawnScriptedCodex('turn-missing');
    trackChild(missing);
    const missingPid = missing.pid ?? 0;
    const missingRoots = await tempRoots();
    closers.push(async () => rm(missingRoots.base, { recursive: true, force: true }));
    const missingSession = await openCodexResidentSession(openInput(missingRoots), {
      spawnProcess: () => missing,
    });
    sessions.push(missingSession);
    await expect(missingSession.startTurn(turnInput(missingRoots, []))).rejects.toThrow(
      /did not accept/
    );
    expect(missingSession.childState()).toBe('absent');
    expect(processIsGone(missingPid)).toBe(true);
  });

  it('rejects a missing credential, a forbidden environment, and a corrupt resume before native work', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const input = openInput(roots, { capabilityCredential: '' });
    await expect(testAdapter.openSession(input)).rejects.toThrow(/credentials/);
    await expect(readdir(roots.state).catch(() => [])).resolves.toEqual([]);
    await expect(
      testAdapter.openSession(openInput(roots, {}, { CODEX_HOME: roots.home }))
    ).rejects.toThrow(/CODEX_HOME/);
    await expect(
      testAdapter.openSession(openInput(roots, { resumeReference: Uint8Array.from([0xff, 0xfe]) }))
    ).rejects.toThrow(/UTF-8/);
  });

  it('keeps one thread across Turns, resumes exactly, and leaves no credential behind', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    await writeFile(
      join(roots.state, 'config.toml'),
      'model_provider = "retained-bad"\n# retained user configuration marker\n'
    );
    await writeFile(join(roots.state, 'unknown.data'), 'retained unknown file');
    await mkdir(join(roots.home, '.codex'));
    await writeFile(
      join(roots.home, '.codex', 'config.toml'),
      'w2_unknown_ambient_authority = true\n# ambient-only-marker\n'
    );
    const inference = await responsesServer();
    const mcp = await mcpServer();
    mcp.idle = true;
    const input = openInput(roots, {
      inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
      capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
    });
    let spawned: ChildProcessWithoutNullStreams | undefined;
    let spawnEnvironment: NodeJS.ProcessEnv | undefined;
    const session = await openCodexResidentSession(input, {
      binaryPath: vendorBinary,
      spawnProcess: (binary, args, options) => {
        spawnEnvironment = options.env;
        spawned = spawn(binary, [...args], {
          ...options,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;
        return spawned;
      },
    });
    sessions.push(session);
    expect(session.childState()).toBe('running');
    const opened = await session.nativeHandle();
    expect(countRollouts(await walk(roots.state))).toBe(0);
    expect(opened.state).toBe('pending');
    expect(spawned?.pid).toBeGreaterThan(0);
    expect(processIsGone(spawned!.pid!)).toBe(false);
    expect(spawned!.spawnargs).toEqual([vendorBinary, ...codexLaunchArguments()]);
    expect(JSON.stringify(spawned!.spawnargs)).not.toContain(INFERENCE_SECRET);
    expect(JSON.stringify(spawned!.spawnargs)).not.toContain(CAPABILITY_SECRET);
    expect(spawnEnvironment?.CODEX_HOME).toBe(roots.state);
    expect(JSON.stringify(spawnEnvironment)).not.toContain(INFERENCE_SECRET);
    expect(JSON.stringify(spawnEnvironment)).not.toContain(CAPABILITY_SECRET);
    const beforeDirect = inference.bodies.length;
    await expect(
      session.startTurn({
        ...turnInput(roots, ['alpha']),
        llmRoute: route('openkit-logical-model', 'direct-provider'),
      })
    ).rejects.toThrow(/route/);
    expect(inference.bodies).toHaveLength(beforeDirect);
    expect((await session.nativeHandle()).state).toBe('pending');
    expect(countRollouts(await walk(roots.state))).toBe(0);

    const project = join(roots.work, 'project-cedar-cwd');
    await mkdir(project);
    mcp.idle = false;
    const first = await session.startTurn({
      // The Harness binds this Turn before the adapter begins native thread/start.
      ...turnInput(roots, ['alpha']),
      workingDirectory: project,
    });
    const firstResult = await first.settled;
    expect(firstResult.status).toBe('completed');
    expect(firstResult.assistantText).toBe('alpha-answer');
    const firstBody = inference.bodies.find((body) => body.includes('Remember the word cedar.'));
    expect(firstBody).toContain('openkit-logical-model');
    expect(firstBody).toContain('Remember the word cedar.');
    expect(firstBody).toContain('alpha_tool');
    expect(firstBody).toContain('mcp__alpha');
    expect(firstBody).toContain(project);
    expect(await filesContaining(roots.state, [INFERENCE_SECRET, CAPABILITY_SECRET])).toEqual([]);
    const liveHome = await walk(roots.state);
    expect(liveHome.some((path) => path.endsWith('.sqlite'))).toBe(true);
    expect(liveHome.some((path) => path.endsWith('.sqlite-wal'))).toBe(true);
    expect(liveHome.some((path) => /logs.*\.sqlite/.test(path))).toBe(true);
    const readyReference = await readyReferenceOf(session);
    expect(new TextDecoder().decode(readyReference)).toMatch(/^[0-9a-f-]{36}$/);
    expect(countRollouts(await walk(roots.state))).toBeGreaterThan(0);

    const recalled = await session.startTurn({
      ...turnInput(roots, ['alpha'], 'What word did I ask you to remember?'),
      llmRoute: { ...route('second-model'), id: 'route-2' },
      workingDirectory: project,
    });
    const recalledResult = await recalled.settled;
    expect(recalledResult.status).toBe('completed');
    expect(recalledResult.assistantText).toBe('beta-answer');
    const recalledBody = inference.bodies.at(-1) ?? '';
    expect(JSON.parse(recalledBody).model).toBe('second-model');
    expect(recalledBody).toContain('cedar');
    expect(recalledBody).toContain('alpha-answer');
    expect(recalledBody).toContain('alpha_tool');
    expect(recalledBody).not.toContain('beta_tool');

    const beforeSupplyChange = inference.bodies.length;
    await expect(
      session.startTurn({
        ...turnInput(roots, ['beta'], 'What word did I ask you to remember?'),
        workingDirectory: project,
      })
    ).rejects.toThrow(/does not re-list/);
    expect(inference.bodies).toHaveLength(beforeSupplyChange);
    await expect(
      session.startTurn({ ...turnInput(roots, ['alpha']), workingDirectory: roots.work })
    ).rejects.toThrow(/does not re-list/);
    expect(inference.bodies).toHaveLength(beforeSupplyChange);
    expect(session.childState()).toBe('running');

    const otherRoots = await tempRoots();
    closers.push(async () => rm(otherRoots.base, { recursive: true, force: true }));
    const other = await testAdapter.openSession(
      openInput(otherRoots, {
        inferenceBaseUrl: input.loopback.inferenceBaseUrl,
        capabilityBaseUrl: input.loopback.capabilityBaseUrl,
        agentSessionId: 'as_other',
      })
    );
    sessions.push(other);
    const otherResult = await (await other.startTurn(turnInput(otherRoots, [], 'Say other.')))
      .settled;
    expect(otherResult.assistantText).toBe('alpha-answer');
    await expect(other.close()).rejects.toThrow(/drain\/persistence/);
    expect(other.childState()).toBe('absent');
    expect(session.childState()).toBe('running');

    inference.hang = true;
    const hanging = await session.startTurn({
      ...turnInput(roots, ['alpha'], 'hang please'),
      workingDirectory: project,
    });
    await inference.untilHung();
    await hanging.interrupt();
    const interrupted = await hanging.settled;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.assistantText).toBeNull();
    expect(session.childState()).toBe('running');
    inference.hang = false;

    const observations: unknown[] = [];
    const continued = await session.startTurn({
      ...turnInput(roots, ['alpha'], 'Continue after interrupt.', observations),
      workingDirectory: project,
    });
    expect((await continued.settled).status).toBe('completed');
    expect(JSON.stringify(observations)).not.toContain(INFERENCE_SECRET);
    expect(JSON.stringify(observations)).not.toContain(CAPABILITY_SECRET);
    expect(observations.length).toBeGreaterThan(0);

    const beforeLaterDirect = inference.bodies.length;
    await expect(
      session.startTurn({
        ...turnInput(roots, ['alpha'], 'Say other.'),
        workingDirectory: project,
        llmRoute: route('openkit-logical-model', 'direct-provider'),
      })
    ).rejects.toThrow(/route/);
    expect(inference.bodies).toHaveLength(beforeLaterDirect);

    await expect(session.close()).rejects.toThrow(/drain\/persistence/);
    expect(session.childState()).toBe('absent');
    const retained = await walk(roots.state);
    expect(retained.some((name) => name.includes('rollout-'))).toBe(true);
    expect(retained.join('\n')).not.toContain('model_catalog');
    expect(retained.join('\n')).not.toContain('plugins-clone');
    const leaked = await filesContaining(roots.state, [
      INFERENCE_SECRET,
      CAPABILITY_SECRET,
      'ambient-only-marker',
    ]);
    expect(leaked).toEqual([]);

    await rm(roots.control, { recursive: true, force: true });
    const successorControl = join(roots.base, 'successor-control');
    mcp.idle = true;
    const idleRequests = mcp.requestCount;
    const successor = await testAdapter.openSession({
      ...input,
      agentSessionId: 'as_successor',
      controlRoot: successorControl,
      loopback: {
        ...input.loopback,
        inferenceCredential: 'successor-inference-secret',
        capabilityCredential: 'successor-capability-secret',
      },
      resumeReference: readyReference,
    });
    sessions.push(successor);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mcp.requestCount).toBe(idleRequests);
    const successorHandle = await successor.nativeHandle();
    expect(successorHandle).toEqual({ state: 'ready', reference: readyReference });
    mcp.idle = false;
    const successorResult = await (
      await successor.startTurn({
        ...turnInput(roots, ['gamma'], 'What word did I ask you to remember?'),
        workingDirectory: project,
      })
    ).settled;
    expect(successorResult.status).toBe('completed');
    const successorBody = inference.bodies.at(-1) ?? '';
    expect(successorBody).toContain('cedar');
    expect(successorBody).toContain('gamma_tool');
    expect(successorBody).toContain('mcp__gamma');
    expect(successorBody).not.toContain('alpha_tool');
    const rolloutCount = (await walk(roots.state)).filter((name) =>
      name.includes('rollout-')
    ).length;
    await expect(successor.close()).rejects.toThrow(/drain\/persistence/);
    expect(await readFile(join(roots.state, 'config.toml'), 'utf8')).toBe(
      'model_provider = "retained-bad"\n# retained user configuration marker\n'
    );
    expect(await readFile(join(roots.state, 'unknown.data'), 'utf8')).toBe('retained unknown file');
    expect(
      await filesContaining(roots.state, [
        INFERENCE_SECRET,
        CAPABILITY_SECRET,
        'successor-inference-secret',
        'successor-capability-secret',
      ])
    ).toEqual([]);
    const childrenBefore = directChildPids();
    await expect(
      testAdapter.openSession({
        ...input,
        agentSessionId: 'as_bad',
        controlRoot: roots.control,
        resumeReference: new TextEncoder().encode('00000000-0000-0000-0000-000000000000'),
      })
    ).rejects.toThrow(/thread|rollout/);
    const childrenAfter = directChildPids();
    if (childrenBefore && childrenAfter) {
      expect(childrenAfter.filter((pid) => !childrenBefore.includes(pid))).toEqual([]);
    }
    expect((await walk(roots.state)).filter((name) => name.includes('rollout-'))).toHaveLength(
      rolloutCount
    );
  }, 180_000);

  it('shows the first Turn tools and working directory before a supply change is refused', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const mcp = await mcpServer();
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(session);
    const project = join(roots.work, 'project-cedar-cwd');
    await mkdir(project);
    const first = await session.startTurn({
      ...turnInput(roots, ['alpha']),
      workingDirectory: project,
    });
    expect((await first.settled).assistantText).toBe('alpha-answer');
    const firstBody =
      inference.bodies.find((body) => body.includes('Remember the word cedar.')) ?? '';
    expect(firstBody).toContain('alpha_tool');
    expect(firstBody).toContain('mcp__alpha');
    expect(firstBody).toContain(project);
    const before = inference.bodies.length;
    await expect(
      session.startTurn({
        ...turnInput(roots, ['beta'], 'What word did I ask you to remember?'),
        workingDirectory: project,
      })
    ).rejects.toThrow(/does not re-list/);
    expect(inference.bodies).toHaveLength(before);
    expect(session.childState()).toBe('running');
  }, 180_000);

  it('reports ready when an interrupted first Turn has written the rollout', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const mcp = await mcpServer();
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(session);
    inference.hang = true;
    const hanging = await session.startTurn(turnInput(roots, ['alpha'], 'hang please'));
    await inference.untilHung();
    await hanging.interrupt();
    const interrupted = await hanging.settled;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.assistantText).toBeNull();
    expect(session.childState()).toBe('running');
    const rollouts = countRollouts(await walk(roots.state));
    const handle = await session.nativeHandle();
    expect(rollouts).toBeGreaterThan(0);
    expect(handle.state).toBe('ready');
  }, 180_000);

  it('interrupts a blocked MCP tool and completes a later Turn', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const mcp = await mcpServer();
    mcp.holdCalls = true;
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(session);
    const turn = await session.startTurn(turnInput(roots, ['alpha'], 'invoke alpha tool'));
    const observed = await Promise.race([
      mcp.untilHeld().then(() => 'held' as const),
      turn.settled.then((result) => result),
    ]);
    expect(observed).toBe('held');
    await turn.interrupt();
    const interrupted = await turn.settled;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.assistantText).toBeNull();
    expect(session.childState()).toBe('running');
    mcp.holdCalls = false;
    mcp.releaseCalls();
    const later = await session.startTurn(turnInput(roots, ['alpha'], 'Say other.'));
    expect((await later.settled).status).toBe('completed');
    expect((await later.settled).assistantText).toBe('alpha-answer');
  }, 180_000);

  it('closes the native process during a blocked tool call and ignores late tool output', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    const mcp = await mcpServer();
    mcp.holdCalls = true;
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(session);
    const turn = await session.startTurn(turnInput(roots, ['alpha'], 'invoke alpha tool'));
    await mcp.untilHeld();
    const before = inference.bodies.length;
    await expect(session.close()).rejects.toThrow(/drain\/persistence/);
    expect(session.childState()).toBe('absent');
    mcp.releaseCalls();
    await expect(turn.settled).resolves.toMatchObject({ status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inference.bodies).toHaveLength(before);
  }, 180_000);

  it('preserves native local Skills while replacing managed roots, including empty supply', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const localDir = join(roots.state, 'skills', 'local-skill');
    await mkdir(localDir, { recursive: true });
    const localBytes =
      '---\nname: local-skill\ndescription: CODEX_LOCAL_SKILL_MARKER is the local probe.\n---\n# Local\nReport CODEX_LOCAL_SKILL_MARKER.\n';
    await writeFile(join(localDir, 'SKILL.md'), localBytes);
    const skillDir = join(roots.work, 'marker-skill');
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: marker-skill\ndescription: CODEX_SKILL_MARKER_r2 is the skill probe.\n---\n# Marker\nReport the token CODEX_SKILL_MARKER_r2.\n'
    );
    const inference = await responsesServer();
    const mcp = await mcpServer();
    const session = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(session);
    const turn = await session.startTurn({
      ...turnInput(roots, [], 'Say other.'),
      skillTargetPaths: [{ id: 'marker-skill', targetPath: skillDir }],
    });
    const result = await turn.settled;
    expect(result.status).toBe('completed');
    const body = inference.bodies.find((item) => item.includes('Say other.')) ?? '';
    expect(body).toContain('CODEX_SKILL_MARKER_r2');
    expect(body).toContain('CODEX_LOCAL_SKILL_MARKER');
    // Read native current projection rather than historical prompt text.
    const rpc = (session as unknown as { rpc: CodexAppServer }).rpc;
    const installed = await rpc.request('skills/list', { cwds: [roots.work], forceReload: true });
    expect(JSON.stringify(installed)).toContain('CODEX_SKILL_MARKER_r2');
    expect(
      (await (await session.startTurn(turnInput(roots, [], 'Empty Skill supply.'))).settled).status
    ).toBe('completed');
    const cleared = await rpc.request('skills/list', { cwds: [roots.work], forceReload: true });
    expect(JSON.stringify(cleared)).not.toContain('CODEX_SKILL_MARKER_r2');
    expect(JSON.stringify(cleared)).toContain('CODEX_LOCAL_SKILL_MARKER');
    expect(await readFile(join(localDir, 'SKILL.md'), 'utf8')).toBe(localBytes);
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toContain('CODEX_SKILL_MARKER_r2');
    await expect(session.close()).rejects.toThrow(/drain\/persistence/);
    const emptySession = await testAdapter.openSession(
      openInput(roots, {
        inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1`,
        capabilityBaseUrl: `http://127.0.0.1:${mcp.port}/capabilities`,
      })
    );
    sessions.push(emptySession);
    // A fresh conversation makes this prompt proof independent of historical Skill descriptions.
    expect(
      (
        await (
          await emptySession.startTurn(turnInput(roots, [], 'Fresh empty Skill supply.'))
        ).settled
      ).status
    ).toBe('completed');
    const emptyBody = inference.bodies.at(-1) ?? '';
    expect(emptyBody).toContain('Fresh empty Skill supply.');
    expect(emptyBody).toContain('CODEX_LOCAL_SKILL_MARKER');
    expect(emptyBody).not.toContain('CODEX_SKILL_MARKER_r2');
    expect(await readFile(join(localDir, 'SKILL.md'), 'utf8')).toBe(localBytes);
  }, 180_000);
});

describe('round 4 failure boundaries', () => {
  async function fixture() {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer();
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
      controlTimeoutMs: 20,
    });
    return { roots, child, session };
  }

  it.each([
    'EOF',
    'close',
    'stream-error',
    'stderr-error',
    'process-error',
    'malformed',
    'malformed-plus-terminal',
  ])('rejects settlement after unproved stop: %s', async (mode) => {
    const { roots, child, session } = await fixture();
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    if (mode === 'EOF') {
      child.stdout.write(Buffer.from([0xe2, 0x82]));
      child.stdout.emit('end');
    } else if (mode === 'close') child.stdout.emit('close');
    else if (mode === 'stream-error') child.stdout.emit('error', new Error('lost stdout'));
    else if (mode === 'stderr-error')
      expect(() => child.stderr.emit('error', new Error('lost stderr'))).not.toThrow();
    else if (mode === 'process-error') child.emit('error', new Error('lost process'));
    else
      child.stdout.write(
        JSON.stringify({
          method: 'turn/completed',
          params: { threadId: NATIVE_THREAD, turn: { id: 'controlled-turn', status: 'future' } },
        }) +
          '\n' +
          (mode === 'malformed-plus-terminal' ? terminalFrame() : '')
      );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it.each([
    'completed',
    'inProgress',
  ])('rejects numeric accepted Turn identity: %s', async (status) => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer(undefined, { turn: { id: 42, status, items: [] } });
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
    });
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it.each([
    'completed',
    'inProgress',
  ])('rejects missing required accepted Turn items: %s', async (status) => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer(undefined, { turn: { id: 'controlled-turn', status } });
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
    });
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
  });

  it('rejects coercible native thread identity', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer(undefined, undefined, [NATIVE_THREAD]);
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
    });
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('fixes the admitted route set while allowing preferred-model changes', async () => {
    const { roots, child, session } = await fixture();
    const a = route();
    const b = { ...route('second-model'), id: 'route-2' };
    const requests: Array<{ method: string; params: { model?: string; extraRoots?: string[] } }> =
      [];
    child.stdin.on('data', (chunk) =>
      requests.push(
        ...chunk
          .toString()
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line))
      )
    );
    const input = { ...turnInput(roots, []), allowedLlmRoutes: [a, b] };
    const first = await session.startTurn(input);
    child.stdout.write(terminalFrame());
    await first.settled;
    for (const rejected of [
      { ...input, llmRoute: { ...a, model: 'unadmitted' } },
      { ...input, allowedLlmRoutes: [a] },
      { ...input, allowedLlmRoutes: [a, { ...b, providerInstanceId: 'changed' }] },
      {
        ...input,
        allowedLlmRoutes: [
          a,
          {
            ...b,
            modelParameters: {
              contextWindow: 100,
              maxOutputTokens: 10,
              inputModalities: ['text'] as const,
              reasoning: false,
            },
          },
        ],
      },
    ]) {
      const before = requests.length;
      await expect(session.startTurn(rejected)).rejects.toThrow(/route/);
      expect(requests).toHaveLength(before);
      expect(session.childState()).toBe('running');
    }
    const second = await session.startTurn({ ...input, allowedLlmRoutes: [b, a], llmRoute: b });
    child.stdout.write(terminalFrame());
    await second.settled;
    expect(requests.filter((r) => r.method === 'turn/start').map((r) => r.params.model)).toEqual([
      a.model,
      b.model,
    ]);
  });

  it('projects empty Skill roots after a nonempty Turn', async () => {
    const { roots, child, session } = await fixture();
    const requests: Array<{ method: string; params: { model?: string; extraRoots?: string[] } }> =
      [];
    child.stdin.on('data', (chunk) =>
      requests.push(
        ...chunk
          .toString()
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line))
      )
    );
    const first = await session.startTurn({
      ...turnInput(roots, []),
      skillTargetPaths: [{ id: 'old', targetPath: roots.work }],
    });
    child.stdout.write(terminalFrame());
    await first.settled;
    const second = await session.startTurn(turnInput(roots, []));
    child.stdout.write(terminalFrame());
    await second.settled;
    expect(
      requests.filter((r) => r.method === 'skills/extraRoots/set').map((r) => r.params.extraRoots)
    ).toEqual([[roots.work], []]);
  });

  it.each([
    'identical',
    'contradictory',
  ])('poisons duplicate terminal before publication: %s', async (mode) => {
    const { roots, child, session } = await fixture();
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    child.stdout.write(
      terminalFrame() + terminalFrame(mode === 'identical' ? 'completed' : 'failed')
    );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
  });

  it('fences a terminal received after publication', async () => {
    const { roots, child, session } = await fixture();
    const turn = await session.startTurn(turnInput(roots, []));
    child.stdout.write(terminalFrame());
    await expect(turn.settled).resolves.toMatchObject({ status: 'completed' });
    child.stdout.write(terminalFrame('failed'));
    await delay(15);
    const later = await session.startTurn(turnInput(roots, []));
    await expect(later.settled).rejects.toThrow(/unavailable/);
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('validates individual completed item discriminants', async () => {
    const { roots, child, session } = await fixture();
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    child.stdout.write(
      JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: NATIVE_THREAD,
          turnId: 'controlled-turn',
          item: { type: 'futureCoreItem', text: 'bad' },
        },
      }) +
        '\n' +
        terminalFrame()
    );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
  });

  it('memoizes failed close after later process exit', async () => {
    const { child, session } = await fixture();
    const a = session.close();
    const b = session.close();
    expect(a).toBe(b);
    await expect(a).rejects.toThrow();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(session.close()).toBe(a);
    await expect(session.close()).rejects.toThrow();
  });

  it('flushes incomplete stdout UTF-8 at EOF', async () => {
    const child = controlledPeer();
    const broken: string[] = [];
    new CodexAppServer(
      child,
      [],
      () => undefined,
      (reason) => broken.push(reason)
    );
    child.stdout.end(Buffer.from([0xe2, 0x82]));
    await delay(5);
    expect(broken).toHaveLength(1);
  });

  it.each([
    { id: 1, error: { code: 'unknown-native-code', message: 'bad' } },
    { id: 1, result: {}, error: { code: -32602, message: 'bad' } },
  ])('rejects malformed error/result alternatives: %j', async (frame) => {
    const child = controlledPeer();
    const broken: string[] = [];
    new CodexAppServer(
      child,
      [],
      () => undefined,
      (reason) => broken.push(reason)
    );
    child.stdout.write(`${JSON.stringify(frame)}\n`);
    expect(broken).toHaveLength(1);
  });

  it('keeps admission fenced across awaited setup after close begins', async () => {
    const { roots, child, session } = await fixture();
    child.stdin.end = (() => child.stdin) as typeof child.stdin.end;
    const requests: string[] = [];
    child.stdin.removeAllListeners('data');
    let threadRequestId: number | undefined;
    child.stdin.on('data', (chunk) => {
      const message = JSON.parse(chunk.toString());
      requests.push(message.method);
      if (message.method === 'config/read') {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { config: {} } })}\n`);
      } else threadRequestId = message.id;
    });
    const starting = session.startTurn(turnInput(roots, []));
    await delay(5);
    const closed = session.close().catch(() => undefined);
    child.stdout.write(
      `${JSON.stringify({ id: threadRequestId, result: { thread: { id: NATIVE_THREAD } } })}\n`
    );
    const turn = await starting;
    await expect(turn.settled).rejects.toThrow();
    await closed;
    expect(requests).toEqual(['config/read', 'thread/start']);
    await expect(session.startTurn(turnInput(roots, []))).rejects.toThrow(/closing/);
  });

  it('bounds setup and native cleanup without waiting for an unadmitted capture', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer();
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
      setupTimeoutMs: 10,
      controlTimeoutMs: 20,
    });
    let release: (() => void) | undefined;
    const captureWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = turnInput(roots, [], 'capture deadline', []);
    const starting = session.startTurn({
      ...input,
      runtimeCapture: { ...input.runtimeCapture, emit: () => captureWait },
    });
    const observed = starting.then(
      (turn) =>
        turn.settled.then(
          () => 'resolved',
          () => 'rejected'
        ),
      () => 'rejected'
    );
    expect(await Promise.race([observed, delay(100).then(() => 'pending')])).toBe('rejected');
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    release!();
    await delay(5);
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('returns unknown when exit races inspection and when inspection expires', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer('/test/rollout');
    let release: ((value: { size: number }) => void) | undefined;
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
      inspectTimeoutMs: 10,
      inspectRollout: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const turn = await session.startTurn(turnInput(roots, []));
    child.stdout.write(terminalFrame());
    await turn.settled;
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
    const inspecting = session.nativeHandle();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    release!({ size: 1 });
    expect(await inspecting).toEqual({ state: 'unknown' });
  });

  it('bounds interrupt terminal proof while ordinary model work has no control deadline', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const child = controlledPeer();
    const session = await openCodexResidentSession(openInput(roots), {
      spawnProcess: () => child,
      stopGraceMs: 5,
      controlTimeoutMs: 10,
    });
    const turn = await session.startTurn(turnInput(roots, []));
    const observed = turn.settled.then(
      () => 'resolved',
      () => 'rejected'
    );
    expect(await Promise.race([observed, delay(30).then(() => 'pending')])).toBe('pending');
    await expect(turn.interrupt()).rejects.toThrow(/unproved/);
    expect(await observed).toBe('rejected');
  });

  it('bounds initialization of a stopped real vendor process inside ten seconds', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    let child: ChildProcessWithoutNullStreams | undefined;
    const before = performance.now();
    await expect(
      openCodexResidentSession(openInput(roots), {
        binaryPath: vendorBinary,
        stopGraceMs: 5,
        spawnProcess: (binary, args, options) => {
          child = spawn(binary, [...args], {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          }) as ChildProcessWithoutNullStreams;
          process.kill(child.pid!, 'SIGSTOP');
          trackChild(child);
          return child;
        },
      })
    ).rejects.toThrow();
    expect(performance.now() - before).toBeLessThanOrEqual(10_000);
    expect(processIsGone(child!.pid!)).toBe(true);
  }, 12_000);

  it('preserves drain failure after forced native termination', async () => {
    const roots = await tempRoots();
    closers.push(async () => rm(roots.base, { recursive: true, force: true }));
    const inference = await responsesServer();
    let child: ChildProcessWithoutNullStreams | undefined;
    const session = await openCodexResidentSession(
      openInput(roots, { inferenceBaseUrl: `http://127.0.0.1:${inference.port}/inference/v1` }),
      {
        binaryPath: vendorBinary,
        stopGraceMs: 250,
        spawnProcess: (binary, args, options) => {
          child = spawn(binary, [...args], {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          }) as ChildProcessWithoutNullStreams;
          trackChild(child);
          return child;
        },
      }
    );
    const turn = await session.startTurn(turnInput(roots, [], 'hang please'));
    await inference.untilHung();
    process.kill(child!.pid!, 'SIGSTOP');
    await expect(session.close()).rejects.toThrow(/drain\/persistence/);
    expect(child!.signalCode).toBe('SIGKILL');
    expect(processIsGone(child!.pid!)).toBe(true);
    await expect(turn.settled).resolves.toMatchObject({ status: 'failed' });
  }, 12_000);

  it('poisons conflict between an immediate result and an early terminal', async () => {
    const { roots, child, session } = await fixture();
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        if (message.method === 'config/read') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { config: {} } })}\n`);
          continue;
        }
        if (message.method === 'turn/start')
          child.stdout.write(
            terminalFrame('failed') +
              JSON.stringify({
                id: message.id,
                result: { turn: { id: 'controlled-turn', status: 'completed', items: [] } },
              }) +
              '\n'
          );
        else
          child.stdout.write(
            `${JSON.stringify({ id: message.id, result: { thread: { id: NATIVE_THREAD } } })}\n`
          );
      }
    });
    const turn = await session.startTurn(turnInput(roots, []));
    await expect(turn.settled).rejects.toThrow(/unproved/);
  });

  it('streams every multibyte stdout split and bounds permission accumulation', async () => {
    const frame = Buffer.from(
      `${JSON.stringify({ method: 'future/event', params: { text: 'a€💡中z' } })}\n`
    );
    for (let split = 1; split < frame.length; split += 1) {
      const child = controlledPeer();
      const values: unknown[] = [];
      const broken: string[] = [];
      new CodexAppServer(
        child,
        [],
        (_, value) => values.push(value),
        (reason) => broken.push(reason)
      );
      child.stdout.write(frame.subarray(0, split));
      child.stdout.write(frame.subarray(split));
      expect(values).toEqual([{ text: 'a€💡中z' }]);
      expect(broken).toEqual([]);
    }
    const child = controlledPeer();
    const rpc = new CodexAppServer(
      child,
      [],
      () => undefined,
      () => undefined
    );
    for (let i = 0; i < 100; i += 1)
      child.stdout.write(
        `${JSON.stringify({ id: 100 + i, method: 'item/commandExecution/requestApproval', params: {} })}\n`
      );
    expect(rpc.permissionRecords).toHaveLength(16);
    child.stderr.write(Buffer.from([0xe2]));
    child.stderr.write(Buffer.from([0x82, 0xac]));
    child.stderr.end();
    await delay(5);
    expect(rpc.stderrDiagnostic()).toBe('€');
  });

  it('resets permission diagnostics at the next Turn boundary', async () => {
    const { roots, child, session } = await fixture();
    const first = await session.startTurn(turnInput(roots, []));
    child.stdout.write(
      `${JSON.stringify({ id: 200, method: 'item/commandExecution/requestApproval', params: {} })}\n` +
        terminalFrame()
    );
    expect((await first.settled).diagnostics?.nativePermissions).toContain('cancel:');
    const second = await session.startTurn(turnInput(roots, [], 'next turn'));
    child.stdout.write(terminalFrame());
    expect((await second.settled).diagnostics?.nativePermissions).toBeUndefined();
  });

  it('redacts and bounds unknown native method records and UTF-8 diagnostics', async () => {
    const child = controlledPeer();
    const rpc = new CodexAppServer(
      child,
      [INFERENCE_SECRET],
      () => undefined,
      () => undefined
    );
    child.stdout.write(`${JSON.stringify({ id: 99, method: INFERENCE_SECRET, params: {} })}\n`);
    const oversizedChild = controlledPeer();
    const oversized = new CodexAppServer(
      oversizedChild,
      [],
      () => undefined,
      () => undefined
    );
    oversizedChild.stdout.write(
      `${JSON.stringify({ id: 100, method: '€'.repeat(20_000), params: {} })}\n`
    );
    expect(oversized.permissionRecords).toEqual([{ method: 'unknown', outcome: 'unsupported' }]);
    expect(JSON.stringify(rpc.permissionRecords)).not.toContain(INFERENCE_SECRET);
    expect(Buffer.byteLength(JSON.stringify(rpc.permissionRecords))).toBeLessThan(2048);
    for (const [text, secrets] of [
      ['€'.repeat(6000), []],
      ['a'.repeat(20_000), ['a']],
    ] as const) {
      const bounded = redactDiagnostic(text, secrets);
      expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(16 * 1024);
      expect(bounded).not.toContain('�');
    }
  });

  it.each([
    'unknown-native-code',
    -32099,
  ])('does not accept unknown native RPC error semantics as refusal: %s', async (code) => {
    const { roots, child, session } = await fixture();
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.method === 'config/read') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { config: {} } })}\n`);
          continue;
        }
        child.stdout.write(
          `${JSON.stringify({
            id: message.id,
            error: { code, message: 'bad', provedRefusal: true },
          })}\n`
        );
      }
    });
    const turn = await session.startTurn(turnInput(roots, []));
    await expect(turn.settled).rejects.toThrow();
    expect(await session.nativeHandle()).toEqual({ state: 'unknown' });
  });

  it('bounds the complete backpressured send and cleans listeners', async () => {
    const child = controlledPeer();
    child.stdin.removeAllListeners('data');
    child.stdin.write = (() => false) as typeof child.stdin.write;
    const rpc = new CodexAppServer(
      child,
      [],
      () => undefined,
      () => undefined
    );
    const observed = rpc.request('initialize', {}, 10).then(
      () => 'resolved',
      () => 'rejected'
    );
    expect(await Promise.race([observed, delay(60).then(() => 'pending')])).toBe('rejected');
    expect(child.stdin.listenerCount('drain')).toBe(0);
    expect(child.stdin.listenerCount('close')).toBe(0);
  });
});

const NATIVE_THREAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
/** One terminal frame for boundary tests. */
function terminalFrame(status = 'completed'): string {
  return `${JSON.stringify({
    method: 'turn/completed',
    params: { threadId: NATIVE_THREAD, turn: { id: 'controlled-turn', status, items: [] } },
  })}\n`;
}
/** Short observation delay; never a native-settlement oracle. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Controllable stdio peer with deliberately unproved process stop. */
function controlledPeer(
  rolloutPath?: string,
  turnResult?: unknown,
  threadId: unknown = NATIVE_THREAD
): ChildProcessWithoutNullStreams {
  const child = childThatNeverExits(false);
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const result =
        message.method === 'config/read'
          ? { config: { mcp_servers: {} } }
          : message.method === 'thread/start'
            ? { thread: { id: threadId, path: rolloutPath } }
            : message.method === 'turn/start'
              ? (turnResult ?? { turn: { id: 'controlled-turn', status: 'inProgress', items: [] } })
              : {};
      child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  });
  return child;
}

/** Counts rollout files under one Codex home. */
function countRollouts(paths: readonly string[]): number {
  return paths.filter((name) => name.includes('rollout-')).length;
}

/** Polls until the rollout file makes the handle resumable. */
async function readyReferenceOf(session: WorkerResidentSession): Promise<Uint8Array> {
  let reference: Uint8Array | undefined;
  await expect
    .poll(
      async () => {
        const handle = await session.nativeHandle();
        if (handle.state === 'ready') reference = handle.reference;
        return handle.state;
      },
      { timeout: 5_000 }
    )
    .toBe('ready');
  if (!reference) throw new Error('Codex handle became ready without a reference.');
  return reference;
}

function route(
  model = 'openkit-logical-model',
  upstream: 'nanocore-gateway' | 'direct-provider' = 'nanocore-gateway'
): WorkerAdapterLlmRoute {
  return {
    credentialVisibility: 'placeholder',
    endpoint: {
      kind: 'openai-compatible',
      ...(upstream === 'direct-provider' ? { workerBaseUrl: 'https://example.invalid/v1' } : {}),
      upstream: { kind: upstream },
    },
    id: 'route-1',
    model,
    providerInstanceId: 'provider-1',
  };
}

async function tempRoots(): Promise<{
  base: string;
  state: string;
  control: string;
  home: string;
  work: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'codex-adapter-'));
  const state = join(base, 'state');
  const control = join(base, 'control');
  const home = join(base, 'home');
  const work = join(base, 'work');
  await Promise.all([state, control, home, work].map((path) => mkdir(path, { recursive: true })));
  return { base, state, control, home, work };
}

function openInput(
  roots: { state: string; control: string; home: string },
  overrides: {
    capabilityCredential?: string;
    inferenceCredential?: string;
    inferenceBaseUrl?: string;
    capabilityBaseUrl?: string;
    agentSessionId?: string;
    resumeReference?: Uint8Array;
  } = {},
  environment: Record<string, string> = {}
): WorkerResidentOpenInput {
  return {
    agentSessionId: overrides.agentSessionId ?? 'as_codex',
    controlRoot: roots.control,
    environment: {
      PATH: process.env.PATH ?? '',
      HOME: roots.home,
      TMPDIR: roots.home,
      ...environment,
    },
    loopback: {
      capabilityBaseUrl: overrides.capabilityBaseUrl ?? 'http://127.0.0.1:9/capabilities',
      capabilityCredential:
        overrides.capabilityCredential === undefined
          ? CAPABILITY_SECRET
          : overrides.capabilityCredential,
      inferenceBaseUrl: overrides.inferenceBaseUrl ?? 'http://127.0.0.1:9/inference/v1',
      inferenceCredential: overrides.inferenceCredential ?? INFERENCE_SECRET,
    },
    resumeReference: overrides.resumeReference ?? null,
    stateRoot: roots.state,
  };
}

/** True when the pid cannot be signaled because it has exited. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Direct children of this test process, or null when `pgrep` cannot run. */
function directChildPids(): number[] | null {
  const listed = spawnSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' });
  if (listed.error) return null;
  return (listed.stdout ?? '')
    .split('\n')
    .map((line) => Number(line))
    .filter((pid) => pid > 0);
}

/** Kills a scripted peer if the assertion fails before the adapter stops it. */
function trackChild(child: ChildProcessWithoutNullStreams): void {
  closers.push(
    () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      })
  );
}

/**
 * Stdio peer that never emits `exit`. Its initialize error fails the open, and `kill` leaves
 * the process looking live so the adapter must not reject the open as a clean refusal.
 */
function childThatNeverExits(initializeError = true): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams['stdin'];
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1_000_000_001;
  child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
  if (initializeError)
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: 1, error: { message: 'initialize failed' } })}\n`);
    });
  return child;
}

/** Node peer that speaks just enough App Server JSON-RPC to reach one failure. */
function spawnScriptedCodex(
  mode:
    | 'resume-error'
    | 'turn-missing'
    | 'turn-refused'
    | 'terminal-failed'
    | 'terminal-same-chunk'
    | 'terminal-before'
    | 'terminal-missing-thread'
    | 'terminal-wrong-thread'
    | 'terminal-unknown-item'
    | 'terminal-unknown-status'
    | 'terminal-in-progress'
    | 'terminal-malformed-assistant'
    | 'additive-before-terminal'
    | 'broken-after-accept'
    | 'exit-during-accept'
): ChildProcessWithoutNullStreams {
  const script = `
let buf = '';
const mode = ${JSON.stringify(mode)};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id == null || typeof msg.method !== 'string') continue;
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: {} });
      continue;
    }
    if (msg.method === 'skills/extraRoots/set') {
      send({ id: msg.id, result: {} });
      continue;
    }
    if (msg.method === 'config/read') {
      send({ id: msg.id, result: { config: { mcp_servers: {} } } });
      continue;
    }
    if (msg.method === 'thread/start') {
      send({
        id: msg.id,
        result: { thread: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } },
      });
      continue;
    }
    if (msg.method === 'thread/read') {
      send({ id: msg.id, error: { code: -32000, message: 'no rollout found' } });
      continue;
    }
    if (msg.method === 'thread/resume') {
      send({ id: msg.id, error: { code: -32000, message: 'no rollout found' } });
      continue;
    }
    if (msg.method === 'turn/start' && mode === 'turn-missing') {
      send({ id: msg.id, result: { turn: { status: 'inProgress', items: [] } } });
      continue;
    }
    if (msg.method === 'turn/start' && mode === 'turn-refused') {
      send({ id: msg.id, error: { code: -32602, message: 'turn refused' } });
    }
    if (msg.method === 'turn/start' && mode === 'broken-after-accept') {
      send({ id: msg.id, result: { turn: { id: 'turn-scripted', status: 'inProgress', items: [] } } });
      setTimeout(() => process.stdout.write('null\\n'), 20);
    }
    if (msg.method === 'turn/start' && mode === 'exit-during-accept') process.exit(1);
    if (msg.method === 'turn/start' && (mode.startsWith('terminal-') || mode === 'additive-before-terminal')) {
      const accepted = { id: msg.id, result: { turn: { id: 'turn-scripted', status: 'inProgress', items: [] } } };
      const item = mode === 'terminal-unknown-item' ? { type: 'futureCoreItem', text: 'bad' } : { type: 'agentMessage', text: mode === 'terminal-malformed-assistant' ? 7 : 'ok' };
      const terminal = { method: 'turn/completed', params: {
        ...(mode === 'terminal-missing-thread' ? {} : { threadId: mode === 'terminal-wrong-thread' ? 7 : 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
        turn: { id: 'turn-scripted', status: mode === 'terminal-failed' ? 'failed' : mode === 'terminal-unknown-status' ? 'futureStatus' : mode === 'terminal-in-progress' ? 'inProgress' : 'completed', items: [item] }
      }};
      const a = JSON.stringify(accepted) + '\\n';
      const t = JSON.stringify(terminal) + '\\n';
      const additive = JSON.stringify({method:'future/additive',params:{threadId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}}) + '\\n';
      if (mode === 'terminal-before') process.stdout.write(t + a);
      else if (mode === 'terminal-same-chunk') process.stdout.write(a + t);
      else if (mode === 'additive-before-terminal') process.stdout.write(a + additive + t);
      else {
        process.stdout.write(a);
        setTimeout(() => process.stdout.write(t), 20);
      }
    }
  }
});
`;
  return spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

function turnInput(
  roots: { state: string; work: string },
  mcpServerIds: readonly string[],
  turnInputText = 'Remember the word cedar.',
  observations?: unknown[]
): WorkerResidentTurnInput {
  const capture: RuntimeCaptureInput = {
    captureCoverage: { scope: 'task', value: observations ? 'on' : 'off' },
    credentialValues: [INFERENCE_SECRET, CAPABILITY_SECRET],
    emit: async (record) => {
      observations?.push(record);
    },
    packageSnapshotId: 'pkg_codex',
  };
  return {
    llmRoute: route(),
    allowedLlmRoutes: [route(), { ...route('second-model'), id: 'route-2' }],
    mcpServerIds,
    runtimeCapture: capture,
    skillTargetPaths: [],
    turnDirectory: roots.work,
    turnId: `turn_${mcpServerIds.join('_') || 'none'}_${turnInputText.length}`,
    turnInput: turnInputText,
    workingDirectory: roots.work,
  };
}

async function responsesServer(): Promise<{
  port: number;
  bodies: string[];
  hang: boolean;
  untilHung: () => Promise<void>;
}> {
  const bodies: string[] = [];
  let hang = false;
  let resolveHung = () => undefined;
  const hung = new Promise<void>((resolve) => {
    resolveHung = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = await readBody(request);
    bodies.push(body);
    if (
      ![`Bearer ${INFERENCE_SECRET}`, 'Bearer successor-inference-secret'].includes(
        request.headers.authorization ?? ''
      )
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (latestMarker(body) === 'hang please') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_hang","status":"in_progress","output":[]}}\n\n'
      );
      resolveHung();
      return;
    }
    if (latestMarker(body) === 'invoke alpha tool' && !body.includes('function_call_output')) {
      writeFunctionCall(response, advertisedMcpTool(body));
      return;
    }
    const text = replyFor(body);
    const payload = {
      id: 'resp_ok',
      status: 'completed',
      output: [
        {
          id: 'msg_ok',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...payload, status: 'in_progress', output: [] } })}\n\n`
    );
    response.write(
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: payload.output[0] })}\n\n`
    );
    response.end(
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`
    );
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('inference listen failed');
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      })
  );
  return {
    port: address.port,
    bodies,
    get hang() {
      return hang;
    },
    set hang(value: boolean) {
      hang = value;
      if (value) {
        void hung;
      }
    },
    untilHung: () => hung,
  };
}

async function mcpServer(
  binding = { port: 0, host: '127.0.0.1', credential: CAPABILITY_SECRET }
): Promise<{
  port: number;
  idle: boolean;
  readonly requestCount: number;
  readonly requests: ReadonlyArray<{ path: string | undefined; authorization: string | undefined }>;
  holdCalls: boolean;
  untilHeld: () => Promise<void>;
  releaseCalls: () => void;
}> {
  let holdCalls = false;
  let idle = false;
  let requestCount = 0;
  const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
  let resolveHeld = () => undefined;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const waiting: Array<{ end: () => void }> = [];
  const server = createServer(async (request, response) => {
    requestCount += 1;
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (idle) {
      response.writeHead(403);
      response.end();
      return;
    }
    const raw = await readBody(request);
    let message: { id?: unknown; method?: string; params?: { protocolVersion?: string } } = {};
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.id == null) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (
      ![`Bearer ${binding.credential}`, 'Bearer successor-capability-secret'].includes(
        request.headers.authorization ?? ''
      )
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    const tool = request.url?.includes('gamma')
      ? 'gamma_tool'
      : request.url?.includes('beta')
        ? 'beta_tool'
        : 'alpha_tool';
    if (message.method === 'tools/call' && holdCalls) {
      waiting.push({
        end: () => {
          response.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'codex-test',
          });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: 'tool-done' }] },
            })
          );
        },
      });
      resolveHeld();
      return;
    }
    const result =
      message.method === 'tools/list'
        ? {
            tools: [
              { name: tool, description: 't', inputSchema: { type: 'object', properties: {} } },
            ],
          }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'tool-done' }] }
          : {
              protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'codex-test', version: '0' },
            };
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'codex-test' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await listen(server, binding.port, binding.host);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mcp listen failed');
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      })
  );
  return {
    port: address.port,
    requests,
    get idle() {
      return idle;
    },
    set idle(value: boolean) {
      idle = value;
    },
    get requestCount() {
      return requestCount;
    },
    get holdCalls() {
      return holdCalls;
    },
    set holdCalls(value: boolean) {
      holdCalls = value;
    },
    untilHeld: () =>
      Promise.race([
        held,
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('MCP tool was not called')), 8_000);
        }),
      ]),
    releaseCalls: () => {
      for (const heldCall of waiting.splice(0)) heldCall.end();
    },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function listen(
  server: ReturnType<typeof createServer>,
  port = 0,
  host = '127.0.0.1'
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else found.push(path);
    }
  }
  await visit(directory);
  return found;
}

async function filesContaining(directory: string, needles: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const path of await walk(directory)) {
    const bytes = await readFile(path);
    if (needles.some((needle) => bytes.includes(Buffer.from(needle)))) hits.push(path);
  }
  return hits;
}

/**
 * Codex routes an MCP tool only when the function call carries the namespace it advertised.
 * A bare tool name comes back as `unsupported call`.
 */
function advertisedMcpTool(body: string): { namespace: string; name: string } {
  const match = body.match(
    /"type":"namespace","name":"(mcp__[^"]+)","description":"[^"]*","tools":\[\{"type":"function","name":"([^"]+)"/
  );
  const namespace = match?.[1];
  const name = match?.[2];
  if (namespace && name) return { namespace, name };
  return { namespace: 'mcp__alpha', name: 'alpha_tool' };
}

/** Streams one namespaced Responses function call. The MCP server is what then blocks. */
function writeFunctionCall(
  response: ServerResponse,
  tool: { namespace: string; name: string }
): void {
  const item = {
    id: 'fc_alpha',
    type: 'function_call',
    status: 'completed',
    name: tool.name,
    namespace: tool.namespace,
    call_id: 'call_alpha',
    arguments: '{}',
  };
  const payload = { id: 'resp_tool', status: 'completed', output: [item] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_tool', status: 'in_progress', output: [] } })}\n\n`
  );
  response.write(
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } })}\n\n`
  );
  response.write(
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_alpha', arguments: '{}' })}\n\n`
  );
  response.write(
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`
  );
  response.end(
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`
  );
}

/** Latest user sentence this test sent. Tool schemas and earlier history do not win. */
function latestMarker(body: string): string {
  const markers = [
    'Continue after interrupt.',
    'Say other.',
    'What word did I ask you to remember?',
    'Remember the word cedar.',
    'invoke alpha tool',
    'hang please',
  ];
  let best = -1;
  let marker = '';
  for (const candidate of markers) {
    const at = body.lastIndexOf(candidate);
    if (at > best) {
      best = at;
      marker = candidate;
    }
  }
  return marker;
}

/** Picks the assistant text from the latest user sentence, not from tool-schema words. */
function replyFor(body: string): string {
  if (latestMarker(body) === 'Continue after interrupt.') return 'continued-answer';
  if (latestMarker(body) === 'What word did I ask you to remember?') return 'beta-answer';
  return 'alpha-answer';
}
