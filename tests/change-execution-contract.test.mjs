import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const consultantRole = read('.codex/agents/consultant.toml');
const auditorRole = read('.codex/agents/auditor.toml');
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

test('keeps fresh direction scrutiny at consequential commitments rather than routine dispatch', () => {
  const recovery = paragraphWith(contract, ['fresh context MUST', 'primary-context identity']);
  assert.notEqual(recovery, '');
  for (const marker of [
    'compacted since its own last check',
    'direction-bearing commitment',
    'changing scope or accepted design',
    'substantial investment in a new route',
    'an irreversible or external effect',
    'closure whose delivered scheme materially differs',
    'An ordinary commit or cross-owner delegation within that direction is not sufficient by itself',
    'After a Reframe, a long pause and resume, or primary-agent replacement',
    'before renewed material investment',
    "a delegated context's own compaction is not the primary's",
    'clears the obligation of the primary context whose Intent, checkpoint, and evidence it read',
    'not of the fresh context that performed it',
    'Ordinary mid-slice compaction is not a dispatch trigger',
    'where the plan keeps a route log, record one line',
  ])
    assert.ok(recovery.includes(marker), `missing recovery boundary: ${marker}`);

  const checkpoint = paragraphWith(contract, ['A Consultant may name', 'MUST obtain']);
  assert.match(checkpoint, /before dependent work continues, even if it sees no drift itself/u);
  assert.match(checkpoint, /without a meaningful observable/u);
  assert.match(checkpoint, /cannot prove freshness or guarantee an undispatched intervention/u);
  for (const outcome of OUTCOMES) assert.ok(checkpoint.includes(`\`${outcome}\``));

  for (const marker of [
    'before renewed material investment',
    'Ordinary mid-slice compaction does not dispatch this role',
    'compacted since its own last check',
    'before dependent work continues even if it sees no drift',
    'Instruction checks cannot prove freshness or guarantee actual dispatch',
  ])
    assert.ok(consultantRole.includes(marker), `missing Consultant boundary: ${marker}`);
  for (const outcome of OUTCOMES) assert.ok(consultantRole.includes(outcome));
});

test('registers Consultant and preserves bounded Auditor judgment and human invitation', () => {
  assert.match(roleRegistry, /\[agents\.consultant\]/u);
  assert.match(roleRegistry, /config_file = "agents\/consultant\.toml"/u);
  assert.match(consultantRole, /^name = "consultant"/mu);
  assert.doesNotMatch(roleRegistry, /\[agents\.verifier\]/u);
  assert.equal(existsSync(new URL('../.codex/agents/verifier.toml', import.meta.url)), false);
  assert.match(consultantRole, /Do not duplicate Reviewer implementation acceptance/u);
  assert.match(
    consultantRole,
    /Co-designing a proposal does not qualify you as its independent final acceptor/u
  );
  assert.match(consultantRole, /missing authorization/u);
  assert.match(consultantRole, /no credible next route/u);
  assert.match(auditorRole, /Within discretion left by existing authority/u);
  assert.match(
    auditorRole,
    /Never waive a MUST, the Safety Kernel, an owner, or an engineer decision/u
  );
  assert.match(auditorRole, /do not each require a dated audit record/u);
  assert.match(contract, /Never prescribe a passing verdict, hide dissent/u);
  assert.match(contract, /Stop the previous writer before transferring the same paths/u);
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
  assert.match(contract, /optional `proposal\.md`, `findings\.md`, and `route-log\.md`/u);
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

  for (const projection of [consultantRole, roleRegistry]) {
    assert.match(projection, /direction-bearing commitment/u);
  }
  assert.match(consultantRole, /Coverage belongs to the primary-context identity and plan/u);
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
