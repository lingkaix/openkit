// openkit-test-platform: posix
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConversationRetrievalTrace } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';

const publication = vi.hoisted(() => ({
  descriptors: new Map<number, string>(),
  events: [] as Array<{ op: 'sync' | 'rename'; path: string; from?: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      publication.descriptors.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      publication.descriptors.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    fsyncSync: ((descriptor: number) => {
      publication.events.push({ op: 'sync', path: publication.descriptors.get(descriptor)! });
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      publication.events.push({ op: 'rename', from: String(args[0]), path: String(args[1]) });
      return actual.renameSync(...args);
    }) as typeof actual.renameSync,
  };
});

import { publishRetrievalTrace, retrievalTraceRelativePath } from './retrieval-traces.js';

describe('retrieval trace publication', () => {
  it('synchronizes trace bytes and directory entries before acknowledging publication', () => {
    const workspaceId = testEntityId('ws', 'retrieval-trace-durability');
    const threadId = testEntityId('th', 'retrieval-trace-durability');
    const turnId = testEntityId('tu', 'retrieval-trace-durability');
    const reference = {
      scopeId: `retrieval-trace/turn/${workspaceId}/${threadId}/${turnId}`,
      objectId: testEntityId('krt', 'retrieval-trace-durability'),
    };
    const trace: ConversationRetrievalTrace = {
      sourceKind: 'conversation',
      traceId: reference.objectId,
      queryContext: {
        serverId: testEntityId('dep', 'retrieval-trace-durability'),
        workspaceId,
        threadId,
        turnId,
        actor: { kind: 'user', id: testEntityId('usr', 'retrieval-trace-durability') },
      },
      requestDigest: `sha256:${'1'.repeat(64)}`,
      retrievalParameters: { mode: 'lexical', limit: 1 },
      selected: [],
      complete: true,
      createdAt: '2026-10-17T00:00:00.000Z',
    };
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-retrieval-trace-'));
    try {
      publication.events.length = 0;
      publishRetrievalTrace(workspaceRoot, reference, trace);
      const path = join(workspaceRoot, retrievalTraceRelativePath(reference));
      const renameAt = publication.events.findIndex(
        (event) => event.op === 'rename' && event.path === path
      );
      expect(renameAt).toBeGreaterThan(0);
      const rename = publication.events[renameAt]!;
      expect(dirname(rename.from!)).toBe(dirname(path));
      expect(publication.events[renameAt - 1]).toEqual({ op: 'sync', path: rename.from });
      expect(publication.events[renameAt + 1]).toEqual({ op: 'sync', path: dirname(path) });
      // Every newly created ancestor entry must survive with the trace file.
      let parent = dirname(path);
      while (parent !== workspaceRoot) {
        parent = dirname(parent);
        expect(publication.events.slice(0, renameAt)).toContainEqual({ op: 'sync', path: parent });
      }
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(trace);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
