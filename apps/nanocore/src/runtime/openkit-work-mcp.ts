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
import { createArtifactReview } from '../artifact-reviews.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import { readWorkerContextPackageTrace } from '../context/worker-context-package.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  ArtifactAuthorityError,
  type FsStore,
} from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { findSchedulerAdmissionForWorkerLineage } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import { pendingToolResult, raiseRecordedPendingRequest } from './pending-request-flow.js';
import {
  canonicalJsonText,
  PendingRequestCommandError,
  preflightPendingRequest,
  type RaisePendingRequestInput,
} from './pending-requests.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import { requireWorkerCredentialCheckValues } from './worker-credential-guard.js';
import {
  MAX_WORKER_ARTIFACT_BYTES,
  validateWorkerArtifactPath,
  type WorkerArtifactCapture,
} from './worker-governance-backend.js';
import { MCP_RESULT_TOO_LARGE_MESSAGE } from './worker-mcp-gateway.js';
import { preflightArtifactTuple, prepareWorkerArtifact } from './worker-transcript.js';

/** Reserved built-in Worker MCP server supplied to every worker AgentSession. */
export const OPENKIT_WORK_MCP_ID = 'openkit-work';

const WorkRequestInputArgsSchema = z
  .object({
    requestId: RequestIdSchema,
    prompt: z.string().min(1),
    questions: z.array(UserInputQuestionSchema).min(1),
  })
  .strip();

/** Bounded model metadata; scope, digest, bytes and physical target remain trusted. */
const WorkSubmitArtifactArgsSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !value.startsWith('import-lineage:'), {
        message: 'requestId uses reserved imported-history proof',
      }),
    path: z.string().min(1).max(4096),
    kind: z.enum(['report', 'diff', 'file', 'summary']),
    title: z.string().min(1),
    mediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
    materialProposal: z
      .object({
        materialId: z.string().min(1),
        baseRevisionId: z.string().min(1),
        baseContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
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
  {
    name: 'work_submit_artifact',
    description:
      'Submit one finished file from an eligible output root. Finish writing first. Success returns the durable Artifact id; correction or a new file version uses a new requestId. Read the eligible roots in this package guidance. Admitted media: text/markdown, text/plain, application/json.',
    inputSchema: mcpInputSchema(WorkSubmitArtifactArgsSchema),
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
    readonly captureArtifact?: WorkerArtifactCapture;
    readonly signal?: AbortSignal;
    readonly requireAdmission?: () => void;
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
  if (toolName === 'work_submit_artifact') {
    try {
      return await submitArtifact(input, args);
    } catch (error) {
      if (error instanceof ArtifactAuthorityError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      throw error;
    }
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
        ) &&
          isThreadIdVisible(
            input.store,
            peer.workspaceId,
            peer.threadId,
            responsibleUserId,
            admission.serverAdminTokenId !== null
          )
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
      throw new OperationError(error.code, error.message, error.status, { cause: error });
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
      throw new OperationError(error.code, error.message, error.status, { cause: error });
    throw error;
  }
}

/** Captures once, then publishes a complete request-owned tuple before acknowledging the id. @param input Authenticated owners/capture. @param args Model metadata. @returns Durable id, never a transport acknowledgement. */
async function submitArtifact(
  input: Parameters<typeof dispatchOpenkitWorkTool>[0],
  args: Record<string, unknown>
) {
  const parsed = WorkSubmitArtifactArgsSchema.safeParse(args);
  if (!parsed.success)
    throw new OperationError('invalid_request', 'Artifact submission metadata is invalid.', 400);
  const metadata = parsed.data;
  const { store, workspaceDb, environmentPackage, coreDb } = input;
  const { scope } = environmentPackage;
  try {
    validateWorkerArtifactPath(environmentPackage, metadata.path);
  } catch {
    throw new OperationError(
      'invalid_request',
      'Choose one canonical file strictly inside an eligible output root.',
      400
    );
  }
  const commandScope = {
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    packageSnapshotId: environmentPackage.snapshotId,
  };
  const identity = canonicalJsonText([
    environmentPackage.snapshotId,
    scope.turnId,
    metadata.requestId,
  ]);
  const artifactId = `worker-artifact-${createHash('sha256').update(identity).digest('hex')}`;
  const inputHash = createHash('sha256').update(canonicalJsonText(metadata)).digest('hex');
  const replay = () => {
    const receipt = store.getCommandRequest(
      'artifact.submit',
      metadata.requestId,
      commandScope,
      workspaceDb
    );
    const existing = store.listArtifacts(scope.workspaceId).find((a) => a.id === artifactId);
    if (receipt) {
      if (receipt.inputHash !== inputHash)
        throw new OperationError(
          'idempotency_key_conflict',
          'The request was already used with different submission metadata.',
          409
        );
      const sourceTurn = store.getTurnById(scope.turnId);
      if (
        sourceTurn.agentId !== environmentPackage.agent.agentId ||
        sourceTurn.agentSessionId !== scope.agentSessionId ||
        !existing ||
        receipt.response.kind !== 'artifact' ||
        receipt.response.id !== artifactId ||
        existing.origin.requestId !== metadata.requestId ||
        existing.origin.kind !== 'turn-output' ||
        existing.turnId !== scope.turnId ||
        existing.threadId !== scope.threadId ||
        existing.origin.turnId !== scope.turnId ||
        existing.origin.threadId !== scope.threadId ||
        existing.content.format !==
          (metadata.mediaType === 'text/markdown'
            ? 'markdown'
            : metadata.mediaType === 'text/plain'
              ? 'text'
              : 'json') ||
        existing.updatedAt !== existing.createdAt ||
        existing.kind !== metadata.kind ||
        existing.version !== 1 ||
        existing.lastMutationRequestId !== metadata.requestId ||
        existing.createdAt !== receipt.createdAt ||
        existing.contentDigest !==
          `sha256:${createHash('sha256').update(existing.content.body, 'utf8').digest('hex')}`
      )
        throw new OperationError(
          'recovery_required',
          'Artifact receipt and authority disagree.',
          409
        );
      preflightArtifactTuple(store, workspaceDb, existing, {
        artifactId,
        artifactVersion: 1,
        contentDigest: existing.contentDigest,
        sourceThreadId: scope.threadId,
        sourceTurnId: scope.turnId,
        sourceAgentId: environmentPackage.agent.agentId,
        materialProposal: metadata.materialProposal ?? null,
        createdAt: existing.createdAt,
      });

      return artifactResult(artifactId);
    }
    if (
      existing ||
      store
        .listThreadItems(scope.workspaceId, scope.threadId)
        .some((item) => item.type === 'artifact-reference' && item.artifactId === artifactId) ||
      workspaceDb.sqlite
        .prepare('SELECT 1 FROM artifact_reviews WHERE artifact_id = ?')
        .get(artifactId)
    )
      throw new OperationError(
        'recovery_required',
        'Submission authority exists without its receipt.',
        409
      );
    return null;
  };
  const replayResult = replay();
  if (replayResult) return replayResult;
  const admit = () => {
    input.signal?.throwIfAborted();
    input.requireAdmission?.();
    const turn = store.getTurnById(scope.turnId);
    if (
      turn.status !== 'running' ||
      turn.agentSessionId !== scope.agentSessionId ||
      turn.agentId !== environmentPackage.agent.agentId ||
      getWorkerControlAcceptedFinalStatus(coreDb, {
        agentSessionId: scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: scope.requestId ?? null,
        threadId: scope.threadId,
        turnId: scope.turnId,
        workspaceId: scope.workspaceId,
      })
    )
      throw new WorkerControlGatewayError(
        'turn_not_active',
        'The Turn no longer admits publication.',
        409
      );
  };
  const published = () =>
    store
      .listArtifacts(scope.workspaceId)
      .filter((a) => a.origin.kind === 'turn-output' && a.turnId === scope.turnId)
      .reduce((n, a) => n + Buffer.byteLength(a.content.body, 'utf8'), 0);
  admit();
  if (!input.captureArtifact)
    throw new OperationError('recovery_required', 'Artifact capture is unavailable.', 503);
  const recordedAt = new Date().toISOString();
  const captured = await input.captureArtifact({
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: metadata.requestId,
    path: metadata.path,
    maxByteLength: Math.max(0, MAX_WORKER_ARTIFACT_BYTES - published()) + 1,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  admit();
  if (captured.bytes.length + published() > MAX_WORKER_ARTIFACT_BYTES)
    throw new OperationError(
      'invalid_request',
      'The file exceeds remaining published Artifact capacity.',
      400
    );
  const contextPackageTrace = metadata.materialProposal
    ? readWorkerContextPackageTrace({
        authorities: createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb }),
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        turnId: scope.turnId,
        workspaceRoot: resolveDataRootPath(workspaceDb.dataRoot, 'workspaces', scope.workspaceId),
      })
    : undefined;
  const prepared = prepareWorkerArtifact({
    store,
    workspaceDb,
    environmentPackage,
    artifactId,
    requestId: metadata.requestId,
    recordedAt,
    metadata,
    bytes: captured.bytes,
    checkValues: requireWorkerCredentialCheckValues(captured.credentialCheckValues),
    ...(contextPackageTrace ? { contextPackageTrace } : {}),
  });
  // Another caller may have completed while capture awaited. Never roll back that caller's tuple.
  const completedDuringCapture = replay();
  if (completedDuringCapture) return completedDuringCapture;
  // No await in the final admission/publication segment: a terminalizer or another publisher cannot interleave.
  admit();
  if (captured.bytes.length + published() > MAX_WORKER_ARTIFACT_BYTES)
    throw new OperationError(
      'invalid_request',
      'The file exceeds remaining published Artifact capacity.',
      400
    );
  try {
    store.createArtifact(prepared.artifact);
    workspaceDb.sqlite.transaction(() => {
      createArtifactReview(workspaceDb, prepared.reviewInput);
      store.recordCommandRequest(
        {
          command: 'artifact.submit',
          requestId: metadata.requestId,
          scope: commandScope,
          inputHash,
          response: { kind: 'artifact', id: artifactId },
          createdAt: recordedAt,
        },
        workspaceDb
      );
    })();
  } catch (error) {
    store.rollbackArtifactCreation(artifactId);
    throw error;
  }
  // Project only already committed authority; a listener may seal the Turn during delivery.
  const reference = store
    .listThreadItems(scope.workspaceId, scope.threadId)
    .find((item) => item.type === 'artifact-reference' && item.artifactId === artifactId)!;
  const eventScope = {
    requestId: metadata.requestId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    workspaceId: scope.workspaceId,
  };
  store.emitTurnEvent(
    scope.turnId,
    { ...eventScope, event: 'item.created', data: { type: 'item-created', item: reference } },
    ALREADY_DECIDED_PUBLICATION_ADMISSION
  );
  store.emitTurnEvent(
    scope.turnId,
    {
      ...eventScope,
      event: 'item.completed',
      data: { type: 'item-completed', item: reference, itemId: reference.id },
    },
    ALREADY_DECIDED_PUBLICATION_ADMISSION
  );
  store.emitTurnEvent(
    scope.turnId,
    {
      ...eventScope,
      event: 'artifact.created',
      data: { type: 'artifact-created', artifact: prepared.artifact },
    },
    ALREADY_DECIDED_PUBLICATION_ADMISSION
  );
  return artifactResult(artifactId);
}

/** Formats the already committed identity for native MCP clients. @param artifactId Canonical id. @returns Successful MCP result. */
function artifactResult(artifactId: string) {
  return {
    isError: false,
    content: [{ type: 'text' as const, text: JSON.stringify({ artifactId }) }],
    structuredContent: { artifactId } as Record<string, unknown>,
  };
}
