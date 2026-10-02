/**
 * Mod-pack source scanning. Real packs nest arbitrarily deep (术士君临 is
 * double-wrapped, variants sit at <pack>\<pack>\<variant>\mods\<ModName>),
 * so this is a breadth-first walk to depth 7 that prunes game-content dirs
 * ("data" subtrees are huge) and stops at anything that identifies as a mod.
 *
 * If the registered source IS a game dir (contains D2R.exe), its top-level
 * mods\ — the install *destination* — is skipped, so installed copies are
 * never mistaken for a source.
 */
import { joinPath, basename, dirname } from "./paths.js";
import { readModInfo } from "./modinfo.js";
import type { KnownMod } from "./config.js";

export interface ScanOutcome {
  mods: KnownMod[];
  scannedDirs: number;
  warnings: string[];
}

const MAX_DEPTH = 7;
const MAX_DIRS = 5000;
const MAX_RESULTS = 300;

const PRUNE_DIRS = new Set(["data", "$recycle.bin", "system volume information", "node_modules"]);

interface QueueItem {
  dir: string;
  depth: number;
  variant: string;
}

async function listDir(dir: string): Promise<TjsDirEnt[]> {
  const d = await tjs.readDir(dir);
  const out: TjsDirEnt[] = [];
  for await (const e of d) out.push(e);
  return out;
}

export async function scanSource(
  sourcePath: string,
  sourceId: string,
): Promise<ScanOutcome> {
  const warnings: string[] = [];
  const results = new Map<string, KnownMod>();
  const queue: QueueItem[] = [{ dir: sourcePath, depth: 0, variant: "" }];
  let scanned = 0;

  // Source root is itself a game install? Then its mods\ is the install
  // target, not a pack layout — never descend into it.
  let rootIsGameDir = false;
  try {
    await tjs.stat(joinPath(sourcePath, "D2R.exe"));
    rootIsGameDir = true;
  } catch {
    /* just a pack dir */
  }

  while (queue.length > 0 && scanned < MAX_DIRS && results.size < MAX_RESULTS) {
    const { dir, depth, variant } = queue.shift()!;
    scanned++;

    let entries: TjsDirEnt[];
    try {
      entries = await listDir(dir);
    } catch (err) {
      warnings.push(`无法读取目录 ${dir}：${String(err)}`);
      continue;
    }

    const dirName = basename(dir);
    // readModInfo classifies via modinfo.json (either layout) or a
    // same-named .mpq child — non-null means this dir IS a mod (a leaf).
    if (depth > 0) {
      const info = await readModInfo(dir, dirName);
      if (info) {
        // Prefer the pack-layout variant: the dir holding the mods\ folder
        // (1.第一种开荒用\mods\EJ → "1.第一种开荒用"), which stays correct
        // no matter how far the pack sits below the registered root. Fall
        // back to the first segment under the root for loose layouts.
        const holder = basename(dirname(dirname(dir)));
        const modVariant = dirname(dir).toLowerCase().endsWith("\\mods")
          ? holder
          : variant || holder;
        results.set(modKey(sourceId, modVariant, dirName), {
          key: modKey(sourceId, modVariant, dirName),
          name: dirName,
          displayName: info.name !== dirName ? info.name : null,
          savepath: info.savepath,
          sourceId,
          sourcePath: dir,
          relPath: toRel(sourcePath, dir),
          variant: modVariant,
          parseWarning: info.warning,
          readmePath: null, // resolved after the walk (see commands.ts)
        });
        continue;
      }
    }

    if (depth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (e.name.startsWith(".") || PRUNE_DIRS.has(e.name.toLowerCase())) continue;
      if (depth === 0 && rootIsGameDir && e.name.toLowerCase() === "mods") continue;
      queue.push({
        dir: joinPath(dir, e.name),
        depth: depth + 1,
        variant: variant || (depth === 0 ? e.name : ""),
      });
    }
  }

  const mods = [...results.values()].sort(
    (a, b) => a.variant.localeCompare(b.variant) || a.name.localeCompare(b.name),
  );
  if (mods.length === 0 && warnings.length === 0) {
    warnings.push("未在该目录中找到任何 mod（需要形如 mods\\<ModName> 的结构）");
  }
  return { mods, scannedDirs: scanned, warnings };
}

function modKey(sourceId: string, variant: string, name: string): string {
  // Same mod name in two variants of one pack must not collapse.
  return variant ? `${sourceId}:${variant}:${name}` : `${sourceId}:${name}`;
}

function toRel(root: string, dir: string): string {
  const normRoot = root.replace(/[\\/]+$/, "");
  const normDir = dir.replace(/[\\/]+$/, "");
  if (normDir === normRoot) return "";
  const head = normDir.slice(0, normRoot.length);
  if (head.toLowerCase() !== normRoot.toLowerCase()) return normDir;
  return normDir.slice(normRoot.length).replace(/^[\\/]+/, "");
}
