// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireGitEcosystemSkill } from './skill-git-source.js';
import { SkillSourceInputError } from './skill-source.js';

const roots: string[] = [];
const header =
  '---\nname: Release Example\ndescription: Exact committed Skill.\n---\nInstructions.\n';

/** A real disposable repository supplies immutable source observations without network access. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-skill-source-git-'));
  roots.push(root);
  const git = (args: readonly string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Skill fixture',
        GIT_AUTHOR_EMAIL: 'fixture',
        GIT_COMMITTER_NAME: 'Skill fixture',
        GIT_COMMITTER_EMAIL: 'fixture',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '--initial-branch=main']);
  mkdirSync(join(root, 'skills', 'release', 'references'), { recursive: true });
  writeFileSync(join(root, 'skills', 'release', 'SKILL.md'), header);
  writeFileSync(
    join(root, 'skills', 'release', 'references', 'data.bin'),
    Buffer.from([0, 255, 16])
  );
  writeFileSync(join(root, 'skills', 'release', 'run.sh'), '#!/bin/sh\nprintf exact\n');
  chmodSync(join(root, 'skills', 'release', 'run.sh'), 0o755);
  return {
    root,
    git,
    source: {
      kind: 'git' as const,
      url: root,
      source: 'git:test-fixture',
      ref: 'main',
      subpath: 'skills/release',
      skillName: null,
    },
  };
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

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('committed ecosystem Skill acquisition', () => {
  it('pins the resolved commit and imports committed support bytes and executable facts without a checkout', async () => {
    const f = fixture();
    f.git(['add', '.']);
    f.git(['commit', '-m', 'Initial Skill']);
    const commit = f.git(['rev-parse', 'HEAD']);
    writeFileSync(join(f.root, 'skills', 'release', 'SKILL.md'), 'uncommitted bytes');
    const scratch = observeScratchDirectories();
    const acquired = await acquireGitEcosystemSkill(f.source);
    expect(acquired).toMatchObject({
      source: 'git:test-fixture',
      sourceCommit: commit,
      subpath: 'skills/release',
      name: 'Release Example',
    });
    expect(acquired.tree.find((entry) => entry.path === 'SKILL.md')?.contentBase64).toBe(
      Buffer.from(header).toString('base64')
    );
    expect(acquired.tree.find((entry) => entry.path === 'references/data.bin')?.contentBase64).toBe(
      Buffer.from([0, 255, 16]).toString('base64')
    );
    expect(acquired.tree.find((entry) => entry.path === 'run.sh')?.executable).toBe(true);
    expect(acquired.tree.some((entry) => entry.path.includes('.git'))).toBe(false);
    expect(scratch).toHaveLength(1);
    expect(() => fs.lstatSync(scratch[0]!)).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
    expect(f.git(['rev-parse', 'HEAD'])).toBe(commit);
    expect(fs.readFileSync(join(f.root, 'skills', 'release', 'SKILL.md'), 'utf8')).toBe(
      'uncommitted bytes'
    );
    expect(fs.readFileSync(join(f.root, 'skills', 'release', 'references', 'data.bin'))).toEqual(
      Buffer.from([0, 255, 16])
    );
    expect(fs.readFileSync(join(f.root, 'skills', 'release', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\nprintf exact\n'
    );
  });

  it('refuses a selected committed link instead of resolving content outside the package', async () => {
    const f = fixture();
    symlinkSync('../../outside.txt', join(f.root, 'skills', 'release', 'linked.txt'));
    writeFileSync(join(f.root, 'outside.txt'), 'not Skill supply');
    f.git(['add', '.']);
    f.git(['commit', '-m', 'Linked content']);
    const commit = f.git(['rev-parse', 'HEAD']);
    const scratch = observeScratchDirectories();
    await expect(acquireGitEcosystemSkill(f.source)).rejects.toBeInstanceOf(SkillSourceInputError);
    expect(scratch).toHaveLength(1);
    expect(() => fs.lstatSync(scratch[0]!)).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
    expect(f.git(['rev-parse', 'HEAD'])).toBe(commit);
    expect(fs.readFileSync(join(f.root, 'skills', 'release', 'SKILL.md'), 'utf8')).toBe(header);
    expect(fs.readFileSync(join(f.root, 'skills', 'release', 'references', 'data.bin'))).toEqual(
      Buffer.from([0, 255, 16])
    );
    expect(fs.readFileSync(join(f.root, 'skills', 'release', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\nprintf exact\n'
    );
    expect(fs.readlinkSync(join(f.root, 'skills', 'release', 'linked.txt'))).toBe(
      '../../outside.txt'
    );
    expect(fs.readFileSync(join(f.root, 'outside.txt'), 'utf8')).toBe('not Skill supply');
  });
});
