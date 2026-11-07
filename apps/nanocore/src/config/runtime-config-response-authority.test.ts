// openkit-test-platform: posix
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRuntimeConfigManager } from './runtime-config.js';
import { RuntimeConfigFileService, RuntimeConfigFileServiceError } from './runtime-config-files.js';

/**
 * The configuration identity owner requires revision-protected writes. The Web
 * ConfigurationScreen saves its submitted content with the returned revision;
 * a later author's revision must never authorize that editor's next save.
 * This L1 check uses real files and CAS, not an HTTP or native FULL-ACK double.
 * See docs/specs/20260628-nanocore_config_identity_contract.md, Current Contract
 * and Implementation Projection; ConfigurationScreen.tsx:95-119.
 */
it.each(['create', 'update'] as const)(
  '%s returns its own published revision after an external Audit wait',
  async (operation) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-response-authority-'));
    let releaseAudit = () => {};
    const auditHold = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let signalAudit = () => {};
    const auditEntered = new Promise<void>((resolve) => {
      signalAudit = resolve;
    });
    let auditTask: Promise<void> | undefined;
    let pendingA: Promise<Awaited<ReturnType<RuntimeConfigFileService['createFile']>>> | undefined;
    let authorityCalls = 0;
    let aSettled = false;
    try {
      const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
      const id = `workspaces/${workspaceId}/data-sources.jsonc`;
      const filePath = join(dataRoot, 'workspaces', workspaceId, 'config/data-sources.jsonc');
      const manager = createRuntimeConfigManager({ dataRoot });
      const options = {
        dataRoot,
        workspaceIds: [workspaceId],
        userId: 'user_00000000-0000-7000-8000-000000000002',
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      };
      const source = {
        id: 'repo_default',
        kind: 'git',
        displayName: 'Initial source',
        locator: { repositoryResourceId: 'repo_default' },
        access: 'read-only',
        sensitivity: 'internal',
        allowedSlotKinds: ['worktree'],
        status: 'active',
      };
      const initialContent = JSON.stringify({ schemaVersion: 1, sources: [source] });
      const aSource = { ...source, access: 'read-write', displayName: 'A source' };
      const aContent = JSON.stringify({ schemaVersion: 1, sources: [aSource] });
      const bContent = JSON.stringify({
        schemaVersion: 1,
        sources: [{ ...aSource, displayName: 'B descriptive edit' }],
      });
      const nextAContent = JSON.stringify({
        schemaVersion: 1,
        sources: [{ ...aSource, displayName: 'A next draft without B' }],
      });
      // Setup uses the file owner, not a manufactured file, SQL row or receipt.
      const setup = new RuntimeConfigFileService(options);
      if (operation === 'update') {
        await setup.createFile({ id, kind: 'data-source', content: initialContent });
      }
      const initialRevision = operation === 'update' ? setup.readFile(id).file.revision : null;
      const onDataSourceAuthorityChange = () => {
        authorityCalls += 1;
        // Audit is outside FilesService ownership. Only its completion is staged;
        // no file publication, CAS, authority decision or native ACK is mocked.
        auditTask = auditHold.then(() => {});
        signalAudit();
        return auditTask;
      };
      const a = new RuntimeConfigFileService({ ...options, onDataSourceAuthorityChange });
      const b = new RuntimeConfigFileService({ ...options, onDataSourceAuthorityChange });
      pendingA = Promise.resolve().then(() => {
        const input = {
          id,
          kind: 'data-source' as const,
          content: aContent,
          expectedRevision: initialRevision,
        };
        return operation === 'create' ? a.createFile(input) : a.updateFile(input);
      });
      void pendingA.then(
        () => {
          aSettled = true;
        },
        () => {
          aSettled = true;
        }
      );
      const reachedAudit = await Promise.race([
        auditEntered.then(() => true),
        pendingA.then(() => false),
      ]);
      expect(reachedAudit, 'Authority-changing publication must reach the external Audit.').toBe(
        true
      );
      expect(
        aSettled,
        'PUBLIC_OLD_AUDIT_AWAIT_UNREACHED: synchronous OLD cannot stage this overlap.'
      ).toBe(false);
      expect(authorityCalls).toBe(1);
      const readA = b.readFile(id);
      expect(readA.content).toBe(aContent);
      expect(readA.file.revision).not.toBeNull();
      expect(readFileSync(filePath, 'utf8')).toBe(aContent);
      await b.updateFile({
        id,
        kind: 'data-source',
        content: bContent,
        expectedRevision: readA.file.revision,
      });
      const readB = b.readFile(id);
      expect(readB.content).toBe(bContent);
      expect(readB.file.revision).not.toBe(readA.file.revision);
      expect(authorityCalls).toBe(1);
      expect(aSettled, 'B must publish while A is still pending.').toBe(false);
      releaseAudit();
      const writtenA = await pendingA;
      // Match the actual Web consumer: retain A's saved content and returned token.
      let refusal: unknown;
      try {
        await a.updateFile({
          id,
          kind: 'data-source',
          content: nextAContent,
          expectedRevision: writtenA.file.revision,
        });
      } catch (error) {
        refusal = error;
      }
      expect.soft(writtenA.file.revision).toBe(readA.file.revision);
      expect.soft(writtenA.file.revision).not.toBe(readB.file.revision);
      expect.soft(refusal).toBeInstanceOf(RuntimeConfigFileServiceError);
      expect.soft(refusal).toMatchObject({ status: 409, code: 'config_revision_conflict' });
      expect(a.readFile(id)).toMatchObject({
        content: bContent,
        file: { revision: readB.file.revision },
      });
      expect(readFileSync(filePath, 'utf8')).toBe(bContent);
      expect(authorityCalls).toBe(1);
    } finally {
      releaseAudit();
      await Promise.allSettled([pendingA, auditTask]);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
);
