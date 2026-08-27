import { type FormEvent, type ReactNode, useState } from 'react';
import { THEME_CLASS, useThemeStore } from '../../app/theme-store';
import { Button, Card, ErrorBanner, Page, PageHeader, TextField } from '../../primitives';
import { InvitationsPanel } from './InvitationsPanel';
import { MembersScreen } from './MembersScreen';
import {
  type AccountMutationRequest,
  isUnauthenticated,
  useAccountAdmission,
  useAccountMutation,
} from './session';

/** Full-viewport account-state frame shown before the product shell is admitted. */
function AccountFrame({ children }: { children: ReactNode }) {
  const theme = useThemeStore((state) => state.theme);
  return (
    <main
      aria-label="Account access"
      className={`${THEME_CLASS[theme]} flex min-h-[600px] min-w-[800px] items-center justify-center bg-canvas px-6 py-8 text-fg`}
    >
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

/** Stable account-admission progress shown while the protected read is pending. */
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
  const admission = useAccountAdmission();

  if (admission.isPending || admission.isFetching) return <AccountChecking />;
  if (admission.isError && isUnauthenticated(admission.error)) return <SignInScreen />;
  if (admission.isError) {
    return <AccountReadFailure retry={() => void admission.refetch()} />;
  }
  return children;
}

/** Email/password account gate backed only by existing Core Client auth operations. */
export function SignInScreen() {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useAccountMutation();
  const signingUp = mode === 'signUp';

  /** Submits live form values as one immediate request and clears password after failure. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request: AccountMutationRequest = {
      operation: mode,
      email,
      name,
      password,
    };
    mutation.mutate(request, { onError: () => setPassword('') });
  }

  return (
    <AccountFrame>
      <Card className="flex flex-col gap-5">
        <header>
          <p className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">OpenKit</p>
          <h1 className="mt-1 text-title font-extrabold text-fg-strong">Account access</h1>
          <p className="mt-1 text-sm text-fg-muted">Sign in or create an account to continue.</p>
        </header>
        <form aria-label="Account access" className="flex flex-col gap-3" onSubmit={submit}>
          {signingUp ? (
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              isDisabled={mutation.isPending}
              isRequired
            />
          ) : null}
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            isDisabled={mutation.isPending}
            isRequired
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            isDisabled={mutation.isPending}
            isRequired
          />
          {mutation.isPending ? (
            <p role="status" aria-live="polite" className="text-sm text-fg-muted">
              {signingUp ? 'Signing up…' : 'Signing in…'}
            </p>
          ) : null}
          {mutation.isError ? (
            <ErrorBanner
              message={signingUp ? "Couldn't sign up. Try again." : "Couldn't sign in. Try again."}
            />
          ) : null}
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              type="button"
              variant="quiet"
              isDisabled={mutation.isPending}
              onPress={() => {
                setMode(signingUp ? 'signIn' : 'signUp');
                setPassword('');
                mutation.reset();
              }}
            >
              {signingUp ? 'Sign in' : 'Sign up'}
            </Button>
            <Button type="submit" isDisabled={mutation.isPending}>
              {signingUp ? 'Sign up' : 'Sign in'}
            </Button>
          </div>
        </form>
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
      <Card className="flex items-center justify-between gap-4">
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
