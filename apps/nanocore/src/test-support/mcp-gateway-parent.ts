import { existsSync, readFileSync } from 'node:fs';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';

const [dataRoot, pidFile, stdioStub] = process.argv.slice(2);
if (!dataRoot || !pidFile || !stdioStub) throw new Error('Missing MCP crash fixture input.');

const coreDb = openCoreDb(dataRoot);
applyMigrations(coreDb);
const gateway = createDefaultWorkerMcpGateway(coreDb);
const serverPidFile = `${pidFile}.server`;
const server = resolveWorkspaceMcpServer({
  catalog: {
    schemaVersion: 1,
    servers: [
      {
        allowedTools: ['echo'],
        approvalRequiredTools: [],
        credentialBindings: [],
        deniedTools: [],
        enabled: true,
        id: 'echo',
        pinnedSchemaSnapshotId: null,
        schemaPolicy: 'tracking',
        timeoutMs: 2_000,
        transport: { args: [stdioStub], command: process.execPath, environment: {}, kind: 'stdio' },
      },
    ],
  },
  serverId: 'echo',
});
const gatewayInput = {
  credentials: {
    environment: {
      OPENKIT_MCP_DESCENDANT_PID_FILE: pidFile,
      OPENKIT_MCP_DESCENDANT_SECRET: 'crash-private-value',
      OPENKIT_MCP_IGNORE_STDIN_EXIT: '1',
      OPENKIT_MCP_SERVER_PID_FILE: serverPidFile,
    },
  },
  server,
  workspaceId: 'ws_demo',
};
void gateway
  .callTool({
    ...gatewayInput,
    arguments: { message: 'timeout' },
    toolName: 'echo',
  })
  .catch(() => undefined);
while (!existsSync(pidFile) || !existsSync(serverPidFile)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
process.stdout.write(
  `${JSON.stringify({
    descendantPid: JSON.parse(readFileSync(pidFile, 'utf8')).pid,
    serverPid: Number(readFileSync(serverPidFile, 'utf8')),
  })}\n`
);
await new Promise(() => undefined);
