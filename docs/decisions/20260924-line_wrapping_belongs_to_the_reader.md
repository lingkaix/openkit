---
status: Accepted
date: "2026-09-24"
decider: Engineer
supersedes: docs/decisions/20260709-no_line_breaks_in_sentences.md
---
# Line Wrapping Belongs To The Editor And Reader

## Decision

Output text must not insert a line break inside a complete sentence or paragraph. Root AGENTS.md states the rule as one of its two Chinese meta-instructions, and the writing reference applies it to repository documents.

## Reason

The engineer gave the reason on 2026-09-24, summarized here from Chinese: some models break their output lines at an unpredictable length, so text reads badly at different screen widths. Wrapping is therefore left to the editor and the reader rather than inserted in the text.

Source: the engineer's answer of 2026-09-24 to the landing's report, summarized above and noted in change record 202609231611190001-engineering_governance_landing; the rule has been in root AGENTS.md since the initial commit of 2026-07-09.

## Rejected Alternatives

- Hard-wrapping sentences and paragraphs at a fixed width. Rejected because the width suits one screen and reads badly on others.

## Revisit When

Not stated by the engineer. The writer's reading, not a supplied trigger: a reader or tool that the repository depends on cannot wrap text itself.

## Affected Owners

- AGENTS.md
- docs/writing.md
