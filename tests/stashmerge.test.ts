import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import {
  planMerge,
  applyMerge,
  DEFAULT_GRID,
  type MergeSourceSpec,
  type MergeTargetSpec,
} from "../src/services/stashmerge.js";
import { readStashHeader, STASH_FILES, STASH_HEADER_BYTES } from "../src/services/stash.js";
import { parseItemFile } from "../src/services/itemview.js";
import * as stashLib from "@dschu012/d2s/lib/d2/stash.js";
import { constants as constants99 } from "@dschu012/d2s/lib/data/versions/99_constant_data.js";
import { listBackups } from "../src/services/saves.js";

let sb: TestSandbox;
let saveDir: string;

/** 简单物品 fixture（M11 补丁后 write 尊重 version）。 */
function simpleItem(type: string, x: number, y: number): Record<string, unknown> {
  return {
    identified: true,
    simple_item: true,
    location_id: 0,
    equipped_id: 0,
    alt_position_id: 5,
    position_x: x,
    position_y: y,
    type,
    quality: 2,
  };
}

async function writeStashFixture(
  path: string,
  items: Record<string, unknown>[],
  opts: { hardcore?: boolean; gold?: number; pages?: number; version?: number } = {},
): Promise<void> {
  const per = Math.max(1, opts.pages ?? 1);
  const flat = [...items];
  const bytes = await stashLib.write(
    {
      hardcore: opts.hardcore === true,
      sharedGold: opts.gold ?? 0,
      pages: Array.from({ length: per }, (_, i) => ({
        name: "",
        type: 0,
        items: i === 0 ? flat : [],
      })),
    },
    constants99,
    opts.version ?? 105,
    {},
  );
  await tjs.writeFile(path, bytes);
}

function newFile(name: string, pages: number, hardcore = false, sharedGold = 0): MergeTargetSpec {
  return { slot: null, fileName: name, pages, hardcore, sharedGold };
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

describe("planMerge", () => {
  it("packs two stash sources into one new file with real item sizes", async () => {
    const a = joinPath(saveDir, "a.d2i");
    const b = joinPath(saveDir, "b.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]); // El 符文 1×1
    await writeStashFixture(b, [simpleItem("kit", 0, 1)]); // Kite Shield 2×3
    const { view } = await planMerge(
      saveDir,
      [
        { path: a, kind: "stash" },
        { path: b, kind: "stash" },
      ],
      [newFile("merged.d2i", 1)],
      DEFAULT_GRID,
    );
    expect(view.carried).toBe(2);
    expect(view.placed).toBe(2);
    expect(view.unplaced).toBe(0);
    expect(view.unknownSize).toBe(0);
    expect(view.targets).toHaveLength(1);
    const items = view.targets[0]!.items;
    const shield = items.find((i) => i.type === "kit")!;
    const rune = items.find((i) => i.type === "r01")!;
    expect(shield.w).toBe(2); // 常量表 iw/ih 生效
    expect(shield.h).toBe(3);
    expect(rune.w).toBe(1);
    // 不重叠（shield 占 2×3，rune 只能在其外）
    const shieldCells = new Set(
      Array.from({ length: shield.w * shield.h }, (_, k) => `${shield.x + (k % shield.w)},${shield.y + Math.floor(k / shield.w)}`),
    );
    expect(shieldCells.has(`${rune.x},${rune.y}`)).toBe(false);
    expect(view.targets[0]!.version).toBe(105); // 沿用仓库来源版本
  });

  it("refuses when items do not fit (放不下，绝不静默丢弃)", async () => {
    const a = joinPath(saveDir, "big.d2i");
    await writeStashFixture(
      a,
      Array.from({ length: 200 }, (_, i) => simpleItem("r01", i % 10, Math.floor(i / 10) % 10)),
    );
    await expect(
      planMerge(saveDir, [{ path: a, kind: "stash" }], [newFile("out.d2i", 1)], DEFAULT_GRID),
    ).rejects.toThrow(/放不下 100 件/);
  });

  it("enforces the 8-page coordinate cap and safe file names", async () => {
    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]);
    await expect(
      planMerge(saveDir, [{ path: a, kind: "stash" }], [newFile("out.d2i", 9)], DEFAULT_GRID),
    ).rejects.toThrow(/页数须为 1–8/);
    await expect(
      planMerge(saveDir, [{ path: a, kind: "stash" }], [newFile("../evil.d2i", 1)], DEFAULT_GRID),
    ).rejects.toThrow(/文件名不合法/);
  });

  it("flags unknown-size mod items as 1×1 with a warning", async () => {
    const a = joinPath(saveDir, "modstash.d2i");
    await writeStashFixture(a, [simpleItem("zzz", 0, 0)]); // 非标准代码
    const { view } = await planMerge(saveDir, [{ path: a, kind: "stash" }], [newFile("out.d2i", 1)], DEFAULT_GRID);
    expect(view.unknownSize).toBe(1);
    expect(view.warnings.join("\n")).toContain("尺寸未知");
  });

  it("warns when a new-file target overwrites an existing file", async () => {
    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]);
    await writeStashFixture(joinPath(saveDir, "out.d2i"), []);
    const { view } = await planMerge(saveDir, [{ path: a, kind: "stash" }], [newFile("out.d2i", 1)], DEFAULT_GRID);
    expect(view.targets[0]!.exists).toBe(true);
    expect(view.warnings.join("\n")).toContain("将被覆盖");
  });

  it("rejects sources the lib cannot parse (mod 自定义位宽)", async () => {
    const bad = joinPath(saveDir, STASH_FILES.soft);
    await tjs.writeFile(bad, "garbage-not-a-stash-padding");
    await expect(
      planMerge(saveDir, [{ path: bad, kind: "stash" }], [newFile("out.d2i", 1)], DEFAULT_GRID),
    ).rejects.toThrow(/来源无法合并/);
  });
});

describe("applyMerge", () => {
  it("merges sources into a new file, byte-verifies by readback", async () => {
    const a = joinPath(saveDir, "a.d2i");
    const b = joinPath(saveDir, "b.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0), simpleItem("r02", 1, 0)]);
    await writeStashFixture(b, [simpleItem("kit", 0, 1)], { gold: 777 });
    const srcs: MergeSourceSpec[] = [
      { path: a, kind: "stash" },
      { path: b, kind: "stash" },
    ];
    const tgt = [newFile("merged.d2i", 2, false, 777)]; // 输出 gold 由目标规格决定
    const { view } = await planMerge(saveDir, srcs, tgt, DEFAULT_GRID);

    const res = await applyMerge(saveDir, srcs, tgt, DEFAULT_GRID, {
      backupKeep: 5,
      expectCarried: view.carried,
      note: "merge test",
    });
    expect(res.backupId).toBeNull(); // 新文件，无需快照
    expect(res.targets[0]!.items).toBe(3);

    // 落盘文件可被常规解析器读回，数量守恒
    const parsed = await parseItemFile(joinPath(saveDir, "merged.d2i"));
    expect(parsed.kind).toBe("stash");
    const total = parsed.kind === "stash" ? parsed.pages.reduce((n, p) => n + p.items.length, 0) : 0;
    expect(total).toBe(3);
    expect(parsed.kind === "stash" ? parsed.sharedGold : -1).toBe(777);
    // 无 tmp 残留
    const entries = await fsp.readdir(saveDir);
    expect(entries.filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  });

  it("splits one stash across multiple targets", async () => {
    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, Array.from({ length: 4 }, (_, i) => simpleItem("r01", i, 0)));
    const srcs: MergeSourceSpec[] = [{ path: a, kind: "stash" }];
    const tgts = [newFile("part1.d2i", 1), newFile("part2.d2i", 1)];
    const { view } = await planMerge(saveDir, srcs, tgts, DEFAULT_GRID);
    expect(view.carried).toBe(4);
    await applyMerge(saveDir, srcs, tgts, DEFAULT_GRID, {
      backupKeep: 5,
      expectCarried: view.carried,
    });
    for (const name of ["part1.d2i", "part2.d2i"]) {
      const parsed = await parseItemFile(joinPath(saveDir, name));
      expect(parsed.kind).toBe("stash");
      const n = parsed.kind === "stash" ? parsed.pages.reduce((n, p) => n + p.items.length, 0) : -1;
      expect(n).toBe(2);
    }
  });

  it("preserves an existing target's version (B2: 写路径版本不硬编码)", async () => {
    // 手拼 v105 头 + 1 空页的目标文件
    const target = joinPath(saveDir, "v105.d2i");
    const sector = 8192;
    const buf = new Uint8Array(sector);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xaa55aa55, true);
    dv.setUint32(8, 105, true);
    await tjs.writeFile(target, buf);

    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]);
    const srcs: MergeSourceSpec[] = [{ path: a, kind: "stash" }];
    const tgts: MergeTargetSpec[] = [{ slot: null, fileName: "v105.d2i", pages: 1, hardcore: false, sharedGold: 0 }];
    const { view } = await planMerge(saveDir, srcs, tgts, DEFAULT_GRID);
    expect(view.targets[0]!.version).toBe(105);
    await applyMerge(saveDir, srcs, tgts, DEFAULT_GRID, { backupKeep: 5, expectCarried: view.carried });
    const head = await readStashHeader(target);
    expect(head!.version).toBe(105);
  });

  it("keeps sharedGold identical across every sector (B3)", async () => {
    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]);
    const srcs: MergeSourceSpec[] = [{ path: a, kind: "stash" }];
    const tgts: MergeTargetSpec[] = [
      { slot: null, fileName: "gold.d2i", pages: 3, hardcore: false, sharedGold: 123456 },
    ];
    const { view } = await planMerge(saveDir, srcs, tgts, DEFAULT_GRID);
    await applyMerge(saveDir, srcs, tgts, DEFAULT_GRID, { backupKeep: 5, expectCarried: view.carried });
    const bytes = await tjs.readFile(joinPath(saveDir, "gold.d2i"));
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const golds: number[] = [];
    // 每 sector 自带小头（magic+gold+自身 size，compact 模式下尺寸可变），
    // 按各自 size 字段步进
    for (let off = 0; off + STASH_HEADER_BYTES <= bytes.length; ) {
      if (dv.getUint32(off, true) !== 0xaa55aa55) break;
      golds.push(dv.getUint32(off + 12, true));
      off += dv.getUint32(off + 16, true);
    }
    expect(golds).toEqual([123456, 123456, 123456]); // 每 sector 小头一致
  });

  it("snapshots the save root before overwriting an existing stash", async () => {
    await tjs.writeFile(joinPath(saveDir, STASH_FILES.soft), "OLD-STASH");
    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]);
    const srcs: MergeSourceSpec[] = [{ path: a, kind: "stash" }];
    const tgts: MergeTargetSpec[] = [
      { slot: "soft", fileName: null, pages: 1, hardcore: false, sharedGold: 0 },
    ];
    const { view } = await planMerge(saveDir, srcs, tgts, DEFAULT_GRID);
    const res = await applyMerge(saveDir, srcs, tgts, DEFAULT_GRID, {
      backupKeep: 5,
      expectCarried: view.carried,
    });
    expect(res.backupId).not.toBeNull();
    const metas = (await listBackups()).backups;
    const meta = metas.find((b) => b.id === res.backupId);
    expect(meta?.trigger).toBe("stash");
    // 快照里是旧仓库内容
    const old = await fsp.readFile(
      joinPath(sb.appdata, "com.zyj.d2rbox", "backups", res.backupId!, "slots", "root", STASH_FILES.soft),
      "utf8",
    );
    expect(old).toBe("OLD-STASH");
    // 目标已被新仓库覆盖
    const head = await readStashHeader(joinPath(saveDir, STASH_FILES.soft));
    expect(head).not.toBeNull();
  });

  it("refuses when sources changed between preview and apply", async () => {
    const a = joinPath(saveDir, "a.d2i");
    await writeStashFixture(a, [simpleItem("r01", 0, 0)]);
    const srcs: MergeSourceSpec[] = [{ path: a, kind: "stash" }];
    const tgts = [newFile("out.d2i", 1)];
    await planMerge(saveDir, srcs, tgts, DEFAULT_GRID);
    await expect(
      applyMerge(saveDir, srcs, tgts, DEFAULT_GRID, { backupKeep: 5, expectCarried: 999 }),
    ).rejects.toThrow(/来源已变化/);
  });
});
