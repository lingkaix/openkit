# Smoke Tests

This directory owns direct-execution checks for built release artifacts.

Smoke scripts start the built artifact, verify its minimum health surface, and shut it down without becoming product workflow or regression suites. NanoCore process/API behavior belongs in `apps/nanocore/e2e/`, and package or module behavior belongs in its L1 owner.

Run the complete built-artifact smoke gate from the repository root:

```bash
pnpm -w test:smoke
```

Individual scripts may be run directly after building their owning artifact. Smoke scripts do not receive sibling unit tests; non-trivial behavior must move to the lowest existing L1-L4 owner instead.
