/** Phase 3 probe #3 — scan with the GAME DIR as registered source (user's UI case). */
import { scanSource } from "../src/services/scan.js";
import { findReadme } from "../src/services/modinfo.js";

const GAME = "D:\\Games\\Diablo II Resurrected – Infernal Edition";
const scan = await scanSource(GAME, "src_gamedir");
console.log(
  JSON.stringify(
    {
      scannedDirs: scan.scannedDirs,
      warnings: scan.warnings,
      mods: scan.mods.map((m) => ({
        key: m.key,
        name: m.name,
        displayName: m.displayName,
        variant: m.variant,
        savepath: m.savepath,
        relPath: m.relPath,
      })),
    },
    null,
    1,
  ),
);
for (const m of scan.mods) {
  console.log(`readme(${m.name}) =`, await findReadme(m.sourcePath));
}
console.log("PROBE3_DONE");
