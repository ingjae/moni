// capture.js — screenshots and screen recording, Shottr-style.
//
// Shell side: area selection overlay, pixel capture (Shell.Screenshot),
// recording through GNOME's own screencast service, pinned images, and
// clipboard ownership. The annotation editor is a separate GTK4 process
// (editor.js) that talks back over stdout, one command per line.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CACHE = `${GLib.get_user_cache_dir()}/moni`;
const SCROLL_FRAMES = 40;
const HINTS = {
    shot: ['Drag an area', 'click: screen', 'Space: window', '⏎: last area', 'S: scrolling', 'T: copy text', '3 / 5: timer', 'Esc'],
    window: ['Click a window', 'Space: back to area', 'Esc'],
    scroll: ['Scrolling capture: drag over the part that scrolls', 'Esc'],
    ocr: ['Copy text: drag over the text', 'Esc'],
    record: ['Drag an area to record', 'click: whole screen', 'Esc'],
};

function pushModal(actor) {
    const grab = Main.pushModal(actor);
    // GNOME 42-44 returns a boolean and pops by actor; 45+ returns a grab.
    return () => Main.popModal(typeof grab === 'boolean' ? actor : grab);
}

function stamp() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
}

// Topmost normal window under (x, y) on the active workspace, as a rect.
function windowAt(x, y) {
    const ws = global.workspace_manager.get_active_workspace();
    const actors = global.get_window_actors().filter(a => {
        const w = a.meta_window;
        return a.visible && !w.minimized && w.get_window_type() !== Meta.WindowType.DESKTOP && w.located_on_workspace(ws);
    });
    for (let i = actors.length - 1; i >= 0; i--) {
        const r = actors[i].meta_window.get_frame_rect();
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
            const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
            return {x: x0, y: y0, width: Math.min(global.stage.width, r.x + r.width) - x0,
                height: Math.min(global.stage.height, r.y + r.height) - y0};
        }
    }
    return null;
}

function monitorArea() {
    const m = Main.layoutManager.monitors[global.display.get_current_monitor()];
    return {x: m.x, y: m.y, width: m.width, height: m.height};
}

// Full-screen dim layer with a pixel loupe. Drag a rectangle, click for the
// monitor under the pointer, Esc to cancel. Screenshots also take Space
// (window), Enter (last area), S (scrolling), T (OCR) and 3 / 5 (timer).
// Resolves with {mode, area, delay} or null.
async function selectArea({record = false, last = null, ocr = false} = {}) {
    // Freeze a copy of the screen first, for the loupe.
    let frozen = null, fscale = 1;
    if (!record) {
        try {
            const f = await captureArea(null, `${CACHE}/freeze.png`);
            frozen = Cairo.ImageSurface.createFromPNG(f);
            fscale = frozen.getWidth() / global.stage.width;
        } catch (e) {
            frozen = null;
        }
    }
    return new Promise(resolve => {
        const overlay = new St.Widget({reactive: true, can_focus: true, layout_manager: new Clutter.FixedLayout()});
        overlay.set_position(0, 0);
        overlay.set_size(global.stage.width, global.stage.height);
        const canvas = new St.DrawingArea();
        canvas.set_size(global.stage.width, global.stage.height);
        overlay.add_child(canvas);
        const label = new St.Label({style_class: 'moni-select-hint'});
        overlay.add_child(label);
        Main.layoutManager.uiGroup.add_child(overlay);
        let mode = record ? 'record' : 'shot';
        const setMode = m => {
            mode = m;
            label.text = HINTS[m].filter(h => (ocr || !h.startsWith('T:')) && (last || !h.startsWith('⏎'))).join('   ·   ');
            label.set_position(Math.round((global.stage.width - label.width) / 2), 48);
            canvas.queue_repaint();
        };
        setMode(mode);
        const pop = pushModal(overlay);
        overlay.grab_key_focus();
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);

        let start = null, cur = global.get_pointer().slice(0, 2);
        const rect = () => {
            if (mode === 'window')
                return windowAt(...cur);
            const [x1, y1] = start ?? cur;
            const [x2, y2] = cur;
            return {x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)};
        };
        canvas.connect('repaint', () => {
            const cr = canvas.get_context();
            const [w, h] = canvas.get_surface_size();
            cr.setSourceRGBA(0, 0, 0, 0.38);
            cr.paint();
            const r = rect();
            if ((start || mode === 'window') && r) {
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.rectangle(r.x, r.y, r.width, r.height);
                cr.fill();
                cr.setOperator(Cairo.Operator.OVER);
                cr.setSourceRGBA(0.04, 0.52, 1, 1);
                cr.setLineWidth(mode === 'window' ? 3 : 1.5);
                cr.rectangle(r.x + 0.75, r.y + 0.75, r.width - 1.5, r.height - 1.5);
                cr.stroke();
                const text = `${r.width} × ${r.height}`;
                cr.setFontSize(12);
                const ty = r.y + r.height + 22 < h ? r.y + r.height + 18 : r.y + 18;
                cr.setSourceRGBA(0, 0, 0, 0.75);
                cr.rectangle(r.x, ty - 13, text.length * 7.2 + 10, 18);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.moveTo(r.x + 5, ty);
                cr.showText(text);
            } else if (mode !== 'window') {
                cr.setSourceRGBA(1, 1, 1, 0.55);
                cr.setLineWidth(1);
                cr.moveTo(0, cur[1] + 0.5);
                cr.lineTo(w, cur[1] + 0.5);
                cr.moveTo(cur[0] + 0.5, 0);
                cr.lineTo(cur[0] + 0.5, h);
                cr.stroke();
            }
            if (frozen && mode !== 'window')
                drawLoupe(cr, w, h);
            cr.$dispose();
        });

        // 8x view of the frozen screen around the pointer, centre pixel boxed.
        const drawLoupe = (cr, w, h) => {
            const R = 64, Z = 8, gap = 22;
            let lx = cur[0] + gap, ly = cur[1] + gap;
            if (lx + 2 * R > w)
                lx = cur[0] - gap - 2 * R;
            if (ly + 2 * R + 24 > h)
                ly = cur[1] - gap - 2 * R - 24;
            const cx = lx + R, cy = ly + R;
            const px = Math.floor(cur[0] * fscale), py = Math.floor(cur[1] * fscale);
            cr.save();
            cr.arc(cx, cy, R, 0, 2 * Math.PI);
            cr.clip();
            cr.translate(cx - Z / 2, cy - Z / 2);
            cr.scale(Z, Z);
            cr.translate(-px, -py);
            cr.setSourceSurface(frozen, 0, 0);
            cr.getSource().setFilter(Cairo.Filter.NEAREST);
            cr.paint();
            cr.restore();
            cr.setLineWidth(1);
            cr.setSourceRGBA(0, 0, 0, 0.8);
            cr.rectangle(cx - Z / 2 - 0.5, cy - Z / 2 - 0.5, Z + 1, Z + 1);
            cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.rectangle(cx - Z / 2 - 1.5, cy - Z / 2 - 1.5, Z + 3, Z + 3);
            cr.stroke();
            cr.setLineWidth(2);
            cr.arc(cx, cy, R, 0, 2 * Math.PI);
            cr.stroke();
            const text = `${Math.round(cur[0])}, ${Math.round(cur[1])}`;
            cr.setFontSize(11);
            const tw = text.length * 6.6 + 12;
            cr.setSourceRGBA(0, 0, 0, 0.75);
            cr.rectangle(cx - tw / 2, ly + 2 * R + 6, tw, 17);
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(cx - tw / 2 + 6, ly + 2 * R + 18);
            cr.showText(text);
        };

        const finish = result => {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            pop();
            overlay.destroy();
            frozen = null;
            resolve(result);
        };
        overlay.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== 1) {
                finish(null);
                return Clutter.EVENT_STOP;
            }
            start = event.get_coords().map(Math.round);
            cur = start;
            return Clutter.EVENT_STOP;
        });
        overlay.connect('motion-event', (_a, event) => {
            cur = event.get_coords().map(Math.round);
            canvas.queue_repaint();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('button-release-event', () => {
            if (!start)
                return Clutter.EVENT_STOP;
            const r = rect();
            if (mode === 'window')
                finish(r ? {mode: 'shot', area: r} : null);
            else if (r.width < 4 || r.height < 4)
                finish({mode, area: monitorArea()});
            else
                finish({mode, area: r});
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            const ch = (event.get_key_unicode() ?? '').toLowerCase();
            if (sym === Clutter.KEY_Escape)
                finish(null);
            else if (record || start)
                return Clutter.EVENT_STOP;
            else if (sym === Clutter.KEY_space)
                setMode(mode === 'window' ? 'shot' : 'window');
            else if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && last)
                finish({mode: 'shot', area: last});
            else if (ch === 's')
                setMode('scroll');
            else if (ch === 't' && ocr)
                setMode('ocr');
            else if (ch === '3' || ch === '5')
                finish({mode: 'timer', delay: Number(ch)});
            return Clutter.EVENT_STOP;
        });
    });
}

// Wait until the overlay is gone from the screen before grabbing pixels.
function afterRepaint(ms = 120) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// area null: the whole stage.
function captureArea(area, path) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        const done = (s, res) => {
            try {
                if (area)
                    s.screenshot_area_finish(res);
                else
                    s.screenshot_finish(res);
                stream.close(null);
                resolve(path);
            } catch (e) {
                reject(e);
            }
        };
        if (area)
            shot.screenshot_area(area.x, area.y, area.width, area.height, stream, done);
        else
            shot.screenshot(false, stream, done);
    });
}

// Big centred 3‥2‥1 before a timed capture.
async function countdown(seconds) {
    const label = new St.Label({style_class: 'moni-countdown'});
    Main.layoutManager.addChrome(label);
    for (let n = seconds; n > 0; n--) {
        label.text = String(n);
        label.set_position(Math.round((global.stage.width - label.width) / 2), Math.round((global.stage.height - label.height) / 2));
        await afterRepaint(1000);
    }
    label.destroy();
}

export function copyImageToClipboard(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (ok)
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
}

// A captured image floating above all windows. Drag to move,
// scroll to resize, double-click or right-click to close.
function pinImage(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        return;
    const w0 = bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19];
    const h0 = bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23];
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    let zoom = Math.min(1, 520 * scale / w0);
    const pin = new St.Widget({reactive: true, style_class: 'moni-pin'});
    const resize = () => {
        pin.set_size(Math.round(w0 * zoom), Math.round(h0 * zoom));
        pin.set_style(`background-image: url("file://${path}"); background-size: ${Math.round(w0 * zoom)}px ${Math.round(h0 * zoom)}px;`);
    };
    resize();
    const [px, py] = global.get_pointer();
    pin.set_position(Math.max(0, px - pin.width / 2), Math.max(0, py - pin.height / 2));
    Main.layoutManager.addChrome(pin);

    let drag = null;
    pin.connect('button-press-event', (_a, event) => {
        if (event.get_button() === 3 || event.get_click_count() === 2) {
            pin.destroy();
            return Clutter.EVENT_STOP;
        }
        const [x, y] = event.get_coords();
        drag = [x - pin.x, y - pin.y];
        return Clutter.EVENT_STOP;
    });
    pin.connect('motion-event', (_a, event) => {
        if (drag) {
            const [x, y] = event.get_coords();
            pin.set_position(Math.round(x - drag[0]), Math.round(y - drag[1]));
        }
        return Clutter.EVENT_STOP;
    });
    pin.connect('button-release-event', () => {
        drag = null;
        return Clutter.EVENT_STOP;
    });
    pin.connect('scroll-event', (_a, event) => {
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP)
            zoom = Math.min(4, zoom * 1.1);
        else if (dir === Clutter.ScrollDirection.DOWN)
            zoom = Math.max(0.1, zoom / 1.1);
        resize();
        return Clutter.EVENT_STOP;
    });
}

export class Capture {
    constructor(extPath, settings, onRecordingChanged) {
        this._extPath = extPath;
        this._settings = settings;
        this._onRecordingChanged = onRecordingChanged;
        this._busy = false;
        this._recording = null;
        this._editors = new Set();
        GLib.mkdir_with_parents(CACHE, 0o700);
    }

    get recording() {
        return this._recording;
    }

    async screenshot() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const sel = await selectArea({last: this._lastArea, ocr: this._ocrEnabled()});
            if (!sel)
                return;
            if (sel.mode === 'timer')
                await countdown(sel.delay);
            const area = sel.area ?? monitorArea();
            this._lastArea = area;
            await afterRepaint();
            if (sel.mode === 'scroll') {
                await this._scrollCapture(area);
                return;
            }
            const path = await captureArea(area, `${CACHE}/shot_${stamp()}.png`);
            if (sel.mode === 'ocr')
                await this._ocr(path);
            else
                this._openEditor(path);
        } catch (e) {
            logError(e, 'moni: screenshot');
            Main.notify('Moni', `Screenshot failed: ${e.message}`);
        } finally {
            this._busy = false;
        }
    }

    _ocrEnabled() {
        return this._settings.get_boolean('ocr') && !!GLib.find_program_in_path('tesseract');
    }

    _helper(args) {
        return new Promise((resolve, reject) => {
            const proc = Gio.Subprocess.new(['gjs', '-m', `${this._extPath}/helper.js`, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        throw new Error(err.trim() || `helper ${args[0]} failed`);
                    resolve(out);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _ocr(path) {
        const text = (await this._helper(['ocr', path])).trim();
        GLib.unlink(path);
        if (!text) {
            Main.notify('Moni', 'No text found in that area');
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        Main.notify(`Copied ${text.length} characters`, text.length > 120 ? `${text.slice(0, 120)}…` : text);
    }

    // Scroll the window under the area with a virtual mouse wheel, grabbing
    // a frame after each step until the page stops moving, Stop is pressed
    // or SCROLL_FRAMES is reached; then stitch the frames in the helper.
    async _scrollCapture(area) {
        const seat = Clutter.get_default_backend().get_default_seat();
        const dev = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const now = () => GLib.get_monotonic_time();
        const [px, py] = global.get_pointer();
        dev.notify_absolute_motion(now(), area.x + area.width / 2, area.y + area.height / 2);

        let stopped = false;
        const stop = new St.Button({label: 'Stop scrolling capture', style_class: 'moni-select-hint moni-stop', reactive: true});
        stop.connect('clicked', () => (stopped = true));
        Main.layoutManager.addChrome(stop);
        const below = area.y + area.height + 56 < global.stage.height;
        stop.set_position(Math.round(area.x + (area.width - stop.width) / 2),
            below ? area.y + area.height + 12 : Math.max(8, area.y - stop.height - 12));

        const id = stamp(), frames = [];
        const clicks = Math.max(1, Math.floor(area.height / 250));
        let prev = null;
        try {
            for (let i = 0; i < SCROLL_FRAMES && !stopped; i++) {
                await afterRepaint(i ? 350 : 80);
                const f = await captureArea(area, `${CACHE}/scroll_${id}_${String(i).padStart(2, '0')}.png`);
                const sum = GLib.compute_checksum_for_data(GLib.ChecksumType.MD5, GLib.file_get_contents(f)[1]);
                if (sum === prev) {
                    GLib.unlink(f);
                    break;
                }
                prev = sum;
                frames.push(f);
                for (let c = 0; c < clicks; c++)
                    dev.notify_discrete_scroll(now(), Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
            }
        } finally {
            stop.destroy();
            dev.notify_absolute_motion(now(), px, py);
        }
        if (frames.length === 1) {
            this._openEditor(frames[0]);
            return;
        }
        const out = `${CACHE}/shot_${id}_scroll.png`;
        try {
            await this._helper(['stitch', out, ...frames]);
        } finally {
            frames.forEach(f => GLib.unlink(f));
        }
        this._openEditor(out);
    }

    _openEditor(path) {
        // The shell sets GDK_BACKEND=x11 for itself; the editor should use
        // whatever the session is (Wayland or X11).
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
        launcher.unsetenv('GDK_BACKEND');
        const proc = launcher.spawnv(['gjs', '-m', `${this._extPath}/editor.js`, path, ...(this._ocrEnabled() ? ['--ocr'] : [])]);
        this._editors.add(proc);
        const out = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const readLine = () => out.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                line = null;
            }
            if (line === null) {
                this._editors.delete(proc);
                return;
            }
            this._onEditorCommand(line);
            readLine();
        });
        readLine();
    }

    _onEditorCommand(line) {
        const i = line.indexOf(' ');
        const cmd = line.slice(0, i), arg = line.slice(i + 1);
        if (cmd === 'COPY')
            copyImageToClipboard(arg);
        else if (cmd === 'TEXT')
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, arg);
        else if (cmd === 'TEXTJ')
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, JSON.parse(arg));
        else if (cmd === 'PIN')
            pinImage(arg);
        else if (cmd === 'SAVED')
            Main.notify('Screenshot saved', arg);
    }

    // ── recording ──────────────────────────────────────────────────────
    // GNOME's screencast service only accepts calls from the shell's own
    // bus connection — which is exactly where an extension runs.

    async toggleRecording() {
        if (this._recording) {
            this.stopRecording();
            return;
        }
        if (this._busy)
            return;
        this._busy = true;
        try {
            const area = (await selectArea({record: true}))?.area;
            if (!area)
                return;
            await afterRepaint();
            const dir = `${GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir()}/Screencasts`;
            GLib.mkdir_with_parents(dir, 0o755);
            const options = {
                'draw-cursor': new GLib.Variant('b', this._settings.get_boolean('record-cursor')),
                'framerate': new GLib.Variant('i', 30),
            };
            const [ok, file] = await this._call('ScreencastArea', new GLib.Variant('(iiiisa{sv})',
                [area.x, area.y, area.width, area.height, `${dir}/Moni_${stamp()}`, options]), '(bs)');
            if (!ok)
                throw new Error('the screencast service refused to start');
            this._recording = {file, start: GLib.get_monotonic_time()};
            this._onRecordingChanged();
        } catch (e) {
            logError(e, 'moni: record');
            Main.notify('Moni', `Recording failed: ${e.message}`);
        } finally {
            this._busy = false;
        }
    }

    async stopRecording() {
        const rec = this._recording;
        if (!rec || rec.stopping)
            return;
        rec.stopping = true;
        this._onRecordingChanged();
        try {
            const [ok] = await this._call('StopScreencast', null, '(b)');
            if (!ok)
                throw new Error('the screencast service did not confirm the stop');
            this._recording = null;
            this._onRecordingChanged();
            // GNOME 45+ appends the container extension itself; 42-44 do not.
            let file = rec.file;
            if (!/\.\w+$/.test(file)) {
                Gio.File.new_for_path(file).move(Gio.File.new_for_path(`${file}.webm`), Gio.FileCopyFlags.NONE, null, null);
                file += '.webm';
            }
            Main.notify('Recording saved', file);
        } catch (e) {
            rec.stopping = false;
            this._onRecordingChanged();
            logError(e, 'moni: stop recording');
            Main.notify('Recording could not be finalized', `Check recording status before retrying: ${e.message}`);
        }
    }

    _call(method, params, replyType) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call('org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast',
                'org.gnome.Shell.Screencast', method, params, new GLib.VariantType(replyType),
                Gio.DBusCallFlags.NONE, 10000, null, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res).deepUnpack());
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    openGnomeUI() {
        Main.screenshotUI?.open();
    }

    destroy() {
        if (this._recording)
            this.stopRecording();
        for (const p of this._editors)
            p.force_exit();
        this._editors.clear();
    }
}
