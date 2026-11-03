// openkit-test-platform: posix
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs, { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRemoteEcosystemSkill } from './skill-ecosystem-source.js';
import { SkillSourceInputError } from './skill-source.js';

const roots: string[] = [];
const daemons: ChildProcess[] = [];
const releaseHeader =
  '---\nname: Release Example\ndescription: Exact committed Skill.\n---\nInstructions.\n';
const otherHeader =
  '---\nname: Other Example\ndescription: Second committed Skill.\n---\nOther instructions.\n';

/** Isolates fixture Git from ambient configuration and credentials and keeps commits reproducible. */
const gitEnvironment = {
  PATH: process.env.PATH,
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Skill fixture',
  GIT_AUTHOR_EMAIL: 'fixture',
  GIT_COMMITTER_NAME: 'Skill fixture',
  GIT_COMMITTER_EMAIL: 'fixture',
};

/** Builds a real disposable repository so served objects stay outside the test process. */
function repository() {
  const parent = fs.mkdtempSync(join(tmpdir(), 'openkit-skill-ecosystem-git-'));
  roots.push(parent);
  const root = join(parent, 'repo');
  mkdirSync(root);
  const git = (args: readonly string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '--initial-branch=main']);
  mkdirSync(join(root, 'skills', 'release', 'references'), { recursive: true });
  writeFileSync(join(root, 'skills', 'release', 'SKILL.md'), releaseHeader);
  writeFileSync(
    join(root, 'skills', 'release', 'references', 'data.bin'),
    Buffer.from([0, 255, 16])
  );
  writeFileSync(join(root, 'skills', 'release', 'run.sh'), '#!/bin/sh\nprintf exact\n');
  chmodSync(join(root, 'skills', 'release', 'run.sh'), 0o755);
  return { parent, root, git };
}

/** Adds a second committed package so selection between candidates stays observable. */
function addOtherSkill(root: string): void {
  mkdirSync(join(root, 'skills', 'other'), { recursive: true });
  writeFileSync(join(root, 'skills', 'other', 'SKILL.md'), otherHeader);
}

/** Reserves one loopback port by listening on port 0 and releasing it before the daemon binds. */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback probe did not bind.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

/** Waits for the daemon's own listener; spawn completion does not prove readiness. */
async function waitForDaemon(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('git daemon exited before accepting connections.');
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    if (Date.now() > deadline) throw new Error('git daemon did not accept connections.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Serves the disposable repository through a loopback-only git daemon. The public locator refuses
 * local paths and file URLs, so real Git transport is the only admitted way to observe commits.
 */
async function serve(fixture: { parent: string }, ref?: string): Promise<{ locator: string }> {
  const port = await freeLoopbackPort();
  const child = spawn(
    'git',
    [
      '-c',
      'uploadpack.allowFilter=true',
      'daemon',
      '--export-all',
      '--reuseaddr',
      `--base-path=${fixture.parent}`,
      '--listen=127.0.0.1',
      `--port=${port}`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );
  daemons.push(child);
  await waitForDaemon(child, port);
  return { locator: `git://127.0.0.1:${port}/repo${ref === undefined ? '' : `#${ref}`}` };
}

/** Stops one daemon before its fixture directory is removed. */
async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** Records real scratch allocation because the acquisition result cannot reveal cleanup. */
function observeScratchDirectories(): string[] {
  const directories: string[] = [];
  const createDirectory = fs.mkdtempSync;
  vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
    const directory = createDirectory(prefix, options);
    directories.push(directory.toString());
    roots.push(directory.toString());
    return directory;
  });
  syncBuiltinESMExports();
  return directories;
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(daemons.splice(0).map((child) => stopDaemon(child)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Git ecosystem Skill acquisition over a loopback remote', () => {
  it('pins the served commit and returns committed bytes and executable facts despite uncommitted changes', async () => {
    const fixture = repository();
    fixture.git(['add', '.']);
    fixture.git(['commit', '-m', 'Initial Skill']);
    const commit = fixture.git(['rev-parse', 'HEAD']);
    writeFileSync(join(fixture.root, 'skills', 'release', 'SKILL.md'), 'uncommitted bytes');
    const served = await serve(fixture, 'main');
    const scratch = observeScratchDirectories();
    const acquired = await acquireRemoteEcosystemSkill({
      source: served.locator,
      sourceSubpath: 'skills/release',
    });
    expect(acquired.sourceCommit).toBe(commit);
    expect(acquired.sourceLocator).toBe(served.locator);
    expect(acquired.sourceSubpath).toBe('skills/release');
    const tree = new Map(acquired.tree.map((entry) => [entry.path, entry] as const));
    expect(tree.get('SKILL.md')).toEqual({
      path: 'SKILL.md',
      kind: 'file',
      executable: false,
      contentBase64: Buffer.from(releaseHeader).toString('base64'),
    });
    expect(tree.get('references')?.kind).toBe('directory');
    expect(tree.get('references/data.bin')?.contentBase64).toBe(
      Buffer.from([0, 255, 16]).toString('base64')
    );
    expect(tree.get('run.sh')).toEqual({
      path: 'run.sh',
      kind: 'file',
      executable: true,
      contentBase64: Buffer.from('#!/bin/sh\nprintf exact\n').toString('base64'),
    });
    expect(tree.has('linked.txt')).toBe(false);
    expect(acquired.tree.some((entry) => entry.path.includes('.git'))).toBe(false);
    expect(scratch).toHaveLength(1);
    expect(() => fs.lstatSync(scratch[0]!)).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(commit);
    expect(fs.readFileSync(join(fixture.root, 'skills', 'release', 'SKILL.md'), 'utf8')).toBe(
      'uncommitted bytes'
    );
    expect(
      fs.readFileSync(join(fixture.root, 'skills', 'release', 'references', 'data.bin'))
    ).toEqual(Buffer.from([0, 255, 16]));
    expect(fs.readFileSync(join(fixture.root, 'skills', 'release', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\nprintf exact\n'
    );
    expect(fs.statSync(join(fixture.root, 'skills', 'release', 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('refuses a committed link in the selected package without reading content outside it', async () => {
    const fixture = repository();
    symlinkSync('../../outside.txt', join(fixture.root, 'skills', 'release', 'linked.txt'));
    writeFileSync(join(fixture.root, 'outside.txt'), 'not Skill supply');
    fixture.git(['add', '.']);
    fixture.git(['commit', '-m', 'Linked content']);
    const commit = fixture.git(['rev-parse', 'HEAD']);
    // The fixture must really carry a committed link; otherwise the refusal proves nothing.
    expect(fixture.git(['ls-tree', 'HEAD', 'skills/release/linked.txt']).split(' ')[0]).toBe(
      '120000'
    );
    const served = await serve(fixture);
    const scratch = observeScratchDirectories();
    await expect(
      acquireRemoteEcosystemSkill({ source: served.locator, sourceSubpath: 'skills/release' })
    ).rejects.toBeInstanceOf(SkillSourceInputError);
    expect(scratch).toHaveLength(1);
    expect(() => fs.lstatSync(scratch[0]!)).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(commit);
    expect(fs.readFileSync(join(fixture.root, 'skills', 'release', 'SKILL.md'), 'utf8')).toBe(
      releaseHeader
    );
    expect(fs.readlinkSync(join(fixture.root, 'skills', 'release', 'linked.txt'))).toBe(
      '../../outside.txt'
    );
    expect(fs.readFileSync(join(fixture.root, 'outside.txt'), 'utf8')).toBe('not Skill supply');
  });

  it('selects one committed package by sourceSubpath or by Skill name and refuses ambiguity', async () => {
    const fixture = repository();
    addOtherSkill(fixture.root);
    fixture.git(['add', '.']);
    fixture.git(['commit', '-m', 'Two Skills']);
    const served = await serve(fixture);
    const scratch = observeScratchDirectories();
    const bySubpath = await acquireRemoteEcosystemSkill({
      source: served.locator,
      sourceSubpath: 'skills/release',
    });
    expect(bySubpath.sourceSubpath).toBe('skills/release');
    expect(bySubpath.tree.find((entry) => entry.path === 'SKILL.md')?.contentBase64).toBe(
      Buffer.from(releaseHeader).toString('base64')
    );
    const byName = await acquireRemoteEcosystemSkill({
      source: served.locator,
      sourceSkillName: 'other example',
    });
    expect(byName.sourceSubpath).toBe('skills/other');
    expect(byName.tree.find((entry) => entry.path === 'SKILL.md')?.contentBase64).toBe(
      Buffer.from(otherHeader).toString('base64')
    );
    await expect(acquireRemoteEcosystemSkill({ source: served.locator })).rejects.toBeInstanceOf(
      SkillSourceInputError
    );
    expect(scratch).toHaveLength(3);
    for (const directory of scratch)
      expect(() => fs.lstatSync(directory)).toThrowError(
        expect.objectContaining({ code: 'ENOENT' })
      );
  });

  it('refuses an explicit Skill name that disagrees with the locator-pinned selection', async () => {
    const fixture = repository();
    addOtherSkill(fixture.root);
    fixture.git(['add', '.']);
    fixture.git(['commit', '-m', 'Two Skills']);
    const served = await serve(fixture, 'main@Release%20Example');
    await expect(
      acquireRemoteEcosystemSkill({
        source: served.locator,
        sourceSkillName: 'Other Example',
      })
    ).rejects.toBeInstanceOf(SkillSourceInputError);
    const agreed = await acquireRemoteEcosystemSkill({
      source: served.locator,
      sourceSkillName: 'Release Example',
    });
    expect(agreed.sourceSubpath).toBe('skills/release');
    // Provenance keeps the resolved ref and drops the selection suffix of the authored locator.
    expect(agreed.sourceLocator).toBe(served.locator.slice(0, served.locator.indexOf('@')));
  });

  it('refuses a local repository path and its file URL because only a remote locator is admitted', async () => {
    const fixture = repository();
    fixture.git(['add', '.']);
    fixture.git(['commit', '-m', 'Initial Skill']);
    await expect(acquireRemoteEcosystemSkill({ source: fixture.root })).rejects.toBeInstanceOf(
      SkillSourceInputError
    );
    await expect(
      acquireRemoteEcosystemSkill({ source: `file://${fixture.root}` })
    ).rejects.toBeInstanceOf(SkillSourceInputError);
  });
});
