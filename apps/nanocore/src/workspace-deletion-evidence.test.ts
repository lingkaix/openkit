import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { insertExternalTriggerAdmission } from './storage/external-trigger-admissions.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  createWorkspaceDeletionClosure,
  existingWorkspaceDeletionClosureRoot,
  verifyWorkspaceDeletionClosure,
} from './workspace-deletion-evidence.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

it('verifies extended descriptive closure bytes after reopen while inventory and requirements stay exact', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-closure-extensions-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Closure annotations');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const input = {
      coreDb,
      dataRoot,
      workspaceId: workspace.id,
      repositoryWorkspaceDb: (workspaceId: string) => {
        const db = openWorkspaceDb(dataRoot, workspaceId);
        applyScopedMigrations(db);
        return db;
      },
      requestId: '00000000-0000-4000-8000-000000000001',
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      sourceRegistryRevision: 1,
      closureId: 'wsclose_extended',
      cutoffTimestamp: '2026-10-06T00:00:00.000Z',
      recoveryExportId: 'wsexp_00000000-0000-706a-b20c-a6a21d73aae2',
      recoveryExportManifestDigest: `sha256:${'a'.repeat(64)}`,
    };
    const baseline = createWorkspaceDeletionClosure(input);
    const closureRoot = existingWorkspaceDeletionClosureRoot(
      dataRoot,
      workspace.id,
      input.closureId
    );
    const path = join(closureRoot, 'workspace-closure.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.annotation = 'closure';
    raw.lineage.annotation = 'lineage';
    const bytes = `${JSON.stringify(raw)}\n`;
    writeFileSync(path, bytes);
    const read = verifyWorkspaceDeletionClosure({ ...input, closureRoot });
    expect(read).not.toHaveProperty('annotation');
    expect(read.lineage).not.toHaveProperty('annotation');
    expect(read.contentDigest).toBe(baseline.contentDigest);
    expect(read.manifestDigest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toEqual(read);
    raw.contentInventory[0].annotation = 'inventory';
    writeFileSync(path, JSON.stringify(raw));
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toThrow(
      /Unrecognized key/
    );
    delete raw.contentInventory[0].annotation;
    raw.requiredFeatures = ['unsupported.closure.v1'];
    writeFileSync(path, JSON.stringify(raw));
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toThrow(
      /required feature/
    );
    raw.requiredFeatures = [];
    raw.lineage.workspaceId = 'ws_00000000-0000-769e-b6a6-c9fdf1f7d7d9';
    writeFileSync(path, JSON.stringify(raw));
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toThrow(
      /contradictory/
    );
  } finally {
    coreDb.sqlite.close();
  }
});

it('retains the immutable external admission join in deletion evidence before its Core rows are purged', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-external-event-closure-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('External event closure');
    const actorId = 'usr_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actorId, workspaceId: workspace.id });
    const pollThread = store.createThread(workspace.id, 'Poll');
    const instant = '2026-10-18T00:00:00.000Z';
    const schedules = new AutomationStore(coreDb, new WorkspaceMutationAdmission(), () => instant);
    const schedule = schedules.createAutomation(actorId, {
      workspaceId: workspace.id,
      threadId: pollThread.id,
      name: 'Poll',
      prompt: 'Read selected source.',
      intervalSeconds: 30,
    });
    schedules.updateAutomation(actorId, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    const occurrence = schedules.collectScanCandidates(instant)[0]!;
    const accepted = schedules.commitAttempt(occurrence.id, 2, {
      kind: 'ready',
      payload: {
        backendId: 'nanohost',
        requestedAgentId: 'closure-worker',
        profileRef: null,
        modelId: 'closure-model',
        workspaceRoots: [],
        workspaceCwd: null,
      },
    })!;
    const target = store.createThread(workspace.id, 'Case', undefined, 'conversation', {
      visibility: 'workspace',
      threadSource: 'worker',
      parentThreadId: pollThread.id,
    });
    const retained = coreDb.sqlite.transaction(() => {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'closure-case-queue',
        backendId: 'nanohost',
        requestedAgentId: 'closure-worker',
        workspaceId: workspace.id,
        threadId: target.id,
        turnId: testEntityId('tu', 'tu_closure_case'),
        turnInput: 'One case.',
        triggerActor: schedule.actor,
      });
      return insertExternalTriggerAdmission(coreDb, {
        scheduleId: schedule.id,
        eventKey: 'source/message-1',
        sourceTurnId: accepted.turnId!,
        queueEntryId: entry.queueEntryId,
      });
    })();
    const input = {
      coreDb,
      dataRoot,
      workspaceId: workspace.id,
      repositoryWorkspaceDb: (workspaceId: string) => {
        const db = openWorkspaceDb(dataRoot, workspaceId);
        applyScopedMigrations(db);
        return db;
      },
      requestId: '00000000-0000-4000-8000-000000000002',
      originalOwnerUserId: actorId,
      sourceRegistryRevision: 1,
      closureId: 'wsclose_event',
      cutoffTimestamp: instant,
      recoveryExportId: 'wsexp_00000000-0000-706a-b20c-a6a21d73aae2',
      recoveryExportManifestDigest: `sha256:${'a'.repeat(64)}`,
    };
    createWorkspaceDeletionClosure(input);
    const closureRoot = existingWorkspaceDeletionClosureRoot(
      dataRoot,
      workspace.id,
      input.closureId
    );
    const captured = JSON.parse(
      readFileSync(join(closureRoot, 'records/recurring-history.jsonl'), 'utf8')
    );
    expect(captured.sources[0].externalAdmissions).toEqual([retained]);
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).not.toThrow();
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
