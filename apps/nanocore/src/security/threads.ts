import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import { SecurityTriggerRefusal } from '../storage/security-trigger-codecs.js';

type Owners = { coreDb: CoreDb; store: FsStore };

/** Trusted source identity only. v0.2.0 selects no security Thread. */
export interface SecurityThreadSelection {
  recipientUserId: string;
  generation: number;
  workspaceId: string;
  threadId: string;
  threadStatus: 'active' | 'archived';
}

/**
 * Returns null before Core or Workspace reads.
 * Ordinary Administration is not classified as a security Thread.
 */
export async function selectSecurityThread(
  _input: Owners & { workspaceId: string; threadId: string }
): Promise<SecurityThreadSelection | null> {
  return null;
}

/** Destination preparation is refused before a Thread is created. */
export async function prepareSecurityThread(
  _input: Owners & { requestId: string }
): Promise<SecurityThreadSelection> {
  throw new SecurityTriggerRefusal('forbidden');
}
