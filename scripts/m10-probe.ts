/**
 * M10 probe: cross-validate readStashHeader against the d2s lib's full
 * parse on REAL stash files (the lib's compact write is not a layout
 * oracle — only real files are). Also exercises stashConsistency warnings.
 */
import { readStashHeader, stashConsistency } from "../src/services/stash.js";
import { parseItemFile } from "../src/services/itemview.js";
import { listItemSources } from "../src/services/itemview.js";

const SAVE = "C:/Users/ZYJ/Saved Games/Diablo II Resurrected";

const files = [
  "SharedStashSoftCoreV2.d2i",
  "SharedStashHardCoreV2.d2i",
  "SharedStashSoftCoreV2.d2i.1",
];

for (const f of files) {
  const p = `${SAVE}/${f}`;
  const h = await readStashHeader(p);
  const parsed = await parseItemFile(p);
  const libPages = parsed.kind === "stash" ? parsed.pageCount : `(${parsed.kind})`;
  const libHardcore = parsed.kind === "stash" ? parsed.hardcore : "-";
  const libGold = parsed.kind === "stash" ? parsed.sharedGold : "-";
  const itemCount =
    parsed.kind === "stash" ? parsed.pages.reduce((n, pg) => n + pg.items.length, 0) : "-";
  console.log(
    `${f}\n  header: hardcore=${h?.hardcore} version=${h?.version} gold=${h?.sharedGold} sectorSize=${h?.sectorSize} pages=${h?.pageCount}\n  lib:    hardcore=${libHardcore} gold=${libGold} pages=${libPages} items=${itemCount}`,
  );
}

const c = await stashConsistency(SAVE);
console.log("\nconsistency warnings:");
for (const w of c.warnings) console.log(`  [${w.level}] ${w.text}`);
if (c.warnings.length === 0) console.log("  (none)");

const groups = await listItemSources(SAVE);
console.log("\ngroups:", groups.groups.map((g) => `${g.name}(${g.stashes.length} d2i)`).join(", "));
console.log("probe done");
