---
type: change-plan
status: verified
---
# Governed Domain Pages And Retrieval

## Intent

Deliver C05 as one additive feature after the pre-reset cut, before rc.11: official Rule, Effect and business Objective domain types, required declared metadata and native/KM type/applicability selection. The accepted [consolidation owner](../../specs/20261018-nanocore_interception_and_information_consolidation.md#information-and-record-authority), [Notebook owner](../../specs/20260909-knowledge_notebook_editing.md) and [Knowledge](../../core/knowledge.md) govern this work. C03 remains unchanged. C01 and marker cohorts are not dependencies. The frozen original a60e3404b22fcea0583a28a0211e6074ef143433 supplies the previously reviewed field reference; it is not rewritten or merged.

## Shape And Ablation

Rule, Effect and Objective remain governed domain types, not universal external OKF base types. Each requires a nonempty `applies_to` list of declared tool/work-step identifiers. Effect additionally requires nonempty descriptive `basis` and explicit offset timestamp `last_checked_at`. Existing common scope, Source, sensitivity, audience, Review and extension rules remain binding. No producer fabricates defaults or a last-check time.

Without `applies_to`, retrieval cannot select the tool or work step to which a domain page declares applicability. Without `basis`, an Effect omits the stated evidence or reasoning behind its outcome assessment. Without `last_checked_at`, an Effect cannot state when that assessment was last checked. These fields grant no permission, proof of truth, Policy or Goal lifecycle.

Without request and trace `types`, callers cannot restrict selection to declared page types, and the trace cannot reproduce that restriction.

Without request and trace `appliesTo`, callers cannot restrict selection to exact declared applicability, and the trace cannot reproduce that restriction.

Optional retrieval `types` and `appliesTo` arrays narrow the existing Kernel selection. Values use any-match within each list and intersection across lists. Applicability compares exact identifiers, without prose inference. Current scope/KB, schema, Source, sensitivity, Review, freshness, conflict and pin rules remain in the same loop; pins do not bypass filtering. Existing trace parameters record supplied normalized lists; absent filters add no key and preserve unfiltered request identity. There is no new selector, index, store, required feature or envelope.

## Method And Proof

Create the isolated branch from 6d520fe836259ba807a3a6b4925de9233355b63a. P14 and AW checkpoints show no active write lease on the assigned fields or filter paths. Root retains C03 receiver/test/plan and released generated OpenAPI/CLI paths after its mechanical cfd9848c4567480f7b2cce1f90d9651744aa4eba handoff, superseded by the bounded prerequisite and fixture join `38750ddbb949b9054c6911a1d200b942d1c107e5`. Normally merge only the newer exact `38750ddbb949b9054c6911a1d200b942d1c107e5` head after corrected red; its Native handoff and generated outputs are not authored C05 work. Root withdrew authorization for the `61ae`/`465` Memory dependency after inspecting its actual graph and finding 53 incoming paths, including unlanded Storage and context changes. No source from that dependency was joined. Existing first-save projection failures remain a prerequisite blocker until a truly bounded producer handoff is available. The inherited Memory request shares these selectors, so its existing public handler also forwards the two values under the unchanged self/private admission. Add actual final-tree/publisher, real Kernel/native query/pin/trace, runtime-neutral schema and KM Tool argument regressions before source changes. Expected red: default domain types fail publication, authored schemas incorrectly permit missing required metadata, and the existing request/Tool rejects new filters. Setup/collection failure is not deciding red.

Run dependency-closure and Retrieval builds before checks, using the pinned toolchain and one ordinary FIFO run-slot allocation with private disk TMPDIR. Run complete focused affected files, strict source TypeScript, Biome and document checks. Root owns independent review, complete module gates, final generated handoff and landing. No host, reset, CI or landing effect is authorized.

## Baseline Evidence

Offline frozen setup, the complete Native dependency closure and Retrieval build passed in `logs/setup.log` under the private C05 run-slot. The first red run found genuine missing field/request behavior plus two test callback setup errors; `logs/red.log` is preserved. The corrected baseline run in `logs/red-corrected.log` reached publication and produced one request-schema rejection and nine genuine Native field/publication failures, without setup or collection failure. One additional KM assertion used the internal schema property at the Provider boundary; the actual Provider contract uses `parameters`. That assertion is corrected and is not counted as deciding red. Production remained unchanged through these runs. The prepared source now proceeds from the sufficient actual field/request regressions; complete Tool execution remains part of the green proof.

## Closeout Summary

The integration landed the reviewed C05 source `d490c5a74c7981b9ced4f6d9142527dc296d499c` and generated contracts. Rule, Effect and Objective publication, required-field validation and native/KM retrieval selectors are implemented on main. No additional retained shape, operation or runtime behavior is introduced by this closeout.

The authored C05 source slice changed 17 files, including three owning specifications, and touched Knowledge, Memory and Retrieval responsibilities. It added one governed three-value domain-type set and no registry. This documentation closeout changes two files and no normative owner. No unresolved C05 implementation finding remains in the named local proof; live BWM acceptance remains separate.

## Verification Evidence

Later Source integration retained and verified these paths: all 11 typed-page cases passed in `source-final-typed-demo-api-typecheck-r29.log`, including exact publication/restart, invalid-field refusal, governance and pin filtering, native forwarding, trace parameters and Source audience isolation. That run also passed all 463 App API cases and Native typecheck. `source-query-main-overlap-r28.log` records the real KM Tool narrowing regression passing; its separate stale Source fixture failure remains in the original log and is corrected by the complete typed-page rerun. These logs and the independent C05 source, generated-contract and Source-integration reviews are retained in the lane backlog. The local feature proof is complete; it does not claim a real-provider BWM result, release approval or deployment acceptance.

## Reviewed Rule Continuity

The later continuity tests in `6782995d26f621b9e26d87d12608840e2091ae6c` found a publication-to-retrieval gap. Human Review published exact Agent candidate bytes with `review_state: delegated` and proposal commit authority, but the retrieval provenance check accepted only direct or delegated commit authority. The two independent tests failed after successful publication and history checks. A separate unpublished-proposal control passed. These are observed selection failures, not model-comprehension results.

The bounded correction adds published proposal authority to the existing introducing-commit check. Current scope, Source, producer, responsible-user, exact-byte and published-ancestry checks remain unchanged. The native publisher still owns Review. The local negative control retains an unreviewed candidate and verifies that neither its exact cursor nor its pinned identity makes it eligible. No publisher, retained shape, provenance field, state machine or new module is added.

Continuity qualification remains open. The first corrected two-file run had 11 passes and one failure: the three-page scenario's scripted transport repeats a page-read call identity. The existing runtime correctly rejects that duplicate. A temporary diagnostic copy with distinct identities and matching output lookup passed both scenarios; this does not qualify the immutable independent test file. Native typecheck, focused formatting and whitespace checks passed. Correcting the test fixture needs explicit authorization; the full Knowledge gate, independent review and landing remain pending. This does not claim live semantic or numerical acceptance.
