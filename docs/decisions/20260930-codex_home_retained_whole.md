---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Codex Retains Its Whole Native Home Under Fixed External Authority

## Decision

The Codex adapter retains the complete opaque `CODEX_HOME` as the admitted Thread-private native data home across Turn close, AgentSession close, and compatible successor creation, and it generates no base configuration file there. Native configuration and rules inside the admitted Sandbox home and working roots may influence local execution inside the Sandbox. They never select a conversation, establish an AgentSession, select an unadmitted model or provider route, supply OpenKit credentials, or authorize an external effect; current AEP resolution, adapter-owned bindings, and the Gateway keep that authority. [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md) owns the exact rules and the qualification that must pass before native work, including the stop condition when those external-authority and credential boundaries cannot be proved.

## Reason

No native mechanism was qualified in the independent W2 round-4 investigation of the pinned `@openai/codex@0.159.2` distribution that simultaneously retains the whole home, keeps pre-existing configuration inert as launch policy, and isolates generated configuration. The independent W2 round-4 review observed that relocating only the native SQLite databases breaks exact resume after the disposable control root is removed, because the databases record that root's pathname, while a whole retained home without generated base configuration resumed exactly and kept the adapter-selected model over a retained model preference. Retaining the home whole follows [Full Permission Inside The Sandbox](20260930-full_permission_inside_the_sandbox.md), which places restrictions at the Sandbox boundary rather than on in-Sandbox configuration, and it lets one image configure shared in-Sandbox tools for every runtime.

The engineer selected this option on 2026-09-30 in the agent communication redesign session, choosing the option presented as "A, retain whole (recommended)" after being told its cost: a larger native configuration input surface that requires qualification against hostile or conflicting configuration, auth-store loading, and credential residue in native databases and logs.

## Rejected Alternatives

- Keeping retained configuration inert while waiting for a qualified native configuration-source separation capability, because none was qualified for the examined 0.159.2 distribution and the engineer preferred whole-home retention under fixed external authority to delaying Codex qualification.
- Relocating only the SQLite state beside a disposable home, because it does not retain the complete home and it fails exact resume after control-root removal.
- Maintaining an adapter-owned inventory of native filenames or rewriting native database locators, because either would make the adapter track undocumented native layout.

## Revisit When

Qualification cannot prove that retained configuration leaves the external route, credential, and Gateway boundaries unchanged, or a pinned Codex release provides an explicit native configuration-source separation that would permit inert retained configuration.

## Affected Owners

- docs/specs/20260716-codex_worker_adapter.md
