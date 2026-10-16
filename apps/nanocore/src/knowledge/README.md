# Knowledge Format

This directory owns the portable OKF v0.2 Markdown parser, OpenKit knowledge-profile validation and the immutable notebook content boundary.

## Boundaries

- `okf.ts` parses one YAML frontmatter mapping with bounded aliases, retains nested metadata, derives concept identity, validates reserved Markdown structure and conformance levels, and rejects secret-shaped fields recursively.
- `updateOkfFrontmatter` is the shared YAML edit boundary for changing managed fields while retaining unknown metadata and the selected exact Markdown body.
- Parsed computation, executor, attester, provenance, generation, and verification metadata remains inert data; this directory does not execute code, access networks, attest runs, or grant authority.
- Knowledge routes, ledgers, retrieval, indexes, and portable file storage remain with their existing feature and storage owners.
- Page `source_refs` validation and source-reference indexes share `resolveRegisteredKnowledgeSourceReference`: bare ids require an owning-scope registry target and pins additionally require its matching digest. Registry resolution preserves citation bytes and supplies no review, captured-byte integrity, or retrieval authorization proof.
- `notebook.ts` uses a bare local Git repository for exact immutable page trees, unpublished candidates, published-ref compare-and-set and retained history. Git messages preserve strict historical admission facts; these facts grant no current permission. No working tree, hooks, network or model-supplied Git arguments are exposed.
- The notebook content boundary is not yet joined to existing Workspace page producers and retrieval. Do not initialize it as an alternative live authority for an existing notebook; the coordinated cutover must replace every old reader and writer together. Current scope/source admission, OKF validation, Audit, command receipts, required human decisions and suppression remain mandatory responsibilities of the common publisher and its callers.
- Keep parsing deterministic and independent of database, provider, and HTTP concerns.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/knowledge` and the affected Knowledge Store tests.

See [Research Cookbook](../../../../docs/cookbooks/research.md).
