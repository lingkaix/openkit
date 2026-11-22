import { readRetainedV1 } from '@openkit/protocol';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  verifyOpenKitAccessTokenSecret,
} from './access-token.js';
import {
  getOpenKitAccessTokenRecord,
  type VerifiedOpenKitAccessTokenRecord,
} from './access-token-store.js';

/**
 * Verifies one presented OpenKit access token against durable server records.
 *
 * @param coreDb Open Core database handles.
 * @param secret Presented bearer token secret.
 * @param options Optional verification clock and redacted source summary.
 * @returns Verified non-secret token identity or null.
 * @throws When a retained token format or its workspace-binding JSON is invalid.
 */
export async function verifyOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  secret: string,
  options: {
    channel?: string;
    now?: Date;
    source?: string;
    runtimeConfigManager?: RuntimeConfigManager;
  } = {}
): Promise<VerifiedOpenKitAccessTokenRecord | null> {
  if (!isOpenKitAccessTokenSecret(secret)) return null;
  const expectedHash = hashOpenKitAccessTokenSecret(secret);
  const row = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, * FROM openkit_access_tokens WHERE token_hash = ?'
    )
    .get(expectedHash) as
    | { schemaVersion: unknown; token_id: string; token_hash: string }
    | undefined;
  if (!row || !verifyOpenKitAccessTokenSecret(secret, row.token_hash)) return null;
  // Preserve retained-format refusal before admission; this read grants no authority.
  const retained = readRetainedV1(row, () => getOpenKitAccessTokenRecord(coreDb, row.token_id));
  const input = {
    tokenId: row.token_id,
    expectedHash,
    ...(options.now ? { now: options.now.toISOString() } : {}),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  const scope = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: coreDb.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const result = await client.accessTokenVerification(
    database,
    input,
    !!retained?.runSubject && retained.status === 'active'
  );
  if (retained?.runSubject) {
    if (options.runtimeConfigManager) {
      await new SecurityTriggerStore(coreDb).consumeSensor(
        retained.runSubject.lineage,
        options.runtimeConfigManager
      );
    }
    return null;
  }
  return result;
}
