import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Keeps explicit registered-source selection distinct from coincidentally equal entry bytes. */
describe('direct Knowledge saved-source lineage', () => {
  it('retains the selected exact Source relationship through public indexes and restart', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-source-lineage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
    const app = createApp({ coreDb, dataRoot, store });
    const client = createCoreClient({
      baseUrl: 'http://test.invalid',
      fetch: (input, init) => app.fetch(new Request(input, init)),
    });
    try {
      const { source } = await client.operations['knowledge.source.register']({
        workspaceId: 'ws_demo',
        requestId: crypto.randomUUID(),
        kind: 'document',
        title: 'Reading room source',
        content: 'The reading room opens at eight.',
      });
      expect(source.contentDigest).toBeTruthy();
      const reference = `source:${source.id}@${source.contentDigest}`;
      const entry = await client.operations['knowledge.create']({
        workspaceId: 'ws_demo',
        requestId: crypto.randomUUID(),
        kind: 'project-context',
        title: 'Reading room hours',
        content: 'The reading room opens at eight.',
        sourceReferences: [reference],
      });
      const indexes = await client.operations['knowledge.indexes']({ workspaceId: 'ws_demo' });
      expect(indexes.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: entry.id, reference, resolved: true })
      );
      const reopened = new FsStore({ dataRoot });
      const reopenedApp = createApp({ coreDb, dataRoot, store: reopened });
      const reopenedClient = createCoreClient({
        baseUrl: 'http://test.invalid',
        fetch: (input, init) => reopenedApp.fetch(new Request(input, init)),
      });
      const retained = await reopenedClient.operations['knowledge.list']({
        workspaceId: 'ws_demo',
      });
      expect(retained.items.find((item) => item.id === entry.id)?.sourceReferences).toEqual([
        reference,
      ]);
      const rebuilt = await reopenedClient.operations['knowledge.indexes']({
        workspaceId: 'ws_demo',
      });
      expect(rebuilt.sourceReferences.references).toContainEqual(
        expect.objectContaining({ conceptId: entry.id, reference, resolved: true })
      );
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
