---
status: Accepted
---
# Generative Apps Model

This document owns Light App, Light App Catalog, Generative Kernel, and Generative UI: their purpose, agent-first relationship, durable authority, lifecycle, failure boundaries, and conformance expectations.

This document does not own Agent identity or runtime, Plugin packaging, Skill versioning, MCP transport, database layout, UI protocol payloads, authorization policy, credentials, execution scheduling, or backup formats. Their existing owners remain authoritative.

## Purpose

OpenKit is a professional workspace that connects work across existing systems. A membership platform and a CRM may identify the same person differently; an analysis may produce useful customer dimensions that the CRM cannot hold. Small durable mappings, annotations, and reusable functions make those systems work together without replacing them or reproducing their entire data model.

The design premise is **Generative Kernel + AI Agent + Generative UI**. Agents turn recurring needs into stable data structures, understand and operate those structures, and present useful information or interactions when needed. The stable part is the data kernel; the agent supplies contextual reasoning and composition; the UI supplies a user-facing projection. Generative describes how these capabilities are created, adapted, and used, not permission to make storage or execution probabilistic.

The objective is generality with a small maintained platform. OpenKit MUST NOT require a visual app builder, a full frontend/backend declaration language, a business-specific workflow engine, or a custom code-hosting platform merely to preserve a few useful records. It is not intended to replace large professional CRM, supply-chain, retail, or other domain systems.

## Canonical Terms

**Light App** is a Workspace-owned unit of small durable application data and its meaning, optionally accompanied by reusable agent behavior and presentation. It belongs to exactly one Workspace. Its identity survives changes to display names, generated interfaces, and the agent currently using it. A Light App may contain several related collections; a collection is not automatically a separate app.

**Light App Catalog** is the Workspace-scoped discovery and management projection over its Light Apps. It exposes app identity, purpose, admitted schema revision, lifecycle/availability, provenance, and associated presentation or behavior resources. Catalog commands change the existing app or resource owner; the catalog is not a second schema, data, installation, or version authority.

**Generative Kernel** is a Light App's stable data kernel: its admitted schema and authoritative data. The schema includes structural constraints and the semantic description needed to interpret the data. Kernel operations expose this authority through governed interfaces. The term does not denote a shared business backend, an agent, a UI, or a new execution runtime.

**Generative UI** is agent-native presentation and interaction produced or selected for a current need through a host-admitted component and action contract. A widget or card is a presentation, not an additional business-data owner. Generative UI may use a Kernel, existing OpenKit records, external results, or task output; it does not require a Light App.

Agent retains its canonical meaning in [Runtime Model](runtime-model.md). This aspect defines agents as the Kernel's primary consumers, not a new class of Agent.

## Principles

- **Data integrity is the hard boundary.** Validation, constraints, concurrency, durable commit, and recovery are enforced by the owning deterministic services, never delegated to an agent's confidence or generated prose.
- **Agent-led management is the primary path.** Agents create, modify, and manage Light Apps in response to user intent through governed catalog and Kernel commands. Import/export is an additional path: a schema can create an app without UI or fixed functions, and associated Generative UI, MCP, Skills, or an Agent Plugin may accompany it. Neither a visual builder nor manual package authoring is required.
- **Agent understanding precedes useful action.** Structural discovery and business meaning are first-class interfaces. Agents should not have to infer a field's meaning from its label or reverse-engineer an application screen.
- **General operations precede specialized behavior.** Agents can compose useful reads and writes without a hand-authored business function for every task. Bounds protect the owned resource and transaction boundary, not an arbitrarily small list of business use cases.
- **Reuse existing agent facilities.** Stable scripts and optimized or sensitive functions use Agent Plugin, MCP, Skill, and execution facilities through their existing owners. A Kernel does not require its own plugin system or runner.
- **Presentation is optional.** Ordinary data work works headlessly. A user request or agent judgment may select an existing widget or propose a new one. Routine rendering, querying, validation, and admitted deterministic actions do not require a model call.
- **One authority per concern.** A schema file, schema introspection response, Plugin, agent context, and saved UI must not become competing authorities for current business data or authorization.

## Agent Understanding And Data Access

An authorized agent MUST be able to discover the Light App's identity, purpose, current schema revision, collections, fields, constraints, relationships, and supported operations. The semantic description MUST explain domain meaning that affects correct use: identifier namespaces, external source identity, units or enumerations where relevant, provenance and freshness, and which system owns a fact. The interface MUST distinguish missing semantic information from verified facts and identify unavailable capabilities rather than inventing them.

Schema and associated semantics MUST be versioned together. A consumer can discover a compact app overview and retrieve exact relevant schema and context without receiving every record, every Plugin, or an entire Workspace. Semantic descriptions and external content are data for reasoning, never instructions that can replace the caller's role or authorization.

General data interfaces MUST support schema-aware queries and mutations, including useful set-based and transactional operations within one Kernel. The interface SHOULD exploit native database capabilities instead of accumulating a bespoke query or workflow language. Exact syntax and supported operators are implementation contracts. A bounded query or database-language projection is acceptable only when it enforces app scope, supported statements, parameters, resource limits, and the same mutation invariants as every other entry point.

Agents MUST NOT receive unrestricted physical database or filesystem access as a substitute for the interface. Ordinary data operations cannot modify admission metadata, receipts, policy, credentials, other apps, or schema outside its evolution contract. An exposed capability's limits and refusal conditions MUST be discoverable so an agent can choose a valid alternative without guessing.

## Reusable Agent Behavior

A Light App MAY have fixed operations when optimization, repeatability, or sensitivity justifies them. They are optional conveniences or deliberately controlled effect paths, not a prerequisite for general data access. Agent Plugins group existing Skill and MCP resources; Skills may include instructions and CLI tools. Prefer a cohesive MCP surface over one server per function, without making a server mandatory for a data-only app.

Agents may create, revise, select, and use these resources through admitted catalog and execution operations. Resource availability, selection, and execution authority remain distinct. Publishing or installing a Plugin MUST NOT grant permissions, automatically inject it into every agent, execute installation hooks, or turn its code into trusted NanoCore code. Fixed operations identify their inputs, outputs, implementation revision, targets, and effects; stale or missing bindings remain explicit.

Internal Core roles may consume selected behavior resources only through their trusted entry-path assembly and existing capability rules. Loading a Skill supplies context; invoking MCP or CLI has an effect and needs an admitted execution path. Plugin content cannot expand the running role's tools, scope, audience, or budget. Heavy computation and script execution retain their existing runtime boundary; no internal role becomes a Worker or gains an AgentSession merely to understand a Light App.

## Presentation And Interaction

Agents may select a registered reusable presentation or propose one dynamically, using the same Core admission boundary. Reuse standard tool/UI-resource association and structured-result contracts: tools supply data or request rendering, resources supply presentation, and the host binds them without merging their authority. Headless data tools and render requests MUST remain separable: reading data need not show a widget, and showing a widget does not create a Kernel. Host-controlled rendering and current-authority action dispatch remain distinct responsibilities.

The host organizes the overall layout and uses its native component catalog by default. Specialized interaction MAY be delegated through one generic host component to an admitted Plugin HTML widget in an isolated browser context. The Plugin owns the implementation inside that region; it does not expand the native catalog for every customer-specific feature. Exact resource identity, supported capabilities, and a governed message bridge determine the delegation; an arbitrary URL or inline agent code cannot obtain host authority. Native and delegated regions exchange bounded typed data/events, never DOM access. A failed delegate leaves independent native regions usable and disables only interactions that depend on its unavailable result.

Agents may author new Plugin widgets as code resources through the existing development, validation, catalog, and capability owners. Registration and admission precede execution. Widget code remains untrusted even after publication; host isolation and server authorization are separate requirements.

An admitted widget binds an exact presentation version, source meaning, and supported actions. Business facts stay with their source. Historical results remain labeled historical; live views resolve current data; unsaved input remains a client draft until explicitly submitted. A saved view retains presentation intent and bindings, not copied grants, business truth, or an independent execution history.

Saving, reopening, or rendering MUST NOT rerun old effects or silently regenerate a definition. A stale action or unavailable source cannot be redirected to a replacement operation. UI confirmation is a projection of an owning human gate when one is required, never a substitute for that gate or an authorization grant.

## Durable Authority And Lifecycle

Each Light App MUST have an independently identifiable data and recovery boundary under its Workspace. Schema definitions may be authored as files; editable candidates MUST be distinguished from the schema revision actually admitted with the data. A failed schema-file write, import, or migration cannot leave two competing current definitions. Physical stores and portable representations remain projections of [Storage](storage.md).

Creation validates the proposed schema, semantic context, identities, and constraints before making the Kernel usable. Agent authoring and schema import reach this same admission boundary and publish the resulting app in its Workspace catalog. Export may carry the schema alone or explicitly selected associated presentation/behavior resources; business data is a separate explicit selection rather than an assumed part of a reusable schema. Imports verify provenance, dependencies, identities, and supported formats; associated resources retain their existing owners and require current target admission. Missing optional resources can leave an otherwise valid data app usable with those features explicitly unavailable. Schema changes name their expected base revision, validate existing affected data, and either commit the whole local change or preserve the previous state. A changed meaning that affects correct operations is a versioned schema change even when no physical column changes. Generated transformations cannot silently coerce, truncate, drop, or invent existing values.

Data mutations enforce structural constraints and applicable record or set preconditions within their transaction. Concurrent edits produce a valid commit or an explicit conflict. Supporting bulk operations cannot weaken lost-update protection or make a partially applied batch appear successful. A database constraint does not prove the agent's business judgment correct; provenance, current context, and necessary human decisions remain visible.

Retirement disables new mutations and effect invocation while retaining authorized inspection, evidence, and export. Reactivation revalidates current schema, dependencies, and authority. Destructive removal requires an explicit data-loss and recovery contract; schema history alone cannot recover deleted data. Backup and copying MUST cover schema, data, and required local metadata consistently. A copy is a new app identity with consistently rewritten internal references; it does not copy credentials, current grants, or authority over external systems.

Restart reads the committed schema and data and reconstructs disposable projections. Corruption, missing authority, stale revisions, unavailable Plugin versions, revoked membership, and failed dependencies produce explicit conditions. An agent or old widget MUST NOT repair missing truth by inference. Recovery restores verified owned data through the existing recovery authority.

Local data and external effects are different transaction domains. After an external write succeeds and a local annotation fails, the external success remains true and local persistence remains unresolved. Retry and deduplication use existing command or execution owners; no Kernel runner or synthetic combined receipt hides an unknown effect.

## Permissions And Accountability

The initial Workspace membership baseline is owned by [Permissions](permissions.md): an active member is eligible for the full Workspace operation set, including its Light Apps. No per-app role hierarchy or collection/field ACL is required. This is an authorization baseline, not a claim that every credential, internal role, or external account has every capability.

Current identity, membership, credential restrictions, Policy, Vault, disclosure, and required human decisions continue to govern each effect. Future finer rules use the same subject/action/resource/context seam; they should not require redesigning the Kernel or its clients. Sensitive and consequential operations MUST preserve attributable evidence under [Audit](audit.md), including the actor, target, relevant schema or implementation revision, request lineage, and outcome or explicit uncertainty, without recording secrets or creating a second audit authority.

## Observable Conformance

These are normative requirements for a conforming implementation, not claims that the current product implements them. Accepted Core direction does not establish implementation or publication readiness.

- A user can ask an agent to create and manage an app through its Workspace catalog, or import the same schema through the same admission boundary. Schema-only round trips work without UI or Plugin dependencies; optional resources do not gain authority from import.
- An authorized agent can discover a previously unseen app, distinguish two external systems' IDs, understand the relevant schema and provenance, and perform a valid query and mutation without a bespoke business tool or UI.
- Headless bulk data work and a widget action observe the same constraints, concurrency behavior, authorization, and authoritative results. Invalid or stale writes leave prior data intact.
- A failed migration or interrupted local transaction exposes either committed valid state or the prior state; backup and restore demonstrate exact data recovery for the supported contract.
- Copying an app preserves schema meaning and data relationships while establishing new app identity and no inherited external authority.
- Publishing shared executable presentation resources applies the existing effect-proportional preview/confirmation and Policy rules; an already admitted exact render does not invent another approval lifecycle.
- A selected Plugin operation runs only its admitted version through the owning capability or runtime; Skill text, MCP metadata, and widget declarations cannot grant execution rights.
- A widget over existing non-Kernel data works independently; saved views reopen without model regeneration or action replay and display missing or stale sources explicitly.
- Two active Workspace members receive the same membership-derived operation eligibility; removed members and unrelated users do not. Credential, Policy, and human-decision restrictions still apply, and sensitive effects retain attributable evidence.

## Relationships And Realization

[Architecture](architecture.md) owns placement and App/Core/Agent responsibility; [Agent Supply](agent-supply.md) owns behavior-resource supply; [Agent Capability](agent-capability.md) owns governed invocation and internal Tool admission. [Protocol](protocol.md), [Storage](storage.md), [Permissions](permissions.md), [Vault](vault.md), and [Audit](audit.md) retain their existing authority. This aspect composes them without new identity, policy, storage, execution, or recovery planes.

Schema file format, database engine and paths, query syntax, MCP and CLI payloads, Plugin package layout, renderer protocol, widget-resource representation, and concrete internal-role selection are implementation decisions. They MUST preserve this model without being promoted into additional universal business concepts.
