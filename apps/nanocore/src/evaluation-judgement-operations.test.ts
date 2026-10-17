import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CorrectMaterialRangeRequestSchema,
  RecordEvaluationJudgementRequestSchema,
} from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { createEvaluationJudgementOperationImplementations } from './evaluation-judgement-operations.js';
import { FsStore } from './lib/store.js';
import type { AdmittedOperationContext } from './operation-contract.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  createWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  saveWorkspaceMaterialRevision,
} from './workspace-materials.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it('joins exact human annotations and corrections to ordinary transactional command replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-judgement-api-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Human evaluation');
  const workspaceId = workspace.id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const db = openWorkspaceDb(root, workspaceId);
  onTestFinished(() => {
    if (db.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const actor = { kind: 'user', id: userId } as const;
  const acceptedAt = new Date().toISOString();
  const { materialId } = createWorkspaceMaterial(db, {
    actor,
    acceptedAt,
    requestId: 'create',
    title: 'Human source',
    kind: 'text',
    sensitivity: 'internal',
  });
  const content = 'Original 😀 source\r\n';
  const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const { revisionId } = saveWorkspaceMaterialRevision(db, {
    actor,
    acceptedAt,
    materialId,
    requestId: 'initial',
    expectedRevisionId: null,
    content,
    contentDigest,
  });
  const target = {
    kind: 'material-range',
    offsetUnit: 'utf-16',
    materialId,
    revisionId,
    contentDigest,
    start: 9,
    end: 11,
    originalText: '😀',
  };
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'session', userId },
    actorRef: actor,
    scope: { kind: 'workspace', workspaceId },
  };
  const operations = createEvaluationJudgementOperationImplementations({
    store,
    coreDb,
    inflightCommands: new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>(),
    repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
  });
  const input = RecordEvaluationJudgementRequestSchema.parse({
    workspaceId,
    requestId: 'human-assessment',
    judgement: {
      kind: 'rate',
      target,
      choice: { value: 2, lowerBound: 1, upperBound: 3 },
      note: 'Needs correction',
      extensions: { rubric: 'manual' },
    },
  });
  const recorded = await operations['evaluation.judgement-add'](input, context);
  expect(recorded.judgement).toMatchObject({
    actor,
    kind: 'rate',
    target,
    note: 'Needs correction',
  });
  expect(getWorkspaceMaterialRevision(db, materialId, revisionId).content).toBe(content);
  const correction = CorrectMaterialRangeRequestSchema.parse({
    workspaceId,
    requestId: 'human-correction',
    target,
    replacementText: 'new',
    decision: 'apply',
  });
  const applied = await operations['material.range-correct'](correction, context);
  expect(applied.judgement).toMatchObject({ kind: 'correct', actor, choice: { outcome: 'apply' } });
  expect(await operations['material.range-correct'](correction, context)).toEqual(applied);
  expect(await operations['evaluation.judgement-add'](input, context)).toEqual(recorded);
  await expect(
    operations['material.range-correct']({ ...correction, replacementText: 'other' }, context)
  ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  expect(
    await operations['evaluation.judgement-add'](input, { ...context, delivery: 'model' })
  ).toEqual(recorded);
  db.sqlite
    .prepare(
      'UPDATE workspace_materials SET sensitivity = ? WHERE workspace_id = ? AND material_id = ?'
    )
    .run('restricted', workspaceId, materialId);
  await expect(
    operations['evaluation.judgement-add'](input, { ...context, delivery: 'model' })
  ).rejects.toMatchObject({ code: 'sensitive_content' });
  await expect(
    operations['material.range-correct'](correction, { ...context, delivery: 'model' })
  ).rejects.toMatchObject({ code: 'sensitive_content' });
  expect(getWorkspaceMaterialRevision(db, materialId, revisionId).judgements).toEqual([
    recorded.judgement,
    applied.judgement,
  ]);
  coreDb.sqlite
    .prepare(
      'UPDATE workspace_registry SET status = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ?'
    )
    .run('deleting', new Date().toISOString(), workspaceId);
  await expect(operations['evaluation.judgement-add'](input, context)).rejects.toMatchObject({
    code: 'workspace_access_denied',
  });
});
