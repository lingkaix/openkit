---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/rt-2
---
# Automated Component Update Orchestration

## Intent Revision 1

Source: coordinator direction to L-RT on 2026-10-16. Implement P29, Automated NanoHost and Worker update orchestration, as one whole feature on `lane/rt-2` created from `lane/rt`. Reuse the reviewed P29 material in the backlog and the implementation selected for train 3. Follow the recommended engineer rulings. Consult Astra only for a real product design decision. Do not start P25 before P14 lands. Do not contact a1 or a2 or alter the retained App. Keep chunk 1 independently landable. Between work items, check train 3 once; when it lands and the window is free, pause this work and land chunk 1 first.

## Owners And Boundaries

[Release Management](../../specs/20260829-release_management.md#bounded-test-deployment-update) owns the bounded migration-free staging grant, explicit deployment selection, component order, continuity and separate outcomes. [NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md#installed-release-replacement) owns stopped replacement through the unchanged installer, whole-domain fencing, retained inputs, activation prevention, complete payload verification and successor readiness. [Persistent Worker Volumes](../../specs/20260910-persistent_worker_volumes.md#planned-environment-replacement) owns exact preparation, confirmation, drain, activation and unknown-outcome recovery. [App Update Delivery](../../specs/20260910-app_update_delivery.md) owns App assessment and update operations. The accepted [operator replacement decision](../../decisions/20261006-nanohost_installed_release_replacement.md) excludes a new installer replacement mode or always-on updater.

The missing feature is bounded operator orchestration of those existing component owners. It must retain each component's actual identities and result separately, stop before every dependent stage after a failure or unknown effect, and preserve retained bytes and protected accounts. A release assertion does not authorize a migration, reset, changed credential scope or recovery. P14 reset, P25, publication and selected-host release qualification remain separate.

The seam joins published manifest and archive identities, independently observed operator-host facts, App update receipts and Worker preparation/activation. Independent tests must derive expected effects from these owners and exercise failures between components. The existing nonce-bound P02 inspection and public physical-Epoch join remain the host observation owner; process existence or installed bytes alone cannot substitute for running attribution.

## Working Checkpoint

Branch `lane/rt-2` was created from chunk1 head `ee627ee2`. Train 3 has not landed. Its P29 Worker stage, archive attribution, fixed inspection command and native producer fixtures are available in the lane-owned provisional integration checkout for inspection. They are not yet present in this branch's base. Read their actual bytes and the accepted owners before selecting the smallest missing composition. Do not copy or recreate an existing owner.

Known implementation: the Worker stage already prepares and activates once, checks a fresh exact host observation before each effect and requires separate NanoHost replacement evidence. The App composition already uses prepare/preflight/start/status but its standalone CLI refuses because the live identity adapter is absent. No NanoHost replacement stage is present in the earlier P29 directory. Determine which concrete authorized operator adapter and composition can complete the admitted path without a new lifecycle or duplicate installer.

The next material action is to inspect those adapters and define a short call example, fixed effects, stop conditions and decisive tests. Expected result: an owner-aligned implementation boundary rather than a new update service. A necessary new product decision or consequential owner conflict goes to independent Astra scrutiny; routine implementation choices do not.

## Verification And Completion

Use the pinned toolchains, one worker and the shared CPU slot for affected checks. Keep temporary files on disk-backed private storage. An independent test author will own only the selected new test files before implementation at the cross-owner seam. Exact main-based review, generated output, full CI and lane landing occur in the landing window after chunk 1. Fixture evidence proves orchestration and local boundaries; it does not prove published-host acquisition, fencing, retained-work continuation or release qualification.

Report when this whole feature is ready to land or a genuine product decision or blocker requires the coordinator. Preserve unknown outcomes and the saved operation IDs for inspection; no blind retry, automatic rollback or new default target is admitted.

## Direction Check And First Probe

Independent Astra scrutiny in the external P29-consultant-boundary.md permits the narrower external operator CLI under the existing owners; no new product decision or normative amendment is required. Implement one Linux/systemd posture, exact App-first compatibility, operation-owned persistent inhibition, the unchanged installer and separate component evidence. Preserve App-owner recovery, which is not an orchestrator rollback. Restore accepted supervision and measure the same running incarnation and final effective unit digest before successful NanoHost evidence can admit Worker preparation. A temporary restart override cannot become the permanent baseline.

The first decisive probe is the fixed-destination custody seam: real filesystem retention and vacancy with a fault at the first vacancy must leave old bytes protected, activation blocked and no dependent call. An independent test author owns the Python regression and its Node entry point. The builder owns the Python implementation. This can be developed before the train3 base lands without duplicating its existing Worker or inspection producers.

## First Seam Evidence

The independent test author supplied 18 Python methods, including all eight changed-payload subsets and reserved-path, custody, mutation and durability counterexamples. The missing-helper red confirmed missing implementation and was not a product-failure verdict. The real filesystem implementation passes those methods; the Node entry and eight concrete inspection-transport cases pass as well. The transport suite includes fixed deadlines, output overflow, cancellation, target/command refusal and redacted failure. A preliminary independent gpt-6.1-sol review APPROVED these five seam files in the external L-RT-P29-first-seams.md report. It does not accept the missing whole feature or a mutating transport.

The producer replaced the test wrapper's personal cache path with caller TMPDIR; assertions stayed unchanged. Custody remains subject to the accepted exclusive-operator and fenced-writer precondition, and is not a snapshot against later privileged writes. Read-only SSH cancellation is an unknown observation, not proof that the remote process completed. Keep those limits in the full composition.

Train3 landed on main at `79291fa9` while these seams were completed. L-GA holds the window. Chunk1 remains frozen at `ee627ee2`; preserve this P29 work separately while that landing waits for its window. The next P29 work item is the concrete systemd inhibition and fixed privileged procedure, with real isolated-systemd proof required before use. The shipped unit currently uses Restart=always; preserve the accepted observed final policy rather than assuming on-failure or accepting the temporary no-restart baseline.

## Supervisor Predicate In Progress

The next independent Test Author task owns only nanohost-systemd.test.py and its Node entry in the separate P29 worktree. It derives readable guard, typed condition and complete cgroup absence falsifiers before the supervisor implementation. The selected posture and short call example are in the proposal. This read-only predicate is not the mutating inhibition recipe. No real supervisor effect has occurred. The first-seam code is frozen and independently approved; the queued L-RT landing-window acquisition still waits for L-GA while this disjoint work continues.


The read-only supervisor predicate now passes its independently authored 25 Python methods through the Node entry. The first implementation run failed the new-sibling-at-final-query case; the corrected predicate refreshes guard and kernel facts after that query. Both results are retained externally as P29-systemd-predicate-green.log (first failure) and P29-systemd-predicate-final.log (pass). No assertion was weakened. The missing-module red was collected before production appeared. Complete live manager search-path admission and real isolated-systemd inhibition proof remain absent, so this seam does not authorize replacement effects.
