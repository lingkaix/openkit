import { describe, expect, it } from 'vitest';
import {
  parseEcosystemSkillHeader,
  parseSkillImportSource,
  SkillSourceInputError,
} from './skill-source.js';

describe('ecosystem Skill source parsing', () => {
  it.each([
    [
      'owner/repo',
      {
        kind: 'git',
        url: 'https://github.com/owner/repo.git',
        ref: null,
        subpath: null,
        skillName: null,
      },
    ],
    [
      'github:owner/repo#release@release-helper',
      {
        kind: 'git',
        url: 'https://github.com/owner/repo.git',
        ref: 'release',
        subpath: null,
        skillName: 'release-helper',
      },
    ],
    ['owner/repo@Release Notes', { kind: 'git', skillName: 'Release Notes' }],
    ['owner/repo/skills/release', { kind: 'git', subpath: 'skills/release' }],
    ['https://github.com/owner/repo', { kind: 'git', url: 'https://github.com/owner/repo.git' }],
    [
      'https://github.com/owner/repo/tree/main/skills/release',
      {
        kind: 'git',
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
        subpath: 'skills/release',
      },
    ],
    ['https://github.com/owner/repo/tree/main', { kind: 'git', ref: 'main', subpath: null }],
    [
      'gitlab:group/subgroup/repo',
      { kind: 'git', url: 'https://gitlab.com/group/subgroup/repo.git' },
    ],
    [
      'https://gitlab.com/group/subgroup/repo/-/tree/main/skills/release',
      {
        kind: 'git',
        url: 'https://gitlab.com/group/subgroup/repo.git',
        ref: 'main',
        subpath: 'skills/release',
      },
    ],
    [
      'https://git.example.invalid/group/repo/-/tree/main/skill',
      { kind: 'git', url: 'https://git.example.invalid/group/repo.git', subpath: 'skill' },
    ],
    ['git@github.com:owner/repo.git', { kind: 'git', url: 'git@github.com:owner/repo.git' }],
    ['ssh://git@git.example.invalid:7999/group/repo.git#release', { kind: 'git', ref: 'release' }],
    [
      'https://git.example.invalid/group/repo.git',
      { kind: 'git', url: 'https://git.example.invalid/group/repo.git' },
    ],
    ['git://git.example.invalid/group/repo.git', { kind: 'git' }],
    [
      'git+https://git.example.invalid/group/repo.git',
      { kind: 'git', url: 'https://git.example.invalid/group/repo.git' },
    ],
    ['./my-skills', { kind: 'local', path: './my-skills' }],
    ['../my-skills', { kind: 'local', path: '../my-skills' }],
    ['/assigned/my-skills', { kind: 'local', path: '/assigned/my-skills' }],
    ['C:\\assigned\\my-skills', { kind: 'local', path: 'C:\\assigned\\my-skills' }],
    ['https://example.invalid/skill/SKILL.md', { kind: 'download' }],
    ['https://example.invalid/download/skill', { kind: 'download' }],
    [
      'https://example.invalid/skill.tgz?version=one',
      { kind: 'download', source: 'https://example.invalid/skill.tgz' },
    ],
    [
      'https://raw.githubusercontent.com/owner/repo/main/skills/release/SKILL.md',
      { kind: 'download' },
    ],
    ['https://github.com/owner/repo/archive/refs/heads/main.zip', { kind: 'download' }],
    ['https://gitlab.com/group/repo/-/archive/main/repo.tar.gz', { kind: 'download' }],
  ])('preserves acquisition intent for %s without acquiring it', (source, expected) => {
    expect(parseSkillImportSource(source)).toMatchObject(expected);
  });

  it.each([
    '',
    'owner',
    ' owner/repo',
    'owner/repo ',
    'file:///outside/skill',
    'ext::unsafe',
    'https://embedded@example.invalid/repo.git',
    'https://github.com/owner/repo/tree/main/../outside',
    'https://github.com/owner/repo/tree/main/%2e%2e/outside',
    'https://github.com/owner/repo/tree/main/%2foutside',
    'https://github.com/owner/repo/tree/main//outside',
    'owner/repo/../outside',
    'owner/repo#--upload-pack=unsafe',
    'owner/repo#%E0%A4%A',
    'owner/repo#main@../other',
    'owner/repo\nother',
  ])('refuses unsafe or invalid source intent %j with a content-free error', (source) => {
    expect(() => parseSkillImportSource(source)).toThrow(SkillSourceInputError);
    expect(() => parseSkillImportSource(source)).toThrow('Skill source or metadata is invalid.');
  });
});

describe('ecosystem Skill YAML header', () => {
  it.each([
    '\n',
    '\r\n',
  ])('accepts original BOM and %j bytes with descriptive extensions', (newline) => {
    const raw = `\ufeff---${newline}name: "Release Notes Helper"${newline}description: |${newline}  Prepare exact release notes.${newline}metadata:${newline}  internal: true${newline}  version: 2${newline}  tags: [one, two]${newline}allowed-tools: [untrusted]${newline}---${newline}# Exact body${newline}`;
    expect(parseEcosystemSkillHeader(raw)).toEqual({
      name: 'Release Notes Helper',
      description: 'Prepare exact release notes.\n',
      internal: true,
    });
    expect(raw.startsWith('\ufeff')).toBe(true);
  });

  it('does not interpret truthy descriptive metadata as internal selection or Tool authority', () => {
    expect(
      parseEcosystemSkillHeader(
        '---\nname: alpha\ndescription: Example.\nmetadata:\n  internal: "true"\nallowed-tools: "*"\n---\nBody.'
      )
    ).toEqual({ name: 'alpha', description: 'Example.', internal: false });
  });

  it.each([
    '# Missing header',
    '---js\nthrow new Error()\n---\nBody.',
    '---\n- alpha\n- beta\n---\nBody.',
    '---\nname: [bad\ndescription: Example.\n---\nBody.',
    '---\nname: alpha\nname: beta\ndescription: Example.\n---\nBody.',
    '---\nname: alpha\n---\nBody.',
    '---\nname: 4\ndescription: Example.\n---\nBody.',
    '---\nname: "  "\ndescription: Example.\n---\nBody.',
    '---\nname: alpha\ndescription: false\n---\nBody.',
  ])('refuses invalid required YAML data without evaluating it', (raw) => {
    expect(() => parseEcosystemSkillHeader(raw)).toThrow(SkillSourceInputError);
  });
});
