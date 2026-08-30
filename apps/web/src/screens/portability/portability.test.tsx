import {
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
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
import { encodeVaultMaterial } from './data';
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
const WORKSPACE = { id: 'ws1', name: 'Market research', kind: 'general' } as const;
const WORKSPACE_B = { id: 'ws2', name: 'Second workspace', kind: 'general' } as const;
const EXPORTED_ABSENT_ID = 'ws_exported_absent';
const QUICK_CHAT_WORKSPACE = {
  id: 'ws_quick_chat',
  name: 'Quick Chat',
  kind: 'quick-chat',
} as const;
const EXPORT_ID = 'wsexp_1';
const EXPORT_ID_B = 'wsexp_2';
const LOCAL_SOURCE_DEPLOYMENT_ID = 'dep_local';
const EXTERNAL_SOURCE_DEPLOYMENT_ID = 'dep_source';
const WORKSPACE_EXPORT_FILE_BYTES = serializeExportJson({
  id: WORKSPACE.id,
  name: WORKSPACE.name,
  kind: WORKSPACE.kind,
  status: 'active',
  defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
  counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});
const FILE_DIGEST = 'sha256:0f141fbf15bd9400f2152ee0738383b2d713f6502cd98f8ee72951843f632197';
const FILE_BYTES = new TextEncoder().encode(WORKSPACE_EXPORT_FILE_BYTES).byteLength;
const CONTENT_INVENTORY = [
  { path: 'records/workspace.json', digest: FILE_DIGEST, bytes: FILE_BYTES },
];
const CONTENT_DIGEST = 'sha256:0cd2fa898af279bb1179b690909444b73031fa36d246fa4037346c598ca2c9f5';
const DRY_RUN_REQUEST = WorkspaceImportDryRunRequestSchema.parse({
  sourceWorkspaceId: WORKSPACE.id,
  exportId: EXPORT_ID,
});
const AVAILABLE_DRY_RUN_REQUEST = WorkspaceImportDryRunRequestSchema.parse({
  sourceWorkspaceId: EXPORTED_ABSENT_ID,
  exportId: EXPORT_ID,
});
const CHANGED_SOURCE_REQUEST = WorkspaceImportDryRunRequestSchema.parse({
  sourceWorkspaceId: WORKSPACE_B.id,
  exportId: EXPORT_ID,
});
const CHANGED_EXPORT_REQUEST = WorkspaceImportDryRunRequestSchema.parse({
  sourceWorkspaceId: WORKSPACE.id,
  exportId: EXPORT_ID_B,
});
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
  sourceDeploymentId: LOCAL_SOURCE_DEPLOYMENT_ID,
  workspaceId: WORKSPACE.id,
  exportCreatedAt: TIMESTAMP,
  exportFormatVersion: 2 as const,
  contentInventory: CONTENT_INVENTORY,
};

const EXPORTED_ABSENT_MANIFEST = {
  ...MANIFEST,
  lineage: { workspaceId: EXPORTED_ABSENT_ID },
  workspaceId: EXPORTED_ABSENT_ID,
  sourceDeploymentId: EXTERNAL_SOURCE_DEPLOYMENT_ID,
};

const CHANGED_SOURCE_MANIFEST = {
  ...MANIFEST,
  lineage: { workspaceId: WORKSPACE_B.id },
  workspaceId: WORKSPACE_B.id,
  sourceDeploymentId: EXTERNAL_SOURCE_DEPLOYMENT_ID,
};

const CHANGED_EXPORT_MANIFEST = {
  ...MANIFEST,
  id: EXPORT_ID_B,
};

const VERIFICATION = {
  fileCount: 1,
  totalBytes: FILE_BYTES,
  checkedFiles: ['records/workspace.json'],
};

const COLLISION = {
  status: 'collides' as const,
  workspaceId: WORKSPACE.id,
  suggestedWorkspaceId: 'ws_imported_ws1',
};

const AVAILABLE_COLLISION = {
  status: 'available' as const,
  workspaceId: EXPORTED_ABSENT_ID,
};

const CHANGED_SOURCE_COLLISION = {
  status: 'available' as const,
  workspaceId: WORKSPACE_B.id,
};

const IMPORTED_WORKSPACE = {
  id: COLLISION.suggestedWorkspaceId,
  name: 'Imported research',
  kind: 'general' as const,
  status: 'active' as const,
  defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
  counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const EXPORT_RESULT = WorkspaceExportResponseSchema.parse({
  exportId: EXPORT_ID,
  workspaceId: WORKSPACE.id,
  manifest: MANIFEST,
  fileCount: 1,
  totalBytes: FILE_BYTES,
  checkedFiles: ['records/workspace.json'],
});

const DRY_RUN = WorkspaceImportDryRunResponseSchema.parse({
  mode: 'dry-run',
  exportId: EXPORT_ID,
  sourceWorkspaceId: WORKSPACE.id,
  exportedWorkspaceId: WORKSPACE.id,
  manifest: MANIFEST,
  verification: VERIFICATION,
  collision: COLLISION,
});

const DRY_RUN_AVAILABLE = WorkspaceImportDryRunResponseSchema.parse({
  mode: 'dry-run',
  exportId: EXPORT_ID,
  sourceWorkspaceId: EXPORTED_ABSENT_ID,
  exportedWorkspaceId: EXPORTED_ABSENT_ID,
  manifest: EXPORTED_ABSENT_MANIFEST,
  verification: VERIFICATION,
  collision: AVAILABLE_COLLISION,
});

const CHANGED_SOURCE_DRY_RUN = WorkspaceImportDryRunResponseSchema.parse({
  mode: 'dry-run',
  exportId: EXPORT_ID,
  sourceWorkspaceId: WORKSPACE_B.id,
  exportedWorkspaceId: WORKSPACE_B.id,
  manifest: CHANGED_SOURCE_MANIFEST,
  verification: VERIFICATION,
  collision: CHANGED_SOURCE_COLLISION,
});

const CHANGED_EXPORT_DRY_RUN = WorkspaceImportDryRunResponseSchema.parse({
  mode: 'dry-run',
  exportId: EXPORT_ID_B,
  sourceWorkspaceId: WORKSPACE.id,
  exportedWorkspaceId: WORKSPACE.id,
  manifest: CHANGED_EXPORT_MANIFEST,
  verification: VERIFICATION,
  collision: COLLISION,
});

const DRY_RUNS = [
  DRY_RUN,
  DRY_RUN_AVAILABLE,
  CHANGED_SOURCE_DRY_RUN,
  CHANGED_EXPORT_DRY_RUN,
] as const;

const MANIFEST_DIGESTS = new Map([
  [
    `${WORKSPACE.id}/${EXPORT_ID}`,
    'sha256:b796e26a17d120bdb3da4ee9c58bfbfd9a451b88989742a26749794205c362fc',
  ],
  [
    `${EXPORTED_ABSENT_ID}/${EXPORT_ID}`,
    'sha256:f6075fca77e7ffae15e2c8a422e53c6e6070e1525387ae85d06750a66579eda2',
  ],
  [
    `${WORKSPACE_B.id}/${EXPORT_ID}`,
    'sha256:a147834b4059571949436715c2724bddef98fb55603a3016b4789535f6220e93',
  ],
  [
    `${WORKSPACE.id}/${EXPORT_ID_B}`,
    'sha256:6c29d5346ad4b2de0f2ea3c85cc87b8b24ad05d4805ec2096c119a3eb03a68ab',
  ],
]);

/** Resolves the dry-run fixture whose handles match one import request. */
function dryRunFor(command: { sourceWorkspaceId: string; exportId: string }) {
  const review = DRY_RUNS.find(
    (item) =>
      item.sourceWorkspaceId === command.sourceWorkspaceId && item.exportId === command.exportId
  );
  if (!review) {
    throw new Error(`no dry-run fixture for ${command.sourceWorkspaceId}/${command.exportId}`);
  }
  return review;
}

/** Builds a complete schema-parsed import response from the matching dry-run report. */
function importResultFor(input: unknown) {
  const command = WorkspaceImportRequestSchema.parse(input);
  const review = dryRunFor(command);
  const importedWorkspaceId =
    review.collision.status === 'available'
      ? review.exportedWorkspaceId
      : review.collision.suggestedWorkspaceId;
  const [fileEntry] = review.manifest.contentInventory;
  const manifestDigest = MANIFEST_DIGESTS.get(`${review.sourceWorkspaceId}/${review.exportId}`);
  expect(manifestDigest).toEqual(expect.stringMatching(/^sha256:[0-9a-f]{64}$/));
  expect(fileEntry?.digest).toBe(FILE_DIGEST);
  expect(fileEntry?.bytes).toBe(FILE_BYTES);
  expect(review.manifest.contentDigest).toBe(CONTENT_DIGEST);
  expect(manifestDigest).not.toBe(review.manifest.contentDigest);
  expect(manifestDigest).not.toBe(fileEntry?.digest);
  expect(review.manifest.contentDigest).not.toBe(fileEntry?.digest);
  const result = WorkspaceImportResponseSchema.parse({
    mode: 'imported',
    requestId: command.requestId ?? null,
    exportId: command.exportId,
    sourceWorkspaceId: command.sourceWorkspaceId,
    exportedWorkspaceId: review.exportedWorkspaceId,
    importedWorkspaceId,
    manifest: review.manifest,
    verification: review.verification,
    collision: review.collision,
    workspace: {
      ...IMPORTED_WORKSPACE,
      id: importedWorkspaceId,
      importedFrom: {
        sourceDeploymentId: review.manifest.sourceDeploymentId,
        sourceWorkspaceId: review.exportedWorkspaceId,
        exportCreatedAt: review.manifest.exportCreatedAt,
        manifestDigest,
      },
    },
  });
  expect(result.workspace.importedFrom?.manifestDigest).toBe(manifestDigest);
  expect(result.sourceWorkspaceId).toBe(command.sourceWorkspaceId);
  expect(result.exportId).toBe(command.exportId);
  expect(result.exportedWorkspaceId).toBe(review.exportedWorkspaceId);
  expect(result.manifest).toEqual(review.manifest);
  expect(result.collision).toEqual(review.collision);
  expect(result.importedWorkspaceId).toBe(importedWorkspaceId);
  expect(result.workspace.id).toBe(importedWorkspaceId);
  if (review.collision.status === 'available') {
    expect(result.importedWorkspaceId).toBe(result.exportedWorkspaceId);
  } else {
    expect(result.importedWorkspaceId).toBe(review.collision.suggestedWorkspaceId);
  }
  return result;
}

for (const review of DRY_RUNS) {
  importResultFor({
    sourceWorkspaceId: review.sourceWorkspaceId,
    exportId: review.exportId,
    requestId: 'req_import_identity',
  });
}
expect(new Set(MANIFEST_DIGESTS.values()).size).toBe(DRY_RUNS.length);

const UNBOUND_REFERENCE = {
  backendKind: 'encrypted-file' as const,
  currentVersion: 0,
  ownerScope: 'workspace' as const,
  referenceId: 'vault_ref_imported',
  secretKind: 'repository-credential',
  status: 'unbound' as const,
  workspaceId: WORKSPACE.id,
};

const UNBOUND_SAME_KIND = {
  ...UNBOUND_REFERENCE,
  referenceId: 'vault_ref_imported_peer',
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
function makeClient(overrides: { core?: MethodOverrides; app?: MethodOverrides } = {}): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE] }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      exportWorkspace: vi.fn().mockResolvedValue(EXPORT_RESULT),
      dryRunWorkspaceImport: vi.fn().mockResolvedValue(DRY_RUN),
      importWorkspace: vi
        .fn()
        .mockImplementation((input: unknown) => Promise.resolve(importResultFor(input))),
      listWorkspaceVaultReferences: vi.fn().mockResolvedValue(VAULT_LIST),
      listWorkspaceVaultGrants: vi
        .fn()
        .mockImplementation((workspaceId: string) =>
          Promise.resolve(emptyVaultGrants(workspaceId))
        ),
      listWorkspaceVaultUseRecords: vi
        .fn()
        .mockImplementation((workspaceId: string) => Promise.resolve(emptyVaultUses(workspaceId))),
      rebindWorkspaceVaultReference: vi.fn().mockResolvedValue(REBIND_MUTATION),
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

/** Fills the server-managed import handles and runs dry-run review. */
async function reviewImport(
  user: ReturnType<typeof userEvent.setup>,
  sourceWorkspaceId: string = WORKSPACE.id,
  exportId: string = EXPORT_ID
) {
  await user.type(screen.getByRole('textbox', { name: 'Source workspace ID' }), sourceWorkspaceId);
  await user.type(screen.getByRole('textbox', { name: 'Export ID' }), exportId);
  await user.click(screen.getByRole('button', { name: 'Review import' }));
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

/** Captures the exact accepted import command, including its requestId. */
function acceptedImportCommand(
  importWorkspace: ReturnType<typeof vi.fn>,
  callIndex = 0,
  request: { sourceWorkspaceId: string; exportId: string } = DRY_RUN_REQUEST
) {
  const command = WorkspaceImportRequestSchema.parse(importWorkspace.mock.calls[callIndex]?.[0]);
  expect(command.requestId).toEqual(expect.any(String));
  expect(command).toEqual({
    sourceWorkspaceId: request.sourceWorkspaceId,
    exportId: request.exportId,
    requestId: command.requestId,
  });
  return command;
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

function importSection() {
  return screen.getByRole('region', { name: 'Import' });
}

/** Inverse precommit copy that must not appear in a consequence row or the Import region. */
function expectNoContradictoryPrecommitCopy(node: HTMLElement) {
  expect(node).not.toHaveTextContent(/source owner remains/i);
  expect(node).not.toHaveTextContent(/preserves source membership/i);
  expect(node).not.toHaveTextContent(/source memberships? are recreated/i);
  expect(node).not.toHaveTextContent(/source invitations? are recreated/i);
  expect(node).not.toHaveTextContent(/source tokens? are recreated/i);
  expect(node).not.toHaveTextContent(/imported approvals? authorize/i);
  expect(node).not.toHaveTextContent(/imported permission decisions? authorize/i);
  expect(node).not.toHaveTextContent(/imported vault grants? authorize/i);
  expect(node).not.toHaveTextContent(/vault references? remain (?:bound|active)/i);
  expect(node).not.toHaveTextContent(/does not require rebind/i);
  expect(node).not.toHaveTextContent(/no rebind (?:is )?required/i);
  const text = node.textContent ?? '';
  expect(text).not.toMatch(
    /becomes[\s\S]{0,80}new(?: canonical)? owner[\s\S]{0,80}source owner remains/i
  );
  expect(text).not.toMatch(/sole active member[\s\S]{0,80}preserves source membership/i);
  expect(text).not.toMatch(/not reconstructed[\s\S]{0,80}are reconstructed/i);
  expect(text).not.toMatch(/historical only[\s\S]{0,80}authorize/i);
  expect(text).not.toMatch(/unbound[\s\S]{0,80}remain (?:bound|active)/i);
}

/** Accessible Import consequence rows: named list items, otherwise table rows. */
function importConsequenceRows(section: HTMLElement) {
  const namedList = within(section).queryByRole('list', {
    name: /consequence|import will|before you import|what import does/i,
  });
  const lists = namedList ? [namedList] : within(section).queryAllByRole('list');
  const fromLists = lists.flatMap((list) => within(list).queryAllByRole('listitem'));
  if (fromLists.length > 0) return fromLists;
  return within(section).queryAllByRole('row');
}

/** Returns the one accessible row whose text binds this subject. */
function uniqueConsequenceRow(rows: HTMLElement[], subject: RegExp) {
  const matches = rows.filter((row) => subject.test(row.textContent ?? ''));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** Visible precommit consequences required on both collision branches before Import. */
function expectPrecommitConsequences(section: HTMLElement) {
  const rows = importConsequenceRows(section);
  expect(rows.length).toBeGreaterThanOrEqual(4);
  const owner = uniqueConsequenceRow(rows, /authenticated importer/i);
  const membership = uniqueConsequenceRow(rows, /source(?:[\s-]deployment)?[\s\w,/]*memberships?/i);
  const authority = uniqueConsequenceRow(rows, /Approval|approvals?/i);
  const vault = uniqueConsequenceRow(rows, /vault references?/i);
  expect(new Set([owner, membership, authority, vault]).size).toBe(4);

  expect(owner).toHaveTextContent(/(?:becomes|is recorded as)(?: the)? new(?: canonical)? owner/i);
  expect(owner).toHaveTextContent(/(?:sole|only) active member/i);

  expect(membership).toHaveTextContent(/invitations?/i);
  expect(membership).toHaveTextContent(/tokens?/i);
  expect(membership).toHaveTextContent(
    /(?:must not|are not|will not|never) (?:be )?(?:reconstructed|recreated)/i
  );

  expect(authority).toHaveTextContent(/PermissionDecision|permission decisions?/i);
  expect(authority).toHaveTextContent(/VaultGrant|vault grants?/i);
  expect(authority).toHaveTextContent(/historical only|history only|historical evidence only/i);
  expect(authority).toHaveTextContent(
    /grant no authority|non-authorizing|do not (?:grant|confer) authority/i
  );

  expect(vault).toHaveTextContent(/unbound/i);
  expect(vault).toHaveTextContent(
    /(?:require|need)(?:s|d)? (?:an? )?(?:explicit )?(?:local )?rebind/i
  );

  for (const row of [owner, membership, authority, vault]) {
    expectNoContradictoryPrecommitCopy(row);
  }
  expectNoContradictoryPrecommitCopy(section);
}

function expectReviewIdentities(
  review:
    | typeof DRY_RUN
    | typeof DRY_RUN_AVAILABLE
    | typeof CHANGED_SOURCE_DRY_RUN
    | typeof CHANGED_EXPORT_DRY_RUN,
  request: { sourceWorkspaceId: string; exportId: string }
) {
  expect(review.sourceWorkspaceId).toBe(request.sourceWorkspaceId);
  expect(review.exportId).toBe(request.exportId);
  expect(review.exportedWorkspaceId).toBe(review.manifest.workspaceId);
  expect(review.manifest.id).toBe(request.exportId);
  expect(review.manifest.lineage).toEqual({ workspaceId: review.exportedWorkspaceId });
  expect(review.collision.workspaceId).toBe(review.exportedWorkspaceId);
  if (review.collision.status === 'available') {
    expect(review.manifest.sourceDeploymentId).toBe(EXTERNAL_SOURCE_DEPLOYMENT_ID);
    expect(review.manifest.sourceDeploymentId).not.toBe(LOCAL_SOURCE_DEPLOYMENT_ID);
  }
}

function expectReviewSummary(
  review:
    | typeof DRY_RUN
    | typeof DRY_RUN_AVAILABLE
    | typeof CHANGED_SOURCE_DRY_RUN
    | typeof CHANGED_EXPORT_DRY_RUN
) {
  expect(review.exportedWorkspaceId).toBe(review.manifest.workspaceId);
  expect(review.manifest.id).toBe(review.exportId);
  expect(review.manifest.lineage).toEqual({ workspaceId: review.exportedWorkspaceId });
  expect(review.collision.workspaceId).toBe(review.exportedWorkspaceId);
  const section = importSection();
  expect(section).toHaveTextContent(
    new RegExp(`source workspace[\\s\\S]*${review.sourceWorkspaceId}`, 'i')
  );
  expect(section).toHaveTextContent(
    new RegExp(`exported workspace[\\s\\S]*${review.exportedWorkspaceId}`, 'i')
  );
  expect(section).toHaveTextContent(new RegExp(`${review.verification.fileCount}\\s+files?`, 'i'));
  expect(section).toHaveTextContent(new RegExp(`${review.verification.totalBytes}\\s+bytes`, 'i'));
  expectPrecommitConsequences(section);
  if (review.collision.status === 'collides') {
    expect(section).toHaveTextContent(review.collision.suggestedWorkspaceId);
    expect(section).toHaveTextContent(/already exists|new id/i);
  } else {
    expect(section).toHaveTextContent(
      new RegExp(`(target|suggested) workspace[\\s\\S]*${review.collision.workspaceId}`, 'i')
    );
    expect(section).toHaveTextContent(/available|no collision|does not collide|keep/i);
    expect(section).not.toHaveTextContent(/already exists|new id/i);
  }
}

function expectVaultUiAbsent(client: CoreClient) {
  expect(screen.queryByRole('button', { name: 'Export workspace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /rebind/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
  expect(client.app.exportWorkspace).not.toHaveBeenCalled();
  expect(client.app.listWorkspaceVaultReferences).not.toHaveBeenCalled();
  expect(client.app.listWorkspaceVaultGrants).not.toHaveBeenCalled();
  expect(client.app.listWorkspaceVaultUseRecords).not.toHaveBeenCalled();
  expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
}

/** User-scoped import of an unrelated external-deployment export the caller may inspect. */
async function proveUserScopedImport(
  user: ReturnType<typeof userEvent.setup>,
  client: CoreClient,
  queryClient: QueryClient
) {
  expect(DRY_RUN_AVAILABLE.manifest.sourceDeploymentId).toBe(EXTERNAL_SOURCE_DEPLOYMENT_ID);
  expect(DRY_RUN_AVAILABLE.sourceWorkspaceId).not.toBe(WORKSPACE.id);
  expect(DRY_RUN_AVAILABLE.manifest.sourceDeploymentId).not.toBe(LOCAL_SOURCE_DEPLOYMENT_ID);
  expectReviewIdentities(DRY_RUN_AVAILABLE, AVAILABLE_DRY_RUN_REQUEST);
  expect(screen.getByRole('button', { name: 'Review import' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
  expectVaultUiAbsent(client);
  await reviewImport(user, EXPORTED_ABSENT_ID, EXPORT_ID);
  await waitFor(() =>
    expect(vi.mocked(client.app.dryRunWorkspaceImport).mock.calls).toEqual([
      [AVAILABLE_DRY_RUN_REQUEST],
    ])
  );
  expectReviewSummary(DRY_RUN_AVAILABLE);
  expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();
  expect(client.app.importWorkspace).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Import workspace' }));
  await waitFor(() => expect(client.app.importWorkspace).toHaveBeenCalledTimes(1));
  const acceptedImport = acceptedImportCommand(
    vi.mocked(client.app.importWorkspace),
    0,
    AVAILABLE_DRY_RUN_REQUEST
  );
  expect(vi.mocked(client.app.importWorkspace).mock.calls).toEqual([[acceptedImport]]);
  expectVaultUiAbsent(client);
  assertNoLeakedInternals(queryClient);
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Portability', () => {
  it('reuses the shared Settings Vault hook rather than a Portability-owned vault query', () => {
    const production = `${portabilityDataSource}\n${portabilityScreenSource}`;
    expect(production).toMatch(
      /import\s*\{[\s\S]*?\buseVault\b[\s\S]*?\}\s*from\s*['"]\.\.\/settings(?:\/data)?['"]/
    );
    expect(production).toMatch(/\buseVault\s*\(/);
    expect(production).not.toMatch(/\busePortabilityVaultReferences\b/);
    expect(production).not.toMatch(/portabilityKeys\.vault/);
  });

  it('is a reachable user-scoped surface for export, import review, and vault rebind', async () => {
    const user = userEvent.setup();
    const surface = surfaceById('portability');
    expect(surface).toMatchObject({
      title: 'Portability',
      path: '/settings/portability',
      tier: 'A',
      nav: 'settings-user',
    });
    expect(isSurfaceLive(surface!)).toBe(true);

    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_stale' });
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-private failure'))
      .mockResolvedValue({ items: [WORKSPACE] });
    const client = makeClient({ core: { listWorkspaces } });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByRole('region', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toBeEnabled();
    const loadAlert = await screen.findByRole('alert');
    expect(loadAlert).toHaveTextContent(/couldn't load workspaces/i);
    expect(loadAlert).not.toHaveTextContent('workspace-private failure');
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
    expect(screen.getByRole('button', { name: 'Review import' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
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
      expect(vi.mocked(client.app.listWorkspaceVaultReferences).mock.calls).toEqual([
        [WORKSPACE.id],
      ]);
    });
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(
      vi.mocked(client.app.listWorkspaceVaultReferences).mock.invocationCallOrder[0]
    ).toBeGreaterThan(listWorkspaces.mock.invocationCallOrder[1]);
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.dryRunWorkspaceImport).not.toHaveBeenCalled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
  });

  it('exports the selected Workspace, reviews an import dry-run before apply, and rebinds from an authoritative refetch', async () => {
    const user = userEvent.setup();
    const importedWorkspaces = createDeferred<{ items: unknown[] }>();
    const reboundVault = createDeferred<typeof REBOUND_LIST>();
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({ items: [WORKSPACE] })
      .mockReturnValueOnce(importedWorkspaces.promise);
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockResolvedValueOnce(VAULT_LIST)
      .mockReturnValueOnce(reboundVault.promise);
    const client = makeClient({
      core: { listWorkspaces },
      app: { listWorkspaceVaultReferences },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));

    await waitFor(() =>
      expect(vi.mocked(client.app.exportWorkspace).mock.calls).toEqual([[WORKSPACE.id]])
    );
    expect(await screen.findByText(EXPORT_ID)).toBeInTheDocument();
    expect(screen.getByText('1 file', { exact: false })).toBeInTheDocument();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);

    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
    await reviewImport(user);
    await waitFor(() =>
      expect(vi.mocked(client.app.dryRunWorkspaceImport).mock.calls).toEqual([[DRY_RUN_REQUEST]])
    );
    expect(await screen.findByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
    expectReviewSummary(DRY_RUN);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);

    await user.click(screen.getByRole('button', { name: 'Import workspace' }));
    await waitFor(() => expect(client.app.importWorkspace).toHaveBeenCalledTimes(1));
    const acceptedImport = acceptedImportCommand(vi.mocked(client.app.importWorkspace));
    expect(vi.mocked(client.app.importWorkspace).mock.calls).toEqual([[acceptedImport]]);
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(IMPORTED_WORKSPACE.name)).toBeInTheDocument();

    importedWorkspaces.resolve({ items: [WORKSPACE, IMPORTED_WORKSPACE] });
    expect(await screen.findByText(IMPORTED_WORKSPACE.name)).toBeInTheDocument();
    assertNoLeakedInternals(queryClient);

    await user.type(vaultMaterialInput(), VAULT_MATERIAL);
    expect(vaultMaterialInput()).toHaveValue(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL_BASE64);
    await user.click(rebindControl());
    await confirmRebind(user);
    await waitFor(() => expect(client.app.rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.app.rebindWorkspaceVaultReference).mock.calls).toEqual([
      [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, REBIND_REQUEST],
    ]);
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(screen.queryByText('Active', { exact: true })).not.toBeInTheDocument();
    expect(vaultMaterialInput()).toHaveValue('');
    assertNoLeakedInternals(queryClient);

    reboundVault.resolve(REBOUND_LIST);
    expect(await screen.findByText('Active', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id]]);
    expect(client.app.exportWorkspace).toHaveBeenCalledTimes(1);
    expect(client.app.dryRunWorkspaceImport).toHaveBeenCalledTimes(1);
    expect(client.app.importWorkspace).toHaveBeenCalledTimes(1);
    expect(client.app.rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    assertNoLeakedInternals(queryClient);
  });

  it('shows non-collision dry-run review semantics before import is enabled', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [WORKSPACE_B] });
    const client = makeClient({
      core: { listWorkspaces },
      app: {
        dryRunWorkspaceImport: vi.fn().mockResolvedValue(DRY_RUN_AVAILABLE),
        listWorkspaceVaultReferences: vi.fn().mockResolvedValue(EMPTY_VAULT_B),
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(screen.getByText(WORKSPACE_B.name, { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(EXPORTED_ABSENT_ID)).not.toBeInTheDocument();
    expect(WORKSPACE_B.id).not.toBe(EXPORTED_ABSENT_ID);
    expect(DRY_RUN_AVAILABLE.exportedWorkspaceId).toBe(EXPORTED_ABSENT_ID);
    expect(DRY_RUN_AVAILABLE.collision.workspaceId).toBe(EXPORTED_ABSENT_ID);
    expect(DRY_RUN_AVAILABLE.manifest.sourceDeploymentId).toBe(EXTERNAL_SOURCE_DEPLOYMENT_ID);
    expect(DRY_RUN_AVAILABLE.manifest.sourceDeploymentId).not.toBe(LOCAL_SOURCE_DEPLOYMENT_ID);
    expect(DRY_RUN_AVAILABLE.manifest.sourceDeploymentId).not.toBe(MANIFEST.sourceDeploymentId);
    expectReviewIdentities(DRY_RUN_AVAILABLE, AVAILABLE_DRY_RUN_REQUEST);
    expect(listWorkspaces.mock.calls.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
    await reviewImport(user, EXPORTED_ABSENT_ID, EXPORT_ID);
    await waitFor(() =>
      expect(vi.mocked(client.app.dryRunWorkspaceImport).mock.calls).toEqual([
        [AVAILABLE_DRY_RUN_REQUEST],
      ])
    );
    expectReviewSummary(DRY_RUN_AVAILABLE);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    [
      'source workspace ID',
      WORKSPACE_B.id,
      EXPORT_ID,
      CHANGED_SOURCE_REQUEST,
      CHANGED_SOURCE_DRY_RUN,
    ],
    ['export ID', WORKSPACE.id, EXPORT_ID_B, CHANGED_EXPORT_REQUEST, CHANGED_EXPORT_DRY_RUN],
  ] as const)('invalidates Import until a new dry-run after the %s changes', async (field, sourceWorkspaceId, exportId, nextRequest, nextReview) => {
    const user = userEvent.setup();
    const dryRunWorkspaceImport = vi
      .fn()
      .mockResolvedValueOnce(DRY_RUN)
      .mockResolvedValue(nextReview);
    const client = makeClient({ app: { dryRunWorkspaceImport } });
    const { queryClient } = renderApp('/settings/portability', client);

    expectReviewIdentities(nextReview, nextRequest);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    await reviewImport(user);
    expectReviewSummary(DRY_RUN);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();

    const edited = field === 'source workspace ID' ? 'Source workspace ID' : 'Export ID';
    const nextValue = field === 'source workspace ID' ? sourceWorkspaceId : exportId;
    await user.clear(screen.getByRole('textbox', { name: edited }));
    await user.type(screen.getByRole('textbox', { name: edited }), nextValue);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Review import' }));
    await waitFor(() => expect(dryRunWorkspaceImport).toHaveBeenCalledTimes(2));
    expect(dryRunWorkspaceImport.mock.calls[1]).toEqual([nextRequest]);
    expectReviewSummary(nextReview);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Import workspace' }));
    await waitFor(() => expect(client.app.importWorkspace).toHaveBeenCalledTimes(1));
    const acceptedImport = acceptedImportCommand(
      vi.mocked(client.app.importWorkspace),
      0,
      nextRequest
    );
    expect(vi.mocked(client.app.importWorkspace).mock.calls).toEqual([[acceptedImport]]);
    assertNoLeakedInternals(queryClient);
  });

  it('treats an uncertain export as a result-unknown outcome and requires an explicit new export action', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [WORKSPACE] });
    const exportWorkspace = vi.fn().mockRejectedValue(new Error('export-private failure'));
    const client = makeClient({ core: { listWorkspaces }, app: { exportWorkspace } });
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
    expect(exportWorkspace.mock.calls).toEqual([[WORKSPACE.id]]);
    expect(exportWorkspace).toHaveBeenCalledTimes(1);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    await waitFor(() =>
      expect(exportWorkspace.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id]])
    );
    expect(
      within(screen.getByRole('alert')).queryByRole('button', { name: 'Try again' })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /inspect/i })).not.toBeInTheDocument();
    expect(client.app.dryRunWorkspaceImport).not.toHaveBeenCalled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('keeps import handles and offers safe retry after a typed import review failure', async () => {
    const user = userEvent.setup();
    const dryRunWorkspaceImport = vi
      .fn()
      .mockRejectedValue(privateFailure(400, 'workspace_import_dry_run_failed'));
    const client = makeClient({ app: { dryRunWorkspaceImport } });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    await reviewImport(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't review/i);
    expect(alert).not.toHaveTextContent('portability-private failure');
    expect(alert).not.toHaveTextContent('workspace_import_dry_run_failed');
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toHaveValue(WORKSPACE.id);
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toHaveValue(EXPORT_ID);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
    expect(dryRunWorkspaceImport.mock.calls).toEqual([[DRY_RUN_REQUEST]]);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(dryRunWorkspaceImport.mock.calls).toEqual([[DRY_RUN_REQUEST], [DRY_RUN_REQUEST]])
    );
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toHaveValue(WORKSPACE.id);
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toHaveValue(EXPORT_ID);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('keeps the dry-run review and retries the exact import requestId after a typed import failure', async () => {
    const user = userEvent.setup();
    const importWorkspace = vi
      .fn()
      .mockRejectedValue(privateFailure(400, 'workspace_import_failed'));
    const client = makeClient({ app: { importWorkspace } });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    await reviewImport(user);
    expect(await screen.findByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import workspace' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't import/i);
    expect(alert).not.toHaveTextContent('portability-private failure');
    expect(alert).not.toHaveTextContent('workspace_import_failed');
    expect(screen.getByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();
    expect(importWorkspace).toHaveBeenCalledTimes(1);
    const acceptedImport = acceptedImportCommand(importWorkspace);
    expect(importWorkspace.mock.calls).toEqual([[acceptedImport]]);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(importWorkspace.mock.calls).toEqual([[acceptedImport], [acceptedImport]])
    );
    expect(screen.getByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
    expect(client.app.dryRunWorkspaceImport).toHaveBeenCalledTimes(1);
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('clears vault material after a typed rebind failure and requires inspection before a new action', async () => {
    const user = userEvent.setup();
    const listWorkspaceVaultReferences = vi.fn().mockResolvedValue(VAULT_LIST);
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockRejectedValue(privateFailure(400, 'vault_reference_rebind_failed'));
    const client = makeClient({
      app: { listWorkspaceVaultReferences, rebindWorkspaceVaultReference },
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
      [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
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
        [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
        [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
      ])
    );
    expect(vaultMaterialInput()).toHaveValue('');
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.dryRunWorkspaceImport).not.toHaveBeenCalled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
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
      app: { listWorkspaceVaultReferences, rebindWorkspaceVaultReference },
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
      [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
    ]);
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id]]);
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(await screen.findByText('Active', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.dryRunWorkspaceImport).not.toHaveBeenCalled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
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
      app: { listWorkspaceVaultReferences, rebindWorkspaceVaultReference },
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
      [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
    ]);
    await waitFor(() => expect(listWorkspaceVaultReferences).toHaveBeenCalledTimes(2));
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE.id]]);
    expect(vaultQueryKeys(queryClient)).toEqual([settingsKeys.vault(WORKSPACE.id)]);
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Active', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
    expect(screen.getByText(/no vault references/i)).toBeInTheDocument();
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1);
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.dryRunWorkspaceImport).not.toHaveBeenCalled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    ['import', 'success'],
    ['import', 'failure'],
    ['rebind', 'success'],
    ['rebind', 'failure'],
  ] as const)('keeps user import global and a late Workspace rebind scoped for %s %s', async (operation, settlement) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [WORKSPACE, WORKSPACE_B] });
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        Promise.resolve(workspaceId === WORKSPACE.id ? VAULT_LIST : EMPTY_VAULT_B)
      );
    const importWorkspace = vi.fn().mockImplementation((input: unknown) => {
      if (operation === 'import') {
        return pending.promise;
      }
      return Promise.resolve(importResultFor(input));
    });
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockReturnValue(operation === 'rebind' ? pending.promise : Promise.resolve(REBIND_MUTATION));
    const client = makeClient({
      core: { listWorkspaces },
      app: { importWorkspace, listWorkspaceVaultReferences, rebindWorkspaceVaultReference },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();

    if (operation === 'import') {
      await reviewImport(user);
      expect(await screen.findByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Import workspace' }));
      await waitFor(() => expect(importWorkspace).toHaveBeenCalledTimes(1));
    } else {
      await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
      await user.click(rebindControl());
      await confirmRebind(user);
      await waitFor(() =>
        expect(rebindWorkspaceVaultReference.mock.calls).toEqual([
          [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
        ])
      );
    }

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(listWorkspaceVaultReferences.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE_B.id]])
    );
    expect(await screen.findByText(WORKSPACE_B.name, { exact: true })).toBeInTheDocument();
    if (operation === 'import') {
      expect(screen.getByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toHaveValue(
        WORKSPACE.id
      );
      expect(screen.getByRole('textbox', { name: 'Export ID' })).toHaveValue(EXPORT_ID);
    } else {
      expect(screen.queryByText(COLLISION.suggestedWorkspaceId)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(IMPORTED_WORKSPACE.name)).not.toBeInTheDocument();
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebind/i })).toBeNull();
    assertNoLeakedInternals(queryClient);

    await act(async () => {
      if (settlement === 'success') {
        pending.resolve(
          operation === 'import'
            ? importResultFor(importWorkspace.mock.calls[0]?.[0])
            : REBIND_MUTATION
        );
      } else {
        pending.reject(
          privateFailure(
            400,
            operation === 'import' ? 'workspace_import_failed' : 'vault_reference_rebind_failed'
          )
        );
      }
      await pending.promise.catch(() => undefined);
    });

    const main = screen.getByRole('main');
    if (operation === 'import') {
      expect(within(main).getByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
      if (settlement === 'failure') {
        expect(within(main).queryByText(IMPORTED_WORKSPACE.name)).not.toBeInTheDocument();
        expect(await within(main).findByRole('alert')).toHaveTextContent(/couldn't import/i);
      } else {
        expect(await within(main).findByText(IMPORTED_WORKSPACE.name)).toBeInTheDocument();
        expect(within(main).queryByRole('alert')).not.toBeInTheDocument();
      }
    } else {
      expect(within(main).queryByText(IMPORTED_WORKSPACE.name)).not.toBeInTheDocument();
      expect(within(main).queryByText(COLLISION.suggestedWorkspaceId)).not.toBeInTheDocument();
      expect(within(main).queryByRole('alert')).not.toBeInTheDocument();
    }
    expect(within(main).queryByText('Active', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't rebind/i)).not.toBeInTheDocument();
    expect(screen.queryByText('portability-private failure')).not.toBeInTheDocument();
    expect(listWorkspaceVaultReferences.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE_B.id]]);
    expect(importWorkspace).toHaveBeenCalledTimes(operation === 'import' ? 1 : 0);
    expect(rebindWorkspaceVaultReference).toHaveBeenCalledTimes(operation === 'rebind' ? 1 : 0);
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('clears typed Vault material on Workspace switch without retaining it in TanStack', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [WORKSPACE, WORKSPACE_B] });
    const listWorkspaceVaultReferences = vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        Promise.resolve(workspaceId === WORKSPACE.id ? VAULT_LIST : EMPTY_VAULT_B)
      );
    const client = makeClient({
      core: { listWorkspaces },
      app: { listWorkspaceVaultReferences },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await user.type(vaultMaterialInput(), VAULT_MATERIAL);
    expect(vaultMaterialInput()).toHaveValue(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL);
    expect(retainedPortabilityState(queryClient)).not.toContain(VAULT_MATERIAL_BASE64);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(listWorkspaceVaultReferences.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE_B.id]])
    );
    expect(screen.queryByLabelText('Vault material')).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    expect(vaultMaterialInput()).toHaveValue('');
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    assertNoLeakedInternals(queryClient);
  });

  it('keeps user-scoped import without export or Vault for Quick Chat', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [QUICK_CHAT_WORKSPACE] });
    const client = makeClient({
      core: { listWorkspaces },
      app: { dryRunWorkspaceImport: vi.fn().mockResolvedValue(DRY_RUN_AVAILABLE) },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByText(QUICK_CHAT_WORKSPACE.name, { exact: true })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent(/select or create a project workspace/i);
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toBeInTheDocument();
    await proveUserScopedImport(user, client, queryClient);
  });

  it('keeps user-scoped import available when no Workspace is selected and does not describe it as selected-Workspace permission', async () => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [] });
    const client = makeClient({
      core: { listWorkspaces },
      app: { dryRunWorkspaceImport: vi.fn().mockResolvedValue(DRY_RUN_AVAILABLE) },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent(/select or create a project workspace/i);
    expect(main).not.toHaveTextContent(/select or create a workspace to export, import/i);
    expect(vaultQueryKeys(queryClient)).toEqual([]);
    await proveUserScopedImport(user, client, queryClient);
  });

  it('keeps existing Portability UI plus stale or error indication when a background Workspace refetch fails', async () => {
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({ items: [WORKSPACE] })
      .mockRejectedValueOnce(new Error('workspace-private failure'));
    const client = makeClient({ core: { listWorkspaces } });
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
      expect(screen.getByRole('button', { name: 'Export workspace' })).toBeEnabled();
      expect(screen.getByText('Unbound', { exact: true })).toBeInTheDocument();
      expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument();
      expect(
        screen.getByText(/status may be stale|couldn't load workspaces|couldn't refresh/i)
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('workspace-private failure')).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient);
  });

  it('names each Rebind control from public-schema secretKind and a per-reference discriminator', async () => {
    const client = makeClient({
      app: { listWorkspaceVaultReferences: vi.fn().mockResolvedValue(TWO_UNBOUND_VAULT) },
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
      copy: /access denied/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'dry-run' as const,
      status: 400,
      code: 'workspace_import_dry_run_failed',
      copy: /couldn't review|could not verify/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'dry-run' as const,
      status: 403,
      code: 'workspace_import_forbidden',
      copy: /forbidden|unavailable|access denied/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'import' as const,
      status: 403,
      code: 'workspace_import_forbidden',
      copy: /forbidden|unavailable|access denied/i,
      forbidden: /conflict|recovery required/i,
    },
    {
      command: 'import' as const,
      status: 400,
      code: 'workspace_import_failed',
      copy: /couldn't import|could not verify or publish/i,
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
    const dryRunWorkspaceImport = vi
      .fn()
      .mockRejectedValue(scenario.command === 'dry-run' ? error : undefined)
      .mockResolvedValue(DRY_RUN);
    const importWorkspace = vi
      .fn()
      .mockRejectedValue(scenario.command === 'import' ? error : undefined)
      .mockImplementation((input: unknown) => Promise.resolve(importResultFor(input)));
    const rebindWorkspaceVaultReference = vi
      .fn()
      .mockRejectedValue(scenario.command === 'rebind' ? error : undefined)
      .mockResolvedValue(REBIND_MUTATION);
    const client = makeClient({
      app: {
        exportWorkspace,
        dryRunWorkspaceImport,
        importWorkspace,
        rebindWorkspaceVaultReference,
      },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();

    if (scenario.command === 'export') {
      exportWorkspace.mockReset();
      exportWorkspace.mockRejectedValue(error);
      await user.click(screen.getByRole('button', { name: 'Export workspace' }));
    } else if (scenario.command === 'dry-run') {
      dryRunWorkspaceImport.mockReset();
      dryRunWorkspaceImport.mockRejectedValue(error);
      await reviewImport(user);
    } else if (scenario.command === 'import') {
      importWorkspace.mockReset();
      importWorkspace.mockRejectedValue(error);
      await reviewImport(user);
      expect(await screen.findByText(COLLISION.suggestedWorkspaceId)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Import workspace' }));
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
    if (scenario.command === 'import' || scenario.command === 'dry-run') {
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
    } else {
      expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    }
    assertNoLeakedInternals(queryClient);
  });

  it.each([
    ['zero workspaces', [] as const],
    ['only Quick Chat', [QUICK_CHAT_WORKSPACE]],
  ] as const)('reaches user-scoped Portability from Settings with %s', async (_label, items) => {
    const user = userEvent.setup();
    const listWorkspaces = vi.fn().mockResolvedValue({ items: [...items] });
    const client = makeClient({
      core: { listWorkspaces },
      app: { dryRunWorkspaceImport: vi.fn().mockResolvedValue(DRY_RUN_AVAILABLE) },
    });
    const { queryClient } = renderApp('/', client);

    const appNav = await screen.findByRole('navigation', { name: 'Primary workspace navigation' });
    expect(within(appNav).queryByRole('button', { name: 'Portability' })).not.toBeInTheDocument();
    await user.click(within(appNav).getByRole('button', { name: 'Settings' }));
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    await user.click(await within(nav).findByRole('button', { name: 'Portability' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portability' })
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeInTheDocument();
    expectVaultUiAbsent(client);
    await proveUserScopedImport(user, client, queryClient);
  });

  it('keeps user import visible, usable, and unremounted while the project Vault query is pending', async () => {
    const user = userEvent.setup();
    const pendingVault = createDeferred<typeof VAULT_LIST>();
    const pendingImport = createDeferred<ReturnType<typeof importResultFor>>();
    const listWorkspaceVaultReferences = vi.fn().mockReturnValue(pendingVault.promise);
    const importWorkspace = vi.fn().mockReturnValue(pendingImport.promise);
    const client = makeClient({
      app: { listWorkspaceVaultReferences, importWorkspace },
    });
    const { queryClient } = renderApp('/settings/portability', client);

    await waitFor(() =>
      expect(vi.mocked(client.app.listWorkspaceVaultReferences).mock.calls).toEqual([
        [WORKSPACE.id],
      ])
    );
    const importNode = await screen.findByRole('region', { name: 'Import' });
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Review import' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeDisabled();
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();

    await reviewImport(user);
    await waitFor(() =>
      expect(vi.mocked(client.app.dryRunWorkspaceImport).mock.calls).toEqual([[DRY_RUN_REQUEST]])
    );
    expectReviewSummary(DRY_RUN);
    expect(screen.getByRole('button', { name: 'Import workspace' })).toBeEnabled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import workspace' }));
    await waitFor(() => expect(client.app.importWorkspace).toHaveBeenCalledTimes(1));
    const acceptedImport = acceptedImportCommand(vi.mocked(client.app.importWorkspace));
    expect(vi.mocked(client.app.importWorkspace).mock.calls).toEqual([[acceptedImport]]);
    expect(importSection()).toBe(importNode);
    expect(screen.queryByText('Unbound', { exact: true })).not.toBeInTheDocument();
    expect(client.app.listWorkspaceVaultReferences).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingImport.resolve(importResultFor(acceptedImport));
      pendingVault.resolve(VAULT_LIST);
      await pendingImport.promise;
    });

    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    expect(importSection()).toBe(importNode);
    expect(screen.getByRole('textbox', { name: 'Source workspace ID' })).toHaveValue(WORKSPACE.id);
    expect(screen.getByRole('textbox', { name: 'Export ID' })).toHaveValue(EXPORT_ID);
    expect(client.app.dryRunWorkspaceImport).toHaveBeenCalledTimes(1);
    expect(client.app.importWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.app.importWorkspace).mock.calls).toEqual([[acceptedImport]]);
    assertNoLeakedInternals(queryClient);
  });

  it('requires a separate explicit Vault rebind confirmation whose Cancel makes zero API calls and Confirm makes one', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderApp('/settings/portability', client);

    expect(await screen.findByText('Unbound', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(client.app.listWorkspaceVaultReferences).toHaveBeenCalledTimes(1));
    await user.click(rebindControl());
    const emptyDialog = await screen.findByRole('dialog', {
      name: new RegExp(`confirm rebind ${UNBOUND_REFERENCE.secretKind}`, 'i'),
    });
    expect(emptyDialog).toHaveTextContent(UNBOUND_REFERENCE.referenceId);
    expect(within(emptyDialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();
    await user.click(within(emptyDialog).getByRole('button', { name: 'Cancel' }));
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    const readsAfterLoad = {
      exportWorkspace: vi.mocked(client.app.exportWorkspace).mock.calls.length,
      dryRunWorkspaceImport: vi.mocked(client.app.dryRunWorkspaceImport).mock.calls.length,
      importWorkspace: vi.mocked(client.app.importWorkspace).mock.calls.length,
      listWorkspaceVaultReferences: vi.mocked(client.app.listWorkspaceVaultReferences).mock.calls
        .length,
      listWorkspaceVaultGrants: vi.mocked(client.app.listWorkspaceVaultGrants).mock.calls.length,
      listWorkspaceVaultUseRecords: vi.mocked(client.app.listWorkspaceVaultUseRecords).mock.calls
        .length,
      rebindWorkspaceVaultReference: vi.mocked(client.app.rebindWorkspaceVaultReference).mock.calls
        .length,
    };
    expect(readsAfterLoad.rebindWorkspaceVaultReference).toBe(0);
    await user.click(rebindControl());
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', { name: /confirm/i });
    expect(dialog).toHaveTextContent(UNBOUND_REFERENCE.secretKind);
    expect(dialog).toHaveTextContent(UNBOUND_REFERENCE.referenceId);
    expect(dialog).toHaveTextContent(/becomes active/i);
    expect(dialog).toHaveTextContent(/cannot be rebound again/i);
    assertNoLeakedInternals(queryClient, 'cache');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    assertNoLeakedInternals(queryClient, 'cache');
    expect(vi.mocked(client.app.exportWorkspace).mock.calls.length).toBe(
      readsAfterLoad.exportWorkspace
    );
    expect(vi.mocked(client.app.dryRunWorkspaceImport).mock.calls.length).toBe(
      readsAfterLoad.dryRunWorkspaceImport
    );
    expect(vi.mocked(client.app.importWorkspace).mock.calls.length).toBe(
      readsAfterLoad.importWorkspace
    );
    expect(vi.mocked(client.app.listWorkspaceVaultReferences).mock.calls.length).toBe(
      readsAfterLoad.listWorkspaceVaultReferences
    );
    expect(vi.mocked(client.app.listWorkspaceVaultGrants).mock.calls.length).toBe(
      readsAfterLoad.listWorkspaceVaultGrants
    );
    expect(vi.mocked(client.app.listWorkspaceVaultUseRecords).mock.calls.length).toBe(
      readsAfterLoad.listWorkspaceVaultUseRecords
    );
    expect(client.app.rebindWorkspaceVaultReference).not.toHaveBeenCalled();

    await user.clear(vaultMaterialInput());
    await user.type(vaultMaterialInput(), ASCII_VAULT_MATERIAL);
    await user.click(rebindControl());
    const confirmDialog = await screen.findByRole('dialog', { name: /confirm/i });
    expect(confirmDialog).toHaveTextContent(/becomes active/i);
    expect(confirmDialog).toHaveTextContent(/cannot be rebound again/i);
    await user.click(within(confirmDialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(client.app.rebindWorkspaceVaultReference).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.app.rebindWorkspaceVaultReference).mock.calls).toEqual([
      [WORKSPACE.id, UNBOUND_REFERENCE.referenceId, ASCII_REBIND_REQUEST],
    ]);
    expect(client.app.exportWorkspace).not.toHaveBeenCalled();
    expect(client.app.dryRunWorkspaceImport).not.toHaveBeenCalled();
    expect(client.app.importWorkspace).not.toHaveBeenCalled();
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
});
