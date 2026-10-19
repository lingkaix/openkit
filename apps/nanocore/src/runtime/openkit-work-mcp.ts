import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  KnowledgeAskRequestSchema,
  KnowledgeTellRequestSchema,
  ListThreadItemsResponseSchema,
  operationToolName,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  deriveEntityId,
  isSealedTurnTerminal,
  MAX_ARTIFACT_FILE_BYTES,
  ProductTurnSchema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import type { z } from 'zod';
import { createArtifactReview } from '../artifact-reviews.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { searchPdfSourceSnapshot } from '../context/pdf-source-representation.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import { readWorkerContextPackageTrace } from '../context/worker-context-package.js';
import {
  readWorkerSourceSnapshot,
  resolveCurrentWorkerSource,
  type WorkerSourceReadResult,
} from '../context/worker-source-read.js';
import { viewWorkerSourceSnapshot } from '../context/worker-source-vision.js';
import { uuidv5 } from '../generative-kernel/uuid.js';
import type {
  NotebookPublicationAdmission,
  NotebookUpdate,
} from '../knowledge/notebook-publication.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  ArtifactAuthorityError,
  type FsStore,
} from '../lib/store.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
} from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { findSchedulerAdmissionForWorkerLineage } from '../scheduler-records.js';
import {
  FileAdmissionError,
  type FileStorageAdmission,
} from '../storage/artifacts/file-admission.js';
import {
  ArtifactPayloadCleanupError,
  stageArtifactPayload,
} from '../storage/artifacts/file-payload.js';
import { withCanonicalFileWriteAdmission } from '../storage/canonical-write-capacity.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import {
  OPENKIT_WORK_TOOL_DEFINITIONS,
  WorkReadPeerArgsSchema,
  WorkReadSourceArgsSchema,
  WorkRequestInputArgsSchema,
  WorkSearchSourceArgsSchema,
  WorkSubmitArtifactArgsSchema,
  WorkViewSourceArgsSchema,
} from './openkit-work-supply.js';
import { pendingToolResult, raiseRecordedPendingRequest } from './pending-request-flow.js';
import {
  canonicalJsonText,
  PendingRequestCommandError,
  preflightPendingRequest,
  type RaisePendingRequestInput,
} from './pending-requests.js';
import { assertWorkerArtifactDigestProof } from './worker-artifact-credential-scan.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import {
  createWorkerArtifactLiteralCheck,
  requireWorkerCredentialCheckValues,
} from './worker-credential-guard.js';
import {
  validateWorkerArtifactPath,
  type WorkerArtifactCapture,
} from './worker-governance-backend.js';
import { MCP_RESULT_TOO_LARGE_MESSAGE } from './worker-mcp-gateway.js';
import { preflightArtifactTuple, prepareWorkerArtifact } from './worker-transcript.js';

export {
  createOpenkitWorkMcpSupply,
  OPENKIT_WORK_CATALOG_DIGEST,
  OPENKIT_WORK_MCP_ID,
  OPENKIT_WORK_TOOL_DEFINITIONS,
  OPENKIT_WORK_TOOLS,
} from './openkit-work-supply.js';

// Stateless handles contain no reversible identity and have no retained per-peer state.
// The running-Turn admission and HMAC scope expire them at the Turn boundary; restart also invalidates them.
// This key is never persisted or supplied to a worker.
const peerHandleKey = randomBytes(32);

const workToolIdsByName = new Map(
  OPENKIT_WORK_TOOL_DEFINITIONS.map((tool) => [operationToolName(tool.name), tool.name])
);

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
    readonly fileAdmission?: FileStorageAdmission;
    readonly signal?: AbortSignal;
    readonly requireAdmission?: () => void;
    readonly knowledgeAgent?: OperationInvocationDependencies['knowledgeAgent'];
    readonly automationStore?: OperationInvocationDependencies['automationStore'];
    readonly turnStartServices?: OperationInvocationDependencies['turnStartServices'];
    readonly knowledgeCallId?: string;
    readonly knowledgePublicationAdmission?: (
      request: NotebookUpdate
    ) => NotebookPublicationAdmission;
  },
  toolName: string,
  args: Record<string, unknown>
) {
  const toolId = workToolIdsByName.get(toolName);
  if (!toolId) {
    throw new WorkerControlGatewayError('capability_denied', 'Work Tool is unavailable.', 403);
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
  if (toolId === 'work.source.read') return readSource(input, args);
  if (toolId === 'work.source.search') return searchSource(input, args);
  if (toolId === 'work.source.view') return viewSource(input, args);
  if (toolId === 'automation.event-admit') {
    input.requireAdmission?.();
    if (!input.automationStore || !input.turnStartServices)
      throw new OperationError(
        'scheduler_unavailable',
        'Scheduled event admission is unavailable.',
        503
      );
    const invoke = createOperationInvocation({
      coreDb: input.coreDb,
      store: input.store,
      automationStore: input.automationStore,
      turnStartServices: input.turnStartServices,
      workspaceMutationAdmission: input.automationStore.mutationAdmission,
    });
    const result = await invoke('automation.event-admit', args, {
      kind: 'worker',
      actor: scope.triggerActor,
      lineage: { ...scope, packageSnapshotId: input.environmentPackage.snapshotId },
      requestId: uuidv5(
        JSON.stringify(['automation.event-admit', scope.turnId, input.knowledgeCallId])
      ),
      bindings: {
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        turnId: scope.turnId,
      },
      delivery: 'model',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>,
      isError: false,
    };
  }
  if (toolId === 'knowledge.ask' || toolId === 'knowledge.tell') {
    input.requireAdmission?.();
    if (!input.knowledgeAgent || !input.knowledgeCallId)
      throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
    const admission = findSchedulerAdmissionForWorkerLineage(input.coreDb, {
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      turnId: scope.turnId,
      agentSessionId: scope.agentSessionId,
      packageSnapshotId: input.environmentPackage.snapshotId,
    });
    // Reuse the admitted real bearer lineage; Workspace authority alone cannot grant Server access.
    const serverKnowledgeActor =
      admission?.serverAdminTokenId && admission.triggerActor.kind === 'user'
        ? {
            kind: 'token' as const,
            userId: admission.triggerActor.id,
            tokenId: admission.serverAdminTokenId,
            tokenScope: 'server-admin' as const,
          }
        : undefined;
    const signal = input.signal ?? new AbortController().signal;
    const result =
      toolId === 'knowledge.ask'
        ? await input.knowledgeAgent.ask({
            ...KnowledgeAskRequestSchema.omit({ workspaceId: true }).parse(args),
            workspaceId: scope.workspaceId,
            caller: 'worker',
            capabilityCallId: input.knowledgeCallId,
            access: {
              store: input.store,
              coreDb: input.coreDb,
              actor: scope.triggerActor,
              ...(serverKnowledgeActor
                ? { serverKnowledgeActor, requestActor: serverKnowledgeActor }
                : {}),
              outputThreadId: scope.threadId,
              outputTurnId: scope.turnId,
            },
            signal,
            assertCurrent: () => {
              input.requireAdmission?.();
            },
          })
        : await input.knowledgeAgent.maintain({
            ...KnowledgeTellRequestSchema.omit({ workspaceId: true, requestId: true }).parse(args),
            workspaceId: scope.workspaceId,
            requestId: uuidv5(JSON.stringify(['knowledge.tell', input.knowledgeCallId])),
            instructions:
              'Integrate the supplied information and keep the notebook overview current.',
            trigger: 'request',
            actor: scope.triggerActor,
            signal,
            ...(serverKnowledgeActor ? { requestActor: serverKnowledgeActor } : {}),
            askingThreadId: scope.threadId,
            askingTurnId: scope.turnId,
            currentAdmission: input.knowledgePublicationAdmission,
            tellContent: KnowledgeTellRequestSchema.omit({
              workspaceId: true,
              requestId: true,
            }).parse(args).content,
          });
    input.requireAdmission?.();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>,
      isError: false,
    };
  }
  if (toolId === 'work.artifact.submit') {
    try {
      return await submitArtifact(input, args);
    } catch (error) {
      if (error instanceof ArtifactAuthorityError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      throw error;
    }
  }
  if (toolId === 'work.peer.list' || toolId === 'work.peer.read') {
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
    if (toolId === 'work.peer.list') {
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

/** Searches an exact current PDF representation under the accepted reference and current source authority. */
async function searchSource(
  input: Parameters<typeof dispatchOpenkitWorkTool>[0],
  args: Record<string, unknown>
) {
  const parsed = WorkSearchSourceArgsSchema.safeParse(args);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  try {
    const selected = await resolveCurrentWorkerSource(input, parsed.data.path);
    if (!selected.source) throw new Error('Selected PDF is unavailable.');
    const projection = await searchPdfSourceSnapshot({
      ...selected,
      source: selected.source,
      dataRoot: input.workspaceDb.dataRoot,
      admission: input.fileAdmission,
      query: { mode: parsed.data.mode, query: parsed.data.query, limit: parsed.data.limit },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    selected.assertCurrent();
    return sourceToolResult({ ...projection });
  } catch {
    return sourceToolResult({
      status: 'unavailable',
      reason: input.signal?.aborted ? 'cancelled' : 'unavailable',
    });
  }
}

/** Serializes bounded source facts without exposing private exceptions or a fabricated handle. */
function sourceToolResult(projection: Record<string, unknown>) {
  const result = {
    isError: false,
    structuredContent: projection,
    content: [{ type: 'text' as const, text: JSON.stringify(projection) }],
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 512 * 1024)
    throw new WorkerControlGatewayError('mcp-result-too-large', MCP_RESULT_TOO_LARGE_MESSAGE, 413);
  return result;
}

/** Returns one explicit view through standard MCP image carriage, without metadata-only structuredContent that can hide the image in stock carriers. */
async function viewSource(
  input: Parameters<typeof dispatchOpenkitWorkTool>[0],
  args: Record<string, unknown>
) {
  const parsed = WorkViewSourceArgsSchema.safeParse(args);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  try {
    if (!input.fileAdmission)
      return sourceToolResult({ status: 'unavailable', reason: 'unavailable' });
    const selected = await resolveCurrentWorkerSource(input, parsed.data.path);
    if (!selected.source) return sourceToolResult({ status: 'unavailable', reason: 'unsupported' });
    const view = await viewWorkerSourceSnapshot({
      ...selected,
      source: selected.source,
      admission: input.fileAdmission,
      page: parsed.data.page,
      crop: parsed.data.crop,
      signal: input.signal,
    });
    selected.assertCurrent();
    if (view.status === 'unavailable') return sourceToolResult({ ...view });
    const { bytes, ...metadata } = view;
    const result: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/jpeg' }
      >;
    } = {
      isError: false,
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
      ],
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 512 * 1024)
      return sourceToolResult({ status: 'unavailable', reason: 'resource_limited' });
    input.signal?.throwIfAborted();
    selected.assertCurrent();
    return result;
  } catch {
    return sourceToolResult({
      status: 'unavailable',
      reason: input.signal?.aborted ? 'cancelled' : 'unavailable',
    });
  }
}

/** Reads one accepted source reference through existing current Worker and canonical source authority. */
async function readSource(
  input: Parameters<typeof dispatchOpenkitWorkTool>[0],
  args: Record<string, unknown>
) {
  const parsed = WorkReadSourceArgsSchema.safeParse(args);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'MCP tool arguments are invalid.', {
      code: 'mcp-call-failed',
    });
  let projection: WorkerSourceReadResult;
  try {
    const selected = await resolveCurrentWorkerSource(input, parsed.data.path);
    projection = await readWorkerSourceSnapshot({
      ...selected,
      mode: parsed.data.mode,
      cursor: parsed.data.cursor,
      signal: input.signal,
    });
    selected.assertCurrent();
  } catch {
    projection = {
      status: 'unavailable',
      reason: input.signal?.aborted ? 'cancelled' : 'unavailable',
    };
  }
  return sourceToolResult({ ...projection });
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
    requestItemId: deriveEntityId('it', [args.requestId, 'request']),
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
  const artifactId = deriveEntityId('ar', [
    environmentPackage.snapshotId,
    scope.turnId,
    metadata.requestId,
  ]);
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
        existing.content.format !== 'file' ||
        existing.content.mediaType !== metadata.mediaType ||
        existing.updatedAt !== existing.createdAt ||
        existing.kind !== metadata.kind ||
        existing.version !== 1 ||
        existing.lastMutationRequestId !== metadata.requestId ||
        existing.createdAt !== receipt.createdAt
      )
        throw new OperationError(
          'recovery_required',
          'Artifact receipt and authority disagree.',
          409
        );
      store.assertArtifactContent(existing);
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
  admit();
  if (!input.captureArtifact || !input.fileAdmission)
    throw new OperationError('recovery_required', 'Artifact capture is unavailable.', 503);
  const recordedAt = new Date().toISOString();
  // Reserve the future Artifact stage before capture; transport separately reserves its source
  // against this same owner, so the peak includes both copies without reserving either twice.
  const reservation = input.fileAdmission.reserve({
    stagingBytes: BigInt(MAX_ARTIFACT_FILE_BYTES),
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 65_536n,
  });
  let captured: Awaited<ReturnType<WorkerArtifactCapture>> | undefined;
  let staged: Awaited<ReturnType<typeof stageArtifactPayload>> | undefined;
  let cleanupUnproved = false;
  const failures: unknown[] = [];
  let response: ReturnType<typeof artifactResult> | undefined;
  try {
    captured = await input.captureArtifact({
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: metadata.requestId,
      path: metadata.path,
      maxByteLength: MAX_ARTIFACT_FILE_BYTES + 1,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    admit();
    if (captured.byteLength > MAX_ARTIFACT_FILE_BYTES)
      throw new FileAdmissionError('file_too_large');
    reservation.reduceTo(BigInt(captured.byteLength) + 65_536n);
    const checkValues = requireWorkerCredentialCheckValues(captured.credentialCheckValues);
    staged = await stageArtifactPayload({
      workspaceRoot: resolveDataRootPath(workspaceDb.dataRoot, 'workspaces', scope.workspaceId),
      source: captured.source,
      expectedByteLength: captured.byteLength,
      expectedDigest: captured.contentDigest,
      reservation,
      inspectChunk: createWorkerArtifactLiteralCheck(checkValues),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await assertWorkerArtifactDigestProof({
      dataRoot: workspaceDb.dataRoot,
      ownerRoot: resolveDataRootPath(workspaceDb.dataRoot, 'workspaces', scope.workspaceId),
      payload: staged,
      evidence: checkValues,
      ...(input.signal ? { signal: input.signal } : {}),
    });
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
      payload: staged,
      checkValues,
      ...(contextPackageTrace ? { contextPackageTrace } : {}),
    });
    // Another caller may have completed while capture awaited. Never roll back that caller's tuple.
    const completedDuringCapture = replay();
    if (completedDuringCapture) response = completedDuringCapture;
    else {
      // No await in the final admission/publication segment: a terminalizer or another publisher cannot interleave.
      admit();
      reservation.assertAvailable();
      withCanonicalFileWriteAdmission(input.fileAdmission, () => {
        try {
          store.createArtifact(prepared.artifact, staged);
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
        response = artifactResult(artifactId);
      });
    }
  } catch (error) {
    cleanupUnproved = error instanceof ArtifactPayloadCleanupError;
    failures.push(error);
  }
  // Attempt both cleanups even if one fails. Preserve the original failure and keep capacity
  // when any private stage remains unproved; accepted Artifact authority is never rolled back here.
  for (const source of [staged, captured]) {
    try {
      await source?.remove();
    } catch (error) {
      cleanupUnproved = true;
      failures.push(error);
    }
  }
  if (!cleanupUnproved) reservation.release();
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new ArtifactPayloadCleanupError(failures);
  if (!response)
    throw new OperationError('recovery_required', 'Artifact acknowledgement is unavailable.', 503);
  return response;
}

/** Formats the already committed identity for native MCP clients. @param artifactId Canonical id. @returns Successful MCP result. */
function artifactResult(artifactId: string) {
  return {
    isError: false,
    content: [{ type: 'text' as const, text: JSON.stringify({ artifactId }) }],
    structuredContent: { artifactId } as Record<string, unknown>,
  };
}
