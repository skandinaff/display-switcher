# Display Switcher — Roadmap

This file tracks planned work and staged delivery for the “active connection” feature and related improvements.

## Goals
- Show which input is currently active per display.
- Keep UI responsive and simple; avoid intrusive polling.
- Respect extension architecture and GNOME Shell guidelines.

## Stages
1) Frontend placeholder: checkmarks on first item in each display submenu (no backend logic).
2) Model and storage: represent per-display active input in memory; optional persistence if useful.
3) Detection: read VCP 0x60 (Input Select) via `ddcutil getvcp 60` per display.
4) Wiring: update checkmarks based on detection results; update after switching or rescan.
5) Polishing: radio-style selection per submenu; error states; optional refresh button per display.

## Current Milestone (Stage 1 — rollback)
- Reverted detection wiring and radio ornaments.
- Static checkmark on first item in each per-display submenu.
- Added minimal read-only "Active Inputs" section that reads and shows the current input per display on menu open or manual refresh.

## Notes / Considerations
- Use `PopupMenu.PopupMenuItem` with `setOrnament(PopupMenu.Ornament.CHECK)` to show a checkmark without a switch.
- For later stages, apply `Ornament.DOT` (radio-style) to represent mutually exclusive inputs.
- Detection is best-effort; some monitors may not expose or allow reading VCP 0x60 reliably.
- Avoid excessive synchronous calls; use `Gio.Subprocess` and update UI asynchronously.

## Done
- Initial scan of extension structure and menu composition.
- Stage 1 implemented: checkmarks on first item in each display submenu.
- Stage 2 implemented: state model, input map, and menu references; no UI behavior changes yet.
- Stage 3 implemented: async detection with timeout, per-display serialization, and triggers on submenu open/rescan; state updated only.
- Stage 4 implemented: wire ornaments (DOT) to detected state; update selection after detection, switching, and rescans.

## Next-Session Handoff — Details
- **Input map:** Define a canonical map of VCP values → labels:
  - `0x11`: HDMI-1
  - `0x0f`: DisplayPort-1
  - `0x1b`: USB-C
  - Keep extensible via a constant (e.g., `INPUT_MAP`) so additional inputs can be added without UI refactors.
- **State model:** Maintain in-memory state keyed by a stable monitor key (prefer serial; fallback `model|id`):
  - Structure: `{ currentInput: string | null, lastCheckedAt: number | null }`.
  - Do not persist yet; memory-only until feature stabilizes.
- **Detection triggers:** Read current input (`ddcutil getvcp 60`) at these moments:
  - When a per-display submenu is opened.
  - Immediately after a successful switch command for that display.
  - When the user runs “Rescan Displays”.
  - Optional: a small “Refresh status” item per display submenu.
- **UI behavior:**
  - Convert per-display submenu items to `PopupMenu.PopupMenuItem` and use `setOrnament(PopupMenu.Ornament.DOT)` to represent mutually exclusive inputs.
  - Select the item matching detected value; if unknown, none selected.
  - Keep “All Monitors” submenu with plain actions (no radios).
- **Concurrency and limits:**
  - Serialize `ddcutil` calls per display; at most one in-flight query per display.
  - Apply a timeout and surface non-fatal errors without blocking the UI.
- **Errors and empty states:**
  - If detection fails or `ddcutil` is absent, show “Unknown input” subtly and keep items actionable.
  - Never block opening menus; degrade gracefully.
- **Code hooks used:**
  - `_readInputOne(displayId): Promise<string|null>` — parses VCP 0x60 and returns a mapped code or `null`.
  - `_updateSelectionMarkers(displayId, value)` — updates radio/check selection for that submenu.
  - `_monitorKey(d)` — helper for deriving a stable key (serial preferred; fallback `model|id`).
  - Keep references to created submenu menu items per display for quick updates.
- **Testing steps (manual):**
  - Rescan displays; open a per-display submenu and observe detection updating selection.
  - Switch input; verify the selection updates immediately.
  - Unplug/inaccessible monitor scenario; verify graceful “Unknown input”.
- **Persistence (optional, later):**
  - Persistence is not required. If added later, introduce a schema key to store last-known input; still treat runtime detection as source of truth.
