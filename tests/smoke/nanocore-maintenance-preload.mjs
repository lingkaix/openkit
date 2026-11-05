import { isMainThread } from 'node:worker_threads';
import { installInitialMaintenanceWitness } from './nanocore-maintenance-observer.mjs';

// Workers inherit --import, but only the owned main process has this completion IPC.
// Leave real storage/backup worker execution and the original startup owner untouched.
if (isMainThread) installInitialMaintenanceWitness();
