import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importWorkspaceSkill, loadWorkspaceResourceCatalog } from './resource-catalog.js';

it('retains first source identity with exact bytes and does not invent Git lineage for uploads', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-provenance-'));
  try {
    const base = {
      dataRoot,
      workspaceId: 'ws_demo',
      id: 'ecosystem-example',
      displayName: 'Ecosystem Example',
      activate: false,
      producer: { kind: 'user' as const, id: 'user_local' },
      createdAt: '2026-10-16T00:00:00Z',
      tree: [
        {
          kind: 'file' as const,
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            '---\nname: Example\ndescription: Retain supplied provenance.\n---\nOriginal bytes\n'
          ).toString('base64'),
        },
      ],
    };
    const source = {
      sourceLocator: 'https://github.com/example/skills.git',
      sourceCommit: 'a'.repeat(40),
      sourceSubpath: 'skills/example',
    };
    const first = importWorkspaceSkill({ ...base, ...source, expectedRevision: 0 });
    expect(first.version.provenance).toMatchObject(source);
    const repeated = importWorkspaceSkill({
      ...base,
      ...source,
      sourceCommit: 'b'.repeat(40),
      expectedRevision: 1,
    });
    expect(repeated.version.provenance).toEqual(first.version.provenance);
    const upload = importWorkspaceSkill({
      ...base,
      id: 'uploaded-example',
      uploadedSourceId: 'request-upload-example',
      expectedRevision: 2,
    });
    expect(upload.version.provenance.sourceCommit).toBeNull();
    expect(upload.version.provenance.uploadedSourceId).toBe('request-upload-example');
    expect(
      loadWorkspaceResourceCatalog(dataRoot, base.workspaceId).skills.versions[0]?.provenance
    ).toEqual(first.version.provenance);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
