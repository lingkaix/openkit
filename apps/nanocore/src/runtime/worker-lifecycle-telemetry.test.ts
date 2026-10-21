// openkit-test-platform: posix
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { shutdownTelemetry, startTelemetry } from '../telemetry.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

const readFilesystemStats = fs.statfs;
const REQUEST_CANARY = 'private-request-content-canary';
const ERROR_CANARY = 'private-backend-error-canary';
const METRIC = 'openkit.turn.stage.duration';
const DIMENSIONS = ['openkit.lifecycle.stage', 'openkit.outcome.class', 'openkit.worker.kind'];
let root: string;
let logDirectory: string;
let coreDb: CoreDb;

/** Standard OTLP AnyValue attributes used by these assertions, not a custom decoder. */
type Attributes = Array<{ key: string; value: { stringValue?: string } }>;
/** Standard explicit-bucket histogram fields consumed from stock-shaped local JSON. */
interface Histogram {
  name: string;
  unit: string;
  histogram: {
    aggregationTemporality: number;
    dataPoints: Array<{
      attributes: Attributes;
      count: number | string;
      sum: number;
      bucketCounts: Array<number | string>;
    }>;
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'worker-lifecycle-telemetry-'));
  logDirectory = join(root, 'logs');
  await fs.mkdir(logDirectory);
  coreDb = openCoreDb(join(root, 'data'));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  recordTestNativeRuntimeTarget(coreDb);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(fs, 'statfs').mockImplementation(async (...args) => {
    const stats = await readFilesystemStats(...args);
    const capacity = {
      type: 0xef53,
      bsize: 4096,
      blocks: 1_048_576,
      bfree: 1_048_576,
      bavail: 1_048_576,
      files: 1_000_000,
      ffree: 900_000,
    };
    return Object.assign(
      stats,
      typeof stats.bsize === 'bigint'
        ? Object.fromEntries(Object.entries(capacity).map(([key, value]) => [key, BigInt(value)]))
        : capacity
    );
  });
});

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  try {
    await shutdownTelemetry();
  } finally {
    coreDb?.sqlite.close();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('current Worker lifecycle telemetry', () => {
  it('ends validation only after the real executor awaits its backend, without claiming native work', async () => {
    const exporter = beginTelemetry();
    const fixture = await createFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    fixture.capabilities.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return fixture.availableCapabilities();
    });
    const run = await fixture.run();
    try {
      await vi.waitFor(() => expect(fixture.validation).toHaveBeenCalledOnce());
      await entered.promise;
      expect(fixture.executor.isTurnExecutionActive(run.turn.id)).toBe(true);
      expect(validationSpans(exporter)).toEqual([]);
      expect(fixture.plan).not.toHaveBeenCalled();
      expect(run.settled).not.toHaveBeenCalled();
      await delay(25);
    } finally {
      release.resolve();
    }
    expect(await run.outcome).toBe(fixture.stopAfterValidation);
    assertProductSettlement(fixture, run);
    const spans = validationSpans(exporter);
    expect(
      spans,
      'the awaited validation boundary must emit one ended lifecycle span'
    ).toHaveLength(1);
    const span = spans[0]!;
    expect(span.attributes).toMatchObject({
      'openkit.outcome.class': 'success',
      'openkit.worker.kind': 'codex',
      'openkit.turn.id': run.turn.id,
      'openkit.thread.id': DEMO_THREAD_ID,
      'openkit.workspace.id': DEMO_WORKSPACE_ID,
      'openkit.agent.session.id': run.agentSessionId,
    });
    expect(span.duration[0] + span.duration[1] / 1e9).toBeGreaterThanOrEqual(0.02);
    expect(
      exporter
        .getFinishedSpans()
        .some((item) =>
          /native.*run|turn[._ ]start.*delivery/i.test(
            String(item.attributes['openkit.lifecycle.stage'])
          )
        )
    ).toBe(false);
    await shutdownTelemetry();
    await assertSafeLocalBytes();
  });

  it('records a returned validation refusal as rejected, never successful native execution', async () => {
    const exporter = beginTelemetry();
    const fixture = await createFixture();
    fixture.capabilities.mockResolvedValueOnce({
      ...(await fixture.availableCapabilities()),
      capabilities: [],
    });
    const run = await fixture.run();
    expect(await run.outcome).toBeInstanceOf(DeterministicAgentPreparationError);
    expect(fixture.validation).toHaveBeenCalledOnce();
    expect(fixture.plan).not.toHaveBeenCalled();
    assertProductSettlement(fixture, run);
    const spans = validationSpans(exporter);
    expect(
      spans,
      'diagnostic refusal is an observed validation result, not a success'
    ).toHaveLength(1);
    expect(spans[0]?.attributes['openkit.outcome.class']).toBe('rejected');
    await shutdownTelemetry();
    await assertSafeLocalBytes();
  });

  it('exports nine successful validations and one failure as ten delta histogram samples', async () => {
    beginTelemetry();
    const fixture = await createFixture();
    const backendFailure = new Error(ERROR_CANARY);
    const turnIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      if (index === 9) fixture.capabilities.mockRejectedValueOnce(backendFailure);
      const run = await fixture.run();
      turnIds.push(run.turn.id);
      expect(await run.outcome).toBe(index === 9 ? backendFailure : fixture.stopAfterValidation);
      assertProductSettlement(fixture, run);
    }
    expect(fixture.validation).toHaveBeenCalledTimes(10);
    expect(fixture.plan).toHaveBeenCalledTimes(9);
    await shutdownTelemetry();
    const first = await localMetrics();
    const histograms = first.filter((metric) => metric.name === METRIC);
    expect(
      histograms.length,
      'actual runtime validations must export the stage-duration histogram'
    ).toBeGreaterThan(0);
    const counts: Record<string, number> = {};
    for (const metric of histograms) {
      expect(metric.unit).toBe('s');
      expect(metric.histogram.aggregationTemporality).toBe(1);
      for (const point of metric.histogram.dataPoints) {
        expect(point.attributes.map((attribute) => attribute.key).sort()).toEqual(
          [...DIMENSIONS].sort()
        );
        const attributes = Object.fromEntries(
          point.attributes.map((attribute) => [attribute.key, attribute.value.stringValue])
        );
        if (attributes['openkit.lifecycle.stage']?.toLowerCase() !== 'validation') continue;
        expect(attributes['openkit.worker.kind']).toBe('codex');
        expect(Number.isFinite(point.sum)).toBe(true);
        expect(point.sum).toBeGreaterThanOrEqual(0);
        expect(point.bucketCounts.reduce<number>((sum, count) => sum + Number(count), 0)).toBe(
          Number(point.count)
        );
        const outcome = attributes['openkit.outcome.class']!;
        counts[outcome] = (counts[outcome] ?? 0) + Number(point.count);
      }
    }
    expect(counts).toEqual({ success: 9, failure: 1 });
    for (const id of turnIds) expect(JSON.stringify(histograms)).not.toContain(id);
    await shutdownTelemetry();
    expect(await localMetrics(), 'repeated read and shutdown must not resample ended work').toEqual(
      first
    );
    await assertSafeLocalBytes();
  });

  it.each([
    'disabled',
    'unavailable',
  ] as const)('preserves backend failure and claim cleanup when telemetry is %s', async (mode) => {
    const exporter = beginTelemetry(mode);
    const exported = vi.spyOn(exporter, 'export');
    const fixture = await createFixture();
    const failure = new Error(ERROR_CANARY);
    fixture.capabilities.mockRejectedValueOnce(failure);
    const run = await fixture.run();
    expect(await run.outcome).toBe(failure);
    expect(fixture.validation).toHaveBeenCalledOnce();
    expect(fixture.plan).not.toHaveBeenCalled();
    assertProductSettlement(fixture, run);
    await shutdownTelemetry();
    if (mode === 'disabled') expect(exported).not.toHaveBeenCalled();
    expect((await signalFiles()).length).toBe(0);
  });
});

/** Keeps the real validator and executor; controls capability discovery and the next no-effect boundary. */
async function createFixture() {
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const agentSetup = createTestAgentSetup({ requiredCapabilities: ['worker-control'] });
  admitTestNativeEnvironment(coreDb, agentSetup.manifest);
  const runtime = createConfiguredWorkerLifecycleRuntime({ coreDb, store, env: {} });
  if (!(runtime.turnExecutor instanceof WorkerGovernanceTurnExecutor))
    throw new Error('Expected the configured worker executor');
  const executor = runtime.turnExecutor;
  const backend = executor.executionBackend as WorkerGovernanceBackend;
  vi.spyOn(backend, 'inspectMaterializationCapacity').mockReturnValue('available');
  const availableCapabilities = backend.describeCapabilities.bind(backend);
  const capabilities = vi.spyOn(backend, 'describeCapabilities');
  const validation = vi.spyOn(backend, 'validatePackage');
  // Stop before any native effect. Validation success must not become native success.
  const stopAfterValidation = new Error('controlled-no-effect-boundary');
  const plan = vi.spyOn(backend, 'planSession').mockImplementation(() => {
    throw stopAfterValidation;
  });
  const materialize = vi.spyOn(backend, 'materialize');
  const submit = vi.spyOn(backend, 'submit');
  const cleanup = vi.spyOn(backend, 'cleanupSession');
  return {
    store,
    executor,
    validation,
    capabilities,
    availableCapabilities,
    plan,
    materialize,
    submit,
    cleanup,
    stopAfterValidation,
    /** Starts one real admitted Turn and observes its public settlement without replacing the executor. */
    async run() {
      const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
      const created = await store.createTurn(
        DEMO_WORKSPACE_ID,
        DEMO_THREAD_ID,
        REQUEST_CANARY,
        actor
      );
      const turn = await store.updateTurn(created.id, { agentId: agentSetup.manifest.id });
      const agentSessionId = testEntityId('as', `telemetry-${turn.id}`);
      const now = () => new Date().toISOString();
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: actor,
        profileRef: 'profile_worker',
        queueEntryId: `queue_${turn.id}`,
        requestId: `request:${turn.id}`,
        requestedAgentId: agentSetup.manifest.id,
        threadId: turn.threadId,
        turnId: turn.id,
        turnInput: REQUEST_CANARY,
        workspaceId: DEMO_WORKSPACE_ID,
        now,
      });
      const attempt = recordTestExecutionAttempt(coreDb, {
        entry,
        attemptId: testEntityId('attempt', `telemetry-${turn.id}`),
        agentSessionId,
        inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
        bindingRef: `binding:${turn.id}`,
        sessionCompatibilityKey: 'fixture-compatibility',
        now,
      });
      const settled = vi.fn();
      const outcome = executor
        .startTurn(store, turn.id, REQUEST_CANARY, {
          attemptId: attempt.attemptId,
          agentSessionId,
          agentSetup,
          requestId: entry.requestId,
          triggerActor: actor,
          workspaceRoots: [],
          onSubmissionSettled: settled,
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      return { turn, agentSessionId, attemptId: attempt.attemptId, settled, outcome };
    },
  };
}

/** Verifies existing product failure and no-effect cleanup before checking optional diagnostics. */
function assertProductSettlement(
  fixture: ReturnType<typeof createFixture>,
  run: ReturnType<ReturnType<typeof createFixture>['run']>
): void {
  expect(fixture.store.getTurnById(run.turn.id).status).toBe('failed');
  expect(fixture.executor.isTurnExecutionActive(run.turn.id)).toBe(false);
  expect(run.settled).toHaveBeenCalledOnce();
  expect(requireSchedulerExecutionAttempt(coreDb, run.attemptId).phase).toBe('closed');
  expect(fixture.materialize).not.toHaveBeenCalled();
  expect(fixture.submit).not.toHaveBeenCalled();
  expect(fixture.cleanup).not.toHaveBeenCalled();
}

/** Starts real private SDK capture; unsafe capacity affects only the local destination. */
function beginTelemetry(mode?: 'disabled' | 'unavailable'): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  startTelemetry({
    bootId: 'boot-worker-lifecycle',
    logDirectory,
    exporter,
    readReserveBytes: () => (mode === 'unavailable' ? Number.NaN : 1_000_000_000),
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      ...(mode === 'disabled' ? { OTEL_SDK_DISABLED: 'true' } : {}),
    },
  });
  return exporter;
}

/** Selects the owner's validation stage without prescribing a new helper or span name. */
function validationSpans(exporter: InMemorySpanExporter): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) => String(span.attributes['openkit.lifecycle.stage']).toLowerCase() === 'validation'
    );
}

/** Enumerates only this fixture's real signal files, without assuming a segment naming convention. */
async function signalFiles(directory = logDirectory): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await signalFiles(path)));
    else if (entry.isFile() && (await fs.stat(path)).size > 0) files.push(path);
  }
  return files.sort();
}

/** Parses stock JSON metric requests; empty SDK collections supply no histogram evidence. */
async function localMetrics(): Promise<Histogram[]> {
  const metrics: Histogram[] = [];
  for (const file of await signalFiles()) {
    const text = await fs.readFile(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const signals = new Set<string>();
    for (const line of text.trimEnd().split('\n')) {
      const request = JSON.parse(line) as {
        resourceSpans?: unknown[];
        resourceMetrics?: Array<{ scopeMetrics: Array<{ metrics: Histogram[] }> }>;
      };
      if (request.resourceSpans) signals.add('traces');
      if (request.resourceMetrics) signals.add('metrics');
      for (const resource of request.resourceMetrics ?? [])
        for (const scope of resource.scopeMetrics)
          for (const metric of scope.metrics)
            if (metric.histogram?.dataPoints.length) metrics.push(metric);
    }
    expect(signals.size, 'traces and metrics require separate signal segments').toBeLessThanOrEqual(
      1
    );
  }
  return metrics;
}

/** Checks actual serialized diagnostics rather than a filtered attribute projection. */
async function assertSafeLocalBytes(): Promise<void> {
  const bytes = (
    await Promise.all((await signalFiles()).map((path) => fs.readFile(path, 'utf8')))
  ).join('');
  for (const canary of [REQUEST_CANARY, ERROR_CANARY, root]) expect(bytes).not.toContain(canary);
}

/** Holds an actual awaited backend call without replacing the executor or telemetry subject. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
