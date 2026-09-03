import {
  type MaterializedWorkspaceRoot,
  materializeWorkspaceRoots,
  requireCredentialFreeHttpsGitLocator,
  resolveWorkspaceDataSourceReference,
} from '@openkit/config-schema';

import type { AgentManifest } from '../agents/manifest.js';
import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { ensureWorkspaceLayout } from '../storage/fs-layout.js';
import { TurnStartValidationError } from './orchestrator.js';

const REMOTE_GIT_WORKER_ROOT = '/workspace/openkit';

/**
 * Resolves configured NanoCore roots plus the selected Agent's remote Git input.
 *
 * @param snapshot Runtime config snapshot captured for the Turn.
 * @param store Shared product store that contains the Workspace.
 * @param workspaceId Workspace id that owns the Turn.
 * @param selectedManifest Explicit Agent selected before workspace resolution.
 * @returns Worker launch roots for the accepted Turn.
 * @throws TurnStartValidationError when the selected source is unavailable or unsafe.
 */
export function materializeWorkspaceRootsForTurn(
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string,
  selectedManifest: AgentManifest
): MaterializedWorkspaceRoot[] {
  const inputs = selectedManifest.workspace?.inputs ?? [];
  let remoteRoot: MaterializedWorkspaceRoot | null = null;
  if (inputs.length > 1) {
    throw blockedWorkspaceSource('Exactly one Agent workspace input is supported.');
  }
  if (inputs.length === 1) {
    const input = inputs[0];
    if (
      typeof input?.id !== 'string' ||
      typeof input.sourceRef !== 'string' ||
      (input.access !== 'read-only' && input.access !== 'read-write')
    ) {
      throw blockedWorkspaceSource('Agent workspace input requires id, sourceRef, and access.');
    }
    if (input.access !== 'read-write') {
      throw blockedWorkspaceSource('Remote Git workspace input must be read-write.');
    }
    if (
      findWorkspaceConfig(snapshot, workspaceId)?.config.workspace?.roots.some(
        (root) => root.id === input.id
      )
    ) {
      throw blockedWorkspaceSource(
        `Workspace input id conflicts with a configured root: ${input.id}`
      );
    }

    const catalog = workspaceDataSourceCatalog(snapshot, workspaceId);
    if (!catalog) {
      throw blockedWorkspaceSource(
        `Workspace data source catalog required for sourceRef: ${input.sourceRef}`
      );
    }

    let resolved: ReturnType<typeof resolveWorkspaceDataSourceReference>;
    try {
      resolved = resolveWorkspaceDataSourceReference({
        access: input.access,
        catalog,
        slotKind: 'worktree',
        sourceRef: input.sourceRef,
      });
    } catch (error) {
      throw blockedWorkspaceSource(error instanceof Error ? error.message : String(error));
    }
    if (resolved.sourceKind !== 'git' || resolved.vaultGrantRef) {
      throw blockedWorkspaceSource('Workspace source must be credential-free remote Git.');
    }

    let locator: ReturnType<typeof requireCredentialFreeHttpsGitLocator>;
    try {
      locator = requireCredentialFreeHttpsGitLocator(resolved.locator);
    } catch (error) {
      throw blockedWorkspaceSource(error instanceof Error ? error.message : String(error));
    }
    remoteRoot = {
      access: input.access,
      id: input.id,
      sourceCommit: locator.commit,
      sourceKind: 'remote-git',
      workerPath: REMOTE_GIT_WORKER_ROOT,
    };
  }

  const configuredRoots = materializeConfiguredWorkspaceRoots(snapshot, store, workspaceId);
  return remoteRoot ? [remoteRoot, ...configuredRoots] : configuredRoots;
}

/** Resolves bounded host-local roots owned by Workspace configuration. */
function materializeConfiguredWorkspaceRoots(
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string
): MaterializedWorkspaceRoot[] {
  const dataRoot = store.getDataRoot();
  const workspaceConfig = findWorkspaceConfig(snapshot, workspaceId);
  if (!dataRoot || !workspaceConfig) {
    return [];
  }

  const layout = ensureWorkspaceLayout(dataRoot, workspaceId);
  return materializeWorkspaceRoots({
    config: workspaceConfig.config,
    workspaceRoot: layout.root,
    createMissing: true,
  });
}

/** Returns the selected Workspace catalog snapshot, when configured. */
function workspaceDataSourceCatalog(snapshot: RuntimeConfigSnapshot, workspaceId: string) {
  return snapshot.workspaceDataSourceCatalogs.find((entry) => entry.workspaceId === workspaceId)
    ?.catalog;
}

/** Creates the product-safe pre-admission source failure. */
function blockedWorkspaceSource(message: string): TurnStartValidationError {
  return new TurnStartValidationError('workspace_data_source_blocked', message, 409);
}
