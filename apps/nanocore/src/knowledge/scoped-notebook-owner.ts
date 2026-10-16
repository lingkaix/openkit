import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  DeploymentAdminRequiredError,
  isCanonicalUserOperationAuthorized,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
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
}

/** Scope-only raw content boundary; it is not a Source, output-audience, sensitivity or suppression grant. */
export interface PinnedScopedNotebook {
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
  if (!input.actor) throw new ScopedNotebookAccessError();
  if (input.target.kind === 'user') {
    if (!isCanonicalUserOperationAuthorized(input.coreDb, input.actor))
      throw new ScopedNotebookAccessError();
    return {
      ownerScope: { kind: 'user', userId: input.actor.userId },
      notebookRoot: userMemoryRoot(input.coreDb.dataRoot, input.actor.userId),
    };
  }
  try {
    requireCurrentDeploymentAdmin(input.coreDb, input.actor);
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError) throw new ScopedNotebookAccessError();
    throw error;
  }
  if (input.target.kind === 'user-inspection') {
    if (!isCanonicalUserActive(input.coreDb, input.target.userId))
      throw new ScopedNotebookAccessError();
    return {
      ownerScope: { kind: 'user', userId: input.target.userId },
      notebookRoot: userMemoryRoot(input.coreDb.dataRoot, input.target.userId),
    };
  }
  if (input.target.kind !== 'server') throw new ScopedNotebookAccessError();
  return {
    ownerScope: { kind: 'server' },
    notebookRoot: serverKnowledgeRoot(input.coreDb.dataRoot),
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
  };
  const owner = resolveScopedNotebookOwner(context);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const notebookRevision = notebook.publishedRevision();
  return {
    ownerScope: owner.ownerScope,
    notebookRevision,
    read: (paths) => {
      resolveScopedNotebookOwner(context);
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
  const owner = resolveScopedNotebookOwner(input);
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
  return initializeNotebook({
    notebookRoot: owner.notebookRoot,
    owner: userDb ? { kind: 'user', userDb } : { kind: 'server', coreDb: input.coreDb },
    initialization: {
      requestId: input.initialization.requestId,
      instructionReference: input.initialization.instructionReference,
      producer: { kind: 'user', id: input.actor!.userId },
    },
    revalidate: () => {
      resolveScopedNotebookOwner(input);
      return {
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        reviewRequiredPageIds: [],
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      };
    },
  });
}
