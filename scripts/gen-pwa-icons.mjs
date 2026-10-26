#!/usr/bin/env node
/**
 * PWA icon generator (issue #71) — zero-dependency, deterministic.
 *
 * Renders the web-edition app icons (regular + maskable, 192/512) as
 * flat PNGs with node's zlib: brand green (#58cc02, the splash-screen
 * token) with a white five-point star. Deliberately simple — the issue
 * scopes PWA support to "basic offline"; store-grade icon art remains
 * the user-side asset set (docs/store). Rerunnable: node scripts/gen-pwa-icons.mjs
 *
 * Why hand-rolled PNG encoding: the repo is vector-first and adding an
 * image-processing dependency (sharp et al.) for four flat icons fails
 * the leaner-is-better bar; a ~120-line RGBA rasterizer + PNG chunk
 * writer is fully controllable, auditable, and has zero supply chain.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "apps", "mobile", "public", "icons");

const BRAND_GREEN = [0x58, 0xcc, 0x02, 255];
const WHITE = [255, 255, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];

// --- minimal PNG encoder -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- raster helpers ----------------------------------------------------------------

function starPolygon(cx, cy, outerR, innerR) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function roundedRectInside(x, y, size, radius) {
  const r = Math.min(radius, size / 2);
  const cx = Math.abs(x - size / 2);
  const cy = Math.abs(y - size / 2);
  if (cx <= size / 2 - r || cy <= size / 2 - r) return true;
  const dx = cx - (size / 2 - r);
  const dy = cy - (size / 2 - r);
  return dx * dx + dy * dy <= r * r;
}

/**
 * Render one icon. Maskable icons are full-bleed with the star inside
 * the 80% safe zone; regular icons use rounded corners and a larger
 * star (visual parity with the splash-screen brand mark).
 */
function renderIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const cornerRadius = size * 0.18;
  const starOuter = maskable ? size * 0.3 : size * 0.38;
  const starInner = starOuter * 0.42;
  const star = starPolygon(size / 2, size / 2, starOuter, starInner);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let color;
      if (!maskable && !roundedRectInside(x + 0.5, y + 0.5, size, cornerRadius)) {
        color = TRANSPARENT;
      } else if (pointInPolygon(x + 0.5, y + 0.5, star)) {
        color = WHITE;
      } else {
        color = BRAND_GREEN;
      }
      const o = (y * size + x) * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = color[3];
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const outputs = [
  ["icon-192.png", renderIcon(192, false)],
  ["icon-512.png", renderIcon(512, false)],
  ["icon-maskable-192.png", renderIcon(192, true)],
  ["icon-maskable-512.png", renderIcon(512, true)],
];
for (const [name, png] of outputs) {
  writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`${name}: ${png.length} bytes`);
}
console.log(`wrote ${outputs.length} icons to apps/mobile/public/icons/`);
