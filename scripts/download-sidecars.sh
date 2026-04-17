#!/usr/bin/env bash
# Download yt-dlp sidecar binaries for all target platforms.
# Run this before building the app: npm run setup-sidecars
#
# Binaries are placed in src-tauri/binaries/ with Tauri target-triple suffixes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BIN_DIR"

YT_DLP_VERSION="latest"
YT_DLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"

echo "==> Downloading yt-dlp sidecars into $BIN_DIR"

# ── macOS (universal binary works on both Intel and Apple Silicon) ────────────
echo "  Downloading yt-dlp for macOS..."
curl -fSL "$YT_DLP_BASE/yt-dlp_macos" -o "$BIN_DIR/yt-dlp-aarch64-apple-darwin"
cp "$BIN_DIR/yt-dlp-aarch64-apple-darwin" "$BIN_DIR/yt-dlp-x86_64-apple-darwin"
chmod +x "$BIN_DIR/yt-dlp-aarch64-apple-darwin" "$BIN_DIR/yt-dlp-x86_64-apple-darwin"
if command -v codesign >/dev/null 2>&1; then
  codesign --sign - --force --timestamp=none \
    "$BIN_DIR/yt-dlp-aarch64-apple-darwin" \
    "$BIN_DIR/yt-dlp-x86_64-apple-darwin"
fi

# ── Windows x64 ─────────────────────────────────────────────────────────────
echo "  Downloading yt-dlp for Windows..."
curl -fSL "$YT_DLP_BASE/yt-dlp.exe" -o "$BIN_DIR/yt-dlp-x86_64-pc-windows-msvc.exe"

echo ""
echo "==> Done! Sidecar binaries:"
ls -lh "$BIN_DIR"/yt-dlp-*
echo ""
echo "You can now build the app with: npm run tauri build"
