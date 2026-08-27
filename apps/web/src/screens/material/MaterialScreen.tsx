import { ApiCallError } from '@openkit/core-client';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  DiffView,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  MaterialEditor,
  Page,
  PageHeader,
  Skeleton,
} from '../../primitives';
import { useCurrentWorkspaceId, useWorkspaces } from '../chat/data';
import {
  type MaterialKind,
  type MaterialSensitivity,
  sha256Content,
  useCreateWorkspaceMaterial,
  useSaveWorkspaceMaterialRevision,
  useWorkspaceMaterial,
  useWorkspaceMaterialRevision,
  useWorkspaceMaterialRevisions,
  useWorkspaceMaterials,
  type WorkspaceMaterial,
} from './data';
import { RevisionHistory } from './RevisionHistory';
import { ThreadMaterialPanel } from './ThreadMaterialPanel';

/** Input accepted by the explicit New Material flow. */
interface NewMaterialInput {
  /** Required user-visible Material title. */
  title: string;
  /** One of the two server-admitted content kinds. */
  kind: MaterialKind;
  /** One of the three server-admitted sensitivity classes. */
  sensitivity: MaterialSensitivity;
}

/** Renders the local creation form without starting any work command. */
function NewMaterialForm({
  onCancel,
  onCreate,
  isPending,
  disconnected,
  createError,
}: {
  onCancel: () => void;
  onCreate: (input: NewMaterialInput) => void;
  isPending: boolean;
  disconnected: boolean;
  createError: boolean;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MaterialKind>('markdown');
  const [sensitivity, setSensitivity] = useState<MaterialSensitivity>('internal');

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <Eyebrow>New Material</Eyebrow>
          <p className="mt-1 text-sm text-fg-muted">Create a workspace-owned text resource.</p>
        </div>
        <Button size="sm" variant="quiet" onPress={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="mt-4 flex flex-col gap-4">
        {createError ? (
          <ErrorBanner
            message="Couldn't create this Material."
            onRetry={
              !disconnected && !isPending
                ? () => onCreate({ title: title.trim(), kind, sensitivity })
                : undefined
            }
          />
        ) : null}
        <label className="flex flex-col gap-1 text-xs font-bold text-fg" htmlFor="material-title">
          Title
          <input
            id="material-title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="h-8 rounded-ok border border-border bg-card px-3 text-sm font-normal text-fg outline-none transition-colors placeholder:text-fg-muted hover:border-border-hover focus:border-accent focus:ring-2 focus:ring-focus"
            required
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-bold text-fg">Kind</legend>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="radio"
              name="material-kind"
              value="markdown"
              checked={kind === 'markdown'}
              onChange={() => setKind('markdown')}
            />
            Markdown
          </label>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="radio"
              name="material-kind"
              value="text"
              checked={kind === 'text'}
              onChange={() => setKind('text')}
            />
            Plain text
          </label>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-bold text-fg">Sensitivity</legend>
          {(['public', 'internal', 'restricted'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm capitalize text-fg">
              <input
                type="radio"
                name="material-sensitivity"
                value={value}
                checked={sensitivity === value}
                onChange={() => setSensitivity(value)}
              />
              {value}
            </label>
          ))}
        </fieldset>
        <Button
          isDisabled={!title.trim() || isPending || disconnected}
          onPress={() => onCreate({ title: title.trim(), kind, sensitivity })}
        >
          Create Material
        </Button>
      </div>
    </Card>
  );
}

/**
 * Renders one Material's authoritative identity, editor baseline, and revision views.
 *
 * @param props Material and registered route context.
 * @param props.threadId Exact Thread from the registered Material route.
 * @returns The authoritative Material detail surface.
 */
function MaterialDetail({
  workspaceId,
  materialId,
  threadId,
  disconnected,
}: {
  workspaceId: string;
  materialId: string;
  threadId: string;
  disconnected: boolean;
}) {
  const material = useWorkspaceMaterial(workspaceId, materialId);
  const revisions = useWorkspaceMaterialRevisions(workspaceId, materialId);
  const [openedRevisionId, setOpenedRevisionId] = useState<string | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const record = material.data?.material;
  const currentRevisionId = record?.currentRevisionId ?? null;
  const selectedRevisionId = openedRevisionId ?? currentRevisionId;
  const revision = useWorkspaceMaterialRevision(workspaceId, materialId, selectedRevisionId);
  const currentRevision = useWorkspaceMaterialRevision(workspaceId, materialId, currentRevisionId);
  const selectedRevision = openedRevisionId ? revision.data?.revision : undefined;
  const currentContent = currentRevision.data?.revision.content;
  const revisionItems = revisions.data?.revisions ?? [];
  const compareBeforeId =
    selectedRevisionId === currentRevisionId
      ? (revisionItems.find((item) => item.revisionId !== currentRevisionId)?.revisionId ?? null)
      : (selectedRevisionId ?? revisionItems[0]?.revisionId ?? null);
  const compareAfterId = currentRevisionId;
  const compareBefore = useWorkspaceMaterialRevision(workspaceId, materialId, compareBeforeId);
  const compareAfter = useWorkspaceMaterialRevision(workspaceId, materialId, compareAfterId);
  const save = useSaveWorkspaceMaterialRevision(workspaceId, materialId, threadId);

  if (!record && material.isLoading) return <Skeleton lines={7} />;
  if (!record) {
    return (
      <ErrorBanner message="Couldn't load this material." onRetry={() => void material.refetch()} />
    );
  }

  /** Saves the exact editor draft only while the live connection permits mutation. */
  const saveDraft = async (content: string) => {
    if (disconnected) throw new Error('Material save is unavailable while disconnected.');
    setConflict(false);
    try {
      await save.mutateAsync({
        expectedRevisionId: record.currentRevisionId,
        contentDigest: await sha256Content(content),
        content,
      });
    } catch (error) {
      if (error instanceof ApiCallError && error.status === 409 && error.code === 'conflict') {
        setConflict(true);
      }
      throw error;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Eyebrow>{record.kind === 'markdown' ? 'Markdown Material' : 'Text Material'}</Eyebrow>
            <h2 className="mt-1 truncate text-lg font-extrabold text-fg-strong">{record.title}</h2>
            <p className="mt-1 font-mono text-xs text-fg-muted">{record.materialId}</p>
          </div>
          <span className="rounded-full bg-sunken px-2 py-1 text-xs capitalize text-fg-muted">
            {record.sensitivity}
          </span>
        </div>
        {conflict ? (
          <div className="mt-4">
            <ErrorBanner message="This material changed since you opened it. Keep the draft and save again after reviewing the current revision." />
          </div>
        ) : null}
        {material.isError ? (
          <div className="mt-4">
            <ErrorBanner
              message="The latest Material details could not be refreshed."
              onRetry={() => void material.refetch()}
            />
          </div>
        ) : null}
        {currentRevision.isError ? (
          <div className="mt-4">
            <ErrorBanner
              message="The current saved revision could not be refreshed."
              onRetry={() => void currentRevision.refetch()}
            />
          </div>
        ) : null}
        <div className="mt-5">
          {currentContent !== undefined || currentRevisionId === null ? (
            <fieldset disabled={disconnected}>
              <MaterialEditor
                key={currentRevisionId ?? 'empty'}
                label={record.title}
                kind={record.kind}
                initialValue={currentContent ?? ''}
                onSave={saveDraft}
              />
            </fieldset>
          ) : currentRevision.isError ? null : (
            <Skeleton lines={4} />
          )}
        </div>
      </Card>

      {revisions.isLoading && !revisions.data ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : revisions.isError && !revisions.data ? (
        <ErrorBanner
          message="Couldn't load revision history."
          onRetry={() => void revisions.refetch()}
        />
      ) : (
        <>
          {revisions.isError ? (
            <ErrorBanner
              message="The revision history could not be refreshed."
              onRetry={() => void revisions.refetch()}
            />
          ) : null}
          <RevisionHistory
            revisions={revisionItems}
            selectedRevisionId={selectedRevisionId}
            onOpen={(revisionId) => {
              setOpenedRevisionId(revisionId);
              setComparisonOpen(false);
            }}
            onCompare={() => setComparisonOpen(true)}
          />
        </>
      )}

      {!comparisonOpen && openedRevisionId ? (
        <Card>
          <Eyebrow>Opened revision</Eyebrow>
          {selectedRevision ? (
            <>
              {revision.isError ? (
                <div className="mt-3">
                  <ErrorBanner
                    message="This opened revision could not be refreshed."
                    onRetry={() => void revision.refetch()}
                  />
                </div>
              ) : null}
              <p className="mt-1 font-mono text-xs text-fg-muted">{selectedRevision.revisionId}</p>
              <section
                aria-label={`Revision ${selectedRevision.revisionId}`}
                className="mt-3 max-h-72 overflow-auto rounded-ok border border-border bg-sunken p-3"
              >
                <pre className="whitespace-pre-wrap font-mono text-xs text-fg">
                  {selectedRevision.content}
                </pre>
              </section>
            </>
          ) : revision.isError ? (
            <div className="mt-3">
              <ErrorBanner
                message="Couldn't load this revision."
                onRetry={() => void revision.refetch()}
              />
            </div>
          ) : (
            <div className="mt-3">
              <Skeleton lines={4} />
            </div>
          )}
        </Card>
      ) : null}

      {comparisonOpen && compareBeforeId && compareAfterId ? (
        <Card>
          <Eyebrow>Client-only comparison</Eyebrow>
          <p className="mt-1 text-xs text-fg-muted">
            Read-only comparison of two immutable revisions; it does not change Material state.
          </p>
          {compareBefore.isError || compareAfter.isError ? (
            <div className="mt-3">
              <ErrorBanner
                message="Couldn't load both revisions for comparison."
                onRetry={() => {
                  void compareBefore.refetch();
                  void compareAfter.refetch();
                }}
              />
            </div>
          ) : null}
          {compareBefore.data?.revision && compareAfter.data?.revision ? (
            <div className="mt-3">
              <DiffView
                before={compareBefore.data.revision.content}
                after={compareAfter.data.revision.content}
                beforeLabel={`Revision ${compareBeforeId}`}
                afterLabel={`Revision ${compareAfterId}`}
              />
            </div>
          ) : !compareBefore.isError && !compareAfter.isError ? (
            <div className="mt-3">
              <Skeleton lines={4} />
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Registers the live route-only Material surface after authorized Workspace discovery settles.
 *
 * @returns The discovery gate or the current Workspace Material projection.
 * @throws When the registered route omits its required Thread id.
 */
export function MaterialScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const { materialId: routeMaterialId, threadId } = useParams<{
    materialId?: string;
    threadId?: string;
  }>();
  if (!threadId) throw new Error('The registered Material route requires a Thread id.');
  const navigate = useNavigate();
  const materials = useWorkspaceMaterials(workspaceId);
  const create = useCreateWorkspaceMaterial(workspaceId);
  const { failed, checking } = useConnection();
  const disconnected = failed || checking;
  const [showNew, setShowNew] = useState(false);
  const selectedMaterialId = routeMaterialId ?? materials.data?.[0]?.materialId ?? null;

  if (!workspaces.isSuccess) {
    return (
      <Page>
        {workspaces.isError ? (
          <ErrorBanner
            message="Couldn't load workspaces"
            onRetry={() => void workspaces.refetch()}
          />
        ) : (
          <Skeleton lines={8} />
        )}
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Material"
        subtitle="Author and compare immutable workspace content."
        actions={
          workspaceId ? (
            <Button onPress={() => setShowNew(true)} isDisabled={create.isPending || disconnected}>
              New Material
            </Button>
          ) : undefined
        }
      />
      <MaterialSurfaceBody
        workspaceId={workspaceId}
        materials={materials.data}
        selectedMaterialId={selectedMaterialId}
        routeMaterialId={routeMaterialId}
        threadId={threadId}
        onSelect={(id) => navigate(`/materials/${threadId}/${id}`)}
        create={create}
        showNew={showNew}
        disconnected={disconnected}
        materialsLoading={materials.isLoading}
        materialsError={materials.isError}
        onRetryMaterials={() => void materials.refetch()}
        onNew={() => setShowNew(true)}
        onCancel={() => setShowNew(false)}
      />
      {workspaceId ? (
        <ThreadMaterialPanel
          workspaceId={workspaceId}
          threadId={threadId}
          materialId={selectedMaterialId}
        />
      ) : null}
    </Page>
  );
}

/**
 * Renders the Material list and creation/details state within one route.
 *
 * @param props Material read state and registered route context.
 * @param props.threadId Exact Thread from the registered Material route.
 * @returns The selected Material surface state.
 */
function MaterialSurfaceBody({
  workspaceId,
  materials,
  selectedMaterialId,
  routeMaterialId,
  threadId,
  onSelect,
  create,
  showNew,
  disconnected,
  materialsLoading,
  materialsError,
  onRetryMaterials,
  onNew,
  onCancel,
}: {
  workspaceId: string | null;
  materials: WorkspaceMaterial[] | undefined;
  selectedMaterialId: string | null;
  routeMaterialId: string | undefined;
  threadId: string;
  onSelect: (materialId: string) => void;
  create: ReturnType<typeof useCreateWorkspaceMaterial>;
  showNew: boolean;
  disconnected: boolean;
  materialsLoading: boolean;
  materialsError: boolean;
  onRetryMaterials: () => void;
  onNew: () => void;
  onCancel: () => void;
}) {
  if (!workspaceId) return <EmptyState icon="file" title="Choose a Workspace first" />;
  if (routeMaterialId && !materials) {
    return (
      <>
        <section aria-label="Material editor" className="min-w-0">
          <MaterialDetail
            workspaceId={workspaceId}
            materialId={routeMaterialId}
            threadId={threadId}
            disconnected={disconnected}
          />
        </section>
        {materialsLoading ? (
          <Skeleton lines={5} />
        ) : (
          <ErrorBanner message="Couldn't load Workspace Materials." onRetry={onRetryMaterials} />
        )}
      </>
    );
  }
  if (materialsLoading && !materials) return <Skeleton lines={5} />;
  if (!materials) {
    return <ErrorBanner message="Couldn't load Workspace Materials." onRetry={onRetryMaterials} />;
  }

  const listedMaterials = materials;
  const newMaterialForm = showNew ? (
    <NewMaterialForm
      isPending={create.isPending}
      disconnected={disconnected}
      createError={create.isError}
      onCancel={onCancel}
      onCreate={(input) =>
        create.mutate(input, {
          onSuccess: ({ materialId }) => {
            onCancel();
            onSelect(materialId);
          },
        })
      }
    />
  ) : null;

  if (listedMaterials.length === 0 && !routeMaterialId) {
    return (
      <>
        {newMaterialForm ?? (
          <EmptyState
            icon="file"
            title="Create your first Material"
            hint="Saved content stays in the Workspace until you explicitly save a revision."
            action={
              <Button onPress={onNew} isDisabled={disconnected}>
                New Material
              </Button>
            }
          />
        )}
        {materialsError ? (
          <ErrorBanner
            message="The Material list could not be refreshed."
            onRetry={onRetryMaterials}
          />
        ) : null}
      </>
    );
  }

  if (listedMaterials.length === 0 && routeMaterialId) {
    return (
      <>
        {newMaterialForm}
        <section aria-label="Material editor" className="min-w-0">
          <MaterialDetail
            workspaceId={workspaceId}
            materialId={routeMaterialId}
            threadId={threadId}
            disconnected={disconnected}
          />
        </section>
        {materialsError ? (
          <ErrorBanner
            message="The Material list could not be refreshed."
            onRetry={onRetryMaterials}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {newMaterialForm}
      <div className="grid min-h-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Card>
          <Eyebrow>Workspace Materials</Eyebrow>
          <div className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto">
            {listedMaterials.map((material) => (
              <Button
                key={material.materialId}
                size="sm"
                variant={material.materialId === selectedMaterialId ? 'outline' : 'quiet'}
                className="justify-start rounded-ok text-left"
                onPress={() => onSelect(material.materialId)}
              >
                <span className="truncate">{material.title}</span>
              </Button>
            ))}
          </div>
        </Card>
        <section aria-label="Material editor" className="min-w-0">
          {selectedMaterialId ? (
            <MaterialDetail
              key={selectedMaterialId}
              workspaceId={workspaceId}
              materialId={selectedMaterialId}
              threadId={threadId}
              disconnected={disconnected}
            />
          ) : null}
        </section>
      </div>
      {materialsError ? (
        <ErrorBanner
          message="The Material list could not be refreshed."
          onRetry={onRetryMaterials}
        />
      ) : null}
      {routeMaterialId &&
      !listedMaterials.some((material) => material.materialId === routeMaterialId) ? (
        <p className="text-xs text-fg-muted">
          The named Material is not in the current list; its server record is shown if available.
        </p>
      ) : null}
    </>
  );
}
