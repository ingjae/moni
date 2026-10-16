#!/usr/bin/env python3
"""Run the real GTK editor renderer in a graphical session (make test-ui)."""
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / 'src/editor.js').read_text()
# Reuse the actual editor class and widgets, replacing only the application entrypoint.
source = source[:source.index('const path = System.programArgs[0];')]
harness = r'''
const dir = System.programArgs[0];
const fixture = `${dir}/fixture.png`;
const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 320, 240);
const ctx = new Cairo.Context(surface);
ctx.setSourceRGB(0x24 / 255, 0x68 / 255, 0xac / 255);
ctx.paint();
ctx.setSourceRGB(1, 1, 1);
for (let y = 40; y < 180; y += 4) {
    for (let x = 30; x < 200; x += 4) {
        if (((x - 30) / 4 + (y - 40) / 4) % 2 === 0) {ctx.rectangle(x, y, 2, 2);ctx.fill();}
    }
}
surface.writeToPNG(fixture);
ctx.$dispose();
let failed = false;
const app = new Adw.Application({application_id: 'io.github.ingjae.moni.RenderTest',
    flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    loadCss();
    const editor = new Editor(app, fixture);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        try {
            const check = (condition, message) => {if (!condition) throw new Error(message);};
            check(editor.area.get_width() > 100, 'canvas must be allocated');
            check(editor.pixelHex([10, 10]) === '#2468AC', 'picker reads image pixels');
            check(editor.pixelHex([-1, 0]) === null, 'picker rejects margins');
            const sum = path => GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, GLib.file_get_contents(path)[1]);
            const baseline = editor.exportTo(`${dir}/baseline.png`);
            for (const id of ['arrow', 'rect', 'highlight', 'blur', 'ruler']) {
                editor.setTool(id);
                const it = editor.makeItem([30, 40], [200, 180]);
                if (id === 'blur') {
                    it.pixbuf = editor.pixelate(it);
                    check(it.pixbuf.get_width() === 170, 'pixelation region width');
                }
                editor.items.push(it);
            }
            editor.items.push({type: 'text', color: '#ffffff', x1: 20, y1: 20, text: 'Moni 테스트'});
            editor.items.push({type: 'step', color: '#ff3b30', x1: 230, y1: 180, n: 1});
            const items = editor.items;
            for (const item of items) {
                editor.items = [item];
                const single = editor.exportTo(`${dir}/${item.type}.png`);
                check(sum(single) !== sum(baseline), `${item.type} changes image pixels`);
            }
            editor.items = items;
            const output = `${dir}/annotated.png`;
            editor.exportTo(output);
            const exported = GdkPixbuf.Pixbuf.new_from_file(output);
            check(exported.get_width() === 320 && exported.get_height() === 240, 'export keeps source resolution');
            check(sum(baseline) !== sum(output), 'annotations change exported pixels');
            const count = editor.items.length;
            editor.undo();
            check(editor.items.length === count - 1, 'undo removes one annotation');
            const it = editor.makeItem([-40, -20], [500, 300]);
            check(it.x1 === 0 && it.y1 === 0 && it.x2 === 320 && it.y2 === 240, 'annotations clamp to image');
            editor.items = [];
            editor.exportTo(`${dir}/undone.png`);
            check(sum(baseline) === sum(`${dir}/undone.png`), 'undo state restores original rendered image');
            print(`ok    GTK editor: all 8 tools, Unicode text, export, undo, boundaries; scale=${editor.area.get_scale_factor()}; window=${editor.win.get_width()}x${editor.win.get_height()}`);
        } catch (e) {
            failed = true;
            printerr(`${e}\n${e.stack}`);
        }
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
if (failed) System.exit(1);
'''
with tempfile.TemporaryDirectory(prefix='moni-editor-test-') as directory:
    module = Path(directory) / 'editor-test.js'
    module.write_text(source + harness)
    subprocess.run(['gjs', '-m', str(module), directory], check=True, timeout=30)
