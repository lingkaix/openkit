import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Reads one repository file used by this executable projection.
 *
 * @param {string} path Repository-relative path.
 * @returns {string} File contents.
 */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const contract = read('docs/change-execution.md');
const documentationModel = read('docs/documentation-model.md');
const verifierRole = read('.codex/agents/verifier.toml');
const roleRegistry = read('.codex/config.toml');
const changesReadme = read('docs/changes/README.md');
const changesGuide = read('docs/changes/AGENTS.md');
const OUTCOMES = ['Continue', 'Reframe', 'Ask Human', 'Close'];

/**
 * Finds one paragraph that carries every marker for a single contract rule.
 *
 * @param {string} text Document text.
 * @param {(string|RegExp)[]} markers Required markers.
 * @returns {string} Matching paragraph.
 */
function paragraphWith(text, markers) {
  return (
    text
      .split(/\n\s*\n/u)
      .find((paragraph) =>
        markers.every((marker) =>
          typeof marker === 'string' ? paragraph.includes(marker) : marker.test(paragraph)
        )
      ) ?? ''
  );
}

test('defines exactly four material-turn outcomes', () => {
  const outcomeParagraph = paragraphWith(
    contract,
    OUTCOMES.map((outcome) => `\`${outcome}\``)
  );

  assert.notEqual(outcomeParagraph, '', 'missing the closed material-turn outcome vocabulary');
  assert.match(outcomeParagraph, /(?:exactly|only) four/iu);
  assert.deepEqual(
    [...outcomeParagraph.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]),
    OUTCOMES
  );
});

test('predeclares what a material Next Action must change and observe', () => {
  const nextAction = paragraphWith(contract, [
    /material/iu,
    /Next Action/u,
    /before/iu,
    /Artifact/u,
    /Belief/u,
    /Decision/u,
    /Observable/u,
    /Evidence/u,
  ]);

  assert.notEqual(nextAction, '', 'missing the material Next Action predeclaration');
  assert.ok(
    /Evidence[^.\n]*(?:change|reframe|alter)[^.\n]*(?:route|decision)/iu.test(nextAction),
    'Next Action must name evidence that would change the route'
  );
});

test('requires fresh-context direction review at its three drift triggers', () => {
  const reorientation = paragraphWith(contract, [
    /fresh context/iu,
    /compaction/iu,
    /resume/iu,
    /direction/iu,
  ]);

  assert.notEqual(reorientation, '', 'missing fresh-context direction review');
  for (const outcome of OUTCOMES) assert.ok(reorientation.includes(`\`${outcome}\``));

  // One pilot compacted 107 times against 28 total subagent spawns and left no
  // record either way. Keying the check to compaction measured token volume;
  // keying it to commitment measures where a wrong belief is actually spent.
  // Each member of the commitment set is load-bearing: an independent review
  // found that dropping `Close` and commit leaves post-compaction drift that
  // produces only reversible edits entirely uncaught.
  assert.match(reorientation, /MUST perform the direction check/u);
  for (const trigger of [
    /before a durable commitment/iu,
    /compacted since its own last check/iu,
    /after a Reframe/u,
    /long pause and resume or a change of primary-agent identity/iu,
  ]) {
    assert.match(reorientation, trigger);
  }
  for (const commitment of [
    /a commit/u,
    /a `Close`/u,
    /a cross-owner delegation/u,
    /irreversible, externally effectful, or real-environment action/u,
  ]) {
    assert.match(reorientation, commitment);
  }

  // Without the lineage sentence, "compacted since its own last check" has no
  // reading once work is delegated: a subagent's compaction would silently
  // satisfy or silently violate the primary context's obligation.
  assert.ok(
    /Coverage is per plan and per primary-context identity/u.test(reorientation),
    'the obligation must name whose compaction and whose check it counts'
  );
  assert.ok(
    /delegated context's own compaction is not the primary's/u.test(reorientation),
    'a delegated compaction must not be conflated with the primary context'
  );
  // The fresh context performs the check but the compacted primary owns the
  // obligation. An earlier draft cleared the performer, which left the primary
  // permanently obligated and made the rule undischargeable.
  assert.ok(
    /clears the obligation of the primary context whose Intent, checkpoint, and evidence it read, not of the fresh context that performed it/u.test(
      reorientation
    ),
    'the check must clear the primary rather than its performer'
  );
  // The mid-slice line needs a sink. Requiring it of a plan that owes no route
  // log would demand a record with nowhere to go.
  assert.ok(
    /where the plan keeps a route log, ordinary mid-slice compaction requires only one recorded line/u.test(
      reorientation
    ),
    'the mid-slice line must be scoped to plans that have a sink for it'
  );
  assert.ok(
    /compaction[^.\n]*not a trigger on its own/iu.test(reorientation),
    'compaction alone must not be stated as a trigger'
  );
  assert.ok(
    /ordinary mid-slice compaction requires only one recorded line/iu.test(reorientation),
    'skipped mid-slice checks must stay visible as a recorded line'
  );

  assert.ok(
    /fresh context[^.\n]*(?:compaction|resume)/iu.test(verifierRole),
    'verifier must own the fresh-context compaction/resume seam'
  );
  // The role projection dropped `externally effectful` once already, so the
  // operational instruction is pinned to the owner's complete commitment set.
  assert.ok(
    /durable commitment is a commit, a Close, a cross-owner delegation, or an irreversible, externally effectful, or real-environment action/u.test(
      verifierRole
    ),
    'the role must carry the owner-complete durable-commitment set'
  );
  assert.ok(
    /mid-slice compaction does not dispatch this role/iu.test(verifierRole),
    'verifier must not be dispatched on ordinary mid-slice compaction'
  );
  for (const outcome of OUTCOMES) assert.ok(verifierRole.includes(outcome));
});

test('mirrors uncommitted plan material onto its committed bundle name', () => {
  const mirror = paragraphWith(contract, [/`temp\/changes\/`/u, /mirrors/iu]);

  assert.notEqual(mirror, '', 'missing the temp/changes mirror rule');
  // Derivable from the plan id, which is what a post-compaction fresh context
  // has. Before this, one plan's material sat under four commit-hash-named
  // directories plus fifty loose scripts at the temp/ root.
  assert.ok(
    /one directory per plan under the same name as that plan's `docs\/changes\/` bundle/u.test(
      mirror
    ),
    'the uncommitted directory must carry the committed bundle name'
  );
  // The mirror is a default home, not an enclosure: an agent still needs room
  // to put working material where the work actually needs it.
  assert.ok(
    /may still reference and use other `temp\/` paths where the work needs them/u.test(mirror),
    'the mirror must not forbid other temp paths'
  );
});

test('gives retained pilot material one shape without rebuilding an event log', () => {
  const routeLog = paragraphWith(contract, [/route-log\.md/u, /entry kinds/iu]);

  assert.notEqual(routeLog, '', 'missing the route-log shape');
  // Committed beside plan.md and findings.md, because its purpose is
  // task-external review: curated decision evidence left only in prunable
  // uncommitted space would not survive to be reviewed.
  assert.match(routeLog, /`route-log\.md` carries its plan's route history/u);
  // The line shape is the whole formatting contract; without it the four entry
  // kinds could be satisfied by any structure at all.
  assert.match(routeLog, /one plain line per entry/u);
  // Admission is repository-wide but only the pilots owe one, so a non-pilot
  // route log has defined semantics instead of none.
  assert.match(
    routeLog,
    /The three approved pilot plans keep one; any other plan may, and none is required to\./u
  );
  assert.match(documentationModel, /optional `route-log\.md`/u);
  assert.match(contract, /optional `findings\.md` and `route-log\.md`/u);
  // Scope is the three pilots. A projection that universalized this obligation
  // would add a durable record no repeated evidence has yet asked for.
  // Three committed bundle members, three distinct standings. Collapsing any
  // pair would give execution evidence the standing of design or of a finding.
  assert.ok(
    /non-authorizing execution evidence/u.test(routeLog),
    'the route log must carry no authorizing standing'
  );
  assert.ok(
    /`findings\.md` keeps this plan's findings and their dispositions/u.test(routeLog),
    'the route log must stay distinct from findings'
  );

  // Written by an agent at a decision point, not by machinery: the predecessor
  // state.json reached revision 397 because a mechanism logged every process
  // event.
  assert.ok(
    /appended by an agent at a decision point and never by machinery/iu.test(routeLog),
    'the route log must not be machine-written'
  );
  // The exemption covers the Continue outcome only. An earlier draft exempted
  // the whole turn, which discarded the defeating evidence behind every commit.
  assert.ok(
    /A commit already records the `Continue` outcome and the artifact, so neither is repeated here/u.test(
      routeLog
    ),
    'the commit exemption must be limited to the Continue outcome'
  );
  assert.ok(
    /committing turn's defeated premise, refuted hypothesis, or direction verdict is still an entry/u.test(
      routeLog
    ),
    'a committing turn must still log its causal evidence'
  );
  for (const kind of [
    /a `Reframe` with the evidence that defeated the premise/u,
    /failed attempt or refuted hypothesis with the missing fact it named/iu,
    /direction check, written by the fresh context that performed it/iu,
    // Without this kind the mandatory mid-slice line has no permitted sink,
    // since plan.md gains no working log and the log admits nothing else.
    /ordinary mid-slice compaction, the one line naming what was re-read/iu,
  ]) {
    assert.match(routeLog, kind);
  }

  // plan.md must stay intent and design. Losing either half of this sentence
  // turns the plan back into the working log the cutover removed.
  assert.ok(
    /`plan\.md` keeps Intent, key design, accepted decisions, and the rewritable checkpoint, and gains no working log/u.test(
      routeLog
    ),
    'the route log must not migrate into plan.md'
  );
  // The four entry kinds do state required content, so banning a "field
  // schema" outright contradicted them. The ban is on mechanized enforcement,
  // which is what turned the predecessor state.json into 397 revisions.
  assert.ok(
    /The entry kinds state what an entry carries, not a checked format: add no schema file, validator, test, revision counter, or automatic writer to it\./u.test(
      routeLog
    ),
    'the route log must ban enforcement machinery without banning its own content rules'
  );
  // Anything durable must reach its real owner rather than stay in a record
  // that carries no authority and may later be pruned.
  assert.ok(
    /primary agent promotes its surviving conclusions to their owners/u.test(routeLog),
    'closeout must name who promotes what survives'
  );
  // Appending is a single-writer path like any other, and the log's own
  // completeness is self-reported: claiming otherwise would make an
  // unverifiable record read as proof.
  assert.ok(
    /The primary agent owns the append/u.test(routeLog),
    'the append path must name one writer'
  );
  assert.ok(
    /completeness is self-reported and no check establishes it/u.test(routeLog),
    'the log must not read as proof of its own completeness'
  );
});

test('defines one findings lifecycle, item shape, and follow-up index', () => {
  const lifecycle = paragraphWith(contract, [
    /`findings\.md`/u,
    /exactly three/iu,
    /`open`/u,
    /`deferred`/u,
    /`closed`/u,
    /terminal/iu,
  ]);
  const fields = paragraphWith(contract, [
    /`Observation`/u,
    /`Impact`/u,
    /`Evidence`/u,
    /`Owner`/u,
    /`Next action`/u,
    /`Closing verdict`/u,
    /`Closure evidence`/u,
  ]);
  const index = paragraphWith(contract, [
    /`## Follow-up Index`/u,
    /unchecked/iu,
    /checked/iu,
    /non-authorizing/iu,
  ]);

  assert.notEqual(lifecycle, '', 'missing the closed findings status lifecycle');
  assert.match(lifecycle, /`open` → `closed`/u);
  assert.match(lifecycle, /`open` → `deferred`/u);
  assert.match(lifecycle, /`deferred` → `open`/u);
  assert.match(lifecycle, /`deferred` → `closed`/u);
  assert.match(lifecycle, /appends its transition history to `Next action`/u);
  assert.match(lifecycle, /deletes no substantive history/u);
  assert.notEqual(fields, '', 'missing the fixed findings field set');
  assert.match(fields, /Every item requires the first five fields/u);
  assert.match(fields, /closed items require both `Closing verdict` and `Closure evidence`/iu);
  assert.match(fields, /exact shape ``- \*\*<Label>:\*\* <text>``/u);
  assert.notEqual(index, '', 'missing the findings follow-up index contract');
  assert.match(index, /every `open` and `deferred` item/iu);
  assert.match(index, /``- \[ \] `<ID>` \[<status>\] <short title>``/u);
  assert.match(index, /``- \[x\] `<ID>` \[closed\] <short title>``/u);
  assert.match(index, /self-reported/iu);
  assert.match(documentationModel, /findings report/iu);
  assert.match(documentationModel, /follow-up index/iu);
  assert.match(changesReadme, /later closure checks that line/iu);
  assert.match(changesReadme, /retains the append-only `Next action` history/u);
  assert.match(changesGuide, /take exclusive ownership of that `findings\.md` path/u);
  assert.match(changesGuide, /retain its append-only `Next action` history/u);
  assert.match(changesGuide, /append its closing verdict and closure evidence in the same change/u);
});

test('keeps every route-log and trigger projection aligned with its owner', () => {
  // These four projections drifted from the owner once already: the role
  // dropped `externally effectful`, both docs/changes guides dropped the
  // alternate-temp-path allowance, and the local guide dropped the direction
  // entry's outcome and reason. Nothing read them, so nothing caught it.
  for (const [label, text] of [
    ['docs/changes/README.md', changesReadme],
    ['docs/changes/AGENTS.md', changesGuide],
  ]) {
    assert.ok(
      /other `temp\/` paths where the work needs them/u.test(text),
      `${label} dropped the owner's alternate-temp-path allowance`
    );
  }
  assert.ok(
    /route-log\.md/u.test(changesReadme) && /no other plan owes one/u.test(changesReadme),
    'the README must carry the pilot scope with the route log'
  );
  assert.ok(
    /direction check with its outcome and reason/u.test(changesGuide),
    'the local guide must keep the direction entry complete'
  );
  // The owner states one required disposition per entry kind; an entry that
  // records only that a check happened settles nothing.
  assert.match(contract, /with its outcome and reason/u);

  // The registry description is what a dispatcher reads first.
  for (const projection of [verifierRole, roleRegistry]) {
    assert.ok(
      /durable commitment/u.test(projection),
      'both role projections must name the commitment trigger'
    );
  }
  // Without the reset condition the role reads as owing a check before every
  // later commitment, which is the cadence this change exists to replace.
  assert.ok(
    /compacted since its own last check/u.test(verifierRole),
    'the role must carry the owner reset condition'
  );
  assert.ok(
    /clears the obligation of the primary context you read, not of your own/u.test(verifierRole),
    'the role must clear the primary rather than itself'
  );
});

test('appends Intent epochs and rewrites the working checkpoint', () => {
  const persistence = paragraphWith(contract, [
    /Intent Epoch/u,
    /append/iu,
    /checkpoint/iu,
    /rewrit/iu,
  ]);

  assert.notEqual(persistence, '', 'missing append-Intent/rewrite-checkpoint ownership');
  assert.ok(
    /(?:must not|never)[^.\n]*(?:modify|rewrite|delete)/iu.test(persistence),
    'a recorded Intent Epoch must not be modified or deleted'
  );
});
