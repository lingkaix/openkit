import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { correctMaterialRange } from './material-range-corrections.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  createWorkspaceMaterial,
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  saveWorkspaceMaterialRevision,
} from './workspace-materials.js';

/** Computes the digest of the original UTF-8 bytes. */
function digest(text: string) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

it('retains exact correction attribution and reports apply, reject, stale and conflict without rebasing', () => {
  const root = mkdtempSync(join(tmpdir(), 'material-range-correction-'));
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
    requestId: 'create-correction',
    title: 'Original',
    kind: 'text',
    sensitivity: 'internal',
  });
  const content = '\uFEFFA😀\r\nB';
  const { revisionId } = saveWorkspaceMaterialRevision(db, {
    actor,
    acceptedAt,
    materialId,
    requestId: 'save-original',
    expectedRevisionId: null,
    content,
    contentDigest: digest(content),
  });
  const target = {
    kind: 'material-range',
    materialId,
    revisionId,
    contentDigest: digest(content),
    start: 2,
    end: 4,
    originalText: '😀',
  } as const;
  const input = {
    actor,
    acceptedAt,
    workspaceId: db.workspaceId,
    requestId: 'correct-source',
    target,
    replacementText: 'ok',
    decision: 'apply',
    note: 'Human correction',
    extensions: { source: 'manual' },
  } as const;
  const apply = () => db.sqlite.transaction(() => correctMaterialRange(db, input))();
  expect(() =>
    db.sqlite.transaction(() => {
      apply();
      throw new Error('rollback correction');
    })()
  ).toThrow('rollback correction');
  expect(getWorkspaceMaterial(db, materialId).currentRevisionId).toBe(revisionId);
  expect(getWorkspaceMaterialRevision(db, materialId, revisionId).judgements).toEqual([]);
  const judgement = apply();
  expect(judgement).toMatchObject({
    kind: 'correct',
    actor,
    recordedAt: acceptedAt,
    target,
    note: 'Human correction',
    choice: { outcome: 'apply', replacementText: 'ok' },
  });
  if (judgement.kind !== 'correct' || judgement.choice.outcome !== 'apply')
    throw new Error('Expected applied correction');
  const resulting = getWorkspaceMaterialRevision(
    db,
    materialId,
    judgement.choice.resultingRevision.revisionId
  );
  expect(resulting.content).toBe('\uFEFFAok\r\nB');
  expect(resulting.contentDigest).toBe(digest(resulting.content));
  expect(resulting.parentRevisionId).toBe(revisionId);
  expect(getWorkspaceMaterialRevision(db, materialId, revisionId).content).toBe(content);
  expect(getWorkspaceMaterialRevision(db, materialId, revisionId).judgements).toEqual([judgement]);
  const raw = JSON.parse(
    (
      db.sqlite
        .prepare('SELECT judgements FROM workspace_material_revisions WHERE revision_id = ?')
        .get(revisionId) as { judgements: string }
    ).judgements
  );
  raw[0].actor.displayName = 'Historical reviewer';
  raw[0].target.description = 'Original range';
  db.sqlite
    .prepare('UPDATE workspace_material_revisions SET judgements = ? WHERE revision_id = ?')
    .run(JSON.stringify(raw), revisionId);
  expect(getWorkspaceMaterialRevision(db, materialId, revisionId).judgements).toEqual([judgement]);
  expect(() =>
    db.sqlite.transaction(() =>
      correctMaterialRange(db, { ...input, requestId: 'conflicting-correction' })
    )()
  ).toThrow(expect.objectContaining({ code: 'conflict' }));
  expect(() =>
    db.sqlite.transaction(() =>
      correctMaterialRange(db, {
        ...input,
        requestId: 'stale-correction',
        target: { ...target, originalText: 'other' },
      })
    )()
  ).toThrow(expect.objectContaining({ code: 'stale' }));
  const rejected = db.sqlite.transaction(() =>
    correctMaterialRange(db, { ...input, requestId: 'reject-proposal', decision: 'reject' })
  )();
  expect(
    JSON.parse(
      (
        db.sqlite
          .prepare('SELECT judgements FROM workspace_material_revisions WHERE revision_id = ?')
          .get(revisionId) as { judgements: string }
      ).judgements
    )[0]
  ).toMatchObject({
    actor: { displayName: 'Historical reviewer' },
    target: { description: 'Original range' },
  });
  expect(rejected).toMatchObject({
    kind: 'correct',
    choice: { outcome: 'reject', resultingRevision: null },
  });
  expect(getWorkspaceMaterial(db, materialId).currentRevisionId).toBe(resulting.revisionId);
  db.sqlite.close();
  const reopened = openWorkspaceDb(root, db.workspaceId);
  try {
    expect(getWorkspaceMaterialRevision(reopened, materialId, revisionId).judgements).toEqual([
      judgement,
      rejected,
    ]);
  } finally {
    reopened.sqlite.close();
  }
});
