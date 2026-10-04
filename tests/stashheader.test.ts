import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import {
  readStashHeader,
  stashConsistency,
  STASH_FILES,
  STASH_HEADER_BYTES,
  MAX_SAFE_PAGES,
} from "../src/services/stash.js";
import * as stashLib from "@dschu012/d2s/lib/d2/stash.js";
import { constants as constants99 } from "@dschu012/d2s/lib/data/versions/99_constant_data.js";

let sb: TestSandbox;
let saveDir: string;

/** 用库自身 write 造合法 .d2i（与头部读取器交叉验证 pageCount/HC/gold）。 */
async function writeStashFixture(
  path: string,
  opts: { hardcore?: boolean; gold?: number; pages?: number },
): Promise<void> {
  const bytes = await stashLib.write(
    {
      hardcore: opts.hardcore === true,
      sharedGold: opts.gold ?? 0,
      pages: Array.from({ length: opts.pages ?? 1 }, () => ({
        name: "",
        type: 0,
        items: [],
      })),
    },
    constants99,
    105,
    {},
  );
  await tjs.writeFile(path, bytes);
}

/** 手拼头部（不依赖 lib，测边界：超页/坏 sectorSize/装反）。 */
function handHeader(opts: {
  hardcore?: boolean;
  version?: number;
  gold?: number;
  sectorSize?: number;
  pages?: number;
  magic?: number;
}): Uint8Array {
  const buf = new Uint8Array(STASH_HEADER_BYTES);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, opts.magic ?? 0xaa55aa55, true);
  dv.setUint32(4, opts.hardcore ? 1 : 0, true);
  dv.setUint32(8, opts.version ?? 105, true);
  dv.setUint32(12, opts.gold ?? 0, true);
  const sectorSize = opts.sectorSize ?? 8192;
  dv.setUint32(16, sectorSize, true);
  if (opts.pages != null) {
    // 每 sector 自带 64B 小头：总长 = sectorSize × 页数
    const full = new Uint8Array(sectorSize * opts.pages);
    full.set(buf, 0);
    return full;
  }
  return buf;
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

describe("readStashHeader", () => {
  it("matches the d2s lib on pages / hardcore / gold", async () => {
    const p = joinPath(saveDir, "x.d2i");
    await writeStashFixture(p, { hardcore: true, gold: 12345, pages: 3 });
    const h = await readStashHeader(p);
    expect(h).not.toBeNull();
    // lib 写路径 version 硬编码 98=0x62（可行性文档 §5-B2），非 105
    expect(h!.hardcore).toBe(true); // u32@4==0 → 硬核（反着存）
    expect(h!.pageCount).toBe(3);
    expect(h!.sharedGold).toBe(12345);
    expect(h!.version).toBe(98);
    expect(h!.sectorSize).toBeGreaterThan(STASH_HEADER_BYTES);
  });

  it("derives page count from file length on hand-built headers", async () => {
    const p = joinPath(saveDir, "hand.d2i");
    await tjs.writeFile(p, handHeader({ pages: 7 }));
    expect((await readStashHeader(p))!.pageCount).toBe(7);
  });

  it("returns null for garbage / truncated / missing files", async () => {
    const bad = joinPath(saveDir, "bad.d2i");
    await tjs.writeFile(bad, new TextEncoder().encode("not a stash at all........"));
    expect(await readStashHeader(bad)).toBeNull();
    const short = joinPath(saveDir, "short.d2i");
    await tjs.writeFile(short, new Uint8Array(32));
    expect(await readStashHeader(short)).toBeNull();
    expect(await readStashHeader(joinPath(saveDir, "missing.d2i"))).toBeNull();
  });

  it("yields pageCount null when sectorSize is absurd", async () => {
    const p = joinPath(saveDir, "zerosec.d2i");
    await tjs.writeFile(p, handHeader({ sectorSize: 0 }));
    expect((await readStashHeader(p))!.pageCount).toBeNull();
  });
});

describe("stashConsistency", () => {
  it("reports no warnings for well-formed SC+HC pairs", async () => {
    await writeStashFixture(joinPath(saveDir, STASH_FILES.soft), { pages: 2 });
    await writeStashFixture(joinPath(saveDir, STASH_FILES.hard), { hardcore: true, pages: 2 });
    const r = await stashConsistency(saveDir);
    expect(r.soft.exists).toBe(true);
    expect(r.hard.exists).toBe(true);
    expect(r.soft.header!.pageCount).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it("flags SC/HC page-count mismatch as info", async () => {
    await writeStashFixture(joinPath(saveDir, STASH_FILES.soft), { pages: 1 });
    await writeStashFixture(joinPath(saveDir, STASH_FILES.hard), { hardcore: true, pages: 3 });
    const r = await stashConsistency(saveDir);
    const info = r.warnings.filter((w) => w.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0]!.text).toContain("页数不一致");
    expect(info[0]!.text).toContain("软核 1 页 / 硬核 3 页");
  });

  it("flags a swapped SC/HC file (hardcore flag vs slot)", async () => {
    // 软核文件放进硬核槽位——文件本身合法，内容与槽位不符
    await writeStashFixture(joinPath(saveDir, STASH_FILES.hard), { hardcore: false, pages: 1 });
    const r = await stashConsistency(saveDir);
    const errs = r.warnings.filter((w) => w.level === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.text).toContain("与槽位不符");
  });

  it("warns when a stash exceeds the 8-page coordinate cap", async () => {
    await tjs.writeFile(
      joinPath(saveDir, STASH_FILES.soft),
      handHeader({ pages: MAX_SAFE_PAGES + 1 }),
    );
    const r = await stashConsistency(saveDir);
    const warns = r.warnings.filter((w) => w.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.text).toContain(`超过物品坐标字段的 ${MAX_SAFE_PAGES} 页上限`);
  });

  it("reports unparseable slot files and skips checks for missing ones", async () => {
    await tjs.writeFile(joinPath(saveDir, STASH_FILES.soft), "garbage-not-a-stash-padding");
    const r = await stashConsistency(saveDir);
    expect(r.soft.exists).toBe(true);
    expect(r.soft.header).toBeNull();
    expect(r.hard.exists).toBe(false);
    expect(r.warnings.map((w) => w.level)).toEqual(["error"]); // 仅软核头部损坏
  });
});
