/**
 * 大仓库向导: replace the D2R shared-stash file(s) with an author-provided
 * .d2i, with a mandatory auto snapshot of the save root as the rollback
 * point. D2R keeps one stash per mode: SoftCore / HardCore, V2 names.
 */
import { joinPath, basename } from "./paths.js";
import { createBackup, isGameRunning } from "./saves.js";

export const STASH_FILES = {
  soft: "SharedStashSoftCoreV2.d2i",
  hard: "SharedStashHardCoreV2.d2i",
} as const;

export type StashSlot = keyof typeof STASH_FILES;

export function isStashSlot(slot: string): slot is StashSlot {
  return slot === "soft" || slot === "hard";
}

const MAX_STASH_BYTES = 64 * 1024 * 1024;

export interface StashPreflight {
  slot: StashSlot;
  fileName: string;
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  gameRunning: boolean;
}

export async function stashPreflight(saveDir: string, slot: StashSlot): Promise<StashPreflight> {
  const path = joinPath(saveDir, STASH_FILES[slot]);
  const out: StashPreflight = {
    slot,
    fileName: STASH_FILES[slot],
    path,
    exists: false,
    size: 0,
    mtime: 0,
    gameRunning: await isGameRunning(),
  };
  try {
    const st = await tjs.stat(path);
    out.exists = true;
    out.size = st.size;
    out.mtime = st.mtim instanceof Date ? st.mtim.getTime() : 0;
  } catch {
    /* no current stash — first run for this mode */
  }
  return out;
}

export async function stashReplace(opts: {
  saveDir: string;
  slot: StashSlot;
  sourcePath: string;
  note?: string;
  backupKeep: number;
}): Promise<{ ok: boolean; backupId: string | null; replaced: boolean }> {
  if (await isGameRunning()) {
    throw new Error("D2R.exe 正在运行，请先退出游戏再替换共享仓库");
  }

  const src = opts.sourcePath.trim();
  if (!src) throw new Error("未选择要导入的 .d2i 文件");
  if (!/\.d2i$/i.test(src)) throw new Error(`不是 .d2i 仓库文件：${basename(src)}`);
  let srcStat: { size: number };
  try {
    srcStat = await tjs.stat(src);
  } catch {
    throw new Error(`文件不存在：${src}`);
  }
  if (srcStat.size > MAX_STASH_BYTES) {
    throw new Error(`仓库文件过大（${Math.round(srcStat.size / 1024 / 1024)}MB），疑似选错文件`);
  }

  const target = joinPath(opts.saveDir, STASH_FILES[opts.slot]);

  // Rollback point: snapshot the whole save root whenever a current stash
  // exists (root scope covers every stash file in one mechanism).
  let backupId: string | null = null;
  const preflight = await stashPreflight(opts.saveDir, opts.slot);
  if (preflight.exists) {
    const backup = await createBackup({
      saveDir: opts.saveDir,
      slots: ["root"],
      note: opts.note?.trim() || `替换 ${preflight.fileName} 前自动备份`,
      trigger: "stash",
      backupKeep: opts.backupKeep,
    });
    backupId = backup.id;
  }

  // Atomic overwrite: copy next to the target, then rename over it.
  const tmp = `${target}.tmp-${Date.now()}`;
  await tjs.copyFile(src, tmp);
  await tjs.rename(tmp, target);
  return { ok: true, backupId, replaced: true };
}
