import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type { WorkerResidentSession } from '../adapter-registry.js';

/** Admission failures injected at the actual SDK and current native transport boundaries. */
export type DeepSeekAdmissionFailure = 'channel-loss' | 'close-flush';

/** Records the exercised native seam without replacing prompts, inspection, stop, or cleanup. */
export function failDeepSeekAdmission(
  session: WorkerResidentSession,
  kind: DeepSeekAdmissionFailure
): string[] {
  const { agent, child } = session as unknown as {
    agent: ClientSideConnection;
    child: ChildProcessWithoutNullStreams;
  };
  const calls: string[] = [];
  if (kind === 'channel-loss') {
    const select = agent.setSessionConfigOption.bind(agent);
    agent.setSessionConfigOption = (input) => {
      calls.push('setSessionConfigOption');
      const pending = select(input);
      child.stdout.emit('error', new Error('Injected current admission channel loss.'));
      return pending;
    };
  } else {
    agent.closeSession = async () => {
      calls.push('closeSession');
      throw new Error('Injected native close/flush failure.');
    };
  }
  return calls;
}

/** Withholds one real successful idle replacement-resume acknowledgement at native admission. */
export function withholdDeepSeekResumeAcknowledgement(session: WorkerResidentSession): string[] {
  const native = session as unknown as {
    spawnHost(record: unknown): Promise<void>;
    admitNativeLine(line: string): void;
  };
  const calls: string[] = [];
  const spawn = native.spawnHost.bind(native);
  native.spawnHost = async (record) => {
    await spawn(record);
    const admit = native.admitNativeLine.bind(native);
    native.admitNativeLine = (line) => {
      const message = JSON.parse(line);
      if (calls.length === 0 && message.result && Array.isArray(message.result.configOptions)) {
        calls.push('resumeAcknowledgement');
        return;
      }
      admit(line);
    };
  };
  return calls;
}
