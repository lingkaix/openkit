import { isDeepStrictEqual } from 'node:util';
import {
  activateWorkerStorageAttachment,
  admitWorkerStorageContributor,
  createWorkerStorageBinding,
  markWorkerStorageAttachmentUnknown,
  markWorkerStoragePurgePending,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  settleWorkerStoragePurge,
  WorkerStorageBindingError,
  workerStorageSchedulerRows,
} from '../runtime/worker-storage-binding-records.js';
import { presentControlFacts } from './control-store-input.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlWorkerStorageInput } from './worker-storage-binding-codecs.js';

/** Executes the complete existing binding tuple inside the admitted Core savepoint and covering FULL commit. */
export function applyControlWorkerStorageBinding(db: CoreDb, input: ControlWorkerStorageInput) {
  assertControlProductWriter(db.sqlite);
  switch (input.kind) {
    case 'create-and-reserve':
    case 'reserve-existing':
    case 'admit-contributor': {
      const authorizeContributor = (contributor: { contributorRef: string }) =>
        input.authorizedContributorRefs.includes(contributor.contributorRef);
      if (input.kind === 'create-and-reserve')
        createWorkerStorageBinding(db, presentControlFacts(input));
      return input.kind === 'admit-contributor'
        ? admitWorkerStorageContributor(db, presentControlFacts({ ...input, authorizeContributor }))
        : reserveWorkerStorageAttachment(
            db,
            presentControlFacts({ ...input, authorizeContributor })
          );
    }
    case 'activate':
      return activateWorkerStorageAttachment(db, presentControlFacts(input));
    case 'release':
      return releaseWorkerStorageAttachment(db, presentControlFacts(input));
    case 'mark-unknown':
      return markWorkerStorageAttachmentUnknown(db, presentControlFacts(input));
    case 'purge-pending':
      if (!isDeepStrictEqual(workerStorageSchedulerRows(db, input.storageRef), input.schedulerRows))
        throw new WorkerStorageBindingError(
          'purge_blocked',
          'Worker storage still has an attachment or surviving reference.'
        );
      return markWorkerStoragePurgePending(
        db,
        presentControlFacts({
          ...input,
          authorizePurge: () => true,
          hasSurvivingReferences: () => false,
        })
      );
    case 'purge-settle':
      return settleWorkerStoragePurge(db, presentControlFacts(input));
  }
}
