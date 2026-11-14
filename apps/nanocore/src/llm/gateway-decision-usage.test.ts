import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  finishCapabilityCall,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createTestWorkspaceDb, disposeTestStore } from '../test-support/store.js';
import { requestGatewayDecision } from './gateway-decision.js';
import { GatewayUsageTracker } from './gateway-usage.js';
import type { ResolvedLogicalModel } from './logical-models.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

const networkGuard = vi.hoisted(() => {
  const state = { attempts: 0, original: globalThis.fetch };
  globalThis.fetch = async () => {
    state.attempts++;
    throw new Error('Unexpected global network transport in usage oracle');
  };
  return state;
});

const documented = JSON.parse(
  readFileSync(new URL('./gateway-decision.fixture.json', import.meta.url), 'utf8')
);
const secret = 'synthetic-usage-provider-secret';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  const attempts = networkGuard.attempts;
  networkGuard.attempts = 0;
  expect(attempts, 'Native usage proof must not contact a real Provider').toBe(0);
});
afterAll(() => {
  globalThis.fetch = networkGuard.original;
});

/** Admits distinct primary and auxiliary calls through the actual native ledger owner. */
async function fixture(
  usage: unknown = documented.native.usage,
  remote: { hold?: Promise<void>; onStarted?: () => void; refuse?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-decision-usage-'));
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Auxiliary decision usage');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'An actual Turn', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const workspaceDb = createTestWorkspaceDb(root, DEMO_WORKSPACE_ID);
  const common = {
    workspaceDb,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    turnId: turn.id,
    family: 'llm' as const,
    redactionClass: 'metadata-only' as const,
  };
  const primary = await startCapabilityCall({
    ...common,
    authorityActor: {
      kind: 'agent',
      id: 'primary-worker',
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
    },
    agentId: 'primary-worker',
    capabilityId: 'llm.responses',
    operation: 'responses',
  });
  const reviewer = {
    kind: 'agent' as const,
    id: 'security-review-agent',
    responsibleUserId: FIXTURE_LOCAL_USER_ID,
  };
  const decision = await startCapabilityCall({
    ...common,
    authorityActor: reviewer,
    agentId: reviewer.id,
    capabilityId: 'llm.decision',
    operation: 'decision',
  });
  let observed: Awaited<ReturnType<typeof requestGatewayDecision>> | undefined;
  cleanups.push(async () => {
    await finishCapabilityCall({ workspaceDb, callId: primary.id, status: 'aborted' });
    await finishCapabilityCall({
      workspaceDb,
      callId: decision.id,
      status: observed ? (observed.metric.kind === 'failure' ? 'failed' : 'succeeded') : 'aborted',
    });
    await disposeTestStore(root, workspaceDb);
    rmSync(root, { recursive: true, force: true });
  });
  const logicalModel: ResolvedLogicalModel = {
    id: 'independent-review-model',
    displayName: 'Independent review',
    modelFamilyId: null,
    capabilities: [],
    autoFailover: false,
    contextManagement: { type: 'compaction', compactThreshold: 8000 },
    routes: [
      {
        id: 'review-member',
        providerProfileId: 'review-provider',
        providerModel: 'gpt-6-luna',
        available: true,
        unavailableReason: null,
      },
    ],
  };
  const provider: ResolvedLLMProviderConfig = {
    id: 'review-provider',
    displayName: 'Review provider',
    adapterId: 'openai',
    apiKey: secret,
    baseUrl: 'https://usage.example.invalid/v1',
    models: ['gpt-6-luna'],
    requiresApiKey: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native', decisions: 'native' },
    modelMetadata: { 'gpt-6-luna': { limit: { context: 32768, output: 1024 } } },
  };
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(await new Request(input, init).text());
    remote.onStarted?.();
    if (remote.hold) await remote.hold;
    const response = structuredClone(documented.native);
    if (remote.refuse) response.answers = [{ type: 'refusal', name: 'verdict' }];
    if (usage === undefined) delete response.usage;
    else response.usage = usage;
    return Response.json(response);
  };
  const tracker = new GatewayUsageTracker();
  const dispatcher = new LLMGatewayProviderDispatcher({
    piAiClient: new PiAiGatewayClient({ fetch }),
    usageTracker: tracker,
  });
  const run = async (options: { deadline?: number } = {}) => {
    observed = await requestGatewayDecision(
      {
        ...options,
        logicalModel,
        routeId: 'review-member',
        mode: 'native',
        ledger: { workspaceDb, call: decision },
        signal: new AbortController().signal,
        assertAuthority: () => {},
        action: {
          principal: { kind: 'agent', id: reviewer.id },
          onBehalfOf: FIXTURE_LOCAL_USER_ID,
          operation: 'knowledge.publish',
          target: {
            kind: 'container',
            container: {
              kind: 'workspace',
              id: DEMO_WORKSPACE_ID,
              owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
            },
          },
          destinationAudience: [FIXTURE_LOCAL_USER_ID],
          influenceSources: ['import:synthetic-source'],
        },
      },
      { dispatcher, resolveGatewayProvider: () => provider }
    );
    return observed;
  };
  return { workspaceDb, turn, primary, decision, reviewer, logicalModel, requests, tracker, run };
}

it('persists only observed auxiliary decision consumption under the admitted reviewer call and exact Turn', async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.decision).toBe('allow');
  expect(result.capabilityCallId).toBe(f.decision.id);
  expect(f.decision.id).not.toBe(f.primary.id);
  expect(f.requests).toHaveLength(1);
  const calls = listWorkspaceCapabilityCalls(f.workspaceDb, DEMO_WORKSPACE_ID);
  expect(calls.find((call) => call.id === f.decision.id)).toMatchObject({
    capabilityId: 'llm.decision',
    family: 'llm',
    operation: 'decision',
  });
  expect(calls.find((call) => call.id === f.primary.id)).toMatchObject({
    capabilityId: 'llm.responses',
    operation: 'responses',
  });
  const rows = listWorkspaceUsageRecords(f.workspaceDb, DEMO_WORKSPACE_ID);
  const measured = rows.filter((row) => row.capabilityCallId === f.decision.id);
  expect(measured.length).toBeGreaterThan(0);
  expect(measured.map((row) => row.id).sort()).toEqual([...result.usageRecordIds].sort());
  expect(rows.filter((row) => row.capabilityCallId === f.primary.id)).toEqual([]);
  for (const row of measured)
    expect(row).toMatchObject({
      workspaceId: DEMO_WORKSPACE_ID,
      turnId: f.turn.id,
      agentId: f.reviewer.id,
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
      category: 'llm',
      modelId: f.logicalModel.id,
      providerRef: 'review-provider',
      providerModel: 'gpt-6-luna',
    });
  expect(
    measured.filter((row) => row.unit === 'tokens').reduce((sum, row) => sum + row.quantity, 0)
  ).toBe(20);
  expect(measured.some((row) => row.unit === 'tokens' && row.quantity === 0)).toBe(false);
  const audit = listWorkspaceAuditEvents(f.workspaceDb, DEMO_WORKSPACE_ID);
  expect(JSON.stringify({ requests: f.requests, result, calls, rows, audit })).not.toContain(
    secret
  );
});

it('preserves nested native cache-write and cache-read observations without adding them twice to inclusive input', async () => {
  const f = await fixture({
    input_tokens: 13,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens: 7,
    total_tokens: 20,
  });
  const result = await f.run();
  expect(result.decision).toBe('allow');
  const rows = listWorkspaceUsageRecords(f.workspaceDb, DEMO_WORKSPACE_ID).filter(
    (row) => row.capabilityCallId === f.decision.id
  );
  expect(
    rows.find((row) => row.source === 'llm-gateway-adapter-reported:cache_read')
  ).toMatchObject({ unit: 'tokens', quantity: 3 });
  expect(
    rows.find((row) => row.source === 'llm-gateway-adapter-reported:cache_write')
  ).toMatchObject({ unit: 'tokens', quantity: 2 });
  expect(f.tracker.snapshot().summaries).toEqual([
    expect.objectContaining({
      endpoint: 'decision',
      inputTokens: 13,
      completionTokens: 7,
      totalTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    }),
  ]);
  expect(rows.filter((row) => row.unit === 'usd')).toEqual([]);
});

it('retains actual observed native usage when the documented verdict is a refusal', async () => {
  const f = await fixture(documented.native.usage, { refuse: true });
  const result = await f.run();
  expect(result).toMatchObject({
    decision: 'escalate',
    metric: { kind: 'failure', code: 'refusal' },
  });
  const rows = listWorkspaceUsageRecords(f.workspaceDb, DEMO_WORKSPACE_ID).filter(
    (row) => row.capabilityCallId === f.decision.id
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map((row) => row.id).sort()).toEqual([...result.usageRecordIds].sort());
  expect(
    rows.filter((row) => row.unit === 'tokens').reduce((sum, row) => sum + row.quantity, 0)
  ).toBe(20);
  for (const row of rows)
    expect(row).toMatchObject({
      turnId: f.turn.id,
      agentId: f.reviewer.id,
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
    });
  expect(f.requests).toHaveLength(1);
});

it('records a late native observation after timeout without allowing that response to replace escalation', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const remoteStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(documented.native.usage, { hold, onStarted: started });
  let terminal: Awaited<ReturnType<typeof requestGatewayDecision>> | undefined;
  const reading = f.run().then((result) => {
    terminal = result;
    return result;
  });
  try {
    await Promise.race([remoteStarted, reading]);
    expect(f.requests).toHaveLength(1);
    await expect
      .poll(() => terminal?.metric, { timeout: 3000, interval: 20 })
      .toEqual({ kind: 'failure', code: 'timeout' });
    expect(terminal!.decision).toBe('escalate');
    expect(
      listWorkspaceUsageRecords(f.workspaceDb, DEMO_WORKSPACE_ID).filter(
        (row) => row.capabilityCallId === f.decision.id && row.unit === 'tokens'
      )
    ).toEqual([]);
    release();
    await expect
      .poll(
        () =>
          listWorkspaceUsageRecords(f.workspaceDb, DEMO_WORKSPACE_ID)
            .filter((row) => row.capabilityCallId === f.decision.id && row.unit === 'tokens')
            .reduce((sum, row) => sum + row.quantity, 0),
        { timeout: 2000, interval: 20 }
      )
      .toBe(20);
    expect(terminal).toMatchObject({
      decision: 'escalate',
      metric: { kind: 'failure', code: 'timeout' },
    });
    expect(f.requests).toHaveLength(1);
  } finally {
    release();
    await reading;
  }
}, 10_000);

it('does not treat unknown Provider consumption as fabricated zero tokens or successful review', async () => {
  // null omits actual token quantities without substituting an observed-zero report.
  const f = await fixture(null);
  const result = await f.run();
  expect(result).toMatchObject({
    decision: 'escalate',
    metric: { kind: 'failure', code: 'usage_unavailable' },
  });
  const rows = listWorkspaceUsageRecords(f.workspaceDb, DEMO_WORKSPACE_ID).filter(
    (row) => row.capabilityCallId === f.decision.id
  );
  expect(rows.filter((row) => row.unit === 'tokens')).toEqual([]);
  for (const row of rows) expect(row.unit).toBe('requests');
  expect(f.requests).toHaveLength(1);
});
