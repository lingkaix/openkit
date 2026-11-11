---
status: Accepted
date: "2026-11-11"
decider: "Engineer; Coordinator amendments on 2026-11-11"
---
# Login Preference And New-Turn Selection

## Decision

A Codex Login requirement keeps one exact grant in each immutable AEP. At a new Turn boundary, selection may resolve another currently authorized exact grant for that requirement. The eligible preferred grant comes first, then the attributed User's own Logins, then Workspace-shared Logins, with quarantine, account exhaustion, conflicting refresh and the 60-second departure cooldown enforced. When preference is skipped, the replacement Audit records the fixed reason. Ownership alone grants no use authority. Activation uses the existing governed Vault operation, current target authority, Policy and Audit; a predecessor receipt supplies correlation only. Same-family in-flight refresh stays exact. Cross-account continuation requires proof of the actual current account or trusted predecessor correlation tied to its previous exact AEP and receipt; the target account alone supplies no such proof. It returns a typed blocked result when that proof is absent.

In v0.1.0, explicit preference means a persistent grant-value change through the existing deployment-administrator configuration owner: `runtime.file-update`, then successful `runtime.reload`. It takes effect for Turns composed from that installed snapshot. Saving alone does not activate it; queued dispatch keeps its captured snapshot. Ordinary Users, Workspace members and agents have no configuration-write authority. Their existing sharing, withdrawal and revocation operations and automatic replacement remain available within current authority.

The file-publication owner records the actor, Workspace, Agent requirement, old/new grant identities and Kernel authorization outcome through the existing Audit shape. No new PermissionDecision family, candidate-set field, one-shot target, Turn input, Scheduler admission shape or AEP shape is introduced. The existing binding replacement operation activates the already-selected new plan; it does not retroactively select its grant.

## Reason

The Engineer's 2026-10-31 ruling owns the Login selection and safety boundaries. The Coordinator's 2026-11-11 amendments settle preferred-grant composition, persistent explicit ingress and the existing publication Audit extension. This record preserves their rationale; the linked specifications own the behavior.

The authored binding must express a durable preference without making its exact grant the only possible authority for future Turns. Existing reviewed grants supply that authority. A persistent configuration value has an existing publication, revision and reload lifecycle; a target named only at activation would arrive after the new AEP already fixed its grant. The current configuration writer authorizes deployment administrators, so ordinary-owner explicit selection requires a separately accepted owner.

## Rejected Alternatives

- Mutate a retained AEP or broaden an in-flight refresh: this loses the exact admitted consumer and grant.
- Add a one-shot target or retained candidate list: the existing authored binding already supplies persistent preference, and activation cannot choose an earlier package retroactively.
- Treat ownership, a previous receipt or a historical decision as current permission: each target still needs current exact consuming authority.
- Give ordinary owners implicit configuration-write authority: the existing administrator owner does not provide it. [Issue #711](https://github.com/lingkaix/openkit/issues/711) tracks the after-v0.1.0 owner.

## Revisit When

Revisit before adding ordinary-owner configuration writes, one-shot selection, cross-account continuation without current-account proof, or a retained selection mechanism. These exceed this decision.

## Affected Owners

- [Vault Secret Injection](../specs/20260703-vault_secret_injection.md)
- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [NanoCore Configuration Identity](../specs/20260628-nanocore_config_identity_contract.md)
