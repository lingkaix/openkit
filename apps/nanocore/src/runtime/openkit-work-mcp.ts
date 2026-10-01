import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { ListThreadItemsResponseSchema } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  isSealedTurnTerminal,
  ProductTurnSchema,
  RequestIdSchema,
  responsibleUserIdForActor,
  UserInputQuestionSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { findSchedulerAdmissionForWorkerLineage } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { pendingToolResult, raiseRecordedPendingRequest } from './pending-request-flow.js';
import {
  canonicalJsonText,
  PendingRequestCommandError,
  preflightPendingRequest,
  type RaisePendingRequestInput,
} from './pending-requests.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';
import { MCP_RESULT_TOO_LARGE_MESSAGE } from './worker-mcp-gateway.js';

/** Reserved built-in Worker MCP server supplied to every worker AgentSession. */
export const OPENKIT_WORK_MCP_ID = 'openkit-work';

const WorkRequestInputArgsSchema = z
  .object({
    requestId: RequestIdSchema,
    prompt: z.string().min(1),
    questions: z.array(UserInputQuestionSchema).min(1),
  })
  .strip();

const WorkListPeersArgsSchema = z.object({}).strip();
const WorkReadPeerArgsSchema = z
  .object({
    handle: z.string().min(1),
    cursor: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .default('0'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strip();

// Stateless handles contain no reversible identity and have no retained per-peer state.
// The running-Turn admission and HMAC scope expire them at the Turn boundary; restart also invalidates them.
// This key is never persisted or supplied to a worker.
const peerHandleKey = randomBytes(32);

function mcpInputSchema(schema: z.ZodType): Record<string, unknown> {
  const projection = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete projection.$schema;
  return projection;
}

/** Fixed built-in work tools; their schemas ignore inert additive input members. */
export const OPENKIT_WORK_TOOLS = [
  {
    name: 'work_request_input',
    description:
      'Ask the responsible user one or more non-secret questions. The answer arrives on a later Turn. Recording the question is the result of this call.',
    inputSchema: mcpInputSchema(WorkRequestInputArgsSchema),
  },
  {
    name: 'work_list_peers',
    description:
      'List other AgentSessions currently in your Sandbox through opaque handles valid only within this Turn. Thread metadata requires current read access.',
    inputSchema: mcpInputSchema(WorkListPeersArgsSchema),
  },
  {
    name: 'work_read_peer',
    description:
      'Read recent product Turns and Items for one current peer. Results are newest first; use nextCursor for older records. This does not control or change the peer.',
    inputSchema: mcpInputSchema(WorkReadPeerArgsSchema),
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
 * Dispatches the built-in work tools under the existing authenticated MCP admission.
 *
 * @param input Authenticated package and open workspace database.
 * @param toolName Tool admitted by the fixed built-in supply.
 * @param args Untrusted tool arguments.
 * @returns MCP tool result with isError false.
 */
export async function dispatchOpenkitWorkTool(
  input: {
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly coreDb: CoreDb;
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
  },
  toolName: string,
  args: Record<string, unknown>
) {
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
  if (toolName === 'work_list_peers' || toolName === 'work_read_peer') {
    const peers = input.coreDb.sqlite
      .prepare(`
      SELECT peer.agent_session_runtime_binding_id AS bindingId,
             peer.agent_session_id AS agentSessionId, peer.workspace_id AS workspaceId,
             peer.thread_id AS threadId, peer_harness.adapter_id AS runtime
      FROM agent_session_runtime_bindings caller
      JOIN harness_instance_records caller_harness ON caller_harness.harness_instance_id = caller.harness_instance_id
      JOIN harness_instance_records peer_harness ON peer_harness.sandbox_runtime_id = caller_harness.sandbox_runtime_id
      JOIN agent_session_runtime_bindings peer ON peer.harness_instance_id = peer_harness.harness_instance_id
      WHERE caller.agent_session_id = ? AND peer.agent_session_id <> caller.agent_session_id
      ORDER BY peer.agent_session_runtime_binding_id
    `)
      .all(scope.agentSessionId) as Array<{
      bindingId: string;
      agentSessionId: string;
      workspaceId: string;
      threadId: string;
      runtime: string;
    }>;
    const handleFor = (bindingId: string) =>
      createHmac('sha256', peerHandleKey)
        .update(JSON.stringify([scope.turnId, scope.agentSessionId, bindingId]))
        .digest('base64url');
    // The MCP Gateway already admitted this exact lineage; retain its current bearer context for the peer Workspace.
    const admission = findSchedulerAdmissionForWorkerLineage(input.coreDb, {
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      turnId: scope.turnId,
      agentSessionId: scope.agentSessionId,
      packageSnapshotId: input.environmentPackage.snapshotId,
    })!;
    const canRead = (peer: (typeof peers)[number]) =>
      Boolean(
        currentSchedulerAdmissionWorkspaceAuthority(
          input.coreDb,
          { ...admission, workspaceId: peer.workspaceId },
          'thread.read',
          true
        ) && isThreadIdVisible(input.store, peer.workspaceId, peer.threadId, responsibleUserId)
      );
    let projection: Record<string, unknown>;
    if (toolName === 'work_list_peers') {
      projection = {
        peers: peers.map((peer) => ({
          handle: handleFor(peer.bindingId),
          agentId: input.store.getAgentSession(peer.agentSessionId).agentId,
          runtime: peer.runtime,
          ...(canRead(peer)
            ? {
                title: input.store.getThread(peer.workspaceId, peer.threadId).name,
                activeTurn: input.store
                  .listThreadTurns(peer.workspaceId, peer.threadId)
                  .some((candidate) => !isSealedTurnTerminal(candidate.status)),
              }
            : {}),
        })),
      };
    } else {
      const parsed = WorkReadPeerArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'MCP tool arguments are invalid.',
          {
            code: 'mcp-call-failed',
          }
        );
      }
      const { handle, cursor, limit } = parsed.data;
      const peer = peers.find((candidate) => handleFor(candidate.bindingId) === handle);
      if (!peer || !canRead(peer)) {
        throw new WorkerControlGatewayError('peer_not_found', 'Peer not found.', 404);
      }
      const offset = Number(cursor);
      const turns = input.store.listThreadTurns(peer.workspaceId, peer.threadId).toReversed();
      const items = input.store
        .listThreadItems(peer.workspaceId, peer.threadId)
        .filter((item) =>
          ['user-message', 'assistant-message', 'plan', 'tool-call', 'status'].includes(item.type)
        )
        .toReversed();
      projection = {
        turns: turns.slice(offset, offset + limit).map((record) => {
          // The ordinary Thread dashboard's schema owns identity redaction.
          // Items are paged separately so a Turn cannot smuggle its complete nested history.
          const { id, status, triggerActor, triggerSource, startedAt, completedAt } =
            ProductTurnSchema.parse({ ...record, items: [] });
          return { id, status, triggerActor, triggerSource, startedAt, completedAt };
        }),
        ...ListThreadItemsResponseSchema.parse({
          items: items.slice(offset, offset + limit),
          nextCursor:
            offset + limit < Math.max(turns.length, items.length) ? String(offset + limit) : null,
        }),
      };
    }
    const result = {
      isError: false,
      structuredContent: projection,
      content: [{ type: 'text' as const, text: JSON.stringify(projection) }],
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 512 * 1024) {
      throw new WorkerControlGatewayError(
        'mcp-result-too-large',
        MCP_RESULT_TOO_LARGE_MESSAGE,
        413
      );
    }
    return result;
  }
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
