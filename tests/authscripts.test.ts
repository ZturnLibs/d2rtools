import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import { scanModScripts } from "../src/services/authscripts.js";

let sb: TestSandbox;
let gameDir: string;
let modA: string;

/**
 * Build a CRLF bat whose `injectLine` starts with a pair of GBK high bytes
 * ("中" = D6 D0) — proving the ASCII-structure analysis is immune to GBK
 * multibyte sequences. Same construction as scripts/phase5-probe.ts.
 */
function batBytes(lines: string[], injectLine: number): Uint8Array {
  const gbkZh = [0xd6, 0xd0];
  const bytes: number[] = [];
  lines.forEach((l, i) => {
    if (i === injectLine) bytes.push(...gbkZh);
    for (let k = 0; k < l.length; k++) bytes.push(l.charCodeAt(k) & 0x7f);
    bytes.push(0x0d, 0x0a);
  });
  return new Uint8Array(bytes);
}

beforeEach(async () => {
  sb = await makeSandbox();
  gameDir = joinPath(sb.root, "Games", "D2R");
  modA = joinPath(gameDir, "mods", "ModA");
  await tjs.makeDir(joinPath(modA, "tools"), { recursive: true });

  await tjs.writeFile(
    joinPath(modA, "kill.bat"),
    batBytes(
      [
        "@echo off",
        "rem 切换辅助（本行首注入 GBK 字节）",
        "echo switching...",
        "taskkill /f /im D2R.exe",
        "del .\\mods\\MDK\\config.txt",
        "pause",
      ],
      1,
    ),
  );
  await tjs.writeFile(
    joinPath(modA, "run.bat"),
    batBytes(
      [
        "@echo off",
        'start "" D2R.exe -w',
        "xcopy /y .\\mods\\MDK\\settings.ini .\\",
      ],
      -1,
    ),
  );
  await tjs.writeFile(
    joinPath(modA, "echo.bat"),
    batBytes(["@echo off", "echo HELLO-TEST"], -1),
  );
  // deep scripts are the mod's own toolchain — never surfaced
  await tjs.writeFile(joinPath(modA, "tools", "deep.bat"), "@echo off\r\n");
});

afterEach(async () => {
  await sb.cleanup();
});

describe("scanModScripts", () => {
  it("scans only top-level .bat/.cmd of existing mod dirs, sorted", async () => {
    const { mods } = await scanModScripts(gameDir, ["ModA", "Ghost", "..\\evil"]);
    expect(mods.map((m) => m.mod)).toEqual(["ModA"]); // missing/invalid names skipped
    const names = mods[0]!.scripts.map((s) => s.name);
    expect(names).toEqual(["echo.bat", "kill.bat", "run.bat"]);
    expect(names).not.toContain("deep.bat");
  });

  it("flags kill.bat: killsGame + pause, and missing mods\\MDK target", async () => {
    const { mods } = await scanModScripts(gameDir, ["ModA"]);
    const kill = mods[0]!.scripts.find((s) => s.name === "kill.bat");
    expect(kill?.sideEffects).toEqual({
      killsGame: true,
      launchesGame: false,
      pauses: true,
    });
    expect(kill?.missingTargets).toEqual(["MDK"]);
    expect(kill?.truncated).toBe(false);
    expect(kill?.size).toBeGreaterThan(0);
    expect(kill?.mtime).toBeGreaterThan(0);
  });

  it("flags run.bat: launchesGame via start D2R.exe, forward-slash ref still maps to MDK", async () => {
    const { mods } = await scanModScripts(gameDir, ["ModA"]);
    const run = mods[0]!.scripts.find((s) => s.name === "run.bat");
    expect(run?.sideEffects).toEqual({
      killsGame: false,
      launchesGame: true,
      pauses: false,
    });
    expect(run?.missingTargets).toEqual(["MDK"]);
  });

  it("echo.bat has no side effects", async () => {
    const { mods } = await scanModScripts(gameDir, ["ModA"]);
    const echo = mods[0]!.scripts.find((s) => s.name === "echo.bat");
    expect(echo?.sideEffects).toEqual({
      killsGame: false,
      launchesGame: false,
      pauses: false,
    });
    expect(echo?.missingTargets).toEqual([]);
  });

  it("b64 payload round-trips the raw bytes including the GBK pair", async () => {
    const { mods } = await scanModScripts(gameDir, ["ModA"]);
    const kill = mods[0]!.scripts.find((s) => s.name === "kill.bat");
    const bin = atob(kill!.b64);
    const bytes = [...bin].map((c) => c.charCodeAt(0));
    const i = bytes.indexOf(0xd6);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(bytes[i + 1]).toBe(0xd0);
    // the taskkill line survives in the raw payload
    const ascii = String.fromCharCode(...bytes);
    expect(ascii).toContain("taskkill /f /im D2R.exe");
  });

  it("does not flag a taskkill inside a comment line", async () => {
    await tjs.writeFile(
      joinPath(modA, "note.bat"),
      batBytes(["@echo off", "rem taskkill is mentioned but not executed", "echo done"], -1),
    );
    const { mods } = await scanModScripts(gameDir, ["ModA"]);
    const note = mods[0]!.scripts.find((s) => s.name === "note.bat");
    expect(note?.sideEffects.killsGame).toBe(false);
  });
});
