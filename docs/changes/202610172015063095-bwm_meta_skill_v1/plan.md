---
type: change-plan
status: implemented
---
# BWM Meta-Skill v1

## Intent Revision 1

The engineer settled the BWM design and the coordinator approved this bounded plan on 2026-10-18. Write a general domain Meta-Skill in skills/ that a Worker follows inside an approved Goal to turn supplied business materials into four human-reviewable proposals: a domain Skill, Light App schema, Gateway tool rules and Knowledge model. Use existing operations and the Knowledge Manager, preserve uncertainty and treat inbound content as data. Follow the existing correction-to-candidate-v2 and human-selection loop. Add no product code, Core type, runner, evaluation machinery, privileged Worker path or automatic adoption. The coordinator accepted the operations-only scope of skills/AGENTS.md; no AGENTS.md edit is required.

## Intent Revision 2

The coordinator's go requires only the existing top-level skills/README.md to change, an independent Sol review, an exact local gate under lane rule 2 and express landing on green. The separate dev probe is prepared after landing for coordinator dispatch. Knowledge steps target intended KM behavior and are marked as requiring the parallel KM fix in that probe. The first synthetic validation covers intake, four proposals, human review and pin, one application read/draft/App-approved fake send with pinned-version lineage, a correction and two next-case version runs for human selection. A live result is not claimed by authoring this Skill.

## Owner And Boundary Map

[Work Model](../../core/work-model.md) and [Goal Mode](../../specs/20261002-goal.md) retain work admission and responsible-person completion. [Skill Catalog](../../specs/20260711-skill_catalog_versioning_pinning.md) owns candidate submission, exact-byte lineage, pinning, exact run selection and rollback. [Generative Kernel](../../specs/20260908-generative_kernel_data_operations.md) owns declarative schemas, catalog selection, explicit activation and snapshot restore. [Knowledge](../../core/knowledge.md) and [Knowledge Manager](../../specs/20260704-knowledge_manager_internal_agent_runtime.md) own grounded queries, bounded maintenance and governed publication. [Remote MCP](../../specs/20261002-remote_mcp_interface.md) owns public discovery and call; [Pending Requests](../../specs/20260930-pending_requests.md) retains human effect decisions. The authored Skill is non-authoritative guidance over these owners, not an owner amendment.

The representation seams are retained Skill tree/Artifact bytes to catalog candidate, definition JSON to catalog versus live schema, KM source references to its review outcome, and exact Skill selection to Turn/AEP/effect evidence; existing Artifact Reviews retain exact output choice independently from catalog adoption. The Skill directs current-schema discovery and preserves actual returned identities. It introduces no serializer or storage implementation. A Worker without management authority returns the existing Artifact to an authorized caller rather than gaining new authority.

## Section Ablation

| Retained content | Why the first synthetic run needs it |
| --- | --- |
| Entry purpose | Select the intake compiler without assuming an industry or hidden authority. |
| Establish the work | Bind the Worker to the approved Goal Plan and available capabilities. |
| Read the intake | Distinguish written criteria, interviews, current records and hostile inbound instructions. |
| Prepare four proposals | Produce all four reviewable outputs from the same sources. |
| Obtain human decisions | Prevent candidate adoption or configuration from masquerading as effect approval. |
| Run the accepted domain Skill | Observe read, draft, captured approval, fake effect and actual pinned Skill evidence. |
| Incorporate a correction | Reach candidate v2 and next-case human comparison through existing operations. |
| Return a truthful handoff | Keep missing capabilities and unproved outcomes visible without closing the human-owned Goal. |
| intake.md: source set | Retain source support and conflicting claims rather than assume a correct answer. |
| intake.md: data/instructions | Ignore the embedded applicant instruction and preserve the approved audience. |
| intake.md: KM | Query and integrate through the intended grounded KM route. |
| intake.md: work extraction | Derive only needed decisions, state, tools, errors and questions. |
| proposals.md: candidate | Submit exact complete bytes without adding Worker management credentials. |
| proposals.md: Light App | Prepare valid declarative state and separate import from live application. |
| proposals.md: Gateway | Present exact tool rules for human choice while exposing the absent dedicated review primitive. |
| proposals.md: Knowledge | Prepare source-linked model content and retain KM review/publication evidence. |
| proposals.md: handoff | Keep the four separate outcomes and interrupted operations truthful. |
| improvement.md: correction | Preserve the actual v1 base and authorized change. |
| improvement.md: next case | Compare v1/v2 using two ordinary exact-version runs without duplicate sensitive effects. |
| improvement.md: choice | Retain human choice and use existing promotion/pin or rollback operations. |

## Working Checkpoint

Four Skill files and the existing top-level guide are authored; no Skill-internal README, scripts, product code, new schema or generated API/CLI changes are needed. The entry is 51 lines against a 150-line limit. Metadata quick validation passed. The initial committed head 73919633 passed its lane local gate including the complete existing Skill interface, public-redaction and archive suites. Independent provisional source review found no blocking defect. A non-blocking naming note now uses discovery-supplied Tool names, and the existing Artifact choice operation is stated explicitly. Final-head review and the exact gate remain pending. The external lane checkpoint and rc.12 gap inventory retain execution state; they are not design authority. No dev, host, deployment, publication or real effect has run in this change.

## Verification And Remaining Proof

Local evidence must cover Skill metadata, self-contained reference links, declared operation identities and existing complete operations Skill interface/redaction/archive suites, plus the lane local gate. No production module changed. The dev probe separately proves actual grounded KM work, retained outputs, human decisions, native Skill consumption, approved fake effect, audit joins and next-case comparison. Gateway lacks a dedicated proposal/review operation. No aggregate Skill comparison operation is present, but ordinary exact-version Turns and artifact.review.select on existing output Reviews provide the bounded human comparison/choice path. No aggregate mechanism is required or added. The KM fix and live journey are outstanding dependencies/proof, not successful results.

Complexity: six authored/updated files, no owning document changed, no registry or closed set added. Existing work, Skill, Kernel, Knowledge and approval owners are consumed without changing their contracts.

## Intent Revision 3 — BWM Support Text

After R093 landed, the coordinator assigned the engineer-approved 2026-10-18 03:58Z text change. A domain Skill, Gateway rules and typed OKF Knowledge remain the required proposals. A Light App proposal is optional and limited to glue instance data that no external system owns. Cross-system links retain their match basis as ordinary fields; cross-system work progress may also be local. Concept, role and relationship definitions belong to Knowledge Entity/Topic pages or the domain Skill. General knowledge receives no business model. Knowledge output uses existing base types plus proposed Scope Schema domain types for human review; Rule pages declare applies_to. Safety-critical execution rules belong in the pinned domain Skill. This text consumes the existing Kernel, Knowledge and Skill owners; it adds no product code or mechanism.

## Support Text Ablation

- SKILL.md, intake.md, proposals.md and the top-level guide replace the mandatory Light App with conditional glue data, because the source systems already own the business records.
- The Knowledge proposal changes from untyped prose to typed OKF pages and human-reviewed Scope Schema proposals, because rules need a tool/step lookup target and effects need their basis and last check.
- Domain Skill guidance includes safety-critical execution rules in the pinned bytes, because a case must receive these rules without relying on a successful Knowledge retrieval.

The existing Goal Plan, separate human decisions, exact catalog versions, captured effect approval and candidate-to-v2 selection loop keep their owners. improvement.md is unchanged. The external B01 probe follows the conditional schema output; live KM and workflow evidence remain separate from this text landing.

## Intent Revision 4 — Workspace Onboarding

The coordinator approved the 12-line onboarding plan on 2026-10-18 at 12:00Z, including the engineer's push-versus-pull and domain Skill boundary addenda. The human creates an empty Workspace and approves the onboarding Goal Plan. The Meta-Skill prepares role Skills, Knowledge, system connections and tool rules, zero or more needed glue apps and supported recurring work for separate human adoption. Pinned Skills push frequent or costly execution rules; Knowledge supplies retrieved reference information. Every costly rule names an independent decision-point check. Domain Skill Markdown states responsibility, authority, information access and per-action rules, evidence, effects and side effects, consistently with Policy/tool rules and Knowledge references. No new schema or product capability is authorized by this content.

The external restaurant-group intake tests non-case work with synthetic files only. Human reviews of setup outputs and a fixed downstream task set use existing records for outcomes, corrections, Turns, usage, time, approvals, denials and escalations. A corrected Meta-Skill uses existing exact-version candidate and selection paths in fresh Workspaces; the human chooses. Unsupported checks, formal rule-review adoption, missing evidence joins or required connector/write-back capabilities go to the rc.12 gap list. The full loop runs in rc.11 on final formats; this additive text may land before the pre-reset cut.

## Onboarding Text Ablation

- The empty-Workspace checklist and connection proposals cover setup that the existing-case entry cannot perform; actual creation and configuration retain their existing human authority.
- Distinct role Skills, push/pull placement, boundary and information-map sections make the instructions needed at execution available in the selected Skill. Independent checks address costly errors that pushed text alone cannot enforce.
- Multiple optional glue apps and report, analysis, content and recurring-work proposals cover work outside one admissions case without relocating external truth or adding a runner.
- Existing-record measurement and fresh-Workspace v1/v2 comparison expose setup quality and downstream authority mismatches without an evaluator, score or new durable record.

Verification remains metadata, reference/operation inspection, complete Skill interface/redaction/archive suites, the exact lane gate and independent Sol review. The synthetic files and text are not live acceptance. No product module, public contract, generated API/CLI, Web code, schema or registry changes.
