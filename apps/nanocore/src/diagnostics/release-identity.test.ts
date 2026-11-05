import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDiagnosticsResponseSchema } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { BootConfigError } from '../config/mode.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { RELEASE_IDENTITY_PATH, readReleaseIdentity } from './release-identity.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TAG = 'v0.1.0-rc.5';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes one identity file and returns its path. */
function writeIdentity(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'release-identity-'));
  roots.push(root);
  const path = join(root, 'release-identity.json');
  writeFileSync(path, contents);
  return path;
}

describe('App release identity', () => {
  it('reports a valid identity file and reports nulls when the file is missing', async () => {
    const path = writeIdentity(`${JSON.stringify({ releaseTag: TAG, sourceCommit: COMMIT })}\n`);
    const missing = join(path, '..', 'absent.json');

    expect(readReleaseIdentity(path)).toEqual({ releaseTag: TAG, sourceCommit: COMMIT });
    expect(readReleaseIdentity(missing)).toEqual({ releaseTag: null, sourceCommit: null });
    const untagged = writeIdentity(JSON.stringify({ releaseTag: null, sourceCommit: COMMIT }));
    expect(readReleaseIdentity(untagged)).toEqual({ releaseTag: null, sourceCommit: COMMIT });
    expect(AppDiagnosticsResponseSchema.shape.build.parse(readReleaseIdentity(untagged))).toEqual({
      releaseTag: null,
      sourceCommit: COMMIT,
    });
    expect(RELEASE_IDENTITY_PATH).toBe('/usr/local/lib/openkit/release-identity.json');

    const app = createApp({ releaseIdentity: readReleaseIdentity(path) });
    const response = await app.request(...operationRequest('diagnostics.app', {}));
    expect(response.status).toBe(200);
    expect(AppDiagnosticsResponseSchema.parse(await response.json()).build).toEqual({
      releaseTag: TAG,
      sourceCommit: COMMIT,
    });
  });

  it('uses a source-build file only after an absent image identity, never over a present image', () => {
    const image = writeIdentity(JSON.stringify({ releaseTag: TAG, sourceCommit: COMMIT }));
    const sourceCommit = 'a'.repeat(40);
    const source = writeIdentity(JSON.stringify({ releaseTag: null, sourceCommit }));
    const missing = join(image, '..', 'absent-image.json');
    expect(readReleaseIdentity(image, source)).toEqual({ releaseTag: TAG, sourceCommit: COMMIT });
    expect(readReleaseIdentity(missing, source)).toEqual({ releaseTag: null, sourceCommit });
    expect(readReleaseIdentity(missing, join(source, '..', 'absent-source.json'))).toEqual({
      releaseTag: null,
      sourceCommit: null,
    });
    writeFileSync(image, '{');
    expect(() => readReleaseIdentity(image, source)).toThrow(BootConfigError);
    writeFileSync(source, JSON.stringify({ releaseTag: null, sourceCommit: null }));
    expect(() => readReleaseIdentity(missing, source)).toThrow(BootConfigError);
  });

  it('ignores unknown additive file keys and does not copy them into diagnostics', () => {
    const path = writeIdentity(
      JSON.stringify({ releaseTag: TAG, sourceCommit: COMMIT, note: 'ignored' })
    );
    expect(readReleaseIdentity(path)).toEqual({ releaseTag: TAG, sourceCommit: COMMIT });
  });

  it('fails boot configuration for a malformed identity file', () => {
    const cases = [
      '{',
      '[]',
      'null',
      JSON.stringify({ releaseTag: TAG }),
      JSON.stringify({ releaseTag: 'V0.1.0', sourceCommit: COMMIT }),
      JSON.stringify({ releaseTag: TAG, sourceCommit: COMMIT.toUpperCase() }),
      JSON.stringify({ releaseTag: null, sourceCommit: null }),
    ];
    for (const contents of cases) {
      const path = writeIdentity(contents);
      expect(() => readReleaseIdentity(path)).toThrow(BootConfigError);
      try {
        readReleaseIdentity(path);
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_release_identity' });
      }
    }
  });

  it('reports a non-release build when diagnostics has no admitted identity', async () => {
    const app = createApp();
    const response = await app.request(...operationRequest('diagnostics.app', {}));
    expect(response.status).toBe(200);
    expect(AppDiagnosticsResponseSchema.parse(await response.json()).build).toEqual({
      releaseTag: null,
      sourceCommit: null,
    });
  });

  it('fails closed when the identity path exists but cannot be read as a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-identity-dir-'));
    roots.push(root);
    const path = join(root, 'not-a-file');
    mkdirSync(path);
    expect(() => readReleaseIdentity(path)).toThrow(BootConfigError);
  });
});
