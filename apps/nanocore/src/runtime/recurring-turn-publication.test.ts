// openkit-test-platform: posix
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { startRecurringScheduleService } from './recurring-schedule-service.js';
import { recurringTurnPublicationIssue } from './recurring-turn-publication.js';

const nodeFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

it.each([
  'openkit.work-observations.v1',
  'openkit.unsupported.v1',
])('checks the exact required Turn feature %s without changing metadata', (feature) => {
  const root = mkdtempSync(join(tmpdir(), 'recurring-feature-'));
  try {
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Required features');
    const thread = store.createThread(workspace.id, 'Target');
    const turn = store.createTurn(workspace.id, thread.id, 'Inspect metadata', {
      kind: 'user',
      id: 'user_local',
    });
    const path = join(
      root,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'turn.json'
    );
    const bytes = `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), requiredFeatures: [feature], futureDescription: 'Unconsumed descriptive metadata.' })}\n`;
    writeFileSync(path, bytes);
    if (feature === 'openkit.work-observations.v1') {
      expect(readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)?.turn.id).toBe(
        turn.id
      );
    } else {
      expect(() => readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)).toThrow(
        feature
      );
    }
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  'workspace',
  'thread',
  'turn',
] as const)('refuses a redirected canonical %s parent without reading its Turn', (boundary) => {
  const root = mkdtempSync(join(tmpdir(), 'recurring-parent-'));
  const outside = mkdtempSync(join(tmpdir(), 'recurring-parent-outside-'));
  try {
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Canonical source');
    const thread = store.createThread(workspace.id, 'Target');
    const turn = store.createTurn(workspace.id, thread.id, 'Retain exact bytes', {
      kind: 'user',
      id: 'user_local',
    });
    expect(readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)?.turn.id).toBe(
      turn.id
    );
    const workspacePath = join(root, 'workspaces', workspace.id);
    const threadPath = join(workspacePath, 'threads', thread.id);
    const turnPath = join(threadPath, 'turns', turn.id);
    const source =
      boundary === 'workspace' ? workspacePath : boundary === 'thread' ? threadPath : turnPath;
    const target = join(outside, 'retained');
    renameSync(source, target);
    symlinkSync(target, source, 'dir');
    expect(() => readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)).toThrow(
      /symbolic link/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it.each([
  'before-rename',
  'after-rename',
] as const)('reads actual recurring publication across a physical interruption %s', async (point) => {
  const root = mkdtempSync(join(tmpdir(), 'recurring-publication-'));
  const frozenRoot = mkdtempSync(join(tmpdir(), 'recurring-publication-frozen-'));
  const coreDb = openCoreDb(root);
  let recovered: ReturnType<typeof openCoreDb> | undefined;
  let service: ReturnType<typeof startRecurringScheduleService> | undefined;
  const rename = nodeFs.renameSync;
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Recurring publication');
    const thread = store.createThread(workspace.id, 'Existing target');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: 'user_local',
    });
    const gate = new WorkspaceMutationAdmission();
    const instant = '2026-10-16T00:00:00.000Z';
    const schedules = new AutomationStore(coreDb, gate, () => instant);
    const schedule = schedules.createAutomation('user_local', {
      workspaceId: workspace.id,
      threadId: thread.id,
      name: 'Inspect',
      prompt: 'Inspect',
      intervalSeconds: 5,
    });
    schedules.updateAutomation('user_local', schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    let faults = 0;
    // Freeze the entire native data root before the writer catch can run, including the committed Core WAL.
    nodeFs.renameSync = ((from, to) => {
      const source = String(from);
      if (basename(source).startsWith('record-') && basename(dirname(source)) === '.staging') {
        if (point === 'after-rename') rename(from, to);
        faults++;
        cpSync(root, frozenRoot, { recursive: true });
        throw new Error('Initial publication interrupted');
      }
      rename(from, to);
    }) as typeof nodeFs.renameSync;
    syncBuiltinESMExports();
    const create = vi.spyOn(store, 'createTurn');
    service = startRecurringScheduleService({
      schedules,
      store,
      now: () => instant,
      prepare: async () => ({
        kind: 'ready',
        payload: {
          backendId: 'modeled',
          requestedAgentId: 'worker',
          profileRef: null,
          modelId: 'exact-model',
          workspaceRoots: [],
          workspaceCwd: null,
        },
      }),
      setInterval: () => 'timer',
      clearInterval: () => {},
    });
    await service.runOnce();
    nodeFs.renameSync = rename;
    syncBuiltinESMExports();
    expect(faults).toBe(1);
    await service.runOnce();
    expect(create).toHaveBeenCalledTimes(1);
    service.stop();
    const accepted = schedules
      .listHistory(schedule.id)
      .items.find((entry) => entry.kind === 'occurrence')!.record;
    expect(accepted).toMatchObject({
      state: 'admission-accepted',
      attempts: [{ number: 1, code: 'accepted' }],
    });
    recovered = openCoreDb(frozenRoot);
    const restored = new AutomationStore(
      recovered,
      new WorkspaceMutationAdmission(),
      () => instant
    );
    expect(restored.getOccurrence(accepted.id)).toEqual(accepted);
    const freshStore = new FsStore({ dataRoot: frozenRoot });
    const fixed = requireSchedulerAdmissionEntry(recovered, accepted.queueEntryId!);
    const publish = vi.spyOn(freshStore, 'createTurn');
    const update = vi.spyOn(freshStore, 'updateTurn');
    expect(recurringTurnPublicationIssue(freshStore, fixed)).toBe(
      point === 'before-rename' ? 'turn_missing' : null
    );
    expect(publish).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  } finally {
    nodeFs.renameSync = rename;
    syncBuiltinESMExports();
    service?.stop();
    vi.restoreAllMocks();
    recovered?.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(frozenRoot, { recursive: true, force: true });
  }
});
