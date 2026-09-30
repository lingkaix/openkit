import type { OpenKitConfig } from '@openkit/config-schema';
import { resolveWorkspaceMcpServer, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { RequestIdSchema } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  finishCapabilityCall,
  recordUsage,
  type StartedCapabilityCall,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import {
  readPolicyApprovalDecision,
  recordProductPermissionDecision,
} from '../policy/permission-decisions.js';
import {
  currentGitPushCredentialGrant,
  executeRepositoryPush,
  type RepositoryPushContext,
  resolveGitPushCredentialEnv,
} from '../repository-routes.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { getVaultGrant } from '../vault/vault-grants.js';
import { getVaultReference } from '../vault/vault-references.js';
import {
  assertCurrentMcpVaultAuthority,
  completeMcpVaultInjections,
  type PendingMcpVaultInjection,
  resolveWorkerMcpCredentials,
} from '../worker-mcp-routes.js';
import { getWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { evaluateGitPushLinkage } from './git-push-linkage.js';
import { evaluateGitPushPolicy } from './git-push-policy.js';
import { inspectGitPushRepository } from './git-push-repository.js';
import type { InflightIdempotentCommand } from './idempotent-command.js';
import { readCurrentMcpToolSchemaSnapshot } from './mcp-tool-schema-snapshots.js';
import {
  OPENKIT_REPOSITORY_CATALOG_DIGEST,
  OPENKIT_REPOSITORY_MCP_ID,
} from './openkit-repository-mcp.js';
import {
  executionCallIdForRequest,
  PendingRequestCommandError,
  type PendingRequestRecord,
} from './pending-requests.js';
import {
  type WorkerMcpGateway,
  WorkerMcpGatewayCallError,
  type WorkerMcpGatewayCredentials,
} from './worker-mcp-gateway.js';

/** Gateway-private material resolved before the grant's synchronous authority step. */
export interface PreparedCapturedPendingCall {
  readonly credentials?: WorkerMcpGatewayCredentials | undefined;
  readonly gitEnv?: NodeJS.ProcessEnv;
  readonly actor?: Actor;
  readonly grants: readonly {
    readonly id: string;
    readonly version: number;
    readonly referenceId: string;
  }[];
  readonly failed: boolean;
  readonly injections?: readonly PendingMcpVaultInjection[];
}

/** Resolves credential material through the existing audited MCP Vault owner before a claim. */
export async function prepareCapturedPendingCall(input: {
  readonly actor?: Actor;
  readonly record: PendingRequestRecord;
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly coreDb: CoreDb | undefined;
  readonly vaultBackend: (() => VaultBackend) | undefined;
  readonly workerMcpGateway: WorkerMcpGateway;
  readonly workspaceDb: WorkspaceDb;
}): Promise<PreparedCapturedPendingCall> {
  const record = input.record;
  if (!record.serverId) return { grants: [], failed: false };
  if (record.serverId === OPENKIT_REPOSITORY_MCP_ID) {
    try {
      const intent = parseRepositoryIntent(record.canonicalArgumentsJson);
      const repository = intent
        ? getWorkspaceRepositoryResource(input.workspaceDb, record.workspaceId, intent.resourceId)
        : null;
      if (!repository || !input.actor || !input.coreDb) return { grants: [], failed: true };
      const gitEnv = resolveGitPushCredentialEnv({
        actorId: record.responsibleUserId,
        authority: { kind: 'request', actor: input.actor },
        capabilityCallId: executionCallIdForRequest(record.requestId),
        coreDb: input.coreDb,
        repository,
        vaultBackend: input.vaultBackend,
        workspaceDb: input.workspaceDb,
        workspaceId: record.workspaceId,
      });
      const grant = repository.git.vaultGrantRef
        ? getVaultGrant(input.coreDb, repository.git.vaultGrantRef)
        : null;
      const reference = grant ? getVaultReference(input.coreDb, grant.vaultReferenceId) : null;
      return gitEnv && grant && reference
        ? {
            gitEnv,
            actor: input.actor,
            grants: [
              {
                id: grant.grantId,
                referenceId: reference.referenceId,
                version: reference.currentVersion,
              },
            ],
            failed: false,
          }
        : { grants: [], failed: true };
    } catch {
      return { grants: [], failed: true };
    }
  }
  try {
    if (!input.catalog) return { grants: [], failed: true };
    const resolved = resolveWorkspaceMcpServer({
      catalog: input.catalog,
      serverId: record.serverId,
    });
    const environmentPackage = {
      snapshotId: record.packageDigest ?? '',
      scope: { workspaceId: record.workspaceId, agentSessionId: record.agentSessionId ?? '' },
      agent: { agentId: record.agentId ?? '' },
    };
    const material = await resolveWorkerMcpCredentials({
      call: { id: executionCallIdForRequest(record.requestId) },
      environmentPackage,
      input: {
        ...(input.coreDb ? { coreDb: input.coreDb } : {}),
        workerMcpGateway: input.workerMcpGateway,
        ...(input.vaultBackend ? { vaultBackend: input.vaultBackend } : {}),
      },
      operation: 'mcp.call_tool',
      resolved,
      workspaceDb: input.workspaceDb,
    });
    const grants = material.injections.map(({ grant }) => {
      const reference = getVaultReference(input.coreDb!, grant.vaultReferenceId);
      if (!reference) throw new Error('Resolved Vault reference is missing.');
      return {
        id: grant.grantId,
        referenceId: reference.referenceId,
        version: reference.currentVersion,
      };
    });
    return {
      credentials: material.credentials,
      grants,
      injections: material.injections,
      failed: false,
    };
  } catch {
    return { grants: [], failed: true };
  }
}

/** Facts the grant step re-evaluates. Absent fields keep the route default. */
export interface CapturedPendingCallFacts {
  readonly membership?: boolean;
  readonly agentAuthority?: boolean;
  readonly toolInSupply: boolean;
  readonly schemaCurrent: boolean;
  readonly policyAllows: boolean;
  readonly credentialsValid: boolean;
}

/** Result of one captured execution after the claim commits. */
export interface CapturedPendingCallExecution {
  readonly disposition: 'approved-executed' | 'execution-error' | 'outcome-unknown';
  readonly reason: string | null;
  readonly result: unknown;
}

/** Records execution admission in the existing capability and permission owners inside the claim transaction. */
export function admitCapturedPendingCall(
  record: PendingRequestRecord,
  workspaceDb: WorkspaceDb,
  commandRequestId: string
): StartedCapabilityCall {
  const repository = record.serverId === OPENKIT_REPOSITORY_MCP_ID;
  const call = startCapabilityCall({
    workspaceDb,
    callId: executionCallIdForRequest(record.requestId),
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    turnId: record.raisingTurnId,
    agentId: record.agentId,
    agentSessionId: record.agentSessionId,
    packageSnapshotId: record.packageDigest,
    schemaSnapshotId: record.schemaSnapshotId,
    authorityActor: { kind: 'user', id: record.responsibleUserId },
    requestId: commandRequestId,
    family: repository ? 'network' : 'mcp',
    operation: repository ? 'git.push' : 'mcp.call_tool',
    capabilityId: repository ? 'workspace.git.push' : 'mcp.call_tool',
    itemId: repository ? record.requestItemId : null,
    providerRef: repository ? 'github' : record.serverId,
    serviceRef: repository
      ? (parseRepositoryIntent(record.canonicalArgumentsJson)?.resourceId ?? null)
      : `mcp-tool:${record.toolName}`,
    redactionClass: 'metadata-only',
    summary: 'Captured pending call execution.',
  });
  if (!call.inserted)
    throw new PendingRequestCommandError(
      'recovery_required',
      'The captured execution call already exists.',
      409
    );
  if (repository) {
    const source = readPolicyApprovalDecision(
      workspaceDb,
      record.workspaceId,
      record.requestId,
      'repo.push'
    );
    if (!source)
      throw new PendingRequestCommandError(
        'recovery_required',
        'The Git push decision is missing.',
        409
      );
    recordProductPermissionDecision({
      ...source,
      contextSummary: {
        ...(source.contextSummary as Record<string, unknown>),
        capabilityCallId: call.id,
      },
      workspaceDb,
      workspaceId: record.workspaceId,
      ownerScope: 'workspace',
      approvalId: record.requestId,
      policyEngineVersion: 'nanocore-approval-policy:v1',
      policySnapshotId: 'policy_snapshot_runtime',
      decisionId: `pd_repo_push_grant_${record.requestId}`,
      result: 'allow',
      reasonCode: 'repo_push_human_granted',
      enforcementPoint: 'approval.respond',
      auditActor: { kind: 'user', id: record.responsibleUserId },
    });
    return call;
  }
  recordProductPermissionDecision({
    workspaceDb,
    workspaceId: record.workspaceId,
    ownerScope: 'workspace',
    decisionId: `pd_pending_execution_${record.requestId}`,
    action: 'tool.use',
    approvalId: record.requestId,
    auditActor: { kind: 'user', id: record.responsibleUserId },
    subjectSummary: { responsibleUserId: record.responsibleUserId, agentId: record.agentId },
    resourceSummary: { serverId: record.serverId, toolName: record.toolName },
    contextSummary: {
      capabilityCallId: call.id,
      threadId: record.threadId,
      turnId: record.raisingTurnId,
      packageSnapshotId: record.packageDigest,
    },
    enforcementPoint: 'approval.respond',
    policyEngineVersion: 'nanocore-workspace-role-policy:v1',
    policySnapshotId: 'policy_snapshot_runtime',
    reasonCode: 'mcp_approval_grant_reauthorized',
    result: 'allow',
  });
  return call;
}

/**
 * Re-evaluates a captured call against the current catalog and schema snapshot.
 * Credential grants are read from Core. The Workspace read uses the grant transaction's connection.
 *
 * @param input Captured record and current supply.
 * @returns Supply, schema, policy, and credential facts.
 */
export function evaluateCapturedPendingCall(input: {
  readonly manifest: RuntimeConfigSnapshot['agentManifests'][number] | null;
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly coreDb: CoreDb | undefined;
  readonly record: PendingRequestRecord;
  readonly sqlite: import('better-sqlite3').Database;
  readonly prepared?: PreparedCapturedPendingCall | undefined;
  readonly selectedMcpServerIds?: readonly string[];
  readonly approvalPolicy?: OpenKitConfig['policy'];
}): CapturedPendingCallFacts {
  const { record } = input;
  const agentAuthority = input.manifest !== null && input.manifest.id === record.agentId;
  const selected =
    agentAuthority &&
    (input.selectedMcpServerIds
      ? input.selectedMcpServerIds.includes(record.serverId ?? '')
      : input.manifest!.mcp?.some((server) => server.id === record.serverId));
  const absent = {
    agentAuthority,
    toolInSupply: false,
    schemaCurrent: false,
    policyAllows: false,
    credentialsValid: false,
  };
  if (!record.serverId || !record.toolName || !record.schemaSnapshotId || !record.catalogRevision) {
    return absent;
  }
  if (record.serverId === OPENKIT_REPOSITORY_MCP_ID) {
    const current =
      record.toolName === 'repository_push' &&
      record.catalogRevision === OPENKIT_REPOSITORY_CATALOG_DIGEST &&
      record.schemaSnapshotId === OPENKIT_REPOSITORY_CATALOG_DIGEST;
    const intent = parseRepositoryIntent(record.canonicalArgumentsJson);
    const db = { sqlite: input.sqlite } as WorkspaceDb;
    const repository = intent
      ? getWorkspaceRepositoryResource(db, record.workspaceId, intent.resourceId)
      : null;
    const decision = readPolicyApprovalDecision(
      db,
      record.workspaceId,
      record.requestId,
      'repo.push'
    );
    let barriers = false;
    try {
      const bound = decision?.resourceSummary as {
        sourceRef: string;
        sourceCommit: string;
        remoteIdentity: string;
        remoteSummary: string;
        commitIds: string[];
        targetBranch: string;
      };
      const inspection =
        repository && bound
          ? inspectGitPushRepository(repository.localPath, bound.sourceRef)
          : null;
      barriers = Boolean(
        repository &&
          inspection &&
          bound &&
          inspection.sourceCommit === bound.sourceCommit &&
          inspection.remoteIdentity === bound.remoteIdentity &&
          inspection.remoteSummary === bound.remoteSummary &&
          bound.commitIds.at(-1) === bound.sourceCommit &&
          evaluateGitPushPolicy({
            git: repository.git,
            targetBranch: bound.targetBranch,
            approvalNamesProtectedTarget: true,
          }).allowed &&
          evaluateGitPushLinkage(db, {
            commitIds: bound.commitIds,
            requireReviewLinkage: repository.git.requireReviewLinkage,
            hostSessionLinkageExemption: false,
            workspaceId: record.workspaceId,
          }).allowed
      );
    } catch {
      barriers = false;
    }
    let credentialsValid = false;
    if (repository && input.prepared?.actor && input.coreDb && !input.prepared.failed) {
      const grant = currentGitPushCredentialGrant({
        actorId: record.responsibleUserId,
        authority: { kind: 'request', actor: input.prepared.actor },
        capabilityCallId: executionCallIdForRequest(record.requestId),
        coreDb: input.coreDb,
        repository,
        vaultBackend: undefined,
        workspaceDb: db,
        workspaceId: record.workspaceId,
      });
      const reference = grant ? getVaultReference(input.coreDb, grant.vaultReferenceId) : null;
      const observed = input.prepared.grants.find((candidate) => candidate.id === grant?.grantId);
      credentialsValid = Boolean(
        grant &&
          reference &&
          observed?.referenceId === reference.referenceId &&
          observed.version === reference.currentVersion
      );
    }
    return {
      agentAuthority,
      toolInSupply: Boolean(selected && current && repository),
      schemaCurrent: current,
      policyAllows:
        barriers &&
        input.approvalPolicy?.workspaceApprovalModes?.[record.workspaceId]?.['repo.push'] !==
          'auto_allow',
      credentialsValid,
    };
  }
  if (!input.catalog) return absent;
  let resolved: ReturnType<typeof resolveWorkspaceMcpServer> | null = null;
  try {
    resolved = resolveWorkspaceMcpServer({ catalog: input.catalog, serverId: record.serverId });
  } catch {
    resolved = null;
  }
  if (!resolved || resolved.catalogDigest !== record.catalogRevision) return absent;
  const allowed =
    resolved.allowedTools.includes(record.toolName) &&
    !resolved.deniedTools.includes(record.toolName);
  const snapshot = readCurrentMcpToolSchemaSnapshot({
    catalogEntryId: record.serverId,
    pinnedSchemaSnapshotId: null,
    workspaceDb: { sqlite: input.sqlite } as WorkspaceDb,
    workspaceId: record.workspaceId,
  });
  const toolPresent = Boolean(snapshot?.tools.some((tool) => tool.name === record.toolName));
  return {
    agentAuthority,
    toolInSupply: Boolean(selected && allowed && toolPresent),
    schemaCurrent: snapshot?.schemaSnapshotId === record.schemaSnapshotId,
    policyAllows: resolved.approvalRequiredTools.includes(record.toolName),
    credentialsValid:
      !input.prepared?.failed &&
      credentialsStillValid(input.coreDb, resolved.credentialBindings, record, input.prepared),
  };
}

/**
 * Executes one claimed captured call once. Repository push uses the Git owner.
 * An external MCP call uses the process gateway. A released worker lease is not required:
 * the approving responsible user is the request authority.
 *
 * @param input Claimed record and current process owners.
 * @returns Disposition recorded by the approval command.
 */
export async function executeCapturedPendingCall(input: {
  readonly actor: Actor;
  readonly approvalPolicy: OpenKitConfig['policy'] | undefined;
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly record: PendingRequestRecord;
  readonly store: FsStore;
  readonly vaultBackend: (() => VaultBackend) | undefined;
  readonly workerMcpGateway: WorkerMcpGateway;
  readonly workspaceDb: WorkspaceDb;
  readonly prepared?: PreparedCapturedPendingCall | undefined;
  readonly executionCall?: StartedCapabilityCall | undefined;
}): Promise<CapturedPendingCallExecution> {
  const { record } = input;
  if (!input.executionCall)
    return { disposition: 'outcome-unknown', reason: 'execution-admission-missing', result: null };
  if (record.serverId === OPENKIT_REPOSITORY_MCP_ID && record.toolName === 'repository_push') {
    return executeCapturedRepositoryPush(input);
  }
  if (!record.serverId || !record.toolName || !record.canonicalArgumentsJson || !input.catalog) {
    recordCapturedExecution(
      input.executionCall,
      input.workspaceDb,
      'failed',
      'binding-missing',
      false
    );
    return { disposition: 'execution-error', reason: 'binding-missing', result: null };
  }
  let resolved: ReturnType<typeof resolveWorkspaceMcpServer>;
  try {
    resolved = resolveWorkspaceMcpServer({ catalog: input.catalog, serverId: record.serverId });
  } catch {
    recordCapturedExecution(
      input.executionCall,
      input.workspaceDb,
      'failed',
      'tool-left-supply',
      false
    );
    return { disposition: 'execution-error', reason: 'tool-left-supply', result: null };
  }
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(record.canonicalArgumentsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      recordCapturedExecution(
        input.executionCall,
        input.workspaceDb,
        'failed',
        'arguments-invalid',
        false
      );
      return { disposition: 'execution-error', reason: 'arguments-invalid', result: null };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    recordCapturedExecution(
      input.executionCall,
      input.workspaceDb,
      'failed',
      'arguments-invalid',
      false
    );
    return { disposition: 'execution-error', reason: 'arguments-invalid', result: null };
  }
  try {
    const result = await input.workerMcpGateway.callTool({
      ...(input.prepared?.credentials ? { credentials: input.prepared.credentials } : {}),
      arguments: args,
      server: resolved,
      signal: AbortSignal.timeout(resolved.timeoutMs),
      toolName: record.toolName,
      workspaceId: record.workspaceId,
    });
    if (input.coreDb && input.prepared?.injections)
      completeMcpVaultInjections(input.coreDb, input.executionCall, input.prepared.injections);
    recordCapturedExecution(input.executionCall, input.workspaceDb, 'succeeded', null, true);
    return { disposition: 'approved-executed', reason: null, result };
  } catch (error) {
    const known = error instanceof WorkerMcpGatewayCallError && error.upstreamEffect !== 'unknown';
    if (input.executionCall)
      recordCapturedExecution(
        input.executionCall,
        input.workspaceDb,
        known ? 'failed' : 'unknown',
        error instanceof WorkerMcpGatewayCallError ? error.code : 'execution-unproven',
        !(error instanceof WorkerMcpGatewayCallError && error.upstreamEffect === 'not-contacted')
      );
    if (known) {
      return { disposition: 'execution-error', reason: error.code, result: null };
    }
    return { disposition: 'outcome-unknown', reason: 'execution-unproven', result: null };
  }
}

/** Settles one admitted captured call and records usage only when contact is not disproved. */
function recordCapturedExecution(
  call: StartedCapabilityCall,
  workspaceDb: WorkspaceDb,
  status: 'succeeded' | 'failed' | 'unknown',
  errorCode: string | null,
  contacted: boolean
): void {
  workspaceDb.sqlite.transaction(() => {
    if (contacted)
      recordUsage({
        workspaceDb,
        call,
        records: [
          {
            usageId: `usage_pending_${call.id}`,
            category: 'tool',
            quantity: 1,
            source: 'mcp-gateway-request-dispatched',
            unit: 'tool_calls',
          },
        ],
      });
    finishCapabilityCall({ workspaceDb, callId: call.id, status, errorCode });
  })();
}

function credentialsStillValid(
  coreDb: CoreDb | undefined,
  bindings: ReadonlyArray<{ readonly vaultGrantId: string }>,
  record: PendingRequestRecord,
  prepared: PreparedCapturedPendingCall | undefined
): boolean {
  if (bindings.length === 0) return true;
  if (!coreDb) return false;
  const now = Date.now();
  return bindings.every((binding) => {
    const grant = getVaultGrant(coreDb, binding.vaultGrantId);
    const reference = grant ? getVaultReference(coreDb, grant.vaultReferenceId) : null;
    try {
      assertCurrentMcpVaultAuthority(
        {
          environmentPackage: {
            snapshotId: record.packageDigest ?? '',
            scope: { workspaceId: record.workspaceId, agentSessionId: record.agentSessionId ?? '' },
            agent: { agentId: record.agentId ?? '' },
          },
          operation: 'mcp.call_tool',
        },
        grant,
        reference
      );
    } catch {
      return false;
    }
    const resolved = prepared?.grants.find((candidate) => candidate.id === binding.vaultGrantId);
    return Boolean(
      resolved &&
        reference &&
        resolved.referenceId === reference.referenceId &&
        resolved.version === reference.currentVersion &&
        (grant!.expiresAt === null || Date.parse(grant!.expiresAt) > now)
    );
  });
}

async function executeCapturedRepositoryPush(input: {
  readonly executionCall?: StartedCapabilityCall | undefined;
  readonly prepared?: PreparedCapturedPendingCall | undefined;
  readonly actor: Actor;
  readonly approvalPolicy: OpenKitConfig['policy'] | undefined;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly record: PendingRequestRecord;
  readonly store: FsStore;
  readonly vaultBackend: (() => VaultBackend) | undefined;
  readonly workspaceDb: WorkspaceDb;
}): Promise<CapturedPendingCallExecution> {
  const { record } = input;
  const intent = parseRepositoryIntent(record.canonicalArgumentsJson);
  if (!intent) {
    if (input.executionCall)
      recordCapturedExecution(
        input.executionCall,
        input.workspaceDb,
        'failed',
        'arguments-invalid',
        false
      );
    return { disposition: 'execution-error', reason: 'arguments-invalid', result: null };
  }
  const repository = getWorkspaceRepositoryResource(
    input.workspaceDb,
    record.workspaceId,
    intent.resourceId
  );
  if (!repository)
    return { disposition: 'execution-error', reason: 'tool-left-supply', result: null };
  const allow = readPolicyApprovalDecision(
    input.workspaceDb,
    record.workspaceId,
    record.requestId,
    'repo.push',
    'allow'
  );
  if (!allow) {
    const source = readPolicyApprovalDecision(
      input.workspaceDb,
      record.workspaceId,
      record.requestId,
      'repo.push'
    );
    if (!source) return { disposition: 'execution-error', reason: 'policy-changed', result: null };
    recordProductPermissionDecision({
      action: 'repo.push',
      approvalId: record.requestId,
      auditActor: { kind: 'user', id: input.actor.userId },
      contextSummary: source.contextSummary,
      decisionId: `pd_repo_push_grant_${record.requestId}`,
      enforcementPoint: 'approval.respond',
      ownerScope: 'workspace',
      policyEngineVersion: 'nanocore-approval-policy:v1',
      policySnapshotId: 'policy_snapshot_runtime',
      reasonCode: 'repo_push_human_granted',
      requiredApprovalKind: 'permission',
      resourceSummary: source.resourceSummary,
      result: 'allow',
      subjectSummary: source.subjectSummary,
      workspaceDb: input.workspaceDb,
      workspaceId: record.workspaceId,
    });
  }
  const approval = input.store.getApproval(record.requestId);
  if (approval.status !== 'granted') {
    input.store.updateApproval(record.requestId, {
      resolvedAt: record.decidedAt,
      status: 'granted',
    });
  }
  const context: RepositoryPushContext = {
    ...(input.prepared?.gitEnv ? { preparedGitEnv: input.prepared.gitEnv } : {}),
    ...(input.executionCall ? { executionCall: input.executionCall } : {}),
    actorId: input.actor.userId,
    approvalPolicy: input.approvalPolicy,
    authority: { kind: 'request', actor: input.actor },
    coreDb: input.coreDb,
    inflightCommands: input.inflightCommands,
    repository,
    store: input.store,
    vaultBackend: input.vaultBackend,
    workspaceDb: input.workspaceDb,
    workspaceId: record.workspaceId,
  };
  try {
    const pushed = await executeRepositoryPush(context, {
      approvalRequestId: record.requestId,
      requestId: intent.requestId,
    });
    if (input.executionCall) {
      const status = input.workspaceDb.sqlite
        .prepare('SELECT status FROM capability_calls WHERE call_id = ?')
        .get(input.executionCall.id) as { status: string } | undefined;
      if (status?.status === 'running')
        recordCapturedExecution(
          input.executionCall,
          input.workspaceDb,
          'failed',
          pushed.outcome,
          false
        );
    }
    return {
      disposition: pushed.outcome === 'pushed' ? 'approved-executed' : 'execution-error',
      reason: pushed.outcome === 'pushed' ? null : pushed.outcome,
      result: pushed,
    };
  } catch {
    if (input.executionCall)
      recordCapturedExecution(
        input.executionCall,
        input.workspaceDb,
        'unknown',
        'execution-unproven',
        false
      );
    return { disposition: 'outcome-unknown', reason: 'execution-unproven', result: null };
  }
}

function parseRepositoryIntent(canonicalArgumentsJson: string | null): {
  readonly resourceId: string;
  readonly requestId: string;
} | null {
  if (!canonicalArgumentsJson) return null;
  try {
    const parsed = JSON.parse(canonicalArgumentsJson) as {
      resourceId?: unknown;
      requestId?: unknown;
    };
    return typeof parsed.resourceId === 'string' &&
      parsed.resourceId.length > 0 &&
      RequestIdSchema.safeParse(parsed.requestId).success
      ? { resourceId: parsed.resourceId, requestId: parsed.requestId as string }
      : null;
  } catch {
    return null;
  }
}
