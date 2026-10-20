import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { type KnowledgeOwnerScope, parseReferenceScope } from '@openkit/protocol';
import MarkdownIt from 'markdown-it';
import type { NotebookRevision } from './notebook.js';
import {
  parseKnowledgePageSourceReference,
  parseOkfDocument,
  validateKnowledgePageCandidate,
} from './okf.js';

import { assertSourcePointerEdit, decodeSourcePointer } from './source-pointers.js';

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
      const source = path.startsWith('@sources/');
      // Resolve authored links in canonical Git namespaces, then project into the transient view.
      target = target.startsWith('/')
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(posix.dirname(source ? path.slice(1) : path), target));
      if (source)
        target = target.startsWith('sources/')
          ? `@${target}`
          : target.startsWith('pages/')
            ? target.slice('pages/'.length)
            : '';
      else if (target.startsWith('@sources/')) target = '';
      links.add(target);
    }
  }
  return links;
}

/** Validates one complete immutable candidate, with changed pages and affected existing links checked together. */
export function validateNotebookCandidate(input: {
  readonly ownerScope: KnowledgeOwnerScope;
  /** Exact page scope supplied by current owner admission, including its retained Knowledge Base. */
  readonly pageScopeId?: string;
  /** Transient path-qualified edit maps can include Sources; NotebookRevision.files stays Page-only. */
  readonly base: Pick<NotebookRevision, 'files'>;
  readonly candidate: Pick<NotebookRevision, 'files'>;
  readonly scopeSchemaText: string;
  readonly registeredSources: ReadonlyMap<string, string | null>;
  readonly resolvedReferences: ReadonlyMap<string, ReadonlySet<string>>;
  /** Trusted current suppression permits an unavailable link, never a readable or restored page. */
  readonly suppressedPageIds?: readonly string[];
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
  const suppressedPaths = new Set(
    input.ownerScope.kind === 'user' ? input.suppressedPageIds?.map((pageId) => `${pageId}.md`) : []
  );
  const knowledgeIds = new Set(
    Object.keys(input.candidate.files)
      .filter(
        (path) =>
          !path.startsWith('@sources/') && !['index.md', 'log.md'].includes(posix.basename(path))
      )
      .map((path) => path.slice(0, -3))
  );
  const errors: Array<{ pageId: string; code: string }> = [];
  const sources = new Set<string>();
  let diagnosticsTruncated = false;
  const fail = (pageId: string, code: string): void => {
    if (errors.length < MAX_DIAGNOSTICS) errors.push({ pageId, code });
    else diagnosticsTruncated = true;
  };
  for (const path of removedPaths)
    if (path.startsWith('@sources/')) fail(path.slice(0, -3), 'notebook.invalid_source_edit');
  for (const path of Object.keys(input.candidate.files).sort()) {
    const pageId = path.slice(0, -3);
    const content = input.candidate.files[path]!;
    if (path.startsWith('@sources/') && changed.has(path)) {
      try {
        const scope = parseReferenceScope(input.pageScopeId ?? '');
        if (input.ownerScope.kind !== 'workspace' || scope?.family !== 'page')
          throw new Error('Invalid Source owner.');
        const id = path.slice('@sources/'.length, -3);
        const pointer = decodeSourcePointer({
          ownerScope: input.ownerScope,
          knowledgeBaseId: scope.knowledgeBaseId,
          scopeSchemaText: input.scopeSchemaText,
          id,
          content,
        });
        if (input.registeredSources.get(id) !== pointer.source.contentDigest)
          throw new Error('Source is unavailable.');
        const original = input.base.files[path];
        if (original !== undefined) assertSourcePointerEdit(original, content);
        sources.add(`source:${id}@${pointer.source.contentDigest}`);
      } catch {
        fail(pageId, 'notebook.invalid_source_edit');
        continue;
      }
    }

    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) {
      // An unchanged malformed member indicates corrupt content, rather than permission to omit it.
      fail(pageId, 'notebook.invalid_document');
      continue;
    }
    if (path === 'index.md' && parsed.document.frontmatter.okf_version !== '0.2') {
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
        ...(input.pageScopeId === undefined ? {} : { pageScopeId: input.pageScopeId }),
        ...(input.resolvedReferences.has(pageId)
          ? { resolvedReferences: input.resolvedReferences.get(pageId)! }
          : {}),
      });
      if (report.conformance !== 'scope-schema-valid' || report.errors.length > 0) {
        fail(pageId, 'notebook.invalid_page');
        // Keep native reason codes for bounded author feedback; omit messages and authored values.
        for (const error of report.errors) fail(pageId, error.code);
      }
      const declaredId = parsed.document.frontmatter.openkit_entry_id;
      if (!path.startsWith('@sources/') && declaredId !== undefined && declaredId !== pageId)
        fail(pageId, 'notebook.page_identity_mismatch');
      const references = parsed.document.frontmatter.source_refs;
      if (Array.isArray(references))
        for (const reference of references)
          if (typeof reference === 'string') sources.add(reference);
      // Subjects are affected objects, not supporting evidence or a new Source family.
      if (parsed.document.frontmatter.type === 'Observation') {
        const subjects = parsed.document.frontmatter.subject_refs;
        if (Array.isArray(subjects))
          for (const reference of subjects) {
            const subject =
              typeof reference === 'string'
                ? parseKnowledgePageSourceReference(reference, input.pageScopeId)
                : null;
            const target = subject
              ? input.candidate.files[`${subject.reference.objectId}.md`]
              : undefined;
            if (
              !subject ||
              target === undefined ||
              (subject.contentDigest !== undefined &&
                subject.contentDigest !==
                  `sha256:${createHash('sha256').update(target).digest('hex')}`)
            )
              fail(pageId, 'notebook.invalid_subject_reference');
          }
      }
    }
    const links = pageLinks(path, parsed.document.body);
    for (const target of links) {
      if (suppressedPaths.has(target) && !Object.hasOwn(input.candidate.files, target)) continue;
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
          if (typeof reference !== 'string') continue;
          const parsedReference = parseKnowledgePageSourceReference(reference, input.pageScopeId);
          if (!parsedReference) continue;
          const target = parsedReference.reference.objectId;
          if (removed.has(`${target}.md`) && !suppressedPaths.has(`${target}.md`)) {
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
