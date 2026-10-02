/**
 * M2 probe — full 存档管家/仓库向导 backend flow against a SANDBOX save dir
 * under tmp (never touches the real save tree), plus a read-only overview of
 * the real save root. Run: node scripts/run-probe.mjs phase4-probe.ts
 */
import {
  scanSaveOverview,
  createBackup,
  restoreBackup,
  listBackups,
  deleteBackup,
  setBackupNote,
  pruneBackups,
  isGameRunning,
  isSaveSlot,
  backupsRoot,
} from "../src/services/saves.js";
import { stashPreflight, stashReplace } from "../src/services/stash.js";
import { saveRoot, joinPath, pathExists } from "../src/services/paths.js";

// The probe writes real snapshots into %APPDATA%\...\backups — remember the
// pre-existing ids so cleanup can remove everything created here.
const preExisting = new Set((await listBackups()).backups.map((b) => b.id));

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

// -- sandbox save tree -------------------------------------------------------
const sb = joinPath(tjs.tmpDir, `d2rbox-m2probe-${Date.now()}`);
const sbMods = joinPath(sb, "mods");
await tjs.makeDir(sbMods, { recursive: true });
await tjs.makeDir(joinPath(sb, "手工备份"), { recursive: true });
await tjs.makeDir(joinPath(sbMods, "EJ"), { recursive: true });
await tjs.writeFile(joinPath(sb, "Hero.d2s"), new TextEncoder().encode("HERO-V1"));
await tjs.writeFile(joinPath(sb, "Settings.json"), new TextEncoder().encode("{}"));
await tjs.writeFile(joinPath(sb, "SharedStashSoftCoreV2.d2i"), new TextEncoder().encode("STASH-OLD"));
await tjs.writeFile(joinPath(sb, "手工备份", "x.d2i"), new TextEncoder().encode("OLD-MANUAL"));
await tjs.writeFile(joinPath(sbMods, "EJ", "a.d2s"), new TextEncoder().encode("EJ-A"));

// -- 1. slot grammar ---------------------------------------------------------
check("slot root valid", isSaveSlot("root"));
check("slot mods/EJ valid", isSaveSlot("mods/EJ"));
check("slot traversal rejected", !isSaveSlot("mods/../.."));
check("slot junk rejected", !isSaveSlot("mods/a\\b"));

// -- 2. overview (sandbox) ---------------------------------------------------
const ov = await scanSaveOverview(sb, ["EJ", "Ghost"]);
check("overview root exists", ov.root.exists);
check("overview root files=3", ov.root.files.length === 3, ov.root.files.map((f) => f.name));
check("overview root dirs=1 (手工备份)", ov.root.dirs.length === 1 && ov.root.dirs[0]?.name === "手工备份");
check("overview EJ group exists", ov.mods.find((m) => m.name === "EJ")?.exists === true);
check("overview Ghost group not-exists", ov.mods.find((m) => m.name === "Ghost")?.exists === false);

// -- 3. real saveRoot overview (READ-ONLY) ------------------------------------
const real = await scanSaveOverview(await saveRoot(), []);
console.log(
  `INFO real saveRoot: files=${real.root.files.length} dirs=${real.root.dirs.map((d) => d.name).join(",")} modGroups=${real.mods.length} totalBytes=${real.root.totalBytes}`,
);

// -- 4. backup + mutate + restore ---------------------------------------------
const bak = await createBackup({
  saveDir: sb,
  slots: ["root", "mods/EJ"],
  note: "probe base",
  trigger: "manual",
  backupKeep: 5,
});
check("backup files=5", bak.files === 5, bak); // 3 root files + 手工备份/x.d2i + EJ/a.d2s
check("backup signature", bak.signature === "mods/EJ+root", bak.signature);
check("root snapshot excludes mods\\", !(await pathExists(joinPath(backupsRoot(), bak.id, "slots", "root", "mods"))));
check("snapshot preserves subdir layout", await pathExists(joinPath(backupsRoot(), bak.id, "slots", "root", "手工备份", "x.d2i")));

await tjs.writeFile(joinPath(sb, "Hero.d2s"), new TextEncoder().encode("HERO-V2-MUCH-LONGER"));
await tjs.remove(joinPath(sb, "Settings.json"));
await tjs.writeFile(joinPath(sbMods, "EJ", "b.d2s"), new TextEncoder().encode("EJ-B-NEW"));
await tjs.writeFile(joinPath(sb, "SharedStashSoftCoreV2.d2i"), new TextEncoder().encode("STASH-DIRTY"));

const restore = await restoreBackup({ id: bak.id, saveDir: sb, backupKeep: 5 });
check("restore ok", restore.ok);
check("restore made pre-restore snapshot", restore.preRestoreId !== null);
check("root file content rolled back", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "Hero.d2s"))) === "HERO-V1");
check("root deleted file restored", await pathExists(joinPath(sb, "Settings.json")));
check("stash file rolled back", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "SharedStashSoftCoreV2.d2i"))) === "STASH-OLD");
check("mod save dir mirrored", !(await pathExists(joinPath(sbMods, "EJ", "b.d2s"))));
check("mods subtree survived root restore", await pathExists(joinPath(sbMods, "EJ", "a.d2s")));
check("手工备份 dir survived", await pathExists(joinPath(sb, "手工备份", "x.d2i")));

// -- 5. prune: keep=2 per signature -------------------------------------------
await createBackup({ saveDir: sb, slots: ["root"], note: "", trigger: "manual", backupKeep: 2 });
await createBackup({ saveDir: sb, slots: ["root"], note: "", trigger: "manual", backupKeep: 2 });
const afterPrune = await listBackups();
const rootOnly = afterPrune.backups.filter((b) => b.signature === "root");
check("prune keeps 2 per signature", rootOnly.length === 2, rootOnly.length);

// -- 6. note + delete ----------------------------------------------------------
if (rootOnly[0]) {
  await setBackupNote(rootOnly[0].id, "标注过的");
  const re = await listBackups();
  check("note persisted", re.backups.find((b) => b.id === rootOnly[0].id)?.note === "标注过的");
  await deleteBackup(rootOnly[0].id);
  const re2 = await listBackups();
  check("delete removes snapshot", !re2.backups.some((b) => b.id === rootOnly[0].id));
}

// -- 7. stash wizard ------------------------------------------------------------
const authorPath = joinPath(sb, "author.d2i");
await tjs.writeFile(authorPath, new TextEncoder().encode("AUTHOR-STASH-CONTENT"));
const pre = await stashPreflight(sb, "soft");
check("stash preflight sees current", pre.exists && pre.size === "STASH-OLD".length, pre);
check("stash preflight game not running", pre.gameRunning === false);

const rep = await stashReplace({ saveDir: sb, slot: "soft", sourcePath: authorPath, note: "", backupKeep: 5 });
check("stash replace ok", rep.ok && rep.replaced);
check("stash replace made rollback snapshot", rep.backupId !== null);
check("stash target now author content", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "SharedStashSoftCoreV2.d2i"))) === "AUTHOR-STASH-CONTENT");
const post = await stashPreflight(sb, "soft");
check("stash preflight shows new size", post.size === "AUTHOR-STASH-CONTENT".length);

// -- 8. game process probe (real, read-only) -----------------------------------
check("isGameRunning false (game closed)", (await isGameRunning()) === false);

// -- cleanup --------------------------------------------------------------------
await tjs.remove(sb, { recursive: true, maxRetries: 3, retryDelay: 200 });
check("sandbox cleaned", !(await pathExists(sb)));

// remove every snapshot this probe created (incl. prune-survivors and
// pre-restore points); pre-existing user backups are never touched
for (const b of await listBackups().then((r) => r.backups)) {
  if (!preExisting.has(b.id)) await deleteBackup(b.id).catch(() => undefined);
}
check("backup store cleaned", (await listBackups()).backups.every((b) => preExisting.has(b.id)));

console.log(failures === 0 ? "\nPROBE_ALL_PASS" : `\nPROBE_FAILURES=${failures}`);
