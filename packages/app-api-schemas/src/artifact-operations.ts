import {
  ArtifactIdSchema,
  GetArtifactResponseSchema,
  ListArtifactsResponseSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  ArtifactFolderSnapshotResponseSchema,
  ImportWorkspaceArtifactRequestSchema,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactRequestSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  ListArtifactReviewsResponseSchema,
  SelectArtifactReviewCandidateRequestSchema,
  SelectArtifactReviewCandidateResponseSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
} from './material.js';
import type { OperationDefinition } from './operation-contract.js';

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

const workspaceSelector = { workspaceId: WorkspaceIdSchema };
const threadSelector = { ...workspaceSelector, threadId: ThreadIdSchema };

/** Sole public contracts for Artifact inventory, immutable content, import, introduction and version-owned Review decisions. */
export const ARTIFACT_OPERATION_DEFINITIONS = {
  'artifact.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List visible submitted outputs and directly imported files.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: ListArtifactsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one Artifact descriptor and immutable origin.',
    inputSchema: z.object({ ...workspaceSelector, artifactId: ArtifactIdSchema }).strict(),
    outputSchema: GetArtifactResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.import': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    description: 'Import one immutable Workspace Artifact version.',
    inputSchema: ImportWorkspaceArtifactRequestSchema.safeExtend({ ...workspaceSelector }),
    outputSchema: ImportWorkspaceArtifactResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.write',
    mutating: true,
    successStatus: 201,
  },
  'artifact.download': {
    binding: 'streaming',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Download the exact original bytes of one immutable Artifact version.',
    inputSchema: z
      .object({
        ...workspaceSelector,
        artifactId: ArtifactIdSchema,
        artifactVersion: z.number().int().positive(),
      })
      .strict(),
    outputSchema: z.unknown(),
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.folder-read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read a verified paged folder inventory.',
    inputSchema: z
      .object({
        ...workspaceSelector,
        artifactId: ArtifactIdSchema,
        artifactVersion: z.number().int().positive(),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    outputSchema: ArtifactFolderSnapshotResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.folder-extract': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Explicitly extract a bounded ZIP folder snapshot; preserve the original.',
    inputSchema: z
      .object({
        ...workspaceSelector,
        artifactId: ArtifactIdSchema,
        artifactVersion: z.number().int().positive(),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    outputSchema: ArtifactFolderSnapshotResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: true,
  },
  'artifact.introduce': {
    binding: 'json',
    returnsOneTimeSecret: false,
    description: 'Introduce one exact imported Artifact version into an idle Thread.',
    inputSchema: IntroduceWorkspaceArtifactRequestSchema.extend({
      ...threadSelector,
      artifactId: ArtifactIdSchema,
    }),
    outputSchema: IntroduceWorkspaceArtifactResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'artifact.write',
    mutating: true,
    successStatus: 201,
  },
  'artifact.review-list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List version-keyed Reviews for one visible Artifact.',
    inputSchema: z.object({ ...workspaceSelector, artifactId: ArtifactIdSchema }).strict(),
    outputSchema: ListArtifactReviewsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'artifact.read',
    mutating: false,
  },
  'artifact.review.select': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Record an attributable choice of one exact available Artifact candidate.',
    inputSchema: SelectArtifactReviewCandidateRequestSchema.extend({
      ...workspaceSelector,
      artifactId: ArtifactIdSchema,
      artifactVersion: z.number().int().positive(),
    }),
    outputSchema: SelectArtifactReviewCandidateResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'review.apply',
    mutating: true,
  },
  'artifact.review.decide': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Decide one exact version-owned Artifact Review.',
    inputSchema: SubmitArtifactReviewDecisionRequestSchema.safeExtend({
      ...workspaceSelector,
      artifactId: ArtifactIdSchema,
      artifactVersion: z.number().int().positive(),
    }),
    outputSchema: SubmitArtifactReviewDecisionResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'review.apply',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
