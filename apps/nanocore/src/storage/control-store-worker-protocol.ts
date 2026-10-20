/** Internal wire version; this is not a public operation or a retained record format. */
export const CONTROL_WORKER_VERSION = 1;

/** Fixed, qualified batching and per-database pending admission bounds. */
export const CONTROL_WORKER_LIMITS = {
  batchTransitions: 32,
  batchWaitMs: 5,
  pendingTransitions: 1024,
} as const;

/** SQLite bind values that survive structured cloning without executable content. */
export type ControlSqlValue = string | number | bigint | Uint8Array | null;

/** One fully materialized SQLite row; no cursor crosses the worker boundary. */
export type ControlSqlRow = Record<string, ControlSqlValue>;

/**
 * One trusted, bounded SQLite statement in a local transition.
 *
 * SQL and statement order come from Core code, never a public request. Conditions belong in SQL predicates and these in-worker assertions, not a main-thread read/decision round trip. Bind caller data; synchronize immutable inputs first. There are no callbacks, result references, external effects or transaction SQL.
 */
export type ControlSqlStatement =
  | {
      readonly mode: 'run';
      readonly sql: string;
      readonly parameters: readonly ControlSqlValue[];
      /** A conditional mutation must affect this many rows or roll back its transition. */
      readonly expectChanges?: number;
    }
  | {
      readonly mode: 'get';
      readonly sql: string;
      readonly parameters: readonly ControlSqlValue[];
      /** Check existence inside the same savepoint as all dependent mutations. */
      readonly expectRow?: 'present' | 'absent';
    };

/** A statement result, available to the caller only after durable outer COMMIT. */
export type ControlSqlResult =
  | { readonly mode: 'run'; readonly changes: number; readonly lastInsertRowid: number | bigint }
  | { readonly mode: 'get'; readonly row: ControlSqlRow | null };

/**
 * Trusted internal database-worker requests.
 *
 * An id is transient message correlation, never a replacement command receipt. A database key denotes an already-admitted physical scope, not new ownership. The host must cap outstanding writes before postMessage using the same pending bound: a worker-side cap alone cannot bound a blocked MessagePort's backlog. Pure reads use separate read-only/query_only connections and do not use this API.
 */
export type ControlWorkerRequest = {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly id: number;
  readonly database: string;
} & (
  | {
      readonly operation: 'open';
      /** Absolute, admitted path with an existing parent; never a public path argument. */
      readonly path: string;
      /** Explicit fresh-scope admission; false must never initialize a missing database. */
      readonly create: boolean;
    }
  | { readonly operation: 'write'; readonly statements: readonly ControlSqlStatement[] }
  | { readonly operation: 'checkpoint' | 'reclaim' | 'close' }
);

/** Closed failure categories; SQL text, bindings and native error messages are not returned. */
export type ControlWorkerFailureCode =
  | 'invalid-request'
  | 'not-open'
  | 'busy'
  | 'precondition'
  | 'constraint'
  | 'sql-failed'
  | 'unavailable'
  | 'commit-unknown';

/**
 * Worker reply. Success for writes follows the outer FULL-durability COMMIT.
 *
 * Worker loss, missing replies and commit-unknown are not proof of non-commit. Inspect the original command receipt under its identity/fingerprint; this transport neither retries nor supplies another durable queue or recovery owner.
 */
export type ControlWorkerReply = {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly id: number;
} & (
  | { readonly status: 'ok'; readonly operation: 'open' | 'close' }
  | {
      readonly status: 'ok';
      readonly operation: 'write';
      readonly results: readonly ControlSqlResult[];
    }
  | {
      readonly status: 'ok';
      readonly operation: 'checkpoint';
      readonly pressure: {
        readonly busy: number;
        readonly log: number;
        readonly checkpointed: number;
        readonly walBytes: number;
        readonly walAgeMs: number;
      };
    }
  | { readonly status: 'ok'; readonly operation: 'reclaim'; readonly complete: boolean }
  | {
      readonly status: 'error';
      readonly code: ControlWorkerFailureCode;
      readonly commit: 'not-committed' | 'unknown';
    }
);
