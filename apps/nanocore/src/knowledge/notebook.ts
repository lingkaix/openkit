import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { KnowledgeNotebookCommitMetadataSchema } from '@openkit/protocol';
import type { z } from 'zod';

const PUBLISHED_REF = 'refs/heads/published';
const FILE_BYTES = 2 * 1024 * 1024;
const EDITING_BYTES = 32 * 1024 * 1024;
const EMPTY_INDEX = '---\nokf_version: "0.2"\n---\n# Notebook\n';
/** The shared typed commit facts also supply the existing Audit owner's pre-publication projection. */
export const NotebookCommitMetadataSchema = KnowledgeNotebookCommitMetadataSchema;

/** Exact metadata serialized as the complete service-owned Git commit message. */
export type NotebookCommitMetadata = z.infer<typeof NotebookCommitMetadataSchema>;

/** Immutable notebook bytes and historical admission facts read from one Git commit. */
export interface NotebookRevision {
  readonly revision: string;
  readonly parentRevision: string | null;
  readonly files: Readonly<Record<string, string>>;
  readonly metadata: NotebookCommitMetadata;
}

/** Closed content-owner failure; no host paths or Git diagnostics enter product errors. */
export class NotebookError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'conflict' | 'recovery_required',
    readonly currentRevision?: string
  ) {
    super(`Notebook ${code.replaceAll('_', ' ')}.`);
  }
}

/** Checks bundle-relative Markdown paths before any Git input or filesystem projection. */
function validPath(path: string): boolean {
  return (
    Buffer.byteLength(path) <= 243 &&
    !isAbsolute(path) &&
    !/[\\@]/.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    path.endsWith('.md') &&
    path
      .slice(0, -3)
      .split('/')
      .every((part) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(part) && part !== '.' && part !== '..') &&
    !path.slice(0, -3).endsWith('.md') &&
    !path.split('/').some((part) => part.toLowerCase() === '.git')
  );
}

/** Validates transport-independent limits; OKF/schema/source admission belongs to the common publisher caller. */
function validateFiles(files: Readonly<Record<string, string>>, editing = false): void {
  let total = 0;
  const folded = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (
      !validPath(path) ||
      typeof text !== 'string' ||
      Buffer.from(text).toString('utf8') !== text ||
      (editing && Buffer.byteLength(text) > FILE_BYTES)
    )
      throw new NotebookError('invalid_request');
    const normalized = path.toLowerCase();
    if (folded.has(normalized)) throw new NotebookError('invalid_request');
    folded.add(normalized);
    total += Buffer.byteLength(text);
  }
  if ((editing && total > EDITING_BYTES) || (!editing && !Object.hasOwn(files, 'index.md')))
    throw new NotebookError('invalid_request');
}

/** Rejects filesystem indirection at every existing ancestor of the trusted repository path. */
function checkRepositoryPath(path: string): void {
  let part = resolve(path);
  while (true) {
    const stat = lstatSync(part, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new NotebookError('recovery_required');
    const parent = dirname(part);
    if (parent === part) return;
    part = parent;
  }
}

/** Rejects Git-local alternate stores, config includes and linked metadata before Git can read outside this owner. */
function checkGitInternals(repositoryPath: string): void {
  if (!lstatSync(repositoryPath, { throwIfNoEntry: false })) return;
  for (const forbidden of [
    'commondir',
    'gitdir',
    'shallow',
    'info/grafts',
    'objects/info/alternates',
    'objects/info/http-alternates',
  ])
    if (lstatSync(join(repositoryPath, forbidden), { throwIfNoEntry: false }))
      throw new NotebookError('recovery_required');
  const inspect = (path: string): void => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new NotebookError('recovery_required');
    if (stat.isDirectory()) for (const entry of readdirSync(path)) inspect(join(path, entry));
  };
  for (const path of ['objects', 'refs', 'HEAD', 'config', 'packed-refs'])
    inspect(join(repositoryPath, path));
  const config = join(repositoryPath, 'config');
  if (lstatSync(config, { throwIfNoEntry: false })) {
    const text = readFileSync(config, 'utf8');
    if (
      !/^\[core\]\r?\n\trepositoryformatversion = 0\r?\n\tfilemode = (?:true|false)\r?\n\tbare = true\r?\n$/.test(
        text
      )
    )
      throw new NotebookError('recovery_required');
  }
}

/** Flushes directory entries after Git flushes its object/ref files through core.fsync=all. */
function syncDirectory(path: string, recursive = false): void {
  if (recursive)
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new NotebookError('recovery_required');
      if (entry.isDirectory()) syncDirectory(join(path, entry.name), true);
    }
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** One bare Git content authority; it owns no live authorization, command receipts or editing lifecycle. */
export class KnowledgeNotebook {
  private readonly repositoryPath: string;

  constructor(input: { readonly repositoryPath: string }) {
    this.repositoryPath = resolve(input.repositoryPath);
    checkRepositoryPath(this.repositoryPath);
  }

  /** Runs fixed plumbing with ambient Git configuration, hooks, network and callbacks disabled. */
  private git(args: readonly string[], input?: string, author = 'OpenKit'): string {
    try {
      checkRepositoryPath(this.repositoryPath);
      checkGitInternals(this.repositoryPath);
      const output = execFileSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.fsync=all',
          '-c',
          'core.fsyncMethod=fsync',
          '-c',
          'core.logAllRefUpdates=false',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          '-c',
          'protocol.allow=never',
          '-c',
          'commit.gpgSign=false',
          '-c',
          'core.attributesFile=/dev/null',
          `--git-dir=${this.repositoryPath}`,
          ...args,
        ],
        {
          encoding: 'buffer',
          input: input === undefined ? undefined : Buffer.from(input),
          maxBuffer: EDITING_BYTES + 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            LANG: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_AUTHOR_NAME: author,
            GIT_AUTHOR_EMAIL: 'openkit',
            GIT_COMMITTER_NAME: 'OpenKit',
            GIT_COMMITTER_EMAIL: 'openkit',
          },
        }
      );
      return new TextDecoder('utf-8', { fatal: true }).decode(output);
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Establishes a fresh notebook once; a partial or initialized repository is never replaced. */
  initialize(input: {
    readonly files?: Readonly<Record<string, string>>;
    readonly metadata: NotebookCommitMetadata;
  }): string {
    const metadata = NotebookCommitMetadataSchema.safeParse(input.metadata);
    const files = { 'index.md': EMPTY_INDEX, ...input.files };
    if (!metadata.success) throw new NotebookError('invalid_request');
    validateFiles(files);
    if (lstatSync(this.repositoryPath, { throwIfNoEntry: false }))
      throw new NotebookError('recovery_required');
    mkdirSync(dirname(this.repositoryPath), { recursive: true });
    this.git(['init', '--bare', '--initial-branch=published', this.repositoryPath]);
    const entries = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        this.git(['hash-object', '-w', '--stdin'], content).trim(),
      ])
    );
    const revision = this.createCommit(entries, metadata.data, null);
    this.git(['update-ref', PUBLISHED_REF, revision, '0'.repeat(revision.length)]);
    this.syncRefs();
    syncDirectory(dirname(this.repositoryPath));
    return revision;
  }

  /** Pins the complete current revision; missing or invalid initialized content fails closed. */
  publishedRevision(): string {
    const revision = this.git(['rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`]).trim();
    this.inspectRevision(revision);
    return revision;
  }

  /** Pins strict metadata and immutable tree identities without loading omitted page bodies. */
  inspectRevision(
    revision: string
  ): Omit<NotebookRevision, 'files'> & { readonly entries: Readonly<Record<string, string>> } {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
      throw new NotebookError('recovery_required');
    const commit = this.git(['cat-file', 'commit', revision]);
    const boundary = commit.indexOf('\n\n');
    const headers = commit.slice(0, boundary).split('\n');
    const parents = headers.filter((header) => header.startsWith('parent '));
    const message = commit.slice(boundary + 2);
    let metadata: NotebookCommitMetadata;
    try {
      const parsed: unknown = JSON.parse(message);
      metadata = NotebookCommitMetadataSchema.parse(parsed);
      // Service serialization also rejects duplicate keys and trailing JSON fragments.
      if (message !== `${JSON.stringify(metadata)}\n`) throw new Error('Invalid metadata.');
    } catch {
      throw new NotebookError('recovery_required');
    }
    if (
      boundary < 0 ||
      parents.length > 1 ||
      !headers.some((header) => header.startsWith('author '))
    )
      throw new NotebookError('recovery_required');
    const entries: Record<string, string> = Object.create(null);
    for (const row of this.git(['ls-tree', '-r', '-z', '--full-tree', revision]).split('\0')) {
      if (!row) continue;
      const match = /^100644 blob ([a-f0-9]+)\tpages\/(.+)$/.exec(row);
      if (!match || !validPath(match[2]!)) throw new NotebookError('recovery_required');
      entries[match[2]!] = match[1]!;
    }
    if (!Object.hasOwn(entries, 'index.md')) throw new NotebookError('recovery_required');
    return {
      revision,
      parentRevision: parents[0]?.slice('parent '.length) ?? null,
      entries,
      metadata,
    };
  }

  /** Reads selected exact immutable page bytes; no omitted page enters the editing workspace. */
  readRevision(revision: string, paths?: readonly string[]): NotebookRevision {
    const { entries, ...record } = this.inspectRevision(revision);
    const files: Record<string, string> = Object.create(null);
    for (const path of paths ?? Object.keys(entries)) {
      const object = entries[path];
      if (!object) throw new NotebookError('invalid_request');
      files[path] = this.git(['cat-file', 'blob', object]);
    }
    return { ...record, files };
  }

  /** Creates an unpublished fixed-base candidate; validation/authority checks precede caller publication. */
  prepare(input: {
    readonly baseRevision: string;
    readonly changes: Readonly<Record<string, string | null>>;
    readonly metadata: NotebookCommitMetadata;
  }): string {
    if (Object.keys(input.changes).length > 256) throw new NotebookError('invalid_request');
    const metadata = NotebookCommitMetadataSchema.safeParse(input.metadata);
    if (!metadata.success) throw new NotebookError('invalid_request');
    const entries = { ...this.inspectRevision(input.baseRevision).entries };
    validateFiles(
      Object.fromEntries(
        Object.entries(input.changes).filter(
          (entry): entry is [string, string] => entry[1] !== null
        )
      ),
      true
    );
    for (const [path, value] of Object.entries(input.changes)) {
      if (!validPath(path) || (value !== null && typeof value !== 'string'))
        throw new NotebookError('invalid_request');
      if (value === null) delete entries[path];
      else entries[path] = this.git(['hash-object', '-w', '--stdin'], value).trim();
    }
    if (!Object.hasOwn(entries, 'index.md')) throw new NotebookError('invalid_request');
    return this.createCommit(entries, metadata.data, input.baseRevision);
  }

  /** Compares and sets the sole publication ref after the caller's final admission and Audit boundary. */
  publish(input: { readonly baseRevision: string; readonly candidateRevision: string }): {
    revision: string;
  } {
    const candidate = this.inspectRevision(input.candidateRevision);
    if (candidate.parentRevision !== input.baseRevision) throw new NotebookError('invalid_request');
    // Verify omitted retained blobs as well as edited files without admitting their bodies to the model workspace.
    this.git(['fsck', '--strict', '--no-reflogs', '--no-dangling', input.candidateRevision]);
    const current = this.publishedRevision();
    if (current !== input.baseRevision) throw new NotebookError('conflict', current);
    try {
      this.git(['update-ref', PUBLISHED_REF, input.candidateRevision, input.baseRevision]);
    } catch {
      const observed = this.publishedRevision();
      if (observed !== input.baseRevision && observed !== input.candidateRevision)
        throw new NotebookError('conflict', observed);
      // A missing or uncertain ref result cannot supply completed command evidence.
      throw new NotebookError('recovery_required');
    }
    this.syncRefs();
    return { revision: input.candidateRevision };
  }

  /** Retains exact required-review evidence without changing the published notebook. */
  retainCandidate(input: {
    readonly proposalId: string;
    readonly candidateRevision: string;
  }): void {
    if (!/^[A-Za-z0-9_-]+$/.test(input.proposalId)) throw new NotebookError('invalid_request');
    const candidate = this.inspectRevision(input.candidateRevision);
    if (!candidate.parentRevision) throw new NotebookError('invalid_request');
    const ref = `refs/proposals/${input.proposalId}`;
    this.git([
      'update-ref',
      ref,
      input.candidateRevision,
      '0'.repeat(input.candidateRevision.length),
    ]);
    syncDirectory(join(this.repositoryPath, 'refs'), true);
  }

  /** Returns retained published ancestry; source/owner disclosure remains the inspection caller's duty. */
  history(input: { readonly revision?: string } = {}): readonly NotebookRevision[] {
    const records: NotebookRevision[] = [];
    let revision: string | null = input.revision ?? this.publishedRevision();
    while (revision) {
      const record = this.readRevision(revision);
      records.push(record);
      revision = record.parentRevision;
    }
    return records;
  }

  /** Writes data-only blob/tree/commit objects; no working tree, filters or executable content is used. */
  private createCommit(
    objects: Readonly<Record<string, string>>,
    metadata: NotebookCommitMetadata,
    parent: string | null
  ): string {
    const tree = new Map<string, string | Map<string, unknown>>();
    for (const [path, object] of Object.entries(objects)) {
      let entries = tree;
      const parts = ['pages', ...path.split('/')];
      for (const segment of parts.slice(0, -1)) {
        const found = entries.get(segment);
        if (typeof found === 'string') throw new NotebookError('invalid_request');
        if (!found) entries.set(segment, new Map());
        entries = entries.get(segment) as typeof tree;
      }
      const basename = parts.at(-1)!;
      if (entries.has(basename)) throw new NotebookError('invalid_request');
      entries.set(basename, object);
    }
    const writeTree = (entries: typeof tree): string => {
      const rows = [...entries].map(([name, value]) =>
        typeof value === 'string'
          ? `100644 blob ${value}\t${name}\0`
          : `040000 tree ${writeTree(value as typeof tree)}\t${name}\0`
      );
      return this.git(['mktree', '-z'], rows.join('')).trim();
    };
    const root = writeTree(tree);
    const revision = this.git(
      ['commit-tree', root, ...(parent ? ['-p', parent] : []), '-F', '-'],
      `${JSON.stringify(metadata)}\n`,
      metadata.producer.id
    ).trim();
    syncDirectory(join(this.repositoryPath, 'objects'), true);
    syncDirectory(this.repositoryPath);
    return revision;
  }

  /** Makes the published reference and its parent directory entries durable before returning. */
  private syncRefs(): void {
    syncDirectory(join(this.repositoryPath, 'refs'), true);
    syncDirectory(this.repositoryPath);
  }
}
