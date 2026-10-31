import { Document, parseDocument } from 'yaml';

const DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION = 'openkit-scope-knowledge-schema-v4';
const REQUIRED_SCOPED_KNOWLEDGE_FEATURES = [
  'openkit.knowledge-owner-scope.v1',
  'openkit.knowledge-git-notebook.v1',
] as const;

interface OkfFraming {
  readonly frontmatter: string | null;
  readonly body: string;
  readonly unclosed: boolean;
}

/** Splits one OKF Markdown document into frontmatter and body without validating profile fields. */
function splitOkfDocument(content: string): OkfFraming {
  if (!content.startsWith('---\n')) {
    return { body: content, frontmatter: null, unclosed: false };
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return { body: '', frontmatter: '', unclosed: true };
  }
  return {
    body: content.slice(end + '\n---\n'.length),
    frontmatter: content.slice(4, end),
    unclosed: false,
  };
}

/** Normalizes body text for title/body editors while keeping an empty body empty. */
function normalizeEditableBody(body: string): string {
  if (body.length === 0) return body;
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

/** Ensures persisted OKF body bytes end with one trailing newline when non-empty. */
function serializeBody(body: string): string {
  if (body.length === 0) return body;
  return body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * Page lifecycle states the Notebook UI may select, in lifecycle order.
 *
 * These are the governed `openkit_status` values from the Knowledge Store governance
 * rules. `invalid` and `deleted` stay out of the human selector: they name a rejected or
 * suppressed record rather than an ordinary authoring intent.
 */
export const KNOWLEDGE_PAGE_STATES = ['draft', 'active', 'archived', 'superseded'] as const;

/** One selectable page lifecycle state. */
export type KnowledgePageState = (typeof KNOWLEDGE_PAGE_STATES)[number];

/**
 * Standard OKF `status` each selectable page state projects to.
 *
 * The governance owner requires `openkit_status` and this projection to agree, so the UI
 * writes both fields together rather than leaving the page in a conflicting state.
 */
const STANDARD_STATUS_BY_PAGE_STATE = {
  active: 'stable',
  archived: 'deprecated',
  draft: 'draft',
  superseded: 'deprecated',
} satisfies Record<KnowledgePageState, string>;

/** Reports whether one value is a selectable page lifecycle state. */
export function isKnowledgePageState(value: unknown): value is KnowledgePageState {
  return typeof value === 'string' && (KNOWLEDGE_PAGE_STATES as readonly string[]).includes(value);
}

/** Reads human title, body, OKF type and page state from complete page bytes. */
export function readKnowledgePageDisplay(
  path: string,
  content: string
): { title: string; body: string; type: string | null; state: KnowledgePageState | null } {
  const framing = splitOkfDocument(content);
  if (framing.frontmatter === null || framing.unclosed) {
    return { title: path, body: normalizeEditableBody(framing.body), type: null, state: null };
  }
  const document = parseDocument(framing.frontmatter, { uniqueKeys: true });
  const frontmatter = document.toJS({ maxAliasCount: 50 });
  const record =
    frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
      ? (frontmatter as Record<string, unknown>)
      : {};
  const title = typeof record.title === 'string' ? record.title : path;
  const type = typeof record.type === 'string' ? record.type : null;
  const state = isKnowledgePageState(record.openkit_status) ? record.openkit_status : null;
  return { title, body: normalizeEditableBody(framing.body), type, state };
}

/** Updates only managed title, body and/or page state while retaining other frontmatter keys. */
export function patchKnowledgePageTitleBody(input: {
  path: string;
  content: string;
  title?: string;
  body?: string;
  state?: KnowledgePageState;
}): string {
  const framing = splitOkfDocument(input.content);
  if (framing.frontmatter === null || framing.unclosed) {
    throw new Error('Knowledge page bytes cannot be edited because frontmatter is invalid.');
  }
  const document = parseDocument(framing.frontmatter, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error('Knowledge page bytes cannot be edited because frontmatter YAML is invalid.');
  }
  if (input.title !== undefined) document.set('title', input.title);
  if (input.state !== undefined) {
    document.set('openkit_status', input.state);
    document.set('status', STANDARD_STATUS_BY_PAGE_STATE[input.state]);
  }
  const serialized = document.toString({ lineWidth: 0 });
  const body = input.body !== undefined ? serializeBody(input.body) : framing.body;
  return `---\n${serialized}---\n${body}`;
}

/** Builds complete scoped OKF bytes for one new human-authored Knowledge page. */
export function composeUserAuthoredKnowledgePage(input: {
  workspaceId: string;
  path: string;
  title: string;
  body: string;
  state?: KnowledgePageState;
  sourceRefs?: readonly string[];
  timestamp?: string;
}): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const state = input.state ?? 'active';
  const document = new Document({
    type: 'KnowledgePage',
    title: input.title,
    schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
    requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
    openkit_status: state,
    status: STANDARD_STATUS_BY_PAGE_STATE[state],
    scope: { kind: 'workspace', workspaceId: input.workspaceId },
    source_refs: input.sourceRefs ? [...input.sourceRefs] : [],
    review_state: 'user-authored',
    sensitivity: 'normal',
    freshness: 'current',
    created_at: timestamp,
    updated_at: timestamp,
  });
  const frontmatter = document.toString({ lineWidth: 0 });
  return `---\n${frontmatter}---\n${serializeBody(input.body)}`;
}
