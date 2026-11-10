// openkit-test-platform: posix
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const preload = fileURLToPath(new URL('../test-support/load-native-observer.cjs', import.meta.url));
const observerEnv = (root: string) => ({
  TMPDIR: tmpdir(),
  R2_CLOSE_CHANNEL: `load-open-${randomUUID()}`,
  OPENKIT_R2_ATTR_OUTPUT_DIR: root,
});
const routes = [
  {
    route: 'compiled',
    client: '../../dist/storage/control-store-worker-client.js',
    entry: join(appRoot, 'dist', 'storage', 'control-store-worker.bundle.mjs'),
  },
  {
    route: 'temporary',
    client: './control-store-worker-client.ts',
    entry: join(tmpdir(), 'nanocore-worker', 'dist', 'storage', 'control-store-worker.mjs'),
  },
  {
    route: 'typescript-eval',
    client: './control-store-worker-client.ts',
    entry: fileURLToPath(new URL('./control-store-worker.ts', import.meta.url)),
  },
] as const;

// Run a real ESM import before any owner imports. Join the native report before
// closing the worker so an exit-only observer cannot supply the evidence.
const calibration = `
  import { deepEqual, equal, throws } from 'node:assert/strict';
  import { mkdirSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { BroadcastChannel } from 'node:worker_threads';
  import Database from 'better-sqlite3';

  const [clientUrl, root] = process.argv.slice(2);
  const workspace = join(root, 'workspace.sqlite');
  new Database(workspace).close();
  new Database(workspace, { readonly: true, fileMustExist: true }).close();
  mkdirSync(join(root, 'missing'));
  throws(() => new Database(join(root, 'missing', 'workspace.sqlite'), {
    readonly: true, fileMustExist: true,
  }), { code: 'SQLITE_CANTOPEN' });

  if (clientUrl.endsWith('.ts')) (await import('tsx/esm/api')).register();
  const native = await import(clientUrl);
  const client = native.getControlStoreWorkerClient();
  const channel = new BroadcastChannel(process.env.R2_CLOSE_CHANNEL);
  const waitFor = (kind, request) => new Promise((resolve) => {
    channel.onmessage = ({ data }) => {
      if (data?.kind === kind) resolve(data);
    };
    channel.postMessage(request);
  });
  let result;
  try {
    await client.open({
      database: 'calibration', path: join(root, 'user.sqlite'), create: true, initialize: 'user',
    });
    const ready = await waitFor('ready', { kind: 'window', lower: 0, upper: Number.MAX_SAFE_INTEGER });
    const finished = await waitFor('finished', { kind: 'finish' });
    equal(finished.threadId, ready.threadId);
    const report = JSON.parse(readFileSync(
      join(root, 'native-observation-thread' + finished.threadId + '.json'), 'utf8'
    ));
    equal(report.threadId, finished.threadId);
    equal(report.observerErrors, 0);
    deepEqual(report.openObservation, finished.openObservation);
    result = {
      main: globalThis.__lopsOpen?.snapshot() ?? null,
      native: report.openObservation ?? null,
    };
    await client.close('calibration');
  } finally {
    channel.close();
    await native.shutdownControlStoreWorkerClient();
  }
  process.stdout.write(JSON.stringify(result));
`;

it.each(routes)(
  'reports ESM SQLite opens and the real $route Worker entry before shutdown',
  async ({ route, client, entry }) => {
    const root = mkdtempSync(join(tmpdir(), 'load-open-observer-'));
    try {
      const script = join(root, 'calibrate.mjs');
      symlinkSync(join(appRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
      writeFileSync(script, calibration);
      const sha256 = createHash('sha256').update(readFileSync(entry)).digest('hex');
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--require', preload, script, new URL(client, import.meta.url).href, root],
        {
          cwd: appRoot,
          env: {
            ...observerEnv(root),
            ...(route === 'temporary' && { VITEST: 'true' }),
          },
          timeout: 20_000,
        }
      );
      const observation = JSON.parse(stdout);
      expect(observation.main).toMatchObject({
        entry: null,
        observerErrors: 0,
        groups: {
          'writable/workspace.sqlite': { count: 1, success: 1, errors: 0 },
          'readonly/workspace.sqlite': { count: 2, success: 1, errors: 1 },
        },
      });
      expect(observation.native).toMatchObject({
        entry: { route, sha256 },
        observerErrors: 0,
        groups: { 'writable/user.sqlite': { success: 1, errors: 0 } },
      });
      for (const group of [
        observation.main.groups['writable/workspace.sqlite'],
        observation.main.groups['readonly/workspace.sqlite'],
        observation.native.groups['writable/user.sqlite'],
      ]) {
        expect(Number.isFinite(group.maxMs) && group.maxMs >= 0).toBe(true);
        expect(Number.isFinite(group.sumMs) && group.sumMs >= group.maxMs).toBe(true);
      }
      expect(stdout).not.toContain(root);
      expect(stdout).not.toContain(appRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

it('reports late constructor observation as missing after the unobserved driver was loaded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'load-open-observer-late-'));
  try {
    const driver = createRequire(import.meta.url).resolve('better-sqlite3');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--require',
        driver,
        '--require',
        preload,
        '--eval',
        `import('better-sqlite3').then(({ default: Database }) => {
          new Database(':memory:').close();
          process.stdout.write(JSON.stringify(globalThis.__lopsOpen.snapshot()));
        });`,
      ],
      { cwd: appRoot, env: observerEnv(root), timeout: 20_000 }
    );
    // A genuine successful open is invisible once the original export was cached.
    // An empty group set with an observation error cannot serve as a zero-count claim.
    expect(JSON.parse(stdout)).toEqual({ entry: null, groups: {}, observerErrors: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
