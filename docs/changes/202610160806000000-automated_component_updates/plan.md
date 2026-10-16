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

## Working Checkpoint

The separate D-RT-5 transport candidate is frozen on `lane/rt`; exact reviewed-head fullCI passed, then a clean unedited main merge and unchanged OpenAPI/CLI regeneration produced head `5e3e1a078878b253f060808e063c77e4feeda53f`. Its second fullCI passed on that exact head, and the landing-window acquisition is queued. P29 remains independently prepared on `lane/rt-2`, which already merged the reviewed transport source and train3 producers. Merge the final landed transport/main head before this feature's own landing.

The whole App→NanoHost→Worker composition, concrete CLI/live/root adapters and NanoHost producer are implemented. The current combined run passed288cases; the separate native/archive/custody run passed65cases, including real P02 process images and the72 separately authored Python methods. Merged CLI/live/component suites passed78cases. These runs have zero failures or skips. Earlier dependency, missing temporary-directory and wrong result-path observations were setup or test-instrument failures; production assertions were not weakened. Frozen offline own-worktree dependency installation is complete. Actual provider inference, retained-work continuation and release qualification are not claimed.

The fixed privileged procedure uses the unchanged installer, complete payload checks, private retained-input comparisons and existing native inspection. A controlled start is one effect. The live adapter waits on public pending-readiness observations, then asks a separate fixed read-only subphase for exactly one native baseline inspection. The composition then performs its separate unpredictable-nonce/server join against that baseline; finalization similarly supplies the restored baseline before the final join. Any unavailable native sample stops before another sample or effect, without refresh. Finalization restores stock supervision for the same process and supplies the final digest used by Worker admission. This corrects the earlier proposed native-inspection startup poll, which would conflict with Release Management's unavailable-observation rule.

The CLI helper finished and its branch was merged. Independent whole-source review found no actionable production defect and retained changes-requested only for the missing actual systemd proof. The other helper owns the two explicit private-systemd fixture files; its committed draft is merged. The real private bus and manager now register, and the stock predecessor unit starts after a private required-socket placeholder. Observer containment for the real sibling-scope probe is being corrected. Each completed private cgroup and filesystem root was removed. No actual inhibition PASS exists yet, and source/manual publication remains blocked on that proof. No retained dev/a1/a2 service is used by P29.

The remaining work is real isolated-systemd inhibition/reexec/permit/finalization proof, final source/fixture delta review, documentation checks and exact-head fullCI. OpenAPI generation/validation passed. The generated CLI changes because it embeds the root package manifest, which adds the explicit host-gate command; comparing both build graphs found226inputs with only that manifest changed. The source guide and operator manual are being aligned with the implemented posture and unknown-outcome recovery. No new deployment registry, updater service, recovery lifecycle, automatic replay or payload rollback is introduced.

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
