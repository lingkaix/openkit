import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareTimelineCacheReads,
  shrinkTimelineCacheReads,
  timelineCacheReadSites,
} from '../scripts/validate-timeline-cache-reads.mjs';

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
