/** Synthetic stand-ins; identifiers and deployment coordinates have no real counterpart. */
import { canonical, digest, RUNTIMES } from '../../support/release-round/safety.mjs';
/** Synthetic public success envelope; it never calls a product surface. */
export const ok = (data) => ({ ok: true, data });
/** Closed clock interval shared by all invented deciding records. */
export const start = '2026-01-01T00:00:00.000Z',
  end = '2026-01-01T01:00:00.000Z';
/** Complete private-input stand-in with no real deployment or credential coordinates. */
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
      root: '/example/data',
      archiveDirectory: '/example/archives',
      buildDirectory: '/example/builds',
      webDirectory: '/example/web',
      container: 'example-app',
      imageRepository: 'example/app',
      environmentFile: '/example/env',
      expectedContainer: 'example-container',
      expectedImage: d,
      configurationDigest: d,
      bindingRevision: 1,
      bindingDigest: d,
      nanoHostDigest: d,
      workerDigest: d,
      workerAgents: RUNTIMES.map((r) => `agent-example-${r}`),
      componentCommits: { nanoHost: hash, worker: hash },
      componentPaths: { nanoHost: ['apps/nanohost'], worker: ['containers/workers'] },
      protectedMetadataPaths: ['/example/protected'],
      payloadDigests: { '/example/payload': 'b'.repeat(64) },
      diagnosticUnit: 'example-proxy.service',
      minimumFreeBytes: 1024,
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
    task: {
      repository: 'example/project',
      issue: 2,
      base: 'main',
      branch: 'example-acceptance',
      agentId: 'agent-example-codex',
      allowedFiles: ['example.md'],
      expectedPatch: '+Example fix',
      decidingActorId: 'actor-example',
    },
    goal: {
      intent: 'Produce one example note Artifact without external writes.',
      filename: 'example-note.md',
      decidingActorId: 'actor-example',
      requiredContent: ['Example', 'note'],
    },
    external: {
      executable: '/example/agent',
      modelId: 'example-model',
      persona: 'You are a colleague.',
      goal: 'Find the shared example task and explain its latest result.',
      judgeFile: '/example/judgment.json',
    },
    bounds: { readAttempts: 2, pollMs: 1, observationMs: 100, decisionMs: 100, processMs: 100 },
    sequence: { priorCount: 0, resetReason: null },
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
function observation(tid, turns, items) {
  return {
    dashboard: ok({
      thread: { id: tid, workspaceId: 'workspace-example' },
      turns,
      pendingRequests: [],
      artifacts: [],
    }),
    turnReads: turns.map(ok),
    items: ok({ items, nextCursor: null }),
    artifactReads: [],
  };
}
/** Exact synthetic effect intent whose digest changes with its authorized arguments. */
export function taskIntent(_p, tool, args) {
  return {
    requestId: `request-example-${tool}`,
    turnId: 'turn-example-task-0',
    state: 'pending',
    approvalEffect: {
      detail: { toolName: tool, arguments: args, argumentsDigest: digest(canonical(args)) },
    },
  };
}
/** A complete passing observation set for intervening on each frozen deciding predicate. */
export function bundle(p = parameters()) {
  const b = {
    attribution: {
      candidateCommit: p.candidateCommit,
      checklistBlob: p.checklistBlob,
      configurationDigest: p.deployment.configurationDigest,
      archiveSha256: 'c'.repeat(64),
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
  const web = [];
  b.deployment = {
    build: {
      candidate: p.candidateCommit,
      archiveSha256: b.attribution.archiveSha256,
      buildExitCode: 0,
      smoke: { exitCode: 0 },
      imageId: p.deployment.expectedImage,
      web: { files: web, directoryDigest: digest(canonical(web)) },
    },
    replace: {
      ok: true,
      candidate: p.candidateCommit,
      image: p.deployment.expectedImage,
      newContainerId: 'container-example-new',
      newContainerImage: p.deployment.expectedImage,
      newContainerConfigImage: p.deployment.expectedImage,
      dataRoot: p.deployment.root,
      settingsBefore: { network: 'host' },
      settingsAfter: { network: 'host' },
      sameEnvironmentInMemoryComparison: true,
      sameMounts: true,
      protectedRootKeyTrustSlotMetadataUnchangedAtStart: true,
      webFileCount: 0,
      liveWebPointsAtCommitNamedDirectory: true,
    },
    configurationDigest: p.deployment.configurationDigest,
    components: {
      nanoHost: { unchanged: true, digest: p.deployment.nanoHostDigest },
      worker: { unchanged: true, digest: p.deployment.workerDigest },
    },
    baselineGeneration: 1,
    startup: { rows: [{ health: { httpStatus: 200, body: '{"status":"ok"}' } }] },
    rendered: { commands: [{ arguments: ['snapshot'], exitCode: 0, stdout: 'Sign in' }] },
    public: {
      diagnostics: ok({
        boot: {
          bootId: 'boot-example',
          acceptingProductWork: true,
          subsystems: { app: { reasons: [] } },
        },
      }),
      'workspace-retained': ok({ id: p.workspaceId }),
      'target-1': ok({
        ready: true,
        predecessorFenced: true,
        freshEmpty: true,
        connectionGeneration: 2,
      }),
      binding: ok({
        items: [
          {
            id: 'github',
            approvalRequiredTools: ['example_write'],
            bindingRevision: 1,
            currentVersionDigest: p.deployment.bindingDigest,
          },
        ],
      }),
      closedAt: '2026-01-01T00:01:00.000Z',
    },
  };
  const chat = turn('thread-example-chat', 0);
  b.chat = {
    threadId: chat.threadId,
    submission: ok({
      outcome: 'answered',
      targetRef: 'internal-role:assistant',
      handoff: null,
      originatingWorkspaceId: p.workspaceId,
      receivingWorkspaceId: p.workspaceId,
      originatingThreadId: chat.threadId,
      receivingThreadId: chat.threadId,
    }),
    evidence: observation(chat.threadId, [chat], [item(chat, '19 plus 23 is 42.')]),
  };
  const task = turn('thread-example-task', 0, p.task.agentId),
    taskItems = [item(task, 'Example fix in open unmerged pull request')];
  for (const tool of ['issue_read', 'create_branch', 'push_files', 'create_pull_request'])
    taskItems.push({
      ...item(task, ''),
      id: `tool-example-${tool}`,
      type: 'tool-call',
      tool,
      server: 'github',
      error: null,
      causationId: `cap-example-${tool}`,
    });
  const last = observation(task.threadId, [task], taskItems),
    base = { owner: 'example', repo: 'project' },
    intents = [
      taskIntent(p, 'create_branch', { ...base, branch: p.task.branch, from_branch: p.task.base }),
      taskIntent(p, 'push_files', {
        ...base,
        branch: p.task.branch,
        files: [{ path: 'example.md', content: 'Example fix' }],
        message: 'Example fix',
      }),
      taskIntent(p, 'create_pull_request', {
        ...base,
        head: p.task.branch,
        base: p.task.base,
        title: 'Example fix',
        draft: false,
      }),
    ];
  for (const intent of intents)
    taskItems.push({
      ...item(task, ''),
      id: `decision-example-${intent.requestId}`,
      type: 'approval-decision',
      approvalRequestId: intent.requestId,
      decision: 'granted',
      actor: { id: p.task.decidingActorId },
    });
  last.dashboard.data.pendingRequests = intents.map((q) => ({
    ...q,
    state: 'resolved',
    resolution: 'granted',
    disposition: 'approved-executed',
    decidingActorId: p.task.decidingActorId,
  }));
  b.task = {
    threadId: task.threadId,
    input: { requestId: 'request-example-task' },
    submission: ok({ turn: task }),
    last,
    replay: {
      input: { requestId: 'request-example-task' },
      before: last.dashboard,
      after: last.dashboard,
      replay: ok({ turn: task }),
    },
    decisions: intents.map((q) => ({
      pendingRequest: q,
      input: { decision: 'granted' },
      response: ok({}),
    })),
    github: {
      reads: [1, 2, 3].map(() => ({ exitCode: 0, httpStatus: 200, hasNextPage: false })),
      branch: { name: p.task.branch, headSha: 'f'.repeat(40) },
      pullRequests: [
        {
          pullRequest: { number: 3, state: 'open', merged_at: null, draft: false },
          head: { ref: p.task.branch, sha: 'f'.repeat(40), repository: p.task.repository },
          base: { ref: p.task.base, repository: p.task.repository },
          changedFiles: [{ filename: 'example.md', patch: '+Example fix' }],
        },
      ],
    },
  };
  const pr = b.task.github.pullRequests[0];
  b.task.github.reads = [
    {
      route: `repos/${p.task.repository}/branches/${encodeURIComponent(p.task.branch)}`,
      body: b.task.github.branch,
    },
    {
      route: `repos/${p.task.repository}/pulls?state=all&base=${encodeURIComponent(p.task.base)}&head=${encodeURIComponent(`${p.task.repository.split('/')[0]}:${p.task.branch}`)}&per_page=100`,
      body: [{ pullRequest: pr.pullRequest, head: pr.head, base: pr.base }],
    },
    { route: `repos/${p.task.repository}/pulls/3/files?per_page=100`, body: pr.changedFiles },
  ].map(({ route, body }) => ({
    route,
    body: structuredClone(body),
    bodyDigest: digest(canonical(body)),
    exitCode: 0,
    httpStatus: 200,
    hasNextPage: false,
  }));
  const gt = turn('thread-example-goal', 0, 'goal-coordinator'),
    bytes = canonical({
      intentBasis: { intent: p.goal.intent, revision: 0 },
      cards: [{ cardId: 'card-example', revision: 0 }],
    }),
    version = { planVersionId: 'plan-example', bytes, digest: digest(bytes) },
    pending = {
      requestId: 'request-example-plan',
      operation: 'goal.plan.approve',
      state: 'pending',
      exactIntent: {
        goalId: 'goal-example',
        planVersionId: version.planVersionId,
        bytes,
        digest: digest(bytes),
      },
    },
    before = {
      goal: {
        goalId: 'goal-example',
        intentRevision: 0,
        proposedPlanVersionId: version.planVersionId,
        activePlanVersionId: null,
      },
      versions: [version],
      tasks: [],
    },
    completionBytes = canonical({
      intent: p.goal.intent,
      intentRevision: 0,
      planVersionId: version.planVersionId,
      unresolvedWork: [],
      evidence: [{ kind: 'artifact', id: 'artifact-example-note', digest: digest('Example note') }],
    }),
    completion = {
      requestId: 'request-example-completion',
      operation: 'goal.completion.accept',
      exactIntent: {
        goalId: 'goal-example',
        bytes: completionBytes,
        digest: digest(completionBytes),
      },
    };
  b.goal = {
    threadId: gt.threadId,
    evidence: observation(gt.threadId, [gt], [item(gt, 'Goal completed')]),
    planDecision: { exactPlan: version, exactPendingRequest: pending, before: ok(before) },
    completionDecision: { request: completion },
    linkedTask: (() => {
      const t = turn('thread-example-linked', 0, 'agent-example-codex'),
        a = {
          id: 'artifact-example-note',
          kind: 'file',
          title: p.goal.filename,
          content: { format: 'text', body: 'Example note' },
          contentDigest: digest('Example note'),
          origin: {
            kind: 'turn-output',
            threadId: t.threadId,
            turnId: t.id,
            requestId: 'submission-example-note',
          },
        };
      return {
        ...observation(
          t.threadId,
          [t],
          [
            item(t, 'Example note'),
            {
              ...item(t, ''),
              type: 'artifact-reference',
              artifactId: a.id,
              lastMutationRequestId: a.origin.requestId,
            },
          ]
        ),
        artifactReads: [ok(a)],
      };
    })(),
    lastGoal: ok({
      goal: {
        goalId: 'goal-example',
        intent: p.goal.intent,
        intentRevision: 0,
        activePlanVersionId: version.planVersionId,
        changeRevision: 1,
        consideredRevision: 1,
        disposition: {
          kind: 'accepted',
          candidate: JSON.parse(completionBytes),
          pendingRequestId: completion.requestId,
          actorId: p.goal.decidingActorId,
        },
      },
      cards: [{ cardId: 'card-example', revision: 0 }],
      versions: [version],
      tasks: [
        {
          threadId: 'thread-example-linked',
          planVersionId: version.planVersionId,
          cardId: 'card-example',
          cardRevision: 0,
        },
      ],
      requests: [
        {
          ...pending,
          state: 'resolved',
          resolution: 'granted',
          claim: 'finished',
          disposition: 'approved-executed',
          decidingActorId: p.goal.decidingActorId,
        },
        {
          ...completion,
          state: 'resolved',
          resolution: 'granted',
          claim: 'finished',
          disposition: 'approved-executed',
          decidingActorId: p.goal.decidingActorId,
        },
      ],
    }),
  };
  const answer = 'The example task produced the fix and an open unmerged pull request.',
    reply = taskItems[0].text,
    independent = { ...last, thread: ok({ id: task.threadId }), latestTurnId: task.id };
  b.external = {
    receipt: {
      exitCode: 0,
      outsideSourceCheckout: true,
      workingDirectoryRemoved: true,
      checklistExpectedAnswerSshToolsAndPreflightOutputSupplied: false,
      carrierSha256: 'e'.repeat(64),
      clientVersion: 'example-client',
      stdout: JSON.stringify({ item: { type: 'agent_message', text: answer } }),
    },
    preflight: { passed: true, carrierSha256: 'e'.repeat(64) },
    transcript: [
      { method: 'initialize', httpStatus: 200 },
      { method: 'tools/list', httpStatus: 200 },
      {
        method: 'tools/call',
        httpStatus: 200,
        request: {
          params: {
            name: 'call',
            arguments: { operation: 'thread.dashboard', input: { threadId: task.threadId } },
          },
        },
        response: {
          result: { content: [{ type: 'text', text: JSON.stringify(last.dashboard.data) }] },
        },
      },
    ],
    independent,
    judgment: {
      checker: 'checker-example',
      recordId: task.id,
      publicReplyDigest: digest(reply),
      answerDigest: digest(answer),
      servedCandidate: p.candidateCommit,
      servedImage: b.deployment.build.imageId,
      grounded: true,
    },
  };
  return b;
}

/** Owner-shaped prepared Worker candidate with an exact payload-bound preview. */
export function preparedWorker(input) {
  const agentId = input.target.agentId,
    ref = (kind) => ({
      artifactId: `artifact-example-${kind}-${agentId}`,
      artifactVersion: 1,
      contentDigest: digest(`${kind}-${agentId}`),
    });
  const value = {
    requestId: input.requestId,
    target: input.target,
    configuration: input.configuration,
    authoredCandidate: ref('authored'),
    resolvedCandidate: ref('resolved'),
    image: {
      digest: input.declaration.ref,
      platform: { os: 'linux', architecture: 'amd64' },
      storageLayout: {
        family: null,
        version: null,
        uid: 1000,
        gid: 1000,
        workingDirectory: '/workspace',
        targets: [{ target: '/workspace' }],
      },
    },
    affectedStorage: [],
    replaceNow: null,
    preparedAt: start,
  };
  value.activationConfirmation = `activate-worker-environment:${JSON.stringify({
    affectedStorage: [],
    imageDigest: input.declaration.ref,
    defaultsDigest: null,
    configuration: input.configuration,
    replaceNow: null,
    resolvedCandidate: value.resolvedCandidate,
    target: input.target,
  })}`;
  return value;
}

/** Synthetic host build identity from the same extracted source as the App. */
export function workerBuild(p, appBuild) {
  return {
    ok: true,
    exitCode: 0,
    candidate: p.candidateCommit,
    buildDirectory: appBuild.buildDirectory,
    archiveSha256: appBuild.archiveSha256,
    target: 'worker-runtimes',
    platform: 'linux/amd64',
    archive: '/example/archives/worker.oci.tar',
    archiveDigest: digest('example-oci-archive'),
    digest: digest('example-worker-manifest'),
  };
}
