import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = ['left', 'center', 'right'];
const FORMAT = 'moni-settings';
const REPO = 'https://github.com/ingjae/moni';
const OCR_PACKAGES = ['tesseract-ocr', 'tesseract-ocr-eng', 'tesseract-ocr-kor', 'zbar-tools'];
const ocrInstalled = () => ['tesseract', 'zbarimg'].every(p => GLib.find_program_in_path(p));

// Every schema key as plain JSON, so the file is readable and diffable.
function exportSettings(settings) {
    const keys = {};
    for (const key of settings.settings_schema.list_keys().sort())
        keys[key] = settings.get_value(key).recursiveUnpack();
    return JSON.stringify({format: FORMAT, version: 1, exported: new Date().toISOString(), keys}, null, 2);
}

// Applies known keys with the right type; returns [applied, skipped].
function importSettings(settings, text) {
    const data = JSON.parse(text);
    if (data?.format !== FORMAT || typeof data.keys !== 'object')
        throw new Error('not a Moni settings file');
    const schema = settings.settings_schema;
    let applied = 0, skipped = 0;
    for (const [key, value] of Object.entries(data.keys)) {
        if (!schema.has_key(key)) {
            skipped++;
            continue;
        }
        // GLib.Variant would silently coerce ('wide' → 0), so check first.
        const type = schema.get_key(key).get_value_type().dup_string();
        const valid = {
            b: typeof value === 'boolean',
            i: Number.isInteger(value),
            x: Number.isInteger(value),
            s: typeof value === 'string',
            as: Array.isArray(value) && value.every(v => typeof v === 'string'),
        }[type];
        if (!valid) {
            skipped++;
            continue;
        }
        settings.set_value(key, new GLib.Variant(type, value));
        applied++;
    }
    return [applied, skipped];
}

// Widgets limited to libadwaita 1.1 so the same file runs on Ubuntu 22.04.
export default class MoniPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'Moni', icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        // Adw parses titles as Pango markup: '&' and '<Super>' must be escaped.
        const esc = t => GLib.markup_escape_text(t, -1);
        const group = (title, description = '') => {
            const g = new Adw.PreferencesGroup({title: esc(title), description: esc(description)});
            page.add(g);
            return g;
        };
        const row = (g, title, subtitle, widget) => {
            const r = new Adw.ActionRow({title: esc(title), subtitle: esc(subtitle)});
            widget.valign = Gtk.Align.CENTER;
            r.add_suffix(widget);
            r.activatable_widget = widget;
            g.add(r);
            return r;
        };
        const toggle = (g, key, title, subtitle = '') => {
            const sw = new Gtk.Switch();
            settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
            row(g, title, subtitle, sw);
        };
        const spin = (g, key, title, subtitle, min, max, step) => {
            const sb = Gtk.SpinButton.new_with_range(min, max, step);
            settings.bind(key, sb, 'value', Gio.SettingsBindFlags.DEFAULT);
            row(g, title, subtitle, sb);
        };

        const panel = group('Top bar', 'What to draw in the panel');
        toggle(panel, 'show-cpu', 'CPU');
        toggle(panel, 'show-ram', 'Memory');
        toggle(panel, 'show-gpu', 'GPU', 'NVIDIA, AMD or Jetson. Hidden when none is found');
        toggle(panel, 'show-net', 'Network throughput');
        toggle(panel, 'show-disk', 'Disk usage', 'Root filesystem');
        toggle(panel, 'show-ip', 'IP address', 'Address of the default-route interface');
        toggle(panel, 'show-text', 'Numbers next to graphs');

        const robo = group('Robotics', 'Badges only appear while there is something to show');
        toggle(robo, 'show-ros', 'ROS 2 node radar', 'Finds processes with librcl.so loaded — never joins DDS');
        toggle(robo, 'show-rosbag', 'rosbag recording', 'BAG badge with write rate and time until the disk is full');
        toggle(robo, 'show-can', 'CAN bus', 'can*/vcan* state, frame rate and error counters');
        toggle(robo, 'show-devices', 'Sensor devices', 'ttyUSB/ttyACM serial, cameras, gamepads');
        toggle(robo, 'notify-devices', 'Notify on plug / unplug');
        toggle(robo, 'show-pm2', 'PM2 processes', 'Apps in ~/.pm2: status, CPU, memory, restarts — no pm2 CLI polling');
        toggle(robo, 'notify-pm2', 'Notify on PM2 crash', 'When an app exits non-zero or ends up errored');
        toggle(robo, 'show-docker', 'Docker containers', 'Running containers, CPU, memory, health — via the Engine socket, no docker CLI');
        toggle(robo, 'notify-docker', 'Notify on container trouble', 'Non-zero exit, restart loop or unhealthy');

        const net = group('Internet check');
        toggle(net, 'internet-probe', 'Measure latency', 'TCP connect to the host below every 10 s');
        const entry = new Gtk.Entry({width_chars: 16});
        settings.bind('probe-host', entry, 'text', Gio.SettingsBindFlags.DEFAULT);
        row(net, 'Probe host', 'Port 443', entry);

        const capture = group('Screenshot & recording',
            'Drag an area (click = whole screen) → annotate, copy, save or pin. While selecting: Space window, ' +
            'Enter last area, S scrolling capture, 3 / 5 timer. Recordings go to ~/Videos/Screencasts. ' +
            'Accelerator syntax, e.g. <Super><Shift>s. Empty disables. Print still opens GNOME\'s own tool.');
        const accel = (key, title, g = capture) => {
            const e = new Gtk.Entry({width_chars: 18, text: settings.get_strv(key)[0] ?? ''});
            settings.connect(`changed::${key}`, () => {
                const v = settings.get_strv(key)[0] ?? '';
                if (e.text.trim() !== v)
                    e.text = v;
            });
            e.connect('changed', () => {
                const text = e.text.trim();
                const ok = text === '' || Gtk.accelerator_parse(text)[0];
                e[ok ? 'remove_css_class' : 'add_css_class']('error');
                if (ok)
                    settings.set_strv(key, text ? [text] : []);
            });
            row(g, title, '', e);
        };
        accel('screenshot-shortcut', 'Screenshot');
        accel('record-shortcut', 'Start / stop recording');
        toggle(capture, 'record-cursor', 'Show pointer in recordings');
        this._ocrRow(window, settings, capture, row);

        const clip = group('Clipboard history',
            'Super+Shift+V or the 📋 icon: type to search, Enter or click to paste, ★ to keep an item. ' +
            'Recent items live in memory only; ★ favorites are saved. Password-manager copies are skipped.');
        toggle(clip, 'show-clipboard', 'Clipboard history');
        accel('clipboard-shortcut', 'Open history', clip);
        toggle(clip, 'clipboard-paste', 'Paste on pick', 'Off: only copies the item back to the clipboard');
        spin(clip, 'clipboard-size', 'Recent items', 'Kept until logout', 10, 200, 10);

        const general = group('General');
        spin(general, 'update-interval', 'Update interval', 'Milliseconds', 500, 10000, 250);
        spin(general, 'graph-width', 'Graph width', 'Pixels per panel graph', 20, 120, 4);
        const dd = Gtk.DropDown.new_from_strings(POSITIONS);
        dd.selected = Math.max(0, POSITIONS.indexOf(settings.get_string('panel-position')));
        dd.connect('notify::selected', () => settings.set_string('panel-position', POSITIONS[dd.selected]));
        settings.connect('changed::panel-position', () => {
            dd.selected = Math.max(0, POSITIONS.indexOf(settings.get_string('panel-position')));
        });
        row(general, 'Panel position', '', dd);
        const STYLES = ['color', 'mono'];
        const style = Gtk.DropDown.new_from_strings(['Color', 'Monochrome']);
        style.selected = Math.max(0, STYLES.indexOf(settings.get_string('style')));
        style.connect('notify::selected', () => settings.set_string('style', STYLES[style.selected]));
        settings.connect('changed::style', () => {
            style.selected = Math.max(0, STYLES.indexOf(settings.get_string('style')));
        });
        row(general, 'Style', 'Apple system colors, or grays only', style);

        const updates = group('Updates', 'New releases come from github.com/ingjae/moni and are checked against their SHA-256 digest.');
        toggle(updates, 'update-check', 'Check for updates', 'Once a day; a notification offers the update');
        const auto = new Gtk.Switch();
        settings.bind('update-auto', auto, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('update-check', auto, 'sensitive', Gio.SettingsBindFlags.GET);
        row(updates, 'Install automatically', 'Applies after a Shell restart or the next login', auto);
        this._checkRow(window, updates, row);

        const backup = group('Backup', 'Move your Moni setup — toggles, shortcuts and ★ clipboard favorites — to another machine.');
        const choose = (title, action, onFile) => {
            const dlg = new Gtk.FileChooserNative({title, action, transient_for: window, modal: true});
            const filter = new Gtk.FileFilter({name: 'Moni settings (JSON)'});
            filter.add_pattern('*.json');
            dlg.add_filter(filter);
            if (action === Gtk.FileChooserAction.SAVE)
                dlg.set_current_name('moni-settings.json');
            dlg.connect('response', (_d, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    try {
                        onFile(dlg.get_file());
                    } catch (e) {
                        window.add_toast(new Adw.Toast({title: `Failed: ${e.message}`}));
                    }
                }
                window._dialog = null;
            });
            window._dialog = dlg; // keep it alive until it answers
            dlg.show();
        };
        const button = (label, onClick) => {
            const b = new Gtk.Button({label});
            b.connect('clicked', onClick);
            return b;
        };
        row(backup, 'Export settings', 'Save every setting to a JSON file', button('Export…', () =>
            choose('Export Moni settings', Gtk.FileChooserAction.SAVE, file => {
                file.replace_contents(new TextEncoder().encode(exportSettings(settings)), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                window.add_toast(new Adw.Toast({title: `Exported to ${file.get_basename()}`}));
            })));
        row(backup, 'Import settings', 'Apply a file exported from Moni', button('Import…', () =>
            choose('Import Moni settings', Gtk.FileChooserAction.OPEN, file => {
                const [, bytes] = file.load_contents(null);
                const [applied, skipped] = importSettings(settings, new TextDecoder().decode(bytes));
                window.add_toast(new Adw.Toast({
                    title: `Imported ${applied} settings${skipped ? ` · ${skipped} skipped` : ''}`,
                }));
            })));

        const about = group('About', 'Bugs, questions and ideas: please open a GitHub issue.');
        const link = (title, subtitle, label, uri) =>
            row(about, title, subtitle, new Gtk.LinkButton({label, uri}));
        row(about, 'Version', '', new Gtk.Label({label: this.metadata['version-name'], selectable: true}));
        link('GitHub', 'Source code, releases and docs', 'github.com/ingjae/moni', REPO);
        link('Report an issue', 'Bugs, questions, feature requests', 'Open issue', `${REPO}/issues/new`);
    }

    // Check now, then Update when a release is waiting. Runs helper.js, the
    // same download and SHA-256 check the Shell uses.
    _checkRow(window, g, row) {
        const version = this.metadata['version-name'];
        const button = new Gtk.Button({label: 'Check now'});
        const r = row(g, 'Check for updates now', `Installed: ${version}`, button);
        const helper = args => new Promise((resolve, reject) => {
            const proc = Gio.Subprocess.new(['gjs', '-m', `${this.path}/helper.js`, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        throw new Error(err.trim().split('\n').pop() || `helper ${args[0]} failed`);
                    resolve(out.trim());
                } catch (e) {
                    reject(e);
                }
            });
        });
        let found = null;
        button.connect('clicked', async () => {
            button.sensitive = false;
            try {
                if (!found) {
                    r.subtitle = 'Checking…';
                    const out = await helper(['latest', version, String(this.metadata['shell-version'][0])]);
                    found = out ? JSON.parse(out) : null;
                    r.subtitle = found ? `Moni ${found.version} is available · installed: ${version}` : `Up to date (${version})`;
                    button.label = found ? 'Update' : 'Check now';
                } else {
                    r.subtitle = `Installing ${found.version}…`;
                    await helper(['install', found.url, found.sha256]);
                    r.subtitle = GLib.getenv('XDG_SESSION_TYPE') === 'wayland'
                        ? `Moni ${found.version} installed · log out and back in to apply`
                        : `Moni ${found.version} installed · restart GNOME Shell (Alt+F2, r) to apply`;
                    button.visible = false;
                }
            } catch (e) {
                r.subtitle = GLib.markup_escape_text(`Failed: ${e.message}`, -1);
            } finally {
                button.sensitive = true;
            }
        });
    }

    // OCR needs tesseract and zbar. Turning the switch on installs them
    // through apt with the desktop's own password prompt (pkexec).
    _ocrRow(window, settings, g, row) {
        const sw = new Gtk.Switch({active: settings.get_boolean('ocr')});
        const info = 'Selector T: copy text from an area · editor: OCR button and QR links';
        const r = row(g, 'Text recognition (OCR) and QR codes', info, sw);
        const command = `sudo apt install ${OCR_PACKAGES.join(' ')}`;
        const fail = msg => {
            sw.active = false;
            r.subtitle = GLib.markup_escape_text(`${msg} — or run: ${command}`, -1);
        };
        sw.connect('notify::active', () => {
            if (sw.active === settings.get_boolean('ocr'))
                return;
            if (!sw.active || ocrInstalled()) {
                settings.set_boolean('ocr', sw.active);
                r.subtitle = info;
                return;
            }
            if (!GLib.find_program_in_path('pkexec') || !GLib.find_program_in_path('apt-get')) {
                fail('Install tesseract and zbar first');
                return;
            }
            sw.sensitive = false;
            r.subtitle = 'Installing tesseract (English, Korean) and zbar… approve the password prompt';
            try {
                const proc = Gio.Subprocess.new(['pkexec', 'env', 'DEBIAN_FRONTEND=noninteractive',
                    'apt-get', 'install', '-y', ...OCR_PACKAGES], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.wait_async(null, () => {
                    sw.sensitive = true;
                    if (proc.get_successful() && ocrInstalled()) {
                        settings.set_boolean('ocr', true);
                        r.subtitle = info;
                        window.add_toast(new Adw.Toast({title: 'OCR installed'}));
                    } else {
                        fail('Install cancelled or failed');
                    }
                });
            } catch (e) {
                sw.sensitive = true;
                fail(e.message);
            }
        });
    }
}
