import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { expect, onTestFinished } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createTestGatewayConfig } from './agent-environment.js';
import { DEMO_WORKSPACE_ID, seedDemoWorkspace } from './demo-store.js';
import { createKnowledgeAnswerApp } from './knowledge-agent.js';
import { ensureLocalUser } from './local-user.js';
import { createTestStore } from './store.js';

/**
 * Real operation admission, notebooks and runtime; only Provider transport is replaced.
 *
 * @param enableMaintenance Whether this invocation supplies the existing maintenance configuration.
 * @returns The request-local app, Store, database, root and actor with registered cleanup.
 */
export async function fixture(enableMaintenance = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-result-api-'));
  const store = createTestStore({ dataRoot });
  await seedDemoWorkspace(store);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const maintenanceGateway = createTestGatewayConfig();
  // Match the real-KM transport fixture's compaction boundary when supplying native settings.
  maintenanceGateway.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 32_000 },
  ];
  const result = createKnowledgeAnswerApp(
    {
      dataRoot,
      store,
      coreDb,
      ...(enableMaintenance
        ? {
            runtimeConfigManager: createRuntimeConfigManager({
              dataRoot,
              initialSnapshot: createInMemoryRuntimeConfigSnapshot({
                dataRoot,
                gatewayConfig: maintenanceGateway,
                providerRegistry: new ProviderRegistry([
                  {
                    id: 'agent-openrouter',
                    displayName: 'Test inference provider',
                    kind: 'custom',
                    baseUrl: 'https://provider.invalid/v1',
                    models: ['openai/gpt-5.2'],
                    modelMetadata: {
                      'openai/gpt-5.2': {
                        tool_call: true,
                        limit: { context: 64_000, output: 2_000 },
                      },
                    },
                  },
                ]),
                workspaceConfigs: [
                  {
                    workspaceId: DEMO_WORKSPACE_ID,
                    path: join(
                      dataRoot,
                      'workspaces',
                      DEMO_WORKSPACE_ID,
                      'config',
                      'workspace.jsonc'
                    ),
                    config: WorkspaceConfigSchema.parse({
                      schemaVersion: 1,
                      workspace: {
                        name: 'Link repair fixture',
                        knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
                      },
                    }),
                  },
                ],
              }),
            }),
          }
        : {}),
    },
    []
  );
  onTestFinished(async () => {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { ...result, store, coreDb, dataRoot, userId };
}

/**
 * Submits a real model-visible Tool call through the Gateway projection.
 *
 * @param name Operation name projected to the model-visible Tool name.
 * @param value Tool arguments serialized into the Provider response.
 * @returns One Provider response containing the requested function call.
 */
export function call(name: string, value: unknown) {
  return {
    id: randomUUID(),
    object: 'response',
    output: [
      {
        type: 'function_call',
        call_id: randomUUID(),
        name: operationToolName(name),
        arguments: JSON.stringify(value),
      },
    ],
  };
}

/**
 * Reads only delivered feedback; the dispatcher's private context contains a live database.
 *
 * @param f The existing result fixture whose latest model request contains Tool feedback.
 * @returns The latest delivered function-call output after its existing string assertion.
 */
export function latestToolOutput(f: Awaited<ReturnType<typeof fixture>>): string {
  const [, request] = f.createResponses.mock.calls.at(-1) as unknown as Parameters<
    LLMGatewayProviderDispatcher['createResponses']
  >;
  const input = request.input as Array<{ type?: string; output?: string }>;
  const latest = input.findLast((entry) => entry.type === 'function_call_output');
  expect(latest?.output).toEqual(expect.any(String));
  return latest!.output!;
}

/**
 * Native calls in one Provider response retain their ordinary sequential execution.
 *
 * @param entries Ordered operation names and Tool arguments for the Provider response.
 * @returns One Provider response containing the ordered native function calls.
 */
export function calls(entries: Array<[string, unknown]>) {
  const first = call(entries[0]![0], entries[0]![1]);
  return { ...first, output: entries.flatMap(([name, value]) => call(name, value).output) };
}
