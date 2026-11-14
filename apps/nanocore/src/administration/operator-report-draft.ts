const DESCRIPTION_CODEPOINT_LIMIT = 1200;

/**
 * Formats only an operator's own observations and fixed upstream links as plain text.
 * This creates neither an Artifact nor a source/permission claim and performs no submission.
 * Native callers independently authenticate and authorize any source before using this text.
 */
export function renderOperatorReportDraft(description: string): string {
  const points = Array.from(description);
  const quoted = JSON.stringify(points.slice(0, DESCRIPTION_CODEPOINT_LIMIT).join(''));
  return [
    'Unsubmitted operator report draft: unverified observations, not an Artifact.',
    `Operator description (untrusted, JSON-quoted${points.length > DESCRIPTION_CODEPOINT_LIMIT ? ', truncated at 1200 Unicode codepoints' : ', bounded to 1200 Unicode codepoints'}):`,
    quoted,
    '',
    'Suspected-security reports: follow private upstream instructions; do not post private evidence in public issues.',
    'https://github.com/lingkaix/openkit/security',
    'Non-security defects: review the issue text yourself before using the upstream issue form.',
    'https://github.com/lingkaix/openkit/issues/new',
    'You may instead use your own binding only under its existing authority.',
    'No automatic publication, Task start, credential delivery or binding creation occurs.',
  ].join('\n');
}
