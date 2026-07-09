import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type NanoCoreHarness,
  readTurnEventsUntil,
  removeDataRoot,
  startNanoCoreHarness,
  startTurn,
} from './_lib/harness.js';

interface SmokePrerequisites {
  enabled: boolean;
  reason: string;
}

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

const prerequisites = readSmokePrerequisites();
const smokeIt = prerequisites.enabled ? it : it.skip;

describe('nanocore e2e real Codex smoke', () => {
  smokeIt(
    prerequisites.enabled
      ? 'drives one minimal turn through the real Codex agent'
      : `skips real Codex smoke: ${prerequisites.reason}`,
    async () => {
      harness = await startNanoCoreHarness({ useSimulator: false });

      const workspaceId = 'ws_demo';
      const threadId = 'th_demo';
      const turn = await startTurn(
        harness.baseUrl,
        workspaceId,
        threadId,
        'Reply with exactly OPENKIT_SMOKE_OK.'
      );
      const turnId = String(turn.id);
      const events = await readTurnEventsUntil(
        harness.baseUrl,
        workspaceId,
        threadId,
        turnId,
        (event) => event.event === 'turn.completed',
        120_000
      );

      expect(events.some((event) => event.event === 'turn.completed')).toBe(true);
      expect(events.some((event) => isAssistantMessageCompleted(event.data))).toBe(true);
    },
    130_000
  );
});

/**
 * Reads the opt-in prerequisites for the real Codex smoke test.
 *
 * @returns Whether the smoke should run and the skip reason when it should not.
 */
function readSmokePrerequisites(): SmokePrerequisites {
  if (process.env.OPENKIT_E2E_REAL_CODEX !== '1') {
    return { enabled: false, reason: 'set OPENKIT_E2E_REAL_CODEX=1 to opt in' };
  }

  if (!runtimeBinaryExists('codex')) {
    return { enabled: false, reason: '`codex` was not found on PATH' };
  }

  if (!hasCredentialMarker()) {
    return {
      enabled: false,
      reason: 'set OPENAI_API_KEY or OPENKIT_E2E_REAL_CODEX_CREDENTIAL=1 after `codex login`',
    };
  }

  return { enabled: true, reason: '' };
}

/**
 * Checks whether a runtime binary name exists on the current process PATH.
 *
 * @param runtime Runtime binary name.
 * @returns True when the binary can be executed.
 */
function runtimeBinaryExists(runtime: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => canExecute(join(entry, runtime)));
}

/**
 * Checks executable access for one path.
 *
 * @param path Candidate executable path.
 * @returns True when the current process can execute the path.
 */
function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks for an explicit credential marker accepted by the smoke test.
 *
 * @returns True when a provider credential marker is present.
 */
function hasCredentialMarker(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY || process.env.OPENKIT_E2E_REAL_CODEX_CREDENTIAL === '1'
  );
}

/**
 * Checks whether one event payload contains a completed assistant-message item.
 *
 * @param data SSE event payload.
 * @returns True when the event is an assistant-message completion.
 */
function isAssistantMessageCompleted(data: Record<string, unknown>): boolean {
  if (data.type !== 'item-completed' || typeof data.item !== 'object' || data.item === null) {
    return false;
  }

  return (data.item as { type?: unknown }).type === 'assistant-message';
}
