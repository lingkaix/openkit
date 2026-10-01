import * as childProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { readWorkspaceSnapshotCandidate } from './workspace-snapshot-candidate.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const marker = 'openkit-full-mode-delta\n';
describe('native snapshot candidate bytes', () => {
  it('refuses malformed Git path statistics with a named admission error', () => {
    const stats = vi
      .mocked(childProcess.execFileSync)
      .mockReturnValueOnce(Buffer.from('malformed\0'));
    try {
      expect(() => readWorkspaceSnapshotCandidate(Buffer.from('git candidate'))).toThrow(
        'path statistics are malformed'
      );
    } finally {
      stats.mockClear();
    }
  });
  it('retains an embedded line feed in a length-framed mode-only path', () => {
    const path = 'dir/a\nb';
    const result = readWorkspaceSnapshotCandidate(
      Buffer.from(`${marker}0644 0600 ${Buffer.byteLength(path)} ${path}\n`)
    );
    expect(result.gitPatch.length).toBe(0);
    expect(result.requiresRefinement).toBe(true);
    expect(result.changedPaths).toEqual([
      {
        path,
        status: 'mode_changed',
        binary: false,
        oldPermissions: '0644',
        newPermissions: '0600',
      },
    ]);
  });
  it('decodes a path containing the mode delimiter without splitting inside that path', () => {
    const path = 'dir/a\nopenkit-full-mode-delta\nb';
    expect(
      readWorkspaceSnapshotCandidate(
        Buffer.from(`${marker}0644 0600 ${Buffer.byteLength(path)} ${path}\n`)
      ).changedPaths[0]?.path
    ).toBe(path);
  });
  it('projects an executable-bit-only Git delta as a supported permission change', () => {
    const bytes = Buffer.from(
      `diff --git a/a b/a\nold mode 100644\nnew mode 100755\n${marker}0644 0755 1 a\n`
    );
    const result = readWorkspaceSnapshotCandidate(bytes);
    expect(result.changedPaths).toEqual([
      {
        path: 'a',
        status: 'mode_changed',
        binary: false,
        oldPermissions: '0644',
        newPermissions: '0755',
      },
    ]);
    expect(result.requiresRefinement).toBe(false);
  });
  it('requires refinement for manifest-only directory paths mixed into a Git candidate', () => {
    const patch =
      'diff --git a/a b/a\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..78981922613b2afb6025042ff6bd878ac1994e85\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+a\n';
    const result = readWorkspaceSnapshotCandidate(
      Buffer.from(`${patch}${marker}---- 0644 1 a\n---- 0755 3 dir\n`)
    );
    expect(result.changedPaths.map((entry) => entry.path)).toEqual(['a', 'dir']);
    expect(result.requiresRefinement).toBe(true);
  });
  it('decodes an ordinary cumulative Git candidate with full permission metadata', () => {
    const bytes = Buffer.from(
      'diff --git a/a b/a\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..78981922613b2afb6025042ff6bd878ac1994e85\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+a\n' +
        marker +
        '---- 0644 1 a\n'
    );
    const result = readWorkspaceSnapshotCandidate(bytes);
    expect(result.changedPaths).toEqual([
      { path: 'a', status: 'added', binary: false, newPermissions: '0644' },
    ]);
    expect(result.requiresRefinement).toBe(false);
    expect(result.gitPatch.includes(Buffer.from(marker))).toBe(false);
  });
  it.each([
    '',
    'not-a-mode-record\n',
    '0644 0644 1 a\n',
    '---- ---- 1 a\n',
    '0644 0600 01 a\n',
    '0644 0600 5 a\n',
    '0644 0600 1 aX',
    '0644 0600 1 b\n0644 0600 1 a\n',
    '0644 0600 1 a\n0644 0600 1 a\n',
    '0644 0600 3 ../\n',
  ])('refuses malformed or unsafe mode framing %j', (record) => {
    expect(() => readWorkspaceSnapshotCandidate(Buffer.from(marker + record))).toThrow(
      record === 'not-a-mode-record\n' || record.includes(' 01 ')
        ? 'mode record is malformed'
        : undefined
    );
  });
});
