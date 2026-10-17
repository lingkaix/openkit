# STOP recovery backup

Do not merge this branch. It contains a recovery archive and the stopped checkpoint, not a source integration tree.

The archive preserves historical modified tracked files and unresolved index stage blobs in the four worktrees named by manifest.json. Original worktrees remain in place. Generated dist and node_modules symlinks are excluded. Inspect the manifest and restore only the named files needed after an explicit coordinator RESUME.

The source candidate remains on lane/aw. checkpoint.md records exact heads, completed checks and the next permitted step.
