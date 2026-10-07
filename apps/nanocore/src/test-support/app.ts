import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type CreateAppOptions, createApp as createNanoCoreApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createTestAgentSetup, createTestGatewayConfig } from './agent-environment.js';
import { admitTestNativeEnvironment } from './native-environment.js';

export type { CreateAppOptions } from '../app.js';

/**
 * Creates a NanoCore app with an explicit deterministic executor for unit tests.
 *
 * @param options Production app options, including an optional executor override.
 * @returns NanoCore app configured for deterministic unit tests.
 */
export function createApp(options: CreateAppOptions = {}): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb) {
    admitTestNativeEnvironment(options.coreDb, createTestAgentSetup().manifest);
    for (const manifest of options.agentManifests ??
      options.runtimeConfigManager?.current().agentManifests ??
      [])
      admitTestNativeEnvironment(options.coreDb, manifest);
  }
  const ownsRuntimeConfig = !options.runtimeConfigManager && !options.gatewayConfig;
  const defaultProviderRegistry = new ProviderRegistry([
    {
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Test inference provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
  const providerSupportsDefaultGateway =
    !options.providerRegistry ||
    options.providerRegistry.get('agent-openrouter')?.models.includes('openai/gpt-5.2') === true;
  const turnExecutor =
    options.turnExecutor ?? new SimulatedTurnExecutor({ coreDb: options.coreDb });
  return createNanoCoreApp({
    ...(ownsRuntimeConfig && providerSupportsDefaultGateway
      ? { gatewayConfig: createTestGatewayConfig() }
      : {}),
    ...(ownsRuntimeConfig && !options.providerRegistry
      ? { providerRegistry: defaultProviderRegistry }
      : {}),
    ...options,
    turnExecutor,
  });
}

/** Databases owned only by tests that exercise local HTTP through canonical Workspace authority. */
const workspaceAuthorityFixtures: Array<{
  coreDb: ReturnType<typeof openCoreDb>;
  dataRoot: string;
}> = [];

afterEach(() => {
  for (const fixture of workspaceAuthorityFixtures.splice(0)) {
    if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

/** Supplies real local identity and membership records for formerly storage-only HTTP fixtures; explicit and server authority stays caller-owned. */
export function createAppWithWorkspaceAuthority(
  options: CreateAppOptions = {}
): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb || options.mode === 'server' || !options.store) return createApp(options);
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-test-workspace-authority-'));
  const coreDb = openCoreDb(dataRoot);
  workspaceAuthorityFixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  for (const workspace of options.store.listWorkspaces()) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
  }
  return createApp({ ...options, coreDb });
}
