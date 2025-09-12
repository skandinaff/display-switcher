# Repository Guidelines

This repository contains a GNOME Shell extension that switches monitor inputs via `ddcutil`. Use the guidance below to develop, package, and submit changes consistently.

## Project Structure & Module Organization
- Root: `extension.js` (indicator/menu logic), `prefs.js` (preferences UI), `metadata.json`, `Makefile`, `README.md`, `ROADMAP.md`.
- Settings: `schemas/` with `org.gnome.shell.extensions.display-switcher.gschema.xml` (compile before running).
- Assets: optional `stylesheet.css` packaged via `make pack`.

## Build, Test, and Development Commands
- Compile schemas (local dev): `make schemas` (runs `glib-compile-schemas schemas`).
- Clean compiled schema: `make clean`.
- Package ZIP for upload: `make pack` (requires `gnome-extensions` CLI).
- Enable/disable while testing: `gnome-extensions enable|disable display-switcher@skandinaff.github.com`.
- Reload Shell: Xorg `Alt+F2`, type `r`; Wayland: log out/in.

## Coding Style & Naming Conventions
- Language: modern GJS (ES modules). Import with `gi://` and `resource:///` URIs.
- Indentation: 4 spaces; semicolons required; single quotes for strings.
- Classes: PascalCase (e.g., `DisplaySwitchIndicator`); constants UPPER_SNAKE (e.g., `INPUT_MAP`).
- Files: lower‑case with `.js`; schemas use reverse‑DNS id `org.gnome.shell.extensions.display-switcher`.
- No objects before `enable()`; destroy everything in `disable()`.

## Testing Guidelines
- No automated tests yet; perform manual runs:
  - Verify `ddcutil detect` lists displays; confirm switching per‑display and “All Monitors”.
  - Confirm preferences persist positions and influence menu ordering.
  - Watch logs: `journalctl --user -f | grep -i gnome-shell`.

## Commit & Pull Request Guidelines
- Commits: short, imperative subject lines (<= 72 chars). Group related changes. Examples: `read inputs sequentially`, `prefs: persist positions`.
- PRs must include:
  - Summary of changes and rationale.
  - Testing notes (GNOME Shell version, steps, screenshots if UI changed).
  - Any schema changes and reminder to run `make schemas`.

## Security & Configuration Tips
- Runs `ddcutil` unprivileged; do not introduce elevated calls.
- Keep `PATH` assumptions minimal; handle missing `ddcutil` gracefully.
- Maintain responsiveness: avoid long main‑loop blocks; prefer subprocess with timeouts.

