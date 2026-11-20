import type { StorageStatus } from './storage-owner.js';

/** A6 reports disabled at cutover before dispatch, replay or background work can post effects. */
export interface SecurityTriggerStore {
  status(): StorageStatus<'security-trigger'>;
}
