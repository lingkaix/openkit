import assert from 'node:assert/strict';
import { test } from 'node:test';

const target = 'https://staging.example.invalid';
const nonce = 'a'.repeat(64);
const bootId = '11111111-1111-4111-8111-111111111111';

/** Owner-derived P02 wire evidence; the real native-producer composition has its own test owner. */
function observed() {
  const process = { bootId, pid: 123, startTimeTicks: '12345' };
  return {
    nonce,
    outcome: 'observed',
    machineIdentityDigest: '1'.repeat(64),
    physicalEpoch: '2'.repeat(64),
    identityId: 'configured-nanohost',
    deploymentId: 'configured-deployment',
    connectionGeneration: 8,
    coordinator: structuredClone(process),
    executables: {
      nanohost: { process: structuredClone(process), sha256: '3'.repeat(64) },
      gateway: { process: { bootId, pid: 124, startTimeTicks: '12346' }, sha256: '4'.repeat(64) },
    },
    unit: {
      fileSha256: '5'.repeat(64),
      effectiveStateDigest: '6'.repeat(64),
      activeState: 'active',
      subState: 'running',
    },
    replacementDuringMeasurement: false,
  };
}

/** Observes fixed invocation and bounded collection requests without contacting an operator host. */
function fixture() {
  const requests = [];
  const result = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: Buffer.from(`${JSON.stringify(observed())}\n`),
    stderr: Buffer.alloc(0),
  };
  const runOperator = async (selected, request) => {
    requests.push(request);
    assert.equal(requests.length, 1, 'inspection must not retry');
    assert.equal(selected, target);
    assert.deepEqual(Object.keys(request).sort(), [
      'command',
      'maxStderrBytes',
      'maxStdoutBytes',
      'signal',
      'stdin',
      'timeoutMs',
    ]);
    assert.deepEqual(request.command, ['/usr/lib/openkit/nanohost', 'inspect']);
    assert.equal(request.stdin, JSON.stringify({ nonce }));
    assert.equal(request.timeoutMs, 10_000);
    assert.equal(request.maxStdoutBytes, 16_384);
    assert.equal(request.maxStderrBytes, 256);
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.signal.aborted, false);
    return result;
  };
  return { requests, result, runOperator, request: { nonce } };
}

/** Keeps the first missing-export red inside a named test rather than failing collection. */
async function invoke(f) {
  const { invokeNanoHostInspection } = await import('./host-observation.mjs');
  assert.equal(
    typeof invokeNanoHostInspection,
    'function',
    'the fixed operator invocation export is required'
  );
  return invokeNanoHostInspection(target, f.request, f.runOperator);
}

test('invokes the fixed NanoHost command once with nonce-only input and collection bounds', async () => {
  const f = fixture();
  assert.deepEqual(await invoke(f), observed());
  assert.equal(f.requests.length, 1);
});

test('accepts a complete UTF-8 string response as well as byte output', async () => {
  const f = fixture();
  f.result.stdout = `${JSON.stringify(observed())}\n`;
  f.result.stderr = '';
  assert.deepEqual(await invoke(f), observed());
});

for (const reason of [
  'not-running',
  'access-denied',
  'connection-unavailable',
  'process-changed',
  'measurement-unavailable',
  'unit-unavailable',
]) {
  test(`returns the closed unavailable ${reason} envelope`, async () => {
    const f = fixture();
    const value = { nonce, outcome: 'unavailable', reason };
    f.result.stdout = Buffer.from(JSON.stringify(value));
    assert.deepEqual(await invoke(f), value);
    assert.equal(f.requests.length, 1);
  });
}

for (const [name, change] of [
  [
    'nonzero exit',
    (value) => {
      value.exitCode = 1;
    },
  ],
  [
    'missing exit status',
    (value) => {
      delete value.exitCode;
    },
  ],
  [
    'termination signal',
    (value) => {
      value.signal = 'SIGTERM';
    },
  ],
  [
    'missing signal status',
    (value) => {
      delete value.signal;
    },
  ],
  [
    'reported timeout',
    (value) => {
      value.timedOut = true;
    },
  ],
  [
    'missing timeout status',
    (value) => {
      delete value.timedOut;
    },
  ],
  [
    'nonempty stderr',
    (value) => {
      value.stderr = Buffer.from('synthetic-private-operator-error');
    },
  ],
  [
    'whitespace stderr',
    (value) => {
      value.stderr = '\n';
    },
  ],
  [
    'stderr collection overflow',
    (value) => {
      value.stderr = Buffer.alloc(257, 32);
    },
  ],
  [
    'empty stdout',
    (value) => {
      value.stdout = Buffer.alloc(0);
    },
  ],
  [
    'truncated JSON',
    (value) => {
      value.stdout = '{"nonce":';
    },
  ],
  [
    'multiple JSON envelopes',
    (value) => {
      value.stdout = `${value.stdout}${JSON.stringify(observed())}`;
    },
  ],
  [
    'non-JSON output',
    (value) => {
      value.stdout = 'synthetic-private-operator-error';
    },
  ],
  [
    'malformed UTF-8',
    (value) => {
      value.stdout = Buffer.from([0xc3, 0x28]);
    },
  ],
  [
    'non-byte output object',
    (value) => {
      value.stdout = observed();
    },
  ],
]) {
  test(`refuses ${name} without retry or exposing raw operator output`, async () => {
    const f = fixture();
    change(f.result);
    await assert.rejects(
      () => invoke(f),
      (error) => {
        assert.equal(
          `${error.message} ${error.stack} ${JSON.stringify(error.cause)}`.includes(
            'synthetic-private-operator-error'
          ),
          false
        );
        return true;
      }
    );
    assert.equal(f.requests.length, 1);
  });
}

test('accepts the 16 KiB framing boundary and rejects one extra byte', async () => {
  const exact = fixture();
  const body = JSON.stringify(observed());
  exact.result.stdout = Buffer.from(body + ' '.repeat(16_384 - Buffer.byteLength(body)));
  assert.deepEqual(await invoke(exact), observed());
  const over = fixture();
  over.result.stdout = Buffer.concat([exact.result.stdout, Buffer.from('\n')]);
  await assert.rejects(() => invoke(over));
  assert.equal(over.requests.length, 1);
});

test('counts UTF-8 bytes before stripping oversized descriptive content', async () => {
  const f = fixture();
  f.result.stdout = JSON.stringify({ ...observed(), annotation: 'é'.repeat(8_200) });
  assert.ok(f.result.stdout.length < 16_384);
  assert.ok(Buffer.byteLength(f.result.stdout) > 16_384);
  await assert.rejects(() => invoke(f));
  assert.equal(f.requests.length, 1);
});

for (const [name, change] of [
  [
    'wrong nonce',
    (value) => {
      value.nonce = 'b'.repeat(64);
    },
  ],
  [
    'missing nonce',
    (value) => {
      delete value.nonce;
    },
  ],
  [
    'unknown outcome',
    (value) => {
      value.outcome = 'partial';
    },
  ],
  [
    'unknown unavailable reason',
    (value) => {
      value.outcome = 'unavailable';
      value.reason = 'retry-later';
    },
  ],
  [
    'missing process identity',
    (value) => {
      delete value.coordinator;
    },
  ],
  [
    'unsafe PID',
    (value) => {
      value.coordinator.pid = 2_147_483_648;
      value.executables.nanohost.process.pid = 2_147_483_648;
    },
  ],
  [
    'overflowing start ticks',
    (value) => {
      value.coordinator.startTimeTicks = '18446744073709551616';
      value.executables.nanohost.process.startTimeTicks = '18446744073709551616';
    },
  ],
  [
    'unsafe connection generation',
    (value) => {
      value.connectionGeneration = 9_007_199_254_740_992;
    },
  ],
  [
    'changed NanoHost incarnation',
    (value) => {
      value.executables.nanohost.process.pid = 125;
    },
  ],
  [
    'Gateway PID aliases NanoHost',
    (value) => {
      value.executables.gateway.process.pid = 123;
    },
  ],
  [
    'replacement during measurement',
    (value) => {
      value.replacementDuringMeasurement = true;
    },
  ],
]) {
  test(`refuses unsupported producer core: ${name}`, async () => {
    const f = fixture();
    const value = observed();
    change(value);
    f.result.stdout = Buffer.from(JSON.stringify(value));
    await assert.rejects(() => invoke(f));
    assert.equal(f.requests.length, 1);
  });
}

test('strips unknown descriptive fields from the observed envelope and nested process evidence', async () => {
  const f = fixture();
  const value = observed();
  for (const nested of [
    value,
    value.coordinator,
    value.executables,
    value.executables.nanohost,
    value.executables.nanohost.process,
    value.executables.gateway,
    value.executables.gateway.process,
    value.unit,
  ]) {
    nested.annotation = { opaque: 'synthetic-private-operator-error' };
  }
  f.result.stdout = Buffer.from(JSON.stringify(value));
  assert.deepEqual(await invoke(f), observed());
});

test('strips unknown descriptive fields from unavailable output', async () => {
  const f = fixture();
  const value = { nonce, outcome: 'unavailable', reason: 'process-changed' };
  f.result.stdout = Buffer.from(
    JSON.stringify({ ...value, annotation: 'synthetic-private-operator-error' })
  );
  assert.deepEqual(await invoke(f), value);
});

for (const request of [
  { nonce, command: ['other-command'] },
  { nonce, pid: 123 },
  { nonce, unit: 'other.service' },
  { nonce: '' },
  { nonce: 'A'.repeat(64) },
  {},
]) {
  test(`refuses unsupported caller instruction ${JSON.stringify(request)} before invoking the operator`, async () => {
    const f = fixture();
    f.request = request;
    await assert.rejects(() => invoke(f));
    assert.equal(f.requests.length, 0);
  });
}

test('converts a thrown operator error to safe bounded failure without retry', async () => {
  const f = fixture();
  let attempts = 0;
  f.runOperator = async () => {
    attempts += 1;
    throw Error('synthetic-private-operator-error');
  };
  await assert.rejects(
    () => invoke(f),
    (error) => {
      assert.equal(
        `${error.message} ${error.stack} ${JSON.stringify(error.cause)}`.includes(
          'synthetic-private-operator-error'
        ),
        false
      );
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test('aborts a nonsettling operator invocation at the whole 10-second deadline', async (t) => {
  const { invokeNanoHostInspection } = await import('./host-observation.mjs');
  assert.equal(typeof invokeNanoHostInspection, 'function');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let captured;
  let attempts = 0;
  const pending = invokeNanoHostInspection(target, { nonce }, async (_target, request) => {
    captured = request.signal;
    attempts += 1;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(pending);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(captured.aborted, false);
  t.mock.timers.tick(9_999);
  assert.equal(captured.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(captured.aborted, true);
  assert.equal(attempts, 1);
});

for (const [name, substitution] of [
  [
    'root outcome',
    (text) => text.replace('"outcome":"observed"', '"outcome":"unavailable","outcome":"observed"'),
  ],
  ['nested PID', (text) => text.replace('"pid":123', '"pid":125,"pid":123')],
  ['escaped nonce key', (text) => text.replace('"nonce":', `"\\u006eonce":"${nonce}","nonce":`)],
]) {
  test(`refuses duplicate ${name} instead of accepting the last value`, async () => {
    const f = fixture();
    f.result.stdout = substitution(JSON.stringify(observed()));
    await assert.rejects(() => invoke(f));
    assert.equal(f.requests.length, 1);
  });
}
