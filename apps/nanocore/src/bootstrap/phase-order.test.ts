import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Extracts boot phase names from the NanoCore process entrypoint.
 *
 * @returns Ordered boot phase names.
 */
function readEntrypointBootPhaseNames(): string[] {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  return Array.from(source.matchAll(/name: '([^']+)'/g), (match) => match[1] ?? '');
}

/**
 * Reads the NanoCore process entrypoint source.
 *
 * @returns Entrypoint source text.
 */
function readEntrypointSource(): string {
  return readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
}

describe('NanoCore boot phase order', () => {
  it('matches the accepted startup phase order', () => {
    expect(readEntrypointBootPhaseNames()).toEqual([
      'config',
      'data-root-layout',
      'instance-lock',
      'migrations',
      'policy-kernel',
      'vault',
      'local-identity',
      'scheduler-restart-recovery',
    ]);

    const source = readEntrypointSource();
    const restartPhase = source.indexOf("name: 'scheduler-restart-recovery'");
    const deletionFence = source.indexOf(
      'restoreWorkspaceDeletionMutationAdmission({',
      restartPhase
    );
    const runtimeFence = source.indexOf('fenceNanoHostRuntimeTargetAfterRestart(', restartPhase);
    expect(deletionFence).toBeGreaterThan(restartPhase);
    expect(runtimeFence).toBeGreaterThan(deletionFence);
  });

  it('preserves stopped scheduler hooks when shutdown hits the deadline', () => {
    const source = readEntrypointSource();

    expect(source).toContain('const stepsCompleted = [');
    expect(source).toContain(
      "onDeadline: () => finishShutdown(signal, [...stepsCompleted, 'shutdown.deadline'], true, 1)"
    );
  });

  it('validates listener and server-auth inputs before activating copied templates', () => {
    const source = readEntrypointSource();
    const configPhase = source.indexOf("name: 'config'");
    const initialConfigLoad = source.indexOf(
      'runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 })',
      configPhase
    );
    const bindValidation = source.indexOf('resolveBindPort(process.env', configPhase);
    const secretValidation = source.indexOf('resolveBetterAuthSecret(process.env', configPhase);
    const templateWrite = source.indexOf('ensureConfigTemplateSurface(dataRoot)', configPhase);
    const finalConfigLoad = source.indexOf(
      'runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 })',
      initialConfigLoad + 1
    );
    const layoutPhase = source.indexOf("name: 'data-root-layout'", configPhase);

    expect(initialConfigLoad).toBeGreaterThan(configPhase);
    expect(bindValidation).toBeGreaterThan(configPhase);
    expect(secretValidation).toBeGreaterThan(configPhase);
    expect(initialConfigLoad).toBeLessThan(bindValidation);
    expect(bindValidation).toBeLessThan(templateWrite);
    expect(secretValidation).toBeLessThan(templateWrite);
    expect(templateWrite).toBeLessThan(finalConfigLoad);
    expect(finalConfigLoad).toBeLessThan(layoutPhase);
  });

  it('composes queued scheduler retries with the vault-backed provider credential resolver', () => {
    const source = readEntrypointSource();

    expect(source).toContain(
      'const schedulerProviderCredentialResolver = createVaultProviderCredentialResolver({'
    );
    expect(source).toContain(
      'dependencies: { providerCredentialResolver: schedulerProviderCredentialResolver },'
    );
  });

  it('fails authoritative storage integrity before bootstrap credentials or listener binding', () => {
    const source = readEntrypointSource();
    const migrationsPhase = source.indexOf("name: 'migrations'");
    const coreIntegrityCheck = source.indexOf(
      'coreDb = openCoreDbWithIntegrityCheck(dataRoot)',
      migrationsPhase
    );
    const scopedIntegrityCheck = source.indexOf(
      'verifyAndMigrateExistingScopedDatabases(dataRoot)',
      coreIntegrityCheck
    );
    const criticalFailureGate = source.indexOf(
      'if (criticalBootFailure || !bootReadiness.acceptingProductWork)'
    );
    const bootstrapCredential = source.indexOf(
      'const bootstrap = ensureServerBootstrapToken(coreDb)',
      criticalFailureGate
    );
    const listenerBind = source.indexOf('const appServer = appTlsListen', criticalFailureGate);

    expect(coreIntegrityCheck).toBeGreaterThan(migrationsPhase);
    expect(scopedIntegrityCheck).toBeGreaterThan(coreIntegrityCheck);
    expect(criticalFailureGate).toBeGreaterThan(scopedIntegrityCheck);
    expect(bootstrapCredential).toBeGreaterThan(criticalFailureGate);
    expect(listenerBind).toBeGreaterThan(criticalFailureGate);
    expect(source).not.toContain('storageRecoveryEvents');
    expect(source).not.toContain("code: 'storage.quarantined'");
  });

  it('starts scheduler recovery maintenance only after constructing the ordinary listener', () => {
    const source = readEntrypointSource();
    const listenerConstruction = source.indexOf('const appServer = appTlsListen');
    const nanoHostListenerConstruction = source.indexOf('const nanoHostServer = nanoHostListener');
    const maintenanceStart = source.indexOf(
      'schedulerLeaseMaintenance = startSchedulerLeaseMaintenanceService(coreDb, {'
    );

    expect(listenerConstruction).toBeGreaterThan(-1);
    expect(nanoHostListenerConstruction).toBeGreaterThan(listenerConstruction);
    expect(maintenanceStart).toBeGreaterThan(listenerConstruction);
    expect(maintenanceStart).toBeGreaterThan(nanoHostListenerConstruction);
  });
});
