// openkit-test-platform: posix
// These permission and no-follow fixtures require the unprivileged POSIX test runner.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localAiRoot, readLocalAiState, writeLocalAiState } from './store.js';

const roots: string[] = [];
const initial = { schemaVersion: 1 as const, backends: {} };
function fixture(bytes?: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-local-ai-state-'));
  roots.push(root);
  const directory = localAiRoot(root);
  const path = join(directory, 'state.json');
  if (bytes !== undefined) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, bytes);
  }
  return { root, directory, path };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it('defaults only for genuinely absent initial state and round-trips valid settings', () => {
  const { root } = fixture();
  expect(readLocalAiState(root)).toEqual(initial);
  const state = {
    schemaVersion: 1 as const,
    backends: {
      'llama-cpp': {
        enabled: true,
        selectedModelId: 'local-model',
        threads: 2,
        licenseAcceptedAt: '2026-11-10T00:00:00Z',
      },
    },
  };
  writeLocalAiState(root, state);
  expect(readLocalAiState(root)).toEqual(state);
});

it.each([
  [
    'future version',
    '{"schemaVersion":2,"backends":{},"future":"preserve"}',
    'local_ai_state_unsupported',
  ],
  ['malformed JSON', '{"private":"DO-NOT-REPORT",', 'local_ai_state_corrupt'],
  ['missing version', '{"backends":{}}', 'local_ai_state_corrupt'],
  ['JSON BOM remains invalid', '\uFEFF{"schemaVersion":1,"backends":{}}', 'local_ai_state_corrupt'],
  [
    'invalid settings',
    '{"schemaVersion":1,"backends":{"llama-cpp":{"enabled":true}}}',
    'local_ai_state_corrupt',
  ],
  [
    'invalid UTF-8',
    Buffer.concat([
      Buffer.from('{"schemaVersion":1,"backends":{"llama-cpp":{"enabled":true,"selectedModelId":"'),
      Buffer.from([0xff]),
      Buffer.from('","threads":2,"licenseAcceptedAt":"accepted"}}}'),
    ]),
    'local_ai_state_corrupt',
  ],
] as const)('reports and preserves %s on read and attempted replacement', (_label, bytes, code) => {
  const { root, path } = fixture(bytes);
  for (const operation of [() => readLocalAiState(root), () => writeLocalAiState(root, initial)]) {
    let failure: unknown;
    try {
      operation();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain('DO-NOT-REPORT');
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
  }
});

it('does not replace retained valid settings with an invalid new value', () => {
  const { root, path } = fixture(JSON.stringify(initial));
  expect(() => writeLocalAiState(root, { schemaVersion: 2 } as never)).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(initial));
});

it('refuses unreadable state rather than returning defaults or replacing it', () => {
  const { root, path } = fixture(JSON.stringify(initial));
  chmodSync(path, 0);
  try {
    expect(() => readLocalAiState(root)).toThrow(
      expect.objectContaining({ code: 'local_ai_state_unreadable' })
    );
    expect(() => writeLocalAiState(root, initial)).toThrow(
      expect.objectContaining({ code: 'local_ai_state_unreadable' })
    );
  } finally {
    chmodSync(path, 0o600);
  }
  expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(initial));
});

it('does not mistake a directory, link or invalid ancestor for initial absence', () => {
  for (const kind of ['directory', 'link', 'ancestor'] as const) {
    const { root, directory, path } = fixture();
    if (kind === 'ancestor') {
      mkdirSync(join(root, 'server', 'files'), { recursive: true });
      writeFileSync(directory, 'retained');
    } else {
      mkdirSync(directory, { recursive: true });
      if (kind === 'directory') mkdirSync(path);
      else symlinkSync(join(root, 'absent-target'), path);
    }
    expect(() => readLocalAiState(root)).toThrow(
      expect.objectContaining({ code: 'local_ai_state_unreadable' })
    );
    expect(() => writeLocalAiState(root, initial)).toThrow(
      expect.objectContaining({ code: 'local_ai_state_unreadable' })
    );
  }
});
