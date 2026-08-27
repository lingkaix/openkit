import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertNoPublicSecretLeak,
  prepareEvidenceDirectory,
  verifyRealCodexRuntime,
  waitForChildOrDeadline,
  writeExclusiveEvidenceFile,
} from './real-codex-support.mjs';

/**
 * Applies URI component encoding repeatedly for normalization-boundary checks.
 *
 * @param {string} value Plain test value.
 * @param {number} depth Exact encoding depth.
 * @returns {string} Repeatedly encoded value.
 */
function encodePercentLayers(value, depth) {
  let encoded = value;
  for (let pass = 0; pass < depth; pass += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

for (const encodedCredentialSurface of [
  {
    name: 'userinfo',
    value: 'https%253A%252F%252Foperator%253Auserinfo-canary%2540example.invalid',
  },
  {
    name: 'query key',
    value: 'https://example.invalid/path?access%255Ftoken=query-canary',
  },
  {
    name: 'fragment key',
    value: 'https://example.invalid/path#client%255Fsecret=fragment-canary',
  },
]) {
  test(`rejects double-percent-encoded credential material in a public ${encodedCredentialSurface.name}`, () => {
    assert.throws(() => assertNoPublicSecretLeak(encodedCredentialSurface.value), /exposed/);
  });
}

for (const encodedCredentialSurface of [
  {
    name: 'userinfo',
    value: 'https%25253A%25252F%25252Foperator%25253Auserinfo-canary%252540example.invalid',
  },
  {
    name: 'query key',
    value: 'https://example.invalid/path?access%25255Ftoken=query-canary',
  },
  {
    name: 'fragment key',
    value: 'https://example.invalid/path#client%25255Fsecret=fragment-canary',
  },
]) {
  test(`rejects triple-percent-encoded credential material in a public ${encodedCredentialSurface.name}`, () => {
    assert.throws(() => assertNoPublicSecretLeak(encodedCredentialSurface.value), /exposed/);
  });
}

test('verifies the prepared real Codex account, profiles, and strict no-op reload', async () => {
  let accountStatus = 'logged_in';
  const provider = {
    defaultModel: 'openai-codex/gpt-5.6-sol',
    displayName: 'OpenAI Codex',
    extensions: { openkit: { subscriptionAccount: { accountSlotId: 'a1-codex-slot' } } },
    id: 'a1-openai-codex',
    kind: 'oauth',
    models: ['openai-codex/gpt-5.6-sol'],
    vendor: 'openai-codex',
  };
  const agent = {
    id: 'agent_codex_host',
    provider: { model: 'openai-codex/gpt-5.6-sol', ref: 'a1-openai-codex' },
    schemaVersion: 1,
  };
  const reload = {
    plan: {
      applied: [],
      deferred: [],
      nextVersion: 2,
      previousVersion: 1,
      rejected: [],
      requiresRestart: [],
      warnings: [],
    },
    runtimeConfig: { pendingRestart: [] },
    status: 'dry-run',
  };
  const requestedFiles = [];
  let listedAccountSlotId = 'a1-codex-slot';
  let reportedAccountSlotId;
  const core = {
    providerSubscriptions: {
      getAccountStatus: async (subscriptionProviderId, accountSlotId) => ({
        accountSlotId: reportedAccountSlotId ?? accountSlotId,
        status: accountStatus,
        subscriptionProviderId,
      }),
      listAccounts: async () => ({
        accounts: [
          {
            accountSlotId: listedAccountSlotId,
            status: accountStatus,
            subscriptionProviderId: 'openai-codex',
          },
        ],
      }),
    },
    runtimeConfig: {
      getFile: async (id) => {
        requestedFiles.push(id);
        return {
          content: JSON.stringify(id.startsWith('providers/') ? provider : agent),
          file: { revision: 'prepared-1' },
        };
      },
      reload: async () => reload,
    },
  };

  assert.equal(Object.hasOwn(reload.runtimeConfig, 'staleSessions'), false);
  requestedFiles.length = 0;
  assert.deepEqual(await verifyRealCodexRuntime(core), {
    providerId: 'a1-openai-codex',
  });
  assert.deepEqual(requestedFiles.slice(0, 2), [
    'agents/codex.agent.jsonc',
    'providers/a1-openai-codex.provider.jsonc',
  ]);
  for (const [mutate, restore, pattern] of [
    [
      () => {
        provider.vendor = 'openai_codex';
      },
      () => {
        provider.vendor = 'openai-codex';
      },
      /provider/i,
    ],
    [
      () => {
        delete provider.vendor;
      },
      () => {
        provider.vendor = 'openai-codex';
      },
      /provider/i,
    ],
    [
      () => {
        provider.kind = 'api-key';
      },
      () => {
        provider.kind = 'oauth';
      },
      /provider/i,
    ],
    [
      () => {
        delete provider.kind;
      },
      () => {
        provider.kind = 'oauth';
      },
      /provider/i,
    ],
    [
      () => {
        provider.defaultModel = 'openai-codex/wrong';
      },
      () => {
        provider.defaultModel = 'openai-codex/gpt-5.6-sol';
      },
      /provider/i,
    ],
    [
      () => {
        delete provider.defaultModel;
      },
      () => {
        provider.defaultModel = 'openai-codex/gpt-5.6-sol';
      },
      /provider/i,
    ],
    [
      () => {
        provider.models = ['openai-codex/gpt-5.6-sol', 'openai-codex/extra'];
      },
      () => {
        provider.models = ['openai-codex/gpt-5.6-sol'];
      },
      /provider/i,
    ],
    [
      () => {
        delete provider.models;
      },
      () => {
        provider.models = ['openai-codex/gpt-5.6-sol'];
      },
      /provider/i,
    ],
    [
      () => {
        listedAccountSlotId = 'default';
      },
      () => {
        listedAccountSlotId = 'a1-codex-slot';
      },
      /logged in/i,
    ],
    [
      () => {
        reportedAccountSlotId = 'default';
      },
      () => {
        reportedAccountSlotId = undefined;
      },
      /logged in/i,
    ],
    [
      () => {
        delete provider.extensions.openkit.subscriptionAccount.accountSlotId;
      },
      () => {
        provider.extensions.openkit.subscriptionAccount.accountSlotId = 'a1-codex-slot';
      },
      /provider/i,
    ],
    [
      () => {
        provider.extensions.openkit.subscriptionAccount.accountSlotId = 'wrong-slot';
      },
      () => {
        provider.extensions.openkit.subscriptionAccount.accountSlotId = 'a1-codex-slot';
      },
      /logged in/i,
    ],
  ]) {
    mutate();
    await assert.rejects(() => verifyRealCodexRuntime(core), pattern);
    restore();
  }
  accountStatus = 'logged_out';
  await assert.rejects(() => verifyRealCodexRuntime(core), /logged in/i);
  accountStatus = 'logged_in';

  provider.id = 'wrong_provider';
  await assert.rejects(() => verifyRealCodexRuntime(core), /provider/i);
  provider.id = 'a1-openai-codex';
  agent.id = 'agent_wrong';
  await assert.rejects(() => verifyRealCodexRuntime(core), /agent/i);
  agent.id = 'agent_codex_host';
  agent.provider.model = 'openai-codex/wrong';
  await assert.rejects(() => verifyRealCodexRuntime(core), /agent|model/i);
  agent.provider.model = 'openai-codex/gpt-5.6-sol';
  reload.plan.applied.push({ path: 'providers/a1-openai-codex.provider.jsonc' });
  await assert.rejects(() => verifyRealCodexRuntime(core), /no-op/i);
});

test('enforces the shared deadline, redaction, and exclusive owner-only evidence policy', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.pid = 73;
  const outcome = await waitForChildOrDeadline(child, 1, (pid, signal) => {
    signals.push([pid, signal]);
    queueMicrotask(() => child.emit('close', null, signal));
  });
  assert.deepEqual(outcome, { kind: 'timeout' });
  assert.deepEqual(signals, [[-73, 'SIGKILL']]);

  assert.throws(
    () => assertNoPublicSecretLeak({ authorization: 'Bearer support-secret-canary-value' }),
    /exposed/
  );
  assert.throws(() => assertNoPublicSecretLeak('/home/operator/.codex/auth.json'), /exposed/);
  assert.throws(
    () => assertNoPublicSecretLeak({ summary: 'exact-secret-canary' }, ['exact-secret-canary']),
    /exposed/
  );

  const root = await mkdtemp(join(tmpdir(), 'openkit-e2e-support-evidence-'));
  const output = join(root, 'result.json');
  try {
    prepareEvidenceDirectory(root, ['result.json']);
    writeExclusiveEvidenceFile(output, '{}\n');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeExclusiveEvidenceFile(output, '{}\n'), /EEXIST/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('accepts ordinary access metadata without weakening access-token redaction', () => {
  assert.doesNotThrow(() => assertNoPublicSecretLeak({ access: 'read-write' }));
  assert.throws(
    () => assertNoPublicSecretLeak({ accessToken: 'support-access-token-canary' }),
    /exposed/
  );
});

test('rejects an existing evidence directory that is not owner-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-e2e-support-public-evidence-'));
  chmodSync(root, 0o755);

  try {
    assert.throws(() => prepareEvidenceDirectory(root, ['result.json']), /owner-only|0700/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('accepts an innocuous public value after exactly eight percent-decoding layers', () => {
  assert.doesNotThrow(() =>
    assertNoPublicSecretLeak(encodePercentLayers('public/notice:value', 8))
  );
});

test('rejects credential material after exactly eight percent-decoding layers', () => {
  assert.throws(
    () =>
      assertNoPublicSecretLeak(
        encodePercentLayers('https://operator:depth-eight-canary@example.invalid/private', 8)
      ),
    /exposed/
  );
});

test('fails closed when percent decoding still changes an innocuous value after eight layers', () => {
  assert.throws(() => assertNoPublicSecretLeak(encodePercentLayers('public/notice:value', 9)));
});

const UNICODE_PUBLIC_MARKER = 'operator-marker-机密-🔒';

for (const markerDepth of [0, 1, 8]) {
  test(`rejects a configured Unicode marker after ${markerDepth} UTF-8 percent-encoding layers`, () => {
    assert.throws(
      () =>
        assertNoPublicSecretLeak(
          { publicNotice: encodePercentLayers(UNICODE_PUBLIC_MARKER, markerDepth) },
          [UNICODE_PUBLIC_MARKER]
        ),
      /exposed/
    );
  });
}

test('fails closed when a configured Unicode marker remains encoded after eight layers', () => {
  assert.throws(() =>
    assertNoPublicSecretLeak({ publicNotice: encodePercentLayers(UNICODE_PUBLIC_MARKER, 9) }, [
      UNICODE_PUBLIC_MARKER,
    ])
  );
});

for (const escapedCredentialKey of [
  {
    name: 'leading character',
    nestedJson: '{"\\u0061ccess_token":"unicode-key-leading-canary"}',
  },
  {
    name: 'separator',
    nestedJson: '{"access\\u005ftoken":"unicode-key-separator-canary"}',
  },
]) {
  test(`rejects a credential object with a Unicode-escaped ${escapedCredentialKey.name} in a safe-named string`, () => {
    assert.throws(
      () => assertNoPublicSecretLeak({ publicNotice: escapedCredentialKey.nestedJson }),
      /exposed/
    );
  });
}
