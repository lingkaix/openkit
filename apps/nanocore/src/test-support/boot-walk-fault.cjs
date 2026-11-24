// openkit-test-platform: posix
'use strict';

// Fault fixture only: it refuses selected SQLite reads in Main and never writes.
// OPENKIT_TEST_BOOT_WALK_FAULT = { workspaceId?, fail?, arm?, shared?, census?, label }.
// - fail: SQL text that throws on the named Workspace's own database once armed.
// - arm: SQL text on any handle that arms the fault; absent = armed from process start.
// - shared: after the Workspace read fails, every Core read fails too (shared owner lost).
// - census 'lost': after the Workspace read fails, listing the Workspace directory fails with EIO.
// - census 'walk': the Boot walk's own census listing of the Workspace directory fails with EIO.
// The fault covers Boot only: it disarms when the App listener binds, so live reads after Boot run unfaulted.
(() => {
  const threads = require('node:worker_threads');
  if (!threads.isMainThread) return;
  const raw = process.env.OPENKIT_TEST_BOOT_WALK_FAULT;
  if (!raw) return;
  const fault = JSON.parse(raw);
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const Database = createRequire(path.join(__dirname, '..', '..', 'package.json'))(
    'better-sqlite3'
  );
  const scoped = path.join('workspaces', fault.workspaceId ?? '', 'db', 'workspace.sqlite');
  const core = path.join('server', 'db', 'core.sqlite');
  let armed = !fault.arm;
  let disarmed = false;
  let coreLost = false;
  let censusLost = false;
  const reported = new Set();
  const report = (event) => {
    if (reported.has(event)) return;
    reported.add(event);
    process.stderr.write(`[boot-walk-fault] ${event}\n`);
  };
  const check = (database, sql) => {
    const name = typeof database?.name === 'string' ? database.name : '';
    if (!armed && !disarmed && sql.includes(fault.arm)) {
      armed = true;
      report('armed');
    }
    if (coreLost && name.endsWith(core)) {
      report('core-refused');
      throw new Error('[boot-walk-fault] Core authority is unavailable.');
    }
    if (armed && fault.fail && name.endsWith(scoped) && sql.includes(fault.fail)) {
      report(`hit ${fault.label}`);
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
        String(new Error().stack).includes('listAdmittedWorkspaceIds');
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
    check(this, String(sql));
    return prepare.call(this, sql, ...rest);
  };
  // Owners cache prepared statements, so the fault also applies at execution.
  const probe = new Database(':memory:');
  const statement = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  for (const method of ['get', 'all', 'iterate', 'run']) {
    const original = statement[method];
    statement[method] = function (...args) {
      check(this.database, String(this.source));
      return original.apply(this, args);
    };
  }
})();
