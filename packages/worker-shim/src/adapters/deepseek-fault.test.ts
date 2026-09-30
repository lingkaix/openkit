import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Defaults are image supply; test runs never import the developer's native home.
let imageHome: string;
beforeEach(() => {
  imageHome = mkdtempSync(join(tmpdir(), 'deepseek-test-image-'));
  vi.stubEnv('HOME', imageHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(imageHome, { force: true, recursive: true });
});
/** Runs the actual adapter in an isolated supervisor; unhandled errors are fatal. */
function probe(scenario: string): Promise<{ code: number | null; output: string }> {
  const script = `
    import { registerHooks } from 'node:module';
    import { readFileSync, existsSync } from 'node:fs';
    import ts from 'typescript';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL) {
          const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
          if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
          source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
        return next(url, context);
      }
    });
    await import(${JSON.stringify(new URL('./deepseek-fault-probe.ts', import.meta.url).href)});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--unhandled-rejections=strict', '--input-type=module', '--eval', script, scenario],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (bytes) => {
      output += bytes;
    });
    child.stderr.on('data', (bytes) => {
      output += bytes;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

describe('DeepSeek subprocess failure boundaries', () => {
  it.each([
    'write',
    'read',
    'premature-close',
    'transport',
    'write-unproved',
    'idle-read',
    'idle-write',
    'method',
    'request-result',
    'request-error',
    'response-params',
    'response-noid',
    'both',
    'error',
    'id',
    'missing',
    'params',
    'typed-id',
    'additive',
    'close',
    'close-unproved',
    'content',
    'content-unproved',
    'overflow',
    'overflow-unproved',
  ])('stops or fences %s without escaping the supervisor', async (scenario) => {
    const result = await probe(scenario);
    expect(result.output).not.toMatch(/Unhandled|unhandled rejection/i);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`PROBE-PASS ${scenario}`);
  }, 40_000);
});
