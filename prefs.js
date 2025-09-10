/* prefs.js - Preferences dialog for Display Switcher */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function monitorKeyFor(mon) {
    // Prefer serial; fall back to model+id combo
    if (mon && mon.serial && mon.serial.length > 0)
        return `sn:${mon.serial}`;
    const model = (mon && mon.model) ? mon.model : '';
    const id = (mon && mon.id) ? String(mon.id) : '';
    return `model:${model}|id:${id}`;
}

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

function loadPositions(settings) {
    try {
        return settings.get_value('positions').deepUnpack();
    } catch (_e) {
        return {};
    }
}

function savePositions(settings, mapObj) {
    try {
        const variant = new GLib.Variant('a{ss}', mapObj);
        settings.set_value('positions', variant);
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

        const monitors = loadMonitors(settings);
        let positions = loadPositions(settings);

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
        const options = [_('Unknown'), _('Left'), _('Right')];

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

            const key = monitorKeyFor(mon);
            const current = (positions[key] || '').toLowerCase();
            let idx = 0; // Unknown
            if (current === 'left') idx = 1;
            else if (current === 'right') idx = 2;
            drop.selected = idx;

            drop.connect('notify::selected', () => {
                const sel = drop.selected;
                // Update mapping: 0 -> remove, 1 -> left, 2 -> right
                positions = loadPositions(settings); // refresh in case changed externally
                if (sel === 0) {
                    if (positions[key]) delete positions[key];
                } else if (sel === 1) {
                    positions[key] = 'left';
                } else if (sel === 2) {
                    positions[key] = 'right';
                }
                savePositions(settings, positions);
            });

            row.add_suffix(drop);
            group.add(row);
        }

        window.add(page);
    }
}

