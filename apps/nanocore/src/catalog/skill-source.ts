import { isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';

// Source and YAML conventions are adapted from vercel-labs/skills at 13e4063a1cf913f5606d57d42ab83a86f5001e04.
// The full MIT notice is in apps/nanocore/THIRD-PARTY-NOTICES.md. No upstream CLI or telemetry is imported.

/** Parsed acquisition intent; it contains no catalog, execution or filesystem authority. */
export type SkillImportSource =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'download'; readonly url: string; readonly source: string }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly source: string;
      readonly ref: string | null;
      readonly subpath: string | null;
      readonly skillName: string | null;
    };

/** Descriptive ecosystem header; no field grants an OpenKit capability. */
export interface EcosystemSkillHeader {
  readonly name: string;
  readonly description: string;
  readonly internal: boolean;
}

/** Bounded refusal that does not expose a source URL, local path or authored payload. */
export class SkillSourceInputError extends Error {
  /** Creates a safe refusal without retaining untrusted input in the error. */
  public constructor() {
    super('Skill source or metadata is invalid.');
    this.name = 'SkillSourceInputError';
  }
}

/** Decodes request syntax without exposing URI parser diagnostics. */
function decodedValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SkillSourceInputError();
  }
}

/** Source syntax cannot carry terminal or subprocess control bytes. */
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

/** Rejects unsafe selected paths instead of normalizing them into a different package. */
export function validateSkillSourceSubpath(path: string): string {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path !== path.normalize('NFC') ||
    path
      .split('/')
      .some(
        (segment) =>
          !segment || segment === '.' || segment === '..' || hasControlCharacters(segment)
      )
  )
    throw new SkillSourceInputError();
  return path;
}

/** Decodes one URL segment exactly once; escaped separators cannot become traversal. */
function decodedSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new SkillSourceInputError();
  }
  if (decoded.includes('/')) throw new SkillSourceInputError();
  return validateSkillSourceSubpath(decoded);
}

/** Git is invoked with fixed argument positions; refs still cannot be option-like or control-bearing. */
function sourceRef(ref: string | null): string | null {
  if (
    ref !== null &&
    (!ref ||
      ref.startsWith('-') ||
      hasControlCharacters(ref) ||
      Array.from(ref).some((character) => ' ~^:?*[\\'.includes(character)))
  )
    throw new SkillSourceInputError();
  return ref;
}

/** Parses ecosystem locators without network, filesystem reads, subprocesses or environment lookups. */
export function parseSkillImportSource(value: string): SkillImportSource {
  if (!value || value.length > 8_192 || value !== value.trim() || hasControlCharacters(value))
    throw new SkillSourceInputError();
  if (isAbsolute(value) || /^\.\.?($|[/\\])/u.test(value) || /^[a-z]:[/\\]/iu.test(value))
    return { kind: 'local', path: value };

  let input = value;
  if (input.startsWith('github:')) input = input.slice('github:'.length);
  else if (input.startsWith('gitlab:'))
    input = `https://gitlab.com/${input.slice('gitlab:'.length)}`;
  const fragmentIndex = input.indexOf('#');
  const fragment = fragmentIndex < 0 ? null : input.slice(fragmentIndex + 1);
  input = fragmentIndex < 0 ? input : input.slice(0, fragmentIndex);
  const filterIndex = fragment?.lastIndexOf('@') ?? -1;
  const ref = sourceRef(
    fragment === null
      ? null
      : decodedValue(filterIndex < 0 ? fragment : fragment.slice(0, filterIndex)) || null
  );
  let skillName = filterIndex < 0 ? null : decodedValue(fragment!.slice(filterIndex + 1));
  if (
    skillName !== null &&
    (!skillName.trim() || skillName.includes('/') || skillName.includes('\\'))
  )
    throw new SkillSourceInputError();

  if (!input.includes(':') && !input.startsWith('.')) {
    const match = /^([^/@]+)\/([^/@]+)(?:@([^/]+)|\/(.+))?\/?$/u.exec(input);
    if (!match) throw new SkillSourceInputError();
    const owner = decodedSegment(match[1]!);
    const repo = decodedSegment(match[2]!.replace(/\.git$/u, ''));
    skillName ??= match[3] ?? null;
    return {
      kind: 'git',
      url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`,
      source: `github:${owner}/${repo}`,
      ref,
      subpath: match[4] ? validateSkillSourceSubpath(match[4]) : null,
      skillName,
    };
  }
  if (/^[^/@:]+@[^/:]+:.+$/u.test(input)) {
    validateSkillSourceSubpath(input.slice(input.indexOf(':') + 1));
    return { kind: 'git', url: input, source: input, ref, subpath: null, skillName };
  }

  let url: URL;
  try {
    url = new URL(input.replace(/^git\+https:/u, 'https:'));
  } catch {
    throw new SkillSourceInputError();
  }
  if (
    !['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) ||
    url.password ||
    (url.username && url.protocol !== 'ssh:')
  )
    throw new SkillSourceInputError();
  // URL normalizes dot segments. Inspect the authored path first so normalization cannot hide them.
  const authoredPath = /^[a-z+]+:\/\/[^/?#]+(\/[^?#]*)?/iu.exec(input)?.[1] ?? '';
  const relativePath = authoredPath.replace(/^\/|\/$/gu, '');
  const segments = relativePath ? relativePath.split('/').map(decodedSegment) : [];
  const host = url.hostname.toLowerCase();
  const hostedDownload =
    ['raw.githubusercontent.com', 'codeload.github.com', 'objects.githubusercontent.com'].includes(
      host
    ) ||
    (host === 'github.com' && ['archive', 'raw', 'releases'].includes(segments[2] ?? '')) ||
    (segments.includes('-') &&
      ['archive', 'raw'].includes(segments[segments.indexOf('-') + 1] ?? ''));
  const gitlabTree = segments.findIndex(
    (segment, index) => segment === '-' && segments[index + 1] === 'tree'
  );
  const isGitHub = host === 'github.com' && !hostedDownload;
  const isGitLab =
    !hostedDownload &&
    (host === 'gitlab.com' || (gitlabTree >= 2 && segments[gitlabTree + 1] === 'tree'));
  if (isGitHub || isGitLab) {
    const marker = isGitHub ? (segments[2] === 'tree' ? 2 : -1) : gitlabTree;
    const repository = marker >= 0 ? segments.slice(0, marker) : segments;
    if (repository.length < 2 || (isGitHub && repository.length !== 2))
      throw new SkillSourceInputError();
    const treeRefIndex = marker < 0 ? -1 : marker + (isGitHub ? 1 : 2);
    const treeRef = treeRefIndex < 0 ? ref : sourceRef(segments[treeRefIndex] ?? null);
    if (marker >= 0 && treeRef === null) throw new SkillSourceInputError();
    const subpath = treeRefIndex < 0 ? null : segments.slice(treeRefIndex + 1).join('/') || null;
    const repositoryPath = repository.join('/').replace(/\.git$/u, '');
    const remote = `${url.protocol}//${url.host}/${repositoryPath}.git`;
    return { kind: 'git', url: remote, source: remote, ref: treeRef, subpath, skillName };
  }
  const source = new URL(url);
  source.search = '';
  source.hash = '';
  if (
    !hostedDownload &&
    (url.protocol === 'ssh:' || url.protocol === 'git:' || url.pathname.endsWith('.git'))
  )
    return { kind: 'git', url: url.href, source: source.href, ref, subpath: null, skillName };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SkillSourceInputError();
  return { kind: 'download', url: url.href, source: source.href };
}

/** Reads required descriptive strings from YAML only, preserving original payload bytes elsewhere. */
export function parseEcosystemSkillHeader(raw: string): EcosystemSkillHeader {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new SkillSourceInputError();
  const document = parseDocument(match[1]!);
  if (document.errors.length || document.warnings.length) throw new SkillSourceInputError();
  let header: unknown;
  try {
    header = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new SkillSourceInputError();
  }
  if (!header || typeof header !== 'object' || Array.isArray(header))
    throw new SkillSourceInputError();
  const { name, description, metadata } = header as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    typeof description !== 'string' ||
    !description.trim()
  )
    throw new SkillSourceInputError();
  const internal =
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).internal === true;
  return { name, description, internal };
}
