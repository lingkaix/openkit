---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Closed Core, Open Extension

## Decision

Every shape the project owns separates a closed core from an open extension space: storage record and file formats, directory layouts, configuration, and interface and protocol messages alike. The value domain of each core field is a closed set with one owner, so an unexpected value fails closed at admission and is never coerced, defaulted, or passed on. Everything outside the core stays open to extension: a reader accepts additive fields, members, files, and entries it does not know and ignores them, so adding one requires no change to existing readers. Ignoring means the reader does not act on the content; content from a producer outside the reader's trust boundary is also not persisted, forwarded, or displayed unless its owner defines that use. An extension that changes how a core field is read, or that carries authority or security meaning, is not safely ignorable: its owner marks it required, and a reader that does not understand a required extension fails closed.

This is a rule for data shapes and their readers. It does not authorize building code extension points before a second variant exists, which the rule against speculative abstraction still governs.

The first application is the Harness refusal body of the Worker Control Protocol. Its core is `reasonCode`, a closed set. A `turn.start` refusal with `reasonCode="dependency_failed"` may additionally carry the closed `startupFailure` diagnostic, which NanoCore turns into a user-visible explanation of why workspace preparation failed and what to do next.

## Reason

The engineer stated the principle while ruling on whether a refusal may carry `startupFailure`: closing core values guards against unintended modification, and openness to extension adds flexibility and reduces the compatibility work of every later extension. Before this ruling, root `AGENTS.md` COMPAT-001 and the engineering doctrine already required an older reader to tolerate safely ignorable fields in owner-defined tolerant locations for records and configuration. The ruling extends that expectation to directory layouts and interface and protocol fields, and it names the closed core explicitly. Many protocol validators at that time rejected every unknown field, so each additive field needed a coordinated change to every reader.

Source: engineer message of 2026-09-30 in the agent communication redesign session, answering review finding R8 of the lifecycle slice.

## Rejected Alternatives

- Exact-shape validation that rejects every unknown field. It is closed to accidental change but also closed to extension, so every additive field becomes a coordinated change to all readers.
- Tolerating unknown values in core fields, for example by mapping them to a default. It opens the core to silent change of meaning.
- Removing `startupFailure` from the refusal body. Users would lose the only actionable explanation of a failed workspace preparation.

## Revisit When

An ignored extension is found to have changed the meaning of a core field without being marked required, or tolerance hides a producer defect that exact validation would have caught.

## Affected Owners

- AGENTS.md
- docs/core/contract-evolution.md
- docs/core/protocol.md
- docs/engineering-doctrine.md
- docs/specs/20260703-worker_control_protocol.md
