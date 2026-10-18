import type { LocalStorageMount, StorageFailure, StorageService } from './contract.js';

/** Local configured roots; this initial scaffold refuses operations until implemented. */
export class LocalStorage implements StorageService {
  constructor(_options: { mounts: LocalStorageMount[]; stagingRoot: string }) {}
  stat: StorageService['stat'] = async () => unavailable();
  scan: StorageService['scan'] = async () => unavailable();
  read: StorageService['read'] = async () => unavailable();
  beginStage: StorageService['beginStage'] = async () => unavailable();
  writeStage: StorageService['writeStage'] = async () => unavailable();
  finishStage: StorageService['finishStage'] = async () => unavailable();
  readStage: StorageService['readStage'] = async () => unavailable();
  discardStage: StorageService['discardStage'] = async () => unavailable();
  /** Release this instance's transient staging files. */
  async close(): Promise<void> {}
}

/** Observable pre-implementation refusal for the regression-first package scaffold. */
function unavailable(): StorageFailure {
  return { status: 'unavailable', reason: 'unsupported' };
}
