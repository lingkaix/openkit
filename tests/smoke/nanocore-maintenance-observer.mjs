import { registerHooks } from 'node:module';

const messageType = 'openkit-smoke-initial-maintenance';

/** Joins a real startup-owner completion message, never HTTP readiness or elapsed time. */
export function observeInitialMaintenance(child) {
  let detach = () => {};
  const completed = new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== messageType) return;
      detach();
      if (message.status !== 'completed' || message.snapshots !== true) {
        reject(new Error('Initial recovery and automatic snapshot maintenance failed.'));
        return;
      }
      resolve(Date.now());
    };
    const onExit = (code, signal) => {
      detach();
      reject(new Error(`Process exited before initial maintenance completed: ${code}/${signal}.`));
    };
    const onError = (error) => {
      detach();
      reject(error);
    };
    detach = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
  // A child may fail before the caller enters its existing startup wait.
  void completed.catch(() => {});
  return {
    /** Shares the smoke's original startup deadline, without adding another timeout window. */
    async waitUntil(deadline) {
      let timer;
      try {
        await Promise.race([
          completed.then((observedAt) => {
            if (observedAt > deadline)
              throw new Error('Initial maintenance missed startup deadline.');
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Initial maintenance missed startup deadline.')),
              Math.max(0, deadline - Date.now())
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        detach();
      }
    },
  };
}

/**
 * Observes the existing process owner's promise in this disposable child only.
 * The real factory immediately starts one pass; runOnce joins that same pass.
 * No product file/API, capture limit, interval, stage or readiness value is changed.
 */
export function installInitialMaintenanceWitness() {
  if (typeof process.send !== 'function') throw new Error('Smoke witness requires its owned IPC.');
  const entrypoint = new URL('../../apps/nanocore/dist/index.js', import.meta.url).href;
  const service = new URL(
    '../../apps/nanocore/dist/runtime/scheduler-attempt-maintenance-service.js',
    import.meta.url
  ).href;
  const target = JSON.stringify(service);
  const wrapper = `
    export * from ${target};
    import { startSchedulerAttemptMaintenanceService as startActual } from ${target};
    export function startSchedulerAttemptMaintenanceService(input) {
      if (typeof input.runRecoveryMaintenance.snapshots !== 'function') {
        throw new Error('Smoke requires the actual automatic snapshot stage.');
      }
      const owner = startActual(input);
      const report = (status) => {
        process.send({ type: ${JSON.stringify(messageType)}, status, snapshots: true });
        process.channel?.unref();
      };
      void owner.runOnce().then(() => report('completed'), () => report('failed'));
      return owner;
    }
  `;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL === entrypoint &&
        specifier === './runtime/scheduler-attempt-maintenance-service.js'
      ) {
        hooks.deregister();
        return {
          url: `data:text/javascript,${encodeURIComponent(wrapper)}`,
          format: 'module',
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
}
