import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ThreadSchema, TurnSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { acquireDataRootLock, type DataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { coreDbPath, LOCAL_USER_ID } from './fs-layout.js';
import { WorkspaceSystemRecordSchema } from './workspace-file-records.js';

const THREAD_ENTRY_REQUIRED_FEATURE = 'openkit.thread-entry.v1' as const;
const THREAD_VISIBILITY_REQUIRED_FEATURE = 'openkit.thread-visibility.v1' as const;
const THREAD_REQUIRED_FEATURES = [
  THREAD_ENTRY_REQUIRED_FEATURE,
  THREAD_VISIBILITY_REQUIRED_FEATURE,
] as const;

type Thread = import('zod').infer<typeof ThreadSchema>;
type WorkspaceKind = import('zod').infer<typeof WorkspaceSystemRecordSchema>['kind'];

/** Allowed operator defaults for ambiguous predecessor Threads. */
export type AmbiguousVisibilityDefault = 'workspace';

/** One Thread examined during visibility cutover migration. */
export interface ThreadVisibilityMigrationRow {
  readonly decision: 'already-current' | 'classified' | 'operator-default' | 'ambiguous' | 'error';
  readonly path: string;
  readonly reason: string;
  readonly threadId: string;
  readonly visibility?: Thread['visibility'];
  readonly workspaceId: string;
}

/** Result of a dry-run or applied Thread visibility cutover migration. */
export interface ThreadVisibilityCutoverMigrationResult {
  readonly ambiguousCount: number;
  readonly applied: boolean;
  readonly backupRoot: string | null;
  readonly classifiedCount: number;
  readonly errorCount: number;
  readonly outcome: 'succeeded' | 'blocked';
  readonly rows: readonly ThreadVisibilityMigrationRow[];
  readonly scannedCount: number;
  readonly writtenCount: number;
}

/** Input for the stopped-process Thread visibility cutover migration. */
export interface MigrateThreadVisibilityCutoverInput {
  /** When set, ambiguous predecessors receive this explicit operator classification. */
  readonly ambiguousDefault?: AmbiguousVisibilityDefault;
  /** External destination for copies of rewritten thread.json files. */
  readonly backupRoot: string;
  /** NanoCore data root. */
  readonly dataRoot: string;
  /** When true, classify and report without writing. */
  readonly dryRun?: boolean;
}

/**
 * Classifies or applies explicit operator defaults for predecessor Thread visibility.
 *
 * NanoCore must be stopped. Without `ambiguousDefault`, ambiguous history blocks with no writes.
 */
export function migrateThreadVisibilityCutover(
  input: MigrateThreadVisibilityCutoverInput
): ThreadVisibilityCutoverMigrationResult {
  const dataRoot = resolve(input.dataRoot);
  const backupRoot = resolve(input.backupRoot);
  const dryRun = input.dryRun === true;
  const ambiguousDefault = input.ambiguousDefault;

  if (!existsSync(dataRoot)) {
    throw new Error(`Thread visibility cutover data root is missing: ${dataRoot}`);
  }
  if (backupRoot === dataRoot || backupRoot.startsWith(`${dataRoot}/`)) {
    throw new Error('Thread visibility cutover backup root must be outside the data root.');
  }

  let lock: DataRootLock;
  try {
    lock = acquireDataRootLock(dataRoot, {
      bootId: `thread-visibility-cutover-${randomUUID()}`,
    });
  } catch (error) {
    if (error instanceof DataRootLockError) {
      throw new Error(
        'Thread visibility cutover requires a stopped NanoCore with an exclusive data-root lock.'
      );
    }
    throw error;
  }

  try {
    const rows: ThreadVisibilityMigrationRow[] = [];
    const workspacesRoot = join(dataRoot, 'workspaces');
    for (const workspaceId of listDirectoryNames(workspacesRoot)) {
      const workspaceRoot = join(workspacesRoot, workspaceId);
      const workspaceRecordPath = join(workspaceRoot, 'workspace-record.json');
      if (!existsSync(workspaceRecordPath)) continue;
      const workspaceRecord = WorkspaceSystemRecordSchema.parse(readJson(workspaceRecordPath));
      const threadsRoot = join(workspaceRoot, 'threads');
      for (const threadId of listDirectoryNames(threadsRoot)) {
        const threadPath = join(threadsRoot, threadId, 'thread.json');
        if (!existsSync(threadPath)) {
          rows.push({
            decision: 'error',
            path: threadPath,
            reason: 'missing-thread-json',
            threadId,
            workspaceId,
          });
          continue;
        }
        const raw = readJson(threadPath);
        if (!isRecord(raw)) {
          rows.push({
            decision: 'error',
            path: threadPath,
            reason: 'invalid-thread-json',
            threadId,
            workspaceId,
          });
          continue;
        }
        const features = Array.isArray(raw.requiredFeatures)
          ? raw.requiredFeatures.filter((value): value is string => typeof value === 'string')
          : [];
        if (features.includes(THREAD_VISIBILITY_REQUIRED_FEATURE)) {
          rows.push({
            decision: 'already-current',
            path: threadPath,
            reason: 'has-visibility-feature',
            threadId,
            visibility:
              raw.visibility === 'private' || raw.visibility === 'workspace'
                ? raw.visibility
                : undefined,
            workspaceId,
          });
          continue;
        }
        if ('visibility' in raw || 'privateOwnerUserId' in raw) {
          rows.push({
            decision: 'error',
            path: threadPath,
            reason: 'visibility-without-feature',
            threadId,
            workspaceId,
          });
          continue;
        }

        let audience: Pick<Thread, 'visibility' | 'privateOwnerUserId'>;
        let decision: ThreadVisibilityMigrationRow['decision'] = 'classified';
        let reason: string;
        try {
          audience = classifyThreadVisibilityCutover(
            dataRoot,
            workspaceRoot,
            workspaceRecord.kind,
            threadId
          );
          reason =
            audience.visibility === 'private' ? 'quick-chat-owner' : 'formal-or-agent-inception';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('ambiguous project history')) {
            rows.push({
              decision: 'error',
              path: threadPath,
              reason: message,
              threadId,
              workspaceId,
            });
            continue;
          }
          if (!ambiguousDefault) {
            rows.push({
              decision: 'ambiguous',
              path: threadPath,
              reason: 'ambiguous-project-history',
              threadId,
              workspaceId,
            });
            continue;
          }
          audience = { visibility: ambiguousDefault };
          decision = 'operator-default';
          reason = `operator-default-${ambiguousDefault}`;
        }

        const thread = ThreadSchema.parse({
          id: typeof raw.id === 'string' ? raw.id : threadId,
          workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : workspaceId,
          name: raw.name ?? null,
          preview: raw.preview,
          status: raw.status,
          entryPath: raw.entryPath ?? 'conversation',
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
          ...audience,
        });
        rows.push({
          decision,
          path: threadPath,
          reason,
          threadId,
          visibility: thread.visibility,
          workspaceId,
        });
      }
    }

    const ambiguousCount = rows.filter((row) => row.decision === 'ambiguous').length;
    const errorCount = rows.filter((row) => row.decision === 'error').length;
    const classifiedCount = rows.filter(
      (row) => row.decision === 'classified' || row.decision === 'operator-default'
    ).length;
    const blocked = ambiguousCount > 0 || errorCount > 0;
    if (blocked || dryRun) {
      return {
        ambiguousCount,
        applied: false,
        backupRoot: null,
        classifiedCount,
        errorCount,
        outcome: blocked ? 'blocked' : 'succeeded',
        rows,
        scannedCount: rows.length,
        writtenCount: 0,
      };
    }

    mkdirSync(backupRoot, { recursive: true });
    let writtenCount = 0;
    for (const row of rows) {
      if (row.decision !== 'classified' && row.decision !== 'operator-default') continue;
      const raw = readJson(row.path);
      if (!isRecord(raw)) {
        throw new Error(`Thread JSON became unreadable during apply: ${row.path}`);
      }
      let audience: Pick<Thread, 'visibility' | 'privateOwnerUserId'>;
      if (row.decision === 'operator-default') {
        audience = { visibility: 'workspace' };
      } else {
        const workspaceRoot = join(dataRoot, 'workspaces', row.workspaceId);
        const kind = WorkspaceSystemRecordSchema.parse(
          readJson(join(workspaceRoot, 'workspace-record.json'))
        ).kind;
        audience = classifyThreadVisibilityCutover(dataRoot, workspaceRoot, kind, row.threadId);
      }
      const thread = ThreadSchema.parse({
        id: typeof raw.id === 'string' ? raw.id : row.threadId,
        workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : row.workspaceId,
        name: raw.name ?? null,
        preview: raw.preview,
        status: raw.status,
        entryPath: raw.entryPath ?? 'conversation',
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        ...audience,
      });
      const relativeBackup = join(row.workspaceId, row.threadId, 'thread.json');
      const backupPath = join(backupRoot, relativeBackup);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(row.path, backupPath);
      writeJsonAtomic(row.path, projectCanonicalThreadRecord(thread, raw));
      writtenCount += 1;
    }

    return {
      ambiguousCount: 0,
      applied: true,
      backupRoot,
      classifiedCount,
      errorCount: 0,
      outcome: 'succeeded',
      rows,
      scannedCount: rows.length,
      writtenCount,
    };
  } finally {
    lock.release();
  }
}

/** Parses CLI argv for the Thread visibility cutover migration. */
export function parseThreadVisibilityCutoverMigrationArgs(argv: readonly string[]): {
  ambiguousDefault?: AmbiguousVisibilityDefault;
  backupRoot: string;
  dataRoot: string;
  dryRun: boolean;
} {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let dataRoot: string | undefined;
  let backupRoot: string | undefined;
  let ambiguousDefault: AmbiguousVisibilityDefault | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--data-root') {
      if (!value) throw new Error('Missing value for --data-root');
      dataRoot = value;
      index += 1;
      continue;
    }
    if (flag === '--backup-root') {
      if (!value) throw new Error('Missing value for --backup-root');
      backupRoot = value;
      index += 1;
      continue;
    }
    if (flag === '--ambiguous-default') {
      if (value !== 'workspace') {
        throw new Error('Thread visibility cutover --ambiguous-default supports only workspace.');
      }
      ambiguousDefault = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown Thread visibility cutover flag: ${flag}`);
  }
  if (!dataRoot) throw new Error('Missing required Thread visibility cutover flag: --data-root');
  if (!backupRoot)
    throw new Error('Missing required Thread visibility cutover flag: --backup-root');
  return { ambiguousDefault, backupRoot, dataRoot, dryRun };
}

/** Runs the Thread visibility cutover migration CLI and prints a path-free summary. */
export function runThreadVisibilityCutoverMigrationCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  }
): ThreadVisibilityCutoverMigrationResult {
  const args = parseThreadVisibilityCutoverMigrationArgs(argv);
  const result = migrateThreadVisibilityCutover(args);
  const summary = {
    ambiguousCount: result.ambiguousCount,
    applied: result.applied,
    classifiedCount: result.classifiedCount,
    errorCount: result.errorCount,
    outcome: result.outcome,
    scannedCount: result.scannedCount,
    writtenCount: result.writtenCount,
    decisions: Object.fromEntries(
      (['already-current', 'classified', 'operator-default', 'ambiguous', 'error'] as const).map(
        (decision) => [decision, result.rows.filter((row) => row.decision === decision).length]
      )
    ),
  };
  write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.outcome === 'blocked') {
    throw new Error(
      `Thread visibility cutover blocked: ambiguous=${result.ambiguousCount} error=${result.errorCount}`
    );
  }
  return result;
}

/** Mirrors NanoCore predecessor cutover classification for operator migration. */
function classifyThreadVisibilityCutover(
  dataRoot: string,
  workspaceRoot: string,
  kind: WorkspaceKind,
  threadId: string
): Pick<Thread, 'visibility' | 'privateOwnerUserId'> {
  if (kind === 'quick-chat') {
    const workspaceId = basename(workspaceRoot);
    const candidates = new Set([LOCAL_USER_ID, ...listDirectoryNames(join(dataRoot, 'users'))]);
    if (existsSync(coreDbPath(dataRoot))) {
      const database = new Database(coreDbPath(dataRoot), { readonly: true, fileMustExist: true });
      try {
        for (const row of database.prepare('SELECT id FROM users').all() as Array<{ id: string }>) {
          candidates.add(row.id);
        }
      } finally {
        database.close();
      }
    }
    for (const userId of candidates) {
      const namespace =
        userId === LOCAL_USER_ID
          ? ''
          : `u_${createHash('sha256').update(userId).digest('hex').slice(0, 12)}_`;
      if (workspaceId === `ws_${namespace}quick_chat`) {
        return { visibility: 'private', privateOwnerUserId: userId };
      }
    }
    throw new Error('Thread visibility cutover requires the canonical Quick Chat owner.');
  }
  const turnsRoot = join(workspaceRoot, 'threads', threadId, 'turns');
  const turns = listDirectoryNames(turnsRoot).map((id) =>
    TurnSchema.parse({ ...(readJson(join(turnsRoot, id, 'turn.json')) as object), items: [] })
  );
  const firstTurn = turns.sort(
    (left, right) =>
      (left.startedAt ?? '').localeCompare(right.startedAt ?? '') || left.id.localeCompare(right.id)
  )[0];
  if (turns.length > 0 && turns.every((turn) => turn.agentId)) return { visibility: 'workspace' };
  if (!firstTurn?.startedAt || turns[1]?.startedAt === firstTurn.startedAt) {
    throw new Error(
      'Thread visibility cutover requires explicit classification of ambiguous project history.'
    );
  }
  if (firstTurn.agentId) return { visibility: 'workspace' };
  const databasePath = join(workspaceRoot, 'db', 'workspace.sqlite');
  if (firstTurn && existsSync(databasePath)) {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      if (
        database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goal_records'")
          .get()
      ) {
        const goalObjectives = database
          .prepare(
            'SELECT created_by_item_id AS itemId FROM goal_records WHERE workspace_id = ? AND thread_id = ?'
          )
          .all(basename(workspaceRoot), threadId) as Array<{ itemId: string | null }>;
        const itemsPath = join(turnsRoot, firstTurn.id, 'items.jsonl');
        const items = loadCurrentItems(itemsPath);
        if (
          goalObjectives.some((goal) =>
            items.some((item) => item.id === goal.itemId && item.type === 'user-message')
          )
        ) {
          return { visibility: 'workspace' };
        }
      }
    } finally {
      database.close();
    }
  }
  throw new Error(
    'Thread visibility cutover requires explicit classification of ambiguous project history.'
  );
}

function projectCanonicalThreadRecord(
  threadInput: Thread,
  previous?: unknown
): Record<string, unknown> {
  const thread = ThreadSchema.parse(threadInput);
  const preserved = isRecord(previous) ? previous : {};
  return {
    ...preserved,
    ...thread,
    schemaVersion: 1,
    recordType: 'thread',
    ownerScope: 'workspace',
    lineage: { workspaceId: thread.workspaceId, threadId: thread.id },
    contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(thread)).digest('hex')}`,
    redactionLevel: 'none',
    sensitivity: thread.visibility,
    requiredFeatures: [...THREAD_REQUIRED_FEATURES],
    extensions:
      typeof preserved.extensions === 'object' && preserved.extensions !== null
        ? preserved.extensions
        : {},
  };
}

function loadCurrentItems(path: string): Array<{ id: string; type: string }> {
  if (!existsSync(path)) return [];
  const current = new Map<string, { id: string; type: string }>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as { id?: string; type?: string };
    if (typeof item.id === 'string' && typeof item.type === 'string') {
      current.set(item.id, { id: item.id, type: item.type });
    }
  }
  return [...current.values()];
}

function listDirectoryNames(path: string): string[] {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata?.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
