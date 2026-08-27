# Change Records

Read `README.md` first. This file adds only directory-local execution rules.

## Local Agent Rules

- Keep one concise record per material lifecycle and link the current owners.
- For long-running material work, append Intent Epochs and rewrite only the marked working checkpoint.
- Update the checkpoint when evidence changes a fact, unknown, method, frontier, or predicted Next Action; do not log routine commands or role transitions.
- Inspect actual artifacts and named execution evidence before recording acceptance.
- Keep raw transcripts, tool output, timing, and intermediate evidence uncommitted under `temp/changes/`, in a directory named exactly like this plan's bundle, and still use other `temp/` paths where the work needs them.
- In an approved pilot plan only, append to this bundle's `route-log.md` rather than to `plan.md`: a `Reframe` with its defeating evidence, a failed attempt or refuted hypothesis with its missing fact, each fresh-context direction check with its outcome and reason written by the context that performed it, and the one line recording an ordinary mid-slice compaction where no fresh check ran. A commit already records its `Continue` outcome; the causal evidence of a committing turn is still an entry.
- Never append to, normalize, or reconstruct a legacy `state.json`; retain it unchanged as historical evidence.
- Findings outside current intent remain non-authorizing until an engineer or accepted owner admits them.
- Keep every findings item in the fixed status and field shape owned by `docs/change-execution.md`; when later work closes a listed item, take exclusive ownership of that `findings.md` path, check its `Follow-up Index` line, change its heading to `closed`, retain its append-only `Next action` history, and append its closing verdict and closure evidence in the same change.
- Complete implementation and verification evidence when work closes or is superseded.
