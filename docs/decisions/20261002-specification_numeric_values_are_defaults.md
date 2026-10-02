---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Empirical Numeric Values In Specifications Are Current Defaults

## Decision

Most numeric limits, timeouts, windows, counts, and sizes in specifications are assumptions based on experience, and such a value is a current default, not a governing constant. The specification states the property the value protects, such as a bound, a refusal before write, or a failure scoped to one Turn, and either leaves the number to the implementation or names it marked as the current default. A number that defines a wire or persisted-data format, such as a field width, belongs to that contract and keeps its contract-evolution obligations. The deferred slimming of the agent communication specifications applies this rule to the 10-second drain, the 30-second internal-role timeout, and the 100-event replay window, and examines similar values, such as the 16-request outstanding ceiling, the same way. A value may later become user-configurable through its owner's ordinary change process; this decision adds no configuration surface now.

## Reason

On 2026-10-02 the engineer said, translated from Chinese: "Most of these three values and similar values in the specification documents are assumptions based on experience. In later maintenance and upgrades they may change at any time with our needs or with external conditions, such as updates and upgrades of third-party libraries or changes to the deployment environment. Some values may also become flexible values that users can configure later in development. They therefore should not be hard-coded in the specification documents, or should be marked."

This extends [the ruling that specifications prescribe architecture, not implementation](20261001-specifications_prescribe_architecture_not_implementation.md). Agents apply every normative sentence literally, so an unmarked number reads as a contract that a dependency upgrade, a deployment change, or a later user setting would break.

## Rejected Alternatives

- Classify each value as a key detail or a default one by one with the engineer before writing. The engineer answered for the class of values chosen from experience; a writer who keeps a value as a contract states the reason instead.
- Remove every number from specifications. The engineer allowed marking as an alternative to omission, and a named current default keeps the trade-off visible to maintainers.

## Revisit When

A value left to the implementation turns out to be load-bearing across owners, for example two components that must agree on it, and its absence from the specification causes a defect.

## Affected Owners

- docs/writing.md
- The specifications touched by the agent communication redesign, in the deferred slimming pass.
