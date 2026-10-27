// editor.js — Moni Shot, a Shottr-style screenshot editor.
//
//   gjs -m editor.js <capture.png> [--ocr]
//
// GTK 4.6 / libadwaita 1.1 APIs only, so it runs on Ubuntu 22.04 too.
// Anything that must outlive this window (clipboard, pinned images) is
// handed back to the Shell extension on stdout, one command per line:
//   COPY <png>   TEXT <string>   TEXTJ <json string>   PIN <png>   SAVED <png>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import System from 'system';

import {run, recognize} from './helper.js';

const GROUPS = [
    [{id: 'move', key: 'v', name: 'Select and move'}],
    [
        {id: 'arrow', key: 'a', name: 'Arrow'},
        {id: 'line', key: 'l', name: 'Line'},
        {id: 'rect', key: 'r', name: 'Rectangle'},
        {id: 'oval', key: 'o', name: 'Oval'},
        {id: 'pen', key: 'p', name: 'Pen'},
        {id: 'highlight', key: 'h', name: 'Highlighter'},
        {id: 'text', key: 't', name: 'Text'},
        {id: 'step', key: 'n', name: 'Numbered step'},
    ],
    [
        {id: 'pixelate', key: 'b', name: 'Pixelate'},
        {id: 'blur', key: 'g', name: 'Blur'},
        {id: 'erase', key: 'e', name: 'Smart erase'},
        {id: 'spotlight', key: 's', name: 'Spotlight'},
    ],
    [
        {id: 'ruler', key: 'm', name: 'Ruler'},
        {id: 'picker', key: 'i', name: 'Color picker'},
        {id: 'crop', key: 'c', name: 'Crop'},
    ],
];
const TOOLS = GROUPS.flat();
const CLICK_TOOLS = new Set(['text', 'step', 'picker']);
const LINES = new Set(['arrow', 'line', 'ruler']);
const BOXES = new Set(['rect', 'oval', 'highlight', 'pixelate', 'blur', 'erase', 'spotlight']);
const REDACT = new Set(['pixelate', 'blur', 'erase']);
const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#000000'];
const WIDTHS = [0.6, 1, 1.7];
const BACKDROPS = [
    ['#5ac8fa', '#007aff'], ['#a18cd1', '#fbc2eb'], ['#ff9a9e', '#fecfef'], ['#f6d365', '#fda085'],
    ['#43e97b', '#38f9d7'], ['#30cfd0', '#330867'], ['#e6e9f0', '#c3cfe2'], ['#232526', '#414345'],
];
const ACCENT = [0x0a / 255, 0x84 / 255, 1];

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const isLight = ([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11 > 0.6;
const stamp = () => GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
const send = (cmd, arg) => print(`${cmd} ${arg}`);

// Distance from point p to segment ab, in image pixels.
function segDist([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function box(it) {
    const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
    return {x, y, w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1)};
}

// ── icons ──────────────────────────────────────────────────────────────
// Drawn with Cairo on an 18 px grid, so they look the same on every icon
// theme and follow the button's text color (light, dark, checked).

function drawIcon(cr, id, [r, g, b, a]) {
    const ink = (alpha = 1) => cr.setSourceRGBA(r, g, b, a * alpha);
    ink();
    cr.setLineWidth(1.6);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    const path = pts => {
        cr.moveTo(...pts[0]);
        pts.slice(1).forEach(p => cr.lineTo(...p));
    };
    switch (id) {
    case 'move':
        path([[5, 2.5], [5, 15], [8.3, 11.8], [10.6, 16.2], [12.6, 15.2], [10.3, 10.9], [14.8, 10.7]]);
        cr.closePath();
        cr.stroke();
        break;
    case 'arrow':
        path([[3.5, 14.5], [14, 4]]);
        path([[8, 4], [14, 4], [14, 10]]);
        cr.stroke();
        break;
    case 'line':
        path([[3.5, 14.5], [14.5, 3.5]]);
        cr.stroke();
        break;
    case 'rect':
        roundedRect(cr, 2.5, 4, 13, 10, 2);
        cr.stroke();
        break;
    case 'oval':
        cr.save();
        cr.translate(9, 9);
        cr.scale(6.8, 5.3);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.stroke();
        break;
    case 'pen':
        cr.moveTo(2.5, 13);
        cr.curveTo(5, 4, 8, 16, 10.5, 8.5);
        cr.curveTo(12, 4.5, 14, 8, 15.5, 5.5);
        cr.stroke();
        break;
    case 'highlight':
        ink(0.4);
        cr.rectangle(2.5, 6, 13, 6.5);
        cr.fill();
        ink();
        path([[5, 9.25], [13, 9.25]]);
        cr.stroke();
        break;
    case 'text':
        path([[4, 4], [14, 4]]);
        path([[9, 4], [9, 15]]);
        cr.stroke();
        break;
    case 'step':
        cr.arc(9, 9, 6.6, 0, 2 * Math.PI);
        cr.stroke();
        path([[7.6, 7], [9.3, 5.8], [9.3, 12.4]]);
        cr.stroke();
        break;
    case 'pixelate':
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                ink((i + j) % 2 ? 0.35 : 1);
                cr.rectangle(3 + i * 4, 3 + j * 4, 4, 4);
                cr.fill();
            }
        }
        break;
    case 'blur':
        [[6.6, 0.25], [4.6, 0.5], [2.6, 1]].forEach(([rad, al]) => {
            ink(al);
            cr.arc(9, 9, rad, 0, 2 * Math.PI);
            cr.fill();
        });
        break;
    case 'erase':
        path([[3.5, 11.5], [9.5, 5.5], [14, 10], [9.5, 14.5], [6.5, 14.5]]);
        cr.closePath();
        cr.stroke();
        path([[6.5, 8.5], [11, 13]]);
        cr.stroke();
        break;
    case 'spotlight':
        ink(0.35);
        cr.rectangle(2, 2, 14, 14);
        cr.arc(9, 9, 4.2, 0, 2 * Math.PI);
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.fill();
        ink();
        cr.arc(9, 9, 4.2, 0, 2 * Math.PI);
        cr.stroke();
        break;
    case 'ruler':
        roundedRect(cr, 2, 6, 14, 6, 1);
        cr.stroke();
        [5, 7.5, 10, 12.5].forEach((x, i) => path([[x, 6], [x, i % 2 ? 8 : 9]]));
        cr.stroke();
        break;
    case 'picker':
        path([[3.5, 14.5], [10, 8]]);
        cr.stroke();
        cr.arc(12.2, 5.8, 2.7, 0, 2 * Math.PI);
        cr.fill();
        break;
    case 'crop':
        path([[5, 2], [5, 13], [16, 13]]);
        path([[2, 5], [13, 5], [13, 16]]);
        cr.stroke();
        break;
    case 'fill':
        roundedRect(cr, 3, 3, 12, 12, 2.5);
        cr.stroke();
        roundedRect(cr, 5.5, 5.5, 7, 7, 1.2);
        cr.fill();
        break;
    case 'w0': case 'w1': case 'w2':
        cr.arc(9, 9, [1.6, 2.8, 4.2][Number(id[1])], 0, 2 * Math.PI);
        cr.fill();
        break;
    case 'ocr':
        path([[2.5, 6], [2.5, 2.5], [6, 2.5]]);
        path([[12, 2.5], [15.5, 2.5], [15.5, 6]]);
        path([[15.5, 12], [15.5, 15.5], [12, 15.5]]);
        path([[6, 15.5], [2.5, 15.5], [2.5, 12]]);
        path([[6, 6.5], [12, 6.5]]);
        path([[9, 6.5], [9, 12]]);
        cr.stroke();
        break;
    case 'backdrop':
        roundedRect(cr, 2, 2, 14, 14, 3);
        cr.stroke();
        ink(0.45);
        roundedRect(cr, 5, 5, 8, 8, 1.5);
        cr.fill();
        break;
    case 'pin':
        cr.arc(9, 6.5, 3.8, 0, 2 * Math.PI);
        cr.stroke();
        path([[9, 10.3], [9, 16]]);
        cr.stroke();
        break;
    case 'save':
        path([[9, 2.5], [9, 11]]);
        path([[5.5, 7.8], [9, 11.3], [12.5, 7.8]]);
        path([[3, 12], [3, 15.5], [15, 15.5], [15, 12]]);
        cr.stroke();
        break;
    }
}

function icon(id) {
    const da = new Gtk.DrawingArea({content_width: 18, content_height: 18, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER});
    da.set_draw_func((w, cr, width, height) => {
        const c = w.get_color?.() ?? w.get_style_context().get_color();
        cr.translate(Math.round((width - 18) / 2), Math.round((height - 18) / 2));
        drawIcon(cr, id, [c.red, c.green, c.blue, c.alpha]);
    });
    return da;
}

const CSS = `
@define-color accent_bg_color #0a84ff;
@define-color accent_color #0a84ff;
@define-color accent_fg_color #ffffff;
.moni-canvas { background-color: mix(@window_bg_color, @window_fg_color, 0.07); }
.moni-tools { margin: 0 6px; }
.moni-tool { min-width: 30px; min-height: 28px; padding: 0; border-radius: 7px; }
.moni-tool:checked { background-color: @accent_bg_color; color: @accent_fg_color; }
.moni-sep { margin: 8px 5px; min-width: 1px; background-color: alpha(@window_fg_color, 0.15); }
.moni-bar { padding: 6px 10px; border-top: 1px solid alpha(@window_fg_color, 0.1); background-color: @window_bg_color; }
.moni-swatch { min-width: 18px; min-height: 18px; padding: 0; margin: 0 1px; border-radius: 9px;
    box-shadow: inset 0 0 0 1px alpha(black, 0.18); }
.moni-swatch:checked { box-shadow: inset 0 0 0 2px @window_bg_color, 0 0 0 2px @accent_bg_color; }
.moni-status { font-family: monospace; font-size: 11px; opacity: 0.6; }
.moni-qr { padding: 6px 12px; background-color: alpha(@accent_bg_color, 0.15); }
.moni-grad { min-width: 28px; min-height: 28px; padding: 0; border-radius: 8px; }
${COLORS.map((c, i) => `.moni-c${i} { background: ${c}; }`).join('\n')}
${BACKDROPS.map(([a, b], i) => `.moni-g${i} { background: linear-gradient(135deg, ${a}, ${b}); }`).join('\n')}
`;

function loadCss() {
    const provider = new Gtk.CssProvider();
    try {
        provider.load_from_data(CSS, -1);                       // GTK >= 4.12
    } catch (e) {
        provider.load_from_data(new TextEncoder().encode(CSS)); // GTK 4.6
    }
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

class Editor {
    constructor(app, path, ocr = false) {
        this.path = path;
        this.ocrEnabled = ocr;
        this.pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        this.W = this.pixbuf.get_width();
        this.H = this.pixbuf.get_height();
        this.pixels = this.pixbuf.get_pixels();
        this.stride = this.pixbuf.get_rowstride();
        this.channels = this.pixbuf.get_n_channels();
        this.base = Math.max(3, Math.round(Math.max(this.W, this.H) / 350));
        this.items = [];
        this.crop = null;
        this.history = [];
        this.redoStack = [];
        this.draft = null;
        this.drag = null;
        this.sel = -1;
        this.tool = 'arrow';
        this.prevTool = 'arrow';
        this.color = COLORS[0];
        this.width = 1;
        this.fill = false;
        this.backdrop = -1;
        this.zoom = 1;
        this.pan = [0, 0];
        this.pointer = [0, 0];
        this.spaceDown = false;
        this.view = {s: 1, tx: 0, ty: 0};
        this._buildUi(app);
        this._wireInput();
        this.toolButtons.arrow.active = true;
        this.swatches[0].active = true;
        this.widthButtons[1].active = true;
        this.updateTitle();
        this.win.present();
        this.scanQr();
    }

    _buildUi(app) {
        this.win = new Adw.ApplicationWindow({application: app, title: 'Moni Shot'});
        const sf = this.win.get_scale_factor?.() ?? 1;
        this.win.set_default_size(
            Math.max(820, Math.min(1500, Math.round(this.W / sf) + 80)),
            Math.max(480, Math.min(960, Math.round(this.H / sf) + 170)));

        const flat = (child, tip, fn) => {
            const b = new Gtk.Button({child, tooltip_text: tip, valign: Gtk.Align.CENTER});
            b.add_css_class('flat');
            b.connect('clicked', fn);
            return b;
        };

        const header = new Adw.HeaderBar();
        this.undoButton = flat(new Gtk.Image({icon_name: 'edit-undo-symbolic'}), 'Undo (Ctrl+Z)', () => this.undo());
        this.redoButton = flat(new Gtk.Image({icon_name: 'edit-redo-symbolic'}), 'Redo (Ctrl+Shift+Z)', () => this.redo());
        header.pack_start(this.undoButton);
        header.pack_start(this.redoButton);

        const tools = new Gtk.Box({spacing: 2, valign: Gtk.Align.CENTER});
        tools.add_css_class('moni-tools');
        this.toolButtons = {};
        let group = null;
        GROUPS.forEach((g, gi) => {
            if (gi) {
                const sep = new Gtk.Box();
                sep.add_css_class('moni-sep');
                tools.append(sep);
            }
            for (const t of g) {
                const b = new Gtk.ToggleButton({child: icon(t.id), tooltip_text: `${t.name}   ${t.key.toUpperCase()}`});
                b.add_css_class('moni-tool');
                b.add_css_class('flat');
                if (group)
                    b.set_group(group);
                group ??= b;
                b.connect('toggled', () => {
                    if (b.active)
                        this.setTool(t.id);
                });
                this.toolButtons[t.id] = b;
                tools.append(b);
            }
        });
        header.set_title_widget(tools);
        const copy = new Gtk.Button({label: 'Copy', tooltip_text: 'Copy to clipboard (Ctrl+C)', valign: Gtk.Align.CENTER});
        copy.add_css_class('suggested-action');
        copy.connect('clicked', () => this.copy());
        header.pack_end(copy);

        // QR / barcode found in the capture.
        this.qrLabel = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, selectable: true});
        const qrBox = new Gtk.Box({spacing: 8});
        qrBox.add_css_class('moni-qr');
        qrBox.append(this.qrLabel);
        this.qrOpen = new Gtk.Button({label: 'Open'});
        this.qrOpen.add_css_class('flat');
        this.qrOpen.connect('clicked', () => Gtk.show_uri(this.win, this.qrText, Gdk.CURRENT_TIME));
        const qrCopy = new Gtk.Button({label: 'Copy'});
        qrCopy.add_css_class('flat');
        qrCopy.connect('clicked', () => this.copyText(this.qrText));
        qrBox.append(this.qrOpen);
        qrBox.append(qrCopy);
        this.qrBar = new Gtk.Revealer({child: qrBox, reveal_child: false});

        this.area = new Gtk.DrawingArea({hexpand: true, vexpand: true, focusable: true});
        this.area.add_css_class('moni-canvas');
        this.area.set_draw_func((_a, cr, w, h) => this.draw(cr, w, h));
        this.toasts = new Adw.ToastOverlay({child: this.area});

        // Bottom bar: style on the left, output on the right.
        const bar = new Gtk.Box({spacing: 4});
        bar.add_css_class('moni-bar');
        this.swatches = [];
        let sgroup = null;
        COLORS.forEach((c, i) => {
            const b = new Gtk.ToggleButton({tooltip_text: `${c}   ${i + 1}`, valign: Gtk.Align.CENTER});
            b.add_css_class('moni-swatch');
            b.add_css_class(`moni-c${i}`);
            if (sgroup)
                b.set_group(sgroup);
            sgroup ??= b;
            b.connect('toggled', () => {
                if (!b.active)
                    return;
                this.color = c;
                this.restyle({color: c});
            });
            this.swatches.push(b);
            bar.append(b);
        });
        const sep = () => {
            const s = new Gtk.Box();
            s.add_css_class('moni-sep');
            return s;
        };
        bar.append(sep());
        this.widthButtons = [];
        let wgroup = null;
        ['Thin', 'Medium', 'Thick'].forEach((name, i) => {
            const b = new Gtk.ToggleButton({child: icon(`w${i}`), tooltip_text: `${name} line   [ ]`});
            b.add_css_class('moni-tool');
            b.add_css_class('flat');
            if (wgroup)
                b.set_group(wgroup);
            wgroup ??= b;
            b.connect('toggled', () => {
                if (!b.active)
                    return;
                this.width = i;
                this.restyle({lw: this.lineWidth()});
            });
            this.widthButtons.push(b);
            bar.append(b);
        });
        this.fillButton = new Gtk.ToggleButton({child: icon('fill'), tooltip_text: 'Filled shapes and text   F'});
        this.fillButton.add_css_class('moni-tool');
        this.fillButton.add_css_class('flat');
        this.fillButton.connect('toggled', () => {
            this.fill = this.fillButton.active;
            this.restyle({fill: this.fill});
        });
        bar.append(this.fillButton);

        this.status = new Gtk.Label({hexpand: true, xalign: 0.5});
        this.status.add_css_class('moni-status');
        bar.append(this.status);

        if (this.ocrEnabled && GLib.find_program_in_path('tesseract'))
            bar.append(flat(icon('ocr'), 'Copy text in the image (OCR)', () => this.ocr()));
        const grads = new Gtk.Box({spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6});
        this.backdropButton = new Gtk.MenuButton({child: icon('backdrop'), tooltip_text: 'Backdrop', valign: Gtk.Align.CENTER});
        this.backdropButton.add_css_class('flat');
        const none = new Gtk.Button({label: 'None'});
        none.connect('clicked', () => this.setBackdrop(-1));
        grads.append(none);
        BACKDROPS.forEach((_, i) => {
            const b = new Gtk.Button();
            b.add_css_class('moni-grad');
            b.add_css_class(`moni-g${i}`);
            b.connect('clicked', () => this.setBackdrop(i));
            grads.append(b);
        });
        this.backdropButton.set_popover(new Gtk.Popover({child: grads}));
        bar.append(this.backdropButton);
        bar.append(flat(icon('pin'), 'Pin above all windows (Ctrl+P)', () => this.pin()));
        bar.append(flat(icon('save'), 'Save to Pictures/Screenshots (Ctrl+S)', () => this.save()));

        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(header);
        content.append(this.qrBar);
        content.append(this.toasts);
        content.append(bar);
        this.win.set_content(content);
    }

    // ── input ──────────────────────────────────────────────────────────

    toImage(x, y) {
        const v = this.view;
        return [(x - v.tx) / v.s, (y - v.ty) / v.s];
    }

    _wireInput() {
        const drag = new Gtk.GestureDrag({button: 1});
        drag.connect('drag-begin', (_g, x, y) => this.onPress(this.toImage(x, y)));
        drag.connect('drag-update', (_g, dx, dy) => {
            const [, sx, sy] = drag.get_start_point();
            const shift = (drag.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
            this.onDrag(this.toImage(sx + dx, sy + dy), [dx, dy], shift);
        });
        drag.connect('drag-end', (_g, dx, dy) => {
            const [, sx, sy] = drag.get_start_point();
            this.onRelease(Math.hypot(dx, dy), [sx, sy]);
        });
        this.area.add_controller(drag);

        const pan = new Gtk.GestureDrag({button: 2});
        let pan0 = null;
        pan.connect('drag-begin', () => (pan0 = [...this.pan]));
        pan.connect('drag-update', (_g, dx, dy) => {
            this.pan = [pan0[0] + dx, pan0[1] + dy];
            this.area.queue_draw();
        });
        this.area.add_controller(pan);

        const click = new Gtk.GestureClick({button: 1});
        click.connect('pressed', (_g, n, x, y) => {
            if (n !== 2 || this.tool !== 'move')
                return;
            const i = this.hitTest(this.toImage(x, y));
            if (this.items[i]?.type === 'text')
                this.askText(null, [x, y], i);
        });
        this.area.add_controller(click);

        const scroll = new Gtk.EventControllerScroll({flags: Gtk.EventControllerScrollFlags.BOTH_AXES});
        scroll.connect('scroll', (c, dx, dy) => {
            if (c.get_current_event_state() & Gdk.ModifierType.CONTROL_MASK)
                this.zoomAt(this.pointer, dy < 0 ? 1.25 : 0.8);
            else if (this.zoom > 1)
                this.panBy(-dx * 40, -dy * 40);
            else
                return false;
            return true;
        });
        this.area.add_controller(scroll);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_m, x, y) => {
            this.pointer = [x, y];
            const p = this.toImage(x, y);
            this.updateStatus(p);
            if (this.tool === 'move' && !this.drag)
                this.area.set_cursor(Gdk.Cursor.new_from_name(this.handleAt(p) || this.hitTest(p) >= 0 ? 'move' : 'default', null));
        });
        this.area.add_controller(motion);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_k, keyval, _code, state) => this.onKey(keyval, state));
        keys.connect('key-released', (_k, keyval) => {
            if (keyval === Gdk.KEY_space) {
                this.spaceDown = false;
                this.setTool(this.tool);
            }
        });
        this.win.add_controller(keys);
    }

    onKey(keyval, state) {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const name = Gdk.keyval_name(keyval)?.toLowerCase();
        const nudge = {left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1]}[name];
        if (ctrl) {
            const act = {
                c: () => this.copy(), s: () => this.save(), p: () => this.pin(),
                z: () => (shift ? this.redo() : this.undo()), y: () => this.redo(),
                0: () => this.resetView(), 1: () => this.actualSize(),
                equal: () => this.zoomAt(null, 1.25), plus: () => this.zoomAt(null, 1.25),
                minus: () => this.zoomAt(null, 0.8),
            }[name];
            if (!act)
                return false;
            act();
            return true;
        }
        if (name === 'escape') {
            if (this.sel >= 0)
                this.select(-1);
            else if (this.tool === 'crop')
                this.toolButtons[this.prevTool].active = true;
            else
                this.win.close();
        } else if ((name === 'delete' || name === 'backspace') && this.sel >= 0) {
            this.commit();
            this.items.splice(this.sel, 1);
            this.select(-1);
        } else if (nudge && this.sel >= 0) {
            const k = shift ? 10 : 1;
            this.commit();
            this.items[this.sel] = this.refreshed(this.shift(this.items[this.sel], nudge[0] * k, nudge[1] * k));
            this.area.queue_draw();
        } else if (name === 'space') {
            this.spaceDown = true;
            this.area.set_cursor(Gdk.Cursor.new_from_name('grab', null));
        } else if (name === 'bracketleft' || name === 'bracketright') {
            this.widthButtons[Math.max(0, Math.min(2, this.width + (name === 'bracketleft' ? -1 : 1)))].active = true;
        } else if (name === 'f') {
            this.fillButton.active = !this.fillButton.active;
        } else if (TOOLS.some(t => t.key === name)) {
            this.toolButtons[TOOLS.find(t => t.key === name).id].active = true;
        } else if (/^[1-8]$/.test(name)) {
            this.swatches[Number(name) - 1].active = true;
        } else {
            return false;
        }
        return true;
    }

    setTool(id) {
        if (id !== this.tool && this.tool !== 'crop')
            this.prevTool = this.tool;
        this.tool = id;
        if (id !== 'move')
            this.sel = -1;
        const cursor = {text: 'text', move: 'default'}[id] ?? 'crosshair';
        this.area.set_cursor(Gdk.Cursor.new_from_name(cursor, null));
        this.updateStatus(null);
        this.updateTitle();
        this.area.queue_draw();
    }

    // Annotations live on the image: points on the dark margin are pulled in.
    clamp([x, y]) {
        return [Math.max(0, Math.min(this.W, x)), Math.max(0, Math.min(this.H, y))];
    }

    lineWidth() {
        return Math.max(1.5, this.base * WIDTHS[this.width]);
    }

    makeItem(a, b, square = false) {
        const [x1, y1] = this.clamp(a);
        let [x2, y2] = this.clamp(b);
        if (square) {
            const dx = x2 - x1, dy = y2 - y1;
            if (LINES.has(this.tool)) {
                const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy);
                [x2, y2] = this.clamp([x1 + Math.cos(ang) * len, y1 + Math.sin(ang) * len]);
            } else {
                const d = Math.min(Math.abs(dx), Math.abs(dy));
                [x2, y2] = [x1 + Math.sign(dx) * d, y1 + Math.sign(dy) * d];
            }
        }
        return {type: this.tool, color: this.color, lw: this.lineWidth(), fill: this.fill, x1, y1, x2, y2};
    }

    onPress(p) {
        this.p0 = p;
        if (this.spaceDown) {
            this.drag = {mode: 'pan', pan0: [...this.pan]};
            return;
        }
        if (this.tool === 'move') {
            const h = this.handleAt(p);
            if (h) {
                this.drag = {mode: 'resize', ...h, orig: this.items[this.sel], before: this.snapshot()};
            } else {
                this.select(this.hitTest(p));
                if (this.sel >= 0)
                    this.drag = {mode: 'move', orig: this.items[this.sel], before: this.snapshot()};
            }
        } else if (this.tool === 'crop') {
            this.drag = {mode: 'crop', rect: null};
        } else if (this.tool === 'pen') {
            this.draft = {type: 'pen', color: this.color, lw: this.lineWidth(), pts: [this.clamp(p)]};
        } else if (!CLICK_TOOLS.has(this.tool)) {
            this.draft = this.makeItem(p, p);
        }
    }

    onDrag(p, [dx, dy], shift) {
        const d = this.drag, p0 = this.p0;
        if (d?.mode === 'pan') {
            this.pan = [d.pan0[0] + dx, d.pan0[1] + dy];
        } else if (d?.mode === 'move') {
            this.items[this.sel] = this.shift(d.orig, p[0] - p0[0], p[1] - p0[1]);
        } else if (d?.mode === 'resize') {
            const q = this.clamp(p);
            this.items[this.sel] = {...d.orig, [d.kx]: q[0], [d.ky]: q[1]};
        } else if (d?.mode === 'crop') {
            const [x1, y1] = this.clamp(p0), [x2, y2] = this.clamp(p);
            d.rect = {x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)),
                w: Math.round(Math.abs(x2 - x1)), h: Math.round(Math.abs(y2 - y1))};
        } else if (this.draft?.type === 'pen') {
            const q = this.clamp(p), last = this.draft.pts.at(-1);
            if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 1)
                this.draft.pts.push(q);
        } else if (this.draft) {
            this.draft = this.makeItem(p0, p, shift);
        } else {
            return;
        }
        this.area.queue_draw();
    }

    onRelease(dist, widgetPoint) {
        const d = this.drag;
        this.drag = null;
        if (d?.mode === 'move' || d?.mode === 'resize') {
            const it = this.items[this.sel];
            if (it !== d.orig) {
                this.items[this.sel] = this.refreshed(it);
                this.commit(d.before);
            }
        } else if (d?.mode === 'crop') {
            this.commit();
            this.crop = d.rect && d.rect.w >= 4 && d.rect.h >= 4 ? d.rect : null;
            this.toolButtons[this.prevTool].active = true;
        } else if (CLICK_TOOLS.has(this.tool) && !d) {
            if (dist < 4)
                this.click(this.p0, widgetPoint);
        } else if (this.draft?.type === 'pen') {
            if (this.draft.pts.length >= 2)
                this.addItem(this.draft);
        } else if (this.draft && dist >= 3 && this.refresh(this.draft)) {
            this.addItem(this.draft);
        }
        this.draft = null;
        this.updateTitle();
        this.area.queue_draw();
    }

    click(p, widgetPoint) {
        if (this.tool !== 'picker')
            p = this.clamp(p);
        if (this.tool === 'step') {
            const n = this.items.filter(i => i.type === 'step').length + 1;
            this.addItem({type: 'step', color: this.color, lw: this.lineWidth(), x1: p[0], y1: p[1], n});
        } else if (this.tool === 'picker') {
            const hex = this.pixelHex(p);
            if (hex) {
                send('TEXT', hex);
                this.toast(`Copied ${hex}`);
            }
        } else if (this.tool === 'text') {
            const i = this.hitTest(p);
            this.askText(p, widgetPoint, this.items[i]?.type === 'text' ? i : -1);
        }
    }

    askText(p, [wx, wy], edit = -1) {
        const old = this.items[edit];
        const entry = new Gtk.Entry({placeholder_text: 'Text, then Enter', width_chars: 24, text: old?.text ?? ''});
        const pop = new Gtk.Popover({child: entry});
        pop.set_parent(this.area);
        pop.set_pointing_to(new Gdk.Rectangle({x: Math.round(wx), y: Math.round(wy), width: 1, height: 1}));
        entry.connect('activate', () => {
            const text = entry.text.trim() ? entry.text : '';
            if (old && text !== old.text) {
                this.commit();
                if (text)
                    this.items[edit] = {...old, text};
                else
                    this.items.splice(edit, 1);
                this.select(-1);
            } else if (!old && text) {
                this.addItem({type: 'text', color: this.color, lw: this.lineWidth(), fill: this.fill, x1: p[0], y1: p[1], text});
            }
            pop.popdown();
            this.updateTitle();
            this.area.queue_draw();
        });
        pop.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            pop.unparent();
            return GLib.SOURCE_REMOVE;
        }));
        pop.popup();
        entry.grab_focus();
    }

    // ── state & history ────────────────────────────────────────────────
    // Items are never mutated once committed: edits replace the object, so
    // a snapshot is just a shallow copy of the list.

    snapshot() {
        return {items: this.items.slice(), crop: this.crop};
    }

    commit(before = this.snapshot()) {
        this.history.push(before);
        this.redoStack = [];
    }

    restore(s) {
        this.items = s.items;
        this.crop = s.crop;
        this.select(-1);
        this.updateTitle();
    }

    addItem(it) {
        this.commit();
        this.items.push(it);
    }

    undo() {
        if (!this.history.length)
            return;
        this.redoStack.push(this.snapshot());
        this.restore(this.history.pop());
    }

    redo() {
        if (!this.redoStack.length)
            return;
        this.history.push(this.snapshot());
        this.restore(this.redoStack.pop());
    }

    select(i) {
        this.sel = i;
        this.area.queue_draw();
    }

    // Color / width / fill buttons also restyle the selected annotation.
    restyle(patch) {
        if (this.sel < 0)
            return;
        this.commit();
        this.items[this.sel] = this.refreshed({...this.items[this.sel], ...patch});
        this.updateTitle();
        this.area.queue_draw();
    }

    setBackdrop(i) {
        this.backdrop = i;
        this.backdropButton.get_popover().popdown();
        this.updateTitle();
        this.area.queue_draw();
    }

    // ── geometry ───────────────────────────────────────────────────────

    // Topmost annotation under p, or -1. The grab margin never drops below
    // ~6 screen pixels, so thin lines stay easy to pick on a zoomed-out view.
    hitTest(p) {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            const tol = Math.max(it.lw * 1.5, 6 / this.view.s);
            const inBox = (bx, by, bw, bh) => p[0] >= bx - tol && p[0] <= bx + bw + tol && p[1] >= by - tol && p[1] <= by + bh + tol;
            let hit = false;
            switch (it.type) {
            case 'arrow': case 'line': case 'ruler':
                hit = segDist(p, [it.x1, it.y1], [it.x2, it.y2]) <= tol;
                break;
            case 'pen':
                hit = it.pts.some((q, j) => segDist(p, it.pts[Math.max(0, j - 1)], q) <= tol);
                break;
            case 'rect': {
                const {x, y, w, h} = box(it);
                hit = inBox(x, y, w, h) && (it.fill || !(p[0] > x + tol && p[0] < x + w - tol && p[1] > y + tol && p[1] < y + h - tol));
                break;
            }
            case 'oval': {
                const {x, y, w, h} = box(it);
                const rx = Math.max(w / 2, 1), ry = Math.max(h / 2, 1);
                const r = Math.hypot((p[0] - x - rx) / rx, (p[1] - y - ry) / ry);
                hit = it.fill ? r <= 1 + tol / Math.min(rx, ry) : Math.abs(r - 1) * Math.min(rx, ry) <= tol;
                break;
            }
            case 'step':
                hit = Math.hypot(p[0] - it.x1, p[1] - it.y1) <= it.lw * 4 + tol;
                break;
            case 'text': {
                const b = this.bounds(it);
                hit = inBox(b.x, b.y, b.w, b.h);
                break;
            }
            default: {
                const {x, y, w, h} = box(it);
                hit = inBox(x, y, w, h);
            }
            }
            if (hit)
                return i;
        }
        return -1;
    }

    // Image-space bounding box, for selection outlines and text hits.
    bounds(it) {
        const m = it.lw / 2;
        if (it.type === 'pen') {
            const xs = it.pts.map(q => q[0]), ys = it.pts.map(q => q[1]);
            const x = Math.min(...xs), y = Math.min(...ys);
            return {x: x - m, y: y - m, w: Math.max(...xs) - x + it.lw, h: Math.max(...ys) - y + it.lw};
        }
        if (it.type === 'text') {
            const [w, h] = it.size ?? [it.lw * 6 * it.text.length * 0.6, it.lw * 7];
            const pad = it.fill ? it.lw * 1.8 : 0;
            return {x: it.x1 - pad, y: it.y1 - pad * 0.6, w: w + pad * 2, h: h + pad * 1.2};
        }
        if (it.type === 'step') {
            const r = it.lw * 4;
            return {x: it.x1 - r, y: it.y1 - r, w: 2 * r, h: 2 * r};
        }
        const b = box(it);
        return {x: b.x - m, y: b.y - m, w: b.w + it.lw, h: b.h + it.lw};
    }

    handles(it) {
        if (LINES.has(it.type))
            return [['x1', 'y1'], ['x2', 'y2']];
        if (BOXES.has(it.type))
            return [['x1', 'y1'], ['x2', 'y1'], ['x1', 'y2'], ['x2', 'y2']];
        return [];
    }

    handleAt(p) {
        const it = this.items[this.sel];
        if (!it)
            return null;
        const r = 8 / this.view.s;
        const h = this.handles(it).find(([kx, ky]) => Math.hypot(p[0] - it[kx], p[1] - it[ky]) <= r);
        return h ? {kx: h[0], ky: h[1]} : null;
    }

    // A moved copy, so undo can restore the original object.
    shift(it, dx, dy) {
        const out = {...it};
        for (const [kx, ky] of [['x1', 'y1'], ['x2', 'y2'], ['px', 'py']]) {
            if (it[kx] !== undefined) {
                out[kx] = it[kx] + dx;
                out[ky] = it[ky] + dy;
            }
        }
        if (it.pts)
            out.pts = it.pts.map(([x, y]) => [x + dx, y + dy]);
        return out;
    }

    // ── redaction ──────────────────────────────────────────────────────

    region(it) {
        const x = Math.max(0, Math.floor(Math.min(it.x1, it.x2)));
        const y = Math.max(0, Math.floor(Math.min(it.y1, it.y2)));
        const w = Math.min(this.W, Math.ceil(Math.max(it.x1, it.x2))) - x;
        const h = Math.min(this.H, Math.ceil(Math.max(it.y1, it.y2))) - y;
        return w >= 2 && h >= 2 ? {x, y, w, h} : null;
    }

    pixelate(it) {
        const r = this.region(it);
        if (!r)
            return null;
        const block = Math.max(6, it.lw * 3);
        it.px = r.x;
        it.py = r.y;
        return this.pixbuf.new_subpixbuf(r.x, r.y, r.w, r.h)
            .scale_simple(Math.max(1, Math.round(r.w / block)), Math.max(1, Math.round(r.h / block)), GdkPixbuf.InterpType.BILINEAR)
            .scale_simple(r.w, r.h, GdkPixbuf.InterpType.NEAREST);
    }

    // Box-filter down, smooth back up twice: a cheap, strong Gaussian look.
    blurred(it) {
        const r = this.region(it);
        if (!r)
            return null;
        const k = Math.max(6, it.lw * 3);
        it.px = r.x;
        it.py = r.y;
        const size = f => [Math.max(1, Math.round(r.w / f)), Math.max(1, Math.round(r.h / f))];
        return this.pixbuf.new_subpixbuf(r.x, r.y, r.w, r.h)
            .scale_simple(...size(k), GdkPixbuf.InterpType.HYPER)
            .scale_simple(r.w, r.h, GdkPixbuf.InterpType.BILINEAR)
            .scale_simple(...size(k / 2), GdkPixbuf.InterpType.HYPER)
            .scale_simple(r.w, r.h, GdkPixbuf.InterpType.BILINEAR);
    }

    // Average of a thin ring around the box: erases UI text on flat backgrounds.
    ringColor(it) {
        const r = this.region(it);
        if (!r)
            return null;
        const sum = [0, 0, 0];
        let n = 0;
        const add = (x, y) => {
            if (x < 0 || y < 0 || x >= this.W || y >= this.H)
                return;
            const o = y * this.stride + x * this.channels;
            for (let c = 0; c < 3; c++)
                sum[c] += this.pixels[o + c];
            n++;
        };
        for (let k = 1; k <= 2; k++) {
            for (let x = r.x - k; x < r.x + r.w + k; x++) {
                add(x, r.y - k);
                add(x, r.y + r.h - 1 + k);
            }
            for (let y = r.y; y < r.y + r.h; y++) {
                add(r.x - k, y);
                add(r.x + r.w - 1 + k, y);
            }
        }
        return n ? sum.map(v => v / n / 255) : null;
    }

    // Recompute pixels a redaction shows; false when it covers no image.
    refresh(it) {
        if (!REDACT.has(it.type))
            return true;
        const value = {pixelate: () => this.pixelate(it), blur: () => this.blurred(it), erase: () => this.ringColor(it)}[it.type]();
        if (value)
            it[it.type === 'erase' ? 'rgb' : 'pixbuf'] = value;
        return value !== null;
    }

    refreshed(it) {
        this.refresh(it);
        return it;
    }

    // ── view ───────────────────────────────────────────────────────────

    frame(forExport = false) {
        if (this.tool === 'crop' && !forExport)
            return {x: 0, y: 0, w: this.W, h: this.H};
        return this.crop ?? {x: 0, y: 0, w: this.W, h: this.H};
    }

    padding(f, forExport = false) {
        if (this.backdrop < 0 || (this.tool === 'crop' && !forExport))
            return 0;
        return Math.max(24, Math.round(Math.max(f.w, f.h) * 0.07));
    }

    computeView(w, h) {
        const f = this.frame(), pad = this.padding(f);
        const cw = f.w + 2 * pad, ch = f.h + 2 * pad;
        const sf = this.area.get_scale_factor();
        const fit = Math.min((w - 48) / cw, (h - 48) / ch, 1 / sf);
        const s = fit * this.zoom;
        const ox = Math.round((w - cw * s) / 2 + this.pan[0]), oy = Math.round((h - ch * s) / 2 + this.pan[1]);
        return {s, fit, ox, oy, cw, ch, pad, f, tx: ox + (pad - f.x) * s, ty: oy + (pad - f.y) * s};
    }

    zoomAt(point, factor) {
        const w = this.area.get_width(), h = this.area.get_height();
        point ??= [w / 2, h / 2];
        const p = this.toImage(...point);
        this.zoom = Math.max(0.25, Math.min(32, this.zoom * factor));
        const v = this.computeView(w, h);
        this.pan[0] += point[0] - (v.tx + p[0] * v.s);
        this.pan[1] += point[1] - (v.ty + p[1] * v.s);
        this.view = this.computeView(w, h);
        this.updateStatus(null);
        this.area.queue_draw();
    }

    panBy(dx, dy) {
        this.pan = [this.pan[0] + dx, this.pan[1] + dy];
        this.area.queue_draw();
    }

    resetView() {
        this.zoom = 1;
        this.pan = [0, 0];
        this.view = this.computeView(this.area.get_width(), this.area.get_height());
        this.updateStatus(null);
        this.area.queue_draw();
    }

    actualSize() {
        const v = this.computeView(this.area.get_width(), this.area.get_height());
        this.zoomAt(null, 1 / this.area.get_scale_factor() / v.s);
    }

    pixelHex([x, y]) {
        x = Math.floor(x);
        y = Math.floor(y);
        if (x < 0 || y < 0 || x >= this.W || y >= this.H)
            return null;
        const o = y * this.stride + x * this.channels;
        return `#${[0, 1, 2].map(i => this.pixels[o + i].toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    }

    updateStatus(p) {
        const parts = [];
        const hex = p && this.pixelHex(p);
        if (hex)
            parts.push(`${Math.floor(p[0])}, ${Math.floor(p[1])}`, hex);
        if (this.zoom !== 1)
            parts.push(`${Math.round(this.view.s * this.area.get_scale_factor() * 100)}%`);
        if (this.tool === 'crop')
            parts.push('drag to crop · click to reset · Esc cancel');
        this.status.label = parts.join('    ');
    }

    updateTitle() {
        const f = this.frame(true), pad = this.padding(f, true);
        this.win.title = `Moni Shot — ${f.w + 2 * pad} × ${f.h + 2 * pad}`;
        this.undoButton.sensitive = this.history.length > 0;
        this.redoButton.sensitive = this.redoStack.length > 0;
    }

    toast(title) {
        this.toasts.add_toast(new Adw.Toast({title, timeout: 2}));
    }

    // ── rendering ──────────────────────────────────────────────────────

    draw(cr, w, h) {
        const v = this.view = this.computeView(w, h);
        // Soft page shadow on the canvas only; never exported.
        if (!v.pad) {
            for (let k = 6; k >= 1; k--) {
                roundedRect(cr, v.ox - k, v.oy - k + 2, v.cw * v.s + 2 * k, v.ch * v.s + 2 * k, k + 2);
                cr.setSourceRGBA(0, 0, 0, 0.035);
                cr.fill();
            }
        }
        cr.save();
        cr.translate(v.ox, v.oy);
        cr.scale(v.s, v.s);
        this.renderPage(cr, v.f, v.pad);
        cr.restore();

        const toW = (x, y) => [v.tx + x * v.s, v.ty + y * v.s];
        if (this.tool === 'crop') {
            const c = this.drag?.rect ?? this.crop;
            if (c) {
                const [x, y] = toW(c.x, c.y);
                cr.setFillRule(Cairo.FillRule.EVEN_ODD);
                cr.rectangle(v.ox, v.oy, v.cw * v.s, v.ch * v.s);
                cr.rectangle(x, y, c.w * v.s, c.h * v.s);
                cr.setSourceRGBA(0, 0, 0, 0.5);
                cr.fill();
                cr.setFillRule(Cairo.FillRule.WINDING);
                cr.rectangle(x + 0.5, y + 0.5, c.w * v.s - 1, c.h * v.s - 1);
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.setLineWidth(1);
                cr.stroke();
            }
        }
        const it = this.items[this.sel];
        if (it && this.tool === 'move') {
            const b = this.bounds(it);
            const [x, y] = toW(b.x, b.y);
            cr.setSourceRGBA(...ACCENT, 1);
            cr.setLineWidth(1);
            cr.setDash([4, 3], 0);
            cr.rectangle(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(b.w * v.s), Math.round(b.h * v.s));
            cr.stroke();
            cr.setDash([], 0);
            for (const [kx, ky] of this.handles(it)) {
                cr.arc(...toW(it[kx], it[ky]), 4.5, 0, 2 * Math.PI);
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.fillPreserve();
                cr.setSourceRGBA(...ACCENT, 1);
                cr.setLineWidth(1.5);
                cr.stroke();
            }
        }
    }

    // The output page: optional gradient backdrop, then the (cropped) image.
    renderPage(cr, f, pad) {
        const radius = pad ? Math.max(6, Math.min(18, Math.round(Math.min(f.w, f.h) * 0.02))) : 0;
        if (pad) {
            const [c0, c1] = BACKDROPS[this.backdrop].map(rgb);
            const grad = new Cairo.LinearGradient(0, 0, f.w + 2 * pad, f.h + 2 * pad);
            grad.addColorStopRGB(0, ...c0);
            grad.addColorStopRGB(1, ...c1);
            cr.setSource(grad);
            cr.rectangle(0, 0, f.w + 2 * pad, f.h + 2 * pad);
            cr.fill();
            const spread = pad * 0.35;
            for (let k = 10; k >= 1; k--) {
                const e = spread * k / 10;
                roundedRect(cr, pad - e, pad - e + pad * 0.12, f.w + 2 * e, f.h + 2 * e, radius + e);
                cr.setSourceRGBA(0, 0, 0, 0.03);
                cr.fill();
            }
        }
        cr.save();
        roundedRect(cr, pad, pad, f.w, f.h, radius);
        cr.clip();
        cr.translate(pad - f.x, pad - f.y);
        this.render(cr);
        cr.restore();
    }

    // Image plus annotations, in image coordinates. Redactions go first so
    // nothing drawn on top gets blurred away; the spotlight dims beneath
    // the annotations so they stay vivid.
    render(cr) {
        Gdk.cairo_set_source_pixbuf(cr, this.pixbuf, 0, 0);
        cr.paint();
        const all = this.draft ? [...this.items, this.draft] : this.items;
        all.filter(it => REDACT.has(it.type)).forEach(it => this.drawItem(cr, it));
        const spots = all.filter(it => it.type === 'spotlight');
        if (spots.length) {
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.rectangle(-1, -1, this.W + 2, this.H + 2);
            for (const s of spots) {
                const b = box(s);
                roundedRect(cr, b.x, b.y, b.w, b.h, s.lw * 1.5);
            }
            cr.setSourceRGBA(0, 0, 0, 0.55);
            cr.fill();
            cr.setFillRule(Cairo.FillRule.WINDING);
        }
        all.filter(it => !REDACT.has(it.type) && it.type !== 'spotlight').forEach(it => this.drawItem(cr, it));
    }

    drawItem(cr, it) {
        const lw = it.lw;
        const col = rgb(it.color);
        const [r, g, b] = col;
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(lw);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        const {x, y, w, h} = it.x2 !== undefined ? box(it) : {};
        switch (it.type) {
        case 'arrow': {
            const ang = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
            const head = lw * 4.5;
            const bx = it.x2 - Math.cos(ang) * head * 0.8, by = it.y2 - Math.sin(ang) * head * 0.8;
            cr.moveTo(it.x1, it.y1);
            cr.lineTo(bx, by);
            cr.stroke();
            cr.moveTo(it.x2, it.y2);
            cr.lineTo(it.x2 - head * Math.cos(ang - 0.45), it.y2 - head * Math.sin(ang - 0.45));
            cr.lineTo(it.x2 - head * Math.cos(ang + 0.45), it.y2 - head * Math.sin(ang + 0.45));
            cr.closePath();
            cr.fill();
            break;
        }
        case 'line':
            cr.moveTo(it.x1, it.y1);
            cr.lineTo(it.x2, it.y2);
            cr.stroke();
            break;
        case 'rect':
            roundedRect(cr, x, y, w, h, lw * 0.8);
            if (it.fill)
                cr.fill();
            else
                cr.stroke();
            break;
        case 'oval':
            if (w < 1 || h < 1)
                break;
            cr.save();
            cr.translate(x + w / 2, y + h / 2);
            cr.scale(w / 2, h / 2);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            if (it.fill)
                cr.fill();
            else
                cr.stroke();
            break;
        case 'pen':
            cr.moveTo(...it.pts[0]);
            for (const q of it.pts.slice(1))
                cr.lineTo(...q);
            cr.stroke();
            break;
        case 'highlight':
            cr.setSourceRGBA(r, g, b, 0.35);
            cr.rectangle(x, y, w, h);
            cr.fill();
            break;
        case 'pixelate':
        case 'blur':
            if (it.pixbuf) {
                Gdk.cairo_set_source_pixbuf(cr, it.pixbuf, it.px, it.py);
                cr.rectangle(it.px, it.py, it.pixbuf.get_width(), it.pixbuf.get_height());
                cr.fill();
            } else {
                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.5);
                cr.rectangle(x, y, w, h);
                cr.fill();
            }
            break;
        case 'erase':
            if (it.rgb)
                cr.setSourceRGBA(...it.rgb, 1);
            else
                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.5);
            cr.rectangle(x, y, w, h);
            cr.fill();
            break;
        case 'spotlight':
            break;
        case 'text': {
            const fs = lw * 6;
            const layout = PangoCairo.create_layout(cr);
            const font = Pango.FontDescription.from_string('Sans Bold');
            font.set_absolute_size(fs * Pango.SCALE);
            layout.set_font_description(font);
            layout.set_text(it.text, -1);
            it.size = layout.get_pixel_size();
            const ink = isLight(col) ? 0 : 1;
            if (it.fill) {
                const bb = this.bounds(it);
                roundedRect(cr, bb.x, bb.y, bb.w, bb.h, fs * 0.35);
                cr.fill();
                cr.moveTo(it.x1, it.y1);
                cr.setSourceRGBA(ink, ink, ink, 1);
                PangoCairo.show_layout(cr, layout);
            } else {
                cr.moveTo(it.x1, it.y1);
                PangoCairo.layout_path(cr, layout);
                cr.setSourceRGBA(ink, ink, ink, 0.9);
                cr.setLineWidth(lw * 0.9);
                cr.strokePreserve();
                cr.setSourceRGBA(r, g, b, 1);
                cr.fill();
            }
            break;
        }
        case 'step': {
            const rad = lw * 4;
            cr.arc(it.x1, it.y1, rad, 0, 2 * Math.PI);
            cr.fill();
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(rad * 1.2);
            const ext = cr.textExtents(String(it.n));
            const ink = isLight(col) ? 0 : 1;
            cr.setSourceRGBA(ink, ink, ink, 1);
            cr.moveTo(it.x1 - ext.width / 2 - ext.xBearing, it.y1 - ext.height / 2 - ext.yBearing);
            cr.showText(String(it.n));
            break;
        }
        case 'ruler': {
            const dx = it.x2 - it.x1, dy = it.y2 - it.y1;
            const len = Math.hypot(dx, dy);
            const ang = Math.atan2(dy, dx), nx = -Math.sin(ang) * lw * 2, ny = Math.cos(ang) * lw * 2;
            cr.setLineWidth(Math.max(1.5, lw / 2));
            cr.moveTo(it.x1, it.y1);
            cr.lineTo(it.x2, it.y2);
            for (const [px, py] of [[it.x1, it.y1], [it.x2, it.y2]]) {
                cr.moveTo(px - nx, py - ny);
                cr.lineTo(px + nx, py + ny);
            }
            cr.stroke();
            const label = `${Math.round(len)} px` + (Math.abs(dx) > 2 && Math.abs(dy) > 2 ? `  (${Math.round(Math.abs(dx))} × ${Math.round(Math.abs(dy))})` : '');
            const fs = lw * 4;
            cr.selectFontFace('Monospace', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(fs);
            const ext = cr.textExtents(label);
            const mx = (it.x1 + it.x2) / 2 + nx * 2, my = (it.y1 + it.y2) / 2 + ny * 2;
            cr.setSourceRGBA(0, 0, 0, 0.75);
            roundedRect(cr, mx - ext.width / 2 - fs * 0.4, my - fs * 0.9, ext.width + fs * 0.8, fs * 1.3, fs * 0.3);
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(mx - ext.width / 2, my);
            cr.showText(label);
            break;
        }
        }
    }

    // ── recognition ────────────────────────────────────────────────────

    async scanQr() {
        if (!this.ocrEnabled || !GLib.find_program_in_path('zbarimg'))
            return;
        const codes = (await run(['zbarimg', '--quiet', '--raw', this.path])).split('\n').filter(Boolean);
        if (!codes.length)
            return;
        this.qrText = codes[0];
        this.qrLabel.label = `QR   ${codes[0]}${codes.length > 1 ? `   (+${codes.length - 1})` : ''}`;
        this.qrOpen.visible = /^(https?|ftp|mailto|tel|geo):/i.test(codes[0]);
        this.qrBar.reveal_child = true;
    }

    async ocr() {
        const f = this.frame(true);
        this.toast('Recognizing text…');
        const text = await recognize(this.pixbuf.new_subpixbuf(f.x, f.y, f.w, f.h), this.path.replace(/\.png$/, '_ocr.png'));
        if (text)
            this.copyText(text, `Copied ${text.length} characters`);
        else
            this.toast('No text found');
    }

    copyText(text, msg = 'Copied') {
        send('TEXTJ', JSON.stringify(text));
        this.toast(msg);
    }

    // ── output ─────────────────────────────────────────────────────────

    exportTo(path) {
        const f = this.frame(true), pad = this.padding(f, true);
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, f.w + 2 * pad, f.h + 2 * pad);
        const cr = new Cairo.Context(surface);
        this.renderPage(cr, f, pad);
        surface.writeToPNG(path);
        cr.$dispose();
        return path;
    }

    copy() {
        send('COPY', this.exportTo(this.path.replace(/\.png$/, '_edit.png')));
        this.toast('Copied to clipboard');
    }

    save() {
        const dir = `${GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir()}/Screenshots`;
        GLib.mkdir_with_parents(dir, 0o755);
        const path = this.exportTo(`${dir}/Moni_${stamp()}.png`);
        send('SAVED', path);
        this.toast(`Saved ${path.replace(GLib.get_home_dir(), '~')}`);
    }

    pin() {
        send('PIN', this.exportTo(this.path.replace(/\.png$/, `_pin${Date.now()}.png`)));
        this.win.close();
    }
}

const path = System.programArgs[0];
if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
    printerr('usage: gjs -m editor.js <image.png>');
    System.exit(2);
}
const app = new Adw.Application({application_id: 'io.github.ingjae.moni.Shot', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    loadCss();
    new Editor(app, path, System.programArgs.includes('--ocr'));
});
app.run([]);
