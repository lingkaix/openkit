import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_RESOURCE_POLICY_FEATURE } from '@openkit/config-schema';
import { allocateEntityId, PROTOCOL_VERSION, writeRetainedV1 } from '@openkit/protocol';
import { copyVerifiedFile, publishDurableFile } from '@openkit/storage';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import {
  publishWorkspaceResourceCatalog,
  readWorkspaceResourceCatalog,
} from '../catalog/resource-catalog.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  applyPendingCloseout,
  type ControlPendingCommandInput,
  listThreadPendingRequests,
  type PreparedControlPendingCommand,
  readPendingRequest,
  renderPendingOutcomeItems,
} from '../runtime/pending-requests.js';
import {
  applyControlPendingTransition,
  type ControlPendingTransition,
  prepareControlPendingCommands,
} from './control-store-pending.js';
import {
  applyControlTerminal,
  type ControlContentPreparation,
  type ControlProductEntry,
  ControlProductPreconditionError,
  type ControlTerminalTransition,
  openControlStoreProductReadHandle,
  type PreparedControlTerminal,
  prepareControlTerminal,
  readProduct,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import {
  RECURRING_PORTABLE_PATHS,
  readRecurringPortableFiles,
} from './recurring-portable-history.js';
import { endCaptureInDb, inspectCapture } from './workspace-capture-protection.js';
import {
  ensureCanonicalDirectory,
  loadWorkspace,
  nativeProductScope,
  publishCanonicalPathAsync,
  readNativeTurnHistory,
} from './workspace-file-records.js';

/** One selected capture decision; closure verification and writer exclusion stay with its lifecycle. */
export interface ControlRecoveryCaptureInput {
  readonly workspaceId: string;
  readonly captureId: string;
  readonly state: 'finished' | 'abandoned';
}

/** Uses the original first-terminal owner inside the native covering transaction, never a new commit. */
export function applyControlRecoveryCapture(
  db: WorkspaceDb,
  input: ControlRecoveryCaptureInput
): void {
  if (db.workspaceId !== input.workspaceId) throw new ControlProductPreconditionError();
  endCaptureInDb(db, input.workspaceId, input.captureId, input.state);
}

/** Original source seal tuple; marker publication and capture completion remain later fenced steps. */
export interface ControlRecoveryMoveOutInput {
  readonly workspaceId: string;
  readonly captureId: string;
  readonly expectedRevision: number;
  readonly manifestDigest: string;
}

/** Commits current source lifecycle and its original Audit together, preserving active publication rights. */
export function applyControlRecoveryMoveOut(
  db: WorkspaceDb,
  input: ControlRecoveryMoveOutInput
): void {
  if (
    db.workspaceId !== input.workspaceId ||
    !db.sqlite.inTransaction ||
    inspectCapture(db, input.workspaceId, input.captureId)?.state !== 'active'
  )
    throw new ControlProductPreconditionError();
  const current = readProduct(
    db.sqlite,
    { kind: 'workspace', workspaceId: input.workspaceId },
    'workspace',
    input.workspaceId
  );
  if (!current) throw new ControlProductPreconditionError();
  // The frozen product view omits lifecycle extensions; inspect the original retained source fact.
  const movedJson = db.sqlite
    .prepare("SELECT json_extract(record_json, '$.movedOut') FROM control_workspaces WHERE id=?")
    .pluck()
    .get(input.workspaceId) as string | null;
  const moved =
    movedJson === null
      ? undefined
      : (JSON.parse(movedJson) as { backupId?: string; manifestDigest?: string });
  if (
    current.revision === input.expectedRevision + 1 &&
    moved?.backupId === input.captureId &&
    moved.manifestDigest === input.manifestDigest
  )
    return;
  if (current.revision !== input.expectedRevision || moved !== undefined)
    throw new ControlProductPreconditionError();
  const result = db.sqlite
    .prepare(
      "UPDATE control_workspaces SET revision=revision+1, record_json=json_set(record_json, '$.movedOut', json(?)) WHERE id=? AND revision=?"
    )
    .run(
      JSON.stringify({ backupId: input.captureId, manifestDigest: input.manifestDigest }),
      input.workspaceId,
      input.expectedRevision
    );
  if (result.changes !== 1) throw new ControlProductPreconditionError();
  recordWorkspaceAuditEvent({
    workspaceDb: db,
    workspaceId: input.workspaceId,
    action: 'workspace.move-out',
    resource: `workspace:${input.workspaceId}`,
    outcome: 'succeeded',
    summary: `Moved out ${input.captureId} ${input.manifestDigest}.`,
  });
}

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
  // Keep the complete original file/history census inside the admitted native owner.
  loadWorkspace(root, db.workspaceId);
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

/** One existing durable history unit; no phase or cursor survives acknowledgement. */
export type PreparedControlRecoveryHistory =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'terminal';
      readonly input: ControlTerminalTransition;
      readonly prepared: PreparedControlTerminal;
    }
  | {
      readonly kind: 'pending';
      readonly input: ControlPendingTransition;
      readonly prepared: PreparedControlPendingCommand;
    };

/** Prepares one captured history transition without calling a worker client or holding SQL across byte awaits. */
export async function prepareControlRecoveryHistory(
  db: WorkspaceDb,
  workspaceId: string,
  root: string,
  directories: ControlContentPreparation
): Promise<PreparedControlRecoveryHistory> {
  if (db.workspaceId !== workspaceId || db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  const scope = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId }, root);
  const { owner, contentMount: mount } = scope;
  const now = new Date().toISOString();
  const openTurn = db.sqlite
    .prepare(
      "SELECT id FROM control_turns WHERE status NOT IN ('completed','failed','cancelled','interrupted') ORDER BY id LIMIT 1"
    )
    .get() as { id: string } | undefined;
  if (openTurn) {
    const history = readNativeTurnHistory(scope, openTurn.id);
    if (!history) throw new ControlProductPreconditionError();
    const turn = {
      ...history.turn,
      status: 'interrupted' as const,
      completedAt: now,
      error: {
        code: 'workspace_recovered',
        message: 'Captured work was interrupted by offline recovery.',
      },
    };
    const sequence = Number(
      db.sqlite
        .prepare(
          "SELECT COALESCE(MAX(sequence),0)+1 FROM control_product_entries WHERE kind='event' AND turn_id=?"
        )
        .pluck()
        .get(turn.id)
    );
    const governed = db.sqlite
      .prepare('SELECT 1 FROM control_executions WHERE work_id=?')
      .get(turn.id)
      ? await (await import('../runtime/worker-turn-failure.js')).workerTurnTerminalPublication(
          db,
          turn.id,
          'interrupted'
        )
      : undefined;
    const input: ControlTerminalTransition = {
      owner,
      turn: {
        kind: 'turn',
        expectedRevision: history.revision,
        record: writeRetainedV1({
          ...turn,
          items: [],
          captureCoverage: history.captureCoverage ?? undefined,
        }),
      },
      products: [],
      entries: [
        {
          kind: 'event',
          turnId: turn.id,
          sequence,
          expectedRevision: 0,
          ...(await prepareRetainedProductJson(
            mount,
            owner,
            join(root, 'runtime/staging'),
            writeRetainedV1({
              protocolVersion: PROTOCOL_VERSION,
              workspaceId,
              threadId: turn.threadId,
              turnId: turn.id,
              requestId: null,
              timestamp: now,
              sequence,
              event: 'turn.completed',
              data: { type: 'turn-completed', stopReason: 'aborted', turn },
            })
          )),
        },
      ],
      reap: { reason: 'offline Workspace recovery', inferredBy: 'workspace-recovery' },
      evidence: governed?.evidence ?? [],
      evidenceContent: [],
      command: null,
      execution: governed?.execution ?? null,
    };
    return {
      kind: 'terminal',
      input,
      prepared: await prepareControlTerminal(db, input, mount, directories),
    };
  }
  const selected = db.sqlite
    .prepare(`SELECT request_id FROM pending_requests WHERE workspace_id=? AND
    ((claim='claimed' AND disposition IS NULL) OR delivery='frozen' OR state='pending' OR delivery='undelivered')
    ORDER BY CASE WHEN claim='claimed' AND disposition IS NULL THEN 0 WHEN delivery='frozen' THEN 1 ELSE 2 END,request_id LIMIT 1`)
    .get(workspaceId) as { request_id: string } | undefined;
  if (!selected) return { kind: 'done' };
  const record = readPendingRequest(db.sqlite, selected.request_id);
  if (!record || record.workspaceId !== workspaceId) throw new ControlProductPreconditionError();
  const pending = listThreadPendingRequests(db.sqlite, workspaceId, record.threadId);
  if ((record.claim === 'claimed' && record.disposition === null) || record.delivery === 'frozen') {
    const command: ControlPendingCommandInput =
      record.delivery === 'frozen' && !(record.claim === 'claimed' && record.disposition === null)
        ? {
            action: 'delivery-unknown',
            workspaceId,
            turnId: record.deliveryTurnId!,
            now,
            expected: pending
              .filter(
                (request) =>
                  request.delivery === 'frozen' && request.deliveryTurnId === record.deliveryTurnId
              )
              .map((request) => ({
                requestId: request.requestId,
                sourceHash: commandInputHash(request),
              })),
          }
        : {
            action: 'settle-unfinished',
            workspaceId,
            now,
            expected: [{ requestId: record.requestId, sourceHash: commandInputHash(record) }],
          };
    const input = { input: command, products: [], entries: [], receipt: null };
    return {
      kind: 'pending',
      input,
      prepared: await prepareControlPendingCommands(
        db,
        [command],
        mount,
        [],
        undefined,
        directories
      ),
    };
  }
  const turnId = allocateEntityId('tu');
  const command = {
    action: 'closeout' as const,
    workspaceId,
    threadId: record.threadId,
    closeoutTurnId: turnId,
    actor: { kind: 'system' as const, id: 'workspace-recovery' },
    now,
    expected: [{ requestId: record.requestId, sourceHash: commandInputHash(record) }],
    expectedThreadCensus: pending.map((request) => request.requestId),
    invalidatingEvents: [{ requestId: record.requestId, event: 'workspace-recovered' }],
  };
  let items: ReturnType<typeof renderPendingOutcomeItems>;
  db.sqlite.exec('SAVEPOINT recovery_projection');
  try {
    const closed = applyPendingCloseout(db.sqlite, {
      ...command,
      usable: (request) => request.requestId === record.requestId,
      invalidatingEvent: () => 'workspace-recovered',
    });
    if (!closed.length) throw new ControlProductPreconditionError();
    items = renderPendingOutcomeItems(closed, turnId, now);
  } finally {
    db.sqlite.exec('ROLLBACK TO recovery_projection');
    db.sqlite.exec('RELEASE recovery_projection');
  }
  const turn = {
    id: turnId,
    owner,
    threadId: record.threadId,
    triggerActor: { kind: 'system' as const, id: 'workspace-recovery', responsibleUserId: null },
    triggerSource: { kind: 'system-input' as const, summary: 'Offline recovery closeout' },
    agentId: null,
    agentSessionId: null,
    configVersion: null,
    items,
    status: 'completed' as const,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    error: null,
  };
  const entries: ControlProductEntry[] = [];
  for (const item of items)
    entries.push({
      kind: 'item',
      turnId,
      sequence: entries.length + 1,
      expectedRevision: 0,
      ...(await prepareRetainedProductJson(
        mount,
        owner,
        join(root, 'runtime/staging'),
        writeRetainedV1(item)
      )),
    });
  entries.push({
    kind: 'event',
    turnId,
    sequence: 1,
    expectedRevision: 0,
    ...(await prepareRetainedProductJson(
      mount,
      owner,
      join(root, 'runtime/staging'),
      writeRetainedV1({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId,
        threadId: record.threadId,
        turnId,
        requestId: null,
        timestamp: now,
        sequence: 1,
        event: 'turn.completed',
        data: { type: 'turn-completed', stopReason: 'completed', turn },
      })
    )),
  });
  const input: ControlTerminalTransition = {
    owner,
    turn: {
      kind: 'turn',
      expectedRevision: 0,
      record: writeRetainedV1({
        ...turn,
        items: [],
        captureCoverage: { scope: 'workspace', value: 'off' },
      }),
    },
    products: [],
    entries,
    pending: [command],
    reap: { reason: 'offline Workspace recovery', inferredBy: 'workspace-recovery' },
    evidence: [],
    evidenceContent: [],
    command: null,
    execution: null,
  };
  return {
    kind: 'terminal',
    input,
    prepared: await prepareControlTerminal(db, input, mount, directories),
  };
}

/** Applies one prepared original terminal/Pending tuple; its covering native commit proves progress. */
export function applyControlRecoveryHistory(
  db: WorkspaceDb,
  prepared: PreparedControlRecoveryHistory
): boolean {
  if (!db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  if (prepared.kind === 'done') return true;
  if (prepared.kind === 'terminal') {
    applyControlTerminal(db, prepared.input, prepared.prepared);
    const request = prepared.input.pending?.[0];
    if (request?.action === 'closeout') {
      const after = readPendingRequest(db.sqlite, request.expected![0]!.requestId);
      if (!after || after.state === 'pending' || after.delivery === 'undelivered')
        throw new ControlProductPreconditionError();
    }
  } else {
    const result = applyControlPendingTransition(db, prepared.input, prepared.prepared);
    if (!result.requestIds.length) throw new ControlProductPreconditionError();
  }
  return false;
}
