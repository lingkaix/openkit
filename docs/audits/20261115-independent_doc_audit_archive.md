---
date: "2026-11-15"
---
# Independent Documentation Audit: Archive Check

This non-authorizing record holds the archive check of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations only. It does not authorize design, and it changes no archived file: archived bytes were frozen under [Documentation Model](../documentation-model.md#specifications) (historical archive rule superseded by [DOC-FINAL Information Architecture](../decisions/20261116-doc_final_information_architecture.md)).

## Scope And Base

- Base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15).
- Files: the 67 files under `docs/specs/retired/` and `docs/specs/superseded/`: 17 retired specifications, 48 superseded specifications, and the two directory guides.
- Method: a read-only script parsed the frontmatter of every archived specification, resolved every `current-guidance` and `decision-evidence` target as a repository-relative path, checked the status of each active target, checked the reason sections, and listed every link from an active document into the archive. It read the base worktree only.

## Lifecycle Metadata

- Every archived specification has the status of its directory (`Retired` or `Superseded`), `status-changed`, `current-guidance` and `decision-evidence`, and its reason section.
- `current-guidance`: 150 targets. 125 are repository paths that exist, 17 are `None` or a URL, and 8 are historical paths (below). Every existing specification target is `Accepted`.
- `decision-evidence`: 150 targets. 15 are URLs; the others exist except the same 8 historical paths.
- The two directory guides state the purpose and the frozen rule of their directory.

## Historical Paths

Six frozen superseded specifications name eight paths that no longer exist at their active location:

| Frozen specification | Historical paths |
| --- | --- |
| `docs/specs/superseded/20260513-core_protocol_model_notes.md` | `docs/core/permissions.md`, `docs/core/audit.md` |
| `docs/specs/superseded/20260617-openkit_ai_interface.md` | docs/specs/20260713-openkit_agent_skill_interface.md |
| `docs/specs/superseded/20260628-protocol_contract_consolidation.md` | docs/specs/20260713-openkit_agent_skill_interface.md |
| `docs/specs/superseded/agent-workflow/20260517-nano_core_orchestrator.md` | `docs/core/agent-workflow.md` |
| `docs/specs/superseded/agent-workflow/20260525-sustained_mode_long_running_agent.md` | `docs/core/agent-workflow.md`, docs/specs/20260713-openkit_agent_skill_interface.md |
| `docs/specs/superseded/agent-workflow/20260526-nano_core_lightweight_agents.md` | `docs/core/agent-workflow.md` |

The [frozen archive navigation record](20261112-frozen_archive_navigation.md) already maps each of them to its current reader (Policy, Evidence, Work Model, and the split owners of the retired Agent Skill interface). The lifecycle resolver maps the date-prefixed specification path to its file under `retired/`. No new mapping is needed, and no archived byte is changed.

## Inbound Links

Active documents hold five links into the archive, from two specifications: the [Human Attention Intervention Model](../specs/20260531-human_attention_intervention_model.md) (four supersession pointers) and [Pending Requests](../specs/20260930-pending_requests.md) (one). All five resolve. `docs/INDEX.md` lists the archived files as a generated projection.

## Result

No finding. The round-1 preliminary pass (summary record, Remaining Work item 3) found the same historical paths; the frozen archive navigation record has since carried their mapping.

## Checks

At commit time: `node scripts/validate-doc-model.mjs` passed, `node scripts/generate-doc-index.mjs` regenerated `docs/INDEX.md`, `pnpm check:repo` passed, and the content scan of the staged diff found no email, token, credential path, private host, local absolute path or Vietnamese text.
