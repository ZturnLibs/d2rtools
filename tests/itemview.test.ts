import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import { listItemSources, parseItemFile } from "../src/services/itemview.js";
import * as stashLib from "@dschu012/d2s/lib/d2/stash.js";
import { constants as constants99 } from "@dschu012/d2s/lib/data/versions/99_constant_data.js";

let sb: TestSandbox;
let saveDir: string;

/** 用库自身 write 造一份合法 .d2i fixture（简单物品可无损回环；
 *  复杂物物品 write 需要完整字段，交给实机验收覆盖）。 */
async function writeStashFixture(
  path: string,
  opts: { hardcore?: boolean; gold?: number; pages: { type: string; x: number; y: number }[][] },
): Promise<void> {
  const bytes = await stashLib.write(
    {
      hardcore: opts.hardcore === true,
      sharedGold: opts.gold ?? 0,
      pages: opts.pages.map((items) => ({
        name: "",
        type: 0,
        items: items.map((it) => ({
          identified: true,
          simple_item: true,
          location_id: 0,
          equipped_id: 0,
          position_x: it.x,
          position_y: it.y,
          alt_position_id: 2,
          type: it.type,
          quality: 2,
        })),
      })),
    },
    constants99,
    105,
    {},
  );
  await tjs.writeFile(path, bytes);
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

describe("listItemSources", () => {
  it("lists root + mods dirs with stashes and characters, sorted", async () => {
    await writeStashFixture(joinPath(saveDir, "SharedStashSoftCoreV2.d2i"), {
      pages: [[]],
    });
    await tjs.writeFile(joinPath(saveDir, "Amazon_01.d2s"), "fake-d2s");
    await tjs.writeFile(joinPath(saveDir, "Settings.json"), "{}"); // 不应出现
    const modDir = joinPath(saveDir, "mods", "EJ");
    await tjs.makeDir(modDir, { recursive: true });
    await tjs.writeFile(joinPath(modDir, "Hero.d2s"), "fake-d2s");

    const { groups } = await listItemSources(saveDir);
    expect(groups.map((g) => g.name)).toEqual(["主存档", "EJ"]);
    expect(groups[0]!.slot).toBe("root");
    expect(groups[0]!.stashes).toHaveLength(1);
    expect(groups[0]!.stashes[0]!.kind).toBe("shared-soft");
    expect(groups[0]!.characters.map((c) => c.name)).toEqual(["Amazon_01"]);
    expect(groups[1]!.slot).toBe("mods/EJ");
    expect(groups[1]!.characters.map((c) => c.name)).toEqual(["Hero"]);
    expect(groups[1]!.stashes).toHaveLength(0);
  });

  it("classifies hardcore stash and unknown .d2i as other kinds", async () => {
    await writeStashFixture(joinPath(saveDir, "SharedStashHardCoreV2.d2i"), { pages: [[]] });
    await writeStashFixture(joinPath(saveDir, "author-backup.d2i"), { pages: [[]] });
    const { groups } = await listItemSources(saveDir);
    const kinds = groups[0]!.stashes.map((s) => s.kind);
    expect(kinds).toContain("shared-hard");
    expect(kinds).toContain("other");
  });

  it("returns exists=false when the save dir is missing entirely", async () => {
    await tjs.remove(saveDir, { recursive: true });
    const { groups } = await listItemSources(saveDir);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.exists).toBe(false);
    expect(groups[0]!.stashes).toEqual([]);
    expect(groups[0]!.characters).toEqual([]);
  });
});

describe("parseItemFile · stash", () => {
  it("round-trips pages, gold, hardcore flag and item fields", async () => {
    const path = joinPath(saveDir, "SharedStashSoftCoreV2.d2i");
    await writeStashFixture(path, {
      hardcore: true,
      gold: 777,
      pages: [
        [{ type: "r01", x: 0, y: 1 }, { type: "gcv", x: 2, y: 1 }],
        [{ type: "r02", x: 0, y: 3 }],
      ],
    });

    const r = await parseItemFile(path);
    expect(r.kind).toBe("stash");
    if (r.kind !== "stash") return;
    expect(r.hardcore).toBe(true);
    expect(r.sharedGold).toBe(777);
    expect(r.pageCount).toBe(2);
    expect(r.pages[0]!.items).toHaveLength(2);

    const rune = r.pages[0]!.items[0]!;
    expect(rune.type).toBe("r01");
    expect(rune.name).toBe("El Rune"); // 常量表解析出的基础名
    expect(rune.category).toBe("rune");
    expect(rune.where).toBe("stash");
    expect(rune.page).toBe(0);
    expect(rune.x).toBe(0);
    expect(rune.y).toBe(1);

    const gem = r.pages[0]!.items[1]!;
    expect(gem.type).toBe("gcv");
    expect(gem.name).toBe("Chipped Amethyst");
    expect(gem.category).toBe("gem");

    expect(r.pages[1]!.items[0]!.page).toBe(1);
    expect(r.pages[1]!.items[0]!.type).toBe("r02");
  });

  it("names pages 第 N 页 when the file has no page names", async () => {
    const path = joinPath(saveDir, "a.d2i");
    await writeStashFixture(path, { pages: [[], []] });
    const r = await parseItemFile(path);
    if (r.kind !== "stash") return expect.fail("expected stash");
    expect(r.pages.map((p) => p.name)).toEqual(["第 1 页", "第 2 页"]);
  });
});

describe("parseItemFile · errors", () => {
  it("reports corrupt .d2i as kind=error instead of throwing", async () => {
    const path = joinPath(saveDir, "bad.d2i");
    await tjs.writeFile(path, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const r = await parseItemFile(path);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("仓库解析失败");
  });

  it("reports garbage .d2s as kind=error", async () => {
    const path = joinPath(saveDir, "bad.d2s");
    await tjs.writeFile(path, "not-a-character-file");
    const r = await parseItemFile(path);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("角色解析失败");
  });

  it("rejects other extensions up front", async () => {
    const path = joinPath(saveDir, "Settings.json");
    await tjs.writeFile(path, "{}");
    const r = await parseItemFile(path);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("仅支持");
  });

  it("reports unreadable files as kind=error", async () => {
    const r = await parseItemFile(joinPath(saveDir, "ghost.d2i"));
    expect(r.kind).toBe("error");
  });
});
