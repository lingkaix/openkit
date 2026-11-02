import { allocateEntityId } from '@openkit/protocol';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  getWorkerStorageBinding,
  prepareWorkerStorageContributor,
  type WorkerStorageBinding,
  WorkerStorageBindingError,
  type WorkerStorageSelectionInput,
  type WorkerStorageTarget,
  workerStorageSchedulerRows,
} from './worker-storage-binding-records.js';

export {
  type AuthorizeWorkerStorageContributor,
  authorizeAttachedWorkerStorageReplacement,
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
  listWorkerStorageBindings,
  resolveWorkerStorageWorkSlotRef,
  selectWorkerStorageBinding,
  type WorkerStorageBinding,
  WorkerStorageBindingError,
  type WorkerStorageContributor,
  type WorkerStorageLayout,
  type WorkerStorageSelectionInput,
  type WorkerStorageTarget,
  workerStorageDefaultWorkSlotRef,
  workerStorageLayoutDigest,
  workerStorageScopeDigest,
} from './worker-storage-binding-records.js';

/** Opens the existing Core writer before evaluating current caller-owned authority. */
async function bindingWriter(coreDb: CoreDb) {
  const scope = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: coreDb.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return { client, database };
}

/** Freezes only the exact contributor identities admitted by the existing current-authority callback. */
function admittedSelection<
  T extends Omit<WorkerStorageSelectionInput, 'storageRef' | 'expectedRevision'> & {
    readonly reuseWorkSlotRef?: string;
  },
>(
  binding: Pick<
    WorkerStorageBinding,
    'storageRef' | 'workspaceId' | 'contributors' | 'attachmentGeneration'
  >,
  input: T,
  now: string,
  generation: number
) {
  const proposed = prepareWorkerStorageContributor(binding, input, now, generation);
  const contributors = [...binding.contributors, proposed];
  const authorizedContributorRefs: string[] = [];
  // Preserve the original first-denied predicate order without replacing its native refusal.
  for (const contributor of contributors) {
    if (!input.authorizeContributor(contributor)) break;
    authorizedContributorRefs.push(contributor.contributorRef);
  }
  const { authorizeContributor: _callback, ...facts } = input;
  return {
    ...facts,
    now,
    layout: { ...input.layout, targets: [...input.layout.targets] },
    ...(input.adjudicatedThreadIds
      ? { adjudicatedThreadIds: [...input.adjudicatedThreadIds] }
      : {}),
    authorizedContributorRefs,
  };
}

/** Creates and reserves the first attachment as one atomic native tuple; no idle partial association is published. */
export async function createAndReserveWorkerStorageAttachment(
  coreDb: CoreDb,
  input: Omit<
    Parameters<typeof reserveWorkerStorageAttachment>[1],
    'storageRef' | 'expectedRevision'
  > & { readonly deploymentId: string }
): Promise<WorkerStorageBinding> {
  const { authorizeContributor, ...facts } = input;
  const snapshot = { ...structuredClone(facts), authorizeContributor };
  const { client, database } = await bindingWriter(coreDb);
  const storageRef = allocateEntityId('wst');
  const now = snapshot.now ?? new Date().toISOString();
  const admitted = admittedSelection(
    { storageRef, workspaceId: snapshot.workspaceId, contributors: [], attachmentGeneration: 0 },
    snapshot,
    now,
    1
  );
  return client.workerStorageBinding(database, {
    ...admitted,
    storageRef,
    expectedRevision: 1,
    kind: 'create-and-reserve',
  });
}

/** Publishes the existing exact reserveWorkerStorageAttachment transition after its covering FULL acknowledgement. */
export async function reserveWorkerStorageAttachment(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput & {
    readonly agentSessionId: string;
    readonly now?: string;
    readonly reuseWorkSlotRef?: string;
    readonly runtimeTargetId: string;
  }
): Promise<WorkerStorageBinding> {
  const { authorizeContributor, ...facts } = input;
  const snapshot = { ...structuredClone(facts), authorizeContributor };
  const { client, database } = await bindingWriter(coreDb);
  const binding = getWorkerStorageBinding(coreDb, { storageRef: snapshot.storageRef });
  if (!binding)
    throw new WorkerStorageBindingError('not_found', 'Worker storage association was not found.');
  const now = snapshot.now ?? new Date().toISOString();
  const admitted = admittedSelection(binding, snapshot, now, binding.attachmentGeneration + 1);
  return client.workerStorageBinding(database, { ...admitted, kind: 'reserve-existing' });
}

/** Publishes the existing exact admitWorkerStorageContributor transition after its covering FULL acknowledgement. */
export async function admitWorkerStorageContributor(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput & { readonly reuseWorkSlotRef?: string }
): Promise<WorkerStorageBinding> {
  const { authorizeContributor, ...facts } = input;
  const snapshot = { ...structuredClone(facts), authorizeContributor };
  const { client, database } = await bindingWriter(coreDb);
  const binding = getWorkerStorageBinding(coreDb, { storageRef: snapshot.storageRef });
  if (!binding)
    throw new WorkerStorageBindingError('not_found', 'Worker storage association was not found.');
  const now = new Date().toISOString();
  const admitted = admittedSelection(binding, snapshot, now, binding.attachmentGeneration);
  return client.workerStorageBinding(database, { ...admitted, kind: 'admit-contributor' });
}

/** Publishes the existing exact activateWorkerStorageAttachment transition after its covering FULL acknowledgement. */
export async function activateWorkerStorageAttachment(
  coreDb: CoreDb,
  input: {
    readonly attachmentGeneration: number;
    readonly expectedRevision: number;
    readonly now?: string;
    readonly sandboxBindingRef: string;
    readonly storageRef: string;
    readonly targets: readonly WorkerStorageTarget[];
  }
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  const { client, database } = await bindingWriter(coreDb);
  return client.workerStorageBinding(database, {
    ...snapshot,
    targets: [...snapshot.targets],
    kind: 'activate',
  });
}

/** Publishes the existing exact releaseWorkerStorageAttachment transition after its covering FULL acknowledgement. */
export async function releaseWorkerStorageAttachment(
  coreDb: CoreDb,
  input: {
    readonly attachmentGeneration: number;
    readonly cleanupProved: boolean;
    readonly expectedRevision: number;
    readonly now?: string;
    readonly sandboxBindingRef?: string | null;
    readonly storageRef: string;
  }
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  const { client, database } = await bindingWriter(coreDb);
  return client.workerStorageBinding(database, { ...snapshot, kind: 'release' });
}

/** Publishes the existing exact markWorkerStorageAttachmentUnknown transition after its covering FULL acknowledgement. */
export async function markWorkerStorageAttachmentUnknown(
  coreDb: CoreDb,
  input: {
    readonly attachmentGeneration: number;
    readonly expectedRevision: number;
    readonly now?: string;
    readonly storageRef: string;
  }
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  const { client, database } = await bindingWriter(coreDb);
  return client.workerStorageBinding(database, { ...snapshot, kind: 'mark-unknown' });
}

/** Publishes the existing exact markWorkerStoragePurgePending transition after its covering FULL acknowledgement. */
export async function markWorkerStoragePurgePending(
  coreDb: CoreDb,
  input: {
    readonly authorizePurge: () => boolean;
    readonly expectedRevision: number;
    readonly hasSurvivingReferences: () => boolean;
    readonly now?: string;
    readonly storageRef: string;
  }
): Promise<WorkerStorageBinding> {
  const { authorizePurge, hasSurvivingReferences, ...retained } = input;
  const snapshot = { ...structuredClone(retained), authorizePurge, hasSurvivingReferences };
  const { client, database } = await bindingWriter(coreDb);
  if (!snapshot.authorizePurge())
    throw new WorkerStorageBindingError(
      'authorization_denied',
      'Worker storage purge is not authorized.'
    );
  if (snapshot.hasSurvivingReferences())
    throw new WorkerStorageBindingError(
      'purge_blocked',
      'Worker storage still has an attachment or surviving reference.'
    );
  const { authorizePurge: _authorize, hasSurvivingReferences: _references, ...facts } = snapshot;
  return client.workerStorageBinding(database, {
    ...facts,
    kind: 'purge-pending',
    schedulerRows: workerStorageSchedulerRows(coreDb, snapshot.storageRef),
  });
}

/** Publishes the existing exact settleWorkerStoragePurge transition after its covering FULL acknowledgement. */
export async function settleWorkerStoragePurge(
  coreDb: CoreDb,
  input: {
    readonly expectedRevision: number;
    readonly now?: string;
    readonly outcome: 'purged' | 'retained' | 'unknown';
    readonly storageRef: string;
  }
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  const { client, database } = await bindingWriter(coreDb);
  return client.workerStorageBinding(database, { ...snapshot, kind: 'purge-settle' });
}
