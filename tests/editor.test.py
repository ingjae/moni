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
            for (const id of ['arrow', 'line', 'rect', 'oval', 'highlight', 'pixelate', 'blur', 'erase', 'spotlight', 'ruler']) {
                editor.setTool(id);
                const it = editor.makeItem([30, 40], [200, 180]);
                check(editor.refresh(it), `${id} covers image pixels`);
                if (id === 'pixelate' || id === 'blur')
                    check(it.pixbuf.get_width() === 170, `${id} region width`);
                editor.items.push(it);
            }
            editor.setTool('rect');
            editor.items.push({...editor.makeItem([40, 50], [90, 90]), fill: true, color: '#34c759'});
            editor.items.push({type: 'text', color: '#ffffff', lw: 3, x1: 20, y1: 20, text: 'Moni 테스트'});
            editor.items.push({type: 'text', color: '#ffcc00', lw: 3, fill: true, x1: 20, y1: 200, text: 'bubble'});
            editor.items.push({type: 'step', color: '#ff3b30', lw: 3, x1: 230, y1: 180, n: 1});
            editor.items.push({type: 'pen', color: '#34c759', lw: 3, pts: [[240, 30], [260, 60], [290, 40], [300, 90]]});
            const items = editor.items;
            for (const item of items) {
                editor.items = [item];
                const single = editor.exportTo(`${dir}/${item.type}${item.fill ? '-fill' : ''}.png`);
                check(sum(single) !== sum(baseline), `${item.type} changes image pixels`);
            }
            editor.items = items;
            const output = `${dir}/annotated.png`;
            editor.exportTo(output);
            const exported = GdkPixbuf.Pixbuf.new_from_file(output);
            check(exported.get_width() === 320 && exported.get_height() === 240, 'export keeps source resolution');
            check(sum(baseline) !== sum(output), 'annotations change exported pixels');
            const it = editor.makeItem([-40, -20], [500, 300]);
            check(it.x1 === 0 && it.y1 === 0 && it.x2 === 320 && it.y2 === 240, 'annotations clamp to image');
            editor.setTool('arrow');
            const snapped = editor.makeItem([10, 10], [110, 14], true);
            check(Math.abs(snapped.y2 - 10) < 1e-9 && Math.abs(snapped.x2 - 110.08) < 0.01, 'Shift snaps lines to 45 degrees');
            editor.setTool('rect');
            const sq = editor.makeItem([10, 10], [110, 60], true);
            check(sq.x2 - sq.x1 === 50 && sq.y2 - sq.y1 === 50, 'Shift makes squares');

            // Smart erase samples the flat blue around the checkerboard.
            editor.setTool('erase');
            const er = editor.makeItem([30, 40], [200, 180]);
            editor.refresh(er);
            check(er.rgb.every((v, i) => Math.abs(v - [0x24, 0x68, 0xac][i] / 255) < 0.02), 'smart erase picks the surrounding color');

            // History: add, move, resize, delete, undo, redo.
            editor.items = [];
            editor.history = [];
            editor.redoStack = [];
            editor.addItem({type: 'step', color: '#ff3b30', lw: 3, x1: 100, y1: 100, n: 1});
            editor.addItem({type: 'pen', color: '#34c759', lw: 3, pts: [[10, 200], [60, 210], [110, 200]]});
            editor.addItem({type: 'rect', color: '#0a84ff', lw: 3, x1: 150, y1: 20, x2: 300, y2: 120});
            editor.addItem({type: 'oval', color: '#0a84ff', lw: 3, x1: 20, y1: 20, x2: 80, y2: 60});
            check(editor.hitTest([60, 210]) === 1, 'hit test finds the pen stroke');
            check(editor.hitTest([102, 98]) === 0, 'hit test finds the step badge');
            check(editor.hitTest([150, 70]) === 2, 'hit test finds the rectangle edge');
            check(editor.hitTest([225, 70]) === -1, 'rectangle interior is not a grab target');
            check(editor.hitTest([20, 40]) === 3 && editor.hitTest([50, 40]) === -1, 'oval is grabbed by its outline');
            const pen = editor.items[1];
            editor.setTool('move');
            editor.sel = 1;
            editor.onPress([60, 210]);
            editor.drag.mode === 'move' || check(false, 'press on selection starts a move');
            editor.onDrag([100, 160], [0, 0], false);
            editor.onRelease(50, [0, 0]);
            check(editor.items[1].pts[0][0] === 50 && editor.items[1].pts[0][1] === 150, 'move shifts every pen point');
            check(editor.hitTest([100, 160]) === 1, 'moved stroke is grabbed at its new place');
            editor.sel = 2;
            editor.onPress([300, 120]);
            check(editor.drag?.mode === 'resize', 'corner handle starts a resize');
            editor.onDrag([280, 200], [0, 0], false);
            editor.onRelease(80, [0, 0]);
            check(editor.items[2].x2 === 280 && editor.items[2].y2 === 200 && editor.items[2].x1 === 150, 'resize moves only the dragged corner');
            editor.undo();
            check(editor.items[2].y2 === 120, 'undo reverts a resize');
            editor.undo();
            check(editor.items[1] === pen, 'undo reverts a move');
            editor.redo();
            check(editor.items[1].pts[0][0] === 50, 'redo replays a move');
            const count = editor.items.length;
            editor.undo();
            editor.undo();
            check(editor.items.length === count - 1, 'undo removes one annotation');

            // Crop and backdrop change the exported size.
            editor.items = [];
            editor.crop = {x: 10, y: 20, w: 100, h: 50};
            editor.exportTo(`${dir}/crop.png`);
            const cropped = GdkPixbuf.Pixbuf.new_from_file(`${dir}/crop.png`);
            check(cropped.get_width() === 100 && cropped.get_height() === 50, 'crop exports only the crop');
            editor.backdrop = 0;
            editor.exportTo(`${dir}/backdrop.png`);
            const framed = GdkPixbuf.Pixbuf.new_from_file(`${dir}/backdrop.png`);
            check(framed.get_width() === 148 && framed.get_height() === 98, 'backdrop pads the crop');
            const fp = framed.get_pixels();
            check(fp[0] > 0x40 && fp[2] > 0xe0, 'backdrop corner shows the gradient');
            editor.backdrop = -1;
            editor.crop = null;
            editor.exportTo(`${dir}/undone.png`);
            check(sum(baseline) === sum(`${dir}/undone.png`), 'empty state restores original rendered image');
            print(`ok    GTK editor: 15 tools, move, resize, undo/redo, crop, backdrop, smart erase; scale=${editor.area.get_scale_factor()}; window=${editor.win.get_width()}x${editor.win.get_height()}`);
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
    (Path(directory) / 'helper.js').write_text((root / 'src/helper.js').read_text())
    module = Path(directory) / 'editor-test.js'
    module.write_text(source + harness)
    subprocess.run(['gjs', '-m', str(module), directory], check=True, timeout=30)
