import { allocateEntityId } from '@openkit/protocol';
import { OperationError } from '../operation-error.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
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

/** Opens the existing Core native owner; callers retain this distinct pre-submission stage. */
export async function prepareNanoHostTransportWriter(
  coreDb: CoreDb
): Promise<{ client: ReturnType<typeof getControlStoreWorkerClient>; database: string }> {
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
  return { client, database };
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
  coreDb: CoreDb,
  input: ControlNanoHostTransportInput,
  beforeSubmit?: () => Promise<void>
) {
  const admitted = ControlNanoHostTransportInputSchema.parse(input);
  const { client, database } = await prepareNanoHostTransportWriter(coreDb);
  await beforeSubmit?.();
  return client.nanoHostTransport(database, admitted);
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
  coreDb: CoreDb,
  input: CreateNanoHostTransportTokenRecordInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenIssueResult> {
  const tokenId = input.tokenId ?? allocateEntityId('nhtok');
  const secret = input.secret ?? createOpenKitAccessTokenSecret();
  const result = await commitNanoHostTransportStage(
    coreDb,
    { kind: 'issue', record: issuanceFacts(input, tokenId, secret), ...adminFacts(actor) },
    beforeSubmit
  );
  const record = nativeResult(result, 'record').record;
  if (!record) throw new Error('NanoHost transport token record was not created.');
  return { record, secret, tokenId };
}

/** Shared enrollment submission; its caller has already distinguished native-open failure. */
export async function submitNanoHostTransportEnrollment(
  writer: Awaited<ReturnType<typeof prepareNanoHostTransportWriter>>,
  input: EnrollNanoHostTransportIdentityInput,
  actor?: Actor
): Promise<NanoHostTransportTokenIssueResult> {
  const tokenId = input.tokenId;
  const secret = input.secret;
  const result = await writer.client.nanoHostTransport(writer.database, {
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
  coreDb: CoreDb,
  input: EnrollNanoHostTransportIdentityInput,
  actor?: Actor
): Promise<NanoHostTransportTokenIssueResult> {
  const snapshot = { ...input, ...explicitClock(input.now) };
  const authority = actor ? { ...actor } : undefined;
  return submitNanoHostTransportEnrollment(
    await prepareNanoHostTransportWriter(coreDb),
    snapshot,
    authority
  );
}

/** Proves the presented secret on Main, then repeats its exact current hash/owner/usability inside native last-use SQL. */
export async function verifyNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  secret: string,
  options: { channel?: string; now?: Date; source?: string } = {}
): Promise<VerifiedNanoHostTransportTokenRecord | null> {
  if (!isOpenKitAccessTokenSecret(secret)) return null;
  const tokenHash = hashOpenKitAccessTokenSecret(secret);
  const row = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_hash = ?')
    .get(tokenHash) as NanoHostTransportTokenRow | undefined;
  if (
    !row ||
    !verifyOpenKitAccessTokenSecret(secret, row.token_hash) ||
    row.token_type !== NANOHOST_TRANSPORT_TOKEN_TYPE ||
    row.scope !== NANOHOST_TRANSPORT_TOKEN_SCOPE ||
    !isNanoHostTransportIdentityActive(coreDb, row.owner_nanohost_identity_id, row.deployment_id) ||
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
  return nativeResult(
    await commitNanoHostTransportStage(coreDb, {
      kind: 'verify',
      tokenHash,
      ...options,
      ...explicitClock(options.now),
    }),
    'record'
  ).record;
}

/** Revokes one Token in native SQL; repeated/missing results retain their original full-row semantics. */
export async function revokeNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  options: { now?: Date } = {},
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenRecord | null> {
  const snapshot = { ...explicitClock(options.now) };
  const authority = actor ? { ...actor } : undefined;
  const writer = await prepareNanoHostTransportWriter(coreDb);
  await beforeSubmit?.();
  return submitNanoHostTransportRevocation(writer, tokenId, snapshot, authority);
}

/** Submits only the revocation stage, so open/admission uncertainty cannot be mistaken for its commit. */
export async function submitNanoHostTransportRevocation(
  writer: Awaited<ReturnType<typeof prepareNanoHostTransportWriter>>,
  tokenId: string,
  options: { now?: Date } = {},
  actor?: Actor
): Promise<NanoHostTransportTokenRecord | null> {
  return nativeResult(
    await writer.client.nanoHostTransport(writer.database, {
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
  coreDb: CoreDb,
  tokenId: string,
  input: RotateNanoHostTransportTokenRecordInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenRotationResult | null> {
  const successorTokenId = allocateEntityId('nhtok');
  const secret = createOpenKitAccessTokenSecret();
  const result = nativeResult(
    await commitNanoHostTransportStage(
      coreDb,
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
  writer: Awaited<ReturnType<typeof prepareNanoHostTransportWriter>>,
  input: { identityId: string; deploymentId: string; now?: Date },
  actor?: Actor
): Promise<NanoHostTransportTokenRecord[]> {
  return nativeResult(
    await writer.client.nanoHostTransport(writer.database, {
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
  coreDb: CoreDb,
  predecessorTokenId: string,
  options: { now?: Date } = {}
): Promise<NanoHostTransportTokenRecord | null> {
  return nativeResult(
    await commitNanoHostTransportStage(coreDb, {
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
  coreDb: CoreDb,
  input: { predecessorTokenId: string; successorTokenId: string; now?: Date },
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<{
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null> {
  const snapshot = { ...input, ...explicitClock(input.now) };
  const authority = actor ? { ...actor } : undefined;
  const writer = await prepareNanoHostTransportWriter(coreDb);
  await beforeSubmit?.();
  return submitNanoHostTransportRotationAbort(writer, snapshot, authority);
}

/** Submits only the original abort tuple, preserving uncertainty until pending-process cleanup is decided. */
export async function submitNanoHostTransportRotationAbort(
  writer: Awaited<ReturnType<typeof prepareNanoHostTransportWriter>>,
  input: { predecessorTokenId: string; successorTokenId: string; now?: Date },
  actor?: Actor
): Promise<{
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null> {
  return nativeResult(
    await writer.client.nanoHostTransport(writer.database, {
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
  coreDb: CoreDb,
  identityId: string,
  deploymentId: string
): boolean {
  return Boolean(
    coreDb.sqlite
      .prepare(
        `SELECT 1 FROM nanohost_integration_identities
         WHERE identity_id = ? AND deployment_id = ? AND status = 'active'`
      )
      .get(identityId, deploymentId)
  );
}

/** Existing Main read; this function has no mutation or post-ACK reconstruction. */
export function listNanoHostTransportTokenRecords(coreDb: CoreDb): NanoHostTransportTokenRecord[] {
  const rows = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens ORDER BY issued_at DESC, token_id DESC')
    .all() as NanoHostTransportTokenRow[];

  return rows.map(readNanoHostTransportTokenRecord);
}

/** Existing Main read; this function has no mutation or post-ACK reconstruction. */
export function getNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string
): NanoHostTransportTokenRecord | null {
  const row = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_id = ?')
    .get(tokenId) as NanoHostTransportTokenRow | undefined;

  return row ? readNanoHostTransportTokenRecord(row) : null;
}
