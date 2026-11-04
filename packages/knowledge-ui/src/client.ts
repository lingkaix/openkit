/** Folder, notebook page, or imported file. Mounts in omni are folders. */
export type KnowledgeNodeKind = 'folder' | 'page' | 'file';

/** One browsable node. `parentId` is null at the root of a library. */
export interface KnowledgeNode {
  id: string;
  parentId: string | null;
  title: string;
  kind: KnowledgeNodeKind;
  mediaType: string;
  updatedAt: string | null;
}

/** One list page. `nextCursor` is null when the host has no further page. */
export interface KnowledgeListPage {
  nodes: KnowledgeNode[];
  nextCursor: string | null;
}

/** One search page. Each node keeps the snippet the client returned. */
export interface KnowledgeSearchPage {
  nodes: Array<{ node: KnowledgeNode; snippet: string }>;
  nextCursor: string | null;
}

/** A read. Binary previews use `contentUrl` and leave `body` null. */
export interface KnowledgeRead {
  node: KnowledgeNode;
  body: string | null;
  version: string;
  contentUrl?: string;
}

/** Thrown by `saveText` when `expectedVersion` is no longer current. */
export interface KnowledgeVersionConflict {
  kind: 'version-conflict';
  currentVersion: string;
}

/** Host adapter. OpenKit and omni each implement this and nothing else. */
export interface KnowledgeClient {
  list(parentId: string | null, cursor?: string): Promise<KnowledgeListPage>;
  read(id: string): Promise<KnowledgeRead>;
  search(query: string, cursor?: string): Promise<KnowledgeSearchPage>;
  saveText(id: string, body: string, expectedVersion: string): Promise<{ version: string }>;
  importFile(parentId: string | null, file: Blob): Promise<KnowledgeNode>;
}

/** True when `saveText` rejected because the page version moved. */
export function isKnowledgeVersionConflict(error: unknown): error is KnowledgeVersionConflict {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { kind?: unknown; currentVersion?: unknown };
  return record.kind === 'version-conflict' && typeof record.currentVersion === 'string';
}
