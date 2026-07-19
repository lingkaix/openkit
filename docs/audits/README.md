# Audit Records

This directory contains dated observation records produced by rules defined in owning specifications: calibration reports, drift findings, load-bearing maps, detection-rate trends, and similar instrument readings.

The audit-record type is owned by `docs/documentation-model.md`. The rule that produces each record — what is measured, how, and on what cadence — is owned by a specification, currently primarily `docs/specs/20260719-verification_calibration.md`.

## Authority

Audit records carry no authority of any kind. They are observations that inform decisions recorded elsewhere: a finding that requires action becomes a change record or a specification update that links back to the audit record as evidence. Nothing may cite an audit record as design authority.

## File Shape

- Filename: `YYYYMMDD-short_name.md` with a lowercase snake-case name.
- Each record states what was observed, the observation date, the rule and specification that produced it, and the documents or surfaces observed.
- Each record links its generating specification with a repository-relative path.

## Lifecycle

Past records are never edited; a new observation is a new record. Superseded readings stay in place as the historical trend. Records may be pruned under a retention rule stated by the generating specification; pruning is a normal commit, not a rewrite.

## Validation

`scripts/validate-doc-model.mjs` checks filename shape and the generating-specification link for every record in this directory as part of `check:repo`.
