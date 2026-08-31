import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Reads the protected authorized-Workspace collection that owns account admission. */
export function useAccountAdmission() {
  const client = useCoreClient();
  return useQuery({
    queryKey: accountAdmissionKey,
    queryFn: () => client.app.listAuthorizedWorkspaces(),
    retry: false,
    structuralSharing: false,
  });
}

/**
 * Runs one email-auth operation and starts a protected refetch after success.
 *
 * The request object is the TanStack mutation variable while the operation is in flight. Its credential fields are erased before settlement, and auth responses and credential-bearing server errors are deliberately not retained.
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
      useWorkspaceStore.getState().setCurrentWorkspaceId(null);
      void queryClient.refetchQueries({ queryKey: accountAdmissionKey, exact: true });
    },
  });
}
