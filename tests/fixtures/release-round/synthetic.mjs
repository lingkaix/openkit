/** Synthetic stand-ins; identifiers and deployment coordinates have no real counterpart. */
import { digest, RUNTIMES } from '../../support/release-round/safety.mjs';
/** Synthetic public success envelope; it never calls a product surface. */
export const ok = (data) => ({ ok: true, data });
/** Closed clock interval shared by all invented deciding records. */
export const start = '2026-01-01T00:00:00.000Z',
  end = '2026-01-01T01:00:00.000Z';
/** Complete round-input stand-in without final sequence or real deployment and credential coordinates. */
export function parameters() {
  const hash = 'a'.repeat(40),
    d = `sha256:${'b'.repeat(64)}`;
  return {
    roundId: 'example-round',
    candidateCommit: hash,
    checklistBlob: hash,
    scenarioRevision: 'synthetic-set',
    evidenceAlias: 'example-evidence',
    workspaceId: 'workspace-example',
    protectedIds: ['protected-example'],
    cli: {
      executable: '/example/openkit',
      credentialFile: '/example/credential',
      origin: 'https://staging.example.invalid',
    },
    deployment: {
      sshAlias: 'example-host',
      machineId: 'a'.repeat(32),
      container: 'example-app',
      imageRepository: 'example/app',
      configurationDigest: d,
      nanoHostDigest: d,
      workerDigest: d,
      appImage: `sha256:${'c'.repeat(64)}`,
      webIdentity: `sha256:${'d'.repeat(64)}`,
      componentCommits: { nanoHost: hash, worker: hash },
      componentPaths: { nanoHost: ['apps/nanohost'], worker: ['containers/workers'] },
      diagnosticUnit: 'example-proxy.service',
    },
    runtimes: Object.fromEntries(
      RUNTIMES.map((r) => [
        r,
        {
          agentId: `agent-example-${r}`,
          profileId: 'default',
          modelId: 'configured default',
          configurationVersion: 1,
          marker: `example-${r}`,
          filename: `example-${r}.txt`,
        },
      ])
    ),
    issue: {
      repository: 'example/project',
      number: 1,
      title: 'Example read issue',
      state: 'closed',
    },
    bounds: { readAttempts: 2, pollMs: 1, observationMs: 100, processMs: 100 },
    authority: ['example-effect-authorization'],
    knownReferences: ['example-known-boundary'],
  };
}
function turn(tid, n, agent = 'quick-chat') {
  return {
    id: `turn-example-${tid}-${n}`,
    workspaceId: 'workspace-example',
    threadId: tid,
    status: 'completed',
    error: null,
    agentId: agent,
    agentProfileId: 'default',
    configVersion: 1,
    startedAt: `2026-01-01T00:${String(n * 2 + 2).padStart(2, '0')}:00.000Z`,
    completedAt: `2026-01-01T00:${String(n * 2 + 3).padStart(2, '0')}:00.000Z`,
  };
}
function item(t, text) {
  return {
    id: `item-example-${t.id}`,
    workspaceId: t.workspaceId,
    threadId: t.threadId,
    turnId: t.id,
    status: 'completed',
    type: 'assistant-message',
    text,
  };
}
/** A complete passing observation set for intervening on each frozen deciding predicate. */
export function bundle(p = parameters()) {
  const b = {
    attribution: {
      candidateCommit: p.candidateCommit,
      checklistBlob: p.checklistBlob,
      configurationDigest: p.deployment.configurationDigest,
      runnerSha256: 'd'.repeat(64),
      parameterSha256: 'e'.repeat(64),
      start,
      end,
    },
    cleanup: { observed: true },
    telemetry: Object.fromEntries(
      ['client', 'proxy', 'app', 'external', 'health'].map((k) => [
        k,
        { coverage: 'unavailable', http502: null, connectionReset: null },
      ])
    ),
    runtimes: {},
    issues: {},
  };
  for (const r of RUNTIMES) {
    const cfg = p.runtimes[r],
      tid = `thread-example-${r}`,
      steps = [],
      history = [],
      arts = [];
    for (const [n, letter] of ['A', 'B', 'C', 'D'].entries()) {
      const t = turn(tid, n, cfg.agentId),
        items = [
          item(
            t,
            letter === 'A'
              ? cfg.marker
              : letter === 'B'
                ? `${p.issue.title} ${p.issue.state}`
                : `${cfg.filename} ${cfg.marker}`
          ),
        ];
      if (letter === 'B')
        items.push({
          ...item(t, ''),
          id: `call-example-${r}`,
          type: 'tool-call',
          server: 'github',
          tool: 'issue_read',
          error: null,
          causationId: `cap-example-${r}`,
        });
      if (letter === 'C' || letter === 'D') {
        const a = {
          id: `artifact-example-${r}-${letter}`,
          kind: 'file',
          title: cfg.filename,
          content: { format: 'text', body: cfg.marker },
          contentDigest: digest(cfg.marker),
          origin: {
            kind: 'turn-output',
            threadId: tid,
            turnId: t.id,
            requestId: `submission-example-${letter}`,
          },
        };
        arts.push(ok(a));
        items.push({
          ...item(t, ''),
          id: `ref-example-${r}-${letter}`,
          type: 'artifact-reference',
          artifactId: a.id,
          lastMutationRequestId: a.origin.requestId,
        });
      }
      history.push(...items);
      steps.push({
        scenario: letter,
        submission: ok({ id: t.id }),
        submitInput: { requestId: `admission-example-${r}-${letter}`, modelId: cfg.modelId },
        turnId: t.id,
        turn: t,
        items,
        artifactReads: structuredClone(arts),
        dashboard: { artifacts: arts.map((v) => v.data) },
        itemCoverage: { items: structuredClone(history), nextCursor: null },
      });
    }
    b.runtimes[r] = { threadId: tid, modelId: cfg.modelId, steps };
    b.issues[r] = { readExit: 0, issue: p.issue };
  }
  b.binding = ok({
    items: [{ id: 'github', approvalRequiredTools: ['example_write'] }],
  });
  b.components = {
    nanoHost: { unchanged: true, digest: p.deployment.nanoHostDigest },
    worker: { unchanged: true, digest: p.deployment.workerDigest },
  };
  return b;
}
