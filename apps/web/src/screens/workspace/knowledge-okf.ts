import { createHash } from 'node:crypto';
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

/** Reads human title, body and OKF type from complete page bytes. */
export function readKnowledgePageDisplay(
  path: string,
  content: string
): { title: string; body: string; type: string | null } {
  const framing = splitOkfDocument(content);
  if (framing.frontmatter === null || framing.unclosed) {
    return { title: path, body: normalizeEditableBody(framing.body), type: null };
  }
  const document = parseDocument(framing.frontmatter, { uniqueKeys: true });
  const frontmatter = document.toJS({ maxAliasCount: 50 });
  const record =
    frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
      ? (frontmatter as Record<string, unknown>)
      : {};
  const title = typeof record.title === 'string' ? record.title : path;
  const type = typeof record.type === 'string' ? record.type : null;
  return { title, body: normalizeEditableBody(framing.body), type };
}

/** Updates only managed title and/or body fields while retaining other frontmatter keys. */
export function patchKnowledgePageTitleBody(input: {
  path: string;
  content: string;
  title?: string;
  body?: string;
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
  sourceRefs?: readonly string[];
  timestamp?: string;
}): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const document = new Document({
    type: 'KnowledgePage',
    title: input.title,
    schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
    requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
    openkit_status: 'active',
    status: 'stable',
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

/** Computes the canonical page digest for fixtures and assertions. */
export function knowledgePageContentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
