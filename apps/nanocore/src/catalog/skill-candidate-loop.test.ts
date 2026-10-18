import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationId } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents, recordWorkspaceAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import { readSkillCandidateArtifact } from '../skill-candidate-artifact.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  CatalogConflictError,
  type CatalogTreeFile,
  decideWorkspaceSkillCandidate,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
  setWorkspaceSkillPin,
  submitWorkspaceSkillCandidate,
  validateCatalogTree,
} from './resource-catalog.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/skill-candidate-loop/', import.meta.url));
const producerFixtureRoot = join(fixtureRoot, 'candidate-producer');
const createdAt = '2026-10-16T09:00:00Z';
const digest = (body: string | Buffer) =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

/** Package test fixture bytes through the existing Artifact/tree admission shape. */
function packageTree(root: string, prefix = ''): CatalogTreeFile[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      return [{ kind: 'directory' as const, path }, ...packageTree(root, path)];
    if (!entry.isFile()) throw new Error('A test package must contain ordinary files only.');
    return [
      {
        kind: 'file' as const,
        path,
        executable: Boolean(statSync(join(root, path)).mode & 0o111),
        contentBase64: readFileSync(join(root, path)).toString('base64'),
      },
    ];
  });
}

/** Real retained Artifact and catalog owners; this fixture does not simulate native Task admission. */
function fixture(privateOwnerUserId?: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-candidate-component-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const workspaceId = store.listWorkspaces().find((workspace) => workspace.kind !== 'personal')!.id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: LOCAL_USER_ID });
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  cleanup.push(() => workspaceDb.sqlite.close());
  applyScopedMigrations(workspaceDb);
  const actor: Actor = { kind: 'session', userId: LOCAL_USER_ID };
  const thread = store.createThread(
    workspaceId,
    'Synthetic Skill candidate output',
    undefined,
    'conversation',
    privateOwnerUserId ? { visibility: 'private', privateOwnerUserId } : { visibility: 'workspace' }
  );
  const turn = store.createTurn(
    workspaceId,
    thread.id,
    'Prepare a synthetic workshop Skill candidate. Do not activate it.',
    { kind: 'user', id: LOCAL_USER_ID }
  );
  // This is explicit fake Worker output in ordinary retained records, not evidence of a scheduler or physical Worker run.
  store.updateTurn(turn.id, { agentId: 'ag_synthetic_author' });
  const tree = packageTree(join(fixtureRoot, 'workshop'));
  const body = JSON.stringify(tree);
  const artifact = store.createArtifact({
    id: allocateEntityId('ar'),
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    kind: 'file',
    title: 'Synthetic Skill candidate',
    status: 'ready',
    summary: 'Synthetic component output only.',
    version: 1,
    content: { format: 'json', body },
    contentDigest: digest(body),
    lastMutationRequestId: 'synthetic-author-output',
    origin: {
      kind: 'turn-output',
      threadId: thread.id,
      turnId: turn.id,
      requestId: 'synthetic-author-output',
    },
    createdAt,
    updatedAt: createdAt,
  });
  const selection = {
    workspaceId,
    artifactId: artifact.id,
    version: artifact.version,
    contentDigest: artifact.contentDigest,
  };
  return {
    actor,
    artifact,
    coreDb,
    dataRoot,
    selection,
    store,
    thread,
    tree,
    turn,
    workspaceDb,
    workspaceId,
  };
}

/** Component composition of retained Artifact admission and candidate submission. */
function submit(
  f: ReturnType<typeof fixture>,
  baseDigest: string | null = null,
  expectedRevision = 0
) {
  const admitted = readSkillCandidateArtifact({
    ...f,
    store: new FsStore({ dataRoot: f.dataRoot }),
  });
  if (admitted.producer?.kind !== 'agent')
    throw new Error('Expected proved fake Worker attribution.');
  const result = submitWorkspaceSkillCandidate({
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    entryId: 'synthetic-workshop',
    baseDigest,
    expectedRevision,
    createdAt,
    producer: { kind: admitted.producer.kind, id: admitted.producer.id },
    submitter: { kind: 'user', id: f.actor.userId },
    uploadedSourceId: admitted.source.artifactId,
    evidenceRefs: [
      `artifact:${f.artifact.id}:${f.artifact.version}:${f.artifact.contentDigest}`,
      `turn:${f.turn.id}`,
    ],
    summary: 'Synthetic workshop proposals; no real booking or acceptance.',
    tree: admitted.tree,
  });
  return { ...result, admitted };
}

/** Consumes the selected captured script bytes through Node; no native Skill installation or Worker delivery is claimed. */
function runProposal(script: string, input: unknown) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as { outcome: string; reason: string; evidence: unknown[] };
}

const sourceMappings = JSON.parse(
  readFileSync(join(fixtureRoot, 'workshop/references/sources.json'), 'utf8')
);
const request = {
  asOf: '2026-10-16T09:00:00Z',
  equipmentId: 'projector',
  start: '2026-10-16T10:00:00Z',
  end: '2026-10-16T11:00:00Z',
  quantity: 1,
  sources: sourceMappings,
};

describe('synthetic Skill Artifact/catalog component', () => {
  // Main takes 29.4 s alone (version stack: 28.1 s); allow headroom for sequential Turns under load.
  it('runs the synthetic native Task, Artifact, human promotion and later pinned-use loop', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-candidate-native-'));
    cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
    const coreDb = openCoreDb(dataRoot);
    cleanup.push(() => coreDb.sqlite.close());
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: LOCAL_USER_ID });
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    cleanup.push(() => workspaceDb.sqlite.close());
    applyScopedMigrations(workspaceDb);
    recordTestNativeRuntimeTarget(coreDb);
    const producerSkill = importWorkspaceSkill({
      dataRoot,
      workspaceId,
      id: 'candidate-producer',
      displayName: 'Test candidate producer',
      activate: true,
      expectedRevision: 0,
      createdAt,
      producer: { kind: 'user', id: LOCAL_USER_ID },
      tree: packageTree(producerFixtureRoot),
    });
    const producerSetup = createTestAgentSetup({
      agentId: 'agent_candidate_producer',
      skillIds: ['candidate-producer'],
    });
    const useSetup = createTestAgentSetup({
      agentId: 'agent_candidate_consumer',
      skillIds: ['synthetic-workshop'],
    });
    // Catalog publication reloads authored supply. Keep this fixture's Agents and route on disk.
    mkdirSync(join(dataRoot, 'config/agents'), { recursive: true });
    for (const setup of [producerSetup, useSetup])
      writeFileSync(
        join(dataRoot, 'config/agents', `${setup.manifest.id}.agent.jsonc`),
        JSON.stringify(setup.manifest)
      );
    mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config/providers/agent-openrouter.provider.jsonc'),
      JSON.stringify({
        id: 'agent-openrouter',
        displayName: 'Test inference provider',
        kind: 'local',
        models: ['openai/gpt-5.2'],
        modelMetadata: { 'openai/gpt-5.2': { limit: { context: 128_000 } } },
      })
    );
    writeFileSync(
      join(dataRoot, 'config/gateway.jsonc'),
      JSON.stringify(createTestGatewayConfig())
    );
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000_000n);
    const executor = new SimulatedTurnExecutor({ coreDb, fileAdmission });
    const app = createApp({
      fileAdmission,
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [producerSetup.manifest, useSetup.manifest],
    });
    const candidateTree = packageTree(join(fixtureRoot, 'workshop'));
    let selectedScript: string | null = null;
    const artifacts: ReturnType<FsStore['createArtifact']>[] = [];
    const createArtifact = store.createArtifact.bind(store);
    // The existing simulator owns admission/closeout. Only its Worker output is fake-backed here.
    vi.spyOn(store, 'createArtifact').mockImplementation((input) => {
      if (input.origin.kind !== 'turn-output') return createArtifact(input);
      const body = JSON.stringify(
        selectedScript === null ? candidateTree : runProposal(selectedScript, request)
      );
      const artifact = createArtifact({
        ...input,
        kind: 'file',
        title: 'SYNTHETIC Skill candidate output',
        summary: 'Fake Worker output; no real business acceptance or external booking.',
        content: { format: 'json', body },
        contentDigest: digest(body),
      });
      artifacts.push(artifact);
      return artifact;
    });
    const call = (operation: OperationId, input: Record<string, unknown>) =>
      app.request(
        ...operationRequest(operation, {}, { body: JSON.stringify({ workspaceId, ...input }) })
      );
    const start = async (agentId: string, input: string) => {
      const thread = store.createThread(workspaceId, 'SYNTHETIC Skill candidate Task');
      const requestId = randomUUID();
      const response = await call('task.start', { threadId: thread.id, requestId, agentId, input });
      expect(response.status, await response.clone().text()).toBe(202);
      const result = await response.json();
      await vi.waitFor(() => expect(store.getTurnById(result.turn.id).status).toBe('completed'), {
        timeout: 10_000,
      });
      const artifact = artifacts.find((value) => value.turnId === result.turn.id);
      expect(artifact).toBeDefined();
      expect(
        store.getCommandRequest('task.start', requestId, {
          workspaceId,
          threadId: thread.id,
          actorId: LOCAL_USER_ID,
        })?.response.id
      ).toBe(result.turn.id);
      return { turn: store.getTurnById(result.turn.id), artifact: artifact! };
    };
    const authored = await start(
      producerSetup.manifest.id,
      'Return the supplied synthetic workshop Skill candidate as an Artifact. Do not activate it.'
    );
    const submittedResponse = await call('catalog.skill-candidate-submit', {
      skillId: 'synthetic-workshop',
      expectedRevision: 1,
      baseDigest: null,
      requestId: randomUUID(),
      summary: 'SYNTHETIC workshop candidate, no real-use acceptance.',
      artifact: {
        artifactId: authored.artifact.id,
        version: authored.artifact.version,
        contentDigest: authored.artifact.contentDigest,
      },
    });
    expect(submittedResponse.status, await submittedResponse.clone().text()).toBe(201);
    const submitted = await submittedResponse.json();
    expect(submitted.candidate.producer).toEqual({ kind: 'agent', id: producerSetup.manifest.id });
    expect(
      loadWorkspaceResourceCatalog(dataRoot, workspaceId).skills.entries.find(
        (entry) => entry.id === 'synthetic-workshop'
      )?.currentDigest
    ).toBeNull();
    const promoted = await call('catalog.skill-candidate-decide', {
      candidateId: submitted.candidate.id,
      decision: 'promoted',
      expectedRevision: 2,
      expectedCurrentDigest: null,
      requestId: randomUUID(),
    });
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    const pin = await call('catalog.skill-pin', {
      skillId: 'synthetic-workshop',
      digest: submitted.candidate.candidateDigest,
      expectedRevision: 3,
      expectedPinDigest: null,
      requestId: randomUUID(),
    });
    expect(pin.status, await pin.clone().text()).toBe(200);
    const retained = readWorkspaceSkillSnapshot({
      dataRoot,
      workspaceId,
      entryId: 'synthetic-workshop',
      digest: submitted.candidate.candidateDigest,
    });
    selectedScript = retained.entries
      .find((entry) => entry.path === 'scripts/propose-booking.mjs')!
      .content!.toString('utf8');
    const used = await start(
      useSetup.manifest.id,
      'Use the pinned synthetic-workshop Skill with the explicitly synthetic fixture inventory and reservations. Propose only; do not book.'
    );
    expect(JSON.parse(used.artifact.content.body)).toEqual({
      outcome: 'propose',
      reason: 'snapshot-capacity',
      evidence: sourceMappings.map(
        ({ id, contentDigest }: { id: string; contentDigest: string }) => ({ id, contentDigest })
      ),
    });
    const snapshots = listExportableAgentEnvironmentPackageSnapshots(workspaceDb, workspaceId);
    expect(
      snapshots.find((record) => record.turnId === authored.turn.id)?.snapshot.supply.skills[0]
    ).toMatchObject({
      id: 'candidate-producer',
      integrity: { sha256: producerSkill.version.digest },
    });
    expect(
      snapshots.find((record) => record.turnId === used.turn.id)?.snapshot.supply.skills[0]
    ).toMatchObject({
      id: 'synthetic-workshop',
      integrity: { sha256: submitted.candidate.candidateDigest },
      selectionSource: 'pin',
    });
    const catalog = loadWorkspaceResourceCatalog(dataRoot, workspaceId);
    expect(catalog.skills.candidates[0]?.decision?.actor).toEqual({
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    expect(catalog.skills.pins[0]?.digest).toBe(submitted.candidate.candidateDigest);
  }, 60_000);

  it('admits only the test fixture without activation and keeps the retired author package absent', () => {
    expect(
      existsSync(fileURLToPath(new URL('../../../../skills/openkit-bwm-author/', import.meta.url)))
    ).toBe(false);
    const f = fixture();
    const tree = packageTree(producerFixtureRoot);
    expect(tree.map((entry) => entry.path)).toEqual(['SKILL.md']);
    const imported = importWorkspaceSkill({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      id: 'candidate-producer',
      displayName: 'Test candidate producer',
      activate: false,
      expectedRevision: 0,
      createdAt,
      producer: { kind: 'user', id: LOCAL_USER_ID },
      tree,
    });
    const retained = readWorkspaceSkillSnapshot({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      entryId: 'candidate-producer',
      digest: imported.version.digest,
    });
    expect(retained.version.digest).toBe(validateCatalogTree(tree).digest);
    for (const file of tree.filter((entry) => entry.kind === 'file'))
      expect(
        retained.entries.find((entry) => entry.path === file.path)?.content?.toString('base64')
      ).toBe(file.contentBase64);
    expect(imported.catalog.skills.entries[0]?.currentDigest).toBeNull();
  });

  it('retains source/work attribution, requires explicit human promotion and keeps an exact pin after default advancement', () => {
    const f = fixture();
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId).skills.candidates).toEqual([]);
    const submitted = submit(f);
    const { candidate } = submitted;
    expect(submitted.admitted).toMatchObject({
      producer: { kind: 'agent', id: 'ag_synthetic_author', responsibleUserId: LOCAL_USER_ID },
      submitter: { kind: 'user', id: LOCAL_USER_ID },
      producingTurn: { threadId: f.thread.id, turnId: f.turn.id },
      source: f.selection,
    });
    expect(candidate).toMatchObject({
      disposition: 'proposed',
      decision: null,
      producer: { kind: 'agent', id: 'ag_synthetic_author' },
      submitter: { kind: 'user', id: LOCAL_USER_ID },
      evidenceRefs: [
        `artifact:${f.artifact.id}:1:${f.artifact.contentDigest}`,
        `turn:${f.turn.id}`,
      ],
    });
    expect(submitted.catalog.skills.entries[0]?.currentDigest).toBeNull();
    expect(submitted.catalog.skills.pins).toEqual([]);
    expect(
      isWorkspaceOperationAuthorized(f.coreDb, f.actor, f.workspaceId, {
        mutating: true,
        policyOperation: 'workspace.configure',
      })
    ).toBe(true);
    const audit = recordWorkspaceAuditEvent({
      workspaceDb: f.workspaceDb,
      workspaceId: f.workspaceId,
      actor: { kind: 'user', id: LOCAL_USER_ID },
      action: 'catalog.skill-candidate.admit',
      resource: `skill-candidate:${candidate.id}:${candidate.candidateDigest}`,
      requestId: 'synthetic-promote',
      outcome: 'succeeded',
      summary: 'Synthetic human decision admission; no real-use acceptance.',
    });
    const promoted = decideWorkspaceSkillCandidate({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      candidateId: candidate.id,
      decision: 'promoted',
      expectedRevision: submitted.catalog.revision,
      expectedCurrentDigest: null,
      decisionContext: {
        actor: { kind: 'user', id: LOCAL_USER_ID },
        auditRef: audit.id,
        decidedAt: createdAt,
      },
    });
    const pinned = setWorkspaceSkillPin({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      entryId: candidate.entryId,
      digest: candidate.candidateDigest,
      expectedRevision: promoted.revision,
      expectedPinDigest: null,
    });
    const newerTree = f.tree.map((entry) =>
      entry.kind === 'file' && entry.path === 'SKILL.md'
        ? {
            ...entry,
            contentBase64: Buffer.from(
              `${Buffer.from(entry.contentBase64!, 'base64').toString('utf8')}\nSynthetic newer default.\n`
            ).toString('base64'),
          }
        : entry
    );
    const newer = importWorkspaceSkill({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      id: candidate.entryId,
      displayName: 'Synthetic workshop',
      activate: true,
      expectedRevision: pinned.revision,
      createdAt,
      producer: { kind: 'user', id: LOCAL_USER_ID },
      tree: newerTree,
    });
    const reopened = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
    expect(reopened.skills.entries[0]?.currentDigest).toBe(newer.version.digest);
    expect(reopened.skills.pins[0]?.digest).toBe(candidate.candidateDigest);
    expect(reopened.skills.candidates[0]?.decision?.auditRef).toBe(audit.id);
    expect(
      listWorkspaceAuditEvents(f.workspaceDb, f.workspaceId).find((event) => event.id === audit.id)
        ?.actor
    ).toEqual({ kind: 'user', id: LOCAL_USER_ID });
    const retained = readWorkspaceSkillSnapshot({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      entryId: candidate.entryId,
      digest: reopened.skills.pins[0]!.digest,
    });
    expect(retained.version.provenance.uploadedSourceId).toBe(f.artifact.id);
    for (const file of f.tree.filter((entry) => entry.kind === 'file'))
      expect(
        retained.entries.find((entry) => entry.path === file.path)?.content?.toString('base64')
      ).toBe(file.contentBase64);
    const script = retained.entries.find((entry) => entry.path === 'scripts/propose-booking.mjs')!;
    expect(retained.version.inventory.find((entry) => entry.path === script.path)?.executable).toBe(
      true
    );
    expect(runProposal(script.content!.toString('utf8'), request)).toEqual({
      outcome: 'propose',
      reason: 'snapshot-capacity',
      evidence: sourceMappings.map(
        ({ id, contentDigest }: { id: string; contentDigest: string }) => ({ id, contentDigest })
      ),
    });
    // No native Task command receipt or physical Worker delivery is fabricated by this component fixture.
    expect(f.store.listCommandRequests()).toEqual([]);
  });

  it.each([
    'foreign-private',
    'revoked',
    'changed-source',
  ] as const)('refuses %s Artifact admission without a candidate or selection effect', (reason) => {
    const f = fixture(reason === 'foreign-private' ? allocateEntityId('usr') : undefined);
    if (reason === 'revoked')
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, LOCAL_USER_ID))();
    if (reason === 'changed-source') f.selection.version += 1;
    expect(() => submit(f)).toThrowError(
      expect.objectContaining({ name: 'SkillCandidateArtifactError' })
    );
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId).skills).toMatchObject({
      candidates: [],
      entries: [],
      pins: [],
      versions: [],
    });
  });

  it('rejects stale candidate promotion and a changed expected pin instead of following current values', () => {
    const f = fixture();
    const submitted = submit(f);
    const imported = importWorkspaceSkill({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      id: submitted.candidate.entryId,
      displayName: 'Synthetic workshop',
      activate: true,
      expectedRevision: submitted.catalog.revision,
      createdAt,
      producer: { kind: 'user', id: LOCAL_USER_ID },
      tree: f.tree,
    });
    expect(() =>
      decideWorkspaceSkillCandidate({
        dataRoot: f.dataRoot,
        workspaceId: f.workspaceId,
        candidateId: submitted.candidate.id,
        decision: 'promoted',
        expectedRevision: imported.catalog.revision,
        expectedCurrentDigest: imported.version.digest,
        decisionContext: {
          actor: { kind: 'user', id: LOCAL_USER_ID },
          auditRef: 'synthetic-unused-admission',
          decidedAt: createdAt,
        },
      })
    ).toThrow(CatalogConflictError);
    expect(() =>
      setWorkspaceSkillPin({
        dataRoot: f.dataRoot,
        workspaceId: f.workspaceId,
        entryId: submitted.candidate.entryId,
        digest: submitted.candidate.candidateDigest,
        expectedRevision: imported.catalog.revision,
        expectedPinDigest: imported.version.digest,
      })
    ).toThrow(CatalogConflictError);
    const current = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
    expect(current.revision).toBe(imported.catalog.revision);
    expect(current.skills.candidates[0]?.disposition).toBe('proposed');
    expect(current.skills.pins).toEqual([]);
  });
});

describe('synthetic domain operation, not a Skill-quality evaluator', () => {
  const script = readFileSync(join(fixtureRoot, 'workshop/scripts/propose-booking.mjs'), 'utf8');
  it('maps each claim to exact admitted synthetic source bytes', () => {
    const records = JSON.parse(readFileSync(join(fixtureRoot, 'admitted-sources.json'), 'utf8'));
    expect(sourceMappings).toHaveLength(2);
    for (const source of sourceMappings) {
      const original = records.find((record: { id: string }) => record.id === source.id);
      expect(source.contentDigest).toBe(digest(original.body));
      const { body: _body, ...metadata } = original;
      expect(source).toEqual(metadata);
    }
    expect(sourceMappings[0].facts).toEqual([
      { kind: 'inventory', equipmentId: 'projector', capacity: 2 },
    ]);
    expect(sourceMappings[1].facts).toEqual([
      {
        kind: 'reservation',
        id: 'r1',
        equipmentId: 'projector',
        quantity: 1,
        start: request.start,
        end: request.end,
      },
    ]);
  });
  it.each([
    ['capacity', { ...request, quantity: 2 }, 'decline', 'capacity-exceeded'],
    [
      'adjacent intervals',
      { ...request, start: request.end, end: '2026-10-16T12:00:00Z', quantity: 2 },
      'propose',
      'snapshot-capacity',
    ],
    ['expired source', { ...request, asOf: '2026-10-17T09:00:00Z' }, 'blocked', 'stale-evidence'],
    [
      'missing source',
      { ...request, sources: sourceMappings.slice(0, 1) },
      'blocked',
      'missing-evidence',
    ],
    ['invalid quantity', { ...request, quantity: -1 }, 'blocked', 'invalid-input'],
    [
      'conflicting capacity',
      {
        ...request,
        sources: [
          ...sourceMappings,
          {
            ...sourceMappings[0],
            id: 'synthetic-conflict',
            facts: [{ kind: 'inventory', equipmentId: 'projector', capacity: 3 }],
          },
        ],
      },
      'blocked',
      'conflicting-evidence',
    ],
    [
      'restricted material',
      { ...request, sources: [{ ...sourceMappings[0], audience: 'private' }, sourceMappings[1]] },
      'blocked',
      'invalid-evidence',
    ],
    [
      'disjoint reservations',
      {
        ...request,
        end: '2026-10-16T12:00:00Z',
        sources: [
          sourceMappings[0],
          {
            ...sourceMappings[1],
            facts: [
              ...sourceMappings[1].facts,
              {
                ...sourceMappings[1].facts[0],
                id: 'r2',
                start: request.end,
                end: '2026-10-16T12:00:00Z',
              },
            ],
          },
        ],
      },
      'propose',
      'snapshot-capacity',
    ],
  ])('handles %s without changing the synthetic source', (_label, input, outcome, reason) => {
    const before = JSON.stringify(input);
    expect(runProposal(script, input)).toMatchObject({ outcome, reason });
    expect(JSON.stringify(input)).toBe(before);
  });
});
