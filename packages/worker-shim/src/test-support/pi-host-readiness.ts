import type { Duplex } from 'node:stream';
import { createPiLineReader, parsePiHostFrame } from '../adapters/pi-channel.js';

/**
 * Waits for a test child's module loading before starting adapter control deadlines.
 * Request zero is deliberately invalid and creates no native session; adapter requests begin at one.
 * The real host and controlled peer must prove their request listener with the same closed refusal.
 * Cold SDK imports measured 8 s in the CI image, independently of the operation under test.
 * Production startup and control deadlines are unchanged.
 * @param channel The already spawned test child's private control channel.
 * @returns Resolves only after the child refuses the closed invalid request.
 */
export function waitForPiHostReadiness(channel: Duplex): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.off('data', receive);
      channel.off('close', closed);
      channel.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    const receive = createPiLineReader(
      (line) => {
        const frame = parsePiHostFrame(line);
        if (frame.kind !== 'response' || frame.response.id !== 0) return;
        finish(
          !frame.response.ok && frame.response.error.code === 'invalid_request'
            ? undefined
            : new Error('Pi test host did not prove its request listener.')
        );
      },
      () => finish(new Error('Pi test host readiness frame exceeded its bound.'))
    );
    const closed = () => finish(new Error('Pi test host closed before readiness.'));
    const timer = setTimeout(
      () => finish(new Error('Pi test host module loading timed out.')),
      120_000
    );
    channel.on('data', receive);
    channel.once('close', closed);
    channel.once('error', finish);
    channel.write('{"id":0}\n', (error) => {
      if (error) finish(error);
    });
  });
}
