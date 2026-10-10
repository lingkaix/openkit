/** Offline comparisons of complete deciding public records; no transport or host access. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  canonical,
  digest,
  files,
  RUNTIMES,
  readJson,
  SCENARIOS,
  save,
  sha,
  validateParams,
  workerActivationInput,
  workerPreparedMatches,
} from './safety.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const data = (v) => (v?.ok === true ? v.data : undefined);
const artifact = (v) => data(v)?.artifact ?? data(v);
const assistant = (items) =>
  (items ?? []).filter((i) => i.type === 'assistant-message' && i.status === 'completed');
const id = (v) => v?.id ?? v?.artifactId;
const blocking = (v) => v === true || (Array.isArray(v) && v.length > 0);
const complete = (v) =>
  v && Array.isArray(v.items) && Object.hasOwn(v, 'nextCursor') && v.nextCursor === null;
const same = (a, b) => canonical(a) === canonical(b);
function checker(scenario, refs) {
  const failures = [];
  return {
    test: (predicate, present, holds) => {
      if (!present) failures.push({ predicate, kind: 'missing' });
      else if (!holds) failures.push({ predicate, kind: 'observed' });
    },
    finish: (status) => ({
      scenario,
      mechanicalCode: failures.length
        ? failures.some((f) => f.kind === 'missing')
          ? 'I'
          : 'N'
        : 'P',
      actualStatus: status ?? 'unavailable',
      failures,
      evidence: refs,
    }),
  };
}
function observation(c, e, tid, ws) {
  const board = data(e?.dashboard),
    items = data(e?.items),
    turns = e?.turnReads?.map(data);
  c.test(
    'complete Turn and Item coverage',
    board &&
      Array.isArray(board.turns) &&
      complete(items) &&
      turns &&
      turns.every(Boolean) &&
      turns.length === board.turns.length &&
      same(turns.map((t) => t.id).sort(), board.turns.map((t) => t.id).sort()),
    complete(items) &&
      turns.length === board.turns.length &&
      same(turns.map((t) => t.id).sort(), board.turns.map((t) => t.id).sort())
  );
  c.test(
    'addressed public Thread lineage',
    board?.thread && turns,
    board?.thread?.id === tid &&
      board?.thread?.workspaceId === ws &&
      turns?.every((t) => t.threadId === tid && t.workspaceId === ws)
  );
  c.test(
    'terminal observed Turns',
    turns && turns.length > 0,
    turns?.every((t) => terminal.has(t.status))
  );
  return { board, items: items?.items ?? [], turns: turns ?? [] };
}

/** Compare each runtime row independently, including failed Turns that produced files. */
export function runtimeRows(r, issue, p, runtime, refs, binding) {
  return ['A', 'B', 'C', 'D'].map((letter) => {
    const c = checker(`${runtime}.${letter}`, refs),
      steps = r?.steps?.filter((s) => s.scenario.toUpperCase() === letter) ?? [];
    c.test('one scenario observation', steps.length === 1, true);
    const s = steps[0];
    if (!s) return c.finish();
    const turn = s.turn,
      coverage = s.itemCoverage,
      items = coverage?.items?.filter((i) => i.turnId === s.turnId) ?? [],
      cfg = p.runtimes[runtime];
    c.test(
      'public terminal Turn and admission',
      turn && s.submission,
      terminal.has(turn?.status) && data(s.submission)?.id === s.turnId && turn?.id === s.turnId
    );
    c.test(
      'runtime, model and configuration attribution',
      turn && s.submitInput,
      turn?.threadId === r.threadId &&
        turn?.workspaceId === p.workspaceId &&
        turn?.agentId === cfg.agentId &&
        turn?.agentProfileId === cfg.profileId &&
        turn?.configVersion === cfg.configurationVersion &&
        (s.submitInput?.modelId === undefined ? 'configured default' : s.submitInput.modelId) ===
          cfg.modelId
    );
    c.test('complete Item pagination', complete(coverage), true);
    c.test('successful Turn', turn, turn?.status === 'completed' && turn?.error === null);
    c.test(
      'same-Turn completed assistant Item',
      coverage,
      assistant(items).some((i) => i.threadId === r.threadId)
    );
    const replies = assistant(items).map((i) => i.text);
    if (letter === 'A')
      c.test('exact declared marker reply', coverage, replies.includes(cfg.marker));
    if (letter === 'B') {
      c.test(
        'independent issue identity',
        issue,
        issue?.readExit === 0 &&
          issue?.issue?.number === p.issue.number &&
          issue?.issue?.title === p.issue.title &&
          issue?.issue?.state === p.issue.state
      );
      c.test(
        'issue title and state in completed reply',
        coverage,
        replies.some(
          (t) => t.includes(p.issue.title) && t.toLowerCase().includes(p.issue.state.toLowerCase())
        )
      );
      c.test(
        'completed Gateway issue capability call',
        coverage,
        items.some(
          (i) =>
            i.type === 'tool-call' &&
            i.status === 'completed' &&
            i.server === 'github' &&
            ['issue_read', 'get_issue'].includes(i.tool) &&
            i.error === null &&
            typeof i.causationId === 'string'
        )
      );
      const github = binding?.find((v) => v.id === 'github');
      c.test(
        'issue read without completed GitHub writes',
        Array.isArray(github?.approvalRequiredTools) && coverage,
        !items.some(
          (i) =>
            i.type === 'tool-call' &&
            i.status === 'completed' &&
            i.server === 'github' &&
            github?.approvalRequiredTools?.includes(i.tool)
        )
      );
    }
    if (letter === 'C' || letter === 'D') {
      c.test(
        'file title and marker in completed reply',
        coverage,
        replies.some((t) => t.includes(cfg.filename) && t.includes(cfg.marker))
      );
      c.test(
        'complete public Artifact collection',
        s.dashboard && s.artifactReads,
        Array.isArray(s.dashboard?.artifacts) &&
          s.artifactReads?.every((v) => v.ok) &&
          s.dashboard?.artifacts?.every((a) =>
            s.artifactReads.some((v) => id(artifact(v)) === id(a))
          )
      );
      const valid = (s.artifactReads ?? [])
        .map(artifact)
        .filter((a) => validArtifact(a, cfg.filename, cfg.marker, r.threadId, s.turnId));
      c.test(
        'same-Turn Artifact origin, bytes and recomputed digest',
        s.artifactReads,
        valid.length === 1
      );
      c.test(
        'completed same-Turn Artifact reference and request',
        coverage,
        valid.some((a) =>
          items.some(
            (i) =>
              i.type === 'artifact-reference' &&
              i.status === 'completed' &&
              i.artifactId === id(a) &&
              i.turnId === s.turnId &&
              i.lastMutationRequestId === a.origin.requestId
          )
        )
      );
      if (letter === 'D') {
        const previous = r.steps.find((v) => v.scenario.toUpperCase() === 'C'),
          earlier = (previous?.artifactReads ?? [])
            .map(artifact)
            .filter((a) =>
              validArtifact(a, cfg.filename, cfg.marker, r.threadId, previous?.turnId)
            );
        c.test(
          'distinct follow-up on same Thread after terminal predecessor',
          previous?.turn && turn,
          previous?.turnId !== s.turnId &&
            terminal.has(previous?.turn?.status) &&
            turn?.threadId === previous?.turn?.threadId &&
            Date.parse(turn?.startedAt) >= Date.parse(previous?.turn?.completedAt)
        );
        c.test(
          'earlier Items retained byte-equivalent',
          previous?.itemCoverage && coverage,
          (previous?.items ?? []).length > 0 &&
            (previous?.items ?? []).every((old) => coverage?.items?.some((v) => same(old, v)))
        );
        c.test(
          'own new submission and immutable earlier file equality',
          s.artifactReads && previous?.artifactReads,
          valid.length === 1 &&
            earlier.length === 1 &&
            id(valid[0]) !== id(earlier[0]) &&
            valid[0].origin.requestId !== earlier[0].origin.requestId &&
            s.artifactReads.some((v) => same(artifact(v), earlier[0]))
        );
      }
    }
    return c.finish(turn?.status ?? s.submission?.error?.code);
  });
}
function validArtifact(a, title, body, tid, turnId) {
  return (
    a?.kind === 'file' &&
    a.title === title &&
    a.content?.format === 'text' &&
    a.content.body === body &&
    a.contentDigest === digest(Buffer.from(body, 'utf8')) &&
    a.origin?.kind === 'turn-output' &&
    a.origin.threadId === tid &&
    a.origin.turnId === turnId &&
    typeof a.origin.requestId === 'string' &&
    a.origin.requestId.length > 0
  );
}

function deploymentRow(bundle, p) {
  const r = bundle.deployment,
    c = checker('Deploy', r?.refs ?? ['round.json']),
    b = r?.build,
    x = r?.replace,
    d = r?.public;
  const update = r?.workerUpdate,
    failure = update?.failure;
  if (failure) {
    const proof = failure.proof,
      observed =
        proof?.ok === false ||
        (failure.stage === 'import digest' &&
          proof?.ok === true &&
          proof.digest !== update.build?.digest) ||
        (failure.stage === 'owner status' &&
          proof?.ok === true &&
          (proof.data?.desired?.imageDigest !== update.build?.digest ||
            proof.data?.reload?.matchesDesired !== true ||
            proof.data?.persistedRevision !==
              update.agents?.at(-1)?.activated?.data?.configuration?.revision)) ||
        (failure.stage === 'decision timeout' &&
          Number.isFinite(Date.parse(proof?.expiresAt)) &&
          Date.parse(proof.observedAt) >= Date.parse(proof.expiresAt) &&
          proof.submitted === false);
    c.test(`Worker maintenance ${failure.stage} refused before admission`, observed, false);
    return c.finish('failed');
  }
  c.test(
    'maintained exact-source build and smoke receipt',
    b && x,
    b?.candidate === p.candidateCommit &&
      x?.candidate === p.candidateCommit &&
      b?.buildExitCode === 0 &&
      b?.smoke?.exitCode === 0 &&
      b?.archiveSha256 === bundle.attribution.archiveSha256 &&
      x?.ok === true
  );
  c.test(
    'served image and container attribution',
    b && x,
    b?.imageId === x?.image &&
      x?.newContainerImage === b?.imageId &&
      x?.newContainerConfigImage === b?.imageId &&
      Boolean(x?.newContainerId)
  );
  c.test(
    'protected settings, root and environment preserved',
    x,
    x?.dataRoot === p.deployment.root &&
      same(x?.settingsBefore, x?.settingsAfter) &&
      x?.sameEnvironmentInMemoryComparison === true &&
      x?.sameMounts === true &&
      x?.protectedRootKeyTrustSlotMetadataUnchangedAtStart === true
  );
  c.test(
    'Web identity and exact extracted bytes',
    b?.web && x,
    b?.web?.directoryDigest === digest(canonical(b?.web?.files)) &&
      b?.web?.files?.length === x?.webFileCount &&
      x?.liveWebPointsAtCommitNamedDirectory === true
  );
  c.test(
    'retained NanoHost and unchanged-or-updated Worker attribution',
    r?.components,
    r?.components?.nanoHost?.unchanged === true &&
      r?.components?.nanoHost?.digest === p.deployment.nanoHostDigest &&
      (r?.components?.worker?.unchanged === true
        ? r.components.worker.digest === p.deployment.workerDigest
        : r?.components?.worker?.unchanged === false &&
          r.components.worker.changedInputs?.length > 0 &&
          r.components.worker.sourceCommit === p.candidateCommit &&
          r.components.worker.digest === update?.build?.digest)
  );
  if (r?.components?.worker?.unchanged === false) {
    const build = update?.build,
      imported = update?.import;
    c.test(
      'host-platform Worker build from the same exact App source',
      build,
      build?.ok === true &&
        build.candidate === p.candidateCommit &&
        build.buildDirectory === b?.buildDirectory &&
        build.archiveSha256 === b?.archiveSha256 &&
        build.target === 'worker-runtimes' &&
        ['linux/amd64', 'linux/arm64'].includes(build.platform) &&
        /^sha256:[a-f0-9]{64}$/.test(build.digest) &&
        /^sha256:[a-f0-9]{64}$/.test(build.archiveDigest)
    );
    c.test(
      'NanoHost import preserves the archive manifest digest',
      imported,
      imported?.ok === true &&
        imported.exitCode === 0 &&
        imported.digest === build?.digest &&
        imported.expectedDigest === build?.digest &&
        imported.archiveDigest === build?.archiveDigest
    );
    const administration = data(update?.administration);
    c.test(
      'round-owned private administration Thread created through the public entry',
      administration,
      administration?.outcome === 'answered' &&
        administration.targetRef === 'internal-role:administration' &&
        administration.turn?.status === 'completed' &&
        administration.receivingThreadId === update?.administrationThreadId &&
        administration.receivingThreadId === administration.turn?.threadId &&
        administration.receivingWorkspaceId === administration.turn?.workspaceId &&
        Array.isArray(administration.turn?.items) &&
        administration.turn.items.every((v) => !v.type.includes('tool'))
    );
    const agents = update?.agents;
    c.test(
      'complete unique declared Agent activation coverage',
      agents,
      agents?.length === p.deployment.workerAgents.length &&
        new Set(agents?.map((v) => v.agentId)).size === agents?.length &&
        p.deployment.workerAgents.every((id) => agents?.some((v) => v.agentId === id))
    );
    for (const agentId of p.deployment.workerAgents) {
      const entry = agents?.find((v) => v.agentId === agentId),
        prepared = data(entry?.prepared),
        activated = data(entry?.activated),
        status = data(entry?.status),
        decision = entry?.decision;
      c.test(
        `exact prepared Worker candidate for declared Agent ${sha(agentId)}`,
        prepared && entry?.input && entry?.before,
        prepared?.requestId === entry?.input.requestId &&
          entry?.input.administrationThreadId === update?.administrationThreadId &&
          entry?.input.target.agentId === agentId &&
          entry?.input.declaration.kind === 'reference' &&
          entry?.input.declaration.ref === build?.digest &&
          entry?.input.declaration.pullPolicy === 'never' &&
          !Object.hasOwn(entry?.input ?? {}, 'replaceNow') &&
          entry?.before.data?.agentId === agentId &&
          entry?.before.data?.fileId === prepared?.configuration.fileId &&
          entry?.before.data?.persistedRevision === prepared?.configuration.expectedRevision &&
          workerPreparedMatches(
            prepared,
            { kind: 'agent', agentId },
            entry?.input.configuration,
            build?.digest
          )
      );
      c.test(
        `administrator decision and unchanged activation for declared Agent ${sha(agentId)}`,
        decision && activated,
        decision?.kind === 'worker-environment' &&
          decision.decision === 'grant' &&
          Boolean(decision.operator) &&
          Number.isFinite(Date.parse(decision.decidedAt)) &&
          same(decision.prepared, entry?.prepared) &&
          decision.requestId === prepared?.resolvedCandidate.artifactId &&
          same(
            decision.input,
            prepared && workerActivationInput(prepared, decision.input?.requestId)
          ) &&
          activated?.requestId === decision?.input.requestId &&
          same(activated?.target, prepared?.target) &&
          same(activated?.resolvedCandidate, prepared?.resolvedCandidate) &&
          activated?.replaceNow === null &&
          activated?.affected?.length === 0 &&
          activated?.configuration?.fileId === prepared?.configuration.fileId
      );
      c.test(
        `owner-reported imported Worker digest for declared Agent ${sha(agentId)}`,
        status,
        status?.agentId === agentId &&
          status.fileId === prepared?.configuration.fileId &&
          status.persistedRevision === activated?.configuration?.revision &&
          status.desired?.imageDigest === build?.digest &&
          status.reload?.matchesDesired === true
      );
    }
    c.test(
      'all Worker updates precede scenario admission',
      update?.readyAt && d?.closedAt,
      Date.parse(update?.readyAt) <= Date.parse(d?.closedAt)
    );
  }
  const health = r?.startup?.rows ?? [];
  c.test(
    'public healthy response',
    r?.startup,
    health.some(
      (v) => v.health?.httpStatus === 200 && JSON.parse(v.health.body ?? '{}').status === 'ok'
    )
  );
  const commands = r?.rendered?.commands;
  c.test(
    'rendered Web entry',
    commands,
    commands?.some(
      (v) =>
        v.arguments.includes('snapshot') &&
        v.exitCode === 0 &&
        /Sign in|Account access/.test(v.stdout)
    )
  );
  const diagnostic = data(d?.diagnostics),
    workspace = data(d?.['workspace-retained']),
    target = Object.entries(d ?? {})
      .filter(([k]) => k.startsWith('target-'))
      .map(([, v]) => data(v))
      .find((v) => v?.ready);
  c.test(
    'authenticated ready boot and Workspace read',
    diagnostic && workspace,
    diagnostic?.boot?.acceptingProductWork === true &&
      Boolean(diagnostic?.boot?.bootId) &&
      Object.values(diagnostic?.boot?.subsystems ?? {}).every((s) =>
        s.reasons.every((v) => !blocking(v.blocks))
      ) &&
      workspace?.id === p.workspaceId
  );
  const workerTurns = [
    ...Object.values(bundle.runtimes ?? {}).flatMap((v) =>
      (v.steps ?? []).flatMap((s) => [s.turn, ...(s.dashboard?.turns ?? [])])
    ),
    ...[
      bundle.task?.last,
      bundle.chat?.evidence,
      bundle.goal?.evidence,
      bundle.goal?.linkedTask,
      bundle.external?.independent,
    ].flatMap((v) => [...(v?.turnReads ?? []).map(data), ...(data(v?.dashboard)?.turns ?? [])]),
  ].filter((t) => t?.agentId !== 'quick-chat');
  const starts = workerTurns.map((t) => Date.parse(t?.startedAt));
  c.test(
    'ready fenced fresh target before first Worker',
    target &&
      Number.isFinite(Date.parse(d?.closedAt)) &&
      starts.length > 0 &&
      starts.every(Number.isFinite),
    target?.ready === true &&
      target?.predecessorFenced === true &&
      target?.freshEmpty === true &&
      target?.connectionGeneration > r?.baselineGeneration &&
      Date.parse(d.closedAt) < Math.min(...starts)
  );
  const binding = data(d?.binding)?.items;
  c.test(
    'protected configuration binding',
    binding,
    binding?.some(
      (v) =>
        v.bindingRevision === p.deployment.bindingRevision &&
        v.currentVersionDigest === p.deployment.bindingDigest
    ) && r?.configurationDigest === p.deployment.configurationDigest
  );
  return c.finish(x?.ok ? 'installed' : 'unavailable');
}
function chatRow(r, p) {
  const c = checker('Chat', r?.refs ?? ['round.json']),
    d = data(r?.submission),
    o = observation(c, r?.evidence, r?.threadId, p.workspaceId);
  c.test(
    'conversation answered on addressed Thread with no handoff',
    d,
    d?.outcome === 'answered' &&
      d?.targetRef === 'internal-role:assistant' &&
      d?.handoff === null &&
      d?.originatingWorkspaceId === p.workspaceId &&
      d?.receivingWorkspaceId === p.workspaceId &&
      d?.originatingThreadId === r.threadId &&
      d?.receivingThreadId === r.threadId
  );
  const handoff = o.items.some(
    (i) =>
      /handoff|worker-delegation/.test(i.type) ||
      (i.type === 'status' && ['Task Mode handoff', 'Goal Mode handoff'].includes(i.title))
  );
  c.test(
    'receipt and Item handoff evidence agree',
    !(d?.outcome === 'answered' && d?.handoff === null && handoff),
    true
  );
  c.test(
    'completed quick-chat answer without Worker delegation',
    r?.evidence,
    o.turns.length === 1 &&
      o.turns[0].status === 'completed' &&
      o.turns[0].agentId === 'quick-chat' &&
      assistant(o.items).some((i) => i.turnId === o.turns[0].id && /\b42\b/.test(i.text)) &&
      !handoff
  );
  return c.finish(o.turns[0]?.status ?? r?.submission?.error?.code);
}

/** Project the parsed deciding bodies by their fixed read routes for retention and comparison. */
export function taskReadProjections(g, p) {
  const base = `repos/${p.task.repository}`;
  const prs = g?.pullRequests ?? [];
  return [
    { route: `${base}/branches/${encodeURIComponent(p.task.branch)}`, body: g?.branch ?? null },
    {
      route: `${base}/pulls?state=all&base=${encodeURIComponent(p.task.base)}&head=${encodeURIComponent(`${p.task.repository.split('/')[0]}:${p.task.branch}`)}&per_page=100`,
      body: prs.map(({ changedFiles: _files, ...pr }) => pr),
    },
    ...prs.map((pr) => ({
      route: `${base}/pulls/${pr.pullRequest?.number}/files?per_page=100`,
      body: pr.changedFiles,
    })),
  ];
}

/** Validate the exact effect object, not a prose authorization label or boolean. */
export function allowedTaskIntent(q, p) {
  try {
    const raw = q.approvalEffect?.detail,
      d = typeof raw === 'string' ? JSON.parse(raw) : raw,
      a = d.arguments;
    if (!a || digest(canonical(a)) !== d.argumentsDigest) return false;
    const [owner, repo] = p.task.repository.split('/');
    if (a.owner !== owner || a.repo !== repo) return false;
    if (d.toolName === 'create_branch')
      return (
        Object.keys(a).every((k) => ['owner', 'repo', 'branch', 'from_branch'].includes(k)) &&
        a.branch === p.task.branch &&
        (a.from_branch ?? p.task.base) === p.task.base
      );
    if (d.toolName === 'push_files')
      return (
        Object.keys(a).every((k) => ['owner', 'repo', 'branch', 'files', 'message'].includes(k)) &&
        a.branch === p.task.branch &&
        Array.isArray(a.files) &&
        a.files.length > 0 &&
        a.files.every(
          (f) =>
            Object.keys(f).every((k) => ['path', 'content'].includes(k)) &&
            p.task.allowedFiles.includes(f.path) &&
            typeof f.content === 'string'
        )
      );
    if (d.toolName === 'create_pull_request')
      return (
        Object.keys(a).every((k) =>
          [
            'owner',
            'repo',
            'head',
            'base',
            'title',
            'body',
            'draft',
            'maintainer_can_modify',
          ].includes(k)
        ) &&
        a.head === p.task.branch &&
        a.base === p.task.base &&
        (a.draft ?? false) === false
      );
    return false;
  } catch {
    return false;
  }
}
function taskRow(r, p) {
  const c = checker('Task', r?.refs ?? ['round.json']),
    o = observation(c, r?.last, r?.threadId, p.workspaceId),
    admission = data(r?.submission),
    replay = r?.replay;
  c.test(
    'exact Task admission',
    admission,
    admission?.turn?.threadId === r?.threadId &&
      admission?.turn?.agentId === p.task.agentId &&
      o.turns.some((t) => t.id === admission?.turn?.id)
  );
  c.test(
    'current-owner replay preserves request and all Turns',
    replay?.input && replay?.before && replay?.after && replay?.replay,
    same(replay?.input, r?.input) &&
      same(
        data(replay?.before)?.turns.map((t) => t.id),
        data(replay?.after)?.turns.map((t) => t.id)
      ) &&
      data(replay?.replay)?.turn?.id === admission?.turn?.id
  );
  c.test(
    'terminal successful Task with completed result Items',
    r?.last,
    o.turns.length > 0 &&
      o.turns.every((t) => t.status === 'completed' && t.error === null) &&
      assistant(o.items).length > 0
  );
  const requests = o.board?.pendingRequests,
    decisions = r?.decisions ?? [];
  c.test(
    'complete exact authorization decisions and actors',
    requests && r?.decisions,
    requests?.length === 3 &&
      requests?.every(
        (q) =>
          q.state === 'resolved' &&
          q.resolution === 'granted' &&
          q.disposition === 'approved-executed' &&
          o.items.some(
            (i) =>
              i.type === 'approval-decision' &&
              i.approvalRequestId === q.requestId &&
              i.status === 'completed' &&
              i.decision === 'granted' &&
              i.actor?.id === p.task.decidingActorId
          ) &&
          decisions.some(
            (v) =>
              v.pendingRequest?.requestId === q.requestId &&
              allowedTaskIntent(v.pendingRequest, p) &&
              v.input?.decision === 'granted' &&
              v.response?.ok === true
          )
      )
  );
  c.test(
    'causally linked completed GitHub reads and writes',
    r?.last,
    ['issue_read', 'create_branch', 'push_files', 'create_pull_request'].every((tool) =>
      o.items.some(
        (i) =>
          i.type === 'tool-call' &&
          i.tool === tool &&
          i.server === 'github' &&
          i.status === 'completed' &&
          i.error === null &&
          i.causationId
      )
    )
  );
  const g = r?.github;
  const expectedReads = taskReadProjections(g, p);
  c.test(
    'fresh route-bound parsed branch, PR and changed-file bodies',
    Array.isArray(g?.pullRequests) &&
      g?.reads?.length === expectedReads.length &&
      expectedReads.every((expected) => {
        const reads = g.reads.filter((v) => v.route === expected.route);
        return (
          reads.length === 1 &&
          Object.hasOwn(reads[0], 'body') &&
          reads[0].bodyDigest === digest(canonical(reads[0].body)) &&
          same(reads[0].body, expected.body) &&
          reads[0].hasNextPage === false
        );
      }),
    g?.reads?.every((v) => v.exitCode === 0 && v.httpStatus === 200)
  );
  const prs = g?.pullRequests ?? [],
    matches = prs.filter(
      (v) =>
        v.head?.ref === p.task.branch &&
        v.base?.ref === p.task.base &&
        v.head?.repository === p.task.repository &&
        v.base?.repository === p.task.repository &&
        v.pullRequest?.state === 'open' &&
        v.pullRequest?.merged_at === null &&
        !v.pullRequest?.draft
    );
  c.test(
    'one open unmerged PR with branch-head equality',
    g,
    g?.branch?.name === p.task.branch &&
      matches.length === 1 &&
      matches[0].head.sha === g?.branch?.headSha
  );
  c.test(
    'meaningful authorized changed-file diff',
    g,
    matches.length === 1 &&
      matches[0].changedFiles.length > 0 &&
      matches[0].changedFiles.every(
        (f) =>
          p.task.allowedFiles.includes(f.filename) &&
          typeof f.patch === 'string' &&
          f.patch.includes(p.task.expectedPatch)
      )
  );
  return c.finish(o.turns.at(-1)?.status ?? r?.submission?.error?.code);
}

/** Check exact immutable Goal intents against a current, fully retained public version. */
export function allowedGoalIntent(q, g, p) {
  try {
    const e = q.exactIntent;
    if (!e || e.goalId !== g.goal.goalId || digest(e.bytes) !== e.digest) return false;
    const parsed = JSON.parse(e.bytes);
    if (q.operation === 'goal.plan.approve') {
      const v = g.versions.find((v) => v.planVersionId === g.goal.proposedPlanVersionId);
      return (
        e.planVersionId === v?.planVersionId &&
        e.bytes === v.bytes &&
        e.digest === v.digest &&
        parsed.intentBasis?.intent === p.goal.intent &&
        parsed.intentBasis?.revision === g.goal.intentRevision &&
        parsed.cards?.length === 1 &&
        !g.tasks.length &&
        g.goal.activePlanVersionId === null
      );
    }
    if (q.operation === 'goal.completion.accept')
      return (
        parsed.intent === p.goal.intent &&
        parsed.intentRevision === g.goal.intentRevision &&
        parsed.planVersionId === g.goal.activePlanVersionId &&
        parsed.unresolvedWork?.length === 0 &&
        parsed.evidence?.length > 0 &&
        g.tasks.length === 1 &&
        g.tasks[0].planVersionId === parsed.planVersionId
      );
    return false;
  } catch {
    return false;
  }
}
function goalRow(r, p) {
  const c = checker('Goal', r?.refs ?? ['round.json']),
    g = data(r?.lastGoal),
    o = observation(c, r?.evidence, r?.threadId, p.workspaceId),
    decision = r?.planDecision,
    v = decision?.exactPlan;
  c.test(
    'public intent and one bounded card',
    g,
    g?.goal?.intent === p.goal.intent && g?.cards?.length === 1
  );
  c.test(
    'immutable exact Plan approved and consumed by responsible actor',
    g && decision,
    g?.goal?.activePlanVersionId === v?.planVersionId &&
      digest(v?.bytes ?? '') === v?.digest &&
      g?.versions?.some((x) => same(x, v)) &&
      g?.requests?.some(
        (q) =>
          q.requestId === decision?.exactPendingRequest?.requestId &&
          q.resolution === 'granted' &&
          q.claim === 'finished' &&
          q.disposition === 'approved-executed' &&
          q.decidingActorId === p.goal.decidingActorId
      ) &&
      allowedGoalIntent(decision?.exactPendingRequest, data(decision?.before), p)
  );
  c.test(
    'no Task before exact Plan grant',
    decision?.before,
    data(decision?.before)?.tasks?.length === 0
  );
  c.test(
    'complete Goal observation with no unresolved request',
    g && r?.evidence,
    g?.goal?.consideredRevision === g?.goal?.changeRevision &&
      !g?.requests?.some((q) => q.state === 'pending')
  );
  const linked = g?.tasks?.[0],
    output = r?.linkedTask,
    linkedTurns = output?.turnReads?.map(data) ?? [],
    outputItems = data(output?.items);
  const valid = (output?.artifactReads ?? [])
    .map(artifact)
    .filter(
      (a) =>
        a?.title === p.goal.filename &&
        typeof a.content?.body === 'string' &&
        p.goal.requiredContent.every((v) => a.content.body.includes(v)) &&
        validArtifact(a, p.goal.filename, a.content.body, linked?.threadId, a.origin?.turnId) &&
        linkedTurns.some((t) => t?.id === a.origin.turnId && t.status === 'completed') &&
        outputItems?.items?.some(
          (i) =>
            i.type === 'artifact-reference' &&
            i.status === 'completed' &&
            i.artifactId === id(a) &&
            i.turnId === a.origin.turnId
        )
    );
  c.test(
    'linked Task and public output',
    g && r?.evidence,
    g?.tasks?.length === 1 &&
      complete(outputItems) &&
      valid.length === 1 &&
      linkedTurns.length > 0 &&
      linkedTurns.every((t) => t?.status === 'completed') &&
      !outputItems?.items?.some(
        (i) =>
          i.type === 'tool-call' &&
          i.server === 'github' &&
          [
            'create_branch',
            'push_files',
            'create_pull_request',
            'issue_write',
            'merge_pull_request',
            'add_issue_comment',
          ].includes(i.tool)
      )
  );
  if (g?.tasks?.length)
    c.test(
      'linked Task card and Plan identity',
      linked,
      linked.planVersionId === g.goal.activePlanVersionId &&
        JSON.parse(v?.bytes ?? 'null')?.cards?.some(
          (card) => card.cardId === linked.cardId && card.revision === linked.cardRevision
        )
    );
  const completion = r?.completionDecision;
  c.test(
    'exact completion candidate grant consumed and Goal accepted',
    g,
    g?.goal?.disposition?.kind === 'accepted' &&
      Boolean(completion) &&
      allowedGoalIntent(completion?.request, g, p) &&
      g?.requests?.some(
        (q) =>
          q.requestId === completion?.request?.requestId &&
          q.resolution === 'granted' &&
          q.claim === 'finished' &&
          q.decidingActorId === p.goal.decidingActorId &&
          q.disposition === 'approved-executed'
      ) &&
      same(
        g.goal.disposition.candidate,
        JSON.parse(completion?.request?.exactIntent?.bytes ?? 'null')
      ) &&
      g.goal.disposition.pendingRequestId === completion?.request?.requestId &&
      g.goal.disposition.actorId === p.goal.decidingActorId &&
      valid.some((a) =>
        g.goal.disposition.candidate.evidence.some(
          (e) => e.kind === 'artifact' && e.id === id(a) && e.digest === a.contentDigest
        )
      )
  );
  return c.finish(
    g?.goal?.disposition?.kind ??
      (o.turns.every((t) => terminal.has(t.status)) ? 'observed-open' : 'unavailable')
  );
}
function externalRow(r, p, bundle) {
  const c = checker('External', r?.refs ?? ['round.json']),
    receipt = r?.receipt,
    transcript = r?.transcript;
  c.test(
    'one fresh isolated client with pinned preflight bridge',
    receipt && r?.preflight,
    receipt?.exitCode === 0 &&
      receipt?.outsideSourceCheckout === true &&
      receipt?.workingDirectoryRemoved === true &&
      receipt?.checklistExpectedAnswerSshToolsAndPreflightOutputSupplied === false &&
      receipt?.carrierSha256 === r?.preflight?.carrierSha256 &&
      r?.preflight?.passed === true &&
      Boolean(receipt?.clientVersion)
  );
  const calls = [];
  for (const row of transcript ?? []) {
    if (row.method === 'tools/call' && row.request?.params?.name === 'call') {
      try {
        const texts = row.response?.result?.content?.filter((v) => v.type === 'text');
        calls.push({
          operation: row.request.params.arguments.operation,
          input: row.request.params.arguments.input,
          result: JSON.parse(texts[0].text),
        });
      } catch {
        calls.push({ unparseable: true });
      }
    }
  }
  c.test(
    'actual remote MCP exchanges and catalog',
    transcript,
    transcript?.some((v) => v.method === 'initialize' && v.httpStatus === 200) &&
      transcript?.some((v) => v.method === 'tools/list' && v.httpStatus === 200) &&
      calls.length > 0 &&
      calls.every((v) => !v.unparseable)
  );
  const fresh = r?.independent,
    latest = fresh?.latestTurnId,
    tid = data(fresh?.thread)?.id;
  const o = { items: data(fresh?.items)?.items ?? [], turns: fresh?.turnReads?.map(data) ?? [] };
  c.test(
    'complete deciding Turn and Item read',
    complete(data(fresh?.items)) &&
      fresh?.turnReads &&
      fresh?.thread &&
      o.turns.length === 1 &&
      o.turns.every(Boolean),
    complete(data(fresh?.items)) &&
      o.turns.length === 1 &&
      o.turns[0]?.id === latest &&
      o.turns[0]?.threadId === tid &&
      o.turns[0]?.workspaceId === p.workspaceId
  );
  c.test(
    'latest completed Turn independently selected',
    fresh?.dashboard,
    data(fresh?.dashboard)
      ?.turns?.filter((t) => t.status === 'completed')
      .at(-1)?.id === latest
  );
  const actorBoard = calls.find(
    (v) => v.operation === 'thread.dashboard' && v.result?.thread?.id === fresh?.thread?.data?.id
  )?.result;
  c.test(
    'Actor consulted the exact independently read latest record',
    fresh && transcript,
    actorBoard?.turns?.at(-1)?.id === latest &&
      o.turns.some((v) => v.id === latest && v.status === 'completed')
  );
  let answer = '';
  try {
    const events = receipt.stdout
      .split('\n')
      .filter(Boolean)
      .map((v) => JSON.parse(v));
    answer = events.filter((v) => v.item?.type === 'agent_message').at(-1)?.item?.text ?? '';
  } catch {
    /* Invalid client output is missing answer evidence. */
  }
  const reply = assistant(o.items.filter((v) => v.turnId === latest)).at(-1)?.text,
    j = r?.judgment;
  c.test(
    'independent deciding fact and answer grounding',
    j && reply && answer,
    j?.checker &&
      j?.recordId === latest &&
      j?.publicReplyDigest === digest(reply) &&
      j?.answerDigest === digest(answer) &&
      j?.servedCandidate === p.candidateCommit &&
      j?.servedImage === bundle.deployment?.build?.imageId &&
      j?.grounded === true
  );
  return c.finish(
    receipt?.timedOut ? 'timeout' : receipt?.exitCode === 0 ? 'completed' : 'client-failed'
  );
}

/** Every fixed scenario traverses its predicates; attribution failures cannot become passes. */
export function evaluate(bundle, p) {
  const global = [];
  const a = bundle.attribution;
  if (
    !a ||
    a.candidateCommit !== p.candidateCommit ||
    a.checklistBlob !== p.checklistBlob ||
    a.configurationDigest !== p.deployment.configurationDigest ||
    !a.archiveSha256 ||
    !a.runnerSha256 ||
    !a.parameterSha256
  )
    global.push('candidate/checklist/configuration/instrument attribution');
  if (
    !Number.isFinite(Date.parse(a?.start)) ||
    !Number.isFinite(Date.parse(a?.end)) ||
    Date.parse(a.start) > Date.parse(a.end)
  )
    global.push('closed attribution window');
  if (bundle.cleanup?.observed !== true) global.push('unobserved cleanup');
  if (
    !bundle.telemetry ||
    !['client', 'proxy', 'app', 'external', 'health'].every((k) =>
      Object.hasOwn(bundle.telemetry, k)
    )
  )
    global.push('missing diagnostic coverage declaration');
  for (const channel of Object.values(bundle.telemetry ?? {}))
    for (const span of channel?.spans ?? [])
      if (
        !Number.isFinite(Date.parse(span.startedAt)) ||
        !Number.isFinite(Date.parse(span.observedAt ?? span.startedAt)) ||
        Date.parse(span.startedAt) < Date.parse(a?.start) ||
        Date.parse(span.observedAt ?? span.startedAt) > Date.parse(a?.end)
      )
        global.push('telemetry outside attribution window');
  let rows = [
    deploymentRow(bundle, p),
    ...RUNTIMES.flatMap((r) =>
      runtimeRows(
        bundle.runtimes?.[r],
        bundle.issues?.[r],
        p,
        r,
        bundle.runtimes?.[r]?.refs ?? [`round.json#runtimes.${r}`],
        data(bundle.deployment?.public?.binding)?.items
      )
    ),
    chatRow(bundle.chat, p),
    taskRow(bundle.task, p),
    goalRow(bundle.goal, p),
    externalRow(bundle.external, p, bundle),
  ];
  if (global.length)
    rows = rows.map((r) => ({
      ...r,
      mechanicalCode: 'I',
      failures: [...r.failures, ...global.map((predicate) => ({ predicate, kind: 'missing' }))],
    }));
  return { rows, global };
}

/** Keep non-pass causation with an independent checker; reject manufactured pass adjudications. */
export function classify(result, p, adjudications = []) {
  const seen = new Set();
  for (const a of adjudications) {
    if (
      !a ||
      Object.keys(a).some((k) => !['scenario', 'code', 'reference', 'checker'].includes(k)) ||
      !['K', 'E', 'N', 'T', 'I'].includes(a.code) ||
      !a.reference ||
      !a.checker ||
      seen.has(a.scenario)
    )
      throw Error('Invalid or duplicate independent adjudication');
    seen.add(a.scenario);
    const row = result.rows.find((r) => r.scenario === a.scenario);
    if (!row || row.mechanicalCode === 'P')
      throw Error('Adjudication for a P or unknown row refused');
    if (row.mechanicalCode === 'I' && a.code !== 'I')
      throw Error('Missing evidence cannot be classified as an observed failure');
    if (a.code === 'K' && !p.knownReferences.includes(a.reference))
      throw Error('Known defect does not predate this round');
  }
  const rows = result.rows.map((r) => ({
    ...r,
    code:
      r.mechanicalCode === 'P'
        ? 'P'
        : (adjudications.find((a) => a.scenario === r.scenario)?.code ?? null),
    adjudication: adjudications.find((a) => a.scenario === r.scenario) ?? null,
  }));
  const classified = rows.every((r) => r.code),
    counts = {
      executed: rows.filter((r) => r.actualStatus !== 'unavailable').length,
      incomplete: rows.filter((r) => r.code === 'I' || r.code === 'T' || r.code === null).length,
      successful: rows.filter((r) => r.code === 'P').length,
      new: rows.filter((r) => r.code === 'N').length,
      known: rows.filter((r) => r.code === 'K').length,
      external: rows.filter((r) => r.code === 'E').length,
      environment: rows.filter((r) => r.code === 'T').length,
    };
  const completeRound =
      classified && counts.executed === SCENARIOS.length && counts.incomplete === 0,
    clean = completeRound && counts.new === 0 && counts.environment === 0;
  return {
    classified,
    rows,
    counts,
    complete: completeRound,
    clean,
    consecutive: clean ? (p.sequence.resetReason ? 0 : p.sequence.priorCount) + 1 : 0,
    reset: p.sequence.resetReason ?? (clean ? null : 'unclassified or non-clean round'),
  };
}

/** Read the two retained operator layouts without trusting their old judge projections. */
export async function legacy(dir, prefix, p) {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw Error('Invalid legacy prefix');
  const root = path.join(dir, 'logs'),
    refs = [];
  const read = async (suffix) => {
    const f = `${prefix}-${suffix}.json`;
    try {
      const v = await readJson(path.join(root, f));
      refs.push(`logs/${f}`);
      return v;
    } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  };
  const build = await read('build'),
    replace = await read('replace'),
    pub = await read('deployment-public'),
    generation = await read('generation-before'),
    components = await read('component-attribution');
  const attribution = await readJson(path.join(dir, 'legacy-attribution.json'));
  const bundle = {
    attribution,
    cleanup: await readJson(path.join(dir, 'legacy-cleanup.json')),
    deployment: {
      build,
      replace,
      public: pub,
      startup: await read('startup-client'),
      rendered: (await read('web-rendered-observation')) ?? (await read('web-rendered')),
      baselineGeneration:
        generation?.connectionGeneration ?? generation?.data?.connectionGeneration,
      configurationDigest: p.deployment.configurationDigest,
      components: components ?? attribution.components,
    },
    runtimes: {},
    issues: {},
  };
  for (const r of RUNTIMES) {
    bundle.runtimes[r] = await read(`${r}-scenarios`);
    if (bundle.runtimes[r]) bundle.runtimes[r].refs = [`logs/${prefix}-${r}-scenarios.json`];
    const names = (await fs.readdir(root)).filter(
      (f) =>
        f.startsWith(`${prefix}-${r}-issue`) &&
        f.endsWith('.json') &&
        !f.includes('-command') &&
        !f.includes('-transport')
    );
    if (names.length === 1) {
      bundle.issues[r] = await readJson(path.join(root, names[0]));
      refs.push(`logs/${names[0]}`);
    }
  }
  bundle.chat = await read('chat-receipt');
  if (bundle.chat) bundle.chat.refs = [`logs/${prefix}-chat-receipt.json`];
  bundle.task = await read('task-receipt');
  if (bundle.task) {
    bundle.task.refs = [
      `logs/${prefix}-task-receipt.json`,
      `logs/${prefix}-task-github-proof.json`,
    ];
    bundle.task.replay = await read('task-owner-replay');
    bundle.task.github = await read('task-github-proof');
    // The historical collector retained parsed deciding projections rather than raw HTTP bodies.
    // Bind those original fields to their retained routes; never reconstruct missing observations.
    if (bundle.task.github) {
      const projections = taskReadProjections(bundle.task.github, p);
      bundle.task.github.reads = bundle.task.github.reads?.map((receipt) => {
        const projection = projections.find((v) => v.route === receipt.route);
        return projection
          ? { ...receipt, body: projection.body, bodyDigest: digest(canonical(projection.body)) }
          : receipt;
      });
    }
    bundle.task.decisions = [];
    for (const f of (await fs.readdir(root)).filter(
      (v) => v.startsWith(`${prefix}-task-decision-`) && v.endsWith('.json')
    )) {
      bundle.task.decisions.push(await readJson(path.join(root, f)));
      refs.push(`logs/${f}`);
    }
  }
  bundle.goal = await read('goal-receipt');
  if (bundle.goal) {
    bundle.goal.refs = [`logs/${prefix}-goal-receipt.json`];
    bundle.goal.planDecision = await read('goal-plan-decision');
  }
  bundle.external = {
    refs: [
      `logs/${prefix}-external-receipt.json`,
      `logs/${prefix}-external-mcp-transcript.json`,
      `logs/${prefix}-external-independent-task.json`,
    ],
    receipt: await read('external-receipt'),
    transcript: await read('external-mcp-transcript'),
    preflight: await read('preflight-receipt'),
    independent: await read('external-independent-task'),
    judgment: await readJson(path.join(dir, 'legacy-external-judgment.json')),
  };
  const start = Date.parse(attribution.start),
    end = Date.parse(attribution.end),
    spans = [],
    outside = [];
  for (const f of (await fs.readdir(root)).filter(
    (v) => v.startsWith(`${prefix}-`) && v.endsWith('-transport.json')
  )) {
    const v = await readJson(path.join(root, f));
    refs.push(`logs/${f}`);
    for (const span of v.http ?? [])
      (Date.parse(span.startedAt) >= start && Date.parse(span.observedAt) <= end
        ? spans
        : outside
      ).push(span);
  }
  const startup =
    bundle.deployment.startup?.rows?.map((v) => ({
      startedAt: v.health.at,
      status: v.health.httpStatus,
      connectionReset: v.health.connectionReset ?? false,
    })) ?? [];
  const mcp = (bundle.external.transcript ?? []).map((v) => ({
    startedAt: v.startedAt,
    observedAt: v.observedAt,
    status: v.httpStatus,
    connectionReset: v.connectionReset ?? false,
  }));
  bundle.telemetry = {
    client: telemetry(spans, 'sampled requests'),
    health: telemetry(startup, 'sampled requests; completion times unavailable'),
    external: telemetry(mcp, 'actual MCP messages'),
    proxy: {
      coverage: 'unavailable',
      reason: 'historical filtered diagnostic interval extends beyond scenario window',
    },
    app: {
      coverage: 'unavailable',
      reason: 'historical filtered diagnostic samples are not complete coverage',
    },
  };
  bundle.telemetry.client.excludedOutsideWindow = outside.length;
  bundle.deployment.refs = refs;
  return { bundle, refs };
}
/** Keep unavailable coverage distinct from covered zero while retaining observed samples. */
export function telemetry(spans, coverage) {
  const observed = {
    http502: spans.filter((v) => v.status === 502).length,
    connectionReset: spans.filter((v) => v.connectionReset).length,
    requests: spans.length,
  };
  return {
    coverage,
    ...(coverage === 'unavailable'
      ? { http502: null, connectionReset: null, requests: null, observed }
      : observed),
    spans,
  };
}

/** Produce a neutral public row backed by a content-addressed private evidence manifest. */
export async function summarize(dir, { legacyPrefix, adjudicationsFile } = {}) {
  if (legacyPrefix && !/^[a-z0-9][a-z0-9-]*$/.test(legacyPrefix))
    throw Error('Invalid legacy evidence prefix');
  const p = validateParams(await readJson(path.join(dir, 'params.json')));
  let bundle, refs;
  if (legacyPrefix) ({ bundle, refs } = await legacy(dir, legacyPrefix, p));
  else {
    bundle = await readJson(path.join(dir, 'round.json'));
    refs = (await files(dir)).filter(
      (f) => !['summary.json', 'row.md', 'manifest.json'].includes(f)
    );
    const prep = await readJson(path.join(dir, 'prepare.json'));
    if (prep.parameterSha256 !== sha(await fs.readFile(path.join(dir, 'params.json'))))
      throw Error('Pinned parameters changed');
    if (
      prep.runnerSha256 !== bundle.attribution?.runnerSha256 ||
      prep.parameterSha256 !== bundle.attribution?.parameterSha256 ||
      prep.checklistBlob !== p.checklistBlob ||
      !Array.isArray(prep.instrumentFiles) ||
      sha(canonical(prep.instrumentFiles)) !== prep.runnerSha256
    )
      throw Error('Conflicting pinned instrument attribution');
    if (
      sha((await readJson(path.join(dir, 'checklist-section.json'))).text) !==
      prep.checklistSectionSha256
    )
      throw Error('Frozen checklist section digest mismatch');
  }
  if (!legacyPrefix && bundle.external) {
    try {
      bundle.external.judgment = await readJson(path.join(dir, 'external-judgment.json'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const evaluation = evaluate(bundle, p),
    adjudications = adjudicationsFile ? await readJson(adjudicationsFile) : [];
  if (!Array.isArray(adjudications)) throw Error('Adjudications must be an array');
  const summary = classify(evaluation, p, adjudications);
  if (legacyPrefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (['logs', 'summary.json', 'row.md', 'manifest.json'].includes(entry.name)) continue;
      if (entry.isFile()) refs.push(entry.name);
      else if (entry.isDirectory())
        for (const child of await files(path.join(dir, entry.name)))
          refs.push(`${entry.name}/${child}`);
      else throw Error('Unexpected legacy bundle symlink refused');
    }
    for (const entry of await fs.readdir(path.join(dir, 'logs'), { withFileTypes: true })) {
      if (!entry.name.startsWith(`${legacyPrefix}-`)) continue;
      if (entry.isFile()) refs.push(`logs/${entry.name}`);
      else if (entry.isDirectory())
        for (const child of await files(path.join(dir, 'logs', entry.name)))
          refs.push(`logs/${entry.name}/${child}`);
      else throw Error('Non-regular legacy evidence refused');
    }
  }
  const entries = [];
  for (const f of [
    ...new Set([
      ...refs,
      ...(legacyPrefix
        ? [
            'params.json',
            'legacy-attribution.json',
            'legacy-cleanup.json',
            'legacy-external-judgment.json',
          ]
        : []),
    ]),
  ].sort())
    entries.push({ file: f, sha256: sha(await fs.readFile(path.join(dir, f))) });
  if (adjudicationsFile) {
    const previous = entries.findIndex((v) => v.file === 'adjudications.json');
    if (previous >= 0) entries.splice(previous, 1);
    const copy = await fs.readFile(adjudicationsFile);
    await fs.writeFile(path.join(dir, 'adjudications.json'), copy, { mode: 0o600 });
    if (!entries.some((v) => v.file === 'adjudications.json'))
      entries.push({ file: 'adjudications.json', sha256: sha(copy) });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  const manifestSha256 = sha(canonical(entries));
  await save(path.join(dir, 'manifest.json'), { entries, sha256: manifestSha256 }, [], false);
  const failures = new Map();
  for (const runtime of RUNTIMES)
    for (const step of bundle.runtimes?.[runtime]?.steps ?? []) {
      if (step.turn?.status === 'failed')
        failures.set(step.turn.id, {
          runtime,
          turnId: step.turn.id,
          cause: step.turn.error ?? 'unavailable',
        });
    }
  for (const [scenario, record] of [
    ['Task', bundle.task?.last],
    ['Goal', bundle.goal?.linkedTask],
  ])
    for (const turn of record?.turnReads ?? []) {
      if (turn.data?.status === 'failed')
        failures.set(turn.data.id, {
          runtime: scenario,
          turnId: turn.data.id,
          cause: turn.data.error ?? 'unavailable',
        });
    }
  const result = {
    ...summary,
    workerFailures: [...failures.values()],
    attribution: bundle.attribution,
    telemetry: bundle.telemetry,
    cleanup: bundle.cleanup,
    instrument: evaluation.global,
    manifestSha256,
    evidenceAlias: p.evidenceAlias,
  };
  await save(path.join(dir, 'summary.json'), result, [], false);
  const counts = summary.counts,
    dispositions = summary.rows
      .filter((r) => r.adjudication)
      .map((r) => `${r.scenario}=${r.code}:check-${SCENARIOS.indexOf(r.scenario) + 1}`);
  const cell = (v) => String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const identity = (v) => (/^sha256:[a-f0-9]{64}$/.test(v ?? '') ? v : 'unavailable');
  const utc = (v) => (Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : 'unavailable');
  const columns = [
    p.roundId,
    `${p.candidateCommit}; set=${p.checklistBlob}; revision=sha256:${sha(p.scenarioRevision)}`,
    `App=${identity(bundle.deployment?.build?.imageId)}; Web=${identity(bundle.deployment?.build?.web?.directoryDigest)}; NanoHost=${identity(p.deployment.nanoHostDigest)}; Worker=${identity(bundle.deployment?.components?.worker?.digest ?? p.deployment.workerDigest)}; config=${identity(p.deployment.configurationDigest)}; receipt=${p.evidenceAlias}; UTC=${utc(bundle.attribution?.start)}/${utc(bundle.attribution?.end)}`,
    summary.rows.map((r) => `${r.scenario}=${r.code ?? 'unclassified'}`).join('; '),
    `executed=${counts.executed}/21; incomplete=${counts.incomplete}; successful=${counts.successful}; new=${counts.new}; known=${counts.known}; external=${counts.external}; complete=${summary.complete ? 'yes' : 'no'}; clean=${summary.clean ? 'yes' : 'no'}; consecutive=${summary.consecutive}; reset=${p.sequence.resetReason ? 'declared; details=summary' : (summary.reset ?? 'none')}`,
    dispositions.join('; ') || 'none',
    `${p.evidenceAlias}; manifest=sha256:${manifestSha256}; instrument=${bundle.attribution?.runnerSha256}; non-pass checks=${summary.classified ? 'complete' : 'pending'}; telemetry/cleanup=summary`,
  ];
  await fs.writeFile(
    path.join(dir, 'row.md'),
    `| Round | Tested candidate / frozen set | Deployment identity / window | Per-scenario outcomes | Counts / sequence | New defects / other dispositions | Retained evidence / non-pass checks |\n| --- | --- | --- | --- | --- | --- | --- |\n| ${columns.map(cell).join(' | ')} |\n`,
    { mode: 0o600 }
  );
  return result;
}
