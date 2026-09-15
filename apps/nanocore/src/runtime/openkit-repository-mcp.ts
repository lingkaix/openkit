import { createHash } from 'node:crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  ExecuteGitPushRequestSchema,
  RequestGitPushApprovalRequestSchema,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { RequestIdSchema, responsibleUserIdForActor } from '@openkit/protocol';
import { z } from 'zod';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  executeRepositoryPush,
  type RepositoryPushContext,
  requestRepositoryPushApproval,
} from '../repository-routes.js';
import { getWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { TurnStartValidationError } from './orchestrator.js';

/** Reserved, explicitly selected built-in Worker MCP server. */
export const OPENKIT_REPOSITORY_MCP_ID = 'openkit-repository';
const approvalSchema = z
  .object(RequestGitPushApprovalRequestSchema.shape)
  .omit({ threadId: true, turnId: true })
  .extend({ resourceId: z.string().min(1), requestId: RequestIdSchema })
  .strict();
const executeSchema = z
  .object(ExecuteGitPushRequestSchema.shape)
  .extend({ resourceId: z.string().min(1), requestId: RequestIdSchema })
  .strict();

/** Fixed repository tools; all caller authority comes from the authenticated AEP. */
export const OPENKIT_REPOSITORY_TOOLS = [
  {
    name: 'repository_push_request_approval',
    description:
      'Request approval to publish an exact commit already present in the linked NanoCore repository. Missing host commits require Workspace review/apply first. Human approval stops this Task; after approval start a new Task to execute the grant.',
    inputSchema: z.toJSONSchema(approvalSchema, { target: 'draft-2020-12' }) as Record<
      string,
      unknown
    >,
  },
  {
    name: 'repository_push_execute',
    description:
      'Execute an exact granted repository push, including a grant from a previous Task, under current authority. Git and write credentials remain on NanoCore.',
    inputSchema: z.toJSONSchema(executeSchema, { target: 'draft-2020-12' }) as Record<
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

/**
 * Dispatches two concrete repository commands through their existing in-process owner.
 * @param context Current Core dependencies, without caller-supplied repository or actor authority.
 * @param environmentPackage Authenticated immutable Worker package.
 * @param capabilityCallId Current MCP call linked to a possible human Gate.
 * @param toolName Selected built-in tool.
 * @param args Untrusted tool arguments.
 * @returns Public domain result and whether the exact newly created human Gate needs a stop.
 */
export async function dispatchOpenkitRepositoryTool(
  context: Omit<RepositoryPushContext, 'actorId' | 'repository' | 'workspaceId'>,
  environmentPackage: AgentEnvironmentPackage,
  capabilityCallId: string,
  toolName: string,
  args: Record<string, unknown>
) {
  const schema =
    toolName === 'repository_push_request_approval'
      ? approvalSchema
      : toolName === 'repository_push_execute'
        ? executeSchema
        : null;
  if (!schema)
    throw new McpError(ErrorCode.InvalidRequest, 'MCP tool is unavailable.', {
      code: 'mcp-tool-not-found',
    });
  const parsed = schema.safeParse(args);
  if (!parsed.success)
    throw new McpError(ErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  const { scope } = environmentPackage;
  const actorId = responsibleUserIdForActor(scope.triggerActor);
  if (
    !context.coreDb ||
    !actorId ||
    !currentWorkspaceAuthority(
      context.coreDb,
      scope.workspaceId,
      scope.triggerActor,
      'repo.push',
      true
    )
  ) {
    throw new McpError(ErrorCode.InvalidRequest, 'MCP tool call was denied.', {
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
    throw new McpError(ErrorCode.InvalidRequest, 'MCP tool call was denied.', {
      code: 'mcp-denied',
    });
  }
  const { resourceId: _selectedResource, ...candidate } = parsed.data;
  const domainInput =
    toolName === 'repository_push_request_approval'
      ? RequestGitPushApprovalRequestSchema.safeParse({
          ...candidate,
          threadId: scope.threadId,
          turnId: scope.turnId,
        })
      : ExecuteGitPushRequestSchema.safeParse(candidate);
  if (!domainInput.success)
    throw new McpError(ErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  const ownerContext = { ...context, actorId, repository, workspaceId: scope.workspaceId };
  try {
    if (toolName === 'repository_push_request_approval') {
      const input = approvalSchema.parse(args);
      const { resourceId: _resourceId, ...request } = input;
      const data = await requestRepositoryPushApproval(
        ownerContext,
        { ...request, threadId: scope.threadId, turnId: scope.turnId },
        {
          agentId: environmentPackage.agent.agentId,
          agentSessionId: scope.agentSessionId,
          packageSnapshotId: environmentPackage.snapshotId,
          capabilityCallId,
        }
      );
      return {
        result: repositoryToolResult(data),
        pendingApproval: data.approval.status === 'pending',
      };
    }
    const { resourceId: _resourceId, ...request } = executeSchema.parse(args);
    const data = await executeRepositoryPush(ownerContext, request);
    return { result: repositoryToolResult(data), pendingApproval: false };
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
