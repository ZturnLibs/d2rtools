/**
 * M6 — zip 压缩备份 + config 配置快照 测试：
 *  - zip 往返（root / mods 槽），root 槽排除 mods\ 语义在 zip 模式同样生效
 *  - 混合存储：文件夹旧备份与 zip 新备份并列 list / 各自 restore
 *  - config 伪槽：只收 Settings.json / lootfilter.json / *.fltr，
 *    restore 覆盖写回且绝不碰 .d2s
 *  - zip-slip 防护、>256MB 守卫（mock stat）、prune 混合格式按签名保留
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { zipSync } from "fflate";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath, pathExists } from "../src/services/paths.js";
import {
  createBackup,
  restoreBackup,
  listBackups,
  pruneBackups,
  isSaveSlot,
  type BackupMeta,
} from "../src/services/saves.js";
import { zipDir, unzipToDir } from "../src/services/zip.js";

let sb: TestSandbox;
let saveDir: string;
let backupsDir: string;

async function write(rel: string, content: string): Promise<void> {
  const p = joinPath(saveDir, rel);
  await tjs.makeDir(p.slice(0, p.lastIndexOf("\\")), { recursive: true });
  await tjs.writeFile(p, new TextEncoder().encode(content));
}

async function readStr(rel: string): Promise<string> {
  return fsp.readFile(joinPath(saveDir, rel), "utf8");
}

async function backupDirOf(id: string): Promise<string> {
  return joinPath(backupsDir, id);
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
  backupsDir = joinPath(sb.appdata, "com.zyj.d2rbox", "backups");
});

afterEach(async () => {
  await sb.cleanup();
});

function find(backups: BackupMeta[], id: string): BackupMeta {
  const b = backups.find((x) => x.id === id);
  if (!b) throw new Error(`backup ${id} not listed`);
  return b;
}

// ---------------------------------------------------------------------------
// isSaveSlot
// ---------------------------------------------------------------------------

describe("isSaveSlot (config)", () => {
  it("accepts root / mods\<name> / config, rejects junk", () => {
    expect(isSaveSlot("root")).toBe(true);
    expect(isSaveSlot("config")).toBe(true);
    expect(isSaveSlot("mods/EJ")).toBe(true);
    expect(isSaveSlot("CONFIG")).toBe(false);
    expect(isSaveSlot("../x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// zip 往返
// ---------------------------------------------------------------------------

describe("zip-format backup round-trip", () => {
  it("root slot: slots\\root.zip is written, restore is byte-exact, mods\\ untouched", async () => {
    await write("Settings.json", "SETTINGS-V1");
    await write("Amazon.d2s", "CHAR-V1");
    await write("mods\\EJ\\EJChar.d2s", "EJ-V1");

    const b = await createBackup({
      saveDir, slots: ["root"], trigger: "manual", backupKeep: 10, zip: true,
    });
    const dir = await backupDirOf(b.id);
    expect(await pathExists(joinPath(dir, "slots", "root.zip"))).toBe(true);
    expect(await pathExists(joinPath(dir, "slots", "root"))).toBe(false); // 无文件夹槽
    const meta = find((await listBackups()).backups, b.id);
    expect(meta.zip).toBe(true);
    expect(meta.size).toBeGreaterThan(0);

    // root.zip 不含 mods\：解压清单核对
    const probe = joinPath(sb.root, "probe-root");
    await unzipToDir(joinPath(dir, "slots", "root.zip"), probe);
    const names = await fsp.readdir(probe);
    expect(names).toContain("Settings.json");
    expect(names).toContain("Amazon.d2s");
    expect(names).not.toContain("mods");

    // 篡改主存档与 mod 存档
    await write("Settings.json", "SETTINGS-TAMPERED");
    await write("Amazon.d2s", "CHAR-TAMPERED");
    await write("mods\\EJ\\EJChar.d2s", "EJ-TAMPERED");

    const r = await restoreBackup({ id: b.id, saveDir, backupKeep: 10 });
    expect(r.ok).toBe(true);
    expect(r.preRestoreId).not.toBeNull(); // 还原前自动备份
    expect(await readStr("Settings.json")).toBe("SETTINGS-V1");
    expect(await readStr("Amazon.d2s")).toBe("CHAR-V1");
    // root 槽还原不清 mods\（zip 模式与文件夹语义一致）
    expect(await readStr("mods\\EJ\\EJChar.d2s")).toBe("EJ-TAMPERED");
    // 解压临时目录已清理
    expect((await fsp.readdir(joinPath(dir, "slots"))).filter((n) => n.startsWith(".tmp-unzip-"))).toEqual([]);
  });

  it("mods slot: zip round-trip restores the mod save dir", async () => {
    await write("mods\\EJ\\EJChar.d2s", "EJ-V1");
    const b = await createBackup({
      saveDir, slots: ["mods/EJ"], trigger: "manual", backupKeep: 10, zip: true,
    });
    const dir = await backupDirOf(b.id);
    expect(await pathExists(joinPath(dir, "slots", "EJ.zip"))).toBe(true);

    await write("mods\\EJ\\EJChar.d2s", "EJ-TAMPERED");
    await restoreBackup({ id: b.id, saveDir, backupKeep: 10 });
    expect(await readStr("mods\\EJ\\EJChar.d2s")).toBe("EJ-V1");
  });

  it("multi-slot zip backup restores every slot", async () => {
    await write("Amazon.d2s", "CHAR-V1");
    await write("mods\\EJ\\EJChar.d2s", "EJ-V1");
    const b = await createBackup({
      saveDir, slots: ["root", "mods/EJ"], trigger: "manual", backupKeep: 10, zip: true,
    });
    await write("Amazon.d2s", "CHAR-X");
    await write("mods\\EJ\\EJChar.d2s", "EJ-X");
    await restoreBackup({ id: b.id, saveDir, backupKeep: 10 });
    expect(await readStr("Amazon.d2s")).toBe("CHAR-V1");
    expect(await readStr("mods\\EJ\\EJChar.d2s")).toBe("EJ-V1");
  });
});

// ---------------------------------------------------------------------------
// 混合存储
// ---------------------------------------------------------------------------

describe("mixed folder/zip storage", () => {
  it("old folder backup and new zip backup coexist, list formats, each restores", async () => {
    await write("Settings.json", "V1");
    const oldB = await createBackup({
      saveDir, slots: ["root"], trigger: "manual", backupKeep: 10, zip: false,
    });
    expect(await pathExists(joinPath(await backupDirOf(oldB.id), "slots", "root"))).toBe(true);

    await write("Settings.json", "V2");
    const newB = await createBackup({
      saveDir, slots: ["root"], trigger: "manual", backupKeep: 10, zip: true,
    });

    const { backups } = await listBackups();
    expect(find(backups, oldB.id).zip).toBe(false);
    expect(find(backups, newB.id).zip).toBe(true);

    // 文件夹旧备份还原 V1
    await write("Settings.json", "V3");
    await restoreBackup({ id: oldB.id, saveDir, backupKeep: 10 });
    expect(await readStr("Settings.json")).toBe("V1");

    // zip 新备份还原 V2
    await restoreBackup({ id: newB.id, saveDir, backupKeep: 10 });
    expect(await readStr("Settings.json")).toBe("V2");
  });
});

// ---------------------------------------------------------------------------
// config 槽
// ---------------------------------------------------------------------------

describe("config slot", () => {
  async function seed(): Promise<void> {
    await write("Settings.json", "SETTINGS-V1");
    await write("lootfilter.json", "LOOTFILTER-V1");
    await write("新手 - 亚马逊.fltr", "FLTR-V1");
    await write("Amazon.d2s", "CHAR-V1");
    await write("mods\\EJ\\x.d2s", "EJ-V1");
  }

  it("collects only the manifest (zip format) — no .d2s, not even under mods\\", async () => {
    await seed();
    const b = await createBackup({
      saveDir, slots: ["config"], trigger: "manual", backupKeep: 10, zip: true,
    });
    const probe = joinPath(sb.root, "probe-config");
    await unzipToDir(joinPath(await backupDirOf(b.id), "slots", "config.zip"), probe);
    expect((await fsp.readdir(probe)).sort()).toEqual(
      ["Settings.json", "lootfilter.json", "新手 - 亚马逊.fltr"].sort(),
    );
  });

  it("collects only the manifest (folder format)", async () => {
    await seed();
    const b = await createBackup({
      saveDir, slots: ["config"], trigger: "manual", backupKeep: 10, zip: false,
    });
    const slotDir = joinPath(await backupDirOf(b.id), "slots", "config");
    expect((await fsp.readdir(slotDir)).sort()).toEqual(
      ["Settings.json", "lootfilter.json", "新手 - 亚马逊.fltr"].sort(),
    );
  });

  it("restore overlays manifest files only, characters untouched (zip format)", async () => {
    await seed();
    const charBefore = await readStr("Amazon.d2s");
    const b = await createBackup({
      saveDir, slots: ["config"], trigger: "manual", backupKeep: 10, zip: true,
    });

    await write("Settings.json", "SETTINGS-TAMPERED");
    await write("lootfilter.json", "LOOTFILTER-TAMPERED");
    await write("新手 - 亚马逊.fltr", "FLTR-TAMPERED");
    await write("Amazon.d2s", "CHAR-TAMPERED"); // 模拟改动后的角色
    const charTampered = await readStr("Amazon.d2s");

    await restoreBackup({ id: b.id, saveDir, backupKeep: 10 });

    expect(await readStr("Settings.json")).toBe("SETTINGS-V1");
    expect(await readStr("lootfilter.json")).toBe("LOOTFILTER-V1");
    expect(await readStr("新手 - 亚马逊.fltr")).toBe("FLTR-V1");
    expect(await readStr("Amazon.d2s")).toBe(charTampered); // 角色不碰
    expect(charTampered).not.toBe(charBefore);
  });

  it("restore overlays manifest files only (folder format)", async () => {
    await seed();
    const b = await createBackup({
      saveDir, slots: ["config"], trigger: "manual", backupKeep: 10, zip: false,
    });
    await write("Settings.json", "SETTINGS-TAMPERED");
    const charTampered = await readStr("Amazon.d2s");
    await restoreBackup({ id: b.id, saveDir, backupKeep: 10 });
    expect(await readStr("Settings.json")).toBe("SETTINGS-V1");
    expect(await readStr("Amazon.d2s")).toBe(charTampered);
  });
});

// ---------------------------------------------------------------------------
// zip-slip 防护
// ---------------------------------------------------------------------------

describe("zip-slip guard", () => {
  it("rejects .. and drive-letter entries before writing anything", async () => {
    const evil = zipSync({
      "../evil.txt": new TextEncoder().encode("pwn"),
      "C:/evil.txt": new TextEncoder().encode("pwn"),
      "ok.txt": new TextEncoder().encode("fine"),
    });
    const zipPath = joinPath(sb.root, "evil.zip");
    await tjs.writeFile(zipPath, evil);
    const out = joinPath(sb.root, "unzipped");
    await expect(unzipToDir(zipPath, out)).rejects.toThrow(/不安全路径/);
    expect(await pathExists(out)).toBe(false); // 校验先行，什么都没写
  });
});

// ---------------------------------------------------------------------------
// >256MB 守卫
// ---------------------------------------------------------------------------

describe("zipDir size guard", () => {
  it("throws on a >256MB file (stat size mocked, nothing big written)", async () => {
    await write("big.bin", "tiny");
    await write("small.txt", "ok");
    const zipPath = joinPath(sb.root, "out.zip");

    const realStat = tjs.stat.bind(tjs);
    const patched = async (p: string) => {
      const st = await realStat(p);
      if (p.endsWith("big.bin")) return { ...st, size: 300 * 1024 * 1024 };
      return st;
    };
    (tjs as unknown as { stat: typeof tjs.stat }).stat = patched;
    try {
      await expect(zipDir(saveDir, zipPath)).rejects.toThrow(/文件过大/);
    } finally {
      (tjs as unknown as { stat: typeof tjs.stat }).stat = realStat;
    }
    expect(await pathExists(zipPath)).toBe(false);
    expect(await pathExists(`${zipPath}.tmp`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prune 混合格式
// ---------------------------------------------------------------------------

describe("pruneBackups with mixed formats", () => {
  it("keeps newest N per signature regardless of format", async () => {
    await write("Settings.json", "V1");
    const r1 = await createBackup({ saveDir, slots: ["root"], trigger: "manual", backupKeep: 10, zip: false });
    await write("Settings.json", "V2");
    const r2 = await createBackup({ saveDir, slots: ["root"], trigger: "manual", backupKeep: 10, zip: true });
    await write("Settings.json", "V3");
    const r3 = await createBackup({ saveDir, slots: ["root"], trigger: "manual", backupKeep: 10, zip: false });
    const c1 = await createBackup({ saveDir, slots: ["config"], trigger: "manual", backupKeep: 10, zip: true });

    await pruneBackups(1);

    const { backups } = await listBackups();
    const rootLeft = backups.filter((b) => b.signature === "root");
    expect(rootLeft.map((b) => b.id)).toEqual([r3.id]);
    const cfgLeft = backups.filter((b) => b.signature === "config");
    expect(cfgLeft.map((b) => b.id)).toEqual([c1.id]);
    // 留下的 zip 备份仍可正常还原
    await write("Settings.json", "VX");
    await restoreBackup({ id: r3.id, saveDir, backupKeep: 10 });
    expect(await readStr("Settings.json")).toBe("V3");
    void r1;
    void r2;
  });
});
