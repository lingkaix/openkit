import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KnowledgeQueryContextSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  isEntityId,
  ReferenceScopeIdSchema,
  RetrievalTraceReferenceSchema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { parseDocument } from 'yaml';
import type { Actor } from './auth/identity.js';
import {
  currentWorkspaceAuthority,
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import {
  type KnowledgePageReferenceProof,
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringFrontmatterField,
  stringListFrontmatterField,
} from './knowledge/okf.js';
import { resolveWorkspaceKnowledgeReferenceProofs } from './knowledge-source-authority.js';
import type { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import {
  getRetrievalService,
  type RetrievalDocument,
  type RetrievalScope,
} from './retrieval-service.js';
import { type CoreDb, openWorkspaceDb } from './storage/db.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import {
  listKnowledgePageIds,
  readWorkspaceKnowledgePage,
} from './storage/workspace-file-records.js';
import { readWorkspaceKnowledgeConflictLedger } from './storage/workspace-portable-file-state.js';

/** Current source and destination authority supplied by trusted operation assembly. */
export interface KnowledgeRetrievalAccess {
  store: FsStore;
  coreDb?: CoreDb | undefined;
  actor: ActorRef;
  requestActor?: Actor | undefined;
  outputThreadId?: string | undefined;
  /** Existing querying Turn, supplied only by trusted execution assembly. */
  outputTurnId?: string | undefined;
}
interface Target {
  dataRoot: string;
  workspaceId: string;
  access: KnowledgeRetrievalAccess;
}
/** Resolves trusted query lineage before any source inventory or kernel access. */
export function resolveKnowledgeQueryContext(input: Target) {
  const { access, workspaceId } = input;
  try {
    if (!workspaceId || !access.actor) throw new Error('Missing query owner.');
    input.access.store.getWorkspace(workspaceId);
    ReferenceScopeIdSchema.parse(`page/workspace/${workspaceId}`);
    if (access.outputTurnId && !access.outputThreadId) throw new Error('Turn without Thread.');
    if (access.outputThreadId) {
      const thread = access.store.getThread(workspaceId, access.outputThreadId);
      if (thread.workspaceId !== workspaceId) throw new Error('Wrong Thread Workspace.');
      const scopeId = access.outputTurnId
        ? `retrieval-trace/turn/${workspaceId}/${access.outputThreadId}/${access.outputTurnId}`
        : `retrieval-trace/thread/${workspaceId}/${access.outputThreadId}`;
      RetrievalTraceReferenceSchema.shape.scopeId.parse(scopeId);
      if (access.outputTurnId) {
        const turn = access.store.getTurnById(access.outputTurnId);
        if (turn.workspaceId !== workspaceId || turn.threadId !== access.outputThreadId)
          throw new Error('Wrong Turn lineage.');
      }
    }
    return KnowledgeQueryContextSchema.parse({
      serverId: readDataRootLayoutMarker(input.dataRoot).deploymentId,
      workspaceId,
      actor: access.actor,
      ...(access.outputThreadId ? { threadId: access.outputThreadId } : {}),
      ...(access.outputTurnId ? { turnId: access.outputTurnId } : {}),
    });
  } catch {
    throw new OperationError(
      'invalid_request',
      'Knowledge query context is missing or contradictory.',
      400
    );
  }
}
/** Rechecks live membership, credentials and Policy before opening a named generation. */
export function admitKnowledgeRetrieval(input: Pick<Target, 'workspaceId' | 'access'>): void {
  const { access, workspaceId } = input;
  const allowed = access.coreDb
    ? currentWorkspaceAuthority(
        access.coreDb,
        workspaceId,
        access.actor,
        'knowledge.read',
        true,
        access.requestActor
      ) !== null &&
      (!access.requestActor ||
        isWorkspaceOperationAuthorized(access.coreDb, access.requestActor, workspaceId, {
          mutating: false,
          policyOperation: 'knowledge.read',
        }))
    : access.actor.kind === 'user' &&
      isEntityId('usr', access.actor.id) &&
      access.requestActor?.kind === 'local' &&
      access.requestActor.userId === access.actor.id;
  if (!allowed || (access.outputThreadId && !threadReadable(input, access.outputThreadId)))
    throw new OperationError('workspace_access_denied', 'Knowledge retrieval access denied.', 403);
}
/** Source audiences cannot expand into a shared or differently owned private destination. */
function threadReadable(input: Pick<Target, 'workspaceId' | 'access'>, threadId: string): boolean {
  const { access, workspaceId } = input;
  try {
    const administrator = access.requestActor
      ? access.coreDb
        ? isCurrentDeploymentAdministrator(access.coreDb, access.requestActor)
        : access.requestActor.kind === 'local'
      : false;
    const thread = access.store.getThread(workspaceId, threadId);
    if (
      !isThreadVisible(
        access.store,
        thread,
        responsibleUserIdForActor(access.actor) ?? undefined,
        administrator
      )
    )
      return false;
    if (!access.outputThreadId || thread.visibility === 'workspace') return true;
    const destination = access.store.getThread(workspaceId, access.outputThreadId);
    return (
      destination.visibility === 'private' &&
      destination.privateOwnerUserId === thread.privateOwnerUserId
    );
  } catch {
    return false;
  }
}
/** Current Proposal/Review and external work owners establish evidence; callers supply no proof map. */
export function currentKnowledgeReferenceProofs(
  input: Pick<Target, 'workspaceId' | 'access'>
): ReadonlyMap<string, KnowledgePageReferenceProof> {
  const { access, workspaceId } = input;
  const db = access.coreDb ? openWorkspaceDb(access.coreDb.dataRoot, workspaceId) : undefined;
  try {
    return resolveWorkspaceKnowledgeReferenceProofs({
      coreDb: access.coreDb,
      store: access.store,
      workspaceDb: db,
      workspaceId,
    });
  } finally {
    db?.sqlite.close();
  }
}
/** Verifies current source bytes and audiences before supplying canonical page text to the kernel. */
export function knowledgePageReadable(
  input: Target,
  pageId: string,
  content: string,
  visiting = new Set<string>()
): boolean {
  if (visiting.has(pageId)) return false;
  visiting.add(pageId);
  const document = parseOkfDocument({ path: `knowledge/pages/${pageId}.md`, content }).document;
  // Invalid pages remain addressable for lower-conformance disposition without inventing source grants.
  if (!document) return true;
  const refs = stringListFrontmatterField(document, 'source_refs');
  if (refs === null) return false;
  return knowledgeSourceReferencesReadable(input, pageId, refs, visiting);
}
/** Rechecks exact retained source references, including references no longer on the current page. */
export function knowledgeSourceReferencesReadable(
  input: Target,
  pageId: string,
  refs: readonly string[],
  visiting = new Set<string>([pageId])
): boolean {
  const { store } = input.access;
  const sources = new Map(
    store.listKnowledgeSources(input.workspaceId).map((source) => [source.id, source.contentDigest])
  );
  for (const reference of refs) {
    try {
      // The existing proof owner verifies the exact terminal Turn, final Item and S39 tuple.
      if (/^(?:turn|item|context-package):/.test(reference)) {
        const proof = currentKnowledgeReferenceProofs(input).get(pageId);
        if (!proof?.sourceReferences.includes(reference)) return false;
      }
      if (reference.startsWith('source:')) {
        const resolution = resolveRegisteredKnowledgeSourceReference(reference, sources);
        if (!resolution.resolved || !resolution.targetId) return false;
        const source = store.getKnowledgeSource(input.workspaceId, resolution.targetId);
        if (source.originatingThreadId && !threadReadable(input, source.originatingThreadId))
          return false;
        const material = store.readKnowledgeSourceMaterial(input.workspaceId, source.id);
        if (material === null || digest(material) !== source.contentDigest) return false;
      } else if (reference.startsWith('knowledge:')) {
        const match = /^knowledge:([^@]+)(?:@(sha256:[a-f0-9]{64}))?$/.exec(reference);
        if (!match) return false;
        const source = readWorkspaceKnowledgePage(
          join(input.dataRoot, 'workspaces', input.workspaceId),
          match[1]!
        );
        if (source === null || (match[2] && digest(source) !== match[2])) return false;
        const sourceDocument = parseOkfDocument({
          path: `knowledge/pages/${match[1]!}.md`,
          content: source,
        }).document;
        const sensitivity = sourceDocument
          ? stringFrontmatterField(sourceDocument, 'sensitivity')
          : null;
        // A nested source has no candidate disposition that can protect its identity later.
        if (
          !sourceDocument ||
          sensitivity === null ||
          sensitivity === 'restricted' ||
          sensitivity === 'confidential' ||
          !knowledgePageReadable(input, match[1]!, source, new Set(visiting))
        )
          return false;
      } else if (reference.startsWith('turn:')) {
        const turn = store.getTurnById(reference.slice(5));
        if (turn.workspaceId !== input.workspaceId || !threadReadable(input, turn.threadId))
          return false;
      } else if (!reference.startsWith('item:') && !reference.startsWith('context-package:')) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
/** Source-bound conflict state stays an authoritative ledger decision, never an index flag. */
export function knowledgePageConflicted(workspaceRoot: string, pageId: string): boolean {
  const latest = new Map<string, { status: string; subjectReferences: string[] }>();
  for (const rows of readWorkspaceKnowledgeConflictLedger(workspaceRoot).values())
    for (const row of rows) latest.set(row.id, row);
  return [...latest.values()].some(
    (row) =>
      !['resolved', 'superseded'].includes(row.status) &&
      row.subjectReferences.some(
        (reference) => reference.replace(/@sha256:[a-f0-9]{64}$/, '') === `knowledge:${pageId}`
      )
  );
}
/** Declares only body, description and tags as body fields; title has its own kernel weight. */
function textRanges(content: string, body: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const bodyStart = content.length - body.length;
  const yamlStart = content.startsWith('---\n') ? 4 : 0;
  const yamlEnd = content.lastIndexOf('\n---\n', bodyStart);
  if (yamlStart && yamlEnd >= yamlStart) {
    const yaml = parseDocument(content.slice(yamlStart, yamlEnd));
    for (const key of ['description', 'tags']) {
      const node = yaml.get(key, true);
      if (node && typeof node === 'object' && 'range' in node && Array.isArray(node.range)) {
        const start = yamlStart + node.range[0]!;
        const end = yamlStart + node.range[1]!;
        ranges.push({
          start: Buffer.byteLength(content.slice(0, start)),
          end: Buffer.byteLength(content.slice(0, end)),
        });
      }
    }
  }
  if (body.length)
    ranges.push({
      start: Buffer.byteLength(content.slice(0, bodyStart)),
      end: Buffer.byteLength(content),
    });
  return ranges.sort((a, b) => a.start - b.start);
}
/** Uses the indexed document's selected language while keeping answer coverage on title and body only. */
export async function analyzeKnowledgePage(input: {
  dataRoot: string;
  workspaceId: string;
  query: string;
  content: string;
  title: string;
  body: string;
}) {
  const service = getRetrievalService(
    input.dataRoot,
    join(input.dataRoot, 'workspaces', input.workspaceId)
  );
  const doc = parseOkfDocument({
    path: 'knowledge/pages/analysis.md',
    content: input.content,
  }).document;
  const hint = doc ? stringFrontmatterField(doc, 'language') : null;
  let language: 'zh' | 'ja' | 'unicode';
  if (hint === 'zh' || hint === 'ja' || hint === 'unicode') language = hint;
  else {
    const bytes = Buffer.from(input.content);
    const searchable = textRanges(input.content, doc?.body ?? input.content)
      .map((range) => bytes.subarray(range.start, range.end).toString('utf8'))
      .join('\n');
    language = (await service.analyze('language', input.title, searchable)).language;
  }
  return service.analyze(input.query, input.title, input.body, language);
}

/** Enumerates the complete currently readable file-backed inventory with exact observed byte identities. */
export function collectKnowledgeInventory(input: Target): {
  view: RetrievalScope;
  referenceProofs: ReadonlyMap<string, KnowledgePageReferenceProof>;
} {
  admitKnowledgeRetrieval(input);
  const root = join(input.dataRoot, 'workspaces', input.workspaceId);
  const referenceProofs = currentKnowledgeReferenceProofs(input);
  const documents: RetrievalDocument[] = [];
  for (const id of listKnowledgePageIds(join(root, 'knowledge', 'pages'))) {
    const content = readWorkspaceKnowledgePage(root, id);
    if (content === null || !knowledgePageReadable(input, id, content)) continue;
    const parsed = parseOkfDocument({ path: `knowledge/pages/${id}.md`, content });
    const doc = parsed.document;
    const canonicalDigest = digest(content).slice(7);
    const language = doc ? stringFrontmatterField(doc, 'language') : null;
    documents.push({
      key: { namespace: 'knowledge', id },
      revision: canonicalDigest,
      digest: canonicalDigest,
      size: Buffer.byteLength(content),
      name: `${id}.md`,
      title: doc ? (stringFrontmatterField(doc, 'title') ?? id) : id,
      media_type: 'text/markdown',
      text_ranges: doc
        ? textRanges(content, doc.body)
        : [{ start: 0, end: Buffer.byteLength(content) }],
      ...(language === 'zh' || language === 'ja' || language === 'unicode' ? { language } : {}),
      metadata: { workspaceId: input.workspaceId, knowledgePageId: id },
      locator: `knowledge/pages/${id}.md`,
      content: { kind: 'inline-text', text: content },
    });
  }
  return {
    view: {
      scope: JSON.stringify([
        'knowledge',
        input.workspaceId,
        responsibleUserIdForActor(input.access.actor),
        input.access.outputThreadId ?? null,
      ]),
      documents,
    },
    referenceProofs,
  };
}
/** Exact current canonical-byte identity, not a retained notebook commit or history claim. */
function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
