/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Canonical mapping of input codes (VCP 0x60) to labels
// Extendable in later stages if needed
const INPUT_MAP = Object.freeze({
    '0x11': 'HDMI-1',
    '0x0f': 'DisplayPort-1',
    '0x1b': 'USB-C',
});

const INPUT_CODES = Object.freeze(['0x11', '0x0f', '0x1b']);

// Simple indicator with a menu for switching inputs via ddcutil
const DisplaySwitchIndicator = GObject.registerClass(
class DisplaySwitchIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, _('Display Switch'));

        // Panel icon
        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._settings = settings || null;

        // Stage 2: in-memory model for per-display input state
        // Keyed by stable monitor key; value: { currentInput: string|null, lastCheckedAt: number|null }
        this._displayState = new Map();
        // Keep references to per-display submenu and items for future updates without rebuilding
        // Map: key -> { submenu, items: { '0x11': item, '0x0f': item, '0x1b': item } }
        this._menuRefs = new Map();

        this._displays = this._detectDisplays();
        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed::positions', () => {
                this._relabelDisplays();
                this._buildMenu();
            });
        }
        this._buildMenu();
    }

    destroy() {
        if (this._settings && this._settingsChangedId) {
            try { this._settings.disconnect(this._settingsChangedId); } catch (_e) {}
            this._settingsChangedId = 0;
        }
        super.destroy();
    }

    _clearMenu() {
        this.menu.removeAll();
        this._menuRefs.clear();
    }

    _buildMenu() {
        this._clearMenu();

        // Refresh labels with position tags if any
        this._relabelDisplays();

        // Submenu: All monitors
        const allSub = new PopupMenu.PopupSubMenuMenuItem(_('All Monitors'));
        allSub.menu.addAction(_('Switch to HDMI-1'), () => this._switchAll('0x11'));
        allSub.menu.addAction(_('Switch to DisplayPort-1'), () => this._switchAll('0x0f'));
        allSub.menu.addAction(_('Switch to USB-C'), () => this._switchAll('0x1b'));
        this.menu.addMenuItem(allSub);

        // Per-display submenus
        if (this._displays.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const list = [...this._displays];
        // Sort: left -> center -> right -> unknown, then by id
        const rank = p => (p === 'left' ? 0 : (p === 'center' ? 1 : (p === 'right' ? 2 : 3)));
        list.sort((a, b) => (rank(a.position) - rank(b.position)) || (a.id - b.id));

        for (const d of list) {
            const label = d.label || `${_('Display')} ${d.id}`;
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            const key = this._stableMonitorKey(d);

            // Ensure state entry exists for this display
            if (!this._displayState.has(key))
                this._displayState.set(key, { currentInput: null, lastCheckedAt: null });

            // Frontend placeholder: show a checkmark on the first item
            // Use a regular item with a CHECK ornament for compatibility
            const itemHdmi = new PopupMenu.PopupMenuItem(_('Switch to HDMI-1'));
            if (itemHdmi.setOrnament)
                itemHdmi.setOrnament(PopupMenu.Ornament.CHECK);
            itemHdmi.connect('activate', () => this._switchOne('0x11', d.id));
            sub.menu.addMenuItem(itemHdmi);

            // Remaining actions unchanged (no checkmarks yet), but use PopupMenuItem
            // so we can reference them later when wiring detection.
            const itemDp = new PopupMenu.PopupMenuItem(_('Switch to DisplayPort-1'));
            itemDp.connect('activate', () => this._switchOne('0x0f', d.id));
            sub.menu.addMenuItem(itemDp);

            const itemUsbC = new PopupMenu.PopupMenuItem(_('Switch to USB-C'));
            itemUsbC.connect('activate', () => this._switchOne('0x1b', d.id));
            sub.menu.addMenuItem(itemUsbC);

            // Store references for future ornament updates
            this._menuRefs.set(key, { submenu: sub, items: { '0x11': itemHdmi, '0x0f': itemDp, '0x1b': itemUsbC } });

            this.menu.addMenuItem(sub);
        }

        // Rescan displays
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Rescan Displays'), () => {
            this._displays = this._detectDisplays();
            this._buildMenu();
        });
    }

    _switchAll(vcpValue) {
        if (this._displays.length === 0) {
            // Fallback: run without specifying display
            GLib.spawn_command_line_async(`ddcutil setvcp 60 ${vcpValue}`);
            return;
        }
        for (const d of this._displays) {
            this._runSetVcp(vcpValue, d.id ?? d);
        }
    }

    _switchOne(vcpValue, display) {
        this._runSetVcp(vcpValue, display);
    }

    _runSetVcp(vcpValue, display) {
        // VCP code 0x60 (Input Select)
        // Examples: 0x11 (HDMI-1), 0x0f (DisplayPort-1), 0x1b (USB-C)
        const cmd = `ddcutil -d ${display} setvcp 60 ${vcpValue}`;
        GLib.spawn_command_line_async(cmd);
    }

    _detectDisplays() {
        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', 'detect'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [, stdout, _stderr] = proc.communicate_utf8(null, null);
            if (!proc.get_successful())
                return [];

            const text = stdout || '';
            const displays = [];
            let current = null;

            for (const rawLine of text.split('\n')) {
                const line = rawLine.trimEnd();
                const mDisp = line.match(/^Display\s+(\d+)/);
                if (mDisp) {
                    if (current) displays.push(current);
                    current = { id: parseInt(mDisp[1], 10), model: null, serial: null };
                    continue;
                }
                if (!current)
                    continue;

                const mModel = line.match(/^\s*Model:\s*(.+)$/);
                if (mModel && !current.model) {
                    current.model = mModel[1].trim();
                    continue;
                }
                const mSN = line.match(/^\s*(?:Serial number|SN):\s*(.+)$/);
                if (mSN && !current.serial) {
                    current.serial = mSN[1].trim();
                    continue;
                }
            }
            if (current)
                displays.push(current);

            // Fallback: if nothing parsed (e.g. different formatting), try terse to get ids
            if (displays.length === 0) {
                const procTerse = Gio.Subprocess.new(
                    ['ddcutil', 'detect', '--terse'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                const [, stdoutT, _stderrT] = procTerse.communicate_utf8(null, null);
                if (procTerse.get_successful()) {
                    const ids = [];
                    for (const line of (stdoutT || '').split('\n')) {
                        const m = line.match(/^Display\s+(\d+)/);
                        if (m) ids.push(parseInt(m[1], 10));
                    }
                    for (const id of ids)
                        displays.push({ id, model: null, serial: null });
                }
            }

            // Compute labels; disambiguate duplicate models
            const byModel = new Map();
            for (const d of displays) {
                const model = d.model && d.model.length > 0 ? d.model : _('Display') + ' ' + d.id;
                if (!byModel.has(model)) byModel.set(model, []);
                byModel.get(model).push(d);
            }
            for (const [model, list] of byModel.entries()) {
                if (list.length === 1) {
                    list[0].labelBase = model;
                    list[0].label = model;
                } else {
                    list.sort((a, b) => a.id - b.id);
                    list.forEach((d, idx) => {
                        d.labelBase = `${model} (${idx + 1})`;
                        d.label = d.labelBase;
                    });
                }
            }

            // Apply position tags (from settings) and persist to settings if available
            this._persistMonitors(displays);
            this._applyPositions(displays);

            // Stage 2: reconcile state entries with detected displays
            const keys = new Set(displays.map(d => this._stableMonitorKey(d)));
            // Remove state for displays no longer present
            for (const k of Array.from(this._displayState.keys())) {
                if (!keys.has(k))
                    this._displayState.delete(k);
            }
            // Ensure state exists for current displays
            for (const d of displays) {
                const k = this._stableMonitorKey(d);
                if (!this._displayState.has(k))
                    this._displayState.set(k, { currentInput: null, lastCheckedAt: null });
            }

            return displays;
        } catch (e) {
            return [];
        }
    }

    // Stage 2 helper: provide a stable key for state bookkeeping
    _stableMonitorKey(d) {
        return this._monitorKey(d);
    }

    // Stage 2: placeholder for detection; to be implemented in Stage 3
    async _readInputOne(_displayId) {
        return null;
    }

    // Stage 2: update radio/check ornaments for a display submenu based on value
    // Will be used in Stage 4; safe no-op if items not found
    _updateDisplayMenuChecksByKey(key, valueHex) {
        const ref = this._menuRefs.get(key);
        if (!ref || !ref.items)
            return;
        for (const code of INPUT_CODES) {
            const item = ref.items[code];
            if (!item || !item.setOrnament)
                continue;
            if (valueHex && code.toLowerCase() === String(valueHex).toLowerCase())
                item.setOrnament(PopupMenu.Ornament.DOT);
            else
                item.setOrnament(PopupMenu.Ornament.NONE);
        }
    }

    _monitorKey(d) {
        if (d.serial && d.serial.length > 0)
            return `sn:${d.serial}`;
        const model = d.model || '';
        return `model:${model}|id:${d.id}`;
    }

    _loadPositions() {
        if (!this._settings)
            return {};
        try {
            return this._settings.get_value('positions').deepUnpack();
        } catch (_e) {
            return {};
        }
    }

    _applyPositions(displays) {
        const pos = this._loadPositions();
        for (const d of displays) {
            const key = this._monitorKey(d);
            let p = (pos[key] || '').toLowerCase();
            if (p === 'centre') p = 'center'; // accept British spelling
            d.position = (p === 'left' || p === 'center' || p === 'right') ? p : undefined;
            if (d.labelBase) {
                let posLabel = '';
                if (d.position === 'left') posLabel = _('Left');
                else if (d.position === 'center') posLabel = _('Center');
                else if (d.position === 'right') posLabel = _('Right');
                d.label = d.labelBase + (posLabel ? ` (${posLabel})` : '');
            }
        }
    }

    _relabelDisplays() {
        if (!this._displays || this._displays.length === 0)
            return;
        this._applyPositions(this._displays);
    }

    _persistMonitors(displays) {
        if (!this._settings)
            return;
        try {
            // Store as array of JSON strings for flexibility
            const arr = displays.map(d => JSON.stringify({ id: d.id, model: d.model || '', serial: d.serial || '' }));
            this._settings.set_strv('monitors', arr);
        } catch (_e) {
            // Silently ignore if schema missing or not compiled
        }
    }
});

export default class DisplaySwitchExtension extends Extension {
    enable() {
        let settings = null;
        try {
            // Will work only if schema is present/compiled
            settings = this.getSettings();
        } catch (_e) {
            settings = null;
        }
        this._indicator = new DisplaySwitchIndicator(settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
