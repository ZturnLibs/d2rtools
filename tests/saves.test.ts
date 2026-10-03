import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath, pathExists } from "../src/services/paths.js";
import {
  createBackup,
  listBackups,
  restoreBackup,
  pruneBackups,
  setBackupNote,
  deleteBackup,
  backupsRoot,
  scanSaveOverview,
  isSaveSlot,
} from "../src/services/saves.js";

let sb: TestSandbox;
let saveDir: string;

async function readText(p: string): Promise<string> {
  return fsp.readFile(p, "utf8");
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(joinPath(saveDir, "手工备份"), { recursive: true });
  await tjs.makeDir(joinPath(saveDir, "mods", "EJ"), { recursive: true });
  await tjs.writeFile(joinPath(saveDir, "Hero.d2s"), "HERO-V1");
  await tjs.writeFile(joinPath(saveDir, "Settings.json"), "{}");
  await tjs.writeFile(joinPath(saveDir, "手工备份", "x.d2i"), "OLD-MANUAL");
  await tjs.writeFile(joinPath(saveDir, "mods", "EJ", "a.d2s"), "EJ-A");
});

afterEach(async () => {
  await sb.cleanup();
});

describe("isSaveSlot", () => {
  it("accepts root and mods/<name>, rejects traversal and junk", () => {
    expect(isSaveSlot("root")).toBe(true);
    expect(isSaveSlot("mods/EJ")).toBe(true);
    expect(isSaveSlot("mods/../..")).toBe(false);
    expect(isSaveSlot("mods/a\\b")).toBe(false);
    expect(isSaveSlot("mods/")).toBe(false);
    expect(isSaveSlot("")).toBe(false);
  });
});

describe("scanSaveOverview", () => {
  it("reports root files, non-mods subdirs and known/unknown mod groups", async () => {
    const ov = await scanSaveOverview(saveDir, ["EJ", "Ghost"]);
    expect(ov.root.exists).toBe(true);
    expect(ov.root.files.map((f) => f.name).sort()).toEqual([
      "Hero.d2s",
      "Settings.json",
    ]);
    expect(ov.root.dirs.map((d) => d.name)).toEqual(["手工备份"]);
    const ej = ov.mods.find((m) => m.name === "EJ");
    const ghost = ov.mods.find((m) => m.name === "Ghost");
    expect(ej?.exists).toBe(true);
    expect(ghost?.exists).toBe(false); // known but not created yet
    expect(ej?.files.map((f) => f.name)).toEqual(["a.d2s"]);
  });
});

describe("backup / restore lifecycle", () => {
  it("createBackup copies slots, excluding mods\\ from root scope", async () => {
    const bak = await createBackup({
      saveDir,
      slots: ["root", "mods/EJ"],
      note: "base",
      trigger: "manual",
      backupKeep: 5,
    });
    expect(bak.files).toBe(4); // 2 root files + 手工备份/x.d2i + EJ/a.d2s
    expect(bak.signature).toBe("mods/EJ+root");
    const dir = joinPath(backupsRoot(), bak.id);
    expect(await pathExists(joinPath(dir, "slots", "root", "Hero.d2s"))).toBe(true);
    // mods\ must NOT be snapshotted inside the root slot
    expect(await pathExists(joinPath(dir, "slots", "root", "mods"))).toBe(false);
    // subdir layout preserved
    expect(await readText(joinPath(dir, "slots", "root", "手工备份", "x.d2i"))).toBe("OLD-MANUAL");
    expect(await readText(joinPath(dir, "slots", "EJ", "a.d2s"))).toBe("EJ-A");
  });

  it("rejects empty slot list and nonexistent sources", async () => {
    await expect(
      createBackup({ saveDir, slots: [], trigger: "manual", backupKeep: 5 }),
    ).rejects.toThrow(/未选择/);
    await expect(
      createBackup({ saveDir, slots: ["mods/Ghost"], trigger: "manual", backupKeep: 5 }),
    ).rejects.toThrow(/不存在/);
    await expect(
      createBackup({ saveDir, slots: ["mods/../x"], trigger: "manual", backupKeep: 5 }),
    ).rejects.toThrow(/非法/);
  });

  it("restore rolls back mutated/deleted files and mirrors the mod slot", async () => {
    const bak = await createBackup({
      saveDir,
      slots: ["root", "mods/EJ"],
      note: "",
      trigger: "manual",
      backupKeep: 5,
    });

    // mutate: change one file, delete one, add one in each scope
    await tjs.writeFile(joinPath(saveDir, "Hero.d2s"), "HERO-V2-MUCH-LONGER");
    await tjs.remove(joinPath(saveDir, "Settings.json"));
    await tjs.writeFile(joinPath(saveDir, "SharedStashSoftCoreV2.d2i"), "STASH-DIRTY");
    await tjs.writeFile(joinPath(saveDir, "mods", "EJ", "b.d2s"), "EJ-B-NEW");

    const res = await restoreBackup({ id: bak.id, saveDir, backupKeep: 5 });
    expect(res.ok).toBe(true);
    // mandatory pre-restore snapshot was taken
    expect(res.preRestoreId).not.toBeNull();
    expect(res.preRestoreId).not.toBe(bak.id);

    expect(await readText(joinPath(saveDir, "Hero.d2s"))).toBe("HERO-V1");
    expect(await pathExists(joinPath(saveDir, "Settings.json"))).toBe(true);
    // files added after the backup are gone (mirror restore)
    expect(await pathExists(joinPath(saveDir, "SharedStashSoftCoreV2.d2i"))).toBe(false);
    // mod slot mirrored too: b.d2s removed, a.d2s intact
    expect(await pathExists(joinPath(saveDir, "mods", "EJ", "b.d2s"))).toBe(false);
    expect(await readText(joinPath(saveDir, "mods", "EJ", "a.d2s"))).toBe("EJ-A");
    // root restore protects live mods\ subtree
    expect(await pathExists(joinPath(saveDir, "mods", "EJ"))).toBe(true);
    // non-mods subdir survives
    expect(await readText(joinPath(saveDir, "手工备份", "x.d2i"))).toBe("OLD-MANUAL");
  });

  it("pre-restore snapshot captures the dirty state (undo path works)", async () => {
    const bak = await createBackup({
      saveDir,
      slots: ["root"],
      note: "",
      trigger: "manual",
      backupKeep: 5,
    });
    await tjs.writeFile(joinPath(saveDir, "Hero.d2s"), "HERO-DIRTY");
    const res = await restoreBackup({ id: bak.id, saveDir, backupKeep: 5 });
    // restore returned the tree to HERO-V1; the pre-restore snapshot holds HERO-DIRTY
    expect(await readText(joinPath(saveDir, "Hero.d2s"))).toBe("HERO-V1");
    const pre = await listBackups();
    const preMeta = pre.backups.find((b) => b.id === res.preRestoreId);
    expect(preMeta?.trigger).toBe("pre-restore");
    expect(preMeta?.note).toContain(bak.id);
    const preContent = await readText(
      joinPath(backupsRoot(), res.preRestoreId!, "slots", "root", "Hero.d2s"),
    );
    expect(preContent).toBe("HERO-DIRTY");
  });

  it("restoring a nonexistent backup id throws", async () => {
    await expect(
      restoreBackup({ id: "bak_nope123", saveDir, backupKeep: 5 }),
    ).rejects.toThrow(/不存在/);
  });
});

describe("listBackups / setBackupNote / deleteBackup", () => {
  it("lists newest first, persists notes, deletes by id", async () => {
    const a = await createBackup({ saveDir, slots: ["root"], note: "", trigger: "manual", backupKeep: 10 });
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct createdAt
    const b = await createBackup({ saveDir, slots: ["root"], note: "", trigger: "manual", backupKeep: 10 });
    const { dir, backups } = await listBackups();
    expect(dir).toBe(joinPath(sb.appdata, "com.zyj.d2rbox", "backups"));
    expect(backups.map((x) => x.id)).toEqual([b.id, a.id]);

    await setBackupNote(a.id, "  标注过的  ");
    expect((await listBackups()).backups.find((x) => x.id === a.id)?.note).toBe("标注过的");

    await deleteBackup(a.id);
    const after = await listBackups();
    expect(after.backups.some((x) => x.id === a.id)).toBe(false);
    expect(after.backups.some((x) => x.id === b.id)).toBe(true);
    await expect(deleteBackup(a.id)).rejects.toThrow(/不存在/);
    await expect(setBackupNote("bak_missing1", "x")).rejects.toThrow(/不存在/);
  });
});

describe("pruneBackups", () => {
  it("keeps the newest N per scope signature and drops the oldest", async () => {
    const keep = 3;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await createBackup({ saveDir, slots: ["root"], note: `n${i}`, trigger: "manual", backupKeep: keep });
      ids.push(b.id);
    }
    const rootOnly = (await listBackups()).backups.filter((b) => b.signature === "root");
    expect(rootOnly.length).toBe(keep);
    // newest survive, oldest pruned
    expect(rootOnly.map((b) => b.id)).not.toContain(ids[0]);
    expect(rootOnly.map((b) => b.id)).toContain(ids[4]);
  });

  it("prunes per signature independently", async () => {
    for (let i = 0; i < 3; i++) {
      await createBackup({ saveDir, slots: ["root"], note: "", trigger: "manual", backupKeep: 2 });
      await createBackup({ saveDir, slots: ["mods/EJ"], note: "", trigger: "manual", backupKeep: 2 });
    }
    const all = (await listBackups()).backups;
    expect(all.filter((b) => b.signature === "root").length).toBe(2);
    expect(all.filter((b) => b.signature === "mods/EJ").length).toBe(2);
  });

  it("ignores keep < 1", async () => {
    const before = (await listBackups()).backups.length;
    await pruneBackups(0);
    await pruneBackups(Number.NaN);
    expect((await listBackups()).backups.length).toBe(before);
  });
});
