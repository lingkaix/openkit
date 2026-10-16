import { z } from 'zod';
import { entityIdPattern, isEntityId } from './entity-id.js';

/** Canonical ws entity identity at a boundary that names its kind. */
export const WorkspaceIdSchema = z.string().regex(entityIdPattern('ws'));

/** Canonical th entity identity at a boundary that names its kind. */
export const ThreadIdSchema = z.string().regex(entityIdPattern('th'));

/** Canonical tu entity identity at a boundary that names its kind. */
export const TurnIdSchema = z.string().regex(entityIdPattern('tu'));

/** Canonical it entity identity at a boundary that names its kind. */
export const ItemIdSchema = z.string().regex(entityIdPattern('it'));

/** Canonical ar entity identity at a boundary that names its kind. */
export const ArtifactIdSchema = z.string().regex(entityIdPattern('ar'));

/**
 * Owner-defined selector or request identity; excluded from entity allocation.
 */
export const ApprovalRequestIdSchema = z.string().min(1);

/**
 * Owner-defined selector or request identity; excluded from entity allocation.
 */
export const UserInputRequestIdSchema = z.string().min(1);

/**
 * Owner-defined selector or request identity; excluded from entity allocation.
 */
export const KnowledgeEntryIdSchema = z.string().min(1);

/**
 * Owner-defined selector or request identity; excluded from entity allocation.
 */
export const AgentIdSchema = z.string().min(1);

/** Canonical as entity identity at a boundary that names its kind. */
export const AgentSessionIdSchema = z.string().regex(entityIdPattern('as'));

/**
 * Owner-defined selector or request identity; excluded from entity allocation.
 */
export const AgentProfileIdSchema = z.string().min(1);

/** Canonical cap entity identity at a boundary that names its kind. */
export const CapabilityCallIdSchema = z.string().regex(entityIdPattern('cap'));

/** Canonical pd entity identity at a boundary that names its kind. */
export const PermissionDecisionIdSchema = z.string().regex(entityIdPattern('pd'));

/** Canonical grant entity identity at a boundary that names its kind. */
export const VaultGrantIdSchema = z.string().regex(entityIdPattern('grant'));

/** Canonical use entity identity at a boundary that names its kind. */
export const UsageRecordIdSchema = z.string().regex(entityIdPattern('use'));

/** Canonical aud entity identity at a boundary that names its kind. */
export const AuditEventIdSchema = z.string().regex(entityIdPattern('aud'));

/**
 * Idempotency key used to correlate mutating commands with resulting events.
 */
export const RequestIdSchema = z.string().uuid();

/** Checks canonical User identity through the shared kind owner. */
export function isUserId(value: string): boolean {
  return isEntityId('usr', value);
}

/** Checks canonical Workspace identity through the shared kind owner. */
export function isWorkspaceId(value: string): boolean {
  return isEntityId('ws', value);
}

/** Checks canonical Thread identity through the shared kind owner. */
export function isThreadId(value: string): boolean {
  return isEntityId('th', value);
}

/** Checks canonical Turn identity through the shared kind owner. */
export function isTurnId(value: string): boolean {
  return isEntityId('tu', value);
}

/** Canonical usr entity identity at a boundary that names its kind. */
export const UserIdSchema = z.string().regex(entityIdPattern('usr'));

/** Canonical mat entity identity at a boundary that names its kind. */
export const MaterialIdSchema = z.string().regex(entityIdPattern('mat'));

/** Canonical mrev entity identity at a boundary that names its kind. */
export const MaterialRevisionIdSchema = z.string().regex(entityIdPattern('mrev'));

/** Canonical arev entity identity at a boundary that names its kind. */
export const ArtifactReviewIdSchema = z.string().regex(entityIdPattern('arev'));

/** Canonical kr entity identity at a boundary that names its kind. */
export const KnowledgeReviewIdSchema = z.string().regex(entityIdPattern('kr'));

/** Canonical auto entity identity at a boundary that names its kind. */
export const AutomationIdSchema = z.string().regex(entityIdPattern('auto'));

/** Canonical auth entity identity at a boundary that names its kind. */
export const AuthenticationSessionIdSchema = z.string().regex(entityIdPattern('auth'));

/** Canonical acct entity identity at a boundary that names its kind. */
export const AuthenticationAccountIdSchema = z.string().regex(entityIdPattern('acct'));

/** Canonical verif entity identity at a boundary that names its kind. */
export const AuthenticationVerificationIdSchema = z.string().regex(entityIdPattern('verif'));

/** Canonical tok entity identity at a boundary that names its kind. */
export const AccessTokenIdSchema = z.string().regex(entityIdPattern('tok'));

/** Canonical nhtok entity identity at a boundary that names its kind. */
export const NanoHostTransportTokenIdSchema = z.string().regex(entityIdPattern('nhtok'));

/** Canonical inv entity identity at a boundary that names its kind. */
export const InvitationIdSchema = z.string().regex(entityIdPattern('inv'));

/** Canonical dep entity identity at a boundary that names its kind. */
export const DeploymentIdSchema = z.string().regex(entityIdPattern('dep'));

/** Canonical ks entity identity at a boundary that names its kind. */
export const KnowledgeSourceIdSchema = z.string().regex(entityIdPattern('ks'));

/** Canonical ko entity identity at a boundary that names its kind. */
export const KnowledgeObservationIdSchema = z.string().regex(entityIdPattern('ko'));

/** Canonical kc entity identity at a boundary that names its kind. */
export const KnowledgeClaimIdSchema = z.string().regex(entityIdPattern('kc'));

/** Canonical kf entity identity at a boundary that names its kind. */
export const KnowledgeConflictIdSchema = z.string().regex(entityIdPattern('kf'));

/** Canonical attempt entity identity at a boundary that names its kind. */
export const ExecutionAttemptIdSchema = z.string().regex(entityIdPattern('attempt'));

/** Canonical wst entity identity at a boundary that names its kind. */
export const WorkerStorageTargetIdSchema = z.string().regex(entityIdPattern('wst'));

/** Canonical vault entity identity at a boundary that names its kind. */
export const VaultReferenceIdSchema = z.string().regex(entityIdPattern('vault'));

/** Canonical vu entity identity at a boundary that names its kind. */
export const VaultUseIdSchema = z.string().regex(entityIdPattern('vu'));

/** Canonical cand entity identity at a boundary that names its kind. */
export const ResourceCandidateIdSchema = z.string().regex(entityIdPattern('cand'));

/** Canonical col entity identity at a boundary that names its kind. */
export const CollectionIdSchema = z.string().regex(entityIdPattern('col'));

/** Canonical fld entity identity at a boundary that names its kind. */
export const FieldIdSchema = z.string().regex(entityIdPattern('fld'));

/** Canonical pres entity identity at a boundary that names its kind. */
export const PresentationIdSchema = z.string().regex(entityIdPattern('pres'));

/** Canonical wsexp entity identity at a boundary that names its kind. */
export const WorkspaceExportIdSchema = z.string().regex(entityIdPattern('wsexp'));

/** Canonical drb entity identity at a boundary that names its kind. */
export const DataRootBackupIdSchema = z.string().regex(entityIdPattern('drb'));

/** Canonical recurring occurrence identity; allocation stays with the recurring owner. */
export const RecurringOccurrenceIdSchema = z.string().regex(entityIdPattern('occ'));

/** Canonical retained expired-range identity; allocation stays with the recurring owner. */
export const RecurringExpiredRangeIdSchema = z.string().regex(entityIdPattern('range'));
