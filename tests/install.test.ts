import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath, pathExists } from "../src/services/paths.js";
import {
  installMod,
  installState,
  uninstallPreflight,
  uninstallModDir,
  chunkedCopy,
  BIG_FILE,
  type InstallProgress,
} from "../src/services/install.js";

let sb: TestSandbox;
let gameDir: string;
let sourcePath: string;

async function readText(p: string): Promise<string> {
  return fsp.readFile(p, "utf8");
}

beforeEach(async () => {
  sb = await makeSandbox();
  gameDir = joinPath(sb.root, "Games", "D2R");
  sourcePath = joinPath(sb.root, "pack", "EJ");
  await tjs.makeDir(joinPath(sourcePath, "data", "global"), { recursive: true });
  await tjs.writeFile(joinPath(sourcePath, "modinfo.json"), '{"name":"EJ","savepath":"EJ"}');
  await tjs.writeFile(joinPath(sourcePath, "data", "global", "excel.bin"), "EXCEL-CONTENT");
  await tjs.writeFile(joinPath(sourcePath, "EJ.mpq"), Buffer.from("MPQ magic"));
});

afterEach(async () => {
  await sb.cleanup();
});

function collectProgress(): { events: InstallProgress[]; push: (p: InstallProgress) => void } {
  const events: InstallProgress[] = [];
  return { events, push: (p) => events.push(p) };
}

describe("chunkedCopy", () => {
  it("copies multi-chunk files byte-for-byte and reports progress", async () => {
    // 2.5 MiB → 3 chunks of 1 MiB
    const src = joinPath(sb.root, "big.bin");
    const dst = joinPath(sb.root, "big-copy.bin");
    const data = Buffer.alloc(2.5 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    await tjs.writeFile(src, data);

    const calls: [number, number][] = [];
    await chunkedCopy(src, dst, (done, total) => calls.push([done, total]));

    const copied = await fsp.readFile(dst);
    expect(copied.equals(data)).toBe(true);
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([1024 * 1024, data.length]);
    expect(calls[2]?.[0]).toBe(data.length);
  });
});

describe("installMod — copy mode", () => {
  it("copies the whole source tree into <game>\\mods\\<name>", async () => {
    const { events, push } = collectProgress();
    const out = await installMod({
      gameDir,
      sourcePath,
      modName: "EJ",
      mode: "copy",
      overwrite: false,
      onProgress: push,
    });
    expect(out.ok).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.mode).toBe("copy");
    expect(out.files).toBe(3);
    expect(out.bytes).toBeGreaterThan(0);

    const dest = joinPath(gameDir, "mods", "EJ");
    expect(await readText(joinPath(dest, "modinfo.json"))).toBe('{"name":"EJ","savepath":"EJ"}');
    expect(await readText(joinPath(dest, "data", "global", "excel.bin"))).toBe("EXCEL-CONTENT");
    expect(Buffer.from(await tjs.readFile(joinPath(dest, "EJ.mpq"))).toString()).toBe("MPQ magic");
    // source untouched (copy semantics)
    expect(await pathExists(joinPath(sourcePath, "modinfo.json"))).toBe(true);

    expect(events[0]).toMatchObject({ type: "start", files: 3 });
    expect(events.some((e) => e.type === "file" && e.path === "data\\global\\excel.bin")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "mode", mode: "copy" });
  });

  it("refuses invalid mod names and missing sources", async () => {
    await expect(
      installMod({ gameDir, sourcePath, modName: "..", mode: "copy", overwrite: false }),
    ).rejects.toThrow(/非法 mod 名/);
    await expect(
      installMod({ gameDir, sourcePath: joinPath(sb.root, "ghost"), modName: "EJ", mode: "copy", overwrite: false }),
    ).rejects.toThrow(/源目录不存在/);
  });

  it("refuses to overwrite an existing install unless overwrite=true", async () => {
    const opts = { gameDir, sourcePath, modName: "EJ", mode: "copy" as const, overwrite: false };
    await installMod(opts);
    await expect(installMod(opts)).rejects.toThrow(/已存在/);

    // mutate the installed copy, then overwrite-install restores it from source
    await tjs.writeFile(joinPath(gameDir, "mods", "EJ", "EJ.mpq"), "TAMPERED");
    const out = await installMod({ ...opts, overwrite: true });
    expect(out.ok).toBe(true);
    expect(Buffer.from(await tjs.readFile(joinPath(gameDir, "mods", "EJ", "EJ.mpq"))).toString()).toBe("MPQ magic");
  });

  it("routes files >= BIG_FILE through the chunked path with byte progress", async () => {
    const big = Buffer.alloc(BIG_FILE + 7, 7);
    await tjs.writeFile(joinPath(sourcePath, "big.mpq"), big);
    const { events, push } = collectProgress();
    const out = await installMod({
      gameDir, sourcePath, modName: "EJ", mode: "copy", overwrite: false, onProgress: push,
    });
    expect(out.ok).toBe(true);
    const copied = await fsp.readFile(joinPath(gameDir, "mods", "EJ", "big.mpq"));
    expect(copied.equals(big)).toBe(true);
    expect(events.some((e) => e.type === "bytes" && e.file === "big.mpq" && e.done === e.total)).toBe(true);
  });
});

describe("installMod — hardlink mode", () => {
  it("hardlinks every file and reports mode hardlink", async () => {
    const out = await installMod({
      gameDir, sourcePath, modName: "EJ", mode: "hardlink", overwrite: false,
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("hardlink"); // only if EVERY file linked

    const srcStat = await fsp.stat(joinPath(sourcePath, "modinfo.json"));
    const dstStat = await fsp.stat(joinPath(gameDir, "mods", "EJ", "modinfo.json"));
    expect(dstStat.ino).toBe(srcStat.ino);
    expect(dstStat.nlink).toBe(2);

    // edits through the hardlink are visible from both paths (same inode)
    await tjs.writeFile(joinPath(gameDir, "mods", "EJ", "modinfo.json"), "SHARED-WRITE");
    expect(await readText(joinPath(sourcePath, "modinfo.json"))).toBe("SHARED-WRITE");
  });

  it("falls back to copy per file when linking fails, reporting mode copy", async () => {
    // Plant a directory where modinfo.json's dest file must go. overwrite
    // would wipe it, so plant synchronously from the "start" progress event
    // (fired after dest exists but before any file is written): link() and
    // copyFile() both fail on the collision, the per-file error is collected
    // and install still finishes with mode "copy".
    const out = await installMod({
      gameDir,
      sourcePath,
      modName: "EJ",
      mode: "hardlink",
      overwrite: false,
      onProgress: (p) => {
        if (p.type === "start") {
          fs.mkdirSync(joinPath(gameDir, "mods", "EJ", "modinfo.json"), { recursive: true });
        }
      },
    });
    expect(out.ok).toBe(false);
    expect(out.mode).toBe("copy");
    expect(out.errors.some((e) => e.startsWith("modinfo.json"))).toBe(true);
    // the other files still installed
    expect(await pathExists(joinPath(gameDir, "mods", "EJ", "data", "global", "excel.bin"))).toBe(true);
  });
});

describe("installState / uninstallModDir", () => {
  it("tracks installed state from disk", async () => {
    expect(await installState(gameDir, "EJ")).toBe(false);
    expect(await installState(gameDir, "bad/name")).toBe(false);
    await installMod({ gameDir, sourcePath, modName: "EJ", mode: "copy", overwrite: false });
    expect(await installState(gameDir, "EJ")).toBe(true);
    await uninstallModDir(gameDir, "EJ");
    expect(await installState(gameDir, "EJ")).toBe(false);
    expect(await pathExists(joinPath(gameDir, "mods"))).toBe(true); // mods\ itself stays
  });

  it("uninstallModDir refuses names escaping mods\\", async () => {
    await expect(uninstallModDir(gameDir, "..\\evil")).rejects.toThrow(/非法 mod 名/);
  });
});

describe("uninstallPreflight", () => {
  it("reports not-installed for missing mods", async () => {
    const pre = await uninstallPreflight(gameDir, "EJ");
    expect(pre.installed).toBe(false);
    expect(pre.savepath).toBeNull();
    expect(pre.saveDir).toBeNull();
  });

  it("reads savepath from the installed modinfo and flags root saves", async () => {
    const rootSource = joinPath(sb.root, "pack", "rootmod");
    await tjs.makeDir(rootSource, { recursive: true });
    await tjs.writeFile(joinPath(rootSource, "modinfo.json"), '{"name":"R","savepath":"../"}');
    await tjs.writeFile(joinPath(rootSource, "R.mpq"), "x");

    await installMod({ gameDir, sourcePath: rootSource, modName: "rootmod", mode: "copy", overwrite: false });
    const pre = await uninstallPreflight(gameDir, "rootmod");
    expect(pre.installed).toBe(true);
    expect(pre.savepath).toBe("../");
    expect(pre.usesRootSaves).toBe(true);
    // points at the real (sandboxed) main save root
    expect(pre.saveDir).toBe(joinPath(sb.home, "Saved Games", "Diablo II Resurrected"));
    expect(pre.saveDirExists).toBe(false);
  });

  it("resolves named savepaths under the save root", async () => {
    await installMod({ gameDir, sourcePath, modName: "EJ", mode: "copy", overwrite: false });
    await tjs.makeDir(joinPath(sb.home, "Saved Games", "Diablo II Resurrected", "mods", "EJ"), {
      recursive: true,
    });
    const pre = await uninstallPreflight(gameDir, "EJ");
    expect(pre.usesRootSaves).toBe(false);
    expect(pre.saveDir).toBe(joinPath(sb.home, "Saved Games", "Diablo II Resurrected", "mods", "EJ"));
    expect(pre.saveDirExists).toBe(true);
  });
});
