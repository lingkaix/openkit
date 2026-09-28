---
status: Accepted
---
# Agent Harnesses

This reference says which agent harnesses can run the repository's roles, how a role is dispatched to them, which model realizes each capability tier in each harness, and what each harness can enforce rather than only ask for.

## Owns

- The supported harness set: Codex, Claude Code, Grok Build, Cursor CLI, PI run through Herdr, and DeepSeek Harness. OpenCode is not supported.
- The dispatch method, which is the same for every harness: a dispatch prompt that names the role contract. No harness keeps a copy or adapter of a role.
- The dispatch prompt template below.
- The model bound to each capability tier in each harness; a concrete model name appears only here, except for defaults that a harness's own configuration file already holds.
- The record of what each harness enforces and its known quirks. This list grows from observed behavior; an entry is added when a run shows it and removed when a run disproves it.

### Dispatching A Role

1. Choose the function from docs/roles/README.md and its minimum tier; a reviewer is at least the tier of the producer it reviews.
2. Resolve the concrete model and reasoning level for that tier in the chosen harness from the table below before launch.
3. Set the tools and restrictions the task needs, such as read-only access, through the harness's own controls at launch. A restriction written only in the prompt is a request, not containment: a role is guidance, never authorization.
4. If the harness cannot select the required model or restriction for a delegated run, launch a separate session that can, or dispatch the task elsewhere. Report missing capacity instead of silently using a lower tier.
5. Send the prompt below. The primary reads the actual diff or output before reading the report.

A researcher is dispatched with live web access where the harness offers it.

```text
You are the <role> for <bounded scope>.
Repository root: <absolute checkout path>.
Before task work, read AGENTS.md, then docs/roles/<role>.md, and follow its reading instructions.
If the contract is missing, unreadable, or conflicts with this assignment, report that before dependent work.

Task and source: <requested outcome; engineer statement or source pointer>.
Accepted authority: <owning documents and relevant decisions>.
Inputs and evidence: <exact artifacts, current-state references, unresolved objections>.
Writable paths: <exact paths, or NONE>.
Prohibitions and effect boundary: <excluded work; network, credentials, commits, publication, and delegation limits>.
Completion check: <observable acceptance condition and the checks to run>.
Return: <conclusion; evidence pointers; exact commands and results; changed paths; unresolved findings and decisions needed>.

Dispatch configuration chosen by the primary: <harness; tier; model and reasoning; tools; sandbox and permission controls; known enforcement gaps>.

For a fast-tier builder: use only the bounded inputs above instead of the broad reading list; do not infer missing intent, expand scope, or settle a governing decision; return the blocker when the task no longer fits these bounds.
For a Consultant: Gap: <freshness, independence, or capability>. Stance: <challenge or guide>.
```

The configuration line records the launch choice; it does not configure the runtime. A completion check describes the evidence to produce, never a verdict to reach. A runtime without the checkout receives the role file's text inside its dispatch; that is transient context, not another maintained copy.

| Harness | Instructions it loads | How the model and restrictions are set | What it can enforce |
| --- | --- | --- | --- |
| Codex | Root AGENTS.md | Model and reasoning at launch or delegation; project defaults in .codex/config.toml | Sandbox and approval policy; the project configuration grants full access, so a read-only run must request the read-only sandbox explicitly |
| Claude Code | Root CLAUDE.md, which imports root AGENTS.md | Model and tool selection per delegated agent or session | Tool allowlists; permission modes |
| Grok Build | Root AGENTS.md | Model, sandbox profile, and tool denylist at launch | A read-only sandbox profile that write-denies the repository; permission modes |
| Cursor CLI | Root AGENTS.md | Model at launch | An ask mode that is read-only |
| PI through Herdr | Root AGENTS.md | Provider, model, and thinking level at launch in a Herdr pane | Tool allowlists; no sandbox |
| DeepSeek Harness | Root AGENTS.md through its instruction loader | Not yet verified | Not yet verified |

### Models By Tier

| Harness | frontier | standard | fast |
| --- | --- | --- | --- |
| Codex | gpt-6-astra, reasoning xhigh for a Consultant and high otherwise | default_subagent_model in .codex/config.toml; gpt-6-astra with medium reasoning for a researcher | not bound |
| Claude Code | opus | sonnet | not bound |
| Grok Build | grok-4.7 | grok-4.7 | not bound |
| Cursor CLI | not used | grok-4.7-high | grok-4.7-build-fast |
| PI through Herdr | openai-codex/gpt-6-astra with high thinking | openai-codex/gpt-6-astra | not used |
| DeepSeek Harness | not yet bound | not yet bound | not yet bound |

A route is recorded as verified for a harness only after an observed dispatch shows that the agent read its contract, ran on the chosen model, and respected the chosen restrictions.

### Known Quirks

- Codex: a spawned Codex context has started its own reviewers, waited on them, and treated their verdicts as acceptance; bind it to the builder role and do not count its self-review. It has also rewritten a test it was told was immutable, so diff its writable paths before reading its report.
- PI through Herdr: a Herdr pane may start without the repository's runtime toolchain, so native SQLite modules fail on an ABI mismatch that looks like a product failure. Check the Node version in the pane before trusting a failing suite. PI stops when its model quota runs out; plan a fallback owner for its paths.
- Grok Build: headless runs in plan permission mode stop after the first message because tool calls are refused; use the read-only sandbox with automatic approval for read-only compiler work instead.

## Does Not Own

- Which roles exist, their minimum tiers, when they are composed, or the tier vocabulary: docs/change-execution.md owns them.
- Any role's operation: its contract under docs/roles/ owns it.
- Toolchain setup and runtimes: docs/toolchain.md owns them.

## Judgments

- A constraint that the harness enforces, such as a read-only sandbox or a permission mode, is stronger evidence than the same constraint written in a prompt. Rests on: harnesses have edited outside their lease and self-spawned reviewers when told not to. Overturned by: a prompt-only constraint that holds across repeated observed runs in that harness.
- Different model families make less correlated errors, so independent review of consequential work prefers a different family from the producer's. Rests on: anecdotal cases in which a reviewer of another family found defects the producer's family missed. Overturned by: seeded-defect calibration showing no family effect.

## Related Documents

- docs/change-execution.md
- docs/roles/README.md
- docs/toolchain.md
