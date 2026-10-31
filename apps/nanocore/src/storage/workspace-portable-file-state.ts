import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { ProductRetrievalTrace } from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import {
  compareCodeUnits,
  type RetrievalTraceReference,
  RetrievalTraceReferenceSchema,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { parseJsoncObject } from '../config/jsonc.js';
import { assertPortableKnowledgeOverview } from '../context/knowledge-overview.js';
import { readPortableWorkspaceNotebookPages } from '../knowledge/notebook-workspace-portability.js';
import { reserveCanonicalFileWrite } from './canonical-write-capacity.js';
import { validateRecurringPortableHistory } from './recurring-portable-history.js';
import { StoredProductRetrievalTraceV1Schema } from './retrieval-trace-retained-v1.js';
import { assertRetrievalTraceIdentity, retrievalTraceRelativePath } from './retrieval-traces.js';
import {
  assertCanonicalDirectory,
  readAdmittedWorkspaceKnowledgeSelection,
  readCanonicalTextFile,
} from './workspace-file-records.js';

const RetrievalTraceReaderSchema = StoredProductRetrievalTraceV1Schema;

/** Authoritative file-backed workspace state that is portable but not owned by canonical protocol records. */
export interface WorkspacePortableFileState {
  /** Immutable imported source history; never interpreted as target schedule authority. */
  readonly recurringHistory?: string | null;
  /** Immutable query-owned retrieval traces keyed by canonical Workspace-relative path. */
  readonly retrievalTraceFiles: ReadonlyMap<string, ProductRetrievalTrace>;
  /** Exact workspace configuration text, or null when absent. */
  readonly workspaceConfig: string | null;
  /** Exact workspace knowledge schema text, or null when absent. */
  readonly workspaceSchema: string | null;
  /** One source published commit; archive provenance only, never a target permission. */
  readonly notebookRevision?: string;
  /** Exact portable OKF page text keyed by workspace-relative path. */
  readonly nativeKnowledgePages: ReadonlyMap<string, string>;
  /** Turn-owned worker Context Package traces and exact worker-visible text files. */
  readonly workerContextPackageFiles: ReadonlyMap<string, string>;
}

/** Canonical Workspace, Thread, and Turn owners admitted for portable file reads. */
export interface WorkspacePortableOwnerGraph {
  /** Workspace that owns every portable path. */
  readonly workspaceId: string;
  /** Canonical Threads that may own Thread-level traces. */
  readonly threads: readonly { readonly threadId: string }[];
  /** Canonical Turns that may own Turn-level traces and Context Packages. */
  readonly turns: readonly { readonly threadId: string; readonly turnId: string }[];
}

/**
 * Reads all authoritative portable file state beneath one real workspace root.
 *
 * @param workspaceRoot Published source workspace root.
 * @param owners Canonical Workspace, Thread, and Turn identities allowed to own portable trees.
 * @returns Strictly parsed ledgers and exact portable text files.
 * @throws Error for malformed rows, invalid month placement, links, or non-regular files.
 */
export function readWorkspacePortableFileState(
  workspaceRoot: string,
  owners: WorkspacePortableOwnerGraph
): WorkspacePortableFileState {
  const root = resolve(workspaceRoot);

  assertCanonicalDirectory(root);
  const selection = readAdmittedWorkspaceKnowledgeSelection(root, owners.workspaceId);
  const recurringHistory = readOptionalText(root, 'imports/recurrence-history.json');
  if (recurringHistory !== null) validateRecurringPortableHistory(recurringHistory);
  return {
    recurringHistory,
    retrievalTraceFiles: readWorkspaceRetrievalTraceFiles(root, owners),
    workspaceConfig: readOptionalText(root, 'config/workspace.jsonc'),
    workspaceSchema: selection.scopeSchemaText,
    ...readPortableWorkspaceNotebookPages(root, selection),
    workerContextPackageFiles: readWorkerContextPackageFiles(root, owners.turns),
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
  if (state.recurringHistory != null) {
    validateRecurringPortableHistory(state.recurringHistory);
    writeText(root, 'imports/recurrence-history.json', state.recurringHistory, false);
  }
  if (state.workspaceConfig !== null) {
    const imported = readRetainedV1(parseJsoncObject(state.workspaceConfig), (value) =>
      WorkspaceConfigSchema.parse(value)
    );
    const initializedConfig = readOptionalText(root, 'config/workspace.jsonc');
    if (initializedConfig !== null) {
      // Native Notebook initialization fixes the target base before portable config is staged.
      const initialized = readRetainedV1(parseJsoncObject(initializedConfig), (value) =>
        WorkspaceConfigSchema.parse(value)
      );
      if (
        !initialized.workspace.defaultKnowledgeBaseId ||
        initialized.workspace.defaultKnowledgeBaseId !== imported.workspace.defaultKnowledgeBaseId
      )
        throw new Error(
          'Portable configuration contradicts the initialized Knowledge Base binding.'
        );
    }
    writeText(root, 'config/workspace.jsonc', state.workspaceConfig, initializedConfig !== null);
  }
  if (state.workspaceSchema !== null) {
    writeText(root, 'knowledge/schema/scope-schema.yaml', state.workspaceSchema, true);
  }
  writeWorkspaceRetrievalTraceFiles(root, state.retrievalTraceFiles);
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

  assertCanonicalDirectory(root);
  if (!state) {
    return;
  }
  if (state.workspaceConfig !== null) {
    writeText(root, 'workspace-files/config/workspace.jsonc', state.workspaceConfig, false);
  }
  if (state.workspaceSchema !== null) {
    writeText(
      root,
      'workspace-files/knowledge/schema/scope-schema.yaml',
      state.workspaceSchema,
      false
    );
  }
  writeExportTextMap(root, state.nativeKnowledgePages, 'knowledge/pages/');
  writeWorkspaceRetrievalTraceExportFiles(root, state.retrievalTraceFiles);
  assertWorkerContextPackageFiles(state.workerContextPackageFiles);
  writeExportTextMap(root, state.workerContextPackageFiles, 'threads/');
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

/** Parses one query-owned trace file and binds its body to its canonical Workspace-relative path. */
export function parseWorkspaceRetrievalTraceFile(
  relativePath: string,
  text: string,
  expectedWorkspaceId: string
): { readonly reference: RetrievalTraceReference; readonly trace: ProductRetrievalTrace } {
  safeRelativeSegments(relativePath);
  const turnMatch = /^threads\/([^/]+)\/turns\/([^/]+)\/retrieval-traces\/([^/]+)\.json$/.exec(
    relativePath
  );
  const threadMatch = /^threads\/([^/]+)\/retrieval-traces\/([^/]+)\.json$/.exec(relativePath);
  if (!turnMatch && !threadMatch) {
    throw new Error(`Portable retrieval trace path is invalid: ${relativePath}.`);
  }
  const reference = RetrievalTraceReferenceSchema.parse({
    scopeId: turnMatch
      ? `retrieval-trace/turn/${expectedWorkspaceId}/${turnMatch[1]}/${turnMatch[2]}`
      : `retrieval-trace/thread/${expectedWorkspaceId}/${threadMatch![1]}`,
    objectId: turnMatch ? turnMatch[3] : threadMatch![2],
  });
  const trace = readRetainedV1(JSON.parse(text), (value) =>
    RetrievalTraceReaderSchema.parse(value)
  );
  assertRetrievalTraceIdentity(reference, trace);
  return { reference, trace };
}

/** Serializes only normalized trace evidence; ignored additions cannot enter export or import. */
export function serializeWorkspaceRetrievalTrace(trace: ProductRetrievalTrace): string {
  return `${JSON.stringify(writeRetainedV1(RetrievalTraceReaderSchema.parse(trace)))}\n`;
}

/** Reads every trace file whose path has one canonical Thread or Turn owner. */
function readWorkspaceRetrievalTraceFiles(
  root: string,
  owners: WorkspacePortableOwnerGraph
): ReadonlyMap<string, ProductRetrievalTrace> {
  if (workspaceDirectory(root, 'knowledge/traces', false)) {
    throw new Error('The retired Knowledge retrieval trace ledger is unsupported.');
  }
  const knownThreads = new Set(owners.threads.map(({ threadId }) => threadId));
  const knownTurns = new Set(
    owners.turns.map(({ threadId, turnId }) => {
      if (!knownThreads.has(threadId)) {
        throw new Error(`Portable Turn has no canonical Thread: ${threadId}/${turnId}.`);
      }
      return `${threadId}\0${turnId}`;
    })
  );
  if (knownThreads.size !== owners.threads.length || knownTurns.size !== owners.turns.length) {
    throw new Error('Portable retrieval trace owners must be unique.');
  }
  const files = new Map<string, ProductRetrievalTrace>();
  const threadsDirectory = workspaceDirectory(root, 'threads', false);
  if (!threadsDirectory) return files;

  for (const thread of readdirSync(threadsDirectory, { withFileTypes: true }).sort((a, b) =>
    compareCodeUnits(a.name, b.name)
  )) {
    if (thread.isSymbolicLink()) {
      throw new Error(`Portable workspace path must not be a symbolic link: ${thread.name}.`);
    }
    if (!thread.isDirectory()) continue;
    const threadRoot = `threads/${thread.name}`;
    const threadTraces = workspaceDirectory(root, `${threadRoot}/retrieval-traces`, false);
    if (threadTraces) {
      if (!knownThreads.has(thread.name)) {
        throw new Error(`Portable retrieval trace has no canonical Thread: ${thread.name}.`);
      }
      readRetrievalTraceDirectory(
        root,
        `${threadRoot}/retrieval-traces`,
        owners.workspaceId,
        files
      );
    }
    const turnsDirectory = workspaceDirectory(root, `${threadRoot}/turns`, false);
    if (!turnsDirectory) continue;
    for (const turn of readdirSync(turnsDirectory, { withFileTypes: true }).sort((a, b) =>
      compareCodeUnits(a.name, b.name)
    )) {
      if (turn.isSymbolicLink()) {
        throw new Error(`Portable workspace path must not be a symbolic link: ${turn.name}.`);
      }
      if (!turn.isDirectory()) continue;
      const traceRoot = `${threadRoot}/turns/${turn.name}/retrieval-traces`;
      const traceDirectory = workspaceDirectory(root, traceRoot, false);
      if (!traceDirectory) continue;
      if (!knownTurns.has(`${thread.name}\0${turn.name}`)) {
        throw new Error(
          `Portable retrieval trace has no canonical Turn: ${thread.name}/${turn.name}.`
        );
      }
      readRetrievalTraceDirectory(root, traceRoot, owners.workspaceId, files);
    }
  }
  return files;
}

/** Reads one strict immutable trace directory without accepting alternate entries. */
function readRetrievalTraceDirectory(
  root: string,
  relativeDirectory: string,
  workspaceId: string,
  files: Map<string, ProductRetrievalTrace>
): void {
  const directory = workspaceDirectory(root, relativeDirectory, false);
  if (!directory) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareCodeUnits(a.name, b.name)
  )) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Portable workspace path must not be a symbolic link: ${relativePath}.`);
    }
    if (!entry.isFile()) {
      throw new Error(
        `Portable retrieval trace directory contains an invalid entry: ${relativePath}.`
      );
    }
    if (/^\.krt_[0-9a-f-]+\.[0-9a-f-]+\.tmp$/.test(entry.name)) continue;
    if (!/^krt_[^/]+\.json$/.test(entry.name)) {
      throw new Error(
        `Portable retrieval trace directory contains an invalid entry: ${relativePath}.`
      );
    }
    const { trace } = parseWorkspaceRetrievalTraceFile(
      relativePath,
      readCanonicalTextFile(join(directory, entry.name)),
      workspaceId
    );
    files.set(relativePath, trace);
  }
}

/** Writes reminted trace files into an unpublished staging Workspace. */
function writeWorkspaceRetrievalTraceFiles(
  root: string,
  files: ReadonlyMap<string, ProductRetrievalTrace>
): void {
  for (const [path, trace] of [...files].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const text = serializeWorkspaceRetrievalTrace(trace);
    const { reference } = parseWorkspaceRetrievalTraceFile(
      path,
      text,
      trace.queryContext.workspaceId
    );
    if (retrievalTraceRelativePath(reference) !== path) {
      throw new Error(`Portable retrieval trace path is contradictory: ${path}.`);
    }
    writeText(root, path, text, false);
  }
}

/** Writes admitted trace files under the portable export namespace. */
function writeWorkspaceRetrievalTraceExportFiles(
  root: string,
  files: ReadonlyMap<string, ProductRetrievalTrace>
): void {
  for (const [path, trace] of [...files].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const text = serializeWorkspaceRetrievalTrace(trace);
    parseWorkspaceRetrievalTraceFile(path, text, trace.queryContext.workspaceId);
    writeText(root, `workspace-files/${path}`, text, false);
  }
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
    compareCodeUnits(a.name, b.name)
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
      compareCodeUnits(a.name, b.name)
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
    if (match[4] === 'knowledge-overview.md') assertPortableKnowledgeOverview(content);
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
      compareCodeUnits(a.name, b.name)
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
  const byteLength = Buffer.byteLength(content, 'utf8');
  const reservation = reserveCanonicalFileWrite(byteLength);
  let descriptor: number | undefined;
  let release = true;
  let opened = false;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        (exists ? constants.O_TRUNC : constants.O_EXCL),
      0o600
    );
    opened = true;
    release = false;
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Portable workspace path must be a regular file: ${path}.`);
    }
    writeFileSync(descriptor, content);
    reservation?.recordWritten(byteLength);
    closeSync(descriptor);
    descriptor = undefined;
    reservation?.assertAvailable();
    release = true;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
    }
    // This writer owns only unpublished staging files. Failed cleanup keeps its reservation.
    if (opened) rmSync(path, { force: true });
    release = true;
    throw error;
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      if (release) reservation?.release();
    }
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
