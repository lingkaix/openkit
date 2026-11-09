import { createHash } from 'node:crypto';
import type { SteerTaskRequest, SteerTaskResponse } from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  deriveEntityId,
  ItemSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { auditAuthenticationFromActor } from '../auth/audit-attribution.js';
import type { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './idempotent-command.js';
import {
  type TaskSteerReceiptMetadata,
  TaskSteerReceiptMetadataSchema,
  taskSteerCausation,
  taskSteerRefusal,
} from './task-steer-receipt.js';
import type { TurnExecutor } from './types.js';

/** Names one submitted instruction independently of its text and addressed Turn, so changed replay conflicts. */
export function taskSteerInputItemId(
  input: Pick<SteerTaskRequest, 'workspaceId' | 'threadId' | 'requestId'>,
  actorId: string
): string {
  return deriveEntityId('it', {
    command: 'task.steer',
    actorId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestId: input.requestId,
  });
}

/** Executes the accepted Task live-steer lifecycle through existing Item, command receipt and Harness owners. */
export async function steerTask(
  dependencies: {
    readonly store: FsStore;
    readonly turnExecutor: TurnExecutor | undefined;
    readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  },
  input: SteerTaskRequest,
  context: AdmittedOperationContext
): Promise<SteerTaskResponse> {
  const { store, turnExecutor } = dependencies;
  const actor = publicOperationActor(context);
  const itemActor = { kind: 'user', id: actor.userId } as const;
  const scope = { workspaceId: input.workspaceId, threadId: input.threadId, actorId: actor.userId };
  const commandInput = {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    input: input.input,
  };
  const inputHash = commandInputHash(commandInput);
  const inputItemId = taskSteerInputItemId(input, actor.userId);
  const target = {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    inputItemId,
  };
  const failure = (code: string, message: string) =>
    new OperationError(code, message, 409, { details: target });
  const replay = (
    record: NonNullable<ReturnType<FsStore['getCommandRequest']>>
  ): SteerTaskResponse => {
    const metadata = TaskSteerReceiptMetadataSchema.strip().safeParse(
      record.response.steerMetadata
    );
    if (
      !metadata.success ||
      record.response.kind !== 'turn' ||
      record.response.id !== input.turnId ||
      metadata.data.turnId !== input.turnId ||
      metadata.data.inputItemId !== inputItemId ||
      metadata.data.inputHash !== inputHash
    )
      throw failure('steer_outcome_unknown', 'Steer delivery cannot be proved.');
    if (metadata.data.disposition === 'accepted') return { ...target, delivery: 'accepted' };
    if (metadata.data.disposition === 'refused' && metadata.data.refusal) {
      const refusal = metadata.data.refusal;
      throw new OperationError(refusal.code, refusal.message, refusal.status, { details: target });
    }
    if (
      metadata.data.disposition === 'refused' &&
      metadata.data.reason === 'workspace_access_denied'
    )
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403, {
        details: target,
      });
    throw failure(
      metadata.data.disposition === 'unknown'
        ? 'steer_outcome_unknown'
        : metadata.data.reason === 'unsupported'
          ? 'steer_unsupported'
          : metadata.data.reason === 'busy'
            ? 'steer_busy'
            : 'steer_target_stale',
      metadata.data.disposition === 'unknown'
        ? 'Steer delivery cannot be proved.'
        : 'The instruction was not delivered to the addressed Turn.'
    );
  };
  return runIdempotentCommand({
    store,
    inflightCommands: dependencies.inflightCommands,
    command: 'task.steer',
    requestId: input.requestId,
    scope,
    input: commandInput,
    responseKind: 'turn',
    replay,
    responseId: () => input.turnId,
    execute: async (receipt) => {
      const existing = store.readThreadTimelineSnapshot(
        input.workspaceId,
        input.threadId,
        (snapshot) => (snapshot.position(inputItemId) ? snapshot.item(inputItemId) : null)
      );
      if (existing) {
        if (
          existing.type !== 'user-message' ||
          existing.turnId !== input.turnId ||
          existing.text !== input.input ||
          existing.actor.kind !== 'user' ||
          existing.actor.id !== actor.userId ||
          existing.causationId !== taskSteerCausation(input.requestId)
        )
          throw new IdempotencyKeyConflictError();
        throw failure(
          'steer_outcome_unknown',
          'The retained instruction has no completed delivery receipt.'
        );
      }
      const assertTarget = () => {
        const lineage = store.getTurnLineage(input.turnId);
        if (
          !lineage ||
          lineage.workspaceId !== input.workspaceId ||
          lineage.threadId !== input.threadId
        )
          throw new OperationError('turn_not_found', 'Turn not found.', 404);
        const turn = store.getTurnMetadata(input.workspaceId, input.threadId, input.turnId);
        if (
          workspaceIdForOwner(turn.owner) !== input.workspaceId ||
          turn.threadId !== input.threadId
        )
          throw new OperationError('turn_not_found', 'Turn not found.', 404);
        if (
          turn.status !== 'running' ||
          !turn.agentSessionId ||
          turn.agentId === 'goal-coordinator'
        )
          throw failure(
            'steer_target_stale',
            'The addressed Task Turn has no exact running worker.'
          );
      };
      assertTarget();
      if (!turnExecutor?.steerTurn)
        throw failure('steer_unsupported', 'The runtime has no qualified live-steer boundary.');
      let correlation: { operationId: string; executionId: string } | undefined;
      let observed:
        | Pick<TaskSteerReceiptMetadata, 'disposition' | 'reason' | 'refusal'>
        | undefined;
      const recheck = async () => {
        await context.recheckAdmission?.();
        assertTarget();
      };
      const complete = async (
        result: Pick<TaskSteerReceiptMetadata, 'disposition' | 'reason' | 'refusal'>
      ) => {
        if (!correlation) throw new Error('Steer receipt requires its admitted original Item.');
        observed ??= result;
        result = observed;
        const retained = store.getCommandRequest('task.steer', input.requestId, scope);
        if (retained) return;
        const timestamp = new Date().toISOString();
        const { responseKind: _responseKind, ...originalReceipt } = receipt;
        await store.publishTaskSteerReceipt({
          receipt: {
            ...originalReceipt,
            command: 'task.steer',
            response: {
              kind: 'turn',
              id: input.turnId,
              steerMetadata: {
                turnId: input.turnId,
                inputItemId,
                inputHash,
                ...result,
                ...correlation,
              },
            },
          },
          audit: {
            id: allocateEntityId('aud'),
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: inputItemId,
            capabilityCallId: null,
            permissionDecisionId: null,
            vaultGrantId: null,
            requestId: input.requestId,
            actor: itemActor,
            authentication: auditAuthenticationFromActor(actor),
            subject: null,
            agentId: null,
            agentSessionId: null,
            category: 'command',
            action: 'task.steer',
            resource: `turn:${input.turnId}`,
            resourceRevision: null,
            outcome: result.disposition === 'accepted' ? 'succeeded' : 'failed',
            severity: 'info',
            summary: `Steer delivery ${result.disposition}.`,
            errorCode: null,
            createdAt: timestamp,
            occurredAt: timestamp,
          },
        });
      };
      try {
        await turnExecutor.steerTurn(
          store,
          { ...target, inputDigest: createHash('sha256').update(input.input).digest('hex') },
          {
            recheck,
            complete,
            admit: async (source) => {
              await recheck();
              const timestamp = new Date().toISOString();
              const item = ItemSchema.parse({
                id: inputItemId,
                owner: { kind: 'workspace', workspaceId: input.workspaceId },
                threadId: input.threadId,
                turnId: input.turnId,
                type: 'user-message',
                actor: itemActor,
                text: input.input,
                status: 'completed',
                createdAt: timestamp,
                completedAt: timestamp,
                causationId: taskSteerCausation(input.requestId),
              });
              // The native writer checks the exact Turn and synchronizes original bytes before acknowledging this append.
              await store.createItem(item);
              correlation = source;
              try {
                const event = await store.persistTurnEvent(input.turnId, {
                  event: 'item.completed',
                  workspaceId: input.workspaceId,
                  threadId: input.threadId,
                  turnId: input.turnId,
                  requestId: input.requestId,
                  data: { type: 'item-completed', itemId: inputItemId, item },
                });
                store.emitTurnEvent(input.turnId, event);
              } catch (error) {
                // admit has not returned, so the backend cannot have enqueued or dispatched text.
                // Keep the dependency owner's public refusal and its original HTTP/MCP semantics.
                await complete(taskSteerRefusal(error));
                throw error;
              }
            },
          }
        );
      } catch (error) {
        if (!correlation) {
          assertTarget();
          throw error;
        }
        await complete(observed ?? { disposition: 'unknown', reason: 'outcome_unknown' });
      }
      const retained = store.getCommandRequest('task.steer', input.requestId, scope);
      if (!retained) {
        if (correlation) await complete({ disposition: 'unknown', reason: 'outcome_unknown' });
        throw failure('steer_outcome_unknown', 'Steer delivery cannot be proved.');
      }
      return replay(retained);
    },
  });
}
