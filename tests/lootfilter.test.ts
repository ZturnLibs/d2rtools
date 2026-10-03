/**
 * 掉落过滤 (M5) service tests — run against the sandboxed save root.
 * Covers list/read (BOM / no BOM / broken JSON), updatePreset (enabled
 * write-back, untouched fields, BOM + 4-space indent preservation, no tmp
 * leftovers, byte-exact backups), the backup chain (list/restore/delete),
 * duplicate/rename/delete and summarizeRule.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath, pathExists } from "../src/services/paths.js";
import {
  listPresets,
  readPreset,
  updatePreset,
  summarizeRule,
  listPresetBackups,
  restorePresetBackup,
  deletePresetBackup,
  duplicatePreset,
  renamePreset,
  deletePreset,
  isValidPresetName,
} from "../src/services/lootfilter.js";

let sb: TestSandbox;
let saveDir: string;

const FILE_A = "新手 - 亚马逊.fltr";
const FILE_B = "进阶.fltr";

const SAMPLE = {
  name: "新手 - 亚马逊",
  rules: [
    {
      name: "隐藏全部",
      enabled: false,
      ruleType: "hide",
      filterEtherealSocketed: true,
      equipmentRarity: ["rare", "lowQuality", "magic", "unique", "set", "hiQuality", "normal"],
      equipmentQuality: ["normal", "exceptional", "elite"],
      equipmentCategory: ["acce", "armo", "weap"],
      itemCategory: ["misc"],
    },
    { name: "显示暗金", enabled: true, ruleType: "show", filterEtherealSocketed: false, equipmentRarity: ["unique"] },
    { name: "显示符文", enabled: false, ruleType: "show", filterEtherealSocketed: false, itemCategory: ["runes"] },
  ],
};

function encode(obj: unknown, bom = false, trailingNewline = false): Uint8Array {
  let text = JSON.stringify(obj, null, 4);
  if (trailingNewline) text += "\n";
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(3 + body.length);
  out[0] = 0xef;
  out[1] = 0xbb;
  out[2] = 0xbf;
  out.set(body, 3);
  return out;
}

async function writePreset(file: string, bytes: Uint8Array): Promise<void> {
  await tjs.writeFile(joinPath(saveDir, file), bytes);
}

async function readBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await fsp.readFile(joinPath(saveDir, file)));
}

/** readBytes for absolute paths (e.g. inside the backup store). */
async function readBytesAbs(p: string): Promise<Uint8Array> {
  return new Uint8Array(await fsp.readFile(p));
}

async function readText(file: string): Promise<string> {
  return fsp.readFile(joinPath(saveDir, file), "utf8");
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

// ---------------------------------------------------------------------------
// isValidPresetName
// ---------------------------------------------------------------------------

describe("isValidPresetName", () => {
  it("accepts plain .fltr names, rejects separators / dots / no extension", () => {
    expect(isValidPresetName("新手 - 亚马逊.fltr")).toBe(true);
    expect(isValidPresetName("a.fltr")).toBe(true);
    expect(isValidPresetName("a.fltr ")).toBe(false); // 末尾空格不属于 .fltr 后缀
    expect(isValidPresetName("..\\x.fltr")).toBe(false);
    expect(isValidPresetName("a/b.fltr")).toBe(false);
    expect(isValidPresetName("a:b.fltr")).toBe(false);
    expect(isValidPresetName(".fltr")).toBe(false);
    expect(isValidPresetName("a.txt")).toBe(false);
    expect(isValidPresetName("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listPresets / readPreset
// ---------------------------------------------------------------------------

describe("listPresets / readPreset", () => {
  it("lists presets sorted by name with counts and stat info", async () => {
    await writePreset(FILE_B, encode({ name: "进阶", rules: [{ name: "r", enabled: true, ruleType: "show" }] }));
    await writePreset(FILE_A, encode(SAMPLE));
    const presets = await listPresets();
    expect(presets.map((p) => p.name)).toEqual(["进阶", "新手 - 亚马逊"]); // zh-Hans-CN 拼音序
    const a = presets[1]!;
    expect(a.file).toBe(FILE_A);
    expect(a.ruleCount).toBe(3);
    expect(a.enabledCount).toBe(1);
    expect(a.size).toBeGreaterThan(0);
    expect(a.mtime).toBeGreaterThan(0);
  });

  it("returns empty list when the save root is missing", async () => {
    await tjs.remove(saveDir, { recursive: true });
    expect(await listPresets()).toEqual([]);
  });

  it("reads a BOM file, stripping the BOM and keeping every rule field", async () => {
    await writePreset(FILE_A, encode(SAMPLE, true));
    const r = await readPreset(FILE_A);
    expect(r.warning).toBeNull();
    expect(r.name).toBe("新手 - 亚马逊");
    expect(r.rules).toHaveLength(3);
    expect(r.rules[0]!.equipmentRarity).toEqual(SAMPLE.rules[0]!.equipmentRarity);
    expect(r.rules[0]!.filterEtherealSocketed).toBe(true);
    expect(r.rules[1]!.enabled).toBe(true);
  });

  it("reads a no-BOM, trailing-newline file", async () => {
    await writePreset(FILE_A, encode(SAMPLE, false, true));
    const r = await readPreset(FILE_A);
    expect(r.warning).toBeNull();
    expect(r.rules).toHaveLength(3);
  });

  it("broken JSON yields a warning instead of throwing", async () => {
    await writePreset(FILE_A, new TextEncoder().encode("{ not json !!!"));
    const r = await readPreset(FILE_A);
    expect(r.rules).toEqual([]);
    expect(r.warning).toBeTruthy();
    expect(r.name).toBe("新手 - 亚马逊"); // 文件名兜底
  });

  it("throws for a missing file and rejects path-escape names", async () => {
    await expect(readPreset("ghost.fltr")).rejects.toThrow(/不存在/);
    await expect(readPreset("..\\evil.fltr")).rejects.toThrow(/非法预设文件名/);
    await expect(listPresets()).resolves.toEqual([]); // 逃逸文件不会被列出
  });
});

// ---------------------------------------------------------------------------
// updatePreset
// ---------------------------------------------------------------------------

describe("updatePreset", () => {
  it("writes enabled flags back and preserves everything else", async () => {
    const original = encode(SAMPLE, true);
    await writePreset(FILE_A, original);

    const r = await updatePreset(FILE_A, [
      { index: 0, enabled: true },
      { index: 2, enabled: true },
    ]);
    expect(r.changed).toBe(2);
    expect(r.gameRunning).toBe(false); // spawn stubbed → probe fails → not running
    expect(r.backedUp).toMatch(/^\d{8}-\d{6}$/);

    const now = await readPreset(FILE_A);
    expect(now.rules[0]!.enabled).toBe(true);
    expect(now.rules[1]!.enabled).toBe(true); // 未触碰，保持原值
    expect(now.rules[2]!.enabled).toBe(true);
    // 未触碰字段原样保留
    expect(now.rules[0]!.equipmentRarity).toEqual(SAMPLE.rules[0]!.equipmentRarity);
    expect(now.rules[0]!.equipmentCategory).toEqual(SAMPLE.rules[0]!.equipmentCategory);
    expect(now.rules[0]!.itemCategory).toEqual(SAMPLE.rules[0]!.itemCategory);

    const bytes = await readBytes(FILE_A);
    expect(bytes[0]).toBe(0xef); // BOM 保留
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("{")).toBe(true); // TextDecoder 会吞掉前导 BOM
    expect(text).toContain('\n    "rules": [');
    expect(text).not.toMatch(/[\r\n]$/); // 原文无末尾换行 → 写回也没有
  });

  it("keeps a trailing newline when the source had one", async () => {
    await writePreset(FILE_A, encode(SAMPLE, false, true));
    await updatePreset(FILE_A, [{ index: 1, enabled: false }]);
    const text = await readText(FILE_A);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith("{")).toBe(true); // 无 BOM 来源不加 BOM
  });

  it("leaves no tmp file behind and the backup equals the old file byte-for-byte", async () => {
    const original = encode(SAMPLE);
    await writePreset(FILE_A, original);

    const r = await updatePreset(FILE_A, [{ index: 0, enabled: true }]);

    const entries = await fsp.readdir(saveDir);
    expect(entries.filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
    expect(entries).toContain(FILE_A);

    const backup = joinPath(saveDir, "_d2rbox_filter_backups", FILE_A, r.backedUp!);
    expect(await readBytesAbs(backup)).toEqual(original);
  });

  it("refuses to touch an unparsable file (and creates no backup)", async () => {
    await writePreset(FILE_A, new TextEncoder().encode("{ broken"));
    await expect(updatePreset(FILE_A, [{ index: 0, enabled: true }])).rejects.toThrow(/无法解析/);
    expect(await listPresetBackups(FILE_A)).toEqual([]);
  });

  it("ignores out-of-range indexes", async () => {
    await writePreset(FILE_A, encode(SAMPLE));
    const r = await updatePreset(FILE_A, [{ index: 99, enabled: true }]);
    expect(r.changed).toBe(0);
    const now = await readPreset(FILE_A);
    expect(now.rules.every((x) => x.enabled === false || x.name === "显示暗金")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backup chain: list → restore → delete
// ---------------------------------------------------------------------------

describe("preset backups", () => {
  it("list → restore (restored bytes equal old version, current re-backed-up) → delete", async () => {
    const v1 = encode(SAMPLE);
    await writePreset(FILE_A, v1);

    // v1 → toggle → v2
    const upd = await updatePreset(FILE_A, [{ index: 0, enabled: true }]);
    const v2 = await readBytes(FILE_A);
    expect(v2).not.toEqual(v1);

    let backups = await listPresetBackups(FILE_A);
    expect(backups.map((b) => b.name)).toEqual([upd.backedUp]);

    // restore → content equals v1; 当前版本(v2)被再备份
    const res = await restorePresetBackup(FILE_A, upd.backedUp!);
    expect(res.restored).toBe(true);
    expect(res.backedUp).toMatch(/^\d{8}-\d{6}/);
    expect(await readBytes(FILE_A)).toEqual(v1);

    backups = await listPresetBackups(FILE_A);
    expect(backups).toHaveLength(2);
    // 回滚生成的备份内容 = v2
    const preRestore = joinPath(saveDir, "_d2rbox_filter_backups", FILE_A, res.backedUp!);
    expect(await readBytesAbs(preRestore)).toEqual(v2);

    // delete 两个备份
    for (const b of backups) await deletePresetBackup(FILE_A, b.name);
    expect(await listPresetBackups(FILE_A)).toEqual([]);
  });

  it("restore validates the backup name and refuses unknown ones", async () => {
    await writePreset(FILE_A, encode(SAMPLE));
    await expect(restorePresetBackup(FILE_A, "../evil")).rejects.toThrow(/非法备份名/);
    await expect(restorePresetBackup(FILE_A, "20990101-000000")).rejects.toThrow(/备份不存在/);
  });
});

// ---------------------------------------------------------------------------
// duplicate / rename / delete
// ---------------------------------------------------------------------------

describe("duplicate / rename / delete", () => {
  it("duplicate copies content and sets the internal name + new file", async () => {
    await writePreset(FILE_A, encode(SAMPLE, true));
    const r = await duplicatePreset(FILE_A, "我的过滤");
    expect(r.file).toBe("我的过滤.fltr");
    const dup = await readPreset("我的过滤.fltr");
    expect(dup.name).toBe("我的过滤");
    expect(dup.rules).toHaveLength(3);
    expect(dup.rules[0]!.equipmentRarity).toEqual(SAMPLE.rules[0]!.equipmentRarity);
    const dupBytes = await readBytes("我的过滤.fltr");
    expect(dupBytes[0]).toBe(0xef); // BOM 沿用来源
    expect(await readPreset(FILE_A)).toMatchObject({ name: "新手 - 亚马逊" }); // 源不动
  });

  it("duplicate refuses duplicate names and illegal names", async () => {
    await writePreset(FILE_A, encode(SAMPLE));
    await writePreset(FILE_B, encode(SAMPLE));
    await expect(duplicatePreset(FILE_A, "进阶")).rejects.toThrow(/同名/);
    await expect(duplicatePreset(FILE_A, "a/b")).rejects.toThrow(/非法预设名/);
    await expect(duplicatePreset(FILE_A, "x.fltr")).rejects.toThrow(/非法预设名/);
  });

  it("rename moves the file and syncs the internal name", async () => {
    await writePreset(FILE_A, encode(SAMPLE));
    const r = await renamePreset(FILE_A, "老手过滤");
    expect(r.file).toBe("老手过滤.fltr");
    expect(await pathExists(joinPath(saveDir, FILE_A))).toBe(false);
    expect(await pathExists(joinPath(saveDir, "老手过滤.fltr"))).toBe(true);
    const renamed = await readPreset("老手过滤.fltr");
    expect(renamed.name).toBe("老手过滤");
    expect(renamed.rules).toHaveLength(3);
  });

  it("rename rejects same name and existing target", async () => {
    await writePreset(FILE_A, encode(SAMPLE));
    await writePreset(FILE_B, encode(SAMPLE));
    await expect(renamePreset(FILE_A, "新手 - 亚马逊")).rejects.toThrow(/相同/);
    await expect(renamePreset(FILE_A, "进阶")).rejects.toThrow(/同名/);
  });

  it("delete removes the preset from the list but keeps its backup", async () => {
    await writePreset(FILE_A, encode(SAMPLE));
    const before = await readBytes(FILE_A);
    const r = await deletePreset(FILE_A);
    expect(r.backedUp).toMatch(/^\d{8}-\d{6}$/);
    expect((await listPresets()).map((p) => p.file)).toEqual([]);
    const backup = joinPath(saveDir, "_d2rbox_filter_backups", FILE_A, r.backedUp!);
    expect(await readBytesAbs(backup)).toEqual(before);
  });

  it("delete rejects path-escape file names", async () => {
    await expect(deletePreset("..\\lootfilter.json")).rejects.toThrow(/非法预设文件名/);
  });
});

// ---------------------------------------------------------------------------
// summarizeRule
// ---------------------------------------------------------------------------

describe("summarizeRule", () => {
  it("maps hide/show with condition arrays to 中文", () => {
    expect(
      summarizeRule({
        name: "隐藏全部",
        ruleType: "hide",
        equipmentQuality: ["normal", "exceptional"],
        equipmentRarity: ["lowQuality"],
        equipmentCategory: ["armo", "weap"],
      }),
    ).toBe("隐藏：普通/扩展 低品质 护甲/武器");
    expect(summarizeRule({ name: "显示暗金", ruleType: "show", equipmentRarity: ["unique"] })).toBe(
      "显示：暗金",
    );
    expect(summarizeRule({ name: "显示符文", ruleType: "show", itemCategory: ["runes"] })).toBe(
      "显示：符文",
    );
    expect(summarizeRule({ name: "显示精英", ruleType: "show", equipmentQuality: ["elite"] })).toBe(
      "显示：精英",
    );
    expect(summarizeRule({ name: "x", ruleType: "hide", filterEtherealSocketed: true })).toBe(
      "隐藏：仅无形/镶孔",
    );
  });

  it("falls back to the rule name for unknown types or no conditions", () => {
    expect(summarizeRule({ name: "自定义规则", ruleType: "weird" })).toBe("自定义规则");
    expect(summarizeRule({ name: "仅镶孔", ruleType: "hide" })).toBe("仅镶孔");
    expect(summarizeRule({ ruleType: "show" })).toBe("未命名规则");
  });
});
