#!/usr/bin/env bash
# Usage: ./scripts/release.sh 0.2.0
#
# Bumps the version in package.json and tauri.conf.json,
# commits the change, creates a git tag, and pushes everything.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>  (e.g. $0 0.2.0)"
  exit 1
fi

# Strip leading 'v' if provided (e.g. v0.2.0 -> 0.2.0)
VERSION="${VERSION#v}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

echo "==> Bumping version to $VERSION"

# Update package.json
cd "$ROOT"
npm version "$VERSION" --no-git-tag-version --allow-same-version

# Update tauri.conf.json
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
if command -v python3 &>/dev/null; then
  python3 -c "
import json, sys
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['version'] = '$VERSION'
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"
else
  # Fallback: sed
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$TAURI_CONF"
fi

# Update Cargo.toml
CARGO_TOML="$ROOT/src-tauri/Cargo.toml"
sed -i '' "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$CARGO_TOML"

echo "==> Committing and tagging v$VERSION"
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "release v$VERSION"
git tag "v$VERSION"

echo "==> Pushing to origin"
git push && git push --tags

echo ""
echo "Done! GitHub Actions will now build the release."
echo "Check progress at: https://github.com/qformedia/compi-builder/actions"
