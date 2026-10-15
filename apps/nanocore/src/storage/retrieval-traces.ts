import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type KnowledgeRetrievalTrace,
  KnowledgeRetrievalTraceReaderSchema,
  KnowledgeRetrievalTraceSchema,
} from '@openkit/app-api-schemas';
import {
  parseReferenceScope,
  type RetrievalTraceReference,
  RetrievalTraceReferenceSchema,
} from '@openkit/protocol';
import { OperationError } from '../operation-error.js';
import { assertCanonicalDirectory, readCanonicalTextFile } from './workspace-file-records.js';

/** Resolves a validated query-owned trace reference within its Workspace only. */
export function retrievalTraceRelativePath(reference: RetrievalTraceReference): string {
  const parsed = RetrievalTraceReferenceSchema.parse(reference);
  const scope = parseReferenceScope(parsed.scopeId);
  if (!scope || scope.family !== 'retrieval-trace')
    throw new Error('Invalid retrieval trace owner.');
  return scope.kind === 'turn'
    ? `threads/${scope.threadId}/turns/${scope.turnId}/retrieval-traces/${parsed.objectId}.json`
    : `threads/${scope.threadId}/retrieval-traces/${parsed.objectId}.json`;
}

/** Checks the exact owner/id relationship before a trace can be published or consumed. */
export function assertRetrievalTraceIdentity(
  reference: RetrievalTraceReference,
  trace: KnowledgeRetrievalTrace
): void {
  const scope = parseReferenceScope(reference.scopeId);
  if (
    !scope ||
    scope.family !== 'retrieval-trace' ||
    trace.traceId !== reference.objectId ||
    scope.workspaceId !== trace.queryContext.workspaceId ||
    scope.threadId !== trace.queryContext.threadId ||
    (scope.kind === 'turn'
      ? scope.turnId !== trace.queryContext.turnId
      : trace.queryContext.turnId !== undefined)
  )
    throw new Error('Knowledge retrieval trace lineage is contradictory.');
}

/** Publishes one immutable query-owned file; this is the sole live trace writer. */
export function publishRetrievalTrace(
  workspaceRoot: string,
  reference: RetrievalTraceReference,
  value: KnowledgeRetrievalTrace
): void {
  const trace = KnowledgeRetrievalTraceSchema.parse(value);
  assertRetrievalTraceIdentity(reference, trace);
  const relative = retrievalTraceRelativePath(reference);
  // Check every existing parent before mkdir or canonical reads; no symlink can redirect a trace.
  let parent = workspaceRoot;
  assertCanonicalDirectory(parent);
  for (const segment of relative.split('/').slice(0, -1)) {
    parent = join(parent, segment);
    if (!existsSync(parent)) mkdirSync(parent);
    assertCanonicalDirectory(parent);
  }
  const path = join(workspaceRoot, relative);
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw new OperationError(
      'idempotency_key_conflict',
      'Knowledge retrieval trace already exists.',
      409
    );
  const temporary = join(dirname(path), `.${reference.objectId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(trace), { flag: 'wx', mode: 0o600 });
    // The publisher is one synchronous writer. No await separates its existence check and rename.
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Reads exact evidence bytes for an already admitted owner; callers must recheck current access. */
export function readRetrievalTrace(
  workspaceRoot: string,
  reference: RetrievalTraceReference
): KnowledgeRetrievalTrace | null {
  const relative = retrievalTraceRelativePath(reference);
  let parent = workspaceRoot;
  assertCanonicalDirectory(parent);
  for (const segment of relative.split('/').slice(0, -1)) {
    parent = join(parent, segment);
    if (!existsSync(parent)) return null;
    assertCanonicalDirectory(parent);
  }
  const path = join(workspaceRoot, relative);
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  const trace = KnowledgeRetrievalTraceReaderSchema.parse(JSON.parse(readCanonicalTextFile(path)));
  assertRetrievalTraceIdentity(reference, trace);
  return trace;
}
