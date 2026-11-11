// openkit-test-platform: posix
'use strict';

// Passive fixture only. --require can be inherited by native Workers: patch Main alone.
(() => {
  const threads = require('node:worker_threads');
  if (!threads.isMainThread) return;
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire, Module } = require('node:module');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const net = require('node:net');
  const http = require('node:http');
  const https = require('node:https');
  const eventLimit = 512,
    handleLimit = 32,
    pendingLimit = 128;
  const events = [],
    observerErrors = [];
  // Only live Database objects are retained. Closed history belongs to the same
  // bounded event ledger; export projections are derived, never independently accumulated.
  const live = new Map();
  let nextHandle = 0,
    nextDatabase = 0,
    liveHandles = 0,
    maxLiveHandles = 0;
  let serial = 0,
    overflow = false,
    installed = false;
  let manifest, reportPath, physicalRoot;
  const constructorCounts = { published: 0, staging: 0, outside: 0, memory: 0, unclassified: 0 };
  const scopeConstructorCounts = { core: 0, user: 0, workspace: 0, app: 0 };
  const isPublishedOpen = (event) => ['core-open', 'published-open'].includes(event.kind);
  const isPublishedClose = (event) =>
    ['core-close', 'published-close'].includes(event.kind) && event.open === false;
  const databaseForPhysical = (physical) => {
    if (typeof physical !== 'string') return null;
    const relative = path.relative(physicalRoot, physical).split(path.sep).join('/');
    return (
      events.find((event) => isPublishedOpen(event) && event.relativePath === relative)?.database ??
      null
    );
  };
  // Canonical physical identity, never a directory scan or an arbitrary filename exclusion.
  const canonicalPath = (value) => {
    try {
      return fs.realpathSync(value);
    } catch (reason) {
      if (reason?.code !== 'ENOENT') throw reason;
      return path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
    }
  };
  const classify = (value) => {
    const physical = canonicalPath(value);
    const relative = path.relative(physicalRoot, physical).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
      return { scope: 'outside' };
    if (relative === 'server/db/core.sqlite') return { scope: 'core', physical, relative };
    if (/^users\/[^/]+\/db\/user\.sqlite$/.test(relative))
      return { scope: 'user', physical, relative };
    if (/^workspaces\/(?!\.staging\/)[^/]+\/db\/workspace\.sqlite$/.test(relative))
      return { scope: 'workspace', physical, relative };
    if (/^workspaces\/(?!\.staging\/)[^/]+\/light-apps\/[^/]+\/data\.sqlite$/.test(relative))
      return { scope: 'app', physical, relative };
    const staged =
      /^workspaces\/\.staging\/([^/]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/db\/workspace\.sqlite$/.exec(
        relative
      );
    if (staged && !fs.existsSync(path.join(physicalRoot, 'workspaces', staged[1])))
      return { scope: 'staging' }; // Store's unique random initializer; final Workspace is absent.
    return { scope: 'unclassified' }; // Unknown fixture-root constructors fail; never silently disappear.
  };
  const error = (phase, reason) => {
    const value =
      reason && typeof reason.code === 'string' && /^[A-Z0-9_]+$/.test(reason.code)
        ? reason.code
        : 'UNCLASSIFIED';
    if (observerErrors.length < 16) observerErrors.push({ phase, code: value });
    else overflow = true;
  };
  const emit = (record) => {
    const seq = ++serial;
    if (events.length < eventLimit) events.push({ seq, ...record });
    else overflow = true;
    return seq;
  };
  try {
    const manifestPath = process.env.OPENKIT_F1_OBSERVER_MANIFEST;
    if (!manifestPath || !path.isAbsolute(manifestPath)) return;
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      !path.isAbsolute(manifest.corePath) ||
      !path.isAbsolute(manifest.workspacePath) ||
      !path.isAbsolute(manifest.reportPath) ||
      path.dirname(manifest.reportPath) !== path.dirname(manifestPath) ||
      typeof manifest.requestId !== 'string'
    )
      return;
    reportPath = manifest.reportPath;
    const physicalCore = fs.realpathSync(manifest.corePath);
    physicalRoot = path.dirname(path.dirname(path.dirname(physicalCore)));
    if (physicalCore !== path.join(physicalRoot, 'server', 'db', 'core.sqlite')) return;
  } catch {
    return; // A missing report is a fixture failure, never a successful observation.
  }
  const port = Number(process.env.OPENKIT_F1_OBSERVER_PORT);
  const publicContext = new AsyncLocalStorage();
  const pending = new Map();
  const workerIds = new WeakMap();
  let nextWorker = 0,
    nextServer = 0;
  const aliasPaths = new Map([
    [`core:${manifest.corePath}`, fs.realpathSync(manifest.corePath)],
    [`workspace:${manifest.workspacePath}`, fs.realpathSync(manifest.workspacePath)],
  ]);
  const aliases = new Map([
    [`core:${manifest.corePath}`, 'core'],
    [`workspace:${manifest.workspacePath}`, 'workspace'],
  ]);
  const snapshot = (reason, related = {}) => {
    const publishedLive = [...live.values()].map(({ db, handle, scope, database }) => {
      if (!db.open) {
        error('unobserved-close', undefined);
        return { handle, scope, database, open: false };
      }
      try {
        return {
          handle,
          scope,
          database,
          open: true,
          readonly: db.readonly,
          queryOnly: db.pragma('query_only', { simple: true }),
        };
      } catch (reason) {
        error('snapshot', reason);
        return { handle, scope, database, open: true, readonly: db.readonly };
      }
    });
    emit({ kind: 'core-snapshot', reason, ...related, publishedLive });
  };
  // Reconstruct exact historical views from actual opens, successful closes and the
  // policy sampled while each handle was live. No closed Database object is retained.
  const snapshotProjection = (event) => {
    const published = events
      .filter((opened) => isPublishedOpen(opened) && opened.seq < event.seq)
      .map((opened) => {
        const identity = { handle: opened.handle, scope: opened.scope, database: opened.database };
        const closed = events.find(
          (candidate) =>
            isPublishedClose(candidate) &&
            candidate.handle === opened.handle &&
            candidate.seq < event.seq
        );
        if (closed) return { ...identity, open: false };
        const sampled = event.publishedLive.find((state) => state.handle === opened.handle);
        if (sampled) return sampled;
        error('missing-live-sample', undefined);
        return { ...identity, open: true }; // Reliability fails; never invent policy or closure.
      });
    const { publishedLive, ...header } = event;
    return {
      ...header,
      published,
      core: published
        .filter((state) => state.scope === 'core')
        .map(({ scope, database, ...state }) => state),
    };
  };
  process.on('exit', (exitCode) => {
    try {
      // These temporary JSON views are derived only at export from <=512 ledger events.
      const opens = events.filter(isPublishedOpen);
      const exportedEvents = events.map((event) =>
        event.kind === 'core-snapshot' ? snapshotProjection(event) : event
      );
      const finalPublishedHandles = opens.map(({ handle, scope, database }) => {
        const closed = events.find((event) => isPublishedClose(event) && event.handle === handle);
        if (closed) return { handle, scope, database, open: false };
        const retained = live.get(handle);
        if (!retained) error('missing-live-reference', undefined);
        return { handle, scope, database, open: retained ? retained.db.open : true };
      });
      const databases = opens
        .filter(
          (event, index) =>
            opens.findIndex((candidate) => candidate.database === event.database) === index
        )
        .map(({ database, scope, relativePath }) => ({ database, scope, relativePath }));
      fs.writeFileSync(
        reportPath,
        JSON.stringify({
          schemaVersion: 1,
          mainThread: threads.isMainThread,
          installed,
          overflow,
          observerErrors,
          exitCode,
          pending: pending.size,
          events: exportedEvents,
          finalHandles: finalPublishedHandles
            .filter((state) => state.scope === 'core')
            .map(({ handle, open }) => ({ handle, open })),
          finalPublishedHandles,
          constructorCounts,
          scopeConstructorCounts,
          databases,
          liveHandles,
          maxLiveHandles,
          retainedLiveHandles: live.size,
        })
      );
    } catch {
      // No stdout/stderr, path or error-message output. A missing report cannot qualify.
    }
  });
  try {
    const load = createRequire(path.join(process.cwd(), 'package.json'));
    const databaseModule = load.resolve('better-sqlite3');
    if (load.cache[databaseModule])
      throw Object.assign(new Error('SQLite driver was loaded before observer interception.'), {
        code: 'SQLITE_DRIVER_ALREADY_LOADED',
      });
    const observed = new WeakSet();
    const observeDatabase = (db) => {
      if (observed.has(db)) return db;
      observed.add(db);
      if (!db.name || db.name === ':memory:') {
        constructorCounts.memory += 1;
        return db;
      }
      let owner;
      try {
        owner = classify(db.name);
      } catch (reason) {
        error('constructor-identity', reason);
        return db;
      }
      if (owner.scope === 'outside') {
        constructorCounts.outside += 1;
        return db;
      }
      if (owner.scope === 'staging') {
        constructorCounts.staging += 1;
        emit({ kind: 'unpublished-staging-open', uniqueSuffix: true, finalAbsent: true });
        return db;
      }
      if (owner.scope === 'unclassified') {
        constructorCounts.unclassified += 1;
        error('unclassified-root-database', undefined);
        return db;
      }
      constructorCounts.published += 1;
      scopeConstructorCounts[owner.scope] += 1;
      const database = databaseForPhysical(owner.physical) ?? ++nextDatabase;
      const handle = ++nextHandle,
        scope = owner.scope;
      liveHandles += 1;
      maxLiveHandles = Math.max(maxLiveHandles, liveHandles);
      if (live.size >= handleLimit) overflow = true;
      else live.set(handle, { db, handle, scope, database });
      if (liveHandles > handleLimit) overflow = true;
      // Every constructor is recorded even on resource overflow; overflow remains fatal.
      emit({
        kind: scope === 'core' ? 'core-open' : 'published-open',
        handle,
        scope,
        database,
        relativePath: owner.relative,
        readonly: db.readonly,
        liveAfter: liveHandles,
      });
      const close = db.close;
      db.close = function (...closeArgs) {
        let policy;
        try {
          policy = {
            readonly: this.readonly,
            queryOnly: this.pragma('query_only', { simple: true }),
          };
        } catch (reason) {
          error('close-policy', reason);
        }
        const result = Reflect.apply(close, this, closeArgs);
        if (!this.open) {
          if (events.some((event) => isPublishedClose(event) && event.handle === handle))
            error('duplicate-close', undefined);
          else {
            live.delete(handle);
            liveHandles -= 1;
          }
        } else error('close-still-open', undefined);
        emit({
          kind: scope === 'core' ? 'core-close' : 'published-close',
          handle,
          scope,
          database,
          open: this.open,
          policy,
          liveAfter: liveHandles,
        });
        return result; // Only successful actual close supplies closure evidence.
      };
      return db;
    };
    // Compile the genuine driver source unchanged and wrap its export before Node's
    // ESM snapshot. Restore this one-use hook before any application work begins.
    const compile = Module._extensions['.js'];
    let intercepted = false;
    Module._extensions['.js'] = (module, filename) => {
      compile(module, filename);
      if (filename !== databaseModule) return;
      module.exports = new Proxy(module.exports, {
        construct: (target, args, newTarget) =>
          observeDatabase(Reflect.construct(target, args, newTarget)),
        apply: (target, self, args) => observeDatabase(Reflect.apply(target, self, args)),
      });
      intercepted = true;
    };
    try {
      load(databaseModule);
    } finally {
      Module._extensions['.js'] = compile;
    }
    if (!intercepted)
      throw Object.assign(new Error('SQLite driver compilation was not intercepted.'), {
        code: 'SQLITE_DRIVER_NOT_INTERCEPTED',
      });
    const post = threads.Worker.prototype.postMessage;
    threads.Worker.prototype.postMessage = function (...args) {
      const request = args[0];
      if (
        !request ||
        typeof request !== 'object' ||
        typeof request.id !== 'number' ||
        typeof request.operation !== 'string' ||
        (request.operation !== 'shutdown' && typeof request.database !== 'string')
      )
        return Reflect.apply(post, this, args);
      if (request.operation === 'open') {
        try {
          const owner = classify(request.path);
          if (['core', 'user', 'workspace', 'app'].includes(owner.scope)) {
            aliases.set(request.database, owner.scope);
            aliasPaths.set(request.database, owner.physical);
          }
        } catch (reason) {
          error('native-open-identity', reason);
        }
      }
      const scope = request.operation === 'shutdown' ? 'host' : aliases.get(request.database);
      if (!scope) return Reflect.apply(post, this, args);
      if (!workerIds.has(this)) {
        const worker = ++nextWorker;
        workerIds.set(this, worker);
        this.on('message', (reply) => {
          if (!reply || typeof reply !== 'object' || typeof reply.id !== 'number') return;
          const key = `${worker}:${reply.id}`;
          const original = pending.get(key);
          if (!original) return;
          // Forecast/nonterminal messages are not ACKs and do not erase correlation.
          if (reply.status !== 'ok' && reply.status !== 'error') return;
          pending.delete(key);
          if (reply.operation !== original.operation) {
            error('reply-correlation', undefined);
            return;
          }
          const terminal = { kind: 'native-terminal', status: reply.status, ...original };
          emit(terminal);
          snapshot('native-ack', {
            worker,
            rpc: reply.id,
            scope: original.scope,
            operation: original.operation,
            publicOrdinal: original.publicOrdinal,
          });
        });
      }
      // Posting global shutdown causally precedes the native final drain/SQLite close.
      // Observe before forwarding it; do not wrap or replace native SQL or its ACK.
      if (request.operation === 'shutdown') snapshot('before-native-shutdown');
      if (request.operation === 'close')
        snapshot(scope === 'core' ? 'before-native-close' : 'before-published-native-close', {
          scope,
          closingDatabase: databaseForPhysical(aliasPaths.get(request.database)),
        });
      const worker = workerIds.get(this),
        key = `${worker}:${request.id}`;
      if (pending.has(key)) error('duplicate-request', undefined);
      else if (pending.size >= pendingLimit) overflow = true;
      else {
        const original = {
          worker,
          rpc: request.id,
          scope,
          operation: request.operation,
          publicOrdinal: publicContext.getStore() ?? null,
        };
        // One closed event-type discriminant identifies the real shutdown Audit. No
        // Audit JSON, SQL, body, credential, content buffer or result is inspected.
        if (
          request.operation === 'boot-audit' &&
          request.input &&
          ['boot.start', 'boot.outcome', 'boot.shutdown'].includes(request.input.eventType)
        )
          original.auditPhase = request.input.eventType;
        original.requestSeq = emit({ kind: 'native-request', ...original });
        pending.set(key, original);
      }
      return Reflect.apply(post, this, args); // Header scalars only; no content/result access.
    };
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      const first = args[0];
      const requestedPort =
        typeof first === 'object' && first !== null ? Number(first.port) : Number(first);
      const selected =
        (this instanceof http.Server || this instanceof https.Server) && requestedPort === port;
      if (selected) {
        const server = ++nextServer;
        snapshot('listen-call', { server });
        this.once('listening', () => snapshot('listening', { server }));
        const originalEmit = this.emit;
        this.emit = function (event, ...values) {
          const request = values[0],
            response = values[1];
          if (
            event !== 'request' ||
            request?.method !== 'POST' ||
            request.url !== '/api/app/operations/thread.create' ||
            request.headers?.['x-openkit-request-id'] !== manifest.requestId
          )
            return Reflect.apply(originalEmit, this, [event, ...values]);
          // Builtin async identity correlates this genuine request to original native posts;
          // no body/authorization inspection or buffering is introduced.
          return publicContext.run(1, () => {
            emit({ kind: 'public-start', publicOrdinal: 1 });
            snapshot('public-start', { publicOrdinal: 1 });
            response.once('finish', () => {
              emit({ kind: 'public-response', publicOrdinal: 1, status: response.statusCode });
              snapshot('public-response', { publicOrdinal: 1 });
            });
            return Reflect.apply(originalEmit, this, [event, ...values]);
          });
        };
      }
      return Reflect.apply(listen, this, args);
    };
    installed = true;
  } catch (reason) {
    error('install', reason);
  }
})();
