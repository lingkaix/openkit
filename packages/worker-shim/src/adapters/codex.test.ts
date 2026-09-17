import { createHash } from 'node:crypto';
// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerAdapterPrepareInput, WorkerNativeProcessResult } from '../adapter-registry.js';
import { codexAdapter } from './codex.js';
import { loadCodexUnknownModelFallbackPrompt } from './codex-unknown-model-catalog.js';

const NATIVE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const TEST_THREAD_ID = '019f0000-0000-7000-8000-000000000099';
const finalMessageRace = vi.hoisted(() => ({
  path: null as string | null,
  replace: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1]
    ) => {
      const handle = await actual.open(path, flags);
      if (String(path) === finalMessageRace.path) {
        finalMessageRace.path = null;
        finalMessageRace.replace?.();
      }
      return handle;
    },
  };
});

/**
 * Creates one isolated Codex adapter input.
 *
 * @returns Adapter input with one Shim-selected LLM route.
 */
function codexInput(): WorkerAdapterPrepareInput {
  const root = mkdtempSync(join(tmpdir(), 'openkit-codex-adapter-'));

  return {
    childEnvironment: {
      OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
      PATH: process.env.PATH ?? '',
    },
    controlRoot: join(root, 'session', 'native-control'),
    llmRoute: {
      credentialVisibility: 'placeholder',
      endpoint: {
        kind: 'openai-compatible',
        upstream: {
          kind: 'nanocore-gateway',
        },
      },
      id: 'worker-inference',
      model: 'gpt-5',
      providerInstanceId: 'provider_openai',
    },
    sessionDirectory: join(root, 'session'),
    stateRoot: join(root, 'state'),
    turnInput: 'Summarize the repository.',
    workingDirectory: '/workspace/repository',
  };
}

/**
 * Creates one normally exited native process result.
 *
 * @param exitCode Native process exit code.
 * @returns Bounded process output presented to adapter collection.
 */
function nativeResult(exitCode = 0): WorkerNativeProcessResult {
  return {
    exitCode,
    interrupted: false,
    signal: null,
    stderr: '',
    stdout: new Uint8Array(),
  };
}

/** Writes one pinned root rollout proving the exact native conversation UUID. */
function writeRootRollout(stateRoot: string, threadId: string): void {
  const directory = join(stateRoot, 'sessions', '2026', '08', '21');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `rollout-${threadId}.jsonl`),
    `${JSON.stringify({
      payload: {
        cli_version: '0.153.4',
        cwd: '/workspace/repository',
        id: threadId,
        originator: 'codex_exec',
        session_id: threadId,
        source: 'exec',
        timestamp: '2026-08-21T00:00:00.000Z',
      },
      timestamp: '2026-08-21T00:00:00.000Z',
      type: 'session_meta',
    })}\n`,
    'utf8'
  );
}

/** Resolves the startup-bound native catalog path from one Codex launch plan. */
function catalogPathFromArgv(argv: readonly string[]): string {
  for (let index = 0; index < argv.length - 1; index += 1) {
    const override = argv[index + 1];
    if (argv[index] === '-c' && override?.startsWith('model_catalog_json=')) {
      return JSON.parse(override.slice('model_catalog_json='.length)) as string;
    }
  }
  throw new Error('Codex launch plan is missing model_catalog_json.');
}

/** Reads the secret-free native catalog bound into one Codex launch plan. */
function readBoundCatalog(argv: readonly string[]): {
  catalog: { models: Array<Record<string, unknown>> };
  path: string;
} {
  const path = catalogPathFromArgv(argv);
  return {
    catalog: JSON.parse(readFileSync(path, 'utf8')) as {
      models: Array<Record<string, unknown>>;
    },
    path,
  };
}

/** Supplies the native conversation proof required by a successful continuity Turn. */
async function collectTestTurn(
  input: WorkerAdapterPrepareInput,
  launchPlan: Awaited<ReturnType<typeof codexAdapter.prepareTurn>>,
  processResult: WorkerNativeProcessResult
) {
  mkdirSync(input.controlRoot, { recursive: true });
  if (processResult.exitCode === 0 && !processResult.interrupted) {
    writeRootRollout(input.stateRoot, TEST_THREAD_ID);
  }
  return codexAdapter.collectTurn({
    controlRoot: input.controlRoot,
    launchPlan,
    processResult:
      processResult.exitCode === 0 && !processResult.interrupted
        ? {
            ...processResult,
            stdout: Buffer.from(
              `${JSON.stringify({ thread_id: TEST_THREAD_ID, type: 'thread.started' })}\n`
            ),
          }
        : processResult,
    stateRoot: input.stateRoot,
  });
}

describe('Codex worker adapter', () => {
  it('opens a pending Session, establishes one exact UUID, resumes it, and closes only that root', async () => {
    const first = codexInput();
    const sibling = codexInput();
    const threadId = '019f0000-0000-7000-8000-000000000001';
    mkdirSync(first.sessionDirectory, { recursive: true });
    mkdirSync(sibling.sessionDirectory, { recursive: true });

    await expect(
      codexAdapter.openSession({ controlRoot: first.controlRoot, stateRoot: first.stateRoot })
    ).resolves.toEqual({
      nativeHandle: null,
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
    });
    await codexAdapter.openSession({
      controlRoot: sibling.controlRoot,
      stateRoot: sibling.stateRoot,
    });
    const initialPlan = await codexAdapter.prepareTurn(first);
    expect(initialPlan.argv).not.toContain('resume');
    expect(initialPlan.argv).not.toContain('--ephemeral');
    expect(initialPlan.argv).toContain('--cd');
    expect(initialPlan.argv[initialPlan.argv.indexOf('--cd') + 1]).toBe(first.workingDirectory);
    writeRootRollout(first.stateRoot, threadId);
    writeFileSync(
      initialPlan.argv[initialPlan.argv.indexOf('--output-last-message') + 1] as string,
      'First answer.',
      'utf8'
    );

    const collected = await codexAdapter.collectTurn({
      launchPlan: initialPlan,
      processResult: {
        ...nativeResult(),
        stdout: Buffer.from(`${JSON.stringify({ thread_id: threadId, type: 'thread.started' })}\n`),
      },
      controlRoot: first.controlRoot,
      stateRoot: first.stateRoot,
    });
    expect(collected.nativeHandle).toBe(threadId);
    expect(collected.nativeHandleDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      codexAdapter.inspectSession({ controlRoot: first.controlRoot, stateRoot: first.stateRoot })
    ).resolves.toMatchObject({
      nativeHandleDigest: collected.nativeHandleDigest,
      nativeHandleState: 'ready',
    });

    const resumedPlan = await codexAdapter.prepareTurn({
      ...first,
      nativeTurnDirectory: join(first.sessionDirectory, 'second-turn'),
    });
    const resumeIndex = resumedPlan.argv.indexOf('resume');
    expect(resumedPlan.argv[resumeIndex + 1]).toBe('--json');
    expect(resumedPlan.argv.at(-2)).toBe(threadId);
    expect(resumedPlan.argv.at(-1)).toBe(first.turnInput);
    expect(resumedPlan.argv).not.toContain('--cd');
    expect(resumedPlan.argv).not.toContain(first.workingDirectory);
    await expect(
      codexAdapter.inspectSession({
        controlRoot: sibling.controlRoot,
        stateRoot: sibling.stateRoot,
      })
    ).resolves.toMatchObject({
      nativeHandleState: 'pending',
    });
    writeFileSync(join(first.stateRoot, 'unknown-native-data.bin'), Buffer.from([0, 1, 2, 3]));

    await expect(
      codexAdapter.closeSession({
        controlRoot: first.controlRoot,
        sessionDirectory: first.sessionDirectory,
      })
    ).resolves.toEqual({ privateState: 'absent' });
    expect(existsSync(first.stateRoot)).toBe(true);
    expect(existsSync(first.controlRoot)).toBe(false);
    expect(readFileSync(join(first.stateRoot, 'unknown-native-data.bin'))).toEqual(
      Buffer.from([0, 1, 2, 3])
    );
    expect(existsSync(sibling.stateRoot)).toBe(true);

    const successor = {
      ...first,
      controlRoot: join(first.sessionDirectory, 'successor-control'),
      sessionDirectory: join(first.sessionDirectory, 'successor'),
    };
    await expect(
      codexAdapter.openSession({
        controlRoot: successor.controlRoot,
        stateRoot: successor.stateRoot,
      })
    ).resolves.toMatchObject({ nativeHandleState: 'pending' });
    const successorPlan = await codexAdapter.prepareTurn(successor);
    expect(successorPlan.argv).not.toContain('resume');
    expect(readFileSync(join(successor.stateRoot, 'unknown-native-data.bin'))).toEqual(
      Buffer.from([0, 1, 2, 3])
    );
  });

  it('creates the isolated Codex home before launch', async () => {
    const input = codexInput();

    await codexAdapter.prepareTurn(input);

    expect(lstatSync(input.stateRoot).isDirectory()).toBe(true);
  });

  it('prepares the pinned one-shot command without a config-artifact envelope', async () => {
    const input = codexInput();
    const plan = await codexAdapter.prepareTurn(input);

    expect(plan.argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--output-last-message',
      join(input.sessionDirectory, 'final-message.txt'),
      '--cd',
      input.workingDirectory,
      '-c',
      'skills.bundled.enabled=false',
      '-c',
      `model_catalog_json=${JSON.stringify(join(input.controlRoot, 'model-catalog.json'))}`,
      '-c',
      'model_provider="openkit-worker-inference"',
      '-c',
      'web_search="disabled"',
      '-c',
      'model_providers.openkit-worker-inference.name="OpenKit Worker Inference"',
      '-c',
      'model_providers.openkit-worker-inference.base_url="http://127.0.0.1:17892/inference/v1"',
      '-c',
      'model_providers.openkit-worker-inference.env_key="OPENKIT_WORKER_INFERENCE_TOKEN"',
      '-c',
      'model_providers.openkit-worker-inference.wire_api="responses"',
      '-c',
      'model_providers.openkit-worker-inference.requires_openai_auth=false',
      '--model',
      'gpt-5',
      '--dangerously-bypass-approvals-and-sandbox',
      input.turnInput,
    ]);
    expect(plan.captureStdout).toBe(true);
    expect(plan.environment).toMatchObject({
      OPENKIT_WORKER_INFERENCE_TOKEN: 'openshell-placeholder-value',
    });
    expect(plan.environment.CODEX_HOME).toContain(input.stateRoot);
    expect(plan.argv).not.toContain('openshell-placeholder-value');
    expect(plan).not.toHaveProperty('configArtifacts');
  });

  it.each([
    'file',
    'symlink',
  ])('rejects an existing catalog %s without changing its target', async (kind) => {
    const input = codexInput();
    const nativeTurnDirectory = join(input.sessionDirectory, 'private-turn');
    mkdirSync(nativeTurnDirectory, { recursive: true });
    const target = join(input.sessionDirectory, 'unrelated.txt');
    const catalog = join(nativeTurnDirectory, 'model-catalog.json');
    writeFileSync(target, 'preserve-me');
    if (kind === 'symlink') symlinkSync(target, catalog);
    else writeFileSync(catalog, 'stale-catalog');
    await expect(codexAdapter.prepareTurn({ ...input, nativeTurnDirectory })).rejects.toMatchObject(
      { code: 'EEXIST' }
    );
    expect(readFileSync(target, 'utf8')).toBe('preserve-me');
    expect(readFileSync(catalog, 'utf8')).toBe(
      kind === 'symlink' ? 'preserve-me' : 'stale-catalog'
    );
  });

  it('leaves pinned bundled catalog matches without a generated descriptor', async () => {
    const input = codexInput();
    for (const model of ['gpt-6-astra', 'gpt-5.2', 'gpt-5.2-codex', 'custom/gpt-5.4'] as const) {
      const plan = await codexAdapter.prepareTurn({
        ...input,
        llmRoute: { ...input.llmRoute, model },
      });
      expect(plan.argv.some((argument) => argument.startsWith('model_catalog_json='))).toBe(false);
      expect(plan.argv[plan.argv.indexOf('--model') + 1]).toBe(model);
    }
    expect(existsSync(join(input.controlRoot, 'model-catalog.json'))).toBe(false);
  });

  it('binds a Turn-private unknown-model catalog with freeform apply_patch at first exec and UUID resume', async () => {
    const input = codexInput();
    const nativeTurnDirectory = join(input.sessionDirectory, 'turns', 'native-turn');
    const prepared = {
      ...input,
      nativeTurnDirectory,
    };
    mkdirSync(prepared.controlRoot, { recursive: true });
    const firstPlan = await codexAdapter.prepareTurn(prepared);
    const firstCatalog = readBoundCatalog(firstPlan.argv);
    const serialized = JSON.stringify(firstCatalog.catalog);
    const [model] = firstCatalog.catalog.models;

    expect(firstPlan.argv).not.toContain('resume');
    expect(firstCatalog.path).toBe(join(nativeTurnDirectory, 'model-catalog.json'));
    expect(existsSync(join(prepared.stateRoot, 'model-catalog.json'))).toBe(false);
    expect(existsSync(join(prepared.controlRoot, 'model-catalog.json'))).toBe(false);
    const bundled = JSON.parse(
      readFileSync(
        new URL('../../snapshots/codex-0.153.4/bundled-models.json', import.meta.url),
        'utf8'
      )
    );
    expect(firstCatalog.catalog.models.slice(1)).toEqual(bundled.models);
    expect(model).toMatchObject({
      apply_patch_tool_type: 'freeform',
      base_instructions: loadCodexUnknownModelFallbackPrompt(),
      context_window: 272_000,
      description: null,
      display_name: 'gpt-5',
      experimental_supported_tools: [],
      include_apps_usage_instructions: false,
      max_context_window: 272_000,
      priority: 99,
      shell_type: 'unified_exec',
      slug: 'gpt-5',
      support_verbosity: false,
      supported_in_api: true,
      supported_reasoning_levels: [],
      truncation_policy: { limit: 10_000, mode: 'bytes' },
      visibility: 'none',
    });
    expect(createHash('sha256').update(String(model?.base_instructions)).digest('hex')).toBe(
      '3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d'
    );
    expect(model).not.toHaveProperty('model_messages');
    expect(serialized).not.toContain(prepared.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN);
    expect(serialized).not.toContain('openkit-worker-inference');
    expect(JSON.stringify(model)).not.toContain('GPT-6-Astra');
    expect(firstPlan.argv[firstPlan.argv.indexOf('--model') + 1]).toBe('gpt-5');

    writeFileSync(
      firstPlan.argv[firstPlan.argv.indexOf('--output-last-message') + 1] as string,
      'First answer.',
      'utf8'
    );
    await collectTestTurn(prepared, firstPlan, nativeResult());
    const resumedPlan = await codexAdapter.prepareTurn({
      ...prepared,
      nativeTurnDirectory: join(input.sessionDirectory, 'turns', 'next-turn'),
    });
    const resumedCatalog = readBoundCatalog(resumedPlan.argv);

    expect(resumedPlan.argv).toContain('resume');
    expect(resumedPlan.argv.at(-2)).toBe(TEST_THREAD_ID);
    expect(resumedCatalog.path).not.toBe(firstCatalog.path);
    expect(resumedCatalog.catalog).toEqual(firstCatalog.catalog);
  });

  it('projects selected MCP servers through fixed authenticated loopback URLs', async () => {
    const input = codexInput();
    const capabilityToken = 'capability-token-value';
    const plan = await codexAdapter.prepareTurn({
      ...input,
      childEnvironment: {
        ...input.childEnvironment,
        OPENKIT_WORKER_CAPABILITY_TOKEN: capabilityToken,
      },
      mcpServerIds: ['echo', 'search-tools'],
    });

    expect(plan.argv).toEqual(
      expect.arrayContaining([
        'mcp_servers.echo.url="http://127.0.0.1:17892/capabilities/mcp/echo"',
        'mcp_servers.echo.bearer_token_env_var="OPENKIT_WORKER_CAPABILITY_TOKEN"',
        'mcp_servers.search-tools.url="http://127.0.0.1:17892/capabilities/mcp/search-tools"',
        'mcp_servers.search-tools.bearer_token_env_var="OPENKIT_WORKER_CAPABILITY_TOKEN"',
      ])
    );
    expect(plan.environment.OPENKIT_WORKER_CAPABILITY_TOKEN).toBe(capabilityToken);
    expect(plan.argv).not.toContain(capabilityToken);
  });

  it('projects Skill trees into CODEX_HOME/skills as discovery links, not as the digested supply root', async () => {
    const input = codexInput();
    const supplyRoot = mkdtempSync(join(tmpdir(), 'openkit-codex-skill-supply-'));
    const targetPath = join(supplyRoot, 'repo-guidelines');
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, 'SKILL.md'), '# Hello\n');
    await codexAdapter.prepareTurn({
      ...input,
      skillTargetPaths: [{ id: 'repo-guidelines', targetPath }],
    });
    const discoveryPath = join(input.stateRoot, 'skills', 'repo-guidelines');
    expect(lstatSync(discoveryPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(discoveryPath, 'SKILL.md'))).toBe(true);

    await expect(codexAdapter.prepareTurn(input)).rejects.toThrow(
      /retained.*Skill|Skill.*conflict/i
    );
    expect(lstatSync(discoveryPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(discoveryPath, 'SKILL.md'))).toBe(true);
  });

  it('rejects retained Codex system Skills as ambient authority without changing their bytes', async () => {
    const input = codexInput();
    const systemSkillPath = join(input.stateRoot, 'skills', '.system', 'runtime-help');
    mkdirSync(systemSkillPath, { recursive: true });
    writeFileSync(join(systemSkillPath, 'SKILL.md'), '# Runtime help\n');

    await expect(codexAdapter.prepareTurn(input)).rejects.toThrow(
      /retained.*Skill|Skill.*conflict/i
    );
    expect(readFileSync(join(systemSkillPath, 'SKILL.md'), 'utf8')).toBe('# Runtime help\n');
  });

  it('rejects direct-provider authority before launch', async () => {
    const input = codexInput();

    await expect(
      codexAdapter.prepareTurn({
        ...input,
        childEnvironment: { OPENAI_API_KEY: 'provider-credential-value' },
        llmRoute: {
          credentialVisibility: 'environment',
          endpoint: {
            kind: 'provider-compatible',
            upstream: { kind: 'direct-provider' },
          },
          id: 'worker-inference',
          model: 'gpt-5',
          providerInstanceId: 'openai',
        },
      })
    ).rejects.toThrow(/Codex direct-provider routes are unsupported/i);
  });

  it.each([
    {
      expected: { assistantText: 'Completed answer.', status: 'completed' },
      name: 'a regular final message',
      setup: (path: string) => writeFileSync(path, '  Completed answer.\n', 'utf8'),
    },
    {
      expected: { assistantText: null, status: 'completed' },
      name: 'an absent final message',
      setup: (_path: string) => undefined,
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'a non-file final path',
      setup: (path: string) => mkdirSync(path, { recursive: true }),
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'an oversized final message',
      setup: (path: string) => writeFileSync(path, Buffer.alloc(NATIVE_OUTPUT_MAX_BYTES + 1)),
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'an invalid UTF-8 final message',
      setup: (path: string) => writeFileSync(path, Buffer.from([0xff, 0x0a])),
    },
    {
      expected: { assistantText: null, status: 'failed' },
      name: 'a symlink final path',
      setup: (path: string) => {
        writeFileSync(`${path}.target`, 'must not be followed', 'utf8');
        symlinkSync(`${path}.target`, path);
      },
    },
    {
      expected: { assistantText: null, status: 'failed' },
      exitCode: 7,
      name: 'a non-zero process with a final message',
      setup: (path: string) => writeFileSync(path, 'must not be accepted', 'utf8'),
    },
  ])('collects $name fail closed', async ({ exitCode = 0, expected, setup }) => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const launchPlan = await codexAdapter.prepareTurn(input);
    const finalMessageIndex = launchPlan.argv.indexOf('--output-last-message') + 1;
    const finalMessagePath = launchPlan.argv[finalMessageIndex];

    expect(finalMessagePath).toBeTruthy();
    setup(finalMessagePath as string);

    await expect(collectTestTurn(input, launchPlan, nativeResult(exitCode))).resolves.toMatchObject(
      expected
    );
  });

  it('removes a stale final message before preparing a reused session', async () => {
    const original = codexInput();
    const input = { ...original, llmRoute: { ...original.llmRoute, model: 'gpt-6-astra' } };
    mkdirSync(input.sessionDirectory, { recursive: true });
    const firstPlan = await codexAdapter.prepareTurn(input);
    const finalPath = firstPlan.argv[firstPlan.argv.indexOf('--output-last-message') + 1];

    expect(finalPath).toBeTruthy();
    writeFileSync(finalPath as string, 'stale assistant message', 'utf8');

    const launchPlan = await codexAdapter.prepareTurn(input);
    await expect(collectTestTurn(input, launchPlan, nativeResult())).resolves.toMatchObject({
      assistantText: null,
      status: 'completed',
    });
  });

  it.each([
    { name: 'another regular file', replacement: 'replacement text' },
    { name: 'an oversized file', replacement: Buffer.alloc(NATIVE_OUTPUT_MAX_BYTES + 1) },
  ])('reads the opened final message when its path becomes $name', async ({ replacement }) => {
    const input = codexInput();
    mkdirSync(input.sessionDirectory, { recursive: true });
    const launchPlan = await codexAdapter.prepareTurn(input);
    const finalPath = launchPlan.argv[launchPlan.argv.indexOf('--output-last-message') + 1];
    const openedPath = `${finalPath}.opened`;
    const replacementPath = `${finalPath}.replacement`;

    expect(finalPath).toBeTruthy();
    writeFileSync(finalPath as string, 'trusted final message', 'utf8');
    writeFileSync(replacementPath, replacement);
    finalMessageRace.path = finalPath as string;
    finalMessageRace.replace = () => {
      renameSync(finalPath as string, openedPath);
      renameSync(replacementPath, finalPath as string);
    };

    await expect(collectTestTurn(input, launchPlan, nativeResult())).resolves.toMatchObject({
      assistantText: 'trusted final message',
      status: 'completed',
    });
  });

  it('redacts exact relay credentials and common secret shapes from failure diagnostics', async () => {
    const input = codexInput();
    const launchPlan = await codexAdapter.prepareTurn(input);
    const relayToken = input.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN as string;
    const apiKey = 'sk-secret-diagnostic-value';
    const result = await collectTestTurn(input, launchPlan, {
      ...nativeResult(7),
      stderr: `Authorization: Bearer ${relayToken} api_key=${apiKey}`,
      stdout: Buffer.from(`native output ${relayToken}`),
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(relayToken);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain('[redacted]');
  });
});
