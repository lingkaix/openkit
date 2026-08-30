import { useState } from 'react';
import { Input, Label, SearchField } from 'react-aria-components';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import { Button, ErrorBanner, Skeleton } from '../../primitives';
import { useWorkspaceStore } from '../workspace-store';
import {
  type AppSearchHit,
  authorizedWorkspaceId,
  pathForSearchHit,
  useAppSearch,
  useWorkspaces,
} from './data';

/**
 * Application search field and results. Opened from the sidebar brand row;
 * not a pinned strip above routed main content.
 */
export function AppSearch({ onClose }: { onClose?: () => void }) {
  const navigate = useNavigate();
  const { failed: disconnected } = useConnection();
  const workspaces = useWorkspaces();
  const [draft, setDraft] = useState('');
  const [submitted, setSubmitted] = useState('');
  const search = useAppSearch(submitted);
  const hits = search.data ?? [];

  function submit(value: string) {
    if (disconnected) return;
    setSubmitted(value.trim());
  }

  function admittedTarget(hit: AppSearchHit) {
    if (!workspaces.isSuccess) return undefined;
    return authorizedWorkspaceId(
      workspaces.data,
      hit.kind === 'workspace' ? hit.id : hit.workspaceId
    );
  }

  function openHit(hit: AppSearchHit) {
    const workspaceId = admittedTarget(hit);
    if (!workspaceId) return;
    useWorkspaceStore.getState().setCurrentWorkspaceId(workspaceId);
    navigate(pathForSearchHit(hit));
    onClose?.();
  }

  return (
    <div>
      <SearchField
        className="flex flex-col gap-1"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        isDisabled={disconnected}
      >
        <Label className="text-xs font-bold text-fg">Search</Label>
        <Input
          className="h-8 rounded-ok border border-border bg-card px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted hover:border-border-hover focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg"
          placeholder="Search"
        />
      </SearchField>

      {submitted ? (
        <div className="mt-3">
          {search.isError ? (
            <ErrorBanner message="Couldn't search." onRetry={() => void search.refetch()} />
          ) : null}
          {search.isFetching && search.data === undefined ? <Skeleton lines={2} /> : null}
          {search.isSuccess && hits.length === 0 ? (
            <p className="text-sm text-fg-muted">No search results</p>
          ) : null}
          {hits.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {hits.map((hit) => (
                <li key={`${hit.kind}:${hit.id}`}>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="w-full justify-start"
                    isDisabled={!admittedTarget(hit)}
                    onPress={() => openHit(hit)}
                  >
                    {hit.title}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
