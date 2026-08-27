# Audit Record Guidelines

Read `README.md` first. This file contains only local agent execution rules for audit records.

## Rules

- Never treat audit-record content as design authority; decisions belong in change records, specifications, or core documents that may cite an audit record as evidence.
- Never edit a past audit record; write a new dated record for a new observation.
- Name files `YYYYMMDD-short_name.md` and link the generating specification or governance owner in every record.
- For a terminal archive, record the exact source and final archive paths, accepted transition decision, every authority criterion's receiver disposition, every inbound current-guidance link disposition, and each final archived-file SHA-256; do not decide the transition inside the audit.
- Record observations and measurements only; do not embed new rules, thresholds, or design guidance — propose those in the owning specification instead.
- Do not include secrets, credentials, tokens, private account data, or unredacted transcripts.
- Prune only under a retention rule stated by the generating owner.
