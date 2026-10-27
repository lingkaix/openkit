import {
  type WorkspaceFreezeRefusal,
  WorkspaceFreezeRefusalSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';

/**
 * Parses a structured lifecycle refusal from a typed 409 API error.
 *
 * @param error Mutation or query failure from Core Client.
 * @returns Parsed refusal details, or null when the error is not a freeze refusal.
 */
export function parseWorkspaceFreezeRefusal(error: unknown): WorkspaceFreezeRefusal | null {
  if (!(error instanceof ApiCallError) || error.status !== 409) return null;
  if (error.code !== 'workspace_blocked' && error.code !== 'workspace_frozen') return null;
  const parsed = WorkspaceFreezeRefusalSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}
