import { describe, expect, it } from 'vitest';
import { discoverEcosystemSkills } from './skill-discovery.js';
import { SkillSourceInputError } from './skill-source.js';

/** Actual YAML bytes let discovery exercise the same parser as installed snapshot admission. */
function header(name: string, internal = false): Uint8Array {
  return Buffer.from(
    `---\nname: ${JSON.stringify(name)}\ndescription: Exercise discovery.\nmetadata:\n  internal: ${internal}\n---\nInstructions.\n`
  );
}

describe('ecosystem Skill discovery', () => {
  it('selects a root package without turning its nested supporting packages into sibling imports', () => {
    const headers = new Map([
      ['SKILL.md', header('root')],
      ['skills/nested/SKILL.md', header('nested')],
    ]);
    expect(
      discoverEcosystemSkills({ headers }).map(({ name, subpath }) => ({ name, subpath }))
    ).toEqual([{ name: 'root', subpath: '' }]);
  });

  it('uses ordinary containers and Agent paths while excluding internal and dependency/build content', () => {
    const headers = new Map([
      ['skills/category/ordinary/SKILL.md', header('ordinary')],
      ['skills/.curated/curated/SKILL.md', header('curated')],
      ['.agents/skills/common/SKILL.md', header('common')],
      ['.claude/skills/other/SKILL.md', header('other')],
      ['.codex/skills/internal/SKILL.md', header('hidden', true)],
      ['node_modules/package/SKILL.md', header('dependency')],
      ['build/example/SKILL.md', header('build')],
      ['unrelated/deep/example/SKILL.md', header('fallback-only')],
    ]);
    expect(
      discoverEcosystemSkills({ headers })
        .map(({ name }) => name)
        .sort()
    ).toEqual(['common', 'curated', 'ordinary', 'other']);
    expect(discoverEcosystemSkills({ headers, skillName: 'hidden' })).toMatchObject([
      { subpath: '.codex/skills/internal', internal: true },
    ]);
  });

  it('keeps duplicate names distinct and requires an exact unambiguous explicit selection', () => {
    const headers = new Map([
      ['skills/one/SKILL.md', header('duplicate')],
      ['skills/two/SKILL.md', header('duplicate')],
    ]);
    expect(discoverEcosystemSkills({ headers })).toHaveLength(2);
    expect(() => discoverEcosystemSkills({ headers, skillName: 'duplicate' })).toThrow(
      SkillSourceInputError
    );
    expect(
      discoverEcosystemSkills({ headers, subpath: 'skills/two', skillName: 'duplicate' })
    ).toMatchObject([{ subpath: 'skills/two' }]);
    expect(() =>
      discoverEcosystemSkills({ headers, subpath: 'skills/two', skillName: 'absent' })
    ).toThrow(SkillSourceInputError);
  });

  it('falls back to bounded nested discovery only when ordinary containers yield no valid Skill', () => {
    const headers = new Map([
      ['vendor/domain/package/SKILL.md', header('fallback')],
      ['a/b/c/d/e/f/SKILL.md', header('too-deep')],
      ['.git/objects/SKILL.md', header('administration')],
    ]);
    expect(discoverEcosystemSkills({ headers }).map(({ name }) => name)).toEqual(['fallback']);
  });

  it('refuses an unsafe staged path and does not substitute another package for invalid explicit content', () => {
    expect(() =>
      discoverEcosystemSkills({ headers: new Map([['../SKILL.md', header('escape')]]) })
    ).toThrow(SkillSourceInputError);
    const headers = new Map([
      ['skills/invalid/SKILL.md', Buffer.from('---js\nthrow new Error()\n---\nInvalid.')],
      ['skills/valid/SKILL.md', header('valid')],
    ]);
    expect(discoverEcosystemSkills({ headers, subpath: 'skills/invalid' })).toEqual([]);
  });
});
