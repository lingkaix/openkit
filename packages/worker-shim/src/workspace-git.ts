import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
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
  /** Exact credential-free remote Git source resolved by NanoCore. */
  source: {
    /** Stable digest of the selected catalog entry. */
    catalogEntryDigest: string;
    /** Exact remote commit selected for this Turn. */
    commit: string;
    /** Closed source kind consumed by this materializer. */
    kind: 'git';
    /** Catalog sensitivity classification. */
    sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
    /** Stable catalog source id. */
    sourceId: string;
    /** Manifest-authored source reference. */
    sourceRef: string;
    /** Credential-free HTTPS Git URL. */
    url: string;
  };
  /** Git change-set publication settings. */
  materialization?: {
    /** Worker-visible manifest path. */
    changeSetManifestPath?: unknown;
    /** Materialization strategy. */
    strategy?: unknown;
  };
}

/**
 * Materializes exact remote Git commits into absent or empty plain work slots, preserving populated targets.
 *
 * @param inputs Validated remote Git inputs selected for this Turn.
 * @param workspaceRoot Worker-visible root that contains every target.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @returns Clean exact base commits keyed by workspace input id.
 * @throws When a target escapes the workspace root or Git cannot produce the exact commit.
 */
export async function materializeWorkspaceGitInputs(
  inputs: readonly WorkspaceGitInput[],
  workspaceRoot: string,
  sessionDir: string
): Promise<Map<string, string>> {
  if (inputs.length > 1) {
    throw new Error('Only one writable Git workspace input is supported per worker session.');
  }
  if (inputs.length === 0) {
    return new Map();
  }

  const root = resolve(workspaceRoot);

  for (const input of inputs) {
    const target = resolve(input.target);
    const targetRelative = relative(root, target);
    if (
      targetRelative === '' ||
      isAbsolute(targetRelative) ||
      targetRelative === '..' ||
      targetRelative.startsWith(`..${sep}`)
    ) {
      throw new Error('Git workspace target must stay beneath the declared workspace root.');
    }

    await prepareWorkspaceTargetParent(root, dirname(target));

    const existing = await lstatIfExists(target);
    if (existing) {
      await assertPlainDirectory(target);
      if ((await readdir(target)).length > 0) {
        await assertRetainedWorkspaceSource(input, sessionDir);
        return await captureWorkspaceGitSnapshots(inputs, sessionDir, false);
      }
    } else {
      await mkdir(target);
    }
    await requireGitText(
      target,
      sessionDir,
      ['init', `--object-format=${input.source.commit.length === 64 ? 'sha256' : 'sha1'}`],
      {},
      'Remote Git workspace initialization failed.'
    );
    await requireGitText(
      target,
      sessionDir,
      ['remote', 'add', 'origin', input.source.url],
      {},
      'Remote Git origin configuration failed.'
    );
    await fetchDeclaredCommit(target, sessionDir, input.source.commit);
    await requireGitText(
      target,
      sessionDir,
      ['checkout', '--detach', input.source.commit],
      {},
      'Remote Git commit checkout failed.'
    );
    if (
      (await requireGitCommit(
        target,
        sessionDir,
        'HEAD',
        'Remote Git workspace HEAD is unavailable.'
      )) !== input.source.commit
    ) {
      throw new Error('Remote Git workspace HEAD does not match the declared commit.');
    }
    return await prepareWorkspaceGitSnapshots(inputs, sessionDir);
  }

  return new Map();
}

/** Creates only missing target-parent directories after the complete lexical chain is safe. */
async function prepareWorkspaceTargetParent(root: string, targetParent: string): Promise<void> {
  const chain = await inspectWorkspaceDirectoryChain(root, targetParent);
  for (const path of chain) {
    const status = await lstatIfExists(path);
    if (!status) {
      await mkdir(path);
    }
    await assertPlainDirectory(path);
  }
}

/** Returns the lexical trusted-ancestor chain after rejecting existing links and non-directories. */
async function inspectWorkspaceDirectoryChain(
  root: string,
  targetParent: string
): Promise<string[]> {
  let trustedRoot = root;
  while (!(await lstatIfExists(trustedRoot))) {
    const parent = dirname(trustedRoot);
    if (parent === trustedRoot) {
      throw new Error('Git workspace root has no existing directory ancestor.');
    }
    trustedRoot = parent;
  }

  const targetRelative = relative(trustedRoot, targetParent);
  if (
    isAbsolute(targetRelative) ||
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`)
  ) {
    throw new Error('Git workspace target parent escapes the declared workspace root.');
  }

  const chain = [trustedRoot];
  let current = trustedRoot;
  for (const segment of targetRelative.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    chain.push(current);
  }
  for (const path of chain) {
    const status = await lstatIfExists(path);
    if (status) {
      assertPlainDirectoryStatus(path, status);
    }
  }
  return chain;
}

/** Requires one path to remain an existing ordinary directory. */
async function assertPlainDirectory(path: string): Promise<void> {
  const status = await lstatIfExists(path);
  if (!status) {
    throw new Error('Git workspace directory disappeared during materialization.');
  }
  assertPlainDirectoryStatus(path, status);
}

/** Rejects one inspected directory status when it could redirect or block containment. */
function assertPlainDirectoryStatus(path: string, status: Awaited<ReturnType<typeof lstat>>): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(
      `Git workspace path must stay beneath the declared workspace root without symbolic-link ancestors: ${path}`
    );
  }
}

/** Returns link-preserving filesystem status without treating an absent path as failure. */
async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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
  return await captureWorkspaceGitSnapshots(inputs, sessionDir, true);
}

/** Captures exact Git bases while optionally admitting pre-existing retained work bytes. */
async function captureWorkspaceGitSnapshots(
  inputs: readonly WorkspaceGitInput[],
  sessionDir: string,
  requireClean: boolean
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
    if (requireClean && candidatePaths.length > 0) {
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

/** Verifies that a retained worktree still belongs to the requested exact source and baseline. */
async function assertRetainedWorkspaceSource(
  input: WorkspaceGitInput,
  sessionDir: string
): Promise<void> {
  const head = await requireGitCommit(
    input.target,
    sessionDir,
    'HEAD',
    'Retained Git workspace baseline is unavailable.'
  );
  if (head !== input.source.commit) {
    throw new Error('Retained Git workspace baseline conflicts with the requested commit.');
  }
  const origin = (
    await requireGitText(
      input.target,
      sessionDir,
      ['config', '--local', '--no-includes', '--get', 'remote.origin.url'],
      {},
      'Retained Git workspace source is unavailable.'
    )
  ).trim();
  if (origin !== input.source.url) {
    throw new Error('Retained Git workspace source conflicts with the requested origin.');
  }
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

/** Private stderr retained only to classify a failed fetch. It never enters a product error. */
const GIT_STDERR_LIMIT = 4096;

/** How a failed Git subprocess ended. Successful commands leave this null. */
type GitFailureKind = 'exit' | 'signal' | 'spawn' | 'timeout';

/** Outcome of one bounded Git subprocess. */
interface GitInvocation {
  readonly failure: GitFailureKind | null;
  readonly ok: boolean;
  readonly stderr: string;
  readonly stdout: Buffer;
}

/**
 * Fetches one exact commit into an empty slot.
 *
 * A depth-1 raw object id is the fast path, and both that fetch and the advertised-ref fallback use HTTP/1.1. Any completed nonzero fetch tries advertised branch tips and tags once. A timeout, signal, or spawn failure does not. Checkout continues only when the object type is exactly `commit`. A completed check that reports the object is absent is a distinct refusal. The terminal fetch failure is a certificate failure, a transport failure, or an ordinary fetch failure. Every other object-check failure stays an ordinary fetch failure.
 *
 * @param cwd Empty Git workspace root.
 * @param sessionDir Worker session directory used for the scrubbed Git environment.
 * @param commit Exact declared commit.
 */
async function fetchDeclaredCommit(cwd: string, sessionDir: string, commit: string): Promise<void> {
  const fetchConfig = ['http.version=HTTP/1.1'];
  const direct = await gitInvocation(
    cwd,
    sessionDir,
    ['fetch', '--no-tags', '--depth=1', 'origin', commit],
    {},
    undefined,
    fetchConfig
  );
  if (direct.ok) {
    return;
  }
  if (direct.failure !== 'exit') {
    throwTerminalFetchFailure(direct);
  }
  const advertised = await gitInvocation(
    cwd,
    sessionDir,
    ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
    {},
    undefined,
    fetchConfig
  );
  if (!advertised.ok) {
    throwTerminalFetchFailure(advertised);
  }
  const object = await gitInvocation(cwd, sessionDir, ['cat-file', '-t', commit]);
  if (object.ok) {
    if (object.stdout.toString('utf8').trim() !== 'commit') {
      throw new Error('Remote Git commit fetch failed.');
    }
    return;
  }
  if (
    object.failure === 'exit' &&
    object.stderr.toLowerCase().includes('could not get object info')
  ) {
    throw new Error('Remote Git commit is not available from the configured remote.');
  }
  throw new Error('Remote Git commit fetch failed.');
}

/** Private stderr phrases that identify a certificate failure without leaving the process. */
const FETCH_TLS_MARKERS = [
  'ssl certificate',
  'certificate problem',
  'self-signed',
  'unable to get local issuer',
  'tls certificate',
  'certificate signer not trusted',
  'server certificate verification failed',
  'certificate verification failed',
] as const;

/** Private stderr phrases that identify a transport failure without leaving the process. */
const FETCH_TRANSPORT_MARKERS = [
  'http/2',
  'http2 framing',
  'framing layer',
  'could not resolve host',
  'failed to connect',
  'connection refused',
  'connection reset',
  'connection timed out',
  'early eof',
  'proxy connect',
  'connect tunnel failed',
  'could not resolve proxy',
  'recv failure',
  'the requested url returned error: 401',
  'the requested url returned error: 403',
] as const;

/**
 * Refuses the terminal fetch with a closed product message.
 *
 * Timeout, signal, and spawn are transport failures. A completed failure is a certificate failure or a transport failure only when its private stderr matches a fixed phrase. HTTP 401 and 403 status lines are transport failures and are not evidence of a particular sandbox denial. Certificate phrases win when both are present. Every other completed failure stays ordinary.
 *
 * @param invocation Failed fetch invocation.
 */
function throwTerminalFetchFailure(invocation: GitInvocation): never {
  if (invocation.failure !== 'exit') {
    throw new Error('Remote Git commit fetch transport failed.');
  }
  const stderr = invocation.stderr.toLowerCase();
  if (FETCH_TLS_MARKERS.some((marker) => stderr.includes(marker))) {
    throw new Error('Remote Git commit fetch TLS failed.');
  }
  if (FETCH_TRANSPORT_MARKERS.some((marker) => stderr.includes(marker))) {
    throw new Error('Remote Git commit fetch transport failed.');
  }
  throw new Error('Remote Git commit fetch failed.');
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
  const result = await gitInvocation(cwd, sessionDir, argv, environment, stdin);
  return result.ok ? result.stdout : null;
}

/**
 * Runs one bounded Git subprocess and retains a private stderr prefix.
 *
 * @param cwd Git workspace root.
 * @param sessionDir Worker session directory used to disable ambient config.
 * @param argv Git argument vector.
 * @param environment Explicit command-local Git environment overrides.
 * @param stdin Optional exact stdin bytes.
 * @param config Git config assignments inserted before the subcommand.
 * @returns Success, exact stdout, a bounded stderr prefix, and the failure kind.
 */
async function gitInvocation(
  cwd: string,
  sessionDir: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  stdin?: Buffer,
  config: readonly string[] = []
): Promise<GitInvocation> {
  return new Promise((resolveOutput) => {
    const child = spawn(
      'git',
      [
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        ...config.flatMap((entry) => ['-c', entry]),
        ...argv,
      ],
      {
        cwd,
        env: gitEnvironment(sessionDir, environment),
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    let failure: GitFailureKind | null = null;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveOutput({ failure: ok ? null : failure, ok, stderr, stdout: Buffer.concat(chunks) });
    };
    const abort = () => {
      if (settled) {
        return;
      }
      failure = 'timeout';
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(abort, gitTimeoutMs());

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < GIT_STDERR_LIMIT) {
        stderr += chunk.toString('utf8');
        if (stderr.length > GIT_STDERR_LIMIT) {
          stderr = stderr.slice(0, GIT_STDERR_LIMIT);
        }
      }
    });
    child.stdin?.on('error', () => {
      if (settled || failure === 'timeout') {
        return;
      }
      failure = 'spawn';
      child.kill('SIGKILL');
    });
    child.on('error', () => {
      failure = 'spawn';
      finish(false);
    });
    child.on('close', (exitCode, signal) => {
      if (failure === 'timeout' || failure === 'spawn') {
        finish(false);
        return;
      }
      if (exitCode === 0 && !signal) {
        finish(true);
        return;
      }
      failure = signal ? 'signal' : 'exit';
      finish(false);
    });
    child.stdin?.end(stdin);
  });
}

/**
 * Returns the Git subprocess budget.
 *
 * Tests may shorten it with `OPENKIT_WORKER_GIT_TIMEOUT_MS`. Production ignores that variable.
 *
 * @returns Timeout in milliseconds.
 */
function gitTimeoutMs(): number {
  if (process.env.NODE_ENV !== 'test') {
    return GIT_TIMEOUT_MS;
  }
  const override = Number(process.env.OPENKIT_WORKER_GIT_TIMEOUT_MS);
  if (Number.isSafeInteger(override) && override > 0) {
    return override;
  }
  return GIT_TIMEOUT_MS;
}

/**
 * Builds the allowlisted Git subprocess environment and explicit safety controls. A nonempty `SSL_CERT_FILE` is copied to both `GIT_SSL_CAINFO` and `CURL_CA_BUNDLE`. Ambient CA paths do not win.
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
  if (process.env.SSL_CERT_FILE) {
    environment.CURL_CA_BUNDLE = process.env.SSL_CERT_FILE;
    environment.GIT_SSL_CAINFO = process.env.SSL_CERT_FILE;
  }

  for (const key of [
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
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
