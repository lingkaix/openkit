import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogInputError,
  catalogDocumentPath,
  importWorkspacePlugin,
  loadWorkspaceResourceCatalog,
} from './resource-catalog.js';
import { readWorkspaceSkillContent } from './skill-inspection.js';

const mutation = vi.hoisted(() => ({ path: null as string | null, replacement: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args);
      if (String(args[0]) === mutation.path) {
        mutation.path = null;
        actual.writeFileSync(args[0], mutation.replacement);
      }
      return result;
    }) as typeof actual.readFileSync,
  };
});

/** Real package bytes with a valid independently versioned Skill. */
function fixture(content: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-source-snapshot-'));
  const treeRoot = join(dataRoot, 'source');
  const skillPath = join(treeRoot, 'skills', 'alpha', 'SKILL.md');
  mkdirSync(join(treeRoot, 'skills', 'alpha'), { recursive: true });
  writeFileSync(
    join(treeRoot, 'plugin.json'),
    JSON.stringify({ name: 'source-pack', version: '1' })
  );
  writeFileSync(skillPath, content);
  return {
    dataRoot,
    skillPath,
    treeRoot,
    input: {
      createdAt: '2026-10-16T00:00:00.000Z',
      dataRoot,
      expectedRevision: 0,
      install: true,
      producer: { id: 'user_local', kind: 'user' as const },
      treeRoot,
      workspaceId: 'ws_demo',
    },
  };
}

describe('captured PluginVersion source', () => {
  it('uses captured package member bytes when the source changes immediately after collection', () => {
    const original =
      '---\nname: alpha\ndescription: Original captured instructions.\n---\n# Original';
    const changed = '---\nname: alpha\ndescription: Changed mutable source.\n---\n# Changed';
    const f = fixture(original);
    try {
      // The real filesystem read returns its captured bytes, then the source changes before parsing.
      mutation.path = f.skillPath;
      mutation.replacement = changed;
      const imported = importWorkspacePlugin(f.input);
      expect(mutation.path).toBeNull();
      expect(readFileSync(f.skillPath, 'utf8')).toBe(changed);
      const version = imported.catalog.skills.versions[0]!;
      expect(
        readWorkspaceSkillContent({
          dataRoot: f.dataRoot,
          workspaceId: 'ws_demo',
          entryId: version.entryId,
          digest: version.digest,
          path: 'SKILL.md',
        }).contentBase64
      ).toBe(Buffer.from(original).toString('base64'));
      expect(version.provenance.pluginVersionDigest).toBe(imported.version.digest);
      expect(imported.version.members[0]?.versionDigest).toBe(version.digest);
    } finally {
      mutation.path = null;
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed Skill members before publishing any canonical package bytes', () => {
    const f = fixture('# Missing required Skill metadata');
    try {
      expect(() => importWorkspacePlugin(f.input)).toThrow(CatalogInputError);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, 'ws_demo').revision).toBe(0);
      expect(existsSync(catalogDocumentPath(f.dataRoot, 'ws_demo'))).toBe(false);
      // The existing read path creates empty layout directories, which carry no catalog authority.
      for (const kind of ['plugin-snapshots', 'skill-snapshots']) {
        expect(readdirSync(join(f.dataRoot, 'workspaces', 'ws_demo', 'catalog', kind))).toEqual([]);
      }
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });
});
