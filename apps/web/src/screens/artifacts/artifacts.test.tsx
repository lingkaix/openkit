import {
  ImportWorkspaceArtifactRequestSchema,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactRequestSchema,
  IntroduceWorkspaceArtifactResponseSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import {
  ArtifactSchema,
  ItemSchema,
  ListArtifactsResponseSchema,
  ListThreadsResponseSchema,
  ListWorkspacesResponseSchema,
  ThreadSchema,
  TurnReadProjectionSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { AppRoutes } from '../../app/routes';
import { surfaceById } from '../../app/surfaces';
import { useWorkspaceStore } from '../workspace-store';

const TIMESTAMP = '2026-08-29T02:00:00.000Z';
const POISON_SECRET = 'sk-secret-should-never-render';
const PREVIEW_BODY = 'Weekly competitor summary for the research workspace.';
const PREVIEW_DIGEST = 'sha256:47b8ddf66206442a533377531bd1a877f9bf910a0d62b205e9bfd86b4b7e1707';
const IMPORT_TITLE = 'Imported weekly summary';
const IMPORT_CONTENT = '# Imported weekly summary';
const IMPORT_DIGEST = 'sha256:c61601b9584981695f0ace9e91299e34b15911bc934642519ed95d076df3360e';
const IMPORT_TITLE_V2 = 'Imported weekly summary revised';
const IMPORT_CONTENT_V2 = '# Imported weekly summary\n\nRevised edition.';
const IMPORT_SUMMARY_V2 = 'Revised imported weekly summary.';
const IMPORT_DIGEST_V2 = 'sha256:a4aa759b692e6f4441b35376f10c0faa5ee948bf7ab011b1732c6dffb52fac4e';
const SECONDARY_IMPORT_TITLE = 'Imported competitor appendix';
const SECONDARY_IMPORT_CONTENT = '# Imported competitor appendix';
const SECONDARY_IMPORT_DIGEST =
  'sha256:8ecbbc69fee9cfe754926024b3e86dd3b42be5c88161db5bde71256c4d73eda4';
const OPS_BODY = 'Ops body';
const OPS_DIGEST = 'sha256:b8238e0ad296bb47e6fa9c2ec1ef244c58bc91b5046e2bc56d2ca1bcf1b6843f';
const INTRODUCE_TURN_ID = 'tu_intro';
const INTRODUCE_ITEM_ID = 'it_intro';
const DISTRACTOR_TITLE = 'Mismatched distractor artifact';
const DISTRACTOR_SUMMARY = 'Distractor summary must not settle introduction';
const MULTILINE_MARKDOWN = '# Imported weekly summary\n\nSecond paragraph with **emphasis**.';
const MULTILINE_MARKDOWN_DIGEST =
  'sha256:1d6ffbe6dd46a907b2a3fe1b404e0a7c575783ea61e7a9dbc25f3efbda678c13';
const MULTILINE_PLAIN = 'Line one\nLine two\nLine three';
const MULTILINE_PLAIN_DIGEST =
  'sha256:46c949c0b79bc3c1eef1d2970222427b7a0e8d70233d4cc2429535f0f41a0e9a';
const MULTILINE_JSON = '{\n  "title": "weekly",\n  "ready": true\n}';
const MULTILINE_JSON_DIGEST =
  'sha256:8d2a142ab0a8c7d7a220b2ad401f49f4e1e2060483dbf425048336b538b38fda';
const MULTILINE_MARKDOWN_IMPORT = ImportWorkspaceArtifactRequestSchema.parse({
  requestId: 'req_multiline_markdown',
  title: 'Multiline import',
  mediaType: 'text/markdown',
  content: MULTILINE_MARKDOWN,
  contentDigest: MULTILINE_MARKDOWN_DIGEST,
});
const MULTILINE_PLAIN_IMPORT = ImportWorkspaceArtifactRequestSchema.parse({
  requestId: 'req_multiline_plain',
  title: 'Multiline import',
  mediaType: 'text/plain',
  content: MULTILINE_PLAIN,
  contentDigest: MULTILINE_PLAIN_DIGEST,
});
const MULTILINE_JSON_IMPORT = ImportWorkspaceArtifactRequestSchema.parse({
  requestId: 'req_multiline_json',
  title: 'Multiline import',
  mediaType: 'application/json',
  content: MULTILINE_JSON,
  contentDigest: MULTILINE_JSON_DIGEST,
});

function workspaceRecord(
  id: string,
  name: string,
  kind: 'research' | 'operations',
  counts: { threadCount: number; artifactCount: number }
) {
  return WorkspaceRecordSchema.parse({
    id,
    name,
    kind,
    status: 'active',
    defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
    counts: { ...counts, knowledgeEntryCount: 0 },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
}

const WORKSPACE = workspaceRecord('ws1', 'Market research', 'research', {
  threadCount: 1,
  artifactCount: 2,
});
const WORKSPACE_B = workspaceRecord('ws2', 'Ops workspace', 'operations', {
  threadCount: 1,
  artifactCount: 1,
});

const THREAD_NAME = 'Competitive teardown';
const THREAD = ThreadSchema.parse({
  id: 'th_intro',
  workspaceId: WORKSPACE.id,
  name: THREAD_NAME,
  preview: THREAD_NAME,
  status: 'active',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});
const THREAD_B = ThreadSchema.parse({
  ...THREAD,
  id: 'th_ops',
  workspaceId: WORKSPACE_B.id,
  name: 'Ops thread',
  preview: 'Ops thread',
});

const ARTIFACT = ArtifactSchema.parse({
  id: 'artifact_weekly',
  workspaceId: WORKSPACE.id,
  threadId: 'th_weekly',
  turnId: 'tu_weekly',
  kind: 'report',
  title: 'Weekly competitor summary',
  status: 'ready',
  summary: 'One-page research summary.',
  version: 1,
  content: { format: 'markdown', body: PREVIEW_BODY },
  contentDigest: PREVIEW_DIGEST,
  lastMutationRequestId: POISON_SECRET,
  origin: {
    kind: 'turn-output',
    threadId: 'th_weekly',
    turnId: 'tu_weekly',
    requestId: POISON_SECRET,
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const IMPORTED_ARTIFACT = ArtifactSchema.parse({
  ...ARTIFACT,
  id: 'artifact_imported',
  threadId: null,
  turnId: null,
  title: IMPORT_TITLE,
  summary: null,
  content: { format: 'markdown', body: IMPORT_CONTENT },
  contentDigest: IMPORT_DIGEST,
  lastMutationRequestId: 'req_imported',
  origin: {
    kind: 'imported',
    sourceKind: 'direct-import',
    sourceId: 'req_imported',
    sourceDigest: IMPORT_DIGEST,
    actor: { kind: 'user', id: 'user_1' },
    requestId: 'req_imported',
    recordedAt: TIMESTAMP,
  },
});

const IMPORTED_ARTIFACT_V2 = ArtifactSchema.parse({
  ...IMPORTED_ARTIFACT,
  version: 2,
  title: IMPORT_TITLE_V2,
  summary: IMPORT_SUMMARY_V2,
  content: { format: 'markdown', body: IMPORT_CONTENT_V2 },
  contentDigest: IMPORT_DIGEST_V2,
  lastMutationRequestId: 'req_imported_v2',
});

const SECONDARY_IMPORTED_ARTIFACT = ArtifactSchema.parse({
  ...IMPORTED_ARTIFACT,
  id: 'artifact_imported_appendix',
  title: SECONDARY_IMPORT_TITLE,
  content: { format: 'markdown', body: SECONDARY_IMPORT_CONTENT },
  contentDigest: SECONDARY_IMPORT_DIGEST,
  lastMutationRequestId: 'req_imported_appendix',
  origin: {
    ...IMPORTED_ARTIFACT.origin,
    sourceId: 'req_imported_appendix',
    sourceDigest: SECONDARY_IMPORT_DIGEST,
    requestId: 'req_imported_appendix',
  },
});

const ARTIFACT_B = ArtifactSchema.parse({
  ...ARTIFACT,
  id: 'artifact_ops',
  workspaceId: WORKSPACE_B.id,
  threadId: 'th_ops_src',
  turnId: 'tu_ops_src',
  title: 'Ops runbook',
  summary: 'Ops-only artifact.',
  content: { format: 'markdown', body: OPS_BODY },
  contentDigest: OPS_DIGEST,
  lastMutationRequestId: 'req_ops',
  origin: {
    kind: 'turn-output',
    threadId: 'th_ops_src',
    turnId: 'tu_ops_src',
    requestId: 'req_ops',
  },
});

const IMPORT_MUTATION = ImportWorkspaceArtifactResponseSchema.parse({
  artifactId: 'mutation-only-artifact',
  artifactVersion: 1,
});
const INTRODUCE_MUTATION = IntroduceWorkspaceArtifactResponseSchema.parse({
  artifactId: IMPORTED_ARTIFACT.id,
  artifactVersion: IMPORTED_ARTIFACT.version,
  turnId: INTRODUCE_TURN_ID,
  itemId: INTRODUCE_ITEM_ID,
});
const INTRODUCE_MUTATION_V2 = IntroduceWorkspaceArtifactResponseSchema.parse({
  ...INTRODUCE_MUTATION,
  artifactVersion: IMPORTED_ARTIFACT_V2.version,
});

type MethodOverrides = Partial<Record<string, unknown>>;

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

function artifactsFor(workspaceId: string) {
  return workspaceId === WORKSPACE_B.id ? [ARTIFACT_B] : [ARTIFACT, IMPORTED_ARTIFACT];
}

function threadsFor(workspaceId: string) {
  return workspaceId === WORKSPACE_B.id ? [THREAD_B] : [THREAD];
}

/** Build one completed artifact-reference Item for an introduction Turn. */
function introduceItem(input: {
  id: string;
  artifactId: string;
  artifactVersion: number;
  lastMutationRequestId: string;
  title: string;
  summary: string | null;
  workspaceId?: string;
  threadId?: string;
  turnId?: string;
  status?: 'completed' | 'in_progress' | 'failed' | 'declined';
}) {
  const item = ItemSchema.parse({
    id: input.id,
    workspaceId: input.workspaceId ?? WORKSPACE.id,
    threadId: input.threadId ?? THREAD.id,
    turnId: input.turnId ?? INTRODUCE_TURN_ID,
    type: 'artifact-reference',
    status: input.status ?? 'completed',
    artifactId: input.artifactId,
    artifactVersion: input.artifactVersion,
    lastMutationRequestId: input.lastMutationRequestId,
    title: input.title,
    summary: input.summary,
    createdAt: TIMESTAMP,
    completedAt: TIMESTAMP,
  });
  if (item.type !== 'artifact-reference') {
    throw new Error(`expected artifact-reference, got ${item.type}`);
  }
  return item;
}

/** Schema-valid completed Item that is not an artifact-reference. */
function extraNonArtifactItem() {
  return ItemSchema.parse({
    id: 'it_intro_extra_status',
    workspaceId: WORKSPACE.id,
    threadId: THREAD.id,
    turnId: INTRODUCE_TURN_ID,
    type: 'status',
    status: 'completed',
    level: 'info',
    title: DISTRACTOR_TITLE,
    summary: DISTRACTOR_SUMMARY,
    createdAt: TIMESTAMP,
    completedAt: TIMESTAMP,
  });
}

/** Build an introduction Turn around one artifact-reference Item, with optional contradictory fields. */
function introduceTurn(
  item: ReturnType<typeof introduceItem>,
  extras: {
    extraItems?: Array<ReturnType<typeof ItemSchema.parse>>;
    id?: string;
    status?: 'cancelled' | 'completed' | 'failed' | 'interrupted' | 'pending' | 'running';
    threadId?: string;
    workspaceId?: string;
  } = {}
) {
  const status = extras.status ?? 'completed';
  const completed = status === 'completed';
  return TurnReadProjectionSchema.parse({
    id: extras.id ?? INTRODUCE_TURN_ID,
    workspaceId: extras.workspaceId ?? WORKSPACE.id,
    threadId: extras.threadId ?? THREAD.id,
    triggerActor: { kind: 'user', id: 'user_1' },
    items: extras.extraItems ? [item, ...extras.extraItems] : [item],
    error: null,
    configVersion: null,
    startedAt: TIMESTAMP,
    completedAt: completed ? TIMESTAMP : null,
    durationMs: completed ? 0 : null,
    status,
    humanGate: null,
    contextPackageDigest: null,
  });
}

/** Matching completed artifact-reference Item for the frozen introduction receipt. */
function matchedIntroduceItem(requestId: string) {
  return introduceItem({
    id: INTRODUCE_MUTATION.itemId,
    artifactId: INTRODUCE_MUTATION.artifactId,
    artifactVersion: INTRODUCE_MUTATION.artifactVersion,
    lastMutationRequestId: requestId,
    title: IMPORTED_ARTIFACT.title,
    summary: IMPORTED_ARTIFACT.summary,
  });
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(overrides: { core?: MethodOverrides; app?: MethodOverrides } = {}): CoreClient {
  const artifacts = [...artifactsFor(WORKSPACE.id), ...artifactsFor(WORKSPACE_B.id)];
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue(ListWorkspacesResponseSchema.parse({ items: [WORKSPACE, WORKSPACE_B] })),
      listArtifacts: vi
        .fn()
        .mockImplementation((workspaceId: string) =>
          Promise.resolve(ListArtifactsResponseSchema.parse({ items: artifactsFor(workspaceId) }))
        ),
      getArtifact: vi.fn().mockImplementation((workspaceId: string, artifactId: string) => {
        const record = artifacts.find(
          (item) => item.workspaceId === workspaceId && item.id === artifactId
        );
        return record
          ? Promise.resolve(record)
          : Promise.reject(new Error(`Artifact not found: ${artifactId}`));
      }),
      listThreads: vi
        .fn()
        .mockImplementation((workspaceId: string) =>
          Promise.resolve(ListThreadsResponseSchema.parse({ items: threadsFor(workspaceId) }))
        ),
      getTurn: vi.fn(),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      importWorkspaceArtifact: vi.fn().mockResolvedValue(IMPORT_MUTATION),
      introduceWorkspaceArtifact: vi.fn().mockResolvedValue(INTRODUCE_MUTATION),
      ...overrides.app,
    },
  } as unknown as CoreClient;
}

function renderApp(path: string, client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return { client, queryClient };
}

/** Selects one listed option from an accessible combobox or listbox trigger. */
async function selectListedOption(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string
) {
  const trigger =
    screen
      .queryAllByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      .find((button) => button.getAttribute('aria-haspopup') === 'listbox') ??
    screen.getByRole('combobox', { name: new RegExp(`^${name}$`, 'i') });
  await user.click(trigger);
  await user.click(
    within(await screen.findByRole('listbox')).getByRole('option', { name: option })
  );
}

/** Fills the bounded Workspace Artifact import form and submits it. */
async function submitImport(
  user: ReturnType<typeof userEvent.setup>,
  input: { title: string; mediaType: string; content: string } = {
    title: IMPORT_TITLE,
    mediaType: 'text/markdown',
    content: IMPORT_CONTENT,
  }
) {
  await user.click(screen.getByRole('button', { name: /import artifact/i }));
  await user.type(screen.getByRole('textbox', { name: 'Title' }), input.title);
  await user.type(screen.getByRole('textbox', { name: 'Media type' }), input.mediaType);
  await user.type(screen.getByRole('textbox', { name: 'Content' }), input.content);
  await user.click(screen.getByRole('button', { name: /^import$/i }));
}

/** Opens one listed Artifact by its product title. */
async function openArtifact(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(title) }));
}

/** Opens the imported Artifact and chooses one existing Workspace Thread. */
async function chooseIntroduceThread(
  user: ReturnType<typeof userEvent.setup>,
  threadName = THREAD_NAME
) {
  await openArtifact(user, IMPORTED_ARTIFACT.title);
  await selectListedOption(user, 'Thread', threadName);
}

/** Fills Import Content through the accessible multiline control and submits. */
async function submitMultilineImport(
  user: ReturnType<typeof userEvent.setup>,
  input: { title: string; mediaType: string; content: string }
) {
  await user.click(screen.getByRole('button', { name: /import artifact/i }));
  await user.type(screen.getByRole('textbox', { name: 'Title' }), input.title);
  await user.type(screen.getByRole('textbox', { name: 'Media type' }), input.mediaType);
  const content = screen.getByRole('textbox', { name: 'Content' });
  expect(content.tagName).toBe('TEXTAREA');
  expect(content).toHaveAccessibleName('Content');
  await user.click(content);
  await user.paste(input.content);
  expect(content).toHaveValue(input.content);
  await user.click(screen.getByRole('button', { name: /^import$/i }));
}

/** Starts one imported-Artifact introduction whose authoritative Turn is still pending. */
async function startImportedIntroduction(user: ReturnType<typeof userEvent.setup>) {
  const turnRead = createDeferred<ReturnType<typeof introduceTurn>>();
  const getTurn = vi.fn().mockReturnValue(turnRead.promise);
  const introduceWorkspaceArtifact = vi.fn().mockResolvedValue(INTRODUCE_MUTATION);
  renderApp(
    '/artifacts',
    makeClient({
      core: {
        listArtifacts: vi
          .fn()
          .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] })),
        getTurn,
      },
      app: { introduceWorkspaceArtifact },
    })
  );
  expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
  expect(IMPORTED_ARTIFACT.origin.kind).toBe('imported');
  expect(IMPORTED_ARTIFACT.threadId).toBeNull();
  expect(IMPORTED_ARTIFACT.turnId).toBeNull();
  await chooseIntroduceThread(user);
  expect(await screen.findByText(IMPORTED_ARTIFACT.content.body)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /introduce into thread/i }));
  await waitFor(() => expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1));
  const command = acceptedIntroduce(introduceWorkspaceArtifact);
  await waitFor(() =>
    expect(getTurn.mock.calls).toEqual([[WORKSPACE.id, THREAD.id, INTRODUCE_MUTATION.turnId]])
  );
  return { command, getTurn, introduceWorkspaceArtifact, turnRead };
}

/** Fail-closed recovery UI after a contradictory introduction Turn, with no later mutation. */
async function assertFailClosedIntroductionRecovery(
  introduceWorkspaceArtifact: ReturnType<typeof vi.fn>
) {
  expect(
    screen.queryByText(new RegExp(`introduced into ${THREAD_NAME}`, 'i'))
  ).not.toBeInTheDocument();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/recovery required/i);
  expect(alert).not.toHaveTextContent('recovery_required');
  expect(alert).not.toHaveTextContent(/private failure/i);
  expect(screen.queryByText(DISTRACTOR_TITLE)).not.toBeInTheDocument();
  expect(screen.queryByText(DISTRACTOR_SUMMARY)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();
  expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1);
  assertNoLeakedInternals();
}

function acceptedImport(mock: ReturnType<typeof vi.fn>, index = 0) {
  const [workspaceId, input] = mock.mock.calls[index] ?? [];
  expect(workspaceId).toBe(WORKSPACE.id);
  return ImportWorkspaceArtifactRequestSchema.parse(input);
}

function acceptedIntroduce(mock: ReturnType<typeof vi.fn>, index = 0) {
  const [workspaceId, threadId, artifactId, input] = mock.mock.calls[index] ?? [];
  expect([workspaceId, threadId, artifactId]).toEqual([
    WORKSPACE.id,
    THREAD.id,
    IMPORTED_ARTIFACT.id,
  ]);
  return IntroduceWorkspaceArtifactRequestSchema.parse(input);
}

function assertNoLeakedInternals() {
  const serialized = document.documentElement.outerHTML;
  expect(serialized).not.toContain(POISON_SECRET);
  expect(serialized).not.toContain(DISTRACTOR_SUMMARY);
}

function privateError(status: number, code: string, privateText: string) {
  return new ApiCallError(status, privateText, { code });
}

/** Starts one import or introduce command that fails with a typed public error. */
async function startTypedCommandFailure(
  user: ReturnType<typeof userEvent.setup>,
  command: 'import' | 'introduce',
  error: ApiCallError,
  retrySucceeds: boolean
) {
  const importWorkspaceArtifact = retrySucceeds
    ? vi.fn().mockRejectedValueOnce(error).mockResolvedValue(IMPORT_MUTATION)
    : vi.fn().mockRejectedValue(error);
  const introduceWorkspaceArtifact = retrySucceeds
    ? vi.fn().mockRejectedValueOnce(error).mockResolvedValue(INTRODUCE_MUTATION)
    : vi.fn().mockRejectedValue(error);
  const listArtifacts = vi
    .fn()
    .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] }));
  const getArtifact = vi.fn().mockResolvedValue(IMPORTED_ARTIFACT);
  renderApp(
    '/artifacts',
    makeClient({
      core: { listArtifacts, getArtifact },
      app: { importWorkspaceArtifact, introduceWorkspaceArtifact },
    })
  );

  expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
  if (command === 'import') {
    await submitImport(user);
  } else {
    await chooseIntroduceThread(user);
    expect(await screen.findByText(IMPORTED_ARTIFACT.content.body)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /introduce into thread/i }));
  }

  const mutation = command === 'import' ? importWorkspaceArtifact : introduceWorkspaceArtifact;
  await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
  const first =
    command === 'import'
      ? acceptedImport(importWorkspaceArtifact)
      : acceptedIntroduce(introduceWorkspaceArtifact);
  return {
    first,
    getArtifact,
    importWorkspaceArtifact,
    introduceWorkspaceArtifact,
    listArtifacts,
    mutation,
  };
}

async function disconnectWrites(queryClient: QueryClient, meta: ReturnType<typeof vi.fn>) {
  meta.mockRejectedValue(new Error('down'));
  await queryClient.invalidateQueries({ queryKey: ['core', 'meta'] });
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Artifacts', () => {
  it('lists selected-Workspace artifacts, opens one exact artifact, and previews product-safe content', async () => {
    const user = userEvent.setup();
    const { client } = renderApp('/artifacts', makeClient());

    expect(await screen.findByRole('heading', { level: 1, name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary workspace navigation' });
    expect(within(nav).getByRole('button', { name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByText(ARTIFACT.title)).toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.content.body)).not.toBeInTheDocument();
    assertNoLeakedInternals();
    expect(vi.mocked(client.core.listArtifacts).mock.calls).toEqual([[WORKSPACE.id]]);
    expect(client.core.getArtifact).not.toHaveBeenCalled();

    await openArtifact(user, ARTIFACT.title);

    await waitFor(() =>
      expect(vi.mocked(client.core.getArtifact).mock.calls).toEqual([[WORKSPACE.id, ARTIFACT.id]])
    );
    expect(await screen.findByText(ARTIFACT.content.body)).toBeInTheDocument();
    assertNoLeakedInternals();

    const surface = surfaceById('artifacts');
    expect(surface).toMatchObject({ title: 'Artifacts', tier: 'A', nav: 'primary' });
    expect(isSurfaceLive(surface!)).toBe(true);
  });

  it.each([
    {
      name: 'shows a loading skeleton while the Artifact list is pending',
      list: () => new Promise(() => {}),
      expectLoading: true,
    },
    {
      name: 'shows an empty state when the selected Workspace has no Artifacts',
      list: () => Promise.resolve(ListArtifactsResponseSchema.parse({ items: [] })),
      expectLoading: false,
    },
  ])('$name', async ({ list, expectLoading }) => {
    renderApp(
      '/artifacts',
      makeClient({ core: { listArtifacts: vi.fn().mockImplementation(list) } })
    );
    if (expectLoading) {
      await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
      return;
    }
    expect(await screen.findByText(/no artifacts yet/i)).toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.title)).not.toBeInTheDocument();
  });

  it('keeps the Artifact list visible and marks it stale while disconnected', async () => {
    renderApp(
      '/artifacts',
      makeClient({ core: { meta: vi.fn().mockRejectedValue(new Error('down')) } })
    );
    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    expect(await screen.findByText('Status may be stale', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import artifact/i })).toBeDisabled();
    assertNoLeakedInternals();
  });

  it.each([
    {
      name: 'denied',
      error: privateError(403, 'workspace_access_denied', 'list-denied-private failure'),
      message: /access denied/i,
    },
    {
      name: 'failed',
      error: new Error('list-private failure'),
      message: /couldn't load artifacts/i,
    },
  ])('recovers a $name Artifact list without leaking private text', async ({ error, message }) => {
    const user = userEvent.setup();
    const listArtifacts = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] }));
    renderApp('/artifacts', makeClient({ core: { listArtifacts } }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(screen.queryByText(ARTIFACT.title)).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    expect(listArtifacts.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id]]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries an exact Artifact read failure without leaking private text', async () => {
    const user = userEvent.setup();
    const getArtifact = vi
      .fn()
      .mockRejectedValueOnce(new Error('artifact-read-private failure'))
      .mockResolvedValue(ARTIFACT);
    renderApp('/artifacts', makeClient({ core: { getArtifact } }));

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await openArtifact(user, ARTIFACT.title);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load that artifact/i);
    expect(alert).not.toHaveTextContent('artifact-read-private failure');
    expect(screen.queryByText(ARTIFACT.content.body)).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(ARTIFACT.content.body)).toBeInTheDocument();
    expect(getArtifact.mock.calls).toEqual([
      [WORKSPACE.id, ARTIFACT.id],
      [WORKSPACE.id, ARTIFACT.id],
    ]);
  });

  it('imports through the current schema then settles from an authoritative list refetch', async () => {
    const user = userEvent.setup();
    const importRead = createDeferred<ReturnType<typeof ListArtifactsResponseSchema.parse>>();
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] }))
      .mockReturnValueOnce(importRead.promise);
    const importWorkspaceArtifact = vi.fn().mockResolvedValue(IMPORT_MUTATION);
    renderApp(
      '/artifacts',
      makeClient({ core: { listArtifacts }, app: { importWorkspaceArtifact } })
    );

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await submitImport(user);

    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1));
    const command = acceptedImport(importWorkspaceArtifact);
    expect(command).toMatchObject({
      title: IMPORT_TITLE,
      mediaType: 'text/markdown',
      contentDigest: IMPORT_DIGEST,
      content: IMPORT_CONTENT,
      requestId: expect.any(String),
    });
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(2));
    expect(screen.getByText(ARTIFACT.title)).toBeInTheDocument();
    expect(screen.queryByText(IMPORT_MUTATION.artifactId)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_TITLE)).not.toBeInTheDocument();

    importRead.resolve(ListArtifactsResponseSchema.parse({ items: [ARTIFACT, IMPORTED_ARTIFACT] }));
    expect(await screen.findByText(IMPORT_TITLE)).toBeInTheDocument();
    expect(listArtifacts.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id]]);
  });

  it('introduces from listed Threads at the selected Artifact version and settles from the completed Turn item', async () => {
    const user = userEvent.setup();
    const turnRead = createDeferred<ReturnType<typeof introduceTurn>>();
    const listArtifacts = vi
      .fn()
      .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] }));
    const getTurn = vi.fn().mockReturnValue(turnRead.promise);
    const introduceWorkspaceArtifact = vi.fn().mockResolvedValue(INTRODUCE_MUTATION);
    const { client } = renderApp(
      '/artifacts',
      makeClient({
        core: { listArtifacts, getTurn },
        app: { introduceWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await openArtifact(user, IMPORTED_ARTIFACT.title);
    expect(screen.queryByRole('textbox', { name: /thread id/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /expected artifact version/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();
    expect(introduceWorkspaceArtifact).not.toHaveBeenCalled();
    expect(vi.mocked(client.core.listThreads)).toHaveBeenCalledWith(WORKSPACE.id);
    expect(
      vi.mocked(client.core.listThreads).mock.calls.every((call) => call[0] === WORKSPACE.id)
    ).toBe(true);

    await selectListedOption(user, 'Thread', THREAD_NAME);
    await user.click(screen.getByRole('button', { name: /introduce into thread/i }));

    await waitFor(() => expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1));
    const command = acceptedIntroduce(introduceWorkspaceArtifact);
    expect(command).toMatchObject({
      expectedArtifactVersion: IMPORTED_ARTIFACT.version,
      requestId: expect.any(String),
    });
    await waitFor(() =>
      expect(getTurn.mock.calls).toEqual([[WORKSPACE.id, THREAD.id, INTRODUCE_MUTATION.turnId]])
    );
    expect(
      screen.queryByText(new RegExp(`introduced into ${THREAD_NAME}`, 'i'))
    ).not.toBeInTheDocument();
    expect(listArtifacts.mock.calls).toEqual([[WORKSPACE.id]]);

    const matched = introduceItem({
      id: INTRODUCE_MUTATION.itemId,
      artifactId: INTRODUCE_MUTATION.artifactId,
      artifactVersion: INTRODUCE_MUTATION.artifactVersion,
      lastMutationRequestId: command.requestId,
      title: IMPORTED_ARTIFACT.title,
      summary: IMPORTED_ARTIFACT.summary,
    });
    const turn = introduceTurn(matched);
    expect(turn.items).toEqual([matched]);
    expect(matched).toMatchObject({
      id: INTRODUCE_MUTATION.itemId,
      type: 'artifact-reference',
      status: 'completed',
      turnId: INTRODUCE_MUTATION.turnId,
      artifactId: INTRODUCE_MUTATION.artifactId,
      artifactVersion: INTRODUCE_MUTATION.artifactVersion,
      lastMutationRequestId: command.requestId,
    });
    turnRead.resolve(turn);
    expect(
      await screen.findByText(new RegExp(`introduced into ${THREAD_NAME}`, 'i'))
    ).toBeInTheDocument();
    expect(getTurn).toHaveBeenCalledTimes(1);
    assertNoLeakedInternals();
  });

  it('does not settle introduction from a mismatched-only authoritative Turn', async () => {
    const user = userEvent.setup();
    const { command, getTurn, introduceWorkspaceArtifact, turnRead } =
      await startImportedIntroduction(user);

    const mismatched = introduceItem({
      id: 'it_intro_other',
      artifactId: ARTIFACT.id,
      artifactVersion: ARTIFACT.version,
      lastMutationRequestId: 'req_unrelated_communication',
      title: DISTRACTOR_TITLE,
      summary: DISTRACTOR_SUMMARY,
    });
    const turn = introduceTurn(mismatched);
    expect(turn.items).toEqual([mismatched]);
    expect(mismatched).toMatchObject({
      type: 'artifact-reference',
      status: 'completed',
      turnId: INTRODUCE_TURN_ID,
    });
    expect(mismatched.id).not.toBe(INTRODUCE_MUTATION.itemId);
    expect(mismatched.artifactId).not.toBe(INTRODUCE_MUTATION.artifactId);
    expect(mismatched.lastMutationRequestId).not.toBe(command.requestId);
    await act(async () => {
      turnRead.resolve(turn);
    });
    expect(getTurn).toHaveBeenCalledTimes(1);
    await assertFailClosedIntroductionRecovery(introduceWorkspaceArtifact);
  });

  it('disables introduction when the selected Workspace has no Threads', async () => {
    const user = userEvent.setup();
    const listThreads = vi.fn().mockResolvedValue(ListThreadsResponseSchema.parse({ items: [] }));
    renderApp(
      '/artifacts',
      makeClient({
        core: {
          listArtifacts: vi
            .fn()
            .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] })),
          listThreads,
        },
      })
    );

    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await openArtifact(user, IMPORTED_ARTIFACT.title);
    expect(await screen.findByText(/no threads/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();
    expect(listThreads).toHaveBeenCalledWith(WORKSPACE.id);
    expect(listThreads.mock.calls.every((call) => call[0] === WORKSPACE.id)).toBe(true);
  });

  it('recovers a Thread-list failure without leaking private text', async () => {
    const user = userEvent.setup();
    let failThreads = true;
    const listThreads = vi
      .fn()
      .mockImplementation(() =>
        failThreads
          ? Promise.reject(new Error('thread-list-private failure'))
          : Promise.resolve(ListThreadsResponseSchema.parse({ items: [THREAD] }))
      );
    renderApp(
      '/artifacts',
      makeClient({
        core: {
          listArtifacts: vi
            .fn()
            .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] })),
          listThreads,
        },
      })
    );

    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await openArtifact(user, IMPORTED_ARTIFACT.title);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load threads/i);
    expect(alert).not.toHaveTextContent('thread-list-private failure');
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();

    failThreads = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await selectListedOption(user, 'Thread', THREAD_NAME);
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeEnabled();
    expect(listThreads).toHaveBeenCalledWith(WORKSPACE.id);
  });

  it.each([
    {
      command: 'import' as const,
      error: new Error('import-transport-private failure'),
      message: /couldn't import/i,
    },
    {
      command: 'introduce' as const,
      error: privateError(409, 'thread_busy', 'introduce-busy-private failure'),
      message: /couldn't introduce|busy/i,
    },
  ])('replays the exact $command after uncertain transport or thread_busy and blocks retry while disconnected', async ({
    command,
    error,
    message,
  }) => {
    const user = userEvent.setup();
    const importWorkspaceArtifact = vi.fn().mockRejectedValue(error);
    const introduceWorkspaceArtifact = vi.fn().mockRejectedValue(error);
    const meta = vi.fn().mockResolvedValue({});
    const { queryClient } = renderApp(
      '/artifacts',
      makeClient({
        core: { meta },
        app: { importWorkspaceArtifact, introduceWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    if (command === 'import') {
      await submitImport(user);
    } else {
      await chooseIntroduceThread(user);
      await user.click(screen.getByRole('button', { name: /introduce into thread/i }));
    }

    const mutation = command === 'import' ? importWorkspaceArtifact : introduceWorkspaceArtifact;
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    const first =
      command === 'import'
        ? acceptedImport(importWorkspaceArtifact)
        : acceptedIntroduce(introduceWorkspaceArtifact);
    if (command === 'import') {
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(IMPORT_TITLE);
      expect(screen.getByRole('textbox', { name: 'Content' })).toHaveValue(IMPORT_CONTENT);
    }
    const alert = await waitFor(() => {
      const match = screen
        .getAllByRole('alert')
        .find((node) => message.test(node.textContent ?? ''));
      expect(match).toBeTruthy();
      return match as HTMLElement;
    });
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    const retried =
      command === 'import'
        ? acceptedImport(importWorkspaceArtifact, 1)
        : acceptedIntroduce(introduceWorkspaceArtifact, 1);
    expect(retried).toEqual(first);

    await disconnectWrites(queryClient, meta);
    await waitFor(() => {
      const current = screen
        .getAllByRole('alert')
        .find((node) => message.test(node.textContent ?? ''));
      expect(current).toBeTruthy();
      expect(
        within(current as HTMLElement).getByRole('button', { name: 'Try again' })
      ).toBeDisabled();
    });
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it('disables a stale introduction target after refresh until another eligible Artifact is selected', async () => {
    const user = userEvent.setup();
    const error = privateError(409, 'stale', 'introduce-stale-private failure');
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] }))
      .mockResolvedValue(
        ListArtifactsResponseSchema.parse({ items: [SECONDARY_IMPORTED_ARTIFACT] })
      );
    const getArtifact = vi.fn().mockImplementation((_workspaceId: string, artifactId: string) => {
      if (artifactId === SECONDARY_IMPORTED_ARTIFACT.id) {
        return Promise.resolve(SECONDARY_IMPORTED_ARTIFACT);
      }
      if (artifactId === IMPORTED_ARTIFACT.id && listArtifacts.mock.calls.length < 2) {
        return Promise.resolve(IMPORTED_ARTIFACT);
      }
      return Promise.reject(new Error(`Artifact not found: ${artifactId}`));
    });
    const introduceWorkspaceArtifact = vi.fn().mockRejectedValue(error);
    renderApp(
      '/artifacts',
      makeClient({
        core: { listArtifacts, getArtifact },
        app: { introduceWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await chooseIntroduceThread(user);
    await user.click(screen.getByRole('button', { name: /introduce into thread/i }));

    await waitFor(() => expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1));
    const first = acceptedIntroduce(introduceWorkspaceArtifact);
    expect(first.expectedArtifactVersion).toBe(IMPORTED_ARTIFACT.version);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/stale|no longer current/i);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent('stale');

    const readsBeforeRetry = listArtifacts.mock.calls.length + getArtifact.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(listArtifacts.mock.calls.length + getArtifact.mock.calls.length).toBeGreaterThan(
        readsBeforeRetry
      )
    );
    expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(SECONDARY_IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    expect(screen.queryByText(IMPORTED_ARTIFACT.title)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_TITLE_V2)).not.toBeInTheDocument();
    expect(screen.queryByText(/version 2/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();

    await openArtifact(user, SECONDARY_IMPORTED_ARTIFACT.title);
    await selectListedOption(user, 'Thread', THREAD_NAME);
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeEnabled();
    expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1);
  });

  it('refreshes a version-conflicted Artifact then sends a distinct new introduce request', async () => {
    const user = userEvent.setup();
    const error = privateError(409, 'conflict', 'introduce-conflict-private failure');
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] }))
      .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT_V2] }));
    const getArtifact = vi
      .fn()
      .mockResolvedValueOnce(IMPORTED_ARTIFACT)
      .mockResolvedValue(IMPORTED_ARTIFACT_V2);
    const introduceWorkspaceArtifact = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(INTRODUCE_MUTATION_V2);
    renderApp(
      '/artifacts',
      makeClient({
        core: { listArtifacts, getArtifact },
        app: { introduceWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await chooseIntroduceThread(user);
    await user.click(screen.getByRole('button', { name: /introduce into thread/i }));

    await waitFor(() => expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1));
    const first = acceptedIntroduce(introduceWorkspaceArtifact);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/conflict|changed|expected version/i);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent('conflict');

    const readsBeforeRetry = listArtifacts.mock.calls.length + getArtifact.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(listArtifacts.mock.calls.length + getArtifact.mock.calls.length).toBeGreaterThan(
        readsBeforeRetry
      )
    );
    expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(IMPORT_TITLE_V2)).toBeInTheDocument();
    expect(await screen.findByText(IMPORT_SUMMARY_V2)).toBeInTheDocument();
    expect(await screen.findByText(/revised edition/i)).toBeInTheDocument();
    expect(await screen.findByText(/version 2/i)).toBeInTheDocument();
    expect(screen.queryByText(IMPORT_CONTENT, { exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /introduce into thread/i }));

    await waitFor(() => expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(2));
    const next = acceptedIntroduce(introduceWorkspaceArtifact, 1);
    expect(next.requestId).not.toBe(first.requestId);
    expect(next.expectedArtifactVersion).toBe(IMPORTED_ARTIFACT_V2.version);
  });

  it.each([
    'import',
    'introduce',
  ] as const)('restores authority before a denied %s can run again', async (command) => {
    const user = userEvent.setup();
    const error = privateError(403, 'workspace_access_denied', `${command}-denied-private failure`);
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce(
        ListWorkspacesResponseSchema.parse({ items: [WORKSPACE, WORKSPACE_B] })
      )
      .mockResolvedValueOnce(
        ListWorkspacesResponseSchema.parse({ items: [WORKSPACE, WORKSPACE_B] })
      );
    const importWorkspaceArtifact = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(IMPORT_MUTATION);
    const introduceWorkspaceArtifact = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(INTRODUCE_MUTATION);
    renderApp(
      '/artifacts',
      makeClient({
        core: { listWorkspaces },
        app: { importWorkspaceArtifact, introduceWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    if (command === 'import') {
      await submitImport(user);
    } else {
      await chooseIntroduceThread(user);
      await user.click(screen.getByRole('button', { name: /introduce into thread/i }));
    }

    const mutation = command === 'import' ? importWorkspaceArtifact : introduceWorkspaceArtifact;
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    const first =
      command === 'import'
        ? acceptedImport(importWorkspaceArtifact)
        : acceptedIntroduce(introduceWorkspaceArtifact);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/access denied/i);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent('workspace_access_denied');
    const action = screen.getByRole('button', {
      name: command === 'import' ? /^import$/i : /introduce into thread/i,
    });
    expect(action).toBeDisabled();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(mutation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(action).toBeEnabled());

    await user.click(action);
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    const next =
      command === 'import'
        ? acceptedImport(importWorkspaceArtifact, 1)
        : acceptedIntroduce(introduceWorkspaceArtifact, 1);
    expect(next.requestId).not.toBe(first.requestId);
  });

  it('keeps a pending import settlement bound to its source Workspace across a switch', async () => {
    const user = userEvent.setup();
    const importRead = createDeferred<typeof IMPORT_MUTATION>();
    const importWorkspaceArtifact = vi.fn().mockReturnValue(importRead.promise);
    const { client } = renderApp('/artifacts', makeClient({ app: { importWorkspaceArtifact } }));

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await submitImport(user);
    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1));
    const ws1Command = acceptedImport(importWorkspaceArtifact);

    act(() => {
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id });
    });
    expect(await screen.findByText(ARTIFACT_B.title)).toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.title)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi.mocked(client.core.listArtifacts).mock.calls.some((call) => call[0] === WORKSPACE_B.id)
      ).toBe(true)
    );

    await user.click(screen.getByRole('button', { name: /import artifact/i }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ops import draft');
    importRead.resolve(IMPORT_MUTATION);
    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Ops import draft');
    expect(screen.queryByText(IMPORT_MUTATION.artifactId)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_TITLE)).not.toBeInTheDocument();
    expect(ws1Command.requestId).toEqual(expect.any(String));
    expect(client.app.introduceWorkspaceArtifact).not.toHaveBeenCalled();
  });

  it('clears a selected-Artifact introduction error when switching Artifacts', async () => {
    const user = userEvent.setup();
    const introduceWorkspaceArtifact = vi
      .fn()
      .mockRejectedValue(privateError(409, 'conflict', 'artifact-a-private failure'));
    renderApp('/artifacts', makeClient({ app: { introduceWorkspaceArtifact } }));

    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await chooseIntroduceThread(user);
    await user.click(screen.getByRole('button', { name: /introduce into thread/i }));
    await waitFor(() => expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /conflict|changed|expected version/i
    );
    expect(screen.queryByText('artifact-a-private failure')).not.toBeInTheDocument();

    await openArtifact(user, ARTIFACT.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('artifact-a-private failure')).not.toBeInTheDocument();
    expect(introduceWorkspaceArtifact).toHaveBeenCalledTimes(1);
  });

  it('keeps a turn-output Artifact ineligible for introduction after a Thread is selected', async () => {
    const user = userEvent.setup();
    const introduceWorkspaceArtifact = vi.fn();
    const { client } = renderApp('/artifacts', makeClient({ app: { introduceWorkspaceArtifact } }));

    expect(ARTIFACT.origin.kind).toBe('turn-output');
    expect(ARTIFACT.threadId).toBe('th_weekly');
    expect(ARTIFACT.turnId).toBe('tu_weekly');
    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await openArtifact(user, ARTIFACT.title);
    expect(await screen.findByText(ARTIFACT.content.body)).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(client.core.getArtifact).mock.calls).toEqual([[WORKSPACE.id, ARTIFACT.id]])
    );

    await selectListedOption(user, 'Thread', THREAD_NAME);
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();
    expect(introduceWorkspaceArtifact).not.toHaveBeenCalled();
    assertNoLeakedInternals();
  });

  it.each([
    {
      name: 'the exact Artifact read is still loading',
      getArtifact: () => new Promise(() => {}),
      afterOpen: async () => {
        await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
      },
    },
    {
      name: 'the exact Artifact read failed',
      getArtifact: () => Promise.reject(new Error('artifact-read-private failure')),
      afterOpen: async () => {
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/couldn't load that artifact/i);
        expect(alert).not.toHaveTextContent('artifact-read-private failure');
      },
    },
    {
      name: 'the exact Artifact version disagrees with the list row',
      getArtifact: () => Promise.resolve(IMPORTED_ARTIFACT_V2),
      afterOpen: async (getArtifact: ReturnType<typeof vi.fn>) => {
        await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(/revised edition/i)).not.toBeInTheDocument();
        expect(screen.getByText(/version 1/i)).toBeInTheDocument();
      },
    },
  ])('disables introduction while $name', async ({ getArtifact, afterOpen }) => {
    const user = userEvent.setup();
    const artifactRead = vi.fn().mockImplementation(getArtifact);
    const introduceWorkspaceArtifact = vi.fn();
    renderApp(
      '/artifacts',
      makeClient({
        core: {
          listArtifacts: vi
            .fn()
            .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [IMPORTED_ARTIFACT] })),
          getArtifact: artifactRead,
        },
        app: { introduceWorkspaceArtifact },
      })
    );

    expect(IMPORTED_ARTIFACT.origin.kind).toBe('imported');
    expect(IMPORTED_ARTIFACT.threadId).toBeNull();
    expect(IMPORTED_ARTIFACT.turnId).toBeNull();
    expect(await screen.findByText(IMPORTED_ARTIFACT.title)).toBeInTheDocument();
    await openArtifact(user, IMPORTED_ARTIFACT.title);
    await afterOpen(artifactRead);
    await selectListedOption(user, 'Thread', THREAD_NAME);
    expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();
    expect(introduceWorkspaceArtifact).not.toHaveBeenCalled();
    expect(artifactRead.mock.calls).toEqual([[WORKSPACE.id, IMPORTED_ARTIFACT.id]]);
    assertNoLeakedInternals();
  });

  it.each([
    {
      name: 'the Turn is not completed',
      turn: (requestId: string) =>
        introduceTurn(matchedIntroduceItem(requestId), { status: 'running' }),
    },
    {
      name: 'the Turn id disagrees with the receipt',
      turn: (requestId: string) =>
        introduceTurn(matchedIntroduceItem(requestId), { id: 'tu_other' }),
    },
    {
      name: 'the Turn workspace disagrees with the request',
      turn: (requestId: string) =>
        introduceTurn(matchedIntroduceItem(requestId), { workspaceId: WORKSPACE_B.id }),
    },
    {
      name: 'the Turn thread disagrees with the request',
      turn: (requestId: string) =>
        introduceTurn(matchedIntroduceItem(requestId), { threadId: THREAD_B.id }),
    },
    {
      name: 'the Turn has an extra artifact-reference Item',
      turn: (requestId: string) =>
        introduceTurn(matchedIntroduceItem(requestId), {
          extraItems: [
            introduceItem({
              id: 'it_intro_extra',
              artifactId: ARTIFACT.id,
              artifactVersion: ARTIFACT.version,
              lastMutationRequestId: 'req_unrelated_communication',
              title: DISTRACTOR_TITLE,
              summary: DISTRACTOR_SUMMARY,
            }),
          ],
        }),
    },
    {
      name: 'the completed Item thread disagrees with the request',
      turn: (requestId: string) =>
        introduceTurn(
          introduceItem({
            id: INTRODUCE_MUTATION.itemId,
            artifactId: INTRODUCE_MUTATION.artifactId,
            artifactVersion: INTRODUCE_MUTATION.artifactVersion,
            lastMutationRequestId: requestId,
            title: IMPORTED_ARTIFACT.title,
            summary: IMPORTED_ARTIFACT.summary,
            threadId: THREAD_B.id,
          })
        ),
    },
    {
      name: 'the completed Item workspace disagrees with the request',
      turn: (requestId: string) => {
        const item = introduceItem({
          id: INTRODUCE_MUTATION.itemId,
          artifactId: INTRODUCE_MUTATION.artifactId,
          artifactVersion: INTRODUCE_MUTATION.artifactVersion,
          lastMutationRequestId: requestId,
          title: IMPORTED_ARTIFACT.title,
          summary: IMPORTED_ARTIFACT.summary,
          workspaceId: WORKSPACE_B.id,
        });
        const turn = introduceTurn(item);
        expect(item.workspaceId).toBe(WORKSPACE_B.id);
        expect(turn.workspaceId).toBe(WORKSPACE.id);
        expect(item.workspaceId).not.toBe(turn.workspaceId);
        return turn;
      },
    },
    {
      name: 'the Turn has an extra non-artifact-reference Item',
      turn: (requestId: string) => {
        const extra = extraNonArtifactItem();
        expect(extra.type).not.toBe('artifact-reference');
        const turn = introduceTurn(matchedIntroduceItem(requestId), { extraItems: [extra] });
        expect(turn.items).toHaveLength(2);
        expect(turn.items[1]).toEqual(extra);
        return turn;
      },
    },
  ])('fail-closes introduction when $name', async ({ turn }) => {
    const user = userEvent.setup();
    const { command, getTurn, introduceWorkspaceArtifact, turnRead } =
      await startImportedIntroduction(user);

    await act(async () => {
      turnRead.resolve(turn(command.requestId));
    });
    expect(getTurn).toHaveBeenCalledTimes(1);
    await assertFailClosedIntroductionRecovery(introduceWorkspaceArtifact);
  });

  it.each([
    {
      code: 'invalid_request' as const,
      message: /invalid/i,
      status: 400,
    },
    {
      code: 'source_digest_mismatch' as const,
      message: /digest|mismatch/i,
      status: 400,
    },
  ])('continues a $code import from corrected input under a new requestId', async ({
    code,
    message,
    status,
  }) => {
    const user = userEvent.setup();
    const { first, importWorkspaceArtifact } = await startTypedCommandFailure(
      user,
      'import',
      privateError(status, code, `${code}-private failure`),
      true
    );
    if (!('contentDigest' in first)) throw new Error('expected an Artifact import command');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent(code);
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(IMPORT_TITLE);
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveValue(IMPORT_CONTENT);

    const content = screen.getByRole('textbox', { name: 'Content' });
    await user.clear(content);
    await user.click(content);
    await user.paste(IMPORT_CONTENT_V2);
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(2));
    const next = acceptedImport(importWorkspaceArtifact, 1);
    expect(next.requestId).not.toBe(first.requestId);
    expect(next).toMatchObject({
      title: IMPORT_TITLE,
      mediaType: 'text/markdown',
      content: IMPORT_CONTENT_V2,
    });
    expect(next.contentDigest).not.toBe(first.contentDigest);
    assertNoLeakedInternals();
  });

  it.each([
    {
      command: 'import' as const,
      status: 409,
      code: 'recovery_required',
      message: /recovery required/i,
    },
    {
      command: 'introduce' as const,
      status: 400,
      code: 'invalid_request',
      message: /invalid/i,
    },
    {
      command: 'introduce' as const,
      status: 409,
      code: 'recovery_required',
      message: /recovery required/i,
    },
  ])('fail-closes typed $command $code without a mutation retry', async ({
    command,
    status,
    code,
    message,
  }) => {
    const user = userEvent.setup();
    const { mutation } = await startTypedCommandFailure(
      user,
      command,
      privateError(status, code, `${code}-private failure`),
      false
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent(code);
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    if (command === 'import') {
      expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
    } else {
      expect(screen.getByRole('button', { name: /introduce into thread/i })).toBeDisabled();
      expect(
        screen.queryByText(new RegExp(`introduced into ${THREAD_NAME}`, 'i'))
      ).not.toBeInTheDocument();
    }
    expect(mutation).toHaveBeenCalledTimes(1);
    assertNoLeakedInternals();
  });

  it.each([
    'import',
    'introduce',
  ] as const)('retries $command idempotency_key_conflict only after refresh and a new explicit request', async (command) => {
    const user = userEvent.setup();
    const {
      first,
      getArtifact,
      importWorkspaceArtifact,
      introduceWorkspaceArtifact,
      listArtifacts,
      mutation,
    } = await startTypedCommandFailure(
      user,
      command,
      privateError(409, 'idempotency_key_conflict', 'idempotency_key_conflict-private failure'),
      true
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/conflict/i);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent('idempotency_key_conflict');

    const readsBeforeRetry = listArtifacts.mock.calls.length + getArtifact.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(listArtifacts.mock.calls.length + getArtifact.mock.calls.length).toBeGreaterThan(
        readsBeforeRetry
      )
    );
    expect(mutation).toHaveBeenCalledTimes(1);

    const action = screen.getByRole('button', {
      name: command === 'import' ? /^import$/i : /introduce into thread/i,
    });
    await user.click(action);
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    const next =
      command === 'import'
        ? acceptedImport(importWorkspaceArtifact, 1)
        : acceptedIntroduce(introduceWorkspaceArtifact, 1);
    expect(next.requestId).not.toBe(first.requestId);
    assertNoLeakedInternals();
  });

  it.each([
    { name: 'Markdown', request: MULTILINE_MARKDOWN_IMPORT },
    { name: 'plain text', request: MULTILINE_PLAIN_IMPORT },
    { name: 'JSON', request: MULTILINE_JSON_IMPORT },
  ])('imports exact multiline $name through an accessible textarea', async ({ request }) => {
    const user = userEvent.setup();
    const importWorkspaceArtifact = vi.fn().mockResolvedValue(IMPORT_MUTATION);
    renderApp(
      '/artifacts',
      makeClient({
        core: {
          listArtifacts: vi
            .fn()
            .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] })),
        },
        app: { importWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await submitMultilineImport(user, {
      title: request.title,
      mediaType: request.mediaType,
      content: request.content,
    });

    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1));
    expect(acceptedImport(importWorkspaceArtifact)).toMatchObject({
      title: request.title,
      mediaType: request.mediaType,
      content: request.content,
      contentDigest: request.contentDigest,
      requestId: expect.any(String),
    });
    assertNoLeakedInternals();
  });

  it('retains cached Artifact rows when an authoritative list refetch rejects', async () => {
    const user = userEvent.setup();
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] }))
      .mockRejectedValueOnce(new Error('list-refetch-private failure'))
      .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] }));
    const importWorkspaceArtifact = vi.fn().mockResolvedValue(IMPORT_MUTATION);
    renderApp(
      '/artifacts',
      makeClient({ core: { listArtifacts }, app: { importWorkspaceArtifact } })
    );

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await submitImport(user);
    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(2));

    expect(screen.getByText(ARTIFACT.title)).toBeInTheDocument();
    expect(screen.queryByText(IMPORT_MUTATION.artifactId)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_TITLE)).not.toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load artifacts|status may be stale/i);
    expect(alert).not.toHaveTextContent('list-refetch-private failure');
    expect(screen.getByRole('button', { name: /import artifact/i })).toBeDisabled();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(3));
    expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(listArtifacts.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id], [WORKSPACE.id]]);
    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /import artifact/i })).toBeEnabled()
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    assertNoLeakedInternals();
  });

  it('fail-closes cached Artifact content after a denied list refetch and recovers through Workspace discovery', async () => {
    const user = userEvent.setup();
    const recoveredArtifacts =
      createDeferred<ReturnType<typeof ListArtifactsResponseSchema.parse>>();
    const listWorkspaces = vi
      .fn()
      .mockResolvedValue(ListWorkspacesResponseSchema.parse({ items: [WORKSPACE, WORKSPACE_B] }));
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] }))
      .mockRejectedValueOnce(
        privateError(403, 'workspace_access_denied', 'list-refetch-denied-private failure')
      )
      .mockReturnValueOnce(recoveredArtifacts.promise);
    const getArtifact = vi.fn().mockResolvedValue(ARTIFACT);
    const importWorkspaceArtifact = vi.fn().mockResolvedValue(IMPORT_MUTATION);
    renderApp(
      '/artifacts',
      makeClient({
        core: { listWorkspaces, listArtifacts, getArtifact },
        app: { importWorkspaceArtifact },
      })
    );

    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    expect(screen.getByText(ARTIFACT.summary as string)).toBeInTheDocument();
    await openArtifact(user, ARTIFACT.title);
    expect(await screen.findByText(ARTIFACT.content.body)).toBeInTheDocument();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    await submitImport(user);
    await waitFor(() => expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(2));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/access denied/i);
    expect(alert).not.toHaveTextContent(/private failure/i);
    expect(alert).not.toHaveTextContent('workspace_access_denied');
    expect(screen.queryByText(ARTIFACT.title)).not.toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.summary as string)).not.toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.content.body)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_MUTATION.artifactId)).not.toBeInTheDocument();
    expect(screen.queryByText(IMPORT_TITLE)).not.toBeInTheDocument();
    for (const name of [/import artifact/i, /introduce into thread/i, /^import$/i]) {
      const action = screen.queryByRole('button', { name });
      if (action) expect(action).toBeDisabled();
    }
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    assertNoLeakedInternals();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(3));
    expect(importWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(ARTIFACT.title)).not.toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.summary as string)).not.toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.content.body)).not.toBeInTheDocument();
    expect(screen.queryByText('list-refetch-denied-private failure')).not.toBeInTheDocument();

    recoveredArtifacts.resolve(ListArtifactsResponseSchema.parse({ items: [ARTIFACT] }));
    expect(await screen.findByText(ARTIFACT.title)).toBeInTheDocument();
    expect(screen.getByText(ARTIFACT.summary as string)).toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT.content.body)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /import artifact/i })).toBeEnabled()
    );
    await openArtifact(user, ARTIFACT.title);
    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(ARTIFACT.content.body)).toBeInTheDocument();
    assertNoLeakedInternals();
  });
});
