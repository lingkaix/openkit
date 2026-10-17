import { posix } from 'node:path';
import { Bash, InMemoryFs } from 'just-bash';
import type { KnowledgeNotebook } from './notebook.js';
import { NotebookError, validateNotebookFiles } from './notebook.js';
import type { NotebookEdit } from './notebook-publication.js';

/** Fixed owner bounds, shared with native Tool descriptions rather than authored configuration. */
export const NOTEBOOK_EDITING_LIMITS = {
  workspaceBytes: 32 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  changedFiles: 256,
  scriptBytes: 64 * 1024,
  outputBytes: 64 * 1024,
} as const;

/** Only interpreted file/text commands are supplied; optional runtimes and effects stay absent. */
const COMMANDS = [
  'cat',
  'printf',
  'echo',
  'ls',
  'mkdir',
  'rmdir',
  'touch',
  'rm',
  'cp',
  'mv',
  'pwd',
  'head',
  'tail',
  'wc',
  'stat',
  'grep',
  'rg',
  'sed',
  'awk',
  'sort',
  'uniq',
  'cut',
  'paste',
  'tr',
  'rev',
  'nl',
  'fold',
  'expand',
  'unexpand',
  'join',
  'tee',
  'find',
  'basename',
  'dirname',
  'tree',
  'du',
  'xargs',
  'true',
  'false',
  'jq',
  'yq',
  'diff',
  'seq',
  'expr',
  'sha256sum',
] as const;

/** All data lives in memory; the mutation boundary also protects omitted immutable base members. */
class NotebookEditingFs extends InMemoryFs {
  private changed = new Set<string>();

  constructor(
    private readonly initial: Record<string, string>,
    private readonly basePaths: ReadonlySet<string>,
    private readonly selected: ReadonlySet<string>
  ) {
    super(initial, { maxTotalBytes: NOTEBOOK_EDITING_LIMITS.workspaceBytes });
  }

  private writable(path: string, directory = false): string {
    const normalized = posix.resolve('/', path);
    if (!normalized.startsWith('/notebook/')) throw new Error('Notebook path is read-only.');
    const relative = normalized.slice('/notebook/'.length);
    if (directory) {
      if (
        !relative
          .split('/')
          .every(
            (part) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(part) && part !== '.' && part !== '..'
          )
      )
        throw new Error('Invalid notebook directory.');
    } else {
      validateNotebookFiles({ [relative]: '' }, true);
      if (this.basePaths.has(relative) && !this.selected.has(relative))
        throw new Error('Notebook path is outside the editable selection.');
    }
    return normalized;
  }

  private changedPaths(path: string, bytes: Uint8Array | null): Set<string> {
    const next = new Set(this.changed);
    const original = this.initial[path];
    const unchanged =
      bytes === null
        ? original === undefined
        : original !== undefined && Buffer.from(original).equals(Buffer.from(bytes));
    if (unchanged) next.delete(path);
    else next.add(path);
    if (next.size > NOTEBOOK_EDITING_LIMITS.changedFiles)
      throw new Error('Notebook edits exceed 256 changed files.');
    return next;
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: Parameters<InMemoryFs['writeFile']>[2]
  ): Promise<void> {
    path = this.writable(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const bytes =
      typeof content === 'string'
        ? Buffer.from(content, encoding === 'binary' ? 'latin1' : (encoding ?? 'utf8'))
        : Buffer.from(content);
    if (bytes.length > NOTEBOOK_EDITING_LIMITS.fileBytes)
      throw new Error('Notebook file exceeds 2 MiB.');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Notebook files must contain UTF-8 text.');
    }
    const next = this.changedPaths(path, bytes);
    await super.writeFile(path, bytes);
    this.changed = next;
  }

  override async appendFile(
    path: string,
    content: string | Uint8Array,
    options?: Parameters<InMemoryFs['writeFile']>[2]
  ): Promise<void> {
    this.writable(path);
    const prior = (await this.exists(path)) ? await this.readFileBuffer(path) : new Uint8Array();
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const appended =
      typeof content === 'string'
        ? Buffer.from(content, encoding === 'binary' ? 'latin1' : (encoding ?? 'utf8'))
        : content;
    await this.writeFile(path, Buffer.concat([prior, appended]));
  }

  override async mkdir(path: string, options?: Parameters<InMemoryFs['mkdir']>[1]): Promise<void> {
    this.writable(path, true);
    await super.mkdir(path, options);
  }

  override async rm(path: string, options?: Parameters<InMemoryFs['rm']>[1]): Promise<void> {
    const normalized = posix.resolve('/', path);
    const paths = this.getAllPaths().filter(
      (entry) => entry === normalized || entry.startsWith(`${normalized}/`)
    );
    if (!paths.length) this.writable(normalized);
    const before = this.changed;
    try {
      for (const entry of paths) {
        const directory = (await this.stat(entry)).isDirectory;
        this.writable(entry, directory);
        if (!directory) this.changed = this.changedPaths(entry, null);
      }
      await super.rm(normalized, options);
    } catch (error) {
      this.changed = before;
      throw error;
    }
  }

  override async cp(
    src: string,
    dest: string,
    options?: Parameters<InMemoryFs['cp']>[2]
  ): Promise<void> {
    if ((await this.stat(src)).isDirectory) {
      if (!options?.recursive) throw new Error('Recursive copy is required.');
      this.writable(dest, true);
      await this.mkdir(dest, { recursive: true });
      for (const name of await this.readdir(src))
        await this.cp(posix.join(src, name), posix.join(dest, name), options);
    } else await this.writeFile(dest, await this.readFileBuffer(src));
  }

  override async mv(src: string, dest: string): Promise<void> {
    const normalized = posix.resolve('/', src);
    for (const entry of this.getAllPaths().filter(
      (path) => path === normalized || path.startsWith(`${normalized}/`)
    ))
      this.writable(entry, (await this.stat(entry)).isDirectory);
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  override async createExclusive(
    path: string,
    options: Parameters<InMemoryFs['createExclusive']>[1]
  ): Promise<void> {
    path = this.writable(path, options.directory);
    const next = options.directory ? this.changed : this.changedPaths(path, new Uint8Array());
    await super.createExclusive(path, options);
    this.changed = next;
  }

  override async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.writable(path);
    await super.utimes(path, atime, mtime);
  }

  override async chmod(): Promise<void> {
    throw new Error('Notebook file modes are fixed.');
  }
  override async symlink(): Promise<void> {
    throw new Error('Notebook links are disabled.');
  }
  override async link(): Promise<void> {
    throw new Error('Notebook links are disabled.');
  }
}

/** Bounded script observation; a nonzero exit says nothing about publication. */
export interface NotebookEditingResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Native admission pins all authority and exact bytes before exposing these two KM operations. */
export function createNotebookAgentEditing<Result extends { readonly outcome: string }>(input: {
  readonly notebook: KnowledgeNotebook;
  readonly baseRevision: string;
  readonly requestId: string;
  readonly files: Readonly<Record<string, string>>;
  readonly sources?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly revalidate: () => void;
  /** Uses the existing publisher or saves the exact existing pending Proposal. */
  readonly submit: (edit: NotebookEdit) => Promise<Result>;
}) {
  input.revalidate();
  const fixedFiles = { ...input.files };
  const base = input.notebook.inspectRevision(input.baseRevision);
  validateNotebookFiles(fixedFiles, true);
  const selected = new Set(Object.keys(fixedFiles));
  const admitted = input.notebook.readRevision(input.baseRevision, [...selected]).files;
  const initial: Record<string, string> = {};
  let admittedBytes = 0;
  for (const [path, content] of Object.entries(fixedFiles)) {
    if (admitted[path] !== content) throw new NotebookError('invalid_request');
    initial[`/notebook/${path}`] = content;
  }
  for (const [path, content] of Object.entries(input.sources ?? {})) {
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/.test(path))
      throw new NotebookError('invalid_request');
    initial[`/sources/${path}`] = content;
  }
  for (const content of Object.values(initial)) {
    admittedBytes += Buffer.byteLength(content);
    if (
      Buffer.byteLength(content) > NOTEBOOK_EDITING_LIMITS.fileBytes ||
      Buffer.from(content).toString('utf8') !== content
    )
      throw new NotebookError('invalid_request');
  }
  if (admittedBytes > NOTEBOOK_EDITING_LIMITS.workspaceBytes)
    throw new NotebookError('invalid_request');
  const fs = new NotebookEditingFs(initial, new Set(Object.keys(base.entries)), selected);
  let ended = false;
  let busy = false;
  const assertOpen = () => {
    input.signal.throwIfAborted();
    if (ended || busy || Date.now() >= input.deadlineMs) throw new NotebookError('invalid_request');
    input.revalidate();
  };
  return {
    /** Interprets one bounded script against the same volatile tree for this Turn. */
    async workspaceUpdate(request: { readonly script: string }): Promise<NotebookEditingResult> {
      assertOpen();
      if (
        typeof request.script !== 'string' ||
        Object.keys(request).some((key) => key !== 'script') ||
        Buffer.byteLength(request.script) > NOTEBOOK_EDITING_LIMITS.scriptBytes
      )
        throw new NotebookError('invalid_request');
      busy = true;
      try {
        // Each interpreter shares only the admitted filesystem, not shell variables, plugins or ambient state.
        const bash = new Bash({
          fs,
          cwd: '/notebook',
          env: {},
          commands: [...COMMANDS],
          executionLimitProfile: 'hardened',
          executionLimits: {
            maxSourceBytes: NOTEBOOK_EDITING_LIMITS.scriptBytes,
            maxOutputSize: NOTEBOOK_EDITING_LIMITS.outputBytes,
            maxFileSystemBytes: NOTEBOOK_EDITING_LIMITS.workspaceBytes,
            maxExecutionTimeMs: Math.max(1, Math.min(10_000, input.deadlineMs - Date.now())),
          },
        });
        const result = await bash.exec(request.script, { signal: input.signal, rawScript: true });
        const stdout = Buffer.from(result.stdout)
          .subarray(0, NOTEBOOK_EDITING_LIMITS.outputBytes)
          .toString('utf8');
        const stderr = Buffer.from(result.stderr)
          .subarray(0, NOTEBOOK_EDITING_LIMITS.outputBytes - Buffer.byteLength(stdout))
          .toString('utf8');
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          truncated:
            Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >=
            NOTEBOOK_EDITING_LIMITS.outputBytes,
        };
      } catch {
        input.signal.throwIfAborted();
        throw new NotebookError('invalid_request');
      } finally {
        busy = false;
      }
    },
    /** Submits exactly the current admitted edit tree; final validation includes omitted immutable pages. */
    async notebookUpdate(request: {
      readonly summary: string;
    }): Promise<Result | { readonly outcome: 'no_change' }> {
      assertOpen();
      if (
        typeof request.summary !== 'string' ||
        Object.keys(request).some((key) => key !== 'summary') ||
        Buffer.byteLength(request.summary) > 4096
      )
        throw new NotebookError('invalid_request');
      busy = true;
      try {
        const files: Record<string, string> = {};
        for (const path of fs.getAllPaths()) {
          if (!path.startsWith('/notebook/') || !(await fs.stat(path)).isFile) continue;
          files[path.slice('/notebook/'.length)] = await fs.readFile(path);
        }
        validateNotebookFiles(files, true);
        const changes = [...new Set([...selected, ...Object.keys(files)])]
          .sort()
          .filter((path) => fixedFiles[path] !== files[path])
          .map((path) => ({ path, content: files[path] ?? null }));
        if (changes.length > NOTEBOOK_EDITING_LIMITS.changedFiles)
          throw new NotebookError('invalid_request');
        input.revalidate();
        if (!changes.length) {
          ended = true;
          return { outcome: 'no_change' };
        }
        const result = await input.submit({
          requestId: input.requestId,
          baseRevision: input.baseRevision,
          changes,
          summary: request.summary,
        });
        if (result.outcome === 'published' || result.outcome === 'review_required') ended = true;
        return result;
      } finally {
        busy = false;
      }
    },
  };
}
