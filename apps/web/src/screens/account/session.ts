import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';

/** The single TanStack owner for protected account admission reads. */
export const accountAdmissionKey = ['account', 'authorized-workspaces'] as const;

/** The user-scoped TanStack query removed at every successful account transition. */
export const myInvitationsKey = ['account', 'my-workspace-invitations'] as const;

/** The feature-scoped TanStack mutation removed at every successful account transition. */
export const myInvitationDecisionMutationKey = [
  'account',
  'my-workspace-invitation-decision',
] as const;

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
    queryFn: () => client.operations['workspace.list']({}),
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
 * The request object is the TanStack mutation variable while the operation is in flight. Its credential fields are erased before settlement, and auth responses and credential-bearing server errors are deliberately not retained. The following protected read starts from a reset admission query, so the previous product, gate, or failure does not stay mounted while that read is in flight.
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
      } catch {
        throw new Error('The account operation failed.');
      } finally {
        request.email = '';
        request.password = '';
        request.name = '';
      }
    },
    onSuccess: () => {
      const mutationCache = queryClient.getMutationCache();
      for (const mutation of mutationCache.findAll({
        exact: true,
        mutationKey: myInvitationDecisionMutationKey,
      })) {
        mutationCache.remove(mutation);
      }
      queryClient.removeQueries({ queryKey: myInvitationsKey, exact: true });
      queryClient.removeQueries({ queryKey: ['workspaces'], exact: true });
      queryClient.removeQueries({ queryKey: ['thread-dashboard'] });
      useWorkspaceStore.getState().setCurrentWorkspaceId(null);
      void queryClient.resetQueries({ queryKey: accountAdmissionKey, exact: true });
    },
  });
}
