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

## Intent Revision 3

The coordinator reassigned the NanoHost Runtime And Transport owner to P02 as its single writer. P02 must integrate the prepared live-inspection amendment exactly as drafted for option C, with the Astra agreement and final P29 consumer draft as source acceptance. Acceptance predicate 26 remains unchanged; a later builder owns only that predicate after this branch merges. Release Management remains with its separate owner through the coordinator. The coordinator now requires merge trains: keep this head rebased, obtain a fresh independent review, push and report the approved head; do not start branch CI. Source: coordinator messages on 2026-10-15.

## Intent Revision 4

The coordinator assigned P02 sole write ownership of docs/decisions/20261015-nanohost_live_operator_inspection.md to resolve the independent review finding. Land the prepared option C record with its owner rule, cite the Astra agreement and P29 proposal as scrutiny sources, keep the P29 interface unchanged and return the corrections to the same reviewer. The runtime-target clause permits the accepted projection; P12 still owns its code. Source: coordinator reply on 2026-10-15.

## Accepted Owners And Boundary

P02 is now the single writer of the NanoHost Runtime And Transport owner and integrates the accepted amendment before dependent implementation. The latest coordinator assignment supersedes the P11 routing in Intent Revision 2. Reuse Deployment Host Requirements' exact machineIdentityDigest algorithm. The consumer response contract remains exact; P02 chooses only its command/IPC spelling, access control, bounds and effective-unit field set as explicitly delegated by that contract. Any interface change goes through the coordinator before implementation. Root compromise is outside the guarantee. Independent reviewer accepts the owner amendment and code; the producer does not adjudicate its own authority artifact.

## Intent Revision 5

The coordinator recorded the live-inspection implementation as approved, directed a rebase onto fcbb9978, and asked P02 to reconcile the collection-test failure with the green main gate. Later instructions identify an exhausted shared temporary-filesystem inode pool and require private temporary roots for every check and helper. The reconciliation below corrects the evidence classification without changing collector behavior. Remaining P02 items use their own bounded execution record. Source: coordinator messages on 2026-10-15.

## Current Checkpoint

The accepted generation is already available at the production outer-session readiness callback. Local coordinator state can retain an ephemeral observation of that exact connection without adding a public protocol or durable owner. Accepted realization: one fixed root-only local Unix inspection entry, invoked by a fixed nanohost inspect command with bounded nonce-only stdin; observation tasks cannot perform runtime effects. Pin and recheck boot/PID/start ticks, live executable handles, current connection binding, installed unit bytes and canonical effective systemd properties around one bounded measurement. Missing or inconsistent proof yields the consumer's closed unavailable envelope. The mechanism must never infer current Epoch from roots, logs, pathname contents or a standalone process.

Named seam: the running coordinator/process and OS observation producer to a nonce-bound local operator response, then P29's separately owned join. A separate test author must derive negative cases from the amended owner and consumer contract before reading implementation. P29 doubles alone cannot establish this producer's correctness. Fixtures use own processes and private paths, not the installed service or running App container.

Next Action: obtain independent exact-head review of the completed producer and its named focused evidence, correct any findings, then push and report the approved head for the merge train. The coordinator recorded the approved owner amendment and directed implementation. The inspection follows that owner and the final consumer response shape; published-host proof remains separate.

## Completion Evidence

Retain exact focused commands/results, independent verdict, candidate head and push result. Keep the approved head rebased on current main; the coordinator gates the combined merge train. P02 starts no branch CI. Report residual real-host and published-artifact proof separately. Record changed-file, owner and closed-vocabulary counts; no new authority is inferred from those counts.

## #227 Checkpoint

The existing local index import wrote its projected layout into the system temporary directory. The correction selects and validates the host manifest without writing, then streams its archive into the existing digest-attributed store staging under the native store lock. Existing capacity accounting, incomplete-entry listing, same-digest verification recovery and exact-digest removal continue to own those bytes. No directory staging lifecycle or metadata migration is added.

The separate test author owned the new image_import_tests.rs file and derived seven composition regressions from the accepted Image Store clauses without reading the implementation diff. The parent inspected the actual tests, took back write ownership, applied formatting and the author's requested child-test execution assertion, and ran them: seven passed. The four existing platform-import regressions passed. A temporary mutation moved projection staging to the configured system temporary directory; the child-local denied-temp regression failed at its intended I/O refusal. The mutation was restored. These observations prove the named staging and refusal cases, not peak-memory usage or real-host image preparation.

The wider image-focused run found three source-boundary checks broken by placing the new test-only module before production code. The module declaration moved beside the existing test-only footer without changing the checks. The final image-focused run passed 66 tests with one existing ignored registry test. Formatting passed. Clippy found one redundant conversion, which was removed; the focused Clippy run with warnings denied then passed. The source slice was independently reviewed, its record correction was approved, and its head was pushed. The coordinator recorded that approved head. No branch CI was started.

## Verification And Remaining Gate

Focused commands ran under the coordinator resource wrapper with one Cargo build worker and one test thread: `cargo test --locked host_platform_index_import -- --test-threads=1` passed four tests; `cargo test --locked image_import_tests -- --test-threads=1` passed seven; `cargo test --locked image_ -- --test-threads=1` passed 66 with one existing ignored external-registry test; `cargo fmt --check` and `cargo clippy --locked --all-targets --all-features -- -D warnings` passed. The denied-temp mutation produced the intended deciding assertion failure and was restored. The new child regression also requires that its exact deciding test ran. No installed service, running App container or host kernel setting changed.

Current owning contracts: [NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md), [Deployment Host Requirements](../../specs/20260909-deployment_host_requirements.md), [Communication](../../core/communication.md) and [Runtime Model](../../core/runtime-model.md). The P29 contract draft and the Astra option C agreement remain source acceptance evidence, not replacement owners. The approved documentation slice integrated the owner before the implementation checkpoint below. Published-host measurement and archive qualification remain separately authorized acceptance work.

The documentation-model validator passed with zero errors. The worktree lacked its Node dependency install, so the check used the byte-identical repository validator and parser from the existing checkout with the pinned Node version; it validated this worktree's documents and wrote no generated output. Raw execution details remain outside the record. The #227 implementation changes six NanoHost files and this one record, touches one behavioral owner, changes no normative owner and adds no durable state shape or registry.

## Live-Inspection Amendment Checkpoint

The current change integrates the exact prepared amendment body into the existing owner and transcribes the already accepted successful response shape. It adds the narrow nullable stored-Epoch correlation exception to the previous App API prohibition and detailed response clause, the matching ownership bullet and the linked accepted decision. The complete acceptance-predicate section, including predicate 26, remains byte-identical. No Release Management, public schema code, production code or runtime behavior changes occur in this slice.

The first consumer seam is the actual allocated connection generation retained from the authenticated readiness callback, available only after the complete acknowledgement and cleared on connection loss. The second seam is the effective-unit digest: lowercase SHA-256 over compact UTF-8 JSON without a newline, sorted property names and string values, with the owner's exact property set and execution normalization. These definitions retain the P29 draft interface; no consumer difference is proposed. The canonical consumer shape now resides in the owning specification and does not depend on this execution record.

The initial amendment changed only this plan and the existing owner. Validation preserved all twelve accepted draft paragraphs, matched the consumer's successful JSON example exactly, preserved the complete acceptance-predicate section and original intent revisions, and passed the documentation-model validator with zero errors. The whitespace check passed. No runtime test was required for this documentation-only slice.

The fresh reviewer requested two corrections: reconcile the older exact runtime-target response clause with the accepted nullable witness, and preserve the trust-boundary choice in a linked decision record. The clause now keeps every prior field and exclusion except the accepted witness exception. The coordinator assigned the new decision record, which records the accepted option C, reasons, alternatives, scrutiny sources and revisit conditions without changing the consumer interface. The same reviewer approved the correction, which was pushed and recorded by the coordinator.

## Live-Inspection Implementation Checkpoint

The coordinator recorded the corrected amendment as independently approved and directed producer implementation. The new local entry retains no durable inspection state. The real coordinator supplies its Epoch and owned Gateway child incarnation; the native transport supplies the verified identity, deployment and allocated generation only after its complete readiness acknowledgement. A connection-lifetime observation clears availability on cancellation and ordinary return; the independently driven physical-connection task clears it on close even when dispatch remains pending. A transition before acknowledgement cannot republish that old binding. The existing member monitor closes inspection before fencing, and coordinator teardown aborts its listener and responses before stopping members.

The fixed CLI reads bounded nonce-only stdin before service initialization. Its client checks both peer UID and the response coordinator incarnation, required consumer semantics, complete framing and nonce, then strips descriptive additions. The producer pins process executable handles, hashes in bounded chunks, and compares process, file, unit and connection observations around the complete measurement. Four blocking measurement slots remain held until their work ends; timeout and teardown abort responses without waiting for those reads. Unit observations request only the accepted non-secret property set through the fixed read with a cleared child environment. The machine read follows the host checker's nonempty, bounded regular-file rule and exact-byte digest. No public schema code or Release Management file changes.

The separate test author derived cases and fixed canonical hash vectors before reading the implementation. The baseline command probe rejected inspect as an invalid argument. The first composition run passed six cases and failed two because unoptimized SHA-256 over the large debug executable took more than the accepted five seconds. An independent timed hash established that cause. The implementation now uses the already locked TLS crypto backend for optimized SHA-256; no bound or expected observation changed. The final ten composition cases passed, including real native acknowledgement, lost acknowledgement, physical close during pending dispatch, same-Epoch successor, cancellation, empty/symlink machine refusal and escaped environment-value refusal. The four actual CLI cases passed, with valid requests only from an unauthorized child UID. These observations do not prove real systemd integration or published-host qualification.

The direct serde and ring dependencies reuse existing locked packages and add no new package version. Serde supplies duplicate-key-refusing bounded JSON admission without another handwritten grammar; ring preserves the accepted deadline while hashing actual executable bytes. The implementation changes ten NanoHost files and this plan, edits no normative owner, preserves the six accepted unavailable reasons and forty effective-unit properties, and adds no durable state or registry.

An initial cancellation-clear mutation passed because physical shutdown could mask the missing cancellation clear. The separate author strengthened that oracle to retain a real H2 sender after session cancellation, complete a transport round trip, and prove the peer remained live before requiring unavailable inspection. The correct implementation passed. The same temporary mutation then failed at that deciding assertion with an incorrect observed result. The mutation was restored, and the final composition run passed all ten tests. No accepted check was weakened.

Final focused evidence under the resource wrapper with one Cargo build worker and one test thread: `cargo test --locked --bin nanohost live_inspection_tests:: -- --test-threads=1` passed ten; `cargo test --locked --test live_inspection_cli -- --test-threads=1` passed four; `cargo test --locked epoch_coordinator::tests:: -- --test-threads=1` passed thirty-eight with one existing privileged-network test ignored; the seventeen exact main-entrypoint tests passed; the three exact native startup-deadline tests passed. `cargo clippy --locked --all-targets --all-features -- -D warnings`, `cargo fmt --check`, documentation-model validation and the whitespace check passed. The complete normative owner remains byte-identical to the approved amendment, including predicate 26.

The wider `nanocore_session::tests::` run passed thirty-nine and failed the existing `h1_r3_real_poll_dispatch_collector_and_sender`: its collection result was effect_failed instead of baseline. An isolated run of that exact test on the approved pre-implementation head also failed with the same result. This is a known baseline finding, not a passing transport-suite claim; its check and unrelated collection code remain unchanged. Independent review must assess the implementation with that residual evidence. No installed service, running App container, host configuration or branch CI was touched.

## Collection-Test Evidence Reconciliation

The raw [fcbb9978 L0-L2 job log](https://github.com/lingkaix/openkit/actions/runs/38722488810/job/116380418422) confirms that the exact collection test executed and passed. The gate calls verify:l0-l2, then test:ci, the release test selector, the NanoHost test script and cargo test. It is not omitted from the gate.

The exact test initially reproduced locally on fcbb9978, but narrowed instrumentation located its refusal in private-store capacity admission before Git initialization. The new private disk-backed temporary filesystem reports zero total and available inodes despite ample available bytes. The accepted collector requires observable free-inode capacity and therefore refuses that environment. This is distinct from the coordinator's earlier shared temporary-filesystem exhaustion; failures in that exhaustion window are not product evidence.

The unchanged exact test on fcbb9978 passed when run in an isolated user and mount namespace with its own private temporary filesystem exposing explicit byte and inode capacity. That fixture was mounted only in the test process namespace, then unmounted; its task-owned directory was removed. No host mount, installed service, container or kernel setting changed. Diagnostic source instrumentation was restored. The result is environment-dependent capacity refusal, not a demonstrated collector defect or a missing CI test. No production resource check, assertion or skip was weakened. Future collection checks must name and satisfy their filesystem-capacity prerequisites under the coordinator's temporary-root rule.
