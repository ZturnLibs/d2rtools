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

// ---------------------------------------------------------------------------
// 头部只读解析 + HC/SC 一致性检测 (M10)
//
// .d2i（D2R V2）布局（实机文件 + lib stash.js 双重验证，可行性文档 §2 的
// 描述有两处不准，以此为准）：
//   文件 = N 个 sector 顺序拼接，每页一个 sector；每个 sector 自带一份
//   64 字节小头：magic u32 (0xAA55AA55) | hardcore u32 | version u32 |
//   sharedGold u32 | sectorSize u32 | 44B 保留，随后是该页物品位流。
//   - hardcore 语义反着存：0 = 硬核，非 0 = 软核（lib: `ReadUInt32()==0`）
//   - 页数 = floor(文件长度 / sectorSize)（不是减一次头——每 sector 都有头）
// 只读第一个 sector 头即可回答"几页/是不是 HC/金币多少"——物品段解析
// 失败（mod 自定义位宽）也不影响，这正是向导替换前需要的最小事实。
// 坐标字段上限：x/y 各 4bit、页索引 3bit → >8 页的仓库会溢出（超页检测）。
// ---------------------------------------------------------------------------

export const STASH_HEADER_BYTES = 64;
/** 页索引字段 3bit，第 9 页及以后无法被物品坐标寻址。 */
export const MAX_SAFE_PAGES = 8;
const MAX_SECTOR_BYTES = 16 * 1024 * 1024;

export interface StashHeaderInfo {
  hardcore: boolean;
  version: number;
  sharedGold: number;
  sectorSize: number;
  /** null = 长度/sectorSize 推不出（文件截断或 sectorSize 异常） */
  pageCount: number | null;
}

/** 只读文件头（第一个 sector 的 64 字节小头）。非 .d2i/头部不合法返回
 *  null（不抛错）。 */
export async function readStashHeader(path: string): Promise<StashHeaderInfo | null> {
  let bytes: Uint8Array;
  let size: number;
  try {
    bytes = await tjs.readFile(path);
    const st = await tjs.stat(path);
    size = st.size;
  } catch {
    return null;
  }
  if (bytes.length < STASH_HEADER_BYTES) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0xaa55aa55) return null;
  const sectorSize = dv.getUint32(16, true);
  const pageCount =
    sectorSize > STASH_HEADER_BYTES && sectorSize <= MAX_SECTOR_BYTES && size >= sectorSize
      ? Math.floor(size / sectorSize)
      : null;
  return {
    hardcore: dv.getUint32(4, true) === 0, // 0 = 硬核（反着存）
    version: dv.getUint32(8, true),
    sharedGold: dv.getUint32(12, true),
    sectorSize,
    pageCount,
  };
}

export interface StashSlotConsistency {
  slot: StashSlot;
  fileName: string;
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  header: StashHeaderInfo | null;
}

export interface ConsistencyWarning {
  level: "error" | "warn" | "info";
  text: string;
}

export interface StashConsistency {
  soft: StashSlotConsistency;
  hard: StashSlotConsistency;
  warnings: ConsistencyWarning[];
}

const SLOT_LABEL = { soft: "软核", hard: "硬核" } as const;

/**
 * 两个仓库槽位的头部事实 + 一致性发现。向导第 1 步展示；第 2 步的
 * "将被清空的物品清单"走完整的 d2r:itemView（含物品明细），两者互补。
 */
export async function stashConsistency(saveDir: string): Promise<StashConsistency> {
  const warnings: ConsistencyWarning[] = [];
  const slots = { soft: null as StashSlotConsistency | null, hard: null as StashSlotConsistency | null };
  for (const slot of ["soft", "hard"] as const) {
    const path = joinPath(saveDir, STASH_FILES[slot]);
    const info: StashSlotConsistency = {
      slot,
      fileName: STASH_FILES[slot],
      path,
      exists: false,
      size: 0,
      mtime: 0,
      header: null,
    };
    try {
      const st = await tjs.stat(path);
      info.exists = true;
      info.size = st.size;
      info.mtime = st.mtim instanceof Date ? st.mtim.getTime() : 0;
    } catch {
      slots[slot] = info;
      continue;
    }
    info.header = await readStashHeader(path);
    if (!info.header) {
      warnings.push({
        level: "error",
        text: `${info.fileName}：无法解析仓库头部（文件损坏，或不是 .d2i 仓库）`,
      });
    } else {
      if (info.header.hardcore !== (slot === "hard")) {
        warnings.push({
          level: "error",
          text: `${info.fileName}：文件内容标记为${SLOT_LABEL[info.header.hardcore ? "hard" : "soft"]}仓库，与槽位不符——可能装反了 SC/HC 文件`,
        });
      }
      if (info.header.pageCount !== null && info.header.pageCount > MAX_SAFE_PAGES) {
        warnings.push({
          level: "warn",
          text: `${info.fileName}：${info.header.pageCount} 页，超过物品坐标字段的 ${MAX_SAFE_PAGES} 页上限——第 ${MAX_SAFE_PAGES + 1} 页及以后的物品可能无法正常显示/交互`,
        });
      }
    }
    slots[slot] = info;
  }
  const { soft, hard } = slots as { soft: StashSlotConsistency; hard: StashSlotConsistency };
  if (
    soft.exists &&
    hard.exists &&
    soft.header?.pageCount != null &&
    hard.header?.pageCount != null &&
    soft.header.pageCount !== hard.header.pageCount
  ) {
    warnings.push({
      level: "info",
      text: `软核/硬核仓库页数不一致（软核 ${soft.header.pageCount} 页 / 硬核 ${hard.header.pageCount} 页）。合法但通常意味着混装了不同版本的仓库文件——若是同一整合包，建议两个槽位一并替换`,
    });
  }
  return { soft, hard, warnings };
}
