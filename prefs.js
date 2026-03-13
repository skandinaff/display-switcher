/* prefs.js - Preferences dialog for Display Switcher */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function normalizePosition(value) {
    let position = String(value || '').toLowerCase();
    if (position === 'centre')
        position = 'center';
    return (position === 'left' || position === 'center' || position === 'right') ? position : '';
}

function normalizeVcpCode(value) {
    if (value === null || typeof value === 'undefined')
        return '';
    let code = String(value).toLowerCase();
    if (/^\d+$/.test(code)) {
        const n = parseInt(code, 10);
        if (Number.isFinite(n))
            code = '0x' + n.toString(16).padStart(2, '0');
    }
    return code;
}

function normalizeSerial(value) {
    return String(value || '').trim();
}

function getMonitorIdentityKey(monitor) {
    if (!monitor)
        return '';
    const serial = normalizeSerial(monitor.serial);
    if (serial)
        return `serial:${serial}`;
    return (typeof monitor.id === 'number') ? `id:${monitor.id}` : '';
}

function findMonitor(list, monitor) {
    if (!Array.isArray(list) || !monitor)
        return null;
    const serial = normalizeSerial(monitor.serial);
    if (serial) {
        const serialMatches = list.filter(item => normalizeSerial(item.serial) === serial);
        if (serialMatches.length === 1)
            return serialMatches[0];
    }
    return list.find(item => item && item.id === monitor.id) || null;
}

function enforceUniquePositions(list, preferredMonitor = null) {
    const preferredKey = getMonitorIdentityKey(preferredMonitor);
    const seen = new Map();
    for (const monitor of list) {
        const position = normalizePosition(monitor.position);
        monitor.position = position;
        if (!position)
            continue;
        if (!seen.has(position)) {
            seen.set(position, monitor);
            continue;
        }

        const currentKey = getMonitorIdentityKey(monitor);
        const previous = seen.get(position);
        const previousKey = getMonitorIdentityKey(previous);
        if (preferredKey && currentKey === preferredKey) {
            previous.position = '';
            seen.set(position, monitor);
        } else if (preferredKey && previousKey === preferredKey) {
            monitor.position = '';
        } else {
            monitor.position = '';
        }
    }
}

function sanitizeMonitors(list, preferredMonitor = null) {
    const monitors = Array.isArray(list) ? list.map(monitor => {
        const next = {...monitor};
        next.position = normalizePosition(next.position);
        next.lastInput = normalizeVcpCode(next.lastInput);
        next.connectedInput = normalizeVcpCode(next.connectedInput);
        if (Array.isArray(next.usableInputs)) {
            next.usableInputs = next.usableInputs
                .map(value => normalizeVcpCode(value))
                .filter(value => value);
        }
        return next;
    }) : [];
    enforceUniquePositions(monitors, preferredMonitor);
    return monitors;
}

function monitorsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function loadMonitorsRaw(settings) {
    const arr = settings.get_strv('monitors');
    const list = [];
    for (const s of arr) {
        try {
            const o = JSON.parse(s);
            if (o && typeof o.id === 'number')
                list.push(o);
        } catch (_e) {
            // skip
        }
    }
    return list;
}

function loadMonitors(settings) {
    return sanitizeMonitors(loadMonitorsRaw(settings));
}

function saveMonitors(settings, list, preferredMonitor = null) {
    try {
        const sanitized = sanitizeMonitors(list, preferredMonitor);
        const arr = sanitized.map(o => JSON.stringify(o));
        settings.set_strv('monitors', arr);
    } catch (_e) {
        // ignore
    }
}

export default class DisplaySwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(520, 460);
        const settings = this.getSettings();
        const version = String(this.metadata.version ?? _('Unknown'));
        const INPUT_CODES = ['0x11', '0x0f', '0x1b'];
        const INPUT_LABELS = new Map([
            ['0x11', _('HDMI')],
            ['0x0f', _('DP')],
            ['0x1b', _('USB-C')],
        ]);
        const CONNECTED_OPTIONS = [_('Not set'), _('HDMI'), _('DP'), _('USB-C')];

        const page = new Adw.PreferencesPage({ title: _('Display Switcher') });
        const monitorsGroup = new Adw.PreferencesGroup({ title: _('Monitors') });
        page.add(monitorsGroup);

        const storedMonitors = loadMonitorsRaw(settings);
        let monitors = sanitizeMonitors(storedMonitors);
        if (!monitorsEqual(storedMonitors, monitors))
            saveMonitors(settings, monitors);

        if (monitors.length === 0) {
            // PreferencesWindow accepts only Adw.PreferencesPage children.
            // Show an informational row instead of adding Adw.StatusPage directly.
            const emptyRow = new Adw.ActionRow({
                title: _('No monitors detected yet'),
                subtitle: _('Open the menu and run “Rescan Displays” to detect monitors, then reopen preferences.'),
            });
            const icon = new Gtk.Image({ icon_name: 'video-display-symbolic' });
            emptyRow.add_prefix(icon);
            monitorsGroup.add(emptyRow);
        } else {
            const connectionGroup = new Adw.PreferencesGroup({
                title: _('This Computer'),
                description: _('Mark which monitor input is physically connected to this computer. The menu shows that input with a plug marker.'),
            });
            page.add(connectionGroup);

            // Build a row per monitor with inline ID, position dropdown, and usable inputs dropdown
            // Order for position: Unknown, Left, Center, Right
            const options = [_('Unknown'), _('Left'), _('Center'), _('Right')];

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
                    const target = findMonitor(monitors, mon);
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
                    saveMonitors(settings, monitors, target);
                });

                row.add_suffix(drop);
                // Usable inputs dropdown with checkmarks (popover menu)
                const inputsButton = new Gtk.MenuButton();
                inputsButton.valign = Gtk.Align.CENTER;

                const buttonLabel = new Gtk.Label({ xalign: 0.5 });
                const refreshButtonLabel = () => {
                    const fresh = loadMonitors(settings);
                    const target = findMonitor(fresh, mon);
                    const list = target && Array.isArray(target.usableInputs) ? target.usableInputs.map(v => String(v).toLowerCase()) : [];
                    const effective = (list && list.length > 0) ? list : INPUT_CODES;
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
                        const target = findMonitor(fresh, mon);
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
                        const target = findMonitor(fresh, mon);
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
                        saveMonitors(settings, fresh, target);
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

                for (const code of INPUT_CODES)
                    listBox.append(buildRow(code));

                inputsButton.popover = popover;
                row.add_suffix(inputsButton);
                monitorsGroup.add(row);

                const connectionRow = new Adw.ActionRow({
                    title,
                    subtitle: _('This computer is connected via'),
                });
                const connectionOptions = new Gtk.StringList();
                for (const option of CONNECTED_OPTIONS)
                    connectionOptions.append(option);

                const connectionDrop = new Gtk.DropDown({ model: connectionOptions });
                connectionDrop.valign = Gtk.Align.CENTER;

                const refreshConnectionSelection = () => {
                    const fresh = loadMonitors(settings);
                    const target = findMonitor(fresh, mon);
                    const connectedInput = normalizeVcpCode(target ? target.connectedInput : '');
                    let selected = 0;
                    if (connectedInput === '0x11')
                        selected = 1;
                    else if (connectedInput === '0x0f')
                        selected = 2;
                    else if (connectedInput === '0x1b')
                        selected = 3;
                    connectionDrop.selected = selected;
                };
                refreshConnectionSelection();

                connectionDrop.connect('notify::selected', () => {
                    const fresh = loadMonitors(settings);
                    const target = findMonitor(fresh, mon);
                    if (!target)
                        return;

                    if (connectionDrop.selected === 1)
                        target.connectedInput = '0x11';
                    else if (connectionDrop.selected === 2)
                        target.connectedInput = '0x0f';
                    else if (connectionDrop.selected === 3)
                        target.connectedInput = '0x1b';
                    else
                        target.connectedInput = '';

                    saveMonitors(settings, fresh);
                });

                connectionRow.add_suffix(connectionDrop);
                connectionGroup.add(connectionRow);
            }
        }

        const aboutGroup = new Adw.PreferencesGroup({ title: _('About') });
        const versionRow = new Adw.ActionRow({
            title: _('Version'),
            activatable: false,
        });
        versionRow.add_suffix(new Gtk.Label({
            label: version,
            selectable: true,
            valign: Gtk.Align.CENTER,
        }));
        aboutGroup.add(versionRow);
        page.add(aboutGroup);

        window.add(page);
    }
}
