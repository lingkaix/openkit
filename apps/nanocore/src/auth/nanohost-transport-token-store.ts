import { allocateEntityId } from '@openkit/protocol';
import { OperationError } from '../operation-error.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { AdmittedNanoHostTransportStorage } from '../storage/nanohost-transport-owner.js';
import type { StorageResult } from '../storage/storage-owner.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type { Actor } from './identity.js';
import {
  type ControlNanoHostTransportInput,
  ControlNanoHostTransportInputSchema,
  type ControlNanoHostTransportResult,
  type NanoHostTransportTokenRow,
  nanoHostTransportAdminFacts,
  readNanoHostTransportTokenRecord,
} from './nanohost-transport-codecs.js';
import {
  createOpenKitAccessTokenSecret,
  evaluateNanoHostTransportTokenUsability,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  NANOHOST_TRANSPORT_TOKEN_SCOPE,
  NANOHOST_TRANSPORT_TOKEN_TYPE,
  type NanoHostTransportTokenStatus,
  verifyOpenKitAccessTokenSecret,
} from './nanohost-transport-token.js';

/** Input for creating one durable NanoHost transport Token record. */
export interface CreateNanoHostTransportTokenRecordInput {
  /** Configured NanoHost IntegrationIdentity id that owns the token. */
  ownerNanoHostIdentityId: string;
  /** Declared deployment binding. */
  deploymentId: string;
  /** Server-admin actor that authorized issuance. */
  responsibleServerAdminActorId: string;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Current time. */
  now?: Date;
  /** Optional deterministic token id for tests. */
  tokenId?: string;
  /** Optional deterministic token secret for tests. */
  secret?: string;
  /** Previous token id when this token replaces an older token. */
  predecessorTokenId?: string | null;
}

/** Input for atomically persisting the configured identity and its delivered first Token. */
export interface EnrollNanoHostTransportIdentityInput
  extends CreateNanoHostTransportTokenRecordInput {
  /** Pre-generated token id whose secret was delivered to the configured sink. */
  tokenId: string;
  /** Pre-generated token secret whose configured sink write was proved. */
  secret: string;
}

/** Newly issued NanoHost transport Token. */
export interface NanoHostTransportTokenIssueResult {
  /** Durable token id. */
  tokenId: string;
  /** Plaintext token secret returned exactly once by the caller. */
  secret: string;
  /** Redacted durable record created for the token. */
  record: NanoHostTransportTokenRecord;
}

/** Input for rotating one durable NanoHost transport Token record. */
export interface RotateNanoHostTransportTokenRecordInput {
  /** Overlap window in seconds for the predecessor token. */
  overlapSeconds: number;
  /** Current time. */
  now?: Date;
}

/** Newly issued token plus the rotated predecessor record. */
export interface NanoHostTransportTokenRotationResult extends NanoHostTransportTokenIssueResult {
  /** Redacted predecessor record after rotation. */
  rotatedRecord: NanoHostTransportTokenRecord;
}

/** Redacted durable NanoHost transport Token record. */
export interface NanoHostTransportTokenRecord {
  /** Durable token id. */
  tokenId: string;
  /** Configured NanoHost IntegrationIdentity id that owns the token. */
  ownerNanoHostIdentityId: string;
  /** Closed token type. */
  tokenType: typeof NANOHOST_TRANSPORT_TOKEN_TYPE;
  /** Closed token scope. */
  scope: typeof NANOHOST_TRANSPORT_TOKEN_SCOPE;
  /** Declared deployment binding. */
  deploymentId: string;
  /** Token lifecycle status. */
  status: NanoHostTransportTokenStatus;
  /** Issue timestamp. */
  issuedAt: string;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Revocation timestamp. */
  revokedAt: string | null;
  /** Previous token id for rotated tokens. */
  predecessorTokenId: string | null;
  /** Rotation overlap expiry. */
  rotationOverlapExpiresAt: string | null;
  /** Server-admin actor that authorized issuance. */
  responsibleServerAdminActorId: string;
  /** Last successful use timestamp. */
  lastUsedAt: string | null;
  /** Last successful use channel. */
  lastUsedChannel: string | null;
  /** Last successful use source summary. */
  lastUsedSource: string | null;
}

/** Verified durable NanoHost transport Token record. */
export type VerifiedNanoHostTransportTokenRecord = NanoHostTransportTokenRecord;

type NanoHostTransportReadDb = { readonly sqlite: Pick<CoreDb['sqlite'], 'prepare'> };
type NanoHostTransportMutationStorage = CoreDb | AdmittedNanoHostTransportStorage;
interface PreparedNanoHostTransportWriter {
  submit(input: ControlNanoHostTransportInput): Promise<ControlNanoHostTransportResult>;
}

type TransportVerificationOptions = { channel?: string; now?: Date; source?: string };

/** Admits the owner before submission so an open failure carries no credential-commit uncertainty. */
export async function prepareNanoHostTransportWriter(
  storage: NanoHostTransportMutationStorage
): Promise<PreparedNanoHostTransportWriter> {
  if ('owner' in storage) {
    if (storage.owner.read(() => undefined).state !== 'ready')
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    return {
      async submit(input) {
        const local = ControlNanoHostTransportInputSchema.parse(input);
        if (
          local.kind === 'lifecycle-audit' ||
          local.kind === 'decommission-audit' ||
          ('actor' in local && local.actor)
        )
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        return storage.owner.transport(local);
      },
    };
  }
  const coreDb = storage;
  if (!coreDb.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    create: false,
    initialize: 'core',
    dataRoot: coreDb.dataRoot,
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  if (!coreDb.sqlite.open) throw new ControlStoreWorkerError('precondition', 'not-committed');
  return { submit: (input) => client.nanoHostTransport(database, input) };
}

/** Reads the existing storage certainty before a public error projection can hide its cause. */
export function nanoHostTransportCommitState(error: unknown) {
  const original = error instanceof OperationError ? error.cause : error;
  return original instanceof ControlStoreWorkerError ? original.commit : undefined;
}

/** Projects only existing current-admin facts; trusted callers and cleanup omit this argument. */
function adminFacts(actor?: Actor) {
  return actor ? { actor: nanoHostTransportAdminFacts(actor) } : {};
}

/** Keeps the finite reply discriminator checked without a post-ACK database reread. */
function nativeResult<K extends ControlNanoHostTransportResult['kind']>(
  value: ControlNanoHostTransportResult,
  kind: K
): Extract<ControlNanoHostTransportResult, { kind: K }> {
  if (value.kind !== kind) throw new Error('NanoHost native result has an unexpected form.');
  return value as Extract<ControlNanoHostTransportResult, { kind: K }>;
}

/** Submits one complete domain stage after opening the existing owner. */
async function commitNanoHostTransportStage(
  storage: NanoHostTransportMutationStorage,
  input: ControlNanoHostTransportInput,
  beforeSubmit?: () => Promise<void>
) {
  const admitted = ControlNanoHostTransportInputSchema.parse(input);
  const writer = await prepareNanoHostTransportWriter(storage);
  await beforeSubmit?.();
  return writer.submit(admitted);
}

/** Copies an explicit caller clock before waits while retaining the live omitted-clock semantics. */
function explicitClock(now?: Date) {
  return now ? { now: new Date(now.getTime()) } : {};
}

/** Prepares only the existing hash and issuance facts; plaintext stays with the Main caller. */
function issuanceFacts(
  input: CreateNanoHostTransportTokenRecordInput,
  tokenId: string,
  secret: string
) {
  return {
    tokenId,
    tokenHash: hashOpenKitAccessTokenSecret(secret),
    ownerNanoHostIdentityId: input.ownerNanoHostIdentityId,
    deploymentId: input.deploymentId,
    responsibleServerAdminActorId: input.responsibleServerAdminActorId,
    expiresAt: input.expiresAt,
    ...(input.predecessorTokenId === undefined
      ? {}
      : { predecessorTokenId: input.predecessorTokenId }),
    ...explicitClock(input.now),
  };
}

/** Creates one native-owned Token and pairs the acknowledged original row with its one-time Main secret. */
export async function createNanoHostTransportTokenRecord(
  storage: NanoHostTransportMutationStorage,
  input: CreateNanoHostTransportTokenRecordInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenIssueResult> {
  const tokenId = input.tokenId ?? allocateEntityId('nhtok');
  const secret = input.secret ?? createOpenKitAccessTokenSecret();
  const result = await commitNanoHostTransportStage(
    storage,
    { kind: 'issue', record: issuanceFacts(input, tokenId, secret), ...adminFacts(actor) },
    beforeSubmit
  );
  const record = nativeResult(result, 'record').record;
  if (!record) throw new Error('NanoHost transport token record was not created.');
  return { record, secret, tokenId };
}

/** Shared enrollment submission; its caller has already distinguished native-open failure. */
export async function submitNanoHostTransportEnrollment(
  writer: PreparedNanoHostTransportWriter,
  input: EnrollNanoHostTransportIdentityInput,
  actor?: Actor
): Promise<NanoHostTransportTokenIssueResult> {
  const tokenId = input.tokenId;
  const secret = input.secret;
  const result = await writer.submit({
    kind: 'enroll',
    record: issuanceFacts(input, tokenId, secret),
    ...adminFacts(actor),
  });
  const record = nativeResult(result, 'record').record;
  if (!record) throw new Error('NanoHost transport token record was not created.');
  return { record, secret, tokenId };
}

/** Atomically enrolls or reactivates the exact identity and first Token through the existing native owner. */
export async function enrollNanoHostTransportIdentity(
  storage: NanoHostTransportMutationStorage,
  input: EnrollNanoHostTransportIdentityInput,
  actor?: Actor
): Promise<NanoHostTransportTokenIssueResult> {
  const snapshot = { ...input, ...explicitClock(input.now) };
  const authority = actor ? { ...actor } : undefined;
  return submitNanoHostTransportEnrollment(
    await prepareNanoHostTransportWriter(storage),
    snapshot,
    authority
  );
}

/** Proves the presented secret on Main, then repeats its exact current hash/owner/usability inside native last-use SQL. */
export async function verifyNanoHostTransportTokenRecord(
  storage: NanoHostTransportMutationStorage,
  secret: string,
  options: TransportVerificationOptions = {}
): Promise<VerifiedNanoHostTransportTokenRecord | null> {
  const admitted =
    'owner' in storage
      ? storage.owner.read((sqlite) =>
          prepareNanoHostTransportVerification({ sqlite }, secret, options)
        )
      : {
          state: 'ready' as const,
          value: prepareNanoHostTransportVerification(storage, secret, options),
        };
  if (admitted.state !== 'ready')
    throw new ControlStoreWorkerError('precondition', 'not-committed');
  const input = admitted.value;
  if (!input) return null;
  return nativeResult(await commitNanoHostTransportStage(storage, input), 'record').record;
}

/** Prepares the hash-only writer tuple from the exact admitted token and active identity. */
export function prepareNanoHostTransportVerification(
  owner: NanoHostTransportReadDb,
  secret: string,
  options: TransportVerificationOptions = {}
): Extract<ControlNanoHostTransportInput, { kind: 'verify' }> | null {
  if (!isOpenKitAccessTokenSecret(secret)) return null;
  const tokenHash = hashOpenKitAccessTokenSecret(secret);
  const row = owner.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_hash = ?')
    .get(tokenHash) as NanoHostTransportTokenRow | undefined;
  if (
    !row ||
    !verifyOpenKitAccessTokenSecret(secret, row.token_hash) ||
    row.token_type !== NANOHOST_TRANSPORT_TOKEN_TYPE ||
    row.scope !== NANOHOST_TRANSPORT_TOKEN_SCOPE ||
    !isNanoHostTransportIdentityActive(owner, row.owner_nanohost_identity_id, row.deployment_id) ||
    !evaluateNanoHostTransportTokenUsability(
      {
        expiresAt: row.expires_at,
        rotationOverlapExpiresAt: row.rotation_overlap_expires_at,
        status: row.status,
      },
      options.now
    ).usable
  )
    return null;
  return { kind: 'verify', tokenHash, ...options, ...explicitClock(options.now) };
}

/** Revokes one Token in native SQL; repeated/missing results retain their original full-row semantics. */
export async function revokeNanoHostTransportTokenRecord(
  storage: NanoHostTransportMutationStorage,
  tokenId: string,
  options: { now?: Date } = {},
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenRecord | null> {
  const snapshot = { ...explicitClock(options.now) };
  const authority = actor ? { ...actor } : undefined;
  const writer = await prepareNanoHostTransportWriter(storage);
  await beforeSubmit?.();
  return submitNanoHostTransportRevocation(writer, tokenId, snapshot, authority);
}

/** Submits only the revocation stage, so open/admission uncertainty cannot be mistaken for its commit. */
export async function submitNanoHostTransportRevocation(
  writer: PreparedNanoHostTransportWriter,
  tokenId: string,
  options: { now?: Date } = {},
  actor?: Actor
): Promise<NanoHostTransportTokenRecord | null> {
  return nativeResult(
    await writer.submit({
      kind: 'revoke',
      tokenId,
      ...explicitClock(options.now),
      ...adminFacts(actor),
    }),
    'record'
  ).record;
}

/** Rotates the original two-row tuple atomically without moving its one-time secret into the worker wire. */
export async function rotateNanoHostTransportTokenRecord(
  storage: NanoHostTransportMutationStorage,
  tokenId: string,
  input: RotateNanoHostTransportTokenRecordInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenRotationResult | null> {
  const successorTokenId = allocateEntityId('nhtok');
  const secret = createOpenKitAccessTokenSecret();
  const result = nativeResult(
    await commitNanoHostTransportStage(
      storage,
      {
        kind: 'rotate',
        tokenId,
        successorTokenId,
        successorTokenHash: hashOpenKitAccessTokenSecret(secret),
        ...input,
        ...explicitClock(input.now),
        ...adminFacts(actor),
      },
      beforeSubmit
    ),
    'rotation'
  ).result;
  return result ? { ...result, tokenId: successorTokenId, secret } : null;
}

/** Submits the existing all-Token plus identity tuple after preparation has settled. */
export async function submitNanoHostTransportDecommission(
  writer: PreparedNanoHostTransportWriter,
  input: { identityId: string; deploymentId: string; now?: Date },
  actor?: Actor
): Promise<NanoHostTransportTokenRecord[]> {
  return nativeResult(
    await writer.submit({
      kind: 'decommission',
      ...input,
      ...explicitClock(input.now),
      ...adminFacts(actor),
    }),
    'decommission'
  ).records;
}

/** Keeps the original cutover conditional so an already revoked predecessor cannot be revived. */
export async function completeNanoHostTransportTokenCutover(
  storage: NanoHostTransportMutationStorage,
  predecessorTokenId: string,
  options: { now?: Date } = {}
): Promise<NanoHostTransportTokenRecord | null> {
  return nativeResult(
    await commitNanoHostTransportStage(storage, {
      kind: 'cutover',
      tokenId: predecessorTokenId,
      ...options,
      ...explicitClock(options.now),
    }),
    'record'
  ).record;
}

/** Atomically revokes the successor and restores the predecessor before any external cleanup. */
export async function abortNanoHostTransportTokenRotation(
  storage: NanoHostTransportMutationStorage,
  input: { predecessorTokenId: string; successorTokenId: string; now?: Date },
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<{
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null> {
  const snapshot = { ...input, ...explicitClock(input.now) };
  const authority = actor ? { ...actor } : undefined;
  const writer = await prepareNanoHostTransportWriter(storage);
  await beforeSubmit?.();
  return submitNanoHostTransportRotationAbort(writer, snapshot, authority);
}

/** Submits only the original abort tuple, preserving uncertainty until pending-process cleanup is decided. */
export async function submitNanoHostTransportRotationAbort(
  writer: PreparedNanoHostTransportWriter,
  input: { predecessorTokenId: string; successorTokenId: string; now?: Date },
  actor?: Actor
): Promise<{
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null> {
  return nativeResult(
    await writer.submit({
      kind: 'abort',
      ...input,
      ...explicitClock(input.now),
      ...adminFacts(actor),
    }),
    'abort'
  ).result;
}

/** Commits only the two existing successful Audit forms as their original separately awaited stage. */
export async function recordNanoHostTransportAudit(
  coreDb: CoreDb,
  input: Extract<ControlNanoHostTransportInput, { kind: 'lifecycle-audit' | 'decommission-audit' }>
): Promise<void> {
  nativeResult(await commitNanoHostTransportStage(coreDb, input), 'audit');
}

/** Existing Main read; this function has no mutation or post-ACK reconstruction. */
export function isNanoHostTransportIdentityActive(
  owner: NanoHostTransportReadDb,
  identityId: string,
  deploymentId: string
): boolean {
  return Boolean(
    owner.sqlite
      .prepare(
        `SELECT 1 FROM nanohost_integration_identities
         WHERE identity_id = ? AND deployment_id = ? AND status = 'active'`
      )
      .get(identityId, deploymentId)
  );
}

/** Injected credential inventory read bound to the admitted NanoHost owner. */
export type NanoHostTransportTokenReader = () => StorageResult<
  'nanohost',
  readonly NanoHostTransportTokenRecord[]
>;

/** Reads the redacted inventory on the caller's already admitted owner handle. */
export function listNanoHostTransportTokenRecords(
  owner: NanoHostTransportReadDb
): NanoHostTransportTokenRecord[] {
  const rows = owner.sqlite
    .prepare(`SELECT token_id, owner_nanohost_identity_id, token_type, scope, deployment_id,
      status, issued_at, expires_at, revoked_at, predecessor_token_id,
      rotation_overlap_expires_at, responsible_server_admin_actor_id,
      last_used_at, last_used_channel, last_used_source
      FROM nanohost_transport_tokens ORDER BY issued_at DESC, token_id DESC`)
    .all() as Omit<NanoHostTransportTokenRow, 'token_hash'>[];

  return rows.map(readNanoHostTransportTokenRecord);
}

/** Existing Main read; this function has no mutation or post-ACK reconstruction. */
export function getNanoHostTransportTokenRecord(
  owner: NanoHostTransportReadDb,
  tokenId: string
): NanoHostTransportTokenRecord | null {
  const row = owner.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_id = ?')
    .get(tokenId) as NanoHostTransportTokenRow | undefined;

  return row ? readNanoHostTransportTokenRecord(row) : null;
}
