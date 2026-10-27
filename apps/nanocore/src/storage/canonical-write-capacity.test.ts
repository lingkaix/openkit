import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { createAppWithWorkspaceAuthority as createApp } from '../test-support/app.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import { knowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from './canonical-write-capacity.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  appendCanonicalTextFile,
  loadWorkspaceFileRecords,
  nativeProductScope,
  writeFileAtomic,
  writeWorkspaceFileRecords,
} from './workspace-file-records.js';

const immutableFault = vi.hoisted(() => ({ shared: new SharedArrayBuffer(4096) }));

// Fault the real native preparation, leaving its verifier, SQL and replies intact.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(
          `(${installImmutableFault.toString()})(require, require('node:worker_threads').workerData.immutableFault);` +
            entry,
          {
            ...options,
            eval: true,
            workerData: { ...options?.workerData, immutableFault: immutableFault.shared },
          }
        );
      }
    },
  };
});

/** Corrupts the exact private input before native verification, or fails its required sync. */
function installImmutableFault(require: NodeRequire, shared: SharedArrayBuffer): void {
  const state = new Int32Array(shared, 0, 4);
  const fs = require('node:fs') as typeof import('node:fs');
  const promises = require('node:fs/promises') as typeof import('node:fs/promises');
  const open = promises.open;
  promises.open = (async (...args: Parameters<typeof open>) => {
    const mode = Atomics.load(state, 0);
    const prefix = Buffer.from(shared, 16, Atomics.load(state, 2)).toString();
    const path = String(args[0]);
    const selected = mode && prefix && path.startsWith(prefix) && path.endsWith('.tmp');
    if (selected && mode !== 4 && Atomics.compareExchange(state, 1, 0, 1) === 0) {
      if (mode === 1) fs.unlinkSync(path);
      else {
        fs.chmodSync(path, 0o600);
        const bytes = fs.readFileSync(path);
        if (mode === 2) fs.truncateSync(path, bytes.length - 1);
        else {
          bytes[0] = bytes[0]! ^ 1;
          fs.writeFileSync(path, bytes);
        }
      }
    }
    const file = await open(...args);
    if (selected && mode === 4)
      file.sync = async () => {
        Atomics.store(state, 1, 1);
        throw Object.assign(new Error('synchronization fault'), { code: 'EIO' });
      };
    return file;
  }) as typeof open;
  require('node:module').syncBuiltinESMExports();
}

const roots: string[] = [];
const cores: ReturnType<typeof openCoreDb>[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const core of cores.splice(0)) if (core.sqlite.open) core.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'canonical-capacity-'));
  roots.push(path);
  return path;
}
/** Retained inline records exercise the existing writer; new uploads use file descriptors. */
async function fixture(content = 'prior original') {
  const dataRoot = root();
  const coreDb = openCoreDb(dataRoot);
  cores.push(coreDb);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Canonical capacity');
  const bytes = content;
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const artifactId = allocateEntityId('ar');
  const requestId = randomUUID(),
    time = new Date().toISOString();
  await store.createArtifact({
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
it('refuses a retained large inline body copy while preserving its original bytes', async () => {
  const f = await fixture('x'.repeat(1024 * 1024));
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
  const f = await fixture();
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
    const timestamp = new Date().toISOString();
    const page = knowledgePageFixture(
      {
        id: 'retained-knowledge',
        title: 'Retained Knowledge',
        content: 'k'.repeat(1024 * 1024),
        sourceReferences: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: f.workspace.id }
    );
    const response = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: f.workspace.id },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            baseRevision: notebook.publishedRevision(),
            path: page.path,
            content: page.content,
            summary: 'Create the canonical page before record persistence.',
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const revision = notebook.publishedRevision();
    const path = page.path;
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
it('skips equal JSON cores but reserves retained additive fields when the core changes', async () => {
  const f = await fixture(),
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

it.each([
  'missing',
  'short',
  'digest-mismatched',
  'unsynchronized',
] as const)('refuses a public Item whose immutable input is %s without committing a reference', async (fault) => {
  const dataRoot = root();
  const coreDb = openCoreDb(dataRoot);
  cores.push(coreDb);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Immutable Item');
  const thread = await store.createThread(workspace.id, 'Immutable Item');
  const turn = await store.createTurn(workspace.id, thread.id, 'Publish', {
    kind: 'user',
    id: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  const before = db.sqlite.prepare('SELECT * FROM control_product_entries').all();
  const state = new Int32Array(immutableFault.shared, 0, 4);
  const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId: workspace.id });
  const prefix = Buffer.from(`${scope.contentMount.root}/.`);
  new Uint8Array(immutableFault.shared, 16).set(prefix);
  Atomics.store(state, 2, prefix.length);
  Atomics.store(state, 1, 0);
  Atomics.store(
    state,
    0,
    ['missing', 'short', 'digest-mismatched', 'unsynchronized'].indexOf(fault) + 1
  );
  let faultApplied = false;
  try {
    await expect(
      (async () =>
        await store.createItem({
          id: allocateEntityId('it'),
          owner: { kind: 'workspace', workspaceId: workspace.id },
          threadId: thread.id,
          turnId: turn.id,
          type: 'assistant-message',
          // Keep these real file-input faults above the retained inline threshold.
          text: 'Exact immutable input'.padEnd(70_000, '.'),
          status: 'in_progress',
          createdAt: turn.startedAt!,
          completedAt: null,
        }))()
    ).rejects.toThrow();
    faultApplied = Atomics.load(state, 1) === 1;
    expect(faultApplied, 'the fault must reach the actual immutable Product bytes').toBe(true);
    expect(db.sqlite.prepare('SELECT * FROM control_product_entries').all()).toEqual(before);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await getControlStoreWorkerClient().shutdown();
    expect(new FsStore({ dataRoot }).listThreadItems(workspace.id, thread.id)).toEqual([]);
  } finally {
    Atomics.store(state, 0, 0);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await getControlStoreWorkerClient().shutdown();
    db.sqlite.close();
  }
});
