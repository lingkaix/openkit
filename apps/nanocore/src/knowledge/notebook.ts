import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { setImmediate as yieldToMain } from 'node:timers/promises';
import {
  KNOWLEDGE_NOTEBOOK_COMMIT_SCHEMA_VERSION,
  KnowledgeNotebookCommitMetadataSchema,
  KnowledgeSourceIdSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { NotebookError } from './notebook-error.js';
import { assertSourcePointerEdit } from './source-pointer-codecs.js';

export { NotebookError, type NotebookLinkDiagnostic } from './notebook-error.js';

const PUBLISHED_REF = 'refs/heads/published';
const FILE_BYTES = 2 * 1024 * 1024;
const EDITING_BYTES = 32 * 1024 * 1024;
const GIT_OUTPUT_BYTES = EDITING_BYTES + 1024 * 1024;
/** Exact initial reserved navigation bytes used by fresh notebooks. */
export const DEFAULT_NOTEBOOK_INDEX = '---\nokf_version: "0.2"\n---\n# Notebook\n';
/** The shared typed commit facts also supply the existing Audit owner's pre-publication projection. */
export const NotebookCommitMetadataSchema = KnowledgeNotebookCommitMetadataSchema;

/** Historical admission facts; the service adds the retained commit format marker. */
export type NotebookCommitMetadata = z.infer<typeof NotebookCommitMetadataSchema>;

/** Immutable notebook bytes and historical admission facts read from one Git commit. */
export interface NotebookRevision {
  readonly revision: string;
  readonly parentRevision: string | null;
  /** Canonical curated Pages only; Source pointer blobs have a separate native reader. */
  readonly files: Readonly<Record<string, string>>;
  readonly metadata: NotebookCommitMetadata;
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

/** Validates Page files or transient edit maps; schema and authority remain with the publisher caller. */
export function validateNotebookFiles(
  files: Readonly<Record<string, string>>,
  editing = false
): void {
  let total = 0;
  const folded = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (
      !(
        validPath(path) ||
        (editing &&
          path.startsWith('@sources/') &&
          path.endsWith('.md') &&
          KnowledgeSourceIdSchema.safeParse(path.slice('@sources/'.length, -3)).success)
      ) ||
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

/** Private immutable tree/body result shared by both scheduling paths. */
interface NotebookInspection {
  readonly record: Omit<NotebookRevision, 'files'> & {
    readonly entries: Readonly<Record<string, string>>;
  };
  readonly tree: string;
  readonly blobs: readonly string[];
}

/** One fixed Git plumbing command shared by synchronous and asynchronous publication. */
interface NotebookGitCommand {
  readonly args: readonly string[];
  readonly input?: string;
  readonly author?: string;
}

/** One bare Git content authority; it owns no live authorization, command receipts or editing lifecycle. */
export class KnowledgeNotebook {
  private readonly repositoryPath: string;
  private readonly selectedRevision: string | undefined;
  /** Full verified reads belong to one publication only; no shared revision or authority cache. */
  private preparedReads?: {
    readonly device: number;
    readonly inode: number;
    readonly revisions: Map<
      string,
      {
        readonly tree: string;
        readonly record: ReturnType<KnowledgeNotebook['inspectRevision']>;
      }
    >;
    readonly blobs: Map<string, string>;
  };

  constructor(input: {
    readonly repositoryPath: string;
    /** Exact SQL-selected Workspace head; User and Server owners keep their Git ref selection. */
    readonly selectedRevision?: string;
  }) {
    this.repositoryPath = resolve(input.repositoryPath);
    this.selectedRevision = input.selectedRevision;
  }

  /** Builds fixed plumbing policy with ambient Git configuration, hooks, network and callbacks disabled. */
  private gitInvocation(args: readonly string[], input?: string, author = 'OpenKit') {
    try {
      // The repository itself is canonical storage; Git may not follow a substituted root.
      const root = lstatSync(this.repositoryPath, { throwIfNoEntry: false });
      if (root && (!root.isDirectory() || root.isSymbolicLink()))
        throw new NotebookError('recovery_required');
      return {
        args: [
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
        options: {
          encoding: 'buffer' as const,
          input: input === undefined ? undefined : Buffer.from(input),
          maxBuffer: GIT_OUTPUT_BYTES,
          stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
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
        },
      };
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Runs synchronous publication plumbing with the shared fixed policy. */
  private gitBytes(
    args: readonly string[],
    input?: string,
    author = 'OpenKit',
    maxBuffer = GIT_OUTPUT_BYTES
  ): Buffer {
    try {
      const command = this.gitInvocation(args, input, author);
      return execFileSync('git', command.args, { ...command.options, maxBuffer });
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Reads fixed plumbing off the event loop with the original output and error bounds. */
  private async gitBytesAsync(
    args: readonly string[],
    input?: string,
    author = 'OpenKit',
    maxBuffer = GIT_OUTPUT_BYTES
  ): Promise<Buffer> {
    try {
      const command = this.gitInvocation(args, input, author);
      return await new Promise<Buffer>((resolve, reject) => {
        const child = execFile(
          'git',
          command.args,
          { ...command.options, maxBuffer },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          }
        );
        child.stdin?.on('error', reject);
        child.stdin?.end(command.options.input);
      });
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Decodes asynchronous text with the original strict UTF-8 boundary. */
  private async gitAsync(
    args: readonly string[],
    input?: string,
    author = 'OpenKit'
  ): Promise<string> {
    try {
      const bytes = await this.gitBytesAsync(args, input, author);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Decodes textual plumbing output strictly; raw Git tree bytes stay inside the content owner. */
  private git(args: readonly string[], input?: string, author = 'OpenKit'): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.gitBytes(args, input, author));
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Verifies an original Source blob before applying its captured-field edit constraints. */
  private readBlob(object: string): string {
    this.assertPreparedRoot();
    const prepared = this.preparedReads?.blobs.get(object);
    if (prepared !== undefined) return prepared;
    return this.decodeBlob(object, this.readObjectsBatch([{ id: object, type: 'blob' }])[0]!);
  }

  /** Reads exactly the requested identities in one child, with the original per-object byte bound. */
  private readObjectsBatch(
    objects: readonly { readonly id: string; readonly type: 'commit' | 'blob' }[]
  ): Buffer[] {
    if (objects.some(({ id }) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)))
      throw new NotebookError('recovery_required');
    // A batch must not turn the old per-object bound into a smaller whole-notebook limit.
    // The extra 128 bytes cover each strict header and its terminating newline.
    const bytes = this.gitBytes(
      ['cat-file', '--batch'],
      objects.map(({ id }) => `${id}\n`).join(''),
      'OpenKit',
      objects.length * (GIT_OUTPUT_BYTES + 128)
    );
    return this.decodeObjectsBatch(objects, bytes);
  }

  /** Checks every frame and exact response count before either reader can return a blob. */
  private decodeObjectsBatch(
    objects: readonly { readonly id: string; readonly type: 'commit' | 'blob' }[],
    bytes: Buffer
  ): Buffer[] {
    let offset = 0;
    const result: Buffer[] = [];
    for (const object of objects) {
      const lineEnd = bytes.indexOf(10, offset);
      if (lineEnd < offset || lineEnd - offset > 127) throw new NotebookError('recovery_required');
      const header = /^([a-f0-9]{40}|[a-f0-9]{64}) (commit|blob) (0|[1-9][0-9]*)$/.exec(
        bytes.toString('latin1', offset, lineEnd)
      );
      const size = header ? Number(header[3]) : NaN;
      if (
        header?.[1] !== object.id ||
        header[2] !== object.type ||
        !Number.isSafeInteger(size) ||
        size > GIT_OUTPUT_BYTES
      )
        throw new NotebookError('recovery_required');
      const start = lineEnd + 1;
      const end = start + size;
      if (end >= bytes.length || bytes[end] !== 10) throw new NotebookError('recovery_required');
      result.push(bytes.subarray(start, end));
      offset = end + 1;
    }
    if (offset !== bytes.length) throw new NotebookError('recovery_required');
    return result;
  }

  /** Shares exact Git blob identity and strict content decoding across both read paths. */
  private decodeBlob(object: string, bytes: Buffer): string {
    const observed = createHash(object.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (observed !== object) throw new NotebookError('recovery_required');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Establishes a fresh notebook once; a partial or initialized repository is never replaced. */
  initialize(input: {
    readonly files?: Readonly<Record<string, string>>;
    readonly sourcePointers?: Readonly<Record<string, string>>;
    readonly metadata: NotebookCommitMetadata;
    readonly beforePublish?: (candidateRevision: string) => void;
  }): string {
    const revision = this.prepareInitialRevision(input);
    // Native fresh-scope admission retains its Audit evidence after the exact commit exists and before its ref does.
    input.beforePublish?.(revision);
    this.publishInitialRevision(revision);
    return revision;
  }

  /** Creates a fresh repository and its exact initial commit without publishing a current ref. */
  prepareInitialRevision(input: {
    readonly files?: Readonly<Record<string, string>>;
    readonly sourcePointers?: Readonly<Record<string, string>>;
    readonly metadata: NotebookCommitMetadata;
  }): string {
    const metadata = NotebookCommitMetadataSchema.safeParse(input.metadata);
    const files = { 'index.md': DEFAULT_NOTEBOOK_INDEX, ...input.files };
    if (!metadata.success) throw new NotebookError('invalid_request');
    validateNotebookFiles(files);
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
    const sources = Object.fromEntries(
      Object.entries(input.sourcePointers ?? {}).map(([id, content]) => {
        KnowledgeSourceIdSchema.parse(id);
        return [id, this.git(['hash-object', '-w', '--stdin'], content).trim()];
      })
    );
    return this.createCommit(entries, metadata.data, null, sources);
  }

  /** Publishes one validated parentless initial revision into a still-fresh repository. */
  publishInitialRevision(revision: string): void {
    if (this.inspectRevision(revision).parentRevision !== null)
      throw new NotebookError('invalid_request');
    this.git(['update-ref', PUBLISHED_REF, revision, '0'.repeat(revision.length)]);
  }

  /** Pins the complete current revision; missing or invalid initialized content fails closed. */
  publishedRevision(): string {
    return this.inspectPublishedRevision().revision;
  }

  /** Shares the validated current record within one operation, never across public calls. */
  private inspectPublishedRevision() {
    const revision =
      this.selectedRevision ??
      this.git(['rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`]).trim();
    return this.inspectRevision(revision);
  }

  /** Pins strict metadata and immutable tree identities without loading omitted page bodies. */
  inspectRevision(
    revision: string
  ): Omit<NotebookRevision, 'files'> & { readonly entries: Readonly<Record<string, string>> } {
    return this.inspectRevisionTree(revision).record;
  }

  /** Keeps one strict immutable tree within this operation; Source decoding stays at its original boundary. */
  private inspectRevisionTree(
    revision: string,
    select?: (
      entries: Readonly<Record<string, string>>,
      tree: string
    ) => {
      readonly objects: readonly string[];
      readonly missing?: boolean;
    }
  ): NotebookInspection {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
      throw new NotebookError('recovery_required');
    this.assertPreparedRoot();
    const prepared = this.preparedReads?.revisions.get(revision);
    const cachedSelection = prepared
      ? (select?.(prepared.record.entries, prepared.tree) ?? { objects: [] })
      : undefined;
    if (
      prepared &&
      cachedSelection?.objects.every((object) => this.preparedReads!.blobs.has(object))
    ) {
      const selected = cachedSelection;
      const blobs = selected.objects.map((object) => {
        const body = this.preparedReads!.blobs.get(object);
        if (body === undefined) throw new NotebookError('recovery_required');
        return body;
      });
      if (selected.missing) throw new NotebookError('invalid_request');
      return {
        record: {
          ...prepared.record,
          metadata: structuredClone(prepared.record.metadata),
          entries: Object.assign(Object.create(null), prepared.record.entries),
        },
        tree: prepared.tree,
        blobs,
      };
    }
    const tree = this.git(['ls-tree', '-r', '-z', '--full-tree', revision]);
    const entries = this.decodeTree(tree);
    const selected = select?.(entries, tree) ?? { objects: [] };
    const [commit, ...objects] = this.readObjectsBatch([
      { id: revision, type: 'commit' },
      ...selected.objects.map((id) => ({ id, type: 'blob' as const })),
    ]);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(commit);
    } catch {
      throw new NotebookError('recovery_required');
    }
    const record = this.decodeCommit(revision, text);
    const blobs = objects.map((bytes, index) => this.decodeBlob(selected.objects[index]!, bytes));
    if (selected.missing) throw new NotebookError('invalid_request');
    return {
      record: {
        revision,
        parentRevision: record.parentRevision,
        entries,
        metadata: record.metadata,
      },
      tree,
      blobs,
    };
  }

  /** Stops at the same first absent path as the sequential reader; omitted objects are never loaded. */
  private selectObjects(entries: Readonly<Record<string, string>>, paths: readonly string[]) {
    const objects: string[] = [];
    for (const path of paths) {
      if (!entries[path]) return { objects, missing: true };
      objects.push(entries[path]!);
    }
    return { objects };
  }

  /** Decodes the same canonical service commit metadata for both read paths. */
  private decodeCommit(revision: string, commit: string): Omit<NotebookRevision, 'files'> {
    const boundary = commit.indexOf('\n\n');
    const headers = commit.slice(0, boundary).split('\n');
    const parents = headers.filter((header) => header.startsWith('parent '));
    const message = commit.slice(boundary + 2);
    let metadata: NotebookCommitMetadata;
    try {
      const parsed: unknown = JSON.parse(message);
      metadata = NotebookCommitMetadataSchema.parse(parsed);
      // Historical absence keeps its original canonical bytes; explicit markers remain closed.
      const canonical =
        typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'schemaVersion')
          ? { schemaVersion: KNOWLEDGE_NOTEBOOK_COMMIT_SCHEMA_VERSION, ...metadata }
          : metadata;
      // Service serialization also rejects duplicate keys and trailing JSON fragments.
      if (message !== `${JSON.stringify(canonical)}\n`) throw new Error('Invalid metadata.');
    } catch {
      throw new NotebookError('recovery_required');
    }
    if (
      boundary < 0 ||
      parents.length > 1 ||
      !headers.some((header) => header.startsWith('author '))
    )
      throw new NotebookError('recovery_required');
    return { revision, parentRevision: parents[0]?.slice('parent '.length) ?? null, metadata };
  }

  /** Validates Page and Source tree entries and requires the reserved index. */
  private decodeTree(tree: string): Readonly<Record<string, string>> {
    const entries: Record<string, string> = Object.create(null);
    for (const row of tree.split('\0')) {
      if (!row) continue;
      const match = /^100644 blob ([a-f0-9]+)\t(pages|sources)\/(.+)$/.exec(row);
      if (!match || !validPath(match[3]!)) throw new NotebookError('recovery_required');
      if (match[2] === 'sources') {
        if (!KnowledgeSourceIdSchema.safeParse(match[3]!.slice(0, -3)).success)
          throw new NotebookError('recovery_required');
      } else entries[match[3]!] = match[1]!;
    }
    if (!Object.hasOwn(entries, 'index.md')) throw new NotebookError('recovery_required');
    return entries;
  }

  /** Reads selected exact immutable page bytes; no omitted page enters the editing workspace. */
  readRevision(revision: string, paths?: readonly string[]): NotebookRevision {
    let selected: readonly string[] = [];
    const {
      record: { entries: _entries, ...record },
      blobs,
    } = this.inspectRevisionTree(revision, (entries) => {
      selected = paths ?? Object.keys(entries);
      return this.selectObjects(entries, selected);
    });
    const files: Record<string, string> = Object.create(null);
    selected.forEach((path, index) => {
      files[path] = blobs[index]!;
    });
    return { ...record, files };
  }

  /** Reads only native Source pointer blobs from the same immutable Git tree as the pages. */
  readSourcePointers(revision: string): Readonly<Record<string, string>> {
    let selected: string[] = [];
    const { blobs } = this.inspectRevisionTree(revision, (_entries, tree) => {
      const sources = this.sourceObjects(revision, tree);
      selected = Object.keys(sources);
      return { objects: Object.values(sources) };
    });
    return Object.fromEntries(selected.map((id, index) => [id, blobs[index]!]));
  }

  /** Starts one operation-local immutable preparation, independent of any live authority decision. */
  async withPreparedReadsAsync(
    revisions: readonly string[],
    input: { readonly paths?: readonly string[]; readonly sources?: boolean } = {}
  ): Promise<KnowledgeNotebook> {
    const prepared = new KnowledgeNotebook({
      repositoryPath: this.repositoryPath,
      ...(this.selectedRevision ? { selectedRevision: this.selectedRevision } : {}),
    });
    let root: ReturnType<typeof lstatSync>;
    try {
      root = lstatSync(this.repositoryPath);
    } catch {
      throw new NotebookError('recovery_required');
    }
    if (!root.isDirectory() || root.isSymbolicLink()) throw new NotebookError('recovery_required');
    prepared.preparedReads = {
      device: root.dev,
      inode: root.ino,
      revisions: new Map(),
      blobs: new Map(),
    };
    for (const revision of revisions) await prepared.preloadRevisionAsync(revision, input);
    return prepared;
  }

  /** Verifies another complete exact revision in the same publication, never across calls. */
  async preloadRevisionAsync(
    revision: string,
    input: { readonly paths?: readonly string[]; readonly sources?: boolean } = {}
  ): Promise<void> {
    const sources = input.sources ?? true;
    if (!this.preparedReads) throw new NotebookError('recovery_required');
    const select = (pages: Readonly<Record<string, string>>, tree: string) => {
      const all = {
        ...pages,
        ...Object.fromEntries(
          Object.entries(this.sourceObjects(revision, tree)).map(([id, object]) => [
            `@sources/${id}.md`,
            object,
          ])
        ),
      };
      const selection = this.selectObjects(all, input.paths ?? Object.keys(pages));
      return {
        ...selection,
        objects: [
          ...selection.objects,
          ...(sources ? Object.values(this.sourceObjects(revision, tree)) : []),
        ],
      };
    };
    const prior = this.preparedReads.revisions.get(revision);
    if (prior) {
      const requested = select(prior.record.entries, prior.tree);
      if (
        !requested.missing &&
        requested.objects.every((object) => this.preparedReads!.blobs.has(object))
      ) {
        this.assertPreparedRoot();
        return;
      }
    }
    const inspected = await this.inspectRevisionTreeAsync(revision, select, true);
    this.assertPreparedRoot();
    const objects = select(inspected.record.entries, inspected.tree).objects;
    objects.forEach((object, index) => {
      this.preparedReads!.blobs.set(object, inspected.blobs[index]!);
    });
    this.preparedReads.revisions.set(revision, {
      tree: inspected.tree,
      record: inspected.record,
    });
  }

  /** The same pathname must still denote the physical root that supplied prepared immutable bytes. */
  private assertPreparedRoot(): void {
    if (!this.preparedReads) return;
    try {
      const root = lstatSync(this.repositoryPath);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        root.dev !== this.preparedReads.device ||
        root.ino !== this.preparedReads.inode
      )
        throw new Error('root changed');
    } catch {
      throw new NotebookError('recovery_required');
    }
  }

  /** Pins current validated metadata without blocking on Git subprocesses. */
  async publishedRevisionAsync(): Promise<string> {
    const revision =
      this.selectedRevision ??
      (await this.gitAsync(['rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`])).trim();
    await this.inspectRevisionAsync(revision);
    return revision;
  }

  /** Pins strict metadata and tree identities through the same batch framing and pure decoders. */
  async inspectRevisionAsync(revision: string): Promise<NotebookInspection['record']> {
    return (await this.inspectRevisionTreeAsync(revision)).record;
  }

  /** Exactly one tree and one selected-object batch, with released per-blob decoding work. */
  private async inspectRevisionTreeAsync(
    revision: string,
    select?: Parameters<KnowledgeNotebook['inspectRevisionTree']>[1],
    fresh = false
  ): Promise<NotebookInspection> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
      throw new NotebookError('recovery_required');
    this.assertPreparedRoot();
    const cached = this.preparedReads?.revisions.get(revision);
    const chosen = cached
      ? (select?.(cached.record.entries, cached.tree) ?? { objects: [] })
      : undefined;
    if (
      !fresh &&
      cached &&
      chosen?.objects.every((object) => this.preparedReads!.blobs.has(object))
    )
      return this.inspectRevisionTree(revision, select);
    const tree = await this.gitAsync(['ls-tree', '-r', '-z', '--full-tree', revision]);
    const entries = this.decodeTree(tree);
    const selected = select?.(entries, tree) ?? { objects: [] };
    const objects = [
      { id: revision, type: 'commit' as const },
      ...selected.objects.map((id) => ({ id, type: 'blob' as const })),
    ];
    if (objects.some(({ id }) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)))
      throw new NotebookError('recovery_required');
    const bytes = await this.gitBytesAsync(
      ['cat-file', '--batch'],
      objects.map(({ id }) => `${id}\n`).join(''),
      'OpenKit',
      objects.length * (GIT_OUTPUT_BYTES + 128)
    );
    const [commit, ...bodies] = this.decodeObjectsBatch(objects, bytes);
    let record: Omit<NotebookRevision, 'files'>;
    try {
      record = this.decodeCommit(
        revision,
        new TextDecoder('utf-8', { fatal: true }).decode(commit)
      );
    } catch {
      throw new NotebookError('recovery_required');
    }
    const blobs: string[] = [];
    for (let index = 0; index < bodies.length; index++) {
      blobs.push(this.decodeBlob(selected.objects[index]!, bodies[index]!));
      if (index % 16 === 15) await yieldToMain();
    }
    if (selected.missing) throw new NotebookError('invalid_request');
    this.assertPreparedRoot();
    return { record: { ...record, entries }, tree, blobs };
  }

  /** Loads the original selected Page/Source set in a single asynchronous object batch. */
  async readRevisionWithSourcesAsync(
    revision: string,
    input: { readonly pageIds?: readonly string[]; readonly sources: boolean }
  ): Promise<
    NotebookInspection['record'] & {
      readonly files: Readonly<Record<string, string>>;
      readonly sources: Readonly<Record<string, string>> | undefined;
    }
  > {
    let paths: string[] = [];
    let sources: Readonly<Record<string, string>> = {};
    const inspected = await this.inspectRevisionTreeAsync(revision, (entries, tree) => {
      paths = input.pageIds
        ? input.pageIds.map((id) => `${id}.md`).filter((path) => Object.hasOwn(entries, path))
        : Object.keys(entries).filter((path) => !['index.md', 'log.md'].includes(basename(path)));
      sources = input.sources ? this.sourceObjects(revision, tree) : {};
      return { objects: [...paths.map((path) => entries[path]!), ...Object.values(sources)] };
    });
    return {
      ...inspected.record,
      files: Object.assign(
        Object.create(null),
        Object.fromEntries(paths.map((path, index) => [path, inspected.blobs[index]!]))
      ),
      sources: input.sources
        ? Object.assign(
            Object.create(null),
            Object.fromEntries(
              Object.keys(sources).map((id, index) => [id, inspected.blobs[paths.length + index]!])
            )
          )
        : undefined,
    };
  }

  /** Reads the same exact selected Page prefix and absent-path refusal as the synchronous reader. */
  async readRevisionAsync(revision: string, paths?: readonly string[]): Promise<NotebookRevision> {
    let selected: readonly string[] = [];
    const {
      record: { entries: _entries, ...record },
      blobs,
    } = await this.inspectRevisionTreeAsync(revision, (entries) => {
      selected = paths ?? Object.keys(entries);
      return this.selectObjects(entries, selected);
    });
    return {
      ...record,
      files: Object.assign(
        Object.create(null),
        Object.fromEntries(selected.map((path, index) => [path, blobs[index]!]))
      ),
    };
  }

  /** Reads only native Source pointers through the same strict immutable tree. */
  async readSourcePointersAsync(revision: string): Promise<Readonly<Record<string, string>>> {
    let sources: Readonly<Record<string, string>> = {};
    const { blobs } = await this.inspectRevisionTreeAsync(revision, (_entries, tree) => {
      sources = this.sourceObjects(revision, tree);
      return { objects: Object.values(sources) };
    });
    return Object.fromEntries(Object.keys(sources).map((id, index) => [id, blobs[index]!]));
  }

  /** Checks history's limit-one published ancestry without loading Page bodies. */
  async assertPublishedAncestryAsync(revision: string): Promise<void> {
    const published = await this.publishedRevisionAsync();
    await this.inspectRevisionAsync(revision);
    if ((await this.gitAsync(['merge-base', revision, published])).trim() !== revision)
      throw new NotebookError('invalid_request');
  }

  /** Reads exact path-qualified content for edit and Proposal deltas; Page projections stay separate. */
  readContent(revision: string, paths?: readonly string[]): Readonly<Record<string, string>> {
    let selected: readonly string[] = [];
    const { blobs } = this.inspectRevisionTree(revision, (pages, tree) => {
      const entries = { ...pages };
      for (const [id, object] of Object.entries(this.sourceObjects(revision, tree)))
        entries[`@sources/${id}.md`] = object;
      selected = paths ?? Object.keys(entries);
      return this.selectObjects(entries, selected);
    });
    return Object.fromEntries(selected.map((path, index) => [path, blobs[index]!]));
  }

  /** Creates a Source-only candidate; native Source admission owns captured facts and publication. */
  prepareSourcePointers(input: {
    readonly baseRevision: string;
    readonly changes: Readonly<Record<string, string | null>>;
    readonly metadata: NotebookCommitMetadata;
  }): string {
    return this.finishPlumbing(this.prepareSourcePointerSteps(input));
  }

  /** Common Source validation and native serialization, independent of scheduling. */
  private *prepareSourcePointerSteps(
    input: Parameters<KnowledgeNotebook['prepareSourcePointers']>[0]
  ): Generator<NotebookGitCommand, string, string> {
    const inspected = this.inspectRevisionTree(input.baseRevision);
    const base = inspected.record;
    const metadata = NotebookCommitMetadataSchema.parse(input.metadata);
    const sources = { ...this.sourceObjects(input.baseRevision, inspected.tree) };
    for (const [id, content] of Object.entries(input.changes)) {
      if (
        !KnowledgeSourceIdSchema.safeParse(id).success ||
        (content !== null &&
          (typeof content !== 'string' ||
            Buffer.byteLength(content) > FILE_BYTES ||
            Buffer.from(content).toString('utf8') !== content))
      )
        throw new NotebookError('invalid_request');
      if (content === null) delete sources[id];
      else sources[id] = (yield { args: ['hash-object', '-w', '--stdin'], input: content }).trim();
    }
    return yield* this.createCommitSteps(base.entries, metadata, input.baseRevision, sources);
  }

  /** Gets immutable Source objects without loading raw originals or admitting metadata for disclosure. */
  private sourceObjects(
    revision: string,
    inspectedTree?: string
  ): Readonly<Record<string, string>> {
    this.assertPreparedRoot();
    const preparedTree = this.preparedReads?.revisions.get(revision)?.tree;
    inspectedTree ??= preparedTree;
    const tree =
      inspectedTree === undefined
        ? this.git(['ls-tree', '-r', '-z', '--full-tree', revision, '--', 'sources/'])
        : inspectedTree
            .split('\0')
            .filter((row) => row.includes('\tsources/'))
            .join('\0');
    return this.decodeSourceObjects(tree);
  }

  /** Applies the same strict native Source tree grammar to both read paths. */
  private decodeSourceObjects(tree: string): Readonly<Record<string, string>> {
    const sources: Record<string, string> = Object.create(null);
    for (const row of tree.split('\0')) {
      if (!row) continue;
      const match = /^100644 blob ([a-f0-9]+)\tsources\/([^/]+)\.md$/.exec(row);
      if (!match || !KnowledgeSourceIdSchema.safeParse(match[2]).success)
        throw new NotebookError('recovery_required');
      sources[match[2]!] = match[1]!;
    }
    return sources;
  }

  /** Drives the same fixed serializer without a second implementation of its validation. */
  private finishPlumbing(steps: Generator<NotebookGitCommand, string, string>): string {
    let step = steps.next();
    while (!step.done) {
      const { args, input, author } = step.value;
      step = steps.next(this.git(args, input, author));
    }
    return step.value;
  }

  /** Releases Main while each fixed Git child completes; no effect is retried. */
  private async finishPlumbingAsync(
    steps: Generator<NotebookGitCommand, string, string>
  ): Promise<string> {
    let step = steps.next();
    while (!step.done) {
      const { args, input, author } = step.value;
      step = steps.next(await this.gitAsync(args, input, author));
    }
    return step.value;
  }

  /** Writes the original fixed-base candidate with prepared reads and asynchronous native effects. */
  async prepareAsync(input: Parameters<KnowledgeNotebook['prepare']>[0]): Promise<string> {
    const notebook = this.preparedReads
      ? this
      : await this.withPreparedReadsAsync([input.baseRevision]);
    return notebook.finishPlumbingAsync(notebook.prepareSteps(input));
  }

  /** Writes the same Source-only candidate without synchronous children. */
  async prepareSourcePointersAsync(
    input: Parameters<KnowledgeNotebook['prepareSourcePointers']>[0]
  ): Promise<string> {
    const notebook = this.preparedReads
      ? this
      : await this.withPreparedReadsAsync([input.baseRevision], { paths: [], sources: false });
    return notebook.finishPlumbingAsync(notebook.prepareSourcePointerSteps(input));
  }

  /** Creates an unpublished fixed-base candidate; validation/authority checks precede caller publication. */
  prepare(input: {
    readonly baseRevision: string;
    readonly changes: Readonly<Record<string, string | null>>;
    readonly metadata: NotebookCommitMetadata;
    /** Native package admission supplies already-validated Source pointers for the same commit. */
    readonly sourcePointers?: Readonly<Record<string, string>>;
  }): string {
    return this.finishPlumbing(this.prepareSteps(input));
  }

  /** Common edit validation and native serialization, independent of scheduling. */
  private *prepareSteps(
    input: Parameters<KnowledgeNotebook['prepare']>[0]
  ): Generator<NotebookGitCommand, string, string> {
    if (Object.keys(input.changes).length > 256) throw new NotebookError('invalid_request');
    const metadata = NotebookCommitMetadataSchema.safeParse(input.metadata);
    if (!metadata.success) throw new NotebookError('invalid_request');
    const inspected = this.inspectRevisionTree(input.baseRevision);
    const entries = { ...inspected.record.entries };
    validateNotebookFiles(
      Object.fromEntries(
        Object.entries(input.changes).filter(
          (entry): entry is [string, string] => entry[1] !== null
        )
      ),
      true
    );
    const sources = { ...this.sourceObjects(input.baseRevision, inspected.tree) };
    for (const [path, value] of Object.entries(input.changes)) {
      if (
        (!validPath(path) && !path.startsWith('@sources/')) ||
        (value !== null && typeof value !== 'string')
      )
        throw new NotebookError('invalid_request');
      if (path.startsWith('@sources/')) {
        const id = path.slice('@sources/'.length, -3);
        if (!KnowledgeSourceIdSchema.safeParse(id).success || !sources[id] || value === null)
          throw new NotebookError('invalid_request');
        assertSourcePointerEdit(this.readBlob(sources[id]!), value);
        sources[id] = (yield { args: ['hash-object', '-w', '--stdin'], input: value }).trim();
      } else if (value === null) delete entries[path];
      else entries[path] = (yield { args: ['hash-object', '-w', '--stdin'], input: value }).trim();
    }
    if (!Object.hasOwn(entries, 'index.md')) throw new NotebookError('invalid_request');
    for (const [id, content] of Object.entries(input.sourcePointers ?? {})) {
      KnowledgeSourceIdSchema.parse(id);
      if (Object.hasOwn(sources, id) || Buffer.byteLength(content) > FILE_BYTES)
        throw new NotebookError('invalid_request');
      sources[id] = (yield { args: ['hash-object', '-w', '--stdin'], input: content }).trim();
    }
    return yield* this.createCommitSteps(entries, metadata.data, input.baseRevision, sources);
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
    return { revision: input.candidateRevision };
  }

  /** Verifies and publishes the same fixed-base ref off Main, with fresh admission before dispatch. */
  async publishAsync(input: {
    readonly baseRevision: string;
    readonly candidateRevision: string;
    readonly beforePublish?: () => void;
  }): Promise<{ revision: string }> {
    const candidate = await this.inspectRevisionAsync(input.candidateRevision);
    if (candidate.parentRevision !== input.baseRevision) throw new NotebookError('invalid_request');
    await this.gitAsync([
      'fsck',
      '--strict',
      '--no-reflogs',
      '--no-dangling',
      input.candidateRevision,
    ]);
    const current = await this.publishedRevisionAsync();
    if (current !== input.baseRevision) throw new NotebookError('conflict', current);
    input.beforePublish?.();
    try {
      await this.gitAsync([
        'update-ref',
        PUBLISHED_REF,
        input.candidateRevision,
        input.baseRevision,
      ]);
    } catch {
      const observed = await this.publishedRevisionAsync();
      if (observed !== input.baseRevision && observed !== input.candidateRevision)
        throw new NotebookError('conflict', observed);
      throw new NotebookError('recovery_required');
    }
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
  }

  /** Retains the same exact create-only Proposal ref without blocking Main on Git. */
  async retainCandidateAsync(
    input: Parameters<KnowledgeNotebook['retainCandidate']>[0] & { beforeRetain?: () => void }
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(input.proposalId)) throw new NotebookError('invalid_request');
    const candidate = await this.inspectRevisionAsync(input.candidateRevision);
    if (!candidate.parentRevision) throw new NotebookError('invalid_request');
    input.beforeRetain?.();
    await this.gitAsync([
      'update-ref',
      `refs/proposals/${input.proposalId}`,
      input.candidateRevision,
      '0'.repeat(input.candidateRevision.length),
    ]);
  }

  /** Reads the service-owned retained Proposal ref without changing publication or reconstructing content. */
  retainedCandidate(proposalId: string): Omit<NotebookRevision, 'files'> {
    if (!/^[A-Za-z0-9_-]+$/.test(proposalId)) throw new NotebookError('invalid_request');
    return this.inspectRevision(
      this.git(['rev-parse', '--verify', `refs/proposals/${proposalId}`]).trim()
    );
  }

  /** Reads the service-owned ref asynchronously, then verifies its exact immutable candidate. */
  async retainedCandidateAsync(proposalId: string): Promise<Omit<NotebookRevision, 'files'>> {
    if (!/^[A-Za-z0-9_-]+$/.test(proposalId)) throw new NotebookError('invalid_request');
    const revision = (
      await this.gitAsync(['rev-parse', '--verify', `refs/proposals/${proposalId}`])
    ).trim();
    return this.inspectRevisionAsync(revision);
  }

  /** Returns a bounded metadata page from published ancestry without loading page bodies. */
  history(input: { readonly revision?: string; readonly limit?: number } = {}): {
    readonly revisions: readonly Omit<NotebookRevision, 'files'>[];
    readonly nextRevision: string | null;
  } {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new NotebookError('invalid_request');
    const publishedRecord = this.inspectPublishedRevision();
    const published = publishedRecord.revision;
    let revision: string | null = input.revision ?? published;
    // Validate the cursor before ancestry; its immutable record also supplies the first row.
    let inspected = revision === published ? publishedRecord : this.inspectRevision(revision);
    // Normal history cannot disclose retained unpublished Proposal candidates through a cursor.
    if (this.git(['merge-base', revision, published]).trim() !== revision)
      throw new NotebookError('invalid_request');
    const revisions: Omit<NotebookRevision, 'files'>[] = [];
    while (revision && revisions.length < limit) {
      const { entries: _entries, ...record } = inspected;
      revisions.push(record);
      revision = record.parentRevision;
      if (revision && revisions.length < limit) inspected = this.inspectRevision(revision);
    }
    return { revisions, nextRevision: revision };
  }

  /**
   * Validates every retained Git object, commit and service-owned ref without granting authority.
   * Backup callers own quiescence and the matching Proposal/Review records outside this Git owner.
   * Returns identities only; invalid or unsupported graph state requires explicit recovery.
   */
  validateRetainedGraph(): {
    readonly publishedRevision: string;
    readonly revisions: readonly string[];
  } {
    const publishedRevision = this.publishedRevision();
    if (this.git(['symbolic-ref', 'HEAD']).trim() !== PUBLISHED_REF)
      throw new NotebookError('recovery_required');
    // fsck checks every retained object, including unreachable candidate objects, by its real hash.
    this.git(['fsck', '--strict', '--full', '--no-reflogs', '--no-dangling']);
    const refs = this.git([
      'for-each-ref',
      '--format=%(refname) %(objectname) %(objecttype) %(symref)',
    ]);
    // A native Workspace selects its parentless seed in SQL without a Git ref.
    for (const row of refs === '' ? [] : refs.trim().split('\n')) {
      const [ref, revision, type, symbolicTarget] = row.split(' ');
      if (!ref || !revision || type !== 'commit' || symbolicTarget)
        throw new NotebookError('recovery_required');
      if (ref === PUBLISHED_REF) {
        // Workspace SQL owns current selection after activation. Its Git ref is a
        // retained projection and may lag; User and Server keep the ref as owner.
        if (this.selectedRevision === undefined && revision !== publishedRevision)
          throw new NotebookError('recovery_required');
        continue;
      }
      const proposal = /^refs\/proposals\/([A-Za-z0-9_-]+)$/.exec(ref);
      if (!proposal) throw new NotebookError('recovery_required');
      const candidate = this.inspectRevision(revision);
      if (
        !candidate.parentRevision ||
        candidate.metadata.authority.kind !== 'proposal' ||
        candidate.metadata.authority.proposalId !== proposal[1]
      )
        throw new NotebookError('recovery_required');
    }
    const revisions: string[] = [];
    for (const row of this.git([
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype)',
    ])
      .trim()
      .split('\n')) {
      const [revision, type] = row.split(' ');
      if (type !== 'commit' || !revision) continue;
      // Existing tree, metadata and fatal UTF-8 boundaries also cover unreferenced commits.
      // Release each page collection immediately; the result carries object identities only.
      this.readRevision(revision);
      revisions.push(revision);
    }
    return { publishedRevision, revisions: revisions.sort() };
  }

  /** Writes data-only blob/tree/commit objects; no working tree, filters or executable content is used. */
  private createCommit(
    objects: Readonly<Record<string, string>>,
    metadata: NotebookCommitMetadata,
    parent: string | null,
    sourceObjects?: Readonly<Record<string, string>>
  ): string {
    return this.finishPlumbing(this.createCommitSteps(objects, metadata, parent, sourceObjects));
  }

  /** Produces only the original data-only tree/commit plumbing and exact metadata bytes. */
  private *createCommitSteps(
    objects: Readonly<Record<string, string>>,
    metadata: NotebookCommitMetadata,
    parent: string | null,
    sourceObjects?: Readonly<Record<string, string>>
  ): Generator<NotebookGitCommand, string, string> {
    const tree = new Map<string, string | Map<string, unknown>>();
    const paths = {
      ...Object.fromEntries(
        Object.entries(objects).map(([path, object]) => [`pages/${path}`, object])
      ),
      ...Object.fromEntries(
        Object.entries(sourceObjects ?? (parent ? this.sourceObjects(parent) : {})).map(
          ([id, object]) => [`sources/${id}.md`, object]
        )
      ),
    };
    for (const [path, object] of Object.entries(paths)) {
      let entries = tree;
      const parts = path.split('/');
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
    const writeTree = function* (
      entries: typeof tree
    ): Generator<NotebookGitCommand, string, string> {
      const rows: string[] = [];
      for (const [name, value] of entries) {
        rows.push(
          typeof value === 'string'
            ? `100644 blob ${value}\t${name}\0`
            : `040000 tree ${yield* writeTree(value as typeof tree)}\t${name}\0`
        );
      }
      return (yield { args: ['mktree', '-z'], input: rows.join('') }).trim();
    };
    const root = yield* writeTree(tree);
    return (yield {
      args: ['commit-tree', root, ...(parent ? ['-p', parent] : []), '-F', '-'],
      input: `${JSON.stringify({ schemaVersion: KNOWLEDGE_NOTEBOOK_COMMIT_SCHEMA_VERSION, ...metadata })}\n`,
      author: metadata.producer.id,
    }).trim();
  }
}
