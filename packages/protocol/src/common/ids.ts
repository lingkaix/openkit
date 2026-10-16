import { z } from 'zod';

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const WorkspaceIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const ThreadIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const TurnIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const ItemIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const ArtifactIdSchema = z.string().min(1);

/** Opaque identity owned by the existing Workspace Material records. */
export const MaterialIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const ApprovalRequestIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const UserInputRequestIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const KnowledgeEntryIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const AgentIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const AgentSessionIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const AgentProfileIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const CapabilityCallIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const PermissionDecisionIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const VaultGrantIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const UsageRecordIdSchema = z.string().min(1);

/**
 * Opaque protocol IDs are strings on the wire.
 */
export const AuditEventIdSchema = z.string().min(1);

/**
 * Idempotency key used to correlate mutating commands with resulting events.
 */
export const RequestIdSchema = z.string().uuid();

/** Checks the current User id form at a boundary that names that kind. */
export function isUserId(value: string): boolean {
  // Better Auth's current generator emits 32 alphanumeric characters; local/product ids use user_.
  return /^[A-Za-z0-9]{32}$/.test(value) || (value.startsWith('user_') && value.length > 5);
}

/** Checks the current Workspace id form; the identifier rollout tightens this owner. */
export function isWorkspaceId(value: string): boolean {
  return value.startsWith('ws_') && value.length > 3;
}

/** Checks the current Thread id form at a boundary that names that kind. */
export function isThreadId(value: string): boolean {
  return value.startsWith('th_') && value.length > 3;
}

/** Checks the current Turn id form at a boundary that names that kind. */
export function isTurnId(value: string): boolean {
  // Store-created Turns use tu_; active command-derived Turn owners use turn_.
  return (
    (value.startsWith('tu_') && value.length > 3) || (value.startsWith('turn_') && value.length > 5)
  );
}
