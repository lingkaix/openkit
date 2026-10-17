// openkit-test-platform: posix
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCatalogTree } from './resource-catalog.js';
import { acquireLocalEcosystemSkill } from './skill-local-source.js';
import { SkillSourceInputError } from './skill-source.js';

const roots: string[] = [];
const header = Buffer.from(
  '---\nname: Local Example\ndescription: Exact local bytes.\n---\nBody.\n'
);

/** Each acquisition test owns its local source and removes every retained fixture. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-local-skill-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('authorized local Skill acquisition', () => {
  it('stages exact complete bytes, empty directories and executability before catalog admission', () => {
    const root = fixture();
    writeFileSync(join(root, 'SKILL.md'), header);
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'not Skill supply');
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nprintf example\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    const acquired = acquireLocalEcosystemSkill({ path: root });
    expect(acquired.tree).toContainEqual({ kind: 'directory', path: 'empty' });
    expect(acquired.tree.find((entry) => entry.path === 'run.sh')?.executable).toBe(true);
    expect(acquired.tree.find((entry) => entry.path === 'SKILL.md')?.contentBase64).toBe(
      header.toString('base64')
    );
    expect(acquired.tree.some((entry) => entry.path.startsWith('.git'))).toBe(false);
    writeFileSync(join(root, 'run.sh'), 'source changed after staging');
    expect(validateCatalogTree(acquired.tree).digest).toBe(acquired.digest);
  });

  it('keeps ambiguous repositories unselected and resolves an exact directory without rewriting payloads', () => {
    const root = fixture();
    for (const name of ['one', 'two']) {
      mkdirSync(join(root, 'skills', name), { recursive: true });
      writeFileSync(join(root, 'skills', name, 'SKILL.md'), header);
    }
    expect(() => acquireLocalEcosystemSkill({ path: root })).toThrow(SkillSourceInputError);
    expect(acquireLocalEcosystemSkill({ path: root, subpath: 'skills/two' })).toMatchObject({
      name: 'Local Example',
      subpath: 'skills/two',
    });
  });

  it('refuses selected links instead of importing bytes outside the Skill root', () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(join(root, 'SKILL.md'), header);
    writeFileSync(join(outside, 'private.txt'), 'outside Skill content');
    symlinkSync(join(outside, 'private.txt'), join(root, 'reference.txt'));
    expect(() => acquireLocalEcosystemSkill({ path: root })).toThrow(SkillSourceInputError);
    symlinkSync(root, join(outside, 'linked-skill'));
    expect(() => acquireLocalEcosystemSkill({ path: outside, subpath: 'linked-skill' })).toThrow(
      SkillSourceInputError
    );
  });
});
