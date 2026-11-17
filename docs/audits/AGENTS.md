# Audit Record Guidelines

Read `README.md` first. This file contains only local agent execution rules for audit records.

## Rules

- Report incremental findings and assurance rulings in the current task context; retain them in a change record when one exists or the context independently needs to survive. An Auditor call alone requires no record. Use a dated audit for durable cross-task scrutiny or an owning measurement rule.
- Never treat audit-record content as design authority; decisions belong in specifications, Core documents, or decision records, and a finding that needs action becomes a GitHub issue.
- Never edit a past audit record; write a new dated record for a new observation.
- Name files `YYYYMMDD-short_name.md` and link the generating specification or governance owner in every record.
- Record observations and measurements only; do not embed new rules, thresholds, or design guidance — propose those in the owning specification instead.
- Do not include secrets, credentials, tokens, private account data, or unredacted transcripts.
- Delete a record only at closeout under the evidence rule in `docs/documentation-model.md`.
