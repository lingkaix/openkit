import { OpenKitConfigSchema } from '@openkit/config-schema';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import {
  type CreateAppOptions,
  prepareTestAppOptions,
  prepareWorkspaceAuthorityFixture,
} from './app.js';
import { confirmContextDefaults } from './confirm-context-defaults.js';

export { confirmContextDefaults } from './confirm-context-defaults.js';

/** Preserves an explicit transport fixture while its human admits the real context Policy first. */
export async function confirmContextDefaultsForApp(
  options: CreateAppOptions
): Promise<CreateAppOptions> {
  options = prepareTestAppOptions(prepareWorkspaceAuthorityFixture(options));
  const { coreDb, store } = options;
  const dataRoot = options.dataRoot ?? coreDb?.dataRoot;
  if (!coreDb || !store || !dataRoot)
    throw new Error('Context consent requires the actual fixture owners.');
  const manager =
    options.runtimeConfigManager ??
    createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        ...options,
        dataRoot,
        openKitConfig: OpenKitConfigSchema.parse({ schemaVersion: 1, ...options.openKitConfig }),
      }),
    });
  return { ...options, runtimeConfigManager: await confirmContextDefaults(coreDb, store, manager) };
}
