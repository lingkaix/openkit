/* Test-only entry and SQLite constructor observations. No paths or database contents in reports. */
'use strict';
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire, Module, registerHooks } = require('node:module');
const { basename, resolve } = require('node:path');
const { fileURLToPath } = require('node:url');
const { isMainThread } = require('node:worker_threads');

const entryRoutes = new Map([
  ['control-store-worker.bundle.mjs', 'compiled'],
  ['control-store-worker.mjs', 'temporary'],
  ['control-store-worker.ts', 'typescript-eval'],
]);

if (!globalThis.__lopsOpen) {
  let entry = null;
  let entryUrl;
  let observerErrors = 0;
  const groups = Object.create(null);
  const observe = (fn) => {
    try {
      fn();
    } catch {
      observerErrors++;
    }
  };
  globalThis.__lopsOpen = {
    snapshot: () => ({ entry, groups: structuredClone(groups), observerErrors }),
  };

  observe(() => {
    const req = createRequire(resolve(__dirname, '../../package.json'));
    const driver = req.resolve('better-sqlite3');
    const scopes = new Set([
      'core.sqlite',
      'user.sqlite',
      'workspace.sqlite',
      'data.sqlite',
      ':memory:',
    ]);

    function open(call, args) {
      const start = process.hrtime.bigint();
      let success = false;
      try {
        const result = call();
        success = true;
        return result;
      } finally {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        observe(() => {
          const name = typeof args[0] === 'string' ? basename(args[0]) : 'other';
          const scope = scopes.has(name) ? name : 'other';
          const option = args[1];
          const descriptor =
            option && typeof option === 'object'
              ? Object.getOwnPropertyDescriptor(option, 'readonly')
              : undefined;
          const mode = !descriptor
            ? option && typeof option === 'object' && 'readonly' in option
              ? 'unknown'
              : 'writable'
            : descriptor.value === true
              ? 'readonly'
              : descriptor.value === false ||
                  (descriptor.value === undefined && 'value' in descriptor)
                ? 'writable'
                : 'unknown';
          const key = `${mode}/${scope}`;
          groups[key] ??= {
            count: 0,
            success: 0,
            errors: 0,
            sumMs: 0,
            maxMs: 0,
          };
          const group = groups[key];
          group.count++;
          group[success ? 'success' : 'errors']++;
          group.sumMs += ms;
          group.maxMs = Math.max(group.maxMs, ms);
        });
      }
    }

    observe(() => {
      if (req.cache[driver]) throw new Error('SQLite driver was loaded before the observer');
      // Wrap the genuine export before Node snapshots it for ESM. The temporary
      // extension hook compiles unmodified source and is restored before any work.
      const compile = Module._extensions['.js'];
      Module._extensions['.js'] = (module, filename) => {
        compile(module, filename);
        if (filename === driver)
          module.exports = new Proxy(module.exports, {
            construct: (t, a, n) => open(() => Reflect.construct(t, a, n), a),
            apply: (t, self, a) => open(() => Reflect.apply(t, self, a), a),
          });
      };
      try {
        req(driver);
      } finally {
        Module._extensions['.js'] = compile;
      }
    });

    if (!isMainThread)
      registerHooks({
        load(url, context, nextLoad) {
          const loaded = nextLoad(url, context);
          if (!url.startsWith('file:') || !url.includes('/control-store-worker.')) return loaded;
          observe(() => {
            const path = fileURLToPath(url);
            const route = entryRoutes.get(basename(path));
            if (!route || entryUrl === url) return;
            if (entryUrl) {
              entry = null;
              throw new Error('Multiple native entry sources in one observer');
            }
            entryUrl = url;
            const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
            entry = { route, sha256 };
          });
          return loaded;
        },
      });
  });
}
