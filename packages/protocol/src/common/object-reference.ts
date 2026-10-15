import { z } from 'zod';
import { isThreadId, isTurnId, isUserId, isWorkspaceId } from './ids.js';

/** Logical collection identified by the fixed local reference grammar. */
export type ReferenceScope =
  | { family: 'page'; kind: 'user'; userId: string }
  | { family: 'page'; kind: 'workspace'; workspaceId: string }
  | { family: 'page'; kind: 'server' }
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
  if (family === 'page') {
    if (kind === 'server' && parts.length === 2) return { family, kind };
    if (kind === 'user' && parts.length === 3 && a && isUserId(a))
      return { family, kind, userId: a };
    if (kind === 'workspace' && parts.length === 3 && a && isWorkspaceId(a))
      return { family, kind, workspaceId: a };
  }
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
  .strict();

/** Page reference keeps page-path validation with the Knowledge owner. */
export const PageReferenceSchema = ScopeQualifiedReferenceSchema.extend({
  scopeId: ReferenceScopeIdSchema.refine((value) => parseReferenceScope(value)?.family === 'page'),
});

/** Existing server-generated retrieval-trace id, independent of its owning collection. */
export const RetrievalTraceIdSchema = z
  .string()
  .regex(/^krt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** Query-owned trace reference; a reference never grants access to its evidence. */
export const RetrievalTraceReferenceSchema = ScopeQualifiedReferenceSchema.extend({
  scopeId: ReferenceScopeIdSchema.refine(
    (value) => parseReferenceScope(value)?.family === 'retrieval-trace'
  ),
  objectId: RetrievalTraceIdSchema,
});

/** Scope-qualified object identity. */
export type ScopeQualifiedReference = z.infer<typeof ScopeQualifiedReferenceSchema>;
/** Logical notebook page identity. */
export type PageReference = z.infer<typeof PageReferenceSchema>;
/** Query-owned selection evidence identity. */
export type RetrievalTraceReference = z.infer<typeof RetrievalTraceReferenceSchema>;
