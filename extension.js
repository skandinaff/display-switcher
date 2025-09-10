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
    _init() {
        super._init(0.0, _('Display Switch'));

        // Panel icon
        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._displays = this._detectDisplays();
        this._buildMenu();
    }

    _clearMenu() {
        this.menu.removeAll();
    }

    _buildMenu() {
        this._clearMenu();

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

        for (const d of this._displays) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(_('Display ') + d);
            sub.menu.addAction(_('Switch to HDMI-1'), () => this._switchOne('0x11', d));
            sub.menu.addAction(_('Switch to DisplayPort-1'), () => this._switchOne('0x0f', d));
            sub.menu.addAction(_('Switch to USB-C'), () => this._switchOne('0x1b', d));
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
            this._runSetVcp(vcpValue, d);
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
                ['ddcutil', 'detect', '--terse'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [, stdout, stderr] = proc.communicate_utf8(null, null);
            if (!proc.get_successful())
                return [];

            const text = stdout || '';
            // Parse lines like: "Display 1"
            const displays = [];
            for (const line of text.split('\n')) {
                const m = line.match(/^Display\s+(\d+)/);
                if (m) displays.push(parseInt(m[1], 10));
            }
            return displays;
        } catch (e) {
            // If detection fails, return empty list
            return [];
        }
    }
});

export default class DisplaySwitchExtension extends Extension {
    enable() {
        this._indicator = new DisplaySwitchIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
