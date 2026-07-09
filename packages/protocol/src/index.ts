export * from './common/ids.js';
export * from './common/item-delta.js';
export * from './common/timestamps.js';
export * from './common/version.js';
export * from './errors/error.js';
export * from './events/envelope.js';
export * from './models/agent.js';
export * from './models/approval.js';
export * from './models/artifact.js';
export * from './models/audit.js';
export * from './models/capability.js';
export * from './models/item.js';
export * from './models/knowledge.js';
export * from './models/thread.js';
export * from './models/turn.js';
export * from './models/usage.js';
export * from './models/workspace.js';
export * from './requests/approval.js';
export * from './requests/artifact.js';
export * from './requests/thread.js';
export * from './requests/turn.js';
export * from './requests/workspace.js';

import { z } from 'zod';

import { SseEventNameSchema } from './events/envelope.js';
import { WorkspaceResourcesSchema, WorkspaceSummarySchema } from './models/workspace.js';

/**
 * Server metadata and client capability discovery response.
 */
export const MetaResponseSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  eventFamilies: z.array(SseEventNameSchema),
  itemTypes: z.array(z.string().min(1)).optional(),
  itemDeltaKinds: z.array(z.string().min(1)).optional(),
});

/**
 * Workspace listing response.
 */
export const ListWorkspacesResponseSchema = z.object({
  items: z.array(WorkspaceSummarySchema),
});

/**
 * Workspace resources response.
 */
export const WorkspaceResourcesResponseSchema = WorkspaceResourcesSchema;
