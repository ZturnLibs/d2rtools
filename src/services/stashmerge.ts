/**
 * 大箱子合并/拆分写入 (M11): carry items from multiple sources (.d2i stashes
 * and/or characters) into one or more target stash files, with a previewed
 * layout plan and a guarded write pipeline.
 *
 * 设计边界（详见 docs/stash-manager-feasibility.md）：
 * - 只搬物品坐标与容器归属，不改物品体、不造物品——与存档修改器划清界限。
 *   物品体按 lib 解析出的原始对象原样重序列化（实机 286 件回读逐件一致，
 *   见 scripts/m11-roundtrip-probe.ts）。
 * - 只支持 lib 能完整解析的标准布局 .d2i；mod 自定义位宽的仓库读不出来，
 *   在计划阶段即拒绝（绝不半写）。
 * - 坐标合法化：x/y 各 4bit（≤15）、页索引 3bit（≤8 页）——页数/网格越界
 *   在计划层硬拒。物品尺寸来自 v99 常量表（iw/ih）；mod 自定义代码未知
 *   尺寸按 1×1 放置并显式告警（可能重叠，由用户预览后自行判断）。
 * - B2 已由 pnpm patch 修复（写路径 version 不再硬编码 0x62）；B3 无需
 *   补丁——lib 每个 sector 从 data.sharedGold 重写小头，单一 stash 对象
 *   构造上保证各 sector 一致。
 * - 写管线护栏：D2R 进程检测 → 根快照（任一目标已存在时）→ tmp+rename
 *   原子落盘 → 回读逐件校验。回滚走存档管家快照还原。
 *
 * 预览/执行使用同一确定性计划函数：apply 前重算并比对来源物品总数，
 * 来源在两次调用之间被改动则拒绝执行。
 */
import { joinPath } from "./paths.js";
import * as stashLib from "@dschu012/d2s/lib/d2/stash.js";
import { constants as constants99 } from "@dschu012/d2s/lib/data/versions/99_constant_data.js";
import { itemDtoOf, readRawCharacter, readRawStash, ensureConstants } from "./itemview.js";
import type { RawItem, ItemDto, CategoryKey } from "./itemview.js";
import { readStashHeader, STASH_FILES, MAX_SAFE_PAGES } from "./stash.js";
import type { StashSlot } from "./stash.js";
import { createBackup, isGameRunning } from "./saves.js";

// ---------------------------------------------------------------------------
// 物品尺寸（布局装箱用）
// ---------------------------------------------------------------------------

interface SizeEntry {
  iw?: number;
  ih?: number;
}

const SIZE_TABLES = ["other_items", "armor_items", "weapon_items"] as const;

const SIZED_CONSTANTS = constants99 as unknown as Record<string, Record<string, SizeEntry>>;

/** 常量表查物品占格（符文/宝石在 other_items，甲/武器各归其表）。 */
function sizeOf(type: string): { w: number; h: number; sizeKnown: boolean } {
  for (const t of SIZE_TABLES) {
    const e = SIZED_CONSTANTS[t]?.[type];
    if (e) {
      const w = Math.min(15, Math.max(1, Math.round(e.iw ?? 1)));
      const h = Math.min(15, Math.max(1, Math.round(e.ih ?? 1)));
      return { w, h, sizeKnown: true };
    }
  }
  return { w: 1, h: 1, sizeKnown: false };
}

// ---------------------------------------------------------------------------
// 来源收集
// ---------------------------------------------------------------------------

export interface MergeSourceSpec {
  path: string;
  kind: "stash" | "character";
}

interface Carried {
  item: RawItem;
  dto: ItemDto;
  /** 来源标识（路径末段） */
  from: string;
  w: number;
  h: number;
  sizeKnown: boolean;
}

/** 仓库内物品的小头标记（实机验证：游戏写 5）。 */
const STASH_ALT_POSITION = 5;

/** 归一为"存于共享仓库页"的容器字段（角色来源物品需要；仓→仓本就是该值）。 */
function normalizeForStash(item: RawItem, x: number, y: number): void {
  item.location_id = 0;
  item.equipped_id = 0;
  item.alt_position_id = STASH_ALT_POSITION;
  item.position_x = x;
  item.position_y = y;
}

// ---------------------------------------------------------------------------
// 计划（预览与执行共用，确定性）
// ---------------------------------------------------------------------------

export interface MergeTargetSpec {
  /** 覆盖现有槽位（saveRoot 下标准文件名）——与 fileName 二选一 */
  slot: StashSlot | null;
  /** 新文件名（saveRoot 下，仅限安全文件名字符） */
  fileName: string | null;
  /** 目标页数，1..8（页索引 3bit 上限） */
  pages: number;
  hardcore: boolean;
  sharedGold: number;
}

export interface MergeGridSpec {
  w: number;
  h: number;
}

export const DEFAULT_GRID: MergeGridSpec = { w: 10, h: 10 };

export interface PlannedItemView {
  name: string;
  type: string;
  quality: string;
  category: CategoryKey;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  qty: number | null;
  ethereal: boolean;
  sockets: number | null;
  from: string;
}

export interface TargetPlanView {
  label: string;
  path: string;
  exists: boolean;
  hardcore: boolean;
  sharedGold: number;
  version: number;
  items: PlannedItemView[];
}

export interface MergePlanView {
  targets: TargetPlanView[];
  carried: number;
  placed: number;
  unplaced: number;
  unknownSize: number;
  warnings: string[];
}

const KNOWN_VERSIONS = [96, 97, 98, 99, 105];
const SAFE_FILENAME = /^[\w\-.]{1,64}\.d2i$/i;

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await tjs.stat(path);
    return !st.isDirectory;
  } catch {
    return false;
  }
}

interface Planned {
  path: string;
  label: string;
  exists: boolean;
  existsVersion: number | null;
  spec: MergeTargetSpec;
  /** (target, page, x, y) → carried item */
  placed: { carried: Carried; page: number; x: number; y: number }[];
}

function validateGrid(grid: MergeGridSpec): void {
  if (!Number.isInteger(grid.w) || !Number.isInteger(grid.h) || grid.w < 1 || grid.h < 1 || grid.w > 15 || grid.h > 15) {
    throw new Error(`非法网格规格：${grid.w}×${grid.h}（各 1–15，坐标字段 4bit 上限）`);
  }
}

function validateTargets(saveDir: string, targets: MergeTargetSpec[]): Planned[] {
  if (targets.length < 1) throw new Error("至少需要一个目标文件");
  if (targets.length > 8) throw new Error("目标文件过多（≤8 个）");
  return targets.map((t) => {
    if (t.pages < 1 || t.pages > MAX_SAFE_PAGES || !Number.isInteger(t.pages)) {
      throw new Error(`目标页数须为 1–${MAX_SAFE_PAGES}（页索引字段 3bit 上限）：${t.pages}`);
    }
    if ((t.slot === null) === (t.fileName === null)) {
      throw new Error("目标须指定 slot（覆盖槽位）或 fileName（新文件）之一");
    }
    if (t.slot !== null && !["soft", "hard"].includes(t.slot)) {
      throw new Error(`非法仓库槽位：${t.slot}`);
    }
    let path: string;
    let label: string;
    if (t.slot !== null) {
      path = joinPath(saveDir, STASH_FILES[t.slot]);
      label = t.slot === "soft" ? "软核仓库" : "硬核仓库";
    } else {
      const name = t.fileName!.trim();
      if (!SAFE_FILENAME.test(name)) {
        throw new Error(`新文件名不合法（仅限字母/数字/点/横线/下划线，且以 .d2i 结尾）：${name}`);
      }
      path = joinPath(saveDir, name);
      label = name;
    }
    return { path, label, exists: false, existsVersion: null, spec: t, placed: [] };
  });
}

/**
 * 确定性计划：收集来源物品 → 面积降序首次适应装箱 → 每件物品的
 * (目标, 页, x, y)。放不下时抛错并给出数字，绝不静默丢弃。
 */
export async function planMerge(
  saveDir: string,
  sources: MergeSourceSpec[],
  targets: MergeTargetSpec[],
  grid: MergeGridSpec,
): Promise<{ planned: Planned[]; view: MergePlanView }> {
  validateGrid(grid);
  if (sources.length < 1) throw new Error("至少需要一个来源文件");
  const planned = validateTargets(saveDir, targets);

  // 目标现状（存在性看文件本身——存在但损坏的目标同样会被覆盖，须快照；
  // 版本只在头部可解析时沿用）
  for (const p of planned) {
    p.exists = await fileExists(p.path);
    const head = p.exists ? await readStashHeader(p.path) : null;
    p.existsVersion = head !== null && KNOWN_VERSIONS.includes(head.version) ? head.version : null;
  }

  // 收集来源
  ensureConstants();
  const carried: Carried[] = [];
  for (const s of sources) {
    const from = s.path.split(/[\\/]/).pop() ?? s.path;
    if (s.kind === "stash") {
      const raw = await readRawStash(s.path).catch((err: unknown) => {
        throw new Error(`来源无法合并（${from}）：${err instanceof Error ? err.message : String(err)}`);
      });
      for (const items of raw.pages) {
        for (const it of items) {
          const size = sizeOf(it.type ?? "?");
          carried.push({ item: it, dto: itemDtoOf(it, "stash", -1), from, ...size });
        }
      }
    } else {
      const raw = await readRawCharacter(s.path).catch((err: unknown) => {
        throw new Error(`来源无法读取（${from}）：${err instanceof Error ? err.message : String(err)}`);
      });
      for (const it of raw.items) {
        const size = sizeOf(it.type ?? "?");
        carried.push({ item: it, dto: itemDtoOf(it, "stash", -1), from, ...size });
      }
    }
  }

  // 首次适应装箱：面积降序（稳定），逐目标逐页扫格。
  // 两轮：第一轮按目标配额均分（拆分语义——多个目标时均匀分布而非
  // 填满第一个再开下一个）；第二轮不限额兜底配额放不下的大件，
  // 保证"均分"永不比顺序装箱更早触发"放不下"。
  const order = carried
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.w * b.c.h - a.c.w * a.c.h || a.i - b.i)
    .map((e) => e.c);
  const occupied = planned.map((p) => Array.from({ length: p.spec.pages }, () => new Set<string>()));
  const quota = Math.ceil(carried.length / planned.length);
  const tryPlace = (c: Carried, caps: number[]): boolean => {
    for (let ti = 0; ti < planned.length; ti++) {
      if (caps[ti]! <= 0) continue;
      const pages = planned[ti]!.spec.pages;
      for (let pg = 0; pg < pages; pg++) {
        const used = occupied[ti]![pg]!;
        for (let y = 0; y <= grid.h - c.h; y++) {
          for (let x = 0; x <= grid.w - c.w; x++) {
            let free = true;
            for (let dy = 0; dy < c.h && free; dy++) {
              for (let dx = 0; dx < c.w && free; dx++) {
                if (used.has(`${x + dx},${y + dy}`)) free = false;
              }
            }
            if (!free) continue;
            for (let dy = 0; dy < c.h; dy++) {
              for (let dx = 0; dx < c.w; dx++) used.add(`${x + dx},${y + dy}`);
            }
            planned[ti]!.placed.push({ carried: c, page: pg, x, y });
            caps[ti]!--;
            return true;
          }
        }
      }
    }
    return false;
  };
  const capped = planned.map(() => quota);
  const leftovers: Carried[] = [];
  for (const c of order) {
    if (!tryPlace(c, capped)) leftovers.push(c);
  }
  const uncapped = planned.map(() => Number.POSITIVE_INFINITY);
  let unplaced = 0;
  for (const c of leftovers) {
    if (!tryPlace(c, uncapped)) unplaced++;
  }

  if (unplaced > 0) {
    const cells = planned.reduce((n, p) => n + p.spec.pages * grid.w * grid.h, 0);
    throw new Error(
      `放不下 ${unplaced} 件（共 ${carried.length} 件）：${planned.length} 个目标共 ${cells} 格。请增加页数/目标数或加大网格`,
    );
  }

  // 输出版本：目标已存在 → 沿用其版本；否则取第一个仓库来源的版本 → 99
  const firstStashVersion = await (async () => {
    for (const s of sources) {
      if (s.kind !== "stash") continue;
      const h = await readStashHeader(s.path);
      if (h && KNOWN_VERSIONS.includes(h.version)) return h.version;
    }
    return 99;
  })();

  const warnings: string[] = [];
  const unknownSize = carried.filter((c) => !c.sizeKnown).length;
  if (unknownSize > 0) {
    warnings.push(
      `${unknownSize} 件物品尺寸未知（mod 自定义代码不在标准物品表），按 1×1 放置——若实际占格更大，可能与相邻物品重叠，请在游戏内确认`,
    );
  }
  for (const p of planned) {
    if (p.exists && p.spec.slot === null) {
      warnings.push(`目标 ${p.label} 已存在，将被覆盖（替换前自动快照）`);
    }
  }

  const view: MergePlanView = {
    targets: planned.map((p) => ({
      label: p.label,
      path: p.path,
      exists: p.exists,
      hardcore: p.spec.hardcore,
      sharedGold: p.spec.sharedGold,
      version: p.existsVersion ?? firstStashVersion,
      items: p.placed.map(({ carried: c, page, x, y }) => ({
        name: c.dto.name,
        type: c.dto.type,
        quality: c.dto.quality,
        category: c.dto.category,
        page,
        x,
        y,
        w: c.w,
        h: c.h,
        qty: c.dto.qty,
        ethereal: c.dto.ethereal,
        sockets: c.dto.sockets,
        from: c.from,
      })),
    })),
    carried: carried.length,
    placed: carried.length - unplaced,
    unplaced,
    unknownSize,
    warnings,
  };
  return { planned, view };
}

// ---------------------------------------------------------------------------
// 执行（护栏写管线）
// ---------------------------------------------------------------------------

export interface MergeApplyResult {
  backupId: string | null;
  targets: { path: string; version: number; items: number; bytes: number }[];
}

export async function applyMerge(
  saveDir: string,
  sources: MergeSourceSpec[],
  targets: MergeTargetSpec[],
  grid: MergeGridSpec,
  opts: { backupKeep: number; note?: string; expectCarried: number },
): Promise<MergeApplyResult> {
  const { planned, view } = await planMerge(saveDir, sources, targets, grid);
  if (view.carried !== opts.expectCarried) {
    throw new Error(`来源已变化（预览时 ${opts.expectCarried} 件，现 ${view.carried} 件），请重新预览后再执行`);
  }

  if (await isGameRunning()) {
    throw new Error("D2R.exe 正在运行，请先退出游戏再写入共享仓库");
  }

  // 回滚点：任一目标已存在就拍根快照（覆盖所有槽位文件）
  let backupId: string | null = null;
  if (planned.some((p) => p.exists)) {
    const backup = await createBackup({
      saveDir,
      slots: ["root"],
      note: opts.note?.trim() || "大箱子合并/拆分前自动备份",
      trigger: "stash",
      backupKeep: opts.backupKeep,
    });
    backupId = backup.id;
  }

  const results: MergeApplyResult["targets"] = [];
  for (let ti = 0; ti < planned.length; ti++) {
    const p = planned[ti]!;
    const version = view.targets[ti]!.version;
    // 装箱坐标写回原始物品对象；角色来源归一容器字段，仓→仓本就是该值
    const pages: RawItem[][] = Array.from({ length: p.spec.pages }, () => []);
    const expected: string[] = [];
    for (const { carried: c, page, x, y } of p.placed) {
      normalizeForStash(c.item, x, y);
      pages[page]!.push(c.item);
      expected.push(`${c.dto.type}|${c.dto.quality}|${x},${y}|${c.dto.qty ?? ""}`);
    }
    const bytes = await stashLib.write(
      {
        hardcore: p.spec.hardcore,
        sharedGold: p.spec.sharedGold,
        pages: pages.map((items) => ({ name: "", type: 0, items })),
      },
      constants99,
      version,
      {},
    );

    // 原子落盘 + 回读逐件校验（type/quality/坐标/数量）
    const tmp = `${p.path}.tmp-${Date.now()}`;
    await tjs.writeFile(tmp, bytes);
    try {
      const reread = await tjs.readFile(tmp);
      const parsed = (await stashLib.read(reread, constants99, 99, {})) as {
        pages?: { items?: RawItem[] }[];
      };
      const verified = (parsed.pages ?? [])
        .flatMap((pg) =>
          (pg.items ?? []).map((it) => {
            const dto = itemDtoOf(it, "stash", 0);
            return `${dto.type}|${dto.quality}|${it.position_x ?? 0},${it.position_y ?? 0}|${dto.qty ?? ""}`;
          }),
        )
        .sort();
      expected.sort();
      if (verified.length !== expected.length) {
        throw new Error(`回读物品数不符（期望 ${expected.length}，实得 ${verified.length}）`);
      }
      for (let i = 0; i < verified.length; i++) {
        if (verified[i] !== expected[i]) {
          throw new Error(`回读物品不符：${expected[i]} ≠ ${verified[i]}`);
        }
      }
    } catch (err) {
      await tjs.remove(tmp, { maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      throw new Error(`目标 ${p.label} 写入校验失败：${err instanceof Error ? err.message : String(err)}`);
    }
    await tjs.rename(tmp, p.path);
    results.push({ path: p.path, version, items: p.placed.length, bytes: bytes.length });
  }

  return { backupId, targets: results };
}
