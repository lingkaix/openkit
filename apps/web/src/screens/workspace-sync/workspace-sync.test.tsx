import {
  BackendWorkspaceHandleSchema,
  StagedWorkspaceReviewSchema,
  WorkerOutputManifestSchema,
  WorkspaceApplyPlanSchema,
  WorkspaceApplyResultSchema,
  WorkspaceChangeSetSchema,
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
  WorkspaceQuarantineRecordSchema,
  WorkspaceReconciliationRecordSchema,
  WorkspaceSyncReviewItemSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { ArtifactSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, matchPath, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { AppRoutes } from '../../app/routes';
import { SURFACES, surfaceById } from '../../app/surfaces';
import { useWorkspaceStore } from '../workspace-store';

const TIMESTAMP = '2026-07-21T12:00:00.000Z';
const HOST_PATH = '/Users/secret/openkit-staging';
const RAW_HANDLE = 'sandbox-pid-9999-gateway-xyz';
const POISON_SECRET = 'sk-secret-should-never-render';
const WORKSPACE = { id: 'ws1', name: 'Market research', kind: 'general' } as const;
const WORKSPACE_B = { id: 'ws2', name: 'Second workspace', kind: 'general' } as const;
const QUICK_CHAT_WORKSPACE = {
  id: 'ws_quick_chat',
  name: 'Quick Chat',
  kind: 'quick-chat',
} as const;
const EVIDENCE_BUNDLE_ID = 'evb_wrr_1';
const PENDING_PATCH_TEXT = 'diff --git a/docs/spec.md b/docs/spec.md\n';

/**
 * Counts unified-diff hunk additions and deletions using the NanoCore
 * `workspaceDiffSummary` rule: +/- lines after `@@ ` until the next `diff --git`.
 */
function countPatchHunkEdits(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let insideHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      insideHunk = false;
    } else if (line.startsWith('@@ ')) {
      insideHunk = true;
    } else if (insideHunk && line.startsWith('+')) {
      additions += 1;
    } else if (insideHunk && line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

const PENDING_PATCH_STATS = countPatchHunkEdits(PENDING_PATCH_TEXT);

const INPUT_SNAPSHOT = WorkspaceInputSnapshotSchema.parse({
  id: 'wis_1',
  workspaceId: WORKSPACE.id,
  resourceId: 'default',
  resourceKind: 'git_repository',
  strategy: 'git',
  pathScope: ['docs'],
  writableRoots: ['docs'],
  ignoredPaths: [],
  generatedFiles: [],
  base: { commit: 'abc123', contentDigest: null },
  backend: {
    kind: 'openshell',
    label: 'OpenShell',
    capabilitySummary: ['git-materialization'],
  },
  createdAt: TIMESTAMP,
});

const MATERIALIZATION = WorkspaceMaterializationRecordSchema.parse({
  id: 'wmr_1',
  inputSnapshotId: INPUT_SNAPSHOT.id,
  workspaceId: WORKSPACE.id,
  backendKind: 'openshell',
  packageSnapshotId: 'aepsnap_1',
  workerSessionId: 'session_1',
  strategy: 'git',
  materializedRootRef: HOST_PATH,
  base: { commit: 'abc123', contentDigest: null },
  policyDigest: 'sha256:policy',
  readinessEvidence: [],
  createdAt: TIMESTAMP,
});

const BACKEND_HANDLE = BackendWorkspaceHandleSchema.parse({
  id: 'bwh_wmr_1',
  workspaceId: WORKSPACE.id,
  materializationRecordId: MATERIALIZATION.id,
  backendKind: 'openshell',
  packageSnapshotId: 'aepsnap_1',
  workerSessionId: 'session_1',
  transportRefs: [
    { kind: 'host-path', ref: HOST_PATH },
    { kind: 'runtime', ref: RAW_HANDLE },
  ],
  cleanupStatus: 'pending',
  retention: 'until-reconciliation',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const OUTPUT_MANIFEST = WorkerOutputManifestSchema.parse({
  id: 'wom_1',
  workspaceId: WORKSPACE.id,
  materializationRecordId: MATERIALIZATION.id,
  inputSnapshotId: INPUT_SNAPSHOT.id,
  workerSessionId: 'session_1',
  backendKind: 'openshell',
  strategy: 'git',
  changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
  artifactIds: ['ar_workspace_changes_1'],
  logRefs: [],
  testOutputRefs: [],
  ignoredOutputs: [],
  evidenceRefs: [],
  collectedAt: TIMESTAMP,
});

const CHANGE_SET = WorkspaceChangeSetSchema.parse({
  id: 'wcs_1',
  materializationRecordId: MATERIALIZATION.id,
  inputSnapshotId: INPUT_SNAPSHOT.id,
  workspaceId: WORKSPACE.id,
  resourceId: 'default',
  strategy: 'git',
  base: { commit: 'abc123', contentDigest: null },
  head: { commit: 'def456', contentDigest: null },
  changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
  patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: PENDING_PATCH_TEXT.length },
  bundle: null,
  artifactIds: ['ar_workspace_changes_1'],
  evidenceRefs: [{ kind: 'worker', ref: 'turn_demo' }],
  redaction: { status: 'redacted', notes: [] },
  createdAt: TIMESTAMP,
});

const PENDING_STAGED_REVIEW = StagedWorkspaceReviewSchema.parse({
  id: 'swr_pending',
  changeSetId: CHANGE_SET.id,
  workspaceId: WORKSPACE.id,
  status: 'pending',
  staging: {
    strategy: 'git_worktree',
    ref: 'staging://workspace/wcs_1',
    branch: 'openkit/review/swr_pending',
  },
  diffSummary: {
    filesChanged: CHANGE_SET.changedPaths.length,
    additions: PENDING_PATCH_STATS.additions,
    deletions: PENDING_PATCH_STATS.deletions,
  },
  riskSummary: '1 changed path staged for human review.',
  validation: [{ command: 'worker', status: 'passed', ref: 'turn_demo' }],
  actionCenterRowId: 'workspace-review:swr_pending',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const REJECTED_STAGED_REVIEW = StagedWorkspaceReviewSchema.parse({
  ...PENDING_STAGED_REVIEW,
  id: 'swr_rejected',
  status: 'rejected',
  staging: {
    ...PENDING_STAGED_REVIEW.staging,
    branch: 'openkit/review/swr_rejected',
  },
  actionCenterRowId: 'workspace-review:swr_rejected',
});

const PENDING_REVIEW = WorkspaceSyncReviewItemSchema.parse({
  artifactId: 'ar_workspace_changes_1',
  changeSet: CHANGE_SET,
  patchPayload: {
    mediaType: 'text/x-diff',
    text: PENDING_PATCH_TEXT,
    digest: 'sha256:patch',
    bytes: PENDING_PATCH_TEXT.length,
  },
  review: PENDING_STAGED_REVIEW,
});

const REJECTED_REVIEW = WorkspaceSyncReviewItemSchema.parse({
  ...PENDING_REVIEW,
  artifactId: 'ar_workspace_changes_rejected',
  review: REJECTED_STAGED_REVIEW,
});

const ACCEPTED_REVIEW = WorkspaceSyncReviewItemSchema.parse({
  ...PENDING_REVIEW,
  review: { ...PENDING_STAGED_REVIEW, status: 'accepted' },
});

const APPLY_PLAN = WorkspaceApplyPlanSchema.parse({
  id: 'wap_swr_1',
  workspaceId: WORKSPACE.id,
  reviewId: PENDING_STAGED_REVIEW.id,
  changeSetId: CHANGE_SET.id,
  strategy: 'git',
  approvalState: 'approved',
  plannedWrites: ['docs/spec.md'],
  baselineChecks: [{ command: 'git apply --check', status: 'passed', ref: null }],
  pathConflicts: [],
  binaryRisks: [],
  permissionChanges: [],
  policyChecks: [{ command: 'workspace review accepted', status: 'passed', ref: null }],
  createdAt: TIMESTAMP,
});

const APPLY_RESULT = WorkspaceApplyResultSchema.parse({
  id: 'war_swr_1',
  workspaceId: WORKSPACE.id,
  reviewId: PENDING_STAGED_REVIEW.id,
  changeSetId: CHANGE_SET.id,
  status: 'applied',
  appliedPaths: ['docs/spec.md'],
  skippedPaths: [],
  conflictRecords: [],
  verification: [{ command: 'git apply --check', status: 'passed', ref: null }],
  commitIds: [],
  appliedAt: TIMESTAMP,
});

const RECOVERY_RECORD = WorkspaceReconciliationRecordSchema.parse({
  id: 'wrr_1',
  workspaceId: WORKSPACE.id,
  triggerReason: 'restart',
  affectedRecordIds: [MATERIALIZATION.id, BACKEND_HANDLE.id],
  backendHandleSummary: {
    backendKind: 'openshell',
    handleId: BACKEND_HANDLE.id,
    hostPath: HOST_PATH,
    runtimeHandle: RAW_HANDLE,
  },
  backendReachability: { status: 'unavailable', checkedAt: TIMESTAMP, detail: null },
  collectedOutputManifestIds: [OUTPUT_MANIFEST.id],
  evidenceBundleIds: [EVIDENCE_BUNDLE_ID],
  stateBefore: 'ready',
  stateAfter: 'requires-human',
  quarantineRefs: [],
  requiredHumanDecision: 'inspect_recovery',
  retentionDecision: 'retain-backend',
  startedAt: TIMESTAMP,
  finishedAt: null,
});

const RECOVERED_RECORD = WorkspaceReconciliationRecordSchema.parse({
  ...RECOVERY_RECORD,
  stateBefore: 'requires-human',
  stateAfter: 'recovered',
  requiredHumanDecision: null,
  retentionDecision: 'teardown-backend',
  finishedAt: TIMESTAMP,
});

const PENDING_STAGED_REVIEW_B = StagedWorkspaceReviewSchema.parse({
  ...PENDING_STAGED_REVIEW,
  id: 'swr_pending_b',
  actionCenterRowId: 'workspace-review:swr_pending_b',
});

const PENDING_REVIEW_B = WorkspaceSyncReviewItemSchema.parse({
  ...PENDING_REVIEW,
  artifactId: 'ar_workspace_changes_b',
  review: PENDING_STAGED_REVIEW_B,
});

const RECOVERY_RECORD_B = WorkspaceReconciliationRecordSchema.parse({
  ...RECOVERY_RECORD,
  id: 'wrr_2',
});

const QUARANTINE_RECORD = WorkspaceQuarantineRecordSchema.parse({
  id: 'wqr_1',
  workspaceId: WORKSPACE.id,
  lifecycleRecordIds: [RECOVERY_RECORD.id, OUTPUT_MANIFEST.id],
  failureKind: 'digest_mismatch',
  storageRef: 'quarantine/workspace-sync/wqr_1',
  retentionClass: 'restricted-evidence',
  requiredHumanDecision: 'inspect_quarantined_output',
  resolution: 'pending',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  resolvedAt: null,
});

const PREVIEW_PATCH_TEXT = [
  'diff --git a/docs/brief.md b/docs/overview.md',
  'similarity index 80%',
  'rename from docs/brief.md',
  'rename to docs/overview.md',
  '--- a/docs/brief.md',
  '+++ b/docs/overview.md',
  '@@ -1,2 +1,3 @@',
  ' # Brief',
  '-Draft overview',
  '+Published overview',
  '+Reviewed by sync',
  'diff --git a/assets/chart.png b/assets/chart.png',
  'index 1111111..2222222 100644',
  'GIT binary patch',
  'delta 2048',
  'diff --git a/scripts/run.sh b/scripts/run.sh',
  'old mode 100644',
  'new mode 100755',
  '',
].join('\n');
const PREVIEW_PATCH_STATS = countPatchHunkEdits(PREVIEW_PATCH_TEXT);
const PREVIEW_ARTIFACT_BODY = 'Exact workspace preview artifact body for inspection.';

const PREVIEW_CHANGE_SET = WorkspaceChangeSetSchema.parse({
  ...CHANGE_SET,
  id: 'wcs_preview',
  artifactIds: ['ar_workspace_preview_1'],
  changedPaths: [
    {
      path: 'docs/overview.md',
      oldPath: 'docs/brief.md',
      status: 'renamed',
      binary: false,
    },
    {
      path: 'assets/chart.png',
      status: 'modified',
      binary: true,
      size: 2048,
      digest: 'sha256:chart',
      mediaType: 'image/png',
      binaryReview: {
        mode: 'artifact-only',
        reason: 'binary-path',
        summary: 'Binary workspace change requires artifact review.',
        digest: 'sha256:chart',
        mediaType: 'image/png',
        bytes: 2048,
      },
    },
    {
      path: 'scripts/run.sh',
      status: 'mode_changed',
      binary: false,
      oldPermissions: '0644',
      newPermissions: '0755',
    },
  ],
  patch: {
    ref: 'artifact://patch/preview',
    digest: 'sha256:preview-patch',
    bytes: PREVIEW_PATCH_TEXT.length,
  },
});

const PREVIEW_STAGED_REVIEW = StagedWorkspaceReviewSchema.parse({
  ...PENDING_STAGED_REVIEW,
  id: 'swr_preview',
  changeSetId: PREVIEW_CHANGE_SET.id,
  diffSummary: {
    filesChanged: PREVIEW_CHANGE_SET.changedPaths.length,
    additions: PREVIEW_PATCH_STATS.additions,
    deletions: PREVIEW_PATCH_STATS.deletions,
  },
  riskSummary: `${PREVIEW_CHANGE_SET.changedPaths.length} changed paths staged for human review.`,
  staging: {
    ...PENDING_STAGED_REVIEW.staging,
    branch: 'openkit/review/swr_preview',
  },
  actionCenterRowId: 'workspace-review:swr_preview',
});

const PREVIEW_REVIEW = WorkspaceSyncReviewItemSchema.parse({
  ...PENDING_REVIEW,
  artifactId: 'ar_workspace_preview_1',
  changeSet: PREVIEW_CHANGE_SET,
  patchPayload: {
    mediaType: 'text/x-diff',
    text: PREVIEW_PATCH_TEXT,
    digest: 'sha256:preview-patch',
    bytes: PREVIEW_PATCH_TEXT.length,
  },
  review: PREVIEW_STAGED_REVIEW,
});

const PREVIEW_ARTIFACT = ArtifactSchema.parse({
  id: PREVIEW_REVIEW.artifactId,
  workspaceId: WORKSPACE.id,
  threadId: 'th_workspace_preview',
  turnId: 'tu_workspace_preview',
  kind: 'diff',
  title: 'Workspace preview patch',
  status: 'ready',
  summary: PREVIEW_STAGED_REVIEW.riskSummary,
  version: 1,
  content: { format: 'text', body: PREVIEW_ARTIFACT_BODY },
  contentDigest: `sha256:${'c'.repeat(64)}`,
  lastMutationRequestId: 'req_workspace_preview',
  origin: {
    kind: 'turn-output',
    threadId: 'th_workspace_preview',
    turnId: 'tu_workspace_preview',
    requestId: 'req_workspace_preview',
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const QUARANTINED_RECORD = WorkspaceReconciliationRecordSchema.parse({
  ...RECOVERY_RECORD,
  stateBefore: 'requires-human',
  stateAfter: 'quarantined',
  requiredHumanDecision: null,
  retentionDecision: 'teardown-backend',
  finishedAt: TIMESTAMP,
});

const UNRECOVERABLE_RECORD = WorkspaceReconciliationRecordSchema.parse({
  ...RECOVERY_RECORD,
  stateBefore: 'requires-human',
  stateAfter: 'unrecoverable',
  requiredHumanDecision: null,
  retentionDecision: 'teardown-backend',
  finishedAt: TIMESTAMP,
});

type AppOverrides = Partial<CoreClient['app']>;
type CoreOverrides = Partial<CoreClient['core']>;

/** Creates a caller-controlled promise for proving pre-settlement UI state. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(app: AppOverrides = {}, core: CoreOverrides = {}): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE] }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      ...core,
    },
    app: {
      listAuthorizedWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      listWorkspaceSyncReviews: vi
        .fn()
        .mockResolvedValue({ items: [PENDING_REVIEW, REJECTED_REVIEW] }),
      getWorkspaceSyncReview: vi.fn().mockResolvedValue(PENDING_REVIEW),
      submitWorkspaceSyncReviewDecision: vi.fn(),
      listWorkspaceInputSnapshots: vi.fn().mockResolvedValue({ items: [INPUT_SNAPSHOT] }),
      listWorkspaceMaterializationRecords: vi.fn().mockResolvedValue({ items: [MATERIALIZATION] }),
      listBackendWorkspaceHandles: vi.fn().mockResolvedValue({ items: [BACKEND_HANDLE] }),
      listWorkerOutputManifests: vi.fn().mockResolvedValue({ items: [OUTPUT_MANIFEST] }),
      listWorkspaceChangeSets: vi.fn().mockResolvedValue({ items: [CHANGE_SET] }),
      listStagedWorkspaceReviews: vi
        .fn()
        .mockResolvedValue({ items: [PENDING_STAGED_REVIEW, REJECTED_STAGED_REVIEW] }),
      listWorkspaceApplyPlans: vi.fn().mockResolvedValue({ items: [APPLY_PLAN] }),
      listWorkspaceApplyResults: vi.fn().mockResolvedValue({ items: [APPLY_RESULT] }),
      getWorkspaceApplyResult: vi.fn().mockResolvedValue(APPLY_RESULT),
      listWorkspaceReconciliationRecords: vi.fn().mockResolvedValue({ items: [RECOVERY_RECORD] }),
      listWorkspaceQuarantineRecords: vi.fn().mockResolvedValue({ items: [QUARANTINE_RECORD] }),
      submitWorkspaceRecoveryDecision: vi.fn(),
      ...app,
    },
  } as unknown as CoreClient;
}

function LocationProbe({ onChange }: { onChange: (pathname: string) => void }) {
  const location = useLocation();
  onChange(location.pathname);
  return null;
}

function renderApp(path: string, client: CoreClient, onLocation?: (pathname: string) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          {onLocation ? <LocationProbe onChange={onLocation} /> : null}
          {children}
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return client;
}

function syncCalls(client: CoreClient) {
  return {
    listReviews: vi.mocked(client.app.listWorkspaceSyncReviews).mock.calls,
    getReview: vi.mocked(client.app.getWorkspaceSyncReview).mock.calls,
    submitDecision: vi.mocked(client.app.submitWorkspaceSyncReviewDecision).mock.calls,
    listSnapshots: vi.mocked(client.app.listWorkspaceInputSnapshots).mock.calls,
    listMaterializations: vi.mocked(client.app.listWorkspaceMaterializationRecords).mock.calls,
    listHandles: vi.mocked(client.app.listBackendWorkspaceHandles).mock.calls,
    listManifests: vi.mocked(client.app.listWorkerOutputManifests).mock.calls,
    listChangeSets: vi.mocked(client.app.listWorkspaceChangeSets).mock.calls,
    listStaged: vi.mocked(client.app.listStagedWorkspaceReviews).mock.calls,
    listPlans: vi.mocked(client.app.listWorkspaceApplyPlans).mock.calls,
    listResults: vi.mocked(client.app.listWorkspaceApplyResults).mock.calls,
    getResult: vi.mocked(client.app.getWorkspaceApplyResult).mock.calls,
    listRecovery: vi.mocked(client.app.listWorkspaceReconciliationRecords).mock.calls,
    listQuarantine: vi.mocked(client.app.listWorkspaceQuarantineRecords).mock.calls,
    submitRecovery: vi.mocked(client.app.submitWorkspaceRecoveryDecision).mock.calls,
  };
}

function expectNoRecoveryDecisionActions(recovery: HTMLElement) {
  expect(within(recovery).queryByRole('button', { name: /Resume collection/i })).toBeNull();
  expect(within(recovery).queryByRole('button', { name: /Stage verified/i })).toBeNull();
  expect(within(recovery).queryByRole('button', { name: /Quarantine/i })).toBeNull();
  expect(within(recovery).queryByRole('button', { name: /Abandon/i })).toBeNull();
}

/** Collects accessible and ancestor text that can associate one recovery decision control. */
function decisionAssociationTexts(button: HTMLElement, limit: HTMLElement): string[] {
  const texts: string[] = [];
  const describedBy = button.getAttribute('aria-describedby');
  if (describedBy) {
    for (const id of describedBy.split(/\s+/)) {
      const node = document.getElementById(id);
      if (node) texts.push(node.textContent ?? '');
    }
  }
  texts.push(button.getAttribute('aria-description') ?? '');
  texts.push(button.getAttribute('title') ?? '');
  let current: HTMLElement | null = button;
  while (current && current !== limit) {
    texts.push(current.textContent ?? '');
    current = current.parentElement;
  }
  return texts;
}

/** Requires one recovery decision to own its terminal outcome and teardown/evidence effects. */
function expectAssociatedRecoveryDecisionPreview(
  recovery: HTMLElement,
  buttonName: string,
  stateLabel: string,
  otherStateLabels: readonly string[]
) {
  const button = within(recovery).getByRole('button', { name: buttonName });
  const isolated = (text: string) =>
    text.includes(stateLabel) && otherStateLabels.every((other) => !text.includes(other));
  const associated = decisionAssociationTexts(button, recovery).find(isolated);
  expect(associated).toBeTruthy();
  const globalTeardownAndEvidence =
    /every (?:listed )?(?:recovery )?decision[\s\S]{0,200}(?:tears down|teardown)[\s\S]{0,80}backend[\s\S]{0,200}retain(?:s|ed)?[\s\S]{0,80}evidence/i.test(
      recovery.textContent ?? ''
    );
  const scopedEffects = decisionAssociationTexts(button, recovery).find(
    (text) =>
      isolated(text) &&
      /teardown[ -]backend/i.test(text) &&
      /retain(?:s|ed)?[\s\S]{0,80}evidence/i.test(text) &&
      text.includes(EVIDENCE_BUNDLE_ID) &&
      text.includes(OUTPUT_MANIFEST.id)
  );
  expect(Boolean(globalTeardownAndEvidence || scopedEffects)).toBe(true);
  if (!buttonName.startsWith('Abandon ')) {
    expect(
      Array.from(recovery.querySelectorAll('p')).find((preview) => {
        const text = preview.textContent ?? '';
        return (
          isolated(text) &&
          /teardown[ -]backend/i.test(text) &&
          /retain(?:s|ed)?[\s\S]{0,80}evidence/i.test(text) &&
          text.includes(EVIDENCE_BUNDLE_ID) &&
          text.includes(OUTPUT_MANIFEST.id)
        );
      })
    ).toBeVisible();
  }
}

/** Returns whether a pathname matches a live cataloged surface, including parameterized routes. */
function isRegisteredLivePath(pathname: string): boolean {
  return SURFACES.some(
    (surface) =>
      isSurfaceLive(surface) && matchPath({ path: surface.path, end: true }, pathname) != null
  );
}

function changedPathRow(region: HTMLElement, path: string, requiredTexts: string[]): HTMLElement {
  const pathNode = within(region).getByText(path, { exact: true });
  const otherPaths = PREVIEW_CHANGE_SET.changedPaths
    .map((entry) => entry.path)
    .filter((candidate) => candidate !== path);
  let current: HTMLElement | null = pathNode;
  while (current && current !== region) {
    const text = current.textContent ?? '';
    const hasRequired = requiredTexts.every((item) => text.includes(item));
    const isolated = otherPaths.every((other) => !text.includes(other));
    if (hasRequired && isolated) return current;
    current = current.parentElement;
  }
  throw new Error(`No scoped changed-path row for ${path}`);
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Workspace changes', () => {
  it('is a reachable selected-Workspace surface that projects every Sync collection as summaries', async () => {
    const surface = surfaceById('workspace-changes');
    expect(surface).toMatchObject({
      title: 'Workspace changes',
      path: '/workspace-changes',
      tier: 'A',
      nav: 'workspace-compact',
    });
    expect(isSurfaceLive(surface!)).toBe(true);

    const client = makeClient();
    renderApp('/workspace-changes', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Workspace changes' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't exist/i)).not.toBeInTheDocument();

    const destinations = await screen.findByRole('group', { name: 'Workspace destinations' });
    const navButton = screen.getByRole('button', { name: 'Workspace changes' });
    expect(destinations).toContainElement(navButton);

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.id)).toBeInTheDocument();
    expect(within(reviews).getByText(CHANGE_SET.id)).toBeInTheDocument();
    expect(within(reviews).getByText(PENDING_REVIEW.artifactId)).toBeInTheDocument();
    expect(within(reviews).getByText('docs/spec.md')).toBeInTheDocument();
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    expect(within(reviews).getByText('Pending', { exact: true })).toBeInTheDocument();
    expect(
      within(reviews).getAllByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).toHaveLength(1);
    expect(
      within(reviews).getAllByRole('button', { name: `Refine ${PENDING_STAGED_REVIEW.id}` })
    ).toHaveLength(1);
    expect(
      within(reviews).getAllByRole('button', { name: `Reject ${PENDING_STAGED_REVIEW.id}` })
    ).toHaveLength(1);
    expect(
      within(reviews).getAllByRole('button', { name: `Block ${PENDING_STAGED_REVIEW.id}` })
    ).toHaveLength(1);
    expect(within(reviews).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(reviews).getByText('Rejected', { exact: true })).toBeInTheDocument();

    expect(screen.getByRole('region', { name: 'Input snapshots' })).toHaveTextContent(/git/i);
    expect(screen.getByRole('region', { name: 'Materializations' })).toHaveTextContent(
      /openshell/i
    );
    expect(screen.getByRole('region', { name: 'Backend handles' })).toHaveTextContent(/pending/i);
    expect(screen.getByRole('region', { name: 'Worker outputs' })).toHaveTextContent(
      'docs/spec.md'
    );
    expect(screen.getByRole('region', { name: 'Change sets' })).toHaveTextContent('docs/spec.md');
    expect(screen.getByRole('region', { name: 'Staged reviews' })).toHaveTextContent(/pending/i);
    expect(screen.getByRole('region', { name: 'Apply plans' })).toHaveTextContent(/approved/i);
    expect(screen.getByRole('region', { name: 'Apply results' })).toHaveTextContent(/applied/i);

    const recovery = screen.getByRole('region', { name: 'Recovery' });
    expect(within(recovery).getByText(RECOVERY_RECORD.id)).toBeInTheDocument();
    expect(within(recovery).getByText('Requires human', { exact: true })).toBeInTheDocument();
    expect(within(recovery).getByText(/unavailable/i)).toBeInTheDocument();
    expect(within(recovery).getByText(OUTPUT_MANIFEST.id)).toBeInTheDocument();
    expect(within(recovery).getByText(EVIDENCE_BUNDLE_ID)).toBeInTheDocument();
    expect(within(recovery).getByText(MATERIALIZATION.id)).toBeInTheDocument();
    expect(within(recovery).getByText(BACKEND_HANDLE.id)).toBeInTheDocument();
    expect(within(recovery).getByText(RECOVERY_RECORD.requiredHumanDecision!)).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', {
        name: `Resume collection ${RECOVERY_RECORD.id}`,
      })
    ).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', { name: `Stage verified ${RECOVERY_RECORD.id}` })
    ).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', { name: `Quarantine ${RECOVERY_RECORD.id}` })
    ).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', { name: `Abandon ${RECOVERY_RECORD.id}` })
    ).toBeInTheDocument();
    expect(within(recovery).queryByRole('button', { name: 'Resume collection' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Quarantine' })).toHaveTextContent(
      /digest mismatch/i
    );

    expect(
      screen.queryByRole('button', { name: /listWorkspace|getWorkspace|submitWorkspace/i })
    ).toBeNull();
    const serializedDom = document.documentElement.outerHTML;
    expect(serializedDom).not.toContain(HOST_PATH);
    expect(serializedDom).not.toContain(RAW_HANDLE);
    expect(serializedDom).not.toContain(POISON_SECRET);
    expect(serializedDom).not.toMatch(/"items"\s*:/);

    await waitFor(() => {
      expect(syncCalls(client)).toEqual({
        listReviews: [[WORKSPACE.id]],
        getReview: [[WORKSPACE.id, PENDING_STAGED_REVIEW.id]],
        submitDecision: [],
        listSnapshots: [[WORKSPACE.id]],
        listMaterializations: [[WORKSPACE.id]],
        listHandles: [[WORKSPACE.id]],
        listManifests: [[WORKSPACE.id]],
        listChangeSets: [[WORKSPACE.id]],
        listStaged: [[WORKSPACE.id]],
        listPlans: [[WORKSPACE.id]],
        listResults: [[WORKSPACE.id]],
        getResult: [[WORKSPACE.id, APPLY_RESULT.id]],
        listRecovery: [[WORKSPACE.id]],
        listQuarantine: [[WORKSPACE.id]],
        submitRecovery: [],
      });
    });
  });

  it('submits one accepted review decision and refetches authoritative rows', async () => {
    const user = userEvent.setup();
    const listWorkspaceSyncReviews = vi
      .fn()
      .mockResolvedValueOnce({ items: [PENDING_REVIEW, REJECTED_REVIEW] })
      .mockResolvedValue({ items: [ACCEPTED_REVIEW, REJECTED_REVIEW] });
    const submitWorkspaceSyncReviewDecision = vi.fn().mockResolvedValue({
      review: ACCEPTED_REVIEW.review,
      workspaceApplyResult: APPLY_RESULT,
    });
    const client = makeClient({ listWorkspaceSyncReviews, submitWorkspaceSyncReviewDecision });
    renderApp('/workspace-changes', client);

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    await user.click(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    );

    await waitFor(() => expect(submitWorkspaceSyncReviewDecision).toHaveBeenCalledTimes(1));
    const requestId = submitWorkspaceSyncReviewDecision.mock.calls[0]?.[2].requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(submitWorkspaceSyncReviewDecision.mock.calls).toEqual([
      [WORKSPACE.id, PENDING_STAGED_REVIEW.id, { decision: 'accepted', requestId }],
    ]);
    await waitFor(() => expect(listWorkspaceSyncReviews).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Accepted', { exact: true })).toBeInTheDocument();
    expect(
      within(reviews).queryByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).toBeNull();
    expect(client.app.submitWorkspaceRecoveryDecision).not.toHaveBeenCalled();
  });

  it('submits one recovery decision and refetches authoritative rows', async () => {
    const user = userEvent.setup();
    const listWorkspaceReconciliationRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [RECOVERY_RECORD] })
      .mockResolvedValue({ items: [RECOVERED_RECORD] });
    const submitWorkspaceRecoveryDecision = vi.fn().mockResolvedValue({
      reconciliationRecord: RECOVERED_RECORD,
    });
    const client = makeClient({
      listWorkspaceReconciliationRecords,
      submitWorkspaceRecoveryDecision,
    });
    renderApp('/workspace-changes', client);

    const recovery = await screen.findByRole('region', { name: 'Recovery' });
    expectAssociatedRecoveryDecisionPreview(
      recovery,
      `Resume collection ${RECOVERY_RECORD.id}`,
      'Recovered',
      ['Quarantined', 'Unrecoverable']
    );
    expect(submitWorkspaceRecoveryDecision).not.toHaveBeenCalled();
    await user.click(
      within(recovery).getByRole('button', { name: `Resume collection ${RECOVERY_RECORD.id}` })
    );

    await waitFor(() => expect(submitWorkspaceRecoveryDecision).toHaveBeenCalledTimes(1));
    const requestId = submitWorkspaceRecoveryDecision.mock.calls[0]?.[2].requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(submitWorkspaceRecoveryDecision.mock.calls).toEqual([
      [WORKSPACE.id, RECOVERY_RECORD.id, { decision: 'resume_collection', requestId }],
    ]);
    await waitFor(() => expect(listWorkspaceReconciliationRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Recovered', { exact: true })).toBeInTheDocument();
    expectNoRecoveryDecisionActions(recovery);
    expect(client.app.submitWorkspaceSyncReviewDecision).not.toHaveBeenCalled();
  });

  it('preserves authoritative rows and offers safe retry after a typed review failure', async () => {
    const user = userEvent.setup();
    const submitWorkspaceSyncReviewDecision = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'workspace-sync-private failure', { code: 'recovery_required' })
      );
    const client = makeClient({ submitWorkspaceSyncReviewDecision });
    renderApp('/workspace-changes', client);

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    await user.click(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Recovery required', { exact: true })).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('workspace-sync-private failure');
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    expect(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).toBeInTheDocument();
    expect(submitWorkspaceSyncReviewDecision).toHaveBeenCalledTimes(1);

    const readsBeforeRetry = vi.mocked(client.app.listWorkspaceSyncReviews).mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(vi.mocked(client.app.listWorkspaceSyncReviews)).toHaveBeenCalledTimes(
        readsBeforeRetry + 1
      )
    );
    expect(submitWorkspaceSyncReviewDecision).toHaveBeenCalledTimes(1);
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    expect(document.documentElement.outerHTML).not.toContain(HOST_PATH);
    expect(document.documentElement.outerHTML).not.toContain(POISON_SECRET);
  });

  it('does not publish Workspace changes or call Sync APIs for Quick Chat', async () => {
    const surface = surfaceById('workspace-changes');
    expect(surface).toMatchObject({
      title: 'Workspace changes',
      path: '/workspace-changes',
      tier: 'A',
      nav: 'workspace-compact',
    });

    const client = makeClient(
      {},
      { listWorkspaces: vi.fn().mockResolvedValue({ items: [QUICK_CHAT_WORKSPACE] }) }
    );
    renderApp('/workspace-changes', client);

    expect(await screen.findByText(QUICK_CHAT_WORKSPACE.name, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace changes' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Workspace changes' })
    ).not.toBeInTheDocument();
    expect(syncCalls(client)).toEqual({
      listReviews: [],
      getReview: [],
      submitDecision: [],
      listSnapshots: [],
      listMaterializations: [],
      listHandles: [],
      listManifests: [],
      listChangeSets: [],
      listStaged: [],
      listPlans: [],
      listResults: [],
      getResult: [],
      listRecovery: [],
      listQuarantine: [],
      submitRecovery: [],
    });
  });

  it('binds mutation, pending, and error state to the selected workspaceId', async () => {
    const user = userEvent.setup();
    const workspaceADecision = createDeferred<{
      review: typeof ACCEPTED_REVIEW.review;
      workspaceApplyResult: typeof APPLY_RESULT;
    }>();
    const submitWorkspaceSyncReviewDecision = vi.fn().mockImplementation((workspaceId: string) => {
      if (workspaceId === WORKSPACE.id) return workspaceADecision.promise;
      return Promise.resolve({ review: ACCEPTED_REVIEW.review, workspaceApplyResult: null });
    });
    const listWorkspaceSyncReviews = vi.fn().mockImplementation((workspaceId: string) =>
      Promise.resolve({
        items: workspaceId === WORKSPACE.id ? [PENDING_REVIEW, REJECTED_REVIEW] : [],
      })
    );
    const client = makeClient(
      { listWorkspaceSyncReviews, submitWorkspaceSyncReviewDecision },
      { listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE, WORKSPACE_B] }) }
    );
    useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id });
    renderApp('/workspace-changes', client);

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    const accept = within(reviews).getByRole('button', {
      name: `Accept ${PENDING_STAGED_REVIEW.id}`,
    });
    await user.click(accept);
    await waitFor(() => expect(submitWorkspaceSyncReviewDecision).toHaveBeenCalledTimes(1));
    expect(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).toBeDisabled();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(listWorkspaceSyncReviews.mock.calls.some((call) => call[0] === WORKSPACE_B.id)).toBe(
        true
      )
    );
    expect(screen.queryByText(PENDING_STAGED_REVIEW.riskSummary)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).not.toBeInTheDocument();

    await act(async () => {
      workspaceADecision.reject(
        new ApiCallError(409, 'workspace-sync-private failure', { code: 'recovery_required' })
      );
      await workspaceADecision.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Recovery required', { exact: true })).not.toBeInTheDocument();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Recovery required', { exact: true })).toBeInTheDocument();
    expect(await screen.findByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    expect(submitWorkspaceSyncReviewDecision.mock.calls.map((call) => call[0])).toEqual([
      WORKSPACE.id,
    ]);
  });

  it('keeps the last authoritative rows visible when a post-command refetch fails', async () => {
    const user = userEvent.setup();
    const listWorkspaceSyncReviews = vi
      .fn()
      .mockResolvedValueOnce({ items: [PENDING_REVIEW, REJECTED_REVIEW] })
      .mockRejectedValue(new Error('workspace-sync-private refetch failure'));
    const submitWorkspaceSyncReviewDecision = vi.fn().mockResolvedValue({
      review: ACCEPTED_REVIEW.review,
      workspaceApplyResult: APPLY_RESULT,
    });
    const client = makeClient({ listWorkspaceSyncReviews, submitWorkspaceSyncReviewDecision });
    renderApp('/workspace-changes', client);

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    await user.click(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    );

    await waitFor(() => expect(submitWorkspaceSyncReviewDecision).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listWorkspaceSyncReviews).toHaveBeenCalledTimes(2));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load/i);
    expect(alert).not.toHaveTextContent('workspace-sync-private refetch failure');
    expect(within(reviews).getByText(PENDING_STAGED_REVIEW.riskSummary)).toBeInTheDocument();
    expect(within(reviews).getByText('Pending', { exact: true })).toBeInTheDocument();
    expect(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).toBeInTheDocument();
    expect(screen.queryByText('Accepted', { exact: true })).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('gives repeated review and recovery actions exact target-specific accessible names', async () => {
    const client = makeClient({
      listWorkspaceSyncReviews: vi
        .fn()
        .mockResolvedValue({ items: [PENDING_REVIEW, PENDING_REVIEW_B] }),
      listStagedWorkspaceReviews: vi
        .fn()
        .mockResolvedValue({ items: [PENDING_STAGED_REVIEW, PENDING_STAGED_REVIEW_B] }),
      listWorkspaceReconciliationRecords: vi
        .fn()
        .mockResolvedValue({ items: [RECOVERY_RECORD, RECOVERY_RECORD_B] }),
    });
    renderApp('/workspace-changes', client);

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    expect(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW.id}` })
    ).toBeInTheDocument();
    expect(
      within(reviews).getByRole('button', { name: `Accept ${PENDING_STAGED_REVIEW_B.id}` })
    ).toBeInTheDocument();
    expect(
      within(reviews).getByRole('button', { name: `Refine ${PENDING_STAGED_REVIEW.id}` })
    ).toBeInTheDocument();
    expect(
      within(reviews).getByRole('button', { name: `Refine ${PENDING_STAGED_REVIEW_B.id}` })
    ).toBeInTheDocument();
    expect(within(reviews).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(reviews).queryByRole('button', { name: 'Refine' })).toBeNull();

    const recovery = await screen.findByRole('region', { name: 'Recovery' });
    expect(
      within(recovery).getByRole('button', { name: `Resume collection ${RECOVERY_RECORD.id}` })
    ).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', { name: `Resume collection ${RECOVERY_RECORD_B.id}` })
    ).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', { name: `Quarantine ${RECOVERY_RECORD.id}` })
    ).toBeInTheDocument();
    expect(
      within(recovery).getByRole('button', { name: `Quarantine ${RECOVERY_RECORD_B.id}` })
    ).toBeInTheDocument();
    expect(within(recovery).queryByRole('button', { name: 'Resume collection' })).toBeNull();
    expect(within(recovery).queryByRole('button', { name: 'Quarantine' })).toBeNull();
  });

  it('exposes every effect-bearing pending review field and an inspect affordance', async () => {
    const user = userEvent.setup();
    let pathname = '/workspace-changes';
    const getArtifact = vi.fn().mockResolvedValue(PREVIEW_ARTIFACT);
    const client = makeClient(
      {
        listWorkspaceSyncReviews: vi.fn().mockResolvedValue({ items: [PREVIEW_REVIEW] }),
        getWorkspaceSyncReview: vi.fn().mockResolvedValue(PREVIEW_REVIEW),
        listWorkspaceChangeSets: vi.fn().mockResolvedValue({ items: [PREVIEW_CHANGE_SET] }),
        listStagedWorkspaceReviews: vi.fn().mockResolvedValue({ items: [PREVIEW_STAGED_REVIEW] }),
      },
      { getArtifact, listArtifacts: vi.fn().mockResolvedValue({ items: [PREVIEW_ARTIFACT] }) }
    );
    renderApp('/workspace-changes', client, (next) => {
      pathname = next;
    });

    const reviews = await screen.findByRole('region', { name: 'Reviews' });
    const renamed = PREVIEW_CHANGE_SET.changedPaths[0]!;
    const binary = PREVIEW_CHANGE_SET.changedPaths[1]!;
    const modeChanged = PREVIEW_CHANGE_SET.changedPaths[2]!;
    const renamedRow = changedPathRow(reviews, renamed.path, [renamed.oldPath!, 'Renamed']);
    expect(within(renamedRow).getByText('Renamed', { exact: true })).toBeInTheDocument();
    expect(within(renamedRow).getByText(renamed.oldPath!, { exact: true })).toBeInTheDocument();
    const binaryRow = changedPathRow(reviews, binary.path, [
      binary.binaryReview!.summary,
      'Modified',
    ]);
    expect(within(binaryRow).getByText('Modified', { exact: true })).toBeInTheDocument();
    expect(within(binaryRow).getByText(binary.binaryReview!.summary)).toBeInTheDocument();
    expect(within(binaryRow).getByText(/artifact[- ]only/i)).toBeInTheDocument();
    expect(within(binaryRow).getByText(/binary[- ]path/i)).toBeInTheDocument();
    const modeRow = changedPathRow(reviews, modeChanged.path, [
      'Mode changed',
      modeChanged.oldPermissions!,
      modeChanged.newPermissions!,
    ]);
    expect(within(modeRow).getByText('Mode changed', { exact: true })).toBeInTheDocument();
    expect(
      within(modeRow).getByText(modeChanged.oldPermissions!, { exact: true })
    ).toBeInTheDocument();
    expect(
      within(modeRow).getByText(modeChanged.newPermissions!, { exact: true })
    ).toBeInTheDocument();
    expect(reviews).toHaveTextContent(PREVIEW_STAGED_REVIEW.riskSummary);
    expect(
      Array.from(reviews.querySelectorAll('pre')).some(
        (preview) => preview.textContent === PREVIEW_PATCH_TEXT
      )
    ).toBe(true);
    expect(PREVIEW_STAGED_REVIEW.diffSummary).toEqual({
      filesChanged: PREVIEW_CHANGE_SET.changedPaths.length,
      additions: PREVIEW_PATCH_STATS.additions,
      deletions: PREVIEW_PATCH_STATS.deletions,
    });
    expect(PREVIEW_REVIEW.patchPayload?.bytes).toBe(PREVIEW_PATCH_TEXT.length);
    expect(PREVIEW_CHANGE_SET.patch?.bytes).toBe(PREVIEW_PATCH_TEXT.length);
    const { filesChanged, additions, deletions } = PREVIEW_STAGED_REVIEW.diffSummary;
    expect(additions).toBeGreaterThan(0);
    expect(deletions).toBeGreaterThan(0);
    expect(reviews).toHaveTextContent(new RegExp(`${filesChanged}\\s+files?(?:\\s+changed)?`, 'i'));
    expect(reviews).toHaveTextContent(
      new RegExp(
        `(?:added|additions?)[:\\s]+${additions}|\\+${additions}|${additions}\\s+(?:added|additions?)`,
        'i'
      )
    );
    expect(reviews).toHaveTextContent(
      new RegExp(
        `(?:deleted|deletions?)[:\\s]+${deletions}|[−-]${deletions}|${deletions}\\s+(?:deleted|deletions?)`,
        'i'
      )
    );
    const inspectName = `Inspect ${PREVIEW_REVIEW.artifactId}`;
    const inspectControl =
      within(reviews).queryByRole('link', { name: inspectName }) ??
      within(reviews).getByRole('button', { name: inspectName });
    expect(screen.queryByText(PREVIEW_ARTIFACT.title, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_ARTIFACT_BODY, { exact: true })).not.toBeInTheDocument();
    await user.click(inspectControl);
    const artifactTitle = await screen.findByText(PREVIEW_ARTIFACT.title, { exact: true });
    const artifactBody = await screen.findByText(PREVIEW_ARTIFACT_BODY, { exact: true });
    expect(artifactTitle).toBeVisible();
    expect(artifactBody).toBeVisible();
    if (pathname !== '/workspace-changes') {
      expect(isRegisteredLivePath(pathname)).toBe(true);
    }
  });

  it.each([
    {
      button: 'Stage verified',
      decision: 'stage_verified' as const,
      result: RECOVERED_RECORD,
      stateLabel: 'Recovered',
      otherStateLabels: ['Quarantined', 'Unrecoverable'],
    },
    {
      button: 'Quarantine',
      decision: 'quarantine' as const,
      result: QUARANTINED_RECORD,
      stateLabel: 'Quarantined',
      otherStateLabels: ['Recovered', 'Unrecoverable'],
    },
    {
      button: 'Abandon',
      decision: 'abandon' as const,
      result: UNRECOVERABLE_RECORD,
      stateLabel: 'Unrecoverable',
      otherStateLabels: ['Recovered', 'Quarantined'],
    },
  ])('presents exact $button recovery effects including teardown and retained evidence', async ({
    button,
    decision,
    result,
    stateLabel,
    otherStateLabels,
  }) => {
    const user = userEvent.setup();
    const listWorkspaceReconciliationRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [RECOVERY_RECORD] })
      .mockResolvedValue({ items: [result] });
    const submitWorkspaceRecoveryDecision = vi.fn().mockResolvedValue({
      reconciliationRecord: result,
    });
    const client = makeClient({
      listWorkspaceReconciliationRecords,
      submitWorkspaceRecoveryDecision,
    });
    renderApp('/workspace-changes', client);

    const recovery = await screen.findByRole('region', { name: 'Recovery' });
    expect(result.stateBefore).toBe('requires-human');
    expectAssociatedRecoveryDecisionPreview(
      recovery,
      `${button} ${RECOVERY_RECORD.id}`,
      stateLabel,
      otherStateLabels
    );
    expect(submitWorkspaceRecoveryDecision).not.toHaveBeenCalled();
    await user.click(
      within(recovery).getByRole('button', { name: `${button} ${RECOVERY_RECORD.id}` })
    );

    if (decision === 'abandon') {
      expect(submitWorkspaceRecoveryDecision).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent(/unrecoverable/i);
      await user.click(within(dialog).getByRole('button', { name: /abandon|confirm/i }));
    }

    await waitFor(() => expect(submitWorkspaceRecoveryDecision).toHaveBeenCalledTimes(1));
    const requestId = submitWorkspaceRecoveryDecision.mock.calls[0]?.[2].requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(submitWorkspaceRecoveryDecision.mock.calls).toEqual([
      [WORKSPACE.id, RECOVERY_RECORD.id, { decision, requestId }],
    ]);
    await waitFor(() => expect(listWorkspaceReconciliationRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(stateLabel, { exact: true })).toBeInTheDocument();
    expect(within(recovery).getByText(/teardown[ -]backend/i)).toBeInTheDocument();
    expect(within(recovery).getByText(EVIDENCE_BUNDLE_ID)).toBeInTheDocument();
    expect(within(recovery).getByText(OUTPUT_MANIFEST.id)).toBeInTheDocument();
    expectNoRecoveryDecisionActions(recovery);
  });

  it('renders a truthful unsupported or empty state instead of a blank pane for Quick Chat', async () => {
    useWorkspaceStore.setState({ currentWorkspaceId: QUICK_CHAT_WORKSPACE.id });
    const client = makeClient(
      {},
      { listWorkspaces: vi.fn().mockResolvedValue({ items: [QUICK_CHAT_WORKSPACE] }) }
    );
    renderApp('/workspace-changes', client);

    expect(await screen.findByText(QUICK_CHAT_WORKSPACE.name, { exact: true })).toBeInTheDocument();
    const main = screen.getByRole('main', { name: 'Workspace' });
    expect(main).toHaveTextContent(/workspace changes is unavailable/i);
    expect(main).toHaveTextContent(/create or select an eligible project workspace/i);
    expect(syncCalls(client)).toEqual({
      listReviews: [],
      getReview: [],
      submitDecision: [],
      listSnapshots: [],
      listMaterializations: [],
      listHandles: [],
      listManifests: [],
      listChangeSets: [],
      listStaged: [],
      listPlans: [],
      listResults: [],
      getResult: [],
      listRecovery: [],
      listQuarantine: [],
      submitRecovery: [],
    });
  });
});
