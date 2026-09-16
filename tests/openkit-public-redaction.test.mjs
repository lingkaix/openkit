import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactPublicValue } from '../skills/openkit-secrets.mjs';

test('public redaction preserves standalone slash punctuation while redacting paths and tokens', () => {
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
      path: '[redacted-local-path]',
      home: '[redacted-local-path]',
      homeRoot: '[redacted-local-path]',
      windowsPath: '[redacted-local-path]',
      windowsRoot: '[redacted-local-path]',
      uncPath: '[redacted-local-path]',
      token: '[redacted]',
      note: 'used [redacted] beside [redacted-local-path]',
    }
  );
});
