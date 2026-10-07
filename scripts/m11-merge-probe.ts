/**
 * M11 probe: real-file merge/split in a sandbox (never touches the real
 * save dir). Copies parseable stashes + a character from the live save dir,
 * then: merge (stash+char → new file) → split (→ part1/part2) → slot
 * overwrite (garbage pre-existing file → auto snapshot restores it).
 * Run: node scripts/run-probe.mjs m11-merge-probe.ts
 */
import { listItemSources, parseItemFile } from "../src/services/itemview.js";
import { planMerge, applyMerge, DEFAULT_GRID } from "../src/services/stashmerge.js";
import { joinPath } from "../src/services/paths.js";
import { listBackups } from "../src/services/saves.js";
import { STASH_FILES } from "../src/services/stash.js";

const SAVE = "C:/Users/ZYJ/Saved Games/Diablo II Resurrected";
const SB = ".probe-m11";
const APPDATA = joinPath(SB, "appdata");
const saveDir = joinPath(SB, "saves");

// 备份根走 APPDATA —— 指进沙盒，绝不碰真实备份库
tjs.env.APPDATA = APPDATA;
await tjs.remove(SB, { recursive: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
await tjs.makeDir(saveDir, { recursive: true });

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

// ---- 收集真实来源（可解析、有物品），拷进沙盒 ----
const groups = await listItemSources(SAVE);
const stashCopies: { name: string; path: string; items: number }[] = [];
let charCopy: { name: string; path: string; items: number } | null = null;
for (const g of groups.groups) {
  for (const st of g.stashes) {
    const parsed = await parseItemFile(st.path).catch(() => null);
    if (parsed?.kind !== "stash") continue;
    const n = parsed.pages.reduce((s, p) => s + p.items.length, 0);
    if (n === 0) continue;
    const dest = joinPath(saveDir, `copy-${st.name.replace(/[^\w.-]/g, "_")}`);
    await tjs.writeFile(dest, await tjs.readFile(st.path));
    stashCopies.push({ name: st.name, path: dest, items: n });
  }
  for (const ch of g.characters) {
    const parsed = await parseItemFile(ch.path).catch(() => null);
    if (parsed?.kind !== "character") continue;
    const n = parsed.groups.reduce((s, g) => s + g.items.length, 0);
    if (n > (charCopy?.items ?? 0)) {
      const dest = joinPath(saveDir, `copy-${ch.name.replace(/[^\w.-]/g, "_")}.d2s`);
      await tjs.writeFile(dest, await tjs.readFile(ch.path));
      charCopy = { name: ch.name, path: dest, items: n };
    }
  }
}
stashCopies.sort((a, b) => a.items - b.items);
console.log(
  `sources: ${stashCopies.map((s) => `${s.name}(${s.items})`).join(", ")}` +
    (charCopy ? ` + char ${charCopy.name}(${charCopy.items})` : " + no char"),
);
if (stashCopies.length < 1) throw new Error("no parseable stash sources on this machine");

// ---- 1) 合并：两个最小仓库 + 角色 → 新文件 8 页 ----
const mergeSources = [
  { path: stashCopies[0]!.path, kind: "stash" as const },
  ...(stashCopies[1] ? [{ path: stashCopies[1]!.path, kind: "stash" as const }] : []),
  ...(charCopy ? [{ path: charCopy.path, kind: "character" as const }] : []),
];
const targets1 = [{ slot: null, fileName: "merged.d2i", pages: 8, hardcore: false, sharedGold: 0 }];
const plan1 = await planMerge(saveDir, mergeSources, targets1, DEFAULT_GRID);
check(
  "merge plan",
  plan1.view.carried === plan1.view.placed && plan1.view.unplaced === 0,
  `carried ${plan1.view.carried}, placed ${plan1.view.placed}, unknown ${plan1.view.unknownSize}, warnings ${plan1.view.warnings.length}`,
);
const res1 = await applyMerge(saveDir, mergeSources, targets1, DEFAULT_GRID, {
  backupKeep: 5,
  expectCarried: plan1.view.carried,
  note: "probe merge",
});
check("merge apply: no snapshot for new file", res1.backupId === null);
const mergedParsed = await parseItemFile(joinPath(saveDir, "merged.d2i"));
check(
  "merged file parses with all items",
  mergedParsed.kind === "stash" && mergedParsed.pages.reduce((n, p) => n + p.items.length, 0) === plan1.view.carried,
  `parsed ${mergedParsed.kind === "stash" ? mergedParsed.pages.reduce((n, p) => n + p.items.length, 0) : "?"}/${plan1.view.carried}`,
);

// ---- 2) 拆分：merged → part1(4页) + part2(4页) ----
const targets2 = [
  { slot: null, fileName: "part1.d2i", pages: 4, hardcore: false, sharedGold: 0 },
  { slot: null, fileName: "part2.d2i", pages: 4, hardcore: false, sharedGold: 0 },
];
const plan2 = await planMerge(saveDir, [{ path: joinPath(saveDir, "merged.d2i"), kind: "stash" }], targets2, DEFAULT_GRID);
const splitCounts = plan2.view.targets.map((t) => t.items.length);
check(
  "split plan distributes across targets",
  plan2.view.unplaced === 0 && splitCounts.every((n) => n > 0),
  `part1 ${splitCounts[0]} + part2 ${splitCounts[1]} = ${splitCounts[0]! + splitCounts[1]!} (carried ${plan2.view.carried})`,
);
await applyMerge(saveDir, [{ path: joinPath(saveDir, "merged.d2i"), kind: "stash" }], targets2, DEFAULT_GRID, {
  backupKeep: 5,
  expectCarried: plan2.view.carried,
});
let splitTotal = 0;
for (const name of ["part1.d2i", "part2.d2i"]) {
  const parsed = await parseItemFile(joinPath(saveDir, name));
  if (parsed.kind === "stash") splitTotal += parsed.pages.reduce((n, p) => n + p.items.length, 0);
}
check("split write conserves count", splitTotal === plan2.view.carried, `${splitTotal}/${plan2.view.carried}`);

// ---- 3) 槽位覆盖：预置垃圾文件 → 自动快照含旧内容 ----
await tjs.writeFile(joinPath(saveDir, STASH_FILES.soft), "OLD-STASH-GARBAGE");
const targets3 = [{ slot: "soft" as const, fileName: null, pages: 8, hardcore: false, sharedGold: 0 }];
const plan3 = await planMerge(
  saveDir,
  [{ path: joinPath(saveDir, "part1.d2i"), kind: "stash" }],
  targets3,
  DEFAULT_GRID,
);
check("slot target detected as existing (garbage file)", plan3.view.targets[0]!.exists === true);
const res3 = await applyMerge(
  saveDir,
  [{ path: joinPath(saveDir, "part1.d2i"), kind: "stash" }],
  targets3,
  DEFAULT_GRID,
  { backupKeep: 5, expectCarried: plan3.view.carried, note: "probe slot overwrite" },
);
check("slot apply produced snapshot", res3.backupId !== null);
if (res3.backupId) {
  const snap = await tjs.readFile(
    joinPath(APPDATA, "com.zyj.d2rbox", "backups", res3.backupId, "slots", "root", STASH_FILES.soft),
  );
  check("snapshot holds pre-overwrite bytes", new TextDecoder().decode(snap) === "OLD-STASH-GARBAGE");
  const metas = (await listBackups()).backups;
  check("backup meta trigger=stash", metas.find((b) => b.id === res3.backupId)?.trigger === "stash");
}
const slotParsed = await parseItemFile(joinPath(saveDir, STASH_FILES.soft));
check(
  "slot file rewritten and parses",
  slotParsed.kind === "stash" && slotParsed.pages.reduce((n, p) => n + p.items.length, 0) === plan3.view.carried,
);

// 清理沙盒
await tjs.remove(SB, { recursive: true, maxRetries: 3, retryDelay: 200 });
console.log(failed === 0 ? "ALL PASS" : `${failed} CHECK(S) FAILED`);
if (failed > 0) throw new Error("probe failed");
