import { createHash } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  RequestIdSchema,
  responsibleUserIdForActor,
  UserInputQuestionSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { pendingToolResult, raiseRecordedPendingRequest } from './pending-request-flow.js';
import {
  canonicalJsonText,
  PendingRequestCommandError,
  preflightPendingRequest,
  type RaisePendingRequestInput,
} from './pending-requests.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

/** Reserved built-in Worker MCP server supplied to every worker AgentSession. */
export const OPENKIT_WORK_MCP_ID = 'openkit-work';

const WorkRequestInputArgsSchema = z
  .object({
    requestId: RequestIdSchema,
    prompt: z.string().min(1),
    questions: z.array(UserInputQuestionSchema).min(1),
  })
  .strip();

function mcpInputSchema(schema: z.ZodType): Record<string, unknown> {
  const projection = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete projection.$schema;
  return projection;
}

/** The only openkit-work tool in this slice. Peer tools are later. */
export const OPENKIT_WORK_TOOLS = [
  {
    name: 'work_request_input',
    description:
      'Ask the responsible user one or more non-secret questions. The answer arrives on a later Turn. Recording the question is the result of this call.',
    inputSchema: mcpInputSchema(WorkRequestInputArgsSchema),
  },
] as const;

/** Digest binds selected supply to the exact built-in tool schema. */
export const OPENKIT_WORK_CATALOG_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(OPENKIT_WORK_TOOLS)).digest('hex')}`;

/** Returns the supply entry appended to every worker package. */
export function createOpenkitWorkMcpSupply(): AgentEnvironmentPackage['supply']['mcpServers'][number] {
  return {
    id: OPENKIT_WORK_MCP_ID,
    catalogDigest: OPENKIT_WORK_CATALOG_DIGEST,
    allowedTools: OPENKIT_WORK_TOOLS.map((tool) => tool.name),
    deniedTools: [],
    approvalRequiredTools: [],
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}

/**
 * Returns whether these arguments are a secret question and must be refused before any write.
 *
 * @param args Untrusted tool arguments.
 * @returns True when a present question has isSecret true.
 */
export function workRequestInputIsSecret(args: Record<string, unknown>): boolean {
  const parsed = WorkRequestInputArgsSchema.safeParse(args);
  return parsed.success && parsed.data.questions.some((question) => question.isSecret);
}

/**
 * Raises one pending user-input request and returns its pending-input tool result.
 *
 * @param input Authenticated package and open workspace database.
 * @param args Untrusted tool arguments.
 * @returns MCP tool result with isError false.
 */
export async function dispatchOpenkitWorkTool(
  input: {
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
  },
  args: Record<string, unknown>
) {
  const parsed = WorkRequestInputArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  }
  if (parsed.data.questions.some((question) => question.isSecret)) {
    throw new WorkerControlGatewayError(
      'secret_input_not_supported',
      'Secret input is not supported.',
      400
    );
  }
  const { scope } = input.environmentPackage;
  const responsibleUserId = responsibleUserIdForActor(scope.triggerActor);
  const turn = input.store.getTurnById(scope.turnId);
  if (
    !responsibleUserId ||
    turn.workspaceId !== scope.workspaceId ||
    turn.threadId !== scope.threadId ||
    turn.status !== 'running'
  ) {
    throw new WorkerControlGatewayError('turn_not_active', 'The Turn is not running.', 409);
  }
  const now = new Date().toISOString();
  const raiseInput = workRaiseInput(input.environmentPackage, parsed.data, now);
  let raised: ReturnType<typeof raiseRecordedPendingRequest>;
  try {
    raised = raiseRecordedPendingRequest(input.store, input.workspaceDb.sqlite, raiseInput);
  } catch (error) {
    if (error instanceof PendingRequestCommandError) {
      throw new WorkerControlGatewayError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (!input.store.listAllItems().some((item) => item.id === raised.requestItemId)) {
    input.store.createItem({
      id: raised.requestItemId,
      workspaceId: raised.workspaceId,
      threadId: raised.threadId,
      turnId: raised.raisingTurnId,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId,
      userInputRequestId: raised.requestId,
      prompt: parsed.data.prompt,
      questions: [...parsed.data.questions],
      createdAt: now,
      completedAt: now,
    });
  }
  return pendingToolResult('pending-input', raised.requestId);
}

function workRaiseInput(
  environmentPackage: AgentEnvironmentPackage,
  args: z.infer<typeof WorkRequestInputArgsSchema>,
  now: string
): RaisePendingRequestInput {
  return {
    requestId: args.requestId,
    workspaceId: environmentPackage.scope.workspaceId,
    threadId: environmentPackage.scope.threadId,
    raisingTurnId: environmentPackage.scope.turnId,
    requestItemId: `it_work_input_${createHash('sha256').update(args.requestId).digest('hex').slice(0, 24)}`,
    kind: 'user-input',
    requesterKind: 'worker',
    agentId: environmentPackage.agent.agentId,
    agentSessionId: environmentPackage.scope.agentSessionId,
    responsibleUserId: responsibleUserIdForActor(environmentPackage.scope.triggerActor)!,
    questions: args.questions,
    questionDigest: `sha256:${createHash('sha256').update(canonicalJsonText(args.questions)).digest('hex')}`,
    now,
  };
}

/** Validates request arguments, duplicate identity, and the bound before admitting an MCP call. */
export function preflightWorkRequestInput(
  environmentPackage: AgentEnvironmentPackage,
  workspaceDb: WorkspaceDb,
  args: Record<string, unknown>
) {
  const parsed = WorkRequestInputArgsSchema.safeParse(args);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  if (parsed.data.questions.some((question) => question.isSecret))
    throw new WorkerControlGatewayError(
      'secret_input_not_supported',
      'Secret input is not supported.',
      400
    );
  try {
    const existing = preflightPendingRequest(
      workspaceDb.sqlite,
      workRaiseInput(environmentPackage, parsed.data, new Date().toISOString())
    );
    return existing ? pendingToolResult('pending-input', existing.requestId) : null;
  } catch (error) {
    if (error instanceof PendingRequestCommandError)
      throw new WorkerControlGatewayError(error.code, error.message, error.status);
    throw error;
  }
}
