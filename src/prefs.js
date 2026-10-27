import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = ['left', 'center', 'right'];
const FORMAT = 'moni-settings';
const REPO = 'https://github.com/ingjae/moni';
const OCR_PACKAGES = ['tesseract-ocr', 'tesseract-ocr-eng', 'tesseract-ocr-kor', 'zbar-tools'];
// Images picked for quick copy buttons are copied here, so moving or
// deleting the original does not break the button.
const QUICK_ICONS = GLib.build_filenamev([GLib.get_user_data_dir(), 'moni', 'quick-icons']);
const dropQuickIcon = path => path?.startsWith(`${QUICK_ICONS}/`) && GLib.unlink(path);
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

        const quick = group('Quick copy',
            'One-click buttons in the top bar for a token, an address or a command. ' +
            'Not kept in clipboard history; stored as plain text in dconf and included in Export.');
        toggle(quick, 'show-quick', 'Quick copy buttons', 'Shown while at least one item exists');
        const ACTIONS = ['both', 'copy', 'paste'];
        const action = Gtk.DropDown.new_from_strings(['Copy and paste', 'Copy only', 'Paste only']);
        action.selected = Math.max(0, ACTIONS.indexOf(settings.get_string('quick-action')));
        action.connect('notify::selected', () => settings.set_string('quick-action', ACTIONS[action.selected]));
        row(quick, 'On click', 'Paste types it at the cursor; Paste only restores your clipboard', action);
        this._quickItems(window, settings, quick);

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
        // The prefs process gets metadata over D-Bus, which drops arrays such
        // as shell-version, so read it from the installed metadata.json.
        const shellMajor = () => {
            const [, bytes] = GLib.file_get_contents(`${this.path}/metadata.json`);
            return String(JSON.parse(new TextDecoder().decode(bytes))['shell-version'][0]);
        };
        let found = null;
        button.connect('clicked', async () => {
            button.sensitive = false;
            try {
                if (!found) {
                    r.subtitle = 'Checking…';
                    const out = await helper(['latest', version, shellMajor()]);
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

    // Item rows with Edit / Delete, then an Add row; edits open a small dialog.
    _quickItems(window, settings, g) {
        const load = () => {
            try {
                const items = JSON.parse(settings.get_string('quick-items'));
                return Array.isArray(items) ? items : [];
            } catch (e) {
                return [];
            }
        };
        const store = items => settings.set_string('quick-items', JSON.stringify(items));
        const iconButton = (icon, tooltip, onClick) => {
            const b = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER});
            b.add_css_class('flat');
            b.connect('clicked', onClick);
            return b;
        };
        let rows = [];
        const render = () => {
            rows.forEach(r => g.remove(r));
            rows = load().map((item, i) => {
                // The icon as the top bar shows it, then the text, masked.
                const r = new Adw.ActionRow({title: `•••• ${String(item.text ?? '').length} characters`});
                const tile = item.image
                    ? new Gtk.Image({file: item.image, pixel_size: 20})
                    : new Gtk.Label({label: String(item.icon ?? ''), css_classes: ['heading']});
                tile.width_request = 36;
                r.add_prefix(tile);
                r.add_suffix(iconButton('document-edit-symbolic', 'Edit', () => this._quickDialog(window, item, edited => {
                    const items = load();
                    if (items[i]?.image !== edited.image)
                        dropQuickIcon(items[i]?.image);
                    items[i] = edited;
                    store(items);
                })));
                r.add_suffix(iconButton('user-trash-symbolic', 'Delete', () => {
                    dropQuickIcon(item.image);
                    store(load().filter((_x, k) => k !== i));
                }));
                g.add(r);
                return r;
            });
            const add = new Adw.ActionRow({title: 'Add item'});
            add.add_suffix(iconButton('list-add-symbolic', 'Add', () => this._quickDialog(window, null, item => store([...load(), item]))));
            g.add(add);
            rows.push(add);
        };
        settings.connect('changed::quick-items', render);
        render();
    }

    // Icon: up to a few characters typed in, or an emoji from the picker.
    _quickDialog(window, item, onSave) {
        const dlg = new Gtk.Window({transient_for: window, modal: true, title: item ? 'Edit quick copy' : 'New quick copy', default_width: 460});
        const header = new Gtk.HeaderBar({show_title_buttons: false});
        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: 'Save'});
        save.add_css_class('suggested-action');
        header.pack_start(cancel);
        header.pack_end(save);
        dlg.set_titlebar(header);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
            margin_top: 18, margin_bottom: 18, margin_start: 18, margin_end: 18});
        const heading = text => new Gtk.Label({label: text, xalign: 0, css_classes: ['heading']});
        box.append(heading('Icon'));
        const iconRow = new Gtk.Box({spacing: 6});
        const icon = new Gtk.Entry({max_length: 8, width_chars: 10, placeholder_text: 'GH or 🔑', text: item?.icon ?? ''});
        const chooser = new Gtk.EmojiChooser();
        chooser.connect('emoji-picked', (_c, emoji) => (icon.text = emoji));
        iconRow.append(icon);
        iconRow.append(new Gtk.MenuButton({label: '😀', tooltip_text: 'Pick an emoji', popover: chooser}));
        iconRow.append(new Gtk.Label({label: 'Short text (e.g. GH, IP) or an emoji', css_classes: ['dim-label']}));
        box.append(iconRow);

        // An image replaces the text icon in the top bar.
        let image = item?.image ?? '';
        const imageRow = new Gtk.Box({spacing: 6});
        const preview = new Gtk.Image({pixel_size: 24});
        const pick = new Gtk.Button({label: 'Choose image…'});
        const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', tooltip_text: 'Remove image'});
        const showImage = () => {
            preview.set_from_file(image || null);
            preview.visible = clear.visible = !!image;
        };
        pick.connect('clicked', () => {
            const fc = new Gtk.FileChooserNative({title: 'Choose an image', transient_for: dlg, modal: true});
            const filter = new Gtk.FileFilter({name: 'Images'});
            filter.add_pixbuf_formats();
            fc.add_filter(filter);
            fc.connect('response', (_f, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    image = fc.get_file().get_path();
                    showImage();
                    sync();
                }
                dlg._chooser = null;
            });
            dlg._chooser = fc; // keep it alive until it answers
            fc.show();
        });
        clear.connect('clicked', () => {
            image = '';
            showImage();
            sync();
        });
        imageRow.append(preview);
        imageRow.append(pick);
        imageRow.append(clear);
        imageRow.append(new Gtk.Label({label: 'Or your own image (PNG, SVG, JPG)', css_classes: ['dim-label']}));
        box.append(imageRow);
        showImage();

        box.append(heading('Text to copy'));
        const view = new Gtk.TextView({wrap_mode: Gtk.WrapMode.CHAR, monospace: true,
            top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6});
        view.buffer.text = item?.text ?? '';
        const scroll = new Gtk.ScrolledWindow({child: view, min_content_height: 110, has_frame: true});
        box.append(scroll);
        dlg.set_child(box);

        const text = () => view.buffer.text;
        const sync = () => (save.sensitive = (!!icon.text.trim() || !!image) && !!text());
        icon.connect('changed', sync);
        view.buffer.connect('changed', sync);
        sync();
        // Bring Settings back to the front, or it can end up behind other windows.
        dlg.connect('close-request', () => {
            window.present();
            return false;
        });
        cancel.connect('clicked', () => dlg.close());
        save.connect('clicked', () => {
            let stored = image;
            if (image && image !== item?.image) {
                try {
                    GLib.mkdir_with_parents(QUICK_ICONS, 0o700);
                    const ext = image.match(/\.\w+$/)?.[0] ?? '';
                    stored = GLib.build_filenamev([QUICK_ICONS, `${GLib.uuid_string_random()}${ext}`]);
                    Gio.File.new_for_path(image).copy(Gio.File.new_for_path(stored), Gio.FileCopyFlags.NONE, null, null);
                } catch (e) {
                    window.add_toast(new Adw.Toast({title: `Image not saved: ${e.message}`}));
                    return;
                }
            }
            onSave({icon: icon.text.trim(), image: stored || undefined, text: text()});
            dlg.close();
        });
        dlg.present();
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
