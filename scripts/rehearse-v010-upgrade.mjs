import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  compareFamilies,
  EXTERNAL_FAMILIES,
  retainedFamilies,
  summarizeFamilies,
} from './upgrade-from-previous.mjs';
import { readFileCorpus, seedFileCorpus } from './upgrade-from-previous-corpus.mjs';
import { readSqlCorpus, seedSqlCorpus } from './upgrade-from-previous-sql-corpus.mjs';

export const REHEARSAL_MIGRATION_SQL =
  'CREATE TABLE `openkit_rehearsal_probe` (`id` integer PRIMARY KEY NOT NULL);\n';
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const REGISTER = new URL('../docs/specs/20261017-retained_format_register.md', import.meta.url);
const STORAGE_REPORT = 'storage-result.json';
const WORKER_REPORT = 'worker-result.json';
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Admits exactly one known additive Core migration and identical predecessor SQL. */
export function inspectRehearsalMigration(previous, candidate) {
  let extra;
  for (const scope of ['core', 'user', 'workspace', 'app']) {
    const folder = (root) => join(root, 'drizzle', scope);
    const journal = (root) => readJson(join(folder(root), 'meta', '_journal.json'));
    const { entries: before, ...oldHeader } = journal(previous);
    const { entries: after, ...newHeader } = journal(candidate);
    assert.deepEqual(newHeader, oldHeader, `${scope}: journal header changed.`);
    assert(Array.isArray(before) && before.length > 0 && Array.isArray(after));
    assert.equal(after.length, before.length + (scope === 'core' ? 1 : 0));
    assert.deepEqual(after.slice(0, before.length), before, `${scope}: old ledger changed.`);
    for (const { tag } of before) {
      assert.match(tag, /^[0-9]+_[a-z0-9_]+$/, 'Unsafe migration name.');
      assert(
        readFileSync(join(folder(previous), `${tag}.sql`)).equals(
          readFileSync(join(folder(candidate), `${tag}.sql`))
        ),
        `${scope}: old SQL changed.`
      );
    }
    if (scope !== 'core') continue;
    const last = before.at(-1);
    extra = after.at(-1);
    assert.match(extra.tag, /^[0-9]+_g5_rehearsal_probe$/);
    assert.equal(extra.idx, last.idx + 1);
    assert(Number.isSafeInteger(extra.when) && extra.when > last.when);
    assert.equal(
      readFileSync(join(folder(candidate), `${extra.tag}.sql`), 'utf8'),
      REHEARSAL_MIGRATION_SQL
    );
  }
  return { tag: extra.tag, when: extra.when, hash: digest(REHEARSAL_MIGRATION_SQL) };
}

/** Opens only exact compiled owners; the rehearsal never changes either build. */
async function buildOwners(build, tag) {
  const appRoot = resolve(build.appRoot);
  const load = (name) => import(pathToFileURL(join(appRoot, 'dist', `${name}.js`)).href);
  const { readReleaseIdentity } = await load('diagnostics/release-identity');
  const identity = readReleaseIdentity(resolve(build.identityFile));
  assert.match(identity.releaseTag ?? '', tag, 'Wrong release build.');
  assert.match(identity.sourceCommit ?? '', SHA, 'Missing build source identity.');
  return {
    appRoot,
    identity,
    backup: await load('storage/data-root-backup'),
    db: await load('storage/db'),
    migrate: await load('storage/migrate'),
    layout: await load('storage/fs-layout'),
    auth: await load('auth/identity'),
    protocol: await import(
      pathToFileURL(createRequire(join(appRoot, 'package.json')).resolve('@openkit/protocol')).href
    ),
    worker: await load('storage/control-store-worker-client'),
    BootConfigError: (await load('config/mode')).BootConfigError,
  };
}

const writeReceipt = (root, name, value, flag = 'wx') =>
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o600 });

// The product's journal lookup tries cwd before the compiled module's directory.
async function inBuild(owner, work) {
  const cwd = process.cwd();
  process.chdir(owner.appRoot);
  try {
    return await work();
  } finally {
    process.chdir(cwd);
  }
}

function migrateAndReadCore(owner, dataRoot, apply) {
  const coreDb = owner.db.openExistingCoreDbWithIntegrityCheck(dataRoot);
  try {
    if (apply) owner.migrate.applyMigrations(coreDb);
    return coreDb.sqlite
      .prepare('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id')
      .all();
  } finally {
    coreDb.sqlite.close();
  }
}

function capture(owner, dataRoot, backupRoot) {
  const { backup, layout } = owner;
  const { deploymentId: sourceDeploymentId } = layout.readDataRootLayoutMarker(dataRoot);
  assert(
    !existsSync(join(dataRoot, 'server', 'runtime', 'nanocore.lock')),
    'Data Root is running.'
  );
  const source = backup.inventoryRegularFiles(dataRoot);
  backup.assertExternalColdBackupDestination(dataRoot, backupRoot);
  const startedAt = new Date().toISOString();
  backup.copyColdDataRoot({ dataRoot, backupRoot });
  const { manifest } = backup.writeColdDataRootBackupManifest({
    backupRoot,
    backupId: owner.protocol.allocateEntityId('drb'),
    sourceDeploymentId,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  const verified = backup.verifyDataRootBackupManifest({ backupRoot });
  backup.assertBackupMatchesPredecessor(verified, source);
  assert.deepEqual(verified.manifest, manifest);
  return {
    checkedFiles: verified.checkedFiles.length,
    manifestSha256: digest(JSON.stringify(manifest)),
  };
}

function tree(owner, root) {
  const identity = (path) => {
    const { dev, ino, mode } = statSync(path);
    return { dev, ino, mode };
  };
  return {
    root: identity(root),
    files: owner.backup.inventoryRegularFiles(root).map((entry) => ({
      ...entry,
      ...identity(join(root, entry.path)),
    })),
  };
}

async function g1(previous, candidate, dataRoot, ledger) {
  const before = tree(previous, dataRoot);
  const corePath = 'server/db/core.sqlite';
  const wal = `${corePath}-wal`;
  const shm = `${corePath}-shm`;
  assert(
    !before.files.some(({ path }) => path === wal || path === shm),
    'Core must start stopped.'
  );
  await assert.rejects(
    inBuild(previous, () => migrateAndReadCore(previous, dataRoot, false)),
    (error) =>
      error instanceof previous.BootConfigError && error.code === 'migration_unsupported_core'
  );
  const after = tree(previous, dataRoot);
  const residue = after.files.filter(({ path }) => path === wal || path === shm);
  assert.deepEqual(
    { ...after, files: after.files.filter(({ path }) => path !== wal && path !== shm) },
    before,
    'Refused old open changed original files.'
  );
  assert(!residue.some(({ path, bytes }) => path === wal && bytes !== 0));
  assert.deepEqual(
    await inBuild(candidate, () => migrateAndReadCore(candidate, dataRoot, false)),
    ledger
  );
  assert.deepEqual(
    tree(candidate, dataRoot),
    before,
    'Supported reopen left residue or changed data.'
  );
  return {
    code: 'migration_unsupported_core',
    residue: residue.map(({ path, bytes }) => ({ path, bytes })),
  };
}

async function g2(previous, dataRoot, futureBackup) {
  const destination = tree(previous, dataRoot);
  const backup = tree(previous, futureBackup);
  await assert.rejects(
    inBuild(previous, () =>
      previous.backup.restoreDataRootBackup({ backupRoot: futureBackup, dataRoot })
    ),
    (error) =>
      error instanceof previous.BootConfigError && error.code === 'migration_unsupported_core'
  );
  assert.deepEqual(
    tree(previous, dataRoot),
    destination,
    'Future restore changed its destination.'
  );
  assert.deepEqual(tree(previous, futureBackup), backup, 'Future restore changed its backup.');
  return { code: 'migration_unsupported_core', destinationUnchanged: true, backupUnchanged: true };
}

/** Seeds and upgrades an owned stopped fixture. Reports no live Worker acceptance. */
export async function rehearseStorage(input) {
  const root = resolve(input.output);
  const previous = await buildOwners(input.previous, /^v0\.1\.0(?:-rc\.[1-9][0-9]*)?$/);
  const candidate = await buildOwners(input.candidate, /^v0\.1\.1$/);
  assert.notEqual(previous.identity.sourceCommit, candidate.identity.sourceCommit);
  assert.match(
    input.previous.workerPlatformImage,
    SHA256,
    'An exact old Worker platform digest is required.'
  );
  const migration = inspectRehearsalMigration(previous.appRoot, candidate.appRoot);
  mkdirSync(root, { mode: 0o700 });
  const report = {
    status: 'failed',
    phase: 'seed',
    previous: previous.identity,
    candidate: candidate.identity,
    oldWorkerPlatformImage: input.previous.workerPlatformImage,
    migration,
  };
  try {
    const dataRoot = join(root, 'data');
    const retainedRoot = join(root, 'corpus');
    const oldBackup = join(root, 'v010-backup');
    const futureBackup = join(root, 'v011-backup');
    const destination = join(root, 'restore-target');
    const { sources, selectors } = await inBuild(previous, async () => {
      const coreDb = previous.db.openCoreDb(dataRoot);
      let userId;
      try {
        previous.migrate.applyMigrations(coreDb);
        userId = await previous.auth.ensureLocalUser(coreDb);
      } finally {
        await previous.worker.shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
      }
      const sources = {
        appRoot: previous.appRoot,
        dataRoot,
        retainedRoot,
        userId,
        corpusProducer: 'current',
      };
      const selectors = await seedFileCorpus(sources);
      Object.assign(selectors, await seedSqlCorpus({ ...sources, selectors }));
      return { sources, selectors };
    });
    const families = retainedFamilies(readFileSync(REGISTER, 'utf8')).filter(
      (family) => !EXTERNAL_FAMILIES.includes(family)
    );
    const collect = (owner) =>
      inBuild(owner, async () => {
        try {
          const context = { ...sources, appRoot: owner.appRoot, selectors };
          return { ...(await readFileCorpus(context)), ...(await readSqlCorpus(context)) };
        } finally {
          await owner.worker.shutdownControlStoreWorkerClient();
        }
      });
    const baseline = summarizeFamilies(await collect(previous), families);
    report.phase = 'verified-backup';
    report.backup = await inBuild(previous, () => capture(previous, dataRoot, oldBackup));
    // A supported restore establishes the exact old destination for the future-backup control.
    await inBuild(previous, () =>
      previous.backup.restoreDataRootBackup({ backupRoot: oldBackup, dataRoot: destination })
    );

    report.phase = 'upgrade';
    const oldLedger = await inBuild(previous, () => migrateAndReadCore(previous, dataRoot, false));
    const newLedger = await inBuild(candidate, () => migrateAndReadCore(candidate, dataRoot, true));
    assert.deepEqual(newLedger.slice(0, -1), oldLedger, 'Old ledger entries changed.');
    assert.equal(newLedger.length, oldLedger.length + 1, 'The migration must append exactly once.');
    assert.equal(newLedger.at(-1).created_at, migration.when);
    assert.equal(newLedger.at(-1).hash, migration.hash);
    compareFamilies(baseline, await collect(candidate), families);
    report.preservedFamilies = families.length;

    report.phase = 'reopen';
    assert.deepEqual(
      await inBuild(candidate, () => migrateAndReadCore(candidate, dataRoot, true)),
      newLedger
    );
    compareFamilies(baseline, await collect(candidate), families);
    report.reopenIdempotent = true;

    report.phase = 'old-open';
    report.oldOpen = await g1(previous, candidate, dataRoot, newLedger);

    report.phase = 'future-restore';
    report.futureBackup = await inBuild(candidate, () =>
      capture(candidate, dataRoot, futureBackup)
    );
    report.futureRestore = await g2(previous, destination, futureBackup);

    report.phase = 'storage-complete';
    report.status = 'awaiting-worker';
    return report;
  } finally {
    writeReceipt(root, STORAGE_REPORT, report);
  }
}

/** Makes one old-image preparation attempt and requires the specific pre-activation refusal. */
export async function checkOldWorker({ request, candidate, imageDigest, worker }) {
  assert.match(imageDigest, SHA256);
  const call = async (name, input, status = 200) => {
    const observed = await request(name, input);
    assert.equal(observed.status, status, `${name}: unexpected status.`);
    return observed.body;
  };
  const diagnostics = await call('diagnostics.app', {});
  assert.deepEqual(diagnostics.build, candidate, 'Wrong running App build.');
  assert.equal(diagnostics.boot.acceptingProductWork, true);
  const runtime = await call('nanohost.runtime-target', {});
  assert(
    runtime.ready &&
      runtime.freshEmpty &&
      runtime.predecessorFenced &&
      runtime.connectionGeneration > 0
  );
  for (const key of ['identityId', 'deploymentId']) {
    assert(
      worker.expectedRuntime[key] && runtime[key] === worker.expectedRuntime[key],
      'Wrong NanoHost binding.'
    );
  }
  const assertIdle = async () => {
    const state = await call('app-update.preflight', {});
    assert(state.state === 'idle' && Object.values(state.counts).every((count) => count === 0));
  };
  await assertIdle();
  const readFile = () => call('runtime.file-read', { id: worker.agentFileId });
  const before = await readFile();
  assert.match(before.file.revision, SHA256);
  const refusal = await call(
    'worker-environment.prepare',
    {
      requestId: randomUUID(),
      administrationThreadId: worker.administrationThreadId,
      target: { kind: 'agent', agentId: worker.agentId },
      configuration: { fileId: worker.agentFileId, expectedRevision: before.file.revision },
      declaration: { kind: 'reference', ref: imageDigest, pullPolicy: 'never' },
      replaceNow: null,
    },
    409
  );
  assert.equal(refusal.code, 'worker_release_incompatible');
  const after = await readFile();
  assert.deepEqual(after.file, before.file, 'Old Worker preparation changed the authored file.');
  await assertIdle();
  return {
    code: refusal.code,
    status: 409,
    stage: 'image-admission',
    configurationUnchanged: true,
  };
}

/** Only runs in the explicitly prepared disposable guest namespace. */
async function rehearseWorker(input) {
  assert.notEqual(readlinkSync('/proc/self/ns/net'), readlinkSync('/proc/1/ns/net'));
  const root = resolve(input.output);
  const receipt = readJson(join(root, STORAGE_REPORT));
  assert.equal(receipt.status, 'awaiting-worker');
  assert.equal(receipt.oldWorkerPlatformImage, input.previous.workerPlatformImage);
  const candidate = await buildOwners(input.candidate, /^v0\.1\.1$/);
  assert.deepEqual(receipt.candidate, candidate.identity, 'Storage and Worker builds differ.');
  const origin = new URL(input.worker.origin);
  assert(
    ['http:', 'https:'].includes(origin.protocol) &&
      ['127.0.0.1', '[::1]'].includes(origin.hostname) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash,
    'A private loopback App origin is required.'
  );
  const report = { status: 'in-progress-no-replay', candidate: receipt.candidate };
  writeReceipt(root, WORKER_REPORT, report);
  const token = process.env.OPENKIT_UPGRADE_ADMIN_TOKEN;
  try {
    report.refusal = await checkOldWorker({
      candidate: receipt.candidate,
      imageDigest: receipt.oldWorkerPlatformImage,
      worker: input.worker,
      request: async (name, body) => {
        const response = await fetch(new URL(`/api/app/operations/${name}`, origin), {
          method: 'POST',
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'content-type': 'application/json',
            origin: origin.origin,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(name === 'worker-environment.prepare' ? 360_000 : 10_000),
          redirect: 'error',
        });
        return { status: response.status, body: await response.json() };
      },
    });
    report.status = 'qualified';
    return report;
  } catch (error) {
    report.status = 'failed-no-replay';
    throw error;
  } finally {
    writeReceipt(root, WORKER_REPORT, report, 'w');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [phase, path, ...extra] = process.argv.slice(2);
    assert(path && extra.length === 0 && ['storage', 'worker'].includes(phase));
    const input = readJson(path);
    const result = phase === 'storage' ? await rehearseStorage(input) : await rehearseWorker(input);
    console.log(JSON.stringify(result));
  } catch {
    // Owner failures can contain private paths; never print their raw messages.
    console.error(
      JSON.stringify({ status: 'failed', code: 'upgrade_rehearsal_refused_or_unproved' })
    );
    process.exitCode = 1;
  }
}
