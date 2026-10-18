import type { ContentReference } from '@openkit/protocol';

/** Captured logical location, without a backend root or access authority. */
export type StorageLocator = ContentReference['locator'];

/** Current Policy decision supplied by the trusted caller, never a new retained grant. */
export interface StorageAccess {
  grantId: string;
  knowledgeBaseId: string;
  ownerScope: StorageLocator['ownerScope'];
  mount: string;
  pathPrefix: string;
  mode: 'read-only' | 'staged-write';
  expiresAt: string;
  revoked: boolean;
}

/** Observed byte facts; the existing Source or Artifact record owns their retention. */
export interface StorageContent {
  reference: ContentReference;
  byteLength: number;
  mediaType: string;
}

/** Explicit failures do not disclose a backend path or substitute different content. */
export type StorageFailure =
  | { status: 'denied' }
  | { status: 'invalid-request' }
  | { status: 'resource-limited' }
  | { status: 'rescan-required' }
  | { status: 'failed' }
  | {
      status: 'unavailable';
      reason: 'missing' | 'changed' | 'inaccessible' | 'unsupported';
      reference?: ContentReference;
    };

/** One serializable response; each byte response is bounded independently. */
export type StorageResult<T> = { status: 'ok'; value: T } | StorageFailure;

/** An admitted mount binding; credentials and Policy decisions are not mount configuration. */
export interface LocalStorageMount {
  knowledgeBaseId: string;
  ownerScope: StorageLocator['ownerScope'];
  name: string;
  root: string;
}

/** One bounded raw-byte chunk, encoded for a process-independent transport. */
export interface StorageChunk {
  data: string;
  offset: number;
  nextOffset: number | null;
}

/** Bounded filesystem metadata, without content indexing or media processing. */
export interface StorageEntry {
  path: string;
  kind: 'file' | 'directory';
  byteLength: number;
}

/** Continuation is a current directory scan, not a retained history or change journal. */
export interface StorageScan {
  entries: StorageEntry[];
  cursor: string | null;
}

/** Temporary staged bytes for an owning publisher to consume; this grants no publication. */
export interface StorageStage {
  handle: string;
  content: StorageContent;
}

/** Control and byte requests contain JSON values only; native resources stay in the backend. */
export interface StorageService {
  stat(request: {
    access: StorageAccess;
    locator: StorageLocator;
  }): Promise<StorageResult<StorageContent>>;
  scan(request: {
    access: StorageAccess;
    directory: StorageLocator;
    limit: number;
    cursor?: string;
    nameIncludes?: string;
  }): Promise<StorageResult<StorageScan>>;
  read(request: {
    access: StorageAccess;
    content: StorageContent;
    offset: number;
    length: number;
  }): Promise<StorageResult<StorageChunk>>;
  beginStage(request: {
    access: StorageAccess;
    locator: StorageLocator;
    maxByteLength: number;
  }): Promise<StorageResult<{ handle: string }>>;
  writeStage(request: {
    access: StorageAccess;
    handle: string;
    data: string;
  }): Promise<StorageResult<{ byteLength: number }>>;
  finishStage(request: {
    access: StorageAccess;
    handle: string;
  }): Promise<StorageResult<StorageStage>>;
  readStage(request: {
    access: StorageAccess;
    handle: string;
    offset: number;
    length: number;
  }): Promise<StorageResult<StorageChunk>>;
  discardStage(request: {
    access: StorageAccess;
    handle: string;
  }): Promise<StorageResult<null>>;
}

/** Per-operation bounds; large files cross the boundary as repeated bounded chunks. */
export const STORAGE_LIMITS = {
  contentBytes: 1_000_000_000,
  chunkBytes: 1_048_576,
  scanEntries: 256,
  openStages: 16,
} as const;
