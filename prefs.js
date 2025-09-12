/* prefs.js - Preferences dialog for Display Switcher */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function loadMonitors(settings) {
    const arr = settings.get_strv('monitors');
    const list = [];
    for (const s of arr) {
        try {
            const o = JSON.parse(s);
            list.push(o);
        } catch (_e) {
            // skip
        }
    }
    return list;
}

function saveMonitors(settings, list) {
    try {
        const arr = list.map(o => JSON.stringify(o));
        settings.set_strv('monitors', arr);
    } catch (_e) {
        // ignore
    }
}

export default class DisplaySwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(520, 460);
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({ title: _('Display Switcher') });
        const group = new Adw.PreferencesGroup({ title: _('Monitor Positions') });
        page.add(group);

        let monitors = loadMonitors(settings);

        if (monitors.length === 0) {
            const status = new Adw.StatusPage({
                title: _('No monitors stored yet'),
                description: _('Open the menu and run “Rescan Displays” to detect monitors, then reopen preferences.'),
                icon_name: 'video-display-symbolic',
            });
            window.add(status);
            window.add(page);
            return;
        }

        // Build a row per monitor with a dropdown for position
        // Order: Unknown, Left, Center, Right
        const options = [_('Unknown'), _('Left'), _('Center'), _('Right')];

        for (const mon of monitors) {
            const row = new Adw.ActionRow();

            const title = mon.model && mon.model.length > 0 ? mon.model : `${_('Display')} ${mon.id}`;
            row.title = title;
            if (mon.serial && mon.serial.length > 0)
                row.subtitle = _('Serial: ') + mon.serial;

            const strList = new Gtk.StringList();
            for (const o of options)
                strList.append(o);

            const drop = new Gtk.DropDown({ model: strList });
            drop.valign = Gtk.Align.CENTER;

            let current = (mon.position || '').toLowerCase();
            if (current === 'centre') current = 'center';
            let idx = 0; // Unknown
            if (current === 'left') idx = 1;
            else if (current === 'center') idx = 2;
            else if (current === 'right') idx = 3;
            drop.selected = idx;

            drop.connect('notify::selected', () => {
                const sel = drop.selected;
                // Update monitors list: 0 -> clear, 1 -> left, 2 -> center, 3 -> right
                monitors = loadMonitors(settings); // refresh in case changed externally
                // Find by id first; fall back to serial if needed
                let target = monitors.find(m => m && m.id === mon.id);
                if (!target && mon.serial)
                    target = monitors.find(m => m && m.serial === mon.serial);
                if (!target)
                    return;
                if (sel === 0) {
                    target.position = '';
                } else if (sel === 1) {
                    target.position = 'left';
                } else if (sel === 2) {
                    target.position = 'center';
                } else if (sel === 3) {
                    target.position = 'right';
                }
                saveMonitors(settings, monitors);
            });

            row.add_suffix(drop);
            group.add(row);
        }

        window.add(page);
    }
}
