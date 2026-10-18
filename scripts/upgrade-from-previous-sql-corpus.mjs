import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  'Scheduler queue, attempts and recurring history',
  'Runtime targets and binding/control graph',
  'Core command receipts',
  'User command and Thread read receipts',
  'User Audit and notebook admission',
  'Workspace permission, Audit and Vault use',
  'Workspace capability calls and Usage',
  'Pending Requests, Workspace receipts and Worker checkpoints',
  'Material content, revisions and Thread bindings',
  'Artifact Review decisions, range feedback, independent candidate choices and apply lineage',
  'Goals, cards, immutable Plans and Task facts',
  'EvidenceBundle and normalized runtime evidence metadata',
  'Resolved Agent setup and MCP Tool-schema snapshots',
  'Workspace synchronization and snapshot chain',
  'Generative UI presentations',
  'Light App metadata, business data, Audit and receipts',
  'Light App immutable definitions',
  'Light App local recovery snapshots',
  'Native migration journals',
]);

/** Loads product code only from the explicit previous or candidate package root. */
async function owners(appRoot) {
  const load = (name) => import(pathToFileURL(join(appRoot, 'dist', `${name}.js`)).href);
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
    load,
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

/** Seeds current SQLite families with the previous revision's real producers and stopped writers. */
export async function seedSqlCorpus({ appRoot, dataRoot, userId, selectors }) {
  const o = await owners(appRoot);
  const { workspaceId, threadId, turnId } = selectors;
  const core = o.db.openCoreDb(dataRoot);
  const user = o.db.openUserDb(dataRoot, userId);
  const workspace = o.db.openWorkspaceDb(dataRoot, workspaceId);
  const actor = { kind: 'user', id: userId };
  const sql = {
    userId,
    agentSessionId: id('as', 'session'),
    artifactId: selectors.artifactId ?? id('ar', 'review-artifact'),
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
    sql.queueEntryId = 'upgrade-corpus-queue';
    const entry = o.scheduler.createSchedulerAdmissionEntry(core, {
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
    sql.runtimeTargetId = 'upgrade-corpus-target';
    const target = o.targets.allocateNanoHostRuntimeTargetConnectionGeneration(core, {
      targetId: sql.runtimeTargetId,
      deploymentId: 'upgrade-corpus',
      identityId: 'upgrade-corpus',
      observedAt: NOW,
    });
    o.targets.upsertNanoHostRuntimeTarget(core, {
      ...target,
      physicalEpoch: 'a'.repeat(64),
      freshEmpty: true,
      ready: true,
      predecessorFenced: true,
      observedAt: NOW,
    });
    const binding = o.bindings.createWorkerStorageBinding(core, {
      deploymentId: 'upgrade-corpus',
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
        deploymentId: 'upgrade-corpus',
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
      observedAt: NOW,
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
    sql.pendingRequestId = '00000000-0000-4000-8000-000000000901';
    o.pending.raisePendingRequest(workspace.sqlite, {
      requestId: sql.pendingRequestId,
      workspaceId,
      threadId,
      raisingTurnId: turnId,
      requestItemId: o.pending.pendingRequestItemId(sql.pendingRequestId, 'request'),
      kind: 'approval',
      requesterKind: 'person',
      responsibleUserId: userId,
      governedIntent: { operation: 'synthetic-corpus', content: 'Synthetic retained decision.' },
      approval: {
        kind: 'permission',
        title: 'Synthetic corpus',
        description: 'Retained approval fixture.',
      },
      now: NOW,
    });
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
    const review = o.reviews.createArtifactReview(workspace, {
      artifactId: sql.artifactId,
      artifactVersion: 1,
      contentDigest: `sha256:${digest(content)}`,
      sourceThreadId: threadId,
      sourceTurnId: turnId,
      sourceAgentId: 'agent_codex_host',
      materialProposal: null,
      createdAt: NOW,
    });
    sql.reviewId = review.reviewId;
    o.reviews.decideArtifactReview(workspace, {
      actorId: userId,
      actor,
      artifactContent: content,
      artifactId: sql.artifactId,
      artifactMediaType: 'text/plain',
      artifactVersion: 1,
      decidedAt: NOW,
      decision: 'accepted',
      feedback: 'Synthetic retained acceptance.',
      requestId: 'upgrade-corpus-review',
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
    sql.evidenceBundleId = 'evb_upgrade-corpus';
    o.evidence.recordWorkspaceEvidenceBundle(workspace, {
      id: sql.evidenceBundleId,
      workspaceId,
      threadId,
      turnId,
      goalId: null,
      agentSessionId: sql.agentSessionId,
      backendType: 'openshell',
      sourceKind: 'worker-turn',
      summary: 'Synthetic retained evidence.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
      contentDigests: [`sha256:${digest('Synthetic retained evidence.\n')}`],
      retentionClass: 'turn-evidence',
      sensitivityClass: 'product-safe',
      importStatus: 'promoted',
      requiredFeatures: ['evidence.bundle.v1'],
      createdAt: NOW,
    });
    sql.runtimeEvidenceId = o.runtimeEvidence.recordWorkerRuntimeProvenanceEvidence(workspace, {
      packageSnapshotId: 'aepsnap_upgrade-corpus',
      workspaceId,
      threadId,
      turnId,
      agentSessionId: sql.agentSessionId,
      backendType: 'openshell',
      backendVersion: 'synthetic',
      placement: 'local',
      summary: 'Synthetic retained runtime evidence.',
      evidenceBundleIds: [sql.evidenceBundleId],
      contentDigests: [`sha256:${digest('Synthetic retained evidence.\n')}`],
      outcome: 'succeeded',
      collectedAt: NOW,
    }).id;
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
    const presentation = await o.ui.publishGenerativePresentation(
      {
        ...kernelContext,
        workspaceDb: workspace,
        requestId: '00000000-0000-4000-8000-000000000905',
      },
      {
        threadId,
        turnId,
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
    return { sql };
  } finally {
    workspace.sqlite.close();
    user.sqlite.close();
    core.sqlite.close();
  }
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
    const receipt = (handle, key) =>
      o.commands.readCommandRequestRecordsFromSqlite(handle.sqlite).find((row) => row.key === key);
    const token = required(
      o.tokens.listOpenKitAccessTokenRecords(core).find((row) => row.tokenId === sql.tokenId),
      SQL_CORPUS_FAMILIES[0]
    );
    const tokenHash = core.sqlite
      .prepare('SELECT token_hash FROM openkit_access_tokens WHERE token_id = ?')
      .pluck()
      .get(sql.tokenId);
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
        { defaultTokenId: o.tokens.resolveSessionDeploymentAdminTokenId(core, sql.userId) },
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
      ]),
      [SQL_CORPUS_FAMILIES[6]]: one(SQL_CORPUS_FAMILIES[6], [
        o.targets.getNanoHostRuntimeTarget(core, sql.runtimeTargetId),
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
        o.pending.readPendingRequest(workspace.sqlite, sql.pendingRequestId),
        receipt(workspace, sql.receiptKeys.workspace),
        o.checkpoints.getWorkerCheckpoint(workspace, workspaceId, threadId, turnId),
      ]),
      [SQL_CORPUS_FAMILIES[13]]: one(SQL_CORPUS_FAMILIES[13], [
        o.materials.getWorkspaceMaterial(workspace, sql.materialId),
        o.materials.getWorkspaceMaterialRevision(workspace, sql.materialId, sql.materialRevisionId),
        o.materials.getThreadMaterial(workspace, threadId, sql.materialId),
      ]),
      [SQL_CORPUS_FAMILIES[14]]: one(SQL_CORPUS_FAMILIES[14], [
        o.reviews.getArtifactReview(workspace, sql.artifactId, 1),
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
        o.commands.readCommandRequestRecordsFromSqlite(app.sqlite),
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
    };
  } finally {
    app?.sqlite.close();
    workspace.sqlite.close();
    user.sqlite.close();
    core.sqlite.close();
  }
}
