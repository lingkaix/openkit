import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { DEMO_WORKSPACE_ID, DEMO_THREAD_ID } from '../test-support/demo-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { AutomationStore } from '../lib/automation-store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { prepareRecurringOccurrence } from './recurring-schedule-preparation.js';

const fixtures: { root: string; db: CoreDb }[] = [];
afterEach(() => {
  for (const { root, db } of fixtures.splice(0)) {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Uses the real current setup resolver and durable occurrence without a Worker backend. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recurrence-preparation-'));
  const db = openCoreDb(root);
  fixtures.push({ root, db });
  applyMigrations(db);
  const store = createDemoStore({ dataRoot: root });
  const thread = store.createThread(DEMO_WORKSPACE_ID, 'Recurring preparation');
  const schedules = new AutomationStore(
    db,
    new WorkspaceMutationAdmission(),
    () => '2026-10-16T00:00:00.000Z'
  );
  const schedule = schedules.createAutomation(FIXTURE_LOCAL_USER_ID, {
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    name: 'Inspect',
    prompt: 'Inspect status',
    intervalSeconds: 5,
  });
  schedules.updateAutomation(FIXTURE_LOCAL_USER_ID, schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const occurrence = schedules.collectScanCandidates('2026-10-16T00:00:00.000Z')[0]!;
  const manifest = createTestAgentSetup().manifest;
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: root,
    openKitConfig: { defaults: { defaultAgentId: manifest.id } },
    agentManifests: [manifest],
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Local fixture',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
        modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
      },
    ]),
  });
  return { store, occurrence, snapshot, db };
}

it('resolves an exact current selection without queue, Turn or runtime effects', async () => {
  const { store, occurrence, snapshot, db } = fixture();
  const before = store.listThreadTurns(occurrence.workspaceId, occurrence.snapshot.threadId);
  const result = await prepareRecurringOccurrence({
    occurrence,
    snapshot,
    store,
    backendId: 'backend_fixture',
  });
  expect(result).toEqual({
    kind: 'ready',
    payload: {
      backendId: 'backend_fixture',
      requestedAgentId: snapshot.agentManifests[0]!.id,
      profileRef: 'default',
      modelId: 'openai/gpt-5.2',
      workspaceCwd: null,
      workspaceRoots: [],
    },
  });
  expect(store.listThreadTurns(occurrence.workspaceId, occurrence.snapshot.threadId)).toEqual(
    before
  );
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
});

it('refuses unavailable supply and never substitutes after a selection is frozen', async () => {
  const { store, occurrence, snapshot } = fixture();
  const result = await prepareRecurringOccurrence({
    occurrence,
    snapshot,
    store,
    backendId: 'backend_fixture',
  });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected initial exact selection.');
  const frozen = { ...occurrence, resolvedPayload: result.payload };
  expect(
    await prepareRecurringOccurrence({ occurrence: frozen, snapshot, store, backendId: null })
  ).toEqual({ kind: 'failure', code: 'scheduler_unavailable' });
  expect(
    await prepareRecurringOccurrence({
      occurrence: frozen,
      snapshot,
      store,
      backendId: 'replacement',
    })
  ).toEqual({ kind: 'failure', code: 'selection_unavailable' });
  const replacement = createTestAgentSetup({ agentId: 'different-worker' }).manifest;
  expect(
    await prepareRecurringOccurrence({
      occurrence: frozen,
      snapshot: { ...snapshot, agentManifests: [replacement] },
      store,
      backendId: 'backend_fixture',
    })
  ).toEqual({ kind: 'failure', code: 'selection_unavailable' });
  expect(
    await prepareRecurringOccurrence({
      occurrence: frozen,
      snapshot: { ...snapshot, gatewayConfig: { ...snapshot.gatewayConfig, logicalModels: [] } },
      store,
      backendId: 'backend_fixture',
    })
  ).toEqual({ kind: 'failure', code: 'selection_unavailable' });
});
