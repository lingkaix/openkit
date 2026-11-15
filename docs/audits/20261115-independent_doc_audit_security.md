---
date: "2026-11-15"
---
# Independent Documentation Audit: Security Group

This non-authorizing record holds the security group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15). The round-2 inventory adds this group: the new Core charter and its two specifications (P0-G4-17).
- Core document: `docs/core/security.md` (SEC).
- Specifications: `20261109-development_security.md` (DSEC, `kind: process`) and `20261109-runtime_security.md` (RSEC).
- G3 inspection: two read-only inspector contexts (DSEC, RSEC). They read code, workflows and scripts only and ran no tests. The auditor verified each kept finding against the base SHA.

## G2 Core Against Specifications

- SE-G2-01: SEC agrees with DSEC on the urgent class ("known exploitation and published malicious packages") and the five finding statuses, and with RSEC on alarm-first stop, feeds that never close or lower a finding, no autonomous widening, and the exposure switch. No action.
- SE-G2-02: SEC (Relationships) says that [Evidence](../core/evidence.md) owns "audit events, including security events". The Evidence aspect does not mention security events, alarms or findings. Question Q-246.
- SE-G2-03: SEC (Defense Loop) says "The release gate refuses to ship open urgent findings that have no accepted disposition." SEC also says that it does not own concrete deadlines, thresholds or workflows, and DSEC owns the release gate. Question Q-247.
- SE-G2-04: SEC says that the classes and their target times "are defined by the development and runtime owners"; DSEC is the single owner of the classes, and RSEC uses them. Wording only (Question Q-249).
- SE-G2-05: SEC keeps a staging phrase in Limits And Trade-offs ("introduced owner by owner"; "review of new versions" next to it is a mitigation, not staging) and has no section named Boundaries And Non-Goals; its content is in Trust Boundaries, Threat Model and Limits And Trade-offs, which the Core README allows. Question Q-249.
- SE-G2-06: RSEC lists amendments to Policy, Identity, Mediation and Protocol as rollout work, and the Core aspects already carry them. Of the Core line pins that RSEC cites, `policy.md:119` (the agent-for-User rule) and `mediation.md:60` (distinct roles) still point at the cited rules; `policy.md:263` is stale (the restrict-only gate rule is now at `:271`), and other body pins (`policy.md:82`, `:267`, `:291`) are stale too. Question Q-249.
- SE-G2-07: The Pause has no Core owner; RSEC and the bootstrap readiness specification own it. No Core rule needs it. No action.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| SE-DSEC-01 | DSEC frontmatter `implementation: Not Started` | Pinned scanners with checksums (`scripts/security-tools.json`), `scripts/check-security.mjs`, the release jobs `release-security` and `attest-release-images` in `.github/workflows/ci.yml`, `.github/workflows/security.yml`, `SECURITY.md`, the pnpm rules in `pnpm-workspace.yaml` and the image build changes exist | Status metadata false | Corrected to `Partial` (the mounted-route `check:repo` step and repository settings remain) |
| SE-DSEC-04 | DSEC Current Implementation Projection written as future work ("stops pushing", "gains", "moves", "one new scheduled workflow") | `.github/workflows/ci.yml:64-66` (`test-image` does not run on `pull_request`); `ci.yml:270-274` (`release-preflight` runs `check-security.mjs --release`); `ci.yml:1750` (`release-security` runs `release-security.mjs`); `ci.yml:1808-1825` (`attest-release-images`); `ci.yml:2421-2440` (`github-release` SBOMs and attestations); `lefthook.yml:4`; `scripts/release-safety.mjs:6`; `pnpm-workspace.yaml:4-7`; `containers/workers/Dockerfile:288-300`; `containers/app/Dockerfile:16-23,156-169`; `scripts/release-preflight.mjs:7,737` | Projection drift | Rewritten as current facts; `check:repo` does not call `check:security`; the `release-preflight` job runs `check-security.mjs --release`, the `release-security` job scans the candidate image digests, and `github-release` generates the SBOMs |
| SE-DSEC-02 | DSEC (Where Each Check Runs): exposure owner/switch coverage runs in `check:repo` and on every pull request; [Security Program Rulings](../decisions/20261109-security_program_rulings.md) item 22: uncovered route groups "fail the repository check" | `package.json` `check:repo` has no coverage step; coverage is `apps/nanocore/src/policy/operation-exposure-coverage.test.ts`, which runs only in the L0-L2 jobs on `push` and manual dispatch; on `pull_request` only `pr-check` and `nanohost-installer` run | Code differs from a current accepted document and decision | Issue #747 (blocking candidate: security) |
| SE-DSEC-06 | DSEC: "The tag-only release job alone gets `id-token: write` and `attestations: write`." | Three jobs hold both permissions: `attest-release-images` (`ci.yml:1777-1778`), `github-release` (`ci.yml:2377-2378`) and `.github/workflows/release-promotion.yml:91-92`; all are tag-only or promotion jobs | No accepted record decides; first principles favor the code, because candidates are attested before publication | Question Q-250 |
| SE-DSEC-03 | DSEC Background table "State at 835ffb0a4" | Every row is now false; the table is dated to a commit | History in a specification | Question Q-249 |
| SE-DSEC-05 | DSEC: the scheduled image scan | `.github/workflows/security.yml` is diagnostic only | Wording | Question Q-249 |
| SE-RSEC-01, -02 (sign-in) | RSEC E1 limiter per source and per account, trusted proxy hop count; `auth.failure-threshold` for R2 | `apps/nanocore/src/auth/better-auth.ts` sets no limiter or proxy option; the only threshold producer is the bearer path (`apps/nanocore/src/auth/middleware.ts:130-141`) | Code differs from a current accepted document | Issue #736 (blocking candidate: security) |
| SE-RSEC-02 (revoked), -03, EV-AUE-07 | RSEC E5 and the audit owner: `server.config.update`, `channel.pairing.bind`, `channel.pairing.unbind`, `auth.revoked-credential-presented` | Consumers only (`apps/nanocore/src/storage/security-trigger-codecs.ts:84,88,89,91`) | Code differs from current accepted documents | Issue #737 (blocking candidate: security) |
| SE-RSEC-04 | RSEC Pause and the bootstrap readiness Persistent Pause rule | No setting, refusal or R1 raise | Code differs from current accepted documents | Issue #738 (blocking candidate: security) |
| SE-RSEC-05 | RSEC E6 fixed channel text for `automation` requests | `apps/nanocore/src/channels/discord-rest.ts:84`; `apps/nanocore/src/channel-services.ts:98-133` returns question text | Code differs from a current accepted document | Issue #739 (blocking candidate: security) |
| SE-RSEC-06 | RSEC E9 Spread: Knowledge and Memory carry the influence bit | No code in `apps/nanocore/src/knowledge/` or the Memory owners (`apps/nanocore/src/memory-operations.ts` and related files) writes or propagates the bit; the register marks both rows Planned | Code differs from a current accepted document | Issue #740 (blocking candidate: retained data format, security) |
| SE-RSEC-07, -08 | RSEC Background snapshot and stale Core line pins | Commit-pinned snapshot; Core already carries the amendments | History and navigation | Question Q-249 |
| SE-RSEC-09 | RSEC Current Implementation Projection covers only E10, E11 and E13 | See the five issues above | Projection gap | One sentence added that names the unimplemented items and their issues; for E6 it names the fixed `inspect` and `answer` text and the delivery deadline word, because delivery already sends fixed link-only text (`apps/nanocore/src/channels/discord-rest.ts:84`) |
| SE-RSEC-10 | RSEC Proposed Design: "The only further retained values are `quarantine` ... and `containment` ..." | RSEC (E13) itself defines the `route-group-switch` container kind; the retained format register lists the `route-group-switch` and `context-preset` container kinds; `apps/nanocore/src/policy/statements.ts:225` also requires the `security.containment` action, which no specification or register row names | Undecided: scope of the sentence and an unregistered value | Question Q-248 |

## Held G1 Probe Findings

None. The group is new in round 2.

## G4 Organization

No move, merge, or split is applied. Placement of the two specifications under SEC is confirmed (P0-G4-17).

## G5 Writing

Dated snapshots, line pins, staging phrases and the classes wording are recorded in Question Q-249.

## Semantic Preservation

| File | Normative sentences | Other sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- | --- |
| SEC | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |
| DSEC | 36 unchanged, 1 changed | 358 unchanged, 14 changed or removed, 16 added | 24 unchanged | 63 unchanged, 1 removed (`SECRET`), 15 added | 30 unchanged | 33 unchanged |
| RSEC | 141 unchanged | 574 unchanged, 1 added | 101 unchanged, 5 added (issue numbers) | 170 unchanged | 37 unchanged | 79 unchanged, 5 added |

- DSEC: the changed and removed sentences are the projection bullets and the frontmatter value. The added identifiers are the job, script, workflow and module names that the rewritten bullets cite. The `check:repo` mounted-route step keeps its status as an acceptance-phase implementation requirement, and runtime Policy keeps enforcement. The removed identifier `SECRET` named the former constant that moved to the shared module.
- RSEC: one projection sentence is added; no rule changes.
- No acceptance item, heading or link was removed, and no file moved.

## Issues Opened

- #736 `[auth] The sign-in limiter, the trusted proxy hop count and the sign-in failure event are not implemented`, blocking candidate (security).
- #737 `[security] server.config.update, channel.pairing.bind, channel.pairing.unbind and auth.revoked-credential-presented have no producer`, blocking candidate (security).
- #738 `[security] The persistent "pause agent work" setting is not implemented`, blocking candidate (security).
- #739 `[channels] Discord shows the question text of an automation security request instead of the fixed text`, blocking candidate (security).
- #740 `[security] The external-influence bit does not carry into Knowledge and Memory revisions`, blocking candidate (retained data format, security). A comment corrects the Memory code path.
- #747 `[ci] Exposure owner and switch coverage does not run in check:repo or on pull requests`, blocking candidate (security).

## Questions For The Engineer

### Q-245. Which gate runs exposure owner and switch coverage?

- Withdrawn after the independent review. DSEC and the Security Program Rulings (item 22) decide the gate, and the NanoCore test does not run on pull requests, so the gap is a defect: issue #747.

### Q-246. Does Evidence own security events?

- Context: SEC says that Evidence owns audit events, including security events. The Evidence aspect does not mention security events, and RSEC and the audit owner define the event list.
- Options: (A) Evidence names security events as audit events; the event list and rules stay with specifications. (B) SEC names RSEC and the audit owner instead of Evidence.
- Recommendation: A, because SEC cites no specification and Evidence is the Core owner of audit semantics.
- Meanwhile: no change.

### Q-247. Does the release gate rule belong in Core?

- Context: SEC (Defense Loop) states that the release gate refuses open urgent findings without an accepted disposition, and also says that it owns no concrete workflow. DSEC owns the release gate.
- Options: (A) Keep the sentence as a Core principle ("open urgent findings without an accepted disposition block release"). (B) Move it to DSEC.
- Recommendation: A, reworded as the principle; the gate mechanics stay in DSEC.
- Meanwhile: no change.

### Q-248. Which further retained values does RSEC add?

- Context: RSEC says that the only further retained values are `quarantine` (Policy lifetime anchor) and `containment` (Server journal definition field). The accepted [Security Program Rulings](../decisions/20261109-security_program_rulings.md) item 26 is the basis of that sentence ("Admit only `quarantine` ... and `containment`"). RSEC (E13) itself defines the `route-group-switch` container kind, and the retained format register lists the `route-group-switch` and `context-preset` container kinds. The code also requires a `security.containment` Policy action, which no specification or register row names.
- Options: (A) RSEC scopes the sentence to the lifetime anchor and journal definition fields that item 26 decides, and RSEC and the register name the `security.containment` action. (B) RSEC lists all further values (`quarantine`, `containment`, `route-group-switch`, `context-preset`, `security.containment`), which amends what item 26 says.
- Recommendation: A, because it keeps item 26 as decided and registers the one value that is in retained Policy records without an owner.
- Meanwhile: no change.

### Q-249. May the security writing cleanups be applied?

- Context: DSEC and RSEC keep dated Background snapshots that are now false, RSEC keeps Core line pins that no longer point at the cited rules and lists Core amendments as pending, DSEC does not mark the scheduled scan as diagnostic, and SEC keeps staging phrases and loose wording on who defines the classes.
- Options: (A) Apply the cleanups. (B) Keep the text.
- Recommendation: A, under the round-1 delegated sweep for labels and history wording.
- Meanwhile: no change.

### Q-250. Which release jobs may hold the attestation permissions?

- Context: DSEC says that the tag-only release job alone gets `id-token: write` and `attestations: write`. Three jobs hold both: `attest-release-images` attests the candidate subjects before publication, `github-release` attests every released subject, and the promotion workflow attests the promoted subjects. All three run only for a tag or a promotion. The workflow README says "tag-only release jobs".
- Options: (A) DSEC says "the tag-only release and promotion jobs". (B) The workflows move all attestation into one job.
- Recommendation: A, because attesting candidates before publication is part of the release gate.
- Meanwhile: no change.

## Independent Review

One fresh reviewer read the group diff, this record and the claim inventory against the base SHA. It confirmed the other projection bullets, the `Partial` value, the five RSEC issues and their titles, Questions Q-247 and Q-249, and the safety and format checks. It returned twelve findings; the auditor verified each against the base SHA and applied all of them:

- Two DSEC projection bullets added by this audit were wrong: the SBOMs and the released-subject attestations come from `github-release`, and `check-security.mjs --release` runs in the `release-preflight` job. Both bullets and SE-DSEC-04 are corrected.
- The owner/switch metadata citation now names `packages/app-api-schemas/src/operation-definitions.ts`, which holds the descriptors.
- SE-DSEC-02 is decided by DSEC and rulings item 22 and the coverage does not run on pull requests: issue #747; Question Q-245 is withdrawn.
- A missing finding on the attestation permissions is added as SE-DSEC-06 and Question Q-250.
- `docs/INDEX.md` is regenerated in this commit.
- Question Q-248 now cites rulings item 26 and names `route-group-switch` and the unregistered `security.containment` action.
- SE-G2-06 now separates the still-correct Core pins from the stale ones.
- The RSEC projection sentence now names the missing E6 parts exactly.
- SE-RSEC-06 cites the real Memory code; a comment on #740 corrects the path.
- Question Q-246 option A no longer makes Core cite a specification.
- SE-G2-05 and the `pnpm-workspace.yaml` line range are corrected.

## Checks

At commit time: `node scripts/validate-doc-model.mjs` passed, `node scripts/generate-doc-index.mjs` regenerated `docs/INDEX.md`, `pnpm check:repo` passed, and the content scan of the staged diff found no email, token, credential path, private host, local absolute path or Vietnamese text.
