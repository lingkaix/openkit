import { resolveWorkspaceMcpServer, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import { finishMcpToolCall, type StartedCapabilityCall } from '../capability/usage-ledger.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { OperationError } from '../operation-error.js';
import {
  prepareCapturedPermissionDecision,
  readCapturedMediationAllowInDb,
  readCapturedMediationSource,
} from '../policy/permission-decisions.js';
import type { readPermissionDecisionRowV1 } from '../policy/retained-records-v1.js';
import { ControlCapabilityCommandInputSchema } from '../storage/control-store-capability.js';
import { presentControlFacts } from '../storage/control-store-input.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
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

/** Admits the existing Call, decision and any no-contact refusal after the original native claim ACK. */
export async function admitCapturedPendingCall(
  record: PendingRequestRecord,
  workspaceDb: WorkspaceDb,
  commandRequestId: string,
  prepared?: PreparedCapturedPendingCall,
  failure?: string
): Promise<StartedCapabilityCall & { readonly refusal?: string }> {
  const source = readCapturedMediationSource(record, workspaceDb.sqlite);
  const reviewed =
    source && !failure && !prepared?.failed && workspaceDb.workspaceId === record.workspaceId
      ? readCapturedMediationAllow(record, workspaceDb.sqlite, source, prepared?.mediation)
      : null;
  // A current submission refusal still owns the already-acknowledged reservation's truthful finish.
  if (source && !reviewed && !failure) failure = 'policy-changed';
  const callId = executionCallIdForRequest(record.requestId);
  const context = {
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
  };
  const admitted = await getControlStoreWorkerClient().workspaceCapability(
    workspaceDb,
    ControlCapabilityCommandInputSchema.parse({
      kind: 'admit',
      workspaceId: record.workspaceId,
      callId,
      context,
      now: new Date().toISOString(),
      capturedSource: {
        requestId: record.requestId,
        sourceDecisionId: record.policyDecisionId,
        reviewedDecisionId: reviewed?.decision.decisionId ?? null,
        ...(failure ? { failure } : {}),
      },
      ...(failure
        ? {
            finish: {
              status: 'failed',
              errorCode: failure,
              now: new Date().toISOString(),
            },
          }
        : {}),
    })
  );
  if (!admitted || typeof admitted !== 'object' || !('inserted' in admitted))
    throw new TypeError('Invalid native captured admission result.');
  if (!admitted.inserted)
    throw new PendingRequestCommandError(
      'recovery_required',
      'The captured execution call already exists.',
      409
    );
  return presentControlFacts({ ...admitted, context: presentControlFacts(admitted.context) });
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
  const allowed = resolved.allowedTools.includes(record.toolName);
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
      : false,
    credentialsValid:
      !input.prepared?.failed &&
      credentialsStillValid(input.coreDb, resolved, record, input.prepared),
  };
}

/** Checks current Main authority before the shared exact retained-decision/Audit reader. */
function readCapturedMediationAllow(
  record: PendingRequestRecord,
  sqlite: WorkspaceDb['sqlite'],
  source: ReturnType<typeof readPermissionDecisionRowV1>,
  reviewed: PreparedCapturedPendingCall['mediation']
) {
  if (!reviewed || !reviewed.current()) return null;
  return readCapturedMediationAllowInDb(record, sqlite, source, reviewed);
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
  /** Current Main scope/supply/Policy/credential checks, evaluated at the actual contact and disclosure boundaries. */
  readonly current?: (() => string | undefined) | undefined;
}): Promise<CapturedPendingCallExecution> {
  const { record } = input;
  if (!input.executionCall)
    return { disposition: 'outcome-unknown', reason: 'execution-admission-missing', result: null };
  const executionCall = input.executionCall;
  // Retain the actual pre-contact refusal with its finish, without replacing the admitted allow.
  const refuseSubmission = async (reason: string) => {
    const source = readCapturedMediationSource(record, input.workspaceDb.sqlite);
    const reviewed = source
      ? readCapturedMediationAllowInDb(
          record,
          input.workspaceDb.sqlite,
          source,
          input.prepared?.mediation
        )
      : null;
    await finishMcpToolCall(
      executionCall,
      input.workspaceDb,
      {
        status: 'failed',
        errorCode: reason,
        decision: prepareCapturedPermissionDecision(
          record,
          input.workspaceDb,
          reviewed,
          reason,
          new Date(),
          allocateEntityId('pd')
        ),
      },
      false
    );
  };
  // Completed observations report evidence failure without changing a settled Tool outcome.
  const observeOutcome = async (
    outcome: CapturedPendingCallExecution
  ): Promise<CapturedPendingCallExecution> => {
    if (outcome.result !== null && input.prepared?.mediation) {
      let current = false;
      try {
        current = input.prepared.mediation.current();
      } catch {
        // A settled effect grants no disclosure when current authority cannot be read.
      }
      if (!current)
        outcome = { ...outcome, reason: 'authority-changed-after-execution', result: null };
    }
    try {
      await input.prepared?.mediation?.observe?.();
    } catch {
      outcome = { ...outcome, reason: outcome.reason ?? 'policy-observation-unavailable' };
    }
    if (outcome.result !== null) {
      let refusal: string | undefined;
      try {
        refusal = input.current?.();
        if (input.prepared?.mediation && !input.prepared.mediation.current())
          refusal = 'authority-changed-after-execution';
      } catch {
        refusal = 'authority-changed-after-execution';
      }
      if (refusal) return { ...outcome, reason: refusal, result: null };
    }
    return outcome;
  };
  if (!record.serverId || !record.toolName || !record.canonicalArgumentsJson || !input.catalog) {
    await refuseSubmission('binding-missing');
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
    await refuseSubmission('tool-left-supply');
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
      await refuseSubmission('arguments-invalid');
      return observeOutcome({
        disposition: 'execution-error',
        reason: 'arguments-invalid',
        result: null,
      });
    }
    args = parsed as Record<string, unknown>;
  } catch {
    await refuseSubmission('arguments-invalid');
    return observeOutcome({
      disposition: 'execution-error',
      reason: 'arguments-invalid',
      result: null,
    });
  }
  if (
    resolved.catalogDigest !== record.catalogRevision ||
    !credentialsStillValid(input.coreDb, resolved, record, input.prepared) ||
    (resolved.scope === 'server' &&
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
    await refuseSubmission('credentials-invalid');
    return observeOutcome({
      disposition: 'execution-error',
      reason: 'credentials-invalid',
      result: null,
    });
  }
  const refusal =
    input.current?.() ??
    (input.prepared?.mediation && !input.prepared.mediation.current()
      ? 'policy-changed'
      : undefined);
  if (refusal) {
    await refuseSubmission(refusal);
    return observeOutcome({ disposition: 'execution-error', reason: refusal, result: null });
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
    await finishMcpToolCall(
      input.executionCall,
      input.workspaceDb,
      { status: 'succeeded', errorCode: null },
      true
    );
    outcome = { disposition: 'approved-executed', reason: null, result };
  } catch (error) {
    const known = error instanceof WorkerMcpGatewayCallError && error.upstreamEffect !== 'unknown';
    if (
      input.executionCall &&
      !(error instanceof ControlStoreWorkerError && error.commit === 'unknown') &&
      // The shared composer already attempted the separate finish-only diagnostic.
      !(
        (error instanceof OperationError && error.code === 'usage_record_failed') ||
        (error instanceof TypeError && error.message === 'Unsupported retained record format.')
      )
    )
      await finishMcpToolCall(
        input.executionCall,
        input.workspaceDb,
        {
          status: known ? 'failed' : 'unknown',
          errorCode: error instanceof WorkerMcpGatewayCallError ? error.code : 'execution-unproven',
        },
        !(error instanceof WorkerMcpGatewayCallError && error.upstreamEffect === 'not-contacted')
      );
    outcome = known
      ? { disposition: 'execution-error', reason: error.code, result: null }
      : { disposition: 'outcome-unknown', reason: 'execution-unproven', result: null };
  }
  return observeOutcome(outcome);
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
