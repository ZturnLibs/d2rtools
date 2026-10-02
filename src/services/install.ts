/**
 * Mod install / uninstall. Install = materialize the source mod dir under
 * <game>\mods\<ModName>: hardlink per file when possible (same volume, no
 * elevation), falling back to copy per file; files ≥16MB copy in 1MiB chunks
 * so progress actually moves on the ~800MB MPQs. Per-file failures are
 * collected, not fatal. Uninstall NEVER touches saves — only the game-side
 * mod dir.
 */
import {
  joinPath,
  dirname,
  modsDir,
  modDir,
  isValidModName,
  pathExists,
  modSaveDir,
} from "./paths.js";
import { readModInfo } from "./modinfo.js";

export const BIG_FILE = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export type InstallMode = "copy" | "hardlink";

export type InstallProgress =
  | { type: "start"; files: number; bytes: number }
  | { type: "mode"; mode: InstallMode }
  | { type: "file"; path: string; index: number; files: number }
  | { type: "bytes"; file: string; done: number; total: number }
  | { type: "done"; ok: boolean; files: number; bytes: number; mode: InstallMode; errors: string[] };

export interface InstallOutcome {
  ok: boolean;
  files: number;
  bytes: number;
  mode: InstallMode; // "hardlink" only if every file linked; else "copy"
  errors: string[];
}

interface FileEntry {
  src: string;
  rel: string;
  size: number;
}

async function collectFiles(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string): Promise<void> {
    const d = await tjs.readDir(dir);
    for await (const e of d) {
      const full = joinPath(dir, e.name);
      if (e.isDirectory) {
        await walk(full);
      } else if (e.isFile) {
        let size = 0;
        try {
          size = (await tjs.stat(full)).size;
        } catch {
          /* size is advisory */
        }
        out.push({ src: full, rel: full.slice(root.length).replace(/^[\\/]+/, ""), size });
      }
    }
  }
  await walk(root);
  return out;
}

export async function chunkedCopy(
  src: string,
  dst: string,
  onBytes?: (done: number, total: number) => void,
): Promise<void> {
  const total = (await tjs.stat(src)).size;
  const reader = await tjs.open(src, "r");
  const writer = await tjs.open(dst, "w");
  try {
    let done = 0;
    for (;;) {
      const buf = await reader.read(CHUNK);
      if (buf.length === 0) break;
      await writer.write(buf);
      done += buf.length;
      onBytes?.(done, total);
    }
  } finally {
    await reader.close();
    await writer.close();
  }
}

export interface InstallOptions {
  gameDir: string;
  sourcePath: string;
  modName: string;
  mode: InstallMode;
  overwrite: boolean;
  onProgress?: (p: InstallProgress) => void;
}

export async function installMod(opts: InstallOptions): Promise<InstallOutcome> {
  const { gameDir, sourcePath, modName, mode, overwrite, onProgress } = opts;
  if (!isValidModName(modName)) throw new Error(`非法 mod 名：${JSON.stringify(modName)}`);
  if (!(await pathExists(sourcePath))) throw new Error(`源目录不存在：${sourcePath}`);

  const dest = modDir(gameDir, modName);
  if (await pathExists(dest)) {
    if (!overwrite) throw new Error(`mods\\${modName} 已存在：请先卸载，或勾选覆盖安装`);
    await tjs.remove(dest, { recursive: true, maxRetries: 5, retryDelay: 200 });
  }
  await tjs.makeDir(dest, { recursive: true });

  const files = await collectFiles(sourcePath);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  onProgress?.({ type: "start", files: files.length, bytes: totalBytes });

  const errors: string[] = [];
  let allHardlinked = files.length > 0;
  let copiedBytes = 0;
  let index = 0;

  for (const f of files) {
    const dst = joinPath(dest, f.rel);
    await tjs.makeDir(dirname(dst), { recursive: true });

    if (mode === "hardlink") {
      try {
        await tjs.link(f.src, dst);
        index++;
        continue;
      } catch {
        allHardlinked = false; // cross-volume / EPERM — this file copies
      }
    }

    try {
      if (f.size >= BIG_FILE) {
        let lastReport = 0;
        await chunkedCopy(f.src, dst, (done, total) => {
          const now = Date.now();
          if (now - lastReport >= 100 || done === total) {
            lastReport = now;
            onProgress?.({ type: "bytes", file: f.rel, done, total });
          }
        });
      } else {
        await tjs.copyFile(f.src, dst);
      }
      copiedBytes += f.size;
    } catch (err) {
      allHardlinked = false;
      errors.push(`${f.rel}：${String(err)}`);
    }
    index++;
    onProgress?.({ type: "file", path: f.rel, index, files: files.length });
  }

  onProgress?.({ type: "mode", mode: mode === "hardlink" && allHardlinked ? "hardlink" : "copy" });
  return {
    ok: errors.length === 0,
    files: files.length,
    bytes: copiedBytes,
    mode: mode === "hardlink" && allHardlinked ? "hardlink" : "copy",
    errors,
  };
}

/** Live disk check — the single source of truth for "已安装". */
export async function installState(gameDir: string, modName: string): Promise<boolean> {
  if (!isValidModName(modName)) return false;
  return pathExists(modDir(gameDir, modName));
}

export interface UninstallPreflight {
  installed: boolean;
  savepath: string | null;
  usesRootSaves: boolean;
  saveDir: string | null;
  saveDirExists: boolean;
}

/**
 * Everything the uninstall dialog needs. Reads modinfo live from the
 * installed copy so it works even when the mod isn't in knownMods.
 */
export async function uninstallPreflight(
  gameDir: string,
  modName: string,
): Promise<UninstallPreflight> {
  if (!isValidModName(modName)) throw new Error(`非法 mod 名：${JSON.stringify(modName)}`);
  const dir = modDir(gameDir, modName);
  const installed = await pathExists(dir);
  if (!installed) {
    return {
      installed: false,
      savepath: null,
      usesRootSaves: false,
      saveDir: null,
      saveDirExists: false,
    };
  }
  let savepath: string | null = null;
  const info = await readModInfo(dir, modName);
  if (info) savepath = info.savepath;

  const usesRootSaves = savepath === "../" || savepath === ".." || savepath === ".";
  const saveDir = savepath ? await modSaveDir(savepath) : null;
  const saveDirExists = saveDir ? await pathExists(saveDir) : false;
  return { installed, savepath, usesRootSaves, saveDir, saveDirExists };
}

/**
 * Remove <game>\mods\<ModName> only. Path-checked twice (name + resolved
 * prefix); saves under %UserProfile% are never touched.
 */
export async function uninstallModDir(gameDir: string, modName: string): Promise<void> {
  const target = modDir(gameDir, modName); // throws on bad names
  const base = modsDir(gameDir).toLowerCase();
  if (!target.toLowerCase().startsWith(base + "\\")) {
    throw new Error(`拒绝删除 mods 目录之外的位置：${target}`);
  }
  if (await pathExists(target)) {
    await tjs.remove(target, { recursive: true, maxRetries: 5, retryDelay: 200 });
  }
}
