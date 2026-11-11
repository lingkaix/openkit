// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { zstdDecompressSync } from 'node:zlib';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { deriveEntityId, PROTOCOL_VERSION, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { computeBootReadinessSnapshot } from '../bootstrap/readiness.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import { recurringTurnPublicationIssue } from '../runtime/recurring-turn-publication.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createApp } from '../test-support/app.js';
import { createDemoWorkspaceForUser, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, openWorkspaceReadDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { workspaceArchiveHeader } from './workspace-archive.js';
import { verifyWorkspaceExportTree, WORKSPACE_EXPORT_MANIFEST_FILE } from './workspace-export.js';
import {
  nativeProductScope,
  readNativeProductEntries,
  readPublishedTurnFileRecords,
} from './workspace-file-records.js';

const fixtures: Array<{ root: string; db: ReturnType<typeof openCoreDb> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const { root, db } of fixtures.splice(0)) {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Owns explicit local identity, membership and portable data for the projection proof. */
async function fixture(getBootReadiness?: () => BootReadinessSnapshot) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-b14-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  ensureLocalUser(db);
  const store = new FsStore({ dataRoot: root });
  const demo = createDemoWorkspaceForUser(FIXTURE_LOCAL_USER_ID);
  await store.importWorkspaceSnapshot({
    ...notebookImportFixture({ workspaceId: demo.workspace.id, knowledge: [] }),
    workspace: demo.workspace,
    threads: [demo.thread],
    knowledge: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  });
  recordWorkspaceOwnerMembership({
    coreDb: db,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: demo.workspace.id,
  });
  fixtures.push({ root, db });
  return {
    root,
    db,
    store,
    app: createApp({
      dataRoot: root,
      coreDb: db,
      store,
      ...(getBootReadiness ? { getBootReadiness } : {}),
    }),
  };
}

/** Sends caller-owned bytes without supplying authority or fixture defaults. */
function request(path: string, body: unknown) {
  return [
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  ] as const;
}

/** Reads the specific native export usage owner without acquiring authority for the caller. */
function exportUsage(root: string) {
  const workspaceDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  try {
    applyScopedMigrations(workspaceDb);
    return workspaceDb.sqlite
      .prepare("SELECT * FROM usage_records WHERE category = 'storage' ORDER BY usage_id")
      .all();
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Observes the genuine selected Main SQLite instances without throwing policy assertions into HTTP. */
function observeExportDownloadReader(path: string) {
  const prepare = Database.prototype.prepare;
  const close = Database.prototype.close;
  const exec = Database.prototype.exec;
  const readers = new Map<Database.Database, { readonly: boolean; queryOnly: unknown }>();
  const businessReaders = new Set<Database.Database>();
  const closed: Array<{
    reader: Database.Database;
    readonly: boolean;
    queryOnly: unknown;
    code: string | null;
    unchanged: boolean;
    closed: boolean;
    observationError?: string;
  }> = [];
  let inside = false;
  const prepared = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (!inside && this.name === path) {
      // The physical flag is intrinsic. Supported-ledger preflight precedes ready query policy.
      if (!readers.has(this)) readers.set(this, { readonly: this.readonly, queryOnly: undefined });
      if (
        /\bFROM\s+capability_calls\s+call\b/i.test(sql) &&
        /\bJOIN\s+usage_records\s+usage\b/i.test(sql)
      ) {
        inside = true;
        try {
          businessReaders.add(this);
          readers.get(this)!.queryOnly = this.pragma('query_only', { simple: true });
        } finally {
          inside = false;
        }
      }
    }
    return prepare.call(this, sql);
  });
  const closing = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
    this: Database.Database
  ) {
    if (this.name !== path) return close.call(this);
    const row = {
      reader: this,
      readonly: this.readonly,
      queryOnly: this.pragma('query_only', { simple: true }) as unknown,
      code: null as string | null,
      unchanged: false,
      closed: false,
      observationError: undefined as string | undefined,
    };
    // Preflight has no published business-read phase; require its configured close policy.
    const ready = readers.get(this);
    if (ready && ready.queryOnly === undefined) ready.queryOnly = row.queryOnly;
    inside = true;
    try {
      const before = prepare.call(this, 'SELECT * FROM __drizzle_migrations ORDER BY id').all();
      if (!before.length || this.inTransaction)
        throw new Error('Unusable protected-row challenge.');
      exec.call(this, 'SAVEPOINT export_download_reader_challenge');
      try {
        prepare
          .call(
            this,
            'DELETE FROM __drizzle_migrations WHERE id = (SELECT id FROM __drizzle_migrations ORDER BY id LIMIT 1)'
          )
          .run();
      } catch (error) {
        row.code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'UNCLASSIFIED';
      } finally {
        exec.call(this, 'ROLLBACK TO export_download_reader_challenge');
        exec.call(this, 'RELEASE export_download_reader_challenge');
      }
      row.unchanged =
        JSON.stringify(
          prepare.call(this, 'SELECT * FROM __drizzle_migrations ORDER BY id').all()
        ) === JSON.stringify(before);
    } catch (error) {
      row.observationError = error instanceof Error ? error.message : String(error);
    } finally {
      inside = false;
    }
    try {
      return close.call(this);
    } finally {
      row.closed = !this.open;
      closed.push(row);
    }
  });
  return {
    readers,
    businessReaders,
    closed,
    restore() {
      prepared.mockRestore();
      closing.mockRestore();
    },
  };
}

describe('Workspace JSON transfer cutover', () => {
  it('exports complete canonical Item history after an unacknowledged append and later update', async () => {
    const { root, store, app } = await fixture();
    const thread = store.listThreads(DEMO_WORKSPACE_ID)[0]!;
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Retain history', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const item = await store.createItem({
      id: testEntityId('it', 'it_export_history'),
      type: 'assistant-message',
      owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
      threadId: thread.id,
      turnId: turn.id,
      text: 'A',
      status: 'completed',
      createdAt: '2026-10-16T00:00:00.000Z',
      completedAt: '2026-10-16T00:00:00.000Z',
    });
    const client = getControlStoreWorkerClient();
    const products = client.products.bind(client);
    let faults = 0;
    const interception = vi.spyOn(client, 'products').mockImplementationOnce(async (...args) => {
      await products(...args);
      faults++;
      throw new ControlStoreWorkerError('unavailable', 'unknown');
    });
    try {
      await expect(store.updateItem(item.id, { text: 'B' })).rejects.toMatchObject({
        commit: 'unknown',
      });
    } finally {
      interception.mockRestore();
    }
    expect(faults).toBe(1);
    await store.updateItem(item.id, { text: 'C' });
    const cachedTexts = () =>
      store
        .listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)
        .filter((row) => row.id === item.id)
        .map((row) => (row.type === 'assistant-message' ? row.text : null));
    expect(cachedTexts()).toEqual(['A', 'B', 'C']);
    expect(readPublishedTurnFileRecords(root, DEMO_WORKSPACE_ID, thread.id, turn.id)?.turn).toEqual(
      store.getTurn(DEMO_WORKSPACE_ID, thread.id, turn.id)
    );
    const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID });
    const originalEntries = readNativeProductEntries(scope, turn.id, 'item');
    expect(originalEntries.map(({ value }) => (value as { text: string }).text)).toEqual([
      'A',
      'B',
      'C',
    ]);
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const artifact = readFileSync(
      join(
        root,
        'server',
        'exports',
        'workspaces',
        DEMO_WORKSPACE_ID,
        exportId,
        'records',
        'item-revisions.jsonl'
      ),
      'utf8'
    );
    expect(
      artifact
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((row) => row.id === item.id)
        .map((row) => row.text)
    ).toEqual(['A', 'B', 'C']);
    expect(readNativeProductEntries(scope, turn.id, 'item')).toEqual(originalEntries);
    expect(cachedTexts()).toEqual(['A', 'B', 'C']);
  });

  it('exports canonical recurring Turn data after an actual update persistence failure', async () => {
    const { root, db, store, app } = await fixture();
    const thread = store.listThreads(DEMO_WORKSPACE_ID)[0]!;
    const instant = '2026-10-16T00:00:00.000Z';
    const schedules = new AutomationStore(db, new WorkspaceMutationAdmission(), () => instant);
    const schedule = await schedules.createAutomation(FIXTURE_LOCAL_USER_ID, {
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: thread.id,
      name: 'Inspect retained bytes',
      prompt: 'Inspect retained bytes',
      intervalSeconds: 5,
    });
    await schedules.updateAutomation(FIXTURE_LOCAL_USER_ID, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    const occurrence = (await schedules.collectScanCandidates(instant))[0]!;
    await schedules.commitAttempt(occurrence.id, 2, {
      kind: 'ready',
      payload: {
        backendId: 'modeled',
        requestedAgentId: 'worker',
        profileRef: null,
        modelId: 'exact-model',
        workspaceRoots: [],
        workspaceCwd: null,
      },
    });
    const entry = requireSchedulerAdmissionEntry(
      db,
      schedules.getOccurrence(occurrence.id).queueEntryId!
    );
    const turn = await store.createTurn(
      entry.workspaceId,
      entry.threadId,
      entry.turnInput,
      entry.triggerActor,
      null,
      {
        turnId: entry.turnId,
        status: 'pending',
        agentId: entry.requestedAgentId,
        executorKind: 'worker',
        reasoningEffort: entry.reasoningEffort,
      }
    );
    const published = readPublishedTurnFileRecords(root, DEMO_WORKSPACE_ID, thread.id, turn.id)!;
    expect(published.turn.status).toBe('pending');
    const nativeDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
    const sourceBytes = nativeDb.sqlite
      .prepare('SELECT * FROM control_turns WHERE id=?')
      .get(turn.id);
    try {
      nativeDb.sqlite.exec(
        "CREATE TRIGGER refuse_turn_update BEFORE UPDATE ON control_turns BEGIN SELECT RAISE(ABORT, 'injected native Turn failure'); END"
      );
      await expect(store.updateTurn(turn.id, { status: 'running' })).rejects.toMatchObject({
        commit: 'not-committed',
      });
      expect(
        nativeDb.sqlite.prepare('SELECT * FROM control_turns WHERE id=?').get(turn.id)
      ).toEqual(sourceBytes);
    } finally {
      nativeDb.sqlite.exec('DROP TRIGGER refuse_turn_update');
      nativeDb.sqlite.close();
    }
    expect(store.getTurn(DEMO_WORKSPACE_ID, thread.id, turn.id)).toEqual(turn);
    expect(recurringTurnPublicationIssue(store, entry)).toBeNull();
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const exportedTurns = readFileSync(
      join(
        root,
        'server',
        'exports',
        'workspaces',
        DEMO_WORKSPACE_ID,
        exportId,
        'records',
        'turns.jsonl'
      ),
      'utf8'
    );
    expect(
      exportedTurns
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([writeRetainedV1({ ...published.turn, captureCoverage: published.captureCoverage })]);
    expect(exportedTurns).not.toContain('failed-cache');
    // A fresh Store must export the same canonical Turn without a prior candidate cache.
    const freshStore = new FsStore({ dataRoot: root });
    expect(freshStore.listThreadTurns(DEMO_WORKSPACE_ID, thread.id)).toEqual([turn]);
    const freshApp = createApp({ dataRoot: root, coreDb: db, store: freshStore });
    const withoutCache = await freshApp.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(withoutCache.status, await withoutCache.clone().text()).toBe(200);
    const withoutCacheResult = await withoutCache.json();
    expect(
      readFileSync(
        join(
          root,
          'server',
          'exports',
          'workspaces',
          DEMO_WORKSPACE_ID,
          withoutCacheResult.exportId,
          'records',
          'turns.jsonl'
        ),
        'utf8'
      )
    ).toBe(exportedTurns);
    const preserved = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
    try {
      expect(
        preserved.sqlite.prepare('SELECT * FROM control_turns WHERE id=?').get(turn.id)
      ).toEqual(sourceBytes);
    } finally {
      preserved.sqlite.close();
    }
    expect(readPublishedTurnFileRecords(root, DEMO_WORKSPACE_ID, thread.id, turn.id)).toEqual(
      published
    );
  });

  it('round-trips actual archive bytes and Knowledge through the Web session streaming bindings', async () => {
    const source = await fixture();
    // The test controls only session admission; export and archive download use real owners.
    const sessionApp = (f: Awaited<ReturnType<typeof fixture>>) =>
      createApp({
        dataRoot: f.root,
        coreDb: f.db,
        store: f.store,
        mode: 'server',
        auth: {
          api: {
            getSession: async () => ({
              session: { id: 'archive_session' },
              user: { id: FIXTURE_LOCAL_USER_ID },
            }),
          },
          handler: async () => Response.json({ status: 'auth-ok' }),
        },
      });
    createOpenKitAccessTokenRecord(source.db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const sourceWeb = sessionApp(source);
    const content = 'Web session archive: café and exact retained content.';
    const notebookResponse = await sourceWeb.request(
      ...request('/api/app/operations/knowledge.notebook.list', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(notebookResponse.status, await notebookResponse.clone().text()).toBe(200);
    const { notebookRevision } = await notebookResponse.json();
    const [createPath, createInit] = request('/api/app/operations/knowledge.notebook.create', {
      workspaceId: DEMO_WORKSPACE_ID,
      baseRevision: notebookRevision,
      path: 'web-archive-proof.md',
      content: serializeKnowledgePageFixture(
        {
          title: 'Web archive proof',
          content,
          createdAt: '2026-10-19T00:00:00.000Z',
          updatedAt: '2026-10-19T00:00:00.000Z',
        },
        { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID }
      ),
      summary: 'Publish archive proof',
    });
    const created = await sourceWeb.request(createPath, {
      ...createInit,
      headers: { ...createInit.headers, 'x-openkit-request-id': randomUUID() },
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const exported = await sourceWeb.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const downloaded = await sourceWeb.request(
      `/api/app/workspaces/${DEMO_WORKSPACE_ID}/exports/${exportId}/archive`
    );
    expect(downloaded.status, await downloaded.clone().text()).toBe(200);
    const bytes = await downloaded.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('refuses private export consumption after its source-owner creator loses administrator eligibility', async () => {
    const { db, root, store } = await fixture();
    const now = Date.now();
    db.sqlite
      .prepare(
        `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('${testEntityId('usr', 'user_private')}', 'Private owner', 'private@example.test', 0, ?, ?, 'human')`
      )
      .run(now, now);
    await store.createThread(
      DEMO_WORKSPACE_ID,
      'Another user private history',
      undefined,
      undefined,
      {
        visibility: 'private',
        privateOwnerUserId: testEntityId('usr', 'user_private'),
      }
    );
    const token = createOpenKitAccessTokenRecord(db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({
      dataRoot: root,
      coreDb: db,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'creator_session' },
            user: { id: FIXTURE_LOCAL_USER_ID },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const [url, init] = request('/api/app/operations/workspace.export', {
      workspaceId: DEMO_WORKSPACE_ID,
    });
    const exported = await app.request(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token.secret}` },
    });
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const archivePath = `/api/app/workspaces/${DEMO_WORKSPACE_ID}/exports/${exportId}/archive`;
    const eligible = await app.request(archivePath, {
      headers: { authorization: `Bearer ${token.secret}` },
    });
    expect(eligible.status).toBe(200);
    expect((await eligible.arrayBuffer()).byteLength).toBeGreaterThan(0);
    revokeOpenKitAccessTokenRecord(db, token.record.tokenId);
    expect(
      isCurrentDeploymentAdministrator(db, { kind: 'session', userId: FIXTURE_LOCAL_USER_ID })
    ).toBe(false);
    expect(
      isWorkspaceOperationAuthorized(
        db,
        { kind: 'session', userId: FIXTURE_LOCAL_USER_ID },
        DEMO_WORKSPACE_ID,
        {
          mutating: false,
          policyOperation: 'workspace.export',
        }
      )
    ).toBe(false);
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const published = readdirSync(join(root, 'workspaces'));
    const archive = await app.request(archivePath);
    const body = Buffer.from(await archive.arrayBuffer());
    expect.soft(archive.status).toBe(403);
    expect.soft(archive.headers.get('content-type')).toContain('application/json');
    // Parsing the complete response as this exact refusal proves no archive bytes were released.
    expect(JSON.parse(body.toString())).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
    });
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
    expect(readdirSync(join(root, 'workspaces'))).toEqual(published);
  });

  it('retires the authorized former bindings without an alias', async () => {
    const { app, store, root } = await fixture();
    const usage = exportUsage(root);
    const before = store.listWorkspaces().map(({ id }) => id);
    for (const path of [
      `/api/app/workspaces/${DEMO_WORKSPACE_ID}/export`,
      '/api/app/workspace-imports/dry-run',
      '/api/app/workspace-imports',
    ]) {
      const response = await app.request(
        ...request(path, { sourceWorkspaceId: DEMO_WORKSPACE_ID, exportId: 'absent' })
      );
      expect(response.status, path).toBe(404);
    }
    expect(store.listWorkspaces().map(({ id }) => id)).toEqual(before);
    expect(exportUsage(root)).toEqual(usage);
  });

  it('canonical export reaches its existing owner', async () => {
    const { app } = await fixture();
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    await exported.json();
  });

  it('HTTP and MCP readiness refuses export without tree or registry writes', async () => {
    let readiness = computeBootReadinessSnapshot({ bootId: 'b14-readiness' });
    const { app, db, root } = await fixture(() => readiness);
    const exportedResponse = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(exportedResponse.status).toBe(200);
    await exportedResponse.json();
    const token = createOpenKitAccessTokenRecord(db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const exportsRoot = join(root, 'server', 'exports', 'workspaces', DEMO_WORKSPACE_ID);
    const trees = readdirSync(exportsRoot);
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    readiness = computeBootReadinessSnapshot({
      bootId: 'b14-readiness',
      subsystems: {
        storage: {
          state: 'failed',
          reasons: [
            { code: 'storage.failed', message: 'Storage unavailable.', blocks: ['product_work'] },
          ],
        },
      },
    });
    const operation = 'workspace.export';
    const input = { workspaceId: DEMO_WORKSPACE_ID };
    const response = await app.request(...request(`/api/app/operations/${operation}`, input));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'product_work_unavailable' });
    const rpc = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token.secret}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'openkit_call', arguments: { operation, input } },
      }),
    });
    expect(rpc.status).toBe(200);
    const result = (await rpc.json()).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(readdirSync(exportsRoot)).toEqual(trees);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
  });

  it('refuses read-only and revoked export credentials before export usage or tree writes', async () => {
    const { db, root, store } = await fixture();
    const app = createApp({ dataRoot: root, coreDb: db, store, mode: 'server' });
    const readonly = createOpenKitAccessTokenRecord(db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'workspace-readonly',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const revoked = createOpenKitAccessTokenRecord(db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    revokeOpenKitAccessTokenRecord(db, revoked.record.tokenId);
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const exports = readdirSync(join(root, 'server', 'exports'));
    const usage = exportUsage(root);
    for (const [secret, status] of [
      [readonly.secret, 403],
      [revoked.secret, 401],
    ] as const) {
      const [url, init] = request('/api/app/operations/workspace.export', {
        workspaceId: DEMO_WORKSPACE_ID,
      });
      const response = await app.request(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${secret}` },
      });
      expect(response.status).toBe(status);
    }
    expect(readdirSync(join(root, 'server', 'exports'))).toEqual(exports);
    expect(exportUsage(root)).toEqual(usage);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
  });

  it('rejects caller-selected administrator eligibility without creating an export', async () => {
    const { app, root } = await fixture();
    const before = exportUsage(root);
    const trees = readdirSync(join(root, 'server', 'exports'));
    const response = await app.request(
      ...request('/api/app/operations/workspace.export', {
        workspaceId: DEMO_WORKSPACE_ID,
        administratorEligible: true,
      })
    );
    expect(response.status).toBe(400);
    expect(exportUsage(root)).toEqual(before);
    expect(readdirSync(join(root, 'server', 'exports'))).toEqual(trees);
  });

  it('keeps an administrator private export inaccessible to the non-creating source owner', async () => {
    const { app, store, db, root } = await fixture();
    const now = Date.now();
    db.sqlite
      .prepare(
        `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('${testEntityId('usr', 'user_source')}', 'Source', 'source@example.test', 0, ?, ?, 'human')`
      )
      .run(now, now);
    const workspace = await store.createWorkspace('Source-owned private data');
    recordWorkspaceOwnerMembership({
      coreDb: db,
      ownerUserId: testEntityId('usr', 'user_source'),
      workspaceId: workspace.id,
    });
    await store.createThread(workspace.id, 'Private project', undefined, undefined, {
      visibility: 'private',
      privateOwnerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: workspace.id })
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const { exportId } = await exported.json();
    const ownerApp = createApp({
      dataRoot: root,
      coreDb: db,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'source_session' },
            user: { id: testEntityId('usr', 'user_source') },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const archive = await ownerApp.request(
      `/api/app/workspaces/${workspace.id}/exports/${exportId}/archive`
    );
    expect(archive.status).toBe(403);
    const creatorDownload = await app.request(
      `/api/app/workspaces/${workspace.id}/exports/${exportId}/archive`
    );
    expect(creatorDownload.status).toBe(200);
    expect((await creatorDownload.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it.each([
    ['missing call', 'DELETE FROM capability_calls WHERE call_id = ?'],
    ['missing creator proof', 'DELETE FROM usage_records WHERE capability_call_id = ?'],
    [
      'different recorded actor',
      `UPDATE usage_records SET responsible_user_id = '${testEntityId('usr', 'user_other')}' WHERE capability_call_id = ?`,
    ],
    [
      'contradictory recorded actor',
      `UPDATE usage_records SET responsible_user_id = '${testEntityId('usr', 'user_other')}' WHERE capability_call_id = ? AND unit = 'bytes'`,
    ],
  ])('fails closed on %s without publishing an imported Workspace', async (_case, mutation) => {
    const { app, db, root } = await fixture();
    const exported = await app.request(
      ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const workspaceDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
    try {
      expect(
        workspaceDb.sqlite
          .prepare(mutation)
          .run(deriveEntityId('cap', ['storage_export', exportId])).changes
      ).toBeGreaterThan(0);
    } finally {
      workspaceDb.sqlite.close();
    }
    const registry = db.sqlite
      .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
      .all();
    const archive = await app.request(
      `/api/app/workspaces/${DEMO_WORKSPACE_ID}/exports/${exportId}/archive`
    );
    expect(archive.status).toBe(403);
    expect(await archive.json()).toMatchObject({ code: 'workspace_export_archive_forbidden' });
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
    ).toEqual(registry);
  });
  it('downloads the exact attributed archive with physically read-only query-only Main readers', async () => {
    const f = await fixture();
    // Reuse this owner's existing session-admission seam; Core still decides current export authority.
    const administrator = createOpenKitAccessTokenRecord(f.db, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({
      dataRoot: f.root,
      coreDb: f.db,
      store: f.store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'export_reader_creator_session' },
            user: { id: FIXTURE_LOCAL_USER_ID },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const path = realpathSync(workspaceDbPath(f.root, DEMO_WORKSPACE_ID));
    const database = `workspace:${path}`;
    const nativeAcks: Array<{ operation: string; id: number }> = [];
    const pending = new Map<Worker, Map<number, string>>();
    const listeners: Array<{ worker: Worker; listener: (reply: unknown) => void }> = [];
    const postMessage = Worker.prototype.postMessage;
    const posting = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const message = args[0] as { id?: number; operation?: string; database?: string } | null;
      if (
        message &&
        typeof message.id === 'number' &&
        typeof message.operation === 'string' &&
        (message.database === database || (message.operation === 'shutdown' && pending.has(this)))
      ) {
        if (!pending.has(this)) {
          pending.set(this, new Map());
          const listener = (reply: unknown) => {
            const row = reply as { id?: number; status?: string } | null;
            if (!row || typeof row.id !== 'number') return;
            const operation = pending.get(this)?.get(row.id);
            if (!operation) return;
            pending.get(this)!.delete(row.id);
            if (row.status === 'ok') nativeAcks.push({ operation, id: row.id });
          };
          this.on('message', listener);
          listeners.push({ worker: this, listener });
        }
        pending.get(this)!.set(message.id, message.operation);
      }
      return Reflect.apply(postMessage, this, args);
    });
    let observed: ReturnType<typeof observeExportDownloadReader> | undefined;
    try {
      const exported = await app.request(
        ...request('/api/app/operations/workspace.export', { workspaceId: DEMO_WORKSPACE_ID })
      );
      expect(exported.status, await exported.clone().text()).toBe(200);
      const { exportId } = await exported.json();
      const exportRoot = join(
        f.root,
        'server',
        'exports',
        'workspaces',
        DEMO_WORKSPACE_ID,
        exportId
      );
      const verified = verifyWorkspaceExportTree({ exportRoot });
      expect(verified.manifest.workspaceId).toBe(DEMO_WORKSPACE_ID);
      expect(verified.artifactPayloadFiles.size).toBe(0);
      const files = new Map<string, Buffer>([
        [WORKSPACE_EXPORT_MANIFEST_FILE, Buffer.from(verified.manifestText)],
        ...[...verified.fileContents].map(([name, text]) => [name, Buffer.from(text)] as const),
        ...[...verified.binaryFileContents].map(
          ([name, bytes]) => [name, Buffer.from(bytes)] as const
        ),
      ]);
      const originalFiles = [...files].map(([name, bytes]) => [name, Buffer.from(bytes)] as const);
      const directories = new Set<string>();
      for (const name of files.keys()) {
        const parts = name.split('/');
        parts.pop();
        while (parts.length) {
          directories.add(`${parts.join('/')}/`);
          parts.pop();
        }
      }
      const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
      const chunks: Buffer[] = [];
      for (const name of [...directories].sort(compare))
        chunks.push(workspaceArchiveHeader(name, 'directory', 0));
      for (const name of [...files.keys()].sort(compare)) {
        const bytes = files.get(name)!;
        chunks.push(workspaceArchiveHeader(name, 'file', bytes.length), bytes);
        const padding = (512 - (bytes.length % 512)) % 512;
        if (padding) chunks.push(Buffer.alloc(padding));
      }
      chunks.push(Buffer.alloc(1024));
      const usage = exportUsage(f.root);
      const callId = deriveEntityId('cap', ['storage_export', exportId]);
      const attributed = usage.filter(
        (row) => (row as { capability_call_id: string }).capability_call_id === callId
      ) as Array<{ unit: string; quantity: number; responsible_user_id: string }>;
      expect(attributed).toHaveLength(2);
      expect(new Map(attributed.map((row) => [row.unit, row.quantity]))).toEqual(
        new Map([
          ['files', verified.checkedFiles.length],
          ['bytes', verified.manifest.contentInventory.reduce((sum, file) => sum + file.bytes, 0)],
        ])
      );
      expect(attributed.every((row) => row.responsible_user_id === FIXTURE_LOCAL_USER_ID)).toBe(
        true
      );
      expect(nativeAcks.some((row) => row.operation === 'capability')).toBe(true);
      observed = observeExportDownloadReader(path);
      const downloaded = await app.request(
        `/api/app/workspaces/${DEMO_WORKSPACE_ID}/exports/${exportId}/archive`
      );
      expect(downloaded.status, await downloaded.clone().text()).toBe(200);
      expect(zstdDecompressSync(Buffer.from(await downloaded.arrayBuffer()))).toEqual(
        Buffer.concat(chunks)
      );
      observed.restore();
      expect(exportUsage(f.root)).toEqual(usage);
      for (const [name, bytes] of originalFiles)
        expect(readFileSync(join(exportRoot, name))).toEqual(bytes);
      revokeOpenKitAccessTokenRecord(f.db, administrator.record.tokenId);
      const denied = await app.request(
        `/api/app/workspaces/${DEMO_WORKSPACE_ID}/exports/${exportId}/archive`
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        protocolVersion: PROTOCOL_VERSION,
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
      });
      expect(exportUsage(f.root)).toEqual(usage);
      await shutdownControlStoreWorkerClient();
      expect(nativeAcks.some((row) => row.operation === 'shutdown')).toBe(true);
      expect([...pending.values()].every((requests) => requests.size === 0)).toBe(true);
      const cold = openWorkspaceReadDb(f.root, DEMO_WORKSPACE_ID);
      try {
        expect(
          cold.sqlite
            .prepare("SELECT * FROM usage_records WHERE category='storage' ORDER BY usage_id")
            .all()
        ).toEqual(usage);
      } finally {
        cold.sqlite.close();
      }
      // Deciding physical policy checks follow real HTTP/native/canonical/cold prerequisites.
      expect(observed.readers.size).toBeGreaterThan(0);
      expect(observed.businessReaders.size).toBeGreaterThan(0);
      expect(observed.closed).toHaveLength(observed.readers.size);
      for (const [reader, ready] of observed.readers) {
        expect(
          ready,
          `Actual selected Main reader policies: ${JSON.stringify({
            ready: [...observed.readers.values()],
            close: observed.closed.map((row) => ({
              readonly: row.readonly,
              queryOnly: row.queryOnly,
              code: row.code,
              unchanged: row.unchanged,
              closed: row.closed,
              observationError: row.observationError,
            })),
          })}`
        ).toEqual({ readonly: true, queryOnly: 1 });
        expect(observed.closed.filter((row) => row.reader === reader)).toEqual([
          {
            reader,
            readonly: true,
            queryOnly: 1,
            code: 'SQLITE_READONLY',
            unchanged: true,
            closed: true,
            observationError: undefined,
          },
        ]);
        expect(reader.open).toBe(false);
      }
    } finally {
      observed?.restore();
      posting.mockRestore();
      for (const { worker, listener } of listeners) worker.off('message', listener);
    }
  });
});
