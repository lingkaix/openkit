import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { resolvePublicNativeEnvironment } from './native-environment.js';
import { TurnStartValidationError } from './orchestrator.js';
import {
  admitWorkerImageEnvironment,
  writeWorkerImageSettlement,
} from './worker-image-settlements.js';

const imageDigest = `sha256:${'d'.repeat(64)}`;
const roots: string[] = [];
const dbs: CoreDb[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => {
    db.sqlite.close();
  });
  roots.splice(0).forEach((root) => {
    rmSync(root, { force: true, recursive: true });
  });
});

/** One actual authored manifest, not an environment-specific parallel setup format. */
function nativeEnvironmentManifest(environment: Record<string, string | null> = {}) {
  return AuthoredAgentConfigSchema.parse({
    schemaVersion: 1,
    id: 'agent_native',
    displayName: 'Native',
    models: { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: ['reasoning'] },
    runtime: {
      adapter: 'pi',
      kind: 'pi',
      image: { kind: 'reference', pullPolicy: 'never', ref: imageDigest },
      environment,
      binaries: [
        { id: 'shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'pi', path: '/usr/local/bin/pi' },
      ],
    },
    sandbox: { network: [] },
  });
}

/** Admits synthetic non-secret defaults through the production settlement path. */
function fixture(
  values: Record<string, string> = { DEFAULT: 'from-image', EMPTY: '', HOME: '/image/home' }
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-resolution-'));
  roots.push(root);
  const db = openCoreDb(root);
  dbs.push(db);
  applyMigrations(db);
  const candidate = {
    authoredArtifactId: 'ar_native',
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: `sha256:${'a'.repeat(64)}`,
    inputDigest: `sha256:${'b'.repeat(64)}`,
  };
  const defaultsDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;
  writeWorkerImageSettlement(db, {
    ...candidate,
    requestId: '1'.repeat(64),
    operation: 'image.acquire',
    outcome: { kind: 'success', imageDigest },
  });
  return { db, candidate, defaults: { imageDigest, defaultsDigest, values } };
}

describe('public native environment resolution', () => {
  it('blocks absent or merely acquired defaults without dispatching any image effect', () => {
    const f = fixture();
    expect(() => resolvePublicNativeEnvironment(undefined, nativeEnvironmentManifest())).toThrow(
      'Core storage is unavailable'
    );
    expect(() => resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest())).toThrow(
      new TurnStartValidationError(
        'worker_environment_preparation_required',
        'Agent "agent_native" requires Worker environment preparation and activation before starting work; verified image defaults are unavailable.',
        409
      )
    );
  });
  it('keeps corrupt admitted defaults distinct from missing preparation', () => {
    const f = fixture();
    f.db.sqlite
      .prepare('UPDATE worker_image_settlements SET native_environment_json = ?')
      .run('{invalid-json');
    expect(() => resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest())).toThrow(
      SyntaxError
    );
  });
  it('inherits, overrides, suppresses and restores empty/literal values while excluding managed defaults', () => {
    const f = fixture();
    admitWorkerImageEnvironment(f.db, f.candidate, f.defaults);
    expect(
      resolvePublicNativeEnvironment(
        f.db,
        nativeEnvironmentManifest({ DEFAULT: null, NEW_SETTING: 'x=y\n', EMPTY: '' })
      )
    ).toEqual({
      imageDigest,
      defaultsDigest: f.defaults.defaultsDigest,
      values: { EMPTY: '', NEW_SETTING: 'x=y\n' },
    });
    expect(
      resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest({ DEFAULT: 'from-image' }))
    ).toEqual(resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest()));
    expect(resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest()).values).toEqual({
      DEFAULT: 'from-image',
      EMPTY: '',
    });
  });
  it('refuses protected overrides and credential collisions, including null removals', () => {
    const f = fixture();
    admitWorkerImageEnvironment(f.db, f.candidate, f.defaults);
    expect(() => nativeEnvironmentManifest({ HOME: null })).toThrow();
    const protectedManifest = nativeEnvironmentManifest();
    protectedManifest.runtime.environment = { HOME: null };
    expect(() => resolvePublicNativeEnvironment(f.db, protectedManifest)).toThrow(
      'authority conflict'
    );
    const manifest = nativeEnvironmentManifest({ DEFAULT: null });
    manifest.sandbox.credentialDeclarations = [
      {
        id: 'credential',
        visibility: 'runtime-env',
        targetEnvVarName: 'DEFAULT',
        grantRef: 'grant',
      },
    ];
    expect(() => resolvePublicNativeEnvironment(f.db, manifest)).toThrow('authority conflict');
    manifest.runtime.environment = {};
    expect(() => resolvePublicNativeEnvironment(f.db, manifest)).toThrow('credential collision');
  });
  it.each([
    'DSH_HOME',
    'DSH_PERMISSION_MODE',
    'DSH_TELEMETRY_MODE',
    'DSH_TELEMETRY_OTLP_URL',
  ])('refuses DeepSeek public override or removal of %s at resolution', (name) => {
    const f = fixture();
    admitWorkerImageEnvironment(f.db, f.candidate, f.defaults);
    const manifest = nativeEnvironmentManifest();
    manifest.runtime.adapter = 'deepseek';
    for (const value of ['literal-canary', null]) {
      manifest.runtime.environment = { [name]: value };
      expect(() => resolvePublicNativeEnvironment(f.db, manifest)).toThrow('authority conflict');
    }
  });
  it('filters DeepSeek managed image defaults while resolving ordinary public settings', () => {
    const f = fixture({
      DSH_HOME: 'image-home',
      DSH_PERMISSION_MODE: 'image-mode',
      DSH_TELEMETRY_MODE: 'image-telemetry',
      DSH_TELEMETRY_OTLP_URL: 'image-url',
      DSH_PUBLIC_SETTING: 'from-image',
    });
    admitWorkerImageEnvironment(f.db, f.candidate, f.defaults);
    const manifest = nativeEnvironmentManifest({ DSH_PUBLIC_SETTING: 'public-canary' });
    manifest.runtime.adapter = 'deepseek';
    expect(resolvePublicNativeEnvironment(f.db, manifest)).toEqual({
      imageDigest,
      defaultsDigest: f.defaults.defaultsDigest,
      values: { DSH_PUBLIC_SETTING: 'public-canary' },
    });
  });
  it('resolves prototype-looking names literally instead of assigning object authority', () => {
    const f = fixture();
    admitWorkerImageEnvironment(f.db, f.candidate, f.defaults);
    const overrides = JSON.parse('{"__proto__":"literal","constructor":"own"}');
    expect(
      resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest(overrides)).values
    ).toMatchObject(overrides);
  });
  it('refuses a combined map outside the final bound even when both inputs fit separately', () => {
    const f = fixture(
      Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`DEFAULT_${i}`, '']))
    );
    admitWorkerImageEnvironment(f.db, f.candidate, f.defaults);
    expect(() =>
      resolvePublicNativeEnvironment(f.db, nativeEnvironmentManifest({ EXTRA: 'x' }))
    ).toThrow();
  });
});
