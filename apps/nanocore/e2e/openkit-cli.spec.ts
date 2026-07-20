import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

const cliPath = fileURLToPath(new URL('../../../skills/openkit/scripts/openkit', import.meta.url));
let harness: NanoCoreHarness | null = null;

/** Minimal successful CLI envelope used by this acceptance story. */
type CliEnvelope = {
  ok: true;
  command: string;
  operation?: string;
  requestId?: string;
  data: Record<string, unknown>;
};

afterEach(async () => {
  const current = harness;
  harness = null;
  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('OpenKit Skill CLI e2e', () => {
  it('diagnoses NanoCore and persists one public mutation', async () => {
    harness = await startNanoCoreHarness({ seedDemoWorkspace: false });

    const doctor = await runCli(harness.baseUrl, ['doctor']);
    expect(doctor).toMatchObject({
      ok: true,
      command: 'doctor',
      data: {
        endpoint: harness.baseUrl,
        authentication: 'unauthenticated-local',
        nanocore: { ready: true, protocolVersion: PROTOCOL_VERSION },
      },
    });
    expect(doctor.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const created = await runCli(
      harness.baseUrl,
      ['ops', 'call', 'workspace.create', '--input', '-'],
      JSON.stringify({ name: 'CLI E2E Workspace' })
    );
    expect(created).toMatchObject({
      ok: true,
      command: 'ops.call',
      operation: 'workspace.create',
      data: { name: 'CLI E2E Workspace', kind: 'general', status: 'active' },
    });
    expect(created.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await runCli(harness.baseUrl, ['ops', 'call', 'workspace.list', '--input', '-']);
    expect(listed).toMatchObject({
      ok: true,
      command: 'ops.call',
      operation: 'workspace.list',
    });
    expect(listed.data.items).toContainEqual(expect.objectContaining({ workspace: created.data }));
  }, 20_000);
});

/**
 * Runs the checked standalone CLI against one local NanoCore process.
 *
 * @param baseUrl NanoCore base URL.
 * @param args CLI arguments.
 * @param input Standard-input JSON.
 * @returns Parsed successful CLI envelope.
 */
function runCli(baseUrl: string, args: string[], input = '{}'): Promise<CliEnvelope> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        OPENKIT_NANOCORE_URL: baseUrl,
        OPENKIT_NANOCORE_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`OpenKit CLI failed with ${code ?? signal}: ${stderr || stdout}`));
        return;
      }
      expect(stderr).toBe('');
      resolve(JSON.parse(stdout) as CliEnvelope);
    });
    child.stdin.end(input);
  });
}
