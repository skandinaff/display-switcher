/* prefs.js - Preferences dialog for Display Switcher */
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DISPLAY_CONFIG_XML = `<node>
    <interface name="org.gnome.Mutter.DisplayConfig">
        <method name="GetCurrentState">
            <arg name="serial" direction="out" type="u" />
            <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />
            <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />
            <arg name="properties" direction="out" type="a{sv}" />
        </method>
    </interface>
</node>`;
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DISPLAY_CONFIG_XML);

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

function getDisplayDdcLabel(monitor) {
    if (typeof monitor?.id === 'number')
        return `DDC ${monitor.id}`;
    return '';
}

function getDisplayDdcSubtitle(monitor) {
    const label = getDisplayDdcLabel(monitor);
    return label ? _('DDC ID: ') + label.replace('DDC ', '') : '';
}

function getAutoDetectionIdentitySubtitle(monitor) {
    const parts = [];
    const ddcSubtitle = getDisplayDdcSubtitle(monitor);
    if (ddcSubtitle)
        parts.push(ddcSubtitle);
    const serial = normalizeSerial(monitor?.serial);
    if (serial)
        parts.push(_('SN: ') + serial);
    return parts.join('  •  ');
}

function appendSubtitlePart(parts, value) {
    if (value)
        parts.push(value);
}

function buildIdentifyToggleLabel(enabled) {
    return enabled ? _('Hide') : _('Show');
}

function updateIdentifyToggleButton(button, settings) {
    button.label = buildIdentifyToggleLabel(settings.get_boolean('show-identify-overlays'));
}

function toggleIdentifyOverlays(settings) {
    settings.set_boolean('show-identify-overlays', !settings.get_boolean('show-identify-overlays'));
}

function getMonitorSortRank(position) {
    if (position === 'left')
        return 0;
    if (position === 'center')
        return 1;
    if (position === 'right')
        return 2;
    return 3;
}

function sortMonitorsForDisplay(monitors) {
    return [...monitors].sort((a, b) => {
        return (getMonitorSortRank(a.position) - getMonitorSortRank(b.position)) ||
            (a.id - b.id);
    });
}

function runCommand(argv, timeoutMs = 5000) {
    return new Promise(resolve => {
        let finished = false;
        let timeoutId = 0;
        let proc = null;

        const finish = result => {
            if (finished)
                return;
            finished = true;
            if (timeoutId) {
                try {
                    GLib.source_remove(timeoutId);
                } catch (_e) {
                    // ignore
                }
                timeoutId = 0;
            }
            resolve(result);
        };

        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (_e) {
            finish({ok: false, stdout: '', stderr: '', status: -1});
            return;
        }

        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [ok, stdout, stderr] = p.communicate_utf8_finish(res);
                const success = ok && p.get_successful();
                finish({
                    ok: !!success,
                    stdout: stdout || '',
                    stderr: stderr || '',
                    status: success ? 0 : 1,
                });
            } catch (_e) {
                finish({ok: false, stdout: '', stderr: '', status: -3});
            }
        });

        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(100, timeoutMs | 0), () => {
            try {
                proc.force_exit();
            } catch (_e) {
                // ignore
            }
            finish({ok: false, stdout: '', stderr: 'timeout', status: -2});
            return GLib.SOURCE_REMOVE;
        });
    });
}

function parseDetectedDisplays(text) {
    const displays = [];
    let current = null;

    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trimEnd();
        const matchDisplay = line.match(/^Display\s+(\d+)/);
        if (matchDisplay) {
            if (current)
                displays.push(current);
            current = {id: parseInt(matchDisplay[1], 10), model: '', serial: ''};
            continue;
        }
        if (!current)
            continue;

        const matchModel = line.match(/^\s*Model:\s*(.+)$/);
        if (matchModel && !current.model) {
            current.model = matchModel[1].trim();
            continue;
        }

        const matchSerial = line.match(/^\s*(?:Serial number|SN):\s*(.+)$/);
        if (matchSerial && !current.serial)
            current.serial = matchSerial[1].trim();
    }

    if (current)
        displays.push(current);
    return displays;
}

async function detectDisplaysAsync() {
    let result = await runCommand(['ddcutil', 'detect'], 5000);
    let displays = parseDetectedDisplays(result.stdout);
    if (result.ok && displays.length > 0)
        return {ok: true, displays};

    result = await runCommand(['ddcutil', 'detect', '--terse'], 5000);
    if (!result.ok)
        return {ok: false, displays: []};

    const terseDisplays = [];
    for (const line of String(result.stdout || '').split('\n')) {
        const matchDisplay = line.match(/^Display\s+(\d+)/);
        if (matchDisplay)
            terseDisplays.push({id: parseInt(matchDisplay[1], 10), model: '', serial: ''});
    }
    return {ok: true, displays: terseDisplays};
}

function getHostMonitorKey(connector, vendor, product, serial) {
    return [
        String(connector || ''),
        String(vendor || ''),
        String(product || ''),
        String(serial || ''),
    ].join('\u0000');
}

function normalizeDisplayName(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function connectorToAutoInputCode(connector) {
    const value = String(connector || '').trim().toLowerCase();
    if (value.startsWith('hdmi'))
        return '0x11';
    if (value.startsWith('usb-c') || value.startsWith('usbc') || value.includes('type-c'))
        return '0x1b';
    if (value.startsWith('dp') || value.startsWith('displayport') || value.startsWith('display-port'))
        return '0x0f';
    return '';
}

function extractActiveHostMonitors(monitors, logicalMonitors) {
    const monitorsByKey = new Map();
    for (const monitor of monitors) {
        const [monitorSpecs, _modes, props] = monitor;
        const [connector, vendor, product, serial] = monitorSpecs;
        let displayName = '';
        if (props && props['display-name'])
            displayName = String(props['display-name'].unpack() || '');
        monitorsByKey.set(
            getHostMonitorKey(connector, vendor, product, serial),
            {connector, vendor, product, serial, displayName}
        );
    }

    const active = [];
    const seen = new Set();
    for (const logicalMonitor of logicalMonitors) {
        const monitorsSpecs = logicalMonitor[5] || [];
        for (const monitorSpecs of monitorsSpecs) {
            const [connector, vendor, product, serial] = monitorSpecs;
            const key = getHostMonitorKey(connector, vendor, product, serial);
            if (seen.has(key))
                continue;
            seen.add(key);
            const monitor = monitorsByKey.get(key);
            if (monitor)
                active.push(monitor);
        }
    }

    return active;
}

async function loadActiveHostMonitorsAsync() {
    return new Promise(resolve => {
        let proxy = null;
        try {
            proxy = new DisplayConfigProxy(
                Gio.DBus.session,
                'org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig'
            );
        } catch (_e) {
            resolve({ok: false, activeHostMonitors: []});
            return;
        }

        proxy.GetCurrentStateRemote((result, err) => {
            if (err) {
                resolve({ok: false, activeHostMonitors: []});
                return;
            }

            try {
                const [, monitors, logicalMonitors] = result;
                resolve({
                    ok: true,
                    activeHostMonitors: extractActiveHostMonitors(monitors, logicalMonitors),
                });
            } catch (_e) {
                resolve({ok: false, activeHostMonitors: []});
            }
        });
    });
}

function getDisplayNameCandidates(display) {
    const candidates = [];
    const seen = new Set();
    for (const value of [display?.model, display?.labelBase, display?.label]) {
        const normalized = normalizeDisplayName(value);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        candidates.push(normalized);
    }
    return candidates;
}

function getMergedDetectedDisplay(display, knownMonitors) {
    const matched = findMonitor(knownMonitors, display);
    return matched ? {...matched, ...display} : display;
}

function findAutoConnectedInput(display, activeHostMonitors) {
    if (!display || !Array.isArray(activeHostMonitors) || activeHostMonitors.length === 0)
        return '';

    const serial = normalizeSerial(display.serial);
    if (serial) {
        const serialMatches = activeHostMonitors.filter(m => normalizeSerial(m.serial) === serial);
        if (serialMatches.length === 1)
            return connectorToAutoInputCode(serialMatches[0].connector);
    }

    const names = getDisplayNameCandidates(display);
    for (const name of names) {
        const modelMatches = activeHostMonitors.filter(m => normalizeDisplayName(m.displayName) === name);
        if (modelMatches.length === 1)
            return connectorToAutoInputCode(modelMatches[0].connector);
    }

    return '';
}

async function detectAutoConnectedInputsAsync(knownMonitors = []) {
    const [displayResult, hostResult] = await Promise.all([
        detectDisplaysAsync(),
        loadActiveHostMonitorsAsync(),
    ]);

    const detected = new Map();
    for (const display of displayResult.displays) {
        const mergedDisplay = getMergedDetectedDisplay(display, knownMonitors);
        const inputCode = findAutoConnectedInput(mergedDisplay, hostResult.activeHostMonitors);
        if (inputCode)
            detected.set(getMonitorIdentityKey(display), inputCode);
    }
    return {
        detected,
        ok: displayResult.ok && hostResult.ok,
        displayQueryOk: displayResult.ok,
        hostQueryOk: hostResult.ok,
    };
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
        window.set_default_size(720, 640);
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
            monitors = sortMonitorsForDisplay(monitors);
            const identifyDisplaysRow = new Adw.ActionRow({
                title: _('Identify Displays'),
                subtitle: _('Show persistent on-screen number overlays until you turn them off.'),
            });
            const identifyDisplaysButton = new Gtk.Button({
                label: buildIdentifyToggleLabel(settings.get_boolean('show-identify-overlays')),
                valign: Gtk.Align.CENTER,
            });
            settings.connect('changed::show-identify-overlays', () => {
                updateIdentifyToggleButton(identifyDisplaysButton, settings);
            });
            identifyDisplaysButton.connect('clicked', () => {
                toggleIdentifyOverlays(settings);
                updateIdentifyToggleButton(identifyDisplaysButton, settings);
            });
            identifyDisplaysRow.add_suffix(identifyDisplaysButton);
            monitorsGroup.add(identifyDisplaysRow);

            const connectionGroup = new Adw.PreferencesGroup({
                title: _('This Computer'),
                description: _('Mark which monitor input is physically connected to this computer. The menu shows that input with a plug marker.'),
            });
            page.add(connectionGroup);
            const autoDetectionGroup = new Adw.PreferencesGroup({
                title: _('Auto Detection'),
                description: _('Test what the automatic connected-input detection currently sees without changing saved settings.'),
            });
            page.add(autoDetectionGroup);

            // Build a row per monitor with inline ID, position dropdown, and usable inputs dropdown
            // Order for position: Unknown, Left, Center, Right
            const options = [_('Unknown'), _('Left'), _('Center'), _('Right')];
            const autoDetectionRows = new Map();
            const autoDetectionStatusRow = new Adw.ActionRow({
                title: _('Automatic Detection'),
                subtitle: _('Press Detect Now to test automatic cable detection.'),
            });
            const detectNowButton = new Gtk.Button({
                label: _('Detect Now'),
                valign: Gtk.Align.CENTER,
            });
            autoDetectionStatusRow.add_suffix(detectNowButton);
            autoDetectionGroup.add(autoDetectionStatusRow);

            for (const [index, mon] of monitors.entries()) {
                const row = new Adw.ActionRow();

                const title = mon.model && mon.model.length > 0 ? mon.model : `${_('Display')} ${mon.id}`;
                const numberedTitle = `${index + 1}. ${title}`;
                row.title = numberedTitle;
                row.subtitle = getDisplayDdcSubtitle(mon);

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
                    title: numberedTitle,
                    subtitle: `${_('This computer is connected via')}  •  ${getDisplayDdcSubtitle(mon)}`,
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

                const autoDetectionRow = new Adw.ActionRow({
                    title: numberedTitle,
                    subtitle: getAutoDetectionIdentitySubtitle(mon) || _('No automatic match yet'),
                    activatable: false,
                });
                autoDetectionRows.set(getMonitorIdentityKey(mon), autoDetectionRow);
                autoDetectionGroup.add(autoDetectionRow);
            }

            const updateAutoDetectionRows = async () => {
                detectNowButton.sensitive = false;
                autoDetectionStatusRow.subtitle = _('Detecting current connections…');

                let detection = null;
                try {
                    detection = await detectAutoConnectedInputsAsync(loadMonitors(settings));
                } catch (_e) {
                    detection = {
                        detected: new Map(),
                        ok: false,
                        displayQueryOk: false,
                        hostQueryOk: false,
                    };
                }

                const fresh = loadMonitors(settings);
                for (const mon of fresh) {
                    const row = autoDetectionRows.get(getMonitorIdentityKey(mon));
                    if (!row)
                        continue;

                    const detectedCode = normalizeVcpCode(detection.detected.get(getMonitorIdentityKey(mon)));
                    const manualCode = normalizeVcpCode(mon.connectedInput);
                    const parts = [];
                    appendSubtitlePart(parts, getAutoDetectionIdentitySubtitle(mon));
                    if (detectedCode)
                        appendSubtitlePart(parts, _('Detected automatically: ') + (INPUT_LABELS.get(detectedCode) || detectedCode));
                    else
                        appendSubtitlePart(parts, _('Detected automatically: Not detected'));
                    if (manualCode)
                        appendSubtitlePart(parts, _('Manual override: ') + (INPUT_LABELS.get(manualCode) || manualCode));
                    row.subtitle = parts.join('  •  ');
                }

                if (!detection.ok) {
                    autoDetectionStatusRow.subtitle = _(
                        'Automatic detection could not query all sources. Check logs or monitor connectivity.'
                    );
                } else if (detection.detected.size > 0) {
                    autoDetectionStatusRow.subtitle = _('Detection refreshed.');
                } else {
                    autoDetectionStatusRow.subtitle = _('No automatic matches found.');
                }
                detectNowButton.sensitive = true;
            };

            detectNowButton.connect('clicked', () => {
                void updateAutoDetectionRows();
            });
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
