import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { QUALIFIED_STEER_PINS } from './turn-executor-factory.js';

const shipped = JSON.parse(
  readFileSync(
    new URL('../../../../containers/worker-runtimes/versions.json', import.meta.url),
    'utf8'
  )
) as Record<string, { version?: unknown } | undefined>;

// A harness pin bump re-runs the pinned adapter live-steer cases (worker-shim Codex/Pi adapter and
// Harness tests, Pi Runtime Host tests) and then updates the list. A failing pin leaves the list here
// and in QUALIFIED_STEER_PINS on purpose, so a bump can neither silently disable nor blindly enable steer.
it('binds the qualified live-steer pins to the exact shipped Worker harness pins', () => {
  expect(QUALIFIED_STEER_PINS).toEqual({ codex: shipped.codex?.version, pi: shipped.pi?.version });
});
