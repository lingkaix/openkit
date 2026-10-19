import { createHash } from 'node:crypto';
import { formatReferenceUri, parseReferenceUri } from '@openkit/protocol';
import { parseOkfDocument, stringListFrontmatterField } from './okf.js';

/** Reads current unresolved subjects from the Notebook, without treating evidence as a subject. */
export function unresolvedNotebookSubjects(
  files: Readonly<Record<string, string>>,
  pageScopeId: string
): ReadonlySet<string> {
  const subjects = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) continue;
    const fields = parsed.document.frontmatter;
    if (
      fields.type !== 'Observation' ||
      fields.conflict_status !== 'unresolved' ||
      !['draft', 'active'].includes(String(fields.openkit_status))
    )
      continue;
    for (const reference of stringListFrontmatterField(parsed.document, 'subject_refs') ?? []) {
      const subject = parseReferenceUri(reference);
      if (!subject || subject.reference.scopeId !== pageScopeId) continue;
      // A version-specific assessment cannot acquire an object-wide claim about later bytes.
      if (subject.contentDigest !== undefined) {
        const target = files[`${subject.reference.objectId}.md`];
        if (
          target === undefined ||
          subject.contentDigest !== `sha256:${createHash('sha256').update(target).digest('hex')}`
        )
          continue;
      }
      subjects.add(formatReferenceUri(subject.reference));
    }
  }
  return subjects;
}
