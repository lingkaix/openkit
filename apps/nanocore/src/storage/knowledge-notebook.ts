import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorRefSchema } from '@openkit/protocol';
import { type Node, parseTree } from 'jsonc-parser';
import { z } from 'zod';

const revisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const maintenance = z
  .object({ enabled: z.literal(true), reviewRequiredPageIds: z.array(z.string()) })
  .strict();
const metadataSchema = z
  .object({
    summary: z.string().refine((value) => Buffer.byteLength(value) <= 4096),
    changeRequest: z.object({ requestId: z.string().min(1), inputDigest: sha256 }).strict(),
    producer: z
      .object({
        actor: ActorRefSchema,
        invocationId: z.string().min(1).optional(),
        modelRef: z.string().min(1).optional(),
      })
      .strict(),
    authority: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('instruction'), reference: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('maintenance'), setting: maintenance, digest: sha256 }).strict(),
      z.object({ kind: z.literal('proposal'), proposalId: z.string().min(1) }).strict(),
    ]),
    sourceReferences: z.array(z.string()),
  })
  .strict();
/** Exact admission evidence retained inside the immutable content commit, never a reusable grant. */
export type NotebookCommitMetadata = z.infer<typeof metadataSchema>;
/** Trusted Git attribution comes from the admitting command, never authored page fields. */
export interface NotebookAttribution {
  name: string;
  email: string;
  timestamp: string;
}
/** One final-tree text edit; null removes the current path but retains its history. */
export interface NotebookChange {
  path: string;
  content: string | null;
}
/** A typed canonical-owner failure with no private path, query or body in its message. */
export class KnowledgeNotebookError extends Error {
  constructor(
    readonly code: 'recovery_required' | 'conflict' | 'validation_failed' | 'source_unavailable'
  ) {
    super(`Knowledge notebook ${code}.`);
    this.name = 'KnowledgeNotebookError';
  }
}
const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n# Knowledge\n';
const REF = 'refs/heads/published';
const FILE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_BYTES = 32 * 1024 * 1024;

/** Owns local immutable page bytes and the sole published content ref for one admitted scope. */
export class KnowledgeNotebook {
  readonly repository: string;
  constructor(readonly root: string) {
    this.repository = join(root, 'notebook.git');
  }

  /** Initializes a fresh authorized scope only; an existing broken notebook is never recreated. */
  initialize(metadata: NotebookCommitMetadata, attribution: NotebookAttribution): string {
    if (existsSync(this.repository)) throw new KnowledgeNotebookError('recovery_required');
    mkdirSync(this.repository, { recursive: true, mode: 0o700 });
    this.git(['init', '--bare', '--quiet']);
    const candidate = this.prepare(
      null,
      [{ path: 'pages/index.md', content: ROOT_INDEX }],
      metadata,
      attribution,
      () => undefined
    );
    this.sync();
    this.git(['update-ref', REF, candidate, '0'.repeat(candidate.length)]);
    this.sync();
    return candidate;
  }

  /** Pins the current published commit and validates its authority-bearing metadata. */
  pin(): string {
    const revision = this.git(['rev-parse', '--verify', REF]).trim();
    this.commitMetadata(revision);
    return revision;
  }

  /** Reads exact canonical text at an admitted immutable revision, never a materialized fallback. */
  read(revision: string, path: string): string | null {
    this.assertRevision(revision);
    assertPagePath(path);
    const entry = this.git(['ls-tree', '-z', revision, '--', path]);
    if (entry === '') return null;
    if (!entry.startsWith('100644 blob ') || !entry.endsWith(`\t${path}\0`))
      throw new KnowledgeNotebookError('recovery_required');
    const bytes = this.gitBytes(['show', `${revision}:${path}`], undefined, FILE_BYTES);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new KnowledgeNotebookError('recovery_required');
    }
  }

  /** Lists regular UTF-8 page paths in one pinned tree with no symlinks or submodules. */
  entries(revision: string): string[] {
    this.assertRevision(revision);
    const rows = this.git(['ls-tree', '-rz', '--full-tree', revision]).split('\0').filter(Boolean);
    return rows
      .map((row) => {
        const match = /^100644 blob [a-f0-9]+\t(.+)$/.exec(row);
        if (!match) throw new KnowledgeNotebookError('recovery_required');
        assertPagePath(match[1]!);
        return match[1]!;
      })
      .sort(compareBytes);
  }

  /** Prepares immutable objects without changing published content or creating a receipt. */
  prepare(
    base: string | null,
    changes: readonly NotebookChange[],
    metadata: NotebookCommitMetadata,
    attribution: NotebookAttribution,
    validate: (pages: ReadonlyMap<string, string>) => void
  ): string {
    this.assertRepositorySafe();
    const admitted = validateMetadata(metadata);
    if (base !== null) this.assertRevision(base);
    if (
      changes.length > 256 ||
      new Set(changes.map((change) => change.path)).size !== changes.length
    )
      throw new KnowledgeNotebookError('validation_failed');
    const pages = new Map<string, string>();
    if (base) for (const path of this.entries(base)) pages.set(path, this.read(base, path)!);
    for (const change of changes) {
      assertPagePath(change.path);
      if (change.content === null) pages.delete(change.path);
      else {
        if (
          Buffer.byteLength(change.content) > FILE_BYTES ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            change.content
          )
        )
          throw new KnowledgeNotebookError('validation_failed');
        pages.set(change.path, change.content);
      }
    }
    if (
      !pages.has('pages/index.md') ||
      [...pages.values()].reduce((n, text) => n + Buffer.byteLength(text), 0) > WORKSPACE_BYTES
    )
      throw new KnowledgeNotebookError('validation_failed');
    validate(pages);
    const temporary = mkdtempSync(join(tmpdir(), 'openkit-notebook-index-'));
    const index = join(temporary, 'index');
    try {
      this.git(base ? ['read-tree', base] : ['read-tree', '--empty'], undefined, index);
      for (const change of changes) {
        if (change.content === null)
          this.git(['update-index', '--force-remove', '--', change.path], undefined, index);
        else {
          const blob = this.git(['hash-object', '-w', '--stdin'], change.content, index).trim();
          this.git(
            ['update-index', '--add', '--cacheinfo', '100644', blob, change.path],
            undefined,
            index
          );
        }
      }
      const tree = this.git(['write-tree'], undefined, index).trim();
      return this.git(
        ['commit-tree', tree, ...(base ? ['-p', base] : [])],
        canonicalJson(admitted),
        index,
        attribution
      ).trim();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  /** Publishes one fixed-base candidate only after fresh admission and required Audit retention. */
  publish(base: string, candidate: string, admitAndRecordAudit: () => void): string {
    this.assertRevision(base);
    const metadata = this.commitMetadata(candidate);
    if (this.git(['rev-parse', `${candidate}^`]).trim() !== base)
      throw new KnowledgeNotebookError('conflict');
    if (this.pin() !== base) throw new KnowledgeNotebookError('conflict');
    admitAndRecordAudit();
    // Admission evidence is necessary, but never replaces the current compare-and-set ref.
    validateMetadata(metadata);
    this.sync();
    try {
      this.git(['update-ref', REF, candidate, base]);
    } catch {
      throw new KnowledgeNotebookError(this.pin() === base ? 'conflict' : 'recovery_required');
    }
    this.sync();
    return candidate;
  }

  /** Reads the complete strict JSON commit message; unknown authority semantics fail closed. */
  commitMetadata(revision: string): NotebookCommitMetadata {
    this.assertRevision(revision);
    const text = this.git(['show', '-s', '--format=%B', revision]);
    const errors: { error: number; offset: number; length: number }[] = [];
    const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
    if (!tree || tree.type !== 'object' || errors.length)
      throw new KnowledgeNotebookError('recovery_required');
    assertUniqueKeys(tree);
    try {
      return validateMetadata(JSON.parse(text));
    } catch {
      throw new KnowledgeNotebookError('recovery_required');
    }
  }

  /** Refuses link or special-file mutation paths before creating any Git object. */
  private assertRepositorySafe(): void {
    const visit = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new KnowledgeNotebookError('recovery_required');
      if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    };
    visit(this.repository);
  }
  /** Requires an exact full object id naming a local commit, with replacement objects disabled. */
  private assertRevision(revision: string): void {
    if (
      !revisionSchema.safeParse(revision).success ||
      this.git(['cat-file', '-t', revision]).trim() !== 'commit'
    )
      throw new KnowledgeNotebookError('recovery_required');
  }
  /** Executes only code-owned Git commands with no ambient credentials, hooks, filters or transport. */
  private git(
    args: string[],
    input?: string,
    index?: string,
    attribution?: NotebookAttribution
  ): string {
    return this.gitBytes(args, input, WORKSPACE_BYTES + 1024 * 1024, index, attribution).toString(
      'utf8'
    );
  }
  /** Bounds process time and output, and keeps host errors out of product failures. */
  private gitBytes(
    args: string[],
    input?: string,
    maxBuffer = WORKSPACE_BYTES,
    index?: string,
    attribution?: NotebookAttribution
  ): Buffer {
    const result = spawnSync(
      '/usr/bin/git',
      [
        '--git-dir',
        this.repository,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.logAllRefUpdates=false',
        '-c',
        'gc.auto=0',
        '-c',
        'protocol.allow=never',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.fsync=all',
        '-c',
        'core.fsyncMethod=fsync',
        ...args,
      ],
      {
        input,
        maxBuffer,
        timeout: 60_000,
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...(index ? { GIT_INDEX_FILE: index } : {}),
          ...(attribution
            ? {
                GIT_AUTHOR_NAME: attribution.name,
                GIT_COMMITTER_NAME: attribution.name,
                GIT_AUTHOR_EMAIL: attribution.email,
                GIT_COMMITTER_EMAIL: attribution.email,
                GIT_AUTHOR_DATE: attribution.timestamp,
                GIT_COMMITTER_DATE: attribution.timestamp,
              }
            : {}),
        },
      }
    );
    if (result.error || result.signal || result.status !== 0)
      throw new KnowledgeNotebookError('recovery_required');
    return result.stdout;
  }
  /** Flushes every owned object/ref before acknowledgement; no staging or old objects are purged. */
  private sync(): void {
    const visit = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new KnowledgeNotebookError('recovery_required');
      if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child));
      const fd = openSync(path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    visit(this.repository);
  }
}

/** Rejects unsafe page paths, reserved-root aliases, case collisions and non-Markdown content paths. */
function assertPagePath(path: string): void {
  if (
    Buffer.byteLength(path) > 249 ||
    !/^pages\/(?:[a-z0-9][a-z0-9._-]{0,63}\/)*[a-z0-9][a-z0-9._-]{0,63}\.md$/.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new KnowledgeNotebookError('validation_failed');
}
/** Verifies authority-bearing metadata, including the exact resolved maintenance-setting digest. */
function validateMetadata(value: unknown): NotebookCommitMetadata {
  const parsed = metadataSchema.safeParse(value);
  if (!parsed.success) throw new KnowledgeNotebookError('validation_failed');
  const metadata = parsed.data;
  if (
    metadata.authority.kind === 'maintenance' &&
    metadata.authority.digest !==
      `sha256:${createHash('sha256').update(canonicalJson(metadata.authority.setting)).digest('hex')}`
  )
    throw new KnowledgeNotebookError('validation_failed');
  return metadata;
}
/** Rejects duplicate members before ordinary JSON decoding can erase their ambiguity. */
function assertUniqueKeys(node: Node): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string;
      if (keys.has(key)) throw new KnowledgeNotebookError('recovery_required');
      keys.add(key);
      if (property.children?.[1]) assertUniqueKeys(property.children[1]);
    }
  } else if (node.type === 'array')
    for (const child of node.children ?? []) assertUniqueKeys(child);
}
/** Serializes the commit message as one complete deterministic JSON object. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareBytes(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Stable canonical ordering is bytewise, independent of host locale. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
