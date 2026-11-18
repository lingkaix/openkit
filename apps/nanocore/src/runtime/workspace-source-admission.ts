import {
  type AgentEnvironmentPackage,
  requireCredentialFreeHttpsGitLocator,
  resolveWorkspaceDataSourceReference,
} from '@openkit/config-schema';
import { type PolicyDocumentV1, ThreadSchema, workspaceIdForOwner } from '@openkit/protocol';
import type { AgentManifest } from '../agents/manifest.js';
import { readThreadPolicyAncestors } from '../auth/thread-policy-ancestors.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { TurnStartValidationError } from '../operation-error.js';
import { readProduct } from '../storage/control-store-product-records.js';
import { type CoreDb, openWorkspaceReadDb } from '../storage/db.js';

/** Current configuration required to prove the bounded credential-free Git authority. */
export type WorkspaceSourceAuthorityConfiguration = Pick<
  RuntimeConfigSnapshot,
  'openKitConfig' | 'workspaceConfigs'
> &
  Partial<Pick<RuntimeConfigSnapshot, 'workspaceDataSourceCatalogs'>>;

/**
 * Refuses source constraints that the current Git snapshot cannot represent or enforce.
 * The authored reader still preserves these fields; using them must never select the whole source.
 */
export function assertSupportedWorkspaceSourceInputs(manifest: AgentManifest): void {
  for (const input of manifest.workspace?.inputs ?? []) {
    if (
      typeof input.sourceRef === 'string' &&
      Object.keys(input).some((key) => !['id', 'sourceRef', 'access'].includes(key))
    ) {
      throw blockedWorkspaceSource(
        'Workspace source input constraints are not supported. Remove the constraint or select a separately bounded catalog source, then submit a new request.'
      );
    }
  }
}

/**
 * Proves the subset with no applicable conditional Policy; evaluating source conditions remains unsupported.
 * A catalog entry and a cached root are never evidence that current Policy permits source ingress.
 */
export function assertWorkspaceSourcePolicy(
  current: WorkspaceSourceAuthorityConfiguration | undefined,
  workspaceId: string,
  threadId: string,
  coreDb?: CoreDb
): asserts current is WorkspaceSourceAuthorityConfiguration {
  if (!current) {
    throw blockedWorkspaceSource(
      'Current workspace source authority is unavailable. Reload source configuration and submit a new request, or remove this source input.'
    );
  }
  const workspace = current.workspaceConfigs.find((entry) => entry.workspaceId === workspaceId);
  if (
    hasUnprovedSourcePolicy(
      current.openKitConfig.policy?.mediation,
      workspaceId,
      threadId,
      coreDb
    ) ||
    hasUnprovedSourcePolicy(
      workspace?.config.workspace.policy?.mediation,
      workspaceId,
      threadId,
      coreDb
    )
  ) {
    throw blockedWorkspaceSource(
      'Current workspace source Policy intersection cannot be proved. Remove this source input and retry the remaining work, or ask an administrator for a supported source configuration.'
    );
  }
}

/** Skips only inactive statements and scopes proved unrelated to this source dispatch. */
function hasUnprovedSourcePolicy(
  policy: PolicyDocumentV1 | undefined,
  workspaceId: string,
  threadId: string,
  coreDb: CoreDb | undefined
): boolean {
  let scopes: string[] | undefined;
  return (
    policy?.statements.some((statement) => {
      if (statement.state !== 'active') return false;
      if (statement.scope.resources.length === 0) return true;
      return statement.scope.resources.some((resource) => {
        if (resource.kind !== 'container') return true;
        const { owner, kind, id } = resource.container;
        if (owner.kind === 'workspace' && owner.workspaceId !== workspaceId) return false;
        if (owner.kind === 'workspace' && kind === 'thread') {
          if (id === threadId) return true;
          if (!coreDb) return true;
          scopes ??= currentSourceThreadScopes(coreDb, workspaceId, threadId);
          return scopes.includes(id);
        }
        return true;
      });
    }) ?? false
  );
}

/** Reuses native Thread ancestry so a parent's Policy can never look like an unrelated scope. */
function currentSourceThreadScopes(
  coreDb: CoreDb,
  workspaceId: string,
  threadId: string
): string[] {
  let db: ReturnType<typeof openWorkspaceReadDb> | undefined;
  try {
    db = openWorkspaceReadDb(coreDb.dataRoot, workspaceId);
    const sqlite = db.sqlite;
    const owner = { kind: 'workspace', workspaceId } as const;
    const read = (id: string) => {
      const thread = ThreadSchema.parse(readProduct(sqlite, owner, 'thread', id)?.record);
      if (
        thread.id !== id ||
        thread.owner.kind !== 'workspace' ||
        workspaceIdForOwner(thread.owner) !== workspaceId
      ) {
        throw blockedWorkspaceSource(
          'Current source Thread Policy lineage is unavailable. Restore Thread metadata and submit a new request, or remove this source input.'
        );
      }
      return thread;
    };
    return [
      threadId,
      ...readThreadPolicyAncestors({ getThread: (_workspaceId, id) => read(id) }, read(threadId)),
    ];
  } catch {
    throw blockedWorkspaceSource(
      'Current source Thread Policy lineage is unavailable. Restore Thread metadata and submit a new request, or remove this source input.'
    );
  } finally {
    db?.sqlite.close();
  }
}

/**
 * Rechecks existing immutable Git snapshots after preparation awaits and at physical dispatch.
 * Generated Context Package inputs have a separate owner and do not select a catalog source.
 */
export function assertCurrentWorkspaceSources(
  environmentPackage: Pick<AgentEnvironmentPackage, 'scope' | 'workspace'>,
  readCurrent: (() => WorkspaceSourceAuthorityConfiguration) | undefined,
  coreDb?: CoreDb
): void {
  const sources = environmentPackage.workspace.inputs.filter(
    (input) => input.source.kind !== 'generated'
  );
  if (sources.length === 0) return;
  let current: WorkspaceSourceAuthorityConfiguration | undefined;
  try {
    current = readCurrent?.();
  } catch {
    throw blockedWorkspaceSource(
      'Current workspace source authority is unavailable. Reload source configuration and submit a new request, or remove this source input.'
    );
  }
  try {
    const workspaceId = environmentPackage.scope.workspaceId;
    assertWorkspaceSourcePolicy(current, workspaceId, environmentPackage.scope.threadId, coreDb);
    const catalog = current.workspaceDataSourceCatalogs?.find(
      (entry) => entry.workspaceId === workspaceId
    )?.catalog;
    if (!catalog) throw new Error('Current workspace source catalog is unavailable.');
    for (const input of sources) {
      const source = input.source;
      if (source.kind !== 'git' || typeof source.sourceRef !== 'string') {
        throw new Error('Workspace source authority cannot be proved.');
      }
      const resolved = resolveWorkspaceDataSourceReference({
        catalog,
        sourceRef: source.sourceRef,
        access: input.access,
        slotKind: 'worktree',
      });
      const locator = requireCredentialFreeHttpsGitLocator(resolved.locator);
      if (
        resolved.sourceKind !== 'git' ||
        resolved.vaultGrantRef ||
        resolved.sourceId !== source.sourceId ||
        resolved.sensitivity !== source.sensitivity ||
        resolved.catalogEntryDigest !== source.catalogEntryDigest ||
        locator.url !== source.url ||
        locator.commit !== source.commit
      ) {
        throw new Error('Remote Git source authority changed before dispatch.');
      }
    }
  } catch (error) {
    if (error instanceof TurnStartValidationError) throw error;
    throw blockedWorkspaceSource(
      `${error instanceof Error ? error.message : 'Current workspace source authority is unavailable.'} Reload source configuration and submit a new request, or remove this source input.`
    );
  }
}

/** Creates the existing pre-dispatch source refusal without adding an outcome or retained field. */
export function blockedWorkspaceSource(message: string): TurnStartValidationError {
  return new TurnStartValidationError('workspace_data_source_blocked', message, 409);
}
