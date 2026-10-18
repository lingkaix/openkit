import { PolicyDocumentV1Schema, PolicyWriteProposalV1Schema } from '@openkit/protocol';
import {
  AgentSessionIdSchema,
  ArtifactIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

import { SubmitConversationResponseSchema } from './chat-mode.js';

/** Request body for one turn in the current user's private administration entry. */
export const SubmitAdministrationConversationRequestSchema = z
  .object({
    input: z.string().min(1),
    logicalModelId: z.string().min(1).optional(),
    requestId: RequestIdSchema,
    threadId: ThreadIdSchema.optional(),
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
    artifactId: ArtifactIdSchema,
    artifactVersion: z.literal(1),
    contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

/** Bounded catalog draft; the target's registered configuration schema validates changes. */
const CatalogConfigurationProposalSchema = z
  .object({
    targetFamily: z.enum(['gateway', 'provider']),
    targetId: z.string().min(1),
    expectedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    changes: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Exact retained terminal Turn; NanoCore verifies its audience and immutable AEP lineage. */
export const ConfigurationGitFailureRefSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
  })
  .strict();

/** Only existing REST Git-read rules are eligible; endpoint and authority fields are absent. */
export const WorkerGitReadConfigurationProposalSchema = z
  .object({
    targetFamily: z.literal('agent'),
    targetId: z.string().min(1),
    expectedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    failure: ConfigurationGitFailureRefSchema,
    changes: z
      .object({
        networkGrantId: z.string().min(1),
        rules: z
          .array(
            z
              .object({
                method: z.enum(['GET', 'POST']),
                path: z.string().startsWith('/').min(1),
              })
              .strict()
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

/** Only the registered Policy section is proposed; paths and unrelated server fields are absent. */
const PolicyConfigurationProposalSchema = z.object({
  targetFamily: z.literal('policy'),
  targetId: z.literal('server'),
  expectedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  changes: z.object({ proposed: PolicyDocumentV1Schema, rationale: z.string().min(1) }).strict(),
}).strict();

/** Closed registered target families admitted by the configuration proposal owner. */
export const ProposeAdministrationConfigurationRequestSchema = z.discriminatedUnion(
  'targetFamily',
  [CatalogConfigurationProposalSchema, WorkerGitReadConfigurationProposalSchema, PolicyConfigurationProposalSchema]
);

const CandidateFields = {
  kind: z.literal('administration-configuration-candidate'),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  restartRequired: z.boolean(),
  command: z.literal('administration.configuration.apply'),
  operation: z.literal('update'),
};

/** Immutable private candidate with server-derived retained failure evidence for Worker repairs. */
export const ConfigurationCandidateArtifactSchema = z.discriminatedUnion('targetFamily', [
  PolicyConfigurationProposalSchema.extend({ ...CandidateFields, policyProposal: PolicyWriteProposalV1Schema }).strict(),
  CatalogConfigurationProposalSchema.extend(CandidateFields).strict(),
  WorkerGitReadConfigurationProposalSchema.extend({
    ...CandidateFields,
    failureEvidence: z
      .object({
        agentSessionId: AgentSessionIdSchema,
        snapshotId: z.string().min(1),
        snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
        repositoryInputId: z.string().min(1),
        explanationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
  }).strict(),
]);

/** Fixed private Tool input; current invocation and Policy authority are server-derived. */
export const ApplyDelegatedAdministrationConfigurationRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    candidate: ConfigurationCandidateRefSchema,
  })
  .strict();

/** Exact catalog preview; configuration authority remains with the server owner. */
export type ConfigurationCandidateArtifact = z.infer<typeof ConfigurationCandidateArtifactSchema>;

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
    candidate: ConfigurationCandidateRefSchema.strip(),
    persisted: z.boolean(),
    revision: z.string().nullable(),
    reload: z.enum(['applied', 'rejected', 'failed', 'not-attempted']),
    restartRequired: z.boolean(),
  })
  .strip();

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
