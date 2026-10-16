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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CACHE = `${GLib.get_user_cache_dir()}/moni`;

function pushModal(actor) {
    const grab = Main.pushModal(actor);
    // GNOME 42-44 returns a boolean and pops by actor; 45+ returns a grab.
    return () => Main.popModal(typeof grab === 'boolean' ? actor : grab);
}

function stamp() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
}

// Full-screen dim layer: drag a rectangle, click for the monitor under the
// pointer, Esc to cancel. Resolves with {x, y, width, height} or null.
function selectArea(hint) {
    return new Promise(resolve => {
        const overlay = new St.Widget({reactive: true, can_focus: true, layout_manager: new Clutter.FixedLayout()});
        overlay.set_position(0, 0);
        overlay.set_size(global.stage.width, global.stage.height);
        const canvas = new St.DrawingArea();
        canvas.set_size(global.stage.width, global.stage.height);
        overlay.add_child(canvas);
        const label = new St.Label({style_class: 'moni-select-hint', text: hint});
        overlay.add_child(label);
        Main.layoutManager.uiGroup.add_child(overlay);
        label.set_position(Math.round((global.stage.width - label.width) / 2), 48);
        const pop = pushModal(overlay);
        overlay.grab_key_focus();
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);

        let start = null, cur = global.get_pointer().slice(0, 2);
        const rect = () => {
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
            if (start) {
                cr.setOperator(0); // CLEAR
                cr.rectangle(r.x, r.y, r.width, r.height);
                cr.fill();
                cr.setOperator(2); // OVER
                cr.setSourceRGBA(0.35, 0.78, 0.98, 1);
                cr.setLineWidth(1.5);
                cr.rectangle(r.x + 0.75, r.y + 0.75, r.width - 1.5, r.height - 1.5);
                cr.stroke();
                const text = `${r.width} × ${r.height}`;
                cr.setFontSize(12);
                const ty = r.y + r.height + 18 < h ? r.y + r.height + 16 : r.y - 6;
                cr.setSourceRGBA(0, 0, 0, 0.75);
                cr.rectangle(r.x, ty - 13, text.length * 7.2 + 10, 18);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.moveTo(r.x + 5, ty);
                cr.showText(text);
            } else {
                // crosshair
                cr.setSourceRGBA(1, 1, 1, 0.55);
                cr.setLineWidth(1);
                cr.moveTo(0, cur[1] + 0.5);
                cr.lineTo(w, cur[1] + 0.5);
                cr.moveTo(cur[0] + 0.5, 0);
                cr.lineTo(cur[0] + 0.5, h);
                cr.stroke();
            }
            cr.$dispose();
        });

        const finish = area => {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            pop();
            overlay.destroy();
            resolve(area);
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
            if (r.width < 4 || r.height < 4) {
                const m = Main.layoutManager.monitors[global.display.get_current_monitor()];
                finish({x: m.x, y: m.y, width: m.width, height: m.height});
            } else {
                finish(r);
            }
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                finish(null);
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

function captureArea(area, path) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot_area(area.x, area.y, area.width, area.height, stream, (shot, res) => {
            try {
                shot.screenshot_area_finish(res);
                stream.close(null);
                resolve(path);
            } catch (e) {
                reject(e);
            }
        });
    });
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
            const area = await selectArea('Drag to capture  ·  click: whole screen  ·  Esc: cancel');
            if (!area)
                return;
            await afterRepaint();
            const path = await captureArea(area, `${CACHE}/shot_${stamp()}.png`);
            this._openEditor(path);
        } catch (e) {
            logError(e, 'moni: screenshot');
            Main.notify('Moni', `Screenshot failed: ${e.message}`);
        } finally {
            this._busy = false;
        }
    }

    _openEditor(path) {
        // The shell sets GDK_BACKEND=x11 for itself; the editor should use
        // whatever the session is (Wayland or X11).
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
        launcher.unsetenv('GDK_BACKEND');
        const proc = launcher.spawnv(['gjs', '-m', `${this._extPath}/editor.js`, path]);
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
            const area = await selectArea('Drag an area to record  ·  click: whole screen  ·  Esc: cancel');
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
