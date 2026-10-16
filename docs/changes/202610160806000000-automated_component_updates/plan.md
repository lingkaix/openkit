---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/rt-2
---
# Automated Component Update Orchestration

## Intent Revision 1

Source: coordinator direction to L-RT on 2026-10-16. Implement P29, Automated NanoHost and Worker update orchestration, as one whole feature on `lane/rt-2` created from `lane/rt`. Reuse the reviewed P29 material in the backlog and the implementation selected for train 3. Follow the recommended engineer rulings. Consult Astra only for a real product design decision. Do not start P25 before P14 lands. Do not contact a1 or a2 or alter the retained App. Keep chunk 1 independently landable. Between work items, check train 3 once; when it lands and the window is free, pause this work and land chunk 1 first.

## Intent Revision 2

Source: later coordinator direction on 2026-10-16. Chunk1 landed; prioritize urgent D-RT-5 transport diagnosis and its scoped landing before resuming P29 production. The transport repair may land with Worker acceptance explicitly blocked on separate provider subscription setup. After that landing, continue P29. P25 still waits for P14.

## Owners And Boundaries

[Release Management](../../specs/20260829-release_management.md#bounded-test-deployment-update) owns the bounded migration-free staging grant, explicit deployment selection, component order, continuity and separate outcomes. [NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md#installed-release-replacement) owns stopped replacement through the unchanged installer, whole-domain fencing, retained inputs, activation prevention, complete payload verification and successor readiness. [Persistent Worker Volumes](../../specs/20260910-persistent_worker_volumes.md#planned-environment-replacement) owns exact preparation, confirmation, drain, activation and unknown-outcome recovery. [App Update Delivery](../../specs/20260910-app_update_delivery.md) owns App assessment and update operations. The accepted [operator replacement decision](../../decisions/20261006-nanohost_installed_release_replacement.md) excludes a new installer replacement mode or always-on updater.

The missing feature is bounded operator orchestration of those existing component owners. It must retain each component's actual identities and result separately, stop before every dependent stage after a failure or unknown effect, and preserve retained bytes and protected accounts. A release assertion does not authorize a migration, reset, changed credential scope or recovery. P14 reset, P25, publication and selected-host release qualification remain separate.

The seam joins published manifest and archive identities, independently observed operator-host facts, App update receipts and Worker preparation/activation. Independent tests must derive expected effects from these owners and exercise failures between components. The existing nonce-bound P02 inspection and public physical-Epoch join remain the host observation owner; process existence or installed bytes alone cannot substitute for running attribution.

## Intent Revision 3

Source: coordinator update on 2026-10-16 and the delegated current lane brief. Use Landing protocolv2: merge main, generate, run gates, get independent exact-head review, push and run fullCI before acquiring the window. Unedited clean main merges can reuse the reviewed head under land.sh's sixth argument. Land D-RT-5 separately, commit and push lane work at least hourly, and use the permitted independent helper worktrees while the landing CI runs. The current brief permits two gpt-6.1-sol helpers. P25 still waits for P14.

## Intent Revision 4

Source: coordinator update on2026-10-16 12:55Z. Express landing is the default: independent approved exact-head review, push, exact committed local-gate, acquire, clean-main-merge/local-gate exception, express landing and main-push verification with immediate reviewed repair if needed. Cancel queued branch CI for express candidates. CI/workflow and scripts/release changes retain protocolv2 exact-head fullCI; this feature changes the existing App release-update script, so it keeps that route. D-RT-5 uses express landing first.

## Working Checkpoint

The separate D-RT-5 transport repair landed on main `5c75b9890e54d3ada9b57f406a018e69aaf2fd37`; its exact main-push CI passed. P29 merged that head and the subsequent Web landing cleanly. OpenAPI and CLI regeneration passed with unchanged output. The transport real-host candidate remains separately attributed; P29 has no selected-host execution authority.

The whole App→NanoHost→Worker composition, concrete CLI/live/root adapters and NanoHost producer are implemented. The final whole affected-module run passed495cases, including all existing App update, CLI and Skill interface tests. The final explicit host command passed its Node entry and all four real systemd cases. The independently authored supervisor suite now has27methods after the stock failed-state correction; its custody and maintenance peers have18and29. The earlier288/65/78runs remain narrower evidence. All final deciding suites have zero failures or skips. Earlier dependency, missing temporary-directory and wrong result-path observations were setup or test-instrument failures; production assertions were not weakened. Frozen offline own-worktree dependency installation is complete. Actual provider inference, retained-work continuation and release qualification are not claimed.

The fixed privileged procedure uses the unchanged installer, complete payload checks, private retained-input comparisons and existing native inspection. A controlled start is one effect. The live adapter waits on public pending-readiness observations, then asks a separate fixed read-only subphase for exactly one native baseline inspection. The composition then performs its separate unpredictable-nonce/server join against that baseline; finalization similarly supplies the restored baseline before the final join. Any unavailable native sample stops before another sample or effect, without refresh. Finalization restores stock supervision for the same process and supplies the final digest used by Worker admission. This corrects the earlier proposed native-inspection startup poll, which would conflict with Release Management's unavailable-observation rule.

Both implementation helpers finished and their branches were merged. The isolated real systemd gate passed all four cases with actual whole-slice and sibling stop, durable retention before first vacancy, partial activation refusal across daemon reexec and a fresh private PID1 with empty tmpfs run state, one consumed start permit, refused second start, retained failed-start custody, same-process stock-supervision restoration and lost-final-reload reply refusal. Every private cgroup and filesystem root was removed. This exposed the stock stop's failed/failed state; its lowest regression failed before correction and passed after the predicate admitted that exact stopped pair while preserving all process, guard and kernel checks. The supervisor, maintenance and host-procedure wrappers passed after correction. Independent review inspected the actual four-case output and exact source hashes and settled the real-proof objection. No retained dev/a1/a2 service was used by P29. Synthetic target publication in this gate is separate from the real archive/staging-installer cases; it proves neither selected-host readiness nor power-loss durability.

The first fullCI root shard failed because operator fixtures used a public temporary parent, which the actual protected-file reader correctly refuses before the intended cases. The fixture now uses an owned protected cache root, and an explicit unsafe-parent refusal remains. A frozen original case reproduces the refusal under a disposable world-writable temporary parent; all79current adapter/CLI/component cases pass under that same temporary environment. Production admission is unchanged. The remaining work is exact-head delta review, repository recheck and new fullCI before landing. The final explicit host-placed live gate passed after formatting the entry, and check:repo completed successfully with three warnings and31infos, no errors or fixes. OpenAPI generation/validation passed. The generated CLI changes because it embeds the root package manifest, which adds the explicit host-gate command; comparing both build graphs found226inputs with only that manifest changed. The source guide and operator manual are being aligned with the implemented posture and unknown-outcome recovery. No new deployment registry, updater service, recovery lifecycle, automatic replay or payload rollback is introduced.

## Verification And Completion

Use the pinned toolchains, one worker and the shared CPU slot for affected checks. Keep and clean owned disk-backed temporary roots. Required deciding checks inspect actual implementation bytes and named execution output; fixture or producer reports alone cannot accept the host recipe. Prepare the final main-based review, generated output and fullCI outside the landing window under protocolv2. Acquire only green and follow its clean-main-merge rule if main moves. Fixture evidence proves only its named operator and filesystem boundaries; selected-host acquisition, retained-work continuation and release qualification remain separately authorized.

Report when the feature is ready to land or a genuine product decision or blocker requires the coordinator. Preserve unknown outcomes and existing operation IDs for inspection. No blind retry, automatic rollback, default target or unauthorized selected-host execution is admitted.

## Direction Check And First Probe

Independent Astra scrutiny in the external P29-consultant-boundary.md permits the narrower external operator CLI under the existing owners; no new product decision or normative amendment is required. Implement one Linux/systemd posture, exact App-first compatibility, operation-owned persistent inhibition, the unchanged installer and separate component evidence. Preserve App-owner recovery, which is not an orchestrator rollback. Restore accepted supervision and measure the same running incarnation and final effective unit digest before successful NanoHost evidence can admit Worker preparation. A temporary restart override cannot become the permanent baseline.

The first decisive probe is the fixed-destination custody seam: real filesystem retention and vacancy with a fault at the first vacancy must leave old bytes protected, activation blocked and no dependent call. An independent test author owns the Python regression and its Node entry point. The builder owns the Python implementation. This can be developed before the train3 base lands without duplicating its existing Worker or inspection producers.

## First Seam Evidence

The independent test author supplied 18 Python methods, including all eight changed-payload subsets and reserved-path, custody, mutation and durability counterexamples. The missing-helper red confirmed missing implementation and was not a product-failure verdict. The real filesystem implementation passes those methods; the Node entry and eight concrete inspection-transport cases pass as well. The transport suite includes fixed deadlines, output overflow, cancellation, target/command refusal and redacted failure. A preliminary independent gpt-6.1-sol review APPROVED these five seam files in the external L-RT-P29-first-seams.md report. It does not accept the missing whole feature or a mutating transport.

The producer replaced the test wrapper's personal cache path with caller TMPDIR; assertions stayed unchanged. Custody remains subject to the accepted exclusive-operator and fenced-writer precondition, and is not a snapshot against later privileged writes. Read-only SSH cancellation is an unknown observation, not proof that the remote process completed. Keep those limits in the full composition.

Train3 landed on main at `79291fa9` while these seams were completed. At that historical checkpoint L-GA held the window and chunk1 was frozen at `ee627ee2`; chunk1 has since landed and the current transport priority is recorded above. The next P29 work item is the concrete systemd inhibition and fixed privileged procedure, with real isolated-systemd proof required before use. The shipped unit currently uses Restart=always; preserve the accepted observed final policy rather than assuming on-failure or accepting the temporary no-restart baseline.

## Supervisor Predicate In Progress

The next independent Test Author task owns only nanohost-systemd.test.py and its Node entry in the separate P29 worktree. It derives readable guard, typed condition and complete cgroup absence falsifiers before the supervisor implementation. The selected posture and short call example are in the proposal. This read-only predicate is not the mutating inhibition recipe. No real supervisor effect has occurred. The first-seam code is frozen and independently approved; the queued L-RT landing-window acquisition still waits for L-GA while this disjoint work continues.


The read-only supervisor predicate now passes its independently authored 25 Python methods through the Node entry. The first implementation run failed the new-sibling-at-final-query case; the corrected predicate refreshes guard and kernel facts after that query. Both results are retained externally as P29-systemd-predicate-green.log (first failure) and P29-systemd-predicate-final.log (pass). No assertion was weakened. The missing-module red was collected before production appeared. Complete live manager search-path admission and real isolated-systemd inhibition proof remain absent, so this seam does not authorize replacement effects.


## Scope And Qualification Limits

The feature changes43files relative to current main, including two owning specifications. Four existing owners govern the composition: Release Management, NanoHost Runtime And Transport, App Update Delivery and Persistent Worker Volumes. The finite wrapper introduces closed invocation/artifact/result envelopes, six fixed host actions,14step-refusal categories and four identity-refusal categories. Its API allowlist contains12existing operations and its privileged source allowlist contains four checkout files. It adds no product registry, public operation, retained lifecycle, resident controller or installer replacement mode.

The tests qualify their named local process, filesystem, native-inspection, archive/staging-installer, real private-systemd and doubled public-API boundaries. No selected staging deployment update or Worker/provider Turn is performed under this change. Such execution needs its existing deployment grant and component prerequisites; fixture success supplies no grant, retained-work continuation, release qualification, kernel-reboot or power-loss claim.


## Cold Preparation Deadline Correction

The public Worker preparation operation waits for image acquisition and inspection. The runtime permits fifteen minutes for registry acquisition, and the separate D-RT-5 diagnostic observed91.3seconds of preparation. The new adapter had incorrectly applied its ordinary thirty-second request window to this synchronous mutation. The lowest mock-timer regression failed on that old adapter after90seconds, with six existing cases passing. Worker preparation now has a finite thirty-minute client window; other operations retain thirtyseconds. Deadline, transport loss and incomplete responses remain unknown without replay or automatic recovery. The cookbook now points to the concrete external command and its existing owner boundaries. Corrected-source validation passed all7APIcases and all500affected ordinary cases with zero failures or skips, plus focused Biome and the repository check. Independent exact-head delta review and fullCI remain required.


## Hosted CI Context Findings

The next exact-head fullCI on7185fced observed four failures before cancellation to release runner capacity. Both Worker image smoke builds refused an unavailable upstream dependency: the selected `@deepseek-ai/cordis-plugin-loader@1.0.6` requires `@deepseek-ai/schemastery@~3.18.5`, but the anonymous registry has no matching stable version. The image and workflow bytes are unchanged from main. This supply blocker was reported to the coordinator for OPS. The root shard passed1478cases and failed28operator-live fixture constructors; the protected input fixture correction is insufficient to qualify checkout-source ancestry. A controlled hostile-checkout probe and test-context correction remain required. The native shard passed379unitcases and failed one real Node fixture startup at its15-second setup bound, before TLS admission. The NanoHost test runner must enforce the existing one-worker execution rule without changing the startup or product deadlines. No hosted result overrides these observed failures; the corrected exact head requires new review and fullCI.


Both CI-context corrections are merged from isolated helper branches. Operator tests retain unchanged runtime sources once beneath protected fixture ownership, keep only the dependency link outside custody, compare the privileged source bytes and require the original constructor to refuse an unsafe checkout ancestor before any adapter. The NanoHost package test command now selects one test thread by default; no startup bound, product deadline, TLS assertion or production admission changes. Controlled hostile-checkout red/green, integrated default-command Cargo verification, repository checks and final independent review are pending on this corrected source.


The upstream supply failure cleared without a product change. A later anonymous registry read records publication of `schemastery@3.18.5` at13:49:43Z, after the smoke jobs failed around13:45Z. The unchanged runtime dependency selection then resolved successfully; no loader override or native version change is proposed. The operator fixture initially omitted its module-relative image catalog and stopped in setup; that output is not a deciding red or green. Its retained source tree now includes the unchanged catalog, and corrected controlled runs remain pending.
