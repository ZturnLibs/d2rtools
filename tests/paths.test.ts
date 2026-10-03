import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import {
  isValidModName,
  basename,
  dirname,
  joinPath,
  modSaveDir,
} from "../src/services/paths.js";

let sb: TestSandbox | undefined;
afterEach(async () => {
  await sb?.cleanup();
  sb = undefined;
});

describe("isValidModName", () => {
  it("accepts normal names incl. Chinese and spaces", () => {
    expect(isValidModName("EJ")).toBe(true);
    expect(isValidModName("术士君临")).toBe(true);
    expect(isValidModName("My Mod v2")).toBe(true);
    expect(isValidModName("a".repeat(64))).toBe(true);
  });

  it("rejects empty and over-long names", () => {
    expect(isValidModName("")).toBe(false);
    expect(isValidModName("a".repeat(65))).toBe(false);
  });

  it("rejects dot segments and Windows-reserved characters", () => {
    expect(isValidModName(".")).toBe(false);
    expect(isValidModName("..")).toBe(false);
    for (const ch of ["\\", "/", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(isValidModName(`a${ch}b`), `name containing ${ch}`).toBe(false);
    }
  });
});

describe("joinPath", () => {
  it("joins with backslashes", () => {
    expect(joinPath("a", "b", "c")).toBe("a\\b\\c");
  });

  it("normalizes mixed separators", () => {
    expect(joinPath("a/b", "c\\d", "e")).toBe("a\\b\\c\\d\\e");
  });

  it("keeps the leading \\\\ of a UNC path", () => {
    expect(joinPath("\\\\server\\share", "mods", "EJ")).toBe("\\\\server\\share\\mods\\EJ");
  });

  it("skips empty parts", () => {
    expect(joinPath("", "a", "", "b")).toBe("a\\b");
  });
});

describe("basename / dirname", () => {
  it("handles backslash and slash paths", () => {
    expect(basename("C:\\Games\\D2R\\mods\\EJ")).toBe("EJ");
    expect(basename("C:/Games/D2R/mods/EJ")).toBe("EJ");
    expect(dirname("C:\\Games\\D2R\\mods\\EJ")).toBe("C:\\Games\\D2R\\mods");
    expect(dirname("C:/Games/D2R/mods/EJ")).toBe("C:/Games/D2R/mods");
  });

  it("strips trailing separators", () => {
    expect(basename("C:\\Games\\D2R\\")).toBe("D2R");
    expect(dirname("C:\\Games\\D2R\\")).toBe("C:\\Games");
  });

  it("handles segment-only and separator-free input", () => {
    expect(basename("EJ")).toBe("EJ");
    expect(dirname("EJ")).toBe("");
    expect(basename("C:")).toBe("C:");
    // trailing separators are trimmed, leaving a separator-free "C:"
    expect(dirname("C:\\")).toBe("");
  });
});

describe("modSaveDir", () => {
  let box: TestSandbox;
  beforeEach(async () => {
    box = await makeSandbox();
    sb = box;
  });

  it("maps ../, .., . and empty to the main save root", async () => {
    const root = box.home + "\\Saved Games\\Diablo II Resurrected";
    for (const sp of ["../", "..", ".", "", "   "]) {
      expect(await modSaveDir(sp), `savepath ${JSON.stringify(sp)}`).toBe(root);
    }
  });

  it("maps a named savepath under mods\\", async () => {
    expect(await modSaveDir("EJ")).toBe(
      box.home + "\\Saved Games\\Diablo II Resurrected\\mods\\EJ",
    );
  });
});
