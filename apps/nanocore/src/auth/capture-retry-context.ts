import { createHash } from 'node:crypto';
import type { Actor } from './identity.js';

/** Binds a refused request to its authenticated principal and session without granting authority. */
export function captureRetryContext(actor: Actor | undefined): string | undefined {
  if (
    !actor ||
    (actor.kind === 'session' && !actor.sessionId) ||
    (actor.kind === 'token' && !actor.tokenId)
  )
    return undefined;
  return createHash('sha256')
    .update(
      JSON.stringify([actor.kind, actor.userId, actor.sessionId ?? null, actor.tokenId ?? null])
    )
    .digest('hex');
}

/** Advertises only a definite authorized admission refusal with a stable authentication binding. */
export function captureRetryHeaders(actor: Actor | undefined): Record<string, string> {
  const context = captureRetryContext(actor);
  return context ? { 'Retry-After': '1', 'x-openkit-retry-context': context } : {};
}
