import type { CoreClient } from '@openkit/core-client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { Button, DiffView, ErrorBanner, ListRow, Skeleton } from '../../primitives';
import type { AttentionRow, KnowledgeProposalDecision, KnowledgeProposalDecisionInput } from './data';

type Source = KnowledgeProposalDecisionInput['source'];
type Preview = Awaited<ReturnType<CoreClient['operations']['knowledge.proposal.read']>>;

/** Only a preview of the displayed candidate can enable its acceptance. */
function assertIdentity(preview: Preview, source: Source): Preview {
  if (preview.proposalId !== source.knowledgeProposalId || preview.proposalDigest !== source.proposalDigest ||
    preview.baseRevision !== source.baseRevision || preview.candidateRevision !== source.candidateRevision)
    throw new Error('The proposal changed. Refresh the Knowledge page.');
  return preview;
}

/** Maps only the current row's supported native decision actions. */
function decisionFor(action: AttentionRow['actions'][number]): KnowledgeProposalDecision | null {
  if (action.method !== 'POST') return null;
  switch (action.kind) {
    case 'accept_knowledge': return 'accepted';
    case 'reject_knowledge': return 'rejected';
    case 'defer': return 'deferred';
    default: return null;
  }
}

/** Displays exact saved candidate changes before accepting the identity shown to the user. */
export function KnowledgeProposalRow({ row, blocked, onDecide }: {
  row: AttentionRow;
  blocked: boolean;
  onDecide: (input: KnowledgeProposalDecisionInput) => void;
}) {
  const client = useCoreClient();
  const [open, setOpen] = useState(false);
  const [inspected, setInspected] = useState<string[]>([]);
  const source = row.source as Source;
  const key = ['knowledge-proposal-preview', source.workspaceId, source.knowledgeProposalId,
    source.proposalDigest, source.baseRevision, source.candidateRevision];
  const preview = useQuery({
    queryKey: key,
    queryFn: async () => assertIdentity(await client.operations['knowledge.proposal.read']({
      workspaceId: source.workspaceId, proposalId: source.knowledgeProposalId,
    }), source),
    enabled: open, retry: false, refetchOnMount: 'always',
  });
  const displayed = preview.isSuccess && !preview.isFetching ? preview.data : null;
  useEffect(() => {
    if (!displayed) setInspected((current) => current.length ? [] : current);
  }, [displayed]);
  const complete = Boolean(displayed?.paths.length && displayed.paths.every((path) => inspected.includes(path)));
  return <div className="flex min-w-0 flex-col gap-3 py-2">
    <ListRow>
      <div className="min-w-0 flex-1 py-1">
        <p className="text-sm font-bold text-fg-strong">{row.title}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{row.summary}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        <Button size="sm" variant="outline" isDisabled={blocked} onPress={() => setOpen((value) => !value)}>
          {open ? 'Hide changes' : 'Inspect changes'}
        </Button>
        {row.actions.map((action) => {
          const decision = decisionFor(action);
          return decision ? <div key={action.kind} className="flex flex-col items-start gap-1">
            <Button size="sm" variant="outline"
              isDisabled={blocked || action.disabled === true || (decision === 'accepted' && !complete)}
              onPress={() => onDecide({ source, decision })}>{action.label}</Button>
            {action.reason ? <p className="max-w-64 text-xs text-fg-muted">{action.reason}</p> : null}
          </div> : null;
        })}
      </div>
    </ListRow>
    {open ? <div className="flex min-w-0 flex-col gap-3">
      {preview.isPending || preview.isFetching ? <Skeleton lines={2} /> : null}
      {preview.isError ? <ErrorBanner message="Couldn't read the saved proposal. Refresh if its identity changed."
        onRetry={() => { setInspected([]); void preview.refetch(); }} /> : null}
      {displayed ? <>
        <p className="text-xs text-fg-muted">Inspect each complete page change before accepting. Rejection and deferral do not require acceptance.</p>
        {displayed.paths.map((path) => <ProposalPage key={path} source={source} path={path}
          queryKey={key} blocked={blocked} inspected={inspected.includes(path)}
          onUnavailable={() => setInspected((current) => current.includes(path) ? current.filter((value) => value !== path) : current)}
          onInspected={() => setInspected((current) => current.includes(path) ? current : [...current, path])} />)}
      </> : null}
    </div> : null}
  </div>;
}

/** Pages a selected exact before/after pair without treating an excerpt as the complete diff. */
function ProposalPage({ source, path, queryKey, blocked, inspected, onInspected, onUnavailable }: {
  source: Source; path: string; queryKey: string[]; blocked: boolean; inspected: boolean; onInspected: () => void; onUnavailable: () => void;
}) {
  const client = useCoreClient();
  const [open, setOpen] = useState(false);
  const chunks = useInfiniteQuery({
    queryKey: [...queryKey, path], initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const value = assertIdentity(await client.operations['knowledge.proposal.read']({
        workspaceId: source.workspaceId, proposalId: source.knowledgeProposalId, path, offset: pageParam,
      }), source);
      if (value.path !== path || value.nextOffset === undefined || value.before === undefined || value.after === undefined)
        throw new Error('The complete page preview is unavailable.');
      return value;
    },
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: open, retry: false, refetchOnMount: 'always',
  });
  const complete = chunks.isSuccess && !chunks.isFetching && !chunks.hasNextPage;
  useEffect(() => { if (!complete) onUnavailable(); }, [complete, onUnavailable]);
  return <div className="flex min-w-0 flex-col gap-2">
    <Button size="sm" variant="outline" isDisabled={blocked} onPress={() => setOpen((value) => !value)}>
      {open ? `Hide ${path}` : `Read ${path}`}
    </Button>
    {open ? <>
      {chunks.isPending || chunks.isFetching ? <Skeleton lines={2} /> : null}
      {chunks.isError ? <ErrorBanner message={`Couldn't read ${path}. Acceptance remains unavailable.`} onRetry={() => { void chunks.refetch(); }} /> : null}
      {chunks.isSuccess && !chunks.isFetching ? chunks.data.pages.map((chunk, index) => <DiffView key={`${path}-${index}`}
        before={chunk.before ?? ''} after={chunk.after ?? ''}
        beforeLabel={`${path} before, part ${index + 1}${chunk.before === null ? ' (absent)' : ''}`}
        afterLabel={`${path} after, part ${index + 1}${chunk.after === null ? ' (removed)' : ''}`} />) : null}
      {chunks.hasNextPage ? <Button size="sm" variant="outline" isDisabled={blocked || chunks.isFetching}
        onPress={() => { void chunks.fetchNextPage(); }}>Read next part of {path}</Button> : null}
      <Button size="sm" variant="outline" isDisabled={blocked || !complete || inspected} onPress={onInspected}>
        {inspected ? `${path} inspected` : `Mark ${path} inspected`}
      </Button>
    </> : null}
  </div>;
}
