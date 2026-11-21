import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
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
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { ControlWorkerStorageInput } from './worker-storage-binding-codecs.js';

/** Applies the binding CAS against an admitted NanoHost handle after its external authority decision. */
function applyLocalWorkerStorageBinding(
  owner: { readonly sqlite: Database.Database },
  input: Exclude<ControlWorkerStorageInput, { kind: 'purge-pending' }>
) {
  assertControlProductWriter(owner.sqlite);
  switch (input.kind) {
    case 'create-and-reserve':
    case 'reserve-existing':
    case 'admit-contributor': {
      const authorizeContributor = (contributor: { contributorRef: string }) =>
        input.authorizedContributorRefs.includes(contributor.contributorRef);
      if (input.kind === 'create-and-reserve')
        createWorkerStorageBinding(owner, presentControlFacts(input));
      return input.kind === 'admit-contributor'
        ? admitWorkerStorageContributor(
            owner,
            presentControlFacts({ ...input, authorizeContributor })
          )
        : reserveWorkerStorageAttachment(
            owner,
            presentControlFacts({ ...input, authorizeContributor })
          );
    }
    case 'activate':
      return activateWorkerStorageAttachment(owner, presentControlFacts(input));
    case 'release':
      return releaseWorkerStorageAttachment(owner, presentControlFacts(input));
    case 'mark-unknown':
      return markWorkerStorageAttachmentUnknown(owner, presentControlFacts(input));
    case 'purge-settle':
      return settleWorkerStoragePurge(owner, presentControlFacts(input));
  }
}

/** Applies the binding tuple on the admitted owner. The purge census requires Core. */
export function applyControlWorkerStorageBinding(
  db: CoreDb | { readonly scope?: never; readonly sqlite: Database.Database },
  input: ControlWorkerStorageInput
) {
  if (input.kind !== 'purge-pending') return applyLocalWorkerStorageBinding(db, input);
  assertControlProductWriter(db.sqlite);
  if (db.scope !== 'core') throw new ControlProductPreconditionError();
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
}
