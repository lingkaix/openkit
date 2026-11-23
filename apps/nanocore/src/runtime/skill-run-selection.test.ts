// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  catalogDocumentPath,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  setWorkspaceSkillPin,
} from '../catalog/resource-catalog.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real catalog snapshots and command storage meet the existing modeled Worker boundary. */
async function fixture(explicitSetupVersion = true) {
  // The simulated executor is the packaged self-check path: the env selects, before the Control
  // worker starts, the Native writer that publishes its final through the admitted owner.
  process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
  cleanup.push(async () => {
    delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  });
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-run-'));
  const databases: (ReturnType<typeof openCoreDb> | ReturnType<typeof openWorkspaceDb>)[] = [];
  cleanup.push(() => disposeTestStore(dataRoot, ...databases.reverse()));
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const localUserId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Exact Skill selection');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: localUserId });
  const version = (body: string, expectedRevision: number, id = 'run-skill') =>
    importWorkspaceSkill({
      dataRoot,
      workspaceId: workspace.id,
      expectedRevision,
      id,
      displayName: 'Run Skill',
      activate: expectedRevision === 0,
      producer: { kind: 'user', id: localUserId },
      createdAt: '2026-10-17T00:00:00.000Z',
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            `---\nname: run-skill\ndescription: Exact run selection.\n---\n${body}\n`
          ).toString('base64'),
        },
      ],
    });
  const first = version('Version A', 0);
  const second = version('Version B', 1);
  setWorkspaceSkillPin({
    dataRoot,
    workspaceId: workspace.id,
    entryId: 'run-skill',
    digest: first.version.digest,
    expectedPinDigest: null,
    expectedRevision: 2,
  });
  const outside = version('Outside composed setup', 3, 'outside-skill');
  const manifest = createTestAgentSetup({ skillIds: ['run-skill'] }).manifest;
  manifest.skills = [
    { id: 'run-skill', ...(explicitSetupVersion ? { digest: second.version.digest } : {}) },
  ];
  // Catalog reload must see the same authored setup rather than discard inline test options.
  mkdirSync(join(dataRoot, 'config', 'agents'), { recursive: true });
  mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'agents', `${manifest.id}.agent.jsonc`),
    JSON.stringify(manifest)
  );
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    JSON.stringify(createTestGatewayConfig())
  );
  writeFileSync(
    join(dataRoot, 'config', 'providers', 'agent-openrouter.provider.jsonc'),
    JSON.stringify({
      id: 'agent-openrouter',
      displayName: 'Test inference provider',
      kind: 'local',
      defaultModel: 'openai/gpt-5.2',
      models: ['openai/gpt-5.2'],
    })
  );
  await recordTestNativeRuntimeTarget(coreDb);
  const executor = new SimulatedTurnExecutor({ coreDb });
  const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
  const submit = vi.spyOn(executor, 'submit');
  const app = createApp({
    dataRoot,
    coreDb,
    store,
    turnExecutor: executor,
    agentManifests: [manifest],
  });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(workspaceDb);
  const request = async (digest: string, skillId = 'run-skill') => ({
    workspaceId: workspace.id,
    threadId: (
      await store.createThread(workspace.id, 'Exact Skill run', undefined, 'conversation', {
        visibility: 'workspace',
      })
    ).id,
    requestId: randomUUID(),
    agentId: manifest.id,
    input: 'Check supplied Skill.',
    skillSelections: [{ skillId, digest }],
  });
  const call = (input: unknown) =>
    app.request(...operationRequest('turn.start', {}, { body: JSON.stringify(input) }));
  return {
    app,
    call,
    coreDb,
    dataRoot,
    first,
    second,
    outside,
    workspace,
    workspaceDb,
    store,
    request,
    prepare,
    submit,
  };
}

it('returns a storage recovery refusal when the Workspace queue input insert fails', async () => {
  const f = await fixture();
  const request = await f.request(f.first.version.digest);
  f.workspaceDb.sqlite.exec(
    `CREATE TRIGGER refuse_queue_input BEFORE INSERT ON workspace_work_inputs
      BEGIN SELECT RAISE(ABORT, 'Workspace queue input insert is unavailable'); END`
  );

  const response = await f.call(request);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'recovery_required' });
  expect(
    f.coreDb.sqlite
      .prepare('SELECT 1 FROM scheduler_admission_entries WHERE request_id = ?')
      .get(request.requestId)
  ).toBeUndefined();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});

it('rejects a non-scalar public start retry before writing a receipt', async () => {
  const f = await fixture();
  const request = { ...(await f.request(f.first.version.digest)), input: '\uFFFD' };
  const changed = { ...request, input: '\uD800' };
  const originalBytes = Buffer.from(request.input);
  expect(Buffer.from(changed.input)).toEqual(originalBytes);
  const receiptIds = f.workspaceDb.sqlite
    .prepare(
      "SELECT response_id FROM idempotency_requests WHERE command_name = 'turn.start' AND request_id = ?"
    )
    .pluck();
  const inputBytes = f.workspaceDb.sqlite
    .prepare('SELECT input_bytes FROM workspace_work_inputs WHERE invocation_id = ?')
    .pluck();
  const publish = vi
    .spyOn(f.store, 'createTurn')
    .mockRejectedValueOnce(new Error('Interrupted after Core admission'));

  const interrupted = await f.call(request);
  expect(interrupted.status).toBe(404);
  expect(await interrupted.json()).toMatchObject({ code: 'turn_start_failed' });
  expect(publish).toHaveBeenCalledOnce();
  publish.mockRestore();
  const originalTurnId = f.coreDb.sqlite
    .prepare('SELECT turn_id FROM scheduler_admission_entries WHERE request_id = ?')
    .pluck()
    .get(request.requestId);
  expect(originalTurnId).toEqual(expect.any(String));
  expect(receiptIds.all(request.requestId)).toEqual([]);
  expect(inputBytes.all(request.requestId)).toEqual([originalBytes]);

  const refused = await f.call(changed);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'recovery_required' });
  expect(receiptIds.all(request.requestId)).toEqual([]);
  expect(inputBytes.all(request.requestId)).toEqual([originalBytes]);

  const replayed = await f.call(request);
  expect(replayed.status, await replayed.clone().text()).toBe(202);
  expect(await replayed.json()).toMatchObject({ id: originalTurnId });
  expect(receiptIds.all(request.requestId)).toEqual([originalTurnId]);
  expect(inputBytes.all(request.requestId)).toEqual([originalBytes]);
});

it.each([
  { retry: 'exact', code: 'recovery_required' },
  { retry: 'changed', code: 'scheduler_admission_denied' },
] as const)(
  'keeps missing selected input absent on an $retry public start retry',
  async ({ retry, code }) => {
    const f = await fixture();
    const request = await f.request(f.first.version.digest);
    const publish = vi
      .spyOn(f.store, 'createTurn')
      .mockRejectedValueOnce(new Error('Interrupted after Core admission'));
    await f.call(request);
    expect(publish).toHaveBeenCalledOnce();
    publish.mockRestore();
    const selectedRow = f.coreDb.sqlite.prepare(
      'SELECT input_id AS inputId, input_digest AS digest, status FROM scheduler_admission_entries WHERE request_id = ?'
    );
    const selected = selectedRow.get(request.requestId) as
      | { inputId: string; digest: string; status: string }
      | undefined;
    expect(selected).toMatchObject({ status: 'queued' });
    expect(
      f.workspaceDb.sqlite
        .prepare('DELETE FROM workspace_work_inputs WHERE input_id = ?')
        .run(selected!.inputId).changes
    ).toBe(1);

    const response = await f.call(
      retry === 'changed' ? { ...request, input: 'Replacement from a later caller.' } : request
    );
    expect(
      f.workspaceDb.sqlite
        .prepare('SELECT 1 FROM workspace_work_inputs WHERE input_id = ?')
        .get(selected!.inputId)
    ).toBeUndefined();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
    expect(selectedRow.get(request.requestId)).toEqual(selected);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  }
);

it('retains two exact run choices and their AEP explanation without changing setup, default or pin', async () => {
  const f = await fixture();
  const catalogBefore = readFileSync(catalogDocumentPath(f.dataRoot, f.workspace.id));
  const inputs = [
    await f.request(f.first.version.digest),
    await f.request(f.second.version.digest),
  ];
  for (const input of inputs) {
    const response = await f.call(input);
    expect(response.status, await response.clone().text()).toBe(202);
    const result = await response.json();
    const turnId = result.id;
    await expect
      .poll(() => f.store.getTurnById(turnId).status, { timeout: 10_000 })
      .toBe('completed');
    await expect
      .poll(
        () =>
          listSchedulerExecutionAttemptsForTurn(f.coreDb, {
            workspaceId: f.workspace.id,
            threadId: input.threadId,
            turnId,
          })[0]?.phase
      )
      .toBe('closed');
    const attempt = listSchedulerExecutionAttemptsForTurn(f.coreDb, {
      workspaceId: f.workspace.id,
      threadId: input.threadId,
      turnId,
    })[0]!;
    const snapshot = requireAgentEnvironmentPackageSnapshot(
      f.workspaceDb,
      f.workspace.id,
      attempt.inputRef!
    ).snapshot;
    expect(snapshot.supply.skills).toEqual([
      expect.objectContaining({
        id: 'run-skill',
        integrity: { sha256: input.skillSelections[0]!.digest },
        selectionSource: 'run',
      }),
    ]);
    expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(turnId)).toMatchObject({
      skillSelections: input.skillSelections,
    });
    const replay = await f.call(input);
    expect(replay.status, await replay.clone().text()).toBe(202);
    expect((await replay.json()).id).toBe(turnId);
  }
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.submit).toHaveBeenCalledTimes(2);
  const changed = await f.call({ ...inputs[0], skillSelections: inputs[1]!.skillSelections });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ code: 'idempotency_key_conflict' });
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(readFileSync(catalogDocumentPath(f.dataRoot, f.workspace.id))).toEqual(catalogBefore);
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills).toMatchObject({
    entries: expect.arrayContaining([
      expect.objectContaining({ id: 'run-skill', currentDigest: f.first.version.digest }),
    ]),
    pins: [{ entryId: 'run-skill', digest: f.first.version.digest }],
  });
}, 30_000);

it('refuses an available Skill outside composed setup before Worker preparation or submission', async () => {
  const f = await fixture();
  const input = await f.request(f.outside.version.digest, 'outside-skill');
  const response = await f.call(input);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'invalid_skill_selection' });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.store.listThreadTurns(f.workspace.id, input.threadId)).toEqual([]);
});

it('retains the winning pin Audit only for pin-selected supply, without copying procedure bodies', async () => {
  const f = await fixture(false);
  const pin = async (digest: string | null) => {
    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    const requestId = randomUUID();
    const response = await f.app.request(
      ...operationRequest(
        'catalog.skill-pin',
        {},
        {
          body: JSON.stringify({
            workspaceId: f.workspace.id,
            requestId,
            expectedRevision: catalog.revision,
            expectedPinDigest: catalog.skills.pins[0]?.digest ?? null,
            skillId: 'run-skill',
            digest,
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return f.workspaceDb.sqlite
      .prepare('SELECT audit_event_id AS id FROM audit_events WHERE request_id = ? AND action = ?')
      .get(requestId, 'catalog.skill-pin.admit') as { id: string };
  };
  const firstPin = await pin(f.first.version.digest);
  const winner = await pin(f.first.version.digest);
  expect(winner.id).not.toBe(firstPin.id);
  const run = async (source: 'pin' | 'run') => {
    const { skillSelections, ...input } = await f.request(f.first.version.digest);
    const response = await f.call(source === 'run' ? { ...input, skillSelections } : input);
    expect(response.status, await response.clone().text()).toBe(202);
    const { id: turnId } = await response.json();
    await expect
      .poll(() => f.store.getTurnById(turnId).status, { timeout: 10_000 })
      .toBe('completed');
    await expect
      .poll(
        () =>
          listSchedulerExecutionAttemptsForTurn(f.coreDb, {
            workspaceId: f.workspace.id,
            threadId: input.threadId,
            turnId,
          })[0]?.phase
      )
      .toBe('closed');
    const attempt = listSchedulerExecutionAttemptsForTurn(f.coreDb, {
      workspaceId: f.workspace.id,
      threadId: input.threadId,
      turnId,
    })[0]!;
    const snapshot = requireAgentEnvironmentPackageSnapshot(
      f.workspaceDb,
      f.workspace.id,
      attempt.inputRef!
    ).snapshot;
    expect(snapshot.supply.skills).toEqual([
      expect.objectContaining({
        id: 'run-skill',
        integrity: { sha256: f.first.version.digest },
        selectionSource: source,
      }),
    ]);
    if (source === 'pin')
      expect(snapshot.supply.skills[0]?.lineage).toHaveProperty('pinAuditRef', winner.id);
    else expect(snapshot.supply.skills[0]?.lineage).not.toHaveProperty('pinAuditRef');
    expect(snapshot.agent.instructions).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('Version A');
    expect(JSON.stringify(snapshot)).not.toContain('Version B');
  };
  await run('pin');
  await run('run');
}, 30_000);
