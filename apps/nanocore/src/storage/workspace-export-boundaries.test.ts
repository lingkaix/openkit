import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
// openkit-test-platform: posix

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { WORKSPACE_RESOURCE_POLICY_FEATURE } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { operationRequest } from '../test-support/operation-request.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { loadWorkspaceFileRecords } from './workspace-file-records.js';

const timestamp = '2026-07-12T00:00:00.000Z';

/** Returns the smallest complete workspace export input. */
function minimalExportInput(
  exportRoot: string,
  workspaceId = 'ws_00000000-0000-7000-8000-000000000001',
  exportId = 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4'
): Parameters<typeof writeWorkspaceExportTree>[0] {
  const knowledgeBaseId = allocateEntityId('kb');
  return {
    exportRoot,
    exportId,
    sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
    createdAt: timestamp,
    workspace: {
      id: workspaceId,
      name: 'Boundary workspace',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    threads: [],
    turns: [],
    knowledge: [],
    itemRevisions: [],
    artifacts: [],
    artifactReviews: [],
    threadMaterialBindings: [],
    workspaceMaterialRevisions: [],
    workspaceMaterials: [],
    agentSessions: [],
    turnEvents: [],
    portableFileState: {
      nativeKnowledgePages: new Map(),
      retrievalTraceFiles: new Map(),
      workerContextPackageFiles: new Map(),
      workspaceConfig: JSON.stringify({
        schemaVersion: 1,
        workspace: {
          name: 'Boundary workspace',
          defaultAgentId: null,
          defaultKnowledgeBaseId: knowledgeBaseId,
          knowledgeMounts: [
            { knowledgeBaseId, name: 'default', backend: 'local', root: 'raw', default: true },
          ],
        },
      }),
      workspaceSchema: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    },
  };
}

/** Returns one valid source record for export-boundary tests. */
function knowledgeSource(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    kind: 'document',
    title: 'Boundary source',
    uri: null,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Creates a file-backed route store containing the legacy demo workspace. */
async function createBoundaryStore(dataRoot: string): Promise<FsStore> {
  const store = createTestStore({ dataRoot });
  const demo = createDemoWorkspaceForUser('usr_00000000-0000-7000-8000-000000000001');
  await store.importWorkspaceSnapshot({
    ...notebookImportFixture({ workspaceId: demo.workspace.id, knowledge: demo.knowledge }),
    workspace: demo.workspace,
    threads: [demo.thread],
    knowledge: demo.knowledge,
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  });
  return store;
}

const boundaryDatabases: Array<ReturnType<typeof openCoreDb>> = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of boundaryDatabases.splice(0)) if (db.sqlite.open) db.sqlite.close();
});

/** Supplies the explicitly named local source owner's durable authority to JSON transfer fixtures. */
function boundaryAuthority(dataRoot: string, workspaceId: string) {
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId,
  });
  boundaryDatabases.push(coreDb);
  return coreDb;
}

/** Parses regular-file bytes from one canonical tar archive. */
function readTarRegularFiles(archive: Buffer): ReadonlyMap<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > archive.length ||
        !archive.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
        !archive.subarray(offset + 1024).every((byte) => byte === 0)
      ) {
        throw new Error('Tar archive has an invalid end marker.');
      }
      return files;
    }

    const readText = (start: number, length: number) => {
      const field = header.subarray(start, start + length);
      const terminator = field.indexOf(0);
      return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8');
    };
    const readOctal = (start: number, length: number) => {
      const text = readText(start, length).trim();
      return text ? Number.parseInt(text, 8) : 0;
    };
    const name = readText(0, 100);
    const prefix = readText(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = readText(124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Tar entry has an invalid size: ${path}`);
    }
    const type = header[156];
    const expectedMode = type === 53 ? 0o755 : 0o644;
    if (
      readOctal(100, 8) !== expectedMode ||
      readOctal(108, 8) !== 0 ||
      readOctal(116, 8) !== 0 ||
      readOctal(136, 12) !== 0 ||
      readText(265, 32) !== '' ||
      readText(297, 32) !== ''
    ) {
      throw new Error(`Tar entry metadata is not canonical: ${path}`);
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) {
      throw new Error(`Tar entry is truncated: ${path}`);
    }
    if (type === 0 || type === 48) {
      if (files.has(path)) {
        throw new Error(`Tar archive repeats a regular file: ${path}`);
      }
      files.set(path, Buffer.from(archive.subarray(contentStart, contentEnd)));
    } else if (type !== 53) {
      throw new Error(`Tar archive contains an unsupported entry type: ${path}`);
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  throw new Error('Tar archive has no end marker.');
}

describe('workspace export filesystem boundaries', () => {
  it('rejects unsafe Source identities before writing outside the export', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-source-boundary-'));
    const unsafeId = '../../../outside-source';

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(join(parent, 'source-export')),
        knowledgeSources: [knowledgeSource(unsafeId)],
      })
    ).toThrow(ZodError);

    expect(existsSync(join(parent, 'outside-source'))).toBe(false);
  });

  it('requires a fresh real export directory so stale files cannot leak', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-fresh-root-'));
    const emptyRoot = join(parent, 'empty-export');
    mkdirSync(emptyRoot);

    expect(() => writeWorkspaceExportTree(minimalExportInput(emptyRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(emptyRoot)).toBe(true);

    const exportRoot = join(parent, 'export');
    mkdirSync(join(exportRoot, 'records'), { recursive: true });
    writeFileSync(join(exportRoot, 'records', 'knowledge-proposals.jsonl'), '{"stale":true}\n');
    const staleArtifact = join(
      exportRoot,
      'artifacts',
      'ar_00000000-0000-7061-bae6-24a979165303',
      'files',
      'content.md'
    );
    mkdirSync(dirname(staleArtifact), { recursive: true });
    writeFileSync(staleArtifact, 'stale artifact');

    expect(() => writeWorkspaceExportTree(minimalExportInput(exportRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(join(exportRoot, 'records', 'workspace-record.json'))).toBe(false);

    const target = join(parent, 'symlink-target');
    mkdirSync(target);
    const linkedRoot = join(parent, 'linked-export');
    symlinkSync(target, linkedRoot);
    expect(() => writeWorkspaceExportTree(minimalExportInput(linkedRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(join(target, 'records', 'workspace-record.json'))).toBe(false);
  });

  it('removes a partial export tree when writing fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-failed-write-'));
    const exportRoot = join(parent, 'export');

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(exportRoot),
        knowledgeSources: [knowledgeSource('ks_00000000-0000-7e65-a399-d53a84c98ecb')],
      })
    ).toThrow(/canonical Notebook/i);
    expect(existsSync(exportRoot)).toBe(false);
  });

  it('rejects a basename that cannot fit strict USTAR before accepting the export', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-ustar-path-'));
    const exportRoot = join(parent, 'export');
    const input = minimalExportInput(exportRoot);

    expect(() =>
      writeWorkspaceExportTree({
        ...input,
        portableFileState: {
          ...input.portableFileState!,
          nativeKnowledgePages: new Map([
            [
              `knowledge/pages/${'a'.repeat(101)}.md`,
              '---\ntype: "RepoConvention"\ntitle: "Too long for USTAR"\n---\nPortable.\n',
            ],
          ]),
        },
      })
    ).toThrow(/POSIX USTAR/);
    expect(existsSync(exportRoot)).toBe(false);
  });

  it('rejects an existing verified tree whose basename cannot fit strict USTAR', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-verify-ustar-path-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const originalPath = 'workspace-files/config/workspace.jsonc';
    const longPath = `workspace-files/knowledge/pages/${'a'.repeat(101)}.md`;
    mkdirSync(dirname(join(exportRoot, longPath)), { recursive: true });
    renameSync(join(exportRoot, originalPath), join(exportRoot, longPath));
    const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contentDigest: string;
      contentInventory: Array<{ path: string; digest: string; bytes: number }>;
    };
    const entry = manifest.contentInventory.find((candidate) => candidate.path === originalPath);
    if (!entry) throw new Error('Expected workspace config inventory entry.');
    entry.path = longPath;
    manifest.contentInventory.sort((left, right) => left.path.localeCompare(right.path));
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyWorkspaceExportTree({ exportRoot })).toThrow(/POSIX USTAR/);
  });

  it('rejects symlink and non-directory verifier roots before reading a manifest', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-verify-root-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const linkedRoot = join(parent, 'linked-export');
    symlinkSync(exportRoot, linkedRoot);
    const fileRoot = join(parent, 'not-a-directory');
    writeFileSync(fileRoot, 'not a directory');

    expect(() => verifyWorkspaceExportTree({ exportRoot: linkedRoot })).toThrow(
      /Export root must be a real directory/
    );
    expect(() => verifyWorkspaceExportTree({ exportRoot: fileRoot })).toThrow(
      /Export root must be a real directory/
    );
  });

  it('rejects a manifest whose content digest does not cover its inventory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-manifest-digest-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { contentDigest: string };

    manifest.contentDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyWorkspaceExportTree({ exportRoot })).toThrow(/content digest/i);
  });

  it('returns the exact file contents and manifest digest checked by one verification', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-verified-contents-'));
    const exportRoot = join(parent, 'export');
    writeWorkspaceExportTree(minimalExportInput(exportRoot));
    const verified = verifyWorkspaceExportTree({ exportRoot }) as ReturnType<
      typeof verifyWorkspaceExportTree
    > & {
      fileContents?: ReadonlyMap<string, string>;
      manifestDigest?: string;
    };
    const workspacePath = join(exportRoot, 'records', 'workspace-record.json');
    const manifestText = readFileSync(join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE), 'utf8');

    expect(verified.fileContents?.get('records/workspace-record.json')).toBe(
      readFileSync(workspacePath, 'utf8')
    );
    expect(verified.manifestDigest).toBe(
      `sha256:${createHash('sha256').update(manifestText).digest('hex')}`
    );
  });

  it('does not remove external staging through a linked workspaces directory', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-staging-link-'));
    const external = mkdtempSync(join(tmpdir(), 'openkit-workspace-staging-external-'));
    const marker = join(external, '.staging', 'keep.txt');
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, 'keep');
    symlinkSync(external, join(dataRoot, 'workspaces'));

    expect(() =>
      loadWorkspaceFileRecords(dataRoot, 'usr_00000000-0000-7000-8000-000000000001')
    ).toThrow();
    expect(readFileSync(marker, 'utf8')).toBe('keep');
  });
});

describe('workspace export route boundaries', () => {
  it('streams one zstd workspace archive from the verified export', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-archive-'));
    const store = await createBoundaryStore(dataRoot);
    const app = await createApp({
      coreDb: boundaryAuthority(dataRoot, 'ws_00000000-0000-7000-8000-000000000001'),
      dataRoot,
      store,
    });
    const exportResponse = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          method: 'POST',
        }
      )
    );
    const exported = (await exportResponse.json()) as { exportId: string };
    const exportRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      exported.exportId
    );
    const verified = verifyWorkspaceExportTree({ exportRoot });
    const expectedFiles = new Map<string, Buffer>([
      [
        WORKSPACE_EXPORT_MANIFEST_FILE,
        readFileSync(join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE)),
      ],
      ...[...verified.fileContents].map(([path, text]) => [path, Buffer.from(text)] as const),
    ]);

    const response = await app.request(
      `/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/exports/${exported.exportId}/archive`
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openkit.workspace-export+tar.zstd'
    );
    const archivedFiles = readTarRegularFiles(
      zstdDecompressSync(Buffer.from(await response.arrayBuffer()))
    );
    expect([...archivedFiles.keys()]).toEqual(
      [...expectedFiles.keys()].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right))
      )
    );
    for (const [path, expected] of expectedFiles) {
      expect(archivedFiles.get(path), path).toEqual(expected);
    }
  });

  it('exports a knowledge page path that needs a USTAR prefix', async () => {
    const sourceDataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-ustar-source-'));
    const sourceStore = await createBoundaryStore(sourceDataRoot);
    const sourceApp = await createApp({
      coreDb: boundaryAuthority(sourceDataRoot, 'ws_00000000-0000-7000-8000-000000000001'),
      dataRoot: sourceDataRoot,
      store: sourceStore,
    });
    const pagePath = `knowledge/pages/${'a'.repeat(60)}/${'b'.repeat(60)}.md`;
    const pageContent = serializeKnowledgePageFixture(
      {
        title: 'USTAR prefix page',
        content: 'Portable.',
        sourceReferences: [],
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }
    );
    const notebookResponse = await sourceApp.request(
      ...operationRequest('knowledge.notebook.list', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );
    expect(notebookResponse.status, await notebookResponse.clone().text()).toBe(200);
    const { notebookRevision } = (await notebookResponse.json()) as { notebookRevision: string };
    const created = await sourceApp.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          baseRevision: notebookRevision,
          path: `${pagePath.slice('knowledge/pages/'.length, -3)}.md`,
          content: pageContent,
          summary: 'Publish explicit full-page fixture',
        },
        { headers: { 'x-openkit-request-id': '00000000-0000-4000-8000-000000000991' } }
      )
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const exportedResponse = await sourceApp.request(
      ...operationRequest('workspace.export', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    );
    expect(exportedResponse.status, await exportedResponse.clone().text()).toBe(200);
    const { exportId } = (await exportedResponse.json()) as { exportId: string };
    const archiveResponse = await sourceApp.request(
      `/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/exports/${exportId}/archive`
    );
    expect(archiveResponse.status, await archiveResponse.clone().text()).toBe(200);
    const archived = readTarRegularFiles(
      zstdDecompressSync(Buffer.from(await archiveResponse.arrayBuffer()))
    );
    const archivedPath = `workspace-files/${pagePath}`;
    expect(archived.has(archivedPath)).toBe(true);
    expect(archived.get(archivedPath)).toEqual(Buffer.from(pageContent));
  });

  it('fails closed when a worker-backed Turn has no S39 trace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-s39-'));
    const store = await createBoundaryStore(dataRoot);
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Export an untraced worker Turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const session = await store.createAgentSession({
      id: 'as_00000000-0000-7191-a06d-dfd2a31b7d87',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      status: 'busy',
      message: null,
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    await store.updateTurn(turn.id, { agentSessionId: session.id });
    const app = await createApp({
      coreDb: boundaryAuthority(dataRoot, 'ws_00000000-0000-7000-8000-000000000001'),
      dataRoot,
      store,
    });
    app.onError((error) => new Response(error.message, { status: 500 }));

    const response = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        { method: 'POST' }
      )
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Worker Context Package coverage is incomplete.');
    expect(
      readdirSync(
        join(dataRoot, 'server', 'exports', 'workspaces', 'ws_00000000-0000-7000-8000-000000000001')
      )
    ).toEqual([]);
  });
});

describe('Workspace resource Policy portability', () => {
  it('exports a last-revoke boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resource-policy-portable-'));
    try {
      const store = new FsStore();
      const workspace = await store.createWorkspace('Boundary workspace');
      const thread = await store.createThread(workspace.id, 'Managed Thread');
      const input = minimalExportInput(
        join(root, 'export'),
        workspace.id,
        allocateEntityId('wsexp')
      );
      input.threads = [thread];
      const userId = allocateEntityId('usr');
      const boundary = managedThreadPolicy({
        workspaceId: workspace.id,
        threadId: thread.id,
        userId,
      });
      const sourceConfig = JSON.parse(input.portableFileState!.workspaceConfig!);
      input.portableFileState!.workspaceConfig = JSON.stringify({
        ...sourceConfig,
        requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
        workspace: { ...sourceConfig.workspace, policy: { mediation: boundary } },
      });
      const verified = writeWorkspaceExportTree(input);
      expect(verified.manifest.requiredFeatures).toContain(WORKSPACE_RESOURCE_POLICY_FEATURE);
      const exported = parseJsonc(
        verified.fileContents.get('workspace-files/config/workspace.jsonc')!
      );
      expect(exported.workspace.policy.mediation).toEqual(boundary);
    } finally {
      await shutdownControlStoreWorkerClient();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
