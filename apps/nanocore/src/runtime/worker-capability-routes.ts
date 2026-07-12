import { createHash, randomUUID } from 'node:crypto';

import { KnowledgeManagerDraftProposalResponseSchema } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { ApprovalRequestSchema, ArtifactSchema, KnowledgeEntrySchema } from '@openkit/protocol';
import { WorkerCapabilityCallSummarySchema } from '@openkit/worker-protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { createInjectionPlan } from '../injection-plans.js';
import { createInjectionReceipt } from '../injection-receipts.js';
import { draftKnowledgeProposal } from '../knowledge-manager.js';
import { searchKnowledgeEntries } from '../knowledge-search.js';
import type { FsStore } from '../lib/store.js';
import { createPolicyApprovalGate } from '../policy/approval-gates.js';
import { readPolicyApprovalDecision } from '../policy/permission-decisions.js';
import type { CoreDb } from '../storage/db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { vaultSecretMaterialToString } from '../vault/vault-backend.js';
import { getVaultGrant } from '../vault/vault-grants.js';
import { getVaultReference } from '../vault/vault-references.js';
import type { VaultUnlockState } from '../vault/vault-unlock-state.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import {
  mcpToolSchemaContentDigest,
  recordMcpToolSchemaSnapshot,
  WorkerCapabilityMcpToolSchema,
} from './mcp-tool-schema-snapshots.js';
import { WorkerControlGatewayError, type WorkerControlLineage } from './worker-control-gateway.js';
import {
  asWorkerControlApiError,
  type ParsedJsonRequest,
  parseBoundedJsonRequest,
  WorkerControlLineageRequestSchema,
} from './worker-http.js';
import type {
  WorkerMcpGateway,
  WorkerMcpGatewayCredentials,
  WorkerMcpLiveSchemaSnapshot,
} from './worker-mcp-gateway.js';

const workerMcpToolArgumentValidator = new Ajv2020({ allErrors: false, strict: false });

const WorkerCapabilityKnowledgeSearchRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});
const WorkerCapabilityKnowledgeReadRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  knowledgeEntryId: z.string().min(1),
});
const WorkerCapabilityKnowledgeProposalRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
const WorkerCapabilityArtifactReadRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  artifactId: z.string().min(1),
});
const WorkerCapabilityMcpListServersRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
});
const WorkerCapabilityMcpListToolsRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  serverId: z.string().min(1),
});
const WorkerCapabilityMcpCallToolRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  approvalRequestId: z.string().min(1).optional(),
  policyDecisionId: z.string().min(1).optional(),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const WorkerCapabilityDiagnosticReadRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
});
const WorkerCapabilityMcpServerSummarySchema = z.object({
  id: z.string().min(1),
  transport: z.enum(['stdio', 'http', 'websocket']),
  health: z.enum(['ready', 'degraded', 'failed']),
  toolNames: z.array(z.string().min(1)),
});
const WorkerCapabilityMcpToolResultSchema = z.record(z.string(), z.unknown());
const WorkerCapabilityKnowledgeSearchResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  items: z.array(KnowledgeEntrySchema),
});
const WorkerCapabilityKnowledgeReadResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  item: KnowledgeEntrySchema,
});
const WorkerCapabilityKnowledgeProposalResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  draft: KnowledgeManagerDraftProposalResponseSchema,
});
const WorkerCapabilityArtifactReadResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  artifact: ArtifactSchema,
});
const WorkerCapabilityMcpListServersResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  servers: z.array(WorkerCapabilityMcpServerSummarySchema),
});
const WorkerCapabilityMcpListToolsResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  schemaSnapshotId: z.string().min(1),
  tools: z.array(WorkerCapabilityMcpToolSchema),
});
const WorkerCapabilityMcpCallToolResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  schemaSnapshotId: z.string().min(1),
  result: WorkerCapabilityMcpToolResultSchema,
});
const WorkerCapabilityDiagnosticReadResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  diagnostics: z
    .object({
      agentSessionId: z.string().min(1),
      capabilityRouteFamilies: z.array(z.string().min(1)),
      mcpServerIds: z.array(z.string().min(1)),
      packageSnapshotId: z.string().min(1),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
      workspaceId: z.string().min(1),
    })
    .strict(),
});
const WorkerCapabilityMcpCallToolApprovalResponseSchema = z.object({
  approval: ApprovalRequestSchema,
  approvalItemId: z.string().min(1),
  policyDecisionId: z.string().min(1),
});

const WORKER_CAPABILITY_REQUEST_MAX_BYTES = 64 * 1024;

/**
 * Parses one bounded worker capability request.
 *
 * @param c Hono request context.
 * @param schema Schema used to validate the capability request.
 * @returns Parsed request data, or an error response.
 */
async function parseWorkerCapabilityRequest<T>(
  c: Context,
  schema: z.ZodType<T>
): Promise<ParsedJsonRequest<T>> {
  return parseBoundedJsonRequest(
    c,
    schema,
    WORKER_CAPABILITY_REQUEST_MAX_BYTES,
    'Worker capability payload',
    { invalid: 'capability_input_invalid', oversized: 'capability_input_invalid' }
  );
}

/**
 * Builds a product-safe worker capability call summary.
 *
 * @param input Summary fields.
 * @returns Validated worker capability call summary.
 */
function buildWorkerCapabilityCallSummary(input: {
  /** Worker lineage bound to the capability call. */
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  /** Capability family name. */
  family: z.infer<typeof WorkerCapabilityCallSummarySchema>['family'];
  /** Product-safe input summary. */
  inputSummary: string;
  /** Product-safe output summary. */
  outputSummary: string;
}): z.infer<typeof WorkerCapabilityCallSummarySchema> {
  const timestamp = new Date().toISOString();

  return WorkerCapabilityCallSummarySchema.parse({
    capabilityCallId: `cap_${input.lineage.packageSnapshotId}_${input.family.replace('.', '_')}_${Date.now().toString(36)}`,
    completedAt: timestamp,
    diagnostics: [],
    family: input.family,
    inputSummary: input.inputSummary,
    lineage: input.lineage,
    outputSummary: input.outputSummary,
    schemaVersion: 1,
    sequence: 0,
    startedAt: timestamp,
    status: 'succeeded',
  });
}

/**
 * Records one successful worker capability call when durable storage is available.
 *
 * @param input Worker lineage, summaries, and request context.
 * @returns Product-safe worker capability call summary.
 */
function recordWorkerCapabilityCallSummary(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Worker lineage bound to the capability call. */
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  /** Capability family name. */
  family:
    | 'knowledge.search'
    | 'knowledge.read'
    | 'knowledge.proposal'
    | 'worker_mcp.call'
    | 'artifact.read'
    | 'diagnostic.read';
  /** Durable usage-ledger capability family. */
  ledgerFamily?: 'knowledge' | 'mcp' | 'workspace' | undefined;
  /** Durable gateway operation. Defaults to the worker-facing family. */
  operation?: string | undefined;
  /** Redacted service reference. */
  serviceRef?: string | undefined;
  /** Optional usage rows recorded before the capability call is completed. */
  usageRecords?:
    | Array<{
        /** Usage category. */
        category: 'tool';
        /** Usage unit. */
        unit: 'capability_calls' | 'tool_calls';
        /** Measured quantity. */
        quantity: number;
        /** Measurement source. */
        source?: string | null;
      }>
    | undefined;
  /** Product-safe input summary. */
  inputSummary: string;
  /** Product-safe output summary. */
  outputSummary: string;
}): z.infer<typeof WorkerCapabilityCallSummarySchema> {
  const fallback = () =>
    buildWorkerCapabilityCallSummary({
      family: input.family,
      inputSummary: input.inputSummary,
      lineage: input.lineage,
      outputSummary: input.outputSummary,
    });

  if (!input.coreDb) {
    return fallback();
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);

    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: input.family,
      family: input.ledgerFamily ?? 'knowledge',
      operation: input.operation ?? input.family,
      redactionClass: 'metadata-only',
      requestId: input.lineage.requestId ?? null,
      serviceRef: input.serviceRef ?? 'knowledge-store',
      summary: input.inputSummary,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });
    if (input.usageRecords?.length) {
      recordUsage({
        call,
        records: input.usageRecords,
        workspaceDb,
      });
    }
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
    const completedAt = new Date().toISOString();

    return WorkerCapabilityCallSummarySchema.parse({
      capabilityCallId: call.id,
      completedAt,
      diagnostics: [],
      family: input.family,
      inputSummary: input.inputSummary,
      lineage: input.lineage,
      outputSummary: input.outputSummary,
      schemaVersion: 1,
      sequence: 0,
      startedAt: completedAt,
      status: 'succeeded',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Builds worker-visible MCP server summaries from the authenticated package supply.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @returns Product-safe MCP server summaries.
 */
function listWorkerVisibleMcpServers(
  environmentPackage: AgentEnvironmentPackage,
  gateway: WorkerMcpGateway
) {
  return environmentPackage.supply.mcpServers.map((server) =>
    WorkerCapabilityMcpServerSummarySchema.parse({
      health: gateway.getServerHealth?.(server) ?? 'ready',
      id: server.id,
      toolNames: server.allowedTools,
      transport: server.transport,
    })
  );
}

/**
 * Builds deterministic tool schema snapshots for one worker-visible MCP server.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @param serverId Requested MCP server id.
 * @returns Schema snapshot id and product-safe tool schemas.
 */
function listWorkerVisibleMcpTools(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string
): {
  schemaSnapshotId: string;
  tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
} {
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );

  if (!server) {
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      `MCP server is not enabled for this worker session: ${serverId}`,
      404
    );
  }

  const digest = server.integrity?.sha256 ?? server.version ?? 'unknown';
  const schemaByName = new Map(server.toolSchemas.map((tool) => [tool.name, tool.inputSchema]));

  return {
    schemaSnapshotId: `mcpsnap_${server.id}_${digest}`,
    tools: server.allowedTools.map((name) =>
      WorkerCapabilityMcpToolSchema.parse({
        inputSchema: schemaByName.get(name) ?? {
          additionalProperties: true,
          type: 'object',
        },
        name,
      })
    ),
  };
}

/**
 * Closes gateway resources and denies a call when a known MCP vault grant is no longer active.
 *
 * @param input Grant validation context.
 */
async function requireActiveWorkerMcpVaultGrants(input: {
  coreDb: CoreDb;
  gateway: WorkerMcpGateway;
  server: AgentEnvironmentPackage['supply']['mcpServers'][number];
}): Promise<void> {
  for (const grantId of input.server.vaultGrantIds) {
    const grant = getVaultGrant(input.coreDb, grantId);

    if (!grant) {
      continue;
    }

    const expired = grant.expiresAt ? Date.parse(grant.expiresAt) <= Date.now() : false;

    if (grant.status !== 'active' || expired) {
      await input.gateway.closeServer?.(input.server);
      throw new WorkerControlGatewayError(
        'mcp-denied',
        'MCP tool call denied by revoked vault grant.',
        403
      );
    }
  }
}

/**
 * Resolves gateway-private credentials for one MCP call from active vault grants.
 *
 * @param input Credential resolution context.
 * @returns Gateway-private credential material, or undefined when no vault-backed credential applies.
 */
function resolveWorkerMcpGatewayCredentials(input: {
  capabilityCallId: string;
  coreDb: CoreDb;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  server: AgentEnvironmentPackage['supply']['mcpServers'][number];
  vaultUnlockState: VaultUnlockState | null;
}): WorkerMcpGatewayCredentials | undefined {
  if (
    !input.vaultUnlockState ||
    !input.server.providerInstanceIds.includes('provider_github_read')
  ) {
    return undefined;
  }

  const grantId = input.server.vaultGrantIds.find(
    (candidate) => getVaultGrant(input.coreDb, candidate)?.vaultReferenceId === 'vault_github_read'
  );

  if (!grantId) {
    return undefined;
  }

  const grant = getVaultGrant(input.coreDb, grantId);
  const reference = getVaultReference(input.coreDb, 'vault_github_read');

  if (!grant || !reference) {
    return undefined;
  }
  if (!grant.allowedInjectionPaths.includes('gateway-only')) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call denied by vault grant injection policy.',
      403
    );
  }
  if (grant.targetAgentSessionId && grant.targetAgentSessionId !== input.lineage.agentSessionId) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call denied by vault grant target.',
      403
    );
  }

  const planId = `plan_${input.lineage.packageSnapshotId}_${grant.grantId}_mcp_gateway`;
  const receiptId = `receipt_${input.capabilityCallId}_${grant.grantId}`;
  const now = new Date().toISOString();

  createInjectionPlan(input.coreDb, {
    backendCapabilityRequirement: 'mcp-gateway:github-token',
    capabilityId: 'worker_mcp.call',
    expirationBehavior: grant.expiresAt ? `expires-at:${grant.expiresAt}` : 'grant-lifetime',
    grantId: grant.grantId,
    injectionVisibility: 'gateway-only',
    packageSnapshotId: input.lineage.packageSnapshotId,
    planId,
    redactionRule: 'no-secret-material',
    revocationBehavior: 'close-gateway-session',
    now: () => now,
  });
  createInjectionReceipt(input.coreDb, {
    agentSessionId: input.lineage.agentSessionId,
    backendSummary: 'mcp-gateway:github-token',
    capabilityCallId: input.capabilityCallId,
    expiresAt: grant.expiresAt,
    grantId: grant.grantId,
    injectedAt: now,
    planId,
    receiptId,
    revocationStatus: 'active',
  });

  const material = createVaultUseAuditedBackend({
    agentSessionId: input.lineage.agentSessionId,
    backend: input.vaultUnlockState.backend(),
    capabilityCallId: input.capabilityCallId,
    db: input.coreDb,
    grantId: grant.grantId,
    ownerScope: 'server',
    planId,
    receiptId,
    resolvingPath: 'grant',
    now: () => now,
  }).resolve({ referenceId: reference.referenceId });
  const token = vaultSecretMaterialToString(material);

  return {
    environment: { GH_TOKEN: token, GITHUB_TOKEN: token },
    headers: { authorization: `Bearer ${token}` },
  };
}

/**
 * Executes one currently enabled MCP tool through the NanoCore gateway.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @param serverId Requested MCP server id.
 * @param toolName Requested MCP tool name.
 * @returns Schema snapshot id and product-safe tool result.
 */
function callWorkerVisibleMcpTool(
  environmentPackage: AgentEnvironmentPackage,
  gateway: WorkerMcpGateway,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  credentials?: WorkerMcpGatewayCredentials | undefined,
  liveSchemaSnapshotSink?: ((snapshot: WorkerMcpLiveSchemaSnapshot) => void) | undefined
): Promise<{
  result: z.infer<typeof WorkerCapabilityMcpToolResultSchema>;
  schemaSnapshotId: string;
}> {
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );
  const snapshot = listWorkerVisibleMcpTools(environmentPackage, serverId);
  const tool = snapshot.tools.find((candidate) => candidate.name === toolName);

  if (!server) {
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      `MCP server is not enabled for this worker session: ${serverId}`,
      404
    );
  }

  if (!tool) {
    throw new WorkerControlGatewayError(
      'mcp-tool-not-found',
      `MCP tool is not enabled for this worker session: ${serverId}/${toolName}`,
      404
    );
  }

  validateWorkerMcpToolArguments(tool.inputSchema, args, serverId, toolName);

  return gateway
    .callTool({ arguments: args, credentials, liveSchemaSnapshotSink, server, toolName })
    .then((result) => ({
      result: WorkerCapabilityMcpToolResultSchema.parse(result),
      schemaSnapshotId: snapshot.schemaSnapshotId,
    }));
}

/**
 * Checks whether one enabled MCP tool requires human approval.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @param serverId Requested MCP server id.
 * @param toolName Requested MCP tool name.
 * @returns True when the AEP marks the tool as approval-required.
 */
function workerMcpToolRequiresApproval(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  toolName: string
): boolean {
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );

  return server?.approvalRequiredTools.includes(toolName) ?? false;
}

/**
 * Throws the stable worker-visible error for a tool outside the worker MCP allowlist.
 *
 * @param serverId MCP server id.
 * @param toolName MCP tool name.
 */
function mcpToolNotFound(serverId: string, toolName: string): never {
  throw new WorkerControlGatewayError(
    'mcp-tool-not-found',
    `MCP tool is not enabled for this worker session: ${serverId}/${toolName}`,
    404
  );
}

/**
 * Creates or reuses the approval gate for one approval-required MCP tool call.
 *
 * @param input MCP approval context.
 * @returns Product-safe pending approval response.
 */
function createMcpToolApprovalGate(input: {
  coreDb?: CoreDb;
  environmentPackage: AgentEnvironmentPackage;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  serverId: string;
  store: FsStore;
  toolName: string;
}): z.infer<typeof WorkerCapabilityMcpCallToolApprovalResponseSchema> {
  if (!input.coreDb) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool approval requires durable workspace storage.',
      403
    );
  }

  const tool = listWorkerVisibleMcpTools(input.environmentPackage, input.serverId).tools.find(
    (candidate) => candidate.name === input.toolName
  );

  if (!tool) {
    mcpToolNotFound(input.serverId, input.toolName);
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        agentSessionId: input.lineage.agentSessionId,
        serverId: input.serverId,
        threadId: input.lineage.threadId,
        toolName: input.toolName,
        turnId: input.lineage.turnId,
        workspaceId: input.lineage.workspaceId,
      })
    )
    .digest('hex')
    .slice(0, 20);
  const approvalId = `ap_mcp_${digest}`;
  const approvalItemId = `it_mcp_approval_${digest}`;
  const decisionId = `pd_mcp_require_${digest}`;

  try {
    applyScopedMigrations(workspaceDb);

    const existingDecision = readPolicyApprovalDecision(
      workspaceDb,
      input.lineage.workspaceId,
      approvalId,
      'mcp.call'
    );

    if (existingDecision) {
      return WorkerCapabilityMcpCallToolApprovalResponseSchema.parse({
        approval: input.store.getApproval(approvalId),
        approvalItemId,
        policyDecisionId: existingDecision.decisionId,
      });
    }

    const gate = createPolicyApprovalGate({
      action: 'mcp.call',
      approvalId,
      approvalItemId,
      contextSummary: {
        agentSessionId: input.lineage.agentSessionId,
        packageSnapshotId: input.lineage.packageSnapshotId,
        requestId: input.lineage.requestId,
        threadId: input.lineage.threadId,
        turnId: input.lineage.turnId,
        workspaceId: input.lineage.workspaceId,
      },
      decisionId,
      description: `Allow this worker turn to call ${input.serverId}/${input.toolName}. Tool arguments and credentials are not included in the approval record.`,
      reasonCode: 'mcp_call_requires_human_approval',
      resourceSummary: {
        kind: 'mcp-tool-call',
        packageSnapshotId: input.lineage.packageSnapshotId,
        serverId: input.serverId,
        toolName: input.toolName,
        workspaceId: input.lineage.workspaceId,
      },
      store: input.store,
      subjectSummary: {
        agentSessionId: input.lineage.agentSessionId,
        kind: 'worker-agent-session',
      },
      title: `Approve MCP tool ${input.serverId}/${input.toolName}`,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    return WorkerCapabilityMcpCallToolApprovalResponseSchema.parse({
      approval: input.store.getApproval(gate.approvalId),
      approvalItemId: gate.approvalItemId,
      policyDecisionId: gate.decisionId,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Executes one MCP tool call and records durable success or failure diagnostics when storage exists.
 *
 * @param input Worker MCP call and ledger context.
 * @returns Product-safe call result and capability summary.
 */
async function callWorkerVisibleMcpToolWithLedger(input: {
  coreDb?: CoreDb;
  environmentPackage: AgentEnvironmentPackage;
  gateway: WorkerMcpGateway;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  serverId: string;
  store: FsStore;
  toolName: string;
  args: Record<string, unknown>;
  vaultUnlockState?: VaultUnlockState | null;
}): Promise<{
  callResult: Awaited<ReturnType<typeof callWorkerVisibleMcpTool>>;
  capabilityCall: z.infer<typeof WorkerCapabilityCallSummarySchema>;
}> {
  const toolSnapshot = listWorkerVisibleMcpTools(input.environmentPackage, input.serverId);
  const inputSummary = `MCP tool call requested for ${input.serverId}/${input.toolName} using ${toolSnapshot.schemaSnapshotId}.`;

  if (!input.coreDb) {
    const callResult = await callWorkerVisibleMcpTool(
      input.environmentPackage,
      input.gateway,
      input.serverId,
      input.toolName,
      input.args
    );

    return {
      callResult,
      capabilityCall: buildWorkerCapabilityCallSummary({
        family: 'worker_mcp.call',
        inputSummary,
        lineage: input.lineage,
        outputSummary: `MCP tool ${input.toolName} completed.`,
      }),
    };
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    recordMcpToolSchemaSnapshot({
      environmentPackage: input.environmentPackage,
      schemaSnapshotId: toolSnapshot.schemaSnapshotId,
      serverId: input.serverId,
      tools: toolSnapshot.tools,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: 'worker_mcp.call',
      family: 'mcp',
      operation: 'mcp.call_tool',
      redactionClass: 'metadata-only',
      requestId: input.lineage.requestId ?? null,
      serviceRef: 'mcp-gateway',
      summary: inputSummary,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    try {
      const server = input.environmentPackage.supply.mcpServers.find(
        (candidate) => candidate.id === input.serverId
      );
      let credentials: WorkerMcpGatewayCredentials | undefined;

      if (server) {
        await requireActiveWorkerMcpVaultGrants({
          coreDb: input.coreDb,
          gateway: input.gateway,
          server,
        });
        credentials = resolveWorkerMcpGatewayCredentials({
          capabilityCallId: call.id,
          coreDb: input.coreDb,
          lineage: input.lineage,
          server,
          vaultUnlockState: input.vaultUnlockState ?? null,
        });
      }

      const recordLiveSchemaSnapshot = (snapshot: WorkerMcpLiveSchemaSnapshot): void => {
        const contentDigest = mcpToolSchemaContentDigest(snapshot.tools);
        recordMcpToolSchemaSnapshot({
          contentDigest,
          environmentPackage: input.environmentPackage,
          schemaSnapshotId: `mcpsnap_${input.serverId}_${contentDigest.slice(0, 32)}`,
          serverId: input.serverId,
          serverVersion:
            typeof snapshot.serverInfo?.version === 'string' ? snapshot.serverInfo.version : null,
          source: 'live',
          tools: snapshot.tools,
          workspaceDb,
          workspaceId: input.lineage.workspaceId,
        });
      };
      const callResult = await callWorkerVisibleMcpTool(
        input.environmentPackage,
        input.gateway,
        input.serverId,
        input.toolName,
        input.args,
        credentials,
        recordLiveSchemaSnapshot
      );

      recordUsage({
        call,
        records: [
          {
            category: 'tool',
            quantity: 1,
            source: 'gateway-observed',
            unit: 'tool_calls',
          },
        ],
        workspaceDb,
      });
      finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });

      const completedAt = new Date().toISOString();

      return {
        callResult,
        capabilityCall: WorkerCapabilityCallSummarySchema.parse({
          capabilityCallId: call.id,
          completedAt,
          diagnostics: [],
          family: 'worker_mcp.call',
          inputSummary,
          lineage: input.lineage,
          outputSummary: `MCP tool ${input.toolName} completed.`,
          schemaVersion: 1,
          sequence: 0,
          startedAt: completedAt,
          status: 'succeeded',
        }),
      };
    } catch (error) {
      finishCapabilityCall({
        workspaceDb,
        callId: call.id,
        errorCode: workerMcpFailureErrorCode(error),
        status: 'failed',
      });
      throw error;
    }
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Maps one Worker MCP failure to the stable ledger error code.
 *
 * @param error Failure thrown during MCP validation or dispatch.
 * @returns Product-safe error code for capability diagnostics.
 */
function workerMcpFailureErrorCode(error: unknown): string {
  return error instanceof WorkerControlGatewayError ? error.code : 'mcp-call-failed';
}

/**
 * Records a denied worker MCP capability call after authenticated policy evaluation.
 *
 * @param input Denied MCP call context.
 */
function recordDeniedWorkerMcpCapabilityCall(input: {
  coreDb?: CoreDb;
  error: WorkerControlGatewayError;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  serverId: string;
  store: FsStore;
  toolName: string;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: 'worker_mcp.call',
      callId: `cap_denied_mcp_${randomUUID()}`,
      family: 'mcp',
      operation: 'mcp.call_tool',
      redactionClass: 'metadata-only',
      requestId: null,
      serviceRef: 'mcp-gateway',
      summary: `MCP tool call denied for ${input.serverId}/${input.toolName}.`,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    finishCapabilityCall({
      callId: call.id,
      errorCode: input.error.code,
      status: 'failed',
      workspaceDb,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Records one authenticated failed worker capability attempt when durable storage is available.
 *
 * @param input Failed capability context.
 */
function recordFailedWorkerCapabilityCall(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Stable error code returned to the worker. */
  errorCode: string;
  /** Worker-facing capability family. */
  family: 'knowledge.read' | 'artifact.read';
  /** Durable usage-ledger capability family. */
  ledgerFamily: 'knowledge' | 'workspace';
  /** Worker lineage bound to the capability call. */
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  /** Durable gateway operation. */
  operation: string;
  /** Redacted service reference. */
  serviceRef: string;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Product-safe failure summary. */
  summary: string;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: input.family,
      callId: `cap_failed_${input.family.replace('.', '_')}_${randomUUID()}`,
      family: input.ledgerFamily,
      operation: input.operation,
      redactionClass: 'metadata-only',
      requestId: null,
      serviceRef: input.serviceRef,
      summary: input.summary,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    finishCapabilityCall({
      callId: call.id,
      errorCode: input.errorCode,
      status: 'failed',
      workspaceDb,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Verifies that an immutable permission decision allows one MCP tool call.
 *
 * @param input Policy decision lookup input.
 * @throws WorkerControlGatewayError when the decision is absent or not allowed.
 */
function requireAllowedMcpToolCallPolicyDecision(input: {
  approvalRequestId?: string;
  approvalRequired?: boolean;
  coreDb?: CoreDb;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  policyDecisionId?: string;
  serverId: string;
  store: FsStore;
  toolName: string;
}): void {
  if (!input.coreDb) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call requires an allowed policy decision.',
      403
    );
  }

  if (!input.policyDecisionId && !input.approvalRequestId) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call requires an allowed policy decision.',
      403
    );
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const row = workspaceDb.sqlite
      .prepare(
        `SELECT action, approval_id, owner_scope, workspace_id, result, resource_summary_json
         FROM permission_decisions
         WHERE action = 'mcp.call'
           AND result = 'allow'
           AND (
             (? IS NOT NULL AND decision_id = ?)
             OR (? IS NOT NULL AND approval_id = ?)
           )
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(
        input.policyDecisionId ?? null,
        input.policyDecisionId ?? null,
        input.approvalRequestId ?? null,
        input.approvalRequestId ?? null
      ) as
      | {
          action: string;
          approval_id: string | null;
          owner_scope: string;
          resource_summary_json: string;
          result: string;
          workspace_id: string | null;
        }
      | undefined;

    if (
      !row ||
      row.action !== 'mcp.call' ||
      row.owner_scope !== 'workspace' ||
      row.workspace_id !== input.lineage.workspaceId ||
      row.result !== 'allow'
    ) {
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
    }

    if (input.approvalRequired) {
      if (!row.approval_id) {
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
      }

      const approval = input.store.getApproval(row.approval_id);

      if (approval.status !== 'granted') {
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
      }
    }

    const resource = JSON.parse(row.resource_summary_json) as Record<string, unknown>;

    if (
      resource.kind !== 'mcp-tool-call' ||
      resource.serverId !== input.serverId ||
      resource.toolName !== input.toolName ||
      resource.workspaceId !== input.lineage.workspaceId
    ) {
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
    }
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Validates MCP tool arguments against the package snapshot JSON Schema.
 *
 * @param schema Tool input schema from the resolved package snapshot.
 * @param args JSON object arguments supplied by the worker.
 * @param serverId MCP server id used for typed diagnostics.
 * @param toolName MCP tool name used for typed diagnostics.
 */
function validateWorkerMcpToolArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  serverId: string,
  toolName: string
): void {
  let validate: ReturnType<typeof workerMcpToolArgumentValidator.compile>;

  try {
    validate = workerMcpToolArgumentValidator.compile(schema);
  } catch {
    throw new WorkerControlGatewayError(
      'mcp-invalid-arguments',
      `MCP tool arguments do not match schema: ${serverId}/${toolName}`,
      400
    );
  }

  if (!validate(args)) {
    throw new WorkerControlGatewayError(
      'mcp-invalid-arguments',
      `MCP tool arguments do not match schema: ${serverId}/${toolName}`,
      400
    );
  }
}

/**
 * Registers the sandbox-authenticated worker capability routes.
 *
 * @param dependencies Worker capability dependencies owned by the app composition root.
 */
export function registerWorkerCapabilityRoutes({
  app,
  authenticateWorkerPackageOwner,
  coreDb,
  vaultUnlockState,
  workerMcpGateway,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly authenticateWorkerPackageOwner: (input: {
    readonly authorization: string | null;
    readonly lineage: WorkerControlLineage;
  }) => {
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly store: FsStore;
  };
  readonly coreDb: CoreDb | undefined;
  readonly vaultUnlockState: VaultUnlockState | null;
  readonly workerMcpGateway: WorkerMcpGateway;
}): void {
  /**
   * Authenticates one request against an enabled worker capability plane.
   *
   * @param input Sandbox authorization and package lineage.
   * @returns Authenticated package and owner-scoped store.
   * @throws WorkerControlGatewayError when the package disables worker capabilities.
   */
  function authenticateWorkerCapability(input: {
    readonly authorization: string | null;
    readonly lineage: WorkerControlLineage;
  }): { readonly environmentPackage: AgentEnvironmentPackage; readonly store: FsStore } {
    const authenticated = authenticateWorkerPackageOwner(input);

    if (authenticated.environmentPackage.capabilities.mode === 'disabled') {
      throw new WorkerControlGatewayError(
        'capability_unavailable',
        'Worker capability access is disabled by the authenticated package.',
        403
      );
    }

    return authenticated;
  }

  /**
   * Requires one exact worker capability route and its resolved policy reference.
   *
   * @param environmentPackage Authenticated package that grants worker authority.
   * @param family Capability family requested by the route.
   * @param path Worker-visible capability path.
   * @throws WorkerControlGatewayError when the package does not authorize the route.
   */
  function requireWorkerCapabilityRoute(
    environmentPackage: AgentEnvironmentPackage,
    family: AgentEnvironmentPackage['capabilities']['routes'][number]['family'],
    path: string
  ): void {
    const route = environmentPackage.capabilities.routes.find(
      (candidate) => candidate.family === family && candidate.path === path
    );

    if (!route) {
      throw new WorkerControlGatewayError(
        'capability_not_in_package',
        `Worker capability is not authorized by the package: ${family}`,
        403
      );
    }

    if (!route.policyRefId) {
      throw new WorkerControlGatewayError(
        'capability_policy_denied',
        `Worker capability has no resolved policy reference: ${family}`,
        403
      );
    }
  }

  app.post('/api/worker-capabilities/knowledge/search', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityKnowledgeSearchRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      requireWorkerCapabilityRoute(environmentPackage, 'knowledge.search', '/knowledge/search');
      const limit = parsed.data.limit ?? 10;
      const items = searchKnowledgeEntries(
        store.listKnowledge(environmentPackage.scope.workspaceId),
        parsed.data.query,
        limit
      );

      return c.json(
        WorkerCapabilityKnowledgeSearchResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'knowledge.search',
            inputSummary: `Knowledge search requested with query length ${parsed.data.query.length}.`,
            lineage: parsed.data.lineage,
            outputSummary: `${items.length} knowledge entries matched.`,
            store,
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-knowledge-search',
                unit: 'capability_calls',
              },
            ],
            ...(coreDb ? { coreDb } : {}),
          }),
          items,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/knowledge/read', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityKnowledgeReadRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    let capabilityStore: FsStore | null = null;

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      requireWorkerCapabilityRoute(environmentPackage, 'knowledge.read', '/knowledge/read');
      capabilityStore = store;
      const item = store.getKnowledgeEntry(
        environmentPackage.scope.workspaceId,
        parsed.data.knowledgeEntryId
      );

      return c.json(
        WorkerCapabilityKnowledgeReadResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'knowledge.read',
            inputSummary: `Knowledge read requested for ${parsed.data.knowledgeEntryId}.`,
            lineage: parsed.data.lineage,
            outputSummary: `Knowledge entry ${item.id} returned.`,
            store,
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-knowledge-read',
                unit: 'capability_calls',
              },
            ],
            ...(coreDb ? { coreDb } : {}),
          }),
          item,
        })
      );
    } catch (error) {
      if (error instanceof WorkerControlGatewayError) {
        return asWorkerControlApiError(error);
      }

      if (capabilityStore) {
        recordFailedWorkerCapabilityCall({
          errorCode: 'worker_capability_knowledge_not_found',
          family: 'knowledge.read',
          ledgerFamily: 'knowledge',
          lineage: parsed.data.lineage,
          operation: 'knowledge.read',
          serviceRef: 'knowledge-store',
          store: capabilityStore,
          summary: `Knowledge read failed for ${parsed.data.knowledgeEntryId}.`,
          ...(coreDb ? { coreDb } : {}),
        });
      }
      return asApiError((error as Error).message, 'worker_capability_knowledge_not_found', 404);
    }
  });

  app.post('/api/worker-capabilities/knowledge/proposals', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityKnowledgeProposalRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      requireWorkerCapabilityRoute(
        environmentPackage,
        'knowledge.proposal',
        '/knowledge/proposals'
      );
      const timestamp = new Date().toISOString();
      const proposal = store.createKnowledgeProposal({
        createdAt: timestamp,
        id: `kp_${randomUUID()}`,
        status: 'pending',
        summary: parsed.data.summary,
        title: parsed.data.title,
        updatedAt: timestamp,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      const draft = draftKnowledgeProposal({
        operationId: `km_proposal_${randomUUID()}`,
        workspaceId: environmentPackage.scope.workspaceId,
        caller: 'assistant',
        proposal,
        sourceReferences: parsed.data.sourceReferences,
        entries: store.listKnowledge(environmentPackage.scope.workspaceId),
        sources: store.listKnowledgeSources(environmentPackage.scope.workspaceId),
        confidence: parsed.data.confidence,
      });

      return c.json(
        WorkerCapabilityKnowledgeProposalResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'knowledge.proposal',
            inputSummary: `Knowledge proposal requested with title length ${parsed.data.title.length}.`,
            lineage: parsed.data.lineage,
            operation: 'knowledge.proposal',
            outputSummary: `Knowledge proposal ${proposal.id} drafted.`,
            serviceRef: 'knowledge-manager',
            store,
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-knowledge-proposal',
                unit: 'capability_calls',
              },
            ],
            ...(coreDb ? { coreDb } : {}),
          }),
          draft,
        })
      );
    } catch (error) {
      if (error instanceof WorkerControlGatewayError) {
        return asWorkerControlApiError(error);
      }

      return asApiError((error as Error).message, 'worker_capability_knowledge_proposal_failed');
    }
  });

  app.post('/api/worker-capabilities/artifacts/read', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(c, WorkerCapabilityArtifactReadRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    let capabilityStore: FsStore | null = null;

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      requireWorkerCapabilityRoute(environmentPackage, 'artifact.read', '/artifacts/read');
      capabilityStore = store;
      const artifact = store.getArtifact(
        environmentPackage.scope.workspaceId,
        parsed.data.artifactId
      );

      return c.json(
        WorkerCapabilityArtifactReadResponseSchema.parse({
          artifact,
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'artifact.read',
            inputSummary: `Artifact read requested for ${parsed.data.artifactId}.`,
            ledgerFamily: 'workspace',
            lineage: parsed.data.lineage,
            operation: 'artifact.read',
            outputSummary: `Artifact ${artifact.id} returned.`,
            serviceRef: 'artifact-store',
            store,
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-artifact-read',
                unit: 'capability_calls',
              },
            ],
            ...(coreDb ? { coreDb } : {}),
          }),
        })
      );
    } catch (error) {
      if (error instanceof WorkerControlGatewayError) {
        return asWorkerControlApiError(error);
      }

      if (capabilityStore) {
        recordFailedWorkerCapabilityCall({
          errorCode: 'worker_capability_artifact_not_found',
          family: 'artifact.read',
          ledgerFamily: 'workspace',
          lineage: parsed.data.lineage,
          operation: 'artifact.read',
          serviceRef: 'artifact-store',
          store: capabilityStore,
          summary: `Artifact read failed for ${parsed.data.artifactId}.`,
          ...(coreDb ? { coreDb } : {}),
        });
      }
      return asApiError((error as Error).message, 'worker_capability_artifact_not_found', 404);
    }
  });

  app.post('/api/worker-capabilities/mcp/list-servers', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityMcpListServersRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const servers = listWorkerVisibleMcpServers(environmentPackage, workerMcpGateway);

      return c.json(
        WorkerCapabilityMcpListServersResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'worker_mcp.call',
            inputSummary: 'MCP server list requested.',
            ledgerFamily: 'mcp',
            lineage: parsed.data.lineage,
            operation: 'mcp.list_servers',
            outputSummary: `${servers.length} MCP servers visible.`,
            serviceRef: 'mcp-gateway',
            store,
            ...(coreDb ? { coreDb } : {}),
          }),
          servers,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/mcp/list-tools', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(c, WorkerCapabilityMcpListToolsRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const toolSnapshot = listWorkerVisibleMcpTools(environmentPackage, parsed.data.serverId);
      if (coreDb) {
        const workspaceDb = openWorkspaceDb(
          coreDb.dataRoot,
          store.getUserId(),
          parsed.data.lineage.workspaceId
        );

        try {
          applyScopedMigrations(workspaceDb);
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            schemaSnapshotId: toolSnapshot.schemaSnapshotId,
            serverId: parsed.data.serverId,
            tools: toolSnapshot.tools,
            workspaceDb,
            workspaceId: parsed.data.lineage.workspaceId,
          });
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return c.json(
        WorkerCapabilityMcpListToolsResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'worker_mcp.call',
            inputSummary: `MCP tool list requested for ${parsed.data.serverId}.`,
            ledgerFamily: 'mcp',
            lineage: parsed.data.lineage,
            operation: 'mcp.list_tools',
            outputSummary: `${toolSnapshot.tools.length} MCP tools visible.`,
            serviceRef: 'mcp-gateway',
            store,
            ...(coreDb ? { coreDb } : {}),
          }),
          schemaSnapshotId: toolSnapshot.schemaSnapshotId,
          tools: toolSnapshot.tools,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/mcp/call-tool', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(c, WorkerCapabilityMcpCallToolRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const approvalRequired = workerMcpToolRequiresApproval(
        environmentPackage,
        parsed.data.serverId,
        parsed.data.toolName
      );

      if (approvalRequired && !parsed.data.policyDecisionId && !parsed.data.approvalRequestId) {
        const approval = createMcpToolApprovalGate({
          environmentPackage,
          lineage: parsed.data.lineage,
          serverId: parsed.data.serverId,
          store,
          toolName: parsed.data.toolName,
          ...(coreDb ? { coreDb } : {}),
        });

        return c.json(approval, 202);
      }

      try {
        requireAllowedMcpToolCallPolicyDecision({
          ...(parsed.data.approvalRequestId
            ? { approvalRequestId: parsed.data.approvalRequestId }
            : {}),
          approvalRequired,
          lineage: parsed.data.lineage,
          ...(parsed.data.policyDecisionId
            ? { policyDecisionId: parsed.data.policyDecisionId }
            : {}),
          serverId: parsed.data.serverId,
          store,
          toolName: parsed.data.toolName,
          ...(coreDb ? { coreDb } : {}),
        });
      } catch (error) {
        if (error instanceof WorkerControlGatewayError) {
          recordDeniedWorkerMcpCapabilityCall({
            error,
            lineage: parsed.data.lineage,
            serverId: parsed.data.serverId,
            store,
            toolName: parsed.data.toolName,
            ...(coreDb ? { coreDb } : {}),
          });
        }
        throw error;
      }
      const { capabilityCall, callResult } = await callWorkerVisibleMcpToolWithLedger({
        args: parsed.data.arguments,
        environmentPackage,
        gateway: workerMcpGateway,
        lineage: parsed.data.lineage,
        serverId: parsed.data.serverId,
        store,
        toolName: parsed.data.toolName,
        vaultUnlockState,
        ...(coreDb ? { coreDb } : {}),
      });

      return c.json(
        WorkerCapabilityMcpCallToolResponseSchema.parse({
          capabilityCall,
          result: callResult.result,
          schemaSnapshotId: callResult.schemaSnapshotId,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/diagnostics/read', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityDiagnosticReadRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const { environmentPackage, store } = authenticateWorkerCapability({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      requireWorkerCapabilityRoute(environmentPackage, 'diagnostic.read', '/diagnostics/read');

      return c.json(
        WorkerCapabilityDiagnosticReadResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'diagnostic.read',
            inputSummary: 'Worker session diagnostics requested.',
            ledgerFamily: 'workspace',
            lineage: parsed.data.lineage,
            operation: 'diagnostic.read',
            outputSummary: 'Worker session diagnostics returned.',
            serviceRef: 'worker-capability-diagnostics',
            store,
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-diagnostic-read',
                unit: 'capability_calls',
              },
            ],
            ...(coreDb ? { coreDb } : {}),
          }),
          diagnostics: {
            agentSessionId: environmentPackage.scope.agentSessionId,
            capabilityRouteFamilies: environmentPackage.capabilities.routes.map(
              (route) => route.family
            ),
            mcpServerIds: environmentPackage.supply.mcpServers.map((server) => server.id),
            packageSnapshotId: environmentPackage.snapshotId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            workspaceId: environmentPackage.scope.workspaceId,
          },
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });
}
