# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

CompiFlow is a Tauri 2.0 desktop application (Rust backend + React/TypeScript frontend) for managing video compilations. See `README.md` for full details.

### Running the app

```bash
npx tauri dev --config '{"bundle":{"targets":"all"}}'
```

The `--config` override is **required on Linux** because `tauri.conf.json` specifies macOS/Windows bundle targets (`dmg`, `macos`, `nsis`) which fail validation on Linux. The override sets targets to `"all"` which lets Tauri pick platform-appropriate defaults.

The Vite dev server runs on `http://localhost:1420`. The Tauri app window opens automatically.

### yt-dlp sidecar

Tauri expects a sidecar binary at `src-tauri/binaries/yt-dlp-x86_64-unknown-linux-gnu`. This binary is not committed to git (`.gitignore`'d). On Linux, download it before building:

```bash
curl -fSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
  -o src-tauri/binaries/yt-dlp-x86_64-unknown-linux-gnu
chmod +x src-tauri/binaries/yt-dlp-x86_64-unknown-linux-gnu
```

### Lint & type-check

```bash
npx tsc --noEmit
```

No ESLint configuration exists in this project. TypeScript type-checking is the primary lint mechanism.

### Build

- **Frontend only**: `npm run build` (runs `tsc && vite build`)
- **Full app**: `npx tauri build --config '{"bundle":{"targets":"all"}}'` (same Linux override needed)
- **Rust only**: `cd src-tauri && TAURI_CONFIG='{"bundle":{"targets":["deb"]}}' cargo build`

### System dependencies (Linux)

These are needed for Tauri on Linux and must be installed once:

- `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`, `libsoup-3.0-dev`
- `libgtk-3-dev`, `libglib2.0-dev`, `libgdk-pixbuf2.0-dev`, `librsvg2-dev`
- `libappindicator3-dev`, `patchelf`, `libssl-dev`, `pkg-config`

### External dependencies

- **HubSpot Private App token** is required at runtime (entered in the Settings dialog). Without it, the app launches but cannot load clips/projects.
- **yt-dlp** and **ffmpeg** are used for video downloading/processing.

### Rust version

Rust 1.85+ is required (the `zvariant_utils` crate needs `edition2024` support). Run `rustup update stable` if the installed version is older.
