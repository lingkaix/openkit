// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkerResidentAdapter, WorkerResidentSession } from '../adapter-registry.js';
import { WorkerHarness } from '../harness.js';
import type { SandboxIntegrationClient } from '../integration-client.js';
import {
  failDeepSeekAdmission,
  withholdDeepSeekResumeAcknowledgement,
} from '../test-support/deepseek-admission.js';
import { startSyntheticInference } from '../test-support/inference.js';
import { deepseekResidentAdapter } from './deepseek.js';

// Defaults are image supply; test runs never import the developer's native home.
let imageHome: string;
beforeEach(() => {
  imageHome = mkdtempSync(join(tmpdir(), 'deepseek-test-image-'));
  vi.stubEnv('HOME', imageHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(imageHome, { force: true, recursive: true });
});

/** Tests the actual Harness and adapter; only external Integration endpoints are synthetic. */
it.each([
  {
    kind: 'resume-timeout',
    name: 'fences a missing real resume acknowledgement through the real Harness',
  },
  {
    kind: 'removed-model',
    name: 'closes a proved removed-model refusal through the real Harness and admits a recovered successor',
  },
  {
    kind: 'channel-loss',
    name: 'fences admission channel loss through the real Harness after proved stop',
  },
  {
    kind: 'close-flush',
    name: 'fences initialization close/flush failure through the real Harness after proved stop',
  },
] as const)('$name', async ({ kind }) => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-real-harness-'));
  const sandboxRoot = join(root, 'openkit');
  const nativeRoot = join(root, 'native');
  const residents: WorkerResidentSession[] = [];
  const accepted: string[] = [];
  const statuses: unknown[] = [];
  const inference = await startSyntheticInference(() => ({ text: 'fresh' }));
  // Route the actual native host to the synthetic provider without replacing ACP or native work.
  const adapter: WorkerResidentAdapter = {
    async openSession(input) {
      expect(readdirSync(join(sandboxRoot, 'worktrees', input.agentSessionId))).toEqual([]);
      const resident = await deepseekResidentAdapter.openSession({
        ...input,
        loopback: { ...input.loopback, inferenceBaseUrl: inference.url },
      });
      residents.push(resident);
      const start = resident.startTurn.bind(resident);
      resident.startTurn = async (input) => {
        const turn = await start(input);
        accepted.push(input.turnId);
        return turn;
      };
      return resident;
    },
  };
  const integration = {
    ready: Promise.resolve(),
    registerSessionLoopback: () => undefined,
    destroySessionLoopback: () => undefined,
    bindTurnRouteTokens: () => undefined,
    clearTurnRouteTokens: () => undefined,
    drainTurn: async () => 0,
    workerControlFetch: async (url: string, init: { body: string }) => {
      if (url.endsWith('/final-status')) statuses.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
      };
    },
  } as unknown as SandboxIntegrationClient;
  const harness = new WorkerHarness({
    adapters: { deepseek: adapter },
    environment: { PATH: process.env.PATH! },
    integration,
    nativeDataRootDirectory: nativeRoot,
    rootDirectory: join(root, 'private'),
    sandboxRoot,
    turnOutputDirectory: join(sandboxRoot, 'session'),
  });
  let sequence = 0;
  const send = (operation: string, body: Record<string, unknown>) =>
    harness.handle({
      body,
      harnessInstanceId: 'deepseek-harness',
      operation: operation as never,
      operationId: hash(String(sequence)),
      schemaVersion: 2,
      sequence: sequence++,
    });
  const selector = (id: string) => ({
    agentSessionId: id,
    agentSessionRuntimeBindingId: `binding-${id}`,
  });
  const open = (id: string, resume: { locator: string; digest: string } | null) => {
    // Core imports the admitted initial AEP before open; Harness initializes its work slot before native admission.
    const config = join(sandboxRoot, 'sessions', id, 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'package.json'),
      JSON.stringify({
        scope: { agentSessionId: id, threadId: 'thread-one', workspaceId: 'workspace-one' },
        workspace: { root: sandboxRoot, inputs: [] },
        extensions: {
          openkit: {
            sessionWorkspace: {
              layout: {
                slots: [
                  {
                    kind: 'worktree',
                    access: 'read-write',
                    path: join(sandboxRoot, 'worktrees', id),
                  },
                ],
              },
            },
          },
        },
      })
    );
    return send('session.open', {
      ...selector(id),
      adapterId: 'deepseek',
      agentSessionCompatibilityKey: hash('setup'),
      capabilityLoopbackCredential: credential(`cap-${id}`),
      inferenceLoopbackCredential: credential(`inf-${id}`),
      effectiveSetupGeneration: 1,
      resume,
      threadId: 'thread-one',
      workspaceId: 'workspace-one',
    });
  };
  const start = (id: string, turnId: string, models: string[], preferred: string, text: string) => {
    const inputRoot = join(sandboxRoot, 'sessions', id);
    const config = join(inputRoot, 'config');
    mkdirSync(config, { recursive: true });
    mkdirSync(join(inputRoot, 'context'), { recursive: true });
    const packagePath = join(config, 'package.json');
    writeFileSync(
      packagePath,
      JSON.stringify({
        capabilities:
          kind === 'close-flush' && id === 'as-refused'
            ? {
                mode: 'enabled',
                protocol: 'openkit-worker-capability-v1',
                routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
              }
            : { mode: 'disabled', routes: [] },
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'deepseek' },
          bindings: {
            capabilities: {
              pathPrefix: '/capabilities/',
              tokenRef: 'runtime://openkit/capability-token',
            },
            inference: { pathPrefix: '/inference/', tokenRef: 'runtime://openkit/inference-token' },
            workerControl: {
              pathPrefix: '/worker-control/',
              tokenRef: 'runtime://openkit/worker-control-token',
            },
          },
          mode: 'sandbox-integration',
        },
        credentials: { declarations: [] },
        extensions: { openkit: { turnInput: text } },
        llm: {
          mode: 'gateway',
          preferredLogicalModelId: preferred,
          routes: models.map((model) => ({
            credentialVisibility: 'placeholder',
            endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
            id: `route-${model}`,
            model,
            providerInstanceId: 'provider',
          })),
        },
        observability: { captureCoverage: { scope: 'server', value: 'off' } },
        runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: sandboxRoot } },
        scope: { agentSessionId: id, threadId: 'thread-one', turnId, workspaceId: 'workspace-one' },
        snapshotId: `package-${turnId}`,
        supply: {
          mcpServers: kind === 'close-flush' && id === 'as-refused' ? [{ id: 'alpha' }] : [],
        },
      })
    );
    return send('turn.start', {
      ...selector(id),
      aepRef: packagePath,
      capabilityToken: credential(`cap-turn-${turnId}`),
      contextPackageId: `ctxpkg_${turnId}`,
      contextRef: join(inputRoot, 'context'),
      deadline: '2099-01-01T00:00:00.000Z',
      inferenceToken: credential(`inf-turn-${turnId}`),
      leaseId: `lease-${turnId}`,
      packageSnapshotId: `package-${turnId}`,
      threadId: 'thread-one',
      turnId,
      turnSequence: 0,
      workerControlToken: credential(`control-${turnId}`),
      workspaceId: 'workspace-one',
    });
  };
  const settled = (id: string) =>
    vi.waitFor(
      async () => {
        const result = await send('session.inspect', selector(id));
        expect(result.body).toMatchObject({ cleanupState: 'clean', state: 'open' });
      },
      { timeout: 20_000, interval: 10 }
    );
  try {
    expect(await open('as-first', null)).toMatchObject({ disposition: 'succeeded' });
    const seed = await start('as-first', 'seed-b', ['a', 'b'], 'b', 'STARTUP-B');
    expect(seed, JSON.stringify(seed.body)).toMatchObject({ disposition: 'succeeded' });
    await settled('as-first');
    expect(await start('as-first', 'seed-a', ['a', 'b'], 'a', 'HARNESS-RETAINED-A')).toMatchObject({
      disposition: 'succeeded',
    });
    await settled('as-first');
    const reference = readFileSync(join(nativeRoot, 'agent-session-references', 'as-first'));
    const resume = { locator: 'as-first', digest: hash(reference) };
    expect(await send('session.close', selector('as-first'))).toMatchObject({
      disposition: 'succeeded',
      body: { state: 'closed' },
    });
    expect(await open('as-refused', resume)).toMatchObject({
      disposition: 'succeeded',
      body: { nativeHandleState: 'ready', nativeHandleDigest: resume.digest },
    });
    const calls =
      kind === 'removed-model'
        ? null
        : kind === 'resume-timeout'
          ? withholdDeepSeekResumeAcknowledgement(residents[1]!)
          : failDeepSeekAdmission(residents[1]!, kind);
    const count = inference.requests.length;
    expect(
      await start(
        'as-refused',
        'removed-model',
        kind === 'removed-model' ? ['b'] : kind === 'resume-timeout' ? ['a', 'b', 'c'] : ['a', 'b'],
        'b',
        'must-not-prompt'
      )
    ).toMatchObject({ disposition: 'refused', body: { reasonCode: 'dependency_failed' } });
    await settled('as-refused');
    if (calls)
      expect(calls).toEqual([
        kind === 'resume-timeout'
          ? 'resumeAcknowledgement'
          : kind === 'channel-loss'
            ? 'setSessionConfigOption'
            : 'closeSession',
      ]);
    expect(inference.requests).toHaveLength(count);
    expect(accepted).toEqual(['seed-b', 'seed-a']);
    expect(await send('session.inspect', selector('as-refused'))).toMatchObject({
      disposition: 'succeeded',
      body: {
        state: 'open',
        childState: 'absent',
        nativeHandleState: 'unknown',
        nativeHandleDigest: null,
        cleanupState: 'clean',
      },
    });
    expect((harness as unknown as { activeTurnCount(): number }).activeTurnCount()).toBe(0);
    const refusedClose = await send('session.close', selector('as-refused'));
    const afterRefusedClose =
      refusedClose.disposition === 'refused'
        ? (await send('session.inspect', selector('as-refused'))).body
        : null;
    if (kind !== 'removed-model') {
      expect(refusedClose, JSON.stringify(refusedClose)).toMatchObject({
        disposition: 'refused',
        body: { reasonCode: 'cleanup_required' },
      });
      expect(afterRefusedClose).toMatchObject({
        state: 'failed',
        cleanupState: 'unknown',
        childState: 'absent',
        nativeHandleState: 'unknown',
        nativeHandleDigest: null,
      });
      expect((harness as unknown as { activeTurnCount(): number }).activeTurnCount()).toBe(0);
      expect(await send('session.close', selector('as-refused'))).toMatchObject({
        disposition: 'refused',
        body: { reasonCode: 'cleanup_required' },
      });
      expect(await open('as-fenced-successor', resume)).toMatchObject({ disposition: 'refused' });
      expect(readFileSync(join(nativeRoot, 'agent-session-references', 'as-refused'))).toEqual(
        reference
      );
      return;
    }
    expect(
      refusedClose,
      JSON.stringify({
        close: refusedClose.body,
        afterRefusedClose,
        activeTurns: (harness as unknown as { activeTurnCount(): number }).activeTurnCount(),
      })
    ).toMatchObject({
      disposition: 'succeeded',
      body: { state: 'closed', childState: 'absent', privateState: 'absent' },
    });
    // Even the refused successor's accepted idle proof keeps its exact resume reference.
    expect(readFileSync(join(nativeRoot, 'agent-session-references', 'as-refused'))).toEqual(
      reference
    );
    const failedResume = { locator: 'as-refused', digest: resume.digest };
    expect(await open('as-recovered', failedResume)).toMatchObject({
      disposition: 'succeeded',
      body: { nativeHandleState: 'ready', nativeHandleDigest: resume.digest },
    });
    expect(await start('as-recovered', 'recovered', ['a', 'b'], 'a', 'recover')).toMatchObject({
      disposition: 'succeeded',
    });
    await settled('as-recovered');
    expect(JSON.stringify(inference.requests.at(-1)?.body.messages)).toContain(
      'HARNESS-RETAINED-A'
    );
    expect(inference.requests.at(-1)?.body.model).toBe('a');
    expect(readFileSync(join(nativeRoot, 'agent-session-references', 'as-recovered'))).toEqual(
      reference
    );
    expect(await send('session.close', selector('as-recovered'))).toMatchObject({
      disposition: 'succeeded',
    });
    expect(await send('harness.drain', {})).toMatchObject({
      disposition: 'succeeded',
      body: { activeTurns: 0, openSessions: 0 },
    });
    expect(statuses).toHaveLength(4);
  } finally {
    await Promise.all(residents.map((resident) => resident.close().catch(() => undefined)));
    await inference.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

/** Fixed private credentials and identities used by this loopback-only regression. */
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Produces a valid loopback credential distinct for each session and Turn. */
function credential(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
