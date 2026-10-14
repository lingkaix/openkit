import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerTurnCapturePaths } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerResidentTurnInput } from './adapter-registry.js';
import type { SandboxIntegrationClient } from './integration-client.js';
import { runResidentTurn } from './turn.js';

const lineage = {
  agentSessionId: 'as_provenance',
  packageSnapshotId: 'pkg_provenance',
  threadId: 'th_task_sha256:0123',
  turnId: 'tu_task_sha256:4567',
  workspaceId: 'ws_provenance',
};

/** Supplies the exact Core projection without launching a native process. */
function declaration(threadId = lineage.threadId, adapterId = 'codex', turnId = lineage.turnId) {
  const paths = workerTurnCapturePaths(threadId, adapterId, turnId);
  return {
    rawStreamsRoot: paths.rawStreamsRoot,
    streamManifestPath: paths.streamManifestPath,
    nativeOriginIndexPath: paths.nativeOriginIndexPath,
    maxStreamCount: 64,
    maxTotalBytes: 256 * 1024 * 1024,
  };
}

/** Runs the real pre-launch parser and terminal publisher against an inert resident. */
function fixture(provenance: unknown, adapterId = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'worker-turn-provenance-'));
  const packagePath = join(root, 'package.json');
  writeFileSync(
    packagePath,
    JSON.stringify({
      control: {
        adapter: { kind: 'openkit-worker-shim', targetRuntime: adapterId },
        mode: 'sandbox-integration',
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
        transcript: { runtimeProvenance: provenance },
      },
      llm: {
        mode: 'gateway',
        preferredLogicalModelId: 'model',
        routes: [
          {
            id: 'route',
            model: 'model',
            providerInstanceId: 'provider',
            credentialVisibility: 'placeholder',
            endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
          },
        ],
      },
      observability: { captureCoverage: { scope: 'server', value: 'off' } },
      runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: root } },
      extensions: { openkit: { turnInput: 'Inspect the admitted capture.' } },
      scope: { ...lineage, requestId: 'request_provenance' },
    })
  );
  const startTurn = vi.fn(async (_input: WorkerResidentTurnInput) => ({
    interrupt: async () => undefined,
    settled: Promise.resolve({
      assistantText: null,
      status: 'completed' as const,
      stopReason: 'completed',
    }),
  }));
  const sessionDir = join(root, 'capture');
  return {
    root,
    sessionDir,
    startTurn,
    run: () =>
      runResidentTurn({
        adapterId,
        lineage,
        packagePath,
        sessionDir,
        turnDirectory: join(root, 'turn'),
        credentialValues: [],
        environment: {},
        nativeEnvironment: null,
        runtimeEnvironmentNames: new Set(),
        signal: new AbortController().signal,
        tokens: {
          capabilityToken: 'capability-value',
          controlToken: 'control-value',
          inferenceToken: 'inference-value',
        },
        onStarted() {},
        onTurnBarrier() {},
        integration: {
          ready: Promise.resolve(),
          bindTurnRouteTokens() {},
          clearTurnRouteTokens() {},
          async drainTurn() {
            return 0;
          },
        } as unknown as SandboxIntegrationClient,
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
        }),
        resident: {
          startTurn,
          exited: new Promise<void>(() => undefined),
          childState: () => 'running',
          close: async () => undefined,
          nativeHandle: async () => ({ state: 'pending' }),
        },
      }),
  };
}

describe('admitted Turn provenance capture', () => {
  it.each([
    'codex',
    'pi',
    'opencode',
    'deepseek',
  ])('passes only the exact %s capture projection to the resident', async (adapterId) => {
    const expected = declaration(lineage.threadId, adapterId);
    const f = fixture(expected, adapterId);
    try {
      await expect(f.run()).resolves.toEqual({ status: 'completed' });
      expect(f.startTurn).toHaveBeenCalledTimes(1);
      expect(f.startTurn.mock.calls[0]?.[0].runtimeProvenance).toEqual({
        ...expected,
        lineage: { ...lineage, requestId: 'request_provenance' },
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'retired root',
      value: {
        ...declaration(),
        rawStreamsRoot: '/openkit/session/runtime/raw',
        streamManifestPath: '/openkit/session/runtime/raw-streams.json',
        nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
      },
    },
    { name: 'sibling Thread', value: declaration('th_other') },
    { name: 'other runtime', value: declaration(lineage.threadId, 'pi') },
    { name: 'sibling Turn', value: declaration(lineage.threadId, 'codex', 'tu_other') },
    {
      name: 'mixed origin index',
      value: {
        ...declaration(),
        nativeOriginIndexPath: declaration('th_other').nativeOriginIndexPath,
      },
    },
    {
      name: 'native directory',
      value: {
        ...declaration(),
        rawStreamsRoot: `/openkit/threads/${lineage.threadId}/codex/native`,
      },
    },
    { name: 'zero byte bound', value: { ...declaration(), maxTotalBytes: 0 } },
  ])('refuses $name before capture creation or native work', async ({ value }) => {
    const f = fixture(value);
    try {
      await expect(f.run()).rejects.toThrow('Invalid runtime provenance declaration.');
      expect(f.startTurn).not.toHaveBeenCalled();
      expect(existsSync(f.sessionDir)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
