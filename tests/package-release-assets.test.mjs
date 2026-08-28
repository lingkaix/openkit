import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { packageReleaseAssets } from '../scripts/package-release-assets.mjs';

test('release packager archives the complete Skill and writes its SHA-256', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'openkit-release-assets-'));
  writeFileSync(join(repoRoot, 'LICENSE'), 'fixture license\n');
  mkdirSync(join(repoRoot, 'skills', 'openkit', 'references'), { recursive: true });
  mkdirSync(join(repoRoot, 'skills', 'openkit', 'scripts'), { recursive: true });
  writeFileSync(join(repoRoot, 'skills', 'openkit', 'SKILL.md'), '# Fixture Skill\n');
  writeFileSync(join(repoRoot, 'skills', 'openkit', 'references', 'setup.md'), '# Setup\n');
  const cliPath = join(repoRoot, 'skills', 'openkit', 'scripts', 'openkit');
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  chmodSync(cliPath, 0o755);
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'release-test@openkit.local']);
  git(repoRoot, ['config', 'user.name', 'OpenKit Release Test']);
  git(repoRoot, ['add', 'LICENSE', 'skills/openkit']);
  git(repoRoot, ['commit', '-qm', 'fixture']);

  const outputDir = join(repoRoot, 'dist', 'release');
  const result = packageReleaseAssets({
    outputDir,
    ref: 'HEAD',
    repoRoot,
    tag: 'v0.1.0-rc.1',
  });
  const repeated = packageReleaseAssets({
    outputDir: join(repoRoot, 'dist', 'repeated'),
    ref: 'HEAD',
    repoRoot,
    tag: 'v0.1.0-rc.1',
  });
  const archive = readFileSync(result.archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const listed = spawnSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' });

  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), [
    'openkit-skill-v0.1.0-rc.1/',
    'openkit-skill-v0.1.0-rc.1/LICENSE',
    'openkit-skill-v0.1.0-rc.1/skills/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/SKILL.md',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/references/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/references/setup.md',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/scripts/',
    'openkit-skill-v0.1.0-rc.1/skills/openkit/scripts/openkit',
  ]);
  assert.equal(result.checksum, checksum);
  assert.equal(repeated.checksum, checksum);
  assert.equal(
    readFileSync(result.checksumPath, 'utf8'),
    `${checksum}  openkit-skill-v0.1.0-rc.1.tar.gz\n`
  );
  const extractDir = join(repoRoot, 'extract');
  mkdirSync(extractDir);
  const extracted = spawnSync('tar', ['-xzf', result.archivePath, '-C', extractDir], {
    encoding: 'utf8',
  });
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.notEqual(
    statSync(
      join(extractDir, 'openkit-skill-v0.1.0-rc.1', 'skills', 'openkit', 'scripts', 'openkit')
    ).mode & 0o111,
    0
  );
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
