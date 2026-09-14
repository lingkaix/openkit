import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';

describe('administration catalog application client', () => {
  it('sends exact human confirmation and validates the persistence/reload response', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const candidate = {
      artifactId: 'candidate',
      artifactVersion: 1 as const,
      contentDigest: digest,
    };
    const input = {
      requestId: '11111111-1111-4111-8111-111111111111',
      candidate,
      confirmation: {
        action: 'administration.configuration.apply' as const,
        contentDigest: digest,
      },
    };
    const result = {
      candidate,
      persisted: true,
      revision: 'revision',
      reload: 'failed',
      restartRequired: true,
    };
    const fetch = vi.fn(async () => Response.json(result));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    expect(await client.app.applyAdministrationConfiguration(input)).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/administration/configuration/apply',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) })
    );
    expect(() =>
      client.app.applyAdministrationConfiguration({
        ...input,
        confirmation: { ...input.confirmation, contentDigest: `sha256:${'b'.repeat(64)}` },
      })
    ).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
