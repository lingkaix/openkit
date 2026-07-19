import { randomUUID } from 'node:crypto';
import type {
  WorkspaceAccessLevel,
  WorkspaceAccessRecoveryState,
  WorkspaceInvitation,
  WorkspaceMember,
} from '@openkit/app-api-schemas';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import type { CoreDb } from './storage/db.js';
import { listActiveWorkspaceIdsForActor, resolveWorkspaceRole } from './workspace-membership.js';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Core-only Workspace registry facts that do not expose Workspace content. */
export interface WorkspaceRegistryFact {
  /** Stable Workspace identifier. */
  workspaceId: string;
  /** Current canonical owner user identifier. */
  ownerUserId: string;
  /** Positive registry compare-and-set revision. */
  registryRevision: number;
}

/** Registry and membership facts needed to project one authorized Workspace. */
export interface AuthorizedWorkspaceRegistryFact extends WorkspaceRegistryFact {
  /** Current role derived from the registry and active membership. */
  effectiveRole: 'owner' | 'editor' | 'viewer';
  /** Positive revision of the caller's active membership. */
  membershipRevision: number;
}

/** Input shared by Core-owned Workspace lifecycle mutations. */
interface WorkspaceMutationInput {
  /** Open Core database already inside the command transaction. */
  coreDb: CoreDb;
  /** Stable Workspace identifier. */
  workspaceId: string;
  /** Current time override for deterministic tests. */
  now?: Date;
}

/** Input for creating one registered-user invitation. */
export interface CreateWorkspaceInvitationInput extends WorkspaceMutationInput {
  /** Exact active owner creating the invitation. */
  inviterUserId: string;
  /** Exact email lookup input; it is never stored as invitation authority. */
  inviteeEmail: string;
  /** Access level proposed by the owner. */
  proposedAccessLevel: WorkspaceAccessLevel;
}

/** Input for one invitee-owned invitation transition. */
export interface InviteeInvitationTransitionInput extends WorkspaceMutationInput {
  /** Stable invitation identifier. */
  invitationId: string;
  /** Canonical active user bound to the invitation. */
  inviteeUserId: string;
  /** Positive invitation revision supplied by the caller. */
  expectedRevision: number;
}

/** Input for revoking one owner-visible invitation. */
export interface RevokeWorkspaceInvitationInput extends WorkspaceMutationInput {
  /** Stable invitation identifier. */
  invitationId: string;
  /** Current active owner requesting revocation. */
  ownerUserId: string;
  /** Positive invitation revision supplied by the caller. */
  expectedRevision: number;
}

/** Input for changing an active non-owner membership. */
export interface ChangeWorkspaceMemberAccessInput extends WorkspaceMutationInput {
  /** Current active owner requesting the access change. */
  ownerUserId: string;
  /** Canonical member whose stored access changes. */
  memberUserId: string;
  /** Current membership revision supplied by the caller. */
  expectedRevision: number;
  /** Replacement stored access level. */
  accessLevel: WorkspaceAccessLevel;
}

/** Input for removing one active non-owner membership. */
export interface RemoveWorkspaceMemberInput extends WorkspaceMutationInput {
  /** Current active owner requesting removal. */
  ownerUserId: string;
  /** Canonical member being removed. */
  memberUserId: string;
  /** Current membership revision supplied by the caller. */
  expectedRevision: number;
}

/** Input for an editor or viewer leaving one Workspace. */
export interface LeaveWorkspaceInput extends WorkspaceMutationInput {
  /** Canonical active member leaving the Workspace. */
  memberUserId: string;
  /** Current membership revision supplied by the caller. */
  expectedRevision: number;
}

/** Input for ordinary owner-controlled ownership transfer. */
export interface TransferWorkspaceOwnershipInput extends WorkspaceMutationInput {
  /** Current active Workspace owner. */
  currentOwnerUserId: string;
  /** Active member becoming owner. */
  targetUserId: string;
  /** Current registry revision supplied by the caller. */
  expectedRegistryRevision: number;
}

/** Input for one of the two bounded deployment-administrator recovery actions. */
export interface RecoverWorkspaceAccessInput extends WorkspaceMutationInput {
  /** Closed recovery action selected by the deployment administrator. */
  action: 'add-self-as-editor' | 'transfer-ownership-to-self';
  /** Active canonical user represented by the administrator credential. */
  administratorUserId: string;
  /** Current registry revision supplied by the caller. */
  expectedRegistryRevision: number;
}

/** Result of creating one registered-user invitation. */
export type CreateWorkspaceInvitationResult =
  | { kind: 'created'; invitation: WorkspaceInvitation }
  | { kind: 'invitee_unavailable' }
  | { kind: 'workspace_access_denied' };

/** Closed result of invitation accept, decline, or revoke. */
export type WorkspaceInvitationTransitionResult =
  | { kind: 'accepted'; invitation: WorkspaceInvitation; member: WorkspaceMember }
  | { kind: 'declined' | 'revoked'; invitation: WorkspaceInvitation }
  | { kind: 'invitation_not_pending'; invitation: WorkspaceInvitation }
  | { kind: 'revision_conflict'; invitation: WorkspaceInvitation }
  | { kind: 'workspace_access_denied' };

/** Closed result of a membership access or tombstone mutation. */
export type WorkspaceMemberMutationResult =
  | { kind: 'changed' | 'removed' | 'unchanged'; member: WorkspaceMember }
  | { kind: 'revision_conflict'; member: WorkspaceMember }
  | { kind: 'owner_transfer_required' }
  | { kind: 'workspace_access_denied' };

/** Closed result of ordinary ownership transfer. */
export type TransferWorkspaceOwnershipResult =
  | { kind: 'transferred'; registry: WorkspaceRegistryFact }
  | { kind: 'unchanged'; registry: WorkspaceRegistryFact }
  | { kind: 'revision_conflict'; registry: WorkspaceRegistryFact }
  | { kind: 'workspace_access_denied' };

/** Closed result of bounded administrator Workspace recovery. */
export type RecoverWorkspaceAccessResult =
  | { kind: 'recovered'; recovery: WorkspaceAccessRecoveryState }
  | { kind: 'unchanged'; recovery: WorkspaceAccessRecoveryState }
  | { kind: 'revision_conflict'; recovery: WorkspaceAccessRecoveryState }
  | { kind: 'workspace_access_denied' };

/** Raw invitation columns read from Core SQLite. */
interface WorkspaceInvitationRow {
  invitation_id: string;
  workspace_id: string;
  invitee_user_id: string;
  proposed_access_level: WorkspaceAccessLevel;
  inviter_user_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  expires_at: string;
  accepted_at: string | null;
  declined_at: string | null;
  revoked_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** Raw membership and owner columns read from Core SQLite. */
interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  status: 'active' | 'removed';
  access_level: WorkspaceAccessLevel;
  invitation_id: string | null;
  joined_at: string;
  removed_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
}

/**
 * Lists Core registry facts for the caller's currently authorized Workspace set.
 *
 * @param coreDb Core database containing registry and membership authority.
 * @param userId Active canonical caller user id.
 * @returns Stable Workspace-id-ordered registry and membership facts.
 */
export function listAuthorizedWorkspaceRegistryFacts(
  coreDb: CoreDb,
  userId: string
): AuthorizedWorkspaceRegistryFact[] {
  // ponytail: the authorized set is intentionally small; use one joined query only if measured.
  return listActiveWorkspaceIdsForActor(coreDb, userId).flatMap((workspaceId) => {
    const row = coreDb.sqlite
      .prepare(
        `SELECT registry.owner_user_id, registry.revision AS registry_revision,
                member.revision AS membership_revision
         FROM workspace_registry AS registry
         INNER JOIN workspace_members AS member
           ON member.workspace_id = registry.workspace_id
          AND member.user_id = ?
          AND member.status = 'active'
         WHERE registry.workspace_id = ? AND registry.status = 'active'`
      )
      .get(userId, workspaceId) as
      | { membership_revision: number; owner_user_id: string; registry_revision: number }
      | undefined;
    const effectiveRole = resolveWorkspaceRole(coreDb, workspaceId, userId);
    return row && effectiveRole
      ? [
          {
            workspaceId,
            ownerUserId: row.owner_user_id,
            effectiveRole,
            registryRevision: row.registry_revision,
            membershipRevision: row.membership_revision,
          },
        ]
      : [];
  });
}

/**
 * Lists every durable membership tombstone and active membership for one Workspace.
 *
 * @param coreDb Core database containing membership authority.
 * @param workspaceId Stable Workspace identifier already authorized by the caller.
 * @returns Stable user-id-ordered safe membership projections.
 */
export function listWorkspaceMembers(coreDb: CoreDb, workspaceId: string): WorkspaceMember[] {
  return (
    coreDb.sqlite
      .prepare(
        `SELECT member.*, registry.owner_user_id
         FROM workspace_members AS member
         INNER JOIN workspace_registry AS registry
           ON registry.workspace_id = member.workspace_id
         WHERE member.workspace_id = ?
         ORDER BY member.user_id`
      )
      .all(workspaceId) as WorkspaceMemberRow[]
  ).map(projectMember);
}

/**
 * Lists every durable invitation for one owner-authorized Workspace.
 *
 * @param coreDb Core database containing invitation authority.
 * @param workspaceId Stable Workspace identifier already authorized by the caller.
 * @param now Current time used only for effective expiry projection.
 * @returns Newest-first safe invitation projections.
 */
export function listWorkspaceInvitations(
  coreDb: CoreDb,
  workspaceId: string,
  now = new Date()
): WorkspaceInvitation[] {
  return (
    coreDb.sqlite
      .prepare(
        `SELECT * FROM workspace_invitations
         WHERE workspace_id = ?
         ORDER BY created_at DESC, invitation_id DESC`
      )
      .all(workspaceId) as WorkspaceInvitationRow[]
  ).map((row) => projectInvitation(row, now));
}

/**
 * Lists invitations bound to one authenticated canonical user without requiring membership.
 *
 * @param coreDb Core database containing invitation authority.
 * @param userId Active canonical invitee user id.
 * @param now Current time used only for effective expiry projection.
 * @returns Newest-first safe invitation projections, or an empty list for an inactive user.
 */
export function listMyWorkspaceInvitations(
  coreDb: CoreDb,
  userId: string,
  now = new Date()
): WorkspaceInvitation[] {
  if (!isCanonicalUserActive(coreDb, userId)) {
    return [];
  }
  return (
    coreDb.sqlite
      .prepare(
        `SELECT * FROM workspace_invitations
         WHERE invitee_user_id = ?
         ORDER BY created_at DESC, invitation_id DESC`
      )
      .all(userId) as WorkspaceInvitationRow[]
  ).map((row) => projectInvitation(row, now));
}

/**
 * Reads the only administrator-safe Workspace recovery projection.
 *
 * @param coreDb Core database containing recovery authority.
 * @param workspaceId Stable Workspace identifier.
 * @param administratorUserId Active canonical administrator user id.
 * @returns Safe recovery facts, or null without revealing a missing Workspace or inactive user.
 */
export function getWorkspaceAccessRecoveryState(
  coreDb: CoreDb,
  workspaceId: string,
  administratorUserId: string
): WorkspaceAccessRecoveryState | null {
  if (!isCanonicalUserActive(coreDb, administratorUserId)) {
    return null;
  }
  const registry = getWorkspaceRegistryFact(coreDb, workspaceId);
  if (!registry) {
    return null;
  }
  return {
    workspaceId,
    ownerUserId: registry.ownerUserId,
    administratorRole: resolveWorkspaceRole(coreDb, workspaceId, administratorUserId),
    registryRevision: registry.registryRevision,
  };
}

/**
 * Creates one fixed-seven-day registered-user invitation inside the caller's Core transaction.
 *
 * @param input Owner, target, Workspace, and proposed access facts.
 * @returns Created invitation or a product-safe closed denial.
 * @throws Error when called outside an outer Core transaction.
 */
export function createWorkspaceInvitation(
  input: CreateWorkspaceInvitationInput
): CreateWorkspaceInvitationResult {
  requireOuterTransaction(input.coreDb);
  if (resolveWorkspaceRole(input.coreDb, input.workspaceId, input.inviterUserId) !== 'owner') {
    return { kind: 'workspace_access_denied' };
  }
  const normalizedEmail = input.inviteeEmail.trim().toLowerCase();
  const candidates = input.coreDb.sqlite
    .prepare("SELECT id FROM users WHERE lower(trim(email)) = ? AND status = 'active'")
    .all(normalizedEmail) as Array<{ id: string }>;
  if (candidates.length !== 1) {
    return { kind: 'invitee_unavailable' };
  }
  const inviteeUserId = candidates[0]?.id;
  if (!inviteeUserId) {
    return { kind: 'invitee_unavailable' };
  }
  if (resolveWorkspaceRole(input.coreDb, input.workspaceId, inviteeUserId)) {
    return { kind: 'invitee_unavailable' };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_invitations
       SET status = 'revoked', revoked_at = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND invitee_user_id = ? AND status = 'pending'`
    )
    .run(nowIso, nowIso, input.workspaceId, inviteeUserId);
  const invitationId = `inv_${randomUUID()}`;
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_invitations (
        invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id,
        status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
    )
    .run(
      invitationId,
      input.workspaceId,
      inviteeUserId,
      input.proposedAccessLevel,
      input.inviterUserId,
      new Date(now.getTime() + INVITATION_LIFETIME_MS).toISOString(),
      nowIso,
      nowIso
    );
  return { kind: 'created', invitation: requireInvitation(input.coreDb, invitationId, now) };
}

/**
 * Accepts one exact pending unexpired invitation and admits or reactivates its member.
 *
 * @param input Bound invitee and expected invitation revision.
 * @returns Accepted records or a terminal, stale, or non-enumerating denial.
 * @throws Error when called outside an outer Core transaction.
 */
export function acceptWorkspaceInvitation(
  input: InviteeInvitationTransitionInput
): WorkspaceInvitationTransitionResult {
  requireOuterTransaction(input.coreDb);
  if (!isCanonicalUserActive(input.coreDb, input.inviteeUserId)) {
    return { kind: 'workspace_access_denied' };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_invitations
       SET status = 'accepted', accepted_at = ?, revision = revision + 1, updated_at = ?
       WHERE invitation_id = ? AND invitee_user_id = ? AND status = 'pending'
         AND julianday(expires_at) > julianday(?) AND revision = ?
         AND EXISTS (
           SELECT 1 FROM workspace_registry
           WHERE workspace_id = workspace_invitations.workspace_id AND status = 'active'
         )`
    )
    .run(nowIso, nowIso, input.invitationId, input.inviteeUserId, nowIso, input.expectedRevision);
  if (changed.changes === 0) {
    return classifyInvitationFailure(
      readInvitationForInvitee(input.coreDb, input.invitationId, input.inviteeUserId),
      input.expectedRevision,
      now
    );
  }
  const invitation = requireInvitation(input.coreDb, input.invitationId, now);
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?, NULL, 1, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET
        status = 'active',
        access_level = excluded.access_level,
        invitation_id = excluded.invitation_id,
        removed_at = NULL,
        revision = workspace_members.revision + 1,
        updated_at = excluded.updated_at
      WHERE workspace_members.status = 'removed'`
    )
    .run(
      invitation.workspaceId,
      input.inviteeUserId,
      invitation.proposedAccessLevel,
      input.invitationId,
      nowIso,
      nowIso,
      nowIso
    );
  const member = getWorkspaceMember(input.coreDb, invitation.workspaceId, input.inviteeUserId);
  if (!member) {
    throw new Error('Accepted invitation did not produce an active membership.');
  }
  return { kind: 'accepted', invitation, member };
}

/**
 * Declines one exact pending unexpired invitation for its bound active invitee.
 *
 * @param input Bound invitee and expected invitation revision.
 * @returns Declined invitation or a terminal, stale, or non-enumerating denial.
 * @throws Error when called outside an outer Core transaction.
 */
export function declineWorkspaceInvitation(
  input: InviteeInvitationTransitionInput
): WorkspaceInvitationTransitionResult {
  requireOuterTransaction(input.coreDb);
  if (!isCanonicalUserActive(input.coreDb, input.inviteeUserId)) {
    return { kind: 'workspace_access_denied' };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_invitations
       SET status = 'declined', declined_at = ?, revision = revision + 1, updated_at = ?
       WHERE invitation_id = ? AND invitee_user_id = ? AND status = 'pending'
         AND julianday(expires_at) > julianday(?) AND revision = ?`
    )
    .run(nowIso, nowIso, input.invitationId, input.inviteeUserId, nowIso, input.expectedRevision);
  if (changed.changes === 0) {
    return classifyInvitationFailure(
      readInvitationForInvitee(input.coreDb, input.invitationId, input.inviteeUserId),
      input.expectedRevision,
      now
    );
  }
  return { kind: 'declined', invitation: requireInvitation(input.coreDb, input.invitationId, now) };
}

/**
 * Revokes one exact pending unexpired invitation for its active Workspace owner.
 *
 * @param input Owner, Workspace, invitation, and expected revision facts.
 * @returns Revoked invitation or a terminal, stale, or non-enumerating denial.
 * @throws Error when called outside an outer Core transaction.
 */
export function revokeWorkspaceInvitation(
  input: RevokeWorkspaceInvitationInput
): WorkspaceInvitationTransitionResult {
  requireOuterTransaction(input.coreDb);
  if (resolveWorkspaceRole(input.coreDb, input.workspaceId, input.ownerUserId) !== 'owner') {
    return { kind: 'workspace_access_denied' };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_invitations
       SET status = 'revoked', revoked_at = ?, revision = revision + 1, updated_at = ?
       WHERE invitation_id = ? AND workspace_id = ? AND status = 'pending'
         AND julianday(expires_at) > julianday(?) AND revision = ?`
    )
    .run(nowIso, nowIso, input.invitationId, input.workspaceId, nowIso, input.expectedRevision);
  if (changed.changes === 0) {
    return classifyInvitationFailure(
      readInvitationForWorkspace(input.coreDb, input.invitationId, input.workspaceId),
      input.expectedRevision,
      now
    );
  }
  return { kind: 'revoked', invitation: requireInvitation(input.coreDb, input.invitationId, now) };
}

/**
 * Changes one active non-owner membership using its exact revision.
 *
 * @param input Owner, member, access, and expected revision facts.
 * @returns Changed member or a closed denial/conflict.
 * @throws Error when called outside an outer Core transaction.
 */
export function changeWorkspaceMemberAccess(
  input: ChangeWorkspaceMemberAccessInput
): WorkspaceMemberMutationResult {
  requireOuterTransaction(input.coreDb);
  const registry = getWorkspaceRegistryFact(input.coreDb, input.workspaceId);
  if (
    !registry ||
    registry.ownerUserId !== input.ownerUserId ||
    resolveWorkspaceRole(input.coreDb, input.workspaceId, input.ownerUserId) !== 'owner'
  ) {
    return { kind: 'workspace_access_denied' };
  }
  if (input.memberUserId === registry.ownerUserId) {
    return { kind: 'owner_transfer_required' };
  }
  const member = getWorkspaceMember(input.coreDb, input.workspaceId, input.memberUserId);
  if (!member) {
    return { kind: 'workspace_access_denied' };
  }
  if (member.status === 'removed' || member.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict', member };
  }
  if (member.accessLevel === input.accessLevel) {
    return { kind: 'unchanged', member };
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_members
       SET access_level = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND revision = ?`
    )
    .run(input.accessLevel, nowIso, input.workspaceId, input.memberUserId, input.expectedRevision);
  if (changed.changes === 0) {
    return classifyMemberFailure(
      getWorkspaceMember(input.coreDb, input.workspaceId, input.memberUserId),
      input.expectedRevision
    );
  }
  return {
    kind: 'changed',
    member: requireMember(input.coreDb, input.workspaceId, input.memberUserId),
  };
}

/**
 * Tombstones one active non-owner membership using its exact revision.
 *
 * @param input Owner, member, and expected revision facts.
 * @returns Removed member or a closed denial/conflict.
 * @throws Error when called outside an outer Core transaction.
 */
export function removeWorkspaceMember(
  input: RemoveWorkspaceMemberInput
): WorkspaceMemberMutationResult {
  requireOuterTransaction(input.coreDb);
  const registry = getWorkspaceRegistryFact(input.coreDb, input.workspaceId);
  if (
    !registry ||
    registry.ownerUserId !== input.ownerUserId ||
    resolveWorkspaceRole(input.coreDb, input.workspaceId, input.ownerUserId) !== 'owner'
  ) {
    return { kind: 'workspace_access_denied' };
  }
  if (input.memberUserId === registry.ownerUserId) {
    return { kind: 'owner_transfer_required' };
  }
  return tombstoneMember(input, input.memberUserId);
}

/**
 * Tombstones the active editor or viewer membership of the current caller.
 *
 * @param input Caller membership and expected revision facts.
 * @returns Removed member or an owner, access, or revision denial.
 * @throws Error when called outside an outer Core transaction.
 */
export function leaveWorkspace(input: LeaveWorkspaceInput): WorkspaceMemberMutationResult {
  requireOuterTransaction(input.coreDb);
  const registry = getWorkspaceRegistryFact(input.coreDb, input.workspaceId);
  const member = getWorkspaceMember(input.coreDb, input.workspaceId, input.memberUserId);
  if (!registry || !member) {
    return { kind: 'workspace_access_denied' };
  }
  if (registry.ownerUserId === input.memberUserId) {
    return { kind: 'owner_transfer_required' };
  }
  if (member.status === 'removed' || member.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict', member };
  }
  const role = resolveWorkspaceRole(input.coreDb, input.workspaceId, input.memberUserId);
  if (role !== 'editor' && role !== 'viewer') {
    return { kind: 'workspace_access_denied' };
  }
  return tombstoneMember(input, input.memberUserId);
}

/**
 * Transfers ownership to one active member and promotes a viewer before the registry update.
 *
 * @param input Current owner, target member, and expected registry revision.
 * @returns Updated registry fact or a closed access/revision denial.
 * @throws Error when called outside an outer Core transaction or if a fenced update is contradicted.
 */
export function transferWorkspaceOwnership(
  input: TransferWorkspaceOwnershipInput
): TransferWorkspaceOwnershipResult {
  requireOuterTransaction(input.coreDb);
  const registry = getWorkspaceRegistryFact(input.coreDb, input.workspaceId);
  if (
    !registry ||
    registry.ownerUserId !== input.currentOwnerUserId ||
    resolveWorkspaceRole(input.coreDb, input.workspaceId, input.currentOwnerUserId) !== 'owner'
  ) {
    return { kind: 'workspace_access_denied' };
  }
  const target = getWorkspaceMember(input.coreDb, input.workspaceId, input.targetUserId);
  if (
    !target ||
    target.status !== 'active' ||
    !isCanonicalUserActive(input.coreDb, input.targetUserId)
  ) {
    return { kind: 'workspace_access_denied' };
  }
  if (registry.registryRevision !== input.expectedRegistryRevision) {
    return { kind: 'revision_conflict', registry };
  }
  if (input.targetUserId === registry.ownerUserId) {
    return { kind: 'unchanged', registry };
  }
  if (!fenceRegistry(input.coreDb, input.workspaceId, input.expectedRegistryRevision)) {
    return {
      kind: 'revision_conflict',
      registry: requireRegistryFact(input.coreDb, input.workspaceId),
    };
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  if (target.accessLevel === 'viewer') {
    input.coreDb.sqlite
      .prepare(
        `UPDATE workspace_members
         SET access_level = 'editor', revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND user_id = ? AND status = 'active'`
      )
      .run(nowIso, input.workspaceId, input.targetUserId);
  }
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_registry
       SET owner_user_id = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND owner_user_id = ? AND status = 'active' AND revision = ?`
    )
    .run(
      input.targetUserId,
      nowIso,
      input.workspaceId,
      input.currentOwnerUserId,
      input.expectedRegistryRevision
    );
  if (changed.changes !== 1) {
    throw new Error('Fenced Workspace ownership transfer was contradicted.');
  }
  return { kind: 'transferred', registry: requireRegistryFact(input.coreDb, input.workspaceId) };
}

/**
 * Applies one of the two bounded administrator recovery actions using registry CAS.
 *
 * @param input Administrator, action, Workspace, and expected revision facts.
 * @returns Safe recovery state or a closed access/revision denial.
 * @throws Error when called outside an outer Core transaction or if a fenced update is contradicted.
 */
export function recoverWorkspaceAccess(
  input: RecoverWorkspaceAccessInput
): RecoverWorkspaceAccessResult {
  requireOuterTransaction(input.coreDb);
  if (!isCanonicalUserActive(input.coreDb, input.administratorUserId)) {
    return { kind: 'workspace_access_denied' };
  }
  const recovery = getWorkspaceAccessRecoveryState(
    input.coreDb,
    input.workspaceId,
    input.administratorUserId
  );
  if (!recovery) {
    return { kind: 'workspace_access_denied' };
  }
  if (recovery.registryRevision !== input.expectedRegistryRevision) {
    return { kind: 'revision_conflict', recovery };
  }
  const alreadyRecovered =
    input.action === 'transfer-ownership-to-self'
      ? recovery.ownerUserId === input.administratorUserId
      : recovery.administratorRole === 'owner' || recovery.administratorRole === 'editor';
  if (alreadyRecovered) {
    return { kind: 'unchanged', recovery };
  }
  if (!fenceRegistry(input.coreDb, input.workspaceId, input.expectedRegistryRevision)) {
    return {
      kind: 'revision_conflict',
      recovery: requireRecoveryState(input.coreDb, input.workspaceId, input.administratorUserId),
    };
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_invitations
       SET status = 'revoked', revoked_at = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND invitee_user_id = ? AND status = 'pending'`
    )
    .run(nowIso, nowIso, input.workspaceId, input.administratorUserId);
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES (?, ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET
        status = 'active',
        access_level = 'editor',
        invitation_id = CASE
          WHEN workspace_members.status = 'removed' THEN NULL
          ELSE workspace_members.invitation_id
        END,
        removed_at = NULL,
        revision = workspace_members.revision + 1,
        updated_at = excluded.updated_at
      WHERE workspace_members.status = 'removed' OR workspace_members.access_level = 'viewer'`
    )
    .run(input.workspaceId, input.administratorUserId, nowIso, nowIso, nowIso);
  const ownerUserId =
    input.action === 'transfer-ownership-to-self'
      ? input.administratorUserId
      : recovery.ownerUserId;
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_registry
       SET owner_user_id = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND status = 'active' AND revision = ?`
    )
    .run(ownerUserId, nowIso, input.workspaceId, input.expectedRegistryRevision);
  if (changed.changes !== 1) {
    throw new Error('Fenced Workspace access recovery was contradicted.');
  }
  return {
    kind: 'recovered',
    recovery: requireRecoveryState(input.coreDb, input.workspaceId, input.administratorUserId),
  };
}

/** Requires the transaction boundary owned by the lifecycle command wrapper. */
function requireOuterTransaction(coreDb: CoreDb): void {
  if (!coreDb.sqlite.inTransaction) {
    throw new Error('Workspace sharing mutations require an outer Core transaction.');
  }
}

/** Acquires the Core writer lock only when one registry revision still matches. */
function fenceRegistry(coreDb: CoreDb, workspaceId: string, expectedRevision: number): boolean {
  return (
    coreDb.sqlite
      .prepare(
        `UPDATE workspace_registry SET revision = revision
         WHERE workspace_id = ? AND status = 'active' AND revision = ?`
      )
      .run(workspaceId, expectedRevision).changes === 1
  );
}

/**
 * Reads one active registry row without any Workspace content.
 *
 * @param coreDb Core database containing registry authority.
 * @param workspaceId Stable Workspace identifier from an already authorized owner or receipt.
 * @returns Safe registry fact, or null when no active registry row exists.
 */
export function getWorkspaceRegistryFact(
  coreDb: CoreDb,
  workspaceId: string
): WorkspaceRegistryFact | null {
  const row = coreDb.sqlite
    .prepare(
      `SELECT workspace_id, owner_user_id, revision
       FROM workspace_registry WHERE workspace_id = ? AND status = 'active'`
    )
    .get(workspaceId) as
    | { owner_user_id: string; revision: number; workspace_id: string }
    | undefined;
  return row
    ? {
        workspaceId: row.workspace_id,
        ownerUserId: row.owner_user_id,
        registryRevision: row.revision,
      }
    : null;
}

/** Reads one required active registry row after a successful transition. */
function requireRegistryFact(coreDb: CoreDb, workspaceId: string): WorkspaceRegistryFact {
  const registry = getWorkspaceRegistryFact(coreDb, workspaceId);
  if (!registry) {
    throw new Error('Successful Workspace sharing transition lost its registry row.');
  }
  return registry;
}

/** Reads one invitation visible to its bound invitee. */
function readInvitationForInvitee(
  coreDb: CoreDb,
  invitationId: string,
  inviteeUserId: string
): WorkspaceInvitationRow | undefined {
  return coreDb.sqlite
    .prepare('SELECT * FROM workspace_invitations WHERE invitation_id = ? AND invitee_user_id = ?')
    .get(invitationId, inviteeUserId) as WorkspaceInvitationRow | undefined;
}

/** Reads one invitation visible inside its exact Workspace. */
function readInvitationForWorkspace(
  coreDb: CoreDb,
  invitationId: string,
  workspaceId: string
): WorkspaceInvitationRow | undefined {
  return coreDb.sqlite
    .prepare('SELECT * FROM workspace_invitations WHERE invitation_id = ? AND workspace_id = ?')
    .get(invitationId, workspaceId) as WorkspaceInvitationRow | undefined;
}

/** Reads and projects one required invitation after a successful transition. */
function requireInvitation(coreDb: CoreDb, invitationId: string, now: Date): WorkspaceInvitation {
  const invitation = getWorkspaceInvitation(coreDb, invitationId, now);
  if (!invitation) {
    throw new Error('Successful Workspace invitation transition lost its authority row.');
  }
  return invitation;
}

/**
 * Reads one safe invitation projection for an already authorized owner or command receipt.
 *
 * @param coreDb Core database containing invitation authority.
 * @param invitationId Stable invitation identifier.
 * @param now Current time used only for effective expiry projection.
 * @returns Safe invitation projection, or null when absent.
 */
export function getWorkspaceInvitation(
  coreDb: CoreDb,
  invitationId: string,
  now = new Date()
): WorkspaceInvitation | null {
  const row = coreDb.sqlite
    .prepare('SELECT * FROM workspace_invitations WHERE invitation_id = ?')
    .get(invitationId) as WorkspaceInvitationRow | undefined;
  return row ? projectInvitation(row, now) : null;
}

/** Projects durable invitation state plus deadline-derived effective expiry. */
function projectInvitation(row: WorkspaceInvitationRow, now: Date): WorkspaceInvitation {
  const expiresAt = Date.parse(row.expires_at);
  const effectiveStatus =
    row.status === 'pending' && (!Number.isFinite(expiresAt) || expiresAt <= now.getTime())
      ? 'expired'
      : row.status;
  return {
    invitationId: row.invitation_id,
    workspaceId: row.workspace_id,
    inviteeUserId: row.invitee_user_id,
    proposedAccessLevel: row.proposed_access_level,
    inviterUserId: row.inviter_user_id,
    effectiveStatus,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    revokedAt: row.revoked_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as WorkspaceInvitation;
}

/** Applies the specified terminal-before-stale invitation failure precedence. */
function classifyInvitationFailure(
  row: WorkspaceInvitationRow | undefined,
  expectedRevision: number,
  now: Date
): WorkspaceInvitationTransitionResult {
  if (!row) {
    return { kind: 'workspace_access_denied' };
  }
  const invitation = projectInvitation(row, now);
  if (invitation.effectiveStatus !== 'pending') {
    return { kind: 'invitation_not_pending', invitation };
  }
  if (invitation.revision !== expectedRevision) {
    return { kind: 'revision_conflict', invitation };
  }
  return { kind: 'workspace_access_denied' };
}

/**
 * Reads one membership with its registry-derived effective role.
 *
 * @param coreDb Core database containing membership authority.
 * @param workspaceId Stable Workspace identifier from an already authorized owner or receipt.
 * @param userId Stable member user identifier.
 * @returns Safe membership projection, or null when absent.
 */
export function getWorkspaceMember(
  coreDb: CoreDb,
  workspaceId: string,
  userId: string
): WorkspaceMember | null {
  const row = coreDb.sqlite
    .prepare(
      `SELECT member.*, registry.owner_user_id
       FROM workspace_members AS member
       INNER JOIN workspace_registry AS registry ON registry.workspace_id = member.workspace_id
       WHERE member.workspace_id = ? AND member.user_id = ?`
    )
    .get(workspaceId, userId) as WorkspaceMemberRow | undefined;
  return row ? projectMember(row) : null;
}

/** Reads one required membership after a successful transition. */
function requireMember(coreDb: CoreDb, workspaceId: string, userId: string): WorkspaceMember {
  const member = getWorkspaceMember(coreDb, workspaceId, userId);
  if (!member) {
    throw new Error('Successful Workspace membership transition lost its authority row.');
  }
  return member;
}

/** Projects one membership row into the closed public variant. */
function projectMember(row: WorkspaceMemberRow): WorkspaceMember {
  const effectiveRole =
    row.status === 'removed'
      ? null
      : row.user_id === row.owner_user_id
        ? 'owner'
        : row.access_level;
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    status: row.status,
    accessLevel: row.access_level,
    effectiveRole,
    invitationId: row.invitation_id,
    joinedAt: row.joined_at,
    removedAt: row.removed_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as WorkspaceMember;
}

/** Classifies an unchanged membership without reviving a missing or removed edge. */
function classifyMemberFailure(
  member: WorkspaceMember | null,
  expectedRevision: number
): WorkspaceMemberMutationResult {
  return member && (member.status === 'removed' || member.revision !== expectedRevision)
    ? { kind: 'revision_conflict', member }
    : { kind: 'workspace_access_denied' };
}

/** Applies the shared removed-tombstone transition for owner removal and member leave. */
function tombstoneMember(
  input: WorkspaceMutationInput & { expectedRevision: number },
  memberUserId: string
): WorkspaceMemberMutationResult {
  const nowIso = (input.now ?? new Date()).toISOString();
  const changed = input.coreDb.sqlite
    .prepare(
      `UPDATE workspace_members
       SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND revision = ?`
    )
    .run(nowIso, nowIso, input.workspaceId, memberUserId, input.expectedRevision);
  if (changed.changes === 0) {
    return classifyMemberFailure(
      getWorkspaceMember(input.coreDb, input.workspaceId, memberUserId),
      input.expectedRevision
    );
  }
  return { kind: 'removed', member: requireMember(input.coreDb, input.workspaceId, memberUserId) };
}

/** Reads one required safe recovery state after a successful transition. */
function requireRecoveryState(
  coreDb: CoreDb,
  workspaceId: string,
  administratorUserId: string
): WorkspaceAccessRecoveryState {
  const recovery = getWorkspaceAccessRecoveryState(coreDb, workspaceId, administratorUserId);
  if (!recovery) {
    throw new Error('Successful Workspace recovery lost its safe state projection.');
  }
  return recovery;
}
