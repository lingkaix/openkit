import { hashOpenKitTreeEntries, type OpenKitTreeEntry } from '@openkit/config-schema';

/** Invalid authored catalog supply, including unsupported plugin declarations and unrepresentable ids. */
export class CatalogInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogInputError';
  }
}

/** One API-submitted tree entry. */
export interface CatalogTreeFile {
  /** Canonical base64 file bytes; omitted for directories and empty files. */
  readonly contentBase64?: string;
  /** Whether any file executable bit should be retained; directories cannot set this to true. */
  readonly executable?: boolean;
  /** Directory or regular file. */
  readonly kind: 'directory' | 'file';
  /** Root-relative path. */
  readonly path: string;
}

/** Validates one bounded transport tree and derives its physical-tree identity without filesystem effects. */
export function validateCatalogTree(tree: readonly CatalogTreeFile[]): {
  readonly entries: readonly OpenKitTreeEntry[];
  readonly digest: string;
} {
  const entries = treeFilesToEntries(tree);
  return { digest: hashOpenKitTreeEntries(entries), entries };
}

/** Forms the actual tree, including ancestors that materialization must create, before shared validation. */
export function treeFilesToEntries(tree: readonly CatalogTreeFile[]): OpenKitTreeEntry[] {
  const entries: OpenKitTreeEntry[] = tree.map((entry) => {
    if (entry.kind === 'directory') {
      if (entry.contentBase64 !== undefined || entry.executable === true)
        throw new CatalogInputError(
          `Resource tree directory cannot carry content or executable file flags: ${entry.path}.`
        );
      return { kind: 0, path: entry.path };
    }
    const encoded = entry.contentBase64 ?? '';
    const content = Buffer.from(encoded, 'base64');
    // Node accepts malformed encodings; exact transport must already be canonical.
    if (content.toString('base64') !== encoded)
      throw new CatalogInputError(`Resource tree file requires canonical base64: ${entry.path}.`);
    return { content, kind: entry.executable ? 2 : 1, path: entry.path };
  });
  const directories = new Set(
    entries.filter((entry) => entry.kind === 0).map((entry) => entry.path)
  );
  for (const entry of tree) {
    const segments = entry.path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/');
      if (!directories.has(path)) {
        directories.add(path);
        // A file at this path remains a duplicate, which the shared validator rejects.
        entries.push({ kind: 0, path });
      }
    }
  }
  return entries;
}
