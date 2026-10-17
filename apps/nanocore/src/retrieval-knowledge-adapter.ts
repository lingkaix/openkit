import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { KnowledgeQueryContextSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  isEntityId,
  ReferenceScopeIdSchema,
  RetrievalTraceReferenceSchema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { parseDocument } from 'yaml';
import type { Actor } from './auth/identity.js';
import {
  currentWorkspaceAuthority,
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { findAssistantTimeline } from './internal-agents/assistant-timeline.js';
import { admitMemoryContext, memoryPageFacts } from './knowledge/memory-lifecycle.js';
import { readMemorySuppressions } from './knowledge/memory-maintenance.js';
import { KnowledgeNotebook, NotebookError } from './knowledge/notebook.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  type KnowledgePageReferenceProof,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  resolveRegisteredKnowledgeSourceReference,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateScopeKnowledgeSchema,
} from './knowledge/okf.js';
import { admitUserMemorySources } from './knowledge/scoped-knowledge-sources.js';
import {
  pinScopedNotebook,
  resolveScopedNotebookOwner,
} from './knowledge/scoped-notebook-owner.js';
import {
  admitsServerKnowledge,
  readServerKnowledgeSource,
} from './knowledge/server-knowledge-owner.js';
import {
  resolveWorkspaceKnowledgeReferenceProofs,
  verifyKnowledgeProposalWorkHistory,
} from './knowledge-source-authority.js';
import type { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { RetrievalDocument, RetrievalScope } from './retrieval-service.js';
import { type CoreDb, openWorkspaceDb, type UserDb } from './storage/db.js';
import { readDataRootLayoutMarker, userDbPath } from './storage/fs-layout.js';
import { assertCanonicalDirectory } from './storage/workspace-file-records.js';
import { readWorkspaceKnowledgeConflictLedger } from './storage/workspace-portable-file-state.js';

/** Current source and destination authority supplied by trusted operation assembly. */
export interface KnowledgeRetrievalAccess {
  store: FsStore;
  coreDb?: CoreDb | undefined;
  actor: ActorRef;
  requestActor?: Actor | undefined;
  /** Actual current administrator credential retained by trusted native Worker admission. */
  serverKnowledgeActor?: Actor | undefined;
  outputThreadId?: string | undefined;
  /** Existing querying Turn, supplied only by trusted execution assembly. */
  outputTurnId?: string | undefined;
  /** Existing authenticated-self database, supplied by native Memory assembly when available. */
  userDb?: UserDb | undefined;
}
/** Checks the existing Server owner without opening a notebook, Source or derived index. */
export function canReadServerKnowledge(input: {
  readonly access: KnowledgeRetrievalAccess;
}): boolean {
  const actor = input.access.serverKnowledgeActor ?? input.access.requestActor;
  return Boolean(
    input.access.coreDb &&
      actor &&
      actor.userId === responsibleUserIdForActor(input.access.actor) &&
      admitsServerKnowledge({ coreDb: input.access.coreDb, actor })
  );
}

/** Rechecks Server admission alongside the actual querying Workspace and output audience. */
export function admitServerKnowledgeRetrieval(input: Target): void {
  admitKnowledgeRetrieval(input);
  if (
    !canReadServerKnowledge(input) ||
    resolve(input.access.coreDb!.dataRoot) !== resolve(input.dataRoot) ||
    !input.access.store.getDataRoot() ||
    resolve(input.access.store.getDataRoot()!) !== resolve(input.dataRoot)
  )
    throw new OperationError('workspace_access_denied', 'Server Knowledge access denied.', 403);
}

/** Reads exact Server Git pages and their same-scope literal/page Source closure under current authority. */
export function readAuthorizedServerNotebookPages(input: Target) {
  admitServerKnowledgeRetrieval(input);
  const context = {
    coreDb: input.access.coreDb!,
    actor: input.access.serverKnowledgeActor ?? input.access.requestActor,
  };
  const owner = resolveScopedNotebookOwner({ ...context, target: { kind: 'server' } });
  const pin = pinScopedNotebook({ ...context, target: { kind: 'server' } });
  const current = pin.read().files;
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const notebookRevision = input.notebookRevision ?? pin.notebookRevision;
  if (input.notebookRevision) notebook.history({ revision: notebookRevision, limit: 1 });
  const files =
    notebookRevision === pin.notebookRevision
      ? current
      : notebook.readRevision(notebookRevision).files;
  const scopeSchemaText = readFileSync(
    join(owner.notebookRoot, 'schema', 'scope-schema.yaml'),
    'utf8'
  );
  const schema = parseScopeKnowledgeSchema(scopeSchemaText);
  if (!schema.ok) throw new NotebookError('recovery_required');
  const registeredSources = new Map<string, string | null>();
  const proofs = new Map<string, KnowledgePageReferenceProof>();
  const eligible = (
    id: string,
    content: string,
    selected: Readonly<Record<string, string>>,
    visiting: ReadonlySet<string>
  ): boolean => {
    if (visiting.has(id)) return false;
    const parsed = parseOkfDocument({ path: `${id}.md`, content });
    if (!parsed.ok) return false;
    if (!parsed.document.reserved) {
      const report = validateScopeKnowledgeSchema(parsed.document, schema.schema, {
        kind: 'server',
      });
      if (report.conformance !== 'scope-schema-valid' || report.errors.length) return false;
    }
    const sensitivity = stringFrontmatterField(parsed.document, 'sensitivity');
    if (
      sensitivity === 'restricted' ||
      sensitivity === 'confidential' ||
      (parsed.document.frontmatter.sensitivity !== undefined &&
        !schema.schema.allowedSensitivities.includes(sensitivity ?? ''))
    )
      return false;
    const declaredRefs = stringListFrontmatterField(parsed.document, 'source_refs');
    if (
      declaredRefs === null &&
      (!parsed.document.reserved || parsed.document.frontmatter.source_refs !== undefined)
    )
      return false;
    const refs = declaredRefs ?? [];
    const next = new Set([...visiting, id]);
    for (const reference of refs) {
      if (reference.startsWith('source:')) {
        const { targetId } = resolveRegisteredKnowledgeSourceReference(
          reference,
          registeredSources
        );
        if (!targetId) return false;
        const source = readServerKnowledgeSource(context, targetId);
        if (!source) return false;
        registeredSources.set(targetId, source.source.contentDigest);
        if (!resolveRegisteredKnowledgeSourceReference(reference, registeredSources).resolved)
          return false;
      } else if (reference.startsWith('knowledge:')) {
        const match = /^knowledge:([^@]+)(?:@(sha256:[a-f0-9]{64}))?$/.exec(reference);
        const source = match ? selected[`${match[1]}.md`] : undefined;
        if (
          !match ||
          source === undefined ||
          (match[2] && digest(source) !== match[2]) ||
          !eligible(match[1]!, source, selected, next)
        )
          return false;
        // A retained reference cannot bypass a later restriction on its current source page.
        const currentSource = current[`${match[1]}.md`];
        if (
          selected !== current &&
          currentSource !== undefined &&
          !eligible(match[1]!, currentSource, current, new Set())
        )
          return false;
      } else return false;
    }
    proofs.set(id, {
      knowledgePageId: id,
      contentDigest: digest(content),
      sourceReferences: [...new Set(refs)].sort(),
      resolvedReferences: new Set(refs),
    });
    return true;
  };
  const ids =
    input.pageIds ??
    Object.keys(files)
      .filter((path) => !['index.md', 'log.md'].includes(basename(path)))
      .map((path) => path.slice(0, -3))
      .sort();
  const pages: AuthorizedWorkspaceNotebookPage[] = [];
  for (const id of ids) {
    const content = files[`${id}.md`];
    if (
      content === undefined ||
      (current[`${id}.md`] !== undefined &&
        !eligible(id, current[`${id}.md`]!, current, new Set())) ||
      !eligible(id, content, files, new Set())
    ) {
      if (input.pageIds)
        throw new OperationError('workspace_access_denied', 'Knowledge page is unavailable.', 403);
      continue;
    }
    pages.push({ id, path: `${id}.md`, content, contentDigest: digest(content) });
  }
  admitServerKnowledgeRetrieval(input);
  const selectedIds = new Set(pages.map(({ id }) => id));
  return {
    notebookRevision,
    pages,
    scopeSchemaText,
    registeredSources,
    referenceProofs: new Map([...proofs].filter(([id]) => selectedIds.has(id))),
  };
}

/** Verifies the commit that actually introduced these exact delegated page bytes, not a model-authored label. */
export function knowledgePageDelegated(
  input: Target,
  pageId: string,
  content: string,
  sourceScope: 'workspace' | 'server' = 'workspace'
): boolean {
  if (sourceScope === 'server') admitServerKnowledgeRetrieval(input);
  else admitKnowledgeRetrieval(input);
  const notebook = new KnowledgeNotebook({
    repositoryPath:
      sourceScope === 'server'
        ? join(input.dataRoot, 'server', 'knowledge', 'notebook.git')
        : join(input.dataRoot, 'workspaces', input.workspaceId, 'knowledge', 'notebook.git'),
  });
  const revision = input.notebookRevision ?? notebook.publishedRevision();
  notebook.history({ revision, limit: 1 });
  let record = notebook.inspectRevision(revision);
  const path = `${pageId}.md`;
  const blob = record.entries[path];
  if (!blob || notebook.readRevision(revision, [path]).files[path] !== content) return false;
  while (record.parentRevision) {
    const parent = notebook.inspectRevision(record.parentRevision);
    if (parent.entries[path] !== blob) break;
    record = parent;
  }
  return (
    record.metadata.producer.kind === 'agent' &&
    record.metadata.producer.responsibleUserId !== null &&
    (record.metadata.authority.kind === 'delegated' || record.metadata.authority.kind === 'direct')
  );
}

/** Memory search requires current self authority and an actual private Assistant output Timeline. */
export type UserMemoryRetrievalAccess = KnowledgeRetrievalAccess & {
  coreDb: CoreDb;
  userDb: UserDb;
  requestActor: Actor;
  outputThreadId: string;
};
interface Target {
  dataRoot: string;
  workspaceId: string;
  access: KnowledgeRetrievalAccess;
  /** Exact already selected published commit; omitted only at initial request admission. */
  notebookRevision?: string | undefined;
  /** Restricts proof reads to exact selected identities when the caller already has a selection. */
  pageIds?: readonly string[] | undefined;
}

/** Current User/private Timeline admission precedes all Memory inventory, Kernel and trace access. */
export function admitUserMemoryRetrieval(input: Target): void {
  const { access } = input;
  try {
    if (
      !access.coreDb ||
      !access.requestActor ||
      access.actor.kind !== 'user' ||
      access.actor.id !== access.requestActor.userId ||
      !access.outputThreadId ||
      resolve(access.coreDb.dataRoot) !== resolve(input.dataRoot) ||
      !access.store.getDataRoot() ||
      resolve(access.store.getDataRoot()!) !== resolve(input.dataRoot)
    )
      throw new Error('Memory owner unavailable.');
    resolveScopedNotebookOwner({
      coreDb: access.coreDb,
      actor: access.requestActor,
      target: { kind: 'user' },
    });
    if (access.userDb)
      admitMemoryContext({
        coreDb: access.coreDb,
        actor: access.requestActor,
        userDb: access.userDb,
      });
    ReferenceScopeIdSchema.parse(`page/user/${access.requestActor.userId}`);
    const timeline = findAssistantTimeline(
      access.store,
      input.workspaceId,
      access.requestActor.userId
    );
    if (!timeline || timeline.id !== access.outputThreadId)
      throw new Error('Private Timeline unavailable.');
    admitKnowledgeRetrieval(input);
    resolveKnowledgeQueryContext(input);
  } catch {
    throw new OperationError('memory_access_denied', 'Memory retrieval access denied.', 403);
  }
}

/** Reads exact published User pages after current self, private audience, schema, Source integrity and page-id suppression admission. */
export function readAuthorizedUserMemoryPages(input: Target) {
  admitUserMemoryRetrieval(input);
  const coreDb = input.access.coreDb!;
  const actor = input.access.requestActor!;
  const owner = resolveScopedNotebookOwner({ coreDb, actor, target: { kind: 'user' } });
  const userRoot = join(input.dataRoot, 'users', actor.userId);
  let sqlite: Database.Database | undefined;
  try {
    let userDb = input.access.userDb;
    for (const path of [
      input.dataRoot,
      join(input.dataRoot, 'users'),
      userRoot,
      join(userRoot, 'db'),
    ])
      assertCanonicalDirectory(path);
    const path = userDbPath(input.dataRoot, actor.userId);
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (userDb && !userDb.sqlite.open))
      throw new NotebookError('recovery_required');
    if (!userDb) {
      // Existing trace consumers open read-only authority and never initialize or migrate a User store.
      sqlite = new Database(path, { readonly: true, fileMustExist: true });
      userDb = { scope: 'user', dataRoot: input.dataRoot, userId: actor.userId, sqlite };
    }
    const context = { coreDb, userDb, actor };
    admitMemoryContext(context);
    const pin = pinScopedNotebook({ coreDb, actor, target: { kind: 'user' } });
    const current = pin.read().files;
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(owner.notebookRoot, 'notebook.git'),
    });
    const notebookRevision = input.notebookRevision ?? pin.notebookRevision;
    if (input.notebookRevision) notebook.history({ revision: notebookRevision, limit: 1 });
    const files =
      notebookRevision === pin.notebookRevision
        ? current
        : notebook.readRevision(notebookRevision).files;
    const scopeSchemaText = readFileSync(
      join(owner.notebookRoot, 'schema', 'scope-schema.yaml'),
      'utf8'
    );
    const schema = parseScopeKnowledgeSchema(scopeSchemaText);
    if (!schema.ok) throw new NotebookError('recovery_required');
    // No User Conflict producer is joined. Never reinterpret Workspace rows as User authority.
    const conflicts = join(owner.notebookRoot, 'conflicts');
    if (lstatSync(conflicts, { throwIfNoEntry: false })) {
      assertCanonicalDirectory(conflicts);
      if (readdirSync(conflicts).length) throw new NotebookError('recovery_required');
    }
    const suppressed = new Set(
      readMemorySuppressions(owner.notebookRoot, actor.userId).map(({ payload }) => payload.pageId)
    );
    const registeredSources = new Map<string, string | null>();
    const eligible = (id: string, content: string) => {
      if (suppressed.has(id) || !memoryPageFacts(`${id}.md`, content)) return false;
      const parsed = parseOkfDocument({ path: `${id}.md`, content });
      if (!parsed.ok) throw new NotebookError('recovery_required');
      const report = validateScopeKnowledgeSchema(parsed.document, schema.schema, owner.ownerScope);
      if (report.conformance !== 'scope-schema-valid' || report.errors.length)
        throw new NotebookError('recovery_required');
      try {
        const admitted = admitUserMemorySources(context, { [`${id}.md`]: content });
        for (const [sourceId, sourceDigest] of admitted.registeredSources)
          registeredSources.set(sourceId, sourceDigest);
      } catch (error) {
        if (error instanceof NotebookError && error.code === 'invalid_request') return false;
        throw error;
      }
      return true;
    };
    const ids =
      input.pageIds ??
      Object.keys(files)
        .filter((path) => !['index.md', 'log.md'].includes(basename(path)))
        .map((path) => path.slice(0, -3))
        .sort();
    const pages: AuthorizedWorkspaceNotebookPage[] = [];
    for (const id of ids) {
      const content = files[`${id}.md`];
      if (
        content === undefined ||
        !eligible(id, content) ||
        (current[`${id}.md`] !== undefined && !eligible(id, current[`${id}.md`]!))
      ) {
        if (input.pageIds)
          throw new OperationError('memory_access_denied', 'Memory page is unavailable.', 403);
        continue;
      }
      pages.push({ id, path: `${id}.md`, content, contentDigest: digest(content) });
    }
    admitUserMemoryRetrieval(input);
    return {
      notebookRevision,
      pages,
      scopeSchemaText,
      registeredSources,
      referenceProofs: new Map<string, KnowledgePageReferenceProof>(),
    };
  } catch (error) {
    if (error instanceof OperationError || error instanceof NotebookError) throw error;
    throw new NotebookError('recovery_required');
  } finally {
    sqlite?.close();
  }
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
  if (access.requestActor && access.requestActor.userId !== responsibleUserIdForActor(access.actor))
    throw new OperationError('workspace_access_denied', 'Knowledge retrieval access denied.', 403);
  const allowed = access.coreDb
    ? access.requestActor
      ? isWorkspaceOperationAuthorized(access.coreDb, access.requestActor, workspaceId, {
          mutating: false,
          policyOperation: 'knowledge.read',
        })
      : currentWorkspaceAuthority(
          access.coreDb,
          workspaceId,
          access.actor,
          'knowledge.read',
          true
        ) !== null
    : access.actor.kind === 'user' &&
      isEntityId('usr', access.actor.id) &&
      access.requestActor?.kind === 'local' &&
      access.requestActor.userId === access.actor.id;
  if (!allowed || (access.outputThreadId && !threadReadable(input, access.outputThreadId)))
    throw new OperationError('workspace_access_denied', 'Knowledge retrieval access denied.', 403);
}
/** Checks Thread source/destination audience after current Workspace and credential admission. */
export function threadReadable(
  input: Pick<Target, 'workspaceId' | 'access'>,
  threadId: string
): boolean {
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
/**
 * Checks current registered Source audience and origin lineage after current Workspace/credential admission.
 * This predicate admits identity disclosure only; it grants no publication permission or byte-integrity proof.
 */
export function knowledgeSourceAudienceReadable(
  input: Pick<Target, 'workspaceId' | 'access'>,
  sourceId: string
): boolean {
  admitKnowledgeRetrieval(input);
  try {
    const source = input.access.store.getKnowledgeSource(input.workspaceId, sourceId);
    if (source.originatingThreadId && !threadReadable(input, source.originatingThreadId))
      return false;
    if (source.originatingTurnId) {
      const turn = input.access.store.getTurnById(source.originatingTurnId);
      if (
        !source.originatingThreadId ||
        turn.workspaceId !== input.workspaceId ||
        turn.threadId !== source.originatingThreadId
      )
        return false;
    }
  } catch {
    return false;
  }
  admitKnowledgeRetrieval(input);
  return true;
}

/** Exact published bytes and external work owners establish source proof, never a human Review. */
export function currentKnowledgeReferenceProofs(
  input: Pick<Target, 'workspaceId' | 'access' | 'notebookRevision' | 'pageIds'>
): ReadonlyMap<string, KnowledgePageReferenceProof> {
  const { access, workspaceId } = input;
  const db = access.coreDb ? openWorkspaceDb(access.coreDb.dataRoot, workspaceId) : undefined;
  try {
    return resolveWorkspaceKnowledgeReferenceProofs({
      coreDb: access.coreDb,
      store: access.store,
      workspaceDb: db,
      workspaceId,
      notebookRevision: input.notebookRevision,
      pageIds: input.pageIds,
    });
  } finally {
    db?.sqlite.close();
  }
}
/** Request-local immutable content selection; this object contains no retained authorization grant. */
interface PinnedNotebookTarget extends Target {
  readonly notebook: KnowledgeNotebook;
  readonly notebookRevision: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly contents: Map<string, string>;
}

/** Derives the physical root from the Store and admits only current published ancestry. */
function pinNotebook(input: Target): PinnedNotebookTarget {
  admitKnowledgeRetrieval(input);
  const dataRoot = input.access.store.getDataRoot();
  if (
    !dataRoot ||
    resolve(dataRoot) !== resolve(input.dataRoot) ||
    (input.access.coreDb && resolve(input.access.coreDb.dataRoot) !== resolve(dataRoot))
  )
    throw new OperationError('workspace_access_denied', 'Knowledge retrieval access denied.', 403);
  input.access.store.getWorkspace(input.workspaceId);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', input.workspaceId, 'knowledge', 'notebook.git'),
  });
  const notebookRevision = input.notebookRevision ?? notebook.publishedRevision();
  if (input.notebookRevision !== undefined)
    notebook.history({ revision: notebookRevision, limit: 1 });
  return {
    ...input,
    dataRoot,
    notebook,
    notebookRevision,
    entries: notebook.inspectRevision(notebookRevision).entries,
    contents: new Map(),
  };
}

/** Loads only requested immutable blobs; selected object damage is an explicit content-owner failure. */
function pinnedPage(input: PinnedNotebookTarget, pageId: string): string | null {
  const path = `${pageId}.md`;
  if (!Object.hasOwn(input.entries, path)) return null;
  if (!input.contents.has(pageId))
    input.contents.set(
      pageId,
      input.notebook.readRevision(input.notebookRevision, [path]).files[path]!
    );
  return input.contents.get(pageId)!;
}

/** Checks exact pinned bytes and their full source closure without granting a Review. */
function pinnedPageReadable(
  input: PinnedNotebookTarget,
  pageId: string,
  content: string,
  visiting: ReadonlySet<string>
): boolean {
  if (visiting.has(pageId) || pinnedPage(input, pageId) !== content) return false;
  const parsed = parseOkfDocument({ path: `knowledge/pages/${pageId}.md`, content });
  if (!parsed.ok) return false;
  const sensitivity = stringFrontmatterField(parsed.document, 'sensitivity');
  if (
    parsed.document.frontmatter.sensitivity !== undefined &&
    (sensitivity === null ||
      (!DEFAULT_SCOPE_KNOWLEDGE_SCHEMA.allowedSensitivities.includes(sensitivity) &&
        sensitivity !== 'restricted'))
  )
    return false;
  const refs = stringListFrontmatterField(parsed.document, 'source_refs');
  if (refs === null && !parsed.document.reserved) return false;
  return pinnedSourcesReadable(input, refs ?? [], new Set([...visiting, pageId]));
}

/** Reuses the completed-work owner, then intersects every source with its current bytes and audience. */
function pinnedSourcesReadable(
  input: PinnedNotebookTarget,
  refs: readonly string[],
  visiting: ReadonlySet<string>
): boolean {
  admitKnowledgeRetrieval(input);
  const { store } = input.access;
  const sources = new Map(
    store.listKnowledgeSources(input.workspaceId).map((source) => [source.id, source.contentDigest])
  );
  const workspaceDb =
    input.access.coreDb &&
    refs.some((reference) => /^(?:turn|item|context-package):/.test(reference))
      ? openWorkspaceDb(input.access.coreDb.dataRoot, input.workspaceId)
      : undefined;
  try {
    verifyKnowledgeProposalWorkHistory({
      coreDb: input.access.coreDb,
      workspaceDb,
      sourceReferences: refs,
      store,
      workspaceId: input.workspaceId,
      allowImportedHistory: Boolean(store.getWorkspace(input.workspaceId).importedFrom),
    });
    for (const reference of refs) {
      if (reference.startsWith('source:')) {
        const resolution = resolveRegisteredKnowledgeSourceReference(reference, sources);
        if (!resolution.resolved || !resolution.targetId) return false;
        if (!knowledgeSourceAudienceReadable(input, resolution.targetId)) return false;
        const source = store.getKnowledgeSource(input.workspaceId, resolution.targetId);
        const material = store.readKnowledgeSourceMaterial(input.workspaceId, source.id);
        if (material === null || digest(material) !== source.contentDigest) return false;
        if (!knowledgeSourceAudienceReadable(input, source.id)) return false;
      } else if (reference.startsWith('knowledge:')) {
        const match = /^knowledge:([^@]+)(?:@(sha256:[a-f0-9]{64}))?$/.exec(reference);
        if (!match) return false;
        const content = pinnedPage(input, match[1]!);
        if (content === null || (match[2] && digest(content) !== match[2])) return false;
        if (!pinnedKnowledgeSourceReadable(input, match[1]!, content, visiting)) return false;
        // Exact history stays pinned; later source restrictions still govern its disclosure.
        const currentRevision = input.notebook.publishedRevision();
        if (currentRevision !== input.notebookRevision) {
          const current = pinNotebook({ ...input, notebookRevision: currentRevision });
          const currentContent = pinnedPage(current, match[1]!);
          if (
            currentContent !== null &&
            !pinnedKnowledgeSourceReadable(current, match[1]!, currentContent, new Set())
          )
            return false;
        }
      } else if (reference.startsWith('turn:')) {
        const turn = store.getTurnById(reference.slice(5));
        if (turn.workspaceId !== input.workspaceId || !threadReadable(input, turn.threadId))
          return false;
      } else if (!reference.startsWith('item:') && !reference.startsWith('context-package:'))
        return false;
    }
    admitKnowledgeRetrieval(input);
    return true;
  } catch (error) {
    if (error instanceof NotebookError) throw error;
    return false;
  } finally {
    workspaceDb?.sqlite.close();
  }
}

/** Applies source sensitivity and recursive audience checks within one selected revision. */
function pinnedKnowledgeSourceReadable(
  input: PinnedNotebookTarget,
  pageId: string,
  content: string,
  visiting: ReadonlySet<string>
): boolean {
  const parsed = parseOkfDocument({ path: `knowledge/pages/${pageId}.md`, content });
  const sensitivity = parsed.document
    ? stringFrontmatterField(parsed.document, 'sensitivity')
    : null;
  return (
    parsed.ok &&
    sensitivity !== null &&
    sensitivity !== 'restricted' &&
    sensitivity !== 'confidential' &&
    pinnedPageReadable(input, pageId, content, visiting)
  );
}

/** Verifies exact selected source bytes and current audience, including recursive pinned references. */
export function knowledgePageReadable(
  input: Target,
  pageId: string,
  content: string,
  visiting = new Set<string>()
): boolean {
  return pinnedPageReadable(pinNotebook(input), pageId, content, visiting);
}

/** Rechecks retained trace references against current authority and the same selected notebook commit. */
export function knowledgeSourceReferencesReadable(
  input: Target,
  pageId: string,
  refs: readonly string[],
  visiting = new Set<string>([pageId])
): boolean {
  return pinnedSourcesReadable(pinNotebook(input), refs, visiting);
}

/** Exact source-admitted page facts consumed by native Knowledge reads and retrieval. */
export interface AuthorizedWorkspaceNotebookPage {
  readonly id: string;
  readonly path: string;
  readonly content: string;
  readonly contentDigest: string;
}

/**
 * Reads one published Workspace notebook selection under current scope and source authority.
 * Inventory filters denied identities; explicitly requested denied or absent pages fail uniformly.
 * The returned commit and bytes never follow a later publication during this request.
 */
export function readAuthorizedWorkspaceNotebookPages(input: Target): {
  readonly notebookRevision: string;
  readonly pages: readonly AuthorizedWorkspaceNotebookPage[];
  readonly referenceProofs: ReadonlyMap<string, KnowledgePageReferenceProof>;
} {
  const pinned = pinNotebook(input);
  const ids =
    input.pageIds ??
    Object.keys(pinned.entries)
      .filter((path) => !['index.md', 'log.md'].includes(basename(path)))
      .map((path) => path.slice(0, -3))
      .sort();
  // Inventory owns the complete body enumeration; selected reads keep unrelated blobs unloaded.
  if (input.pageIds === undefined) {
    const files = pinned.notebook.readRevision(
      pinned.notebookRevision,
      ids.map((id) => `${id}.md`)
    ).files;
    for (const id of ids) pinned.contents.set(id, files[`${id}.md`]!);
  }
  const pages: AuthorizedWorkspaceNotebookPage[] = [];
  for (const id of ids) {
    const content = pinnedPage(pinned, id);
    if (content === null || !pinnedPageReadable(pinned, id, content, new Set())) {
      if (input.pageIds)
        throw new OperationError('workspace_access_denied', 'Knowledge page is unavailable.', 403);
      continue;
    }
    pages.push({ id, path: `${id}.md`, content, contentDigest: digest(content) });
  }
  const referenceProofs = currentKnowledgeReferenceProofs({
    ...pinned,
    pageIds: pages.map(({ id }) => id),
  });
  // Source/work verification can observe changed owners; old disclosure eligibility is never a return grant.
  const currentPages = pages.filter(({ id, content }) =>
    pinnedPageReadable(pinned, id, content, new Set())
  );
  if (input.pageIds && currentPages.length !== pages.length)
    throw new OperationError('workspace_access_denied', 'Knowledge page is unavailable.', 403);
  const currentIds = new Set(currentPages.map(({ id }) => id));
  admitKnowledgeRetrieval(pinned);
  return {
    notebookRevision: pinned.notebookRevision,
    pages: currentPages,
    referenceProofs: new Map([...referenceProofs].filter(([id]) => currentIds.has(id))),
  };
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
/** Enumerates one published Git revision after current scope and recursive source admission. */
export function collectKnowledgeInventory(input: Target): {
  view: RetrievalScope;
  notebookRevision: string;
  referenceProofs: ReadonlyMap<string, KnowledgePageReferenceProof>;
} {
  const { notebookRevision, pages, referenceProofs } = readAuthorizedWorkspaceNotebookPages(input);
  const documents: RetrievalDocument[] = [];
  for (const { id, content } of pages) {
    const parsed = parseOkfDocument({ path: `knowledge/pages/${id}.md`, content });
    const doc = parsed.document;
    const canonicalDigest = digest(content).slice(7);
    const language = doc ? stringFrontmatterField(doc, 'language') : null;
    documents.push({
      key: { namespace: 'knowledge', id },
      revision: notebookRevision,
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
    notebookRevision,
    referenceProofs,
  };
}
/** Enumerates one admitted Server Knowledge base in its own existing Kernel eligibility partition. */
export function collectServerKnowledgeInventory(input: Target) {
  const admitted = readAuthorizedServerNotebookPages(input);
  const documents: RetrievalDocument[] = admitted.pages.map(({ id, content }) => {
    const doc = parseOkfDocument({ path: `${id}.md`, content }).document!;
    const language = stringFrontmatterField(doc, 'language');
    return {
      key: { namespace: 'knowledge', id },
      revision: admitted.notebookRevision,
      digest: digest(content).slice(7),
      size: Buffer.byteLength(content),
      name: `${id}.md`,
      title: stringFrontmatterField(doc, 'title') ?? id,
      media_type: 'text/markdown',
      text_ranges: textRanges(content, doc.body),
      ...(language === 'zh' || language === 'ja' || language === 'unicode' ? { language } : {}),
      metadata: { sourceScope: 'server', knowledgePageId: id },
      locator: `server/knowledge/pages/${id}.md`,
      content: { kind: 'inline-text', text: content },
    };
  });
  return {
    ...admitted,
    view: {
      scope: JSON.stringify([
        'knowledge',
        'server',
        input.workspaceId,
        responsibleUserIdForActor(input.access.actor),
        input.access.outputThreadId ?? null,
      ]),
      documents,
    },
  };
}
/** Enumerates only admitted self pages in the existing Kernel, separately from Workspace Knowledge and raw Sources. */
export function collectUserMemoryInventory(input: Target) {
  const admitted = readAuthorizedUserMemoryPages(input);
  const userId = input.access.requestActor!.userId;
  const documents: RetrievalDocument[] = admitted.pages.map(({ id, content }) => {
    const doc = parseOkfDocument({ path: `${id}.md`, content }).document!;
    const language = stringFrontmatterField(doc, 'language');
    return {
      key: { namespace: 'memory', id },
      revision: admitted.notebookRevision,
      digest: digest(content).slice(7),
      size: Buffer.byteLength(content),
      name: `${id}.md`,
      title: stringFrontmatterField(doc, 'title') ?? id,
      media_type: 'text/markdown',
      text_ranges: textRanges(content, doc.body),
      ...(language === 'zh' || language === 'ja' || language === 'unicode' ? { language } : {}),
      metadata: { userId, workspaceId: input.workspaceId, knowledgePageId: id },
      locator: `memory/pages/${id}.md`,
      content: { kind: 'inline-text', text: content },
    };
  });
  return {
    ...admitted,
    view: {
      scope: JSON.stringify(['memory', userId, input.workspaceId, input.access.outputThreadId]),
      documents,
    },
  };
}
/** Exact SHA-256 page identity, independent of the retained Git commit identity. */
function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
