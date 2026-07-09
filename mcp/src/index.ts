#!/usr/bin/env node
import { createNanoCoreClientOptionsFromEnv } from './config.js';
import { createDefaultNanoCoreCredentialStore } from './credential-store.js';
import { createJsonRpcHandler } from './mcp-protocol.js';
import { createNanoCoreClient } from './nanocore-client.js';
import { createOpenKitAiInterface } from './registry.js';
import { serveStdio } from './stdio-server.js';

/**
 * Starts the OpenKit AI Interface process.
 *
 * @returns Resolves after writing startup diagnostics.
 */
async function main(): Promise<void> {
  const credentialStore = createDefaultNanoCoreCredentialStore();
  const nanoCoreOptions = createNanoCoreClientOptionsFromEnv(process.env, {
    credentialStore,
  });
  const registry = createOpenKitAiInterface({
    credentialStore,
    nanoCore: createNanoCoreClient(nanoCoreOptions),
    nanoCoreBaseUrl: nanoCoreOptions.baseUrl,
  });

  await serveStdio({
    error: process.stderr,
    handler: createJsonRpcHandler(registry),
    input: process.stdin,
    output: process.stdout,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
