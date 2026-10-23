// Export → reset → import round trip for the prefs Backup group.
//   GSETTINGS_BACKEND=memory gjs -m tests/settings-backup.test.js   (after `make build`)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// prefs.js can't be imported outside the prefs process, so lift the two helpers out.
const src = new TextDecoder().decode(GLib.file_get_contents('src/prefs.js')[1]);
const body = src.slice(src.indexOf('const FORMAT'), src.indexOf('// Widgets limited'));
const {exportSettings, importSettings} = new Function('GLib', `${body}; return {exportSettings, importSettings};`)(GLib);

const source = Gio.SettingsSchemaSource.new_from_directory('build/esm/schemas', null, false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.moni', false)});
let failed = 0;
const check = (name, cond) => {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    failed += cond ? 0 : 1;
};

settings.set_boolean('show-cpu', false);
settings.set_int('update-interval', 2500);
settings.set_string('panel-position', 'left');
settings.set_strv('clipboard-favorites', ['ros2 launch nav2_bringup', 'export ROS_DOMAIN_ID=42']);
const file = JSON.parse(exportSettings(settings));
check('export covers every key', Object.keys(file.keys).length === settings.settings_schema.list_keys().length);

for (const k of settings.settings_schema.list_keys())
    settings.reset(k);
file.keys['no-such-key'] = 1;
file.keys['graph-width'] = 'wide';
const [applied, skipped] = importSettings(settings, JSON.stringify(file));
check('import restores values', !settings.get_boolean('show-cpu') && settings.get_int('update-interval') === 2500 &&
    settings.get_string('panel-position') === 'left' && settings.get_strv('clipboard-favorites')[1] === 'export ROS_DOMAIN_ID=42');
check('unknown and mistyped keys are skipped, not coerced', skipped === 2 && settings.get_int('graph-width') === 28 && applied > 0);
let rejected = false;
try {
    importSettings(settings, '{"hello": 1}');
} catch (e) {
    rejected = true;
}
check('foreign JSON is rejected', rejected);
if (failed)
    System.exit(1);
