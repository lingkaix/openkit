---
type: change-plan
status: in-progress
date: "2026-10-15"
branch: rc8/p02-nanohost-transport
---
# NanoHost Image Import And Live Inspection

Status: active; design accepted by the coordinator. Updated: 2026-10-15. This record supplies no design authority.

## Intent Revision 1

The coordinator accepted P29 option C with Astra Consultant agreement and assigned P02 the live NanoHost inspection and NanoHost owner amendment after #227. Source: the coordinator messages, consultant-wave1.md section P29 host observation, P29-host-observation-proposal.md option C and P29-host-observation-contract.md. The inspection answers from the running coordinator, binds one caller nonce to process incarnation, live physical Epoch and current authoritative connection, and measures the machine digest, running NanoHost/Gateway executable images and effective unit state. It is read-only operator maintenance. No public host-control API, runtime SSH fallback, automatic repair or live-host contact is authorized. P12 owns stored public Epoch correlation; P29 owns orchestration and verified archive attribution.

## Intent Revision 2

The coordinator assigned P02 sole write ownership of this directory's plan.md only, bounded to #227 and live inspection. Owner amendments go through P11; the earlier direct owner-edit grant no longer applies. The P29 Host Observation Consumer Contract draft is the target interface; any interface change must go through the coordinator before implementation. Source: coordinator follow-up messages on 2026-10-15. The Astra agreement for option C accepts the exact nonce/process/executable/unit/current-connection join and leaves published-host proof separate.

## Accepted Owners And Boundary

P11 amends docs/specs/20260802-nanohost_runtime_and_transport.md before dependent live-inspection implementation. P02 supplies the concrete amendment request and implements its accepted inspection boundary. Reuse Deployment Host Requirements' exact machineIdentityDigest algorithm. The consumer response contract remains exact; P02 chooses only its command/IPC spelling, access control, bounds and effective-unit field set as explicitly delegated by that contract. Any interface change goes through the coordinator before implementation. Root compromise is outside the guarantee. Independent reviewer accepts the owner amendment and code; the producer does not adjudicate its own authority artifact.

## Current Checkpoint

The accepted generation is already available at the production outer-session readiness callback. Local coordinator state can retain an ephemeral observation of that exact connection without adding a public protocol or durable owner. Proposed realization: one fixed root-only local Unix inspection entry, invoked by a fixed nanohost inspect command with bounded nonce-only stdin; observation tasks cannot perform runtime effects. Pin and recheck boot/PID/start ticks, live executable handles, current connection binding, installed unit bytes and canonical effective systemd properties around one bounded measurement. Missing or inconsistent proof yields the consumer's closed unavailable envelope. The mechanism must never infer current Epoch from roots, logs, pathname contents or a standalone process.

Named seam: the running coordinator/process and OS observation producer to a nonce-bound local operator response, then P29's separately owned join. A separate test author must derive negative cases from the amended owner and consumer contract before reading implementation. P29 doubles alone cannot establish this producer's correctness. Fixtures use own processes and private paths, not the installed service or openkit-rc6 container.

Next Action: finish and independently review #227, submit the concrete owner amendment to P11 through the coordinator, then derive inspection tests and implement the accepted fixed local read. Verification covers replacements, access refusal, nonce grammar, same-Epoch reconnect and unavailable results. Evidence that the local generation or owned Gateway process cannot be identified would stop the dependent implementation and return that seam to the coordinator. CI remains on hold until green main is announced.

## Completion Evidence

Retain exact focused commands/results, independent verdict, candidate head and push result. Rebase and run the full gate only after the CI hold is released. Report residual real-host and published-artifact proof separately. Record changed-file, owner and closed-vocabulary counts; no new authority is inferred from those counts.

## #227 Checkpoint

The existing local index import wrote its projected layout into the system temporary directory. The correction selects and validates the host manifest without writing, then streams its archive into the existing digest-attributed store staging under the native store lock. Existing capacity accounting, incomplete-entry listing, same-digest verification recovery and exact-digest removal continue to own those bytes. No directory staging lifecycle or metadata migration is added.

The separate test author owned the new image_import_tests.rs file and derived seven composition regressions from the accepted Image Store clauses without reading the implementation diff. The parent inspected the actual tests, took back write ownership, applied formatting and the author's requested child-test execution assertion, and ran them: seven passed. The four existing platform-import regressions passed. A temporary mutation moved projection staging to the configured system temporary directory; the child-local denied-temp regression failed at its intended I/O refusal. The mutation was restored. These observations prove the named staging and refusal cases, not peak-memory usage or real-host image preparation.

The wider image-focused run found three source-boundary checks broken by placing the new test-only module before production code. The module declaration moved beside the existing test-only footer without changing the checks. The final image-focused run passed 66 tests with one existing ignored registry test. Formatting passed. Clippy found one redundant conversion, which was removed; the focused Clippy run with warnings denied then passed. Independent review and branch push follow; no CI starts during the coordinator hold.

## Verification And Remaining Gate

Focused commands ran under the coordinator resource wrapper with one Cargo build worker and one test thread: `cargo test --locked host_platform_index_import -- --test-threads=1` passed four tests; `cargo test --locked image_import_tests -- --test-threads=1` passed seven; `cargo test --locked image_ -- --test-threads=1` passed 66 with one existing ignored external-registry test; `cargo fmt --check` and `cargo clippy --locked --all-targets --all-features -- -D warnings` passed. The denied-temp mutation produced the intended deciding assertion failure and was restored. The new child regression also requires that its exact deciding test ran. No installed service, running App container or host kernel setting changed.

Current owning contracts: [NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md), [Deployment Host Requirements](../../specs/20260909-deployment_host_requirements.md), [Communication](../../core/communication.md) and [Runtime Model](../../core/runtime-model.md). The P29 contract draft and the Astra option C agreement remain source acceptance evidence, not replacement owners. Live-inspection implementation waits for P11's amendment. Published-host measurement and archive qualification remain separately authorized acceptance work.

The documentation-model validator passed with zero errors. The worktree lacked its Node dependency install, so the check used the byte-identical repository validator and parser from the existing checkout with the pinned Node version; it validated this worktree's documents and wrote no generated output. Raw execution details remain outside the record. The implementation changes six NanoHost files and this one record, touches one behavioral owner, changes no normative owner and adds no durable state shape or registry.
