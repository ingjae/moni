// Moni — a robotics-aware system monitor for the GNOME top bar.
//
// Written as an ES module for GNOME 45+. tools/build.py rewrites it into
// the legacy imports.* form for GNOME 42-44 (Ubuntu 22.04).

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as C from './collectors.js';
import * as Cap from './capture.js';
import * as Clip from './clipboard.js';
import * as Up from './updater.js';
import * as Quick from './quick.js';

const HISTORY = 180;
const PANEL_GRAPH_H = 18;
const MENU_GRAPH = [340, 40];

// Apple system colors (dark variants).
const COLOR = {
    cpu: [0.04, 0.52, 1.00], // blue
    ram: [0.37, 0.36, 0.90], // indigo
    gpu: [0.19, 0.82, 0.35], // green
    rx: [0.04, 0.52, 1.00],
    tx: [1.00, 0.22, 0.37], // pink
    disk: [1.00, 0.62, 0.04], // orange
    ros: [0.39, 0.82, 1.00], // cyan
    can: [1.00, 0.62, 0.04],
    pm2: [0.40, 0.90, 0.89], // mint
    docker: [0.04, 0.52, 1.00],
    dev: [0.19, 0.82, 0.35],
    rec: [1.00, 0.27, 0.23], // red
};
// style = 'mono': grays only. The top bar is always dark, the menu may not be.
let monochrome = false;
const MONO_PANEL = [0.92, 0.92, 0.94];
const MONO_MENU = [0.55, 0.55, 0.58];

const css = ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
const pct = v => `${Math.round(v ?? 0)}%`;

function fmtBytes(b) {
    const u = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    b = b ?? 0;
    while (b >= 1024 && i < u.length - 1) {
        b /= 1024;
        i++;
    }
    return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)}${u[i]}`;
}

function fmtCount(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

function fmtDuration(s) {
    if (s < 3600)
        return `${Math.max(1, Math.round(s / 60))}m`;
    const h = Math.floor(s / 3600);
    return h >= 48 ? `${Math.floor(h / 24)}d` : `${h}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
}

const dockerTrouble = c => c.state === 'restarting' || c.state === 'dead' || c.health === 'unhealthy' || c.crashLoop;

// Most important first: transient robotics alerts survive a crowded panel.
const FIT_PRIORITY = ['shot', 'rec', 'ros', 'can', 'pm2', 'docker', 'cpu', 'ram', 'net', 'gpu', 'disk', 'ip'];

// '<Super><Shift>s' -> 'Super+Shift+S'
const fmtAccel = a => (a ?? '').replace(/<(\w+)>/g, '$1+').replace(/\+([a-z])$/, (_m, k) => `+${k.toUpperCase()}`);

const fmtClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const bar = (p, n = 12) => '█'.repeat(Math.round(p / 100 * n)).padEnd(n, '░');

class History {
    constructor() {
        this.values = [];
    }

    push(v) {
        this.values.push(v);
        if (this.values.length > HISTORY)
            this.values.shift();
    }
}

// Sparkline: one or more series, newest sample on the right, 2 px per sample.
// max === null auto-scales to the visible window (used for byte rates).
const Graph = GObject.registerClass(
class MoniGraph extends St.DrawingArea {
    _init(series, width, height, max, panel = false) {
        super._init({style_class: 'moni-graph', y_align: Clutter.ActorAlign.CENTER});
        this._panel = panel;
        this.set_style(`width: ${width}px; height: ${height}px;`);
        this._series = series;
        this._max = max;
        this.connect('repaint', () => this._paint());
    }

    _paint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const step = 2;
        const n = Math.ceil(w / step) + 1;
        let max = this._max;
        if (max === null) {
            max = 1024;
            for (const s of this._series) {
                for (const v of s.history.values.slice(-n))
                    max = Math.max(max, v);
            }
        }
        for (const s of this._series) {
            const vals = s.history.values.slice(-n);
            if (vals.length < 2)
                continue;
            const x0 = w - (vals.length - 1) * step;
            const y = v => h - Math.min(1, v / max) * (h - 1.5) - 0.75;
            const [r, g, b] = monochrome ? this._panel ? MONO_PANEL : MONO_MENU : s.color;
            cr.moveTo(x0, y(vals[0]));
            vals.forEach((v, i) => cr.lineTo(x0 + i * step, y(v)));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            if (s.fill) {
                cr.strokePreserve();
                cr.lineTo(w, h);
                cr.lineTo(x0, h);
                cr.closePath();
                cr.setSourceRGBA(r, g, b, 0.2);
                cr.fill();
            } else {
                cr.stroke();
            }
        }
        cr.$dispose();
    }
});

// Per-core load as a row of vertical bars.
const CoreBars = GObject.registerClass(
class MoniCoreBars extends St.DrawingArea {
    _init(width, height) {
        super._init({style_class: 'moni-graph'});
        this.set_style(`width: ${width}px; height: ${height}px;`);
        this.values = [];
        this.connect('repaint', () => this._paint());
    }

    _paint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const n = this.values.length;
        const bw = n ? w / n : w;
        this.values.forEach((v, i) => {
            const t = Math.min(1, v / 100);
            // blue → red as a core saturates; gray gets denser in mono
            const [a, b] = monochrome ? [MONO_MENU, MONO_MENU] : [COLOR.cpu, COLOR.rec];
            cr.setSourceRGBA(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
                monochrome ? 0.45 + 0.45 * t : 0.85);
            const bh = Math.max(1, t * (h - 2));
            cr.rectangle(i * bw + 0.5, h - 1 - bh, Math.max(1, bw - 1), bh);
            cr.fill();
        });
        cr.$dispose();
    }
});

function makeCard(title, color) {
    const box = new St.BoxLayout({vertical: true, style_class: 'moni-card', x_expand: true});
    const head = new St.BoxLayout({style_class: 'moni-card-head'});
    const dot = new St.Widget({
        style_class: 'moni-dot', style: `background-color: ${css(color)};`,
        y_align: Clutter.ActorAlign.CENTER, visible: !monochrome,
    });
    head.add_child(dot);
    const label = new St.Label({text: title, style_class: 'moni-card-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    head.add_child(label);
    const value = new St.Label({
        style_class: 'moni-card-value', x_expand: true,
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
    });
    head.add_child(value);
    box.add_child(head);
    const detail = new St.Label({style_class: 'moni-detail'});
    detail.opacity = 255;
    detail.clutter_text.line_wrap = true;
    detail.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
    detail.clutter_text.ellipsize = 0;
    return {box, label, value, detail, dot, add: w => box.add_child(w), finish: () => box.add_child(detail)};
}

const MoniIndicator = GObject.registerClass(
class MoniIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Moni', false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._state = {};
        this._h = {};
        for (const k of ['cpu', 'mem', 'gpu', 'rx', 'tx', 'rd', 'wr'])
            this._h[k] = new History();
        this._cpu = new C.CpuSampler();
        this._net = new C.NetSampler();
        this._io = new C.DiskIoSampler();
        this._gpu = new C.GpuSampler();
        this._ros = new C.RosRadar();
        this._can = new C.CanMonitor();
        this._pm2 = new C.Pm2Monitor();
        this._docker = new C.DockerMonitor();
        this._ticks = -1;
        this._ipKey = '';

        this._panel = new St.BoxLayout({style_class: 'moni-panel'});
        this.add_child(this._panel);
        this._buildPanel();
        this._buildMenu();

        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSetting(key));
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refreshMenu();
        });
        this._watchDevices();
        this._tick();
        this._startTimer();
        const queueFit = () => this._queueFit();
        this.connect('notify::width', queueFit);
        Main.panel.connectObject('notify::width', queueFit, this);
        Main.panel._centerBox.connectObject('notify::width', queueFit, this);
        Main.panel._rightBox.connectObject('notify::width', queueFit, this);
        Main.panel._leftBox.connectObject('notify::width', queueFit, this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', queueFit, this);
        this._queueFit();
    }

    // ── panel ──────────────────────────────────────────────────────────

    _buildPanel() {
        this._panel.destroy_all_children();
        const s = this._settings;
        this._applyStyle();
        const gw = s.get_int('graph-width');
        const showText = s.get_boolean('show-text');
        this._chips = {};
        const chip = (key, label, series = null, max = 100, cls = '') => {
            const box = new St.BoxLayout({style_class: `moni-chip ${cls}`, y_align: Clutter.ActorAlign.CENTER});
            const l = new St.Label({text: label, style_class: 'moni-chip-label', y_align: Clutter.ActorAlign.CENTER, visible: !!label});
            l.opacity = cls ? 255 : 150;
            l.clutter_text.ellipsize = 0; // never "…" the panel; Pango.EllipsizeMode.NONE
            box.add_child(l);
            const graph = series ? new Graph(series, gw, PANEL_GRAPH_H, max, true) : null;
            if (graph)
                box.add_child(graph);
            const value = new St.Label({style_class: 'moni-value', y_align: Clutter.ActorAlign.CENTER});
            value.clutter_text.ellipsize = 0;
            value.visible = showText || !graph;
            box.add_child(value);
            this._panel.add_child(box);
            this._chips[key] = {box, graph, value};
        };

        // Robotics badges appear only while there is something to report.
        chip('shot', '● REC', null, 100, 'moni-badge moni-alert');
        if (s.get_boolean('show-rosbag'))
            chip('rec', '● BAG', null, 100, 'moni-badge moni-badge-rec');
        if (s.get_boolean('show-ros'))
            chip('ros', 'ROS', null, 100, 'moni-badge moni-badge-ros');
        if (s.get_boolean('show-can'))
            chip('can', 'CAN', null, 100, 'moni-badge moni-badge-can');
        if (s.get_boolean('show-pm2'))
            chip('pm2', 'PM2', null, 100, 'moni-badge moni-badge-pm2');
        if (s.get_boolean('show-docker'))
            chip('docker', 'DOCKER', null, 100, 'moni-badge moni-badge-docker');
        if (s.get_boolean('show-cpu'))
            chip('cpu', 'CPU', [{history: this._h.cpu, color: COLOR.cpu, fill: true}]);
        if (s.get_boolean('show-ram'))
            chip('ram', 'RAM', [{history: this._h.mem, color: COLOR.ram, fill: true}]);
        if (s.get_boolean('show-gpu') && this._gpu.kind)
            chip('gpu', 'GPU', [{history: this._h.gpu, color: COLOR.gpu, fill: true}]);
        if (s.get_boolean('show-net')) {
            chip('net', 'NET', [
                {history: this._h.rx, color: COLOR.rx, fill: true},
                {history: this._h.tx, color: COLOR.tx, fill: false},
            ], null);
            // ↓/↑ stacked on two lines keeps the chip narrow.
            const net = this._chips.net;
            net.value.add_style_class_name('moni-value-net');
            net.value.clutter_text.line_alignment = 2; // Pango.Alignment.RIGHT
        }
        if (s.get_boolean('show-disk'))
            chip('disk', 'DISK');
        if (s.get_boolean('show-ip'))
            chip('ip', '');
        this._fallback = new St.Icon({icon_name: 'utilities-system-monitor-symbolic', icon_size: 16});
        this._panel.add_child(this._fallback);
        this._updatePanel();
    }

    _updatePanel() {
        this._fallback.visible = false;
        const st = this._state;
        const set = (key, text, visible = true) => {
            const c = this._chips[key];
            if (!c)
                return;
            c.fitHidden = false;
            c.box.visible = visible;
            if (!visible)
                return;
            if (c.value.text !== text) {
                c.value.text = text;
                // Repaint the whole chip: on some setups redrawing only the new
                // glyphs left digits of the old value on screen (#3).
                c.box.queue_redraw();
            }
            c.graph?.queue_repaint();
        };
        set('cpu', pct(st.cpu?.total));
        set('ram', pct(st.mem?.percent));
        set('gpu', st.gpu?.sleeping ? 'zZ' : pct(st.gpu?.util));
        set('net', `${fmtBytes(st.net?.rx)} ↓\n${fmtBytes(st.net?.tx)} ↑`);
        set('disk', pct(st.disk?.percent));
        set('ip', st.primaryIp ?? '', !!st.primaryIp);
        const rec = this._ext.capture.recording;
        set('shot', rec ? (rec.stopping ? 'Stopping…' : fmtClock((GLib.get_monotonic_time() - rec.start) / 1e6)) : '', !!rec);

        const nodes = (st.ros?.nodes ?? []).filter(n => n.role !== 'daemon');
        const domains = st.ros?.domains ?? [];
        set('ros', domains.length > 1 ? `${nodes.length} ⚠` : `${nodes.length}`, nodes.length > 0);
        this._chips.ros?.box[domains.length > 1 ? 'add_style_class_name' : 'remove_style_class_name']('moni-alert');

        const bags = [...(st.ros?.bags ?? [])].sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
        const bag = bags[0];
        set('rec', bag ? (bag.eta !== null ? fmtDuration(bag.eta) : `${fmtBytes(bag.rate)}/s`) : '', !!bag);
        this._chips.rec?.box[bag?.eta !== null && bag?.eta < 600 ? 'add_style_class_name' : 'remove_style_class_name']('moni-alert');

        // An idle bus stays in the menu; the badge means traffic or trouble.
        const cans = (st.can ?? []).filter(c => c.up);
        const fps = cans.reduce((a, c) => a + c.rxFps + c.txFps, 0);
        const canAlert = cans.some(c => c.state !== 'UP');
        set('can', canAlert ? 'BUS?' : fmtCount(fps), fps > 0 || canAlert);
        this._chips.can?.box[canAlert ? 'add_style_class_name' : 'remove_style_class_name']('moni-alert');

        // PM2: shown while the daemon runs; red on errored apps or a crash loop.
        const pm2 = st.pm2?.apps ?? [];
        const pm2Alert = pm2.some(a => a.status === 'errored' || a.crashLoop);
        set('pm2', `${pm2.filter(a => a.status === 'online').length}/${pm2.length}${pm2Alert ? ' ⚠' : ''}`, pm2.length > 0);
        this._chips.pm2?.box[pm2Alert ? 'add_style_class_name' : 'remove_style_class_name']('moni-alert');

        // Docker: running containers; red while one restarts or is unhealthy.
        const ctrs = st.docker ?? [];
        const up = ctrs.filter(c => c.state === 'running').length;
        const dockerAlert = ctrs.some(dockerTrouble);
        set('docker', `${up}${dockerAlert ? ' ⚠' : ''}`, up > 0 || dockerAlert);
        this._chips.docker?.box[dockerAlert ? 'add_style_class_name' : 'remove_style_class_name']('moni-alert');
        this._fitPanel();
        this._fallback.visible = !Object.values(this._chips).some(c => c.box.visible);
        const hiddenAlert = Object.values(this._chips).some(c => c.fitHidden && c.box.has_style_class_name('moni-alert'));
        this._fallback[hiddenAlert ? 'add_style_class_name' : 'remove_style_class_name']('moni-alert');
    }

    // Never draw over the clock: if the chips need more room than is left
    // between the clock and the rest of our panel box, drop the least
    // important ones. Everything hidden here is still in the dropdown.
    _queueFit() {
        if (this._fitLater)
            return;
        this._fitLaters = global.compositor.get_laters?.();
        const callback = () => {
            this._fitLater = 0;
            if (!this._destroyed)
                this._updatePanel();
            return GLib.SOURCE_REMOVE;
        };
        this._fitLater = this._fitLaters
            ? this._fitLaters.add(Meta.LaterType.BEFORE_REDRAW, callback)
            : Meta.later_add(Meta.LaterType.BEFORE_REDRAW, callback);
    }

    _fitPanel() {
        const box = this._settings.get_string('panel-position');
        const side = box === 'left' ? Main.panel._leftBox : box === 'right' ? Main.panel._rightBox : null;
        if (!side || !this.get_stage())
            return;
        const others = side.get_children()
            .filter(a => a.visible && a !== this.get_parent())
            .reduce((w, a) => w + a.get_preferred_width(-1)[1], 0);
        const overhead = this.get_preferred_width(-1)[1] - this._panel.get_preferred_width(-1)[1];
        const room = Main.panel.width / 2 - Main.panel._centerBox.get_preferred_width(-1)[1] / 2 -
            others - overhead - 12;
        const spacing = this._panel.get_theme_node().get_length('spacing');
        let used = 0;
        const priority = [...FIT_PRIORITY].sort((a, b) =>
            Number(this._chips[b]?.box.has_style_class_name('moni-alert') ?? false) -
            Number(this._chips[a]?.box.has_style_class_name('moni-alert') ?? false));
        for (const key of priority) {
            const c = this._chips[key];
            if (!c || !c.box.visible)
                continue;
            const w = c.box.get_preferred_width(-1)[1] + (used ? spacing : 0);
            c.fitHidden = used + w > room;
            c.box.visible = !c.fitHidden;
            if (!c.fitHidden)
                used += w;
        }
    }

    // ── menu ───────────────────────────────────────────────────────────

    _buildMenu() {
        // Capture actions first: they must stay reachable on short screens.
        const capture = (record, icon) => {
            const item = new PopupMenu.PopupImageMenuItem('', icon);
            item.add_child(this._accelLabel(record ? 'record-shortcut' : 'screenshot-shortcut'));
            // Let the menu fade out first so it is not in the capture.
            item.connect('activate', () => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._ext.capture[record ? 'toggleRecording' : 'screenshot']();
                return GLib.SOURCE_REMOVE;
            }));
            this.menu.addMenuItem(item);
            return item;
        };
        this._shotItem = capture(false, 'camera-photo-symbolic');
        this._shotItem.label.text = 'Screenshot';
        this._castItem = capture(true, 'media-record-symbolic');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // The dashboard scrolls when it is taller than the work area.
        const dash = new PopupMenu.PopupMenuSection();
        const scroll = this._dashScroll = new St.ScrollView({style_class: 'moni-scroll', overlay_scrollbars: true});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_child(dash.actor);
        // Keep the section registered with PopupMenu for focus, sensitivity
        // and destruction, while its content box stays inside the scroll view.
        dash.actor = scroll;
        scroll._delegate = dash;
        this.menu.addMenuItem(dash);

        const top = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const topBox = new St.BoxLayout({vertical: true, style_class: 'moni-dash', x_expand: true});
        top.add_child(topBox);
        dash.addMenuItem(top);

        this._ipSection = new PopupMenu.PopupMenuSection();
        dash.addMenuItem(this._ipSection);

        const bottom = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const bottomBox = new St.BoxLayout({vertical: true, style_class: 'moni-dash', x_expand: true});
        bottom.add_child(bottomBox);
        dash.addMenuItem(bottom);

        const cards = this._cards = {};
        const card = (parent, key, title, color, graphSeries = null, max = 100) => {
            const c = makeCard(title, color);
            if (graphSeries) {
                c.graph = new Graph(graphSeries, ...MENU_GRAPH, max);
                c.add(c.graph);
            }
            cards[key] = c;
            parent.add_child(c.box);
            return c;
        };

        const head = card(topBox, 'sys', '', [0.6, 0.6, 0.6]);
        head.label.add_style_class_name('moni-host');
        head.finish();

        const cpu = card(topBox, 'cpu', 'CPU', COLOR.cpu, [{history: this._h.cpu, color: COLOR.cpu, fill: true}]);
        cpu.bars = new CoreBars(MENU_GRAPH[0], 18);
        cpu.add(cpu.bars);
        cpu.finish();
        card(topBox, 'mem', 'Memory', COLOR.ram, [{history: this._h.mem, color: COLOR.ram, fill: true}]).finish();
        if (this._gpu.kind)
            card(topBox, 'gpu', 'GPU', COLOR.gpu, [{history: this._h.gpu, color: COLOR.gpu, fill: true}]).finish();
        card(topBox, 'net', 'Network', COLOR.rx, [
            {history: this._h.rx, color: COLOR.rx, fill: true},
            {history: this._h.tx, color: COLOR.tx, fill: false},
        ], null).finish();

        card(bottomBox, 'disk', 'Storage', COLOR.disk, [
            {history: this._h.rd, color: COLOR.disk, fill: true},
            {history: this._h.wr, color: COLOR.tx, fill: false},
        ], null).finish();
        card(bottomBox, 'bat', 'Battery', COLOR.gpu).finish();
        card(bottomBox, 'ros', 'ROS 2', COLOR.ros).finish();
        card(bottomBox, 'bag', 'rosbag', COLOR.rec).finish();
        card(bottomBox, 'can', 'CAN bus', COLOR.can).finish();
        card(bottomBox, 'pm2', 'PM2', COLOR.pm2).finish();
        card(bottomBox, 'docker', 'Docker', COLOR.docker).finish();
        card(bottomBox, 'dev', 'Sensors', COLOR.dev).finish();
        for (const k of ['ros', 'bag', 'can', 'pm2', 'docker', 'dev'])
            cards[k].detail.add_style_class_name('moni-mono');
        cards.disk.detail.add_style_class_name('moni-mono');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updateItem = new PopupMenu.PopupImageMenuItem('', 'software-update-available-symbolic');
        this._updateItem.connect('activate', () => {
            const u = this._ext.updater;
            if (u.installed)
                Up.restartShell();
            else
                u.install();
        });
        this.menu.addMenuItem(this._updateItem);
        this.onUpdateChanged();
        this.menu.addAction('Settings', () => openSettings(this._ext));
    }

    // Shown only while a release is waiting or needs a restart to apply.
    onUpdateChanged() {
        const u = this._ext.updater, item = this._updateItem;
        item.visible = !!u?.available;
        if (!u?.available)
            return;
        const wayland = Meta.is_wayland_compositor();
        item.label.text = !u.installed ? `Update to Moni ${u.available.version}`
            : wayland ? `Moni ${u.available.version}: log out to apply` : `Moni ${u.available.version}: restart to apply`;
        item.reactive = !(u.installed && wayland);
    }

    _accelLabel(key) {
        const label = new St.Label({
            text: fmtAccel(this._settings.get_strv(key)[0]), style_class: 'moni-accel',
            x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        });
        label.opacity = 150;
        return label;
    }

    _refreshMenu() {
        const st = this._state, c = this._cards;
        // Informational rows must retain the theme's normal text contrast.
        const fg = this.menu.actor.get_theme_node().get_foreground_color();
        for (const card of Object.values(c)) {
            for (const label of [card.label, card.value, card.detail])
                label.set_style(`color: rgb(${fg.red}, ${fg.green}, ${fg.blue});`);
        }
        const monitor = Main.layoutManager.findMonitorForActor(this);
        if (monitor) {
            const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            this._dashScroll.set_style(`max-height: ${Math.max(80, work.height - 200)}px;`);
        }
        this._castItem.label.text = this._ext.capture.recording?.stopping ? 'Stopping recording…'
            : this._ext.capture.recording ? 'Stop recording' : 'Record screen';
        this._castItem.setSensitive(!this._ext.capture.recording?.stopping);
        const show = (card, visible) => {
            card.box.visible = visible;
            return visible;
        };

        const sys = C.readSystem();
        c.sys.label.text = sys.host;
        c.sys.value.text = `up ${fmtDuration(sys.uptime)}`;
        c.sys.detail.text = `load ${sys.load.join(' ')} · kernel ${sys.kernel}`;

        const temp = C.readCpuTemp();
        c.cpu.value.text = pct(st.cpu?.total) + (temp !== null ? `  ·  ${Math.round(temp)}°C` : '');
        c.cpu.detail.text = `${st.cpu?.cores.length ?? '?'} threads`;
        c.cpu.bars.values = st.cpu?.cores ?? [];
        c.cpu.bars.queue_repaint();
        c.cpu.graph.queue_repaint();

        const m = st.mem;
        c.mem.value.text = m ? `${fmtBytes(m.used)} / ${fmtBytes(m.total)}` : '';
        c.mem.detail.text = m?.swapTotal ? `swap ${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}` : 'no swap';
        c.mem.graph.queue_repaint();

        if (c.gpu) {
            const g = st.gpu;
            c.gpu.label.text = g?.name || 'GPU';
            if (g?.sleeping) {
                c.gpu.value.text = 'zZ sleeping';
                c.gpu.detail.text = 'dGPU is runtime-suspended — not woken up to be measured';
            } else if (g) {
                c.gpu.value.text = pct(g.util) + (g.temp !== null && g.temp !== undefined ? `  ·  ${Math.round(g.temp)}°C` : '');
                const parts = [];
                if (g.memTotal)
                    parts.push(`VRAM ${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}`);
                if (g.power !== null && g.power !== undefined)
                    parts.push(`${g.power.toFixed(1)} W`);
                c.gpu.detail.text = parts.join(' · ');
            }
            c.gpu.graph.queue_repaint();
        }

        c.net.value.text = `↓ ${fmtBytes(st.net?.rx)}/s   ↑ ${fmtBytes(st.net?.tx)}/s`;
        const seconds = Math.min(HISTORY - 1, Math.floor((c.cpu.graph.width || MENU_GRAPH[0]) / 2)) * (this._interval ?? 1500) / 1000;
        const windowLabel = `last ${Math.round(seconds)} s`;
        c.cpu.detail.text += ` · ${windowLabel}`;
        c.mem.detail.text += ` · ${windowLabel}`;
        const netParts = [`↓ RX / ↑ TX · ${windowLabel}`];
        if (this._settings.get_boolean('internet-probe')) {
            netParts.push(st.online === undefined ? 'Probe …'
                : st.online ? `Probe ● ${Math.round(st.latency)} ms` : 'Probe host unreachable');
        }
        if (st.wifi)
            netParts.push(`Wi-Fi ${st.wifi.iface} ${Math.round(st.wifi.dbm)} dBm`);
        netParts.push('click an address to copy');
        c.net.detail.text = netParts.join('\n');
        c.net.graph.queue_repaint();

        const mounts = C.listMounts();
        c.disk.value.text = `R ${fmtBytes(st.io?.read)}/s   W ${fmtBytes(st.io?.write)}/s`;
        c.disk.detail.text = `R read / W write · ${windowLabel}\n` + mounts.map(x =>
            `${x.mount.length > 12 ? `…${x.mount.slice(-11)}` : x.mount.padEnd(12)} ${bar(x.percent)} ${pct(x.percent).padStart(4)}  ${fmtBytes(x.free)} free`).join('\n');
        c.disk.graph.queue_repaint();

        const b = C.readBattery();
        if (show(c.bat, !!b)) {
            c.bat.value.text = `${b.percent}%`;
            c.bat.detail.text = `${b.status}${b.watts ? ` · ${b.watts.toFixed(1)} W` : ''}`;
        }

        this._refreshRobotics();
    }

    _refreshRobotics() {
        const st = this._state, c = this._cards, s = this._settings;
        const ros = st.ros;
        const nodes = (ros?.nodes ?? []).filter(n => n.role !== 'daemon');
        if (c.ros.box.visible = s.get_boolean('show-ros') && nodes.length > 0) {
            const cpu = nodes.reduce((a, n) => a + n.cpu, 0);
            const rss = nodes.reduce((a, n) => a + n.rss, 0);
            c.ros.value.text = `${nodes.length} procs · ${cpu.toFixed(0)}% · ${fmtBytes(rss)}`;
            const meta = [
                ros.domains.length > 1 ? `⚠ domains ${ros.domains.join(', ')}` : `domain ${ros.domains[0]}`,
                ros.distro, ros.rmw ?? 'default rmw',
            ].filter(Boolean).join(' · ');
            const rows = nodes.slice(0, 12).map(n => {
                const name = n.pkg && n.pkg !== n.name ? `${n.name} (${n.pkg})` : n.name;
                const tag = n.role === 'node' ? '' : `[${n.role}] `;
                const label = `${tag}${name}`;
                return `${(label.length > 30 ? `${label.slice(0, 29)}…` : label).padEnd(30)} ${`${n.cpu.toFixed(1)}%`.padStart(6)} ${fmtBytes(n.rss).padStart(6)}${ros.domains.length > 1 ? `  d${n.domain}` : ''}`;
            });
            if (nodes.length > 12)
                rows.push(`… ${nodes.length - 12} more`);
            c.ros.detail.text = [meta, `${'PROCESS'.padEnd(30)} ${'CPU'.padStart(6)} ${'MEM'.padStart(6)}`, ...rows].join('\n');
        }

        const bags = ros?.bags ?? [];
        if (c.bag.box.visible = s.get_boolean('show-rosbag') && bags.length > 0) {
            c.bag.value.text = `${bags.length} recording${bags.length === 1 ? '' : 's'}`;
            c.bag.detail.text = bags.map(bag => [
                bag.dir || 'waiting for output directory…',
                `${fmtBytes(bag.rate)}/s · written ${fmtBytes(bag.written)} · ${bag.free != null ? `${fmtBytes(bag.free)} free` : 'free space unknown'}`,
                bag.eta != null ? `disk full in ${fmtDuration(bag.eta)}${bag.eta < 600 ? '  ⚠' : ''}` : 'idle / low rate',
            ].join('\n')).join('\n\n');
        }

        const cans = st.can ?? [];
        if (c.can.box.visible = s.get_boolean('show-can') && cans.length > 0) {
            c.can.value.text = `${cans.filter(x => x.up).length}/${cans.length} up`;
            c.can.detail.text = cans.map(x =>
                `${x.name.padEnd(7)} ${x.state.padEnd(10)} ▼${fmtCount(x.rxFps).padStart(5)}/s ▲${fmtCount(x.txFps).padStart(5)}/s  err ${x.errors}${x.virtual ? '  (virtual)' : ''}`).join('\n');
        }

        const pm2 = st.pm2?.apps ?? [];
        if (c.pm2.box.visible = s.get_boolean('show-pm2') && pm2.length > 0) {
            const on = pm2.filter(a => a.status === 'online');
            c.pm2.value.text = `${on.length}/${pm2.length} online · ${on.reduce((t, a) => t + a.cpu, 0).toFixed(0)}% · ${fmtBytes(on.reduce((t, a) => t + a.rss, 0))}`;
            // Same width budget as the ROS table (~46 mono chars).
            const rows = pm2.slice(0, 12).map(a => {
                const name = `${a.name}:${a.id}`;
                const status = a.crashLoop && a.status === 'online' ? 'looping' : a.status;
                const on = a.status === 'online';
                const tail = on ? fmtDuration(a.uptime)
                    : a.lastExit && a.lastExit.code !== 0 ? `exit ${a.lastExit.code ?? a.lastExit.signal}` : '';
                return `${(name.length > 16 ? `${name.slice(0, 15)}…` : name).padEnd(16)} ${status.padEnd(7)} ` +
                    `${(on ? `${a.cpu.toFixed(1)}%` : '').padStart(5)} ${(on ? fmtBytes(a.rss) : '').padStart(5)} ` +
                    `${String(a.restarts).padStart(3)} ${tail}`;
            });
            if (pm2.length > 12)
                rows.push(`… ${pm2.length - 12} more`);
            c.pm2.detail.text = [`${'APP'.padEnd(16)} ${'STATUS'.padEnd(7)} ${'CPU'.padStart(5)} ${'MEM'.padStart(5)} ${'↺'.padStart(3)} UP`, ...rows].join('\n');
        }

        const ctrs = st.docker ?? [];
        if (c.docker.box.visible = s.get_boolean('show-docker') && ctrs.length > 0) {
            const run = ctrs.filter(x => x.state === 'running');
            c.docker.value.text = `${run.length}/${ctrs.length} running · ${run.reduce((t, x) => t + x.cpu, 0).toFixed(0)}% · ${fmtBytes(run.reduce((t, x) => t + x.mem, 0))}`;
            const rows = ctrs.slice(0, 12).map(x => {
                const on = x.state === 'running';
                const status = `${C.compactDockerStatus(x.status)}${x.restarts ? ` ↺${x.restarts}` : ''}`;
                return `${(x.name.length > 16 ? `${x.name.slice(0, 15)}…` : x.name).padEnd(16)} ` +
                    `${(on ? `${x.cpu.toFixed(1)}%` : '').padStart(5)} ${(on ? fmtBytes(x.mem) : '').padStart(5)} ` +
                    `${status}${dockerTrouble(x) ? ' ⚠' : ''}`;
            });
            if (ctrs.length > 12)
                rows.push(`… ${ctrs.length - 12} more`);
            c.docker.detail.text = [`${'CONTAINER'.padEnd(16)} ${'CPU'.padStart(5)} ${'MEM'.padStart(5)} STATUS`, ...rows].join('\n');
        }

        const devs = this._devices ?? [];
        if (c.dev.box.visible = s.get_boolean('show-devices') && devs.length > 0) {
            c.dev.value.text = `${devs.length} connected`;
            c.dev.detail.text = devs.map(d => `${d.dev.padEnd(10)} ${d.label}`).join('\n');
        }
    }

    _rebuildIpItems() {
        const addrs = this._state.addrs ?? [];
        const key = JSON.stringify([addrs, this._state.defaultIface]);
        if (key === this._ipKey)
            return;
        this._ipKey = key;
        this._ipSection.removeAll();
        for (const a of addrs) {
            const item = new PopupMenu.PopupMenuItem(a.iface + (a.iface === this._state.defaultIface ? '  ★' : ''));
            item.label.add_style_class_name('moni-ip-iface');
            item.add_child(new St.Label({
                text: a.address, style_class: 'moni-mono', x_expand: true,
                x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
            }));
            item.add_child(new St.Icon({icon_name: 'edit-copy-symbolic', style_class: 'popup-menu-icon'}));
            item.connect('activate', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, a.address);
                Main.notify('Moni', `Copied ${a.address} (${a.iface})`);
            });
            this._ipSection.addMenuItem(item);
        }
    }

    // ── sampling ───────────────────────────────────────────────────────

    _startTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._interval = Math.max(500, this._settings.get_int('update-interval'));
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _tick() {
        try {
            this._sample();
            this._updatePanel();
            if (this.menu.isOpen)
                this._refreshMenu();
        } catch (e) {
            logError(e, 'moni');
        }
    }

    _sample() {
        const st = this._state, s = this._settings;
        this._ticks++;
        const every = ms => this._ticks % Math.max(1, Math.round(ms / (this._interval ?? 1500))) === 0;

        const cpu = this._cpu.sample();
        if (cpu) {
            st.cpu = cpu;
            this._h.cpu.push(cpu.total);
        }
        st.mem = C.readMemory();
        this._h.mem.push(st.mem?.percent ?? 0);
        st.net = this._net.sample();
        this._h.rx.push(st.net.rx);
        this._h.tx.push(st.net.tx);
        st.io = this._io.sample();
        this._h.rd.push(st.io.read);
        this._h.wr.push(st.io.write);
        if (every(10000))
            st.disk = C.fsUsage('/');

        if (this._gpu.kind && (s.get_boolean('show-gpu') || this.menu.isOpen)) {
            this._gpu.poll(this._cancellable, info => {
                if (this._destroyed)
                    return;
                st.gpu = info;
                this._h.gpu.push(info && !info.sleeping ? info.util : 0);
            });
        }
        if ((s.get_boolean('show-ros') || s.get_boolean('show-rosbag')) && every(3000))
            st.ros = this._ros.scan();
        if (s.get_boolean('show-can'))
            st.can = this._can.sample();
        if (s.get_boolean('show-pm2') && every(3000)) {
            const prev = st.pm2;
            st.pm2 = this._pm2.scan();
            this._notifyPm2(prev, st.pm2);
        } else if (!s.get_boolean('show-pm2')) {
            st.pm2 = null;
        }
        if (s.get_boolean('show-docker') && every(3000)) {
            this._docker.poll(this._cancellable, list => {
                if (this._destroyed || !this._settings.get_boolean('show-docker'))
                    return;
                const prev = st.docker;
                st.docker = list;
                this._notifyDocker(prev, list);
                this._updatePanel();
            });
        } else if (!s.get_boolean('show-docker')) {
            st.docker = null;
        }
        if (every(10000))
            this._refreshNetwork();
    }

    // A container that died with a non-zero code, started restarting or went
    // unhealthy. Once per container per minute, none for the first poll.
    _notifyDocker(prev, cur) {
        if (!prev || !cur || !this._settings.get_boolean('notify-docker'))
            return;
        const before = new Map(prev.map(x => [x.id, x]));
        const now = GLib.get_monotonic_time() / 1e6;
        this._dockerNotified ??= new Map();
        for (const x of cur) {
            const b = before.get(x.id);
            if (!b || now - (this._dockerNotified.get(x.id) ?? 0) < 60)
                continue;
            let body = null;
            if (x.restarts > b.restarts || (x.state === 'restarting' && b.state !== 'restarting'))
                body = x.restarts ? `restarted (${x.restarts}× since login)` : 'restarting';
            else if (x.state === 'exited' && b.state !== 'exited' && x.exitCode !== 0)
                body = `exited with code ${x.exitCode}`;
            else if (x.health === 'unhealthy' && b.health !== 'unhealthy')
                body = 'health check failing';
            if (!body)
                continue;
            this._dockerNotified.set(x.id, now);
            Main.notify(`Docker: ${x.name}`, `${body} · ${x.image}`);
        }
    }

    // A crash (non-zero exit → restart) or an app giving up ("errored").
    // At most one notification per app per minute, none for the first scan.
    _notifyPm2(prev, cur) {
        if (!prev || !cur || !this._settings.get_boolean('notify-pm2'))
            return;
        const before = new Map(prev.apps.map(a => [`${a.name}:${a.id}`, a]));
        const now = GLib.get_monotonic_time() / 1e6;
        this._pm2Notified ??= new Map();
        for (const a of cur.apps) {
            const b = before.get(`${a.name}:${a.id}`);
            if (!b)
                continue;
            const errored = a.status === 'errored' && b.status !== 'errored';
            const crashed = a.restarts > b.restarts && a.lastExit?.code !== 0;
            const key = `${a.name}:${a.id}`;
            if ((!errored && !crashed) || (!errored && now - (this._pm2Notified.get(key) ?? 0) < 60))
                continue;
            this._pm2Notified.set(key, now);
            Main.notify(errored ? `PM2: ${a.name} errored` : `PM2: ${a.name} crashed`,
                errored ? `Stopped after ${a.restarts} restarts (exit ${a.lastExit?.code ?? '?'})`
                    : `exit ${a.lastExit?.code ?? a.lastExit?.signal} · restarted (${a.restarts} so far)`);
        }
    }

    _refreshNetwork() {
        const st = this._state;
        st.defaultIface = C.defaultRouteIface();
        st.wifi = C.readWifi();
        C.queryAddresses(this._cancellable, addrs => {
            if (this._destroyed || !addrs)
                return;
            st.addrs = addrs.filter(a => a.family === 4 && !/^(docker|br-|veth|virbr)/.test(a.iface));
            st.primaryIp = (st.addrs.find(a => a.iface === st.defaultIface) ?? st.addrs[0])?.address ?? null;
            this._rebuildIpItems();
            this._updatePanel();
        });
        if (this._settings.get_boolean('internet-probe')) {
            C.probeLatency(this._settings.get_string('probe-host'), 443, this._cancellable, ms => {
                if (this._destroyed)
                    return;
                st.latency = ms;
                st.online = ms !== null;
            });
        }
    }

    // /dev is watched with inotify: zero cost until something is plugged.
    _watchDevices() {
        this._devices = C.listSensorDevices();
        this._monitors = [];
        for (const path of ['/dev', '/dev/input']) {
            try {
                const m = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, null);
                m.connect('changed', () => this._scheduleDeviceScan());
                this._monitors.push(m);
            } catch (e) {
                logError(e, `moni: cannot watch ${path}`);
            }
        }
    }

    _scheduleDeviceScan() {
        if (this._devTimer)
            return;
        // udev creates /dev/serial/by-id links slightly after the node itself.
        this._devTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._devTimer = 0;
            const before = new Map(this._devices.map(d => [d.dev, d]));
            this._devices = C.listSensorDevices();
            const after = new Map(this._devices.map(d => [d.dev, d]));
            if (this._settings.get_boolean('show-devices') && this._settings.get_boolean('notify-devices')) {
                for (const [dev, d] of after) {
                    if (!before.has(dev))
                        Main.notify(`Connected  /dev/${dev}`, d.label);
                }
                for (const [dev, d] of before) {
                    if (!after.has(dev))
                        Main.notify(`Disconnected  /dev/${dev}`, d.label);
                }
            }
            if (this.menu.isOpen)
                this._refreshRobotics();
            return GLib.SOURCE_REMOVE;
        });
    }

    onRecordingChanged() {
        if (this._recTimer) {
            GLib.source_remove(this._recTimer);
            this._recTimer = 0;
        }
        if (this._ext.capture.recording) {
            this._recTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._updatePanel();
                return GLib.SOURCE_CONTINUE;
            });
        }
        this._updatePanel();
        if (this.menu.isOpen)
            this._refreshMenu();
    }

    _applyStyle() {
        monochrome = this._settings.get_string('style') === 'mono';
        for (const actor of [this._panel, this.menu.box])
            actor[monochrome ? 'add_style_class_name' : 'remove_style_class_name']('moni-style-mono');
        for (const c of Object.values(this._cards ?? {}))
            c.dot.visible = !monochrome;
    }

    _onSetting(key) {
        if (key === 'update-interval')
            this._startTimer();
        else if (key !== 'panel-position')
            this._buildPanel();
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._fitLater) {
            if (this._fitLaters)
                this._fitLaters.remove(this._fitLater);
            else
                Meta.later_remove(this._fitLater);
        }
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._devTimer)
            GLib.source_remove(this._devTimer);
        if (this._recTimer)
            GLib.source_remove(this._recTimer);
        this._monitors.forEach(m => m.cancel());
        this._settings.disconnect(this._settingsId);
        super.destroy();
    }
});

// GNOME refuses to open Settings while its window exists, even when that
// window is hidden behind others; bring the open one to the front instead.
function openSettings(ext) {
    const raise = () => global.get_window_actors().map(a => a.meta_window)
        .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions' && w.get_title() === ext.metadata.name)
        ?.activate(global.get_current_time());
    try {
        ext.openPreferences()?.catch?.(raise);
    } catch (e) {
        raise();
    }
}

const SHORTCUTS = {'screenshot-shortcut': false, 'record-shortcut': true};

export default class MoniExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.capture = new Cap.Capture(this.path, this._settings, () => this._indicator?.onRecordingChanged());
        this.updater = new Up.Updater(this.path, this.metadata, this._settings, () => this._indicator?.onUpdateChanged());
        for (const [key, record] of Object.entries(SHORTCUTS)) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this.capture[record ? 'toggleRecording' : 'screenshot']());
        }
        this._posId = this._settings.connect('changed::panel-position', () => {
            this._removeIndicator();
            this._addIndicator();
        });
        this._addIndicator();
        this._clipId = this._settings.connect('changed::show-clipboard', () => this._syncClipboard());
        this._syncClipboard();
        this._quickIds = ['changed::show-quick', 'changed::quick-items'].map(sig =>
            this._settings.connect(sig, () => this._syncQuick()));
        this._syncQuick();
    }

    // Quick copy buttons: on when enabled and at least one item is set.
    // Their copies stay out of the clipboard history (tokens, passwords).
    _syncQuick() {
        const on = this._settings.get_boolean('show-quick') && Quick.readItems(this._settings).length > 0;
        if (on && !this._quick) {
            this._quick = new Quick.QuickIndicator(this._settings, text => this._clip?.ignore(text));
            Quick.addToPanel(this.uuid, this._quick);
        } else if (!on && this._quick) {
            this._quick.destroy();
            this._quick = null;
        }
    }

    // Clipboard history is its own panel icon + shortcut, on only when enabled.
    _syncClipboard() {
        const on = this._settings.get_boolean('show-clipboard');
        if (on && !this._clip) {
            this._clip = new Clip.ClipboardIndicator(this._settings);
            Clip.addToPanel(this.uuid, this._clip);
            Main.wm.addKeybinding('clipboard-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._clip?.toggle());
        } else if (!on && this._clip) {
            Main.wm.removeKeybinding('clipboard-shortcut');
            this._clip.destroy();
            this._clip = null;
        }
    }

    disable() {
        for (const key of Object.keys(SHORTCUTS))
            Main.wm.removeKeybinding(key);
        this._settings.disconnect(this._posId);
        this._settings.disconnect(this._clipId);
        this._quickIds.forEach(id => this._settings.disconnect(id));
        this._quick?.destroy();
        this._quick = null;
        if (this._clip) {
            Main.wm.removeKeybinding('clipboard-shortcut');
            this._clip.destroy();
            this._clip = null;
        }
        this._removeIndicator();
        this.capture.destroy();
        this.capture = null;
        this.updater.destroy();
        this.updater = null;
        this._settings = null;
    }

    _addIndicator() {
        const box = this._settings.get_string('panel-position');
        this._indicator = new MoniIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, box === 'right' ? 0 : -1, box);
    }

    _removeIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
