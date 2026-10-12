// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EMPTY_RESOURCE_CATALOG } from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => ({
  events: [] as Array<{ op: 'writeFileSync' | 'fsyncSync' | 'renameSync'; to?: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      trace.events.push({ op: 'writeFileSync' });
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    fsyncSync: ((descriptor: number) => {
      trace.events.push({ op: 'fsyncSync' });
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ) => {
      trace.events.push({ op: 'renameSync', to: String(to) });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

import { publishWorkspaceResourceCatalog } from './resource-catalog.js';

/**
 * Requires a file fsync between the temporary write and rename, then a directory fsync.
 *
 * @param events Recorded filesystem operations.
 * @param destinationSuffix Renamed target suffix.
 */
function expectDurableRename(
  events: Array<{ op: 'writeFileSync' | 'fsyncSync' | 'renameSync'; to?: string }>,
  destinationSuffix: string
): void {
  const renameAt = events.findIndex(
    (event) => event.op === 'renameSync' && event.to?.endsWith(destinationSuffix)
  );
  expect(renameAt).toBeGreaterThan(0);
  const writeAt = events.slice(0, renameAt).findLastIndex((event) => event.op === 'writeFileSync');
  expect(writeAt).toBeGreaterThanOrEqual(0);
  expect(events.slice(writeAt + 1, renameAt).some((event) => event.op === 'fsyncSync')).toBe(true);
  expect(events.slice(renameAt + 1).some((event) => event.op === 'fsyncSync')).toBe(true);
}

describe('resource catalog durable publication', () => {
  it('fsyncs catalog.json before and after the atomic rename', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-durable-'));
    trace.events.length = 0;
    const published = publishWorkspaceResourceCatalog({
      catalog: EMPTY_RESOURCE_CATALOG,
      dataRoot,
      expectedRevision: 0,
      workspaceId: 'ws_durable',
    });
    expect(published.revision).toBe(1);
    expectDurableRename(trace.events, '/catalog/catalog.json');
  });
});
