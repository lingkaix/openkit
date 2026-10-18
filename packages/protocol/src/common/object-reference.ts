import { z } from 'zod';
import { entityIdPattern } from './entity-id.js';
import {
  ArtifactIdSchema,
  isKnowledgeBaseId,
  isThreadId,
  isTurnId,
  isUserId,
  isWorkspaceId,
  MaterialIdSchema,
} from './ids.js';

/** Logical collection identified by the fixed local reference grammar. */
export type ReferenceScope =
  | { family: 'page'; kind: 'user'; userId: string; knowledgeBaseId: string }
  | { family: 'page'; kind: 'workspace'; workspaceId: string; knowledgeBaseId: string }
  | { family: 'page'; kind: 'server'; knowledgeBaseId: string }
  | { family: 'raw'; kind: 'user'; userId: string; knowledgeBaseId: string }
  | { family: 'raw'; kind: 'workspace'; workspaceId: string; knowledgeBaseId: string }
  | { family: 'raw'; kind: 'server'; knowledgeBaseId: string }
  | { family: 'artifact' | 'material'; kind: 'workspace'; workspaceId: string }
  | { family: 'input'; kind: 'turn'; workspaceId: string; threadId: string; turnId: string }
  | { family: 'retrieval-trace'; kind: 'thread'; workspaceId: string; threadId: string }
  | {
      family: 'retrieval-trace';
      kind: 'turn';
      workspaceId: string;
      threadId: string;
      turnId: string;
    };

/** Parses one exact logical scope path; transport decoding belongs to its transport. */
export function parseReferenceScope(value: string): ReferenceScope | null {
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const [family, kind, a, b, c] = parts;
  if (family === 'page' || family === 'raw') {
    if (kind === 'server' && parts.length === 3 && a && isKnowledgeBaseId(a))
      return { family, kind, knowledgeBaseId: a };
    if (kind === 'user' && parts.length === 4 && a && b && isUserId(a) && isKnowledgeBaseId(b))
      return { family, kind, userId: a, knowledgeBaseId: b };
    if (
      kind === 'workspace' &&
      parts.length === 4 &&
      a &&
      b &&
      isWorkspaceId(a) &&
      isKnowledgeBaseId(b)
    )
      return { family, kind, workspaceId: a, knowledgeBaseId: b };
  }
  if (
    (family === 'artifact' || family === 'material') &&
    kind === 'workspace' &&
    parts.length === 3 &&
    a &&
    isWorkspaceId(a)
  )
    return { family, kind, workspaceId: a };
  if (
    family === 'input' &&
    kind === 'turn' &&
    parts.length === 5 &&
    a &&
    b &&
    c &&
    isWorkspaceId(a) &&
    isThreadId(b) &&
    isTurnId(c)
  )
    return { family, kind, workspaceId: a, threadId: b, turnId: c };
  if (family === 'retrieval-trace' && a && b && isWorkspaceId(a) && isThreadId(b)) {
    if (kind === 'thread' && parts.length === 4)
      return { family, kind, workspaceId: a, threadId: b };
    if (kind === 'turn' && parts.length === 5 && c && isTurnId(c))
      return { family, kind, workspaceId: a, threadId: b, turnId: c };
  }
  return null;
}

/** Exact local collection path, validated by its current identifier owners. */
export const ReferenceScopeIdSchema = z
  .string()
  .refine((value) => parseReferenceScope(value) !== null, {
    message: 'Invalid scope-qualified reference scope.',
  });

/** Reference identity; resolution additionally requires trusted Server context and current access. */
export const ScopeQualifiedReferenceSchema = z
  .object({
    scopeId: ReferenceScopeIdSchema,
    objectId: z.string().min(1),
  })
  .strict()
  .superRefine(({ scopeId, objectId }, context) => {
    const family = parseReferenceScope(scopeId)?.family;
    const valid =
      family === 'artifact'
        ? !objectId.includes('/') && ArtifactIdSchema.safeParse(objectId).success
        : family === 'material'
          ? !objectId.includes('/') && MaterialIdSchema.safeParse(objectId).success
          : family === 'raw'
            ? isSafeObjectPath(objectId)
            : family !== 'input' ||
              (/^(0|[1-9][0-9]*)$/.test(objectId) && Number.isSafeInteger(Number(objectId)));
    if (!valid)
      context.addIssue({
        code: 'custom',
        path: ['objectId'],
        message: 'Invalid object selector for this reference kind.',
      });
  });

/** Page reference keeps page-path validation with the Knowledge owner. */
export const PageReferenceSchema = ScopeQualifiedReferenceSchema.safeExtend({
  scopeId: ReferenceScopeIdSchema.refine((value) => parseReferenceScope(value)?.family === 'page'),
});

/** Raw-content identity uses a safe path relative to its Knowledge Base raw root, with no mount inference. */
export const RawContentReferenceSchema = ScopeQualifiedReferenceSchema.safeExtend({
  scopeId: ReferenceScopeIdSchema.refine((value) => parseReferenceScope(value)?.family === 'raw'),
});

/** Existing server-generated retrieval-trace id, independent of its owning collection. */
export const RetrievalTraceIdSchema = z.string().regex(entityIdPattern('krt'));

/** Query-owned trace reference; a reference never grants access to its evidence. */
export const RetrievalTraceReferenceSchema = ScopeQualifiedReferenceSchema.safeExtend({
  scopeId: ReferenceScopeIdSchema.refine(
    (value) => parseReferenceScope(value)?.family === 'retrieval-trace'
  ),
  objectId: RetrievalTraceIdSchema,
});

/** Scope-qualified object identity. */
export type ScopeQualifiedReference = z.infer<typeof ScopeQualifiedReferenceSchema>;
/** Logical notebook page identity. */
export type PageReference = z.infer<typeof PageReferenceSchema>;
/** Raw-content path identity within an exact Knowledge Base. */
export type RawContentReference = z.infer<typeof RawContentReferenceSchema>;
/** Query-owned selection evidence identity. */
export type RetrievalTraceReference = z.infer<typeof RetrievalTraceReferenceSchema>;

/** Existing immutable Artifact selection; version and original digest are separate evidence. */
export const ArtifactReferenceSchema = ScopeQualifiedReferenceSchema.safeExtend({
  scopeId: ReferenceScopeIdSchema.refine(
    (value) => parseReferenceScope(value)?.family === 'artifact'
  ),
  objectId: ArtifactIdSchema,
});

/** Existing Workspace Material selection; revisions remain under the Material owner. */
export const MaterialReferenceSchema = ScopeQualifiedReferenceSchema.safeExtend({
  scopeId: ReferenceScopeIdSchema.refine(
    (value) => parseReferenceScope(value)?.family === 'material'
  ),
  objectId: MaterialIdSchema,
});

/** Ordered input selector within one retained Turn; an ordinal grants no file access. */
export const TurnInputReferenceSchema = ScopeQualifiedReferenceSchema.safeExtend({
  scopeId: ReferenceScopeIdSchema.refine((value) => parseReferenceScope(value)?.family === 'input'),
});

/** Qualified immutable Artifact owner identity. */
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
/** Qualified Workspace Material owner identity. */
export type MaterialReference = z.infer<typeof MaterialReferenceSchema>;
/** Qualified retained input ordinal. */
export type TurnInputReference = z.infer<typeof TurnInputReferenceSchema>;

const contentDigestPattern = /^sha256:[0-9a-f]{64}(?![\s\S])/;

/** Rejects unsafe path structure and invalid Unicode without interpreting percent text or mount names. */
function isSafeObjectPath(value: string): boolean {
  return (
    !/[\p{Cc}\p{Cs}\\]/u.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/**
 * Formats one canonical local URI; the optional original-content digest remains separate evidence.
 * @param reference Exact logical scope and unescaped object path; this grants no access.
 * @param contentDigest Optional lowercase SHA-256 evidence in sha256:<hex> form.
 * @returns Canonical openkit URI with one encoded segment per original path segment.
 * @throws Error when the reference, object path or digest is invalid.
 */
export function formatReferenceUri(
  reference: ScopeQualifiedReference,
  contentDigest?: string
): string {
  const parsed = ScopeQualifiedReferenceSchema.parse(reference);
  if (parseReferenceScope(parsed.scopeId)?.family === 'retrieval-trace')
    RetrievalTraceReferenceSchema.parse(parsed);
  if (!isSafeObjectPath(parsed.objectId)) throw new TypeError('Invalid reference object path.');
  if (
    contentDigest !== undefined &&
    (typeof contentDigest !== 'string' || !contentDigestPattern.test(contentDigest))
  )
    throw new TypeError('Invalid reference content digest.');
  const objectPath = parsed.objectId
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/');
  return `openkit:${parsed.scopeId}/${objectPath}${contentDigest === undefined ? '' : `@${contentDigest}`}`;
}

/**
 * Parses canonical URI text without resolution, authorization or Unicode normalization.
 * @param uri Exact openkit URI; percent text is decoded once within object path segments only.
 * @returns Logical reference and separate optional digest, or null for unsafe or noncanonical text.
 */
export function parseReferenceUri(
  uri: string
): { reference: ScopeQualifiedReference; contentDigest?: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith('openkit:')) return null;
  try {
    let path = uri.slice('openkit:'.length);
    let contentDigest: string | undefined;
    const pinOffset = path.indexOf('@');
    if (pinOffset !== -1) {
      contentDigest = path.slice(pinOffset + 1);
      if (!contentDigestPattern.test(contentDigest)) return null;
      path = path.slice(0, pinOffset);
    }
    const parts = path.split('/');
    // All closed scope forms have three to five segments; object paths can contain any count.
    const scopeLength = [3, 4, 5].find(
      (length) => parseReferenceScope(parts.slice(0, length).join('/')) !== null
    );
    if (scopeLength === undefined) return null;
    const reference = {
      scopeId: parts.slice(0, scopeLength).join('/'),
      objectId: parts
        .slice(scopeLength)
        .map((segment) => {
          const decoded = decodeURIComponent(segment);
          if (decoded.includes('/') || decoded.includes('\\'))
            throw new TypeError('Encoded reference separator.');
          return decoded;
        })
        .join('/'),
    };
    // Re-encoding enforces uppercase escapes and rejects aliases such as escaped unreserved text.
    if (formatReferenceUri(reference, contentDigest) !== uri) return null;
    return { reference, ...(contentDigest === undefined ? {} : { contentDigest }) };
  } catch {
    return null;
  }
}

/** Canonical URI string admission uses the same parser as every textual reference consumer. */
export const ReferenceUriSchema = z.string().refine((value) => parseReferenceUri(value) !== null, {
  message: 'Invalid canonical reference URI.',
});
