import type { CoreClient, KnowledgeEntry, WorkspaceRecord } from '@openkit/core-client';
import { createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId, useWorkspaces } from '../chat/data';

/**
 * Workspace / Overview data hooks (WP-6). Action Center, Agents, Knowledge, and
 * first-run readiness all flow through `@openkit/core-client` under TanStack
 * Query — server state is never copied into Zustand.
 */
export const workspaceKeys = {
  attention: (workspaceId: string) => ['attention', workspaceId] as const,
  agents: ['agents'] as const,
  knowledge: (workspaceId: string) => ['knowledge', workspaceId] as const,
  knowledgeStore: (workspaceId: string) => ['knowledge-store', workspaceId] as const,
  dashboard: (workspaceId: string) => ['dashboard', workspaceId] as const,
  repositories: (workspaceId: string) => ['repositories', workspaceId] as const,
};

/** Re-export workspace selection for Overview / Agents / Knowledge / First-run. */
export { useCurrentWorkspaceId, useWorkspaces };

/** Human attention row from `actionCenter.listHumanAttention`. */
export type AttentionRow = Awaited<
  ReturnType<CoreClient['actionCenter']['listHumanAttention']>
>['items'][number];
/** Agent catalog entry from `agents.list`. */
export type AgentEntry = Awaited<ReturnType<CoreClient['agents']['list']>>['items'][number];
/** Knowledge entry from `core.listKnowledge`. */
export type KnowledgeItem = KnowledgeEntry;
/** Bounded Knowledge Store projection returned by the three live list reads. */
export type KnowledgeStoreProjection = {
  sources: Awaited<ReturnType<CoreClient['app']['listKnowledgeSources']>>['items'];
  observations: Awaited<ReturnType<CoreClient['app']['listKnowledgeObservations']>>['items'];
  claims: Awaited<ReturnType<CoreClient['app']['listKnowledgeClaims']>>['items'];
};
/** Decision accepted by the existing Knowledge Proposal owner. */
export type KnowledgeProposalDecision = Parameters<
  CoreClient['app']['submitKnowledgeProposalDecision']
>[2]['decision'];
/** Exact Knowledge attention owner and decision submitted by the Web projection. */
export type KnowledgeProposalDecisionInput = {
  source: Extract<AttentionRow['source'], { type: 'knowledge' }>;
  decision: KnowledgeProposalDecision;
};
/** Selected-Workspace repository resources, diagnostics, and durable push records. */
export type RepositoryProjection = {
  resources: Awaited<ReturnType<CoreClient['repositories']['list']>>;
  diagnostics: Awaited<ReturnType<CoreClient['repositories']['diagnostics']>>;
  pushRecords: Awaited<ReturnType<CoreClient['repositories']['listGitPushRecords']>>['items'];
};
/** Exact replayable request for one repository push approval. */
export type GitPushApprovalCommand = {
  workspaceId: string;
  resourceId: string;
  input: Parameters<CoreClient['repositories']['requestGitPushApproval']>[2];
};
/** Versioned execution request for one granted repository push approval. */
export type GitPushExecutionCommand = {
  workspaceId: string;
  resourceId: string;
  input: Parameters<CoreClient['repositories']['executeGitPush']>[2];
};

/** Sort Needs-you rows longest-waiting first (oldest `createdAt` first). */
export function sortByWaitingTime(rows: AttentionRow[]): AttentionRow[] {
  return [...rows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/** List unified Action Center attention rows for the active workspace. */
export function useHumanAttention(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.attention(workspaceId ?? ''),
    queryFn: async () =>
      sortByWaitingTime(
        (await client.actionCenter.listHumanAttention(workspaceId as string)).items
      ),
    enabled: Boolean(workspaceId),
  });
}

/** Optional ambient dashboard counts / in-motion cards for Overview. */
export function useWorkspaceDashboard(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.dashboard(workspaceId ?? ''),
    queryFn: () => client.app.getWorkspaceDashboard(workspaceId as string),
    enabled: Boolean(workspaceId),
  });
}

/** List product-visible agents. */
export function useAgents() {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.agents,
    queryFn: async () => (await client.agents.list()).items,
  });
}

/** List workspace knowledge entries. */
export function useKnowledge(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledge(workspaceId ?? ''),
    queryFn: async () => (await client.core.listKnowledge(workspaceId as string)).items,
    enabled: Boolean(workspaceId),
  });
}

/** Read the bounded Source, Observation, and Claim projection as one query. */
export function useKnowledgeStore(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledgeStore(workspaceId ?? ''),
    queryFn: async (): Promise<KnowledgeStoreProjection> => {
      const [sources, observations, claims] = await Promise.all([
        client.app.listKnowledgeSources(workspaceId as string),
        client.app.listKnowledgeObservations(workspaceId as string),
        client.app.listKnowledgeClaims(workspaceId as string),
      ]);
      return {
        sources: sources.items,
        observations: observations.items,
        claims: claims.items,
      };
    },
    enabled: Boolean(workspaceId),
  });
}

/**
 * Read repository resources, diagnostics, and push records for one validated Workspace.
 *
 * @param workspaceId Validated selected Workspace, or null before discovery settles.
 * @returns One TanStack query over the three existing repository reads.
 */
export function useRepositoryProjection(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.repositories(workspaceId ?? ''),
    queryFn: async (): Promise<RepositoryProjection> => {
      const [resources, diagnostics, pushRecords] = await Promise.all([
        client.repositories.list(workspaceId as string),
        client.repositories.diagnostics(workspaceId as string),
        client.repositories.listGitPushRecords(workspaceId as string),
      ]);
      return { resources, diagnostics, pushRecords: pushRecords.items };
    },
    enabled: Boolean(workspaceId),
  });
}

/** @returns Mutation for requesting or exactly replaying one repository push approval command. */
export function useRequestGitPushApproval() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: GitPushApprovalCommand) =>
      client.repositories.requestGitPushApproval(
        command.workspaceId,
        command.resourceId,
        command.input
      ),
    retry: false,
  });
}

/** @returns Mutation that executes one granted push and reads its exact terminal record. */
export function useExecuteGitPush() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: async (command: GitPushExecutionCommand) => {
      const record = await client.repositories.executeGitPush(
        command.workspaceId,
        command.resourceId,
        command.input
      );
      return client.repositories.getGitPushRecord(command.workspaceId, record.id);
    },
    retry: false,
  });
}

/** Submit one Knowledge Proposal decision without claiming read-model settlement. */
export function useSubmitKnowledgeProposalDecision() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: KnowledgeProposalDecisionInput) =>
      client.app.submitKnowledgeProposalDecision(
        input.source.workspaceId,
        input.source.knowledgeProposalId,
        { decision: input.decision, requestId: createRequestId() }
      ),
    retry: false,
  });
}

/** Create a knowledge entry in the active workspace. */
export function useCreateKnowledge(workspaceId: string | null) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; content: string; kind?: KnowledgeEntry['kind'] }) =>
      client.core.createKnowledge(workspaceId as string, {
        kind: input.kind ?? 'preference',
        title: input.title,
        content: input.content,
        requestId: createRequestId(),
      }),
    onSuccess: () => {
      if (workspaceId) {
        void queryClient.invalidateQueries({ queryKey: workspaceKeys.knowledge(workspaceId) });
      }
    },
  });
}

/** Update one knowledge entry without claiming authoritative read-model settlement. */
export function useUpdateKnowledge(workspaceId: string | null) {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (input: { knowledgeEntryId: string; title?: string; content?: string }) =>
      client.core.updateKnowledge(workspaceId as string, input.knowledgeEntryId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.content === undefined ? {} : { content: input.content }),
        requestId: createRequestId(),
      }),
  });
}

/** Delete one knowledge entry without claiming authoritative read-model settlement. */
export function useDeleteKnowledge(workspaceId: string | null) {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (knowledgeEntryId: string) =>
      client.core.deleteKnowledge(workspaceId as string, knowledgeEntryId, {
        requestId: createRequestId(),
      }),
  });
}

/** Create a workspace from the first-run / new-workspace form. */
export function useCreateWorkspace() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string): Promise<WorkspaceRecord> =>
      client.core.createWorkspace({ name, requestId: createRequestId() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

/**
 * Decide an Action Center row inline when the row carries enough ids.
 * Approvals map to `core.respondApproval`; other kinds without a safe mutation
 * path are left for the caller to open in-context.
 */
export function useDecideAttention(workspaceId: string | null) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { row: AttentionRow; action: AttentionRow['actions'][number] }) => {
      const { row, action } = args;
      if (
        (action.kind === 'grant_approval' || action.kind === 'deny_approval') &&
        row.source.type === 'approval' &&
        row.threadId &&
        row.turnId
      ) {
        return client.core.respondApproval(row.source.approvalRequestId, {
          workspaceId: row.source.workspaceId,
          threadId: row.source.threadId,
          turnId: row.source.turnId,
          decision: action.kind === 'grant_approval' ? 'granted' : 'denied',
        });
      }
      if (
        (action.kind === 'accept_review' || action.kind === 'request_refinement') &&
        row.source.type === 'artifact_review' &&
        row.artifactId &&
        row.artifactVersion
      ) {
        return client.app.submitArtifactReviewDecision(
          row.source.workspaceId,
          row.source.artifactId,
          row.source.artifactVersion,
          {
            decision: action.kind === 'accept_review' ? 'accepted' : 'rejected',
          }
        );
      }
      throw new Error(`Inline decision is not available for action ${action.kind}`);
    },
    onSuccess: () => {
      if (workspaceId) {
        void queryClient.invalidateQueries({ queryKey: workspaceKeys.attention(workspaceId) });
      }
    },
  });
}

/** Whether an Action Center action can be decided inline from the row payload. */
export function canDecideInline(
  row: AttentionRow,
  action: AttentionRow['actions'][number]
): boolean {
  if (
    (action.kind === 'grant_approval' || action.kind === 'deny_approval') &&
    row.source.type === 'approval' &&
    row.threadId &&
    row.turnId
  ) {
    return true;
  }
  if (
    (action.kind === 'accept_review' || action.kind === 'request_refinement') &&
    row.source.type === 'artifact_review' &&
    row.artifactId &&
    row.artifactVersion
  ) {
    return true;
  }
  return false;
}

/** Deep-link into the owning thread / goal / artifact for a Needs-you row. */
export function openHrefForRow(row: AttentionRow): string | null {
  if (row.source.type === 'artifact_review') {
    return `/goals/${row.source.threadId}/artifacts/${row.source.artifactId}`;
  }
  if (
    row.source.type === 'goal' ||
    row.source.type === 'goal_review' ||
    row.kind === 'artifact_review'
  ) {
    const threadId = row.threadId ?? ('threadId' in row.source ? row.source.threadId : null);
    return threadId ? `/goals/${threadId}` : null;
  }
  if (row.threadId) {
    return `/chat/${row.threadId}`;
  }
  if ('threadId' in row.source && typeof row.source.threadId === 'string') {
    return `/chat/${row.source.threadId}`;
  }
  return null;
}

/** Map agent health into the plain-language readiness vocabulary (DESIGN.md §13). */
export function readinessLabel(agent: AgentEntry): {
  label: string;
  tone: 'positive' | 'informative' | 'notice' | 'negative' | 'neutral';
} {
  if (agent.status === 'disabled') {
    return { label: 'Resting', tone: 'neutral' };
  }
  switch (agent.health.status) {
    case 'ready':
      return { label: 'Ready', tone: 'positive' };
    case 'running':
    case 'starting':
      return { label: 'Working', tone: 'informative' };
    case 'offline':
    case 'failed':
      return { label: 'Needs attention', tone: 'notice' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

/** Short lane copy from the agent kind enum. */
export function agentLane(kind: AgentEntry['kind']): string {
  switch (kind) {
    case 'researcher':
      return 'Research — finds and checks information';
    case 'coder':
      return 'Coding — implements and verifies changes';
    case 'planner':
      return 'Planning — structures multi-step work';
    case 'reviewer':
      return 'Review — checks work before it lands';
    default:
      return 'Internal worker';
  }
}

/** Initials for the agent avatar. */
export function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}

/** Cycle worker hues so roster cards stay visually distinct. */
export function agentHue(index: number): 'scout' | 'quill' | 'ledger' | 'pixel' {
  const hues = ['scout', 'quill', 'ledger', 'pixel'] as const;
  return hues[index % hues.length]!;
}

/** Human-readable waiting label from an ISO timestamp. */
export function waitingLabel(createdAt: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(createdAt).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Waiting just now';
  if (minutes < 60) return `Waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Waiting ${hours}h`;
  const days = Math.floor(hours / 24);
  return `Waiting ${days}d`;
}
