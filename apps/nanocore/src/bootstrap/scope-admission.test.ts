// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-products.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openCoreDbWithIntegrityCheck,
  openUserDb,
  openWorkspaceDb,
} from '../storage/db.js';
import { coreDbPath, ensureLayout, userDbPath, workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { verifyAndMigrateExistingScopedDatabases } from '../storage/workspace-storage-migration.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
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

/** Keeps SQLite integrity intact while replacing its native record with an invalid scalar. The writer is stopped first. */
function damageWorkspaceRecord(dataRoot: string, workspaceId: string, damaged: string): Buffer {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  try {
    expect(
      db.sqlite
        .prepare('UPDATE control_workspaces SET record_json = ? WHERE id = ?')
        .run(JSON.stringify(damaged), workspaceId).changes
    ).toBe(1);
  } finally {
    db.sqlite.close();
  }
  return readFileSync(workspaceDbPath(dataRoot, workspaceId));
}
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const badId = 'ws_00000000-0000-7490-845b-dcfa3ee49925';
const goodId = 'ws_00000000-0000-73c3-900f-8d310e4ba201';

/** Creates complete retained Knowledge predecessor bytes for one healthy Workspace boot fixture. */
function initializeWorkspaceKnowledgePredecessor(dataRoot: string, workspaceId: string): void {
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const knowledgeBaseId = testEntityId('kb', `scope-admission:${workspaceId}`);
  const configRoot = join(workspaceRoot, 'config');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, 'workspace.jsonc'),
    `${JSON.stringify(
      writeRetainedV1({
        workspace: {
          name: workspaceId,
          defaultAgentId: null,
          defaultKnowledgeBaseId: knowledgeBaseId,
          knowledgeMounts: [
            {
              name: 'managed',
              backend: 'local',
              root: 'raw',
              default: true,
              knowledgeBaseId,
            },
          ],
        },
      })
    )}\n`
  );
  const schemaRoot = join(workspaceRoot, 'knowledge', 'schema');
  mkdirSync(schemaRoot, { recursive: true });
  writeFileSync(join(schemaRoot, 'scope-schema.yaml'), DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
  new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  }).initialize({
    files: { 'index.md': DEFAULT_NOTEBOOK_INDEX },
    metadata: {
      summary: 'Scope admission fixture',
      producer: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
      authority: { kind: 'direct', instructionReference: 'test-fixture:scope-admission' },
      changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'0'.repeat(64)}` },
      sourceReferences: [],
    },
  });
}

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
  ] as const)('refuses Workspace database state %s without recreation', async (fault) => {
    const dataRoot = root();
    for (const id of [badId, goodId]) {
      const db = openWorkspaceDb(dataRoot, id);
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      db.sqlite.close();
    }
    initializeWorkspaceKnowledgePredecessor(dataRoot, goodId);
    const path = workspaceDbPath(dataRoot, badId);
    const damaged =
      fault === 'empty' ? Buffer.alloc(0) : Buffer.from('unreadable canonical Workspace authority');
    if (fault === 'missing') rmSync(path);
    else writeFileSync(path, damaged);

    await expect(verifyAndMigrateExistingScopedDatabases(dataRoot)).resolves.toBeUndefined();
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

  it('loads healthy native history without publishing a corrupt sibling cache', async () => {
    const dataRoot = root();
    const initial = createTestStore({ dataRoot });
    const good = await initial.createWorkspace('Healthy history');
    const bad = await initial.createWorkspace('Damaged history');
    const damaged = '{not a canonical record';
    await shutdownControlStoreWorkerClient();
    const before = damageWorkspaceRecord(dataRoot, bad.id, damaged);
    const path = workspaceDbPath(dataRoot, bad.id);
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getWorkspace(good.id).name).toBe('Healthy history');
    expect(reopened.listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
    expect(() => reopened.getWorkspace(bad.id)).toThrow('quarantined');
    expect(readFileSync(path)).toEqual(before);
    expect(scopeAdmissionFailures(dataRoot)).toContainEqual({
      scope: 'workspace',
      id: bad.id,
      check: 'records',
    });
  });

  it('validates native authority before scoped migration or call-loss recovery writes', async () => {
    const dataRoot = root();
    const initial = createTestStore({ dataRoot });
    const bad = await initial.createWorkspace('Malformed native authority');
    const good = await initial.createWorkspace('Healthy native authority');
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
    await shutdownControlStoreWorkerClient();
    const badDatabase = workspaceDbPath(dataRoot, bad.id);
    const before = damageWorkspaceRecord(dataRoot, bad.id, '{bad history');
    await verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
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

  it('contains an unreadable Workspace traversal without refusing its readable sibling', async () => {
    const dataRoot = root();
    const initial = createTestStore({ dataRoot });
    const bad = await initial.createWorkspace('Unreadable subtree');
    const good = await initial.createWorkspace('Readable subtree');
    const badRoot = join(dataRoot, 'workspaces', bad.id);
    await shutdownControlStoreWorkerClient();
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

  it('refuses an earlier database without native product authority before domain migration', async () => {
    const dataRoot = root();
    const initial = createTestStore({ dataRoot });
    const workspace = await initial.createWorkspace('Earlier native schema');
    const sibling = await initial.createWorkspace('Current native authority');
    await shutdownControlStoreWorkerClient();
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
    const before = readFileSync(workspaceDbPath(dataRoot, workspace.id));
    // Workspace 0000 predates native products. Its former file history is no longer an authority.
    // Boot cannot synthesize product records from later DDL or a readable configuration projection.
    await verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
      FsStore.validateFileAuthority(dataRoot)
    );
    expect(isScopeAdmitted(dataRoot, 'workspace', workspace.id)).toBe(false);
    expect(readFileSync(workspaceDbPath(dataRoot, workspace.id))).toEqual(before);
    const reopened = new FsStore({ dataRoot });
    expect(() => reopened.getWorkspace(workspace.id)).toThrow('quarantined');
    expect(reopened.listWorkspaces().map(({ id }) => id)).toEqual([sibling.id]);
    expect(reopened.getWorkspace(sibling.id).name).toBe('Current native authority');
  });

  it('removes a later-refused Workspace from an already published Store listing', async () => {
    const dataRoot = root();
    const store = createTestStore({ dataRoot });
    const bad = await store.createWorkspace('Migration failure');
    const good = await store.createWorkspace('Still admitted');
    await shutdownControlStoreWorkerClient();
    const db = openWorkspaceDb(dataRoot, bad.id);
    try {
      db.sqlite.exec(
        'DROP TABLE __drizzle_migrations; CREATE VIEW __drizzle_migrations AS SELECT 1 AS invalid'
      );
    } finally {
      db.sqlite.close();
    }
    await verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
      FsStore.validateFileAuthority(dataRoot)
    );
    expect(isScopeAdmitted(dataRoot, 'workspace', bad.id)).toBe(false);
    expect(store.listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
    expect(new FsStore({ dataRoot }).listWorkspaces().map(({ id }) => id)).toEqual([good.id]);
  });

  it('excludes previously cached Items after a late Workspace refusal without changing history', async () => {
    const dataRoot = root();
    const store = createTestStore({ dataRoot });
    const bad = await store.createWorkspace('Refused aggregate source');
    const good = await store.createWorkspace('Admitted aggregate source');
    const ids = new Map<string, string>();
    let badItemPath = '';
    for (const workspace of [bad, good]) {
      const thread = await store.createThread(workspace.id, 'Retained source');
      const turn = await store.createTurn(
        workspace.id,
        thread.id,
        'Retained input',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null
      );
      const id = allocateEntityId('it');
      ids.set(workspace.id, id);
      const now = new Date().toISOString();
      await store.createItem({
        id,
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: `ap_${id}`,
        kind: 'permission',
        title: workspace.name,
        description: 'Retained aggregate content.'.repeat(3_000),
        createdAt: now,
        completedAt: now,
      });
      if (workspace.id === bad.id) {
        const scope = nativeProductScope(dataRoot, turn.owner);
        const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
        try {
          // Read the actual native descriptor; the content reader returns decoded Item values.
          const entry = reader.entries(turn.id, 'item').find((candidate) => candidate.id === id);
          expect(entry).toBeDefined();
          badItemPath = join(scope.contentMount.root, entry!.content.reference.locator.path);
        } finally {
          reader.close();
        }
      }
    }
    expect(store.listAllItems().map(({ id }) => id)).toEqual(
      expect.arrayContaining([...ids.values()])
    );
    await shutdownControlStoreWorkerClient();
    const before = readFileSync(badItemPath);
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
    expect(readFileSync(badItemPath)).toEqual(before);
  });

  it('contains private User database loss without refusing a healthy Workspace', async () => {
    const dataRoot = root();
    const userId = 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b';
    const user = openUserDb(dataRoot, userId);
    applyScopedMigrations(user);
    user.sqlite.close();
    const good = openWorkspaceDb(dataRoot, goodId);
    applyScopedMigrations(good, undefined, 'pre-knowledge');
    good.sqlite.close();
    initializeWorkspaceKnowledgePredecessor(dataRoot, goodId);
    const path = userDbPath(dataRoot, userId);
    const damaged = Buffer.from('unreadable private User authority');
    writeFileSync(path, damaged);
    await expect(verifyAndMigrateExistingScopedDatabases(dataRoot)).resolves.toBeUndefined();
    expect(isScopeAdmitted(dataRoot, 'workspace', goodId)).toBe(true);
    expect(() => openUserDb(dataRoot, userId)).toThrow('quarantined');
    expect(readFileSync(path)).toEqual(damaged);
  });
});
