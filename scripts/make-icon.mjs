/**
 * Icon pipeline: icon/app.svg → per-size PNG (Edge headless) → icon/app.ico
 * (+ icon/app-icon.png 256px for the runtime window icon).
 *
 * ICO frame formats: ≤48px as 32bpp DIB (broadest shell compatibility),
 * ≥64px as embedded PNG (Vista+). The DIB frames are re-decoded to
 * .render/check-*.png for eyeball verification.
 *
 * Run: node scripts/make-icon.mjs
 */
import { spawnSync } from "node:child_process";
import { inflateSync, deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ICON_DIR = path.join(root, "icon");
const RENDER_DIR = path.join(ICON_DIR, ".render");
const SVG = path.join(ICON_DIR, "app.svg");
const OUT_ICO = path.join(ICON_DIR, "app.ico");
const OUT_PNG = path.join(ICON_DIR, "app-icon.png");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => spawnSync("cmd", ["/d", "/c", `if exist "${p}" exit /b 0`], { stdio: "ignore" }).status === 0);
if (!EDGE) throw new Error("msedge.exe not found");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// -- 1. render each size (SVG needs explicit width/height or Edge crops) -----
mkdirSync(RENDER_DIR, { recursive: true });
const svgText = readFileSync(SVG, "utf8");
for (const size of SIZES) {
  const scaled = svgText.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  const tmpSvg = path.join(RENDER_DIR, `icon-${size}.svg`);
  writeFileSync(tmpSvg, scaled);
  const out = path.join(RENDER_DIR, `${size}.png`);
  const profile = mkdtempSync(path.join(os.tmpdir(), "ztron-icon-"));
  const r = spawnSync(
    EDGE,
    [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      `--user-data-dir=${profile}`,
      `--window-size=${size},${size}`,
      "--default-background-color=00000000",
      `--screenshot=${out}`,
      `file:///${tmpSvg.replace(/\\/g, "/")}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"], timeout: 30000 },
  );
  rmSync(profile, { recursive: true, force: true });
  if (!r || !readFileSyncSafe(out)) throw new Error(`render ${size}px failed`);
  console.log(`render ${size}px ok`);
}
function readFileSyncSafe(p) {
  try { return readFileSync(p); } catch { return null; }
}

// -- 2. minimal PNG decode (8-bit RGBA, non-interlaced) ----------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8, idat = [], ihdr = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const { width: w, height: h, depth, colorType, interlace } = ihdr;
  if (depth !== 8 || colorType !== 6 || interlace !== 0)
    throw new Error(`unsupported png (${depth}bit color${colorType} ilace${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(px, y * stride);
    prev = cur;
  }
  return { width: w, height: h, rgba: px };
}

// -- 3. frame encoders --------------------------------------------------------
function dibFrame({ width: w, height: h, rgba }) {
  const maskStride = Math.ceil(w / 32) * 4;
  const xorStride = w * 4;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(w, 4);
  hdr.writeInt32LE(h * 2, 8); // XOR + AND heights
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(maskStride * h, 20); // biSizeImage
  const xor = Buffer.alloc(xorStride * h);
  for (let y = 0; y < h; y++) {
    const src = y * xorStride, dst = (h - 1 - y) * xorStride; // bottom-up
    for (let x = 0; x < w; x++) {
      xor[dst + x * 4] = rgba[src + x * 4 + 2]; // B
      xor[dst + x * 4 + 1] = rgba[src + x * 4 + 1]; // G
      xor[dst + x * 4 + 2] = rgba[src + x * 4]; // R
      xor[dst + x * 4 + 3] = rgba[src + x * 4 + 3]; // A
    }
  }
  return Buffer.concat([hdr, xor, Buffer.alloc(maskStride * h)]); // AND mask: alpha decides
}

/** Re-encode a decoded frame back to PNG (filter 0) — verification output. */
function encodePng({ width: w, height: h, rgba }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32LE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32LE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -- 4. pack the ICO ----------------------------------------------------------
const frames = SIZES.map((size) => {
  const img = decodePng(readFileSync(path.join(RENDER_DIR, `${size}.png`)));
  if (img.width !== size || img.height !== size) throw new Error(`${size}px got ${img.width}x${img.height}`);
  return { size, img, data: size <= 48 ? dibFrame(img) : readFileSync(path.join(RENDER_DIR, `${size}.png`)) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
const entries = [];
let offset = 6 + frames.length * 16;
for (const f of frames) {
  const e = Buffer.alloc(16);
  e[0] = f.size >= 256 ? 0 : f.size;
  e[1] = f.size >= 256 ? 0 : f.size;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(f.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += f.data.length;
}
writeFileSync(OUT_ICO, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
writeFileSync(OUT_PNG, readFileSync(path.join(RENDER_DIR, "256.png")));

// -- 5. verification: DIB frames → PNG for eyeball check ----------------------
for (const size of [48, 16]) {
  const f = frames.find((x) => x.size === size);
  const { width: w, height: h, rgba } = f.img;
  // sanity: DIB header fields round-trip
  if (f.data.readUInt32LE(0) !== 40 || f.data.readInt32LE(8) !== h * 2) throw new Error("dib header bad");
  const maskStride = Math.ceil(w / 32) * 4;
  if (f.data.length !== 40 + w * h * 4 + maskStride * h)
    throw new Error(`dib size mismatch (${f.data.length})`);
  writeFileSync(path.join(RENDER_DIR, `check-${size}.png`), encodePng(f.img));
}

console.log(`wrote ${path.relative(root, OUT_ICO)} (${SIZES.join("/")}) + ${path.relative(root, OUT_PNG)}`);
