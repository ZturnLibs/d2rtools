/**
 * 物品清单 (M7): read-only parsing of .d2i shared stashes and .d2s
 * characters via @dschu012/d2s (pure Uint8Array JS — runs on tjs and the
 * vitest node shim alike; see src/d2s-lib.d.ts for the subpath imports).
 *
 * Why no pnpm patch: the feasibility doc's B1 concern (defaultConfig
 * hardcoded into readItems) is structurally real but inert in 2.0.36 —
 * nothing consumes the extendedStash flag, and item location fields have
 * fixed widths (invloc:4/x:4/y:4/page:3), so stash grid layout lives in
 * the mod, not the file. Read-only listing needs no patch; B1/B2/B3 stay
 * on the M11 write-path list.
 *
 * Version handling: bundled constant data exists for v96/v99 only. Real
 * RotW/Infernal saves report v105, whose format is read-compatible with
 * v99 (halbu precedent) — we pass constants explicitly on every call so
 * the library never does its own version lookup, and alias 105→99 data.
 * Unknown item codes (mod-added items) resolve to their raw code; that is
 * honest for a read-only view.
 *
 * Every listing function takes an explicit saveDir so sandbox probes can
 * exercise the flow headlessly, same contract as saves.ts.
 */
import { joinPath, pathExists } from "./paths.js";
import * as stashLib from "@dschu012/d2s/lib/d2/stash.js";
import * as charLib from "@dschu012/d2s/lib/d2/d2s.js";
import { setConstantData } from "@dschu012/d2s/lib/d2/constants.js";
import { constants as constants96 } from "@dschu012/d2s/lib/data/versions/96_constant_data.js";
import { constants as constants99 } from "@dschu012/d2s/lib/data/versions/99_constant_data.js";

// ---------------------------------------------------------------------------
// Constant data registration (idempotent)
// ---------------------------------------------------------------------------

let constantsReady = false;

/** Register bundled v96/v99 data + the v105→v99 read-compat alias.
 *  Exported for stashmerge (M11) which reads raw items on its own. */
export function ensureConstants(): void {
  if (constantsReady) return;
  // d2s.read looks up constants by char.header.version; without a
  // registration for the exact version it throws.
  setConstantData(96, constants96);
  setConstantData(99, constants99);
  setConstantData(105, constants99); // RotW/Infernal, read-compatible
  constantsReady = true;
}

// ---------------------------------------------------------------------------
// Sources: which stashes / characters exist per save group
// ---------------------------------------------------------------------------

export interface StashFileInfo {
  name: string;
  path: string;
  size: number;
  mtime: number;
  /** filename-derived kind: softcore / hardcore shared stash, or other .d2i */
  kind: "shared-soft" | "shared-hard" | "other";
}

export interface CharacterFileInfo {
  /** file stem: `Amazon_01.d2s` → `Amazon_01` */
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export interface ItemSourceGroup {
  /** "主存档" or the mod save dir name */
  name: string;
  /** "root" | "mods/<name>" — matches the save-manager slot model */
  slot: string;
  path: string;
  exists: boolean;
  stashes: StashFileInfo[];
  characters: CharacterFileInfo[];
}

function stashKindOf(name: string): StashFileInfo["kind"] {
  const lower = name.toLowerCase();
  if (lower.startsWith("sharedstashsoftcore")) return "shared-soft";
  if (lower.startsWith("sharedstashhardcore")) return "shared-hard";
  return "other";
}

/** Top-level .d2i / .d2s files of one directory (no recursion). */
async function scanGroup(dir: string): Promise<{
  exists: boolean;
  stashes: StashFileInfo[];
  characters: CharacterFileInfo[];
}> {
  if (!(await pathExists(dir))) return { exists: false, stashes: [], characters: [] };
  const stashes: StashFileInfo[] = [];
  const characters: CharacterFileInfo[] = [];
  const d = await tjs.readDir(dir);
  for await (const e of d) {
    if (!e.isFile) continue;
    const lower = e.name.toLowerCase();
    const path = joinPath(dir, e.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = await tjs.stat(path);
      size = st.size;
      mtime = st.mtim instanceof Date ? st.mtim.getTime() : 0;
    } catch {
      /* raced delete — still list the entry */
    }
    if (lower.endsWith(".d2i")) {
      stashes.push({ name: e.name, path, size, mtime, kind: stashKindOf(e.name) });
    } else if (lower.endsWith(".d2s")) {
      const stem = e.name.slice(0, -4);
      if (stem.length > 0) characters.push({ name: stem, path, size, mtime });
    }
  }
  stashes.sort((a, b) => a.name.localeCompare(b.name));
  characters.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, stashes, characters };
}

/**
 * Browseable sources: the save root plus every live dir under mods\
 * (independent-mod save dirs). savepath="../" mods share the root group,
 * so they surface here naturally — same grouping as the save manager.
 */
export async function listItemSources(saveDir: string): Promise<{ groups: ItemSourceGroup[] }> {
  const groups: ItemSourceGroup[] = [];
  const root = await scanGroup(saveDir);
  groups.push({
    name: "主存档",
    slot: "root",
    path: saveDir,
    exists: root.exists,
    stashes: root.stashes,
    characters: root.characters,
  });
  const modsDir = joinPath(saveDir, "mods");
  if (await pathExists(modsDir)) {
    const d = await tjs.readDir(modsDir);
    const names: string[] = [];
    for await (const e of d) {
      if (e.isDirectory) names.push(e.name);
    }
    names.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    for (const name of names) {
      const dir = joinPath(modsDir, name);
      const g = await scanGroup(dir);
      groups.push({
        name,
        slot: `mods/${name}`,
        path: dir,
        exists: g.exists,
        stashes: g.stashes,
        characters: g.characters,
      });
    }
  }
  return { groups };
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

export type QualityKey =
  | "low" | "normal" | "superior" | "magic" | "set" | "rare" | "unique" | "crafted"
  | "unknown";

const QUALITY_KEYS: Record<number, QualityKey> = {
  1: "low",
  2: "normal",
  3: "superior",
  4: "magic",
  5: "set",
  6: "rare",
  7: "unique",
  8: "crafted",
};

export type CategoryKey = "rune" | "gem" | "weapon" | "armor" | "jewel" | "other";

export type WhereKey =
  | "stash" | "inventory" | "cube" | "equipped" | "corpse" | "merc" | "other";

export interface ItemDto {
  /** item code, e.g. "r01" / "kit" — mod-added codes pass through raw */
  type: string;
  /** display name: personalized > runeword > unique > set > base > code */
  name: string;
  quality: QualityKey;
  category: CategoryKey;
  where: WhereKey;
  /** stash: 0-based sector index; character: -1 (grouping is via `where`) */
  page: number;
  x: number;
  y: number;
  qty: number | null;
  level: number | null;
  ethereal: boolean;
  socketed: boolean;
  sockets: number | null;
  identified: boolean;
}

export interface RawItem {
  type?: string;
  personalized?: number | boolean;
  personalized_name?: string;
  runeword_name?: string;
  unique_name?: string | null;
  set_name?: string | null;
  type_name?: string;
  quality?: number;
  location_id?: number;
  alt_position_id?: number;
  position_x?: number;
  position_y?: number;
  quantity?: number;
  level?: number;
  ethereal?: number | boolean;
  socketed?: number | boolean;
  nr_of_items_in_sockets?: number;
  identified?: number | boolean;
  categories?: string[];
  [key: string]: unknown;
}

function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}

function categoryOf(item: RawItem): CategoryKey {
  const cats = item.categories ?? [];
  if (cats.includes("Rune")) return "rune";
  if (cats.includes("Gem")) return "gem";
  if (cats.includes("Jewel")) return "jewel";
  if (cats.includes("Weapon")) return "weapon";
  if (cats.includes("Any Armor")) return "armor";
  return "other";
}

function whereOfStash(pageIndex: number): { where: WhereKey; page: number } {
  return { where: "stash", page: pageIndex };
}

/** Character storage grouping per D2 location/alt-position conventions. */
function whereOfChar(item: RawItem): { where: WhereKey; page: number } {
  const loc = item.location_id ?? 0;
  const alt = item.alt_position_id ?? 0;
  if (loc === 0) {
    if (alt === 0) return { where: "inventory", page: -1 };
    if (alt === 1) return { where: "cube", page: -1 };
    if (alt === 2) return { where: "stash", page: -1 };
    return { where: "other", page: -1 };
  }
  if (loc === 1) return { where: "equipped", page: -1 };
  if (loc === 2) return { where: "cube", page: -1 };
  if (loc === 4) return { where: "corpse", page: -1 };
  if (loc === 6) return { where: "merc", page: -1 };
  return { where: "other", page: -1 };
}

/** 展示 DTO（stashmerge 布局预览复用同一套命名/品质逻辑）。 */
export function itemDtoOf(item: RawItem, where: WhereKey, page: number): ItemDto {
  return toDto(item, where, page);
}

function toDto(item: RawItem, where: WhereKey, page: number): ItemDto {
  const name =
    (typeof item.personalized_name === "string" && item.personalized_name) ||
    (typeof item.runeword_name === "string" && item.runeword_name) ||
    (typeof item.unique_name === "string" && item.unique_name) ||
    (typeof item.set_name === "string" && item.set_name) ||
    (typeof item.type_name === "string" && item.type_name) ||
    item.type ||
    "?";
  return {
    type: item.type ?? "?",
    name,
    quality: QUALITY_KEYS[item.quality ?? 0] ?? "unknown",
    category: categoryOf(item),
    where,
    page,
    x: item.position_x ?? 0,
    y: item.position_y ?? 0,
    qty: typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : null,
    level: typeof item.level === "number" ? item.level : null,
    ethereal: toBool(item.ethereal),
    socketed: toBool(item.socketed),
    sockets:
      typeof item.nr_of_items_in_sockets === "number" && item.nr_of_items_in_sockets > 0
        ? item.nr_of_items_in_sockets
        : null,
    identified: toBool(item.identified),
  };
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

export type ParseResult =
  | {
      kind: "stash";
      version: string;
      hardcore: boolean;
      sharedGold: number;
      pageCount: number;
      /** first-line summary for UI: gold + page count */
      pages: { index: number; name: string; items: ItemDto[] }[];
    }
  | {
      kind: "character";
      name: string;
      className: string | null;
      level: number | null;
      hardcore: boolean;
      expansion: boolean;
      groups: { where: WhereKey; items: ItemDto[] }[];
    }
  | {
      /** 物品明细解不出（mod 自定义属性位宽），但头部身份信息已提取 */
      kind: "character-partial";
      name: string;
      className: string | null;
      level: number | null;
      hardcore: boolean;
      expansion: boolean;
      message: string;
    }
  | { kind: "error"; message: string };

const WHERE_ORDER: WhereKey[] = [
  "equipped", "inventory", "stash", "cube", "merc", "corpse", "other",
];

function groupCharItems(items: ItemDto[]): { where: WhereKey; items: ItemDto[] }[] {
  const by = new Map<WhereKey, ItemDto[]>();
  for (const it of items) {
    const list = by.get(it.where) ?? [];
    list.push(it);
    by.set(it.where, list);
  }
  return WHERE_ORDER.filter((w) => by.has(w)).map((where) => ({ where, items: by.get(where)! }));
}

// ---------------------------------------------------------------------------
// 头部降级解析（物品段解析失败时的身份提取）
// ---------------------------------------------------------------------------

/**
 * 手读 .d2s 固定偏移头部。三种布局（偏移为字节）：
 * - ≤v97（经典 D2R 2.4-）：name@20(16B) status@36 class@40 level@43
 * - v98/v99：name 移至 267(16B)，status/class/level 不变
 * - v105（RotW/Infernal，halbu v105.rs 布局）：整个区块前移——
 *   status@20 class@24 level@27 name@299(48B)
 * 返回 null 当 magic 不对或名字不可读（说明根本不是角色文件）。
 */
function parseCharIdentity(
  bytes: Uint8Array,
): { name: string; className: string | null; level: number | null; hardcore: boolean; expansion: boolean } | null {
  try {
    if (bytes.length < 8) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0xaa55aa55) return null;
    const version = dv.getUint32(4, true);
    let nameOff: number;
    let nameLen: number;
    let statusOff: number;
    let classOff: number;
    let levelOff: number;
    if (version > 99) {
      nameOff = 299;
      nameLen = 48;
      statusOff = 20;
      classOff = 24;
      levelOff = 27;
    } else if (version > 0x61) {
      nameOff = 267;
      nameLen = 16;
      statusOff = 36;
      classOff = 40;
      levelOff = 43;
    } else {
      nameOff = 20;
      nameLen = 16;
      statusOff = 36;
      classOff = 40;
      levelOff = 43;
    }
    if (bytes.length < nameOff + nameLen) return null;
    const name = new TextDecoder("utf-8")
      .decode(bytes.subarray(nameOff, nameOff + nameLen))
      .replace(/\0/g, "")
      .trim();
    if (!name) return null;
    const status = statusOff < bytes.length ? (bytes[statusOff] ?? 0) : 0;
    const clsIdx = classOff < bytes.length ? (bytes[classOff] ?? -1) : -1;
    const classes = (constants99 as { classes?: { n?: string }[] }).classes ?? [];
    const level = levelOff < bytes.length ? (bytes[levelOff] ?? 0) : 0;
    return {
      name,
      className: classes[clsIdx]?.n ?? (clsIdx >= 0 ? `职业${clsIdx}` : null),
      level: level !== null && level > 0 && level <= 110 ? level : null,
      hardcore: (status >>> 2 & 1) === 1,
      expansion: (status >>> 5 & 1) === 1,
    };
  } catch {
    return null;
  }
}

/**
 * Parse one .d2i / .d2s file. Dispatches on extension (both formats open
 * with magic 0xAA55AA55, so the extension is the only reliable signal).
 * Never throws — a corrupt/unsupported file yields kind:"error" so the UI
 * can show it inline.
 */
export async function parseItemFile(path: string): Promise<ParseResult> {
  ensureConstants();
  const lower = path.toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = await tjs.readFile(path);
  } catch (err) {
    return { kind: "error", message: `无法读取文件：${String(err)}` };
  }

  if (lower.endsWith(".d2i")) {
    try {
      // constants + explicit version: the library never does its own
      // version→constants lookup (v105 alias registered defensively).
      const stash = await stashLib.read(bytes, constants99, 99, {});
      const pages = (stash.pages ?? []).map((p, index) => ({
        index,
        name: p.name || `第 ${index + 1} 页`,
        items: ((p.items ?? []) as RawItem[]).map((it) => toDto(it, "stash", index)),
      }));
      return {
        kind: "stash",
        version: String(stash.version ?? "?"),
        hardcore: stash.hardcore === true,
        sharedGold: typeof stash.sharedGold === "number" ? stash.sharedGold : 0,
        pageCount: pages.length,
        pages,
      };
    } catch (err) {
      return { kind: "error", message: `仓库解析失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (lower.endsWith(".d2s")) {
    try {
      const char = await charLib.read(bytes, constants99);
      const h = char.header;
      // Container fields per items.js: items (main list), corpse_items
      // (flat concat across corpses), merc_items, golem_item (single).
      const c = char as unknown as Record<string, unknown>;
      const rawItems = [
        ...((c.items ?? []) as RawItem[]),
        ...((c.corpse_items ?? []) as RawItem[]),
        ...((c.merc_items ?? []) as RawItem[]),
        ...(c.golem_item ? [c.golem_item as RawItem] : []),
      ];
      const dtos = rawItems.map((it) => {
        const w = whereOfChar(it);
        return toDto(it, w.where, w.page);
      });
      return {
        kind: "character",
        name: typeof h.name === "string" ? h.name : "?",
        className: typeof h.class === "string" ? h.class : null,
        level: typeof h.level === "number" ? h.level : null,
        hardcore: h.status?.hardcore === true,
        expansion: h.status?.expansion === true,
        groups: groupCharItems(dtos),
      };
    } catch (err) {
      // 物品段解不出（最常见：mod 自定义 SaveBits，如 7 页大仓库/扩展技能
      // mod 给 nextexp、OSkill 等加了标准表没有的存档位宽）。降级为只报
      // 头部身份信息——头部是固定偏移布局，手读即可，v105 布局经 halbu
      // 与实机存档双重验证。
      const partial = parseCharIdentity(bytes);
      if (partial) {
        return {
          kind: "character-partial",
          ...partial,
          message:
            "物品明细暂无法解析：该角色的物品使用了 mod 自定义的存档属性位宽" +
            "（常见于大仓库 / 扩展技能类 mod）。角色档案本身完好，本工具未改动存档。",
        };
      }
      return {
        kind: "error",
        message: `角色解析失败（版本可能不受支持）：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { kind: "error", message: "仅支持 .d2i 仓库与 .d2s 角色文件" };
}

// ---------------------------------------------------------------------------
// 原样读取（M11 合并/拆分）：返回 lib 原始物品对象（写路径需要完整字段做
// 字节级重序列化），与 parseItemFile 的 DTO 视图互补。解析失败直接抛错，
// 由合并服务转成"该来源不可合并"的告警。
// ---------------------------------------------------------------------------

export interface RawStashRead {
  hardcore: boolean;
  sharedGold: number;
  /** 每页的原始物品对象数组（lib read 输出，含 enhance 展开字段） */
  pages: RawItem[][];
}

export async function readRawStash(path: string): Promise<RawStashRead> {
  ensureConstants();
  const bytes = await tjs.readFile(path);
  const stash = (await stashLib.read(bytes, constants99, 99, {})) as {
    hardcore?: boolean;
    sharedGold?: number;
    pages?: { items?: RawItem[] }[];
  };
  return {
    hardcore: stash.hardcore === true,
    sharedGold: typeof stash.sharedGold === "number" ? stash.sharedGold : 0,
    pages: (stash.pages ?? []).map((p) => p.items ?? []),
  };
}

export interface RawCharacterRead {
  items: RawItem[];
}

export async function readRawCharacter(path: string): Promise<RawCharacterRead> {
  ensureConstants();
  const bytes = await tjs.readFile(path);
  const char = await charLib.read(bytes, constants99);
  const c = char as unknown as Record<string, unknown>;
  return {
    items: [
      ...((c.items ?? []) as RawItem[]),
      ...((c.corpse_items ?? []) as RawItem[]),
      ...((c.merc_items ?? []) as RawItem[]),
      ...(c.golem_item ? [c.golem_item as RawItem] : []),
    ],
  };
}
