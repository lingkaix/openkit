import { posix } from 'node:path';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import MarkdownIt from 'markdown-it';
import type { NotebookRevision } from './notebook.js';
import { parseOkfDocument, validateKnowledgePageCandidate } from './okf.js';

const markdown = new MarkdownIt({ html: false, linkify: false });
const MAX_DIAGNOSTICS = 100;

/** Bounded structural diagnostics; current source disclosure and publication authority remain separate checks. */
export interface NotebookValidationResult {
  readonly changedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly sourceReferences: readonly string[];
  readonly errors: readonly { readonly pageId: string; readonly code: string }[];
  readonly diagnosticsTruncated: boolean;
}

/** Reads actual Markdown links, excluding code examples, images and external resources. */
function pageLinks(path: string, body: string): ReadonlySet<string> {
  const links = new Set<string>();
  for (const block of markdown.parse(body, {})) {
    for (const token of block.children ?? []) {
      if (token.type !== 'link_open') continue;
      const href = token.attrGet('href');
      if (
        !href ||
        href.startsWith('#') ||
        href.startsWith('//') ||
        /^[a-z][a-z0-9+.-]*:/i.test(href)
      )
        continue;
      let target: string;
      try {
        target = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
      } catch {
        // A malformed local path cannot resolve to an admitted page.
        links.add('');
        continue;
      }
      if (!target.endsWith('.md')) continue;
      target = target.startsWith('/')
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(posix.dirname(path), target));
      links.add(target);
    }
  }
  return links;
}

/** Validates one complete immutable candidate, with changed pages and affected existing links checked together. */
export function validateNotebookCandidate(input: {
  readonly ownerScope: KnowledgeOwnerScope;
  readonly base: NotebookRevision;
  readonly candidate: NotebookRevision;
  readonly scopeSchemaText: string;
  readonly registeredSources: ReadonlyMap<string, string | null>;
  readonly resolvedReferences: ReadonlyMap<string, ReadonlySet<string>>;
}): NotebookValidationResult {
  const paths = [
    ...new Set([...Object.keys(input.base.files), ...Object.keys(input.candidate.files)]),
  ].sort();
  const changedPaths = paths.filter(
    (path) => input.base.files[path] !== input.candidate.files[path]
  );
  const changed = new Set(changedPaths);
  const removedPaths = changedPaths.filter((path) => !Object.hasOwn(input.candidate.files, path));
  const removed = new Set(removedPaths);
  const knowledgeIds = new Set(
    Object.keys(input.candidate.files)
      .filter((path) => !['index.md', 'log.md'].includes(posix.basename(path)))
      .map((path) => path.slice(0, -3))
  );
  const errors: Array<{ pageId: string; code: string }> = [];
  const sources = new Set<string>();
  let diagnosticsTruncated = false;
  const fail = (pageId: string, code: string): void => {
    if (errors.length < MAX_DIAGNOSTICS) errors.push({ pageId, code });
    else diagnosticsTruncated = true;
  };
  for (const path of Object.keys(input.candidate.files).sort()) {
    const pageId = path.slice(0, -3);
    const content = input.candidate.files[path]!;
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) {
      // An unchanged malformed member indicates corrupt content, rather than permission to omit it.
      fail(pageId, 'notebook.invalid_document');
      continue;
    }
    if (changed.has(path) && !parsed.document.reserved) {
      const report = validateKnowledgePageCandidate({
        path,
        content,
        scopeSchemaText: input.scopeSchemaText,
        expectedOwnerScope: input.ownerScope,
        registeredSources: input.registeredSources,
        knowledgeIds,
        ...(input.resolvedReferences.has(pageId)
          ? { resolvedReferences: input.resolvedReferences.get(pageId)! }
          : {}),
      });
      if (report.conformance !== 'scope-schema-valid' || report.errors.length > 0)
        fail(pageId, 'notebook.invalid_page');
      const declaredId = parsed.document.frontmatter.openkit_entry_id;
      if (declaredId !== undefined && declaredId !== pageId)
        fail(pageId, 'notebook.page_identity_mismatch');
      const references = parsed.document.frontmatter.source_refs;
      if (Array.isArray(references))
        for (const reference of references)
          if (typeof reference === 'string') sources.add(reference);
    }
    const links = pageLinks(path, parsed.document.body);
    for (const target of links) {
      if (
        (changed.has(path) && !Object.hasOwn(input.candidate.files, target)) ||
        (!changed.has(path) && removed.has(target))
      ) {
        fail(pageId, 'notebook.unresolved_page_link');
        break;
      }
    }
    // A Source-style local page citation must also survive removal, even in an unchanged referrer.
    if (!changed.has(path)) {
      const references = parsed.document.frontmatter.source_refs;
      if (Array.isArray(references))
        for (const reference of references) {
          if (typeof reference !== 'string' || !reference.startsWith('knowledge:')) continue;
          const target = reference.slice('knowledge:'.length).split('@', 1)[0]!;
          if (removed.has(`${target}.md`)) {
            fail(pageId, 'notebook.unresolved_page_reference');
            break;
          }
        }
    }
  }
  return {
    changedPaths,
    removedPaths,
    sourceReferences: [...sources].sort(),
    errors,
    diagnosticsTruncated,
  };
}
