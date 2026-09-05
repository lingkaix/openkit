// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import {
  cleanupWorkspaceArchiveRequestStaging,
  stageWorkspaceArchive,
} from './workspace-archive.js';
import {
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { loadWorkspaceFileRecords } from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

const timestamp = '2026-07-12T00:00:00.000Z';

/** Returns a Better Auth test double for one signed-in canonical user. */
function authForUser(userId: string): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({ session: { id: `session_${userId}` }, user: { id: userId } }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/** Returns the smallest complete workspace export input. */
function minimalExportInput(
  exportRoot: string,
  workspaceId = 'ws_demo',
  exportId = 'wsexp_demo'
): Parameters<typeof writeWorkspaceExportTree>[0] {
  return {
    exportRoot,
    exportId,
    sourceDeploymentId: 'dep_source',
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
      claims: new Map(),
      conflicts: new Map(),
      nativeKnowledgePages: new Map(),
      observations: new Map(),
      retrievalTraces: new Map(),
      workerContextPackageFiles: new Map(),
      workspaceConfig: JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Boundary workspace', defaultAgentId: null },
      }),
      workspaceSchema: null,
    },
  };
}

/** Returns one valid source record for export-boundary tests. */
function knowledgeSource(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'ws_demo',
    kind: 'document',
    title: 'Boundary source',
    uri: null,
    contentDigest: 'sha256:source',
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Creates a file-backed route store containing the legacy demo workspace. */
function createBoundaryStore(dataRoot: string): FsStore {
  const store = new FsStore({ dataRoot });
  const demo = createDemoWorkspaceForUser('user_local');
  store.importWorkspaceSnapshot({
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

/** Returns open descriptors still owned by one archive-request staging namespace. */
function openArchiveStagingDescriptors(dataRoot: string): string[] {
  const stagingRoot = join(dataRoot, 'server', 'files', 'workspace-archive-requests');
  return readdirSync('/proc/self/fd').flatMap((descriptor) => {
    try {
      const target = readlinkSync(join('/proc/self/fd', descriptor));
      return target.includes(stagingRoot) ? [target] : [];
    } catch {
      return [];
    }
  });
}

/** Rewrites one regular-file header to keep its staging descriptor open after a partial body. */
function tarHeaderWithDeclaredSize(header: Buffer, size: number): Buffer {
  const rewritten = Buffer.from(header);
  rewritten.fill(0, 124, 136);
  rewritten.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  rewritten.fill(32, 148, 156);
  let checksum = 0;
  for (const byte of rewritten) checksum += byte;
  rewritten.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return rewritten;
}

/** Creates one compressed tar fixture without touching a filesystem. */
async function archiveWithEntry(
  header: { name: string; type: 'file' | 'symlink'; linkname?: string },
  content = Buffer.alloc(0)
): Promise<Buffer> {
  const rawHeader = Buffer.alloc(512);
  rawHeader.write(header.name, 0, 100, 'utf8');
  rawHeader.write('0000644\0', 100, 8, 'ascii');
  rawHeader.write('0000000\0', 108, 8, 'ascii');
  rawHeader.write('0000000\0', 116, 8, 'ascii');
  rawHeader.write('00000000000\0', 136, 12, 'ascii');
  rawHeader[156] = header.type === 'symlink' ? 50 : 48;
  if (header.linkname) rawHeader.write(header.linkname, 157, 100, 'utf8');
  rawHeader.write('ustar\0', 257, 6, 'ascii');
  rawHeader.write('00', 263, 2, 'ascii');
  const canonicalHeader = tarHeaderWithDeclaredSize(rawHeader, content.byteLength);
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return zstdCompressSync(Buffer.concat([canonicalHeader, content, padding, Buffer.alloc(1024)]));
}

describe('workspace export filesystem boundaries', () => {
  it('rejects unsafe knowledge source and material ids before writing outside the export', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-export-source-boundary-'));
    const unsafeId = '../../../outside-source';

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(join(parent, 'source-export')),
        knowledgeSources: [knowledgeSource(unsafeId)],
      })
    ).toThrow(/safe path segment/i);

    expect(() =>
      writeWorkspaceExportTree({
        ...minimalExportInput(join(parent, 'material-export')),
        knowledgeSourceMaterials: [{ sourceId: unsafeId, content: 'must stay contained' }],
      })
    ).toThrow(/safe path segment/i);
    expect(existsSync(join(parent, 'outside-source', 'content.txt'))).toBe(false);
  });

  it('rejects an unsafe persisted source id before reading material outside the export', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-import-source-boundary-'));
    const exportRoot = join(parent, 'export');
    const safeId = 'ks_safe';
    const unsafeId = '../../../outside-source';
    writeWorkspaceExportTree({
      ...minimalExportInput(exportRoot),
      knowledgeSources: [knowledgeSource(safeId)],
    });

    const sourcePath = join(exportRoot, 'records', 'knowledge-sources.jsonl');
    const sourceText = `${JSON.stringify(knowledgeSource(unsafeId))}\n`;
    writeFileSync(sourcePath, sourceText);
    const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contentDigest: string;
      contentInventory: Array<{ path: string; digest: string; bytes: number }>;
    };
    const sourceEntry = manifest.contentInventory.find(
      (entry) => entry.path === 'records/knowledge-sources.jsonl'
    );
    if (!sourceEntry) {
      throw new Error('Expected knowledge source inventory entry.');
    }
    sourceEntry.bytes = Buffer.byteLength(sourceText);
    sourceEntry.digest = `sha256:${createHash('sha256').update(sourceText).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const outsideMaterial = join(parent, 'outside-source', 'content.txt');
    mkdirSync(dirname(outsideMaterial), { recursive: true });
    writeFileSync(outsideMaterial, 'external material');

    expect(() =>
      readWorkspaceImportSnapshot({
        verified: verifyWorkspaceExportTree({ exportRoot }),
        targetWorkspaceId: 'ws_imported',
      })
    ).toThrow(/safe path segment/i);
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
    const staleArtifact = join(exportRoot, 'artifacts', 'ar_stale', 'files', 'content.md');
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
        knowledgeSourceMaterials: [{ sourceId: 'ks_missing', content: 'partial content' }],
      })
    ).toThrow(/references missing source/i);
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

    expect(() => loadWorkspaceFileRecords(dataRoot, 'user_local')).toThrow();
    expect(readFileSync(marker, 'utf8')).toBe('keep');
  });
});

describe('workspace export route boundaries', () => {
  it('streams one zstd workspace archive from the verified export', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-archive-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const exportRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      'ws_demo',
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
      `/api/app/workspaces/ws_demo/exports/${exported.exportId}/archive`
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

  it('round-trips Unicode and USTAR prefix paths through the strict archive importer', async () => {
    const sourceDataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-unicode-source-'));
    const sourceStore = createBoundaryStore(sourceDataRoot);
    const exportId = 'wsexp_unicode';
    const exportRoot = join(sourceDataRoot, 'server', 'exports', 'workspaces', 'ws_demo', exportId);
    mkdirSync(dirname(exportRoot), { recursive: true });
    const input = minimalExportInput(exportRoot, 'ws_demo', exportId);
    const pagePath = `knowledge/pages/分类/${'a'.repeat(90)}.md`;
    writeWorkspaceExportTree({
      ...input,
      sourceDeploymentId: readDataRootLayoutMarker(sourceDataRoot).deploymentId,
      portableFileState: {
        ...input.portableFileState!,
        nativeKnowledgePages: new Map([
          [pagePath, '---\ntype: "RepoConvention"\ntitle: "Unicode archive"\n---\nPortable.\n'],
        ]),
      },
    });
    const archiveResponse = await createApp({
      dataRoot: sourceDataRoot,
      store: sourceStore,
    }).request(`/api/app/workspaces/ws_demo/exports/${exportId}/archive`);
    expect(archiveResponse.status, await archiveResponse.clone().text()).toBe(200);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    expect(
      readTarRegularFiles(zstdDecompressSync(archive)).has(`workspace-files/${pagePath}`)
    ).toBe(true);

    const targetDataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-unicode-target-'));
    const targetResponse = await createApp({
      dataRoot: targetDataRoot,
      store: createBoundaryStore(targetDataRoot),
    }).request('/api/app/workspace-archives/import-dry-run', {
      body: archive,
      headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      method: 'POST',
    });

    expect(targetResponse.status, await targetResponse.clone().text()).toBe(200);
  });

  it('fails closed when a worker-backed Turn has no S39 trace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-s39-'));
    const store = createBoundaryStore(dataRoot);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Export an untraced worker Turn', {
      kind: 'user',
      id: 'user_local',
    });
    const session = store.createAgentSession({
      id: 'as_export_missing_trace',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'busy',
      message: null,
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    store.updateTurn(turn.id, { agentSessionId: session.id });
    const app = createApp({ dataRoot, store });
    app.onError((error) => new Response(error.message, { status: 500 }));

    const response = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Worker Context Package coverage is incomplete.');
    expect(readdirSync(join(dataRoot, 'server', 'exports', 'workspaces', 'ws_demo'))).toEqual([]);
  });
});

describe('workspace import route handles', () => {
  it('adds a missing root index while preserving imported reserved Markdown bytes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-okf-index-'));
    const store = createBoundaryStore(dataRoot);
    const exportId = 'wsexp_missing_okf_index';
    const exportRoot = join(dataRoot, 'server', 'exports', 'workspaces', 'ws_demo', exportId);
    const nestedIndex = '# Imported topic index\n\nKeep this navigation byte-for-byte.\n';
    const nestedLog = '# Imported topic log\n\nKeep this history byte-for-byte.\n';
    const input = minimalExportInput(exportRoot, 'ws_demo', exportId);
    mkdirSync(dirname(exportRoot), { recursive: true });
    writeWorkspaceExportTree({
      ...input,
      sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      portableFileState: {
        ...input.portableFileState!,
        nativeKnowledgePages: new Map([
          ['knowledge/pages/topic/index.md', nestedIndex],
          ['knowledge/pages/topic/log.md', nestedLog],
        ]),
      },
    });

    const response = await createApp({ dataRoot, store }).request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as { importedWorkspaceId: string };
    const pagesRoot = join(
      dataRoot,
      'workspaces',
      result.importedWorkspaceId,
      'knowledge',
      'pages'
    );
    expect(readFileSync(join(pagesRoot, 'index.md'), 'utf8')).toBe(
      '---\nokf_version: "0.2"\n---\n# Knowledge\n\n* [topic](<topic/>)\n'
    );
    expect(readFileSync(join(pagesRoot, 'topic', 'index.md'), 'utf8')).toBe(nestedIndex);
    expect(readFileSync(join(pagesRoot, 'topic', 'log.md'), 'utf8')).toBe(nestedLog);
  });

  it.each([
    'dry-run',
    'import',
  ] as const)('rejects an unrelated-deployment server-managed handle on %s', async (route) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-foreign-handle-'));
    const store = createBoundaryStore(dataRoot);
    const exportRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      'ws_demo',
      'wsexp_foreign'
    );
    mkdirSync(dirname(exportRoot), { recursive: true });
    writeWorkspaceExportTree(minimalExportInput(exportRoot, 'ws_demo', 'wsexp_foreign'));
    const app = createApp({ dataRoot, store });
    const beforeWorkspaceIds = store.listWorkspaces().map((workspace) => workspace.id);
    const collisionRoot = join(dataRoot, 'workspaces', 'ws_imported_ws_demo');

    const response = await app.request(
      route === 'dry-run' ? '/api/app/workspace-imports/dry-run' : '/api/app/workspace-imports',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceWorkspaceId: 'ws_demo',
          exportId: 'wsexp_foreign',
        }),
      }
    );

    expect.soft(response.status).toBe(403);
    expect.soft(await response.json()).toMatchObject({ code: 'workspace_import_forbidden' });
    expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(beforeWorkspaceIds);
    expect(existsSync(collisionRoot)).toBe(false);
  });

  it.each([
    ['dry-run', 'sourceWorkspaceId'],
    ['dry-run', 'exportId'],
    ['import', 'sourceWorkspaceId'],
    ['import', 'exportId'],
  ] as const)('rejects %s when the requested %s disagrees with the manifest', async (route, field) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-handle-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const requestedWorkspaceId = field === 'sourceWorkspaceId' ? 'ws_wrong_handle' : 'ws_demo';
    const requestedExportId = field === 'exportId' ? 'wsexp_wrong_handle' : exported.exportId;
    const originalRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      'ws_demo',
      exported.exportId
    );
    const requestedRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      requestedWorkspaceId,
      requestedExportId
    );
    mkdirSync(dirname(requestedRoot), { recursive: true });
    renameSync(originalRoot, requestedRoot);

    const response = await app.request(
      route === 'dry-run' ? '/api/app/workspace-imports/dry-run' : '/api/app/workspace-imports',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceWorkspaceId: requestedWorkspaceId,
          exportId: requestedExportId,
        }),
      }
    );

    expect(response.status).toBe(400);
  });

  it('skips an orphan final workspace path when choosing a collision id', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-orphan-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const orphanRoot = join(dataRoot, 'workspaces', 'ws_imported_ws_demo');
    mkdirSync(orphanRoot, { recursive: true });
    writeFileSync(join(orphanRoot, 'orphan.txt'), 'keep');

    const response = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId: exported.exportId }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ importedWorkspaceId: 'ws_imported_ws_demo_2' });
    expect(readFileSync(join(orphanRoot, 'orphan.txt'), 'utf8')).toBe('keep');
  });

  it('skips a workspace id owned anywhere else in the deployment', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-registry-'));
    const store = createBoundaryStore(dataRoot);
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id,
            display_name,
            email,
            email_verified,
            created_at,
            updated_at,
            kind
          )
           VALUES
             ('user_local', 'Local', 'local@example.com', false, ?, ?, 'human'),
             ('user_other', 'Other', 'other@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: 'ws_demo',
      });
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_other',
        workspaceId: 'ws_imported_ws_demo',
      });
      const app = createApp({ coreDb, dataRoot, store });
      const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
        method: 'POST',
      });
      const exported = (await exportResponse.json()) as { exportId: string };

      const response = await app.request('/api/app/workspace-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId: exported.exportId }),
      });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ importedWorkspaceId: 'ws_imported_ws_demo_2' });
      expect(
        coreDb.sqlite
          .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
          .get('ws_imported_ws_demo')
      ).toEqual({ owner_user_id: 'user_other' });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('workspace archive import boundaries', () => {
  it('uses private staging modes and removes only the owned request directory', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-staging-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const archiveResponse = await app.request(
      `/api/app/workspaces/ws_demo/exports/${exported.exportId}/archive`
    );
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    let closeBody = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(archive);
        closeBody = () => controller.close();
      },
    });
    const request = new Request('http://openkit.test/api/app/workspace-archives/import-dry-run', {
      body,
      duplex: 'half',
      headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      method: 'POST',
    } as RequestInit & { duplex: 'half' });
    const stagedPromise = stageWorkspaceArchive(request, dataRoot);
    const requestsRoot = join(dataRoot, 'server', 'files', 'workspace-archive-requests');
    const requestEntries = readdirSync(requestsRoot);

    expect(requestEntries).toHaveLength(1);
    expect(statSync(join(requestsRoot, requestEntries[0]!)).mode & 0o777).toBe(0o700);
    closeBody();
    const staged = await stagedPromise;
    expect(statSync(staged.exportRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(staged.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE)).mode & 0o777).toBe(
      0o600
    );
    staged.remove();
    expect(readdirSync(requestsRoot)).toEqual([]);
  });

  it('removes abandoned request staging only during explicit boot cleanup', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-cleanup-'));
    createBoundaryStore(dataRoot);
    const requestsRoot = join(dataRoot, 'server', 'files', 'workspace-archive-requests');
    mkdirSync(join(requestsRoot, 'request-abandoned'), { recursive: true });
    writeFileSync(join(requestsRoot, 'request-abandoned', 'partial'), 'partial');

    cleanupWorkspaceArchiveRequestStaging(dataRoot);

    expect(existsSync(requestsRoot)).toBe(false);
  });

  it.each([
    ['unsafe path', { name: '../outside.txt', type: 'file' }],
    ['symbolic link', { name: 'linked', type: 'symlink', linkname: 'outside' }],
  ] as const)('rejects a tar %s and removes request staging', async (_label, header) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-malicious-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const archive = await archiveWithEntry(
      header,
      header.type === 'file' ? Buffer.from('bad') : undefined
    );

    const response = await app.request('/api/app/workspace-archives/import-dry-run', {
      body: archive,
      headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(existsSync(join(dataRoot, 'outside.txt'))).toBe(false);
    expect(readdirSync(join(dataRoot, 'server', 'files', 'workspace-archive-requests'))).toEqual(
      []
    );
  });

  it('rejects a declared compressed body above the fixed ceiling before staging', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-limit-'));
    const app = createApp({ dataRoot, store: createBoundaryStore(dataRoot) });

    const response = await app.request('/api/app/workspace-archives/import-dry-run', {
      body: new Uint8Array([1]),
      headers: {
        'content-length': '8589934593',
        'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
      },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(existsSync(join(dataRoot, 'server', 'files', 'workspace-archive-requests'))).toBe(false);
  });

  it('rejects non-block-aligned bytes after the tar end marker', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-tail-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const exportResponse = await app.request('/api/app/workspaces/ws_demo/export', {
      method: 'POST',
    });
    const exported = (await exportResponse.json()) as { exportId: string };
    const archiveResponse = await app.request(
      `/api/app/workspaces/ws_demo/exports/${exported.exportId}/archive`
    );
    const malformed = zstdCompressSync(
      Buffer.concat([
        zstdDecompressSync(Buffer.from(await archiveResponse.arrayBuffer())),
        Buffer.from([0]),
      ])
    );

    const response = await app.request('/api/app/workspace-archives/import-dry-run', {
      body: malformed,
      headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(readdirSync(join(dataRoot, 'server', 'files', 'workspace-archive-requests'))).toEqual(
      []
    );
  });

  it('closes a staging file when the compressed body aborts upstream', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-abort-'));
    createBoundaryStore(dataRoot);
    const complete = zstdDecompressSync(
      await archiveWithEntry({ name: 'partial.bin', type: 'file' }, Buffer.alloc(1024, 1))
    );
    const partial = zstdCompressSync(
      Buffer.concat([
        tarHeaderWithDeclaredSize(complete.subarray(0, 512), 1_048_576),
        Buffer.alloc(512, 1),
      ])
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partial);
        setTimeout(() => controller.error(new Error('injected upstream abort')), 10);
      },
    });
    const request = new Request('http://openkit.test/api/app/workspace-archives/import-dry-run', {
      body,
      duplex: 'half',
      headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      method: 'POST',
    } as RequestInit & { duplex: 'half' });

    expect(openArchiveStagingDescriptors(dataRoot)).toEqual([]);
    await expect(stageWorkspaceArchive(request, dataRoot)).rejects.toThrow(
      'injected upstream abort'
    );
    expect(openArchiveStagingDescriptors(dataRoot)).toEqual([]);
  });

  it('requires a mutating request id before staging the archive body', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-archive-request-id-'));
    const store = createBoundaryStore(dataRoot);
    const app = createApp({ dataRoot, store });
    const beforeWorkspaceIds = store.listWorkspaces().map((workspace) => workspace.id);

    const response = await app.request('/api/app/workspace-archives/import', {
      body: new Uint8Array([1]),
      headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(beforeWorkspaceIds);
    expect(existsSync(join(dataRoot, 'server', 'files', 'workspace-archive-requests'))).toBe(false);
  });
});

describe('workspace portable authority boundaries', () => {
  it('imports only target ownership while source authority remains non-authorizing history', async () => {
    const sourceDataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-authority-source-'));
    const targetDataRoot = mkdtempSync(join(tmpdir(), 'openkit-portable-authority-target-'));
    const sourceCoreDb = openCoreDb(sourceDataRoot);
    const targetCoreDb = openCoreDb(targetDataRoot);

    try {
      applyMigrations(sourceCoreDb);
      applyMigrations(targetCoreDb);
      const now = Date.now();
      const users = [
        ['user_source_owner', 'Source owner'],
        ['user_source_active', 'Source active member'],
        ['user_source_removed', 'Source removed member'],
        ['user_target_importer', 'Target importer'],
      ] as const;
      for (const coreDb of [sourceCoreDb, targetCoreDb]) {
        const insertUser = coreDb.sqlite.prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind
          ) VALUES (?, ?, ?, false, ?, ?, 'human')`
        );
        for (const [userId, displayName] of users) {
          insertUser.run(userId, displayName, `${userId}@example.com`, now, now);
        }
      }

      const sourceStore = new FsStore({ dataRoot: sourceDataRoot });
      const sourceWorkspace = sourceStore.createWorkspace('Portable authority source');
      recordWorkspaceOwnerMembership({
        coreDb: sourceCoreDb,
        ownerUserId: 'user_source_owner',
        workspaceId: sourceWorkspace.id,
      });
      const insertMember = sourceCoreDb.sqlite.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`
      );
      insertMember.run(
        sourceWorkspace.id,
        'user_source_active',
        'active',
        'editor',
        timestamp,
        null,
        timestamp,
        timestamp
      );
      insertMember.run(
        sourceWorkspace.id,
        'user_source_removed',
        'removed',
        'viewer',
        timestamp,
        timestamp,
        timestamp,
        timestamp
      );
      sourceCoreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, proposed_access_level,
            inviter_user_id, status, expires_at, accepted_at, declined_at, revoked_at,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, 'viewer', ?, 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
        )
        .run(
          'inv_source_importer',
          sourceWorkspace.id,
          'user_target_importer',
          'user_source_owner',
          '2099-01-01T00:00:00.000Z',
          timestamp,
          timestamp
        );
      sourceCoreDb.sqlite
        .prepare(
          `INSERT INTO session (
            id, expires_at, token, created_at, updated_at, user_id
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          'session_source_authority',
          Date.parse('2099-01-01T00:00:00.000Z'),
          'source-session-token',
          now,
          now,
          'user_source_owner'
        );
      createOpenKitAccessTokenRecord(sourceCoreDb, {
        expiresAt: '2099-01-01T00:00:00.000Z',
        ownerUserId: 'user_source_owner',
        scope: 'workspace',
        tokenId: 'token_source_authority',
        workspaceIds: [sourceWorkspace.id],
      });
      const sourceApp = createApp({
        auth: authForUser('user_source_owner'),
        coreDb: sourceCoreDb,
        dataRoot: sourceDataRoot,
        mode: 'server',
        store: sourceStore,
      });
      const exportResponse = await sourceApp.request(
        `/api/app/workspaces/${sourceWorkspace.id}/export`,
        { method: 'POST' }
      );
      expect(exportResponse.status, await exportResponse.clone().text()).toBe(200);
      const exported = (await exportResponse.json()) as { exportId: string };
      const sourceEditorApp = createApp({
        auth: authForUser('user_source_active'),
        coreDb: sourceCoreDb,
        dataRoot: sourceDataRoot,
        mode: 'server',
        store: sourceStore,
      });
      const forbiddenDownload = await sourceEditorApp.request(
        `/api/app/workspaces/${sourceWorkspace.id}/exports/${exported.exportId}/archive`
      );
      expect(forbiddenDownload.status).toBe(403);
      const archiveResponse = await sourceApp.request(
        `/api/app/workspaces/${sourceWorkspace.id}/exports/${exported.exportId}/archive`
      );
      expect(archiveResponse.status, await archiveResponse.clone().text()).toBe(200);
      const archiveBytes = await archiveResponse.arrayBuffer();
      const forbiddenSameDeploymentImport = await sourceEditorApp.request(
        '/api/app/workspace-archives/import-dry-run',
        {
          body: archiveBytes.slice(0),
          headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
          method: 'POST',
        }
      );
      expect(forbiddenSameDeploymentImport.status).toBe(403);

      const targetStore = new FsStore({ dataRoot: targetDataRoot });
      const targetApp = createApp({
        auth: authForUser('user_target_importer'),
        coreDb: targetCoreDb,
        dataRoot: targetDataRoot,
        mode: 'server',
        store: targetStore,
      });
      const dryRunResponses = await Promise.all(
        [0, 1].map(() =>
          targetApp.request('/api/app/workspace-archives/import-dry-run', {
            body: archiveBytes.slice(0),
            headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
            method: 'POST',
          })
        )
      );
      for (const response of dryRunResponses) {
        expect(response.status, await response.clone().text()).toBe(200);
      }
      expect(await dryRunResponses[0]!.json()).toMatchObject({
        collision: { status: 'available', workspaceId: sourceWorkspace.id },
        sourceWorkspaceId: sourceWorkspace.id,
      });
      expect(targetStore.listWorkspaces()).toEqual([]);
      expect(
        readdirSync(join(targetDataRoot, 'server', 'files', 'workspace-archive-requests'))
      ).toEqual([]);

      const importResponse = await targetApp.request('/api/app/workspace-archives/import', {
        body: archiveBytes,
        headers: {
          'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
          'x-openkit-request-id': '00000000-0000-4000-8000-000000000008',
        },
        method: 'POST',
      });
      expect(importResponse.status, await importResponse.clone().text()).toBe(200);
      const imported = (await importResponse.json()) as { importedWorkspaceId: string };
      expect(
        readdirSync(join(targetDataRoot, 'server', 'files', 'workspace-archive-requests'))
      ).toEqual([]);

      expect(
        targetCoreDb.sqlite
          .prepare(
            `SELECT workspace_id AS workspaceId, user_id AS userId, status,
                    access_level AS accessLevel
             FROM workspace_members
             ORDER BY workspace_id, user_id`
          )
          .all()
      ).toEqual([
        {
          accessLevel: 'editor',
          status: 'active',
          userId: 'user_target_importer',
          workspaceId: imported.importedWorkspaceId,
        },
      ]);
      expect(
        targetCoreDb.sqlite
          .prepare(
            `SELECT workspace_id AS workspaceId, owner_user_id AS ownerUserId
             FROM workspace_registry
             ORDER BY workspace_id`
          )
          .all()
      ).toEqual([
        { ownerUserId: 'user_target_importer', workspaceId: imported.importedWorkspaceId },
      ]);
      expect(
        targetCoreDb.sqlite.prepare('SELECT invitation_id FROM workspace_invitations').all()
      ).toEqual([]);
      expect(targetCoreDb.sqlite.prepare('SELECT id FROM session').all()).toEqual([]);
      expect(
        targetCoreDb.sqlite.prepare('SELECT token_id FROM openkit_access_tokens').all()
      ).toEqual([]);
      expect(
        currentWorkspaceAuthority(
          targetCoreDb,
          imported.importedWorkspaceId,
          { id: 'user_source_owner', kind: 'user' },
          'workspace.read',
          true
        )
      ).toBeNull();
    } finally {
      sourceCoreDb.sqlite.close();
      targetCoreDb.sqlite.close();
    }
  });
});
