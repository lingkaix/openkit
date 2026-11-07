import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the real migrated owner; Main writes only fixture setup and explicit SQL faults. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'capability-call-updates-owner-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const itemId = allocateEntityId('it');
  let db = openWorkspaceDb(root, workspaceId);
  databases.push(db);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  const coreDb = createTestCoreDb(root);
  let actor: { kind: 'user'; id: string };
  try {
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
    actor = { kind: 'user', id: userId };
  } finally {
    closeTestCoreDb(coreDb);
  }
  const writer = getControlStoreWorkerClient();

  async function open() {
    db.sqlite.pragma('query_only = ON');
    await writer.open({
      database: workspaceId,
      path: db.sqlite.name,
      create: false,
      initialize: 'workspace',
      productOwner: { kind: 'workspace', workspaceId },
      dataRoot: root,
    });
  }

  async function admit() {
    await open();
    const call = await writer.capability(workspaceId, {
      kind: 'admit',
      workspaceId,
      now: new Date().toISOString(),
      context: {
        authorityActor: actor,
        itemId,
        family: 'mcp',
        operation: 'mcp.call-tool',
        capabilityId: 'mcp.call-tool',
        redactionClass: 'metadata-only',
        summary: 'before cache attribution',
      },
    });
    if (!call || typeof call !== 'object' || !('context' in call))
      throw new Error('Native admission did not return its original Call.');
    // Keep nonempty Usage in both terminal witnesses, rather than only checking an empty table.
    await writer.capability(workspaceId, {
      kind: 'usage-finish',
      workspaceId,
      call,
      usage: {
        records: [{ category: 'tool', unit: 'capability_calls', quantity: 1 }],
        now: new Date().toISOString(),
      },
    });
    return call;
  }

  function tuple() {
    return {
      calls: listWorkspaceCapabilityCalls(db, workspaceId),
      audit: listWorkspaceAuditEvents(db, workspaceId),
      usage: listWorkspaceUsageRecords(db, workspaceId),
    };
  }

  async function reopen() {
    await writer.close(workspaceId);
    db.sqlite.close();
    db = openWorkspaceDb(root, workspaceId);
    databases.push(db);
    await open();
  }

  return {
    get db() {
      return db;
    },
    workspaceId,
    itemId,
    writer,
    open,
    admit,
    tuple,
    reopen,
  };
}

describe('CapabilityCall update public native owner', { concurrent: false }, () => {
  it('acknowledges worker-cache attribution and retains only its owned changes after reopen', async () => {
    const f = fixture();
    const call = await f.admit();
    const before = f.tuple();
    const workerCache = {
      runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
      summary: 'cache attribution retained',
    };
    await expect(
      f.writer.capability(f.workspaceId, {
        kind: 'attribution',
        workspaceId: f.workspaceId,
        callId: call.id,
        workerCache,
      })
    ).resolves.toBeNull();
    const after = f.tuple();
    expect(after).toEqual({
      ...before,
      calls: [{ ...before.calls[0], ...workerCache }],
    });
    await f.reopen();
    expect(f.tuple()).toEqual(after);
  });

  it('clears the Item with terminal success and retains the Call, Audit and Usage after reopen', async () => {
    const f = fixture();
    const call = await f.admit();
    const before = f.tuple();
    expect(before.calls).toEqual([
      expect.objectContaining({ id: call.id, itemId: f.itemId, status: 'running' }),
    ]);
    expect(before.usage).toHaveLength(1);
    const now = new Date().toISOString();
    await expect(
      f.writer.capability(f.workspaceId, {
        kind: 'finish',
        workspaceId: f.workspaceId,
        callId: call.id,
        finish: { clearItem: true, status: 'succeeded', now },
      })
    ).resolves.toBeNull();
    const after = f.tuple();
    expect(after.calls).toEqual([
      { ...before.calls[0], itemId: null, status: 'succeeded', completedAt: now },
    ]);
    expect(after.usage).toEqual(before.usage);
    expect(after.audit.filter((row) => row.action !== 'capability.finish')).toEqual(before.audit);
    expect(after.audit.filter((row) => row.action === 'capability.finish')).toEqual([
      expect.objectContaining({
        capabilityCallId: call.id,
        action: 'capability.finish',
        outcome: 'succeeded',
        itemId: null,
      }),
    ]);
    await f.reopen();
    expect(f.tuple()).toEqual(after);
  });

  it('rolls back Item clearing on actual terminal SQL refusal, including after reopen', async () => {
    const f = fixture();
    const call = await f.admit();
    const before = f.tuple();
    expect(before.calls).toEqual([
      expect.objectContaining({ id: call.id, itemId: f.itemId, status: 'running' }),
    ]);
    expect(before.usage).toHaveLength(1);
    expect(before.audit.length).toBeGreaterThan(0);

    // Exclude the native writer for fixture mutation; ABORT refuses actual terminal SQL.
    await f.writer.close(f.workspaceId);
    f.db.sqlite.pragma('query_only = OFF');
    f.db.sqlite.exec(`
      CREATE TRIGGER refuse_call_update_terminal
      AFTER UPDATE OF completed_at ON capability_calls
      WHEN NEW.call_id = '${call.id}' AND NEW.completed_at IS NOT NULL
        AND NEW.item_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'call update terminal refusal after Item clear'); END
    `);
    await f.open();
    try {
      await expect(
        f.writer.capability(f.workspaceId, {
          kind: 'finish',
          workspaceId: f.workspaceId,
          callId: call.id,
          finish: { clearItem: true, status: 'succeeded', now: new Date().toISOString() },
        })
      ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      // The trigger can fire only after clear-Item and the terminal UPDATE both ran natively.
      expect(f.tuple()).toEqual(before);
      await f.reopen();
      expect(f.tuple()).toEqual(before);
    } finally {
      await f.writer.close(f.workspaceId);
      f.db.sqlite.pragma('query_only = OFF');
      f.db.sqlite.exec('DROP TRIGGER refuse_call_update_terminal');
      f.db.sqlite.pragma('query_only = ON');
    }
  });
});
