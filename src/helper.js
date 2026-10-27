// helper.js — pixel work the Shell must not do on its compositor thread.
//
//   gjs -m helper.js ocr <image.png>                 recognized text → stdout
//   gjs -m helper.js stitch <out.png> <frame.png>…   stitched height → stdout
//
// The editor imports the same functions directly.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

// Async subprocess → stdout text ('' on any failure).
export function run(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    resolve(p.communicate_utf8_finish(res)[1] ?? '');
                } catch (e) {
                    resolve('');
                }
            });
        } catch (e) {
            resolve('');
        }
    });
}

// ── OCR ────────────────────────────────────────────────────────────────

// Tesseract reads small UI text far better at 2x. Uses every installed
// language among English, Korean, Japanese and Simplified Chinese.
export async function recognize(pixbuf, tmp) {
    if (pixbuf.get_height() < 1200)
        pixbuf = pixbuf.scale_simple(pixbuf.get_width() * 2, pixbuf.get_height() * 2, GdkPixbuf.InterpType.BILINEAR);
    pixbuf.savev(tmp, 'png', [], []);
    const langs = (await run(['tesseract', '--list-langs'])).split('\n').map(s => s.trim());
    const lang = ['eng', 'kor', 'jpn', 'chi_sim'].filter(l => langs.includes(l)).join('+') || 'eng';
    const text = await run(['tesseract', tmp, 'stdout', '-l', lang]);
    GLib.unlink(tmp);
    return text.replace(/\f/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ── scrolling capture ──────────────────────────────────────────────────

// One hash per row. The outer columns are skipped: scrollbars and their
// thumbs change between frames even where the content did not.
export function rowHashes(pb) {
    const px = pb.get_pixels(), stride = pb.get_rowstride(), n = pb.get_n_channels();
    const w = pb.get_width(), h = pb.get_height();
    const x0 = Math.min(8, Math.floor(w * 0.02)) * n, x1 = (w - Math.max(Math.min(24, Math.floor(w * 0.1)), Math.floor(w * 0.04))) * n;
    const out = new Uint32Array(h);
    for (let y = 0; y < h; y++) {
        let hash = 2166136261;
        for (let i = y * stride + x0, end = y * stride + x1; i < end; i++)
            hash = Math.imul(hash ^ px[i], 16777619);
        out[y] = hash >>> 0;
    }
    return out;
}

// How far b scrolled past a. Rows that did not move at the top and bottom
// are a sticky header and footer. Only rows whose hash is unique in b vote,
// so blank lines cannot fake a match. null: nothing moved (end of page);
// d 0: no reliable overlap.
export function findOffset(a, b) {
    const H = a.length;
    let top = 0;
    while (top < H && a[top] === b[top])
        top++;
    if (top === H)
        return null;
    let bottom = 0;
    while (bottom < H - top && a[H - 1 - bottom] === b[H - 1 - bottom])
        bottom++;
    const count = new Map();
    for (let i = top; i < H - bottom; i++)
        count.set(b[i], (count.get(b[i]) ?? 0) + 1);
    let best = 0, bestScore = 0;
    for (let d = 1; d < H - top - bottom; d++) {
        let score = 0;
        for (let i = top; i < H - bottom - d; i++) {
            if (b[i] === a[i + d] && count.get(b[i]) === 1)
                score++;
        }
        if (score > bestScore) {
            best = d;
            bestScore = score;
        }
    }
    return {d: bestScore >= 3 ? best : 0, top, bottom};
}

// Frames in scroll order → one tall pixbuf. Stops at the first frame that
// did not move or cannot be matched.
export function stitch(frames) {
    const H = frames[0].get_height(), W = frames[0].get_width();
    const hashes = frames.map(rowHashes);
    const steps = [];
    for (let k = 1; k < frames.length; k++) {
        const o = findOffset(hashes[k - 1], hashes[k]);
        if (!o || !o.d)
            break;
        steps.push({k, ...o});
    }
    const footer = steps.length ? steps.at(-1).bottom : 0;
    const total = H - (steps[0]?.bottom ?? 0) + steps.reduce((s, st) => s + st.d, 0) + footer;
    const out = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, frames[0].get_has_alpha(), 8, W, total);
    let y = H - (steps[0]?.bottom ?? 0);
    frames[0].copy_area(0, 0, W, y, out, 0, 0);
    for (const st of steps) {
        frames[st.k].copy_area(0, H - st.bottom - st.d, W, st.d, out, 0, y);
        y += st.d;
    }
    frames[steps.at(-1)?.k ?? 0].copy_area(0, H - footer, W, footer, out, 0, y);
    return out;
}

// ── command line ───────────────────────────────────────────────────────

if (System.programInvocationName.endsWith('helper.js')) {
    const [cmd, ...args] = System.programArgs;
    const loop = new GLib.MainLoop(null, false);
    let code = 0;
    (async () => {
        if (cmd === 'ocr') {
            print(await recognize(GdkPixbuf.Pixbuf.new_from_file(args[0]), `${args[0]}.ocr.png`));
        } else if (cmd === 'stitch') {
            const out = stitch(args.slice(1).map(f => GdkPixbuf.Pixbuf.new_from_file(f)));
            out.savev(args[0], 'png', [], []);
            print(out.get_height());
        } else {
            printerr('usage: gjs -m helper.js ocr <png> | stitch <out.png> <frame.png>…');
            code = 2;
        }
    })().catch(e => {
        printerr(e);
        code = 1;
    }).finally(() => loop.quit());
    loop.run();
    System.exit(code);
}
