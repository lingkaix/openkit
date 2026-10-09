// openkit-test-platform: posix
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PiTurnOutcomeTracker } from '../../pi-runtime-host/src/outcome.ts';
import type {
  WorkerAdapterResult,
  WorkerResidentSession,
  WorkerResidentTurnInput,
} from './adapter-registry.js';
import { normalizeCodexAssistant, openCodexResidentSession } from './adapters/codex.js';
import { classifyDeepSeekStop, deepseekResidentAdapter } from './adapters/deepseek.js';
import { createOpenCodeAdapter, OPENCODE_PROVIDER_ID } from './adapters/opencode.js';
import { projectPiTurnSettlement } from './adapters/pi.js';
import type { SandboxIntegrationClient } from './integration-client.js';
import { runResidentTurn } from './turn.js';

const CAUSE_CANARIES = [
  'sk-reviewerSyntheticToken123',
  '/private/customer/project/payroll.txt',
  'CONFIDENTIAL_PROMPT_CANARY',
];

describe('normalized Turn failure cause', () => {
  it.each([
    ...['codex', 'opencode', 'deepseek', 'pi'].flatMap((adapter) =>
      ['none', 'before', 'during', 'after', 'later'].map((requestTiming) => ({
        adapter,
        diagnostics: undefined,
        stopReason: 'interrupted',
        nativeStatus: 'interrupted' as const,
        requestTiming,
        requested: requestTiming === 'before' || requestTiming === 'later',
        expected:
          requestTiming === 'before' || requestTiming === 'later'
            ? undefined
            : 'Worker runtime stopped on its own without an OpenKit interrupt request.',
      }))
    ),
    ...['codex', 'opencode', 'deepseek'].map((adapter) => ({
      adapter,
      requestTiming: 'capture',
      requested: false,
      diagnostics: undefined,
      stopReason: 'interrupted',
      nativeStatus: 'interrupted' as const,
      expected: 'Worker runtime stopped on its own without an OpenKit interrupt request.',
    })),
    {
      adapter: 'opencode',
      requestTiming: 'collection',
      requested: false,
      diagnostics: undefined,
      stopReason: 'interrupted',
      nativeStatus: 'interrupted' as const,
      expected: 'Worker runtime stopped on its own without an OpenKit interrupt request.',
    },
    {
      adapter: 'pi-requested',
      diagnostics: undefined,
      stopReason: 'worker-interrupted',
      nativeStatus: 'interrupted' as const,
      requested: true,
      expected: undefined,
    },
    {
      adapter: 'pi-self-abort-late',
      diagnostics: undefined,
      stopReason: 'aborted',
      nativeStatus: 'failed' as const,
      expected: 'Worker runtime stopped on its own without an OpenKit interrupt request.',
    },
    {
      adapter: 'pi-self-abort',
      diagnostics: undefined,
      stopReason: 'aborted',
      nativeStatus: 'failed' as const,
      expected: 'Worker runtime stopped on its own without an OpenKit interrupt request.',
    },
    {
      diagnostics: undefined,
      stopReason: 'interrupted',
      nativeStatus: 'interrupted' as const,
      requested: true,
      expected: undefined,
    },
    {
      diagnostics: undefined,
      stopReason: 'length',
      nativeStatus: 'length' as const,
      expected: undefined,
    },
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
  ])('carries a sanitized cause with normalized $stopReason fallback into both terminal records ($adapter $requestTiming)', async (testCase) => {
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
        if ('requestTiming' in testCase && testCase.requestTiming === 'during')
          cancellation.abort();
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
    const cancellation = new AbortController();
    let settleNative!: (result: WorkerAdapterResult) => void;
    const requested = 'requested' in testCase && testCase.requested;
    const nativeStatus = 'nativeStatus' in testCase ? testCase.nativeStatus : 'failed';
    const expectedStatus =
      nativeStatus === 'length' ? 'blocked' : requested ? 'interrupted' : 'failed';
    const diagnostics = testCase.diagnostics;
    let result: WorkerAdapterResult = {
      assistantText: null,
      status: nativeStatus,
      interruptRequested: Boolean(requested),
      stopReason: testCase.stopReason,
      ...(diagnostics ? { diagnostics } : {}),
    };
    if ('adapter' in testCase && testCase.adapter === 'codex')
      result = normalizeCodexAssistant('interrupted', ['partial'], Boolean(requested));
    if ('adapter' in testCase && testCase.adapter === 'deepseek')
      result = classifyDeepSeekStop({
        badContent: false,
        cancelRequested: Boolean(requested),
        hostEnded: false,
        overLimit: false,
        promptFailed: false,
        stopReason: 'cancelled',
        text: 'partial',
      });
    if (
      'adapter' in testCase &&
      ['pi-self-abort', 'pi-self-abort-late', 'pi-requested'].includes(testCase.adapter)
    ) {
      // Feed actual host correlation and shim projection into the shared terminal publisher.
      const tracker = new PiTurnOutcomeTracker();
      const message = {
        role: 'assistant',
        provider: 'openkit-worker-inference',
        model: 'model',
        stopReason: 'aborted',
        content: [{ type: 'text', text: 'partial' }],
      };
      tracker.observe({ type: 'message_end', message });
      tracker.observe({ type: 'turn_end', message });
      tracker.observe({ type: 'agent_end', messages: [message], willRetry: false });
      tracker.observe({ type: 'agent_settled' });
      result = projectPiTurnSettlement(
        {
          turnId: lineage.turnId,
          compactionEntryIds: [],
          nativeHandle: { state: 'pending' },
          outcome: tracker.finish({
            interrupted: Boolean(requested),
            promptFailed: false,
            route: { provider: message.provider, model: message.model },
          }),
        },
        { expectedHandleText: null, secrets: [] }
      );
    }
    let native: WorkerResidentSession | undefined;
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
      const turnOptions = {
        adapterId: 'fixture',
        credentialValues: ['secret-value'],
        environment: {},
        integration,
        lineage,
        onStarted() {
          if (requested || ('adapter' in testCase && testCase.adapter === 'pi-self-abort-late'))
            cancellation.abort();
          settleNative(result);
        },
        onTurnBarrier() {
          if ('requestTiming' in testCase && testCase.requestTiming === 'after')
            cancellation.abort();
        },
        packagePath,
        resident: {
          exited: new Promise<void>(() => undefined),
          childState: () => 'running',
          close: async () => undefined,
          nativeHandle: async () => ({ state: 'pending' }),
          startTurn: async () => ({
            interrupt: async () => undefined,
            settled: new Promise<WorkerAdapterResult>((resolve) => {
              settleNative = resolve;
            }),
          }),
        },
        runtimeEnvironmentNames: new Set(),
        nativeEnvironment: null,
        sessionDir: join(root, 'output'),
        signal: cancellation.signal,
        tokens: {
          controlToken: 'control-value',
          inferenceToken: 'inference-value',
          capabilityToken: 'capability-value',
        },
        turnDirectory: join(root, 'turn'),
      } satisfies Parameters<typeof runResidentTurn>[0];
      let captureRequests = 0;
      let interruptDeliveries = 0;
      if (
        'requestTiming' in testCase &&
        ['capture', 'collection'].includes(testCase.requestTiming)
      ) {
        const opened = await captureBoundaryResident(
          testCase.adapter,
          root,
          lineage.agentSessionId,
          testCase.requestTiming
        );
        native = opened.session;
        turnOptions.resident = {
          ...turnOptions.resident,
          startTurn: async (input: WorkerResidentTurnInput) => {
            const active = await opened.session.startTurn({
              ...input,
              mcpServerIds: [],
              runtimeCapture: {
                ...input.runtimeCapture,
                emit: async (record, body) => {
                  if (opened.isFinalCapture(record.fact)) {
                    captureRequests += 1;
                    cancellation.abort();
                  }
                  await input.runtimeCapture.emit(record, body);
                },
              },
            });
            return {
              settled: active.settled,
              interrupt: async () => {
                interruptDeliveries += 1;
                await active.interrupt();
              },
            };
          },
        };
        turnOptions.onStarted = opened.finish;
      }
      await expect(runResidentTurn(turnOptions)).resolves.toEqual({
        status: expectedStatus,
        ...('nativeError' in testCase ? { nativeEvidence: { nativeTerminal: true } } : {}),
        ...('requestTiming' in testCase &&
        ['capture', 'collection'].includes(testCase.requestTiming)
          ? { nativeEvidence: testCase.adapter === 'deepseek' ? {} : { nativeTerminal: true } }
          : {}),
      });
      if (
        'requestTiming' in testCase &&
        ['capture', 'collection'].includes(testCase.requestTiming)
      ) {
        expect(captureRequests).toBeGreaterThan(0);
        expect(interruptDeliveries).toBe(1);
      }
      expect(finalStatuses).toHaveLength(1);
      expect(finalStatuses[0]?.body).toMatchObject({
        status: expectedStatus,
        stopReason: nativeStatus === 'length' ? 'length' : requested ? 'aborted' : 'error',
      });
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
          ?.failureCause
      ).toBe(testCase.expected);
      expect(JSON.stringify(finalStatuses)).not.toContain('secret-value');
      expect(JSON.stringify(finalStatuses)).not.toContain('unknown-secret');
      if ('requestTiming' in testCase && testCase.requestTiming === 'later') {
        const nextSignal = new AbortController();
        await expect(
          runResidentTurn({
            ...turnOptions,
            lineage: { ...lineage, turnId: 'turn-later' },
            signal: nextSignal.signal,
            onStarted() {
              settleNative({ ...result, interruptRequested: false });
            },
            onTurnBarrier() {},
            sessionDir: join(root, 'later-output'),
            turnDirectory: join(root, 'later-turn'),
          })
        ).resolves.toEqual({ status: 'failed' });
        expect(finalStatuses).toHaveLength(2);
        expect(finalStatuses[1]?.body).toMatchObject({
          status: 'failed',
          stopReason: 'error',
          diagnostics: {
            failureCause: 'Worker runtime stopped on its own without an OpenKit interrupt request.',
          },
        });
        expect(nextSignal.signal.aborted).toBe(false);
      }
    } finally {
      await native?.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Real adapter collection paths with typed native peers; no provider or native executable is launched. */
async function captureBoundaryResident(
  adapter: string,
  root: string,
  agentSessionId: string,
  timing: string
) {
  const stateRoot = join(root, 'native');
  mkdirSync(join(stateRoot, 'dsh-home'), { recursive: true });
  const open = {
    agentSessionId,
    stateRoot,
    controlRoot: join(root, 'control'),
    environment: {},
    resumeReference: null,
    loopback: {
      inferenceBaseUrl: 'http://127.0.0.1:9',
      inferenceCredential: 'inference-value',
      capabilityBaseUrl: 'http://127.0.0.1:9',
      capabilityCredential: 'capability-value',
    },
  };
  if (adapter === 'deepseek') {
    const session = await deepseekResidentAdapter.openSession(open);
    const boundary = session as unknown as {
      sessionId: string;
      beginTurn(input: WorkerResidentTurnInput): {
        settled: Promise<WorkerAdapterResult>;
        finish(reason: string, failed: boolean): void;
      };
      interrupt(active: unknown): Promise<void>;
    };
    boundary.sessionId = 'native-session';
    let active: ReturnType<typeof boundary.beginTurn>;
    session.startTurn = async (input) => {
      active = boundary.beginTurn(input);
      return { settled: active.settled, interrupt: () => boundary.interrupt(active) };
    };
    return {
      session,
      finish: () => active.finish('cancelled', false),
      isFinalCapture: (fact: { kind: string; phase?: string; reason?: string }) =>
        fact.kind === 'assistant' && fact.phase === 'interrupted',
    };
  }
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    pid: 424242,
    kill() {
      this.exitCode = 0;
      this.emit('exit', 0, null);
      this.stdout.end();
      this.stderr.end();
      this.emit('close', 0, null);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  if (adapter === 'codex') {
    const threadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        const result =
          request.method === 'config/read'
            ? { config: { mcp_servers: {} } }
            : request.method === 'thread/start'
              ? { thread: { id: threadId } }
              : request.method === 'turn/start'
                ? { turn: { id: 'native-turn', status: 'inProgress', items: [] } }
                : {};
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    const session = await openCodexResidentSession(open, {
      spawnProcess: () => child,
      stopGraceMs: 10,
    });
    return {
      session,
      finish: () => {
        child.stdout.write(
          `${JSON.stringify({
            method: 'turn/completed',
            params: { threadId, turn: { id: 'native-turn', status: 'interrupted', items: [] } },
          })}\n`
        );
      },
      isFinalCapture: (fact: { kind: string; reason?: string }) =>
        fact.kind === 'coverage' && fact.reason === 'source-missing',
    };
  }
  child.stdin.once('finish', () => child.kill());
  let prompted = false;
  let selectedModel = 'model';
  const client = {
    agent: { get: async () => ({ data: { permissions: [] } }) },
    config: { get: async () => [] },
    location: { reload: async () => undefined },
    model: {
      list: async () => ({
        data: [{ id: 'model', providerID: OPENCODE_PROVIDER_ID, enabled: true }],
      }),
    },
    mcp: {
      add: async () => undefined,
      list: async () => ({ data: [] }),
      remove: async () => undefined,
    },
    message: {
      list: async () => ({
        cursor: {},
        data: prompted
          ? [
              { id: 'native-user', type: 'user' },
              ...(timing === 'collection'
                ? [
                    {
                      id: 'native-answer',
                      type: 'assistant',
                      finish: 'error',
                      content: [{ type: 'text', text: 'partial' }],
                    },
                  ]
                : []),
              { id: 'native-idle', type: 'idle', outcome: 'interrupted' },
            ]
          : [],
      }),
    },
    permission: { list: async () => [] },
    session: {
      update: async () => undefined,
      create: async () => ({ id: 'native-session' }),
      form: { list: async () => [] },
      get: async () => ({
        id: 'native-session',
        model: { id: selectedModel, providerID: OPENCODE_PROVIDER_ID },
        time: prompted ? { idle: Number.MAX_SAFE_INTEGER } : {},
        ...(prompted ? { outcome: 'interrupted' } : {}),
      }),
      switchModel: async (input: { model: { id: string } }) => {
        selectedModel = input.model.id;
      },
      interrupt: async () => ({ interrupted: true }),
      move: async () => undefined,
      wait: async () => undefined,
      prompt: async () => {
        prompted = true;
        return { id: 'native-user' };
      },
    },
  };
  const module = { OpenCode: { make: () => client } } as unknown as Awaited<
    ReturnType<NonNullable<Parameters<typeof createOpenCodeAdapter>[0]['loadClient']>>
  >;
  const session = await createOpenCodeAdapter({
    loadClient: async () => module,
    resolveBinary: () => '/unused',
    spawnServer: () => {
      setTimeout(() => child.stdout.write('server listening on http://127.0.0.1:9\n'), 0);
      return child;
    },
    stopTimeoutMs: 10,
  }).openSession(open);
  return {
    session,
    finish() {},
    isFinalCapture: (fact: { kind: string; phase?: string }) =>
      timing === 'collection'
        ? fact.kind === 'assistant' && fact.phase === 'failed'
        : fact.kind === 'origin' && fact.phase === 'interrupted',
  };
}
