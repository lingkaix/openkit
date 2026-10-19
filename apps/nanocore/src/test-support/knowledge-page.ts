import { createHash } from 'node:crypto';
import { type KnowledgeOwnerScope, KnowledgeOwnerScopeSchema } from '@openkit/protocol';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
} from '../knowledge/okf.js';

/**
 * Authors explicit OKF KnowledgePage bytes for fixtures that do not test page editing.
 *
 * @param input Fixture title, body, timestamps and exact source references.
 * @param ownerScope Trusted fixture owner recorded in the full page bytes.
 * @returns Complete canonical Markdown with one final fixture newline.
 */
export function serializeKnowledgePageFixture(
  input: {
    readonly title: string;
    readonly content: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sourceReferences?: readonly string[];
  },
  ownerScope: KnowledgeOwnerScope
): string {
  const scope = KnowledgeOwnerScopeSchema.parse(ownerScope);
  return [
    '---',
    'type: "KnowledgePage"',
    `title: ${JSON.stringify(input.title)}`,
    `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
    'openkit_status: "active"',
    'status: "stable"',
    `scope: ${JSON.stringify(scope)}`,
    `requiredFeatures: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
    `source_refs: ${JSON.stringify(input.sourceReferences ?? [])}`,
    'review_state: "user-authored"',
    'sensitivity: "normal"',
    'freshness: "current"',
    `created_at: ${JSON.stringify(input.createdAt)}`,
    `updated_at: ${JSON.stringify(input.updatedAt)}`,
    '---',
    input.content,
    '',
  ].join('\n');
}

/** Authors one canonical page fixture for Store/import consumers without a legacy entry record. */
export function knowledgePageFixture(
  input: Parameters<typeof serializeKnowledgePageFixture>[0] & { readonly id: string },
  ownerScope: KnowledgeOwnerScope
) {
  const content = serializeKnowledgePageFixture(input, ownerScope);
  return {
    id: input.id,
    path: `${input.id}.md`,
    content,
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}
