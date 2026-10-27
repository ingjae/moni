// editor.js — Moni Shot, a Shottr-style screenshot editor.
//
//   gjs -m editor.js <capture.png>
//
// GTK 4.6 / libadwaita 1.1 APIs only, so it runs on Ubuntu 22.04 too.
// Anything that must outlive this window (clipboard, pinned images) is
// handed back to the Shell extension on stdout, one command per line:
//   COPY <png>   TEXT <string>   PIN <png>   SAVED <png>

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

const TOOLS = [
    {id: 'move', key: 'v', label: '✥', name: 'Move'},
    {id: 'arrow', key: 'a', label: '↗', name: 'Arrow'},
    {id: 'rect', key: 'r', label: '▭', name: 'Rectangle'},
    {id: 'pen', key: 'p', label: '✎', name: 'Pen'},
    {id: 'highlight', key: 'h', label: '▮', name: 'Highlighter'},
    {id: 'text', key: 't', label: 'T', name: 'Text'},
    {id: 'blur', key: 'b', label: '▦', name: 'Pixelate'},
    {id: 'step', key: 'n', label: '①', name: 'Step number'},
    {id: 'ruler', key: 'm', label: '⟷', name: 'Ruler'},
    {id: 'picker', key: 'i', label: '◎', name: 'Color picker'},
];
const CLICK_TOOLS = new Set(['text', 'step', 'picker']);
const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#000000'];

// Distance from point p to segment ab, in image pixels.
function segDist([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const stamp = () => GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
const send = (cmd, arg) => print(`${cmd} ${arg}`);

const CSS = `
.moni-canvas { background-color: #1e1e1e; }
.moni-tool { min-width: 34px; font-size: 15px; padding: 2px 6px; }
.moni-swatch { min-width: 20px; min-height: 20px; padding: 0; margin: 0 2px; border-radius: 10px; }
.moni-swatch:checked { box-shadow: inset 0 0 0 2px #ffffff, 0 0 0 2px #8a8a8a; }
.moni-status { font-family: monospace; font-size: 11px; padding: 4px 10px; }
${COLORS.map((c, i) => `.moni-c${i} { background: ${c}; }`).join('\n')}
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
    constructor(app, path) {
        this.path = path;
        this.pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        this.W = this.pixbuf.get_width();
        this.H = this.pixbuf.get_height();
        this.pixels = this.pixbuf.get_pixels();
        this.stride = this.pixbuf.get_rowstride();
        this.channels = this.pixbuf.get_n_channels();
        this.lw = Math.max(3, Math.round(Math.max(this.W, this.H) / 350));
        this.items = [];
        this.history = [];
        this.draft = null;
        this.moving = null;
        this.tool = 'arrow';
        this.color = COLORS[0];
        this.view = {s: 1, ox: 0, oy: 0};

        this.win = new Adw.ApplicationWindow({application: app, title: 'Moni Shot'});
        const sf = this.win.get_scale_factor?.() ?? 1;
        this.win.set_default_size(
            Math.max(640, Math.min(1400, Math.round(this.W / sf) + 48)),
            Math.max(420, Math.min(920, Math.round(this.H / sf) + 150)));

        const header = new Adw.HeaderBar();
        this.title = new Adw.WindowTitle({title: 'Moni Shot', subtitle: `${this.W} × ${this.H}`});
        header.set_title_widget(this.title);
        const action = (label, tip, fn, cls) => {
            const b = new Gtk.Button({label, tooltip_text: tip});
            if (cls)
                b.add_css_class(cls);
            b.connect('clicked', fn);
            header.pack_end(b);
        };
        action('Copy', 'Copy to clipboard (Ctrl+C)', () => this.copy(), 'suggested-action');
        action('Save', 'Save to Pictures/Screenshots (Ctrl+S)', () => this.save());
        action('Pin', 'Float above all windows (Ctrl+P)', () => this.pin());
        const undo = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: 'Undo (Ctrl+Z)'});
        undo.connect('clicked', () => this.undo());
        header.pack_start(undo);

        const toolbar = new Gtk.Box({spacing: 4, margin_start: 8, margin_end: 8, margin_top: 6, margin_bottom: 6});
        this.toolButtons = {};
        let group = null;
        for (const t of TOOLS) {
            const b = new Gtk.ToggleButton({label: t.label, tooltip_text: `${t.name} (${t.key.toUpperCase()})`});
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
            toolbar.append(b);
        }
        const palette = new Gtk.Box({spacing: 4, margin_start: 8, margin_end: 8, margin_bottom: 6});
        this.swatches = [];
        let sgroup = null;
        COLORS.forEach((c, i) => {
            const b = new Gtk.ToggleButton({tooltip_text: `${c}  (${i + 1})`, valign: Gtk.Align.CENTER});
            b.add_css_class('moni-swatch');
            b.add_css_class(`moni-c${i}`);
            if (sgroup)
                b.set_group(sgroup);
            sgroup ??= b;
            b.connect('toggled', () => {
                if (b.active)
                    this.color = c;
            });
            this.swatches.push(b);
            palette.append(b);
        });

        this.area = new Gtk.DrawingArea({hexpand: true, vexpand: true});
        this.area.add_css_class('moni-canvas');
        this.area.set_draw_func((_a, cr, w, h) => this.draw(cr, w, h));

        this.status = new Gtk.Label({xalign: 0, wrap: true});
        this.status.add_css_class('moni-status');

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(header);
        const toolScroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER});
        toolScroll.set_child(toolbar);
        box.append(toolScroll);
        box.append(palette);
        box.append(this.area);
        box.append(this.status);
        this.toasts = new Adw.ToastOverlay();
        this.toasts.set_child(box);
        this.win.set_content(this.toasts);

        this._wireInput();
        this.toolButtons.arrow.active = true;
        this.swatches[0].active = true;
        this.updateStatus(null);
        this.win.present();
    }

    // ── input ──────────────────────────────────────────────────────────

    toImage(x, y) {
        const v = this.view;
        return [(x - v.ox) / v.s, (y - v.oy) / v.s];
    }

    _wireInput() {
        const drag = new Gtk.GestureDrag();
        let p0 = null;
        drag.connect('drag-begin', (_g, x, y) => {
            p0 = this.toImage(x, y);
            if (this.tool === 'move') {
                const i = this.hitTest(p0);
                if (i >= 0)
                    this.moving = {i, orig: this.items[i], before: this.items.slice()};
            } else if (this.tool === 'pen') {
                this.draft = {type: 'pen', color: this.color, pts: [this.clamp(p0)]};
            } else if (!CLICK_TOOLS.has(this.tool)) {
                this.draft = this.makeItem(p0, p0);
            }
        });
        drag.connect('drag-update', (_g, dx, dy) => {
            const [sx, sy] = drag.get_start_point().slice(1);
            const p = this.toImage(sx + dx, sy + dy);
            if (this.moving) {
                this.items[this.moving.i] = this.shift(this.moving.orig, p[0] - p0[0], p[1] - p0[1]);
            } else if (this.draft?.type === 'pen') {
                const q = this.clamp(p), last = this.draft.pts.at(-1);
                if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 1)
                    this.draft.pts.push(q);
            } else if (this.draft) {
                this.draft = this.makeItem(p0, p);
            } else {
                return;
            }
            this.area.queue_draw();
        });
        drag.connect('drag-end', (_g, dx, dy) => {
            if (this.moving) {
                const it = this.items[this.moving.i];
                if (it !== this.moving.orig) {
                    if (it.type === 'blur')
                        it.pixbuf = this.pixelate(it) ?? it.pixbuf;
                    this.history.push(this.moving.before);
                }
                this.moving = null;
            } else if (CLICK_TOOLS.has(this.tool)) {
                if (Math.hypot(dx, dy) < 4)
                    this.click(p0, drag.get_start_point().slice(1));
            } else if (this.draft?.type === 'pen') {
                if (this.draft.pts.length >= 2)
                    this.addItem(this.draft);
            } else if (this.draft && Math.hypot(dx, dy) >= 3) {
                if (this.draft.type === 'blur')
                    this.draft.pixbuf = this.pixelate(this.draft);
                if (this.draft.pixbuf !== null)
                    this.addItem(this.draft);
            }
            this.draft = null;
            this.area.queue_draw();
        });
        this.area.add_controller(drag);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_m, x, y) => {
            const p = this.toImage(x, y);
            this.updateStatus(p);
            if (this.tool === 'move' && !this.moving)
                this.area.set_cursor(Gdk.Cursor.new_from_name(this.hitTest(p) >= 0 ? 'move' : 'default', null));
        });
        this.area.add_controller(motion);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_k, keyval, _code, state) => this.onKey(keyval, state));
        this.win.add_controller(keys);
    }

    onKey(keyval, state) {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const name = Gdk.keyval_name(keyval)?.toLowerCase();
        if (ctrl && name === 'c')
            this.copy();
        else if (ctrl && name === 's')
            this.save();
        else if (ctrl && name === 'p')
            this.pin();
        else if (ctrl && name === 'z')
            this.undo();
        else if (name === 'escape')
            this.win.close();
        else if (!ctrl && TOOLS.some(t => t.key === name))
            this.toolButtons[TOOLS.find(t => t.key === name).id].active = true;
        else if (!ctrl && /^[1-8]$/.test(name))
            this.swatches[Number(name) - 1].active = true;
        else
            return false;
        return true;
    }

    setTool(id) {
        this.tool = id;
        this.updateStatus(null);
        const cursor = {text: 'text', move: 'default'}[id] ?? 'crosshair';
        this.area.set_cursor(Gdk.Cursor.new_from_name(cursor, null));
    }

    // Annotations live on the image: points on the dark margin are pulled in.
    clamp([x, y]) {
        return [Math.max(0, Math.min(this.W, x)), Math.max(0, Math.min(this.H, y))];
    }

    makeItem(a, b) {
        const [x1, y1] = this.clamp(a), [x2, y2] = this.clamp(b);
        return {type: this.tool, color: this.color, x1, y1, x2, y2};
    }

    click(p, widgetPoint) {
        if (this.tool !== 'picker')
            p = this.clamp(p);
        if (this.tool === 'step') {
            const n = this.items.filter(i => i.type === 'step').length + 1;
            this.addItem({type: 'step', color: this.color, x1: p[0], y1: p[1], n});
        } else if (this.tool === 'picker') {
            const hex = this.pixelHex(p);
            if (hex) {
                send('TEXT', hex);
                this.toast(`Copied ${hex}`);
            }
        } else if (this.tool === 'text') {
            this.askText(p, widgetPoint);
        }
    }

    askText(p, [wx, wy]) {
        const entry = new Gtk.Entry({placeholder_text: 'Text, then Enter', width_chars: 24});
        const pop = new Gtk.Popover({child: entry});
        pop.set_parent(this.area);
        const rect = new Gdk.Rectangle({x: Math.round(wx), y: Math.round(wy), width: 1, height: 1});
        pop.set_pointing_to(rect);
        entry.connect('activate', () => {
            if (entry.text.trim())
                this.addItem({type: 'text', color: this.color, x1: p[0], y1: p[1], text: entry.text});
            pop.popdown();
            this.area.queue_draw();
        });
        pop.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            pop.unparent();
            return GLib.SOURCE_REMOVE;
        }));
        pop.popup();
        entry.grab_focus();
    }

    addItem(it) {
        this.history.push(this.items.slice());
        this.items.push(it);
    }

    undo() {
        if (this.history.length)
            this.items = this.history.pop();
        this.area.queue_draw();
    }

    // Topmost annotation under p, or -1. The grab margin never drops below
    // ~6 screen pixels, so thin lines stay easy to pick on a zoomed-out view.
    hitTest(p) {
        const tol = Math.max(this.lw * 2, 6 / this.view.s);
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            const a = [it.x1, it.y1], b = [it.x2, it.y2];
            const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
            const w = Math.abs(it.x2 - it.x1), h = Math.abs(it.y2 - it.y1);
            const inBox = (bx, by, bw, bh) => p[0] >= bx - tol && p[0] <= bx + bw + tol && p[1] >= by - tol && p[1] <= by + bh + tol;
            let hit = false;
            switch (it.type) {
            case 'arrow':
            case 'ruler':
                hit = segDist(p, a, b) <= tol;
                break;
            case 'pen':
                hit = it.pts.some((q, j) => segDist(p, it.pts[Math.max(0, j - 1)], q) <= tol);
                break;
            case 'rect':
                hit = inBox(x, y, w, h) && !(p[0] > x + tol && p[0] < x + w - tol && p[1] > y + tol && p[1] < y + h - tol);
                break;
            case 'highlight':
            case 'blur':
                hit = inBox(x, y, w, h);
                break;
            case 'step':
                hit = Math.hypot(p[0] - it.x1, p[1] - it.y1) <= this.lw * 4 + tol;
                break;
            case 'text':
                hit = it.size && inBox(it.x1, it.y1, ...it.size);
                break;
            }
            if (hit)
                return i;
        }
        return -1;
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

    pixelHex([x, y]) {
        x = Math.floor(x);
        y = Math.floor(y);
        if (x < 0 || y < 0 || x >= this.W || y >= this.H)
            return null;
        const o = y * this.stride + x * this.channels;
        return `#${[0, 1, 2].map(i => this.pixels[o + i].toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    }

    updateStatus(p) {
        const parts = [`${this.W} × ${this.H}`];
        if (p) {
            const hex = this.pixelHex(p);
            if (hex)
                parts.push(`x ${Math.floor(p[0])}  y ${Math.floor(p[1])}`, hex);
        }
        parts.push(`${TOOLS.find(t => t.id === this.tool).name} · 1–8 color · Ctrl+C copy · Ctrl+S save · Esc close`);
        this.status.label = parts.join('   ');
    }

    toast(title) {
        this.toasts.add_toast(new Adw.Toast({title, timeout: 1}));
    }

    // ── rendering ──────────────────────────────────────────────────────

    pixelate(it) {
        const x = Math.max(0, Math.floor(Math.min(it.x1, it.x2)));
        const y = Math.max(0, Math.floor(Math.min(it.y1, it.y2)));
        const w = Math.min(this.W - x, Math.ceil(Math.abs(it.x2 - it.x1)));
        const h = Math.min(this.H - y, Math.ceil(Math.abs(it.y2 - it.y1)));
        if (w < 2 || h < 2)
            return null;
        const block = Math.max(6, this.lw * 3);
        const small = this.pixbuf.new_subpixbuf(x, y, w, h)
            .scale_simple(Math.max(1, Math.round(w / block)), Math.max(1, Math.round(h / block)), GdkPixbuf.InterpType.BILINEAR);
        it.px = x;
        it.py = y;
        return small.scale_simple(w, h, GdkPixbuf.InterpType.NEAREST);
    }

    draw(cr, w, h) {
        const sf = this.area.get_scale_factor();
        const s = Math.min((w - 32) / this.W, (h - 32) / this.H, 1 / sf);
        const ox = Math.round((w - this.W * s) / 2), oy = Math.round((h - this.H * s) / 2);
        this.view = {s, ox, oy};
        cr.save();
        cr.translate(ox, oy);
        cr.scale(s, s);
        this.render(cr);
        cr.restore();
    }

    render(cr) {
        Gdk.cairo_set_source_pixbuf(cr, this.pixbuf, 0, 0);
        cr.paint();
        for (const it of this.draft ? [...this.items, this.draft] : this.items)
            this.drawItem(cr, it);
    }

    drawItem(cr, it) {
        const lw = this.lw;
        const [r, g, b] = rgb(it.color);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        const x = Math.min(it.x1, it.x2 ?? it.x1), y = Math.min(it.y1, it.y2 ?? it.y1);
        const w = Math.abs((it.x2 ?? it.x1) - it.x1), h = Math.abs((it.y2 ?? it.y1) - it.y1);
        switch (it.type) {
        case 'arrow': {
            const ang = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
            const head = lw * 4.5;
            const bx = it.x2 - Math.cos(ang) * head * 0.8, by = it.y2 - Math.sin(ang) * head * 0.8;
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(lw);
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
        case 'rect':
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(lw);
            cr.rectangle(x, y, w, h);
            cr.stroke();
            break;
        case 'pen':
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(lw);
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
        case 'blur':
            if (it.pixbuf) {
                Gdk.cairo_set_source_pixbuf(cr, it.pixbuf, it.px, it.py);
                cr.paint();
            } else {
                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.5);
                cr.rectangle(x, y, w, h);
                cr.fill();
            }
            break;
        case 'text': {
            const fs = lw * 6;
            const layout = PangoCairo.create_layout(cr);
            const font = Pango.FontDescription.from_string('Sans Bold');
            font.set_absolute_size(fs * Pango.SCALE);
            layout.set_font_description(font);
            layout.set_text(it.text, -1);
            it.size = layout.get_pixel_size();
            cr.moveTo(it.x1, it.y1);
            PangoCairo.layout_path(cr, layout);
            const light = r * 0.3 + g * 0.59 + b * 0.11 > 0.6;
            cr.setSourceRGBA(light ? 0 : 1, light ? 0 : 1, light ? 0 : 1, 0.9);
            cr.setLineWidth(lw * 0.9);
            cr.strokePreserve();
            cr.setSourceRGBA(r, g, b, 1);
            cr.fill();
            break;
        }
        case 'step': {
            const rad = lw * 4;
            cr.arc(it.x1, it.y1, rad, 0, 2 * Math.PI);
            cr.setSourceRGBA(r, g, b, 1);
            cr.fill();
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(rad * 1.2);
            const ext = cr.textExtents(String(it.n));
            const light = r * 0.3 + g * 0.59 + b * 0.11 > 0.6;
            cr.setSourceRGBA(light ? 0 : 1, light ? 0 : 1, light ? 0 : 1, 1);
            cr.moveTo(it.x1 - ext.width / 2 - ext.xBearing, it.y1 - ext.height / 2 - ext.yBearing);
            cr.showText(String(it.n));
            break;
        }
        case 'ruler': {
            const dx = it.x2 - it.x1, dy = it.y2 - it.y1;
            const len = Math.hypot(dx, dy);
            const ang = Math.atan2(dy, dx), nx = -Math.sin(ang) * lw * 2, ny = Math.cos(ang) * lw * 2;
            cr.setSourceRGBA(r, g, b, 1);
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
            cr.rectangle(mx - ext.width / 2 - fs * 0.4, my - fs * 0.9, ext.width + fs * 0.8, fs * 1.3);
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(mx - ext.width / 2, my);
            cr.showText(label);
            break;
        }
        }
    }

    // ── output ─────────────────────────────────────────────────────────

    exportTo(path) {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, this.W, this.H);
        const cr = new Cairo.Context(surface);
        this.render(cr);
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
    new Editor(app, path);
});
app.run([]);
