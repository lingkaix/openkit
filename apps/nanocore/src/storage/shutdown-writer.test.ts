import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openCoreDb } from './db.js';

it('terminates the whole process when a writer is blocked in native SQLite', () => {
  const root = mkdtempSync(join(tmpdir(), 'writer-deadline-'));
  try {
    const owner = openCoreDb(root);
    try {
      owner.sqlite.exec('BEGIN IMMEDIATE');
      const worker = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const writer = new DatabaseSync(workerData);
      writer.exec('PRAGMA busy_timeout=60000');
      parentPort.postMessage('waiting');
      writer.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('unexpected writer completion');
    `;
      const run = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
      import { Worker } from 'node:worker_threads';
      import { closeWithDeadline, forceShutdownAtDeadline } from ${JSON.stringify(new URL('../bootstrap/shutdown.ts', import.meta.url).href)};
      const path = ${JSON.stringify(owner.sqlite.name)};
      const writer = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: path });
      writer.on('message', (message) => {
        if (message !== 'waiting') throw new Error(message);
        void closeWithDeadline({
          close: (callback) => writer.once('exit', callback),
          deadlineMs: 100,
          onClosed: () => { throw new Error('Unexpected clean writer exit'); },
          onDeadline: () => forceShutdownAtDeadline('SIGTERM', 0),
        });
      });
    `,
        ],
        { encoding: 'utf8', timeout: 5000 }
      );
      expect(run.error).toBeUndefined();
      expect(run.signal, run.stderr).toBe('SIGKILL');
      expect(run.stderr).toContain('deadline reached');
    } finally {
      owner.sqlite.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
