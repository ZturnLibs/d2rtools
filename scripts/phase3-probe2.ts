/**
 * Phase 3 probe #2 — exportShortcut service + readme text decode chain
 * (b64 round-trip + BOM/GBK fallback), headless.
 */
import { exportShortcut } from "../src/services/launch.js";

const GAME = "D:\\Games\\Diablo II Resurrected – Infernal Edition";

/** Mirrors d2r:readTextB64 (≤2MB, chunked btoa). */
function toB64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// -- 1. export a .lnk for EJ onto the desktop
const lnk = await exportShortcut({
  fileName: "d2rbox-probe-EJ.lnk",
  targetExe: `${GAME}\\D2R.exe`,
  args: ["-mod", "EJ", "-txt"].join(" "),
  workDir: GAME,
});
console.log("LNK_PATH", lnk);

// -- 2. readme decode chain: read bytes -> b64 -> decode (utf-8 / GBK fallback)
const readmePath =
  `${GAME}\\术士君临MOD整合-自行测试\\术士君临MOD整合-自行测试\\` +
  `2.第二种大型整合\\mods\\VIPer_cs\\说明.txt`;
const raw = await tjs.readFile(readmePath);
const b64 = toB64(raw);
const bin = atob(b64);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
// Mirror frontend decode.ts: fatal utf-8 first, GBK fallback.
let text: string;
try {
  text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  text = text.replace(/^\uFEFF/, "");
  console.log("README_ENCODING utf-8");
} catch {
  text = new TextDecoder("gbk").decode(bytes).replace(/^\uFEFF/, "");
  console.log("README_ENCODING gbk");
}
console.log("README_BYTES", raw.length);
console.log("README_HEAD", text.slice(0, 160).replace(/\r?\n/g, " ⏎ "));

console.log("PROBE2_DONE");
