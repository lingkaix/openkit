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

      <VaultList
        id="vault-injection-plans"
        title="Injection plans"
        emptyTitle="No injection plans"
        emptyHint="Workspace injection plans will appear here when granted."
        isLoading={plans.isLoading}
        isError={plans.isError}
        errorMessage="Couldn't load injection plans."
        onRetry={() => void plans.refetch()}
      >
        {(plans.data ?? []).map((plan) => (
          <PlanRow key={plan.planId} plan={plan} />
        ))}
      </VaultList>

      <VaultList
        id="vault-injection-receipts"
        title="Injection receipts"
        emptyTitle="No injection receipts"
        emptyHint="Workspace injection receipts will appear here after attach."
        isLoading={receipts.isLoading}
        isError={receipts.isError}
        errorMessage="Couldn't load injection receipts."
        onRetry={() => void receipts.refetch()}
      >
        {(receipts.data ?? []).map((receipt) => (
          <ReceiptRow key={receipt.receiptId} receipt={receipt} />
        ))}
      </VaultList>
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
  children,
}: {
  id: string;
  title: string;
  emptyTitle: string;
  emptyHint: string;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  const empty = !Array.isArray(children) || children.length === 0;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <h2 id={id} className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
        {title}
      </h2>
      {isLoading ? (
        <Skeleton lines={3} />
      ) : isError ? (
        <ErrorBanner message={errorMessage ?? "Couldn't load Vault records."} onRetry={onRetry} />
      ) : empty ? (
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
