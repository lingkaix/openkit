import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  assertWorkspaceMaterialRange,
  createWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  saveWorkspaceMaterialRevision,
} from './workspace-materials.js';

it('anchors an original range in UTF-16 without splitting a surrogate or substituting a digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'material-judgement-range-'));
  const db = openWorkspaceDb(root, 'ws_00000000-0000-7000-8000-000000000001');
  onTestFinished(() => {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  const acceptedAt = '2026-10-17T12:00:00.000Z';
  const { materialId } = createWorkspaceMaterial(db, {
    actor,
    acceptedAt,
    requestId: 'create-range-source',
    title: 'Exact source',
    kind: 'text',
    sensitivity: 'internal',
  });
  const content = '\uFEFFA😀\r\nB';
  const contentDigest = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
  const { revisionId } = saveWorkspaceMaterialRevision(db, {
    materialId,
    actor,
    acceptedAt,
    requestId: 'save-range-source',
    expectedRevisionId: null,
    content,
    contentDigest,
  });
  const range = { materialId, revisionId, contentDigest, start: 2, end: 4, originalText: '😀' };
  expect(assertWorkspaceMaterialRange(db, range)).toEqual(
    getWorkspaceMaterialRevision(db, materialId, revisionId)
  );
  expect(() =>
    assertWorkspaceMaterialRange(db, { ...range, end: 3, originalText: '\ud83d' })
  ).toThrow(expect.objectContaining({ code: 'stale' }));
  expect(() =>
    assertWorkspaceMaterialRange(db, { ...range, contentDigest: `sha256:${'0'.repeat(64)}` })
  ).toThrow(expect.objectContaining({ code: 'stale' }));
});
