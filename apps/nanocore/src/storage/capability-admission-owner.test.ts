import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  openTestNativeWorkspace,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

const databases: WorkspaceDb[] = [];
const roots: string[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of databases.splice(0)) closeTestCoreDb(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates migrated owners and a real Workspace initiator, without manufacturing ledger rows. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'capability-admission-owner-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const db = openWorkspaceDb(root, workspaceId);
  databases.push(db);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  const coreDb = createTestCoreDb(root);
  try {
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
    const input = {
      workspaceDb: db,
      workspaceId,
      authorityActor: { kind: 'user' as const, id: userId },
      capabilityId: 'llm.responses',
      family: 'llm' as const,
      operation: 'responses.create',
      redactionClass: 'metadata-only',
      requestId: '00000000-0000-4000-8000-000000000001',
      sourceIds: ['repo_beta', 'repo_alpha', 'repo_beta'],
      schemaSnapshotId: `sha256:${'a'.repeat(64)}`,
    };
    return { db, input };
  } finally {
    closeTestCoreDb(coreDb);
  }
}

/** Reads complete original rows because public projections can omit retained fields. */
function retained(db: WorkspaceDb) {
  return {
    calls: db.sqlite.prepare('SELECT * FROM capability_calls ORDER BY call_id').all(),
    audits: db.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all(),
    usage: db.sqlite.prepare('SELECT * FROM usage_records ORDER BY usage_id').all(),
  };
}

describe('Workspace capability admission owner', { concurrent: false }, () => {
  it('rolls back the inserted Call when its actual linked admission Audit fails, with no success ACK', async () => {
    const { db, input } = fixture();
    await openTestNativeWorkspace(db);
    // Audit/Usage spec, AuditEvent: admission Call and linked Audit share one transaction.
    // Fire only after the actual inserted Call exists, not at validation or transport admission.
    db.sqlite.exec(`CREATE TRIGGER refuse_workspace_admission_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'capability.admit' AND EXISTS (
        SELECT 1 FROM capability_calls WHERE call_id = NEW.capability_call_id
      )
      BEGIN SELECT RAISE(ABORT, 'injected Workspace admission Audit failure'); END`);
    db.sqlite.pragma('query_only = ON');

    await expect(Promise.resolve().then(() => startCapabilityCall(input))).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(listWorkspaceCapabilityCalls(db, db.workspaceId)).toEqual([]);
    expect(listWorkspaceAuditEvents(db, db.workspaceId)).toEqual([]);
    expect(listWorkspaceUsageRecords(db, db.workspaceId)).toEqual([]);
    expect(retained(db)).toEqual({ calls: [], audits: [], usage: [] });

    db.sqlite.pragma('query_only = OFF');
    db.sqlite.exec('DROP TRIGGER refuse_workspace_admission_audit');
    db.sqlite.pragma('query_only = ON');
    const call = await startCapabilityCall(input);
    expect(call.inserted).toBe(true);
    expect(listWorkspaceCapabilityCalls(db, db.workspaceId)).toEqual([
      expect.objectContaining({ id: call.id, status: 'running' }),
    ]);
    expect(listWorkspaceAuditEvents(db, db.workspaceId)).toEqual([
      expect.objectContaining({
        action: 'capability.admit',
        capabilityCallId: call.id,
        actor: input.authorityActor,
        outcome: 'unknown',
      }),
    ]);
  });

  it('replays without a new admission Audit and preserves all rows on owner, attribution or format refusal', async () => {
    const { db, input } = fixture();
    await openTestNativeWorkspace(db);
    db.sqlite.pragma('query_only = ON');
    const first = await startCapabilityCall(input);
    const original = retained(db);
    expect(original.calls).toHaveLength(1);
    expect(original.audits).toHaveLength(1);

    // The database owner, not an incoming Workspace id, decides the durable home.
    await expect(
      Promise.resolve().then(() =>
        startCapabilityCall({ ...input, workspaceId: allocateEntityId('ws') })
      )
    ).rejects.toThrow();
    expect(retained(db)).toEqual(original);

    // An exact recorder replay is not public Gateway execution authority. Gateway has its own
    // single-use/no-contact witnesses in gateway-lineage.test.ts. This fault proves no new Audit.
    db.sqlite.pragma('query_only = OFF');
    db.sqlite.exec(`CREATE TRIGGER refuse_replay_admission_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'capability.admit'
      BEGIN SELECT RAISE(ABORT, 'replay must not invent admission Audit'); END`);
    db.sqlite.pragma('query_only = ON');
    const replay = await startCapabilityCall({
      ...input,
      callId: allocateEntityId('cap'),
      sourceIds: ['repo_alpha', 'repo_beta'],
    });
    expect(replay).toMatchObject({ id: first.id, inserted: false });
    expect(retained(db)).toEqual(original);

    // Capability lifecycle: schemaSnapshotId is immutable attribution, not a new request key.
    await expect(
      Promise.resolve().then(() =>
        startCapabilityCall({ ...input, schemaSnapshotId: `sha256:${'b'.repeat(64)}` })
      )
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect(retained(db)).toEqual(original);

    // Retained format must fail closed before replay or decoding corrupt optional content.
    db.sqlite.pragma('query_only = OFF');
    db.sqlite
      .prepare(
        "UPDATE capability_calls SET schema_version = 2, extensions_json = 'invalid-json' WHERE call_id = ?"
      )
      .run(first.id);
    db.sqlite.pragma('query_only = ON');
    const unsupported = retained(db);
    await expect(Promise.resolve().then(() => startCapabilityCall(input))).rejects.toThrow(
      TypeError
    );
    expect(retained(db)).toEqual(unsupported);
    expect(unsupported.audits).toEqual(original.audits);
  });
});
