// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerAdapterResult } from './adapter-registry.js';
import { deepseekResidentAdapter } from './adapters/deepseek.js';
import type { SandboxIntegrationClient } from './integration-client.js';
import { runResidentTurn } from './turn.js';

const CAUSE_CANARIES = [
  'sk-reviewerSyntheticToken123',
  '/private/customer/project/payroll.txt',
  'CONFIDENTIAL_PROMPT_CANARY',
];

describe('normalized Turn failure cause', () => {
  it.each([
    {
      nativeError: {
        code: -32603,
        message: `Internal error: no content ${CAUSE_CANARIES.join(' ')} ${'界'.repeat(20_000)}`,
      },
      diagnostics: undefined,
      stopReason: 'prompt_failed',
      expected: 'DeepSeek prompt failed with ACP error -32603.',
    },
    {
      nativeError: {
        code: -32603,
        message: `Internal error: turn failed: model "${CAUSE_CANARIES.join(' ')} ${'界'.repeat(20_000)}" returned a completed response with no content`,
      },
      diagnostics: undefined,
      stopReason: 'prompt_failed',
      expected: 'DeepSeek model returned a completed response with no content.',
    },
    {
      diagnostics: {
        failureCause:
          'Native prompt failed: no content secret-value Authorization: Bearer unknown-secret',
      },
      stopReason: 'prompt_failed',
      expected: 'Native prompt failed: no content [redacted] Authorization: Bearer [redacted]',
    },
    { diagnostics: undefined, stopReason: 'output_limit', expected: 'output_limit' },
    {
      diagnostics: { failureCause: '   ' },
      stopReason: 'missing_terminal_outcome',
      expected: 'missing_terminal_outcome',
    },
  ])('carries a sanitized cause with normalized $stopReason fallback into both terminal records', async (testCase) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-turn-cause-'));
    const packagePath = join(root, 'package.json');
    const lineage = {
      workspaceId: 'ws-cause',
      threadId: 'th-cause',
      turnId: 'turn-cause',
      agentSessionId: 'as-cause',
      packageSnapshotId: 'package-cause',
    };
    writeFileSync(
      packagePath,
      JSON.stringify({
        control: {
          adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture' },
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
        capabilities: {
          mode: 'enabled',
          protocol: 'openkit-worker-capability-v1',
          routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
        },
        extensions: {
          openkit: {
            turnInput: 'fail',
            sessionWorkspace: {
              layout: { slots: [{ kind: 'worktree', access: 'read-write', path: root }] },
            },
          },
        },
        llm: {
          mode: 'gateway',
          preferredLogicalModelId: 'model',
          routes: [
            {
              credentialVisibility: 'placeholder',
              endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
              id: 'route',
              model: 'model',
              providerInstanceId: 'provider',
            },
          ],
        },
        observability: { captureCoverage: { scope: 'server', value: 'off' } },
        runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: root } },
        scope: lineage,
        snapshotId: lineage.packageSnapshotId,
        workspace: { root, inputs: [] },
        supply: { mcpServers: [{ id: 'echo' }] },
      })
    );
    const finalStatuses: Array<{ body: { diagnostics: Record<string, string> } }> = [];
    const integration = {
      ready: Promise.resolve(),
      bindTurnRouteTokens() {},
      clearTurnRouteTokens() {},
      async drainTurn() {
        return 0;
      },
      workerControlFetch: async (url: string, init: { body: string }) => {
        if (url.endsWith('/final-status')) finalStatuses.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
        };
      },
    } as unknown as SandboxIntegrationClient;
    const diagnostics = testCase.diagnostics;
    let result: WorkerAdapterResult = {
      assistantText: null,
      status: 'failed',
      stopReason: testCase.stopReason,
      ...(diagnostics ? { diagnostics } : {}),
    };
    try {
      if ('nativeError' in testCase) {
        const stateRoot = join(root, 'native');
        // Reuse an isolated native home; the boundary probe launches no process.
        mkdirSync(join(stateRoot, 'dsh-home'), { recursive: true });
        const native = (await deepseekResidentAdapter.openSession({
          agentSessionId: lineage.agentSessionId,
          controlRoot: join(root, 'control'),
          stateRoot,
          environment: {},
          loopback: {
            inferenceBaseUrl: 'http://127.0.0.1:9',
            inferenceCredential: 'inference-value',
            capabilityBaseUrl: 'http://127.0.0.1:9',
            capabilityCredential: 'capability-value',
          },
          resumeReference: null,
        })) as unknown as {
          promptRequestId: number;
          classifyNativeLine(line: string): string | null;
          close(): Promise<void>;
          beginTurn(): {
            promptFailed: boolean;
            settled: Promise<WorkerAdapterResult>;
            finish(stopReason: undefined, promptFailed: boolean): void;
          };
        };
        try {
          const active = native.beginTurn();
          native.promptRequestId = 7;
          native.classifyNativeLine(
            JSON.stringify({ jsonrpc: '2.0', id: 7, error: testCase.nativeError })
          );
          active.finish(undefined, active.promptFailed);
          result = await active.settled;
        } finally {
          await native.close();
        }
      }
      await expect(
        runResidentTurn({
          adapterId: 'fixture',
          credentialValues: ['secret-value'],
          environment: {},
          integration,
          lineage,
          onStarted() {},
          packagePath,
          resident: {
            exited: new Promise(() => undefined),
            childState: () => 'running',
            close: async () => undefined,
            nativeHandle: async () => ({ state: 'pending' }),
            startTurn: async () => ({
              interrupt: async () => undefined,
              settled: Promise.resolve(result),
            }),
          },
          runtimeEnvironmentNames: new Set(),
          nativeEnvironment: null,
          sessionDir: join(root, 'output'),
          signal: new AbortController().signal,
          tokens: {
            controlToken: 'control-value',
            inferenceToken: 'inference-value',
            capabilityToken: 'capability-value',
          },
          turnDirectory: join(root, 'turn'),
        })
      ).resolves.toEqual({ status: 'failed' });
      expect(finalStatuses).toHaveLength(1);
      for (const canary of CAUSE_CANARIES) {
        expect(JSON.stringify(finalStatuses)).not.toContain(canary);
      }
      expect(finalStatuses[0]?.body.diagnostics?.failureCause).toBe(testCase.expected);
      const records = readFileSync(join(root, 'output', 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        records.find((record) => record.event.type === 'turn.failed').event.data.diagnostics
          .failureCause
      ).toBe(testCase.expected);
      expect(JSON.stringify(finalStatuses)).not.toContain('secret-value');
      expect(JSON.stringify(finalStatuses)).not.toContain('unknown-secret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
