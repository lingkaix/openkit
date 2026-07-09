import { z } from 'zod';

/**
 * Agent profile schema embedded in or referenced by agent manifests.
 */
export const AgentProfileShapeSchema = z
  .object({
    capabilities: z.array(z.string().min(1)).optional(),
    displayName: z.string().min(1),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
    id: z.string().min(1),
    instructions: z.string().min(1).optional(),
    instructionsRef: z.string().min(1).optional(),
    modelRef: z.string().min(1).optional(),
    providerRef: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).optional(),
    tools: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

/**
 * Agent profile shape.
 */
export type AgentProfileShape = z.infer<typeof AgentProfileShapeSchema>;
