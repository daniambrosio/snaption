import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// Rounded square background with a camera-lens "S" letter
// Background: deep indigo gradient-feel (single tone, #2A2A5E)
// Foreground: white "S"
const BG = [42, 42, 94];
const FG = [255, 255, 255];

function makePng(size) {
  const bytes = new Uint8Array(size * size * 4);
  const radius = Math.floor(size * 0.22);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inRounded = isInsideRounded(x, y, size, radius);
      if (!inRounded) { bytes[i+3] = 0; continue; }

      if (isS(x, y, size)) {
        bytes[i] = FG[0]; bytes[i+1] = FG[1]; bytes[i+2] = FG[2]; bytes[i+3] = 255;
      } else {
        bytes[i] = BG[0]; bytes[i+1] = BG[1]; bytes[i+2] = BG[2]; bytes[i+3] = 255;
      }
    }
  }

  // Convert to scanlines with filter byte 0
  const rowSize = size * 4 + 1;
  const raw = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size * 4; x++) {
      raw[y * rowSize + 1 + x] = bytes[y * size * 4 + x];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // 8-bit
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function isInsideRounded(x, y, size, r) {
  if (x >= r && x < size - r) return true;
  if (y >= r && y < size - r) return true;
  // corners
  const cx = x < r ? r : size - 1 - r;
  const cy = y < r ? r : size - 1 - r;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Draw a stylized "S" — three horizontal bars connected by alternating vertical segments
// Shape:   ━━━━
//          │
//          ━━━━
//             │
//          ━━━━
function isS(x, y, size) {
  const pad = Math.round(size * 0.26);
  const thick = Math.max(1, Math.round(size * 0.14));
  const left = pad;
  const right = size - pad;
  const top = pad;
  const bottom = size - pad;
  const mid = Math.round((top + bottom) / 2 - thick / 2);

  // Three horizontal bars (top / middle / bottom)
  if (y >= top && y < top + thick && x >= left && x < right) return true;
  if (y >= mid && y < mid + thick && x >= left && x < right) return true;
  if (y >= bottom - thick && y < bottom && x >= left && x < right) return true;

  // Left vertical (between top and middle bars)
  if (y >= top && y < mid + thick && x >= left && x < left + thick) return true;

  // Right vertical (between middle and bottom bars)
  if (y >= mid && y < bottom && x >= right - thick && x < right) return true;

  return false;
}

for (const size of [16, 48, 128]) {
  const png = makePng(size);
  writeFileSync(new URL(`./icon${size}.png`, import.meta.url), png);
  console.log(`  wrote icon${size}.png (${png.length} bytes)`);
}
