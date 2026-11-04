import type { CoreClient } from '@openkit/core-client';
import {
  ArtifactSchema,
  ListArtifactsResponseSchema,
  ListThreadsResponseSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';

const TIMESTAMP = '2026-10-20T09:00:00.000Z';

const WORKSPACE = WorkspaceRecordSchema.parse({
  id: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
  name: 'Market research',
  kind: 'research',
  status: 'active',
  counts: { threadCount: 0, artifactCount: 3, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const IMAGE_TITLE = 'Quarterly chart';
const IMAGE_ID = 'ar_00000000-0000-7c11-8e01-3f5d7a9b2c40';
const IMAGE_DIGEST = `sha256:${'1'.repeat(64)}`;

const PDF_TITLE = 'Quarterly report';
const PDF_ID = 'ar_00000000-0000-7a11-9c7e-4d2f6b8a1c35';
const PDF_DIGEST = `sha256:${'2'.repeat(64)}`;
const PDF_MEDIA_TYPE = 'application/pdf';
const PDF_SIZE = 12_345;

const REPORT_TITLE = 'Runbook notes';
const REPORT_ID = 'ar_00000000-0000-7d22-8b3a-5e6f7c8d9a01';
const REPORT_DIGEST = `sha256:${'3'.repeat(64)}`;

type Artifact = ReturnType<typeof ArtifactSchema.parse>;

/** Imported binary artifact with an exact media type and byte length. */
function importedFile(input: {
  id: string;
  title: string;
  mediaType: string;
  byteLength: number;
  digest: string;
  requestId: string;
}): Artifact {
  return ArtifactSchema.parse({
    id: input.id,
    workspaceId: WORKSPACE.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: input.title,
    status: 'ready',
    summary: null,
    version: 1,
    content: {
      format: 'file',
      mediaType: input.mediaType,
      byteLength: input.byteLength,
    },
    contentDigest: input.digest,
    lastMutationRequestId: input.requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: input.requestId,
      sourceDigest: input.digest,
      actor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
      requestId: input.requestId,
      recordedAt: TIMESTAMP,
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
}

/** Work-produced report artifact used to prove filtering by kind. */
function reportArtifact(): Artifact {
  return ArtifactSchema.parse({
    id: REPORT_ID,
    workspaceId: WORKSPACE.id,
    threadId: 'th_00000000-0000-7795-b51b-fdaf75668bc1',
    turnId: 'tu_00000000-0000-7995-899e-1efea8c86c29',
    kind: 'report',
    title: REPORT_TITLE,
    status: 'ready',
    summary: 'Operator notes.',
    version: 1,
    content: { format: 'markdown', body: '# Runbook notes' },
    contentDigest: REPORT_DIGEST,
    lastMutationRequestId: 'req_runbook',
    origin: {
      kind: 'turn-output',
      threadId: 'th_00000000-0000-7795-b51b-fdaf75668bc1',
      turnId: 'tu_00000000-0000-7995-899e-1efea8c86c29',
      requestId: 'req_runbook',
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
}

const IMAGE = importedFile({
  id: IMAGE_ID,
  title: IMAGE_TITLE,
  mediaType: 'image/png',
  byteLength: 2_048,
  digest: IMAGE_DIGEST,
  requestId: 'req_chart',
});
const PDF = importedFile({
  id: PDF_ID,
  title: PDF_TITLE,
  mediaType: PDF_MEDIA_TYPE,
  byteLength: PDF_SIZE,
  digest: PDF_DIGEST,
  requestId: 'req_report',
});
const REPORT = reportArtifact();

type MethodOverrides = Partial<Record<string, unknown>>;

/** Build a fake CoreClient over one exact artifact list. */
function makeClient(artifacts: Artifact[], overrides: { operations?: MethodOverrides } = {}) {
  const client = {
    core: { meta: vi.fn().mockResolvedValue({}) },
    app: {},
    artifactFiles: {
      import: vi.fn().mockResolvedValue({ artifactId: PDF_ID, artifactVersion: 1 }),
      browserDownloadUrl: ({
        artifactId,
        artifactVersion,
      }: {
        artifactId: string;
        artifactVersion: number;
      }) => `/download/${artifactId}/${artifactVersion}`,
    },
    operations: {
      'thread.list': vi.fn().mockResolvedValue(ListThreadsResponseSchema.parse({ items: [] })),
      'artifact.list': vi
        .fn()
        .mockResolvedValue(ListArtifactsResponseSchema.parse({ items: artifacts })),
      'artifact.read': vi.fn().mockImplementation(({ artifactId }: { artifactId: string }) => {
        const record = artifacts.find((item) => item.id === artifactId);
        return record
          ? Promise.resolve(record)
          : Promise.reject(new Error(`Artifact not found: ${artifactId}`));
      }),
      'artifact.version-list': vi.fn().mockResolvedValue({ items: [] }),
      'artifact.import': vi.fn(),
      'artifact.introduce': vi.fn(),
      'turn.read': vi.fn(),
      ...overrides.operations,
      'workspace.list': vi.fn().mockResolvedValue({
        items: [
          {
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace: WORKSPACE,
            isOwner: true,
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          },
        ],
      }),
    },
  } as unknown as CoreClient;
  return client;
}

/** Render the product route that hosts the Artifacts screen. */
function renderApp(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/artifacts']}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return { client, queryClient };
}

/** Open one listed artifact by its product title. */
async function openArtifact(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(title) }));
}

/** The Download control, whether the screen renders it as a link or a button. */
function downloadControl() {
  return (
    screen.queryByRole('link', { name: /download/i }) ??
    screen.queryByRole('button', { name: /download/i })
  );
}

describe('artifact preview by media type', () => {
  it('renders an image for an image fixture', async () => {
    const user = userEvent.setup();
    renderApp(makeClient([IMAGE]));
    await openArtifact(user, IMAGE_TITLE);
    const images = await screen.findAllByRole('img');
    expect(
      images.some(
        (image) =>
          (image.getAttribute('src') ?? '').includes(IMAGE_ID) ||
          (image.getAttribute('alt') ?? '').includes(IMAGE_TITLE)
      )
    ).toBe(true);
  });

  it('renders name, size, and Download for a pdf fixture without a page image', async () => {
    const user = userEvent.setup();
    renderApp(makeClient([PDF]));
    await openArtifact(user, PDF_TITLE);
    await waitFor(() => expect(screen.getAllByText(PDF_TITLE).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/\d[\d.,]*\s?(?:bytes|B|KB|MB)/i).length).toBeGreaterThan(0);
    expect(downloadControl()).not.toBeNull();
    expect(
      screen
        .queryAllByRole('img')
        .some(
          (image) =>
            (image.getAttribute('src') ?? '').includes(PDF_ID) ||
            (image.getAttribute('alt') ?? '').includes(PDF_TITLE)
        )
    ).toBe(false);
  });
});

describe('artifact import action', () => {
  it('offers no Media type field and names the import action Import', async () => {
    const user = userEvent.setup();
    renderApp(makeClient([IMAGE, PDF, REPORT]));
    await screen.findByText(IMAGE_TITLE);
    const importAction = screen.getByRole('button', { name: 'Import' });
    await user.click(importAction);
    expect(screen.queryByRole('textbox', { name: 'Media type' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Import' }).length).toBeGreaterThan(0);
  });
});

describe('artifact list filter', () => {
  it('matches title and kind and hides a non-matching title', async () => {
    const user = userEvent.setup();
    renderApp(makeClient([IMAGE, PDF, REPORT]));
    await screen.findByText(IMAGE_TITLE);
    const filter = screen.getByLabelText(/filter/i);

    await user.type(filter, 'file');
    expect(screen.queryByText(REPORT_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText(IMAGE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(PDF_TITLE)).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, 'chart');
    expect(screen.getByText(IMAGE_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(REPORT_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(PDF_TITLE)).not.toBeInTheDocument();
  });
});

describe('artifact details', () => {
  it('hides the media type, digest, and raw id until Details is opened', async () => {
    const user = userEvent.setup();
    renderApp(makeClient([PDF]));
    await openArtifact(user, PDF_TITLE);

    expect(screen.queryByText(/application\/pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sha256:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ar_00000000-0000-7a11/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^details$/i }));

    expect(screen.getByText(/application\/pdf/)).toBeInTheDocument();
    expect(screen.getByText(/sha256:/)).toBeInTheDocument();
    expect(screen.getByText(/ar_00000000-0000-7a11/)).toBeInTheDocument();
  });
});

describe('artifact list pagination', () => {
  it('offers no next-page or load-more control without a list cursor', async () => {
    renderApp(makeClient([IMAGE, PDF, REPORT]));
    await screen.findByText(IMAGE_TITLE);
    expect(
      screen.queryByRole('button', { name: /next page|load more|show more|more artifacts/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /next page|load more|show more|more artifacts/i })
    ).not.toBeInTheDocument();
  });
});
