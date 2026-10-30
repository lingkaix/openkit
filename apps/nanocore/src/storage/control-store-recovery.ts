import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_RESOURCE_POLICY_FEATURE } from '@openkit/config-schema';
import { copyVerifiedFile, publishDurableFile } from '@openkit/storage';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import {
  publishWorkspaceResourceCatalog,
  readWorkspaceResourceCatalog,
} from '../catalog/resource-catalog.js';
import { parseJsoncObject } from '../config/jsonc.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
  readProduct,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import {
  RECURRING_PORTABLE_PATHS,
  readRecurringPortableFiles,
} from './recurring-portable-history.js';
import { endCaptureInDb } from './workspace-capture-protection.js';
import { ensureCanonicalDirectory, publishCanonicalPathAsync } from './workspace-file-records.js';

/** Cleanup facts for an already admitted, unpublished restore or MOVE candidate. */
export interface ControlRecoveryCleanupInput {
  readonly workspaceId: string;
  readonly action: 'workspace.restore' | 'workspace.move-in';
  readonly summary: string;
  readonly preparation: {
    readonly now: string;
    readonly requiredFeatures: readonly string[];
    readonly restricted: boolean;
    readonly ownerId: string;
    readonly memberMappings: readonly {
      readonly sourceAccountId: string;
      readonly targetAccountId: string;
    }[];
  };
}

/** Prepares inert history and target policy before cleanup SQL on the admitted private candidate. */
export async function prepareControlRecoveryCleanup(
  db: WorkspaceDb,
  input: ControlRecoveryCleanupInput,
  root: string
): Promise<void> {
  if (db.workspaceId !== input.workspaceId || db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const threads = (
    db.sqlite.prepare('SELECT id FROM control_threads').pluck().all() as string[]
  ).map((id) => {
    const record = readProduct(db.sqlite, owner, 'thread', id)?.record;
    if (!record || typeof record.id !== 'string') throw new ControlProductPreconditionError();
    return {
      id: record.id,
      visibility: record.visibility,
      privateOwnerUserId: record.privateOwnerUserId,
    };
  });
  if (input.preparation.requiredFeatures.includes('workspace.recurring-triggers.v1')) {
    const turns = new Map(
      (db.sqlite.prepare('SELECT id FROM control_turns').pluck().all() as string[]).map((id) => {
        const record = readProduct(db.sqlite, owner, 'turn', id)?.record;
        if (!record || typeof record.threadId !== 'string')
          throw new ControlProductPreconditionError();
        return [id, record.threadId] as const;
      })
    );
    const history = readRecurringPortableFiles(
      new Map(
        Object.values(RECURRING_PORTABLE_PATHS).map((path) => [
          path,
          readFileSync(join(root, path), 'utf8'),
        ])
      ),
      {
        workspaceId: db.workspaceId,
        threadIds: new Set(threads.map((thread) => thread.id)),
        turns,
      }
    );
    const directory = join(root, 'imports');
    ensureCanonicalDirectory(directory);
    const staged = join(directory, `.recovery-${randomUUID()}.tmp`);
    await publishDurableFile({
      destinationPath: staged,
      bytes: JSON.stringify(history),
      mode: 0o600,
    });
    await publishCanonicalPathAsync(staged, join(directory, 'recurrence-history.json'));
  }
  if (input.action !== 'workspace.move-in' && !input.preparation.restricted) return;
  const configPath = join(root, 'config/workspace.jsonc');
  const config = parseJsoncObject(readFileSync(configPath, 'utf8')) as {
    workspace: { policy?: { mediation?: unknown } };
    requiredFeatures?: string[];
  };
  config.requiredFeatures = [
    ...new Set([...(config.requiredFeatures ?? []), WORKSPACE_RESOURCE_POLICY_FEATURE]),
  ];
  const pairs = new Map(
    input.preparation.memberMappings.map((pair) => [pair.sourceAccountId, pair.targetAccountId])
  );
  const unavailable =
    input.action === 'workspace.move-in'
      ? threads.filter(
          (thread) =>
            thread.visibility === 'private' && !pairs.has(thread.privateOwnerUserId as string)
        )
      : threads;
  const anchor = { owner, kind: 'workspace', id: db.workspaceId };
  config.workspace.policy = {
    mediation: {
      schemaVersion: 1,
      statements: unavailable.map((thread) => ({
        id: `recovery-${thread.id}`,
        kind: 'managed-boundary',
        state: 'active',
        author: { kind: 'human', id: input.preparation.ownerId },
        authority: { kind: 'human', userId: input.preparation.ownerId },
        authoredAt: input.preparation.now,
        lifetime: { anchor },
        scope: {
          subjects: [],
          actions: [],
          resources: [
            { kind: 'container', container: { ...anchor, kind: 'thread', id: thread.id } },
          ],
        },
      })),
    },
  };
  const staged = join(root, 'config', `.recovery-${randomUUID()}.tmp`);
  await publishDurableFile({ destinationPath: staged, bytes: JSON.stringify(config), mode: 0o600 });
  await publishCanonicalPathAsync(staged, configPath);
  const catalog = readWorkspaceResourceCatalog(db.dataRoot, db.workspaceId);
  // Keep the single revision-protected catalog mutation owner, including retained annotations.
  publishWorkspaceResourceCatalog({
    dataRoot: db.dataRoot,
    workspaceId: db.workspaceId,
    expectedRevision: catalog.revision,
    catalog: {
      ...catalog,
      mcp: {
        ...catalog.mcp,
        bindings: catalog.mcp.bindings.map((binding) => ({
          ...binding,
          enabled: false,
          credentialBindings: [],
        })),
      },
      plugins: { ...catalog.plugins, installations: [] },
      skills: { ...catalog.skills, pins: [] },
    },
  });
}

/** Applies existing recovery owners together; only the native covering commit acknowledges them. */
export function applyControlRecoveryCleanup(
  db: WorkspaceDb,
  input: ControlRecoveryCleanupInput
): void {
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  if (input.action === 'workspace.move-in') {
    // Resolve every target from the original rows: injective account maps can still overlap source ids.
    const pairs = new Map(
      input.preparation.memberMappings.map((pair) => [pair.sourceAccountId, pair.targetAccountId])
    );
    const threads = db.sqlite
      .prepare(
        "SELECT id,json_extract(record_json,'$.privateOwnerUserId') AS owner FROM control_threads"
      )
      .all() as { id: string; owner: string | null }[];
    const update = db.sqlite.prepare(
      "UPDATE control_threads SET revision=revision+1,record_json=json_set(record_json,'$.privateOwnerUserId',?) WHERE id=?"
    );
    for (const thread of threads) {
      const target = thread.owner ? pairs.get(thread.owner) : undefined;
      if (target) update.run(target, thread.id);
    }
  }
  recoverRunningCapabilityCalls({ workspaceDb: db });
  const captures = db.sqlite
    .prepare("SELECT capture_id FROM workspace_capture_records WHERE state='active'")
    .pluck()
    .all() as string[];
  for (const capture of captures) endCaptureInDb(db, db.workspaceId, capture, 'finished');
  recordWorkspaceAuditEvent({
    workspaceDb: db,
    workspaceId: db.workspaceId,
    action: input.action,
    resource: `workspace:${db.workspaceId}`,
    outcome: 'succeeded',
    summary: input.summary,
  });
}

/** Root-locked current safety source for an already admitted private restore candidate. */
export interface ControlRecoverySafetyInput {
  readonly workspaceId: string;
  readonly sourceDataRoot: string;
}

/** Existing refusal distinctions; no source row crosses the message boundary. */
export type ControlRecoverySafetyResult = 'preserved' | 'unavailable' | 'moved-out';

/** Worker-local source census, held only until the owning candidate transition settles. */
export type PreparedControlRecoverySafety =
  | { readonly result: 'preserved'; readonly rows: readonly Record<string, unknown>[] }
  | { readonly result: 'unavailable' | 'moved-out' };

/** Reads current safety without migrations or writes, and closes the source before byte preparation. */
function readControlRecoverySafety(
  input: ControlRecoverySafetyInput
): PreparedControlRecoverySafety {
  let current: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
  try {
    current = openControlStoreProductReadHandle(
      workspaceDbPath(input.sourceDataRoot, input.workspaceId),
      { kind: 'workspace', workspaceId: input.workspaceId }
    );
    if (current.sqlite.pragma('integrity_check', { simple: true }) !== 'ok')
      return { result: 'unavailable' };
    if (
      current.sqlite
        .prepare("SELECT json_extract(record_json,'$.movedOut') FROM control_workspaces WHERE id=?")
        .pluck()
        .get(input.workspaceId)
    )
      return { result: 'moved-out' };
    return {
      result: 'preserved',
      rows: current.sqlite.prepare('SELECT * FROM evidence_bundles').all() as Record<
        string,
        unknown
      >[],
    };
  } catch {
    // Only an unreadable source may use the original explicit lost-safety acknowledgement.
    return { result: 'unavailable' };
  } finally {
    current?.close();
  }
}

/** Prepares current private bytes before candidate SQL; a late copy failure is never unavailable safety. */
export async function prepareControlRecoverySafety(
  input: ControlRecoverySafetyInput,
  candidateRoot: string
): Promise<PreparedControlRecoverySafety> {
  const safety = readControlRecoverySafety(input);
  if (safety.result !== 'preserved') return safety;
  // The admitted private candidate is never published if any copy, validation or sync fails.
  const config = join(candidateRoot, 'config/workspace.jsonc');
  const stagedConfig = join(candidateRoot, 'config', `.recovery-${randomUUID()}.tmp`);
  await copyVerifiedFile({
    sourcePath: join(
      input.sourceDataRoot,
      'workspaces',
      input.workspaceId,
      'config/workspace.jsonc'
    ),
    destinationPath: stagedConfig,
    mode: 0o600,
  });
  await publishCanonicalPathAsync(stagedConfig, config);
  const catalogRoot = join(candidateRoot, 'catalog');
  ensureCanonicalDirectory(catalogRoot);
  const stagedCatalog = join(catalogRoot, `.recovery-${randomUUID()}.tmp`);
  // This is a copy of current retained authority, not a revision-advancing catalog mutation.
  await publishDurableFile({
    destinationPath: stagedCatalog,
    bytes: JSON.stringify(readWorkspaceResourceCatalog(input.sourceDataRoot, input.workspaceId)),
  });
  await publishCanonicalPathAsync(stagedCatalog, join(catalogRoot, 'catalog.json'));
  return safety;
}

/** Replaces captured safety with the proved current rows; failures never become lost-safety consent. */
export function applyControlRecoverySafety(
  db: WorkspaceDb,
  input: ControlRecoverySafetyInput,
  prepared: PreparedControlRecoverySafety
): ControlRecoverySafetyResult {
  if (db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  if (prepared.result !== 'preserved') return prepared.result;
  db.sqlite.prepare('DELETE FROM evidence_bundles').run();
  for (const row of prepared.rows) {
    const columns = Object.keys(row);
    db.sqlite
      .prepare(
        `INSERT INTO evidence_bundles (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }
  return 'preserved';
}
