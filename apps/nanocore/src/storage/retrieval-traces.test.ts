// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConversationRetrievalTrace, KnowledgeRetrievalTrace } from '@openkit/app-api-schemas';
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

import {
  publishRetrievalTrace,
  readRetrievalTrace,
  readTurnRetrievalTraces,
  retrievalTraceRelativePath,
} from './retrieval-traces.js';

import {
  parseWorkspaceRetrievalTraceFile,
  serializeWorkspaceRetrievalTrace,
} from './workspace-portable-file-state.js';

describe('retrieval trace publication', () => {
  it('retains supplied normalized typed selectors and exact selection evidence across read boundaries', () => {
    const workspaceId = testEntityId('ws', 'typed-trace-retention');
    const threadId = testEntityId('th', 'typed-trace-retention');
    const turnId = testEntityId('tu', 'typed-trace-retention');
    const reference = {
      scopeId: `retrieval-trace/turn/${workspaceId}/${threadId}/${turnId}`,
      objectId: testEntityId('krt', 'typed-trace-retention'),
    };
    const sourceScope = `page/workspace/${workspaceId}/${testEntityId('kb', 'typed-trace-retention')}`;
    const pageReference = { scopeId: sourceScope, objectId: 'invoice-rule' };
    const trace: KnowledgeRetrievalTrace = {
      traceId: reference.objectId,
      queryContext: {
        serverId: testEntityId('dep', 'typed-trace-retention'),
        workspaceId,
        threadId,
        turnId,
        actor: { kind: 'user', id: testEntityId('usr', 'typed-trace-retention') },
      },
      sourceScope,
      notebookRevision: 'published-notebook-commit',
      caller: 'app-api',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      retrievalParameters: {
        limit: 3,
        pinnedReferences: [pageReference],
        states: ['active'],
        sourceScope: 'workspace',
        types: ['Objective', 'Rule'],
        appliesTo: ['step:invoice-review', 'tool:invoice.check'],
      },
      selected: [
        {
          reference: pageReference,
          revision: 'published-notebook-commit',
          contentDigest: `sha256:${'b'.repeat(64)}`,
          sourceReferences: ['source:invoice-evidence'],
        },
      ],
      excluded: [
        {
          reference: { scopeId: sourceScope, objectId: 'invoice-effect' },
          revision: 'published-notebook-commit',
          contentDigest: `sha256:${'c'.repeat(64)}`,
          sourceReferences: ['source:invoice-evidence'],
          reason: 'policy_excluded',
        },
      ],
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-typed-trace-'));
    try {
      publishRetrievalTrace(workspaceRoot, reference, trace);
      const relativePath = retrievalTraceRelativePath(reference);
      const path = join(workspaceRoot, relativePath);
      const published = readFileSync(path, 'utf8');
      expect(JSON.parse(published)).toEqual({ ...trace, schemaVersion: 1 });

      // Retained evidence keeps the query's selectors and digest; current access is caller-owned.
      expect.soft(readRetrievalTrace(workspaceRoot, reference)).toEqual(trace);
      expect
        .soft(readTurnRetrievalTraces(workspaceRoot, workspaceId, threadId, turnId))
        .toEqual([{ reference, trace }]);
      expect
        .soft(parseWorkspaceRetrievalTraceFile(relativePath, published, workspaceId))
        .toEqual({ reference, trace });
      const portable = serializeWorkspaceRetrievalTrace(trace);
      expect.soft(JSON.parse(portable)).toEqual({ ...trace, schemaVersion: 1 });
      expect
        .soft(parseWorkspaceRetrievalTraceFile(relativePath, portable, workspaceId))
        .toEqual({ reference, trace });
      expect(readFileSync(path, 'utf8')).toBe(published);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses missing or unknown trace versions before decoding the source family', () => {
    const workspaceId = testEntityId('ws', 'trace-version');
    const threadId = testEntityId('th', 'trace-version');
    const turnId = testEntityId('tu', 'trace-version');
    const reference = {
      scopeId: `retrieval-trace/turn/${workspaceId}/${threadId}/${turnId}`,
      objectId: testEntityId('krt', 'trace-version'),
    };
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-trace-version-'));
    try {
      const path = join(workspaceRoot, retrievalTraceRelativePath(reference));
      mkdirSync(dirname(path), { recursive: true });
      for (const marker of [{}, { schemaVersion: 2 }]) {
        const invalid = JSON.stringify({ ...marker, sourceKind: 'future' });
        writeFileSync(path, invalid);
        expect(() => readRetrievalTrace(workspaceRoot, reference)).toThrow(
          'Unsupported retained record format.'
        );
        expect(() => readTurnRetrievalTraces(workspaceRoot, workspaceId, threadId, turnId)).toThrow(
          'Unsupported retained record format.'
        );
        expect(() =>
          parseWorkspaceRetrievalTraceFile(
            retrievalTraceRelativePath(reference),
            invalid,
            workspaceId
          )
        ).toThrow('Unsupported retained record format.');
        expect(readFileSync(path, 'utf8')).toBe(invalid);
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
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
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      expect(retained).toEqual({ ...trace, schemaVersion: 1 });
      const annotated = JSON.stringify({ ...retained, publicNote: 'Trace description.' });
      writeFileSync(path, annotated);
      expect(readRetrievalTrace(workspaceRoot, reference, 'conversation')).toEqual(trace);
      expect(readTurnRetrievalTraces(workspaceRoot, workspaceId, threadId, turnId)).toEqual([
        { reference, trace },
      ]);
      expect(
        parseWorkspaceRetrievalTraceFile(
          retrievalTraceRelativePath(reference),
          annotated,
          workspaceId
        )
      ).toEqual({ reference, trace });
      const portable = serializeWorkspaceRetrievalTrace(trace);
      expect(JSON.parse(portable)).toEqual({ ...trace, schemaVersion: 1 });
      expect(
        parseWorkspaceRetrievalTraceFile(
          retrievalTraceRelativePath(reference),
          portable,
          workspaceId
        )
      ).toEqual({ reference, trace });
      expect(readFileSync(path, 'utf8')).toBe(annotated);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
