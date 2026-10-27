import {
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  WorkspaceExportResponseSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
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
import { chatKeys } from '../chat/data';
import { settingsKeys } from '../settings/data';
import { useWorkspaceStore } from '../workspace-store';
import { encodeVaultMaterial, workspaceExportArchiveHref } from './data';
import portabilityDataSource from './data.ts?raw';
import portabilityScreenSource from './PortabilityScreen.tsx?raw';

/** Serializes one export JSON file the way NanoCore `writeJson` writes it. */
function serializeExportJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const TIMESTAMP = '2026-08-29T02:00:00.000Z';
const VAULT_MATERIAL = 'café-密钥';
const VAULT_MATERIAL_BASE64 = btoa(
  String.fromCharCode(...new TextEncoder().encode(VAULT_MATERIAL))
);
const ASCII_VAULT_MATERIAL = 'vault-material';
const ASCII_VAULT_MATERIAL_BASE64 = btoa(ASCII_VAULT_MATERIAL);
const WORKSPACE = {
  id: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
  name: 'Market research',
  kind: 'general',
} as const;
const WORKSPACE_B = {
  id: 'ws_00000000-0000-7ec6-8e33-a3b1d758efc6',
  name: 'Second workspace',
  kind: 'general',
} as const;
const PERSONAL_WORKSPACE = {
  id: 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
  name: 'Personal',
  kind: 'personal',
} as const;
const EXPORT_ID = 'wsexp_00000000-0000-7569-b23e-40ca1402f214';
const WORKSPACE_EXPORT_FILE_BYTES = serializeExportJson({
  id: WORKSPACE.id,
  name: WORKSPACE.name,
  kind: WORKSPACE.kind,
  status: 'active',
  counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});
const FILE_DIGEST = 'sha256:0f141fbf15bd9400f2152ee0738383b2d713f6502cd98f8ee72951843f632197';
const FILE_BYTES = new TextEncoder().encode(WORKSPACE_EXPORT_FILE_BYTES).byteLength;
const CONTENT_INVENTORY = [
  {
    path: 'records/ws_00000000-0000-70f9-a923-618c488a4651.json',
    digest: FILE_DIGEST,
    bytes: FILE_BYTES,
  },
];
const CONTENT_DIGEST = 'sha256:0cd2fa898af279bb1179b690909444b73031fa36d246fa4037346c598ca2c9f5';
const REBIND_REQUEST = VaultAdminRebindWorkspaceReferenceRequestSchema.parse({
  materialBase64: VAULT_MATERIAL_BASE64,
});
const ASCII_REBIND_REQUEST = VaultAdminRebindWorkspaceReferenceRequestSchema.parse({
  materialBase64: ASCII_VAULT_MATERIAL_BASE64,
});

const MANIFEST = {
  schemaVersion: 1,
  recordType: 'workspace-export' as const,
  id: EXPORT_ID,
  ownerScope: 'workspace' as const,
  lineage: { workspaceId: WORKSPACE.id },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  contentDigest: CONTENT_DIGEST,
  redactionLevel: 'metadata' as const,
  sensitivity: 'internal' as const,
  requiredFeatures: [] as string[],
  extensions: {},
  sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
  workspaceId: WORKSPACE.id,
  exportCreatedAt: TIMESTAMP,
  exportFormatVersion: 3 as const,
  contentInventory: CONTENT_INVENTORY,
};

const EXPORT_RESULT = WorkspaceExportResponseSchema.parse({
  exportId: EXPORT_ID,
  workspaceId: WORKSPACE.id,
  manifest: MANIFEST,
  fileCount: 1,
  totalBytes: FILE_BYTES,
  checkedFiles: ['records/ws_00000000-0000-70f9-a923-618c488a4651.json'],
});

const UNBOUND_REFERENCE = {
  backendKind: 'encrypted-file' as const,
  currentVersion: 0,
  ownerScope: 'workspace' as const,
  referenceId: 'vault_00000000-0000-767a-8491-216d8363929d',
  secretKind: 'repository-credential',
  status: 'unbound' as const,
  workspaceId: WORKSPACE.id,
};

const UNBOUND_SAME_KIND = {
  ...UNBOUND_REFERENCE,
  referenceId: 'vault_00000000-0000-7527-84d6-f93e78bfd616',
};

const REBOUND_REFERENCE = {
  ...UNBOUND_REFERENCE,
  currentVersion: 1,
  status: 'active' as const,
};

const VAULT_LIST = VaultAdminListWorkspaceReferencesResponseSchema.parse({
  workspaceId: WORKSPACE.id,
  items: [UNBOUND_REFERENCE],
});

const TWO_UNBOUND_VAULT = VaultAdminListWorkspaceReferencesResponseSchema.parse({
  workspaceId: WORKSPACE.id,
  items: [UNBOUND_REFERENCE, UNBOUND_SAME_KIND],
});

const EMPTY_VAULT = VaultAdminListWorkspaceReferencesResponseSchema.parse({
  workspaceId: WORKSPACE.id,
  items: [],
});

const EMPTY_VAULT_B = VaultAdminListWorkspaceReferencesResponseSchema.parse({
  workspaceId: WORKSPACE_B.id,
  items: [],
});

const REBOUND_LIST = VaultAdminListWorkspaceReferencesResponseSchema.parse({
  workspaceId: WORKSPACE.id,
  items: [REBOUND_REFERENCE],
});

const REBIND_MUTATION = VaultAdminRebindWorkspaceReferenceResponseSchema.parse({
  backendKind: 'encrypted-file',
  currentVersion: 1,
  ownerScope: 'workspace',
  referenceId: UNBOUND_REFERENCE.referenceId,
  secretKind: 'repository-credential',
  status: 'active',
  workspaceId: WORKSPACE.id,
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

/** Typed failure whose private message must never reach the DOM. */
function privateFailure(status: number, code: string) {
  return new ApiCallError(status, 'portability-private failure', { code });
}

/** Empty grant list matching the Settings Vault hook's companion read. */
function emptyVaultGrants(workspaceId: string) {
  return { workspaceId, items: [] };
}

/** Empty use-record list matching the Settings Vault hook's companion read. */
function emptyVaultUses(workspaceId: string) {
  return { workspaceId, vaultUseRecords: [] };
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(
  overrides: { operations?: MethodOverrides; core?: MethodOverrides; app?: MethodOverrides } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),

      ...overrides.core,
    },
    app: {
      downloadWorkspaceExportArchive: vi.fn(),
      ...overrides.app,
    },

    operations: {
      'vault.reference-list': vi.fn().mockResolvedValue(VAULT_LIST),
      'vault.grant-list': vi
        .fn()
        .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
          Promise.resolve(emptyVaultGrants(workspaceId))
        ),
      'vault.use-list': vi
        .fn()
        .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
          Promise.resolve(emptyVaultUses(workspaceId))
        ),
      'vault.reference-rebind': vi.fn().mockResolvedValue(REBIND_MUTATION),
      'workspace.export': vi.fn().mockResolvedValue(EXPORT_RESULT),
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'attention.list': vi.fn().mockResolvedValue({ items: [] }),
      'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.operations,
      'workspace.list': vi
        .fn()
        .mockResolvedValueOnce({
          items: [WORKSPACE].map((workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            isOwner: true,
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })),
        })
        .mockImplementation(
          (overrides.operations?.['workspace.list'] as
            | CoreClient['operations']['workspace.list']
            | undefined) ??
            vi.fn().mockResolvedValue({
              items: [WORKSPACE].map((workspace) => ({
                membershipStatus: 'active' as const,
                accessCause: 'membership' as const,
                workspace,
                isOwner: true,
                membershipRevision: 1,
                ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
                registryRevision: 1,
              })),
            })
        ),
    },
  } as unknown as CoreClient;
}

/** Renders production routes with a caller-selected query freshness policy. */
function renderApp(
  path: string,
  client: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
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

/** Confirms the explicit Vault rebind dialog; Rebind itself must not submit. */
async function confirmRebind(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog', { name: /confirm/i });
  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
}

/** Returns the Vault material control after proving it is a password field. */
function vaultMaterialInput() {
  const input = screen.getByLabelText('Vault material');
  expect(input).toHaveAttribute('type', 'password');
  return input;
}

/** Accessible Rebind control for one public-schema secretKind and reference identity. */
function rebindControl(
  secretKind = UNBOUND_REFERENCE.secretKind,
  referenceId = UNBOUND_REFERENCE.referenceId
) {
  return screen.getByRole('button', {
    name: `Rebind ${secretKind} ${referenceId}`,
  });
}

/** Serializes TanStack retention so Vault material can be proven absent from cache. */
function retainedPortabilityState(queryClient: QueryClient) {
  return JSON.stringify({
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => ({
        data: mutation.state.data,
        variables: mutation.state.variables,
      })),
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({
        key: query.queryKey,
        data: query.state.data,
      })),
  });
}

function vaultQueryKeys(queryClient: QueryClient) {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter(
      (key) => Array.isArray(key) && key.some((part) => part === 'vault' || part === 'portability')
    );
}

function assertNoLeakedInternals(queryClient: QueryClient, surface: 'all' | 'cache' = 'all') {
  const serializedDom = document.documentElement.outerHTML;
  const retained = retainedPortabilityState(queryClient);
  const inspected = surface === 'all' ? [serializedDom, retained] : [retained];
  for (const text of inspected) {
    expect(text).not.toContain(VAULT_MATERIAL);
    expect(text).not.toContain(VAULT_MATERIAL_BASE64);
    expect(text).not.toContain(ASCII_VAULT_MATERIAL);
    expect(text).not.toContain(ASCII_VAULT_MATERIAL_BASE64);
  }
  if (surface === 'all') {
    expect(serializedDom).not.toMatch(/"items"\s*:/);
  }
  for (const mutation of queryClient.getMutationCache().getAll()) {
    const variables = mutation.state.variables;
    if (variables && typeof variables === 'object') {
      expect(variables).not.toHaveProperty('materialBase64');
    }
  }
}

/** Same-origin encoded archive href bound to one Workspace export. */
function expectDownloadArchiveLink(workspaceId: string, exportId: string) {
  const link = screen.getByRole('link', { name: 'Download archive (opens in a new tab)' });
  expect(link).toHaveAttribute('href', workspaceExportArchiveHref(workspaceId, exportId));
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.getAttribute('rel') ?? '').toMatch(/\bnoopener\b/);
  return link;
}

function expectVaultUiAbsent(client: CoreClient) {
  expect(screen.queryByRole('button', { name: 'Export workspace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /rebind/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
  expect(client.operations['workspace.export']).not.toHaveBeenCalled();
  expect(client.operations['vault.reference-list']).not.toHaveBeenCalled();
  expect(client.operations['vault.grant-list']).not.toHaveBeenCalled();
  expect(client.operations['vault.use-list']).not.toHaveBeenCalled();
  expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Portability', () => {
  it('does not expose ordinary workspace import entry points', async () => {
    const production = `${portabilityDataSource}\n${portabilityScreenSource}`;
    expect(production).not.toMatch(/workspace\.import/);
    expect(production).not.toMatch(/ImportPanel/);
    expect(production).not.toMatch(/Portable archive/);
    renderApp('/settings/portability', makeClient());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import workspace' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Portable archive')).not.toBeInTheDocument();
  });

  it('renders a structured freeze refusal instead of a generic export banner', async () => {
    const user = userEvent.setup();
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    const refusal = {
      workspaceId: WORKSPACE.id,
      operation: 'archive' as const,
      retryable: false,
      blockers: [
        {
          kind: 'turn' as const,
          reason: 'active-work' as const,
          reference: { threadId, turnId },
          actions: [],
        },
      ],
    };
    const exportWorkspace = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'blocked', { code: 'workspace_blocked', details: refusal })
      );
    const client = makeClient({ operations: { 'workspace.export': exportWorkspace } });
    renderApp('/settings/portability', client);
    await user.click(await screen.findByRole('button', { name: 'Export workspace' }));
    expect(await screen.findByLabelText('Workspace blocked')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't export/i)).not.toBeInTheDocument();
  });

  it('shows administrator authority when export is refused with 403', async () => {
    const user = userEvent.setup();
    const exportWorkspace = vi.fn().mockRejectedValue(new ApiCallError(403, 'denied'));
    const client = makeClient({ operations: { 'workspace.export': exportWorkspace } });
    renderApp('/settings/portability', client);
    await user.click(await screen.findByRole('button', { name: 'Export workspace' }));
    expect(
      await screen.findByText('Workspace export requires administrator authority.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
  });

  it('reuses the shared Settings Vault hook rather than a Portability-owned vault query', () => {
    const production = `${portabilityDataSource}\n${portabilityScreenSource}`;
    expect(production).toMatch(
      /import\s*\{[\s\S]*?\buseVault\b[\s\S]*?\}\s*from\s*['"]\.\.\/settings(?:\/data)?['"]/
    );
    expect(production).toMatch(/\buseVault\s*\(/);
    expect(production).not.toMatch(/\busePortabilityVaultReferences\b/);
    expect(production).not.toMatch(/portabilityKeys\.vault/);
  });

  it('is a reachable administration surface for export and vault rebind', async () => {
    const user = userEvent.setup();
    const surface = surfaceById('portability');
    expect(surface).toMatchObject({
      title: 'Portability',
      path: '/settings/portability',
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(isSurfaceLive(surface!)).toBe(true);

    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_00000000-0000-72a2-a815-916a363a02e2' });
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('ws_00000000-0000-7b14-af76-27f19ffc88fa failure'))
      .mockResolvedValue({
        items: [WORKSPACE].map((workspace) => ({
          membershipStatus: 'active' as const,
          accessCause: 'membership' as const,
          workspace,
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      });
    const client = makeClient({ core: {}, operations: { 'workspace.list': listWorkspaces } });
    const { queryClient } = renderApp('/settings/portability', client);

    const loadAlert = await screen.findByRole('alert');
    expect(loadAlert).toHaveTextContent(/couldn't load workspaces/i);
    expect(loadAlert).not.toHaveTextContent('ws_00000000-0000-7b14-af76-27f19ffc88fa failure');
    expect(screen.getByRole('heading', { level: 1, name: 'Portability' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export workspace' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no project workspace selected/i)).not.toBeInTheDocument();
    await user.click(within(loadAlert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't exist/i)).not.toBeInTheDocument();

    expect(screen.getByText(WORKSPACE.name, { exact: true })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
        name: 'Portability',
      })
    ).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
    expect(
      screen.queryByRole('link', { name: 'Download archive (opens in a new tab)' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use server export' })).not.toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(UNBOUND_REFERENCE.secretKind, { exact: true })).toBeInTheDocument();
    expect(rebindControl()).toBeEnabled();
    expect(vaultMaterialInput()).toHaveValue('');
    expect(
      screen.queryByRole('button', {
        name: /exportWorkspace|dryRunWorkspaceImport|importWorkspace|rebindWorkspaceVaultReference/i,
      })
    ).toBeNull();
    assertNoLeakedInternals(queryClient);

    await waitFor(() => {
      expect(vi.mocked(client.operations['vault.reference-list']).mock.calls).toEqual([
        [{ workspaceId: WORKSPACE.id }],
      ]);
    });
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(
      vi.mocked(client.operations['vault.reference-list']).mock.invocationCallOrder[0]
    ).toBeGreaterThan(listWorkspaces.mock.invocationCallOrder[1]);
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
  });

  it('does not use a stored or first cached Workspace while discovery is stale-errored', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id });
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({
        items: [WORKSPACE, WORKSPACE_B].map((workspace) => ({
          membershipStatus: 'active' as const,
          accessCause: 'membership' as const,
          workspace,
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      })
      .mockRejectedValueOnce(new Error('ws_00000000-0000-7b14-af76-27f19ffc88fa failure'))
      .mockResolvedValue({
        items: [WORKSPACE, WORKSPACE_B].map((workspace) => ({
          membershipStatus: 'active' as const,
          accessCause: 'membership' as const,
          workspace,
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      });
    const client = makeClient({ core: {}, operations: { 'workspace.list': listWorkspaces } });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByRole('button', { name: 'Export workspace' })).toBeEnabled();
    expect(screen.getByText(WORKSPACE.name, { exact: true })).toBeInTheDocument();

    await queryClient.refetchQueries({ exact: true, queryKey: chatKeys.workspaces });
    const loadAlert = await screen.findByRole('alert');
    expect(loadAlert).toHaveTextContent(/couldn't load workspaces/i);
    expect(loadAlert).not.toHaveTextContent('ws_00000000-0000-7b14-af76-27f19ffc88fa failure');
    expect(screen.getByRole('heading', { level: 1, name: 'Portability' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).queryByRole('button', { name: 'Export workspace' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no project workspace selected/i)).not.toBeInTheDocument();

    await user.click(within(loadAlert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Export workspace' })).toBeEnabled();
    expect(screen.getByText(WORKSPACE.name, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('exports the selected Workspace and rebinds from an authoritative refetch', async () => {
    const user = userEvent.setup();
    const reboundVault = createDeferred<typeof REBOUND_LIST>();
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({
        items: [WORKSPACE].map((workspace) => ({
          membershipStatus: 'active' as const,
          accessCause: 'membership' as const,
          workspace,
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      })
      .mockResolvedValue({
        items: [WORKSPACE].map((workspace) => ({
          membershipStatus: 'active' as const,
          accessCause: 'membership' as const,
          workspace,
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      });
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockReturnValueOnce(reboundVault.promise);
    const client = makeClient({
      core: {},
      app: {},

      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'workspace.list': listWorkspaces,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));

    await waitFor(() =>
      expect(vi.mocked(client.operations['workspace.export']).mock.calls).toEqual([
        [{ workspaceId: WORKSPACE.id }],
      ])
    );
    expect(await screen.findByText(EXPORT_ID)).toBeInTheDocument();
    expect(screen.getByText('1 file', { exact: false })).toBeInTheDocument();
    expectDownloadArchiveLink(WORKSPACE.id, EXPORT_ID);
    expect(client.app.downloadWorkspaceExportArchive).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
    await user.type(vaultMaterialInput(), VAULT_MATERIAL);
    expect(vaultMaterialInput()).toHaveValue(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL_BASE64);
    await user.click(rebindControl());
    await confirmRebind(user);
    await waitFor(() =>
      expect(client.operations['vault.reference-rebind']).toHaveBeenCalledTimes(1)
    );
    expect(vi.mocked(client.operations['vault.reference-rebind']).mock.calls).toEqual([
      [
        {
          workspaceId: WORKSPACE.id,
          referenceId: UNBOUND_REFERENCE.referenceId,
          ...REBIND_REQUEST,
        },
      ],
    ]);
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(screen.queryByText('Active', { exact: true })).not.toBeInTheDocument();
    expect(vaultMaterialInput()).toHaveValue('');
    assertNoLeakedInternals(queryClient);

    reboundVault.resolve(REBOUND_LIST);
    expect(await screen.findByText('Active', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([
      [{ workspaceId: WORKSPACE.id }],
      [{ workspaceId: WORKSPACE.id }],
    ]);
    expect(client.operations['workspace.export']).toHaveBeenCalledTimes(1);
    expect(client.operations['vault.reference-rebind']).toHaveBeenCalledTimes(1);
    assertNoLeakedInternals(queryClient);
  });

  it('treats an uncertain export as a result-unknown outcome and requires an explicit new export action', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({
      items: [WORKSPACE].map((workspace) => ({
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        workspace,
        isOwner: true,
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        registryRevision: 1,
      })),
    });
    const exportWorkspace = vi.fn().mockRejectedValue(new Error('export-private failure'));
    const client = makeClient({
      core: {},
      app: {},
      operations: {
        'workspace.export': exportWorkspace,
        'workspace.list': listWorkspaces,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /(?:result is unknown|unknown result|not known whether[\s\S]{0,60}(?:completed|succeeded|finished))/i
    );
    expect(alert).not.toHaveTextContent(/inspect/i);
    expect(alert).not.toHaveTextContent('export-private failure');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /inspect/i })).not.toBeInTheDocument();
    expect(exportWorkspace.mock.calls).toEqual([[{ workspaceId: WORKSPACE.id }]]);
    expect(exportWorkspace).toHaveBeenCalledTimes(1);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    await waitFor(() =>
      expect(exportWorkspace.mock.calls).toEqual([
        [{ workspaceId: WORKSPACE.id }],
        [{ workspaceId: WORKSPACE.id }],
      ])
    );
    expect(
      within(screen.getByRole('alert')).queryByRole('button', { name: 'Try again' })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /inspect/i })).not.toBeInTheDocument();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('clears vault material after a typed rebind failure and requires inspection before a new action', async () => {
    const user = userEvent.setup();
    const listWorkspaceVaultReferences = vi.fn().mockResolvedValue(VAULT_LIST);
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockRejectedValue(privateFailure(400, 'vault_reference_rebind_failed'));
    const client = makeClient({
      app: {},
      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'vault.reference-rebind': rebindWorkspaceVaultReference,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    await user.click(rebindControl());
    await confirmRebind(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't rebind/i);
    expect(alert).not.toHaveTextContent('portability-private failure');
    expect(alert).not.toHaveTextContent('vault_reference_rebind_failed');
    expect(vaultMaterialInput()).toHaveValue('');
    expect(rebindWorkspaceVaultReference.mock.calls).toEqual([
      [
        {
          workspaceId: WORKSPACE.id,
          referenceId: UNBOUND_REFERENCE.referenceId,
          ...ASCII_REBIND_REQUEST,
        },
      ],
    ]);
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(screen.getByText('Unbound', { exact: true })).toBeInTheDocument();
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    assertNoLeakedInternals(queryClient);

    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    expect(rebindControl()).toBeEnabled();
    await user.click(rebindControl());
    await confirmRebind(user);
    await waitFor(() =>
      expect(rebindWorkspaceVaultReference.mock.calls).toEqual([
        [
          {
            workspaceId: WORKSPACE.id,
            referenceId: UNBOUND_REFERENCE.referenceId,
            ...ASCII_REBIND_REQUEST,
          },
        ],
        [
          {
            workspaceId: WORKSPACE.id,
            referenceId: UNBOUND_REFERENCE.referenceId,
            ...ASCII_REBIND_REQUEST,
          },
        ],
      ])
    );
    expect(vaultMaterialInput()).toHaveValue('');
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('refetches an active vault row after vault_reference_not_unbound and does not replay rebind', async () => {
    const user = userEvent.setup();
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockResolvedValue(REBOUND_LIST);
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockRejectedValue(privateFailure(409, 'vault_reference_not_unbound'));
    const client = makeClient({
      app: {},
      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'vault.reference-rebind': rebindWorkspaceVaultReference,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    await user.click(rebindControl());
    await confirmRebind(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not unbound|already bound/i);
    expect(alert).not.toHaveTextContent(/conflict|recovery required/i);
    expect(alert).not.toHaveTextContent('portability-private failure');
    expect(alert).not.toHaveTextContent('vault_reference_not_unbound');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(rebindWorkspaceVaultReference.mock.calls).toEqual([
      [
        {
          workspaceId: WORKSPACE.id,
          referenceId: UNBOUND_REFERENCE.referenceId,
          ...ASCII_REBIND_REQUEST,
        },
      ],
    ]);
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([
      [{ workspaceId: WORKSPACE.id }],
      [{ workspaceId: WORKSPACE.id }],
    ]);
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(await screen.findByText('Active', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('refetches an empty vault list after vault_reference_not_found and does not replay rebind', async () => {
    const user = userEvent.setup();
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockResolvedValue(EMPTY_VAULT);
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockRejectedValue(privateFailure(404, 'vault_reference_not_found'));
    const client = makeClient({
      app: {},
      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'vault.reference-rebind': rebindWorkspaceVaultReference,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    await user.click(rebindControl());
    await confirmRebind(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not found/i);
    expect(alert).not.toHaveTextContent(/conflict|recovery required/i);
    expect(alert).not.toHaveTextContent('portability-private failure');
    expect(alert).not.toHaveTextContent('vault_reference_not_found');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(rebindWorkspaceVaultReference.mock.calls).toEqual([
      [
        {
          workspaceId: WORKSPACE.id,
          referenceId: UNBOUND_REFERENCE.referenceId,
          ...ASCII_REBIND_REQUEST,
        },
      ],
    ]);
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([
      [{ workspaceId: WORKSPACE.id }],
      [{ workspaceId: WORKSPACE.id }],
    ]);
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Active', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
    expect(screen.getByText(/no vault references/i)).toBeInTheDocument();
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    ['rebind', 'success'],
    ['rebind', 'failure'],
  ] as const)('keeps a late Workspace rebind scoped for %s %s', async (_operation, settlement) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    const listWorkspaces = vi.fn().mockResolvedValue({
      items: [WORKSPACE, WORKSPACE_B].map((workspace) => ({
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        workspace,
        isOwner: true,
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        registryRevision: 1,
      })),
    });
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(workspaceId === WORKSPACE.id ? VAULT_LIST : EMPTY_VAULT_B)
      );
    const rebindWorkspaceVaultReference = vi.fn().mockReturnValue(pending.promise);
    const client = makeClient({
      core: {},
      app: {},

      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'vault.reference-rebind': rebindWorkspaceVaultReference,
        'workspace.list': listWorkspaces,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();

    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    await user.click(rebindControl());
    await confirmRebind(user);
    await waitFor(() =>
      expect(rebindWorkspaceVaultReference.mock.calls).toEqual([
        [
          {
            workspaceId: WORKSPACE.id,
            referenceId: UNBOUND_REFERENCE.referenceId,
            ...ASCII_REBIND_REQUEST,
          },
        ],
      ])
    );

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(listWorkspaceVaultReferences.mock.calls).toEqual([
        [{ workspaceId: WORKSPACE.id }],
        [{ workspaceId: WORKSPACE_B.id }],
      ])
    );
    expect(await screen.findByText(WORKSPACE_B.name, { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('ws_00000000-0000-7ca9-b277-954ac43692f1')).not.toBeInTheDocument();
    expect(screen.queryByText('Imported research')).not.toBeInTheDocument();
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    assertNoLeakedInternals(queryClient);

    await act(async () => {
      if (settlement === 'success') {
        pending.resolve(REBIND_MUTATION);
      } else {
        pending.reject(privateFailure(400, 'vault_reference_rebind_failed'));
      }
      await pending.promise.catch(() => undefined);
    });

    const main = screen.getByRole('main');
    expect(within(main).queryByText('Imported research')).not.toBeInTheDocument();
    expect(
      within(main).queryByText('ws_00000000-0000-7ca9-b277-954ac43692f1')
    ).not.toBeInTheDocument();
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(main).queryByText('Active', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't rebind/i)).not.toBeInTheDocument();
    expect(screen.queryByText('portability-private failure')).not.toBeInTheDocument();
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([
      [{ workspaceId: WORKSPACE.id }],
      [{ workspaceId: WORKSPACE_B.id }],
    ]);
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('clears typed Vault material on Workspace switch without retaining it in TanStack', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({
      items: [WORKSPACE, WORKSPACE_B].map((workspace) => ({
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        workspace,
        isOwner: true,
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        registryRevision: 1,
      })),
    });
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(workspaceId === WORKSPACE.id ? VAULT_LIST : EMPTY_VAULT_B)
      );
    const client = makeClient({
      core: {},
      app: {},

      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'workspace.list': listWorkspaces,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.type(vaultMaterialInput(), VAULT_MATERIAL);
    expect(vaultMaterialInput()).toHaveValue(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL_BASE64);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(listWorkspaceVaultReferences.mock.calls).toEqual([
        [{ workspaceId: WORKSPACE.id }],
        [{ workspaceId: WORKSPACE_B.id }],
      ])
    );
    expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    expect(vaultMaterialInput()).toHaveValue('');
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('exports the selected personal Workspace', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({
      items: [PERSONAL_WORKSPACE].map((workspace) => ({
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        workspace,
        isOwner: true,
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        registryRevision: 1,
      })),
    });
    const client = makeClient({
      core: {},
      app: {},

      operations: {
        'vault.reference-list': vi
          .fn()
          .mockResolvedValue({ ...EMPTY_VAULT_B, workspaceId: PERSONAL_WORKSPACE.id }),
        'workspace.export': vi.fn().mockResolvedValue({
          ...EXPORT_RESULT,
          workspaceId: PERSONAL_WORKSPACE.id,
          manifest: {
            ...MANIFEST,
            workspaceId: PERSONAL_WORKSPACE.id,
            lineage: { workspaceId: PERSONAL_WORKSPACE.id },
          },
        }),
        'workspace.list': listWorkspaces,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByText(PERSONAL_WORKSPACE.name, { exact: true })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent(/select or create a project workspace/i);
    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
    await waitFor(() =>
      expect(vi.mocked(client.operations['vault.reference-list']).mock.calls).toEqual([
        [{ workspaceId: PERSONAL_WORKSPACE.id }],
      ])
    );
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    await waitFor(() =>
      expect(vi.mocked(client.operations['workspace.export']).mock.calls).toEqual([
        [{ workspaceId: PERSONAL_WORKSPACE.id }],
      ])
    );
    expectDownloadArchiveLink(PERSONAL_WORKSPACE.id, EXPORT_ID);
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    401, 403,
  ])('hides cached Vault references and rebind after a %s current read', async (status) => {
    const referencesRead = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockRejectedValue(
        new ApiCallError(status, 'portability-private failure', {
          code: 'workspace_access_denied',
          details: { secret: VAULT_MATERIAL },
        })
      );
    const client = makeClient({ operations: { 'vault.reference-list': referencesRead } });
    const { queryClient } = renderApp('/settings/portability', client);
    expect(
      await screen.findByText(UNBOUND_REFERENCE.referenceId, { exact: true })
    ).toBeInTheDocument();
    expect(
      rebindControl(UNBOUND_REFERENCE.secretKind, UNBOUND_REFERENCE.referenceId)
    ).toBeEnabled();
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: settingsKeys.vault(WORKSPACE.id), exact: true });
    });
    const vault = screen.getByRole('region', { name: 'Vault references' });
    expect(await within(vault).findByRole('alert')).toHaveTextContent(
      /couldn't load vault references/i
    );
    expect.soft(queryClient.getQueryState(settingsKeys.vault(WORKSPACE.id))?.error).toMatchObject({
      status,
      code: 'workspace_access_denied',
      message: "Couldn't load vault references.",
      details: undefined,
    });
    expect
      .soft(within(vault).queryByText(UNBOUND_REFERENCE.referenceId, { exact: true }))
      .toBeNull();
    expect.soft(within(vault).queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(within(vault).queryByLabelText('Vault material')).toBeNull();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
  });

  it('blocks an open rebind confirmation while the current Vault read is pending or denied', async () => {
    const user = userEvent.setup();
    const reread = createDeferred<typeof VAULT_LIST>();
    const referencesRead = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockReturnValueOnce(reread.promise)
      .mockResolvedValue(VAULT_LIST);
    const client = makeClient({ operations: { 'vault.reference-list': referencesRead } });
    const { queryClient } = renderApp('/settings/portability', client);
    await screen.findByText(UNBOUND_REFERENCE.referenceId, { exact: true });
    await user.type(vaultMaterialInput(), VAULT_MATERIAL);
    await user.click(rebindControl(UNBOUND_REFERENCE.secretKind, UNBOUND_REFERENCE.referenceId));
    const dialog = await screen.findByRole('dialog', { name: /confirm rebind/i });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeEnabled();
    let refresh!: Promise<void>;
    act(() => {
      refresh = queryClient.refetchQueries({
        queryKey: settingsKeys.vault(WORKSPACE.id),
        exact: true,
      });
    });
    await waitFor(() => expect(referencesRead).toHaveBeenCalledTimes(2));
    expect.soft(confirm).toBeDisabled();
    await user.click(confirm);
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    await act(async () => {
      reread.reject(privateFailure(403, 'workspace_access_denied'));
      await refresh;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load vault references/i);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(UNBOUND_REFERENCE.referenceId, { exact: true })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(UNBOUND_REFERENCE.referenceId, { exact: true });
    expect(vaultMaterialInput()).toHaveValue('');
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('hides cached Vault references after denial followed by a failed remount read', async () => {
    const user = userEvent.setup();
    const referencesRead = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockRejectedValueOnce(privateFailure(403, 'workspace_access_denied'))
      .mockRejectedValue(privateFailure(500, 'unavailable'));
    const client = makeClient({ operations: { 'vault.reference-list': referencesRead } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
    });
    renderApp('/settings/portability', client, queryClient);
    await screen.findByText(UNBOUND_REFERENCE.referenceId, { exact: true });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: settingsKeys.vault(WORKSPACE.id), exact: true });
    });
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await screen.findByRole('heading', { level: 1, name: 'Appearance' });
    await user.click(screen.getByRole('button', { name: 'Portability' }));
    await screen.findByRole('heading', { level: 1, name: 'Portability' });
    // Refresh explicitly to isolate denial disposal from mount admission.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: settingsKeys.vault(WORKSPACE.id), exact: true });
    });
    expect(referencesRead.mock.calls.length).toBeGreaterThanOrEqual(3);
    const vault = screen.getByRole('region', { name: 'Vault references' });
    expect(await within(vault).findByRole('alert')).toHaveTextContent(
      /couldn't load vault references/i
    );
    expect
      .soft(within(vault).queryByText(UNBOUND_REFERENCE.referenceId, { exact: true }))
      .toBeNull();
    expect(within(vault).queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
  });

  it('does not expose a departed pending Vault read in a later Portability mount', async () => {
    const user = userEvent.setup();
    const departedRead = createDeferred<typeof VAULT_LIST>();
    const currentRead = createDeferred<typeof VAULT_LIST>();
    const referencesRead = vi
      .fn()
      .mockReturnValueOnce(departedRead.promise)
      .mockReturnValue(currentRead.promise);
    const client = makeClient({ operations: { 'vault.reference-list': referencesRead } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
    });
    renderApp('/settings/portability', client, queryClient);
    await waitFor(() => expect(referencesRead).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await screen.findByRole('heading', { level: 1, name: 'Appearance' });
    await user.click(screen.getByRole('button', { name: 'Portability' }));
    await screen.findByRole('heading', { level: 1, name: 'Portability' });
    await act(async () => {
      departedRead.resolve(VAULT_LIST);
      await departedRead.promise;
    });
    await waitFor(() => expect(referencesRead).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(UNBOUND_REFERENCE.referenceId, { exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    await act(async () => {
      currentRead.resolve(VAULT_LIST);
      await currentRead.promise;
    });
    expect(
      await screen.findByText(UNBOUND_REFERENCE.referenceId, { exact: true })
    ).toBeInTheDocument();
    expect(
      rebindControl(UNBOUND_REFERENCE.secretKind, UNBOUND_REFERENCE.referenceId)
    ).toBeEnabled();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
  });

  it('keeps existing Portability UI plus stale or error indication when a background Workspace refetch fails', async () => {
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({
        items: [WORKSPACE].map((workspace) => ({
          membershipStatus: 'active' as const,
          accessCause: 'membership' as const,
          workspace,
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      })
      .mockRejectedValueOnce(new Error('ws_00000000-0000-7b14-af76-27f19ffc88fa failure'));
    const client = makeClient({ core: {}, operations: { 'workspace.list': listWorkspaces } });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();

    act(() => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.workspaces });
    });

    await waitFor(() => {
      expect(listWorkspaces).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('heading', { level: 1, name: 'Portability' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load workspaces/i);
      expect(screen.queryByRole('button', { name: 'Export workspace' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /rebind/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/no project workspace selected/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText('ws_00000000-0000-7b14-af76-27f19ffc88fa failure')
    ).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient);
  });

  it('names each Rebind control from public-schema secretKind and a per-reference discriminator', async () => {
    const client = makeClient({
      app: {},
      operations: { 'vault.reference-list': vi.fn().mockResolvedValue(TWO_UNBOUND_VAULT) },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findAllByText('Unbound', { exact: true })).toHaveLength(2);
    expect(UNBOUND_REFERENCE.secretKind).toBe(UNBOUND_SAME_KIND.secretKind);
    expect(UNBOUND_REFERENCE.referenceId).not.toBe(UNBOUND_SAME_KIND.referenceId);
    expect(
      screen.getAllByText(UNBOUND_REFERENCE.secretKind, { exact: true }).length
    ).toBeGreaterThanOrEqual(1);
    expect(
      rebindControl(UNBOUND_REFERENCE.secretKind, UNBOUND_REFERENCE.referenceId)
    ).toBeEnabled();
    expect(
      rebindControl(UNBOUND_SAME_KIND.secretKind, UNBOUND_SAME_KIND.referenceId)
    ).toBeEnabled();
    expect(rebindControl(UNBOUND_REFERENCE.secretKind, UNBOUND_REFERENCE.referenceId)).not.toBe(
      rebindControl(UNBOUND_SAME_KIND.secretKind, UNBOUND_SAME_KIND.referenceId)
    );
    expect(screen.queryAllByRole('button', { name: /^Rebind$/ })).toHaveLength(0);
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    {
      command: 'export' as const,
      status: 409,
      code: 'conflict',
      copy: /conflict|pending input|unresolved/i,
      forbidden: /recovery required|access denied/i,
    },
    {
      command: 'export' as const,
      status: 403,
      code: 'workspace_access_denied',
      copy: /administrator authority/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'rebind' as const,
      status: 403,
      code: 'workspace_access_denied',
      copy: /access denied/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'rebind' as const,
      status: 423,
      code: 'vault_backend_not_available',
      copy: /backend is not available|not available/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'rebind' as const,
      status: 503,
      code: 'vault_storage_unavailable',
      copy: /storage is not configured|storage unavailable|not configured/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'rebind' as const,
      status: 400,
      code: 'vault_reference_rebind_failed',
      copy: /couldn't rebind|rebind failed/i,
      forbidden: /conflict|recovery required/i,
    },
  ])('projects typed $command $code copy without leaking the private failure', async (scenario) => {
    const user = userEvent.setup();
    const error = privateFailure(scenario.status, scenario.code);
    const exportWorkspace = vi
      .fn()
      .mockRejectedValue(scenario.command === 'export' ? error : undefined)
      .mockResolvedValue(EXPORT_RESULT);
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockRejectedValue(scenario.command === 'rebind' ? error : undefined)
      .mockResolvedValue(REBIND_MUTATION);
    const client = makeClient({
      operations: {
        'vault.reference-rebind': rebindWorkspaceVaultReference,
        'workspace.export': exportWorkspace,
      },
      app: {},
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();

    if (scenario.command === 'export') {
      exportWorkspace.mockReset();
      exportWorkspace.mockRejectedValue(error);
      await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    } else {
      rebindWorkspaceVaultReference.mockReset();
      rebindWorkspaceVaultReference.mockRejectedValue(error);
      await user.type(await screen.findByLabelText('Vault material'), 'ok');
      await user.click(rebindControl());
      await confirmRebind(user);
    }

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(scenario.copy);
    expect(alert).not.toHaveTextContent(scenario.forbidden);
    expect(alert).not.toHaveTextContent('portability-private failure');
    if (scenario.code.includes('_')) {
      expect(alert).not.toHaveTextContent(scenario.code);
    }
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    ['zero workspaces', [] as const],
    ['only a personal Workspace', [PERSONAL_WORKSPACE]],
  ] as const)('reaches administration Portability from Settings with %s', async (_label, items) => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({
      items: [...items].map((workspace) => ({
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        workspace,
        isOwner: true,
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        registryRevision: 1,
      })),
    });
    const client = makeClient({
      core: {},
      app: {},

      operations: {
        'workspace.list': listWorkspaces,
      },
    });
    renderApp('/', client);

    const appNav = await screen.findByRole('navigation', { name: 'Primary workspace navigation' });
    expect(within(appNav).queryByRole('button', { name: 'Portability' })).not.toBeInTheDocument();
    await user.click(within(appNav).getByRole('button', { name: 'Settings' }));
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    await user.click(await within(nav).findByRole('button', { name: 'Portability' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    const expectWorkspaceSurface = () => {
      if (items.length === 0) expectVaultUiAbsent(client);
      else {
        expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
        expect(vi.mocked(client.operations['vault.reference-list']).mock.calls).toEqual([
          [{ workspaceId: PERSONAL_WORKSPACE.id }],
        ]);
        expect(client.operations['workspace.export']).not.toHaveBeenCalled();
        expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
      }
    };
    await waitFor(expectWorkspaceSurface);
  });

  it('requires a separate explicit Vault rebind confirmation whose Cancel makes zero API calls and Confirm makes one', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(client.operations['vault.reference-list']).toHaveBeenCalledTimes(1));
    await user.click(rebindControl());
    const emptyDialog = await screen.findByRole('dialog', {
      name: new RegExp(`confirm rebind ${UNBOUND_REFERENCE.secretKind}`, 'i'),
    });
    expect(emptyDialog).toHaveTextContent(UNBOUND_REFERENCE.referenceId);
    expect(within(emptyDialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();
    await user.click(within(emptyDialog).getByRole('button', { name: 'Cancel' }));
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    const readsAfterLoad = {
      exportWorkspace: vi.mocked(client.operations['workspace.export']).mock.calls.length,
      listWorkspaceVaultReferences: vi.mocked(client.operations['vault.reference-list']).mock.calls
        .length,
      listWorkspaceVaultGrants: vi.mocked(client.operations['vault.grant-list']).mock.calls.length,
      listWorkspaceVaultUseRecords: vi.mocked(client.operations['vault.use-list']).mock.calls
        .length,
      rebindWorkspaceVaultReference: vi.mocked(client.operations['vault.reference-rebind']).mock
        .calls.length,
    };
    expect(readsAfterLoad.rebindWorkspaceVaultReference).toBe(0);
    await user.click(rebindControl());
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', { name: /confirm/i });
    expect(dialog).toHaveTextContent(UNBOUND_REFERENCE.secretKind);
    expect(dialog).toHaveTextContent(UNBOUND_REFERENCE.referenceId);
    expect(dialog).toHaveTextContent(/becomes active/i);
    expect(dialog).toHaveTextContent(/cannot be rebound again/i);
    assertNoLeakedInternals(queryClient, 'cache');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient, 'cache');
    expect(vi.mocked(client.operations['workspace.export']).mock.calls.length).toBe(
      readsAfterLoad.exportWorkspace
    );
    expect(vi.mocked(client.operations['vault.reference-list']).mock.calls.length).toBe(
      readsAfterLoad.listWorkspaceVaultReferences
    );
    expect(vi.mocked(client.operations['vault.grant-list']).mock.calls.length).toBe(
      readsAfterLoad.listWorkspaceVaultGrants
    );
    expect(vi.mocked(client.operations['vault.use-list']).mock.calls.length).toBe(
      readsAfterLoad.listWorkspaceVaultUseRecords
    );
    expect(client.operations['vault.reference-rebind']).not.toHaveBeenCalled();

    await user.clear(vaultMaterialInput());
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    await user.click(rebindControl());
    const confirmDialog = await screen.findByRole('dialog', { name: /confirm/i });
    expect(confirmDialog).toHaveTextContent(/becomes active/i);
    expect(confirmDialog).toHaveTextContent(/cannot be rebound again/i);
    await user.click(within(confirmDialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(client.operations['vault.reference-rebind']).toHaveBeenCalledTimes(1)
    );
    expect(vi.mocked(client.operations['vault.reference-rebind']).mock.calls).toEqual([
      [
        {
          workspaceId: WORKSPACE.id,
          referenceId: UNBOUND_REFERENCE.referenceId,
          ...ASCII_REBIND_REQUEST,
        },
      ],
    ]);
    expect(client.operations['workspace.export']).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('encodes 131072-byte vault material without RangeError and round-trips exact bytes', () => {
    const value = 'a'.repeat(131072);
    const utf8 = new TextEncoder().encode(value);
    expect(utf8.byteLength).toBe(131072);
    const encoded = encodeVaultMaterial(value);
    const roundTripped = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(roundTripped).toHaveLength(utf8.length);
    expect(roundTripped.every((byte, index) => byte === utf8[index])).toBe(true);
  });

  it('keeps export archive href off JSON-base64 and host paths', () => {
    const production = `${portabilityDataSource}\n${portabilityScreenSource}`;
    expect(production).toMatch(/workspaceExportArchiveHref\(/);
    expect(production).not.toMatch(/createObjectURL/);
    expect(production).not.toMatch(/readAsDataURL/);
    expect(production).not.toMatch(/contentBase64/);
    expect(production).not.toMatch(/arrayBufferToBase64/);
    expect(production).not.toMatch(/sourcePath/);
  });

  it('encodes export archive href paths without RangeError', () => {
    expect(workspaceExportArchiveHref(WORKSPACE.id, EXPORT_ID)).toBe(
      `/api/app/workspaces/${WORKSPACE.id}/exports/${EXPORT_ID}/archive`
    );
    expect(workspaceExportArchiveHref('ws 1/a', 'exp?x')).toBe(
      '/api/app/workspaces/ws%201%2Fa/exports/exp%3Fx/archive'
    );
  });

  it('offers a same-origin encoded archive link for the created export', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    const link = expectDownloadArchiveLink(WORKSPACE.id, EXPORT_ID);
    expect(link).toBeEnabled();
    expect(screen.getByRole('heading', { level: 1, name: 'Portability' })).toBeInTheDocument();
    expect(client.app.downloadWorkspaceExportArchive).not.toHaveBeenCalled();
  });

  it('does not offer an earlier export archive after the selected Workspace changes', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({
      items: [WORKSPACE, WORKSPACE_B].map((workspace) => ({
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        workspace,
        isOwner: true,
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        registryRevision: 1,
      })),
    });
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve(workspaceId === WORKSPACE.id ? VAULT_LIST : EMPTY_VAULT_B)
      );
    const client = makeClient({
      core: {},
      app: {},

      operations: {
        'vault.reference-list': listWorkspaceVaultReferences,
        'workspace.list': listWorkspaces,
      },
    });
    renderApp('/settings/portability', client);

    expect(await screen.findByRole('button', { name: 'Export workspace' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    expectDownloadArchiveLink(WORKSPACE.id, EXPORT_ID);
    expect(
      within(screen.getByRole('region', { name: 'Export' })).getByText(EXPORT_ID)
    ).toBeInTheDocument();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    expect(await screen.findByText(WORKSPACE_B.name, { exact: true })).toBeInTheDocument();
    const exportRegion = screen.getByRole('region', { name: 'Export' });
    expect(within(exportRegion).queryByText(EXPORT_ID)).not.toBeInTheDocument();
    expect(
      within(exportRegion).queryByRole('link', { name: 'Download archive (opens in a new tab)' })
    ).not.toBeInTheDocument();
    expect(
      within(exportRegion).queryByRole('link', { name: 'Download archive' })
    ).not.toBeInTheDocument();
    expect(
      within(exportRegion).queryByRole('button', { name: 'Download archive' })
    ).not.toBeInTheDocument();
    expect(client.app.downloadWorkspaceExportArchive).not.toHaveBeenCalled();
    expect(vi.mocked(client.operations['workspace.export']).mock.calls).toEqual([
      [{ workspaceId: WORKSPACE.id }],
    ]);
  });
});
