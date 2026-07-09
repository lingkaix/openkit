import { describe, expect, it } from 'vitest';
import { createNanoCoreClientOptionsFromEnv } from './config.js';

describe('OpenKit AI Interface configuration', () => {
  it('maps the scoped NanoCore token environment to one bearer header', () => {
    const options = createNanoCoreClientOptionsFromEnv({
      OPENKIT_NANOCORE_TOKEN: ' okt_openkit_secret ',
      OPENKIT_NANOCORE_URL: 'https://nanocore.example.test/',
    });

    expect(options).toEqual({
      baseUrl: 'https://nanocore.example.test/',
      headers: {
        authorization: 'Bearer okt_openkit_secret',
        'x-openkit-client-channel': 'mcp',
        'x-openkit-client-source': 'desktop-agent',
      },
    });
  });

  it('uses the desktop credential store when no token environment is present', () => {
    const options = createNanoCoreClientOptionsFromEnv(
      {
        OPENKIT_NANOCORE_URL: 'https://nanocore.example.test/',
      },
      {
        credentialStore: {
          readNanoCoreToken: ({ baseUrl }) =>
            baseUrl === 'https://nanocore.example.test/' ? ' okt_keychain_secret ' : null,
        },
      }
    );

    expect(options).toEqual({
      baseUrl: 'https://nanocore.example.test/',
      headers: {
        authorization: 'Bearer okt_keychain_secret',
        'x-openkit-client-channel': 'mcp',
        'x-openkit-client-source': 'desktop-agent',
      },
    });
  });

  it('prefers the token environment over the desktop credential store', () => {
    const options = createNanoCoreClientOptionsFromEnv(
      {
        OPENKIT_NANOCORE_TOKEN: 'okt_env_secret',
        OPENKIT_NANOCORE_URL: 'https://nanocore.example.test/',
      },
      {
        credentialStore: {
          readNanoCoreToken: () => 'okt_keychain_secret',
        },
      }
    );

    expect(options.headers).toEqual({
      authorization: 'Bearer okt_env_secret',
      'x-openkit-client-channel': 'mcp',
      'x-openkit-client-source': 'desktop-agent',
    });
  });

  it('ignores removed raw cookie and authorization passthrough variables', () => {
    const env = {
      OPENKIT_NANOCORE_AUTHORIZATION: 'Bearer deployment-token',
      OPENKIT_NANOCORE_COOKIE: 'better-auth.session_token=session-value',
      OPENKIT_NANOCORE_URL: 'https://nanocore.example.test/',
    };

    const options = createNanoCoreClientOptionsFromEnv(env);

    expect(options).toEqual({
      baseUrl: 'https://nanocore.example.test/',
    });
  });

  it('omits empty auth headers for local mode', () => {
    const options = createNanoCoreClientOptionsFromEnv({
      OPENKIT_NANOCORE_TOKEN: '',
    });

    expect(options).toEqual({ baseUrl: 'http://127.0.0.1:3000' });
  });
});
