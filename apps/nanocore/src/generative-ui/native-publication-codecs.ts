import { GenerativePresentationSchema } from '@openkit/app-api-schemas';
import {
  ItemSchema,
  RequestIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Exact domain tuple; immutable bodies use the existing native binary reservation, not JSON-envelope capacity. */
export const ControlGenerativePresentationSchema = z
  .object({
    presentation: GenerativePresentationSchema.omit({ publication: true }),
    answer: ItemSchema.nullable(),
    sourceItem: ItemSchema.nullable(),
    receipt: z
      .object({
        key: z.string().min(1),
        command: z.literal('generative-ui.publish'),
        requestId: RequestIdSchema,
        scope: z.object({ workspaceId: WorkspaceIdSchema, actorId: z.string().min(1) }).strict(),
        inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        responseKind: z.literal('generative_presentation'),
        createdAt: TimestampSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
  })
  .strict();
/** Typed native publication body, decoded and validated before any SQL. */
export type ControlGenerativePresentation = z.infer<typeof ControlGenerativePresentationSchema>;
/** Small closed envelope for the existing transferable binary account. */
export const ControlGenerativePresentationWireSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    turnId: TurnIdSchema,
    byteLength: z.number().int().positive().safe(),
  })
  .strict();
/** Native publication envelope; its body is only ControlGenerativePresentation, never SQL or callbacks. */
export type ControlGenerativePresentationWire = z.infer<
  typeof ControlGenerativePresentationWireSchema
>;
