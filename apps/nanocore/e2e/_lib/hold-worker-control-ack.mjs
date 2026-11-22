// Preloaded only by the public Worker lifecycle fixture.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, Worker } from 'node:worker_threads';

const directory = process.env.OPENKIT_E2E_ACK_MARKERS;
if (isMainThread && directory) {
  const emit = Worker.prototype.emit;
  const restartAdmission = process.env.OPENKIT_E2E_ACK_CASE === 'restart-admit';
  const allocation = new WeakMap();
  if (restartAdmission) {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (request, ...args) {
      if (
        request?.operation === 'nanohost-owner' &&
        request.mutation.kind === 'runtime-target' &&
        request.mutation.input.input.kind === 'allocate'
      )
        allocation.set(this, request.id);
      return post.call(this, request, ...args);
    };
  }
  let held = 0;
  Worker.prototype.emit = function (event, ...args) {
    const reply = args[0];
    if (
      event === 'message' &&
      restartAdmission &&
      reply?.status === 'ok' &&
      reply.operation === 'nanohost-owner' &&
      allocation.get(this) === reply.id
    ) {
      // Hold the exact ACK for the new session's allocation, after its FULL commit.
      allocation.delete(this);
      writeFileSync(join(directory, 'held-restart-admit'), '');
      setTimeout(() => emit.call(this, event, ...args), 700);
      return true;
    }
    if (
      !restartAdmission &&
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
