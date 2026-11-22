// Preloaded only by the public Worker lifecycle fixture's first serving process.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, Worker } from 'node:worker_threads';

const directory = process.env.OPENKIT_E2E_ACK_MARKERS;
if (isMainThread && directory) {
  const emit = Worker.prototype.emit;
  let held = 0;
  Worker.prototype.emit = function (event, ...args) {
    const reply = args[0];
    if (
      event === 'message' &&
      reply?.status === 'ok' &&
      reply.operation === 'worker-control-record' &&
      reply.result.kind === 'sequence' &&
      held < 2
    ) {
      // The real worker committed. Delay only delivery of the original successful ACK to Main.
      writeFileSync(join(directory, `held-${++held}`), '');
      setTimeout(() => emit.call(this, event, ...args), 700);
      return true;
    }
    return emit.call(this, event, ...args);
  };
}
