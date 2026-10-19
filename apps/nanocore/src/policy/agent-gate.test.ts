import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAccess, type PolicyState } from '@openkit/policy-kernel';
import { allocateEntityId, type PolicyDocumentV1, PolicyDocumentV1Schema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { preparePolicyConfiguration, readAdmittedPolicyDocument } from './configuration.js';
import { PolicyInterception } from './interception.js';
import { listExportableWorkspacePermissionDecisions } from './permission-decisions.js';
import { type PolicyProposal, policyDigest, preparePolicyDocument } from './statements.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const human = { kind: 'human' as const, id: userId };
const participantVersion = `sha256:${'1'.repeat(64)}`;
const now = '2026-10-19T07:31:00.000Z';
const agentId = 'policy-reviewer';
const supervisorId = 'policy-supervisor';
const otherHumanId = 'usr_00000000-0000-7000-8000-000000000002';
const scope = {
  subjects: [human],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' }],
};
const proposal: PolicyProposal = {
  operation: 'mcp.call-tool',
  workspaceId,
  serverId: 'issues',
  toolName: 'read',
  argumentsDigest: policyDigest({ issue: 1 }),
  catalogRevision: 'catalog-fixture',
  packageDigest: 'package-fixture',
  schemaDigest: null,
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  subject: {
    principal: human,
    onBehalfOf: null,
    actor: { kind: 'agent', id: 'worker', responsibleUserId: userId },
    process: {
      workspaceId,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
    },
    credentialKind: 'worker-package',
    responsibleHumanId: userId,
  },
};

/** Current human-authored I16 binding, used before the agent declaration is admitted. */
function deterministicBinding() {
  return {
    id: 'review-issues',
    kind: 'binding' as const,
    author: human,
    authority: { kind: 'human' as const, userId },
    authoredAt: now,
    state: 'active' as const,
    scope,
    lifetime: {
      anchor: {
        owner: { kind: 'workspace' as const, workspaceId },
        kind: 'workspace',
        id: workspaceId,
      },
    },
    operation: 'mcp.call-tool',
    stage: 'decide' as const,
    mode: 'gate' as const,
    participant: { kind: 'deterministic' as const, id: 'test-review', version: participantVersion },
    inputDisclosure: scope,
    order: 0,
    timeoutMs: 100,
    failure: 'escalate-to-human' as const,
    circuit: { failures: 1, recoveryAfterMs: 60_000 },
  };
}

/** One declaration retains creation identity and a single current responsibility edge. */
function agentDeclaration(id: string, responsibility = human, responsibleHumanId = userId) {
  const { participant: _participant, ...common } = deterministicBinding();
  return {
    id: `principal:${id}`,
    kind: 'agent-principal',
    author: common.author,
    authority: common.authority,
    authoredAt: common.authoredAt,
    state: 'active',
    scope: { ...scope, subjects: [{ kind: 'agent', id }] },
    lifetime: common.lifetime,
    agentId: id,
    creator: human,
    responsibleHumanId,
    responsibility,
  };
}

/** Real schema/admission is the producer of the document consumed by interception. */
function agentDocument(responsibleHumanId = userId) {
  const root = { kind: 'human' as const, id: responsibleHumanId };
  const supervisor = agentDeclaration(supervisorId, root, responsibleHumanId);
  const declaration = {
    ...agentDeclaration(agentId, root, responsibleHumanId),
    responsibility: { kind: 'agent', id: supervisorId },
  };
  const raw = {
    schemaVersion: 1,
    statements: [
      supervisor,
      declaration,
      {
        ...deterministicBinding(),
        participant: { kind: 'agent', id: agentId, version: policyDigest(declaration) },
      },
    ],
  };
  expect(
    PolicyDocumentV1Schema.safeParse(raw).success,
    'The native document schema must admit the agent declaration and participant.'
  ).toBe(true);
  return preparePolicyDocument({
    current: { schemaVersion: 1, statements: [] },
    proposed: PolicyDocumentV1Schema.parse(raw),
    userId,
    now,
  }).document;
}

/** The actual admitted binding supplies transport identity and its exact revision. */
function admittedBinding(document: PolicyDocumentV1) {
  const binding = document.statements.find((statement) => statement.kind === 'binding');
  if (!binding) throw new Error('Expected admitted binding.');
  return binding;
}

/** Agent assessments are transient; durable evidence holds only their digest. */
function assessment(decision: 'allow' | 'deny' | 'escalate') {
  return {
    decision,
    risk: 'The request reads one issue.',
    authorizationAssessment: 'The current agent grant covers this exact read.',
    rationale: `Return ${decision} for this bounded fixture.`,
  };
}

/** The real synchronous Kernel supplies the final permission result. */
function kernel(allow = true) {
  const state: PolicyState = {
    elements: [
      { id: 'u', kind: 'user' },
      { id: 'ua', kind: 'userAttribute' },
      { id: 'o', kind: 'object' },
      { id: 'oa', kind: 'objectAttribute' },
      { id: 'pc', kind: 'policyClass' },
    ],
    assignments: [
      { child: 'u', parent: 'ua' },
      { child: 'ua', parent: 'pc' },
      { child: 'o', parent: 'oa' },
      { child: 'oa', parent: 'pc' },
    ],
    operations: [{ id: 'tool.use', accessRights: ['tool-use'] }],
    associations: allow
      ? [{ id: 'grant', userAttribute: 'ua', targetAttribute: 'oa', accessRights: ['tool-use'] }]
      : [],
  };
  return evaluateAccess(state, { user: 'u', operation: 'tool.use', target: 'o' });
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) close();
});

/** Composes native admission, interception and the real decision/Audit storage owners. */
function fixture(document: PolicyDocumentV1) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-agent-gate-'));
  const workspaceDb = openWorkspaceDb(root, workspaceId);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(workspaceDb);
  return {
    workspaceDb,
    document,
    proposal,
    authorizationRevision: policyDigest({ member: userId }),
    authorCurrent: () => true,
    anchorCurrent: () => true,
    participantAuthorized: () => true,
    stillCurrent: () => true,
    finalKernel: () => kernel(),
  };
}

/** Real human candidate, confirmation, CAS, reload and private Artifact owners. */
function configurationFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-activation-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const actor = { kind: 'local' as const, userId };
  const personalWorkspaceId = quickChatWorkspaceIdForUser(userId);
  const thread = store.createThread(
    personalWorkspaceId,
    'Review agent Policy',
    allocateEntityId('th'),
    'administration',
    { visibility: 'private', privateOwnerUserId: userId }
  );
  const turn = store.createTurn(
    personalWorkspaceId,
    thread.id,
    'Review this agent gate.',
    { kind: 'user', id: userId },
    null
  );
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  const serverPath = join(dataRoot, 'config/server.jsonc');
  writeFileSync(serverPath, JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [workspaceId, personalWorkspaceId],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const options = {
    actor,
    coreDb,
    store,
    files,
    runtimeConfig: () => manager.current(),
    reload: () => manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb: () => workspaceDb,
    inflightCommands: new WeakMap(),
  };
  const service = createAdministrationConfiguration(options);
  const request = (document: PolicyDocumentV1) => ({
    targetFamily: 'policy' as const,
    targetId: 'server' as const,
    expectedRevision: files.readFile('server.jsonc').file.revision!,
    changes: { proposed: document, rationale: 'Explicit human review of this exact agent gate.' },
  });
  const propose = (document: PolicyDocumentV1) =>
    service.propose(request(document), {
      threadId: thread.id,
      turnId: turn.id,
      requestId: randomUUID(),
    });
  return { ...options, service, manager, workspaceDb, serverPath, request, propose };
}

describe('agent gate at native I16', () => {
  it('refuses direct active configuration preparation without prior exact completed shadow evidence', () => {
    const f = configurationFixture();
    const original = readFileSync(f.serverPath, 'utf8');
    expect(() =>
      preparePolicyConfiguration({
        ...f,
        request: f.request(agentDocument()),
        loadedPolicy: undefined,
      })
    ).toThrow(/shadow/i);
    expect(readFileSync(f.serverPath, 'utf8')).toBe(original);
  });

  it('activates only the exact completed shadow gate through a separate human-confirmed candidate', async () => {
    const f = configurationFixture();
    const shadow = agentDocument();
    admittedBinding(shadow).state = 'shadow';
    const original = readFileSync(f.serverPath, 'utf8');
    const proposedShadow = f.propose(shadow);
    expect(readFileSync(f.serverPath, 'utf8')).toBe(original);
    await expect(
      f.service.apply({
        requestId: randomUUID(),
        candidate: proposedShadow.candidate,
        confirmation: { ...proposedShadow.confirmation, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).rejects.toThrow();
    expect(readFileSync(f.serverPath, 'utf8')).toBe(original);
    expect(
      await f.service.apply({
        requestId: randomUUID(),
        candidate: proposedShadow.candidate,
        confirmation: proposedShadow.confirmation,
      })
    ).toMatchObject({ persisted: true, reload: 'applied' });
    const loadedShadow = readAdmittedPolicyDocument(
      f.coreDb,
      f.manager.current().openKitConfig.policy?.mediation
    );
    const active = structuredClone(loadedShadow);
    admittedBinding(active).state = 'active';
    expect(() => f.propose(active)).toThrow(/shadow/i);
    const binding = admittedBinding(loadedShadow);
    const evaluated = await new PolicyInterception(undefined, {
      id: agentId,
      version: binding.participant.version,
      invoke: async () => assessment('deny'),
    }).decide({
      workspaceDb: f.workspaceDb,
      document: loadedShadow,
      proposal,
      authorizationRevision: policyDigest({ member: userId }),
      authorCurrent: () => true,
      anchorCurrent: () => true,
      participantAuthorized: () => true,
      stillCurrent: () => true,
      finalKernel: () => kernel(),
    });
    expect(evaluated.result).toBe('allow');
    const different = structuredClone(active);
    admittedBinding(different).timeoutMs += 1;
    expect(() => f.propose(different)).toThrow(/shadow/i);
    const beforeActivation = readFileSync(f.serverPath, 'utf8');
    const activation = f.propose(active);
    expect(readFileSync(f.serverPath, 'utf8')).toBe(beforeActivation);
    expect(activation.preview.policyProposal).toMatchObject({
      proposer: human,
      validation: 'valid',
    });
    expect(
      await f.service.apply({
        requestId: randomUUID(),
        candidate: activation.candidate,
        confirmation: activation.confirmation,
      })
    ).toMatchObject({ persisted: true, reload: 'applied' });
    const loadedActive = readAdmittedPolicyDocument(
      f.coreDb,
      f.manager.current().openKitConfig.policy?.mediation
    );
    expect(admittedBinding(loadedActive).state).toBe('active');
    expect(admittedBinding(loadedActive).participant.version).toBe(binding.participant.version);
  });

  it('admits the human-authored declaration and preserves its creator when the author changes', () => {
    const proposed = {
      ...agentDeclaration(agentId),
      creator: { kind: 'agent', id: 'untrusted-creator' },
    };
    expect(
      PolicyDocumentV1Schema.safeParse({ schemaVersion: 1, statements: [proposed] }).success
    ).toBe(true);
    const created = preparePolicyDocument({
      current: { schemaVersion: 1, statements: [] },
      proposed: { schemaVersion: 1, statements: [proposed] },
      userId,
      now,
    }).document;
    expect(created.statements[0]).toMatchObject({ author: human, creator: human });
    const changed = preparePolicyDocument({
      current: created,
      proposed: {
        ...created,
        statements: [
          {
            ...created.statements[0],
            lifetime: { ...proposed.lifetime, notAfter: '2026-10-20T00:00:00Z' },
          },
        ],
      },
      userId: otherHumanId,
      now,
    }).document;
    expect(changed.statements[0]).toMatchObject({
      author: { kind: 'human', id: otherHumanId },
      creator: human,
    });
    expect(agentDocument().statements).toHaveLength(3);
  });

  it.each([
    ['allow', 'allow'],
    ['deny', 'deny'],
    ['escalate', 'require_escalation'],
  ] as const)('maps the agent %s result and retains actual native evidence', async (decision, expected) => {
    const input = fixture(agentDocument());
    const calls: string[] = [];
    const invoke = vi.fn(async () => {
      calls.push('agent');
      return assessment(decision);
    });
    const deterministic = vi.fn(async () => ({ decision: 'deny' }));
    const binding = admittedBinding(input.document);
    const pipeline = new PolicyInterception(
      { id: agentId, version: binding.participant.version, invoke: deterministic },
      { id: agentId, version: binding.participant.version, invoke }
    );
    const result = await pipeline.decide({
      ...input,
      finalKernel: () => {
        calls.push('kernel');
        return kernel();
      },
    });
    expect(result.result).toBe(expected);
    expect(calls).toEqual(['agent', 'kernel']);
    expect(deterministic).not.toHaveBeenCalled();
    const rows = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId);
    expect(rows).toHaveLength(2);
    const gate = rows.find((row) => row.mediation?.role === 'gate')!;
    const final = rows.find((row) => row.decisionId === result.decisionId)!;
    expect(gate.result).toBe(expected);
    expect(gate.mediation?.subject).toEqual({
      principal: { kind: 'agent', id: agentId },
      actor: { kind: 'agent', id: agentId, responsibleUserId: userId },
      responsibleHumanId: userId,
      process: proposal.subject.process,
      onBehalfOf: null,
      credentialKind: 'worker-package',
    });
    expect(final.mediation?.subject).toEqual(proposal.subject);
    expect(final.mediation?.kernel?.effect).toBe('allow');
    expect(final.mediation?.invocations).toEqual([{ kind: 'decision', id: gate.decisionId }]);
    const events = input.workspaceDb.sqlite
      .prepare('SELECT policy_invocation_json FROM audit_events WHERE permission_decision_id = ?')
      .all(gate.decisionId) as { policy_invocation_json: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.policy_invocation_json)).toMatchObject({
      participant: { id: agentId },
      outcome: 'completed',
      outputDigest: policyDigest(assessment(decision)),
      subject: gate.mediation?.subject,
    });
    expect(events[0]!.policy_invocation_json).not.toContain(assessment(decision).rationale);
  });

  it('escalates failed, invalid and unavailable agent execution without inventing a substantive result', async () => {
    for (const failure of ['throw', 'invalid', 'unavailable'] as const) {
      const input = fixture(agentDocument());
      const binding = admittedBinding(input.document);
      const invoke = vi.fn(async () => {
        if (failure === 'throw') throw new Error('Transport unavailable.');
        return { decision: 'allow' };
      });
      const participant =
        failure === 'unavailable'
          ? undefined
          : { id: agentId, version: binding.participant.version, invoke };
      const result = await new PolicyInterception(undefined, participant).decide(input);
      expect(result.result).toBe('require_escalation');
      const rows = listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId);
      expect(rows.find((row) => row.mediation?.role === 'gate')?.result).toBe('require_escalation');
      expect(
        rows.find((row) => row.decisionId === result.decisionId)?.mediation?.kernel?.effect
      ).toBe('allow');
      const audit = input.workspaceDb.sqlite
        .prepare(
          'SELECT policy_invocation_json FROM audit_events WHERE policy_invocation_json IS NOT NULL'
        )
        .get() as { policy_invocation_json: string };
      expect(JSON.parse(audit.policy_invocation_json)).toMatchObject({
        outcome:
          failure === 'throw' ? 'error' : failure === 'invalid' ? 'malformed' : 'unavailable',
        outputDigest: null,
      });
    }
  });

  it('keeps a human-only requirement and the final Kernel denial stronger than agent allow', async () => {
    for (const humanRequired of [true, false]) {
      const input = fixture(agentDocument());
      const binding = admittedBinding(input.document);
      const calls: string[] = [];
      const result = await new PolicyInterception(undefined, {
        id: agentId,
        version: binding.participant.version,
        invoke: async () => {
          calls.push('agent');
          return assessment('allow');
        },
      }).decide({
        ...input,
        requiresHumanApproval: humanRequired,
        finalKernel: () => {
          calls.push('kernel');
          return kernel(humanRequired);
        },
      });
      expect(result.result).toBe(humanRequired ? 'require_approval' : 'deny');
      expect(calls).toEqual(['agent', 'kernel']);
    }
  });

  it.each([
    'missing',
    'cyclic',
    'lost-human',
    'lost-author',
    'shadow-lost-authority',
  ] as const)('suspends a %s responsibility chain before disclosure', async (fault) => {
    const input = fixture(agentDocument(fault === 'lost-author' ? userId : otherHumanId));
    if (fault === 'missing') input.document.statements.splice(0, 1);
    if (fault === 'cyclic')
      Object.assign(input.document.statements[0]!, {
        responsibility: { kind: 'agent', id: agentId },
      });
    const binding = admittedBinding(input.document);
    if (fault === 'shadow-lost-authority') binding.state = 'shadow';
    const invoke = vi.fn(async () => assessment('allow'));
    const finalKernel = vi.fn(() => kernel());
    const result = await new PolicyInterception(undefined, {
      id: agentId,
      version: binding.participant.version,
      invoke,
    }).decide({
      ...input,
      authorCurrent: (id) =>
        ((fault !== 'lost-human' && fault !== 'shadow-lost-authority') || id !== otherHumanId) &&
        (fault !== 'lost-author' || id !== userId),
      finalKernel,
    });
    expect(result.result).toBe(fault === 'shadow-lost-authority' ? 'allow' : 'error');
    expect(invoke).not.toHaveBeenCalled();
    expect(finalKernel).toHaveBeenCalledTimes(1);
    if (fault === 'shadow-lost-authority')
      expect(
        listExportableWorkspacePermissionDecisions(input.workspaceDb, workspaceId).find(
          (row) => row.mediation?.role === 'gate'
        )?.result
      ).toBe('error');
  });

  it('rechecks the current terminal human after an agent result and before release', async () => {
    const input = fixture(agentDocument(otherHumanId));
    const binding = admittedBinding(input.document);
    let humanCurrent = true;
    const calls: string[] = [];
    const result = await new PolicyInterception(undefined, {
      id: agentId,
      version: binding.participant.version,
      invoke: async () => {
        calls.push('agent');
        humanCurrent = false;
        return assessment('allow');
      },
    }).decide({
      ...input,
      authorCurrent: (id) => id !== otherHumanId || humanCurrent,
      finalKernel: () => {
        calls.push('kernel');
        return kernel();
      },
    });
    expect(result.result).toBe('error');
    expect(calls).toEqual(['agent', 'kernel']);
  });

  it('does not inherit human rights when the declared agent domain excludes the Tool', async () => {
    const input = fixture(agentDocument());
    const declaration = input.document.statements.find(
      (statement) => statement.id === `principal:${agentId}`
    )!;
    declaration.scope.resources = [{ ...scope.resources[0]!, toolName: 'unrelated' }];
    const binding = admittedBinding(input.document);
    binding.participant.version = policyDigest(declaration);
    const invoke = vi.fn(async () => assessment('allow'));
    const result = await new PolicyInterception(undefined, {
      id: agentId,
      version: binding.participant.version,
      invoke,
    }).decide(input);
    expect(result.result).toBe('error');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves exact retained bytes and side effects for empty and deterministic no-agent paths', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    let entropy = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(++entropy);
      return array;
    });
    for (const hasDeterministicGate of [false, true]) {
      entropy = 0;
      const document = PolicyDocumentV1Schema.parse({
        schemaVersion: 1,
        statements: hasDeterministicGate ? [deterministicBinding()] : [],
      });
      const input = fixture(document);
      const invoke = vi.fn(async () => ({ decision: 'allow' }));
      const pipeline = new PolicyInterception({
        id: 'test-review',
        version: participantVersion,
        invoke,
      });
      const before = input.workspaceDb.sqlite.prepare('SELECT total_changes() AS n').get() as {
        n: number;
      };
      const result = await pipeline.decide(input);
      const after = input.workspaceDb.sqlite.prepare('SELECT total_changes() AS n').get() as {
        n: number;
      };
      const bytes = JSON.stringify({
        decisions: input.workspaceDb.sqlite
          .prepare('SELECT * FROM permission_decisions ORDER BY rowid')
          .all(),
        audit: input.workspaceDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),
      });
      expect(result.result).toBe('allow');
      expect(invoke).toHaveBeenCalledTimes(hasDeterministicGate ? 1 : 0);
      expect(after.n - before.n).toBe(hasDeterministicGate ? 4 : 2);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        hasDeterministicGate
          ? '43e0f6fce217353ec7f877aab6d3ecda206d58da3b46d07f0c1e8db434059fd9'
          : '092341f3bdce3409ddb922fab1c150caaf0e522c97113cf9ae31c2da05dba9d8'
      );
    }
  });
});
