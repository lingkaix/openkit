import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ChildProcessOpenShellCellCommandRunner,
  type OpenShellCellCommandRunner,
  OpenShellCellController,
} from './openshell-cell.js';

/** Deterministic Cell helper command runner used by controller tests. */
class FakeOpenShellCellCommandRunner implements OpenShellCellCommandRunner {
  public readonly calls: Array<{ args: string[]; command: string }> = [];

  public failure: Error | null = null;

  /**
   * Records one exact helper command.
   *
   * @param command Executable selected by the controller.
   * @param args Exact non-secret helper arguments.
   */
  public async run(command: string, args: readonly string[]): Promise<void> {
    this.calls.push({ args: [...args], command });
    if (this.failure) {
      throw this.failure;
    }
  }
}

describe('OpenShellCellController', () => {
  it.skipIf(process.platform === 'win32')(
    'force-kills same-group descendants before reporting a command timeout',
    async () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-cell-runner-'));
      const markerPath = join(testRoot, 'descendant-survived');
      const descendantSource = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'late'),350)`;
      const leaderSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{detached:false,stdio:'ignore'});setTimeout(()=>{},1000)`;
      const runner = new ChildProcessOpenShellCellCommandRunner(100, 100);

      try {
        await expect(runner.run(process.execPath, ['-e', leaderSource])).rejects.toThrow(
          'timed out after 100ms'
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        rmSync(testRoot, { force: true, recursive: true });
      }
    }
  );

  it('derives a stable non-secret binding for each exact lifecycle target', () => {
    const localA = new OpenShellCellController({ runner: new FakeOpenShellCellCommandRunner() });
    const localB = new OpenShellCellController({ runner: new FakeOpenShellCellCommandRunner() });
    const remote = new OpenShellCellController({
      runner: new FakeOpenShellCellCommandRunner(),
      sshTarget: 'ubuntu@a1',
    });

    expect(localA.targetId).toBe(localB.targetId);
    expect(localA.targetId).toMatch(/^cell-[a-f0-9]{24}$/);
    expect(remote.targetId).toMatch(/^cell-[a-f0-9]{24}$/);
    expect(remote.targetId).not.toBe(localA.targetId);
  });

  it('runs the fixed privileged helper without a shell for prepare and recycle', async () => {
    const runner = new FakeOpenShellCellCommandRunner();
    const controller = new OpenShellCellController({ runner });

    await controller.prepare('aepsnap_cell_owner_1');
    await controller.recycle('aepsnap_cell_owner_1');

    expect(runner.calls).toEqual([
      {
        args: [
          '-n',
          '/usr/local/libexec/openkit-openshell-cell',
          'prepare',
          'aepsnap_cell_owner_1',
        ],
        command: '/usr/bin/sudo',
      },
      {
        args: [
          '-n',
          '/usr/local/libexec/openkit-openshell-cell',
          'recycle',
          'aepsnap_cell_owner_1',
        ],
        command: '/usr/bin/sudo',
      },
    ]);
  });

  it('runs the same fixed helper through a validated remote SSH target', async () => {
    const runner = new FakeOpenShellCellCommandRunner();
    const controller = new OpenShellCellController({ runner, sshTarget: 'ubuntu@a1' });

    await controller.prepare('aepsnap_remote_cell_1');
    await controller.recycle('aepsnap_remote_cell_1');

    expect(runner.calls).toEqual([
      {
        args: [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ForwardAgent=no',
          '-o',
          'ForwardX11=no',
          '-o',
          'PermitLocalCommand=no',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'ServerAliveInterval=10',
          '-o',
          'ServerAliveCountMax=2',
          'ubuntu@a1',
          '/usr/bin/sudo',
          '-n',
          '/usr/local/libexec/openkit-openshell-cell',
          'prepare',
          'aepsnap_remote_cell_1',
        ],
        command: '/usr/bin/ssh',
      },
      {
        args: [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ForwardAgent=no',
          '-o',
          'ForwardX11=no',
          '-o',
          'PermitLocalCommand=no',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'ServerAliveInterval=10',
          '-o',
          'ServerAliveCountMax=2',
          'ubuntu@a1',
          '/usr/bin/sudo',
          '-n',
          '/usr/local/libexec/openkit-openshell-cell',
          'recycle',
          'aepsnap_remote_cell_1',
        ],
        command: '/usr/bin/ssh',
      },
    ]);
  });

  it('rejects an unsafe SSH target before invoking the helper', async () => {
    const runner = new FakeOpenShellCellCommandRunner();

    expect(
      () => new OpenShellCellController({ runner, sshTarget: '-oProxyCommand=malicious' })
    ).toThrow('OpenShell Cell SSH target is invalid.');
    expect(runner.calls).toEqual([]);
  });

  it('rejects an unsafe owner before invoking the helper', async () => {
    const runner = new FakeOpenShellCellCommandRunner();
    const controller = new OpenShellCellController({ runner });

    await expect(controller.prepare('owner; shutdown -h now')).rejects.toThrow(
      'OpenShell Cell owner id is invalid.'
    );
    expect(runner.calls).toEqual([]);
  });

  it('reports a remote timeout as a redacted failed lifecycle call', async () => {
    const runner = new FakeOpenShellCellCommandRunner();
    runner.failure = new Error('ssh timeout with private diagnostics');
    const controller = new OpenShellCellController({ runner, sshTarget: 'ubuntu@a1' });

    const error = await controller.prepare('aepsnap_cell_owner_2').catch((reason) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('OpenShell Cell prepare failed.');
    expect((error as Error).message).not.toContain('private diagnostics');
  });

  it('ships a syntactically valid privileged helper', () => {
    const helperPath = fileURLToPath(new URL('../../scripts/openshell-cell.sh', import.meta.url));

    expect(() => execFileSync('bash', ['-n', helperPath])).not.toThrow();
    const helper = readFileSync(helperPath, 'utf8');
    const stopEpoch = helper.slice(
      helper.indexOf('stop_epoch() {'),
      helper.indexOf('\n}\n\n# Claims')
    );
    const sliceFence = stopEpoch.indexOf('kill --kill-whom=all --signal=SIGKILL "$CELL_SLICE"');
    const finalBridgeProof = stopEpoch.search(/\[\[ ! -e "\/sys\/class\/net\/\$\{bridge\}" \]\]/);
    const rootRemoval = stopEpoch.lastIndexOf(`"$RM" -rf -- "${'$'}{state:?}" "${'$'}{run:?}"`);

    expect(helper).toContain('settings set --global --key providers_v2_enabled --value true --yes');
    expect(helper).toMatch(/"\$DOCKER" network rm "openkit-cell-\$\{epoch\}"/);
    expect(helper).toContain('epoch Gateway service stopped during emptiness verification.');
    expect(helper).toContain('The controller allows 600 seconds, leaving at least 60 seconds');
    expect(helper).toMatch(
      /"\$TIMEOUT" --kill-after=2 "\$remaining" "\$DOCKER" image load --input "\$archive"/
    );
    expect(helper).toMatch(/printf '%s\\n' "\$CURRENT_BOOT_ID" >"\$\{state\}\/boot-id"/);
    expect(helper).toContain(`ACTIVE_CLEANUP_PHASE="${'$'}{fields[4]}"`);
    expect(helper).toContain(`ACTIVE_CLEANUP_BRIDGE="${'$'}{fields[5]}"`);
    expect(stopEpoch).toContain('if [[ "$ACTIVE_CLEANUP_PHASE" == \'fenced\' ]]');
    expect(stopEpoch).toContain(`'fenced' "${'$'}{bridge:--}"`);
    expect(stopEpoch).toContain('if [[ "$stored_boot_id" == "$CURRENT_BOOT_ID" ]]');
    expect(stopEpoch).toContain("fail 'dedicated Docker state is unavailable for cleanup.'");
    expect(stopEpoch).toContain("fail 'epoch Docker network inspection failed.'");
    expect(stopEpoch).not.toMatch(/network inspect[\s\S]{0,160}\|\| true/);
    expect(stopEpoch).toContain("fail 'epoch Docker bridge was recreated during teardown.'");
    expect(sliceFence).toBeGreaterThan(-1);
    expect(finalBridgeProof).toBeGreaterThan(sliceFence);
    expect(rootRemoval).toBeGreaterThan(finalBridgeProof);
  });
});
