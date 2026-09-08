import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectBoundedTree,
  digestOpenKitTree,
  hashOpenKitTreeEntries,
  OPENKIT_TREE_DIGEST_FORMAT,
} from './tree-digest.js';

describe('openkit-tree-v1', () => {
  it('hashes the empty tree as domain, zero byte, and zero entry count', () => {
    expect(hashOpenKitTreeEntries([])).toBe(
      'sha256:a140c7ce340858d21344be6f53bf5019394752daed540df504ac4d4e0bb56ca4'
    );
  });

  it('includes empty directories and executable bits in identity', () => {
    const emptyDirOnly = hashOpenKitTreeEntries([{ kind: 0, path: 'bin' }]);
    const fileOnly = hashOpenKitTreeEntries([
      { content: Buffer.from('hello\n', 'utf8'), kind: 1, path: 'SKILL.md' },
    ]);
    const withExecutable = hashOpenKitTreeEntries([
      { content: Buffer.from('hello\n', 'utf8'), kind: 1, path: 'SKILL.md' },
      { content: Buffer.from('#!/bin/sh\n', 'utf8'), kind: 2, path: 'bin/run' },
      { kind: 0, path: 'bin' },
    ]);
    const withoutExecutableBit = hashOpenKitTreeEntries([
      { content: Buffer.from('hello\n', 'utf8'), kind: 1, path: 'SKILL.md' },
      { content: Buffer.from('#!/bin/sh\n', 'utf8'), kind: 1, path: 'bin/run' },
      { kind: 0, path: 'bin' },
    ]);

    expect(emptyDirOnly).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fileOnly).not.toBe(emptyDirOnly);
    expect(withExecutable).not.toBe(fileOnly);
    expect(withExecutable).not.toBe(withoutExecutableBit);
  });

  it('orders records by unsigned UTF-8 path bytes and ignores insertion order', () => {
    const left = hashOpenKitTreeEntries([
      { content: Buffer.from('b', 'utf8'), kind: 1, path: 'b.md' },
      { content: Buffer.from('a', 'utf8'), kind: 1, path: 'a.md' },
    ]);
    const right = hashOpenKitTreeEntries([
      { content: Buffer.from('a', 'utf8'), kind: 1, path: 'a.md' },
      { content: Buffer.from('b', 'utf8'), kind: 1, path: 'b.md' },
    ]);

    expect(left).toBe(right);
  });

  it('rejects unsafe, non-NFC, duplicate, and oversized trees', () => {
    expect(() => hashOpenKitTreeEntries([{ kind: 0, path: '../escape' }])).toThrow(
      /parent path segment/
    );
    expect(() => hashOpenKitTreeEntries([{ kind: 0, path: 'a\\b' }])).toThrow(/backslash/);
    expect(() => hashOpenKitTreeEntries([{ kind: 0, path: 'cafe\u0301' }])).toThrow(/NFC/);
    expect(() =>
      hashOpenKitTreeEntries([
        { kind: 0, path: 'dup' },
        { kind: 1, path: 'dup', content: Buffer.alloc(0) },
      ])
    ).toThrow(/duplicate/i);
    expect(() =>
      hashOpenKitTreeEntries(
        Array.from({ length: 1_025 }, (_, index) => ({
          kind: 0 as const,
          path: `d${index}`,
        })),
        { maxEntries: 1_024 }
      )
    ).toThrow(/1,024/);
  });

  it('collects a filesystem tree, strips .git, and preserves executability', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-tree-'));
    try {
      mkdirSync(join(root, 'refs'));
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, 'SKILL.md'), '# Hello\n');
      writeFileSync(join(root, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      chmodSync(join(root, 'bin', 'run.sh'), 0o755);
      const collected = collectBoundedTree(root, { maxBytes: 16 * 1024 * 1024, maxEntries: 1_024 });
      expect(collected.map((entry) => entry.path)).toEqual([
        'SKILL.md',
        'bin',
        'bin/run.sh',
        'refs',
      ]);
      expect(collected.find((entry) => entry.path === 'bin/run.sh')?.kind).toBe(2);
      expect(digestOpenKitTree(root).digestFormat).toBe(OPENKIT_TREE_DIGEST_FORMAT);
      expect(digestOpenKitTree(root).digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects ill-formed surrogate paths', () => {
    expect(() => hashOpenKitTreeEntries([{ kind: 0, path: '\uD800' }])).toThrow(/UTF-8/);
  });

  it('rejects an uploaded tree that contains a .git path segment', () => {
    expect(() => hashOpenKitTreeEntries([{ kind: 0, path: '.git' }])).toThrow(/\.git/);
    expect(() =>
      hashOpenKitTreeEntries([{ content: Buffer.from('x'), kind: 1, path: 'foo/.git/config' }])
    ).toThrow(/\.git/);
  });
});
