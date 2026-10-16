import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  AssistantHistoryQuerySchema,
  type ConversationRetrievalTrace,
} from '@openkit/app-api-schemas';
import type { Item, RetrievalTraceReference } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  currentWorkspaceAuthority,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { isThreadVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { searchProductSources } from '../retrieval-sources.js';
import type { CoreDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import {
  allocateRetrievalTraceId,
  publishRetrievalTrace,
  readRetrievalTrace,
} from '../storage/retrieval-traces.js';
import type { AgentTool, AgentToolResult } from './internal-agent-loop.js';
import { redactInternalAgentText } from './redaction.js';
import {
  internalContextHistoryBody,
  internalContextItems,
  internalContextSourceDigest,
} from './rolling-context.js';

/** Trusted querying owner, never model-selected source or audience authority. */
export interface AssistantHistoryContext {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly actor: Actor;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
}

type Selection = ConversationRetrievalTrace['selected'][number];

/** Rechecks membership and the ordinary User audience without an administrator override. */
function requireAudience(input: AssistantHistoryContext): void {
  const { actor, coreDb, store, workspaceId, threadId, turnId } = input;
  if (
    !currentWorkspaceAuthority(
      coreDb,
      workspaceId,
      { kind: 'user', id: actor.userId },
      'thread.read',
      true
    ) ||
    !isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
      mutating: false,
      policyOperation: 'thread.read',
    })
  )
    throw unavailable();
  const thread = store.getThread(workspaceId, threadId);
  if (!isThreadVisible(store, thread, actor.userId, false)) throw unavailable();
  store.getTurn(workspaceId, threadId, turnId);
}

/** Verifies the current source bytes and their eligibility for the exact querying audience. */
function requireSelection(input: AssistantHistoryContext, selection: Selection): void {
  if (selection.reference.workspaceId !== input.workspaceId) throw unavailable();
  const source = input.store.getThread(input.workspaceId, selection.reference.threadId);
  const destination = input.store.getThread(input.workspaceId, input.threadId);
  if (
    !isThreadVisible(input.store, source, input.actor.userId, false) ||
    (source.visibility === 'private' &&
      (destination.visibility !== 'private' ||
        destination.privateOwnerUserId !== source.privateOwnerUserId))
  )
    throw unavailable();
  const item = input.store
    .listThreadItems(input.workspaceId, source.id)
    .find((item) => item.id === selection.reference.itemId);
  if (
    !item ||
    item.turnId !== selection.reference.turnId ||
    item.type === 'reasoning' ||
    item.type === 'context-summary' ||
    ((item.type === 'user-message' || item.type === 'assistant-message') &&
      item.status !== 'completed') ||
    hash(JSON.stringify(item)) !== selection.revision ||
    hash(internalContextHistoryBody(item)) !== selection.digest
  )
    throw unavailable();
}

/** Checks a retained conversation trace through its existing containing-record and source owners. */
export function assertConversationRetrievalTraceReadable(input: {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly actor: Actor;
  readonly workspaceId: string;
  readonly retrievalTraceRef: RetrievalTraceReference;
}): void {
  const root = input.store.getDataRoot();
  if (!root) throw unavailable();
  const trace = readRetrievalTrace(
    join(root, 'workspaces', input.workspaceId),
    input.retrievalTraceRef,
    'conversation'
  );
  if (
    !trace ||
    trace.queryContext.workspaceId !== input.workspaceId ||
    trace.queryContext.serverId !== readDataRootLayoutMarker(root).deploymentId
  )
    throw unavailable();
  const context = {
    ...input,
    threadId: trace.queryContext.threadId,
    turnId: trace.queryContext.turnId,
  };
  requireAudience(context);
  if (trace.retrievalParameters.mode === 'range')
    requireRange(context, trace.retrievalParameters.range);
  for (const selection of trace.selected) requireSelection(context, selection);
}

/**
 * Binds bounded past-Item search to R2 and the existing immutable query trace.
 *
 * Every query and later publication rechecks the current audience and exact source revisions. The retained closure contains only selections already supplied to this bounded run; it grants no authority and performs no effect replay.
 *
 * @param input Current actor and exact admitted querying Turn.
 * @returns The fixed model Tool and a publication guard for every returned selection.
 */
export function createAssistantHistory(input: AssistantHistoryContext): {
  readonly tool: AgentTool;
  readonly assertCurrent: () => void;
} {
  const selected: Selection[] = [];
  const ranges: Array<Parameters<typeof requireRange>[1]> = [];
  const assertCurrent = () => {
    requireAudience(input);
    const turn = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);
    if (turn.status !== 'pending' && turn.status !== 'running') throw unavailable();
    for (const range of ranges) requireRange(input, range);
    for (const selection of selected) requireSelection(input, selection);
  };
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(AssistantHistoryQuerySchema, {
    io: 'input',
  });
  return {
    assertCurrent,
    tool: {
      name: 'thread.history.read',
      description:
        'Search retained visible history, or read the exact source-bound range named by a summary. A next cursor resumes large Items and ranges within the same bounds. Membership and audience are checked; incomplete results do not prove absence.',
      inputSchema,
      execute: async (value, context) => {
        try {
          if (context.signal.aborted) throw context.signal.reason;
          const query = AssistantHistoryQuerySchema.parse(value);
          assertCurrent();
          const root = input.store.getDataRoot();
          if (!root || root !== input.coreDb.dataRoot) throw unavailable();
          const reference = {
            scopeId: `retrieval-trace/turn/${input.workspaceId}/${input.threadId}/${input.turnId}`,
            objectId: allocateRetrievalTraceId(),
          };
          let complete = true;
          let next: { itemId: string; offset: number } | undefined;
          const hits: Array<Selection & { snippet: string; offset?: number; nextOffset?: number }> =
            [];
          if ('range' in query) {
            const items = requireRange(input, query.range);
            let index = query.cursor
              ? items.findIndex((item) => item.id === query.cursor!.itemId)
              : 0;
            if (index < 0) throw unavailable();
            for (; index < items.length && hits.length < query.limit; index += 1) {
              const item = items[index]!;
              const body = redactInternalAgentText(internalContextHistoryBody(item));
              const bytes = Buffer.from(body);
              const offset = hits.length === 0 ? (query.cursor?.offset ?? 0) : 0;
              if (
                offset > bytes.length ||
                (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
              )
                throw unavailable();
              const snippet = boundedUtf8(bytes.subarray(offset).toString('utf8'), 4096);
              const nextOffset = offset + Buffer.byteLength(snippet);
              const selection: Selection = {
                reference: {
                  workspaceId: input.workspaceId,
                  threadId: item.threadId,
                  turnId: item.turnId,
                  itemId: item.id,
                },
                revision: hash(JSON.stringify(item)),
                digest: hash(internalContextHistoryBody(item)),
              };
              requireSelection(input, selection);
              hits.push({ ...selection, snippet, offset, nextOffset });
              if (nextOffset < bytes.length) {
                next = { itemId: item.id, offset: nextOffset };
                break;
              }
              next =
                index + 1 < items.length ? { itemId: items[index + 1]!.id, offset: 0 } : undefined;
            }
            complete = next === undefined;
          } else {
            const results = await searchProductSources(
              {
                store: input.store,
                coreDb: input.coreDb,
                actor: input.actor,
                workspaceId: input.workspaceId,
                outputThreadId: input.threadId,
                families: ['conversation'],
                administratorOverride: false,
              },
              query
            );
            if (context.signal.aborted) throw context.signal.reason;
            assertCurrent();
            complete = results.every((result) => result.complete);
            for (const hit of results.flatMap((result) => result.hits)) {
              const selection: Selection = {
                reference: {
                  workspaceId: hit.provenance.workspaceId!,
                  threadId: hit.provenance.threadId!,
                  turnId: hit.provenance.turnId!,
                  itemId: hit.provenance.itemId!,
                },
                revision: `sha256:${hit.revision}`,
                digest: `sha256:${hit.digest}`,
              };
              // A changed, removed or newly private source cannot retain its old snippet or reference.
              try {
                requireSelection(input, selection);
              } catch {
                complete = false;
                continue;
              }
              if (hits.length >= query.limit) {
                complete = false;
                continue;
              }
              hits.push({
                ...selection,
                snippet: boundedUtf8(redactInternalAgentText(hit.snippet), 4096),
              });
            }
          }
          const output = () => ({
            hits,
            complete,
            retrievalTraceRef: reference,
            ...(next ? { next } : {}),
          });
          const envelope = (): AgentToolResult => ({
            content: [{ type: 'text', text: JSON.stringify(output()) }],
          });
          while (Buffer.byteLength(JSON.stringify(envelope())) > 64 * 1024 && hits.length) {
            const omitted = hits.pop()!;
            if ('range' in query)
              next = { itemId: omitted.reference.itemId, offset: omitted.offset ?? 0 };
            complete = false;
          }
          if (Buffer.byteLength(JSON.stringify(envelope())) > 64 * 1024) throw unavailable();
          const selections = hits.map(({ reference, revision, digest }) => ({
            reference,
            revision,
            digest,
          }));
          const trace: ConversationRetrievalTrace = {
            sourceKind: 'conversation',
            traceId: reference.objectId,
            queryContext: {
              serverId: readDataRootLayoutMarker(root).deploymentId,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              turnId: input.turnId,
              actor: { kind: 'user', id: input.actor.userId },
            },
            requestDigest: hash(
              JSON.stringify({
                query,
                workspaceId: input.workspaceId,
                threadId: input.threadId,
                turnId: input.turnId,
              })
            ),
            retrievalParameters:
              'range' in query
                ? { ...query, mode: 'range' }
                : { mode: query.mode, limit: query.limit },
            selected: selections,
            complete,
            createdAt: new Date().toISOString(),
          };
          if (context.signal.aborted) throw context.signal.reason;
          assertCurrent();
          for (const selection of selections) requireSelection(input, selection);
          publishRetrievalTrace(join(root, 'workspaces', input.workspaceId), reference, trace);
          selected.push(...selections);
          if ('range' in query) ranges.push(query.range);
          return envelope();
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: error instanceof OperationError ? error.code : 'history_unavailable',
                  message:
                    'Conversation history is unavailable under current source and audience checks.',
                }),
              },
            ],
            isError: true,
          };
        }
      },
    },
  };
}

/** Derives the exact eligible canonical range; its digest and qualified endpoints grant no authority. */
function requireRange(
  input: AssistantHistoryContext,
  range: {
    readonly threadId: string;
    readonly firstItemId: string;
    readonly lastItemId: string;
    readonly sourceDigest: string;
  }
): Item[] {
  requireAudience(input);
  const source = input.store.getThread(input.workspaceId, range.threadId);
  const destination = input.store.getThread(input.workspaceId, input.threadId);
  if (
    !isThreadVisible(input.store, source, input.actor.userId, false) ||
    (source.visibility === 'private' &&
      (destination.visibility !== 'private' ||
        source.privateOwnerUserId !== destination.privateOwnerUserId))
  )
    throw unavailable();
  const current = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const history = internalContextItems(input.store, { ...current, threadId: source.id });
  const first = history.findIndex((item) => item.id === range.firstItemId);
  const last = history.findIndex((item) => item.id === range.lastItemId);
  if (first < 0 || last < first) throw unavailable();
  const items = history.slice(first, last + 1);
  if (internalContextSourceDigest(input.store, items) !== range.sourceDigest) throw unavailable();
  return items;
}

/** Keeps a preview within a UTF-8 byte bound without splitting a Unicode code point. */
function boundedUtf8(value: string, maximum: number): string {
  let size = 0;
  let result = '';
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maximum) break;
    result += character;
    size += bytes;
  }
  return result;
}

/** Encodes canonical source and request digests with their algorithm label. */
function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Refuses without disclosing a denied source identity or internal dependency detail. */
function unavailable(): OperationError {
  return new OperationError(
    'history_unavailable',
    'Conversation history is unavailable under current source and audience checks.',
    403
  );
}
