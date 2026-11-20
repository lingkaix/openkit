import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runOpenKitOperatorCli } from '../auth/admin-recovery.js';
import { openCoreDb } from './db.js';
import {
  applyDiscordReportsOperatorCommand,
  type DiscordReportsOperatorCommand,
  getOrCreateDiscordReportsPrincipal,
  readDiscordReportsBindingRevision,
} from './discord-reports-bindings.js';
import { applyMigrations } from './migrate.js';

const target = {
  guildId: '123',
  channelId: '234',
  botUserId: '345',
  audienceRef: 'exact-audience',
  workspaceId: 'workspace',
  accountableUserId: 'member',
  collectionSetRevision: 'c1',
  roles: [
    {
      definitionId: 'reports',
      definitionRevision: 'd1',
      slotCollections: {
        facts: { collectionId: 'facts', collectionRevision: 'f1' },
        brief: { collectionId: 'brief', collectionRevision: 'b1' },
      },
    },
  ],
};

it('runs operator commands through migrated Core and fences stale, widened and replaced binding authority', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'discord-binding-'));
  let publish = true;
  let manage = true;
  try {
    const db = openCoreDb(dataRoot);
    applyMigrations(db);
    db.sqlite.close();
    const run = (request: DiscordReportsOperatorCommand) =>
      runOpenKitOperatorCli(
        ['discord', 'reports', '--data-root', dataRoot, '--request', JSON.stringify(request)],
        {
          write: () => {},
          discordReports: async (coreDb, input) =>
            applyDiscordReportsOperatorCommand(coreDb.sqlite, input, {
              manage: (value) => manage && value.workspaceId === target.workspaceId,
              publish: (value) =>
                publish &&
                value.audienceRef === target.audienceRef &&
                value.roles[0]?.definitionRevision === 'd1',
            }),
        }
      );
    const draft = await run({ operation: 'create', target });
    if (!draft || !('bindingRevision' in draft)) throw new Error('expected draft');
    expect(await run({ operation: 'read', bindingId: draft.bindingId })).toEqual(draft);
    const activate = {
      operation: 'activate' as const,
      bindingId: draft.bindingId,
      expectedRevision: draft.bindingRevision,
    };
    await expect(run({ ...activate, expectedRevision: 'stale' })).rejects.toThrow('refused');
    publish = false;
    await expect(run(activate)).rejects.toThrow('refused');
    publish = true;
    const active = await run(activate);
    if (!active || !('bindingRevision' in active)) throw new Error('expected active binding');
    const other = await run({ operation: 'create', target });
    if (!other || !('bindingRevision' in other)) throw new Error('expected second draft');
    await expect(
      run({
        operation: 'activate',
        bindingId: other.bindingId,
        expectedRevision: other.bindingRevision,
      })
    ).rejects.toThrow('refused');
    await expect(
      run({
        operation: 'narrow',
        bindingId: active.bindingId,
        expectedRevision: active.bindingRevision,
        roles: target.roles,
        collectionSetRevision: 'c2',
      })
    ).rejects.toThrow('refused');
    const personDb = openCoreDb(dataRoot);
    const principal = personDb.sqlite
      .transaction(() => getOrCreateDiscordReportsPrincipal(personDb.sqlite, active, '456'))
      .immediate();
    personDb.sqlite.close();
    if (!principal) throw new Error('expected basic principal');
    expect(principal.tier).toBe('basic');
    const tier = {
      operation: 'tier' as const,
      bindingId: active.bindingId,
      expectedRevision: active.bindingRevision,
      principalId: principal.principalId,
      expectedTierRevision: principal.tierRevision,
      tier: 'expanded' as const,
    };
    expect(await run(tier)).toMatchObject({ principalId: principal.principalId, tier: 'expanded' });
    await expect(run(tier)).rejects.toThrow('refused');
    const narrowed = await run({
      operation: 'narrow',
      bindingId: active.bindingId,
      expectedRevision: active.bindingRevision,
      roles: [
        { ...target.roles[0]!, slotCollections: { facts: target.roles[0]!.slotCollections.facts } },
      ],
      collectionSetRevision: 'c2',
    });
    if (!narrowed || !('bindingRevision' in narrowed)) throw new Error('expected narrowed binding');
    const revoke = {
      operation: 'revoke' as const,
      bindingId: active.bindingId,
      expectedRevision: narrowed.bindingRevision,
    };
    publish = false;
    manage = false;
    await expect(run(revoke)).rejects.toThrow('refused');
    manage = true;
    const revoked = await run(revoke);
    expect(revoked).toMatchObject({ state: 'revoked' });
    publish = true;
    const replacement = await run({
      operation: 'activate',
      bindingId: other.bindingId,
      expectedRevision: other.bindingRevision,
    });
    if (!replacement || !('bindingRevision' in replacement))
      throw new Error('expected replacement');
    expect(replacement.bindingId).not.toBe(active.bindingId);
    const finalDb = openCoreDb(dataRoot);
    expect(
      readDiscordReportsBindingRevision(finalDb.sqlite, active.bindingId, active.bindingRevision)
    ).toEqual(active);
    expect(
      readDiscordReportsBindingRevision(
        finalDb.sqlite,
        narrowed.bindingId,
        narrowed.bindingRevision
      )
    ).toEqual(narrowed);
    const newPrincipal = finalDb.sqlite
      .transaction(() => getOrCreateDiscordReportsPrincipal(finalDb.sqlite, replacement, '456'))
      .immediate();
    finalDb.sqlite.close();
    expect(newPrincipal).toMatchObject({
      tier: 'basic',
      principalId: expect.not.stringMatching(principal.principalId),
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
