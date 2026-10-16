import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
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
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Skill management');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
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
    producer: { kind: 'user' as const, id: LOCAL_USER_ID },
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
    workspace,
    workspaceDb,
    first: first.version.digest,
    second: second.version.digest,
    call,
  };
}

describe('native Skill management command evidence', () => {
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
          event.actor.id === LOCAL_USER_ID &&
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
