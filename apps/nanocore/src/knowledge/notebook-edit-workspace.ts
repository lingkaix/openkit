import { posix } from 'node:path';
import {
  Bash,
  type CommandName,
  decodeBytesToUtf8,
  type FileContent,
  type IFileSystem,
  type InitialFiles,
  InMemoryFs,
  stdoutAsBytes,
  stdoutKind,
} from 'just-bash';
import { validateNotebookFiles } from './notebook.js';

/** Fixed notebook-owner bounds, for the maintenance Tool's metadata and diagnostics. */
export const NOTEBOOK_EDIT_LIMITS = Object.freeze({
  admittedBytes: 32 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  changedFiles: 256,
  scriptBytes: 64 * 1024,
  outputBytes: 64 * 1024,
});

const ENVIRONMENT = Object.freeze({
  HOME: '/notebook',
  PWD: '/notebook',
  PATH: '/bin:/usr/bin',
  LANG: 'C.UTF-8',
});

// No runtime, network, archive, link, plugin or host command is registered.
const COMMANDS: readonly CommandName[] = [
  'echo',
  'printf',
  'cat',
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
  'fgrep',
  'egrep',
  'rg',
  'sed',
  'awk',
  'sort',
  'uniq',
  'comm',
  'cut',
  'paste',
  'tr',
  'rev',
  'nl',
  'fold',
  'expand',
  'unexpand',
  'strings',
  'split',
  'column',
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
  'seq',
  'expr',
  'jq',
  'yq',
  'diff',
  'tac',
  'sha256sum',
];

/** Closed, product-safe failure for the existing maintenance Tool closure to project. */
export class NotebookEditWorkspaceError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'scope_denied'
      | 'limit_reached'
      | 'cancelled'
      | 'deadline_reached',
    message: string
  ) {
    super(message);
    this.name = 'NotebookEditWorkspaceError';
  }
}

/** One trusted immutable admission; paths and Sources are selected before model execution. */
export interface NotebookEditWorkspaceInput {
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly editablePaths: readonly string[];
  readonly sources: Readonly<Record<string, string>>;
  /** Absolute epoch milliseconds, no later than the shared internal Agent loop's deadline. */
  readonly deadline: number;
}

/** Bounded display from interpreted editing; this result makes no publication claim. */
export interface NotebookEditResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Admits only canonical, relative virtual paths, including selected Source file names. */
function safeRelativePath(path: string): boolean {
  return (
    Buffer.byteLength(path) <= 243 &&
    path
      .split('/')
      .every((part) => /^[a-z0-9][a-z0-9._-]{0,66}$/.test(part) && part !== '.' && part !== '..')
  );
}

/** Applies the existing content owner's safe Markdown grammar without requiring a root index. */
function safePage(path: string): boolean {
  try {
    validateNotebookFiles({ [path]: '' }, true);
    return true;
  } catch {
    return false;
  }
}

/** A regular file cannot also be an ancestor directory in the candidate tree. */
function hasFileParent(path: string, files: Readonly<Record<string, string>>): boolean {
  const parts = path.split('/').slice(0, -1);
  while (parts.length > 0) {
    if (Object.hasOwn(files, parts.join('/'))) return true;
    parts.pop();
  }
  return false;
}

/** Clips display on a UTF-8 boundary without introducing a replacement character. */
function clip(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString('utf8');
}

/** Invocation-local edits over a private immutable base; the existing publisher owns final-tree semantics. */
export class NotebookEditWorkspace {
  private readonly base: Readonly<Record<string, string>>;
  private readonly editable: ReadonlySet<string>;
  private readonly sources: Readonly<Record<string, string>>;
  private readonly deadline: number;
  private files: Record<string, string>;
  private snapshot: InMemoryFs | undefined;
  private busy = false;
  private signal: AbortSignal | undefined;
  private terminal: 'cancelled' | 'deadline_reached' | undefined;

  constructor(input: NotebookEditWorkspaceInput) {
    if (!Number.isSafeInteger(input.deadline) || input.deadline <= 0)
      throw new NotebookEditWorkspaceError(
        'invalid_request',
        'Notebook editing requires a shared deadline.'
      );
    this.deadline = input.deadline;
    this.base = Object.freeze({ ...input.baseFiles });
    this.editable = new Set(input.editablePaths);
    this.sources = Object.freeze({ ...input.sources });
    this.files = Object.create(null) as Record<string, string>;
    for (const path of this.editable) {
      if (!safePage(path) || !Object.hasOwn(this.base, path))
        throw new NotebookEditWorkspaceError(
          'invalid_request',
          'Notebook editing requires selected existing page paths.'
        );
      this.files[path] = this.base[path]!;
    }
    for (const path of Object.keys(this.sources))
      if (!safeRelativePath(path) || hasFileParent(path, this.sources))
        throw new NotebookEditWorkspaceError(
          'invalid_request',
          'Notebook editing requires safe selected Source names.'
        );
    this.validate(this.files);
  }

  /** Returns only exact bounded content changes; omitted base members remain unchanged for the publisher. */
  changes(): Record<string, string | null> {
    this.assertAvailable();
    this.validate(this.files);
    this.assertAvailable();
    return this.diff(this.files);
  }

  /** Executes one Tool input under the fixed admission and the current shared-loop cancellation signal. */
  async update(
    input: { readonly script: string },
    signal: AbortSignal
  ): Promise<NotebookEditResult> {
    if (signal.aborted) this.cancel('cancelled');
    this.assertAvailable();
    this.signal = signal;
    if (
      !input ||
      typeof input.script !== 'string' ||
      Object.keys(input).some((key) => key !== 'script')
    )
      throw new NotebookEditWorkspaceError(
        'invalid_request',
        'Notebook editing requires only {script:string}.'
      );
    if (Buffer.byteLength(input.script) > NOTEBOOK_EDIT_LIMITS.scriptBytes)
      throw new NotebookEditWorkspaceError(
        'limit_reached',
        'Notebook editing script exceeds 64 KiB UTF-8.'
      );

    this.busy = true;
    const deadline = Math.min(this.deadline, Date.now() + 30_000);
    const controller = new AbortController();
    const cancel = (): void => {
      this.cancel('cancelled');
      controller.abort();
    };
    const timer = setTimeout(
      () => {
        this.cancel('deadline_reached');
        controller.abort();
      },
      Math.max(1, deadline - Date.now())
    );
    timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
    let violation: NotebookEditWorkspaceError | undefined;
    const ensureLive = (): void => {
      if (signal.aborted) this.cancel('cancelled');
      else if (controller.signal.aborted || Date.now() >= deadline) this.cancel('deadline_reached');
      if (this.terminal)
        throw new NotebookEditWorkspaceError(
          this.terminal,
          'Notebook editing was cancelled or reached its deadline.'
        );
    };
    try {
      // Copy admitted bytes and virtual metadata so a rejected call cannot change prior temporary edits.
      const initial: InitialFiles = Object.fromEntries([
        ...Object.entries(this.files).map(([path, text]) => [`/notebook/${path}`, text]),
        ...Object.entries(this.sources).map(([path, text]) => [`/sources/${path}`, text]),
      ]);
      const directories: Array<{ path: string; mtime?: Date }> = [
        { path: '/notebook' },
        { path: '/sources' },
      ];
      if (this.snapshot) {
        for (const path of this.snapshot.getAllPaths()) {
          const stat = await this.snapshot.lstat(path);
          if (stat.isDirectory) directories.push({ path, mtime: stat.mtime });
          else
            initial[path] = {
              content: initial[path] as string,
              mode: stat.mode,
              mtime: stat.mtime,
            };
        }
      }
      const memory = new InMemoryFs(initial, { maxTotalBytes: NOTEBOOK_EDIT_LIMITS.admittedBytes });
      for (const { path } of directories) await memory.mkdir(path, { recursive: true });
      for (const { path, mtime } of directories) if (mtime) await memory.utimes(path, mtime, mtime);
      const deny = (code: 'scope_denied' | 'limit_reached', message: string): never => {
        violation ??= new NotebookEditWorkspaceError(code, message);
        throw violation;
      };
      const allocate = async (operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith('ENOSPC: in-memory filesystem byte limit exceeded')
          )
            deny(
              'limit_reached',
              'Notebook editing exceeds 32 MiB; select a narrower editing request.'
            );
          throw error;
        }
      };
      const writable = (path: string, directory = false): string => {
        ensureLive();
        const normalized = posix.resolve('/', path);
        const relative = normalized.slice('/notebook/'.length);
        if (
          !normalized.startsWith('/notebook/') ||
          !(directory ? safeRelativePath(relative) : safePage(relative)) ||
          (Object.hasOwn(this.base, relative) && !this.editable.has(relative)) ||
          (!directory && Object.keys(this.base).some((path) => path.startsWith(`${relative}/`))) ||
          hasFileParent(relative, this.base)
        )
          deny(
            'scope_denied',
            'Notebook editing write is outside the selected pages and new safe page paths.'
          );
        return normalized;
      };
      const checkContent = (
        content: FileContent,
        options: Parameters<IFileSystem['writeFile']>[2],
        existingBytes = 0
      ): void => {
        const bytes =
          typeof content === 'string'
            ? Buffer.byteLength(
                content,
                typeof options === 'string' ? options : (options?.encoding ?? 'utf8')
              )
            : content.byteLength;
        if (existingBytes + bytes > NOTEBOOK_EDIT_LIMITS.fileBytes)
          deny('limit_reached', 'Notebook editing file exceeds 2 MiB UTF-8.');
      };
      const affected = async (path: string): Promise<string[]> => {
        const normalized = posix.resolve('/', path);
        return [
          normalized,
          ...memory.getAllPaths().filter((entry) => entry.startsWith(`${normalized}/`)),
        ];
      };
      const checkTree = async (path: string): Promise<void> => {
        for (const entry of await affected(path)) {
          const stat = await memory.stat(entry);
          writable(entry, stat.isDirectory);
        }
      };
      // Expose the filesystem interface only. InMemoryFs's bootstrap-only sync methods
      // would let Bash create command stubs outside the notebook profile.
      const fs: IFileSystem = {
        readFile: memory.readFile.bind(memory),
        readFileBuffer: memory.readFileBuffer.bind(memory),
        readFileBytes: memory.readFileBytes.bind(memory),
        exists: memory.exists.bind(memory),
        stat: memory.stat.bind(memory),
        lstat: memory.lstat.bind(memory),
        readdir: memory.readdir.bind(memory),
        readdirWithFileTypes: memory.readdirWithFileTypes.bind(memory),
        getAllPaths: memory.getAllPaths.bind(memory),
        resolvePath: memory.resolvePath.bind(memory),
        realpath: memory.realpath.bind(memory),
        readlink: memory.readlink.bind(memory),
        writeFile: async (path, content, options) => {
          writable(path);
          checkContent(content, options);
          await allocate(() => memory.writeFile(path, content, options));
        },
        appendFile: async (path, content, options) => {
          writable(path);
          const existing = (await memory.exists(path)) ? (await memory.stat(path)).size : 0;
          checkContent(content, options, existing);
          await allocate(() => memory.appendFile(path, content, options));
        },
        mkdir: async (path, options) => {
          writable(path, true);
          await memory.mkdir(path, options);
        },
        createExclusive: async (path, options) => {
          writable(path, options.directory);
          await memory.createExclusive(path, options);
        },
        rm: async (path, options) => {
          if (await memory.exists(path)) await checkTree(path);
          else writable(path);
          await memory.rm(path, options);
        },
        cp: async (source, target, options) => {
          const origin = posix.resolve('/', source);
          for (const entry of await affected(source)) {
            const stat = await memory.stat(entry);
            writable(posix.join(target, posix.relative(origin, entry)), stat.isDirectory);
          }
          await allocate(() => memory.cp(source, target, options));
        },
        mv: async (source, target) => {
          await checkTree(source);
          const origin = posix.resolve('/', source);
          for (const entry of await affected(source)) {
            if (Object.hasOwn(this.base, entry.slice('/notebook/'.length)))
              deny('scope_denied', 'Notebook editing cannot rename published page identities.');
            writable(
              posix.join(target, posix.relative(origin, entry)),
              (await memory.stat(entry)).isDirectory
            );
          }
          await memory.mv(source, target);
        },
        chmod: async () =>
          deny('scope_denied', 'Notebook editing cannot change file types or permissions.'),
        utimes: async (path, atime, mtime) => {
          writable(path);
          await memory.utimes(path, atime, mtime);
        },
        symlink: async () =>
          deny('scope_denied', 'Notebook editing does not allow symbolic links.'),
        link: async () => deny('scope_denied', 'Notebook editing does not allow hard links.'),
      };
      const bash = new Bash({
        fs,
        cwd: '/notebook',
        env: ENVIRONMENT,
        commands: [...COMMANDS],
        executionLimitProfile: 'hardened',
        executionLimits: {
          maxSourceBytes: NOTEBOOK_EDIT_LIMITS.scriptBytes,
          maxFileSystemBytes: NOTEBOOK_EDIT_LIMITS.admittedBytes,
          maxExecutionTimeMs: Math.max(1, deadline - Date.now()),
          maxExtensionCleanupTimeMs: 0,
        },
      });
      ensureLive();
      const result = await bash.exec(input.script, {
        signal: controller.signal,
        rawScript: true,
        replaceEnv: true,
        env: ENVIRONMENT,
      });
      if (violation) throw violation;
      ensureLive();
      // The Tool closure must mark nonzero results as failures and retain the exact exit fields.
      // Library exit 126 is also available to scripts, so stderr text supplies no authority.
      const next: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const path of memory.getAllPaths()) {
        const stat = await memory.lstat(path);
        if (!stat.isFile) {
          if (!stat.isDirectory)
            throw new NotebookEditWorkspaceError(
              'scope_denied',
              'Notebook editing requires regular files.'
            );
          continue;
        }
        if (!path.startsWith('/notebook/')) continue;
        writable(path);
        const bytes = Buffer.from(await memory.readFileBuffer(path));
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes))
          throw new NotebookEditWorkspaceError(
            'invalid_request',
            'Notebook editing requires UTF-8 text.'
          );
        next[path.slice('/notebook/'.length)] = text;
      }
      this.validate(next);
      const displayStdout =
        stdoutKind(result) === 'bytes' ? decodeBytesToUtf8(stdoutAsBytes(result)) : result.stdout;
      const stdout = clip(displayStdout, NOTEBOOK_EDIT_LIMITS.outputBytes);
      const stderr = clip(
        result.stderr,
        NOTEBOOK_EDIT_LIMITS.outputBytes - Buffer.byteLength(stdout)
      );
      ensureLive();
      this.files = next;
      this.snapshot = memory;
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        truncated: stdout !== displayStdout || stderr !== result.stderr,
      };
    } catch (error) {
      ensureLive();
      if (error instanceof NotebookEditWorkspaceError) throw error;
      throw (
        violation ??
        new NotebookEditWorkspaceError(
          'limit_reached',
          'Notebook editing could not complete within its admitted bounds.'
        )
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.busy = false;
    }
  }

  /** Checks content and diff limits before temporary state is retained or submitted. */
  private validate(files: Readonly<Record<string, string>>): void {
    for (const path of Object.keys(files))
      if (hasFileParent(path, files))
        throw new NotebookEditWorkspaceError(
          'invalid_request',
          'Notebook editing requires a regular-file page tree.'
        );
    let total = 0;
    for (const text of [...Object.values(files), ...Object.values(this.sources)]) {
      if (typeof text !== 'string' || Buffer.from(text).toString('utf8') !== text)
        throw new NotebookEditWorkspaceError(
          'invalid_request',
          'Notebook editing requires UTF-8 text.'
        );
      const bytes = Buffer.byteLength(text);
      if (bytes > NOTEBOOK_EDIT_LIMITS.fileBytes)
        throw new NotebookEditWorkspaceError(
          'limit_reached',
          'Notebook editing file exceeds 2 MiB UTF-8.'
        );
      total += bytes;
    }
    if (total > NOTEBOOK_EDIT_LIMITS.admittedBytes)
      throw new NotebookEditWorkspaceError(
        'limit_reached',
        'Notebook editing exceeds 32 MiB; select a narrower editing request.'
      );
    if (Object.keys(this.diff(files)).length > NOTEBOOK_EDIT_LIMITS.changedFiles)
      throw new NotebookEditWorkspaceError(
        'limit_reached',
        'Notebook editing exceeds 256 changed files.'
      );
  }

  /** Computes the exact candidate delta without including omitted immutable base pages. */
  private diff(files: Readonly<Record<string, string>>): Record<string, string | null> {
    return Object.fromEntries(
      [...new Set([...this.editable, ...Object.keys(files)])]
        .sort()
        .filter((path) => files[path] !== this.base[path])
        .map((path) => [path, files[path] ?? null])
    );
  }

  /** Refuses concurrent use and any attempt to reuse a cancelled invocation. */
  private assertAvailable(): void {
    if (this.signal?.aborted) this.cancel('cancelled');
    else if (Date.now() >= this.deadline) this.cancel('deadline_reached');
    if (this.terminal)
      throw new NotebookEditWorkspaceError(
        this.terminal,
        `Notebook editing ${this.terminal.replaceAll('_', ' ')}.`
      );
    if (this.busy)
      throw new NotebookEditWorkspaceError(
        'invalid_request',
        'Notebook editing call is already running.'
      );
  }

  /** Cancellation removes all unpublished volatile bytes held by this component. */
  private cancel(reason: 'cancelled' | 'deadline_reached'): void {
    this.terminal ??= reason;
    this.files = Object.create(null) as Record<string, string>;
    this.snapshot = undefined;
  }
}
