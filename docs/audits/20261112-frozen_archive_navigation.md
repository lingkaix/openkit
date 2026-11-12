---
date: "2026-11-12"
---
# Frozen Archive Navigation

This non-authorizing record states where a reader goes for six frozen superseded specifications whose guidance metadata still names historical paths. Its generating rule is [Terminal Archive Audit And Archive Immutability](../documentation-model.md#terminal-archive-audit-and-archive-immutability). It records an observation. It does not authorize a design and it does not amend an archive.

## Observation

On 2026-11-12 the six files below were restored to their bytes at `2deb81a8a4c55c6880de24672f10d4cebcd91cd9`, the parent of `4decb5b9e8ebde0509b1a323da83865f3db78725`. That parent is the freeze baseline for these files. Their `current-guidance` and `decision-evidence` fields again name the historical paths. Those fields stay historical evidence. A later reader uses this record for current navigation.

The lifecycle resolver already maps one missing date-prefixed specification path from a frozen referrer to the single same-name file in a terminal directory. Literal absence of the old active path does not make that historical target missing. [Historical Link Resolution And Returned Findings](20261005-openkit_agent_skill_interface_terminal_archive.md#historical-link-resolution-and-returned-findings) records that resolver. This record does not replace historical decision-evidence with a current owner.

## Current Navigation

| Historical coordinate still named by the frozen metadata | Current document | What that document owns |
| --- | --- | --- |
| `docs/core/permissions.md` | [Policy Model](../core/policy.md) | Authorization and permission decisions |
| `docs/core/audit.md` | [Evidence](../core/evidence.md) | Audit projection semantics |
| `docs/core/agent-workflow.md` | [Work Model](../core/work-model.md) | Core workflow mechanisms |
| docs/specs/20260713-openkit_agent_skill_interface.md | Split below | Not one surviving owner |

The removed Agent Skill interface remains at [docs/specs/retired/20260713-openkit_agent_skill_interface.md](../specs/retired/20260713-openkit_agent_skill_interface.md). Its historical disposition is [OpenKit Agent Skill Interface Terminal Archive](20261005-openkit_agent_skill_interface_terminal_archive.md): [Transition Decision And Exit Evidence](20261005-openkit_agent_skill_interface_terminal_archive.md#transition-decision-and-exit-evidence) and [Criterion Dispositions](20261005-openkit_agent_skill_interface_terminal_archive.md#criterion-dispositions). That disposition splits the surviving concerns:

- End-user product-channel concerns use [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md).
- Shared operation and projection concerns use [Operation Definition](../specs/20261002-operation_definition.md).
- Operator and administrator CLI scope uses [Agent Operator Skill](../specs/20260910-agent_operator_skill.md).

The operator Skill is not the sole receiver of the retired public interface.

## Frozen Files

| Frozen specification | Historical paths its metadata still names |
| --- | --- |
| `docs/specs/superseded/20260513-core_protocol_model_notes.md` | `docs/core/permissions.md`, `docs/core/audit.md` |
| `docs/specs/superseded/20260617-openkit_ai_interface.md` | docs/specs/20260713-openkit_agent_skill_interface.md |
| `docs/specs/superseded/20260628-protocol_contract_consolidation.md` | docs/specs/20260713-openkit_agent_skill_interface.md |
| `docs/specs/superseded/agent-workflow/20260517-nano_core_orchestrator.md` | `docs/core/agent-workflow.md` |
| `docs/specs/superseded/agent-workflow/20260525-sustained_mode_long_running_agent.md` | `docs/core/agent-workflow.md`, docs/specs/20260713-openkit_agent_skill_interface.md |
| `docs/specs/superseded/agent-workflow/20260526-nano_core_lightweight_agents.md` | `docs/core/agent-workflow.md` |

Other paths in those same metadata fields already name documents that exist. This record does not restate them. The documentation index lists this record with the other audit records.
