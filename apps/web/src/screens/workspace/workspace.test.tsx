import { KnowledgeDerivedIndexesResponseSchema } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';
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
const QUICK_CHAT_WORKSPACE = {
  id: 'ws_quick_chat',
  name: 'Quick Chat',
  kind: 'quick-chat',
  status: 'active',
  counts: WORKSPACE_COUNTS,
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_NEW,
} as const;

const REPOSITORY_RESOURCE = {
  workspaceId: 'ws1',
  resourceId: 'repo_default',
  type: 'git_repository',
  displayName: 'Market research repository',
  diagnosticsStatus: 'ready',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_NEW,
  pathSummary: 'git repository ending in market-research',
  git: {
    authorEmail: null,
    authorName: null,
    allowedPushTargets: ['main'],
    commitOnApply: false,
    protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
    requireReviewLinkage: true,
    stagingStrategy: 'staging-root',
    vaultGrantRef: null,
  },
  validation: {
    ok: true,
    resourceKind: 'git_repository',
    status: 'ready',
    summary: 'Repository is ready.',
    pathSummary: 'git repository ending in market-research',
  },
} as const;

const REPOSITORY_DIAGNOSTIC = {
  workspaceId: 'ws1',
  resourceId: REPOSITORY_RESOURCE.resourceId,
  type: 'git_repository',
  displayName: REPOSITORY_RESOURCE.displayName,
  diagnosticsStatus: 'ready',
  ready: true,
  summary: 'Repository is ready for governed push.',
  pathSummary: REPOSITORY_RESOURCE.pathSummary,
  updatedAt: TIMESTAMP_NEW,
} as const;

const PUSH_TARGET = {
  threadId: 'th_push',
  turnId: 'tu_push',
  sourceRef: 'HEAD',
  targetBranch: 'main',
  commitIds: ['abc123', 'def456'],
} as const;

const PUSH_APPROVAL = {
  approval: {
    id: 'ap_push',
    workspaceId: 'ws1',
    threadId: PUSH_TARGET.threadId,
    turnId: PUSH_TARGET.turnId,
    kind: 'permission',
    status: 'granted',
    title: 'Approve Git push to main',
    description: 'Publish abc123 and def456 from HEAD to main.',
    createdAt: TIMESTAMP_OLD,
    resolvedAt: TIMESTAMP_NEW,
  },
  approvalItemId: 'it_push_approval',
  policyDecisionId: 'pd_push',
} as const;

const PENDING_PUSH_APPROVAL = {
  ...PUSH_APPROVAL,
  approval: {
    ...PUSH_APPROVAL.approval,
    status: 'pending',
    resolvedAt: null,
  },
} as const;

const PUSH_RECORD = {
  id: 'gpr_push',
  workspaceId: 'ws1',
  repositoryResourceId: REPOSITORY_RESOURCE.resourceId,
  approvalRowId: PUSH_APPROVAL.approvalItemId,
  policyDecisionId: PUSH_APPROVAL.policyDecisionId,
  actorId: 'user_1',
  remoteSummary: 'GitHub repository market-research on origin',
  sourceRef: PUSH_TARGET.sourceRef,
  targetBranch: PUSH_TARGET.targetBranch,
  commitIds: [...PUSH_TARGET.commitIds],
  reviewIds: ['review_1'],
  remoteHeadBefore: 'def456',
  remoteHeadAfter: PUSH_TARGET.commitIds[0],
  outcome: 'pushed',
  errorSummary: null,
  createdAt: TIMESTAMP_NEW,
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
      href: '/api/approvals/ap1/respond',
    },
    { kind: 'deny_approval', label: 'Skip', method: 'POST', href: '/api/approvals/ap1/respond' },
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
    { kind: 'answer_question', label: 'Answer', method: 'POST', href: '/api/turns' },
    { kind: 'open_thread', label: 'Open', method: 'GET', href: '/api/workspaces/ws1/threads/th2' },
  ],
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

const AGENT_DETAIL = {
  ...AGENT_READY,
  modelId: 'gpt-authoritative',
  health: { status: 'ready', message: 'Authoritative health', checkedAt: TIMESTAMP_NEW },
};

const DEFAULT_REPOSITORY_INPUT = {
  displayName: 'Linked default repository',
  localPath: '/tmp/openkit-default-repo',
} as const;

const UPDATED_REPOSITORY_RESOURCE = {
  ...REPOSITORY_RESOURCE,
  displayName: DEFAULT_REPOSITORY_INPUT.displayName,
  pathSummary: 'git repository ending in openkit-default-repo',
};

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
  overrides: {
    core?: MethodOverrides;
    app?: MethodOverrides;
    agents?: MethodOverrides;
    actionCenter?: MethodOverrides;
    repositories?: MethodOverrides;
  } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A] }),
      listKnowledge: vi.fn().mockResolvedValue({ items: [] }),
      createKnowledge: vi.fn().mockResolvedValue(KNOWLEDGE_ENTRY),
      updateKnowledge: vi.fn().mockResolvedValue(UPDATED_KNOWLEDGE_ENTRY),
      deleteKnowledge: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({
        id: 'ws-new',
        name: 'New workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: TIMESTAMP_NEW,
        updatedAt: TIMESTAMP_NEW,
      }),
      respondApproval: vi.fn().mockResolvedValue({}),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      getWorkspaceDashboard: vi.fn().mockResolvedValue({
        workspace: { id: WORKSPACE_A.id, name: WORKSPACE_A.name },
        counts: {
          threadCount: 2,
          artifactCount: 0,
          knowledgeEntryCount: 0,
          providerCount: 1,
        },
        defaultContext: { modelId: null, agentId: null, skillIds: [] },
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
      submitArtifactReviewDecision: vi.fn().mockResolvedValue({}),
      listKnowledgeSources: vi.fn().mockResolvedValue({ items: [] }),
      listKnowledgeObservations: vi.fn().mockResolvedValue({ items: [] }),
      listKnowledgeClaims: vi.fn().mockResolvedValue({ items: [] }),
      listKnowledgeConflicts: vi.fn().mockResolvedValue({ items: [] }),
      readKnowledgeIndexes: vi.fn().mockResolvedValue(EMPTY_KNOWLEDGE_INDEXES),
      registerKnowledgeSource: vi.fn(),
      readKnowledgeSource: vi.fn(),
      recordKnowledgeObservation: vi.fn(),
      recordKnowledgeClaim: vi.fn(),
      recordKnowledgeConflict: vi.fn(),
      resolveKnowledgeConflict: vi.fn(),
      retrieveKnowledge: vi.fn(),
      prepareKnowledgeContext: vi.fn(),
      answerKnowledgeManager: vi.fn(),
      draftKnowledgeProposal: vi.fn(),
      suggestKnowledgeRepairs: vi.fn(),
      checkKnowledgeHealth: vi.fn(),
      reverseKnowledgeProposal: vi.fn(),
      submitKnowledgeProposalDecision: vi.fn().mockResolvedValue({}),
      ...overrides.app,
    },
    agents: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      get: vi.fn().mockResolvedValue(AGENT_READY),
      refreshHealth: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.agents,
    },
    actionCenter: {
      listHumanAttention: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.actionCenter,
    },
    repositories: {
      list: vi.fn().mockResolvedValue({
        items: [REPOSITORY_RESOURCE],
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_RESOURCE,
      }),
      diagnostics: vi.fn().mockResolvedValue({
        workspaceId: 'ws1',
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_DIAGNOSTIC,
        resources: [REPOSITORY_DIAGNOSTIC],
      }),
      listGitPushRecords: vi.fn().mockResolvedValue({ items: [PUSH_RECORD] }),
      getGitPushRecord: vi.fn().mockResolvedValue(PUSH_RECORD),
      requestGitPushApproval: vi.fn().mockResolvedValue(PUSH_APPROVAL),
      executeGitPush: vi.fn().mockResolvedValue(PUSH_RECORD),
      setDefault: vi.fn(),
      ...overrides.repositories,
    },
  } as unknown as CoreClient;
}

/** Enters one bounded default-repository command in the live Repositories form. */
async function enterDefaultRepository(
  user: ReturnType<typeof userEvent.setup>,
  input: { displayName: string; localPath: string } = DEFAULT_REPOSITORY_INPUT
) {
  for (const [name, value] of [
    ['Display name', input.displayName],
    ['Local path', input.localPath],
  ] as const) {
    const field = screen.getByRole('textbox', { name });
    await user.clear(field);
    await user.type(field, value);
  }
}

/** Enters one exact versioned Git push target in the live Repositories form. */
async function enterPushTarget(user: ReturnType<typeof userEvent.setup>) {
  for (const [name, value] of [
    ['Thread ID', PUSH_TARGET.threadId],
    ['Turn ID', PUSH_TARGET.turnId],
    ['Source ref', PUSH_TARGET.sourceRef],
    ['Target branch', PUSH_TARGET.targetBranch],
    ['Commit IDs', PUSH_TARGET.commitIds.join(' ')],
  ] as const) {
    const input = screen.getByRole('textbox', { name });
    await user.clear(input);
    await user.type(input, value);
  }
}

/** Returns one labelled Knowledge product panel on the existing /knowledge surface. */
function knowledgePanel(name: 'Sources' | 'Ledger' | 'Retrieval' | 'Manager') {
  return screen.getByRole('region', { name });
}

/** Enters bounded Knowledge panel fields without using the page-CRUD Title/Content labels. */
async function fillKnowledgeFields(
  user: ReturnType<typeof userEvent.setup>,
  region: HTMLElement,
  fields: ReadonlyArray<readonly [string, string]>
) {
  for (const [name, value] of fields) {
    const field = within(region).getByRole('textbox', { name });
    await user.clear(field);
    await user.type(field, value);
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
    method: 'registerKnowledgeSource',
    inputIndex: 1,
  },
  {
    typeName: 'RecordKnowledgeObservationCommand',
    hookName: 'useRecordKnowledgeObservation',
    method: 'recordKnowledgeObservation',
    inputIndex: 1,
  },
  {
    typeName: 'RecordKnowledgeClaimCommand',
    hookName: 'useRecordKnowledgeClaim',
    method: 'recordKnowledgeClaim',
    inputIndex: 1,
  },
  {
    typeName: 'RecordKnowledgeConflictCommand',
    hookName: 'useRecordKnowledgeConflict',
    method: 'recordKnowledgeConflict',
    inputIndex: 1,
  },
  {
    typeName: 'ResolveKnowledgeConflictCommand',
    hookName: 'useResolveKnowledgeConflict',
    method: 'resolveKnowledgeConflict',
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
function callsOn(method: { mock: { calls: unknown[][] } }, workspaceId: string) {
  return method.mock.calls.filter((call) => call[0] === workspaceId);
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
      .mockImplementation((workspaceId: string) => Promise.resolve(catalog(workspaceId).sources)),
    listKnowledgeObservations: vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        Promise.resolve(catalog(workspaceId).observations)
      ),
    listKnowledgeClaims: vi
      .fn()
      .mockImplementation((workspaceId: string) => Promise.resolve(catalog(workspaceId).claims)),
    listKnowledgeConflicts: vi
      .fn()
      .mockImplementation((workspaceId: string) => Promise.resolve(catalog(workspaceId).conflicts)),
    readKnowledgeIndexes: vi
      .fn()
      .mockImplementation((workspaceId: string) => Promise.resolve(catalog(workspaceId).indexes)),
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
  method: { mock: { calls: unknown[][] } },
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
  expect(method.mock.calls.every((call) => call[0] === workspaceId)).toBe(true);
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
      actionCenter: {
        listHumanAttention: vi.fn().mockReturnValue(new Promise(() => {})),
      },
    });
    renderApp('/', client);
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows the empty "caught up" state when nothing needs you', async () => {
    renderApp('/', makeClient());
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it('renders Needs-you rows longest-waiting first and decides approvals inline', async () => {
    const user = userEvent.setup();
    const respondApproval = vi.fn().mockResolvedValue({});
    const listHumanAttention = vi.fn().mockResolvedValue({
      items: [OPEN_ONLY_ROW, APPROVAL_ROW],
    });
    const client = makeClient({
      core: { respondApproval },
      actionCenter: { listHumanAttention },
    });
    renderApp('/', client);

    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    expect(screen.getByText('Answer required')).toBeInTheDocument();

    const titles = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    expect(titles[0]).toBe('Scout asks to sign in to the vendor portal');
    expect(titles[1]).toBe('Answer required');

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith('ap1', {
        workspaceId: 'ws1',
        threadId: 'th1',
        turnId: 't1',
        decision: 'granted',
      })
    );
  });

  it('shows an Open link when a row cannot be decided inline', async () => {
    const client = makeClient({
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({ items: [OPEN_ONLY_ROW] }),
      },
    });
    renderApp('/', client);
    expect(await screen.findByText('Answer required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open thread' })).toHaveAttribute(
      'href',
      '/chat/th2?workspaceId=ws1'
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows an error banner with retry when the queue fails', async () => {
    const user = userEvent.setup();
    const listHumanAttention = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ items: [] });
    const client = makeClient({ actionCenter: { listHumanAttention } });
    renderApp('/', client);
    expect(await screen.findByText(/Couldn't load what needs you/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
  });

  it('disables inline actions and marks counts stale when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }),
      },
    });
    renderApp('/', client);
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
      },
      { timeout: 3000 }
    );
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });
});

describe('Agents (board 08)', () => {
  it('lists agents with plain-language readiness', async () => {
    const client = makeClient({
      agents: {
        list: vi.fn().mockResolvedValue({ items: [AGENT_READY, AGENT_WORKING] }),
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
      agents: { list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
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

  it('marks readiness stale when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      agents: { list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/stale/i)).toBeInTheDocument(), {
      timeout: 3000,
    });
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
    renderApp('/agents', makeClient({ agents: { list, refreshHealth } }));

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(refreshHealth).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /refresh health/i }));

    await waitFor(() => expect(refreshHealth).toHaveBeenCalledWith('ws1'));
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
        agents: { get, list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    const details = screen.getByText('View details').closest('details') as HTMLElement;
    await user.click(within(details).getByText('View details'));

    await waitFor(() => expect(get).toHaveBeenCalledWith(AGENT_READY.id));
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
        agents: { get, list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const details = screen.getByText('View details').closest('details') as HTMLElement;
    await user.click(within(details).getByText('View details'));

    await waitFor(() => expect(get).toHaveBeenCalledWith(AGENT_READY.id));
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
        agents: { get, list, refreshHealth },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const details = screen.getByText('View details').closest('details') as HTMLElement;
    await user.click(within(details).getByText('View details'));
    await waitFor(() => expect(get).toHaveBeenCalledWith(AGENT_READY.id));
    expect(within(details).getByText(/Authoritative health/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh health/i }));
    await waitFor(() => expect(refreshHealth).toHaveBeenCalledWith('ws1'));
    expect(refreshHealth).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get.mock.calls).toEqual([[AGENT_READY.id], [AGENT_READY.id]]);
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
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
        },
        agents: {
          list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
          refreshHealth,
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh health/i }));
    await waitFor(() => expect(refreshHealth).toHaveBeenCalledWith(WORKSPACE_A.id));
    expect(refreshHealth).toHaveBeenCalledTimes(1);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't refresh/i);
    expect(alert).not.toHaveTextContent('Health refresh rejected.');

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(refreshHealth.mock.calls.every((call) => call[0] === WORKSPACE_A.id)).toBe(true)
    );
    await proveWriteDoesNotRetarget(user, refreshHealth, WORKSPACE_A.id);
    expect(refreshHealth).not.toHaveBeenCalledWith(WORKSPACE_B.id);
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
        agents: {
          list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }),
          refreshHealth,
        },
      })
    );

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh health/i }));
    await waitFor(() => expect(refreshHealth).toHaveBeenCalledWith(WORKSPACE_A.id));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't refresh/i);
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeEnabled();

    meta.mockRejectedValue(new Error('down'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['core', 'meta'] });
    });
    await waitFor(() => expect(screen.getByText(/stale/i)).toBeInTheDocument());
    const retry = within(alert).getByRole('button', { name: /try again/i });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(refreshHealth).toHaveBeenCalledTimes(1);
    expect(refreshHealth.mock.calls).toEqual([[WORKSPACE_A.id]]);
  });
});

describe('Knowledge (board 14)', () => {
  it('lists knowledge entries', async () => {
    const client = makeClient({
      core: { listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }) },
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
    const client = makeClient({ core: { createKnowledge } });
    renderApp('/knowledge', client);
    await screen.findByText(/No entries yet/i);
    await user.click(screen.getByRole('button', { name: /Add knowledge/i }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Prefer concise memos');
    await user.type(screen.getByRole('textbox', { name: 'Content' }), 'Keep it short.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(createKnowledge).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({
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
    renderApp('/knowledge', makeClient({ core: { listKnowledge, updateKnowledge } }));

    await user.click(await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const content = screen.getByRole('textbox', { name: 'Content' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(title).toHaveValue(KNOWLEDGE_ENTRY.title);
    expect(content).toHaveValue(KNOWLEDGE_ENTRY.content);
    expect(save).toBeDisabled();

    await user.clear(title);
    await user.type(title, '   ');
    expect(save).toBeDisabled();
    await user.clear(title);
    await user.type(title, 'Prefer concise release notes');
    await user.click(save);

    await waitFor(() =>
      expect(updateKnowledge).toHaveBeenCalledWith('ws1', KNOWLEDGE_ENTRY.id, {
        requestId: expect.any(String),
        title: 'Prefer concise release notes',
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
          listKnowledge: vi.fn().mockResolvedValue({ items: [entry] }),
          updateKnowledge,
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
    await user.type(content, 'Changed server content');
    await user.click(save);
    await waitFor(() =>
      expect(updateKnowledge).toHaveBeenCalledWith('ws1', entry.id, {
        content: 'Changed server content',
        requestId: expect.any(String),
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
    renderApp('/knowledge', makeClient({ core: { listKnowledge, updateKnowledge } }));

    await user.click(await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const content = screen.getByRole('textbox', { name: 'Content' });
    await user.clear(content);
    await user.type(content, 'Unsaved local content');
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
    renderApp('/knowledge', makeClient({ core: { deleteKnowledge, listKnowledge } }));

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove knowledge' });
    expect(deleteKnowledge).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(deleteKnowledge).toHaveBeenCalledWith('ws1', KNOWLEDGE_ENTRY.id, {
        requestId: expect.any(String),
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
    renderApp('/knowledge', makeClient({ core: { deleteKnowledge, listKnowledge } }));

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
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          [operation === 'update' ? 'updateKnowledge' : 'deleteKnowledge']: mutation,
        },
      })
    );

    if (operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, 'Unsaved local wording');
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
          listKnowledge,
          [`${operation}Knowledge`]: mutation,
        },
      })
    );

    if (operation === 'create') {
      await screen.findByText(/No entries yet/i);
      await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
      await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Prefer concise memos');
      await user.type(screen.getByRole('textbox', { name: 'Content' }), 'Keep it short.');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, 'Unsaved local wording');
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
    expect(firstCall?.[0]).toBe(WORKSPACE_A.id);
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
      await user.type(screen.getByRole('textbox', { name: 'Title' }), laterEntry.title);
      await user.type(screen.getByRole('textbox', { name: 'Content' }), laterEntry.content);
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
      );
      await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, laterEntry.title);
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
    expect(mutation.mock.calls[2]?.[0]).toBe(WORKSPACE_A.id);
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
          deleteKnowledge,
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          updateKnowledge,
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
    await user.type(content, 'Pending content change');
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
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
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
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          [`${operation}Knowledge`]: vi.fn().mockReturnValue(pending.promise),
        },
      })
    );

    await screen.findByText(KNOWLEDGE_ENTRY.title);
    if (operation === 'create') {
      await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
      await user.type(screen.getByRole('textbox', { name: 'Title' }), 'New preference');
      await user.type(screen.getByRole('textbox', { name: 'Content' }), 'New content');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, 'Changed preference');
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
        app: { listKnowledgeClaims, listKnowledgeObservations, listKnowledgeSources },
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
    expect(listKnowledgeSources).toHaveBeenCalledWith('ws1');
    expect(listKnowledgeObservations).toHaveBeenCalledWith('ws1');
    expect(listKnowledgeClaims).toHaveBeenCalledWith('ws1');
  });

  it('keeps a Loading skeleton visible until the attention read settles', async () => {
    const attentionRead = createDeferred<{ items: [] }>();
    renderApp(
      '/knowledge',
      makeClient({
        core: { listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }) },
        actionCenter: { listHumanAttention: vi.fn().mockReturnValue(attentionRead.promise) },
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
    renderApp('/knowledge', makeClient({ app: { listKnowledgeSources } }));

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
        actionCenter: { listHumanAttention },
        app: {
          listKnowledgeClaims,
          listKnowledgeObservations,
          listKnowledgeSources,
          submitKnowledgeProposalDecision,
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
        actionCenter: {
          listHumanAttention: vi
            .fn()
            .mockResolvedValue({ items: [NON_KNOWLEDGE_PROPOSAL_DECOY, row] }),
        },
        app: { submitKnowledgeProposalDecision },
      })
    );

    const action = await screen.findByRole('button', { name: label });
    for (const absentLabel of ['Accept', 'Reject', 'Defer'].filter((item) => item !== label)) {
      expect(screen.queryByRole('button', { name: absentLabel })).not.toBeInTheDocument();
    }
    await user.click(action);
    await waitFor(() =>
      expect(submitKnowledgeProposalDecision).toHaveBeenCalledWith('ws1', 'kp_exact', {
        decision,
        requestId: expect.any(String),
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
        actionCenter: { listHumanAttention: vi.fn().mockResolvedValue({ items: [row] }) },
        app: { submitKnowledgeProposalDecision },
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
        actionCenter: { listHumanAttention },
        app: { submitKnowledgeProposalDecision },
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
        actionCenter: {
          listHumanAttention: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_PROPOSAL_ROW] }),
        },
        app: { submitKnowledgeProposalDecision },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const alert = await screen.findByRole('alert');
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    const firstRequestId = submitKnowledgeProposalDecision.mock.calls[0]?.[2].requestId;

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(2));
    expect(submitKnowledgeProposalDecision.mock.calls[1]?.[2].requestId).not.toBe(firstRequestId);
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
    const listHumanAttention = vi.fn().mockImplementation((workspaceId: string) =>
      Promise.resolve({
        items: workspaceId === WORKSPACE_B.id ? [proposalB] : [KNOWLEDGE_PROPOSAL_ROW],
      })
    );
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
        },
        actionCenter: { listHumanAttention },
        app: { submitKnowledgeProposalDecision },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't submit that proposal decision/i);
    expect(alert).not.toHaveTextContent('decision failed.');
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    expect(submitKnowledgeProposalDecision.mock.calls[0]?.[0]).toBe(WORKSPACE_A.id);
    expect(submitKnowledgeProposalDecision.mock.calls[0]?.[1]).toBe('kp_exact');
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
      WORKSPACE_A.id,
      'kp_exact',
      expect.objectContaining({ decision: 'rejected' }),
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
        core: { meta },
        actionCenter: {
          listHumanAttention: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_PROPOSAL_ROW] }),
        },
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
        app: { listKnowledgeSources, readKnowledgeSource, registerKnowledgeSource },
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
      expect(registerKnowledgeSource).toHaveBeenCalledWith('ws1', {
        requestId: expect.any(String),
        kind: REGISTER_SOURCE_INPUT.kind,
        title: REGISTER_SOURCE_INPUT.title,
        content: REGISTER_SOURCE_INPUT.content,
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
      expect(readKnowledgeSource).toHaveBeenCalledWith('ws1', KNOWLEDGE_SOURCE.id)
    );
    expect(within(sources).getByText('Text')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SOURCE_DERIVED_REPRESENTATION.path);
    expect(readKnowledgeSource).toHaveBeenCalledTimes(1);
  });

  it('records ledger rows from the Ledger panel, lists conflicts, and resolves through an accessible control', async () => {
    const user = userEvent.setup();
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
          listKnowledgeClaims,
          listKnowledgeConflicts,
          listKnowledgeObservations,
          recordKnowledgeClaim,
          recordKnowledgeConflict,
          recordKnowledgeObservation,
          resolveKnowledgeConflict,
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
    expect(listKnowledgeConflicts.mock.calls).toEqual([['ws1']]);

    await selectListedOption(user, ledger, 'Observation kind', OBSERVATION_KIND_OPTION);
    await fillKnowledgeFields(user, ledger, [
      ['Observation summary', KNOWLEDGE_OBSERVATION.summary],
      ['Observation producer', KNOWLEDGE_OBSERVATION.producer],
    ]);
    await user.click(within(ledger).getByRole('button', { name: 'Record observation' }));
    await waitFor(() =>
      expect(recordKnowledgeObservation).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({
          requestId: expect.any(String),
          kind: OBSERVATION_KIND,
          summary: KNOWLEDGE_OBSERVATION.summary,
          producer: KNOWLEDGE_OBSERVATION.producer,
        })
      )
    );
    await waitFor(() => expect(listKnowledgeObservations).toHaveBeenCalledTimes(2));
    expect(listKnowledgeObservations.mock.calls).toEqual([['ws1'], ['ws1']]);
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
        'ws1',
        expect.objectContaining({
          requestId: expect.any(String),
          statement: KNOWLEDGE_CLAIM.statement,
          producer: KNOWLEDGE_CLAIM.producer,
        })
      )
    );
    await waitFor(() => expect(listKnowledgeClaims).toHaveBeenCalledTimes(2));
    expect(listKnowledgeClaims.mock.calls).toEqual([['ws1'], ['ws1']]);
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
        'ws1',
        expect.objectContaining({
          requestId: expect.any(String),
          summary: CONFLICT_SUMMARY,
          subjectReferences: KNOWLEDGE_CONFLICT.subjectReferences,
          producer: KNOWLEDGE_CONFLICT.producer,
        })
      )
    );
    await waitFor(() => expect(listKnowledgeConflicts).toHaveBeenCalledTimes(2));
    expect(listKnowledgeConflicts.mock.calls).toEqual([['ws1'], ['ws1']]);
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
      expect(resolveKnowledgeConflict).toHaveBeenCalledWith('ws1', KNOWLEDGE_CONFLICT.id, {
        requestId: expect.any(String),
        resolution: CONFLICT_RESOLUTION,
        resolvedBy: 'user:test',
      })
    );
    await waitFor(() => expect(listKnowledgeConflicts).toHaveBeenCalledTimes(3));
    expect(listKnowledgeConflicts.mock.calls).toEqual([['ws1'], ['ws1'], ['ws1']]);
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
        app: { prepareKnowledgeContext, readKnowledgeIndexes, retrieveKnowledge },
      })
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const retrieval = knowledgePanel('Retrieval');
    await waitFor(() => expect(readKnowledgeIndexes).toHaveBeenCalledWith('ws1'));
    expect(await within(retrieval).findByText('weekly')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('knowledge/pages/mem1.md');

    await fillKnowledgeFields(user, retrieval, [['Query', RETRIEVAL_QUERY]]);
    await user.click(within(retrieval).getByRole('button', { name: 'Retrieve' }));
    await waitFor(() =>
      expect(retrieveKnowledge).toHaveBeenCalledWith('ws1', { query: RETRIEVAL_QUERY })
    );
    expect(await within(retrieval).findByText(RETRIEVAL_TRACE_ID)).toBeInTheDocument();
    expect(within(retrieval).getByText(KNOWLEDGE_ENTRY.id)).toBeInTheDocument();
    expect(within(retrieval).getByText('Sensitive content')).toBeInTheDocument();
    expect(screen.queryByText('sensitive_content')).not.toBeInTheDocument();

    await user.click(within(retrieval).getByRole('button', { name: 'Prepare context' }));
    await waitFor(() =>
      expect(prepareKnowledgeContext).toHaveBeenCalledWith('ws1', { query: RETRIEVAL_QUERY })
    );
    expect(await within(retrieval).findByText('prepared')).toBeInTheDocument();
    expect(readKnowledgeIndexes).toHaveBeenCalledTimes(1);
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
    expect(prepareKnowledgeContext).toHaveBeenCalledTimes(1);
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
          answerKnowledgeManager,
          checkKnowledgeHealth,
          draftKnowledgeProposal,
          reverseKnowledgeProposal,
          suggestKnowledgeRepairs,
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
      expect(answerKnowledgeManager).toHaveBeenCalledWith('ws1', { query: MANAGER_QUESTION })
    );
    expect(await within(manager).findByText(KNOWLEDGE_ANSWER.answer)).toBeInTheDocument();

    await user.click(within(manager).getByRole('button', { name: 'Suggest repairs' }));
    await user.click(within(manager).getByRole('button', { name: 'Check health' }));
    await waitFor(() => expect(suggestKnowledgeRepairs).toHaveBeenCalledWith('ws1', { limit: 10 }));
    await waitFor(() => expect(checkKnowledgeHealth).toHaveBeenCalledWith('ws1', { limit: 10 }));
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
      method: 'registerKnowledgeSource',
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
        method: 'listKnowledgeSources' as const,
        initial: { items: [KNOWLEDGE_SOURCE] },
        after: { items: [KNOWLEDGE_SOURCE, REGISTERED_SOURCE] },
      },
      result: REGISTERED_SOURCE.title,
      echo: 'Mutation source must not become visible',
      expected: [
        [
          'ws1',
          expect.objectContaining({
            kind: REGISTER_SOURCE_INPUT.kind,
            title: REGISTER_SOURCE_INPUT.title,
            content: REGISTER_SOURCE_INPUT.content,
          }),
        ],
      ],
    },
    {
      method: 'readKnowledgeSource',
      panel: 'Sources' as const,
      kind: 'failed',
      privateText: 'Source not found.',
      error: new ApiCallError(404, 'Source not found.', { code: 'not_found' }),
      message: /couldn't load/i,
      action: `View ${KNOWLEDGE_SOURCE.title}`,
      seed: { listKnowledgeSources: { items: [KNOWLEDGE_SOURCE] } },
      success: {
        source: KNOWLEDGE_SOURCE,
        derivedRepresentations: [SOURCE_DERIVED_REPRESENTATION],
      },
      result: 'Text',
      expected: [['ws1', KNOWLEDGE_SOURCE.id]],
    },
    {
      method: 'recordKnowledgeObservation',
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
        method: 'listKnowledgeObservations' as const,
        initial: { items: [] },
        after: { items: [SERVER_OBSERVATION] },
      },
      result: SERVER_OBSERVATION.summary,
      echo: 'Mutation observation must not become visible',
      expected: [
        [
          'ws1',
          expect.objectContaining({
            kind: OBSERVATION_KIND,
            summary: KNOWLEDGE_OBSERVATION.summary,
            producer: KNOWLEDGE_OBSERVATION.producer,
          }),
        ],
      ],
    },
    {
      method: 'recordKnowledgeClaim',
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
        method: 'listKnowledgeClaims' as const,
        initial: { items: [] },
        after: { items: [SERVER_CLAIM] },
      },
      result: SERVER_CLAIM.statement,
      echo: 'Mutation claim must not become visible',
      expected: [
        [
          'ws1',
          expect.objectContaining({
            statement: KNOWLEDGE_CLAIM.statement,
            producer: KNOWLEDGE_CLAIM.producer,
          }),
        ],
      ],
    },
    {
      method: 'recordKnowledgeClaim',
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
        method: 'listKnowledgeClaims' as const,
        initial: { items: [] },
        after: { items: [SERVER_CLAIM] },
      },
      result: SERVER_CLAIM.statement,
      echo: 'Mutation claim must not become visible',
      expected: [
        [
          'ws1',
          expect.objectContaining({
            statement: KNOWLEDGE_CLAIM.statement,
            producer: KNOWLEDGE_CLAIM.producer,
          }),
        ],
      ],
    },
    {
      method: 'listKnowledgeConflicts',
      panel: 'Ledger' as const,
      kind: 'denied',
      privateText: 'Conflict list denied.',
      error: accessDenied('Conflict list denied.'),
      message: /couldn't load|access denied/i,
      success: { items: [KNOWLEDGE_CONFLICT] },
      result: KNOWLEDGE_CONFLICT.summary,
      expected: [['ws1']],
    },
    {
      method: 'listKnowledgeConflicts',
      panel: 'Ledger' as const,
      kind: 'failed',
      privateText: 'Conflict list failed.',
      error: operationFailed('Conflict list failed.'),
      message: /couldn't load/i,
      success: { items: [KNOWLEDGE_CONFLICT] },
      result: KNOWLEDGE_CONFLICT.summary,
      expected: [['ws1']],
    },
    {
      method: 'recordKnowledgeConflict',
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
        method: 'listKnowledgeConflicts' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [KNOWLEDGE_CONFLICT, SERVER_CONFLICT] },
      },
      result: SERVER_CONFLICT.summary,
      echo: 'Mutation conflict must not become visible',
      expected: [
        [
          'ws1',
          expect.objectContaining({
            summary: CONFLICT_SUMMARY,
            subjectReferences: KNOWLEDGE_CONFLICT.subjectReferences,
            producer: KNOWLEDGE_CONFLICT.producer,
          }),
        ],
      ],
    },
    {
      method: 'recordKnowledgeConflict',
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
        method: 'listKnowledgeConflicts' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [KNOWLEDGE_CONFLICT, SERVER_CONFLICT] },
      },
      result: SERVER_CONFLICT.summary,
      echo: 'Mutation conflict must not become visible',
      expected: [
        [
          'ws1',
          expect.objectContaining({
            summary: CONFLICT_SUMMARY,
            subjectReferences: KNOWLEDGE_CONFLICT.subjectReferences,
            producer: KNOWLEDGE_CONFLICT.producer,
          }),
        ],
      ],
    },
    {
      method: 'resolveKnowledgeConflict',
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
        method: 'listKnowledgeConflicts' as const,
        initial: { items: [KNOWLEDGE_CONFLICT] },
        after: { items: [SERVER_RESOLVED_CONFLICT] },
      },
      result: SERVER_RESOLVED_CONFLICT.resolution,
      echo: 'Mutation resolution is not authority',
      expected: [
        [
          'ws1',
          KNOWLEDGE_CONFLICT.id,
          expect.objectContaining({
            resolution: CONFLICT_RESOLUTION,
            resolvedBy: 'user:test',
          }),
        ],
      ],
    },
    {
      method: 'readKnowledgeIndexes',
      panel: 'Retrieval' as const,
      kind: 'denied',
      privateText: 'Index read denied.',
      error: accessDenied('Index read denied.'),
      message: /couldn't load|access denied/i,
      success: KNOWLEDGE_INDEXES,
      result: 'weekly',
      expected: [['ws1']],
    },
    {
      method: 'readKnowledgeIndexes',
      panel: 'Retrieval' as const,
      kind: 'failed',
      privateText: 'Index read failed.',
      error: operationFailed('Index read failed.'),
      message: /couldn't load/i,
      success: KNOWLEDGE_INDEXES,
      result: 'weekly',
      expected: [['ws1']],
    },
    {
      method: 'retrieveKnowledge',
      panel: 'Retrieval' as const,
      kind: 'failed',
      privateText: 'Retrieval rejected.',
      error: operationFailed('Retrieval rejected.'),
      message: /couldn't retrieve/i,
      action: 'Retrieve',
      fields: [['Query', RETRIEVAL_QUERY]] as const,
      success: KNOWLEDGE_RETRIEVAL,
      result: RETRIEVAL_TRACE_ID,
      expected: [['ws1', { query: RETRIEVAL_QUERY }]],
    },
    {
      method: 'prepareKnowledgeContext',
      panel: 'Retrieval' as const,
      kind: 'failed',
      privateText: 'Context rejected.',
      error: operationFailed('Context rejected.'),
      message: /couldn't prepare/i,
      action: 'Prepare context',
      fields: [['Query', RETRIEVAL_QUERY]] as const,
      success: KNOWLEDGE_CONTEXT,
      result: 'prepared',
      expected: [['ws1', { query: RETRIEVAL_QUERY }]],
    },
    {
      method: 'answerKnowledgeManager',
      panel: 'Manager' as const,
      kind: 'failed',
      privateText: 'Answer rejected.',
      error: operationFailed('Answer rejected.'),
      message: /couldn't answer/i,
      action: 'Answer',
      fields: [['Question', MANAGER_QUESTION]] as const,
      success: KNOWLEDGE_ANSWER,
      result: KNOWLEDGE_ANSWER.answer,
      expected: [['ws1', { query: MANAGER_QUESTION }]],
    },
    {
      method: 'suggestKnowledgeRepairs',
      panel: 'Manager' as const,
      kind: 'denied',
      privateText: 'Repair suggestion denied.',
      error: accessDenied('Repair suggestion denied.'),
      message: /couldn't suggest|access denied/i,
      action: 'Suggest repairs',
      success: KNOWLEDGE_REPAIRS,
      result: KNOWLEDGE_REPAIR.title,
      expected: [['ws1', { limit: 10 }]],
    },
    {
      method: 'suggestKnowledgeRepairs',
      panel: 'Manager' as const,
      kind: 'failed',
      privateText: 'Repair suggestion failed.',
      error: operationFailed('Repair suggestion failed.'),
      message: /couldn't suggest/i,
      action: 'Suggest repairs',
      success: KNOWLEDGE_REPAIRS,
      result: KNOWLEDGE_REPAIR.title,
      expected: [['ws1', { limit: 10 }]],
    },
    {
      method: 'checkKnowledgeHealth',
      panel: 'Manager' as const,
      kind: 'failed',
      privateText: 'Health rejected.',
      error: operationFailed('Health rejected.'),
      message: /couldn't check|couldn't inspect/i,
      action: 'Check health',
      success: KNOWLEDGE_HEALTH,
      result: KNOWLEDGE_HEALTH.summary,
      expected: [['ws1', { limit: 10 }]],
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
      testCase.method === 'registerKnowledgeSource' ||
      testCase.method === 'recordKnowledgeObservation' ||
      testCase.method === 'recordKnowledgeClaim' ||
      testCase.method === 'recordKnowledgeConflict' ||
      testCase.method === 'resolveKnowledgeConflict'
    ) {
      expect(typeof firstRequestId).toBe('string');
      expect(requestIdFromCall(method.mock.calls[1])).toBe(firstRequestId);
    }
    if (owner && 'owner' in testCase && testCase.owner) {
      await waitFor(() => expect(owner.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(owner.mock.calls.every((call) => call[0] === 'ws1')).toBe(true);
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
          `input: Parameters<CoreClient\\['app'\\]\\['${slice.method}'\\]>\\[${slice.inputIndex}\\]`
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

  it('does not keep Workspace A Knowledge drafts submit-capable after switching to Workspace B', async () => {
    const user = userEvent.setup();
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
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
        },
        app: {
          listKnowledgeConflicts: vi.fn().mockImplementation((workspaceId: string) =>
            Promise.resolve({
              items: workspaceId === WORKSPACE_A.id ? [KNOWLEDGE_CONFLICT] : [],
            })
          ),
          answerKnowledgeManager,
          prepareKnowledgeContext,
          recordKnowledgeClaim,
          recordKnowledgeConflict,
          recordKnowledgeObservation,
          registerKnowledgeSource,
          resolveKnowledgeConflict,
          retrieveKnowledge,
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
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
          createKnowledge,
        },
      })
    );

    await screen.findByText(/No entries yet/i);
    await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Prefer concise memos');
    await user.type(screen.getByRole('textbox', { name: 'Content' }), 'Keep it short.');
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
    const listKnowledgeSources = vi.fn().mockImplementation((workspaceId: string) =>
      Promise.resolve({
        items: workspaceId === WORKSPACE_A.id ? [KNOWLEDGE_SOURCE] : [],
      })
    );
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
        },
        app: { listKnowledgeSources, registerKnowledgeSource },
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
      WORKSPACE_A.id,
      expect.objectContaining({ title: REGISTER_SOURCE_INPUT.title })
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
    const listKnowledge = vi.fn().mockImplementation((workspaceId: string) => {
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
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
          listKnowledge,
          [testCase.operation === 'update' ? 'updateKnowledge' : 'deleteKnowledge']: mutation,
        },
      })
    );
    if (testCase.operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, 'Prefer concise release notes');
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
    expect(mutation.mock.calls[0]?.[0]).toBe(WORKSPACE_A.id);

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
    const listHumanAttention = vi.fn().mockImplementation((workspaceId: string) => {
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
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
        },
        actionCenter: { listHumanAttention },
        app: { submitKnowledgeProposalDecision },
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1));
    expect(submitKnowledgeProposalDecision.mock.calls[0]?.[0]).toBe(WORKSPACE_A.id);

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
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({
            items: mode === 'switch' ? [WORKSPACE_A, WORKSPACE_B] : [WORKSPACE_A],
          }),
        },
        app: {
          listKnowledgeClaims,
          listKnowledgeConflicts,
          listKnowledgeObservations,
          listKnowledgeSources,
          readKnowledgeIndexes,
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
      method: 'registerKnowledgeSource',
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
        method: 'listKnowledgeSources' as const,
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
        'ws1',
        expect.objectContaining({
          kind: NEXT_REGISTER_SOURCE_INPUT.kind,
          title: NEXT_REGISTER_SOURCE_INPUT.title,
          content: NEXT_REGISTER_SOURCE_INPUT.content,
        }),
      ],
    },
    {
      method: 'recordKnowledgeObservation',
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
        method: 'listKnowledgeObservations' as const,
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
        'ws1',
        expect.objectContaining({
          kind: NEXT_OBSERVATION_KIND,
          summary: NEXT_OBSERVATION.summary,
          producer: NEXT_OBSERVATION.producer,
        }),
      ],
    },
    {
      method: 'recordKnowledgeClaim',
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
        method: 'listKnowledgeClaims' as const,
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
        'ws1',
        expect.objectContaining({
          statement: NEXT_CLAIM.statement,
          producer: NEXT_CLAIM.producer,
        }),
      ],
    },
    {
      method: 'recordKnowledgeConflict',
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
        method: 'listKnowledgeConflicts' as const,
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
        'ws1',
        expect.objectContaining({
          summary: NEXT_CONFLICT_INPUT.summary,
          subjectReferences: NEXT_CONFLICT_INPUT.subjectReferences,
          producer: NEXT_CONFLICT_INPUT.producer,
        }),
      ],
    },
    {
      method: 'resolveKnowledgeConflict',
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
        method: 'listKnowledgeConflicts' as const,
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
        'ws1',
        SECOND_CONFLICT.id,
        expect.objectContaining({
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
      method: 'listKnowledgeSources',
      panel: 'Sources' as const,
      message: /couldn't load/i,
      privateText: 'source list failed.',
    },
    {
      method: 'listKnowledgeObservations',
      panel: 'Ledger' as const,
      message: /couldn't load observations/i,
      privateText: 'observation list failed.',
    },
    {
      method: 'listKnowledgeClaims',
      panel: 'Ledger' as const,
      message: /couldn't load claims/i,
      privateText: 'claim list failed.',
    },
    {
      method: 'listKnowledgeConflicts',
      panel: 'Ledger' as const,
      message: /couldn't load conflicts/i,
      privateText: 'conflict list failed.',
    },
    {
      method: 'readKnowledgeIndexes',
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
    expect(method.mock.calls).toEqual([[WORKSPACE_A.id]]);
  });
});

describe('Repositories (board 19)', () => {
  it('validates the selected Workspace before the exact live reads and keeps the default repository command bounded', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_stale' });
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-private failure'))
      .mockResolvedValue({ items: [WORKSPACE_A] });
    const client = makeClient({ core: { listWorkspaces } });
    renderApp('/repositories', client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load workspaces/i);
    expect(alert).not.toHaveTextContent('workspace-private failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Repositories' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    expect(screen.getByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(screen.getByText(REPOSITORY_DIAGNOSTIC.summary)).toBeInTheDocument();
    expect(screen.getByText('Pushed', { exact: true })).toBeInTheDocument();

    const validatedAt = listWorkspaces.mock.invocationCallOrder[1];
    expect({
      resources: {
        calls: vi.mocked(client.repositories.list).mock.calls,
        afterValidation:
          vi.mocked(client.repositories.list).mock.invocationCallOrder[0] > validatedAt,
      },
      diagnostics: {
        calls: vi.mocked(client.repositories.diagnostics).mock.calls,
        afterValidation:
          vi.mocked(client.repositories.diagnostics).mock.invocationCallOrder[0] > validatedAt,
      },
      records: {
        calls: vi.mocked(client.repositories.listGitPushRecords).mock.calls,
        afterValidation:
          vi.mocked(client.repositories.listGitPushRecords).mock.invocationCallOrder[0] >
          validatedAt,
      },
      record: vi.mocked(client.repositories.getGitPushRecord).mock.calls,
    }).toEqual({
      resources: { calls: [['ws1']], afterValidation: true },
      diagnostics: { calls: [['ws1']], afterValidation: true },
      records: { calls: [['ws1']], afterValidation: true },
      record: [],
    });
    expect(client.repositories.setDefault).not.toHaveBeenCalled();
    expect(screen.queryByText(/changes waiting to apply/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|review changes/i })).not.toBeInTheDocument();
  });

  it('shows content-shaped loading while repository resources, diagnostics, and records are pending', async () => {
    const pending = new Promise(() => {});
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          list: vi.fn().mockReturnValue(pending),
          diagnostics: vi.fn().mockReturnValue(pending),
          listGitPushRecords: vi.fn().mockReturnValue(pending),
        },
      })
    );

    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows explicit empty states for repository resources, diagnostics, and push records', async () => {
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          list: vi.fn().mockResolvedValue({
            items: [],
            defaultResourceId: null,
            defaultResource: null,
          }),
          diagnostics: vi.fn().mockResolvedValue({
            workspaceId: 'ws1',
            defaultResourceId: null,
            defaultResource: null,
            resources: [],
          }),
          listGitPushRecords: vi.fn().mockResolvedValue({ items: [] }),
        },
      })
    );

    expect(await screen.findByText('No linked repositories', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No repository diagnostics', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No push records', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request approval' })).not.toBeInTheDocument();
  });

  it('shows one plain error and retries repository reads without invoking a mutation', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('repository-private failure'))
      .mockResolvedValue({
        items: [REPOSITORY_RESOURCE],
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_RESOURCE,
      });
    const requestGitPushApproval = vi.fn();
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({ repositories: { executeGitPush, list, requestGitPushApproval } })
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load repositories/i);
    expect(alert).not.toHaveTextContent('repository-private failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(requestGitPushApproval).not.toHaveBeenCalled();
    expect(executeGitPush).not.toHaveBeenCalled();
  });

  it('replays the exact pending approval request after an external grant and executes only after the authoritative granted response', async () => {
    const user = userEvent.setup();
    const recordRead = createDeferred<typeof PUSH_RECORD>();
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [] });
    const getGitPushRecord = vi.fn().mockReturnValue(recordRead.promise);
    let authoritativeApproval: typeof PENDING_PUSH_APPROVAL | typeof PUSH_APPROVAL =
      PENDING_PUSH_APPROVAL;
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn().mockResolvedValue(PUSH_RECORD);
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(1));
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Awaiting approval', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();

    authoritativeApproval = PUSH_APPROVAL;
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Approved', { exact: true })).toBeInTheDocument();
    const execute = await screen.findByRole('button', { name: 'Execute push' });
    expect(executeGitPush).not.toHaveBeenCalled();
    await user.click(execute);

    await waitFor(() => expect(executeGitPush).toHaveBeenCalledTimes(1));
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    await waitFor(() => expect(getGitPushRecord.mock.calls).toEqual([['ws1', PUSH_RECORD.id]]));
    expect(screen.queryByText('Pushed', { exact: true })).not.toBeInTheDocument();

    recordRead.resolve(PUSH_RECORD);
    expect(await screen.findByText('Pushed', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(4));
  });

  it('replaces a stale same-id list row with the exact authoritative record after execution', async () => {
    const user = userEvent.setup();
    const staleRecord = {
      ...PUSH_RECORD,
      remoteSummary: 'Stale same-id push record',
      sourceRef: 'refs/heads/stale',
      commitIds: ['stale123'],
      outcome: 'auth-failed' as const,
      errorSummary: 'Stale list projection',
    };
    const newerRecord = {
      ...PUSH_RECORD,
      id: 'gpr_newer',
      approvalRowId: 'it_newer_push_approval',
      remoteSummary: 'Concurrent newer push record',
      sourceRef: 'refs/heads/newer',
      commitIds: ['newer123'],
      outcome: 'refused-policy' as const,
      errorSummary: 'Newer refusal',
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
    };
    const olderRecord = {
      ...PUSH_RECORD,
      id: 'gpr_older',
      approvalRowId: 'it_older_push_approval',
      remoteSummary: 'Distinct older push record',
      sourceRef: 'refs/heads/older',
      commitIds: ['older123'],
      outcome: 'remote-unreachable' as const,
      errorSummary: 'Older remote failure',
      createdAt: TIMESTAMP_OLD,
      updatedAt: TIMESTAMP_OLD,
    };
    const listGitPushRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [newerRecord, staleRecord, olderRecord] });
    const requestGitPushApproval = vi.fn().mockResolvedValue(PUSH_APPROVAL);
    const executeGitPush = vi.fn().mockResolvedValue(PUSH_RECORD);
    const getGitPushRecord = vi.fn().mockResolvedValue(PUSH_RECORD);
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await user.click(await screen.findByRole('button', { name: 'Execute push' }));

    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.queryAllByText(PUSH_RECORD.remoteSummary, { exact: true })).toHaveLength(1)
    );
    expect(
      screen.getAllByText(
        `${PUSH_TARGET.sourceRef} to ${PUSH_TARGET.targetBranch} · ${PUSH_TARGET.commitIds.join(', ')}`,
        { exact: true }
      )
    ).toHaveLength(1);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    expect(screen.queryByText(staleRecord.remoteSummary, { exact: true })).not.toBeInTheDocument();
    const pushRecords = screen.getByText('Push records', { exact: true }).closest('section');
    expect(pushRecords).not.toBeNull();
    const expectedOrder: string[] = [
      newerRecord.remoteSummary,
      PUSH_RECORD.remoteSummary,
      olderRecord.remoteSummary,
    ];
    expect(
      within(pushRecords as HTMLElement)
        .getAllByText((content) => expectedOrder.includes(content))
        .map((element) => element.textContent)
    ).toEqual(expectedOrder);
    expect(screen.queryByText('Recovery required', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    expect(getGitPushRecord.mock.calls).toEqual([['ws1', PUSH_RECORD.id]]);
    expect(listGitPushRecords.mock.calls).toEqual([['ws1'], ['ws1'], ['ws1']]);
  });

  it('preserves refetched records and requires recovery for a mismatching authoritative record', async () => {
    const user = userEvent.setup();
    const refetchedRecord = {
      ...PUSH_RECORD,
      approvalRowId: 'it_previous_push_approval',
      remoteSummary: 'Preserved refetched push record',
    };
    const mismatchingRecord = {
      ...PUSH_RECORD,
      repositoryResourceId: 'repo_other',
      remoteSummary: 'Mismatching authoritative push record',
    };
    const listGitPushRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [refetchedRecord] });
    const requestGitPushApproval = vi.fn().mockResolvedValue(PUSH_APPROVAL);
    const executeGitPush = vi.fn().mockResolvedValue(PUSH_RECORD);
    const getGitPushRecord = vi.fn().mockResolvedValue(mismatchingRecord);
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await user.click(await screen.findByRole('button', { name: 'Execute push' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Recovery required', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(refetchedRecord.remoteSummary, { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText(mismatchingRecord.remoteSummary, { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    expect(getGitPushRecord.mock.calls).toEqual([['ws1', PUSH_RECORD.id]]);
    expect(listGitPushRecords.mock.calls).toEqual([['ws1'], ['ws1'], ['ws1']]);
  });

  it.each([
    ['matching terminal tuple', PUSH_RECORD, false],
    ['no terminal record', null, true],
    ['workspace mismatch', { ...PUSH_RECORD, workspaceId: 'ws_other' }, true],
    ['repository mismatch', { ...PUSH_RECORD, repositoryResourceId: 'repo_other' }, true],
    ['approval item mismatch', { ...PUSH_RECORD, approvalRowId: 'it_other' }, true],
    ['policy decision mismatch', { ...PUSH_RECORD, policyDecisionId: 'pd_other' }, true],
    ['source ref mismatch', { ...PUSH_RECORD, sourceRef: 'refs/heads/other' }, true],
    ['target branch mismatch', { ...PUSH_RECORD, targetBranch: 'release' }, true],
    [
      'commit cardinality mismatch',
      { ...PUSH_RECORD, commitIds: [PUSH_TARGET.commitIds[0]] },
      true,
    ],
    [
      'ordered commit mismatch',
      { ...PUSH_RECORD, commitIds: [...PUSH_TARGET.commitIds].reverse() },
      true,
    ],
  ] as const)('requires the exact consumed-record tuple for %s', async (_case, terminalRecord, executeVisible) => {
    const user = userEvent.setup();
    const listGitPushRecords = vi
      .fn()
      .mockResolvedValue({ items: terminalRecord ? [terminalRecord] : [] });
    let authoritativeApproval: typeof PENDING_PUSH_APPROVAL | typeof PUSH_APPROVAL =
      PENDING_PUSH_APPROVAL;
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn();
    const getGitPushRecord = vi.fn();
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    authoritativeApproval = PUSH_APPROVAL;
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Approved', { exact: true })).toBeInTheDocument();
    if (executeVisible) {
      expect(await screen.findByRole('button', { name: 'Execute push' })).toBeEnabled();
    } else {
      expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    }
    expect(executeGitPush).not.toHaveBeenCalled();
    expect(getGitPushRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', 'Denied'],
    ['expired', 'Expired'],
    ['superseded', 'Superseded'],
    ['withdrawn', 'Withdrawn'],
  ] as const)('shows the fixed %s terminal state without execute', async (status, label) => {
    const user = userEvent.setup();
    let authoritativeApproval: unknown = PENDING_PUSH_APPROVAL;
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [] });
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({
        repositories: { executeGitPush, listGitPushRecords, requestGitPushApproval },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;

    authoritativeApproval = {
      ...PUSH_APPROVAL,
      approval: { ...PUSH_APPROVAL.approval, status },
    };
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls[1]).toEqual([
      'ws1',
      REPOSITORY_RESOURCE.resourceId,
      { requestId: approvalRequestId, ...PUSH_TARGET },
    ]);
    expect(await screen.findByText(label, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();
  });

  it.each([
    { workspaceId: 'ws_other' },
    { threadId: 'th_other' },
    { turnId: 'tu_other' },
  ] as const)('does not expose execute for mismatched granted authority %#', async (mismatch) => {
    const user = userEvent.setup();
    let authoritativeApproval: unknown = PENDING_PUSH_APPROVAL;
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({ repositories: { executeGitPush, requestGitPushApproval } })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    authoritativeApproval = {
      ...PUSH_APPROVAL,
      approval: { ...PUSH_APPROVAL.approval, ...mismatch },
    };
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls[1]).toEqual([
      'ws1',
      REPOSITORY_RESOURCE.resourceId,
      { requestId: approvalRequestId, ...PUSH_TARGET },
    ]);
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();
  });

  it.each([
    ['idempotency_key_conflict', 'Request conflict'],
    ['recovery_required', 'Recovery required'],
  ] as const)('retains repository state for typed approval %s without replaying the request', async (code, label) => {
    const user = userEvent.setup();
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [PUSH_RECORD] });
    const requestGitPushApproval = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'Approval command rejected.', { code }));
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({
        repositories: { executeGitPush, listGitPushRecords, requestGitPushApproval },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(label, { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(1));
    const requestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId, ...PUSH_TARGET }],
    ]);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();

    const readsBeforeRetry = listGitPushRecords.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(readsBeforeRetry + 1));
    expect(requestGitPushApproval).toHaveBeenCalledTimes(1);
    expect(executeGitPush).not.toHaveBeenCalled();
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
  });

  it.each([
    ['idempotency_key_conflict', 'Request conflict'],
    ['recovery_required', 'Recovery required'],
  ] as const)('retains repository state for typed execute %s without replaying either mutation', async (code, label) => {
    const user = userEvent.setup();
    let authoritativeApproval: typeof PENDING_PUSH_APPROVAL | typeof PUSH_APPROVAL =
      PENDING_PUSH_APPROVAL;
    const priorPushRecord = {
      ...PUSH_RECORD,
      approvalRowId: 'it_previous_push_approval',
    };
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [priorPushRecord] });
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'Push command rejected.', { code }));
    renderApp(
      '/repositories',
      makeClient({
        repositories: { executeGitPush, listGitPushRecords, requestGitPushApproval },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    authoritativeApproval = PUSH_APPROVAL;
    await user.click(screen.getByRole('button', { name: 'Check approval' }));
    await user.click(await screen.findByRole('button', { name: 'Execute push' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(label, { exact: true })).toBeInTheDocument();
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(executeGitPush).toHaveBeenCalledTimes(1));
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    const readsBeforeRetry = listGitPushRecords.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(readsBeforeRetry + 1));
    expect(requestGitPushApproval).toHaveBeenCalledTimes(2);
    expect(executeGitPush).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
  });

  it('sets the default repository from the bounded form and refetches the projection', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [REPOSITORY_RESOURCE],
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_RESOURCE,
      })
      .mockResolvedValueOnce({
        items: [UPDATED_REPOSITORY_RESOURCE],
        defaultResourceId: UPDATED_REPOSITORY_RESOURCE.resourceId,
        defaultResource: UPDATED_REPOSITORY_RESOURCE,
      });
    const setDefault = vi.fn().mockResolvedValue({ repository: UPDATED_REPOSITORY_RESOURCE });
    renderApp('/repositories', makeClient({ repositories: { list, setDefault } }));

    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    await enterDefaultRepository(user);
    await user.click(screen.getByRole('button', { name: /set default/i }));

    await waitFor(() =>
      expect(setDefault).toHaveBeenCalledWith('ws1', { ...DEFAULT_REPOSITORY_INPUT })
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(UPDATED_REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(setDefault).toHaveBeenCalledTimes(1);
  });

  it('preserves the current repository list when setDefault fails and keeps retry available', async () => {
    const user = userEvent.setup();
    const setDefault = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'Repository command rejected.', { code: 'conflict' })
      );
    renderApp('/repositories', makeClient({ repositories: { setDefault } }));

    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    await enterDefaultRepository(user);
    await user.click(screen.getByRole('button', { name: /set default/i }));

    await waitFor(() => expect(setDefault).toHaveBeenCalledTimes(1));
    expect(screen.getByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't set|couldn't update|try again/i);
    expect(alert).not.toHaveTextContent('Repository command rejected.');
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('keeps repository records visible but disables push mutations while disconnected', async () => {
    const client = makeClient({ core: { meta: vi.fn().mockRejectedValue(new Error('down')) } });
    renderApp('/repositories', client);

    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(await screen.findByText('Status may be stale', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request approval' })).toBeDisabled();
    expect(client.repositories.requestGitPushApproval).not.toHaveBeenCalled();
    expect(client.repositories.executeGitPush).not.toHaveBeenCalled();
  });

  it('does not expose a set-default repository action on Quick Chat', async () => {
    const client = makeClient({
      core: { listWorkspaces: vi.fn().mockResolvedValue({ items: [QUICK_CHAT_WORKSPACE] }) },
    });
    renderApp('/repositories', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Repositories' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set default/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Display name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Local path' })).not.toBeInTheDocument();
    expect(screen.queryByText('Default repository')).not.toBeInTheDocument();
    expect(client.repositories.setDefault).not.toHaveBeenCalled();
  });

  it('clears or scopes a failed default-repository retry after Workspace switch without retargeting', async () => {
    const user = userEvent.setup();
    const setDefault = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'Repository command rejected.', { code: 'conflict' })
      );
    const workspaceBResources = createDeferred<{
      items: [];
      defaultResourceId: null;
      defaultResource: null;
    }>();
    const list = vi.fn().mockImplementation((workspaceId: string) =>
      workspaceId === WORKSPACE_B.id
        ? workspaceBResources.promise
        : Promise.resolve({
            items: [REPOSITORY_RESOURCE],
            defaultResourceId: REPOSITORY_RESOURCE.resourceId,
            defaultResource: REPOSITORY_RESOURCE,
          })
    );
    const diagnostics = vi.fn().mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === WORKSPACE_B.id
          ? {
              workspaceId: WORKSPACE_B.id,
              defaultResourceId: null,
              defaultResource: null,
              resources: [],
            }
          : {
              workspaceId: WORKSPACE_A.id,
              defaultResourceId: REPOSITORY_RESOURCE.resourceId,
              defaultResource: REPOSITORY_DIAGNOSTIC,
              resources: [REPOSITORY_DIAGNOSTIC],
            }
      )
    );
    const listGitPushRecords = vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        Promise.resolve(workspaceId === WORKSPACE_B.id ? { items: [] } : { items: [PUSH_RECORD] })
      );
    renderApp(
      '/repositories',
      makeClient({
        core: {
          listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE_A, WORKSPACE_B] }),
        },
        repositories: { diagnostics, list, listGitPushRecords, setDefault },
      })
    );

    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    await enterDefaultRepository(user);
    await user.click(screen.getByRole('button', { name: /set default/i }));
    await waitFor(() =>
      expect(setDefault).toHaveBeenCalledWith(WORKSPACE_A.id, { ...DEFAULT_REPOSITORY_INPUT })
    );
    expect(setDefault).toHaveBeenCalledTimes(1);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't set|couldn't update/i);
    expect(alert).not.toHaveTextContent('Repository command rejected.');

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(WORKSPACE_B.id);
      expect(diagnostics).toHaveBeenCalledWith(WORKSPACE_B.id);
      expect(listGitPushRecords).toHaveBeenCalledWith(WORKSPACE_B.id);
    });
    await waitFor(() =>
      expect(screen.queryByText(REPOSITORY_RESOURCE.displayName)).not.toBeInTheDocument()
    );
    workspaceBResources.resolve({ items: [], defaultResourceId: null, defaultResource: null });

    const header = (await screen.findByRole('heading', { level: 1, name: 'Repositories' })).closest(
      'header'
    ) as HTMLElement;
    expect(within(header).getByText(WORKSPACE_B.name, { exact: true })).toBeInTheDocument();
    expect(await screen.findByText('No linked repositories', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No repository diagnostics', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No push records', { exact: true })).toBeInTheDocument();

    await proveWriteDoesNotRetarget(user, setDefault, WORKSPACE_A.id);
    expect(setDefault.mock.calls.every((call) => call[0] === WORKSPACE_A.id)).toBe(true);
    expect(setDefault).not.toHaveBeenCalledWith(WORKSPACE_B.id, expect.anything());
  });

  it('keeps a failed default-repository retry connection-guarded', async () => {
    const user = userEvent.setup();
    const meta = vi.fn().mockResolvedValue({});
    const setDefault = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'Repository command rejected.', { code: 'conflict' })
      );
    const queryClient = renderApp(
      '/repositories',
      makeClient({
        core: { meta },
        repositories: { setDefault },
      })
    );

    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    await enterDefaultRepository(user);
    await user.click(screen.getByRole('button', { name: /set default/i }));
    await waitFor(() =>
      expect(setDefault).toHaveBeenCalledWith(WORKSPACE_A.id, { ...DEFAULT_REPOSITORY_INPUT })
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't set|couldn't update/i);
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeEnabled();

    meta.mockRejectedValue(new Error('down'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['core', 'meta'] });
    });
    await waitFor(() =>
      expect(screen.getByText('Status may be stale', { exact: true })).toBeInTheDocument()
    );
    const retry = within(alert).getByRole('button', { name: /try again/i });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(setDefault.mock.calls).toEqual([[WORKSPACE_A.id, { ...DEFAULT_REPOSITORY_INPUT }]]);
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
      core: {
        meta,
        listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
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
      core: { listWorkspaces: vi.fn().mockResolvedValue({ items: [] }) },
    });
    renderApp('/first-run', client);
    expect(await screen.findByText(/Your agent team/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create workspace/i })).toHaveAttribute(
      'href',
      '/workspaces/new'
    );
  });

  it('offers a calm ready path when a workspace already exists', async () => {
    renderApp('/first-run', makeClient());
    expect(await screen.findByText(/You're set/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Overview/i })).toHaveAttribute('href', '/');
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
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: TIMESTAMP_NEW,
      updatedAt: TIMESTAMP_NEW,
    });
    const client = makeClient({ core: { createWorkspace } });
    renderApp('/workspaces/new', client);
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Launch prep');
    await user.click(screen.getByRole('button', { name: /Create workspace/i }));
    await waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch prep' }))
    );
  });
});
