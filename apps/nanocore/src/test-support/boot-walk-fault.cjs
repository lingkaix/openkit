// openkit-test-platform: posix
'use strict';

// Fault fixture only: it refuses selected SQLite reads and never writes.
// OPENKIT_TEST_BOOT_WALK_FAULT =
//   { workspaceId?, fail?, within?, outside?, after?, times?, miss?, arm?, live?, shared?, census?,
//     writer?, writerSql?, writerWithin?, writerAfter?, writerWatch?, label }.
// - fail: SQL text that throws on the named Workspace's own database in Main once armed.
// - within / outside: the fail applies only while one listed function is / no listed function is
//   on the stack.
// - after: number of matching reads that still succeed before the fail applies.
// - times: number of matching reads the fail applies to; absent = every later matching read.
// - miss: the matching read observes no row instead of failing (a missing record, not an error).
// - arm: SQL text on any handle that arms the fault; absent = armed from process start.
// - live: function names whose matching reads stay faulted after the bind, for a Boot handoff whose
//   owner keeps working after the listeners bind.
// - shared: after the Workspace read fails, every Core read fails too (shared owner lost).
// - census 'lost': after the Workspace read fails, listing the Workspace directory fails with EIO.
// - census 'walk': the Boot walk's own census listing of the Workspace directory fails with EIO.
// - writer: in the control-store writer thread, the named Workspace's Item publication reads its
//   Turn head: 'missing-head' observes no row (the writer's own precondition refusal), 'busy'
//   throws SQLITE_BUSY (the writer's busy result). writerSql / writerWithin select another writer
//   read (default the Turn head read inside prepareControlItemAppend); writerAfter counts the
//   matching writer reads that still succeed first.
// - writerWatch: in the control-store writer thread, report (never refuse) the first table write
//   that enters the named Workspace's database, so a case can require that no write began there.
// The Main fault covers Boot only: it disarms when the App listener binds, so live reads after Boot
// run unfaulted, except reads under a listed `live` owner.
(() => {
  const threads = require('node:worker_threads');
  const raw = process.env.OPENKIT_TEST_BOOT_WALK_FAULT;
  if (!raw) return;
  const fault = JSON.parse(raw);
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const Database = createRequire(path.join(__dirname, '..', '..', 'package.json'))(
    'better-sqlite3'
  );
  const scoped = path.join('workspaces', fault.workspaceId ?? '', 'db', 'workspace.sqlite');
  // Owner reads sit deep below the Boot walk, so read the whole stack, not the default ten frames.
  const stack = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 200;
    try {
      return String(new Error().stack);
    } finally {
      Error.stackTraceLimit = limit;
    }
  };
  if (!threads.isMainThread) {
    if (!fault.writer && !fault.writerWatch) return;
    const probe = new Database(':memory:');
    const statement = Object.getPrototypeOf(probe.prepare('SELECT 1'));
    probe.close();
    if (fault.writerWatch) {
      const run = statement.run;
      let entered = false;
      statement.run = function (...args) {
        const name = typeof this.database?.name === 'string' ? this.database.name : '';
        if (
          !entered &&
          name.endsWith(scoped) &&
          /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(String(this.source))
        ) {
          entered = true;
          process.stderr.write(
            `[boot-walk-fault] writer-entered ${fault.label} ${String(this.source).slice(0, 80)}\n`
          );
        }
        return run.apply(this, args);
      };
    }
    if (!fault.writer) return;
    const get = statement.get;
    let writerPassed = 0;
    statement.get = function (...args) {
      const name = typeof this.database?.name === 'string' ? this.database.name : '';
      if (
        name.endsWith(scoped) &&
        String(this.source) === (fault.writerSql ?? 'SELECT * FROM control_turns WHERE id=?') &&
        stack().includes(fault.writerWithin ?? 'prepareControlItemAppend') &&
        writerPassed++ >= (fault.writerAfter ?? 0)
      ) {
        process.stderr.write(`[boot-walk-fault] hit ${fault.label}\n`);
        // The writer hit names its operation, so a miscounted writerAfter shows which post it refused.
        process.stderr.write(
          `[boot-walk-fault] writer-stack ${stack()
            .split('\n')
            .slice(2, 14)
            .map(
              (frame) =>
                frame
                  .trim()
                  .replace(/^at (async )?/, '')
                  .split(' (')[0]
            )
            .join(' < ')}\n`
        );
        if (fault.writer === 'missing-head') return undefined;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return get.apply(this, args);
    };
    return;
  }
  const core = path.join('server', 'db', 'core.sqlite');
  let armed = !fault.arm;
  let passed = 0;
  let applied = 0;
  const listed = (names) => [].concat(names);
  let disarmed = false;
  let coreLost = false;
  let censusLost = false;
  const reported = new Set();
  const report = (event) => {
    if (reported.has(event)) return;
    reported.add(event);
    process.stderr.write(`[boot-walk-fault] ${event}\n`);
  };
  const check = (database, sql, execution) => {
    const name = typeof database?.name === 'string' ? database.name : '';
    if (!armed && !disarmed && sql.includes(fault.arm)) {
      armed = true;
      report('armed');
    }
    if (coreLost && name.endsWith(core)) {
      report('core-refused');
      throw new Error('[boot-walk-fault] Core authority is unavailable.');
    }
    if (
      (armed ||
        (disarmed && fault.live && listed(fault.live).some((name) => stack().includes(name)))) &&
      fault.fail &&
      name.endsWith(scoped) &&
      sql.includes(fault.fail) &&
      (!fault.within || listed(fault.within).some((name) => stack().includes(name))) &&
      (!fault.outside || !listed(fault.outside).some((name) => stack().includes(name))) &&
      // A counted or missing-row fault applies at execution, so one read counts once whether or
      // not its statement was cached.
      (fault.after === undefined || (execution && passed++ >= fault.after)) &&
      (!fault.miss || execution) &&
      (fault.times === undefined || applied < fault.times)
    ) {
      applied++;
      report(`hit ${fault.label}`);
      // The first hit names its callers, so a misattributed hold shows which owner read it.
      report(
        `hit-stack ${stack()
          .split('\n')
          .slice(2)
          .map(
            (frame) =>
              frame
                .trim()
                .replace(/^at (async )?/, '')
                .split(' (')[0]
          )
          .filter(
            (frame) => frame && !frame.startsWith('node:') && !frame.includes('boot-walk-fault')
          )
          .slice(0, 24)
          .join(' < ')}`
      );
      if (fault.miss) return 'miss';
      if (fault.shared) coreLost = true;
      if (fault.census === 'lost') censusLost = true;
      throw Object.assign(new Error('database disk image is malformed'), {
        code: 'SQLITE_CORRUPT',
      });
    }
  };
  if (fault.census) {
    const fs = require('node:fs');
    const readdirSync = fs.readdirSync;
    const census = `${path.sep}workspaces`;
    fs.readdirSync = function (target, ...rest) {
      const walkCensus =
        fault.census === 'walk' &&
        armed &&
        !disarmed &&
        stack().includes('listAdmittedWorkspaceIds');
      if ((walkCensus || censusLost) && String(target).endsWith(census)) {
        report(walkCensus ? `hit ${fault.label}` : 'census-refused');
        throw Object.assign(new Error(`EIO: i/o error, scandir '${target}'`), {
          code: 'EIO',
          errno: -5,
          syscall: 'scandir',
          path: String(target),
        });
      }
      return readdirSync.call(this, target, ...rest);
    };
    require('node:module').syncBuiltinESMExports();
  }
  const net = require('node:net');
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const port = typeof args[0] === 'object' && args[0] !== null ? args[0].port : args[0];
    if (!disarmed && Number(port) === Number(process.env.PORT)) {
      disarmed = true;
      armed = false;
      report('disarmed');
    }
    return listen.apply(this, args);
  };
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql, ...rest) {
    check(this, String(sql), false);
    return prepare.call(this, sql, ...rest);
  };
  // Owners cache prepared statements, so the fault also applies at execution.
  const probe = new Database(':memory:');
  const statement = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  for (const method of ['get', 'all', 'iterate', 'run']) {
    const original = statement[method];
    statement[method] = function (...args) {
      if (check(this.database, String(this.source), true) === 'miss')
        return method === 'all' ? [] : undefined;
      return original.apply(this, args);
    };
  }
})();
