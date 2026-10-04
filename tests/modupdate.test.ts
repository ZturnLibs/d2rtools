import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import {
  parseUpdateMeta,
  parseRemoteConfig,
  compareVersions,
  checkModUpdate,
  shouldAutoCheck,
  AUTO_CHECK_INTERVAL_MS,
} from "../src/services/modupdate.js";

let sb: TestSandbox;

beforeEach(async () => {
  sb = await makeSandbox();
});

afterEach(async () => {
  await sb.cleanup();
});

describe("parseUpdateMeta (D2RLaunch 约定字段)", () => {
  it("reads the canonical spaced-key spellings", () => {
    const meta = parseUpdateMeta({
      name: "EJ",
      savepath: "EJ",
      "Mod Version": "0.1.2.3",
      "Mod Config Download": "https://a/config.json",
      "Mod Download": "https://a/mod.zip",
    });
    expect(meta).toEqual({
      version: "0.1.2.3",
      configUrl: "https://a/config.json",
      downloadUrl: "https://a/mod.zip",
    });
  });

  it("accepts camelCase / D2RMM-style lowercase keys", () => {
    expect(parseUpdateMeta({ modVersion: "1.0", modConfigDownload: "u", modDownload: "d" })).toEqual({
      version: "1.0",
      configUrl: "u",
      downloadUrl: "d",
    });
    expect(parseUpdateMeta({ version: "2.0" }).version).toBe("2.0");
  });

  it("normalizes spaces/underscores/case when matching", () => {
    expect(parseUpdateMeta({ "mod_config_download  ": "u" }).configUrl).toBe("u");
    expect(parseUpdateMeta({ "MOD VERSION": "9" }).version).toBe("9");
  });

  it("ignores non-string and empty values", () => {
    expect(parseUpdateMeta({ version: 42, "Mod Download": "  " })).toEqual({
      version: null,
      configUrl: null,
      downloadUrl: null,
    });
  });
});

describe("parseRemoteConfig", () => {
  it("reads version/download/changelog leniently", () => {
    const cfg = parseRemoteConfig(`{"version":"1.2.3","download":"https://x/m.zip","changelog":"修复了崩溃"}`);
    expect(cfg).toEqual({ version: "1.2.3", downloadUrl: "https://x/m.zip", changelog: "修复了崩溃" });
  });

  it("accepts trailing commas (author json is hand-edited)", () => {
    const cfg = parseRemoteConfig(`{"version":"2.0","download":"u",}`);
    expect(cfg.version).toBe("2.0");
  });

  it("throws on non-JSON bodies (R1: 配额超限返回 HTML)", () => {
    expect(() => parseRemoteConfig("<html>403 quota</html>")).toThrow();
  });
});

describe("compareVersions", () => {
  it("compares segment by segment", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0); // numeric, not lexical
  });

  it("pads missing segments with 0", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "0.9")).toBeGreaterThan(0);
  });

  it("falls back to string compare for non-integer segments", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("2026.10", "2026.9")).toBeGreaterThan(0);
  });
});

describe("shouldAutoCheck (lastChecked 节流)", () => {
  it("returns true when never checked", () => {
    expect(shouldAutoCheck(undefined)).toBe(true);
    expect(shouldAutoCheck(Number.NaN)).toBe(true);
  });

  it("false inside the throttle window, true after", () => {
    const now = 1_000_000_000;
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS + 1000, now)).toBe(false);
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS - 1000, now)).toBe(true);
  });
});

describe("checkModUpdate", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function makeMod(modinfo: string): Promise<string> {
    const dir = joinPath(sb.root, "mods", "EJ");
    await tjs.makeDir(dir, { recursive: true });
    await tjs.writeFile(joinPath(dir, "modinfo.json"), new TextEncoder().encode(modinfo));
    return dir;
  }

  it("supported:false when the mod has no update fields", async () => {
    const dir = await makeMod(`{"name":"EJ","savepath":"EJ"}`);
    const status = await checkModUpdate({ modDir: dir, dirName: "EJ" });
    expect(status.supported).toBe(false);
    expect(status.hasUpdate).toBe(false);
  });

  it("detects a newer remote version and carries the download url", async () => {
    const dir = await makeMod(
      `{"name":"EJ","Mod Version":"1.0.0","Mod Config Download":"https://cdn.example/ej.json"}`,
    );
    globalThis.fetch = (async () =>
      new Response(`{"version":"1.1.0","download":"https://cdn.example/ej.zip"}`, { status: 200 })) as
      typeof fetch;
    const status = await checkModUpdate({ modDir: dir, dirName: "EJ" });
    expect(status.supported).toBe(true);
    expect(status.localVersion).toBe("1.0.0");
    expect(status.remoteVersion).toBe("1.1.0");
    expect(status.hasUpdate).toBe(true);
    expect(status.downloadUrl).toBe("https://cdn.example/ej.zip");
  });

  it("no update when remote equals local; unknown local counts as update", async () => {
    const dir = await makeMod(
      `{"Mod Version":"1.1.0","Mod Config Download":"https://cdn.example/ej.json"}`,
    );
    globalThis.fetch = (async () =>
      new Response(`{"version":"1.1.0","download":"u.zip"}`, { status: 200 })) as typeof fetch;
    expect((await checkModUpdate({ modDir: dir, dirName: "EJ" })).hasUpdate).toBe(false);

    const dir2 = await makeMod(`{"Mod Config Download":"https://cdn.example/ej.json"}`);
    expect((await checkModUpdate({ modDir: dir2, dirName: "EJ" })).hasUpdate).toBe(true);
  });

  it("network failure lands in status.error, not a throw (R1 降级)", async () => {
    const dir = await makeMod(
      `{"Mod Version":"1.0.0","Mod Config Download":"https://cdn.example/ej.json"}`,
    );
    globalThis.fetch = (async () => {
      throw new Error("Network request failed: Unable to connect");
    }) as typeof fetch;
    const status = await checkModUpdate({ modDir: dir, dirName: "EJ" });
    expect(status.supported).toBe(true);
    expect(status.error).toContain("Unable to connect");
    expect(status.hasUpdate).toBe(false);
    expect(status.localVersion).toBe("1.0.0");
  });

  it("HTTP error status lands in status.error too", async () => {
    const dir = await makeMod(
      `{"Mod Version":"1.0.0","Mod Config Download":"https://cdn.example/ej.json"}`,
    );
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const status = await checkModUpdate({ modDir: dir, dirName: "EJ" });
    expect(status.error).toContain("403");
  });
});
