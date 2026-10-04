/**
 * App configuration: one JSON document at %APPDATA%\com.zyj.d2rbox\config.json.
 * Plain tjs I/O (no store plugin) with atomic writes (temp + rename) and a
 * single-flight updateConfig so concurrent commands serialize cleanly.
 * A missing or corrupted file boots on defaults and never throws.
 */

import { joinPath } from "./paths.js";

export interface ModSource {
  id: string;
  path: string;
  label: string;
  addedAt: number;
}

/** One scanned mod variant. `name` (the folder name under mods\) is the
 *  canonical key used for -mod args, install dirs and save grouping;
 *  modinfo's own "name" is display-only (VIPer_cs's is "xin"). */
export interface KnownMod {
  key: string; // sourceId + ":" + name — unique per (source, mod)
  name: string;
  /** modinfo.json's own "name" when it differs from the folder name
   *  (VIPer_cs's is "xin") — display-only. */
  displayName: string | null;
  savepath: string;
  sourceId: string;
  sourcePath: string;
  relPath: string;
  variant: string; // first path segment under the source root
  parseWarning: string | null;
  readmePath: string | null; // author-facing 说明.txt, resolved at scan time
}

/** One launch profile. Single mod: D2R's -mod takes one mod per launch. */
export interface LaunchProfile {
  id: string;
  name: string;
  modName: string;
  extraArgs: string[];
  note: string;
  createdAt: number;
}

export interface InstallRecord {
  mode: "copy" | "hardlink";
  installedAt: number;
  sourcePath: string;
}

/** M7 退出守护：一次工具启动游戏时的存档指纹 + pre-launch 快照锚点。 */
export interface LaunchWatch {
  startedAt: number;
  pid: number;
  slots: string[];
  fingerprint: {
    slot: string;
    files: { name: string; size: number; mtime: number }[];
  }[];
  /** pre-launch 快照 id — 存档异常时前端一键还原的目标 */
  backupId: string | null;
}

export interface AppConfig {
  version: 1;
  gameDir: string | null;
  sources: ModSource[];
  knownMods: KnownMod[];
  profiles: LaunchProfile[];
  installed: Record<string, InstallRecord>;
  /** Snapshot the save dir(s) before every tool-launched game start. */
  autoBackup: boolean;
  /** Snapshots kept per scope signature (root / mods\<name> combos). */
  backupKeep: number;
  /** Store new snapshots as slots\<seg>.zip instead of folders (M6). */
  backupZip: boolean;
  /** Non-null while a tool-launched game session is being watched (M7). */
  launchWatch: LaunchWatch | null;
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    gameDir: null,
    sources: [],
    knownMods: [],
    profiles: [],
    installed: {},
    autoBackup: true,
    backupKeep: 10,
    backupZip: true,
    launchWatch: null,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** App version shown in Settings 关于 — keep in sync with package.json. */
export const APP_VERSION = "0.2.0";

export function configDir(): string {
  // %APPDATA% is guaranteed for interactive Windows sessions.
  const appdata = tjs.env.APPDATA;
  if (!appdata) throw new Error("无法定位 %APPDATA%，无法读写配置");
  return joinPath(appdata, "com.zyj.d2rbox");
}

export function configPath(): string {
  return joinPath(configDir(), "config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  let raw: Uint8Array;
  try {
    raw = await tjs.readFile(configPath());
  } catch {
    return defaultConfig();
  }
  try {
    const cfg = JSON.parse(new TextDecoder().decode(raw)) as AppConfig;
    if (cfg && typeof cfg === "object" && cfg.version === 1) {
      // Fill any fields missing from older files.
      return { ...defaultConfig(), ...cfg };
    }
    console.error("[d2rbox] config version mismatch, using defaults");
    return defaultConfig();
  } catch (err) {
    console.error("[d2rbox] config parse failed, using defaults:", err);
    return defaultConfig();
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await tjs.makeDir(configDir(), { recursive: true });
  const target = configPath();
  const tmp = joinPath(configDir(), `config.json.tmp-${Date.now()}`);
  await tjs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await tjs.rename(tmp, target);
}

// Single-flight: updates chain so read-modify-write cycles never interleave.
let updateChain: Promise<unknown> = Promise.resolve();

export function updateConfig(
  fn: (cfg: AppConfig) => AppConfig | Promise<AppConfig>,
): Promise<AppConfig> {
  const next = updateChain.then(async () => {
    const cfg = await loadConfig();
    const updated = await fn(cfg);
    await saveConfig(updated);
    return updated;
  });
  // Keep the chain alive even if one update fails.
  updateChain = next.catch(() => undefined);
  return next;
}
