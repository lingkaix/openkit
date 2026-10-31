/** Authored local-link feedback for the same admitted author, never process diagnostics. */
export interface NotebookLinkDiagnostic {
  readonly code: 'notebook.unresolved_page_link';
  readonly pageId: string;
  readonly target: string;
}

/** Closed content-owner failure; host and Git diagnostics stay private. */
export class NotebookError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'conflict' | 'recovery_required' | 'review_required',
    readonly currentRevision?: string,
    /** Native validation codes only; transient feedback, never authored text or publication authority. */
    readonly diagnostics?: readonly string[],
    /** Transient author feedback, ordered and bounded independently of generic codes. */
    readonly linkDiagnostics?: readonly NotebookLinkDiagnostic[]
  ) {
    super(`Notebook ${code.replaceAll('_', ' ')}.`);
    this.linkDiagnostics = linkDiagnostics
      ?.slice()
      .sort((left, right) => (left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0))
      .slice(0, 8)
      .map(({ code, pageId, target }) => ({ code, pageId, target: target.slice(0, 256) }));
  }
}
