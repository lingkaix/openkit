import { redactInternalAgentText } from './redaction.js';
import type { InternalAgentStreamEvent } from './types.js';

/**
 * Failure behavior for one internal-agent hook.
 */
export type InternalAgentHookMode = 'observational' | 'critical';

/**
 * Hook invoked for internal-agent stream events.
 */
export interface InternalAgentHook {
  /** Stable app-local hook id used in diagnostics. */
  readonly id: string;
  /** Failure behavior for this hook; defaults to observational isolation. */
  readonly mode?: InternalAgentHookMode;
  /**
   * Handles one internal-agent stream event.
   *
   * @param event Internal-agent stream event being dispatched.
   */
  readonly handleEvent: (event: InternalAgentStreamEvent) => void | Promise<void>;
}

/**
 * Redacted hook failure diagnostic safe for app-local diagnostics.
 */
export interface InternalAgentHookFailureDiagnostic {
  /** Stable hook id that failed. */
  readonly hookId: string;
  /** Event type being dispatched when the hook failed. */
  readonly eventType: InternalAgentStreamEvent['eventType'];
  /** Failure behavior configured for the hook. */
  readonly mode: InternalAgentHookMode;
  /** Redacted hook error message. */
  readonly message: string;
}

/**
 * Dispatcher for one composed internal-agent hook chain.
 */
export interface InternalAgentHookDispatcher {
  /**
   * Dispatches an internal-agent event to every configured hook.
   *
   * @param event Internal-agent stream event to dispatch.
   * @returns Redacted diagnostics for isolated observational hook failures.
   * @throws InternalAgentCriticalHookError when a critical hook fails.
   */
  dispatch(event: InternalAgentStreamEvent): Promise<InternalAgentHookFailureDiagnostic[]>;
}

/**
 * Error thrown when a critical internal-agent hook fails.
 */
export class InternalAgentCriticalHookError extends Error {
  /** Stable app-local error code. */
  public readonly code = 'internal_agent_critical_hook_failed';
  /** Redacted diagnostic for the failed critical hook. */
  public readonly diagnostic: InternalAgentHookFailureDiagnostic;

  /**
   * Creates one critical hook failure error.
   *
   * @param diagnostic Redacted critical hook failure diagnostic.
   */
  public constructor(diagnostic: InternalAgentHookFailureDiagnostic) {
    super(diagnostic.message);
    this.name = 'InternalAgentCriticalHookError';
    this.diagnostic = diagnostic;
  }
}

/**
 * Creates a dispatcher that composes internal-agent hooks in registration order.
 *
 * @param hooks Hooks to dispatch for each internal-agent stream event.
 * @returns Hook dispatcher with observational isolation and critical fail-fast semantics.
 */
export function createInternalAgentHookDispatcher(
  hooks: readonly InternalAgentHook[]
): InternalAgentHookDispatcher {
  return {
    dispatch: async (event) => {
      const diagnostics: InternalAgentHookFailureDiagnostic[] = [];

      for (const hook of hooks) {
        const mode = hook.mode ?? 'observational';

        try {
          await hook.handleEvent(event);
        } catch (error) {
          const diagnostic = createHookFailureDiagnostic(hook, mode, event, error);

          if (mode === 'critical') {
            throw new InternalAgentCriticalHookError(diagnostic);
          }

          diagnostics.push(diagnostic);
        }
      }

      return diagnostics;
    },
  };
}

/**
 * Creates a redacted hook failure diagnostic.
 *
 * @param hook Hook that failed while handling the event.
 * @param mode Effective hook failure mode.
 * @param event Event being dispatched when the hook failed.
 * @param error Unknown hook error value.
 * @returns Redacted hook failure diagnostic.
 */
function createHookFailureDiagnostic(
  hook: InternalAgentHook,
  mode: InternalAgentHookMode,
  event: InternalAgentStreamEvent,
  error: unknown
): InternalAgentHookFailureDiagnostic {
  return {
    hookId: hook.id,
    eventType: event.eventType,
    mode,
    message: redactInternalAgentText(error instanceof Error ? error.message : String(error)),
  };
}
