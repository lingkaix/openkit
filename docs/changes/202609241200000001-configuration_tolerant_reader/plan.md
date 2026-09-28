---
type: change-plan
status: verified
date: "2026-09-24"
---
# Configuration Tolerant Reader

## Intent Revision 1 — 2026-09-24

On 2026-09-24 the engineer accepted that settled mechanisms stay stable while extension stays open, and that hand-written configuration written for a newer release must not stop an older one: an unknown key produces a warning diagnostic and is otherwise ignored, while an unknown key inside an authority-bearing section and a feature the file declares as required still fail closed. [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) landed that rule in docs/core/contract-evolution.md and drafted this plan so that the configuration owners and loaders follow it. The outcome is that every authored configuration file NanoCore reads has each of its sections classified as tolerant or authority-bearing, loaders behave accordingly, and the diagnostic reaches the operator through the existing configuration-error channel. The engineer transfers this plan to a primary before work starts. Generated and machine-written records are out of scope; they follow the storage rules of the same Core document. No commit, push, deployment, or external publication is authorized by this draft.

## Owners

[Contract Evolution](../../core/contract-evolution.md) owns stability classes and extension tolerance, including the Hand-Written Configuration section. [NanoCore Config Identity Contract](../../specs/20260628-nanocore_config_identity_contract.md) owns authored Server, User, and Workspace file classification and runtime-config diagnostics. [Workspace Data Source Catalog](../../specs/20260704-workspace_data_source_catalog.md) owns `data-sources.jsonc` semantics. [Agent Environment Package](../../specs/20260616-agent_environment_package.md) owns the agent environment manifest. [Schema Evolution Record Envelope](../../specs/20260703-schema_evolution_record_envelope.md) owns the required-feature registry that already expresses required features.

## Accepted Decisions

- [Settled Mechanisms Stay Stable And Extension Stays Open](../../decisions/20260924-stable_mechanisms_open_extension.md) is the governing decision.
- [Internal Development Does Not Consider Backward Compatibility](../../decisions/20260709-no_backward_compatibility.md) still holds: this plan adds tolerance for newer files in older readers, not aliases or migrations for old files.

## Closeout

Status is completed under the handoff's local-commit authorization. The accepted per-file classification is implemented: unknown optional keys at the named Server, User, Workspace and data-source locations produce located warnings; authority-bearing sections and unsupported required features reject. One shared required-feature validator serves the three newly tolerant schemas, and one small unknown-key collector serves their loaders and the existing editor. Data-source parsing keeps its existing behavior-inert unknown fields. Editor writes preserve the submitted JSONC bytes.

Independent Grok review found missing reload warning delivery and duplicate editor diagnostics with incorrect scoped file IDs. The corrections use the existing reload-plan warning array and public file-ID mapping. Web now renders that warning array after Apply. The review's initial startup claim was disproved by the existing index.ts startup diagnostic loop; no second startup logger was added. A second actual-diff review accepted the correction. Its output is retained at temp/changes/202609241200000001-configuration_tolerant_reader/grok-review-final.txt.

## Verification

The independent config-tolerance suite passes 11 tests, including exact once-only warnings and public file IDs, redacted reload locations, authority rejection, required-feature rejection before write, and unchanged disk bytes on failure. The broader focused NanoCore configuration set passes 45 tests; the config-schema Server, source-catalog and Workspace set passes 47 tests. ConfigurationScreen passes 12 tests, with the warning-display regression first observed failing. Both affected backend package builds and typechecks, focused Biome and git diff --check pass. Raw UI evidence is web-warning-red.txt and web-warning-green.txt in the same temporary bundle. Repository-wide verification belongs to the final handoff checkpoint and is not inferred from these checks.

The current implementation introduces no dependency, policy engine, configuration file type, public status field or registry. Four authored file kinds gain or complete warning delivery; three existing parser/diagnostic consumers share one collector, and the three newly tolerant schemas share one required-feature predicate. The one owning specification changed is the NanoCore Config Identity Contract; the other named owners retain their criteria. The focused commit changes 19 files across config-schema, NanoCore configuration and Web configuration, with one normative document amended; the local commit is recorded by the handoff closeout. No unresolved configuration finding remains; GOVLAND-FND-008 is closed in the governance landing findings.

## Verification Direction

Begin with the lowest-sufficient regression per loader: tolerant section warning, authority-bearing failure, declared required feature failure, and a warning that names the key and its location. Run the config-schema and NanoCore configuration suites and the repository gates in proportion. A reviewer checks the section classification against the Safety Kernel, and the test author derives the cases from the Core rule, not from the new schema code.
