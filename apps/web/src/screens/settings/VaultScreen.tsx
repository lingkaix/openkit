import { useConnection } from '../../app/core-client';
import {
  Card,
  EmptyState,
  ErrorBanner,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  type StatusTone,
} from '../../primitives';
import {
  useCurrentWorkspaceId,
  useVault,
  useWorkspaces,
  type VaultGrantRow,
  type VaultReferenceRow,
  type VaultUseRow,
} from './data';

/**
 * Maps a Vault lifecycle value to the fixed status-chip vocabulary.
 *
 * @param value Vault record lifecycle value.
 * @returns Plain label and semantic status tone.
 */
function vaultStatus(value: string): { label: string; tone: StatusTone } {
  switch (value) {
    case 'active':
      return { label: 'Ready', tone: 'positive' };
    case 'succeeded':
      return { label: 'Done', tone: 'positive' };
    case 'unbound':
      return { label: 'Blocked', tone: 'notice' };
    case 'revoked':
    case 'expired':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'denied':
      return { label: 'Rejected', tone: 'negative' };
    case 'failed':
      return { label: 'Failed', tone: 'negative' };
  }
  return { label: 'Failed', tone: 'negative' };
}

/** Live, read-only Vault metadata and status projection for board 15. */
export function VaultScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const vault = useVault(workspaceId);
  const { failed: disconnected } = useConnection();

  if (workspaces.isLoading || vault.isLoading) {
    return (
      <Page>
        <Skeleton lines={7} />
      </Page>
    );
  }

  if (workspaces.isError) {
    return (
      <Page>
        <PageHeader
          eyebrow="Settings"
          title="Vault"
          subtitle="Credential references, grants, and use evidence — never secret values."
        />
        <ErrorBanner
          message="Couldn't load workspaces."
          onRetry={() => void workspaces.refetch()}
        />
      </Page>
    );
  }

  if (!workspaceId) {
    return (
      <Page>
        <PageHeader
          eyebrow="Settings"
          title="Vault"
          subtitle="Credential references, grants, and use evidence — never secret values."
        />
        <EmptyState
          icon="key"
          title="No workspace selected"
          hint="Select or create a Workspace to view its Vault metadata."
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Vault"
        subtitle="Credential references, grants, and use evidence — never secret values."
        actions={disconnected ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
      />

      {vault.isError ? (
        <ErrorBanner message="Couldn't load Vault records." onRetry={() => void vault.refetch()} />
      ) : vault.data ? (
        <>
          <VaultList
            id="vault-references"
            title="References"
            emptyTitle="No credential references"
            emptyHint="Workspace credential references will appear here when configured."
          >
            {vault.data.references.map((reference) => (
              <ReferenceRow key={reference.referenceId} reference={reference} />
            ))}
          </VaultList>

          <VaultList
            id="vault-grants"
            title="Grants"
            emptyTitle="No active or historical grants"
            emptyHint="Governed credential-use grants will appear here."
          >
            {vault.data.grants.map((grant) => (
              <GrantRow key={grant.grantId} grant={grant} />
            ))}
          </VaultList>

          <VaultList
            id="vault-use"
            title="Recent use"
            emptyTitle="No credential use recorded"
            emptyHint="Redacted credential-use evidence will appear here."
          >
            {vault.data.uses.map((use) => (
              <UseRow key={use.useId} use={use} />
            ))}
          </VaultList>
        </>
      ) : null}
    </Page>
  );
}

/**
 * Renders a fixed-vocabulary chip for one Vault lifecycle value.
 *
 * @param props Vault lifecycle value to label.
 */
function VaultStatusChip({ value }: { value: string }) {
  const status = vaultStatus(value);
  return (
    <StatusChip tone={status.tone} dot>
      {status.label}
    </StatusChip>
  );
}

/**
 * Renders one read-only Vault record-family section.
 *
 * @param props Section identity, copy, and projected rows.
 */
function VaultList({
  id,
  title,
  emptyTitle,
  emptyHint,
  children,
}: {
  id: string;
  title: string;
  emptyTitle: string;
  emptyHint: string;
  children: React.ReactNode;
}) {
  const empty = !Array.isArray(children) || children.length === 0;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <h2 id={id} className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
        {title}
      </h2>
      {empty ? (
        <EmptyState icon="key" title={emptyTitle} hint={emptyHint} />
      ) : (
        <Card className="py-0">{children}</Card>
      )}
    </section>
  );
}

/**
 * Renders one whitelisted Vault reference row.
 *
 * @param props Safe reference metadata.
 */
function ReferenceRow({ reference }: { reference: VaultReferenceRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{reference.referenceId}</p>
        <p className="text-xs text-fg-muted">
          {reference.secretKind} · version {reference.currentVersion}
        </p>
      </div>
      <VaultStatusChip value={reference.status} />
    </ListRow>
  );
}

/**
 * Renders one whitelisted Vault grant row.
 *
 * @param props Safe grant metadata.
 */
function GrantRow({ grant }: { grant: VaultGrantRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{grant.subjectSummary ?? grant.grantId}</p>
        <p className="text-xs text-fg-muted">
          {grant.vaultReferenceId} · {grant.lifetime} · {grant.allowedInjectionPaths.join(', ')}
        </p>
      </div>
      <VaultStatusChip value={grant.status} />
    </ListRow>
  );
}

/**
 * Renders one whitelisted Vault-use evidence row.
 *
 * @param props Safe use-evidence metadata.
 */
function UseRow({ use }: { use: VaultUseRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{use.vaultReferenceId}</p>
        <p className="text-xs text-fg-muted">
          {use.resolvingPath} · {new Date(use.usedAt).toLocaleString()}
        </p>
      </div>
      <VaultStatusChip value={use.outcome} />
    </ListRow>
  );
}
