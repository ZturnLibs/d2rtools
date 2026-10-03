import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import { scanSource } from "../src/services/scan.js";

let sb: TestSandbox;
let packRoot: string;

async function makeMod(variant: string, name: string, modinfo?: string): Promise<string> {
  const dir = joinPath(packRoot, variant, "mods", name);
  await tjs.makeDir(dir, { recursive: true });
  if (modinfo !== undefined) {
    await tjs.writeFile(joinPath(dir, "modinfo.json"), modinfo);
  } else {
    // modinfo-less mod: a same-named .mpq with the MPQ magic header
    await tjs.writeFile(joinPath(dir, `${name}.mpq`), Buffer.from("MPQ", "utf8"));
  }
  return dir;
}

beforeEach(async () => {
  sb = await makeSandbox();
  packRoot = joinPath(sb.root, "packroot");
});

afterEach(async () => {
  await sb.cleanup();
});

describe("scanSource — pack layouts", () => {
  it("finds mods nested as <pack>\\<variant>\\mods\\<name> and groups by variant", async () => {
    await makeMod("1.开荒", "EJ", '{"name":"EJ","savepath":"../"}');
    await makeMod("1.开荒", "VIPer_cs", '{\n"name": "xin",\n"savepath": "VIPer_cs",\n}\n');
    await makeMod("2.毕业", "EJ", '{"name":"EJ","savepath":"../"}');

    const out = await scanSource(packRoot, "src1");
    expect(out.warnings).toEqual([]);
    expect(out.mods.length).toBe(3);

    const ej1 = out.mods.find((m) => m.variant === "1.开荒" && m.name === "EJ");
    expect(ej1).toMatchObject({
      key: "src1:1.开荒:EJ",
      name: "EJ",
      displayName: null,
      savepath: "../",
      sourceId: "src1",
      variant: "1.开荒",
      relPath: "1.开荒\\mods\\EJ",
    });

    // same folder name in a different variant must NOT collapse
    const ej2 = out.mods.find((m) => m.variant === "2.毕业" && m.name === "EJ");
    expect(ej2?.key).toBe("src1:2.毕业:EJ");
    expect(ej2?.sourcePath).toContain("2.毕业");

    const viper = out.mods.find((m) => m.name === "VIPer_cs");
    expect(viper?.displayName).toBe("xin"); // modinfo name ≠ folder name
    expect(viper?.savepath).toBe("VIPer_cs");
  });

  it("detects modinfo-less mods by the same-named .mpq (magic-header file)", async () => {
    await makeMod("1.开荒", "NoInfo");
    const out = await scanSource(packRoot, "src1");
    expect(out.mods.length).toBe(1);
    expect(out.mods[0]).toMatchObject({
      name: "NoInfo",
      displayName: null,
      savepath: "NoInfo", // folder-name fallback
      variant: "1.开荒",
    });
  });

  it("prunes data subtrees (game content, not pack layout)", async () => {
    const hidden = joinPath(packRoot, "1.开荒", "data", "InsideData");
    await tjs.makeDir(hidden, { recursive: true });
    await tjs.writeFile(joinPath(hidden, "InsideData.mpq"), Buffer.from("MPQ"));
    await makeMod("1.开荒", "EJ", '{"name":"EJ"}');

    const out = await scanSource(packRoot, "src1");
    expect(out.mods.map((m) => m.name)).toEqual(["EJ"]);
  });

  it("variant falls back to the first segment for loose layouts without mods\\", async () => {
    const loose = joinPath(packRoot, "loosepack", "DeepMod");
    await tjs.makeDir(loose, { recursive: true });
    await tjs.writeFile(joinPath(loose, "modinfo.json"), '{"name":"D"}');
    const out = await scanSource(packRoot, "src1");
    expect(out.mods.length).toBe(1);
    expect(out.mods[0]?.variant).toBe("loosepack");
    expect(out.mods[0]?.relPath).toBe("loosepack\\DeepMod");
  });

  it("warns when nothing mod-like is found", async () => {
    await tjs.makeDir(joinPath(packRoot, "empty"), { recursive: true });
    const out = await scanSource(packRoot, "src1");
    expect(out.mods).toEqual([]);
    expect(out.warnings.some((w) => w.includes("未在该目录中找到任何 mod"))).toBe(true);
  });
});

describe("scanSource — registered source is a game dir", () => {
  it("never descends into the game dir's own mods\\ (installed copies are not sources)", async () => {
    const gameRoot = joinPath(sb.root, "Games", "D2R");
    const installed = joinPath(gameRoot, "mods", "InstalledMod");
    await tjs.makeDir(installed, { recursive: true });
    await tjs.writeFile(joinPath(gameRoot, "D2R.exe"), "MZ-fake");
    await tjs.writeFile(joinPath(installed, "InstalledMod.mpq"), Buffer.from("MPQ"));

    const out = await scanSource(gameRoot, "srcGame");
    expect(out.mods).toEqual([]);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("still scans pack subdirs next to D2R.exe", async () => {
    const gameRoot = joinPath(sb.root, "Games", "D2R");
    await tjs.makeDir(gameRoot, { recursive: true });
    await tjs.writeFile(joinPath(gameRoot, "D2R.exe"), "MZ-fake");
    const oldPackRoot = packRoot;
    packRoot = gameRoot; // reuse makeMod against the game root
    await makeMod("1.开荒", "EJ", '{"name":"EJ"}');
    packRoot = oldPackRoot;

    const out = await scanSource(gameRoot, "srcGame");
    expect(out.mods.map((m) => m.name)).toEqual(["EJ"]);
    expect(out.mods[0]?.variant).toBe("1.开荒");
  });
});
