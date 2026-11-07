import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AccountBoundary } from './SignInScreen';

const EMAIL = 'owner@example.test';
const PASSWORD = 'account-password-exact';
const NAME = 'Account User';
const BOOTSTRAP_TOKEN = 'okt_boot';
const ADMIN_TOKEN = 'okt_admin';

const AUTH_REQUIRED = () =>
  new ApiCallError(401, 'Authentication required.', { code: 'core.auth.unauthenticated' });

function renderGate(client: CoreClient) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AccountBoundary>
          <main aria-label="Workspace">product shell</main>
        </AccountBoundary>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

function makeClient(overrides: {
  consume?: ReturnType<typeof vi.fn>;
  signIn?: ReturnType<typeof vi.fn>;
  signUp?: ReturnType<typeof vi.fn>;
}) {
  const consume = overrides.consume ?? vi.fn();
  const client = {
    auth: {
      email: {
        getSession: vi.fn(),
        signIn: overrides.signIn ?? vi.fn(),
        signOut: vi.fn(),
        signUp: overrides.signUp ?? vi.fn(),
      },
    },
    operations: {
      'bootstrap.consume': consume,
      'workspace.list': vi.fn().mockRejectedValue(AUTH_REQUIRED()),
    },
  } as unknown as CoreClient;
  return { client, consume };
}

async function revealBootstrapField(signUp: ReturnType<typeof vi.fn>) {
  const user = userEvent.setup();
  await screen.findByRole('form', { name: /account access/i });
  expect(screen.queryByLabelText('Bootstrap token')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Sign up' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), NAME);
  await user.type(screen.getByRole('textbox', { name: 'Email' }), EMAIL);
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign up' }));
  expect(await screen.findByLabelText('Bootstrap token')).toBeInTheDocument();
  expect(signUp).toHaveBeenCalledTimes(1);
  return user;
}

async function submitBootstrap(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Bootstrap token'), BOOTSTRAP_TOKEN);
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign up' }));
}

/** In-memory Cache Storage so the close assertion can read every stored body. */
function installMemoryCaches() {
  const stores = new Map<string, Map<string, string>>();
  const api = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      return {
        async put(request: RequestInfo | URL, response: Response) {
          const url = request instanceof Request ? request.url : String(request);
          store?.set(url, await response.clone().text());
        },
        async keys() {
          return [...(store?.keys() ?? [])].map((url) => new Request(url));
        },
        async match(request: RequestInfo | URL) {
          const url = request instanceof Request ? request.url : String(request);
          const body = store?.get(url);
          return body === undefined ? undefined : new Response(body);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
  };
  vi.stubGlobal('caches', api);
  return stores;
}

async function cacheText(): Promise<string> {
  if (typeof caches === 'undefined') return '';
  const names = await caches.keys();
  const parts: string[] = [];
  for (const name of names) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response) parts.push(await response.text());
    }
  }
  return parts.join('\n');
}

describe('server bootstrap sign-up', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('reveals the bootstrap token field only after the incomplete sign-up refusal', async () => {
    const signUp = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(403, 'Sign up is disabled.'))
      .mockRejectedValueOnce(
        new ApiCallError(403, 'Server bootstrap is incomplete.', { code: 'FORBIDDEN' })
      );
    const { client, consume } = makeClient({ signUp });
    renderGate(client);

    const user = userEvent.setup();
    await screen.findByRole('form', { name: /account access/i });
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), NAME);
    await user.type(screen.getByRole('textbox', { name: 'Email' }), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t sign up/i);
    expect(screen.queryByLabelText('Bootstrap token')).not.toBeInTheDocument();
    expect(consume).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByLabelText('Bootstrap token')).toBeInTheDocument();
    expect(screen.getByText(/90 days/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Owner user id')).not.toBeInTheDocument();
  });

  it('does not reveal bootstrap for disabled sign-up, then reveals it for the incomplete refusal', async () => {
    const signUp = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(400, 'Email and password sign up is not enabled', {
          code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
        })
      )
      .mockRejectedValueOnce(new ApiCallError(403, 'Server bootstrap is incomplete.'));
    const { client, consume } = makeClient({ signUp });
    renderGate(client);

    const user = userEvent.setup();
    await screen.findByRole('form', { name: /account access/i });
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), NAME);
    await user.type(screen.getByRole('textbox', { name: 'Email' }), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t sign up/i);
    expect(screen.queryByLabelText('Bootstrap token')).not.toBeInTheDocument();
    expect(consume).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByLabelText('Bootstrap token')).toBeInTheDocument();
    expect(consume).not.toHaveBeenCalled();
  });

  it('allows password sign-in after a lost consume response and does not consume again', async () => {
    const consume = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const signIn = vi.fn().mockResolvedValue({});
    const signUp = vi
      .fn()
      .mockRejectedValue(new ApiCallError(403, 'Server bootstrap is incomplete.'));
    const { client } = makeClient({ consume, signIn, signUp });
    renderGate(client);

    const user = await revealBootstrapField(signUp);
    await submitBootstrap(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'If the owner was created, sign in.'
    );
    expect(consume).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    fireEvent.submit(screen.getByRole('form', { name: /account access/i }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('shows the administrator token before sign-in, keeps it if sign-in fails, and drops secrets on close', async () => {
    const stores = installMemoryCaches();
    const seen: Record<string, string> = {};
    const consume = vi.fn(async (body: Record<string, string>) => {
      Object.assign(seen, body);
      return { record: {}, token: ADMIN_TOKEN };
    });
    const signIn = vi.fn().mockRejectedValue(new Error('sign-in failed'));
    const signUp = vi
      .fn()
      .mockRejectedValue(new ApiCallError(403, 'Server bootstrap is incomplete.'));
    const { client } = makeClient({ consume, signIn, signUp });
    renderGate(client);
    const user = await revealBootstrapField(signUp);
    await submitBootstrap(user);

    const sheet = await screen.findByRole('region', { name: 'One-time administrator token' });
    expect(within(sheet).getByLabelText('Administrator token')).toHaveValue(ADMIN_TOKEN);
    expect(within(sheet).getByRole('button', { name: 'Copy' })).toBeEnabled();
    expect(signIn).not.toHaveBeenCalled();
    expect(seen.token).toBe(BOOTSTRAP_TOKEN);
    expect(seen.password).toBe(PASSWORD);
    expect(seen.email).toBe(EMAIL);
    expect(seen.displayName).toBe(NAME);
    expect(seen.ownerUserId).toMatch(/^usr_[0-9a-f]{8}-/);
    expect(Date.parse(seen.tokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(seen).not.toHaveProperty('workspaceId');
    expect(consume).toHaveBeenCalledTimes(1);

    await user.click(within(sheet).getByRole('button', { name: 'Copy' }));
    expect(signIn).not.toHaveBeenCalled();
    await user.type(within(sheet).getByLabelText('Password'), PASSWORD);
    await user.click(within(sheet).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t sign in/i);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(within(sheet).getByLabelText('Administrator token')).toHaveValue(ADMIN_TOKEN);
    expect(consume).toHaveBeenCalledTimes(1);

    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByLabelText('Administrator token')).not.toBeInTheDocument();
    const retained = [
      JSON.stringify(Object.entries(localStorage)),
      JSON.stringify(Object.entries(sessionStorage)),
      await cacheText(),
      [...stores.values()].flatMap((store) => [...store.values()]).join('\n'),
      [...document.querySelectorAll('input')].map((input) => input.value).join('\n'),
    ].join('\n');
    for (const secret of [BOOTSTRAP_TOKEN, ADMIN_TOKEN, PASSWORD]) {
      expect(retained).not.toContain(secret);
    }
  });

  it('does not send the bootstrap secret again after a non-201', async () => {
    const consume = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const signUp = vi
      .fn()
      .mockRejectedValue(new ApiCallError(403, 'Server bootstrap is incomplete.'));
    const { client } = makeClient({ consume, signUp });
    renderGate(client);
    const user = await revealBootstrapField(signUp);
    await submitBootstrap(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/will not be sent again/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/stopped server/i);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sign up' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: /account access/i }));
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('tells the user to sign out when a session is already present', async () => {
    const consume = vi.fn().mockRejectedValue(AUTH_REQUIRED());
    const signUp = vi
      .fn()
      .mockRejectedValue(new ApiCallError(403, 'Server bootstrap is incomplete.'));
    const { client } = makeClient({ consume, signUp });
    renderGate(client);
    const user = await revealBootstrapField(signUp);
    await submitBootstrap(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/sign out/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/will not be sent again/i);
    expect(consume).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByRole('form', { name: /account access/i }));
    expect(consume).toHaveBeenCalledTimes(1);
  });
});
