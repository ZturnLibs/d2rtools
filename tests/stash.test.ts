import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath, pathExists } from "../src/services/paths.js";
import { listBackups } from "../src/services/saves.js";
import { stashPreflight, stashReplace, isStashSlot } from "../src/services/stash.js";

let sb: TestSandbox;
let saveDir: string;

const SOFT = "SharedStashSoftCoreV2.d2i";

async function readText(p: string): Promise<string> {
  return fsp.readFile(p, "utf8");
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

describe("isStashSlot", () => {
  it("accepts only soft/hard", () => {
    expect(isStashSlot("soft")).toBe(true);
    expect(isStashSlot("hard")).toBe(true);
    expect(isStashSlot("SOFT")).toBe(false);
    expect(isStashSlot("x")).toBe(false);
  });
});

describe("stashPreflight", () => {
  it("reports missing stash as exists=false (first run for the mode)", async () => {
    const pre = await stashPreflight(saveDir, "soft");
    expect(pre.exists).toBe(false);
    expect(pre.size).toBe(0);
    expect(pre.mtime).toBe(0);
    expect(pre.fileName).toBe(SOFT);
    expect(pre.path).toBe(joinPath(saveDir, SOFT));
    expect(pre.gameRunning).toBe(false); // spawn stubbed → probe fails → not running
  });

  it("reports size/mtime of the current stash", async () => {
    await tjs.writeFile(joinPath(saveDir, SOFT), "STASH-OLD-CONTENT");
    const pre = await stashPreflight(saveDir, "soft");
    expect(pre.exists).toBe(true);
    expect(pre.size).toBe("STASH-OLD-CONTENT".length);
    expect(pre.mtime).toBeGreaterThan(0);
  });
});

describe("stashReplace", () => {
  it("validates input before touching anything", async () => {
    const src = joinPath(saveDir, "author.d2i");
    await tjs.writeFile(src, "X");
    await expect(
      stashReplace({ saveDir, slot: "soft", sourcePath: "  ", backupKeep: 5 }),
    ).rejects.toThrow(/未选择/);
    await expect(
      stashReplace({ saveDir, slot: "soft", sourcePath: joinPath(saveDir, "x.bin"), backupKeep: 5 }),
    ).rejects.toThrow(/不是 \.d2i/);
    await expect(
      stashReplace({ saveDir, slot: "soft", sourcePath: joinPath(saveDir, "ghost.d2i"), backupKeep: 5 }),
    ).rejects.toThrow(/文件不存在/);
    expect(await pathExists(joinPath(saveDir, SOFT))).toBe(false); // nothing was written
  });

  it("rejects oversized files", async () => {
    const big = joinPath(sb.root, "big.d2i");
    await tjs.writeFile(big, Buffer.alloc(64 * 1024 * 1024 + 1));
    await expect(
      stashReplace({ saveDir, slot: "soft", sourcePath: big, backupKeep: 5 }),
    ).rejects.toThrow(/过大/);
  });

  it("replaces atomically (tmp+rename), no tmp file left behind", async () => {
    await tjs.writeFile(joinPath(saveDir, SOFT), "STASH-OLD");
    const src = joinPath(sb.root, "author.d2i");
    await tjs.writeFile(src, "AUTHOR-STASH-CONTENT");

    const rep = await stashReplace({ saveDir, slot: "soft", sourcePath: src, backupKeep: 5 });
    expect(rep).toEqual({ ok: true, backupId: expect.any(String), replaced: true });

    // target content equals the new .d2i
    expect(await readText(joinPath(saveDir, SOFT))).toBe("AUTHOR-STASH-CONTENT");
    // no leftover tmp files next to the target
    const entries = await fsp.readdir(saveDir);
    expect(entries).toContain(SOFT);
    expect(entries.filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  });

  it("snapshots the save root before replacing an existing stash", async () => {
    await tjs.writeFile(joinPath(saveDir, SOFT), "STASH-OLD");
    const src = joinPath(sb.root, "author.d2i");
    await tjs.writeFile(src, "AUTHOR-NEW");

    const rep = await stashReplace({ saveDir, slot: "soft", sourcePath: src, note: "", backupKeep: 5 });
    expect(rep.backupId).not.toBeNull();

    const metas = (await listBackups()).backups;
    const meta = metas.find((b) => b.id === rep.backupId);
    expect(meta?.trigger).toBe("stash");
    expect(meta?.signature).toBe("root");
    // the snapshot captured the OLD stash content
    const oldContent = await readText(
      joinPath(sb.appdata, "com.zyj.d2rbox", "backups", rep.backupId!, "slots", "root", SOFT),
    );
    expect(oldContent).toBe("STASH-OLD");
  });

  it("skips the snapshot when no current stash exists (first import)", async () => {
    const src = joinPath(sb.root, "author.d2i");
    await tjs.writeFile(src, "FIRST-STASH");
    const rep = await stashReplace({ saveDir, slot: "hard", sourcePath: src, backupKeep: 5 });
    expect(rep.backupId).toBeNull();
    expect(await readText(joinPath(saveDir, "SharedStashHardCoreV2.d2i"))).toBe("FIRST-STASH");
    expect((await listBackups()).backups.length).toBe(0);
  });
});
