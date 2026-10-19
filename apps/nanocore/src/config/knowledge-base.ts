import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type KnowledgeMount,
  KnowledgeMountsSchema,
  OpenKitConfigSchema,
  UserConfigSchema,
  WorkspaceConfigSchema,
} from '@openkit/config-schema';
import {
  allocateEntityId,
  KnowledgeBaseIdSchema,
  type KnowledgeOwnerScope,
  KnowledgeOwnerScopeSchema,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { applyEdits, modify } from 'jsonc-parser';
import { NotebookError } from '../knowledge/notebook.js';
import { serverKnowledgeRoot, userMemoryRoot } from '../storage/fs-layout.js';
import { readCanonicalTextFile, writeFileAtomic } from '../storage/workspace-file-records.js';
import { parseJsoncObject } from './jsonc.js';
import { openKitConfigPath } from './openkit-config.js';

/** An already admitted logical owner; this internal identity lookup grants no content access. */
interface KnowledgeBaseOwner {
  readonly dataRoot: string;
  readonly scope: KnowledgeOwnerScope;
}

/** Resolves the existing configuration and content owners without creating storage. */
function configurationOwner(input: KnowledgeBaseOwner, workspaceRoot?: string) {
  const scope = KnowledgeOwnerScopeSchema.parse(input.scope);
  if (scope.kind === 'workspace') {
    const root = workspaceRoot ?? join(input.dataRoot, 'workspaces', scope.workspaceId);
    return {
      path: join(root, 'config', 'workspace.jsonc'),
      notebookRoot: join(root, 'knowledge'),
      sourcesRoot: join(root, 'sources'),
      member: ['workspace', 'defaultKnowledgeBaseId'],
      mountsMember: ['workspace', 'knowledgeMounts'],
      schema: WorkspaceConfigSchema,
      empty: undefined,
    };
  }
  const notebookRoot =
    scope.kind === 'user'
      ? userMemoryRoot(input.dataRoot, scope.userId)
      : serverKnowledgeRoot(input.dataRoot);
  return {
    path:
      scope.kind === 'user'
        ? join(input.dataRoot, 'users', scope.userId, 'config', 'user.jsonc')
        : openKitConfigPath(input.dataRoot),
    notebookRoot,
    sourcesRoot: join(dirname(notebookRoot), 'sources'),
    member: ['defaultKnowledgeBaseId'],
    mountsMember: ['knowledgeMounts'],
    schema: scope.kind === 'user' ? UserConfigSchema : OpenKitConfigSchema,
    empty: `${JSON.stringify(writeRetainedV1({}))}\n`,
  };
}

/** Reads only the retained binding from a validated owner configuration. */
function readBinding(
  owner: ReturnType<typeof configurationOwner>,
  source: string,
  members = owner.member
): unknown {
  let value: unknown = readRetainedV1(parseJsoncObject(source), (record) =>
    owner.schema.parse(record)
  );
  for (const member of members) {
    value =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[member] : undefined;
  }
  return value;
}

/** Reads the exact established default ID; missing or invalid authority never allocates a replacement. */
export function readDefaultKnowledgeBaseId(input: KnowledgeBaseOwner): string {
  try {
    const owner = configurationOwner(input);
    return KnowledgeBaseIdSchema.parse(readBinding(owner, readCanonicalTextFile(owner.path)));
  } catch {
    throw new NotebookError('recovery_required');
  }
}

/** Reads explicit same-base mount declarations; lookup never creates a default or activates an unknown backend. */
export function readKnowledgeMounts(input: KnowledgeBaseOwner): readonly KnowledgeMount[] {
  try {
    const owner = configurationOwner(input);
    const source = readCanonicalTextFile(owner.path);
    const id = KnowledgeBaseIdSchema.parse(readBinding(owner, source));
    const mounts = KnowledgeMountsSchema.parse(readBinding(owner, source, owner.mountsMember));
    if (mounts.some((mount) => mount.knowledgeBaseId !== id))
      throw new NotebookError('recovery_required');
    // Additional mount names reserve logical raw subdirectories; managed originals cannot occupy them.
    if (
      mounts.some(
        (mount) =>
          !mount.default &&
          lstatSync(join(owner.notebookRoot, 'raw', mount.name), { throwIfNoEntry: false })
      )
    )
      throw new NotebookError('recovery_required');
    return mounts;
  } catch {
    throw new NotebookError('recovery_required');
  }
}

/**
 * Records the default binding during explicit fresh-scope creation, before its first Notebook or Source.
 *
 * Existing binding bytes are retained on retry. Workspace creation supplies its initial configuration in the existing unpublished staging root; published readers never call this writer.
 */
export function initializeDefaultKnowledgeBaseId(
  input: KnowledgeBaseOwner & {
    /** Existing unpublished Workspace staging root supplied by native creation. */
    readonly workspaceRoot?: string;
    /** Already reminted import identity; ordinary fresh creation allocates here. */
    readonly knowledgeBaseId?: string;
  }
): string {
  try {
    const owner = configurationOwner(input, input.workspaceRoot);
    const requested =
      input.knowledgeBaseId === undefined
        ? undefined
        : KnowledgeBaseIdSchema.parse(input.knowledgeBaseId);
    const source = existsSync(owner.path) ? readCanonicalTextFile(owner.path) : owner.empty;
    if (source === undefined) throw new NotebookError('recovery_required');
    const previous = readBinding(owner, source);
    if (previous !== undefined) {
      const retained = KnowledgeBaseIdSchema.parse(previous);
      if (requested !== undefined && retained !== requested)
        throw new NotebookError('recovery_required');
      const mounts = readBinding(owner, source, owner.mountsMember);
      if (mounts !== undefined) {
        KnowledgeMountsSchema.parse(mounts);
        return retained;
      }
      if (existsSync(join(owner.notebookRoot, 'notebook.git')) || existsSync(owner.sourcesRoot))
        throw new NotebookError('recovery_required');
      // This is still fresh native initialization with an explicitly supplied fixed ID, not conversion of an existing notebook.
      const mounted = applyEdits(
        source,
        modify(
          source,
          owner.mountsMember,
          [
            {
              name: 'managed',
              backend: 'local',
              root: 'raw',
              default: true,
              knowledgeBaseId: retained,
            },
          ],
          { formattingOptions: { insertSpaces: true, tabSize: 2 } }
        )
      );
      readBinding(owner, mounted);
      writeFileAtomic(owner.path, mounted);
      return retained;
    }
    if (existsSync(join(owner.notebookRoot, 'notebook.git')) || existsSync(owner.sourcesRoot)) {
      throw new NotebookError('recovery_required');
    }
    const id = requested ?? allocateEntityId('kb');
    const bound = applyEdits(
      source,
      modify(source, owner.member, id, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
    );
    const updated = applyEdits(
      bound,
      modify(
        bound,
        owner.mountsMember,
        [{ name: 'managed', backend: 'local', root: 'raw', default: true, knowledgeBaseId: id }],
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }
      )
    );
    if (readBinding(owner, updated) !== id) throw new NotebookError('recovery_required');
    writeFileAtomic(owner.path, updated);
    return id;
  } catch {
    throw new NotebookError('recovery_required');
  }
}
