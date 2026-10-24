import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { ModelCapture, withTurnModelCapture } from '../llm/model-capture.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { recordWorkerControlAcceptedRecord } from '../runtime/worker-control-records.js';
import { prepareWorkerTurnJournalIntents } from '../runtime/worker-governance-turn-executor.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { appendRecoveredTurnObservation } from './work-observation-recovery.js';
import {
  appendWorkObservation,
  applyControlWorkObservation,
  parseWorkObservationRecord,
  prepareControlWorkObservation,
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationDraft,
  type WorkObservationRecord,
} from './work-observations.js';
import { verifyWorkspaceExportTree, WORKSPACE_EXPORT_MANIFEST_FILE } from './workspace-export.js';
import {
  createVerifiedWorkspaceExport,
  importVerifiedWorkspace,
} from './workspace-transfer-routes.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const roots: string[] = [];
const databases: (CoreDb | WorkspaceDb)[] = [];
const names: Readonly<Record<string, string>> = {
  core: 'nanocore',
  gateway: 'llm-gateway',
  sidecar: 'worker-shim',
  nanohost: 'nanohost',
};
const historicalNames: Readonly<Record<string, string>> = {
  nanocore: 'core',
  'llm-gateway': 'gateway',
  'worker-shim': 'sidecar',
  nanohost: 'nanohost',
};

afterEach(async () => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Opens the real Workspace owner, including its native migrations. */
function workspaceDb(dataRoot: string, workspaceId: string) {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  databases.push(db);
  applyScopedMigrations(db);
  return db;
}

/** Creates an admitted Turn and real storage without a server, runtime or provider process. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observer-names-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Observer names');
  const thread = await store.createThread(workspace.id, 'Observer names');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: workspace.id });
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Retain observations',
    { kind: 'user', id: userId },
    null,
    { captureCoverage: { scope: 'server', value: 'on' } }
  );
  const db = workspaceDb(dataRoot, workspace.id);
  const owner = { threadId: thread.id, turnId: turn.id };
  return {
    dataRoot,
    coreDb,
    store,
    db,
    turn,
    owner,
  };
}

/** Reads portable archive rows without the production parser that is subject to this rename. */
function diskRows(path: string): WorkObservationRecord[] {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** Reads original native metadata bytes without projecting retained observer names. */
function nativeBytes(db: WorkspaceDb, turnId: string): string[] {
  return (
    db.sqlite
      .prepare(
        'SELECT record_json FROM control_work_observations WHERE turn_id=? ORDER BY sequence'
      )
      .all(turnId) as { record_json: string }[]
  ).map((row) => row.record_json);
}

/** Decodes the raw native records independently of the observer-name reader under test. */
function nativeRows(db: WorkspaceDb, turnId: string): WorkObservationRecord[] {
  return nativeBytes(db, turnId).map((record) => JSON.parse(record));
}

/** Installs historical spelling in existing fixture identities only while the native writer is stopped. */
async function retainHistoricalRows(
  f: Awaited<ReturnType<typeof fixture>>,
  rows: readonly (Omit<WorkObservationRecord, 'obs'> & { obs: string })[]
) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.transaction(() => {
    const update = f.db.sqlite.prepare(
      'UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND id=?'
    );
    for (const row of rows) {
      expect(update.run(` ${JSON.stringify(row)} `, f.turn.id, row.id).changes).toBe(1);
    }
  })();
}

/** Serializes fixture history with visible whitespace that a rewrite would remove. */
function ledgerBytes(rows: readonly unknown[]): Buffer {
  return Buffer.from(rows.map((row) => ` ${JSON.stringify(row)} \n`).join(''));
}

/** Runs the model producer and its actual body-publication path with admitted semantic input. */
async function captureModel(f: Awaited<ReturnType<typeof fixture>>) {
  const capture = new ModelCapture({ workspaceDb: f.db, ...f.owner, corr: 'call-one' }, [], 'test');
  await capture.request({
    model: 'test-model',
    messages: [{ role: 'user', content: '  exact original é\n\tfinal  ' }],
    temperature: 0,
  });
}

/** Exercises each changed producer, including inherited publication observers. */
async function captureAllWriters(f: Awaited<ReturnType<typeof fixture>>) {
  await withTurnModelCapture(
    {
      store: f.store,
      turn: f.turn,
      workspaceDb: f.db,
      environment: { systemPrompt: 'Observer test', tools: [] },
    },
    async () => captureModel(f)
  );
  const setup = createTestAgentSetup();
  const session = await f.store.createAgentSession({
    id: testEntityId('as', 'observer-names'),
    agentId: setup.manifest.id,
    workspaceId: f.db.workspaceId,
    threadId: f.owner.threadId,
    status: 'busy',
    message: null,
    createdAt: f.turn.startedAt!,
    updatedAt: f.turn.startedAt!,
  });
  // Admit the original pre-effect Worker graph; terminalization must retain its real journal obligations.
  const environmentPackage = resolveAgentEnvironmentPackage({
    coreDb: f.coreDb,
    captureCoverage: { scope: 'server', value: 'on' },
    agentSessionId: session.id,
    agentSetup: setup,
    backend: { kind: 'openshell' },
    createdAt: f.turn.startedAt!,
    requestId: 'observer-names',
    turn: f.turn,
    turnInput: 'Retain observations',
    triggerActor: f.turn.triggerActor,
    workspaceRoots: [],
  });
  recordAgentEnvironmentPackageSnapshot(f.db, {
    environmentPackage,
    createdAt: f.turn.startedAt!,
  });
  const target = recordTestNativeRuntimeTarget(f.coreDb);
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'observer-names',
    requestId: 'observer-names',
    triggerActor: f.turn.triggerActor,
    profileRef: setup.profileId,
    requestedAgentId: setup.manifest.id,
    workspaceId: f.db.workspaceId,
    threadId: f.owner.threadId,
    turnId: f.turn.id,
    turnInput: 'Retain observations',
  });
  const attempt = recordTestExecutionAttempt(f.coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'observer-names'),
    agentSessionId: session.id,
    inputRef: environmentPackage.snapshotId,
    bindingRef: `fixture-native-binding:${session.id}`,
    sessionCompatibilityKey: 'fixture-observer-names',
    now: () => f.turn.startedAt!,
  });
  const journalIntents = prepareWorkerTurnJournalIntents(f.db, environmentPackage, attempt, {
    backendKind: 'openshell',
    targetId: target.targetId,
    allocationRef: attempt.bindingRef,
  });
  await f.store.updateTurn(f.turn.id, { agentSessionId: session.id }, { journalIntents });
  const lineage = {
    workspaceId: f.db.workspaceId,
    ...f.owner,
    agentSessionId: session.id,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: 'observer-names',
  };
  await recordWorkerControlAcceptedRecord(f.coreDb, {
    lineage,
    operation: 'event_append',
    recordKey: '1',
    sequence: 1,
    acceptedAt: f.turn.startedAt!,
    record: {
      kind: 'event',
      schemaVersion: 1,
      lineage,
      sequence: 1,
      event: {
        type: 'observation.recorded',
        data: {
          observationId: 'runtime-one',
          sourceRef: 'source-one',
          sourceSequence: 1,
          observedAt: f.turn.startedAt!,
          fact: { kind: 'tool', runtimeOriginRef: null, callRef: 'tool-one', phase: 'started' },
          content: {
            state: 'expected',
            bytes: 0,
            sha256: `sha256:${createHash('sha256').update('').digest('hex')}`,
            chunkCount: 0,
            mediaType: 'text/plain',
            boundary: 'runtime-tool-result',
          },
        },
      },
    },
  });
  const terminal = await terminalizeGovernedWorkerTurn({
    agentSessionId: session.id,
    completedAt: new Date().toISOString(),
    errorCode: 'worker_governance_restart_recovery',
    message: 'Worker execution was interrupted during NanoCore restart recovery.',
    outcome: 'interrupted',
    requestId: null,
    store: f.store,
    turnId: f.turn.id,
  });
  if (!('id' in terminal)) throw new Error('Expected the retained Turn after terminalization');
  appendRecoveredTurnObservation(f.db, terminal, 'anchored-cleanup');
}

/** Provides a valid generic coverage record for observer-domain admission checks. */
function gap(
  f: Awaited<ReturnType<typeof fixture>>,
  obs: unknown,
  id: string
): WorkObservationDraft {
  return {
    id,
    type: 'capture.unavailable',
    ts: f.turn.startedAt!,
    // Deliberately cross the runtime admission seam, including invalid and historical inputs.
    obs: obs as WorkObservationDraft['obs'],
    payload: { family: 'runtime-content', reason: 'unsupported' },
  };
}

// Owner: docs/specs/20260921-work_data_retention_format.md (RET) plus the engineer's retained-v1 rename ruling.
describe('retained observer names', () => {
  it('RET Collection Responsibility: "Each point writes only in its observer value obs" — real writers and publications use the new names', async () => {
    const f = await fixture();
    await captureAllWriters(f);
    const rows = nativeRows(f.db, f.turn.id);
    expect(rows.map((row) => [row.type, row.obs])).toEqual([
      ['env.bound', 'nanocore'],
      ['model.observed', 'llm-gateway'],
      ['content.published', 'llm-gateway'],
      ['runtime.observed', 'worker-shim'],
      ['content.published', 'worker-shim'],
      ['turn.reap', 'nanocore'],
    ]);
    expect(rows.every((row) => row.v === 1)).toBe(true);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readWorkObservationTurnBinding(f.db, f.owner).turn.requiredFeatures).toEqual([
      'openkit.work-observations.v1',
    ]);
  });

  it('RET Observation Ledger Envelope: "Append only" — historical v1 names reopen mapped without changing native metadata bytes', async () => {
    const f = await fixture();
    await captureAllWriters(f);
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation: gap(f, 'nanohost', 'host'),
      bodies: [],
    });
    const historical = nativeRows(f.db, f.turn.id).map((row) => ({
      ...row,
      obs: historicalNames[row.obs] ?? row.obs,
      ext: { 'test.annotation': { text: 'retain é', values: [null, 0] } },
    }));
    await retainHistoricalRows(f, historical);
    const bytes = nativeBytes(f.db, f.turn.id);
    const manifest = f.db.sqlite
      .prepare('SELECT record_json FROM control_turns WHERE id=?')
      .get(f.turn.id);
    f.db.sqlite.close();
    const reopened = workspaceDb(f.dataRoot, f.db.workspaceId);
    const rows = readWorkObservations(reopened, f.owner);
    expect.soft(rows).toEqual(historical.map((row) => ({ ...row, obs: names[row.obs] })));
    expect(nativeBytes(reopened, f.turn.id)).toEqual(bytes);
    expect(
      reopened.sqlite.prepare('SELECT record_json FROM control_turns WHERE id=?').get(f.turn.id)
    ).toEqual(manifest);
  });

  it('RET Capture Publication: "Same identity and same content replay is idempotent" — mixed historical/current rows replay without append or rewrite', async () => {
    const f = await fixture();
    await captureModel(f);
    const [metadata, publication] = nativeRows(f.db, f.turn.id);
    await retainHistoricalRows(f, [
      { ...metadata!, obs: 'gateway' },
      { ...publication!, obs: 'llm-gateway' },
    ]);
    const bytes = nativeBytes(f.db, f.turn.id);
    const ref = publication!.refs![0]!;
    const body = readWorkObservationBody(f.db, {
      ...f.owner,
      bundleId: ref.locator,
      createdAt: publication!.ts,
      sha256: ref.digest!,
    })!;
    expect(body).not.toBeNull();
    f.db.sqlite.close();
    const reopened = workspaceDb(f.dataRoot, f.db.workspaceId);
    const { v: _v, seq: _seq, turnId: _turnId, ...draft } = metadata!;
    const { bodies: _bodies, ...payload } = draft.payload;
    const input = {
      ...f.owner,
      observation: { ...draft, payload, obs: 'llm-gateway' as WorkObservationDraft['obs'] },
      bodies: [
        {
          id: 'semantic',
          bytes: body,
          mediaType: 'application/json',
          boundary: 'gateway-admitted-semantic-v1',
        },
      ],
    };
    expect((await appendWorkObservation(reopened, input)).disposition).toBe('duplicate');
    expect((await appendWorkObservation(reopened, input)).disposition).toBe('duplicate');
    expect(readWorkObservations(reopened, f.owner).map((row) => row.obs)).toEqual([
      'llm-gateway',
      'llm-gateway',
    ]);
    const divergent = {
      ...input,
      observation: { ...input.observation, payload: { ...payload, model: 'changed' } },
    };
    const owner = { kind: 'workspace' as const, workspaceId: reopened.workspaceId };
    await shutdownControlStoreWorkerClient();
    // Confirm the intended identity fault inside the real native body; transport retains only safe refusal facts.
    const prepared = prepareControlWorkObservation(owner, divergent);
    expect(() =>
      reopened.sqlite.transaction(() =>
        applyControlWorkObservation(reopened.sqlite, owner, prepared)
      )()
    ).toThrow('recovery_required: observation identity conflict');
    await expect(appendWorkObservation(reopened, divergent)).rejects.toMatchObject({
      name: 'ControlStoreWorkerError',
      code: 'sql-failed',
      commit: 'not-committed',
      message: 'Control database writer operation failed.',
    });
    expect(nativeBytes(reopened, f.turn.id)).toEqual(bytes);
  });

  it('RET References: "A reference MUST NEVER be wrong" — old exports retain bytes, annotations and lineage with mapped observers', async () => {
    const f = await fixture();
    await captureModel(f);
    const sourceLedger = nativeBytes(f.db, f.turn.id);
    const exported = await createVerifiedWorkspaceExport({
      fileAdmission: new FileStorageAdmission(f.dataRoot, () => 0n),
      requestActor: { kind: 'local', userId },
      authorityUserId: userId,
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      exportId: testEntityId('wsexp', 'observer-names'),
      repositoryWorkspaceDb: (id) => workspaceDb(f.dataRoot, id),
      store: f.store,
      workspaceId: f.db.workspaceId,
    });
    const exportRoot = join(
      f.dataRoot,
      'server',
      'exports',
      'workspaces',
      f.db.workspaceId,
      exported.verified.manifest.id
    );
    const observationPath = [...exported.verified.fileContents.keys()].find((path) =>
      path.endsWith('/observations.jsonl')
    )!;
    // Build an old export from real producer output, then verify its revised byte inventory.
    const historical = diskRows(join(exportRoot, observationPath)).map((row) => ({
      ...row,
      obs: 'gateway',
      ext: { 'test.annotation': { text: 'historical é', values: [null, 0] } },
      futureAnnotation: 'ignored without rewriting the source',
    }));
    const bytes = ledgerBytes(historical);
    writeFileSync(join(exportRoot, observationPath), bytes);
    const manifest = JSON.parse(exported.verified.manifestText);
    const entry = manifest.contentInventory.find(
      (item: { path: string }) => item.path === observationPath
    );
    entry.bytes = bytes.byteLength;
    entry.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest.contentInventory)).digest('hex')}`;
    const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const manifestBytes = readFileSync(manifestPath);
    const verified = verifyWorkspaceExportTree({ exportRoot });
    expect(Buffer.from(verified.fileContents.get(observationPath)!)).toEqual(bytes);
    const result = await importVerifiedWorkspace({
      authorityUserId: userId,
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      requestId: null,
      store: f.store,
      verified,
    });
    const targetWorkspaceId = result.importedWorkspaceId;
    const thread = f.store.listThreads(targetWorkspaceId)[0]!;
    const turn = f.store.listThreadTurns(targetWorkspaceId, thread.id)[0]!;
    const importedDb = workspaceDb(f.dataRoot, targetWorkspaceId);
    const owner = { threadId: thread.id, turnId: turn.id };
    const rows = readWorkObservations(importedDb, owner);
    expect.soft(rows.map((row) => row.obs)).toEqual(['llm-gateway', 'llm-gateway']);
    expect(rows).toHaveLength(2);
    expect(targetWorkspaceId).not.toBe(f.db.workspaceId);
    expect(thread.id).not.toBe(f.owner.threadId);
    expect(turn.id).not.toBe(f.owner.turnId);
    expect(rows[0]!.id).not.toBe(historical[0]!.id);
    expect(rows[1]!.parent).toBe(rows[0]!.id);
    expect(rows[0]!.corr).toBe('call-one');
    expect(rows.map((row) => row.ext)).toEqual(historical.map((row) => row.ext));
    const sourceRef = historical[1]!.refs![0]!;
    const targetRef = rows[1]!.refs![0]!;
    expect(targetRef.locator).not.toBe(sourceRef.locator);
    expect(targetRef).toEqual({
      ...sourceRef,
      locator: targetRef.locator,
      scope: { ...sourceRef.scope, workspaceId: targetWorkspaceId },
    });
    const sourceBody = readWorkObservationBody(f.db, {
      ...f.owner,
      bundleId: sourceRef.locator,
      createdAt: historical[1]!.ts,
      sha256: sourceRef.digest!,
    });
    expect(sourceBody).not.toBeNull();
    expect(JSON.parse(Buffer.from(sourceBody!).toString()).messages).toEqual([
      { role: 'user', content: '  exact original é\n\tfinal  ' },
    ]);
    expect(createHash('sha256').update(sourceBody!).digest('hex')).toBe(targetRef.digest);
    expect(
      readWorkObservationBody(importedDb, {
        ...owner,
        bundleId: targetRef.locator,
        createdAt: rows[1]!.ts,
        sha256: targetRef.digest!,
      })
    ).toEqual(sourceBody);
    expect
      .soft(nativeRows(importedDb, turn.id).map((row) => row.obs))
      .toEqual(['llm-gateway', 'llm-gateway']);
    expect(readFileSync(join(exportRoot, observationPath))).toEqual(bytes);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    expect(nativeBytes(f.db, f.turn.id)).toEqual(sourceLedger);
  });

  it('RET Observation Ledger Envelope: obs identifies the observer; Contract Evolution: unknown core values fail closed — accepts current names only for writes', async () => {
    const f = await fixture();
    const current = ['nanocore', 'llm-gateway', 'worker-shim', 'nanohost'];
    for (const obs of current) {
      const observation = gap(f, obs, `accepted-${obs}`);
      expect
        .soft(() => parseWorkObservationRecord({ ...observation, v: 1, seq: 1, turnId: f.turn.id }))
        .not.toThrow();
      await expect
        .soft(appendWorkObservation(f.db, { ...f.owner, observation, bodies: [] }))
        .resolves.toMatchObject({ disposition: 'committed' });
    }
    for (const [index, obs] of ['unknown', 'Gateway', null, 1, {}, ['nanocore']].entries()) {
      const observation = gap(f, obs, `invalid-${index}`);
      expect
        .soft(() => parseWorkObservationRecord({ ...observation, v: 1, seq: 1, turnId: f.turn.id }))
        .toThrow();
      await expect
        .soft(appendWorkObservation(f.db, { ...f.owner, observation, bodies: [] }))
        .rejects.toThrow();
    }
    for (const obs of ['core', 'gateway', 'sidecar']) {
      await expect
        .soft(
          appendWorkObservation(f.db, {
            ...f.owner,
            observation: gap(f, obs, `old-write-${obs}`),
            bodies: [],
          })
        )
        .rejects.toThrow();
    }
    expect.soft(nativeRows(f.db, f.turn.id).map((row) => row.obs)).toEqual(current);
    const typed = await fixture();
    await captureAllWriters(typed);
    for (const row of nativeRows(typed.db, typed.turn.id).filter(
      (row) => row.type !== 'content.published'
    )) {
      const expected =
        row.type === 'model.observed'
          ? 'llm-gateway'
          : row.type === 'runtime.observed'
            ? 'worker-shim'
            : 'nanocore';
      expect.soft(() => parseWorkObservationRecord({ ...row, obs: expected })).not.toThrow();
      for (const obs of current.filter((candidate) => candidate !== expected)) {
        expect.soft(() => parseWorkObservationRecord({ ...row, obs })).toThrow();
      }
    }
  });
});
