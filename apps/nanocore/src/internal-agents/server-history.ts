import { AssistantHistoryReadSchema } from '@openkit/app-api-schemas';
import type { ServerTurn } from '@openkit/protocol';
import { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import type { AgentTool } from './internal-agent-loop.js';
import { redactInternalAgentText } from './redaction.js';
import { internalContextDigest } from './rolling-context.js';

/** Exact current-run history retrieval after compaction; it admits no other Server, User or Workspace work. */
export function createServerRunHistory(input: {
  readonly store: FsStore;
  readonly turn: ServerTurn;
  readonly assertCurrent: () => void;
}): AgentTool {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(AssistantHistoryReadSchema, {
    io: 'input',
  });
  return {
    name: 'thread.history.read',
    description:
      "Read exact original Items covered by this run's compaction summary. Use its source range and optional byte cursor. No other Thread is admitted.",
    inputSchema,
    execute: async (raw) => {
      try {
        input.assertCurrent();
        const query = AssistantHistoryReadSchema.parse(raw);
        if (query.range.threadId !== input.turn.threadId) throw new Error('History unavailable.');
        const turn = input.store.getServerTurnById(input.turn.id);
        const all = turn.items.filter(
          (item) =>
            item.type !== 'context-summary' &&
            item.type !== 'reasoning' &&
            ['completed', 'failed'].includes(item.status)
        );
        const first = all.findIndex((item) => item.id === query.range.firstItemId);
        const last = all.findIndex((item) => item.id === query.range.lastItemId);
        if (first < 0 || last < first) throw new Error('History unavailable.');
        const range = all.slice(first, last + 1);
        if (internalContextDigest({ version: 1, sources: range }) !== query.range.sourceDigest)
          throw new Error('History unavailable.');
        const offsetIndex = query.cursor
          ? range.findIndex((item) => item.id === query.cursor!.itemId)
          : 0;
        if (offsetIndex < 0) throw new Error('History unavailable.');
        const hits = [];
        let next: { itemId: string; offset: number } | undefined;
        for (let index = offsetIndex; index < range.length && hits.length < query.limit; index++) {
          const item = range[index]!;
          const bytes = Buffer.from(redactInternalAgentText(JSON.stringify(item)));
          const offset = index === offsetIndex ? (query.cursor?.offset ?? 0) : 0;
          if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80))
            throw new Error('History unavailable.');
          let end = Math.min(bytes.length, offset + 4096);
          while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
          hits.push({
            reference: {
              owner: { kind: 'server' },
              threadId: item.threadId,
              turnId: item.turnId,
              itemId: item.id,
            },
            revision: internalContextDigest(item),
            content: bytes.subarray(offset, end).toString('utf8'),
            offset,
          });
          next =
            end < bytes.length
              ? { itemId: item.id, offset: end }
              : range[index + 1]
                ? { itemId: range[index + 1]!.id, offset: 0 }
                : undefined;
          if (end < bytes.length) break;
        }
        input.assertCurrent();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                hits,
                complete: next === undefined,
                ...(next ? { next } : {}),
              }),
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: 'The current-run history range is unavailable.' }],
        };
      }
    },
  };
}
