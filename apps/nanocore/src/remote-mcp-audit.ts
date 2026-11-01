import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import type { ControlRemoteMcpAudit } from './storage/remote-mcp-audit-codecs.js';
import { nativeProductScope } from './storage/workspace-file-records.js';

/** Publishes the original separate request Audit before returning the already-computed MCP response. */
export async function recordRemoteMcpAudit(
  db: CoreDb,
  input: ControlRemoteMcpAudit
): Promise<void> {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  await client.remoteMcpAudit(database, snapshot);
}
