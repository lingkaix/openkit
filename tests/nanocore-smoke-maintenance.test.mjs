import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { observeInitialMaintenance } from './smoke/nanocore-maintenance-observer.mjs';

const completed = {
  type: 'openkit-smoke-initial-maintenance',
  status: 'completed',
  snapshots: true,
};

test('waits for the initial owner completion rather than an unrelated child message', async () => {
  const child = new EventEmitter();
  const observation = observeInitialMaintenance(child);
  let settled = false;
  const waiting = observation.waitUntil(Date.now() + 1_000).then(() => {
    settled = true;
  });
  child.emit('message', { type: 'health-ready' });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('message', completed);
  await waiting;
  assert.equal(settled, true);
});

test('retains an actual completion that arrives before the startup waiter', async () => {
  const child = new EventEmitter();
  const observation = observeInitialMaintenance(child);
  child.emit('message', completed);
  await observation.waitUntil(Date.now() + 1_000);
});

test('refuses a failed initial maintenance pass', async () => {
  const child = new EventEmitter();
  const observation = observeInitialMaintenance(child);
  child.emit('message', { ...completed, status: 'failed' });
  await assert.rejects(observation.waitUntil(Date.now() + 1_000), /maintenance failed/);
});

test('refuses completion without automatic snapshot coverage', async () => {
  const child = new EventEmitter();
  const observation = observeInitialMaintenance(child);
  child.emit('message', { ...completed, snapshots: false });
  await assert.rejects(observation.waitUntil(Date.now() + 1_000), /maintenance failed/);
});

test('refuses an early child exit without owner completion', async () => {
  const child = new EventEmitter();
  const observation = observeInitialMaintenance(child);
  child.emit('exit', 1, null);
  await assert.rejects(observation.waitUntil(Date.now() + 1_000), /Process exited/);
});

test('cannot turn a late completion into an extra startup timeout window', async () => {
  const child = new EventEmitter();
  const observation = observeInitialMaintenance(child);
  const expired = Date.now() - 1;
  child.emit('message', completed);
  await assert.rejects(observation.waitUntil(expired), /startup deadline/);
});

test('preload leaves inherited worker execution untouched', async () => {
  const worker = new Worker(
    new URL(
      'data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.postMessage("ready");'
    ),
    {
      execArgv: [
        '--import',
        new URL('./smoke/nanocore-maintenance-preload.mjs', import.meta.url).href,
      ],
    }
  );
  let ready = false;
  try {
    await new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        ready = message === 'ready';
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Inherited worker exited with ${code}.`));
      });
    });
    assert.equal(ready, true);
  } finally {
    await worker.terminate();
  }
});
