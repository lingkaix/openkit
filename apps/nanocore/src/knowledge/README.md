# Knowledge Format

This directory owns the portable OKF v0.2 Markdown parser and OpenKit workspace knowledge-profile validation.

## Boundaries

- `okf.ts` parses one YAML frontmatter mapping with bounded aliases, retains nested metadata, derives concept identity, validates reserved Markdown structure and conformance levels, and rejects secret-shaped fields recursively.
- `updateOkfFrontmatter` is the shared YAML edit boundary for changing managed fields while retaining unknown metadata and the selected exact Markdown body.
- Parsed computation, executor, attester, provenance, generation, and verification metadata remains inert data; this directory does not execute code, access networks, attest runs, or grant authority.
- Knowledge routes, ledgers, retrieval, indexes, and portable file storage remain with their existing feature and storage owners.
- Keep parsing deterministic and independent of database, provider, and HTTP concerns.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/knowledge` and the affected Knowledge Store tests.

See [Research Cookbook](../../../../docs/cookbooks/research.md).
