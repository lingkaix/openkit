import { KnowledgeBaseIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Scope-owned location declarations carry neither credentials nor permission grants. */
export const KnowledgeMountSchema = z
  .object({
    name: z.string().min(1),
    backend: z.string().min(1),
    root: z.string().min(1),
    default: z.boolean(),
    knowledgeBaseId: KnowledgeBaseIdSchema,
  })
  .strip();

/** One fixed Knowledge Base has one default mount and unique namespace names. */
export const KnowledgeMountsSchema = z
  .array(KnowledgeMountSchema)
  .superRefine((mounts, context) => {
    if (mounts.filter((mount) => mount.default).length !== 1)
      context.addIssue({ code: 'custom', message: 'Exactly one Knowledge mount must be default.' });
    const names = new Set<string>();
    mounts.forEach((mount, index) => {
      if (names.has(mount.name))
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: 'Knowledge mount names must be unique.',
        });
      names.add(mount.name);
    });
  });

/** Checks the fixed owner binding without allocating or selecting a Knowledge Base. */
export function validateKnowledgeMountBinding(
  value: {
    defaultKnowledgeBaseId?: string | undefined;
    knowledgeMounts?: z.infer<typeof KnowledgeMountsSchema> | undefined;
  },
  context: z.RefinementCtx
): void {
  if (value.knowledgeMounts === undefined) return;
  if (!value.defaultKnowledgeBaseId)
    context.addIssue({
      code: 'custom',
      path: ['knowledgeMounts'],
      message: 'Knowledge mounts require the fixed scope Knowledge Base.',
    });
  value.knowledgeMounts.forEach((mount, index) => {
    if (mount.knowledgeBaseId !== value.defaultKnowledgeBaseId)
      context.addIssue({
        code: 'custom',
        path: ['knowledgeMounts', index, 'knowledgeBaseId'],
        message: 'Knowledge mount does not belong to the fixed scope Knowledge Base.',
      });
  });
}

/** Serialized location declaration, separate from current Storage access. */
export type KnowledgeMount = z.infer<typeof KnowledgeMountSchema>;
