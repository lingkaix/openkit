---
type: change-plan
status: planned
date: "2026-09-24"
---
# Configuration Tolerant Reader

## Intent Revision 1 — 2026-09-24

On 2026-09-24 the engineer accepted that settled mechanisms stay stable while extension stays open, and that hand-written configuration written for a newer release must not stop an older one: an unknown key produces a warning diagnostic and is otherwise ignored, while an unknown key inside an authority-bearing section and a feature the file declares as required still fail closed. [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) landed that rule in docs/core/contract-evolution.md and drafted this plan so that the configuration owners and loaders follow it. The outcome is that every authored configuration file NanoCore reads has each of its sections classified as tolerant or authority-bearing, loaders behave accordingly, and the diagnostic reaches the operator through the existing configuration-error channel. The engineer transfers this plan to a primary before work starts. Generated and machine-written records are out of scope; they follow the storage rules of the same Core document. No commit, push, deployment, or external publication is authorized by this draft.

## Owners

[Contract Evolution](../../core/contract-evolution.md) owns stability classes and extension tolerance, including the Hand-Written Configuration section. [NanoCore Config Identity Contract](../../specs/20260628-nanocore_config_identity_contract.md) owns the authored Server, User, and Workspace files and their loaders. [Agent Environment Package](../../specs/20260616-agent_environment_package.md) owns the agent environment manifest. [Schema Evolution Record Envelope](../../specs/20260703-schema_evolution_record_envelope.md) owns the required-feature registry that already expresses required features.

## Accepted Decisions

- [Settled Mechanisms Stay Stable And Extension Stays Open](../../decisions/20260924-stable_mechanisms_open_extension.md) is the governing decision.
- [Internal Development Does Not Consider Backward Compatibility](../../decisions/20260709-no_backward_compatibility.md) still holds: this plan adds tolerance for newer files in older readers, not aliases or migrations for old files.

## Working Checkpoint

Status is planned. Facts measured on 2026-09-24: the configuration specification says that all authored files use strict schemas and that unknown authority-bearing behavior remains invalid, which contradicts the Core rule for tolerant sections and must be amended first; packages/config-schema/src uses strict object schemas in about 160 places; apps/nanocore/src/config/agents-loader.test.ts expects an Unrecognized keys error for an unknown field. Unknown: which sections are authority-bearing in each file; which loaders share one parse path; whether the existing configuration-error channel can carry a warning without failing the load.

Predicted Next Action: amend the configuration specification with a per-file table that classifies each section as tolerant or authority-bearing, with independent Consultant scrutiny because the classification decides which unknown keys fail closed; then change the shared schema construction so that tolerant sections collect unknown keys as warnings. Expected observable: a regression that loads a file with an unknown key in a tolerant section and observes the warning and a successful load, and one with an unknown key in an authority-bearing section and observes the existing failure. Evidence that would change the route: a section whose tolerance would let an unknown key change authorization, credentials, sandbox, or routing behavior, which stays strict and goes to the engineer if the classification is disputed.

## Verification Direction

Begin with the lowest-sufficient regression per loader: tolerant section warning, authority-bearing failure, declared required feature failure, and a warning that names the key and its location. Run the config-schema and NanoCore configuration suites and the repository gates in proportion. A reviewer checks the section classification against the Safety Kernel, and the test author derives the cases from the Core rule, not from the new schema code.
