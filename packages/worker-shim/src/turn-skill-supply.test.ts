// openkit-test-platform: posix
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashOpenKitTreeEntries } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeSessionWorkspace } from './turn.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** Prepares an admitted complete tree independently of the installed filesystem walk. */
function skillFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-installed-skill-'));
  roots.push(root);
  const targetPath = join(root, 'source');
  mkdirSync(join(targetPath, 'empty'), { recursive: true });
  const markdown = Buffer.from(
    '---\nname: sample\ndescription: Read supporting content.\n---\nUse run.sh.\n'
  );
  const script = Buffer.from('#!/bin/sh\ncat message.txt\n');
  const support = Buffer.from('Selected version content.\n');
  writeFileSync(join(targetPath, 'SKILL.md'), markdown, { mode: 0o600 });
  writeFileSync(join(targetPath, 'run.sh'), script, { mode: 0o700 });
  writeFileSync(join(targetPath, 'message.txt'), support, { mode: 0o600 });
  const digest = hashOpenKitTreeEntries([
    { path: 'SKILL.md', kind: 1, content: markdown },
    { path: 'empty', kind: 0 },
    { path: 'run.sh', kind: 2, content: script },
    { path: 'message.txt', kind: 1, content: support },
  ]);
  const identity = {
    agentSessionId: allocateEntityId('as'),
    threadId: allocateEntityId('th'),
    workspaceId: allocateEntityId('ws'),
  };
  const workspace = join(root, 'workspace');
  const workSlot = join(workspace, 'work');
  const packagePath = join(root, 'package.json');
  writeFileSync(
    packagePath,
    JSON.stringify({
      scope: identity,
      supply: {
        skills: [
          {
            id: 'selected-skill',
            digestFormat: 'openkit-tree-v1',
            integrity: { sha256: digest },
            materialization: { kind: 'filesystem-copy', targetPath },
          },
        ],
      },
      workspace: { root: workspace, inputs: [] },
      extensions: {
        openkit: {
          sessionWorkspace: {
            layout: { slots: [{ kind: 'worktree', access: 'read-write', path: workSlot }] },
          },
        },
      },
    })
  );
  return { identity, packagePath, root, targetPath, workSlot };
}

describe('complete installed Skill verification', () => {
  it('accepts supporting bytes, normalized executability and an empty directory before workspace setup', async () => {
    const f = skillFixture();
    await expect(
      initializeSessionWorkspace(f.packagePath, join(f.root, 'session'), f.identity)
    ).resolves.toBeNull();
    expect(existsSync(f.workSlot)).toBe(true);
  });

  it.each([
    'supporting bytes',
    'empty directory',
    'executable flag',
  ] as const)('refuses changed %s before workspace setup', async (changed) => {
    const f = skillFixture();
    if (changed === 'supporting bytes')
      writeFileSync(join(f.targetPath, 'message.txt'), 'Changed.');
    if (changed === 'empty directory') rmSync(join(f.targetPath, 'empty'), { recursive: true });
    if (changed === 'executable flag') chmodSync(join(f.targetPath, 'run.sh'), 0o600);
    await expect(
      initializeSessionWorkspace(f.packagePath, join(f.root, 'session'), f.identity)
    ).rejects.toThrow('Installed Skill tree does not match its admitted digest.');
    expect(existsSync(f.workSlot)).toBe(false);
  });
});
