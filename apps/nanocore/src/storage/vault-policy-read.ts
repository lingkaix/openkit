import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { ThreadVisibilityReadPort } from '../auth/thread-visibility.js';
import { readRuntimeConfigPolicySource } from '../config/runtime-config-files.js';
import { PolicyInterception } from '../policy/interception.js';
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  type GoalTaskPolicyReadPort,
  requiredTaskTurn,
} from '../runtime/goal-task-policy-context.js';
import {
  assertHarnessLoginReplacement,
  assertPreparedHarnessLoginReplacement,
  type HarnessLoginReplacementRead,
  readHarnessLoginThreadSessions,
} from '../runtime/harness-login-selection.js';
import { requireReleasedLoginPredecessor } from '../runtime/nanohost-harness-records.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import type { ControlPolicyGrant } from './control-store-worker-protocol.js';
import {
  bindWorkspaceSqlite,
  type CoreDb,
  openUserReadDb,
  type UserDb,
  type WorkspaceDb,
} from './db.js';
import { userDbPath } from './fs-layout.js';
import { StoredTurnV1Schema } from './retained-work-metadata-v1.js';
import type { NativeRuntimePolicyPublication } from './runtime-policy-publication.js';
import { type ControlVaultInput, ControlVaultInputSchema } from './vault-native-codecs.js';
import {
  nativeProductScope,
  type PreparedNativeTurnHistoryRead,
  prepareNativeTurnHistoryRead,
  readNativeProduct,
  WorkspaceSystemRecordSchema,
} from './workspace-file-records.js';

/** One request's actual native read resources; the Worker retains completion and SQL ownership. */
export interface PreparedControlVaultRead {
  /** Actual readonly Workspace connection; existing Login predicates may borrow it without reopening. */
  readonly workspaceDb: WorkspaceDb;
  /** Canonical consumer package, verified again at the synchronous head; reading this property performs no I/O. */
  readonly consumerPackage: ReturnType<typeof requireAgentEnvironmentPackageSnapshot>['snapshot'];
  /** Samples canonical files and physical identities immediately before SQL, with no await afterwards. */
  sampleHead(): void;
  /** Repeats the original decision on the same input/Core connection and actual live publication state. */
  assertCurrent(
    coreDb: CoreDb,
    input: ControlVaultInput,
    policyState: NativeRuntimePolicyPublication | undefined
  ): void;
  /** Idempotently closes this preparation's actual readonly Workspace handle. */
  close(): void;
}

/** The native activation borrows the existing worker-owned Core source, never its lifetime. */
export interface PreparedHarnessLoginActivationRead {
  readonly kind: 'login-activation';
  readonly coreDb: CoreDb;
  readonly consumerPackage: PreparedControlVaultRead['consumerPackage'];
  sampleHead(): void;
  assertCurrent(
    db: WorkspaceDb,
    input: ControlVaultInput,
    policy: ControlPolicyGrant['policy']
  ): void;
  close(): void;
}
export type PreparedNativeVaultRead = PreparedControlVaultRead | PreparedHarnessLoginActivationRead;
type PreparedVaultPolicyRead = Omit<PreparedControlVaultRead, 'assertCurrent'> & {
  assertCurrent(
    core: CoreDb,
    input: ControlVaultInput,
    identity: ControlPolicyGrant['policy']
  ): void;
};

/** Preserves the initial stages' actual Core transaction and active publication authority. */
export async function prepareControlVaultRead(
  coreDb: CoreDb,
  input: ControlVaultInput
): Promise<PreparedControlVaultRead | undefined> {
  if (input.kind === 'thread-login-activate' && input.record.loginBinding)
    throw new ControlProductPreconditionError();
  const read = await prepareVaultPolicyRead(coreDb, input);
  if (!read) return undefined;
  return {
    workspaceDb: read.workspaceDb,
    get consumerPackage() {
      return read.consumerPackage;
    },
    sampleHead: read.sampleHead,
    close: read.close,
    assertCurrent(actual, command, publication) {
      if (!actual.sqlite.inTransaction || publication?.state !== 'active' || !publication.identity)
        throw new ControlProductPreconditionError();
      read.assertCurrent(actual, command, {
        serverRevision: publication.identity.serverRevision,
        workspaceRevision:
          publication.identity.workspaceRevisions.find(
            (entry) => entry.workspaceId === read.workspaceDb.workspaceId
          )?.revision ?? null,
      });
    },
  };
}

/** Prepares only operation-local reads; the bridge retains both physical close and return ownership. */
export async function prepareHarnessLoginActivationRead(
  db: WorkspaceDb,
  input: Extract<ControlVaultInput, { kind: 'thread-login-activate' }>,
  coreDb: CoreDb
): Promise<PreparedHarnessLoginActivationRead> {
  const { record } = input;
  const binding = record.loginBinding;
  if (
    !record.replacement ||
    !binding ||
    !binding.policyProof ||
    db.sqlite.inTransaction ||
    coreDb.sqlite.inTransaction ||
    !coreDb.sqlite.readonly ||
    db.dataRoot !== coreDb.dataRoot ||
    db.workspaceId !== record.context.workspaceId ||
    !isDeepStrictEqual(record.replacement, binding.replacement) ||
    !isDeepStrictEqual(record.context, record.replacement.context) ||
    binding.binding.consumer.snapshotId !== record.context.packageSnapshotId ||
    binding.binding.consumer.scope.workspaceId !== record.context.workspaceId ||
    binding.binding.consumer.scope.threadId !== record.context.threadId ||
    binding.binding.consumer.scope.turnId !== record.context.turnId ||
    binding.binding.consumer.scope.agentSessionId !== record.context.agentSessionId ||
    binding.attemptId !== record.context.leaseId ||
    binding.planId !== record.planId ||
    binding.receiptId !== record.receiptId ||
    binding.reference.referenceId !== record.referenceId ||
    binding.binding.declaration.vaultGrantId !== record.grantId ||
    binding.binding.materialVersion !== record.materialGeneration ||
    binding.reference.currentVersion !== record.materialGeneration ||
    binding.reference.login?.accountId !== record.accountId
  )
    throw new ControlProductPreconditionError();
  const read = await prepareVaultPolicyRead(coreDb, input, db);
  if (!read) throw new ControlProductPreconditionError();
  return {
    kind: 'login-activation',
    coreDb,
    get consumerPackage() {
      return read.consumerPackage;
    },
    sampleHead: read.sampleHead,
    close: read.close,
    assertCurrent(actual, command, policy) {
      if (actual !== db || !db.sqlite.inTransaction || coreDb.sqlite.inTransaction)
        throw new ControlProductPreconditionError();
      read.assertCurrent(coreDb, command, policy);
    },
  };
}

type SourceSample =
  | { readonly value: ReturnType<typeof readRuntimeConfigPolicySource> }
  | { readonly error: unknown };

/** Captures source errors without revoking unrelated last-known-good loaded Policy. */
function sampleSource(
  dataRoot: string,
  owner: Parameters<typeof readRuntimeConfigPolicySource>[1]
): SourceSample {
  try {
    return { value: readRuntimeConfigPolicySource(dataRoot, owner) };
  } catch (error) {
    return { error };
  }
}

/** Repeats the existing native regular-file/canonical-parent binding without a new physical owner. */
function databaseIdentity(path: string, sqlite?: CoreDb['sqlite']): string {
  if (sqlite && (!sqlite.open || resolve(sqlite.name) !== resolve(path)))
    throw new ControlProductPreconditionError();
  const file = lstatSync(path);
  if (!file.isFile() || realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new ControlProductPreconditionError();
  return `${file.dev}:${file.ino}`;
}

/**
 * Prepares initial Login stages and exact Core-confirmed quarantine. Missing Login Policy proof refuses;
 * absent Login binding remains with the canonical native Login discriminator and its ordinary refusal.
 * All immutable history and source I/O ends before assertCurrent. No snapshot supplies loaded authority.
 */
async function prepareVaultPolicyRead(
  coreDb: CoreDb,
  input: ControlVaultInput,
  committingWorkspace?: WorkspaceDb
): Promise<PreparedVaultPolicyRead | undefined> {
  const parsed = ControlVaultInputSchema.parse(input);
  const quarantine =
    parsed.kind === 'reference-login-state' && 'coreConfirmedQuarantine' in parsed.record
      ? parsed.record.coreConfirmedQuarantine
      : undefined;
  const kind = parsed.kind;
  const binding =
    kind === 'reference-advance' || kind === 'receipt-create' || kind === 'thread-login-activate'
      ? parsed.record.loginBinding
      : quarantine?.binding;
  if (!binding) return undefined;
  if (
    quarantine &&
    parsed.kind === 'reference-login-state' &&
    parsed.record.referenceId !== binding.reference.referenceId
  )
    throw new ControlProductPreconditionError();
  if (
    kind !== 'reference-advance' &&
    kind !== 'receipt-create' &&
    kind !== 'reference-login-state' &&
    kind !== 'thread-login-activate'
  )
    throw new ControlProductPreconditionError();
  if ((kind === 'thread-login-activate') !== (committingWorkspace !== undefined))
    throw new ControlProductPreconditionError();
  const { proof } = PolicyInterception.readVaultBindingIntent(kind, binding);
  const connection = coreDb.sqlite;
  const dataRoot = coreDb.dataRoot;
  if (coreDb.scope !== 'core' || !connection.open || connection.inTransaction)
    throw new ControlProductPreconditionError();
  const consumer = binding.binding.consumer;
  const workspaceId = consumer.scope.workspaceId;
  const corePath = nativeProductScope(dataRoot, { kind: 'server' }).path;
  const coreIdentity = databaseIdentity(corePath, connection);
  const located = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
  const workspaceIdentity = databaseIdentity(located.path);
  if (
    committingWorkspace &&
    (committingWorkspace.workspaceId !== workspaceId ||
      committingWorkspace.dataRoot !== dataRoot ||
      committingWorkspace.sqlite.inTransaction)
  )
    throw new ControlProductPreconditionError();
  const reader = openControlStoreProductReadHandle(
    located.path,
    located.owner,
    committingWorkspace?.sqlite
  );
  const workspaceDb =
    committingWorkspace ?? bindWorkspaceSqlite(reader.sqlite, dataRoot, workspaceId);
  const scope = { ...located, sqlite: reader.sqlite };
  const histories: Array<{ turnId: string; read: PreparedNativeTurnHistoryRead }> = [];
  let initialReplacement: HarnessLoginReplacementRead | undefined;
  let replacementRead: HarnessLoginReplacementRead | undefined;
  let closed = false;
  let userRead: { db: UserDb; path: string; identity: string } | undefined;
  let head: { server: SourceSample; workspace: SourceSample } | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    head = undefined;
    histories.length = 0;
    try {
      userRead?.db.sqlite.close();
    } finally {
      reader.close();
    }
  };
  const assertOpen = () => {
    if (
      closed ||
      !connection.open ||
      !reader.sqlite.open ||
      (userRead !== undefined && !userRead.db.sqlite.open) ||
      coreDb.scope !== 'core' ||
      coreDb.sqlite !== connection ||
      coreDb.dataRoot !== dataRoot
    )
      throw new ControlProductPreconditionError();
  };
  const metadata = (turnId: string) => {
    const value = readNativeProduct(scope, 'turn', turnId, reader);
    if (!value) throw new ControlProductPreconditionError();
    const {
      schemaVersion: _header,
      captureCoverage: _coverage,
      requiredFeatures: _features,
      items: _items,
      ...turn
    } = StoredTurnV1Schema.parse(value.record);
    return turn;
  };
  const store: GoalTaskPolicyReadPort &
    Omit<ThreadVisibilityReadPort, 'getWorkspaceResourceAccess'> & {
      getTurnById: typeof metadata;
    } = {
    personalWorkspaceCore: coreDb,
    getDataRoot: () => dataRoot,
    getWorkspace(id) {
      if (id !== workspaceId) throw new ControlProductPreconditionError();
      const value = readNativeProduct(scope, 'workspace', id, reader);
      if (!value) throw new ControlProductPreconditionError();
      return WorkspaceSystemRecordSchema.parse(value.record);
    },
    getThread(id, threadId) {
      if (id !== workspaceId) throw new ControlProductPreconditionError();
      const value = readNativeProduct(scope, 'thread', threadId, reader);
      if (!value) throw new ControlProductPreconditionError();
      return value.record as z.infer<typeof ThreadSchema>;
    },
    getTurnMetadata(id, threadId, turnId) {
      const turn = metadata(turnId);
      if (id !== workspaceId || turn.threadId !== threadId)
        throw new ControlProductPreconditionError();
      return turn;
    },
    getTurnById: metadata,
    getTurn(id, threadId, turnId) {
      if (id !== workspaceId) throw new ControlProductPreconditionError();
      const prepared = histories.find((value) => value.turnId === turnId);
      if (!prepared) throw new ControlProductPreconditionError();
      const turn = prepared.read.readCurrent();
      if (turn.threadId !== threadId) throw new ControlProductPreconditionError();
      return turn;
    },
  };
  try {
    if (quarantine) {
      const ownerId = binding.reference.userId;
      if (!ownerId || binding.reference.ownerScope !== 'user')
        throw new ControlProductPreconditionError();
      const path = userDbPath(dataRoot, ownerId);
      const identity = databaseIdentity(path);
      const db = openUserReadDb(dataRoot, ownerId);
      userRead = { db, path, identity };
      if (
        databaseIdentity(path, db.sqlite) !== identity ||
        !db.sqlite.readonly ||
        db.sqlite.pragma('query_only', { simple: true }) !== 1
      )
        throw new ControlProductPreconditionError();
    }
    if (
      databaseIdentity(located.path, reader.sqlite) !== workspaceIdentity ||
      !reader.get('workspace', workspaceId)
    )
      throw new ControlProductPreconditionError();
    const caller = proof.caller;
    const consumerRecord = requireAgentEnvironmentPackageSnapshot(
      workspaceDb,
      workspaceId,
      consumer.snapshotId
    );
    if (binding.replacement)
      initialReplacement = assertHarnessLoginReplacement(
        coreDb,
        workspaceDb,
        consumerRecord.snapshot,
        binding.replacement
      );
    const callerRecord =
      caller.kind === 'worker'
        ? caller.lineage.packageSnapshotId === consumer.snapshotId
          ? consumerRecord
          : requireAgentEnvironmentPackageSnapshot(
              workspaceDb,
              workspaceId,
              caller.lineage.packageSnapshotId
            )
        : null;
    const callerPackage = callerRecord?.snapshot ?? null;
    if (
      caller.kind === 'worker' &&
      (!callerPackage ||
        caller.lineage.workspaceId !== workspaceId ||
        callerPackage.scope.workspaceId !== workspaceId ||
        callerPackage.scope.threadId !== caller.lineage.threadId ||
        callerPackage.scope.turnId !== caller.lineage.turnId ||
        callerPackage.scope.agentSessionId !== caller.lineage.agentSessionId ||
        callerPackage.snapshotId !== caller.lineage.packageSnapshotId)
    )
      throw new ControlProductPreconditionError();
    const lineages =
      caller.kind === 'worker'
        ? [caller.lineage]
        : caller.kind === 'coordinator'
          ? [{ ...consumer.scope, packageSnapshotId: consumer.snapshotId }]
          : [];
    for (const lineage of lineages) {
      const original = requiredTaskTurn({ coreDb, db: workspaceDb, lineage });
      if (!original) continue;
      for (const turnId of [lineage.turnId, original.turnId]) {
        if (histories.some((value) => value.turnId === turnId)) continue;
        const read = await prepareNativeTurnHistoryRead(scope, turnId);
        if (!read) throw new ControlProductPreconditionError();
        histories.push({ turnId, read });
      }
    }
    assertOpen();
    return Object.freeze({
      workspaceDb,
      get consumerPackage() {
        return structuredClone(consumerRecord.snapshot);
      },
      close,
      sampleHead() {
        head = undefined;
        assertOpen();
        if (
          connection.inTransaction ||
          reader.sqlite.inTransaction ||
          (userRead !== undefined &&
            (userRead.db.sqlite.inTransaction ||
              databaseIdentity(userRead.path, userRead.db.sqlite) !== userRead.identity)) ||
          databaseIdentity(corePath, connection) !== coreIdentity ||
          databaseIdentity(located.path, reader.sqlite) !== workspaceIdentity
        )
          throw new ControlProductPreconditionError();
        replacementRead = undefined;
        const server = sampleSource(dataRoot, { kind: 'server' });
        const workspace = sampleSource(dataRoot, { kind: 'workspace', workspaceId });
        // The canonical immutable owner repeats its complete validation before SQL.
        // A changed package refuses rather than refreshing this request's original intent.
        if (
          !isDeepStrictEqual(
            requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, consumer.snapshotId),
            consumerRecord
          ) ||
          (caller.kind === 'worker' &&
            caller.lineage.packageSnapshotId !== consumer.snapshotId &&
            !isDeepStrictEqual(
              requireAgentEnvironmentPackageSnapshot(
                workspaceDb,
                workspaceId,
                caller.lineage.packageSnapshotId
              ),
              callerRecord
            ))
        )
          throw new ControlProductPreconditionError();
        if (
          databaseIdentity(corePath, connection) !== coreIdentity ||
          databaseIdentity(located.path, reader.sqlite) !== workspaceIdentity ||
          (userRead !== undefined &&
            databaseIdentity(userRead.path, userRead.db.sqlite) !== userRead.identity)
        )
          throw new ControlProductPreconditionError();
        if (binding.replacement) {
          const current = assertHarnessLoginReplacement(
            coreDb,
            workspaceDb,
            consumerRecord.snapshot,
            binding.replacement
          );
          if (!isDeepStrictEqual(current, initialReplacement))
            throw new ControlProductPreconditionError();
          replacementRead = current;
        }
        head = { server, workspace };
      },
      assertCurrent(
        actualCore: CoreDb,
        actualInput: ControlVaultInput,
        policyIdentity: ControlPolicyGrant['policy']
      ) {
        assertOpen();
        const sampled = head;
        head = undefined;
        if (
          !sampled ||
          actualCore.scope !== 'core' ||
          actualCore.sqlite !== connection ||
          actualCore.dataRoot !== dataRoot ||
          actualInput !== input ||
          !isDeepStrictEqual(ControlVaultInputSchema.parse(actualInput), parsed)
        )
          throw new ControlProductPreconditionError();
        PolicyInterception.assertVaultRead({
          coreDb: actualCore,
          workspaceDb,
          kind,
          binding,
          ...(quarantine && userRead ? { quarantine, userDb: userRead.db } : {}),
          callerPackage,
          store,
          sampled,
          policyIdentity,
        });
        if (binding.replacement) {
          if (
            !replacementRead ||
            !isDeepStrictEqual(
              readHarnessLoginThreadSessions(workspaceDb, consumer.scope.threadId),
              replacementRead.sessions
            )
          )
            throw new ControlProductPreconditionError();
          assertPreparedHarnessLoginReplacement(
            actualCore,
            workspaceDb,
            consumerRecord.snapshot,
            binding.replacement,
            replacementRead
          );
          requireReleasedLoginPredecessor(
            actualCore,
            binding.replacement,
            replacementRead,
            consumerRecord.snapshot,
            new Date().toISOString()
          );
          PolicyInterception.assertVaultStorageAudience(
            actualCore,
            workspaceDb,
            consumerRecord.snapshot,
            proof.workspaceDocument
          );
        }
      },
    });
  } catch (error) {
    close();
    throw error;
  }
}
