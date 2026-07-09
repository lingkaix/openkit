import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadProviderProfiles } from '../config/providers-loader.js';
import { createProviderDiagnostics } from './diagnostics.js';

/**
 * Creates a temporary data root with a providers config directory.
 *
 * @returns Providers directory and data-root paths.
 */
function createProviderRoot(): { dataRoot: string; providersRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-diagnostics-'));
  const providersRoot = join(dataRoot, 'config', 'providers');

  mkdirSync(providersRoot, { recursive: true });

  return { dataRoot, providersRoot };
}

describe('createProviderDiagnostics', () => {
  it('blocks raw provider secrets and unknown required sections without leaking secrets', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'raw.provider.jsonc'),
      JSON.stringify({
        apiKey: 'sk-raw-secret',
        displayName: 'Raw',
        id: 'raw',
        kind: 'direct',
        models: ['raw-model'],
      })
    );
    writeFileSync(
      join(providersRoot, 'required-extension.provider.jsonc'),
      JSON.stringify({
        displayName: 'Required Extension',
        extensions: {
          vendorFeature: { required: true },
        },
        id: 'required-extension',
        kind: 'custom',
        models: ['model'],
      })
    );

    const diagnostics = createProviderDiagnostics(loadProviderProfiles(dataRoot));

    expect(diagnostics.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider.invalid_profile',
          profileId: 'raw',
          status: 'blocked',
        }),
        expect.objectContaining({
          code: 'provider.unknown_required_extension',
          profileId: 'required-extension',
          status: 'blocked',
        }),
      ])
    );
    expect(diagnostics.redactedSnapshot).toEqual([
      expect.objectContaining({
        id: 'required-extension',
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('sk-raw-secret');
  });
});
