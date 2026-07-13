import { describe, expect, it } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createConfiguredTurnExecutor } from './turn-executor-factory.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

describe('createConfiguredTurnExecutor', () => {
  it('defaults production execution to the OpenShell local-container executor', () => {
    const executor = createConfiguredTurnExecutor({
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(WorkerGovernanceTurnExecutor);
    expect(
      (executor as unknown as { environmentBackend: { kind: string; placement?: string } })
        .environmentBackend
    ).toMatchObject({
      kind: 'openshell',
      placement: 'local',
    });
    expect(
      (
        executor as unknown as {
          backend: { trustedWorkerInferenceRelayEnabled: boolean };
        }
      ).backend.trustedWorkerInferenceRelayEnabled
    ).toBe(true);
  });

  it('keeps the deterministic self-check executor override', () => {
    const executor = createConfiguredTurnExecutor({
      env: { OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1' },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(SimulatedTurnExecutor);
  });

  it('selects the OpenShell local-container executor through the public worker runtime model', () => {
    const executor = createConfiguredTurnExecutor({
      env: {
        OPENKIT_CONTAINER_BACKEND: 'openshell',
        OPENKIT_CONTAINER_PLACEMENT: 'local',
        OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
          'http://host.openshell.internal:54001/api/worker-control',
        OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS: JSON.stringify([
          {
            access: 'read-only',
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            name: 'github_source',
            port: 443,
            protocol: 'rest',
          },
        ]),
        OPENKIT_OPENSHELL_CODEX_CONFIG_TOML: '/home/ubuntu/.codex/config.toml',
        OPENKIT_OPENSHELL_GATEWAY: 'openshell',
        OPENKIT_OPENSHELL_CODEX_MODEL: 'gpt-5-codex',
        OPENKIT_OPENSHELL_RETAIN_SANDBOXES: '0',
        OPENKIT_OPENSHELL_WORKER_IMAGE: 'openkit/worker-codex:dev',
        OPENKIT_WORKER_RUNTIME: 'container',
      },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(WorkerGovernanceTurnExecutor);
    expect(executor.capabilities).toMatchObject({
      approvals: false,
      artifacts: true,
      questions: false,
    });
    expect(
      (executor as unknown as { environmentBackend: { codexModel: string } }).environmentBackend
        .codexModel
    ).toBe('gpt-5-codex');
    expect(
      (executor as unknown as { backend: { codexConfigTomlPath: string } }).backend
        .codexConfigTomlPath
    ).toBe('/home/ubuntu/.codex/config.toml');
  });

  it('selects the OpenShell remote-container executor through the public worker runtime model', () => {
    const executor = createConfiguredTurnExecutor({
      env: {
        OPENKIT_CONTAINER_BACKEND: 'openshell',
        OPENKIT_CONTAINER_PLACEMENT: 'remote',
        OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
          'https://nanocore.example.com/api/worker-control',
        OPENKIT_OPENSHELL_GATEWAY: 'a1-openshell',
        OPENKIT_OPENSHELL_GATEWAY_INSECURE: '1',
        OPENKIT_OPENSHELL_GATEWAY_URL: 'https://a1.example.com:17670',
        OPENKIT_OPENSHELL_WORKER_IMAGE: 'openkit/worker-codex:dev',
        OPENKIT_WORKER_RUNTIME: 'container',
      },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(WorkerGovernanceTurnExecutor);
    expect(
      (
        executor as unknown as {
          environmentBackend: {
            placement: string;
            gatewayUrl: string;
            workerControlBaseUrl: string;
          };
        }
      ).environmentBackend
    ).toMatchObject({
      workerControlBaseUrl: 'https://nanocore.example.com/api/worker-control',
      gatewayUrl: 'https://a1.example.com:17670',
      placement: 'remote',
    });
    expect(
      (
        executor as unknown as {
          backend: { placement: string; gatewayUrl: string; gatewayInsecure: boolean };
        }
      ).backend
    ).toMatchObject({
      gatewayInsecure: true,
      gatewayUrl: 'https://a1.example.com:17670',
      placement: 'remote',
    });
  });

  it('fails closed when remote-container is missing the remote OpenShell gateway URL', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: {
          OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
            'https://nanocore.example.com/api/worker-control',
          OPENKIT_CONTAINER_BACKEND: 'openshell',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('OPENKIT_OPENSHELL_GATEWAY_URL is required when OPENKIT_CONTAINER_PLACEMENT=remote.');
  });

  it('fails closed when container runtime selects an unsupported backend', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: {
          OPENKIT_CONTAINER_BACKEND: 'docker',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_OPENSHELL_GATEWAY_URL: 'https://a1.example.com:17670',
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('Unsupported OPENKIT_CONTAINER_BACKEND: docker.');
  });

  it('rejects malformed OpenShell extra network endpoint configuration', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: {
          OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS: '{',
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS must be valid JSON.');
  });

  it('rejects OpenShell extra network endpoint protocols unsupported by the policy engine', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: {
          OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS: JSON.stringify([
            {
              host: 'github.com',
              name: 'github_source',
              port: 443,
              protocol: 'tcp',
            },
          ]),
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow(
      'OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[0].protocol must be "rest", "websocket", "graphql", or "sql".'
    );
  });

  it('rejects OpenShell extra endpoints that collide with reserved policy names', () => {
    for (const name of ['openkit_worker_control', 'openkit_worker_inference']) {
      expect(() =>
        createConfiguredTurnExecutor({
          env: {
            OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS: JSON.stringify([
              {
                host: 'nanocore.local',
                name,
                port: 443,
                protocol: 'rest',
              },
            ]),
            OPENKIT_WORKER_RUNTIME: 'container',
          },
          workerControlGateway: new WorkerControlGateway(),
        })
      ).toThrow(`OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[0].name is reserved: ${name}.`);
    }
  });

  it('rejects non-container worker runtime selection', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: { OPENKIT_WORKER_RUNTIME: 'host' },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('Unsupported OPENKIT_WORKER_RUNTIME: host.');
  });

  it('rejects legacy turn executor selection instead of preserving host aliases', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: { OPENKIT_TURN_EXECUTOR: 'codex-host' },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('OPENKIT_TURN_EXECUTOR is no longer supported.');
  });

  it('rejects legacy remote container backend selection', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: { OPENKIT_REMOTE_CONTAINER_BACKEND: 'openshell' },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('OPENKIT_REMOTE_CONTAINER_BACKEND is no longer supported.');
  });
});
