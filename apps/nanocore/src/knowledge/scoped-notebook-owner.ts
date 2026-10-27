import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  DeploymentAdminRequiredError,
  evaluateProductAuthorization,
} from '../auth/operation-authorizer.js';
import {
  initializeDefaultKnowledgeBaseId,
  readDefaultKnowledgeBaseId,
} from '../config/knowledge-base.js';
import type { CoreDb, UserDb } from '../storage/db.js';
import { serverKnowledgeRoot, userMemoryRoot } from '../storage/fs-layout.js';
import { KnowledgeNotebook, NotebookError, type NotebookRevision } from './notebook.js';
import { initializeNotebook } from './notebook-initialization.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  validateScopeKnowledgeSchema,
} from './okf.js';

/** Native target selection: self never accepts another User; administrative inspection is a separate explicit request. */
export type ScopedNotebookTarget =
  | { readonly kind: 'user' }
  | { readonly kind: 'user-inspection'; readonly userId: string }
  | { readonly kind: 'server' };

/** Trusted native authentication and canonical Core authority, never notebook metadata or model arguments. */
export interface ScopedNotebookContext {
  readonly coreDb: CoreDb;
  readonly actor: Actor | undefined;
  readonly target: ScopedNotebookTarget;
  /** Concrete native action; inspection remains read-only at its caller. */
  readonly operation?: 'knowledge.read' | 'knowledge.write' | 'review.apply';
}

/** Scope-only raw content boundary; it is not a Source, output-audience, sensitivity or suppression grant. */
export interface PinnedScopedNotebook {
  /** Exact retained default base; canonical owner admission remains separate. */
  readonly knowledgeBaseId: string;
  readonly ownerScope: Exclude<KnowledgeOwnerScope, { kind: 'workspace' }>;
  readonly notebookRevision: string;
  /** Internal exact-byte read; native consumers must apply current Source/audience/suppression admission before public or model disclosure. */
  readonly read: (paths?: readonly string[]) => NotebookRevision;
}

/** Uniform scope refusal carries no owner existence, notebook content or host path. */
export class ScopedNotebookAccessError extends Error {
  constructor() {
    super('Scoped notebook access denied.');
    this.name = 'ScopedNotebookAccessError';
  }
}

/** Resolves current scope eligibility before deriving a canonical root; Workspace membership grants no Memory access. */
export function resolveScopedNotebookOwner(input: ScopedNotebookContext): {
  readonly ownerScope: PinnedScopedNotebook['ownerScope'];
  readonly notebookRoot: string;
} {
  if (!input.actor || !['user', 'user-inspection', 'server'].includes(input.target.kind))
    throw new ScopedNotebookAccessError();
  const target =
    input.target.kind === 'server'
      ? { kind: 'server' as const, family: 'knowledge' }
      : input.target.kind === 'user'
        ? { kind: 'user' as const }
        : { kind: 'user' as const, userId: input.target.userId };
  const operation = input.operation ?? 'knowledge.read';
  try {
    if (
      evaluateProductAuthorization(
        input.coreDb,
        input.actor,
        target,
        operation,
        operation !== 'knowledge.read'
      ).effect !== 'allow'
    )
      throw new ScopedNotebookAccessError();
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError) throw new ScopedNotebookAccessError();
    throw error;
  }
  const ownerScope: PinnedScopedNotebook['ownerScope'] =
    input.target.kind === 'server'
      ? { kind: 'server' }
      : {
          kind: 'user',
          userId: input.target.kind === 'user' ? input.actor.userId : input.target.userId,
        };
  return {
    ownerScope,
    notebookRoot:
      ownerScope.kind === 'user'
        ? userMemoryRoot(input.coreDb.dataRoot, ownerScope.userId)
        : serverKnowledgeRoot(input.coreDb.dataRoot),
  };
}

/**
 * Pins one immutable published commit for internal native consumers and rechecks current scope admission before every raw read.
 *
 * This performs structural owner/schema validation only. Source disclosure, output audience and forget suppression must be joined before any public/model read; this function supplies none of those grants and never initializes or reads a materialized fallback.
 */
export function pinScopedNotebook(input: ScopedNotebookContext): PinnedScopedNotebook {
  const context = {
    coreDb: input.coreDb,
    actor: input.actor ? { ...input.actor } : undefined,
    target: { ...input.target },
    // Raw bytes always require read authority, including reads made by a writer.
    operation: 'knowledge.read' as const,
  };
  const owner = resolveScopedNotebookOwner(context);
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: input.coreDb.dataRoot,
    scope: owner.ownerScope,
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const notebookRevision = notebook.publishedRevision();
  return {
    ownerScope: owner.ownerScope,
    knowledgeBaseId,
    notebookRevision,
    read: (paths) => {
      resolveScopedNotebookOwner(context);
      if (
        readDefaultKnowledgeBaseId({ dataRoot: input.coreDb.dataRoot, scope: owner.ownerScope }) !==
        knowledgeBaseId
      )
        throw new NotebookError('recovery_required');
      let schemaText: string;
      try {
        schemaText = readFileSync(join(owner.notebookRoot, 'schema', 'scope-schema.yaml'), 'utf8');
      } catch {
        throw new NotebookError('recovery_required');
      }
      const schema = parseScopeKnowledgeSchema(schemaText);
      if (!schema.ok) throw new NotebookError('recovery_required');
      const revision = notebook.readRevision(notebookRevision, paths);
      for (const [path, content] of Object.entries(revision.files)) {
        const parsed = parseOkfDocument({ path, content });
        if (!parsed.ok) throw new NotebookError('recovery_required');
        if (parsed.document.reserved) continue;
        const report = validateScopeKnowledgeSchema(
          parsed.document,
          schema.schema,
          owner.ownerScope
        );
        if (report.conformance !== 'scope-schema-valid' || report.errors.length)
          throw new NotebookError('recovery_required');
      }
      return revision;
    },
  };
}

/** Explicit native fresh-scope initialization; it accepts no authored files, administrative User target or caller-supplied producer. */
export function initializeScopedNotebook(
  input: Omit<ScopedNotebookContext, 'target'> & {
    readonly initialization: { readonly requestId: string; readonly instructionReference: string };
  } & (
      | { readonly target: { readonly kind: 'user' }; readonly userDb: UserDb }
      | { readonly target: { readonly kind: 'server' } }
    )
): string {
  const owner = resolveScopedNotebookOwner({ ...input, operation: 'knowledge.write' });
  if (lstatSync(owner.notebookRoot, { throwIfNoEntry: false }))
    throw new NotebookError('recovery_required');
  const userDb = input.target.kind === 'user' && 'userDb' in input ? input.userDb : undefined;
  if (
    input.target.kind === 'user' &&
    (!userDb ||
      userDb.userId !== input.actor!.userId ||
      resolve(userDb.dataRoot) !== resolve(input.coreDb.dataRoot))
  )
    throw new NotebookError('invalid_request');
  const knowledgeBaseId = initializeDefaultKnowledgeBaseId({
    dataRoot: input.coreDb.dataRoot,
    scope: owner.ownerScope,
  });
  return initializeNotebook({
    notebookRoot: owner.notebookRoot,
    owner: userDb ? { kind: 'user', userDb } : { kind: 'server', coreDb: input.coreDb },
    initialization: {
      requestId: input.initialization.requestId,
      instructionReference: input.initialization.instructionReference,
      producer: { kind: 'user', id: input.actor!.userId },
    },
    revalidate: () => {
      resolveScopedNotebookOwner({ ...input, operation: 'knowledge.write' });
      return {
        pageScopeId:
          owner.ownerScope.kind === 'user'
            ? `page/user/${owner.ownerScope.userId}/${knowledgeBaseId}`
            : `page/server/${knowledgeBaseId}`,
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        reviewRequiredPageIds: [],
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      };
    },
  });
}
