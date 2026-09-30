import { createHash } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { RequestGitPushApprovalRequestSchema } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { RequestIdSchema, responsibleUserIdForActor } from '@openkit/protocol';
import { z } from 'zod';
import { currentWorkerLineageWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  executeRepositoryPush,
  type RepositoryPushContext,
  requestRepositoryPushApproval,
} from '../repository-routes.js';
import { getWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { commandInputHash } from './idempotent-command.js';
import { mcpToolArgumentsContentDigest } from './mcp-tool-schema-snapshots.js';
import { TurnStartValidationError } from './orchestrator.js';
import { pendingToolResult, raiseRecordedPendingRequest } from './pending-request-flow.js';
import {
  canonicalJsonText,
  PendingRequestCommandError,
  preflightPendingRequest,
  readPendingRequest,
  recordAutomaticPolicyGrant,
} from './pending-requests.js';

/** Reserved, explicitly selected built-in Worker MCP server. */
export const OPENKIT_REPOSITORY_MCP_ID = 'openkit-repository';
const approvalSchema = z
  .object(RequestGitPushApprovalRequestSchema.shape)
  .omit({ threadId: true, turnId: true })
  .extend({ resourceId: z.string().min(1), requestId: RequestIdSchema })
  .strict();
/** The one repository tool. Human mode returns a pending approval. Automatic mode pushes inside the call. */
export const OPENKIT_REPOSITORY_TOOLS = [
  {
    name: 'repository_push',
    description:
      'Request an exact repository push of commits already present in the linked NanoCore repository. Human mode returns a pending approval and leaves this Turn running. Automatic mode pushes inside this call. Missing host commits require Workspace review/apply first.',
    inputSchema: z.toJSONSchema(approvalSchema, { target: 'draft-2020-12' }) as Record<
      string,
      unknown
    >,
  },
] as const;

/** Digest binds selected supply to the exact built-in tool schemas. */
export const OPENKIT_REPOSITORY_CATALOG_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(OPENKIT_REPOSITORY_TOOLS)).digest('hex')}`;

/** Returns metadata-only supply for an explicitly selected Codex manifest MCP id. */
export function createOpenkitRepositoryMcpSupply(): AgentEnvironmentPackage['supply']['mcpServers'][number] {
  return {
    id: OPENKIT_REPOSITORY_MCP_ID,
    catalogDigest: OPENKIT_REPOSITORY_CATALOG_DIGEST,
    allowedTools: OPENKIT_REPOSITORY_TOOLS.map((tool) => tool.name),
    deniedTools: [],
    approvalRequiredTools: [],
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}

/** Checks human pending-request identity and limits before the repository MCP call is admitted. */
export function preflightOpenkitRepositoryTool(
  context: Pick<RepositoryPushContext, 'approvalPolicy' | 'workspaceDb'>,
  environmentPackage: AgentEnvironmentPackage,
  args: Record<string, unknown>
) {
  const parsed = approvalSchema.safeParse(args);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  const scope = environmentPackage.scope;
  const actorId = responsibleUserIdForActor(scope.triggerActor);
  if (!actorId)
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool call was denied.', {
      code: 'mcp-denied',
    });
  if (
    context.approvalPolicy?.workspaceApprovalModes?.[scope.workspaceId]?.['repo.push'] ===
    'auto_allow'
  )
    return null;
  const identity = commandInputHash({
    command: 'git_push.approval.request',
    actorId,
    workspaceId: scope.workspaceId,
    repositoryResourceId: parsed.data.resourceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    requestId: parsed.data.requestId,
  }).slice('sha256:'.length);
  const argumentsValue = parsed.data;
  try {
    const duplicate = preflightPendingRequest(context.workspaceDb.sqlite, {
      requestId: `ap_repo_push_${identity}`,
      requestItemId: `it_repo_push_${identity}`,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      raisingTurnId: scope.turnId,
      kind: 'approval',
      requesterKind: 'worker',
      agentId: environmentPackage.agent.agentId,
      agentSessionId: scope.agentSessionId,
      responsibleUserId: actorId,
      now: new Date().toISOString(),
      call: {
        serverId: OPENKIT_REPOSITORY_MCP_ID,
        catalogRevision: OPENKIT_REPOSITORY_CATALOG_DIGEST,
        schemaSnapshotId: OPENKIT_REPOSITORY_CATALOG_DIGEST,
        toolName: 'repository_push',
        canonicalArgumentsJson: canonicalJsonText(argumentsValue),
        argumentsDigest: mcpToolArgumentsContentDigest(argumentsValue),
        packageDigest: environmentPackage.snapshotId,
        policyDecisionId: null,
        authorizationContext: {
          threadId: scope.threadId,
          turnId: scope.turnId,
          agentSessionId: scope.agentSessionId,
          agentId: environmentPackage.agent.agentId,
          responsibleUserId: actorId,
          packageDigest: environmentPackage.snapshotId,
          policyDecisionId: null,
        },
      },
    });
    return duplicate ? pendingToolResult('pending-approval', duplicate.requestId) : null;
  } catch (error) {
    if (error instanceof PendingRequestCommandError && error.code === 'idempotency_key_conflict')
      return repositoryToolResult(
        { ok: false, error: { code: error.code, message: error.message } },
        true
      );
    if (error instanceof PendingRequestCommandError)
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, error.message, {
        code: error.code,
      });
    throw error;
  }
}

/**
 * Dispatches the concrete repository command through their existing in-process owner.
 * @param context Current Core dependencies, without caller-supplied repository or actor authority.
 * @param environmentPackage Authenticated immutable Worker package.
 * @param capabilityCallId Current MCP call linked to the pending request.
 * @param toolName Selected built-in tool.
 * @param args Untrusted tool arguments.
 * @returns Public domain result and whether it records a pending approval.
 */
export async function dispatchOpenkitRepositoryTool(
  context: Omit<RepositoryPushContext, 'actorId' | 'authority' | 'repository' | 'workspaceId'>,
  environmentPackage: AgentEnvironmentPackage,
  capabilityCallId: string,
  toolName: string,
  args: Record<string, unknown>
) {
  if (toolName !== 'repository_push') {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool is unavailable.', {
      code: 'mcp-tool-not-found',
    });
  }
  const parsed = approvalSchema.safeParse(args);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  const { scope } = environmentPackage;
  const actorId = responsibleUserIdForActor(scope.triggerActor);
  const lineage = {
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    agentSessionId: scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    triggerActor: scope.triggerActor,
  };
  if (
    !context.coreDb ||
    !actorId ||
    !currentWorkerLineageWorkspaceAuthority(context.coreDb, lineage, 'repo.push', true)
  ) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool call was denied.', {
      code: 'mcp-denied',
    });
  }
  const repository = getWorkspaceRepositoryResource(
    context.workspaceDb,
    scope.workspaceId,
    parsed.data.resourceId
  );
  if (
    !repository ||
    repository.workspaceId !== scope.workspaceId ||
    context.store.getWorkspace(scope.workspaceId).kind === 'quick-chat'
  ) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'MCP tool call was denied.', {
      code: 'mcp-denied',
    });
  }
  const { resourceId: _selectedResource, ...candidate } = parsed.data;
  const domainInput = RequestGitPushApprovalRequestSchema.safeParse({
    ...candidate,
    threadId: scope.threadId,
    turnId: scope.turnId,
  });
  if (!domainInput.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  const ownerContext: RepositoryPushContext = {
    ...context,
    actorId,
    authority: { kind: 'worker', lineage },
    repository,
    workspaceId: scope.workspaceId,
  };
  try {
    const data = await requestRepositoryPushApproval(ownerContext, domainInput.data, {
      agentId: environmentPackage.agent.agentId,
      agentSessionId: scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      capabilityCallId,
    });
    if (data.approval.status === 'pending') {
      const argumentsValue = {
        commitIds: parsed.data.commitIds,
        requestId: parsed.data.requestId,
        resourceId: parsed.data.resourceId,
        sourceRef: parsed.data.sourceRef,
        targetBranch: parsed.data.targetBranch,
      };
      raiseRecordedPendingRequest(context.store, context.workspaceDb.sqlite, {
        requestId: data.approval.id,
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        raisingTurnId: scope.turnId,
        requestItemId: data.approvalItemId,
        kind: 'approval',
        requesterKind: 'worker',
        agentId: environmentPackage.agent.agentId,
        agentSessionId: scope.agentSessionId,
        responsibleUserId: actorId,
        call: {
          serverId: OPENKIT_REPOSITORY_MCP_ID,
          catalogRevision: OPENKIT_REPOSITORY_CATALOG_DIGEST,
          schemaSnapshotId: OPENKIT_REPOSITORY_CATALOG_DIGEST,
          toolName: 'repository_push',
          canonicalArgumentsJson: canonicalJsonText(argumentsValue),
          argumentsDigest: mcpToolArgumentsContentDigest(argumentsValue),
          packageDigest: environmentPackage.snapshotId,
          policyDecisionId: data.policyDecisionId,
          authorizationContext: {
            threadId: scope.threadId,
            turnId: scope.turnId,
            agentSessionId: scope.agentSessionId,
            agentId: environmentPackage.agent.agentId,
            responsibleUserId: actorId,
            packageDigest: environmentPackage.snapshotId,
            policyDecisionId: data.policyDecisionId,
          },
        },
        approval: {
          kind: 'permission',
          title: data.approval.title,
          description: data.approval.description,
        },
        now: data.approval.createdAt,
      });
      return {
        result: pendingToolResult('pending-approval', data.approval.id),
        pendingApproval: true,
      };
    }
    const pushed = await executeRepositoryPush(ownerContext, {
      approvalRequestId: data.approval.id,
      requestId: parsed.data.requestId,
    });
    if (!readPendingRequest(context.workspaceDb.sqlite, data.approval.id)) {
      recordAutomaticPolicyGrant(context.workspaceDb.sqlite, {
        requestId: data.approval.id,
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        raisingTurnId: scope.turnId,
        requestItemId: data.approvalItemId,
        kind: 'approval',
        requesterKind: 'worker',
        agentId: environmentPackage.agent.agentId,
        agentSessionId: scope.agentSessionId,
        responsibleUserId: actorId,
        approval: {
          kind: 'permission',
          title: data.approval.title,
          description: data.approval.description,
        },
        now: data.approval.createdAt,
      });
    }
    return { result: repositoryToolResult(pushed), pendingApproval: false };
  } catch (error) {
    const code =
      error instanceof TurnStartValidationError
        ? error.code
        : error instanceof Error && 'code' in error && error.code === 'idempotency_key_conflict'
          ? error.code
          : 'git_push_failed';
    const message =
      code === 'git_push_source_unavailable'
        ? 'The source commit must exist in the linked NanoCore repository. Use Workspace review/apply, then request approval for the resulting host commit.'
        : code === 'recovery_required'
          ? 'Repository push recovery requires inspection and a fresh authorized request.'
          : code === 'idempotency_key_conflict'
            ? 'The request identifier was already used with different input.'
            : 'Repository push could not be completed. Inspect the repository and exact approval prerequisites.';
    return {
      result: repositoryToolResult({ ok: false, error: { code, message } }, true),
      pendingApproval: false,
    };
  }
}

/** Projects a public repository response to matching structured and JSON-text MCP content. */
function repositoryToolResult(data: object, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}
