import { z } from 'zod';

/** App automation record returned by NanoCore. */
export const AutomationRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspaceId: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  status: z.enum(['paused', 'enabled']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** App automation list response. */
export const ListAutomationsResponseSchema = z.object({
  items: z.array(AutomationRecordSchema),
});

/** App automation create request. */
export const CreateAutomationRequestSchema = z.object({
  name: z.string().min(1),
  workspaceId: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
});

/** App automation update request. */
export const UpdateAutomationRequestSchema = z.object({
  status: z.enum(['paused', 'enabled']),
});

/** App automation record returned by NanoCore. */
export type AutomationRecord = z.infer<typeof AutomationRecordSchema>;
/** App automation list response. */
export type ListAutomationsResponse = z.infer<typeof ListAutomationsResponseSchema>;
/** App automation create request. */
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequestSchema>;
/** App automation update request. */
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequestSchema>;
