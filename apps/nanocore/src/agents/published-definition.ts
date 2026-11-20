import { UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

const reference = z.string().min(1);
const slot = z
  .object({
    kind: z.enum(['brief', 'fact']),
    schemaId: reference,
    schemaRevision: reference,
  })
  .strict();

function tokenCeiling(inputTokens: number, outputTokens: number) {
  return z
    .object({
      inputTokens: z.number().int().min(1).max(inputTokens),
      outputTokens: z.number().int().min(1).max(outputTokens),
    })
    .strict();
}

/** Option A read contract. It never loads a Worker manifest or activates a definition. */
const publishedDefinition = z
  .object({
    kind: z.literal('published'),
    definitionId: reference,
    definitionRevision: reference,
    agentId: reference,
    displayName: reference,
    botUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    accountableUserId: UserIdSchema,
    workspaceIds: z.array(WorkspaceIdSchema).min(1),
    prompt: reference,
    policyRevision: reference,
    logicalModelId: reference,
    slotSchemas: z.record(reference, slot),
    ceilings: z
      .object({ basic: tokenCeiling(6000, 256), expanded: tokenCeiling(16000, 512) })
      .strict(),
  })
  .strict();

type PublishedDefinition = z.infer<typeof publishedDefinition>;

/** Prepares an immutable revision inside the existing owner's CAS. The caller owns persistence. */
export function preparePublishedDefinitionRevision(input: {
  readonly candidate: unknown;
  readonly definitionId: string;
  readonly expectedCurrentRevision: string | null;
  readonly currentRevision: string | null;
  readonly hasRevision: (revision: string) => boolean;
  readonly admits: (candidate: PublishedDefinition) => boolean;
}) {
  const next = publishedDefinition.safeParse(input.candidate);
  if (
    !next.success ||
    next.data.definitionId !== input.definitionId ||
    input.expectedCurrentRevision !== input.currentRevision ||
    next.data.definitionRevision === input.currentRevision ||
    input.hasRevision(next.data.definitionRevision) ||
    !input.admits(next.data)
  )
    return undefined;
  return next.data;
}

/** Workspace-scoped readback for Communication. A result is not a grant or active deployment. */
export function readPublishedDefinition(
  value: unknown,
  selection: { definitionId: string; definitionRevision: string; workspaceId: string }
) {
  const parsed = publishedDefinition.safeParse(value);
  if (!parsed.success) return undefined;
  const definition = parsed.data;
  if (
    definition.definitionId !== selection.definitionId ||
    definition.definitionRevision !== selection.definitionRevision ||
    !definition.workspaceIds.includes(selection.workspaceId)
  )
    return undefined;
  return definition;
}
