/** Рисует PNG-иконку 180×180 из той же геометрии, что favicon.svg (apple-touch и старые браузеры). */
import fs from "node:fs";
import zlib from "node:zlib";

const SIZE = 180;
const BG = [11, 14, 19];
const LINE = [33, 41, 54];
const ACCENT = [124, 140, 255];

const px = new Uint8Array(SIZE * SIZE * 4);

const set = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
};

const insideRounded = (x, y, s, r) => {
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// фон + скругление
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (insideRounded(x + 0.5, y + 0.5, SIZE, 38)) set(x, y, BG);
    else set(x, y, BG, 0);
  }
}

// рамка
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!insideRounded(x + 0.5, y + 0.5, SIZE, 38)) continue;
    const ex = Math.min(x, SIZE - 1 - x);
    const ey = Math.min(y, SIZE - 1 - y);
    if ((ex < 4 || ey < 4) && insideRounded(x + 0.5, y + 0.5, SIZE, 38)) set(x, y, LINE);
  }
}

// ромб: |x-cx| + |y-cy| в пределах радиуса
const cx = SIZE / 2;
const cy = SIZE / 2;
const R = 74;
const W = 9;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (Math.abs(d - R) <= W / 2) set(x, y, ACCENT);
  }
}
// центр
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= 18 ** 2) set(x, y, ACCENT);
  }
}

// PNG: raw scanlines + filter byte
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.writeFileSync("public/icon-180.png", png);
console.log("public/icon-180.png", png.length, "байт");
