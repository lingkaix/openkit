import assert from 'node:assert/strict';
import { test } from 'node:test';

const target = 'https://staging.example.invalid';
const machineIdentityDigest = '1'.repeat(64);
const physicalEpoch = '2'.repeat(64);
const effectiveStateDigest = '3'.repeat(64);
const bootId = '11111111-1111-4111-8111-111111111111';
const archiveAttribution = {
  archiveSha256: '4'.repeat(64),
  tag: 'v0.1.0-rc.8',
  sourceCommit: 'a'.repeat(40),
  platform: 'linux/arm64',
  payloads: {
    nanohostSha256: '5'.repeat(64),
    gatewaySha256: '6'.repeat(64),
    unitFileSha256: '7'.repeat(64),
  },
};

/** Synthetic evidence tests the consumer join; it cannot establish live measurement or host authentication. */
function fixture() {
  const stored = {
    identityId: 'configured-nanohost',
    deploymentId: 'configured-deployment',
    connectionGeneration: 8,
    physicalEpoch,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    observedAt: '2026-10-15T00:00:00Z',
  };
  const process = { bootId, pid: 123, startTimeTicks: '12345' };
  const inspection = {
    outcome: 'observed',
    machineIdentityDigest,
    physicalEpoch,
    identityId: stored.identityId,
    deploymentId: stored.deploymentId,
    connectionGeneration: 8,
    coordinator: structuredClone(process),
    executables: {
      nanohost: {
        process: structuredClone(process),
        sha256: archiveAttribution.payloads.nanohostSha256,
      },
      gateway: {
        process: { bootId, pid: 124, startTimeTicks: '12346' },
        sha256: archiveAttribution.payloads.gatewaySha256,
      },
    },
    unit: {
      fileSha256: archiveAttribution.payloads.unitFileSha256,
      effectiveStateDigest,
      activeState: 'active',
      subState: 'running',
    },
    replacementDuringMeasurement: false,
  };
  const controls = { stored: (value) => value, inspection: (value) => value };
  const events = [];
  const challenges = [];
  let storedReads = 0;
  const io = {
    call: async (operation, input) => {
      assert.equal(operation, 'nanohost.runtime-target');
      assert.deepEqual(input, {});
      events.push('stored');
      storedReads += 1;
      assert.ok(storedReads <= 2, 'one observation cannot retry its stored-read bracket');
      const value = structuredClone(stored);
      if (storedReads === 2) value.observedAt = '2026-10-15T00:00:01Z';
      return controls.stored(value, storedReads);
    },
    inspectHost: async (selected, request) => {
      assert.equal(selected, target);
      assert.deepEqual(Object.keys(request), ['nonce']);
      assert.match(request.nonce, /^[a-f0-9]{64}$/);
      events.push('inspect');
      challenges.push(request.nonce);
      assert.equal(challenges.length, 1, 'one observation cannot retry host inspection');
      return controls.inspection({ ...structuredClone(inspection), nonce: request.nonce });
    },
  };
  return {
    io,
    controls,
    events,
    challenges,
    stored,
    inspection,
    params: {
      binding: { machineIdentityDigest },
      archiveAttribution: structuredClone(archiveAttribution),
      effectiveStateDigest,
    },
  };
}

/** Loads the new seam at invocation so the first red result names the absent implementation. */
async function observe(f) {
  const { observeOperatorHost } = await import('./host-observation.mjs');
  return observeOperatorHost(target, f.params, f.io);
}

test('joins live nonce-bound payload measurements with both exact stored observations', async () => {
  const f = fixture();
  const result = await observe(f);
  assert.deepEqual(f.events, ['stored', 'inspect', 'stored']);
  assert.deepEqual(result, {
    machineIdentityDigest,
    physicalEpoch,
    archiveAttribution,
    inspection: { ...f.inspection, nonce: f.challenges[0] },
    runtimeTargetBefore: f.stored,
    runtimeTarget: { ...f.stored, observedAt: '2026-10-15T00:00:01Z' },
  });
});

test('retains separate stripped before and after snapshots when the reader reuses its object', async () => {
  const f = fixture();
  const shared = {};
  f.controls.stored = (body) => {
    Object.assign(shared, body, { annotation: 'untrusted-stored-description' });
    return shared;
  };
  const result = await observe(f);
  assert.deepEqual(result.runtimeTargetBefore, f.stored);
  assert.deepEqual(result.runtimeTarget, { ...f.stored, observedAt: '2026-10-15T00:00:01Z' });
  assert.notEqual(result.runtimeTargetBefore, result.runtimeTarget);
  assert.equal(JSON.stringify(result).includes('untrusted-stored-description'), false);
});

test('issues a different nonce for each independent attempt and refuses a replayed response', async () => {
  const first = fixture();
  await observe(first);
  const second = fixture();
  second.controls.inspection = (body) => ({ ...body, nonce: first.challenges[0] });
  await assert.rejects(() => observe(second));
  assert.notEqual(second.challenges[0], first.challenges[0]);
  assert.equal(second.challenges.length, 1);
});

for (const stage of ['before', 'after']) {
  for (const [field, invalid] of [
    ['identityId', 'another-nanohost'],
    ['deploymentId', 'another-deployment'],
    ['connectionGeneration', 9],
    ['physicalEpoch', '8'.repeat(64)],
    ['ready', false],
    ['freshEmpty', false],
    ['predecessorFenced', false],
  ]) {
    test(`refuses ${stage} stored ${field} mismatch without rejoining`, async () => {
      const f = fixture();
      f.controls.stored = (body, index) => {
        if (index === (stage === 'before' ? 1 : 2)) body[field] = invalid;
        return body;
      };
      await assert.rejects(() => observe(f));
      assert.ok(f.challenges.length <= 1);
    });
  }
}

for (const [name, change] of [
  [
    'foreign machine',
    (body) => {
      body.machineIdentityDigest = '8'.repeat(64);
    },
  ],
  [
    'foreign identity',
    (body) => {
      body.identityId = 'another-nanohost';
    },
  ],
  [
    'foreign deployment',
    (body) => {
      body.deploymentId = 'another-deployment';
    },
  ],
  [
    'stale generation',
    (body) => {
      body.connectionGeneration = 7;
    },
  ],
  [
    'different Epoch',
    (body) => {
      body.physicalEpoch = '8'.repeat(64);
    },
  ],
  [
    'wrong NanoHost executable',
    (body) => {
      body.executables.nanohost.sha256 = '8'.repeat(64);
    },
  ],
  [
    'wrong Gateway executable',
    (body) => {
      body.executables.gateway.sha256 = '8'.repeat(64);
    },
  ],
  [
    'wrong installed unit',
    (body) => {
      body.unit.fileSha256 = '8'.repeat(64);
    },
  ],
  [
    'unaccepted effective unit state',
    (body) => {
      body.unit.effectiveStateDigest = '8'.repeat(64);
    },
  ],
  [
    'inactive unit',
    (body) => {
      body.unit.activeState = 'inactive';
    },
  ],
  [
    'non-running unit',
    (body) => {
      body.unit.subState = 'exited';
    },
  ],
  [
    'replacement during measurement',
    (body) => {
      body.replacementDuringMeasurement = true;
    },
  ],
  [
    'another coordinator process',
    (body) => {
      body.coordinator.pid = 125;
    },
  ],
  [
    'reused coordinator PID with different start time',
    (body) => {
      body.coordinator.startTimeTicks = '12347';
    },
  ],
  [
    'another coordinator boot',
    (body) => {
      body.coordinator.bootId = '22222222-2222-4222-8222-222222222222';
    },
  ],
  [
    'Gateway aliases the NanoHost process',
    (body) => {
      body.executables.gateway.process = structuredClone(body.coordinator);
    },
  ],
  [
    'Gateway from another host boot',
    (body) => {
      body.executables.gateway.process.bootId = '22222222-2222-4222-8222-222222222222';
    },
  ],
]) {
  test(`refuses live ${name} without retry`, async () => {
    const f = fixture();
    f.controls.inspection = (body) => {
      change(body);
      return body;
    };
    await assert.rejects(() => observe(f));
    assert.equal(f.challenges.length, 1);
  });
}

for (const [name, change] of [
  [
    'missing nonce',
    (body) => {
      delete body.nonce;
    },
  ],
  [
    'wrong nonce',
    (body) => {
      body.nonce = '0'.repeat(64);
    },
  ],
  [
    'unknown outcome',
    (body) => {
      body.outcome = 'partial';
    },
  ],
  [
    'missing physical Epoch',
    (body) => {
      delete body.physicalEpoch;
    },
  ],
  [
    'non-hex physical Epoch',
    (body) => {
      body.physicalEpoch = 'G'.repeat(64);
    },
  ],
  [
    'zero PID',
    (body) => {
      body.coordinator.pid = 0;
      body.executables.nanohost.process.pid = 0;
    },
  ],
  [
    'fractional PID',
    (body) => {
      body.coordinator.pid = 1.5;
      body.executables.nanohost.process.pid = 1.5;
    },
  ],
  [
    'malformed boot identity',
    (body) => {
      body.coordinator.bootId = 'not-a-uuid';
      body.executables.nanohost.process.bootId = 'not-a-uuid';
    },
  ],
  [
    'noncanonical start-time ticks',
    (body) => {
      body.coordinator.startTimeTicks = '012345';
      body.executables.nanohost.process.startTimeTicks = '012345';
    },
  ],
  [
    'zero start-time ticks',
    (body) => {
      body.coordinator.startTimeTicks = '0';
      body.executables.nanohost.process.startTimeTicks = '0';
    },
  ],
  [
    'missing replacement observation',
    (body) => {
      delete body.replacementDuringMeasurement;
    },
  ],
]) {
  test(`refuses malformed live ${name}`, async () => {
    const f = fixture();
    f.controls.inspection = (body) => {
      change(body);
      return body;
    };
    await assert.rejects(() => observe(f));
    assert.equal(f.challenges.length, 1);
  });
}

for (const reason of [
  'not-running',
  'access-denied',
  'connection-unavailable',
  'process-changed',
  'measurement-unavailable',
  'unit-unavailable',
  'unsupported-reason',
]) {
  test(`unavailable inspection ${reason} stops without repair or retry`, async () => {
    const f = fixture();
    f.controls.inspection = ({ nonce }) => ({ nonce, outcome: 'unavailable', reason });
    await assert.rejects(() => observe(f));
    assert.equal(f.challenges.length, 1);
  });
}

for (const [name, change] of [
  [
    'absent Epoch',
    (body) => {
      delete body.physicalEpoch;
    },
  ],
  [
    'null Epoch',
    (body) => {
      body.physicalEpoch = null;
    },
  ],
  [
    'malformed Epoch',
    (body) => {
      body.physicalEpoch = 'not-an-epoch';
    },
  ],
  [
    'nonpositive generation',
    (body) => {
      body.connectionGeneration = 0;
    },
  ],
]) {
  test(`refuses stored ${name} instead of using a legacy fallback`, async () => {
    const f = fixture();
    f.controls.stored = (body) => {
      change(body);
      return body;
    };
    await assert.rejects(() => observe(f));
    assert.equal(f.challenges.length, 0);
  });
}

test('drops unknown descriptive annotations at every observation level', async () => {
  const f = fixture();
  const marker = 'untrusted-description-must-not-survive';
  const annotate = (value) => {
    value.annotation = { marker, token: 'Bearer syntheticunknownannotation' };
  };
  f.controls.stored = (body) => {
    annotate(body);
    return body;
  };
  f.controls.inspection = (body) => {
    for (const value of [
      body,
      body.coordinator,
      body.executables,
      body.executables.nanohost,
      body.executables.nanohost.process,
      body.executables.gateway,
      body.executables.gateway.process,
      body.unit,
    ])
      annotate(value);
    return body;
  };
  const result = await observe(f);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes('syntheticunknownannotation'), false);
  assert.equal(JSON.stringify(result).includes('annotation'), false);
  assert.deepEqual(f.events, ['stored', 'inspect', 'stored']);
});

for (const stage of ['before', 'inspection', 'after']) {
  test(`stops on ${stage} transport loss without automatic rejoin`, async () => {
    const f = fixture();
    if (stage === 'inspection')
      f.controls.inspection = () => {
        throw Error('Synthetic transport loss');
      };
    else
      f.controls.stored = (body, index) => {
        if (index === (stage === 'before' ? 1 : 2)) throw Error('Synthetic transport loss');
        return body;
      };
    await assert.rejects(() => observe(f));
    assert.ok(f.challenges.length <= 1);
  });
}
