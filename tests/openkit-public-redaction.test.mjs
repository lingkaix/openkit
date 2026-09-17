import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactPublicValue } from '../skills/openkit-secrets.mjs';

test('public redaction preserves standalone slash punctuation while replacing tokens and extra secrets', () => {
  assert.equal(
    redactPublicValue('OrcaRouter / DeepSeek Flash Free'),
    'OrcaRouter / DeepSeek Flash Free'
  );
  assert.deepEqual(
    redactPublicValue(
      {
        model: 'OrcaRouter / DeepSeek Flash Free',
        path: '/Users/demo/private',
        home: '~/secret/file',
        homeRoot: '~/',
        windowsPath: 'C:\\Users\\demo\\private',
        windowsRoot: 'C:\\',
        uncPath: '\\\\server\\share',
        token: 'okt_live_token',
        note: 'used extra-secret beside /tmp/workspace',
      },
      ['extra-secret']
    ),
    {
      model: 'OrcaRouter / DeepSeek Flash Free',
      path: '/Users/demo/private',
      home: '~/secret/file',
      homeRoot: '~/',
      windowsPath: 'C:\\Users\\demo\\private',
      windowsRoot: 'C:\\',
      uncPath: '\\\\server\\share',
      token: '[redacted]',
      note: 'used [redacted] beside /tmp/workspace',
    }
  );
});

test('public redaction retains authorized config quoting, executable and API paths, and unified-diff /dev/null', () => {
  const document = `{
  "executable": "/usr/lib/openkit/nanohost",
  "api": "/v1/provider-subscriptions/xai/accounts/primary/quota"
}`;
  const patch = `--- /dev/null
+++ b/apps/nanocore/src/llm/xai-quota.ts
@@ -0,0 +1 @@
+export {}
`;
  assert.deepEqual(
    redactPublicValue(
      {
        document,
        patch,
        token: 'okt_live_token',
        note: 'used extra-secret beside /usr/bin/openkit',
      },
      ['extra-secret']
    ),
    {
      document,
      patch,
      token: '[redacted]',
      note: 'used [redacted] beside /usr/bin/openkit',
    }
  );
});

test('public redaction preserves nested zero and signed cents, false enabled, and omitted fields through the JSON envelope', () => {
  const envelope = {
    ok: true,
    data: {
      billing: {
        currency: 'USD',
        prepaidBalanceCents: 0,
        onDemandUsedCents: -1,
      },
      enabled: false,
      token: 'okt_live_token',
    },
  };
  assert.deepEqual(redactPublicValue(envelope), {
    ok: true,
    data: {
      billing: {
        currency: 'USD',
        prepaidBalanceCents: 0,
        onDemandUsedCents: -1,
      },
      enabled: false,
      token: '[redacted]',
    },
  });
  assert.equal(
    JSON.stringify(redactPublicValue(envelope)),
    '{"ok":true,"data":{"billing":{"currency":"USD","prepaidBalanceCents":0,"onDemandUsedCents":-1},"enabled":false,"token":"[redacted]"}}'
  );
});
