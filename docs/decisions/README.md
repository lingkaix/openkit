# Decision Records

This directory holds one file per durable decision: who decided, when, what, why, which alternatives were rejected, when to revisit it, and which owners it affects. The type, its fields, its authority, and its immutability rule are owned by the Decision Records section of `docs/documentation-model.md`; this guide covers only how to write and find records here.

## When To Write One

Write a record when someone may later want to reverse the decision: an engineer ruling, an approved agent-initiated change to governing design, or a design decision whose rejected alternatives are likely to be proposed again. Do not record ordinary implementation choices, and do not record open questions; an unresolved question stays with its owner's open-questions section or a change record's findings.

Write it in the same change that lands the rule, and link it from the owner sentence it supports. When you are about to change a rule and find no record of its reason, ask the engineer first and record the answer before changing the rule.

## Shape

```markdown
---
status: Accepted
date: "YYYY-MM-DD"
decider: Engineer
---
# Short Decision Title

## Decision

What was decided, in one paragraph. Name the rule's owner.

## Reason

Why, in the decider's terms. Quote the engineer where the wording matters and say when it is translated.

## Rejected Alternatives

Each alternative and why it lost, or "None recorded."

## Revisit When

The observation or change of premise that would justify reopening it.

## Affected Owners

- The documents that state or depend on the rule.
```

The decider is `Engineer` for an engineer ruling. For an approved agent-initiated change, name both, for example `Engineer, on a Consultant-reviewed proposal`. When a backfilled record finds that an earlier source attributed an agent's design to the engineer, the record says so instead of repeating the attribution.

Name the source change record as plain text, for example "Source: change record 202609231611190001-engineering_governance_landing", and never as a link. Records are public repository text: leave out host names, credentials, private transcripts, and unverified inference.

## Finding Records

Records are not listed in `docs/INDEX.md`. Reach them from the owner that links them, or list this directory; file names start with the decision date.
