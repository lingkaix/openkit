import type { SkillVersionRecord } from '@openkit/config-schema';
import {
  CatalogInputError,
  CatalogNotFoundError,
  loadWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
} from './resource-catalog.js';

/** Exact retained Skill identity within one Workspace catalog. */
export interface WorkspaceSkillVersionInput {
  readonly dataRoot: string;
  readonly digest: string;
  readonly entryId: string;
  readonly workspaceId: string;
}

/** Returns immutable metadata, including unavailable and removed historical versions. */
export function readWorkspaceSkillVersion(input: WorkspaceSkillVersionInput): SkillVersionRecord {
  const catalog = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const version = catalog.skills.versions.find(
    (item) => item.entryId === input.entryId && item.digest === input.digest
  );
  if (!version)
    throw new CatalogNotFoundError(`Skill version not found: ${input.entryId}/${input.digest}`);
  return version;
}

/** Reads one exact regular file after whole-version integrity verification. */
export function readWorkspaceSkillContent(
  input: WorkspaceSkillVersionInput & { readonly path: string }
) {
  const snapshot = readWorkspaceSkillSnapshot(input);
  const entry = snapshot.entries.find((item) => item.path === input.path);
  if (!entry) throw new CatalogNotFoundError(`Skill file not found: ${input.path}`);
  if (entry.kind === 0) throw new CatalogInputError('Skill content reads require a regular file.');
  return {
    contentBase64: (entry.content ?? Buffer.alloc(0)).toString('base64'),
    digest: input.digest,
    entryId: input.entryId,
    path: entry.path,
  };
}

/** Compares verified inventories; binary bytes are identified by size and digest. */
export function diffWorkspaceSkillVersions(
  input: Omit<WorkspaceSkillVersionInput, 'digest'> & {
    readonly baseDigest: string;
    readonly candidateDigest: string;
  }
) {
  const base = readWorkspaceSkillSnapshot({ ...input, digest: input.baseDigest }).version;
  const candidate = readWorkspaceSkillSnapshot({ ...input, digest: input.candidateDigest }).version;
  const before = new Map(base.inventory.map((row) => [row.path, row]));
  const after = new Map(candidate.inventory.map((row) => [row.path, row]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  const changes = paths.flatMap((path) => {
    const prior = before.get(path) ?? null;
    const next = after.get(path) ?? null;
    if (
      prior &&
      next &&
      prior.kind === next.kind &&
      prior.executable === next.executable &&
      prior.sha256 === next.sha256 &&
      prior.size === next.size
    )
      return [];
    return [{ after: next, before: prior, path }];
  });
  return {
    baseDigest: base.digest,
    candidateDigest: candidate.digest,
    changes,
    entryId: input.entryId,
  };
}
