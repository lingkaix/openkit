import { createDemoWorkspaceForUser, FsStore, type FsStoreOptions } from '../lib/store.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';

/**
 * Imports the Demo Workspace fixture into a store when it is absent.
 *
 * @param store Store that should receive the demo fixture.
 * @param userId User id namespace for the fixture ids.
 */
export function seedDemoWorkspace(store: FsStore, userId = LOCAL_USER_ID): void {
  const demo = createDemoWorkspaceForUser(userId);

  try {
    store.getWorkspace(demo.workspace.id);
    return;
  } catch {
    store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      knowledge: demo.knowledge,
      threadItems: [],
    });
  }
}

/**
 * Creates a test store with Quick Chat plus the explicit Demo Workspace fixture.
 *
 * @param options Store options.
 * @returns Store with project workspace fixtures.
 */
export function createDemoStore(options: FsStoreOptions = {}): FsStore {
  const store = new FsStore(options);
  seedDemoWorkspace(store, options.userId ?? LOCAL_USER_ID);
  return store;
}
