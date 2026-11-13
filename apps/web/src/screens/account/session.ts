import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';
import { toastQueue } from '../../primitives/Toast';
import { retainShellCacheOnLogout } from '../../pwa/shell-cache';
import { clearDashboardClockSamples } from '../chat/timeline/clock-offset';
import { resetToastPolicy } from '../chat/timeline/toast-policy';
import { useWorkspaceStore } from '../workspace-store';
import { advanceAccountGeneration } from './generation';

/** The single TanStack owner for protected account admission reads. */
export const accountAdmissionKey = ['account', 'authorized-workspaces'] as const;

/** User-owned channel queries and transient mutation results cleared at every account transition. */
export const accountChannelsKey = ['account', 'channels'] as const;

/** The user-scoped TanStack query removed at every successful account transition. */
export const myInvitationsKey = ['account', 'my-workspace-invitations'] as const;

/** The feature-scoped TanStack mutation removed at every successful account transition. */
export const myInvitationDecisionMutationKey = [
  'account',
  'my-workspace-invitation-decision',
] as const;

/** One administrator-token lifetime. The form offers this duration and no alternative. */
export const BOOTSTRAP_ADMIN_TOKEN_DURATION_MS = 90 * 24 * 60 * 60 * 1000;

/** Visible label for the single administrator-token duration. */
export const BOOTSTRAP_ADMIN_TOKEN_DURATION_LABEL = '90 days';

/** Today's sign-up refusal while the server still has no consumed bootstrap token. */
export const SERVER_BOOTSTRAP_INCOMPLETE_MESSAGE = 'Server bootstrap is incomplete.';

/**
 * Sign-up was refused because server bootstrap is still incomplete.
 *
 * The original transport error is not retained. This value carries no credential.
 */
export class ServerBootstrapRequiredError extends Error {
  constructor() {
    super(SERVER_BOOTSTRAP_INCOMPLETE_MESSAGE);
    this.name = 'ServerBootstrapRequiredError';
  }
}

/** Bootstrap was refused before the secret was checked because a session is already present. */
export class BootstrapSessionPresentError extends Error {
  constructor() {
    super('A session is already present.');
    this.name = 'BootstrapSessionPresentError';
  }
}

/** Bootstrap consumption did not return 201. The secret must not be sent again. */
export class BootstrapConsumeFailedError extends Error {
  constructor() {
    super('Bootstrap consumption did not complete.');
    this.name = 'BootstrapConsumeFailedError';
  }
}

/** True when sign-up failed with today's incomplete-bootstrap refusal. */
export function isServerBootstrapRequired(error: unknown): boolean {
  return error instanceof ServerBootstrapRequiredError;
}

/** True when the transport error is today's incomplete-bootstrap refusal. */
function isIncompleteBootstrapRefusal(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    error.status === 403 &&
    error.message === SERVER_BOOTSTRAP_INCOMPLETE_MESSAGE
  );
}

/** Erases every string field on a credential-bearing record. */
function scrubStrings(record: object): void {
  const fields = record as Record<string, string>;
  for (const key of Object.keys(fields)) fields[key] = '';
}

/**
 * Consumes the one-time bootstrap secret and returns the administrator token.
 *
 * The owner id is allocated here. The request, including the secret and password, is scrubbed
 * before this function settles. A presented session and every other non-201 failure throw a
 * secret-free error so the screen can explain the outcome without sending the secret again.
 *
 * @param client Core client that owns `bootstrap.consume`.
 * @param input Bootstrap secret and the owner identity. Mutated empty before settlement.
 * @returns The one-time administrator token from a 201 response.
 */
export async function consumeBootstrapOwner(
  client: CoreClient,
  input: { token: string; displayName: string; email: string; password: string }
): Promise<string> {
  const request = {
    displayName: input.displayName,
    email: input.email,
    ownerUserId: allocateEntityId('usr'),
    password: input.password,
    token: input.token,
    tokenExpiresAt: new Date(Date.now() + BOOTSTRAP_ADMIN_TOKEN_DURATION_MS).toISOString(),
  };
  try {
    const result = await client.operations['bootstrap.consume'](request);
    const issued = result.token;
    try {
      (result as { token: string }).token = '';
    } catch {
      // A frozen payload keeps its copy until this function returns the extracted string.
    }
    return issued;
  } catch (error) {
    if (isUnauthenticated(error)) throw new BootstrapSessionPresentError();
    throw new BootstrapConsumeFailedError();
  } finally {
    scrubStrings(request);
    scrubStrings(input);
  }
}

/** One transient email-auth request, scrubbed in place before its mutation settles. */
export interface AccountMutationRequest {
  operation: 'signIn' | 'signUp' | 'signOut';
  email: string;
  password: string;
  name: string;
}

/** True only for the exact typed response that opens the account gate. */
export function isUnauthenticated(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    error.status === 401 &&
    error.code === 'core.auth.unauthenticated'
  );
}

/**
 * Reads the protected authorized-Workspace collection that owns account admission.
 *
 * TanStack Query clears an error that has no data when the next fetch starts. The retained error keeps that settled failure mounted through a background refetch. Resetting the query clears its fetched state, so that error is not shown and sign-in, sign-up, sign-out, and explicit retry settle from the new protected read.
 *
 * @param options.enabled When false, observes the existing admission cache without fetching.
 */
export function useAccountAdmission(options?: { readonly enabled?: boolean }) {
  const client = useCoreClient();
  const admission = useQuery({
    queryKey: accountAdmissionKey,
    queryFn: async ({ signal }) => {
      const result = await client.operations['workspace.list']({});
      // Reading the signal lets an account transition cancel this fetch before a late response commits.
      signal.throwIfAborted();
      return result;
    },
    retry: false,
    structuralSharing: false,
    enabled: options?.enabled ?? true,
  });
  const retainedError = useRef<unknown>(null);
  if (admission.isSuccess) {
    retainedError.current = null;
  } else if (admission.error) {
    retainedError.current = admission.error;
  }
  if (admission.isPending && admission.isFetched && retainedError.current != null) {
    const error = retainedError.current;
    return {
      ...admission,
      error,
      isError: true as const,
      isInitialLoading: false as const,
      isLoading: false as const,
      isPending: false as const,
      isSuccess: false as const,
      status: 'error' as const,
    };
  }
  return admission;
}

/**
 * Runs one email-auth operation and replaces account admission after success.
 *
 * The request object is the TanStack mutation variable while the operation is in flight. Its credential fields are erased before settlement, and auth responses and credential-bearing server errors are deliberately not retained. Settings and Operations reads are disposed before admission resets so an earlier account's rows or pending response cannot satisfy the next account. The following protected read starts from a reset admission query, so the previous product, gate, or failure does not stay mounted while that read is in flight.
 */
export function useAccountMutation() {
  const client = useCoreClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: AccountMutationRequest) => {
      try {
        if (request.operation === 'signIn') {
          await client.auth.email.signIn({ email: request.email, password: request.password });
        } else if (request.operation === 'signUp') {
          await client.auth.email.signUp({
            email: request.email,
            name: request.name,
            password: request.password,
          });
        } else {
          await client.auth.email.signOut();
        }
      } catch (error) {
        if (request.operation === 'signUp' && isIncompleteBootstrapRefusal(error)) {
          throw new ServerBootstrapRequiredError();
        }
        throw new Error('The account operation failed.');
      } finally {
        request.email = '';
        request.password = '';
        request.name = '';
      }
    },
    onSuccess: (_data, variables) => {
      advanceAccountGeneration();
      clearDashboardClockSamples();
      toastQueue.clear();
      resetToastPolicy();
      queryClient.removeQueries({ queryKey: ['items'] });
      // Goal, attention, timeline, open Item windows, and the run-start clock
      // are account-owned reads. Cancel in-flight work first so a late response
      // cannot publish after removal. advanceAccountGeneration above qualifies
      // any response that is already in flight.
      void queryClient.cancelQueries({ queryKey: ['goal'] });
      queryClient.removeQueries({ queryKey: ['goal'] });
      void queryClient.cancelQueries({ queryKey: ['attention'] });
      queryClient.removeQueries({ queryKey: ['attention'] });
      void queryClient.cancelQueries({ queryKey: ['thread-timeline'] });
      queryClient.removeQueries({ queryKey: ['thread-timeline'] });
      void queryClient.cancelQueries({ queryKey: ['thread-timeline-items'] });
      queryClient.removeQueries({ queryKey: ['thread-timeline-items'] });
      void queryClient.cancelQueries({ queryKey: ['timeline-run-start'] });
      queryClient.removeQueries({ queryKey: ['timeline-run-start'] });
      if (variables.operation === 'signOut') void retainShellCacheOnLogout();
      const mutationCache = queryClient.getMutationCache();
      for (const mutation of mutationCache.findAll({ mutationKey: accountChannelsKey }))
        mutationCache.remove(mutation);
      queryClient.removeQueries({ queryKey: accountChannelsKey });
      for (const mutation of mutationCache.findAll({
        exact: true,
        mutationKey: myInvitationDecisionMutationKey,
      })) {
        mutationCache.remove(mutation);
      }
      queryClient.removeQueries({ queryKey: myInvitationsKey, exact: true });
      queryClient.removeQueries({ queryKey: ['workspaces'], exact: true });
      queryClient.removeQueries({ queryKey: ['workspaces', 'summaries'], exact: true });
      queryClient.removeQueries({ queryKey: ['account', 'session-user'], exact: true });
      queryClient.removeQueries({ queryKey: ['thread-dashboard'] });
      queryClient.removeQueries({ queryKey: ['settings'] });
      queryClient.removeQueries({ queryKey: ['operations'] });
      useWorkspaceStore.getState().setCurrentWorkspaceId(null);
      void queryClient.resetQueries({ queryKey: accountAdmissionKey, exact: true });
    },
  });
}
