---
date: "2026-10-25"
---
# Independent Documentation Audit: Process Group

This non-authorizing record holds the process group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `d818256def07ecebfc0bcc9c85270fde5047341a` (`main` on 2026-10-25). Issue #440 had no comments and held no group in this scope.
- Specifications (all `kind: process`): `20260529-test_strategy.md` (TST), `20260529-l6_story_acceptance.md` (L6), `20260719-verification_calibration.md` (VCA), `20260711-evaluation_harness_design.md` (EVH, Draft), `20260811-execution_residue_measurement.md` (ERM), `20260729-documentation_field_contract.md` (DFC), `20260829-release_management.md` (REL), and `20260909-persistent_deployment_acceptance.md` (PDA).
- The specifications guide `docs/specs/README.md`, and an audit-only reading of `docs/specs/AGENTS.md`.
- No Core document owns these processes. G2 compares them with `docs/core/doctrine.md`, `docs/core/contract-evolution.md`, `docs/verification-instruments.md`, `docs/documentation-model.md`, `docs/toolchain.md`, and root `AGENTS.md`.
- G3 inspection: three read-only inspector contexts (PR-TST, PR-VCA, PR-REL). They read code only and ran no tests. The auditor verified each kept finding against the code, and read GitHub releases and tags through the GitHub API.

## G2 Process Specifications Against Their Owners

- PR-G2-01: TST line 160 says L0 should enforce that every app and package keeps its own `AGENTS.md`; root `AGENTS.md` LOCAL-001 makes a local `AGENTS.md` optional. Four packages have none (`apps/nanohost`, `packages/pi-runtime-host`, `packages/retrieval-kernel`, `packages/storage`), and no L0 check exists. Two accepted owners conflict: Question Q-161.
- PR-G2-02: VCA line 121 and `docs/documentation-model.md:123` say that `docs/engineering-doctrine.md` holds a falsifiability commitment for the delegation premise. The doctrine has no such sentence, and its Git history shows none. Question Q-166.
- PR-G2-03: VCA line 70 names a saboteur agent; root GOV-013 allows dispatch only of roles whose contracts live in `docs/roles/`, and none names this function. Question Q-165.
- PR-G2-04: PDA line 115 states the automatic release update flow as current; REL line 350 and `scripts/release-update-app.mjs:314-343` show that the App update step refuses to run. Corrected in the PDA projection (see G3).
- PR-G2-05: ERM line 56 lists strict incidents with "publication" where the Safety Kernel says "External Effect and Publication"; VCA line 42 adds "durable authority" to the doctrine's strict list. Wording only; Question Q-168.
- PR-G2-06: REL against `docs/core/contract-evolution.md` (the `v0.1.0` boundary, protected accounts, no automatic reset) and against `docs/toolchain.md`; L6 and TST against `docs/core/doctrine.md` and `docs/verification-instruments.md`. No conflict.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| PR-TST-01 | TST Existing Entrypoints (line 135) and Naming And Placement (line 329): `pnpm --filter @openkit/web e2e:staging` under `apps/web/e2e/staging/`; Summary (line 30): the repository already has staging UI e2e tests | `apps/web/package.json` has only `e2e`; no staging directory; `scripts/docker/e2e-app.sh:147` and `docs/cookbooks/docker-app.md:104` call the missing script | Code differs from the accepted specification at lines 135 and 329; the Summary status claim and the projection line drifted | Issue #516 covers lines 135 and 329 and leaves restore or retire open (TST line 425 and the container packaging specification lean to retire); the Summary claim and the projection are corrected |
| PR-TST-02 | TST lines 305 and 307 name `nanocore-e2e`; the projection repeats the dispatch list | `.github/workflows/ci.yml:13-25,453` use `nano-core-e2e` and add `registry-admission` (owned by Release Management) | Projection drift; the normative names need an engineer ruling | Projection list corrected; Question Q-157 |
| PR-TST-03 | TST line 309: the release gate should run `pnpm -w verify:release` | `ci.yml` runs the sharded `scripts/ci-l0-l2.mjs` gate, `test:e2e:nano`, `test:e2e:web`, and `test:smoke`, and never `verify:release`; TST lines 305 and 311 describe the sharded form | Internal inconsistency; [Release cadence](../decisions/20261014-release_cadence.md) decides single-run coverage but does not name `verify:release` | Question Q-158 |
| PR-TST-04 | TST line 301: pull requests run only the lightweight repository check | `ci.yml:187-205` also runs the NanoHost installer fixed-path gate on pull requests | A question, not an issue: REL line 190 and the NanoHost specification name the installer gate for tags only, no owner states the pull-request scope, and the recommendation keeps the code | Question Q-159 |
| PR-TST-05 | TST Failure Evidence lines 348-352 and line 319 | `ci.yml` L3 (453-505) and L5 (631-660) jobs upload nothing; `apps/nanocore/e2e/_lib/harness.ts:228-259` keeps logs in memory; Playwright keeps only traces | Code differs from the accepted specification (SHOULD) | Issue #517 |
| PR-TST-06 | TST L5 (lines 259-271): smoke stays shallow; Test Authority line 93: no raw SQL setup | `tests/smoke/nanocore-worker-mcp-smoke.mjs` (1,383 lines) carries a Task, inserts and reads rows by raw SQL (868-881, 907-961), and imports `dist/test-support` | Undecided: an L3 proof placed in L5, with no named exception | Question Q-160 |
| PR-TST-07 | TST line 233: e2e specs do not import NanoCore `src/` | `apps/nanocore/e2e/no-src-imports.spec.ts:18,24-27` scans `.ts` files and lines that start with `import ` only | The check differs from the accepted specification (weak oracle) | Issue #518 |
| PR-TST-08 | TST line 160 | See PR-G2-01 | Two accepted owners conflict | Question Q-161 |
| PR-TST-09, 10, 12 | TST line 358 "one ... terminal result per attempted run"; line 362 vocabulary "owned by" the Gateway specification; line 287 dynamic ports | `provider-subscription-real-lifecycle-runner.mjs:188-206` writes one file for all runs; the Gateway specification names two of the runner's six codes; runner line 90 defaults to port 4319 | Undecided ("run" is undefined, the owner lists only part of the vocabulary, the opt-in runner's fixed default is overridable) | Question Q-162 |
| PR-TST-11 | TST projection lists the C01-C04 entrypoints only | `test:e2e:real-codex` (`package.json:38`) and `apps/nanocore/e2e/worker-responses-relay-real-provider-runner.mjs` exist | Projection drift | Corrected |
| PR-L6-01 | L6 line 135: a change to a listed document marks the story for review | `scripts/lib/story-metadata.mjs` checks that contract files exist; no tool or written practice marks a story | Undecided (a review practice may satisfy it) | Question Q-163 |
| PR-L6-02 | L6 line 401: predicates declare channel and tier | All ten stories comply; L6 line 377 makes only front matter, contract references, and section list mechanical | Match | None |
| PR-VCA-01 | VCA Owns: "cadences" | No cadence is stated for the three layers or the probes | Undecided | Question Q-164 |
| PR-VCA-02, 03 | VCA lines 70 and 121 | See PR-G2-03 and PR-G2-02 | Conflict with root governance; missing anchor | Questions Q-165, Q-166 |
| PR-DFC-01 | DFC line 67: one validator plus one generator | `scripts/validate-doc-model.mjs` and `scripts/validate-spec-lifecycle.mjs` both run in `check:repo` (`package.json:28`) | Code differs from the accepted specification, which owns the consolidation (DFC line 12); the acceptance predicate (one module, no metadata regular expression) holds. `docs/documentation-model.md:44` names the second validator as a pointer, so the repair changes that pointer in the same change | Issue #519 |
| PR-DFC-02 | DFC Problem and Migration describe the dual-format state in the present tense | `scripts/lib/doc-fields.mjs` has no legacy reader | Dated narrative | Question Q-168 |
| PR-REL-01 | REL projection: releases `v0.1.0-rc.2` and `v0.1.0-rc.3` are published | The GitHub releases API on 2026-10-25 lists `v0.1.0-rc.2` through `v0.1.0-rc.6` and `v0.1.0-rc.8`; tags `v0.1.0-rc.1` and `v0.1.0-rc.7` have no release | Projection drift | Corrected |
| PR-REL-02 | REL frontmatter `updated` predates its last commit | Frontmatter | The audit does not change frontmatter dates | No action |
| PR-REL-03 | REL line 439: the collection contract requires five named test files exactly once | `scripts/release-tests.mjs:315-370` discovers `scripts/**` without naming them; only `tests/release-shards.test.mjs:314-468` names the five | Undecided whether the test projection satisfies the clause | Question Q-167 |
| PR-REL-04 | PDA line 115 and `implementation: Implemented` | `scripts/release-update-app.mjs:314-343` always refuses after input validation; REL line 350 agrees and also names the complete component update sequence and the first preflight-less upgrade as unresolved | Projection drift; the PDA acceptance kit itself is implemented, and the update step belongs to Release Management | PDA projection corrected; the `implementation` value is unchanged |
| PR-EVH, PR-ERM | EVH (Draft) and ERM: no harness, no record families, records under `docs/audits/` | No harness code; `scripts/validate-doc-model.mjs:1098-1116` checks audit records | Match | None |
| PR matches | TST root and package scripts, CI triggers, concurrency, opt-in gates, C01-C04 paths, coverage recipe; L6 catalog, front matter, body sections, asset shapes; VCA removal-evidence outcomes and harness admission; DFC module exports, parse failures, coercion, schemas; REL tag grammar, package versions, five attachments, notes grammar, Skill archive, concurrency, pinned actions, publication authorization, reuse rules, retention, inventory; PDA outcome codes, no default target, release-only helper | The inspectors' tallies in the audit working space | Match | None |

## Specifications Guide And Local Rules

- SPX-01: the Active Spec Index in `docs/specs/README.md` omitted 19 root specifications. They are now listed in their topic groups. The Draft `20261019-durable_execution_and_control_store.md` is held under #440; only its index line was added, and its content was not audited.
- SPX-02: many paragraphs of `docs/specs/README.md` had line breaks inside the paragraph (NONNEG-002). They are joined; a whitespace-normalized comparison shows the text is otherwise identical.
- SPX-03: the status, implementation, and transition values in the README match `scripts/lib/doc-fields.mjs`.
- SPX-05: the README Lifecycle Evidence example used the former header lines (`Status Changed:`, `Current Guidance:`, `Decision Evidence:`). The accepted Field Contract in `docs/documentation-model.md` and DFC moved these to the frontmatter fields `status-changed`, `current-guidance`, and `decision-evidence`, which every archived specification uses. The example and the five rule sentences that name the fields are corrected; the rules are unchanged. The README phrase "`Status: X` with `Implementation: Y`" names field values and stays.
- SPX-06: P0-G2-01 (summary record) found that no governance document indexes the eight process specifications as one family. The README Active Spec Index now lists seven of them in the group "Workflow, human attention, and verification", and EVH under "Storage, knowledge, policy, vault, audit, and metering". Every specification declares `kind: process`, which the generated index can group. The index serves as the family list; no further action.
- SPX-04: `docs/specs/AGENTS.md` also has line breaks inside paragraphs in Spec Boundary Rules, Required Structure, and Status And Implementation Rules, and it restates README sentences ("Specs are the contract layer ..."). Root `AGENTS.md` forbids the audit from editing it. Question Q-170.

## G4 Organization

No move, merge, or split is applied. REL places normative sections ("Exact-Head Pre-Merge And Release Coordination", "Hosted Scratch Fixture") after `## Links`; Question Q-168.

## G5 Writing

- Experience-chosen numbers not marked as a current default: VCA "three to five seeds in one cycle"; TST "ratio above three to one"; L6 "three consecutive runs ... two for opt-in real-provider" and "one release cycle"; REL "Fourteen-day CI artifact retention", "thirty seconds", and "thirty-two to forty-eight Turns". Question Q-168.
- Trial and round results in normative text: VCA "7 of 13 removed declarations"; DFC "212 documents: 187 carried legacy metadata"; REL "Tag run 38093270321". Question Q-168.
- History and amendment wording: TST "were previously stated in this specification"; L6 "The five former mechanical story proofs now run ..."; DFC "changed from `Draft` / `Not Started` to `Accepted` / `In Progress`"; REL "No reset is executed by this owner amendment". Question Q-168.
- Repeated ruling: REL lines 250, 254, and 256 restate one identifier-cutover ruling. Question Q-168.
- Implementation identifiers in DFC normative text (`parseFrontmatter(content)`, script paths, a quoted regular expression) with no projection section. Question Q-168.
- Undefined labels: L6 "A1", REL "P29", "P14", "the runner", VCA "load-bearing map" and "saboteur". As Q-28: Question Q-168.
- TST Related Docs list two superseded specifications. Question Q-168.
- Dated facts in normative text: PDA "the engineer's 2026-09-09 purpose" and REL "on 2026-10-12 returned `PUBLIC`". Question Q-168.
- L6 uses "RelayStream", which only other specifications define. Question Q-168.
- The REL `## Deferred / Future Work` list is split by blank lines. Question Q-168.

## Public Repository Hygiene

- PR-HYG-01: `docs/decisions/20261014-release_cadence.md` (Reason) cites a report by a home-relative working path, and its Decision names development machines by short host aliases. Decision records are append-only rationale, and this audit does not edit them. Question Q-169.

## Semantic Preservation

The inventory tool compared each changed file with the group base.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260529-test_strategy.md` (TST) | 118 unchanged | 0 | 130 unchanged, 1 changed (`nanocore-e2e` to `nano-core-e2e` in the projection), 9 added | 29 unchanged | 4 unchanged |
| `20260829-release_management.md` (REL) | 164 unchanged | 0 | 140 unchanged, 2 removed (`v0.1.0-rc.3` in the release sentence, `gh release view v0.1.0-rc.1`), 3 added | 39 unchanged | 35 unchanged |
| `20260909-persistent_deployment_acceptance.md` (PDA) | 19 unchanged | 0 | 18 unchanged, 1 added | 15 unchanged | 9 unchanged |
| `docs/specs/README.md` | 55 unchanged, 6 changed (field labels to frontmatter keys only, SPX-05) | 1 unchanged | 211 unchanged, 5 changed (field labels), 25 added | 40 unchanged | 87 unchanged, 20 added |

Changed sentences: the TST Summary status claim (staging tests removed from the list of existing tests) and Current Implementation Projection (dispatch list, staging gap, two further entrypoints), the REL release observation, and one added PDA sentence. The README gains index lines and a field-contract link, renames the lifecycle fields to their frontmatter keys, and loses in-paragraph line breaks. No design rule changed.

## Issues Opened

- #516 `[web] The Web staging e2e script e2e:staging does not exist, but the Docker app e2e script still calls it`, low.
- #517 `[ci] L3 NanoCore e2e and L5 smoke jobs keep no failure evidence beyond the job log`, ordinary (label `enhancement`).
- #518 `[tests] The NanoCore e2e import-boundary check misses multi-line, dynamic, and .mjs imports`, low.
- #519 `[scripts] Documentation field checks still run as two validators instead of one validator plus the index generator`, low (label `enhancement`).

## Questions For The Engineer

### Q-157. Which CI job and dispatch names does the test strategy fix?

- Context: TST lines 305 and 307 name `nanocore-e2e`; the workflow uses `nano-core-e2e`, and dispatch also offers `registry-admission`, which Release Management owns.
- Options: (A) State the jobs and selections by layer in domain terms in the contract, and keep the workflow identifiers in the projection only. (B) Rename the workflow job to `nanocore-e2e`.
- Recommendation: A, because `docs/writing.md` keeps implementation identifiers out of normative text.
- Meanwhile: the projection lists the workflow's names.

### Q-158. What does the release gate run?

- Context: TST line 309 says the release gate should run `pnpm -w verify:release`; lines 305 and 311 describe sharded, reuse-based jobs, and CI never runs `verify:release`.
- Options: (A) Replace line 309 with a rule that the release gate covers the `verify:release` composition, as the admitted shards. (B) Keep line 309 and run `verify:release` in CI.
- Recommendation: A.
- Meanwhile: no change.

### Q-159. Is the NanoHost installer gate a pull-request gate?

- Context: TST line 301 says pull requests run only the lightweight repository check; CI also runs the isolated installer fixed-path gate on every pull request.
- Options: (A) Add the installer gate to TST as a named pull-request exception, with its owner. (B) Run it on `main` pushes and tags only.
- Recommendation: A, because the gate is cheap and protects an installer boundary.
- Meanwhile: no change.

### Q-160. Where does the Worker MCP smoke belong?

- Context: `tests/smoke/nanocore-worker-mcp-smoke.mjs` carries a Task through a stand-in NanoHost session and sets up and checks state by raw SQL; TST keeps L5 shallow and forbids raw SQL setup.
- Options: (A) Move the Task proof to L3 through public interfaces, and keep L5 to boot and health. (B) Record it as a named L5 exception with an owner and a removal condition.
- Recommendation: A.
- Meanwhile: no change.

### Q-161. Must every app and package have its own AGENTS.md?

- Context: TST line 160 says L0 should enforce `AGENTS.md`, `README.md`, and aligned scripts in every app and package; root LOCAL-001 makes a local `AGENTS.md` optional; no L0 check exists.
- Options: (A) Change TST to require `README.md`, keep `AGENTS.md` optional, and decide whether L0 checks the README and script names. (B) Keep TST and add `AGENTS.md` files and a check.
- Recommendation: A, because root `AGENTS.md` owns the local-guide rule.
- Meanwhile: no change.

### Q-162. How are the real-provider runner terms defined?

- Context: TST line 358 says one terminal result per attempted run, and the lifecycle runner writes one file for its two runs; line 362 says the Gateway specification owns the failure vocabulary, but it names two of the six codes (the other four are in `apps/nanocore/src/llm/gateway-routes.ts:1666-1726`), while line 364 says the runner test owns the code enumeration; the opt-in runner defaults to a fixed port that an environment variable overrides.
- Options: (A) Define "run" as one runner invocation, reword line 362 so that the Gateway specification owns the meaning of the codes and the runner test owns the enumeration, and accept the overridable port default for the single-process runner. (B) List all six public codes in the Gateway specification, change the runner to one file per lifecycle run, and use a dynamic port.
- Recommendation: A.
- Meanwhile: no change.

### Q-163. How is a story marked for review when a listed contract changes?

- Context: L6 line 135 says a change to a listed document marks the story for review; only contract existence is checked.
- Options: (A) State it as a review practice in the stories guide. (B) Add a check that lists stories whose contracts changed in a diff.
- Recommendation: A, as no present need for a tool is shown.
- Meanwhile: no change.

### Q-164. Does verification calibration own cadences?

- Context: VCA Owns lists cadences; the body states none and its Non-goals reject a scheduler.
- Options: (A) State that each cycle is audit-selected and sparse, and remove "cadences" from Owns. (B) State a current default cadence per layer.
- Recommendation: A.
- Meanwhile: no change.

### Q-165. Which role plants seeded defects?

- Context: VCA layer 2 names a saboteur agent; GOV-013 allows only roles with contracts in `docs/roles/`.
- Options: (A) Name the function as part of the Auditor role. (B) Add a role contract when the layer 2 pilot starts.
- Recommendation: A.
- Meanwhile: no change.

### Q-166. Where is the delegation premise's falsifiability stated?

- Context: VCA line 121 and `docs/documentation-model.md:123` cite a falsifiability commitment in `docs/engineering-doctrine.md`; the doctrine states the premise as an experiment but names no overturning observation.
- Options: (A) Add one sentence to the doctrine that names what would falsify the delegation premise, pointing to the VCA thresholds. (B) Remove the two pointers.
- Recommendation: A; it is a governance change for the engineer.
- Meanwhile: no change.

### Q-167. Does the test projection satisfy the five-file collection contract?

- Context: REL line 439 requires five named test files exactly once; production inventory discovers files without naming them, and only `tests/release-shards.test.mjs` names the five.
- Options: (A) Restate the clause as an inventory assertion that the release-shards test holds. (B) Make `scripts/release-tests.mjs` refuse a missing file.
- Recommendation: A.
- Meanwhile: no change.

### Q-168. How should the process-group wording, numbers, labels, and placement be fixed?

- Context: the G2-05, G4, G5, and PR-DFC-02 items above.
- Options: (A) As Q-28: mark experience-chosen numbers as current defaults, move trial results and history to change records, keep one copy of the REL ruling, move DFC identifiers into a projection section, move REL normative sections before Links, align the strict-incident wording with the Safety Kernel names, drop superseded Related Docs, and replace each label with its meaning or a link. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

### Q-169. Should the release-cadence decision record be redacted?

- Context: the repository is public; the record cites a home-relative working path and short development host aliases. Decision records are append-only, and Release Management also uses one alias as an exclusion name.
- Options: (A) Replace the path with a neutral description and keep the aliases only where a script uses them. (B) Keep the record as written.
- Recommendation: A, decided by the engineer.
- Meanwhile: no change.

### Q-170. Proposed changes to docs/specs/AGENTS.md

- Context: SPX-04. The audit may only propose.
- Proposal: join the in-paragraph line breaks; replace the restated README sentences with a pointer to `docs/specs/README.md`; keep every rule.
- Recommendation: apply the proposal.
- Meanwhile: no change.

## Independent Review

A fresh Opus context, dispatched as the Reviewer role, read the diff, this record, the ledger, the inventory, the inspector reports, and the cited code. Verdict: accept with fixes. Dispositions:

1. P0-G2-01 had no disposition: accepted. SPX-06 added, and the summary record links it.
2. Two REL line citations were wrong: accepted. 354 is now 350, and 437 is now 439.
3. The README Lifecycle Evidence example used the former header form: accepted. SPX-05 records the correction under the Field Contract.
4. The Q-162 context missed TST line 364: accepted. The context cites it, and the options are narrowed.
5. The #519 evidence omitted `docs/documentation-model.md:44`: accepted. The row names it as a pointer that the repair changes; issue #519 already says so.
6. TST Summary and entrypoint lines contradicted the corrected projection: accepted. The Summary status claim is corrected, and the row says which lines #516 covers.
7. Q-159 reasoning: accepted. The row says why it is a question.
8. Four G5 candidates without a disposition: accepted. Added to G5 under Q-168.
9. The PDA sentence was narrower than REL: accepted. It now names the two further unresolved parts.
10. rc.7 has a tag without a release: noted. REL line 63 keeps failure and partial publication visible without moving or deleting tags, and line 152 fixes a failing prerelease in the next one; the audit did not check why rc.7 has no release. No change.

## Checks

- `node scripts/validate-doc-model.mjs`: validated 676 documents.
- `node scripts/generate-doc-index.mjs`: wrote `docs/INDEX.md` (one added row for this record).
- `pnpm check:repo`: exit 0.
- The content scan of the staged diff found no emails, tokens, credential paths, private hostnames, local absolute paths, or Vietnamese text.
