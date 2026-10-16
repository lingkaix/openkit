import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openCoreDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { validateRecurringPortableHistory } from './recurring-portable-history.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';

it('exports exact recurring history and imports it as inert bytes across repeated transfer', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'recurrence-portable-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspace = store.listWorkspaces().find((entry) => entry.kind === 'code')!;
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: LOCAL_USER_ID,
    });
    const thread = store.createThread(workspace.id, 'Portable recurrence');
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
      prompt: 'Retained exact input',
      intervalSeconds: 5,
    });
    automationStore.updateAutomation(LOCAL_USER_ID, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    const occurrence = automationStore.collectScanCandidates(instant)[0]!;
    automationStore.commitAttempt(occurrence.id, 2, {
      kind: 'ready',
      payload: {
        backendId: 'retained-backend',
        requestedAgentId: 'retained-worker',
        profileRef: null,
        modelId: 'retained-model',
        workspaceRoots: [],
        workspaceCwd: null,
      },
    });
    instant = '2026-10-16T00:00:05.000Z';
    automationStore.collectScanCandidates(instant);
    const app = createApp({ coreDb, dataRoot, store, automationStore });
    const exportWorkspace = async (workspaceId: string) => {
      const response = await app.request(
        ...operationRequest('workspace.export', { workspaceId }, { method: 'POST' })
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const exported = WorkspaceExportResponseSchema.parse(await response.json());
      return {
        exported,
        verified: verifyWorkspaceExportTree({
          exportRoot: join(
            dataRoot,
            'server',
            'exports',
            'workspaces',
            workspaceId,
            exported.exportId
          ),
        }),
      };
    };
    const { exported, verified } = await exportWorkspace(workspace.id);
    const historyPath = 'workspace-files/imports/recurrence-history.json';
    const history = verified.fileContents.get(historyPath);
    expect(history).toBeDefined();
    validateRecurringPortableHistory(history!);
    const source = JSON.parse(history!).sources[0];
    expect(source).toMatchObject({
      workspaceId: workspace.id,
      schedules: [{ id: schedule.id, status: 'active' }],
      occurrences: expect.arrayContaining([
        expect.objectContaining({
          id: occurrence.id,
          scheduledAt: '2026-10-16T00:00:00.000Z',
          state: 'admission-accepted',
        }),
        expect.objectContaining({ scheduledAt: '2026-10-16T00:00:05.000Z', state: 'pending' }),
      ]),
    });
    expect(source.occurrences).toHaveLength(2);
    const response = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: workspace.id,
            exportId: exported.exportId,
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const imported = WorkspaceImportResponseSchema.parse(await response.json());
    expect(
      readFileSync(
        join(
          dataRoot,
          'workspaces',
          imported.importedWorkspaceId,
          'imports',
          'recurrence-history.json'
        ),
        'utf8'
      )
    ).toBe(history);
    for (const table of [
      'recurring_schedules',
      'recurring_occurrences',
      'recurring_expired_ranges',
      'scheduler_admission_entries',
    ])
      expect(
        coreDb.sqlite
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`)
          .get(imported.importedWorkspaceId)
      ).toEqual({ n: 0 });
    expect(
      store
        .listThreads(imported.importedWorkspaceId)
        .flatMap((entry) => store.listThreadTurns(imported.importedWorkspaceId, entry.id))
    ).toEqual([]);
    const repeated = await exportWorkspace(imported.importedWorkspaceId);
    expect(repeated.verified.fileContents.get(historyPath)).toBe(history);
    const unknown = JSON.parse(history!);
    unknown.sources[0].requiredFeatures = ['unknown-authority'];
    expect(() => validateRecurringPortableHistory(JSON.stringify(unknown))).toThrow();
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
