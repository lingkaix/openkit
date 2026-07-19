import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { seedDemoWorkspaceDataRoot } from '../support/demo-data.mjs';

test('seeds demo workspaces through canonical file records', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-demo-data-'));

  try {
    seedDemoWorkspaceDataRoot(dataRoot);
    seedDemoWorkspaceDataRoot(dataRoot);

    const demoRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const quickChatRoot = join(dataRoot, 'workspaces', 'ws_quick_chat');

    assert.equal(existsSync(join(demoRoot, 'store.json')), false);
    assert.equal(JSON.parse(readFileSync(join(demoRoot, 'workspace.json'), 'utf8')).id, 'ws_demo');
    assert.equal(
      JSON.parse(readFileSync(join(quickChatRoot, 'workspace.json'), 'utf8')).id,
      'ws_quick_chat'
    );
    assert.equal(
      JSON.parse(readFileSync(join(demoRoot, 'threads', 'th_demo', 'thread.json'), 'utf8')).id,
      'th_demo'
    );
    assert.match(
      readFileSync(join(demoRoot, 'knowledge', 'pages', 'mem_project.md'), 'utf8'),
      /openkit_entry_id: "mem_project"/
    );
  } finally {
    await rm(dataRoot, { force: true, recursive: true });
  }
});
