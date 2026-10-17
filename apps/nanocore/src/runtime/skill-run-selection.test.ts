// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
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
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

/** Real catalog snapshots and command storage meet the existing modeled Worker boundary. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-run-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  const localUserId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Exact Skill selection');
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
  manifest.skills = [{ id: 'run-skill', digest: second.version.digest }];
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
  recordTestNativeRuntimeTarget(coreDb);
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
  cleanup.push(() => workspaceDb.sqlite.close());
  const request = (digest: string, skillId = 'run-skill') => ({
    workspaceId: workspace.id,
    threadId: store.createThread(workspace.id, 'Exact Skill run', undefined, 'conversation', {
      visibility: 'workspace',
    }).id,
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

it('retains two exact run choices and their AEP explanation without changing setup, default or pin', async () => {
  const f = fixture();
  const catalogBefore = readFileSync(catalogDocumentPath(f.dataRoot, f.workspace.id));
  const inputs = [f.request(f.first.version.digest), f.request(f.second.version.digest)];
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
  const f = fixture();
  const input = f.request(f.outside.version.digest, 'outside-skill');
  const response = await f.call(input);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'invalid_skill_selection' });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.store.listThreadTurns(f.workspace.id, input.threadId)).toEqual([]);
});
