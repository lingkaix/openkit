import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadTimelineResponseSchema } from '@openkit/app-api-schemas';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId, type GatewayRouteLineageEntry } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ledgerOwner from '../capability/usage-ledger.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
  type UsageMeasurementInput,
  writeGatewayRouteLineage,
} from '../capability/usage-ledger.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openWorkspaceDb } from './db.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Uses real call, measurement and route-lineage publishers in a canonical native Workspace. */
async function fixture(withSession = false) {
  const root = mkdtempSync(join(tmpdir(), 'timeline-environment-'));
  const coreDb = createTestCoreDb(root);
  const handles: ReturnType<typeof openWorkspaceDb>[] = [];
  cleanups.push(() => disposeTestStore(root, ...handles, coreDb));
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user', id: userId } as const;
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Recorded environment',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const sessionId = withSession ? allocateEntityId('as') : null;
  if (sessionId)
    await store
      .createAgentSession({
        id: sessionId,
        agentId: 'agent_demo',
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        status: 'created',
        message: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .catch((cause) => {
        throw new Error('Environment fixture Session publication failed', { cause });
      });
  const turn = await store
    .createTurn(DEMO_WORKSPACE_ID, thread.id, 'Measure this exact run', actor, null, {})
    .catch((cause) => {
      throw new Error('Environment fixture Turn publication failed', { cause });
    });
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  handles.push(db);
  async function call(
    options: {
      turn?: typeof turn;
      family?: 'llm' | 'mcp';
      sessionId?: string | null;
      now?: Date;
    } = {}
  ) {
    const sourceTurn = options.turn ?? turn;
    const family = options.family ?? 'llm';
    const sourceSession =
      options.sessionId === undefined
        ? (sessionId ?? sourceTurn.agentSessionId ?? null)
        : options.sessionId;
    const started = await startCapabilityCall({
      workspaceDb: db,
      workspaceId: DEMO_WORKSPACE_ID,
      authorityActor: actor,
      threadId: sourceTurn.threadId,
      turnId: sourceTurn.id,
      agentId:
        sourceTurn.agentId ?? (sourceSession ? store.getAgentSession(sourceSession).agentId : null),
      agentSessionId: sourceSession,
      family,
      operation: family === 'llm' ? 'responses.create' : 'mcp.call-tool',
      capabilityId: family === 'llm' ? 'llm.responses' : 'mcp.call-tool',
      providerRef: 'private-profile-environment-fixture',
      serviceRef: 'private-service-environment-fixture',
      redactionClass: 'metadata-only',
      now: options.now ?? new Date(),
    }).catch((cause) => {
      throw new Error('Environment fixture capability publication failed', { cause });
    });
    expect(started.inserted).toBe(true);
    return started;
  }
  async function usage(
    call: Awaited<ReturnType<typeof startCapabilityCall>>,
    records: UsageMeasurementInput[]
  ) {
    const ids = await recordUsage({ workspaceDb: db, call, records }).catch((cause) => {
      throw new Error('Environment fixture usage publication failed', { cause });
    });
    expect(ids).toHaveLength(records.length);
    return ids;
  }
  async function lineage(
    call: Awaited<ReturnType<typeof startCapabilityCall>>,
    entries: GatewayRouteLineageEntry[]
  ) {
    for (const entry of entries)
      await writeGatewayRouteLineage({
        workspaceDb: db,
        call,
        logicalModelId: 'private-logical-model-fixture',
        entry,
      });
  }
  let app: ReturnType<typeof createApp> | undefined;
  async function read() {
    app ??= createApp({ coreDb, store });
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return ThreadTimelineResponseSchema.parse(body);
  }
  return {
    root,
    coreDb,
    userId,
    actor,
    store,
    thread,
    turn,
    sessionId,
    db,
    call,
    usage,
    lineage,
    read,
  };
}

/** Reached members carry actual attempt evidence, not preference or a preflight exclusion. */
function attempt(member: string, order = 0, retry = 0): GatewayRouteLineageEntry {
  return {
    kind: 'attempt',
    routeMemberId: member,
    providerProfileId: `private-profile-${member}`,
    providerModel: `private-serving-model-${member}`,
    selectionReason: 'fixture recorded selection',
    attemptOrder: order,
    retryIndex: retry,
    outputBegan: false,
    terminalResult: 'failed',
    failureKind: 'provider_unavailable',
  };
}

/** An unavailable member was excluded before contact and is never an attempted fallback. */
function unavailable(member: string): GatewayRouteLineageEntry {
  return {
    kind: 'unavailable',
    routeMemberId: member,
    selectionReason: 'fixture preflight',
    failureKind: 'provider_unavailable',
    unavailableReason: 'fixture route unavailable',
  };
}

type Measurement = Pick<UsageMeasurementInput, 'category' | 'unit' | 'quantity'> & {
  source: string | null;
};

/** Compares the complete qualifier-preserving multiset without imposing a display order. */
function expectMeasurements(actual: unknown, expected: Measurement[]) {
  expect(actual).toEqual({ coverage: 'partial', measurements: expect.arrayContaining(expected) });
  expect((actual as { measurements: unknown[] }).measurements).toHaveLength(expected.length);
}

interface LedgerRead {
  sql: string;
  method: 'all' | 'get';
  rows: Array<Record<string, unknown>>;
  plan: string[];
}

/** Observes real returned rows and native query plans; no source statement or result is replaced. */
function observeLedgerReads() {
  const reads: LedgerRead[] = [];
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql);
    if (/\bselect\b/i.test(sql) && /\b(capability_calls|usage_records)\b/i.test(sql)) {
      const record = (
        method: 'all' | 'get',
        rows: Array<Record<string, unknown>>,
        bindings: unknown[]
      ) => {
        const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{
          detail: string;
        }>;
        reads.push({ sql, method, rows, plan: plan.map((row) => row.detail) });
      };
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...bindings: unknown[]) => {
        const rows = all(...bindings) as Array<Record<string, unknown>>;
        record('all', rows, bindings);
        return rows;
      });
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...bindings: unknown[]) => {
        const row = get(...bindings) as Record<string, unknown> | undefined;
        record('get', row ? [row] : [], bindings);
        return row;
      });
    }
    return statement;
  });
  return reads;
}

describe('Recorded per-run timeline environment', () => {
  it('keeps missing usage and route evidence null rather than inventing zero or a serving model', async () => {
    const f = await fixture();
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.usage).toBeNull();
    expect(run.fallback).toBeNull();
  }, 30_000);

  it('projects call-linked measured usage as a partial lower bound even with no local clipping', async () => {
    const f = await fixture();
    const call = await f.call();
    await f.usage(call, [{ category: 'llm', unit: 'tokens', quantity: 17 }]);
    await finishCapabilityCall({
      workspaceDb: f.db,
      callId: call.id,
      status: 'failed',
      errorCode: 'fixture_provider_failure',
    });
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.usage).toEqual({
      coverage: 'partial',
      measurements: [{ category: 'llm', unit: 'tokens', quantity: 17, source: null }],
    });
    expect(run.fallback).toBeNull();
  }, 30_000);

  it('keeps gateway input, output, cache and total counters separate and sums only exact source-qualified metrics', async () => {
    const f = await fixture();
    const sources = {
      input: 'llm-gateway-adapter-reported:input',
      output: 'llm-gateway-adapter-reported:output',
      total: 'llm-gateway-adapter-reported:total',
      read: 'llm-gateway-adapter-reported:cache_read',
      write: 'llm-gateway-adapter-reported:cache_write',
      cost: 'llm-gateway-adapter-reported:cost_estimate',
    };
    for (const [input, output, cost] of [
      [10, 3, 0.25],
      [20, 7, 0.75],
    ]) {
      const call = await f.call();
      await f.usage(call, [
        { category: 'llm', unit: 'tokens', source: sources.input, quantity: input! },
        { category: 'llm', unit: 'tokens', source: sources.output, quantity: output! },
        { category: 'llm', unit: 'tokens', source: sources.total, quantity: input! + output! },
        { category: 'llm', unit: 'tokens', source: sources.read, quantity: 0 },
        { category: 'llm', unit: 'tokens', source: sources.write, quantity: 0 },
        { category: 'llm', unit: 'usd', source: sources.cost, quantity: cost! },
      ]);
    }
    const tool = await f.call({ family: 'mcp' });
    await f.usage(tool, [
      { category: 'tool', unit: 'tool_calls', source: 'gateway-observed', quantity: 2 },
      { category: 'runtime', unit: 'seconds', source: 'gateway-observed', quantity: 4 },
    ]);
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expectMeasurements(run.usage, [
      { category: 'llm', unit: 'tokens', source: sources.input, quantity: 30 },
      { category: 'llm', unit: 'tokens', source: sources.output, quantity: 10 },
      { category: 'llm', unit: 'tokens', source: sources.total, quantity: 40 },
      { category: 'llm', unit: 'tokens', source: sources.read, quantity: 0 },
      { category: 'llm', unit: 'tokens', source: sources.write, quantity: 0 },
      { category: 'llm', unit: 'usd', source: sources.cost, quantity: 1 },
      { category: 'tool', unit: 'tool_calls', source: 'gateway-observed', quantity: 2 },
      { category: 'runtime', unit: 'seconds', source: 'gateway-observed', quantity: 4 },
    ]);
  }, 30_000);

  it('preserves separate unqualified records and distinguishes a recorded zero from missing usage', async () => {
    const f = await fixture();
    const call = await f.call();
    const ids = await f.usage(call, [
      { category: 'llm', unit: 'tokens', quantity: 4 },
      { category: 'llm', unit: 'tokens', source: null, quantity: 6 },
      { category: 'llm', unit: 'requests', source: 'gateway-observed', quantity: 0 },
    ]);
    expect(new Set(ids).size).toBe(3);
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expectMeasurements(run.usage, [
      { category: 'llm', unit: 'tokens', source: null, quantity: 4 },
      { category: 'llm', unit: 'tokens', source: null, quantity: 6 },
      { category: 'llm', unit: 'requests', source: 'gateway-observed', quantity: 0 },
    ]);
  }, 30_000);

  it('does not borrow measurements from another run with the same recorded Session or another Thread', async () => {
    const f = await fixture(true);
    const own = await f.call();
    await f.usage(own, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
    ]);
    // The real Session identifies both calls. This ledger test claims no Runtime binding or physical execution.
    expect(own.context.agentSessionId).toBe(f.store.getAgentSession(f.sessionId!).id);
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const later = await f.store
      .createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'Same Session, different run', f.actor, null, {})
      .catch((cause) => {
        throw new Error('Environment fixture successor Session Turn publication failed', { cause });
      });
    const otherCall = await f.call({ turn: later });
    expect(otherCall.context.agentSessionId).toBe(own.context.agentSessionId);
    await f.usage(otherCall, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 97 },
    ]);
    const foreignThread = await f.store.createThread(DEMO_WORKSPACE_ID, 'Other ledger Thread');
    const foreignTurn = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      foreignThread.id,
      'Foreign measurement',
      f.actor
    );
    await f.usage(await f.call({ turn: foreignTurn, sessionId: null }), [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 997 },
    ]);
    const body = await f.read();
    expectMeasurements(body.runs.find((run) => run.id === f.turn.id)!.usage, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
    ]);
    expectMeasurements(body.runs.find((run) => run.id === later.id)!.usage, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 97 },
    ]);
  }, 30_000);

  it('counts each actual multi-member LLM call once, not retries, switches or unrelated MCP calls', async () => {
    const f = await fixture();
    for (const entries of [
      [attempt('member-a'), attempt('member-b', 1), attempt('member-a', 2)],
      [attempt('member-b'), attempt('member-c', 1)],
      [attempt('member-a'), attempt('member-a', 1, 1), attempt('member-a', 2, 2)],
    ]) {
      const call = await f.call();
      await f.lineage(call, entries);
      await finishCapabilityCall({
        workspaceDb: f.db,
        callId: call.id,
        status: 'failed',
        errorCode: 'fixture_attempts_failed',
      });
    }
    await f.call({ family: 'mcp' });
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.fallback).toEqual({ callsWithFallback: 2, coverage: 'complete' });
    expect(run.usage).toBeNull();
    const text = JSON.stringify(run);
    for (const privateValue of [
      'member-a',
      'member-b',
      'member-c',
      'private-profile',
      'private-serving-model',
      'private-logical-model',
      'private-service',
    ])
      expect(text).not.toContain(privateValue);
  }, 30_000);

  it('does not call a preflight exclusion an attempted fallback or a complete no-fallback history', async () => {
    const f = await fixture();
    await f.lineage(await f.call(), [unavailable('excluded-member'), attempt('reached-member')]);
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.fallback).toEqual({ callsWithFallback: 0, coverage: 'partial' });
  }, 30_000);

  it('keeps a route with no actual attempt unknown rather than reporting a measured zero', async () => {
    const f = await fixture();
    await f.lineage(await f.call(), [unavailable('excluded-a'), unavailable('excluded-b')]);
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.fallback).toBeNull();
    expect(run.usage).toBeNull();
  }, 30_000);

  it('retains known fallback counts with partial coverage when other calls have missing or zero-attempt lineage', async () => {
    const f = await fixture();
    await f.lineage(await f.call(), [attempt('member-a'), attempt('member-b', 1)]);
    await f.call();
    await f.lineage(await f.call(), [unavailable('excluded-only')]);
    expect((await f.read()).runs.find((run) => run.id === f.turn.id)!.fallback).toEqual({
      callsWithFallback: 1,
      coverage: 'partial',
    });
  }, 30_000);

  it.each(['ar:audit-read', 'ar:workspace-read'] as const)(
    'rechecks independent current %s before any ledger read',
    async (deniedRight) => {
      const f = await fixture();
      const call = await f.call();
      await f.usage(call, [
        { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
      ]);
      await f.lineage(call, [attempt('member-a')]);
      expectMeasurements((await f.read()).runs.find((run) => run.id === f.turn.id)!.usage, [
        { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
      ]);
      const ledgerReads: string[] = [];
      const prepare = Database.prototype.prepare;
      vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
        this: Database.Database,
        sql: string
      ) {
        if (/\bselect\b/i.test(sql) && /\b(capability_calls|usage_records)\b/i.test(sql))
          ledgerReads.push(sql);
        return prepare.call(this, sql);
      });
      await f.read();
      expect(ledgerReads.length).toBeGreaterThan(0);
      const evaluate = policyKernel.evaluateAccess;
      const deny = vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
        evaluate(
          {
            ...policy,
            associations: policy.associations.map((association) => ({
              ...association,
              accessRights: association.accessRights.filter((right) => right !== deniedRight),
            })),
          },
          request
        )
      );
      ledgerReads.length = 0;
      const denied = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
      expect(denied.usage).toBeNull();
      expect(denied.fallback).toBeNull();
      expect(ledgerReads).toEqual([]);
      deny.mockRestore();
      expectMeasurements((await f.read()).runs.find((run) => run.id === f.turn.id)!.usage, [
        { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
      ]);
    },
    30_000
  );

  it('clips 17 native calls to 16 with explicit partial fallback and no Workspace ledger census', async () => {
    const f = await fixture();
    for (let index = 0; index < 17; index++) {
      const call = await f.call();
      await f.usage(call, [
        { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 1 },
      ]);
      await f.lineage(call, [attempt('member-a'), attempt('member-b', 1)]);
    }
    await f.read();
    const calls = vi.spyOn(ledgerOwner, 'listWorkspaceCapabilityCalls');
    const records = vi.spyOn(ledgerOwner, 'listWorkspaceUsageRecords');
    const reads = observeLedgerReads();
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expectMeasurements(run.usage, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 16 },
    ]);
    expect(run.fallback).toEqual({ callsWithFallback: 16, coverage: 'partial' });
    expect(calls).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();
    const metadata = reads.filter(
      (read) => read.method === 'all' && /\bfrom\s+capability_calls\b/i.test(read.sql)
    );
    expect(metadata.length).toBeGreaterThan(0);
    for (const read of metadata) {
      expect(read.rows.length).toBeLessThanOrEqual(17);
      expect(read.plan.some((detail) => detail.includes('capability_calls_turn_family_idx'))).toBe(
        true
      );
      expect(
        read.rows.some((row) =>
          Object.values(row).some(
            (value) => typeof value === 'string' && value.includes('openkit.gateway/routeLineage')
          )
        )
      ).toBe(false);
    }
    const routeBodies = reads.filter(
      (read) => read.method === 'get' && /\bfrom\s+capability_calls\b/i.test(read.sql)
    );
    expect(routeBodies.length).toBeLessThanOrEqual(16);
  }, 30_000);

  it('uses only 32 measurements plus lookahead from one call without guessing a complete total', async () => {
    const f = await fixture();
    const call = await f.call();
    const rows = Array.from(
      { length: 33 },
      (_, index): UsageMeasurementInput => ({
        category: 'llm',
        unit: 'tokens',
        source: 'llm-gateway-adapter-reported:total',
        quantity: 1,
        providerModel: `private-metered-model-${index}`,
      })
    );
    const ids = [
      ...(await f.usage(call, rows.slice(0, 20))),
      ...(await f.usage(call, rows.slice(20))),
    ];
    // Distinct recorded serving models avoid the producer's legitimate equivalent-measurement deduplication.
    expect(new Set(ids).size).toBe(33);
    await f.read();
    const reads = observeLedgerReads();
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expectMeasurements(run.usage, [
      {
        category: 'llm',
        unit: 'tokens',
        source: 'llm-gateway-adapter-reported:total',
        quantity: 32,
      },
    ]);
    expect(JSON.stringify(run)).not.toContain('private-metered-model');
    const measurements = reads.filter(
      (read) => read.method === 'all' && /\bfrom\s+usage_records\b/i.test(read.sql)
    );
    expect(measurements.length).toBeGreaterThan(0);
    for (const read of measurements) {
      expect(read.rows.length).toBeLessThanOrEqual(33);
      expect(read.plan.some((detail) => detail.includes('usage_records_capability_call_idx'))).toBe(
        true
      );
    }
  }, 30_000);

  it.each([64, 65])(
    'bounds a route with %i genuine attempt entries without mistaking an omitted final member for no fallback',
    async (count) => {
      const f = await fixture();
      await f.lineage(
        await f.call(),
        Array.from({ length: count }, (_, index) =>
          attempt(index === count - 1 ? 'last-member' : 'first-member', index, index)
        )
      );
      const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
      if (count === 64)
        expect(run.fallback).toEqual({ callsWithFallback: 1, coverage: 'complete' });
      else expect(run.fallback).toBeNull();
    },
    30_000
  );

  it('omits an oversized route body but retains other known route evidence and measured usage', async () => {
    const f = await fixture();
    await f.lineage(await f.call(), [attempt('member-a'), attempt('member-b', 1)]);
    const large = await f.call();
    await f.lineage(large, [{ ...attempt('large-member'), selectionReason: 'x'.repeat(70_000) }]);
    await f.usage(large, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
    ]);
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.fallback).toEqual({ callsWithFallback: 1, coverage: 'partial' });
    expectMeasurements(run.usage, [
      { category: 'llm', unit: 'tokens', source: 'gateway-observed', quantity: 7 },
    ]);
  }, 30_000);

  it('applies the 64 KiB route-body budget across the run rather than separately to each call', async () => {
    const f = await fixture();
    for (let index = 0; index < 2; index++)
      await f.lineage(await f.call(), [
        { ...attempt('member-a'), selectionReason: 'x'.repeat(40_000) },
        attempt('member-b', 1),
      ]);
    await f.read();
    const reads = observeLedgerReads();
    expect((await f.read()).runs.find((run) => run.id === f.turn.id)!.fallback).toEqual({
      callsWithFallback: 1,
      coverage: 'partial',
    });
    const routeBodies = reads.filter((read) => /\bfrom\s+capability_calls\b/i.test(read.sql));
    const returnedBytes = routeBodies
      .flatMap((read) => read.rows)
      .flatMap((row) => Object.values(row))
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.includes('openkit.gateway/routeLineage')
      )
      .reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8'), 0);
    expect(returnedBytes).toBeLessThanOrEqual(65_536);
  }, 30_000);

  it('preserves an exact 96-byte UTF-8 source and omits an oversized qualifier with its whole measurement', async () => {
    const f = await fixture();
    const exact = 'é'.repeat(48),
      oversized = 'é'.repeat(49);
    await f.usage(await f.call(), [
      { category: 'llm', unit: 'tokens', source: exact, quantity: 7 },
      { category: 'llm', unit: 'tokens', source: oversized, quantity: 700 },
    ]);
    expectMeasurements((await f.read()).runs.find((run) => run.id === f.turn.id)!.usage, [
      { category: 'llm', unit: 'tokens', source: exact, quantity: 7 },
    ]);
  }, 30_000);

  it('bounds metric groups without inventing a combined metric for distinct qualifiers', async () => {
    const f = await fixture();
    const rows = Array.from(
      { length: 10 },
      (_, index): Measurement => ({
        category: 'llm',
        unit: 'tokens',
        source: `fixture-source-${index}`,
        quantity: index + 1,
      })
    );
    await f.usage(await f.call(), rows);
    const usage = (await f.read()).runs.find((run) => run.id === f.turn.id)!.usage!;
    expect(usage.coverage).toBe('partial');
    expect(usage.measurements.length).toBeGreaterThan(0);
    expect(usage.measurements.length).toBeLessThanOrEqual(8);
    for (const measured of usage.measurements) expect(rows).toContainEqual(measured);
  }, 30_000);

  it('bounds serialized new facts and drops whole escaped qualifiers instead of clipping or relabeling them', async () => {
    const f = await fixture();
    const rows = Array.from(
      { length: 8 },
      (_, index): Measurement => ({
        category: 'llm',
        unit: 'tokens',
        source: `${index}:${'\\'.repeat(94)}`,
        quantity: index + 1,
      })
    );
    for (const row of rows) expect(Buffer.byteLength(row.source!, 'utf8')).toBe(96);
    await f.usage(await f.call(), rows);
    const run = (await f.read()).runs.find((run) => run.id === f.turn.id)!;
    expect(run.usage!.measurements.length).toBeGreaterThan(0);
    expect(run.usage!.measurements.length).toBeLessThan(rows.length);
    for (const measured of run.usage!.measurements) expect(rows).toContainEqual(measured);
    expect(
      Buffer.byteLength(JSON.stringify({ usage: run.usage, fallback: run.fallback }), 'utf8')
    ).toBeLessThanOrEqual(1024);
    expect(run.usage!.coverage).toBe('partial');
  }, 30_000);
});
