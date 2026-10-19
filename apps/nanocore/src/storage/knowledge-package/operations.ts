import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { formatReferenceUri, parseReferenceUri } from '@openkit/protocol';
import { applyEdits, modify } from 'jsonc-parser';
import MarkdownIt from 'markdown-it';
import { parseJsoncObject } from '../../config/jsonc.js';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../../config/knowledge-base.js';
import type { RuntimeConfigManager } from '../../config/runtime-config.js';
import { findWorkspaceConfig } from '../../config/runtime-config.js';
import {
  DEFAULT_NOTEBOOK_INDEX,
  KnowledgeNotebook,
  NotebookError,
} from '../../knowledge/notebook.js';
import { publishWorkspaceNotebook } from '../../knowledge/notebook-publication.js';
import { validateNotebookCandidate } from '../../knowledge/notebook-validation.js';
import {
  assertPortableWorkspaceNotebookDisclosure,
  importedWorkspaceNotebookReferences,
  remintPortableWorkspaceNotebookPages,
} from '../../knowledge/notebook-workspace-portability.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  updateOkfFrontmatter,
} from '../../knowledge/okf.js';
import { readSourcePointers } from '../../knowledge/source-pointers.js';
import { importWorkspaceSources } from '../../knowledge/source-workspace-portability.js';
import type { FsStore } from '../../lib/store.js';
import { OperationError } from '../../operation-error.js';
import {
  type KnowledgeRetrievalAccess,
  knowledgeSourceAudienceReadable,
} from '../../retrieval-knowledge-adapter.js';
import type { InflightIdempotentCommand } from '../../runtime/idempotent-command.js';
import type { FileStorageAdmission } from '../artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from '../canonical-write-capacity.js';
import type { WorkspaceDb } from '../db.js';
import {
  assertCanonicalDirectory,
  measureCanonicalFile,
  readCanonicalTextFile,
  writeFileAtomic,
} from '../workspace-file-records.js';
import { KNOWLEDGE_PACKAGE_LIMITS } from './archive.js';
import {
  type KnowledgePackageFile,
  verifyKnowledgePackageFormat,
  writeKnowledgePackageFormat,
} from './format.js';
import type { KnowledgePackageManifest } from './manifest.js';

/** SHA-256 names original UTF-8 bytes, not Git objects or current page labels. */
function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Captures exact current pages, schema, Source pointers and available managed originals under native admission. */
export async function exportKnowledgePackage(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly access: KnowledgeRetrievalAccess;
  readonly directory: string;
  readonly revalidate: () => void;
  readonly fileAdmission: FileStorageAdmission;
}): Promise<KnowledgePackageManifest> {
  input.revalidate();
  const ownerScope = { kind: 'workspace' as const, workspaceId: input.workspaceId };
  const owner = { dataRoot: input.dataRoot, ownerScope };
  const scope = { dataRoot: input.dataRoot, scope: ownerScope };
  const root = join(input.dataRoot, 'workspaces', input.workspaceId, 'knowledge');
  assertCanonicalDirectory(root);
  const knowledgeBaseId = readDefaultKnowledgeBaseId(scope);
  const mounts = readKnowledgeMounts(scope);
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const revision = notebook.publishedRevision();
  const pages = notebook.readRevision(revision).files;
  const schema = readCanonicalTextFile(join(root, 'schema', 'scope-schema.yaml'));
  const pointers = readSourcePointers(owner, revision);
  const check = () => {
    input.revalidate();
    if (
      notebook.publishedRevision() !== revision ||
      readCanonicalTextFile(join(root, 'schema', 'scope-schema.yaml')) !== schema ||
      !isDeepStrictEqual(readKnowledgeMounts(scope), mounts)
    )
      throw new NotebookError('conflict');
    assertPortableWorkspaceNotebookDisclosure({
      dataRoot: input.dataRoot,
      workspaceId: input.workspaceId,
      notebookRevision: revision,
      pages: new Map(
        Object.entries(pages).map(([path, content]) => [`knowledge/pages/${path}`, content])
      ),
      access: input.access,
    });
    for (const [id] of pointers)
      if (
        !knowledgeSourceAudienceReadable(
          { workspaceId: input.workspaceId, access: input.access },
          id
        )
      )
        throw new OperationError(
          'workspace_access_denied',
          'Knowledge package access denied.',
          403
        );
  };
  check();
  const metadataBytes =
    Buffer.byteLength(schema) +
    Object.values(pages).reduce((sum, content) => sum + Buffer.byteLength(content), 0) +
    [...pointers.values()].reduce((sum, pointer) => sum + Buffer.byteLength(pointer.content), 0);
  const rawBytes = [...pointers.values()]
    .filter(
      (pointer) =>
        pointer.fields.contentRef.availability === 'available' &&
        mounts.some(
          (mount) => mount.default && mount.name === pointer.fields.contentRef.locator.mount
        )
    )
    .reduce((sum, pointer) => sum + pointer.fields.byteLength, 0);
  const reservation = input.fileAdmission.reserve({
    stagingBytes: BigInt(metadataBytes * 2 + rawBytes) + 1_048_576n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 65_536n,
  });
  try {
    const metadataDirectory = `${input.directory}-metadata`;
    await mkdir(metadataDirectory, { mode: 0o700 });
    const files: KnowledgePackageFile[] = [];
    const capture = async (path: string, content: string) => {
      const sourcePath = join(metadataDirectory, path);
      await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 });
      await writeFile(sourcePath, content, { flag: 'wx', mode: 0o600 });
      files.push({
        path,
        sourcePath,
        contentDigest: digest(content),
        byteLength: Buffer.byteLength(content),
      });
    };
    for (const [path, content] of Object.entries(pages)) await capture(`pages/${path}`, content);
    await capture('schema/scope-schema.yaml', schema);
    for (const [id, pointer] of pointers) {
      await capture(`sources/${id}.md`, pointer.content);
      const ref = pointer.fields.contentRef;
      const mount = mounts.find((candidate) => candidate.name === ref.locator.mount);
      if (!mount) throw new NotebookError('recovery_required');
      if (!mount.default || ref.availability !== 'available') continue;
      if (
        mount.backend !== 'local' ||
        mount.root !== 'raw' ||
        !ref.locator.path.startsWith('sources/')
      )
        throw new NotebookError('recovery_required');
      let parent = join(root, 'raw');
      assertCanonicalDirectory(parent);
      for (const segment of ref.locator.path.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        assertCanonicalDirectory(parent);
      }
      files.push({
        path: `raw/${ref.locator.path}`,
        sourcePath: join(root, 'raw', ref.locator.path),
        contentDigest: ref.contentDigest,
        byteLength: pointer.fields.byteLength,
      });
    }
    const manifest = await writeKnowledgePackageFormat({
      directory: input.directory,
      limits: KNOWLEDGE_PACKAGE_LIMITS,
      files,
      metadata: {
        ownerScope,
        knowledgeBaseId,
        notebookRevision: revision,
        requiredFeatures: ['openkit.knowledge-git-notebook.v1', 'openkit.knowledge-owner-scope.v1'],
        mounts: mounts.map(({ knowledgeBaseId: _base, ...mount }) => ({
          ...mount,
          root: mount.default ? 'raw/' : mount.root,
        })),
      },
    });
    reservation.recordWritten(metadataBytes * 2 + rawBytes);
    check();
    return manifest;
  } finally {
    reservation.release();
  }
}

/** Requires a genuinely fresh seed, including retained history and Proposal state, before target preparation. */
function requireBootstrapOnly(input: {
  readonly notebook: KnowledgeNotebook;
  readonly root: string;
  readonly store: FsStore;
  readonly workspaceId: string;
}) {
  const graph = input.notebook.validateRetainedGraph();
  const seed = input.notebook.readRevision(graph.publishedRevision);
  if (
    graph.revisions.length !== 1 ||
    seed.parentRevision !== null ||
    seed.metadata.producer.kind !== 'system' ||
    seed.metadata.producer.id !== 'notebook-initializer' ||
    Object.keys(seed.files).length !== 1 ||
    seed.files['index.md'] !== DEFAULT_NOTEBOOK_INDEX ||
    Object.keys(input.notebook.readSourcePointers(seed.revision)).length ||
    input.store.listKnowledgeProposals(input.workspaceId).length ||
    readCanonicalTextFile(join(input.root, 'schema', 'scope-schema.yaml')) !==
      DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT ||
    (existsSync(join(input.root, 'raw')) && readdirSync(join(input.root, 'raw')).length)
  )
    throw new NotebookError('conflict', seed.revision);
  return seed;
}

/** Imports one integrity-verified package through the existing remint, validation, Git/Audit and command owners. */
export async function importKnowledgePackage(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly runtimeConfigManager: Pick<RuntimeConfigManager, 'current'>;
  readonly directory: string;
  readonly fileAdmission: FileStorageAdmission;
  readonly revalidate: () => void;
}) {
  const manifest = await verifyKnowledgePackageFormat({
    directory: input.directory,
    limits: KNOWLEDGE_PACKAGE_LIMITS,
  });
  if (manifest.ownerScope.kind !== 'workspace') throw new NotebookError('invalid_request');
  input.revalidate();
  const root = join(input.dataRoot, 'workspaces', input.workspaceId, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const seed = requireBootstrapOnly({ ...input, root, notebook });
  const scope = {
    dataRoot: input.dataRoot,
    scope: { kind: 'workspace' as const, workspaceId: input.workspaceId },
  };
  const knowledgeBaseId = readDefaultKnowledgeBaseId(scope);
  const targetMounts = readKnowledgeMounts(scope);
  if (targetMounts.length !== 1) throw new NotebookError('conflict');
  const textEntries = manifest.contentInventory.filter((entry) => !entry.path.startsWith('raw/'));
  if (
    textEntries.some((entry) => entry.byteLength > 2 * 1024 * 1024) ||
    textEntries.reduce((sum, entry) => sum + entry.byteLength, 0) > 32 * 1024 * 1024
  )
    throw new NotebookError('invalid_request');
  const schema = readCanonicalTextFile(join(input.directory, 'schema', 'scope-schema.yaml'));
  if (!parseScopeKnowledgeSchema(schema).ok) throw new NotebookError('invalid_request');
  const files = new Map<string, string>();
  const payloadFiles = new Map<string, string>();
  for (const entry of manifest.contentInventory) {
    const path = join(input.directory, entry.path);
    if (entry.path.startsWith('raw/'))
      payloadFiles.set(`workspace-files/knowledge/${entry.path}`, path);
    else if (entry.path.startsWith('pages/') || entry.path.startsWith('sources/')) {
      if (entry.byteLength > 2 * 1024 * 1024) throw new NotebookError('invalid_request');
      files.set(`workspace-files/knowledge/${entry.path}`, readCanonicalTextFile(path));
    } else if (entry.path !== 'schema/scope-schema.yaml')
      throw new NotebookError('invalid_request');
  }
  const transfer = importWorkspaceSources({
    files,
    payloadFiles,
    scopeSchemaText: schema,
    mounts: manifest.mounts.map((mount) => ({
      ...mount,
      root: mount.default ? 'raw' : mount.root,
      knowledgeBaseId: manifest.knowledgeBaseId,
    })),
    sourceWorkspaceId: manifest.ownerScope.workspaceId,
    targetWorkspaceId: input.workspaceId,
    sourceKnowledgeBaseId: manifest.knowledgeBaseId,
    targetKnowledgeBaseId: knowledgeBaseId,
    threadIds: new Map(),
    turnIds: new Map(),
    rewriteUri: (uri) => uri,
  });
  const sourcePins = new Map(
    transfer.originalSources.flatMap((source) => {
      const target = transfer.sourceIds.get(source.id)!;
      return [
        [`source:${source.id}`, `source:${target}`],
        [`source:${source.id}@${source.contentDigest}`, `source:${target}@${source.contentDigest}`],
      ];
    })
  );
  const rawPaths = new Map(
    [...transfer.references].map(([source, target]) => [
      parseReferenceUri(source)!.reference.objectId,
      parseReferenceUri(target)!.reference.objectId,
    ])
  );
  const replacements = new Map([...sourcePins, ...transfer.references]);
  const rewrite = (reference: string): string => {
    const exact = replacements.get(reference);
    if (exact) return exact;
    const parsed = parseReferenceUri(reference);
    if (
      parsed?.reference.scopeId ===
      `page/workspace/${manifest.ownerScope.kind === 'workspace' ? manifest.ownerScope.workspaceId : ''}/${manifest.knowledgeBaseId}`
    )
      return formatReferenceUri(
        {
          scopeId: `page/workspace/${input.workspaceId}/${knowledgeBaseId}`,
          objectId: parsed.reference.objectId,
        },
        parsed.contentDigest
      );
    if (
      parsed?.reference.scopeId ===
      `raw/workspace/${manifest.ownerScope.kind === 'workspace' ? manifest.ownerScope.workspaceId : ''}/${manifest.knowledgeBaseId}`
    ) {
      const path = rawPaths.get(parsed.reference.objectId);
      if (path)
        return formatReferenceUri(
          { scopeId: `raw/workspace/${input.workspaceId}/${knowledgeBaseId}`, objectId: path },
          parsed.contentDigest
        );
    }
    return reference;
  };
  const pages = new Map(
    [...files]
      .filter(([path]) => path.startsWith('workspace-files/knowledge/pages/'))
      .map(([path, content]) => [
        `knowledge/pages/${path.slice('workspace-files/knowledge/pages/'.length)}`,
        content,
      ])
  );
  const markdown = new MarkdownIt({ html: false });
  const reminted = remintPortableWorkspaceNotebookPages({
    pages,
    sourceWorkspaceId: manifest.ownerScope.workspaceId,
    targetWorkspaceId: input.workspaceId,
    sourceKnowledgeBaseId: manifest.knowledgeBaseId,
    targetKnowledgeBaseId: knowledgeBaseId,
    rewriteReferences: (refs) => refs.map(rewrite),
    rewritePage: (path, content, rewriteReference) => {
      const parsed = parseOkfDocument({ path, content });
      if (!parsed.ok) throw new NotebookError('invalid_request');
      let body = parsed.document.body;
      for (const block of markdown.parse(body, {}))
        for (const token of block.children ?? []) {
          const href = token.attrGet(token.type === 'image' ? 'src' : 'href');
          if (!href) continue;
          let target = rewriteReference(href);
          if (target === href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/')) {
            const resolved = posix.normalize(
              posix.join('pages', posix.dirname(path), decodeURI(href))
            );
            const replacement = resolved.startsWith('raw/')
              ? rawPaths.get(resolved.slice(4))
              : undefined;
            if (replacement)
              target = encodeURI(
                posix.relative(posix.join('pages', posix.dirname(path)), `raw/${replacement}`)
              );
          }
          if (target !== href) body = body.replaceAll(href, target);
        }
      // Keep exact authored bytes when no remint or attribution normalization is needed.
      const replaced = content.slice(0, content.length - parsed.document.body.length) + body;
      return parsed.document.reserved ||
        parsed.document.frontmatter.review_state === 'user-authored'
        ? replaced
        : updateOkfFrontmatter({
            path,
            content: replaced,
            updates: { review_state: 'user-authored' },
          });
    },
  });
  const finalFiles = Object.fromEntries(
    [...reminted.pages].map(([path, content]) => [path.slice('knowledge/pages/'.length), content])
  );
  const registeredSources = new Map(
    transfer.sources.map((source) => [source.id, source.contentDigest])
  );
  const facts = () => ({
    pageScopeId: `page/workspace/${input.workspaceId}/${knowledgeBaseId}`,
    scopeSchemaText: schema,
    reviewRequiredPageIds:
      findWorkspaceConfig(input.runtimeConfigManager.current(), input.workspaceId)?.config.workspace
        .knowledgeMaintenance?.reviewRequiredPageIds ?? [],
    registeredSources,
    resolvedReferences: importedWorkspaceNotebookReferences(
      finalFiles,
      `page/workspace/${input.workspaceId}/${knowledgeBaseId}`
    ),
  });
  if (
    validateNotebookCandidate({
      ...facts(),
      ownerScope: scope.scope,
      base: seed,
      candidate: { files: finalFiles },
    }).errors.length
  )
    throw new NotebookError('invalid_request');
  const publicationBytes = manifest.contentInventory.reduce(
    (sum, entry) => sum + entry.byteLength,
    0
  );
  const reservation = input.fileAdmission.reserve({
    stagingBytes: 0n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: BigInt(publicationBytes) + 1_048_576n,
  });
  const copied: string[] = [];
  const createdDirectories = new Set<string>();
  const schemaPath = join(root, 'schema', 'scope-schema.yaml');
  const oldSchema = readCanonicalTextFile(schemaPath);
  const configPath = join(
    input.dataRoot,
    'workspaces',
    input.workspaceId,
    'config',
    'workspace.jsonc'
  );
  const oldConfig = readCanonicalTextFile(configPath);
  const mounts = manifest.mounts.map((mount) => ({
    ...mount,
    root: mount.default ? 'raw' : mount.root,
    knowledgeBaseId,
  }));
  const config = applyEdits(
    oldConfig,
    modify(oldConfig, ['workspace', 'knowledgeMounts'], mounts, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
  );
  parseJsoncObject(config);
  try {
    input.revalidate();
    requireBootstrapOnly({ ...input, root, notebook });
    for (const [path, source] of transfer.payloadFiles) {
      const target = join(input.dataRoot, 'workspaces', input.workspaceId, path);
      let parent = dirname(target);
      while (!existsSync(parent)) {
        createdDirectories.add(parent);
        parent = dirname(parent);
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      copied.push(target);
      reservation.recordWritten(measureCanonicalFile(target).byteLength);
    }
    transfer.verifyCopies(join(input.dataRoot, 'workspaces', input.workspaceId));
    writeFileAtomic(schemaPath, schema);
    writeFileAtomic(configPath, config);
    const result = await publishWorkspaceNotebook(
      {
        store: input.store,
        workspaceDb: input.workspaceDb,
        notebook,
        producer: { kind: 'user', id: input.actorId },
        inflightCommands: input.inflightCommands,
        command: {
          name: 'knowledge.package.import',
          input: { workspaceId: input.workspaceId, requestId: input.requestId, manifest },
        },
        sourcePointers: transfer.pointers,
        revalidate: () => {
          input.revalidate();
          reservation.assertAvailable();
          return facts();
        },
      },
      {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        baseRevision: seed.revision,
        summary: 'Import Knowledge package',
        changes: Object.entries(finalFiles).map(([path, content]) => ({ path, content })),
      }
    );
    return {
      workspaceId: input.workspaceId,
      knowledgeBaseId,
      notebookRevision: result.notebookRevision,
    };
  } catch (error) {
    // Preserve a published or unknown outcome. Only a proved unchanged seed permits local staging compensation.
    if (notebook.publishedRevision() === seed.revision) {
      withCanonicalFileWriteAdmission(input.fileAdmission, () => {
        writeFileAtomic(schemaPath, oldSchema);
        writeFileAtomic(configPath, oldConfig);
      });
      for (const path of copied) rmSync(path, { force: true });
      for (const path of [...createdDirectories].sort((left, right) => right.length - left.length))
        rmdirSync(path);
    }
    throw error;
  } finally {
    reservation.release();
  }
}
