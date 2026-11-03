import { isScopeAdmitted } from './bootstrap/readiness.js';
import type { FsStore } from './lib/store.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import type { ControlPrivateWorkspaceInput } from './storage/private-workspace-codecs.js';
import { nativeProductScope } from './storage/workspace-file-records.js';
import type { RecordWorkspaceOwnerMembershipInput } from './storage/workspace-owner-records.js';

export {
  type RecordWorkspaceOwnerMembershipInput,
  recordWorkspaceOwnerMembership,
  WorkspaceOwnerMembershipRemovedError,
} from './storage/workspace-owner-records.js';

/** Publishes one exact Core stage; no Main SQL or filesystem work spans its acknowledgement. */
async function publishPrivateWorkspace(
  core: CoreDb,
  input: ControlPrivateWorkspaceInput
): Promise<string | null> {
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(core.dataRoot, { kind: 'server' });
  const path = scope.path;
  const database = `core:${path}`;
  await client.open({
    database,
    path,
    dataRoot: core.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return client.privateWorkspace(database, input);
}

/** Awaits ordinary registration through the same Core owner; the command's User receipt remains later. */
export async function publishWorkspaceOwnerMembership(
  input: RecordWorkspaceOwnerMembershipInput
): Promise<void> {
  await publishPrivateWorkspace(input.coreDb, {
    action: 'register',
    userId: input.ownerUserId,
    workspaceId: input.workspaceId,
    at: (input.now ?? new Date()).toISOString(),
  });
}

/** Input for ensuring one active user's built-in personal Workspace. */
export interface EnsureUserQuickChatWorkspaceInput {
  /** Core database that owns canonical user and Workspace relationships. */
  coreDb: CoreDb;
  /** Shared process-level Workspace store. */
  store: FsStore;
  /** Active canonical user that owns the private Workspace. */
  userId: string;
}

/**
 * Ensures one active user's built-in personal Workspace before recording its owner relationship.
 *
 * @param input Canonical user, Core relationship store, and shared Workspace store.
 * @returns Resolves after provisioning, or without opening a known unavailable home whose Core ownership remains valid.
 * @throws WorkspaceOwnerMembershipRemovedError when the retained owner membership is removed.
 * @throws Error when the user is inactive or the reserved Workspace identity is contradictory.
 */
export async function ensureUserQuickChatWorkspace(
  input: EnsureUserQuickChatWorkspaceInput
): Promise<void> {
  // The native deciding section reserves one successor before physical publication can begin.
  // Its covering ACK keeps concurrent and restarted callers on that same selected identity.
  const workspaceId = await publishPrivateWorkspace(input.coreDb, {
    action: 'reserve',
    userId: input.userId,
  });
  if (!workspaceId) throw new Error('Personal Workspace reservation returned no identity.');
  const registry = input.coreDb.sqlite
    .prepare('SELECT owner_user_id AS ownerUserId FROM workspace_registry WHERE workspace_id = ?')
    .get(workspaceId) as { ownerUserId: string } | undefined;
  if (!isScopeAdmitted(input.coreDb.dataRoot, 'workspace', workspaceId)) {
    if (registry?.ownerUserId !== input.userId)
      throw new Error('Personal Workspace ownership is unavailable or contradictory.');
    // Valid Core relationships permit authentication, but never replace a quarantined home.
    return;
  }
  // An established home with missing storage is recovery, never fresh empty provisioning.
  if (registry) input.store.getWorkspace(workspaceId);
  const workspace = await input.store.ensureQuickChatWorkspace(input.userId);
  await publishPrivateWorkspace(input.coreDb, {
    action: 'bind',
    userId: input.userId,
    expectedWorkspaceId: workspaceId,
    workspaceId: workspace.id,
    at: new Date().toISOString(),
  });
}
