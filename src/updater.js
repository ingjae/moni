// Release updates from github.com/ingjae/moni. Network and install run in
// helper.js so the Shell never blocks; this side schedules and notifies.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const DAY = 24 * 3600;

// One notification with buttons on GNOME 42-48.
function notify(title, body, actions = []) {
    let source, n;
    if (MessageTray.getSystemSource) { // GNOME 46+
        source = MessageTray.getSystemSource();
        n = new MessageTray.Notification({source, title, body});
    } else {
        source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);
        n = new MessageTray.Notification(source, title, body);
    }
    for (const [label, callback] of actions)
        n.addAction(label, callback);
    if (source.addNotification)
        source.addNotification(n);
    else
        source.showNotification(n);
}

export function restartShell() {
    try {
        Meta.restart('Restarting…', global.context);
    } catch (e) {
        Meta.restart('Restarting…');
    }
}

export class Updater {
    constructor(path, metadata, settings, onChange) {
        this._helperPath = `${path}/helper.js`;
        this._version = metadata['version-name'];
        this._major = String(metadata['shell-version'][0]);
        this._settings = settings;
        this._onChange = onChange;
        this.available = null; // {version, page, url, sha256}
        this.installed = false;
        // First look a minute after login, then hourly for a day-old check.
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
            this._maybeCheck();
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3600, () => {
                this._maybeCheck();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._onChange = null;
    }

    _helper(args) {
        return new Promise((resolve, reject) => {
            const proc = Gio.Subprocess.new(['gjs', '-m', this._helperPath, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        throw new Error(err.trim() || `helper ${args[0]} failed`);
                    resolve(out.trim());
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _maybeCheck() {
        const now = Math.floor(Date.now() / 1000);
        if (!this._settings.get_boolean('update-check') || now - this._settings.get_int64('update-last-check') < DAY)
            return;
        this._settings.set_int64('update-last-check', now);
        this.check().catch(e => console.warn(`moni: update check: ${e.message}`));
    }

    async check() {
        const out = await this._helper(['latest', this._version, this._major]);
        if (!out || this.installed)
            return;
        this.available = JSON.parse(out);
        this._onChange?.();
        const v = this.available.version;
        if (this._settings.get_boolean('update-auto')) {
            await this.install();
        } else if (this._settings.get_string('update-notified') !== v) {
            this._settings.set_string('update-notified', v);
            notify(`Moni ${v} is available`, `You have ${this._version}.`, [
                ['Update', () => this.install()],
                ['Release notes', () => Gio.AppInfo.launch_default_for_uri(this.available.page, null)],
            ]);
        }
    }

    async install() {
        const a = this.available;
        if (!a || this._installing || this.installed)
            return;
        this._installing = true;
        try {
            await this._helper(['install', a.url, a.sha256]);
            this.installed = true;
            this._onChange?.();
            if (Meta.is_wayland_compositor())
                notify(`Moni ${a.version} installed`, 'Log out and back in to apply it.');
            else
                notify(`Moni ${a.version} installed`, 'Restart GNOME Shell to apply it. Windows stay open.', [['Restart now', restartShell]]);
        } catch (e) {
            notify('Moni update failed', e.message, [['Release page', () => Gio.AppInfo.launch_default_for_uri(a.page, null)]]);
        } finally {
            this._installing = false;
        }
    }
}
