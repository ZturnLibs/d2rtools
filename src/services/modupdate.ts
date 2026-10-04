/**
 * Mod update detection (M9), following the D2RLaunch-WPF convention:
 * authors add extra keys to modinfo.json —
 *   "Mod Version": "0.1.2.3"
 *   "Mod Config Download": "<permanent URL of a small version json>"
 *   "Mod Download": "<permanent direct zip URL>"   (fallback when no config)
 * The game ignores unknown keys, so this is zero-effort author opt-in and
 * the de-facto community standard. We also accept camelCase spellings and
 * D2RMM's lowercase "version" field.
 *
 * Detection requires a config json (it is the only place a REMOTE version
 * lives); a bare "Mod Download" link cannot tell us whether an update
 * exists, so downloadUrl-only mods surface as supported:false and are
 * updated via the mod-index / manual-import paths instead.
 */
import { joinPath } from "./paths.js";
import { lenientParse, readModInfoRaw } from "./modinfo.js";
import { fetchWithTimeout } from "./net.js";

/** Author-declared fields, matched case/space-insensitively. */
export interface UpdateMeta {
  version: string | null;
  configUrl: string | null;
  downloadUrl: string | null;
}

function pickField(obj: Record<string, unknown>, names: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  for (const key of Object.keys(obj)) {
    const k = norm(key);
    for (const want of names) {
      if (k === norm(want)) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

/** Extract the convention fields from a parsed modinfo.json (or config json). */
export function parseUpdateMeta(obj: Record<string, unknown>): UpdateMeta {
  return {
    version: pickField(obj, ["Mod Version", "modVersion", "version"]),
    configUrl: pickField(obj, ["Mod Config Download", "modConfigDownload"]),
    downloadUrl: pickField(obj, ["Mod Download", "modDownload", "download", "downloadUrl"]),
  };
}

/** Read update meta straight from an installed mod dir (either layout). */
export async function readUpdateMeta(modDir: string, dirName: string): Promise<UpdateMeta | null> {
  const raw = await readModInfoRaw(modDir, dirName);
  if (!raw) return null;
  const meta = parseUpdateMeta(raw);
  if (!meta.version && !meta.configUrl && !meta.downloadUrl) return null;
  return meta;
}

/** Remote config json the author's "Mod Config Download" points at. */
export interface RemoteConfig {
  version: string | null;
  downloadUrl: string | null;
  changelog: string | null;
}

export function parseRemoteConfig(text: string): RemoteConfig {
  const parsed = lenientParse(text);
  if (!parsed) throw new Error("更新配置 json 解析失败（内容不是合法 JSON）");
  const meta = parseUpdateMeta(parsed);
  const changelog = pickField(parsed, ["changelog", "changes", "notes"]);
  return { version: meta.version, downloadUrl: meta.downloadUrl, changelog };
}

/** Fetch + parse the remote config json. */
export async function fetchRemoteConfig(configUrl: string, timeoutMs = 15_000): Promise<RemoteConfig> {
  const res = await fetchWithTimeout(configUrl, { timeoutMs });
  if (!res.ok) throw new Error(`更新配置拉取失败：HTTP ${res.status}`);
  return parseRemoteConfig(await res.text());
}

/**
 * Compare dot-separated integer versions ("0.1.2.3" vs "0.2"). Missing
 * segments count as 0; non-integer segments fall back to string compare
 * for that pair. Returns <0 / 0 / >0 like strcmp.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split(/[.+]/);
  const pb = b.trim().split(/[.+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = /^\d+$/.test(sa) ? Number(sa) : null;
    const nb = /^\d+$/.test(sb) ? Number(sb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export interface UpdateStatus {
  /** false = the mod does not participate in the convention (or no config). */
  supported: boolean;
  localVersion: string | null;
  remoteVersion: string | null;
  hasUpdate: boolean;
  /** Direct zip to fetch when applying (from remote config). */
  downloadUrl: string | null;
  /** The remote config json URL — surfaced for diagnostics. */
  configUrl: string | null;
  changelog: string | null;
  lastChecked: number;
  error: string | null;
}

export interface CheckInput {
  modDir: string;
  dirName: string;
}

/**
 * One live update check for an installed mod. Never throws for network /
 * remote problems — they land in status.error (supported stays true so the
 * UI shows a per-mod degraded state, R1). Only unexpected local I/O errors
 * propagate to the caller.
 */
export async function checkModUpdate(input: CheckInput, now = Date.now()): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    supported: false,
    localVersion: null,
    remoteVersion: null,
    hasUpdate: false,
    downloadUrl: null,
    configUrl: null,
    changelog: null,
    lastChecked: now,
    error: null,
  };
  const meta = await readUpdateMeta(input.modDir, input.dirName);
  if (!meta || !meta.configUrl) return base;
  const degraded: UpdateStatus = {
    ...base,
    supported: true,
    localVersion: meta.version,
    configUrl: meta.configUrl,
    lastChecked: now,
  };
  let remote: RemoteConfig;
  try {
    remote = await fetchRemoteConfig(meta.configUrl);
  } catch (err) {
    return { ...degraded, error: err instanceof Error ? err.message : String(err) };
  }
  const remoteVersion = remote.version;
  const hasUpdate =
    remoteVersion !== null &&
    (meta.version === null || compareVersions(remoteVersion, meta.version) > 0);
  return {
    supported: true,
    localVersion: meta.version,
    remoteVersion,
    hasUpdate,
    downloadUrl: remote.downloadUrl,
    configUrl: meta.configUrl,
    changelog: remote.changelog,
    lastChecked: now,
    error: null,
  };
}

/** Re-check interval for automatic (non-forced) refreshes. */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function shouldAutoCheck(lastChecked: number | undefined, now = Date.now()): boolean {
  if (lastChecked === undefined || !Number.isFinite(lastChecked)) return true;
  return now - lastChecked >= AUTO_CHECK_INTERVAL_MS;
}
