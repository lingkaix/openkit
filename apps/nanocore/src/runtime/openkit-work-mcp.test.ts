import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decideArtifactReview, getArtifactReview } from '../artifact-reviews.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { dispatchOpenkitWorkTool, OPENKIT_WORK_TOOLS } from './openkit-work-mcp.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import type { WorkerCredentialCheckValues } from './worker-credential-guard.js';

/** Creates real canonical owners; the capture double stands outside the Core publication seam. */
function submissionFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-submit-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot });
  const turn = store.createTurn('ws_demo', 'th_demo', 'Submit a finished file', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup(),
    agentSessionId: 'as_submit_1',
    triggerActor: turn.triggerActor,
    userId: 'user_local',
    backend: { kind: 'openshell' },
    createdAt: '2026-10-05T00:00:00.000Z',
    requestId: 'req_turn_start',
    turn,
    workspaceCwd: '/workspace/output',
    workspaceRoots: [],
  });
  environmentPackage.workspace.outputs = [
    {
      id: 'main-worktree',
      path: '/workspace/output',
      registerAsArtifacts: true,
      retention: 'sync-on-turn-end',
    },
  ];
  store.updateTurn(turn.id, {
    status: 'running',
    agentId: environmentPackage.agent.agentId,
    agentSessionId: 'as_submit_1',
  });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  onTestFinished(() => {
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
  const input = { coreDb, environmentPackage, store, workspaceDb, captureArtifact };
  const submit = (requestId = 'req_file_1', overrides: Record<string, unknown> = {}) =>
    dispatchOpenkitWorkTool(input, 'work_submit_artifact', {
      requestId,
      path: '/workspace/output/report.md',
      kind: 'report',
      title: 'Report',
      mediaType: 'text/markdown',
      ...overrides,
    });
  const counts = () => ({
    artifacts: store.listArtifacts('ws_demo').filter((artifact) => artifact.turnId === turn.id)
      .length,
    references: store
      .listThreadItems('ws_demo', 'th_demo')
      .filter((item) => item.type === 'artifact-reference' && item.turnId === turn.id).length,
    reviews: (
      workspaceDb.sqlite.prepare('SELECT count(*) AS n FROM artifact_reviews').get() as {
        n: number;
      }
    ).n,
    receipts: store.listCommandRequests().length,
  });
  return { ...input, submit, counts, turn, dataRoot };
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
  it('advertises work_submit_artifact on the existing work supply', () => {
    expect(OPENKIT_WORK_TOOLS.map((tool) => tool.name)).toContain('work_submit_artifact');
  });

  it('returns an Artifact id only after Artifact, reference, Review and receipt are durable', async () => {
    const fixture = submissionFixture();
    const id = acknowledgedArtifactId(await fixture.submit());
    expect(fixture.counts()).toEqual({ artifacts: 1, references: 1, reviews: 1, receipts: 1 });
    expect(
      fixture.store.listArtifacts('ws_demo').find((artifact) => artifact.id === id)
    ).toMatchObject({
      content: { body: 'Finished report\n' },
      turnId: fixture.turn.id,
      origin: { kind: 'turn-output', requestId: 'req_file_1' },
    });
    expect(getArtifactReview(fixture.workspaceDb, id, 1)).toMatchObject({
      sourceTurnId: fixture.turn.id,
    });
    expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
    // Reopening canonical owners checks persistence rather than just the producer's live indexes.
    const reopened = new FsStore({ dataRoot: fixture.dataRoot });
    expect(reopened.listArtifacts('ws_demo').map((artifact) => artifact.id)).toContain(id);
    expect(reopened.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ type: 'artifact-reference', artifactId: id })
    );
    expect(reopened.listCommandRequests()).toContainEqual(
      expect.objectContaining({ requestId: 'req_file_1', response: { kind: 'artifact', id } })
    );
    const reopenedWorkspaceDb = openWorkspaceDb(fixture.dataRoot, 'ws_demo');
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
    expect(
      fixture.store.listArtifacts('ws_demo').find((artifact) => artifact.id === first)?.content
        ?.body
    ).toBe('Finished report\n');
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

  it('rejects unadmitted media without capture or publication and permits correction', async () => {
    const fixture = submissionFixture();
    await expect(fixture.submit('req_bad_media', { mediaType: 'image/png' })).rejects.toMatchObject(
      { code: 'invalid_request' }
    );
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

  it('counts only published bytes and passes remaining capacity plus one sentinel to capture', async () => {
    const fixture = submissionFixture();
    const clean = await fixture.captureArtifact({
      packageSnapshotId: '',
      requestId: '',
      path: '',
      maxByteLength: 0,
    });
    fixture.captureArtifact.mockClear();
    fixture.captureArtifact.mockResolvedValueOnce({
      ...clean,
      bytes: Buffer.alloc(16 * 1024 * 1024 + 1, 120),
    });
    await expect(fixture.submit('req_too_large')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
    await fixture.submit('req_small');
    await fixture.submit('req_next');
    expect(fixture.captureArtifact.mock.calls.map(([request]) => request.maxByteLength)).toEqual([
      16 * 1024 * 1024 + 1,
      16 * 1024 * 1024 + 1,
      16 * 1024 * 1024 - clean.bytes.length + 1,
    ]);
    expect(fixture.counts()).toEqual({ artifacts: 2, references: 2, reviews: 2, receipts: 2 });
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
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'turn_not_active' });
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
    '/workspace/output',
    '/workspace/output/../report.md',
    '/workspace/output//report.md',
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
        path: '/workspace/output/report.md',
      });
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.captureArtifact).not.toHaveBeenCalled();
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
  });

  it.each([
    'empty',
    'invalid-utf8',
    'invalid-json',
  ])('publishes nothing for %s bytes', async (kind) => {
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
    await expect(
      fixture.submit('format', {
        mediaType: kind === 'invalid-json' ? 'application/json' : 'text/plain',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.counts()).toEqual({ artifacts: 0, references: 0, reviews: 0, receipts: 0 });
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
    fixture.store.updateTurn(fixture.turn.id, { [field]: 'contradictory-source' });
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

  it('admits the exact quota boundary and refuses the competing caller without consuming capacity', async () => {
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
      bytes: Buffer.alloc(8 * 1024 * 1024, 10),
    });
    await Promise.all([fixture.submit('quota-1'), fixture.submit('quota-2')]);
    expect(fixture.counts()).toEqual({ artifacts: 2, references: 2, reviews: 2, receipts: 2 });
    await expect(fixture.submit('quota-3')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fixture.captureArtifact.mock.calls.at(-1)![0].maxByteLength).toBe(1);
  });

  it('rechecks quota when two captures compete for insufficient remaining capacity', async () => {
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
      bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 10),
    });
    const results = await Promise.allSettled([
      fixture.submit('compete-1'),
      fixture.submit('compete-2'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
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
      dispatchOpenkitWorkTool({ ...fixture, signal: abort.signal }, 'work_submit_artifact', {
        requestId: 'cancelled',
        path: '/workspace/output/report.md',
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
    await expect(fixture.submit()).rejects.toMatchObject({ code: 'turn_not_active' });
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
    const artifact = fixture.store.getArtifact('ws_demo', id);
    expect(artifact.content.body).toBe(bytes.toString('utf8'));
    expect(artifact.contentDigest).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    );
    expect(artifact.title).toBe('[redacted] report');
    decideArtifactReview(fixture.workspaceDb, {
      actorId: 'user_local',
      artifactContent: artifact.content.body,
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
      id: 'it_prior',
      type: 'assistant-message',
      status: 'completed',
      text: 'Keep existing history.',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: fixture.turn.id,
      createdAt: '2026-10-05T00:00:00.000Z',
      completedAt: '2026-10-05T00:00:00.000Z',
    });
    const historyPath = join(
      fixture.dataRoot,
      'workspaces',
      'ws_demo',
      'threads',
      'th_demo',
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
      reopened.listArtifacts('ws_demo').filter((artifact) => artifact.turnId === fixture.turn.id)
    ).toHaveLength(0);
    expect(
      reopened
        .listThreadItems('ws_demo', 'th_demo')
        .filter((item) => item.turnId === fixture.turn.id && item.type === 'artifact-reference')
    ).toHaveLength(0);
    expect(fixture.store.getTurnEvents(fixture.turn.id)).toHaveLength(0);
    fail.mockRestore();
    acknowledgedArtifactId(await fixture.submit('corrected-after-io'));
  });
});
