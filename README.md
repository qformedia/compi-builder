# CompiFlow

Desktop application for building video compilations from licensed third-party content. Built for [Quantastic](https://www.youtube.com/@Quantastic), a YouTube channel that creates video compilations.

CompiFlow connects to HubSpot CRM to manage External Clips and Video Projects, downloads clips via `yt-dlp`, and provides a drag-and-drop interface for arranging clips into compilations.

## Features

- **Search & filter** External Clips from HubSpot by tags, score, and usage
- **Per-creator lazy loading** with horizontal scroll (Netflix-style rows)
- **Auto-download** clips via `yt-dlp` with browser cookie support
- **Manual import** for clips that can't be auto-downloaded (Douyin, etc.)
- **Drag-and-drop arrange** tab with video preview
- **Finish Video** workflow: generates CSV, renames clips with order prefix, creates a zip for sharing with editors
- **HubSpot sync**: Video Projects are created/opened from HubSpot, clips are associated/disassociated in real time

## Tech Stack

- **Desktop framework**: [Tauri 2.0](https://tauri.app/) (Rust backend, web frontend)
- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Shadcn/ui
- **Drag & drop**: dnd-kit
- **Video downloading**: yt-dlp + ffmpeg
- **CRM**: HubSpot API (Private App token)

## Prerequisites

Install these before running CompiFlow:

1. **Rust** (latest stable)
  ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
2. **Node.js** (v18+)
  ```bash
   brew install node
  ```
3. **yt-dlp** (for downloading clips)
  ```bash
   brew install yt-dlp
  ```
4. **ffmpeg** (for video processing / duration probing)
  ```bash
   brew install ffmpeg
  ```
5. **HubSpot Private App token** with scopes:
  - `crm.objects.custom.read`
  - `crm.objects.custom.write`
  - `crm.schemas.custom.read`
  - `crm.schemas.custom.write`

## Getting Started

```bash
# Clone the repo
git clone <repo-url>
cd compi-builder

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev
```

On first launch:

1. Click the **Settings** gear icon
2. Enter your **HubSpot token**
3. Set a **root folder** for projects (e.g. `~/Documents/CompiFlow`)
4. Optionally configure **browser cookies** (Chrome by default) for downloading from Instagram, etc.

## Project Structure

```
compi-builder/
├── src/                      # Frontend (React + TypeScript)
│   ├── App.tsx               # Main app, tabs, Finish Video flow
│   ├── types.ts              # Shared TypeScript interfaces
│   ├── lib/
│   │   └── hubspot.ts        # HubSpot API client (search, parse clips)
│   ├── components/
│   │   ├── ProjectTab.tsx     # Project management (open/create from HubSpot)
│   │   ├── SearchTab.tsx      # Clip search with tag/score/usage filters
│   │   ├── ArrangeTab.tsx     # Drag-and-drop clip ordering + video player
│   │   ├── ClipCard.tsx       # Reusable clip card (thumbnail, score, actions)
│   │   ├── TagPicker.tsx      # Tag multi-select combobox
│   │   ├── SettingsDialog.tsx  # App settings
│   │   └── ui/               # Shadcn/ui components
│   └── assets/               # Logo, images
├── src-tauri/                # Backend (Rust)
│   ├── src/
│   │   └── lib.rs            # All Tauri commands (HubSpot API, yt-dlp, file ops)
│   ├── icons/                # App icons (generated)
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri configuration
├── package.json
└── index.html
```

## Workflow

1. **Open/Create** a Video Project from HubSpot in the Project tab
2. **Search** for clips in the Search tab using tags and filters
3. **Add** clips to the project (auto-downloads + associates in HubSpot)
4. **Arrange** clips in the desired order using drag-and-drop
5. **Finish Video** to generate CSV, rename clips, and create a zip for editors

## Building for Production

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Releasing a New Version

1. **Commit all feature and fix work first** and ensure only `CHANGELOG.md` is pending. A release tag must include every new file; the release command refuses to run if feature/fix work is still uncommitted.
2. Add the plain-language entry for the new version to `CHANGELOG.md`.
3. Decide the next version number, then from the repo root run:

```bash
npm run release -- 0.X.XX
```

This verifies the changelog entry exists, bumps the version in `package.json`, `tauri.conf.json`, and `Cargo.toml` (and `package-lock.json` via npm), runs `npm run typecheck` (same check as CI), then commits the version and changelog change, creates a `v0.X.XX` tag, and pushes. GitHub Actions will build the release artifacts and publish the matching `CHANGELOG.md` section as the release notes.

## Feedback System Setup (Supabase)

CompiFlow includes a built-in feedback dialog (Report a Problem / Suggest an Improvement) with optional screenshot uploads.

### 1) Configure environment variables

Copy `.env.example` to `.env` and fill values:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_SUPABASE_FEEDBACK_BUCKET=feedback-screenshots
```

### 2) Create database + storage

Run SQL from:

- `supabase/migrations/20260303120000_create_feedback_system.sql`

This creates:

- `public.feedback` table
- RLS policies for insert-only app clients
- `feedback-screenshots` storage bucket and upload/read policies

### 3) Deploy Telegram notification function (optional but recommended)

Function path:

- `supabase/functions/notify-feedback/index.ts`

Deployment and webhook instructions:

- `supabase/functions/notify-feedback/README.md`

## Feedback E2E Verification

1. Launch app and click the new feedback icon near Settings.
2. Submit one **Report a Problem** and one **Suggest an Improvement**.
3. Verify two new rows in `public.feedback`.
4. Verify screenshot URLs are present in `screenshots` when attachments are added.
5. Verify Telegram receives notifications for each INSERT event.

## License

Private - Quantastic / Miquel Tolosa