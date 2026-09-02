// openkit-test-platform: posix
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { acquireDataRootLock, DataRootLockError, dataRootLockPath } from '../bootstrap/lock.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { verifyOpenKitAccessTokenRecord } from './access-token-store.js';
import { runOpenKitOperatorCli } from './admin-recovery.js';
import { createAuthMiddleware } from './middleware.js';
import { disableCanonicalUser } from './user-lifecycle.js';

const NOW = new Date('2026-09-02T00:00:00.000Z');
const EXPIRES_AT = '2026-09-02T12:00:00.000Z';

/** Creates an isolated current Core database with one active and one disabled User. */
function createRecoveryDataRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-admin-recovery-'));
  const coreDb = openCoreDb(dataRoot);

  try {
    applyMigrations(coreDb);
    const insert = coreDb.sqlite.prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, status)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    );
    insert.run('user_active', 'Active User', '  ACTIVE@Example.COM  ', 1, 1, 'active');
    insert.run('user_disabled', 'Disabled User', 'disabled@example.com', 1, 1, 'disabled');
  } finally {
    coreDb.sqlite.close();
  }

  return dataRoot;
}

/** Builds one exact recover-access invocation for a temporary data root. */
function recoveryArgs(
  dataRoot: string,
  outputPath: string,
  expiresAt = EXPIRES_AT,
  ownerUserId = 'user_active'
): string[] {
  return [
    'admin',
    'recover-access',
    '--data-root',
    dataRoot,
    '--owner-user-id',
    ownerUserId,
    '--expires-at',
    expiresAt,
    '--output',
    outputPath,
    '--confirm',
    `issue-server-admin-token:${ownerUserId}:${expiresAt}`,
  ];
}

/** Disables the recovery owner through the canonical caller-owned lifecycle transaction. */
function disableRecoveryOwner(dataRoot: string): void {
  const coreDb = openCoreDb(dataRoot);
  try {
    coreDb.sqlite.transaction(() => disableCanonicalUser(coreDb, 'user_active', NOW))();
  } finally {
    coreDb.sqlite.close();
  }
}

/** Creates one completed recovery fixture for contradiction tests. */
function completeRecoveryFixture(name: string): {
  dataRoot: string;
  outputPath: string;
  envelope: { requestId: string; tokenId: string; token: string };
} {
  const dataRoot = createRecoveryDataRoot();
  const outputPath = join(dataRoot, name);
  runOpenKitOperatorCli(recoveryArgs(dataRoot, outputPath), { now: () => NOW, write() {} });
  return {
    dataRoot,
    outputPath,
    envelope: JSON.parse(readFileSync(outputPath, 'utf8')),
  };
}

describe('stopped-server administrator recovery', () => {
  it('lists only redacted active canonical Users and releases the data-root lock', () => {
    const dataRoot = createRecoveryDataRoot();
    const output: string[] = [];

    const result = runOpenKitOperatorCli(['admin', 'recovery-users', '--data-root', dataRoot], {
      write: (line) => output.push(line),
    });

    expect(result).toEqual([
      {
        displayName: 'Active User',
        email: 'active@example.com',
        userId: 'user_active',
      },
    ]);
    expect(output).toEqual([`${JSON.stringify(result)}\n`]);
    expect(() => JSON.parse(output[0] ?? '')).not.toThrow();
    expect(output.join('')).not.toContain('user_disabled');
    expect(output.join('')).not.toContain('disabled@example.com');
    expect(existsSync(dataRootLockPath(dataRoot))).toBe(false);
  });

  it('publishes one recovery envelope, commits its records, and authenticates one request', async () => {
    const dataRoot = createRecoveryDataRoot();
    const outputPath = join(dataRoot, 'admin-recovery.json');
    const output: string[] = [];

    const result = runOpenKitOperatorCli(recoveryArgs(dataRoot, outputPath), {
      now: () => NOW,
      write: (line) => output.push(line),
    });
    const envelope = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      kind: string;
      requestId: string;
      tokenId: string;
      ownerUserId: string;
      expiresAt: string;
      token: string;
    };
    const coreDb = openCoreDb(dataRoot);

    try {
      const tokenRow = coreDb.sqlite
        .prepare('SELECT token_hash FROM openkit_access_tokens WHERE token_id = ?')
        .get(envelope.tokenId) as { token_hash: string };
      const auditRow = coreDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE request_id = ?')
        .get(envelope.requestId) as Record<string, unknown>;

      expect(envelope).toMatchObject({
        expiresAt: EXPIRES_AT,
        kind: 'openkit-admin-recovery',
        ownerUserId: 'user_active',
      });
      expect(envelope.requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(envelope.tokenId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(envelope.token).toMatch(/^okt_[A-Za-z0-9_-]+$/u);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(tokenRow.token_hash).toMatch(/^sha256:/u);
      expect(JSON.stringify(tokenRow)).not.toContain(envelope.token);
      expect(verifyOpenKitAccessTokenRecord(coreDb, envelope.token, { now: NOW })).toMatchObject({
        ownerUserId: 'user_active',
        scope: 'server-admin',
      });
      expect(auditRow).toMatchObject({
        action: 'auth.admin-recovery.issue',
        outcome: 'succeeded',
        request_id: envelope.requestId,
        resource: `auth-token:${envelope.tokenId}`,
      });
      expect(result).toEqual({
        auditEventId: auditRow.audit_event_id,
        expiresAt: EXPIRES_AT,
        ownerUserId: 'user_active',
        status: 'completed',
        tokenId: envelope.tokenId,
      });
      expect(output).toEqual([`${JSON.stringify(result)}\n`]);
      expect(output.join('')).not.toContain(envelope.token);
      expect(output.join('')).not.toContain(outputPath);
      expect(output.join('')).not.toContain(tokenRow.token_hash);

      const app = new Hono();
      app.use(
        '/api/*',
        createAuthMiddleware('server', undefined, {
          accessTokenVerifier: (secret) => {
            const record = verifyOpenKitAccessTokenRecord(coreDb, secret, { now: NOW });
            return record
              ? {
                  actor: { kind: 'token' as const, userId: record.ownerUserId },
                  tokenId: record.tokenId,
                }
              : null;
          },
        })
      );
      app.get('/api/private', (context) => context.json(context.get('actor')));
      const authenticated = await app.request(
        new Request('http://127.0.0.1/api/private', {
          headers: { authorization: `Bearer ${envelope.token}` },
        })
      );
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toMatchObject({
        kind: 'token',
        tokenId: envelope.tokenId,
        userId: 'user_active',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires exact confirmation and accepts only future expiry through 24 hours', () => {
    const rejectedExpiries = [
      '2026-09-01T23:59:59.999Z',
      NOW.toISOString(),
      '2026-09-03T00:00:00.001Z',
    ];
    for (const expiresAt of rejectedExpiries) {
      const dataRoot = createRecoveryDataRoot();
      const outputPath = join(dataRoot, 'rejected-expiry.json');
      expect(() =>
        runOpenKitOperatorCli(recoveryArgs(dataRoot, outputPath, expiresAt), {
          now: () => NOW,
          write() {},
        })
      ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
      expect(existsSync(outputPath)).toBe(false);
    }

    const confirmationRoot = createRecoveryDataRoot();
    const confirmationPath = join(confirmationRoot, 'confirmation.json');
    const mismatched = recoveryArgs(confirmationRoot, confirmationPath);
    mismatched[mismatched.length - 1] = 'issue-server-admin-token:user_other:wrong-expiry';
    expect(() => runOpenKitOperatorCli(mismatched, { now: () => NOW, write() {} })).toThrow(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(existsSync(confirmationPath)).toBe(false);

    const boundaryRoot = createRecoveryDataRoot();
    const boundaryPath = join(boundaryRoot, 'exact-24-hours.json');
    expect(
      runOpenKitOperatorCli(recoveryArgs(boundaryRoot, boundaryPath, '2026-09-03T00:00:00.000Z'), {
        now: () => NOW,
        write() {},
      })
    ).toMatchObject({ status: 'completed' });
  });

  it('distinguishes a disabled-owner new request from existing recovery attempts', () => {
    const freshRoot = createRecoveryDataRoot();
    const freshPath = join(freshRoot, 'disabled-owner-new.json');
    expect(() =>
      runOpenKitOperatorCli(recoveryArgs(freshRoot, freshPath, EXPIRES_AT, 'user_disabled'), {
        now: () => NOW,
        write() {},
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(existsSync(freshPath)).toBe(false);

    const inactiveRoot = createRecoveryDataRoot();
    const inactivePath = join(inactiveRoot, 'disabled-owner-inactive.json');
    const inactiveArgs = recoveryArgs(inactiveRoot, inactivePath);
    expect(() =>
      runOpenKitOperatorCli(inactiveArgs, {
        now: () => NOW,
        onPhase(phase) {
          if (phase === 'file-published') throw new Error('injected file-first crash');
        },
        write() {},
      })
    ).toThrow('injected file-first crash');
    const inactiveFile = readFileSync(inactivePath, 'utf8');
    disableRecoveryOwner(inactiveRoot);
    expect(() => runOpenKitOperatorCli(inactiveArgs, { now: () => NOW, write() {} })).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(readFileSync(inactivePath, 'utf8')).toBe(inactiveFile);

    const completed = completeRecoveryFixture('disabled-owner-completed.json');
    const completedFile = readFileSync(completed.outputPath, 'utf8');
    disableRecoveryOwner(completed.dataRoot);
    expect(() =>
      runOpenKitOperatorCli(recoveryArgs(completed.dataRoot, completed.outputPath), {
        now: () => NOW,
        write() {},
      })
    ).toThrow(expect.objectContaining({ code: 'recovery_required' }));
    expect(readFileSync(completed.outputPath, 'utf8')).toBe(completedFile);
  });

  it('fails closed without mutation for linked and nonregular output paths', () => {
    for (const kind of ['symlink', 'directory'] as const) {
      const dataRoot = createRecoveryDataRoot();
      const outputRoot = mkdtempSync(join(tmpdir(), 'openkit-admin-recovery-output-'));
      const outputPath = join(outputRoot, `${kind}-output`);
      const targetPath = join(outputRoot, 'symlink-target.json');
      if (kind === 'symlink') {
        writeFileSync(targetPath, 'occupied\n', 'utf8');
        symlinkSync(targetPath, outputPath);
      } else {
        mkdirSync(outputPath);
      }

      expect(
        () =>
          runOpenKitOperatorCli(recoveryArgs(dataRoot, outputPath), {
            now: () => NOW,
            write() {},
          }),
        kind
      ).toThrow(expect.objectContaining({ code: 'recovery_required' }));
      if (kind === 'symlink') {
        expect(readFileSync(targetPath, 'utf8'), kind).toBe('occupied\n');
      } else {
        expect(statSync(outputPath).isDirectory(), kind).toBe(true);
      }

      const coreDb = openCoreDb(dataRoot);
      try {
        expect(
          coreDb.sqlite.prepare('SELECT count(*) AS count FROM openkit_access_tokens').get(),
          kind
        ).toEqual({ count: 0 });
        expect(
          coreDb.sqlite
            .prepare(
              "SELECT count(*) AS count FROM audit_events WHERE action = 'auth.admin-recovery.issue'"
            )
            .get(),
          kind
        ).toEqual({ count: 0 });
      } finally {
        coreDb.sqlite.close();
      }
    }
  });

  it('retains the lock against a concurrent NanoCore acquisition without service startup', () => {
    const dataRoot = createRecoveryDataRoot();
    let checked = false;

    runOpenKitOperatorCli(['admin', 'recovery-users', '--data-root', dataRoot], {
      onPhase(phase) {
        if (phase !== 'locked') return;
        checked = true;
        expect(() =>
          acquireDataRootLock(dataRoot, { bootId: 'concurrent-process-local-probe' })
        ).toThrow(DataRootLockError);
      },
      write() {},
    });

    expect(checked).toBe(true);
    expect(existsSync(dataRootLockPath(dataRoot))).toBe(false);
  });

  it('reports a held lock without preparing or changing the existing layout', () => {
    const dataRoot = createRecoveryDataRoot();
    const configPath = join(dataRoot, 'config', 'server.jsonc');
    const lock = acquireDataRootLock(dataRoot, { bootId: 'existing-holder' });
    unlinkSync(configPath);

    try {
      expect(() =>
        runOpenKitOperatorCli(['admin', 'recovery-users', '--data-root', dataRoot], {
          write() {},
        })
      ).toThrow(expect.objectContaining({ code: 'data_root_locked' }));
      expect(existsSync(configPath)).toBe(false);
    } finally {
      lock.release();
    }
  });

  it('resumes the exact file-first attempt after a pre-transaction crash', () => {
    const dataRoot = createRecoveryDataRoot();
    const outputPath = join(dataRoot, 'file-first-crash.json');
    const args = recoveryArgs(dataRoot, outputPath);

    expect(() =>
      runOpenKitOperatorCli(args, {
        now: () => NOW,
        onPhase(phase) {
          if (phase === 'file-published') throw new Error('injected file-first crash');
        },
        write() {},
      })
    ).toThrow('injected file-first crash');
    const envelopeBefore = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      requestId: string;
      tokenId: string;
      token: string;
    };
    const before = openCoreDb(dataRoot);
    try {
      expect(
        before.sqlite
          .prepare('SELECT count(*) AS count FROM openkit_access_tokens WHERE token_id = ?')
          .get(envelopeBefore.tokenId)
      ).toEqual({ count: 0 });
      expect(
        before.sqlite
          .prepare('SELECT count(*) AS count FROM audit_events WHERE request_id = ?')
          .get(envelopeBefore.requestId)
      ).toEqual({ count: 0 });
    } finally {
      before.sqlite.close();
    }

    const result = runOpenKitOperatorCli(args, { now: () => NOW, write() {} });
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(envelopeBefore);
    expect(result).toMatchObject({ status: 'completed', tokenId: envelopeBefore.tokenId });
  });

  it('re-establishes file and parent durability before retrying a written envelope', () => {
    const dataRoot = createRecoveryDataRoot();
    const outputPath = join(dataRoot, 'pre-sync-crash.json');
    const args = recoveryArgs(dataRoot, outputPath);

    expect(() =>
      runOpenKitOperatorCli(args, {
        now: () => NOW,
        onPhase(phase) {
          if (phase === 'file-written') throw new Error('injected pre-sync crash');
        },
        write() {},
      })
    ).toThrow('injected pre-sync crash');

    const phases: string[] = [];
    runOpenKitOperatorCli(args, {
      now: () => NOW,
      onPhase: (phase) => phases.push(phase),
      write() {},
    });
    expect(phases).toEqual(['locked', 'file-durable', 'transaction-committed']);
  });

  it('requires operator inspection when an inactive published envelope expires', () => {
    const dataRoot = createRecoveryDataRoot();
    const outputPath = join(dataRoot, 'expired-inactive.json');
    const args = recoveryArgs(dataRoot, outputPath);

    expect(() =>
      runOpenKitOperatorCli(args, {
        now: () => NOW,
        onPhase(phase) {
          if (phase === 'file-published') throw new Error('injected file-first crash');
        },
        write() {},
      })
    ).toThrow('injected file-first crash');
    const published = readFileSync(outputPath, 'utf8');

    expect(() =>
      runOpenKitOperatorCli(args, {
        now: () => new Date(EXPIRES_AT),
        write() {},
      })
    ).toThrow(expect.objectContaining({ code: 'recovery_required' }));
    expect(readFileSync(outputPath, 'utf8')).toBe(published);
  });

  it('rejects a malformed inactive envelope without creating durable records', () => {
    const dataRoot = createRecoveryDataRoot();
    const outputPath = join(dataRoot, 'malformed-inactive.json');
    const args = recoveryArgs(dataRoot, outputPath);

    expect(() =>
      runOpenKitOperatorCli(args, {
        now: () => NOW,
        onPhase(phase) {
          if (phase === 'file-published') throw new Error('injected file-first crash');
        },
        write() {},
      })
    ).toThrow('injected file-first crash');
    const original = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      requestId: string;
      tokenId: string;
    };
    writeFileSync(outputPath, `${JSON.stringify({ ...original, extra: true })}\n`, 'utf8');
    const malformed = readFileSync(outputPath, 'utf8');

    expect(() => runOpenKitOperatorCli(args, { now: () => NOW, write() {} })).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(malformed);
    const coreDb = openCoreDb(dataRoot);
    try {
      expect(
        coreDb.sqlite
          .prepare('SELECT count(*) AS count FROM openkit_access_tokens WHERE token_id = ?')
          .get(original.tokenId)
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite
          .prepare('SELECT count(*) AS count FROM audit_events WHERE request_id = ?')
          .get(original.requestId)
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed for contradictory Token, Audit, file, and retry-input states', () => {
    const cases = [
      {
        name: 'token-hash-mismatch',
        mutate(
          coreDb: ReturnType<typeof openCoreDb>,
          fixture: ReturnType<typeof completeRecoveryFixture>
        ) {
          coreDb.sqlite
            .prepare('UPDATE openkit_access_tokens SET token_hash = ? WHERE token_id = ?')
            .run(`sha256:${'0'.repeat(64)}`, fixture.envelope.tokenId);
        },
        tokenCount: 1,
        auditCount: 1,
      },
      {
        name: 'token-without-audit',
        mutate(
          coreDb: ReturnType<typeof openCoreDb>,
          fixture: ReturnType<typeof completeRecoveryFixture>
        ) {
          coreDb.sqlite
            .prepare('DELETE FROM audit_events WHERE request_id = ?')
            .run(fixture.envelope.requestId);
        },
        tokenCount: 1,
        auditCount: 0,
      },
      {
        name: 'audit-without-token',
        mutate(
          coreDb: ReturnType<typeof openCoreDb>,
          fixture: ReturnType<typeof completeRecoveryFixture>
        ) {
          coreDb.sqlite
            .prepare('DELETE FROM openkit_access_tokens WHERE token_id = ?')
            .run(fixture.envelope.tokenId);
        },
        tokenCount: 0,
        auditCount: 1,
      },
      {
        name: 'workspace-owned-audit',
        mutate(
          coreDb: ReturnType<typeof openCoreDb>,
          fixture: ReturnType<typeof completeRecoveryFixture>
        ) {
          coreDb.sqlite
            .prepare('UPDATE audit_events SET workspace_id = ? WHERE request_id = ?')
            .run('ws_contradiction', fixture.envelope.requestId);
        },
        tokenCount: 1,
        auditCount: 1,
      },
      {
        name: 'retained-token-with-lost-file-and-audit',
        mutate(
          coreDb: ReturnType<typeof openCoreDb>,
          fixture: ReturnType<typeof completeRecoveryFixture>
        ) {
          coreDb.sqlite
            .prepare('DELETE FROM audit_events WHERE request_id = ?')
            .run(fixture.envelope.requestId);
          unlinkSync(fixture.outputPath);
        },
        tokenCount: 1,
        auditCount: 0,
      },
      {
        name: 'changed-retry-expiry',
        mutate() {},
        expiresAt: '2026-09-02T13:00:00.000Z',
        tokenCount: 1,
        auditCount: 1,
      },
    ];

    for (const testCase of cases) {
      const fixture = completeRecoveryFixture(`${testCase.name}.json`);
      const originalFile = readFileSync(fixture.outputPath, 'utf8');
      const coreDb = openCoreDb(fixture.dataRoot);
      try {
        testCase.mutate(coreDb, fixture);
      } finally {
        coreDb.sqlite.close();
      }

      expect(
        () =>
          runOpenKitOperatorCli(
            recoveryArgs(fixture.dataRoot, fixture.outputPath, testCase.expiresAt ?? EXPIRES_AT),
            { now: () => NOW, write() {} }
          ),
        testCase.name
      ).toThrow(expect.objectContaining({ code: 'recovery_required' }));
      if (testCase.name === 'retained-token-with-lost-file-and-audit') {
        expect(existsSync(fixture.outputPath), testCase.name).toBe(false);
      } else {
        expect(readFileSync(fixture.outputPath, 'utf8'), testCase.name).toBe(originalFile);
      }

      const after = openCoreDb(fixture.dataRoot);
      try {
        expect(
          after.sqlite
            .prepare('SELECT count(*) AS count FROM openkit_access_tokens WHERE token_id = ?')
            .get(fixture.envelope.tokenId),
          testCase.name
        ).toEqual({ count: testCase.tokenCount });
        expect(
          after.sqlite
            .prepare('SELECT count(*) AS count FROM audit_events WHERE request_id = ?')
            .get(fixture.envelope.requestId),
          testCase.name
        ).toEqual({ count: testCase.auditCount });
      } finally {
        after.sqlite.close();
      }
    }
  });

  it('returns the same completed summary after a post-commit crash without duplicates', () => {
    const dataRoot = createRecoveryDataRoot();
    const outputPath = join(dataRoot, 'post-commit-crash.json');
    const args = recoveryArgs(dataRoot, outputPath);

    expect(() =>
      runOpenKitOperatorCli(args, {
        now: () => NOW,
        onPhase(phase) {
          if (phase === 'transaction-committed') throw new Error('injected post-commit crash');
        },
        write() {},
      })
    ).toThrow('injected post-commit crash');
    const envelope = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      requestId: string;
      tokenId: string;
    };
    const result = runOpenKitOperatorCli(args, { now: () => NOW, write() {} });
    const coreDb = openCoreDb(dataRoot);
    try {
      expect(result).toMatchObject({ status: 'completed', tokenId: envelope.tokenId });
      expect(
        coreDb.sqlite
          .prepare('SELECT count(*) AS count FROM openkit_access_tokens WHERE token_id = ?')
          .get(envelope.tokenId)
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite
          .prepare('SELECT count(*) AS count FROM audit_events WHERE request_id = ?')
          .get(envelope.requestId)
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
