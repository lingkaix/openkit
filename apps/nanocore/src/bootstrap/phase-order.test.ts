import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Extracts boot phase names from the NanoCore process entrypoint.
 *
 * @returns Ordered boot phase names.
 */
function readEntrypointBootPhaseNames(): string[] {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  return Array.from(source.matchAll(/name: '([^']+)'/g), (match) => match[1] ?? '');
}

/**
 * Reads the NanoCore process entrypoint source.
 *
 * @returns Entrypoint source text.
 */
function readEntrypointSource(): string {
  return readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
}

describe('NanoCore boot phase order', () => {
  it('matches the accepted startup phase order', () => {
    expect(readEntrypointBootPhaseNames()).toEqual([
      'config',
      'data-root-layout',
      'instance-lock',
      'migrations',
      'policy-kernel',
      'vault',
      'local-identity',
      'scheduler-restart-recovery',
    ]);
  });

  it('preserves stopped scheduler hooks when shutdown hits the deadline', () => {
    const source = readEntrypointSource();

    expect(source).toContain('const stepsCompleted = [');
    expect(source).toContain(
      "onDeadline: () => finishShutdown(signal, [...stepsCompleted, 'shutdown.deadline'], true, 1)"
    );
  });
});
