import { PolicyDocumentV1Schema, ThreadIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ProductOperationSchema } from './product-policy.js';

/** Readers must understand the common Policy restrictions before exposing content. */
export const WORKSPACE_RESOURCE_POLICY_FEATURE = 'openkit.workspace-resource-policy.v1';

/** Transient request selector; authority lives only in the scope-owned Policy document. */
export const WorkspacePolicyResourceSchema = z
  .object({ family: z.literal('thread'), id: ThreadIdSchema })
  .strict();

/** Current recipient binding used by portable import admission, never a retained grant grammar. */
export type WorkspacePolicySubject =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'agent'; readonly userId: string; readonly agentId: string };

/** Native Workspace constraints on the shared grammar; parsing supplies no current author authority. */
export const WorkspacePolicyDocumentSchema = PolicyDocumentV1Schema.superRefine((document, ctx) => {
  const boundaries = new Set<string>();
  const permissions: string[] = [];
  for (const [index, statement] of document.statements.entries()) {
    const invalid = () =>
      ctx.addIssue({
        code: 'custom',
        path: ['statements', index],
        message: 'Unsupported Workspace Policy scope, constraint or boundary.',
      });
    if (statement.kind !== 'permission' && statement.kind !== 'managed-boundary') {
      invalid();
      continue;
    }
    const anchor = statement.lifetime.anchor;
    const target = statement.scope.resources[0];
    if (
      statement.author.kind !== 'human' ||
      statement.authority.kind !== 'human' ||
      statement.author.id !== statement.authority.userId ||
      anchor.owner.kind !== 'workspace' ||
      anchor.kind !== 'workspace' ||
      anchor.id !== anchor.owner.workspaceId ||
      statement.lifetime.notAfter !== undefined ||
      statement.lifetime.uses !== undefined ||
      statement.scope.resources.length !== 1 ||
      target?.kind !== 'container' ||
      target.container.kind !== 'thread' ||
      target.container.owner.kind !== 'workspace' ||
      target.container.owner.workspaceId !== anchor.id
    ) {
      invalid();
      continue;
    }
    const key = JSON.stringify(target.container);
    if (statement.kind === 'managed-boundary') {
      if (statement.state === 'active') {
        if (boundaries.has(key)) invalid();
        boundaries.add(key);
      }
    } else {
      if (
        !['ordinary', 'agent-process'].includes(statement.grant.kind) ||
        (statement.state === 'active' && !['allow', 'prohibit'].includes(statement.effect)) ||
        statement.scope.subjects.length !== 1 ||
        statement.scope.subjects[0]?.kind !== 'human' ||
        statement.scope.actions.some((action) => !ProductOperationSchema.safeParse(action).success)
      )
        invalid();
      if (statement.state === 'active') permissions.push(key);
    }
  }
  for (const key of permissions)
    if (!boundaries.has(key))
      ctx.addIssue({
        code: 'custom',
        path: ['statements'],
        message: 'An active permission requires its managed boundary.',
      });
});
