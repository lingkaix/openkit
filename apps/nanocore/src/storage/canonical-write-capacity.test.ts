import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { createAppWithWorkspaceAuthority as createApp } from '../test-support/app.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from './canonical-write-capacity.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  appendCanonicalTextFile,
  loadWorkspaceFileRecords,
  writeFileAtomic,
  writeWorkspaceFileRecords,
} from './workspace-file-records.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'canonical-capacity-'));
  roots.push(path);
  return path;
}
/** Retained inline records exercise the existing writer; new uploads use file descriptors. */
function fixture(content = 'prior original') {
  const dataRoot = root(),
    store = new FsStore({ dataRoot }),
    workspace = store.createWorkspace('Canonical capacity');
  const bytes = content;
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const artifactId = allocateEntityId('ar');
  const requestId = randomUUID(),
    time = new Date().toISOString();
  store.createArtifact({
    id: artifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Retained original',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body: bytes },
    contentDigest,
    lastMutationRequestId: requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: requestId,
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: allocateEntityId('usr') },
      requestId,
      recordedAt: time,
    },
    createdAt: time,
    updatedAt: time,
  });
  return {
    dataRoot,
    store,
    workspace,
    artifactId,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
  };
}
it('reserves the full pending UTF-8 replacement before any file effect and includes concurrent future writes', () => {
  const path = root(),
    target = join(path, 'canonical');
  writeFileSync(target, 'prior');
  const bytes = '界🙂'.repeat(10000),
    reserve = 1_000_000n;
  const admission = new FileStorageAdmission(
    path,
    () => reserve,
    () => reserve + BigInt(Buffer.byteLength(bytes)) + 65536n
  );
  const competing = admission.reserve({
    stagingBytes: 1n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 0n,
  });
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () => writeFileAtomic(target, bytes))
  ).toThrow('capacity');
  expect(readFileSync(target, 'utf8')).toBe('prior');
  expect(readdirSync(path)).toEqual(['canonical']);
  competing.release();
  withCanonicalFileWriteAdmission(admission, () => writeFileAtomic(target, bytes));
  expect(readFileSync(target, 'utf8')).toBe(bytes);
});
it('accounts for exact reference/event append bytes and restores the scope after a refusal', () => {
  const path = root(),
    target = join(path, 'events');
  writeFileSync(target, '{"prior":true}\n');
  const admission = new FileStorageAdmission(
    path,
    () => 100n,
    () => 100n + 65536n
  );
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      appendCanonicalTextFile(target, '{"next":true}\n')
    )
  ).toThrow('capacity');
  expect(readFileSync(target, 'utf8')).toBe('{"prior":true}\n');
  appendCanonicalTextFile(target, '{"outside":"unchanged owner"}\n');
  expect(readFileSync(target, 'utf8')).toContain('outside');
});
it('refuses a retained large inline body copy while preserving its original bytes', () => {
  const f = fixture('x'.repeat(1024 * 1024));
  const records = loadWorkspaceFileRecords(f.dataRoot).find(
    (r) => r.workspace.id === f.workspace.id
  )!;
  const payload = join(f.workspaceRoot, 'artifacts', f.artifactId, 'files', 'content.txt'),
    before = readFileSync(payload);
  const admission = new FileStorageAdmission(
    f.dataRoot,
    () => 1_000_000n,
    () => 1_000_000n + 128n * 1024n
  );
  // Prove a healthy capacity source before the deciding large-write refusal.
  admission
    .reserve({ stagingBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n })
    .release();
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      writeWorkspaceFileRecords(f.workspaceRoot, records)
    )
  ).toThrow('capacity');
  expect(readFileSync(payload)).toEqual(before);
});
it('does not rewrite canonical Notebook pages during record persistence under capacity pressure', async () => {
  const f = fixture();
  const coreDb = openCoreDb(f.dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: f.workspace.id,
  });
  try {
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.workspaceRoot, 'knowledge', 'notebook.git'),
    });
    const app = createApp({ coreDb, dataRoot: f.dataRoot, store: f.store });
    const response = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.create',
        { workspaceId: f.workspace.id },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            baseRevision: notebook.publishedRevision(),
            knowledgePageId: 'retained-knowledge',
            kind: 'project-context',
            title: 'Retained Knowledge',
            content: 'k'.repeat(1024 * 1024),
            sourceReferences: [],
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const page = (await response.json()) as { id: string };
    const revision = notebook.publishedRevision();
    const path = `${page.id}.md`;
    const before = Buffer.from(notebook.readRevision(revision, [path]).files[path]!);
    const digest = createHash('sha256').update(before).digest('hex');
    const records = loadWorkspaceFileRecords(f.dataRoot).find(
      (r) => r.workspace.id === f.workspace.id
    )!;
    // A stale projection cannot replace the Git-owned canonical page.
    records.knowledge.find((entry) => entry.id === page.id)!.content = 'Stale projected content.';
    const admission = new FileStorageAdmission(
      f.dataRoot,
      () => 1_000_000n,
      () => 1_000_000n + 128n * 1024n
    );
    // Prove a healthy capacity source before persistence under the small budget.
    admission
      .reserve({ stagingBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n })
      .release();
    expect(() =>
      withCanonicalFileWriteAdmission(admission, () =>
        writeWorkspaceFileRecords(f.workspaceRoot, records)
      )
    ).not.toThrow();
    expect(notebook.publishedRevision()).toBe(revision);
    const after = Buffer.from(
      notebook.readRevision(notebook.publishedRevision(), [path]).files[path]!
    );
    expect(after).toEqual(before);
    expect(createHash('sha256').update(after).digest('hex')).toBe(digest);
  } finally {
    coreDb.sqlite.close();
  }
});
it('skips equal JSON cores but reserves retained additive fields when the core changes', () => {
  const f = fixture(),
    target = join(f.workspaceRoot, 'artifacts', f.artifactId, 'artifact.json');
  const json = JSON.parse(readFileSync(target, 'utf8'));
  json.futureMetadata = 'u'.repeat(1024 * 1024);
  writeFileSync(target, JSON.stringify(json));
  const records = loadWorkspaceFileRecords(f.dataRoot).find(
    (r) => r.workspace.id === f.workspace.id
  )!;
  const admission = new FileStorageAdmission(
    f.dataRoot,
    () => 1_000_000n,
    () => 1_000_000n + 128n * 1024n
  );
  // Prove a healthy capacity source before the deciding large-write refusal.
  admission
    .reserve({ stagingBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n })
    .release();
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      writeWorkspaceFileRecords(f.workspaceRoot, records)
    )
  ).not.toThrow();
  const before = readFileSync(target);
  // Lifecycle status is mutable without changing the retained content version.
  records.artifacts[0]!.status = 'archived';
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      writeWorkspaceFileRecords(f.workspaceRoot, records)
    )
  ).toThrow('capacity');
  expect(readFileSync(target)).toEqual(before);
  expect(existsSync(target)).toBe(true);
});
