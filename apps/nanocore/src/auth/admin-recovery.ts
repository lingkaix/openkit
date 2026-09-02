import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { recordServerAuditEvent } from '../audit-events.js';
import { acquireDataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { type CoreDb, openExistingCoreDbWithIntegrityCheck } from '../storage/db.js';
import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
} from './access-token.js';
import { createOpenKitAccessTokenRecord } from './access-token-store.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

const MAX_RECOVERY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_RECOVERY_ENVELOPE_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOVERY_ENVELOPE_KEYS = [
  'expiresAt',
  'kind',
  'ownerUserId',
  'requestId',
  'token',
  'tokenId',
] as const;

/** Operator-safe active canonical User projection. */
export interface AdminRecoveryUser {
  /** Stable canonical User id. */
  userId: string;
  /** Normalized canonical email. */
  email: string;
  /** User-facing display name. */
  displayName: string;
}

/** Strict credential envelope published once for stopped-server recovery. */
export interface AdminRecoveryEnvelope {
  /** Envelope discriminator. */
  kind: 'openkit-admin-recovery';
  /** Output-path-owned recovery request id. */
  requestId: string;
  /** Durable OpenKit Token id. */
  tokenId: string;
  /** Active canonical User that owns the Token. */
  ownerUserId: string;
  /** Exact bounded Token expiry. */
  expiresAt: string;
  /** One-time OpenKit access-token secret. */
  token: string;
}

/** Operator-safe completed recovery summary. */
export interface AdminRecoverySummary {
  /** Durable OpenKit Token id. */
  tokenId: string;
  /** Active canonical User that owns the Token. */
  ownerUserId: string;
  /** Exact bounded Token expiry. */
  expiresAt: string;
  /** Immutable server AuditEvent id. */
  auditEventId: string;
  /** Terminal command result. */
  status: 'completed';
}

/** Observable stopped-server recovery phases used only by process-local tests. */
export type OpenKitOperatorPhase =
  | 'locked'
  | 'file-written'
  | 'file-durable'
  | 'file-published'
  | 'transaction-committed';

/** Testable sinks, clock, and crash-boundary observer for the stopped-server operator. */
export interface OpenKitOperatorOptions {
  /** Current wall clock. */
  now?: () => Date;
  /** Standard-output sink. */
  write?: (line: string) => void;
  /** Synchronous phase observer used to inject process-local crash failures. */
  onPhase?: (phase: OpenKitOperatorPhase) => void;
}

/** Safe terminal error surfaced by the local operator executable. */
export class AdminRecoveryError extends Error {
  /** Stable secret-free error code. */
  public readonly code: string;

  /** Creates one secret-free operator failure. */
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'AdminRecoveryError';
    this.code = code;
  }
}

interface RecoveryInput {
  dataRoot: string;
  ownerUserId: string;
  expiresAt: string;
  outputPath: string;
  confirmation: string;
}

interface RecoveryTokenRow {
  token_id: string;
  token_hash: string;
  owner_user_id: string;
  scope: string;
  workspace_ids_json: string;
  status: string;
  expires_at: string;
  revoked_at: string | null;
  predecessor_token_id: string | null;
  rotated_grace_expires_at: string | null;
}

interface RecoveryAuditRow {
  audit_event_id: string;
  workspace_id: string | null;
  protocol_version: string | null;
  thread_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  capability_call_id: string | null;
  permission_decision_id: string | null;
  vault_grant_id: string | null;
  request_id: string | null;
  actor_json: string | null;
  subject_json: string | null;
  agent_id: string | null;
  agent_session_id: string | null;
  category: string;
  action: string;
  resource: string | null;
  outcome: string;
  severity: string;
  summary: string;
  error_code: string | null;
  resource_revision: number | null;
}

/** Runs one stopped-server OpenKit operator command. */
export function runOpenKitOperatorCli(
  argv: readonly string[],
  options: OpenKitOperatorOptions = {}
): readonly AdminRecoveryUser[] | AdminRecoverySummary {
  if (argv[0] === 'admin' && argv[1] === 'recovery-users') {
    const flags = parseFlags(argv.slice(2), ['--data-root']);
    const dataRoot = requireAbsolutePath(flags['--data-root']!, 'data-root');

    return runLocked(
      dataRoot,
      options,
      (coreDb) =>
        coreDb.sqlite
          .prepare(
            `SELECT id AS userId, lower(trim(email)) AS email, display_name AS displayName
           FROM users
           WHERE status = 'active'
           ORDER BY id`
          )
          .all() as AdminRecoveryUser[]
    );
  }

  if (argv[0] === 'admin' && argv[1] === 'recover-access') {
    const flags = parseFlags(argv.slice(2), [
      '--data-root',
      '--owner-user-id',
      '--expires-at',
      '--output',
      '--confirm',
    ]);
    const input: RecoveryInput = {
      dataRoot: requireAbsolutePath(flags['--data-root']!, 'data-root'),
      ownerUserId: flags['--owner-user-id']!,
      expiresAt: requireCanonicalInstant(flags['--expires-at']!),
      outputPath: requireAbsolutePath(flags['--output']!, 'output'),
      confirmation: flags['--confirm']!,
    };

    requireRecoveryConfirmation(input);
    return runLocked(input.dataRoot, options, (coreDb) =>
      recoverAdminAccess(coreDb, input, options)
    );
  }

  throw invalidRequest('Unsupported openkit-operator command.');
}

/** Holds the existing data-root lock through database close and stdout completion. */
function runLocked<T>(
  dataRoot: string,
  options: OpenKitOperatorOptions,
  command: (coreDb: CoreDb) => T
): T {
  let lock: ReturnType<typeof acquireDataRootLock>;
  try {
    lock = acquireDataRootLock(dataRoot, { bootId: `operator-${randomUUID()}` });
  } catch (error) {
    if (error instanceof DataRootLockError) {
      throw new AdminRecoveryError('data_root_locked', 'The NanoCore data root is locked.');
    }
    throw error;
  }

  try {
    options.onPhase?.('locked');
    const coreDb = openExistingCoreDbWithIntegrityCheck(dataRoot);
    let result: T;
    try {
      result = command(coreDb);
    } finally {
      coreDb.sqlite.close();
    }
    (options.write ?? ((line) => process.stdout.write(line)))(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    lock.release();
  }
}

/** Creates or exactly resumes one file-first administrator recovery attempt. */
function recoverAdminAccess(
  coreDb: CoreDb,
  input: RecoveryInput,
  options: OpenKitOperatorOptions
): AdminRecoverySummary {
  const now = options.now?.() ?? new Date();
  const expectedRequestId = recoveryRequestId(input.outputPath);
  const expectedTokenId = recoveryTokenId(input.outputPath);
  const ownerIsActive = isCanonicalUserActive(coreDb, input.ownerUserId);
  let fileDescriptor = openExistingRecoveryFile(input.outputPath);
  try {
    if (!ownerIsActive) {
      if (
        fileDescriptor !== null ||
        readRecoveryToken(coreDb, expectedTokenId) ||
        readRecoveryAudits(coreDb, expectedRequestId).length > 0
      ) {
        throw recoveryRequired();
      }
      throw invalidRequest('Administrator recovery requires one active canonical User.');
    }

    let envelope: AdminRecoveryEnvelope;
    if (fileDescriptor === null) {
      assertFirstRecoveryExpiry(input.expiresAt, now);
      envelope = {
        kind: 'openkit-admin-recovery',
        requestId: expectedRequestId,
        tokenId: expectedTokenId,
        ownerUserId: input.ownerUserId,
        expiresAt: input.expiresAt,
        token: createOpenKitAccessTokenSecret(),
      };
      assertRecoveryStateAbsent(coreDb, envelope);
      fileDescriptor = createRecoveryFile(input.outputPath);
      publishRecoveryEnvelope(fileDescriptor, input.outputPath, envelope, options.onPhase);
      options.onPhase?.('file-published');
    } else {
      envelope = readRecoveryEnvelope(fileDescriptor, input.outputPath);
      if (
        envelope.requestId !== expectedRequestId ||
        envelope.tokenId !== expectedTokenId ||
        envelope.ownerUserId !== input.ownerUserId ||
        envelope.expiresAt !== input.expiresAt
      ) {
        throw recoveryRequired();
      }
    }

    const token = readRecoveryToken(coreDb, envelope.tokenId);
    const audits = readRecoveryAudits(coreDb, envelope.requestId);
    if (!token && audits.length === 0) {
      if (!isValidInactiveRecoveryExpiry(envelope.expiresAt, now)) {
        throw recoveryRequired();
      }
      syncRecoveryFile(fileDescriptor, input.outputPath, options.onPhase);
      const summary = commitRecovery(coreDb, envelope, now);
      assertRecoveryFileIdentity(fileDescriptor, input.outputPath);
      options.onPhase?.('transaction-committed');
      return summary;
    }

    if (!token || audits.length !== 1) throw recoveryRequired();
    assertCompletedRecovery(envelope, token, audits[0]!);
    assertRecoveryFileIdentity(fileDescriptor, input.outputPath);
    return recoverySummary(envelope, audits[0]!.audit_event_id);
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
  }
}

/** Commits the pre-published Token and AuditEvent atomically. */
function commitRecovery(
  coreDb: CoreDb,
  envelope: AdminRecoveryEnvelope,
  now: Date
): AdminRecoverySummary {
  const event = coreDb.sqlite.transaction(() => {
    const issue = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: envelope.ownerUserId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: envelope.expiresAt,
      now,
      tokenId: envelope.tokenId,
      secret: envelope.token,
    });
    if (issue.tokenId !== envelope.tokenId || issue.secret !== envelope.token) {
      throw recoveryRequired();
    }

    return recordServerAuditEvent({
      action: 'auth.admin-recovery.issue',
      actor: { id: 'openkit-operator', kind: 'system', responsibleUserId: null },
      category: 'system',
      coreDb,
      occurredAt: now,
      outcome: 'succeeded',
      requestId: envelope.requestId,
      resource: `auth-token:${envelope.tokenId}`,
      severity: 'info',
      subject: { id: envelope.ownerUserId, kind: 'user' },
      summary: recoveryAuditSummary(envelope.expiresAt),
      now,
    });
  })();

  return recoverySummary(envelope, event.id);
}

/** Rejects any pre-existing durable state before first file publication. */
function assertRecoveryStateAbsent(coreDb: CoreDb, envelope: AdminRecoveryEnvelope): void {
  if (
    readRecoveryToken(coreDb, envelope.tokenId) ||
    readRecoveryAudits(coreDb, envelope.requestId).length > 0
  ) {
    throw recoveryRequired();
  }
}

/** Verifies the exact durable state for a completed same-path retry. */
function assertCompletedRecovery(
  envelope: AdminRecoveryEnvelope,
  token: RecoveryTokenRow,
  audit: RecoveryAuditRow
): void {
  if (
    token.token_id !== envelope.tokenId ||
    token.token_hash !== hashOpenKitAccessTokenSecret(envelope.token) ||
    token.owner_user_id !== envelope.ownerUserId ||
    token.scope !== 'server-admin' ||
    token.workspace_ids_json !== '[]' ||
    token.status !== 'active' ||
    token.expires_at !== envelope.expiresAt ||
    token.revoked_at !== null ||
    token.predecessor_token_id !== null ||
    token.rotated_grace_expires_at !== null ||
    audit.workspace_id !== null ||
    audit.protocol_version !== null ||
    audit.thread_id !== null ||
    audit.turn_id !== null ||
    audit.item_id !== null ||
    audit.capability_call_id !== null ||
    audit.permission_decision_id !== null ||
    audit.vault_grant_id !== null ||
    audit.request_id !== envelope.requestId ||
    audit.category !== 'system' ||
    audit.action !== 'auth.admin-recovery.issue' ||
    audit.resource !== `auth-token:${envelope.tokenId}` ||
    audit.outcome !== 'succeeded' ||
    audit.severity !== 'info' ||
    audit.summary !== recoveryAuditSummary(envelope.expiresAt) ||
    audit.error_code !== null ||
    audit.agent_id !== null ||
    audit.agent_session_id !== null ||
    audit.resource_revision !== null ||
    !isExactActor(audit.actor_json, 'system', 'openkit-operator') ||
    !isExactActor(audit.subject_json, 'user', envelope.ownerUserId)
  ) {
    throw recoveryRequired();
  }
}

/** Reads one Token row without exposing it outside the recovery implementation. */
function readRecoveryToken(coreDb: CoreDb, tokenId: string): RecoveryTokenRow | undefined {
  return coreDb.sqlite
    .prepare(
      `SELECT token_id, token_hash, owner_user_id, scope, workspace_ids_json, status,
              expires_at, revoked_at, predecessor_token_id, rotated_grace_expires_at
       FROM openkit_access_tokens
       WHERE token_id = ?`
    )
    .get(tokenId) as RecoveryTokenRow | undefined;
}

/** Reads every AuditEvent that claims one recovery request identity. */
function readRecoveryAudits(coreDb: CoreDb, requestId: string): RecoveryAuditRow[] {
  return coreDb.sqlite
    .prepare(
      `SELECT audit_event_id, workspace_id, protocol_version, thread_id, turn_id, item_id,
              capability_call_id, permission_decision_id, vault_grant_id, request_id,
              actor_json, subject_json, agent_id, agent_session_id, category, action,
              resource, resource_revision, outcome, severity, summary, error_code
       FROM audit_events
       WHERE request_id = ?`
    )
    .all(requestId) as RecoveryAuditRow[];
}

/** Opens an existing non-link recovery file or reports an absent path. */
function openExistingRecoveryFile(path: string): number | null {
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    assertRecoveryFileIdentity(fileDescriptor, path);
    return fileDescriptor;
  } catch (error) {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
    if (isNodeError(error, 'ENOENT')) return null;
    if (error instanceof AdminRecoveryError) throw error;
    throw recoveryRequired();
  }
}

/** Creates the exact recovery path once without following a final symlink. */
function createRecoveryFile(path: string): number {
  try {
    return openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw recoveryRequired();
  }
}

/** Publishes and durably syncs one complete credential envelope. */
function publishRecoveryEnvelope(
  fileDescriptor: number,
  path: string,
  envelope: AdminRecoveryEnvelope,
  onPhase: OpenKitOperatorOptions['onPhase']
): void {
  fchmodSync(fileDescriptor, 0o600);
  writeFileSync(fileDescriptor, `${JSON.stringify(envelope)}\n`, 'utf8');
  onPhase?.('file-written');
  syncRecoveryFile(fileDescriptor, path, onPhase);
}

/** Re-establishes file-first durability before every inactive-envelope commit. */
function syncRecoveryFile(
  fileDescriptor: number,
  path: string,
  onPhase: OpenKitOperatorOptions['onPhase']
): void {
  assertRecoveryFileIdentity(fileDescriptor, path);
  fsyncSync(fileDescriptor);
  assertRecoveryFileIdentity(fileDescriptor, path);

  const parent = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  assertRecoveryFileIdentity(fileDescriptor, path);
  onPhase?.('file-durable');
}

/** Parses one strict bounded UTF-8 credential envelope. */
function readRecoveryEnvelope(fileDescriptor: number, path: string): AdminRecoveryEnvelope {
  assertRecoveryFileIdentity(fileDescriptor, path);
  const buffer = Buffer.alloc(MAX_RECOVERY_ENVELOPE_BYTES + 1);
  const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
  if (bytesRead === 0 || bytesRead > MAX_RECOVERY_ENVELOPE_BYTES) {
    throw recoveryRequired();
  }
  const bytes = buffer.subarray(0, bytesRead);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw recoveryRequired();
  }
  if (!isRecord(value)) throw recoveryRequired();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RECOVERY_ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== RECOVERY_ENVELOPE_KEYS[index]) ||
    value.kind !== 'openkit-admin-recovery' ||
    typeof value.requestId !== 'string' ||
    !UUID_PATTERN.test(value.requestId) ||
    typeof value.tokenId !== 'string' ||
    !UUID_PATTERN.test(value.tokenId) ||
    typeof value.ownerUserId !== 'string' ||
    value.ownerUserId.length === 0 ||
    typeof value.expiresAt !== 'string' ||
    canonicalInstantOrNull(value.expiresAt) === null ||
    typeof value.token !== 'string' ||
    !isOpenKitAccessTokenSecret(value.token)
  ) {
    throw recoveryRequired();
  }
  assertRecoveryFileIdentity(fileDescriptor, path);
  return value as unknown as AdminRecoveryEnvelope;
}

/** Proves that the open descriptor still owns the exact protected output path. */
function assertRecoveryFileIdentity(fileDescriptor: number, path: string): void {
  let descriptor: ReturnType<typeof fstatSync>;
  let target: ReturnType<typeof lstatSync>;
  try {
    descriptor = fstatSync(fileDescriptor);
    target = lstatSync(path);
  } catch {
    throw recoveryRequired();
  }
  if (
    !descriptor.isFile() ||
    !target.isFile() ||
    descriptor.dev !== target.dev ||
    descriptor.ino !== target.ino ||
    descriptor.nlink !== 1 ||
    target.nlink !== 1 ||
    (descriptor.mode & 0o777) !== 0o600 ||
    (target.mode & 0o777) !== 0o600
  ) {
    throw recoveryRequired();
  }
}

/** Requires a valid first-attempt expiry before output mutation. */
function assertFirstRecoveryExpiry(expiresAt: string, now: Date): void {
  if (!isValidInactiveRecoveryExpiry(expiresAt, now)) {
    throw invalidRequest('Recovery expiry must be future and no later than 24 hours.');
  }
}

/** Checks a future recovery expiry through the exact 24-hour boundary. */
function isValidInactiveRecoveryExpiry(expiresAt: string, now: Date): boolean {
  const expiry = Date.parse(expiresAt);
  return expiry > now.getTime() && expiry <= now.getTime() + MAX_RECOVERY_LIFETIME_MS;
}

/** Requires byte-for-byte confirmation of the owner and expiry mutation. */
function requireRecoveryConfirmation(input: RecoveryInput): void {
  if (input.confirmation !== `issue-server-admin-token:${input.ownerUserId}:${input.expiresAt}`) {
    throw invalidRequest('Administrator recovery confirmation does not match.');
  }
}

/** Parses an exact set of required CLI flags in any order. */
function parseFlags(argv: readonly string[], expected: readonly string[]): Record<string, string> {
  if (argv.length !== expected.length * 2) {
    throw invalidRequest('Administrator recovery arguments are incomplete.');
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !expected.includes(flag) || !value || flag in values) {
      throw invalidRequest('Administrator recovery arguments are invalid.');
    }
    values[flag] = value;
  }
  return values;
}

/** Requires one absolute path without echoing it in an error. */
function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw invalidRequest(`Administrator recovery requires an absolute ${label}.`);
  }
  return value;
}

/** Requires the repository's canonical UTC millisecond timestamp form. */
function requireCanonicalInstant(value: string): string {
  if (canonicalInstantOrNull(value) === null) {
    throw invalidRequest('Administrator recovery expiry must be a canonical UTC instant.');
  }
  return value;
}

/** Returns one canonical instant or null without surfacing envelope content. */
function canonicalInstantOrNull(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

/** Derives the unique request UUID from the exact output path without storing the path. */
function recoveryRequestId(outputPath: string): string {
  return recoveryIdentity('request', outputPath);
}

/** Derives the Token UUID from the same unique path under a separate domain. */
function recoveryTokenId(outputPath: string): string {
  return recoveryIdentity('token', outputPath);
}

/** Derives one stable RFC 4122 UUIDv5-shaped identity without storing the path. */
function recoveryIdentity(domain: 'request' | 'token', outputPath: string): string {
  const hash = createHash('sha256')
    .update(`openkit-admin-recovery:${domain}\0`)
    .update(outputPath)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Produces the exact redacted Audit summary that binds recovery expiry. */
function recoveryAuditSummary(expiresAt: string): string {
  return `Local operator issued one server-admin Token expiring at ${expiresAt}.`;
}

/** Produces the only non-secret completion projection. */
function recoverySummary(
  envelope: AdminRecoveryEnvelope,
  auditEventId: string
): AdminRecoverySummary {
  return {
    tokenId: envelope.tokenId,
    ownerUserId: envelope.ownerUserId,
    expiresAt: envelope.expiresAt,
    auditEventId,
    status: 'completed',
  };
}

/** Compares one stored actor or subject reference without relying on JSON key order. */
function isExactActor(json: string | null, kind: 'system' | 'user', id: string): boolean {
  if (!json) return false;
  try {
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value) || value.kind !== kind || value.id !== id) return false;
    return kind === 'system'
      ? value.responsibleUserId === null && Object.keys(value).length === 3
      : Object.keys(value).length === 2;
  } catch {
    return false;
  }
}

/** Checks one unknown parsed JSON value for record access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks one Node filesystem error code. */
function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Creates one stable argument error. */
function invalidRequest(message: string): AdminRecoveryError {
  return new AdminRecoveryError('invalid_request', message);
}

/** Creates the single fail-closed half-state error. */
function recoveryRequired(): AdminRecoveryError {
  return new AdminRecoveryError(
    'recovery_required',
    'Administrator recovery state requires operator inspection.'
  );
}
