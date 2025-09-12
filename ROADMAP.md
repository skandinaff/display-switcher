# Display Switcher — Roadmap

This roadmap tracks completed work and upcoming features.

## Goals
- Show current input per display and keep UI responsive.
- Let users restrict per-display inputs to only connected ones.
- Handle missing `ddcutil` gracefully; no elevated privileges.

## Completed
- Active input detection via `ddcutil getvcp 60` with timeout and async updates.
- Per-display selection indicators (check ornaments) update after switching and rescans.
- Persistence of per-display state in `monitors` key (position, lastInput).
- Menu structure refined per display with detection and relabeling by position.

## Next: Usable Inputs (per monitor)
- Schema/state: extend monitor records with `usableInputs: string[]` storing VCP input codes (e.g., `['0x11','0x0f','0x1b']`). Default when absent: all inputs usable.
- Preferences UI: per-monitor checkboxes for HDMI‑1, DisplayPort‑1, and USB‑C that persist to `usableInputs`.
- Indicator behavior: gray out and disable non‑usable inputs; ignore clicks on them. Do not show a selection ornament on disabled items.
- Migration/defaults: if `usableInputs` is missing or empty, treat as all enabled to avoid regressions.
- Testing: verify disabled items appear insensitive and do not trigger `ddcutil`; toggling prefs updates menu immediately after reopening or rescanning.

## Considerations
- Some monitors expose additional inputs; future work can expand the supported list while keeping persistence format stable.
- Avoid long‑running calls on the main loop; continue using `Gio.Subprocess` with timeouts.
