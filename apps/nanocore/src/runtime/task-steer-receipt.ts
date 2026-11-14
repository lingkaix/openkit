import type { Item } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { boundedJsonText } from '../bounded-read-text.js';
import type { FsStore } from '../lib/store.js';
import { projectOperationError } from '../operation-error.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { CoreDb } from '../storage/db.js';
import {
  StoredTaskSteerDispositionV1ReaderSchema,
  type TaskSteerDisposition,
} from '../storage/retained-work-items-v1.js';
import { requireNanoHostExecutionAttempt } from './nanohost-attempt-records.js';

/** Retains one definite pre-dispatch failure with its existing public error semantics. */
export function taskSteerRefusal(
  error: unknown
): Pick<TaskSteerDisposition, 'disposition' | 'reason' | 'refusal'> {
  const failure = projectOperationError(error);
  const refusal =
    failure && failure.code.length <= 128
      ? {
          code: failure.code,
          status: failure.status,
          message: boundedJsonText(failure.message, 512),
        }
      : { code: 'internal_error', status: 500, message: 'The instruction could not be delivered.' };
  return { disposition: 'refused', reason: refusal.code, refusal };
}

/** Retained linkage on an ordinary user input distinguishes an in-run instruction from a fresh Turn. */
export function taskSteerCausation(requestId: string): string {
  return `task.steer:${requestId}`;
}

/** Original Item metadata survives receipt pruning; absence never means queued or delivered. */
export function readTaskSteerState(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  item: Item,
  live: { readonly coreDb?: CoreDb | undefined; readonly inputHash?: string | undefined } = {}
) {
  if (
    item.type !== 'user-message' ||
    item.actor.kind !== 'user' ||
    !item.causationId?.startsWith('task.steer:')
  )
    return null;
  const requestId = item.causationId.slice('task.steer:'.length);
  if (!requestId || requestId.length > 128) return null;
  const unknown = { requestId, state: 'unknown' as const, reason: null };
  const hash = commandInputHash({ workspaceId, threadId, turnId: item.turnId, input: item.text });
  const retained = Object.hasOwn(item, 'steerDisposition')
    ? item
    : store.readThreadTimelineSnapshot(workspaceId, threadId, (snapshot) => snapshot.item(item.id));
  const parsed = StoredTaskSteerDispositionV1ReaderSchema.safeParse(
    (retained as unknown as Record<string, unknown> | undefined)?.steerDisposition
  );
  const metadata = parsed.success ? parsed.data : undefined;
  if (!metadata) {
    // The existing process-local command owner and exact private slot must both survive.
    // A retained queued/dispatched row alone cannot advertise Sending after Core restart.
    if (live.coreDb && live.inputHash === hash) {
      try {
        const row = live.coreDb.sqlite
          .prepare(`SELECT h.schema_version AS version,h.operation,h.operation_state AS state,
          h.command_body_json AS command,h.result_json AS result,
          b.current_attempt_id AS attempt,b.agent_session_runtime_binding_id AS binding,b.agent_session_id AS session,
          b.next_turn_sequence AS sequence
          FROM agent_session_runtime_bindings b JOIN harness_instance_records h ON h.harness_instance_id=b.harness_instance_id
          WHERE b.workspace_id=? AND b.thread_id=? AND b.current_turn_id=? AND b.lifecycle_state='active'`)
          .get(workspaceId, threadId, item.turnId) as
          | {
              version: number;
              operation: string;
              state: string;
              command: string;
              result: string | null;
              attempt: string;
              binding: string;
              session: string;
              sequence: number;
            }
          | undefined;
        if (
          row?.version === 1 &&
          row.operation === 'turn.steer' &&
          ['queued', 'dispatched', 'settled'].includes(row.state)
        ) {
          const command = JSON.parse(row.command) as Record<string, unknown>;
          const attempt = requireNanoHostExecutionAttempt(live.coreDb, row.attempt);
          const deadline =
            attempt.lastAcceptedHeartbeatAt === null
              ? attempt.startupDeadline
              : attempt.heartbeatDeadline;
          const current =
            attempt.phase === 'open' &&
            attempt.recoveryState === null &&
            deadline > new Date().toISOString() &&
            attempt.workspaceId === workspaceId &&
            attempt.threadId === threadId &&
            attempt.turnId === item.turnId &&
            attempt.agentSessionId === row.session &&
            command.agentSessionId === row.session &&
            command.agentSessionRuntimeBindingId === row.binding &&
            command.leaseId === row.attempt &&
            command.packageSnapshotId === attempt.inputRef &&
            command.turnSequence === row.sequence - 1;
          const pending =
            row.state !== 'settled' ||
            (row.result !== null && JSON.parse(row.result).consumption === undefined);
          if (
            current &&
            pending &&
            command.workspaceId === workspaceId &&
            command.threadId === threadId &&
            command.turnId === item.turnId &&
            command.inputItemId === item.id &&
            command.inputDigest === sha256Hex(item.text)
          )
            return { requestId, state: 'sending' as const, reason: null };
        }
      } catch {
        /* Missing or contradictory live evidence is Unknown, never a future delivery promise. */
      }
    }
    return unknown;
  }
  if (item.threadId !== threadId || metadata.inputHash !== hash) return unknown;
  return {
    requestId,
    state:
      metadata.disposition === 'accepted'
        ? ('accepted' as const)
        : metadata.disposition === 'refused'
          ? ('not-delivered' as const)
          : ('unknown' as const),
    reason: metadata.reason,
  };
}
