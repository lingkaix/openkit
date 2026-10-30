import { parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import {
  runWorkspaceCaptureWorker,
  type WorkspaceCaptureControl,
  WorkspaceRecoveryError,
} from './workspace-backup.js';

const port = parentPort!;
const signal = new Int32Array(workerData.signal);
/** The one request-private rendezvous never blocks Main or a native writer host. */
function control(request: WorkspaceCaptureControl): number | undefined {
  Atomics.store(signal, 0, 0);
  port.postMessage(request);
  while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
  const reply = receiveMessageOnPort(port)?.message;
  if (!reply?.ok)
    throw new WorkspaceRecoveryError('recovery-required', 'Capture admission requires inspection.');
  return reply.result;
}
try {
  const captured = await runWorkspaceCaptureWorker(workerData.input, control, workerData.automatic);
  if (captured) {
    const { manifest: _, ...result } = captured;
    port.postMessage({ kind: 'done', result });
  } else port.postMessage({ kind: 'done', result: null });
} catch (error) {
  port.postMessage({
    kind: 'failed',
    code: error instanceof WorkspaceRecoveryError ? error.code : 'recovery-required',
  });
}
