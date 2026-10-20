import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeNotebookCommitMetadataSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { KnowledgeNotebook } from './notebook.js';

// Owner: knowledge_notebook_editing.md, Content, Revisions And History; marker-gaps-plan M1.
const roots: string[] = [];
const facts = {
  summary: 'Historical notebook',
  changeRequest: {
    requestId: 'historical-create',
    inputDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
  producer: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
  authority: { kind: 'direct' as const, instructionReference: 'item:historical-create' },
  sourceReferences: [],
};
const historicalMessage = `${JSON.stringify(facts)}\n`;

/** Git observes exact stored bytes independently of the Notebook metadata reader. */
function git(repositoryPath: string, args: string[], input?: string): string {
  return execFileSync('git', ['--git-dir', repositoryPath, ...args], {
    encoding: 'utf8',
    input,
    env: {
      PATH: process.env.PATH,
      LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Marker test',
      GIT_AUTHOR_EMAIL: 'openkit',
      GIT_COMMITTER_NAME: 'Marker test',
      GIT_COMMITTER_EMAIL: 'openkit',
    },
  });
}

/** Retain a test-authored message over a real initialized Notebook tree. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-commit-marker-'));
  roots.push(root);
  const repositoryPath = join(root, 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const base = notebook.initialize({ metadata: facts });
  const tree = git(repositoryPath, ['rev-parse', `${base}^{tree}`]).trim();
  return {
    repositoryPath,
    notebook,
    retain(message: string) {
      const revision = git(
        repositoryPath,
        ['commit-tree', tree, '-p', base, '-F', '-'],
        message
      ).trim();
      git(repositoryPath, ['update-ref', 'refs/heads/published', revision]);
      return revision;
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('M1 retained commit format markers', () => {
  it('historical absence means v1: cold inspection preserves metadata, page bytes, commit bytes and ref', () => {
    const f = fixture();
    const revision = f.retain(historicalMessage);
    const before = git(f.repositoryPath, ['cat-file', 'commit', revision]);
    expect(before.slice(before.indexOf('\n\n') + 2)).toBe(historicalMessage);
    const reopened = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
    expect(reopened.inspectRevision(revision).metadata).toEqual(facts);
    expect(reopened.readRevision(revision).files).toEqual({
      'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n',
    });
    expect(reopened.publishedRevision()).toBe(revision);
    expect(git(f.repositoryPath, ['cat-file', 'commit', revision])).toBe(before);
    expect(git(f.repositoryPath, ['rev-parse', 'refs/heads/published']).trim()).toBe(revision);
  });

  it('M1 protocol validation accepts historical absence and explicit v1 without changing the metadata projection', () => {
    expect(KnowledgeNotebookCommitMetadataSchema.safeParse(facts)).toMatchObject({
      success: true,
      data: facts,
    });
    expect(
      KnowledgeNotebookCommitMetadataSchema.safeParse({
        schemaVersion: 'openkit-knowledge-notebook-commit-v1',
        ...facts,
      })
    ).toMatchObject({ success: true, data: facts });
    expect(
      KnowledgeNotebookCommitMetadataSchema.parse({
        schemaVersion: 'openkit-knowledge-notebook-commit-v1',
        ...facts,
      })
    ).toEqual(facts);
  });

  it.each([
    ['wrong-version', 'openkit-knowledge-notebook-commit-v2'],
    ['null', null],
    ['wrong-type', 1],
  ])('M1 explicit %s fails metadata validation and cold inspectRevision without repair', (_label, schemaVersion) => {
    const message = `${JSON.stringify({ schemaVersion, ...facts })}\n`;
    expect(KnowledgeNotebookCommitMetadataSchema.safeParse(JSON.parse(message)).success).toBe(
      false
    );
    const f = fixture();
    const revision = f.retain(message);
    const before = git(f.repositoryPath, ['cat-file', 'commit', revision]);
    const reopened = new KnowledgeNotebook({ repositoryPath: f.repositoryPath });
    expect(() => reopened.inspectRevision(revision)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(git(f.repositoryPath, ['cat-file', 'commit', revision])).toBe(before);
    expect(git(f.repositoryPath, ['rev-parse', 'refs/heads/published']).trim()).toBe(revision);
  });

  it.each([
    'historical',
    'marked',
  ] as const)('Content, Revisions And History: %s canonical commit JSON and duplicate-key refusals still hold', (format) => {
    const f = fixture();
    // Use the real writer's field order for marked v1; no new order is prescribed by M1.
    const base = f.notebook.publishedRevision();
    const object = git(f.repositoryPath, ['cat-file', 'commit', base]);
    const message =
      format === 'historical' ? historicalMessage : object.slice(object.indexOf('\n\n') + 2);
    if (format === 'marked') {
      expect(JSON.parse(message).schemaVersion).toBe('openkit-knowledge-notebook-commit-v1');
    }
    const valid = f.retain(message);
    expect(f.notebook.inspectRevision(valid).metadata).toEqual(facts);
    const faults = [
      ['noncanonical whitespace', message.replace('{', '{ ')],
      [
        'noncanonical field order',
        `${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(message)).reverse()))}\n`,
      ],
      [
        'duplicate authority',
        message.replace(
          '"authority":',
          '"authority":{"kind":"direct","instructionReference":"item:forged"},"authority":'
        ),
      ],
      [
        'duplicate nested key',
        message.replace('"kind":"direct"', '"kind":"proposal","kind":"direct"'),
      ],
      ['trailing second object', `${message}{}`],
    ];
    if (format === 'marked') {
      faults.push(
        [
          'duplicate version',
          message.replace(
            '"schemaVersion":',
            '"schemaVersion":"openkit-knowledge-notebook-commit-v1","schemaVersion":'
          ),
        ],
        [
          'shadowed wrong version',
          message.replace(
            '"schemaVersion":',
            '"schemaVersion":"openkit-knowledge-notebook-commit-v2","schemaVersion":'
          ),
        ]
      );
    }
    for (const [label, invalid] of faults) {
      const revision = f.retain(invalid!);
      const before = git(f.repositoryPath, ['cat-file', 'commit', revision]);
      expect(() => f.notebook.inspectRevision(revision), label).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(git(f.repositoryPath, ['cat-file', 'commit', revision]), label).toBe(before);
      expect(git(f.repositoryPath, ['rev-parse', 'refs/heads/published']).trim(), label).toBe(
        revision
      );
    }
  });
});
