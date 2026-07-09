import { z } from 'zod';

import { AgentIdSchema, AgentProfileIdSchema, AgentSessionIdSchema } from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';

/**
 * Closed lifecycle states for agent sessions.
 */
export const AgentSessionStatusSchema = z.enum([
  'created',
  'initializing',
  'ready',
  'busy',
  'idle',
  'degraded',
  'suspended',
  'interrupted',
  'failed',
  'closed',
]);

/**
 * Closed lifecycle state for an agent session.
 */
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

/**
 * Product-safe sandbox summary for an agent or session.
 */
export const AgentSandboxSummarySchema = z.object({
  access: z.enum(['none', 'read-only', 'read-write']),
  workspaceRootRefs: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1).nullable(),
});

/**
 * Product-visible agent session record without adapter-native launch details.
 */
export const AgentSessionSchema = z.object({
  id: AgentSessionIdSchema,
  agentId: AgentIdSchema,
  workspaceId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  status: AgentSessionStatusSchema,
  message: z.string().min(1).nullable(),
  sandboxSummary: AgentSandboxSummarySchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * Product-visible agent session record.
 */
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * Stable capability summary advertised for an agent catalog entry.
 */
export const AgentCapabilitySummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).nullable(),
});

/**
 * Product-visible agent health snapshot.
 */
export const AgentHealthSchema = z.object({
  status: z.enum(['unknown', 'starting', 'ready', 'running', 'offline', 'failed']),
  message: z.string().min(1).nullable(),
  checkedAt: TimestampSchema.nullable(),
});

/**
 * Behavior profile available inside a product-visible agent.
 */
export const AgentProfileSchema = z.object({
  id: AgentProfileIdSchema,
  displayName: z.string().min(1),
  instructionsRef: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  skillIds: z.array(z.string().min(1)),
  capabilityIds: z.array(z.string().min(1)),
});

/**
 * Stable catalog entry that describes an agent without runtime adapter setup.
 */
export const AgentCatalogEntrySchema = z.object({
  id: AgentIdSchema,
  name: z.string().min(1),
  kind: z.enum(['planner', 'coder', 'researcher', 'reviewer', 'internal']),
  status: z.enum(['enabled', 'disabled']),
  modelId: z.string().min(1).nullable(),
  skillIds: z.array(z.string().min(1)),
  profiles: z.array(AgentProfileSchema),
  defaultProfileId: AgentProfileIdSchema.nullable(),
  capabilities: z.array(AgentCapabilitySummarySchema).default([]),
  sandboxSummary: AgentSandboxSummarySchema.nullable().default(null),
  health: AgentHealthSchema,
});

/**
 * Short product-visible agent summary for attribution and selection views.
 */
export const AgentSummarySchema = AgentCatalogEntrySchema.pick({
  id: true,
  name: true,
  kind: true,
  status: true,
  modelId: true,
  defaultProfileId: true,
  capabilities: true,
  sandboxSummary: true,
  health: true,
});

/**
 * Stable product-visible agent definition.
 */
export const AgentSchema = AgentCatalogEntrySchema;
