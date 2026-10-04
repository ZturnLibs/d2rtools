import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import { parseOkMap } from "../src/services/ps.js";
import {
  analyzePathShape,
  buildSystemProbeCommand,
  decodeIniText,
  isProtectedInstallPath,
  missingCoreFiles,
  normalizeDefenderEx,
  parseBNetEmuIni,
  pathLengthVerdict,
  runHealthCheck,
  type HealthCheckItem,
} from "../src/services/health.js";

let sb: TestSandbox;
let gameDir: string;

const INI_SCHINESE = "[Settings]\r\nGameId=5198665\r\nLocale=schinese\r\nLocaleAudio=schinese\r\n";

/** 标准假游戏目录：D2R.exe + BNet_Emu.ini + 三件核心 DLL + mods\EJ。 */
async function makeGameDir(dir: string, opts: { ini?: string | null; dlls?: boolean } = {}) {
  await tjs.makeDir(joinPath(dir, "mods", "EJ"), { recursive: true });
  await tjs.writeFile(joinPath(dir, "D2R.exe"), "MZ-fake");
  if (opts.ini !== null) {
    await tjs.writeFile(joinPath(dir, "BNet_Emu.ini"), opts.ini ?? INI_SCHINESE);
  }
  if (opts.dlls !== false) {
    for (const f of ["WinHttp.dll", "D2R_loader.dll", "steam_api64.dll"]) {
      await tjs.writeFile(joinPath(dir, f), "fake-dll");
    }
  }
}

const byId = (items: HealthCheckItem[], id: string) => items.find((i) => i.id === id);

beforeEach(async () => {
  sb = await makeSandbox();
  gameDir = joinPath(sb.root, "Games", "D2R");
});

afterEach(async () => {
  await sb.cleanup();
});

describe("parseOkMap", () => {
  it("collects every marker line and ignores noise", () => {
    const out = parseOkMap("noise line\n__D2R_OK__version=3.2.93236\nmore noise\n__D2R_OK__done=1\n");
    expect(out).toEqual({ version: "3.2.93236", done: "1" });
  });
  it("keeps '=' inside values and returns {} without markers", () => {
    expect(parseOkMap("__D2R_OK__osVersion=a=b=c")["osVersion"]).toBe("a=b=c");
    expect(parseOkMap("no markers here")).toEqual({});
  });
});

describe("decodeIniText", () => {
  it("decodes plain UTF-8, strips UTF-8 BOM and UTF-16LE BOM", () => {
    expect(decodeIniText(Buffer.from("Locale=schinese", "utf8"))).toBe("Locale=schinese");
    const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Locale=schinese", "utf8")]);
    expect(decodeIniText(new Uint8Array(bom8))).toBe("Locale=schinese");
    const bom16 = Buffer.from("\ufeffLocale=schinese", "utf16le");
    expect(decodeIniText(new Uint8Array(bom16))).toBe("Locale=schinese");
  });
  it("never throws on junk bytes", () => {
    expect(() => decodeIniText(new Uint8Array([0x80, 0x81, 0x82, 0x83]))).not.toThrow();
  });
});

describe("parseBNetEmuIni", () => {
  it("parses CRLF standard text and tolerates case/whitespace", () => {
    expect(parseBNetEmuIni(INI_SCHINESE)).toEqual({ locale: "schinese", localeAudio: "schinese" });
    expect(parseBNetEmuIni("  LOCALE = enUS  \nlocaleaudio=zhCN\n")).toEqual({
      locale: "enUS",
      localeAudio: "zhCN",
    });
  });
  it("returns nulls for empty / keyless text", () => {
    expect(parseBNetEmuIni("")).toEqual({ locale: null, localeAudio: null });
    expect(parseBNetEmuIni("[Settings]\nGameId=1\n")).toEqual({ locale: null, localeAudio: null });
  });
});

describe("analyzePathShape", () => {
  it("flags Chinese and en-dash paths, passes pure ASCII", () => {
    const hit = analyzePathShape("D:\\Games\\Diablo II Resurrected – Infernal Edition");
    expect(hit.nonAscii).toBe(true);
    expect(hit.specials).toContain("en-dash（–）");
    expect(analyzePathShape("D:\\Games\\Diablo II 中文版").specials).toContain("中文");
    expect(analyzePathShape("D:\\Games\\D2R")).toEqual({
      length: "D:\\Games\\D2R".length,
      nonAscii: false,
      specials: [],
    });
  });
});

describe("pathLengthVerdict", () => {
  it("grades thresholds against long-paths support", () => {
    expect(pathLengthVerdict(60, null).status).toBe("ok");
    expect(pathLengthVerdict(60, false).status).toBe("ok");
    expect(pathLengthVerdict(150, null).status).toBe("info");
    expect(pathLengthVerdict(150, true).status).toBe("info");
    expect(pathLengthVerdict(220, false).status).toBe("warn");
    expect(pathLengthVerdict(220, null).status).toBe("warn");
    expect(pathLengthVerdict(220, false).fixSteps.length).toBeGreaterThan(0);
    expect(pathLengthVerdict(220, true).status).toBe("info");
  });
});

describe("isProtectedInstallPath", () => {
  it("detects WindowsApps / XboxGames segments case-insensitively", () => {
    expect(isProtectedInstallPath("C:\\Program Files\\WindowsApps\\Blizzard.TD2R_123")).toBe(true);
    expect(isProtectedInstallPath("D:\\XboxGames\\Diablo II Resurrected")).toBe(true);
    expect(isProtectedInstallPath("c:\\program files\\windowsapps\\x")).toBe(true);
    expect(isProtectedInstallPath("D:\\Games\\D2R")).toBe(false);
    expect(isProtectedInstallPath("D:\\Games\\WindowsAppsBackup")).toBe(false);
  });
});

describe("missingCoreFiles", () => {
  it("lists absent files only", () => {
    const required = ["WinHttp.dll", "D2R_loader.dll", "steam_api64.dll"];
    expect(missingCoreFiles({ "WinHttp.dll": true, "D2R_loader.dll": true, "steam_api64.dll": true }, required)).toEqual([]);
    expect(missingCoreFiles({ "WinHttp.dll": true, "D2R_loader.dll": false, "steam_api64.dll": true }, required)).toEqual([
      "D2R_loader.dll",
    ]);
  });
});

describe("normalizeDefenderEx", () => {
  it("treats empty and non-admin N/A answers as unknown", () => {
    expect(normalizeDefenderEx("D:\\Games\\D2R|E:\\Stuff")).toBe("D:\\Games\\D2R|E:\\Stuff");
    expect(normalizeDefenderEx("N/A: Must be an administrator to view exclusions")).toBeNull();
    expect(normalizeDefenderEx("n/a")).toBeNull();
    expect(normalizeDefenderEx("")).toBeNull();
    expect(normalizeDefenderEx(null)).toBeNull();
    expect(normalizeDefenderEx(undefined)).toBeNull();
  });
});

describe("buildSystemProbeCommand", () => {
  it("emits all five keys plus the done sentinel, no interpolated paths", () => {
    const cmd = buildSystemProbeCommand();
    for (const key of ["version", "longPaths", "running", "osVersion", "defenderEx", "done"]) {
      expect(cmd).toContain(`__D2R_OK__${key}=`);
    }
    expect(cmd).toContain("$env:D2R_EXE");
  });
});

describe("runHealthCheck", () => {
  it("gameDir=null: single fail item pointing to settings, no path-dependent groups", async () => {
    const r = await runHealthCheck({ gameDir: null, knownModNames: [] });
    expect(r.gameDir).toBeNull();
    expect(r.items.filter((i) => i.status === "fail")).toHaveLength(1);
    const fail = r.items.find((i) => i.status === "fail")!;
    expect(fail.id).toBe("game-dir-set");
    expect(fail.fixSteps.join(" ")).toContain("设置");
    expect(byId(r.items, "game-dir-valid")).toBeUndefined();
    expect(byId(r.items, "game-locale")).toBeUndefined();
    expect(byId(r.items, "av-core-files")).toBeUndefined();
    expect(byId(r.items, "saves-dir")).toBeDefined();
  });

  it("standard healthy install: main items ok, orphan-free", async () => {
    await makeGameDir(gameDir);
    const r = await runHealthCheck({ gameDir, knownModNames: ["EJ"] });
    expect(r.gameDir).toBe(gameDir);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    for (const id of ["game-dir-set", "game-dir-valid", "protected-path", "mods-orphans", "game-locale", "av-core-files"]) {
      expect(byId(r.items, id)?.status, id).toBe("ok");
    }
    // spawn 在测试环境不可用：探针键缺失 → 相关项呈降级语义
    expect(byId(r.items, "game-version")?.status).toBe("info");
    expect(byId(r.items, "game-version")?.detail).toContain("未能读取");
    expect(byId(r.items, "game-running")).toBeUndefined();
    expect(byId(r.items, "long-paths")).toBeUndefined();
    expect(byId(r.items, "os-version")).toBeUndefined();
    expect(byId(r.items, "av-defender-exclusion")).toBeUndefined();
  });

  it("non-Chinese locale warns with fix steps naming schinese", async () => {
    await makeGameDir(gameDir, { ini: "[Settings]\nLocale=enUS\nLocaleAudio=enUS\n" });
    const r = await runHealthCheck({ gameDir, knownModNames: ["EJ"] });
    const locale = byId(r.items, "game-locale")!;
    expect(locale.status).toBe("warn");
    expect(locale.detail).toContain("enUS");
    expect(locale.fixSteps.join(" ")).toContain("schinese");
  });

  it("missing core dll fails with the file named and fix steps", async () => {
    await makeGameDir(gameDir);
    await tjs.remove(joinPath(gameDir, "WinHttp.dll"));
    const r = await runHealthCheck({ gameDir, knownModNames: ["EJ"] });
    const av = byId(r.items, "av-core-files")!;
    expect(av.status).toBe("fail");
    expect(av.detail).toContain("WinHttp.dll");
    expect(av.fixSteps.length).toBeGreaterThan(0);
  });

  it("orphan mod dir is reported as info with its name", async () => {
    await makeGameDir(gameDir);
    await tjs.makeDir(joinPath(gameDir, "mods", "orphanMod"), { recursive: true });
    const r = await runHealthCheck({ gameDir, knownModNames: ["EJ"] });
    const orphans = byId(r.items, "mods-orphans")!;
    expect(orphans.status).toBe("info");
    expect(orphans.detail).toContain("orphanMod");
  });

  it("no BNet_Emu.ini: lang and av groups degrade to skip-semantics info", async () => {
    await makeGameDir(gameDir, { ini: null });
    const r = await runHealthCheck({ gameDir, knownModNames: ["EJ"] });
    expect(byId(r.items, "game-locale")?.status).toBe("info");
    expect(byId(r.items, "av-core-files")?.status).toBe("info");
    expect(byId(r.items, "av-defender-exclusion")).toBeUndefined();
  });

  it("never throws even when every async probe fails (spawn-free sandbox)", async () => {
    await makeGameDir(gameDir);
    const r = await runHealthCheck({ gameDir, knownModNames: ["EJ"] });
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.items.length).toBeGreaterThan(5);
    for (const it of r.items) {
      expect(["ok", "info", "warn", "fail"]).toContain(it.status);
      expect(it.fixSummary === null || it.fixSteps.length > 0 || it.status === "ok" || it.status === "info").toBe(true);
    }
  });

  it("Chinese + en-dash directory name hits path-shape", async () => {
    const cnDir = joinPath(sb.root, "Diablo II Resurrected – 整合版");
    await makeGameDir(cnDir);
    const r = await runHealthCheck({ gameDir: cnDir, knownModNames: ["EJ"] });
    const shape = byId(r.items, "path-shape")!;
    expect(shape.status).toBe("info");
    expect(shape.detail).toContain("en-dash");
    expect(shape.detail).toContain("中文");
  });
});
