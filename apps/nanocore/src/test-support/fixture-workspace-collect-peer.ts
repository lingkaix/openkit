/**
 * Synthetic external NanoHost scan peer for the Codex Login component fixture.
 * It does not qualify the canonical Rust collector, physical NanoHost, OpenShell or A1.
 * It measures fixture-owned bytes with isolated Git plumbing and the existing
 * full-permission manifest format. It writes no Core record, receipt or grant.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  sameWorkspaceSnapshot,
  WorkspaceCollectCommandSchema,
  type WorkspaceCollectJsonResult,
  type WorkspaceSnapshotPair,
} from '../runtime/workspace-collect-wire.js';

interface Entry {
  path: string;
  mode: number;
  directory: boolean;
  blob?: string;
}

/**
 * Creates one bounded private scan store outside the fixture Worker mounts.
 * Captures support measured unchanged work only; changed work fails rather than
 * fabricating a canonical review candidate or a successful empty result.
 */
export async function createFixtureWorkspaceCollectPeer(input: {
  ownedRoot: string;
  worktreeRoot: string;
  scanRoot: string;
}) {
  const root = await realpath(input.ownedRoot);
  const inside = (path: string) => {
    const part = relative(root, resolve(path));
    if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`))
      throw new Error('Fixture scan path is outside its owned root.');
    return resolve(path);
  };
  const worktrees = inside(input.worktreeRoot);
  const privateRoot = inside(input.scanRoot);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const repository = join(privateRoot, 'scan.git');
  const gitHome = join(privateRoot, 'empty-home');
  await mkdir(gitHome, { mode: 0o700 });
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: gitHome,
    XDG_CONFIG_HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
  /** Joins exact Git plumbing, scrubs configuration and never discovers the Worker repository. */
  const git = (args: string[], body: Uint8Array = Buffer.alloc(0)): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        '/usr/bin/git',
        [
          '--no-replace-objects',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.attributesFile=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '--git-dir',
          repository,
          ...args,
        ],
        {
          cwd: privateRoot,
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: AbortSignal.timeout(20_000),
        }
      );
      const output: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      child.once('error', () => {
        failed = true;
      });
      child.stdin.on('error', () => {
        failed = true;
      });
      child.stdout.on('data', (value: Buffer) => {
        bytes += value.length;
        if (bytes > 64 * 1024) {
          failed = true;
          child.kill();
          return;
        }
        output.push(value);
      });
      child.stderr.resume();
      child.once('close', (code) => {
        const text = Buffer.concat(output).toString('utf8').trim();
        if (failed || code !== 0) reject(new Error('Fixture scan Git plumbing failed.'));
        else resolve(text);
      });
      child.stdin.end(body);
    });
  await git(['init', '--bare', '--object-format=sha1', '--template=', repository]);
  const objectId = async (args: string[], body: Buffer) => {
    const id = await git(args, body);
    if (!/^[a-f0-9]{40}$/.test(id))
      throw new Error('Fixture scan Git returned an invalid object identity.');
    return id;
  };
  const blob = (body: Buffer) => objectId(['hash-object', '--no-filters', '-w', '--stdin'], body);

  return async (value: unknown): Promise<WorkspaceCollectJsonResult> => {
    const command = WorkspaceCollectCommandSchema.parse(value);
    const worktree = join(worktrees, command.workSlot);
    inside(worktree);
    let credentialHit = false;
    const started = performance.now();
    /** Measures one stable plain directory tree, excluding only the repository metadata component. */
    const scan = async (): Promise<WorkspaceSnapshotPair> => {
      if ((await realpath(worktree)) !== resolve(worktree))
        throw new Error('Fixture worktree is linked.');
      const entries: Entry[] = [];
      let sourceBytes = 0;
      let names = 0;
      const walk = async (path: string, depth: number) => {
        if (depth > 64 || performance.now() - started > 120_000)
          throw new Error('Fixture worktree scan limit exceeded.');
        for (const item of await readdir(join(worktree, path), { withFileTypes: true })) {
          if (++names > 100_000) throw new Error('Fixture worktree entry limit exceeded.');
          if (item.name === '.git') continue;
          const name = path ? `${path}/${item.name}` : item.name;
          if (Buffer.byteLength(name) > 4096 || /[\0\r]/.test(name))
            throw new Error('Fixture worktree path is unsupported.');
          const target = join(worktree, name);
          const metadata = await lstat(target);
          if (metadata.isDirectory()) {
            entries.push({ path: name, mode: metadata.mode & 0o7777, directory: true });
            await walk(name, depth + 1);
          } else if (metadata.isFile() && metadata.nlink === 1) {
            const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            let body: Buffer;
            try {
              const before = await file.stat();
              if (before.dev !== metadata.dev || before.ino !== metadata.ino || !before.isFile())
                throw new Error('Fixture worktree file changed before read.');
              sourceBytes += before.size;
              if (sourceBytes > 256 * 1024 * 1024)
                throw new Error('Fixture worktree byte limit exceeded.');
              body = await file.readFile();
              const after = await file.stat();
              if (
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                before.mode !== after.mode ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                body.length !== before.size
              )
                throw new Error('Fixture worktree file changed during read.');
            } finally {
              await file.close();
            }
            for (const secret of command.checkValues.runtimeEnv) {
              if (body.includes(Buffer.from(secret))) credentialHit = true;
            }
            // The existing wire supplies digests of the fixed43-byte loopback values, never their plaintext.
            for (let index = 0; index + 43 <= body.length && !credentialHit; index += 1) {
              const digest = createHash('sha256')
                .update(body.subarray(index, index + 43))
                .digest('hex');
              if (command.checkValues.loopbackDigests.includes(digest)) credentialHit = true;
            }
            // No protected source bytes enter even the private fixture Git store.
            if (credentialHit) throw new Error('Fixture worktree contains a protected value.');
            entries.push({
              path: name,
              mode: metadata.mode & 0o7777,
              directory: false,
              blob: await blob(body),
            });
          } else throw new Error('Fixture worktree contains an unsupported link or special file.');
        }
      };
      await walk('', 0);
      const kept = entries
        .filter(
          (entry) =>
            !entry.directory ||
            entries.some((other) => !other.directory && other.path.startsWith(`${entry.path}/`))
        )
        .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
      // Owner: workspace_collect.rs::encode_manifest; full mode and UTF8 byte length are retained independently of Git executable mode.
      const manifestBytes = Buffer.concat(
        kept.map((entry) =>
          Buffer.from(
            `${entry.mode.toString(8).padStart(4, '0')} ${Buffer.byteLength(entry.path)} ${entry.path}\n`
          )
        )
      );
      if (manifestBytes.length > 32 * 1024 * 1024)
        throw new Error('Fixture manifest limit exceeded.');
      const tree = async (directory: string): Promise<string> => {
        const rows: Buffer[] = [];
        for (const entry of kept.filter(
          (entry) =>
            (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '') ===
            directory
        )) {
          const name = entry.path.slice(directory ? directory.length + 1 : 0);
          const mode = entry.directory ? '040000' : entry.mode & 0o111 ? '100755' : '100644';
          const id = entry.directory ? await tree(entry.path) : entry.blob;
          rows.push(Buffer.from(`${mode} ${entry.directory ? 'tree' : 'blob'} ${id}\t${name}\0`));
        }
        return objectId(['mktree', '-z'], Buffer.concat(rows));
      };
      return { tree: await tree(''), manifest: await blob(manifestBytes) };
    };
    try {
      const first = await scan();
      const second = await scan();
      if (credentialHit) return { requestId: command.requestId, outcome: 'credential_hit' };
      const stable = sameWorkspaceSnapshot(first, second);
      if (command.mode === 'baseline')
        return stable
          ? { requestId: command.requestId, outcome: 'baseline', head: second }
          : {
              requestId: command.requestId,
              outcome: 'recovery_required',
              cause: 'baseline_unstable',
            };
      if (sameWorkspaceSnapshot(second, command.previousHead))
        return { requestId: command.requestId, outcome: 'no_new_head', unstable: !stable };
      // This fixture never reports a changed worktree as successful unchanged work.
      return { requestId: command.requestId, outcome: 'effect_failed' };
    } catch {
      return {
        requestId: command.requestId,
        outcome: credentialHit ? 'credential_hit' : 'effect_failed',
      };
    }
  };
}
