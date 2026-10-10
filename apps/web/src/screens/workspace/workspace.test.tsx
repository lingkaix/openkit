import { KnowledgeDerivedIndexesResponseSchema, operationHttpPath } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';
import { workspaceKeys } from './data';
import knowledgeDataSource from './data.ts?raw';
import knowledgeScreenSource from './KnowledgeScreen.tsx?raw';

const TIMESTAMP_OLD = '2026-07-21T10:00:00.000Z';
const TIMESTAMP_NEW = '2026-07-21T11:00:00.000Z';
const WORKSPACE_COUNTS = {
  threadCount: 0,
  artifactCount: 0,
  knowledgeEntryCount: 0,
} as const;
const WORKSPACE_A = {
  id: 'ws1',
  name: 'Market research',
  kind: 'general',
  status: 'active',
  counts: WORKSPACE_COUNTS,
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_NEW,
} as const;
const WORKSPACE_B = {
  id: 'ws2',
  name: 'Second workspace',
  kind: 'general',
  status: 'active',
  counts: WORKSPACE_COUNTS,
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_NEW,
} as const;

const APPROVAL_ROW = {
  id: 'approval:ap1',
  kind: 'approval',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 't1',
  itemId: 'i1',
  title: 'Scout asks to sign in to the vendor portal',
  summary: 'To pull competitor pricing.',
  severity: 'needs_input',
  createdAt: TIMESTAMP_OLD,
  recommendedAction: 'Review and respond to the approval request.',
  source: {
    type: 'approval',
    approvalRequestId: 'ap1',
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    itemId: 'i1',
  },
  actions: [
    {
      kind: 'grant_approval',
      label: 'Approve',
      method: 'POST',
      href: operationHttpPath('approval.respond'),
    },
    {
      kind: 'deny_approval',
      label: 'Skip',
      method: 'POST',
      href: operationHttpPath('approval.respond'),
    },
    { kind: 'open_thread', label: 'Open', method: 'GET', href: '/api/workspaces/ws1/threads/th1' },
  ],
};

const OPEN_ONLY_ROW = {
  id: 'question:q1',
  kind: 'question',
  workspaceId: 'ws1',
  threadId: 'th2',
  turnId: 't2',
  itemId: 'i2',
  title: 'Answer required',
  summary: 'Which market segment should we prioritize?',
  severity: 'needs_input',
  createdAt: TIMESTAMP_NEW,
  recommendedAction: 'Answer the question before the worker can continue.',
  source: {
    type: 'protocol_item',
    itemType: 'user-input-request',
    workspaceId: 'ws1',
    threadId: 'th2',
    turnId: 't2',
    itemId: 'i2',
  },
  actions: [
    {
      kind: 'answer_question',
      label: 'Answer',
      method: 'POST',
      href: '/api/app/operations/question.answer',
    },
    { kind: 'open_thread', label: 'Open', method: 'GET', href: '/api/workspaces/ws1/threads/th2' },
  ],
};

const ARTIFACT_INSPECTION_ROW = {
  id: 'artifact-review:rev1',
  kind: 'artifact_review',
  workspaceId: 'ws1',
  threadId: 'th_goal',
  title: 'Review worker output',
  artifactId: 'ar1',
  artifactVersion: 1,
  summary: 'Inspect this exact Artifact version before choosing a verdict.',
  severity: 'needs_input',
  createdAt: TIMESTAMP_OLD,
  recommendedAction: 'Inspect this exact Artifact version through its owning API.',
  source: {
    type: 'artifact_review',
    reviewId: 'rev1',
    artifactId: 'ar1',
    artifactVersion: 1,
    workspaceId: 'ws1',
    threadId: 'th_goal',
  },
  actions: [
    {
      kind: 'open_artifact',
      label: 'Open artifact',
      method: 'POST',
      href: '/api/app/operations/artifact.read',
    },
  ],
};

const DISABLED_APPROVAL_ROW = {
  ...APPROVAL_ROW,
  id: 'approval:ap_disabled',
  title: 'Read-only approval',
  source: {
    ...APPROVAL_ROW.source,
    approvalRequestId: 'ap_disabled',
  },
  actions: APPROVAL_ROW.actions.map((action) =>
    action.kind === 'grant_approval' || action.kind === 'deny_approval'
      ? { ...action, disabled: true, reason: 'Viewer cannot decide this approval.' }
      : action
  ),
};

const AGENT_READY = {
  id: 'agent_ledger',
  name: 'Ledger',
  kind: 'researcher',
  status: 'enabled',
  modelId: 'gpt-test',
  skillIds: [],
  profiles: [],
  defaultProfileId: null,
  capabilities: [{ id: 'tables', label: 'Tables', description: 'Organize numbers' }],
  sandboxSummary: null,
  health: { status: 'ready', message: 'Healthy', checkedAt: TIMESTAMP_NEW },
};

const AGENT_WORKING = {
  id: 'agent_scout',
  name: 'Scout',
  kind: 'researcher',
  status: 'enabled',
  modelId: null,
  skillIds: [],
  profiles: [],
  defaultProfileId: null,
  capabilities: [],
  sandboxSummary: { access: 'read-only', workspaceRootRefs: [], summary: 'Read-only sandbox' },
  health: { status: 'running', message: 'Summarizing interviews', checkedAt: TIMESTAMP_NEW },
};

const AGENT_CODEX = {
  id: 'agent_codex',
  name: 'Codex Agent',
  kind: null,
  status: 'enabled',
  modelId: null,
  skillIds: [],
  profiles: [],
  defaultProfileId: null,
  capabilities: [],
  sandboxSummary: null,
  health: { status: 'unknown', message: null, checkedAt: null },
};

const AGENT_DETAIL = {
  ...AGENT_READY,
  modelId: 'gpt-authoritative',
  health: { status: 'ready', message: 'Authoritative health', checkedAt: TIMESTAMP_NEW },
};

/** Builds one Worker row matching WorkspaceWorkersResponseSchema. */
function workspaceWorker(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'th_worker',
    threadTitle: 'Implement inventory',
    agentId: 'agent_ledger',
    agentName: 'Ledger',
    status: 'busy',
    recordUpdatedAt: TIMESTAMP_NEW,
    stale: false,
    work: {
      kind: 'goal',
      turnId: 'turn_worker',
      goalId: 'goal_worker',
      taskId: 'task_worker',
    },
    packageDetails: {
      kind: 'available',
      preferredLogicalModelId: 'openai/gpt-preferred',
      mcpServers: [
        {
          id: 'github',
          allowedTools: ['list_issues'],
          deniedTools: ['delete_repo'],
          approvalRequiredTools: ['create_issue'],
        },
      ],
      filesystem: { default: 'deny', enforcement: 'openshell', ruleCount: 1 },
      network: { default: 'deny', enforcement: 'openshell', ruleCount: 0 },
      process: null,
    },
    lastUsedModel: {
      kind: 'available',
      modelId: 'openai/gpt-last-used',
      recordedAt: TIMESTAMP_NEW,
    },
    ...overrides,
  };
}

const KNOWLEDGE_ENTRY = {
  id: 'mem1',
  kind: 'preference',
  title: 'Write in English; keep answers concise',
  content: 'Prefer short replies.',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const UPDATED_KNOWLEDGE_ENTRY = {
  ...KNOWLEDGE_ENTRY,
  title: 'Server-confirmed concise writing',
  content: 'Use the canonical server wording.',
  updatedAt: TIMESTAMP_NEW,
};

const KNOWLEDGE_ENTRY_B = {
  ...KNOWLEDGE_ENTRY,
  id: 'mem_b',
  title: 'Workspace B preference',
  content: 'B must keep its own knowledge bytes.',
};

const KNOWLEDGE_SOURCE = {
  id: 'ks_source',
  workspaceId: 'ws1',
  kind: 'transcript',
  title: 'Customer interview Q3',
  uri: null,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  originatingThreadId: 'th1',
  originatingTurnId: 't1',
  originatingFileId: 'file1',
  capturedAt: TIMESTAMP_OLD,
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_OBSERVATION = {
  id: 'ko_observation',
  workspaceId: 'ws1',
  kind: 'user-feedback',
  summary: 'Customers repeatedly ask for shorter weekly updates.',
  sourceReferences: [],
  scope: 'workspace',
  producer: 'user:test',
  confidence: 0.8,
  freshness: 'current',
  status: 'retained',
  observedAt: TIMESTAMP_OLD,
  createdAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_CLAIM = {
  id: 'kc_claim',
  workspaceId: 'ws1',
  statement: 'Weekly updates should fit on one screen.',
  sourceReferences: [],
  scope: 'workspace',
  producer: 'user:test',
  confidence: 0.7,
  freshness: 'current',
  reviewState: 'needs-review',
  conflictStatus: 'weak_evidence',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_DIGEST = KNOWLEDGE_SOURCE.contentDigest;
const KNOWLEDGE_PAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const RETRIEVAL_TRACE_ID = 'krt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RETRIEVAL_REQUEST_DIGEST = `sha256:${'c'.repeat(64)}`;
const RETRIEVAL_QUERY = 'weekly updates';
const MANAGER_QUESTION = 'How long should weekly updates be?';
const CONFLICT_RESOLUTION = 'The one-screen weekly update claim is authoritative.';
const CONFLICT_SUMMARY = 'Interview notes disagree about update length.';

const REGISTER_SOURCE_INPUT = {
  kind: 'code',
  title: 'Q3 interview transcript',
  content: 'Customers asked for shorter weekly updates.',
} as const;
const NEXT_REGISTER_SOURCE_INPUT = {
  kind: 'document',
  title: 'Follow-up brief',
  content: 'Later notes ask for a one-page weekly digest.',
} as const;
const WORKSPACE_B_SOURCE_DRAFT = {
  title: 'Workspace B source draft',
  content: 'Workspace B source bytes that must survive A settlement.',
} as const;
const SOURCE_KIND_OPTION = 'Code';
const NEXT_SOURCE_KIND_OPTION = 'Document';
const OBSERVATION_KIND = 'agent';
const OBSERVATION_KIND_OPTION = 'Agent';
const NEXT_OBSERVATION_KIND = 'retrieval';
const NEXT_OBSERVATION_KIND_OPTION = 'Retrieval';
const NEXT_OBSERVATION = {
  summary: 'Later retrieval saw a one-page digest request.',
  producer: 'user:follow-up',
} as const;
const NEXT_CLAIM = {
  statement: 'The digest should stay on one page.',
  producer: 'user:follow-up',
} as const;
const NEXT_CONFLICT_INPUT = {
  summary: 'Later notes disagree about digest length.',
  subjectReferences: ['knowledge:mem2', 'claim:kc_later'],
  producer: 'user:follow-up',
} as const;
const NEXT_RESOLUTION = {
  resolution: 'Keep the later one-page digest as the working rule.',
  resolvedBy: 'user:follow-up',
} as const;

const REGISTERED_SOURCE = {
  ...KNOWLEDGE_SOURCE,
  id: 'ks_registered',
  kind: REGISTER_SOURCE_INPUT.kind,
  title: REGISTER_SOURCE_INPUT.title,
  updatedAt: TIMESTAMP_NEW,
};
const SERVER_OBSERVATION = {
  ...KNOWLEDGE_OBSERVATION,
  id: 'ko_server',
  kind: OBSERVATION_KIND,
  summary: 'Server-confirmed shorter weekly updates.',
};
const SERVER_CLAIM = {
  ...KNOWLEDGE_CLAIM,
  id: 'kc_server',
  statement: 'Server-confirmed weekly updates fit on one screen.',
};

const SOURCE_DERIVED_REPRESENTATION = {
  id: 'ks_source:text',
  workspaceId: 'ws1',
  sourceId: KNOWLEDGE_SOURCE.id,
  kind: 'text',
  path: 'sources/derived/ks_source/text.json',
  materialPath: 'sources/materials/ks_source/content.txt',
  contentDigest: KNOWLEDGE_DIGEST,
  sourceContentDigest: KNOWLEDGE_DIGEST,
  createdAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_CONFLICT = {
  id: 'kf_conflict',
  workspaceId: 'ws1',
  subjectReferences: ['knowledge:mem1', 'claim:kc_claim'],
  sourceReferences: ['source:ks_source'],
  status: 'conflicting',
  summary: 'Weekly-update length has contradictory evidence.',
  suggestedActions: [],
  producer: 'user:test',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const RESOLVED_KNOWLEDGE_CONFLICT = {
  ...KNOWLEDGE_CONFLICT,
  status: 'resolved',
  resolution: CONFLICT_RESOLUTION,
  resolvedAt: TIMESTAMP_NEW,
  resolvedBy: 'user:test',
  updatedAt: TIMESTAMP_NEW,
};
const SERVER_CONFLICT = {
  ...KNOWLEDGE_CONFLICT,
  id: 'kf_server',
  summary: 'Server-confirmed contradictory weekly-update evidence.',
};
const SECOND_CONFLICT = {
  ...KNOWLEDGE_CONFLICT,
  id: 'kf_second',
  summary: 'A later conflict about citation freshness.',
};
const SERVER_RESOLVED_CONFLICT = {
  ...RESOLVED_KNOWLEDGE_CONFLICT,
  resolution: 'Server-confirmed one-screen weekly update is authoritative.',
};

/** Builds one schema-valid KnowledgeIndexes response owned by the named Workspace. */
function knowledgeIndexesFor(
  workspaceId: string,
  options: {
    rebuiltAt?: string;
    term?: string;
    edges?: Array<{ fromId: string; target: string; toId: string; resolved: boolean }>;
    records?: Array<{
      conceptId: string;
      path: string;
      title?: string;
      conformance: 'Workspace-schema-valid';
      active: boolean;
      indexed: boolean;
      errors: unknown[];
    }>;
    references?: Array<{
      conceptId: string;
      path: string;
      reference: string;
      kind: 'registered-source';
      targetId: string;
      resolved: boolean;
    }>;
  } = {}
) {
  const rebuiltAt = options.rebuiltAt ?? TIMESTAMP_OLD;
  return KnowledgeDerivedIndexesResponseSchema.parse({
    linkGraph: {
      schemaVersion: 1,
      workspaceId,
      rebuiltAt,
      edges: options.edges ?? [],
    },
    validation: {
      schemaVersion: 1,
      workspaceId,
      rebuiltAt,
      records: options.records ?? [],
    },
    sourceReferences: {
      schemaVersion: 1,
      workspaceId,
      rebuiltAt,
      references: options.references ?? [],
    },
    fullText: {
      schemaVersion: 1,
      workspaceId,
      rebuiltAt,
      tokenizer: 'unicode-simple-v1',
      terms: options.term
        ? [
            {
              term: options.term,
              postings: [{ conceptId: 'mem1', fields: ['body'], occurrences: 1 }],
            },
          ]
        : [],
    },
  });
}

const EMPTY_KNOWLEDGE_INDEXES = knowledgeIndexesFor(WORKSPACE_A.id);

const KNOWLEDGE_INDEXES = knowledgeIndexesFor(WORKSPACE_A.id, {
  rebuiltAt: TIMESTAMP_NEW,
  term: 'weekly',
  edges: [{ fromId: 'weekly-updates', target: '/mem1.md', toId: 'mem1', resolved: true }],
  records: [
    {
      conceptId: KNOWLEDGE_ENTRY.id,
      path: 'knowledge/pages/mem1.md',
      title: KNOWLEDGE_ENTRY.title,
      conformance: 'Workspace-schema-valid',
      active: true,
      indexed: true,
      errors: [],
    },
  ],
  references: [
    {
      conceptId: KNOWLEDGE_ENTRY.id,
      path: 'knowledge/pages/mem1.md',
      reference: 'source:ks_source',
      kind: 'registered-source',
      targetId: KNOWLEDGE_SOURCE.id,
      resolved: true,
    },
  ],
});

const KNOWLEDGE_RETRIEVAL = {
  traceId: RETRIEVAL_TRACE_ID,
  workspaceId: 'ws1',
  caller: 'app-api',
  requestDigest: RETRIEVAL_REQUEST_DIGEST,
  retrievalParameters: { limit: 5, pinnedConceptIds: [] },
  createdAt: TIMESTAMP_NEW,
  selected: [
    {
      knowledgePageId: KNOWLEDGE_ENTRY.id,
      contentDigest: KNOWLEDGE_PAGE_DIGEST,
      score: 4,
      sourceReferences: ['source:ks_source'],
    },
  ],
  excluded: [
    {
      knowledgePageId: 'old-plan',
      contentDigest: null,
      reason: 'sensitive_content',
    },
  ],
};

const KNOWLEDGE_CONTEXT = {
  operationId: 'km_context',
  operation: 'prepare-context-material',
  workspaceId: 'ws1',
  caller: 'app-api',
  retrievalTraceId: RETRIEVAL_TRACE_ID,
  outcome: 'prepared',
  selected: KNOWLEDGE_RETRIEVAL.selected,
  excluded: KNOWLEDGE_RETRIEVAL.excluded,
};

const KNOWLEDGE_ANSWER = {
  operationId: 'km_answer',
  operation: 'answer',
  workspaceId: 'ws1',
  caller: 'app-api',
  retrievalTraceId: RETRIEVAL_TRACE_ID,
  query: MANAGER_QUESTION,
  outcome: 'answered',
  answer: 'Keep weekly updates to one screen.',
  citations: [
    {
      knowledgeEntryId: KNOWLEDGE_ENTRY.id,
      kind: 'preference',
      title: KNOWLEDGE_ENTRY.title,
      excerpt: KNOWLEDGE_ENTRY.content,
    },
  ],
  confidence: 0.75,
  uncertainty: null,
};

const KNOWLEDGE_REPAIR = {
  id: 'repair_duplicate_title_weekly_updates',
  kind: 'duplicate-title',
  title: 'Duplicate title: Weekly updates',
  detail: '2 knowledge entries share the same normalized title.',
  affectedKnowledgeEntryIds: ['mem1', 'mem2'],
  autoApplicable: false,
  reviewRequired: true,
};

const KNOWLEDGE_REPAIRS = {
  operationId: 'km_repair',
  operation: 'suggest-repair',
  workspaceId: 'ws1',
  caller: 'app-api',
  outcome: 'suggested',
  suggestions: [KNOWLEDGE_REPAIR],
};

const KNOWLEDGE_HEALTH = {
  operationId: 'km_health',
  operation: 'health-check',
  workspaceId: 'ws1',
  caller: 'app-api',
  outcome: 'needs-attention',
  summary: 'Knowledge Manager found 1 repair suggestion.',
  checks: [
    {
      code: 'knowledge-present',
      status: 'pass',
      detail: '1 knowledge entry is available.',
    },
    {
      code: 'repair-suggestions',
      status: 'warn',
      detail: '1 review-required repair suggestion was found.',
    },
  ],
  repairSuggestions: [KNOWLEDGE_REPAIR],
};

const KNOWLEDGE_PROPOSAL_ROW = {
  id: 'non-authoritative-wrapper-id',
  kind: 'knowledge_review',
  workspaceId: 'non-authoritative-wrapper-workspace',
  title: 'Review knowledge proposal for writing/weekly-updates',
  summary: 'Keep weekly updates concise and source-linked.',
  severity: 'needs_input',
  createdAt: TIMESTAMP_OLD,
  recommendedAction: 'Accept, reject, or defer the knowledge proposal.',
  source: {
    type: 'knowledge',
    knowledgeProposalId: 'kp_exact',
    workspaceId: 'ws1',
    status: 'pending',
  },
  actions: [
    { kind: 'accept_knowledge', label: 'Accept', method: 'POST' },
    { kind: 'reject_knowledge', label: 'Reject', method: 'POST' },
    { kind: 'defer', label: 'Defer', method: 'POST' },
  ],
};

const KNOWLEDGE_PROPOSAL_ROW_B = {
  ...KNOWLEDGE_PROPOSAL_ROW,
  id: 'proposal-b',
  title: 'Review knowledge proposal for workspace B',
  source: {
    ...KNOWLEDGE_PROPOSAL_ROW.source,
    knowledgeProposalId: 'kp_b',
    workspaceId: WORKSPACE_B.id,
  },
};

const NON_KNOWLEDGE_PROPOSAL_DECOY = {
  ...KNOWLEDGE_PROPOSAL_ROW,
  id: 'non-knowledge-decoy',
  title: 'Non-knowledge proposal decoy',
  source: APPROVAL_ROW.source,
};

type MethodOverrides = Partial<Record<string, unknown>>;

/** Creates a caller-controlled promise for proving pre-settlement UI state. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(
  overrides: { operations?: MethodOverrides; core?: MethodOverrides; app?: MethodOverrides } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),

      ...overrides.core,
    },
    app: { ...overrides.app },
    operations: {
      'worker.list': vi
        .fn()
        .mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
          workspaceId,
          items: [],
        })),
      'agent.list': vi.fn().mockResolvedValue({ items: [] }),
      'agent.read': vi.fn().mockResolvedValue(AGENT_READY),
      'agent.health-refresh': vi.fn().mockResolvedValue({ items: [] }),
      'catalog.read': vi
        .fn()
        .mockResolvedValue({ revision: 1, candidates: [], skills: [], mcp: [], plugins: [] }),
      'catalog.skill-import': vi.fn(),
      'catalog.skill-pin': vi.fn(),
      'catalog.skill-candidate-submit': vi.fn(),
      'catalog.skill-candidate-decide': vi.fn(),
      'catalog.skill-select': vi.fn(),
      'catalog.mcp-create': vi.fn(),
      'catalog.mcp-select': vi.fn(),
      'catalog.mcp-binding': vi.fn(),
      'catalog.plugin-import': vi.fn(),
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'workspace.create': vi.fn().mockResolvedValue({
        id: 'ws-new',
        name: 'New workspace',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: TIMESTAMP_NEW,
        updatedAt: TIMESTAMP_NEW,
      }),
      'workspace.dashboard': vi.fn().mockResolvedValue({
        workspace: { id: WORKSPACE_A.id, name: WORKSPACE_A.name },
        counts: {
          threadCount: 2,
          artifactCount: 0,
          knowledgeEntryCount: 0,
          providerCount: 1,
        },
        defaultContext: { agentId: null },
        agentHealth: [],
        recentThreads: [],
        activeWork: [
          {
            threadId: 'th1',
            title: 'Competitive pricing report',
            status: 'running',
            mode: 'goal',
            agentId: 'agent_scout',
            summary: '4 of 6 steps moving',
            updatedAt: TIMESTAMP_NEW,
          },
        ],
        recentCompletions: [],
        attentionNeeded: [],
      }),
      'approval.respond': vi.fn().mockResolvedValue({}),
      'pending-request.withdraw': vi.fn().mockResolvedValue({}),
      'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),
      'attention.list': vi.fn().mockResolvedValue({ items: [] }),
      'artifact.review.decide': vi.fn().mockResolvedValue({}),
      'knowledge.list': vi.fn().mockResolvedValue({ items: [] }),
      'knowledge.create': vi.fn().mockResolvedValue(KNOWLEDGE_ENTRY),
      'knowledge.update': vi.fn().mockResolvedValue(UPDATED_KNOWLEDGE_ENTRY),
      'knowledge.delete': vi.fn().mockResolvedValue(undefined),
      'knowledge.source.list': vi.fn().mockResolvedValue({ items: [] }),
      'knowledge.observation.list': vi.fn().mockResolvedValue({ items: [] }),
      'knowledge.claim.list': vi.fn().mockResolvedValue({ items: [] }),
      'knowledge.conflict.list': vi.fn().mockResolvedValue({ items: [] }),
      'knowledge.indexes': vi.fn().mockResolvedValue(EMPTY_KNOWLEDGE_INDEXES),
      'knowledge.source.register': vi.fn(),
      'knowledge.source.read': vi.fn(),
      'knowledge.observation.record': vi.fn(),
      'knowledge.claim.record': vi.fn(),
      'knowledge.conflict.record': vi.fn(),
      'knowledge.conflict.resolve': vi.fn(),
      'knowledge.retrieval': vi.fn(),
      'knowledge.context.prepare': vi.fn(),
      'knowledge.answer': vi.fn(),
      'knowledge.proposal.draft': vi.fn(),
      'knowledge.repair.suggest': vi.fn(),
      'knowledge.health.check': vi.fn(),
      'knowledge.proposal.reverse': vi.fn(),
      'knowledge.proposal.decide': vi.fn().mockResolvedValue({}),
      ...overrides.core,
      ...overrides.app,
      'workspace.resources': vi.fn().mockImplementation(async () => {
        const listAgents = overrides.operations?.['agent.list'] as
          | CoreClient['operations']['agent.list']
          | undefined;
        const listed = overrides.operations?.['agent.list']
          ? await listAgents?.({})
          : { items: [] };
        return {
          knowledge: [],
          skills: [],
          agents: listed && typeof listed === 'object' && 'items' in listed ? listed.items : [],
          models: [],
        };
      }),
      'thread.dashboard': vi.fn().mockResolvedValue({
        pendingRequests: ['ap1', 'ap2', 'ap_disabled'].map((requestId) => ({
          requestId,
          state: 'pending',
          canRespond: true,
          approvalEffect: {
            status: 'available',
            summary: 'Summary: One effect',
            detail: '{"effect":"complete"}',
          },
        })),
      }),
      ...overrides.operations,
      'workspace.list': vi
        .fn()
        .mockResolvedValueOnce({
          items: [WORKSPACE_A].map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        })
        .mockImplementation(
          (overrides.operations?.['workspace.list'] as
            | CoreClient['operations']['workspace.list']
            | undefined) ??
            vi.fn().mockResolvedValue({
              items: [WORKSPACE_A].map((workspace) => ({
                workspace,
                effectiveRole: 'owner',
                membershipRevision: 1,
                ownerUserId: 'user_local',
                registryRevision: 1,
              })),
            })
        ),
    },
  } as unknown as CoreClient;
}

/** Returns one labelled Knowledge product panel on the existing /knowledge surface. */
function knowledgePanel(name: 'Sources' | 'Ledger' | 'Retrieval' | 'Manager') {
  return screen.getByRole('region', { name });
}

/** Stops queued input after a test timeout before it can reach the next test's focused field. */
function setupKnowledgeUser(signal: AbortSignal) {
  return userEvent.setup({ advanceTimers: () => signal.throwIfAborted() });
}

/** Pastes Knowledge drafts into focused fields; these journeys assert values, not keystrokes. */
async function fillKnowledgeFields(
  user: ReturnType<typeof userEvent.setup>,
  region: HTMLElement,
  fields: ReadonlyArray<readonly [string, string]>
) {
  for (const [name, value] of fields) {
    const field = within(region).getByRole('textbox', { name });
    await user.clear(field);
    await user.paste(value);
  }
}

/** Selects one listed option from an accessible combobox or listbox trigger. */
async function selectListedOption(
  user: ReturnType<typeof userEvent.setup>,
  region: HTMLElement,
  name: string,
  option: string
) {
  const accessibleName = new RegExp(`${name}$`, 'i');
  const trigger =
    within(region)
      .queryAllByRole('button', { name: accessibleName })
      .find((button) => button.getAttribute('aria-haspopup') === 'listbox') ??
    within(region).getByRole('combobox', { name: accessibleName });
  await user.click(trigger);
  await user.click(
    within(await screen.findByRole('listbox')).getByRole('option', { name: option })
  );
}

/** Builds a private 403 that the product UI must not echo. */
function accessDenied(message: string) {
  return new ApiCallError(403, message, { code: 'workspace_access_denied' });
}

/** Builds a private 500 that the product UI must not echo. */
function operationFailed(message: string) {
  return new ApiCallError(500, message, { code: 'failed' });
}

/** Retries one scoped panel alert and proves it stays free of private server text. */
async function retryScopedAlert(
  user: ReturnType<typeof userEvent.setup>,
  region: HTMLElement,
  message: RegExp,
  privateText: string
) {
  const alert = await within(region).findByRole('alert');
  expect(alert).toHaveTextContent(message);
  expect(alert).not.toHaveTextContent(privateText);
  const retry = within(alert).getByRole('button', { name: /try again/i });
  expect(retry).toBeEnabled();
  await user.click(retry);
  return alert;
}

/** Reads the caller-supplied requestId from one mutating Core client call. */
function requestIdFromCall(call: unknown[] | undefined): string | undefined {
  for (const arg of call ?? []) {
    if (arg && typeof arg === 'object' && 'requestId' in arg) {
      const requestId = (arg as { requestId: unknown }).requestId;
      if (typeof requestId === 'string') return requestId;
    }
  }
  return undefined;
}

/** Proves a scoped panel alert cleared and an operation-specific authoritative value is visible. */
async function proveScopedRetrySettled(region: HTMLElement, result: string, echo?: string) {
  await waitFor(() => expect(within(region).queryByRole('alert')).not.toBeInTheDocument());
  expect(await within(region).findByText(result, { selector: ':not(option)' })).toBeInTheDocument();
  if (echo) expect(screen.queryByText(echo)).not.toBeInTheDocument();
}

const REQUIRED_KNOWLEDGE_OPERATION_HOOKS = [
  'useRegisterKnowledgeSource',
  'useReadKnowledgeSource',
  'useRecordKnowledgeObservation',
  'useRecordKnowledgeClaim',
  'useKnowledgeConflicts',
  'useRecordKnowledgeConflict',
  'useResolveKnowledgeConflict',
  'useKnowledgeIndexes',
  'useRetrieveKnowledge',
  'usePrepareKnowledgeContext',
  'useAnswerKnowledgeManager',
  'useSuggestKnowledgeRepairs',
  'useCheckKnowledgeHealth',
] as const;

const KNOWLEDGE_TYPED_WRITE_SLICES = [
  {
    typeName: 'RegisterKnowledgeSourceCommand',
    hookName: 'useRegisterKnowledgeSource',
    method: 'knowledge.source.register',
    inputIndex: 1,
  },
  {
    typeName: 'RecordKnowledgeObservationCommand',
    hookName: 'useRecordKnowledgeObservation',
    method: 'knowledge.observation.record',
    inputIndex: 1,
  },
  {
    typeName: 'RecordKnowledgeClaimCommand',
    hookName: 'useRecordKnowledgeClaim',
    method: 'knowledge.claim.record',
    inputIndex: 1,
  },
  {
    typeName: 'RecordKnowledgeConflictCommand',
    hookName: 'useRecordKnowledgeConflict',
    method: 'knowledge.conflict.record',
    inputIndex: 1,
  },
  {
    typeName: 'ResolveKnowledgeConflictCommand',
    hookName: 'useResolveKnowledgeConflict',
    method: 'knowledge.conflict.resolve',
    inputIndex: 2,
  },
] as const;

const KNOWLEDGE_DRAFT_WRITES = [
  { panel: 'Sources' as const, action: 'Register source' },
  { panel: 'Ledger' as const, action: 'Record observation' },
  { panel: 'Ledger' as const, action: 'Record claim' },
  { panel: 'Ledger' as const, action: 'Record conflict' },
  { panel: 'Ledger' as const, action: 'Resolve conflict' },
  { panel: 'Retrieval' as const, action: 'Retrieve' },
  { panel: 'Retrieval' as const, action: 'Prepare context' },
  { panel: 'Manager' as const, action: 'Answer' },
] as const;

/** Counts Core client calls issued for one Workspace identity. */
function callsOn(
  method: { mock: { calls: Array<Array<{ workspaceId: string }>> } },
  workspaceId: string
) {
  return method.mock.calls.filter(
    (call) =>
      (typeof call[0] === 'object' && call[0] !== null && 'workspaceId' in call[0]
        ? call[0].workspaceId
        : call[0]) === workspaceId
  );
}

/** Returns one exported Knowledge type or hook slice from workspace data.ts. */
function exportedKnowledgeSlice(name: string): string {
  const start = knowledgeDataSource.search(new RegExp(`export (?:type|function) ${name}\\b`));
  expect(start).toBeGreaterThan(-1);
  const from = knowledgeDataSource.slice(start);
  const next = from.slice(1).search(/\nexport /);
  return next === -1 ? from : from.slice(0, next + 1);
}

type KnowledgeAuthorityMode = 'switch' | 'remount';

/** Labels and payloads for one Knowledge authority generation on one Workspace. */
function knowledgeAuthorityCatalog(
  workspaceId: string,
  generation: number,
  mode: KnowledgeAuthorityMode
) {
  const later =
    mode === 'remount'
      ? {
          source: 'Source after remount',
          observation: 'Observation after remount',
          claim: 'Claim after remount',
          conflict: 'Conflict after remount',
          index: 'index-after-remount',
        }
      : {
          source: 'Source A reread',
          observation: 'Observation A reread',
          claim: 'Claim A reread',
          conflict: 'Conflict A reread',
          index: 'index-a-reread',
        };
  const current =
    workspaceId === WORKSPACE_B.id
      ? {
          source: 'Source B',
          observation: 'Observation B',
          claim: 'Claim B',
          conflict: 'Conflict B',
          index: 'index-b',
        }
      : generation === 0
        ? {
            source: KNOWLEDGE_SOURCE.title,
            observation: KNOWLEDGE_OBSERVATION.summary,
            claim: KNOWLEDGE_CLAIM.statement,
            conflict: KNOWLEDGE_CONFLICT.summary,
            index: 'weekly',
          }
        : later;
  return {
    current,
    sources: {
      items: [
        {
          ...KNOWLEDGE_SOURCE,
          workspaceId,
          id: `ks_${workspaceId}_${generation}`,
          title: current.source,
        },
      ],
    },
    observations: {
      items: [
        {
          ...KNOWLEDGE_OBSERVATION,
          workspaceId,
          id: `ko_${workspaceId}_${generation}`,
          summary: current.observation,
        },
      ],
    },
    claims: {
      items: [
        {
          ...KNOWLEDGE_CLAIM,
          workspaceId,
          id: `kc_${workspaceId}_${generation}`,
          statement: current.claim,
        },
      ],
    },
    conflicts: {
      items: [
        {
          ...KNOWLEDGE_CONFLICT,
          workspaceId,
          id: `kf_${workspaceId}_${generation}`,
          summary: current.conflict,
        },
      ],
    },
    indexes: knowledgeIndexesFor(workspaceId, { term: current.index }),
  };
}

/** Installs generation-aware Knowledge catalog reads for revisit and remount. */
function knowledgeAuthorityReads(mode: KnowledgeAuthorityMode) {
  const generation = { current: 0 };
  const catalog = (workspaceId: string) =>
    knowledgeAuthorityCatalog(workspaceId, generation.current, mode);
  return {
    generation,
    catalog,
    listKnowledgeSources: vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(catalog(workspaceId).sources)
      ),
    listKnowledgeObservations: vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(catalog(workspaceId).observations)
      ),
    listKnowledgeClaims: vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(catalog(workspaceId).claims)
      ),
    listKnowledgeConflicts: vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(catalog(workspaceId).conflicts)
      ),
    readKnowledgeIndexes: vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(catalog(workspaceId).indexes)
      ),
  };
}

/** Proves one Knowledge panel draft and selection were reset after authority settlement. */
function expectKnowledgeDraftCleared(
  panel: HTMLElement,
  fields: ReadonlyArray<readonly [string, string]>,
  selects: ReadonlyArray<{ name: string }> = []
) {
  for (const [name, value] of fields) {
    expect(within(panel).getByRole('textbox', { name })).toHaveValue(value);
  }
  for (const select of selects) {
    const trigger = within(panel)
      .getAllByRole('button', { name: new RegExp(`${select.name}$`, 'i') })
      .find((button) => button.getAttribute('aria-haspopup') === 'listbox');
    expect(trigger).toBeDefined();
    expect(trigger).toHaveTextContent('Select…');
  }
}

/** Fills every Knowledge panel draft that can remain submit-capable across Workspaces. */
async function fillKnowledgeWorkspaceDrafts(user: ReturnType<typeof userEvent.setup>) {
  const sources = knowledgePanel('Sources');
  await selectListedOption(user, sources, 'Source kind', SOURCE_KIND_OPTION);
  await fillKnowledgeFields(user, sources, [
    ['Source title', REGISTER_SOURCE_INPUT.title],
    ['Source content', REGISTER_SOURCE_INPUT.content],
  ]);
  const ledger = knowledgePanel('Ledger');
  await selectListedOption(user, ledger, 'Observation kind', OBSERVATION_KIND_OPTION);
  await fillKnowledgeFields(user, ledger, [
    ['Observation summary', KNOWLEDGE_OBSERVATION.summary],
    ['Observation producer', KNOWLEDGE_OBSERVATION.producer],
    ['Claim statement', KNOWLEDGE_CLAIM.statement],
    ['Claim producer', KNOWLEDGE_CLAIM.producer],
    ['Conflict summary', CONFLICT_SUMMARY],
    ['Subject references', KNOWLEDGE_CONFLICT.subjectReferences.join(' ')],
    ['Conflict producer', KNOWLEDGE_CONFLICT.producer],
    ['Resolution', CONFLICT_RESOLUTION],
    ['Resolved by', 'user:test'],
  ]);
  await selectListedOption(user, ledger, 'Conflict', KNOWLEDGE_CONFLICT.summary);
  await fillKnowledgeFields(user, knowledgePanel('Retrieval'), [['Query', RETRIEVAL_QUERY]]);
  await fillKnowledgeFields(user, knowledgePanel('Manager'), [['Question', MANAGER_QUESTION]]);
}

/** Enters the Workspace B Sources draft used to prove A settlement does not clear B. */
async function fillWorkspaceBSourceDraft(user: ReturnType<typeof userEvent.setup>) {
  const sources = knowledgePanel('Sources');
  await selectListedOption(user, sources, 'Source kind', SOURCE_KIND_OPTION);
  await fillKnowledgeFields(user, sources, [
    ['Source title', WORKSPACE_B_SOURCE_DRAFT.title],
    ['Source content', WORKSPACE_B_SOURCE_DRAFT.content],
  ]);
}

/** Proves the Workspace B Sources draft survived an in-flight Workspace A settlement. */
function expectWorkspaceBSourceDraftRetained() {
  expect(
    within(knowledgePanel('Sources')).getByRole('textbox', { name: 'Source title' })
  ).toHaveValue(WORKSPACE_B_SOURCE_DRAFT.title);
  expect(
    within(knowledgePanel('Sources')).getByRole('textbox', { name: 'Source content' })
  ).toHaveValue(WORKSPACE_B_SOURCE_DRAFT.content);
  expect(
    within(knowledgePanel('Sources')).getByRole('button', { name: /Source kind$/i })
  ).toHaveTextContent(SOURCE_KIND_OPTION);
}

/** Clicks a remaining retry if enabled and proves the write never retargeted to another Workspace. */
async function proveWriteDoesNotRetarget(
  user: ReturnType<typeof userEvent.setup>,
  method: { mock: { calls: Array<Array<{ workspaceId: string }>> } },
  workspaceId: string
) {
  const retry = screen.queryByRole('button', { name: /try again/i });
  if (
    retry &&
    !(retry as HTMLButtonElement).disabled &&
    retry.getAttribute('aria-disabled') !== 'true'
  ) {
    await user.click(retry);
  }
  expect(method.mock.calls.every((call) => call[0]?.workspaceId === workspaceId)).toBe(true);
}

/** Viewer-authorized conversation activity used by Overview ongoing work. */
function overviewConversation(input: {
  id: string;
  name: string;
  preview: string;
  activity: 'chat' | 'task' | 'goal' | 'unknown';
  state: 'working' | 'needs-you' | 'idle';
}) {
  return {
    thread: {
      id: input.id,
      workspaceId: WORKSPACE_A.id,
      name: input.name,
      preview: input.preview,
      status: 'active' as const,
      entryPath: 'conversation' as const,
      visibility: 'workspace' as const,
      createdAt: TIMESTAMP_OLD,
      updatedAt: TIMESTAMP_NEW,
    },
    activity: input.activity,
    state: input.state,
    lastActivityAt: TIMESTAMP_NEW,
  };
}

function renderApp(path: string, client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return queryClient;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Overview / Action Center (board 07)', () => {
  it('shows a loading skeleton while Needs-you rows load', async () => {
    const client = makeClient({
      operations: { 'attention.list': vi.fn().mockReturnValue(new Promise(() => {})) },
    });
    renderApp('/', client);
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows the empty "caught up" state when nothing needs you', async () => {
    renderApp('/', makeClient());
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByText('Competitive pricing report')).not.toBeInTheDocument();
    expect(screen.queryByText('4 of 6 steps moving')).not.toBeInTheDocument();
    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  it('waits for complete exact detail before enabling an attention grant', async () => {
    const detail = createDeferred<unknown>();
    const client = makeClient({
      operations: {
        'attention.list': vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }),
        'thread.dashboard': vi.fn().mockReturnValue(detail.promise),
      },
    });
    renderApp('/', client);
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    await act(async () =>
      detail.resolve({
        pendingRequests: [
          {
            requestId: 'ap1',
            state: 'pending',
            canRespond: true,
            approvalEffect: {
              status: 'available',
              summary: 'Summary: One effect',
              detail: '{"recipient":"late complete argument"}',
            },
          },
        ],
      })
    );
    expect(await screen.findByText('{"recipient":"late complete argument"}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });

  it('keeps authorized denial available when attention detail is unavailable', async () => {
    const client = makeClient({
      operations: {
        'attention.list': vi.fn().mockResolvedValue({
          items: [
            {
              ...APPROVAL_ROW,
              actions: [
                ...APPROVAL_ROW.actions,
                {
                  kind: 'withdraw_request',
                  label: 'Withdraw',
                  method: 'POST',
                  href: operationHttpPath('pending-request.withdraw'),
                },
              ],
            },
          ],
        }),

        'thread.dashboard': vi.fn().mockResolvedValue({
          pendingRequests: [
            {
              requestId: 'ap1',
              state: 'pending',
              canRespond: true,
              approvalEffect: {
                status: 'unavailable',
                reason: 'Complete detail cannot be loaded.',
              },
            },
          ],
        }),
      },
    });
    renderApp('/', client);
    expect(
      await screen.findByText(
        'Exact effect unavailable; approval disabled: Complete detail cannot be loaded.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Deny' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(client.operations['pending-request.withdraw']).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingRequestId: 'ap1',
        ...{ workspaceId: 'ws1', threadId: 'th1' },
      })
    );
  });

  it.each([
    'resolved',
    'inspect-only',
    'read-only',
  ])('keeps attention approval controls closed for %s authority/state', async (state) => {
    const client = makeClient({
      operations: {
        'attention.list': vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }),

        'thread.dashboard': vi.fn().mockResolvedValue({
          pendingRequests: [
            {
              requestId: 'ap1',
              state: state === 'read-only' ? 'pending' : state,
              canRespond: state !== 'read-only',
              approvalEffect: { status: 'available', summary: 'Summary', detail: '{}' },
            },
          ],
        }),
      },
    });
    renderApp('/', client);
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    expect(await screen.findByText('{}')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('renders Needs-you rows longest-waiting first and decides approvals inline', async () => {
    const user = userEvent.setup();
    const respondApproval = vi.fn().mockResolvedValue({});
    const listHumanAttention = vi.fn().mockResolvedValue({
      items: [OPEN_ONLY_ROW, APPROVAL_ROW],
    });
    const client = makeClient({
      operations: { 'approval.respond': respondApproval, 'attention.list': listHumanAttention },

      core: {},
    });
    renderApp('/', client);

    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    expect(screen.getByText('Answer required')).toBeInTheDocument();

    const titles = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    expect(titles[0]).toBe('Scout asks to sign in to the vendor portal');
    expect(titles[1]).toBe('Answer required');

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalRequestId: 'ap1',
          ...{
            workspaceId: 'ws1',
            threadId: 'th1',
            turnId: 't1',
            decision: 'granted',
            requestId: expect.any(String),
          },
        })
      )
    );
  });

  it('shows an Open link when a row cannot be decided inline', async () => {
    const client = makeClient({
      operations: { 'attention.list': vi.fn().mockResolvedValue({ items: [OPEN_ONLY_ROW] }) },
    });
    renderApp('/', client);
    expect(await screen.findByText('Answer required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open thread' })).toHaveAttribute(
      'href',
      '/chat/ws1/th2'
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it.each([
    'workspace_review',
    'workspace_recovery',
  ] as const)('opens workspace changes for a %s row without a Thread', async (type) => {
    const row = {
      id: `${type}:review1`,
      kind: type,
      workspaceId: 'ws1',
      title: 'Review workspace changes',
      createdAt: TIMESTAMP_OLD,
      source: { type, workspaceId: 'ws1', reviewId: 'review1' },
      actions: [{ kind: 'open_artifact', label: 'Open review', method: 'GET' }],
    };
    renderApp(
      '/',
      makeClient({
        operations: { 'attention.list': vi.fn().mockResolvedValue({ items: [row] }) },
      })
    );
    expect(await screen.findByText(row.title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open workspace changes' })).toHaveAttribute(
      'href',
      '/workspace-changes'
    );
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('shows an error banner with retry when the queue fails', async () => {
    const user = userEvent.setup();
    const listHumanAttention = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ items: [] });
    const client = makeClient({
      operations: { 'attention.list': listHumanAttention },
    });
    renderApp('/', client);
    expect(await screen.findByText(/Couldn't load what needs you/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
  });

  it('disables inline actions and marks counts stale when disconnected', async () => {
    const client = makeClient({
      operations: { 'attention.list': vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }) },

      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp('/', client);
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
      },
      { timeout: 3000 }
    );
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it('lists every ongoing Task and Goal with activity and status', async () => {
    const items = [
      overviewConversation({
        id: 'th_goal_need',
        name: 'Launch research program',
        preview: 'Waiting on pricing sources',
        activity: 'goal',
        state: 'needs-you',
      }),
      ...[1, 2, 3, 4].map((index) =>
        overviewConversation({
          id: `th_task_${index}`,
          name: `Task ${index}`,
          preview: `Current task context ${index}`,
          activity: 'task',
          state: 'working',
        })
      ),
      ...[1, 2, 3].map((index) =>
        overviewConversation({
          id: `th_goal_${index}`,
          name: `Goal ${index}`,
          preview: `Current goal context ${index}`,
          activity: 'goal',
          state: 'working',
        })
      ),
      overviewConversation({
        id: 'th_idle_chat',
        name: 'Idle chat',
        preview: 'Yesterday',
        activity: 'chat',
        state: 'idle',
      }),
    ];
    renderApp(
      '/',
      makeClient({
        operations: { 'conversation.navigation': vi.fn().mockResolvedValue({ items }) },

        app: {},
      })
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Launch research program',
      })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open goal' })[0]).toHaveAttribute(
      'href',
      '/goals/ws1/th_goal_need'
    );
    expect(screen.getAllByRole('link', { name: 'Open task' })[0]).toHaveAttribute(
      'href',
      '/tasks/ws1/th_task_1'
    );
    expect(screen.getAllByText('Working').length).toBeGreaterThanOrEqual(7);
    expect(screen.getByRole('heading', { name: 'Task 4' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Goal 3' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getAllByText('Worker task · Working')).toHaveLength(4);
    expect(screen.queryByRole('heading', { name: 'Idle chat' })).not.toBeInTheDocument();
    expect(screen.queryByText('Competitive pricing report')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(8);
  });

  it.each([
    ['task', 'Open task', '/tasks/ws%2Fspace%20%3F%23%25/th%2Fspace%20%3F%23%25'],
    ['goal', 'Open goal', '/goals/ws%2Fspace%20%3F%23%25/th%2Fspace%20%3F%23%25'],
  ] as const)('encodes ongoing %s owner identifiers in its registered destination', async (activity, label, href) => {
    const workspaceId = 'ws/space ?#%';
    const item = overviewConversation({
      id: 'th/space ?#%',
      name: 'Encoded work',
      preview: '',
      activity,
      state: 'working',
    });
    renderApp(
      '/',
      makeClient({
        core: {},
        app: {},

        operations: {
          'conversation.navigation': vi.fn().mockResolvedValue({
            items: [{ ...item, thread: { ...item.thread, workspaceId } }],
          }),

          'workspace.list': vi.fn().mockResolvedValue({
            items: [{ ...WORKSPACE_A, id: workspaceId }].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );
    expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', href);
  });

  it('does not use an unnamed Task raw input as its display title', async () => {
    const item = overviewConversation({
      id: 'unnamed',
      name: 'Temporary',
      preview: '{"schemaVersion":1,"objective":"raw-input"}',
      activity: 'task',
      state: 'working',
    });
    renderApp(
      '/',
      makeClient({
        operations: {
          'conversation.navigation': vi
            .fn()
            .mockResolvedValue({ items: [{ ...item, thread: { ...item.thread, name: null } }] }),
        },

        app: {},
      })
    );
    const main = await screen.findByRole('main', { name: 'Workspace' });
    expect(await within(main).findByRole('heading', { name: 'Worker task' })).toBeInTheDocument();
    expect(main).not.toHaveTextContent('raw-input');
  });

  it('denies an approval inline and keeps disabled approval actions read-only', async () => {
    const user = userEvent.setup();
    const respondApproval = vi.fn().mockResolvedValue({});
    renderApp(
      '/',
      makeClient({
        operations: {
          'approval.respond': respondApproval,
          'attention.list': vi.fn().mockResolvedValue({
            items: [APPROVAL_ROW, DISABLED_APPROVAL_ROW],
          }),
        },

        core: {},
      })
    );
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    const activeRow = screen
      .getByRole('heading', { name: 'Scout asks to sign in to the vendor portal' })
      .closest('[class*="border-b"]') as HTMLElement;
    const readOnly = screen
      .getByRole('heading', { name: 'Read-only approval' })
      .closest('[class*="border-b"]') as HTMLElement;
    expect(await within(activeRow).findByRole('button', { name: 'Allow' })).toBeEnabled();
    expect(await within(readOnly).findByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(within(readOnly).getByRole('button', { name: 'Deny' })).toBeDisabled();

    await user.click(within(activeRow).getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalRequestId: 'ap1',
          ...{
            workspaceId: 'ws1',
            threadId: 'th1',
            turnId: 't1',
            decision: 'denied',
            requestId: expect.any(String),
          },
        })
      )
    );
  });

  it('retries a failed approval with the same request identity', async () => {
    const user = userEvent.setup();
    const respondApproval = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(500, 'private-approval-failure', { code: 'failed' }))
      .mockResolvedValue({});
    renderApp(
      '/',
      makeClient({
        operations: {
          'approval.respond': respondApproval,
          'attention.list': vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }),
        },

        core: {},
      })
    );
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't save that decision/i);
    expect(alert).not.toHaveTextContent('private-approval-failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(respondApproval).toHaveBeenCalledTimes(2));
    expect(requestIdFromCall(respondApproval.mock.calls[0])).toEqual(
      requestIdFromCall(respondApproval.mock.calls[1])
    );
  });

  it('refreshes after a stale denial without sending a second request', async () => {
    const user = userEvent.setup();
    const respondApproval = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'stale-private-denial', { code: 'stale' }));
    const listHumanAttention = vi
      .fn()
      .mockResolvedValueOnce({ items: [APPROVAL_ROW] })
      .mockResolvedValue({ items: [] });
    renderApp(
      '/',
      makeClient({
        operations: { 'approval.respond': respondApproval, 'attention.list': listHumanAttention },

        core: {},
      })
    );
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no longer current/i);
    expect(alert).not.toHaveTextContent('stale-private-denial');
    await waitFor(() => expect(listHumanAttention.mock.calls.length).toBeGreaterThan(1));
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(respondApproval).toHaveBeenCalledTimes(1);
  });

  it('disables approval actions while a decision is pending', async () => {
    const user = userEvent.setup();
    const respondApproval = vi.fn().mockReturnValue(new Promise(() => {}));
    renderApp(
      '/',
      makeClient({
        operations: {
          'approval.respond': respondApproval,
          'attention.list': vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }),
        },

        core: {},
      })
    );
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(respondApproval).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('invalidates the original Workspace after a decision even if selection changes', async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    const respondApproval = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const listHumanAttention = vi
      .fn()
      .mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
        items: workspaceId === WORKSPACE_A.id ? [APPROVAL_ROW] : [],
      }));
    const listConversationNavigation = vi.fn().mockResolvedValue({ items: [] });
    const queryClient = renderApp(
      '/',
      makeClient({
        core: {},
        app: {},

        operations: {
          'approval.respond': respondApproval,
          'attention.list': listHumanAttention,
          'conversation.navigation': listConversationNavigation,

          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(respondApproval).toHaveBeenCalledTimes(1));
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await act(async () => {
      finish({});
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(['attention', WORKSPACE_A.id])?.isInvalidated).toBe(true);
      expect(
        queryClient.getQueryState(['threads', WORKSPACE_A.id, 'navigation'])?.isInvalidated
      ).toBe(true);
    });
  });

  it('keeps a denied row from blocking another approval and hides its retry in another Workspace', async () => {
    const user = userEvent.setup();
    const respondApproval = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(403, 'private-denial', { code: 'workspace_access_denied' })
      );
    const other = {
      ...APPROVAL_ROW,
      id: 'other-approval',
      title: 'Another approval',
      source: { ...APPROVAL_ROW.source, approvalRequestId: 'ap2' },
    };
    renderApp(
      '/',
      makeClient({
        core: {},
        app: {},

        operations: {
          'approval.respond': respondApproval,

          'attention.list': vi
            .fn()
            .mockImplementation(async ({ workspaceId: id }: { workspaceId: string }) => ({
              items: id === WORKSPACE_A.id ? [APPROVAL_ROW, other] : [],
            })),
          'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),

          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );
    await screen.findByRole('heading', { name: 'Another approval' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Allow' })).toHaveLength(2));
    await user.click(screen.getAllByRole('button', { name: 'Allow' })[0]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Access denied.');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Allow' })[1]).toBeEnabled();
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await screen.findByText("You're all caught up");
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(respondApproval).toHaveBeenCalledTimes(1);
  });

  it('retries an Artifact review with the same request identity', async () => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue({});
    const row = {
      ...APPROVAL_ROW,
      id: 'review',
      kind: 'artifact_review',
      title: 'Review report',
      artifactId: 'ar1',
      artifactVersion: 1,
      source: {
        type: 'artifact_review',
        workspaceId: 'ws1',
        artifactId: 'ar1',
        artifactVersion: 1,
      },
      actions: [{ kind: 'accept_review', label: 'Accept', disabled: false }],
    };
    renderApp(
      '/',
      makeClient({
        app: {},

        operations: {
          'attention.list': vi.fn().mockResolvedValue({ items: [row] }),
          'artifact.review.decide': submitArtifactReviewDecision,
        },
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await user.click(
      within(await screen.findByRole('alert')).getByRole('button', { name: 'Try again' })
    );
    await waitFor(() => expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(2));
    expect(submitArtifactReviewDecision.mock.calls[0][0]).toMatchObject({
      decision: 'accepted',
      requestId: expect.any(String),
    });
    expect(submitArtifactReviewDecision.mock.calls[1]).toEqual(
      submitArtifactReviewDecision.mock.calls[0]
    );
  });

  it('opens an Artifact Review for inspection and does not decide it inline', async () => {
    renderApp(
      '/',
      makeClient({
        operations: {
          'attention.list': vi.fn().mockResolvedValue({ items: [ARTIFACT_INSPECTION_ROW] }),
        },
      })
    );
    expect(await screen.findByText('Review worker output')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open goal' })).toHaveAttribute(
      'href',
      '/goals/ws1/th_goal/artifacts/ar1'
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request refinement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abort goal' })).not.toBeInTheDocument();
  });
});

describe('Agents (board 08)', () => {
  it('explains that a disabled agent cannot start work without inferring its private reason', async () => {
    const client = makeClient({
      operations: {
        'agent.list': vi.fn().mockResolvedValue({
          items: [{ ...AGENT_READY, status: 'disabled' }],
        }),
      },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('This agent is disabled and cannot start work.')).toBeInTheDocument();
    expect(screen.getByText('Resting')).toBeInTheDocument();
  });

  it('lists agents with plain-language readiness', async () => {
    const client = makeClient({
      operations: {
        'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY, AGENT_WORKING] }),
      },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('reveals diagnostics behind View details', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      operations: { 'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const details = screen.getByText('View details').closest('details');
    expect(details).toBeTruthy();
    expect(details).not.toHaveAttribute('open');
    await user.click(within(details as HTMLElement).getByText('View details'));
    expect(details).toHaveAttribute('open');
    expect(within(details as HTMLElement).getByText(/gpt-test/i)).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText(/Healthy/i)).toBeInTheDocument();
  });

  it('shows the empty state when no agents are configured', async () => {
    renderApp('/agents', makeClient());
    expect(await screen.findByText(/No agents yet/i)).toBeInTheDocument();
  });

  it('lists a selected Workspace Codex Agent with no role as Worker without claiming ready', async () => {
    const getWorkspaceResources = vi.fn().mockResolvedValue({
      knowledge: [],
      skills: [],
      agents: [AGENT_CODEX],
      models: [],
    });
    const list = vi.fn().mockResolvedValue({ items: [] });
    renderApp(
      '/agents',
      makeClient({
        core: {},
        operations: { 'agent.list': list, 'workspace.resources': getWorkspaceResources },
      })
    );

    expect(await screen.findByText('Codex Agent')).toBeInTheDocument();
    expect(screen.getByText('Worker')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.queryByText('Internal worker')).not.toBeInTheDocument();
    expect(screen.queryByText(/Coding/)).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    expect(getWorkspaceResources).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id });
  });
});

/** Builds one browser directory-picker file with a nested relative path. */
function catalogRelativeFile(content: string, relativePath: string) {
  const file = new File([content], relativePath.split('/').pop() ?? relativePath, {
    type: 'text/markdown',
  });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/**
 * Installs a live FileList that empties in place when the input value is cleared,
 * matching native directory inputs. Static userEvent FileList mocks do not.
 */
function bindLiveDirectoryFiles(input: HTMLInputElement, selected: File[]) {
  const files = [...selected];
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => files,
  });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => (files[0] ? `C:\\fakepath\\${files[0].name}` : ''),
    set(next: string) {
      if (next === '') files.length = 0;
    },
  });
}

/** Dispatches change with a native-like live FileList, then flushes file reads. */
async function changeLiveDirectoryFiles(input: HTMLInputElement, selected: File[]) {
  bindLiveDirectoryFiles(input, selected);
  await act(async () => {
    fireEvent.change(input);
    await Promise.all(selected.map((file) => file.arrayBuffer()));
  });
}

describe('Catalog', () => {
  it('lists Skill, MCP, and plugin empty states from the selected Workspace catalog', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ revision: 2, candidates: [], skills: [], mcp: [], plugins: [] });
    renderApp('/catalog', makeClient({ operations: { 'catalog.read': get } }));
    expect(await screen.findByText('No skills yet')).toBeInTheDocument();
    expect(screen.getByText('No MCP servers')).toBeInTheDocument();
    expect(screen.getByText('No plugins')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id }));
  });

  it('keeps fresh catalog values empty so placeholders cannot submit', async () => {
    const user = userEvent.setup();
    const importSkill = vi.fn();
    const createMcpConfig = vi.fn();
    const get = vi
      .fn()
      .mockResolvedValue({ revision: 2, candidates: [], skills: [], mcp: [], plugins: [] });
    renderApp(
      '/catalog',
      makeClient({
        operations: {
          'catalog.read': get,
          'catalog.skill-import': importSkill,
          'catalog.mcp-create': createMcpConfig,
        },
      })
    );
    expect(await screen.findByRole('button', { name: 'Import SKILL.md' })).toBeDisabled();

    const [skillName, mcpName] = screen.getAllByRole('textbox', { name: 'Display name' });
    expect(skillName).toHaveValue('');
    expect(skillName).toHaveAttribute('placeholder', 'Team guidelines');
    const candidateSummary = screen.getByRole('textbox', { name: 'Candidate summary' });
    expect(candidateSummary).toHaveValue('');
    expect(candidateSummary).toHaveAttribute('placeholder', 'Clarify the rollback section.');
    const skillFile = screen.getByLabelText('Skill markdown file');
    expect(skillFile).toBeDisabled();
    const skippedImport = new File(['# Hello\n'], 'SKILL.md', { type: 'text/markdown' });
    await act(async () => {
      fireEvent.change(skillFile, { target: { files: [skippedImport] } });
      await skippedImport.arrayBuffer();
    });
    expect(importSkill).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import Skill folder' })).toBeDisabled();
    const skillFolder = screen.getByLabelText('Skill folder files');
    expect(skillFolder).toBeDisabled();
    const skippedFolder = catalogRelativeFile('# Hello\n', 'repo-guidelines/SKILL.md');
    await act(async () => {
      fireEvent.change(skillFolder, { target: { files: [skippedFolder] } });
      await skippedFolder.arrayBuffer();
    });
    expect(importSkill).not.toHaveBeenCalled();

    const mcpId = screen.getByRole('textbox', { name: 'Id' });
    expect(mcpId).toHaveValue('');
    expect(mcpId).toHaveAttribute('placeholder', 'echo');
    expect(mcpName).toHaveValue('');
    expect(mcpName).toHaveAttribute('placeholder', 'Echo');
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue('');
    const mcpTools = screen.getByRole('textbox', { name: 'Allowed tools' });
    expect(mcpTools).toHaveValue('');
    expect(mcpTools).toHaveAttribute('placeholder', 'echo');
    expect(screen.getByRole('button', { name: 'Add inactive configuration' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add inactive configuration' }));
    expect(createMcpConfig).not.toHaveBeenCalled();

    await selectListedOption(user, document.body, 'Transport', 'HTTP');
    const mcpEndpoint = screen.getByRole('textbox', { name: 'Endpoint' });
    expect(mcpEndpoint).toHaveValue('');
    expect(mcpEndpoint).toHaveAttribute('placeholder', 'https://example.invalid/mcp');
    expect(screen.getByRole('button', { name: 'Add inactive configuration' })).toBeDisabled();
    await user.type(mcpId, 'echo');
    await user.type(mcpName, 'Echo');
    await user.type(mcpTools, 'echo');
    expect(screen.getByRole('button', { name: 'Add inactive configuration' })).toBeDisabled();
    await user.type(mcpEndpoint, 'https://example.invalid/mcp');
    expect(screen.getByRole('button', { name: 'Add inactive configuration' })).toBeEnabled();
  });

  it('imports a SKILL.md file through the catalog client', async () => {
    const user = userEvent.setup();
    const importSkill = vi.fn().mockResolvedValue({
      entry: {
        availability: 'available',
        currentDigest: `sha256:${'a'.repeat(64)}`,
        description: null,
        displayName: 'Repo guidelines',
        id: 'repo-guidelines',
      },
      revision: 3,
      version: {
        createdAt: TIMESTAMP_NEW,
        digest: `sha256:${'a'.repeat(64)}`,
        digestFormat: 'openkit-tree-v1',
        entryId: 'repo-guidelines',
        inventory: [],
        publisherVersion: null,
      },
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce({ revision: 2, candidates: [], skills: [], mcp: [], plugins: [] })
      .mockResolvedValue({
        revision: 3,
        candidates: [],
        skills: [
          {
            availability: 'available',
            currentDigest: `sha256:${'a'.repeat(64)}`,
            description: null,
            displayName: 'Repo guidelines',
            id: 'repo-guidelines',
            pinDigest: null,
            versions: [{ createdAt: TIMESTAMP_NEW, digest: `sha256:${'a'.repeat(64)}` }],
          },
        ],
        mcp: [],
        plugins: [],
      });
    renderApp(
      '/catalog',
      makeClient({ operations: { 'catalog.read': get, 'catalog.skill-import': importSkill } })
    );
    expect(await screen.findByText('Import SKILL.md')).toBeInTheDocument();
    await user.type(
      screen.getAllByRole('textbox', { name: 'Display name' })[0]!,
      'Repo guidelines'
    );
    const file = new File(['# Hello\n'], 'SKILL.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('Skill markdown file'), file);
    await waitFor(() => expect(importSkill).toHaveBeenCalled());
    expect(importSkill.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_A.id);
    expect(importSkill.mock.calls[0]?.[0]).toMatchObject({
      activate: true,
      displayName: 'Repo guidelines',
      expectedRevision: 2,
      tree: [
        expect.objectContaining({
          contentBase64: btoa('# Hello\n'),
          kind: 'file',
          path: 'SKILL.md',
        }),
      ],
    });
  });

  it('submits a Skill candidate from an existing catalog entry', async () => {
    const user = userEvent.setup();
    const digest = `sha256:${'a'.repeat(64)}`;
    const submitSkillCandidate = vi.fn().mockResolvedValue({
      candidate: {
        baseDigest: digest,
        candidateDigest: `sha256:${'b'.repeat(64)}`,
        createdAt: TIMESTAMP_NEW,
        disposition: 'proposed',
        entryId: 'repo-guidelines',
        id: 'cand_demo',
        summary: 'Clarify the rollback section.',
      },
      revision: 4,
    });
    const get = vi.fn().mockResolvedValue({
      revision: 3,
      candidates: [],
      skills: [
        {
          availability: 'available',
          currentDigest: digest,
          description: null,
          displayName: 'Repo guidelines',
          id: 'repo-guidelines',
          pinDigest: null,
          versions: [{ createdAt: TIMESTAMP_NEW, digest }],
        },
      ],
      mcp: [],
      plugins: [],
    });
    renderApp(
      '/catalog',
      makeClient({
        operations: { 'catalog.read': get, 'catalog.skill-candidate-submit': submitSkillCandidate },
      })
    );
    expect(await screen.findByRole('button', { name: 'Propose update' })).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Candidate summary' }),
      'Clarify the rollback section.'
    );
    await user.click(screen.getByRole('button', { name: 'Propose update' }));
    const file = new File(['# v2\n'], 'SKILL.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('Skill candidate markdown file'), file);
    await waitFor(() => expect(submitSkillCandidate).toHaveBeenCalled());
    expect(submitSkillCandidate.mock.calls[0]?.[0]?.skillId).toBe('repo-guidelines');
    expect(submitSkillCandidate.mock.calls[0]?.[0]).toMatchObject({
      baseDigest: digest,
      summary: 'Clarify the rollback section.',
    });
  });

  it('keeps nested Skill folder bytes and relative paths on import and candidate update', async () => {
    const user = userEvent.setup();
    const digest = `sha256:${'a'.repeat(64)}`;
    const importSkill = vi.fn().mockResolvedValue({
      entry: {
        availability: 'available',
        currentDigest: digest,
        description: null,
        displayName: 'Repo guidelines',
        id: 'repo-guidelines',
      },
      revision: 3,
      version: {
        createdAt: TIMESTAMP_NEW,
        digest,
        digestFormat: 'openkit-tree-v1',
        entryId: 'repo-guidelines',
        inventory: [],
        publisherVersion: null,
      },
    });
    const submitSkillCandidate = vi.fn().mockResolvedValue({
      candidate: {
        baseDigest: digest,
        candidateDigest: `sha256:${'b'.repeat(64)}`,
        createdAt: TIMESTAMP_NEW,
        disposition: 'proposed',
        entryId: 'repo-guidelines',
        id: 'cand_demo',
        summary: 'Clarify the rollback section.',
      },
      revision: 4,
    });
    const skillEntry = {
      availability: 'available',
      currentDigest: digest,
      description: null,
      displayName: 'Repo guidelines',
      id: 'repo-guidelines',
      pinDigest: null,
      versions: [{ createdAt: TIMESTAMP_NEW, digest }],
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce({ revision: 2, candidates: [], skills: [], mcp: [], plugins: [] })
      .mockResolvedValue({
        revision: 3,
        candidates: [],
        skills: [skillEntry],
        mcp: [],
        plugins: [],
      });
    const selectSkillDefault = vi.fn();
    const decideSkillCandidate = vi.fn();
    renderApp(
      '/catalog',
      makeClient({
        operations: {
          'catalog.read': get,
          'catalog.skill-import': importSkill,
          'catalog.skill-candidate-submit': submitSkillCandidate,
          'catalog.skill-select': selectSkillDefault,
          'catalog.skill-candidate-decide': decideSkillCandidate,
        },
      })
    );
    expect(await screen.findByLabelText('Skill folder files')).toBeInTheDocument();
    await user.type(
      screen.getAllByRole('textbox', { name: 'Display name' })[0]!,
      'Repo guidelines'
    );
    await user.upload(screen.getByLabelText('Skill folder files'), [
      catalogRelativeFile('# Hello\n', 'repo-guidelines/SKILL.md'),
      catalogRelativeFile('Do not skip rollback.\n', 'repo-guidelines/references/rollback.md'),
    ]);
    await waitFor(() => expect(importSkill).toHaveBeenCalled());
    expect(importSkill.mock.calls[0]?.[0]).toMatchObject({
      activate: true,
      displayName: 'Repo guidelines',
      expectedRevision: 2,
    });
    expect(importSkill.mock.calls[0]?.[0].tree).toEqual([
      {
        contentBase64: btoa('# Hello\n'),
        kind: 'file',
        path: 'SKILL.md',
      },
      {
        kind: 'directory',
        path: 'references',
      },
      {
        contentBase64: btoa('Do not skip rollback.\n'),
        kind: 'file',
        path: 'references/rollback.md',
      },
    ]);

    await user.type(
      screen.getByRole('textbox', { name: 'Candidate summary' }),
      'Clarify the rollback section.'
    );
    await user.click(await screen.findByRole('button', { name: 'Propose folder update' }));
    await user.upload(screen.getByLabelText('Skill candidate folder files'), [
      catalogRelativeFile('# v2\n', 'repo-guidelines/SKILL.md'),
      catalogRelativeFile('Clarify rollback.\n', 'repo-guidelines/references/rollback.md'),
    ]);
    await waitFor(() => expect(submitSkillCandidate).toHaveBeenCalled());
    expect(submitSkillCandidate.mock.calls[0]?.[0]?.skillId).toBe('repo-guidelines');
    expect(submitSkillCandidate.mock.calls[0]?.[0]).toMatchObject({
      baseDigest: digest,
      expectedRevision: 3,
      summary: 'Clarify the rollback section.',
    });
    expect(submitSkillCandidate.mock.calls[0]?.[0]).not.toHaveProperty('activate');
    expect(submitSkillCandidate.mock.calls[0]?.[0].tree).toEqual([
      {
        contentBase64: btoa('# v2\n'),
        kind: 'file',
        path: 'SKILL.md',
      },
      {
        kind: 'directory',
        path: 'references',
      },
      {
        contentBase64: btoa('Clarify rollback.\n'),
        kind: 'file',
        path: 'references/rollback.md',
      },
    ]);
    expect(selectSkillDefault).not.toHaveBeenCalled();
    expect(decideSkillCandidate).not.toHaveBeenCalled();
  });

  it('imports Skill, candidate, and plugin folders after the native chooser clears the live FileList', async () => {
    const user = userEvent.setup();
    const digest = `sha256:${'a'.repeat(64)}`;
    const importSkill = vi.fn().mockResolvedValue({ revision: 3 });
    const submitSkillCandidate = vi.fn().mockResolvedValue({ revision: 4 });
    const importPlugin = vi.fn().mockResolvedValue({ revision: 3 });
    const get = vi.fn().mockResolvedValue({
      revision: 3,
      candidates: [],
      skills: [
        {
          availability: 'available',
          currentDigest: digest,
          description: null,
          displayName: 'Repo guidelines',
          id: 'repo-guidelines',
          pinDigest: null,
          versions: [{ createdAt: TIMESTAMP_NEW, digest }],
        },
      ],
      mcp: [],
      plugins: [],
    });
    renderApp(
      '/catalog',
      makeClient({
        operations: {
          'catalog.read': get,
          'catalog.skill-import': importSkill,
          'catalog.skill-candidate-submit': submitSkillCandidate,
          'catalog.plugin-import': importPlugin,
        },
      })
    );
    const displayNames = await screen.findAllByRole('textbox', { name: 'Display name' });
    await user.type(displayNames[0]!, 'Repo guidelines');
    await user.type(
      screen.getByRole('textbox', { name: 'Candidate summary' }),
      'Clarify the rollback section.'
    );

    const skillFiles = [
      catalogRelativeFile('# Hello\n', 'repo-guidelines/SKILL.md'),
      catalogRelativeFile('Do not skip rollback.\n', 'repo-guidelines/references/rollback.md'),
    ];
    const candidateFiles = [
      catalogRelativeFile('# v2\n', 'repo-guidelines/SKILL.md'),
      catalogRelativeFile('Clarify rollback.\n', 'repo-guidelines/references/rollback.md'),
    ];
    const pluginFiles = [catalogRelativeFile('{"name":"demo"}\n', 'demo-plugin/plugin.json')];
    await changeLiveDirectoryFiles(
      screen.getByLabelText('Skill folder files') as HTMLInputElement,
      skillFiles
    );
    await user.click(screen.getByRole('button', { name: 'Propose folder update' }));
    await changeLiveDirectoryFiles(
      screen.getByLabelText('Skill candidate folder files') as HTMLInputElement,
      candidateFiles
    );
    await changeLiveDirectoryFiles(
      screen.getByLabelText('Plugin package files') as HTMLInputElement,
      pluginFiles
    );

    expect(importSkill).toHaveBeenCalled();
    expect(importSkill.mock.calls[0]?.[0].tree).toEqual([
      {
        contentBase64: btoa('# Hello\n'),
        kind: 'file',
        path: 'SKILL.md',
      },
      {
        kind: 'directory',
        path: 'references',
      },
      {
        contentBase64: btoa('Do not skip rollback.\n'),
        kind: 'file',
        path: 'references/rollback.md',
      },
    ]);
    expect(submitSkillCandidate).toHaveBeenCalled();
    expect(submitSkillCandidate.mock.calls[0]?.[0].tree).toEqual([
      {
        contentBase64: btoa('# v2\n'),
        kind: 'file',
        path: 'SKILL.md',
      },
      {
        kind: 'directory',
        path: 'references',
      },
      {
        contentBase64: btoa('Clarify rollback.\n'),
        kind: 'file',
        path: 'references/rollback.md',
      },
    ]);
    expect(submitSkillCandidate.mock.calls[0]?.[0]).not.toHaveProperty('activate');
    expect(importPlugin).toHaveBeenCalled();
    expect(importPlugin.mock.calls[0]?.[0].tree).toEqual([
      {
        contentBase64: btoa('{"name":"demo"}\n'),
        kind: 'file',
        path: 'plugin.json',
      },
    ]);
  });

  it('disables catalog writes while disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp('/catalog', client);
    expect(await screen.findByRole('button', { name: 'Import SKILL.md' })).toBeDisabled();
    expect(await screen.findByText('Catalog may be stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import Skill folder' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add inactive configuration' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import plugin package' })).toBeDisabled();
  });

  it('preserves MCP deny and approval policy when toggling enablement', async () => {
    const user = userEvent.setup();
    const digest = `sha256:${'c'.repeat(64)}`;
    const updateMcpBinding = vi.fn().mockResolvedValue({ revision: 4 });
    const get = vi.fn().mockResolvedValue({
      revision: 3,
      candidates: [],
      skills: [],
      mcp: [
        {
          availability: 'available',
          allowedTools: ['echo'],
          approvalRequiredTools: ['danger'],
          bindingRevision: 2,
          currentVersionDigest: digest,
          deniedTools: ['secret'],
          displayName: 'Echo',
          enabled: false,
          id: 'echo',
          schemaPolicy: 'tracking',
          timeoutMs: 60_000,
          transportKind: 'stdio',
          versions: [{ createdAt: TIMESTAMP_NEW, digest, transportKind: 'stdio' }],
        },
      ],
      plugins: [],
    });
    renderApp(
      '/catalog',
      makeClient({ operations: { 'catalog.read': get, 'catalog.mcp-binding': updateMcpBinding } })
    );
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(updateMcpBinding).toHaveBeenCalled());
    expect(updateMcpBinding.mock.calls[0]?.[0]).toMatchObject({
      allowedTools: ['echo'],
      approvalRequiredTools: ['danger'],
      deniedTools: ['secret'],
      enabled: true,
    });
  });
});

describe('Agents roster continued', () => {
  it('queries only the selected Workspace resources and does not project another Workspace roster', async () => {
    const user = userEvent.setup();
    const getWorkspaceResources = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string; threadId?: string }) =>
        Promise.resolve({
          knowledge: [],
          skills: [],
          agents: workspaceId === WORKSPACE_A.id ? [AGENT_READY] : [AGENT_WORKING],
          models: [],
        })
      );
    const list = vi.fn().mockResolvedValue({ items: [AGENT_READY, AGENT_WORKING] });
    const client = makeClient({
      operations: {
        'agent.list': list,
        'workspace.list': vi.fn().mockResolvedValue({
          items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        }),
        'workspace.resources': getWorkspaceResources,
      },
    });
    renderApp('/agents', client);

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.queryByText('Scout')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(getWorkspaceResources).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id })
    );
    expect(
      getWorkspaceResources.mock.calls.every(([{ workspaceId }]) => workspaceId === WORKSPACE_A.id)
    ).toBe(true);
    expect(list).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: WORKSPACE_A.name }));
    await user.click(await screen.findByRole('menuitem', { name: WORKSPACE_B.name }));

    expect(await screen.findByText('Scout')).toBeInTheDocument();
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument();
    expect(getWorkspaceResources).toHaveBeenCalledWith({ workspaceId: WORKSPACE_B.id });
    expect(list).not.toHaveBeenCalled();
  });

  it('marks readiness stale when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      operations: {
        'worker.list': vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_A.id,
          items: [workspaceWorker({ stale: false })],
        }),
        'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
      },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Implement inventory')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Configured agents' })).toHaveTextContent('Ledger');
    await waitFor(
      () => {
        expect(screen.getByText('Readiness may be stale')).toBeInTheDocument();
        expect(screen.getByText('Worker read may be stale')).toBeInTheDocument();
      },
      {
        timeout: 3000,
      }
    );
    expect(screen.queryByText('Setup outdated')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });

  it('refreshes health for the selected Workspace then refetches authoritative agents', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ items: [AGENT_READY] })
      .mockResolvedValueOnce({
        items: [{ ...AGENT_READY, health: { ...AGENT_READY.health, message: 'Rechecked' } }],
      });
    const refreshHealth = vi.fn().mockResolvedValue({ items: [] });
    renderApp(
      '/agents',
      makeClient({ operations: { 'agent.list': list, 'agent.health-refresh': refreshHealth } })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(refreshHealth).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /refresh health/i }));

    await waitFor(() => expect(refreshHealth).toHaveBeenCalledWith({ workspaceId: 'ws1' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Rechecked')).toBeInTheDocument();
    expect(refreshHealth).toHaveBeenCalledTimes(1);
  });

  it('reads the exact agent through get when View details opens and shows the authoritative entry', async () => {
    const user = userEvent.setup();
    const get = vi.fn().mockResolvedValue(AGENT_DETAIL);
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'agent.read': get,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    const details = screen.getByText('View details').closest('details') as HTMLElement;
    await user.click(within(details).getByText('View details'));

    await waitFor(() => expect(get).toHaveBeenCalledWith({ agentId: AGENT_READY.id }));
    expect(within(details).getByText(/gpt-authoritative/i)).toBeInTheDocument();
    expect(within(details).getByText(/Authoritative health/i)).toBeInTheDocument();
    expect(within(details).queryByText(/gpt-test/i)).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable View details error without fabricating the failed agent read', async () => {
    const user = userEvent.setup();
    const get = vi
      .fn()
      .mockRejectedValue(new ApiCallError(404, 'Agent not found.', { code: 'not_found' }));
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'agent.read': get,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const details = screen.getByText('View details').closest('details') as HTMLElement;
    await user.click(within(details).getByText('View details'));

    await waitFor(() => expect(get).toHaveBeenCalledWith({ agentId: AGENT_READY.id }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load|try again/i);
    expect(alert).not.toHaveTextContent('Agent not found.');
    expect(within(details).queryByText(/gpt-test/i)).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('updates already-open exact agent detail after health refresh', async () => {
    const user = userEvent.setup();
    const refreshedDetail = {
      ...AGENT_DETAIL,
      health: { status: 'ready', message: 'Rechecked detail', checkedAt: TIMESTAMP_NEW },
    };
    const get = vi.fn().mockResolvedValueOnce(AGENT_DETAIL).mockResolvedValueOnce(refreshedDetail);
    const list = vi
      .fn()
      .mockResolvedValueOnce({ items: [AGENT_READY] })
      .mockResolvedValueOnce({
        items: [{ ...AGENT_READY, health: refreshedDetail.health }],
      });
    const refreshHealth = vi.fn().mockResolvedValue({
      items: [
        {
          agentId: AGENT_READY.id,
          status: refreshedDetail.health.status,
          message: refreshedDetail.health.message,
          checkedAt: refreshedDetail.health.checkedAt,
        },
      ],
    });
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'agent.read': get,
          'agent.list': list,
          'agent.health-refresh': refreshHealth,
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const details = screen.getByText('View details').closest('details') as HTMLElement;
    await user.click(within(details).getByText('View details'));
    await waitFor(() => expect(get).toHaveBeenCalledWith({ agentId: AGENT_READY.id }));
    expect(within(details).getByText(/Authoritative health/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh health/i }));
    await waitFor(() => expect(refreshHealth).toHaveBeenCalledWith({ workspaceId: 'ws1' }));
    expect(refreshHealth).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get.mock.calls).toEqual([[{ agentId: AGENT_READY.id }], [{ agentId: AGENT_READY.id }]]);
    expect(within(details).getByText(/Rechecked detail/i)).toBeInTheDocument();
    expect(within(details).queryByText(/Authoritative health/i)).not.toBeInTheDocument();
  });

  it('clears or scopes a failed health refresh after Workspace switch without retargeting', async () => {
    const user = userEvent.setup();
    const refreshHealth = vi
      .fn()
      .mockRejectedValue(new ApiCallError(500, 'Health refresh rejected.', { code: 'failed' }));
    renderApp(
      '/agents',
      makeClient({
        core: {},
        operations: {
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
          'agent.health-refresh': refreshHealth,
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh health/i }));
    await waitFor(() =>
      expect(refreshHealth).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id })
    );
    expect(refreshHealth).toHaveBeenCalledTimes(1);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't refresh/i);
    expect(alert).not.toHaveTextContent('Health refresh rejected.');

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(
        refreshHealth.mock.calls.every((call) => call[0]?.workspaceId === WORKSPACE_A.id)
      ).toBe(true)
    );
    await proveWriteDoesNotRetarget(user, refreshHealth, WORKSPACE_A.id);
    expect(refreshHealth).not.toHaveBeenCalledWith({ workspaceId: WORKSPACE_B.id });
  });

  it('keeps a failed health refresh retry connection-guarded', async () => {
    const user = userEvent.setup();
    const meta = vi.fn().mockResolvedValue({});
    const refreshHealth = vi
      .fn()
      .mockRejectedValue(new ApiCallError(500, 'Health refresh rejected.', { code: 'failed' }));
    const queryClient = renderApp(
      '/agents',
      makeClient({
        core: { meta },
        operations: {
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
          'agent.health-refresh': refreshHealth,
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh health/i }));
    await waitFor(() =>
      expect(refreshHealth).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id })
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't refresh/i);
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeEnabled();

    meta.mockRejectedValue(new Error('down'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['core', 'meta'] });
    });
    await waitFor(() => {
      expect(screen.getByText('Readiness may be stale')).toBeInTheDocument();
      expect(screen.getByText('Worker read may be stale')).toBeInTheDocument();
    });
    const retry = within(alert).getByRole('button', { name: /try again/i });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(refreshHealth).toHaveBeenCalledTimes(1);
    expect(refreshHealth.mock.calls).toEqual([[{ workspaceId: WORKSPACE_A.id }]]);
  });
});

describe('Agents actual Workers', () => {
  it('keeps configured catalog labeled separately below actual Workers', async () => {
    const listWorkspaceWorkers = vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_A.id,
      items: [workspaceWorker({ stale: true })],
    });
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'worker.list': listWorkspaceWorkers,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    expect(await screen.findByText('Implement inventory')).toBeInTheDocument();
    const workers = screen.getByRole('region', { name: 'Workers' });
    const catalog = screen.getByRole('region', { name: 'Configured agents' });
    expect(
      workers.compareDocumentPosition(catalog) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(within(workers).getByText('Implement inventory')).toBeInTheDocument();
    expect(within(catalog).getByText('Ledger')).toBeInTheDocument();
    expect(within(catalog).getByText('Ready')).toBeInTheDocument();
    expect(within(workers).getByText('Busy')).toBeInTheDocument();
    expect(within(workers).getByText(/Last recorded/)).toBeInTheDocument();
    expect(within(workers).getByText('Setup outdated')).toBeInTheDocument();
    expect(within(workers).queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.queryByText('Worker read may be stale')).not.toBeInTheDocument();
    expect(listWorkspaceWorkers).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id });
  });

  it('keeps catalog-only supply when the Worker read returns no rows', async () => {
    renderApp(
      '/agents',
      makeClient({
        operations: { 'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('No current workers')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Configured agents' })).toHaveTextContent('Ledger');
    expect(screen.queryByRole('link', { name: /open conversation/i })).not.toBeInTheDocument();
  });

  it('does not report an absent selected Workspace as a successful empty Worker read', async () => {
    const listWorkspaceWorkers = vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_A.id,
      items: [],
    });
    renderApp(
      '/agents',
      makeClient({
        core: {},
        operations: {
          'worker.list': listWorkspaceWorkers,
          'workspace.list': vi.fn().mockResolvedValue({
            items: [].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    expect(
      await screen.findByText('Select a Workspace to see current workers.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No current workers')).not.toBeInTheDocument();
    expect(listWorkspaceWorkers).not.toHaveBeenCalled();
  });

  it('keeps two Workers of one Agent distinct by Thread with exact Goal assignment and conversation link', async () => {
    const user = userEvent.setup();
    const listWorkspaceWorkers = vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_A.id,
      items: [
        workspaceWorker({
          threadId: 'th_alpha',
          threadTitle: 'Alpha thread',
          work: {
            kind: 'goal',
            turnId: 'turn_alpha',
            goalId: 'goal_alpha',
            taskId: 'task_alpha',
          },
        }),
        workspaceWorker({
          threadId: 'th_beta',
          threadTitle: 'Beta thread',
          status: 'idle',
          work: { kind: 'none' },
          lastUsedModel: { kind: 'unavailable' },
        }),
      ],
    });
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'worker.list': listWorkspaceWorkers,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    const workers = await screen.findByRole('region', { name: 'Workers' });
    expect(await within(workers).findByText('Alpha thread')).toBeInTheDocument();
    expect(within(workers).getByText('Beta thread')).toBeInTheDocument();
    expect(within(workers).getByText('Goal goal_alpha · Task task_alpha')).toBeInTheDocument();
    expect(within(workers).getByText('No current assignment')).toBeInTheDocument();
    expect(
      within(workers).getByRole('link', { name: 'Open conversation Alpha thread' })
    ).toHaveAttribute('href', `/tasks/${WORKSPACE_A.id}/th_alpha`);
    expect(
      within(workers).getByRole('link', { name: 'Open conversation Beta thread' })
    ).toHaveAttribute('href', `/tasks/${WORKSPACE_A.id}/th_beta`);
    const idleDetails = within(workers)
      .getAllByText('View details')[1]
      ?.closest('details') as HTMLElement;
    await user.click(within(idleDetails).getByText('View details'));
    expect(within(idleDetails).getByText('Last-used model').closest('div')).toHaveTextContent(
      'Unavailable'
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('keeps a Worker visible after it leaves the configured catalog, including long agent and Thread names', async () => {
    const longTitle =
      'Very long Thread title that must wrap inside the existing Agents layout without overlapping refresh actions';
    const longAgent = 'FormerConfiguredAgentWithAnExceptionallyLongDisplayName';
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'worker.list': vi.fn().mockResolvedValue({
            workspaceId: WORKSPACE_A.id,
            items: [
              workspaceWorker({
                agentId: 'agent_retired',
                agentName: longAgent,
                threadTitle: longTitle,
              }),
            ],
          }),
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    const workers = await screen.findByRole('region', { name: 'Workers' });
    expect(await within(workers).findByText(longAgent)).toBeInTheDocument();
    expect(within(workers).getByText(longTitle)).toBeInTheDocument();
    expect(within(workers).queryByText('Ledger')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Configured agents' })).toHaveTextContent('Ledger');
  });

  it('shows package preference, last-used Restricted or Unavailable, and bounded policy details without joining catalog models', async () => {
    const user = userEvent.setup();
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'worker.list': vi.fn().mockResolvedValue({
            workspaceId: WORKSPACE_A.id,
            items: [
              workspaceWorker({
                lastUsedModel: { kind: 'restricted' },
                packageDetails: {
                  kind: 'available',
                  preferredLogicalModelId: 'openai/gpt-preferred',
                  mcpServers: [
                    {
                      id: 'github',
                      allowedTools: ['list_issues'],
                      deniedTools: ['delete_repo'],
                      approvalRequiredTools: ['create_issue'],
                    },
                  ],
                  filesystem: { default: 'deny', enforcement: 'openshell', ruleCount: 1 },
                  network: { default: null, enforcement: null, ruleCount: 2 },
                  process: null,
                },
              }),
            ],
          }),
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    const workers = await screen.findByRole('region', { name: 'Workers' });
    const details = (await within(workers).findByText('View details')).closest(
      'details'
    ) as HTMLElement;
    await user.click(within(details).getByText('View details'));
    expect(within(details).getByText('openai/gpt-preferred')).toBeInTheDocument();
    expect(within(details).getByText('Restricted')).toBeInTheDocument();
    expect(within(details).queryByText('gpt-test')).not.toBeInTheDocument();
    await user.click(within(details).getByText('MCP and tool policy'));
    expect(within(details).getByText('github')).toBeInTheDocument();
    expect(within(details).getByText(/list_issues/)).toBeInTheDocument();
    expect(within(details).getByText(/delete_repo/)).toBeInTheDocument();
    expect(within(details).getByText(/create_issue/)).toBeInTheDocument();
    await user.click(within(details).getByText('Policy summary'));
    expect(
      within(details).getByText(/Filesystem: default deny, enforcement openshell, 1 rule/)
    ).toBeInTheDocument();
    expect(
      within(details).getByText(/Network: default Not reported, enforcement Not reported, 2 rules/)
    ).toBeInTheDocument();
    expect(within(details).getByText('Process: Not recorded')).toBeInTheDocument();
    expect(within(details).queryByText(/Process: Unavailable/)).not.toBeInTheDocument();
  });

  it('does not treat a failed Worker read as an empty success and keeps the catalog', async () => {
    const listWorkspaceWorkers = vi
      .fn()
      .mockRejectedValue(new ApiCallError(500, 'Private worker dump.', { code: 'failed' }));
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'worker.list': listWorkspaceWorkers,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load workers/i);
    expect(alert).not.toHaveTextContent('Private worker dump.');
    expect(screen.queryByText('No current workers')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Configured agents' })).toHaveTextContent('Ledger');
  });

  it('refreshes the Worker read without refreshing catalog health', async () => {
    const user = userEvent.setup();
    const listWorkspaceWorkers = vi
      .fn()
      .mockResolvedValueOnce({
        workspaceId: WORKSPACE_A.id,
        items: [workspaceWorker({ status: 'busy' })],
      })
      .mockResolvedValueOnce({
        workspaceId: WORKSPACE_A.id,
        items: [workspaceWorker({ status: 'idle', work: { kind: 'none' } })],
      });
    const refreshHealth = vi.fn().mockResolvedValue({ items: [] });
    renderApp(
      '/agents',
      makeClient({
        operations: {
          'worker.list': listWorkspaceWorkers,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
          'agent.health-refresh': refreshHealth,
        },
      })
    );

    expect(await screen.findByText('Busy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh workers/i }));
    await waitFor(() => expect(listWorkspaceWorkers).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Idle')).toBeInTheDocument();
    expect(refreshHealth).not.toHaveBeenCalled();
  });

  it('queries Workers only for the selected Workspace and replaces the previous Workspace rows', async () => {
    const user = userEvent.setup();
    const listWorkspaceWorkers = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve({
          workspaceId,
          items:
            workspaceId === WORKSPACE_A.id
              ? [workspaceWorker({ threadTitle: 'Visible A thread', threadId: 'th_a' })]
              : [
                  workspaceWorker({
                    threadTitle: 'Visible B thread',
                    threadId: 'th_b',
                    agentName: 'Scout',
                  }),
                ],
        })
      );
    renderApp(
      '/agents',
      makeClient({
        core: {},
        operations: {
          'worker.list': listWorkspaceWorkers,
          'agent.list': vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    expect(await screen.findByText('Visible A thread')).toBeInTheDocument();
    expect(screen.queryByText('Visible B thread')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(listWorkspaceWorkers).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A.id })
    );

    await user.click(screen.getByRole('button', { name: WORKSPACE_A.name }));
    await user.click(await screen.findByRole('menuitem', { name: WORKSPACE_B.name }));

    expect(await screen.findByText('Visible B thread')).toBeInTheDocument();
    expect(screen.queryByText('Visible A thread')).not.toBeInTheDocument();
    expect(listWorkspaceWorkers).toHaveBeenCalledWith({ workspaceId: WORKSPACE_B.id });
    expect(
      listWorkspaceWorkers.mock.calls.every(
        ([input]) => input.workspaceId === WORKSPACE_A.id || input.workspaceId === WORKSPACE_B.id
      )
    ).toBe(true);
  });
});

describe('Knowledge (board 14)', () => {
  it('stops cancelled draft input before it can edit the next focused field', async () => {
    const cancellation = new AbortController();
    const user = setupKnowledgeUser(cancellation.signal);
    render(<input aria-label="Next draft" defaultValue="Untouched draft" />);
    const nextDraft = screen.getByRole('textbox', { name: 'Next draft' });
    await user.click(nextDraft);

    cancellation.abort(new Error('Draft test timed out'));
    await expect(user.keyboard('Late draft bytes')).rejects.toThrow('Draft test timed out');
    expect(nextDraft).toHaveValue('Untouched draft');
  });

  it('lists knowledge entries', async () => {
    const client = makeClient({
      core: { 'knowledge.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }) },
    });
    renderApp('/knowledge', client);
    expect(await screen.findByText('Write in English; keep answers concise')).toBeInTheDocument();
  });

  it('shows the empty state when there are no entries', async () => {
    renderApp('/knowledge', makeClient());
    expect(await screen.findByText(/No entries yet/i)).toBeInTheDocument();
  });

  it('creates a knowledge entry from the add form', async () => {
    const user = userEvent.setup();
    const createKnowledge = vi.fn().mockResolvedValue(KNOWLEDGE_ENTRY);
    const client = makeClient({ core: { 'knowledge.create': createKnowledge } });
    renderApp('/knowledge', client);
    await screen.findByText(/No entries yet/i);
    await user.click(screen.getByRole('button', { name: /Add knowledge/i }));
    await user.click(screen.getByRole('textbox', { name: 'Title' }));
    await user.paste('Prefer concise memos');
    await user.click(screen.getByRole('textbox', { name: 'Content' }));
    await user.paste('Keep it short.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(createKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws1',
          kind: 'preference',
          title: 'Prefer concise memos',
          content: 'Keep it short.',
        })
      )
    );
  });

  it('disables save when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp('/knowledge', client);
    await waitFor(
      () => expect(screen.getByRole('button', { name: /Add knowledge/i })).toBeDisabled(),
      {
        timeout: 3000,
      }
    );
  });

  it('edits exact server bytes, submits only changed non-empty fields, and waits for the authoritative refetch', async () => {
    const user = userEvent.setup();
    const authoritativeRead = createDeferred<{ items: (typeof KNOWLEDGE_ENTRY)[] }>();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockReturnValueOnce(authoritativeRead.promise);
    const updateKnowledge = vi.fn().mockResolvedValue({
      ...KNOWLEDGE_ENTRY,
      title: 'Mutation response must not become visible',
    });
    renderApp(
      '/knowledge',
      makeClient({ core: { 'knowledge.list': listKnowledge, 'knowledge.update': updateKnowledge } })
    );

    await user.click(await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const content = screen.getByRole('textbox', { name: 'Content' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(title).toHaveValue(KNOWLEDGE_ENTRY.title);
    expect(content).toHaveValue(KNOWLEDGE_ENTRY.content);
    expect(save).toBeDisabled();

    await user.clear(title);
    await user.click(title);
    await user.paste('   ');
    expect(save).toBeDisabled();
    await user.clear(title);
    await user.click(title);
    await user.paste('Prefer concise release notes');
    await user.click(save);

    await waitFor(() =>
      expect(updateKnowledge).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        knowledgeEntryId: KNOWLEDGE_ENTRY.id,
        ...{
          requestId: expect.any(String),
          title: 'Prefer concise release notes',
        },
      })
    );
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.queryByText('Mutation response must not become visible')).not.toBeInTheDocument();

    authoritativeRead.resolve({ items: [UPDATED_KNOWLEDGE_ENTRY] });
    expect(await screen.findByText(UPDATED_KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(UPDATED_KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
  });

  it('preserves authoritative whitespace and submits only the field the user changed', async () => {
    const user = userEvent.setup();
    const entry = {
      ...KNOWLEDGE_ENTRY,
      title: '  Exact server title  ',
      content: '  Exact server content  ',
    };
    const updateKnowledge = vi.fn().mockResolvedValue(entry);
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.list': vi.fn().mockResolvedValue({ items: [entry] }),
          'knowledge.update': updateKnowledge,
        },
      })
    );

    await user.click(await screen.findByRole('button', { name: /Edit Exact server title/i }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const content = screen.getByRole('textbox', { name: 'Content' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(title).toHaveValue(entry.title);
    expect(content).toHaveValue(entry.content);
    expect(save).toBeDisabled();

    await user.clear(content);
    await user.click(content);
    await user.paste('Changed server content');
    await user.click(save);
    await waitFor(() =>
      expect(updateKnowledge).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        knowledgeEntryId: entry.id,
        ...{
          content: 'Changed server content',
          requestId: expect.any(String),
        },
      })
    );
  });

  it('keeps update intent and cached bytes until a failed authoritative refetch is retried', async () => {
    const user = userEvent.setup();
    const mutationResponse = {
      ...KNOWLEDGE_ENTRY,
      title: 'Mutation response is not display authority',
      content: 'Mutation response content',
    };
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockRejectedValueOnce(new Error('authoritative read failed'))
      .mockResolvedValueOnce({ items: [UPDATED_KNOWLEDGE_ENTRY] });
    const updateKnowledge = vi.fn().mockResolvedValue(mutationResponse);
    renderApp(
      '/knowledge',
      makeClient({ core: { 'knowledge.list': listKnowledge, 'knowledge.update': updateKnowledge } })
    );

    await user.click(await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const content = screen.getByRole('textbox', { name: 'Content' });
    await user.clear(content);
    await user.click(content);
    await user.paste('Unsaved local content');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load knowledge.");
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(screen.queryByText(mutationResponse.title)).not.toBeInTheDocument();
    expect(screen.queryByText(mutationResponse.content)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveValue('Unsaved local content');
    expect(updateKnowledge).toHaveBeenCalledTimes(1);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(3));
    expect(updateKnowledge).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(UPDATED_KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(UPDATED_KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Content' })).not.toBeInTheDocument();
  });

  it('confirms removal and keeps the row until the authoritative refetch removes it', async () => {
    const user = userEvent.setup();
    const authoritativeRead = createDeferred<{ items: (typeof KNOWLEDGE_ENTRY)[] }>();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockReturnValueOnce(authoritativeRead.promise);
    const deleteKnowledge = vi.fn().mockResolvedValue(undefined);
    renderApp(
      '/knowledge',
      makeClient({ core: { 'knowledge.delete': deleteKnowledge, 'knowledge.list': listKnowledge } })
    );

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove knowledge' });
    expect(deleteKnowledge).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(deleteKnowledge).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        knowledgeEntryId: KNOWLEDGE_ENTRY.id,
        ...{
          requestId: expect.any(String),
        },
      })
    );
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    authoritativeRead.resolve({ items: [] });
    await waitFor(() => expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument());
  });

  it('keeps a deleted row until a failed authoritative refetch is retried successfully', async () => {
    const user = userEvent.setup();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockRejectedValueOnce(new Error('authoritative read failed'))
      .mockResolvedValueOnce({ items: [] });
    const deleteKnowledge = vi.fn().mockResolvedValue(undefined);
    renderApp(
      '/knowledge',
      makeClient({ core: { 'knowledge.delete': deleteKnowledge, 'knowledge.list': listKnowledge } })
    );

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole('button', {
        name: 'Remove',
      })
    );
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load knowledge.");
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(3));
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument());
  });

  it.each([
    'update',
    'delete',
  ] as const)('keeps authoritative entry bytes and an explicit retry after a failed %s', async (operation) => {
    const user = userEvent.setup();
    const mutation = vi.fn().mockRejectedValue(new Error(`${operation} failed`));
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          [operation === 'update' ? 'knowledge.update' : 'knowledge.delete']: mutation,
        },
      })
    );

    if (operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.click(title);
      await user.paste('Unsaved local wording');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await user.click(
        await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
      );
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't|failed/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(mutation).toHaveBeenCalledTimes(1);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
  });

  it.each([
    'create',
    'update',
    'delete',
  ] as const)('replays the exact Workspace-bound %s command and requestId after an unknown failure', async (operation) => {
    const user = userEvent.setup();
    const privateText = `${operation} failed.`;
    const secondEntry = {
      ...KNOWLEDGE_ENTRY,
      id: 'mem2',
      title: 'Second preference',
      content: 'A later memo.',
    };
    const laterEntry = {
      ...KNOWLEDGE_ENTRY,
      id: 'mem3',
      title: 'Later preference',
      content: 'A fresh semantic edit.',
    };
    const mutation = vi
      .fn()
      .mockRejectedValueOnce(operationFailed(privateText))
      .mockResolvedValueOnce(
        operation === 'delete'
          ? undefined
          : operation === 'update'
            ? UPDATED_KNOWLEDGE_ENTRY
            : KNOWLEDGE_ENTRY
      )
      .mockResolvedValue(operation === 'delete' ? undefined : laterEntry);
    const listKnowledge = vi.fn().mockImplementation(() =>
      Promise.resolve({
        items:
          operation === 'delete'
            ? mutation.mock.calls.length >= 2
              ? [secondEntry]
              : [KNOWLEDGE_ENTRY, secondEntry]
            : operation === 'create' && mutation.mock.calls.length >= 2
              ? [KNOWLEDGE_ENTRY]
              : operation === 'create'
                ? []
                : [KNOWLEDGE_ENTRY],
      })
    );
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.list': listKnowledge,
          [`knowledge.${operation}`]: mutation,
        },
      })
    );

    if (operation === 'create') {
      await screen.findByText(/No entries yet/i);
      await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
      await user.click(screen.getByRole('textbox', { name: 'Title' }));
      await user.paste('Prefer concise memos');
      await user.click(screen.getByRole('textbox', { name: 'Content' }));
      await user.paste('Keep it short.');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.click(title);
      await user.paste('Unsaved local wording');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await user.click(
        await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
      );
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    const firstCall = mutation.mock.calls[0];
    const firstRequestId = requestIdFromCall(firstCall);
    expect(firstCall?.[0]?.workspaceId).toBe(WORKSPACE_A.id);
    expect(typeof firstRequestId).toBe('string');
    await retryScopedAlert(
      user,
      document.body,
      /couldn't (save that entry|save those changes|remove that entry)/i,
      privateText
    );
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    expect(mutation.mock.calls[1]).toEqual(firstCall);
    expect(requestIdFromCall(mutation.mock.calls[1])).toBe(firstRequestId);

    if (operation === 'create') {
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
      );
      await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
      await user.click(screen.getByRole('textbox', { name: 'Title' }));
      await user.paste(laterEntry.title);
      await user.click(screen.getByRole('textbox', { name: 'Content' }));
      await user.paste(laterEntry.content);
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
      );
      await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.click(title);
      await user.paste(laterEntry.title);
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await waitFor(() =>
        expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument()
      );
      await user.click(screen.getByRole('button', { name: `Remove ${secondEntry.title}` }));
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(3));
    expect(mutation.mock.calls[2]?.[0]?.workspaceId).toBe(WORKSPACE_A.id);
    const laterRequestId = requestIdFromCall(mutation.mock.calls[2]);
    expect(typeof laterRequestId).toBe('string');
    expect(laterRequestId).not.toBe(firstRequestId);
  });

  it('blocks a failed mutation retry while a different Knowledge mutation is pending', async () => {
    const user = userEvent.setup();
    const deleteKnowledge = vi.fn().mockRejectedValue(new Error('delete failed'));
    const pendingUpdate = createDeferred<unknown>();
    const updateKnowledge = vi.fn().mockReturnValue(pendingUpdate.promise);
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.delete': deleteKnowledge,
          'knowledge.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          'knowledge.update': updateKnowledge,
        },
      })
    );

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole('button', {
        name: 'Remove',
      })
    );
    const retry = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const content = screen.getByRole('textbox', { name: 'Content' });
    await user.clear(content);
    await user.click(content);
    await user.paste('Pending content change');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateKnowledge).toHaveBeenCalledTimes(1));

    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);
  });

  it.each([
    'checking',
    'failed',
  ] as const)('disables every exposed Knowledge write while the connection is %s', async (connection) => {
    const meta =
      connection === 'checking'
        ? vi.fn().mockReturnValue(new Promise(() => {}))
        : vi.fn().mockRejectedValue(new Error('offline'));
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          meta,
          'knowledge.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
        },
      })
    );

    await screen.findByText(KNOWLEDGE_ENTRY.title);
    const writes = screen
      .getAllByRole('button')
      .filter((button) => /^(Add knowledge|Edit |Remove )/.test(button.textContent ?? ''));
    expect(writes).toHaveLength(3);
    for (const write of writes) expect(write).toBeDisabled();
  });

  it.each([
    'create',
    'update',
    'delete',
  ] as const)('disables all Knowledge writes while a %s mutation is pending', async (operation) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          [`knowledge.${operation}`]: vi.fn().mockReturnValue(pending.promise),
        },
      })
    );

    await screen.findByText(KNOWLEDGE_ENTRY.title);
    if (operation === 'create') {
      await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
      await user.click(screen.getByRole('textbox', { name: 'Title' }));
      await user.paste('New preference');
      await user.click(screen.getByRole('textbox', { name: 'Content' }));
      await user.paste('New content');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.click(title);
      await user.paste('Changed preference');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await user.click(screen.getByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` }));
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    const writes = screen
      .getAllByRole('button')
      .filter((button) => /^(Add knowledge|Edit |Remove|Save)/.test(button.textContent ?? ''));
    expect(writes.length).toBeGreaterThan(1);
    for (const write of writes) expect(write).toBeDisabled();
  });

  it('reads and renders the bounded live Source, Observation, and Claim projections', async () => {
    const listKnowledgeSources = vi.fn().mockResolvedValue({ items: [KNOWLEDGE_SOURCE] });
    const listKnowledgeObservations = vi.fn().mockResolvedValue({ items: [KNOWLEDGE_OBSERVATION] });
    const listKnowledgeClaims = vi.fn().mockResolvedValue({ items: [KNOWLEDGE_CLAIM] });
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          'knowledge.claim.list': listKnowledgeClaims,
          'knowledge.observation.list': listKnowledgeObservations,
          'knowledge.source.list': listKnowledgeSources,
        },
      })
    );

    expect(await screen.findByText(KNOWLEDGE_SOURCE.title)).toBeInTheDocument();
    expect(screen.getByText('Transcript', { selector: ':not(option)' })).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_OBSERVATION.summary)).toBeInTheDocument();
    expect(screen.getByText('Retained')).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_CLAIM.statement)).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toHaveClass('bg-notice-bg', 'text-notice-fg');
    expect(screen.getByText('Weak evidence')).toBeInTheDocument();
    const statusBackgroundClasses = [
      'bg-info-bg',
      'bg-notice-bg',
      'bg-positive-bg',
      'bg-negative-bg',
      'bg-neutral-bg',
    ];
    for (const label of ['Transcript', 'Retained', 'Weak evidence']) {
      const metadata = screen.getByText(label, { selector: ':not(option)' });
      for (const statusClass of statusBackgroundClasses) {
        expect(metadata).not.toHaveClass(statusClass);
      }
    }
    for (const rawValue of ['transcript', 'retained', 'needs-review', 'weak_evidence']) {
      expect(document.body).not.toHaveTextContent(rawValue);
    }
    expect(listKnowledgeSources).toHaveBeenCalledWith({ workspaceId: 'ws1' });
    expect(listKnowledgeObservations).toHaveBeenCalledWith({ workspaceId: 'ws1' });
    expect(listKnowledgeClaims).toHaveBeenCalledWith({ workspaceId: 'ws1' });
  });

  it('keeps a Loading skeleton visible until the attention read settles', async () => {
    const attentionRead = createDeferred<{ items: [] }>();
    renderApp(
      '/knowledge',
      makeClient({
        operations: { 'attention.list': vi.fn().mockReturnValue(attentionRead.promise) },

        core: { 'knowledge.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }) },
      })
    );

    expect(await screen.findByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();

    attentionRead.resolve({ items: [] });
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument()
    );
  });

  it('leaves a failed bounded Store read retryable', async () => {
    const user = userEvent.setup();
    const listKnowledgeSources = vi
      .fn()
      .mockRejectedValueOnce(new Error('source read failed'))
      .mockResolvedValue({ items: [] });
    renderApp('/knowledge', makeClient({ app: { 'knowledge.source.list': listKnowledgeSources } }));

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listKnowledgeSources).toHaveBeenCalledTimes(2));
  });

  it('retries only the failed initial attention read', async () => {
    const user = userEvent.setup();
    const listHumanAttention = vi
      .fn()
      .mockRejectedValueOnce(new Error('attention read failed'))
      .mockResolvedValue({ items: [] });
    const listKnowledgeSources = vi.fn().mockResolvedValue({ items: [] });
    const listKnowledgeObservations = vi.fn().mockResolvedValue({ items: [] });
    const listKnowledgeClaims = vi.fn().mockResolvedValue({ items: [] });
    const submitKnowledgeProposalDecision = vi.fn();
    renderApp(
      '/knowledge',
      makeClient({
        operations: { 'attention.list': listHumanAttention },
        app: {
          'knowledge.claim.list': listKnowledgeClaims,
          'knowledge.observation.list': listKnowledgeObservations,
          'knowledge.source.list': listKnowledgeSources,
          'knowledge.proposal.decide': submitKnowledgeProposalDecision,
        },
      })
    );

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
    expect(listKnowledgeSources).toHaveBeenCalledTimes(1);
    expect(listKnowledgeObservations).toHaveBeenCalledTimes(1);
    expect(listKnowledgeClaims).toHaveBeenCalledTimes(1);
    expect(submitKnowledgeProposalDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['Accept', 'accept_knowledge', 'accepted'],
    ['Reject', 'reject_knowledge', 'rejected'],
    ['Defer', 'defer', 'deferred'],
  ] as const)('maps only the exact %s action from the Knowledge attention row', async (label, actionKind, decision) => {
    const user = userEvent.setup();
    const submitKnowledgeProposalDecision = vi.fn().mockResolvedValue({});
    const row = {
      ...KNOWLEDGE_PROPOSAL_ROW,
      actions: [{ kind: actionKind, label, method: 'POST' }],
    };
    renderApp(
      '/knowledge',
      makeClient({
        operations: {
          'attention.list': vi
            .fn()
            .mockResolvedValue({ items: [NON_KNOWLEDGE_PROPOSAL_DECOY, row] }),
        },
        app: { 'knowledge.proposal.decide': submitKnowledgeProposalDecision },
      })
    );

    const action = await screen.findByRole('button', { name: label });
    for (const absentLabel of ['Accept', 'Reject', 'Defer'].filter((item) => item !== label)) {
      expect(screen.queryByRole('button', { name: absentLabel })).not.toBeInTheDocument();
    }
    await user.click(action);
    await waitFor(() =>
      expect(submitKnowledgeProposalDecision).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        proposalId: 'kp_exact',
        ...{
          decision,
          requestId: expect.any(String),
        },
      })
    );
    expect(screen.queryByText(NON_KNOWLEDGE_PROPOSAL_DECOY.title)).not.toBeInTheDocument();
  });

  it('omits unsupported proposal actions and exposes the disabled action reason', async () => {
    const user = userEvent.setup();
    const submitKnowledgeProposalDecision = vi.fn();
    const reason = 'The proposal is not ready for acceptance.';
    const row = {
      ...KNOWLEDGE_PROPOSAL_ROW,
      actions: [
        {
          kind: 'accept_knowledge',
          label: 'Accept',
          method: 'POST',
          disabled: true,
          reason,
        },
        { kind: 'open_thread', label: 'Unsupported proposal action', method: 'GET' },
      ],
    };
    renderApp(
      '/knowledge',
      makeClient({
        operations: { 'attention.list': vi.fn().mockResolvedValue({ items: [row] }) },
        app: { 'knowledge.proposal.decide': submitKnowledgeProposalDecision },
      })
    );

    const accept = await screen.findByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Unsupported proposal action' })
    ).not.toBeInTheDocument();
    await user.click(accept);
    expect(submitKnowledgeProposalDecision).not.toHaveBeenCalled();
  });

  it('keeps proposal visibility authoritative until attention refetch settles', async () => {
    const user = userEvent.setup();
    const authoritativeRead = createDeferred<{ items: (typeof KNOWLEDGE_PROPOSAL_ROW)[] }>();
    const successfulRead = createDeferred<{ items: (typeof KNOWLEDGE_PROPOSAL_ROW)[] }>();
    const listHumanAttention = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_PROPOSAL_ROW] })
      .mockReturnValueOnce(authoritativeRead.promise)
      .mockReturnValueOnce(successfulRead.promise);
    const decisionPost = createDeferred<unknown>();
    const submitKnowledgeProposalDecision = vi.fn().mockReturnValue(decisionPost.promise);
    renderApp(
      '/knowledge',
      makeClient({
        operations: { 'attention.list': listHumanAttention },
        app: { 'knowledge.proposal.decide': submitKnowledgeProposalDecision },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1));
    for (const label of ['Accept', 'Reject', 'Defer']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);

    decisionPost.resolve({ review: { decision: 'accepted' } });
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    for (const label of ['Accept', 'Reject', 'Defer']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }

    authoritativeRead.reject(new Error('authoritative attention refetch failed'));
    const alert = await screen.findByRole('alert');
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(3));
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();

    successfulRead.resolve({ items: [] });
    await waitFor(() =>
      expect(screen.queryByText(KNOWLEDGE_PROPOSAL_ROW.title)).not.toBeInTheDocument()
    );
  });

  it('preserves a failed proposal row for explicit fresh-request retry without replay', async () => {
    const user = userEvent.setup();
    const submitKnowledgeProposalDecision = vi.fn().mockRejectedValue(new Error('decision failed'));
    renderApp(
      '/knowledge',
      makeClient({
        operations: {
          'attention.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_PROPOSAL_ROW] }),
        },
        app: { 'knowledge.proposal.decide': submitKnowledgeProposalDecision },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const alert = await screen.findByRole('alert');
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    const firstRequestId = submitKnowledgeProposalDecision.mock.calls[0]?.[0].requestId;

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(2));
    expect(submitKnowledgeProposalDecision.mock.calls[1]?.[0].requestId).not.toBe(firstRequestId);
  });

  it('does not render or retry a Workspace A proposal decision failure in Workspace B', async () => {
    const user = userEvent.setup();
    const proposalB = {
      ...KNOWLEDGE_PROPOSAL_ROW,
      id: 'proposal-b',
      title: 'Review knowledge proposal for workspace B',
      source: {
        ...KNOWLEDGE_PROPOSAL_ROW.source,
        knowledgeProposalId: 'kp_b',
        workspaceId: WORKSPACE_B.id,
      },
    };
    const submitKnowledgeProposalDecision = vi
      .fn()
      .mockRejectedValue(operationFailed('decision failed.'));
    const listHumanAttention = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve({
          items: workspaceId === WORKSPACE_B.id ? [proposalB] : [KNOWLEDGE_PROPOSAL_ROW],
        })
      );
    renderApp(
      '/knowledge',
      makeClient({
        core: {},
        app: { 'knowledge.proposal.decide': submitKnowledgeProposalDecision },

        operations: {
          'attention.list': listHumanAttention,

          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't submit that proposal decision/i);
    expect(alert).not.toHaveTextContent('decision failed.');
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    expect(submitKnowledgeProposalDecision.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_A.id);
    expect(submitKnowledgeProposalDecision.mock.calls[0]?.[0]?.proposalId).toBe('kp_exact');
    const firstRequestId = requestIdFromCall(submitKnowledgeProposalDecision.mock.calls[0]);
    expect(typeof firstRequestId).toBe('string');

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByText(proposalB.title)).toBeInTheDocument();
    expect(screen.queryByText(KNOWLEDGE_PROPOSAL_ROW.title)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    expect(callsOn(submitKnowledgeProposalDecision, WORKSPACE_B.id)).toHaveLength(0);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_A.id }));
    expect(await screen.findByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    await retryScopedAlert(
      user,
      document.body,
      /couldn't submit that proposal decision/i,
      'decision failed.'
    );
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(2));
    expect(submitKnowledgeProposalDecision.mock.calls[1]).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_A.id,
        proposalId: 'kp_exact',
        decision: 'rejected',
      }),
    ]);
    const secondRequestId = requestIdFromCall(submitKnowledgeProposalDecision.mock.calls[1]);
    expect(typeof secondRequestId).toBe('string');
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(callsOn(submitKnowledgeProposalDecision, WORKSPACE_A.id)).toHaveLength(2);
    expect(callsOn(submitKnowledgeProposalDecision, WORKSPACE_B.id)).toHaveLength(0);
  });

  it.each([
    'checking',
    'failed',
  ] as const)('disables proposal decisions while the connection is %s', async (connection) => {
    const meta =
      connection === 'checking'
        ? vi.fn().mockReturnValue(new Promise(() => {}))
        : vi.fn().mockRejectedValue(new Error('offline'));
    renderApp(
      '/knowledge',
      makeClient({
        operations: {
          'attention.list': vi.fn().mockResolvedValue({ items: [KNOWLEDGE_PROPOSAL_ROW] }),
        },

        core: { meta },
      })
    );

    await screen.findByText(KNOWLEDGE_PROPOSAL_ROW.title);
    await waitFor(() => {
      for (const label of ['Accept', 'Reject', 'Defer']) {
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
      }
    });
  });

  it('registers a source from the Sources panel, refetches the list, and reads the selected source', async () => {
    const user = userEvent.setup();
    const authoritativeSources = createDeferred<{ items: (typeof KNOWLEDGE_SOURCE)[] }>();
    const listKnowledgeSources = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_SOURCE] })
      .mockReturnValueOnce(authoritativeSources.promise);
    const registerKnowledgeSource = vi.fn().mockResolvedValue({
      source: { ...REGISTERED_SOURCE, title: 'Mutation source must not become visible' },
      derivedRepresentations: [SOURCE_DERIVED_REPRESENTATION],
    });
    const readKnowledgeSource = vi.fn().mockResolvedValue({
      source: KNOWLEDGE_SOURCE,
      derivedRepresentations: [SOURCE_DERIVED_REPRESENTATION],
    });
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          'knowledge.source.list': listKnowledgeSources,
          'knowledge.source.read': readKnowledgeSource,
          'knowledge.source.register': registerKnowledgeSource,
        },
      })
    );

    expect(await screen.findByText(KNOWLEDGE_SOURCE.title)).toBeInTheDocument();
    const sources = knowledgePanel('Sources');
    await selectListedOption(user, sources, 'Source kind', SOURCE_KIND_OPTION);
    await fillKnowledgeFields(user, sources, [
      ['Source title', REGISTER_SOURCE_INPUT.title],
      ['Source content', REGISTER_SOURCE_INPUT.content],
    ]);
    await user.click(within(sources).getByRole('button', { name: 'Register source' }));
    await waitFor(() =>
      expect(registerKnowledgeSource).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        ...{
          requestId: expect.any(String),
          kind: REGISTER_SOURCE_INPUT.kind,
          title: REGISTER_SOURCE_INPUT.title,
          content: REGISTER_SOURCE_INPUT.content,
        },
      })
    );
    await waitFor(() => expect(listKnowledgeSources).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Mutation source must not become visible')).not.toBeInTheDocument();
    expect(registerKnowledgeSource).toHaveBeenCalledTimes(1);

    authoritativeSources.resolve({ items: [KNOWLEDGE_SOURCE, REGISTERED_SOURCE] });
    expect(await within(sources).findByText(REGISTERED_SOURCE.title)).toBeInTheDocument();
    await user.click(
      within(sources).getByRole('button', { name: `View ${KNOWLEDGE_SOURCE.title}` })
    );
    await waitFor(() =>
      expect(readKnowledgeSource).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        sourceId: KNOWLEDGE_SOURCE.id,
      })
    );
    expect(within(sources).getByText('Text')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SOURCE_DERIVED_REPRESENTATION.path);
    expect(readKnowledgeSource).toHaveBeenCalledTimes(1);
  });

  it('records ledger rows from the Ledger panel, lists conflicts, and resolves through an accessible control', async ({
    signal,
  }) => {
    const user = setupKnowledgeUser(signal);
    const listKnowledgeObservations = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [SERVER_OBSERVATION] });
    const listKnowledgeClaims = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [SERVER_CLAIM] });
    const listKnowledgeConflicts = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_CONFLICT] })
      .mockResolvedValueOnce({ items: [KNOWLEDGE_CONFLICT, SERVER_CONFLICT] })
      .mockResolvedValue({ items: [SERVER_RESOLVED_CONFLICT] });
    const recordKnowledgeObservation = vi.fn().mockResolvedValue({
      observation: {
        ...SERVER_OBSERVATION,
        summary: 'Mutation observation must not become visible',
      },
    });
    const recordKnowledgeClaim = vi.fn().mockResolvedValue({
      claim: { ...SERVER_CLAIM, statement: 'Mutation claim must not become visible' },
    });
    const recordKnowledgeConflict = vi.fn().mockResolvedValue({
      conflict: { ...SERVER_CONFLICT, summary: 'Mutation conflict must not become visible' },
    });
    const resolveKnowledgeConflict = vi.fn().mockResolvedValue({
      conflict: {
        ...SERVER_RESOLVED_CONFLICT,
        resolution: 'Mutation resolution is not authority',
      },
    });
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          'knowledge.claim.list': listKnowledgeClaims,
          'knowledge.conflict.list': listKnowledgeConflicts,
          'knowledge.observation.list': listKnowledgeObservations,
          'knowledge.claim.record': recordKnowledgeClaim,
          'knowledge.conflict.record': recordKnowledgeConflict,
          'knowledge.observation.record': recordKnowledgeObservation,
          'knowledge.conflict.resolve': resolveKnowledgeConflict,
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const ledger = knowledgePanel('Ledger');
    expect(
      await within(ledger).findByText(KNOWLEDGE_CONFLICT.summary, {
        selector: ':not(option)',
      })
    ).toBeInTheDocument();
    expect(listKnowledgeConflicts.mock.calls).toEqual([[{ workspaceId: 'ws1' }]]);

    await selectListedOption(user, ledger, 'Observation kind', OBSERVATION_KIND_OPTION);
    await fillKnowledgeFields(user, ledger, [
      ['Observation summary', KNOWLEDGE_OBSERVATION.summary],
      ['Observation producer', KNOWLEDGE_OBSERVATION.producer],
    ]);
    await user.click(within(ledger).getByRole('button', { name: 'Record observation' }));
    await waitFor(() =>
      expect(recordKnowledgeObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws1',
          requestId: expect.any(String),
          kind: OBSERVATION_KIND,
          summary: KNOWLEDGE_OBSERVATION.summary,
          producer: KNOWLEDGE_OBSERVATION.producer,
        })
      )
    );
    await waitFor(() => expect(listKnowledgeObservations).toHaveBeenCalledTimes(2));
    expect(listKnowledgeObservations.mock.calls).toEqual([
      [{ workspaceId: 'ws1' }],
      [{ workspaceId: 'ws1' }],
    ]);
    expect(await within(ledger).findByText(SERVER_OBSERVATION.summary)).toBeInTheDocument();
    expect(
      screen.queryByText('Mutation observation must not become visible')
    ).not.toBeInTheDocument();

    await fillKnowledgeFields(user, ledger, [
      ['Claim statement', KNOWLEDGE_CLAIM.statement],
      ['Claim producer', KNOWLEDGE_CLAIM.producer],
    ]);
    await user.click(within(ledger).getByRole('button', { name: 'Record claim' }));
    await waitFor(() =>
      expect(recordKnowledgeClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws1',
          requestId: expect.any(String),
          statement: KNOWLEDGE_CLAIM.statement,
          producer: KNOWLEDGE_CLAIM.producer,
        })
      )
    );
    await waitFor(() => expect(listKnowledgeClaims).toHaveBeenCalledTimes(2));
    expect(listKnowledgeClaims.mock.calls).toEqual([
      [{ workspaceId: 'ws1' }],
      [{ workspaceId: 'ws1' }],
    ]);
    expect(await within(ledger).findByText(SERVER_CLAIM.statement)).toBeInTheDocument();
    expect(screen.queryByText('Mutation claim must not become visible')).not.toBeInTheDocument();

    await fillKnowledgeFields(user, ledger, [
      ['Conflict summary', CONFLICT_SUMMARY],
      ['Subject references', KNOWLEDGE_CONFLICT.subjectReferences.join(' ')],
      ['Conflict producer', KNOWLEDGE_CONFLICT.producer],
    ]);
    await user.click(within(ledger).getByRole('button', { name: 'Record conflict' }));
    await waitFor(() =>
      expect(recordKnowledgeConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws1',
          requestId: expect.any(String),
          summary: CONFLICT_SUMMARY,
          subjectReferences: KNOWLEDGE_CONFLICT.subjectReferences,
          producer: KNOWLEDGE_CONFLICT.producer,
        })
      )
    );
    await waitFor(() => expect(listKnowledgeConflicts).toHaveBeenCalledTimes(2));
    expect(listKnowledgeConflicts.mock.calls).toEqual([
      [{ workspaceId: 'ws1' }],
      [{ workspaceId: 'ws1' }],
    ]);
    expect(
      await within(ledger).findByText(SERVER_CONFLICT.summary, {
        selector: ':not(option)',
      })
    ).toBeInTheDocument();
    expect(screen.queryByText('Mutation conflict must not become visible')).not.toBeInTheDocument();

    await selectListedOption(user, ledger, 'Conflict', KNOWLEDGE_CONFLICT.summary);
    await fillKnowledgeFields(user, ledger, [
      ['Resolution', CONFLICT_RESOLUTION],
      ['Resolved by', 'user:test'],
    ]);
    await user.click(within(ledger).getByRole('button', { name: 'Resolve conflict' }));
    await waitFor(() =>
      expect(resolveKnowledgeConflict).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        conflictId: KNOWLEDGE_CONFLICT.id,
        ...{
          requestId: expect.any(String),
          resolution: CONFLICT_RESOLUTION,
          resolvedBy: 'user:test',
        },
      })
    );
    await waitFor(() => expect(listKnowledgeConflicts).toHaveBeenCalledTimes(3));
    expect(listKnowledgeConflicts.mock.calls).toEqual([
      [{ workspaceId: 'ws1' }],
      [{ workspaceId: 'ws1' }],
      [{ workspaceId: 'ws1' }],
    ]);
    expect(screen.queryByText('Mutation resolution is not authority')).not.toBeInTheDocument();
    expect(
      await within(ledger).findByText(SERVER_RESOLVED_CONFLICT.resolution)
    ).toBeInTheDocument();
    expect(resolveKnowledgeConflict).toHaveBeenCalledTimes(1);
  });

  it('reads indexes then retrieves and prepares context from the Retrieval panel', async () => {
    const user = userEvent.setup();
    const readKnowledgeIndexes = vi.fn().mockResolvedValue(KNOWLEDGE_INDEXES);
    const retrieveKnowledge = vi.fn().mockResolvedValue(KNOWLEDGE_RETRIEVAL);
    const prepareKnowledgeContext = vi.fn().mockResolvedValue(KNOWLEDGE_CONTEXT);
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          'knowledge.context.prepare': prepareKnowledgeContext,
          'knowledge.indexes': readKnowledgeIndexes,
          'knowledge.retrieval': retrieveKnowledge,
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const retrieval = knowledgePanel('Retrieval');
    await waitFor(() => expect(readKnowledgeIndexes).toHaveBeenCalledWith({ workspaceId: 'ws1' }));
    expect(await within(retrieval).findByText('weekly')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('knowledge/pages/mem1.md');

    await fillKnowledgeFields(user, retrieval, [['Query', RETRIEVAL_QUERY]]);
    await user.click(within(retrieval).getByRole('button', { name: 'Retrieve' }));
    await waitFor(() =>
      expect(retrieveKnowledge).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        ...{ query: RETRIEVAL_QUERY },
      })
    );
    expect(await within(retrieval).findByText(RETRIEVAL_TRACE_ID)).toBeInTheDocument();
    expect(within(retrieval).getByText(KNOWLEDGE_ENTRY.id)).toBeInTheDocument();
    expect(within(retrieval).getByText('Sensitive content')).toBeInTheDocument();
    expect(screen.queryByText('sensitive_content')).not.toBeInTheDocument();

    await user.click(within(retrieval).getByRole('button', { name: 'Prepare context' }));
    await waitFor(() =>
      expect(prepareKnowledgeContext).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        ...{ query: RETRIEVAL_QUERY },
      })
    );
    expect(await within(retrieval).findByText('prepared')).toBeInTheDocument();
    expect(readKnowledgeIndexes).toHaveBeenCalledTimes(1);
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
    expect(prepareKnowledgeContext).toHaveBeenCalledTimes(1);
  });

  it('shows selected retrieval titles, bounded current previews, and content links without excluded content', async () => {
    const user = userEvent.setup();
    const first = {
      ...KNOWLEDGE_ENTRY,
      content: `${'Current knowledge. '.repeat(30)}Full ending.`,
    };
    const second = { ...KNOWLEDGE_ENTRY_B, id: 'mem2', title: 'Second selected page' };
    const excluded = {
      ...KNOWLEDGE_ENTRY,
      id: 'old-plan',
      title: 'Excluded private plan',
      content: 'Excluded plan content must not become a retrieval preview.',
    };
    const trace = {
      ...KNOWLEDGE_RETRIEVAL,
      selected: [
        KNOWLEDGE_RETRIEVAL.selected[0],
        { ...KNOWLEDGE_RETRIEVAL.selected[0], knowledgePageId: second.id },
        { ...KNOWLEDGE_RETRIEVAL.selected[0], knowledgePageId: 'missing-page' },
      ],
    };
    const listKnowledge = vi.fn().mockResolvedValue({ items: [excluded, second, first] });
    const retrieveKnowledge = vi.fn().mockResolvedValue(trace);
    renderApp(
      '/knowledge',
      makeClient({
        core: { 'knowledge.list': listKnowledge },
        app: { 'knowledge.retrieval': retrieveKnowledge },
      })
    );
    await screen.findByRole('heading', { level: 1, name: 'Knowledge' });
    const retrieval = knowledgePanel('Retrieval');
    await fillKnowledgeFields(user, retrieval, [['Query', RETRIEVAL_QUERY]]);
    await user.click(within(retrieval).getByRole('button', { name: 'Retrieve' }));
    await within(retrieval).findByText(trace.traceId);

    expect(within(retrieval).getByText(first.title)).toBeInTheDocument();
    expect(within(retrieval).getByText(`${first.content.slice(0, 240)}…`)).toBeInTheDocument();
    expect(within(retrieval).queryByText(first.content)).not.toBeInTheDocument();
    expect(within(retrieval).getByText(second.title)).toBeInTheDocument();
    expect(within(retrieval).getByText(second.content)).toBeInTheDocument();
    expect(
      within(retrieval).getByText('Current content; may differ from the recorded retrieval.')
    ).toBeInTheDocument();
    const hits = within(retrieval).getAllByRole('listitem');
    expect(hits).toHaveLength(3);
    for (const [index, selected] of trace.selected.entries()) {
      expect(within(hits[index]).getByText(selected.knowledgePageId)).toBeInTheDocument();
    }
    expect(within(hits[2]).getByText('Current content unavailable.')).toBeInTheDocument();
    expect(within(hits[2]).queryByRole('link')).not.toBeInTheDocument();
    for (const entry of [first, second]) {
      const link = within(retrieval).getByRole('link', {
        name: `View current content: ${entry.title}`,
      });
      const target = document.getElementById(
        decodeURIComponent(link.getAttribute('href')?.slice(1) ?? '')
      );
      expect(target).not.toBeNull();
      expect(target).toHaveTextContent(entry.title);
      expect(target).toHaveTextContent(entry.content);
      expect(target).toHaveAttribute('tabindex', '-1');
      expect(retrieval).not.toContainElement(target);
    }
    expect(within(retrieval).queryByText(excluded.title)).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(excluded.content)).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(excluded.id)).not.toBeInTheDocument();
    expect(within(retrieval).getByText('Sensitive content')).toBeInTheDocument();
    expect(listKnowledge.mock.calls).toEqual([[{ workspaceId: WORKSPACE_A.id }]]);
    expect(retrieveKnowledge.mock.calls).toEqual([
      [{ workspaceId: WORKSPACE_A.id, ...{ query: RETRIEVAL_QUERY } }],
    ]);
  });

  it('keeps the retrieval trace while current content changes or becomes unavailable', async () => {
    const user = userEvent.setup();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockResolvedValueOnce({ items: [UPDATED_KNOWLEDGE_ENTRY] })
      .mockResolvedValue({ items: [] });
    const retrieveKnowledge = vi.fn().mockResolvedValue(KNOWLEDGE_RETRIEVAL);
    const queryClient = renderApp(
      '/knowledge',
      makeClient({
        core: { 'knowledge.list': listKnowledge },
        app: { 'knowledge.retrieval': retrieveKnowledge },
      })
    );
    await screen.findByRole('heading', { level: 1, name: 'Knowledge' });
    const retrieval = knowledgePanel('Retrieval');
    await fillKnowledgeFields(user, retrieval, [['Query', RETRIEVAL_QUERY]]);
    await user.click(within(retrieval).getByRole('button', { name: 'Retrieve' }));
    expect(await within(retrieval).findByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.knowledge(WORKSPACE_A.id) });
    });
    expect(await within(retrieval).findByText(UPDATED_KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(within(retrieval).getByText(UPDATED_KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(within(retrieval).queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.knowledge(WORKSPACE_A.id) });
    });
    expect(await within(retrieval).findByText('Current content unavailable.')).toBeInTheDocument();
    expect(within(retrieval).queryByRole('link')).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(UPDATED_KNOWLEDGE_ENTRY.content)).not.toBeInTheDocument();
    expect(within(retrieval).getByText(RETRIEVAL_TRACE_ID)).toBeInTheDocument();
    expect(within(retrieval).getByText(KNOWLEDGE_ENTRY.id)).toBeInTheDocument();
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'access denial', error: accessDenied('Private permission details') },
    { name: 'read failure', error: operationFailed('Private storage details') },
  ])('does not compose cached retrieval content after current Knowledge $name', async ({
    error,
  }) => {
    const user = userEvent.setup();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockRejectedValue(error);
    const queryClient = renderApp(
      '/knowledge',
      makeClient({
        core: { 'knowledge.list': listKnowledge },
        app: { 'knowledge.retrieval': vi.fn().mockResolvedValue(KNOWLEDGE_RETRIEVAL) },
      })
    );
    await screen.findByRole('heading', { level: 1, name: 'Knowledge' });
    const retrieval = knowledgePanel('Retrieval');
    await fillKnowledgeFields(user, retrieval, [['Query', RETRIEVAL_QUERY]]);
    await user.click(within(retrieval).getByRole('button', { name: 'Retrieve' }));
    expect(await within(retrieval).findByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.knowledge(WORKSPACE_A.id) });
    });

    // TanStack retains the previous data on a failed refetch; it is not current read authority.
    expect(queryClient.getQueryData(workspaceKeys.knowledge(WORKSPACE_A.id))).toEqual([
      KNOWLEDGE_ENTRY,
    ]);
    expect(await within(retrieval).findByText('Current content unavailable.')).toBeInTheDocument();
    expect(within(retrieval).queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(KNOWLEDGE_ENTRY.content)).not.toBeInTheDocument();
    expect(within(retrieval).queryByRole('link')).not.toBeInTheDocument();
    expect(within(retrieval).getByText(RETRIEVAL_TRACE_ID)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(error.message);
  });

  it('does not compose a late Workspace A retrieval with Workspace B current content', async () => {
    const user = userEvent.setup();
    const pending = createDeferred<typeof KNOWLEDGE_RETRIEVAL>();
    const collidingB = { ...KNOWLEDGE_ENTRY_B, id: KNOWLEDGE_ENTRY.id };
    const retrieveKnowledge = vi.fn().mockReturnValue(pending.promise);
    const queryClient = renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.list': vi
            .fn()
            .mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
              items: workspaceId === WORKSPACE_A.id ? [KNOWLEDGE_ENTRY] : [collidingB],
            })),
        },
        app: { 'knowledge.retrieval': retrieveKnowledge },

        operations: {
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );
    await screen.findByRole('heading', { level: 1, name: 'Knowledge' });
    await fillKnowledgeFields(user, knowledgePanel('Retrieval'), [['Query', RETRIEVAL_QUERY]]);
    await user.click(within(knowledgePanel('Retrieval')).getByRole('button', { name: 'Retrieve' }));
    await waitFor(() => expect(retrieveKnowledge).toHaveBeenCalledTimes(1));
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await screen.findByText(collidingB.title);
    await act(async () => {
      pending.resolve(KNOWLEDGE_RETRIEVAL);
    });
    await waitFor(() =>
      expect(queryClient.getMutationCache().getAll()[0].state.status).toBe('success')
    );

    const retrieval = knowledgePanel('Retrieval');
    expect(within(retrieval).queryByText(RETRIEVAL_TRACE_ID)).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(collidingB.title)).not.toBeInTheDocument();
    expect(within(retrieval).queryByText(collidingB.content)).not.toBeInTheDocument();
    expect(within(retrieval).queryByRole('link')).not.toBeInTheDocument();
    expect(retrieveKnowledge.mock.calls).toEqual([
      [{ workspaceId: WORKSPACE_A.id, ...{ query: RETRIEVAL_QUERY } }],
    ]);
  });

  it('answers, suggests repairs, and inspects health from the Manager panel', async () => {
    const user = userEvent.setup();
    const answerKnowledgeManager = vi.fn().mockResolvedValue(KNOWLEDGE_ANSWER);
    const suggestKnowledgeRepairs = vi.fn().mockResolvedValue(KNOWLEDGE_REPAIRS);
    const checkKnowledgeHealth = vi.fn().mockResolvedValue(KNOWLEDGE_HEALTH);
    const draftKnowledgeProposal = vi.fn();
    const reverseKnowledgeProposal = vi.fn();
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          'knowledge.answer': answerKnowledgeManager,
          'knowledge.health.check': checkKnowledgeHealth,
          'knowledge.proposal.draft': draftKnowledgeProposal,
          'knowledge.proposal.reverse': reverseKnowledgeProposal,
          'knowledge.repair.suggest': suggestKnowledgeRepairs,
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const manager = knowledgePanel('Manager');
    expect(
      within(manager).queryByRole('button', { name: 'Draft proposal' })
    ).not.toBeInTheDocument();
    expect(
      within(manager).queryByRole('button', { name: 'Reverse proposal' })
    ).not.toBeInTheDocument();

    await fillKnowledgeFields(user, manager, [['Question', MANAGER_QUESTION]]);
    await user.click(within(manager).getByRole('button', { name: 'Answer' }));
    await waitFor(() =>
      expect(answerKnowledgeManager).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        ...{ query: MANAGER_QUESTION },
      })
    );
    expect(await within(manager).findByText(KNOWLEDGE_ANSWER.answer)).toBeInTheDocument();

    await user.click(within(manager).getByRole('button', { name: 'Suggest repairs' }));
    await user.click(within(manager).getByRole('button', { name: 'Check health' }));
    await waitFor(() =>
      expect(suggestKnowledgeRepairs).toHaveBeenCalledWith({ workspaceId: 'ws1', ...{ limit: 10 } })
    );
    await waitFor(() =>
      expect(checkKnowledgeHealth).toHaveBeenCalledWith({ workspaceId: 'ws1', ...{ limit: 10 } })
    );
    expect(await within(manager).findByText(KNOWLEDGE_HEALTH.summary)).toBeInTheDocument();
    expect(within(manager).getByText(KNOWLEDGE_REPAIR.title)).toBeInTheDocument();
    expect(draftKnowledgeProposal).not.toHaveBeenCalled();
    expect(reverseKnowledgeProposal).not.toHaveBeenCalled();
    expect(answerKnowledgeManager).toHaveBeenCalledTimes(1);
    expect(suggestKnowledgeRepairs).toHaveBeenCalledTimes(1);
    expect(checkKnowledgeHealth).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      method: 'knowledge.source.register',
      panel: 'Sources' as const,
      kind: 'failed',
      privateText: 'Source register rejected.',
      error: operationFailed('Source register rejected.'),
      message: /couldn't register/i,
      action: 'Register source',
      selects: [{ name: 'Source kind', option: SOURCE_KIND_OPTION }],
      fields: [
        ['Source title', REGISTER_SOURCE_INPUT.title],
        ['Source content', REGISTER_SOURCE_INPUT.content],
      ] as const,
      success: {
        source: { ...REGISTERED_SOURCE, title: 'Mutation source must not become visible' },
        derivedRepresentations: [],
      },
      owner: {
        method: 'knowledge.source.list' as const,
        initial: { items: [KNOWLEDGE_SOURCE] },
        after: { items: [KNOWLEDGE_SOURCE, REGISTERED_SOURCE] },
      },
      result: REGISTERED_SOURCE.title,
      echo: 'Mutation source must not become visible',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            kind: REGISTER_SOURCE_INPUT.kind,
            title: REGISTER_SOURCE_INPUT.title,
            content: REGISTER_SOURCE_INPUT.content,
          }),
        ],
      ],
    },
    {
      method: 'knowledge.source.read',
      panel: 'Sources' as const,
      kind: 'failed',
      privateText: 'Source not found.',
      error: new ApiCallError(404, 'Source not found.', { code: 'not_found' }),
      message: /couldn't load/i,
      action: `View ${KNOWLEDGE_SOURCE.title}`,
      seed: { 'knowledge.source.list': { items: [KNOWLEDGE_SOURCE] } },
      success: {
        source: KNOWLEDGE_SOURCE,
        derivedRepresentations: [SOURCE_DERIVED_REPRESENTATION],
      },
      result: 'Text',
      expected: [[{ workspaceId: 'ws1', sourceId: KNOWLEDGE_SOURCE.id }]],
    },
    {
      method: 'knowledge.observation.record',
      panel: 'Ledger' as const,
      kind: 'failed',
      privateText: 'Observation rejected.',
      error: operationFailed('Observation rejected.'),
      message: /couldn't record/i,
      action: 'Record observation',
      selects: [{ name: 'Observation kind', option: OBSERVATION_KIND_OPTION }],
      fields: [
        ['Observation summary', KNOWLEDGE_OBSERVATION.summary],
        ['Observation producer', KNOWLEDGE_OBSERVATION.producer],
      ] as const,
      success: {
        observation: {
          ...SERVER_OBSERVATION,
          summary: 'Mutation observation must not become visible',
        },
      },
      owner: {
        method: 'knowledge.observation.list' as const,
        initial: { items: [] },
        after: { items: [SERVER_OBSERVATION] },
      },
      result: SERVER_OBSERVATION.summary,
      echo: 'Mutation observation must not become visible',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            kind: OBSERVATION_KIND,
            summary: KNOWLEDGE_OBSERVATION.summary,
            producer: KNOWLEDGE_OBSERVATION.producer,
          }),
        ],
      ],
    },
    {
      method: 'knowledge.claim.record',
      panel: 'Ledger' as const,
      kind: 'denied',
      privateText: 'Claim record denied.',
      error: accessDenied('Claim record denied.'),
      message: /couldn't record|access denied/i,
      action: 'Record claim',
      fields: [
        ['Claim statement', KNOWLEDGE_CLAIM.statement],
        ['Claim producer', KNOWLEDGE_CLAIM.producer],
      ] as const,
      success: {
        claim: { ...SERVER_CLAIM, statement: 'Mutation claim must not become visible' },
      },
      owner: {
        method: 'knowledge.claim.list' as const,
        initial: { items: [] },
        after: { items: [SERVER_CLAIM] },
      },
      result: SERVER_CLAIM.statement,
      echo: 'Mutation claim must not become visible',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            statement: KNOWLEDGE_CLAIM.statement,
            producer: KNOWLEDGE_CLAIM.producer,
          }),
        ],
      ],
    },
    {
      method: 'knowledge.claim.record',
      panel: 'Ledger' as const,
      kind: 'failed',
      privateText: 'Claim record failed.',
      error: operationFailed('Claim record failed.'),
      message: /couldn't record/i,
      action: 'Record claim',
      fields: [
        ['Claim statement', KNOWLEDGE_CLAIM.statement],
        ['Claim producer', KNOWLEDGE_CLAIM.producer],
      ] as const,
      success: {
        claim: { ...SERVER_CLAIM, statement: 'Mutation claim must not become visible' },
      },
      owner: {
        method: 'knowledge.claim.list' as const,
        initial: { items: [] },
        after: { items: [SERVER_CLAIM] },
      },
      result: SERVER_CLAIM.statement,
      echo: 'Mutation claim must not become visible',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            statement: KNOWLEDGE_CLAIM.statement,
            producer: KNOWLEDGE_CLAIM.producer,
          }),
        ],
      ],
    },
    {
      method: 'knowledge.conflict.list',
      panel: 'Ledger' as const,
      kind: 'denied',
      privateText: 'Conflict list denied.',
      error: accessDenied('Conflict list denied.'),
      message: /couldn't load|access denied/i,
      success: { items: [KNOWLEDGE_CONFLICT] },
      result: KNOWLEDGE_CONFLICT.summary,
      expected: [[{ workspaceId: 'ws1' }]],
    },
    {
      method: 'knowledge.conflict.list',
      panel: 'Ledger' as const,
      kind: 'failed',
      privateText: 'Conflict list failed.',
      error: operationFailed('Conflict list failed.'),
      message: /couldn't load/i,
      success: { items: [KNOWLEDGE_CONFLICT] },
      result: KNOWLEDGE_CONFLICT.summary,
      expected: [[{ workspaceId: 'ws1' }]],
    },
    {
      method: 'knowledge.conflict.record',
      panel: 'Ledger' as const,
      kind: 'denied',
      privateText: 'Conflict record denied.',
      error: accessDenied('Conflict record denied.'),
      message: /couldn't record|access denied/i,
      action: 'Record conflict',
      fields: [
        ['Conflict summary', CONFLICT_SUMMARY],
        ['Subject references', KNOWLEDGE_CONFLICT.subjectReferences.join(' ')],
        ['Conflict producer', KNOWLEDGE_CONFLICT.producer],
      ] as const,
      success: {
        conflict: { ...SERVER_CONFLICT, summary: 'Mutation conflict must not become visible' },
      },
      owner: {
        method: 'knowledge.conflict.list' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [KNOWLEDGE_CONFLICT, SERVER_CONFLICT] },
      },
      result: SERVER_CONFLICT.summary,
      echo: 'Mutation conflict must not become visible',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            summary: CONFLICT_SUMMARY,
            subjectReferences: KNOWLEDGE_CONFLICT.subjectReferences,
            producer: KNOWLEDGE_CONFLICT.producer,
          }),
        ],
      ],
    },
    {
      method: 'knowledge.conflict.record',
      panel: 'Ledger' as const,
      kind: 'failed',
      privateText: 'Conflict record failed.',
      error: operationFailed('Conflict record failed.'),
      message: /couldn't record/i,
      action: 'Record conflict',
      fields: [
        ['Conflict summary', CONFLICT_SUMMARY],
        ['Subject references', KNOWLEDGE_CONFLICT.subjectReferences.join(' ')],
        ['Conflict producer', KNOWLEDGE_CONFLICT.producer],
      ] as const,
      success: {
        conflict: { ...SERVER_CONFLICT, summary: 'Mutation conflict must not become visible' },
      },
      owner: {
        method: 'knowledge.conflict.list' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [KNOWLEDGE_CONFLICT, SERVER_CONFLICT] },
      },
      result: SERVER_CONFLICT.summary,
      echo: 'Mutation conflict must not become visible',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            summary: CONFLICT_SUMMARY,
            subjectReferences: KNOWLEDGE_CONFLICT.subjectReferences,
            producer: KNOWLEDGE_CONFLICT.producer,
          }),
        ],
      ],
    },
    {
      method: 'knowledge.conflict.resolve',
      panel: 'Ledger' as const,
      kind: 'failed',
      privateText: 'Conflict resolve rejected.',
      error: new ApiCallError(409, 'Conflict resolve rejected.', { code: 'conflict' }),
      message: /couldn't resolve/i,
      action: 'Resolve conflict',
      selects: [{ name: 'Conflict', option: KNOWLEDGE_CONFLICT.summary }],
      fields: [
        ['Resolution', CONFLICT_RESOLUTION],
        ['Resolved by', 'user:test'],
      ] as const,
      success: {
        conflict: {
          ...SERVER_RESOLVED_CONFLICT,
          resolution: 'Mutation resolution is not authority',
        },
      },
      owner: {
        method: 'knowledge.conflict.list' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [SERVER_RESOLVED_CONFLICT] },
      },
      result: SERVER_RESOLVED_CONFLICT.resolution,
      echo: 'Mutation resolution is not authority',
      expected: [
        [
          expect.objectContaining({
            workspaceId: 'ws1',
            conflictId: KNOWLEDGE_CONFLICT.id,
            resolution: CONFLICT_RESOLUTION,
            resolvedBy: 'user:test',
          }),
        ],
      ],
    },
    {
      method: 'knowledge.indexes',
      panel: 'Retrieval' as const,
      kind: 'denied',
      privateText: 'Index read denied.',
      error: accessDenied('Index read denied.'),
      message: /couldn't load|access denied/i,
      success: KNOWLEDGE_INDEXES,
      result: 'weekly',
      expected: [[{ workspaceId: 'ws1' }]],
    },
    {
      method: 'knowledge.indexes',
      panel: 'Retrieval' as const,
      kind: 'failed',
      privateText: 'Index read failed.',
      error: operationFailed('Index read failed.'),
      message: /couldn't load/i,
      success: KNOWLEDGE_INDEXES,
      result: 'weekly',
      expected: [[{ workspaceId: 'ws1' }]],
    },
    {
      method: 'knowledge.retrieval',
      panel: 'Retrieval' as const,
      kind: 'failed',
      privateText: 'Retrieval rejected.',
      error: operationFailed('Retrieval rejected.'),
      message: /couldn't retrieve/i,
      action: 'Retrieve',
      fields: [['Query', RETRIEVAL_QUERY]] as const,
      success: KNOWLEDGE_RETRIEVAL,
      result: RETRIEVAL_TRACE_ID,
      expected: [[{ workspaceId: 'ws1', ...{ query: RETRIEVAL_QUERY } }]],
    },
    {
      method: 'knowledge.context.prepare',
      panel: 'Retrieval' as const,
      kind: 'failed',
      privateText: 'Context rejected.',
      error: operationFailed('Context rejected.'),
      message: /couldn't prepare/i,
      action: 'Prepare context',
      fields: [['Query', RETRIEVAL_QUERY]] as const,
      success: KNOWLEDGE_CONTEXT,
      result: 'prepared',
      expected: [[{ workspaceId: 'ws1', ...{ query: RETRIEVAL_QUERY } }]],
    },
    {
      method: 'knowledge.answer',
      panel: 'Manager' as const,
      kind: 'failed',
      privateText: 'Answer rejected.',
      error: operationFailed('Answer rejected.'),
      message: /couldn't answer/i,
      action: 'Answer',
      fields: [['Question', MANAGER_QUESTION]] as const,
      success: KNOWLEDGE_ANSWER,
      result: KNOWLEDGE_ANSWER.answer,
      expected: [[{ workspaceId: 'ws1', ...{ query: MANAGER_QUESTION } }]],
    },
    {
      method: 'knowledge.repair.suggest',
      panel: 'Manager' as const,
      kind: 'denied',
      privateText: 'Repair suggestion denied.',
      error: accessDenied('Repair suggestion denied.'),
      message: /couldn't suggest|access denied/i,
      action: 'Suggest repairs',
      success: KNOWLEDGE_REPAIRS,
      result: KNOWLEDGE_REPAIR.title,
      expected: [[{ workspaceId: 'ws1', ...{ limit: 10 } }]],
    },
    {
      method: 'knowledge.repair.suggest',
      panel: 'Manager' as const,
      kind: 'failed',
      privateText: 'Repair suggestion failed.',
      error: operationFailed('Repair suggestion failed.'),
      message: /couldn't suggest/i,
      action: 'Suggest repairs',
      success: KNOWLEDGE_REPAIRS,
      result: KNOWLEDGE_REPAIR.title,
      expected: [[{ workspaceId: 'ws1', ...{ limit: 10 } }]],
    },
    {
      method: 'knowledge.health.check',
      panel: 'Manager' as const,
      kind: 'failed',
      privateText: 'Health rejected.',
      error: operationFailed('Health rejected.'),
      message: /couldn't check|couldn't inspect/i,
      action: 'Check health',
      success: KNOWLEDGE_HEALTH,
      result: KNOWLEDGE_HEALTH.summary,
      expected: [[{ workspaceId: 'ws1', ...{ limit: 10 } }]],
    },
  ])('scopes a $kind $method retry to the $panel panel', async (testCase) => {
    const user = userEvent.setup();
    const method = vi
      .fn()
      .mockRejectedValueOnce(testCase.error)
      .mockResolvedValue(testCase.success);
    const owner =
      'owner' in testCase && testCase.owner
        ? vi
            .fn()
            .mockResolvedValueOnce(testCase.owner.initial)
            .mockResolvedValue(testCase.owner.after)
        : undefined;
    const seed = Object.fromEntries(
      Object.entries('seed' in testCase ? (testCase.seed ?? {}) : {}).map(([name, value]) => [
        name,
        vi.fn().mockResolvedValue(value),
      ])
    );
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          ...seed,
          ...(owner && 'owner' in testCase && testCase.owner
            ? { [testCase.owner.method]: owner }
            : {}),
          [testCase.method]: method,
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const panel = knowledgePanel(testCase.panel);
    if ('selects' in testCase && testCase.selects) {
      for (const item of testCase.selects) {
        await selectListedOption(user, panel, item.name, item.option);
      }
    }
    if ('fields' in testCase && testCase.fields) {
      await fillKnowledgeFields(user, panel, [...testCase.fields]);
    }
    if ('action' in testCase && testCase.action) {
      await user.click(within(panel).getByRole('button', { name: testCase.action }));
    }
    await waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    const firstRequestId = requestIdFromCall(method.mock.calls[0]);
    await retryScopedAlert(user, panel, testCase.message, testCase.privateText);
    await waitFor(() => expect(method).toHaveBeenCalledTimes(2));
    expect(method.mock.calls[0]).toEqual(testCase.expected[0]);
    expect(method.mock.calls[1]).toEqual(method.mock.calls[0]);
    if (
      testCase.method === 'knowledge.source.register' ||
      testCase.method === 'knowledge.observation.record' ||
      testCase.method === 'knowledge.claim.record' ||
      testCase.method === 'knowledge.conflict.record' ||
      testCase.method === 'knowledge.conflict.resolve'
    ) {
      expect(typeof firstRequestId).toBe('string');
      expect(requestIdFromCall(method.mock.calls[1])).toBe(firstRequestId);
    }
    if (owner && 'owner' in testCase && testCase.owner) {
      await waitFor(() => expect(owner.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(owner.mock.calls.every((call) => call[0]?.workspaceId === 'ws1')).toBe(true);
    }
    await proveScopedRetrySettled(
      panel,
      testCase.result,
      'echo' in testCase ? testCase.echo : undefined
    );
  });

  it('represents the 13 required Knowledge user operations and omits unpublished proposal draft/reverse', () => {
    for (const hook of REQUIRED_KNOWLEDGE_OPERATION_HOOKS) {
      expect(knowledgeScreenSource).toContain(hook);
    }
    expect(knowledgeScreenSource).not.toMatch(/draftKnowledgeProposal/);
    expect(knowledgeScreenSource).not.toMatch(/reverseKnowledgeProposal/);
    expect(knowledgeDataSource).not.toMatch(/draftKnowledgeProposal/);
    expect(knowledgeDataSource).not.toMatch(/reverseKnowledgeProposal/);
  });

  it('types Knowledge writes with Core Client owned inputs and does not cast them', () => {
    for (const slice of KNOWLEDGE_TYPED_WRITE_SLICES) {
      const typeSource = exportedKnowledgeSlice(slice.typeName);
      const hookSource = exportedKnowledgeSlice(slice.hookName);
      expect(typeSource).toMatch(
        new RegExp(
          `input: Omit<\\s*Parameters<CoreClient\\['operations'\\]\\['${slice.method}'\\]>\\[0\\]`
        )
      );
      expect(hookSource).not.toMatch(/command\.input as /);
      expect(hookSource).not.toMatch(/as unknown as Parameters<CoreClient\['app'\]/);
    }
  });

  it('reuses the shared Select primitive instead of a Knowledge-local listbox', () => {
    expect(knowledgeScreenSource).toMatch(
      /import \{[\s\S]*?\bSelect\b[\s\S]*?\} from ['"]\.\.\/\.\.\/primitives['"]/
    );
    expect(knowledgeScreenSource).not.toMatch(/function PanelSelect\b/);
    expect(knowledgeScreenSource).not.toMatch(/role=["']listbox["']/);
  });

  it('does not keep Workspace A Knowledge drafts submit-capable after switching to Workspace B', async ({
    signal,
  }) => {
    const user = setupKnowledgeUser(signal);
    const registerKnowledgeSource = vi.fn();
    const recordKnowledgeObservation = vi.fn();
    const recordKnowledgeClaim = vi.fn();
    const recordKnowledgeConflict = vi.fn();
    const resolveKnowledgeConflict = vi.fn();
    const retrieveKnowledge = vi.fn();
    const prepareKnowledgeContext = vi.fn();
    const answerKnowledgeManager = vi.fn();
    renderApp(
      '/knowledge',
      makeClient({
        core: {},
        app: {
          'knowledge.conflict.list': vi
            .fn()
            .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
              Promise.resolve({
                items: workspaceId === WORKSPACE_A.id ? [KNOWLEDGE_CONFLICT] : [],
              })
            ),
          'knowledge.answer': answerKnowledgeManager,
          'knowledge.context.prepare': prepareKnowledgeContext,
          'knowledge.claim.record': recordKnowledgeClaim,
          'knowledge.conflict.record': recordKnowledgeConflict,
          'knowledge.observation.record': recordKnowledgeObservation,
          'knowledge.source.register': registerKnowledgeSource,
          'knowledge.conflict.resolve': resolveKnowledgeConflict,
          'knowledge.retrieval': retrieveKnowledge,
        },

        operations: {
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    await fillKnowledgeWorkspaceDrafts(user);
    for (const item of KNOWLEDGE_DRAFT_WRITES) {
      expect(
        within(knowledgePanel(item.panel)).getByRole('button', { name: item.action })
      ).toBeEnabled();
    }

    signal.throwIfAborted();
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    for (const item of KNOWLEDGE_DRAFT_WRITES) {
      const button = within(knowledgePanel(item.panel)).getByRole('button', { name: item.action });
      expect(button).toBeDisabled();
      await user.click(button);
    }
    expect(registerKnowledgeSource).not.toHaveBeenCalled();
    expect(recordKnowledgeObservation).not.toHaveBeenCalled();
    expect(recordKnowledgeClaim).not.toHaveBeenCalled();
    expect(recordKnowledgeConflict).not.toHaveBeenCalled();
    expect(resolveKnowledgeConflict).not.toHaveBeenCalled();
    expect(retrieveKnowledge).not.toHaveBeenCalled();
    expect(prepareKnowledgeContext).not.toHaveBeenCalled();
    expect(answerKnowledgeManager).not.toHaveBeenCalled();
  });

  it('does not keep a Workspace A Add knowledge draft submit-capable after switching to Workspace B', async () => {
    const user = userEvent.setup();
    const createKnowledge = vi.fn();
    renderApp(
      '/knowledge',
      makeClient({
        core: { 'knowledge.create': createKnowledge },

        operations: {
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    await screen.findByText(/No entries yet/i);
    await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
    await user.click(screen.getByRole('textbox', { name: 'Title' }));
    await user.paste('Prefer concise memos');
    await user.click(screen.getByRole('textbox', { name: 'Content' }));
    await user.paste('Keep it short.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Prefer concise memos')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Keep it short.')).not.toBeInTheDocument();
    const save = screen.queryByRole('button', { name: 'Save' });
    if (save) {
      expect(save).toBeDisabled();
      await user.click(save);
    }
    expect(callsOn(createKnowledge, WORKSPACE_B.id)).toHaveLength(0);
    expect(createKnowledge).not.toHaveBeenCalled();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_A.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Prefer concise memos')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep it short.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsOn(createKnowledge, WORKSPACE_A.id)).toHaveLength(1));
    expect(callsOn(createKnowledge, WORKSPACE_B.id)).toHaveLength(0);
  });

  it('keeps an in-flight Workspace A Knowledge write attributed to A without resetting Workspace B drafts', async () => {
    const user = userEvent.setup();
    const pendingRegister = createDeferred<{
      source: typeof REGISTERED_SOURCE;
      derivedRepresentations: [];
    }>();
    const registerKnowledgeSource = vi.fn().mockReturnValue(pendingRegister.promise);
    const listKnowledgeSources = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve({
          items: workspaceId === WORKSPACE_A.id ? [KNOWLEDGE_SOURCE] : [],
        })
      );
    renderApp(
      '/knowledge',
      makeClient({
        core: {},
        app: {
          'knowledge.source.list': listKnowledgeSources,
          'knowledge.source.register': registerKnowledgeSource,
        },

        operations: {
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const sources = knowledgePanel('Sources');
    await selectListedOption(user, sources, 'Source kind', SOURCE_KIND_OPTION);
    await fillKnowledgeFields(user, sources, [
      ['Source title', REGISTER_SOURCE_INPUT.title],
      ['Source content', REGISTER_SOURCE_INPUT.content],
    ]);
    await user.click(within(sources).getByRole('button', { name: 'Register source' }));
    await waitFor(() => expect(registerKnowledgeSource).toHaveBeenCalledTimes(1));
    expect(registerKnowledgeSource).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_A.id, title: REGISTER_SOURCE_INPUT.title })
    );

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    await waitFor(() =>
      expect(callsOn(listKnowledgeSources, WORKSPACE_B.id).length).toBeGreaterThan(0)
    );
    const sourcesAfterSwitch = knowledgePanel('Sources');
    const titleField = within(sourcesAfterSwitch).getByRole('textbox', { name: 'Source title' });
    const contentField = within(sourcesAfterSwitch).getByRole('textbox', {
      name: 'Source content',
    });
    expect(titleField).toBeEnabled();
    expect(contentField).toBeEnabled();
    await selectListedOption(user, sourcesAfterSwitch, 'Source kind', SOURCE_KIND_OPTION);
    await fillKnowledgeFields(user, sourcesAfterSwitch, [
      ['Source title', WORKSPACE_B_SOURCE_DRAFT.title],
      ['Source content', WORKSPACE_B_SOURCE_DRAFT.content],
    ]);
    expect(callsOn(listKnowledgeSources, WORKSPACE_A.id)).toHaveLength(1);
    await user.click(within(sourcesAfterSwitch).getByRole('button', { name: 'Register source' }));
    expect(callsOn(registerKnowledgeSource, WORKSPACE_B.id)).toHaveLength(0);

    pendingRegister.resolve({ source: REGISTERED_SOURCE, derivedRepresentations: [] });
    await waitFor(() => expect(callsOn(listKnowledgeSources, WORKSPACE_A.id)).toHaveLength(2));
    expect(registerKnowledgeSource).toHaveBeenCalledTimes(1);
    expect(callsOn(registerKnowledgeSource, WORKSPACE_A.id)).toHaveLength(1);
    expect(callsOn(registerKnowledgeSource, WORKSPACE_B.id)).toHaveLength(0);
    expect(callsOn(listKnowledgeSources, WORKSPACE_A.id)).toHaveLength(2);
    expect(
      within(knowledgePanel('Sources')).getByRole('textbox', { name: 'Source title' })
    ).toHaveValue(WORKSPACE_B_SOURCE_DRAFT.title);
    expect(
      within(knowledgePanel('Sources')).getByRole('textbox', { name: 'Source content' })
    ).toHaveValue(WORKSPACE_B_SOURCE_DRAFT.content);
    expect(
      within(knowledgePanel('Sources')).getByRole('button', { name: /Source kind$/i })
    ).toHaveTextContent(SOURCE_KIND_OPTION);
    await waitFor(() =>
      expect(
        within(knowledgePanel('Sources')).getByRole('button', { name: 'Register source' })
      ).toBeEnabled()
    );
  });

  it.each([
    {
      operation: 'update' as const,
      echo: 'Mutation response must not become visible',
      settled: [UPDATED_KNOWLEDGE_ENTRY],
    },
    {
      operation: 'delete' as const,
      echo: undefined,
      settled: [] as (typeof KNOWLEDGE_ENTRY)[],
    },
  ])('rereads only the Workspace A knowledge query when an in-flight A $operation completes in B', async (testCase) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    const authoritativeA = createDeferred<{ items: (typeof KNOWLEDGE_ENTRY)[] }>();
    let aReads = 0;
    let bReads = 0;
    const listKnowledge = vi.fn().mockImplementation(({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === WORKSPACE_B.id) {
        bReads += 1;
        return Promise.resolve({
          items:
            bReads > 1
              ? [{ ...KNOWLEDGE_ENTRY_B, title: 'B must not reread after A settlement' }]
              : [KNOWLEDGE_ENTRY_B],
        });
      }
      aReads += 1;
      if (aReads > 1) return authoritativeA.promise;
      return Promise.resolve({ items: [KNOWLEDGE_ENTRY] });
    });
    const mutation = vi.fn().mockReturnValue(pending.promise);
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          'knowledge.list': listKnowledge,
          [testCase.operation === 'update' ? 'knowledge.update' : 'knowledge.delete']: mutation,
        },

        operations: {
          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );
    if (testCase.operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.click(title);
      await user.paste('Prefer concise release notes');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await user.click(
        await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
      );
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    expect(mutation.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_A.id);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(await screen.findByText(KNOWLEDGE_ENTRY_B.title)).toBeInTheDocument();
    expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument();
    await fillWorkspaceBSourceDraft(user);
    const aReadsBefore = callsOn(listKnowledge, WORKSPACE_A.id).length;
    const bReadsBefore = callsOn(listKnowledge, WORKSPACE_B.id).length;
    pending.resolve(
      testCase.operation === 'update' ? { ...KNOWLEDGE_ENTRY, title: testCase.echo } : undefined
    );
    await waitFor(() =>
      expect(listKnowledge.mock.calls.length).toBeGreaterThan(aReadsBefore + bReadsBefore)
    );
    expect(callsOn(listKnowledge, WORKSPACE_A.id)).toHaveLength(aReadsBefore + 1);
    expect(callsOn(listKnowledge, WORKSPACE_B.id)).toHaveLength(bReadsBefore);
    expect(screen.getByText(KNOWLEDGE_ENTRY_B.title)).toBeInTheDocument();
    expect(screen.queryByText('B must not reread after A settlement')).not.toBeInTheDocument();
    if (testCase.echo) {
      expect(screen.queryByText(testCase.echo)).not.toBeInTheDocument();
    }
    expectWorkspaceBSourceDraftRetained();

    authoritativeA.resolve({ items: testCase.settled });
    expect(screen.getByText(KNOWLEDGE_ENTRY_B.title)).toBeInTheDocument();
    expectWorkspaceBSourceDraftRetained();
    expect(callsOn(listKnowledge, WORKSPACE_B.id)).toHaveLength(bReadsBefore);
    expect(callsOn(mutation, WORKSPACE_B.id)).toHaveLength(0);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_A.id }));
    if (testCase.operation === 'update') {
      expect(await screen.findByText(UPDATED_KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
      expect(screen.getByText(UPDATED_KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
      expect(screen.queryByText(testCase.echo ?? '')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText(/No entries yet/i)).toBeInTheDocument();
      expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument();
    }
  });

  it('rereads only the Workspace A attention query when an in-flight A proposal decision completes in B', async () => {
    const user = userEvent.setup();
    const pendingDecision = createDeferred<unknown>();
    const authoritativeA = createDeferred<{ items: unknown[] }>();
    let aReads = 0;
    let bReads = 0;
    const listHumanAttention = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === WORKSPACE_B.id) {
          bReads += 1;
          return Promise.resolve({
            items: bReads > 1 ? [] : [KNOWLEDGE_PROPOSAL_ROW_B],
          });
        }
        aReads += 1;
        if (aReads > 1) return authoritativeA.promise;
        return Promise.resolve({ items: [KNOWLEDGE_PROPOSAL_ROW] });
      });
    const submitKnowledgeProposalDecision = vi.fn().mockReturnValue(pendingDecision.promise);
    renderApp(
      '/knowledge',
      makeClient({
        core: {},
        app: { 'knowledge.proposal.decide': submitKnowledgeProposalDecision },

        operations: {
          'attention.list': listHumanAttention,

          'workspace.list': vi.fn().mockResolvedValue({
            items: [WORKSPACE_A, WORKSPACE_B].map((workspace) => ({
              workspace,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_local',
              registryRevision: 1,
            })),
          }),
        },
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1));
    expect(submitKnowledgeProposalDecision.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_A.id);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(await screen.findByText(KNOWLEDGE_PROPOSAL_ROW_B.title)).toBeInTheDocument();
    expect(screen.queryByText(KNOWLEDGE_PROPOSAL_ROW.title)).not.toBeInTheDocument();
    await fillWorkspaceBSourceDraft(user);
    const aReadsBefore = callsOn(listHumanAttention, WORKSPACE_A.id).length;
    const bReadsBefore = callsOn(listHumanAttention, WORKSPACE_B.id).length;
    pendingDecision.resolve({ review: { decision: 'accepted' } });
    await waitFor(() =>
      expect(listHumanAttention.mock.calls.length).toBeGreaterThan(aReadsBefore + bReadsBefore)
    );
    expect(callsOn(listHumanAttention, WORKSPACE_A.id)).toHaveLength(aReadsBefore + 1);
    expect(callsOn(listHumanAttention, WORKSPACE_B.id)).toHaveLength(bReadsBefore);
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW_B.title)).toBeInTheDocument();
    expectWorkspaceBSourceDraftRetained();

    authoritativeA.resolve({ items: [] });
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW_B.title)).toBeInTheDocument();
    expectWorkspaceBSourceDraftRetained();
    expect(callsOn(listHumanAttention, WORKSPACE_B.id)).toHaveLength(bReadsBefore);
    expect(callsOn(submitKnowledgeProposalDecision, WORKSPACE_B.id)).toHaveLength(0);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_A.id }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(KNOWLEDGE_PROPOSAL_ROW.title)).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it.each([
    { name: 'after A→B→A', mode: 'switch' as const },
    { name: 'after leave-and-return', mode: 'remount' as const },
  ])('rereads Sources, Observations, Claims, Conflicts, and Indexes $name', async ({ mode }) => {
    const user = userEvent.setup();
    const reads = knowledgeAuthorityReads(mode);
    const {
      listKnowledgeSources,
      listKnowledgeObservations,
      listKnowledgeClaims,
      listKnowledgeConflicts,
      readKnowledgeIndexes,
    } = reads;
    renderApp(
      '/knowledge',
      makeClient({
        core: {},
        app: {
          'knowledge.claim.list': listKnowledgeClaims,
          'knowledge.conflict.list': listKnowledgeConflicts,
          'knowledge.observation.list': listKnowledgeObservations,
          'knowledge.source.list': listKnowledgeSources,
          'knowledge.indexes': readKnowledgeIndexes,
        },

        operations: {
          'workspace.list': vi.fn().mockResolvedValue({
            items: (mode === 'switch' ? [WORKSPACE_A, WORKSPACE_B] : [WORKSPACE_A]).map(
              (workspace) => ({
                workspace,
                effectiveRole: 'owner',
                membershipRevision: 1,
                ownerUserId: 'user_local',
                registryRevision: 1,
              })
            ),
          }),
        },
      })
    );

    const first = reads.catalog(WORKSPACE_A.id).current;
    expect(await screen.findByText(first.source)).toBeInTheDocument();
    expect(screen.getByText(first.observation)).toBeInTheDocument();
    expect(screen.getByText(first.claim)).toBeInTheDocument();
    expect(screen.getByText(first.conflict, { selector: ':not(option)' })).toBeInTheDocument();
    expect(screen.getByText(first.index)).toBeInTheDocument();
    expect(callsOn(listKnowledgeSources, WORKSPACE_A.id)).toHaveLength(1);
    expect(callsOn(listKnowledgeObservations, WORKSPACE_A.id)).toHaveLength(1);
    expect(callsOn(listKnowledgeClaims, WORKSPACE_A.id)).toHaveLength(1);
    expect(callsOn(listKnowledgeConflicts, WORKSPACE_A.id)).toHaveLength(1);
    expect(callsOn(readKnowledgeIndexes, WORKSPACE_A.id)).toHaveLength(1);

    reads.generation.current = 1;
    if (mode === 'switch') {
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
      const workspaceB = reads.catalog(WORKSPACE_B.id).current;
      expect(await screen.findByText(workspaceB.source)).toBeInTheDocument();
      expect(screen.getByText(workspaceB.observation)).toBeInTheDocument();
      expect(screen.getByText(workspaceB.claim)).toBeInTheDocument();
      expect(
        screen.getByText(workspaceB.conflict, { selector: ':not(option)' })
      ).toBeInTheDocument();
      expect(screen.getByText(workspaceB.index)).toBeInTheDocument();
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_A.id }));
    } else {
      await user.click(screen.getByRole('button', { name: 'Agents' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Knowledge' }));
    }

    await waitFor(() => {
      expect(callsOn(listKnowledgeSources, WORKSPACE_A.id)).toHaveLength(2);
      expect(callsOn(listKnowledgeObservations, WORKSPACE_A.id)).toHaveLength(2);
      expect(callsOn(listKnowledgeClaims, WORKSPACE_A.id)).toHaveLength(2);
      expect(callsOn(listKnowledgeConflicts, WORKSPACE_A.id)).toHaveLength(2);
      expect(callsOn(readKnowledgeIndexes, WORKSPACE_A.id)).toHaveLength(2);
    });
    const second = reads.catalog(WORKSPACE_A.id).current;
    expect(await screen.findByText(second.source)).toBeInTheDocument();
    expect(screen.getByText(second.observation)).toBeInTheDocument();
    expect(screen.getByText(second.claim)).toBeInTheDocument();
    expect(screen.getByText(second.conflict, { selector: ':not(option)' })).toBeInTheDocument();
    expect(screen.getByText(second.index)).toBeInTheDocument();
  });

  it.each([
    {
      method: 'knowledge.source.register',
      panel: 'Sources' as const,
      action: 'Register source',
      message: /couldn't load/i,
      selects: [{ name: 'Source kind', option: SOURCE_KIND_OPTION }],
      fields: [
        ['Source title', REGISTER_SOURCE_INPUT.title],
        ['Source content', REGISTER_SOURCE_INPUT.content],
      ] as const,
      success: {
        source: { ...REGISTERED_SOURCE, title: 'Mutation source must not become visible' },
        derivedRepresentations: [],
      },
      owner: {
        method: 'knowledge.source.list' as const,
        initial: { items: [KNOWLEDGE_SOURCE] },
        after: { items: [KNOWLEDGE_SOURCE, REGISTERED_SOURCE] },
      },
      result: REGISTERED_SOURCE.title,
      echo: 'Mutation source must not become visible',
      clearedSelects: [{ name: 'Source kind' }],
      clearedFields: [
        ['Source title', ''],
        ['Source content', ''],
      ] as const,
      nextSelects: [{ name: 'Source kind', option: NEXT_SOURCE_KIND_OPTION }],
      nextFields: [
        ['Source title', NEXT_REGISTER_SOURCE_INPUT.title],
        ['Source content', NEXT_REGISTER_SOURCE_INPUT.content],
      ] as const,
      nextExpected: [
        expect.objectContaining({
          workspaceId: 'ws1',
          kind: NEXT_REGISTER_SOURCE_INPUT.kind,
          title: NEXT_REGISTER_SOURCE_INPUT.title,
          content: NEXT_REGISTER_SOURCE_INPUT.content,
        }),
      ],
    },
    {
      method: 'knowledge.observation.record',
      panel: 'Ledger' as const,
      action: 'Record observation',
      message: /couldn't load observations/i,
      selects: [{ name: 'Observation kind', option: OBSERVATION_KIND_OPTION }],
      fields: [
        ['Observation summary', KNOWLEDGE_OBSERVATION.summary],
        ['Observation producer', KNOWLEDGE_OBSERVATION.producer],
      ] as const,
      success: {
        observation: {
          ...SERVER_OBSERVATION,
          summary: 'Mutation observation must not become visible',
        },
      },
      owner: {
        method: 'knowledge.observation.list' as const,
        initial: { items: [] },
        after: { items: [SERVER_OBSERVATION] },
      },
      result: SERVER_OBSERVATION.summary,
      echo: 'Mutation observation must not become visible',
      clearedSelects: [{ name: 'Observation kind' }],
      clearedFields: [
        ['Observation summary', ''],
        ['Observation producer', ''],
      ] as const,
      nextSelects: [{ name: 'Observation kind', option: NEXT_OBSERVATION_KIND_OPTION }],
      nextFields: [
        ['Observation summary', NEXT_OBSERVATION.summary],
        ['Observation producer', NEXT_OBSERVATION.producer],
      ] as const,
      nextExpected: [
        expect.objectContaining({
          workspaceId: 'ws1',
          kind: NEXT_OBSERVATION_KIND,
          summary: NEXT_OBSERVATION.summary,
          producer: NEXT_OBSERVATION.producer,
        }),
      ],
    },
    {
      method: 'knowledge.claim.record',
      panel: 'Ledger' as const,
      action: 'Record claim',
      message: /couldn't load claims/i,
      fields: [
        ['Claim statement', KNOWLEDGE_CLAIM.statement],
        ['Claim producer', KNOWLEDGE_CLAIM.producer],
      ] as const,
      success: {
        claim: { ...SERVER_CLAIM, statement: 'Mutation claim must not become visible' },
      },
      owner: {
        method: 'knowledge.claim.list' as const,
        initial: { items: [] },
        after: { items: [SERVER_CLAIM] },
      },
      result: SERVER_CLAIM.statement,
      echo: 'Mutation claim must not become visible',
      clearedSelects: [] as const,
      clearedFields: [
        ['Claim statement', ''],
        ['Claim producer', ''],
      ] as const,
      nextSelects: [] as const,
      nextFields: [
        ['Claim statement', NEXT_CLAIM.statement],
        ['Claim producer', NEXT_CLAIM.producer],
      ] as const,
      nextExpected: [
        expect.objectContaining({
          workspaceId: 'ws1',
          statement: NEXT_CLAIM.statement,
          producer: NEXT_CLAIM.producer,
        }),
      ],
    },
    {
      method: 'knowledge.conflict.record',
      panel: 'Ledger' as const,
      action: 'Record conflict',
      message: /couldn't load conflicts/i,
      fields: [
        ['Conflict summary', CONFLICT_SUMMARY],
        ['Subject references', KNOWLEDGE_CONFLICT.subjectReferences.join(' ')],
        ['Conflict producer', KNOWLEDGE_CONFLICT.producer],
      ] as const,
      success: {
        conflict: { ...SERVER_CONFLICT, summary: 'Mutation conflict must not become visible' },
      },
      owner: {
        method: 'knowledge.conflict.list' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [KNOWLEDGE_CONFLICT, SERVER_CONFLICT] },
      },
      result: SERVER_CONFLICT.summary,
      echo: 'Mutation conflict must not become visible',
      clearedSelects: [] as const,
      clearedFields: [
        ['Conflict summary', ''],
        ['Subject references', ''],
        ['Conflict producer', ''],
      ] as const,
      nextSelects: [] as const,
      nextFields: [
        ['Conflict summary', NEXT_CONFLICT_INPUT.summary],
        ['Subject references', NEXT_CONFLICT_INPUT.subjectReferences.join(' ')],
        ['Conflict producer', NEXT_CONFLICT_INPUT.producer],
      ] as const,
      nextExpected: [
        expect.objectContaining({
          workspaceId: 'ws1',
          summary: NEXT_CONFLICT_INPUT.summary,
          subjectReferences: NEXT_CONFLICT_INPUT.subjectReferences,
          producer: NEXT_CONFLICT_INPUT.producer,
        }),
      ],
    },
    {
      method: 'knowledge.conflict.resolve',
      panel: 'Ledger' as const,
      action: 'Resolve conflict',
      message: /couldn't load conflicts/i,
      selects: [{ name: 'Conflict', option: KNOWLEDGE_CONFLICT.summary }],
      fields: [
        ['Resolution', CONFLICT_RESOLUTION],
        ['Resolved by', 'user:test'],
      ] as const,
      success: {
        conflict: {
          ...SERVER_RESOLVED_CONFLICT,
          resolution: 'Mutation resolution is not authority',
        },
      },
      owner: {
        method: 'knowledge.conflict.list' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [SERVER_RESOLVED_CONFLICT, SECOND_CONFLICT] },
      },
      result: SERVER_RESOLVED_CONFLICT.resolution,
      echo: 'Mutation resolution is not authority',
      clearedSelects: [{ name: 'Conflict' }],
      clearedFields: [
        ['Resolution', ''],
        ['Resolved by', ''],
      ] as const,
      nextSelects: [{ name: 'Conflict', option: SECOND_CONFLICT.summary }],
      nextFields: [
        ['Resolution', NEXT_RESOLUTION.resolution],
        ['Resolved by', NEXT_RESOLUTION.resolvedBy],
      ] as const,
      nextExpected: [
        expect.objectContaining({
          workspaceId: 'ws1',
          conflictId: SECOND_CONFLICT.id,
          resolution: NEXT_RESOLUTION.resolution,
          resolvedBy: NEXT_RESOLUTION.resolvedBy,
        }),
      ],
    },
  ])('locks a new $method submit after a successful write whose authoritative refetch rejects', async (testCase) => {
    const user = userEvent.setup();
    const method = vi.fn().mockResolvedValue(testCase.success);
    const owner = vi
      .fn()
      .mockResolvedValueOnce(testCase.owner.initial)
      .mockRejectedValueOnce(operationFailed('authoritative read failed'))
      .mockResolvedValue(testCase.owner.after);
    renderApp(
      '/knowledge',
      makeClient({
        app: {
          [testCase.owner.method]: owner,
          [testCase.method]: method,
        },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const panel = knowledgePanel(testCase.panel);
    if ('selects' in testCase && testCase.selects) {
      for (const item of testCase.selects) {
        await selectListedOption(user, panel, item.name, item.option);
      }
    }
    if ('fields' in testCase && testCase.fields) {
      await fillKnowledgeFields(user, panel, [...testCase.fields]);
    }
    await user.click(within(panel).getByRole('button', { name: testCase.action }));
    await waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    const firstRequestId = requestIdFromCall(method.mock.calls[0]);
    expect(typeof firstRequestId).toBe('string');
    await waitFor(() => expect(owner).toHaveBeenCalledTimes(2));

    const submit = within(panel).getByRole('button', { name: testCase.action });
    await waitFor(() => expect(submit).toBeDisabled());
    await user.click(submit);
    expect(method).toHaveBeenCalledTimes(1);
    expect(requestIdFromCall(method.mock.calls[0])).toBe(firstRequestId);

    await retryScopedAlert(user, panel, testCase.message, 'authoritative read failed');
    await waitFor(() => expect(owner).toHaveBeenCalledTimes(3));
    expect(method).toHaveBeenCalledTimes(1);
    expect(requestIdFromCall(method.mock.calls[0])).toBe(firstRequestId);
    await proveScopedRetrySettled(panel, testCase.result, testCase.echo);
    expectKnowledgeDraftCleared(panel, testCase.clearedFields, [...testCase.clearedSelects]);
    const settledSubmit = within(panel).getByRole('button', { name: testCase.action });
    expect(settledSubmit).toBeDisabled();
    await user.click(settledSubmit);
    expect(method).toHaveBeenCalledTimes(1);
    expect(requestIdFromCall(method.mock.calls[0])).toBe(firstRequestId);

    for (const item of testCase.nextSelects) {
      await selectListedOption(user, panel, item.name, item.option);
    }
    await fillKnowledgeFields(user, panel, [...testCase.nextFields]);
    const nextSubmit = within(panel).getByRole('button', { name: testCase.action });
    await waitFor(() => expect(nextSubmit).toBeEnabled());
    await user.click(nextSubmit);
    await waitFor(() => expect(method).toHaveBeenCalledTimes(2));
    const secondRequestId = requestIdFromCall(method.mock.calls[1]);
    expect(typeof secondRequestId).toBe('string');
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(method.mock.calls[1]).toEqual(testCase.nextExpected);
  });

  it.each([
    {
      method: 'knowledge.source.list',
      panel: 'Sources' as const,
      message: /couldn't load/i,
      privateText: 'source list failed.',
    },
    {
      method: 'knowledge.observation.list',
      panel: 'Ledger' as const,
      message: /couldn't load observations/i,
      privateText: 'observation list failed.',
    },
    {
      method: 'knowledge.claim.list',
      panel: 'Ledger' as const,
      message: /couldn't load claims/i,
      privateText: 'claim list failed.',
    },
    {
      method: 'knowledge.conflict.list',
      panel: 'Ledger' as const,
      message: /couldn't load conflicts/i,
      privateText: 'conflict list failed.',
    },
    {
      method: 'knowledge.indexes',
      panel: 'Retrieval' as const,
      message: /couldn't load indexes/i,
      privateText: 'index read failed.',
    },
  ])('guards a failed $method query retry while the connection is failed', async (testCase) => {
    const user = userEvent.setup();
    const meta = vi.fn().mockResolvedValue({});
    const method = vi.fn().mockRejectedValue(operationFailed(testCase.privateText));
    const queryClient = renderApp(
      '/knowledge',
      makeClient({
        core: { meta },
        app: { [testCase.method]: method },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const panel = knowledgePanel(testCase.panel);
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(testCase.message);
    expect(alert).not.toHaveTextContent(testCase.privateText);
    expect(method).toHaveBeenCalledTimes(1);

    meta.mockRejectedValue(new Error('down'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['core', 'meta'] });
    });
    await waitFor(() =>
      expect(screen.getByText(/couldn't reach the local runtime/i)).toBeInTheDocument()
    );
    const retry = within(alert).getByRole('button', { name: /try again/i });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(method).toHaveBeenCalledTimes(1);
    expect(method.mock.calls).toEqual([[{ workspaceId: WORKSPACE_A.id }]]);
  });
});

describe('First run (board 18)', () => {
  it('shows a connect error with retry when the runtime is unreachable', async () => {
    const user = userEvent.setup();
    const meta = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({});
    const client = makeClient({
      core: { meta },
      operations: {
        'workspace.list': vi.fn().mockResolvedValue({
          items: [].map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        }),
      },
    });
    renderApp('/first-run', client);
    await waitFor(
      () =>
        expect(screen.getAllByText(/Couldn't reach the local runtime/i).length).toBeGreaterThan(0),
      { timeout: 3000 }
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(meta.mock.calls.length).toBeGreaterThan(2));
  });

  it('shows welcome guidance when connected with no workspaces', async () => {
    const client = makeClient({
      operations: {
        'workspace.list': vi.fn().mockResolvedValue({
          items: [].map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        }),
      },
    });
    renderApp('/first-run', client);
    expect(await screen.findByText(/Your agent team/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create workspace/i })).toHaveAttribute(
      'href',
      '/settings/workspaces/new'
    );
  });

  it('offers a calm ready path when a workspace already exists', async () => {
    renderApp('/first-run', makeClient());
    expect(await screen.findByText(/You're set/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Overview/i })).toHaveAttribute('href', '/');
  });
});

describe('Archived threads', () => {
  it('lists selected-Workspace archived Threads and restores through updateThread', async () => {
    const user = userEvent.setup();
    const archivedThread = {
      id: 'th_archived_first',
      workspaceId: WORKSPACE_A.id,
      name: 'Past conversation',
      preview: 'Archived conversation',
      status: 'archived' as const,
      createdAt: TIMESTAMP_OLD,
      updatedAt: TIMESTAMP_OLD,
    };
    const previewOnlyThread = {
      id: 'th_archived_second',
      workspaceId: WORKSPACE_A.id,
      name: null,
      preview: 'Preview-only conversation',
      status: 'archived' as const,
      createdAt: TIMESTAMP_OLD,
      updatedAt: TIMESTAMP_OLD,
    };
    const updateThread = vi.fn().mockResolvedValue({ ...archivedThread, status: 'active' });
    const client = makeClient({
      operations: {
        'thread.list': vi.fn().mockResolvedValue({ items: [archivedThread, previewOnlyThread] }),
        'thread.update': updateThread,
      },
      core: {},
    });
    renderApp('/workspace/archived', client);

    expect(await screen.findByRole('heading', { name: 'Archived threads' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Past conversation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview-only conversation' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('main', { name: 'Workspace' })).queryByRole('button', {
        name: 'New conversation',
      })
    ).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Restore' })[0]!);
    await waitFor(() =>
      expect(updateThread).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_A.id,
        threadId: archivedThread.id,
        status: 'active',
      })
    );
  });
});

describe('New workspace (board 07)', () => {
  it('creates a workspace from the form', async () => {
    const user = userEvent.setup();
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'ws-new',
      name: 'Launch prep',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: TIMESTAMP_NEW,
      updatedAt: TIMESTAMP_NEW,
    });
    const client = makeClient({
      operations: { 'workspace.create': createWorkspace },
      core: {},
    });
    renderApp('/settings/workspaces/new', client);
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Launch prep');
    await user.click(screen.getByRole('button', { name: /Create workspace/i }));
    await waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch prep' }))
    );
  });
});
