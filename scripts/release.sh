#!/usr/bin/env bash
# Usage: ./scripts/release.sh 0.2.0
#
# Bumps the version in package.json, tauri.conf.json, and Cargo.toml,
# commits, creates a git tag, and pushes.
# Requires a clean working tree (no uncommitted, staged, or untracked work)
# so a release tag cannot miss new source files that exist only on disk.

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
cd "$ROOT"

require_clean_working_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    echo "==> Error: working tree is not clean."
    echo "    Commit or discard all changes (including untracked files) before releasing,"
    echo "    so the tag includes every new file. Refusing to bump version or tag."
    echo ""
    git status --short
    exit 1
  fi
}

verify_bump_touches_only_version_files() {
  # After bump, only the known version-bump files should be modified; nothing else.
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      package.json|package-lock.json|src-tauri/tauri.conf.json|src-tauri/Cargo.toml|src-tauri/Cargo.lock) ;;
      *)
        echo "==> Error: after version bump, unexpected path changed: $f"
        echo "    Only the standard version files should differ. Refusing to commit or tag."
        git status --short
        exit 1
        ;;
    esac
  done < <(
    (git diff --name-only; git diff --name-only --cached; git ls-files --other --exclude-standard) | sort -u
  )
}

echo "==> Verifying a clean working tree (required to avoid partial tags)"
require_clean_working_tree

echo "==> Bumping version to $VERSION"

# Update package.json
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

echo "==> Verifying that only version files were modified"
verify_bump_touches_only_version_files

echo "==> TypeScript typecheck (match CI; fail before tag if imports are broken)"
npm run typecheck

echo "==> Committing and tagging v$VERSION"
# Include Cargo.lock when it is part of the version bump (safe no-op if unchanged)
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock

git commit -m "release v$VERSION"
git tag "v$VERSION"

echo "==> Pushing to origin"
git push && git push --tags

echo ""
echo "Done! GitHub Actions will now build the release."
echo "Check progress at: https://github.com/qformedia/compi-builder/actions"
