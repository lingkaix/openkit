---
date: "2026-11-15"
---
# Independent Documentation Audit: Periphery Group

This non-authorizing record holds the periphery group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15).
- Repository guides: the `docs/*.md` files outside the Core, specification, decision, change and audit trees: `app-api.md`, `deployment.md`, `toolchain.md`, `roadmap.md`, `glossary.md`, `change-execution.md` and the other top-level guides. Governance guides receive editorial fixes only. `docs/product-vision.md` is out of scope.
- `docs/manual/`, `docs/cookbooks/` and `docs/roles/`.
- The package and app guides under `apps/` and `packages/`: `apps/nanocore/` (35 guides), `apps/web/README.md`, `apps/nanohost/README.md`, and the `packages/*/README.md` guides.
- The known periphery items in the summary record (Remaining Work item 2) and the supplement hand-off (item 7, two uses of "Core Permissions").
- Four specification lines handed off by earlier groups (below).
- G3 inspection: six read-only inspector contexts (P-DOCS, P-CB, P-NC1, P-NC2, P-NC3, P-PKG). They read code, workflows, scripts and Git history only and ran no tests. The auditor verified each kept finding against the base SHA.

## Specification Hand-Offs

| Line | Source | Evidence (at the group base SHA) | Action |
| --- | --- | --- | --- |
| `20260709-worker_credential_access_declarations.md` (WCAD) Current Implementation Projection | [Q-215](20261115-independent_doc_audit_storage.md#q-215-may-the-audit-correct-the-credential-declaration-projection) | The on-demand helpers and the SSH agent facade are implemented (`packages/worker-shim/src/credential-helper-*.ts`). Harness Login selection and exchange (`apps/nanocore/src/runtime/harness-login-selection.ts`, `harness-login-exchange.ts`) and the Codex host-managed login (`packages/worker-shim/src/adapters/codex.ts`) exist, but production composition installs no Login handler: `harness-login-exchange.ts:33-35` describes an uninstalled handler, no production code calls `bindHarnessLogin` (`apps/nanocore/src/runtime/nanohost-session-dispatch.ts:375`, `:628`), `apps/nanocore/src/runtime/harness-login-dormant.test.ts:25` asserts that the lifecycle stays uninstalled, and `20260703-vault_secret_injection.md:104` keeps production activation pending. Generic HTTP bearer refresh exists only as staged NanoHost Provider adapters (`apps/nanohost/src/openshell_provider.rs`) | Projection corrected per channel and activation state, under recommendation A of Q-215. Q-215 stays open for the engineer |
| `20260802-nanohost_runtime_and_transport.md` (NRT) Credential Channel Ownership | Q-215 | Same evidence | The same correction; the paragraph keeps its links |
| `20260703-worker_control_protocol.md` (WCP) seventh operation | runtime-model and work-model hand-off | `turn.steer` exists in `packages/worker-shim/src/harness.ts`, the Codex adapter, the Pi adapter (`packages/worker-shim/src/adapters/pi.ts:706`, `:1064-1095`) and `apps/nanocore/src/runtime/task-steer-receipt.ts`, added by `04b75579e` (Task live steer) | The false "is not implemented" clause is corrected; the qualification sentence stays (Question Q-257) |
| `20260528-core_client_boundary.md` (CCB) supervise route | round-1 PO-PEM-02 | The deterministic test supervise-step route is gone from the code | Corrected to a removal statement |

## Known Items

- `packages/core-client/README.md`: the provider-subscription count is now thirteen and the Quick Chat name is removed (known item); P-PKG-10 to -14 corrected the other counts in that guide.
- `apps/nanocore/README.md` and `packages/config-schema/README.md` Thread visibility claims: issue #471 is closed, and `THREAD_REQUIRED_FEATURES` in `apps/nanocore/src/storage/retained-work-events-v1.ts:164` is emitted by `apps/nanocore/src/lib/store.ts:1820` and `apps/nanocore/src/storage/control-store-products.ts:421`. The claims are true. No action.
- `docs/cookbooks/docker-app.md`: the missing `e2e:staging` call now has a note that names issue #516 (P-CB group).
- "Core Permissions" in `docs/cookbooks/persistent-live-acceptance.md` and `docs/roadmap.md:87` now names Core Policy.

## G3 Guides Against Implementation

The inspectors reported 127 findings: P-DOCS 15, P-CB 13, P-NC1 21, P-PKG 19, P-NC2 21 and P-NC3 38. Each guide is a projection of its code and owners, so the audit corrected each verified drift or dangling reference in place. A finding that needs a judgment, a procedure change or a change to dated evidence is a question.

| Findings | Files | Disposition |
| --- | --- | --- |
| P-DOCS-01 | `docs/app-api.md` | "Active Specifications" group that `docs/INDEX.md` never had: now "Specifications" |
| P-DOCS-02 | `docs/deployment.md` | Owner index named a superseded cell specification: now NRT |
| P-DOCS-07, -08 | `docs/toolchain.md:90` | The host list named the removed NanoCore restart gate (`f44d9350a`), which is deleted from the list; the app-image gate also runs on `main` pushes (`.github/workflows/ci.yml:716`, `20260529-test_strategy.md:385`). The MUST reservation and its criterion are unchanged. The host-placed `test:nanohost-maintenance-live` gate (`74db2d467`) fits none of the reserved kinds, so the list does not name it (Question Q-260) |
| P-DOCS-10 | `docs/roadmap.md:118`, `:191` | Retired Quick Chat name: personal Workspace Assistant (Question Q-258) |
| P-DOCS-11 | `docs/roadmap.md` R008 | The checked outcome stays as written, under the roadmap rule at `:10`; a note now says that ordinary portable import was later removed by the [online Workspace snapshots and recovery decision](../decisions/20261027-online_workspace_snapshots_and_recovery.md) |
| P-DOCS-15 | `docs/glossary.md` | The Consumer closure owners now name `docs/roles/auditor.md` and the verification calibration specification, which use the term |
| P-DOCS-03, -04, -06, -09, -12, -14 | `deployment.md`, `toolchain.md`, `roadmap.md`, `change-execution.md` | Questions Q-251 to Q-254 |
| P-DOCS-05 | `docs/toolchain.md:67` | Verified by the reviewer: `biome.json:19` also turns off `style/noNonNullAssertion`, which Biome 2.6.6 marks recommended, so three exclusions exist, not two. Question Q-252 |
| P-DOCS-13 | `docs/roadmap.md:95` | The `temp/` path is marked historical and `temp/` is uncommitted by rule. No action |
| P-CB-01 to -12 | `docs/cookbooks/` | Corrected: the protocol-first order is credited to `apps/nanocore/AGENTS.md` and the stack specification; the index entry and `docker-test-env.md` state that only CI runs `any` gates in the image; `docker-app.md` names the digest-pinned Node tag, `containers/workers/`, the persistence smoke container and the current Caddy image; `docker-test-env.md` names the tool downloader inputs, the image contents, the smoke list and the host scripts, and says why the installer and maintenance gates are host-placed; `release.md` names `work_artifact_submit` (three places) and the eight SBOM attachments |
| P-CB-13 | `docs/roles/README.md` | Question Q-255 |
| P-NC1-01 to -09, -11 to -21 | `apps/nanocore/README.md`, `apps/web/README.md` | Corrected: the L6 story link, a deleted test file, `build:compiled`, the `test:e2e` Codex exclusion, the Undici version, baseline wording for removed migrations, a removed operation, the 5 s and 15 s polls, removed Composer and Repositories text, the `test/` contents, personal Workspace naming and the Core Policy link. For P-NC1-05 the reviewer confirmed that Undici 8.12.4 keeps the two-second default threshold (`lib/dispatcher/client.js:311`), so the subtraction holds |
| P-NC1-10 | `apps/nanocore/README.md:747` | The guide quotes published code exactly. No action |
| P-PKG-01 to -18 | `apps/nanohost/README.md`, `packages/*/README.md` | Corrected: the 1,000,000,000-byte limit and the `vault_grant-request` Tool names; the operation counts in `app-api-schemas` and `core-client` (16 plus 9, thirteen, 27, 40, fourteen, one archive operation; ten, sixteen, 27, 30, five token methods); the protocol naming; the TypeBox pin 1.4.5; seven Worker shim operations; the DeepSeek rc.2 statement is now marked historical |
| P-PKG-19 | `packages/retrieval-kernel/notices/README.md:11-14` | Question Q-256 |
| P-NC2-01 to -11 | `apps/nanocore/src/runtime/README.md` | Corrected: thirteen Workspace step kinds and baseline wording (`execution-journal.ts:129-143`); `ControlGoalCommandInputSchema` in `goal-codecs.ts:156`; the Work contracts declared in `openkit-work-supply.ts` `OPENKIT_WORK_TOOL_DEFINITIONS`; `turn-routes.ts` owns bodies, not HTTP routes; twelve NanoHost effects (`nanohost-session-dispatch.ts:165-178`); the `openkit/worker-runtimes:dev` template value (`codex.agent.jsonc:12`); the generative descriptor table named instead of a stale count; the live raw-output coalescer (`gateway-routes.ts:2215`); the storage task-steer files; three relative paths |
| P-NC2-12 to -21 | `apps/nanocore/src/storage/README.md` | Corrected: migrations that the baseline squash removed (`drizzle/core` and `drizzle/workspace` hold only `0000_baseline`) are named as baseline content, and their one-way carry sentences are deleted because no carry exists; the protocol-v5 marker (the worker wire version is 97); the schema-only journal cut (producers and readers exist); retired repository table drops; the User and App migrations for `schema_version` and `authentication_json`; composed selected recovery finish and abandon (`workspace-restore.ts:1304-1307`), while MOVE stays uncomposed; personal Workspace naming; two relative paths |
| P-NC3-01 to -26 | 11 other `apps/nanocore/` guides | Corrected: Pi has no static readiness blocker (`336419497`); template checks are in `src/config/shipped-templates.test.ts`; a deleted encoded-slash regression; copied Provider templates receive a new Vault reference (`fs-layout.ts:917-922`); a missing API key gives `provider_api_key_missing` (`logical-models.ts:821-824`); the Drizzle migrator call; a dangling cookbook link; operation counts (25, eleven, nine, 23, 27, fourteen, sixteen, thirteen); deleted or never-present files (`core-command-typed-errors.test.ts`, `server-flow.ts`, `bootstrap.ts`, `actor-store-manager.ts`, `boot-index-readiness.test.ts`, `pi-ai-image-input.test.ts`, `procedure-owned-by-skills.test.ts`, `claim-observation-pages.test.ts`, `goal-intent.ts`) now name their merged successor or are deleted; `@napi-rs/canvas` 1.1.0 |
| P-NC3-27 | `apps/nanocore/src/lib/README.md:82` | A verbatim copy of the Knowledge guide paragraph about `src/knowledge/conflicts.ts`; deleted from the `lib` guide, kept in the Knowledge guide (Question Q-258) |
| P-NC3-28 to -38, P-NC2-20 | `apps/nanocore/` guides | Retired Quick Chat name: personal Workspace, or the Assistant `conversation.submit` path; the code identifiers keep the old name (Question Q-258) |

The auditor also corrected one claim that P-NC3 reported only as clause-test note 4: `apps/nanocore/src/vault/README.md:72` described `importWorkspaceVaultGrants` as if production code wrote `imported-history`. The function is the test fixture `apps/nanocore/src/storage/test-support/vault-retained-fixtures.ts:61`, and no production path writes that value. The line now says so.

After the review, the auditor also corrected four guide sentences that no inspector reported: `apps/nanocore/README.md:63` said that ordinary Workspace producers remain inactive, but the Workspace Worker-Turn producer admits its journal root (`apps/nanocore/src/runtime/worker-governance-turn-executor.ts:6192-6197`); `apps/nanocore/src/storage/README.md:225` now names the intent writer and its producers; `packages/worker-shim/README.md:83` now says that the rc.2 observations are not rc.5 results (`20260930-deepseek_worker_adapter.md:224`); and `packages/app-api-schemas/README.md:201` no longer names the Conversation table, which holds no ordinary Workspace, Thread or Turn command (`packages/app-api-schemas/src/conversation-operations.ts:31-104`).

## Observations Without A Finding

- `backfillControlReadMetadata` (`apps/nanocore/src/storage/control-store-read-metadata.ts:61`) has no production caller since the baseline squash. No accepted owner requires it. Code cleanup is outside this audit.
- After `832ffadf2`, no test checks the encoded-slash opt-in across the four shipped Agent templates; the parser tests remain (`apps/nanocore/src/runtime/agent-environment.test.ts:370-419`). The guide sentence that claimed the regression is deleted.
- `apps/nanocore/src/lib/store.ts:1021` derives retained Workspace ids from the input `quick_chat`. A rename at that place falls under the data continuity rule; round-1 Question Q-04 already recommends renaming code symbols only.
- `docs/changes/README.md:20` repeats the pilot route-log statement of Question Q-254. Change records are evidence and are not edited.

## Inspector Notes

Each clause-test note and G2 observation of the inspectors has one disposition:

- P-DOCS G2: `docs/app-api.md:42-50` names the operation definition specification only through its generic index line (`:43`). No action, because the line does not mislead. The missing NanoHost owner in `docs/deployment.md` is fixed by P-DOCS-02.
- P-DOCS notes 1 and 3 are Questions Q-252 and Q-254; note 2 (Known Debt values) is in Q-259; note 4 (D-labels) is Question Q-261.
- P-CB notes 1, 3 and 4 (`release.md` historical counts, timing projections and an issue snapshot) and notes 5 and 6 (restated Caddy boundary and image contents) are in Q-259; note 2 (the R2 CI hold) is Question Q-262.
- P-NC1 notes 1 and 2 and P-NC2 notes 1 to 5 are repeated paragraphs inside one guide. They are writing cleanups for the Q-259 sweep. P-NC3-27 was different: its paragraph was in the wrong guide, and its path did not resolve there. P-NC2 note 6 is fixed (the sentence is deleted).
- P-NC1 note 3: the `apps/web/README.md` Structure block omits `src/pwa/` and `focused-growth/`. No action, because the omission makes no false claim; the Web owner can add them.
- P-NC3 notes 1 to 3 are in Q-259; note 4 is corrected (above); note 5 is not a finding.
- P-PKG notes 1, 3 and 4 are in Q-259; note 2 is Question Q-256.

## G4 Organization

One placement fix: the duplicated Knowledge paragraph left the `lib` guide (P-NC3-27, Question Q-258). No file is moved, merged or split.

## G5 Writing

Guide prose repeats operation counts that the definition tables own. Twenty of them were stale (P-PKG-03 to -08, P-PKG-10 to -14, P-PKG-17, P-NC3-08 to -10 and P-NC3-12 to -16), and no check covers links or paths in `apps/` and `packages/` guides: `scripts/validate-doc-model.mjs:110` scans only `docs` and `skills/openkit-ops/references`. Question Q-259.

## Semantic Preservation

The inventory compares each changed file at the base SHA with the working tree. Guides under `apps/` and `packages/` are projections without normative sentences of their own; each of their changes is listed above.

| Files | Normative sentences | Other sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- | --- |
| WCAD, WCP, CCB and the five `docs/*.md` guides | 453 of 455 unchanged; 2 corrected (the `toolchain.md:90` host list, which drops the removed restart gate, and the app-image gate trigger); 1 added (the WCAD bearer-refresh status) | 9 of 1,930 corrected, 12 new | 123 unchanged | 642 of 643 unchanged; the superseded cell specification replaced by NRT | unchanged | 88 unchanged, 1 added (the R008 decision) |
| The six changed cookbooks | 121 unchanged | 16 of 745 corrected, 18 new | 41 unchanged, 1 added | 304 of 308 unchanged; 4 corrected (`containers/worker-*`, `node:26-bookworm-slim`, `openkit-app`, `work_submit_artifact`) | unchanged | 56 unchanged, 2 added |
| NRT | covered by the [runtime-model record](20261115-independent_doc_audit_runtime_model.md); this group changes only the Credential Channel Ownership paragraph | | | | | |

## Issues Opened

None. Each guide finding is a projection drift corrected in place. The code facts behind Questions Q-251 to Q-257 need an engineer judgment first.

## Questions For The Engineer

### Q-251. Does the deployment target judgment still hold without a single worker slot?

- Context: `docs/deployment.md:16` and `:18` rest the small-team target on "the single-writer, single-slot profile" of `20260703-runtime_scheduling_scale.md` and name "work queueing behind the single worker slot" as the overturn signal. That specification now sets an authored active-Turn bound with a default of 20 (`:78`) and admits concurrent Turns (`:94`); the code default is `HARNESS_DEFAULT_MAX_ACTIVE_TURNS = 20` (`packages/worker-protocol/src/harness-control.ts:18`). The single-writer part still agrees with the specification.
- Options: (A) Restate the judgment on the single writer and the authored active-Turn bound, with saturation of that bound as the overturn signal. (B) Keep the text as history.
- Recommendation: A, because a judgment must rest on the current owner.
- Meanwhile: no change.

### Q-252. May the toolchain judgments and maintenance procedure be updated?

- Context: `docs/toolchain.md:32` counts five skips; the base has 16 (13 platform predicates and 3 environment opt-ins), all still decidable before the run. `:79` and `:144` call the app-image leaf the one Node-based host CI exception; two NanoHost build jobs also install the root Node pin (`.github/workflows/ci.yml:763-767`, `:810-814`). `:44` and `:147` name only the NanoHost Rust pin; `packages/retrieval-kernel/mise.toml:2` is a second scope-local pin that shares the test image's `RUST_VERSION`, and `tests/toolchain-version-mirrors.test.mjs` checks only the NanoHost pin. `:67` names two Biome rule exclusions; `biome.json:19` also turns off the recommended `style/noNonNullAssertion` rule (Biome 2.6.6), with no stated reason.
- Options: (A) Correct the two counts, add the Retrieval Kernel pin to the maintenance procedure, and state the `style/noNonNullAssertion` exclusion with its reason or remove it from `biome.json`. (B) Keep the counts, and decide whether the Retrieval Kernel pin may differ from the image.
- Recommendation: A, because the procedure must name every pin that the image mirrors; the mirror test change belongs to a code change.
- Meanwhile: no change (the toolchain guide owns procedure).

### Q-253. Is roadmap item R102 complete?

- Context: R102 (concurrent active Turns) is open. The scheduling specification says the slice is implemented, and the code admits 20 concurrent Turns by default. The roadmap closure rule (`:10`) also needs real-use evidence and owner agreement, and the rc.6 plan records 20 simultaneous starts as known issue #245.
- Options: (A) Mark R102 complete with its evidence. (B) Keep it open until #245 is resolved.
- Recommendation: B, unless the engineer accepts the existing evidence, because the closure rule needs real-use evidence.
- Meanwhile: no change.

### Q-254. Which pilot plans keep a route log?

- Context: `docs/change-execution.md:80` says "The three approved pilot plans keep one". Only `docs/changes/202608120101440001-execution_environment_and_testability_boundary/route-log.md` exists; two other plans have pilot cutover headings without a route log. The governance guide does not name the three pilots.
- Options: (A) Name the pilot plans and state that one route log exists. (B) Remove the pilot statement, because the pilots ended.
- Recommendation: B, because a route log is optional for every other plan and the statement no longer constrains work.
- Meanwhile: no change (governance guides receive editorial fixes only).

### Q-255. Does the researcher contract need leading words?

- Context: `docs/roles/README.md:3` says that each contract states its leading words. `docs/roles/researcher.md` has no such line and never had one; the other six contracts have one at line 10.
- Options: (A) Add leading words to the researcher contract. (B) Make the index sentence exclude the researcher.
- Recommendation: A, because the index states one shape for every contract.
- Meanwhile: no change (role contracts are governance).

### Q-256. May the Retrieval Kernel notice evidence keep a stale digest?

- Context: `packages/retrieval-kernel/notices/README.md:11` labels a table "Current input", but its root `Cargo.toml` digest (`:14`) is the value before `2c00c69eb` changed `Cargo.toml:2`. The other two rows match the base. The table is dated P08 evidence (2026-10-15).
- Options: (A) Relabel the table as the P08 input, which stays true. (B) Rerun the dependency evidence and record the new digests.
- Recommendation: A now, and B at the next notice refresh, because changing a dated digest without a rerun would falsify the evidence.
- Meanwhile: no change.

### Q-257. Which qualification gate does live steer need?

- Context: WCP says that adapter qualification and public receipt retention "must be proved before enabling" `turn.steer`. The Task live steer change (`04b75579e`) enabled it for Codex 0.166.0 and Pi 1.4.0, and `apps/nanocore/src/runtime/README.md` says that both pass the exact-work, race, uncertainty, control and no-spill checks. WCP does not name these checks as the gate. The Task Mode specification already states the qualification rule: its Runtime qualification row (`20260704-task_mode_worker_delegation.md:186`) and `:297` ("Adapter and runtime qualification remain separate").
- Options: (A) WCP links the Task live steer Runtime qualification row as its gate and names the qualified adapters. (B) Keep the sentence and open an issue if the checks do not meet it.
- Recommendation: A, because the evidence exists and the owner must state the gate that the code met.
- Meanwhile: the first sentence is corrected; the gate sentence is unchanged.

### Q-258. May the periphery naming and placement corrections stand?

- Context: the guides used the retired Quick Chat name (P-DOCS-10, P-NC1-09, -16 to -20, P-PKG-09, -15, P-NC2-20, P-NC3-28 to -38) and the former name "Core Permissions" (P-NC1-21, known item). The audit applied the owner names: personal Workspace (`docs/core/work-model.md`, `20260709-quick_chat_workspace.md`), the Assistant `conversation.submit` path ([Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md)) and Core Policy. It also removed a duplicated paragraph from the `lib` guide (P-NC3-27). Code identifiers keep `quickChat` and `quick_chat` (for example `quickChatWorkspaceIdForUser`, `inference.local.quick_chat`, `QUICK_CHAT_AGENT_ID`); round-1 Question Q-04 covers them.
- Options: (A) Keep the corrections. (B) Revert them until Q-04 is answered.
- Recommendation: A, because the owners already use the new names and a guide that quotes a code identifier keeps it.
- Meanwhile: the corrections are applied.

### Q-259. Should guides stop restating facts that other owners hold?

- Context: twenty operation counts in package and app guides were stale; each repeats a definition table. No check covers links or paths in `apps/` and `packages/` guides (`scripts/validate-doc-model.mjs:110`), and test consolidation commits (`e3341e839`, `9c413d8fe`, `832ffadf2`, `f6db6da46`, `d513400dd`) left nine stale test references. The inspector notes also list other restated or historical text in guides: repeated paragraphs within one guide, specification constants restated in `apps/nanohost/README.md`, the Node and pnpm values in the Known Debt of `docs/toolchain.md:189`, execution transcripts in `packages/retrieval-kernel/README.md:137-206`, hand copies of the test image contents and smoke list in `docs/cookbooks/docker-test-env.md`, and historical counts, timing projections and an issue-state snapshot in `docs/cookbooks/release.md:132`, `:328`, `:332-338` and `:342` (see Inspector Notes).
- Options: (A) In one sweep, replace guide counts with the name of the owning table, keep one copy of each repeated paragraph, replace restated constants with links to their owners, move execution transcripts to change records, and extend the link and path check to `apps/` and `packages/` guides. (B) Keep the text and correct it in each change.
- Recommendation: A, because a name cannot drift and a check finds dangling paths. The check is a code change for the engineer to authorize.
- Meanwhile: the audit corrected the stale counts, because a correct count is the smallest change, and left the other restated text unchanged.

### Q-260. Is the private systemd maintenance gate inside the host reservation?

- Context: `docs/toolchain.md:90` reserves the `host` placement for checks that drive Docker or a real worker runtime themselves, plus the one fixed-path NanoHost installer namespace gate. `test:nanohost-maintenance-live` (`package.json:18`) is host-placed since `74db2d467` and drives a rootless private systemd manager, D-Bus and cgroup v2 (`scripts/host-worker-update/README.md:75`). It fits none of the reserved kinds, and `74db2d467` did not change the toolchain guide.
- Options: (A) Amend the reservation to name the private systemd maintenance gate next to the installer namespace gate. (B) Change the placement of the gate.
- Recommendation: A, because the image has no systemd manager or cgroup delegation and the gate fails closed without them.
- Meanwhile: the reservation list does not name the gate; the cookbook states its reason for host placement.

### Q-261. Does the glossary still forbid D-labels?

- Context: `docs/glossary.md:116` tells writers to avoid labels such as "G1, G2, D1, D2, D3, O1". Current guides use D-labels as live identifiers: the structure detectors D1 and D2 (`docs/toolchain.md:128-129`) and the gates D1 to D9 (`docs/roadmap.md:99-109`). No check enforces the row (`docs/writing.md:73`).
- Options: (A) Keep the rule and rename the labels in those guides. (B) Narrow the row to labels without a defining list in the same document.
- Recommendation: B, because a label that its own document defines is unambiguous to a reader.
- Meanwhile: no change.

### Q-262. Does the R2 CI hold instruction in the release cookbook still apply?

- Context: `docs/cookbooks/release.md:357` ends with a temporary instruction ("During the R2 CI hold, do not dispatch branch measurements ..."). It names no owner, tracking task or removal condition, which CODEDOC-002 requires for a temporary solution.
- Options: (A) Remove the instruction if the hold has ended. (B) Keep it and add its owner, task and removal condition.
- Recommendation: A if the hold has ended, else B, because a temporary rule must say when it stops.
- Meanwhile: no change.

## Independent Review

One fresh reviewer read the group diff, this record and the six inspector reports against the base SHA. It confirmed more than 25 changed sentences, the scope and content safety of the diff, more than 15 record rows, the finding total, the Known Items, and the form of Questions Q-251 to Q-259. It returned eleven findings; the auditor verified each against the base SHA and applied all of them:

- WCAD and NRT stated that the Harness Login and Codex host-managed paths are implemented. Production composition installs no Login handler, so both lines now say that the code exists and its production activation remains pending, and Q-215 stays open.
- The `docs/toolchain.md:90` edit had added the maintenance gate to a MUST reservation that does not cover it. The gate is removed from the list, Question Q-260 is added, and the cookbook host line now states the reason for each kind of host gate.
- The R008 edit had rewritten a checked outcome against the roadmap rule. The outcome is restored, with the removal note only.
- P-DOCS-05 is a verified drift; Question Q-252 now carries it.
- WCP and Question Q-257 now name the Pi adapter and cite the Task Mode qualification rule.
- Four guide sentences were still false or ambiguous after the edits: `apps/nanocore/README.md:63` (ordinary Workspace producers inactive), `apps/nanocore/src/storage/README.md:225` (producer locations), `packages/worker-shim/README.md:83` (rc.5 evidence) and `packages/app-api-schemas/README.md:201` (the Conversation table). All four are corrected.
- Record counts, finding citations and line numbers are corrected, and the P-NC1-05 caveat is closed.
- Inspector notes that had no disposition now have one (Inspector Notes), with Questions Q-261 and Q-262.

## Checks

At commit time: `node scripts/validate-doc-model.mjs` passed, `node scripts/generate-doc-index.mjs` regenerated `docs/INDEX.md`, `pnpm check:repo` passed, and the content scan of the staged diff found no email, token, credential path, private host, local absolute path or Vietnamese text.
