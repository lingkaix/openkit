import {
  composeUserAuthoredKnowledgePage,
  knowledgePageContentDigest,
  patchKnowledgePageTitleBody,
} from './knowledge-okf';

/** Builds one list-compatible Notebook page fixture with optional display fields for UI tests. */
export function knowledgeNotebookPageFixture(input: {
  id: string;
  title: string;
  body: string;
  workspaceId: string;
  timestamp: string;
  path?: string;
  contentDigest?: string;
  extraFrontmatterLine?: string;
}) {
  const path = input.path ?? `notes/${input.id}.md`;
  let content = composeUserAuthoredKnowledgePage({
    workspaceId: input.workspaceId,
    path,
    title: input.title,
    body: input.body,
    timestamp: input.timestamp,
  });
  if (input.extraFrontmatterLine) {
    content = content.replace(
      'review_state: user-authored',
      `${input.extraFrontmatterLine}\nreview_state: user-authored`
    );
  }
  const contentDigest = input.contentDigest ?? knowledgePageContentDigest(content);
  return {
    id: input.id,
    path,
    content,
    contentDigest,
    title: input.title,
    body: input.body,
  };
}

/** Returns an updated page fixture with new title/body while retaining other frontmatter. */
export function knowledgeNotebookPageWithEdits(
  page: { path: string; content: string; id: string; title: string; body: string },
  edits: { title?: string; body?: string }
) {
  const content = patchKnowledgePageTitleBody({
    path: page.path,
    content: page.content,
    ...edits,
  });
  return {
    id: page.id,
    path: page.path,
    content,
    contentDigest: knowledgePageContentDigest(content),
    title: edits.title ?? page.title,
    body: edits.body ?? page.body,
  };
}
