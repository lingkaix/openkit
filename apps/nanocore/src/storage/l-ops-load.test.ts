/** Test-only real-tuple r2 reference, isolation and single-Turn load. No live Root or model. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { allocateEntityId } from '@openkit/protocol';
import { it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createMeasurementEffectFixture } from '../test-support/load-effect.fixture.js';
import {
  diagnosticContext,
  diagnosticError,
  diagnosticStage,
  observeNative,
} from '../test-support/load-observe.js';
import {
  account,
  type CloseProfile,
  classifyOutcomeError,
  isoTenTurnCriteria,
  LOAD_PROFILES,
  type Outcome,
  schedule,
  topology,
} from '../test-support/load-plan.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { readImmutableProductJson } from './immutable-content.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const B = process.env.OPENKIT_R2_ATTR_OUTPUT_DIR!,
  selected = process.env.R2_LOAD_PROFILE;
const named = selected ? LOAD_PROFILES[selected as keyof typeof LOAD_PROFILES] : undefined;
if (selected && !named) throw Error('Unknown named load profile');
const PROFILE = (named?.profile ?? process.env.R2_CLOSE_PROFILE ?? 'reference') as CloseProfile;
const N = named?.workspaces ?? Number(process.env.LOPS_R2_WORKSPACES ?? 1),
  CONTROL = process.env.R2_CLOSE_CONTROL === 'true';
if (named && process.env.LOPS_R2_WORKSPACES && Number(process.env.LOPS_R2_WORKSPACES) !== N)
  throw Error('Named profile Workspace count differs from caller');
const WARM = CONTROL ? 2000 : 20000,
  WINDOW = CONTROL ? 8000 : 300000,
  RATE = Number(process.env.R2_CLOSE_RATE ?? 202);
const ISO = PROFILE === 'iso' || PROFILE === 'ISO-10T',
  HOT_RATE = CONTROL ? 40 : 400;
const DIAGNOSTIC_ONLY = CONTROL || PROFILE === 'ISO-10T';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function demand(v: unknown, why: string): asserts v {
  if (!v) throw Error(why);
}
function stats(v: number[]) {
  const a = v.slice().sort((x, y) => x - y);
  const q = (p: number) =>
    a.length ? a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;
  return { count: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a.at(-1) ?? null };
}
function scopes(db: ReturnType<typeof openWorkspaceDb>) {
  return Object.fromEntries(
    [
      'capability_calls',
      'permission_decisions',
      'usage_records',
      'audit_events',
      'control_product_entries',
      'control_turns',
    ].map((table) => {
      const rows = db.sqlite
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((x) => JSON.stringify(x))
        .sort();
      return [table, { rows: rows.length, sha256: hash(rows) }];
    })
  );
}
function write(file: string, value: unknown) {
  const fd = fs.openSync(join(B, file), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
it.skipIf(!process.env.OPENKIT_R2_ATTR_OUTPUT_DIR)(
  'r2 envelope uses wall-clock offers, real owners, exact receipts and FULL acknowledgements',
  async () => {
    demand(
      CONTROL || (RATE === 202 && WARM === 20000 && WINDOW === 300000),
      'Measured profile rate/window differs from frozen authority'
    );
    const output = `${N}ws-observer-on.json`;
    demand(!fs.existsSync(join(B, output)), 'Consumed cell refuses overwrite');
    const root = fs.mkdtempSync(join(B, 'product-data-')),
      coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const userId = await ensureLocalUser(coreDb),
      store = new FsStore({ dataRoot: root });
    const workspaces: Array<{ workspace: { id: string }; db: ReturnType<typeof openWorkspaceDb> }> =
        [],
      actors: Array<Array<{ workspaceId: string; threadId: string; turnId: string }>> = [];
    const receipts: any[] = [],
      pending = new Set<Promise<void>>();
    const rows: any[] = schedule(PROFILE, N, RATE, WARM, WINDOW, HOT_RATE).map((s) => ({
      ...s,
      status: 'scheduled',
    }));
    let fixture: Awaited<ReturnType<typeof createMeasurementEffectFixture>> | undefined,
      fixtureClosed = false,
      clientClosed = false;
    let observation: Awaited<ReturnType<typeof observeNative>> | undefined,
      observerClosed = false;
    const result: any = {
      targetCommit: process.env.R2_CLOSE_TARGET_COMMIT ?? 'UNPINNED',
      profile: PROFILE,
      namedProfile: selected ?? null,
      controlsOnly: CONTROL,
      workspaces: N,
      privateDataRoot: root,
      warmupMs: WARM,
      windowMs: WINDOW,
      settlementMs: 30000,
      referenceRateParameter: RATE,
      thresholdsUnchanged: true,
      qualification: false,
    };
    const loop = monitorEventLoopDelay({ resolution: 1 });
    let start = 0,
      measure = Infinity,
      stop = Infinity;
    try {
      for (let w = 0; w < N; w++) {
        const workspace = await store.createWorkspace(`r2 envelope ${PROFILE} ${w}`);
        await recordWorkspaceOwnerMembership({
          coreDb,
          workspaceId: workspace.id,
          ownerUserId: userId,
        });
        const db = openWorkspaceDb(root, workspace.id);
        applyScopedMigrations(db);
        demand(db.sqlite.pragma('synchronous', { simple: true }) === 2, 'Scoped owner is not FULL');
        workspaces.push({ workspace, db });
      }
      if (PROFILE !== 'one')
        fixture = await createMeasurementEffectFixture({
          dataRoot: root,
          coreDb,
          store,
          userId,
          workspaces,
          effectTurnsPerWorkspace: Array.from(
            { length: N },
            (_, w) => topology(PROFILE, N, w).effects
          ),
        });
      for (let w = 0; w < N; w++) {
        const list = [];
        for (let j = 0; j < topology(PROFILE, N, w).native; j++) {
          const thread = await store.createThread(workspaces[w]!.workspace.id, `progress ${j}`);
          const turn = await store.createTurn(
            workspaces[w]!.workspace.id,
            thread.id,
            'native progress',
            { kind: 'user', id: userId }
          );
          list.push({
            workspaceId: workspaces[w]!.workspace.id,
            threadId: thread.id,
            turnId: turn.id,
          });
        }
        if (fixture)
          list.push(...fixture.turns.filter((t) => t.workspaceId === workspaces[w]!.workspace.id));
        actors.push(list);
      }
      result.turns = actors;
      result.topology = actors.map((a, w) => ({
        workspace: w,
        ...topology(PROFILE, N, w, HOT_RATE),
        actualTurns: a.length,
      }));
      result.scheduledPlanSha256 = hash(rows);
      result.expectedWindow = account(rows, WARM, WINDOW, N);
      // COORD00:31: qualification uses original producers; private attribution is not installed.
      result.privateClientAttribution = false;
      result.diagnosticOnly = DIAGNOSTIC_ONLY;
      result.notQualification = DIAGNOSTIC_ONLY;
      start = performance.now();
      measure = start + WARM;
      stop = measure + WINDOW;
      const lower = Number(process.hrtime.bigint()) / 1000 + (measure - performance.now()) * 1000;
      observation = await observeNative(lower, lower + WINDOW * 1000);
      const sql = (globalThis as any).__lopsSql;
      demand(sql, 'Main SQL observer missing');
      sql.windowStart = measure;
      sql.windowEnd = stop;
      setTimeout(() => loop.enable(), Math.max(0, measure - performance.now()));
      function launch(row: Outcome & Record<string, any>) {
        row.issuedMs = performance.now() - start;
        const actor = actors[row.workspace]![row.actor]!;
        row.turnId = actor.turnId;
        const stamp = new Date().toISOString();
        let call: Promise<any>;
        try {
          call = diagnosticContext.run(row, () => {
            diagnosticStage(row.effect ? 'call' : 'producer entry');
            return row.effect
              ? fixture!.call(actor.turnId, row.ordinal)
              : store.createItem({
                  id: allocateEntityId('it'),
                  owner: { kind: 'workspace', workspaceId: actor.workspaceId },
                  threadId: actor.threadId,
                  turnId: actor.turnId,
                  type: 'status',
                  level: 'info',
                  title: 'native progress',
                  status: 'completed',
                  createdAt: stamp,
                  completedAt: stamp,
                  summary: `Progress ${row.ordinal} ${'x'.repeat(256)}`,
                } as any);
          });
        } catch (e) {
          call = Promise.reject(e);
        }
        const operation = call
          .then((value) => {
            row.status = 'acked';
            row.ackMs = performance.now() - start;
            receipts.push(
              row.effect
                ? { effect: true, actor, witness: value }
                : { effect: false, actor, item: value }
            );
          })
          .catch((e: any) => {
            row.error = diagnosticError(e);
            row.errorMs = performance.now() - start;
            row.failingStage = row.effect
              ? row.fixtureStage === 'call'
                ? (row.productFailingStage ?? 'call')
                : (row.fixtureStage ?? row.stage)
              : row.stage;
            Object.assign(row, classifyOutcomeError(e));
          })
          .finally(() => pending.delete(operation));
        pending.add(operation);
      }
      for (let i = 0; i < rows.length; ) {
        const due = rows[i]!.dueMs;
        await sleep(Math.max(0, start + due - performance.now()));
        if (performance.now() >= stop) break;
        do {
          launch(rows[i++]!);
        } while (i < rows.length && Math.abs(rows[i]!.dueMs - due) < 1e-7);
      }
      await sleep(Math.max(0, stop - performance.now()));
      loop.disable();
      result.mainLoop = {
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
        samples: loop.count,
      };
      result.settled = await Promise.race([
        Promise.allSettled([...pending]).then(() => true),
        sleep(30000).then(() => false),
      ]);
      result.accounting = account(rows, WARM, WINDOW, N);
      if (PROFILE === 'ISO-10T')
        result.iso10TCriteria = isoTenTurnCriteria(rows, result.settled, WARM, WINDOW);
      write('diag-cutoff.json', { privateClientAttribution: false });
      if (fixture) {
        const phases = fixture
          .phaseMetrics()
          .filter((x) => x.startedAt >= measure && x.startedAt < stop);
        result.awaitedToolsList = {
          window: stats(phases.map((x) => x.elapsedMs)),
          cold: stats(phases.filter((x) => x.cold === true).map((x) => x.elapsedMs)),
          warm: stats(phases.filter((x) => x.cold === false).map((x) => x.elapsedMs)),
        };
      }
      result.mainSql = {
        busyCount: sql.busy.length,
        errors: sql.errors,
        coverage: sql.coverage,
        begin: stats(sql.begin),
      };
      result.clientQueue = await observation.finish();
      observerClosed = true;
      write(`${N}ws-observer-on-offers.json`, rows);
      demand(result.settled && pending.size === 0, 'Bounded drain left outstanding work');
      const witnesses = receipts.filter((x) => x.effect).map((x) => x.witness);
      for (const witness of witnesses) fixture!.verify(witness);
      if (fixture) {
        result.teardown = await fixture.close();
        fixtureClosed = true;
      } else result.teardown = { clientCloseFailures: 0 };
      await shutdownControlStoreWorkerClient();
      clientClosed = true;
      const before = workspaces.map((w) => scopes(w.db));
      for (const w of workspaces) w.db.sqlite.close();
      coreDb.sqlite.close();
      result.reopen = { scopeHashesMatch: false, effectTuples: 0, progressBodies: 0 };
      for (let w = 0; w < N; w++) {
        const db = openWorkspaceDb(root, workspaces[w]!.workspace.id);
        try {
          demand(isDeepStrictEqual(scopes(db), before[w]), 'Cold native SQL values changed');
          for (const witness of witnesses.filter(
            (x) => x.workspaceId === workspaces[w]!.workspace.id
          )) {
            fixture!.verify(witness, db);
            result.reopen.effectTuples++;
          }
          const scope = nativeProductScope(root, {
            kind: 'workspace',
            workspaceId: workspaces[w]!.workspace.id,
          });
          const descriptors = new Map(
            (
              db.sqlite
                .prepare("SELECT id,content_json FROM control_product_entries WHERE kind='item'")
                .all() as any[]
            ).map((x) => [x.id, JSON.parse(x.content_json)])
          );
          for (const receipt of receipts.filter(
            (x) => !x.effect && x.actor.workspaceId === workspaces[w]!.workspace.id
          )) {
            const descriptor = descriptors.get(receipt.item.id);
            demand(descriptor, 'ACKed Item missing after reopen');
            demand(
              isDeepStrictEqual(
                readImmutableProductJson(scope.contentMount, scope.owner, descriptor),
                { ...receipt.item, schemaVersion: 1 }
              ),
              'ACKed immutable Item changed'
            );
            result.reopen.progressBodies++;
          }
        } finally {
          db.sqlite.close();
        }
      }
      result.reopen.scopeHashesMatch = true;
      const telemetry = fs
        .readdirSync(B)
        .filter((f) => /^native-observation-thread\d+\.json$/.test(f))
        .map((f) => JSON.parse(fs.readFileSync(join(B, f), 'utf8')))
        .filter((t) => result.clientQueue.expectedNativeNodeIds.includes(t.threadId));
      const telemetryCoverage =
        isDeepStrictEqual(
          telemetry.map((t) => t.threadId).sort((a, b) => a - b),
          result.clientQueue.expectedNativeNodeIds.slice().sort((a: number, b: number) => a - b)
        ) &&
        telemetry.some(
          (t) => t.records.length > 0 && t.successfulProductReplies > 0 && t.maxWalBytes > 0
        );
      result.nativeObservation = telemetry.map((t) => ({
        ...t,
        records: undefined,
        steady: t.records.filter((r: any) => r.inWindow),
        allPhaseRecords: t.records.length,
      }));
      const counts = result.accounting.total,
        siblings = result.accounting.siblings;
      const safe =
        (ISO ? siblings[0].missed === 0 : counts.missed === 0) &&
        counts.unknown === 0 &&
        counts.unresolved === 0 &&
        counts.allPhaseUnknown === 0 &&
        counts.allPhaseUnresolved === 0 &&
        result.mainSql.busyCount === 0 &&
        Object.keys(result.mainSql.errors).length === 0 &&
        result.reopen.scopeHashesMatch &&
        result.teardown.clientCloseFailures === 0;
      const responsive =
        result.mainLoop.p99Ms <= 25 &&
        result.mainSql.begin.max !== null &&
        result.mainSql.begin.max <= 10;
      const queueBounded =
        result.clientQueue.observerErrors === 0 &&
        result.clientQueue.all.maxOutstandingPerDatabase <=
          result.clientQueue.limits.pendingTransitions &&
        result.clientQueue.all.maxInputBytes <= result.clientQueue.limits.pendingBytes;
      const floor = ISO
        ? siblings
            .slice(1)
            .every((x: any) => x.scheduled === 1500 && x.scheduledAckedInWindow >= 1485)
        : counts.scheduledAckedInWindow / (WINDOW / 1000) >= (PROFILE === 'one' ? 20 : 200) &&
          siblings.every(
            (x: any) =>
              x.scheduledAckedInWindow / (WINDOW / 1000) >= (PROFILE === 'one' ? 20 : 200 / N)
          );
      const dose =
        PROFILE === 'one' || ISO || counts.scheduledEffectsAckedInWindow / (WINDOW / 1000) >= 20;
      const nativeSafe =
        telemetryCoverage &&
        telemetry.length > 0 &&
        telemetry.every(
          (t) =>
            t.observerErrors === 0 &&
            t.activeAtFinish === 0 &&
            t.earlyProductReplyInsideSql === 0 &&
            t.maxWalBytes <= 32 * 1024 * 1024
        );
      const ordinaryRefusal = ISO
        ? siblings.slice(1).every((x: any) => x.refused === 0 || x.scheduledAckedInWindow >= 1485)
        : counts.refused === 0;
      const oneProof =
        PROFILE !== 'one' ||
        (telemetry.every(
          (t) =>
            t.maxActiveWorkspaceSqlTransactions <= 1 &&
            t.oneReplyWithoutPriorCommit === 0 &&
            t.oneUnclassifiedTransactions === 0 &&
            t.successfulProductReplies === t.records.length &&
            t.records.every(
              (r: any) =>
                r.ok &&
                r.commit &&
                r.attempts === 1 &&
                r.released === 1 &&
                r.rolledBackMembers === 0
            )
        ) &&
          telemetry.reduce((s, t) => s + t.records.length, 0) === receipts.length);
      const hotRefusals = rows.filter(
        (r) => r.steady && r.workspace === 0 && r.status === 'refused'
      );
      const explicitScopeRefusal = hotRefusals.every(
        (r) =>
          r.commit === 'not-committed' &&
          (r.code === 'busy' ||
            (r.error?.name === 'ProtocolError' &&
              r.error?.dataCode === 'operation_storage_unavailable'))
      );
      const hotDisposition =
        !ISO ||
        (explicitScopeRefusal &&
          (hotRefusals.length > 0 || siblings[0].scheduledAckedInWindow === siblings[0].scheduled));
      result.criteria = {
        safe,
        responsive,
        queueBounded,
        floor,
        dose,
        nativeSafe,
        ordinaryRefusal,
        oneProof,
        hotDisposition,
      };
      result.wouldMeetInheritedCriteria =
        !CONTROL && Object.values(result.criteria).every((v) => v === true);
      result.qualification = !DIAGNOSTIC_ONLY && result.wouldMeetInheritedCriteria;
      result.isoHotDisposition = ISO
        ? hotRefusals.length > 0 && explicitScopeRefusal
          ? 'EXPLICIT SCOPE-LOCAL NOT-COMMITTED REFUSAL'
          : siblings[0].scheduledAckedInWindow === siblings[0].scheduled
            ? 'FULLY SERVED; no excess encountered; overload refusal not exercised'
            : 'NOT PROVEN: hot shortfall without explicit overload refusal'
        : undefined;
      result.effectsAllPhases = fixture
        ? {
            cold: receipts.filter((r) => r.effect && r.witness.cold).length,
            warm: receipts.filter((r) => r.effect && !r.witness.cold).length,
          }
        : undefined;
    } catch (e: any) {
      result.failure = { name: e?.name, message: String(e?.message ?? 'unknown'), code: e?.code };
      throw e;
    } finally {
      loop.disable();
      if (observation && !observerClosed) {
        try {
          result.finalObservation = await observation.finish();
        } catch (e: any) {
          result.observerCloseFailure = e?.name;
        }
      }
      if (fixture && !fixtureClosed) {
        try {
          await fixture.close();
        } catch {}
      }
      if (!clientClosed) {
        try {
          await shutdownControlStoreWorkerClient();
        } catch {}
      }
      for (const w of workspaces) {
        try {
          w.db.sqlite.close();
        } catch {}
      }
      try {
        coreDb.sqlite.close();
      } catch {}
      write(output, result);
    }
  },
  900000
);
