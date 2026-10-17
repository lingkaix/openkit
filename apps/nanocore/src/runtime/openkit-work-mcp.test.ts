// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decideArtifactReview, getArtifactReview } from '../artifact-reviews.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { prepareArtifactSourceInputs } from '../context/artifact-source-files.js';
import * as packageOwner from '../context/worker-context-package.js';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from '../storage/artifacts/file-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { dispatchOpenkitWorkTool, OPENKIT_WORK_TOOLS } from './openkit-work-mcp.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import type { WorkerCredentialCheckValues } from './worker-credential-guard.js';
import { readWorkerRawOutput } from './worker-raw-output.js';

/** Creates real canonical owners; the capture double stands outside the Core publication seam. */
function submissionFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-submit-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot });
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Submit a finished file',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup(),
    agentSessionId: 'as_00000000-0000-75c5-83d7-1a74418e3a38',
    triggerActor: turn.triggerActor,
    userId: 'usr_00000000-0000-7000-8000-000000000001',
    backend: { kind: 'openshell' },
    createdAt: '2026-10-05T00:00:00.000Z',
    requestId: 'req_turn_start',
    turn,
    workspaceCwd: '/workspace/output',
    workspaceRoots: [],
  });
  store.updateTurn(turn.id, {
    status: 'running',
    agentId: environmentPackage.agent.agentId,
    agentSessionId: 'as_00000000-0000-75c5-83d7-1a74418e3a38',
  });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(workspaceDb);
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const credentialCheckValues: WorkerCredentialCheckValues = {
    sensitiveValues: ['synthetic-injected-secret'],
    loopbackDigests: ['a', 'b'].map((value) =>
      createHash('sha256').update(value.repeat(43)).digest('hex')
    ),
    routeTokenHashes: {
      workerControl: createHash('sha256').update(Buffer.alloc(32, 17)).digest('hex'),
      inference: createHash('sha256').update(Buffer.alloc(32, 34)).digest('hex'),
      capability: createHash('sha256').update(Buffer.alloc(32, 51)).digest('hex'),
    },
  };
  // This is the proposed backend capture dependency, not a simulated publication implementation.
  // It establishes Core semantics only; real NanoHost/helper admission needs separate composition proof.
  const captureArtifact = vi.fn(
    async (_request: {
      packageSnapshotId: string;
      requestId: string;
      path: string;
      maxByteLength: number;
    }) => ({ bytes: Buffer.from('Finished report\n'), credentialCheckValues })
  );
  const fileAdmission = new FileStorageAdmission(dataRoot, () => 0n);
  // Only the external capture is doubled. The actual Core stage, scan and publication owners
  // consume a new stream per capture, so concurrent calls never share a consumed reader.
  const input = {
    coreDb,
    environmentPackage,
    store,
    workspaceDb,
    fileAdmission,
    captureArtifact: async (request: Parameters<typeof captureArtifact>[0]) => {
      const captured = await captureArtifact(request);
      return {
        source: Readable.from([captured.bytes]),
        byteLength: captured.bytes.length,
        contentDigest: `sha256:${createHash('sha256').update(captured.bytes).digest('hex')}`,
        credentialCheckValues: captured.credentialCheckValues,
        remove: async () => {},
      };
    },
  };
  const readBytes = (id: string) => {
    const artifact = store.getArtifact('ws_00000000-0000-7000-8000-000000000001', id);
    expect(artifact.content.format).toBe('file');
    return readFileSync(
      artifactFilePayloadPath(
        join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001'),
        id,
        artifact.version
      )
    );
  };
  const submit = (requestId = 'req_file_1', overrides: Record<string, unknown> = {}) =>
    dispatchOpenkitWorkTool(input, 'work_submit_artifact', {
      requestId,
      path: '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs/report.md',
      kind: 'report',
      title: 'Report',
      mediaType: 'text/markdown',
      ...overrides,
    });
  const counts = () => ({
    artifacts: store
      .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
      .filter((artifact) => artifact.turnId === turn.id).length,
    references: store
      .listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
      .filter((item) => item.type === 'artifact-reference' && item.turnId === turn.id).length,
    reviews: (
      workspaceDb.sqlite.prepare('SELECT count(*) AS n FROM artifact_reviews').get() as {
        n: number;
      }
    ).n,
    receipts: store.listCommandRequests().length,
  });
  return {
    ...input,
    input,
    captureArtifact,
    readBytes,
    submit,
    counts,
    turn,
    dataRoot,
    credentialCheckValues,
  };
}

/** Extracts the acknowledged id without inferring successful publication from assistant text. */
function acknowledgedArtifactId(
  result: Awaited<ReturnType<typeof dispatchOpenkitWorkTool>>
): string {
  expect(result.isError).toBe(false);
  const content = result.structuredContent as { artifactId?: unknown };
  expect(content.artifactId).toEqual(expect.any(String));
  return content.artifactId as string;
}

describe('synchronous Worker file submission', () => {
  it('captures a real finished file from the empty-roots package output and reads back its Artifact', async () => {
    const fixture = submissionFixture();
    const path = '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs/report.md';
    const localRoot = join(fixture.dataRoot, 'sandbox-output');
    mkdirSync(localRoot);
    writeFileSync(join(localRoot, 'report.md'), '# Session report\n');
    fixture.captureArtifact.mockImplementation(async (request) => {
      expect(request.path).toBe(path);
      return {
        bytes: readFileSync(join(localRoot, 'report.md')),
        credentialCheckValues: fixture.credentialCheckValues,
      };
    });
    const id = acknowledgedArtifactId(await fixture.submit());
    expect(fixture.captureArtifact).toHaveBeenCalledOnce();
    expect(fixture.readBytes(id)).toEqual(Buffer.from('# Session report\n'));
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
    await expect(
      fixture.submit('req_undeclared', { path: '/workspace/outputs/report.md' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      fixture.submit('req_sibling', {
        path: '/openkit/sessions/as_00000000-0000-7a5a-b02b-c33d9bb7bf5c/outputs/report.md',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.captureArtifact).toHaveBeenCalledOnce();
  });

  it('advertises work_submit_artifact on the existing work supply', () => {
    expect(OPENKIT_WORK_TOOLS.map((tool) => tool.name)).toContain('work_submit_artifact');
  });

  it('returns an Artifact id only after Artifact, reference, Review and receipt are durable', async () => {
    const fixture = submissionFixture();
    const id = acknowledgedArtifactId(await fixture.submit());
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
    expect(
      fixture.store
        .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
        .find((artifact) => artifact.id === id)
    ).toMatchObject({
      content: { format: 'file', mediaType: 'text/markdown', byteLength: 16 },
      turnId: fixture.turn.id,
      origin: { kind: 'turn-output', requestId: 'req_file_1' },
    });
    expect(getArtifactReview(fixture.workspaceDb, id, 1)).toMatchObject({
      sourceTurnId: fixture.turn.id,
    });
    expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
    // Reopening canonical owners checks persistence rather than just the producer's live indexes.
    const reopened = new FsStore({ dataRoot: fixture.dataRoot });
    expect(
      reopened
        .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
        .map((artifact) => artifact.id)
    ).toContain(id);
    expect(
      reopened.listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toContainEqual(expect.objectContaining({ type: 'artifact-reference', artifactId: id }));
    expect(reopened.listCommandRequests()).toContainEqual(
      expect.objectContaining({ requestId: 'req_file_1', response: { kind: 'artifact', id } })
    );
    const reopenedWorkspaceDb = openWorkspaceDb(
      fixture.dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    try {
      expect(getArtifactReview(reopenedWorkspaceDb, id, 1)).toMatchObject({
        sourceTurnId: fixture.turn.id,
      });
    } finally {
      reopenedWorkspaceDb.sqlite.close();
    }
  });

  it('replays the same id and immutable bytes without another export', async () => {
    const fixture = submissionFixture();
    const first = acknowledgedArtifactId(await fixture.submit());
    fixture.captureArtifact.mockResolvedValue({
      bytes: Buffer.from('Changed file'),
      credentialCheckValues: {
        sensitiveValues: [],
        loopbackDigests: ['c', 'd'].map((value) =>
          createHash('sha256').update(value.repeat(43)).digest('hex')
        ),
        routeTokenHashes: {
          workerControl: '1'.repeat(64),
          inference: '2'.repeat(64),
          capability: '3'.repeat(64),
        },
      },
    });
    expect(acknowledgedArtifactId(await fixture.submit())).toBe(first);
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
    expect(fixture.readBytes(first)).toEqual(Buffer.from('Finished report\n'));
  });

  it('conflicts on changed path or metadata under the same accepted request', async () => {
    const fixture = submissionFixture();
    await fixture.submit();
    await expect(fixture.submit('req_file_1', { title: 'Changed' })).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
  });

  it('publishes nothing for a proved missing path and permits a corrected same-Turn call', async () => {
    const fixture = submissionFixture();
    fixture.captureArtifact.mockRejectedValueOnce(
      Object.assign(new Error('File not found.'), { code: 'artifact_file_missing', status: 400 })
    );
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'artifact_file_missing' });
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
    acknowledgedArtifactId(await fixture.submit('req_file_corrected'));
    expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
  });

  it('rejects reserved imported-history request proof before capture', async () => {
    const fixture = submissionFixture();
    await expect(fixture.submit('import-lineage:historical')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fixture.captureArtifact).not.toHaveBeenCalled();
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it('rejects malformed media without capture or publication and permits correction', async () => {
    const fixture = submissionFixture();
    await expect(
      fixture.submit('req_bad_media', { mediaType: 'image/png; invalid' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.captureArtifact).not.toHaveBeenCalled();
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
    acknowledgedArtifactId(await fixture.submit('req_media_corrected'));
  });

  it('rejects an exact injected credential match with no canonical writes', async () => {
    const fixture = submissionFixture();
    const clean = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    fixture.captureArtifact.mockResolvedValue({
      ...clean,
      bytes: Buffer.from('prefix synthetic-injected-secret suffix'),
    });
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it.each([
    'literal',
    'original-route-hash',
  ])('rejects an injected %s value in persisted submission identity', async (kind) => {
    const fixture = submissionFixture();
    const requestId =
      kind === 'literal' ? 'synthetic-injected-secret' : Buffer.alloc(32, 51).toString('base64url');
    await expect(fixture.submit(requestId)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
    acknowledgedArtifactId(await fixture.submit('req_safe_identity'));
  });

  it('admits program-produced files independently of the sixteen MiB raw-output allowance', async () => {
    const fixture = submissionFixture();
    fixture.captureArtifact.mockResolvedValue({
      bytes: Buffer.alloc(8 * 1024 * 1024, 0xff),
      credentialCheckValues: fixture.credentialCheckValues,
    });
    await fixture.submit('file-1');
    await fixture.submit('file-2');
    await fixture.submit('file-3');
    expect(fixture.counts()).toEqual({ artifacts: 3, references: 3, reviews: 3, receipts: 3 });
    expect(fixture.captureArtifact.mock.calls.map(([request]) => request.maxByteLength)).toEqual([
      1_000_000_001, 1_000_000_001, 1_000_000_001,
    ]);
    expect(readWorkerRawOutput(fixture.workspaceDb, fixture.environmentPackage.scope)).toEqual({
      rawOutputBytes: 0,
      exhausted: false,
    });
  });

  it('publishes nothing when the Turn seals during capture', async () => {
    const fixture = submissionFixture();
    const clean = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    fixture.captureArtifact.mockImplementation(async () => {
      fixture.store.updateTurn(fixture.turn.id, {
        status: 'interrupted',
        completedAt: '2026-10-05T01:00:00.000Z',
      });
      return clean;
    });
    await expect(fixture.submit()).rejects.toMatchObject({
      code: 'turn_not_active',
    });
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });
});

// Owner: synchronous file submission and original-materialization exact-value admission.
describe('submission authority and byte evidence', () => {
  it.each([
    'loopback-inference',
    'loopback-capability',
    'route-workerControl',
    'route-inference',
    'route-capability',
  ])('rejects a %s match with zero publication', async (kind) => {
    const fixture = submissionFixture();
    const captured = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    const value = kind.startsWith('loopback')
      ? (kind.endsWith('inference') ? 'a' : 'b').repeat(43)
      : Buffer.alloc(
          32,
          kind.endsWith('workerControl') ? 17 : kind.endsWith('inference') ? 34 : 51
        ).toString('base64url');
    fixture.captureArtifact.mockResolvedValue({
      ...captured,
      bytes: Buffer.from(`prefix-${value}-suffix`),
    });
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it.each([
    'loopback-inference',
    'loopback-capability',
    'route-workerControl',
    'route-inference',
    'route-capability',
  ])('fails closed for unavailable %s evidence', async (kind) => {
    const fixture = submissionFixture();
    const captured = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    if (kind.startsWith('loopback'))
      captured.credentialCheckValues.loopbackDigests[kind.endsWith('inference') ? 0 : 1] = '';
    else
      captured.credentialCheckValues.routeTokenHashes[
        kind.slice(6) as 'workerControl' | 'inference' | 'capability'
      ] = '';
    fixture.captureArtifact.mockResolvedValue(captured);
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it.each([
    '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs',
    '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs/../report.md',
    '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs//report.md',
    '/undeclared/report.md',
  ])('rejects path %s before export', async (path) => {
    const fixture = submissionFixture();
    await expect(fixture.submit('bad-path', { path })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fixture.captureArtifact).not.toHaveBeenCalled();
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it.each([
    'registration',
    'retention',
    'overlap',
    'nested-root-equality',
  ])('rejects %s eligibility before export', async (kind) => {
    const fixture = submissionFixture();
    if (kind === 'registration')
      fixture.environmentPackage.workspace.outputs[0]!.registerAsArtifacts = false;
    if (kind === 'retention') fixture.environmentPackage.workspace.outputs[0]!.retention = 'manual';
    if (kind === 'overlap')
      fixture.environmentPackage.workspace.outputs.push({
        ...fixture.environmentPackage.workspace.outputs[0]!,
        id: 'overlap',
      });
    if (kind === 'nested-root-equality')
      fixture.environmentPackage.workspace.outputs.push({
        ...fixture.environmentPackage.workspace.outputs[0]!,
        id: 'nested',
        path: '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs/report.md',
      });
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.captureArtifact).not.toHaveBeenCalled();
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it.each([
    'empty',
    'invalid-utf8',
    'invalid-json',
  ])('preserves exact arbitrary %s bytes', async (kind) => {
    const fixture = submissionFixture();
    const captured = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    fixture.captureArtifact.mockResolvedValue({
      ...captured,
      bytes:
        kind === 'empty'
          ? Buffer.alloc(0)
          : kind === 'invalid-utf8'
            ? Buffer.from([0xff])
            : Buffer.from('{invalid'),
    });
    const id = acknowledgedArtifactId(
      await fixture.submit('format', {
        mediaType: kind === 'invalid-json' ? 'application/json' : 'application/octet-stream',
      })
    );
    const expected =
      kind === 'empty'
        ? Buffer.alloc(0)
        : kind === 'invalid-utf8'
          ? Buffer.from([0xff])
          : Buffer.from('{invalid');
    expect(fixture.readBytes(id)).toEqual(expected);
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
  });

  it('refuses an authority tuple whose receipt is missing without recapture', async () => {
    const fixture = submissionFixture();
    await fixture.submit();
    fixture.workspaceDb.sqlite.prepare('DELETE FROM idempotency_requests').run();
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
  });

  it.each([
    'agentId',
    'agentSessionId',
  ] as const)('refuses replay when canonical source %s contradicts the original AEP', async (field) => {
    const fixture = submissionFixture();
    await fixture.submit();
    fixture.store.updateTurn(fixture.turn.id, {
      [field]:
        field === 'agentSessionId'
          ? testEntityId('as', 'contradictory-source')
          : 'contradictory-source',
    });
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
  });

  it('refuses a receipt with a missing Review without recapture', async () => {
    const fixture = submissionFixture();
    await fixture.submit();
    fixture.workspaceDb.sqlite.prepare('DELETE FROM artifact_reviews').run();
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
  });

  it('admits concurrent independent files whose combined bytes exceed the raw-output allowance', async () => {
    const fixture = submissionFixture();
    fixture.captureArtifact.mockResolvedValue({
      bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 0xff),
      credentialCheckValues: fixture.credentialCheckValues,
    });
    await Promise.all([fixture.submit('concurrent-1'), fixture.submit('concurrent-2')]);
    expect(fixture.counts()).toEqual({ artifacts: 2, references: 2, reviews: 2, receipts: 2 });
  });

  it('reserves future disk writes before capture and refuses a competing request when capacity is held', async () => {
    const fixture = submissionFixture();
    const fileAdmission = new FileStorageAdmission(
      fixture.dataRoot,
      () => 0n,
      () => 1_000_065_536n
    );
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstCapture = fixture.captureArtifact.getMockImplementation()!;
    fixture.captureArtifact.mockImplementation(async (request) => {
      await wait;
      return firstCapture(request);
    });
    const submit = (requestId: string) =>
      dispatchOpenkitWorkTool({ ...fixture.input, fileAdmission }, 'work_submit_artifact', {
        requestId,
        path: '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs/report.md',
        kind: 'report',
        title: 'Report',
        mediaType: 'text/markdown',
      });
    const first = submit('capacity-1');
    await expect(submit('capacity-2')).rejects.toMatchObject({
      code: 'storage_capacity_unavailable',
    });
    expect(fixture.captureArtifact).toHaveBeenCalledOnce();
    release();
    await first;
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
  });

  it('cancellation after capture publishes nothing', async () => {
    const fixture = submissionFixture();
    const abort = new AbortController();
    const captured = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    fixture.captureArtifact.mockImplementation(async () => {
      abort.abort();
      return captured;
    });
    await expect(
      dispatchOpenkitWorkTool({ ...fixture.input, signal: abort.signal }, 'work_submit_artifact', {
        requestId: 'cancelled',
        path: '/openkit/sessions/as_00000000-0000-75c5-83d7-1a74418e3a38/outputs/report.md',
        kind: 'report',
        title: 'Report',
        mediaType: 'text/markdown',
      })
    ).rejects.toBeInstanceOf(Error);
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });
});

describe('submission seals and immutable exact output', () => {
  it('does not publish when accepted final status seals a still-running stored Turn', async () => {
    const fixture = submissionFixture();
    const captured = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    fixture.captureArtifact.mockImplementation(async () => {
      recordWorkerControlAcceptedRecord(fixture.coreDb, {
        acceptedAt: '2026-10-05T00:00:01.000Z',
        lineage: {
          ...fixture.environmentPackage.scope,
          packageSnapshotId: fixture.environmentPackage.snapshotId,
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sequence: 1,
      });
      return captured;
    });
    await expect(fixture.submit()).rejects.toMatchObject({
      code: 'turn_not_active',
    });
    expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it('preserves BOM and exact digest, redacts only the title and replays a decided Review', async () => {
    const fixture = submissionFixture();
    const captured = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    const bytes = Buffer.from('\uFEFF# Exact unchanged bytes\n');
    fixture.captureArtifact.mockResolvedValue({ ...captured, bytes });
    const overrides = { title: 'synthetic-injected-secret report' };
    const id = acknowledgedArtifactId(await fixture.submit('exact-output', overrides));
    const artifact = fixture.store.getArtifact('ws_00000000-0000-7000-8000-000000000001', id);
    expect(fixture.readBytes(id)).toEqual(bytes);
    expect(artifact.contentDigest).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    );
    expect(artifact.title).toBe('[redacted] report');
    decideArtifactReview(fixture.workspaceDb, {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      artifactContent: null,
      artifactFile: { byteLength: bytes.length, contentDigest: artifact.contentDigest },
      artifactId: id,
      artifactMediaType: 'text/markdown',
      artifactVersion: 1,
      decidedAt: '2026-10-05T01:00:00.000Z',
      decision: 'rejected',
      feedback: null,
      requestId: 'review-file',
    });
    expect(acknowledgedArtifactId(await fixture.submit('exact-output', overrides))).toBe(id);
    expect(getArtifactReview(fixture.workspaceDb, id, 1).decision).toBe('rejected');
    expect(fixture.captureArtifact).toHaveBeenCalledTimes(1);
  });
});

describe('submission publication and handled rollback', () => {
  it('publishes the reference and Artifact events only after the complete canonical tuple exists', async () => {
    const fixture = submissionFixture();
    const events: string[] = [];
    fixture.store.addTurnListener(fixture.turn.id, (event) => {
      events.push(event.event);
      expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
    });
    const id = acknowledgedArtifactId(await fixture.submit());
    expect(events).toEqual(['item.created', 'item.completed', 'artifact.created']);
    const sequence = fixture.store.getTurnEvents(fixture.turn.id).map((event) => event.sequence);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    expect(acknowledgedArtifactId(await fixture.submit())).toBe(id);
    expect(events).toHaveLength(3);
  });

  it('removes the new reference revision as well as Artifact authority when receipt persistence fails', async () => {
    const fixture = submissionFixture();
    fixture.store.createItem({
      id: 'it_00000000-0000-767c-97eb-d0af46940f44',
      type: 'assistant-message',
      status: 'completed',
      text: 'Keep existing history.',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: fixture.turn.id,
      createdAt: '2026-10-05T00:00:00.000Z',
      completedAt: '2026-10-05T00:00:00.000Z',
    });
    const historyPath = join(
      fixture.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'threads',
      'th_00000000-0000-7000-8000-000000000001',
      'turns',
      fixture.turn.id,
      'items.jsonl'
    );
    const priorRow = JSON.parse(readFileSync(historyPath, 'utf8'));
    priorRow.futureExtension = { retained: true };
    const priorBytes = `${JSON.stringify(priorRow)}\n`;
    writeFileSync(historyPath, priorBytes);
    const fail = vi.spyOn(fixture.store, 'recordCommandRequest').mockImplementation(() => {
      throw new Error('Receipt I/O failure.');
    });
    await expect(fixture.submit()).rejects.toThrow('Receipt I/O failure.');
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
    expect(readFileSync(historyPath, 'utf8')).toBe(priorBytes);
    const reopened = new FsStore({ dataRoot: fixture.dataRoot });
    expect(
      reopened
        .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
        .filter((artifact) => artifact.turnId === fixture.turn.id)
    ).toHaveLength(0);
    expect(
      reopened
        .listThreadItems(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .filter((item) => item.turnId === fixture.turn.id && item.type === 'artifact-reference')
    ).toHaveLength(0);
    expect(fixture.store.getTurnEvents(fixture.turn.id)).toHaveLength(0);
    fail.mockRestore();
    acknowledgedArtifactId(await fixture.submit('corrected-after-io'));
  });
});

/** Produces a small text PDF with exact xref offsets for the actual source consumer. */
function createPdfFixture(pages: readonly string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const page of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${page}) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

it('dispatches bounded source reads and refuses a path outside the accepted Turn inventory', async () => {
  const fixture = submissionFixture();
  await expect(
    dispatchOpenkitWorkTool(fixture.input, 'work_read_source', {
      path: 'sources/artifacts/not-selected/1.txt',
      mode: 'read',
    })
  ).resolves.toMatchObject({
    isError: false,
    structuredContent: { status: 'unavailable' },
  });
  expect(OPENKIT_WORK_TOOLS.map((tool) => tool.name)).toContain('work_read_source');
  expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
});

/** Captures an actual Artifact, processes and publishes its real snapshot bytes, and supplies only S39's independently verified trace result. Current scheduler, actor, source and receiving-audience checks stay real. */
async function sourceToolFixture(bytes: Buffer, mediaType: string) {
  const fixture = submissionFixture();
  ensureLocalUser(fixture.coreDb);
  recordWorkspaceOwnerMembership({
    coreDb: fixture.coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  fixture.captureArtifact.mockResolvedValue({
    bytes: Buffer.from(bytes),
    credentialCheckValues: fixture.credentialCheckValues,
  });
  const artifactId = acknowledgedArtifactId(await fixture.submit('req_source_tool', { mediaType }));
  const artifact = fixture.store.getArtifact('ws_00000000-0000-7000-8000-000000000001', artifactId);
  const workspaceRoot = join(fixture.dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001');
  const sourceFiles = await prepareArtifactSourceInputs({
    workspaceRoot,
    artifacts: [artifact],
    admission: fixture.fileAdmission,
    assertCurrent: (selected) => {
      expect(selected).toEqual(fixture.store.getArtifact('ws_00000000-0000-7000-8000-000000000001', artifactId));
    },
  });
  const requestItemId = allocateEntityId('it');
  const files = packageOwner.createWorkerContextPackageFiles({
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: fixture.turn.id,
    workerRequestItemId: requestItemId,
    workerRequestBytes: 'Inspect selected sources',
    includedItemIds: [requestItemId],
    contextBudgetTokens: 4096,
    materialSelections: [],
    sourceFiles,
  });
  await packageOwner.writeWorkerContextPackageFiles(workspaceRoot, files, {
    admission: fixture.fileAdmission,
  });
  const source = files.sourceFiles![0]!;
  const { scope } = fixture.environmentPackage;
  const entry = createSchedulerAdmissionEntry(fixture.coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_source_read',
    requestId: scope.requestId,
    triggerActor: scope.triggerActor,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    turnInput: 'Read source',
    requestedAgentId: fixture.environmentPackage.agent.agentId,
  });
  recordTestExecutionAttempt(fixture.coreDb, {
    entry,
    attemptId: allocateEntityId('attempt'),
    agentSessionId: scope.agentSessionId,
    inputRef: fixture.environmentPackage.snapshotId,
    bindingRef: 'binding_source_read',
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => new Date().toISOString(),
  });
  const proof = vi.spyOn(packageOwner, 'readWorkerContextPackageTrace').mockReturnValue({
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    agentSessionId: scope.agentSessionId,
    packageSnapshotId: fixture.environmentPackage.snapshotId,
    sourceFiles: [source],
  } as packageOwner.WorkerContextPackageTrace);
  onTestFinished(() => proof.mockRestore());
  return { ...fixture, artifactId, source, packagePath: source.packagePath, proof };
}

it('reads retained bytes through the real dispatcher and withholds them after current user access is revoked', async () => {
  const fixture = await sourceToolFixture(Buffer.from('Finished report\n'), 'text/plain');
  const { packagePath, proof, artifactId } = fixture;
  const result = await dispatchOpenkitWorkTool(fixture.input, 'work_read_source', {
    path: packagePath,
    mode: 'read',
  });
  expect(result.structuredContent).toMatchObject({
    status: 'ready',
    text: 'Finished report\n',
    eof: true,
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
  expect(proof).toHaveBeenCalledOnce();
  const unselected = await dispatchOpenkitWorkTool(fixture.input, 'work_read_source', {
    path: `${packagePath}/not-selected`,
    mode: 'read',
  });
  expect(unselected.structuredContent).toEqual({ status: 'unavailable', reason: 'unavailable' });
  expect(JSON.stringify(unselected)).not.toContain('Finished report');
  expect(proof).toHaveBeenCalledTimes(2);
  fixture.coreDb.sqlite.transaction(() => {
    disableCanonicalUser(fixture.coreDb, 'usr_00000000-0000-7000-8000-000000000001');
  })();
  const denied = await dispatchOpenkitWorkTool(fixture.input, 'work_read_source', {
    path: packagePath,
    mode: 'read',
  });
  expect(denied.structuredContent).toEqual({ status: 'unavailable', reason: 'unavailable' });
  expect(JSON.stringify(denied)).not.toContain(artifactId);
  expect(JSON.stringify(denied)).not.toContain('Finished report');
  expect(proof).toHaveBeenCalledTimes(2);
});

it(
  'searches only the selected retained PDF text through the real Worker Tool and kernel',
  async () => {
    const f = await sourceToolFixture(
      createPdfFixture(['first page', 'second needle']),
      'application/pdf'
    );
    expect(f.source.projection.pdfTextLayer).toBeDefined();
    const result = await dispatchOpenkitWorkTool(f.input, 'work_search_source', {
      path: f.packagePath,
      mode: 'exact',
      query: 'needle',
    });
    expect(result.structuredContent).toMatchObject({
      status: 'ready',
      result: {
        hits: [
          {
            digest: f.source.originalDigest.slice(7),
            representation_digest: f.source.projection.representationDigest.slice(7),
            locator: {
              kind: 'text',
              original: `${JSON.stringify(f.source.source.reference)}#page=2`,
            },
          },
        ],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
    const denied = await dispatchOpenkitWorkTool(f.input, 'work_search_source', {
      path: `${f.packagePath}/unselected`,
      query: 'needle',
    });
    expect(denied.structuredContent).toEqual({ status: 'unavailable', reason: 'unavailable' });
    expect(JSON.stringify(denied)).not.toContain(f.artifactId);
  },
  30_000
);
