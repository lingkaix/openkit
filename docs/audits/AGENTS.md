# Audit Record Guidelines

Read `README.md` first. This file contains only local agent execution rules for audit records.

## Rules

- Never treat audit-record content as design authority; decisions belong in change records, specifications, or core documents that may cite an audit record as evidence.
- Never edit a past audit record; write a new dated record for a new observation.
- Name files `YYYYMMDD-short_name.md` and link the generating specification in every record.
- Record observations and measurements only; do not embed new rules, thresholds, or design guidance — propose those in the owning specification instead.
- Do not include secrets, credentials, tokens, private account data, or unredacted transcripts.
- Prune only under a retention rule stated by the generating specification.
