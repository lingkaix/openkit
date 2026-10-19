// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
} from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { prepareTurnFileSourceInputs } from '../context/turn-source-files.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  writeWorkerContextPackageFiles,
} from '../context/worker-context-package.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { turnFilePayloadPath } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  type NanoHostFileImportSource,
  prepareNanoHostContextPackageImports,
} from './worker-governance-backend.js';

/** Hashes bytes independently of the package and NanoHost import owners. */
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Reads the actual private import factory and observes its carriage chunk bound. */
async function readImport(source: NanoHostFileImportSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.open(new AbortController().signal)) {
    expect(chunk.byteLength).toBeGreaterThan(0);
    expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Enumerates retained files so an unlisted permanent copy cannot satisfy live delivery. */
function retainedPaths(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? retainedPaths(root, path) : [path];
    })
    .sort();
}

it('streams a complete admitted Turn ZIP into the live Context input without retaining another Core original', async () => {
  // Existing independent archive corpus; this test exercises carriage, not ZIP extraction.
  const corpus = JSON.parse(
    readFileSync(
      new URL('../../../../tests/fixtures/large-context/cases.json', import.meta.url),
      'utf8'
    )
  ) as {
    archives: Array<{ id: string; base64: string; size: number; sha256: string }>;
  };
  const archive = corpus.archives.find((entry) => entry.id === 'valid-file')!;
  const original = Buffer.from(archive.base64, 'base64');
  expect(original.byteLength).toBe(123);
  expect(digest(original)).toBe(
    'sha256:537853f1b6f6c248c79ca42e5951b2902388a09005126d1ebf57eab7f566d40b'
  );
  const dataRoot = mkdtempSync(join(tmpdir(), 'context-live-source-import-'));
  try {
    const store = createDemoStore({ dataRoot });
    const workspace = store.listWorkspaces().find((entry) => entry.kind === 'code')!;
    const thread = store.createThread(workspace.id, 'Inspect the admitted ZIP');
    const stagingPath = join(dataRoot, 'selected.zip');
    writeFileSync(stagingPath, original);
    const admission = new FileStorageAdmission(dataRoot, () => 0n);
    const request = 'Inspect the complete selected ZIP input.';
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      request,
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      null,
      {
        fileInputs: [
          {
            name: 'selected.zip',
            mediaType: 'application/zip',
            sizeBytes: archive.size,
            contentDigest: archive.sha256,
          },
        ],
        filePayloadPaths: [stagingPath],
        fileWriteAdmission: admission,
      }
    );
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    expect(readFileSync(turnFilePayloadPath(workspaceRoot, thread.id, turn.id, 0))).toEqual(
      original
    );
    const item = store.createItem({
      id: allocateEntityId('it'),
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      text: request,
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    let allowed = true;
    const sources = await prepareTurnFileSourceInputs({
      workspaceRoot,
      turn,
      assertCurrent: () => {
        if (!allowed) throw new Error('Private source audience is no longer admitted.');
      },
    });
    const files = createWorkerContextPackageFiles({
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      workerRequestItemId: item.id,
      workerRequestBytes: request,
      includedItemIds: [item.id],
      materialSelections: [],
      sourceFiles: sources,
      contextBudgetTokens: 4096,
    });
    await writeWorkerContextPackageFiles(workspaceRoot, files, { admission });
    const contextRoot = join(
      workspaceRoot,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'context-package'
    );
    const expectedRetained = ['instructions.md', 'package.json', 'sources/turn-inputs/0.txt'];
    expect(files.fileInventory.map((entry) => entry.path).sort()).toEqual(expectedRetained);
    expect(retainedPaths(contextRoot)).toEqual(expectedRetained);
    const retainedManifest = JSON.parse(readFileSync(join(contextRoot, 'package.json'), 'utf8'));
    expect(retainedManifest.sourceFiles[0]).toMatchObject({
      originalDigest: archive.sha256,
      byteLength: 123,
      mediaType: 'application/zip',
      packagePath: 'sources/turn-inputs/0.txt',
      projection: { kind: 'descriptor', availability: 'unavailable' },
    });
    expect(retainedManifest.sourceFiles[0]).not.toHaveProperty('originalSnapshotPath');
    expect(retainedManifest).not.toHaveProperty('contextPackageSources');
    expect(
      JSON.parse(readFileSync(join(contextRoot, 'sources/turn-inputs/0.txt'), 'utf8'))
    ).toMatchObject({ status: 'unavailable', reason: 'unsupported' });

    const agentSessionId = allocateEntityId('as');
    const base = resolveAgentEnvironmentPackage({
      agentSessionId,
      agentSetup: createTestAgentSetup(),
      backend: { kind: 'openshell' },
      captureCoverage: { scope: 'server', value: 'off' },
      requestId: 'context-live-source-import',
      turn,
      triggerActor: turn.triggerActor,
      userId: FIXTURE_LOCAL_USER_ID,
      turnInput: request,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    const contextInput = buildWorkerContextPackageWorkspaceInput({
      agentSessionId,
      threadId: thread.id,
      turnId: turn.id,
      packageRootDigest: files.packageRootDigest,
    });
    const withInput = AgentEnvironmentPackageSchema.parse({
      ...base,
      scope: { ...base.scope, itemId: item.id },
      workspace: { ...base.workspace, inputs: [...base.workspace.inputs, contextInput] },
    });
    const openkit = withInput.extensions.openkit as Record<string, unknown> & {
      workerStorage: { workSlotRef: string };
    };
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...withInput,
      extensions: {
        ...withInput.extensions,
        openkit: {
          ...openkit,
          sessionWorkspace: planSessionWorkspaceMaterialization({
            environmentPackage: withInput,
            workSlotRef: openkit.workerStorage.workSlotRef,
          }),
        },
      },
    });
    // A local variable lets the baseline consumer ignore this new private input and reach the deciding assertion.
    const context = {
      dataRoot,
      contextPackageSources: files.sourceFileInputs ?? [],
      workspaceRoots: [
        {
          id: contextInput.id,
          access: 'read-only' as const,
          sourceKind: 'materialized-dir' as const,
          sourcePath: contextRoot,
          workerPath: contextInput.target,
        },
      ],
    };
    const imports = await prepareNanoHostContextPackageImports(environmentPackage, context);
    const prefix = `${agentSessionId}/context/`;
    const originalPath = `originals/537853f1b6f6c248c79ca42e5951b2902388a09005126d1ebf57eab7f566d40b`;
    const raw = imports.find(
      (entry) => entry.slot === 'context' && entry.relativePath === `${prefix}${originalPath}`
    );
    expect(
      raw,
      'The live Context input must include the admitted original ZIP, not only its unavailable descriptor.'
    ).toBeDefined();
    if (!raw || raw.entryKind !== 'file' || !raw.source)
      throw new Error('Expected a private raw original import.');
    expect(raw).not.toHaveProperty('body');
    expect(raw).toMatchObject({
      byteLength: 123,
      contentDigest: archive.sha256,
      executable: false,
    });
    const contextFiles = imports.filter(
      (entry) => entry.slot === 'context' && entry.entryKind === 'file'
    );
    expect(contextFiles.map((entry) => entry.relativePath.slice(prefix.length)).sort()).toEqual(
      [...expectedRetained, originalPath].sort()
    );
    const observedInventory: Array<{ byteLength: number; contentDigest: string; path: string }> =
      [];
    for (const imported of contextFiles) {
      if (imported.entryKind !== 'file') throw new Error('Expected a regular Context import.');
      const bytes = imported.source ? await readImport(imported.source) : imported.body;
      expect(bytes.byteLength).toBe(imported.byteLength);
      expect(digest(bytes)).toBe(imported.contentDigest);
      const path = imported.relativePath.slice(prefix.length);
      if (path === originalPath) expect(bytes).toEqual(original);
      else expect(bytes).toEqual(readFileSync(join(contextRoot, path)));
      observedInventory.push({ byteLength: bytes.byteLength, contentDigest: digest(bytes), path });
    }
    observedInventory.sort((left, right) => left.path.localeCompare(right.path));
    expect(digest(JSON.stringify(observedInventory))).toBe(
      contextInput.materialization!.contentDigest
    );
    expect(contextInput.materialization!.contentDigest).toBe(files.packageRootDigest);
    expect(retainedPaths(contextRoot)).toEqual(expectedRetained);
    allowed = false;
    const revoked = raw.source.open(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(revoked.next()).rejects.toThrow();
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
