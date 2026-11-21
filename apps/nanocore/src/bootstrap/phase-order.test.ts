import { readFileSync } from 'node:fs';
import {
  createSourceFile,
  isFunctionDeclaration,
  isIfStatement,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from 'typescript6';
import { describe, expect, it, vi } from 'vitest';
import { runBootPhases } from './phases.js';
import {
  computeBootReadinessSnapshot,
  createShutdownReadinessSnapshot,
  withScopeAdmissionReadiness,
} from './readiness.js';
import { closeWithDeadline } from './shutdown.js';

/**
 * Reads the NanoCore process entrypoint source.
 *
 * @returns Entrypoint source text.
 */
function readEntrypointSource(): string {
  return readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
}

/**
 * Evaluates listener closure with the completion continuation now owned by shutdown.
 *
 * @param bindings Free variables closed over by the entrypoint function.
 * @returns The extracted close function.
 */
function evaluateCloseNanoCoreListeners(bindings: {
  shutdownTelemetry: () => Promise<void>;
  workerMcpGateway: { close: () => Promise<unknown> } | undefined;
  appServer: { close: (callback: () => void) => void } | undefined;
  nanoHostServer: { close: (callback: () => void) => void } | null;
}): (onClosed: () => void) => void {
  const sourceFile = createSourceFile(
    'index.ts',
    readEntrypointSource(),
    ScriptTarget.Latest,
    true
  );
  const declaration = sourceFile.statements.find(
    (statement) =>
      isFunctionDeclaration(statement) && statement.name?.text === 'closeNanoCoreListeners'
  );
  if (!declaration) {
    throw new Error('closeNanoCoreListeners was not found in the NanoCore entrypoint.');
  }

  const javascript = transpileModule(declaration.getText(sourceFile), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function(
    'shutdownTelemetry',
    'workerMcpGateway',
    'closeRetrievalServices',
    'appServer',
    'nanoHostServer',
    'nanohostTransportSessionAuthority',
    `${javascript}\nreturn (onClosed) => { void closeNanoCoreListeners().then(onClosed); };`
  )(
    bindings.shutdownTelemetry,
    bindings.workerMcpGateway,
    async () => undefined,
    bindings.appServer,
    bindings.nanoHostServer,
    { closeAllPhysicalConnections: async () => undefined }
  ) as (onClosed: () => void) => void;
}

/** Creates a controlled completion for a process-owned effect. */
function pendingShutdownEffect(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * Executes entrypoint migration and shutdown paths with controlled process and storage effects.
 * The Audit publisher's pending promise represents its native durability acknowledgement.
 * @param effects Process completions, Core migration admission and optional migration fault.
 * @returns Entrypoint operations, completion and observations of owned effects.
 */
function evaluateEntrypointShutdown(effects: {
  maintenance: Promise<void>;
  executions: Promise<void>;
  listeners: Promise<void>;
  audit: Promise<void>;
  coreMigrationsComplete: boolean;
  coreMigrationFailure?: Error;
  communicationAdmission?: Promise<{ state: 'ready' } | { state: 'unavailable' }>;
}) {
  const source = readEntrypointSource();
  const sourceFile = createSourceFile('index.ts', source, ScriptTarget.Latest, true);
  let migrationPhase: string | undefined;
  let communicationPhase: string | undefined;
  sourceFile.forEachChild(function visit(node) {
    if (isObjectLiteralExpression(node)) {
      const name = node.properties.find(
        (property) => isPropertyAssignment(property) && property.name.getText(sourceFile) === 'name'
      );
      if (name && isPropertyAssignment(name) && isStringLiteral(name.initializer)) {
        if (name.initializer.text === 'migrations') migrationPhase = node.getText(sourceFile);
        if (name.initializer.text === 'communication-admission')
          communicationPhase = node.getText(sourceFile);
      }
    }
    node.forEachChild(visit);
  });
  const bootOutcomePublication = sourceFile.statements.find(
    (statement) =>
      isIfStatement(statement) &&
      statement.getText(sourceFile).includes('await recordBootAuditEvent(')
  );
  if (!migrationPhase || !communicationPhase || !bootOutcomePublication)
    throw new Error('NanoCore migration phase or boot-outcome publication was not found.');
  const names = [
    'shutdown',
    'closeNanoCoreListeners',
    'finishShutdown',
    'closeProcessCoreDatabase',
    'recordShutdownAudit',
    'recordBootStartAudit',
    'requireBootValue',
  ];
  const declarations = names.map((name) => {
    const declaration = sourceFile.statements.find(
      (statement) => isFunctionDeclaration(statement) && statement.name?.text === name
    );
    if (!declaration) throw new Error(`${name} was not found in the NanoCore entrypoint.`);
    return declaration.getText(sourceFile);
  });
  const deadline = source.match(/const SHUTDOWN_DEADLINE_MS = ([\d_]+);/);
  if (!deadline?.[1]) throw new Error('NanoCore shutdown deadline was not found.');
  const deadlineMs = Number(deadline[1].replaceAll('_', ''));
  const javascript = transpileModule(
    `${declarations.join('\n')}
    let bootResult;
    async function runMigrationPhase() {
      bootResult = await runBootPhases({ bootId, phases: [${migrationPhase}] });
      bootReadiness = bootResult.readiness;
      return bootResult;
    }
    async function runCommunicationPhase() {
      return await runBootPhases({ bootId, phases: [${communicationPhase}, {
        name: 'after-communication',
        subsystem: 'storage',
        critical: true,
        run: () => {
          events.push('after.communication');
          return { status: 'ok' };
        },
      }] });
    }
    async function publishBootOutcome() {
      ${bootOutcomePublication.getText(sourceFile)}
    }`,
    {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }
  ).outputText;
  const events: string[] = [];
  const recordBootAuditEvent = vi.fn(async () => undefined);
  const recordBootStartAuditEvent = vi.fn(async () => undefined);
  const recordShutdownAuditEvent = vi.fn(() => {
    events.push('audit.started');
    return effects.audit.then(() => {
      events.push('audit.acknowledged');
    });
  });
  const shutdownControlStoreWorkerClient = vi.fn(async () => {
    events.push('native.closed');
  });
  const getControlStoreWorkerClient = vi.fn(() => {
    if (effects.communicationAdmission)
      return { communicationKernel: () => ({ status: () => ({ state: 'ready' }) }) };
    throw new Error('Shutdown must not open a replacement native writer.');
  });
  const exit = vi.fn((code: number) => {
    events.push(`exit:${code}`);
  });
  const forceShutdownAtDeadline = vi.fn();
  const processShutdownAbort = new AbortController();
  const coreDb = {
    sqlite: {
      open: true,
      close: () => events.push('core.closed'),
      prepare: () => ({ all: () => [] }),
    },
  };
  const openCoreDbWithIntegrityCheck = vi.fn(() => coreDb);
  const applyMigrations = vi.fn(() => {
    throw effects.coreMigrationFailure ?? new Error('Unexpected migration invocation.');
  });
  const prepareCommunicationOwner = vi.fn(() => {
    events.push('attention.started');
    return effects.communicationAdmission;
  });
  const recoverRunningCapabilityCalls = vi.fn(async () => {
    events.push('recovery.started');
  });
  const bindings = {
    closeWithDeadline,
    forceShutdownAtDeadline,
    runBootPhases,
    createShutdownReadinessSnapshot,
    bootReadiness: computeBootReadinessSnapshot({ bootId: 'boot_shutdown_order' }),
    bootId: 'boot_shutdown_order',
    dataRoot: '/unused-shutdown-test-root',
    freshCoreInitialization: false,
    coreMigrationsComplete: effects.coreMigrationsComplete,
    verifyExistingCoreBaseline: vi.fn(async () => {}),
    openCoreDbWithIntegrityCheck,
    applyMigrations,
    mode: 'local',
    communicationBinding: undefined,
    prepareCommunicationOwner,
    events,
    restoreWorkspaceRetirementAdmission: vi.fn(),
    restoreWorkspaceRecoveryAdmission: vi.fn(),
    recoverRunningCapabilityCalls,
    admitServerKnowledgeBoot: vi.fn(),
    NotebookError: class extends Error {},
    verifyAndMigrateExistingScopedDatabases: async (_root: string, validate: () => void) =>
      validate(),
    FsStore: class {
      static validateFileAuthority() {}
    },
    sharedStore: undefined,
    rebuildInvalidExistingWorkspaceDerivedIndexes: () => [],
    readDataRootLayoutMarker: () => ({ layoutVersion: 1 }),
    listAppliedMigrationIds: () => [],
    recordBootAuditEvent,
    recordBootStartAuditEvent,
    withScopeAdmissionReadiness,
    SHUTDOWN_DEADLINE_MS: deadlineMs,
    codexResetMaintenance: undefined,
    processShutdownAbort,
    recurringSchedules: { stop: () => events.push('recurring.stop') },
    schedulerDispatchRetry: { stop: () => events.push('dispatch.stop') },
    schedulerAttemptMaintenance: {
      stop: () => {
        events.push('maintenance.stop');
        return effects.maintenance;
      },
    },
    workerLifecycleRuntime: {
      executionReconciler: {
        stop: () => {
          events.push('executions.stop');
          return effects.executions;
        },
      },
    },
    shutdownTelemetry: async () => undefined,
    workerMcpGateway: undefined,
    closeRetrievalServices: async () => undefined,
    appServer: {
      close: (callback: () => void) => {
        events.push('listeners.closing');
        void effects.listeners.then(() => {
          events.push('listeners.closed');
          callback();
        });
      },
    },
    nanoHostServer: null,
    nanohostTransportSessionAuthority: { closeAllPhysicalConnections: async () => undefined },
    vaultUnlockState: { lock: () => events.push('vault.lock') },
    recordShutdownAuditEvent,
    shutdownControlStoreWorkerClient,
    getControlStoreWorkerClient,
    coreDb: effects.coreMigrationsComplete || effects.communicationAdmission ? coreDb : undefined,
    dataRootLock: { release: () => events.push('lock.released') },
    process: { exit },
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const lifecycle = new Function(
    ...Object.keys(bindings),
    `let shutdownCompletion;\n${javascript}\nreturn {
      shutdown,
      runMigrationPhase,
      runCommunicationPhase,
      publishBootOutcome,
      completion: () => shutdownCompletion,
      readiness: () => bootReadiness,
    };`
  )(...Object.values(bindings)) as {
    shutdown: (signal: NodeJS.Signals) => void;
    runMigrationPhase: () => ReturnType<typeof runBootPhases>;
    runCommunicationPhase: () => ReturnType<typeof runBootPhases>;
    publishBootOutcome: () => Promise<void>;
    completion: () => Promise<void>;
    readiness: () => ReturnType<typeof computeBootReadinessSnapshot>;
  };
  return {
    ...lifecycle,
    events,
    deadlineMs,
    recordShutdownAuditEvent,
    recordBootAuditEvent,
    recordBootStartAuditEvent,
    openCoreDbWithIntegrityCheck,
    applyMigrations,
    prepareCommunicationOwner,
    recoverRunningCapabilityCalls,
    shutdownControlStoreWorkerClient,
    getControlStoreWorkerClient,
    exit,
    forceShutdownAtDeadline,
    processShutdownAbort,
  };
}

describe('NanoCore boot phase order', () => {
  it('joins Communication admission and its Attention reconciliation before scheduler recovery', async () => {
    const ack = pendingShutdownEffect();
    const lifecycle = evaluateEntrypointShutdown({
      maintenance: Promise.resolve(),
      executions: Promise.resolve(),
      listeners: Promise.resolve(),
      audit: Promise.resolve(),
      coreMigrationsComplete: true,
      communicationAdmission: ack.promise.then(() => ({ state: 'ready' })),
    });
    const boot = lifecycle.runCommunicationPhase();
    expect(lifecycle.events).toEqual(['attention.started']);
    expect(lifecycle.prepareCommunicationOwner).toHaveBeenCalledOnce();

    ack.resolve();
    const result = await boot;
    expect(result.outcomes[0]?.outcome.status).toBe('ok');
    expect(lifecycle.events).toEqual(['attention.started', 'after.communication']);

    const source = readEntrypointSource();
    const migrations = source.indexOf("name: 'migrations'");
    const communication = source.indexOf("name: 'communication-admission'");
    const scheduler = source.indexOf("name: 'scheduler-restart-recovery'");
    expect(migrations).toBeGreaterThan(-1);
    expect(communication).toBeGreaterThan(migrations);
    expect(scheduler).toBeGreaterThan(communication);
  });

  it('contains a refused Communication reconciliation and keeps unrelated startup serving', async () => {
    const lifecycle = evaluateEntrypointShutdown({
      maintenance: Promise.resolve(),
      executions: Promise.resolve(),
      listeners: Promise.resolve(),
      audit: Promise.resolve(),
      coreMigrationsComplete: true,
      communicationAdmission: Promise.resolve({ state: 'unavailable' }),
    });
    const result = await lifecycle.runCommunicationPhase();
    expect(result.readiness.acceptingProductWork).toBe(true);
    expect(result.outcomes[0]).toMatchObject({
      name: 'communication-admission',
      critical: false,
      outcome: {
        status: 'degraded',
        reason: { code: 'storage.communication_unavailable', blocks: [] },
      },
    });
    expect(lifecycle.events).toEqual(['attention.started', 'after.communication']);
  });

  it('settles listener shutdown when boot has not created optional process owners', async () => {
    const onClosed = vi.fn();
    const closeNanoCoreListeners = evaluateCloseNanoCoreListeners({
      shutdownTelemetry: async () => undefined,
      workerMcpGateway: undefined,
      appServer: undefined,
      nanoHostServer: null,
    });

    expect(() => closeNanoCoreListeners(onClosed)).not.toThrow();
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });

  it('drains maintenance and listeners, locks Vault and awaits Audit before native close and exit', async () => {
    vi.useFakeTimers();
    const maintenance = pendingShutdownEffect();
    const executions = pendingShutdownEffect();
    const listeners = pendingShutdownEffect();
    const audit = pendingShutdownEffect();
    const lifecycle = evaluateEntrypointShutdown({
      maintenance: maintenance.promise,
      executions: executions.promise,
      listeners: listeners.promise,
      audit: audit.promise,
      coreMigrationsComplete: true,
    });

    try {
      lifecycle.shutdown('SIGTERM');
      expect(lifecycle.readiness().acceptingProductWork).toBe(false);
      expect(lifecycle.processShutdownAbort.signal.aborted).toBe(true);
      expect(lifecycle.events).toEqual(
        expect.arrayContaining([
          'recurring.stop',
          'dispatch.stop',
          'maintenance.stop',
          'executions.stop',
        ])
      );
      maintenance.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(lifecycle.events).not.toContain('listeners.closing');
      executions.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(lifecycle.events).toContain('listeners.closing');
      expect(lifecycle.events).not.toContain('vault.lock');
      expect(lifecycle.recordShutdownAuditEvent).not.toHaveBeenCalled();

      listeners.resolve();
      await vi.advanceTimersByTimeAsync(0);
      // Ordered shutdown and Core storage require durable writes before terminal close.
      expect(lifecycle.events.indexOf('listeners.closed')).toBeLessThan(
        lifecycle.events.indexOf('vault.lock')
      );
      expect(lifecycle.events.indexOf('vault.lock')).toBeLessThan(
        lifecycle.events.indexOf('audit.started')
      );
      expect(lifecycle.recordShutdownAuditEvent).toHaveBeenCalledTimes(1);
      expect(lifecycle.shutdownControlStoreWorkerClient).not.toHaveBeenCalled();
      expect(lifecycle.events).not.toContain('core.closed');
      expect(lifecycle.events).not.toContain('lock.released');
      expect(lifecycle.exit).not.toHaveBeenCalled();

      audit.resolve();
      await lifecycle.completion();
      expect(
        lifecycle.events.filter((event) =>
          [
            'audit.acknowledged',
            'native.closed',
            'core.closed',
            'lock.released',
            'exit:0',
          ].includes(event)
        )
      ).toEqual(['audit.acknowledged', 'core.closed', 'native.closed', 'lock.released', 'exit:0']);
      expect(lifecycle.shutdownControlStoreWorkerClient).toHaveBeenCalledTimes(1);
      expect(lifecycle.exit).toHaveBeenCalledTimes(1);
      expect(lifecycle.exit).toHaveBeenCalledWith(0);
      expect(lifecycle.getControlStoreWorkerClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits at the process deadline with pending Audit and no replacement native writer', async () => {
    vi.useFakeTimers();
    const audit = pendingShutdownEffect();
    const lifecycle = evaluateEntrypointShutdown({
      maintenance: Promise.resolve(),
      executions: Promise.resolve(),
      listeners: Promise.resolve(),
      audit: audit.promise,
      coreMigrationsComplete: true,
    });

    try {
      lifecycle.shutdown('SIGINT');
      await vi.advanceTimersByTimeAsync(lifecycle.deadlineMs - 1);
      expect(lifecycle.recordShutdownAuditEvent).toHaveBeenCalledTimes(1);
      expect(lifecycle.events).not.toContain('audit.acknowledged');
      expect(lifecycle.shutdownControlStoreWorkerClient).not.toHaveBeenCalled();
      expect(lifecycle.exit).not.toHaveBeenCalled();
      expect(lifecycle.forceShutdownAtDeadline).not.toHaveBeenCalled();

      // The bootstrap deadline is a crash boundary, even when durability is unknown.
      await vi.advanceTimersByTimeAsync(1);
      await lifecycle.completion();
      expect(lifecycle.forceShutdownAtDeadline).toHaveBeenCalledExactlyOnceWith(
        'SIGINT',
        expect.any(Number)
      );
      expect(lifecycle.exit).not.toHaveBeenCalled();
      expect(lifecycle.events).not.toContain('core.closed');
      expect(lifecycle.events).not.toContain('lock.released');
      expect(lifecycle.recordShutdownAuditEvent).toHaveBeenCalledTimes(1);
      expect(lifecycle.shutdownControlStoreWorkerClient).not.toHaveBeenCalled();
      expect(lifecycle.getControlStoreWorkerClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry failed Core migrations through boot-outcome or partial-shutdown Audit', async () => {
    vi.useFakeTimers();
    const migrationFailure = new Error('Core migration test-migration failed: SQLITE_ERROR.');
    const lifecycle = evaluateEntrypointShutdown({
      maintenance: Promise.resolve(),
      executions: Promise.resolve(),
      listeners: Promise.resolve(),
      audit: Promise.resolve(),
      coreMigrationsComplete: false,
      coreMigrationFailure: migrationFailure,
    });

    try {
      const result = await lifecycle.runMigrationPhase();
      expect(result.readiness.acceptingProductWork).toBe(false);
      expect(result.outcomes).toEqual([
        expect.objectContaining({
          name: 'migrations',
          critical: true,
          outcome: {
            status: 'failed',
            reason: {
              code: 'migrations.failed',
              message: migrationFailure.message,
              blocks: ['product_work'],
            },
          },
        }),
      ]);
      await lifecycle.publishBootOutcome();
      lifecycle.shutdown('SIGTERM');
      await lifecycle.completion();

      // Storage migration fails closed; lifecycle Audit must not repeat the failed phase.
      expect(lifecycle.openCoreDbWithIntegrityCheck).toHaveBeenCalledTimes(1);
      expect(lifecycle.applyMigrations).toHaveBeenCalledTimes(1);
      expect(lifecycle.applyMigrations).toHaveBeenCalledWith(
        lifecycle.openCoreDbWithIntegrityCheck.mock.results[0]?.value
      );
      expect(lifecycle.recordBootStartAuditEvent).not.toHaveBeenCalled();
      expect(lifecycle.recordBootAuditEvent).not.toHaveBeenCalled();
      expect(lifecycle.recordShutdownAuditEvent).not.toHaveBeenCalled();
      expect(lifecycle.getControlStoreWorkerClient).not.toHaveBeenCalled();
      expect(lifecycle.events).toContain('core.closed');
      expect(lifecycle.exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails authoritative storage integrity before bootstrap credentials or listener binding', () => {
    const source = readEntrypointSource();
    const migrationsPhase = source.indexOf("name: 'migrations'");
    const baselineAdmission = source.indexOf(
      'await verifyExistingCoreBaseline(dataRoot)',
      migrationsPhase
    );
    const coreIntegrityCheck = source.indexOf(
      'coreDb = openCoreDbWithIntegrityCheck(dataRoot,',
      migrationsPhase
    );
    const scopedIntegrityCheck = source.indexOf(
      'await verifyAndMigrateExistingScopedDatabases(dataRoot, () => {',
      coreIntegrityCheck
    );
    const coreMigrations = source.indexOf('applyMigrations(coreDb)', coreIntegrityCheck);
    const awaitedBootAudit = source.indexOf('await recordBootStartAudit({', scopedIntegrityCheck);
    const criticalFailureGate = source.indexOf(
      'if (criticalBootFailure || !bootReadiness.acceptingProductWork)'
    );
    const bootstrapCredential = source.indexOf(
      'const bootstrap = await ensureServerBootstrapTokenForStartup(coreDb)',
      criticalFailureGate
    );
    const listenerBind = source.indexOf('appServer = appTlsListen', criticalFailureGate);

    expect(baselineAdmission).toBeGreaterThan(migrationsPhase);
    expect(coreIntegrityCheck).toBeGreaterThan(baselineAdmission);
    expect(scopedIntegrityCheck).toBeGreaterThan(coreIntegrityCheck);
    expect(coreMigrations).toBeGreaterThan(coreIntegrityCheck);
    expect(scopedIntegrityCheck).toBeGreaterThan(coreMigrations);
    expect(awaitedBootAudit).toBeGreaterThan(scopedIntegrityCheck);
    expect(awaitedBootAudit).toBeLessThan(criticalFailureGate);
    expect(criticalFailureGate).toBeGreaterThan(scopedIntegrityCheck);
    expect(bootstrapCredential).toBeGreaterThan(criticalFailureGate);
    expect(listenerBind).toBeGreaterThan(criticalFailureGate);
    expect(source).not.toContain('storageRecoveryEvents');
    expect(source).not.toContain("code: 'storage.quarantined'");
  });

  it('closes process listeners without waiting for optional telemetry flush', async () => {
    const shutdownTelemetry = vi.fn(() => new Promise<void>(() => undefined));
    const appServer = { close: vi.fn((callback: () => void) => callback()) };
    const nanoHostServer = { close: vi.fn((callback: () => void) => callback()) };
    const workerMcpGateway = { close: vi.fn(async () => undefined) };
    const onClosed = vi.fn();
    const closeNanoCoreListeners = evaluateCloseNanoCoreListeners({
      shutdownTelemetry,
      workerMcpGateway,
      appServer,
      nanoHostServer,
    });

    closeNanoCoreListeners(onClosed);
    expect(shutdownTelemetry).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(appServer.close).toHaveBeenCalledTimes(1);
      expect(nanoHostServer.close).toHaveBeenCalledTimes(1);
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
  });
});
