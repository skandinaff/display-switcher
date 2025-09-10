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
        // Sort: left -> right -> unknown, then by id
        const rank = p => (p === 'left' ? 0 : (p === 'right' ? 1 : 2));
        list.sort((a, b) => (rank(a.position) - rank(b.position)) || (a.id - b.id));

        for (const d of list) {
            const label = d.label || `${_('Display')} ${d.id}`;
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            sub.menu.addAction(_('Switch to HDMI-1'), () => this._switchOne('0x11', d.id));
            sub.menu.addAction(_('Switch to DisplayPort-1'), () => this._switchOne('0x0f', d.id));
            sub.menu.addAction(_('Switch to USB-C'), () => this._switchOne('0x1b', d.id));
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

            return displays;
        } catch (e) {
            return [];
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
            const p = (pos[key] || '').toLowerCase();
            d.position = (p === 'left' || p === 'right') ? p : undefined;
            if (d.labelBase)
                d.label = d.labelBase + (d.position ? ` (${d.position === 'left' ? _('Left') : _('Right')})` : '');
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
