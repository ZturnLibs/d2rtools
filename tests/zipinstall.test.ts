import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { zipSync } from "fflate";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import {
  ingestZipChunks,
  scanStageDir,
  rejectedFileReason,
  newStage,
  getStage,
  dropStage,
  stageFromZipFile,
  stageRoot,
} from "../src/services/zipinstall.js";

let sb: TestSandbox;

beforeEach(async () => {
  sb = await makeSandbox();
});

afterEach(async () => {
  await sb.cleanup();
});

/** Feed a buffer to the ingest as small chunks to exercise stream boundaries. */
async function* chunksOf(buf: Uint8Array, size = 512): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, Math.min(buf.length, i + size));
  }
}

const EJ_META = JSON.stringify({ name: "EJ 开荒", savepath: "EJ" });

function singleModZip(): Uint8Array {
  return zipSync({
    "EJ/modinfo.json": new TextEncoder().encode(EJ_META),
    "EJ/EJ.mpq/excel/a.txt": new TextEncoder().encode("a"),
    "EJ/EJ.mpq/data/b.txt": new TextEncoder().encode("b"),
    "EJ/EJ.mpq/data/": new Uint8Array(0), // dir entry
  });
}

describe("rejectedFileReason", () => {
  it("rejects executables and scripts, allows game data", () => {
    for (const bad of ["hack.EXE", "run.bat", "x.dll", "mod.js", "s.ps1", "t.cmd", "u.msi"])
      expect(rejectedFileReason(bad), bad).toBeTruthy();
    for (const ok of ["modinfo.json", "data/dc6/a.dc6", "EJ.mpq", "noext", "说明.txt"])
      expect(rejectedFileReason(ok), ok).toBeNull();
  });
});

describe("ingestZipChunks", () => {
  it("extracts a single-mod zip and scans one candidate", async () => {
    const dir = joinPath(sb.root, "stage-a");
    const { files, bytes } = await ingestZipChunks(chunksOf(singleModZip()), dir);
    expect(files).toBe(3); // dir entry not counted
    expect(bytes).toBe(38); // modinfo.json (36) + a.txt + b.txt
    const scan = await scanStageDir(dir);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      name: "EJ",
      displayName: "EJ 开荒",
      savepath: "EJ",
    });
  });

  it("handles stored (no-compression) zips", async () => {
    const dir = joinPath(sb.root, "stage-b");
    const zip = zipSync({ "EJ/modinfo.json": new TextEncoder().encode(EJ_META) }, { level: 0 });
    const { files } = await ingestZipChunks(chunksOf(zip), dir);
    expect(files).toBe(1);
  });

  it("finds multiple variants for the pick UI", async () => {
    const dir = joinPath(sb.root, "stage-c");
    const zip = zipSync({
      "VIPer/modinfo.json": new TextEncoder().encode('{"name":"主播","savepath":"../"}'),
      "VIPer_cs/modinfo.json": new TextEncoder().encode('{"name":"xin","savepath":"VIPer_cs"}'),
    });
    await ingestZipChunks(chunksOf(zip), dir);
    const scan = await scanStageDir(dir);
    expect(scan.candidates.map((c) => c.name).sort()).toEqual(["VIPer", "VIPer_cs"]);
  });

  it("rejects executable entries before writing anything", async () => {
    const dir = joinPath(sb.root, "stage-d");
    const zip = zipSync({
      "EJ/modinfo.json": new TextEncoder().encode(EJ_META),
      "EJ/hack.exe": new Uint8Array([1, 2, 3]),
    });
    await expect(ingestZipChunks(chunksOf(zip), dir)).rejects.toThrow(/禁止的文件类型(.*)hack\.exe/s);
    await expect(fsp.stat(dir)).rejects.toMatchObject({ code: "ENOENT" }); // cleaned up
  });

  it("rejects zip-slip entry names", async () => {
    const dir = joinPath(sb.root, "stage-e");
    const zip = zipSync({ "../evil.txt": new TextEncoder().encode("x") });
    await expect(ingestZipChunks(chunksOf(zip), dir)).rejects.toThrow(/不安全路径/);
    // nothing escaped the work dir
    await expect(fsp.stat(joinPath(sb.root, "evil.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-zip payloads by magic bytes", async () => {
    const dir = joinPath(sb.root, "stage-f");
    const notZip = new TextEncoder().encode("<html>definitely not a zip</html>");
    await expect(ingestZipChunks(chunksOf(notZip), dir)).rejects.toThrow(/文件头校验失败/);
  });

  it("enforces the per-entry decompressed size cap", async () => {
    const dir = joinPath(sb.root, "stage-g");
    const zip = zipSync({ "EJ/big.txt": new Uint8Array(5000).fill(7) });
    await expect(
      ingestZipChunks(chunksOf(zip), dir, { maxEntryBytes: 1000 }),
    ).rejects.toThrow(/单文件上限/);
  });

  it("handles chunk boundaries smaller than the zip header", async () => {
    const dir = joinPath(sb.root, "stage-h");
    const zip = singleModZip();
    // 1-byte chunks: the PK magic spans two chunks
    const { files } = await ingestZipChunks(chunksOf(zip, 1), dir);
    expect(files).toBe(3);
  });
});

describe("stage registry + stageFromZipFile", () => {
  it("stages a real zip file end to end and cleans up on drop", async () => {
    const zipPath = joinPath(sb.root, "pack.zip");
    await tjs.writeFile(zipPath, singleModZip());
    const outcome = await stageFromZipFile(zipPath);
    expect(outcome.candidates).toHaveLength(1);
    expect(getStage(outcome.stageId)?.dir).toBeTruthy();
    await dropStage(outcome.stageId);
    expect(getStage(outcome.stageId)).toBeNull();
    await expect(fsp.stat(outcome.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws a friendly error on mod-less zips and drops the stage", async () => {
    const zipPath = joinPath(sb.root, "nomod.zip");
    await tjs.writeFile(zipPath, zipSync({ "readme.txt": new TextEncoder().encode("nothing here") }));
    await expect(stageFromZipFile(zipPath)).rejects.toThrow(/未找到可识别的 mod/);
  });

  it("throws on a missing file", async () => {
    await expect(stageFromZipFile(joinPath(sb.root, "nope.zip"))).rejects.toThrow(/文件不存在/);
  });

  it("newStage dirs live under the stage root", async () => {
    const { stageId, dir } = await newStage();
    expect(dir.startsWith(stageRoot())).toBe(true);
    expect(getStage(stageId)).not.toBeNull();
  });
});
