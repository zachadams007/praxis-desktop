// Generate the Flight Deck icon set (teal rounded square on #0a0e14) with zero
// external deps - raw RGBA → PNG (via node:zlib) → multi-res .ico (embedded PNGs).
// Matches the in-app brand mark. Outputs:
//   src-tauri/icons/flightdeck.png   (256, used by the window via include_bytes!)
//   src-tauri/icons/flightdeck.ico   (16..256, used by the desktop/taskbar shortcut)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src-tauri', 'icons');

const BG = [0x0a, 0x0e, 0x14, 0xff]; // #0a0e14
const FG = [0x2f, 0xe0, 0xc6, 0xff]; // #2fe0c6 teal

// Draw a teal rounded square inset on a dark rounded-square background.
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const outerR = size * 0.22; // app-tile corner radius
  const inset = size * 0.30; // teal square inset
  const innerR = size * 0.09;
  const lo = inset, hi = size - inset;
  const put = (x, y, c) => {
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  };
  // rounded-rect coverage test (1=inside, with cheap 1px AA on the FG square)
  const inRounded = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const dx = x - cx, dy = y - cy;
      return Math.hypot(dx, dy) <= r + 0.5;
    }
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const onTile = inRounded(x + 0.5, y + 0.5, 0.5, 0.5, size - 0.5, size - 0.5, outerR);
      if (!onTile) { put(x, y, [0, 0, 0, 0]); continue; } // transparent outside tile
      const onSquare = inRounded(x + 0.5, y + 0.5, lo, lo, hi, hi, innerR);
      put(x, y, onSquare ? FG : BG);
    }
  }
  return buf;
}

function pngFromRGBA(rgba, size) {
  // build raw image data with a filter byte (0) per scanline
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff);
}

function icoFromPngs(entries) {
  // ICONDIR + ICONDIRENTRY[] + PNG payloads (PNG-in-ICO, Vista+)
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const payloads = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;       // width (0 = 256)
    dir[o + 1] = e.size >= 256 ? 0 : e.size;   // height
    dir[o + 2] = 0; dir[o + 3] = 0;            // colors, reserved
    dir.writeUInt16LE(1, o + 4);               // planes
    dir.writeUInt16LE(32, o + 6);              // bpp
    dir.writeUInt32LE(e.png.length, o + 8);    // bytes
    dir.writeUInt32LE(offset, o + 12);         // offset
    offset += e.png.length;
    payloads.push(e.png);
  });
  return Buffer.concat([header, dir, ...payloads]);
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, png: pngFromRGBA(render(s), s) }));
const png256 = pngs.find((p) => p.size === 256).png;
fs.writeFileSync(path.join(OUT, 'flightdeck.png'), png256);
fs.writeFileSync(path.join(OUT, 'flightdeck.ico'), icoFromPngs(pngs));
console.log('wrote', path.join(OUT, 'flightdeck.png'), png256.length, 'bytes');
console.log('wrote', path.join(OUT, 'flightdeck.ico'));
