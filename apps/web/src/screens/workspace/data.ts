import {
  ApiCallError,
  type CoreClient,
  createRequestId,
  type KnowledgeEntry,
  type WorkspaceRecord,
} from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { chatThreadPath, useCurrentWorkspaceId, useWorkspaces } from '../chat/data';

/**
 * Workspace / Overview data hooks (WP-6). Action Center, Agents, Knowledge, and
 * first-run readiness all flow through `@openkit/core-client` under TanStack
 * Query — server state is never copied into Zustand.
 */
export const workspaceKeys = {
  attention: (workspaceId: string) => ['attention', workspaceId] as const,
  agents: ['agents'] as const,
  knowledge: (workspaceId: string) => ['knowledge', workspaceId] as const,
  knowledgeSources: (workspaceId: string) => ['knowledge-sources', workspaceId] as const,
  knowledgeObservations: (workspaceId: string) => ['knowledge-observations', workspaceId] as const,
  knowledgeClaims: (workspaceId: string) => ['knowledge-claims', workspaceId] as const,
  knowledgeConflicts: (workspaceId: string) => ['knowledge-conflicts', workspaceId] as const,
  knowledgeIndexes: (workspaceId: string) => ['knowledge-indexes', workspaceId] as const,
  dashboard: (workspaceId: string) => ['dashboard', workspaceId] as const,
  repositories: (workspaceId: string) => ['repositories', workspaceId] as const,
};

/** Re-export workspace selection for Overview / Agents / Knowledge / First-run. */
export { chatThreadPath, useCurrentWorkspaceId, useWorkspaces };

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
/** Exact replayable Knowledge entry create bound to one Workspace. */
export type CreateKnowledgeCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['core']['createKnowledge']>[1];
};
/** Exact replayable Knowledge entry update bound to one Workspace. */
export type UpdateKnowledgeCommand = {
  workspaceId: string;
  knowledgeEntryId: string;
  input: Parameters<CoreClient['core']['updateKnowledge']>[2];
};
/** Exact replayable Knowledge entry delete bound to one Workspace. */
export type DeleteKnowledgeCommand = {
  workspaceId: string;
  knowledgeEntryId: string;
  input: Parameters<CoreClient['core']['deleteKnowledge']>[2];
};
/** Exact replayable Knowledge Source registration bound to one Workspace. */
export type RegisterKnowledgeSourceCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['registerKnowledgeSource']>[1];
};
/** Exact Knowledge Source read bound to one Workspace identity. */
export type ReadKnowledgeSourceCommand = {
  workspaceId: string;
  sourceId: string;
};
/** Exact replayable Knowledge Observation append bound to one Workspace. */
export type RecordKnowledgeObservationCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['recordKnowledgeObservation']>[1];
};
/** Exact replayable Knowledge Claim append bound to one Workspace. */
export type RecordKnowledgeClaimCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['recordKnowledgeClaim']>[1];
};
/** Exact replayable Knowledge Conflict append bound to one Workspace. */
export type RecordKnowledgeConflictCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['recordKnowledgeConflict']>[1];
};
/** Exact replayable Knowledge Conflict resolution bound to one Workspace. */
export type ResolveKnowledgeConflictCommand = {
  workspaceId: string;
  conflictId: string;
  input: Parameters<CoreClient['app']['resolveKnowledgeConflict']>[2];
};
/** Workspace-bound Knowledge retrieval request. */
export type RetrieveKnowledgeCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['retrieveKnowledge']>[1];
};
/** Workspace-bound Knowledge context preparation request. */
export type PrepareKnowledgeContextCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['prepareKnowledgeContext']>[1];
};
/** Workspace-bound Knowledge Manager answer request. */
export type AnswerKnowledgeManagerCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['answerKnowledgeManager']>[1];
};
/** Workspace-bound Knowledge repair suggestion request. */
export type SuggestKnowledgeRepairsCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['suggestKnowledgeRepairs']>[1];
};
/** Workspace-bound Knowledge health-check request. */
export type CheckKnowledgeHealthCommand = {
  workspaceId: string;
  input: Parameters<CoreClient['app']['checkKnowledgeHealth']>[1];
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

/**
 * Read one agent catalog entry once View details is open.
 *
 * @param agentId Exact catalog id from the current list row.
 * @param enabled Whether the details disclosure is open.
 * @returns Lazy TanStack query for `client.agents.get`.
 */
export function useAgent(agentId: string, enabled: boolean) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [...workspaceKeys.agents, agentId],
    queryFn: () => client.agents.get(agentId),
    enabled,
    retry: false,
  });
}

/** @returns Mutation that refreshes agent health for one selected Workspace. */
export function useRefreshAgentHealth() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => client.agents.refreshHealth(workspaceId),
    retry: false,
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.agents, exact: true });
      await Promise.all(
        response.items.map((item) =>
          queryClient.invalidateQueries({
            queryKey: [...workspaceKeys.agents, item.agentId],
            exact: true,
          })
        )
      );
    },
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

/**
 * Maps a Knowledge API failure to public copy with no private server text.
 *
 * @param error Unknown query or mutation failure.
 * @param fallback Product copy for ordinary failures.
 * @returns Access-denied or the supplied fallback copy.
 */
export function knowledgeActionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiCallError && error.code === 'workspace_access_denied'
    ? 'Access denied.'
    : fallback;
}

const knowledgeListQuery = {
  retry: false,
  refetchOnMount: 'always' as const,
} as const;

/** List workspace Knowledge Source identities. */
export function useKnowledgeSources(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledgeSources(workspaceId ?? ''),
    queryFn: async () => (await client.app.listKnowledgeSources(workspaceId as string)).items,
    enabled: Boolean(workspaceId),
    ...knowledgeListQuery,
  });
}

/** List workspace Knowledge Store observations. */
export function useKnowledgeObservations(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledgeObservations(workspaceId ?? ''),
    queryFn: async () => (await client.app.listKnowledgeObservations(workspaceId as string)).items,
    enabled: Boolean(workspaceId),
    ...knowledgeListQuery,
  });
}

/** List workspace Knowledge Store claims. */
export function useKnowledgeClaims(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledgeClaims(workspaceId ?? ''),
    queryFn: async () => (await client.app.listKnowledgeClaims(workspaceId as string)).items,
    enabled: Boolean(workspaceId),
    ...knowledgeListQuery,
  });
}

/** List workspace Knowledge Store conflicts. */
export function useKnowledgeConflicts(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledgeConflicts(workspaceId ?? ''),
    queryFn: async () => (await client.app.listKnowledgeConflicts(workspaceId as string)).items,
    enabled: Boolean(workspaceId),
    ...knowledgeListQuery,
  });
}

/** Read fresh derived Knowledge Store indexes. */
export function useKnowledgeIndexes(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: workspaceKeys.knowledgeIndexes(workspaceId ?? ''),
    queryFn: () => client.app.readKnowledgeIndexes(workspaceId as string),
    enabled: Boolean(workspaceId),
    ...knowledgeListQuery,
  });
}

/** @returns Mutation that registers one Knowledge Source without claiming list settlement. */
export function useRegisterKnowledgeSource() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: RegisterKnowledgeSourceCommand) =>
      client.app.registerKnowledgeSource(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that reads one Knowledge Source identity. */
export function useReadKnowledgeSource() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: ReadKnowledgeSourceCommand) =>
      client.app.readKnowledgeSource(command.workspaceId, command.sourceId),
    retry: false,
  });
}

/** @returns Mutation that appends one Knowledge Observation without claiming list settlement. */
export function useRecordKnowledgeObservation() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: RecordKnowledgeObservationCommand) =>
      client.app.recordKnowledgeObservation(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that appends one Knowledge Claim without claiming list settlement. */
export function useRecordKnowledgeClaim() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: RecordKnowledgeClaimCommand) =>
      client.app.recordKnowledgeClaim(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that appends one Knowledge Conflict without claiming list settlement. */
export function useRecordKnowledgeConflict() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: RecordKnowledgeConflictCommand) =>
      client.app.recordKnowledgeConflict(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that resolves one Knowledge Conflict without claiming list settlement. */
export function useResolveKnowledgeConflict() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: ResolveKnowledgeConflictCommand) =>
      client.app.resolveKnowledgeConflict(command.workspaceId, command.conflictId, command.input),
    retry: false,
  });
}

/** @returns Mutation that retrieves ranked Knowledge Store candidates. */
export function useRetrieveKnowledge() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: RetrieveKnowledgeCommand) =>
      client.app.retrieveKnowledge(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that prepares source-traceable context material. */
export function usePrepareKnowledgeContext() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: PrepareKnowledgeContextCommand) =>
      client.app.prepareKnowledgeContext(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that answers one Knowledge Manager question. */
export function useAnswerKnowledgeManager() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: AnswerKnowledgeManagerCommand) =>
      client.app.answerKnowledgeManager(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that suggests review-required knowledge repairs. */
export function useSuggestKnowledgeRepairs() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: SuggestKnowledgeRepairsCommand) =>
      client.app.suggestKnowledgeRepairs(command.workspaceId, command.input),
    retry: false,
  });
}

/** @returns Mutation that inspects Knowledge Store health. */
export function useCheckKnowledgeHealth() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: CheckKnowledgeHealthCommand) =>
      client.app.checkKnowledgeHealth(command.workspaceId, command.input),
    retry: false,
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

/** @returns Mutation that sets the selected Workspace default repository. */
export function useSetDefaultRepository() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: {
      workspaceId: string;
      input: Parameters<CoreClient['repositories']['setDefault']>[1];
    }) => client.repositories.setDefault(command.workspaceId, command.input),
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

/** @returns Mutation that creates one Knowledge entry from a Workspace-bound command. */
export function useCreateKnowledge() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: CreateKnowledgeCommand) =>
      client.core.createKnowledge(command.workspaceId, command.input),
    retry: false,
    onSuccess: (_data, command) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.knowledge(command.workspaceId),
      });
    },
  });
}

/** @returns Mutation that updates one Knowledge entry from a Workspace-bound command. */
export function useUpdateKnowledge() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: UpdateKnowledgeCommand) =>
      client.core.updateKnowledge(command.workspaceId, command.knowledgeEntryId, command.input),
    retry: false,
  });
}

/** @returns Mutation that deletes one Knowledge entry from a Workspace-bound command. */
export function useDeleteKnowledge() {
  const client = useCoreClient();
  return useMutation({
    mutationFn: (command: DeleteKnowledgeCommand) =>
      client.core.deleteKnowledge(command.workspaceId, command.knowledgeEntryId, command.input),
    retry: false,
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
    return chatThreadPath(row.workspaceId, row.threadId);
  }
  if ('threadId' in row.source && typeof row.source.threadId === 'string') {
    return chatThreadPath(row.workspaceId, row.source.threadId);
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
