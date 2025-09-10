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

        // HDMI-1 action
        const hdmiItem = new PopupMenu.PopupMenuItem(_('Switch to HDMI-1'));
        hdmiItem.connect('activate', () => {
            // VCP code 0x60 (Input Select), value 0x11 (HDMI-1)
            GLib.spawn_command_line_async('ddcutil setvcp 60 0x11');
        });
        this.menu.addMenuItem(hdmiItem);

        // DisplayPort-1 action
        const dpItem = new PopupMenu.PopupMenuItem(_('Switch to DisplayPort-1'));
        dpItem.connect('activate', () => {
            // VCP code 0x60 (Input Select), value 0x0f (DisplayPort-1)
            GLib.spawn_command_line_async('ddcutil setvcp 60 0x0f');
        });
        this.menu.addMenuItem(dpItem);
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
