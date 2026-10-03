import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import { stripBom, lenientParse, readModInfo, findReadme } from "../src/services/modinfo.js";

let sb: TestSandbox;
let dir: string;

beforeEach(async () => {
  sb = await makeSandbox();
  dir = joinPath(sb.root, "mods", "EJ");
  await tjs.makeDir(dir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

describe("stripBom", () => {
  const BOM = String.fromCharCode(0xfeff);
  it("removes a leading U+FEFF only", () => {
    expect(stripBom(`${BOM}{"a":1}`)).toBe('{"a":1}');
    expect(stripBom(`x${BOM}y`)).toBe(`x${BOM}y`); // BOM not at position 0 stays
    expect(stripBom("")).toBe("");
  });
});

describe("lenientParse", () => {
  const BOM = String.fromCharCode(0xfeff);
  it("parses strict JSON", () => {
    expect(lenientParse('{"name":"EJ","savepath":"../"}')).toEqual({ name: "EJ", savepath: "../" });
  });

  it("parses JSON with a UTF-8 BOM", () => {
    expect(lenientParse(`${BOM}{"name":"EJ"}`)).toEqual({ name: "EJ" });
  });

  it("parses JSON with trailing commas (VIPer_cs style)", () => {
    expect(lenientParse('{"name":"xin",\n"savepath":"VIPer_cs",\n}')).toEqual({
      name: "xin",
      savepath: "VIPer_cs",
    });
    expect(lenientParse('{"a":[1,2,3,],"b":true,}')).toEqual({ a: [1, 2, 3], b: true });
  });

  it("returns null for unrecoverable garbage", () => {
    expect(lenientParse("not json at all {{{")).toBeNull();
    expect(lenientParse("")).toBeNull();
  });

  it("tolerates GBK-mangled bytes as far as possible, null when broken", () => {
    // lenientParse is JSON-only; GBK tolerance lives in authscripts (ASCII
    // structure analysis). Here a GBK comment outside JSON is still null.
    const gbkNote = String.fromCharCode(0xd6, 0xd0); // "中" in GBK
    expect(lenientParse(gbkNote)).toBeNull();
  });
});

describe("readModInfo", () => {
  const BOM = String.fromCharCode(0xfeff);
  it("reads the standard <mod>\\modinfo.json layout", async () => {
    await tjs.writeFile(joinPath(dir, "modinfo.json"), '{"name":"EJ完整版","savepath":"EJSave"}');
    const info = await readModInfo(dir, "EJ");
    expect(info).toEqual({ name: "EJ完整版", savepath: "EJSave", warning: null });
  });

  it("reads modinfo inside <dirName>.mpq\\ (EJ mpq-as-folder), tolerating BOM", async () => {
    const mpq = joinPath(dir, "EJ.mpq");
    await tjs.makeDir(mpq, { recursive: true });
    await tjs.writeFile(joinPath(mpq, "modinfo.json"), `${BOM}{"name":"EJ","savepath":"../"}`);
    const info = await readModInfo(dir, "EJ");
    expect(info?.savepath).toBe("../");
    expect(info?.name).toBe("EJ");
  });

  it("parses trailing-comma modinfo leniently", async () => {
    await tjs.writeFile(
      joinPath(dir, "modinfo.json"),
      '{\n  "name": "xin",\n  "savepath": "VIPer_cs",\n}\n',
    );
    const info = await readModInfo(dir, "VIPer_cs");
    expect(info?.name).toBe("xin");
  });

  it("falls back to folder name for missing/blank fields", async () => {
    await tjs.writeFile(joinPath(dir, "modinfo.json"), '{"name":"  ","savepath":123}');
    const info = await readModInfo(dir, "EJ");
    expect(info?.name).toBe("EJ");
    expect(info?.savepath).toBe("EJ");
  });

  it("treats a modinfo-less dir with a same-named .mpq file as a mod", async () => {
    await tjs.writeFile(joinPath(dir, "EJ.mpq"), Buffer.from("MPQmagic-bytes"));
    const info = await readModInfo(dir, "EJ");
    expect(info).toEqual({ name: "EJ", savepath: "EJ", warning: null });
  });

  it("returns null when neither modinfo nor a same-named .mpq exists", async () => {
    await tjs.writeFile(joinPath(dir, "readme.txt"), "hi");
    expect(await readModInfo(dir, "EJ")).toBeNull();
  });
});

describe("findReadme", () => {
  it("prefers 说明.txt in the mod dir", async () => {
    await tjs.writeFile(joinPath(dir, "说明.txt"), "readme");
    await tjs.writeFile(joinPath(dir, "readme.txt"), "other");
    expect(await findReadme(dir)).toBe(joinPath(dir, "说明.txt"));
  });

  it("falls back to the parent variant dir (术士君临 layout)", async () => {
    await tjs.writeFile(joinPath(sb.root, "mods", "说明.txt"), "variant readme");
    expect(await findReadme(dir)).toBe(joinPath(sb.root, "mods", "说明.txt"));
  });

  it("returns null when nothing is found", async () => {
    expect(await findReadme(dir)).toBeNull();
  });
});
