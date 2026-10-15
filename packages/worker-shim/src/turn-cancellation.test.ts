import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerAdapterResult, WorkerResidentTurnInput } from './adapter-registry.js';
import type { WorkerControlFetch } from './control-client.js';
import type { SandboxIntegrationClient } from './integration-client.js';
import { emitRuntimeFact } from './runtime-capture.js';
import { runResidentTurn } from './turn.js';

const schedulingClock = vi.hoisted(() => ({ controlled: false }));

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: <T>(ms: number, value: T, options?: { signal?: AbortSignal }) => {
      if (!schedulingClock.controlled) return actual.setTimeout(ms, value, options);
      return new Promise<T>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
});

const lineage = {
  agentSessionId: 'as_cancellation',
  packageSnapshotId: 'pkg_cancellation',
  requestId: 'req_cancellation',
  threadId: 'th_cancellation',
  turnId: 'tu_cancellation',
  workspaceId: 'ws_cancellation',
};
const tokens = {
  capabilityToken: 'fixture-capability',
  controlToken: 'fixture-control',
  inferenceToken: 'fixture-inference',
};
const interrupted: WorkerAdapterResult = {
  assistantText: null,
  interruptRequested: true,
  nativeEvidence: { nativeTerminal: true, pipesDrained: true },
  status: 'interrupted',
  stopReason: 'worker-interrupted',
};

/** Supplies an explicit ordering point without elapsed-time polling. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/** Reads the worker-owned transcript, without inferring remote acceptance from local bytes. */
function events(path: string): WorkerCanonicalEventRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkerCanonicalEventRecord);
}

/** Composes the real Turn, transcript writer and control client; only the HTTP effect and native runtime are fixtures. */
function fixture(
  refusedType?: string,
  code = 'worker_control_lease_not_live',
  status = 403,
  acceptEnteredAppend = false
) {
  const root = mkdtempSync(join(tmpdir(), 'worker-cancellation-'));
  const sessionDir = join(root, 'capture');
  const eventPath = join(sessionDir, 'events.jsonl');
  const packagePath = join(root, 'package.json');
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
      extensions: { openkit: { turnInput: 'Inspect cancellation.' } },
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
      observability: { captureCoverage: { scope: 'server', value: 'on' } },
      runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: root } },
      scope: lineage,
    })
  );
  const cancellation = new AbortController();
  const native = deferred<WorkerAdapterResult>();
  const started = deferred<WorkerResidentTurnInput>();
  const readyAppend = deferred<void>();
  const pendingAppend = deferred<void>();
  const releaseAppend = deferred<void>();
  const nativeInterrupted = deferred<void>();
  const accepted: WorkerCanonicalEventRecord[] = [];
  const requests: Array<{
    url: string;
    body: string;
    authorization: string;
    signal: AbortSignal | undefined;
  }> = [];
  const finals: Array<{ sequence: number; lineage: unknown; body: Record<string, unknown> }> = [];
  const sealedAtFinal: string[] = [];
  let settled = false;
  let acceptedFinal = false;
  let enteredResponseRead = false;
  const interrupt = vi.fn(async () => {
    nativeInterrupted.resolve();
    await native.promise;
  });
  const drainTurn = vi.fn(async () => 0);
  const fetch: WorkerControlFetch = async (url, init) => {
    requests.push({
      url,
      body: init.body,
      authorization: init.headers.authorization!,
      signal: init.signal,
    });
    const body = JSON.parse(init.body);
    if (refusedType === 'periodic-heartbeat' && url.endsWith('/heartbeat') && body.sequence > 0) {
      pendingAppend.resolve();
      await releaseAppend.promise;
      return {
        ok: false,
        status,
        text: async () => {
          enteredResponseRead = true;
          return JSON.stringify({ code });
        },
      };
    }
    if (url.endsWith('/events/append')) {
      // A first final is a barrier: the fixture records any attempted output after it.
      expect(acceptedFinal).toBe(false);
      const record = body.record as WorkerCanonicalEventRecord;
      if (record.event.type === refusedType) {
        pendingAppend.resolve();
        await releaseAppend.promise;
        if (!acceptEnteredAppend)
          return { ok: false, status, text: async () => JSON.stringify({ code }) };
        accepted.push(record);
        return {
          ok: true,
          status: 200,
          text: async () => {
            enteredResponseRead = true;
            return JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 });
          },
        };
      }
      accepted.push(record);
      if (record.event.type === 'worker.ready') readyAppend.resolve();
    }
    if (url.endsWith('/final-status')) {
      expect(settled).toBe(true);
      if (acceptEnteredAppend || refusedType === 'periodic-heartbeat')
        expect(enteredResponseRead).toBe(true);
      sealedAtFinal.push(readFileSync(eventPath, 'utf8'));
      finals.push(body);
      acceptedFinal = true;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
    };
  };
  const run = () =>
    runResidentTurn({
      adapterId: 'fixture',
      credentialValues: [],
      environment: {},
      fetch,
      integration: {
        ready: Promise.resolve(),
        bindTurnRouteTokens() {},
        clearTurnRouteTokens() {},
        drainTurn,
      } as unknown as SandboxIntegrationClient,
      lineage,
      nativeEnvironment: null,
      onStarted() {},
      packagePath,
      resident: {
        childState: () => 'running',
        close: async () => undefined,
        exited: new Promise<void>(() => undefined),
        nativeHandle: async () => ({ state: 'pending' }),
        startTurn: async (input) => {
          started.resolve(input);
          return {
            interrupt,
            settled: native.promise.then((result) => {
              settled = true;
              return result;
            }),
          };
        },
      },
      runtimeEnvironmentNames: new Set(),
      sessionDir,
      signal: cancellation.signal,
      tokens,
      turnDirectory: join(root, 'native-turn'),
    });
  return {
    root,
    eventPath,
    sessionDir,
    cancellation,
    native,
    started,
    readyAppend,
    pendingAppend,
    releaseAppend,
    nativeInterrupted,
    accepted,
    requests,
    finals,
    sealedAtFinal,
    interrupt,
    drainTurn,
    run,
  };
}

/** Emits admitted content whose accepted descriptor must remain incomplete when its first chunk is refused. */
function emitContent(
  input: WorkerResidentTurnInput,
  bytes = Buffer.from('Accepted prefix must stay incomplete.')
) {
  return emitRuntimeFact(
    input.runtimeCapture,
    { sourceRef: 'source_cancellation', sourceSequence: 0 },
    {
      kind: 'assistant',
      runtimeOriginRef: null,
      messageRef: 'message_cancellation',
      phase: 'updated',
      representation: 'delta',
    },
    {
      bytes,
      mediaType: 'text/plain',
      boundary: 'runtime.assistant.text',
    }
  );
}

describe('cancellation final after ordinary append refusal', () => {
  // P11 owns the narrow exception. P03 proves worker publication; Core authentication and restart admission belong to P13.
  it('joins an entered accepted chunk after cancellation and leaves later declared chunks unpublished', async () => {
    const f = fixture('observation.content.chunk', 'worker_control_lease_not_live', 403, true);
    const outcome = f.run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    let emission: Promise<unknown> | undefined;
    try {
      const input = await f.started.promise;
      await f.readyAppend.promise;
      // The protocol admits at most 48 KiB in a chunk. This content requires exactly two.
      emission = emitContent(input, Buffer.alloc(48 * 1024 + 1, 120)).catch(
        (error: unknown) => error
      );
      await f.pendingAppend.promise;
      const entered = f.requests.at(-1)!;
      expect(JSON.parse(entered.body).record.event.data.chunkIndex).toBe(0);
      const requestsAtCancellation = f.requests.length;
      f.cancellation.abort();
      await f.nativeInterrupted.promise;
      f.native.resolve(interrupted);
      expect(entered.signal?.aborted).toBe(false);
      expect(f.finals).toEqual([]);
      f.releaseAppend.resolve();
      expect(await outcome).toEqual({
        result: { status: 'interrupted', nativeEvidence: interrupted.nativeEvidence },
      });
      await emission;
      expect(f.requests.slice(requestsAtCancellation).map((request) => request.url)).toEqual([
        '/worker-control/final-status',
      ]);
      const chunks = f.accepted.filter(
        (record) => record.event.type === 'observation.content.chunk'
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.event.data).toMatchObject({ chunkIndex: 0, byteOffset: 0 });
      expect(
        f.accepted.find((record) => record.event.type === 'observation.recorded')?.event.data
      ).toMatchObject({
        content: { state: 'expected', chunkCount: 2, bytes: 48 * 1024 + 1 },
        fact: { phase: 'updated' },
      });
      expect(f.finals).toHaveLength(1);
      const terminal = events(f.eventPath).at(-1)!;
      expect(terminal.event.data).toMatchObject({ status: 'interrupted', stopReason: 'aborted' });
      expect(events(f.eventPath).map((record) => record.event.type)).toEqual([
        'worker.heartbeat',
        'worker.ready',
        'observation.recorded',
        'turn.failed',
      ]);
      // The map is an admitted extension; its exact key is not a new shared schema contract.
      expect(terminal.event.data).toHaveProperty('diagnostics');
      expect(
        Object.values((terminal.event.data.diagnostics ?? {}) as Record<string, string>).some(
          (value) => /\bincomplete\b/i.test(value)
        )
      ).toBe(true);
      expect(f.finals[0]).toEqual({
        operation: 'final_status',
        schemaVersion: 2,
        lineage,
        sequence: terminal.sequence,
        body: terminal.event.data,
      });
      await expect(emitContent(input)).rejects.toThrow();
      expect(f.sealedAtFinal).toEqual([readFileSync(f.eventPath, 'utf8')]);
      expect(readFileSync(join(f.sessionDir, 'items.jsonl'), 'utf8')).toBe('');
    } finally {
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      await outcome;
      await emission;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    'worker_control_lease_not_live',
    'worker_control_revoked',
  ])('joins an entered periodic heartbeat with %s after cancellation without replay', async (code) => {
    schedulingClock.controlled = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const f = fixture('periodic-heartbeat', code);
    const outcome = f.run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await f.readyAppend.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await f.pendingAppend.promise;
      const entered = f.requests.at(-1)!;
      expect(entered.url).toBe('/worker-control/heartbeat');
      expect(JSON.parse(entered.body)).toMatchObject({
        operation: 'heartbeat',
        sequence: 1,
        lineage,
      });
      const requestsAtCancellation = f.requests.length;
      f.cancellation.abort();
      await f.nativeInterrupted.promise;
      f.native.resolve(interrupted);
      await vi.advanceTimersByTimeAsync(0);
      expect(entered.signal?.aborted).toBe(false);
      expect(f.finals).toEqual([]);
      f.releaseAppend.resolve();
      if (code === 'worker_control_lease_not_live') {
        expect(await outcome).toEqual({
          result: { status: 'interrupted', nativeEvidence: interrupted.nativeEvidence },
        });
        expect(f.requests.slice(requestsAtCancellation).map((request) => request.url)).toEqual([
          '/worker-control/final-status',
        ]);
        expect(f.finals).toHaveLength(1);
        const terminal = events(f.eventPath).at(-1)!;
        expect(terminal.event.data).toMatchObject({ status: 'interrupted', stopReason: 'aborted' });
        expect(f.finals[0]).toEqual({
          operation: 'final_status',
          schemaVersion: 2,
          lineage,
          sequence: terminal.sequence,
          body: terminal.event.data,
        });
        expect(f.sealedAtFinal).toEqual([readFileSync(f.eventPath, 'utf8')]);
      } else {
        expect(await outcome).toMatchObject({ error: { code, status: 403 } });
        expect(f.finals).toEqual([]);
        expect(f.requests.slice(requestsAtCancellation)).toEqual([]);
      }
      expect(f.requests.filter((request) => request.url.endsWith('/heartbeat'))).toHaveLength(2);
      expect(events(f.eventPath).map((record) => record.event.type)).toEqual([
        'worker.heartbeat',
        'worker.ready',
        'turn.failed',
      ]);
      // No time advance beyond the entered request is needed: a definitive refusal starts no retry budget.
      expect(performance.now()).toBe(1_000);
      expect(
        f.accepted.filter(
          (record) =>
            record.event.type === 'worker.heartbeat' && record.event.data.status !== 'starting'
        )
      ).toEqual([]);
    } finally {
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      await outcome;
      schedulingClock.controlled = false;
      vi.useRealTimers();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    'worker.ready',
    'observation.content.chunk',
  ])('publishes one sealed interrupted final after a pending %s is refused', async (refusedType) => {
    const f = fixture(refusedType);
    const run = f.run();
    const outcome = run.then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    let emission: Promise<unknown> | undefined;
    try {
      const input = await f.started.promise;
      if (refusedType === 'observation.content.chunk') {
        await f.readyAppend.promise;
        emission = emitContent(input).catch((error: unknown) => error);
      }
      await f.pendingAppend.promise;
      const prefix = structuredClone(f.accepted);
      const requestsAtCancellation = f.requests.length;
      f.cancellation.abort(new Error('Owned exact Turn interrupt.'));
      await f.nativeInterrupted.promise;
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      expect(await outcome).toEqual({
        result: { status: 'interrupted', nativeEvidence: interrupted.nativeEvidence },
      });
      await emission;
      expect(f.interrupt).toHaveBeenCalledTimes(1);
      expect(f.drainTurn).toHaveBeenCalledTimes(1);
      expect(f.finals).toHaveLength(1);
      const terminal = events(f.eventPath).at(-1)!;
      expect(terminal.event).toMatchObject({
        type: 'turn.failed',
        data: { status: 'interrupted', stopReason: 'aborted' },
      });
      expect(f.finals[0]).toEqual({
        operation: 'final_status',
        schemaVersion: 2,
        lineage,
        sequence: terminal.sequence,
        body: terminal.event.data,
      });
      await expect(emitContent(input)).rejects.toThrow();
      expect(f.sealedAtFinal).toEqual([readFileSync(f.eventPath, 'utf8')]);
      expect(f.requests.slice(requestsAtCancellation).map((request) => request.url)).toEqual([
        '/worker-control/final-status',
      ]);
      expect(
        f.requests.every((request) => request.authorization === `Bearer ${tokens.controlToken}`)
      ).toBe(true);
      expect(f.accepted).toEqual(prefix);
      expect(readFileSync(join(f.sessionDir, 'items.jsonl'), 'utf8')).toBe('');
      expect(
        events(f.eventPath).filter(
          (record) =>
            record.event.type === 'worker.heartbeat' && record.event.data.status === 'turn.settled'
        )
      ).toEqual([]);
      if (refusedType === 'observation.content.chunk') {
        const descriptor = f.accepted.find(
          (record) => record.event.type === 'observation.recorded'
        )!;
        expect(descriptor.event.data).toMatchObject({
          content: { state: 'expected', chunkCount: 1 },
          fact: { phase: 'updated' },
        });
        expect(f.accepted.some((record) => record.event.type === 'observation.content.chunk')).toBe(
          false
        );
        expect(readFileSync(f.eventPath, 'utf8')).not.toContain(
          'Accepted prefix must stay incomplete.'
        );
      }
    } finally {
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      await outcome;
      await emission;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { code: 'worker_control_lease_not_live', status: 403, cancel: false },
    { code: 'worker_control_token_invalid', status: 401, cancel: true },
    { code: 'worker_control_lease_not_live', status: 401, cancel: true },
    { code: 'worker_control_lease_not_live', status: 409, cancel: true },
    { code: 'worker_control_revoked', status: 403, cancel: true },
    { code: 'worker_control_fenced', status: 409, cancel: true },
    { code: 'worker_control_deadline_expired', status: 403, cancel: true },
    { code: 'worker_control_unknown_authority', status: 403, cancel: true },
  ])('does not grant cancellation publication for $code (cancel=$cancel)', async ({
    code,
    status,
    cancel,
  }) => {
    const f = fixture('worker.ready', code, status);
    const outcome = f.run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await f.pendingAppend.promise;
      if (cancel) {
        f.cancellation.abort();
        await f.nativeInterrupted.promise;
      }
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      expect(await outcome).toMatchObject({ error: { code, status } });
      expect(f.finals).toEqual([]);
      expect(f.requests.filter((request) => request.url.endsWith('/events/append'))).toHaveLength(
        2
      );
      expect(events(f.eventPath).at(-1)?.event.data).toMatchObject({
        status: 'failed',
        stopReason: 'error',
      });
    } finally {
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      await outcome;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 'completed' as const, interruptRequested: false },
    { status: 'interrupted' as const, interruptRequested: false },
    { status: 'failed' as const, interruptRequested: true },
  ])('does not replace native $status with cancellation after the lease refusal (interruptRequested=$interruptRequested)', async (testCase) => {
    const f = fixture('worker.ready');
    const outcome = f.run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await f.pendingAppend.promise;
      f.cancellation.abort();
      await f.nativeInterrupted.promise;
      f.native.resolve({ assistantText: null, ...testCase, stopReason: 'native-terminal' });
      f.releaseAppend.resolve();
      expect(await outcome).toMatchObject({
        error: { code: 'worker_control_lease_not_live', status: 403 },
      });
      expect(f.finals).toEqual([]);
      expect(events(f.eventPath).at(-1)?.event.data).toMatchObject({
        status: 'failed',
        stopReason: 'error',
      });
    } finally {
      f.native.resolve(interrupted);
      f.releaseAppend.resolve();
      await outcome;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      status: 'completed' as const,
      interruptRequested: false,
      expected: 'completed',
      stopReason: 'completed',
    },
    {
      status: 'interrupted' as const,
      interruptRequested: false,
      expected: 'failed',
      stopReason: 'error',
    },
    {
      status: 'failed' as const,
      interruptRequested: true,
      expected: 'failed',
      stopReason: 'error',
    },
  ])('preserves settled native $status classification with interruptRequested=$interruptRequested', async (testCase) => {
    const f = fixture();
    const outcome = f.run();
    try {
      await f.readyAppend.promise;
      // Late cancellation cannot rewrite the immutable native result supplied by the adapter.
      f.cancellation.abort();
      await f.nativeInterrupted.promise;
      f.native.resolve({
        assistantText: null,
        status: testCase.status,
        interruptRequested: testCase.interruptRequested,
        stopReason: 'native-terminal',
      });
      await expect(outcome).resolves.toEqual({ status: testCase.expected });
      expect(f.finals).toHaveLength(1);
      expect(f.finals[0]?.body).toMatchObject({
        status: testCase.expected,
        stopReason: testCase.stopReason,
      });
    } finally {
      await outcome.catch(() => undefined);
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
