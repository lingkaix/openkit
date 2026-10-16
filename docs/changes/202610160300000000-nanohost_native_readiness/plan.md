---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/rt
---
# NanoHost Native Readiness Repair

## Intent Revision 1

Source: engineer dispatch to lane L-RT on 2026-10-16. Diagnose the published rc.8 NanoHost readiness failure on dev for issue #248, correct the proved cause against the train-3 baseline, add the lowest sufficient regression, and verify one locally built branch binary on dev. Land through the lane window, exact-head independent review and full CI. Leave NanoHost stopped. Do not change the retained App, host kernel settings, or a1/a2. Host data is unimportant under the engineer's direction. Published-artifact acceptance remains separate from local-build verification.

## Intent Revision 2

Source: coordinator direction on 2026-10-16 after accepting the certificate root cause. Select the corrected issuer CA and verify the exact published rc.8 NanoHost on dev. Retain it only while healthy and ready so ops can continue #242. Trace the original certificate source and correct any product or document path that can produce it. Keep eager TLS verification and the explicit cause. Include chunk 1b: unavailable Btrfs inode counts must not become zero capacity; preserve strict byte checks and add regressions. Land both repairs together or consecutively.

## Intent Revision 3

Source: coordinator authorization after the first published attempt hit its retained rebuild-bound hold. Retain complete old epoch state outside its live names, then start from fresh state. Never delete a marker in isolation. Up to three published attempts in total are authorized, each after whole-state retention and only when it can teach a new fact. Dev data is disposable under engineer direction. Inspect recovery guidance and document the operator procedure if missing.

## Intent Revision 4 — Installer Scope And P29 Work Order

Source: coordinator direction on 2026-10-16. Stop polling train3 in a loop. Include D-RT-3 in chunk1: the installer must judge systemd verification diagnostics for OpenKit units and the exit status, ignore unrelated-unit diagnostics, and retain fatal OpenKit errors with regressions. Confirm D-RT-4 whole-state rebuild-bound recovery is documented. Then create lane/rt-2 from lane/rt and implement P29 as one feature; P25 waits for the P14 cutover on main. Check train3 only between work items with one fetch, window status and its landed merge-queue line. When train3 lands, pause P29 and land chunk1 independently under the recorded protocol. Keep command temporary files under the disk-backed cache and remove owned temporary directories when finished.

## Owners And Boundaries

[NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md) owns verified TLS, the physical session, admission, readiness and startup limits. [Runtime Model](../../core/runtime-model.md) owns substrate lifecycle and [Communication](../../core/communication.md) owns transport principles. [Test Strategy](../../specs/20260529-test_strategy.md) and [Verification Instruments](../../verification-instruments.md) own regression scope and deciding evidence. This repair restores accepted behavior and adds no transport fallback or authentication authority.

The current seam is the Rust TLS byte adapter and the native Node HTTPS/H2 listener. Existing real-route regression fixtures will be reused where they can observe the defect. A real dev-host run must prove exact-pair positive readiness and complete predecessor-group absence. Credential-free listener reachability is a separate observation.

## Rewritable Checkpoint

The credential-free Rust probe proved that the original dev listener presented a CA as its server leaf. The published source and lane base have identical transport code. H2 driver completion discarded the verification error, and the initial session retried physical closes until startup expired. P02 adds inspection but leaves this path unchanged. Eager verification now preserves the closed TLS cause. Initial transport refusal also invokes the existing startup invalidation owner before returning.

Ops corrected the retained App certificate. L-RT selected its issuer CA after strict verification. Published attempt 1 exited before TLS because the prior rebuild interval had expired. After whole-state retention, published attempt 2 reached fresh generation 1 with the exact configured pair and all readiness booleans true. The published NanoHost stayed healthy until the controlled local-build check described below. Two published attempts occurred. Their published-artifact evidence remains separate from the later local-build evidence. The initial collector observed readiness, then failed on a binary journal message; independent reads recovered the same running attempt without another start. Three structural comparisons pass. This is readiness evidence, not Worker or full release qualification.

The Btrfs capacity fix shares one inode reserve interpretation between volume seeding and Workspace collection. Both still enforce their existing byte checks and finite inode reserves. Synthetic and real-consumer regressions failed before the correction and now pass. The independent test author has released all test paths. Train 3 is now on main; the final main-based verification is recorded below. Raw evidence and the live checkpoint stay in the external lane evidence directory.

The original certificate matches the setup receipt and came through an operator bind mount outside the product checkout. It is a CA with a loopback SAN and no serverAuth or key-usage extension. The installer installs no TLS material; the App loads operator-supplied certificate files. The shipped Skill references and named deployment/host manuals contain no certificate-generation recipe. This attributes the invalid shape to ad hoc dev listener configuration, not a product certificate generator. The exact original creation command is not retained in repository evidence. The manuals now identify the required leaf/issuer roles and provide the previously missing whole-state recovery procedure.

The combined reviewer found that retaining complete epoch roots could hide the observation flags previously used to release old retained-volume attachment hints. Startup already proves the complete prior process group absent. The correction makes production store opening use that proof and the existing release owner regardless of root or marker presence, while preserving bytes and association lineage. Core settlement remains separate. The independent real retained-store regression failed with the old generation-three attachment still present. With the release call, it preserves all retained metadata except the attachment hint, then attaches the same retained bytes at generation four.

## Verification And Closeout

The independent test author observed the intended red: no HTTP request or RuntimeTarget, but the generic `outer-session admission response failed` cause. After correction, all nine native TLS tests pass. The preliminary reviewer found missing startup invalidation evidence. A real `run_sessions` regression then failed with zero reports instead of one; the caller now invokes that existing owner. These tests cover the real TLS/H2 seam and the initial caller path without a deployed host.

Before the capacity correction, the full NanoHost run recorded 265 passed, 68 failed and three existing ignored tests. The dev Btrfs filesystem reports all three inode counts as zero despite sufficient free bytes. The admitted chunk 1b corrects that interpretation. Eight new capacity regressions pass, including actual seed/collection writes and byte-reserve and overflow refusals. After the retained-attachment correction, the full suite passes 343 unit tests and three service/version integration tests, with three existing tests ignored. Exact-head full CI remains required.

The affected NanoCore suites pass 23 tests; its typecheck and focused Biome check pass. Cargo formatting and Clippy pass after the capacity amendment. Documentation validation and index checks pass. The Skill interface and public-redaction suites pass all 87 tests. The final branch is rebased onto main after train 3. Exact-head review, full CI and landing receipts are retained externally. No Worker acceptance is claimed.

## Provisional Integration And Local Runtime Evidence

A frozen merge of train 3 head `41830d22` and lane repair `b6e38228` produced provisional source `14996ba1`. The one TLS test conflict kept the verification-rejection helper and supplied P02's inspection-state argument. On that complete tree, 371 unit tests and seven integration tests pass, with three existing ignored tests. Cargo formatting and Clippy, NanoCore typecheck and focused lint pass. The probe changes stay within the lane's runtime, test and documentation paths. The primary lane branch was later rebased onto main after train 3, retaining this TLS test resolution.

The locally compiled debug NanoHost from `14996ba1` passed one controlled real dev start at 06:31 UTC. It reached fresh exact-pair RuntimeTarget generation 2 with all readiness flags true. Three positive observations, the same live executable hash, one actual unit start and unchanged Docker bridge, canonical nftables and App container attachments were proved. Both complete prior epoch roots and the published payload were retained before replacement. The same healthy local candidate remains running, with its temporary restart override removed, under the coordinator's final-state direction. This is not the published rc.8 artifact and does not qualify a Worker or release.

The new CLI's read-only RuntimeTarget query refused the retained App with `incompatible_contract`. The instrument uses a frozen CLI that accepts the current App's query contract; product compatibility behavior stays unchanged. Another preflight refused the instrument's incorrect top-level slice assumption before any host effect. The corrected reader uses the actual nested slice, proves live main-process membership, and detects the running predecessor as populated before accepting the later empty-slice proof. These setup refusals consumed no service starts. Ops received the local artifact identity and the completed maintenance result.

The external build and runtime receipts bind source `14996ba1`, the executable SHA, observer SHA and build-input blobs. The final comparison confirms that all 19 recorded production dependency blobs, Cargo declarations and lockfile, pinned Rust toolchain, OpenShell pin and host profile match the provisional build. The whole-app comparison excludes only the README, separate installer script and cfg(test)-only epoch inventory fixture. It detects additional app inputs as a refusal. The running candidate was built on the provisional source, not the final Git head. A read-only final refresh confirms the same executable and process, generation 2 readiness, zero restarts and restored Restart=always. Exact-head review, full CI and landing receipts remain external.

## Installer Diagnostic Scope And Recovery Guidance

D-RT-3 reproduces at the real systemd observer boundary: verification returns zero with a dnsmasq drop-in warning, but the old parser reports `unitParses=false`. The checker now ignores diagnostics attributed to other units and keeps diagnostics that refer to the OpenKit service, slice or required parent, including exact-name, dash-prefix and type-wide drop-ins and references from another unit. Unattributed errors, inspector failures and nonzero status remain blocking, with the existing exact missing-executable exception for an uninstalled archive. Both stdout and stderr use the same attribution rule. [Deployment Host Requirements](../../specs/20260909-deployment_host_requirements.md) owns this criterion. All 131 focused installer, packaging and host-manifest cases pass, with zero failures or skips. After the inherited-drop-in corrections, the eight-case host-profile suite, focused Biome, shell syntax and documentation checks pass as well. Independent review found the dash-prefix and parent-slice cases; real-observer regressions reproduced their false passes before correction. No profile requirement or service effect changes. These local regressions do not qualify a1, and L-RT makes no a1/a2 contact.

D-RT-4 is covered by the committed [rebuild-bound recovery manual](../../../skills/openkit-ops/references/nanocore-operations.en.md#recover-a-nanohost-at-the-rebuild-bound): stop and prove the complete slice empty, retain both complete epoch roots with the marker inside, preserve epoch-external stores and identity, create fresh state through normal startup and verify a new exact-pair ready target. It explicitly forbids deleting the marker alone and disables automatic restart before a controlled start. The earlier independent recovery review inspected that procedure.

## Complexity Snapshot

The current repair changes 22 files and four owning specifications across four owners. It adds no production registry, lifecycle or closed set. The test peer adds a two-role certificate choice and one observation query. Final main-based counts remain 22 files and four owning specifications. Closure evidence is retained externally to avoid a self-referential head claim.


## Final Main-Based Gates

The branch is rebased onto main `ee85d063`, which contains train 3 `79291fa9`. The one test conflict retained eager-verification regressions and P02 inspection-state arguments. Frozen dependency installation, affected dependency builds, OpenAPI generation and validation, and CLI regeneration pass with no generated drift. `check:repo` passes, including 513 documentation records and the checked index. NanoCore typecheck and module lint pass; its three affected suites pass 23 tests. The eight focused installer, host-manifest, packaging, Skill-interface and redaction suites pass 221 tests with no failures or skips. Cargo formatting and Clippy pass. The full NanoHost suite passes 371 unit tests and seven integration tests with zero failures and three existing ignored tests. Named external logs are final-main-node.log and final-main-cargo.log. The external exact-head review and full-CI run complete the lane landing gate.
