import { isDeepStrictEqual } from 'node:util';

/**
 * Maximum UTF-8 bytes of the final assistant message content serialized as JSON. The bound covers
 * every part, including thinking and tool parts, so it also bounds the text the host returns.
 */
export const PI_RESULT_CONTENT_MAX_BYTES = 16 * 1024 * 1024;

/** Settled result of one prompt on the resident session. */
export type PiTurnOutcome =
  | { readonly status: 'completed'; readonly assistantText: string }
  | { readonly status: 'length' | 'failed' | 'interrupted'; readonly reason: string };

/** The admitted route a settled assistant message must name. */
export interface PiAdmittedRoute {
  /** Adapter-owned provider alias. */
  readonly provider: string;
  /** Exact admitted logical model id for this Turn. */
  readonly model: string;
}

/** Assistant-message subset needed for terminal correlation. */
interface PiAssistantMessage extends Record<string, unknown> {
  readonly content: unknown[];
  readonly model: string;
  readonly provider: string;
  readonly role: 'assistant';
  readonly stopReason: string;
}

/**
 * Correlates the session events of one prompt into one trustworthy outcome.
 *
 * A terminal assistant stop, length, or abort message must match its turn end, final non-retrying agent end, and `agent_settled`, with no terminal event after settlement. Length preserves exhaustion and an unrequested abort preserves a safe self-stop diagnostic, without a successful assistant candidate. Errors and terminal tool use cannot establish success; unknown events cannot satisfy correlation.
 */
export class PiTurnOutcomeTracker {
  #agentMatched = false;
  #candidate: PiAssistantMessage | null = null;
  #contradicted = false;
  #settled = false;
  #turnMatched = false;

  /**
   * Observes one session event in emission order.
   *
   * @param event Session event of the prompt being tracked.
   */
  public observe(event: { readonly type: string } & Record<string, unknown>): void {
    const type = event.type;
    if (
      this.#settled &&
      (type === 'message_end' ||
        type === 'turn_end' ||
        type === 'agent_end' ||
        type === 'agent_settled')
    ) {
      this.#contradicted = true;
      return;
    }
    if (type === 'message_end') {
      this.#candidate = readSettledAssistantMessage(event.message);
      this.#turnMatched = false;
      this.#agentMatched = false;
    } else if (type === 'turn_end') {
      this.#turnMatched = Boolean(
        this.#candidate && isDeepStrictEqual(event.message, this.#candidate)
      );
      this.#agentMatched = false;
    } else if (type === 'agent_end') {
      if (event.willRetry === true) {
        this.#candidate = null;
        this.#turnMatched = false;
        this.#agentMatched = false;
        return;
      }
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => isRecord(message) && message.role === 'assistant');
      this.#agentMatched = Boolean(
        this.#candidate &&
          this.#turnMatched &&
          event.willRetry === false &&
          isDeepStrictEqual(lastAssistant, this.#candidate)
      );
    } else if (type === 'agent_settled') {
      if (!this.#candidate || !this.#turnMatched || !this.#agentMatched) {
        this.#contradicted = true;
        return;
      }
      this.#settled = true;
    }
  }

  /**
   * Returns the outcome once the prompt call has returned.
   *
   * @param input Whether an interrupt was requested, whether the prompt call rejected, and the
   *   admitted route of this Turn.
   * @returns Interrupted when interrupted, otherwise length for proved exhaustion, completed with the final text, or failed when correlation, route, content structure, or the content bound does not hold.
   */
  public finish(input: {
    readonly interrupted: boolean;
    readonly promptFailed: boolean;
    readonly route: PiAdmittedRoute;
  }): PiTurnOutcome {
    if (input.interrupted) return { status: 'interrupted', reason: 'worker-interrupted' };
    if (input.promptFailed) return { status: 'failed', reason: 'pi-prompt-failed' };
    const candidate = this.#candidate;
    if (
      this.#contradicted ||
      !this.#settled ||
      !candidate ||
      !this.#turnMatched ||
      !this.#agentMatched
    ) {
      return { status: 'failed', reason: 'pi-terminal-correlation-failed' };
    }
    if (candidate.provider !== input.route.provider || candidate.model !== input.route.model) {
      return { status: 'failed', reason: 'pi-route-mismatch' };
    }
    let contentBytes: number;
    try {
      contentBytes = Buffer.byteLength(JSON.stringify(candidate.content), 'utf8');
    } catch {
      return { status: 'failed', reason: 'pi-output-malformed' };
    }
    if (contentBytes > PI_RESULT_CONTENT_MAX_BYTES) {
      return { status: 'failed', reason: 'pi-output-too-large' };
    }
    const texts: string[] = [];
    for (const part of candidate.content) {
      if (!isRecord(part) || typeof part.type !== 'string') {
        return { status: 'failed', reason: 'pi-output-malformed' };
      }
      if (part.type !== 'text') continue;
      if (typeof part.text !== 'string') return { status: 'failed', reason: 'pi-output-malformed' };
      texts.push(part.text);
    }
    if (candidate.stopReason === 'length') return { status: 'length', reason: 'pi-length' };
    if (candidate.stopReason === 'aborted') {
      return {
        status: 'failed',
        reason: 'Worker runtime stopped on its own without an OpenKit interrupt request.',
      };
    }
    const assistantText = texts.join('').trim();
    return assistantText
      ? { status: 'completed', assistantText }
      : { status: 'failed', reason: 'pi-final-message-empty' };
  }
}

/** Reads one settled assistant stop, length, or abort message for terminal correlation. */
function readSettledAssistantMessage(value: unknown): PiAssistantMessage | null {
  if (
    !isRecord(value) ||
    value.role !== 'assistant' ||
    (value.stopReason !== 'stop' &&
      value.stopReason !== 'length' &&
      value.stopReason !== 'aborted') ||
    !Array.isArray(value.content) ||
    typeof value.provider !== 'string' ||
    typeof value.model !== 'string'
  ) {
    return null;
  }
  return value as PiAssistantMessage;
}

/** Checks whether one value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
