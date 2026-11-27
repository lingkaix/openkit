import { isDeepStrictEqual } from 'node:util';
import { allocateEntityId } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { requireNanoHostObservation } from '../storage/nanohost-observation.js';
import type { AdmittedNanoHostTransportStorage } from '../storage/nanohost-transport-owner.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from './nanohost-runtime-target-records.js';
import {
  type AuthorizeWorkerStorageContributor,
  getWorkerStorageBinding,
  prepareWorkerStorageContributor,
  type WorkerStorageBinding,
  WorkerStorageBindingError,
  type WorkerStorageContributor,
  type WorkerStorageSelectionInput,
  type WorkerStorageTarget,
  workerStorageSchedulerRows,
} from './worker-storage-binding-records.js';

type WorkerStorageAttachmentCommand = Extract<
  Parameters<ReturnType<typeof getControlStoreWorkerClient>['workerStorageBinding']>[1],
  { kind: 'create-and-reserve' | 'reserve-existing' | 'admit-contributor' | 'activate' }
>;

/** The owner evaluates the local guard just before posting the closed Native CAS command. */
export type WriteNanoHostStorageAttachment = (
  command: WorkerStorageAttachmentCommand,
  authority: {
    readonly attemptId: string;
    readonly verifyBeforePost: (sqlite: Database.Database) => boolean;
  }
) => Promise<WorkerStorageBinding>;

/** Binds ordinary preparation to one original attempt and the selected Native opening. */
export interface AdmittedWorkerStorageAttachment {
  readonly attemptId: string;
  readonly target: NanoHostRuntimeTargetRecord;
  readonly read: AdmittedNanoHostTransportStorage['owner']['read'];
  readonly write: WriteNanoHostStorageAttachment;
  readonly authorizeContributor: AuthorizeWorkerStorageContributor;
  isCurrentAttempt(): boolean;
}

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
    contributors,
    input: {
      ...facts,
      now,
      layout: { ...input.layout, targets: [...input.layout.targets] },
      ...(input.adjudicatedThreadIds
        ? { adjudicatedThreadIds: [...input.adjudicatedThreadIds] }
        : {}),
      authorizedContributorRefs,
    },
  };
}

/** Uses the existing pre-post authority boundary. The Native transaction still decides the CAS. */
async function prepareAttachmentPublisher(
  coreDb: CoreDb,
  admitted: AdmittedWorkerStorageAttachment | undefined,
  authorizeContributor: AuthorizeWorkerStorageContributor | undefined
) {
  if (!admitted) {
    const { client, database } = await bindingWriter(coreDb);
    return (input: WorkerStorageAttachmentCommand) => client.workerStorageBinding(database, input);
  }
  const { target, attemptId } = admitted;
  const authorize = authorizeContributor ?? admitted.authorizeContributor;
  return async (
    input: WorkerStorageAttachmentCommand,
    prior?: WorkerStorageBinding | null,
    contributors: readonly WorkerStorageContributor[] = []
  ) => {
    let authorityRefused = false;
    try {
      return await admitted.write(input, {
        attemptId,
        verifyBeforePost: (sqlite) =>
          sqlite
            .transaction(() => {
              const owner = { sqlite };
              const current = getNanoHostRuntimeTarget(owner, target.targetId);
              if (
                !current?.ready ||
                !current.freshEmpty ||
                !current.predecessorFenced ||
                current.connectionGeneration !== target.connectionGeneration ||
                current.deploymentId !== target.deploymentId ||
                current.identityId !== target.identityId ||
                current.physicalEpoch !== target.physicalEpoch ||
                ('runtimeTargetId' in input && input.runtimeTargetId !== target.targetId) ||
                ('deploymentId' in input && input.deploymentId !== target.deploymentId) ||
                (prior &&
                  (prior.runtimeTargetId !== target.targetId ||
                    prior.deploymentId !== target.deploymentId)) ||
                !admitted.isCurrentAttempt() ||
                !isDeepStrictEqual(getWorkerStorageBinding(owner, input), prior)
              )
                return false;
              authorityRefused =
                (input.kind !== 'activate' &&
                  input.authorizedContributorRefs.length !== contributors.length) ||
                !contributors.every(authorize);
              return !authorityRefused;
            })
            .deferred(),
      });
    } catch (error) {
      if (authorityRefused)
        throw new WorkerStorageBindingError(
          'authorization_denied',
          'Worker storage contributor is not currently authorized.'
        );
      throw error;
    }
  };
}

/** Captures the current selected revision on the same reader as the attachment writer. */
function readAttachmentBinding(
  coreDb: CoreDb,
  storageRef: string,
  admitted?: AdmittedWorkerStorageAttachment
): WorkerStorageBinding {
  const binding = requireNanoHostObservation(
    coreDb,
    (sqlite) => {
      try {
        return getWorkerStorageBinding({ sqlite }, { storageRef });
      } catch (error) {
        if (
          error instanceof WorkerStorageBindingError ||
          (error instanceof TypeError && error.message === 'Unsupported retained record format.')
        )
          return error;
        throw error;
      }
    },
    admitted?.read
  );
  if (binding instanceof Error) throw binding;
  if (!binding)
    throw new WorkerStorageBindingError('not_found', 'Worker storage association was not found.');
  return binding;
}

/** Creates and reserves the first attachment as one atomic native tuple; no idle partial association is published. */
export async function createAndReserveWorkerStorageAttachment(
  coreDb: CoreDb,
  input: Omit<
    Parameters<typeof reserveWorkerStorageAttachment>[1],
    'storageRef' | 'expectedRevision'
  > & { readonly deploymentId: string },
  owner?: AdmittedWorkerStorageAttachment
): Promise<WorkerStorageBinding> {
  const { authorizeContributor, ...facts } = input;
  const snapshot = { ...structuredClone(facts), authorizeContributor };
  const publish = await prepareAttachmentPublisher(coreDb, owner, authorizeContributor);
  const storageRef = allocateEntityId('wst');
  const now = snapshot.now ?? new Date().toISOString();
  const admitted = admittedSelection(
    { storageRef, workspaceId: snapshot.workspaceId, contributors: [], attachmentGeneration: 0 },
    snapshot,
    now,
    1
  );
  return publish(
    {
      ...admitted.input,
      storageRef,
      expectedRevision: 1,
      kind: 'create-and-reserve',
    },
    null,
    admitted.contributors
  );
}

/** Publishes the existing exact reserveWorkerStorageAttachment transition after its covering FULL acknowledgement. */
export async function reserveWorkerStorageAttachment(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput & {
    readonly agentSessionId: string;
    readonly now?: string;
    readonly reuseWorkSlotRef?: string;
    readonly runtimeTargetId: string;
  },
  owner?: AdmittedWorkerStorageAttachment
): Promise<WorkerStorageBinding> {
  const { authorizeContributor, ...facts } = input;
  const snapshot = { ...structuredClone(facts), authorizeContributor };
  const publish = await prepareAttachmentPublisher(coreDb, owner, authorizeContributor);
  const binding = readAttachmentBinding(coreDb, snapshot.storageRef, owner);
  const now = snapshot.now ?? new Date().toISOString();
  const admitted = admittedSelection(binding, snapshot, now, binding.attachmentGeneration + 1);
  return publish({ ...admitted.input, kind: 'reserve-existing' }, binding, admitted.contributors);
}

/** Publishes the existing exact admitWorkerStorageContributor transition after its covering FULL acknowledgement. */
export async function admitWorkerStorageContributor(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput & { readonly reuseWorkSlotRef?: string },
  owner?: AdmittedWorkerStorageAttachment
): Promise<WorkerStorageBinding> {
  const { authorizeContributor, ...facts } = input;
  const snapshot = { ...structuredClone(facts), authorizeContributor };
  const publish = await prepareAttachmentPublisher(coreDb, owner, authorizeContributor);
  const binding = readAttachmentBinding(coreDb, snapshot.storageRef, owner);
  const now = new Date().toISOString();
  const admitted = admittedSelection(binding, snapshot, now, binding.attachmentGeneration);
  return publish({ ...admitted.input, kind: 'admit-contributor' }, binding, admitted.contributors);
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
  },
  owner?: AdmittedWorkerStorageAttachment
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  const publish = await prepareAttachmentPublisher(coreDb, owner, undefined);
  const prior = owner ? readAttachmentBinding(coreDb, snapshot.storageRef, owner) : undefined;
  return publish(
    {
      ...snapshot,
      targets: [...snapshot.targets],
      kind: 'activate',
    },
    prior,
    prior?.contributors
  );
}

/** Existing Native release CAS after the owning caller establishes Sandbox cleanup. */
export type WriteNanoHostStorageRelease = (
  input: Extract<
    Parameters<ReturnType<typeof getControlStoreWorkerClient>['workerStorageBinding']>[1],
    { kind: 'release' }
  >
) => Promise<WorkerStorageBinding>;

/** Existing Native CAS for one transition after the caller's cleanup, fence or purge decision. */
export type WriteNanoHostStorageTransition = (
  input: Extract<
    Parameters<ReturnType<typeof getControlStoreWorkerClient>['workerStorageBinding']>[1],
    { kind: 'release' | 'mark-unknown' | 'purge-settle' }
  >
) => Promise<WorkerStorageBinding>;

/**
 * Existing Native purge reservation. Under the acquired Core hold it rechecks the caller's
 * original authority, and the owner rechecks the Core Scheduler census in its commit.
 */
export type WriteNanoHostStoragePurge = (
  input: Extract<
    Parameters<ReturnType<typeof getControlStoreWorkerClient>['workerStorageBinding']>[1],
    { kind: 'purge-pending' }
  >,
  authorizePurge: () => boolean
) => Promise<WorkerStorageBinding>;

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
  },
  admitted?: WriteNanoHostStorageRelease
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  if (admitted) return admitted({ ...snapshot, kind: 'release' });
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
  },
  admitted?: WriteNanoHostStorageTransition
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  if (admitted) return admitted({ ...snapshot, kind: 'mark-unknown' });
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
  },
  admitted?: WriteNanoHostStoragePurge
): Promise<WorkerStorageBinding> {
  const { authorizePurge, hasSurvivingReferences, ...retained } = input;
  const snapshot = { ...structuredClone(retained), authorizePurge, hasSurvivingReferences };
  const writer = admitted ?? (await bindingWriter(coreDb));
  if (!snapshot.authorizePurge())
    throw new WorkerStorageBindingError(
      'authorization_denied',
      'Worker storage purge is not authorized.'
    );
  // Bind the native comparison to the state observed before the caller's absence check.
  // A Scheduler admission committed during that check must invalidate purge.
  const binding = requireNanoHostObservation(coreDb, (sqlite) =>
    getWorkerStorageBinding({ sqlite }, { storageRef: snapshot.storageRef })
  );
  if (!binding)
    throw new WorkerStorageBindingError('not_found', 'Worker storage association was not found.');
  const schedulerRows = workerStorageSchedulerRows(
    coreDb,
    snapshot.storageRef,
    binding.workspaceId
  );
  if (snapshot.hasSurvivingReferences())
    throw new WorkerStorageBindingError(
      'purge_blocked',
      'Worker storage still has an attachment or surviving reference.'
    );
  const { authorizePurge: _authorize, hasSurvivingReferences: _references, ...facts } = snapshot;
  const command = { ...facts, kind: 'purge-pending' as const, schedulerRows };
  return typeof writer === 'function'
    ? writer(command, snapshot.authorizePurge)
    : writer.client.workerStorageBinding(writer.database, command);
}

/** Publishes the existing exact settleWorkerStoragePurge transition after its covering FULL acknowledgement. */
export async function settleWorkerStoragePurge(
  coreDb: CoreDb,
  input: {
    readonly expectedRevision: number;
    readonly now?: string;
    readonly outcome: 'purged' | 'retained' | 'unknown';
    readonly storageRef: string;
  },
  admitted?: WriteNanoHostStorageTransition
): Promise<WorkerStorageBinding> {
  const snapshot = structuredClone(input);
  if (admitted) return admitted({ ...snapshot, kind: 'purge-settle' });
  const { client, database } = await bindingWriter(coreDb);
  return client.workerStorageBinding(database, { ...snapshot, kind: 'purge-settle' });
}
