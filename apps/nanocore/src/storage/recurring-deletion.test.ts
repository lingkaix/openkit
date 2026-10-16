import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { readWorkspaceDeletionRequest } from '../workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openCoreDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

it('seals the complete recurring graph before deletion removes its Core rows and Audit', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'recurrence-deletion-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspace = store.createWorkspace('Recurring deletion');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: LOCAL_USER_ID,
    });
    const thread = store.createThread(workspace.id, 'Historical worker');
    let instant = '2026-10-16T00:00:00.000Z';
    const automationStore = new AutomationStore(
      coreDb,
      new WorkspaceMutationAdmission(),
      () => instant
    );
    const schedule = automationStore.createAutomation(LOCAL_USER_ID, {
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Inspect',
      prompt: 'Retained recurring input',
      intervalSeconds: 3600,
    });
    automationStore.updateAutomation(LOCAL_USER_ID, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    const occurrence = automationStore.collectScanCandidates(instant)[0]!;
    for (let attempt = 0; attempt < 3; attempt++)
      automationStore.commitAttempt(occurrence.id, 2, {
        kind: 'failure',
        code: 'selection_unavailable',
      });
    instant = '2026-10-16T03:10:00.000Z';
    automationStore.collectScanCandidates(instant);
    const before = ['recurring_schedules', 'recurring_occurrences', 'recurring_expired_ranges'].map(
      (table) =>
        (
          coreDb.sqlite
            .prepare(`SELECT record_json FROM ${table} WHERE workspace_id = ? ORDER BY id`)
            .all(workspace.id) as { record_json: string }[]
        ).map((row) => JSON.parse(row.record_json))
    );
    expect(before.every((records) => records.length > 0)).toBe(true);
    const requestId = randomUUID();
    const app = createApp({ coreDb, dataRoot, store, automationStore });
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId,
            expectedRegistryRevision: 1,
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const request = readWorkspaceDeletionRequest(dataRoot, workspace.id, requestId);
    const root = join(
      dataRoot,
      'server',
      'exports',
      'workspace-closures',
      workspace.id,
      request.closureId!
    );
    const manifest = JSON.parse(readFileSync(join(root, 'workspace-closure.json'), 'utf8'));
    expect(manifest.requiredFeatures).toContain('recurring-history-v1');
    const history = JSON.parse(
      readFileSync(join(root, 'records', 'recurring-history.jsonl'), 'utf8')
    );
    expect(history.sources).toEqual([
      {
        workspaceId: workspace.id,
        schedules: before[0],
        occurrences: before[1],
        expiredRanges: before[2],
      },
    ]);
    const audit = readFileSync(join(root, 'records', 'core-audit-events.jsonl'), 'utf8');
    expect(audit).toContain('recurring.expired-range.record');
    for (const table of [
      'recurring_schedules',
      'recurring_occurrences',
      'recurring_expired_ranges',
    ])
      expect(
        coreDb.sqlite
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`)
          .get(workspace.id)
      ).toEqual({ n: 0 });
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE workspace_id = ? AND action LIKE 'recurring.%'"
        )
        .get(workspace.id)
    ).toEqual({ n: 0 });
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
