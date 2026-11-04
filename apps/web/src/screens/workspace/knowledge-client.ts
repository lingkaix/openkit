import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import type { KnowledgeClient, KnowledgeNode } from '@openkit/knowledge-ui';
import { useMemo } from 'react';
import { useCoreClient } from '../../app/core-client';
import { type KnowledgeNotebookPage, useKnowledge } from './data';
import {
  composeUserAuthoredKnowledgePage,
  patchKnowledgePageTitleBody,
  readKnowledgePageDisplay,
} from './knowledge-okf';

const TEXT_PREVIEW = 240;

/** Frontmatter timestamp already stored on the page. Missing means no time, not a guessed one. */
function updatedAtOf(content: string): string | null {
  const match = /^updated_at:\s*(\S+)\s*$/m.exec(content);
  return match?.[1] ?? null;
}

function nodeFromPage(page: KnowledgeNotebookPage): KnowledgeNode {
  const display = readKnowledgePageDisplay(page.path, page.content);
  return {
    id: page.id,
    parentId: null,
    title: display.title,
    kind: 'page',
    mediaType: 'text/markdown',
    updatedAt: updatedAtOf(page.content),
  };
}

function isTextFile(file: Blob, name: string): boolean {
  return (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/markdown' ||
    name.endsWith('.md') ||
    name.endsWith('.txt')
  );
}

function fileName(file: Blob): string {
  return file instanceof File && file.name.trim() ? file.name.trim() : 'Imported file';
}

/**
 * OpenKit adapter over the notebook the screen already loaded.
 * `list` serves that snapshot. A second `knowledge.notebook.list` would change call counts the
 * existing Knowledge tests pin. Search, save, and import call the live operations.
 * `nextCursor` is null: notebook list and retrieval have no page cursor.
 */
export function useOpenKitKnowledgeClient(workspaceId: string | null): KnowledgeClient {
  const core = useCoreClient();
  const knowledge = useKnowledge(workspaceId);
  const pages = knowledge.data?.pages;
  const revision = knowledge.data?.notebookRevision ?? null;

  return useMemo(
    () =>
      createOpenKitKnowledgeClient({
        core,
        workspaceId,
        pages: pages ?? [],
        revision,
      }),
    [core, workspaceId, pages, revision]
  );
}

export function createOpenKitKnowledgeClient(input: {
  core: CoreClient;
  workspaceId: string | null;
  pages: readonly KnowledgeNotebookPage[];
  revision: string | null;
}): KnowledgeClient {
  const { core, workspaceId, pages, revision } = input;

  return {
    async list(parentId, cursor) {
      if (parentId !== null || cursor) return { nodes: [], nextCursor: null };
      return { nodes: pages.map(nodeFromPage), nextCursor: null };
    },

    async read(id) {
      const page = pages.find((candidate) => candidate.id === id);
      if (!page || !revision) throw new Error('That page is not loaded.');
      const display = readKnowledgePageDisplay(page.path, page.content);
      return {
        node: nodeFromPage(page),
        body: display.body,
        version: revision,
      };
    },

    async search(query) {
      if (!workspaceId) return { nodes: [], nextCursor: null };
      const result = await core.operations['knowledge.retrieval']({ workspaceId, query });
      const nodes = result.selected.map((candidate) => {
        const page = pages.find(
          (item) =>
            item.id === candidate.reference.objectId ||
            item.path.replace(/\.md$/, '') === candidate.reference.objectId
        );
        const node = page
          ? nodeFromPage(page)
          : {
              id: candidate.reference.objectId,
              parentId: null,
              title: 'Untitled page',
              kind: 'page' as const,
              mediaType: 'text/markdown',
              updatedAt: null,
            };
        const snippet = page
          ? readKnowledgePageDisplay(page.path, page.content).body.slice(0, TEXT_PREVIEW)
          : '';
        return { node, snippet };
      });
      return { nodes, nextCursor: null };
    },

    async saveText(id, body, expectedVersion) {
      const page = pages.find((candidate) => candidate.id === id);
      if (!page || !workspaceId) throw new Error('That page is not loaded.');
      const content = patchKnowledgePageTitleBody({
        path: page.path,
        content: page.content,
        body,
      });
      try {
        const published = await core.operations['knowledge.notebook.update']({
          workspaceId,
          requestId: createRequestId(),
          baseRevision: expectedVersion,
          summary: `Edit ${page.path}`,
          changes: [{ path: page.path, content }],
        });
        return { version: published.notebookRevision };
      } catch (error) {
        if (
          error instanceof ApiCallError &&
          (error.code === 'conflict' || error.code === 'stale') &&
          workspaceId
        ) {
          const fresh = await core.operations['knowledge.notebook.list']({ workspaceId });
          throw { kind: 'version-conflict' as const, currentVersion: fresh.notebookRevision };
        }
        throw error;
      }
    },

    async importFile(_parentId, file) {
      const name = fileName(file);
      if (!isTextFile(file, name)) {
        throw new Error('OpenKit has no binary knowledge file store.');
      }
      if (!workspaceId || !revision) throw new Error('That folder is not ready.');
      const requestId = createRequestId();
      const path = `notes/${requestId}.md`;
      const title = name.replace(/\.(md|txt)$/i, '');
      const content = composeUserAuthoredKnowledgePage({
        workspaceId,
        path,
        title,
        body: await file.text(),
      });
      await core.operations['knowledge.notebook.create']({
        workspaceId,
        requestId,
        baseRevision: revision,
        path,
        content,
        summary: `Create ${path}`,
      });
      return {
        id: requestId,
        parentId: null,
        title,
        kind: 'page' as const,
        mediaType: file.type || 'text/markdown',
        updatedAt: null,
      };
    },
  };
}
