import { seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot } from '../../../../tests/support/demo-data.mjs';

/**
 * Writes the explicit Demo Workspace fixture used by local-mode Web e2e tests.
 *
 * @param dataRoot NanoCore data root to seed.
 * @param userId User namespace for the seeded workspace.
 */
export function seedDemoWorkspaceDataRoot(dataRoot: string, userId = 'user_local'): void {
  seedSharedDemoWorkspaceDataRoot(dataRoot, { userId });
}
