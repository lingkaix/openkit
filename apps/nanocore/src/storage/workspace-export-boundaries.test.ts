import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import {
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { loadWorkspaceFileRecords } from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

const timestamp = '2026-07-12T00:00:00.000Z';

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
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
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
    agentSessions: [],
    turnEvents: [],
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
    artifactReviews: [],
    agentSessions: [],
    turnEvents: [],
  });
  return store;
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
    expect(existsSync(join(exportRoot, 'records', 'workspace.json'))).toBe(false);

    const target = join(parent, 'symlink-target');
    mkdirSync(target);
    const linkedRoot = join(parent, 'linked-export');
    symlinkSync(target, linkedRoot);
    expect(() => writeWorkspaceExportTree(minimalExportInput(linkedRoot))).toThrow(
      /Export root must not already exist/
    );
    expect(existsSync(join(target, 'records', 'workspace.json'))).toBe(false);
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
    const workspacePath = join(exportRoot, 'records', 'workspace.json');
    const manifestText = readFileSync(join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE), 'utf8');

    expect(verified.fileContents?.get('records/workspace.json')).toBe(
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
    mkdirSync(join(dataRoot, 'users', 'user_local'), { recursive: true });
    symlinkSync(external, join(dataRoot, 'users', 'user_local', 'workspaces'));

    expect(() => loadWorkspaceFileRecords(dataRoot, 'user_local')).toThrow();
    expect(readFileSync(marker, 'utf8')).toBe('keep');
  });
});

describe('workspace import route handles', () => {
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
    const orphanRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_imported_ws_demo');
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
});
