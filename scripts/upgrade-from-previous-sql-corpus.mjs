import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const NOW = '2026-10-17T00:00:00.000Z';
const EXPIRES = '2999-01-01T00:00:00.000Z';

/** Existing retained register rows exercised through the selected revision's owners. */
export const SQL_CORPUS_FAMILIES = Object.freeze([
  'Core identity, authentication and membership',
  'Core bootstrap and default-access settings',
  'Core permission decisions',
  'Core Audit, boot Audit and Vault Audit',
  'Core Vault metadata, grants, injection and use',
  'Scheduler queue, attempts, recurring history and external event joins',
  'Runtime targets and binding/control graph',
  'Core command receipts',
  'User command and Thread read receipts',
  'User Audit and notebook admission',
  'Workspace permission, Audit and Vault use',
  'Workspace capability calls and Usage',
  'Pending Requests, Workspace receipts and Worker checkpoints',
  'Material content, revisions and Thread bindings',
  'Artifact Review decisions, range feedback, choices as judgements and apply lineage',
  'Goals, cards, immutable Plans and Task facts',
  'EvidenceBundle and normalized runtime evidence metadata',
  'Resolved Agent setup and MCP Tool-schema snapshots',
  'Workspace synchronization and snapshot chain',
  'Generative UI presentations',
  'Light App metadata, business data, Audit and receipts',
  'Light App immutable definitions',
  'Light App local recovery snapshots',
  'Native migration journals',
  'Restricted evidence bytes',
  'AEP snapshot',
  'Context Package trace',
  'Context Package files',
  'Work observation log',
  'Runtime provenance and admitted raw streams',
  'Notification attention and delivery attempts',
  'Discord bindings, pairing, disclosures and inbound receipts',
  'Human judgement records',
  'Candidate sets and selections',
]);

/** Loads product code only from the explicit previous or candidate package root. */
async function owners(appRoot) {
  const load = (name) => import(pathToFileURL(join(appRoot, 'dist', `${name}.js`)).href);
  const loadPackage = (name) =>
    import(pathToFileURL(createRequire(join(appRoot, 'package.json')).resolve(name)).href);
  const [
    db,
    migrate,
    store,
    tokens,
    identity,
    membership,
    decisions,
    audit,
    bootAudit,
    references,
    grants,
    uses,
    plans,
    receipts,
    scheduler,
    attempts,
    recurring,
    admission,
    targets,
    bindings,
    backend,
    control,
    commands,
    reads,
    pending,
    checkpoints,
    materials,
    reviews,
    goals,
    evidence,
    runtimeEvidence,
    setup,
    mcp,
    sync,
    kernel,
    appDb,
    snapshots,
    ui,
    usage,
    externalEvents,
    attention,
    discord,
  ] = await Promise.all(
    [
      'storage/db',
      'storage/migrate',
      'lib/store',
      'auth/access-token-store',
      'auth/identity',
      'workspace-membership',
      'policy/permission-decisions',
      'audit-events',
      'bootstrap/audit',
      'vault/vault-references',
      'vault/vault-grants',
      'vault/vault-use-records',
      'vault-injection-plans',
      'vault-injection-receipts',
      'scheduler-records',
      'runtime/execution-attempt-records',
      'lib/automation-store',
      'workspace-mutation-admission',
      'runtime/nanohost-runtime-target',
      'runtime/worker-storage-bindings',
      'runtime/worker-backend-sessions',
      'runtime/worker-control-records',
      'storage/command-request-records',
      'storage/thread-read-receipts',
      'runtime/pending-requests',
      'runtime/worker-checkpoints',
      'workspace-materials',
      'artifact-reviews',
      'runtime/goal-owner',
      'evidence-bundles',
      'runtime/runtime-evidence',
      'agents/setup-ledger',
      'runtime/mcp-tool-schema-snapshots',
      'runtime/workspace-sync-records',
      'generative-kernel/commands',
      'storage/app-db',
      'generative-kernel/snapshots',
      'generative-ui/commands',
      'capability/usage-ledger',
      'storage/external-trigger-admissions',
      'notifications/attention',
      'channels/discord',
    ].map(load)
  );
  return {
    db,
    migrate,
    store,
    tokens,
    identity,
    membership,
    decisions,
    audit,
    bootAudit,
    references,
    grants,
    uses,
    plans,
    receipts,
    scheduler,
    attempts,
    recurring,
    admission,
    targets,
    bindings,
    backend,
    control,
    commands,
    reads,
    pending,
    checkpoints,
    materials,
    reviews,
    goals,
    evidence,
    runtimeEvidence,
    setup,
    mcp,
    sync,
    kernel,
    appDb,
    snapshots,
    ui,
    usage,
    externalEvents,
    attention,
    discord,
    load,
    loadPackage,
  };
}

/** Uses the existing setup-ledger fixture shape, without importing test runners into the App. */
function syntheticAgentSetup() {
  return {
    manifest: {
      defaultProfileId: 'default',
      displayName: 'Synthetic continuity Agent',
      id: 'agent_codex_host',
      mcp: [],
      models: {
        preferredLogicalModelId: 'synthetic-model',
        allowedLogicalModelIds: ['synthetic-model'],
      },
      requiredFeatures: [],
      profiles: [{ id: 'default', instructionsRef: 'codex', skills: [], mcp: [] }],
      runtime: {
        adapter: 'codex',
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'node', path: '/usr/local/bin/node' },
          { id: 'codex', path: '/usr/local/bin/codex' },
        ],
        image: {
          kind: 'reference',
          pullPolicy: 'if-not-present',
          ref: 'example.invalid/synthetic-worker:continuity',
        },
        kind: 'codex',
        version: 'synthetic',
      },
      sandbox: {
        backend: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
        },
        credentialDeclarations: [],
        filesystem: [],
        network: [],
      },
      schemaVersion: 1,
      skills: [],
    },
    profileId: 'default',
    logicalModels: {
      preferredLogicalModelId: 'synthetic-model',
      allowed: [
        {
          id: 'synthetic-model',
          displayName: 'Synthetic model',
          capabilities: ['responses', 'tool-calling', 'input:text', 'output:text'],
          contextManagement: { type: 'compaction', compactThreshold: 8000 },
          modelFamilyId: 'gpt',
          autoFailover: true,
          routes: [
            {
              available: true,
              unavailableReason: null,
              id: 'synthetic-route',
              providerProfileId: 'synthetic-provider',
              providerModel: 'synthetic-model',
            },
          ],
        },
      ],
    },
  };
}

/** Hashes exact bytes without returning credential-bearing data. */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Produces a deterministic synthetic canonical id without a candidate package import. */
function id(kind, suffix) {
  const hex = digest(`upgrade-from-previous:${suffix}`);
  return `${kind}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Requires a selected actual record; empty coverage must fail the upgrade check. */
function required(value, family) {
  if (value == null || (Array.isArray(value) && value.length === 0)) {
    throw new Error(`${family}: selected retained record is missing.`);
  }
  return value;
}

/** Records a non-secret digest of a file relative to the Data Root. */
function fileBytes(dataRoot, path) {
  const bytes = readFileSync(path);
  return { path: relative(dataRoot, path), byteLength: bytes.length, sha256: digest(bytes) };
}

/** Selects durable target identity while boot owns generation, readiness and observation time. */
function retainedRuntimeTarget(target) {
  required(target, 'Runtime targets and binding/control graph');
  return {
    targetId: target.targetId,
    identityId: target.identityId,
    deploymentId: target.deploymentId,
  };
}

/** Captures the previous Worker's actual idle native binding through that revision's owners. */
export async function captureIdleNativeBinding({ appRoot, dataRoot }, worker) {
  const o = await owners(appRoot);
  const core = o.db.openCoreDb(dataRoot);
  const workspace = o.db.openWorkspaceDb(dataRoot, worker.workspaceId);
  try {
    const store = new o.store.FsStore({ dataRoot });
    const turn = store.getTurn(worker.workspaceId, worker.threadId, worker.turnId);
    const session = store.getAgentSession(
      required(turn.agentSessionId, 'Previous Worker AgentSession')
    );
    const binding = required(
      core.sqlite
        .prepare(`
      SELECT b.agent_session_runtime_binding_id AS bindingId,
             s.sandbox_binding_ref AS sandboxBindingRef, s.runtime_target_id AS runtimeTargetId,
             s.origin_physical_epoch AS physicalEpoch, b.native_handle_digest AS nativeHandleDigest
      FROM agent_session_runtime_bindings b
      JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
      JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
      WHERE b.agent_session_id = ? AND b.lifecycle_state = 'open'
        AND b.native_handle_state = 'ready' AND b.current_attempt_id IS NULL
        AND b.current_turn_id IS NULL AND h.active_turn_count = 0
    `)
        .get(session.id),
      'Previous Worker idle native binding'
    );
    assert.equal(session.status, 'idle', 'Previous Worker AgentSession is not idle.');
    assert.equal(session.nativeHandleDigest, binding.nativeHandleDigest);
    assert.match(binding.physicalEpoch, /^[a-f0-9]{64}$/);
    const storage = required(
      o.bindings.getWorkerStorageBindingForSandbox(core, {
        sandboxBindingRef: binding.sandboxBindingRef,
      }),
      'Previous Worker retained storage'
    );
    assert.equal(storage.state, 'attached');
    assert.equal(session.retainedStorage?.storageRef, storage.storageRef);
    assert.ok(
      storage.contributors.some(
        (contributor) =>
          contributor.threadId === session.threadId &&
          contributor.workSlotRef === session.retainedStorage?.workSlotRef
      )
    );
    const aep = await o.load('runtime/aep-snapshot-ledger');
    const snapshot = aep.requireAgentEnvironmentPackageSnapshot(
      workspace,
      worker.workspaceId,
      session.environmentPackageSnapshotId
    );
    assert.equal(snapshot.agentSessionId, session.id);
    return {
      ...binding,
      workspaceId: worker.workspaceId,
      threadId: worker.threadId,
      agentSessionId: session.id,
      snapshotId: snapshot.snapshotId,
      retainedStorage: session.retainedStorage,
      aepBytes: fileBytes(
        dataRoot,
        join(
          dataRoot,
          'workspaces',
          worker.workspaceId,
          'runtime',
          'agent-sessions',
          session.id,
          'aep-snapshots',
          `${snapshot.snapshotId}.json`
        )
      ),
    };
  } finally {
    workspace.sqlite.close();
    core.sqlite.close();
  }
}

/** Checks retained proof and opaque AEP bytes without admitting an old package for execution. */
export async function checkIdleNativeBinding({ appRoot, dataRoot }, previous, candidateWorker) {
  required(previous, 'Previous Worker idle native binding');
  const o = await owners(appRoot);
  const core = o.db.openCoreDb(dataRoot);
  try {
    const session = new o.store.FsStore({ dataRoot }).getAgentSession(previous.agentSessionId);
    assert.equal(session.workspaceId, previous.workspaceId);
    assert.equal(session.threadId, previous.threadId);
    assert.equal(session.environmentPackageSnapshotId, previous.snapshotId);
    assert.equal(session.nativeHandleDigest, previous.nativeHandleDigest);
    assert.deepEqual(session.retainedStorage, previous.retainedStorage);
    assert.deepEqual(
      fileBytes(dataRoot, join(dataRoot, previous.aepBytes.path)),
      previous.aepBytes,
      'Previous Worker AEP bytes changed.'
    );
    if (candidateWorker) {
      assert.equal(
        core.sqlite
          .prepare(`SELECT 1 FROM agent_session_runtime_bindings
        WHERE agent_session_runtime_binding_id = ?`)
          .get(previous.bindingId),
        undefined,
        'Previous Worker idle binding was not retired.'
      );
      // The successful live Worker check proves fresh fenced readiness. Its immutable anchor
      // retains the exact Epoch after the ordered stop clears live RuntimeTarget readiness.
      const anchors = core.sqlite
        .prepare(`SELECT attempt_id AS attemptId
        FROM worker_backend_sessions WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?`)
        .all(candidateWorker.workspaceId, candidateWorker.threadId, candidateWorker.turnId);
      assert.equal(anchors.length, 1, 'Candidate Worker backend anchor is missing or ambiguous.');
      const anchor = o.backend.getWorkerBackendSession(core, anchors[0].attemptId);
      assert.equal(anchor.runtimeTargetId, previous.runtimeTargetId);
      assert.match(anchor.originPhysicalEpoch, /^[a-f0-9]{64}$/);
      assert.notEqual(
        anchor.originPhysicalEpoch,
        previous.physicalEpoch,
        'Candidate retirement did not cross a physical Epoch.'
      );
    }
    return {
      nativeProofPreserved: true,
      aepBytesPreserved: true,
      idleBindingRetired: Boolean(candidateWorker),
    };
  } finally {
    core.sqlite.close();
  }
}

/** Seeds current SQLite families with the previous revision's real producers and stopped writers. */
export async function seedSqlCorpus({ appRoot, dataRoot, retainedRoot, userId, selectors }) {
  const o = await owners(appRoot);
  const { workspaceId, threadId, turnId } = selectors;
  let core = o.db.openCoreDb(dataRoot);
  let user = o.db.openUserDb(dataRoot, userId);
  let workspace = o.db.openWorkspaceDb(dataRoot, workspaceId);
  const actor = { kind: 'user', id: userId };
  const sql = {
    userId,
    agentSessionId: id('as', 'session'),
    artifactId: required(selectors.inlineArtifactId, 'B01 inline Artifact'),
  };
  try {
    o.migrate.applyScopedMigrations(user);
    o.migrate.applyScopedMigrations(workspace);
    const store = new o.store.FsStore({ dataRoot });
    required(store.getTurn(workspaceId, threadId, turnId), 'B01 Turn');
    if (o.membership.resolveWorkspaceMembershipRelation(core, workspaceId, userId) !== 'owner') {
      throw new Error('B01 synthetic User must own its Workspace.');
    }
    const token = o.tokens.createOpenKitAccessTokenRecord(core, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: EXPIRES,
      now: new Date(NOW),
    });
    sql.tokenId = token.tokenId;
    o.tokens.setDefaultServerAdminTokenId(core, userId, token.tokenId);
    sql.serverDecisionId = id('pd', 'server-decision');
    sql.workspaceDecisionId = id('pd', 'workspace-decision');
    for (const ownerScope of ['server', 'workspace']) {
      o.decisions.recordProductPermissionDecision({
        coreDb: core,
        workspaceDb: workspace,
        ownerScope,
        ...(ownerScope === 'workspace' ? { workspaceId } : {}),
        decisionId: ownerScope === 'server' ? sql.serverDecisionId : sql.workspaceDecisionId,
        policyEngineVersion: 'upgrade-corpus:v1',
        policySnapshotId: 'upgrade-corpus',
        subjectSummary: actor,
        action: 'read',
        resourceSummary: { kind: 'synthetic-corpus' },
        contextSummary: { synthetic: true },
        result: 'allow',
        reasonCode: 'allowed',
        enforcementPoint: 'upgrade-corpus',
        now: new Date(NOW),
      });
    }
    sql.serverAuditId = o.audit.recordServerAuditEvent({
      coreDb: core,
      actor,
      action: 'upgrade.corpus',
      outcome: 'succeeded',
      summary: 'Synthetic retained server Audit.',
      now: new Date(NOW),
    }).id;
    sql.userAuditId = o.audit.recordUserAuditEvent({
      userDb: user,
      actor,
      action: 'upgrade.corpus',
      outcome: 'succeeded',
      summary: 'Synthetic retained User Audit.',
      now: new Date(NOW),
    }).id;
    sql.workspaceAuditId = o.audit.recordWorkspaceAuditEvent({
      workspaceDb: workspace,
      workspaceId,
      threadId,
      turnId,
      actor,
      action: 'upgrade.corpus',
      outcome: 'succeeded',
      summary: 'Synthetic retained Workspace Audit.',
      now: new Date(NOW),
    }).id;
    sql.bootId = 'upgrade-corpus-boot';
    o.bootAudit.recordBootStartAuditEvent({
      coreDb: core,
      bootId: sql.bootId,
      migrationIds: [],
      now: new Date(NOW),
    });
    sql.vaultReferenceId = id('vault', 'vault-reference');
    sql.vaultGrantId = id('grant', 'vault-grant');
    o.references.createVaultReference(core, {
      referenceId: sql.vaultReferenceId,
      backendKind: 'encrypted-file',
      ownerScope: 'server',
      displayName: 'Synthetic continuity reference',
      secretKind: 'api-key',
      now: () => NOW,
    });
    o.grants.createVaultGrant(core, {
      grantId: sql.vaultGrantId,
      vaultReferenceId: sql.vaultReferenceId,
      allowedInjectionPaths: ['gateway-only'],
      lifetime: 'workspace',
      ownerScope: 'workspace',
      workspaceId,
      now: () => NOW,
    });
    sql.injectionPlanId = 'upgrade-corpus-injection';
    o.plans.createVaultInjectionPlan(core, {
      planId: sql.injectionPlanId,
      grantId: sql.vaultGrantId,
      injectionVisibility: 'gateway-only',
      backendCapabilityRequirement: 'encrypted-file:resolve',
      expirationBehavior: 'grant-lifetime',
      redactionRule: 'metadata-only',
      revocationBehavior: 'mark-session-stale',
      now: () => NOW,
    });
    sql.injectionReceiptId = 'upgrade-corpus-receipt';
    o.receipts.createVaultInjectionReceipt(core, {
      receiptId: sql.injectionReceiptId,
      planId: sql.injectionPlanId,
      grantId: sql.vaultGrantId,
      agentSessionId: sql.agentSessionId,
      backendSummary: 'Synthetic corpus only.',
      injectedAt: NOW,
      revocationStatus: 'active',
    });
    sql.serverVaultUseId = id('vu', 'server-use');
    sql.workspaceVaultUseId = id('vu', 'workspace-use');
    for (const ownerScope of ['server', 'workspace']) {
      o.uses.createVaultUseRecord(ownerScope === 'server' ? core : workspace, {
        useId: ownerScope === 'server' ? sql.serverVaultUseId : sql.workspaceVaultUseId,
        vaultReferenceId: sql.vaultReferenceId,
        grantId: sql.vaultGrantId,
        materialVersion: 1,
        backendKind: 'encrypted-file',
        ownerScope,
        ...(ownerScope === 'workspace' ? { workspaceId } : {}),
        resolvingPath: 'grant',
        outcome: 'succeeded',
        usedAt: NOW,
      });
    }
    const automation = new o.recurring.AutomationStore(
      core,
      new o.admission.WorkspaceMutationAdmission(),
      () => NOW
    );
    sql.automationId = automation.createAutomation(userId, {
      workspaceId,
      threadId,
      name: 'Synthetic continuity',
      prompt: 'Keep this schedule paused.',
      intervalSeconds: 60,
    }).id;
    sql.queueEntryId = 'upgrade-corpus-queue';
    sql.externalEventKey = 'synthetic-source:event-1';
    const entry = core.sqlite.transaction(() => {
      const admitted = o.scheduler.createSchedulerAdmissionEntry(core, {
        backendId: 'nanohost',
        queueEntryId: sql.queueEntryId,
        requestId: 'upgrade-corpus-worker',
        workspaceId,
        threadId,
        turnId,
        turnInput: 'Synthetic retained admission.',
        requestedAgentId: 'agent_codex_host',
        triggerActor: actor,
        now: () => NOW,
      });
      o.externalEvents.insertExternalTriggerAdmission(core, {
        scheduleId: sql.automationId,
        eventKey: sql.externalEventKey,
        sourceTurnId: turnId,
        queueEntryId: admitted.queueEntryId,
      });
      return admitted;
    })();
    sql.attemptId = id('attempt', 'attempt');
    o.attempts.createSchedulerExecutionAttempt(core, {
      entry,
      attemptId: sql.attemptId,
      preparationInput: { admission: entry },
      now: () => NOW,
    });
    o.attempts.bindSchedulerExecutionAttemptSession(core, {
      attemptId: sql.attemptId,
      agentSessionId: sql.agentSessionId,
      now: () => NOW,
    });
    const preparation = await o.load('runtime/nanohost-attempt-records');
    preparation.bindNanoHostAttemptPreparation(core, {
      attemptId: sql.attemptId,
      agentSessionId: sql.agentSessionId,
      inputRef: 'aepsnap_upgrade-corpus',
      bindingRef: 'upgrade-corpus-binding',
      sessionCompatibilityKey: 'upgrade-corpus',
      now: () => NOW,
    });
    const targetIds = core.sqlite.prepare('SELECT target_id FROM nanohost_runtime_targets').all();
    if (targetIds.length > 1) throw new Error('NanoHost requires one configured RuntimeTarget.');
    sql.runtimeTargetId = targetIds[0]?.target_id ?? 'upgrade-corpus-target';
    const target =
      targetIds.length === 1
        ? o.targets.getNanoHostRuntimeTarget(core, sql.runtimeTargetId)
        : o.targets.allocateNanoHostRuntimeTargetConnectionGeneration(core, {
            targetId: sql.runtimeTargetId,
            deploymentId: 'upgrade-corpus',
            identityId: 'upgrade-corpus',
            observedAt: NOW,
          });
    o.targets.upsertNanoHostRuntimeTarget(core, {
      ...target,
      physicalEpoch: target.physicalEpoch ?? 'a'.repeat(64),
      freshEmpty: true,
      ready: true,
      predecessorFenced: true,
      observedAt: new Date().toISOString(),
    });
    const binding = o.bindings.createWorkerStorageBinding(core, {
      deploymentId: target.deploymentId,
      runtimeTargetId: sql.runtimeTargetId,
      workspaceId,
      now: NOW,
      layout: {
        family: 'openkit-worker',
        version: '1',
        uid: 1000,
        gid: 1000,
        workingDirectory: '/tmp/openkit-bootstrap',
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/workspace' }, { target: '/sandbox' }],
      },
    });
    sql.storageRef = binding.storageRef;
    o.backend.recordWorkerBackendSessionMaterializing(core, {
      backendLineage: {
        kind: 'reference',
        imageRef: 'example.invalid/synthetic-worker:continuity',
      },
      backendVersion: 'synthetic',
      sandboxBindingRef: 'upgrade-corpus-binding',
      now: () => NOW,
      identity: {
        agentSessionId: sql.agentSessionId,
        backendKind: 'openshell',
        backendSessionId: 'upgrade-corpus-session',
        deploymentId: target.deploymentId,
        packageSnapshotId: 'aepsnap_upgrade-corpus',
        runtimeTargetId: sql.runtimeTargetId,
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/upgrade-corpus',
        transientProviderInstanceId: null,
      },
      lineage: { workspaceId, threadId, turnId },
    });
    o.control.recordWorkerControlAcceptedRecord(core, {
      acceptedAt: NOW,
      lineage: {
        workspaceId,
        threadId,
        turnId,
        agentSessionId: sql.agentSessionId,
        packageSnapshotId: 'aepsnap_upgrade-corpus',
        requestId: 'upgrade-corpus-worker',
      },
      operation: 'event_append',
      recordKey: '1',
      sequence: 1,
      record: {
        kind: 'event',
        schemaVersion: 1,
        sequence: 1,
        lineage: {
          workspaceId,
          threadId,
          turnId,
          agentSessionId: sql.agentSessionId,
          packageSnapshotId: 'aepsnap_upgrade-corpus',
          requestId: 'upgrade-corpus-worker',
        },
        event: { type: 'worker.heartbeat', data: { status: 'running' } },
      },
    });
    o.attempts.closeSchedulerExecutionAttemptWithoutEffects(core, {
      attemptId: sql.attemptId,
      noOutstandingEffects: true,
      cause: 'synthetic-corpus',
      now: () => NOW,
    });
    for (const [fromState, toState] of [
      ['materializing', 'cleanup-pending'],
      ['cleanup-pending', 'physical-cleaned'],
      ['physical-cleaned', 'cleaned'],
    ]) {
      o.backend.transitionWorkerBackendSessionState(core, {
        attemptId: sql.attemptId,
        fromState,
        toState,
        now: () => NOW,
      });
    }
    o.targets.recordNanoHostRuntimeTargetConnectionClose(core, {
      targetId: sql.runtimeTargetId,
      closedGeneration: target.connectionGeneration,
      authoritativeGeneration: null,
      observedAt: new Date().toISOString(),
    });
    const call = o.usage.startCapabilityCall({
      workspaceDb: workspace,
      workspaceId,
      threadId,
      turnId,
      authorityActor: actor,
      agentId: 'agent_codex_host',
      agentSessionId: sql.agentSessionId,
      capabilityId: 'llm.responses',
      family: 'llm',
      operation: 'responses.create',
      providerRef: 'synthetic-provider',
      sourceIds: [],
      redactionClass: 'metadata-only',
      summary: 'Synthetic retained capability call.',
      now: new Date(NOW),
    });
    sql.capabilityCallId = call.id;
    o.usage.recordUsage({
      workspaceDb: workspace,
      call,
      now: new Date(NOW),
      records: [
        {
          category: 'llm',
          modelId: 'synthetic-model',
          providerRef: 'synthetic-provider',
          quantity: 1,
          source: 'provider-reported',
          unit: 'tokens',
        },
      ],
    });
    o.usage.finishCapabilityCall({
      workspaceDb: workspace,
      callId: call.id,
      status: 'succeeded',
      now: new Date(NOW),
    });
    await seedTaskReceipts(o, core, user, workspace, store, sql);
    sql.readItemId = store
      .listThreadItems(workspaceId, threadId)
      .find((item) => item.type === 'user-message')?.id;
    if (!sql.readItemId) {
      throw new Error('B01 Turn must have its real request Item before SQL corpus seeding.');
    }
    o.reads.advanceThreadReadReceipt(user, workspaceId, threadId, [sql.readItemId]);
    sql.materialId = o.materials.createWorkspaceMaterial(workspace, {
      acceptedAt: NOW,
      actor,
      kind: 'text',
      requestId: 'upgrade-corpus-material',
      sensitivity: 'internal',
      title: 'Synthetic retained material',
    }).materialId;
    const content = 'Synthetic upgrade continuity material.\n';
    sql.materialRevisionId = o.materials.saveWorkspaceMaterialRevision(workspace, {
      acceptedAt: NOW,
      actor,
      content,
      contentDigest: `sha256:${digest(content)}`,
      expectedRevisionId: null,
      materialId: sql.materialId,
      requestId: 'upgrade-corpus-revision',
    }).revisionId;
    o.materials.bindThreadMaterial(workspace, {
      acceptedAt: NOW,
      actor,
      materialId: sql.materialId,
      threadId,
      requestId: 'upgrade-corpus-binding',
      expectedCurrentRevisionId: sql.materialRevisionId,
    });
    const goal = await o.goals.executeGoalOperation(
      'goal.create',
      {
        workspaceId,
        requestId: '00000000-0000-4000-8000-000000000902',
        intent: 'Preserve the synthetic corpus.',
      },
      { actor: { kind: 'local', userId } },
      store,
      workspace
    );
    sql.goalId = goal.goal.goalId;
    sql.goalThreadId = goal.goal.threadId;
    sql.setupId = 'ras_upgrade-corpus';
    o.setup.recordResolvedAgentSetup(workspace, {
      recordId: sql.setupId,
      workspaceId,
      turnId,
      requestId: 'upgrade-corpus-worker',
      setup: syntheticAgentSetup(),
      createdAt: NOW,
    });
    sql.syncSnapshotId = 'wis_upgrade-corpus';
    o.sync.recordWorkspaceInputSnapshots(workspace, [
      {
        id: sql.syncSnapshotId,
        workspaceId,
        resourceId: 'synthetic',
        sourceId: 'synthetic',
        resourceKind: 'git_repository',
        strategy: 'git',
        base: { commit: 'a'.repeat(40), contentDigest: null },
        backend: { kind: 'openshell', label: 'Synthetic retained backend', capabilitySummary: [] },
        generatedFiles: [],
        ignoredPaths: [],
        pathScope: ['synthetic'],
        writableRoots: ['synthetic'],
        createdAt: NOW,
      },
    ]);
    const kernelContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId,
      actor,
      requestId: '00000000-0000-4000-8000-000000000903',
    };
    const app = await o.kernel.createLightApp(kernelContext, {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Synthetic continuity app',
      purpose: 'Preserve one synthetic business record.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Synthetic retained notes.',
          fields: [{ name: 'note', type: 'text', required: true, description: 'Synthetic note.' }],
          indexes: [],
        },
      ],
    });
    sql.lightAppId = app.appId;
    sql.lightAppSchemaRevision = app.schemaRevision;
    sql.lightAppDefinitionVersion = app.definitionVersion;
    sql.lightAppRecordId = (
      await o.kernel.createRecord(
        { ...kernelContext, requestId: '00000000-0000-4000-8000-000000000904' },
        app.appId,
        'notes',
        app.schemaRevision,
        { note: 'Synthetic retained business record.' }
      )
    ).id;
    const appHandle = o.appDb.openExistingAppDb(dataRoot, workspaceId, app.appId);
    try {
      const snapshot = o.snapshots.snapshotLightApp(appHandle, 'definition-migration');
      sql.lightAppSnapshotId = snapshot.snapshotId;
      sql.lightAppSnapshotPath = relative(
        dataRoot,
        join(
          o.appDb.lightAppRoot(dataRoot, workspaceId, app.appId),
          'snapshots',
          `${snapshot.snapshotId}.sqlite`
        )
      );
      sql.journals = [core, user, workspace, appHandle].map((handle) => ({
        scope: handle.scope,
        hashes: handle.sqlite
          .prepare('SELECT hash FROM __drizzle_migrations ORDER BY id')
          .all()
          .map((row) => row.hash),
      }));
    } finally {
      appHandle.sqlite.close();
    }
    await seedLinkedEvidence(o, core, workspace, store, sql, retainedRoot, async (contextInput) => {
      const { shutdownControlStoreWorkerClient } = await o.load(
        'storage/control-store-worker-client'
      );
      await shutdownControlStoreWorkerClient();
      workspace.sqlite.close();
      user.sqlite.close();
      core.sqlite.close();
      // The native Task and Worker owners run to complete model closeout before the process cut.
      const producer = spawnSync(
        process.execPath,
        [
          '-e',
          `import(process.argv[1]).then(async ({ produceStoppedSqlContext }) => {
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
await produceStoppedSqlContext(input);
});`,
          import.meta.url,
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({ appRoot, dataRoot, retainedRoot, sql, ...contextInput }),
        }
      );
      if (producer.error) throw producer.error;
      if (producer.status !== 0)
        throw new Error(`SQL corpus Worker producer failed: ${producer.stderr || producer.stdout}`);
      const stoppedLine = producer.stdout
        .split('\n')
        .find((row) => row.startsWith('SQL_CORPUS_WORKER_STOP '));
      if (!stoppedLine)
        throw new Error('SQL corpus Worker producer returned no stopped publication.');
      const stopped = JSON.parse(stoppedLine.slice('SQL_CORPUS_WORKER_STOP '.length));
      sql.contextTurnId = stopped.turn.id;
      sql.contextAgentSessionId = stopped.session.id;
      sql.aepSnapshotId = stopped.environmentPackage.snapshotId;
      sql.contextStopped = stopped;
      process.stdout.write(
        `SQL_CORPUS_ADMITTED_STOP ${JSON.stringify({
          turn: {
            status: stopped.turn.status,
            linked: stopped.turn.agentSessionId === stopped.session.id,
          },
          session: { status: stopped.session.status, stale: stopped.session.stale },
          attempt: {
            phase: stopped.attempt.phase,
            operationId: stopped.attempt.operationId,
            prepared: Boolean(stopped.attempt.bindingRef && stopped.attempt.inputRef),
            linked: stopped.attempt.agentSessionId === stopped.session.id,
          },
          checkpoint: {
            stage: stopped.checkpoint.stage,
            iteration: stopped.checkpoint.iteration,
            linked: stopped.checkpoint.workerSessionId === stopped.session.id,
          },
          executions: stopped.executionRows.length,
          intents: stopped.intents,
        })}\n`
      );
      // A fresh process has no surviving Store, writer, admission cache or SQLite connection.
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `import(process.argv[1]).then(async ({ recoverStoppedSqlCorpus }) => {
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const result = await recoverStoppedSqlCorpus(input);
process.stdout.write('SQL_CORPUS_COLD_BOOT ' + JSON.stringify(result));
});`,
          import.meta.url,
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({ appRoot, dataRoot, sql }),
        }
      );
      if (child.error) throw child.error;
      if (child.status !== 0)
        throw new Error(`SQL corpus cold boot failed: ${child.stderr || child.stdout}`);
      const line = child.stdout.split('\n').find((row) => row.startsWith('SQL_CORPUS_COLD_BOOT '));
      if (!line) throw new Error('SQL corpus cold boot returned no owner readback.');
      const recovered = JSON.parse(line.slice('SQL_CORPUS_COLD_BOOT '.length));
      sql.contextRecovery = { turn: recovered.turn, session: recovered.session };
      // Stop this case on the boot owner's first refusal; never seed against degraded checkpoint truth.
      if (recovered.checkpointRecoveryFailures)
        throw new Error(
          `Cold boot recovery refused the native Task checkpoint: ${JSON.stringify({
            turn: {
              status: recovered.turn.status,
              code: recovered.turn.error?.code,
              linked: recovered.turn.agentSessionId === recovered.session.id,
            },
            session: { status: recovered.session.status, stale: recovered.session.stale },
            checkpointRecoveryFailures: recovered.checkpointRecoveryFailures,
            checkpointRecoveryErrors: recovered.checkpointRecoveryErrors,
            projectRecoveredTurnCalls: recovered.projectRecoveredTurnCalls,
          })}`
        );
      const { isCurrentAgentSessionStatus } = await o.load('storage/workspace-file-records');
      if (
        isCurrentAgentSessionStatus(recovered.session.status) &&
        recovered.turn.status === 'running'
      )
        throw new Error(
          `Cold boot recovery left the context Session current and its Turn running: ${JSON.stringify(
            {
              turn: {
                status: recovered.turn.status,
                linked: recovered.turn.agentSessionId === recovered.session.id,
              },
              session: { status: recovered.session.status, stale: recovered.session.stale },
              checkpointRecoveryFailures: recovered.checkpointRecoveryFailures,
              checkpointRecoveryErrors: recovered.checkpointRecoveryErrors,
              projectRecoveredTurnCalls: recovered.projectRecoveredTurnCalls,
            }
          )}`
        );
      core = o.db.openCoreDb(dataRoot);
      user = o.db.openUserDb(dataRoot, userId);
      workspace = o.db.openWorkspaceDb(dataRoot, workspaceId);
      return { core, workspace, store: new o.store.FsStore({ dataRoot }), stopped };
    });
    return { sql };
  } finally {
    const { shutdownControlStoreWorkerClient } = await o.load(
      'storage/control-store-worker-client'
    );
    await shutdownControlStoreWorkerClient();
    if (workspace.sqlite.open) workspace.sqlite.close();
    if (user.sqlite.open) user.sqlite.close();
    if (core.sqlite.open) core.sqlite.close();
  }
}

/** Runs native Task closeout against an external model, then stops before Task envelope recovery. */
export async function produceStoppedSqlContext({
  appRoot,
  dataRoot,
  retainedRoot,
  sql,
  workspaceId,
  threadId,
  requestId,
}) {
  const o = await owners(appRoot);
  const [modes, worker, files, images, imagePreparation, hashing, protocol] = await Promise.all([
    o.load('mode-entry-routes'),
    o.load('runtime/worker-governance-turn-executor'),
    o.load('storage/artifacts/file-admission'),
    o.load('runtime/worker-image-settlements'),
    o.load('worker-environments/worker-environment-preparation'),
    o.load('runtime/idempotent-command'),
    o.loadPackage('@openkit/protocol'),
  ]);
  const core = o.db.openCoreDb(dataRoot);
  const store = new o.store.FsStore({ dataRoot });
  const setup = syntheticAgentSetup();
  const inputDigest = hashing.commandInputHash(
    imagePreparation.materializeRuntimeImage(setup.manifest.runtime.image)
  );
  const candidate = {
    authoredArtifactId: id('ar', 'image-evidence'),
    authoredArtifactVersion: 1,
    authoredContentDigest: inputDigest,
    inputDigest,
  };
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  images.writeWorkerImageSettlement(core, {
    ...candidate,
    requestId: digest('upgrade-corpus-image'),
    operation: 'image.acquire',
    outcome: { kind: 'success', imageDigest },
  });
  images.admitWorkerImageEnvironment(core, candidate, {
    imageDigest,
    defaultsDigest: `sha256:${digest('{}')}`,
    values: {},
  });
  const previousTarget = o.targets.getNanoHostRuntimeTarget(core, sql.runtimeTargetId);
  const target = o.targets.upsertNanoHostRuntimeTarget(core, {
    ...o.targets.allocateNanoHostRuntimeTargetConnectionGeneration(core, {
      targetId: previousTarget.targetId,
      identityId: previousTarget.identityId,
      deploymentId: previousTarget.deploymentId,
      observedAt: new Date().toISOString(),
    }),
    physicalEpoch: o.backend.getWorkerBackendSession(core, sql.attemptId).originPhysicalEpoch,
    freshEmpty: true,
    ready: true,
    predecessorFenced: true,
  });
  const { shutdownControlStoreWorkerClient } = await o.load('storage/control-store-worker-client');
  let originalAttemptId;
  let workerRequest;
  let publishedEnvironmentPackage;
  /** Stops only after the native executor acknowledges model terminal publication and release. */
  async function stopAfterNativeCloseout(environmentPackage) {
    const workspace = o.db.openWorkspaceDb(dataRoot, workspaceId);
    const turn = store.getTurnById(environmentPackage.scope.turnId);
    const session = store.getAgentSession(environmentPackage.scope.agentSessionId);
    const executionRows = workspace.sqlite
      .prepare('SELECT id FROM control_executions WHERE work_id = ?')
      .all(turn.id);
    const intents = workspace.sqlite
      .prepare(
        `SELECT json_extract(control_json, '$.kind') AS kind, state, json_extract(span_json, '$.endTimeUnixNano') AS endedAt
         FROM control_execution_steps WHERE execution_id = ? ORDER BY kind`
      )
      .all(executionRows[0]?.id);
    const stopped = {
      turn,
      session,
      environmentPackage,
      workerRequest,
      requestItemId: protocol.deriveEntityId('it', ['task-user', turn.id]),
      attempt: o.attempts.requireSchedulerExecutionAttempt(core, originalAttemptId),
      checkpoint: o.checkpoints.getWorkerCheckpoint(workspace, workspaceId, threadId, turn.id),
      executionRows,
      intents,
    };
    await shutdownControlStoreWorkerClient();
    workspace.sqlite.close();
    core.sqlite.close();
    await new Promise((resolve) =>
      process.stdout.write(`SQL_CORPUS_WORKER_STOP ${JSON.stringify(stopped)}\n`, resolve)
    );
    // This process cut tests cold Task-envelope publication after completed native model closeout.
    process.exit(0);
  }
  const [appOwner, native, workerProtocol] = await Promise.all([
    o.load('app'),
    o.load('runtime/nanohost-attempt-records'),
    o.loadPackage('@openkit/worker-protocol'),
  ]);
  const gateway = appOwner.createDefaultWorkerControlGateway(core);
  const modelRoot = join(retainedRoot, 'synthetic-context-external-model');
  const exposureRoot = join(modelRoot, 'exposure');
  const model = { registration: null, correlation: null, eventsJsonl: null };
  let capture;
  let credentialCheckValues;
  const modelSessionId = 'upgrade-corpus-context-session';
  const backend = {
    id: 'nanohost',
    async describeCapabilities() {
      return {
        kind: 'openshell',
        version: 'synthetic',
        capabilities: setup.manifest.sandbox.backend.requiredCapabilities,
        dynamicCapabilities: [],
      };
    },
    async validatePackage() {
      return [];
    },
    async prepareAgentSessionContinuity() {
      return 'absent';
    },
    planSession(environmentPackage) {
      return {
        agentSessionId: environmentPackage.scope.agentSessionId,
        backendKind: 'openshell',
        backendSessionId: modelSessionId,
        deploymentId: target.deploymentId,
        packageSnapshotId: environmentPackage.snapshotId,
        runtimeTargetId: target.targetId,
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/upgrade-corpus-context',
        transientProviderInstanceId: null,
      };
    },
    async materialize(environmentPackage, context) {
      assert.equal(existsSync(exposureRoot), false);
      publishedEnvironmentPackage = environmentPackage;
      await context.beforeMaterialization();
      mkdirSync(exposureRoot, { recursive: true });
      capture = writeSqlContextCapture(environmentPackage, join(modelRoot, 'capture'));
      model.registration = gateway.registerSession(environmentPackage, {
        sandboxBindingRef: context.sandboxBindingRef,
      });
      native.bindNanoHostAttemptRouteTokenHashes(core, {
        attemptId: originalAttemptId,
        sandboxBindingRef: context.sandboxBindingRef,
        workerControlTokenHash: model.registration.workerControlTokenHash,
        workerInferenceTokenHash: model.registration.workerInferenceTokenHash,
        workerCapabilityTokenHash: model.registration.workerCapabilityTokenHash,
      });
      const loopbackValues = Array.from({ length: 2 }, () => randomBytes(32).toString('base64url'));
      writeFileSync(join(exposureRoot, 'loopback.json'), JSON.stringify(loopbackValues), {
        mode: 0o600,
      });
      credentialCheckValues = {
        sensitiveValues: [
          context.sandboxBindingRef,
          ...[
            ...context.providerCredentials,
            ...context.runtimeEnvCredentials,
            ...context.runtimeFileCredentials,
          ].map((entry) => entry.credentialValue),
        ],
        loopbackDigests: loopbackValues.map((value) => digest(value)),
        routeTokenHashes: {
          workerControl: model.registration.workerControlTokenHash,
          inference: model.registration.workerInferenceTokenHash,
          capability: model.registration.workerCapabilityTokenHash,
        },
      };
      return {
        backendKind: 'openshell',
        packageId: environmentPackage.packageId,
        packageSnapshotId: environmentPackage.snapshotId,
        controlMode: environmentPackage.control.mode,
        command: environmentPackage.runtime.command,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
        sandbox: { name: modelSessionId, source: 'deterministic-external-model', state: 'created' },
        workspaceInputs: environmentPackage.workspace.inputs.map(
          ({ id, kind, target, access }) => ({ id, kind, target, access })
        ),
      };
    },
    async prepareLaunch() {
      assert.equal(existsSync(exposureRoot), true);
    },
    async submit(input) {
      model.correlation = input;
      return {
        ...input,
        disposition: 'accepted',
        execution: 'pending',
        fenceRef: null,
        outcomeRef: null,
      };
    },
    async inspect() {
      throw new Error('This model has no inspection request.');
    },
    async cancel() {
      throw new Error('This model has no cancellation request.');
    },
    async collectEvidence() {
      return [];
    },
    async collectWorkspaceChanges() {
      return [];
    },
    async collectTranscript() {
      return {
        eventsJsonl: required(model.eventsJsonl, 'External model terminal bytes'),
        itemsJsonl: '',
        runtimeProvenance: capture,
        credentialCheckValues,
      };
    },
    async cleanupSession(identity) {
      assert.equal(identity.backendSessionId, modelSessionId);
      rmSync(exposureRoot, { recursive: true });
      assert.equal(gateway.unregisterSession(publishedEnvironmentPackage.snapshotId), true);
    },
    async release({ proof, ...correlation }) {
      assert.equal(existsSync(exposureRoot), false);
      assert.deepEqual(Object.values(proof), [true, true, true, true, true, true]);
      for (const key of ['attemptId', 'backendId', 'bindingRef', 'inputRef', 'operationId'])
        assert.equal(correlation[key], model.correlation[key]);
      return {
        ...correlation,
        state: 'released',
        fenceRef: `external-model-fence:${correlation.attemptId}`,
      };
    },
  };
  const executor = new worker.WorkerGovernanceTurnExecutor({
    backend,
    coreDb: core,
    fileAdmission: new files.FileStorageAdmission(dataRoot, () => 0n),
    createAgentSessionId: () => id('as', 'context-session'),
    workerControlGateway: gateway,
    async awaitWorkerCompletion(environmentPackage) {
      const { lineage } = capture;
      const terminal = workerProtocol.buildWorkerCanonicalTerminalEventRecord({
        lineage,
        sequence: 0,
        data: {
          status: 'failed',
          stopReason: 'error',
        },
      });
      model.eventsJsonl = `${JSON.stringify(terminal)}\n`;
      const accepted = gateway.recordFinalStatus({
        authorization: `Bearer ${model.registration.token}`,
        tokenFamily: 'worker-control',
        lineage,
        sequence: terminal.sequence,
        ...terminal.event.data,
      });
      assert.equal(accepted.accepted, true);
      return o.control.waitForWorkerControlFinalStatus(core, {
        attemptId: originalAttemptId,
        lineage,
      });
    },
  });
  let execution;
  const startTask = modes.createTaskStartOperation({
    coreDb: core,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new o.admission.WorkspaceMutationAdmission(),
    repositoryWorkspaceDb: (selectedWorkspaceId) =>
      o.db.openWorkspaceDb(dataRoot, selectedWorkspaceId),
    workerCoordinatorCandidates: () => [
      {
        agentId: setup.manifest.id,
        displayName: setup.manifest.displayName,
        readiness: 'ready',
      },
    ],
    startModeWorkerTurn(input) {
      execution = (async () => {
        workerRequest = input.prompt;
        const entry = o.scheduler.createSchedulerAdmissionEntry(core, {
          backendId: backend.id,
          queueEntryId: 'upgrade-corpus-context-queue',
          requestId: input.requestId,
          workspaceId,
          threadId,
          turnId: input.reservedTurnId,
          turnInput: input.prompt,
          requestedAgentId: input.requestedAgentId,
          triggerActor: input.triggerActor,
        });
        const turn = await store.createTurn(
          workspaceId,
          threadId,
          input.prompt,
          input.triggerActor,
          null,
          {
            turnId: input.reservedTurnId,
            status: 'pending',
            agentId: input.requestedAgentId,
            executorKind: 'worker',
            commandReceipt: input.commandReceipt,
            triggerSource: input.triggerSource,
            captureCoverage: { scope: 'server', value: 'on' },
          }
        );
        await input.onTurnCreated?.(turn, null);
        originalAttemptId = id('attempt', 'context-attempt');
        o.attempts.createSchedulerExecutionAttempt(core, {
          entry,
          attemptId: originalAttemptId,
          preparationInput: { admission: entry, setup },
        });
        const preparation = {
          attemptId: originalAttemptId,
          agentSetup: setup,
          freshAgentSessionId: id('as', 'context-session'),
          requestId: input.requestId,
          turn,
          turnInput: input.prompt,
          workspaceCwd: '/workspace',
          workspaceRoots: [],
        };
        const prepared = await executor.prepareAgentSessionForTurn(store, preparation);
        o.attempts.bindSchedulerExecutionAttemptSession(core, {
          attemptId: originalAttemptId,
          agentSessionId: prepared.agentSessionId,
        });
        await executor.commitPreparedAgentSessionForTurn(store, {
          attemptId: originalAttemptId,
          prepared,
          preparation,
        });
        // Match the orchestrator's admitted pending-to-running transition before executor entry.
        await store.updateTurn(turn.id, { status: 'running' });
        await executor.startTurn(store, turn.id, input.prompt, {
          attemptId: originalAttemptId,
          agentSessionId: prepared.agentSessionId,
          agentSetup: setup,
          sessionCompatibilityKey: prepared.sessionCompatibilityKey,
          requestId: input.requestId,
          triggerActor: input.triggerActor,
          workspaceRoots: [],
          workspaceCwd: '/workspace',
        });
        await stopAfterNativeCloseout(publishedEnvironmentPackage);
      })().catch((error) => {
        process.stderr.write(
          `SQL_CORPUS_WORKER_REFUSAL ${JSON.stringify({
            name: error.name,
            code: error.code,
            message: error.message,
            causes: error.errors?.map((cause) => ({
              name: cause.name,
              code: cause.code,
              message: cause.message,
            })),
          })}\n`
        );
        throw error;
      });
      return execution;
    },
  });
  try {
    await startTask(
      store,
      {
        workspaceId,
        threadId,
        requestId,
        agentId: setup.manifest.id,
        input: 'Read the synthetic retained material and keep its content exact.',
      },
      { kind: 'local', userId: sql.userId }
    );
    await execution;
    throw new Error('SQL corpus Task admission returned without the required Worker process stop.');
  } finally {
    if (publishedEnvironmentPackage)
      gateway.unregisterSession(publishedEnvironmentPackage.snapshotId);
    try {
      rmSync(exposureRoot, { recursive: true, force: true });
    } catch {
      process.stderr.write('SQL_CORPUS_MODEL_EXPOSURE_CLEANUP_FAILED\n');
      process.exitCode = 1;
    }
    await shutdownControlStoreWorkerClient();
    if (core.sqlite.open) core.sqlite.close();
  }
}

/** Runs the selected image's pre-listen storage and recovery owners in a fresh process. */
export async function recoverStoppedSqlCorpus({ appRoot, dataRoot, sql }) {
  const o = await owners(appRoot);
  const core = o.db.openCoreDbWithIntegrityCheck(dataRoot, { freshInitialization: false });
  const admission = new o.admission.WorkspaceMutationAdmission();
  const [
    readiness,
    records,
    indexes,
    managers,
    restart,
    native,
    factory,
    app,
    terminal,
    observations,
    flow,
    modes,
  ] = await Promise.all(
    [
      'bootstrap/readiness',
      'storage/workspace-file-records',
      'storage/index-rebuild',
      'knowledge/server-knowledge-maintenance',
      'runtime/scheduler-restart-recovery',
      'runtime/nanohost-attempt-recovery',
      'runtime/turn-executor-factory',
      'app',
      'runtime/worker-turn-failure',
      'storage/work-observation-recovery',
      'runtime/pending-request-flow',
      'mode-entry-routes',
    ].map(o.load)
  );
  try {
    o.migrate.applyMigrations(core);
    readiness.restoreWorkspaceRetirementAdmission({
      coreDb: core,
      workspaceMutationAdmission: admission,
    });
    o.usage.recoverRunningCapabilityCalls({ workspaceDb: core });
    o.db.verifyAndMigrateExistingScopedDatabases(dataRoot, () =>
      o.store.FsStore.validateFileAuthority(dataRoot)
    );
    const store = new o.store.FsStore({ dataRoot });
    indexes.rebuildInvalidExistingWorkspaceDerivedIndexes(dataRoot);
    app.restoreWorkspaceDeletionMutationAdmission({
      coreDb: core,
      dataRoot,
      workspaceMutationAdmission: admission,
    });
    o.targets.fenceNanoHostRuntimeTargetAfterRestart(core, new Date().toISOString());
    records.discardAbandonedWorkspaceStaging(dataRoot);
    await managers.recoverServerKnowledgeManagerTurns(store);
    // The real lifecycle backend is constructed without ambient environment or an effect dispatcher.
    const runtime = factory.createConfiguredWorkerLifecycleRuntime({
      env: {},
      coreDb: core,
      store,
      workspaceMutationAdmission: admission,
    });
    let projectRecoveredTurnCalls = 0;
    const recovery = {
      executionBackend: runtime.turnExecutor.executionBackend,
      store,
      reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
      cleanupBackendSession: runtime.cleanupBackendSession,
      isTurnExecutionActive: runtime.isTurnExecutionActive,
      prepareBackendCleanup: runtime.prepareBackendCleanup,
      restoreBackendSession: runtime.restoreBackendSession,
      // This is the composition used by index.ts, invoked only for subjects the recovery owner selects.
      projectRecoveredTurn: async (subject) => {
        projectRecoveredTurnCalls += 1;
        const context = o.scheduler.requireSchedulerExecutionAttemptAdmissionContext(
          core,
          subject.attemptId
        );
        const anchored = 'state' in subject;
        const result = await terminal.terminalizeGovernedWorkerTurn({
          agentSessionId: subject.agentSessionId,
          completedAt: new Date().toISOString(),
          errorCode: 'worker_governance_restart_recovery',
          message: anchored
            ? 'Worker execution was interrupted during scheduler recovery.'
            : 'Worker execution stopped during scheduler recovery.',
          outcome: anchored ? 'interrupted' : 'failed',
          requestId: context.requestId,
          store,
          turnId: subject.turnId,
        });
        if (!['completed', 'failed', 'interrupted', 'cancelled', 'missing'].includes(result.status))
          throw new Error(
            `Restart recovery left turn ${subject.turnId} non-terminal: ${result.status}.`
          );
        if ('id' in result && result.error?.code === 'worker_governance_restart_recovery') {
          const db = o.db.openBootVerifiedWorkspaceDb(dataRoot, result.owner.workspaceId);
          try {
            observations.appendRecoveredTurnObservation(
              db,
              result,
              anchored ? 'anchored-cleanup' : 'pre-anchor'
            );
          } finally {
            db.sqlite.close();
          }
        }
        return { status: result.status };
      },
    };
    await restart.runSchedulerRestartRecovery(core, recovery);
    await native.classifyNanoHostAttemptsAfterRestart(core, recovery);
    let checkpointRecoveryFailures = 0;
    const checkpointRecoveryErrors = [];
    // Match index.ts: checkpoint failures degrade readiness but do not bypass later recovery.
    for (const { workspaceId } of o.db.listExistingWorkspaceDatabaseScopes(dataRoot)) {
      let db;
      try {
        db = o.db.openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
        for (const checkpoint of o.checkpoints.listExportableWorkerCheckpoints(db, workspaceId)) {
          try {
            if (checkpoint.goalId !== null || checkpoint.taskId !== null)
              throw new Error('Worker checkpoint has only one Goal lineage owner.');
            await modes.classifyDirectTaskCheckpointAfterSchedulerRecovery({
              coreDb: core,
              store,
              workspaceDb: db,
              checkpoint,
            });
          } catch (error) {
            checkpointRecoveryFailures += 1;
            checkpointRecoveryErrors.push(error.message);
          }
        }
      } catch (error) {
        checkpointRecoveryFailures += 1;
        checkpointRecoveryErrors.push(error.message);
      } finally {
        db?.sqlite.close();
      }
    }
    const pendingWorkspace = {
      coreDb: core,
      openWorkspace: (workspaceId) => o.db.openBootVerifiedWorkspaceDb(dataRoot, workspaceId),
    };
    flow.installPendingRequestAdmission(store, pendingWorkspace);
    await flow.recoverPendingRequestsAtBoot(store, pendingWorkspace);
    return {
      turn: store.getTurnById(sql.contextTurnId),
      session: store.getAgentSession(sql.contextAgentSessionId),
      checkpointRecoveryFailures,
      checkpointRecoveryErrors,
      projectRecoveredTurnCalls,
    };
  } catch (error) {
    const store = new o.store.FsStore({ dataRoot });
    const turn = store.getTurnById(sql.contextTurnId);
    const session = store.getAgentSession(sql.contextAgentSessionId);
    process.stderr.write(
      `SQL_CORPUS_RECOVERY_REFUSAL ${JSON.stringify({
        name: error.name,
        code: error.code,
        message: error.message,
        causes: error.errors?.map((cause) => ({
          name: cause.name,
          code: cause.code,
          message: cause.message,
        })),
        turn: { status: turn.status, linked: turn.agentSessionId === session.id },
        session: { status: session.status, stale: session.stale },
        attempt: o.attempts.requireSchedulerExecutionAttempt(
          core,
          sql.contextStopped.attempt.attemptId
        ),
      })}\n`
    );
    throw error;
  } finally {
    const worker = await o.load('storage/control-store-worker-client');
    await worker.shutdownControlStoreWorkerClient();
    core.sqlite.close();
  }
}

/** Admits fresh, unexecuted Task Turns and their original receipts in the selected native writer. */
async function seedTaskReceipts(o, core, user, workspace, store, sql) {
  const records = await o.load('storage/workspace-file-records');
  const { getControlStoreWorkerClient } = await o.load('storage/control-store-worker-client');
  const protocol = await o.loadPackage('@openkit/protocol');
  const { commandInputHash } = await o.load('runtime/idempotent-command');
  sql.receiptKeys = {};
  sql.receipts = {};
  for (const [scopeName, handle, owner] of [
    ['core', core, { kind: 'server' }],
    ['workspace', workspace, { kind: 'workspace', workspaceId: workspace.workspaceId }],
  ]) {
    const thread =
      owner.kind === 'server'
        ? await store.createServerThread('Synthetic retained Task admission')
        : await store.createThread(owner.workspaceId, 'Synthetic retained Task admission');
    const scope =
      owner.kind === 'server' ? { coreId: 'server' } : { workspaceId: owner.workspaceId };
    const requestId = randomUUID();
    const prompt = 'Retain this Task admission without executing it.';
    const turn = protocol.TurnSchema.parse({
      id: protocol.allocateEntityId('tu'),
      owner,
      threadId: thread.id,
      triggerActor: { kind: 'user', id: sql.userId },
      items: [],
      status: 'pending',
      error: null,
      configVersion: null,
      startedAt: NOW,
      completedAt: null,
      durationMs: null,
    });
    const receipt = {
      key: o.store.commandRequestKey('task.start', requestId, scope),
      command: 'task.start',
      requestId,
      scope,
      inputHash: commandInputHash({ input: prompt }),
      response: { kind: 'turn', id: turn.id },
      createdAt: NOW,
      expiresAt: EXPIRES,
    };
    const native = records.nativeProductScope(core.dataRoot, owner);
    const previous = records.readNativeProduct(native, 'thread', thread.id);
    const client = getControlStoreWorkerClient();
    const database = `${scopeName}:${native.path}`;
    await client.open({
      database,
      path: native.path,
      dataRoot: core.dataRoot,
      create: false,
      initialize: owner.kind === 'server' ? 'core' : 'workspace',
      productOwner: owner,
      contentMount: native.contentMount,
    });
    const admitted = await client.transition(database, {
      receipt,
      products: [
        {
          kind: 'thread',
          expectedRevision: previous.revision,
          record: protocol.writeRetainedV1({ ...previous.record, preview: prompt, updatedAt: NOW }),
        },
        { kind: 'turn', expectedRevision: 0, record: protocol.writeRetainedV1(turn) },
      ],
      entries: [],
      audit: o.audit.prepareAuditEvent({
        workspaceId: owner.kind === 'workspace' ? owner.workspaceId : null,
        threadId: thread.id,
        turnId: turn.id,
        requestId,
        actor: turn.triggerActor,
        category: 'command',
        action: 'task.start',
        resource: `turn:${turn.id}`,
        outcome: 'succeeded',
        summary: 'Synthetic Task admitted without execution.',
        now: new Date(NOW),
      }),
    });
    assert.deepEqual(admitted.response, receipt.response);
    const retained = required(
      o.commands.getCommandRequestRecordFromDb(handle, receipt.key, NOW),
      `${scopeName} Task admission receipt`
    );
    assert.deepEqual(retained, receipt);
    assert.deepEqual(
      records.readNativeProduct(native, 'turn', admitted.response.id).record,
      protocol.writeRetainedV1(turn)
    );
    sql.receiptKeys[scopeName] = retained.key;
    sql.receipts[scopeName] = retained;
  }
  // User receipts keep their existing Main owner; the Task pointer comes from native admission.
  const receipt = {
    key: 'task.start|upgrade-corpus-user|user',
    command: 'task.start',
    requestId: 'upgrade-corpus-user',
    scope: { userId: sql.userId },
    inputHash: 'sha256:synthetic-corpus',
    response: sql.receipts.workspace.response,
    createdAt: NOW,
    expiresAt: EXPIRES,
  };
  o.commands.recordCommandRequestRecordInDb(user, receipt);
  sql.receiptKeys.user = receipt.key;
  sql.receipts.user = required(
    o.commands.getCommandRequestRecordFromDb(user, receipt.key, NOW),
    'User command receipt'
  );
}

/** Seeds deployment-local channel history through native owners, using only in-memory synthetic signing material. */
async function seedChannelEvidence(o, core, workspace, sql, { workspaceId, threadId, turnId }) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const actor = { kind: 'session', userId: sql.userId };
  const applicationId = '123456789012345678';
  const discordUserId = '223456789012345678';
  const channel = o.discord.createDiscordChannel({
    sqlite: core.sqlite,
    applicationId,
    publicKey,
    appBaseUrl: 'https://upgrade-fixture.example.invalid',
    newRequestId: randomUUID,
    now: () => Date.parse(NOW),
    resolveActor: (userId) => (userId === sql.userId ? actor : null),
    requestLink: () => null,
    inspectPending: (query) => {
      const record = o.pending.readPendingRequest(workspace.sqlite, query.pendingRequestId);
      if (
        !record ||
        record.state !== 'pending' ||
        record.responsibleUserId !== query.actor.userId ||
        record.workspaceId !== query.workspaceId ||
        record.threadId !== query.threadId
      )
        return { status: 'unavailable', code: 'request_unavailable' };
      return {
        status: 'available',
        kind: 'approval',
        workspaceId,
        threadId,
        pendingRequestId: record.requestId,
        turnId,
        content: o.pending.canonicalJsonText(record.governedIntent),
        responseAllowed: true,
      };
    },
    invoke: async () => {
      throw new Error('The corpus must never dispatch a Core response.');
    },
  });
  const send = (eventId, name, values) => {
    const body = Buffer.from(
      JSON.stringify({
        id: eventId,
        application_id: applicationId,
        type: 2,
        version: 1,
        context: 1,
        channel: { id: '323456789012345678', type: 1 },
        user: { id: discordUserId },
        data: {
          name: 'openkit',
          type: 1,
          options: [
            {
              name,
              type: 1,
              options: Object.entries(values).map(([name, value]) => ({ name, value, type: 3 })),
            },
          ],
        },
      })
    );
    const timestamp = String(Date.parse(NOW) / 1000);
    return channel.handleSignedInteraction({
      body,
      timestamp,
      signature: sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        keys.privateKey
      ).toString('hex'),
    });
  };
  const challenge = channel.beginPairing(actor);
  sql.discordChallengeDigest = digest(challenge.challenge);
  sql.discordPairEventId = '100000000000000001';
  const paired = await send(sql.discordPairEventId, 'pair', { challenge: challenge.challenge });
  if (paired.type !== 4 || !paired.data.content.includes('Discord account paired.'))
    throw new Error('Discord corpus pairing was not admitted.');
  sql.discordInspectEventId = '100000000000000002';
  const inspected = await send(sql.discordInspectEventId, 'inspect', {
    workspace: workspaceId,
    thread: threadId,
    request: sql.pendingRequestId,
  });
  const token =
    inspected.type === 4 && inspected.data.content.match(/Disclosure: ([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error('Discord corpus disclosure was not admitted.');
  sql.discordDisclosureDigest = digest(token);
  const notifications = new o.attention.AttentionNotifications(core.sqlite, { now: () => NOW });
  const delivery = notifications.enqueue({
    source: { workspaceId, threadId, kind: 'approval-request', requestId: sql.pendingRequestId },
    recipientUserId: sql.userId,
  });
  sql.attentionId = delivery.id;
  await notifications.deliver(
    {
      deliveryId: delivery.id,
      recipientUserId: sql.userId,
      channel: 'discord',
      expectedAttemptId: null,
    },
    {
      isEligible: (current) =>
        current.recipientUserId === sql.userId && channel.binding(actor)?.userId === sql.userId,
      // This synthetic transport refuses before contact; it has no network implementation.
      transport: async () => ({ status: 'failed-no-send' }),
    }
  );
}

/** Writes the existing synthetic native capture; these bytes never prove physical execution. */
function writeSqlContextCapture(environmentPackage, captureRoot) {
  const { agentSessionId, requestId, workspaceId, threadId, turnId } = environmentPackage.scope;
  const lineage = {
    agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId,
    workspaceId,
    threadId,
    turnId,
  };
  const nativeSessionId = '019f0000-0000-7000-8000-000000000010';
  const nativeThreadId = '019f0000-0000-7000-8000-000000000001';
  const [sessionFrame, threadFrame] = [
    { type: 'session_meta', payload: { session_id: nativeSessionId, id: nativeThreadId } },
    { type: 'thread.started', thread_id: nativeThreadId },
  ].map((record) => Buffer.from(`${JSON.stringify(record)}\n`));
  const raw = Buffer.concat([sessionFrame, threadFrame]);
  const nativeIndex = [
    [sessionFrame, 'session_meta', { nativeSessionId, nativeThreadId }],
    [threadFrame, 'thread.started', { nativeThreadId }],
  ].map(([bytes, eventKind, identity], frameSequence) => ({
    schemaVersion: 1,
    lineage,
    runtimeFamily: 'codex',
    adapterVersion: '0.153.4',
    streamRef: 'stream-0000.jsonl',
    frameSequence,
    byteOffset: frameSequence === 0 ? 0 : sessionFrame.length,
    byteLength: bytes.length,
    frameSha256: `sha256:${digest(bytes)}`,
    eventKind,
    parseStatus: 'parsed',
    ...identity,
  }));
  const manifest = {
    schemaVersion: 1,
    lineage,
    runtimeFamily: 'codex',
    adapterVersion: '0.153.4',
    primaryStreamRef: 'stream-0000.jsonl',
    captureStatus: 'complete',
    streams: [
      {
        streamRef: 'stream-0000.jsonl',
        sourceKind: 'primary',
        bytes: raw.length,
        sha256: `sha256:${digest(raw)}`,
        frameCount: 2,
        captureStatus: 'complete',
        stableTerminal: true,
      },
    ],
  };
  mkdirSync(captureRoot, { recursive: true });
  writeFileSync(join(captureRoot, 'raw-streams.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(
    join(captureRoot, 'native-origin-index.jsonl'),
    `${nativeIndex.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  );
  writeFileSync(join(captureRoot, 'stream-0000.jsonl'), raw);
  return {
    lineage,
    manifestPath: join(captureRoot, 'raw-streams.json'),
    nativeOriginIndexPath: join(captureRoot, 'native-origin-index.jsonl'),
    diagnostics: [],
    missingPaths: [],
    rawStreamPaths: { 'stream-0000.jsonl': join(captureRoot, 'stream-0000.jsonl') },
  };
}

/** Seeds correlated AEP, Context Package, and original evidence through their product owners. */
async function seedLinkedEvidence(o, core, workspace, store, sql, retainedRoot, coldReopen) {
  const [hashing, context, contextAuthorities, provenance] = await Promise.all(
    [
      'runtime/idempotent-command',
      'context/worker-context-package',
      'context/worker-context-authorities',
      'runtime/worker-runtime-provenance',
    ].map(o.load)
  );
  const actor = { kind: 'user', id: sql.userId };
  const workspaceId = workspace.workspaceId;
  const threadId = sql.goalThreadId;
  const requestId = '00000000-0000-4000-8000-000000000907';
  const reopened = await coldReopen({ workspaceId, threadId, requestId });
  ({ core, workspace, store } = reopened);
  const turn = store.getTurnById(sql.contextTurnId);
  const environmentPackage = reopened.stopped.environmentPackage;
  const artifact = store.getArtifact(workspaceId, sql.artifactId);
  if (artifact.content.format === 'file')
    throw new Error('Artifact Review corpus requires the retained inline Artifact.');
  store.assertArtifactContent(artifact);
  const content = artifact.content.body;
  sql.artifactVersion = artifact.version;
  const publication = store.getArtifactVersion(workspaceId, artifact.id, artifact.version);
  const review = o.reviews.createArtifactReview(workspace, {
    artifactId: sql.artifactId,
    artifactVersion: artifact.version,
    contentDigest: artifact.contentDigest,
    sourceThreadId: artifact.threadId,
    sourceTurnId: artifact.turnId,
    sourceAgentId: artifact.turnId ? (store.getTurnById(artifact.turnId).agentId ?? null) : null,
    materialProposal: null,
    createdAt: publication.version.recordedAt,
  });
  sql.reviewId = review.reviewId;
  o.reviews.decideArtifactReview(workspace, {
    actorId: sql.userId,
    actor,
    artifactContent: content,
    artifactId: sql.artifactId,
    artifactMediaType:
      artifact.content.format === 'markdown'
        ? 'text/markdown'
        : artifact.content.format === 'json'
          ? 'application/json'
          : 'text/plain',
    artifactVersion: artifact.version,
    decidedAt: turn.startedAt,
    decision: 'accepted',
    feedback: 'Synthetic retained acceptance.',
    requestId: 'upgrade-corpus-review',
  });
  const evaluation = await o.load('evaluation-candidates');
  const judgements = await o.load('artifact-judgements');
  const access = {
    coreDb: core,
    workspaceDb: workspace,
    store,
    actor: { kind: 'session', userId: sql.userId },
    inflightCommands: new WeakMap(),
  };
  const judgementInput = {
    requestId: 'upgrade-corpus-artifact-judgement',
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    contentDigest: artifact.contentDigest,
    kind: 'accept',
    choice: null,
    note: 'Synthetic retained human assessment.',
  };
  await hashing.runIdempotentCommand({
    store,
    workspaceDb: workspace,
    inflightCommands: access.inflightCommands,
    command: 'evaluation.judgement-add',
    requestId: judgementInput.requestId,
    scope: { workspaceId },
    input: {
      actor,
      judgement: {
        target: {
          kind: 'artifact-version',
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          contentDigest: artifact.contentDigest,
        },
        kind: judgementInput.kind,
        choice: judgementInput.choice,
        note: judgementInput.note,
      },
    },
    responseKind: 'evaluation_judgement',
    responseId: () => judgementInput.requestId,
    execute: (receipt) => judgements.appendArtifactJudgement(access, judgementInput, receipt),
    replay: () =>
      required(
        judgements.readArtifactJudgement(access, judgementInput),
        'Retained Artifact judgement'
      ),
  });
  const secondBody = `${content}Second synthetic candidate.\n`;
  const secondDigest = `sha256:${digest(secondBody)}`;
  const second = await store.createArtifact({
    ...artifact,
    id: id('ar', 'evaluation-candidate'),
    threadId: null,
    turnId: null,
    title: 'Second synthetic candidate',
    version: 1,
    content: { format: 'text', body: secondBody },
    contentDigest: secondDigest,
    lastMutationRequestId: 'upgrade-corpus-candidate',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'upgrade-corpus-candidate',
      sourceDigest: secondDigest,
      actor,
      requestId: 'upgrade-corpus-candidate',
      recordedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const members = [artifact, second].map((entry) => ({
    artifactId: entry.id,
    artifactVersion: entry.version,
    contentDigest: entry.contentDigest,
  }));
  const candidateSet = await evaluation.createCandidateSet(access, {
    workspaceId,
    requestId: 'upgrade-corpus-candidate-set',
    candidates: members,
  });
  sql.candidateSetId = candidateSet.candidateSetId;
  await evaluation.selectCandidateSet(access, {
    workspaceId,
    candidateSetId: candidateSet.candidateSetId,
    requestId: 'upgrade-corpus-candidate-selection',
    choice: members[1],
    note: 'Synthetic retained comparison.',
  });
  const pendingFlow = await o.load('runtime/pending-request-flow');
  // New person work must not append Items to the recovered sealed Worker Turn.
  const pendingTurn = await store.createTurn(workspaceId, threadId, content, actor);
  sql.pendingRequestId = '00000000-0000-4000-8000-000000000901';
  await pendingFlow.raiseRecordedPendingRequest(store, workspace.sqlite, {
    requestId: sql.pendingRequestId,
    workspaceId,
    threadId,
    raisingTurnId: pendingTurn.id,
    requestItemId: o.pending.pendingRequestItemId(sql.pendingRequestId, 'request'),
    kind: 'approval',
    requesterKind: 'person',
    responsibleUserId: sql.userId,
    governedIntent: { operation: 'synthetic-corpus', content: 'Synthetic retained decision.' },
    approval: {
      kind: 'permission',
      title: 'Synthetic corpus',
      description: 'Retained approval fixture.',
    },
    now: pendingTurn.startedAt,
  });
  await store.createItem({
    id: o.pending.pendingRequestItemId(sql.pendingRequestId, 'request'),
    owner: turn.owner,
    threadId,
    turnId: pendingTurn.id,
    type: 'approval-request',
    approvalRequestId: sql.pendingRequestId,
    kind: 'permission',
    title: 'Synthetic corpus',
    description: 'Retained approval fixture.',
    status: 'completed',
    createdAt: pendingTurn.startedAt,
    completedAt: pendingTurn.startedAt,
  });
  await seedChannelEvidence(o, core, workspace, sql, {
    workspaceId,
    threadId,
    turnId: pendingTurn.id,
  });
  const presentation = await o.ui.publishGenerativePresentation(
    {
      store,
      inflightCommands: new WeakMap(),
      dataRoot: workspace.dataRoot,
      workspaceId,
      actor,
      workspaceDb: workspace,
      requestId: '00000000-0000-4000-8000-000000000905',
    },
    {
      threadId,
      turnId: pendingTurn.id,
      title: 'Synthetic continuity',
      fallbackText: content,
      source: { kind: 'answer', text: content },
      actions: [],
      messages: [
        {
          version: 'v0.9',
          createSurface: {
            surfaceId: 'upgrade-corpus',
            catalogId: 'urn:openkit:a2ui:catalog:native:v1',
            sendDataModel: false,
          },
        },
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'upgrade-corpus',
            components: [{ id: 'root', component: 'Text', text: { path: '/text' } }],
          },
        },
      ],
    }
  );
  sql.presentationId = presentation.id;
  await store.completeTurn(pendingTurn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const workspaceRoot = join(workspace.dataRoot, 'workspaces', workspaceId);
  const authorities = contextAuthorities.createWorkerContextPackageAuthorityReader({
    coreDb: core,
    workspaceDb: workspace,
    store,
  });
  // The native executor already accepted this exact handoff and trace before the process cut.
  const trace = context.readWorkerContextPackageTrace({
    authorities,
    workspaceId,
    threadId,
    turnId: turn.id,
    workspaceRoot,
  });
  sql.aepSnapshotPath = relative(
    workspace.dataRoot,
    join(
      workspaceRoot,
      'runtime',
      'agent-sessions',
      sql.contextAgentSessionId,
      'aep-snapshots',
      `${sql.aepSnapshotId}.json`
    )
  );
  sql.contextTracePath = relative(
    workspace.dataRoot,
    join(workspaceRoot, 'threads', threadId, 'turns', turn.id, 'context-package.json')
  );
  sql.contextFilePaths = trace.fileInventory.map((file) =>
    relative(
      workspace.dataRoot,
      join(workspaceRoot, 'threads', threadId, 'turns', turn.id, 'context-package', file.path)
    )
  );
  const lineage = {
    agentSessionId: sql.contextAgentSessionId,
    packageSnapshotId: sql.aepSnapshotId,
    requestId,
    workspaceId,
    threadId,
    turnId: turn.id,
  };
  const captureRoot = join(retainedRoot, 'synthetic-runtime-capture');
  writeSqlContextCapture(environmentPackage, captureRoot);
  const imported = await provenance.importWorkerRuntimeProvenance({
    backend: { kind: 'openshell', placement: 'local', version: 'synthetic' },
    collectedAt: NOW,
    environmentPackage,
    workspaceDb: workspace,
    workspaceRoot,
    capture: {
      streamManifestPath: join(captureRoot, 'raw-streams.json'),
      nativeOriginIndexPath: join(captureRoot, 'native-origin-index.jsonl'),
      rawStreamsRoot: captureRoot,
    },
  });
  if (!imported.complete) throw new Error('Synthetic runtime provenance failed product admission.');
  sql.rawProvenanceBundleId = imported.rawBundleId;
  sql.provenanceIndexBundleId = imported.indexBundleId;
  sql.provenanceRuntimeEvidenceId = imported.runtimeEvidenceId;
  sql.evidenceBundleId = imported.indexBundleId;
  sql.runtimeEvidenceId = imported.runtimeEvidenceId;
  sql.provenancePaths = [
    'raw-streams.json',
    'native-origin-index.jsonl',
    'raw/stream-0000.jsonl',
  ].map((path) =>
    relative(
      workspace.dataRoot,
      join(workspaceRoot, 'evidence', 'backend', imported.rawBundleId, path)
    )
  );
  sql.provenanceIndexPath = relative(
    workspace.dataRoot,
    join(workspaceRoot, 'evidence', 'bundles', imported.indexBundleId, 'runtime-origin-index.jsonl')
  );
  const goal = o.goals.readGoalView(store, workspace, sql.goalId);
  await o.goals.executeGoalOperation(
    'goal.cancel',
    {
      workspaceId,
      threadId,
      goalId: sql.goalId,
      requestId: '00000000-0000-4000-8000-000000000906',
      expectedRevision: goal.goal.changeRevision,
      reason: 'Synthetic retained history; no work is requested.',
    },
    { actor: { kind: 'local', userId: sql.userId } },
    store,
    workspace
  );
  await pendingFlow.archiveThreadWithCloseout(
    store,
    {
      openWorkspace: (selectedWorkspaceId) =>
        o.db.openWorkspaceDb(workspace.dataRoot, selectedWorkspaceId),
    },
    workspaceId,
    threadId,
    actor
  );
  const body = Buffer.from('Synthetic restricted evidence body.\n');
  const observations = await o.load('storage/work-observations');
  await observations.appendWorkObservation(workspace, {
    threadId,
    turnId: turn.id,
    // The selected revision's reader maps this historical fixture to its own strict writer name.
    observation: observations.parseWorkObservationRecord({
      v: 1,
      seq: 1,
      turnId: turn.id,
      id: 'upgrade-corpus-model',
      type: 'model.observed',
      ts: NOW,
      obs: 'gateway',
      ret: 'turn-evidence',
      payload: {
        attempt: 0,
        direction: 'response',
        event: 'text_end',
        runtimeOriginRef: null,
        content: { state: 'expected' },
      },
    }),
    bodies: [
      { id: 'response', bytes: body, mediaType: 'text/plain', boundary: 'synthetic-model-output' },
    ],
  });
  sql.restrictedBody = {
    bundleId: o.evidence.workObservationBodyBundleId(
      workspaceId,
      threadId,
      turn.id,
      'upgrade-corpus-model',
      'response'
    ),
    threadId,
    turnId: turn.id,
    createdAt: NOW,
    sha256: digest(body),
  };
  sql.restrictedBodyPath = relative(
    workspace.dataRoot,
    join(workspaceRoot, 'evidence', 'backend', sql.restrictedBody.bundleId, 'raw', 'content')
  );
  const tools = [{ name: 'synthetic_inspect', inputSchema: { type: 'object', properties: {} } }];
  sql.mcpSchemaSnapshotId = 'mcp_upgrade-corpus';
  o.mcp.importMcpToolSchemaSnapshots(workspace, [
    {
      capturedAt: NOW,
      catalogEntryId: 'synthetic-mcp',
      contentDigest: o.mcp.mcpToolSchemaContentDigest(tools),
      schemaSnapshotId: sql.mcpSchemaSnapshotId,
      serverVersion: 'synthetic',
      source: 'aep',
      sourceRef: null,
      tools,
      workspaceId,
    },
  ]);
}

/** Reopens linked file owners and checks exact original bytes before returning safe facts. */
async function readLinkedEvidence(o, core, workspace, store, sql) {
  const [aep, context, contextAuthorities, provenance] = await Promise.all(
    [
      'runtime/aep-snapshot-ledger',
      'context/worker-context-package',
      'context/worker-context-authorities',
      'runtime/worker-runtime-provenance',
    ].map(o.load)
  );
  const [recovery, journal, terminal] = await Promise.all([
    o.load('runtime/worker-recovery'),
    o.load('runtime/execution-journal'),
    o.load('runtime/worker-turn-failure'),
  ]);
  const dataRoot = workspace.dataRoot;
  const workspaceId = workspace.workspaceId;
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const snapshot = aep.requireAgentEnvironmentPackageSnapshot(
    workspace,
    workspaceId,
    sql.aepSnapshotId
  );
  const authorities = contextAuthorities.createWorkerContextPackageAuthorityReader({
    coreDb: core,
    workspaceDb: workspace,
    store,
  });
  const trace = context.readWorkerContextPackageTrace({
    authorities,
    workspaceId,
    threadId: sql.goalThreadId,
    turnId: sql.contextTurnId,
    workspaceRoot,
  });
  const { scope } = snapshot.snapshot;
  const { checkpoint, attempt: original } = sql.contextStopped;
  required(checkpoint, 'Original native Task checkpoint');
  assert.equal(checkpoint.turnId, scope.turnId);
  const attempt = o.attempts.requireSchedulerExecutionAttempt(core, original.attemptId);
  assert.equal(attempt.turnId, scope.turnId);
  const lineage = { ...scope, packageSnapshotId: snapshot.snapshotId };
  const final = o.control.getWorkerControlAcceptedFinalStatus(core, lineage);
  required(final, 'Task final');
  assert.equal(
    recovery.recoverWorkerCheckpointStopReason(core, store, workspace, checkpoint),
    o.control.canonicalStopReasonForAcceptedWorkerFinalStatus(final, attempt.terminalCause)
  );
  const commandScope = { actorId: sql.userId, workspaceId, threadId: scope.threadId };
  const key = o.store.commandRequestKey('task.start', scope.requestId, commandScope);
  const receipts = o.commands.readCommandRequestRecordsFromSqlite(workspace.sqlite);
  const command = receipts.find((record) => record.key === key);
  required(command, 'Task receipt');
  assert.equal(command.inputHash, checkpoint.requestInputHash);
  assert.deepEqual(command.response, { kind: 'turn', id: scope.turnId });
  assert.deepEqual(command.scope, commandScope);
  const { execution } = await terminal.workerTurnTerminalPublication(
    workspace,
    scope.turnId,
    'failed'
  );
  const ref = { owner: { kind: 'workspace', workspaceId }, executionId: execution.executionId };
  const reader = journal.createExecutionStepJournalReader(workspace, ref.owner);
  const root = await reader.readExecution(ref);
  assert.equal(root.phase, 'closed', 'Original Task execution is not closed.');
  assert.deepEqual(root.openSteps, []);
  assert.deepEqual(root.exclusionRefs, []);
  const steps = await reader.readEndedSteps(ref);
  // Synchronization owns separate collection responsibilities; a kind is not one fixed invocation.
  assert.ok(
    steps.some((step) => step.control.kind === 'collect'),
    'Original Task lacks collection.'
  );
  assert.deepEqual(
    steps
      .filter((step) => step.control.kind !== 'collect')
      .map((step) => step.control.kind)
      .sort(),
    ['inspect-cleanup', 'materialize', 'release', 'terminal-publication']
  );
  for (const step of steps) {
    assert.equal(step.state, 'completed', 'Original Task has an incomplete obligation.');
    assert.equal(step.control.attemptId, attempt.attemptId);
  }
  assert.deepEqual(
    steps.find((step) => step.control.kind === 'release').control.outputRefs,
    [attempt.fenceRef],
    'Original Task release fence contradicts its accepted attempt.'
  );
  assert.equal(
    o.checkpoints.getWorkerCheckpoint(workspace, workspaceId, scope.threadId, scope.turnId),
    null,
    'The completed original Task checkpoint was not collected.'
  );
  const body = required(
    o.evidence.readWorkObservationBody(workspace, sql.restrictedBody),
    'Restricted evidence bytes'
  );
  const evidence = o.evidence.listStoredWorkspaceEvidenceBundles(workspace, workspaceId);
  const rawBundle = required(
    evidence.find((row) => row.id === sql.rawProvenanceBundleId),
    'Runtime provenance original manifest'
  );
  const indexBundle = required(
    evidence.find((row) => row.id === sql.provenanceIndexBundleId),
    'Runtime provenance normalized index'
  );
  const rawBytes = sql.provenancePaths.map((path) => fileBytes(dataRoot, join(dataRoot, path)));
  for (const bytes of rawBytes) {
    if (!rawBundle.contentDigests.includes(`sha256:${bytes.sha256}`)) {
      throw new Error('Runtime provenance original digest does not match its EvidenceBundle.');
    }
  }
  const indexBytes = fileBytes(dataRoot, join(dataRoot, sql.provenanceIndexPath));
  if (!indexBundle.contentDigests.includes(`sha256:${indexBytes.sha256}`)) {
    throw new Error(
      'Runtime provenance normalized index digest does not match its EvidenceBundle.'
    );
  }
  const workerProtocol = await o.loadPackage('@openkit/worker-protocol');
  const manifest = workerProtocol.WorkerRuntimeRawStreamManifestReaderSchema.parse(
    JSON.parse(readFileSync(join(dataRoot, sql.provenancePaths[0]), 'utf8'))
  );
  const nativeEntries = readFileSync(join(dataRoot, sql.provenancePaths[1]), 'utf8')
    .trim()
    .split('\n')
    .map((line) =>
      workerProtocol.WorkerRuntimeNativeOriginIndexEntryReaderSchema.parse(JSON.parse(line))
    );
  if (manifest.streams.length !== 1 || manifest.streams[0].frameCount !== nativeEntries.length) {
    throw new Error('Runtime provenance manifest and native index disagree.');
  }
  const normalized = readFileSync(join(dataRoot, sql.provenanceIndexPath), 'utf8')
    .trim()
    .split('\n')
    .map((line) => provenance.WorkerRuntimeOriginIndexRowSchema.parse(JSON.parse(line)));
  const observations = await o.load('storage/work-observations');
  const workObservations = observations.readWorkObservations(workspace, {
    threadId: sql.goalThreadId,
    turnId: sql.contextTurnId,
  });
  const observationRecord = workspace.sqlite.prepare(
    'SELECT CAST(record_json AS BLOB) AS bytes FROM control_work_observations WHERE turn_id=? AND id=?'
  );
  const observationBytes = workObservations.map(({ id }) => {
    const { bytes } = observationRecord.get(sql.contextTurnId, id);
    return {
      path: `sqlite/workspace/${workspaceId}/control_work_observations/${id}`,
      byteLength: bytes.length,
      sha256: digest(bytes),
    };
  });
  return {
    closedContext: [attempt, command, final],
    observationBytes,
    manifest,
    nativeEntryCount: nativeEntries.length,
    workObservations,
    snapshot,
    trace,
    body: { sha256: digest(body), byteLength: body.length },
    rawBundle,
    indexBundle,
    normalized,
    rawBytes,
    indexBytes,
  };
}

/** Reads every selected SQL record with the selected revision's product reader. */
export async function readSqlCorpus({ appRoot, dataRoot, selectors }) {
  const o = await owners(appRoot);
  const { workspaceId, threadId, turnId, sql } = selectors;
  const core = o.db.openCoreDb(dataRoot);
  const user = o.db.openUserDb(dataRoot, sql.userId);
  const workspace = o.db.openWorkspaceDb(dataRoot, workspaceId);
  let app;
  try {
    const store = new o.store.FsStore({ dataRoot });
    app = o.appDb.openExistingAppDb(dataRoot, workspaceId, sql.lightAppId);
    const one = (family, values, bytes = []) => ({
      values: values.map((value) => required(value, family)),
      bytes,
    });
    const audit = o.audit.listServerAuditEvents(core);
    const userAudit = o.audit.listSqliteAuditEvents(user.sqlite);
    const workspaceAudit = o.audit.listWorkspaceAuditEvents(workspace, workspaceId);
    const appRootPath = o.appDb.lightAppRoot(dataRoot, workspaceId, sql.lightAppId);
    const snapshot = o.snapshots.readLightAppSnapshot(
      dataRoot,
      workspaceId,
      sql.lightAppId,
      sql.lightAppSnapshotId
    );
    const metadata = o.kernel.getLightApp(dataRoot, workspaceId, sql.lightAppId);
    // App receipts belong to the admitted native Kernel format, not the Core SQL row format.
    // Read at each receipt's creation time so this inventory neither expires nor prunes history.
    const appReceipts = app.sqlite
      .prepare('SELECT request_key AS key, created_at AS createdAt FROM idempotency_requests')
      .all()
      .map(({ key, createdAt }) =>
        required(
          o.commands.getCommandRequestRecordFromDb(app, key, createdAt),
          'Light App command receipt'
        )
      );
    const receipt = (handle, key) => {
      const retained = o.commands
        .readCommandRequestRecordsFromSqlite(handle.sqlite)
        .find((row) => row.key === key);
      assert.deepEqual(
        retained,
        Object.values(sql.receipts).find((row) => row.key === key)
      );
      return retained;
    };
    const linked = await readLinkedEvidence(o, core, workspace, store, sql);
    const evaluation = await o.load('evaluation-candidates');
    const candidateSet = evaluation.readCandidateSet(
      {
        coreDb: core,
        workspaceDb: workspace,
        store,
        actor: { kind: 'session', userId: sql.userId },
      },
      sql.candidateSetId
    );
    const artifactReview = o.reviews.getArtifactReview(
      workspace,
      sql.artifactId,
      sql.artifactVersion
    );
    const pending = required(
      o.pending.readPendingRequest(workspace.sqlite, sql.pendingRequestId),
      SQL_CORPUS_FAMILIES[12]
    );
    const pendingFailure = o.pending.validateCanonicalLoad(
      pending,
      store.listThreadTurns(workspaceId, sql.goalThreadId),
      o.commands.readCommandRequestRecordsFromSqlite(workspace.sqlite)
    );
    if (pendingFailure)
      throw new Error(`Pending request fixture is contradictory: ${pendingFailure.reason}.`);

    const token = required(
      o.tokens.listOpenKitAccessTokenRecords(core).find((row) => row.tokenId === sql.tokenId),
      SQL_CORPUS_FAMILIES[0]
    );
    const tokenHash = core.sqlite
      .prepare('SELECT token_hash FROM openkit_access_tokens WHERE token_id = ?')
      .pluck()
      .get(sql.tokenId);
    for (const { scope, hashes } of sql.journals) {
      const handle =
        scope === 'core' ? core : scope === 'user' ? user : scope === 'workspace' ? workspace : app;
      const currentHashes = handle.sqlite
        .prepare('SELECT hash FROM __drizzle_migrations')
        .all()
        .map((row) => row.hash);
      if (hashes.length === 0 || hashes.some((hash) => !currentHashes.includes(hash))) {
        throw new Error('Native migration journals: selected retained entry is missing.');
      }
    }
    // These private channel rows have no exported record reader. Select only the native owner's known columns.
    const discordReceipt =
      core.sqlite.prepare(`SELECT event_id,payload_digest,request_id,state,created_at,
      discord_user_id,core_user_id,binding_revision,operation_id,workspace_id,thread_id,pending_request_id,turn_id
      FROM discord_inbound_receipts WHERE event_id = ?`);
    return {
      [SQL_CORPUS_FAMILIES[0]]: one(SQL_CORPUS_FAMILIES[0], [
        token,
        { tokenHashDigest: digest(tokenHash) },
        {
          relation: required(
            o.membership.resolveWorkspaceMembershipRelation(core, workspaceId, sql.userId),
            SQL_CORPUS_FAMILIES[0]
          ),
        },
      ]),
      [SQL_CORPUS_FAMILIES[1]]: one(SQL_CORPUS_FAMILIES[1], [
        {
          defaultTokenId: required(
            o.tokens.resolveSessionDeploymentAdminTokenId(core, sql.userId),
            SQL_CORPUS_FAMILIES[1]
          ),
        },
      ]),
      [SQL_CORPUS_FAMILIES[2]]: one(SQL_CORPUS_FAMILIES[2], [
        o.decisions
          .listServerPermissionDecisions(core)
          .find((row) => row.decisionId === sql.serverDecisionId),
      ]),
      [SQL_CORPUS_FAMILIES[3]]: one(SQL_CORPUS_FAMILIES[3], [
        audit.find((row) => row.id === sql.serverAuditId),
        core.sqlite.prepare('SELECT * FROM boot_audit_events WHERE boot_id = ?').get(sql.bootId),
      ]),
      [SQL_CORPUS_FAMILIES[4]]: one(SQL_CORPUS_FAMILIES[4], [
        o.references.getVaultReference(core, sql.vaultReferenceId),
        o.grants.getVaultGrant(core, sql.vaultGrantId),
        o.plans.getVaultInjectionPlan(core, sql.injectionPlanId),
        o.receipts.getVaultInjectionReceipt(core, sql.injectionReceiptId),
        o.uses.getVaultUseRecord(core, sql.serverVaultUseId),
      ]),
      [SQL_CORPUS_FAMILIES[5]]: one(SQL_CORPUS_FAMILIES[5], [
        o.scheduler.requireSchedulerAdmissionEntry(core, sql.queueEntryId),
        o.attempts.requireSchedulerExecutionAttempt(core, sql.attemptId),
        new o.recurring.AutomationStore(
          core,
          new o.admission.WorkspaceMutationAdmission()
        ).getAutomation(sql.automationId),
        o.externalEvents.findExternalTriggerAdmission(core, sql.automationId, sql.externalEventKey),
      ]),
      [SQL_CORPUS_FAMILIES[6]]: one(SQL_CORPUS_FAMILIES[6], [
        retainedRuntimeTarget(o.targets.getNanoHostRuntimeTarget(core, sql.runtimeTargetId)),
        o.bindings.getWorkerStorageBinding(core, { storageRef: sql.storageRef }),
        o.backend.getWorkerBackendSession(core, sql.attemptId),
        o.control.listWorkerControlAcceptedEvents(core, {
          workspaceId,
          threadId,
          turnId,
          agentSessionId: sql.agentSessionId,
          packageSnapshotId: 'aepsnap_upgrade-corpus',
          requestId: 'upgrade-corpus-worker',
        }),
      ]),
      [SQL_CORPUS_FAMILIES[7]]: one(SQL_CORPUS_FAMILIES[7], [receipt(core, sql.receiptKeys.core)]),
      [SQL_CORPUS_FAMILIES[8]]: one(SQL_CORPUS_FAMILIES[8], [
        receipt(user, sql.receiptKeys.user),
        o.reads.readThreadReadReceipt(user, workspaceId, threadId),
      ]),
      [SQL_CORPUS_FAMILIES[9]]: one(SQL_CORPUS_FAMILIES[9], [
        userAudit.find((row) => row.id === sql.userAuditId),
      ]),
      [SQL_CORPUS_FAMILIES[10]]: one(SQL_CORPUS_FAMILIES[10], [
        o.decisions
          .listExportableWorkspacePermissionDecisions(workspace, workspaceId)
          .find((row) => row.decisionId === sql.workspaceDecisionId),
        workspaceAudit.find((row) => row.id === sql.workspaceAuditId),
        o.uses.getVaultUseRecord(workspace, sql.workspaceVaultUseId),
      ]),
      [SQL_CORPUS_FAMILIES[11]]: one(SQL_CORPUS_FAMILIES[11], [
        o.usage
          .listWorkspaceCapabilityCalls(workspace, workspaceId)
          .find((row) => row.id === sql.capabilityCallId),
        o.usage
          .listWorkspaceUsageRecords(workspace, workspaceId)
          .filter((row) => row.capabilityCallId === sql.capabilityCallId),
      ]),
      [SQL_CORPUS_FAMILIES[12]]: one(SQL_CORPUS_FAMILIES[12], [
        pending,
        receipt(workspace, sql.receiptKeys.workspace),
        ...linked.closedContext,
      ]),
      [SQL_CORPUS_FAMILIES[13]]: one(SQL_CORPUS_FAMILIES[13], [
        o.materials.getWorkspaceMaterial(workspace, sql.materialId),
        o.materials.getWorkspaceMaterialRevision(workspace, sql.materialId, sql.materialRevisionId),
        o.materials.getThreadMaterial(workspace, threadId, sql.materialId),
      ]),
      [SQL_CORPUS_FAMILIES[14]]: one(SQL_CORPUS_FAMILIES[14], [
        o.reviews.getArtifactReview(workspace, sql.artifactId, sql.artifactVersion),
      ]),
      [SQL_CORPUS_FAMILIES[15]]: one(SQL_CORPUS_FAMILIES[15], [
        o.goals.readGoalView(store, workspace, sql.goalId),
      ]),
      [SQL_CORPUS_FAMILIES[16]]: one(SQL_CORPUS_FAMILIES[16], [
        o.evidence
          .listStoredWorkspaceEvidenceBundles(workspace, workspaceId)
          .find((row) => row.id === sql.evidenceBundleId),
        o.runtimeEvidence
          .listWorkspaceRuntimeEvidence(workspace, workspaceId)
          .find((row) => row.id === sql.runtimeEvidenceId),
      ]),
      [SQL_CORPUS_FAMILIES[17]]: one(SQL_CORPUS_FAMILIES[17], [
        o.setup.requireResolvedAgentSetup(workspace, workspaceId, sql.setupId),
        o.mcp
          .listExportableMcpToolSchemaSnapshots(workspace, workspaceId)
          .find((row) => row.schemaSnapshotId === sql.mcpSchemaSnapshotId),
      ]),
      [SQL_CORPUS_FAMILIES[18]]: one(SQL_CORPUS_FAMILIES[18], [
        o.sync
          .listWorkspaceInputSnapshots(workspace, workspaceId)
          .find((row) => row.id === sql.syncSnapshotId),
      ]),
      [SQL_CORPUS_FAMILIES[19]]: one(SQL_CORPUS_FAMILIES[19], [
        o.ui.getGenerativePresentation(
          {
            store,
            dataRoot,
            workspaceId,
            workspaceDb: workspace,
            actor: { kind: 'user', id: sql.userId },
          },
          sql.presentationId
        ),
      ]),
      [SQL_CORPUS_FAMILIES[20]]: one(SQL_CORPUS_FAMILIES[20], [
        metadata,
        o.kernel.getRecord(
          dataRoot,
          workspaceId,
          sql.lightAppId,
          'notes',
          sql.lightAppRecordId,
          metadata.schemaRevision
        ),
        o.audit.listSqliteAuditEvents(app.sqlite, workspaceId),
        appReceipts,
      ]),
      [SQL_CORPUS_FAMILIES[21]]: one(
        SQL_CORPUS_FAMILIES[21],
        [{ definitionVersion: metadata.definitionVersion }],
        [
          fileBytes(
            dataRoot,
            join(
              appRootPath,
              'definitions',
              `${metadata.definitionVersion.replace('sha256:', '')}.json`
            )
          ),
        ]
      ),
      [SQL_CORPUS_FAMILIES[22]]: one(
        SQL_CORPUS_FAMILIES[22],
        [snapshot.metadata],
        [
          fileBytes(dataRoot, join(dataRoot, sql.lightAppSnapshotPath)),
          fileBytes(dataRoot, join(appRootPath, 'snapshots', `${sql.lightAppSnapshotId}.json`)),
        ]
      ),
      [SQL_CORPUS_FAMILIES[23]]: one(
        SQL_CORPUS_FAMILIES[23],
        sql.journals.map(({ scope, hashes }) => ({
          scope,
          entries: (scope === 'core'
            ? core
            : scope === 'user'
              ? user
              : scope === 'workspace'
                ? workspace
                : app
          ).sqlite
            .prepare('SELECT * FROM __drizzle_migrations ORDER BY id')
            .all()
            .filter((row) => hashes.includes(row.hash)),
        }))
      ),
      [SQL_CORPUS_FAMILIES[24]]: one(
        SQL_CORPUS_FAMILIES[24],
        [
          linked.body,
          linked.rawBundle,
          linked.indexBundle,
          required(linked.normalized, 'Runtime provenance normalized index'),
        ],
        [
          fileBytes(dataRoot, join(dataRoot, sql.restrictedBodyPath)),
          ...linked.rawBytes,
          linked.indexBytes,
        ]
      ),
      [SQL_CORPUS_FAMILIES[25]]: one(
        SQL_CORPUS_FAMILIES[25],
        [linked.snapshot],
        [fileBytes(dataRoot, join(dataRoot, sql.aepSnapshotPath))]
      ),
      [SQL_CORPUS_FAMILIES[26]]: one(
        SQL_CORPUS_FAMILIES[26],
        [linked.trace],
        [fileBytes(dataRoot, join(dataRoot, sql.contextTracePath))]
      ),
      [SQL_CORPUS_FAMILIES[27]]: one(
        SQL_CORPUS_FAMILIES[27],
        [linked.trace.fileInventory],
        sql.contextFilePaths.map((path) => fileBytes(dataRoot, join(dataRoot, path)))
      ),
      [SQL_CORPUS_FAMILIES[28]]: one(
        SQL_CORPUS_FAMILIES[28],
        // Compare observer meaning across revisions; the separate byte digest still covers the original ledger.
        [
          required(linked.workObservations, 'Work observation log').map((row) => ({
            ...row,
            obs:
              row.obs === 'core'
                ? 'nanocore'
                : row.obs === 'gateway'
                  ? 'llm-gateway'
                  : row.obs === 'sidecar'
                    ? 'worker-shim'
                    : row.obs,
          })),
        ],
        linked.observationBytes
      ),
      [SQL_CORPUS_FAMILIES[29]]: one(
        SQL_CORPUS_FAMILIES[29],
        [
          linked.rawBundle,
          linked.indexBundle,
          { manifest: linked.manifest, nativeEntryCount: linked.nativeEntryCount },
          required(linked.normalized, 'Runtime provenance and admitted raw streams'),
        ],
        [...linked.rawBytes, linked.indexBytes]
      ),
      [SQL_CORPUS_FAMILIES[30]]: one(SQL_CORPUS_FAMILIES[30], [
        new o.attention.AttentionNotifications(core.sqlite).get(sql.attentionId),
      ]),
      [SQL_CORPUS_FAMILIES[31]]: one(SQL_CORPUS_FAMILIES[31], [
        o.discord.readDiscordAccountBinding(core.sqlite, sql.userId),
        core.sqlite
          .prepare(`SELECT digest,user_id,expires_at,consumed_at
          FROM discord_pairing_challenges WHERE digest = ?`)
          .get(sql.discordChallengeDigest),
        core.sqlite
          .prepare(`SELECT token_digest,discord_user_id,binding_revision,workspace_id,thread_id,
          pending_request_id,kind,content_digest,expires_at FROM discord_disclosures WHERE token_digest = ?`)
          .get(sql.discordDisclosureDigest),
        discordReceipt.get(sql.discordPairEventId),
        discordReceipt.get(sql.discordInspectEventId),
      ]),
      [SQL_CORPUS_FAMILIES[32]]: one(SQL_CORPUS_FAMILIES[32], [
        ...artifactReview.judgements,
        ...candidateSet.judgements,
      ]),
      [SQL_CORPUS_FAMILIES[33]]: one(
        SQL_CORPUS_FAMILIES[33],
        [candidateSet],
        candidateSet.candidates.flatMap((candidate) => {
          const root = join(
            dataRoot,
            'workspaces',
            workspaceId,
            'artifacts',
            candidate.artifactId,
            'versions',
            String(candidate.artifactVersion)
          );
          return [
            fileBytes(dataRoot, join(root, 'version-record.json')),
            fileBytes(dataRoot, join(root, 'payload')),
          ];
        })
      ),
    };
  } finally {
    app?.sqlite.close();
    workspace.sqlite.close();
    user.sqlite.close();
    core.sqlite.close();
  }
}
