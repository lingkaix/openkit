import { constants, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { KnowledgeMountsSchema } from '@openkit/config-schema';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import type { z } from 'zod';
import { readKnowledgeMounts } from '../config/knowledge-base.js';
import { reserveCanonicalFileWrite } from '../storage/canonical-write-capacity.js';
import {
  assertCanonicalDirectory,
  measureCanonicalFile,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';
import { updateOkfFrontmatter } from './okf.js';
import {
  decodeSourcePointer,
  readSourcePointers,
  type SourceMetadataSchema,
  type SourcePointer,
} from './source-pointers.js';

const pointerPrefix = 'workspace-files/knowledge/sources/';
const rawPrefix = 'workspace-files/knowledge/raw/';

/** Checks a managed original before copying bytes through the existing canonical transfer boundary. */
function assertOriginal(path: string, pointer: SourcePointer): void {
  const measured = measureCanonicalFile(path);
  if (
    measured.byteLength !== pointer.fields.byteLength ||
    measured.contentDigest !== pointer.fields.contentRef.contentDigest
  )
    throw new Error('Source original integrity is inconsistent.');
}

/** A Source's native managed prefix never names a mount, parent or symbolic directory. */
function assertManagedPath(path: string): void {
  if (
    !path.startsWith('sources/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
  )
    throw new Error('Source original is outside the managed namespace.');
}

/** Exports the pinned canonical Source tree and verified managed originals; external mounts remain references. */
export function exportWorkspaceSources(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly revision: string;
  readonly exportRoot: string;
  readonly sources: readonly (z.infer<typeof SourceMetadataSchema> & { workspaceId: string })[];
}): void {
  const scope = { kind: 'workspace' as const, workspaceId: input.workspaceId };
  const owner = { dataRoot: resolve(input.workspaceRoot, '../..'), ownerScope: scope };
  const pointers = readSourcePointers(owner, input.revision);
  const expected = new Map(
    input.sources.map(({ workspaceId: _workspaceId, ...source }) => [source.id, source])
  );
  if (
    expected.size !== pointers.size ||
    [...pointers].some(([id, pointer]) => !isDeepStrictEqual(pointer.source, expected.get(id)))
  )
    throw new Error('Source export snapshot does not match the pinned Notebook.');
  if (!pointers.size) return;
  const mounts = readKnowledgeMounts({ dataRoot: owner.dataRoot, scope });
  for (const [id, pointer] of pointers) {
    const target = join(input.exportRoot, `${pointerPrefix}${id}.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileAtomic(target, pointer.content);
    const ref = pointer.fields.contentRef;
    const mount = mounts.find((entry) => entry.name === ref.locator.mount);
    if (!mount) throw new Error('Source mount declaration is unavailable.');
    if (!mount.default || ref.availability !== 'available') continue;
    if (mount.backend !== 'local' || mount.root !== 'raw')
      throw new Error('Managed Source export backend is unavailable.');
    assertManagedPath(ref.locator.path);
    let directory = join(input.workspaceRoot, 'knowledge', 'raw');
    assertCanonicalDirectory(directory);
    for (const segment of ref.locator.path.split('/').slice(0, -1)) {
      directory = join(directory, segment);
      assertCanonicalDirectory(directory);
    }
    const source = join(input.workspaceRoot, 'knowledge', 'raw', ref.locator.path);
    assertOriginal(source, pointer);
    const originalTarget = join(input.exportRoot, rawPrefix, ref.locator.path);
    mkdirSync(dirname(originalTarget), { recursive: true });
    const reservation = reserveCanonicalFileWrite(pointer.fields.byteLength);
    try {
      copyFileSync(source, originalTarget, constants.COPYFILE_EXCL);
      reservation?.recordWritten(pointer.fields.byteLength);
      assertOriginal(originalTarget, pointer);
    } finally {
      reservation?.release();
    }
  }
}

/** Remints verified Source pointers and file-backed originals before any target Workspace effects. */
export function importWorkspaceSources(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly payloadFiles: ReadonlyMap<string, string>;
  readonly scopeSchemaText: string;
  readonly mounts: unknown;
  readonly sourceWorkspaceId: string;
  readonly targetWorkspaceId: string;
  readonly sourceKnowledgeBaseId: string;
  readonly targetKnowledgeBaseId: string;
  readonly threadIds: ReadonlyMap<string, string>;
  readonly turnIds: ReadonlyMap<string, string>;
  readonly rewriteUri: (uri: string) => string;
}) {
  const sourceScope = { kind: 'workspace' as const, workspaceId: input.sourceWorkspaceId };
  const targetScope = { kind: 'workspace' as const, workspaceId: input.targetWorkspaceId };
  const mounts = KnowledgeMountsSchema.parse(input.mounts);
  if (mounts.some((mount) => mount.knowledgeBaseId !== input.sourceKnowledgeBaseId))
    throw new Error('Source mounts belong to a different Knowledge Base.');
  const originalSources = [];
  const sources = [];
  const sourceIds = new Map<string, string>();
  const pointers: Record<string, string> = Object.create(null);
  const payloadFiles = new Map<string, string>();
  const references = new Map<string, string>();
  const originals = new Map<string, SourcePointer>();
  const consumed = new Set<string>();
  const remintLineage = (ids: ReadonlyMap<string, string>, id: string | null) => {
    if (id === null) return null;
    const target = ids.get(id);
    if (!target) throw new Error('Source lineage is unavailable.');
    return target;
  };
  for (const [path, content] of input.files) {
    if (path === 'records/knowledge-sources.jsonl' || path.startsWith('sources/'))
      throw new Error('Source export uses a retired storage family.');
    if (!path.startsWith(pointerPrefix)) continue;
    const id = path.slice(pointerPrefix.length, -3);
    if (path !== `${pointerPrefix}${id}.md`) throw new Error('Source pointer path is invalid.');
    const pointer = decodeSourcePointer({
      ownerScope: sourceScope,
      knowledgeBaseId: input.sourceKnowledgeBaseId,
      scopeSchemaText: input.scopeSchemaText,
      id,
      content,
    });
    originalSources.push({ ...pointer.source, workspaceId: input.sourceWorkspaceId });
    const targetId = allocateEntityId('ks');
    sourceIds.set(id, targetId);
    const ref = pointer.fields.contentRef;
    const mount = mounts.find((entry) => entry.name === ref.locator.mount);
    if (!mount) throw new Error('Source mount declaration is unavailable.');
    const originalPath = ref.locator.path;
    const targetPath = mount.default
      ? originalPath
          .split('/')
          .map((segment) => (segment === id ? targetId : segment))
          .join('/')
      : originalPath;
    if (mount.default) {
      assertManagedPath(originalPath);
      if (
        mounts.some(
          (candidate) => !candidate.default && originalPath.startsWith(`${candidate.name}/`)
        )
      )
        throw new Error('Managed Source collides with an additional mount namespace.');
    }
    if (mount.default && ref.availability === 'available') {
      if (mount.backend !== 'local' || mount.root !== 'raw')
        throw new Error('Managed Source import backend is unavailable.');
      const exportedPath = `${rawPrefix}${originalPath}`;
      const original = input.payloadFiles.get(exportedPath);
      if (!original || consumed.has(exportedPath))
        throw new Error('Source original is unavailable or ambiguous.');
      assertOriginal(original, pointer);
      consumed.add(exportedPath);
      payloadFiles.set(`knowledge/raw/${targetPath}`, original);
      originals.set(`knowledge/raw/${targetPath}`, pointer);
    }
    const targetRef = {
      ...ref,
      knowledgeBaseId: input.targetKnowledgeBaseId,
      locator: { ...ref.locator, ownerScope: targetScope, path: targetPath },
    };
    const targetContent = updateOkfFrontmatter({
      path: `sources/${id}.md`,
      content,
      updates: {
        scope: targetScope,
        contentRef: targetRef,
        originatingThreadId: remintLineage(input.threadIds, pointer.source.originatingThreadId),
        originatingTurnId: remintLineage(input.turnIds, pointer.source.originatingTurnId),
        uri: pointer.source.uri === null ? null : input.rewriteUri(pointer.source.uri),
      },
    });
    const target = decodeSourcePointer({
      ownerScope: targetScope,
      knowledgeBaseId: input.targetKnowledgeBaseId,
      scopeSchemaText: input.scopeSchemaText,
      id: targetId,
      content: targetContent,
    });
    sources.push({ ...target.source, workspaceId: input.targetWorkspaceId });
    pointers[targetId] = targetContent;
    references.set(
      formatReferenceUri(
        {
          scopeId: `raw/workspace/${input.sourceWorkspaceId}/${input.sourceKnowledgeBaseId}`,
          objectId: originalPath,
        },
        ref.contentDigest
      ),
      formatReferenceUri(
        {
          scopeId: `raw/workspace/${input.targetWorkspaceId}/${input.targetKnowledgeBaseId}`,
          objectId: targetPath,
        },
        ref.contentDigest
      )
    );
  }
  for (const path of input.payloadFiles.keys()) {
    if (path.startsWith(rawPrefix) && !consumed.has(path))
      throw new Error('Source original has no owning pointer.');
  }
  return {
    originalSources,
    sources,
    sourceIds,
    pointers,
    payloadFiles,
    references,
    // Staging must verify the copied bytes before the existing canonical directory publication.
    verifyCopies: (workspaceRoot: string) => {
      for (const [path, pointer] of originals) assertOriginal(join(workspaceRoot, path), pointer);
    },
  };
}
