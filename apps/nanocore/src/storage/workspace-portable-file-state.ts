import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  KnowledgeClaimSchema,
  KnowledgeConflictSchema,
  KnowledgeObservationSchema,
  KnowledgeRetrievalResponseSchema,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';

import {
  appendCanonicalTextFile,
  assertCanonicalDirectory,
  readCanonicalJsonLines,
  readCanonicalTextFile,
} from './workspace-file-records.js';

const ObservationRowSchema = KnowledgeObservationSchema.strict();
const ClaimRowSchema = KnowledgeClaimSchema.strict();
const ConflictRowSchema = KnowledgeConflictSchema.strict();
const RetrievalTraceRowSchema = KnowledgeRetrievalResponseSchema.strict();

/** Authoritative file-backed workspace state that is portable but not owned by canonical protocol records. */
export interface WorkspacePortableFileState {
  /** Observation rows grouped by canonical ledger month in append order. */
  readonly observations: ReadonlyMap<string, readonly z.infer<typeof ObservationRowSchema>[]>;
  /** Claim rows grouped by canonical ledger month in append order. */
  readonly claims: ReadonlyMap<string, readonly z.infer<typeof ClaimRowSchema>[]>;
  /** Complete conflict append history grouped by canonical ledger month. */
  readonly conflicts: ReadonlyMap<string, readonly z.infer<typeof ConflictRowSchema>[]>;
  /** Retrieval traces grouped by canonical ledger month in append order. */
  readonly retrievalTraces: ReadonlyMap<string, readonly z.infer<typeof RetrievalTraceRowSchema>[]>;
  /** Exact workspace configuration text, or null when absent. */
  readonly workspaceConfig: string | null;
  /** Exact workspace knowledge schema text, or null when absent. */
  readonly workspaceSchema: string | null;
  /** Exact portable OKF page text keyed by workspace-relative path. */
  readonly nativeKnowledgePages: ReadonlyMap<string, string>;
  /** Turn-owned worker Context Package traces and exact worker-visible text files. */
  readonly workerContextPackageFiles: ReadonlyMap<string, string>;
}

/**
 * Appends one strictly validated observation to its canonical monthly ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param row Observation row to append.
 * @throws Error for malformed rows, timestamps, paths, links, or non-regular files.
 */
export function appendWorkspaceKnowledgeObservation(
  workspaceRoot: string,
  row: z.infer<typeof ObservationRowSchema>
): void {
  appendMonthlyLedgerRow(
    workspaceRoot,
    'knowledge/observations',
    row,
    ObservationRowSchema,
    (entry) => entry.observedAt
  );
}

/**
 * Reads the complete strictly validated observation ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param repairFinalFragment Whether to repair an interrupted final JSON fragment.
 * @returns Observation rows grouped by canonical ledger month.
 * @throws Error for malformed rows, month placement, paths, links, or non-regular files.
 */
export function readWorkspaceKnowledgeObservationLedger(
  workspaceRoot: string,
  repairFinalFragment = false
): ReadonlyMap<string, readonly z.infer<typeof ObservationRowSchema>[]> {
  return readMonthlyLedger(
    workspaceRoot,
    'knowledge/observations',
    ObservationRowSchema,
    (row) => row.observedAt,
    repairFinalFragment
  );
}

/**
 * Appends one strictly validated claim to its canonical monthly ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param row Claim row to append.
 * @throws Error for malformed rows, timestamps, paths, links, or non-regular files.
 */
export function appendWorkspaceKnowledgeClaim(
  workspaceRoot: string,
  row: z.infer<typeof ClaimRowSchema>
): void {
  appendMonthlyLedgerRow(
    workspaceRoot,
    'knowledge/claims',
    row,
    ClaimRowSchema,
    (entry) => entry.createdAt
  );
}

/**
 * Reads the complete strictly validated claim ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param repairFinalFragment Whether to repair an interrupted final JSON fragment.
 * @returns Claim rows grouped by canonical ledger month.
 * @throws Error for malformed rows, month placement, paths, links, or non-regular files.
 */
export function readWorkspaceKnowledgeClaimLedger(
  workspaceRoot: string,
  repairFinalFragment = false
): ReadonlyMap<string, readonly z.infer<typeof ClaimRowSchema>[]> {
  return readMonthlyLedger(
    workspaceRoot,
    'knowledge/claims',
    ClaimRowSchema,
    (row) => row.createdAt,
    repairFinalFragment
  );
}

/**
 * Appends one strictly validated conflict revision to its canonical monthly ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param row Conflict row to append.
 * @throws Error for malformed rows, timestamps, paths, links, or non-regular files.
 */
export function appendWorkspaceKnowledgeConflict(
  workspaceRoot: string,
  row: z.infer<typeof ConflictRowSchema>
): void {
  appendMonthlyLedgerRow(
    workspaceRoot,
    'knowledge/conflicts',
    row,
    ConflictRowSchema,
    (entry) => entry.resolvedAt ?? entry.createdAt
  );
}

/**
 * Reads the complete strictly validated conflict revision ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param repairFinalFragment Whether to repair an interrupted final JSON fragment.
 * @returns Conflict revisions grouped by canonical ledger month.
 * @throws Error for malformed rows, month placement, paths, links, or non-regular files.
 */
export function readWorkspaceKnowledgeConflictLedger(
  workspaceRoot: string,
  repairFinalFragment = false
): ReadonlyMap<string, readonly z.infer<typeof ConflictRowSchema>[]> {
  return readMonthlyLedger(
    workspaceRoot,
    'knowledge/conflicts',
    ConflictRowSchema,
    (row) => row.resolvedAt ?? row.createdAt,
    repairFinalFragment
  );
}

/**
 * Appends one strictly validated retrieval trace to its canonical monthly ledger.
 *
 * @param workspaceRoot Published workspace root.
 * @param row Retrieval trace to append.
 * @throws Error for duplicate ids, malformed rows, timestamps, paths, links, or non-regular files.
 */
export function appendWorkspaceKnowledgeRetrievalTrace(
  workspaceRoot: string,
  row: z.infer<typeof RetrievalTraceRowSchema>
): void {
  const parsed = RetrievalTraceRowSchema.parse(row);
  // ponytail: a linear scan fits the small-deployment profile; add an index only if trace volume proves it necessary.
  const existing = readMonthlyLedger(
    workspaceRoot,
    'knowledge/traces',
    RetrievalTraceRowSchema,
    (entry) => entry.createdAt,
    true
  );

  if (
    [...existing.values()].some((rows) => rows.some((entry) => entry.traceId === parsed.traceId))
  ) {
    throw new Error('Duplicate Knowledge retrieval trace id.');
  }
  appendMonthlyLedgerRow(
    workspaceRoot,
    'knowledge/traces',
    parsed,
    RetrievalTraceRowSchema,
    (entry) => entry.createdAt
  );
}

/**
 * Reads one strictly validated Knowledge retrieval trace by id.
 *
 * @param workspaceRoot Published workspace root.
 * @param traceId Retrieval trace id to locate.
 * @returns The unique trace, or null when no row has that id.
 * @throws Error when the ledger is malformed or contains the id more than once.
 */
export function readWorkspaceKnowledgeRetrievalTrace(
  workspaceRoot: string,
  traceId: string
): z.infer<typeof RetrievalTraceRowSchema> | null {
  // ponytail: a linear scan fits the small-deployment profile; add an index only if trace volume proves it necessary.
  const matches = [
    ...readMonthlyLedger(
      workspaceRoot,
      'knowledge/traces',
      RetrievalTraceRowSchema,
      (row) => row.createdAt
    ).values(),
  ]
    .flat()
    .filter((row) => row.traceId === traceId);

  if (matches.length > 1) {
    throw new Error('Duplicate Knowledge retrieval trace id.');
  }

  return matches[0] ?? null;
}

/**
 * Reads all authoritative portable file state beneath one real workspace root.
 *
 * @param workspaceRoot Published source workspace root.
 * @param turns Canonical Thread and Turn identities allowed to own package trees.
 * @returns Strictly parsed ledgers and exact portable text files.
 * @throws Error for malformed rows, invalid month placement, links, or non-regular files.
 */
export function readWorkspacePortableFileState(
  workspaceRoot: string,
  turns: readonly { readonly threadId: string; readonly turnId: string }[]
): WorkspacePortableFileState {
  const root = resolve(workspaceRoot);

  assertCanonicalDirectory(root);
  return {
    observations: readWorkspaceKnowledgeObservationLedger(root),
    claims: readWorkspaceKnowledgeClaimLedger(root),
    conflicts: readWorkspaceKnowledgeConflictLedger(root),
    retrievalTraces: readMonthlyLedger(
      root,
      'knowledge/traces',
      RetrievalTraceRowSchema,
      (row) => row.createdAt
    ),
    workspaceConfig: readOptionalText(root, 'config/workspace.jsonc'),
    workspaceSchema: readOptionalText(root, 'knowledge/schema/workspace-schema.yaml'),
    nativeKnowledgePages: readNativeKnowledgePages(root),
    workerContextPackageFiles: readWorkerContextPackageFiles(root, turns),
  };
}

/**
 * Writes portable state only beneath an existing staging workspace root.
 *
 * @param workspaceRoot Existing staging workspace root.
 * @param state Reminted portable state to publish with the workspace.
 * @throws Error for malformed rows, invalid paths, links, collisions, or month mismatches.
 */
export function writeWorkspacePortableFileState(
  workspaceRoot: string,
  state: WorkspacePortableFileState
): void {
  const root = resolve(workspaceRoot);

  assertCanonicalDirectory(root);
  writeMonthlyLedger(
    root,
    'knowledge/observations',
    state.observations,
    ObservationRowSchema,
    (row) => row.observedAt
  );
  writeMonthlyLedger(
    root,
    'knowledge/claims',
    state.claims,
    ClaimRowSchema,
    (row) => row.createdAt
  );
  writeMonthlyLedger(
    root,
    'knowledge/conflicts',
    state.conflicts,
    ConflictRowSchema,
    (row) => row.resolvedAt ?? row.createdAt
  );
  writeMonthlyLedger(
    root,
    'knowledge/traces',
    state.retrievalTraces,
    RetrievalTraceRowSchema,
    (row) => row.createdAt
  );
  if (state.workspaceConfig !== null) {
    writeText(root, 'config/workspace.jsonc', state.workspaceConfig, false);
  }
  if (state.workspaceSchema !== null) {
    writeText(root, 'knowledge/schema/workspace-schema.yaml', state.workspaceSchema, true);
  }
  writeTextMap(root, state.nativeKnowledgePages, 'knowledge/pages/', true);
  assertWorkerContextPackageFiles(state.workerContextPackageFiles);
  writeTextMap(root, state.workerContextPackageFiles, 'threads/', false);
}

/**
 * Writes portable file state into an owned workspace export root.
 *
 * @param exportRoot Export root owned by the current export writer.
 * @param state Source workspace file state, when present.
 */
export function writeWorkspacePortableExportState(
  exportRoot: string,
  state: WorkspacePortableFileState | undefined
): void {
  const root = resolve(exportRoot);
  const empty = new Map<string, readonly never[]>();

  assertCanonicalDirectory(root);
  writeText(
    root,
    'records/knowledge-observations.jsonl',
    serializeMonthlyLedger(
      state?.observations ?? empty,
      ObservationRowSchema,
      (row) => row.observedAt
    ),
    false
  );
  writeText(
    root,
    'records/knowledge-claims.jsonl',
    serializeMonthlyLedger(state?.claims ?? empty, ClaimRowSchema, (row) => row.createdAt),
    false
  );
  writeText(
    root,
    'records/knowledge-conflicts.jsonl',
    serializeMonthlyLedger(
      state?.conflicts ?? empty,
      ConflictRowSchema,
      (row) => row.resolvedAt ?? row.createdAt
    ),
    false
  );
  writeText(
    root,
    'records/knowledge-retrieval-traces.jsonl',
    serializeMonthlyLedger(
      state?.retrievalTraces ?? empty,
      RetrievalTraceRowSchema,
      (row) => row.createdAt
    ),
    false
  );

  if (!state) {
    return;
  }
  if (state.workspaceConfig !== null) {
    writeText(root, 'workspace-files/config/workspace.jsonc', state.workspaceConfig, false);
  }
  if (state.workspaceSchema !== null) {
    writeText(
      root,
      'workspace-files/knowledge/schema/workspace-schema.yaml',
      state.workspaceSchema,
      false
    );
  }
  writeExportTextMap(root, state.nativeKnowledgePages, 'knowledge/pages/');
  assertWorkerContextPackageFiles(state.workerContextPackageFiles);
  writeExportTextMap(root, state.workerContextPackageFiles, 'threads/');
}

/** Reads and validates one optional monthly JSONL family. */
function readMonthlyLedger<T>(
  root: string,
  relativeDirectory: string,
  schema: z.ZodType<T>,
  timestamp: (row: T) => string,
  repairFinalFragment = false
): ReadonlyMap<string, readonly T[]> {
  const workspaceRoot = resolve(root);

  assertCanonicalDirectory(workspaceRoot);
  const directory = workspaceDirectory(workspaceRoot, relativeDirectory, false);
  const ledgers = new Map<string, readonly T[]>();

  if (!directory) {
    return ledgers;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Portable workspace path must not be a symbolic link: ${join(directory, entry.name)}.`
      );
    }
    if (!entry.isFile() || !/^\d{6}\.jsonl$/.test(entry.name)) {
      throw new Error(
        `Portable ledger directory contains an invalid entry: ${join(directory, entry.name)}.`
      );
    }
    const month = entry.name.slice(0, 6);
    const rows = readCanonicalJsonLines(join(directory, entry.name), repairFinalFragment).map(
      (row) => schema.parse(row)
    );

    for (const row of rows) {
      assertLedgerMonth(month, timestamp(row));
    }
    ledgers.set(month, rows);
  }
  return ledgers;
}

/** Appends one strictly validated row to the monthly ledger selected by its timestamp. */
function appendMonthlyLedgerRow<T>(
  root: string,
  relativeDirectory: string,
  input: T,
  schema: z.ZodType<T>,
  timestamp: (row: T) => string
): void {
  const workspaceRoot = resolve(root);
  const row = schema.parse(input);
  const month = ledgerMonth(timestamp(row));

  assertCanonicalDirectory(workspaceRoot);
  const directory = workspaceDirectory(workspaceRoot, relativeDirectory, true);
  if (!directory) {
    throw new Error(`Portable ledger directory was not created: ${relativeDirectory}.`);
  }
  appendCanonicalTextFile(join(directory, `${month}.jsonl`), `${JSON.stringify(row)}\n`);
}

/** Writes one monthly JSONL family without changing row order. */
function writeMonthlyLedger<T>(
  root: string,
  relativeDirectory: string,
  ledgers: ReadonlyMap<string, readonly T[]>,
  schema: z.ZodType<T>,
  timestamp: (row: T) => string
): void {
  if (ledgers.size === 0) {
    return;
  }
  const directory = workspaceDirectory(root, relativeDirectory, true);

  if (!directory) {
    throw new Error(`Portable ledger directory was not created: ${relativeDirectory}.`);
  }
  for (const [month, inputRows] of [...ledgers].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const rows = parseLedgerMonth(month, inputRows, schema, timestamp);
    const path = join(directory, `${month}.jsonl`);
    if (lstatSync(path, { throwIfNoEntry: false })) {
      throw new Error(`Portable staging ledger already exists: ${path}.`);
    }
    appendCanonicalTextFile(
      path,
      rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''
    );
  }
}

/** Serializes monthly ledger maps without losing month or append order. */
function serializeMonthlyLedger<T>(
  ledgers: ReadonlyMap<string, readonly T[]>,
  schema: z.ZodType<T>,
  timestamp: (row: T) => string
): string {
  const rows = [...ledgers]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([month, inputRows]) => parseLedgerMonth(month, inputRows, schema, timestamp));
  return rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

/** Parses and validates every row stored under one monthly ledger key. */
function parseLedgerMonth<T>(
  month: string,
  inputRows: readonly T[],
  schema: z.ZodType<T>,
  timestamp: (row: T) => string
): T[] {
  if (!/^\d{6}$/.test(month)) {
    throw new Error(`Portable ledger month is invalid: ${month}.`);
  }
  const rows = inputRows.map((row) => schema.parse(row));
  for (const row of rows) {
    assertLedgerMonth(month, timestamp(row));
  }
  return rows;
}

/** Ensures one row lives in the month selected by its authoritative append timestamp. */
function assertLedgerMonth(month: string, timestamp: string): void {
  if (ledgerMonth(timestamp) !== month) {
    throw new Error(`Portable ledger row timestamp does not match month ${month}: ${timestamp}.`);
  }
}

/** Returns the canonical YYYYMM ledger month selected by one ISO-like timestamp. */
function ledgerMonth(timestamp: string): string {
  const match = /^(\d{4})-(\d{2})-/.exec(timestamp);

  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new Error(`Portable ledger row timestamp is invalid: ${timestamp}.`);
  }
  return `${match[1]}${match[2]}`;
}

/** Reads one optional exact text file after verifying every existing parent directory. */
function readOptionalText(root: string, relativePath: string): string | null {
  const directory = workspaceDirectory(root, dirname(relativePath), false);
  if (!directory) {
    return null;
  }
  const path = join(directory, relativePath.split('/').at(-1) ?? '');
  return lstatSync(path, { throwIfNoEntry: false }) ? readCanonicalTextFile(path) : null;
}

/** Reads every portable OKF page, including exact canonical openkit_entry_id pages. */
function readNativeKnowledgePages(root: string): ReadonlyMap<string, string> {
  return new Map(
    [...readTextTree(root, 'knowledge/pages', true)].filter(([path]) => path.endsWith('.md'))
  );
}

/** Reads only complete worker Context Package trees owned by canonical Turns. */
function readWorkerContextPackageFiles(
  root: string,
  turns: readonly { readonly threadId: string; readonly turnId: string }[]
): ReadonlyMap<string, string> {
  const knownTurns = new Set(
    turns.map(({ threadId, turnId }) => {
      safeRelativeSegments(`threads/${threadId}/turns/${turnId}`);
      return `${threadId}\0${turnId}`;
    })
  );
  if (knownTurns.size !== turns.length) {
    throw new Error('Portable worker Context Package Turn identities must be unique.');
  }
  const files = new Map<string, string>();
  const threadsDirectory = workspaceDirectory(root, 'threads', false);
  if (!threadsDirectory) {
    return files;
  }

  for (const thread of readdirSync(threadsDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (thread.isSymbolicLink()) {
      throw new Error(`Portable workspace path must not be a symbolic link: ${thread.name}.`);
    }
    if (!thread.isDirectory()) {
      continue;
    }
    const turnsDirectory = workspaceDirectory(root, `threads/${thread.name}/turns`, false);
    if (!turnsDirectory) {
      continue;
    }
    for (const turn of readdirSync(turnsDirectory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (turn.isSymbolicLink()) {
        throw new Error(`Portable workspace path must not be a symbolic link: ${turn.name}.`);
      }
      if (!turn.isDirectory()) {
        continue;
      }
      const turnPath = `threads/${thread.name}/turns/${turn.name}`;
      const turnDirectory = workspaceDirectory(root, turnPath, false);
      if (!turnDirectory) {
        throw new Error(`Portable worker Context Package Turn is unavailable: ${turnPath}.`);
      }
      const tracePath = `${turnPath}/context-package.json`;
      const packagePath = `${turnPath}/context-package`;
      const trace = lstatSync(join(turnDirectory, 'context-package.json'), {
        throwIfNoEntry: false,
      });
      const packageDirectory = lstatSync(join(turnDirectory, 'context-package'), {
        throwIfNoEntry: false,
      });
      if (!trace && !packageDirectory) {
        continue;
      }
      if (!knownTurns.has(`${thread.name}\0${turn.name}`)) {
        throw new Error(`Portable worker Context Package has no canonical Turn: ${turnPath}.`);
      }
      if (!trace?.isFile() || !packageDirectory?.isDirectory()) {
        throw new Error(`Portable worker Context Package tree is incomplete: ${turnPath}.`);
      }
      files.set(tracePath, readCanonicalTextFile(join(turnDirectory, 'context-package.json')));
      for (const entry of readTextTree(root, packagePath, true)) {
        files.set(...entry);
      }
    }
  }
  assertWorkerContextPackageFiles(files);
  return files;
}

/** Requires every text-map entry to belong to one complete worker Context Package tree. */
function assertWorkerContextPackageFiles(files: ReadonlyMap<string, string>): void {
  const roots = new Map<string, { packageManifest: boolean; trace: boolean }>();
  for (const [path, content] of files) {
    const match =
      /^threads\/([^/]+)\/turns\/([^/]+)\/(context-package\.json|context-package\/(.+))$/.exec(
        path
      );
    if (!match || typeof content !== 'string') {
      throw new Error(`Portable worker Context Package path is invalid: ${path}.`);
    }
    if (match[3] === 'context-package.json') {
      const trace = JSON.parse(content) as {
        readonly threadId?: unknown;
        readonly turnId?: unknown;
      };
      if (trace.threadId !== match[1] || trace.turnId !== match[2]) {
        throw new Error('Worker Context Package trace path lineage is contradictory.');
      }
    }
    const root = `threads/${match[1]}/turns/${match[2]}`;
    const state = roots.get(root) ?? { packageManifest: false, trace: false };
    state.trace ||= match[3] === 'context-package.json';
    state.packageManifest ||= match[3] === 'context-package/package.json';
    roots.set(root, state);
  }
  for (const [root, state] of roots) {
    if (!state.trace || !state.packageManifest) {
      throw new Error(`Portable worker Context Package tree is incomplete: ${root}.`);
    }
  }
}

/** Reads exact UTF-8 files below one optional verified directory tree. */
function readTextTree(
  root: string,
  relativeDirectory: string,
  recursive: boolean
): ReadonlyMap<string, string> {
  const directory = workspaceDirectory(root, relativeDirectory, false);
  const files = new Map<string, string>();

  if (!directory) {
    return files;
  }
  const visit = (current: string, relativeCurrent: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(current, entry.name);
      const relativePath = `${relativeCurrent}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Portable workspace path must not be a symbolic link: ${path}.`);
      }
      if (entry.isDirectory() && recursive) {
        assertCanonicalDirectory(path);
        visit(path, relativePath);
      } else if (entry.isFile()) {
        files.set(relativePath, readCanonicalTextFile(path));
      } else {
        throw new Error(`Portable workspace tree contains an invalid entry: ${path}.`);
      }
    }
  };

  visit(directory, relativeDirectory);
  return files;
}

/** Writes exact text-map entries beneath their single allowed workspace-relative prefix. */
function writeTextMap(
  root: string,
  files: ReadonlyMap<string, string>,
  requiredPrefix: string,
  replace: boolean
): void {
  for (const [path, content] of files) {
    if (!path.startsWith(requiredPrefix) || typeof content !== 'string') {
      throw new Error(`Portable workspace file is outside ${requiredPrefix}: ${path}.`);
    }
    writeText(root, path, content, replace);
  }
}

/** Writes one validated workspace-relative text map under the export namespace. */
function writeExportTextMap(
  root: string,
  files: ReadonlyMap<string, string>,
  requiredPrefix: string
): void {
  for (const [path, content] of files) {
    if (!path.startsWith(requiredPrefix)) {
      throw new Error(`Portable workspace file is outside ${requiredPrefix}: ${path}.`);
    }
    writeText(root, `workspace-files/${path}`, content, false);
  }
}

/** Writes one exact text file without following a target link. */
function writeText(root: string, relativePath: string, content: string, replace: boolean): void {
  const segments = safeRelativeSegments(relativePath);
  const directory = workspaceDirectory(root, segments.slice(0, -1).join('/'), true);
  if (!directory) {
    throw new Error(`Portable workspace directory was not created: ${relativePath}.`);
  }
  const path = join(directory, segments.at(-1) ?? '');
  const exists = lstatSync(path, { throwIfNoEntry: false });
  if (exists && !replace) {
    throw new Error(`Portable staging file already exists: ${path}.`);
  }
  if (exists) {
    readCanonicalTextFile(path);
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exists ? constants.O_TRUNC : constants.O_EXCL),
    0o600
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Portable workspace path must be a regular file: ${path}.`);
    }
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

/** Resolves or creates a real directory beneath the verified workspace root. */
function workspaceDirectory(root: string, relativePath: string, create: boolean): string | null {
  let current = root;
  for (const segment of safeRelativeSegments(relativePath)) {
    current = join(current, segment);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (!metadata) {
      if (!create) {
        return null;
      }
      mkdirSync(current);
    }
    assertCanonicalDirectory(current);
  }
  return current;
}

/** Validates one normalized workspace-relative path and returns its segments. */
function safeRelativeSegments(path: string): string[] {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0')) {
    throw new Error(`Portable workspace path must be relative: ${path}.`);
  }
  const segments = path.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Portable workspace path is invalid: ${path}.`);
  }
  return segments;
}
