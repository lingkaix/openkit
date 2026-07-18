import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStatusBadge } from './AgentStatusBadge';

afterEach(() => {
  cleanup();
});

describe('AgentStatusBadge', () => {
  it('renders a truncated agent session id and status', () => {
    render(() => (
      <AgentStatusBadge
        healthStatus="ready"
        isRefreshing={false}
        sessionId="0190f4c8-0000-7000-8000-000000000123"
        status="busy"
        agentId="agent_codex_host"
        onRefresh={() => undefined}
      />
    ));

    expect(screen.getByRole('region', { name: /agent session/i })).toHaveTextContent('0190f4c8...');
    expect(screen.getByText(/busy/i)).toBeInTheDocument();
    expect(screen.getByText(/agent_codex_host/i)).toBeInTheDocument();
    expect(screen.getByText(/health ready/i)).toBeInTheDocument();
  });

  it('calls refresh action', () => {
    const onRefresh = vi.fn();
    render(() => (
      <AgentStatusBadge
        healthStatus="unknown"
        isRefreshing={false}
        sessionId={null}
        status="idle"
        agentId={null}
        onRefresh={onRefresh}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /refresh agent health/i }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('marks sessions captured from an older runtime config snapshot', () => {
    render(() => (
      <AgentStatusBadge
        agentId="agent_planner"
        configVersion={1}
        currentConfigVersion={2}
        healthStatus="ready"
        isRefreshing={false}
        sessionId="session_stale"
        stale={true}
        status="idle"
        onRefresh={() => undefined}
      />
    ));

    const badge = screen.getByRole('region', { name: /agent session/i });

    expect(badge).toHaveTextContent('stale config');
    expect(badge).toHaveTextContent('v1 -> v2');
  });

  it('renders OpenShell backend control status', () => {
    render(() => (
      <AgentStatusBadge
        agentId="agent_codex_host"
        backend={{
          kind: 'openshell',
          health: 'ready',
          controlMode: 'direct-nanocore',
          control: {
            heartbeat: {
              status: 'running',
              sequence: 4,
              lastHeartbeatAt: '2026-06-16T00:00:03.000Z',
            },
            artifactNoticeCount: 1,
            queuedCommandCount: 2,
            deliveredCommandCount: 2,
          },
          gatewayName: 'openshell',
          gatewayEndpoint: 'https://127.0.0.1:17670',
          version: '0.0.63',
          sandboxName: 'openkit-as-control',
        }}
        healthStatus="ready"
        isRefreshing={false}
        sessionId="as_control"
        status="busy"
        onRefresh={() => undefined}
      />
    ));

    const badge = screen.getByRole('region', { name: /agent session/i });

    expect(badge).toHaveTextContent('openshell ready');
    expect(badge).toHaveTextContent('control running');
  });

  it('copies the full agent session id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(() => (
      <AgentStatusBadge
        healthStatus="ready"
        isRefreshing={false}
        sessionId="0190f4c8-0000-7000-8000-000000000123"
        status="busy"
        agentId="agent_codex_host"
        onRefresh={() => undefined}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /copy session id/i }));

    expect(writeText).toHaveBeenCalledWith('0190f4c8-0000-7000-8000-000000000123');
  });
});
