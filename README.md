# Branchline

<p align="center">
  <img src="public/brand/branchline-mark-512.png" alt="Branchline" width="96" height="96" />
</p>

Git Extensions v2 — a dedicated desktop Git GUI. Not an IDE. Not an AI tool.

Browse history, commit, branch, cherry-pick, push/pull, blame, and manage remotes with a calm focus-mode graph, plain-language safety dialogs, and easy undo.

## Stack

- Angular 20 (standalone, signals, Tailwind CSS)
- Tauri v2 + Rust (`git` CLI writes, git2 reads, SQLite)
- Lucide icons, angular-split, Motion-ready chrome

## Develop

```bash
npm install
source "$HOME/.cargo/env"   # if needed
npm run tauri:dev           # Angular + native window
```

Browser-only UI preview (mock IPC):

```bash
npm start
```

Open http://localhost:4200 — uses mock Git data when Tauri is unavailable.

## Build

```bash
npm run build
npm run tauri:build
```

## Release tooling

A small, config-driven, dependency-free release script (`scripts/release.mjs`) bumps every
version file, commits, and tags in one step. It's generic — nothing about it is
Branchline-specific — so forks and other projects can reuse it as-is.

### Setup (new project or fork)

1. Bootstrap a starter config:

   ```bash
   npm run release:init
   ```

   This writes `release.config.json` with `productName` inferred from `src-tauri/tauri.conf.json`
   (if present) or `package.json`, and a single `files` entry for `package.json`'s `version`.
   It won't overwrite an existing config — pass `--force` if you really want to regenerate it.

2. Open `release.config.json` and add every other file that stores a version number (e.g. a
   Tauri `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, or any other JSON file). See
   [`release.config.example.jsonc`](release.config.example.jsonc) for a fully annotated
   reference of every field and file `kind`.
3. Make sure `package.json` has `release`, `release:patch`, `release:minor`, `release:major`
   scripts pointing at `node scripts/release.mjs` (already set up in this repo — copy them as-is).
4. Try it: `npm run release -- patch --dry-run`.

### Customize (`release.config.json`)

| Field | Default | Purpose |
|---|---|---|
| `productName` | inferred | Used in `{{productName}}` placeholder (e.g. tag message) |
| `tagPrefix` | `"v"` | Prefix for the git tag, e.g. `v1.2.3` |
| `branch` | `"main"` | Branch required before committing/tagging |
| `requireClean` | `true` | Refuse to release with uncommitted changes |
| `push` | `false` | Push automatically after tagging (override per-run with `--push`/`--no-push`) |
| `commitMessage` | `"Release {{version}}"` | Commit message template |
| `tagMessage` | `"{{productName}} {{version}}"` | Annotated tag message template |
| `files` | — | List of files to bump; see example file for supported `kind`s |

Template placeholders available in `commitMessage`/`tagMessage`: `{{version}}`,
`{{previousVersion}}`, `{{tag}}`, `{{productName}}`.

### Everyday commands

```bash
npm run release -- patch --dry-run    # preview, writes nothing
npm run release -- patch --push       # ship a patch (0.1.3 → 0.1.4)
npm run release -- minor --push
npm run release -- 1.0.0 --push       # explicit version
npm run release -- patch --preid beta # prerelease: 0.2.0-beta.0
npm run release -- patch --no-push    # commit + tag, skip push
npm run release -- patch --no-commit  # bump files only, no git
```

Run `node scripts/release.mjs --help` for the full flag list (branch/message overrides,
`--allow-dirty`, etc).

Tag push builds installers and publishes a GitHub Release with downloadable assets.

Public download page (GitHub Pages):

https://seangareth505.github.io/branchline/

### Android APK

> Note: Branchline is primarily a desktop Git GUI. The Android build packages the UI as an APK for sideloading; local Git workflows on phone will be limited compared to desktop.

Workflow: `.github/workflows/release-android.yml`

After the workflow finishes, open **Releases** on GitHub. The APK download URL looks like:

`https://github.com/<you>/<repo>/releases/download/v0.1.0/Branchline-0.1.0-android.apk`

You can also run **Actions → Release Android APK → Run workflow** without a tag (uploads an artifact; tagged pushes publish a Release).

Optional permanent signing (recommended before sharing widely):

```bash
chmod +x scripts/create-android-keystore.sh
./scripts/create-android-keystore.sh
```

Then add GitHub secrets: `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_BASE64`.

### Desktop (macOS / Windows / Linux)

Workflow: `.github/workflows/release-desktop.yml` — same tag push also builds desktop installers onto the Release.

In-app updates (desktop) need a signing key in GitHub Actions. Generate once (already done locally under `.keys/`, gitignored):

```bash
npm run tauri signer generate -- -w .keys/branchline.key --ci
```

Add repo secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — full contents of `.keys/branchline.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — leave empty if the key has no password

The matching public key is already in `src-tauri/tauri.conf.json`. After a signed release, the desktop app can notify and install updates without a manual reinstall.

Android sideload builds still need a new APK install.

## Layout

- **Dashboard** — recent / pinned repos, open, clone, init
- **Browse** — refs (branches, tags, remotes, stash), focus-mode revision graph with filters, commit staging, amend, diff, blame, file history, reflog, console
- **Branches** — create, checkout, merge, rebase, rename, delete (with safety)
- **History actions** — cherry-pick, revert, soft/mixed/hard reset, squash, create tag
- **Remotes** — list / add / remove, pull, pull --rebase, push, force-with-lease
- **Conflicts** — continue / abort merge, rebase, or cherry-pick
- **Onboarding** — Git detect, identity, SSH / credentials checklist
- **Safety** — destructive actions with recommended safe path
- **Stubs** — PRs, Jira, profiles, automation, templates (mock adapters)

## Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘/Ctrl+K | Command palette |
| ⌘/Ctrl+Z | Undo last toast action |
