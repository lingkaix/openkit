// openkit-test-platform: posix
// Independent bounded #616 oracle. UNRUN; no singleton reset or production mocks.
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser, getLocalUserId } from '../auth/identity.js';
import { createTestCoreDb } from '../test-support/store.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, getCoreDb } from './db.js';
import { coreDbPath } from './fs-layout.js';

let namespace: string | undefined;
let namespaceIdentity: { dev: number; ino: number } | undefined;
let passed = false;
let cleanupComplete = false;
let cleanupCurrent: (() => Promise<void>) | undefined;

function ownedSibling(): string {
  const privateRoot = tmpdir();
  const parent = dirname(privateRoot);
  const uid = process.getuid?.();
  const prepared = lstatSync(privateRoot);
  const enclosing = lstatSync(parent);
  if (
    uid === undefined ||
    !basename(privateRoot).startsWith('openkit-vitest-') ||
    realpathSync(privateRoot) !== privateRoot ||
    realpathSync(parent) !== parent ||
    !prepared.isDirectory() ||
    prepared.isSymbolicLink() ||
    prepared.uid !== uid ||
    !enclosing.isDirectory() ||
    enclosing.isSymbolicLink() ||
    prepared.dev !== enclosing.dev
  )
    throw new Error('UNKNOWN: prepared private-root sibling premise is unavailable');
  // Publish before validation or any producer; never delete an unverified namespace.
  namespace = mkdtempSync(join(parent, 'core-default-reader-'));
  const made = lstatSync(namespace);
  if (
    !made.isDirectory() ||
    made.isSymbolicLink() ||
    made.uid !== uid ||
    (made.mode & 0o7777) !== 0o700 ||
    made.dev !== enclosing.dev
  )
    throw new Error('UNKNOWN: owned sibling identity is unverified');
  namespaceIdentity = { dev: made.dev, ino: made.ino };
  return namespace;
}

afterEach(async () => {
  await cleanupCurrent?.();
});
afterAll(() => {
  if (!namespace) return;
  const current = lstatSync(namespace);
  if (
    passed &&
    cleanupComplete &&
    namespaceIdentity &&
    current.dev === namespaceIdentity.dev &&
    current.ino === namespaceIdentity.ino &&
    !current.isSymbolicLink()
  )
    rmSync(namespace, { recursive: true, force: true });
  else
    console.log(
      'Retain Core fixture AND enclosing runtime/filesystem on failure/UNKNOWN:',
      namespace
    );
});

describe('Public default Core reader', () => {
  it('observes native-acknowledged Core history readonly, query-only and with a 5ms busy bound', async () => {
    let stopped = false;
    let producer: CoreDb | undefined;
    let reader: CoreDb | undefined;
    let originalIdentity: Promise<string> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const errors: unknown[] = [];
    let observed: unknown;
    const active = () => {
      if (stopped) throw new Error('UNKNOWN: original setup crossed teardown');
    };
    const cleanup = () => {
      stopped = true;
      cleanupPromise ??= (async () => {
        // An original never-settling producer is UNKNOWN, never cancelled or bypassed.
        if (originalIdentity) {
          try {
            await originalIdentity;
          } catch (error) {
            errors.push(error);
          }
        }
        const dispose = async (call: () => unknown) => {
          try {
            await call();
          } catch (error) {
            errors.push(error);
          }
        };
        await dispose(() => {
          if (reader && namespace && reader.dataRoot === namespace && reader.sqlite.open)
            reader.sqlite.close();
        });
        await dispose(() => closeWorkspaceProductReadHandles(namespace));
        await dispose(() => shutdownControlStoreWorkerClient());
        await dispose(() => {
          if (producer?.sqlite.open) producer.sqlite.close();
        });
        cleanupComplete = true;
      })();
      return cleanupPromise;
    };
    cleanupCurrent = cleanup;
    try {
      const root = ownedSibling();
      active();
      producer = createTestCoreDb(root);
      // Real production local-identity operation: opens the native Core owner and
      // awaits its original durable ACK. No SQL identity/ledger fixture or fake reply.
      originalIdentity = ensureLocalUser(producer);
      const ownerId = await originalIdentity;
      active();
      const env: NodeJS.ProcessEnv = { OPENKIT_DATA_ROOT: root };
      reader = getCoreDb(env); // ORIGINAL public singleton entry; exactly one case.
      expect(reader.dataRoot, 'A pre-existing foreign singleton is a fixture failure').toBe(root);
      expect(reader.sqlite.name).toBe(coreDbPath(root));
      const retainedOwnerId = getLocalUserId(reader);
      expect(
        retainedOwnerId,
        'Legitimate Core observation of the actual native-produced User'
      ).toBe(ownerId);
      observed = {
        readonly: reader.sqlite.readonly,
        queryOnly: reader.sqlite.pragma('query_only', { simple: true }),
        busyTimeout: reader.sqlite.pragma('busy_timeout', { simple: true }),
        retainedOwnerId,
      };
      expect(observed).toEqual({
        readonly: true,
        queryOnly: 1,
        busyTimeout: 5,
        retainedOwnerId: ownerId,
      });
    } catch (error) {
      errors.push(error);
    } finally {
      await cleanup();
      console.log('Default Core reader original facts', { namespace, observed, errors });
    }
    if (errors.length)
      throw new AggregateError(errors, 'Original public Core reader policy/fixture failure');
    passed = true;
  });
});
