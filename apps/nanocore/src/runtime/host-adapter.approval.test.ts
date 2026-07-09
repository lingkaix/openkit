import { describe, expect, it } from 'vitest';

import { createDemoStore } from '../test-support/demo-store.js';
import type { ResolveAgentEnvironmentBackendInput } from './agent-environment.js';
import { CodexHostAdapter } from './host-adapter.js';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionFactory,
  AgentSessionState,
  ApprovalDecision,
  CreateAgentSessionInput,
} from './types.js';

class ApprovalAgentSession implements AgentSession {
  public readonly id: string;
  public readonly environmentPackage: CreateAgentSessionInput['environmentPackage'];
  public readonly threadId: string;
  public readonly approvalResponses: Array<{ approvalId: string; decision: ApprovalDecision }> = [];
  public state: AgentSessionState = 'bound';
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(input: CreateAgentSessionInput) {
    this.id = input.id;
    this.environmentPackage = input.environmentPackage;
    this.threadId = input.threadId;
  }

  /**
   * Registers one runtime event listener.
   */
  public onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts the fake turn.
   */
  public async startTurn(_turnId: string, _input: string): Promise<void> {
    this.state = 'running';
  }

  /**
   * Interrupts the fake turn.
   */
  public async interruptTurn(_turnId: string): Promise<void> {}

  /**
   * Records one approval decision.
   */
  public async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.approvalResponses.push({ approvalId, decision });
  }

  /**
   * Closes the fake session.
   */
  public async close(): Promise<void> {
    this.state = 'exited';
  }

  /**
   * Returns the current fake session state.
   */
  public getState(): AgentSessionState {
    return this.state;
  }

  /**
   * Emits one runtime event.
   */
  public emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class ApprovalAgentSessionFactory implements AgentSessionFactory {
  public readonly sessions: ApprovalAgentSession[] = [];

  /**
   * Creates one approval-capable fake session.
   */
  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const session = new ApprovalAgentSession(input);
    this.sessions.push(session);
    return session;
  }
}

/**
 * Returns the explicit container backend used by legacy host-adapter approval tests.
 *
 * @returns OpenShell Agent Environment Package target.
 */
function testOpenShellBackend(): ResolveAgentEnvironmentBackendInput {
  return {
    controlRelayUpstream: 'https://nanocore.local/api/worker-control',
    kind: 'openshell',
    sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
  };
}

describe('CodexHostAdapter approvals', () => {
  it('bridges an exec approval grant and resumes the turn', async () => {
    const store = createDemoStore();
    const sessionFactory = new ApprovalAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run a command');

    await adapter.startTurn(store, turn.id, 'Run a command');

    const session = sessionFactory.sessions[0];
    session.emit({
      type: 'approval-requested',
      turnId: turn.id,
      approvalId: 'exec_call_1',
      kind: 'permission',
      title: 'Approve command',
      description: 'Run `pnpm test` in /workspace.',
    });

    const approval = store.getApproval('exec_call_1');

    expect(adapter.capabilities.approvals).toBe(true);
    expect(approval.status).toBe('pending');
    expect(store.getTurnById(turn.id)).toMatchObject({
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: `it_approval_request_${approval.id}`,
      },
    });
    expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'approval-request', approvalRequestId: approval.id }),
      ])
    );
    expect(store.getTurnEvents(turn.id).map((event) => event.event)).toEqual(
      expect.arrayContaining(['approval.requested', 'turn.updated'])
    );

    const resolvedApproval = await adapter.respondApproval(store, approval.id, 'granted');

    expect(resolvedApproval.status).toBe('granted');
    expect(session.approvalResponses).toEqual([{ approvalId: approval.id, decision: 'granted' }]);
    expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'approval-decision', approvalRequestId: approval.id }),
      ])
    );
    expect(store.getTurnById(turn.id)).toMatchObject({ status: 'running', humanGate: null });
  });

  it('bridges an apply-patch approval denial and resumes the turn', async () => {
    const store = createDemoStore();
    const sessionFactory = new ApprovalAgentSessionFactory();
    const adapter = new CodexHostAdapter({
      environmentBackend: testOpenShellBackend(),
      sessionFactories: { codex: sessionFactory },
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Patch a file');

    await adapter.startTurn(store, turn.id, 'Patch a file');

    const session = sessionFactory.sessions[0];
    session.emit({
      type: 'approval-requested',
      turnId: turn.id,
      approvalId: 'patch_call_1',
      kind: 'destructive-action',
      title: 'Approve patch',
      description: 'Modify src/index.ts.',
    });

    const resolvedApproval = await adapter.respondApproval(store, 'patch_call_1', 'denied');

    expect(resolvedApproval.status).toBe('denied');
    expect(session.approvalResponses).toEqual([{ approvalId: 'patch_call_1', decision: 'denied' }]);
    expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'approval-decision',
          approvalRequestId: 'patch_call_1',
          decision: 'denied',
        }),
      ])
    );
    expect(store.getTurnById(turn.id).status).toBe('running');
    expect(store.getTurnEvents(turn.id).map((event) => event.event)).toEqual(
      expect.arrayContaining(['approval.requested', 'approval.resolved', 'turn.updated'])
    );
  });
});
