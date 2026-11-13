import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareTimelineCacheReads,
  shrinkTimelineCacheReads,
  timelineCacheReadSites,
} from '../scripts/validate-timeline-cache-reads.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const why = 'Reads only the displayed window key, not every cached timeline.';

test('counts getQueriesData and getQueryCache().findAll calls, not comments or strings', () => {
  const sites = timelineCacheReadSites(
    'apps/web/src/screens/chat/timeline/reader.ts',
    `
      queryClient.getQueriesData({ queryKey });
      client?.getQueriesData({ queryKey: ['thread-timeline'] });
      cache.getQueryCache().findAll({ queryKey });
      cache?.getQueryCache()?.findAll({ queryKey });
      // queryClient.getQueriesData({ queryKey })
      const sample = 'getQueryCache().findAll(';
      other.findAll({ queryKey });
    `
  );
  assert.deepEqual(
    sites.map((site) => site.callee),
    ['getQueriesData', 'getQueriesData', 'getQueryCache().findAll', 'getQueryCache().findAll']
  );
});

test('a new call fails and a removed call must shrink', () => {
  const actual = [
    { path: 'apps/web/src/screens/chat/timeline/reader.ts', callee: 'getQueriesData' },
  ];
  const allowed = [
    {
      path: 'apps/web/src/screens/chat/ThreadStream.tsx',
      callee: 'getQueryCache().findAll',
      why,
    },
  ];
  assert.match(compareTimelineCacheReads(actual, allowed).join('\n'), /New timeline cache read/);
  assert.match(compareTimelineCacheReads(actual, allowed).join('\n'), /Stale timeline cache-read/);
  assert.deepEqual(compareTimelineCacheReads([], []), []);
});

test('refresh-shrink drops a gone row and refuses growth', () => {
  const kept = {
    path: 'apps/web/src/screens/chat/timeline/reader.ts',
    callee: 'getQueriesData',
    why,
  };
  const gone = {
    path: 'apps/web/src/screens/chat/ThreadStream.tsx',
    callee: 'getQueryCache().findAll',
    why,
  };
  const shrunk = shrinkTimelineCacheReads([kept], [kept, gone]);
  assert.deepEqual(shrunk.failures, []);
  assert.deepEqual(shrunk.sites, [kept]);
  const grown = shrinkTimelineCacheReads([kept, gone], [kept]);
  assert.match(grown.failures.join('\n'), /New timeline cache read/);
});

test('a tracked JavaScript timeline file with a new call fails until that file is removed', () => {
  const rel = 'apps/web/src/screens/chat/timeline/ratchet-probe.js';
  const abs = resolve(repoRoot, rel);
  const remove = () => {
    execFileSync('git', ['rm', '-f', '--ignore-unmatch', '--', rel], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    rmSync(abs, { force: true });
  };
  const run = () =>
    spawnSync(process.execPath, ['scripts/validate-timeline-cache-reads.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  remove();
  try {
    writeFileSync(abs, 'client.getQueriesData({})\n');
    execFileSync('git', ['add', '--', rel], { cwd: repoRoot });
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(
      failed.stderr,
      /New timeline cache read apps\/web\/src\/screens\/chat\/timeline\/ratchet-probe\.js getQueriesData \(1, allowlist 0\)/
    );
    remove();
    const passed = run();
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /Timeline cache reads: PASS \(0 allowlisted sites; shrink only\)/);
    assert.equal(
      execFileSync('git', ['ls-files', '--', rel], { cwd: repoRoot, encoding: 'utf8' }),
      ''
    );
  } finally {
    remove();
  }
});
