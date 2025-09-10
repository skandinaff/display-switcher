# Display Switch (GNOME Shell Extension)

Switch monitor input sources directly from the GNOME top bar using `ddcutil` (VCP 0x60: Input Select). Provides actions for common inputs (HDMI-1, DisplayPort-1, USB‑C) per display or for all displays.

## Features
- Panel indicator with quick menu
- Per‑display or all‑displays switching
- Parses monitor Model and Serial (when available)
- Auto‑disambiguates identical models (e.g., “DELL P2721Q (1)”, “(2)”) 
- Persists detected monitors to settings (optional schema)
- Preferences dialog to assign monitors as Left/Right
- Rescan displays without reloading the extension
- Translatable labels via gettext

## Requirements
- GNOME Shell 46
- `ddcutil` available in `PATH`
  - Ensure your user has permission to access DDC/I²C (e.g., udev rules or membership in the `i2c` group depending on your distro)

## Install (from source)
1. Clone or download this repository.
2. Create the extension folder:
   - `~/.local/share/gnome-shell/extensions/display-switcher@skandinaff.github.com/`
3. Copy the files: `extension.js`, `metadata.json`, `stylesheet.css`, and the `schemas/` folder into that directory.
4. Optional but recommended: compile the schema so the extension can persist detected monitors and positions for future use.
   - `glib-compile-schemas ~/.local/share/gnome-shell/extensions/display-switcher@skandinaff.github.com/schemas`
4. Restart GNOME Shell:
   - Xorg: `Alt`+`F2`, type `r`, press `Enter`.
   - Wayland: log out and back in.
5. Enable via Extensions app or `gnome-extensions enable display-switcher@skandinaff.github.com`.

## Usage
- Click the panel icon and choose an input for a specific display or all displays.
- Use “Rescan Displays” if you connect or power‑cycle monitors.

Labels use the monitor model from `ddcutil detect` if present. If two or more displays report the same model, they are enumerated “(1)”, “(2)”, etc. Serial number is read when available and stored in settings if the schema is compiled.

## Preferences (Left/Right assignment)
- Open the Extensions app, select Display Switch, and click Preferences.
- Assign each detected monitor to “Left” or “Right” (or keep “Unknown”).
- The menu will annotate labels with the assignment and sort Left → Right → Unknown.
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

## Development
- Code is modern GJS (ES modules, classes). No deprecated modules.
- Indicator and menu are created in `enable()` and destroyed in `disable()`.
- Minimal logging; errors fall back gracefully.

## Troubleshooting
- “Command not found: ddcutil”: Install `ddcutil` via your distro and ensure it’s in `PATH`.
- “No displays detected”: Ensure monitors support DDC/CI and that the feature is enabled in the OSD; check user permissions to I²C devices.

## Licensing
- GPL‑2.0‑or‑later (see SPDX header in source). If distributing widely, consider adding a `LICENSE` file with full text.

## Publishing Checklist (GNOME Extensions)
- metadata.json
  - `uuid`: `display-switcher@skandinaff.github.com`
  - `name`, `description` set
  - `shell-version`: `["46"]` (only stable versions and at most one dev version)
  - `url`: repository link
- Code hygiene
  - No objects created before `enable()`; all destroyed in `disable()`
  - No deprecated modules (Lang/Mainloop/ByteArray)
  - No GTK/Adwaita imports in `extension.js`; no Shell libraries in preferences (no prefs used)
  - No excessive logging or telemetry
  - No bundled binaries or scripts

Repository: https://github.com/skandinaff/display-switcher
