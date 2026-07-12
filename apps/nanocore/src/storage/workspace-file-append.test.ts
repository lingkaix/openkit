import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const partialWriteState = vi.hoisted(() => ({ calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeSync = ((...args: unknown[]) => {
    const descriptor = args[0] as number;
    const value = args[1];

    partialWriteState.calls += 1;
    if (typeof value === 'string') {
      const buffer = Buffer.from(value);
      return actual.writeSync(descriptor, buffer, 0, Math.max(1, Math.ceil(buffer.length / 2)));
    }

    const buffer = value as Uint8Array;
    const offset = (args[2] as number | undefined) ?? 0;
    const length = (args[3] as number | undefined) ?? buffer.byteLength - offset;
    return actual.writeSync(descriptor, buffer, offset, Math.max(1, Math.ceil(length / 2)));
  }) as typeof actual.writeSync;

  return { ...actual, writeSync };
});

import { appendWorkspaceItemRevision } from './workspace-file-records.js';

describe('canonical append writes', () => {
  it('finishes one JSONL row when the filesystem reports partial writes', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-partial-append-'));
    const threadId = 'th_partial_append';
    const turnId = 'tu_partial_append';
    const item = {
      id: 'it_partial_append',
      workspaceId: 'ws_partial_append',
      threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'The complete row must reach the append log.',
      createdAt: '2026-07-07T00:00:00.000Z',
      completedAt: '2026-07-07T00:00:00.000Z',
    } as const;

    mkdirSync(join(workspaceRoot, 'threads', threadId, 'turns', turnId), { recursive: true });
    appendWorkspaceItemRevision(workspaceRoot, item);

    const content = readFileSync(
      join(workspaceRoot, 'threads', threadId, 'turns', turnId, 'items.jsonl'),
      'utf8'
    );
    expect(JSON.parse(content)).toEqual(item);
    expect(partialWriteState.calls).toBeGreaterThan(1);
  });
});
