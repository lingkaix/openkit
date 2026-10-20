// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { FsStore } from '../lib/store.js';
import {
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openCoreDbWithIntegrityCheck,
  openUserDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from '../storage/db.js';
import { coreDbPath, ensureLayout, userDbPath, workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  createBootReadinessSnapshot,
  isScopeAdmitted,
  refuseScope,
  scopeAdmissionFailures,
  withScopeAdmissionReadiness,
} from './readiness.js';

const roots: string[] = [];
/** Gives each fault a distinct process-local admission scope and retained tree. */
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'scope-admission-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const badId = 'ws_00000000-0000-7490-845b-dcfa3ee49925';
const goodId = 'ws_00000000-0000-73c3-900f-8d310e4ba201';

describe('scope-owned admission', () => {
  it.each([
    'absent',
    'empty',
  ] as const)('refuses %s expected server authority without an empty replacement', (fault) => {
    const dataRoot = root();
    const core = openCoreDb(dataRoot);
    applyMigrations(core);
    expect(ensureLocalUser(core)).toBeTruthy();
    core.sqlite.close();
    const markerPath = join(dataRoot, 'server', 'layout.json');
    const marker = readFileSync(markerPath);
    const path = coreDbPath(dataRoot);
    if (fault === 'absent') rmSync(path);
    else writeFileSync(path, '');
    let replacement: ReturnType<typeof openCoreDbWithIntegrityCheck> | undefined;
    try {
      expect(() => {
        replacement = openCoreDbWithIntegrityCheck(dataRoot);
      }).toThrow(/Core database is missing/);
      expect(existsSync(path)).toBe(fault === 'empty');
      if (fault === 'empty') expect(readFileSync(path)).toEqual(Buffer.alloc(0));
      expect(readFileSync(markerPath)).toEqual(marker);
    } finally {
      replacement?.sqlite.close();
    }
  });

  it.each([
    'corrupt',
    'missing',
    'empty',
  ] as const)('refuses Workspace database state %s without recreation', (fault) => {
    const dataRoot = root();
    for (const id of [badId, goodId]) {
      const db = openWorkspaceDb(dataRoot, id);
      applyScopedMigrations(db);
      db.sqlite.close();
    }
    const path = workspaceDbPath(dataRoot, badId);
    const damaged =
      fault === 'empty' ? Buffer.alloc(0) : Buffer.from('unreadable canonical Workspace authority');
    if (fault === 'missing') rmSync(path);
    else writeFileSync(path, damaged);

    expect(() => verifyAndMigrateExistingScopedDatabases(dataRoot)).not.toThrow();
    expect(isScopeAdmitted(dataRoot, 'workspace', badId)).toBe(false);
    expect(() => openBootVerifiedWorkspaceDb(dataRoot, badId)).toThrow('quarantined');
    expect(() => openWorkspaceDb(dataRoot, badId)).toThrow('quarantined');
    if (fault === 'missing') expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path)).toEqual(damaged);
    const good = openBootVerifiedWorkspaceDb(dataRoot, goodId);
    try {
      good.sqlite.exec(
        "CREATE TABLE sibling_proof (value TEXT); INSERT INTO sibling_proof VALUES ('usable')"
      );
      expect(good.sqlite.prepare('SELECT value FROM sibling_proof').pluck().get()).toBe('usable');
    } finally {
      good.sqlite.close();
    }
    const readiness = withScopeAdmissionReadiness(createBootReadinessSnapshot(), dataRoot);
    expect(readiness.acceptingProductWork).toBe(true);
    expect(readiness.subsystems.storage.state).toBe('degraded');
    expect(readiness.subsystems.storage.reasons).toEqual([
      expect.objectContaining({
        code: 'storage.scope-quarantined',
        blocks: [`workspace:${badId}`],
      }),
    ]);
  });

  it('loads healthy file history without publishing a corrupt sibling cache', () => {
    const dataRoot = root();
    const initial = new FsStore({ dataRoot });
    const good = initial.createWorkspace('Healthy history');
    const bad = initial.createWorkspace('Damaged history');
    const path = join(dataRoot, 'workspaces', bad.id, 'workspace-record.json');
    const damaged = '{not a canonical record';
    writeFileSync(path, damaged);
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getWorkspace(good.id).name).toBe('Healthy history');
    expect(reopened.listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
    expect(() => reopened.getWorkspace(bad.id)).toThrow('quarantined');
    expect(readFileSync(path, 'utf8')).toBe(damaged);
    expect(scopeAdmissionFailures(dataRoot)).toContainEqual({
      scope: 'workspace',
      id: bad.id,
      check: 'records',
    });
  });

  it('validates file authority before scoped migration or call-loss recovery writes', () => {
    const dataRoot = root();
    const initial = new FsStore({ dataRoot });
    const bad = initial.createWorkspace('Malformed file authority');
    const good = initial.createWorkspace('Healthy file authority');
    const callId = 'cap_00000000-0000-7800-b75d-def690d8fb88';
    for (const workspace of [bad, good]) {
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        startCapabilityCall({
          authorityActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
          callId,
          capabilityId: 'llm.responses',
          family: 'llm',
          operation: 'responses.create',
          redactionClass: 'metadata-only',
          requestId: '00000000-0000-4000-8000-000000000005',
          workspaceDb: db,
          workspaceId: workspace.id,
        });
      } finally {
        db.sqlite.close();
      }
    }
    const badDatabase = workspaceDbPath(dataRoot, bad.id);
    const before = readFileSync(badDatabase);
    writeFileSync(join(dataRoot, 'workspaces', bad.id, 'workspace-record.json'), '{bad history');
    verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
      FsStore.validateFileAuthority(dataRoot)
    );
    expect(isScopeAdmitted(dataRoot, 'workspace', bad.id)).toBe(false);
    expect(readFileSync(badDatabase)).toEqual(before);
    const healthy = openWorkspaceDb(dataRoot, good.id);
    try {
      expect(
        healthy.sqlite
          .prepare('SELECT status FROM capability_calls WHERE call_id = ?')
          .pluck()
          .get(callId)
      ).toBe('unknown');
    } finally {
      healthy.sqlite.close();
    }
  });

  it('contains an unreadable Workspace traversal without refusing its readable sibling', () => {
    const dataRoot = root();
    const initial = new FsStore({ dataRoot });
    const bad = initial.createWorkspace('Unreadable subtree');
    const good = initial.createWorkspace('Readable subtree');
    const badRoot = join(dataRoot, 'workspaces', bad.id);
    chmodSync(badRoot, 0);
    try {
      expect(() => ensureLayout(dataRoot)).not.toThrow();
      expect(scopeAdmissionFailures(dataRoot)).toContainEqual({
        scope: 'workspace',
        id: bad.id,
        check: 'layout',
      });
      expect(isScopeAdmitted(dataRoot, 'workspace', good.id)).toBe(true);
    } finally {
      chmodSync(badRoot, 0o700);
    }
  });

  it('validates files independently of approval SQL that needs an existing native migration', () => {
    const dataRoot = root();
    const initial = new FsStore({ dataRoot });
    const workspace = initial.createWorkspace('Earlier native schema');
    const current = openWorkspaceDb(dataRoot, workspace.id);
    const ledgerDdl = current.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE name = '__drizzle_migrations'")
      .pluck()
      .get() as string;
    current.sqlite.close();
    rmSync(workspaceDbPath(dataRoot, workspace.id));
    const earlier = openWorkspaceDb(dataRoot, workspace.id);
    const sql = readFileSync(
      new URL('../../drizzle/workspace/0000_setup.sql', import.meta.url),
      'utf8'
    );
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/workspace/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ when: number }> };
    try {
      earlier.sqlite.exec(sql);
      earlier.sqlite.exec(ledgerDdl);
      earlier.sqlite
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(createHash('sha256').update(sql).digest('hex'), journal.entries[0]!.when);
      expect(earlier.sqlite.prepare('PRAGMA table_info(pending_requests)').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'schema_version' })])
      );
    } finally {
      earlier.sqlite.close();
    }
    verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
      FsStore.validateFileAuthority(dataRoot)
    );
    expect(isScopeAdmitted(dataRoot, 'workspace', workspace.id)).toBe(true);
    expect(new FsStore({ dataRoot }).getWorkspace(workspace.id).name).toBe('Earlier native schema');
  });

  it('removes a later-refused Workspace from an already published Store listing', () => {
    const dataRoot = root();
    const store = new FsStore({ dataRoot });
    const bad = store.createWorkspace('Migration failure');
    const good = store.createWorkspace('Still admitted');
    const db = openWorkspaceDb(dataRoot, bad.id);
    try {
      db.sqlite.exec(
        'DROP TABLE __drizzle_migrations; CREATE VIEW __drizzle_migrations AS SELECT 1 AS invalid'
      );
    } finally {
      db.sqlite.close();
    }
    verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
      FsStore.validateFileAuthority(dataRoot)
    );
    expect(isScopeAdmitted(dataRoot, 'workspace', bad.id)).toBe(false);
    expect(store.listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
    expect(new FsStore({ dataRoot }).listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
  });

  it('excludes previously cached Items after a late Workspace refusal without changing history', () => {
    const dataRoot = root();
    const store = new FsStore({ dataRoot });
    const bad = store.createWorkspace('Refused aggregate source');
    const good = store.createWorkspace('Admitted aggregate source');
    const ids = new Map<string, string>();
    let badItemsPath = '';
    for (const workspace of [bad, good]) {
      const thread = store.createThread(workspace.id, 'Retained source');
      const turn = store.createTurn(
        workspace.id,
        thread.id,
        'Retained input',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null
      );
      const id = allocateEntityId('it');
      ids.set(workspace.id, id);
      const now = new Date().toISOString();
      store.createItem({
        id,
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: `ap_${id}`,
        kind: 'permission',
        title: workspace.name,
        description: 'Retained aggregate content.',
        createdAt: now,
        completedAt: now,
      });
      if (workspace.id === bad.id)
        badItemsPath = join(
          dataRoot,
          'workspaces',
          bad.id,
          'threads',
          thread.id,
          'turns',
          turn.id,
          'items.jsonl'
        );
    }
    expect(store.listAllItems().map(({ id }) => id)).toEqual(
      expect.arrayContaining([...ids.values()])
    );
    const before = readFileSync(badItemsPath);
    refuseScope(dataRoot, { scope: 'workspace', id: bad.id, check: 'database' });
    expect(() => store.getWorkspace(bad.id)).toThrow('quarantined');
    const aggregate = store.listAllItems();
    expect(aggregate.some(({ id }) => id === ids.get(bad.id))).toBe(false);
    expect(aggregate.some(({ id }) => id === ids.get(good.id))).toBe(true);
    expect(
      aggregate.every(
        (item) => item.owner.kind === 'workspace' && item.owner.workspaceId === good.id
      )
    ).toBe(true);
    expect(readFileSync(badItemsPath)).toEqual(before);
  });

  it('contains private User database loss without refusing a healthy Workspace', () => {
    const dataRoot = root();
    const userId = 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b';
    const user = openUserDb(dataRoot, userId);
    applyScopedMigrations(user);
    user.sqlite.close();
    const good = openWorkspaceDb(dataRoot, goodId);
    applyScopedMigrations(good);
    good.sqlite.close();
    const path = userDbPath(dataRoot, userId);
    const damaged = Buffer.from('unreadable private User authority');
    writeFileSync(path, damaged);
    expect(() => verifyAndMigrateExistingScopedDatabases(dataRoot)).not.toThrow();
    expect(isScopeAdmitted(dataRoot, 'workspace', goodId)).toBe(true);
    expect(() => openUserDb(dataRoot, userId)).toThrow('quarantined');
    expect(readFileSync(path)).toEqual(damaged);
  });
});
