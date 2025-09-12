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

// VCP 0x60 (Input Select) common values we expose:
// 0x11 (HDMI-1), 0x0f (DisplayPort-1), 0x1b (USB-C)

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

        this._displays = this._detectDisplays();
        if (this._settings) {
            // React to updates in consolidated monitor records
            this._settingsChangedId = this._settings.connect('changed::monitors', () => {
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
    }

    _buildMenu() {
        this._clearMenu();
        this._inputItemsByDisplay.clear();

        // Refresh labels with position tags if any (from monitors records)
        this._relabelDisplays();

        // Per-display submenus
        const list = [...this._displays];
        // Sort: left -> center -> right -> unknown, then by id
        const rank = p => (p === 'left' ? 0 : (p === 'center' ? 1 : (p === 'right' ? 2 : 3)));
        list.sort((a, b) => (rank(a.position) - rank(b.position)) || (a.id - b.id));

        for (const d of list) {
            const label = d.label || `${_('Display')} ${d.id}`;
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            // Build input options and wire up dynamic checkmarks based on persisted last input
            const items = new Map();

            const itemHdmi = new PopupMenu.PopupMenuItem(_('HDMI-1'));
            itemHdmi.connect('activate', () => this._switchOne('0x11', d.id));
            sub.menu.addMenuItem(itemHdmi);
            items.set('0x11', itemHdmi);

            const itemDp = new PopupMenu.PopupMenuItem(_('DisplayPort-1'));
            itemDp.connect('activate', () => this._switchOne('0x0f', d.id));
            sub.menu.addMenuItem(itemDp);
            items.set('0x0f', itemDp);

            const itemUsbC = new PopupMenu.PopupMenuItem(_('USB-C'));
            itemUsbC.connect('activate', () => this._switchOne('0x1b', d.id));
            sub.menu.addMenuItem(itemUsbC);
            items.set('0x1b', itemUsbC);

            this._inputItemsByDisplay.set(d.id, items);

            // Initialize checkmark based on persisted last input
            const initial = d.lastInput && String(d.lastInput);
            this._updateSelectionMarkers(d.id, initial);

            this.menu.addMenuItem(sub);
        }

        // Rescan displays and open settings
        if (this._displays.length > 0)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Rescan Displays'), () => {
            this._displays = this._detectDisplays();
            this._buildMenu();
            // Also refresh active inputs to update checkmarks
            // Fire and forget; runs asynchronously without blocking the UI
            this._rescanActiveInputs().catch(() => {});
        });
        if (this._extension && typeof this._extension.openPreferences === 'function') {
            this.menu.addAction(_('Settings…'), () => {
                try { this._extension.openPreferences(); } catch (_e) {}
            });
        }
    }

    _switchOne(vcpValue, display) {
        // Respect per-display usable inputs; ignore activation if disabled
        const d = this._displays.find(x => x.id === display);
        if (d && !this._isInputUsable(d, vcpValue))
            return;
        this._runSetVcp(vcpValue, display);
        if (d) {
            // Optimistically persist selection to keep UI responsive
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

            // Hydrate position + lastInput from consolidated records and persist
            this._hydrateFromRecords(displays);
            this._persistMonitors(displays);

            return displays;
        } catch (e) {
            return [];
        }
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

    // Refresh active inputs for all known displays and update UI/persistence
    async _rescanActiveInputs() {
        const displays = Array.isArray(this._displays) ? [...this._displays] : [];
        for (const d of displays) {
            const { code } = await this._readInputOne(d.id);
            if (!code)
                continue;
            d.lastInput = String(code).toLowerCase();
            this._saveLastInputForDisplay(d.id, d.lastInput);
            this._updateSelectionMarkers(d.id, d.lastInput);
        }
        // Save merged monitor records reflecting any new lastInput values
        this._persistMonitors(displays);
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

    _normalizeVcpCode(v) {
        if (v === null || typeof v === 'undefined')
            return '';
        let code = String(v).toLowerCase();
        if (/^\d+$/.test(code)) {
            const n = parseInt(code, 10);
            if (Number.isFinite(n))
                code = '0x' + n.toString(16).padStart(2, '0');
        }
        return code;
    }

    _applyPositionLabel(d) {
        if (!d || !d.labelBase)
            return;
        let posLabel = '';
        if (d.position === 'left') posLabel = _('Left');
        else if (d.position === 'center') posLabel = _('Center');
        else if (d.position === 'right') posLabel = _('Right');
        d.label = d.labelBase + (posLabel ? ` (${posLabel})` : '');
    }

    _relabelDisplays() {
        if (!this._displays || this._displays.length === 0)
            return;
        // Re-apply position labels based on current monitors records
        this._hydrateFromRecords(this._displays);
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
                    usableInputs: Array.isArray(d.usableInputs) ? d.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v) : (Array.isArray(prev.usableInputs) ? prev.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v) : undefined),
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

    _hydrateFromRecords(displays) {
        const records = this._loadMonitorRecords();
        const byId = new Map(records.map(r => [r.id, r]));
        // Also map by serial when available to improve stability
        const bySerial = new Map();
        for (const r of records) {
            if (r.serial && r.serial.length > 0 && !bySerial.has(r.serial))
                bySerial.set(r.serial, r);
        }
        for (const d of displays) {
            let rec = byId.get(d.id);
            if (!rec && d.serial && d.serial.length > 0)
                rec = bySerial.get(d.serial);
            if (rec) {
                const pRaw = (rec.position || '').toLowerCase();
                const p = (pRaw === 'centre') ? 'center' : pRaw; // accept British spelling
                d.position = (p === 'left' || p === 'center' || p === 'right') ? p : undefined;
                const li = rec.lastInput;
                if (li)
                    d.lastInput = String(li).toLowerCase();
                if (Array.isArray(rec.usableInputs)) {
                    d.usableInputs = rec.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v);
                }
            }
            this._applyPositionLabel(d);
        }
    }

    _saveLastInputForDisplay(id, code) {
        if (!this._settings)
            return;
        const norm = this._normalizeVcpCode(code);
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
        const disp = this._displays.find(x => x.id === displayId);
        // Normalize code similar to persistence logic
        const code = this._normalizeVcpCode(selectedCode);
        for (const [vcp, item] of items.entries()) {
            const usable = disp ? this._isInputUsable(disp, vcp) : true;
            if (item.setSensitive)
                item.setSensitive(!!usable);
            if (item.setOrnament) {
                const ornament = (vcp === code && usable) ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;
                item.setOrnament(ornament);
            }
        }
    }

    _isInputUsable(display, code) {
        const norm = this._normalizeVcpCode(code);
        const list = Array.isArray(display.usableInputs) ? display.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v) : null;
        // If no preference set, treat all inputs as usable
        if (!list || list.length === 0)
            return true;
        return list.includes(norm);
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
