import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Reads one repository document.
 *
 * @param {string} path Repository-relative path.
 * @returns {string} File contents.
 */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const CONTRACT_PATH = 'docs/verification-instruments.md';
const TAXONOMY_PATH = 'docs/specs/20260529-test_strategy.md';
const TOOLCHAIN_PATH = 'docs/toolchain.md';
const CONTRACT_CEILING = 4_600;

const contract = read(CONTRACT_PATH);
const taxonomy = read(TAXONOMY_PATH);
const toolchain = read(TOOLCHAIN_PATH);
const changeExecution = read('docs/change-execution.md');
const documentationModel = read('docs/documentation-model.md');
const testAuthorRole = read('.codex/agents/test-author.toml');

const APPROVED_SECTIONS = [
  'Purpose, Scope, And Ownership',
  'Evidence Acquisition',
  'Oracle Classification',
  'Harness Admission',
  'Effect Domains And Observation Channels',
  'Execution Environment',
  'Known Debt',
];

/**
 * Counts words the way the ceiling clause is written to be read.
 *
 * @param {string} text Document text.
 * @returns {number} Word count.
 */
function words(text) {
  return text.trim().split(/\s+/u).length;
}

/**
 * Returns one governing-document section without depending on its prose.
 *
 * @param {string} text Document text.
 * @param {string} heading Approved H2 heading.
 * @returns {string} Section body, including its heading line.
 */
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = text.indexOf('\n## ', start + heading.length + 4);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * Asserts that every marker still appears in a document.
 *
 * @param {string} text Document text.
 * @param {(string|RegExp)[]} markers Required criteria markers.
 * @param {string} label Reported document label.
 */
function assertRetains(text, markers, label) {
  const missing = markers.filter((marker) =>
    typeof marker === 'string' ? !text.includes(marker) : !marker.test(text)
  );

  assert.deepEqual(missing.map(String), [], `${label} dropped a governed criterion`);
}

/**
 * Asserts that no marker appears in a document.
 *
 * @param {string} text Document text.
 * @param {string[]} markers Criteria that must have left this document.
 * @param {string} label Reported document label.
 */
function assertReleased(text, markers, label) {
  const kept = markers.filter((marker) => text.includes(marker));

  assert.deepEqual(kept, [], `${label} still states a rule it no longer owns`);
}

test('keeps the seven approved sections and stays under the stated ceiling', () => {
  const headings = [...contract.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  const count = words(contract);

  assert.deepEqual(headings, APPROVED_SECTIONS);
  assert.ok(
    count <= CONTRACT_CEILING,
    `${CONTRACT_PATH} has ${count} words; maximum is ${CONTRACT_CEILING}`
  );
});

test('states the ceiling exactly once, in the paragraph that owns it', () => {
  const exact = new RegExp(
    String.raw`(?<![\p{L}\p{N}_])at most ${CONTRACT_CEILING} words(?=\.)`,
    'gu'
  );
  const wordFigure = /(?<![\p{L}\p{N}_])\d[\d,_]*(?=(?:\s+words|\s*-\s*word)\b)/gu;
  const literal = new RegExp(String.raw`at most ${CONTRACT_CEILING} words`, 'gu');
  const clause =
    contract.split('\n').find((line) => line.includes(`at most ${CONTRACT_CEILING} words`)) ?? '';
  /**
   * Decides whether one text states this ceiling exactly once, in the sentence
   * form the clause is written in. Both halves are required: the literal count
   * catches a second statement anywhere, and the anchored form catches a figure
   * that has been extended into a different number or a different word.
   *
   * @param {string} text Candidate clause text.
   * @returns {boolean} True when the ceiling is stated once and unambiguously.
   */
  function statesCeilingOnce(text) {
    return [...text.matchAll(literal)].length === 1 && [...text.matchAll(exact)].length === 1;
  }

  assert.ok(statesCeilingOnce(clause), 'the ceiling must be stated once');
  assert.equal([...contract.matchAll(literal)].length, 1, 'the ceiling is stated more than once');
  assert.deepEqual(
    [...contract.matchAll(wordFigure)].map((match) => match[0]),
    [String(CONTRACT_CEILING)],
    'the document states a word figure that is not its ceiling'
  );

  for (const replacement of [
    `1${CONTRACT_CEILING} words`,
    `${CONTRACT_CEILING} ${CONTRACT_CEILING} words`,
    `${CONTRACT_CEILING} words, and at most ${CONTRACT_CEILING} words`,
    `${CONTRACT_CEILING} words-extra`,
  ]) {
    const mutant = clause.replace(`${CONTRACT_CEILING} words`, replacement);

    assert.ok(!statesCeilingOnce(mutant), `accepted ceiling mutant: ${replacement}`);
  }
});

test('binds the ceiling to relocation rather than to deletion', () => {
  assertRetains(
    section(contract, 'Purpose, Scope, And Ownership'),
    [
      'docs/engineering-doctrine.md',
      'never deletes a rule, drops a qualifier, or compresses away a criterion to fit',
      'only an engineer may raise it',
      'tests/verification-instruments-contract.test.mjs',
    ],
    'the ceiling clause'
  );
});

test('keeps the four oracle properties and their falsifiers enumerable', () => {
  const oracle = section(contract, 'Oracle Classification');
  const properties = ['Prior', 'Bounded', 'Reproducible', 'Re-runnable'];

  for (const property of properties) {
    assert.match(
      oracle,
      new RegExp(String.raw`^\| ${property} \| `, 'mu'),
      `oracle property ${property}`
    );
  }
  // The falsifier column is the instrument, not an illustration. A property row
  // that keeps its name and loses its falsifier restores the unexamined claim
  // this table exists to replace.
  assert.match(oracle, /^\| Property \| The oracle \| Falsifier \| Pathology when absent \|$/mu);
  assertRetains(
    oracle,
    [
      'Is its instruction of the form "name one"?',
      'An oracle missing any of the four is weak.',
      'an honest weak oracle is far better than a mechanical proxy that looks strong',
    ],
    'the oracle table'
  );
});

test('keeps the three responses and both limits that bound them', () => {
  const oracle = section(contract, 'Oracle Classification');

  assertRetains(
    oracle,
    [
      '**Declare.**',
      '**Demote.**',
      '**Convert.**',
      'A gate that cannot say which of the four properties its oracle holds does not have a sufficient entry condition',
      'A weak oracle informs and does not gate.',
      // Without the admissibility bar, Convert licenses any mechanical proxy
      // that looks strong, which is the failure mode Convert itself creates.
      '**a necessary condition is admissible only when its violation has actually been observed.**',
      'Some judgements have no strong oracle and will not acquire one',
      '**Portability is never a reason to weaken an oracle.**',
    ],
    'the oracle responses'
  );
});

test('keeps the vocabulary collision that made the bounded property unusable', () => {
  // This paragraph is the one a compression pass reads as an anecdote. It is
  // the reason the property has a name distinct from the scope sense the rest
  // of the framework uses constantly; without it a reader fluent in the scope
  // sense never asks the question the property asks.
  assertRetains(
    contract,
    [
      'When the property is meant, write `bounded oracle`.',
      'A bare `bounded` in a gate, review, or state event means the scope sense.',
    ],
    'the bounded collision rule'
  );
});

test('keeps harness admission decidable by running rather than by reading', () => {
  const harness = section(contract, 'Harness Admission');

  assertRetains(
    harness,
    [
      '**A harness that has never produced a deliberate FAIL is not admitted as an oracle.**',
      'at minimum one success and one failure, plus one timeout wherever the harness declares a timeout outcome',
      'The self-check is not a gate run, consumes no scenario denominator, and produces no product evidence.',
      // The three properties the self-check establishes and reading cannot.
      'A stand-in target must remain observable until the harness has finished evaluating its success condition.',
      'A harness must reach its success outcome through an explicit terminal status.',
      'A harness must not record an outcome it did not observe.',
      // Re-admission boundary and the blunt disposition that makes it cheap.
      'An unchanged harness already admitted under this section stays admitted.',
      'A gate executed by an unadmitted harness produces no evidence.',
      'Its result is void whether it passed or failed',
    ],
    'harness admission'
  );
});

test('anchors evidence acquisition and the two instrument rules this change added', () => {
  const acquisition = section(contract, 'Evidence Acquisition');
  const harness = section(contract, 'Harness Admission');

  assertRetains(
    acquisition,
    [
      // The fourth condition. Without it the document governs only evidence that
      // arrived, which cannot reach a predicate nobody went after.
      'the evidence that would have settled a predicate was cheap, obtainable, and never obtained',
      'No rule about evidence that arrives can reach that, because nothing arrived',
      // The bound that keeps [EVID-001] from becoming an unbounded oracle.
      'It does not require showing that no cheaper probe exists',
      // The observation the scale exists for: the cost structure was inverted.
      'Asking the engineer costs `judgment` or more, and it was the only probe this process had institutionalised',
      'A cheap probe whose outcome changes nothing is not a cheap win.',
      'Evidence that was obtainable and was not obtained is its own failure',
    ],
    'evidence acquisition'
  );
  // The scale is a closed set: a sixth bucket, or a missing one, changes what
  // "cheapest" means in [EVID-001].
  const costs = ['none', 'ambient', 'glance', 'judgment', 'deliberation'];
  assert.deepEqual(
    [...acquisition.matchAll(/^\| `([a-z-]+)` \| /gmu)].map((match) => match[1]),
    costs,
    'the attention-cost scale changed'
  );

  assertRetains(
    harness,
    [
      // NHC-FND-002: fifty-eight green while the deciding comparator ran zero
      // times. A count over cases that never reached the assertion is not
      // evidence, and nothing said so.
      "**A gate's case count is evidence only for the cases whose deciding assertion executed.**",
      'contributes to the count and to nothing else',
      // The seven fields, and the boundary against the calibration specification
      // that owns the ongoing programme rather than this one record.
      "An instrument's discriminating power is established by intervention and never by reading",
      // All seven fields, because an unpinned one is deletable: the first draft of
      // this assertion pinned four and an independent review removed a fifth.
      'names seven things',
      'the instrument state measured, as a commit or content digest',
      'the check that ran it',
      'the intervention',
      'the code path it was applied to; the code path the check exercises',
      'the observed result on each side; and the date',
      // Both sides of the boundary against the calibration specification, which
      // owns the ongoing programme and disclaims this one-instrument record.
      'docs/specs/20260719-verification_calibration.md',
      'Harness Admission evidence about one instrument',
      // Measured: a verdict recorded without these fields went unreproducible in
      // a working day, having already been cited as a current property.
      'A mutation placed in a branch no check enters yields a green suite indistinguishable from a sound oracle',
    ],
    'the instrument rules'
  );
});

test('keeps the effect-domain rule and the observation-channel repair', () => {
  assertRetains(
    section(contract, 'Effect Domains And Observation Channels'),
    [
      'is a finding against the architecture rather than against the check',
      'is not repaired by granting the check access to that domain',
      'the repair is a named observation channel owned with the subject rather than an instrument owned by the check',
      // Without the timing clause, an acceptance unit may build the channel
      // inside the gate, which is the expensive path the rule exists to stop.
      'is decided before the acceptance gate that needs it rather than inside it',
      'building the instrument inside the gate is the expensive path this rule exists to prevent',
      // The rule was already stated and still violated in one pilot, because
      // nothing told an agent it was inside the rule. The detector must key on
      // the deciding observation, not on how the probe reaches the machine: an
      // earlier draft exempted any probe naming an environment fact, and every
      // real probe names one, so it fired on nothing. Recurrence is identified
      // by subject and missing observation, since a rename would otherwise
      // reset the count.
      "deciding observation comes from the subject's own records, schemas, or interfaces",
      // Without this, an existing owned channel would itself classify as
      // forbidden outside instrumentation.
      'where no owned channel already carries it',
      'however it locates them',
      // The detector is a backstop, not a budget of two: an earlier draft read
      // as licensing the first reconstruction, which weakened the very rule it
      // was added to enforce.
      'The repair is owed on the first occurrence',
      "reconstructing the same subject's same missing observation a second time",
      'whatever the probe is named',
      'is the signal that it was missed',
      'promoted to that owner before a third',
    ],
    'the effect-domain rule'
  );
});

test('keeps the container rule with its single exception intact', () => {
  const environment = section(contract, 'Execution Environment');

  assertRetains(
    environment,
    [
      'An ordinary deterministic check MUST NOT require a container runtime.',
      'The single exception is a check whose subject is container behavior itself',
      // Without the subject rule, the exception is claimed by convenience.
      'The boundary is the subject of the assertion, never the convenience of the runner.',
      'Two checks over the same file can therefore fall on opposite sides',
      'A deterministic check MUST NOT assert platform-specific behavior implicitly.',
      'The objective is attributable divergence.',
      // Both satisfying forms must survive; one alone reads as the only form.
      'it.skipIf(process.platform === ',
      'make the divergence its subject and assert it',
    ],
    'the environment rules'
  );
});

test('keeps the real-use host manifest invariants', () => {
  const environment = section(contract, 'Execution Environment');

  assertRetains(
    environment,
    [
      'A manifest is applied by a command and never by a role.',
      'A manifest is not authoritative until a real bring-up has run against a host it produced.',
      'A manifest is grown rather than authored.',
      'Completeness is therefore never a gate on the manifest.',
      "A manifest describes the machine and never the product's state.",
      'Provisioning and bring-up are two commands and never one.',
      'The manifest is addressed by a digest of its own content',
      'manifestDigest=<64-lowercase-hex>',
      'followed by one newline',
      'the value is the SHA-256 of the exact asserted `manifest.json` bytes',
      'Fixture and remote assertion modes collect their observations separately and submit the same normalized fact object to one shared comparator.',
      'The assertion half runs through the existing `pnpm host:assert <alias>` command before real use rather than from a parallel preflight or wrapper.',
      // A recommendation stated as a precondition would forbid the shared host
      // this repository actually has.
      'This is a recommendation rather than a precondition',
      'What is not optional is that the program owns the state the manifest asserts',
      // Strict-risk boundary: it does not relax inside any bounded workspace.
      'Test credentials are generated per attempt, are attempt-local, and are removed on every terminal path.',
      '`[SCOPE-004]` boundary and it does not relax inside any workspace however bounded',
      'one lowercase ASCII label matching `[a-z][a-z0-9-]{0,62}`',
      'passed as one argument, never evaluated as shell text or accepted as an SSH option',
      'Repository files provide no default alias and hold no hostname, user, key, identity file, SSH option, or trust override.',
      "The operator's local SSH configuration alone resolves the alias to the host, user, and private-key reference",
      'ordinary OpenSSH host-key verification applies without `StrictHostKeyChecking` relaxation',
      'an alternate empty known-hosts file, trust-on-first-use substitution, or another bypass',
      'This boundary is verification-only.',
      'may be invoked only by the producer whom the engineer explicitly authorizes to contact the named host for that exact strict-risk real-use task',
      'neither a role assignment nor a change plan grants that authority',
      'It grants no product-runtime, general-purpose remote-execution, installation, credential-provisioning, tunnel, or fallback authority',
      'the following closed matrix and no open-ended search',
      'exactly five accepted origin classes',
      'HTTPS with its default port, HTTPS with an explicit port, and HTTP with literal `localhost`, `127.0.0.1`, or `[::1]`',
      'exactly seven rejected classes',
      '`file`, another scheme, user information, path, query, fragment, and non-loopback plaintext',
      'Bring-up is checked at exactly seven terminal edges',
      'assertion failure, service-start failure, readiness rejection or timeout, `HUP`, `INT`, `TERM`, and success',
      'Direct teardown is checked at exactly four outcomes',
      'stop failure, decommission failure, post-stop-still-active, and successful inactive completion',
      'The matrix is enumerated by executable checks',
    ],
    'the host manifest'
  );
});

test('keeps settled verification-instrument debt absent', () => {
  const debt = section(contract, 'Known Debt');

  assert.equal(debt.trim(), '## Known Debt\n\nNone.');
  assertReleased(
    debt,
    [
      'The Real-Use Host Manifest Is Decided And Not Implemented',
      'Real-Use Remote Execution Has No Owner',
    ],
    'known debt'
  );
});

test('releases the moved rules from the documents that used to state them', () => {
  // The doc-model validator classifies by path and cannot see an ownership
  // defect, so a re-homing is only checked by whether both sides moved. A rule
  // stated in two owners is worse than one stated in the wrong owner.
  const moved = [
    'A harness that has never produced a deliberate FAIL',
    'An oracle missing any of the four is weak.',
    'An ordinary deterministic check MUST NOT require a container runtime.',
    'A deterministic check MUST NOT assert platform-specific behavior implicitly.',
    'a named observation channel owned with the subject',
  ];

  assertReleased(taxonomy, moved, TAXONOMY_PATH);
  assertReleased(
    toolchain,
    [
      'A manifest is applied by a command and never by a role.',
      'Provisioning and bring-up are two commands and never one.',
    ],
    TOOLCHAIN_PATH
  );
  assert.equal(
    [...taxonomy.matchAll(/^## (?:Oracle Classification|Harness Admission)$/gmu)].length,
    0,
    `${TAXONOMY_PATH} still carries a moved section heading`
  );
});

test('keeps both sides of the calibration boundary stated', () => {
  // The doc-model validator classifies by path and cannot see an ownership
  // defect, so a boundary stated by one side only is how one record acquires two
  // owners. The specification that owns the ongoing programme has to disclaim the
  // single-instrument admission record explicitly.
  // Scoped to the disclaiming section on purpose: the same sentence under `Owns`
  // would claim the record rather than cede it, and a whole-file search cannot
  // tell those two apart.
  const calibration = read('docs/specs/20260719-verification_calibration.md');
  assertRetains(
    section(calibration, 'Does Not Own'),
    [
      'The single-instrument discriminating-power record that admits one harness as an oracle',
      CONTRACT_PATH,
    ],
    'docs/specs/20260719-verification_calibration.md Does Not Own'
  );
});

test('keeps both sides of every ownership boundary stated', () => {
  // An owner that only claims, or only disclaims, leaves the seam decidable
  // from one document alone, which is how the same rule acquires two owners.
  assertRetains(
    contract,
    ['docs/specs/20260529-test_strategy.md', 'docs/toolchain.md', 'docs/change-execution.md'],
    'the new owner'
  );
  assertRetains(
    taxonomy,
    [
      'oracle classification, harness admission, the effect-domain and observation-channel rules',
      CONTRACT_PATH,
    ],
    TAXONOMY_PATH
  );
  assertRetains(
    toolchain,
    ['This decision reaches as far as the image and no further.', CONTRACT_PATH],
    TOOLCHAIN_PATH
  );
  assertRetains(
    documentationModel,
    [
      CONTRACT_PATH,
      'a fourth member is the event that promotes it to a `docs/governance/` directory',
    ],
    'the type amendment'
  );
});

test('keeps the qualifiers an independent review has already caught once', () => {
  // Each marker below was absent or wrong in the first draft of this re-homing
  // and was restored after independent review. They share a shape: the moved
  // rules survived intact, and what broke was the connective prose written to
  // seat them in a new document.
  const purpose = section(contract, 'Purpose, Scope, And Ownership');

  assertRetains(
    purpose,
    [
      // The owner must state its own application scope. Leaving it only in the
      // disclaimer of the document that gave the rules up lets a reader of the
      // actual owner exclude documentation validators and review propositions.
      'apply to every deciding instrument this repository relies on, including gate oracles, documentation validators, and review propositions',
      'not only to instruments that live in test files',
      // Toolchain owns environment selection and the two-results reconciliation
      // rule. An unceded claim here would give that rule a second owner.
      'remain with `docs/toolchain.md`',
    ],
    'the scope and cession clauses'
  );
  // The image is one of three permitted environments, not a capability ceiling.
  // Asserting otherwise contradicts the Capability Is Discovered, Not Declared
  // judgment that `docs/toolchain.md` owns.
  assert.ok(
    !contract.includes('fixes what such a check may reach'),
    'the new owner must not restate the image as a capability ceiling'
  );
  assertRetains(
    toolchain,
    ['No document enumerates the capabilities an ordinary deterministic check requires'],
    TOOLCHAIN_PATH
  );
  // The container rule must not survive in both documents in different words.
  assert.ok(
    !taxonomy.includes('browser profile state, or a container runtime'),
    `${TAXONOMY_PATH} still states the container boundary it gave up`
  );
});

test('routes conditional instrument use to the document that owns it', () => {
  assert.ok(
    /(?:when|if)[^.\n]*(?:instrument|oracle)[^.\n]*(?:decid|gate)[^.\n]*`docs\/verification-instruments\.md`/iu.test(
      changeExecution
    ),
    'conditional instrument use must route to docs/verification-instruments.md'
  );
  assert.ok(
    !/^\| Oracle \| /mu.test(changeExecution),
    'the retired universal gate Oracle row must be absent'
  );
  assertRetains(
    testAuthorRole,
    [`Oracle Classification table of ${CONTRACT_PATH}`],
    '.codex/agents/test-author.toml'
  );
});
