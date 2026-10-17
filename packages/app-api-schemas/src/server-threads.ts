import {
  KnowledgeMaintenanceOutcomeSchema,
  RequestIdSchema,
  ServerThreadSchema,
  ServerTurnSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { KnowledgeProposalReviewSchema } from './action-center.js';
import { KnowledgeMaintainRequestSchema, KnowledgeTellRequestSchema } from './knowledge-agent.js';
import {
  KnowledgeManagerDraftedProposalSchema,
  validKnowledgeProposalShape,
} from './knowledge-manager.js';
import {
  ReadKnowledgeProposalRequestSchema,
  ReadKnowledgeProposalResponseSchema,
} from './knowledge-proposal-preview.js';

/** Server ownership comes from current administration admission, never a Workspace selector. */
export const ServerKnowledgeMaintainRequestSchema = KnowledgeMaintainRequestSchema.omit({
  workspaceId: true,
});
/** Explicit information supplied to the Server notebook; Workers retain their Workspace-only entry. */
export const ServerKnowledgeTellRequestSchema = KnowledgeTellRequestSchema.omit({
  workspaceId: true,
});
/** General Server Thread history retains the same Turn and Item families without a Workspace anchor. */
export const ReadServerThreadRequestSchema = z.object({ threadId: ThreadIdSchema }).strict();
export const ReadServerThreadResponseSchema = z
  .object({ thread: ServerThreadSchema, turns: z.array(ServerTurnSchema) })
  .strict();
export const ListServerThreadsResponseSchema = z
  .object({ items: z.array(ServerThreadSchema) })
  .strict();
export const InterruptServerTurnRequestSchema = z.object({ turnId: TurnIdSchema }).strict();
export const InterruptServerTurnResponseSchema = z
  .object({ turnId: TurnIdSchema, interrupted: z.boolean() })
  .strict();

/** Existing Knowledge Proposal core with its Server owner replacing the Workspace selector. */
const { workspaceId: _proposalWorkspace, ...proposalShape } =
  KnowledgeManagerDraftedProposalSchema.shape;
export const ServerKnowledgeProposalSchema = z
  .object({ ...proposalShape, ownerScope: z.object({ kind: z.literal('server') }).strict() })
  .strict()
  .refine(validKnowledgeProposalShape, 'A Proposal requires one complete candidate.');
/** Existing human Review core for the same exact Server candidate. */
const { workspaceId: _reviewWorkspace, ...reviewShape } = KnowledgeProposalReviewSchema.shape;
export const ServerKnowledgeReviewSchema = z
  .object({ ...reviewShape, ownerScope: z.object({ kind: z.literal('server') }).strict() })
  .strict()
  .refine(
    (value) => (value.knowledgePageId !== undefined) !== (value.changedPageIds !== undefined),
    'A Review requires one complete candidate.'
  );
const { workspaceId: _previewWorkspace, ...previewShape } =
  ReadKnowledgeProposalRequestSchema.shape;
export const ReadServerKnowledgeProposalRequestSchema = z
  .object({ ...previewShape, proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/) })
  .strict()
  .refine(({ path, offset }) => path !== undefined || offset === 0, 'An offset requires a path.');
export const ReadServerKnowledgeProposalResponseSchema = ReadKnowledgeProposalResponseSchema;
export const DecideServerKnowledgeProposalRequestSchema = z
  .object({
    proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
    requestId: RequestIdSchema,
    proposalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    baseRevision: z.string().min(1),
    candidateRevision: z.string().min(1),
    decision: z.enum(['accepted', 'rejected', 'deferred']),
  })
  .strict();
export const DecideServerKnowledgeProposalResponseSchema = z
  .object({
    review: ServerKnowledgeReviewSchema,
    notebookRevision: z.string().min(1).nullable(),
  })
  .strict();

/** Only current Server administration credentials can enter these native operations. */
const credentials = ['local-user', 'deployment-administrator'] as const;
const scope = { kind: 'server' } as const;
const target = { kind: 'server' } as const;
const common = {
  binding: 'json',
  returnsOneTimeSecret: false,
  successStatus: 200,
  credentials,
  scope,
  target,
} as const;
/** Additive entries in the existing operation catalog; no tool aliases or separate registry. */
export const SERVER_THREAD_OPERATION_DEFINITIONS = {
  'knowledge.server.maintain': {
    ...common,
    description: 'Request one bounded Server Knowledge maintenance run.',
    inputSchema: ServerKnowledgeMaintainRequestSchema,
    outputSchema: KnowledgeMaintenanceOutcomeSchema,
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'knowledge.server.tell': {
    ...common,
    description: 'Give explicit information to the Server Knowledge Manager.',
    inputSchema: ServerKnowledgeTellRequestSchema,
    outputSchema: KnowledgeMaintenanceOutcomeSchema,
    policyOperation: 'knowledge.write',
    mutating: true,
  },
  'thread.server.list': {
    ...common,
    description: 'List Server-owned work visible to current Server administrators.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListServerThreadsResponseSchema,
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.server.read': {
    ...common,
    description: 'Read one Server-owned Thread and its retained work.',
    inputSchema: ReadServerThreadRequestSchema,
    outputSchema: ReadServerThreadResponseSchema,
    policyOperation: 'thread.read',
    mutating: false,
  },
  'turn.server.interrupt': {
    ...common,
    description: 'Stop one active Server Knowledge Manager Turn.',
    inputSchema: InterruptServerTurnRequestSchema,
    outputSchema: InterruptServerTurnResponseSchema,
    policyOperation: 'turn.run',
    mutating: true,
  },
  'knowledge.server.proposal.read': {
    ...common,
    description: 'Read the exact Server notebook candidate and its review diff.',
    inputSchema: ReadServerKnowledgeProposalRequestSchema,
    outputSchema: ReadServerKnowledgeProposalResponseSchema,
    policyOperation: 'knowledge.read',
    mutating: false,
  },
  'knowledge.server.proposal.decide': {
    ...common,
    description: 'Review the exact fixed-base Server notebook candidate.',
    inputSchema: DecideServerKnowledgeProposalRequestSchema,
    outputSchema: DecideServerKnowledgeProposalResponseSchema,
    policyOperation: 'review.apply',
    mutating: true,
  },
} as const;
