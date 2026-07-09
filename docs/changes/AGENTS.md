# Change Records

Read `README.md` first. This file contains only local agent execution rules for change records.

## Local Agent Rules

- Prefer one change record per major change, pull request, branch, standalone important change, or completed release cycle.
- For major or significant work, start with a `change-plan` before implementation begins, then keep that same record through completion.
- Update the tracking log only at meaningful checkpoints such as phase completion, scope change, agent handoff, important deviation, blocker, decision, verification result, or PR linkage.
- Link related commit hashes, PR URLs, core docs, product docs, specs, issues, and working logs.
- Keep the record concise and focused on material context, impact, checkpoint progress, verification, and follow-ups.
- Complete the implementation summary and final verification sections when the PR is merged, the standalone change lands, the release completes, or the work is superseded.
- Do not use change records as command transcripts, noisy progress logs, or one-file-per-user-story implementation journals.
- If a change needs design alternatives, trade-offs, or migration planning, write or update a spec in `docs/specs/` and link it from the change record.
