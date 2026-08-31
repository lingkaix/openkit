import {
  ApiCallError,
  type CoreClient,
  ProtocolValidationError,
  parseWorkspaceSharingError,
} from '@openkit/core-client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useThemeStore } from '../../app/theme-store';
import { useWorkspaceStore } from '../workspace-store';
import { useMyWorkspaceInvitations } from './data';
import { useAccountAdmission, useAccountMutation } from './session';

const EMAIL = 'account-input@example.test';
const PASSWORD = 'account-password-exact';
const RESPONSE_EMAIL = 'response-user@example.test';
const RESPONSE_TOKEN = 'auth-response-token-exact';
const AUTH_REQUIRED = () =>
  new ApiCallError(401, 'Authentication required.', {
    code: 'core.auth.unauthenticated',
  });
const PRODUCT_WORKSPACES = {
  items: [
    {
      effectiveRole: 'owner' as const,
      membershipRevision: 1,
      ownerUserId: 'user-owner',
      registryRevision: 1,
      workspace: {
        counts: { artifactCount: 0, knowledgeEntryCount: 0, threadCount: 0 },
        createdAt: '2026-08-04T00:00:00.000Z',
        id: 'ws1',
        kind: 'general' as const,
        name: 'Authorized Workspace',
        status: 'active' as const,
        updatedAt: '2026-08-04T00:00:00.000Z',
      },
    },
  ],
};
const OWNER_WORKSPACES = {
  items: [
    { ...PRODUCT_WORKSPACES.items[0], registryRevision: 9 },
    {
      ...PRODUCT_WORKSPACES.items[0],
      registryRevision: 4,
      workspace: {
        ...PRODUCT_WORKSPACES.items[0].workspace,
        id: 'ws2',
        name: 'Other Authorized Workspace',
      },
    },
  ],
};
const NON_OWNER_WORKSPACES = {
  items: [
    {
      ...OWNER_WORKSPACES.items[0],
      effectiveRole: 'editor' as const,
      membershipRevision: 17,
    },
    {
      ...OWNER_WORKSPACES.items[1],
      effectiveRole: 'viewer' as const,
      membershipRevision: 19,
    },
  ],
};
const MEMBER_CREATED_AT = '2026-08-01T00:00:00.000Z';
const MEMBER_UPDATED_AT = '2026-08-04T00:00:00.000Z';
const OWNER_MEMBER = {
  accessLevel: 'editor' as const,
  createdAt: MEMBER_CREATED_AT,
  effectiveRole: 'owner' as const,
  invitationId: null,
  joinedAt: MEMBER_CREATED_AT,
  removedAt: null,
  revision: 7,
  status: 'active' as const,
  updatedAt: MEMBER_UPDATED_AT,
  userId: 'user-owner',
  workspaceId: 'ws1',
};
const EDITOR_MEMBER = {
  ...OWNER_MEMBER,
  effectiveRole: 'editor' as const,
  invitationId: 'inv-editor',
  revision: 11,
  userId: 'user-editor',
};
const VIEWER_MEMBER = {
  ...OWNER_MEMBER,
  accessLevel: 'viewer' as const,
  effectiveRole: 'viewer' as const,
  invitationId: 'inv-viewer',
  revision: 13,
  userId: 'user-viewer',
};
const REMOVED_MEMBER = {
  ...VIEWER_MEMBER,
  effectiveRole: null,
  removedAt: MEMBER_UPDATED_AT,
  revision: 15,
  status: 'removed' as const,
  userId: 'user-removed',
};
const INVITATION_BASE = {
  acceptedAt: null,
  createdAt: MEMBER_CREATED_AT,
  declinedAt: null,
  expiresAt: '2026-08-11T00:00:00.000Z',
  inviterUserId: 'user-owner',
  proposedAccessLevel: 'editor' as const,
  revokedAt: null,
  updatedAt: MEMBER_UPDATED_AT,
  workspaceId: 'ws1',
};
const PENDING_INVITATION = {
  ...INVITATION_BASE,
  effectiveStatus: 'pending' as const,
  invitationId: 'inv-pending',
  inviteeUserId: 'user-invitee-pending',
  revision: 21,
};
const EXPIRED_INVITATION = {
  ...INVITATION_BASE,
  effectiveStatus: 'expired' as const,
  expiresAt: '2026-08-03T00:00:00.000Z',
  invitationId: 'inv-expired',
  inviteeUserId: 'user-invitee-expired',
  revision: 22,
};
const ACCEPTED_INVITATION = {
  ...INVITATION_BASE,
  acceptedAt: MEMBER_UPDATED_AT,
  effectiveStatus: 'accepted' as const,
  invitationId: 'inv-accepted',
  inviteeUserId: 'user-invitee-accepted',
  revision: 23,
};
const DECLINED_INVITATION = {
  ...INVITATION_BASE,
  declinedAt: MEMBER_UPDATED_AT,
  effectiveStatus: 'declined' as const,
  invitationId: 'inv-declined',
  inviteeUserId: 'user-invitee-declined',
  revision: 24,
};
const REVOKED_INVITATION = {
  ...INVITATION_BASE,
  effectiveStatus: 'revoked' as const,
  invitationId: 'inv-revoked',
  inviteeUserId: 'user-invitee-revoked',
  revision: 25,
  revokedAt: MEMBER_UPDATED_AT,
};
const OTHER_PENDING_INVITATION = {
  ...PENDING_INVITATION,
  invitationId: 'inv-other-pending',
  inviteeUserId: 'user-invitee-other',
  revision: 31,
  workspaceId: 'ws2',
};
const SELF_REMOVED_MEMBER = {
  ...EDITOR_MEMBER,
  effectiveRole: null,
  invitationId: 'inv-current-user',
  removedAt: MEMBER_UPDATED_AT,
  revision: 18,
  status: 'removed' as const,
  userId: 'user-current',
};
const WORKSPACE_MEMBERS = {
  items: [OWNER_MEMBER, EDITOR_MEMBER, VIEWER_MEMBER, REMOVED_MEMBER],
};
const WORKSPACE_INVITATIONS = {
  items: [
    PENDING_INVITATION,
    EXPIRED_INVITATION,
    ACCEPTED_INVITATION,
    DECLINED_INVITATION,
    REVOKED_INVITATION,
  ],
};
const MY_INVITATIONS = {
  items: [
    PENDING_INVITATION,
    OTHER_PENDING_INVITATION,
    EXPIRED_INVITATION,
    ACCEPTED_INVITATION,
    DECLINED_INVITATION,
    REVOKED_INVITATION,
  ],
};
const AUTH_USER = {
  createdAt: '2026-08-04T00:00:00.000Z',
  email: RESPONSE_EMAIL,
  emailVerified: true,
  id: 'user-response',
  name: 'Response User',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

/** Creates an auth failure whose structured fields expose every prohibited retained value. */
function poisonAuthFailure() {
  return new ApiCallError(422, 'Authentication failed.', {
    code: `auth.failed.${PASSWORD}`,
    details: {
      credential: { email: EMAIL, password: PASSWORD },
      response: { email: RESPONSE_EMAIL, token: RESPONSE_TOKEN },
    },
    path: ['credentials', EMAIL],
    requestId: `request-${RESPONSE_TOKEN}`,
  });
}

/** A promise whose settlement remains under the test's control. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** Serializes retained state, including enumerable Error fields that JSON normally drops. */
function inspectRetained(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value !== 'object' || value === null) return String(value);
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  if (value instanceof Error) {
    return inspectRetained(
      {
        name: value.name,
        message: value.message,
        cause: value.cause,
        ...Object.fromEntries(Object.entries(value)),
      },
      seen
    );
  }
  if (Array.isArray(value)) return value.map((item) => inspectRetained(item, seen)).join('|');
  return Object.entries(value)
    .map(([key, item]) => `${key}:${inspectRetained(item, seen)}`)
    .join('|');
}

/** Installs guards that fail if account state reaches logs or browser persistence. */
function guardSensitiveSinks(values: string[]) {
  const originalGetItem = Storage.prototype.getItem;
  const originalSetItem = Storage.prototype.setItem;
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
    this: Storage,
    key
  ) {
    if (/auth|session|credential/i.test(key)) {
      throw new Error(`Forbidden browser-owned account read: ${key}`);
    }
    return originalGetItem.call(this, key);
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value
  ) {
    if (/auth|session|credential/i.test(key) || values.some((secret) => value.includes(secret))) {
      throw new Error(`Forbidden browser-owned account state: ${key}`);
    }
    return originalSetItem.call(this, key, value);
  });
  const guardLog =
    (method: string) =>
    (...args: unknown[]) => {
      const output = inspectRetained(args);
      if (values.some((secret) => output.includes(secret))) {
        throw new Error(`Forbidden credential log through console.${method}`);
      }
    };
  const consoleSpies = [
    vi.spyOn(console, 'debug').mockImplementation(guardLog('debug')),
    vi.spyOn(console, 'error').mockImplementation(guardLog('error')),
    vi.spyOn(console, 'info').mockImplementation(guardLog('info')),
    vi.spyOn(console, 'log').mockImplementation(guardLog('log')),
    vi.spyOn(console, 'warn').mockImplementation(guardLog('warn')),
  ];
  return { consoleSpies, getItem, setItem };
}

type SensitiveSinkGuards = ReturnType<typeof guardSensitiveSinks>;

/** Captures browser storage without omitting either keys or values. */
function inspectStorage(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return { key, value: key === null ? null : storage.getItem(key) };
  });
}

/** Captures rendered output while preserving the contract's live-input value exception. */
function inspectRenderedOutput() {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const input of clone.querySelectorAll('input')) {
    input.value = '';
    input.removeAttribute('value');
  }
  return clone.innerHTML;
}

/** Captures every client retention and rendered-output surface admitted by the contract. */
function retainedAccountSurfaces(queryClient: QueryClient, guards: SensitiveSinkGuards) {
  return inspectRetained({
    dom: inspectRenderedOutput(),
    errors: screen.queryAllByRole('alert').map((item) => item.textContent),
    localStorage: inspectStorage(localStorage),
    logs: guards.consoleSpies.map((spy) => spy.mock.calls),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => ({
        data: mutation.state.data,
        error: mutation.state.error,
        variables: mutation.state.variables,
      })),
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, state: query.state })),
    sessionStorage: inspectStorage(sessionStorage),
    statuses: screen.queryAllByRole('status').map((item) => item.textContent),
    themeStore: useThemeStore.getState(),
    workspaceStore: useWorkspaceStore.getState(),
  });
}

/** Proves that account admission never crosses into deployment-only client surfaces. */
function expectNoDeploymentAdmissionProbes(forbidden: ReturnType<typeof makeClient>['forbidden']) {
  expect(forbidden.admin).not.toHaveBeenCalled();
  expect(forbidden.capabilitiesRefresh).not.toHaveBeenCalled();
  expect(forbidden.diagnostics).not.toHaveBeenCalled();
  expect(forbidden.runtimeConfig).not.toHaveBeenCalled();
  expect(forbidden.setup).not.toHaveBeenCalled();
}

/** Proves that TanStack owns an observed in-flight protected read without prescribing its key. */
function expectFetchingAccountQuery(queryClient: QueryClient) {
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .some((query) => query.getObserversCount() > 0 && query.state.fetchStatus === 'fetching')
  ).toBe(true);
}

/** Proves that TanStack retains the exact settled protected-read result without prescribing its key. */
function expectSettledAccountQuery(
  queryClient: QueryClient,
  status: 'error' | 'success',
  result: unknown
) {
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .some(
        (query) =>
          query.state.fetchStatus === 'idle' &&
          query.state.status === status &&
          (status === 'success' ? query.state.data === result : query.state.error === result)
      )
  ).toBe(true);
}

/** Returns the sole TanStack mutation owner for the current account operation. */
function expectAccountMutation(queryClient: QueryClient, status: 'error' | 'pending' | 'success') {
  const mutations = queryClient.getMutationCache().getAll();
  expect(mutations).toHaveLength(1);
  expect(mutations[0]?.state.status).toBe(status);
  return mutations[0] as (typeof mutations)[number];
}

/** Proves that a settled auth mutation keeps status ownership but no forbidden request or result. */
function expectSanitizedAccountMutation(
  queryClient: QueryClient,
  status: 'error' | 'success',
  forbiddenValues: string[]
) {
  const mutation = expectAccountMutation(queryClient, status);
  const retained = inspectRetained({
    data: mutation.state.data,
    error: mutation.state.error,
    variables: mutation.state.variables,
  });
  for (const value of forbiddenValues) {
    expect(retained).not.toContain(value);
  }
}

/** Proves that any product-shell metadata read began after its protected admission read. */
function expectMetaAfterProtectedRead(
  forbidden: ReturnType<typeof makeClient>['forbidden'],
  listAuthorizedWorkspaces: ReturnType<typeof vi.fn>,
  protectedReadIndex: number,
  metaStartIndex = 0
) {
  const protectedCallOrder = listAuthorizedWorkspaces.mock.invocationCallOrder[protectedReadIndex];
  expect(protectedCallOrder).toBeDefined();
  for (const metaCallOrder of forbidden.meta.mock.invocationCallOrder.slice(metaStartIndex)) {
    expect(metaCallOrder).toBeGreaterThan(protectedCallOrder as number);
  }
}

interface ClientOverrides {
  app?: Record<string, unknown>;
  coreWorkspaces?: unknown[];
  listAuthorizedWorkspaces?: ReturnType<typeof vi.fn>;
  signIn?: ReturnType<typeof vi.fn>;
  signOut?: ReturnType<typeof vi.fn>;
  signUp?: ReturnType<typeof vi.fn>;
}

/** Builds the strict Core Client fake for the protected-read account boundary. */
function makeClient(overrides: ClientOverrides = {}) {
  const forbidden = {
    admin: vi.fn().mockRejectedValue(new Error('account admission used administrator API')),
    capabilitiesRefresh: vi
      .fn()
      .mockRejectedValue(new Error('account admission used capabilities')),
    diagnostics: vi.fn().mockRejectedValue(new Error('account admission used diagnostics')),
    meta: vi.fn().mockResolvedValue({}),
    runtimeConfig: vi.fn().mockRejectedValue(new Error('account admission used runtime config')),
    setup: vi.fn().mockRejectedValue(new Error('account admission used setup diagnostics')),
  };
  const listAuthorizedWorkspaces =
    overrides.listAuthorizedWorkspaces ?? vi.fn().mockResolvedValue(PRODUCT_WORKSPACES);
  const client = {
    app: {
      disableUser: forbidden.admin,
      getDiagnostics: forbidden.diagnostics,
      getSetupDiagnostics: forbidden.setup,
      getWorkspaceAccessRecoveryState: forbidden.admin,
      listAuthorizedWorkspaces,
      listServerAuditEvents: forbidden.admin,
      listServerPermissionDecisions: forbidden.admin,
      listServerVaultUseRecords: forbidden.admin,
      recoverWorkspaceAccess: forbidden.admin,
      ...overrides.app,
    },
    auth: {
      email: {
        signIn: overrides.signIn ?? vi.fn(),
        signOut: overrides.signOut ?? vi.fn(),
        signUp: overrides.signUp ?? vi.fn(),
      },
    },
    capabilities: {
      refresh: forbidden.capabilitiesRefresh,
      require: vi.fn(),
      snapshot: vi.fn().mockReturnValue(null),
      supports: vi.fn().mockReturnValue(false),
    },
    core: {
      listWorkspaces: vi.fn().mockResolvedValue({
        items: overrides.coreWorkspaces ?? [{ id: 'ws1', name: 'Authorized Workspace' }],
      }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      meta: forbidden.meta,
    },
    runtimeConfig: {
      getFile: forbidden.runtimeConfig,
      listFiles: forbidden.runtimeConfig,
    },
  } as unknown as CoreClient;
  return { client, forbidden, listAuthorizedWorkspaces };
}

interface SharingOverrides {
  authorizedWorkspaces?: { readonly items: readonly unknown[] };
  coreWorkspaces?: unknown[];
  methods?: Partial<Record<keyof CoreClient['app'], ReturnType<typeof vi.fn>>>;
}

/** Builds the owner-management fake without inventing a second client boundary. */
function makeSharingClient(overrides: SharingOverrides = {}) {
  const methods = {
    acceptWorkspaceInvitation: vi.fn(),
    changeWorkspaceMemberAccess: vi.fn(),
    createWorkspaceInvitation: vi.fn(),
    declineWorkspaceInvitation: vi.fn(),
    leaveWorkspace: vi.fn(),
    listMyWorkspaceInvitations: vi.fn().mockResolvedValue({ items: [] }),
    listWorkspaceInvitations: vi.fn().mockResolvedValue(WORKSPACE_INVITATIONS),
    listWorkspaceMembers: vi.fn().mockResolvedValue(WORKSPACE_MEMBERS),
    removeWorkspaceMember: vi.fn(),
    revokeWorkspaceInvitation: vi.fn(),
    transferWorkspaceOwnership: vi.fn(),
    ...overrides.methods,
  };
  return {
    ...makeClient({
      app: methods,
      coreWorkspaces: overrides.coreWorkspaces,
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue(overrides.authorizedWorkspaces ?? OWNER_WORKSPACES),
    }),
    methods,
  };
}

/** Renders one route with isolated TanStack state and the supplied client. */
function renderApp(path: string, client: CoreClient) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

/** Exposes each existing auth transition beside the active unrelated-query sentinel it must preserve. */
function AccountCacheTransitionHarness({
  unrelatedRead,
}: {
  unrelatedRead: () => Promise<{ retained: boolean }>;
}) {
  useAccountAdmission();
  const accountMutation = useAccountMutation();
  const myInvitations = useMyWorkspaceInvitations();
  const operations = ['signIn', 'signUp', 'signOut'] as const;
  useQuery({
    queryFn: unrelatedRead,
    queryKey: ['account', 's22-q-unrelated'],
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <main aria-label="Account cache transition">
      {myInvitations.invitations.data?.items.map((invitation) => (
        <p key={invitation.invitationId}>
          {invitation.invitationId} {invitation.inviteeUserId} {invitation.workspaceId}
        </p>
      ))}
      {operations.map((operation) => (
        <button
          key={operation}
          onClick={() =>
            accountMutation.mutate({
              email: operation === 'signOut' ? '' : EMAIL,
              name: operation === 'signUp' ? 'Account User' : '',
              operation,
              password: operation === 'signOut' ? '' : PASSWORD,
            })
          }
          type="button"
        >
          {operation}
        </button>
      ))}
    </main>
  );
}

/** Exposes one current-user invitation decision before one successful account transition. */
function AccountDecisionCacheTransitionHarness({
  operation,
}: {
  operation: 'signIn' | 'signUp' | 'signOut';
}) {
  useAccountAdmission();
  const accountMutation = useAccountMutation();
  const myInvitations = useMyWorkspaceInvitations();
  const invitation = myInvitations.invitations.data?.items[0];

  return (
    <main aria-label="Account decision cache transition">
      {invitation ? (
        <p>
          {invitation.invitationId} {invitation.inviteeUserId} {invitation.workspaceId}
        </p>
      ) : null}
      <button
        disabled={!invitation}
        onClick={() =>
          invitation &&
          myInvitations.decision.mutate({
            expectedRevision: invitation.revision,
            invitationId: invitation.invitationId,
            operation: 'accept',
          })
        }
        type="button"
      >
        settle invitation decision
      </button>
      <button
        onClick={() =>
          accountMutation.mutate({
            email: operation === 'signOut' ? '' : EMAIL,
            name: operation === 'signUp' ? 'Account User' : '',
            operation,
            password: operation === 'signOut' ? '' : PASSWORD,
          })
        }
        type="button"
      >
        {operation}
      </button>
    </main>
  );
}

/** Returns the account form's exact live credential inputs. */
function credentialInputs() {
  return {
    email: screen.getByRole('textbox', { name: /^email$/i }) as HTMLInputElement,
    password: screen.getByLabelText(/^password$/i) as HTMLInputElement,
  };
}

/** Enters the exact request values and invokes one auth operation. */
async function submitAuth(mode: 'signIn' | 'signUp') {
  const user = userEvent.setup();
  if (mode === 'signUp' && !screen.queryByRole('textbox', { name: /^name$/i })) {
    const switcher =
      screen.queryByRole('tab', { name: /sign up/i }) ??
      screen.getByRole('button', { name: /sign up/i });
    await user.click(switcher);
  }
  if (mode === 'signUp') {
    await user.type(screen.getByRole('textbox', { name: /^name$/i }), 'Account User');
  }
  const inputs = credentialInputs();
  await user.type(inputs.email, EMAIL);
  await user.type(inputs.password, PASSWORD);
  await user.click(
    screen.getByRole('button', { name: mode === 'signIn' ? /sign in/i : /sign up/i })
  );
  return { user, ...inputs };
}

/** The rendered account gate is the only UI admitted by typed unauthenticated state. */
function expectAccountGate() {
  expect(screen.getByRole('form', { name: /account access/i })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^email$/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.queryByRole('main', { name: 'Workspace' })).not.toBeInTheDocument();
}

/** The protected read is the only operation allowed to settle the post-auth account state. */
function expectProtectedReadPending() {
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.queryByRole('main', { name: 'Workspace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('form', { name: /account access/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
}

/** Reaches a control with Tab alone and stops if focus cycles without finding it. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  const visited = new Set<Element | null>();
  while (document.activeElement !== target && !visited.has(document.activeElement)) {
    visited.add(document.activeElement);
    await user.tab();
  }
  expect(target).toHaveFocus();
}

/** Finds one named row action whether it is inline or behind an accessible actions surface. */
async function revealRowAction(
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
  name: RegExp
) {
  const inline = within(row).queryByRole('button', { name });
  if (inline) return inline;
  const opener = within(row).getByRole('button', { name: /actions|manage|more/i });
  await user.click(opener);
  const surface = screen.queryByRole('menu') ?? screen.getByRole('dialog');
  return (
    within(surface).queryByRole('menuitem', { name }) ??
    within(surface).getByRole('button', { name })
  );
}

/** Proves one row action is absent from both inline controls and its accessible action surface. */
async function expectNoRowAction(
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
  name: RegExp
) {
  expect(within(row).queryByRole('button', { name })).not.toBeInTheDocument();
  const opener = within(row).queryByRole('button', { name: /actions|manage|more/i });
  if (!opener) return;
  await user.click(opener);
  const surface = screen.queryByRole('menu') ?? screen.getByRole('dialog');
  expect(within(surface).queryByRole('menuitem', { name })).not.toBeInTheDocument();
  expect(within(surface).queryByRole('button', { name })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
}

/** Chooses a member access level through either inline controls or an accessible row action surface. */
async function chooseMemberAccess(
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
  accessLevel: 'editor' | 'viewer'
) {
  let surface = row;
  let select =
    within(surface)
      .queryAllByRole('button', { name: /access level/i })
      .find((button) => button.getAttribute('aria-haspopup') === 'listbox') ??
    within(surface).queryByRole('combobox', { name: /access level/i });
  if (!select) {
    const action = await revealRowAction(user, row, /change access|access level/i);
    await user.click(action);
    surface =
      screen.queryByRole('dialog', { name: /access/i }) ?? screen.queryByRole('menu') ?? row;
    select =
      within(surface)
        .queryAllByRole('button', { name: /access level/i })
        .find((button) => button.getAttribute('aria-haspopup') === 'listbox') ??
      within(surface).queryByRole('combobox', { name: /access level/i });
  }
  if (select) {
    await user.click(select);
    const listbox = await screen.findByRole('listbox');
    await user.click(
      within(listbox).getByRole('option', { name: new RegExp(`^${accessLevel}$`, 'i') })
    );
  } else {
    const name = new RegExp(`^${accessLevel}$`, 'i');
    const option =
      within(surface).queryByRole('radio', { name }) ??
      within(surface).getByRole('button', { name });
    await user.click(option);
  }
  return (
    within(surface).queryByRole('button', { name: /save access|change access|confirm/i }) ??
    within(row).getByRole('button', { name: /save access|change access/i })
  );
}

/** Proves a settled sharing operation retains no exact invitation email on any client surface. */
function expectNoRetainedInviteEmail(
  queryClient: QueryClient,
  guards: SensitiveSinkGuards,
  liveField?: HTMLInputElement
) {
  if (liveField) expect(liveField).toHaveValue('');
  expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(EMAIL);
}

/** Waits for one affected row or its explicitly named operation status to show settlement. */
async function expectScopedOperationSettlement(input: {
  regionName: string;
  rowIdentity: RegExp;
  rowState: RegExp;
  statusName: RegExp;
  statusState: RegExp;
}) {
  await waitFor(() => {
    const region = screen.queryByRole('region', { name: input.regionName });
    const row = region ? within(region).queryByRole('row', { name: input.rowIdentity }) : null;
    const status = screen.queryByRole('status', { name: input.statusName });
    expect(
      (row !== null && input.rowState.test(row.textContent ?? '')) ||
        (status !== null && input.statusState.test(status.textContent ?? ''))
    ).toBe(true);
  });
}

/** Proves the protected account cache contains exactly the expected authorized Workspace rows. */
function expectAuthorizedWorkspaceIds(queryClient: QueryClient, workspaceIds: string[]) {
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .some((query) => {
        const data = query.state.data;
        if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) {
          return false;
        }
        const items = data.items as unknown[];
        return (
          items.every(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'ownerUserId' in item &&
              'workspace' in item
          ) &&
          items
            .map((item) => (item as (typeof NON_OWNER_WORKSPACES.items)[number]).workspace.id)
            .join('|') === workspaceIds.join('|')
        );
      })
  ).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useThemeStore.setState({ theme: 'spectrum' });
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('protected-read account gate', () => {
  it('bootstraps from the protected read and keeps a truthful stable pending surface outside the product shell', async () => {
    const pending = deferred<typeof PRODUCT_WORKSPACES>();
    const { client, forbidden, listAuthorizedWorkspaces } = makeClient({
      listAuthorizedWorkspaces: vi.fn().mockReturnValue(pending.promise),
    });
    const { queryClient } = renderApp('/', client);

    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(1));
    expectFetchingAccountQuery(queryClient);
    expect(screen.getByRole('status')).toHaveTextContent(/checking.*account|checking.*access/i);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('main', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
    expect(forbidden.meta).not.toHaveBeenCalled();
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it.each([
    ['empty', { items: [] }],
    ['populated', PRODUCT_WORKSPACES],
  ])('enters the product after a successful %s protected response', async (_case, response) => {
    const pending = deferred<typeof response>();
    const { client, forbidden, listAuthorizedWorkspaces } = makeClient({
      listAuthorizedWorkspaces: vi.fn().mockReturnValue(pending.promise),
    });
    const { queryClient } = renderApp('/', client);

    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(1));
    expectFetchingAccountQuery(queryClient);
    expect(forbidden.meta).not.toHaveBeenCalled();
    pending.resolve(response);
    expect(await screen.findByRole('navigation')).toHaveAccessibleName(
      'Primary workspace navigation'
    );
    expect(screen.getByRole('main', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /account access/i })).not.toBeInTheDocument();
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(1);
    expectSettledAccountQuery(queryClient, 'success', response);
    expectMetaAfterProtectedRead(forbidden, listAuthorizedWorkspaces, 0);
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it.each([
    ['status-only 401', new ApiCallError(401, 'Authentication required.')],
    [
      'unauthenticated code at the wrong status',
      new ApiCallError(403, 'Denied.', { code: 'core.auth.unauthenticated' }),
    ],
    [
      '401 with a different non-null code',
      new ApiCallError(401, 'Denied.', { code: 'core.auth.forbidden' }),
    ],
    ['network failure', new TypeError('Failed to fetch')],
    [
      'protocol failure',
      new ProtocolValidationError({
        code: 'invalid_type',
        message: 'Malformed payload.',
        path: [],
      }),
    ],
    ['other API failure', new ApiCallError(500, 'Unavailable.', { code: 'core.internal' })],
  ])('keeps %s retryable and never translates it to an account gate', async (_case, failure) => {
    const listAuthorizedWorkspaces = vi.fn().mockRejectedValue(failure);
    const { client, forbidden } = makeClient({ listAuthorizedWorkspaces });
    const { queryClient } = renderApp('/deep/protected/route', client);

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t|failed|try again/i);
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeEnabled();
    expect(screen.queryByRole('form', { name: /account access/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expectSettledAccountQuery(queryClient, 'error', failure);
    expect(forbidden.meta).not.toHaveBeenCalled();
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it('opens the accessible reference-composed gate only for typed unauthenticated, including deep routes', async () => {
    const failure = AUTH_REQUIRED();
    const listAuthorizedWorkspaces = vi.fn().mockRejectedValue(failure);
    const { client, forbidden } = makeClient({
      listAuthorizedWorkspaces,
    });
    const { container, queryClient } = renderApp('/goals/ws1/deep-thread', client);

    await screen.findByRole('form', { name: /account access/i });
    expectAccountGate();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /sign up/i })).toBeEnabled();
    expect(screen.getByRole('heading')).toHaveTextContent(/account|openkit/i);
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    ).toHaveNoViolations();
    expectSettledAccountQuery(queryClient, 'error', failure);
    expect(forbidden.meta).not.toHaveBeenCalled();
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it('supports keyboard-only traversal and activation of the account gate', async () => {
    const authPending = deferred<never>();
    const signIn = vi.fn().mockReturnValue(authPending.promise);
    const { client, forbidden } = makeClient({
      listAuthorizedWorkspaces: vi.fn().mockRejectedValue(AUTH_REQUIRED()),
      signIn,
    });
    const { queryClient } = renderApp('/', client);

    await screen.findByRole('form', { name: /account access/i });
    const user = userEvent.setup();
    const { email, password } = credentialInputs();
    const submit = screen.getByRole('button', { name: /sign in/i });
    await tabTo(user, email);
    await user.keyboard(EMAIL);
    await tabTo(user, password);
    await user.keyboard(PASSWORD);
    await tabTo(user, submit);
    await user.keyboard('{Enter}');

    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expectAccountMutation(queryClient, 'pending');
    expect(forbidden.meta).not.toHaveBeenCalled();
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it('renders authenticated Account as a real neutral Settings route with Sign Out', async () => {
    const protectedRead = deferred<typeof PRODUCT_WORKSPACES>();
    const { client, forbidden, listAuthorizedWorkspaces } = makeClient({
      listAuthorizedWorkspaces: vi.fn().mockReturnValue(protectedRead.promise),
    });
    const { container, queryClient } = renderApp('/settings/account', client);

    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(1));
    expectFetchingAccountQuery(queryClient);
    expect(forbidden.meta).not.toHaveBeenCalled();
    protectedRead.resolve(PRODUCT_WORKSPACES);
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Not found' })).not.toBeInTheDocument();
    expect(screen.queryByText("This page doesn't exist")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeEnabled();
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(document.body).not.toHaveTextContent(
      /server mode|local mode|sign[ -]?up.*(?:enabled|disabled|available|unavailable)|deployment|\bhost(?:name)?\b|localhost|127\.0\.0\.1|https?:\/\//i
    );
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    ).toHaveNoViolations();
    expectSettledAccountQuery(queryClient, 'success', PRODUCT_WORKSPACES);
    expectMetaAfterProtectedRead(forbidden, listAuthorizedWorkspaces, 0);
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it('Retry repeats the protected read and enters only after that read succeeds', async () => {
    const failure = new TypeError('Failed to fetch');
    const successfulRetry = deferred<{ items: never[] }>();
    const response = { items: [] };
    const listAuthorizedWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(successfulRetry.promise);
    const { client, forbidden } = makeClient({ listAuthorizedWorkspaces });
    const { queryClient } = renderApp('/', client);

    const retry = await screen.findByRole('button', { name: /try again|retry/i });
    expectSettledAccountQuery(queryClient, 'error', failure);
    expect(forbidden.meta).not.toHaveBeenCalled();
    await userEvent.click(retry);
    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2));
    expectFetchingAccountQuery(queryClient);
    expect(forbidden.meta).not.toHaveBeenCalled();
    successfulRetry.resolve(response);
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2);
    expectSettledAccountQuery(queryClient, 'success', response);
    expectMetaAfterProtectedRead(forbidden, listAuthorizedWorkspaces, 1);
    expectNoDeploymentAdmissionProbes(forbidden);
  });
});

describe('email/password session operations', () => {
  const transitions = [
    { operation: 'signIn', outcome: 'success' },
    { operation: 'signIn', outcome: 'typed unauthenticated' },
    { operation: 'signIn', outcome: 'non-401 failure' },
    { operation: 'signUp', outcome: 'success' },
    { operation: 'signUp', outcome: 'typed unauthenticated' },
    { operation: 'signUp', outcome: 'non-401 failure' },
    { operation: 'signOut', outcome: 'success' },
    { operation: 'signOut', outcome: 'typed unauthenticated' },
    { operation: 'signOut', outcome: 'non-401 failure' },
  ] as const;

  it.each(transitions)('$operation waits for its protected read before settling $outcome', async ({
    operation,
    outcome,
  }) => {
    const initialFailure = AUTH_REQUIRED();
    const protectedRead = deferred<typeof PRODUCT_WORKSPACES>();
    const retryRead = deferred<typeof PRODUCT_WORKSPACES>();
    const authResponse =
      operation === 'signOut'
        ? { success: true }
        : operation === 'signIn'
          ? { redirect: false, token: RESPONSE_TOKEN, user: AUTH_USER }
          : { token: RESPONSE_TOKEN, user: AUTH_USER };
    const authOperation = deferred<typeof authResponse>();
    const auth = vi.fn().mockReturnValue(authOperation.promise);
    const listAuthorizedWorkspaces =
      operation === 'signOut'
        ? vi
            .fn()
            .mockResolvedValueOnce(PRODUCT_WORKSPACES)
            .mockReturnValueOnce(protectedRead.promise)
            .mockReturnValueOnce(retryRead.promise)
        : vi
            .fn()
            .mockRejectedValueOnce(initialFailure)
            .mockReturnValueOnce(protectedRead.promise)
            .mockReturnValueOnce(retryRead.promise);
    const { client, forbidden } = makeClient({
      listAuthorizedWorkspaces,
      [operation]: auth,
    });
    const { queryClient } = renderApp(operation === 'signOut' ? '/settings/account' : '/', client);

    if (operation === 'signOut') {
      const signOut = await screen.findByRole('button', { name: /sign out/i });
      expectSettledAccountQuery(queryClient, 'success', PRODUCT_WORKSPACES);
      expectMetaAfterProtectedRead(forbidden, listAuthorizedWorkspaces, 0);
      await userEvent.click(signOut);
      expect(auth).toHaveBeenCalledWith();
    } else {
      await screen.findByRole('form', { name: /account access/i });
      expectSettledAccountQuery(queryClient, 'error', initialFailure);
      expect(forbidden.meta).not.toHaveBeenCalled();
      await submitAuth(operation);
      expect(auth).toHaveBeenCalledWith(
        operation === 'signIn'
          ? { email: EMAIL, password: PASSWORD }
          : { email: EMAIL, name: 'Account User', password: PASSWORD }
      );
    }

    const metaCallsBeforeAuthSettlement = forbidden.meta.mock.calls.length;
    expectAccountMutation(queryClient, 'pending');
    expect(forbidden.meta).toHaveBeenCalledTimes(metaCallsBeforeAuthSettlement);
    authOperation.resolve(authResponse);
    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(expectProtectedReadPending);
    expectFetchingAccountQuery(queryClient);
    expectSanitizedAccountMutation(queryClient, 'success', [
      EMAIL,
      PASSWORD,
      RESPONSE_EMAIL,
      RESPONSE_TOKEN,
    ]);
    expect(forbidden.meta).toHaveBeenCalledTimes(metaCallsBeforeAuthSettlement);
    expect(auth.mock.invocationCallOrder[0]).toBeLessThan(
      listAuthorizedWorkspaces.mock.invocationCallOrder[1] as number
    );

    if (outcome === 'success') {
      const response = { items: [] };
      protectedRead.resolve(response);
      expect(await screen.findByRole('navigation')).toBeInTheDocument();
      expect(screen.queryByRole('form', { name: /account access/i })).not.toBeInTheDocument();
      expectSettledAccountQuery(queryClient, 'success', response);
      expectMetaAfterProtectedRead(
        forbidden,
        listAuthorizedWorkspaces,
        1,
        metaCallsBeforeAuthSettlement
      );
    } else if (outcome === 'typed unauthenticated') {
      const failure = AUTH_REQUIRED();
      protectedRead.reject(failure);
      await waitFor(expectAccountGate);
      expectSettledAccountQuery(queryClient, 'error', failure);
      expect(forbidden.meta).toHaveBeenCalledTimes(metaCallsBeforeAuthSettlement);
    } else {
      const failure = new TypeError('Failed to fetch');
      protectedRead.reject(failure);
      const retry = await screen.findByRole('button', { name: /try again|retry/i });
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t|failed|try again/i);
      expect(screen.queryByRole('form', { name: /account access/i })).not.toBeInTheDocument();
      expectSettledAccountQuery(queryClient, 'error', failure);
      expect(forbidden.meta).toHaveBeenCalledTimes(metaCallsBeforeAuthSettlement);
      await userEvent.click(retry);
      await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(3));
      await waitFor(expectProtectedReadPending);
      expectFetchingAccountQuery(queryClient);
      expect(forbidden.meta).toHaveBeenCalledTimes(metaCallsBeforeAuthSettlement);
      expect(auth).toHaveBeenCalledTimes(1);
      const retryResponse = { items: [] };
      retryRead.resolve(retryResponse);
      expect(await screen.findByRole('navigation')).toBeInTheDocument();
      expectSettledAccountQuery(queryClient, 'success', retryResponse);
      expectMetaAfterProtectedRead(
        forbidden,
        listAuthorizedWorkspaces,
        2,
        metaCallsBeforeAuthSettlement
      );
    }

    expect(auth).toHaveBeenCalledTimes(1);
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it.each([
    'signIn',
    'signUp',
  ] as const)('%s clears a failed password and retains no credential-bearing error field', async (mode) => {
    const poisonValues = [EMAIL, PASSWORD, RESPONSE_EMAIL, RESPONSE_TOKEN];
    const guards = guardSensitiveSinks(poisonValues);
    const failure = poisonAuthFailure();
    const inspectedFailure = inspectRetained(failure);
    expect(inspectedFailure).toContain('status:422');
    expect(inspectedFailure).toContain(`code:auth.failed.${PASSWORD}`);
    expect(inspectedFailure).toContain('details:credential:');
    expect(inspectedFailure).toContain(`path:credentials|${EMAIL}`);
    expect(inspectedFailure).toContain(`requestId:request-${RESPONSE_TOKEN}`);
    expect(inspectedFailure).toContain(`email:${RESPONSE_EMAIL}`);

    const initialFailure = AUTH_REQUIRED();
    const authPending = deferred<never>();
    const auth = vi.fn().mockReturnValue(authPending.promise);
    const { client, forbidden } = makeClient({
      listAuthorizedWorkspaces: vi.fn().mockRejectedValue(initialFailure),
      [mode]: auth,
    });
    const { queryClient } = renderApp('/', client);
    await screen.findByRole('form', { name: /account access/i });
    expectSettledAccountQuery(queryClient, 'error', initialFailure);
    expect(forbidden.meta).not.toHaveBeenCalled();
    const inputs = await submitAuth(mode);

    expectAccountMutation(queryClient, 'pending');
    expect(
      screen.getByRole('button', { name: mode === 'signIn' ? /sign in/i : /sign up/i })
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/signing in|signing up|working/i);
    expect(inputs.password).toBeDisabled();
    authPending.reject(failure);
    await waitFor(() => expect(inputs.password).toHaveValue(''));
    expect(inputs.email).toHaveValue(EMAIL);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t|failed|try again/i);
    expect(auth).toHaveBeenCalledWith(
      mode === 'signIn'
        ? { email: EMAIL, password: PASSWORD }
        : { email: EMAIL, name: 'Account User', password: PASSWORD }
    );
    expectSanitizedAccountMutation(queryClient, 'error', poisonValues);

    const retained = retainedAccountSurfaces(queryClient, guards);
    for (const poison of poisonValues) {
      expect(retained).not.toContain(poison);
    }
    expect(guards.getItem).not.toHaveBeenCalledWith(expect.stringMatching(/auth|session/i));
    expect(guards.setItem).not.toHaveBeenCalledWith(
      expect.stringMatching(/auth|session/i),
      expect.anything()
    );
    expect(forbidden.meta).not.toHaveBeenCalled();
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it.each([
    'signIn',
    'signUp',
  ] as const)('%s retains neither credentials nor its auth response while the protected read is pending or settled', async (mode) => {
    const poisonValues = [EMAIL, PASSWORD, RESPONSE_EMAIL, RESPONSE_TOKEN];
    const guards = guardSensitiveSinks(poisonValues);
    const initialFailure = AUTH_REQUIRED();
    const protectedRead = deferred<typeof PRODUCT_WORKSPACES>();
    const authResponse =
      mode === 'signIn'
        ? { redirect: false, token: RESPONSE_TOKEN, user: AUTH_USER }
        : { token: RESPONSE_TOKEN, user: AUTH_USER };
    const authOperation = deferred<typeof authResponse>();
    const auth = vi.fn().mockReturnValue(authOperation.promise);
    const listAuthorizedWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(initialFailure)
      .mockReturnValueOnce(protectedRead.promise);
    const { client, forbidden } = makeClient({
      listAuthorizedWorkspaces,
      [mode]: auth,
    });
    const { queryClient } = renderApp('/', client);

    await screen.findByRole('form', { name: /account access/i });
    expectSettledAccountQuery(queryClient, 'error', initialFailure);
    expect(forbidden.meta).not.toHaveBeenCalled();
    await submitAuth(mode);
    expectAccountMutation(queryClient, 'pending');
    authOperation.resolve(authResponse);
    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(expectProtectedReadPending);
    expectFetchingAccountQuery(queryClient);
    expectSanitizedAccountMutation(queryClient, 'success', poisonValues);
    expect(forbidden.meta).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledWith(
      mode === 'signIn'
        ? { email: EMAIL, password: PASSWORD }
        : { email: EMAIL, name: 'Account User', password: PASSWORD }
    );
    for (const poison of poisonValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(poison);
    }

    const response = { items: [] };
    protectedRead.resolve(response);
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expectSettledAccountQuery(queryClient, 'success', response);
    expectMetaAfterProtectedRead(forbidden, listAuthorizedWorkspaces, 1);
    for (const poison of poisonValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(poison);
    }
    expectNoDeploymentAdmissionProbes(forbidden);
  });

  it.each([
    'signIn',
    'signUp',
    'signOut',
  ] as const)('%s independently isolates My invitations before admission refetch on one QueryClient', async (operation) => {
    const actorAInvitation = {
      ...PENDING_INVITATION,
      invitationId: 'inv-actor-a-only',
      inviteeUserId: 'user-actor-a-only',
      workspaceId: 'ws-actor-a-only',
    };
    const actorBInvitation = {
      ...PENDING_INVITATION,
      invitationId: 'inv-actor-b-only',
      inviteeUserId: 'user-actor-b-only',
      workspaceId: 'ws-actor-b-only',
    };
    const actorAValues = [
      actorAInvitation.invitationId,
      actorAInvitation.inviteeUserId,
      actorAInvitation.workspaceId,
      'ws-actor-a-cached-catalog',
    ];
    const guards = guardSensitiveSinks(actorAValues);
    const transitionAdmission = deferred<typeof PRODUCT_WORKSPACES>();
    let actorBMountStarted = false;
    let actorBReadStartedAfterMount = false;
    const listMyWorkspaceInvitations = vi
      .fn()
      .mockResolvedValueOnce({ items: [actorAInvitation] })
      .mockImplementationOnce(() => {
        actorBReadStartedAfterMount = actorBMountStarted;
        return Promise.resolve({ items: [actorBInvitation] });
      });
    const { client, listAuthorizedWorkspaces } = makeSharingClient({
      methods: { listMyWorkspaceInvitations },
    });
    let queryClient!: QueryClient;
    let queriesAtAdmissionStart: string | undefined;
    let unrelatedQueryAtAdmissionStart: unknown;
    let unrelatedStateAtAdmissionStart: unknown;
    let unrelatedObserversAtAdmissionStart: number | undefined;
    listAuthorizedWorkspaces.mockReset().mockResolvedValueOnce(PRODUCT_WORKSPACES);
    listAuthorizedWorkspaces.mockImplementationOnce(() => {
      queriesAtAdmissionStart = inspectRetained(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => ({ key: query.queryKey, state: query.state }))
      );
      unrelatedQueryAtAdmissionStart = queryClient
        .getQueryCache()
        .find({ exact: true, queryKey: ['account', 's22-q-unrelated'] });
      unrelatedStateAtAdmissionStart = (
        unrelatedQueryAtAdmissionStart as { state?: unknown } | undefined
      )?.state;
      unrelatedObserversAtAdmissionStart = (
        unrelatedQueryAtAdmissionStart as { getObserversCount?: () => number } | undefined
      )?.getObserversCount?.();
      return transitionAdmission.promise;
    });
    listAuthorizedWorkspaces.mockResolvedValue(PRODUCT_WORKSPACES);
    const signIn = client.auth.email.signIn as ReturnType<typeof vi.fn>;
    const signOut = client.auth.email.signOut as ReturnType<typeof vi.fn>;
    const signUp = client.auth.email.signUp as ReturnType<typeof vi.fn>;
    signIn.mockResolvedValue({ redirect: false, token: RESPONSE_TOKEN, user: AUTH_USER });
    signOut.mockResolvedValue({ success: true });
    signUp.mockResolvedValue({ token: RESPONSE_TOKEN, user: AUTH_USER });
    const unrelatedKey = ['account', 's22-q-unrelated'] as const;
    const unrelatedValue = { retained: true };
    const unrelatedRead = vi.fn().mockResolvedValue(unrelatedValue);
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    queryClient.setQueryData(unrelatedKey, unrelatedValue);
    queryClient.setQueryData(['workspaces'], [{ id: 'ws-actor-a-cached-catalog' }]);
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws-actor-a-cached-catalog' });
    const unrelatedQuery = queryClient
      .getQueryCache()
      .find({ exact: true, queryKey: unrelatedKey });
    expect(unrelatedQuery).toBeDefined();
    const unrelatedState = unrelatedQuery?.state;
    const mountHarness = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={client}>
            <AccountCacheTransitionHarness unrelatedRead={unrelatedRead} />
          </CoreClientProvider>
        </QueryClientProvider>
      );
    const actorAView = mountHarness();

    await screen.findByText(/inv-actor-a-only.*user-actor-a-only.*ws-actor-a-only/i);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).toContain(actorAValue);
    }
    await userEvent.click(screen.getByRole('button', { name: operation }));

    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
    const auth = operation === 'signIn' ? signIn : operation === 'signUp' ? signUp : signOut;
    expect(auth).toHaveBeenCalledTimes(1);
    expect(auth.mock.invocationCallOrder[0]).toBeLessThan(
      listAuthorizedWorkspaces.mock.invocationCallOrder[1] as number
    );
    expect(unrelatedQueryAtAdmissionStart).toBe(unrelatedQuery);
    expect(unrelatedStateAtAdmissionStart).toBe(unrelatedState);
    expect(unrelatedObserversAtAdmissionStart).toBe(1);
    expect(unrelatedRead).not.toHaveBeenCalled();
    for (const actorAValue of actorAValues) {
      expect(queriesAtAdmissionStart).not.toContain(actorAValue);
    }
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    transitionAdmission.resolve(PRODUCT_WORKSPACES);
    actorAView.unmount();
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().find({ exact: true, queryKey: unrelatedKey })).toBe(
      unrelatedQuery
    );
    expect(unrelatedQuery?.state).toBe(unrelatedState);
    expect(unrelatedRead).not.toHaveBeenCalled();
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(actorAValue);
    }

    actorBMountStarted = true;
    mountHarness();
    await screen.findByText(/inv-actor-b-only.*user-actor-b-only.*ws-actor-b-only/i);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(2);
    expect(actorBReadStartedAfterMount).toBe(true);
    expect(queryClient.getQueryCache().find({ exact: true, queryKey: unrelatedKey })).toBe(
      unrelatedQuery
    );
    expect(unrelatedQuery?.state).toBe(unrelatedState);
    expect(unrelatedQuery?.getObserversCount()).toBe(1);
    expect(unrelatedRead).not.toHaveBeenCalled();
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(actorAValue);
    }
  });

  it.each(
    (['signIn', 'signUp', 'signOut'] as const).flatMap((operation) =>
      (['success', 'error'] as const).map(
        (decisionOutcome) => [operation, decisionOutcome] as const
      )
    )
  )('%s removes only the settled My-invitation %s mutation before admission refetch', async (operation, decisionOutcome) => {
    const actorAInvitation = {
      ...PENDING_INVITATION,
      invitationId: 'inv-actor-a-decision',
      inviteeUserId: 'user-actor-a-decision',
      workspaceId: 'ws-actor-a-decision',
    };
    const actorASettled = {
      ...actorAInvitation,
      acceptedAt: MEMBER_UPDATED_AT,
      effectiveStatus: 'accepted' as const,
      revision: 22,
    };
    const actorBInvitation = {
      ...PENDING_INVITATION,
      invitationId: 'inv-actor-b-decision',
      inviteeUserId: 'user-actor-b-decision',
      workspaceId: 'ws-actor-b-decision',
    };
    const actorAValues = [
      actorAInvitation.invitationId,
      actorAInvitation.inviteeUserId,
      actorAInvitation.workspaceId,
    ];
    const guards = guardSensitiveSinks(actorAValues);
    const transitionAdmission = deferred<typeof PRODUCT_WORKSPACES>();
    let actorBMountStarted = false;
    let actorBReadStartedAfterMount = false;
    let queriesAtAdmissionStart: string | undefined;
    let mutationsAtAdmissionStart: unknown[] | undefined;
    const listMyWorkspaceInvitations = vi
      .fn()
      .mockResolvedValueOnce({ items: [actorAInvitation] })
      .mockImplementationOnce(() => {
        actorBReadStartedAfterMount = actorBMountStarted;
        return Promise.resolve({ items: [actorBInvitation] });
      });
    const decisionFailure = new ApiCallError(409, 'Invitation changed.', {
      code: 'revision_conflict',
      details: { current: { ...actorAInvitation, revision: 23 }, resource: 'invitation' },
    });
    const acceptWorkspaceInvitation =
      decisionOutcome === 'success'
        ? vi.fn().mockResolvedValue({ invitation: actorASettled })
        : vi.fn().mockRejectedValue(decisionFailure);
    const { client, listAuthorizedWorkspaces } = makeSharingClient({
      methods: { acceptWorkspaceInvitation, listMyWorkspaceInvitations },
    });
    let queryClient!: QueryClient;
    listAuthorizedWorkspaces.mockReset().mockResolvedValueOnce(PRODUCT_WORKSPACES);
    listAuthorizedWorkspaces.mockImplementationOnce(() => {
      queriesAtAdmissionStart = inspectRetained(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => ({ key: query.queryKey, state: query.state }))
      );
      mutationsAtAdmissionStart = queryClient.getMutationCache().getAll();
      return transitionAdmission.promise;
    });
    listAuthorizedWorkspaces.mockResolvedValue(PRODUCT_WORKSPACES);
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const unrelatedKey = ['account', 's22-q-unrelated-mutation'] as const;
    const unrelatedValue = { retained: true };
    const unrelatedMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => unrelatedValue,
      mutationKey: unrelatedKey,
    });
    await unrelatedMutation.execute(undefined);
    const mountHarness = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={client}>
            <AccountDecisionCacheTransitionHarness operation={operation} />
          </CoreClientProvider>
        </QueryClientProvider>
      );
    const actorAView = mountHarness();
    await screen.findByText(/inv-actor-a-decision.*user-actor-a-decision.*ws-actor-a-decision/i);
    await userEvent.click(screen.getByRole('button', { name: 'settle invitation decision' }));
    await waitFor(() => expect(acceptWorkspaceInvitation).toHaveBeenCalledTimes(1));
    const decisionMutation = await waitFor(() => {
      const mutations = queryClient
        .getMutationCache()
        .getAll()
        .filter((candidate) => candidate !== unrelatedMutation);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.state.status).toBe(decisionOutcome);
      return mutations[0];
    });
    const decisionKey = decisionMutation?.options.mutationKey;
    expect(inspectRetained(decisionMutation?.state.variables)).toContain(
      actorAInvitation.invitationId
    );
    if (decisionOutcome === 'success') {
      for (const actorAValue of actorAValues) {
        expect(inspectRetained(decisionMutation?.state.data)).toContain(actorAValue);
      }
      expect(decisionMutation?.state.error).toBeNull();
    } else {
      expect(decisionMutation?.state.data).toBeUndefined();
      expect(decisionMutation?.state.error).toMatchObject({
        code: 'revision_conflict',
        current: {
          invitationId: actorAInvitation.invitationId,
          inviteeUserId: actorAInvitation.inviteeUserId,
          workspaceId: actorAInvitation.workspaceId,
        },
        resource: 'invitation',
      });
      for (const actorAValue of actorAValues) {
        expect(inspectRetained(decisionMutation?.state.error)).toContain(actorAValue);
      }
    }
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).toContain(actorAValue);
    }
    await userEvent.click(screen.getByRole('button', { name: operation }));
    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2));
    expect(mutationsAtAdmissionStart).not.toContain(decisionMutation);
    expect(mutationsAtAdmissionStart).toContain(unrelatedMutation);
    expect(decisionKey).toEqual(expect.any(Array));
    expect(decisionKey).not.toHaveLength(0);
    expect(decisionKey).not.toEqual(unrelatedKey);
    expect(unrelatedMutation.state).toMatchObject({ data: unrelatedValue, status: 'success' });
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    for (const actorAValue of actorAValues) {
      expect(queriesAtAdmissionStart).not.toContain(actorAValue);
    }
    transitionAdmission.resolve(PRODUCT_WORKSPACES);
    actorAView.unmount();
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(actorAValue);
    }

    actorBMountStarted = true;
    mountHarness();
    await screen.findByText(/inv-actor-b-decision.*user-actor-b-decision.*ws-actor-b-decision/i);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(2);
    expect(actorBReadStartedAfterMount).toBe(true);
    expect(queryClient.getMutationCache().getAll()).toContain(unrelatedMutation);
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(actorAValue);
    }
  });

  it.each(
    (['signIn', 'signUp', 'signOut'] as const).flatMap((operation) =>
      (['success', 'error'] as const).map(
        (decisionOutcome) => [operation, decisionOutcome] as const
      )
    )
  )('%s detaches a pending My-invitation mutation through late %s settlement', async (operation, decisionOutcome) => {
    const actorAInvitation = {
      ...PENDING_INVITATION,
      invitationId: 'inv-actor-a-pending',
      inviteeUserId: 'user-actor-a-pending',
      workspaceId: 'ws-actor-a-pending',
    };
    const actorASettled = {
      ...actorAInvitation,
      acceptedAt: MEMBER_UPDATED_AT,
      effectiveStatus: 'accepted' as const,
      revision: 22,
    };
    const actorBInvitation = {
      ...PENDING_INVITATION,
      invitationId: 'inv-actor-b-pending',
      inviteeUserId: 'user-actor-b-pending',
      workspaceId: 'ws-actor-b-pending',
    };
    const actorAValues = [
      actorAInvitation.invitationId,
      actorAInvitation.inviteeUserId,
      actorAInvitation.workspaceId,
    ];
    const guards = guardSensitiveSinks(actorAValues);
    const decisionSettlement = deferred<{ invitation: typeof actorASettled }>();
    const transitionAdmission = deferred<typeof PRODUCT_WORKSPACES>();
    const unrelatedPendingQuerySettlement = deferred<{ retained: 'pending-query' }>();
    const unrelatedPendingMutationSettlement = deferred<{ retained: 'pending-mutation' }>();
    let actorBMountStarted = false;
    let actorBReadStartedAfterMount = false;
    let decisionKey: readonly unknown[] | undefined;
    let invitationsKey: readonly unknown[] | undefined;
    let featureMutationsAtAdmissionStart: unknown[] | undefined;
    let invitationsQueryAtAdmissionStart: unknown;
    let unrelatedQueriesAtAdmissionStart:
      | { pending: unknown; pendingState: unknown; settled: unknown; settledState: unknown }
      | undefined;
    let unrelatedMutationsAtAdmissionStart:
      | { pending: unknown[]; pendingState: unknown; settled: unknown[]; settledState: unknown }
      | undefined;
    const listMyWorkspaceInvitations = vi
      .fn()
      .mockResolvedValueOnce({ items: [actorAInvitation] })
      .mockImplementationOnce(() => {
        actorBReadStartedAfterMount = actorBMountStarted;
        return Promise.resolve({ items: [actorBInvitation] });
      });
    const decisionFailure = new ApiCallError(409, 'Invitation changed.', {
      code: 'revision_conflict',
      details: { current: { ...actorAInvitation, revision: 23 }, resource: 'invitation' },
    });
    const acceptWorkspaceInvitation = vi.fn().mockReturnValue(decisionSettlement.promise);
    const { client, listAuthorizedWorkspaces } = makeSharingClient({
      methods: { acceptWorkspaceInvitation, listMyWorkspaceInvitations },
    });
    const unrelatedPendingQueryKey = ['account', 's22-q-p-unrelated-pending-query'] as const;
    const unrelatedSettledQueryKey = ['account', 's22-q-p-unrelated-settled-query'] as const;
    const unrelatedPendingMutationKey = ['account', 's22-q-p-unrelated-pending-mutation'] as const;
    const unrelatedSettledMutationKey = ['account', 's22-q-p-unrelated-settled-mutation'] as const;
    let queryClient!: QueryClient;
    listAuthorizedWorkspaces.mockReset().mockResolvedValueOnce(PRODUCT_WORKSPACES);
    listAuthorizedWorkspaces.mockImplementationOnce(() => {
      featureMutationsAtAdmissionStart = decisionKey
        ? queryClient.getMutationCache().findAll({ exact: true, mutationKey: decisionKey })
        : undefined;
      invitationsQueryAtAdmissionStart = invitationsKey
        ? queryClient.getQueryCache().find({ exact: true, queryKey: invitationsKey })
        : undefined;
      const pendingQuery = queryClient
        .getQueryCache()
        .find({ exact: true, queryKey: unrelatedPendingQueryKey });
      const settledQuery = queryClient
        .getQueryCache()
        .find({ exact: true, queryKey: unrelatedSettledQueryKey });
      const pendingMutations = queryClient
        .getMutationCache()
        .findAll({ exact: true, mutationKey: unrelatedPendingMutationKey });
      const settledMutations = queryClient
        .getMutationCache()
        .findAll({ exact: true, mutationKey: unrelatedSettledMutationKey });
      unrelatedQueriesAtAdmissionStart = {
        pending: pendingQuery,
        pendingState: pendingQuery?.state,
        settled: settledQuery,
        settledState: settledQuery?.state,
      };
      unrelatedMutationsAtAdmissionStart = {
        pending: pendingMutations,
        pendingState: pendingMutations[0]?.state,
        settled: settledMutations,
        settledState: settledMutations[0]?.state,
      };
      return transitionAdmission.promise;
    });
    listAuthorizedWorkspaces.mockResolvedValue(PRODUCT_WORKSPACES);
    const signIn = client.auth.email.signIn as ReturnType<typeof vi.fn>;
    const signOut = client.auth.email.signOut as ReturnType<typeof vi.fn>;
    const signUp = client.auth.email.signUp as ReturnType<typeof vi.fn>;
    signIn.mockResolvedValue({ redirect: false, token: RESPONSE_TOKEN, user: AUTH_USER });
    signOut.mockResolvedValue({ success: true });
    signUp.mockResolvedValue({ token: RESPONSE_TOKEN, user: AUTH_USER });
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const unrelatedPendingQueryRead = vi.fn(() => unrelatedPendingQuerySettlement.promise);
    void queryClient.fetchQuery({
      queryFn: unrelatedPendingQueryRead,
      queryKey: unrelatedPendingQueryKey,
    });
    queryClient.setQueryData(unrelatedSettledQueryKey, { retained: 'settled-query' });
    const unrelatedPendingQuery = queryClient.getQueryCache().find({
      exact: true,
      queryKey: unrelatedPendingQueryKey,
    });
    const unrelatedSettledQuery = queryClient.getQueryCache().find({
      exact: true,
      queryKey: unrelatedSettledQueryKey,
    });
    expect(unrelatedPendingQuery).toBeDefined();
    expect(unrelatedSettledQuery).toBeDefined();
    const unrelatedPendingMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => unrelatedPendingMutationSettlement.promise,
      mutationKey: unrelatedPendingMutationKey,
    });
    const unrelatedPendingMutationPromise = unrelatedPendingMutation.execute(undefined);
    const unrelatedSettledMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => ({ retained: 'settled-mutation' }),
      mutationKey: unrelatedSettledMutationKey,
    });
    await unrelatedSettledMutation.execute(undefined);
    const unrelatedPendingQueryState = unrelatedPendingQuery?.state;
    const unrelatedSettledQueryState = unrelatedSettledQuery?.state;
    const unrelatedPendingMutationState = unrelatedPendingMutation.state;
    const unrelatedSettledMutationState = unrelatedSettledMutation.state;
    const mountHarness = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={client}>
            <AccountDecisionCacheTransitionHarness operation={operation} />
          </CoreClientProvider>
        </QueryClientProvider>
      );
    const actorAView = mountHarness();
    await screen.findByText(/inv-actor-a-pending.*user-actor-a-pending.*ws-actor-a-pending/i);
    const invitationsQuery = queryClient
      .getQueryCache()
      .getAll()
      .find((query) => inspectRetained(query.state.data).includes(actorAInvitation.invitationId));
    invitationsKey = invitationsQuery?.queryKey;
    expect(invitationsKey).toEqual(expect.any(Array));
    expect(invitationsKey).not.toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'settle invitation decision' }));
    await waitFor(() => expect(acceptWorkspaceInvitation).toHaveBeenCalledTimes(1));
    const decisionMutation = queryClient
      .getMutationCache()
      .getAll()
      .find((mutation) =>
        inspectRetained(mutation.state.variables).includes(actorAInvitation.invitationId)
      );
    expect(decisionMutation?.state.status).toBe('pending');
    decisionKey = decisionMutation?.options.mutationKey;
    expect(decisionKey).toEqual(expect.any(Array));
    expect(decisionKey).not.toHaveLength(0);
    const featureMutationsBeforeAuth = queryClient
      .getMutationCache()
      .findAll({ exact: true, mutationKey: decisionKey });
    expect(featureMutationsBeforeAuth).toHaveLength(1);
    expect(featureMutationsBeforeAuth[0]).toBe(decisionMutation);
    expect(inspectRetained(decisionMutation?.state.variables)).toContain(
      actorAInvitation.invitationId
    );

    await userEvent.click(screen.getByRole('button', { name: operation }));
    await waitFor(() => expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(2));
    expect(featureMutationsAtAdmissionStart).toHaveLength(0);
    expect(invitationsQueryAtAdmissionStart).toBeUndefined();
    expect(unrelatedQueriesAtAdmissionStart?.pending).toBe(unrelatedPendingQuery);
    expect(unrelatedQueriesAtAdmissionStart?.pendingState).toBe(unrelatedPendingQueryState);
    expect(unrelatedQueriesAtAdmissionStart?.settled).toBe(unrelatedSettledQuery);
    expect(unrelatedQueriesAtAdmissionStart?.settledState).toBe(unrelatedSettledQueryState);
    expect(unrelatedMutationsAtAdmissionStart?.pending).toHaveLength(1);
    expect(unrelatedMutationsAtAdmissionStart?.pending[0]).toBe(unrelatedPendingMutation);
    expect(unrelatedMutationsAtAdmissionStart?.pendingState).toBe(unrelatedPendingMutationState);
    expect(unrelatedMutationsAtAdmissionStart?.settled).toHaveLength(1);
    expect(unrelatedMutationsAtAdmissionStart?.settled[0]).toBe(unrelatedSettledMutation);
    expect(unrelatedMutationsAtAdmissionStart?.settledState).toBe(unrelatedSettledMutationState);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    expect(unrelatedPendingQueryRead).toHaveBeenCalledTimes(1);

    if (decisionOutcome === 'success') {
      decisionSettlement.resolve({ invitation: actorASettled });
    } else {
      decisionSettlement.reject(decisionFailure);
    }
    await waitFor(() => expect(decisionMutation?.state.status).toBe(decisionOutcome));
    if (decisionOutcome === 'success') {
      expect(decisionMutation?.state.data).toEqual({ invitation: actorASettled });
    } else {
      expect(decisionMutation?.state.error).toMatchObject({
        code: 'revision_conflict',
        current: {
          invitationId: actorAInvitation.invitationId,
          inviteeUserId: actorAInvitation.inviteeUserId,
          workspaceId: actorAInvitation.workspaceId,
        },
        resource: 'invitation',
      });
    }
    expect(queryClient.getMutationCache().getAll()).not.toContain(decisionMutation);
    for (const actorAValue of actorAValues) {
      expect(
        inspectRetained(
          queryClient
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data)
        )
      ).not.toContain(actorAValue);
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(actorAValue);
    }

    transitionAdmission.resolve(PRODUCT_WORKSPACES);
    actorAView.unmount();
    actorBMountStarted = true;
    mountHarness();
    await screen.findByText(/inv-actor-b-pending.*user-actor-b-pending.*ws-actor-b-pending/i);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(2);
    expect(actorBReadStartedAfterMount).toBe(true);
    expect(queryClient.getMutationCache().getAll()).not.toContain(decisionMutation);
    for (const actorAValue of actorAValues) {
      expect(retainedAccountSurfaces(queryClient, guards)).not.toContain(actorAValue);
    }
    unrelatedPendingQuerySettlement.resolve({ retained: 'pending-query' });
    unrelatedPendingMutationSettlement.resolve({ retained: 'pending-mutation' });
    await unrelatedPendingMutationPromise;
  });
});

describe('selected-Workspace owner management', () => {
  it('reads only the selected owner Workspace and renders effective roles and invitation lifecycle without email', async () => {
    const memberRead = deferred<typeof WORKSPACE_MEMBERS>();
    const invitationRead = deferred<typeof WORKSPACE_INVITATIONS>();
    const listWorkspaceMembers = vi.fn().mockReturnValue(memberRead.promise);
    const listWorkspaceInvitations = vi.fn().mockReturnValue(invitationRead.promise);
    const { client, forbidden, methods } = makeSharingClient({
      coreWorkspaces: [
        { id: 'ws1', name: 'Authorized Workspace' },
        { id: 'ws2', name: 'Other Authorized Workspace' },
      ],
      methods: { listWorkspaceInvitations, listWorkspaceMembers },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { container } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    expect(screen.getByRole('status', { name: /workspace members/i })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /workspace invitations/i })).toBeInTheDocument();
    expect(listWorkspaceMembers.mock.calls).toEqual([['ws1']]);
    expect(listWorkspaceInvitations.mock.calls).toEqual([['ws1']]);
    memberRead.resolve(WORKSPACE_MEMBERS);
    invitationRead.resolve(WORKSPACE_INVITATIONS);

    await waitFor(() => {
      expect(
        within(screen.getByRole('region', { name: 'Workspace members' })).getByRole('row', {
          name: /user-owner.*owner/i,
        })
      ).toBeInTheDocument();
      expect(
        within(screen.getByRole('region', { name: 'Workspace invitations' })).getByRole('row', {
          name: /user-invitee-pending.*pending/i,
        })
      ).toBeInTheDocument();
    });
    const members = screen.getByRole('region', { name: 'Workspace members' });
    const invitations = screen.getByRole('region', { name: 'Workspace invitations' });
    expect(within(members).getByRole('row', { name: /user-owner.*owner/i })).toBeInTheDocument();
    expect(within(members).getByRole('row', { name: /user-editor.*editor/i })).toBeInTheDocument();
    expect(within(members).getByRole('row', { name: /user-viewer.*viewer/i })).toBeInTheDocument();
    expect(
      within(members).getByRole('row', { name: /user-removed.*removed/i })
    ).toBeInTheDocument();
    for (const invitation of WORKSPACE_INVITATIONS.items) {
      expect(
        within(invitations).getByRole('row', {
          name: new RegExp(`${invitation.inviteeUserId}.*${invitation.effectiveStatus}`, 'i'),
        })
      ).toBeInTheDocument();
    }
    expect(within(members).getByRole('row', { name: /user-owner.*owner/i })).not.toHaveTextContent(
      /remove|leave/i
    );
    const user = userEvent.setup();
    await expectNoRowAction(
      user,
      within(members).getByRole('row', { name: /user-owner.*owner/i }),
      /change access|remove member|transfer ownership/i
    );
    await expectNoRowAction(
      user,
      within(members).getByRole('row', { name: /user-removed.*removed/i }),
      /change access|remove member|transfer ownership/i
    );
    expect(
      await revealRowAction(
        user,
        within(members).getByRole('row', { name: /user-editor.*editor/i }),
        /transfer ownership/i
      )
    ).toBeEnabled();
    await user.keyboard('{Escape}');
    expect(
      await revealRowAction(
        user,
        within(members).getByRole('row', { name: /user-viewer.*viewer/i }),
        /transfer ownership/i
      )
    ).toBeEnabled();
    await user.keyboard('{Escape}');
    const pending = within(invitations).getByRole('row', {
      name: /user-invitee-pending.*pending/i,
    });
    expect(await revealRowAction(user, pending, /revoke invitation/i)).toBeEnabled();
    await user.keyboard('{Escape}');
    for (const invitation of [
      EXPIRED_INVITATION,
      ACCEPTED_INVITATION,
      DECLINED_INVITATION,
      REVOKED_INVITATION,
    ]) {
      await expectNoRowAction(
        user,
        within(invitations).getByRole('row', {
          name: new RegExp(`${invitation.inviteeUserId}.*${invitation.effectiveStatus}`, 'i'),
        }),
        /revoke invitation/i
      );
    }
    expect(listWorkspaceMembers.mock.calls).toEqual([['ws1']]);
    expect(listWorkspaceInvitations.mock.calls).toEqual([['ws1']]);
    expect(document.body.textContent).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    expect(methods.leaveWorkspace).not.toHaveBeenCalled();
    expectNoDeploymentAdmissionProbes(forbidden);
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    ).toHaveNoViolations();
  });

  it.each([
    {
      empty: /no invitations/i,
      failedMethod: 'listWorkspaceInvitations',
      failedRegion: 'Workspace invitations',
      recoveredRow: null,
      retryResponse: { items: [] },
      stableMethod: 'listWorkspaceMembers',
      stableRegion: 'Workspace members',
      stableResponse: { items: [OWNER_MEMBER] },
      stableRow: /user-owner.*owner/i,
    },
    {
      empty: null,
      failedMethod: 'listWorkspaceMembers',
      failedRegion: 'Workspace members',
      recoveredRow: /user-owner.*owner/i,
      retryResponse: { items: [OWNER_MEMBER] },
      stableMethod: 'listWorkspaceInvitations',
      stableRegion: 'Workspace invitations',
      stableResponse: WORKSPACE_INVITATIONS,
      stableRow: /user-invitee-pending.*pending/i,
    },
  ] as const)('retries only failed owner read $failedMethod and preserves the other collection', async ({
    empty,
    failedMethod,
    failedRegion,
    recoveredRow,
    retryResponse,
    stableMethod,
    stableRegion,
    stableResponse,
    stableRow,
  }) => {
    const failure = new ApiCallError(503, `${failedRegion} unavailable.`, {
      code: 'core.unavailable',
    });
    const failedRead = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(retryResponse);
    const stableRead = vi.fn().mockResolvedValue(stableResponse);
    const { client } = makeSharingClient({
      methods: { [failedMethod]: failedRead, [stableMethod]: stableRead },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const stableCollection = screen.getByRole('region', { name: stableRegion });
    const stableRecord = await within(stableCollection).findByRole('row', { name: stableRow });
    const failedCollection = screen.getByRole('region', { name: failedRegion });
    const alert = await within(failedCollection).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t|failed|unavailable/i);
    const stableReads = stableRead.mock.calls.length;
    expect(failedRead).toHaveBeenCalledTimes(1);
    await userEvent.click(within(alert).getByRole('button', { name: /try again|retry/i }));

    await waitFor(() => expect(failedRead).toHaveBeenCalledTimes(2));
    if (empty) {
      expect(await within(failedCollection).findByText(empty)).toBeInTheDocument();
    } else {
      expect(
        await within(failedCollection).findByRole('row', { name: recoveredRow })
      ).toBeInTheDocument();
    }
    expect(stableRead).toHaveBeenCalledTimes(stableReads);
    expect(stableRecord).toBeInTheDocument();
  });

  it.each([
    [
      'editor',
      { items: [{ ...OWNER_WORKSPACES.items[0], effectiveRole: 'editor' }] },
      ['ws1'],
      /current.*role.*editor|editor.*current.*role/i,
    ],
    [
      'viewer',
      { items: [{ ...OWNER_WORKSPACES.items[0], effectiveRole: 'viewer' }] },
      ['ws1'],
      /current.*role.*viewer|viewer.*current.*role/i,
    ],
    ['no selected Workspace', { items: [] }, [], /No Workspace selected/],
  ] as const)('does not expose owner authority or issue owner reads for %s', async (_case, authorizedWorkspaces, workspaceIds, evidence) => {
    const coreWorkspaces = workspaceIds.map((id) => ({ id, name: 'Authorized Workspace' }));
    const { client, methods } = makeSharingClient({ authorizedWorkspaces, coreWorkspaces });
    useWorkspaceStore.setState({ currentWorkspaceId: workspaceIds[0] ?? null });
    renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    expect(screen.getByRole('button', { name: /sign out/i })).toBeEnabled();
    expect(screen.getByText(evidence)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workspace members' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /invite|remove member|transfer ownership|revoke/i })
    ).not.toBeInTheDocument();
    expect(methods.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(methods.listWorkspaceInvitations).not.toHaveBeenCalled();
    expect(methods.createWorkspaceInvitation).not.toHaveBeenCalled();
    expect(methods.changeWorkspaceMemberAccess).not.toHaveBeenCalled();
    expect(methods.removeWorkspaceMember).not.toHaveBeenCalled();
    expect(methods.revokeWorkspaceInvitation).not.toHaveBeenCalled();
    expect(methods.transferWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it.each([
    'editor',
    'viewer',
  ] as const)('keeps an invite email transient while creating a %s invitation and invents no directory or delivery flow', async (accessLevel) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const failure = new ApiCallError(422, 'Invitation failed.', {
      code: 'invitee_unavailable',
    });
    expect(parseWorkspaceSharingError(failure)?.code).toBe('invitee_unavailable');
    const invite = deferred<never>();
    const createWorkspaceInvitation = vi.fn().mockReturnValue(invite.promise);
    const { client, methods } = makeSharingClient({ methods: { createWorkspaceInvitation } });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'Workspace invitations' });
    const user = userEvent.setup();
    const email = (await within(invitations).findByRole('textbox', {
      name: /invitee email/i,
    })) as HTMLInputElement;
    const access =
      within(invitations)
        .queryAllByRole('button', { name: /access level/i })
        .find((button) => button.getAttribute('aria-haspopup') === 'listbox') ??
      within(invitations).getByRole('combobox', { name: /access level/i });
    const submit = within(invitations).getByRole('button', { name: /create invitation|invite/i });
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    await tabTo(user, email);
    await user.keyboard(EMAIL);
    await user.click(access);
    const listbox = await screen.findByRole('listbox');
    await user.click(
      within(listbox).getByRole('option', { name: new RegExp(`^${accessLevel}$`, 'i') })
    );
    await tabTo(user, submit);
    await user.keyboard('{Enter}');

    expect(createWorkspaceInvitation).toHaveBeenCalledWith('ws1', {
      inviteeEmail: EMAIL,
      proposedAccessLevel: accessLevel,
    });
    expect(submit).toBeDisabled();
    expect(within(invitations).getByRole('status')).toHaveTextContent(/creating|inviting/i);
    expect(
      within(invitations).queryByRole('button', { name: /send email|email link|directory/i })
    ).not.toBeInTheDocument();

    invite.reject(failure);
    await waitFor(() => expect(email).toHaveValue(''));
    expect(within(invitations).getByRole('alert')).toHaveTextContent(/couldn.t|failed/i);
    expect(createWorkspaceInvitation).toHaveBeenCalledTimes(1);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards, email);
  });

  it('changes only a non-owner access level with the current row revision and disables duplicate submission', async () => {
    const mutation = deferred<unknown>();
    const changeWorkspaceMemberAccess = vi.fn().mockReturnValue(mutation.promise);
    const settledMember = {
      ...EDITOR_MEMBER,
      accessLevel: 'viewer' as const,
      effectiveRole: 'viewer' as const,
      revision: 12,
    };
    const listWorkspaceMembers = vi
      .fn()
      .mockResolvedValueOnce(WORKSPACE_MEMBERS)
      .mockResolvedValue({
        items: [OWNER_MEMBER, settledMember, VIEWER_MEMBER, REMOVED_MEMBER],
      });
    const { client, listAuthorizedWorkspaces, methods } = makeSharingClient({
      methods: { changeWorkspaceMemberAccess, listWorkspaceMembers },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const members = screen.getByRole('region', { name: 'Workspace members' });
    const editor = await within(members).findByRole('row', { name: /user-editor.*editor/i });
    const user = userEvent.setup();
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    const save = await chooseMemberAccess(user, editor, 'viewer');
    await user.click(save);

    expect(changeWorkspaceMemberAccess).toHaveBeenCalledWith('ws1', 'user-editor', {
      accessLevel: 'viewer',
      expectedRevision: 11,
    });
    await waitFor(() =>
      expect(!save.isConnected || (save as HTMLButtonElement).disabled).toBe(true)
    );
    expect(changeWorkspaceMemberAccess).toHaveBeenCalledTimes(1);
    const memberReads = methods.listWorkspaceMembers.mock.calls.length;
    const invitationReads = methods.listWorkspaceInvitations.mock.calls.length;
    const workspaceReads = listAuthorizedWorkspaces.mock.calls.length;
    mutation.resolve({ member: settledMember });
    expect(
      await within(members).findByRole('row', { name: /user-editor.*viewer/i })
    ).toBeInTheDocument();
    expect(methods.listWorkspaceMembers.mock.calls.length).toBeLessThanOrEqual(memberReads + 1);
    expect(methods.listWorkspaceInvitations).toHaveBeenCalledTimes(invitationReads);
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(workspaceReads);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
  });

  it.each([
    {
      action: /revoke invitation/i,
      applicableCollection: 'invitations',
      expected: ['ws1', 'inv-pending', { expectedRevision: 21 }],
      method: 'revokeWorkspaceInvitation',
      response: {
        invitation: {
          ...PENDING_INVITATION,
          effectiveStatus: 'revoked' as const,
          revision: 22,
          revokedAt: MEMBER_UPDATED_AT,
        },
      },
      row: /user-invitee-pending.*pending/i,
      settlementIdentity: /user-invitee-pending/i,
      settlementState: /revoked/i,
      statusName: /workspace invitation operation/i,
      statusState: /user-invitee-pending.*revoked|revoked.*user-invitee-pending/i,
    },
    {
      action: /remove member/i,
      applicableCollection: 'members',
      expected: ['ws1', 'user-editor', { expectedRevision: 11 }],
      method: 'removeWorkspaceMember',
      response: {
        member: {
          ...EDITOR_MEMBER,
          effectiveRole: null,
          removedAt: MEMBER_UPDATED_AT,
          status: 'removed',
        },
      },
      row: /user-editor.*editor/i,
      settlementIdentity: /user-editor/i,
      settlementState: /removed/i,
      statusName: /workspace member operation/i,
      statusState: /user-editor.*removed|removed.*user-editor/i,
    },
    {
      action: /transfer ownership/i,
      applicableCollection: 'members',
      expected: ['ws1', { expectedRegistryRevision: 9, targetUserId: 'user-editor' }],
      method: 'transferWorkspaceOwnership',
      response: {
        workspace: {
          ...OWNER_WORKSPACES.items[0],
          effectiveRole: 'editor' as const,
          ownerUserId: 'user-editor',
          registryRevision: 10,
        },
      },
      row: /user-editor.*editor/i,
      settlementIdentity: /user-editor/i,
      settlementState: /owner/i,
      statusName: /workspace ownership transfer/i,
      statusState: /ownership transferred.*user-editor|user-editor.*owner/i,
    },
    {
      action: /transfer ownership/i,
      applicableCollection: 'members',
      expected: ['ws1', { expectedRegistryRevision: 9, targetUserId: 'user-viewer' }],
      method: 'transferWorkspaceOwnership',
      response: {
        workspace: {
          ...OWNER_WORKSPACES.items[0],
          effectiveRole: 'editor' as const,
          ownerUserId: 'user-viewer',
          registryRevision: 10,
        },
      },
      row: /user-viewer.*viewer/i,
      settlementIdentity: /user-viewer/i,
      settlementState: /owner.*editor|editor.*owner/i,
      statusName: /workspace ownership transfer/i,
      statusState:
        /ownership transferred.*user-viewer.*editor|user-viewer.*owner.*editor|user-viewer.*editor.*owner/i,
    },
  ] as const)('requires confirmation and sends the exact $method revision command once', async ({
    action,
    applicableCollection,
    expected,
    method,
    response,
    row,
    settlementIdentity,
    settlementState,
    statusName,
    statusState,
  }) => {
    const pending = deferred<unknown>();
    const operation = vi.fn().mockReturnValue(pending.promise);
    const targetUserId = method === 'transferWorkspaceOwnership' ? expected[1].targetUserId : null;
    const settledMembers =
      method === 'removeWorkspaceMember'
        ? [OWNER_MEMBER, response.member, VIEWER_MEMBER, REMOVED_MEMBER]
        : method === 'transferWorkspaceOwnership'
          ? [
              { ...OWNER_MEMBER, effectiveRole: 'editor' as const },
              {
                ...EDITOR_MEMBER,
                effectiveRole: targetUserId === 'user-editor' ? ('owner' as const) : 'editor',
              },
              {
                ...VIEWER_MEMBER,
                accessLevel: targetUserId === 'user-viewer' ? ('editor' as const) : 'viewer',
                effectiveRole: targetUserId === 'user-viewer' ? ('owner' as const) : 'viewer',
              },
              REMOVED_MEMBER,
            ]
          : WORKSPACE_MEMBERS.items;
    const settledInvitations =
      method === 'revokeWorkspaceInvitation'
        ? [response.invitation, ...WORKSPACE_INVITATIONS.items.slice(1)]
        : WORKSPACE_INVITATIONS.items;
    const listWorkspaceMembers = vi
      .fn()
      .mockResolvedValueOnce(WORKSPACE_MEMBERS)
      .mockResolvedValue({ items: settledMembers });
    const listWorkspaceInvitations = vi
      .fn()
      .mockResolvedValueOnce(WORKSPACE_INVITATIONS)
      .mockResolvedValue({ items: settledInvitations });
    const { client, listAuthorizedWorkspaces, methods } = makeSharingClient({
      methods: {
        [method]: operation,
        listWorkspaceInvitations,
        listWorkspaceMembers,
      },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const region = screen.getByRole('region', {
      name: method === 'revokeWorkspaceInvitation' ? 'Workspace invitations' : 'Workspace members',
    });
    const target = await within(region).findByRole('row', { name: row });
    expect(target).not.toHaveTextContent(settlementState);
    expect(screen.queryByRole('status', { name: statusName })).not.toBeInTheDocument();
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    const user = userEvent.setup();
    await user.click(await revealRowAction(user, target, action));
    expect(operation).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: /confirm/i });
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(operation).not.toHaveBeenCalled();
    await user.click(await revealRowAction(user, target, action));
    const reopened = screen.getByRole('dialog', { name: /confirm/i });
    const confirm = within(reopened).getByRole('button', { name: /confirm/i });
    await user.click(confirm);

    await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect(operation).toHaveBeenCalledWith(...expected);
    await waitFor(() =>
      expect(!confirm.isConnected || (confirm as HTMLButtonElement).disabled).toBe(true)
    );
    expect(methods.leaveWorkspace).not.toHaveBeenCalled();
    const collection =
      applicableCollection === 'invitations'
        ? methods.listWorkspaceInvitations
        : methods.listWorkspaceMembers;
    const unrelatedCollection =
      applicableCollection === 'invitations'
        ? methods.listWorkspaceMembers
        : methods.listWorkspaceInvitations;
    const collectionReads = collection.mock.calls.length;
    const unrelatedReads = unrelatedCollection.mock.calls.length;
    const workspaceReads = listAuthorizedWorkspaces.mock.calls.length;
    pending.resolve(response);
    await expectScopedOperationSettlement({
      regionName:
        method === 'revokeWorkspaceInvitation' ? 'Workspace invitations' : 'Workspace members',
      rowIdentity: settlementIdentity,
      rowState: settlementState,
      statusName,
      statusState,
    });
    expect(collection.mock.calls.length).toBeLessThanOrEqual(collectionReads + 1);
    expect(unrelatedCollection).toHaveBeenCalledTimes(unrelatedReads);
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(workspaceReads);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
  });

  it('does not restore stale owner reads or controls after navigating away and back following ownership transfer', async () => {
    const guards = guardSensitiveSinks([EMAIL]);
    const transferWorkspaceOwnership = vi.fn().mockResolvedValue({
      workspace: {
        ...OWNER_WORKSPACES.items[0],
        effectiveRole: 'editor' as const,
        ownerUserId: 'user-editor',
        registryRevision: 10,
      },
    });
    const { client, listAuthorizedWorkspaces, methods } = makeSharingClient({
      methods: { transferWorkspaceOwnership },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const members = screen.getByRole('region', { name: 'Workspace members' });
    const editor = await within(members).findByRole('row', { name: /user-editor.*editor/i });
    const invitations = screen.getByRole('region', { name: 'Workspace invitations' });
    const email = (await within(invitations).findByRole('textbox', {
      name: /invitee email/i,
    })) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(email, EMAIL);
    const authorizedReads = listAuthorizedWorkspaces.mock.calls.length;
    const memberReads = methods.listWorkspaceMembers.mock.calls.length;
    const invitationReads = methods.listWorkspaceInvitations.mock.calls.length;
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    await user.click(await revealRowAction(user, editor, /transfer ownership/i));
    const dialog = screen.getByRole('dialog', { name: /confirm/i });
    await user.click(within(dialog).getByRole('button', { name: /confirm/i }));

    expect(transferWorkspaceOwnership).toHaveBeenCalledWith('ws1', {
      expectedRegistryRevision: 9,
      targetUserId: 'user-editor',
    });
    expect(
      await screen.findByText(/current.*role.*editor|editor.*current.*role/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workspace members' })).not.toBeInTheDocument();
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(authorizedReads);
    expect(methods.listWorkspaceMembers).toHaveBeenCalledTimes(memberReads);
    expect(methods.listWorkspaceInvitations).toHaveBeenCalledTimes(invitationReads);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards);

    const appearanceNavigation = screen.getByRole('button', { name: 'Appearance' });
    await user.click(appearanceNavigation);
    await waitFor(() => expect(appearanceNavigation).toHaveAttribute('aria-current', 'page'));
    await user.click(screen.getByRole('button', { name: 'Account' }));

    await screen.findByRole('heading', { name: 'Account' });
    expect(
      await screen.findByText(/current.*role.*editor|editor.*current.*role/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workspace members' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /invite|remove member|transfer ownership|revoke/i })
    ).not.toBeInTheDocument();
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(authorizedReads);
    expect(methods.listWorkspaceMembers).toHaveBeenCalledTimes(memberReads);
    expect(methods.listWorkspaceInvitations).toHaveBeenCalledTimes(invitationReads);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards);
  });

  it('settles create success from its authoritative response or one invitation reread without retaining email', async () => {
    const guards = guardSensitiveSinks([EMAIL]);
    const created = {
      ...PENDING_INVITATION,
      invitationId: 'inv-created',
      inviteeUserId: 'user-created',
    };
    const listWorkspaceInvitations = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [created] });
    const createWorkspaceInvitation = vi.fn().mockResolvedValue({ invitation: created });
    const { client, listAuthorizedWorkspaces, methods } = makeSharingClient({
      methods: { createWorkspaceInvitation, listWorkspaceInvitations },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'Workspace invitations' });
    expect(await within(invitations).findByText(/no invitations/i)).toBeInTheDocument();
    expect(
      within(invitations).queryByRole('row', { name: /user-created/i })
    ).not.toBeInTheDocument();
    const email = within(invitations).getByRole('textbox', {
      name: /invitee email/i,
    }) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(email, EMAIL);
    const invitationReads = listWorkspaceInvitations.mock.calls.length;
    const memberReads = methods.listWorkspaceMembers.mock.calls.length;
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    const workspaceReads = listAuthorizedWorkspaces.mock.calls.length;
    await user.click(
      within(invitations).getByRole('button', { name: /create invitation|invite/i })
    );

    expect(createWorkspaceInvitation).toHaveBeenCalledWith('ws1', {
      inviteeEmail: EMAIL,
      proposedAccessLevel: 'editor',
    });
    expect(await within(invitations).findByText('user-created')).toBeInTheDocument();
    expect(listWorkspaceInvitations.mock.calls.length).toBeLessThanOrEqual(invitationReads + 1);
    expect(methods.listWorkspaceMembers).toHaveBeenCalledTimes(memberReads);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(workspaceReads);
    await waitFor(() => expect(email).toHaveValue(''));
    expectNoRetainedInviteEmail(queryClient, guards, email);
  });

  it('lets an owner attempt an eligible command but preserves a typed server denial', async () => {
    const guards = guardSensitiveSinks([EMAIL]);
    const denial = new ApiCallError(403, 'Workspace access denied.', {
      code: 'workspace_access_denied',
    });
    expect(parseWorkspaceSharingError(denial)?.code).toBe('workspace_access_denied');
    const changeWorkspaceMemberAccess = vi.fn().mockRejectedValue(denial);
    const { client, methods } = makeSharingClient({ methods: { changeWorkspaceMemberAccess } });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const members = screen.getByRole('region', { name: 'Workspace members' });
    const editor = await within(members).findByRole('row', { name: /user-editor.*editor/i });
    const user = userEvent.setup();
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    await user.click(await chooseMemberAccess(user, editor, 'viewer'));

    expect(await within(members).findByRole('alert')).toHaveTextContent(/access denied/i);
    expect(changeWorkspaceMemberAccess).toHaveBeenCalledTimes(1);
    expect(changeWorkspaceMemberAccess).toHaveBeenCalledWith('ws1', 'user-editor', {
      accessLevel: 'viewer',
      expectedRevision: 11,
    });
    expect(within(editor).getByRole('status', { name: /editor/i })).toBeInTheDocument();
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards);
  });

  it.each([
    {
      action: /revoke invitation/i,
      code: 'invitation_not_pending',
      currentEvidence: 'revision:99',
      details: {
        current: {
          ...PENDING_INVITATION,
          effectiveStatus: 'revoked' as const,
          revision: 99,
          revokedAt: MEMBER_UPDATED_AT,
        },
      },
      currentIdentity: /user-invitee-pending/i,
      currentState: /revoked/i,
      expectedCall: ['ws1', 'inv-pending', { expectedRevision: 21 }],
      method: 'revokeWorkspaceInvitation',
      outcome: /not pending|revoked/i,
      precludedState: /revoked/i,
      region: 'Workspace invitations',
      row: /user-invitee-pending.*pending/i,
      statusState: /user-invitee-pending.*revoked|revoked.*user-invitee-pending/i,
    },
    {
      action: /revoke invitation/i,
      code: 'revision_conflict',
      details: {
        resource: 'invitation',
        current: { ...PENDING_INVITATION, revision: 99 },
      },
      currentEvidence: 'revision:99',
      currentIdentity: /user-invitee-pending/i,
      currentState: /pending/i,
      expectedCall: ['ws1', 'inv-pending', { expectedRevision: 21 }],
      method: 'revokeWorkspaceInvitation',
      outcome: /conflict|changed/i,
      precludedState: null,
      region: 'Workspace invitations',
      row: /user-invitee-pending.*pending/i,
      statusState: /user-invitee-pending.*pending|pending.*user-invitee-pending/i,
    },
    {
      action: /remove member/i,
      code: 'revision_conflict',
      currentEvidence: 'revision:98',
      currentIdentity: /user-editor/i,
      currentState: /editor/i,
      details: { resource: 'membership', current: { ...EDITOR_MEMBER, revision: 98 } },
      expectedCall: ['ws1', 'user-editor', { expectedRevision: 11 }],
      method: 'removeWorkspaceMember',
      outcome: /conflict|changed/i,
      precludedState: null,
      region: 'Workspace members',
      row: /user-editor.*editor/i,
      statusState: /user-editor.*editor|editor.*user-editor/i,
    },
    {
      action: /transfer ownership/i,
      code: 'revision_conflict',
      currentEvidence: 'registryRevision:97',
      currentIdentity: /user-editor/i,
      currentState: /owner/i,
      details: {
        resource: 'workspace',
        current: {
          ...OWNER_WORKSPACES.items[0],
          effectiveRole: 'editor' as const,
          ownerUserId: 'user-editor',
          registryRevision: 97,
        },
      },
      expectedCall: ['ws1', { expectedRegistryRevision: 9, targetUserId: 'user-editor' }],
      method: 'transferWorkspaceOwnership',
      outcome: /conflict|changed/i,
      precludedState: /owner/i,
      region: 'Workspace members',
      row: /user-editor.*editor/i,
      statusState: /user-editor.*owner|owner.*user-editor/i,
    },
  ] as const)('uses the safe current record for $code from $method instead of synthesizing success', async ({
    action,
    code,
    currentEvidence,
    currentIdentity,
    currentState,
    details,
    expectedCall,
    method,
    outcome,
    precludedState,
    region,
    row,
    statusState,
  }) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const failure = new ApiCallError(409, 'Workspace sharing conflict.', {
      code,
      details,
    });
    expect(parseWorkspaceSharingError(failure)?.code).toBe(code);
    const operation = vi.fn().mockRejectedValue(failure);
    const { client, methods } = makeSharingClient({ methods: { [method]: operation } });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const ownerRegion = screen.getByRole('region', { name: region });
    const target = await within(ownerRegion).findByRole('row', { name: row });
    if (precludedState) expect(target).not.toHaveTextContent(precludedState);
    expect(
      screen.queryByRole('status', { name: /workspace sharing conflict/i })
    ).not.toBeInTheDocument();
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    const user = userEvent.setup();
    await user.click(await revealRowAction(user, target, action));
    const dialog = screen.getByRole('dialog', { name: /confirm/i });
    await user.click(within(dialog).getByRole('button', { name: /confirm/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(outcome);
    await expectScopedOperationSettlement({
      regionName: region,
      rowIdentity: currentIdentity,
      rowState: currentState,
      statusName: /workspace sharing conflict/i,
      statusState,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(...expectedCall);
    expect(
      inspectRetained(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data)
      )
    ).toContain(currentEvidence);
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards);
  });

  it.each([
    ['workspace_access_denied', 403, /access denied/i],
    ['idempotency_key_conflict', 409, /request conflict/i],
    ['recovery_required', 500, /recovery required/i],
  ] as const)('keeps typed invite failure %s visible without automatic replay or email retention', async (code, status, label) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const failure = new ApiCallError(status, 'Workspace invitation failed.', {
      code,
    });
    if (code === 'workspace_access_denied') {
      expect(parseWorkspaceSharingError(failure)?.code).toBe(code);
    } else {
      expect(parseWorkspaceSharingError(failure)).toBeNull();
    }
    const createWorkspaceInvitation = vi.fn().mockRejectedValue(failure);
    const { client, methods } = makeSharingClient({ methods: { createWorkspaceInvitation } });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'Workspace invitations' });
    const email = (await within(invitations).findByRole('textbox', {
      name: /invitee email/i,
    })) as HTMLInputElement;
    const myInvitationReads = methods.listMyWorkspaceInvitations.mock.calls.length;
    await userEvent.type(email, EMAIL);
    await userEvent.click(
      within(invitations).getByRole('button', { name: /create invitation|invite/i })
    );
    const alert = await within(invitations).findByRole('alert');
    expect(alert).toHaveTextContent(label);
    expect(createWorkspaceInvitation).toHaveBeenCalledTimes(1);
    expect(createWorkspaceInvitation).toHaveBeenCalledWith('ws1', {
      inviteeEmail: EMAIL,
      proposedAccessLevel: 'editor',
    });
    await waitFor(() => expect(email).toHaveValue(''));
    expect(methods.listMyWorkspaceInvitations).toHaveBeenCalledTimes(myInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards, email);
  });
});

describe('account-level My invitations', () => {
  it('reads the account collection directly without selected Workspace membership and renders pending plus every terminal lifecycle safely', async () => {
    const guards = guardSensitiveSinks([EMAIL]);
    const myInvitationRead = deferred<typeof MY_INVITATIONS>();
    const listMyWorkspaceInvitations = vi.fn().mockReturnValue(myInvitationRead.promise);
    const { client, methods } = makeSharingClient({
      authorizedWorkspaces: { items: [] },
      coreWorkspaces: [],
      methods: { listMyWorkspaceInvitations },
    });
    const { container, queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'My invitations' });
    expect(within(invitations).getByRole('status')).toHaveTextContent(/loading/i);
    expect(listMyWorkspaceInvitations.mock.calls).toEqual([[]]);
    expect(methods.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(methods.listWorkspaceInvitations).not.toHaveBeenCalled();
    myInvitationRead.resolve(MY_INVITATIONS);

    const pending = await within(invitations).findByRole('row', {
      name: /ws1.*pending|pending.*ws1/i,
    });
    const otherPending = within(invitations).getByRole('row', {
      name: /ws2.*pending|pending.*ws2/i,
    });
    const user = userEvent.setup();
    expect(await revealRowAction(user, pending, /^accept/i)).toBeEnabled();
    await user.keyboard('{Escape}');
    expect(await revealRowAction(user, pending, /^decline/i)).toBeEnabled();
    await user.keyboard('{Escape}');
    expect(await revealRowAction(user, otherPending, /^accept/i)).toBeEnabled();
    await user.keyboard('{Escape}');
    for (const status of ['expired', 'accepted', 'declined', 'revoked'] as const) {
      const terminal = within(invitations).getByRole('row', {
        name: new RegExp(`ws1.*${status}|${status}.*ws1`, 'i'),
      });
      await expectNoRowAction(user, terminal, /accept|decline/i);
    }
    expect(listMyWorkspaceInvitations.mock.calls).toEqual([[]]);
    expect(methods.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(methods.listWorkspaceInvitations).not.toHaveBeenCalled();
    expectNoRetainedInviteEmail(queryClient, guards);
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    ).toHaveNoViolations();
  });

  it('keeps My invitations error, retry, and empty state independent from selected-Workspace owner reads', async () => {
    const guards = guardSensitiveSinks([EMAIL]);
    const failure = new ApiCallError(403, `My invitations unavailable for ${EMAIL}.`, {
      code: 'workspace_access_denied',
    });
    expect(parseWorkspaceSharingError(failure)?.code).toBe('workspace_access_denied');
    const listMyWorkspaceInvitations = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ items: [] });
    const { client, methods } = makeSharingClient({
      methods: { listMyWorkspaceInvitations },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    expect(
      await within(screen.getByRole('region', { name: 'Workspace members' })).findByRole('row', {
        name: /user-owner.*owner/i,
      })
    ).toBeInTheDocument();
    expect(
      await within(screen.getByRole('region', { name: 'Workspace invitations' })).findByRole(
        'row',
        {
          name: /user-invitee-pending.*pending/i,
        }
      )
    ).toBeInTheDocument();
    const invitations = screen.getByRole('region', { name: 'My invitations' });
    const alert = await within(invitations).findByRole('alert');
    expectNoRetainedInviteEmail(queryClient, guards);
    const memberReads = methods.listWorkspaceMembers.mock.calls.length;
    const ownerInvitationReads = methods.listWorkspaceInvitations.mock.calls.length;
    await userEvent.click(within(alert).getByRole('button', { name: /try again|retry/i }));

    expect(await within(invitations).findByText(/no invitations/i)).toBeInTheDocument();
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(2);
    expect(methods.listWorkspaceMembers).toHaveBeenCalledTimes(memberReads);
    expect(methods.listWorkspaceInvitations).toHaveBeenCalledTimes(ownerInvitationReads);
    expectNoRetainedInviteEmail(queryClient, guards);
  });

  it.each([
    [
      'acceptWorkspaceInvitation',
      /^accept/i,
      {
        ...PENDING_INVITATION,
        acceptedAt: MEMBER_UPDATED_AT,
        effectiveStatus: 'accepted' as const,
        revision: 22,
      },
      /accepted/i,
    ],
    [
      'declineWorkspaceInvitation',
      /^decline/i,
      {
        ...PENDING_INVITATION,
        declinedAt: MEMBER_UPDATED_AT,
        effectiveStatus: 'declined' as const,
        revision: 22,
      },
      /declined/i,
    ],
  ] as const)('sends the exact current revision through %s and replaces the row from authoritative success', async (method, action, settledInvitation, settledState) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const operation = deferred<{ invitation: typeof settledInvitation }>();
    const decision = vi.fn().mockReturnValue(operation.promise);
    const listMyWorkspaceInvitations = vi.fn().mockResolvedValue({
      items: [PENDING_INVITATION, OTHER_PENDING_INVITATION],
    });
    const { client } = makeSharingClient({
      authorizedWorkspaces: { items: [] },
      coreWorkspaces: [],
      methods: { [method]: decision, listMyWorkspaceInvitations },
    });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'My invitations' });
    const pending = await within(invitations).findByRole('row', {
      name: /ws1.*pending|pending.*ws1/i,
    });
    const user = userEvent.setup();
    await user.click(await revealRowAction(user, pending, action));
    const dialog = screen.queryByRole('dialog', { name: /confirm/i });
    if (dialog) {
      await user.click(within(dialog).getByRole('button', { name: /confirm/i }));
    }

    expect(decision.mock.calls).toEqual([['inv-pending', { expectedRevision: 21 }]]);
    const invitationReads = listMyWorkspaceInvitations.mock.calls.length;
    operation.resolve({ invitation: settledInvitation });
    expect(
      await within(invitations).findByRole('row', {
        name: new RegExp(`ws1.*${settledState.source}|${settledState.source}.*ws1`, 'i'),
      })
    ).toBeInTheDocument();
    const settledRows = within(invitations).getAllByRole('row');
    expect(settledRows).toHaveLength(2);
    expect(settledRows[0]).toHaveTextContent(
      new RegExp(`ws1.*${settledState.source}|${settledState.source}.*ws1`, 'i')
    );
    expect(settledRows[1]).toHaveTextContent(/ws2.*pending|pending.*ws2/i);
    expect(decision).toHaveBeenCalledTimes(1);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(invitationReads);
    expectNoRetainedInviteEmail(queryClient, guards);
  });

  it.each([
    [
      'invitation_not_pending',
      {
        ...PENDING_INVITATION,
        effectiveStatus: 'revoked' as const,
        revision: 91,
        revokedAt: MEMBER_UPDATED_AT,
      },
      { current: null as never },
      /not pending|revoked/i,
      /revoked/i,
    ],
    [
      'revision_conflict',
      { ...PENDING_INVITATION, revision: 92 },
      { resource: 'invitation' as const },
      /conflict|changed/i,
      /pending/i,
    ],
  ] as const)('replaces the exact My invitation from safe current %s without a collection scan', async (code, current, detailPrefix, outcome, currentState) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const details = code === 'invitation_not_pending' ? { current } : { ...detailPrefix, current };
    const failure = new ApiCallError(409, `Invitation conflict for ${EMAIL}.`, {
      code,
      details,
    });
    expect(parseWorkspaceSharingError(failure)?.code).toBe(code);
    const acceptWorkspaceInvitation = vi.fn().mockRejectedValue(failure);
    const listMyWorkspaceInvitations = vi.fn().mockResolvedValue({
      items: [PENDING_INVITATION, OTHER_PENDING_INVITATION],
    });
    const { client } = makeSharingClient({
      authorizedWorkspaces: { items: [] },
      coreWorkspaces: [],
      methods: { acceptWorkspaceInvitation, listMyWorkspaceInvitations },
    });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'My invitations' });
    const pending = await within(invitations).findByRole('row', {
      name: /ws1.*pending|pending.*ws1/i,
    });
    const user = userEvent.setup();
    await user.click(await revealRowAction(user, pending, /^accept/i));
    const dialog = screen.queryByRole('dialog', { name: /confirm/i });
    if (dialog) {
      await user.click(within(dialog).getByRole('button', { name: /confirm/i }));
    }

    expect(await within(invitations).findByRole('alert')).toHaveTextContent(outcome);
    expect(
      await within(invitations).findByRole('row', {
        name: new RegExp(`ws1.*${currentState.source}|${currentState.source}.*ws1`, 'i'),
      })
    ).toBeInTheDocument();
    const currentRows = within(invitations).getAllByRole('row');
    expect(currentRows).toHaveLength(2);
    expect(currentRows[0]).toHaveTextContent(
      new RegExp(`ws1.*${currentState.source}|${currentState.source}.*ws1`, 'i')
    );
    expect(currentRows[1]).toHaveTextContent(/ws2.*pending|pending.*ws2/i);
    expect(acceptWorkspaceInvitation.mock.calls).toEqual([
      ['inv-pending', { expectedRevision: 21 }],
    ]);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(1);
    expect(
      inspectRetained(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data)
      )
    ).toContain(`revision:${current.revision}`);
    if (code === 'invitation_not_pending') {
      const terminal = within(invitations).getByRole('row', {
        name: /ws1.*revoked|revoked.*ws1/i,
      });
      await expectNoRowAction(user, terminal, /accept|decline/i);
    }
    expectNoRetainedInviteEmail(queryClient, guards);
  });

  it.each([
    ['workspace_access_denied', 403, /access denied/i, false],
    ['idempotency_key_conflict', 409, /request conflict/i, false],
    ['recovery_required', 500, /recovery required/i, true],
  ] as const)('rereads My invitations before exposing an explicit new-request retry for %s', async (code, status, outcome, rereadFails) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const current = { ...PENDING_INVITATION, revision: 29 };
    const accepted = {
      ...current,
      acceptedAt: MEMBER_UPDATED_AT,
      effectiveStatus: 'accepted' as const,
      revision: 30,
    };
    const reread = deferred<{ items: (typeof current | typeof OTHER_PENDING_INVITATION)[] }>();
    const listMyWorkspaceInvitations = vi
      .fn()
      .mockResolvedValueOnce({ items: [PENDING_INVITATION, OTHER_PENDING_INVITATION] })
      .mockReturnValueOnce(reread.promise);
    if (rereadFails) {
      listMyWorkspaceInvitations.mockResolvedValueOnce({
        items: [current, OTHER_PENDING_INVITATION],
      });
    }
    const failure = new ApiCallError(status, `Invitation failed for ${EMAIL}.`, { code });
    const acceptWorkspaceInvitation = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ invitation: accepted });
    const { client } = makeSharingClient({
      authorizedWorkspaces: { items: [] },
      coreWorkspaces: [],
      methods: { acceptWorkspaceInvitation, listMyWorkspaceInvitations },
    });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const invitations = screen.getByRole('region', { name: 'My invitations' });
    const pending = await within(invitations).findByRole('row', {
      name: /ws1.*pending|pending.*ws1/i,
    });
    const user = userEvent.setup();
    await user.click(await revealRowAction(user, pending, /^accept/i));
    const dialog = screen.queryByRole('dialog', { name: /confirm/i });
    if (dialog) {
      await user.click(within(dialog).getByRole('button', { name: /confirm/i }));
    }

    expect(await within(invitations).findByRole('alert')).toHaveTextContent(outcome);
    await waitFor(() => expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(2));
    expect(acceptWorkspaceInvitation.mock.calls).toEqual([
      ['inv-pending', { expectedRevision: 21 }],
    ]);
    const prematureRetry = within(invitations).queryByRole('button', {
      name: /try again|retry/i,
    });
    expect(prematureRetry === null || (prematureRetry as HTMLButtonElement).disabled).toBe(true);
    expectNoRetainedInviteEmail(queryClient, guards);

    if (rereadFails) {
      reread.reject(
        new ApiCallError(503, `My invitations reread failed for ${EMAIL}.`, {
          code: 'core.unavailable',
        })
      );
      const collectionFailure = (
        await within(invitations).findByText("Couldn't load My invitations.")
      ).closest('[role="alert"]');
      expect(collectionFailure).not.toBeNull();
      const collectionRetry = within(collectionFailure as HTMLElement).getByRole('button', {
        name: /try again|retry/i,
      });
      const decisionFailure = (await within(invitations).findByText(outcome)).closest(
        '[role="alert"]'
      );
      expect(decisionFailure).not.toBeNull();
      const decisionRetry = within(decisionFailure as HTMLElement).queryByRole('button', {
        name: /try again|retry/i,
      });
      expect(acceptWorkspaceInvitation).toHaveBeenCalledTimes(1);
      expect(decisionRetry === null || (decisionRetry as HTMLButtonElement).disabled).toBe(true);
      expectNoRetainedInviteEmail(queryClient, guards);

      await user.click(collectionRetry);
      await waitFor(() => expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(3));
      const refreshed = within(invitations).getByRole('row', {
        name: /ws1.*pending|pending.*ws1/i,
      });
      await user.click(await revealRowAction(user, refreshed, /^accept/i));
      const refreshedDialog = screen.queryByRole('dialog', { name: /confirm/i });
      if (refreshedDialog) {
        await user.click(within(refreshedDialog).getByRole('button', { name: /confirm/i }));
      }
    } else {
      reread.resolve({ items: [current, OTHER_PENDING_INVITATION] });
      const retry = await within(invitations).findByRole('button', { name: /try again|retry/i });
      await user.click(retry);
    }

    await waitFor(() => expect(acceptWorkspaceInvitation).toHaveBeenCalledTimes(2));
    expect(acceptWorkspaceInvitation.mock.calls[1]).toEqual([
      'inv-pending',
      { expectedRevision: 29 },
    ]);
    expect(
      await within(invitations).findByRole('row', {
        name: /ws1.*accepted|accepted.*ws1/i,
      })
    ).toBeInTheDocument();
    const settledRows = within(invitations).getAllByRole('row');
    expect(settledRows).toHaveLength(2);
    expect(settledRows[0]).toHaveTextContent(/ws1.*accepted|accepted.*ws1/i);
    expect(settledRows[1]).toHaveTextContent(/ws2.*pending|pending.*ws2/i);
    expect(listMyWorkspaceInvitations).toHaveBeenCalledTimes(rereadFails ? 3 : 2);
    expectNoRetainedInviteEmail(queryClient, guards);
  });
});

describe('selected-membership self-leave', () => {
  it('confirms one exact active non-owner leave and removes only its authoritative Workspace row', async () => {
    const leave = deferred<{ member: typeof SELF_REMOVED_MEMBER }>();
    const leaveWorkspace = vi.fn().mockReturnValue(leave.promise);
    const { client, listAuthorizedWorkspaces, methods } = makeSharingClient({
      authorizedWorkspaces: NON_OWNER_WORKSPACES,
      coreWorkspaces: [
        { id: 'ws1', name: 'Authorized Workspace' },
        { id: 'ws2', name: 'Other Authorized Workspace' },
      ],
      methods: { leaveWorkspace },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    expect(screen.getByText(/current.*role.*editor|editor.*current.*role/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workspace members' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /invite|remove member|transfer ownership|revoke/i })
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /leave workspace/i }));
    expect(leaveWorkspace).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: /confirm.*leave|leave.*confirm/i });
    const confirm = within(dialog).getByRole('button', { name: /confirm|leave/i });
    await user.click(confirm);

    expect(leaveWorkspace.mock.calls).toEqual([['ws1', { expectedRevision: 17 }]]);
    expect(confirm).toBeDisabled();
    const authorizedReads = listAuthorizedWorkspaces.mock.calls.length;
    leave.resolve({ member: SELF_REMOVED_MEMBER });

    await waitFor(() => expectAuthorizedWorkspaceIds(queryClient, ['ws2']));
    expect(listAuthorizedWorkspaces).toHaveBeenCalledTimes(authorizedReads);
    expect(methods.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(methods.listWorkspaceInvitations).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Workspace members' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /invite|remove member|transfer ownership|revoke/i })
    ).not.toBeInTheDocument();
  });

  it('settles a removed safe-current membership conflict without replaying leave', async () => {
    const failure = new ApiCallError(409, 'Membership changed.', {
      code: 'revision_conflict',
      details: { current: SELF_REMOVED_MEMBER, resource: 'membership' },
    });
    expect(parseWorkspaceSharingError(failure)?.code).toBe('revision_conflict');
    const leaveWorkspace = vi.fn().mockRejectedValue(failure);
    const { client, methods } = makeSharingClient({
      authorizedWorkspaces: NON_OWNER_WORKSPACES,
      coreWorkspaces: [
        { id: 'ws1', name: 'Authorized Workspace' },
        { id: 'ws2', name: 'Other Authorized Workspace' },
      ],
      methods: { leaveWorkspace },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /leave workspace/i }));
    const dialog = screen.getByRole('dialog', { name: /confirm.*leave|leave.*confirm/i });
    await user.click(within(dialog).getByRole('button', { name: /confirm|leave/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/conflict|changed/i);
    expect(leaveWorkspace.mock.calls).toEqual([['ws1', { expectedRevision: 17 }]]);
    await waitFor(() => expectAuthorizedWorkspaceIds(queryClient, ['ws2']));
    expect(methods.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(methods.listWorkspaceInvitations).not.toHaveBeenCalled();
  });

  it.each([
    ['workspace_access_denied', 403, /access denied/i],
    ['owner_transfer_required', 409, /transfer.*ownership|ownership.*transfer/i],
    ['idempotency_key_conflict', 409, /request conflict/i],
    ['recovery_required', 500, /recovery required/i],
  ] as const)('keeps self-leave failure %s truthful without a scan or automatic replay', async (code, status, outcome) => {
    const guards = guardSensitiveSinks([EMAIL]);
    const failure = new ApiCallError(status, `Leave failed for ${EMAIL}.`, { code });
    const leaveWorkspace = vi.fn().mockRejectedValue(failure);
    const { client, methods } = makeSharingClient({
      authorizedWorkspaces: NON_OWNER_WORKSPACES,
      coreWorkspaces: [
        { id: 'ws1', name: 'Authorized Workspace' },
        { id: 'ws2', name: 'Other Authorized Workspace' },
      ],
      methods: { leaveWorkspace },
    });
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    const { queryClient } = renderApp('/settings/account', client);

    await screen.findByRole('heading', { name: 'Account' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /leave workspace/i }));
    const dialog = screen.getByRole('dialog', { name: /confirm.*leave|leave.*confirm/i });
    await user.click(within(dialog).getByRole('button', { name: /confirm|leave/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(outcome);
    expect(leaveWorkspace.mock.calls).toEqual([['ws1', { expectedRevision: 17 }]]);
    await Promise.resolve();
    expect(leaveWorkspace).toHaveBeenCalledTimes(1);
    expect(methods.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(methods.listWorkspaceInvitations).not.toHaveBeenCalled();
    expectAuthorizedWorkspaceIds(queryClient, ['ws1', 'ws2']);
    expectNoRetainedInviteEmail(queryClient, guards);
  });
});
