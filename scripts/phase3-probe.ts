/**
 * Phase 3 headless probe — exercises the backend services against the real
 * game dir WITHOUT touching app config (commands layer not involved).
 * Run: node scripts/run-probe.mjs  (bundled on the fly, same esbuild options
 * as the ztron CLI backend pipeline).
 */
import { validateGameDir, ensureModsDir, modsDir } from "../src/services/paths.js";
import { scanSource } from "../src/services/scan.js";
import { findReadme } from "../src/services/modinfo.js";
import { installMod, installState, uninstallPreflight } from "../src/services/install.js";
import { uninstallModDir } from "../src/services/install.js";

const GAME = "D:\\Games\\Diablo II Resurrected – Infernal Edition";
const PACK = `${GAME}\\术士君临MOD整合-自行测试\\术士君临MOD整合-自行测试`;

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`);
  console.log(JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? `[u8 ${v.length}]` : v), 1));
}

// -- 1. validate + ensure mods dir
log("validateGameDir(before)", await validateGameDir(GAME));
await ensureModsDir(GAME);
log("validateGameDir(after ensureModsDir)", await validateGameDir(GAME));
log("modsDir", modsDir(GAME));

// -- 2. scan the pack
const scan = await scanSource(PACK, "src_probe");
log("scanSource: mods", scan.mods.map((m) => ({
  key: m.key,
  name: m.name,
  savepath: m.savepath,
  variant: m.variant,
  parseWarning: m.parseWarning,
  relPath: m.relPath,
})));
log("scanSource: warnings/scannedDirs", { warnings: scan.warnings, scannedDirs: scan.scannedDirs });

for (const m of scan.mods) {
  log(`readme(${m.name})`, await findReadme(m.sourcePath));
}

// -- 3. install EJ with copy (small one)
const ej = scan.mods.find((m) => m.name === "EJ");
if (ej && !(await installState(GAME, "EJ"))) {
  const out = await installMod({
    gameDir: GAME,
    sourcePath: ej.sourcePath,
    modName: "EJ",
    mode: "copy",
    overwrite: false,
    onProgress: () => {},
  });
  log("install EJ(copy)", out);
}
log("installState(EJ)", await installState(GAME, "EJ"));

// -- 4. install VIPer_cs with hardlink (big mpq -> should be instant)
const vip = scan.mods.find((m) => m.name === "VIPer_cs");
if (vip && !(await installState(GAME, "VIPer_cs"))) {
  const t0 = Date.now();
  const out = await installMod({
    gameDir: GAME,
    sourcePath: vip.sourcePath,
    modName: "VIPer_cs",
    mode: "hardlink",
    overwrite: false,
    onProgress: () => {},
  });
  log("install VIPer_cs(hardlink) ms=" + (Date.now() - t0), out);
}
log("installState(VIPer_cs)", await installState(GAME, "VIPer_cs"));

// -- 5. uninstall preflights
log("preflight(EJ)", await uninstallPreflight(GAME, "EJ"));
log("preflight(VIPer_cs)", await uninstallPreflight(GAME, "VIPer_cs"));

console.log("\nPROBE_DONE");
