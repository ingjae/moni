import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = ['left', 'center', 'right'];

// Widgets limited to libadwaita 1.1 so the same file runs on Ubuntu 22.04.
export default class MoniPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'Moni', icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        const group = (title, description = '') => {
            const g = new Adw.PreferencesGroup({title, description});
            page.add(g);
            return g;
        };
        const row = (g, title, subtitle, widget) => {
            const r = new Adw.ActionRow({title, subtitle});
            widget.valign = Gtk.Align.CENTER;
            r.add_suffix(widget);
            r.activatable_widget = widget;
            g.add(r);
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

        const net = group('Internet check');
        toggle(net, 'internet-probe', 'Measure latency', 'TCP connect to the host below every 10 s');
        const entry = new Gtk.Entry({width_chars: 16});
        settings.bind('probe-host', entry, 'text', Gio.SettingsBindFlags.DEFAULT);
        row(net, 'Probe host', 'Port 443', entry);

        const capture = group('Screenshot & recording',
            'Drag an area (click = whole screen) → annotate, copy, save or pin. Recordings go to ~/Videos/Screencasts. ' +
            'Accelerator syntax, e.g. <Super><Shift>s. Empty disables. Print still opens GNOME\'s own tool.');
        const accel = (key, title) => {
            const e = new Gtk.Entry({width_chars: 18, text: settings.get_strv(key)[0] ?? ''});
            e.connect('changed', () => {
                const text = e.text.trim();
                const ok = text === '' || Gtk.accelerator_parse(text)[0];
                e[ok ? 'remove_css_class' : 'add_css_class']('error');
                if (ok)
                    settings.set_strv(key, text ? [text] : []);
            });
            row(capture, title, '', e);
        };
        accel('screenshot-shortcut', 'Screenshot');
        accel('record-shortcut', 'Start / stop recording');
        toggle(capture, 'record-cursor', 'Show pointer in recordings');

        const general = group('General');
        spin(general, 'update-interval', 'Update interval', 'Milliseconds', 500, 10000, 250);
        spin(general, 'graph-width', 'Graph width', 'Pixels per panel graph', 20, 120, 4);
        const dd = Gtk.DropDown.new_from_strings(POSITIONS);
        dd.selected = Math.max(0, POSITIONS.indexOf(settings.get_string('panel-position')));
        dd.connect('notify::selected', () => settings.set_string('panel-position', POSITIONS[dd.selected]));
        row(general, 'Panel position', '', dd);
    }
}
