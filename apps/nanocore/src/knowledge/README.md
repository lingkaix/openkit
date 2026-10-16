# Knowledge Format

This directory owns the portable OKF v0.2 Markdown parser, OpenKit knowledge-profile validation and the immutable notebook content boundary.

## Boundaries

- `okf.ts` parses one YAML frontmatter mapping with bounded aliases, retains nested metadata, derives concept identity, validates reserved Markdown structure and conformance levels, and rejects secret-shaped fields recursively.
- The v4 profile requires a complete `scope` owner mapping and both `openkit.knowledge-owner-scope.v1` and `openkit.knowledge-git-notebook.v1` in `requiredFeatures`. Governed validation rejects unsupported required semantics, parallel `owner_scope` and `openkit_revision` fields; generic external OKF parsing remains permissive. `validateKnowledgePageCandidate` accepts `scopeSchemaText` and `expectedOwnerScope`, and successful schema validation reports `scope-schema-valid` with `scopeSchemaVersion`. The expected owner comes from trusted admission; page metadata grants no permission.
- `notebook-validation.ts` owns structural final-tree validation in the coordinated notebook cutover. Current source disclosure, authorization and publication remain native publisher duties.
- `notebook-publication.ts` joins fixed-base human Workspace edits to the existing Audit and command receipt owners. It retains admission before the Git CAS and completion before success, reconstructs exact old results from their commits, and refuses missing completion evidence. Its native current-authority callback is mandatory. The component admits non-destructive edits only and is not a live API or a substitute for the remaining coordinated cutover and required Review path.
- `notebook-entry-publication.ts` projects retained create/update commands into that same publisher, with an explicit fixed base and stable concept path. Their receipts retain the original command identity and immutable commit, without nested notebook receipts. Service timestamps come from the exact admitted candidate on explicit retry; a missing completion receipt remains recovery_required. Native callers retain current admission and exact source disclosure.
- `updateOkfFrontmatter` is the shared YAML edit boundary for changing managed fields while retaining unknown metadata and the selected exact Markdown body.
- Parsed computation, executor, attester, provenance, generation, and verification metadata remains inert data; this directory does not execute code, access networks, attest runs, or grant authority.
- Knowledge routes, ledgers, retrieval, indexes, and portable file storage remain with their existing feature and storage owners.
- Page `source_refs` validation and source-reference indexes share `resolveRegisteredKnowledgeSourceReference`: bare ids require an owning-scope registry target and pins additionally require its matching digest. Registry resolution preserves citation bytes and supplies no review, captured-byte integrity, or retrieval authorization proof.
- `notebook.ts` uses a bare local Git repository for exact immutable page trees, unpublished candidates, published-ref compare-and-set and retained history. Git messages preserve strict historical admission facts; these facts grant no current permission. No working tree, hooks, network or model-supplied Git arguments are exposed. Git owns its repository internals; product calls do not recursively inspect configuration and object directories or defend against an administrator redirecting them.
- The notebook content boundary is not yet joined to existing Workspace page producers and retrieval. Do not initialize it as an alternative live authority for an existing notebook; the coordinated cutover must replace every old reader and writer together. Current scope/source admission, OKF validation, Audit, command receipts, required human decisions and suppression remain mandatory responsibilities of the common publisher and its callers.
- Profile/schema v4 is a cutover component, not an independent activation path. All live callers must use the Scope schema API and `schema/scope-schema.yaml` with fresh Git notebook initialization; pre-stable data uses the approved reset boundary without offline conversion. There is no v2 fallback. Notebook Git commits own revisions; pages carry no revision counter.
- Keep parsing deterministic and independent of database, provider, and HTTP concerns.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/knowledge` and the affected Knowledge Store tests.

See [Research Cookbook](../../../../docs/cookbooks/research.md).
