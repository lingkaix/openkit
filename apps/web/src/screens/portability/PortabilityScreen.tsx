import { useEffect, useState } from 'react';
import { Link } from 'react-aria-components';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  ListRow,
  Modal,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { useVault } from '../settings/data';
import { parseWorkspaceFreezeRefusal, WorkspaceFreezeRefusalPanel } from '../workspace-freeze';
import {
  exportWorkspaceError,
  isPortabilityProjectKind,
  portabilityVaultStatusLabel,
  rebindWorkspaceVaultError,
  useCurrentWorkspaceId,
  useExportWorkspace,
  useRebindWorkspaceVaultReference,
  useWorkspaces,
  workspaceExportArchiveHref,
} from './data';

/** Administrator export and selected-Workspace vault rebind after migration. */
export function PortabilityScreen() {
  const workspaces = useWorkspaces();
  const currentId = useCurrentWorkspaceId();
  const { checking, failed } = useConnection();
  const disconnected = failed;
  const workspace = workspaces.data?.find((item) => item.id === currentId) ?? null;
  const project =
    !workspaces.isError && workspace && isPortabilityProjectKind(workspace.kind) ? workspace : null;
  const stale = checking || disconnected || Boolean(workspaces.isError && workspaces.data);

  return (
    <Page>
      {workspaces.isLoading && workspaces.data === undefined ? null : (
        <PortabilityHeader stale={stale} />
      )}
      {workspaces.isLoading && workspaces.data === undefined ? (
        <Skeleton lines={4} />
      ) : workspaces.isError ? (
        <ErrorBanner
          message="Couldn't load workspaces."
          onRetry={() => void workspaces.refetch()}
        />
      ) : project ? (
        <AdministratorExport
          key={`export:${project.id}`}
          workspaceId={project.id}
          disconnected={disconnected}
        />
      ) : (
        <EmptyState
          icon="folder"
          title="No project workspace selected"
          hint="Select or create a project workspace to export under administrator authority or rebind Vault references."
        />
      )}
      {project ? (
        <ProjectVault
          key={`vault:${project.id}`}
          workspaceId={project.id}
          disconnected={disconnected}
        />
      ) : null}
    </Page>
  );
}

/** Selected project-Workspace administrator export. */
function AdministratorExport({
  workspaceId,
  disconnected,
}: {
  workspaceId: string;
  disconnected: boolean;
}) {
  const exportWorkspace = useExportWorkspace();
  const exportBound = exportWorkspace.variables === workspaceId;
  const exportSummary = exportBound && exportWorkspace.isSuccess ? exportWorkspace.data : null;
  const refusal =
    exportBound && exportWorkspace.isError
      ? parseWorkspaceFreezeRefusal(exportWorkspace.error)
      : null;
  const exportError =
    exportBound && exportWorkspace.isError ? exportWorkspaceError(exportWorkspace.error) : null;
  const writeBlocked = disconnected || exportWorkspace.isPending;

  return (
    <section className="flex flex-col gap-3" aria-label="Export">
      <Eyebrow>Administrator export</Eyebrow>
      {exportError ? <ErrorBanner message={exportError} /> : null}
      {refusal ? (
        <WorkspaceFreezeRefusalPanel
          refusal={refusal}
          onRetry={() => exportWorkspace.mutate(workspaceId)}
        />
      ) : null}
      <div>
        <Button isDisabled={writeBlocked} onPress={() => exportWorkspace.mutate(workspaceId)}>
          Export workspace
        </Button>
      </div>
      {exportSummary ? (
        <Card>
          <p className="text-sm font-bold text-fg-strong">{exportSummary.exportId}</p>
          <p className="text-sm text-fg">
            {exportSummary.fileCount} {exportSummary.fileCount === 1 ? 'file' : 'files'}
          </p>
          <div className="pt-2">
            <Link
              aria-label="Download archive (opens in a new tab)"
              className="text-sm font-bold text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-focus data-disabled:cursor-not-allowed data-disabled:text-disabled-fg data-disabled:no-underline"
              href={workspaceExportArchiveHref(workspaceId, exportSummary.exportId)}
              isDisabled={writeBlocked}
              rel="noopener noreferrer"
              target="_blank"
            >
              Download archive
            </Link>
          </div>
        </Card>
      ) : null}
    </section>
  );
}

/** Selected-Workspace Vault rebind with current-read admission and ephemeral secret material. */
function ProjectVault({
  workspaceId,
  disconnected,
}: {
  workspaceId: string;
  disconnected: boolean;
}) {
  const vault = useVault(workspaceId);
  const vaultRebind = useRebindWorkspaceVaultReference();
  const [vaultMaterial, setVaultMaterial] = useState('');

  useEffect(() => {
    if (vault.isError) setVaultMaterial('');
  }, [vault.isError]);

  if (!vault.isFetchedAfterMount && !vault.isError) {
    return <Skeleton lines={8} />;
  }

  const references = vault.isSuccess ? (vault.data?.references ?? []) : [];
  const unbound = references.filter((item) => item.status === 'unbound');
  const writeBlocked = disconnected || !vault.isSuccess || vault.fetchStatus !== 'idle';
  const rebindError = vaultRebind.isError ? rebindWorkspaceVaultError(vaultRebind.error) : null;

  function submitRebind(referenceId: string) {
    if (
      writeBlocked ||
      vaultRebind.isPending ||
      !vaultMaterial ||
      !unbound.some((reference) => reference.referenceId === referenceId)
    )
      return;
    const material = vaultMaterial;
    setVaultMaterial('');
    vaultRebind.submit(workspaceId, referenceId, material);
  }

  const unboundHint =
    'Credential references that need a new secret (for example after a Workspace MOVE) will appear here.';

  return (
    <section className="flex flex-col gap-3" aria-label="Vault references">
      <Eyebrow>Vault references</Eyebrow>
      {vault.isError ? (
        <ErrorBanner
          message="Couldn't load vault references."
          onRetry={() => void vault.refetch()}
        />
      ) : null}
      {rebindError ? <ErrorBanner message={rebindError} /> : null}
      {vault.isSuccess && vault.fetchStatus === 'idle' && references.length === 0 ? (
        <EmptyState icon="key" title="No vault references" hint={unboundHint} />
      ) : null}
      {references.map((reference) => (
        <Card key={reference.referenceId} className="py-0">
          <ListRow>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{reference.secretKind}</p>
              <p className="text-xs text-fg-muted">{reference.referenceId}</p>
            </div>
            <StatusChip tone={reference.status === 'active' ? 'positive' : 'notice'}>
              {portabilityVaultStatusLabel(reference.status)}
            </StatusChip>
            {reference.status === 'unbound' ? (
              <Modal
                trigger={
                  <Button
                    size="sm"
                    aria-label={`Rebind ${reference.secretKind} ${reference.referenceId}`}
                    isDisabled={writeBlocked || vaultRebind.isPending}
                  >
                    Rebind
                  </Button>
                }
              >
                <Dialog title={`Confirm rebind ${reference.secretKind}`}>
                  <p>
                    Reference {reference.referenceId} becomes active and cannot be rebound again.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button slot="close" variant="quiet" onPress={() => setVaultMaterial('')}>
                      Cancel
                    </Button>
                    <Button
                      slot="close"
                      isDisabled={writeBlocked || vaultRebind.isPending || !vaultMaterial}
                      onPress={() => submitRebind(reference.referenceId)}
                    >
                      Confirm
                    </Button>
                  </div>
                </Dialog>
              </Modal>
            ) : null}
          </ListRow>
        </Card>
      ))}
      {unbound.length > 0 ? (
        <TextField
          label="Vault material"
          type="password"
          value={vaultMaterial}
          onChange={setVaultMaterial}
          isDisabled={writeBlocked || vaultRebind.isPending}
        />
      ) : null}
    </section>
  );
}

/** Renders the Portability header and disconnected or refetch stale evidence. */
function PortabilityHeader({ stale = false }: { stale?: boolean }) {
  return (
    <PageHeader
      eyebrow="Administration"
      title="Portability"
      subtitle="Export a Workspace under administrator authority, download the portable archive, and rebind credential references that need a new secret."
      actions={stale ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
    />
  );
}
