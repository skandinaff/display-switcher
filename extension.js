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
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// VCP 0x60 (Input Select) common values we expose:
// 0x11 (HDMI-1), 0x0f (DisplayPort-1), 0x1b (USB-C)
const ACTIVE_INPUT_REFRESH_STALE_MS = 15000;
const MONITOR_CHANGE_RESCAN_DELAY_MS = 1500;
const AUTO_CONNECTED_INPUT_REFRESH_DELAY_MS = 250;
const IDENTIFY_OVERLAY_TIMEOUT_MS = 2500;
const INPUT_CODES = ['0x11', '0x0f', '0x1b'];
const DISPLAY_CONFIG_XML = `<node>
    <interface name="org.gnome.Mutter.DisplayConfig">
        <method name="GetCurrentState">
            <arg name="serial" direction="out" type="u" />
            <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />
            <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />
            <arg name="properties" direction="out" type="a{sv}" />
        </method>
        <signal name="MonitorsChanged" />
    </interface>
</node>`;
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DISPLAY_CONFIG_XML);

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
        // Track GLib main loop source ids (timeouts/idles) for cleanup
        this._sourceIds = new Set();
        // Enforce single pending timeout/idle at a time per EGO guidance
        this._pendingTimeoutId = 0;
        this._pendingIdleId = 0;
        // Per-display input menu items to toggle checkmarks
        // Map: displayId -> Map<vcpCode, PopupMenuItem>
        this._inputItemsByDisplay = new Map();
        this._lastActiveInputRefreshUsec = 0;
        this._activeInputRefreshPromise = null;
        this._displayRefreshTimeoutId = 0;
        this._autoConnectionRefreshTimeoutId = 0;
        this._menuRebuildIdleId = 0;
        this._activeHostMonitors = [];
        this._displayConfigProxy = null;
        this._displayConfigSignalId = 0;
        this._autoConnectionRefreshInFlight = false;
        this._autoConnectionRefreshQueued = false;
        this._identifyOverlayTimeoutId = 0;
        this._identifyOverlayActors = [];
        this._identifyOverlaySettingsChangedId = 0;
        this._thisComputerMarkerSettingsChangedId = 0;

        if (this._settings)
            this._sanitizeStoredMonitorRecords();

        this._initDisplayConfig();
        this._displays = this._detectDisplays();
        if (this._settings) {
            // React to updates in consolidated monitor records
            this._settingsChangedId = this._settings.connect('changed::monitors', () => {
                this._relabelDisplays();
                this._buildMenu();
                this._syncIdentifyOverlaysFromSettings();
            });
            this._identifyOverlaySettingsChangedId = this._settings.connect('changed::show-identify-overlays', () => {
                this._syncIdentifyOverlaysFromSettings();
            });
            this._thisComputerMarkerSettingsChangedId = this._settings.connect('changed::this-computer-marker', () => {
                this._buildMenu();
            });
        }
        this._menuOpenChangedId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._maybeRefreshActiveInputs(false);
        });
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._scheduleDisplayRefresh();
        });
        this._buildMenu();
        this._syncIdentifyOverlaysFromSettings();
        this._maybeRefreshActiveInputs(true);
    }

    destroy() {
        // Remove any pending GLib sources we created
        if (this._sourceIds && this._sourceIds.size > 0) {
            try {
                for (const id of this._sourceIds) {
                    try { GLib.source_remove(id); } catch (_e) {}
                }
            } finally {
                this._sourceIds.clear();
            }
        }
        this._pendingTimeoutId = 0;
        this._pendingIdleId = 0;
        if (this._displayRefreshTimeoutId) {
            try { GLib.source_remove(this._displayRefreshTimeoutId); } catch (_e) {}
            this._untrackSource(this._displayRefreshTimeoutId);
            this._displayRefreshTimeoutId = 0;
        }
        if (this._autoConnectionRefreshTimeoutId) {
            try { GLib.source_remove(this._autoConnectionRefreshTimeoutId); } catch (_e) {}
            this._untrackSource(this._autoConnectionRefreshTimeoutId);
            this._autoConnectionRefreshTimeoutId = 0;
        }
        if (this._menuRebuildIdleId) {
            try { GLib.source_remove(this._menuRebuildIdleId); } catch (_e) {}
            this._untrackSource(this._menuRebuildIdleId);
            this._menuRebuildIdleId = 0;
        }
        if (this._identifyOverlayTimeoutId) {
            try { GLib.source_remove(this._identifyOverlayTimeoutId); } catch (_e) {}
            this._untrackSource(this._identifyOverlayTimeoutId);
            this._identifyOverlayTimeoutId = 0;
        }
        this._clearIdentifyOverlays();
        if (this._displayConfigProxy && this._displayConfigSignalId) {
            try { this._displayConfigProxy.disconnectSignal(this._displayConfigSignalId); } catch (_e) {}
            this._displayConfigSignalId = 0;
        }
        this._displayConfigProxy = null;
        if (this._settings && this._settingsChangedId) {
            try { this._settings.disconnect(this._settingsChangedId); } catch (_e) {}
            this._settingsChangedId = 0;
        }
        if (this._menuOpenChangedId) {
            try { this.menu.disconnect(this._menuOpenChangedId); } catch (_e) {}
            this._menuOpenChangedId = 0;
        }
        if (this._settings && this._identifyOverlaySettingsChangedId) {
            try { this._settings.disconnect(this._identifyOverlaySettingsChangedId); } catch (_e) {}
            this._identifyOverlaySettingsChangedId = 0;
        }
        if (this._settings && this._thisComputerMarkerSettingsChangedId) {
            try { this._settings.disconnect(this._thisComputerMarkerSettingsChangedId); } catch (_e) {}
            this._thisComputerMarkerSettingsChangedId = 0;
        }
        if (this._monitorsChangedId) {
            try { Main.layoutManager.disconnect(this._monitorsChangedId); } catch (_e) {}
            this._monitorsChangedId = 0;
        }
        super.destroy();
    }

    _clearMenu() {
        this.menu.removeAll();
    }

    _getInputLabel(code) {
        const norm = this._normalizeVcpCode(code);
        if (norm === '0x11')
            return _('HDMI');
        if (norm === '0x0f')
            return _('DP');
        if (norm === '0x1b')
            return _('USB-C');
        return String(code || '');
    }

    _getInputMenuLabel(display, code) {
        const label = this._getInputLabel(code);
        const connectedInput = display ? this._getEffectiveConnectedInput(display) : '';
        const decorations = [];
        if (connectedInput === this._normalizeVcpCode(code))
            decorations.push(this._getThisComputerMarker());
        const marker = this._getCustomInputMarker(display, code);
        if (marker)
            decorations.push(marker);
        return decorations.length > 0 ? `${label} ${decorations.join(' ')}` : label;
    }

    _getEffectiveConnectedInput(display) {
        if (!display)
            return '';
        return this._normalizeVcpCode(display.connectedInput) || this._normalizeVcpCode(display.autoConnectedInput);
    }

    _truncateGraphemes(value, limit = 3) {
        const text = String(value || '').trim();
        if (!text)
            return '';

        const max = Math.max(1, limit | 0);
        const Segmenter = globalThis.Intl?.Segmenter;
        if (!Segmenter)
            return Array.from(text).slice(0, max).join('');

        const segmenter = new Segmenter(undefined, {granularity: 'grapheme'});
        let out = '';
        let count = 0;
        for (const {segment} of segmenter.segment(text)) {
            if (count >= max)
                break;
            out += segment;
            count += 1;
        }
        return out;
    }

    _normalizeInputMarker(value) {
        return this._truncateGraphemes(value, 3);
    }

    _normalizeSingleMarker(value, fallback = '🔌') {
        const marker = this._truncateGraphemes(value, 1);
        return marker || fallback;
    }

    _normalizeInputLabels(labels) {
        if (!labels || typeof labels !== 'object')
            return undefined;

        const next = {};
        for (const [rawCode, rawMarker] of Object.entries(labels)) {
            const code = this._normalizeVcpCode(rawCode);
            const marker = this._normalizeInputMarker(rawMarker);
            if (INPUT_CODES.includes(code) && marker)
                next[code] = marker;
        }
        return Object.keys(next).length > 0 ? next : undefined;
    }

    _getCustomInputMarker(display, code) {
        if (!display || !display.inputLabels || typeof display.inputLabels !== 'object')
            return '';
        const labels = this._normalizeInputLabels(display.inputLabels);
        const normalizedCode = this._normalizeVcpCode(code);
        return labels?.[normalizedCode] || '';
    }

    _getThisComputerMarker() {
        try {
            return this._normalizeSingleMarker(this._settings?.get_string('this-computer-marker'), '🔌');
        } catch (_e) {
            return '🔌';
        }
    }

    _getDisplayMenuTitle(display) {
        const baseName = display?.model || `${_('Display')} ${display?.id ?? ''}`.trim();
        const ddcId = (typeof display?.id === 'number') ? ` ${display.id}` : '';
        let positionSuffix = '';
        if (display?.position === 'left')
            positionSuffix = ` (${_('Left')})`;
        else if (display?.position === 'center')
            positionSuffix = ` (${_('Center')})`;
        else if (display?.position === 'right')
            positionSuffix = ` (${_('Right')})`;
        return `${baseName}${ddcId}${positionSuffix}`.trim();
    }

    _getDisplaySortRank(position) {
        if (position === 'left')
            return 0;
        if (position === 'center')
            return 1;
        if (position === 'right')
            return 2;
        return 3;
    }

    _getSortedDisplays() {
        const list = [...this._displays];
        list.sort((a, b) => {
            return (this._getDisplaySortRank(a.position) - this._getDisplaySortRank(b.position)) ||
                (a.id - b.id);
        });
        return list;
    }

    _buildMenu() {
        this._clearMenu();
        this._inputItemsByDisplay.clear();

        // Refresh labels with position tags if any (from monitors records)
        this._relabelDisplays();

        // Per-display submenus
        const list = this._getSortedDisplays();

        for (const d of list) {
            const label = this._getDisplayMenuTitle(d);
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            // Build input options and wire up dynamic checkmarks based on persisted last input
            const items = new Map();

            const itemHdmi = new PopupMenu.PopupMenuItem(this._getInputMenuLabel(d, '0x11'));
            itemHdmi.connect('activate', () => this._switchOne('0x11', d.id));
            sub.menu.addMenuItem(itemHdmi);
            items.set('0x11', itemHdmi);

            const itemDp = new PopupMenu.PopupMenuItem(this._getInputMenuLabel(d, '0x0f'));
            itemDp.connect('activate', () => this._switchOne('0x0f', d.id));
            sub.menu.addMenuItem(itemDp);
            items.set('0x0f', itemDp);

            const itemUsbC = new PopupMenu.PopupMenuItem(this._getInputMenuLabel(d, '0x1b'));
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
        if (this._displays.length > 0) {
            this.menu.addAction(_('Identify Displays'), () => {
                this._showIdentifyOverlays(this._isPersistentIdentifyEnabled());
            });
        }
        this.menu.addAction(_('Rescan Displays'), () => {
            this._refreshDisplays(true);
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
        this._runSetVcp(vcpValue, d || {id: display});
        if (d) {
            // Optimistically persist selection to keep UI responsive
            d.lastInput = String(vcpValue).toLowerCase();
            this._saveLastInputForDisplay(d, d.lastInput);
            this._updateSelectionMarkers(d.id, d.lastInput);
            this._lastActiveInputRefreshUsec = GLib.get_monotonic_time();
        }
    }

    _runSetVcp(vcpValue, display) {
        const argv = ['ddcutil', ...this._buildDisplayArgs(display), 'setvcp', '60', String(vcpValue)];
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (_e) {
            // Ignore failures; the optimistic UI state will be corrected on refresh.
        }
    }

    _initDisplayConfig() {
        try {
            this._displayConfigProxy = new DisplayConfigProxy(
                Gio.DBus.session,
                'org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig'
            );
            this._displayConfigSignalId = this._displayConfigProxy.connectSignal('MonitorsChanged', () => {
                this._scheduleAutoConnectedInputRefresh();
            });
            this._scheduleAutoConnectedInputRefresh(true);
        } catch (_e) {
            this._displayConfigProxy = null;
            this._displayConfigSignalId = 0;
        }
    }

    _scheduleAutoConnectedInputRefresh(immediate = false) {
        if (!this._displayConfigProxy)
            return;
        if (this._autoConnectionRefreshTimeoutId) {
            try { GLib.source_remove(this._autoConnectionRefreshTimeoutId); } catch (_e) {}
            this._untrackSource(this._autoConnectionRefreshTimeoutId);
            this._autoConnectionRefreshTimeoutId = 0;
        }
        const delay = immediate ? 0 : AUTO_CONNECTED_INPUT_REFRESH_DELAY_MS;
        this._autoConnectionRefreshTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._untrackSource(this._autoConnectionRefreshTimeoutId);
                this._autoConnectionRefreshTimeoutId = 0;
                this._refreshAutoConnectedInputs();
                return GLib.SOURCE_REMOVE;
            }
        );
        this._trackSource(this._autoConnectionRefreshTimeoutId);
    }

    _refreshAutoConnectedInputs() {
        if (!this._displayConfigProxy)
            return;
        if (this._autoConnectionRefreshInFlight) {
            this._autoConnectionRefreshQueued = true;
            return;
        }

        this._autoConnectionRefreshInFlight = true;
        this._displayConfigProxy.GetCurrentStateRemote((result, err) => {
            if (!this._displayConfigProxy)
                return;
            this._autoConnectionRefreshInFlight = false;
            if (err) {
                if (this._clearAutoConnectedInputs())
                    this._queueMenuRebuild();
            } else {
                try {
                    const [, monitors, logicalMonitors] = result;
                    this._activeHostMonitors = this._extractActiveHostMonitors(monitors, logicalMonitors);
                    if (this._applyAutoConnectedInputs(this._displays))
                        this._queueMenuRebuild();
                } catch (_e) {
                    if (this._clearAutoConnectedInputs())
                        this._queueMenuRebuild();
                }
            }

            if (this._autoConnectionRefreshQueued) {
                this._autoConnectionRefreshQueued = false;
                this._scheduleAutoConnectedInputRefresh(true);
            }
        });
    }

    _queueMenuRebuild() {
        if (this._menuRebuildIdleId)
            return;
        this._menuRebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._untrackSource(this._menuRebuildIdleId);
            this._menuRebuildIdleId = 0;
            this._buildMenu();
            return GLib.SOURCE_REMOVE;
        });
        this._trackSource(this._menuRebuildIdleId);
    }

    _isPersistentIdentifyEnabled() {
        try {
            return !!(this._settings && this._settings.get_boolean('show-identify-overlays'));
        } catch (_e) {
            return false;
        }
    }

    _syncIdentifyOverlaysFromSettings() {
        if (this._isPersistentIdentifyEnabled())
            this._showIdentifyOverlays(true);
        else
            this._clearIdentifyOverlaysAndTimeout();
    }

    _clearIdentifyOverlaysAndTimeout() {
        if (this._identifyOverlayTimeoutId) {
            try { GLib.source_remove(this._identifyOverlayTimeoutId); } catch (_e) {}
            this._untrackSource(this._identifyOverlayTimeoutId);
            this._identifyOverlayTimeoutId = 0;
        }
        this._clearIdentifyOverlays();
    }

    _showIdentifyOverlays(persistent = false) {
        if (!Array.isArray(this._displays) || this._displays.length === 0)
            return;

        this._clearIdentifyOverlaysAndTimeout();

        const list = this._getSortedDisplays();
        for (const display of list) {
            const actor = this._createIdentifyOverlayActor(display);
            if (!actor)
                continue;
            this._identifyOverlayActors.push(actor);
            Main.uiGroup.add_child(actor);
        }

        if (this._identifyOverlayActors.length === 0)
            return;

        if (persistent)
            return;

        this._identifyOverlayTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            IDENTIFY_OVERLAY_TIMEOUT_MS,
            () => {
                this._untrackSource(this._identifyOverlayTimeoutId);
                this._identifyOverlayTimeoutId = 0;
                this._clearIdentifyOverlays();
                return GLib.SOURCE_REMOVE;
            }
        );
        this._trackSource(this._identifyOverlayTimeoutId);
    }

    _clearIdentifyOverlays() {
        for (const actor of this._identifyOverlayActors) {
            try {
                actor.destroy();
            } catch (_e) {
                // ignore
            }
        }
        this._identifyOverlayActors = [];
    }

    _createIdentifyOverlayActor(display) {
        const monitorGeometry = this._findDisplayMonitorGeometry(display);
        if (!monitorGeometry)
            return null;

        const label = new St.Label({
            text: String(display.id),
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'color: white; font-size: 72px; font-weight: 700;',
        });
        const overlay = new St.Bin({
            child: label,
            width: 140,
            height: 140,
            x: Math.round(monitorGeometry.x + (monitorGeometry.width - 140) / 2),
            y: Math.round(monitorGeometry.y + monitorGeometry.height * 0.18),
            reactive: false,
            can_focus: false,
            style: 'background-color: rgba(221, 80, 20, 0.95); border-radius: 20px;',
        });
        return overlay;
    }

    _findDisplayMonitorGeometry(display) {
        const hostMonitor = this._findMatchingActiveHostMonitor(display);
        if (!hostMonitor)
            return null;

        return Main.layoutManager.monitors.find(monitor => {
            return monitor.x === hostMonitor.x && monitor.y === hostMonitor.y;
        }) || null;
    }

    _clearAutoConnectedInputs() {
        this._activeHostMonitors = [];
        if (!Array.isArray(this._displays))
            return false;

        let changed = false;
        for (const display of this._displays) {
            if (this._normalizeVcpCode(display.autoConnectedInput)) {
                delete display.autoConnectedInput;
                changed = true;
            }
        }
        return changed;
    }

    _extractActiveHostMonitors(monitors, logicalMonitors) {
        const monitorsByKey = new Map();
        for (const monitor of monitors) {
            const [monitorSpecs, _modes, props] = monitor;
            const [connector, vendor, product, serial] = monitorSpecs;
            let displayName = '';
            if (props && props['display-name'])
                displayName = String(props['display-name'].unpack() || '');
            const key = this._getHostMonitorKey(connector, vendor, product, serial);
            monitorsByKey.set(key, {connector, vendor, product, serial, displayName});
        }

        const active = [];
        const seen = new Set();
        for (const logicalMonitor of logicalMonitors) {
            const x = logicalMonitor[0];
            const y = logicalMonitor[1];
            const monitorsSpecs = logicalMonitor[5] || [];
            for (const monitorSpecs of monitorsSpecs) {
                const [connector, vendor, product, serial] = monitorSpecs;
                const key = this._getHostMonitorKey(connector, vendor, product, serial);
                if (seen.has(key))
                    continue;
                seen.add(key);
                const monitor = monitorsByKey.get(key);
                if (monitor)
                    active.push({...monitor, x, y});
            }
        }

        return active;
    }

    _getHostMonitorKey(connector, vendor, product, serial) {
        return [
            String(connector || ''),
            String(vendor || ''),
            String(product || ''),
            String(serial || ''),
        ].join('\u0000');
    }

    _normalizeDisplayName(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    _connectorToAutoInputCode(connector) {
        const value = String(connector || '').trim().toLowerCase();
        if (value.startsWith('hdmi'))
            return '0x11';
        if (value.startsWith('usb-c') || value.startsWith('usbc') || value.includes('type-c'))
            return '0x1b';
        if (value.startsWith('dp') || value.startsWith('displayport') || value.startsWith('display-port'))
            return '0x0f';
        return '';
    }

    _findAutoConnectedInput(display) {
        const monitor = this._findMatchingActiveHostMonitor(display);
        return monitor ? this._connectorToAutoInputCode(monitor.connector) : '';
    }

    _findMatchingActiveHostMonitor(display) {
        if (!display || !Array.isArray(this._activeHostMonitors) || this._activeHostMonitors.length === 0)
            return null;

        const serial = this._normalizeSerial(display.serial);
        if (serial) {
            const serialMatches = this._activeHostMonitors.filter(m => this._normalizeSerial(m.serial) === serial);
            if (serialMatches.length === 1)
                return serialMatches[0];
        }

        const model = this._normalizeDisplayName(display.model || display.labelBase || display.label || '');
        if (model) {
            const modelMatches = this._activeHostMonitors.filter(m => this._normalizeDisplayName(m.displayName) === model);
            if (modelMatches.length === 1)
                return modelMatches[0];
        }

        return null;
    }

    _applyAutoConnectedInputs(displays) {
        if (!Array.isArray(displays))
            return false;

        let changed = false;
        for (const display of displays) {
            const previous = this._normalizeVcpCode(display.autoConnectedInput);
            const next = this._findAutoConnectedInput(display);
            if (next) {
                display.autoConnectedInput = next;
            } else {
                delete display.autoConnectedInput;
            }
            if (previous !== next)
                changed = true;
        }
        return changed;
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
            this._applyAutoConnectedInputs(displays);
            this._persistMonitors(displays);

            return displays;
        } catch (e) {
            return [];
        }
    }

    // Read current input for a single display via ddcutil getvcp 60
    async _readInputOne(display) {
        const args = ['ddcutil', ...this._buildDisplayArgs(display), 'getvcp', '60'];
        if (args.length < 4)
            return { code: null, raw: '' };
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
            const { code } = await this._readInputOne(d);
            if (!code)
                continue;
            d.lastInput = String(code).toLowerCase();
            this._saveLastInputForDisplay(d, d.lastInput);
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

            // Remove any previously scheduled timeout/idle before creating a new one
            if (this._pendingTimeoutId) {
                try { GLib.source_remove(this._pendingTimeoutId); } catch (_e) {}
                this._untrackSource(this._pendingTimeoutId);
                this._pendingTimeoutId = 0;
            }
            if (this._pendingIdleId) {
                try { GLib.source_remove(this._pendingIdleId); } catch (_e) {}
                this._untrackSource(this._pendingIdleId);
                this._pendingIdleId = 0;
            }
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
                    try { GLib.source_remove(timeoutId); } catch (_e) {}
                    this._untrackSource(timeoutId);
                    if (this._pendingTimeoutId === timeoutId)
                        this._pendingTimeoutId = 0;
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
                const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    resolve({ ok: false, stdout: '', stderr: 'timeout', status: -2 });
                    this._untrackSource(idleId);
                    if (this._pendingIdleId === idleId)
                        this._pendingIdleId = 0;
                    return GLib.SOURCE_REMOVE;
                });
                this._trackSource(idleId);
                this._pendingIdleId = idleId;
                this._untrackSource(timeoutId);
                return GLib.SOURCE_REMOVE;
            });
            this._trackSource(timeoutId);
            this._pendingTimeoutId = timeoutId;
        });
    }

    _trackSource(id) {
        if (!id) return;
        this._sourceIds.add(id);
    }

    _untrackSource(id) {
        if (!id) return;
        this._sourceIds.delete(id);
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

    _normalizePosition(value) {
        let position = String(value || '').toLowerCase();
        if (position === 'centre')
            position = 'center';
        return (position === 'left' || position === 'center' || position === 'right') ? position : '';
    }

    _normalizeSerial(value) {
        return String(value || '').trim();
    }

    _getRecordIdentityKey(item) {
        if (!item)
            return '';
        const serial = this._normalizeSerial(item.serial);
        if (serial)
            return `serial:${serial}`;
        const id = (typeof item === 'number') ? item : item.id;
        return (typeof id === 'number') ? `id:${id}` : '';
    }

    _findMatchingRecord(records, item) {
        if (!Array.isArray(records) || !item)
            return null;
        const serial = this._normalizeSerial(typeof item === 'object' ? item.serial : '');
        if (serial) {
            const serialMatches = records.filter(r => this._normalizeSerial(r.serial) === serial);
            if (serialMatches.length === 1)
                return serialMatches[0];
        }
        const model = this._normalizeDisplayName(typeof item === 'object' ? item.model : '');
        if (model) {
            const modelMatches = records.filter(r => this._normalizeDisplayName(r?.model) === model);
            if (modelMatches.length === 1)
                return modelMatches[0];
        }
        const id = (typeof item === 'number') ? item : item.id;
        if (typeof id !== 'number')
            return null;
        return records.find(r => r && r.id === id) || null;
    }

    _enforceUniquePositions(records, preferredIdentity = '') {
        const seen = new Map();
        for (const record of records) {
            const position = this._normalizePosition(record.position);
            record.position = position;
            if (!position)
                continue;
            if (!seen.has(position)) {
                seen.set(position, record);
                continue;
            }

            const currentIdentity = this._getRecordIdentityKey(record);
            const previousRecord = seen.get(position);
            const previousIdentity = this._getRecordIdentityKey(previousRecord);
            if (preferredIdentity && currentIdentity === preferredIdentity) {
                previousRecord.position = '';
                seen.set(position, record);
            } else if (preferredIdentity && previousIdentity === preferredIdentity) {
                record.position = '';
            } else {
                record.position = '';
            }
        }
    }

    _sanitizeMonitorRecords(records, preferredItem = null) {
        const sanitized = Array.isArray(records) ? records.map(record => {
            const next = {...record};
            next.position = this._normalizePosition(next.position);
            next.lastInput = this._normalizeVcpCode(next.lastInput);
            next.connectedInput = this._normalizeVcpCode(next.connectedInput);
            next.inputLabels = this._normalizeInputLabels(next.inputLabels);
            if (Array.isArray(next.usableInputs)) {
                next.usableInputs = next.usableInputs
                    .map(v => this._normalizeVcpCode(v))
                    .filter(v => v);
            }
            return next;
        }) : [];
        this._enforceUniquePositions(sanitized, this._getRecordIdentityKey(preferredItem));
        return sanitized;
    }

    _monitorRecordsEqual(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    _loadMonitorRecordsRaw() {
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

    _sanitizeStoredMonitorRecords() {
        if (!this._settings)
            return;
        const raw = this._loadMonitorRecordsRaw();
        const sanitized = this._sanitizeMonitorRecords(raw);
        if (this._monitorRecordsEqual(raw, sanitized))
            return;
        try {
            this._settings.set_strv('monitors', sanitized.map(r => JSON.stringify(r)));
        } catch (_e) {}
    }

    _serialIsUniqueAmongDisplays(serial) {
        if (!serial)
            return false;
        let count = 0;
        for (const display of (this._displays || [])) {
            if (this._normalizeSerial(display.serial) === serial)
                count += 1;
        }
        return count === 1;
    }

    _buildDisplayArgs(display) {
        if (!display)
            return [];
        const serial = this._normalizeSerial(typeof display === 'object' ? display.serial : '');
        if (serial && this._serialIsUniqueAmongDisplays(serial))
            return ['--sn', serial];
        const id = (typeof display === 'number') ? display : display.id;
        return (typeof id === 'number') ? ['--display', String(id)] : [];
    }

    _isActiveInputRefreshStale(maxAgeMs = ACTIVE_INPUT_REFRESH_STALE_MS) {
        if (!this._lastActiveInputRefreshUsec)
            return true;
        const ageUs = GLib.get_monotonic_time() - this._lastActiveInputRefreshUsec;
        return ageUs >= (maxAgeMs * 1000);
    }

    _maybeRefreshActiveInputs(force = false) {
        if (!this._displays || this._displays.length === 0)
            return null;
        if (this._activeInputRefreshPromise)
            return this._activeInputRefreshPromise;
        if (!force && !this._isActiveInputRefreshStale())
            return null;

        this._activeInputRefreshPromise = this._rescanActiveInputs()
            .catch(() => {})
            .finally(() => {
                this._lastActiveInputRefreshUsec = GLib.get_monotonic_time();
                this._activeInputRefreshPromise = null;
            });
        return this._activeInputRefreshPromise;
    }

    _scheduleDisplayRefresh() {
        if (this._displayRefreshTimeoutId) {
            try { GLib.source_remove(this._displayRefreshTimeoutId); } catch (_e) {}
            this._untrackSource(this._displayRefreshTimeoutId);
            this._displayRefreshTimeoutId = 0;
        }
        this._displayRefreshTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            MONITOR_CHANGE_RESCAN_DELAY_MS,
            () => {
                this._untrackSource(this._displayRefreshTimeoutId);
                this._displayRefreshTimeoutId = 0;
                this._refreshDisplays(true);
                return GLib.SOURCE_REMOVE;
            }
        );
        this._trackSource(this._displayRefreshTimeoutId);
    }

    _refreshDisplays(forceInputRefresh = false) {
        this._displays = this._detectDisplays();
        this._buildMenu();
        this._syncIdentifyOverlaysFromSettings();
        this._scheduleAutoConnectedInputRefresh();
        if (forceInputRefresh)
            this._maybeRefreshActiveInputs(true);
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
        this._applyAutoConnectedInputs(this._displays);
    }

    _persistMonitors(displays) {
        if (!this._settings)
            return;
        if (!Array.isArray(displays) || displays.length === 0)
            return; // Avoid wiping settings when detection returns nothing
        try {
            const existing = this._loadMonitorRecords();
            const merged = [];
            const matchedExisting = new Set();
            for (const d of displays) {
                const prev = this._findMatchingRecord(existing, d) || {};
                if (prev && Object.keys(prev).length > 0)
                    matchedExisting.add(prev);
                const rec = {
                    id: d.id,
                    model: d.model || '',
                    serial: d.serial || '',
                    position: this._normalizePosition(d.position) || this._normalizePosition(prev.position),
                    lastInput: (typeof d.lastInput !== 'undefined' && d.lastInput !== null && String(d.lastInput)) || prev.lastInput || '',
                    connectedInput: (typeof d.connectedInput !== 'undefined' && d.connectedInput !== null && String(d.connectedInput)) || prev.connectedInput || '',
                    inputLabels: this._normalizeInputLabels(d.inputLabels) || this._normalizeInputLabels(prev.inputLabels),
                    usableInputs: Array.isArray(d.usableInputs) ? d.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v) : (Array.isArray(prev.usableInputs) ? prev.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v) : undefined),
                };
                merged.push(rec);
            }
            for (const record of existing) {
                if (!matchedExisting.has(record))
                    merged.push(record);
            }
            const sanitized = this._sanitizeMonitorRecords(merged);
            this._settings.set_strv('monitors', sanitized.map(r => JSON.stringify(r)));
        } catch (_e) {
            // Silently ignore if schema missing or not compiled
        }
    }

    _loadMonitorRecords() {
        return this._sanitizeMonitorRecords(this._loadMonitorRecordsRaw());
    }

    _hydrateFromRecords(displays) {
        const records = this._loadMonitorRecords();
        for (const d of displays) {
            const rec = this._findMatchingRecord(records, d);
            if (rec) {
                const position = this._normalizePosition(rec.position);
                d.position = position || undefined;
                const li = rec.lastInput;
                if (li)
                    d.lastInput = String(li).toLowerCase();
                const connectedInput = this._normalizeVcpCode(rec.connectedInput);
                if (connectedInput)
                    d.connectedInput = connectedInput;
                else
                    delete d.connectedInput;
                const inputLabels = this._normalizeInputLabels(rec.inputLabels);
                if (inputLabels)
                    d.inputLabels = inputLabels;
                else
                    delete d.inputLabels;
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
        let target = this._findMatchingRecord(recs, id);
        if (!target && typeof id === 'object' && typeof id.id === 'number') {
            target = {
                id: id.id,
                model: id.model || '',
                serial: id.serial || '',
                position: this._normalizePosition(id.position),
                lastInput: '',
                connectedInput: this._normalizeVcpCode(id.connectedInput),
                inputLabels: this._normalizeInputLabels(id.inputLabels),
                usableInputs: Array.isArray(id.usableInputs)
                    ? id.usableInputs.map(v => this._normalizeVcpCode(v)).filter(v => v)
                    : undefined,
            };
            recs.push(target);
        }
        if (!target)
            return;
        target.lastInput = norm;
        try {
            const sanitized = this._sanitizeMonitorRecords(recs, id);
            this._settings.set_strv('monitors', sanitized.map(r => JSON.stringify(r)));
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
