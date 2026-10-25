/* Test-only scalar native transaction observer. No SQL text, bindings, rows or product mutation. */
'use strict';
const { isMainThread, threadId, BroadcastChannel, parentPort } = require('node:worker_threads');
if (!isMainThread && process.env.R2_CLOSE_CHANNEL && process.env.OPENKIT_R2_ATTR_OUTPUT_DIR) {
  const fs = require('node:fs'),
    path = require('node:path');
  const req = require('node:module').createRequire(path.resolve(__dirname, '../../package.json'));
  const Database = req('better-sqlite3'),
    prototype = Database.prototype,
    original = prototype.exec;
  const hr = () => Number(process.hrtime.bigint()) / 1000;
  const channel = new BroadcastChannel(process.env.R2_CLOSE_CHANNEL);
  channel.unref();
  let lower = Infinity,
    upper = -Infinity,
    enabled = false,
    active = 0,
    maxActive = 0,
    earlyAck = 0,
    dumped = false;
  const transactions = new WeakMap(),
    records = [];
  let maxWalBytes = 0,
    successfulProductReplies = 0,
    oneReplyWithoutPriorCommit = 0,
    oneUnclassifiedTransactions = 0;
  const one = process.env.R2_LOAD_PROFILE
    ? /^rep[12]-one$/.test(process.env.R2_LOAD_PROFILE)
    : process.env.R2_CLOSE_PROFILE === 'one';
  let observerErrors = 0;
  const observe = (read) => {
    try {
      return read();
    } catch {
      observerErrors++;
    }
  };
  const incomingProducts = new Set(),
    committedProducts = new Set();
  parentPort.on('message', (value) =>
    observe(() => {
      if (!enabled || !one) return;
      for (const request of Array.isArray(value?.requests) ? value.requests : [value])
        if (['products', 'transition'].includes(request?.operation))
          incomingProducts.add(request.id);
    })
  );
  prototype.exec = function (...args) {
    if (!enabled) return Reflect.apply(original, this, args);
    const details = observe(() => ({
      text: String(args[0] || '').trim(),
      workspace:
        typeof this.name === 'string' &&
        /[\\/]workspaces[\\/].+[\\/]workspace\.sqlite$/.test(this.name),
      start: hr(),
    }));
    if (!enabled || !details?.workspace) return Reflect.apply(original, this, args);
    const { text, start } = details;
    let ok = false;
    try {
      const value = Reflect.apply(original, this, args);
      ok = true;
      return value;
    } finally {
      observe(() => {
        const end = hr();
        if (/^BEGIN IMMEDIATE\s*;?$/i.test(text) && ok) {
          transactions.set(this, {
            workspaceId: path.basename(path.dirname(path.dirname(this.name))),
            start,
            attempts: 0,
            released: 0,
            rolledBackMembers: 0,
            oneRequestIds: one ? [...incomingProducts] : [],
          });
          active++;
          maxActive = Math.max(maxActive, active);
        } else {
          const tx = transactions.get(this);
          if (tx && /^SAVEPOINT control_transition\s*;?$/i.test(text) && ok) tx.attempts++;
          if (tx && /^RELEASE(?: SAVEPOINT)? control_transition\s*;?$/i.test(text) && ok)
            tx.released++;
          if (tx && /^ROLLBACK TO(?: SAVEPOINT)? control_transition\s*;?$/i.test(text) && ok)
            tx.rolledBackMembers++;
          if (tx && /^(COMMIT|ROLLBACK)\s*;?$/i.test(text)) {
            records.push({
              workspaceId: tx.workspaceId,
              startHrUsec: tx.start,
              endHrUsec: end,
              inWindow: end >= lower && end < upper,
              commit: /^COMMIT/i.test(text),
              ok,
              attempts: tx.attempts,
              released: tx.released,
              rolledBackMembers: tx.rolledBackMembers,
              transactionMs: (end - tx.start) / 1000,
              finalSqlCallMs: (end - start) / 1000,
            });
            if (ok) {
              if (one && /^COMMIT/i.test(text)) {
                if (
                  tx.oneRequestIds.length === 1 &&
                  tx.attempts === 1 &&
                  tx.released === 1 &&
                  tx.rolledBackMembers === 0
                )
                  committedProducts.add(tx.oneRequestIds[0]);
                else oneUnclassifiedTransactions++;
              }
              transactions.delete(this);
              active--;
            }
            try {
              maxWalBytes = Math.max(maxWalBytes, fs.statSync(`${this.name}-wal`).size);
            } catch {
              observerErrors++;
            }
          }
        }
      });
    }
  };
  const post = parentPort.postMessage;
  parentPort.postMessage = function (...args) {
    const value = args[0];
    observe(() => {
      if (
        enabled &&
        value?.status === 'ok' &&
        ['products', 'transition'].includes(value.operation)
      ) {
        successfulProductReplies++;
        if (active) earlyAck++;
        if (one && !committedProducts.has(value.id)) oneReplyWithoutPriorCommit++;
      }
      if (value?.id !== undefined) {
        incomingProducts.delete(value.id);
        committedProducts.delete(value.id);
      }
    });
    return Reflect.apply(post, this, args);
  };
  channel.onmessage = ({ data }) => {
    if (data.kind === 'window') {
      lower = data.lower;
      upper = data.upper;
      enabled = true;
      channel.postMessage({ kind: 'ready', threadId });
    }
    if (data.kind === 'finish' && !dumped) {
      dumped = true;
      enabled = false;
      const report = {
        threadId,
        observerErrors,
        records,
        maxActiveWorkspaceSqlTransactions: maxActive,
        activeAtFinish: active,
        earlyProductReplyInsideSql: earlyAck,
        successfulProductReplies,
        maxWalBytes,
        oneReplyWithoutPriorCommit,
        oneUnclassifiedTransactions,
        oneRequestToCommitProof: one
          ? 'unique posted product request ID bound at successful BEGIN, singleton successful COMMIT return precedes same-ID success reply'
          : 'NOT CLAIMED for general mixed request batches; source COMMIT-before-complete ordering retained',
        batchMeaning:
          'SAVEPOINT attempts and successful RELEASEs, not generally selected batch cardinality; exact for successful native-only ONE with no refusal/rollback and complete tuple reconciliation',
        workerInternalReadyPreparingQueue:
          'NOT OBSERVABLE; client admission occupancy is independently observed',
        noSqlTextOrBindingsOrRows: true,
      };
      const file = path.join(
        process.env.OPENKIT_R2_ATTR_OUTPUT_DIR,
        `native-observation-thread${threadId}.json`
      );
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(report));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      channel.postMessage({ kind: 'finished', threadId });
      channel.close();
    }
  };
}
