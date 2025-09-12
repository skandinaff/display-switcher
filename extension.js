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
    _init(settings, extension) {
        super._init(0.0, _('Display Switch'));

        // Panel icon
        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._settings = settings || null;
        this._extension = extension || null;
        // Per-display input menu items to toggle checkmarks
        // Map: displayId -> Map<vcpCode, PopupMenuItem>
        this._inputItemsByDisplay = new Map();

        this._lastInputs = {};
        this._displays = this._detectDisplays();
        this._lastInputs = this._loadLastInputs();
        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed::positions', () => {
                this._relabelDisplays();
                // Persist updated positions into consolidated monitor records
                this._persistMonitors(this._displays);
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
    }

    _buildMenu() {
        this._clearMenu();
        this._inputItemsByDisplay.clear();

        // Refresh labels with position tags if any
        this._relabelDisplays();

        // Per-display submenus

        const list2 = [...this._displays];
        // Sort: left -> center -> right -> unknown, then by id
        const rank2 = p => (p === 'left' ? 0 : (p === 'center' ? 1 : (p === 'right' ? 2 : 3)));
        list2.sort((a, b) => (rank2(a.position) - rank2(b.position)) || (a.id - b.id));

        for (const d of list2) {
            const label = d.label || `${_('Display')} ${d.id}`;
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            // Build input options and wire up dynamic checkmarks based on persisted last input
            const items = new Map();

            const itemHdmi = new PopupMenu.PopupMenuItem(_('Switch to HDMI-1'));
            itemHdmi.connect('activate', () => this._switchOne('0x11', d.id));
            sub.menu.addMenuItem(itemHdmi);
            items.set('0x11', itemHdmi);

            const itemDp = new PopupMenu.PopupMenuItem(_('Switch to DisplayPort-1'));
            itemDp.connect('activate', () => this._switchOne('0x0f', d.id));
            sub.menu.addMenuItem(itemDp);
            items.set('0x0f', itemDp);

            const itemUsbC = new PopupMenu.PopupMenuItem(_('Switch to USB-C'));
            itemUsbC.connect('activate', () => this._switchOne('0x1b', d.id));
            sub.menu.addMenuItem(itemUsbC);
            items.set('0x1b', itemUsbC);

            this._inputItemsByDisplay.set(d.id, items);

            // Initialize checkmark based on persisted last input
            const key = this._stableMonitorKey(d);
            const initial = (d.lastInput && String(d.lastInput)) || this._lastInputs[key];
            this._updateSelectionMarkers(d.id, initial);

            this.menu.addMenuItem(sub);
        }

        // Rescan displays and open settings
        if (this._displays.length > 0)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Rescan Displays'), () => {
            this._displays = this._detectDisplays();
            this._buildMenu();
        });
        if (this._extension && typeof this._extension.openPreferences === 'function') {
            this.menu.addAction(_('Settings…'), () => {
                try { this._extension.openPreferences(); } catch (_e) {}
            });
        }
    }

    _switchOne(vcpValue, display) {
        this._runSetVcp(vcpValue, display);
        const d = this._displays.find(x => x.id === display);
        if (d) {
            const key = this._stableMonitorKey(d);
            // Optimistically persist selection to keep UI responsive
            this._updateLastInput(key, vcpValue);
            d.lastInput = String(vcpValue).toLowerCase();
            this._saveLastInputForDisplay(d.id, d.lastInput);
            this._updateSelectionMarkers(d.id, d.lastInput);
        }
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
            this._applyPositions(displays);
            // Hydrate last inputs from settings and then persist consolidated records
            this._hydrateLastInputs(displays);
            this._persistMonitors(displays);

            return displays;
        } catch (e) {
            return [];
        }
    }

    // Stage 2 helper: provide a stable key for state bookkeeping
    _stableMonitorKey(d) {
        return this._monitorKey(d);
    }

    // Read current input for a single display via ddcutil getvcp 60
    async _readInputOne(displayId) {
        const args = ['ddcutil', '-d', String(displayId), 'getvcp', '60'];
        // ddcutil can take 1–3s; allow generous timeout
        const { ok, stdout } = await this._runCommand(args, 5000);
        if (!ok)
            return { code: null, raw: '' };
        const text = stdout || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const rawLine = lines.find(l => /VCP code\s*0x?60/i.test(l)) || lines[0] || '';
        // Prefer parsing the explicit current value; fall back to sl= token
        let code = null;
        let m = text.match(/current\s+value\s*=\s*(0x[0-9a-fA-F]+|\d+)/i);
        if (!m)
            m = text.match(/\bsl\s*=\s*(0x[0-9a-fA-F]+|\d+)/i);
        if (m) {
            code = m[1];
            if (/^\d+$/.test(code)) {
                const n = parseInt(code, 10);
                if (Number.isFinite(n))
                    code = '0x' + n.toString(16).padStart(2, '0');
            }
            code = String(code).toLowerCase();
        }
        return { code, raw: rawLine };
    }

    // Run a command with timeout; returns { ok, stdout, stderr, status }
    _runCommand(argv, timeoutMs) {
        return new Promise((resolve) => {
            let timedOut = false;
            let timeoutId = 0;
            let proc = null;
            try {
                proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
            } catch (_e) {
                resolve({ ok: false, stdout: '', stderr: '', status: -1 });
                return;
            }

            const onFinish = (p, res) => {
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                    timeoutId = 0;
                }
                if (timedOut) {
                    resolve({ ok: false, stdout: '', stderr: '', status: -2 });
                    return;
                }
                try {
                    const [ok, stdout, stderr] = p.communicate_utf8_finish(res);
                    const success = ok && p.get_successful();
                    resolve({ ok: !!success, stdout: stdout || '', stderr: stderr || '', status: success ? 0 : 1 });
                } catch (_e) {
                    resolve({ ok: false, stdout: '', stderr: '', status: -3 });
                }
            };

            proc.communicate_utf8_async(null, null, onFinish);

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(100, timeoutMs | 0), () => {
                timedOut = true;
                try { proc.force_exit(); } catch (_e) {}
                // Let onFinish resolve; if not called, resolve here after a tick
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    resolve({ ok: false, stdout: '', stderr: 'timeout', status: -2 });
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        });
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

    _loadLastInputs() {
        if (!this._settings)
            return {};
        try {
            return this._settings.get_value('last-inputs').deepUnpack();
        } catch (_e) {
            return {};
        }
    }

    _updateLastInput(key, vcpCode) {
        if (!key || !vcpCode)
            return;
        // Normalize numeric to hex 0x.. just in case
        let code = String(vcpCode).toLowerCase();
        if (/^\d+$/.test(code)) {
            const n = parseInt(code, 10);
            if (Number.isFinite(n))
                code = '0x' + n.toString(16).padStart(2, '0');
        }
        this._lastInputs[key] = code;
        if (this._settings) {
            try {
                const variant = new GLib.Variant('a{ss}', this._lastInputs);
                this._settings.set_value('last-inputs', variant);
            } catch (_e) {}
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
            // Merge with existing records to preserve lastInput
            const existing = this._loadMonitorRecords();
            const byId = new Map(existing.map(r => [r.id, r]));
            const merged = [];
            for (const d of displays) {
                const prev = byId.get(d.id) || {};
                const rec = {
                    id: d.id,
                    model: d.model || '',
                    serial: d.serial || '',
                    position: d.position || '',
                    lastInput: (typeof d.lastInput !== 'undefined' && d.lastInput !== null && String(d.lastInput)) || prev.lastInput || '',
                };
                merged.push(rec);
            }
            this._settings.set_strv('monitors', merged.map(r => JSON.stringify(r)));
        } catch (_e) {
            // Silently ignore if schema missing or not compiled
        }
    }

    _loadMonitorRecords() {
        if (!this._settings)
            return [];
        try {
            const arr = this._settings.get_strv('monitors');
            const out = [];
            for (const s of arr) {
                try {
                    const o = JSON.parse(s);
                    if (o && typeof o.id === 'number')
                        out.push(o);
                } catch (_e) {}
            }
            return out;
        } catch (_e) {
            return [];
        }
    }

    _hydrateLastInputs(displays) {
        const records = this._loadMonitorRecords();
        const map = new Map(records.map(r => [r.id, r.lastInput]));
        for (const d of displays) {
            const li = map.get(d.id);
            if (li)
                d.lastInput = String(li);
        }
    }

    _saveLastInputForDisplay(id, code) {
        if (!this._settings)
            return;
        const norm = (() => {
            let c = String(code).toLowerCase();
            if (/^\d+$/.test(c)) {
                const n = parseInt(c, 10);
                if (Number.isFinite(n)) c = '0x' + n.toString(16).padStart(2, '0');
            }
            return c;
        })();
        const recs = this._loadMonitorRecords();
        for (const r of recs) {
            if (r.id === id) {
                r.lastInput = norm;
                break;
            }
        }
        try {
            this._settings.set_strv('monitors', recs.map(r => JSON.stringify(r)));
        } catch (_e) {}
    }

    _updateSelectionMarkers(displayId, selectedCode) {
        const items = this._inputItemsByDisplay.get(displayId);
        if (!items)
            return;
        // Normalize code similar to persistence logic
        let code = selectedCode ? String(selectedCode).toLowerCase() : '';
        if (/^\d+$/.test(code)) {
            const n = parseInt(code, 10);
            if (Number.isFinite(n))
                code = '0x' + n.toString(16).padStart(2, '0');
        }
        for (const [vcp, item] of items.entries()) {
            if (item.setOrnament) {
                item.setOrnament(vcp === code ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
        }
    }

    // no-op: status label logic removed; checkmarks indicate active input
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
        this._indicator = new DisplaySwitchIndicator(settings, this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
