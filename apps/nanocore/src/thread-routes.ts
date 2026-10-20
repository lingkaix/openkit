import {
  type ArchiveThreadRequestSchema,
  allocateEntityId,
  type CreateThreadRequestSchema,
  ThreadSchema,
  type UpdateThreadRequestSchema,
} from '@openkit/protocol';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { asApiError } from './api-errors.js';
import { prepareAuditEvent } from './audit-events.js';
import { auditAuthenticationFromActor } from './auth/audit-attribution.js';
import type { Actor } from './auth/identity.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { openAssistantTimeline } from './internal-agents/assistant-timeline.js';
import type { FsStore } from './lib/store.js';
import type { AdmittedOperationContext } from './operation-contract.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { archiveThreadWithCloseout } from './runtime/pending-request-flow.js';
import { ControlAdmissionSchema } from './storage/control-store-admission.js';
import type { WorkspaceDb } from './storage/db.js';

/** Existing Thread receipt and pending closeout owners. */
interface ThreadCommandDependencies {
  store: FsStore;
  inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  repositoryWorkspaceDb?: (workspaceId: string) => WorkspaceDb;
}

/** Updates the admitted Thread through its existing exact replay command. Public entry supplies actual actor context; a direct Core caller without it retains explicitly missing Audit attribution, never an inferred actor or grant. */
export async function updateThread(
  input: z.infer<typeof UpdateThreadRequestSchema>,
  dependencies: ThreadCommandDependencies,
  context?: AdmittedOperationContext
) {
  const { store, inflightCommands } = dependencies;
  const updates: { name?: string | null; status?: 'active' | 'archived' } = {};
  if (input.name !== undefined) {
    updates.name = input.name;
  }
  if (input.status !== undefined) {
    updates.status = input.status;
  }
  const thread = await runIdempotentCommand({
    store,
    inflightCommands,
    command: 'thread.update',
    requestId: input.requestId,
    scope: { workspaceId: input.workspaceId, threadId: input.threadId },
    input,
    responseKind: 'thread',
    execute: async ({ responseKind, ...receipt }) =>
      ThreadSchema.parse(
        await store.updateThread(input.workspaceId, input.threadId, updates, {
          receipt: ControlAdmissionSchema.shape.receipt.parse({
            ...receipt,
            response: { kind: responseKind, id: input.threadId },
          }),
          audit: ControlAdmissionSchema.shape.audit.parse(
            prepareAuditEvent({
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              requestId: input.requestId,
              actor: context?.actorRef ?? null,
              ...(context && context.kind !== 'worker'
                ? { authentication: auditAuthenticationFromActor(context.actor) }
                : {}),
              category: 'command',
              action: receipt.command,
              resource: `thread:${input.threadId}`,
              outcome: 'succeeded',
              summary: 'Thread updated.',
              now: new Date(receipt.createdAt),
            })
          ),
        })
      ),
    replay: (record) => ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
    responseId: (result) => result.id,
  });
  return thread;
}

/** Archives the admitted Thread and closes existing Pending Requests through their owner. */
export async function archiveThread(
  input: z.infer<typeof ArchiveThreadRequestSchema>,
  dependencies: ThreadCommandDependencies,
  actor: Actor
) {
  const { store, inflightCommands, repositoryWorkspaceDb } = dependencies;
  const thread = await runIdempotentCommand({
    store,
    inflightCommands,
    command: 'thread.archive',
    requestId: input.requestId,
    scope: { workspaceId: input.workspaceId, threadId: input.threadId },
    input,
    responseKind: 'thread',
    execute: () => {
      const actorId = actor.userId;
      if (!actorId) {
        throw new Error('Thread archive requires an authenticated actor.');
      }
      if (repositoryWorkspaceDb) {
        archiveThreadWithCloseout(
          store,
          { openWorkspace: repositoryWorkspaceDb },
          input.workspaceId,
          input.threadId,
          { kind: 'user', id: actorId }
        );
      } else {
        store.archiveThread(input.workspaceId, input.threadId);
      }
      return ThreadSchema.parse(store.getThread(input.workspaceId, input.threadId));
    },
    replay: (record) => ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
    responseId: (result) => result.id,
  });
  return thread;
}

/** Creates or replays the same actor-bound Thread without admitting Task work or changing visibility. Public entry supplies actual Audit context; direct Core callers retain missing attribution rather than reconstructing a principal from the audience owner. */
export async function createThread(
  input: import('zod').infer<typeof CreateThreadRequestSchema>,
  dependencies: {
    store: FsStore;
    inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  },
  actorId: string,
  context?: AdmittedOperationContext
) {
  const { store, inflightCommands } = dependencies;
  const thread = await runIdempotentCommand({
    store,
    inflightCommands,
    command: 'thread.create',
    requestId: input.requestId,
    scope: { actorId, workspaceId: input.workspaceId },
    input,
    responseKind: 'thread',
    execute: async ({ responseKind, ...receipt }) => {
      const threadId = allocateEntityId('th');
      const admission = {
        receipt: ControlAdmissionSchema.shape.receipt.parse({
          ...receipt,
          response: { kind: responseKind, id: threadId },
        }),
        audit: ControlAdmissionSchema.shape.audit.parse(
          prepareAuditEvent({
            workspaceId: input.workspaceId,
            threadId,
            requestId: input.requestId,
            actor: context?.actorRef ?? null,
            ...(context && context.kind !== 'worker'
              ? { authentication: auditAuthenticationFromActor(context.actor) }
              : {}),
            category: 'command',
            action: receipt.command,
            resource: `thread:${threadId}`,
            outcome: 'succeeded',
            summary: 'Thread opened.',
            now: new Date(receipt.createdAt),
          })
        ),
      };
      return ThreadSchema.parse(
        await (input.visibility === 'workspace'
          ? store.createThread(
              input.workspaceId,
              input.name,
              threadId,
              'conversation',
              { visibility: 'workspace' },
              admission
            )
          : openAssistantTimeline(store, input.workspaceId, actorId, input.name, admission))
      );
    },
    replay: (record) => ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
    responseId: (result) => result.id,
  });
  if (!isThreadVisible(store, thread, actorId)) {
    throw new HTTPException(404, { res: asApiError('Thread not found.', 'not_found', 404) });
  }
  return thread;
}
