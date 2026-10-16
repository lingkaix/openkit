import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ConversationRetrievalTrace,
  type KnowledgeRetrievalTrace,
  type ProductRetrievalTrace,
  ProductRetrievalTraceReaderSchema,
  ProductRetrievalTraceSchema,
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
  trace: ProductRetrievalTrace
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
  value: ProductRetrievalTrace
): void {
  const trace = ProductRetrievalTraceSchema.parse(value);
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

/** Allocates through the existing retrieval-trace identifier owner. */
export function allocateRetrievalTraceId(): string {
  return `krt_${randomUUID()}`;
}

/** Reads Knowledge evidence after caller-owned containing-record and source admission. */
export function readRetrievalTrace(
  workspaceRoot: string,
  reference: RetrievalTraceReference
): KnowledgeRetrievalTrace | null;
/** Reads conversation evidence after caller-owned containing-record and source admission. */
export function readRetrievalTrace(
  workspaceRoot: string,
  reference: RetrievalTraceReference,
  sourceKind: 'conversation'
): ConversationRetrievalTrace | null;
/** Reads exact evidence bytes; a caller cannot reinterpret another source family. */
export function readRetrievalTrace(
  workspaceRoot: string,
  reference: RetrievalTraceReference,
  sourceKind?: 'conversation'
): ProductRetrievalTrace | null {
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
  const trace = ProductRetrievalTraceReaderSchema.parse(JSON.parse(readCanonicalTextFile(path)));
  if ((sourceKind === 'conversation') !== 'sourceKind' in trace)
    throw new OperationError(
      'workspace_access_denied',
      'Retrieval trace source is unavailable.',
      403
    );
  assertRetrievalTraceIdentity(reference, trace);
  return trace;
}

/** Reads the existing query-owned trace inventory for one exact Turn without a second manifest. */
export function readTurnRetrievalTraces(
  workspaceRoot: string,
  workspaceId: string,
  threadId: string,
  turnId: string
): Array<{ reference: RetrievalTraceReference; trace: ProductRetrievalTrace }> {
  const scopeId = `retrieval-trace/turn/${workspaceId}/${threadId}/${turnId}`;
  const scope = parseReferenceScope(scopeId);
  if (!scope || scope.family !== 'retrieval-trace' || scope.kind !== 'turn')
    throw new Error('Invalid retrieval trace owner.');
  let directory = workspaceRoot;
  assertCanonicalDirectory(directory);
  for (const segment of ['threads', scope.threadId, 'turns', scope.turnId, 'retrieval-traces']) {
    directory = join(directory, segment);
    if (!existsSync(directory)) return [];
    assertCanonicalDirectory(directory);
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const reference = RetrievalTraceReferenceSchema.parse({
        scopeId,
        objectId: name.slice(0, -5),
      });
      const trace = ProductRetrievalTraceReaderSchema.parse(
        JSON.parse(readCanonicalTextFile(join(directory, name)))
      );
      assertRetrievalTraceIdentity(reference, trace);
      return { reference, trace };
    });
}
