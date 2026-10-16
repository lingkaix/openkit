# Candidate Artifact

Use this reference to return a complete proposed Skill through an existing JSON Artifact. This is transport data, not a host filesystem path or a catalog command.

The Artifact body is a JSON array. Each entry is a directory or a regular file with a root-relative path:

```json
[
  {"kind":"directory","path":"references"},
  {"kind":"file","path":"SKILL.md","executable":false,"contentBase64":"<base64 of exact UTF-8 bytes>"},
  {"kind":"file","path":"references/domain.md","executable":false,"contentBase64":"<base64 of exact bytes>"}
]
```

The placeholders explain the fields; replace them with actual file bytes. Do not wrap the array in an object or include commentary in the Artifact body. A directory has no file payload. `executable` is a normalized boolean for a regular file, not an arbitrary permission mode. Include scripts, references, assets, licenses, empty files and any required empty directories. Preserve exact bytes; Core computes the tree digest independently.

The complete Skill is limited to 16 MiB of file bytes, 1,024 entries including directories and 32 directory levels. Paths use `/`, already use Unicode NFC and contain no absolute, empty, dot, parent or backslash segments. No `.git` path, duplicate path, link, device or other special file is admitted. Root `SKILL.md` must be valid UTF-8 with a YAML mapping containing nonempty string `name` and `description`. Descriptive metadata, including `allowed-tools`, grants no OpenKit authority.

Retain the Artifact's actual Workspace/id/version/content digest. An authorized user or coordinator explicitly selects that exact retained Artifact and the exact candidate base (null only for a new entry), with a bounded non-secret summary and available work/evidence references. Core must verify current source access, exact retained bytes and original producer lineage before candidate creation. The submitting user is distinct from the producing Worker. An imported or incomplete source must not acquire invented Turn or Worker history.

If the public candidate command does not yet support this exact Artifact selection, report the integration gap and return the reviewable Artifact. Do not replace the missing route with a host path, management token, direct catalog write or fabricated success. A proposed candidate changes no active selection. Promotion and pinning use their own current authority, exact expected revisions and retained decision evidence.
