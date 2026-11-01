import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type ClientConnection,
  type ClientContext,
  methods,
  type SendRequestOptions,
} from '@agentclientprotocol/sdk';
import type { WorkerResidentSession } from '../adapter-registry.js';

/** Intercepts one typed native request; every other method retains its actual SDK behavior. */
export function interceptDeepSeekRequest<Method extends AgentRequestMethod>(
  agent: ClientContext,
  method: Method,
  intercept: (
    params: AgentRequestParamsByMethod[Method],
    request: (
      params: AgentRequestParamsByMethod[Method]
    ) => Promise<AgentRequestResponsesByMethod[Method]>
  ) => Promise<AgentRequestResponsesByMethod[Method]>
): void {
  const request = agent.request.bind(agent);
  agent.request = ((actual: string, params: unknown, options?: SendRequestOptions) => {
    if (actual !== method) return request(actual, params, options);
    return intercept(params as AgentRequestParamsByMethod[Method], (input) =>
      request(method, input, options)
    );
  }) as ClientContext['request'];
}

/** Admission failures injected at the actual SDK and current native transport boundaries. */
export type DeepSeekAdmissionFailure = 'channel-loss' | 'close-flush';

/** Records the exercised native seam without replacing prompts, inspection, stop, or cleanup. */
export function failDeepSeekAdmission(
  session: WorkerResidentSession,
  kind: DeepSeekAdmissionFailure
): string[] {
  const { connection, child } = session as unknown as {
    connection: ClientConnection;
    child: ChildProcessWithoutNullStreams;
  };
  const agent = connection.agent;
  const calls: string[] = [];
  if (kind === 'channel-loss') {
    interceptDeepSeekRequest(agent, methods.agent.session.setConfigOption, (input, select) => {
      calls.push('setSessionConfigOption');
      const pending = select(input);
      child.stdout.emit('error', new Error('Injected current admission channel loss.'));
      return pending;
    });
  } else {
    interceptDeepSeekRequest(agent, methods.agent.session.close, async () => {
      calls.push('closeSession');
      throw new Error('Injected native close/flush failure.');
    });
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
