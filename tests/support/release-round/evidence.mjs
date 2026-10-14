/** Offline comparisons of complete deciding public records; no transport or host access. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  canonical,
  digest,
  files,
  RUNTIMES,
  readJson,
  replySentence,
  SCENARIOS,
  save,
  sha,
  validateParams,
} from './safety.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const data = (v) => (v?.ok === true ? v.data : undefined);
const artifact = (v) => data(v)?.artifact ?? data(v);
const assistant = (items) =>
  (items ?? []).filter((i) => i.type === 'assistant-message' && i.status === 'completed');
const id = (v) => v?.id ?? v?.artifactId;
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
      c.test(
        'exact attempt-specific synthetic sentence reply',
        coverage,
        replies.length === 1 && replies[0] === replySentence(p, runtime)
      );
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

/** Every fixed scenario traverses its predicates; attribution failures cannot become passes. */
export function evaluate(bundle, p) {
  const global = [];
  if (!p.releaseTag) global.push('published prerelease identity unavailable');
  const a = bundle.attribution;
  if (
    !a ||
    a.candidateCommit !== p.candidateCommit ||
    a.checklistBlob !== p.checklistBlob ||
    a.configurationDigest !== p.deployment.configurationDigest ||
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
  let rows = RUNTIMES.flatMap((r) =>
    runtimeRows(
      bundle.runtimes?.[r],
      bundle.issues?.[r],
      p,
      r,
      bundle.runtimes?.[r]?.refs ?? [`round.json#runtimes.${r}`],
      data(bundle.binding)?.items
    )
  );
  if (global.length)
    rows = rows.map((r) => ({
      ...r,
      mechanicalCode: 'I',
      failures: [...r.failures, ...global.map((predicate) => ({ predicate, kind: 'missing' }))],
    }));
  return { rows, global };
}

/** Keep independent non-pass causation for each qualification row. */
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
  };
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

/** Derive qualification rows offline and retain the checker inputs. */
export async function summarize(dir, { adjudicationsFile } = {}) {
  const p = validateParams(await readJson(path.join(dir, 'params.json'))),
    bundle = await readJson(path.join(dir, 'round.json')),
    refs = (await files(dir)).filter(
      (f) => !['summary.json', 'row.md', 'cases.md', 'manifest.json'].includes(f)
    ),
    prep = await readJson(path.join(dir, 'prepare.json'));
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
  const evaluation = evaluate(bundle, p),
    adjudications = adjudicationsFile ? await readJson(adjudicationsFile) : [];
  if (!Array.isArray(adjudications)) throw Error('Adjudications must be an array');
  const summary = classify(evaluation, p, adjudications);
  const entries = [];
  for (const f of [...new Set(refs)].sort())
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
    `App=${identity(p.deployment.appImage)}; Web=${identity(p.deployment.webIdentity)}; NanoHost=${identity(p.deployment.nanoHostDigest)}; Worker=${identity(bundle.components?.worker?.digest ?? p.deployment.workerDigest)}; config=${identity(p.deployment.configurationDigest)}; receipt=${p.evidenceAlias}; UTC=${utc(bundle.attribution?.start)}/${utc(bundle.attribution?.end)}`,
    summary.rows.map((r) => `${r.scenario}=${r.code ?? 'unclassified'}`).join('; '),
    `executed=${counts.executed}/${SCENARIOS.length}; incomplete=${counts.incomplete}; successful=${counts.successful}; new=${counts.new}; known=${counts.known}; external=${counts.external}; complete=${summary.complete ? 'yes' : 'no'}; clean=${summary.clean ? 'yes' : 'no'}`,
    dispositions.join('; ') || 'none',
    `${p.evidenceAlias}; manifest=sha256:${manifestSha256}; instrument=${bundle.attribution?.runnerSha256}; non-pass checks=${summary.classified ? 'complete' : 'pending'}; telemetry/cleanup=summary`,
  ];
  result.publicRows = summary.rows.map((r) => {
    const [runtime, letter] = r.scenario.split('.');
    const step = bundle.runtimes?.[runtime]?.steps?.find((s) => s.scenario === letter);
    return {
      subject: r.scenario,
      publishedIdentity: p.releaseTag ?? 'unavailable',
      sourceCommit: p.candidateCommit,
      identities: {
        app: identity(p.deployment.appImage),
        web: identity(p.deployment.webIdentity),
        nanoHost: identity(p.deployment.nanoHostDigest),
        worker: identity(bundle.components?.worker?.digest ?? p.deployment.workerDigest),
        configuration: identity(p.deployment.configurationDigest),
      },
      start: utc(step?.windowStart ?? step?.turn?.startedAt ?? bundle.attribution?.start),
      end: utc(step?.windowEnd ?? step?.turn?.completedAt ?? bundle.attribution?.end),
      verdict: r.code ?? 'unclassified',
      classification:
        {
          P: 'pass',
          K: 'known defect',
          E: 'accepted external',
          N: 'new defect',
          T: 'environment or tool failure',
          I: 'inconclusive',
        }[r.code] ?? 'undecidable',
      evidenceAlias: p.evidenceAlias,
      evidenceDigest: `sha256:${manifestSha256}`,
      independentCheck:
        r.mechanicalCode === 'P' ? 'not required' : r.adjudication ? 'complete' : 'pending',
    };
  });
  await save(path.join(dir, 'summary.json'), result, [], false);
  await fs.writeFile(
    path.join(dir, 'cases.md'),
    `| Case | Published identity / source | Deployment identities | UTC window | Verdict / classification | Evidence | Independent check |\n| --- | --- | --- | --- | --- | --- | --- |\n${result.publicRows
      .map(
        (r) =>
          `| ${[
            r.subject,
            `${r.publishedIdentity}; ${r.sourceCommit}`,
            Object.entries(r.identities)
              .map(([k, v]) => `${k}=${v}`)
              .join('; '),
            `${r.start}/${r.end}`,
            `${r.verdict}; ${r.classification}`,
            `${r.evidenceAlias}; ${r.evidenceDigest}`,
            r.independentCheck,
          ]
            .map(cell)
            .join(' | ')} |`
      )
      .join('\n')}\n`,
    { mode: 0o600 }
  );
  await fs.writeFile(
    path.join(dir, 'row.md'),
    `| Round | Tested candidate / frozen set | Deployment identity / window | Per-scenario outcomes | Counts | New defects / other dispositions | Retained evidence / non-pass checks |\n| --- | --- | --- | --- | --- | --- | --- |\n| ${columns.map(cell).join(' | ')} |\n`,
    { mode: 0o600 }
  );
  return result;
}
