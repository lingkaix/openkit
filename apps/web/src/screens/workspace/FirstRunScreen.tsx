import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import { useWorkspaces } from './data';

/**
 * First-run welcome (WP-6, board 18) — the app-level empty / onboarding state.
 *
 * Surfaces connect/runtime readiness with retry, then workspace creation. When a
 * workspace already exists, offers a short "you're set" path back to Overview.
 */
export function FirstRunScreen() {
  const { connected, checking, failed, retry } = useConnection();
  const workspaces = useWorkspaces();

  if (checking || workspaces.isLoading) {
    return (
      <Page>
        <Skeleton lines={4} />
      </Page>
    );
  }

  if (failed || !connected) {
    return (
      <Page>
        <PageHeader eyebrow="Welcome" title="Connect the local runtime" />
        <EmptyState
          icon="connect"
          title="Couldn't reach the local runtime"
          hint="Start NanoCore, then retry the connection."
          action={
            <Button size="sm" onPress={retry}>
              Retry
            </Button>
          }
        />
      </Page>
    );
  }

  if (workspaces.isError) {
    return (
      <Page>
        <PageHeader eyebrow="Welcome" title="Your agent team, ready for real work" />
        <ErrorBanner
          message="Couldn't load workspaces."
          onRetry={() => void workspaces.refetch()}
        />
      </Page>
    );
  }

  const hasWorkspace = (workspaces.data?.length ?? 0) > 0;

  if (hasWorkspace) {
    return (
      <Page>
        <PageHeader
          eyebrow="Welcome"
          title="You're set"
          subtitle="A workspace is ready. Head to Overview to see what needs you."
        />
        <EmptyState
          icon="home"
          title="Go to Overview"
          hint="Overview is the home for Needs-you and work in motion."
          action={
            <Link
              to="/"
              className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-bold text-on-accent outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
        eyebrow="Welcome"
        title="Your agent team, ready for real work"
        subtitle="Delegate work, watch it move, step in when it matters. A few small things first."
      />

      <Card className="flex flex-col gap-0 p-0">
        <SetupRow
          done
          title="Agent runtime connected"
          help="Local NanoCore is reachable."
          trailing={
            <StatusChip tone="positive" dot>
              Ready
            </StatusChip>
          }
        />
        <SetupRow
          step={2}
          title="Create your first workspace"
          help="A workspace holds the threads, files, and knowledge for one area of work."
          trailing={
            <Link
              to="/settings/workspaces/new"
              className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
            >
              Create workspace
            </Link>
          }
        />
      </Card>
    </Page>
  );
}

function SetupRow({
  step,
  done,
  title,
  help,
  trailing,
}: {
  step?: number;
  done?: boolean;
  title: string;
  help: string;
  trailing: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-separator px-4 py-3 last:border-b-0">
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? 'bg-positive-bg text-positive-fg' : 'bg-sunken text-fg-muted'
        }`}
      >
        {done ? '✓' : step}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{title}</p>
        <p className="text-xs text-fg-muted">{help}</p>
      </div>
      {trailing}
    </div>
  );
}
