import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  compactWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  type CatalogTreeFile,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
} from './resource-catalog.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

/** These exact uploaded bytes exercise ordinary native catalog management without a Worker. */
function tree(body: string): CatalogTreeFile[] {
  return [
    {
      kind: 'file',
      path: 'SKILL.md',
      contentBase64: Buffer.from(
        `---\nname: Management Example\ndescription: Exercise native commands.\n---\n${body}\n`
      ).toString('base64'),
    },
  ];
}

/** Real records and native HTTP dispatch; direct setup imports only arrange two retained versions. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-management-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Skill management');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  cleanup.push(() => {
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
  });
  applyScopedMigrations(workspaceDb);
  const base = {
    dataRoot,
    workspaceId: workspace.id,
    id: 'management-example',
    displayName: 'Management Example',
    producer: { kind: 'user' as const, id: userId },
    createdAt: '2026-10-16T00:00:00Z',
  };
  const first = importWorkspaceSkill({
    ...base,
    expectedRevision: 0,
    activate: true,
    tree: tree('Version A'),
  });
  const second = importWorkspaceSkill({
    ...base,
    expectedRevision: 1,
    activate: false,
    tree: tree('Version B'),
  });
  const app = createApp({ coreDb, dataRoot, store });
  const call = (
    operation: Parameters<typeof operationRequest>[0],
    input: Record<string, unknown>
  ) =>
    app.request(
      ...operationRequest(
        operation,
        {},
        { body: JSON.stringify({ workspaceId: workspace.id, ...input }) }
      )
    );
  return {
    dataRoot,
    userId,
    coreDb,
    store,
    workspace,
    workspaceDb,
    first: first.version.digest,
    second: second.version.digest,
    call,
  };
}

describe('native Skill management command evidence', () => {
  it('retains the exact winning pin command across identical pins, replay and clear', async () => {
    const f = fixture();
    const pinInput = {
      requestId: randomUUID(),
      expectedRevision: 2,
      skillId: 'management-example',
      digest: f.first,
      expectedPinDigest: null,
    };
    const first = await f.call('catalog.skill-pin', pinInput);
    expect(first.status, await first.clone().text()).toBe(200);
    const prior = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.pins[0]!;
    const firstAudit = f.workspaceDb.sqlite
      .prepare('SELECT id FROM audit_events WHERE request_id = ? AND action = ?')
      .get(pinInput.requestId, 'catalog.skill-pin.admit') as { id: string };
    expect(prior).toMatchObject({ digest: f.first, pinAuditRef: firstAudit.id });

    const repeated = {
      ...pinInput,
      requestId: randomUUID(),
      expectedRevision: 3,
      expectedPinDigest: f.first,
    };
    const second = await f.call('catalog.skill-pin', repeated);
    expect(second.status, await second.clone().text()).toBe(200);
    const winning = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.pins[0]!;
    const winner = f.workspaceDb.sqlite
      .prepare(
        'SELECT id, request_id AS requestId, actor_json AS actor FROM audit_events WHERE request_id = ? AND action = ?'
      )
      .get(repeated.requestId, 'catalog.skill-pin.admit') as {
      id: string;
      requestId: string;
      actor: string;
    };
    expect(winning).toMatchObject({ digest: f.first, pinAuditRef: winner.id });
    expect(winner.id).not.toBe(firstAudit.id);
    expect(winner.requestId).toBe(repeated.requestId);
    expect(JSON.parse(winner.actor)).toEqual({ kind: 'user', id: f.userId });
    const read = await f.call('catalog.read', {});
    expect(read.status, await read.clone().text()).toBe(200);
    expect((await read.json()).skills[0]).toMatchObject({
      pinDigest: f.first,
      pinAuditRef: winner.id,
    });
    const auditCount = () =>
      (
        f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get() as {
          count: number;
        }
      ).count;
    const beforeReplay = auditCount();
    const replay = await f.call('catalog.skill-pin', repeated);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.pins[0]).toEqual(
      winning
    );
    expect(auditCount()).toBe(beforeReplay);
    const cleared = await f.call('catalog.skill-pin', {
      ...repeated,
      requestId: randomUUID(),
      expectedRevision: 4,
      digest: null,
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.pins).toEqual([]);
    expect(
      f.workspaceDb.sqlite.prepare('SELECT id FROM audit_events WHERE id = ?').get(winner.id)
    ).toEqual({ id: winner.id });
  });

  it('keeps unexpired evidence bytes and purges after its existing retention owner expires them', async () => {
    const f = fixture();
    recordWorkspaceEvidenceBundle(f.workspaceDb, {
      id: 'skill-evidence',
      workspaceId: f.workspace.id,
      threadId: null,
      goalId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'skill-comparison',
      summary: 'Retained Skill input.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
      contentDigests: [f.second],
      retentionClass: 'ephemeral-diagnostic',
      sensitivityClass: 'product-safe',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const input = {
      requestId: randomUUID(),
      expectedRevision: 2,
      skillId: 'management-example',
      digest: f.second,
    };
    const refused = await f.call('catalog.skill-purge', input);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('evidence:skill-evidence');
    expect(
      loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.versions.find(
        (v) => v.digest === f.second
      )?.contentState
    ).toBe('retained');
    compactWorkspaceEvidenceBundles({
      workspaceDb: f.workspaceDb,
      workspaceId: f.workspace.id,
      olderThan: '2026-10-15T00:00:00.000Z',
    });
    const removed = await f.call('catalog.skill-purge', { ...input, requestId: randomUUID() });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(
      loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.versions.find(
        (v) => v.digest === f.second
      )?.contentState
    ).toBe('purged');
  });

  it('retains a supplied version named by a real AEP after its default moves', async () => {
    const f = fixture();
    const thread = f.store.createThread(f.workspace.id, 'Retained Skill input');
    const turn = f.store.createTurn(f.workspace.id, thread.id, 'Use retained Skill', {
      kind: 'user',
      id: f.userId,
    });
    const snapshot = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestAgentSetup({ skillIds: ['management-example'] }),
      agentSessionId: allocateEntityId('as'),
      backend: { kind: 'openshell' },
      coreDb: f.coreDb,
      createdAt: '2026-10-16T00:00:00.000Z',
      requestId: null,
      turn,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });
    recordAgentEnvironmentPackageSnapshot(f.workspaceDb, {
      environmentPackage: snapshot,
      createdAt: '2026-10-16T00:00:00.000Z',
    });
    const selected = await f.call('catalog.skill-select', {
      requestId: randomUUID(),
      expectedRevision: 2,
      skillId: 'management-example',
      digest: f.second,
      expectedCurrentDigest: f.first,
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    const refused = await f.call('catalog.skill-purge', {
      requestId: randomUUID(),
      expectedRevision: 3,
      skillId: 'management-example',
      digest: f.first,
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(`aep:${snapshot.snapshotId}`);
    expect(
      loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.versions.find(
        (v) => v.digest === f.first
      )?.contentState
    ).toBe('retained');
  });

  it('imports unchanged ecosystem bytes and checks updates without moving selection or contacting an unavailable source on replay', async () => {
    const f = fixture();
    let content =
      '---\nname: Ecosystem Example\ndescription: Original unmodified package.\n---\nVersion A\n';
    let unavailable = false;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = unavailable ? 503 : 200;
      response.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind.');
      const source = `http://127.0.0.1:${address.port}/SKILL.md`;
      const input = {
        requestId: randomUUID(),
        expectedRevision: 2,
        id: 'ecosystem-example',
        displayName: 'Ecosystem Example',
        activate: false,
        source,
      };
      const imported = await f.call('catalog.skill-import', input);
      expect(imported.status, await imported.clone().text()).toBe(201);
      const original = await imported.json();
      expect(original.version.provenance).toMatchObject({
        sourceLocator: source,
        sourceCommit: null,
      });
      expect(original.entry.currentDigest).toBeNull();
      const retained = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
      const identity = { skillId: original.entry.id, digest: original.version.digest };
      const unchanged = await f.call('catalog.skill-update-check', identity);
      expect(unchanged.status, await unchanged.clone().text()).toBe(200);
      expect(await unchanged.json()).toMatchObject({
        status: 'unchanged',
        observedDigest: identity.digest,
      });
      content = content.replace('Version A', 'Version B');
      const changed = await f.call('catalog.skill-update-check', identity);
      expect(changed.status, await changed.clone().text()).toBe(200);
      expect(await changed.json()).toMatchObject({
        status: 'changed',
        digest: identity.digest,
        sourceCommit: null,
      });
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(retained);
      unavailable = true;
      const missing = await f.call('catalog.skill-update-check', identity);
      expect(missing.status, await missing.clone().text()).toBe(200);
      expect(await missing.json()).toMatchObject({ status: 'unavailable', observedDigest: null });
      const priorRequests = requests;
      const replay = await f.call('catalog.skill-import', input);
      expect(replay.status, await replay.clone().text()).toBe(201);
      expect(await replay.json()).toEqual(original);
      expect(requests).toBe(priorRequests);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(retained);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('refuses a remote local-path source without publishing a catalog version', async () => {
    const f = fixture();
    const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    const result = await f.call('catalog.skill-import', {
      requestId: randomUUID(),
      expectedRevision: 2,
      displayName: 'Local source',
      activate: false,
      source: f.dataRoot,
    });
    expect(result.status, await result.clone().text()).toBe(400);
    expect(await result.json()).toMatchObject({ code: 'invalid_request' });
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
  });

  it.each([
    'import',
    'select',
    'pin',
    'remove',
  ] as const)('audits %s and replays its receipt without repeating the catalog effect', async (kind) => {
    const f = fixture();
    const requestId = randomUUID();
    const operation = `catalog.skill-${kind}` as const;
    const common = { requestId, expectedRevision: 2 };
    const input: Record<string, unknown> =
      kind === 'import'
        ? {
            ...common,
            id: 'uploaded-example',
            displayName: 'Uploaded Example',
            activate: false,
            tree: tree('Uploaded content'),
          }
        : kind === 'select'
          ? {
              ...common,
              skillId: 'management-example',
              digest: f.second,
              expectedCurrentDigest: f.first,
            }
          : kind === 'pin'
            ? { ...common, skillId: 'management-example', digest: f.first, expectedPinDigest: null }
            : { ...common, skillId: 'management-example' };
    const status = kind === 'import' ? 201 : 200;
    const first = await f.call(operation, input);
    expect(first.status, await first.clone().text()).toBe(status);
    const original = await first.json();
    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    const replay = await f.call(operation, input);
    expect(replay.status, await replay.clone().text()).toBe(status);
    expect(await replay.json()).toEqual(original);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(catalog);
    const events = listWorkspaceAuditEvents(f.workspaceDb, f.workspace.id).filter(
      (event) =>
        event.requestId === requestId &&
        event.action.startsWith(operation) &&
        event.outcome === 'succeeded'
    );
    expect(
      events.some(
        (event) =>
          event.outcome === 'succeeded' &&
          event.actor?.kind === 'user' &&
          event.actor.id === f.userId &&
          event.resourceRevision === 3
      )
    ).toBe(true);
    if (kind === 'select' || kind === 'pin') {
      expect(events.map((event) => `${event.resource} ${event.summary}`).join('\n')).toContain(
        f.first
      );
      if (kind === 'select')
        expect(events.map((event) => event.summary).join('\n')).toContain(f.second);
    }
    const changed =
      kind === 'import'
        ? { ...input, displayName: 'Changed input' }
        : kind === 'select' || kind === 'pin'
          ? { ...input, digest: kind === 'select' ? f.first : f.second }
          : { ...input, expectedRevision: 3 };
    const conflict = await f.call(operation, changed);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(catalog);
    expect(
      listWorkspaceAuditEvents(f.workspaceDb, f.workspace.id).filter(
        (event) =>
          event.requestId === requestId &&
          event.action.startsWith(operation) &&
          event.outcome === 'succeeded'
      )
    ).toEqual(events);
  });
});
