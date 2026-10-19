// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import type { ArtifactSchema } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { stageArtifactPayload } from '../storage/artifacts/file-payload.js';
import { artifactFilePayloadPath } from '../storage/artifacts/file-records.js';
import { withCanonicalFileWriteAdmission } from '../storage/canonical-write-capacity.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { prepareArtifactSourceInputs } from './artifact-source-files.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  readWorkerContextPackageTrace,
  type WorkerContextPackageAuthorityReader,
  type WorkerContextPackageFiles,
  type WorkerContextPackageSourceFileInput,
  writeWorkerContextPackageFiles,
  writeWorkerContextPackageTrace,
} from './worker-context-package.js';

const roots: string[] = [];
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000002';
const itemId = 'it_00000000-0000-7000-8000-000000000003';
const agentSessionId = 'as_00000000-0000-7000-8000-000000000004';
const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
const startedAt = '2026-10-18T00:00:00.000Z';
const requestId = 'context-digest-reference';
const request = serializeStructuredWorkerDelegationRequest(
  createStructuredWorkerDelegationRequest({
    acceptanceCriteria: ['Retain exact delivered history with digest-bound source references.'],
    constraints: { maxContextTokens: 4096, maxWorkerIterations: 1 },
    contextRefs: [{ kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' }],
    escalationConditions: [],
    expectedArtifacts: [],
    objective: 'Inspect the selected file.',
    resources: [],
    reviewContext: null,
    reviewPolicy: {
      instructions: 'Inspect the retained bytes.',
      required: true,
      reviewers: ['human'],
    },
    verification: [
      {
        kind: 'command',
        command:
          'pnpm --filter @openkit/nanocore exec vitest run src/context/context-digest-reference.test.ts',
        description: 'Verify exact delivered history.',
      },
    ],
  })
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Hashes fixture bytes independently of the projection and package owners. */
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Captures a real canonical Artifact before composing the actual source and package owners. */
async function artifactFixture(bytes: Buffer, mediaType: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'context-digest-reference-'));
  roots.push(dataRoot);
  const store = createDemoStore({ dataRoot });
  const workspace = store.listWorkspaces().find((entry) => entry.kind === 'code')!;
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const admission = new FileStorageAdmission(dataRoot, () => 0n);
  const artifact: z.infer<typeof ArtifactSchema> = {
    id: 'ar_00000000-0000-7000-8000-000000000005',
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Selected evidence',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'file', byteLength: bytes.length, mediaType },
    contentDigest: digest(bytes),
    lastMutationRequestId: requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: requestId,
      sourceDigest: digest(bytes),
      actor,
      requestId,
      recordedAt: startedAt,
    },
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const reservation = admission.reserve({
    stagingBytes: BigInt(bytes.length) + 65_536n,
    publicationBytes: 65_536n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
  });
  try {
    const stage = await stageArtifactPayload({
      workspaceRoot,
      source: Readable.from([bytes]),
      expectedByteLength: bytes.length,
      expectedDigest: digest(bytes),
      reservation,
    });
    try {
      withCanonicalFileWriteAdmission(admission, () => store.createArtifact(artifact, stage));
    } finally {
      await stage.remove();
    }
  } finally {
    reservation.release();
  }
  const prepare = () =>
    prepareArtifactSourceInputs({
      workspaceRoot,
      artifacts: [artifact],
      admission,
      assertCurrent: (selected) => {
        expect(selected).toEqual(store.getArtifact(workspace.id, artifact.id));
      },
    });
  const filesFor = (sources: readonly WorkerContextPackageSourceFileInput[]) =>
    createWorkerContextPackageFiles({
      workspaceId: workspace.id,
      threadId,
      turnId,
      workerRequestBytes: request,
      workerRequestItemId: itemId,
      includedItemIds: [itemId],
      materialSelections: [],
      contextBudgetTokens: 4096,
      sourceFiles: sources,
    });
  return {
    workspaceRoot,
    workspaceId: workspace.id,
    admission,
    prepare,
    filesFor,
    path: artifactFilePayloadPath(workspaceRoot, artifact.id, 1),
    artifact,
  };
}

/** Supplies unrelated execution authorities without replacing the producer, writer or verifier seam. */
function deliveryAuthorities(
  files: WorkerContextPackageFiles,
  artifact: z.infer<typeof ArtifactSchema>
) {
  const workspaceId = files.workspaceId;
  const turn = {
    id: turnId,
    workspaceId,
    threadId,
    agentSessionId,
    startedAt,
    triggerActor: actor,
  };
  const unresolved = resolveAgentEnvironmentPackage({
    agentSessionId,
    agentSetup: createTestAgentSetup(),
    backend: { kind: 'openshell' },
    captureCoverage: { scope: 'server', value: 'off' },
    requestId,
    triggerActor: actor,
    turn: {
      ...turn,
      completedAt: null,
      configVersion: null,
      durationMs: null,
      error: null,
      items: [],
      status: 'running',
    },
    turnInput: request,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  const contextInput = buildWorkerContextPackageWorkspaceInput({
    agentSessionId,
    threadId,
    turnId,
    packageRootDigest: files.packageRootDigest,
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    ...unresolved,
    scope: { ...unresolved.scope, itemId },
    workspace: { ...unresolved.workspace, inputs: [contextInput] },
  });
  const trace = createWorkerContextPackageTrace({
    agentSessionId,
    excludedItems: [],
    goalId: 'goal_history',
    taskId: 'task_history',
    materialExclusions: [],
    packageFiles: files,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId,
  });
  const readinessEvidence = [
    { kind: 'backend.ready', ref: 'fixture' },
    { kind: 'sandbox.created', ref: 'sandbox_history' },
  ];
  const base = { commit: null, contentDigest: files.packageRootDigest };
  const authorities: WorkerContextPackageAuthorityReader = {
    readAdmission: () => ({ workspaceId, threadId, turnId, requestId, status: 'admitted' }),
    readAgentEnvironmentPackage: () => environmentPackage,
    readAgentSession: () => ({
      id: agentSessionId,
      workspaceId,
      threadId,
      environmentPackageSnapshotId: environmentPackage.snapshotId,
      stale: false,
    }),
    readBackendHandoff: () => ({
      workspaceId,
      threadId,
      turnId,
      agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      backendKind: 'openshell',
      backendSessionId: 'sandbox_history',
      workspaceHandoffState: 'complete',
      readinessEvidence,
    }),
    readMaterialRevision: () => null,
    readThreadItems: () => [
      {
        id: itemId,
        workspaceId,
        threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        text: request,
      },
    ],
    readThreadParent: () => null,
    readTurn: () => turn,
    readWorkspaceImportedFrom: () => null,
    readSourceFile: () => ({
      originalDigest: artifact.contentDigest,
      byteLength: artifact.content.format === 'file' ? artifact.content.byteLength : 0,
      mediaType: artifact.content.format === 'file' ? artifact.content.mediaType : '',
    }),
    readWorkspaceInputSnapshot: () => ({
      backend: {
        capabilitySummary: [...environmentPackage.backend.requiredCapabilities],
        kind: 'openshell',
        label: 'openshell worker backend',
      },
      base,
      createdAt: startedAt,
      generatedFiles: [],
      id: trace.workspaceInputSnapshotId,
      ignoredPaths: [],
      pathScope: [`context_${turnId}`],
      resourceId: `context_${turnId}`,
      resourceKind: 'filesystem',
      strategy: 'filesystem',
      workspaceId,
      writableRoots: [],
    }),
    readWorkspaceMaterializationRecord: () => ({
      backendKind: 'openshell',
      base,
      createdAt: startedAt,
      id: trace.workspaceMaterializationRecordId,
      inputSnapshotId: trace.workspaceInputSnapshotId,
      materializedRootRef: contextInput.target,
      packageSnapshotId: environmentPackage.snapshotId,
      policyDigest: createWorkerContextPackagePolicyDigest({
        backendKind: 'openshell',
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      }),
      readinessEvidence,
      strategy: 'filesystem',
      workerSessionId: 'sandbox_history',
      workspaceId,
    }),
  };
  return { authorities, trace };
}

/** Lists all physical package files so an undeclared retained copy cannot escape the inventory assertion. */
function packagePaths(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? packagePaths(root, path) : [path];
    })
    .sort();
}

/** Runs the real delivery seam and reopens retained history after canonical source loss or replacement. */
async function assertReferenceHistory(original: Buffer, mediaType: string, delivered: string) {
  const f = await artifactFixture(original, mediaType);
  const sources = await f.prepare();
  const files = f.filesFor(sources);
  await writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission });
  const fixture = deliveryAuthorities(files, f.artifact);
  const trace = writeWorkerContextPackageTrace({ ...fixture, workspaceRoot: f.workspaceRoot });
  const root = join(f.workspaceRoot, 'threads', threadId, 'turns', turnId, 'context-package');
  const tracePath = join(root, '..', 'context-package.json');
  const traceBytes = readFileSync(tracePath);
  const packageBytes = readFileSync(join(root, 'package.json'));
  const source = trace.sourceFiles![0]!;
  expect(readFileSync(join(root, source.packagePath), 'utf8')).toBe(delivered);
  expect(source).toMatchObject({
    source: {
      kind: 'artifact',
      reference: {
        scopeId: `artifact/workspace/${f.workspaceId}`,
        objectId: f.artifact.id,
      },
      artifactVersion: 1,
    },
    originalDigest: digest(original),
    byteLength: original.length,
    mediaType,
    projection: { deliveredDigest: digest(delivered), byteLength: Buffer.byteLength(delivered) },
  });
  // Soft checks preserve the historical-reader evidence even while baseline copy retention fails.
  expect.soft(source).not.toHaveProperty('originalSnapshotPath');
  expect.soft(source.projection).not.toHaveProperty('originalSnapshotPath');
  expect.soft(source.projection).not.toHaveProperty('representationSnapshotPath');
  expect
    .soft(trace.fileInventory.map((entry) => entry.path).sort())
    .toEqual(['instructions.md', 'package.json', source.packagePath].sort());
  expect
    .soft(packagePaths(root))
    .toEqual(['instructions.md', 'package.json', source.packagePath].sort());
  const historicalAuthorities = {
    ...fixture.authorities,
    readSourceFile: () => {
      throw new Error('Historical delivery must not reopen the current source.');
    },
  };
  const readHistory = () =>
    readWorkerContextPackageTrace({
      authorities: historicalAuthorities,
      workspaceRoot: f.workspaceRoot,
      workspaceId: f.workspaceId,
      threadId,
      turnId,
    });
  chmodSync(f.path, 0o600);
  rmSync(f.path);
  expect(readHistory()).toEqual(trace);
  writeFileSync(f.path, Buffer.alloc(original.length, 0x58));
  expect(readHistory()).toEqual(trace);
  await writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission });
  expect(readFileSync(tracePath)).toEqual(traceBytes);
  expect(readFileSync(join(root, 'package.json'))).toEqual(packageBytes);
  expect(readFileSync(join(root, source.packagePath), 'utf8')).toBe(delivered);
  const deliveredPath = join(root, source.packagePath);
  chmodSync(deliveredPath, 0o600);
  writeFileSync(deliveredPath, Buffer.alloc(Buffer.byteLength(delivered), 0x58));
  expect(readHistory).toThrow();
  rmSync(deliveredPath);
  expect(readHistory).toThrow();
  await expect(
    writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission })
  ).rejects.toThrow();
  expect(readFileSync(tracePath)).toEqual(traceBytes);
  return source;
}

it('retains only exact delivered text history and digest-bound source identity after original deletion or replacement', async () => {
  const original = Buffer.from(
    `Exact delivered source.\n${'omitted source content.\n'.repeat(150)}`
  );
  // The independent line bound is 50 lines, so this fixture delivers one heading and 49 following lines.
  const delivered = `Exact delivered source.\n${'omitted source content.\n'.repeat(49)}`;
  const source = await assertReferenceHistory(original, 'text/plain', delivered);
  expect(source.projection).toMatchObject({
    representationId: 'original-utf8',
    representationDigest: digest(original),
    representationByteLength: original.length,
    sourceRevision: '1',
    kind: 'excerpt',
    ranges: [{ start: 0, end: 1200 }],
    truncated: true,
    availability: 'incomplete',
  });
});

it('verifies current complete source bytes before first publication even beyond the delivered preview', async () => {
  const original = Buffer.from(
    `Exact delivered source.\n${'omitted source content.\n'.repeat(150)}`
  );
  const f = await artifactFixture(original, 'text/plain');
  const files = f.filesFor(await f.prepare());
  const replacement = Buffer.from(original);
  replacement[replacement.length - 1] = 0x58;
  chmodSync(f.path, 0o600);
  writeFileSync(f.path, replacement);
  await expect(
    writeWorkerContextPackageFiles(f.workspaceRoot, files, { admission: f.admission })
  ).rejects.toThrow();
});

/** Builds the same xref-valid one-page structure as the existing PDF processor fixtures. */
function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 0.1 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

it('retains PDF preview and complete derivative lineage without another original or extracted-text copy', async () => {
  const original = onePagePdf('A'.repeat(2300));
  const representation = `# Page 1\n\n${'A'.repeat(2300)}\n\n`;
  const delivered = `# Page 1\n\n${'A'.repeat(2038)}`;
  const source = await assertReferenceHistory(original, 'application/pdf', delivered);
  expect(source.projection).toMatchObject({
    sourceRevision: '1',
    kind: 'excerpt',
    representationDigest: digest(representation),
    representationByteLength: 2312,
    ranges: [{ start: 0, end: 2048 }],
    truncated: true,
    availability: 'incomplete',
    pdfTextLayer: {
      processor: { id: 'pdfjs-pdf-text-layer-v1' },
      pages: [{ page: 1, startByte: 10, endByte: 2311, coordinateSpace: 'representation-utf8' }],
      coverage: { complete: true, totalPages: 1, processedPages: 1 },
    },
  });
  expect(source.projection.representationDigest).not.toBe(source.originalDigest);
  expect(source.projection.deliveredDigest).not.toBe(source.projection.representationDigest);
});
