import {
  type AuthEmailRequest,
  AuthEmailRequestSchema,
  type AuthGetSessionResponse,
  AuthGetSessionResultSchema,
  type AuthSignInEmailResponse,
  AuthSignInEmailResponseSchema,
  type AuthSignOutResponse,
  AuthSignOutResponseSchema,
  type AuthSignUpEmailRequest,
  AuthSignUpEmailRequestSchema,
  type AuthSignUpEmailResponse,
  AuthSignUpEmailResponseSchema,
} from '@openkit/app-api-schemas';
import type { ClientTransport } from './transport.js';

/** Email/password auth client. */
export interface EmailAuthClient {
  /** Creates a Better Auth email/password user and session. */
  signUp(input: AuthSignUpEmailRequest): Promise<AuthSignUpEmailResponse>;
  /** Creates a Better Auth email/password session. */
  signIn(input: AuthEmailRequest): Promise<AuthSignInEmailResponse>;
  /** Clears the active Better Auth session. */
  signOut(): Promise<AuthSignOutResponse>;
  /** Reads the active Better Auth session, or null when the browser has none. */
  getSession(): Promise<AuthGetSessionResponse | null>;
}

/** Creates the email/password auth client. */
export function createEmailAuthClient(transport: ClientTransport): EmailAuthClient {
  return {
    signUp: (input) =>
      transport.postJson(
        '/api/auth/sign-up/email',
        AuthSignUpEmailRequestSchema.parse(input),
        AuthSignUpEmailResponseSchema
      ),
    signIn: (input) =>
      transport.postJson(
        '/api/auth/sign-in/email',
        AuthEmailRequestSchema.parse(input),
        AuthSignInEmailResponseSchema
      ),
    signOut: () => transport.postJson('/api/auth/sign-out', {}, AuthSignOutResponseSchema),
    getSession: () => transport.getJson('/api/auth/get-session', AuthGetSessionResultSchema),
  };
}
