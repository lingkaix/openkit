import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { type ThemeName, useThemeStore } from '../../app/theme-store';
import { Button, Card, ErrorBanner, Page, PageHeader, Select, TextField } from '../../primitives';
import { InvitationsPanel } from './InvitationsPanel';
import { MembersScreen } from './MembersScreen';
import {
  type AccountMutationRequest,
  accountAdmissionKey,
  BOOTSTRAP_ADMIN_TOKEN_DURATION_LABEL,
  BootstrapSessionPresentError,
  consumeBootstrapOwner,
  isServerBootstrapRequired,
  isUnauthenticated,
  useAccountAdmission,
  useAccountMutation,
} from './session';

/** Full-viewport account-state frame shown before the product shell is admitted. */
function AccountFrame({ children }: { children: ReactNode }) {
  return (
    <main
      aria-label="Account access"
      className="flex min-h-dvh items-center justify-center bg-canvas px-6 py-8 text-fg"
    >
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

/** Stable account-admission progress shown only before any admission result exists. */
function AccountChecking() {
  return (
    <AccountFrame>
      <div className="text-center" role="status" aria-live="polite">
        <p className="text-sm font-bold text-fg-strong">Checking account access…</p>
      </div>
    </AccountFrame>
  );
}

/** Retryable protected-read failure that never guesses an authentication state. */
function AccountReadFailure({ retry }: { retry: () => void }) {
  return (
    <AccountFrame>
      <ErrorBanner message="Couldn't check account access." onRetry={retry} />
    </AccountFrame>
  );
}

/**
 * Global protected-read boundary for every route.
 *
 * @param children Product routes rendered only after the protected read succeeds.
 */
export function AccountBoundary({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const admission = useAccountAdmission();

  if (admission.isPending) return <AccountChecking />;
  if (admission.isError && isUnauthenticated(admission.error)) return <SignInScreen />;
  if (admission.isError) {
    return (
      <AccountReadFailure
        retry={() => {
          void queryClient.resetQueries({ queryKey: accountAdmissionKey, exact: true });
        }}
      />
    );
  }
  return children;
}

/** Email/password account gate backed only by existing Core Client auth operations. */
export function SignInScreen() {
  const client = useCoreClient();
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [adminToken, setAdminToken] = useState('');
  const [consumePending, setConsumePending] = useState(false);
  const [consumeClosed, setConsumeClosed] = useState(false);
  const [consumeFailure, setConsumeFailure] = useState<'recovery' | 'session' | null>(null);
  const mutation = useAccountMutation();
  const signingUp = mode === 'signUp';
  const showingToken = adminToken.length > 0;
  const formBusy = mutation.isPending || consumePending;

  /** Submits live form values as one immediate request and clears password after failure. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (showingToken) return;
    if (signingUp && bootstrapRequired) {
      if (consumeClosed) return;
      void consumeOwner();
      return;
    }
    const request: AccountMutationRequest = {
      operation: mode,
      email,
      name,
      password,
    };
    mutation.mutate(request, {
      onError: (error, variables) => {
        setPassword('');
        if (variables.operation === 'signUp' && isServerBootstrapRequired(error)) {
          setBootstrapRequired(true);
        }
      },
    });
  }

  /** Sends the bootstrap secret once. A non-201 closes that secret for this screen. */
  async function consumeOwner() {
    if (consumeClosed || showingToken || consumePending) return;
    const input = { displayName: name, email, password, token: bootstrapToken };
    setBootstrapToken('');
    setPassword('');
    setConsumePending(true);
    setConsumeFailure(null);
    try {
      const issued = await consumeBootstrapOwner(client, input);
      mutation.reset();
      setAdminToken(issued);
    } catch (error) {
      setConsumeClosed(true);
      setConsumeFailure(error instanceof BootstrapSessionPresentError ? 'session' : 'recovery');
    } finally {
      input.token = '';
      input.password = '';
      input.email = '';
      input.displayName = '';
      setConsumePending(false);
    }
  }

  /** Signs in only after the administrator token is already on screen. */
  function signInWithOwner() {
    mutation.mutate(
      { operation: 'signIn', email, name: '', password },
      { onError: () => setPassword('') }
    );
  }

  /** Drops the one-time administrator token when the disclosure closes. */
  function closeAdminToken() {
    setAdminToken('');
    setPassword('');
    setBootstrapRequired(false);
    setMode('signIn');
    mutation.reset();
  }

  return (
    <AccountFrame>
      <Card className="flex flex-col gap-5">
        <header>
          <p className="text-eyebrow font-bold tracking-eyebrow text-fg-muted">OpenKit</p>
          <h1 className="mt-1 text-title font-extrabold text-fg-strong">Account access</h1>
          <p className="mt-1 text-sm text-fg-muted">Sign in or create an account to continue.</p>
        </header>
        {showingToken ? (
          <section aria-label="One-time administrator token" className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-bold text-fg-strong">Copy this token now</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Copy this administrator token before signing in. It is shown once and is not stored
                in this browser. It lasts {BOOTSTRAP_ADMIN_TOKEN_DURATION_LABEL}.
              </p>
            </div>
            <TextField
              label="Administrator token"
              type="text"
              value={adminToken}
              isReadOnly
              autoComplete="off"
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                onPress={() => {
                  void navigator.clipboard?.writeText(adminToken).catch(() => undefined);
                }}
              >
                Copy
              </Button>
            </div>
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              isDisabled={mutation.isPending}
              isRequired
              autoComplete="current-password"
            />
            {mutation.isPending ? (
              <p role="status" aria-live="polite" className="text-sm text-fg-muted">
                Signing in…
              </p>
            ) : null}
            {mutation.isError ? <ErrorBanner message="Couldn't sign in. Try again." /> : null}
            <div className="flex items-center justify-between gap-3 pt-1">
              <Button variant="quiet" isDisabled={mutation.isPending} onPress={closeAdminToken}>
                Close
              </Button>
              <Button
                isDisabled={mutation.isPending || password.length === 0}
                onPress={signInWithOwner}
              >
                Sign in
              </Button>
            </div>
          </section>
        ) : (
          <form aria-label="Account access" className="flex flex-col gap-3" onSubmit={submit}>
            {signingUp ? (
              <TextField
                label="Name"
                value={name}
                onChange={setName}
                isDisabled={formBusy}
                isRequired
              />
            ) : null}
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              isDisabled={formBusy}
              isRequired
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              isDisabled={formBusy}
              isRequired
            />
            {signingUp && bootstrapRequired ? (
              <>
                <p className="text-sm text-fg-muted">
                  This server still needs its one-time bootstrap token.
                </p>
                <TextField
                  label="Bootstrap token"
                  type="password"
                  value={bootstrapToken}
                  onChange={setBootstrapToken}
                  isDisabled={formBusy || consumeClosed}
                  isRequired
                  autoComplete="off"
                  description={`The administrator token lasts ${BOOTSTRAP_ADMIN_TOKEN_DURATION_LABEL}.`}
                />
              </>
            ) : null}
            {consumePending ? (
              <p role="status" aria-live="polite" className="text-sm text-fg-muted">
                Creating the owner…
              </p>
            ) : null}
            {mutation.isPending ? (
              <p role="status" aria-live="polite" className="text-sm text-fg-muted">
                {signingUp ? 'Signing up…' : 'Signing in…'}
              </p>
            ) : null}
            {consumeFailure === 'session' ? (
              <ErrorBanner message="A session is already present on this browser. Sign out, then return to finish bootstrap. The bootstrap token will not be sent again." />
            ) : null}
            {consumeFailure === 'recovery' ? (
              <ErrorBanner message="This attempt did not finish. The bootstrap token will not be sent again. If the owner was created, sign in. A lost administrator token is recovered on a stopped server and does not reopen bootstrap." />
            ) : null}
            {mutation.isError &&
            !isServerBootstrapRequired(mutation.error) &&
            consumeFailure === null ? (
              <ErrorBanner
                message={
                  signingUp ? "Couldn't sign up. Try again." : "Couldn't sign in. Try again."
                }
              />
            ) : null}
            <div className="flex items-center justify-between gap-3 pt-1">
              <Button
                type="button"
                variant="quiet"
                isDisabled={formBusy}
                onPress={() => {
                  setMode(signingUp ? 'signIn' : 'signUp');
                  setPassword('');
                  mutation.reset();
                }}
              >
                {signingUp ? 'Sign in' : 'Sign up'}
              </Button>
              <Button type="submit" isDisabled={formBusy || (signingUp && consumeClosed)}>
                {signingUp ? 'Sign up' : 'Sign in'}
              </Button>
            </div>
          </form>
        )}
        <Select
          label="Color theme"
          selectedKey={theme}
          onSelectionChange={(key) => setTheme(key as ThemeName)}
          items={[
            { id: 'spectrum', label: 'Spectrum' },
            { id: 'paper', label: 'Paper' },
            { id: 'noir', label: 'Noir' },
          ]}
        />
      </Card>
    </AccountFrame>
  );
}

/** Authenticated Settings account page with the existing sign-out operation. */
export function AccountScreen() {
  const mutation = useAccountMutation();
  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Account"
        subtitle="Manage access to this OpenKit account."
      />
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold text-fg-strong">Account access</p>
          <p className="mt-1 text-xs text-fg-muted">Sign out on this browser.</p>
        </div>
        <Button
          variant="outline"
          isDisabled={mutation.isPending}
          onPress={() =>
            mutation.mutate({
              operation: 'signOut',
              email: '',
              name: '',
              password: '',
            })
          }
        >
          Sign out
        </Button>
      </Card>
      {mutation.isPending ? (
        <p role="status" aria-live="polite" className="text-sm text-fg-muted">
          Signing out…
        </p>
      ) : null}
      {mutation.isError ? <ErrorBanner message="Couldn't sign out. Try again." /> : null}
      <InvitationsPanel />
      <MembersScreen />
    </Page>
  );
}
