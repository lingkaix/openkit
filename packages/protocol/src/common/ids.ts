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
