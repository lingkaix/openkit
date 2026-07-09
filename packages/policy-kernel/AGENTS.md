# Policy Kernel Package

Read `README.md` first. This file contains only local agent execution rules for the policy kernel package.

## Local Agent Rules

- Keep this package product-neutral and storage-neutral.
- Do not import from apps, MCP, Web, NanoCore internals, runtime adapters, or storage code.
- Use NGAC and Policy Machine concepts as the theory base, but do not claim full NGAC standards conformance.
- Keep product-specific helper names in adapter layers, not in this package.
- Use tests first for authorization behavior changes.
- Document exported types, functions, classes, and methods with JSDoc.
