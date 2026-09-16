import { type ChangeEvent, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { useNavigate } from 'react-router-dom';
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
import { useWorkspaceStore } from '../workspace-store';
import {
  dryRunWorkspaceImportError,
  exportWorkspaceError,
  importWorkspaceError,
  isPortabilityProjectKind,
  nextArchiveImportCommand,
  nextImportCommand,
  type PortabilityImportReview,
  portabilityVaultStatusLabel,
  rebindWorkspaceVaultError,
  useCurrentWorkspaceId,
  useDryRunWorkspaceArchiveImport,
  useDryRunWorkspaceImport,
  useExportWorkspace,
  useImportWorkspace,
  useImportWorkspaceArchive,
  useRebindWorkspaceVaultReference,
  useWorkspaces,
  workspaceExportArchiveHref,
} from './data';

/** Live user-scoped import plus selected-Workspace export and vault rebind. */
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
        <ProjectExport
          key={`export:${project.id}`}
          workspaceId={project.id}
          disconnected={disconnected}
        />
      ) : (
        <EmptyState
          icon="folder"
          title="No project workspace selected"
          hint="Select or create a project workspace to export or rebind Vault references."
        />
      )}
      <ImportPanel disconnected={disconnected} />
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

/** Selected project-Workspace export; independent of Vault pending state. */
function ProjectExport({
  workspaceId,
  disconnected,
}: {
  workspaceId: string;
  disconnected: boolean;
}) {
  const exportWorkspace = useExportWorkspace();
  const exportBound = exportWorkspace.variables === workspaceId;
  const exportSummary = exportBound && exportWorkspace.isSuccess ? exportWorkspace.data : null;
  const writeBlocked = disconnected;
  const exportError =
    exportBound && exportWorkspace.isError ? exportWorkspaceError(exportWorkspace.error) : null;

  return (
    <section className="flex flex-col gap-3" aria-label="Export">
      <Eyebrow>Export</Eyebrow>
      {exportError ? <ErrorBanner message={exportError} /> : null}
      <div>
        <Button
          isDisabled={writeBlocked || exportWorkspace.isPending}
          onPress={() => exportWorkspace.mutate(workspaceId)}
        >
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

/** Selected project-Workspace vault rebind; skeletons only this section while Vault is pending. */
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

  if (vault.isLoading && vault.data === undefined) {
    return <Skeleton lines={8} />;
  }

  const references = vault.data?.references ?? [];
  const unbound = references.filter((item) => item.status === 'unbound');
  const writeBlocked = disconnected;
  const rebindError = vaultRebind.isError ? rebindWorkspaceVaultError(vaultRebind.error) : null;

  function submitRebind(referenceId: string) {
    if (!vaultMaterial) return;
    const material = vaultMaterial;
    setVaultMaterial('');
    vaultRebind.submit(workspaceId, referenceId, material);
  }

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
      {!vault.isError && references.length === 0 ? (
        <EmptyState
          icon="key"
          title="No vault references"
          hint="Imported Workspace credential references that need a local rebind will appear here."
        />
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
                      isDisabled={!vaultMaterial}
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

/** User-scoped dry-run review and import; usable without a selected project Workspace. */
function ImportPanel({ disconnected }: { disconnected: boolean }) {
  const navigate = useNavigate();
  const setCurrentWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);
  const reviewImport = useDryRunWorkspaceImport();
  const importWorkspace = useImportWorkspace();
  const reviewArchive = useDryRunWorkspaceArchiveImport();
  const importArchive = useImportWorkspaceArchive();
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('');
  const [exportId, setExportId] = useState('');
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const writeBlocked = disconnected;
  const handlesReady = Boolean(sourceWorkspaceId && exportId);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const reviewPending = reviewImport.isPending || reviewArchive.isPending;
  const importPending = importWorkspace.isPending || importArchive.isPending;
  const sourceLocked = writeBlocked || reviewPending || importPending;
  const archiveReviewBound = Boolean(archiveFile) && reviewArchive.variables === archiveFile;
  const archiveReview = archiveReviewBound && reviewArchive.isSuccess ? reviewArchive.data : null;
  const reviewBound =
    !archiveFile &&
    reviewImport.variables?.sourceWorkspaceId === sourceWorkspaceId &&
    reviewImport.variables?.exportId === exportId;
  const handleReview = reviewBound && reviewImport.isSuccess ? reviewImport.data : null;
  const review = archiveFile ? archiveReview : handleReview;
  const archiveImportBound = Boolean(archiveFile) && importArchive.variables?.file === archiveFile;
  const importBound =
    !archiveFile &&
    importWorkspace.variables?.sourceWorkspaceId === sourceWorkspaceId &&
    importWorkspace.variables?.exportId === exportId;
  const imported =
    archiveFile && archiveImportBound && importArchive.isSuccess
      ? importArchive.data
      : !archiveFile && importBound && importWorkspace.isSuccess
        ? importWorkspace.data
        : null;
  const reviewError = archiveFile
    ? archiveReviewBound && reviewArchive.isError
      ? dryRunWorkspaceImportError(reviewArchive.error)
      : null
    : reviewBound && reviewImport.isError
      ? dryRunWorkspaceImportError(reviewImport.error)
      : null;
  const importError = archiveFile
    ? archiveImportBound && importArchive.isError
      ? importWorkspaceError(importArchive.error)
      : null
    : importBound && importWorkspace.isError
      ? importWorkspaceError(importWorkspace.error)
      : null;

  /**
   * Binds the selected archive File as the import source and invalidates prior review and import.
   *
   * @param event Native change from the Portable archive file control.
   */
  function onArchiveFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setArchiveFile(file);
    reviewArchive.reset();
    importArchive.reset();
    reviewImport.reset();
    importWorkspace.reset();
  }

  /**
   * Clears the selected archive File and native file input so server-export handles are the source.
   */
  function clearArchiveFile() {
    const input = archiveInputRef.current;
    if (input) input.value = '';
    setArchiveFile(null);
    reviewArchive.reset();
    importArchive.reset();
  }

  function submitReview() {
    if (sourceLocked || imported) return;
    if (archiveFile) {
      importArchive.reset();
      importWorkspace.reset();
      reviewImport.reset();
      reviewArchive.mutate(archiveFile);
      return;
    }
    if (!handlesReady) return;
    importWorkspace.reset();
    importArchive.reset();
    reviewArchive.reset();
    reviewImport.mutate({ sourceWorkspaceId, exportId });
  }

  function submitImport() {
    if (imported) return;
    if (archiveFile) {
      if (!archiveReview) return;
      importArchive.mutate(nextArchiveImportCommand(importArchive.variables, archiveFile));
      return;
    }
    if (!handleReview || !handlesReady) return;
    importWorkspace.mutate(
      nextImportCommand(importWorkspace.variables, sourceWorkspaceId, exportId)
    );
  }

  /**
   * Retries the bound dry-run for the current import source without changing File or handle identity.
   */
  function retryReview() {
    if (archiveFile) {
      if (reviewArchive.variables) reviewArchive.mutate(reviewArchive.variables);
      return;
    }
    if (reviewImport.variables) reviewImport.mutate(reviewImport.variables);
  }

  /**
   * Retries the exact bound import command for the current File or server-export handles.
   */
  function retryImport() {
    if (archiveFile) {
      if (importArchive.variables) importArchive.mutate(importArchive.variables);
      return;
    }
    if (importWorkspace.variables) importWorkspace.mutate(importWorkspace.variables);
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Import">
      <Eyebrow>Import</Eyebrow>
      {reviewError ? <ErrorBanner message={reviewError} onRetry={retryReview} /> : null}
      {importError ? <ErrorBanner message={importError} onRetry={retryImport} /> : null}
      <label className="flex flex-col gap-1 text-sm text-fg">
        Portable archive
        <input
          ref={archiveInputRef}
          accept=".openkit-workspace.tar.zst,application/vnd.openkit.workspace-export+tar.zstd"
          aria-label="Portable archive"
          disabled={sourceLocked}
          onChange={onArchiveFileChange}
          type="file"
        />
      </label>
      {archiveFile ? (
        <>
          <p className="text-sm text-fg">{archiveFile.name}</p>
          <div>
            <Button variant="outline" isDisabled={sourceLocked} onPress={clearArchiveFile}>
              Use server export
            </Button>
          </div>
        </>
      ) : (
        <>
          <TextField
            label="Source workspace ID"
            value={sourceWorkspaceId}
            onChange={setSourceWorkspaceId}
            isDisabled={sourceLocked}
          />
          <TextField
            label="Export ID"
            value={exportId}
            onChange={setExportId}
            isDisabled={sourceLocked}
          />
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          isDisabled={sourceLocked || !(archiveFile || handlesReady) || Boolean(imported)}
          onPress={submitReview}
        >
          Review import
        </Button>
        <Button
          isDisabled={writeBlocked || !review || importPending || Boolean(imported)}
          onPress={submitImport}
        >
          Import workspace
        </Button>
      </div>
      {review && !imported ? <ImportReviewSummary review={review} /> : null}
      {imported ? (
        <>
          <div role="status">
            <StatusChip tone="positive">Imported</StatusChip>
            <p className="text-sm font-bold text-fg-strong">{imported.workspace.name}</p>
            <p className="text-sm text-fg">{imported.importedWorkspaceId}</p>
          </div>
          <div>
            <Button
              variant="outline"
              onPress={() => {
                setCurrentWorkspaceId(imported.importedWorkspaceId);
                navigate('/');
              }}
            >
              Open workspace
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Renders identities, inventory counts, collision outcome, and authorization consequences. */
function ImportReviewSummary({ review }: { review: PortabilityImportReview }) {
  const fileLabel = review.verification.fileCount === 1 ? 'file' : 'files';
  const targetWorkspaceId =
    review.collision.status === 'collides'
      ? review.collision.suggestedWorkspaceId
      : review.collision.workspaceId;

  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm text-fg">Source workspace {review.sourceWorkspaceId}</p>
      <p className="text-sm text-fg">Exported workspace {review.exportedWorkspaceId}</p>
      <p className="text-sm font-bold text-fg-strong">{targetWorkspaceId}</p>
      <p className="text-sm text-fg">
        {review.verification.fileCount} {fileLabel} · {review.verification.totalBytes} bytes
      </p>
      {review.collision.status === 'collides' ? (
        <p className="text-sm text-fg">This workspace already exists; import will use a new id.</p>
      ) : (
        <p className="text-sm text-fg">
          Target workspace {review.collision.workspaceId} is available; import will keep this id.
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="What import does">
        <li className="text-sm text-fg">
          The authenticated importer becomes the new canonical owner and the sole active member.
        </li>
        <li className="text-sm text-fg">
          Source-deployment memberships, invitations, and tokens must not be reconstructed.
        </li>
        <li className="text-sm text-fg">
          Approvals, PermissionDecision records, and VaultGrant records are historical only and
          grant no authority.
        </li>
        <li className="text-sm text-fg">
          Vault references are unbound and require an explicit local rebind.
        </li>
      </ul>
    </Card>
  );
}

/** Renders the Portability header and disconnected or refetch stale evidence. */
function PortabilityHeader({ stale = false }: { stale?: boolean }) {
  return (
    <PageHeader
      eyebrow="User"
      title="Portability"
      subtitle="Export this Workspace, download a portable archive, review an import before applying it, and rebind imported Vault references."
      actions={stale ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
    />
  );
}
