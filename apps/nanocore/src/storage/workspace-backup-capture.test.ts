// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createArtifactReview } from '../artifact-reviews.js';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  createLightApp,
  createRecord,
  updateLightAppSchema,
} from '../generative-kernel/commands.js';
import { FsStore } from '../lib/store.js';
import { WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION } from '../runtime/execution-journal.js';
import type { ExecutionJournalSpan } from '../runtime/execution-step-journal.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import {
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  verifyDataRootBackupManifest,
  writeHotDataRootBackup,
} from './data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import {
  createWorkspaceBackup,
  stageWorkspaceBackup,
  type WorkspaceBackupCreateInput,
  type WorkspaceBackupSource,
  type WorkspaceBackupStageInput,
  WorkspaceRecoveryError,
  type WorkspaceRecoveryErrorCode,
} from './workspace-backup.js';
import {
  parseWorkspaceBackupManifest,
  type VerifiedWorkspaceBackupBundle,
  type WorkspaceBackupManifest,
  type WorkspaceBackupVerificationInput,
  withVerifiedWorkspaceBackupBundle,
} from './workspace-backup-bundle.js';

// Independent D0-1 oracles: WM "Workspace Bundle And Authority", capture steps 2–5,
// restore steps 1–2, and the cold/H1 amendment. No capture collector is substituted.
const workspaceId = DEMO_WORKSPACE_ID;
const timestamp = '2026-10-21T10:00:00.000Z';
const release = { version: '0.1.0-d0-fixture', buildId: 'independent-d0-release' };
const roots: string[] = [];

/** Independent exact-byte digest, not the subject's inventory-digest helper. */
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Records every name, mode and byte without following a link, including metadata and SQLite sidecars. */
function tree(
  root: string
): Record<string, { kind: string; mode: number; digest?: string; target?: string }> {
  const result: ReturnType<typeof tree> = {};
  if (!existsSync(root)) return result;
  const visit = (relative: string) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      result[relative] = { kind: 'link', mode: stat.mode & 0o777, target: readlinkSync(path) };
    } else if (stat.isDirectory()) {
      result[relative] = { kind: 'directory', mode: stat.mode & 0o777 };
      for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
    } else {
      result[relative] = {
        kind: 'file',
        mode: stat.mode & 0o777,
        digest: digest(readFileSync(path)),
      };
    }
  };
  visit('');
  return result;
}

/** Reads every retained table through an existing-only SQLite connection, with stable row ordering. */
function databaseRows(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ])
    );
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real native product, Notebook, Source, Material, Review and Light App owners produce the capture graph. */
async function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'd0-capture-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const core = openCoreDb(dataRoot);
  const ownerId = ensureLocalUser(core);
  const actor = { kind: 'user' as const, id: ownerId };
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: ownerId });
  try {
    const privateThread = await store.createThread(
      workspaceId,
      'Private retained history',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: ownerId }
    );
    const turn = await store.createTurn(workspaceId, privateThread.id, 'Retained input', actor);
    const body = '# Retained artifact\nExact authored body.\n';
    const artifactRequestId = randomUUID();
    const artifact = await store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId,
      threadId: privateThread.id,
      turnId: turn.id,
      kind: 'report',
      // Its native reference Item must retain a real file for missing-body and byte faults.
      title: 'Capture artifact'.padEnd(70_000, '.'),
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: digest(body),
      lastMutationRequestId: artifactRequestId,
      origin: {
        kind: 'turn-output',
        requestId: artifactRequestId,
        threadId: privateThread.id,
        turnId: turn.id,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      const material = createWorkspaceMaterial(db, {
        actor,
        acceptedAt: timestamp,
        kind: 'markdown',
        sensitivity: 'internal',
        title: 'Retained material',
        requestId: randomUUID(),
      });
      saveWorkspaceMaterialRevision(db, {
        actor,
        acceptedAt: timestamp,
        materialId: material.materialId,
        expectedRevisionId: null,
        content: body,
        contentDigest: digest(body),
        requestId: randomUUID(),
      });
      bindThreadMaterial(db, {
        acceptedAt: timestamp,
        expectedBindingState: 'not_bound',
        materialId: material.materialId,
        requestId: randomUUID(),
        threadId: privateThread.id,
      });
      createArtifactReview(db, {
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        contentDigest: artifact.contentDigest,
        sourceAgentId: null,
        sourceThreadId: privateThread.id,
        sourceTurnId: turn.id,
        materialProposal: null,
        createdAt: timestamp,
      });
    } finally {
      db.sqlite.close();
    }
    await store.completeTurn(turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const original = Buffer.from([0, 1, 127, 128, 255, 10, 13]);
    const source = await captureWorkspaceSourceFixture({
      dataRoot,
      store,
      coreDb: core,
      userId: ownerId,
      content: original,
      source: {
        id: allocateEntityId('ks'),
        workspaceId,
        kind: 'document',
        title: 'Binary local evidence',
        uri: null,
        contentDigest: digest(original),
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    const context = {
      dataRoot,
      store,
      workspaceId,
      actor,
      requestId: randomUUID(),
      inflightCommands: new WeakMap(),
    };
    const app = await createLightApp(context, {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Retained app',
      purpose: 'Capture local business rows.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Notes.',
          fields: [{ name: 'text', type: 'text', required: true, description: 'Retained body.' }],
          indexes: [],
        },
      ],
    });
    await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'notes',
      app.schemaRevision,
      { text: 'Retained business row' }
    );
    const { appId: _appId, schemaRevision: _schemaRevision, ...retainedSchema } = app.schema!;
    const nextSchema: LightAppSchemaInput = retainedSchema;
    nextSchema.collections[0]!.fields.push({
      name: 'extra',
      type: 'text',
      required: false,
      description: 'New optional field.',
    });
    await updateLightAppSchema(
      { ...context, requestId: randomUUID() },
      app.appId,
      app.appRevision,
      app.schemaRevision,
      nextSchema
    );
    await shutdownControlStoreWorkerClient();
    const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
    const knownBytes = tree(workspaceRoot);
    const rows = databaseRows(workspaceDbPath(dataRoot, workspaceId));
    const appRows = databaseRows(join(workspaceRoot, 'light-apps', app.appId, 'data.sqlite'));
    const reader = openControlStoreProductReadHandle(workspaceDbPath(dataRoot, workspaceId), {
      kind: 'workspace',
      workspaceId,
    });
    let revision: number;
    try {
      revision = reader.get('workspace', workspaceId)!.revision;
    } finally {
      reader.close();
    }
    mkdirSync(join(root, 'staging'));
    return {
      root,
      dataRoot,
      workspaceRoot,
      store,
      ownerId,
      source,
      original,
      privateThread,
      turn,
      app,
      knownBytes,
      rows,
      appRows,
      revision,
      deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot,
        scope: { kind: 'workspace', workspaceId },
      }),
    };
  } finally {
    core.sqlite.close();
  }
}
type Fixture = Awaited<ReturnType<typeof buildFixture>>;
let template: Fixture;
beforeAll(async () => {
  template = await buildFixture();
  roots.splice(roots.indexOf(template.root), 1);
}, 120_000);
afterAll(() => {
  if (template) rmSync(template.root, { recursive: true, force: true });
});

/** Clones the stopped, real-owner fixture so one fault cannot contaminate another case. */
async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'd0-case-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  cpSync(template.dataRoot, dataRoot, { recursive: true });
  mkdirSync(join(root, 'staging'));
  return {
    ...template,
    root,
    dataRoot,
    workspaceRoot: join(dataRoot, 'workspaces', workspaceId),
    store: new FsStore({ dataRoot }),
  };
}

/** Trusted policy is supplied explicitly; database marker names follow the published D0 addendum. */
function inputFor(
  f: Fixture,
  source: WorkspaceBackupSource = { kind: 'stopped-data-root', dataRoot: f.dataRoot }
): WorkspaceBackupCreateInput {
  return {
    source,
    workspaceId,
    expectedSourceDeploymentId: f.deploymentId,
    backupId: allocateEntityId('wsbak'),
    purpose: 'backup',
    bundleRoot: join(f.root, 'bundle'),
    stagingParent: join(f.root, 'staging'),
    admission: new FileStorageAdmission(f.root, () => 0n),
    expectedRelease: release,
    supportedDatabaseFormats: {
      'drizzle.workspace': 17,
      'drizzle.app.1': 1,
      'drizzle.app.2': 2,
      'drizzle.app.3': 3,
      'drizzle.app.4': 4,
      'drizzle.app.5': 5,
      'light-app.kernel.1': 1,
      'light-app.kernel.2': 2,
    },
  };
}

/** Keeps the parent produced by the actual backup writer, including its original crash-consistent guarantee. */
async function hotParent(f: Fixture) {
  const backupRoot = join(f.root, 'parent');
  const backupId = allocateEntityId('drb');
  await writeHotDataRootBackup({
    dataRoot: f.dataRoot,
    backupRoot,
    backupId,
    sourceDeploymentId: f.deploymentId,
    startedAt: timestamp,
    completedAt: timestamp,
  });
  const verified = verifyDataRootBackupManifest({ backupRoot });
  expect(verified.manifest.id).toBe(backupId);
  expect(verified.manifest.consistency).toBe('crash-consistent');
  return { backupRoot, backupId };
}

/** A refusal is proved only by its nominal class and the exact owner-assigned code. */
async function refusal(input: WorkspaceBackupCreateInput, code: WorkspaceRecoveryErrorCode) {
  const error: unknown = await createWorkspaceBackup(input).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WorkspaceRecoveryError);
  expect((error as WorkspaceRecoveryError).code).toBe(code);
  expect(String(error)).not.toContain(input.bundleRoot);
  expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
}

/** Copies only callback-verified bytes for independent SQLite and immutable-family observations. */
async function verifiedFiles(input: WorkspaceBackupVerificationInput) {
  return withVerifiedWorkspaceBackupBundle(input, async (bundle: VerifiedWorkspaceBackupBundle) => {
    const files = new Map<string, Buffer>();
    for (const entry of bundle.manifest.inventory) {
      const chunks: Buffer[] = [];
      for await (const chunk of bundle.readFile(entry.path)) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(entry.bytes);
      expect(digest(bytes)).toBe(entry.sha256);
      files.set(entry.path, bytes);
    }
    return {
      files,
      manifest: bundle.manifest,
      seal: bundle.seal,
      manifestDigest: bundle.manifestDigest,
      fileCount: bundle.fileCount,
      totalBytes: bundle.totalBytes,
    };
  });
}

describe('D0-1: capture complete stopped authority', () => {
  it('WM 340–363, 367–371: stopped capture retains every local family, identity, digest and mode', async () => {
    const f = await fixture();
    const input = inputFor(f);
    const result = await requiredCapture(input);
    expect(result).toMatchObject({
      purpose: 'backup',
      disposition: 'sealed',
      bundleRoot: input.bundleRoot,
    });
    const verified = await verifiedFiles(input);
    expect(result.manifest).toEqual(verified.manifest);
    expect(result.report).toMatchObject({
      backupId: input.backupId,
      workspaceId,
      sourceDeploymentId: f.deploymentId,
      knowledgeBaseIds: [f.knowledgeBaseId],
      capturedRevision: f.revision,
      manifestDigest: verified.manifestDigest,
      fileCount: verified.fileCount,
      totalBytes: verified.totalBytes,
      coverage: verified.manifest.coverage,
      source: { kind: 'stopped-data-root' },
      interruptedTurnIds: [],
      unknownEffectTurnIds: [],
    });
    expect(verified.manifest).toMatchObject({
      format: 'openkit-workspace-backup',
      version: 1,
      purpose: 'backup',
      release,
      capture: { consistency: 'quiescent' },
      accounts: { ownerId: f.ownerId, memberIds: [f.ownerId], privateAudienceRefs: [f.ownerId] },
    });
    expect(verified.seal).toMatchObject({
      backupId: input.backupId,
      purpose: 'backup',
      manifestDigest: digest(readFileSync(join(input.bundleRoot, 'manifest.json'))),
    });
    expect(verified.manifest.coverage.includedAuthorities.length).toBeGreaterThan(0);
    expect(verified.manifest.inventory.some((entry) => /(?:-wal|-shm)$/.test(entry.path))).toBe(
      false
    );
    // Full census of this real fixture's canonical files, independent of bundle path spelling.
    for (const [path, fact] of Object.entries(f.knownBytes)) {
      if (
        fact.kind !== 'file' ||
        /^(?:indexes|logs|projections)\//.test(path) ||
        /(?:-wal|-shm)$/.test(path) ||
        (path.endsWith('.sqlite') && !path.includes('/snapshots/'))
      )
        continue;
      expect(verified.manifest.inventory, `Retained family bytes: ${path}`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path, sha256: fact.digest, mode: fact.mode }),
        ])
      );
    }
    expect([...verified.files.values()].some((bytes) => bytes.equals(f.original))).toBe(true);
    const capturedDatabases = verified.manifest.databaseFormats.map(({ path }, index) => {
      const destination = join(f.root, `inspected-${index}.sqlite`);
      writeFileSync(destination, verified.files.get(path)!);
      return databaseRows(destination);
    });
    const workspaceRows = capturedDatabases.find((rows) => 'control_workspaces' in rows)!;
    expect(workspaceRows).toBeDefined();
    // Capture ownership may add a record. Every other retained family and row remains present.
    for (const [table, rows] of Object.entries(f.rows)) {
      expect(workspaceRows, `Missing table family ${table}`).toHaveProperty(table);
      if (table !== 'workspace_capture_records') expect(workspaceRows[table]).toEqual(rows);
    }
    expect(capturedDatabases.some((rows) => 'app_metadata' in rows)).toBe(true);
    const appIndex = verified.manifest.databaseFormats.findIndex(
      ({ path }) => path === `light-apps/${f.app.appId}/data.sqlite`
    );
    expect(appIndex).toBeGreaterThanOrEqual(0);
    expect(capturedDatabases[appIndex]).toEqual(f.appRows);
    expect(verified.manifest.databaseFormats).toEqual(
      expect.arrayContaining([
        { path: 'db/workspace.sqlite', markers: { 'drizzle.workspace': 17 } },
        {
          path: `light-apps/${f.app.appId}/data.sqlite`,
          markers: { 'drizzle.app.5': 5, 'light-app.kernel.2': 2 },
        },
      ])
    );
    expect(JSON.stringify(result.report)).not.toContain(f.root);
    expect(JSON.stringify(result.report)).not.toContain('Exact authored body');
  }, 120_000);

  it('WM 410–412: MOVE preparation has no seal and does not mark source authority moved-out', async () => {
    const f = await fixture();
    const input = { ...inputFor(f), purpose: 'move' as const };
    const result = await requiredCapture(input);
    expect(result).toMatchObject({
      purpose: 'move',
      disposition: 'prepared',
      manifest: { purpose: 'move', capture: { consistency: 'quiescent' } },
    });
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    const reader = openControlStoreProductReadHandle(workspaceDbPath(f.dataRoot, workspaceId), {
      kind: 'workspace',
      workspaceId,
    });
    try {
      expect(reader.get('workspace', workspaceId)).toMatchObject({
        revision: f.revision,
        record: { status: 'active' },
      });
    } finally {
      reader.close();
    }
    const core = new Database(join(f.dataRoot, 'server/db/core.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        core.prepare('SELECT status FROM workspace_registry WHERE workspace_id=?').get(workspaceId)
      ).toEqual({ status: 'active' });
    } finally {
      core.close();
    }
  }, 120_000);

  it('D0 root exclusion: an existing holder yields root-locked', async () => {
    const f = await fixture();
    const input = inputFor(f);
    const lock = acquireDataRootLock(f.dataRoot, { bootId: 'independent-d0-holder' });
    try {
      await refusal(input, 'root-locked');
      expect(existsSync(input.bundleRoot)).toBe(false);
    } finally {
      lock.release();
    }
  }, 120_000);

  it.each([
    ['missing root', 'source-unavailable'],
    ['missing Workspace database', 'workspace-unavailable'],
    ['invalid Workspace database', 'invalid-database'],
    ['missing retained immutable body', 'incomplete-closure'],
    ['linked retained content', 'unsafe-path'],
    ['wrong deployment', 'deployment-mismatch'],
    ['unrelated output', 'candidate-conflict'],
  ] as const)(
    'WM 355, 368, 370, 377–380: %s refuses with %s without replacement authority',
    async (fault, code) => {
      const f = await fixture();
      let input = inputFor(f);
      const dbPath = workspaceDbPath(f.dataRoot, workspaceId);
      const body = Object.entries(f.knownBytes).find(
        ([path, value]) => path.startsWith('evidence/backend/sha256/') && value.kind === 'file'
      )!;
      expect(body).toBeDefined();
      if (fault === 'missing root')
        input = {
          ...input,
          source: { kind: 'stopped-data-root', dataRoot: join(f.root, 'missing') },
        };
      if (fault === 'missing Workspace database') rmSync(dbPath);
      if (fault === 'invalid Workspace database') writeFileSync(dbPath, 'INVALID-DATABASE-CANARY');
      if (fault === 'missing retained immutable body') rmSync(join(f.workspaceRoot, body[0]));
      if (fault === 'linked retained content') {
        const outside = join(f.root, 'outside');
        writeFileSync(outside, readFileSync(join(f.workspaceRoot, body[0])));
        rmSync(join(f.workspaceRoot, body[0]));
        symlinkSync(outside, join(f.workspaceRoot, body[0]));
      }
      if (fault === 'wrong deployment')
        input = { ...input, expectedSourceDeploymentId: allocateEntityId('dep') };
      if (fault === 'unrelated output') {
        mkdirSync(input.bundleRoot);
        writeFileSync(join(input.bundleRoot, 'unrelated'), 'PRESERVE-UNRELATED');
      }
      const before = tree(f.dataRoot);
      await refusal(input, code);
      // Capture ownership alone may change the existing Workspace database, never create missing authority.
      if (fault === 'missing root') expect(existsSync(join(f.root, 'missing'))).toBe(false);
      if (fault === 'missing Workspace database') expect(existsSync(dbPath)).toBe(false);
      if (fault === 'invalid Workspace database')
        expect(readFileSync(dbPath, 'utf8')).toBe('INVALID-DATABASE-CANARY');
      if (fault === 'unrelated output')
        expect(readFileSync(join(input.bundleRoot, 'unrelated'), 'utf8')).toBe(
          'PRESERVE-UNRELATED'
        );
      expect(tree(f.dataRoot)[`workspaces/${workspaceId}/config/workspace.jsonc`]).toEqual(
        before[`workspaces/${workspaceId}/config/workspace.jsonc`]
      );
    },
    120_000
  );
});

describe('D0-1 H1: verified hot parent is read-only', () => {
  it('H1 parent-lock ruling: capture succeeds while original root is locked and parent bytes never change', async () => {
    const f = await fixture();
    const parent = await hotParent(f);
    const input = inputFor(f, { kind: 'data-root-backup', backupRoot: parent.backupRoot });
    const before = tree(parent.backupRoot);
    const lock = acquireDataRootLock(f.dataRoot, { bootId: 'live-original-root' });
    try {
      const result = await requiredCapture(input);
      expect(result).toMatchObject({
        purpose: 'backup',
        disposition: 'sealed',
        report: {
          source: {
            kind: 'data-root-backup',
            dataRootBackupId: parent.backupId,
            consistency: 'crash-consistent',
          },
        },
      });
      const verified = await verifiedFiles(input);
      expect(verified.manifest.workspaceId).toBe(workspaceId);
      expect(verified.manifest.sourceDeploymentId).toBe(f.deploymentId);
      expect(verified.manifest.knowledgeBaseIds).toEqual([f.knowledgeBaseId]);
      expect([...verified.files.values()].some((bytes) => bytes.equals(f.original))).toBe(true);
      expect(tree(parent.backupRoot)).toEqual(before);
      expect(verifyDataRootBackupManifest({ backupRoot: parent.backupRoot }).manifest.id).toBe(
        parent.backupId
      );
    } finally {
      lock.release();
    }
  }, 120_000);

  it.each([
    ['wrong deployment', 'deployment-mismatch'],
    ['missing parent manifest', 'parent-backup-invalid'],
    ['damaged parent', 'parent-backup-invalid'],
    ['extra parent file', 'parent-backup-invalid'],
    ['wrong parent inventory digest', 'parent-backup-invalid'],
  ] as const)(
    'H1: %s refuses with %s and leaves the parent byte-identical',
    async (fault, code) => {
      const f = await fixture();
      const parent = await hotParent(f);
      let input = inputFor(f, { kind: 'data-root-backup', backupRoot: parent.backupRoot });
      if (fault === 'wrong deployment')
        input = { ...input, expectedSourceDeploymentId: allocateEntityId('dep') };
      if (fault === 'missing parent manifest')
        rmSync(join(parent.backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE));
      if (fault === 'damaged parent')
        writeFileSync(
          join(parent.backupRoot, 'workspaces', workspaceId, 'config/workspace.jsonc'),
          'DAMAGED-PARENT'
        );
      if (fault === 'extra parent file')
        writeFileSync(join(parent.backupRoot, 'extra-unlisted'), 'UNLISTED-PARENT');
      if (fault === 'wrong parent inventory digest') {
        const metadataPath = join(parent.backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE);
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        metadata.contentDigest = `sha256:${'0'.repeat(64)}`;
        writeFileSync(metadataPath, JSON.stringify(metadata));
      }
      const before = tree(parent.backupRoot);
      await refusal(input, code);
      expect(tree(parent.backupRoot)).toEqual(before);
    },
    120_000
  );

  it('H1 and WM 357, 382: in-flight source execution is reported interrupted or unknown, with no replay', async () => {
    const f = await fixture();
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Unfinished source work', {
      kind: 'user',
      id: f.ownerId,
    });
    const session = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId,
      threadId: turn.threadId,
      agentId: 'agent_d0_history',
      status: 'ready',
      message: null,
      createdAt: turn.startedAt!,
      updatedAt: turn.startedAt!,
    });
    await f.store.updateTurn(turn.id, { agentId: session.agentId, agentSessionId: session.id });
    const now = BigInt(Date.now()) * 1_000_000n;
    const span = (id: string): ExecutionJournalSpan & { endTimeUnixNano: null } => ({
      traceId: '1'.repeat(32),
      spanId: id.repeat(16),
      flags: 1,
      name: 'Capture execution history',
      kind: 'INTERNAL',
      startTimeUnixNano: now,
      endTimeUnixNano: null,
      status: { code: 'UNSET' },
      attributes: [],
      droppedAttributesCount: 0,
      events: [],
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      instrumentationScope: {
        name: 'openkit.d0-fixture',
        attributes: [],
        droppedAttributesCount: 0,
      },
      resource: { attributes: [], droppedAttributesCount: 0 },
    });
    await f.store.writeWorkspaceExecutionJournalIntent(workspaceId, {
      execution: {
        ref: { owner: { kind: 'workspace', workspaceId }, executionId: 'd0-in-flight' },
        workId: turn.id,
        definitionVersion: WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
        fingerprint: 'a'.repeat(64),
        exclusionRefs: [],
        span: span('1'),
      },
      stepId: 'deliver-start',
      parentStepId: null,
      parent: null,
      inspectedStep: null,
      carriage: {
        operation: 'deliver-start',
        requestId: randomUUID(),
        sequence: null,
        bindingRef: null,
      },
      control: {
        definitionVersion: WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
        kind: 'deliver-start',
        workId: turn.id,
        target: null,
        operationId: null,
        attemptId: null,
        invocationId: randomUUID(),
        actor: { kind: 'user', id: f.ownerId },
        inputRefs: [],
        outputRefs: [],
        fingerprint: 'b'.repeat(64),
        permittingDecisionRef: null,
        authorityRefs: [],
        retryDeclarationRef: null,
        retryPermitted: false,
        deadlineUnixNano: null,
        physicalFenceRefs: [],
      },
      span: { ...span('2'), parentSpanId: '1'.repeat(16) },
    });
    await shutdownControlStoreWorkerClient();
    const parent = await hotParent(f);
    const parentBefore = tree(parent.backupRoot);
    const sourceBefore = databaseRows(workspaceDbPath(f.dataRoot, workspaceId));
    const result = await requiredCapture(
      inputFor(f, { kind: 'data-root-backup', backupRoot: parent.backupRoot })
    );
    expect([...result.report.interruptedTurnIds, ...result.report.unknownEffectTurnIds]).toContain(
      turn.id
    );
    // An unsettled deliver-start intent cannot prove the external effect did not happen.
    expect(result.report.unknownEffectTurnIds).toContain(turn.id);
    expect(tree(parent.backupRoot)).toEqual(parentBefore);
    expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId))).toEqual(sourceBefore);
  }, 120_000);
});

/** Seals real owner-produced snapshots independently of the unimplemented capture function. */
async function sealedFixture(f: Fixture) {
  const parent = await hotParent(f);
  const input = inputFor(f);
  cpSync(join(parent.backupRoot, 'workspaces', workspaceId), input.bundleRoot, { recursive: true });
  for (const omitted of ['indexes', 'logs', 'projections'])
    rmSync(join(input.bundleRoot, omitted), { recursive: true, force: true });
  removeEmptyFixtureDirectories(input.bundleRoot);
  const inventory = inventoryFor(input.bundleRoot);
  const manifest = parseWorkspaceBackupManifest({
    format: 'openkit-workspace-backup',
    version: 1,
    purpose: 'backup',
    backupId: input.backupId,
    workspaceId,
    sourceDeploymentId: f.deploymentId,
    knowledgeBaseIds: [f.knowledgeBaseId],
    capturedRevision: f.revision,
    priorMoves: [],
    release,
    requiredFeatures: [],
    databaseFormats: inventory
      .filter(({ path }) => path.endsWith('.sqlite'))
      .map(({ path }) => ({
        path,
        markers:
          path === 'db/workspace.sqlite'
            ? { 'drizzle.workspace': 17 }
            : { 'drizzle.app.5': 5, 'light-app.kernel.2': 2 },
      })),
    capture: { startedAt: timestamp, completedAt: timestamp, consistency: 'quiescent' },
    inventory,
    inventoryDigest: digest(JSON.stringify(inventory, null, 1)),
    coverage: {
      includedAuthorities: ['workspace-control', 'workspace-content', 'knowledge', 'light-apps'],
      snapshotRoots: readdirSync(input.bundleRoot).filter((name) =>
        lstatSync(join(input.bundleRoot, name)).isDirectory()
      ),
      omittedProjections: ['indexes', 'logs', 'projections'],
      omittedVolumes: [],
      externalDependencies: [],
    },
    accounts: { ownerId: f.ownerId, memberIds: [f.ownerId], privateAudienceRefs: [f.ownerId] },
  });
  writeMetadata(input.bundleRoot, manifest);
  const stageInput: WorkspaceBackupStageInput = {
    ...input,
    candidateRoot: join(f.root, 'target', 'candidate'),
    expectedWorkspaceId: workspaceId,
    expectedSourceDeploymentId: f.deploymentId,
    purpose: 'backup',
  };
  mkdirSync(dirname(stageInput.candidateRoot), { mode: 0o700 });
  // Structural success is fixture admission, never a substitute for full graph verification.
  expect((await verifiedFiles(stageInput)).manifest).toEqual(manifest);
  return { input: stageInput, manifest };
}

/** Inventory spelling and digests are test-owned; metadata never inventories itself. */
function inventoryFor(root: string) {
  return Object.entries(tree(root))
    .filter(
      ([path, fact]) => fact.kind === 'file' && path !== 'manifest.json' && path !== 'seal.json'
    )
    .map(([path, fact]) => ({
      path,
      bytes: readFileSync(join(root, path)).length,
      sha256: fact.digest!,
      mode: fact.mode,
    }));
}

/** The v1 file inventory represents parent directories only; an empty fixture directory is not content. */
function removeEmptyFixtureDirectories(root: string): void {
  for (const [path, fact] of Object.entries(tree(root)).reverse()) {
    if (path && fact.kind === 'directory' && readdirSync(join(root, path)).length === 0)
      rmdirSync(join(root, path));
  }
}

/** Preserve a deliberately noncompact inventory byte span and bind the seal to the raw manifest. */
function writeMetadata(root: string, manifest: WorkspaceBackupManifest): void {
  const { inventory, ...facts } = manifest;
  const raw = `${JSON.stringify(facts).slice(0, -1)},"inventory":${JSON.stringify(inventory, null, 1)}}\n`;
  writeFileSync(join(root, 'manifest.json'), raw, { mode: 0o600 });
  writeFileSync(
    join(root, 'seal.json'),
    JSON.stringify({
      format: 'openkit-workspace-backup-seal',
      version: 1,
      backupId: manifest.backupId,
      purpose: manifest.purpose,
      manifestDigest: digest(raw),
    }),
    { mode: 0o600 }
  );
}

/** A required result is an explicit resolution assertion, so not-implemented cannot masquerade as success. */
async function requiredCapture(input: WorkspaceBackupCreateInput) {
  const promise = createWorkspaceBackup(input);
  await expect(promise).resolves.toMatchObject({
    purpose: input.purpose,
    disposition: input.purpose === 'backup' ? 'sealed' : 'prepared',
  });
  return promise;
}

describe('D0-1: full staging, independently sealed real-owner fixtures', () => {
  it('Fixture control: real owner graph, hot parent and independent seal pass the landed structural verifier', async () => {
    const f = await fixture();
    const { input, manifest } = await sealedFixture(f);
    expect(manifest.databaseFormats).toEqual(
      expect.arrayContaining([
        { path: 'db/workspace.sqlite', markers: { 'drizzle.workspace': 17 } },
        {
          path: `light-apps/${f.app.appId}/data.sqlite`,
          markers: { 'drizzle.app.5': 5, 'light-app.kernel.2': 2 },
        },
      ])
    );
    expect(databaseRows(join(input.bundleRoot, 'db/workspace.sqlite'))).toEqual(f.rows);
    expect(manifest.inventory.length).toBeGreaterThan(0);
  }, 120_000);

  it('WM 379–380 / addendum: exact Workspace-relative bytes stage privately without metadata or replacement databases', async () => {
    const f = await fixture();
    const { input, manifest } = await sealedFixture(f);
    const sourceBefore = tree(f.dataRoot);
    const bundleBefore = tree(input.bundleRoot);
    const promise = stageWorkspaceBackup(input);
    await expect(promise).resolves.toMatchObject({
      disposition: 'staged',
      candidateRoot: input.candidateRoot,
      manifest,
    });
    const result = await promise;
    expect(lstatSync(input.candidateRoot).mode & 0o777).toBe(0o700);
    expect(result.report).toMatchObject({
      backupId: manifest.backupId,
      workspaceId,
      sourceDeploymentId: f.deploymentId,
      knowledgeBaseIds: [f.knowledgeBaseId],
      capturedRevision: f.revision,
      manifestDigest: digest(readFileSync(join(input.bundleRoot, 'manifest.json'))),
      fileCount: manifest.inventory.length,
      totalBytes: manifest.inventory.reduce((sum, entry) => sum + entry.bytes, 0),
      coverage: manifest.coverage,
      interruptedTurnIds: [],
      unknownEffectTurnIds: [],
    });
    expect(inventoryFor(input.candidateRoot)).toEqual(manifest.inventory);
    expect(existsSync(join(input.candidateRoot, 'manifest.json'))).toBe(false);
    expect(existsSync(join(input.candidateRoot, 'seal.json'))).toBe(false);
    expect(databaseRows(join(input.candidateRoot, 'db/workspace.sqlite'))).toEqual(f.rows);
    expect(tree(input.bundleRoot)).toEqual(bundleBefore);
    expect(tree(f.dataRoot)).toEqual(sourceBefore);
    expect(JSON.stringify(result.report)).not.toContain(f.root);
  }, 120_000);

  it.each([
    ['omitted retained body', 'incomplete-closure', true],
    ['omitted Workspace database', 'incomplete-closure', true],
    ['invalid SQLite with valid file digest', 'invalid-database', true],
    ['wrong database identity', 'invalid-database', true],
    ['tampered bytes', 'invalid-bundle', false],
    ['extra file', 'invalid-bundle', false],
    ['duplicate entry', 'invalid-bundle', false],
    ['unsafe inventory path', 'unsafe-path', false],
    ['symlinked bytes', 'unsafe-path', false],
    ['missing seal', 'invalid-bundle', false],
    ['wrong manifest binding', 'invalid-bundle', false],
    ['inventory digest mismatch', 'invalid-bundle', false],
    ['wrong release', 'release-mismatch', false],
    ['unknown required feature', 'unsupported-format', false],
    ['unknown database marker', 'unsupported-format', false],
    ['wrong expected purpose', 'invalid-bundle', true],
  ] as const)(
    'WM 355–363, 370, 379–380: %s refuses with %s',
    async (fault, code, structurallyValid) => {
      const f = await fixture();
      const sealed = await sealedFixture(f);
      let { input, manifest } = sealed;
      const body = manifest.inventory.find(({ path }) =>
        path.startsWith('evidence/backend/sha256/')
      )!;
      const bodyPath = join(input.bundleRoot, body.path);
      if (fault === 'omitted retained body') rmSync(bodyPath);
      if (fault === 'omitted Workspace database') {
        rmSync(join(input.bundleRoot, 'db/workspace.sqlite'));
        manifest = {
          ...manifest,
          databaseFormats: manifest.databaseFormats.filter(
            ({ path }) => path !== 'db/workspace.sqlite'
          ),
        };
      }
      if (fault === 'invalid SQLite with valid file digest')
        writeFileSync(join(input.bundleRoot, 'db/workspace.sqlite'), 'NOT-SQLITE');
      if (fault === 'wrong database identity') {
        const db = new Database(join(input.bundleRoot, 'db/workspace.sqlite'), {
          fileMustExist: true,
        });
        try {
          // Corrupt only identity, retaining the actual schema, every row and a valid SQLite file.
          db.prepare(
            "UPDATE control_workspaces SET record_json=json_set(record_json, '$.id', ?) WHERE id=?"
          ).run(allocateEntityId('ws'), workspaceId);
        } finally {
          db.close();
        }
      }
      if (structurallyValid) {
        removeEmptyFixtureDirectories(input.bundleRoot);
        const inventory = inventoryFor(input.bundleRoot);
        manifest = {
          ...manifest,
          inventory,
          inventoryDigest: digest(JSON.stringify(inventory, null, 1)),
        };
      }
      if (fault === 'duplicate entry' || fault === 'unsafe inventory path') {
        const inventory =
          fault === 'duplicate entry'
            ? [...manifest.inventory, body]
            : manifest.inventory.map((entry) =>
                entry === body ? { ...entry, path: '../outside' } : entry
              );
        manifest = {
          ...manifest,
          inventory,
          inventoryDigest: digest(JSON.stringify(inventory, null, 1)),
        };
      }
      if (fault === 'inventory digest mismatch')
        manifest = { ...manifest, inventoryDigest: `sha256:${'0'.repeat(64)}` };
      if (fault === 'wrong release')
        manifest = { ...manifest, release: { ...release, buildId: 'another-build' } };
      if (fault === 'unknown required feature')
        manifest = { ...manifest, requiredFeatures: ['workspace.d0.unsupported-fixture'] };
      if (fault === 'unknown database marker')
        manifest = {
          ...manifest,
          databaseFormats: manifest.databaseFormats.map((entry) => ({
            ...entry,
            markers: { 'unknown.database': 1 },
          })),
        };
      writeMetadata(input.bundleRoot, manifest);
      if (fault === 'tampered bytes') {
        chmodSync(bodyPath, 0o600);
        writeFileSync(bodyPath, 'TAMPERED-BODY');
        chmodSync(bodyPath, body.mode);
      }
      if (fault === 'extra file') writeFileSync(join(input.bundleRoot, 'extra'), 'EXTRA-BYTES');
      if (fault === 'symlinked bytes') {
        const outside = join(f.root, 'outside');
        writeFileSync(outside, readFileSync(bodyPath));
        rmSync(bodyPath);
        symlinkSync(outside, bodyPath);
      }
      if (fault === 'missing seal') rmSync(join(input.bundleRoot, 'seal.json'));
      if (fault === 'wrong manifest binding')
        writeFileSync(
          join(input.bundleRoot, 'manifest.json'),
          `${readFileSync(join(input.bundleRoot, 'manifest.json'), 'utf8')}\n`
        );
      if (fault === 'wrong expected purpose') input = { ...input, purpose: 'move' };
      if (structurallyValid) expect((await verifiedFiles(input)).manifest).toEqual(manifest);
      const sourceBefore = tree(f.dataRoot);
      const bundleBefore = tree(input.bundleRoot);
      const error: unknown = await stageWorkspaceBackup(input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkspaceRecoveryError);
      expect((error as WorkspaceRecoveryError).code).toBe(code);
      expect(tree(f.dataRoot)).toEqual(sourceBefore);
      expect(tree(input.bundleRoot)).toEqual(bundleBefore);
      // An absent required authority must remain absent, even in an inspectable failed candidate.
      if (fault === 'omitted Workspace database')
        expect(existsSync(join(input.candidateRoot, 'db/workspace.sqlite'))).toBe(false);
      expect(String(error)).not.toContain(f.root);
      expect(String(error)).not.toContain('TAMPERED-BODY');
    },
    120_000
  );

  it('WM 346, 373, 389: stage preserves an unrelated candidate and returns candidate-conflict', async () => {
    const f = await fixture();
    const { input } = await sealedFixture(f);
    mkdirSync(input.candidateRoot);
    writeFileSync(join(input.candidateRoot, 'unrelated'), 'DO-NOT-REPLACE');
    const before = tree(input.candidateRoot);
    await expect(stageWorkspaceBackup(input)).rejects.toMatchObject({ code: 'candidate-conflict' });
    expect(tree(input.candidateRoot)).toEqual(before);
  }, 120_000);

  it('WM 346: stage capacity failure is capacity-exceeded, without source changes', async () => {
    const f = await fixture();
    const { input } = await sealedFixture(f);
    const before = tree(input.bundleRoot);
    await expect(
      stageWorkspaceBackup({
        ...input,
        admission: new FileStorageAdmission(
          f.root,
          () => 0n,
          () => 0n
        ),
      })
    ).rejects.toMatchObject({ code: 'capacity-exceeded' });
    expect(tree(input.bundleRoot)).toEqual(before);
  }, 120_000);
});
