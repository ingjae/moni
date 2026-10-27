// Scrolling-capture stitcher on synthetic frames (gjs -m tests/helper.test.js).
import GdkPixbuf from 'gi://GdkPixbuf';
import {stitch, findOffset, rowHashes} from '../src/helper.js';

const W = 120, PAGE = 900, VIEW = 200, HEADER = 24, FOOTER = 16;
const check = (ok, msg) => {
    if (!ok)
        throw new Error(msg);
};

// A page of random rows with some blank runs, like real text.
let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
const page = new Uint8Array(PAGE * W * 3);
for (let y = 0; y < PAGE; y++) {
    const blank = y % 37 < 6;
    for (let x = 0; x < W; x++)
        for (let c = 0; c < 3; c++)
            page[(y * W + x) * 3 + c] = blank ? 250 : rand();
}

// A viewport at scroll position s, with a fixed header and footer drawn on top.
function frame(s) {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, W, VIEW);
    const stride = pb.get_rowstride(), bytes = new Uint8Array(stride * VIEW);
    for (let y = 0; y < VIEW; y++) {
        for (let x = 0; x < W; x++) {
            for (let c = 0; c < 3; c++) {
                const fixed = y < HEADER ? 40 : y >= VIEW - FOOTER ? 90 : null;
                bytes[y * stride + x * 3 + c] = fixed ?? page[((s + y) * W + x) * 3 + c];
            }
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, false, 8, W, VIEW, stride);
}

const positions = [0, 70, 140, 210, 280, 350, 420, 490, 560, 630, 700, 700];
const frames = positions.map(frame);
check(findOffset(rowHashes(frames[0]), rowHashes(frames[0])) === null, 'identical frames mean end of page');
const o = findOffset(rowHashes(frames[0]), rowHashes(frames[1]));
check(o.d === 70 && o.top === HEADER && o.bottom === FOOTER, `offset 70 with sticky bars, got ${JSON.stringify(o)}`);

const out = stitch(frames);
const expected = VIEW + 700;
check(out.get_height() === expected, `stitched height ${out.get_height()} != ${expected}`);
const px = out.get_pixels(), stride = out.get_rowstride();
for (let y = HEADER; y < expected - FOOTER; y++) {
    for (let x = 0; x < W; x++) {
        if (px[y * stride + x * 3] !== page[(y * W + x) * 3])
            throw new Error(`pixel mismatch at row ${y}`);
    }
}
check(px[0] === 40 && px[(expected - 1) * stride] === 90, 'header and footer appear once');
check(stitch([frames[0]]).get_height() === VIEW, 'one frame stays as is');
print('ok    scrolling capture stitches 12 frames with a sticky header/footer, stops at end of page');
