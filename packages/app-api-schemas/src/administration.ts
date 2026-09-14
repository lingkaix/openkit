import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';

import { SubmitConversationResponseSchema } from './chat-mode.js';

/** Request body for one turn in the current user's private administration entry. */
export const SubmitAdministrationConversationRequestSchema = z
  .object({
    input: z.string().min(1),
    logicalModelId: z.string().min(1).optional(),
    requestId: RequestIdSchema,
    threadId: z.string().min(1).optional(),
  })
  .strict();

/** Administration conversation response using the shared conversation projection. */
export const SubmitAdministrationConversationResponseSchema = SubmitConversationResponseSchema;

/** Request body for one private administration conversation turn. */
export type SubmitAdministrationConversationRequest = z.infer<
  typeof SubmitAdministrationConversationRequestSchema
>;
/** Response from one private administration conversation turn. */
export type SubmitAdministrationConversationResponse = z.infer<
  typeof SubmitAdministrationConversationResponseSchema
>;

/** Exact immutable catalog candidate identity, never a mutable latest pointer. */
export const ConfigurationCandidateRefSchema = z
  .object({
    artifactId: z.string().min(1),
    artifactVersion: z.literal(1),
    contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

/** Bounded catalog draft; the target's registered configuration schema validates changes. */
export const ProposeAdministrationConfigurationRequestSchema = z
  .object({
    targetFamily: z.enum(['gateway', 'provider']),
    targetId: z.string().min(1),
    expectedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    changes: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Human command confirming the exact immutable candidate shown in the private Thread. */
export const ApplyAdministrationConfigurationRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    candidate: ConfigurationCandidateRefSchema,
    confirmation: z
      .object({
        action: z.literal('administration.configuration.apply'),
        contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.confirmation.contentDigest === value.candidate.contentDigest, {
    message: 'Confirmation must bind the exact candidate digest.',
    path: ['confirmation'],
  });

/** Persisted configuration and actual reload outcome, without claiming provider readiness. */
export const ApplyAdministrationConfigurationResponseSchema = z
  .object({
    candidate: ConfigurationCandidateRefSchema,
    persisted: z.boolean(),
    revision: z.string().nullable(),
    reload: z.enum(['applied', 'rejected', 'failed', 'not-attempted']),
    restartRequired: z.boolean(),
  })
  .strict();

/** Catalog proposal input validated again by its configuration owner. */
export type ProposeAdministrationConfigurationRequest = z.infer<
  typeof ProposeAdministrationConfigurationRequestSchema
>;
/** Payload-bound human configuration command. */
export type ApplyAdministrationConfigurationRequest = z.infer<
  typeof ApplyAdministrationConfigurationRequestSchema
>;
/** Truthful persistence/reload result of the human command. */
export type ApplyAdministrationConfigurationResponse = z.infer<
  typeof ApplyAdministrationConfigurationResponseSchema
>;
