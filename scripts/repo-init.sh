#!/usr/bin/env bash

set -euo pipefail

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

echo "✓ Node is installed ($(mise exec -- node -v))"
echo "✓ pnpm is installed ($(mise exec -- pnpm -v))"
echo "✓ Bun is installed ($(mise exec -- bun --version)) [optional runtime]"
echo "✓ TypeScript is available through the workspace toolchain"

# Install dependencies
echo "📦 Installing dependencies with pnpm..."
mise run install

if [ -f "lefthook.example.yml" ] && [ ! -f "lefthook.yml" ]; then
    mv "lefthook.example.yml" "lefthook.yml"
    echo "✓ Promoted lefthook.example.yml to lefthook.yml"
fi

# Set up tracked git hooks if .git directory exists
if [ -d ".git" ]; then
    echo "🔧 Installing Lefthook-managed git hooks..."
    mise run hooks
    echo "✓ Git hooks installed"
else
    echo "⚠️  Not a git repository. Skipping git hooks setup."
fi

echo ""
echo "✅ Initialization complete!"
echo ""
echo "Next steps:"
echo "  1. Review CONTRIBUTING.md for development guidelines"
echo "  2. Review AGENTS.md for AI coding guidelines"
echo "  3. Review docs/cookbooks/ for optional non-JS/TS setup flows when needed"
echo "  4. Run 'mise run dev' to start development mode"
echo "  5. Run 'mise run verify' to run the full repository validation suite"
echo ""
echo "Happy coding! 🎉"
