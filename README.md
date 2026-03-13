# Display Switch (GNOME Shell Extension)

Switch monitor input sources directly from the GNOME top bar using `ddcutil` (VCP 0x60: Input Select). Provides actions for common inputs (HDMI-1, DisplayPort-1, USB‑C) per display or for all displays.

## Features
- Panel indicator with quick menu
- Per‑display or all‑displays switching
- Parses monitor Model and Serial (when available)
- Auto‑disambiguates identical models (e.g., “DELL P2721Q (1)”, “(2)”) 
- Persists detected monitors to settings (optional schema)
- Preferences dialog to assign monitors as Left/Center/Right
- Rescan displays without reloading the extension
- Translatable labels via gettext

## Requirements
- GNOME Shell 46
- `ddcutil` available in `PATH`
  - Ensure your user has permission to access DDC/I²C (e.g., udev rules or membership in the `i2c` group depending on your distro)

## Development Workflow
Use one repo and generate two builds from it:

- Dev build: `display-switcher-dev@skandinaff.github.com`
- Release build: `display-switcher@skandinaff.github.com`

This prevents the published extension from overwriting your local dev copy.

### Local Dev Install
1. Work in the repo normally.
2. Build, install, and refresh the dev variant:
   - `make dev-refresh`
3. If GNOME has not seen the dev UUID in the current session yet, log out and back in once.
4. After that, `make dev-refresh` is the normal one-command local workflow.

If you only want to rebuild/install without touching GNOME's enabled-extension state:
   - `make dev-install`
5. Enable the dev extension manually if needed:
   - `gnome-extensions enable display-switcher-dev@skandinaff.github.com`
6. Restart GNOME Shell if needed:
   - Xorg: `Alt`+`F2`, type `r`, press `Enter`.
   - Wayland: log out and back in.

The generated install lives under `build/display-switcher-dev@skandinaff.github.com/`, and `make dev-install` copies it into `~/.local/share/gnome-shell/extensions/`.

### Release Packaging
1. Bump `VERSION` to the next store version.
2. Build the release zip:
   - `make pack-release`
   - or `make pack-release VERSION=4`
3. Upload the zip from `build/dist/` to extensions.gnome.org.

`make pack` remains as an alias for `make pack-release`.

## Dev Docs
Development-only notes such as the roadmap live under `dev-docs/` and are not packaged into the extension build outputs.

## Install (manual)
If you do want to install manually without the build targets, the installed folder name and the `uuid` inside `metadata.json` must match exactly.

## Usage
- Click the panel icon and choose an input for a specific display or all displays.
- Use “Rescan Displays” if you connect or power‑cycle monitors.

Labels use the monitor model from `ddcutil detect` if present. If two or more displays report the same model, they are enumerated “(1)”, “(2)”, etc. Serial number is read when available and stored in settings if the schema is compiled.

## Preferences (Position assignment)
- Open the Extensions app, select Display Switch, and click Preferences.
- Assign each detected monitor to “Left”, “Center”, or “Right” (or keep “Unknown”).
- The menu annotates labels with the assignment and sorts Left → Center → Right → Unknown.
- Assignments are stored by serial number when available; otherwise by model+id.

VCP values used:
- HDMI‑1: `0x11`
- DisplayPort‑1: `0x0f`
- USB‑C: `0x1b`

You can extend these mappings in `extension.js` if your monitor uses different input codes.

## Security & Permissions
- Spawns the `ddcutil` process unprivileged; no `pkexec` or elevated privileges are used.
- No clipboard access, telemetry, or network access.
- No long‑running main loop sources are created.

## Compatibility
- Declared support: GNOME Shell 46.
- Older or newer versions are not claimed; test locally before changing `shell-version` in `metadata.json`.

## Troubleshooting
- “Command not found: ddcutil”: Install `ddcutil` via your distro and ensure it’s in `PATH`.
- “No displays detected”: Ensure monitors support DDC/CI and that the feature is enabled in the OSD; check user permissions to I²C devices.

## Acknowledgments
- Uses the excellent `ddcutil` utility to communicate with monitors over DDC/CI https://github.com/rockowitz/ddcutil
