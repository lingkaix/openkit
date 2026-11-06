import { Fragment, type ReactNode } from 'react';
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
  useVaultInjectionPlans,
  useVaultInjectionReceipts,
  useWorkspaces,
  type VaultGrantRow,
  type VaultInjectionPlanRow,
  type VaultInjectionReceiptRow,
  type VaultReferenceRow,
  type VaultUseRow,
} from './data';
import {
  attentionClause,
  attentionSentence,
  isAttention,
  LongList,
  matchesLoadedRow,
} from './LongList';
import { VaultGrantRequestsPanel } from './VaultGrantRequestsPanel';

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
    case 'stale-session':
      return { label: 'Stale session', tone: 'notice' };
  }
  return { label: 'Failed', tone: 'negative' };
}

/** Live, read-only Vault metadata and status projection for board 15. */
export function VaultScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const vault = useVault(workspaceId);
  const plans = useVaultInjectionPlans(workspaceId);
  const receipts = useVaultInjectionReceipts(workspaceId);
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
          eyebrow="Workspace"
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
          eyebrow="Workspace"
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
        eyebrow="Workspace"
        title="Vault"
        subtitle="Credential references, grants, and use evidence — never secret values."
        actions={disconnected ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
      />

      <VaultGrantRequestsPanel key={workspaceId} workspaceId={workspaceId} />
      {vault.isError ? (
        <ErrorBanner message="Couldn't load Vault records." onRetry={() => void vault.refetch()} />
      ) : vault.data ? (
        <>
          <VaultList
            id="vault-references"
            title="References"
            emptyTitle="No credential references"
            emptyHint="Workspace credential references will appear here when configured."
            rows={vault.data.references.map((reference) => ({
              key: reference.referenceId,
              outcome: reference.status,
              title: reference.referenceId,
              node: <ReferenceRow reference={reference} />,
            }))}
          />

          <VaultList
            id="vault-grants"
            title="Grants"
            emptyTitle="No active or historical grants"
            emptyHint="Governed credential-use grants will appear here."
            rows={vault.data.grants.map((grant) => ({
              key: grant.grantId,
              outcome: grant.status,
              title: grant.subjectSummary ?? grant.grantId,
              node: <GrantRow grant={grant} />,
            }))}
          />

          <VaultList
            id="vault-use"
            title="Recent use"
            emptyTitle="No credential use recorded"
            emptyHint="Redacted credential-use evidence will appear here."
            rows={vault.data.uses.map((use) => ({
              key: use.useId,
              outcome: use.outcome,
              title: use.vaultReferenceId,
              at: use.usedAt,
              node: <UseRow use={use} />,
            }))}
          />
        </>
      ) : null}

      <VaultList
        id="vault-injection-plans"
        title="Injection plans"
        emptyTitle="No injection plans"
        emptyHint="Workspace injection plans will appear here when granted."
        isLoading={plans.isLoading}
        isError={plans.isError}
        errorMessage="Couldn't load injection plans."
        onRetry={() => void plans.refetch()}
        rows={(plans.data ?? []).map((plan) => ({
          key: plan.planId,
          outcome: plan.status,
          title: plan.planId,
          node: <PlanRow plan={plan} />,
        }))}
      />

      <VaultList
        id="vault-injection-receipts"
        title="Injection receipts"
        emptyTitle="No injection receipts"
        emptyHint="Workspace injection receipts will appear here after attach."
        isLoading={receipts.isLoading}
        isError={receipts.isError}
        errorMessage="Couldn't load injection receipts."
        onRetry={() => void receipts.refetch()}
        rows={(receipts.data ?? []).map((receipt) => ({
          key: receipt.receiptId,
          outcome: receipt.revocationStatus,
          title: receipt.receiptId,
          node: <ReceiptRow receipt={receipt} />,
        }))}
      />
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
  isLoading = false,
  isError = false,
  errorMessage,
  onRetry,
  rows,
}: {
  id: string;
  title: string;
  emptyTitle: string;
  emptyHint: string;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  rows: Array<{
    key: string;
    outcome: string;
    title: string;
    at?: string;
    node: ReactNode;
  }>;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <h2 id={id} className="text-eyebrow font-bold tracking-eyebrow text-fg-muted">
        {title}
      </h2>
      {isLoading ? (
        <Skeleton lines={3} />
      ) : isError ? (
        <ErrorBanner message={errorMessage ?? "Couldn't load Vault records."} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState icon="key" title={emptyTitle} hint={emptyHint} />
      ) : (
        <LongList
          summary={(filter) => {
            const lines = rows
              .filter(
                (row) =>
                  isAttention(row.outcome) &&
                  matchesLoadedRow(filter, {
                    outcome: row.outcome,
                    title: row.title,
                    at: row.at,
                  })
              )
              .map((row) => (
                <p key={row.key}>
                  {attentionSentence(attentionClause(row.outcome), row.title, row.at)}
                </p>
              ));
            return lines.length > 0 ? (
              lines
            ) : (
              <p>Nothing failed, was denied, or needs a decision.</p>
            );
          }}
          records={(filter) => (
            <Card className="py-0">
              {rows
                .filter((row) =>
                  matchesLoadedRow(filter, {
                    outcome: row.outcome,
                    title: row.title,
                    at: row.at,
                  })
                )
                .map((row) => (
                  <Fragment key={row.key}>{row.node}</Fragment>
                ))}
            </Card>
          )}
        />
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

/**
 * Renders one whitelisted Vault injection-plan row.
 *
 * @param props Safe injection-plan metadata.
 */
function PlanRow({ plan }: { plan: VaultInjectionPlanRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{plan.planId}</p>
        <p className="text-xs text-fg-muted">{plan.injectionVisibility}</p>
        <p className="text-xs text-fg-muted">{plan.expirationBehavior}</p>
      </div>
      <VaultStatusChip value={plan.status} />
    </ListRow>
  );
}

/**
 * Renders one whitelisted Vault injection-receipt row.
 *
 * @param props Safe injection-receipt metadata.
 */
function ReceiptRow({ receipt }: { receipt: VaultInjectionReceiptRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{receipt.receiptId}</p>
        <p className="text-xs text-fg-muted">{receipt.backendSummary}</p>
      </div>
      <VaultStatusChip value={receipt.revocationStatus} />
    </ListRow>
  );
}
