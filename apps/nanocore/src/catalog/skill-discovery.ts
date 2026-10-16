import {
  type EcosystemSkillHeader,
  parseEcosystemSkillHeader,
  SkillSourceInputError,
  validateSkillSourceSubpath,
} from './skill-source.js';

// Discovery conventions are adapted from vercel-labs/skills at 13e4063a1cf913f5606d57d42ab83a86f5001e04.
// See apps/nanocore/THIRD-PARTY-NOTICES.md for the full MIT notice.
const CONTAINERS = [
  'skills',
  'skills/.curated',
  'skills/.experimental',
  'skills/.system',
  '.agents/skills',
  '.claude/skills',
  '.cline/skills',
  '.codebuddy/skills',
  '.codex/skills',
  '.commandcode/skills',
  '.continue/skills',
  '.factory/skills',
  '.github/skills',
  '.goose/skills',
  '.grok/skills',
  '.iflow/skills',
  '.junie/skills',
  '.kilo/skills',
  '.kilocode/skills',
  '.kimchi/skills',
  '.kiro/skills',
  '.minimax/skills',
  '.mux/skills',
  '.neovate/skills',
  '.opencode/skills',
  '.openhands/skills',
  '.pi/skills',
  '.posit/assistant/skills',
  '.qoder/skills',
  '.roo/skills',
  '.trae/skills',
  '.windsurf/skills',
  '.zcode/skills',
  '.zencoder/skills',
] as const;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);

/** One discovered directory and its descriptive header, without catalog or execution authority. */
export interface DiscoveredEcosystemSkill extends EcosystemSkillHeader {
  readonly subpath: string;
}

/**
 * Finds ecosystem Skills in an acquisition owner's bounded regular-file header inventory.
 * This function neither reads a filesystem nor follows links; complete selected payloads still
 * enter the existing tree validator before import. Duplicate names remain distinct locations.
 */
export function discoverEcosystemSkills(input: {
  readonly headers: ReadonlyMap<string, Uint8Array>;
  readonly subpath?: string;
  readonly skillName?: string;
  /** One common archive directory, without rewriting paths or making selection explicit. */
  readonly archiveRoot?: string;
}): readonly DiscoveredEcosystemSkill[] {
  if (input.headers.size > 10_000) throw new SkillSourceInputError();
  const selected = input.subpath === undefined ? '' : validateSkillSourceSubpath(input.subpath);
  const prefix = selected ? `${selected}/` : '';
  const archiveRoot =
    input.archiveRoot === undefined ? '' : validateSkillSourceSubpath(input.archiveRoot);
  if (archiveRoot.includes('/')) throw new SkillSourceInputError();
  const containers = [
    ...CONTAINERS,
    ...(archiveRoot ? CONTAINERS.map((container) => `${archiveRoot}/${container}`) : []),
  ];
  const roots = new Map<string, Uint8Array>();
  let bytes = 0;
  for (const [path, content] of input.headers) {
    validateSkillSourceSubpath(path);
    bytes += content.byteLength;
    if (bytes > 25 * 1024 * 1024) throw new SkillSourceInputError();
    if (!path.startsWith(prefix) || path.split('/').some((part) => SKIP.has(part))) continue;
    const relative = path.slice(prefix.length);
    if (relative === 'SKILL.md') roots.set('', content);
    else if (relative.endsWith('/SKILL.md'))
      roots.set(relative.slice(0, -'/SKILL.md'.length), content);
  }
  const parse = (root: string, raw: Uint8Array): DiscoveredEcosystemSkill | null => {
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      const header = parseEcosystemSkillHeader(content);
      if (header.internal && input.skillName === undefined && input.subpath === undefined)
        return null;
      return { ...header, subpath: `${prefix}${root}`.replace(/\/$/u, '') };
    } catch (error) {
      if (error instanceof TypeError || error instanceof SkillSourceInputError) return null;
      throw error;
    }
  };
  const choose = (skills: readonly DiscoveredEcosystemSkill[]) => {
    if (input.skillName === undefined) return skills;
    const matches = skills.filter(
      (skill) => skill.name.toLowerCase() === input.skillName!.toLowerCase()
    );
    if (matches.length !== 1) throw new SkillSourceInputError();
    return matches;
  };
  if (roots.has('')) {
    const root = parse('', roots.get('')!);
    return choose(root ? [root] : []);
  }
  const candidates = [...roots].filter(([root]) => {
    const parts = root.split('/');
    return !parts.slice(1).some((_, index) => roots.has(parts.slice(0, index + 1).join('/')));
  });
  const preferred = candidates.filter(
    ([root]) =>
      root.split('/').length === 1 ||
      containers.some(
        (container) =>
          root.startsWith(`${container}/`) &&
          root.slice(container.length + 1).split('/').length <= 3
      )
  );
  const parsed = (entries: typeof candidates) =>
    entries.flatMap(([root, raw]) => {
      const skill = parse(root, raw);
      return skill ? [skill] : [];
    });
  const first = parsed(preferred);
  const skills = first.length
    ? first
    : parsed(
        candidates.filter(
          ([root]) =>
            root.split('/').length <= (archiveRoot && root.startsWith(`${archiveRoot}/`) ? 6 : 5)
        )
      );
  return choose(
    skills.sort((left, right) =>
      Buffer.compare(Buffer.from(left.subpath), Buffer.from(right.subpath))
    )
  );
}
