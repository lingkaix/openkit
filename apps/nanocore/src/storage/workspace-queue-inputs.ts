import { isMainThread } from 'node:worker_threads';
import { sha256Hex } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import type { WorkInputRef } from './control-kernel-port.js';
import {
  CONTROL_PRODUCT_LIMITS,
  ControlProductPreconditionError,
} from './control-store-product-records.js';
import { openAdmittedWorkspaceReadDb, type WorkspaceDb } from './db.js';

/** The Workspace keeps its bytes under original logical work even before the Turn is published. */
export interface WorkspaceQueueInputScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly originalInvocationId: string;
}

interface WorkspaceQueueInputBody {
  readonly input: WorkInputRef;
  readonly text: string;
}

/** The exact freeze delivery projection and its independently addressable originals. */
export interface WorkspaceQueueInputBatch extends WorkspaceQueueInputScope {
  readonly manifest: WorkspaceQueueInputBody;
  readonly members: readonly WorkspaceQueueInputBody[];
}

interface PreparedWorkspaceQueueInput {
  readonly inputId: string;
  readonly digest: string;
  readonly bytes: Buffer;
}

interface PreparedWorkspaceQueueInputBatch {
  readonly scope: WorkspaceQueueInputScope;
  readonly inputs: readonly PreparedWorkspaceQueueInput[];
}

const inputRow = `SELECT schema_version AS schemaVersion, thread_id AS threadId, turn_id AS turnId,
  invocation_id AS originalInvocationId, input_digest AS digest, input_bytes AS bytes
  FROM workspace_work_inputs WHERE input_id = ?`;

type InputRow = Omit<WorkspaceQueueInputScope, 'workspaceId'> & {
  readonly schemaVersion: number;
  readonly digest: string;
  readonly bytes: Buffer;
};

function requireScope(db: WorkspaceDb, scope: WorkspaceQueueInputScope): void {
  if (
    db.workspaceId !== scope.workspaceId ||
    !scope.threadId ||
    !scope.turnId ||
    !scope.originalInvocationId
  )
    throw new ControlProductPreconditionError();
}

function prepareBody(
  workspaceId: string,
  body: WorkspaceQueueInputBody
): PreparedWorkspaceQueueInput {
  const { input, text } = body;
  if (input.owner.kind !== 'workspace' || input.owner.workspaceId !== workspaceId || !input.inputId)
    throw new ControlProductPreconditionError();
  const length = Buffer.byteLength(text);
  if (length > CONTROL_PRODUCT_LIMITS.immutableBodyBytes)
    throw new ControlProductPreconditionError();
  const bytes = Buffer.from(text);
  if (bytes.toString() !== text || sha256Hex(bytes) !== input.digest)
    throw new ControlProductPreconditionError();
  return { inputId: input.inputId, digest: input.digest, bytes };
}

/** Prepares a start body for the same native writer that will acknowledge its original identity. */
export function prepareWorkspaceQueueInput(
  db: WorkspaceDb,
  scope: WorkspaceQueueInputScope,
  body: WorkspaceQueueInputBody
): PreparedWorkspaceQueueInputBatch {
  requireScope(db, scope);
  return { scope, inputs: [prepareBody(scope.workspaceId, body)] };
}

/** Prepares a manifest and each ordered member before entering the Pending freeze transaction. */
export function prepareWorkspaceQueueInputBatch(
  db: WorkspaceDb,
  batch: WorkspaceQueueInputBatch
): PreparedWorkspaceQueueInputBatch {
  const { manifest, members, ...scope } = batch;
  requireScope(db, scope);
  const expectedManifest = members.map(({ input }) => ({
    inputId: input.inputId,
    digest: input.digest,
  }));
  const ids = new Set([manifest.input.inputId, ...expectedManifest.map(({ inputId }) => inputId)]);
  if (
    members.length === 0 ||
    ids.size !== members.length + 1 ||
    manifest.input.inputId !== scope.turnId ||
    manifest.text !== JSON.stringify(expectedManifest)
  )
    throw new ControlProductPreconditionError();
  return {
    scope,
    inputs: [manifest, ...members].map((body) => prepareBody(scope.workspaceId, body)),
  };
}

/** Freezes exact bytes with the existing native write, including the Pending selection where applicable. */
export function commitWorkspaceQueueInputBatch(
  db: WorkspaceDb,
  prepared: PreparedWorkspaceQueueInputBatch
): void {
  if (isMainThread || !db.sqlite.inTransaction || db.sqlite.readonly)
    throw new ControlProductPreconditionError();
  const { scope, inputs } = prepared;
  requireScope(db, scope);
  const insert = db.sqlite.prepare(`INSERT INTO workspace_work_inputs
    (input_id, thread_id, turn_id, invocation_id, input_digest, input_bytes, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(input_id) DO NOTHING`);
  const existing = db.sqlite.prepare(inputRow);
  for (const input of inputs) {
    const stored = existing.get(input.inputId) as InputRow | undefined;
    if (!stored) {
      insert.run(
        input.inputId,
        scope.threadId,
        scope.turnId,
        scope.originalInvocationId,
        input.digest,
        input.bytes
      );
      continue;
    }
    if (
      stored.schemaVersion !== 1 ||
      stored.threadId !== scope.threadId ||
      stored.turnId !== scope.turnId ||
      stored.originalInvocationId !== scope.originalInvocationId ||
      stored.digest !== input.digest ||
      !stored.bytes.equals(input.bytes)
    )
      throw new ControlProductPreconditionError();
  }
}

type InputAddress = Omit<WorkspaceQueueInputScope, 'originalInvocationId'>;

const inputReadStatements = new WeakMap<Database.Database, Database.Statement>();

function readInputRow(
  dataRoot: string,
  scope: InputAddress,
  inputId: string,
  borrowed?: WorkspaceDb
): InputRow | null {
  let db = borrowed;
  try {
    db ??= openAdmittedWorkspaceReadDb(dataRoot, scope.workspaceId);
    if (
      db.workspaceId !== scope.workspaceId ||
      db.dataRoot !== dataRoot ||
      !db.sqlite.open ||
      !db.sqlite.readonly
    )
      return null;
    let statement = inputReadStatements.get(db.sqlite);
    if (!statement) {
      statement = db.sqlite.prepare(inputRow);
      inputReadStatements.set(db.sqlite, statement);
    }
    const stored = statement.get(inputId) as InputRow | undefined;
    if (
      !stored ||
      stored.schemaVersion !== 1 ||
      stored.threadId !== scope.threadId ||
      stored.turnId !== scope.turnId ||
      !stored.originalInvocationId ||
      !Buffer.isBuffer(stored.bytes) ||
      stored.bytes.length > CONTROL_PRODUCT_LIMITS.immutableBodyBytes ||
      sha256Hex(stored.bytes) !== stored.digest
    )
      return null;
    return stored;
  } catch {
    return null;
  } finally {
    if (!borrowed) db?.sqlite.close();
  }
}

/** Resolves the digest only from the original staged invocation in the admitted Workspace. */
export function findWorkspaceQueueInputRef(
  dataRoot: string,
  scope: InputAddress,
  address: { readonly inputId: string; readonly originalInvocationId: string },
  borrowed?: WorkspaceDb
): WorkInputRef | null {
  const stored = readInputRow(dataRoot, scope, address.inputId, borrowed);
  if (!stored || stored.originalInvocationId !== address.originalInvocationId) return null;
  return {
    owner: { kind: 'workspace', workspaceId: scope.workspaceId },
    inputId: address.inputId,
    digest: stored.digest,
  };
}

/** Reads exact UTF-8 from the selected, admitted Workspace. */
export function readWorkspaceQueueInput(
  dataRoot: string,
  scope: InputAddress,
  input: WorkInputRef,
  borrowed?: WorkspaceDb
): { readonly text: string; readonly originalInvocationId: string } | null {
  if (input.owner.kind !== 'workspace' || input.owner.workspaceId !== scope.workspaceId)
    return null;
  const stored = readInputRow(dataRoot, scope, input.inputId, borrowed);
  if (!stored || stored.digest !== input.digest) return null;
  const text = stored.bytes.toString();
  if (!Buffer.from(text, 'utf8').equals(stored.bytes)) return null;
  return { text, originalInvocationId: stored.originalInvocationId };
}

/** Validates the committed owner, digest and original invocation at the Core admission boundary. */
export function hasCommittedWorkspaceQueueInput(
  dataRoot: string,
  scope: InputAddress,
  input: WorkInputRef,
  originalInvocationId: string
): boolean {
  try {
    return (
      readWorkspaceQueueInput(dataRoot, scope, input)?.originalInvocationId === originalInvocationId
    );
  } catch {
    return false;
  }
}
