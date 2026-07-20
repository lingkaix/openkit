import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';

/**
 * Writes the explicit Demo Workspace fixture used by local-mode Web e2e tests.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the file records and Core membership authority are durable.
 */
export async function seedDemoWorkspaceDataRoot(dataRoot: string): Promise<void> {
  seedSharedDemoWorkspaceDataRoot(dataRoot);
  await seedDemoWorkspaceAuthority(dataRoot);
}
