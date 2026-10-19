import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { KnowledgeMount } from '@openkit/config-schema';
import { responsibleUserIdForActor } from '@openkit/protocol';
import type { StorageAccess } from '@openkit/storage';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import { OperationError } from '../operation-error.js';
import {
  admitKnowledgeRetrieval,
  type KnowledgeRetrievalAccess,
} from '../retrieval-knowledge-adapter.js';
import { resolveScopedNotebookOwner, ScopedNotebookAccessError } from './scoped-notebook-owner.js';
import { type SourcePointerOwner, sourceNotebookRoot } from './source-pointers.js';

/** Trusted native assembly fixes the consumer and owner; model arguments cannot select this boundary. */
export interface ManagedSourceAdmission {
  readonly owner: SourcePointerOwner;
  readonly knowledgeBaseId: string;
  readonly mount: KnowledgeMount;
  readonly access: Omit<KnowledgeRetrievalAccess, 'store'> & {
    readonly store?: KnowledgeRetrievalAccess['store'];
  };
  readonly consumer: 'native' | 'worker';
  readonly mode: 'read-only' | 'staged-write';
  /** Only the existing native Notebook publisher supplies current write admission. */
  readonly revalidatePublication?: () => void;
}

/** Projects current exact-KB authority without minting, persisting or borrowing a lease. */
export function deriveManagedSourceAccess(input: ManagedSourceAdmission): StorageAccess | null {
  try {
    const { owner, access, mount } = input;
    if (
      input.consumer !== 'native' ||
      !access.coreDb ||
      !access.requestActor ||
      access.requestActor.userId !== responsibleUserIdForActor(access.actor) ||
      resolve(access.coreDb.dataRoot) !== resolve(owner.dataRoot) ||
      !mount.default ||
      mount.backend !== 'local' ||
      resolve(sourceNotebookRoot(owner), mount.root) !== resolve(sourceNotebookRoot(owner), 'raw')
    )
      return null;
    if (owner.ownerScope.kind === 'workspace') {
      if (
        !access.store?.getDataRoot() ||
        resolve(access.store.getDataRoot()!) !== resolve(owner.dataRoot)
      )
        return null;
      admitKnowledgeRetrieval({
        workspaceId: owner.ownerScope.workspaceId,
        access: { ...access, store: access.store! },
      });
    } else {
      const current = resolveScopedNotebookOwner({
        coreDb: access.coreDb,
        actor: access.requestActor,
        target: owner.ownerScope.kind === 'user' ? { kind: 'user' } : { kind: 'server' },
      });
      if (!isDeepStrictEqual(current.ownerScope, owner.ownerScope)) return null;
    }
    if (
      readDefaultKnowledgeBaseId({ dataRoot: owner.dataRoot, scope: owner.ownerScope }) !==
        input.knowledgeBaseId ||
      mount.knowledgeBaseId !== input.knowledgeBaseId ||
      !readKnowledgeMounts({ dataRoot: owner.dataRoot, scope: owner.ownerScope }).some((current) =>
        isDeepStrictEqual(current, mount)
      )
    )
      return null;
    if (input.mode === 'staged-write') {
      if (!input.revalidatePublication) return null;
      input.revalidatePublication();
    }
    return {
      basis: 'knowledge',
      ownerScope: owner.ownerScope,
      knowledgeBaseId: input.knowledgeBaseId,
      mount: mount.name,
      pathPrefix: 'sources',
      mode: input.mode,
    };
  } catch (error) {
    if (
      error instanceof ScopedNotebookAccessError ||
      (error instanceof OperationError && error.code === 'workspace_access_denied')
    )
      return null;
    throw error;
  }
}
