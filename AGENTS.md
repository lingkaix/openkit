# AI Agent Coding Guidelines

This file is the concise execution rulebook for agents working in this repository.

## A Rule: 我们的项目处在内部开发中，因此在做设计、决策、实现和修改时，不要考虑任何向后兼容的问题

## Operating Model

- Agents execute well-scoped work end-to-end.
- Engineers own architecture, trade-offs, and final approval.
- Prefer explicit rules over tribal knowledge.
- Current product development is MCP-first and NanoCore-first: use external coordinator agents through `@openkit/mcp` to dogfood the system, discover gaps, and harden the kernel before treating the Web UI as the primary product build surface.
- Stabilize core behavior in protocol, schemas, NanoCore, public App API, and MCP contracts first. Reflect that stable behavior in the Web UI after the kernel contract is reliable instead of using UI work as the default starting point for core behavior.
- Testing follows the accepted L0-L6 model: L0 static repo checks, L1 package and app unit tests, L2 contract and conformance tests, L3 NanoCore black-box e2e, L4 Web browser e2e, L5 smoke and artifact health tests, and L6 story acceptance. Keep L6 agent-first, keep deterministic adapters only where useful, and reduce confirmed L6 defects into L1-L5 regression coverage.
- Current protocol design is being advanced by keeping `packages/protocol`, `apps/nanocore`, and `apps/web` structurally aligned.
- Default protocol iteration follows one of two paths:
  1. Research-driven path: when external projects, repositories, docs, papers, articles, or prior-art comparisons are needed, start the `.codex/agents/researcher.toml` sub-agent. Research evidence, cloned repositories, notes, and generated reports stay under `temp/research/<date>-<slug>/` and are not committed. The main agent reviews the researcher output, cross-checks it against primary sources and available tools such as DeepWiki, CodeGraph, Graphify, or local source inspection, then promotes accepted conclusions into `docs/specs/`, `docs/core/`, `docs/changes/`, or other canonical project documents before implementation. Improve the protocol first, implement the update in `apps/nanocore`, then reflect the change in `apps/web`.
  2. UI-play path: when a developer plays with the UI and proposes an end-user-facing change, the agent should first decide whether the current protocol must change to support the request; if so, update the protocol first, then update the `apps/nanocore` server, and finally reflect the upgraded behavior in the UI.
- When aligning changes across packages, update and commit each package separately in sequence (e.g., commit `packages/protocol` first, then `apps/nanocore`, then `apps/web`). This keeps the history linear, reviewable, and bisectable.

## Mandatory Rules

### 1. Test-first development

- Before writing tests, choose an implementation shape that keeps the feature path maintainable, discoverable, cohesive, and easy to review.
- Write tests first for every feature and bugfix.
- Prefer two commits for behavior changes:
  1. `test: add tests for <feature>`
  2. `feat|fix(<scope>): implement <feature>`
- After the test and implementation pass, do a code-quality review for simplicity, cohesion, duplication, unnecessary abstractions, and traceability.
- Use one or more follow-up commits when the post-TDD review finds maintainability improvements that should be separated from the initial implementation.
- Do not ship behavior changes without tests.

### 2. Document code

Document every type, interface, struct, class, function, and method using the standard format for that language:

- JS/TS: JSDoc
- Go: GoDoc
- Python: PyDoc / PEP 257
- Rust: RustDoc

Documentation should cover purpose, parameters, return values, and error behavior where relevant.

### 3. Keep specs and change records current

- Follow `docs/change-tracking.md` before adding files under `docs/specs/`, `docs/changes/`, or `docs/working_logs/`.
- Use `docs/specs/` for non-trivial changes:
  - architecture or workflow changes
  - public API changes
  - rollout or migration planning
  - work with meaningful trade-offs
- Use `docs/changes/` for material change lifecycle records: write change plans before significant work, keep curated progress checkpoints during execution, and finish with implementation summaries for major PR, standalone, or release-level records.
- Every material change record must link related core architecture, product design, and spec docs where relevant, especially `docs/core/architecture.md`, `docs/core/work-model.md`, `docs/product-vision.md`, and applicable `docs/specs/` files.
- Use `docs/working_logs/` for archived release PRDs, task lists, and progress logs from long-run agent cycles.
- Keep spec and change record aligned with implementation.

Filename rules:

- specs: `YYYYMMDD-short_name.md`
- changes: `[datetime]-[short_name].md`

### 4. Use Conventional Commits

Commit messages must follow:

```text
<type>[optional scope]: <description>
```

Allowed types:

- `feat`
- `fix`
- `docs`
- `test`
- `refactor`
- `perf`
- `build`
- `ci`
- `chore`

### 5. Follow local guides and cookbooks

- Every important directory must contain a local `README.md`.
- `README.md` is the directory-level source of truth for purpose, scope, architecture boundaries, commands, test/build usage, file maps, human workflow, and links to related design documents.
- `AGENTS.md` is optional. Create or keep it only when the directory has local agent execution rules that are not already covered by the root `AGENTS.md` or the local `README.md`.
- When a directory has `AGENTS.md`, the file must state that agents should read the sibling `README.md` first and that `AGENTS.md` contains only local agent execution rules.
- Do not duplicate general background, module descriptions, command tables, or design context from `README.md` into `AGENTS.md`.
- Before changing a concrete app or package, read its local `README.md` and, when present, its local `AGENTS.md`.
- If a relevant cookbook exists in `docs/cookbooks/`, follow it.
- Do not handcraft new sub-project starter files unless a cookbook explicitly allows it.

### 6. Preserve code quality

- Keep files focused and cohesive.
- Minimize coupling between modules.
- Optimize for maintainability and discoverability over file-size targets; do not treat line count as a quality metric.
- It is acceptable to keep related logic in one larger cohesive file, or a small set of cohesive files, when that makes the full implementation easier to search, read, and maintain.
- Keep complete feature paths easy to trace from one clear entry point.
- Avoid scattering one implementation across many helpers, types, classes, files, or packages unless the split removes real complexity.
- Prefer direct, readable flow over unnecessary intermediate states, wrapper functions, and pass-through abstractions.
- Reuse existing patterns before creating parallel implementations for similar scenarios.
- Prefer small, reviewable changes.
- Refactor when needed to keep boundaries clear, but stay scoped to the task.

### 7. Keep repository text in English

- All code, comments, and documentation must be in English.
- All documentation must be Markdown.

## Execution Checklist

Before finishing work, verify:

- tests were added first for behavior changes
- maintainability and discoverability were considered before test design
- post-TDD code-quality review was completed when behavior changed
- new code is documented
- specs are updated for non-trivial changes
- change records are updated
- local guides are updated when an app or package changed
- relevant cookbook guidance was followed
- lint, typecheck, tests, and build pass locally
- no new linter errors remain

## Working Rules

### When editing existing code

- Read the current implementation first.
- Follow existing patterns unless there is a clear repository-level reason to change them.
- Avoid unrelated refactors.

### When working on apps, packages, CI, or setup

- Check `docs/cookbooks/` first.
- Prefer official CLIs, framework generators, or approved templates.
- Keep setup instructions and automation in version-controlled files.

### When adding dependencies

- Use the package manager to add them.
- Prefer maintained current versions unless the user requests otherwise.
- Commit the appropriate lockfile updates.
- Document why the dependency exists when it affects workflow or architecture.

## Quick References

- Repository entry point: `README.md`
- Human workflow: `CONTRIBUTING.md`
- Template design: `docs/template-overview.md`
- Setup/ops recipes: `docs/cookbooks/`
- App guides: `apps/README.md`
- Package guides: `packages/README.md`

## Notes

**在输出任何文本时，禁止在一个完整的语句或段落内插入换行符**
