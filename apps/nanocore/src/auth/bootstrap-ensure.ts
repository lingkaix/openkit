import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { createOpenKitAccessTokenSecret, hashOpenKitAccessTokenSecret } from './access-token.js';
import type { ServerBootstrapTokenIssue } from './bootstrap-token.js';

/** Keeps the startup secret on Main until its original setting mutation has FULL acknowledgement. */
export async function ensureServerBootstrapTokenForStartup(
  coreDb: CoreDb
): Promise<ServerBootstrapTokenIssue | null> {
  const token = createOpenKitAccessTokenSecret();
  const issued = await getControlStoreWorkerClient().bootstrapEnsure(coreDb, {
    tokenHash: hashOpenKitAccessTokenSecret(token),
  });
  return issued ? { ...issued, token } : null;
}
