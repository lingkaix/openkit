import { expect, it } from 'vitest';
import { ThreadSchema } from './models/thread.js';

const thread = {
  id: 'th_00000000-0000-7000-8000-000000000001',
  owner: { kind: 'server' },
  name: 'History',
  preview: 'History',
  status: 'active',
  entryPath: 'conversation',
  visibility: 'server',
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
};
const segmentation = { maxObservationLines: 10_000, maxBytes: 100_000_000, boundaryDelayed: true };

it('preserves reserved segmentation fields and leaves historical absence unchanged', () => {
  expect(JSON.stringify(ThreadSchema.parse(thread))).toBe(JSON.stringify(thread));
  for (const fields of [
    {},
    { segment: 0 },
    { segmentation },
    {
      parentThreadId: 'th_00000000-0000-7000-8000-000000000002',
      segment: 1,
      segmentation,
    },
  ]) {
    const record = { ...thread, ...fields };
    const parsed = ThreadSchema.parse(record);
    expect(parsed).toEqual(record);
    const canonical = JSON.stringify(parsed);
    expect(JSON.stringify(ThreadSchema.parse(JSON.parse(canonical)))).toBe(canonical);
  }
});

it.each([
  { segment: -1 },
  { segment: 0.5 },
  { segment: '1' },
  { segment: null },
  { segmentation: null },
  { segmentation: { ...segmentation, maxObservationLines: 0 } },
  { segmentation: { ...segmentation, maxBytes: -1 } },
  { segmentation: { ...segmentation, maxBytes: 1.5 } },
  { segmentation: { ...segmentation, boundaryDelayed: false } },
  { segmentation: { maxObservationLines: 10_000, maxBytes: 100_000_000 } },
])('refuses malformed reserved Thread fields: %j', (fields) => {
  expect(ThreadSchema.safeParse({ ...thread, ...fields }).success).toBe(false);
});
