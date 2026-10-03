/**
 * 退出守护 (M7): 存档保护默认动作化的"退出后"半边。
 *
 * launch 时存档管家已拍 pre-launch 快照（trigger="auto-launch"）；这里
 * 把当时的存档树指纹（每个 slot 顶层文件的 name/size/mtime）连同快照 id
 * 一起记进 config（launchWatch）。前端轮询到游戏退出后调 postExitCheck：
 *   - 指纹未变 → 什么都不做（"增量"语义：游戏没写档就不产生新快照）
 *   - 指纹变了 → trigger="auto-exit" 补一份退出后快照
 *   - 之前存在的 .d2s 消失了 → lost 列表，前端据此弹"存档异常"警告并
 *     提供一键还原 pre-launch 快照（backupId 即回滚锚点）
 *
 * 指纹只取顶层文件：游戏写的角色/仓库/Settings/lootfilter 全在顶层，
 * 递归既慢又会把无关目录卷进误报。
 */
import { joinPath, pathExists } from "./paths.js";
import { isSaveSlot, slotSourcePath, createBackup, isGameRunning, type SaveSlot } from "./saves.js";
import { loadConfig, updateConfig, type LaunchWatch } from "./config.js";

export interface FingerprintFile {
  name: string;
  size: number;
  mtime: number;
}

export interface SlotFingerprint {
  slot: SaveSlot;
  /** 顶层文件，按名字排序 */
  files: FingerprintFile[];
}

export type { LaunchWatch };

export async function captureFingerprint(
  saveDir: string,
  slots: SaveSlot[],
): Promise<SlotFingerprint[]> {
  const out: SlotFingerprint[] = [];
  for (const slot of slots) {
    if (!isSaveSlot(slot)) throw new Error(`非法存档范围：${slot}`);
    const dir = slotSourcePath(saveDir, slot);
    const files: FingerprintFile[] = [];
    if (await pathExists(dir)) {
      const d = await tjs.readDir(dir);
      for await (const e of d) {
        if (!e.isFile) continue;
        try {
          const st = await tjs.stat(joinPath(dir, e.name));
          files.push({
            name: e.name,
            size: st.size,
            mtime: st.mtim instanceof Date ? st.mtim.getTime() : 0,
          });
        } catch {
          /* raced delete — skip the entry */
        }
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ slot, files });
  }
  return out;
}

export async function armLaunchWatch(watch: LaunchWatch): Promise<void> {
  await updateConfig((cfg) => ({ ...cfg, launchWatch: watch }));
}

/** 已是 null 时不写盘，避免无谓的配置抖动。 */
export async function clearLaunchWatch(): Promise<void> {
  await updateConfig((cfg) => (cfg.launchWatch ? { ...cfg, launchWatch: null } : cfg));
}

export interface PostExitResult {
  /** 游戏仍在运行 — 前端应稍后重试 */
  running: boolean;
  /** 是否有 launchWatch（没有 = 本次启动未经工具或已处理过） */
  watched: boolean;
  /** 存档树相对启动时发生了变化 */
  changed: boolean;
  /** 启动时存在、现在消失的 .d2s 角色名 */
  lost: string[];
  /** changed 时新建的 auto-exit 快照 id */
  backupId: string | null;
  /** pre-launch 快照 id — lost 场景的回滚锚点 */
  preLaunchBackupId: string | null;
}

function indexFingerprints(
  fps: SlotFingerprint[],
): Map<string, Map<string, FingerprintFile>> {
  const bySlot = new Map<string, Map<string, FingerprintFile>>();
  for (const fp of fps) {
    const byName = new Map<string, FingerprintFile>();
    for (const f of fp.files) byName.set(f.name, f);
    bySlot.set(fp.slot, byName);
  }
  return bySlot;
}

/**
 * 游戏退出后的收尾检查。幂等：处理完即清 launchWatch，重复调用返回
 * watched:false。游戏仍在运行时直接返回 running:true（不清状态）。
 */
export async function postExitCheck(opts: {
  saveDir: string;
  backupKeep: number;
  zip: boolean;
}): Promise<PostExitResult> {
  if (await isGameRunning()) {
    return { running: true, watched: false, changed: false, lost: [], backupId: null, preLaunchBackupId: null };
  }
  const cfg = await loadConfig();
  const watch: LaunchWatch | null = cfg.launchWatch;
  if (!watch) {
    return { running: false, watched: false, changed: false, lost: [], backupId: null, preLaunchBackupId: null };
  }
  await clearLaunchWatch();

  const before = indexFingerprints(watch.fingerprint);
  const after = indexFingerprints(await captureFingerprint(opts.saveDir, watch.slots));

  const lost: string[] = [];
  for (const [slot, files] of before) {
    const nowFiles = after.get(slot);
    for (const [name] of files) {
      if (!name.toLowerCase().endsWith(".d2s")) continue;
      if (!nowFiles?.has(name)) lost.push(slot === "root" ? name : `${slot}/${name}`);
    }
  }

  let changed = false;
  for (const [slot, files] of before) {
    const nowFiles = after.get(slot) ?? new Map<string, FingerprintFile>();
    if (files.size !== nowFiles.size) {
      changed = true;
      break;
    }
    for (const [name, meta] of files) {
      const m = nowFiles.get(name);
      if (!m || m.size !== meta.size || m.mtime !== meta.mtime) {
        changed = true;
        break;
      }
    }
    if (changed) break;
  }

  let backupId: string | null = null;
  if (changed) {
    const existing: SaveSlot[] = [];
    for (const s of watch.slots) {
      if (await pathExists(slotSourcePath(opts.saveDir, s))) existing.push(s);
    }
    if (existing.length > 0) {
      const backup = await createBackup({
        saveDir: opts.saveDir,
        slots: existing,
        note: "退出游戏后自动备份",
        trigger: "auto-exit",
        backupKeep: opts.backupKeep,
        zip: opts.zip,
      });
      backupId = backup.id;
    }
  }

  return { running: false, watched: true, changed, lost, backupId, preLaunchBackupId: watch.backupId };
}
