import { resolveWorkspaceMcpServer, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import {
  finishCapabilityCall,
  recordUsage,
  type StartedCapabilityCall,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
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
import { readCurrentMcpToolSchemaSnapshot } from './mcp-tool-schema-snapshots.js';
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
  readonly record: PendingRequestRecord;
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly coreDb: CoreDb | undefined;
  readonly vaultBackend: (() => VaultBackend) | undefined;
  readonly workerMcpGateway: WorkerMcpGateway;
  readonly workspaceDb: WorkspaceDb;
}): Promise<PreparedCapturedPendingCall> {
  const record = input.record;
  if (!record.serverId) return { grants: [], failed: false };
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
    family: 'mcp',
    operation: 'mcp.call_tool',
    capabilityId: 'mcp.call_tool',
    itemId: null,
    providerRef: record.serverId,
    serviceRef: `mcp-tool:${record.toolName}`,
    redactionClass: 'metadata-only',
    summary: 'Captured pending call execution.',
  });
  if (!call.inserted)
    throw new PendingRequestCommandError(
      'recovery_required',
      'The captured execution call already exists.',
      409
    );
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
 * Executes one claimed captured vendor MCP call once.
 * An external MCP call uses the process gateway. A released worker lease is not required:
 * the approving responsible user is the request authority.
 *
 * @param input Claimed record and current process owners.
 * @returns Disposition recorded by the approval command.
 */
export async function executeCapturedPendingCall(input: {
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly coreDb: CoreDb | undefined;
  readonly record: PendingRequestRecord;
  readonly workerMcpGateway: WorkerMcpGateway;
  readonly workspaceDb: WorkspaceDb;
  readonly prepared?: PreparedCapturedPendingCall | undefined;
  readonly executionCall?: StartedCapabilityCall | undefined;
}): Promise<CapturedPendingCallExecution> {
  const { record } = input;
  if (!input.executionCall)
    return { disposition: 'outcome-unknown', reason: 'execution-admission-missing', result: null };
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
