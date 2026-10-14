// openkit-test-platform: posix
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeNotebook, type NotebookCommitMetadata } from './knowledge-notebook.js';

const attribution = {
  name: 'Notebook fixture',
  email: 'fixture@example.invalid',
  timestamp: '2026-10-15T00:00:00Z',
};
const metadata = (requestId: string): NotebookCommitMetadata => ({
  summary: 'Exact notebook fixture',
  changeRequest: { requestId, inputDigest: `sha256:${'a'.repeat(64)}` },
  producer: { actor: { kind: 'user', id: 'user_local' } },
  authority: { kind: 'instruction', reference: requestId },
  sourceReferences: [],
});
const validate = () => undefined;

describe('canonical fixed-base Git notebook', () => {
  it('keeps pinned A exact after publishing B and preserves source bytes across restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-canonical-'));
    const notebook = new KnowledgeNotebook(root);
    const initial = notebook.initialize(metadata('create'), attribution);
    const first = notebook.prepare(
      initial,
      [{ path: 'pages/notes.md', content: 'revision A 测试' }],
      metadata('A'),
      attribution,
      validate
    );
    let audits = 0;
    notebook.publish(initial, first, () => {
      audits += 1;
    });
    const pinned = notebook.pin();
    const second = notebook.prepare(
      first,
      [{ path: 'pages/notes.md', content: 'revision B 修复' }],
      metadata('B'),
      attribution,
      validate
    );
    expect(notebook.pin()).toBe(first);
    expect(notebook.read(pinned, 'pages/notes.md')).toBe('revision A 测试');
    notebook.publish(first, second, () => {
      audits += 1;
    });
    const reopened = new KnowledgeNotebook(root);
    expect(reopened.pin()).toBe(second);
    expect(reopened.read(pinned, 'pages/notes.md')).toBe('revision A 测试');
    expect(reopened.read(second, 'pages/notes.md')).toBe('revision B 修复');
    expect(reopened.commitMetadata(second).changeRequest.requestId).toBe('B');
    expect(audits).toBe(2);
    expect(() => reopened.initialize(metadata('recreate'), attribution)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('requires current-base and admission/Audit evidence before publication and retains unpublished candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-failure-'));
    const notebook = new KnowledgeNotebook(root);
    const initial = notebook.initialize(metadata('create'), attribution);
    const candidate = notebook.prepare(
      initial,
      [{ path: 'pages/notes.md', content: 'unpublished' }],
      metadata('edit'),
      attribution,
      validate
    );
    expect(() =>
      notebook.publish(initial, candidate, () => {
        throw new Error('Audit unavailable');
      })
    ).toThrow('Audit unavailable');
    expect(notebook.pin()).toBe(initial);
    expect(notebook.read(candidate, 'pages/notes.md')).toBe('unpublished');
    notebook.publish(initial, candidate, validate);
    const competitor = notebook.prepare(
      initial,
      [{ path: 'pages/other.md', content: 'other' }],
      metadata('competitor'),
      attribution,
      validate
    );
    expect(() => notebook.publish(initial, competitor, validate)).toThrowError(
      expect.objectContaining({ code: 'conflict' })
    );
    expect(notebook.pin()).toBe(candidate);
  });

  it('rejects unsafe paths, failed final-tree validation, oversized files and link mutation before publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-confinement-'));
    const notebook = new KnowledgeNotebook(root);
    const initial = notebook.initialize(metadata('create'), attribution);
    for (const path of ['../outside.md', 'pages/../outside.md', 'pages/Upper.md', 'config.json'])
      expect(() =>
        notebook.prepare(initial, [{ path, content: 'bad' }], metadata(path), attribution, validate)
      ).toThrowError(expect.objectContaining({ code: 'validation_failed' }));
    expect(() =>
      notebook.prepare(
        initial,
        [{ path: 'pages/big.md', content: 'x'.repeat(2 * 1024 * 1024 + 1) }],
        metadata('big'),
        attribution,
        validate
      )
    ).toThrowError(expect.objectContaining({ code: 'validation_failed' }));
    expect(() =>
      notebook.prepare(
        initial,
        [{ path: 'pages/bad.md', content: 'invalid page' }],
        metadata('invalid'),
        attribution,
        () => {
          throw new Error('final tree invalid');
        }
      )
    ).toThrow('final tree invalid');
    expect(notebook.pin()).toBe(initial);
    symlinkSync(tmpdir(), join(notebook.repository, 'outside'));
    expect(() =>
      notebook.prepare(initial, [], metadata('link'), attribution, validate)
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });
});
