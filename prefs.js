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
        const group = new Adw.PreferencesGroup({ title: _('Monitors') });
        page.add(group);

        let monitors = loadMonitors(settings);

        if (monitors.length === 0) {
            // PreferencesWindow accepts only Adw.PreferencesPage children.
            // Show an informational row instead of adding Adw.StatusPage directly.
            const emptyRow = new Adw.ActionRow({
                title: _('No monitors detected yet'),
                subtitle: _('Open the menu and run “Rescan Displays” to detect monitors, then reopen preferences.'),
            });
            const icon = new Gtk.Image({ icon_name: 'video-display-symbolic' });
            emptyRow.add_prefix(icon);
            group.add(emptyRow);
            window.add(page);
            return;
        }

        // Build a row per monitor with inline ID, position dropdown, and usable inputs dropdown
        // Order for position: Unknown, Left, Center, Right
        const options = [_('Unknown'), _('Left'), _('Center'), _('Right')];
        const INPUT_LABELS = new Map([
            ['0x11', _('HDMI')],
            ['0x0f', _('DP')],
            ['0x1b', _('USB-C')],
        ]);
        const ALL_CODES = ['0x11', '0x0f', '0x1b'];

        for (const mon of monitors) {
            const row = new Adw.ActionRow();

            const title = mon.model && mon.model.length > 0 ? mon.model : `${_('Display')} ${mon.id}`;
            row.title = title;
            const subtitleBits = [];
            if (mon.serial && mon.serial.length > 0)
                subtitleBits.push(_('Serial: ') + mon.serial);
            subtitleBits.push(_('ID: ') + String(mon.id));
            row.subtitle = subtitleBits.join('  •  ');

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
            // Usable inputs dropdown with checkmarks (popover menu)
            const inputsButton = new Gtk.MenuButton();
            inputsButton.valign = Gtk.Align.CENTER;

            const buttonLabel = new Gtk.Label({ xalign: 0.5 });
            const refreshButtonLabel = () => {
                const fresh = loadMonitors(settings);
                let target = fresh.find(m => m && m.id === mon.id);
                if (!target && mon.serial)
                    target = fresh.find(m => m && m.serial === mon.serial);
                const list = target && Array.isArray(target.usableInputs) ? target.usableInputs.map(v => String(v).toLowerCase()) : [];
                const effective = (list && list.length > 0) ? list : ALL_CODES;
                const text = effective.map(c => INPUT_LABELS.get(c) || c).join(', ');
                buttonLabel.label = text.length > 0 ? text : _('All');
            };
            refreshButtonLabel();

            inputsButton.set_child(buttonLabel);

            const popover = new Gtk.Popover();
            const listBox = new Gtk.ListBox();
            listBox.selection_mode = Gtk.SelectionMode.NONE;
            popover.set_child(listBox);

            const buildRow = (code) => {
                const lb = new Gtk.ListBoxRow();
                const h = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, margin_start: 10, margin_end: 10, margin_top: 6, margin_bottom: 6 });
                const lbl = new Gtk.Label({ label: INPUT_LABELS.get(code) || code, xalign: 0 });
                const check = new Gtk.Image({ icon_name: 'emblem-ok-symbolic', visible: false });
                h.append(lbl);
                h.append(new Gtk.Box({ hexpand: true }));
                h.append(check);
                lb.set_child(h);

                const isChecked = () => {
                    const fresh = loadMonitors(settings);
                    let target = fresh.find(m => m && m.id === mon.id);
                    if (!target && mon.serial)
                        target = fresh.find(m => m && m.serial === mon.serial);
                    const list = target && Array.isArray(target.usableInputs) ? target.usableInputs.map(v => String(v).toLowerCase()) : [];
                    if (!list || list.length === 0) // empty means all enabled
                        return true;
                    return list.includes(code);
                };

                const updateVisual = () => {
                    check.visible = isChecked();
                };
                updateVisual();

                const toggle = () => {
                    const fresh = loadMonitors(settings);
                    let target = fresh.find(m => m && m.id === mon.id);
                    if (!target && mon.serial)
                        target = fresh.find(m => m && m.serial === mon.serial);
                    if (!target)
                        return;
                    const list = Array.isArray(target.usableInputs) ? target.usableInputs.map(v => String(v).toLowerCase()) : [];
                    const idx = list.indexOf(code);
                    // Toggle: if currently included, remove; else add
                    if (idx >= 0)
                        list.splice(idx, 1);
                    else
                        list.push(code);
                    target.usableInputs = list;
                    saveMonitors(settings, fresh);
                    updateVisual();
                    refreshButtonLabel();
                };

                // Support keyboard activation
                lb.connect('activate', () => toggle());
                // Make mouse clicks toggle too when selection is NONE
                const click = new Gtk.GestureClick();
                click.connect('released', () => toggle());
                lb.add_controller(click);
                return lb;
            };

            for (const code of ALL_CODES)
                listBox.append(buildRow(code));

            inputsButton.popover = popover;
            row.add_suffix(inputsButton);
            group.add(row);
        }

        window.add(page);
    }
}
