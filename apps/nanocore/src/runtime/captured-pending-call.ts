import { isDeepStrictEqual } from 'node:util';
import { resolveWorkspaceMcpServer, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { deriveEntityId } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  finishCapabilityCall,
  recordUsage,
  type StartedCapabilityCall,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { readAuditEventRowV1, readPermissionDecisionRowV1 } from '../policy/retained-records-v1.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { isCurrentServerMcpMaterial } from '../vault/server-mcp-authority.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { getVaultGrant } from '../vault/vault-grants.js';
import { getVaultReference } from '../vault/vault-references.js';
import {
  assertCurrentMcpVaultAuthority,
  completeMcpVaultInjections,
  type PendingMcpVaultInjection,
  resolveWorkerMcpCredentials,
} from '../worker-mcp-routes.js';
import {
  canonicalMcpToolSchemas,
  readCurrentMcpToolSchemaSnapshot,
  readRetainedMcpToolSchemaSnapshot,
} from './mcp-tool-schema-snapshots.js';
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
  /** Independent current pipeline evaluation; the claim keeps its existing derived decision. */
  readonly mediation?: {
    readonly decisionId: string;
    readonly current: () => boolean;
    /** Optional post-outcome observation owned by response composition. */
    readonly observe?: () => Promise<void>;
  };
}

/** Resolves credential material through the existing audited MCP Vault owner before a claim. */
export async function prepareCapturedPendingCall(input: {
  /** Actual human approving this captured effect, retained by the existing native operation. */
  readonly actor: Pick<Actor, 'userId'>;
  readonly record: PendingRequestRecord;
  readonly catalog: WorkspaceMcpServerCatalog | null;
  readonly coreDb: CoreDb | undefined;
  readonly vaultBackend: (() => VaultBackend) | undefined;
  readonly workerMcpGateway: WorkerMcpGateway;
  readonly workspaceDb: WorkspaceDb;
  /** Runs the current pipeline with the actual authenticated human before resolving credentials. */
  readonly reviewPolicy?: (
    record: PendingRequestRecord,
    actor: Pick<Actor, 'userId'>
  ) => Promise<NonNullable<PreparedCapturedPendingCall['mediation']> | null>;
}): Promise<PreparedCapturedPendingCall> {
  const record = input.record;
  if (!record.serverId) return { grants: [], failed: false };
  const source = readCapturedMediationSource(record, input.workspaceDb.sqlite);
  let mediation: PreparedCapturedPendingCall['mediation'];
  if (source) {
    if (!input.reviewPolicy || input.workspaceDb.workspaceId !== record.workspaceId)
      return { grants: [], failed: true };
    const reviewed = await input.reviewPolicy(record, input.actor);
    if (!reviewed) return { grants: [], failed: true };
    const evaluation = readCapturedMediationAllow(
      record,
      input.workspaceDb.sqlite,
      source,
      reviewed
    );
    if (!evaluation || evaluation.actor.id !== input.actor.userId)
      return { grants: [], failed: true };
    mediation = reviewed;
  }
  try {
    if (!input.catalog) return { grants: [], failed: true };
    const resolved = resolveWorkspaceMcpServer({
      catalog: input.catalog,
      serverId: record.serverId,
    });
    const environmentPackage = {
      snapshotId: record.packageDigest ?? '',
      scope: {
        workspaceId: record.workspaceId,
        agentSessionId: record.agentSessionId ?? '',
        triggerActor: { kind: 'user' as const, id: input.actor.userId },
      },
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
      operation: 'mcp.call-tool',
      resolved,
      workspaceDb: input.workspaceDb,
    });
    const grants = material.injections.map(({ grant, referenceVersion }) => ({
      id: grant.grantId,
      referenceId: grant.vaultReferenceId,
      version: referenceVersion,
    }));
    return {
      credentials: material.credentials,
      grants,
      injections: material.injections,
      failed: false,
      ...(mediation ? { mediation } : {}),
    };
  } catch {
    return { grants: [], failed: true, ...(mediation ? { mediation } : {}) };
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
  commandRequestId: string,
  prepared?: PreparedCapturedPendingCall
): StartedCapabilityCall {
  const source = readCapturedMediationSource(record, workspaceDb.sqlite);
  const reviewed =
    source && !prepared?.failed && workspaceDb.workspaceId === record.workspaceId
      ? readCapturedMediationAllow(record, workspaceDb.sqlite, source, prepared?.mediation)
      : null;
  if (source && !reviewed)
    throw new PendingRequestCommandError(
      'policy-changed',
      'Captured Policy approval is no longer current.',
      409
    );
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
    operation: 'mcp.call-tool',
    capabilityId: 'mcp.call-tool',
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
    decisionId: deriveEntityId('pd', ['pending_execution', record.requestId]),
    action: 'tool.use',
    approvalId: record.requestId,
    auditActor: reviewed?.actor ?? { kind: 'user', id: record.responsibleUserId },
    subjectSummary: reviewed?.decision.subjectSummary ?? {
      responsibleUserId: record.responsibleUserId,
      agentId: record.agentId,
    },
    resourceSummary: { serverId: record.serverId, toolName: record.toolName },
    contextSummary: {
      capabilityCallId: call.id,
      threadId: record.threadId,
      turnId: record.raisingTurnId,
      packageSnapshotId: record.packageDigest,
      ...(reviewed ? { originEvaluationDecisionId: reviewed.decision.decisionId } : {}),
    },
    ...(reviewed ? { mediation: { ...reviewed.decision.mediation!, consumedStatements: [] } } : {}),
    enforcementPoint: reviewed?.decision.enforcementPoint ?? 'approval.respond',
    policyEngineVersion:
      reviewed?.decision.policyEngineVersion ?? 'nanocore-workspace-role-policy:v1',
    policySnapshotId: reviewed?.decision.policySnapshotId ?? 'policy_snapshot_runtime',
    reasonCode: 'mcp_approval_grant_reauthorized',
    result: 'allow',
  });
  return call;
}

/**
 * Re-evaluates a captured call against the current catalog and exact retained schema evidence. Credential grants are read from Core. The Workspace read uses the grant transaction's connection.
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
  const source = readCapturedMediationSource(record, input.sqlite);
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
  const currentTool = snapshot?.tools.find((tool) => tool.name === record.toolName);
  let schemaCurrent = snapshot?.schemaSnapshotId === record.schemaSnapshotId;
  if (resolved.schemaPolicy === 'tracking') {
    const captured = readRetainedMcpToolSchemaSnapshot({
      catalogEntryId: record.serverId,
      schemaSnapshotId: record.schemaSnapshotId,
      workspaceDb: { sqlite: input.sqlite } as WorkspaceDb,
      workspaceId: record.workspaceId,
    });
    const capturedTool = captured?.tools.find((tool) => tool.name === record.toolName);
    // The complete requested schema includes nested descriptions and annotations.
    schemaCurrent = Boolean(
      currentTool &&
        capturedTool &&
        JSON.stringify(canonicalMcpToolSchemas([currentTool])) ===
          JSON.stringify(canonicalMcpToolSchemas([capturedTool]))
    );
  }
  return {
    agentAuthority,
    toolInSupply: Boolean(selected && allowed && currentTool),
    schemaCurrent,
    policyAllows: source
      ? Boolean(readCapturedMediationAllow(record, input.sqlite, source, input.prepared?.mediation))
      : resolved.approvalRequiredTools.includes(record.toolName),
    credentialsValid:
      !input.prepared?.failed &&
      credentialsStillValid(input.coreDb, resolved, record, input.prepared),
  };
}

/** Resolves the existing source pointer without treating missing or corrupt evidence as catalog approval. */
function readCapturedMediationSource(
  record: PendingRequestRecord,
  sqlite: WorkspaceDb['sqlite']
): ReturnType<typeof readPermissionDecisionRowV1> | null {
  if (record.policyDecisionId === null) return null;
  const row = sqlite
    .prepare('SELECT * FROM permission_decisions WHERE decision_id = ?')
    .get(record.policyDecisionId);
  if (!row)
    throw new PendingRequestCommandError(
      'recovery_required',
      'Captured Policy source is missing.',
      409
    );
  const source = readPermissionDecisionRowV1(row);
  if (!source.mediation) return null;
  const target = source.resourceSummary as Record<string, unknown> | null;
  const context = source.contextSummary as Record<string, unknown> | null;
  const process = source.mediation.subject.process;
  if (
    source.ownerScope !== 'workspace' ||
    source.workspaceId !== record.workspaceId ||
    source.action !== 'tool.use' ||
    !['require_escalation', 'require_approval'].includes(source.result) ||
    source.mediation.role !== 'final' ||
    source.mediation.point !== 'mcp.call-tool@decide' ||
    source.mediation.kernel?.effect !== 'allow' ||
    target?.serverId !== record.serverId ||
    target?.toolName !== record.toolName ||
    context?.threadId !== record.threadId ||
    context?.turnId !== record.raisingTurnId ||
    process?.workspaceId !== record.workspaceId ||
    process.threadId !== record.threadId ||
    process.turnId !== record.raisingTurnId ||
    source.mediation.subject.responsibleHumanId !== record.responsibleUserId
  )
    throw new PendingRequestCommandError(
      'recovery_required',
      'Captured Policy source does not match the request.',
      409
    );
  return source;
}

/** Rechecks current facts and exact independent evaluation/Audit evidence; storage failures propagate. */
function readCapturedMediationAllow(
  record: PendingRequestRecord,
  sqlite: WorkspaceDb['sqlite'],
  source: ReturnType<typeof readPermissionDecisionRowV1>,
  reviewed: PreparedCapturedPendingCall['mediation']
) {
  if (!reviewed || !reviewed.current()) return null;
  const row = sqlite
    .prepare('SELECT * FROM permission_decisions WHERE decision_id = ?')
    .get(reviewed.decisionId);
  if (!row) return null;
  const decision = readPermissionDecisionRowV1(row);
  const mediation = decision.mediation;
  const original = source.mediation!;
  const target = decision.resourceSummary as Record<string, unknown> | null;
  const context = decision.contextSummary as Record<string, unknown> | null;
  const capabilityCallId = executionCallIdForRequest(record.requestId);
  if (
    decision.ownerScope !== 'workspace' ||
    decision.workspaceId !== record.workspaceId ||
    decision.action !== 'tool.use' ||
    decision.result !== 'allow' ||
    decision.approvalId !== null ||
    mediation?.role !== 'final' ||
    mediation.kernel?.effect !== 'allow' ||
    mediation.point !== original.point ||
    mediation.policyRevision !== original.policyRevision ||
    mediation.authorizationRevision !== original.authorizationRevision ||
    mediation.proposalDigest !== original.proposalDigest ||
    !isDeepStrictEqual(mediation.subject, original.subject) ||
    target?.serverId !== record.serverId ||
    target?.toolName !== record.toolName ||
    context?.humanApprovalRequestId !== record.requestId ||
    context?.approvalSourceDecisionId !== record.policyDecisionId ||
    context?.capabilityCallId !== capabilityCallId ||
    context?.threadId !== record.threadId ||
    context?.turnId !== record.raisingTurnId ||
    !decision.auditEventId
  )
    return null;
  const auditRow = sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
    .get(decision.auditEventId);
  if (!auditRow) return null;
  const audit = readAuditEventRowV1(auditRow);
  if (
    audit.actor?.kind !== 'user' ||
    context.humanApprovalDeciderId !== audit.actor.id ||
    audit.permissionDecisionId !== decision.decisionId ||
    audit.workspaceId !== record.workspaceId ||
    audit.capabilityCallId !== capabilityCallId ||
    audit.threadId !== record.threadId ||
    audit.turnId !== record.raisingTurnId ||
    audit.action !== 'permission.decision' ||
    audit.resource !== 'permission:tool.use' ||
    audit.outcome !== 'succeeded'
  )
    return null;
  return { decision, actor: audit.actor };
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
  /** Existing backend used only for the current shared material check before dispatch. */
  readonly vaultBackend?: (() => VaultBackend) | undefined;
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
  // Completed observations report evidence failure without changing a settled Tool outcome.
  const observeOutcome = async (
    outcome: CapturedPendingCallExecution
  ): Promise<CapturedPendingCallExecution> => {
    try {
      await input.prepared?.mediation?.observe?.();
    } catch {
      return { ...outcome, reason: outcome.reason ?? 'policy-observation-unavailable' };
    }
    return outcome;
  };
  if (!record.serverId || !record.toolName || !record.canonicalArgumentsJson || !input.catalog) {
    recordCapturedExecution(
      input.executionCall,
      input.workspaceDb,
      'failed',
      'binding-missing',
      false
    );
    return observeOutcome({
      disposition: 'execution-error',
      reason: 'binding-missing',
      result: null,
    });
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
    return observeOutcome({
      disposition: 'execution-error',
      reason: 'tool-left-supply',
      result: null,
    });
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
      return observeOutcome({
        disposition: 'execution-error',
        reason: 'arguments-invalid',
        result: null,
      });
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
    return observeOutcome({
      disposition: 'execution-error',
      reason: 'arguments-invalid',
      result: null,
    });
  }
  if (
    resolved.scope === 'server' &&
    (resolved.catalogDigest !== record.catalogRevision ||
      !credentialsStillValid(input.coreDb, resolved, record, input.prepared) ||
      resolved.credentialBindings.some((binding) => {
        const grant = input.coreDb ? getVaultGrant(input.coreDb, binding.vaultGrantId) : null;
        const reference =
          grant && input.coreDb ? getVaultReference(input.coreDb, grant.vaultReferenceId) : null;
        try {
          const backend = input.vaultBackend?.();
          return !backend || !reference || !isCurrentServerMcpMaterial(backend, reference);
        } catch {
          return true;
        }
      }))
  ) {
    recordCapturedExecution(
      input.executionCall,
      input.workspaceDb,
      'failed',
      'credentials-invalid',
      false
    );
    return observeOutcome({
      disposition: 'execution-error',
      reason: 'credentials-invalid',
      result: null,
    });
  }
  let outcome: CapturedPendingCallExecution;
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
    outcome = { disposition: 'approved-executed', reason: null, result };
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
    outcome = known
      ? { disposition: 'execution-error', reason: error.code, result: null }
      : { disposition: 'outcome-unknown', reason: 'execution-unproven', result: null };
  }
  return observeOutcome(outcome);
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
  resolved: ReturnType<typeof resolveWorkspaceMcpServer>,
  record: PendingRequestRecord,
  prepared: PreparedCapturedPendingCall | undefined
): boolean {
  const bindings = resolved.credentialBindings;
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
          operation: 'mcp.call-tool',
          resolved,
        },
        grant,
        reference
      );
    } catch {
      return false;
    }
    const observed = prepared?.grants.find((candidate) => candidate.id === binding.vaultGrantId);
    return Boolean(
      observed &&
        reference &&
        observed.referenceId === reference.referenceId &&
        observed.version === reference.currentVersion &&
        (grant!.expiresAt === null || Date.parse(grant!.expiresAt) > now)
    );
  });
}
