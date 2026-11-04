import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { STORAGE_LIMITS } from '@openkit/storage';
import {
  guardExistingResolvedAgentSetup,
  requireResolvedAgentSetup,
} from '../agents/setup-ledger-records.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import {
  type ControlResolvedAgentSetupInput,
  type ControlResolvedAgentSetupRecord,
  ControlResolvedAgentSetupRecordSchema,
  type ControlResolvedAgentSetupResult,
} from './resolved-agent-setup-codecs.js';

/** Verified immutable request bytes; parsing runs outside SQL, original row admission remains inside. */
export interface PreparedResolvedAgentSetup {
  readonly record: ControlResolvedAgentSetupRecord;
  readonly setupJson: string;
}

/** Reads only the exact admitted private file; a replaced inode or changed body never reaches SQL. */
export async function prepareResolvedAgentSetup(
  workspaceDb: WorkspaceDb,
  input: ControlResolvedAgentSetupInput
): Promise<PreparedResolvedAgentSetup> {
  if (workspaceDb.workspaceId !== input.scopeWorkspaceId)
    throw new ControlProductPreconditionError();
  const staging = join(dirname(dirname(workspaceDb.sqlite.name)), 'runtime', 'staging');
  const path = join(staging, input.file.name);
  if (
    (await realpath(staging)) !== resolve(staging) ||
    (await realpath(dirname(path))) !== resolve(dirname(path))
  )
    throw new ControlProductPreconditionError();
  const selected = await lstat(path, { bigint: true });
  if (
    !selected.isFile() ||
    selected.isSymbolicLink() ||
    `${selected.dev}:${selected.ino}` !== input.file.identity ||
    selected.size !== BigInt(input.file.byteLength)
  )
    throw new ControlProductPreconditionError();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== selected.dev ||
      before.ino !== selected.ino ||
      before.size !== selected.size
    )
      throw new ControlProductPreconditionError();
    // The producer's admitted finite length, not a growing EOF, bounds this read.
    const bytes = Buffer.allocUnsafe(input.file.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        Math.min(STORAGE_LIMITS.chunkBytes, bytes.length - offset),
        offset
      );
      if (!bytesRead) throw new ControlProductPreconditionError();
      offset += bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead) throw new ControlProductPreconditionError();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      bytes.length !== input.file.byteLength ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs ||
      `sha256:${sha256Hex(bytes)}` !== input.file.digest
    )
      throw new ControlProductPreconditionError();
    const record = ControlResolvedAgentSetupRecordSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    return { record, setupJson: JSON.stringify(record.setup) };
  } finally {
    await file.close();
  }
}

/** Applies the original guard, replacement and dependent read within the owner's savepoint and FULL commit. */
export function applyResolvedAgentSetupInDb(
  workspaceDb: WorkspaceDb,
  prepared: PreparedResolvedAgentSetup
): ControlResolvedAgentSetupResult {
  assertControlProductWriter(workspaceDb.sqlite);
  const input = prepared.record;
  guardExistingResolvedAgentSetup(workspaceDb, input.recordId);
  workspaceDb.sqlite
    .prepare(
      `INSERT OR REPLACE INTO resolved_agent_setups (
        setup_record_id,
        workspace_id,
        turn_id,
        request_id,
        agent_id,
        logical_model_id,
        runtime_kind,
        runtime_adapter,
        required_features_json,
        setup_json,
        created_at,
        schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.recordId,
      input.workspaceId,
      input.turnId ?? null,
      input.requestId ?? null,
      input.setup.manifest.id,
      input.setup.logicalModels.preferredLogicalModelId,
      input.setup.manifest.runtime.kind,
      input.setup.manifest.runtime.adapter,
      JSON.stringify(input.setup.manifest.requiredFeatures),
      prepared.setupJson,
      input.createdAt,
      writeRetainedV1({}).schemaVersion
    );

  return requireResolvedAgentSetup(workspaceDb, input.workspaceId, input.recordId);
}
