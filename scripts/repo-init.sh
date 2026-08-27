#!/usr/bin/env bash

set -euo pipefail

# Bootstrap is the one place that invokes tools through `mise exec --`, because it runs
# before the pinned toolchain is guaranteed to be on PATH. Every documented command after
# bootstrap is a bare `pnpm ...`; see docs/toolchain.md for why that boundary exists.

echo "🚀 Initializing monorepo development environment..."

# Check if we're in the root directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the repository root."
    exit 1
fi

if [ ! -f ".mise.toml" ]; then
    echo "❌ Error: .mise.toml not found. Tool versions must be managed by mise."
    exit 1
fi

if ! command -v mise >/dev/null 2>&1; then
    echo "❌ mise is required but not installed."
    echo "   Install mise from: https://mise.jdx.dev/getting-started.html"
    exit 1
fi

echo "📦 Installing toolchain from .mise.toml..."
MISE_YES=1 mise trust .mise.toml >/dev/null 2>&1 || true
mise install
mise reshim >/dev/null 2>&1 || true

PINNED_NODE_VERSION="$(mise exec -- node -v)"
PINNED_PNPM_VERSION="$(mise exec -- pnpm -v)"

echo "✓ Node is installed (${PINNED_NODE_VERSION})"
echo "✓ pnpm is installed (${PINNED_PNPM_VERSION})"
echo "✓ TypeScript is available through the workspace toolchain"

# Install dependencies
echo "📦 Installing dependencies with pnpm..."
mise exec -- pnpm install

# Set up tracked git hooks if .git directory exists
if [ -d ".git" ]; then
    echo "🔧 Installing Lefthook-managed git hooks..."
    mise exec -- pnpm run hooks:install
    echo "✓ Git hooks installed"
else
    echo "⚠️  Not a git repository. Skipping git hooks setup."
fi

# The repository documents bare `pnpm ...` as the command form, so bootstrap ends by
# checking that the invoking environment actually satisfies that. A missing shims
# directory is reported here as one actionable instruction instead of surfacing later as
# a silent version mismatch in whichever shell forgot it.
MISE_SHIMS_DIR="${MISE_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/mise}/shims"

pinned_toolchain_on_path() {
    command -v node >/dev/null 2>&1 &&
        command -v pnpm >/dev/null 2>&1 &&
        [ "$(node -v 2>/dev/null)" = "${PINNED_NODE_VERSION}" ] &&
        [ "$(pnpm -v 2>/dev/null)" = "${PINNED_PNPM_VERSION}" ]
}

echo ""
if pinned_toolchain_on_path; then
    echo "✓ Bare 'node' and 'pnpm' resolve to the pinned toolchain in this environment"
else
    echo "⚠️  Bare 'node' or 'pnpm' does not resolve to the pinned toolchain here."
    echo "    Repository commands are documented as bare 'pnpm ...', including for agents"
    echo "    running non-interactive shells where 'mise activate' hooks never load."
    echo "    Put the mise shims directory on PATH so that stays true:"
    echo ""
    echo "      export PATH=\"${MISE_SHIMS_DIR}:\$PATH\""
    echo ""
    echo "    Add it to your shell profile, and to the environment of any agent or sandbox"
    echo "    that runs repository commands."
fi

echo ""
echo "✅ Initialization complete!"
echo ""
echo "Next steps:"
echo "  1. Review CONTRIBUTING.md for development guidelines"
echo "  2. Review AGENTS.md for AI coding guidelines"
echo "  3. Review docs/cookbooks/ for optional non-JS/TS setup flows when needed"
echo "  4. Run 'pnpm dev' to start development mode"
echo "  5. Run 'pnpm verify' to run the repository validation suite"
echo ""
echo "Happy coding! 🎉"
