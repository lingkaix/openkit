import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import { SecurityTriggerRefusal } from '../storage/security-trigger-codecs.js';
import type { SecurityItemKey } from './identifiers.js';

type Owners = { coreDb: CoreDb; store: FsStore };

/** Original source and complete publication identities. v0.2.0 publishes none. */
export interface SecurityAlarmPublication {
  requestId: string;
  recipientUserId: string;
  generation: number;
  workspaceId: string;
  threadId: string;
  rule: 'R1' | 'R8' | 'E12';
  key: SecurityItemKey;
  occurrence: { kind: 'initial' | 'reopen' | 'reminder' | 'renotice' | 'conflict'; n: number };
  artifactId: string;
  artifactVersion: 1;
  raiseTurnId: string;
  reportItemId: string;
  requestItemId: string;
}

/** No publication is stored. This does not read Core or Workspace. */
export async function readSecurityAlarmPublication(
  _input: Owners & { workspaceId: string; threadId: string; requestId: string }
): Promise<SecurityAlarmPublication | null> {
  return null;
}

/** Notice publication is refused before a Thread, Turn, report or Attention write. */
export async function publishSecurityAlarm(
  _input: Owners & { requestId: string }
): Promise<{ status: 'published'; publication: SecurityAlarmPublication } | { status: 'busy' }> {
  throw new SecurityTriggerRefusal('forbidden');
}

/** Background drain publishes nothing. */
export async function drainSecurityNotices(_input: Owners): Promise<void> {
  return;
}
