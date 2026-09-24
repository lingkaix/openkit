---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Settled Mechanisms Stay Stable And Extension Stays Open

## Decision

Because OpenKit is experimental and agent orchestration evolves quickly, the system is designed so that settled mechanisms stay stable without large incompatible rewrites, while extensions such as new mechanisms, new configuration fields, and new properties or levels of retained work data stay open. An older reader treats a new field it does not know as extra information it does not process, not as an error. Concretely: durable records and retained work data use tolerant readers and preserve unknown fields when rewriting the same record; a hand-written configuration file with an unknown key produces a warning diagnostic rather than a rejection; unknown authority-bearing sections and features declared as required still fail closed. The internal-development rule that designs need no backward compatibility removes obligations toward old data and old callers; it does not license churn of settled mechanisms, and it does not conflict with forward tolerance. The contract evolution model owns stability classes and extension tolerance; the configuration schema implementation change is handed to its owner.

## Reason

The engineer asked that this be a design principle from the start rather than a repair. The contract evolution model already allowed readers to ignore safely ignorable unknown optional fields and required authority-bearing unknowns to fail closed, but on 2026-09-24 the configuration schema package used strict object schemas 166 times against 11 tolerant ones, so a configuration file with a newer field was rejected. A silently ignored misspelled configuration key is a known failure of pure tolerance, which is why hand-written configuration warns instead of silently ignoring.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-009.

## Rejected Alternatives

- Silently ignoring every unknown field. Rejected because typing mistakes in hand-written configuration would become silent defaults.
- Keeping strict rejection. Rejected because every extension would break older readers.
- Reading the no-backward-compatibility rule as permission to rewrite settled mechanisms freely. Rejected by the engineer.

## Revisit When

A warning for an unknown configuration key is repeatedly ignored and causes a defect, or a tolerant reader is found forwarding unknown fields into a strict projection.

## Affected Owners

- docs/core/contract-evolution.md
- AGENTS.md
- docs/specs/20260616-agent_environment_package.md
- docs/specs/20260628-nanocore_config_identity_contract.md
