import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  'Artifact Review decisions, range feedback, independent candidate choices, judgements and apply lineage',
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
  const core = o.db.openCoreDb(dataRoot);
  const user = o.db.openUserDb(dataRoot, userId);
  const workspace = o.db.openWorkspaceDb(dataRoot, workspaceId);
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
    sql.receiptKeys = {};
    for (const [scopeName, handle, scope] of [
      ['core', core, { coreId: 'server' }],
      ['user', user, { userId }],
      ['workspace', workspace, { workspaceId }],
    ]) {
      const record = {
        key: `task.start|upgrade-corpus-${scopeName}|${scopeName}`,
        command: 'task.start',
        requestId: `upgrade-corpus-${scopeName}`,
        scope,
        inputHash: 'sha256:synthetic-corpus',
        response: { kind: 'turn', id: turnId },
        createdAt: NOW,
        expiresAt: EXPIRES,
      };
      o.commands.recordCommandRequestRecordInDb(handle, record);
      sql.receiptKeys[scopeName] = record.key;
    }
    sql.readItemId = store
      .listThreadItems(workspaceId, threadId)
      .find((item) => item.type === 'user-message')?.id;
    if (!sql.readItemId) {
      throw new Error('B01 Turn must have its real request Item before SQL corpus seeding.');
    }
    o.reads.advanceThreadReadReceipt(user, workspaceId, threadId, [sql.readItemId]);
    o.checkpoints.upsertWorkerCheckpoint(workspace, {
      workspaceId,
      threadId,
      turnId,
      requestId: 'upgrade-corpus-worker',
      requestInputHash: 'sha256:synthetic-corpus',
      stage: 'completed',
      iteration: 1,
      workerSessionId: sql.agentSessionId,
      stopReason: 'completed',
      now: () => NOW,
    });
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
    await seedLinkedEvidence(o, core, workspace, store, sql, retainedRoot);
    return { sql };
  } finally {
    workspace.sqlite.close();
    user.sqlite.close();
    core.sqlite.close();
  }
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

/** Seeds correlated AEP, Context Package, and original evidence through their product owners. */
async function seedLinkedEvidence(o, core, workspace, store, sql, retainedRoot) {
  const [
    aep,
    resolver,
    images,
    imagePreparation,
    hashing,
    context,
    contextAuthorities,
    fileAdmission,
    provenance,
    preparation,
  ] = await Promise.all(
    [
      'runtime/aep-snapshot-ledger',
      'runtime/agent-environment',
      'runtime/worker-image-settlements',
      'worker-environments/worker-environment-preparation',
      'runtime/idempotent-command',
      'context/worker-context-package',
      'context/worker-context-authorities',
      'storage/artifacts/file-admission',
      'runtime/worker-runtime-provenance',
      'runtime/nanohost-attempt-records',
    ].map(o.load)
  );
  const actor = { kind: 'user', id: sql.userId };
  const workspaceId = workspace.workspaceId;
  const threadId = sql.goalThreadId;
  const requestId = 'upgrade-corpus-context';
  const workerRequest = JSON.stringify({
    schemaVersion: 1,
    objective: 'Read the synthetic retained material.',
    acceptanceCriteria: ['Keep the synthetic content exact.'],
    contextRefs: [{ kind: 'workspace', id: workspaceId }],
    resources: [],
    expectedArtifacts: [],
    constraints: { maxContextTokens: 4096, maxWorkerIterations: 1 },
    verification: [{ kind: 'manual', description: 'Read the synthetic corpus.' }],
    reviewPolicy: {
      required: false,
      reviewers: ['human'],
      instructions: 'Synthetic fixture only.',
    },
    escalationConditions: [],
    reviewContext: null,
  });
  const turn = store.createTurn(workspaceId, threadId, workerRequest, actor, null, {
    captureCoverage: { scope: 'server', value: 'on' },
  });
  sql.contextTurnId = turn.id;
  sql.contextAgentSessionId = id('as', 'context-session');
  const requestItemId = id('it', 'context-request');
  store.createItem({
    id: requestItemId,
    workspaceId,
    threadId,
    turnId: turn.id,
    type: 'user-message',
    text: workerRequest,
    actor,
    status: 'completed',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
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
  workspace.sqlite.transaction(() =>
    judgements.appendArtifactJudgement(access, {
      requestId: 'upgrade-corpus-artifact-judgement',
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      contentDigest: artifact.contentDigest,
      kind: 'accept',
      choice: null,
      note: 'Synthetic retained human assessment.',
    })
  )();
  const secondBody = `${content}Second synthetic candidate.\n`;
  const secondDigest = `sha256:${digest(secondBody)}`;
  const second = store.createArtifact({
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
  sql.pendingRequestId = '00000000-0000-4000-8000-000000000901';
  pendingFlow.raiseRecordedPendingRequest(store, workspace.sqlite, {
    requestId: sql.pendingRequestId,
    workspaceId,
    threadId,
    raisingTurnId: turn.id,
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
    now: turn.startedAt,
  });
  store.createItem({
    id: o.pending.pendingRequestItemId(sql.pendingRequestId, 'request'),
    workspaceId,
    threadId,
    turnId: turn.id,
    type: 'approval-request',
    approvalRequestId: sql.pendingRequestId,
    kind: 'permission',
    title: 'Synthetic corpus',
    description: 'Retained approval fixture.',
    status: 'completed',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  await seedChannelEvidence(o, core, workspace, sql, { workspaceId, threadId, turnId: turn.id });
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
      turnId: turn.id,
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
  store.updateTurn(turn.id, { agentSessionId: sql.contextAgentSessionId });
  const setup = syntheticAgentSetup();
  const image = imagePreparation.materializeRuntimeImage(setup.manifest.runtime.image);
  const inputDigest = hashing.commandInputHash(image);
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
  const files = context.createWorkerContextPackageFiles({
    workspaceId,
    threadId,
    turnId: turn.id,
    workerRequestItemId: requestItemId,
    workerRequestBytes: workerRequest,
    includedItemIds: [requestItemId],
    contextBudgetTokens: 4096,
    materialSelections: [],
  });
  const unresolved = resolver.resolveAgentEnvironmentPackage({
    coreDb: core,
    captureCoverage: { scope: 'server', value: 'on' },
    agentSetup: setup,
    agentSessionId: sql.contextAgentSessionId,
    triggerActor: actor,
    backend: { kind: 'openshell' },
    requestId,
    turn: store.getTurn(workspaceId, threadId, turn.id),
    turnInput: workerRequest,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  const environmentPackage = {
    ...unresolved,
    scope: { ...unresolved.scope, itemId: requestItemId },
    workspace: {
      ...unresolved.workspace,
      inputs: [
        context.buildWorkerContextPackageWorkspaceInput({
          agentSessionId: sql.contextAgentSessionId,
          threadId,
          turnId: turn.id,
          packageRootDigest: files.packageRootDigest,
        }),
      ],
    },
  };
  sql.aepSnapshotId = aep.recordAgentEnvironmentPackageSnapshot(workspace, {
    environmentPackage,
    createdAt: turn.startedAt,
  }).snapshotId;
  store.createAgentSession({
    id: sql.contextAgentSessionId,
    workspaceId,
    threadId,
    agentId: 'agent_codex_host',
    status: 'closed',
    message: 'Synthetic retained session.',
    createdAt: turn.startedAt,
    updatedAt: turn.startedAt,
    environmentPackageSnapshotId: sql.aepSnapshotId,
    stale: true,
  });
  const entry = o.scheduler.createSchedulerAdmissionEntry(core, {
    backendId: 'nanohost',
    queueEntryId: 'upgrade-corpus-context-queue',
    requestId,
    workspaceId,
    threadId,
    turnId: turn.id,
    turnInput: workerRequest,
    requestedAgentId: 'agent_codex_host',
    triggerActor: actor,
    now: () => turn.startedAt,
  });
  const attemptId = id('attempt', 'context-attempt');
  o.attempts.createSchedulerExecutionAttempt(core, {
    entry,
    attemptId,
    preparationInput: { admission: entry },
    now: () => turn.startedAt,
  });
  o.attempts.bindSchedulerExecutionAttemptSession(core, {
    attemptId,
    agentSessionId: sql.contextAgentSessionId,
    now: () => turn.startedAt,
  });
  preparation.bindNanoHostAttemptPreparation(core, {
    attemptId,
    agentSessionId: sql.contextAgentSessionId,
    inputRef: sql.aepSnapshotId,
    bindingRef: 'upgrade-corpus-context-binding',
    sessionCompatibilityKey: 'upgrade-corpus-context',
    now: () => turn.startedAt,
  });
  const target = o.targets.getNanoHostRuntimeTarget(core, sql.runtimeTargetId);
  o.targets.upsertNanoHostRuntimeTarget(core, {
    ...target,
    physicalEpoch: 'a'.repeat(64),
    freshEmpty: true,
    ready: true,
    predecessorFenced: true,
    observedAt: new Date().toISOString(),
  });
  o.backend.recordWorkerBackendSessionMaterializing(core, {
    backendLineage: { kind: 'reference', imageRef: setup.manifest.runtime.image.ref },
    backendVersion: 'synthetic',
    sandboxBindingRef: 'upgrade-corpus-context-binding',
    identity: {
      agentSessionId: sql.contextAgentSessionId,
      backendKind: 'openshell',
      backendSessionId: 'upgrade-corpus-context-session',
      deploymentId: target.deploymentId,
      packageSnapshotId: sql.aepSnapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: 'server/runtime/worker-backend-sessions/upgrade-corpus-context',
      transientProviderInstanceId: null,
    },
    lineage: { workspaceId, threadId, turnId: turn.id },
    now: () => turn.startedAt,
  });
  const trace = context.createWorkerContextPackageTrace({
    agentSessionId: sql.contextAgentSessionId,
    packageSnapshotId: sql.aepSnapshotId,
    requestId,
    goalId: sql.goalId,
    taskId: 'task_upgrade-corpus',
    packageFiles: files,
    excludedItems: [],
  });
  const materializer = await o.load('runtime/workspace-materializer');
  const [snapshot] = materializer.buildWorkspaceInputSnapshots({
    environmentPackage,
    backendCapabilities: environmentPackage.backend.requiredCapabilities,
    backendKind: 'openshell',
    createdAt: turn.startedAt,
  });
  const [materialization] = materializer.buildWorkspaceMaterializationRecords({
    inputSnapshots: [snapshot],
    createdAt: turn.startedAt,
    materialization: {
      backendKind: 'openshell',
      backendStatus: { health: 'ready', version: 'synthetic' },
      packageSnapshotId: sql.aepSnapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      sandbox: { name: 'upgrade-corpus-context-session', state: 'created' },
      workspaceInputs: [
        {
          id: environmentPackage.workspace.inputs[0].id,
          target: environmentPackage.workspace.inputs[0].target,
        },
      ],
    },
  });
  o.sync.recordWorkspaceBackendHandoff(workspace, [snapshot], [materialization]);
  o.backend.markWorkerBackendWorkspaceHandoffComplete(core, {
    attemptId,
    now: () => turn.startedAt,
  });
  const workspaceRoot = join(workspace.dataRoot, 'workspaces', workspaceId);
  await context.writeWorkerContextPackageFiles(workspaceRoot, files, {
    admission: new fileAdmission.FileStorageAdmission(workspaceRoot, () => 0n),
  });
  const authorities = contextAuthorities.createWorkerContextPackageAuthorityReader({
    coreDb: core,
    workspaceDb: workspace,
    store,
  });
  context.writeWorkerContextPackageTrace({ authorities, trace, workspaceRoot });
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
  sql.contextFilePaths = ['package.json', ...files.fileInventory.map((file) => file.path)].map(
    (path) =>
      relative(
        workspace.dataRoot,
        join(workspaceRoot, 'threads', threadId, 'turns', turn.id, 'context-package', path)
      )
  );
  // Metadata is synthetic. No backend was called, and no physical effect needs a release fence.
  o.attempts.closeSchedulerExecutionAttemptWithoutEffects(core, {
    attemptId,
    noOutstandingEffects: true,
    cause: 'synthetic-corpus',
    now: () => turn.startedAt,
  });
  for (const [fromState, toState] of [
    ['materializing', 'cleanup-pending'],
    ['cleanup-pending', 'physical-cleaned'],
    ['physical-cleaned', 'cleaned'],
  ]) {
    o.backend.transitionWorkerBackendSessionState(core, {
      attemptId,
      fromState,
      toState,
      now: () => turn.startedAt,
    });
  }
  o.targets.recordNanoHostRuntimeTargetConnectionClose(core, {
    targetId: target.targetId,
    closedGeneration: target.connectionGeneration,
    authoritativeGeneration: null,
    observedAt: new Date().toISOString(),
  });
  store.updateTurn(turn.id, { status: 'completed', completedAt: turn.startedAt });
  const lineage = {
    agentSessionId: sql.contextAgentSessionId,
    packageSnapshotId: sql.aepSnapshotId,
    requestId,
    workspaceId,
    threadId,
    turnId: turn.id,
  };
  const nativeSessionId = '019f0000-0000-7000-8000-000000000010';
  const nativeThreadId = '019f0000-0000-7000-8000-000000000001';
  const sessionFrame = Buffer.from(
    `${JSON.stringify({
      timestamp: NOW,
      type: 'session_meta',
      payload: {
        session_id: nativeSessionId,
        id: nativeThreadId,
        timestamp: NOW,
        cwd: '/workspace/synthetic',
        originator: 'codex_exec',
        cli_version: '0.153.4',
        source: 'exec',
      },
    })}\n`
  );
  const threadFrame = Buffer.from(
    `${JSON.stringify({ type: 'thread.started', thread_id: nativeThreadId })}\n`
  );
  const raw = Buffer.concat([sessionFrame, threadFrame]);
  const nativeIndex = [
    {
      schemaVersion: 1,
      lineage,
      runtimeFamily: 'codex',
      adapterVersion: '0.153.4',
      streamRef: 'stream-0000.jsonl',
      frameSequence: 0,
      byteOffset: 0,
      byteLength: sessionFrame.length,
      frameSha256: `sha256:${digest(sessionFrame)}`,
      eventKind: 'session_meta',
      parseStatus: 'parsed',
      nativeSessionId,
      nativeThreadId,
    },
    {
      schemaVersion: 1,
      lineage,
      runtimeFamily: 'codex',
      adapterVersion: '0.153.4',
      streamRef: 'stream-0000.jsonl',
      frameSequence: 1,
      byteOffset: sessionFrame.length,
      byteLength: threadFrame.length,
      frameSha256: `sha256:${digest(threadFrame)}`,
      eventKind: 'thread.started',
      parseStatus: 'parsed',
      nativeThreadId,
    },
  ];
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
  const captureRoot = join(retainedRoot, 'synthetic-runtime-capture');
  mkdirSync(captureRoot, { recursive: true });
  writeFileSync(join(captureRoot, 'raw-streams.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(
    join(captureRoot, 'native-origin-index.jsonl'),
    `${nativeIndex.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  );
  writeFileSync(join(captureRoot, 'stream-0000.jsonl'), raw);
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
  pendingFlow.archiveThreadWithCloseout(
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
  observations.appendWorkObservation(workspace, {
    threadId,
    turnId: turn.id,
    observation: {
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
    },
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
  sql.observationsPath = relative(
    workspace.dataRoot,
    join(workspaceRoot, 'threads', threadId, 'turns', turn.id, 'observations.jsonl')
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
  return {
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
    const receipt = (handle, key) =>
      o.commands.readCommandRequestRecordsFromSqlite(handle.sqlite).find((row) => row.key === key);
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
        o.checkpoints.getWorkerCheckpoint(workspace, workspaceId, threadId, turnId),
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
        [required(linked.workObservations, 'Work observation log')],
        [fileBytes(dataRoot, join(dataRoot, sql.observationsPath))]
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
