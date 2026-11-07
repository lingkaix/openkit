import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Temp data root for the local-speech oracles. Test support is outside the storage census. */
export function createLocalAiOracleDataRoot(input: {
  readonly mode: 'local' | 'server';
  readonly gateway: unknown;
  readonly providers: readonly { readonly name: string; readonly profile: unknown }[];
}): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-local-ai-p1-'));
  mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'server.jsonc'),
    JSON.stringify({ schemaVersion: 1, mode: input.mode })
  );
  writeFileSync(join(dataRoot, 'config', 'gateway.jsonc'), JSON.stringify(input.gateway));
  for (const provider of input.providers) {
    writeFileSync(
      join(dataRoot, 'config', 'providers', provider.name),
      JSON.stringify(provider.profile)
    );
  }
  return dataRoot;
}

/** Removes one oracle data root after the supervisor and databases are closed. */
export function removeLocalAiOracleDataRoot(dataRoot: string): void {
  rmSync(dataRoot, { force: true, recursive: true });
}
