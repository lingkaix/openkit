import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  TextField,
} from '../../primitives';
import { useWorkspaceStore } from '../workspace-store';
import { useCreateWorkspace } from './data';

/**
 * New workspace form (WP-6, board 07 companion route).
 *
 * Honest create against `core.createWorkspace`. On success, selects the new
 * workspace and returns to Overview. When disconnected, the form stays calm and
 * points back to Overview rather than inventing a kernel API.
 */
export function NewWorkspaceScreen() {
  const navigate = useNavigate();
  const create = useCreateWorkspace();
  const setCurrentWorkspaceId = useWorkspaceStore((s) => s.setCurrentWorkspaceId);
  const { failed: disconnected } = useConnection();
  const [name, setName] = useState('');

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (workspace) => {
        setCurrentWorkspaceId(workspace.id);
        navigate('/');
      },
    });
  }

  if (disconnected) {
    return (
      <Page>
        <PageHeader title="New workspace" />
        <EmptyState
          icon="folder"
          title="Runtime unreachable"
          hint="Reconnect to create a workspace, or head back to Overview."
          action={
            <Link
              to="/"
              className="inline-flex h-8 items-center rounded-full border border-border bg-card px-4 text-sm font-bold text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Overview
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="New workspace"
        subtitle="A workspace holds the threads, files, and knowledge for one area of work."
      />
      <Card className="flex max-w-md flex-col gap-3">
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          placeholder="e.g. Market research"
        />
        {create.isError ? (
          <ErrorBanner message="Couldn't create that workspace." onRetry={submit} />
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" isDisabled={create.isPending || !name.trim()} onPress={submit}>
            Create workspace
          </Button>
          <Link
            to="/"
            className="inline-flex h-7 items-center rounded-full px-3 text-xs font-bold text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            Cancel
          </Link>
        </div>
      </Card>
    </Page>
  );
}
