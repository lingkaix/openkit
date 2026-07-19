import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { WorkerLineage } from './transcript.js';

const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_TIMEOUT_MS = 20_000;
const INDEX_FILE = 'workspace-git.index';
const MANIFEST_FILE = 'workspace-changes.json';
const PATCH_FILE = 'workspace.patch';
const RESERVED_NON_MANIFEST_FILES = new Set([
  INDEX_FILE,
  `${INDEX_FILE}.lock`,
  PATCH_FILE,
  `${PATCH_FILE}.tmp`,
  `${MANIFEST_FILE}.tmp`,
]);

/** Git-backed writable workspace input used by the worker shim. */
export interface WorkspaceGitInput {
  /** Package-local workspace input id. */
  id: string;
  /** Host path materialized for the worker. */
  target: string;
  /** Worker access mode. */
  access: 'read-only' | 'read-write';
  /** Git change-set publication settings. */
  materialization?: {
    /** Worker-visible manifest path. */
    changeSetManifestPath?: unknown;
    /** Materialization strategy. */
    strategy?: unknown;
  };
}

/**
 * Clears prior Git review outputs and captures clean workspace base commits before the worker runs.
 *
 * @param inputs Writable Git workspace inputs.
 * @param sessionDir Worker session directory that owns review outputs.
 * @returns Base commit ids keyed by workspace input id.
 * @throws When inputs are ambiguous, cleanup fails, or a workspace is dirty or unsafe.
 */
export async function prepareWorkspaceGitSnapshots(
  inputs: readonly WorkspaceGitInput[],
  sessionDir: string
): Promise<Map<string, string>> {
  if (inputs.length > 1) {
    throw new Error('Only one writable Git workspace input is supported per worker session.');
  }

  const paths = workspaceGitPaths(inputs, sessionDir);
  await removeSessionArtifacts(sessionDir, paths.all);
  const bases = new Map<string, string>();

  for (const input of inputs) {
    const baseCommit = await requireGitCommit(
      input.target,
      sessionDir,
      'HEAD',
      'Git workspace base commit is unavailable.'
    );
    await assertVisibleIndex(input.target, sessionDir);
    const candidatePaths = await workspaceCandidatePaths(input.target, sessionDir, baseCommit);
    await assertReviewableCandidatePaths(input.target, sessionDir, candidatePaths);
    if (candidatePaths.length > 0) {
      throw new Error('Git workspace must be clean before the worker starts.');
    }
    if (
      (await requireGitCommit(
        input.target,
        sessionDir,
        'HEAD',
        'Git workspace base commit is unavailable.'
      )) !== baseCommit
    ) {
      throw new Error('Git workspace HEAD changed during base capture.');
    }
    bases.set(input.id, baseCommit);
  }

  return bases;
}

/**
 * Collects one post-worker Git snapshot and publishes its patch atomically before its manifest.
 *
 * @param input Workspace inputs, captured bases, exact injected credential values, lineage, and session output directory.
 * @throws When snapshot validation, Git collection, publication, or cleanup fails.
 */
export async function publishWorkspaceGitSnapshots(input: {
  bases: ReadonlyMap<string, string>;
  credentialValues: readonly string[];
  inputs: readonly WorkspaceGitInput[];
  lineage: WorkerLineage;
  sessionDir: string;
}): Promise<void> {
  const paths = workspaceGitPaths(input.inputs, input.sessionDir);
  const credentialBytes = input.credentialValues
    .filter(Boolean)
    .map((value) => Buffer.from(value, 'utf8'));

  try {
    await removeSessionArtifacts(input.sessionDir, paths.temporary);

    if (input.inputs.length === 0) {
      await removeSessionArtifacts(input.sessionDir, paths.all);
      return;
    }

    for (const workspaceInput of input.inputs) {
      const baseCommit = input.bases.get(workspaceInput.id);
      if (!baseCommit) {
        throw new Error('Git workspace base commit is unavailable.');
      }
      const headCommit = await requireGitCommit(
        workspaceInput.target,
        input.sessionDir,
        'HEAD',
        'Git workspace post-run HEAD commit is unavailable.'
      );
      await assertVisibleIndex(workspaceInput.target, input.sessionDir);
      const candidatePaths = await workspaceCandidatePaths(
        workspaceInput.target,
        input.sessionDir,
        baseCommit
      );
      await assertReviewableCandidatePaths(workspaceInput.target, input.sessionDir, candidatePaths);
      if (candidatePaths.length === 0) {
        await removeSessionArtifacts(input.sessionDir, paths.all);
        return;
      }
      // ponytail: worker sandboxes assume one repository writer; add an external lock if that changes.
      const indexEnvironment = { GIT_INDEX_FILE: paths.index };
      await requireGitText(
        workspaceInput.target,
        input.sessionDir,
        ['read-tree', baseCommit],
        indexEnvironment,
        'Git workspace base index preparation failed.'
      );
      await requireGitText(
        workspaceInput.target,
        input.sessionDir,
        ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
        indexEnvironment,
        'Git workspace snapshot collection failed.',
        Buffer.from(`${candidatePaths.join('\0')}\0`)
      );
      const changedPaths = await collectGitChangedPaths(
        workspaceInput.target,
        input.sessionDir,
        baseCommit,
        indexEnvironment
      );

      if (changedPaths.length === 0) {
        await removeSessionArtifacts(input.sessionDir, paths.all);
        return;
      }

      if (credentialBytes.length > 0) {
        for (const changedPath of changedPaths) {
          if (changedPath.status === 'deleted') {
            continue;
          }
          const stagedBlob = await requireGitBytes(
            workspaceInput.target,
            input.sessionDir,
            ['cat-file', 'blob', `:0:${changedPath.path}`],
            indexEnvironment,
            'Git workspace staged content inspection failed.'
          );
          if (credentialBytes.some((credential) => stagedBlob.includes(credential))) {
            throw new Error('Git workspace staged content contains an injected credential.');
          }
        }
      }

      const patch = await requireGitBytes(
        workspaceInput.target,
        input.sessionDir,
        [
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--find-renames',
          '--no-ext-diff',
          '--no-textconv',
          baseCommit,
          '--',
          '.',
        ],
        indexEnvironment,
        'Git workspace patch collection failed.'
      );
      if (patch.byteLength === 0) {
        throw new Error('Git workspace patch collection produced no content.');
      }
      if (
        (await requireGitCommit(
          workspaceInput.target,
          input.sessionDir,
          'HEAD',
          'Git workspace post-run HEAD commit is unavailable.'
        )) !== headCommit
      ) {
        throw new Error('Git workspace HEAD changed during output collection.');
      }

      const patchDigest = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
      const manifestPath = manifestPathFor(workspaceInput, input.sessionDir);
      const manifestTemporaryPath = `${manifestPath}.tmp`;
      await writeFile(paths.patchTemporary, patch, { flag: 'wx' });
      await rename(paths.patchTemporary, paths.patch);
      await writeFile(
        manifestTemporaryPath,
        `${JSON.stringify(
          {
            artifactIds: [],
            base: { commit: baseCommit, contentDigest: null },
            bundle: null,
            changedPaths,
            createdAt: new Date().toISOString(),
            evidenceRefs: [{ kind: 'worker', ref: input.lineage.turnId }],
            head: { commit: headCommit, contentDigest: null },
            id: `wcs_${input.lineage.packageSnapshotId}_${workspaceInput.id}`,
            inputSnapshotId: `wis_${input.lineage.packageSnapshotId}_${workspaceInput.id}`,
            materializationRecordId: `wmr_${input.lineage.packageSnapshotId}_${workspaceInput.id}`,
            patch: {
              bytes: patch.byteLength,
              digest: patchDigest,
              ref: 'worker-session://workspace.patch',
            },
            redaction: { notes: [], status: 'redacted' },
            resourceId: workspaceInput.id,
            strategy: 'git',
            workspaceId: input.lineage.workspaceId,
          },
          null,
          2
        )}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      await rename(manifestTemporaryPath, manifestPath);
    }

    await removeSessionArtifacts(input.sessionDir, paths.temporary);
  } catch (error) {
    await failAfterCleanup(error, input.sessionDir, paths.all);
  }
}

/**
 * Rejects tracked index flags that hide worktree state from normal Git inspection.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 */
async function assertVisibleIndex(cwd: string, sessionDir: string): Promise<void> {
  const flags = await requireGitText(
    cwd,
    sessionDir,
    ['ls-files', '-v', '-z'],
    {},
    'Git workspace index inspection failed.'
  );
  if (splitNulls(flags).some((entry) => entry[0] !== 'H')) {
    throw new Error('Git workspace cannot hide indexed paths from worker lineage checks.');
  }
}

/**
 * Rejects candidate paths that alter attributes or require Git filters NanoCore cannot review.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param paths Candidate changed paths.
 */
async function assertReviewableCandidatePaths(
  cwd: string,
  sessionDir: string,
  paths: readonly string[]
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  if (paths.some((path) => path === '.gitattributes' || path.endsWith('/.gitattributes'))) {
    throw new Error('Git workspace changes cannot modify Git attributes.');
  }

  const attributes = splitNulls(
    await requireGitText(
      cwd,
      sessionDir,
      ['check-attr', '-z', '--stdin', 'filter'],
      {},
      'Git workspace filter inspection failed.',
      Buffer.from(`${paths.join('\0')}\0`)
    )
  );
  if (attributes.length !== paths.length * 3) {
    throw new Error('Git workspace filter metadata is invalid.');
  }
  for (let index = 0; index < attributes.length; index += 3) {
    const path = attributes[index];
    const attribute = attributes[index + 1];
    const value = attributes[index + 2];
    if (
      path !== paths[index / 3] ||
      attribute !== 'filter' ||
      (value !== 'unspecified' && value !== 'unset')
    ) {
      throw new Error('Git workspace changed paths cannot use Git filters.');
    }
  }
}

/**
 * Finds staged, worktree, and untracked candidate paths without staging or content filters.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param baseCommit Captured pre-worker commit.
 * @returns Sorted unique candidate paths.
 */
async function workspaceCandidatePaths(
  cwd: string,
  sessionDir: string,
  baseCommit: string
): Promise<string[]> {
  const [untracked, cached, worktree] = await Promise.all([
    requireGitText(
      cwd,
      sessionDir,
      ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'],
      {},
      'Git workspace untracked path inspection failed.'
    ),
    requireGitText(
      cwd,
      sessionDir,
      [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        baseCommit,
        '--',
        '.',
      ],
      {},
      'Git workspace staged path inspection failed.'
    ),
    unstagedCandidatePaths(cwd, sessionDir),
  ]);
  return [...new Set([...splitNulls(untracked), ...splitNulls(cached), ...worktree])].sort();
}

/**
 * Finds tracked worktree changes from index stat metadata without invoking content filters.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @returns Tracked paths whose filesystem metadata differs from the index.
 */
async function unstagedCandidatePaths(cwd: string, sessionDir: string): Promise<string[]> {
  const output = await requireGitText(
    cwd,
    sessionDir,
    ['ls-files', '--stage', '--debug', '-z', '--', '.'],
    {},
    'Git workspace index stat inspection failed.'
  );
  // ponytail: this fail-closed parser avoids clean filters; use a native index parser if Git changes the format.
  const pattern =
    /(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([^\0]*)\0 {2}ctime: (\d+):(\d+)\n {2}mtime: (\d+):(\d+)\n {2}dev: (\d+)\tino: (\d+)\n {2}uid: (\d+)\tgid: (\d+)\n {2}size: (\d+)\tflags: \d+\n/g;
  const candidates: string[] = [];
  let consumed = 0;

  for (let match = pattern.exec(output); match; match = pattern.exec(output)) {
    if (match.index !== consumed) {
      throw new Error('Git workspace index stat metadata is invalid.');
    }
    consumed = pattern.lastIndex;
    const [mode, objectId, stage, path] = match.slice(1, 5);
    if (!mode || !objectId || !stage || !path || stage !== '0') {
      throw new Error('Git workspace index stat metadata is invalid.');
    }
    const root = resolve(cwd);
    const target = resolve(root, path);
    const relativeTarget = relative(root, target);
    if (
      isAbsolute(relativeTarget) ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${sep}`)
    ) {
      throw new Error('Git workspace index path escapes the workspace root.');
    }

    try {
      const stat = await lstat(target, { bigint: true });
      const expectedCtime = BigInt(match[5] ?? '') * 1_000_000_000n + BigInt(match[6] ?? '');
      const expectedMtime = BigInt(match[7] ?? '') * 1_000_000_000n + BigInt(match[8] ?? '');
      const sameType =
        (mode.startsWith('100') && stat.isFile()) ||
        (mode === '120000' && stat.isSymbolicLink()) ||
        (mode === '160000' && stat.isDirectory());
      const sameExecutable =
        mode === '100644'
          ? (stat.mode & 0o111n) === 0n
          : mode !== '100755' || (stat.mode & 0o111n) !== 0n;
      const sameMetadata =
        stat.ctimeNs === expectedCtime &&
        stat.mtimeNs === expectedMtime &&
        BigInt.asUintN(32, stat.dev) === BigInt(match[9] ?? '') &&
        BigInt.asUintN(32, stat.ino) === BigInt(match[10] ?? '') &&
        BigInt.asUintN(32, stat.uid) === BigInt(match[11] ?? '') &&
        BigInt.asUintN(32, stat.gid) === BigInt(match[12] ?? '') &&
        BigInt.asUintN(32, stat.size) === BigInt(match[13] ?? '');
      if (!sameType || !sameExecutable) {
        candidates.push(path);
        continue;
      }
      if (!sameMetadata) {
        if (mode === '160000') {
          candidates.push(path);
          continue;
        }
        const content =
          mode === '120000' ? Buffer.from(await readlink(target)) : await readFile(target);
        const algorithm = objectId.length === 40 ? 'sha1' : 'sha256';
        const actualObjectId = createHash(algorithm)
          .update(`blob ${content.byteLength}\0`)
          .update(content)
          .digest('hex');

        if (actualObjectId !== objectId) {
          candidates.push(path);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      candidates.push(path);
    }
  }

  if (consumed !== output.length) {
    throw new Error('Git workspace index stat metadata is invalid.');
  }
  return candidates;
}

/**
 * Collects canonical path, mode, rename, and binary metadata from an isolated Git index.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param baseCommit Captured pre-worker commit.
 * @param environment Session-local Git index override.
 * @returns Canonical changed-path records for the workspace manifest.
 */
async function collectGitChangedPaths(
  cwd: string,
  sessionDir: string,
  baseCommit: string,
  environment: NodeJS.ProcessEnv
) {
  const [rawText, numstatText] = await Promise.all([
    requireGitText(
      cwd,
      sessionDir,
      [
        'diff',
        '--cached',
        '--raw',
        '--full-index',
        '--no-abbrev',
        '-z',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        baseCommit,
        '--',
        '.',
      ],
      environment,
      'Git workspace raw diff inspection failed.'
    ),
    requireGitText(
      cwd,
      sessionDir,
      [
        'diff',
        '--cached',
        '--numstat',
        '--no-renames',
        '-z',
        '--no-ext-diff',
        '--no-textconv',
        baseCommit,
        '--',
        '.',
      ],
      environment,
      'Git workspace diff statistics inspection failed.'
    ),
  ]);
  if (!rawText) {
    return [];
  }

  const binaryPaths = new Set<string>();
  const statPaths = new Set<string>();
  for (const record of splitNulls(numstatText)) {
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (secondTab < 0 || secondTab === record.length - 1) {
      throw new Error('Git workspace diff statistics are invalid.');
    }
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    const binary = additions === '-' && deletions === '-';
    if (
      (!binary && (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions))) ||
      statPaths.has(path)
    ) {
      throw new Error('Git workspace diff statistics are invalid.');
    }
    statPaths.add(path);
    if (binary) {
      binaryPaths.add(path);
    }
  }

  const tokens = splitNulls(rawText);
  const touchedPaths = new Set<string>();
  const changedPaths: Array<{
    binaryReview?: {
      bytes: number;
      digest: string;
      mediaType: string;
      mode: 'artifact-only';
      reason: 'binary-path';
      summary: string;
    };
    digest?: string;
    newPermissions?: string;
    oldPermissions?: string;
    size?: number;
    binary: boolean;
    oldPath?: string;
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'mode_changed';
  }> = [];

  for (let index = 0; index < tokens.length; ) {
    const header = tokens[index++];
    const match = header?.match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])\d*$/
    );
    const firstPath = tokens[index++];
    if (!match || !firstPath) {
      throw new Error('Git workspace diff metadata is invalid.');
    }

    const oldMode = match[1];
    const newMode = match[2];
    const oldObjectId = match[3];
    const newObjectId = match[4];
    const code = match[5];
    if (!oldMode || !newMode || !oldObjectId || !newObjectId || !code) {
      throw new Error('Git workspace diff metadata is invalid.');
    }
    const oldPath = code === 'R' ? firstPath : undefined;
    const path = code === 'R' ? tokens[index++] : firstPath;
    if (!path) {
      throw new Error('Git workspace rename metadata is invalid.');
    }
    const oldMissing = /^0+$/.test(oldObjectId);
    const newMissing = /^0+$/.test(newObjectId);
    const oldRegular = oldMode === '100644' || oldMode === '100755';
    const newRegular = newMode === '100644' || newMode === '100755';
    const validShape =
      (code === 'A' && oldMode === '000000' && oldMissing && newRegular && !newMissing) ||
      (code === 'D' && oldRegular && !oldMissing && newMode === '000000' && newMissing) ||
      (code === 'M' && oldRegular && !oldMissing && newRegular && !newMissing) ||
      (code === 'R' && oldRegular && !oldMissing && newRegular && !newMissing);
    if (!validShape) {
      throw new Error('Git workspace diff contains an unsupported status or file mode.');
    }

    const oldPermissions = oldMode === '000000' ? undefined : `0${oldMode.slice(-3)}`;
    const newPermissions = newMode === '000000' ? undefined : `0${newMode.slice(-3)}`;
    const permissionChange =
      oldPermissions && newPermissions && oldPermissions !== newPermissions
        ? { newPermissions, oldPermissions }
        : null;
    let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'mode_changed';
    if (code === 'A') {
      status = 'added';
    } else if (code === 'D') {
      status = 'deleted';
    } else if (code === 'R') {
      status = 'renamed';
    } else if (permissionChange && oldObjectId === newObjectId) {
      status = 'mode_changed';
    } else {
      status = 'modified';
    }

    const binary = binaryPaths.has(path);
    if (oldPath && binaryPaths.has(oldPath) !== binary) {
      throw new Error('Git workspace rename changes binary representation.');
    }
    const blob = binary
      ? await gitBytes(
          cwd,
          sessionDir,
          ['cat-file', 'blob', status === 'deleted' ? oldObjectId : newObjectId],
          environment
        )
      : null;
    if (binary && !blob) {
      throw new Error(`Git workspace binary blob is unavailable: ${path}`);
    }
    const digest = blob ? `sha256:${createHash('sha256').update(blob).digest('hex')}` : undefined;
    changedPaths.push({
      binary,
      ...(oldPath ? { oldPath } : {}),
      path,
      status,
      ...(permissionChange ?? {}),
      ...(blob && digest
        ? {
            binaryReview: {
              bytes: blob.byteLength,
              digest,
              mediaType: 'application/octet-stream',
              mode: 'artifact-only',
              reason: 'binary-path',
              summary: 'Binary workspace change requires artifact review.',
            },
            digest,
            size: blob.byteLength,
          }
        : {}),
    });
    if (oldPath) {
      touchedPaths.add(oldPath);
    }
    touchedPaths.add(path);
  }

  if (
    touchedPaths.size !== statPaths.size ||
    [...touchedPaths].some((path) => !statPaths.has(path))
  ) {
    throw new Error('Git workspace diff path metadata is inconsistent.');
  }

  return changedPaths;
}

/**
 * Runs a required Git command and returns exact stdout bytes.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param failureMessage Product-safe failure message.
 * @param stdin Optional exact stdin bytes.
 * @returns Exact stdout bytes.
 */
async function requireGitBytes(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  failureMessage: string,
  stdin?: Buffer
): Promise<Buffer> {
  const output = await gitBytes(cwd, sessionDir, argv, environment, stdin);
  if (!output) {
    throw new Error(failureMessage);
  }
  return output;
}

/**
 * Runs a required Git command and returns exact UTF-8 stdout text.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param failureMessage Product-safe failure message.
 * @param stdin Optional exact stdin bytes.
 * @returns Exact stdout text.
 */
async function requireGitText(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  failureMessage: string,
  stdin?: Buffer
): Promise<string> {
  return (
    await requireGitBytes(cwd, sessionDir, argv, environment, failureMessage, stdin)
  ).toString('utf8');
}

/**
 * Runs one bounded Git subprocess with a scrubbed environment.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used to disable ambient config.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param stdin Optional exact stdin bytes.
 * @returns Exact stdout bytes, or null when Git fails or times out.
 */
async function gitBytes(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  stdin?: Buffer
): Promise<Buffer | null> {
  return new Promise((resolveOutput) => {
    const child = spawn(
      'git',
      ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...argv],
      {
        cwd,
        env: gitEnvironment(sessionDir, environment),
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      }
    );
    const chunks: Buffer[] = [];
    let settled = false;
    let aborted = false;
    const finish = (output: Buffer | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveOutput(output);
    };
    const abort = () => {
      if (settled) {
        return;
      }
      aborted = true;
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(abort, GIT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdin?.on('error', abort);
    child.on('error', () => finish(null));
    child.on('close', (exitCode) =>
      finish(!aborted && exitCode === 0 ? Buffer.concat(chunks) : null)
    );
    child.stdin?.end(stdin);
  });
}

/**
 * Builds the allowlisted Git subprocess environment and explicit safety controls.
 *
 * @param sessionDir Worker session directory reserved for snapshot state.
 * @param overrides Command-local Git environment overrides.
 * @returns Scrubbed subprocess environment.
 */
function gitEnvironment(sessionDir: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...overrides,
    GIT_ASKPASS: '',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    HOME: sessionDir,
    LC_ALL: 'C',
    PAGER: 'cat',
    SSH_ASKPASS: '',
    XDG_CONFIG_HOME: sessionDir,
  };

  for (const key of [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }

  return environment;
}

/**
 * Resolves and validates one Git commit reference.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param ref Git commit reference.
 * @param failureMessage Product-safe failure message.
 * @returns Full commit object id.
 */
async function requireGitCommit(
  cwd: string,
  sessionDir: string,
  ref: string,
  failureMessage: string
): Promise<string> {
  const commit = (
    await requireGitText(
      cwd,
      sessionDir,
      ['rev-parse', '--verify', `${ref}^{commit}`],
      {},
      failureMessage
    )
  ).trim();
  if (!GIT_OBJECT_ID_PATTERN.test(commit)) {
    throw new Error(failureMessage);
  }
  return commit;
}

/**
 * Resolves session-owned patch, manifest, and temporary artifact paths.
 *
 * @param inputs Writable Git workspace inputs.
 * @param sessionDir Worker session directory.
 * @returns Canonical, temporary, and combined cleanup paths.
 */
function workspaceGitPaths(inputs: readonly WorkspaceGitInput[], sessionDir: string) {
  const patch = sessionArtifactPath(sessionDir, PATCH_FILE);
  const index = sessionArtifactPath(sessionDir, INDEX_FILE);
  const manifests = new Set([
    sessionArtifactPath(sessionDir, MANIFEST_FILE),
    ...inputs.map((input) => manifestPathFor(input, sessionDir)),
  ]);
  const patchTemporary = `${patch}.tmp`;
  const temporary = [
    index,
    `${index}.lock`,
    patchTemporary,
    ...[...manifests].map((path) => `${path}.tmp`),
  ];
  return {
    all: [patch, ...manifests, ...temporary],
    index,
    patch,
    patchTemporary,
    temporary,
  };
}

/**
 * Maps a worker-visible manifest path to one direct child of the local session directory.
 *
 * @param input Writable Git workspace input.
 * @param sessionDir Worker session directory.
 * @returns Safe local manifest path.
 */
function manifestPathFor(input: WorkspaceGitInput, sessionDir: string): string {
  const configured = input.materialization?.changeSetManifestPath;
  let name =
    typeof configured === 'string' && configured.startsWith('/openkit/session/')
      ? basename(configured)
      : MANIFEST_FILE;
  const normalizedName = name.toLowerCase();
  if (normalizedName === MANIFEST_FILE) {
    name = MANIFEST_FILE;
  } else if (RESERVED_NON_MANIFEST_FILES.has(normalizedName)) {
    throw new Error('Git workspace manifest path conflicts with a reserved session artifact.');
  }
  return sessionArtifactPath(sessionDir, name);
}

/**
 * Resolves one direct session artifact path and rejects traversal.
 *
 * @param sessionDir Worker session directory.
 * @param name Artifact basename.
 * @returns Absolute direct-child path.
 */
function sessionArtifactPath(sessionDir: string, name: string): string {
  const root = resolve(sessionDir);
  const path = resolve(root, name);
  if (dirname(path) !== root) {
    throw new Error('Git workspace output path must stay inside the worker session directory.');
  }
  return path;
}

/**
 * Removes every reserved session artifact recursively while attempting all paths.
 *
 * @param sessionDir Worker session directory.
 * @param paths Reserved paths to remove.
 * @throws One cleanup error or an AggregateError containing every cleanup failure.
 */
async function removeSessionArtifacts(sessionDir: string, paths: readonly string[]): Promise<void> {
  const root = resolve(sessionDir);
  const errors: unknown[] = [];

  for (const path of new Set(paths)) {
    if (dirname(resolve(path)) !== root) {
      errors.push(
        new Error('Git workspace output cleanup path escaped the worker session directory.')
      );
      continue;
    }
    try {
      await rm(path, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Git workspace output cleanup failed.');
  }
}

/**
 * Cleans reserved outputs after a primary failure without discarding either error.
 *
 * @param primary Primary snapshot or publication failure.
 * @param sessionDir Worker session directory.
 * @param paths Reserved paths to remove.
 * @throws The primary error, or an AggregateError when cleanup also fails.
 */
async function failAfterCleanup(
  primary: unknown,
  sessionDir: string,
  paths: readonly string[]
): Promise<never> {
  try {
    await removeSessionArtifacts(sessionDir, paths);
  } catch (cleanupError) {
    throw new AggregateError(
      [primary, cleanupError],
      'Git workspace snapshot failed and output cleanup also failed.'
    );
  }
  throw primary;
}

/**
 * Splits exact NUL-delimited Git output into non-empty strings.
 *
 * @param text NUL-delimited output.
 * @returns Parsed non-empty records.
 */
function splitNulls(text: string): string[] {
  return text.split('\0').filter(Boolean);
}
