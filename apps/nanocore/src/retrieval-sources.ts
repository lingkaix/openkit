import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Actor } from './auth/identity.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isArtifactVisible, isThreadVisible } from './auth/thread-visibility.js';
import type { FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { ProductOperation } from './policy/workspace-access.js';
import {
  getRetrievalService,
  type RetrievalDocument,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievalScope,
} from './retrieval-service.js';
import { type CoreDb, openWorkspaceDb } from './storage/db.js';
import { getWorkspaceMaterialRevision, listWorkspaceMaterials } from './workspace-materials.js';

/** Trusted request facts; no model selects an actor, source root, or destination audience. */
export interface ProductRetrievalInput {
  store: FsStore;
  coreDb?: CoreDb | undefined;
  actor: Actor;
  workspaceId: string;
  /** A model result requires an exact currently readable destination Thread. */
  outputThreadId?: string | undefined;
  families: readonly ('conversation' | 'artifact' | 'material')[];
  /** The ordinary Assistant history binding forbids administrator source overrides. */
  administratorOverride?: false;
}
/** One source-owned storage home and current read-eligibility inventory. */
export interface ProductRetrievalScope {
  ownerRoot: string;
  view: RetrievalScope;
}
/** Exact identity supplied by an existing file owner; no body handle is accepted here. */
export interface AdmittedFileIdentity {
  key: RetrievalDocument['key'];
  revision: string;
  digest: string | null;
  size: number;
  name: string;
  mediaType: string;
  title?: string;
  metadata?: Record<string, string>;
  locator?: string;
}
/** Builds identity-only discovery without opening a body or inventing a missing digest. */
export function unreadableFileDocument(source: AdmittedFileIdentity): RetrievalDocument | null {
  if (source.digest === null) return null;
  const digest = canonicalDigest(source.digest);
  return {
    key: source.key,
    revision: source.revision,
    digest,
    size: source.size,
    name: source.name,
    media_type: source.mediaType,
    content: { kind: 'unreadable' },
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
    ...(source.locator === undefined ? {} : { locator: source.locator }),
  };
}
/** Enumerates current owners after policy and destination admission, before generation access. */
export function collectProductRetrievalScopes(
  input: ProductRetrievalInput
): ProductRetrievalScope[] {
  const { store, workspaceId, actor } = input;
  const dataRoot = store.getDataRoot();
  if (!dataRoot)
    throw new OperationError(
      'data_root_required',
      'Retrieval requires a file-backed data root.',
      409
    );
  requireRead(input, 'workspace.read');
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const administrator =
    input.administratorOverride === false
      ? false
      : input.coreDb
        ? isCurrentDeploymentAdministrator(input.coreDb, actor)
        : actor.kind === 'local';
  const destination = input.outputThreadId
    ? store.getThread(workspaceId, input.outputThreadId)
    : null;
  if (destination && !isThreadVisible(store, destination, actor.userId, administrator))
    throw new OperationError('workspace_access_denied', 'Retrieval audience is unavailable.', 403);
  const permittedThread = (threadId: string): boolean => {
    const thread = store.getThread(workspaceId, threadId);
    if (!isThreadVisible(store, thread, actor.userId, administrator)) return false;
    return (
      !destination ||
      thread.visibility === 'workspace' ||
      (destination.visibility === 'private' &&
        destination.privateOwnerUserId === thread.privateOwnerUserId)
    );
  };
  const scopes = new Map<string, ProductRetrievalScope>();
  const partition = (family: string, threadId: string | null) => {
    const thread = threadId ? store.getThread(workspaceId, threadId) : null;
    const ownerRoot =
      thread?.visibility === 'private' ? join(workspaceRoot, 'threads', thread.id) : workspaceRoot;
    const scope = JSON.stringify([family, workspaceId, threadId]);
    let entry = scopes.get(scope);
    if (!entry) {
      entry = { ownerRoot, view: { scope, documents: [] } };
      scopes.set(scope, entry);
    }
    return entry.view;
  };
  const add = (family: string, threadId: string | null, document: RetrievalDocument) => {
    partition(family, threadId).documents.push(document);
  };
  if (input.families.includes('conversation')) {
    requireRead(input, 'thread.read');
    for (const thread of store.listThreads(workspaceId)) {
      if (!permittedThread(thread.id)) continue;
      partition('conversation', thread.id);
      for (const item of store.listThreadItems(workspaceId, thread.id)) {
        // Only the canonical visible message families are admitted; diagnostic payloads stay out.
        if (
          (item.type !== 'user-message' && item.type !== 'assistant-message') ||
          !('text' in item)
        )
          continue;
        const text = item.text;
        add(
          'conversation',
          thread.id,
          directDocument(
            { namespace: 'conversation', id: item.id },
            hash(JSON.stringify(item)),
            text,
            thread.name ?? '',
            'text/plain',
            {
              workspaceId,
              threadId: thread.id,
              turnId: item.turnId,
              itemId: item.id,
            }
          )
        );
      }
    }
  }
  if (input.families.includes('artifact')) {
    requireRead(input, 'artifact.read');
    partition('artifact', null);
    for (const thread of store.listThreads(workspaceId)) {
      if (permittedThread(thread.id)) partition('artifact', thread.id);
    }
    for (const artifact of store.listArtifacts(workspaceId)) {
      if (
        !isArtifactVisible(store, artifact, actor.userId, administrator) ||
        (artifact.threadId && !permittedThread(artifact.threadId))
      )
        continue;
      if (artifact.content.format === 'file') {
        const document = unreadableFileDocument({
          key: { namespace: 'artifact', id: artifact.id },
          revision: hash(JSON.stringify(artifact)),
          digest: artifact.contentDigest,
          size: artifact.content.byteLength,
          name: artifact.title,
          title: artifact.title,
          mediaType: artifact.content.mediaType,
          metadata: {
            workspaceId,
            artifactId: artifact.id,
            version: String(artifact.version),
            ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
            ...(artifact.turnId ? { turnId: artifact.turnId } : {}),
          },
        });
        if (document) add('artifact', artifact.threadId, document);
        continue;
      }
      const text = artifact.content.body;
      if (hash(text) !== canonicalDigest(artifact.contentDigest))
        throw new OperationError(
          'recovery_required',
          'Artifact canonical content is inconsistent.',
          409
        );
      add(
        'artifact',
        artifact.threadId,
        directDocument(
          { namespace: 'artifact', id: artifact.id },
          hash(JSON.stringify(artifact)),
          text,
          artifact.title,
          { markdown: 'text/markdown', text: 'text/plain', json: 'application/json' }[
            artifact.content.format
          ],
          {
            workspaceId,
            artifactId: artifact.id,
            version: String(artifact.version),
            ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
            ...(artifact.turnId ? { turnId: artifact.turnId } : {}),
          }
        )
      );
    }
  }
  if (input.families.includes('material')) {
    requireRead(input, 'workspace.read');
    partition('material', null);
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      for (const material of listWorkspaceMaterials(db)) {
        if (input.outputThreadId && material.sensitivity === 'restricted') continue;
        if (!material.currentRevisionId) continue;
        const revision = getWorkspaceMaterialRevision(
          db,
          material.materialId,
          material.currentRevisionId
        );
        const document = directDocument(
          { namespace: 'material', id: material.materialId },
          hash(JSON.stringify([material, revision.revisionId])),
          revision.content,
          material.title,
          revision.mediaType,
          { workspaceId, materialId: material.materialId, revisionId: revision.revisionId }
        );
        if (document.digest !== canonicalDigest(revision.contentDigest))
          throw new OperationError(
            'recovery_required',
            'Material canonical content is inconsistent.',
            409
          );
        add('material', null, document);
      }
    } finally {
      db.sqlite.close();
    }
  }
  return [...scopes.values()].sort((a, b) =>
    Buffer.compare(Buffer.from(a.view.scope), Buffer.from(b.view.scope))
  );
}
/** Reconciles complete admitted inventories, searches the common kernel, and rechecks current truth. */
export async function searchProductSources(
  input: ProductRetrievalInput,
  query: Pick<RetrievalQuery, 'mode' | 'query' | 'limit'>
): Promise<RetrievalResult[]> {
  const dataRoot = input.store.getDataRoot();
  if (!dataRoot)
    throw new OperationError(
      'data_root_required',
      'Retrieval requires a file-backed data root.',
      409
    );
  // Use the kernel's sole query validator before reading any canonical source content.
  await getRetrievalService(dataRoot, join(dataRoot, 'server')).search({ ...query, scopes: [] });
  const admitted = collectProductRetrievalScopes(input);
  const groups = new Map<string, RetrievalScope[]>();
  for (const entry of admitted)
    groups.set(entry.ownerRoot, [...(groups.get(entry.ownerRoot) ?? []), entry.view]);
  const results: RetrievalResult[] = [];
  for (const [ownerRoot, scopes] of groups) {
    const service = getRetrievalService(dataRoot, ownerRoot);
    for (const view of scopes) {
      const expected = await service.inspect(view.scope);
      await service.publish(view, expected);
    }
    results.push(await service.search({ ...query, scopes }));
  }
  // Policy failure aborts the request; stale source bytes withhold their old hits.
  const currentScopes = collectProductRetrievalScopes(input);
  const currentViews = new Map(currentScopes.map(({ view }) => [view.scope, view]));
  if (admitted.some(({ view }) => !currentViews.has(view.scope)))
    throw new OperationError('workspace_access_denied', 'Retrieval source audience changed.', 403);
  const inventoryChanged =
    admitted.length !== currentScopes.length ||
    admitted.some(
      ({ view }) => JSON.stringify(view) !== JSON.stringify(currentViews.get(view.scope))
    );
  const current = new Map(
    currentScopes.flatMap(({ view }) =>
      view.documents.map(
        (document) => [JSON.stringify([view.scope, document.key]), document] as const
      )
    )
  );
  for (const result of results) {
    if (inventoryChanged) {
      result.complete = false;
      result.coverage.inventory_complete = false;
      result.coverage.enumeration_complete = false;
      result.coverage.reasons.stale = (result.coverage.reasons.stale ?? 0) + 1;
    }
    result.hits = result.hits.filter((hit) => {
      const document = current.get(JSON.stringify([hit.scope, hit.key]));
      if (document?.revision === hit.revision && document.digest === hit.digest) return true;
      result.complete = false;
      result.coverage.inventory_complete = false;
      result.coverage.enumeration_complete = false;
      result.coverage.stale_revisions += 1;
      result.coverage.reasons.stale = (result.coverage.reasons.stale ?? 0) + 1;
      return false;
    });
  }
  return results;
}
/** Creates a direct canonical text unit with exact owner coordinates and no sidecar. */
function directDocument(
  key: RetrievalDocument['key'],
  revision: string,
  text: string,
  title: string,
  mediaType: string,
  metadata: Record<string, string>
): RetrievalDocument {
  return {
    key,
    revision,
    digest: hash(text),
    size: Buffer.byteLength(text),
    name: key.id,
    title,
    media_type: mediaType,
    metadata,
    locator: JSON.stringify(metadata),
    content: { kind: 'inline-text', text },
  };
}
/** Uses current canonical membership, credential and Policy Kernel facts at each boundary. */
function requireRead(input: ProductRetrievalInput, policyOperation: ProductOperation): void {
  const allowed = input.coreDb
    ? isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
        mutating: false,
        policyOperation,
      })
    : input.actor.kind === 'local';
  if (!allowed)
    throw new OperationError('workspace_access_denied', 'Retrieval access denied.', 403);
}
/** Rejects missing or malformed owner digests before identity-only admission. */
function canonicalDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value))
    throw new OperationError('recovery_required', 'Canonical source digest is unavailable.', 409);
  return value.slice(7);
}
/** Hashes exact admitted UTF-8, never an unreadable source body. */
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
