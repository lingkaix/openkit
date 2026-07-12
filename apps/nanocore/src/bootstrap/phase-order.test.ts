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

  it('validates listener and server-auth inputs before activating copied templates', () => {
    const source = readEntrypointSource();
    const configPhase = source.indexOf("name: 'config'");
    const initialConfigLoad = source.indexOf(
      'runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 })',
      configPhase
    );
    const bindValidation = source.indexOf('resolveBindPort(process.env', configPhase);
    const secretValidation = source.indexOf('resolveBetterAuthSecret(process.env', configPhase);
    const templateWrite = source.indexOf('ensureConfigTemplateSurface(dataRoot)', configPhase);
    const finalConfigLoad = source.indexOf(
      'runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 })',
      initialConfigLoad + 1
    );
    const layoutPhase = source.indexOf("name: 'data-root-layout'", configPhase);

    expect(initialConfigLoad).toBeGreaterThan(configPhase);
    expect(bindValidation).toBeGreaterThan(configPhase);
    expect(secretValidation).toBeGreaterThan(configPhase);
    expect(initialConfigLoad).toBeLessThan(bindValidation);
    expect(bindValidation).toBeLessThan(templateWrite);
    expect(secretValidation).toBeLessThan(templateWrite);
    expect(templateWrite).toBeLessThan(finalConfigLoad);
    expect(finalConfigLoad).toBeLessThan(layoutPhase);
  });
});
