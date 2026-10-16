import type { SkillVersionRecord } from '@openkit/config-schema';
import { type CatalogTreeFile, validateCatalogTree } from './catalog-tree.js';
import { acquireDownloadedEcosystemSkill } from './skill-download-source.js';
import { acquireGitEcosystemSkill } from './skill-git-source.js';
import { parseSkillImportSource, SkillSourceInputError, validateSkillSourceSubpath } from './skill-source.js';

/** Complete staged bytes and descriptive provenance; no field grants current import authority. */
export interface AcquiredSkillSupply {
  readonly tree: readonly CatalogTreeFile[];
  readonly sourceLocator?: string;
  readonly sourceCommit?: string | null;
  readonly sourceSubpath?: string | null;
}

/** Acquires remote sources only; a local path must be staged by the caller before upload. */
export async function acquireRemoteEcosystemSkill(input: {
  readonly source: string;
  readonly sourceSubpath?: string | undefined;
  readonly sourceSkillName?: string | undefined;
}): Promise<AcquiredSkillSupply> {
  const parsed = parseSkillImportSource(input.source);
  if (parsed.kind === 'local') throw new SkillSourceInputError();
  const subpath = input.sourceSubpath === undefined ? undefined : validateSkillSourceSubpath(input.sourceSubpath);
  if (parsed.kind === 'git') {
    if (subpath !== undefined && parsed.subpath !== null && subpath !== parsed.subpath ||
        input.sourceSkillName !== undefined && parsed.skillName !== null && input.sourceSkillName !== parsed.skillName)
      throw new SkillSourceInputError();
    const acquired = await acquireGitEcosystemSkill({
      ...parsed,
      subpath: subpath ?? parsed.subpath,
      skillName: input.sourceSkillName ?? parsed.skillName,
    });
    return {
      tree: acquired.tree,
      sourceCommit: acquired.sourceCommit,
      sourceLocator: `${acquired.source}${parsed.ref === null ? '' : `#${encodeURIComponent(parsed.ref)}`}`,
      sourceSubpath: acquired.subpath || null,
    };
  }
  const acquired = await acquireDownloadedEcosystemSkill({
    ...parsed,
    ...(subpath === undefined ? {} : { subpath }),
    ...(input.sourceSkillName === undefined ? {} : { skillName: input.sourceSkillName }),
  });
  return {
    tree: acquired.tree,
    sourceCommit: null,
    sourceLocator: acquired.source,
    sourceSubpath: acquired.subpath || null,
  };
}

/** Observes the retained source without importing bytes, changing provenance or moving selection. */
export async function checkEcosystemSkillUpdate(version: SkillVersionRecord) {
  const original = { digest: version.digest, sourceCommit: version.provenance.sourceCommit };
  const unavailable = { ...original, status: 'unavailable' as const, observedDigest: null, observedCommit: null };
  if (!version.provenance.sourceLocator) return unavailable;
  try {
    const acquired = await acquireRemoteEcosystemSkill({
      source: version.provenance.sourceLocator,
      ...(version.provenance.sourceSubpath === null ? {} : { sourceSubpath: version.provenance.sourceSubpath }),
    });
    const observedDigest = validateCatalogTree(acquired.tree).digest;
    const observedCommit = acquired.sourceCommit ?? null;
    return {
      ...original,
      status: observedDigest === version.digest && observedCommit === version.provenance.sourceCommit
        ? 'unchanged' as const : 'changed' as const,
      observedDigest,
      observedCommit,
    };
  } catch {
    return unavailable;
  }
}
